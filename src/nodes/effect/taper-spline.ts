import type {
  NodeDefinition,
  SplineAnchor,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import { measureSubpath } from "@/engine/spline-math";
import {
  defaultFloatCurve,
  sampleFloatCurve,
  sanitizeFloatCurve,
} from "@/engine/float-curve";

// Taper Spline — per-anchor scale of each point's offset from a pivot,
// shaped by a curve over path progress. Modulate Splines is per-subpath
// (one scale around the centroid); Trim Path is by arc length. This is
// the motion-graphics envelope: taper / flare a path from start to end
// without an expression. Scale handles with the same factor so cubics
// stay shaped.

type Pivot = "centroid" | "first" | "last" | "custom";
type Axis = "xy" | "x" | "y";

function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}

function subpathCentroid(sub: SplineSubpath): [number, number] {
  const a = sub.anchors;
  if (a.length === 0) return [0.5, 0.5];
  let cx = 0;
  let cy = 0;
  for (const an of a) {
    cx += an.pos[0];
    cy += an.pos[1];
  }
  return [cx / a.length, cy / a.length];
}

function pivotOf(
  sub: SplineSubpath,
  mode: Pivot,
  customX: number,
  customY: number
): [number, number] {
  if (mode === "custom") return [customX, customY];
  const a = sub.anchors;
  if (a.length === 0) return [0.5, 0.5];
  if (mode === "first") return [a[0].pos[0], a[0].pos[1]];
  if (mode === "last") {
    const last = a[a.length - 1];
    return [last.pos[0], last.pos[1]];
  }
  return subpathCentroid(sub);
}

function anchorProgress(sub: SplineSubpath): number[] {
  const n = sub.anchors.length;
  if (n === 0) return [];
  if (n === 1) return [0];
  const m = measureSubpath(sub);
  if (m.total <= 1e-12) {
    return sub.anchors.map((_, i) => i / (n - 1));
  }
  const ts: number[] = [0];
  for (let i = 1; i < n; i++) {
    const cum = m.cumulative[i - 1] ?? m.total;
    ts.push(Math.max(0, Math.min(1, cum / m.total)));
  }
  return ts;
}

function taperAnchor(
  an: SplineAnchor,
  px: number,
  py: number,
  sx: number,
  sy: number
): SplineAnchor {
  const dx = an.pos[0] - px;
  const dy = an.pos[1] - py;
  return {
    ...an,
    pos: [px + dx * sx, py + dy * sy],
    inHandle: an.inHandle
      ? [an.inHandle[0] * sx, an.inHandle[1] * sy]
      : undefined,
    outHandle: an.outHandle
      ? [an.outHandle[0] * sx, an.outHandle[1] * sy]
      : undefined,
  };
}

function taperSubpath(
  sub: SplineSubpath,
  pivot: Pivot,
  customX: number,
  customY: number,
  axis: Axis,
  curve: ReturnType<typeof sanitizeFloatCurve>,
  outLo: number,
  outHi: number
): SplineSubpath {
  const [px, py] = pivotOf(sub, pivot, customX, customY);
  const ts = anchorProgress(sub);
  const anchors = sub.anchors.map((an, i) => {
    const u = sampleFloatCurve(curve, ts[i] ?? 0);
    const k = outLo + (outHi - outLo) * u;
    const sx = axis === "y" ? 1 : k;
    const sy = axis === "x" ? 1 : k;
    if (sx === 1 && sy === 1) return an;
    return taperAnchor(an, px, py, sx, sy);
  });
  return { ...sub, anchors };
}

export const taperSplineNode: NodeDefinition = {
  type: "taper-spline",
  name: "Taper Spline",
  category: "spline",
  subcategory: "modifier",
  description:
    "Scale each anchor's offset from a pivot by a curve over path progress — taper, flare, or envelope a path without an expression. Pivot is the subpath centroid (default), the first/last anchor, or a custom canvas point. Axis scales x, y, or both. The curve is sampled at arc-length t ∈ [0,1] along each subpath, then mapped through Out Lo → Out Hi (defaults 1 → 0: full size at the start, a point at the end). Handles scale with the same factor. Per-subpath, unlike Modulate Splines (one scale per whole subpath) or Trim Path (arc-length window).",
  searchAliases: ["envelope", "flare", "taper path", "scale along path"],
  facts: {
    space: { "param:pivotX": "canvas01", "param:pivotY": "canvas01" },
    gotchas: [
      "Curve t is arc-length progress per subpath (measureSubpath cumulative distance), not anchor index, so unevenly-spaced anchors still taper smoothly.",
      "The curve output is remapped through out_lo (t=0) to out_hi (t=1) as a scale multiplier on each anchor's offset from the pivot; defaults 1 → 0 shrink the path to a point at its end.",
      "axis=x or axis=y locks the other axis's scale to 1 instead of skipping it, so an anchor can still move if its handle is asymmetric.",
      "Handles are scaled by the same factor as their anchor, so a heavily tapered cubic can invert if out_lo/out_hi go negative-adjacent (values beyond the 0..4 range aren't clamped in compute).",
    ],
  },
  backend: "webgl2",
  inputs: [{ name: "path", type: "spline", required: true }],
  params: [
    {
      name: "pivot",
      label: "Pivot",
      type: "enum",
      options: ["centroid", "first", "last", "custom"],
      default: "centroid",
    },
    {
      name: "pivotX",
      label: "Pivot X",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
      visibleIf: (p) => p.pivot === "custom",
    },
    {
      name: "pivotY",
      label: "Pivot Y",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
      visibleIf: (p) => p.pivot === "custom",
    },
    {
      name: "axis",
      label: "Axis",
      type: "enum",
      options: ["xy", "x", "y"],
      default: "xy",
    },
    {
      name: "curve",
      label: "Curve",
      type: "float_curve",
      default: defaultFloatCurve(0, 1),
    },
    {
      name: "out_lo",
      label: "Out Lo (t=0)",
      type: "scalar",
      min: 0,
      max: 4,
      softMax: 2,
      step: 0.001,
      default: 1,
    },
    {
      name: "out_hi",
      label: "Out Hi (t=1)",
      type: "scalar",
      min: 0,
      max: 4,
      softMax: 2,
      step: 0.001,
      default: 0,
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [],

  compute({ inputs, params }) {
    const src = inputs.path;
    if (!src || src.kind !== "spline") {
      const empty: SplineValue = { kind: "spline", subpaths: [] };
      return { primary: empty };
    }
    const pivot = (
      ["centroid", "first", "last", "custom"].includes(params.pivot as string)
        ? params.pivot
        : "centroid"
    ) as Pivot;
    const axis = (
      params.axis === "x" || params.axis === "y" ? params.axis : "xy"
    ) as Axis;
    const customX = num(params.pivotX, 0.5);
    const customY = num(params.pivotY, 0.5);
    const curve = sanitizeFloatCurve(params.curve);
    const outLo = num(params.out_lo, 1);
    const outHi = num(params.out_hi, 0);
    const subpaths = src.subpaths.map((sub) =>
      taperSubpath(sub, pivot, customX, customY, axis, curve, outLo, outHi)
    );
    return { primary: { kind: "spline", subpaths } };
  },
};
