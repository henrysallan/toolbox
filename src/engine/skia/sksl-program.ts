// SkSL program assembly for the SkSL Shader node (specdocs/101326_skia-target.md).
//
// The user writes a complete SkSL runtime shader — helpers plus
// `half4 main(float2 fragCoord)` — exactly as React Native Skia will run it.
// The node owns a short prelude in front of it, the same split GLSL
// Expression uses (glsl-expression.ts): built-in uniforms, the child shaders
// the source references, and one uniform per channel minted from the same
// `// ch("k", …)` comment grammar (engine/expr-channels.ts). The exporter
// ships prelude + source verbatim, so what toolbox compiled is the file.
//
// Contract (shaders.skia.org-compatible names, so playground shaders paste):
//   fragCoord     — LOCAL coords, Y-DOWN, pixel centres at +0.5
//   iResolution   — float3: xy = canvas size (toolbox px; RN points), z = 1
//   iTime         — seconds
//   iImage1..4    — child shaders (wired images), declared only when the
//                   source mentions them; sample with iImage1.eval(xy)
//   return value  — PREMULTIPLIED color (Skia's rule; the node converts to
//                   the engine's straight alpha after rendering)
// Skia compiles runtime effects as strict GLSL ES 1.0: no uint / bitwise
// ops, no while loops, constant loop bounds (use `break`), no derivatives,
// no bool uniforms. CanvasKit's compile error is the authority; the lints
// here only add portability warnings Skia can't know about.

import type { CanvasKit, RuntimeEffect } from "canvaskit-wasm";
import type { ExprInput } from "../types";
import { channelKind, type ExprChannelValue } from "../expr-channels";

export const SKSL_CHILD_NAMES = ["iImage1", "iImage2", "iImage3", "iImage4"] as const;
const PRELUDE_NAMES = new Set(["iResolution", "iTime", "main", ...SKSL_CHILD_NAMES]);
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// SkSL type and keyword names a channel must not shadow.
const SKSL_RESERVED = new Set([
  "half", "half2", "half3", "half4", "float", "float2", "float3", "float4",
  "int", "int2", "int3", "int4", "bool", "bool2", "bool3", "bool4",
  "vec2", "vec3", "vec4", "mat2", "mat3", "mat4", "shader", "uniform",
  "layout", "color", "in", "out", "inout", "const", "return", "if", "else",
  "for", "break", "continue", "discard", "true", "false", "struct", "inline",
  "noinline", "void",
]);

export function usableSkslChannelName(name: string): boolean {
  return (
    IDENT_RE.test(name) &&
    !PRELUDE_NAMES.has(name) &&
    !SKSL_RESERVED.has(name) &&
    !name.startsWith("sk_") &&
    !name.includes("__")
  );
}

export function skslChannels(params: Record<string, unknown>): ExprInput[] {
  const entries = (params.inputs as ExprInput[]) ?? [];
  return entries.filter((e) => usableSkslChannelName(e.name));
}

function optionIdent(opt: string): string | null {
  const s = opt
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s || null;
}

// Channel kinds → SkSL declarations. Toggles are ints because SkSL forbids
// bool uniforms (read them as `on != 0`); colors are layout(color) so a P3
// device surface converts the authored sRGB value instead of misreading it.
// Ramps and curves have no M0 lowering (they become child gradient shaders
// in M2) and are reported, not silently dropped.
export function skslChannelDecls(entries: ExprInput[]): {
  lines: string[];
  unsupported: string[];
} {
  const lines: string[] = [];
  const unsupported: string[] = [];
  for (const e of entries) {
    switch (channelKind(e)) {
      case "scalar":
        lines.push(`uniform float ${e.name};`);
        break;
      case "toggle":
        lines.push(`uniform int ${e.name};  // toggle: 0 / 1`);
        break;
      case "enum": {
        lines.push(`uniform int ${e.name};`);
        const used = new Set<string>();
        (e.options ?? []).forEach((opt, i) => {
          const id = optionIdent(opt);
          if (!id || used.has(id)) return;
          used.add(id);
          lines.push(`const int ${e.name}_${id} = ${i};`);
        });
        break;
      }
      case "color":
        lines.push(`layout(color) uniform float4 ${e.name};  // straight alpha, sRGB`);
        break;
      case "ramp":
      case "curve":
        unsupported.push(e.name);
        break;
    }
  }
  return { lines, unsupported };
}

// Children the source samples, in iImage order. Declaring an unreferenced
// child would make React Native supply a shader it never reads.
export function referencedChildren(source: string): string[] {
  const code = stripComments(source);
  return SKSL_CHILD_NAMES.filter((n) => new RegExp(`\\b${n}\\b`).test(code));
}

export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, "");
}

export const SKSL_SOURCE_MARKER = "// ---- shader source ----";

export interface SkslProgram {
  // Prelude + user source: the exact program CanvasKit compiles and the
  // exporter ships.
  sksl: string;
  // Lines before the user's first line — subtract from error line numbers.
  preludeLines: number;
  children: string[];
  channels: ExprInput[];
  // Channel names with no SkSL lowering yet (ramp / curve).
  unsupported: string[];
}

