// SDF provenance — which engine node + param produced each value in an SDF
// tree, so the Skia SDF terminals (nodes/skia/sdf.ts) can bind every uniform
// they generate to the param it came from (specdocs/101326_skia-target.md
// §3.4: a keyframed radius must export as a track, not a sampled series).
//
// The SDF nodes are data-only: compute returns a small tree of numbers
// (engine/types.ts SdfNode / PositionNode / ScalarFieldNode) and nothing in
// it says which node made it. Rather than change every SDF def, the Skia
// terminals' module instruments those defs once (`instrumentSdfDefs`): the
// wrapped compute calls the original and records, for each tree object the
// call created, `{ node, type, params, sockets }` in a WeakMap. Behaviour is
// unchanged — the original's return value is passed through untouched.
//
//   - Only objects of a kind the def's SOURCES entry lists are claimed, and
//     never an object that already has a producer: an SDF Union with one
//     input returns its upstream root unchanged, and that root keeps the
//     primitive that made it.
//   - The table below is the field → param map, one row per kind a def can
//     emit. `scale` is the IR value per param unit (degrees → radians);
//     `fix` re-applies the clamp the def's compute applies (the SkSL
//     generator applies the same clamp in-shader), so a uniform can carry
//     the RAW param and still bind it as a plain ref; `socket` names the
//     input that overrides the param when it carries a value of `sk` kind.
//
// Proposed contract (in the lane report): an optional producer id on the
// SDF value types themselves would make this instrumentation unnecessary.

import type { ComputeArgs, NodeDefinition, NodeOutput, PositionValue, SdfValue, SocketValue, SplineValue } from "../../types";
import type { Bind, BindRef } from "../scene-ir";
import { paintSdf } from "../../sdf-material";
import { flattenSpline } from "../../spline-flatten";

export interface SdfProvenance {
  node: string;
  type: string;
  params: Record<string, unknown>;
  sockets: Record<string, SocketValue | undefined>;
}

export interface SdfFieldSource {
  // The param the field reads when `socket` carries nothing.
  p: string;
  // Input socket that overrides the param, its value kind(s), and the
  // component of a vector socket.
  socket?: string;
  sk?: readonly string[];
  c?: number;
  // IR value = param × scale (BindRef.scale).
  scale?: number;
  // The def's clamp, applied to the (scaled) param. Must match the shader.
  fix?: (v: number, node: Record<string, unknown>) => number;
  // The param is a color (hex) bound as a float4 RGBA uniform.
  color?: boolean;
}

type FieldMap = Record<string, SdfFieldSource>;

const VEC2 = ["vec2"] as const;
const SCALAR = ["scalar"] as const;
const COLOR_SOCKET = ["vec4", "vec3"] as const;
const max0 = (v: number) => Math.max(0, v);
const num = (x: unknown) => (typeof x === "number" ? x : NaN);

// A primitive's own `paint` swatch (engine/sdf-material.ts paintSdf).
const PAINT: FieldMap = { color: { p: "color", color: true } };
const xy = (px: string, py: string, socket: string): FieldMap => ({
  cx: { p: px, socket, sk: VEC2, c: 0 },
  cy: { p: py, socket, sk: VEC2, c: 1 },
});
const smoothK: FieldMap = { k: { p: "smoothness", socket: "smoothness", sk: SCALAR, fix: max0 } };
const repeatGrid: FieldMap = {
  spacingX: { p: "spacing_x", socket: "spacing", sk: VEC2, c: 0, fix: (v) => Math.max(0.001, v) },
  spacingY: { p: "spacing_y", socket: "spacing", sk: VEC2, c: 1, fix: (v) => Math.max(0.001, v) },
  cx: { p: "center_x", socket: "center", sk: VEC2, c: 0 },
  cy: { p: "center_y", socket: "center", sk: VEC2, c: 1 },
};

