import type {
  ExprInput,
  ImageValue,
  InputSocketDef,
  NodeDefinition,
  RenderContext,
} from "@/engine/types";
import {
  buildCurveLut,
  buildRampLut,
  CHANNEL_LUT_SIZE,
  channelKind,
  channelSocketType,
  readChannelValues,
  type ExprChannelValue,
} from "@/engine/expr-channels";
import type { ColorRampStop } from "@/engine/color-ramp";
import type { CurvePoint } from "@/engine/float-curve";

// GLSL Expression — the per-pixel member of the expression family
// (081426_glsl-expression.md M1). The user writes the BODY of main() in
// GLSL 300 es; the node owns the template (#version, precision, io,
// uniforms), compiles through ctx.tryShader (per-node key, in-place
// recompile on edit, cached failures), and draws one fullscreen pass.
//
// Contract the template exposes:
//   v_uv               — Y-UP canvas UV (the engine texture convention)
//   u_a..u_d           — wired image inputs (unwired = 1×1 transparent)
//   u_res / u_aspect   — canvas px size / w÷h
//   u_time / u_frame   — the clock (folded into the fingerprint only when
//                        referenced, so static shaders cache)
//   <name>             — one uniform / lookup per channel, declared as a
//                        `//` comment and minted by Sync (the Point
//                        Expression scanner, verbatim — the comment syntax
//                        is GLSL-legal; engine/expr-channels.ts, spec
//                        090426_expression-channel-kinds.md):
//                          // ch("k", 0.5, 0, 1)        uniform float k
//                          // toggle("on", true)        uniform bool on
//                          // pick("mode", "a", "b")    uniform int mode
//                                                       + const int mode_a=0, mode_b=1
//                          // color("tint", "#ff8800")  uniform vec4 tint (straight alpha)
//                          // ramp("ink", "#000", "#fff")  vec4 ink(float t)
//                          // curve("fall", 1, 0)       float fall(float x)
//                        Ramps/curves are 256×1 LUT textures behind the
//                        generated functions (units 4+; images hold 0–3).
//                        The `u_` prefix is reserved for the template.
//   fragColor          — the output, STRAIGHT alpha (engine invariant —
//                        do not premultiply).
//
// A compile error keeps the last intent visible: output follows On error
// (pass `a` through, or transparent black), and the trimmed info log
// warns once per source to the console.

const DEFAULT_SOURCE = `// Body of main(), plus optional helpers above it.
// Top-level function / struct definitions are hoisted out of main()
// (or wrap them in // functions … // body). Read inputs with
// texture(u_a, v_uv) (u_b..u_d), the clock with u_time, canvas size
// with u_res. Declare tunables as comments, hit Sync, then read them
// by name:
//   // ch("amount", 0.5, 0, 1)      float amount
//   // toggle("invert", false)      bool invert
//   // pick("mode", "soft", "hard") int mode (mode_soft, mode_hard)
//   // color("tint", "#ff8800")     vec4 tint
//   // ramp("ink", "#000000", "#ffffff")  vec4 ink(float t)
//   // curve("falloff", 1, 0)       float falloff(float x)
// Write fragColor (straight alpha).
vec4 a = texture(u_a, v_uv);
fragColor = a;`;

// Uniform names come from user channel names — only clean GLSL
// identifiers that don't shadow the template's own declarations compile.
const GLSL_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const TEMPLATE_NAMES = new Set([
  "u_a",
  "u_b",
  "u_c",
  "u_d",
  "u_res",
  "u_time",
  "u_frame",
  "u_aspect",
  "v_uv",
  "fragColor",
  "main",
]);

// `u_` is the template's prefix (u_a…u_d, u_res, and the per-channel
// u_ramp_<name> / u_curve_<name> samplers), so a channel can't use it; GLSL
// also reserves any identifier containing `__`.
function usableChannelName(name: string): boolean {
  return (
    GLSL_IDENT_RE.test(name) &&
    !TEMPLATE_NAMES.has(name) &&
    !name.startsWith("gl_") &&
    !name.startsWith("u_") &&
    !name.includes("__")
  );
}

// Every channel row whose name compiles — all kinds mint something now
// (pick → int, curve → lookup function), not just ch().
function glslChannels(params: Record<string, unknown>): ExprInput[] {
  const entries = (params.inputs as ExprInput[]) ?? [];
  return entries.filter((e) => usableChannelName(e.name));
}

