// Static images for React Native Skia (Wave 3 lane I): an Image Source /
// Image (Skia) `file` param → the AssetIR that ships it, and the mapping
// Image Source applies to it on the canvas (fit, then the inverse TRS of
// FIT_FS in uv space).
//
// A `file` param holds a decoded ImageBitmap. Its ORIGINAL encoded bytes
// are registered at import / load (lib/image-bytes.ts), so the asset's URL
// is a `blob:` URL of that file — fetched by the preview's asset loader and
// by the export's resolver (engine/skia/asset-bytes.ts), the same bytes in
// both. A bitmap with no registered original (a synthetic one) falls back to
// its PNG re-encode, a data: URL (lib/data-url.ts), when a document exists.
// One URL per bitmap for the session: the evaluator re-runs compute every
// frame and the scene exporter compares asset ids across frames, so the URL
// must not change; it is revoked when the bitmap is collected.

import { isExrImageValue } from "@/engine/exr";
import type { AssetIR } from "@/engine/skia/scene-ir";
import type { SkiaImageSource } from "@/engine/types";
import { isLegacySkew } from "@/engine/transform-value";
import { getImageOriginal } from "@/lib/image-bytes";
import { bitmapToPngDataUrl } from "@/lib/data-url";

type Bitmapish = { width: number; height: number };

const urls = new WeakMap<object, { url: string; mime: string }>();
const revoker =
  typeof FinalizationRegistry !== "undefined" && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function"
    ? new FinalizationRegistry<string>((u) => URL.revokeObjectURL(u))
    : null;

function isBitmap(v: unknown): v is Bitmapish {
  if (!v || typeof v !== "object") return false;
  if (typeof ImageBitmap !== "undefined" && v instanceof ImageBitmap) return true;
  // A stand-in with registered original bytes (Node gates have no ImageBitmap).
  const b = v as Partial<Bitmapish>;
  return typeof b.width === "number" && typeof b.height === "number" && !!getImageOriginal(v as ImageBitmap);
}

const MIME_OK = /^image\/(png|jpeg|jpg|webp|gif)$/i;

// The bitmap's bytes as a URL the asset seam resolves, memoized per bitmap.
// `encode` false: only a registered original (no PNG re-encode — the cheap
// path the editor's per-frame tagging takes).
function bitmapUrl(bmp: Bitmapish, encode = true): { url: string; mime: string } | null {
  const key = bmp as object;
  const hit = urls.get(key);
  if (hit) return hit;
  let made: { url: string; mime: string } | null = null;
  const original = getImageOriginal(bmp as ImageBitmap);
  if (original && typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
    const mime = MIME_OK.test(original.type) ? original.type.toLowerCase() : "image/png";
    made = { url: URL.createObjectURL(original), mime };
    revoker?.register(key, made.url);
  } else if (encode && typeof document !== "undefined" && typeof ImageBitmap !== "undefined" && bmp instanceof ImageBitmap) {
    made = { url: bitmapToPngDataUrl(bmp), mime: "image/png" };
  }
  if (made) urls.set(key, made);
  return made;
}

export type ImageFileAsset =
  | { kind: "asset"; asset: AssetIR }
  | { kind: "empty" }
  | { kind: "problem"; problem: string };

// `file` (an Image Source / Image (Skia) param value) as an image asset
// named `id`. `encode` false: no PNG re-encode fallback.
export function imageFileAsset(id: string, file: unknown, encode = true): ImageFileAsset {
  if (file === null || file === undefined) return { kind: "empty" };
  if (isExrImageValue(file)) {
    return { kind: "problem", problem: "an EXR still (scene-linear float pixels) has no React Native Skia image format — convert it to PNG or JPEG" };
  }
  if (!isBitmap(file)) return { kind: "problem", problem: "its file is not a decoded image" };
  const src = bitmapUrl(file, encode);
  if (!src) return { kind: "problem", problem: "its image has no encoded bytes to ship (re-import the file)" };
  return {
    kind: "asset",
    asset: { id, kind: "image", mime: src.mime, url: src.url, width: file.width, height: file.height },
  };
}

// ---- Image Source's canvas mapping ---------------------------------------------------

export type ImageFit = "cover" | "contain" | "stretch";

export function imageFitParam(v: unknown): ImageFit {
  return v === "contain" || v === "stretch" ? v : "cover";
}

// The IR / React Native fit for an Image Source fit.
export function rnImageFit(fit: ImageFit): "cover" | "contain" | "fill" {
  return fit === "stretch" ? "fill" : fit;
}

