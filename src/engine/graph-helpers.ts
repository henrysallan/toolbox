// Engine-side graph helpers. Lives here (rather than in src/state/graph.ts)
// so the engine subtree is fully self-contained — the export bundle copies
// `src/engine/` and friends without dragging in editor state.
//
// `src/state/graph.ts` re-exports these for back-compat with editor imports.

import type { ParamType, SocketType } from "./types";

// The reroute node's type string. A wire-organizing passthrough (rendered as
// a dot) that flattenGraph dissolves before evaluation — see
// specdocs/archive/071326_reroute-node.md. Lives here (engine-side) so flatten.ts can
// reference it without importing from src/nodes (invariant #1).
export const REROUTE_TYPE = "reroute";

// The frame node's type string — a Blender-style visual frame zone (a shaded
// rect behind its member nodes; membership = each member's `data.frameId`).
// Purely cosmetic: no sockets, never wired, never in the evaluator's needed
// set. "frame" itself was taken by the Auto-Layout sizing adapter node.
// Spec: specdocs/archive/073026_node-cosmetics-and-frames.md.
export const FRAME_TYPE = "frame-zone";

// Parse a React-Flow target handle ID. Regular input sockets are `in:<name>`;
// exposed param sockets are `in:param:<name>`. Returns null for unrecognized.
export function parseTargetHandleKind(
  handle: string
): { kind: "input"; name: string } | { kind: "param"; name: string } | null {
  if (handle.startsWith("in:param:")) {
    return { kind: "param", name: handle.slice("in:param:".length) };
  }
  if (handle.startsWith("in:")) {
    return { kind: "input", name: handle.slice("in:".length) };
  }
  return null;
}

// The switch node's type string + the shape of its numbered slots. Engine-side
// (like REROUTE_TYPE) so graph-validation can special-case its wildcard sockets
// without importing from src/nodes (invariant #1).
export const SWITCH_TYPE = "switch";
export const SWITCH_SLOT_PREFIX = "in";
/** `true` for the switch's value slots (`in0`, `in1`, …) — not `index`/`mask`. */
export function isSwitchSlot(name: string): boolean {
  return /^in\d+$/.test(name);
}
/** Same test against a React-Flow target handle (`in:in0`). */
export function isSwitchSlotHandle(handle: string | undefined | null): boolean {
  if (!handle) return false;
  const parsed = parseTargetHandleKind(handle);
  return parsed?.kind === "input" && isSwitchSlot(parsed.name);
}
/** Switch `type` param values that mean "infer from what's wired in". */
export const SWITCH_AUTO = "auto";
export function switchTypeIsAuto(t: unknown): boolean {
  return t == null || t === SWITCH_AUTO;
}

