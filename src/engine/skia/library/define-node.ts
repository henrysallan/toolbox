// defineSkslNode — the factory every `sksl`-class Skia node is built with
// (specdocs/101326_skia-target.md §3.2–3.3). One SkSL library function plus
// the mirrored node's params in; a NodeDefinition out.
//
// ─── API (Wave 2 ports build against this) ────────────────────────────────
//
//   defineSkslNode(spec: SkslNodeSpec): NodeDefinition
//
//   spec.type          "skia-<mirror>"
//   spec.name          display name
//   spec.mirrors       the default-layer node this ports ("noise")
//   spec.fn            the SkSL library function (shader-expr.ts contract +
//                      registry.ts `count` arrays); registered on define
//   spec.params        the mirrored node's ParamDefs — reuse the objects
//                      (`mirrorParams(perlinNoiseNode, [...names])`) so
//                      names, ranges and defaults cannot drift
//   spec.inputs        upstream shader sockets: { name, fnInput?, label?,
//                      unwired? } → `skia_shader` inputs feeding fn.inputs
//   spec.binds         lib params NOT fed 1:1 by a same-named toolbox param
//                      (a color_ramp split into arrays, a derived value)
//   spec.unsupported   param combos the port does not lower yet → problems;
//                      the node then emits transparent and says why
//   spec.whenUnwired   the node's whole output while an input is unwired,
//                      when the mirror does something other than "read
//                      transparent" (Color Ramp outputs opaque black)
//   + description / facts / category / subcategory / searchAliases
//
// What the def does:
//   - primary output `skia_shader`: { k: "call", fn: fn.id, node: nodeId,
//     params, inputs }. Every lib param whose name matches a toolbox param
//     is `bindParam(value, nodeId, name)` (scene-ir.ts), converted by the
//     lib param's type: float ← scalar / boolean (0|1) / enum (option
//     index); int ← the same, rounded; floatN ← vecN; color ← hex or RGBA
//     tuple → straight sRGB [r, g, b, a]. `binds` overrides or adds; use
//     bindParam when the value is one param, bindDerived when it is a
//     transform of one or more. Nothing is compiled here.
//   - aux `preview` (image): the expression fused (fuse.ts) and rendered by
//     CanvasKit (preview.ts → sksl-render.ts), so the node previews the
//     shipped program. Gated: built only when something consumes it.
//     The evaluator's opacity convention fades image outputs, so the preview
//     fuses with THIS node's `opacity` bind at 1 (the shader keeps it).
//   - skia: { class: "sksl", mirrors }, noMaskInput, validateParams =
//     `unsupported` (the recipe validator rejects what cannot render).
//
// Rules for the library function (also in shader-expr.ts):
//   - one lib param per toolbox param, same name, so binds keep their refs
//     and the exporter can ship each as its own track;
//   - private helpers prefixed with the entry name, nothing else may start
//     with it (gather copies rename by that prefix);
//   - straight alpha in and out; fold the node's `opacity` into alpha
//     yourself when the mirror declares OPACITY_PARAM (the evaluator never
//     touches a shader expression);
//   - `float` only, constant loop bounds with `break`, arrays read by loop
//     index only — check:skia-library compiles every registered function.
//
// Example (src/nodes/skia/noise.ts is the full reference):
//
//   export const skiaNoiseNode = defineSkslNode({
//     type: "skia-noise",
//     name: "Noise (Skia)",
//     mirrors: "noise",
//     subcategory: "generator",
//     description: "…",
//     fn: {
//       id: "tbx.noise.simplex@1",
//       entry: "tbx_noise_simplex",
//       source: `float4 tbx_noise_simplex(float2 uv, float2 res, float scale, …) { … }`,
//       params: [{ name: "scale", type: "float" }, …, { name: "color_a", type: "color" }],
//       inputs: [],
//       uses: ["tbx.noise.simplex2d", "tbx.noise.slice"],
//       cost: 4,
//     },
//     params: mirrorParams(perlinNoiseNode, ["opacity", "type", "scale", …]),
//     unsupported: (p) => (p.type === "simplex" ? [] : [`type=${p.type} is not ported yet`]),
//   });

import type {
  NodeCategory,
  NodeDefinition,
  NodeFacts,
  NodeSubcategory,
  ParamDef,
  RenderContext,
  SkiaShaderValue,
  SocketValue,
} from "../../types";
import type { Bind, RGBA } from "../scene-ir";
import { bindParam, bindStatic } from "../scene-ir";
import type { ShaderExpr } from "../shader-expr";
import { canvasKit, canvasKitError, canvasKitReady, ensureCanvasKit } from "../canvaskit";
import { fuseShader } from "../fuse";
import { renderShaderPreview } from "./preview";
import {
  registerSkslFunction,
  skslTypeWidth,
  validateSkslFunction,
  type SkslLibFunctionDef,
  type SkslLibParam,
} from "./registry";
import { TBX_CONST } from "./core";

