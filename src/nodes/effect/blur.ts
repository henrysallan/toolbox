import { OPACITY_PARAM } from "@/engine/conventions";
import {
  bokehPlan,
  copyImage,
  gaussianPlan,
  runSeparable,
  type BokehShape,
} from "@/engine/convolve";
import type { NodeDefinition } from "@/engine/types";

// The unified Blur node. Spec: specdocs/080226_blur-convolution.md.
//
// One node, several decompositions, one execution shape — every mode
// builds a SeparablePlan and hands it to the shared core, which owns the
// premultiplied + linear-light boundary. See src/engine/convolve/.
//
// Modes present in M1:
//   gaussian — the legacy separable Gaussian, tap-for-tap compatible
//   bokeh    — complex separable circular kernels (disc / ring / soft)
// M2 adds `convolve` (arbitrary kernel image via low-rank SVD), which is
// why the mode lives in an enum rather than a boolean.

export const blurNode: NodeDefinition = {
  type: "blur",
  name: "Blur",
  category: "image",
  subcategory: "modifier",
  description:
    "Blur with selectable kernel. Gaussian for a plain soft blur, or " +
    "Bokeh for true circular apertures (disc, ring, soft) with the " +
    "flat-topped shape and hot rim a Gaussian cannot produce. Filters " +
    "in premultiplied linear light.",
  backend: "webgl2",
  inputs: [{ name: "image", type: "image", required: true }],
  headerControl: { paramName: "mode" },
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["gaussian", "bokeh"],
      default: "gaussian",
    },
    {
      name: "radius",
      label: "Radius (px)",
      type: "scalar",
      min: 0,
      // The legacy node hard-capped at 20, which is nowhere near enough
      // for a visible bokeh disc. softMax keeps the slider usable while
      // leaving the number field as the escape hatch.
      softMax: 200,
      step: 0.5,
      default: 0,
    },
    {
      name: "shape",
      label: "Shape",
      type: "enum",
      options: ["disc", "ring", "soft"],
      default: "disc",
      visibleIf: (p) => p.mode === "bokeh",
    },
    {
      name: "components",
      label: "Components",
      type: "scalar",
      min: 1,
      max: 4,
      step: 1,
      // Measured, not guessed. At 1 component the fit is poor enough that
      // the separable square support shows through — highlights render as
      // rounded SQUARES, not discs. 2 gives circles with soft edges. 3 is
      // where the disc goes properly flat (energy outside the nominal
      // radius drops ~8x from 2 to 3), and 4 buys a slightly crisper edge
      // for another 3 passes. Each component costs 2 horizontal + 1
      // vertical pass.
      default: 3,
      visibleIf: (p) => p.mode === "bokeh",
    },
    {
      name: "ring",
      label: "Ring",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
      visibleIf: (p) => p.mode === "bokeh" && p.shape === "ring",
    },
    {
      name: "linearize",
      label: "Blur in linear light",
      type: "boolean",
      // Correct for the common case (sRGB-ish graph). Deliberately a
      // toggle, not an assumption: a graph already in scene-linear off
      // the EXR/ACES path would be double-transformed. Legacy
      // gaussian-blur nodes are migrated to false on load so existing
      // projects stay colour-stable — see migrateLoadedParams.
      default: true,
    },
    OPACITY_PARAM,
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx }) {
    const src = inputs["image"];
    if (!src || src.kind !== "image") {
      const out = ctx.allocImage();
      ctx.clearTarget(out, [0, 0, 0, 1]);
      return { primary: out };
    }

    const radius = Math.max(0, (params.radius as number) ?? 0);
    if (radius <= 1e-4) {
      // No blur: pass through untouched. Going through the boundary here
      // would be a wasteful round trip AND would quantize the image for
      // nothing.
      return { primary: copyImage(ctx, src) };
    }

    const linearize = params.linearize !== false;
    const mode = (params.mode as string) ?? "gaussian";

    const plan =
      mode === "bokeh"
        ? bokehPlan(
            radius,
            ((params.shape as BokehShape) ?? "disc"),
            (params.components as number) ?? 2,
            (params.ring as number) ?? 0.5,
            linearize
          )
        : gaussianPlan(radius, linearize);

    return { primary: runSeparable(ctx, src, plan) };
  },
};

// Back-compat: the legacy Gaussian Blur node is the same def under its
// original type string, hidden from the menus so it does not show twice.
// `mode` defaults to "gaussian" and the sigma = radius/2 mapping is
// preserved exactly, so old saves keep their look. Their `linearize` is
// forced off by migrateLoadedParams (project.ts) — colour is an aesthetic
// change and should not rewrite existing work, unlike the premultiply
// fix, which is a straight correctness bug and is NOT migrated.
export const gaussianBlurLegacyNode: NodeDefinition = {
  ...blurNode,
  type: "gaussian-blur",
  name: "Gaussian Blur",
  hidden: true,
};
