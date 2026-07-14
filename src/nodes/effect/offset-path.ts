import type {
  NodeDefinition,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import { offsetSubpath } from "@/engine/spline-math";
import {
  resolveSubpathOverlaps,
  type OverlapStyle,
} from "@/engine/spline-offset-resolve";

// Parallel-curve offset. Each subpath is shifted perpendicular to its
// tangent by `distance` units (in normalized canvas space — so 0.05 ≈ 5%
// of the canvas dimension). Positive values offset to the right of the
// path's travel direction; negative to the left. Handled per-subpath so
// compound paths (letter holes, etc.) offset independently.
//
// Built on top of bezier-js's `.offset(d)`, which subdivides around high-
// curvature regions and returns a chain of cubics. We stitch those back
// into our SplineSubpath shape.

export const offsetPathNode: NodeDefinition = {
  type: "spline-offset",
  name: "Offset Path",
  category: "spline",
  subcategory: "modifier",
  description:
    "Offset each subpath perpendicular to its tangent. Useful for variable-width strokes and outline variants without rasterizing. When sharp corners make the offset overlap itself, the Overlap mode cuts the crossing loop — Sharp resolves it to a single point, Smooth rounds the cut.",
  backend: "webgl2",
  inputs: [{ name: "path", type: "spline", required: true }],
  params: [
    {
      name: "distance",
      label: "Distance",
      type: "scalar",
      min: -0.5,
      max: 0.5,
      softMax: 0.1,
      step: 0.001,
      default: 0.02,
    },
    {
      name: "overlap",
      label: "Overlap",
      type: "enum",
      options: ["keep", "sharp", "smooth"],
      default: "keep",
      control: "segmented",
    },
    {
      name: "smoothing",
      label: "Smoothing",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
      visibleIf: (p) => p.overlap === "smooth",
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [],

  compute({ inputs, params, ctx }) {
    const src = inputs.path;
    if (!src || src.kind !== "spline") {
      const empty: SplineValue = { kind: "spline", subpaths: [] };
      return { primary: empty };
    }
    const distance = (params.distance as number) ?? 0;
    if (distance === 0) {
      return { primary: src };
    }
    const style = (params.overlap as OverlapStyle) ?? "keep";
    const smoothing = (params.smoothing as number) ?? 0.5;
    // The offset runs in normalized space; the overlap resolve runs in canvas
    // pixels so its intersection tolerances / fillet radius stay isotropic on
    // non-square canvases (the offset's own anisotropy is unchanged).
    const W = Math.max(1, ctx.width);
    const H = Math.max(1, ctx.height);
    const scaleSub = (s: SplineSubpath, kx: number, ky: number): SplineSubpath => ({
      ...s,
      anchors: s.anchors.map((a) => {
        const out = { ...a, pos: [a.pos[0] * kx, a.pos[1] * ky] as [number, number] };
        if (a.inHandle) out.inHandle = [a.inHandle[0] * kx, a.inHandle[1] * ky];
        if (a.outHandle) out.outHandle = [a.outHandle[0] * kx, a.outHandle[1] * ky];
        return out;
      }),
    });
    const offsetSubpaths = src.subpaths
      .map((s): SplineSubpath | null => {
        const off = offsetSubpath(s, distance);
        if (!off) return null;
        if (style === "keep") return off;
        const resolved = resolveSubpathOverlaps(scaleSub(off, W, H), {
          style,
          filletRadius: smoothing * Math.abs(distance) * W,
        });
        if (!resolved) return null;
        return scaleSub(resolved, 1 / W, 1 / H);
      })
      .filter((s): s is SplineSubpath => s != null);
    const out: SplineValue = { kind: "spline", subpaths: offsetSubpaths };
    return { primary: out };
  },
};
