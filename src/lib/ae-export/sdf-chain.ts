// Hard SDF chains — which SDF trees After Effects draws natively (spec
// 091926_after-effects-handoff.md §10 M4, "SDF hard chains → Merge Paths";
// results specdocs/ae-m4/sdf.md).
//
// An SDF tree is an AST compiled into its consumer's fragment shader
// (src/engine/sdf-compile.ts). Under three consumers — sdf-rasterize,
// sdf-to-mask and sdf-to-spline — only the tree's zero contour (or an offset
// of it) is visible, and a "hard" tree's contour is exactly a boolean of
// parametric shapes:
//
//   leaves      circle, rectangle, polygon, star, triangle, line segment
//   booleans    union / intersection / subtraction (min / max / max(a, −b)),
//               and the smooth ones at smoothness ≤ 0 (smin(a, b, 0) = min)
//   offsets     round (d − r) and onion (|d| − t): an offset distributes over
//               min / max (max(a, b) − r = max(a − r, b − r)), so it lands on
//               the leaves — onion(X) = round_t(X) − round_−t(X)
//   position    translate, rotate, scale (a group transform); mirror (the
//               kept half and its reflection); repeat without jitter (a
//               Repeater per axis); polar with a whole segment count (a
//               rotating Repeater)
//
// Everything else keeps the shader route, named per node: smooth booleans,
// displace, twist, morph, a per-pixel scalar field (polygon sides, rotation
// angle), sdf-spline / sdf-from-image (distance textures computed per eval),
// per-shape materials under a rasterize, and the shading consumers.
//
// Pure: planAeExport (plan.ts) runs it on PlanNodes, the scene walk
// (scene/sdf.ts) on the flattened editor graph — both through SdfChainGraph.

export const SDF_NATIVE_CONSUMERS: ReadonlySet<string> = new Set(["sdf-rasterize", "sdf-to-mask", "sdf-to-spline"]);

export const SDF_LEAF_TYPES: ReadonlySet<string> = new Set([
  "sdf-circle",
  "sdf-rectangle",
  "sdf-polygon",
  "sdf-star",
  "sdf-triangle",
  "sdf-line-segment",
]);

// Variadic booleans: their sockets are the `slots` param (default a, b).
export const SDF_SLOTTED_TYPES: ReadonlySet<string> = new Set(["sdf-union", "sdf-smooth-union"]);

export interface SdfChainGraph {
  type(id: string): string | undefined;
  // Full current params (defaults included).
  values(id: string): Record<string, unknown>;
  // The producer wired into `<id>:in:<socket>` — its id and output handle
  // ("out" | "aux:<name>").
  input(id: string, socket: string): { id: string; handle: string } | undefined;
  // Params that change over time: a live keyframe track or a value wire.
  animated(id: string): ReadonlySet<string>;
}

export type SdfChainVerdict =
  | {
      native: true;
      // Every node of the tree (consumer excluded), unordered.
      nodes: string[];
      // A rasterize's fill: the one colour every leaf paints (the consumer's
      // `foreground` unless a material / painted leaf overrides it everywhere).
      fill?: { node: string; param: string };
      notes: string[];
    }
  | { native: false; nodes: string[]; node: string; type: string; reason: string };

class Refusal extends Error {
  constructor(
    readonly node: string,
    readonly type: string,
    readonly reason: string
  ) {
    super(reason);
  }
}

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const isWhole = (x: number) => Math.abs(x - Math.round(x)) < 1e-9;

export function sdfSlotsOf(values: Record<string, unknown>): string[] {
  const raw = values.slots;
  return Array.isArray(raw) && raw.length > 0 && raw.every((x) => typeof x === "string") && !raw.includes("mask") ? (raw as string[]) : ["a", "b"];
}

// Colour source of a subtree under a rasterize: the param that paints it.
interface Paint {
  node: string;
  param: string;
}

