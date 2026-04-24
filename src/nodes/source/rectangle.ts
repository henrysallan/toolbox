import type {
  NodeDefinition,
  SplineAnchor,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";

// Generate a rectangle (optionally with rounded corners) as a closed
// spline. Corner radius uses the same kappa approximation as Circle so
// adjacent straight edges blend smoothly into each quarter-circle.
//
// Origin + size are in normalized [0,1]² Y-DOWN space. When corner_radius
// is 0, the emitted subpath has 4 corner anchors; otherwise it has 8 (two
// per corner) so each quarter-arc keeps its own in/out handles.

const KAPPA = 0.5522847498307933;

function makeRectSubpath(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
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

export const rectangleNode: NodeDefinition = {
  type: "rectangle",
  name: "Rectangle",
  category: "spline",
  subcategory: "generator",
  description:
    "Generate a rectangle as a closed spline, optionally with rounded corners.",
  backend: "webgl2",
  inputs: [],
  params: [
    {
      name: "originX",
      label: "Origin X",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.25,
    },
    {
      name: "originY",
      label: "Origin Y",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.25,
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
  ],
  primaryOutput: "spline",
  auxOutputs: [],

  compute({ params }) {
    const x = (params.originX as number) ?? 0.25;
    const y = (params.originY as number) ?? 0.25;
    const w = Math.max(0, (params.width as number) ?? 0.5);
    const h = Math.max(0, (params.height as number) ?? 0.5);
    const r = Math.max(0, (params.corner_radius as number) ?? 0);
    const subpath = makeRectSubpath(x, y, w, h, r);
    const out: SplineValue = { kind: "spline", subpaths: [subpath] };
    return { primary: out };
  },
};
