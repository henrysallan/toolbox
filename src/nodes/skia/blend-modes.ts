import type { ParamDef } from "@/engine/types";
import type { BlendMode } from "@/engine/skia/scene-ir";

// React Native Skia's blendMode strings (scene-ir.ts BlendMode), in the
// order Skia declares them: Porter-Duff first, then the separable and
// non-separable color blends. The param stores the RN string verbatim so
// the exporter writes it straight into JSX.
export const SKIA_BLEND_MODES: BlendMode[] = [
  "srcOver", "src", "dst", "dstOver", "srcIn", "dstIn", "srcOut", "dstOut",
  "srcATop", "dstATop", "xor", "plus", "modulate", "clear",
  "screen", "overlay", "darken", "lighten", "colorDodge", "colorBurn",
  "hardLight", "softLight", "difference", "exclusion", "multiply",
  "hue", "saturation", "color", "luminosity",
];

export const SKIA_BLEND_PARAM: ParamDef = {
  name: "blendMode",
  label: "Blend",
  type: "enum",
  options: SKIA_BLEND_MODES,
  default: "srcOver",
};

export function skiaBlendMode(v: unknown): BlendMode {
  return SKIA_BLEND_MODES.includes(v as BlendMode) ? (v as BlendMode) : "srcOver";
}