export function buildSkslProgram(params: Record<string, unknown>): SkslProgram {
  const source = typeof params.expression === "string" ? params.expression : "";
  const channels = skslChannels(params);
  const children = referencedChildren(source);
  const { lines, unsupported } = skslChannelDecls(channels);
  const prelude = [
    "// Prelude owned by the toolbox SkSL Shader node.",
    "uniform float3 iResolution;  // xy = canvas size, z = 1",
    "uniform float iTime;         // seconds",
    ...children.map((c) => `uniform shader ${c};`),
    ...lines,
    SKSL_SOURCE_MARKER,
  ];
  return {
    sksl: `${prelude.join("\n")}\n${source}`,
    preludeLines: prelude.length,
    children,
    channels: channels.filter((c) => !unsupported.includes(c.name)),
    unsupported,
  };
}

// Skia's error text is `error: <line>: <message>` with lines counted from
// the top of the compiled program; rewrite to the user's own line numbers.
export function userLineError(raw: string, preludeLines: number): string {
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) =>
      l.replace(/^(error|warning): (\d+):/, (_m, kind: string, n: string) => {
        const line = Number(n) - preludeLines;
        return line > 0 ? `${kind}: line ${line}:` : `${kind}: (prelude):`;
      })
    )
    .join("\n");
}

// Text-level checks CanvasKit can't make. Problems block (they mean the
// node can't render as intended); warnings are portability notes that the
// device will behave differently from the preview.
export function lintSksl(source: string): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const code = stripComments(source);
  if (!/\bmain\s*\(/.test(code)) {
    problems.push("Source defines no main() — write `half4 main(float2 fragCoord) { … }`.");
  }
  if (/\buniform\b/.test(code)) {
    problems.push(
      "Declare tunables as // ch(…) / color(…) comments, not `uniform` lines — the node owns the uniform block (iImage1..4 are declared for you when used)."
    );
  }
  // Declarations only (`half3 c = …`, `half x` params) — casts like the
  // customary `return half4(c)` are fine, the output is 8-bit anyway.
  if (/\bhalf[234]?\s+(?!main\b)[A-Za-z_]\w*/.test(code)) {
    warnings.push(
      "`half` is a real 16-bit float on iOS Metal but 32-bit in this preview — use `float` for anything precision-sensitive (hashes, large coordinates, accumulated time)."
    );
  }
  if (/\bsk_FragCoord\b/.test(code)) {
    warnings.push("sk_FragCoord is not available to runtime effects — use main()'s coordinate.");
  }
  return { problems, warnings };
}

// ---- compile cache -----------------------------------------------------------

export type SkslCompileResult =
  | { effect: RuntimeEffect; error: null }
  | { effect: null; error: string };

const compileCache = new Map<string, SkslCompileResult>();
const COMPILE_CACHE_CAP = 64;

// Cached by full program text: a typing user mints one entry per distinct
// source, the oldest effect is deleted past the cap. Failures cache too, so a
// broken shader costs one compile, not one per frame.
export function compileSksl(kit: CanvasKit, sksl: string): SkslCompileResult {
  const hit = compileCache.get(sksl);
  if (hit) {
    compileCache.delete(sksl);
    compileCache.set(sksl, hit);
    return hit;
  }
  let message = "";
  const effect = kit.RuntimeEffect.Make(sksl, (m) => {
    message = m;
  });
  const result: SkslCompileResult = effect
    ? { effect, error: null }
    : { effect: null, error: message || "SkSL compile failed" };
  compileCache.set(sksl, result);
  while (compileCache.size > COMPILE_CACHE_CAP) {
    const oldest = compileCache.keys().next().value as string;
    compileCache.get(oldest)?.effect?.delete();
    compileCache.delete(oldest);
  }
  return result;
}

// ---- uniform packing -----------------------------------------------------------

export type SkslUniformValues = Record<string, number | readonly number[]>;

// The float array makeShader expects, in the effect's own uniform order.
// Ints ride as floats (CanvasKit casts per isInteger); missing names stay 0.
export function packUniforms(effect: RuntimeEffect, values: SkslUniformValues): Float32Array {
  const out = new Float32Array(effect.getUniformFloatCount());
  for (let i = 0; i < effect.getUniformCount(); i++) {
    const name = effect.getUniformName(i);
    const u = effect.getUniform(i);
    const v = values[name];
    if (v === undefined) continue;
    const n = u.columns * u.rows;
    if (typeof v === "number") {
      out[u.slot] = v;
    } else {
      for (let k = 0; k < n && k < v.length; k++) out[u.slot + k] = v[k];
    }
  }
  return out;
}

// Channel values (expr-channels shapes) → SkSL uniform values.
export function channelUniformValues(
  channels: ExprInput[],
  values: Record<string, ExprChannelValue>
): SkslUniformValues {
  const out: SkslUniformValues = {};
  for (const e of channels) {
    const v = values[e.name];
    switch (channelKind(e)) {
      case "scalar":
        out[e.name] = typeof v === "number" ? v : 0;
        break;
      case "toggle":
        out[e.name] = v === true ? 1 : 0;
        break;
      case "enum":
        out[e.name] = Math.max(0, (e.options ?? []).indexOf(String(v)));
        break;
      case "color":
        out[e.name] =
          Array.isArray(v) && v.length === 4 && typeof v[0] === "number"
            ? (v as number[])
            : [1, 1, 1, 1];
        break;
      default:
        break;
    }
  }
  return out;
}
