import type { NodeDefinition } from "@/engine/types";
import type { Bind, RGBA } from "@/engine/skia/scene-ir";
import { bindParam } from "@/engine/skia/scene-ir";
import { hexToRgba01 } from "@/engine/spline-fill";
import { bindScaled } from "./paint-shared";
import { filterGroup, num } from "./filter-shared";

// Drop Shadow (Skia) — React Native Skia <Shadow> on a Group layer: a
// blurred, offset, tinted copy of the content's alpha behind it (drop) or
// inside its edge (inner). No toolbox node mirrors it; the gate holds it to
// a CPU reference of Skia's own definition (check-skia-filters):
//   drop   shadow = color × blur_σ(offset(alpha)) under the content
//   inner  RN's MakeInnerShadow: the shadow cast by the shape's
//          complement, offset, blurred and clipped back into the shape
// `blur` is a CSS-style blur radius in px (sigma = blur / 2, Blur's own
// radius → sigma rule), so a keyframed blur exports as its track × 0.5.

export const skiaDropShadowNode: NodeDefinition = {
  type: "skia-drop-shadow",
  name: "Drop Shadow (Skia)",
  category: "image",
  subcategory: "modifier",
  description:
    "A drop shadow (or inner shadow) under the Skia drawing wired into it — React Native Skia <Shadow> on a Group layer: the content's alpha offset by dx/dy px, blurred (radius px, sigma = radius/2) and tinted. shadow_only keeps the shadow and drops the content.",
  searchAliases: ["skia", "shadow", "drop shadow", "inner shadow", "glow", "react native"],
  facts: {
    space: { out: "pixels", "param:dx": "pixels", "param:dy": "pixels", "param:blur": "pixels" },
    gotchas: [
      "dx / dy / blur are canvas px (y down); blur is a radius like CSS box-shadow: sigma = blur/2.",
      "The shadow is cast by the content's alpha only; its colour is `color` (alpha included) whatever the content's colours.",
      "inner draws the shadow inside the shape's edge (React Native Skia's inner shadow); shadow_only keeps just the shadow.",
    ],
  },
  backend: "webgl2",
  skia: { class: "filter" },
  noMaskInput: true,
  inputs: [{ name: "content", label: "Content", type: "skia_draw", required: true }],
  params: [
    { name: "dx", label: "Offset X (px)", type: "scalar", min: -512, max: 512, softMax: 64, step: 0.5, default: 6 },
    { name: "dy", label: "Offset Y (px)", type: "scalar", min: -512, max: 512, softMax: 64, step: 0.5, default: 6 },
    { name: "blur", label: "Blur (px)", type: "scalar", min: 0, max: 256, softMax: 64, step: 0.5, default: 12 },
    { name: "color", label: "Color", type: "color", alpha: true, default: "#000000b3" },
    { name: "mode", label: "Mode", type: "enum", options: ["drop", "inner"], default: "drop" },
    { name: "shadow_only", label: "Shadow only", type: "boolean", default: false },
  ],
  primaryOutput: "skia_draw",
  auxOutputs: [],

  compute({ inputs, params, nodeId }) {
    const color: Bind<RGBA> = bindParam(hexToRgba01((params.color as string) ?? "#000000b3"), nodeId, "color");
    const inner = params.mode === "inner";
    const shadowOnly = params.shadow_only === true;
    return {
      primary: filterGroup(inputs.content, nodeId, {
        imageFilters: [
          {
            k: "shadow",
            dx: bindParam(num(params.dx, 6), nodeId, "dx"),
            dy: bindParam(num(params.dy, 6), nodeId, "dy"),
            blur: bindScaled(Math.max(0, num(params.blur, 12)) * 0.5, nodeId, "blur", 0.5),
            color,
            ...(inner ? { inner: true } : {}),
            ...(shadowOnly ? { shadowOnly: true } : {}),
          },
        ],
      }),
    };
  },
};
