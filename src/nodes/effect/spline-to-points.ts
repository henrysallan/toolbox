import type { NodeDefinition, SplineValue } from "@/engine/types";
import { EMPTY_POINTS, makePoints } from "@/engine/points";

// Spline to Points — emit the input spline's anchor positions as a points
// value, one point per anchor in subpath order. The structural inverse of
// Points to Spline (which chains points back into subpaths), and the
// anchor-exact sibling of Points on Path (which samples evenly along the
// curve by arc length — use that when spacing should ignore where the
// anchors happen to sit).
//
// groupIndex handling: each subpath tags its anchors' points with the
// subpath's own groupIndex (Collect identity survives), falling back to
// the subpath index when untagged — so Points to Spline rebuilds the
// subpaths and per-index downstream nodes split naturally. Closed
// subpaths emit each anchor once (no duplicated closing point).
//
// Classification: Point → Generator (extracts a point set from a spline,
// same shelf as Spline Intersections / Points on Path). Pure CPU,
// deterministic — the fingerprint cache handles it, no `stable` needed.

export const splineToPointsNode: NodeDefinition = {
  type: "spline-to-points",
  name: "Spline to Points",
  category: "point",
  subcategory: "generator",
  description:
    "Extract the input spline's anchor points as a points value — one point per anchor, in subpath order. Each subpath tags its points with its groupIndex (or its subpath index when untagged), so Points to Spline rebuilds the subpaths and per-index nodes split naturally. The original spline passes through on the aux output. For evenly spaced samples along the curve instead of the raw anchors, use Points on Path.",
  backend: "webgl2",
  inputs: [{ name: "spline", type: "spline", required: true }],
  params: [],
  primaryOutput: "points",
  auxOutputs: [{ name: "spline", type: "spline" }],

  compute({ inputs }) {
    const src = inputs.spline;
    const spline: SplineValue =
      src?.kind === "spline" ? src : { kind: "spline", subpaths: [] };

    let count = 0;
    for (const sub of spline.subpaths) count += sub.anchors.length;
    if (count === 0) {
      return { primary: EMPTY_POINTS, aux: { spline } };
    }

    const out = makePoints(count, { withGroupIndices: true });
    const pos = out.positions;
    const groups = out.groupIndices!;
    let i = 0;
    for (let s = 0; s < spline.subpaths.length; s++) {
      const sub = spline.subpaths[s];
      const tag = sub.groupIndex ?? s;
      for (const a of sub.anchors) {
        pos[i * 2] = a.pos[0];
        pos[i * 2 + 1] = a.pos[1];
        groups[i] = tag;
        i++;
      }
    }
    return { primary: out, aux: { spline } };
  },
};