// pick() option → identifier suffix for the `const int <name>_<opt>`
// constants ("spline anchors" → spline_anchors, "3" → 3 so the constant is
// mode_3). Underscore runs collapse — GLSL reserves identifiers containing
// `__`. Null when nothing usable survives; callers also drop duplicates.
function optionIdent(opt: string): string | null {
  const s = opt
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s || null;
}

// Half-texel-correct 1D lookup into a CHANNEL_LUT_SIZE-wide LUT.
const LUT_COORD = `(clamp(t, 0.0, 1.0) * ${(CHANNEL_LUT_SIZE - 1).toFixed(1)} + 0.5) / ${CHANNEL_LUT_SIZE.toFixed(1)}`;

export function glslChannelDecls(entries: ExprInput[]): string[] {
  const lines: string[] = [];
  for (const e of entries) {
    switch (channelKind(e)) {
      case "scalar":
        lines.push(`uniform float ${e.name};`);
        break;
      case "toggle":
        lines.push(`uniform bool ${e.name};`);
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
        lines.push(`uniform vec4 ${e.name};`);
        break;
      case "ramp":
        lines.push(
          `uniform sampler2D u_ramp_${e.name};`,
          `vec4 ${e.name}(float t) { return texture(u_ramp_${e.name}, vec2(${LUT_COORD}, 0.5)); }`
        );
        break;
      case "curve":
        lines.push(
          `uniform sampler2D u_curve_${e.name};`,
          `float ${e.name}(float t) { return texture(u_curve_${e.name}, vec2(${LUT_COORD}, 0.5)).r; }`
        );
        break;
    }
  }
  return lines;
}

const GLSL_TYPES = new Set([
  "void",
  "bool",
  "int",
  "uint",
  "float",
  "double",
  "vec2",
  "vec3",
  "vec4",
  "bvec2",
  "bvec3",
  "bvec4",
  "ivec2",
  "ivec3",
  "ivec4",
  "uvec2",
  "uvec3",
  "uvec4",
  "mat2",
  "mat3",
  "mat4",
  "mat2x2",
  "mat2x3",
  "mat2x4",
  "mat3x2",
  "mat3x3",
  "mat3x4",
  "mat4x2",
  "mat4x3",
  "mat4x4",
  "sampler2D",
  "samplerCube",
  "sampler3D",
  "sampler2DArray",
  "isampler2D",
  "usampler2D",
  "sampler2DShadow",
]);

const GLSL_STMT_KW = new Set([
  "if",
  "for",
  "while",
  "do",
  "switch",
  "return",
  "discard",
  "else",
  "case",
  "default",
  "break",
  "continue",
  "precision",
  "layout",
]);

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_]/;

function skipWsAndComments(src: string, i: number): number {
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      i += 2;
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i = Math.min(n, i + 2);
      continue;
    }
    break;
  }
  return i;
}

function readIdent(src: string, i: number): { name: string; next: number } | null {
  if (i >= src.length || !IDENT_START.test(src[i])) return null;
  let j = i + 1;
  while (j < src.length && IDENT_CHAR.test(src[j])) j++;
  return { name: src.slice(i, j), next: j };
}

function matchingBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function lineIsMarker(line: string, names: string[]): boolean {
  const m = /^\s*\/\/\s*(.+?)\s*$/.exec(line);
  if (!m) return false;
  const t = m[1].replace(/[-_]+/g, " ").trim().toLowerCase();
  return names.includes(t);
}

function splitByMarkers(src: string): { functions: string; body: string } | null {
  const lines = src.split("\n");
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start < 0 && lineIsMarker(lines[i], ["functions"])) start = i;
    else if (
      start >= 0 &&
      end < 0 &&
      lineIsMarker(lines[i], ["body", "main", "end functions"])
    ) {
      end = i;
      break;
    }
  }
  if (start < 0 || end < 0) return null;
  return {
    functions: lines.slice(start + 1, end).join("\n"),
    body: lines.slice(end + 1).join("\n"),
  };
}

function tryTakeStruct(src: string, i: number): number {
  const id = readIdent(src, i);
  if (!id || id.name !== "struct") return -1;
  let j = skipWsAndComments(src, id.next);
  const name = readIdent(src, j);
  if (!name) return -1;
  j = skipWsAndComments(src, name.next);
  if (src[j] !== "{") return -1;
  const close = matchingBrace(src, j);
  if (close < 0) return -1;
  j = skipWsAndComments(src, close + 1);
  if (src[j] === ";") j++;
  return j;
}