// ---------------------------------------------------------------------------
// Coercion table — the canonical cross-type wires. Mirrors coerce.ts (the
// RUNTIME truth); this is the pure predicate form, used by the editor's
// "can this wire land here" checks, the AI-recipe validator, and by node defs
// that unify the types wired into them (Switch). It lives HERE rather than in
// graph-validation.ts so a node def can import it without dragging the
// registry — and therefore every node def — into a cycle.
// graph-validation.ts re-exports it; `editorCanCoerce` there adds the
// polymorphic defType exceptions on top.
// ---------------------------------------------------------------------------
export function coercible(src: string, tgt: string): boolean {
  if (src === tgt) return true;
  if (src === "mask" && tgt === "image") return true;
  if (src === "image" && tgt === "mask") return true;
  // Spline → mask: the coercion layer rasterizes the shape's filled
  // silhouette to a coverage mask.
  if (src === "spline" && tgt === "mask") return true;
  // Scalar broadcasts into vec/uv sockets ((s,s) for uv).
  if (src === "scalar" && (tgt === "vec2" || tgt === "vec3" || tgt === "vec4" || tgt === "uv"))
    return true;
  // Vector WIDENING — vec2 → vec3/vec4, vec3 → vec4, padding z = 0 and w = 1
  // (a point's homogeneous coordinate; a colour's opaque alpha). Widening
  // only: narrowing would silently drop components, and a vec4 landing on a
  // vec2 socket is far more often a mistake than an intent. This is what lets
  // a Switch (or any vec socket) mix arities — see nodes/effect/switch.ts.
  if (src === "vec2" && (tgt === "vec3" || tgt === "vec4")) return true;
  if (src === "vec3" && tgt === "vec4") return true;
  // Image → uv: R/G reinterpreted as per-pixel (u, v) — zero-copy re-wrap in
  // coerce.ts. Grayscale lands on the (f, f) diagonal, i.e. Blender's
  // Fac → Vector domain warp. Mask is excluded: R-format textures read G = 0,
  // which would silently collapse v — route mask → image first.
  if (src === "image" && tgt === "uv") return true;
  // Image/mask → scalar: center-pixel R-channel sample at eval time.
  if ((src === "image" || src === "mask") && tgt === "scalar") return true;
  // Audio → scalar: AnalyserNode RMS level.
  if (src === "audio" && tgt === "scalar") return true;
  // Image ↔ element: wrap as full-canvas element / flatten to image.
  if (src === "image" && tgt === "element") return true;
  if (src === "element" && tgt === "image") return true;
  // Geometry → object3d: auto-wrap in a Mesh with carried transform +
  // material (coerce.ts / three-geometry.ts). One-way — an object3d may be
  // a light/group/instanced mesh, so there's no honest reverse.
  // `points` ↔ `points3d` deliberately coerce in NEITHER direction: the
  // types differ by SPACE (authored [0,1]² vs world meters), and no
  // canonical mapping exists — crossings are explicit nodes/polymorphic
  // inputs only (081026 spec §2).
  if (src === "geometry" && tgt === "object3d") return true;
  // Instances → object3d: the scene boundary resolves the stream into a
  // retained InstancedMesh (three-geometry.ts). One-way, like geometry.
  // instances → geometry is deliberately NOT a coercion — that's Realize
  // Instances, an explicit N×-vertex bake (081026 spec §4.4).
  if (src === "instances" && tgt === "object3d") return true;
  return false;
}

// Preference order when SEVERAL types could serve as the common one — richer
// wins, so {image, mask} unifies on image (mask→image keeps every channel)
// rather than flattening to luminance. Unlisted types rank 0; ties fall back
// to declaration order, i.e. the first wire in.
const UNIFY_RANK: Record<string, number> = {
  vec4: 4,
  vec3: 3,
  vec2: 2,
  uv: 2,
  image: 2,
  element: 2,
  mask: 1,
};

/**
 * The single socket type a set of wired types can all coerce INTO — the
 * type a polymorphic multi-input node (Switch) should give every one of its
 * slots so the evaluator's per-socket coercion does the conversions for free.
 *
 * Only types actually present are considered, so the result is always a real
 * type someone wired (never an invented supertype). When nothing unifies —
 * e.g. `spline` and `image`, which coerce in neither direction — the first
 * type wins and the odd wire out simply yields nothing at that slot; there's
 * no honest answer there, and picking a present type keeps the rest working.
 *
 * Note the common denominator can be the NARROW one: {image, scalar} unifies
 * on scalar (image→scalar is a 1×1 readback; scalar→image doesn't exist), so
 * both slots produce a value. Force the type param if you want the other read.
 */
export function unifySocketTypes(
  types: readonly (SocketType | undefined)[]
): SocketType | null {
  const uniq = Array.from(new Set(types.filter(Boolean) as SocketType[]));
  if (uniq.length === 0) return null;
  if (uniq.length === 1) return uniq[0];
  const candidates = uniq.filter((t) => uniq.every((u) => coercible(u, t)));
  if (candidates.length === 0) return uniq[0];
  return candidates.reduce((best, t) =>
    (UNIFY_RANK[t] ?? 0) > (UNIFY_RANK[best] ?? 0) ? t : best
  );
}

// Map a ParamType to the socket type that drives it. Returns null for param
// types that don't have a meaningful data-socket representation (paint,
// curves, merge_layers, file, enum, ...).
//
// This function is also what ParamPanel reads to decide whether a param gets
// an expose button (`exposable = paramSocketType(p.type) !== null`), so a case
// added here lights up the socket on EVERY node declaring that param type —
// which is exactly how one `color_ramp` line reached all nine ramp params
// across eight nodes (080526_on-node-color-ramp.md).
export function paramSocketType(type: ParamType): SocketType | null {
  switch (type) {
    case "scalar":
    case "boolean":
      return "scalar";
    case "string":
      return "string";
    case "color_ramp":
      return "color_ramp";
    case "vec2":
      return "vec2";
    case "vec3":
      return "vec3";
    case "color":
    case "vec4":
      return "vec4";
    default:
      return null;
  }
}
