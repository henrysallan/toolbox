import type { NodeDefinition } from "@/engine/types";
import { mirrorParams } from "@/engine/skia/library";
import { blurNode } from "../effect/blur";
import { bindDerived, type Bind, type ImageFilterIR, type SkiaNode } from "@/engine/skia/scene-ir";
import { bindScaled } from "./paint-shared";
import { drawInput, num, wrapDrawing } from "./filter-shared";

// Blur (Skia) — the Skia-layer mirror of Blur (effect/blur.ts), Gaussian
// mode: React Native Skia <Blur> on a Group layer.
//
// The GL node's Gaussian (engine/convolve gaussianPlan): sigma = radius / 2,
// a normalized discrete kernel of ceil(3σ) taps per side capped at 64
// (radius ≈ 43), filtered in PREMULTIPLIED alpha and, with `linearize` (the
// default), in linear light. Skia's Blur takes the sigma (canvas px), runs
// premultiplied, and blurs whatever space its layer holds, so:
//   linearize off  group{ layer: [blur σ = r/2] }
//   linearize on   group{ layer: [blur σ = r/2], colorFilters: [linearToSrgb] }
//                    └ group{ layer: colorFilters [srgbToLinear] } ← content
// The inner layer composites the content into the outer one converted to
// linear (a colour filter runs on unpremultiplied colour, as the GL
// boundary pass does), the outer one blurs it and converts back. Skia's
// layers are 8-bit, so linear values quantize where the GL node keeps
// float16: near black a step of the 8-bit linear layer is several sRGB
// levels (measured in the spec, §3.2a).
//
// `radius` binds as the sigma with a 0.5 scale (BindRef.scale), so a
// keyframed radius exports as the radius track × 0.5. Bokeh and convolve
// have no Skia equivalent (a circular aperture is not separable into
// Skia's Gaussian; a kernel image would need a convolution filter React
// Native Skia doesn't expose) and refuse.

// The GL node's tap cap (convolve/index.ts GAUSSIAN_MAX_HALF_TAPS = 64)
// as a radius: past it (3σ > 64 px) the GL kernel is a Gaussian TRUNCATED
// at ±64 px and renormalized — narrower than σ = r/2, tending to a ±64 px
// box (σ 36.95) — while Skia's Gaussian is not truncated.
export const GL_BLUR_MAX_HALF_TAPS = 64;
export const GL_BLUR_TRUNCATION_RADIUS = (GL_BLUR_MAX_HALF_TAPS / 3) * 2;

// The sigma whose Gaussian has the VARIANCE of the GL node's kernel at
// `radius`: r/2 up to the cap, then the truncated kernel's own (measured
// by compare:skia at r = 70: σ 29.5 instead of 35 halves meanAbs).
export function glBlurSigma(radius: number): number {
  const s = Math.max(0, radius) * 0.5;
  if (radius <= GL_BLUR_TRUNCATION_RADIUS || s <= 0) return s;
  let sw = 0;
  let sv = 0;
  for (let i = -GL_BLUR_MAX_HALF_TAPS; i <= GL_BLUR_MAX_HALF_TAPS; i++) {
    const w = Math.exp(-(i * i) / (2 * s * s));
    sw += w;
    sv += w * i * i;
  }
  return Math.sqrt(sv / sw);
}

export const skiaBlurNode: NodeDefinition = {
  type: "skia-blur",
  name: "Blur (Skia)",
  category: "image",
  subcategory: "modifier",
  description:
    "Gaussian blur of the Skia drawing wired into it (React Native Skia <Blur> on a Group layer), with Blur's params: radius in px (sigma = radius / 2) and blur in linear light. Wire a Skia drawing in and the result into Skia Group or Skia Canvas.",
  searchAliases: ["skia", "blur", "gaussian", "soften", "react native"],
  facts: {
    space: { out: "pixels", "param:radius": "pixels" },
    gotchas: [
      "radius is canvas px, sigma = radius/2 as in Blur; on device the exported canvas scales, and the blur scales with it.",
      "Blur's GL kernel stops at 64 taps per side (radius ≈ 43): past that this node uses the sigma with the same spread, but Blur's truncated kernel is boxier.",
      "linearize blurs in linear light through two 8-bit Skia layers (Blur keeps float16): dark gradients band by a few levels.",
      "Content off the canvas blurs into view (Skia sizes the layer to the blur); Blur clamps the edge texel instead, so shapes touching the edge differ there.",
      "Only mode=gaussian ports; bokeh and convolve are refused and the content passes through unblurred.",
    ],
  },
  backend: "webgl2",
  skia: { class: "filter", mirrors: "blur" },
  noMaskInput: true,
  inputs: [{ name: "content", label: "Content", type: "skia_draw", required: true }],
  // Blur's own ParamDefs (mode, radius, linearize): same names, ranges and
  // defaults, so a converted layer copies the values straight across.
  params: mirrorParams(blurNode, ["mode", "radius", "linearize"]),
  primaryOutput: "skia_draw",
  auxOutputs: [],

  compute({ inputs, params, nodeId }) {
    const mode = String(params.mode ?? "gaussian");
    const problems: string[] = [];
    if (mode !== "gaussian") {
      problems.push(
        `Blur (Skia) "${nodeId}": mode "${mode}" has no React Native Skia equivalent — only gaussian ports (Skia's Blur is a Gaussian; ${mode === "bokeh" ? "a bokeh aperture is not one" : "a kernel image needs a convolution filter RN Skia doesn't expose"}). The content passes through unblurred.`
      );
      return { primary: wrapDrawing(inputs.content, nodeId, problems, (c) => c) };
    }
    if (!drawInput(inputs.content)) return { primary: wrapDrawing(inputs.content, nodeId, problems, (c) => c) };
    const radius = Math.max(0, num(params.radius, 0));
    // Up to the GL cap the sigma is radius × 0.5 exactly (a scaled track);
    // past it, the truncated kernel's variance-matched sigma (derived:
    // sampled per frame when the radius animates).
    const sigma: Bind<number> =
      radius <= GL_BLUR_TRUNCATION_RADIUS ? bindScaled(radius * 0.5, nodeId, "radius", 0.5) : bindDerived(glBlurSigma(radius), [{ node: nodeId, param: "radius" }]);
    const blur: ImageFilterIR = { k: "blur", sx: sigma, sy: sigma, tile: "clamp" };
    const linear = params.linearize !== false;
    return {
      primary: wrapDrawing(inputs.content, nodeId, problems, (content): SkiaNode =>
        linear
          ? {
              k: "group",
              id: nodeId,
              layer: { imageFilters: [blur], colorFilters: [{ k: "linearToSrgb" }] },
              children: [{ k: "group", id: nodeId, layer: { colorFilters: [{ k: "srgbToLinear" }] }, children: [content] }],
            }
          : { k: "group", id: nodeId, layer: { imageFilters: [blur] }, children: [content] }
      ),
    };
  },
};
