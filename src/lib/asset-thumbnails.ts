// Thumbnail makers for the Asset Library (specdocs/090326_asset-library.md
// §2). Every maker lands on a canvas whose longest edge is THUMB_SIZE; the
// caller picks the encoding: `encodeThumbDataUrl` for node presets (stored
// inline in the preset row) or `encodeThumbBlob` for the Storage bucket.
//
// Raster sources (bitmaps, video frames, GPU readbacks) encode as JPEG —
// alpha composites over a fixed dark plate first, since JPEG has none.
// Vector sources (splines, points) encode as PNG: line art stays crisp and
// small. The plate colour is a constant, not a theme var: a persisted
// thumbnail can't re-resolve CSS on the reader's theme.
//
// Nothing here touches `document` at module scope — node-presets.ts (and
// its offline check under a stubbed DOM) import the size cap from here.

import type { PointsValue, SplineSubpath } from "@/engine/types";
import { aspectCorrectY } from "@/engine/aspect";
import { buildPath2D } from "@/engine/spline-raster";

export const THUMB_SIZE = 256;
export type ThumbFormat = "jpeg" | "png";

// Inline preset thumbnails ride the user_preferences jsonb row every
// session loads — keep each one small. A 256px JPEG is ~10–30 KB (≈40 K
// chars base64); a PNG of line art ~5–10 KB. Dense noise can overshoot,
// which is what encodeThumbDataUrlWithinCap's ladder is for.
export const MAX_THUMB_DATA_URL_CHARS = 96 * 1024;

const PLATE = "#1a1a1c";
const STROKE = "rgba(255, 255, 255, 0.92)";
const JPEG_QUALITY = 0.82;

export function isThumbDataUrl(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.startsWith("data:image/") &&
    v.length <= MAX_THUMB_DATA_URL_CHARS
  );
}

// Fit a w×h box inside THUMB_SIZE² preserving aspect (never upscales past
// the cap, may upscale tiny sources so cards don't render a 4px speck).
function fitBox(w: number, h: number): { w: number; h: number } {
  const safeW = Number.isFinite(w) && w > 0 ? w : 1;
  const safeH = Number.isFinite(h) && h > 0 ? h : 1;
  const scale = THUMB_SIZE / Math.max(safeW, safeH);
  return {
    w: Math.max(1, Math.round(safeW * scale)),
    h: Math.max(1, Math.round(safeH * scale)),
  };
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  return ctx;
}

// --- encoding -------------------------------------------------------------------

export function encodeThumbDataUrl(
  canvas: HTMLCanvasElement,
  format: ThumbFormat
): string {
  return format === "png"
    ? canvas.toDataURL("image/png")
    : canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

/**
 * Encode for the inline (preset) store, guaranteeing the cap: the asked
 * format first, then JPEG at lower quality, then a 160px JPEG. Returns
 * null only when even that overshoots (never happens for 160px JPEG in
 * practice, but the caller must handle it).
 */
export function encodeThumbDataUrlWithinCap(
  canvas: HTMLCanvasElement,
  format: ThumbFormat
): string | null {
  const first = encodeThumbDataUrl(canvas, format);
  if (isThumbDataUrl(first)) return first;
  const flat = makeCanvas(canvas.width, canvas.height);
  const fctx = ctx2d(flat);
  fctx.fillStyle = PLATE;
  fctx.fillRect(0, 0, flat.width, flat.height);
  fctx.drawImage(canvas, 0, 0);
  const lower = flat.toDataURL("image/jpeg", 0.65);
  if (isThumbDataUrl(lower)) return lower;
  const scale = 160 / Math.max(flat.width, flat.height);
  const small = makeCanvas(
    Math.max(1, Math.round(flat.width * scale)),
    Math.max(1, Math.round(flat.height * scale))
  );
  ctx2d(small).drawImage(flat, 0, 0, small.width, small.height);
  const smallest = small.toDataURL("image/jpeg", 0.65);
  return isThumbDataUrl(smallest) ? smallest : null;
}

export function encodeThumbBlob(
  canvas: HTMLCanvasElement,
  format: ThumbFormat
): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (format === "png") canvas.toBlob((b) => resolve(b), "image/png");
    else canvas.toBlob((b) => resolve(b), "image/jpeg", JPEG_QUALITY);
  });
}

// Storage thumbnails are always JPEG (one path, one mime — spec §1.2); a
// vector canvas gets the plate painted under it here.
export async function encodeStorageThumb(
  canvas: HTMLCanvasElement
): Promise<Blob | null> {
  const flat = makeCanvas(canvas.width, canvas.height);
  const ctx = ctx2d(flat);
  ctx.fillStyle = PLATE;
  ctx.fillRect(0, 0, flat.width, flat.height);
  ctx.drawImage(canvas, 0, 0);
  return encodeThumbBlob(flat, "jpeg");
}

// --- raster sources -------------------------------------------------------------

type Drawable =
  | ImageBitmap
  | HTMLImageElement
  | HTMLCanvasElement
  | HTMLVideoElement;

/** Fit any drawable into the thumb box over the dark plate. */
export function thumbFromDrawable(
  src: Drawable,
  srcW: number,
  srcH: number
): HTMLCanvasElement {
  const { w, h } = fitBox(srcW, srcH);
  const c = makeCanvas(w, h);
  const ctx = ctx2d(c);
  ctx.fillStyle = PLATE;
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(src, 0, 0, w, h);
  return c;
}

export function thumbFromBitmap(bmp: ImageBitmap): HTMLCanvasElement {
  return thumbFromDrawable(bmp, bmp.width, bmp.height);
}

