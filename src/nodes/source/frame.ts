import {
  elementToCanvasImage,
  renderRegionToRect,
  emptyElement,
  type ElementFit,
} from "@/engine/element";
import { unitToPx } from "@/engine/layout";
import type { ElementValue, NodeDefinition } from "@/engine/types";

// The explicit sizing adapter for Auto Layout: wrap any image chain in a
// known rect. Where the image → element coercion yields a full-canvas-
// sized element, Frame gives the content an authored size in layout units
// (1 unit = 1/1000 of the canvas's smaller dimension), with fit control.
//
// Primary output is the element (this node exists to feed layouts); the
// aux image renders it at natural size, centered on a transparent canvas,
// so the preview canvas and the evaluator's aux-image fallback work.
export const frameNode: NodeDefinition = {
  type: "frame",
  name: "Frame",
  category: "image",
  subcategory: "utility",
  description:
    "Wraps an image in a fixed-size element for Auto Layout. Width and height are in layout units (1/1000 of the canvas's smaller dimension); fit controls how the image fills the rect.",
  backend: "webgl2",
  // Primary output is an element, which the universal mask post-pass
  // can't blend — the socket would be decorative.
  noMaskInput: true,
  inputs: [{ name: "image", type: "image", required: true }],
  params: [
    {
      name: "width",
      label: "Width (units)",
      type: "scalar",
      min: 1,
      max: 4000,
      softMax: 1000,
      step: 1,
      default: 300,
    },
    {
      name: "height",
      label: "Height (units)",
      type: "scalar",
      min: 1,
      max: 4000,
      softMax: 1000,
      step: 1,
      default: 300,
    },
    {
      name: "fit",
      label: "Fit",
      type: "enum",
      options: ["cover", "contain", "stretch"],
      default: "cover",
    },
  ],
  primaryOutput: "element",
  auxOutputs: [
    {
      name: "image",
      type: "image",
      description:
        "The framed element rendered at its natural size, centered on a transparent canvas — for previewing and for wiring into plain image consumers.",
    },
  ],

  compute({ inputs, params, ctx }) {
    const src = inputs.image;
    if (!src || src.kind !== "image") {
      const empty = emptyElement();
      return { primary: empty, aux: { image: elementToCanvasImage(empty, ctx) } };
    }

    // Units → px snapshot. Safe to capture: the eval cache (and these
    // closures with it) is dropped whenever the canvas resolution changes.
    const w = Math.max(1, Math.round(unitToPx((params.width as number) ?? 300, ctx)));
    const h = Math.max(1, Math.round(unitToPx((params.height as number) ?? 300, ctx)));
    const fit = ((params.fit as string) ?? "cover") as ElementFit;

    const element: ElementValue = {
      kind: "element",
      measure: () => ({ width: w, height: h }),
      render: (rctx, width, height, opts) =>
        renderRegionToRect(
          rctx,
          src,
          { x: 0, y: 0, width: 1, height: 1 },
          width,
          height,
          opts?.fit ?? fit,
          opts?.alignX,
          opts?.alignY
        ),
      // Hug resolves to the frame's own authored size — exactly what an
      // explicit sizing adapter wants as its slot default.
      preferredSizing: { width: "hug", height: "hug" },
      sourceImage: src,
    };

    return { primary: element, aux: { image: elementToCanvasImage(element, ctx) } };
  },
};