// def type → tree kind → field → source. A kind listed with no fields is
// still claimed (it is the def's own structure).
export const SDF_SOURCES: Record<string, Record<string, FieldMap>> = {
  "sdf-circle": {
    circle: { ...xy("x", "y", "center"), r: { p: "radius", socket: "radius", sk: SCALAR } },
    material: PAINT,
  },
  "sdf-rectangle": {
    rect: {
      ...xy("x", "y", "center"),
      sx: { p: "width", socket: "size", sk: VEC2, c: 0, scale: 0.5, fix: max0 },
      sy: { p: "height", socket: "size", sk: VEC2, c: 1, scale: 0.5, fix: max0 },
      cornerRadius: { p: "corner_radius", fix: (v, n) => Math.max(0, Math.min(Math.min(num(n.sx), num(n.sy)), v)) },
    },
    material: PAINT,
  },
  "sdf-line-segment": {
    lineSegment: {
      ax: { p: "ax", socket: "a", sk: VEC2, c: 0 },
      ay: { p: "ay", socket: "a", sk: VEC2, c: 1 },
      bx: { p: "bx", socket: "b", sk: VEC2, c: 0 },
      by: { p: "by", socket: "b", sk: VEC2, c: 1 },
      r: { p: "thickness", socket: "thickness", sk: SCALAR, fix: max0 },
    },
    material: PAINT,
  },
  "sdf-polygon": {
    polygon: {
      ...xy("x", "y", "center"),
      r: { p: "radius", socket: "radius", sk: SCALAR },
      sides: { p: "sides", fix: (v) => Math.max(3, v) },
    },
    material: PAINT,
  },
  "sdf-triangle": {
    triangle: {
      ax: { p: "ax", socket: "a", sk: VEC2, c: 0 },
      ay: { p: "ay", socket: "a", sk: VEC2, c: 1 },
      bx: { p: "bx", socket: "b", sk: VEC2, c: 0 },
      by: { p: "by", socket: "b", sk: VEC2, c: 1 },
      cx: { p: "cx", socket: "c", sk: VEC2, c: 0 },
      cy: { p: "cy", socket: "c", sk: VEC2, c: 1 },
    },
    material: PAINT,
  },
  "sdf-star": {
    star: {
      ...xy("x", "y", "center"),
      r: { p: "radius", socket: "radius", sk: SCALAR },
      sides: { p: "points", fix: (v) => Math.max(3, v) },
      sharpness: { p: "sharpness", fix: (v, n) => Math.max(2, Math.min(num(n.sides), v)) },
    },
    material: PAINT,
  },
  // segments / segCount / closed are derived from the wired spline (the
  // generator binds them with deps on the `spline` socket).
  "sdf-spline": { splineSdf: {}, material: PAINT, empty: {} },
  "sdf-union": { union: {}, empty: {} },
  "sdf-intersection": { intersection: {}, empty: {} },
  "sdf-subtraction": { subtraction: {}, empty: {} },
  "sdf-smooth-union": { smoothUnion: smoothK, empty: {} },
  "sdf-smooth-intersection": { smoothIntersection: smoothK, empty: {} },
  "sdf-smooth-subtraction": { smoothSubtraction: smoothK, empty: {} },
  "sdf-morph": {
    morph: { t: { p: "amount", socket: "amount", sk: SCALAR, fix: (v) => Math.max(0, Math.min(1, v)) } },
    empty: {},
  },
  "sdf-round": { round: { r: { p: "radius", socket: "radius", sk: SCALAR } }, empty: {} },
  "sdf-onion": { onion: { thickness: { p: "thickness", socket: "thickness", sk: SCALAR, fix: max0 } }, empty: {} },
  "sdf-material": {
    material: { color: { p: "color", color: true, socket: "color", sk: COLOR_SOCKET } },
    empty: {},
    constant: {},
  },
  "sdf-translate": {
    translate: {
      tx: { p: "tx", socket: "offset", sk: VEC2, c: 0 },
      ty: { p: "ty", socket: "offset", sk: VEC2, c: 1 },
    },
  },
  "sdf-scale": {
    scale: {
      sx: { p: "sx", socket: "scale", sk: VEC2, c: 0 },
      sy: { p: "sy", socket: "scale", sk: VEC2, c: 1 },
      cx: { p: "cx" },
      cy: { p: "cy" },
    },
  },
  "sdf-rotate": {
    rotate: {
      rotation: { p: "rotation", socket: "angle", sk: SCALAR, scale: Math.PI / 180 },
      cx: { p: "cx", socket: "pivot", sk: VEC2, c: 0 },
      cy: { p: "cy", socket: "pivot", sk: VEC2, c: 1 },
    },
  },
  "sdf-repeat": {
    repeat: {
      ...repeatGrid,
      limitX: { p: "limit_x", fix: max0 },
      limitY: { p: "limit_y", fix: max0 },
      rotJitter: { p: "rotation_jitter", fix: max0 },
      posJitterX: { p: "position_jitter_x", fix: max0 },
      posJitterY: { p: "position_jitter_y", fix: max0 },
      scaleJitter: { p: "scale_jitter", fix: max0 },
      seed: { p: "seed" },
    },
    cellId: repeatGrid,
  },
  "sdf-mirror": { mirror: { ...xy("center_x", "center_y", "center") } },
  "sdf-polar": {
    polar: {
      ...xy("center_x", "center_y", "center"),
      segments: { p: "segments", fix: (v) => Math.max(1, v) },
      rotation: { p: "rotation" },
    },
  },
  "sdf-twist": {
    twist: { ...xy("center_x", "center_y", "center"), strength: { p: "strength", socket: "strength", sk: SCALAR } },
  },
};

