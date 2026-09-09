import type {
  NodeDefinition,
  SplineAnchor,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import {
  SPLINE_FILL_INPUT,
  TRANSFORM_INPUT,
  SPLINE_RASTER_PARAMS,
  SPLINE_TRIM_PARAMS,
  applyTrimParams,
  emitSplinePrimitive,
  disposeSplineRasterAux,
  resolveSplineRasterAux,
} from "./spline-raster-aux";
import { transformSpline } from "@/engine/spline-transform";

// Generate a rectangle (optionally with rounded corners) as a closed
// spline. Round corners use the same kappa approximation as Circle so
// adjacent straight edges blend into each quarter-circle. Squircle
// corners use Figma/Apple "continuous corner" construction (G2 into the
// straight edge — the curve holds the side longer, then turns tighter):
// https://www.figma.com/blog/desperately-seeking-squircles/
//
// Position + size are in normalized [0,1]² Y-DOWN space. (X, Y) is the
// CENTER of the rectangle — same convention as Circle and the SDF
// primitives, so positioning is consistent across the spline / SDF
// node families. When corner_radius is 0, the emitted subpath has 4
// corner anchors; round corners emit 8 (two per corner); squircle
// corners emit 12 (or 16 when radius is large enough that a circular
// remainder arc remains).

const KAPPA = 0.5522847498307933;
const SQUIRCLE_EPS = 1e-8;

type CornerStyle = "round" | "squircle";

// Figma corner-smoothing params for a 90° corner. `smoothing` is 1
// (full squircle) unless the edge budget forces it down — at radius =
// half the short side the remainder arc is a quarter-circle and this
// collapses back to the round path.
interface SquircleCorner {
  a: number;
  b: number;
  c: number;
  d: number;
  p: number;
  arcSectionLength: number;
  radius: number;
  sweep: number; // remaining circular-arc sweep, radians (0 at full squircle)
}

function squircleCorner(radius: number, budget: number): SquircleCorner {
  // p = (1 + ξ) · R  (q = R at 90°). Clamp ξ so p fits on the edge.
  let smoothing = 1;
  const maxSmoothing = budget / radius - 1;
  if (maxSmoothing < smoothing) smoothing = Math.max(0, maxSmoothing);
  const p = Math.min((1 + smoothing) * radius, budget);

  const arcMeasureDeg = 90 * (1 - smoothing);
  const arcSectionLength =
    Math.sin((arcMeasureDeg / 2) * (Math.PI / 180)) * radius * Math.SQRT2;
  const angleAlphaDeg = (90 - arcMeasureDeg) / 2;
  const p3ToP4 = radius * Math.tan((angleAlphaDeg / 2) * (Math.PI / 180));
  const angleBeta = 45 * smoothing * (Math.PI / 180);
  const c = p3ToP4 * Math.cos(angleBeta);
  const d = c * Math.tan(angleBeta);
  const b = (p - arcSectionLength - c - d) / 3;
  return {
    a: 2 * b,
    b,
    c,
    d,
    p,
    arcSectionLength,
    radius,
    sweep: (Math.PI / 2) * (1 - smoothing),
  };
}

function add2(a: [number, number], b: [number, number]): [number, number] {
  return [a[0] + b[0], a[1] + b[1]];
}
function sub2(a: [number, number], b: [number, number]): [number, number] {
  return [a[0] - b[0], a[1] - b[1]];
}
function scale2(a: [number, number], s: number): [number, number] {
  return [a[0] * s, a[1] * s];
}

// Clockwise unit tangent in Y-DOWN: (x, y) → (−y, x).
function cwUnitTangent(radial: [number, number]): [number, number] {
  const t: [number, number] = [-radial[1], radial[0]];
  const len = Math.hypot(t[0], t[1]);
  return len > SQUIRCLE_EPS ? scale2(t, 1 / len) : [0, 0];
}

// One 90° corner. `u` is the incoming travel direction, `v` the outgoing
// (both unit). Clockwise around the rect: TL u=(0,−1) v=(1,0), TR
// u=(1,0) v=(0,1), and so on. Anchors: start on the incoming edge, one
// (or two, if a remainder arc remains) at the corner, end on the
// outgoing edge. Handles on the start/end lie on the edge, collinear
// with the next control point — zero curvature where the curve meets
// the straight, which is the squircle's signature.
function squircleCornerAnchors(
  vertex: [number, number],
  u: [number, number],
  v: [number, number],
  s: SquircleCorner
): SplineAnchor[] {
  const start = sub2(vertex, scale2(u, s.p));
  const end = add2(vertex, scale2(v, s.p));
  const mid1 = add2(start, add2(scale2(u, s.a + s.b + s.c), scale2(v, s.d)));
  const c2 = add2(start, scale2(u, s.a + s.b));
  const startAnchor: SplineAnchor = {
    pos: start,
    inHandle: [0, 0],
    outHandle: scale2(u, s.a),
  };

  if (s.arcSectionLength < SQUIRCLE_EPS || s.sweep < SQUIRCLE_EPS) {
    const midOut = add2(scale2(u, s.d), scale2(v, s.c));
    const endC2 = add2(mid1, add2(scale2(u, s.d), scale2(v, s.b + s.c)));
    return [
      startAnchor,
      { pos: mid1, inHandle: sub2(c2, mid1), outHandle: midOut },
      { pos: end, inHandle: sub2(endC2, end), outHandle: [0, 0] },
    ];
  }

  const mid2 = add2(
    mid1,
    add2(scale2(u, s.arcSectionLength), scale2(v, s.arcSectionLength))
  );
  const center = add2(vertex, add2(scale2(u, -s.radius), scale2(v, s.radius)));
  const h = s.radius * (4 / 3) * Math.tan(s.sweep / 4);
  const t1 = cwUnitTangent(sub2(mid1, center));
  const t2 = cwUnitTangent(sub2(mid2, center));
  const mid2Out = add2(scale2(u, s.d), scale2(v, s.c));
  const endC2 = add2(mid2, add2(scale2(u, s.d), scale2(v, s.b + s.c)));
  return [
    startAnchor,
    {
      pos: mid1,
      inHandle: sub2(c2, mid1),
      outHandle: scale2(t1, h),
    },
    {
      pos: mid2,
      inHandle: scale2(t2, -h),
      outHandle: mid2Out,
    },
    { pos: end, inHandle: sub2(endC2, end), outHandle: [0, 0] },
  ];
}

function makeRoundRectSubpath(
  x: number,
  y: number,
  w: number,
  h: number,
  rr: number
): SplineSubpath {
  const k = rr * KAPPA;
  // Eight anchors: at each corner, one where the straight edge meets the
  // start of the arc, and another where the arc ends and the next edge
  // begins. Handles point along the arc tangents.
  const anchors: SplineAnchor[] = [
    // Top edge, top-left corner end
    { pos: [x + rr, y], inHandle: [-k, 0], outHandle: [0, 0] },
    // Top edge, top-right corner start
    { pos: [x + w - rr, y], inHandle: [0, 0], outHandle: [k, 0] },
    // Right edge, top-right corner end
    { pos: [x + w, y + rr], inHandle: [0, -k], outHandle: [0, 0] },
    // Right edge, bottom-right corner start
    { pos: [x + w, y + h - rr], inHandle: [0, 0], outHandle: [0, k] },
    // Bottom edge, bottom-right corner end
    { pos: [x + w - rr, y + h], inHandle: [k, 0], outHandle: [0, 0] },
    // Bottom edge, bottom-left corner start
    { pos: [x + rr, y + h], inHandle: [0, 0], outHandle: [-k, 0] },
    // Left edge, bottom-left corner end
    { pos: [x, y + h - rr], inHandle: [0, k], outHandle: [0, 0] },
    // Left edge, top-left corner start
    { pos: [x, y + rr], inHandle: [0, 0], outHandle: [0, -k] },
  ];
  return { anchors, closed: true };
}

function makeRectSubpath(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  style: CornerStyle
): SplineSubpath {
  // Clamp radius to half the shorter side (same rule SVG uses).
  const rr = Math.min(Math.abs(r), Math.abs(w) / 2, Math.abs(h) / 2);
  if (rr <= 0 || w <= 0 || h <= 0) {
    // Plain rectangle — four corner anchors, clockwise from top-left.
    const anchors: SplineAnchor[] = [
      { pos: [x, y] },
      { pos: [x + w, y] },
      { pos: [x + w, y + h] },
      { pos: [x, y + h] },
    ];
    return { anchors, closed: true };
  }
  if (style !== "squircle") return makeRoundRectSubpath(x, y, w, h, rr);

  // Each corner may consume at most half of each adjacent edge.
  const budget = Math.min(w / 2, h / 2);
  const s = squircleCorner(rr, budget);
  // Full clamp (ξ → 0) is a quarter-circle — keep the compact 8-anchor path.
  if (s.a < SQUIRCLE_EPS) return makeRoundRectSubpath(x, y, w, h, rr);

  const tl: [number, number] = [x, y];
  const tr: [number, number] = [x + w, y];
  const br: [number, number] = [x + w, y + h];
  const bl: [number, number] = [x, y + h];
  return {
    anchors: [
      ...squircleCornerAnchors(tl, [0, -1], [1, 0], s),
      ...squircleCornerAnchors(tr, [1, 0], [0, 1], s),
      ...squircleCornerAnchors(br, [0, 1], [-1, 0], s),
      ...squircleCornerAnchors(bl, [-1, 0], [0, -1], s),
    ],
    closed: true,
  };
}

export const rectangleNode: NodeDefinition = {
  type: "rectangle",
  name: "Rectangle",
  category: "spline",
  subcategory: "generator",
  description:
    "Generate a rectangle as a closed spline, optionally with round or squircle corners. Authored in [0,1]² Y-down; the rasterizer scales y about 0.5 by W/H so sizes stay width-relative.",
  facts: {
    space: {
      "param:originX": "canvas01",
      "param:originY": "canvas01",
      "param:width": "canvas01",
      "param:height": "canvas01",
      "param:corner_radius": "canvas01",
      "param:stroke_thickness": "pixels",
    },
    gotchas: [
      "originX/originY is the rectangle's CENTER, not its top-left corner, despite the param name kept for save-load back-compat; pre-conversion projects can look shifted on load.",
      "corner_radius is clamped to half the shorter side (SVG's rule); corner_style (round/squircle) only shows and matters once corner_radius > 0.",
      "rotate spins about the rectangle's own center (originX/originY) in degrees, +CW, independent of any wired transform input's own rotation.",
      "Anchor count varies with shape: 4 sharp corners at radius 0, 8 for round corners, 12 (or 16 with a residual circular arc) for squircle corners.",
      "stroke_thickness is absolute pixels by default; set stroke_units=% to make it a percentage of canvas width instead.",
    ],
  },
  backend: "webgl2",
  inputs: [SPLINE_FILL_INPUT, TRANSFORM_INPUT],
  params: [
    {
      // Param key kept as "originX" / "originY" for save-load
      // back-compat. Old projects that wrote these as top-left
      // corner positions will appear shifted on first load — easy
      // visual fix, no data loss. Going forward the param means
      // the rectangle's center.
      name: "originX",
      label: "X",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "originY",
      label: "Y",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "width",
      label: "Width",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.75,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "height",
      label: "Height",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.75,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "corner_radius",
      label: "Corner radius",
      type: "scalar",
      min: 0,
      max: 0.5,
      softMax: 0.2,
      step: 0.001,
      default: 0,
    },
    {
      name: "corner_style",
      label: "Corner style",
      type: "enum",
      options: ["round", "squircle"],
      optionLabels: { round: "Round", squircle: "Squircle" },
      control: "segmented",
      default: "round",
      visibleIf: (p) => ((p.corner_radius as number) ?? 0) > 0,
    },
    {
      // Rotation about the rectangle's own center (originX/originY). Degrees,
      // same +CW convention as the Transform node and gizmo. The PrimitiveGizmo
      // box stays axis-aligned (no rotation handle yet) — this is a param-only
      // control.
      name: "rotate",
      label: "Rotate (°)",
      type: "scalar",
      min: -360,
      max: 360,
      step: 0.5,
      default: 0,
    },
    // Bundled rasterizer — gives the primitive an `image` output so it's
    // immediately viewable.
    ...SPLINE_TRIM_PARAMS,
    ...SPLINE_RASTER_PARAMS,
  ],
  primaryOutput: "spline",
  auxOutputs: [
    { name: "image", type: "image" },
    { name: "element", type: "element" },
  ],
  resolveAuxOutputs: resolveSplineRasterAux,
  linkedPairs: [{ a: "width", b: "height" }],

  compute({ inputs, params, ctx, nodeId }) {
    // (cx, cy) is the center; subtract w/2 + h/2 to get the top-left
    // corner that makeRectSubpath wants.
    const cx = (params.originX as number) ?? 0.5;
    const cy = (params.originY as number) ?? 0.5;
    const w = Math.max(0, (params.width as number) ?? 0.5);
    const h = Math.max(0, (params.height as number) ?? 0.5);
    const r = Math.max(0, (params.corner_radius as number) ?? 0);
    const style: CornerStyle =
      (params.corner_style as string) === "squircle" ? "squircle" : "round";
    const subpath = makeRectSubpath(cx - w / 2, cy - h / 2, w, h, r, style);
    let out: SplineValue = {
      kind: "spline",
      subpaths: applyTrimParams([subpath], params),
    };
    // Rotate about the rectangle's own center so the shape spins in place.
    const rotateDeg = (params.rotate as number) ?? 0;
    if (rotateDeg !== 0) {
      out = transformSpline(out, {
        translateX: 0,
        translateY: 0,
        scaleX: 1,
        scaleY: 1,
        rotateDeg,
        pivotX: cx,
        pivotY: cy,
      });
    }
    return emitSplinePrimitive(ctx, nodeId, out, params, inputs);
  },

  dispose: disposeSplineRasterAux,
};