export interface SkslNodeInput {
  // Socket name on the node (a `skia_shader` input). Keep the mirrored
  // node's socket name so converted graphs keep their wires.
  name: string;
  label?: string;
  // The library function input it feeds (default: `name`).
  fnInput?: string;
  // Straight RGBA the input reads while unwired (default transparent).
  unwired?: RGBA;
}

export interface SkslBindArgs {
  params: Record<string, unknown>;
  nodeId: string;
  ctx: RenderContext;
}

export interface SkslNodeSpec {
  type: string;
  name: string;
  mirrors?: string;
  category?: NodeCategory;
  subcategory?: NodeSubcategory;
  description: string;
  facts?: NodeFacts;
  searchAliases?: string[];
  fn: SkslLibFunctionDef;
  params: ParamDef[];
  inputs?: SkslNodeInput[];
  binds?: (args: SkslBindArgs) => Record<string, Bind<number | number[]>>;
  unsupported?: (params: Record<string, unknown>) => string[];
  whenUnwired?: (params: Record<string, unknown>) => RGBA | null;
}

export const SKSL_PREVIEW_OUTPUT = "preview";

const specs = new Map<string, SkslNodeSpec>();

// The mirrored node's ParamDefs by name, in the order given — the same
// objects, so a Skia port cannot drift from the node it mirrors.
export function mirrorParams(mirror: Pick<NodeDefinition, "type" | "params">, names: readonly string[]): ParamDef[] {
  return names.map((n) => {
    const p = mirror.params.find((d) => d.name === n);
    if (!p) throw new Error(`${mirror.type} has no param "${n}" to mirror`);
    return p;
  });
}

// A constant color as a call (no child shader): what an unwired input reads
// and what a node with unsupported params emits.
export function constExpr(node: string, color: RGBA): ShaderExpr {
  return { k: "call", fn: TBX_CONST.id, node, params: { color: bindStatic([...color]) }, inputs: {} };
}

// Hex (#rgb / #rrggbb / #rrggbbaa) or an RGBA / RGB tuple → straight 0..1.
export function parseSkslColor(v: unknown, fallback: RGBA = [0, 0, 0, 1]): RGBA {
  if (Array.isArray(v) && v.length >= 3 && v.every((x) => typeof x === "number")) {
    return [v[0], v[1], v[2], typeof v[3] === "number" ? v[3] : 1];
  }
  if (typeof v !== "string") return [...fallback];
  const h = v.trim().replace(/^#/, "");
  const full = h.length === 3 || h.length === 4 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(full)) return [...fallback];
  const byte = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255;
  return [byte(0), byte(2), byte(4), full.length === 8 ? byte(6) : 1];
}

// A toolbox param value → the value one lib param's uniform holds. Array
// (`count`) params have no default conversion; supply them through `binds`.
export function toSkslValue(def: ParamDef, raw: unknown, p: SkslLibParam): number | number[] | undefined {
  if (p.count !== undefined) return undefined;
  const value = raw === undefined ? def.default : raw;
  if (p.type === "color") return parseSkslColor(value);
  const width = skslTypeWidth(p.type);
  if (width > 1) {
    const arr = Array.isArray(value) ? value : [];
    return Array.from({ length: width }, (_, i) => (typeof arr[i] === "number" ? arr[i] : 0));
  }
  let n: number;
  if (typeof value === "boolean") n = value ? 1 : 0;
  else if (def.type === "enum" && def.options) n = Math.max(0, def.options.indexOf(String(value)));
  else if (typeof value === "number" && Number.isFinite(value)) n = value;
  else n = typeof def.default === "number" ? def.default : 0;
  return p.type === "int" ? Math.round(n) : n;
}

// Problems a node's CURRENT params have (the planner and MCP read this).
export function skslNodeProblems(type: string, params: Record<string, unknown>): string[] {
  return specs.get(type)?.unsupported?.(params) ?? [];
}

export function skslNodeSpec(type: string): SkslNodeSpec | undefined {
  return specs.get(type);
}

interface SkslNodeState {
  warned?: string | null;
}

