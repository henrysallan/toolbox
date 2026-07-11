import type {
  NodeDefinition,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import { autoSmoothHandles } from "@/engine/spline-math";

// Set Spline Type — rewrite every anchor's handles, leaving positions,
// closed flags, and groupIndex tags untouched. `linear` strips handles
// (polyline through the anchors); `smooth` fits catmull-rom auto handles
// through them (deliberately destructive to hand-authored handles — that's
// the node's job), with `tension` scaling the handle length (0 ≈ linear,
// 1 = catmull-rom, > 1 overshoots).
//
// Headline combos: Points to Spline (linear) → here (smooth); smoothing
// Connect Points' straight segments; flattening an SVG import to corners.
//
// Spec: specdocs/071026_spline-points-nodes.md.

export const setSplineTypeNode: NodeDefinition = {
  type: "set-spline-type",
  name: "Set Spline Type",
  category: "spline",
  subcategory: "modifier",
  description:
    "Convert a spline's anchors between linear (handles stripped — a polyline) and smooth (catmull-rom auto handles through every anchor, scaled by tension). Positions, closed state, and groups are unchanged.",
  backend: "webgl2",
  inputs: [{ name: "path", type: "spline", required: true }],
  params: [
    {
      name: "spline_type",
      label: "Type",
      type: "enum",
      options: ["linear", "smooth"],
      default: "smooth",
    },
    {
      name: "tension",
      label: "Tension",
      type: "scalar",
      min: 0,
      max: 2,
      step: 0.01,
      default: 1,
      visibleIf: (p) => (p.spline_type ?? "smooth") === "smooth",
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
    const smooth = ((params.spline_type as string) ?? "smooth") === "smooth";
    const tension = Math.max(0, (params.tension as number) ?? 1);

    const subpaths: SplineSubpath[] = src.subpaths.map((sub) => {
      const anchors = smooth
        ? autoSmoothHandles(sub.anchors, !!sub.closed, tension)
        : sub.anchors.map((a) => ({ pos: [a.pos[0], a.pos[1]] as [number, number] }));
      const out: SplineSubpath = { anchors, closed: sub.closed };
      if (sub.groupIndex !== undefined) out.groupIndex = sub.groupIndex;
      return out;
    });

    const out: SplineValue = { kind: "spline", subpaths };
    return { primary: out };
  },
};
