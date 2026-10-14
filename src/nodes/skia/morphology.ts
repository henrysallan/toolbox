import type { NodeDefinition } from "@/engine/types";
import { bindParam } from "@/engine/skia/scene-ir";
import { filterGroup, num } from "./filter-shared";

// Morphology (Skia) — React Native Skia <Morphology> on a Group layer:
// dilate (grow) or erode (shrink) the drawing by `radius` px. Skia's
// filter is a SQUARE window of (2r + 1) px per side, the per-channel max
// (dilate) or min (erode) of the premultiplied pixels, with the radius
// rounded to the nearest whole pixel (measured in CanvasKit: 1.4 → 1,
// 1.5 → 2). No toolbox node mirrors it; check-skia-filters holds it to a
// CPU reference of that definition. Under a scaled canvas the radius
// scales with it (the exported root group), then rounds.

export const skiaMorphologyNode: NodeDefinition = {
  type: "skia-morphology",
  name: "Morphology (Skia)",
  category: "image",
  subcategory: "modifier",
  description:
    "Dilate (grow) or erode (shrink) the Skia drawing wired into it by a radius in px — React Native Skia <Morphology> on a Group layer: a square (2r + 1)-px window, each channel's max (dilate) or min (erode), radius rounded to whole pixels.",
  searchAliases: ["skia", "dilate", "erode", "grow", "shrink", "choke", "expand", "morphology", "react native"],
  facts: {
    space: { out: "pixels", "param:radius": "pixels" },
    gotchas: [
      "The window is a square, not a disc: dilating a dot gives a square, and diagonals grow by √2 × radius.",
      "radius rounds to whole pixels (1.4 → 1, 1.5 → 2), after the canvas scale on device.",
      "Channels dilate independently (premultiplied): colours of neighbouring shapes mix at the seam.",
    ],
  },
  backend: "webgl2",
  skia: { class: "filter" },
  noMaskInput: true,
  inputs: [{ name: "content", label: "Content", type: "skia_draw", required: true }],
  params: [
    { name: "op", label: "Operation", type: "enum", options: ["dilate", "erode"], default: "dilate" },
    { name: "radius", label: "Radius (px)", type: "scalar", min: 0, max: 128, softMax: 24, step: 1, default: 2 },
  ],
  primaryOutput: "skia_draw",
  auxOutputs: [],

  compute({ inputs, params, nodeId }) {
    return {
      primary: filterGroup(inputs.content, nodeId, {
        imageFilters: [
          {
            k: "morphology",
            op: params.op === "erode" ? "erode" : "dilate",
            r: bindParam(Math.max(0, num(params.radius, 2)), nodeId, "radius"),
          },
        ],
      }),
    };
  },
};
