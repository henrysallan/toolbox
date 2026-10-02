// Browser half of the Figma import (specdocs/092326_figma-import.md): decode
// the scene's images into the same runtime values a dropped image file
// produces, load and measure the scene's fonts, run the pure converter, then
// bake any rotated / flipped image placements it asked for. Kept out of
// convert.ts so the check gate can drive the mapping without a DOM.

import { ensureFontLoaded } from "@/lib/fonts";
import { decodeImageFileEnvelope } from "@/lib/project";
import {
  convertFigmaScene,
  type FigmaBitmapOp,
  type FigmaImportResult,
  type FigmaTextMeasure,
} from "./convert";
import type { FigmaScene, FigmaSceneImage, FigmaSceneNode } from "./scene";

async function decode(img: FigmaSceneImage): Promise<ImageBitmap> {
  // Registers the original bytes against the bitmap, so saving the project
  // keeps the source JPEG / PNG instead of re-encoding the decoded pixels.
  return decodeImageFileEnvelope(`data:${img.mime};base64,${img.base64}`);
}

interface SceneFont {
  family: string;
  weight: number;
  italic: boolean;
  text: string;
}

function sceneFonts(scene: FigmaScene): SceneFont[] {
  const faces = new Map<string, SceneFont>();
  const walk = (n: FigmaSceneNode) => {
    if (n.kind === "text") {
      for (const s of n.text.segments) {
        const key = `${s.fontFamily}|${s.fontWeight}|${s.italic}`;
        const f = faces.get(key);
        if (f) f.text += s.characters;
        else faces.set(key, { family: s.fontFamily, weight: s.fontWeight, italic: s.italic, text: s.characters });
      }
    } else if (n.kind === "container") {
      n.children.forEach(walk);
    }
  };
  walk(scene.frame);
  return [...faces.values()].filter((f) => f.family);
}

const timeout = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// The canvas font shorthand the Text node rasterizes with (text-raster.ts
// applyAxisStyling, constant axes) — measurements must use the same one.
function fontShorthand(f: { family: string; weight: number; italic: boolean }, size: number): string {
  return `${f.italic ? "italic " : ""}${Math.round(f.weight)} ${size}px "${f.family}", sans-serif`;
}

async function loadFonts(faces: SceneFont[]): Promise<void> {
  // Remote families can hang on a slow network — never block the paste on
  // them for long; a late font still renders once it lands.
  await Promise.race([
    Promise.all(
      faces.map((f) =>
        ensureFontLoaded(f.family, { weight: f.weight, italic: f.italic, text: f.text }).catch(() => undefined)
      )
    ),
    timeout(5000),
  ]);
  if (typeof document === "undefined" || !document.fonts) return;
  await Promise.race([
    Promise.all(faces.map((f) => document.fonts.load(fontShorthand(f, 16), f.text).catch(() => []))),
    timeout(2000),
  ]);
}

function makeTextMeasure(): FigmaTextMeasure | undefined {
  const c2d = document.createElement("canvas").getContext("2d");
  if (!c2d) return undefined;
  const REF = 200;
  const ratios = new Map<string, number>();
  return {
    baselineBelowMiddle(f) {
      const key = `${f.family}|${f.weight}|${f.italic}`;
      let ratio = ratios.get(key);
      if (ratio === undefined) {
        // Ink top measured from both anchors: the gap between them is how
        // far the alphabetic baseline sits below the em-box centre.
        c2d.font = fontShorthand(f, REF);
        c2d.textBaseline = "alphabetic";
        const fromBaseline = c2d.measureText("H").actualBoundingBoxAscent;
        c2d.textBaseline = "middle";
        const fromMiddle = c2d.measureText("H").actualBoundingBoxAscent;
        ratio = (fromBaseline - fromMiddle) / REF;
        if (!Number.isFinite(ratio)) ratio = 0.3;
        ratios.set(key, ratio);
      }
      return ratio * f.size;
    },
    // A family that doesn't render measures exactly like the generic behind
    // it — test against two generics so a family that IS one of them
    // doesn't read as missing.
    fontAvailable(family, weight, italic) {
      const probe = "mmmmmmmmmmlli1WQ@#0123456789";
      const style = `${italic ? "italic " : ""}${Math.round(weight)} 72px`;
      for (const generic of ["monospace", "serif"]) {
        c2d.font = `${style} ${generic}`;
        const base = c2d.measureText(probe).width;
        c2d.font = `${style} "${family}", ${generic}`;
        if (Math.abs(c2d.measureText(probe).width - base) > 0.01) return true;
      }
      return false;
    },
  };
}

// Draw the source through the op's affine into its canvas (see FigmaBitmapOp).
async function bake(src: ImageBitmap, op: FigmaBitmapOp): Promise<ImageBitmap> {
  const canvas = document.createElement("canvas");
  canvas.width = op.width;
  canvas.height = op.height;
  const c2d = canvas.getContext("2d");
  if (!c2d) throw new Error("no 2d context");
  const [a, b, c, d, e, f] = op.matrix;
  c2d.imageSmoothingQuality = "high";
  c2d.setTransform(a / src.width, b / src.width, c / src.height, d / src.height, e, f);
  c2d.drawImage(src, 0, 0);
  // Straight alpha, like every other bitmap the engine uploads.
  return createImageBitmap(canvas, { premultiplyAlpha: "none" });
}

export async function importFigmaScene(scene: FigmaScene): Promise<FigmaImportResult> {
  const images = new Map<string, unknown>();
  let failed = 0;
  const fonts = sceneFonts(scene);
  await Promise.all([
    ...Object.entries(scene.images).map(async ([key, img]) => {
      try {
        images.set(key, await decode(img));
      } catch {
        failed++;
      }
    }),
    loadFonts(fonts),
  ]);
  let reference: unknown;
  if (scene.reference) {
    try {
      reference = await decode(scene.reference);
    } catch {
      failed++;
    }
  }
  const result = convertFigmaScene(scene, { images, reference, text: makeTextMeasure() });

  let bakeFailed = 0;
  for (const op of result.bitmapOps) {
    const src = images.get(op.imageKey);
    const node = result.nodes.find((n) => n.id === op.nodeId);
    if (!(src instanceof ImageBitmap) || !node) continue;
    try {
      node.data.params = { ...node.data.params, file: await bake(src, op) };
    } catch {
      bakeFailed++;
    }
  }
  if (bakeFailed) result.warnings.unshift(`${bakeFailed} rotated image${bakeFailed === 1 ? "" : "s"} couldn't be re-oriented and ${bakeFailed === 1 ? "is" : "are"} shown unrotated`);
  if (failed) {
    result.warnings.unshift(
      `${failed} image${failed === 1 ? "" : "s"} couldn't be decoded and ${failed === 1 ? "was" : "were"} skipped`
    );
  }
  return result;
}