export function sdfChainVerdict(consumer: string, g: SdfChainGraph): SdfChainVerdict {
  const ctype = g.type(consumer) ?? "?";
  const nodes: string[] = [];
  const seen = new Set<string>();
  const notes = new Set<string>();
  const paints = new Map<string, Paint>();
  const colored = ctype === "sdf-rasterize";
  const add = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      nodes.push(id);
    }
  };
  const refuse = (id: string, reason: string): never => {
    throw new Refusal(id, g.type(id) ?? "?", reason);
  };
  const structural = (id: string, params: string[]) => {
    const anim = g.animated(id);
    for (const p of params) if (anim.has(p)) refuse(id, `its ${p} is animated — it sets the shape's structure (path count, copies), which AE cannot key`);
  };

  const position = (id: string | undefined, via: string) => {
    if (!id) return;
    const src = g.input(id, "position");
    if (!src) return;
    const t = g.type(src.id);
    if (src.handle !== "out") refuse(src.id, `${via}'s position comes from ${t} ${src.handle} (a per-cell id, not a coordinate fold)`);
    const v = g.values(src.id);
    switch (t) {
      case "sdf-translate":
      case "sdf-scale":
        break;
      case "sdf-rotate":
        if (g.input(src.id, "angle_field")) refuse(src.id, "a per-pixel angle field (each pixel turns by its own angle)");
        break;
      case "sdf-mirror":
        structural(src.id, ["axis"]);
        break;
      case "sdf-repeat": {
        structural(src.id, ["bounded", "limit_x", "limit_y"]);
        for (const j of ["rotation_jitter", "position_jitter_x", "position_jitter_y", "scale_jitter"])
          if (num(v[j], 0) !== 0 || g.animated(src.id).has(j)) refuse(src.id, `${j} — per-cell random offsets hash the cell id inside the shader`);
        if (v.bounded === true && (!isWhole(num(v.limit_x, 3)) || !isWhole(num(v.limit_y, 3))))
          refuse(src.id, "fractional repeat limits put the edge copies off the grid");
        break;
      }
      case "sdf-polar":
        structural(src.id, ["segments"]);
        if (!isWhole(Math.max(1, num(v.segments, 6)))) refuse(src.id, "a fractional segment count leaves a partial sector at the seam");
        break;
      case "sdf-twist":
        refuse(src.id, "twist bends straight edges into spirals (a non-affine fold)");
        break;
      default:
        refuse(src.id, `${t ?? "an unknown node"} drives the position — not a coordinate fold AE can follow`);
    }
    add(src.id);
    position(src.id, t ?? src.id);
  };

  const tree = (id: string, paint: Paint | undefined) => {
    const t = g.type(id);
    const v = g.values(id);
    if (!t) refuse(id, "not in this layer");
    if (SDF_LEAF_TYPES.has(t!)) {
      if (t === "sdf-polygon") {
        if (g.input(id, "sides_field")) refuse(id, "a per-pixel sides field (each pixel picks its own side count)");
        structural(id, ["sides"]);
        if (!isWhole(Math.max(3, num(v.sides, 6)))) refuse(id, "a fractional side count is not a closed polygon");
      }
      if (t === "sdf-star") {
        structural(id, ["points"]);
        if (!isWhole(Math.max(3, num(v.points, 5)))) refuse(id, "a fractional point count is not a closed star");
      }
      const own = v.paint === true ? { node: id, param: "color" } : paint;
      if (colored) paints.set(id, own ?? { node: consumer, param: "foreground" });
      add(id);
      position(id, t!);
      return;
    }
    const kids = (sockets: string[]) => {
      for (const s of sockets) {
        const w = g.input(id, s);
        if (!w) continue;
        if (w.handle !== "out") refuse(w.id, `wired from ${g.type(w.id)} ${w.handle}`);
        tree(w.id, paint);
      }
    };
    switch (t) {
      case "sdf-union":
      case "sdf-intersection":
      case "sdf-subtraction":
        kids(t === "sdf-union" ? sdfSlotsOf(v) : ["a", "b"]);
        break;
      case "sdf-smooth-union":
      case "sdf-smooth-intersection":
      case "sdf-smooth-subtraction":
        if (g.input(id, "smoothness") || g.animated(id).has("smoothness") || num(v.smoothness, 0.05) > 0)
          refuse(id, "a smooth blend (smin / smax) has no Merge Paths form");
        notes.add(`${t} at smoothness ≤ 0 is its hard boolean`);
        kids(t === "sdf-smooth-union" ? sdfSlotsOf(v) : ["a", "b"]);
        break;
      case "sdf-round":
      case "sdf-onion":
        kids(["sdf"]);
        break;
      case "sdf-material":
        if (colored) {
          if ((v.color_mode ?? "constant") !== "constant" || g.input(id, "t")) refuse(id, "a colour ramp along a field paints per pixel");
          if (g.input(id, "color")) refuse(id, "a wired material colour");
          paint = { node: id, param: "color" };
        }
        add(id);
        kids(["sdf"]);
        return;
      case "sdf-displace":
        refuse(id, "displacing the distance by an image field moves every edge per pixel");
        break;
      case "sdf-morph":
        refuse(id, "a distance-field morph (mix of two fields) has no path form");
        break;
      case "sdf-spline":
        refuse(id, "its distance loops over a spline texture flattened per eval");
        break;
      case "sdf-from-image":
        refuse(id, "its distance is a JFA transform of an image, computed per eval");
        break;
      default:
        refuse(id, `${t} is not an SDF tree node AE can draw`);
    }
    add(id);
  };

  try {
    if (!SDF_NATIVE_CONSUMERS.has(ctype)) refuse(consumer, `${ctype} shades the distance field (not just its contour)`);
    const root = g.input(consumer, "sdf");
    if (root) {
      if (root.handle !== "out") refuse(root.id, `wired from ${g.type(root.id)} ${root.handle}`);
      tree(root.id, undefined);
    }
    let fill: Paint | undefined;
    if (colored) {
      const keyOf = (p: Paint) => (g.animated(p.node).has(p.param) ? `${p.node}.${p.param}` : String(g.values(p.node)[p.param] ?? "#ffffff").toLowerCase());
      const distinct = new Map<string, Paint>();
      for (const p of paints.values()) distinct.set(keyOf(p), p);
      if (distinct.size > 1) {
        const leaf = [...paints.entries()].find(([, p]) => p.node !== consumer)?.[0] ?? consumer;
        refuse(leaf, `shapes paint different colours (${distinct.size}) — toolbox colours each pixel by its nearest shape, a merged path takes one fill`);
      }
      fill = distinct.size ? [...distinct.values()][0] : { node: consumer, param: "foreground" };
    }
    return { native: true, nodes, ...(fill ? { fill } : {}), notes: [...notes] };
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    return { native: false, nodes, node: e.node, type: e.type, reason: e.reason };
  }
}