// FIT_FS's u_invScale / u_letterbox for an image of imgW × imgH on a
// canvas of w × h: samp = 0.5 + (uv − 0.5) · invScale.
export function imageFitScale(fit: ImageFit, imgW: number, imgH: number, w: number, h: number): { invScale: [number, number]; letterbox: number } {
  const alpha = imgW / imgH / (w / h);
  if (fit === "stretch") return { invScale: [1, 1], letterbox: 0 };
  if (fit === "cover") return { invScale: alpha > 1 ? [1 / alpha, 1] : [1, alpha], letterbox: 0 };
  return { invScale: alpha > 1 ? [1, alpha] : [1 / alpha, 1], letterbox: 1 };
}

export interface ImageTrs {
  translateX: number;
  translateY: number;
  scaleX: number;
  scaleY: number;
  // Degrees, as the param.
  rotate: number;
  pivotX: number;
  pivotY: number;
}

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

export function imageTrsOf(params: Record<string, unknown>): ImageTrs {
  return {
    translateX: num(params.translateX, 0),
    translateY: num(params.translateY, 0),
    scaleX: num(params.scaleX, 1),
    scaleY: num(params.scaleY, 1),
    rotate: num(params.rotate, 0),
    pivotX: num(params.pivotX, 0.5),
    pivotY: num(params.pivotY, 0.5),
  };
}

export function isIdentityTrs(t: ImageTrs): boolean {
  return t.translateX === 0 && t.translateY === 0 && t.scaleX === 1 && t.scaleY === 1 && t.rotate === 0;
}

// ---- the file as a Skia image shader ------------------------------------------------
//
// How Image Source's picture lands on a width × height canvas, as ONE
// local matrix (image px → canvas px) for an ImageShader of the file:
// fitted (cover / contain / fill, centred — React Native's fitRects), then
// its TRS forward. Image Source's TRS is aspect-rigid
// (101526_aspect-rigid-rotation.md), so in Y-down canvas px the forward
// map is
//   X' = P + T + L · (X − P),  L = diag(k, 1) · R(θ) · diag(1 / k, 1) · diag(sx, sy)
// with k = 1, P = (pivotX · width, height / 2 + (pivotY − 0.5) · width) and
// T = (translateX, translateY) · width: translate / pivot Y width-relative,
// rotation rigid. A `legacySkew` mapping keeps the old per-axis TRS:
// k = width / height, P = pivot · size, T = translate · size — the
// rotation happens in per-axis canvas fractions and shears on a
// non-square canvas, exactly as a legacySkew Image Source does.
//
// The SkSL Shader's preview builds its iImage child with this function and
// the export ships IMAGE_MATRIX_SOURCE, the same arithmetic in the same
// order (check-skia-assets holds them bit-identical), so React Native web
// draws the preview's pixels.
export interface ImageMapping {
  // The file's size in px.
  width: number;
  height: number;
  fit: "cover" | "contain" | "fill";
  translateX: number;
  translateY: number;
  scaleX: number;
  scaleY: number;
  // Degrees.
  rotate: number;
  pivotX: number;
  pivotY: number;
  // A ≤v12 Image Source's per-axis TRS (absent = aspect-rigid).
  legacySkew?: boolean;
}