function tryTakeFunction(src: string, i: number): number {
  let j = i;
  const first = readIdent(src, j);
  if (!first) return -1;
  if (GLSL_STMT_KW.has(first.name)) return -1;
  j = first.next;
  const tokens: string[] = [first.name];
  for (;;) {
    j = skipWsAndComments(src, j);
    if (src[j] === "(") break;
    const id = readIdent(src, j);
    if (!id) return -1;
    tokens.push(id.name);
    j = id.next;
    if (tokens.length > 6) return -1;
  }
  if (tokens.length < 2) return -1;
  const typeTok = tokens[tokens.length - 2];
  if (!GLSL_TYPES.has(typeTok) && typeTok !== "struct") {
    // User struct return type: last-but-one isn't a statement keyword.
    if (GLSL_STMT_KW.has(typeTok)) return -1;
  }
  let depth = 0;
  for (; j < src.length; j++) {
    if (src[j] === "(") depth++;
    else if (src[j] === ")") {
      depth--;
      if (depth === 0) {
        j++;
        break;
      }
    }
  }
  j = skipWsAndComments(src, j);
  if (src[j] === ";") return j + 1;
  if (src[j] !== "{") return -1;
  const close = matchingBrace(src, j);
  if (close < 0) return -1;
  return close + 1;
}

// Peel top-level function / struct definitions out of the user source so
// they sit above main() in the template. `// functions` … `// body`
// markers win when both are present; otherwise definitions at the start
// of the snippet (and any later ones that still parse as file-scope) are
// hoisted and the rest stays the body of main().
export function splitGlslUserSource(src: string): {
  functions: string;
  body: string;
} {
  const marked = splitByMarkers(src);
  if (marked) return marked;
  const functions: string[] = [];
  let i = 0;
  while (i < src.length) {
    const start = skipWsAndComments(src, i);
    if (start >= src.length) {
      i = start;
      break;
    }
    const structEnd = tryTakeStruct(src, start);
    const fnEnd = structEnd < 0 ? tryTakeFunction(src, start) : -1;
    const end = structEnd >= 0 ? structEnd : fnEnd;
    if (end < 0) break;
    functions.push(src.slice(start, end).trim());
    i = end;
  }
  return {
    functions: functions.join("\n\n"),
    body: src.slice(i),
  };
}

function buildSource(body: string, decls: string[], functions = ""): string {
  const helpers = functions.trim() ? `${functions.trim()}\n` : "";
  return `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform sampler2D u_c;
uniform sampler2D u_d;
uniform vec2 u_res;
uniform float u_time;
uniform float u_frame;
uniform float u_aspect;
${decls.join("\n")}
${helpers}void main() {
${body}
}`;
}

export function glslExpressionSource(params: Record<string, unknown>): string {
  const raw = typeof params.expression === "string" ? params.expression : "";
  const { functions, body } = splitGlslUserSource(raw);
  return buildSource(body, glslChannelDecls(glslChannels(params)), functions);
}

// Info-log line numbers count the owned template. The user body starts on
// `preludeLines + 1`.
export function glslExpressionPreludeLines(params: Record<string, unknown>): number {
  const src = glslExpressionSource(params);
  const marker = "void main() {\n";
  const idx = src.indexOf(marker);
  if (idx < 0) return 0;
  return src.slice(0, idx + marker.length).split("\n").length - 1;
}

// tryShader throws "Shader compile failed: <log>\n--\n<source>". The source
// echo is noise for a tool result; keep the log.
export function trimShaderInfoLog(error: string | null | undefined): string {
  return (error ?? "unknown error").split("\n--\n")[0];
}

export type GlslShaderInspect = {
  nodeId: string;
  type: "glsl-expression";
  ok: boolean;
  error?: string;
  preludeLines?: number;
  problems?: string[];
};