// The SDF defs the instrumentation applies to, which are also the ones
// offered inside a Skia layer (`skia: { class: "sksl" }` on their defs).
export const SKIA_SDF_TREE_TYPES: readonly string[] = Object.keys(SDF_SOURCES);

const provenance = new WeakMap<object, SdfProvenance>();
const INSTRUMENTED = Symbol.for("toolbox.skia.sdfProvenance");

export function sdfProvenance(obj: object): SdfProvenance | undefined {
  return provenance.get(obj);
}

// Object-valued links in the tree types (children, positions, fields).
const LINKS = ["a", "b", "child", "position", "rotation", "strength", "sides"] as const;

function claim(root: unknown, kinds: Record<string, FieldMap>, rec: SdfProvenance, depth = 0): void {
  if (!root || typeof root !== "object" || depth > 64) return;
  const kind = (root as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !(kind in kinds) || provenance.has(root)) return;
  provenance.set(root, rec);
  for (const k of LINKS) claim((root as Record<string, unknown>)[k], kinds, rec, depth + 1);
}

// Record which objects of `out` this def call created.
export function recordSdfOutput(
  type: string,
  nodeId: string,
  params: Record<string, unknown>,
  inputs: Record<string, SocketValue | undefined>,
  out: NodeOutput | void
): void {
  const kinds = SDF_SOURCES[type];
  if (!kinds || !out) return;
  const rec: SdfProvenance = { node: nodeId, type, params: { ...params }, sockets: { ...inputs } };
  const values = [out.primary, ...Object.values(out.aux ?? {})];
  for (const v of values) {
    if (v && (v.kind === "sdf" || v.kind === "position" || v.kind === "scalar_field")) claim(v.root, kinds, rec);
  }
}

// SDF Spline uploads its flattened segments to a GL texture, which throws on
// the exporter's data-only context (lib/skia-export/scene-sample.ts: no GL),
// and the export would silently lose the shape. Without GL the instrumented
// def builds the same tree minus the texture (sdf-spline.ts compute, the
// upload skipped); the Skia generator re-flattens from the recorded spline.
const SPLINE_MAX_SEGMENTS = 1024;
function splineSdfWithoutGl({ inputs, params }: ComputeArgs): NodeOutput {
  const pos = inputs.position;
  const position = pos && pos.kind === "position" ? (pos as PositionValue).root : { kind: "canvasUv" as const };
  const src = inputs.spline;
  if (!src || src.kind !== "spline") return { primary: { kind: "sdf", root: { kind: "empty" } } };
  const subdivisions = Math.max(1, Math.round((params.subdivisions as number) ?? 16));
  const flat = flattenSpline(src as SplineValue, subdivisions);
  const out: SdfValue = {
    kind: "sdf",
    root: paintSdf(
      {
        kind: "splineSdf",
        position,
        segmentTexture: null as unknown as WebGLTexture,
        segCount: Math.min(SPLINE_MAX_SEGMENTS, flat.segCount),
        closed: flat.allClosed && !params.force_open,
      },
      params
    ),
  };
  return { primary: out };
}