export function defineSkslNode(spec: SkslNodeSpec): NodeDefinition {
  registerSkslFunction(spec.fn);
  specs.set(spec.type, spec);
  const fn = spec.fn;
  const inputs = spec.inputs ?? [];
  const byName = new Map(spec.params.map((p) => [p.name, p]));
  const hasOpacity = byName.has("opacity") && fn.params.some((p) => p.name === "opacity");
  const stateKey = (nodeId: string) => `skia-sksl:${nodeId}`;

  // Once per distinct message, like the SkSL Shader node: a broken node
  // logs when it breaks, not every frame.
  const warnOnce = (ctx: RenderContext, nodeId: string, msgs: string[]) => {
    const state = (ctx.state[stateKey(nodeId)] ??= {}) as SkslNodeState;
    const msg = msgs.length ? msgs.join(" ") : null;
    if (msg && state.warned !== msg) console.warn(`[${spec.name} ${nodeId}] ${msg}`);
    state.warned = msg;
  };
  // Declaration problems are fixed at module load; check them once.
  let fnProblems: string[] | null = null;

  const buildExpr = (
    params: Record<string, unknown>,
    wired: Record<string, SocketValue | undefined>,
    nodeId: string,
    ctx: RenderContext
  ): { expr: ShaderExpr; problems: string[] } => {
    fnProblems ??= validateSkslFunction(fn);
    const problems = [...fnProblems, ...(spec.unsupported?.(params) ?? [])];
    if (problems.length) return { expr: constExpr(nodeId, [0, 0, 0, 0]), problems };
    const shaderIn = (name: string) => {
      const v = wired[name];
      return v && v.kind === "skia_shader" ? (v as SkiaShaderValue).expr : null;
    };
    if (spec.whenUnwired && inputs.some((i) => !shaderIn(i.name))) {
      const c = spec.whenUnwired(params);
      if (c) return { expr: constExpr(nodeId, c), problems: [] };
    }
    const exprInputs: Record<string, ShaderExpr> = {};
    for (const i of inputs) {
      exprInputs[i.fnInput ?? i.name] = shaderIn(i.name) ?? constExpr(`${nodeId}:${i.name}`, i.unwired ?? [0, 0, 0, 0]);
    }
    const binds: Record<string, Bind<number | number[]>> = {};
    for (const p of fn.params) {
      const def = byName.get(p.name);
      if (!def) continue;
      const v = toSkslValue(def, params[p.name], p);
      if (v !== undefined) binds[p.name] = bindParam(v, nodeId, p.name);
    }
    Object.assign(binds, spec.binds?.({ params, nodeId, ctx }));
    return { expr: { k: "call", fn: fn.id, node: nodeId, params: binds, inputs: exprInputs }, problems: [] };
  };

  const transparent = (ctx: RenderContext) => {
    const out = ctx.allocImage();
    ctx.clearTarget(out, [0, 0, 0, 0]);
    return out;
  };

  const renderPreview = (ctx: RenderContext, nodeId: string, expr: ShaderExpr, problems: string[]) => {
    const kit = canvasKit();
    if (!kit) {
      const err = canvasKitError();
      if (err) problems.push(err);
      else void ensureCanvasKit().catch(() => {});
      return transparent(ctx);
    }
    // The evaluator fades this node's image outputs by `opacity`; the shader
    // must not fade them a second time.
    let shown = expr;
    if (hasOpacity && expr.k === "call" && expr.node === nodeId && expr.params.opacity) {
      shown = { ...expr, params: { ...expr.params, opacity: { ...expr.params.opacity, v: 1 } } };
    }
    const fused = fuseShader(shown, { resolution: [ctx.width, ctx.height], time: ctx.time });
    if (!fused.shader) {
      problems.push(...fused.problems);
      return transparent(ctx);
    }
    const r = renderShaderPreview(ctx, kit, fused.shader, ctx.width, ctx.height);
    problems.push(...r.problems);
    return r.image ?? transparent(ctx);
  };

  return {
    type: spec.type,
    name: spec.name,
    category: spec.category ?? "image",
    ...(spec.subcategory ? { subcategory: spec.subcategory } : {}),
    description: spec.description,
    ...(spec.searchAliases ? { searchAliases: spec.searchAliases } : {}),
    ...(spec.facts ? { facts: spec.facts } : {}),
    backend: "webgl2",
    noMaskInput: true,
    gatesOutputs: true,
    skia: { class: "sksl", ...(spec.mirrors ? { mirrors: spec.mirrors } : {}) },
    inputs: inputs.map((i) => ({
      name: i.name,
      ...(i.label ? { label: i.label } : {}),
      type: "skia_shader",
      required: false,
    })),
    params: spec.params,
    primaryOutput: "skia_shader",
    auxOutputs: [
      {
        name: SKSL_PREVIEW_OUTPUT,
        label: "Preview",
        type: "image",
        description:
          "This node's shader (and everything fused into it) rendered by CanvasKit at the canvas size — the program React Native Skia runs. For viewing only; Skia layers consume the shader output.",
      },
    ],
    // CanvasKit readiness, so the transparent placeholder rendered before the
    // WASM landed is not served from cache afterwards; the clock when the
    // function reads iTime.
    fingerprintExtras(_params, ctx) {
      const ck = canvasKitReady() ? "ck1" : "ck0";
      return fn.usesTime ? `${ck}|t:${ctx.time}` : ck;
    },
    compute({ inputs: wired, params, ctx, nodeId, consumedOutputs }) {
      const { expr, problems } = buildExpr(params, wired, nodeId, ctx);
      const primary: SkiaShaderValue = { kind: "skia_shader", expr };
      if (consumedOutputs && !consumedOutputs.has(`aux:${SKSL_PREVIEW_OUTPUT}`)) {
        warnOnce(ctx, nodeId, problems);
        return { primary };
      }
      const preview = renderPreview(ctx, nodeId, expr, problems);
      warnOnce(ctx, nodeId, problems);
      return { primary, aux: { [SKSL_PREVIEW_OUTPUT]: preview } };
    },
    dispose(ctx, nodeId) {
      delete ctx.state[stateKey(nodeId)];
    },
    validateParams(params) {
      return spec.unsupported?.(params) ?? [];
    },
  };
}