export function inspectGlslExpression(
  nodeId: string,
  params: Record<string, unknown>,
  tryShader: (key: string, src: string) => { error: string | null }
): GlslShaderInspect {
  const problems = glslExpressionNode.validateParams?.(params) ?? [];
  const { error } = tryShader(`glsl-expr:${nodeId}`, glslExpressionSource(params));
  const out: GlslShaderInspect = {
    nodeId,
    type: "glsl-expression",
    ok: !error && problems.length === 0,
  };
  if (error) {
    out.error = trimShaderInfoLog(error);
    out.preludeLines = glslExpressionPreludeLines(params);
  }
  if (problems.length) out.problems = problems;
  return out;
}

export function attachGlslErrorsToSpec<T extends { id: string; type: string }>(
  nodes: T[],
  paramsOf: (id: string) => Record<string, unknown> | undefined,
  tryShader: (key: string, src: string) => { error: string | null }
): (T & {
  shaderError?: string;
  shaderPreludeLines?: number;
  shaderProblems?: string[];
})[] {
  return nodes.map((sn) => {
    if (sn.type !== "glsl-expression") return sn;
    const params = paramsOf(sn.id);
    if (!params) return sn;
    const info = inspectGlslExpression(sn.id, params, tryShader);
    if (info.ok) return sn;
    return {
      ...sn,
      ...(info.error
        ? { shaderError: info.error, shaderPreludeLines: info.preludeLines }
        : {}),
      ...(info.problems ? { shaderProblems: info.problems } : {}),
    };
  });
}

interface GlslState {
  // 1×1 transparent fallback bound to unwired samplers (allocated once,
  // released in dispose).
  blank?: ImageValue;
  lastWarned?: string | null;
  // Ramp / curve lookup textures by channel name, keyed by the value they
  // were built from so an untouched ramp never re-uploads. Released when
  // the value changes, the channel goes away, or in dispose.
  luts?: Record<string, { key: string; image: ImageValue }>;
}

// Image inputs sit on units 0–3; LUT channels take 4… on a minimum-spec
// 16-unit device.
const LUT_FIRST_UNIT = 4;
const MAX_LUT_CHANNELS = 12;

function lutKey(kind: "ramp" | "curve", v: ExprChannelValue): string {
  if (kind === "ramp")
    return JSON.stringify(
      ((Array.isArray(v) ? v : []) as ColorRampStop[]).map((s) => [s.position, s.color, s.alpha ?? 1])
    );
  return JSON.stringify(((Array.isArray(v) ? v : []) as CurvePoint[]).map((p) => [p.x, p.y]));
}

// Ensure the LUT texture for one ramp/curve channel is current. Built
// BEFORE drawFullscreen — uploads bind textures, and the draw's setup
// callback runs with the output framebuffer bound.
function ensureLut(
  ctx: RenderContext,
  state: GlslState,
  name: string,
  kind: "ramp" | "curve",
  v: ExprChannelValue
): ImageValue {
  const luts = (state.luts ??= {});
  const key = `${kind}:${lutKey(kind, v)}`;
  const have = luts[name];
  if (have && have.key === key) return have.image;
  if (have) ctx.releaseTexture(have.image.texture);
  const data =
    kind === "ramp"
      ? buildRampLut((Array.isArray(v) ? v : []) as ColorRampStop[])
      : buildCurveLut((Array.isArray(v) ? v : []) as CurvePoint[]);
  const image = ctx.uploadFloat32ToImage(data, CHANNEL_LUT_SIZE, 1);
  luts[name] = { key, image };
  return image;
}

function releaseLuts(ctx: RenderContext, state: GlslState, keep?: Set<string>) {
  if (!state.luts) return;
  for (const name of Object.keys(state.luts)) {
    if (keep?.has(name)) continue;
    ctx.releaseTexture(state.luts[name].image.texture);
    delete state.luts[name];
  }
}

function getState(ctx: RenderContext, nodeId: string): GlslState {
  const key = `glsl-expression:${nodeId}`;
  let s = ctx.state[key] as GlslState | undefined;
  if (!s) {
    s = {};
    ctx.state[key] = s;
  }
  return s;
}

const IMAGE_INPUTS = ["a", "b", "c", "d"] as const;
const TIME_RE = /\bu_(time|frame)\b/;

