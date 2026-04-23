import type {
  NodeDefinition,
  SplineAnchor,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";

// Generate a circle (or ellipse) as a 4-cubic approximation. Standard kappa
// constant — error vs. a true circle is < 0.03% of radius, visually
// indistinguishable.
//
// Output is ONE closed subpath. Pivot + radius are in normalized [0,1]²
// Y-DOWN canvas space, matching every other spline source.

const KAPPA = 0.5522847498307933; // (4/3) * (√2 - 1)

function makeCircleSubpath(
  cx: number,
  cy: number,
  rx: number,
  ry: number
): SplineSubpath {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  // Order: top, right, bottom, left — traversed clockwise in Y-DOWN space.
  const top: SplineAnchor = {
    pos: [cx, cy - ry],
    inHandle: [-kx, 0],
    outHandle: [kx, 0],
  };
  const right: SplineAnchor = {
    pos: [cx + rx, cy],
    inHandle: [0, -ky],
    outHandle: [0, ky],
  };
  const bottom: SplineAnchor = {
    pos: [cx, cy + ry],
    inHandle: [kx, 0],
    outHandle: [-kx, 0],
  };
  const left: SplineAnchor = {
    pos: [cx - rx, cy],
    inHandle: [0, ky],
    outHandle: [0, -ky],
  };
  return { anchors: [top, right, bottom, left], closed: true };
}

export const circleNode: NodeDefinition = {
  type: "circle",
  name: "Circle",
  category: "source",
  description:
    "Generate a circle (or ellipse, via non-uniform radii) as a closed spline.",
  backend: "webgl2",
  inputs: [],
  params: [
    {
      name: "centerX",
      label: "Center X",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "centerY",
      label: "Center Y",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "radiusX",
      label: "Radius X",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.5,
      step: 0.001,
      default: 0.25,
    },
    {
      name: "radiusY",
      label: "Radius Y",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.5,
      step: 0.001,
      default: 0.25,
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [],

  compute({ params }) {
    const cx = (params.centerX as number) ?? 0.5;
    const cy = (params.centerY as number) ?? 0.5;
    const rx = Math.max(0, (params.radiusX as number) ?? 0.25);
    const ry = Math.max(0, (params.radiusY as number) ?? 0.25);
    const subpath = makeCircleSubpath(cx, cy, rx, ry);
    const out: SplineValue = { kind: "spline", subpaths: [subpath] };
    return { primary: out };
  },
};
