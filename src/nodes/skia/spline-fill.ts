import type { NodeDefinition, SkiaDrawValue, SplineValue } from "@/engine/types";
import { bindDerived, bindParam, type PaintIR, type SkiaNode } from "@/engine/skia/scene-ir";
import { splineToSvgPathD } from "@/engine/svg-serialize";
import { hexToRgba01 } from "@/engine/spline-fill";

// Fill (Skia) — the Skia-layer mirror of Fill (spline-fill): a spline's
// interior as React Native Skia <Path>s, with Fill's params. Open subpaths
// close with their closing cubic, as buildPath2D's fill does.
//
//   stack_subpaths on (Fill's default)  one path per subpath, each filled
//     on its own (winding, Canvas2D's default rule) and drawn in order —
//     overlaps stack, so a translucent color doubles up where copies
//     overlap, exactly as Fill draws them;
//   stack_subpaths off                  every subpath in one path, so `rule`
//     (evenodd / nonzero) decides holes.
//
// The per-subpath split is structure: an export needs the subpath count to
// hold still over the scene (Copy to Points counts usually do).

export const skiaSplineFillNode: NodeDefinition = {
  type: "skia-spline-fill",
  name: "Fill (Skia)",
  category: "spline",
  subcategory: "modifier",
  description:
    "Fills a spline's interior as Skia paths (React Native Skia <Path>) with Fill's params: stacked subpaths (each filled on its own, drawn in order) or one path whose fill rule punches holes. Wire it into Skia Group or Skia Canvas.",
  searchAliases: ["skia", "fill", "shape", "interior", "react native"],
  facts: {
    space: { out: "pixels" },
    gotchas: [
      "stack_subpaths=true (default) emits one path per subpath, each filled with the nonzero rule and drawn in order, so translucent overlaps darken like Fill's.",
      "rule (evenodd/nonzero) applies only with stack_subpaths off, where every subpath joins one path.",
      "Open subpaths close with their closing cubic; an export needs the subpath count to stay constant over the scene in stacked mode.",
    ],
  },
  backend: "webgl2",
  skia: { class: "native", mirrors: "spline-fill" },
  noMaskInput: true,
  inputs: [{ name: "path", label: "Path", type: "spline", required: true }],
  params: [
    { name: "color", label: "Color", type: "color", default: "#ffffff", alpha: true },
    { name: "stack_subpaths", label: "Stack subpaths", type: "boolean", default: true },
    {
      name: "rule",
      label: "Fill rule",
      type: "enum",
      options: ["evenodd", "nonzero"],
      default: "evenodd",
      visibleIf: (p) => !p.stack_subpaths,
    },
  ],
  primaryOutput: "skia_draw",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const W = ctx.width;
    const H = ctx.height;
    const v = inputs.path;
    const subpaths = (v?.kind === "spline" ? (v as SplineValue).subpaths : []).filter((s) => s.anchors.length >= 2);
    const closed = subpaths.map((s) => (s.closed ? s : { ...s, closed: true }));
    const paint = (): PaintIR => ({
      style: "fill",
      color: bindParam(hexToRgba01((params.color as string) ?? "#ffffff"), nodeId, "color"),
      antiAlias: true,
    });
    let node: SkiaNode;
    if (params.stack_subpaths !== false) {
      node = {
        k: "group",
        id: nodeId,
        children: closed.map((s) => ({
          k: "shape" as const,
          id: nodeId,
          geom: { k: "path" as const, d: bindDerived(splineToSvgPathD([s], W, H), []), fillType: "winding" as const },
          paint: paint(),
        })),
      };
    } else {
      node = {
        k: "shape",
        id: nodeId,
        geom: {
          k: "path",
          d: bindDerived(splineToSvgPathD(closed, W, H), []),
          fillType: params.rule === "nonzero" ? "winding" : "evenOdd",
        },
        paint: paint(),
      };
    }
    const out: SkiaDrawValue = { kind: "skia_draw", node };
    return { primary: out };
  },
};