export const glslExpressionNode: NodeDefinition = {
  type: "glsl-expression",
  name: "GLSL Expression",
  category: "image",
  subcategory: "modifier",
  description:
    "Write the body of a GLSL fragment shader and run it as one fullscreen pass — the per-pixel counterpart to Point Expression. Read wired images with texture(u_a, v_uv) (u_b–u_d), the clock with u_time/u_frame, and canvas size with u_res; write fragColor with straight alpha. Top-level function and struct definitions are hoisted above main() (or wrap them in // functions … // body). Declare tunables as one-line // comments and hit Sync to mint controls that the template exposes by name: // ch(\"k\", 0.5, 0, 1) → uniform float k (slider); // toggle(\"on\", true) → uniform bool on (pill); // pick(\"mode\", \"a\", \"b\") → uniform int mode plus const int mode_a=0, mode_b=1 (2–3-way pill / dropdown); // color(\"tint\", \"#ff8800\") → uniform vec4 tint (straight alpha, swatch); // ramp(\"ink\", \"#000000\", \"#ffffff\") → vec4 ink(float t) (gradient editor, seeded by the hex list); // curve(\"falloff\", 1, 0) → float falloff(float x) (float-curve editor, seeded by the y list). Sync is add-only (rows keep their tuned value — tune with set_param by channel NAME); scalar/toggle/color/ramp channels are also wireable inputs (scalar/scalar/vec4/color_ramp). Names can't start with u_. A compile error still renders passthrough/transparent — the WebGL info log is on get_shader_errors / get_graph (shaderError), and once in the console.",
  facts: {
    reads: ["time"],
    gotchas: [
      "The cache only busts on the clock when u_time or u_frame appears literally in the source text; time-driven behavior reached only through a channel value won't invalidate the cache.",
      "Channel names may not contain a double underscore (GLSL reserves __identifiers) even if they'd otherwise pass the u_-prefix rule.",
      "Image inputs occupy texture units 0-3; ramp/curve channels bind LUTs starting at unit 4, capped at 12 ramp/curve channels per node (extras sample black).",
      "resolveInputs adds a wireable socket named in:<channel id> (not the channel's display name) for scalar/toggle/color/ramp channels.",
      "Top-level function and struct definitions are hoisted above main(); if auto-hoist misses a helper, wrap it in // functions … // body.",
    ],
  },
  backend: "webgl2",
  inputs: [
    { name: "a", type: "image", required: false },
    { name: "b", type: "image", required: false },
    { name: "c", type: "image", required: false },
    { name: "d", type: "image", required: false },
  ],
  resolveInputs(params): InputSocketDef[] {
    const entries = (params.inputs as ExprInput[]) ?? [];
    return [
      { name: "a", type: "image", required: false },
      { name: "b", type: "image", required: false },
      { name: "c", type: "image", required: false },
      { name: "d", type: "image", required: false },
      ...entries
        .filter((e) => channelSocketType(e) !== null)
        .map<InputSocketDef>((e) => ({
          name: `in:${e.id}`,
          label: e.name,
          type: channelSocketType(e)!,
          required: false,
        })),
    ];
  },
  params: [
    {
      name: "inputs",
      label: "Channels",
      type: "expr_inputs",
      default: [],
      channelSync: true,
    },
    {
      name: "expression",
      label: "Shader",
      type: "string",
      multiline: true,
      default: DEFAULT_SOURCE,
    },
    {
      name: "on_error",
      label: "On error",
      type: "enum",
      options: ["passthrough", "transparent"],
      default: "passthrough",
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],
  // Fold time into the fingerprint only when the source references the
  // clock — static shaders cache as constants (the Point Expression
  // TIME_RE pattern, textually on the GLSL source).
  fingerprintExtras(params, ctx) {
    const source = (params.expression as string) ?? "";
    return TIME_RE.test(source) ? `t:${ctx.time}` : "";
  },

  compute({ inputs, params, ctx, nodeId }) {
    const state = getState(ctx, nodeId);

    // Channel values by name (a wired socket wins over the row — see
    // readChannelValue); only GLSL-safe names reach the template.
    const entries = glslChannels(params);
    const values = readChannelValues(entries, inputs);

    const { program, error } = ctx.tryShader(
      `glsl-expr:${nodeId}`,
      glslExpressionSource(params)
    );
    if (!program) {
      // Trim the source echo off the compiler message; warn once per
      // source. Line numbers in the log include the template prelude.
      const msg = trimShaderInfoLog(error);
      if (state.lastWarned !== msg) {
        console.warn(`[GLSL Expression ${nodeId}] ${msg}`);
        state.lastWarned = msg;
      }
      const a = inputs.a;
      if ((params.on_error as string) !== "transparent" && a?.kind === "image") {
        return { primary: a };
      }
      const out = ctx.allocImage();
      ctx.clearTarget(out, [0, 0, 0, 0]);
      return { primary: out };
    }
    state.lastWarned = null;

    if (!state.blank) {
      state.blank = ctx.uploadFloat32ToImage(new Float32Array(4), 1, 1);
    }
    const blank = state.blank;

    // LUT textures for ramp / curve channels, current before the draw.
    const lutUnits: { uniform: string; image: ImageValue }[] = [];
    const lutNames = new Set<string>();
    for (const e of entries) {
      const kind = channelKind(e);
      if (kind !== "ramp" && kind !== "curve") continue;
      if (lutUnits.length >= MAX_LUT_CHANNELS) {
        if (state.lastWarned !== "luts") {
          console.warn(
            `[GLSL Expression ${nodeId}] more than ${MAX_LUT_CHANNELS} ramp/curve channels — the rest sample black.`
          );
        }
        break;
      }
      lutNames.add(e.name);
      lutUnits.push({
        uniform: `u_${kind}_${e.name}`,
        image: ensureLut(ctx, state, e.name, kind, values[e.name]),
      });
    }
    releaseLuts(ctx, state, lutNames);

    const out = ctx.allocImage();
    ctx.drawFullscreen(program, out, (gl) => {
      for (let i = 0; i < IMAGE_INPUTS.length; i++) {
        const v = inputs[IMAGE_INPUTS[i]];
        const tex = v && v.kind === "image" ? v.texture : blank.texture;
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(
          gl.getUniformLocation(program, `u_${IMAGE_INPUTS[i]}`),
          i
        );
      }
      gl.uniform2f(
        gl.getUniformLocation(program, "u_res"),
        out.width,
        out.height
      );
      gl.uniform1f(gl.getUniformLocation(program, "u_time"), ctx.time);
      gl.uniform1f(gl.getUniformLocation(program, "u_frame"), ctx.frame);
      gl.uniform1f(
        gl.getUniformLocation(program, "u_aspect"),
        out.height > 0 ? out.width / out.height : 1
      );
      for (const e of entries) {
        const v = values[e.name];
        const loc = gl.getUniformLocation(program, e.name);
        switch (channelKind(e)) {
          case "scalar":
            gl.uniform1f(loc, typeof v === "number" ? v : 0);
            break;
          case "toggle":
            gl.uniform1i(loc, v === true ? 1 : 0);
            break;
          case "enum":
            gl.uniform1i(loc, Math.max(0, (e.options ?? []).indexOf(String(v))));
            break;
          case "color": {
            const c =
              Array.isArray(v) && v.length === 4 && typeof v[0] === "number"
                ? (v as number[])
                : [1, 1, 1, 1];
            gl.uniform4f(loc, c[0], c[1], c[2], c[3]);
            break;
          }
          default:
            break; // ramp / curve: bound as LUTs below
        }
      }
      for (let i = 0; i < lutUnits.length; i++) {
        const unit = LUT_FIRST_UNIT + i;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, lutUnits[i].image.texture);
        gl.uniform1i(gl.getUniformLocation(program, lutUnits[i].uniform), unit);
      }
    });
    return { primary: out };
  },

  dispose(ctx, nodeId) {
    const key = `glsl-expression:${nodeId}`;
    const s = ctx.state[key] as GlslState | undefined;
    if (s?.blank) ctx.releaseTexture(s.blank.texture);
    if (s) releaseLuts(ctx, s);
    delete ctx.state[key];
  },

  // Text-level sanity only — the offline validator stubs GL, so real
  // compilation happens at first eval through the tryShader error path.
  validateParams(params) {
    const raw = params.expression;
    if (raw === undefined) return [];
    if (typeof raw !== "string")
      return ["expression must be a string of GLSL."];
    const problems: string[] = [];
    if (raw.includes("#version"))
      problems.push(
        "the node owns #version — remove it from the expression."
      );
    if (/\bvoid\s+main\b/.test(raw))
      problems.push(
        "the node owns main() — write helpers at file scope (they are hoisted) and the rest as the body; don't declare main()."
      );
    if (raw.trim() !== "" && !raw.includes("fragColor"))
      problems.push(
        "expression never writes fragColor — the output would be undefined."
      );
    return problems;
  },
};
