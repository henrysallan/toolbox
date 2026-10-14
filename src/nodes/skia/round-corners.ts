import type { NodeDefinition } from "@/engine/types";
import { bindDerived, type PathEffectIR } from "@/engine/skia/scene-ir";
import { roundCorners } from "@/engine/spline-math";
import { bindScaled, copyShape, geomSubpaths, modifyDrawing, num, subpathsToD, subpathsToLineD } from "./paint-shared";

// Round Corners (Skia) — the Skia-layer mirror of Round Corners over a
// drawing. Two lowerings, picked by `method`:
//
//   fillet  toolbox's own fillet (engine/spline-math.ts roundCorners) run
//           on each shape's path: the same inset (min(radius, half of each
//           edge)) and the same circular-arc cubic, so it matches Round
//           Corners → Stroke / Fill to the path data's 0.001 px. The rounded
//           path is new geometry: static when nothing animates, a per-frame
//           path series (interpolated) when the radius or the shape does.
//   corner  React Native Skia's CornerPathEffect with r = radius × width:
//           a native, animatable effect with the SAME inset points, but the
//           corner is a quadratic (control point on the corner), not a
//           circular arc — ~0.06 r flatter at a right angle. Skia rounds
//           line-to-line corners only, so the path is rewritten with its
//           straight segments as lines. It composes with other path effects
//           only natively (CanvasKit, and so the preview and RN web, can't
//           compose a corner ahead of a dash).
//
// radius is Round Corners' canvas01 distance (× canvas width in px).
// Circles, ovals and already-rounded rects have no corners and pass through.

export const skiaRoundCornersNode: NodeDefinition = {
  type: "skia-round-corners",
  name: "Round Corners (Skia)",
  category: "spline",
  subcategory: "modifier",
  description:
    "Rounds the sharp corners of every shape in a Skia drawing, with Round Corners' radius. Fillet reproduces Round Corners exactly (new path geometry); Corner uses React Native Skia's CornerPathEffect (native and animatable, but a quadratic corner rather than a circular arc).",
  searchAliases: ["skia", "round corners", "fillet", "corner", "react native"],
  facts: {
    space: { "param:radius": "canvas01" },
    gotchas: [
      "radius is a canvas01 distance (× canvas width in px), capped per corner at half of each adjacent edge, exactly like Round Corners.",
      "method=fillet rewrites the path (an animated radius exports as a per-frame path series); method=corner is Skia's CornerPathEffect: same inset, quadratic corners, animates natively.",
      "method=corner rounds only straight-to-straight corners and cannot be previewed ahead of a dash (CanvasKit has no path-effect compose; React Native Skia web neither).",
      "Only handle-less corners round; curved anchors and open-path endpoints pass through, as in Round Corners.",
    ],
  },
  backend: "webgl2",
  skia: { class: "native", mirrors: "round-corners" },
  noMaskInput: true,
  inputs: [{ name: "drawing", label: "Drawing", type: "skia_draw", required: true }],
  params: [
    { name: "radius", label: "Radius", type: "scalar", min: 0, max: 0.5, softMax: 0.15, step: 0.001, default: 0.04 },
    {
      name: "method",
      label: "Method",
      type: "enum",
      options: ["fillet", "corner"],
      optionLabels: { fillet: "Fillet (exact)", corner: "Corner effect (native)" },
      default: "fillet",
      control: "segmented",
    },
  ],
  primaryOutput: "skia_draw",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const W = ctx.width;
    const radius = Math.max(0, num(params.radius, 0.04));
    const corner = params.method === "corner";
    const problems: string[] = [];
    const out = modifyDrawing(
      inputs.drawing,
      nodeId,
      (s) => {
        const g = geomSubpaths(s.geom);
        if (!g) return s;
        if ("problem" in g) {
          problems.push(`Round Corners (Skia) "${nodeId}": ${g.problem}; left unrounded.`);
          return s;
        }
        // The rewritten geometry is this node's: re-id the shape so the
        // exporter follows this node's radius AND its upstream drawing.
        const c = copyShape(s, nodeId);
        const fillType = g.fillType ? { fillType: g.fillType } : {};
        if (!corner) {
          c.geom = { k: "path", d: bindDerived(subpathsToD(roundCorners(g.subpaths, radius * W)), []), ...fillType };
          return c;
        }
        c.geom = { k: "path", d: bindDerived(subpathsToLineD(g.subpaths), []), ...fillType };
        const fx = c.paint.pathEffects ?? [];
        // Geometry first: after any trims, ahead of the shape's other effects.
        const lead = fx.findIndex((e) => e.k !== "trim");
        const at = lead < 0 ? fx.length : lead;
        const eff: PathEffectIR = { k: "corner", r: bindScaled(radius * W, nodeId, "radius", W) };
        c.paint.pathEffects = [...fx.slice(0, at), eff, ...fx.slice(at)];
        return c;
      },
      problems
    );
    return { primary: out };
  },
};