export function imageLocalMatrix(img: ImageMapping, width: number, height: number): number[] {
  const iw = img.width;
  const ih = img.height;
  let s0 = width / iw;
  let s1 = height / ih;
  if (img.fit === "cover") s0 = s1 = Math.max(s0, s1);
  else if (img.fit === "contain") s0 = s1 = Math.min(s0, s1);
  const fx = (width - iw * s0) / 2;
  const fy = (height - ih * s1) / 2;
  const legacy = img.legacySkew === true;
  const k = legacy ? width / height : 1;
  const r = (img.rotate * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  // L = diag(k, 1) · R(r) · diag(1 / k, 1) · diag(scaleX, scaleY)
  const l00 = c * img.scaleX;
  const l01 = -s * k * img.scaleY;
  const l10 = (s / k) * img.scaleX;
  const l11 = c * img.scaleY;
  const px = img.pivotX * width;
  const py = legacy ? img.pivotY * height : height / 2 + (img.pivotY - 0.5) * width;
  const tx = px + img.translateX * width - (l00 * px + l01 * py);
  const ty = py + img.translateY * (legacy ? height : width) - (l10 * px + l11 * py);
  // [L | t] · [diag(s0, s1) | (fx, fy)]
  return [l00 * s0, l01 * s1, l00 * fx + l01 * fy + tx, l10 * s0, l11 * s1, l10 * fx + l11 * fy + ty, 0, 0, 1];
}

// imageLocalMatrix as the bundle's images.ts ships it (keep the two in step;
// check-skia-assets runs both).
export const IMAGE_MATRIX_SOURCE = `// Where an image lands on a width × height canvas, as Image Source draws it:
// fitted (cover / contain / fill, centered), then its translate / rotate /
// scale about the pivot — rigid in pixels, translate / pivot Y
// width-relative; a legacySkew image rotates in per-axis canvas fractions
// and shears on a non-square canvas, exactly as it does in toolbox.
// Row-major 3×3: image px → canvas px (the <ImageShader>'s local matrix).
export function imageMatrix(img: ExportImage, width: number, height: number): number[] {
  const iw = img.width;
  const ih = img.height;
  let s0 = width / iw;
  let s1 = height / ih;
  if (img.fit === "cover") s0 = s1 = Math.max(s0, s1);
  else if (img.fit === "contain") s0 = s1 = Math.min(s0, s1);
  const fx = (width - iw * s0) / 2;
  const fy = (height - ih * s1) / 2;
  const legacy = img.legacySkew === true;
  const k = legacy ? width / height : 1;
  const r = (img.rotate * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  // L = diag(k, 1) · R(r) · diag(1 / k, 1) · diag(scaleX, scaleY)
  const l00 = c * img.scaleX;
  const l01 = -s * k * img.scaleY;
  const l10 = (s / k) * img.scaleX;
  const l11 = c * img.scaleY;
  const px = img.pivotX * width;
  const py = legacy ? img.pivotY * height : height / 2 + (img.pivotY - 0.5) * width;
  const tx = px + img.translateX * width - (l00 * px + l01 * py);
  const ty = py + img.translateY * (legacy ? height : width) - (l10 * px + l11 * py);
  // [L | t] · [diag(s0, s1) | (fx, fy)]
  return [l00 * s0, l01 * s1, l00 * fx + l01 * fy + tx, l10 * s0, l11 * s1, l10 * fx + l11 * fy + ty, 0, 0, 1];
}
`;

// An Image Source / Image (Skia) as a SkiaImageSource (ImageValue
// .skiaSource): the file + its mapping, or why an ImageShader can't
// reproduce it.
export function skiaImageSourceOf(
  id: string,
  params: Record<string, unknown>,
  encode = true
): { source: SkiaImageSource } | { problem: string } | { empty: true } {
  const a = imageFileAsset(id, params.file, encode);
  if (a.kind === "empty") return { empty: true };
  if (a.kind === "problem") return { problem: a.problem };
  const fit = imageFitParam(params.fit);
  const trs = imageTrsOf(params);
  const identity = isIdentityTrs(trs);
  if (fit === "cover" && !identity) {
    // Image Source clips a moved cover image to its transformed canvas
    // rect; an ImageShader can't clip, so the cropped-away part would show.
    return {
      problem:
        "it covers the canvas and is transformed — an ImageShader can't clip the cover crop to the moved canvas rect; use fit contain or stretch, or reset its translate / scale / rotate",
    };
  }
  return {
    source: {
      asset: a.asset,
      fit: rnImageFit(fit),
      ...trs,
      ...(isLegacySkew(params) ? { legacySkew: true } : {}),
      // Outside the image: transparent where Image Source letterboxes or its
      // TRS leaves the unit square; else the edge texel (a cover / stretch
      // image fills the canvas; the engine texture clamps).
      tile: fit === "contain" || !identity ? "decal" : "clamp",
    },
  };
}

export function mappingOf(s: SkiaImageSource): ImageMapping {
  return {
    width: s.asset.width ?? 1,
    height: s.asset.height ?? 1,
    fit: s.fit,
    translateX: s.translateX,
    translateY: s.translateY,
    scaleX: s.scaleX,
    scaleY: s.scaleY,
    rotate: s.rotate,
    pivotX: s.pivotX,
    pivotY: s.pivotY,
    ...(s.legacySkew ? { legacySkew: true } : {}),
  };
}

// The params an Image Source / Image (Skia) draws from; any of them
// animating makes the image itself animate.
export const IMAGE_SOURCE_PARAMS = [
  "file",
  "fit",
  "opacity",
  "translateX",
  "translateY",
  "scaleX",
  "scaleY",
  "rotate",
  "pivotX",
  "pivotY",
  "legacySkew",
  "exr_layer",
  "exr_unpremultiply",
] as const;
