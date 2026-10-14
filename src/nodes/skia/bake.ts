import type { ImageValue, NodeDefinition, SkiaDrawValue } from "@/engine/types";
import { canvasKit, canvasKitReady, ensureCanvasKit } from "@/engine/skia/canvaskit";
import { bindStatic, type AssetIR } from "@/engine/skia/scene-ir";
import {
  bakeAssetId,
  bakeUrl,
  makeBakeImage,
  registerBakeFrame,
  releaseBakeFrames,
  SKIA_BAKE_TYPE,
} from "@/engine/skia/bake-frames";

// Skia Bake — the `bake` lowering class (specdocs/101326_skia-target.md
// §3.2): an ENGINE image inside a Skia layer, shipped as an image asset.
// Anything the Skia library can't express live (a blur or bloom over noise,
// a simulation, video, 3D) renders with the real engine and travels to the
// device as pixels.
//
// Wiring rule: a Skia layer still holds only Skia nodes. The engine graph
// that makes the picture stays OUTSIDE the layer and comes in through a
// Layer Input socket (one you mint by dragging a wire onto the Layer
// Input's empty port, or its `backdrop` — what is below the layer) wired
// into this node's `image`. Flatten splices that wire straight through, so
// the evaluator sees source → Skia Bake (engine/flatten.ts).
//
// Preview: the live engine image at the current frame, read back at canvas
// size and drawn by CanvasKit as the `bake:<nodeId>` asset
// (engine/skia/bake-frames.ts). Export (lib/skia-export/bake.ts): content
// that does not change over the timeline ships as one PNG at canvas size;
// animated content as a sprite sheet of frames that the component steps
// through on the exported clock.

export const BAKE_MODES = ["auto", "static", "animated"] as const;
export const BAKE_SHEET_CAPS = ["2048", "4096", "8192"] as const;

export const skiaBakeNode: NodeDefinition = {
  type: SKIA_BAKE_TYPE,
  name: "Skia Bake",
  category: "utility",
  description:
    "Brings an engine image into a Skia layer and ships it as pixels: the export renders it with the real engine — one PNG when it doesn't change over the timeline, otherwise a sprite sheet of frames the component steps through on the exported clock. Wire the image in from outside the layer through a Layer Input socket (or the Layer Input's backdrop).",
  searchAliases: ["skia", "bake", "image", "sprite sheet", "flipbook", "rasterize", "react native", "asset"],
  facts: {
    space: { out: "pixels" },
    gotchas: [
      "Engine nodes cannot sit inside a Skia layer: build the image outside it and wire it in through a Layer Input socket (drag onto the Layer Input's empty port) or the backdrop.",
      "Draws the image over the whole canvas (0,0 to width×height, fit fill); move or scale it with Skia Group.",
      "Bake auto ships one PNG when nothing upstream moves (keyframes, clip windows, animated noise…), else a sprite sheet; the export also compares rendered frames and switches if they disagree.",
      "A sheet is capped at Max sheet px per side: frames that don't fit at canvas size are baked smaller and upscaled on device (the export warns); lower Bake FPS to keep full size.",
      "Bake FPS 0 means the timeline's fps; a lower rate holds each baked frame until the next one, while the preview still shows every frame.",
    ],
  },
  backend: "webgl2",
  skia: { class: "bake" },
  noMaskInput: true,
  inputs: [{ name: "image", label: "Image", type: "image", required: true }],
  params: [
    {
      name: "mode",
      label: "Bake",
      type: "enum",
      options: [...BAKE_MODES],
      optionLabels: { auto: "Auto", static: "Static PNG", animated: "Sprite sheet" },
      default: "auto",
    },
    {
      name: "fps",
      label: "Bake FPS",
      type: "scalar",
      min: 0,
      max: 240,
      step: 1,
      default: 0,
      visibleIf: (p) => p.mode !== "static",
    },
    {
      name: "max_sheet",
      label: "Max sheet",
      type: "enum",
      options: [...BAKE_SHEET_CAPS],
      optionLabels: { "2048": "2048 px", "4096": "4096 px", "8192": "8192 px" },
      default: "4096",
      visibleIf: (p) => p.mode !== "static",
    },
  ],
  primaryOutput: "skia_draw",
  auxOutputs: [],
  // A frame computed before CanvasKit loaded filed no preview image: bust it.
  fingerprintExtras() {
    return canvasKitReady() ? "ck1" : "ck0";
  },

  compute({ inputs, ctx, nodeId }) {
    const w = ctx.width;
    const h = ctx.height;
    // A fresh AssetIR per compute: the preview frame is filed under this
    // object, so a cached output keeps drawing the frame it was made with.
    const asset: AssetIR = { id: bakeAssetId(nodeId), kind: "image", mime: "image/png", url: bakeUrl(nodeId), width: w, height: h };
    const problems: string[] = [];
    // The export's scene sampler evaluates Skia nodes on a context with no
    // GL (lib/skia-export/scene-sample.ts) and cuts this node's input — the
    // exporter renders it separately — so only a real context reads pixels.
    const live = typeof (ctx as { readImagePixels?: unknown }).readImagePixels === "function";
    const img = inputs.image as ImageValue | undefined;
    if (live) {
      if (!img || img.kind !== "image") {
        problems.push(
          `Skia Bake ${nodeId}: nothing is wired into image — build the engine image outside the Skia layer and wire it in through a Layer Input socket.`
        );
      } else {
        const kit = canvasKit();
        if (!kit) void ensureCanvasKit().catch(() => {});
        else {
          const px = ctx.readImagePixels(img, w, h);
          const frame = px ? makeBakeImage(kit, px, w, h) : null;
          if (frame) registerBakeFrame(ctx, nodeId, asset, frame);
          else problems.push(`Skia Bake ${nodeId}: the engine image could not be read back for the preview.`);
        }
      }
    }
    const out: SkiaDrawValue = {
      kind: "skia_draw",
      node: { k: "image", id: nodeId, asset: asset.id, x: bindStatic(0), y: bindStatic(0), w: bindStatic(w), h: bindStatic(h), fit: "fill" },
      assets: { [asset.id]: asset },
      ...(problems.length ? { problems } : {}),
    };
    return { primary: out };
  },

  dispose(ctx, nodeId) {
    releaseBakeFrames(ctx, nodeId);
  },
};
