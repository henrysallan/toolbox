import { OPACITY_PARAM } from "@/engine/conventions";
import {
  aperturePlan,
  bokehPlan,
  convolvePlan,
  copyImage,
  gaussianPlan,
  runSeparable,
  type ApertureShape,
  type BokehShape,
} from "@/engine/convolve";
import type { NodeDefinition } from "@/engine/types";

// Which bokeh shapes the complex-phasor path can express (it spans
// circularly-symmetric kernels only) and which have to be rasterized and
// decomposed instead. Users never see the split — it is one `shape` enum.
const CIRCULAR_SHAPES = ["disc", "ring", "soft"] as const;
const isCircular = (s: string): s is BokehShape =>
  (CIRCULAR_SHAPES as readonly string[]).includes(s);

// The unified Blur node. Spec: specdocs/archive/080226_blur-convolution.md.
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
  // The kernel socket only exists in Convolve mode, so the node does not
  // carry a dead input in the other two.
  resolveInputs: (p) =>
    p.mode === "convolve"
      ? [
          { name: "image", type: "image", required: true },
          { name: "kernel", type: "image", required: false },
        ]
      : [{ name: "image", type: "image", required: true }],
  headerControl: { paramName: "mode" },
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["gaussian", "bokeh", "convolve"],
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
      // One enum spanning both decomposition families — disc/ring/soft go
      // through complex phasors, the rest get rasterized and SVD'd. The
      // routing is an implementation detail, not a user-facing choice.
      options: ["disc", "ring", "soft", "hexagon", "octagon", "cats_eye", "star"],
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
      visibleIf: (p) => p.mode === "bokeh" && isCircular(String(p.shape)),
    },
    {
      name: "rank",
      label: "Rank",
      type: "scalar",
      min: 1,
      max: 8,
      step: 1,
      // The SVD quality knob — how many rank-1 terms approximate the
      // kernel. Same role `components` plays for the circular family, but
      // a distinct param because the ceilings differ and conflating them
      // would mean one slider with two meanings.
      default: 4,
      visibleIf: (p) =>
        p.mode === "convolve" ||
        (p.mode === "bokeh" && !isCircular(String(p.shape))),
    },
    {
      name: "rotation",
      label: "Rotation",
      type: "scalar",
      min: -180,
      max: 180,
      step: 1,
      default: 0,
      visibleIf: (p) => p.mode === "bokeh" && !isCircular(String(p.shape)),
    },
    {
      name: "normalize",
      label: "Normalize kernel",
      type: "boolean",
      // Off lets the kernel's total act as a gain — useful deliberately,
      // catastrophic accidentally, hence default on.
      default: true,
      visibleIf: (p) => p.mode === "convolve",
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
    const rank = (params.rank as number) ?? 4;

    let plan;
    if (mode === "convolve") {
      const k = inputs["kernel"];
      plan = convolvePlan(
        ctx,
        k && k.kind === "image" ? k : null,
        radius,
        rank,
        params.normalize !== false,
        linearize
      );
    } else if (mode === "bokeh") {
      const shape = String(params.shape ?? "disc");
      plan = isCircular(shape)
        ? bokehPlan(
            radius,
            shape,
            (params.components as number) ?? 3,
            (params.ring as number) ?? 0.5,
            linearize
          )
        : aperturePlan(
            radius,
            shape as ApertureShape,
            rank,
            (params.rotation as number) ?? 0,
            linearize
          );
    } else {
      plan = gaussianPlan(radius, linearize);
    }

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