const hasGl = (args: ComputeArgs) => typeof (args.ctx.gl as { createTexture?: unknown } | undefined)?.createTexture === "function";

// Wrap each def's compute once. Idempotent (hot reload re-imports modules).
export function instrumentSdfDefs(defs: readonly NodeDefinition[]): void {
  for (const def of defs) {
    if (!(def.type in SDF_SOURCES)) continue;
    const marked = def as NodeDefinition & { [INSTRUMENTED]?: boolean };
    if (marked[INSTRUMENTED]) continue;
    const original = def.compute;
    const dataOnly = def.type === "sdf-spline" ? splineSdfWithoutGl : null;
    def.compute = (args) => {
      const out = dataOnly && !hasGl(args) ? dataOnly(args) : original.call(def, args);
      recordSdfOutput(def.type, args.nodeId, args.params, args.inputs, out);
      return out;
    };
    marked[INSTRUMENTED] = true;
  }
}

// ---- binds -----------------------------------------------------------------------

const near = (a: number, b: number) => Object.is(a, b) || Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));

export function hexToRgba01(hex: unknown): [number, number, number, number] | null {
  if (typeof hex !== "string") return null;
  const raw = hex.trim().replace(/^#/, "");
  const s = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw.length === 8 ? raw.slice(0, 6) : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  const n = parseInt(s, 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255, 1];
}

// The bind for one numeric field of a tree object. `value` is what the tree
// holds (what the native terminals bind); the returned bind's `v` may be
// the raw param instead when the shader re-applies the def's clamp.
export function bindSdfField(obj: object, field: string, value: number): Bind<number> {
  const prov = provenance.get(obj);
  const kind = (obj as { kind?: string }).kind ?? "";
  const src = prov ? SDF_SOURCES[prov.type]?.[kind]?.[field] : undefined;
  if (!prov || !src) return { v: value };
  const node = prov.node;
  if (src.socket) {
    const s = prov.sockets[src.socket];
    if (s && (src.sk ?? []).includes(s.kind)) return { v: value, deps: [{ node, param: src.socket }] };
  }
  const raw = prov.params[src.p];
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const v = src.scale !== undefined ? raw * src.scale : raw;
    const fixed = src.fix ? src.fix(v, obj as Record<string, unknown>) : v;
    if (near(fixed, value)) {
      const ref: BindRef = src.scale !== undefined ? { node, param: src.p, scale: src.scale } : { node, param: src.p };
      return { v, ref };
    }
  }
  return { v: value, deps: [{ node, param: src.p }] };
}

// A color field (straight RGB in the tree) as a float4 RGBA uniform.
export function bindSdfColor(obj: object, field: string, rgb: readonly number[]): Bind<number[]> {
  const value = [rgb[0] ?? 1, rgb[1] ?? 1, rgb[2] ?? 1, 1];
  const prov = provenance.get(obj);
  const kind = (obj as { kind?: string }).kind ?? "";
  const src = prov ? SDF_SOURCES[prov.type]?.[kind]?.[field] : undefined;
  if (!prov || !src) return { v: value };
  const node = prov.node;
  if (src.socket) {
    const s = prov.sockets[src.socket];
    if (s && (src.sk ?? []).includes(s.kind)) return { v: value, deps: [{ node, param: src.socket }] };
  }
  const parsed = hexToRgba01(prov.params[src.p]);
  if (parsed && parsed.slice(0, 3).every((c, i) => Object.is(c, value[i]))) return { v: parsed, ref: { node, param: src.p } };
  return { v: value, deps: [{ node, param: src.p }] };
}

// Derived from one or more of the producer's params / sockets.
export function bindSdfDerived<T>(obj: object, value: T, params: string[]): Bind<T> {
  const prov = provenance.get(obj);
  if (!prov) return { v: value };
  return { v: value, deps: params.map((param) => ({ node: prov.node, param })) };
}