/** Decode an encoded image (any browser-decodable mime) and thumb it. */
export async function thumbFromBlob(
  blob: Blob
): Promise<{ canvas: HTMLCanvasElement; width: number; height: number } | null> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    return null;
  }
  try {
    return { canvas: thumbFromBitmap(bmp), width: bmp.width, height: bmp.height };
  } finally {
    bmp.close();
  }
}

/** Custom-thumbnail upload: decode, fit, plate — never store user bytes. */
export function normalizeThumbnailFile(
  file: File
): Promise<HTMLCanvasElement | null> {
  return thumbFromBlob(file).then((r) => r?.canvas ?? null);
}

// A GPU readback (rows top-first, RGBA8) → canvas. Masks arrive as
// (v,0,0,255) and expand to grey so the thumb reads as coverage.
export function thumbFromPixels(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  kind: "image" | "mask" | "uv"
): HTMLCanvasElement {
  // Copy: a readback may be a view on a pooled/shared buffer, and
  // ImageData wants a plain ArrayBuffer-backed array it can own.
  const data = new Uint8ClampedArray(rgba);
  if (kind === "mask") {
    for (let i = 0; i < data.length; i += 4) {
      data[i + 1] = data[i];
      data[i + 2] = data[i];
      data[i + 3] = 255;
    }
  }
  const raw = makeCanvas(w, h);
  ctx2d(raw).putImageData(new ImageData(data, w, h), 0, 0);
  // Composite over the plate (and size-normalize) in one draw.
  return thumbFromDrawable(raw, w, h);
}

// --- video ------------------------------------------------------------------------

// 10 % into the clip — the fixed point the owner chose (decision 6). Far
// enough to clear black lead-ins, early enough that a long clip is still
// recognizable by its opening.
const VIDEO_THUMB_FRACTION = 0.1;
const VIDEO_THUMB_TIMEOUT_MS = 15_000;

/**
 * Grab a frame from a video URL (ObjectURL or https) on a private
 * element — never seeks the node's live element. Resolves null on
 * timeout / decode failure / tainted canvas.
 */
export function thumbFromVideoUrl(
  url: string
): Promise<{ canvas: HTMLCanvasElement; width: number; height: number; duration: number } | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    let done = false;
    const finish = (
      result: {
        canvas: HTMLCanvasElement;
        width: number;
        height: number;
        duration: number;
      } | null
    ) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onErr);
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch {}
      resolve(result);
    };
    const timer = window.setTimeout(() => finish(null), VIDEO_THUMB_TIMEOUT_MS);
    const onErr = () => finish(null);
    const draw = () => {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return finish(null);
      try {
        const canvas = thumbFromDrawable(video, w, h);
        // A cross-origin frame without CORS headers taints the canvas;
        // toDataURL throws. Probe once so the caller gets null, not a
        // later exception.
        canvas.toDataURL();
        finish({ canvas, width: w, height: h, duration: video.duration });
      } catch {
        finish(null);
      }
    };
    const onSeeked = () => {
      // Some engines fire `seeked` before the frame is painted; a rVFC (or
      // a tick) lets the decoder land it.
      const rvfc = (
        video as unknown as {
          requestVideoFrameCallback?: (cb: () => void) => number;
        }
      ).requestVideoFrameCallback;
      if (typeof rvfc === "function") rvfc.call(video, draw);
      else window.setTimeout(draw, 50);
    };
    const onMeta = () => {
      const d = video.duration;
      const t =
        Number.isFinite(d) && d > 0
          ? Math.min(d * VIDEO_THUMB_FRACTION, Math.max(0, d - 0.05))
          : 0;
      video.addEventListener("seeked", onSeeked);
      try {
        video.currentTime = t;
      } catch {
        finish(null);
      }
    };
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("error", onErr);
    video.src = url;
  });
}

// --- vector sources ---------------------------------------------------------------

// Box for a value authored in [0,1]² on a canvas of the given aspect.
function aspectBox(aspect: number): { w: number; h: number } {
  const safe = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  return fitBox(safe, 1);
}

/**
 * The viewport's default spline preview, as a thumbnail: the same
 * buildPath2D (aspect-corrected y) and a thin white stroke. Transparent
 * background — encode as PNG for presets; Storage flattens it.
 */
export function thumbFromSpline(
  subpaths: SplineSubpath[],
  aspect: number
): HTMLCanvasElement {
  const { w, h } = aspectBox(aspect);
  const c = makeCanvas(w, h);
  const ctx = ctx2d(c);
  const path = buildPath2D(subpaths, w, h, false);
  if (path) {
    ctx.strokeStyle = STROKE;
    ctx.lineWidth = Math.max(1.25, Math.min(w, h) * 0.006);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke(path);
  }
  return c;
}

const MAX_THUMB_DOTS = 6000;

/** 2D points as dots (PointsOverlay's drawing, stride-sampled). */
export function thumbFromPoints(
  value: PointsValue,
  aspect: number
): HTMLCanvasElement {
  const { w, h } = aspectBox(aspect);
  const c = makeCanvas(w, h);
  const ctx = ctx2d(c);
  ctx.fillStyle = STROKE;
  const stride = Math.max(1, Math.ceil(value.count / MAX_THUMB_DOTS));
  const pos = value.positions;
  const r = Math.max(1, Math.min(w, h) * 0.006);
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  for (let i = 0; i < value.count; i += stride) {
    const px = pos[i * 2] * w;
    const py = aspectCorrectY(pos[i * 2 + 1], safeAspect) * h;
    ctx.fillRect(px - r, py - r, r * 2, r * 2);
  }
  return c;
}
