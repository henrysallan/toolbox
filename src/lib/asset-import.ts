// Asset Library import pipeline (specdocs/090326_asset-library.md §3): the
// one place that turns a picked file or a node's live param value into a
// library row — kind classification, bytes, thumbnail, then the store op.
// Pure lib: no graph access, no React. EffectsApp's "Add to Assets" and
// the panel's Upload / OS-drop both land here.

import type {
  ExrImageParamValue,
  SvgFileParamValue,
  VideoFileParamValue,
} from "@/engine/types";
import {
  encodeStorageThumb,
  thumbFromBitmap,
  thumbFromBlob,
  thumbFromSpline,
  thumbFromVideoUrl,
} from "@/lib/asset-thumbnails";
import {
  getCloudMediaRef,
  getCloudUploadState,
  maybeUploadCloudMedia,
} from "@/lib/cloud-media-upload";
import { getImageOriginal } from "@/lib/image-bytes";
import { svgFromSubpaths } from "@/lib/svg-write";
import {
  addImageAsset,
  addSvgAsset,
  addVideoAsset,
  imageExtForMime,
  type AddAssetResult,
} from "@/state/user-assets";

export type LibraryFileKind = "image" | "svg" | "video";

/** The v1 media kinds the library accepts (decision 8). */
export function classifyLibraryFile(file: File): LibraryFileKind | null {
  const mime = file.type;
  const n = file.name.toLowerCase();
  if (mime === "image/svg+xml" || n.endsWith(".svg")) return "svg";
  if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|avif|exr)$/.test(n))
    return "image";
  if (mime.startsWith("video/") || /\.(mp4|webm|mov|m4v|avi|mkv)$/.test(n))
    return "video";
  return null;
}

export function stripExt(name: string): string {
  return name.replace(/\.[^/.]+$/, "") || name;
}

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  avif: "image/avif",
  exr: "image/x-exr",
};

function mimeFromName(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return EXT_MIME[ext] ?? "";
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type));
}

async function bitmapToPngBlob(bmp: ImageBitmap): Promise<Blob | null> {
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bmp, 0, 0);
  return canvasToBlob(c, "image/png");
}

async function storageThumb(
  canvas: HTMLCanvasElement | null
): Promise<Blob | null> {
  if (!canvas) return null;
  try {
    return await encodeStorageThumb(canvas);
  } catch {
    return null;
  }
}

// --- images ------------------------------------------------------------------

/**
 * Encoded image bytes → library. Mimes outside the storable table
 * (imageExtForMime) are decoded and re-encoded as PNG. EXR bytes store
 * as-is (the browser can't decode them, so no auto-thumbnail unless the
 * caller supplies one from a GPU readback).
 */
export async function importImageBlob(
  blob: Blob,
  name: string,
  opts: {
    filename?: string;
    thumbCanvas?: HTMLCanvasElement | null;
    width?: number | null;
    height?: number | null;
  } = {}
): Promise<AddAssetResult> {
  let bytes = blob;
  let mime = blob.type || mimeFromName(opts.filename ?? "");
  let width = opts.width ?? null;
  let height = opts.height ?? null;
  let thumbCanvas = opts.thumbCanvas ?? null;
  const isExr = mime === "image/x-exr";

  if (!isExr) {
    // Decode once for the thumbnail + dimensions; re-encode only when the
    // source mime isn't storable.
    const decoded = await thumbFromBlob(blob);
    if (!decoded && !imageExtForMime(mime))
      return { ok: false, error: `Couldn't decode "${name}" as an image.` };
    if (decoded) {
      width ??= decoded.width;
      height ??= decoded.height;
      thumbCanvas ??= decoded.canvas;
    }
    if (!imageExtForMime(mime)) {
      let bmp: ImageBitmap;
      try {
        bmp = await createImageBitmap(blob);
      } catch {
        return { ok: false, error: `Couldn't decode "${name}" as an image.` };
      }
      const png = await bitmapToPngBlob(bmp);
      bmp.close();
      if (!png) return { ok: false, error: "PNG re-encode failed." };
      bytes = png;
      mime = "image/png";
    }
  }
  const thumb = await storageThumb(thumbCanvas);
  return addImageAsset({ bytes, mime, name, width, height, thumb });
}

export function importImageFile(file: File): Promise<AddAssetResult> {
  return importImageBlob(file, stripExt(file.name), { filename: file.name });
}

/**
 * Image Source's `file` param → library. Prefers the registered original
 * bytes (import/load register them — image-bytes.ts) over a PNG
 * re-encode. EXR stills store their canonical bytes; their thumbnail
 * comes from the node's evaluated output (caller-supplied) or nothing.
 */
export async function importImageSourceValue(
  value: ImageBitmap | ExrImageParamValue,
  name: string,
  exrThumb?: () => HTMLCanvasElement | null
): Promise<AddAssetResult> {
  if (value instanceof ImageBitmap) {
    const original = getImageOriginal(value);
    const thumbCanvas = thumbFromBitmap(value);
    if (original && imageExtForMime(original.type)) {
      return importImageBlob(original, name, {
        thumbCanvas,
        width: value.width,
        height: value.height,
      });
    }
    const png = await bitmapToPngBlob(value);
    if (!png) return { ok: false, error: "PNG encode failed." };
    return importImageBlob(png, name, {
      thumbCanvas,
      width: value.width,
      height: value.height,
    });
  }
  // EXR
  const blob =
    value.blob.type === "image/x-exr"
      ? value.blob
      : new Blob([value.blob], { type: "image/x-exr" });
  let thumbCanvas: HTMLCanvasElement | null = null;
  try {
    thumbCanvas = exrThumb?.() ?? null;
  } catch {
    thumbCanvas = null;
  }
  return importImageBlob(blob, name, {
    thumbCanvas,
    width: value.width,
    height: value.height,
  });
}

// --- SVG ---------------------------------------------------------------------

/** SVG markup → library (validated by the real parser first). */
export async function importSvgText(
  text: string,
  name: string
): Promise<AddAssetResult> {
  let parsed: SvgFileParamValue;
  try {
    const { parseSvg } = await import("@/lib/svg-parse");
    parsed = parseSvg(text, name);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : `Couldn't parse "${name}".`,
    };
  }
  const thumb = await storageThumb(
    thumbFromSpline(parsed.subpaths, parsed.aspect)
  );
  return addSvgAsset({ text, name, aspect: parsed.aspect, thumb });
}

export async function importSvgFile(file: File): Promise<AddAssetResult> {
  return importSvgText(await file.text(), stripExt(file.name));
}

/**
 * SVG Source's param → library. The node keeps only parsed geometry, so
 * the document is synthesized (lib/svg-write.ts) — one format for every
 * SVG asset regardless of provenance.
 */
export async function importSvgSourceValue(
  value: SvgFileParamValue,
  name: string
): Promise<AddAssetResult> {
  const text = svgFromSubpaths(value.subpaths, value.aspect, name);
  const thumb = await storageThumb(thumbFromSpline(value.subpaths, value.aspect));
  return addSvgAsset({ text, name, aspect: value.aspect, thumb });
}

// --- video --------------------------------------------------------------------

const VIDEO_NEEDS_CLOUD =
  "Video assets need cloud media, which isn't enabled for this account.";

function explainMissingRef(filename: string | undefined, size?: number): string {
  const st = getCloudUploadState(filename, size);
  if (st?.phase === "hashing" || st?.phase === "uploading")
    return "Still uploading to cloud media — try again in a moment.";
  if (st?.phase === "error")
    return "The cloud upload for this clip failed, so it can't be added.";
  return "This clip isn't in cloud media — re-pick it while cloud media is enabled.";
}

/** A picked/dropped video file → R2 (entitled) → library. */
export async function importVideoFile(
  file: File,
  opts: { cloudMedia: boolean }
): Promise<AddAssetResult> {
  if (!opts.cloudMedia) return { ok: false, error: VIDEO_NEEDS_CLOUD };
  await maybeUploadCloudMedia(file, "video");
  const ref = getCloudMediaRef(file.name, file.size);
  if (!ref) {
    const st = getCloudUploadState(file.name, file.size);
    return {
      ok: false,
      error:
        st?.phase === "error"
          ? `Cloud upload failed for "${file.name}".`
          : `"${file.name}" couldn't be stored in cloud media (unsupported type or over the size cap).`,
    };
  }
  const url = URL.createObjectURL(file);
  let frame: Awaited<ReturnType<typeof thumbFromVideoUrl>> = null;
  try {
    frame = await thumbFromVideoUrl(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const thumb = await storageThumb(frame?.canvas ?? null);
  return addVideoAsset({
    ref,
    name: stripExt(file.name),
    size: file.size,
    duration: frame?.duration ?? null,
    width: frame?.width ?? null,
    height: frame?.height ?? null,
    thumb,
  });
}

/**
 * Video Source's param → library. The clip must already be in R2 (the
 * registry holds its ref); the thumbnail samples the value's own URL on
 * a private element so playback is never disturbed.
 */
export async function importVideoSourceValue(
  value: VideoFileParamValue,
  name: string
): Promise<AddAssetResult> {
  const ref = getCloudMediaRef(value.filename, value.size);
  if (!ref)
    return { ok: false, error: explainMissingRef(value.filename, value.size) };
  const frame = await thumbFromVideoUrl(value.url);
  const thumb = await storageThumb(frame?.canvas ?? null);
  return addVideoAsset({
    ref,
    name,
    size: value.size ?? 0,
    duration: Number.isFinite(value.duration) ? value.duration : null,
    width: value.width || null,
    height: value.height || null,
    thumb,
  });
}

// --- batch ---------------------------------------------------------------------

export interface ImportOutcome {
  name: string;
  result: AddAssetResult;
}

/** Upload Asset… / OS drop: sequential (uploads are heavy), never throws. */
export async function importFilesToLibrary(
  files: File[],
  opts: { cloudMedia: boolean }
): Promise<ImportOutcome[]> {
  const out: ImportOutcome[] = [];
  for (const file of files) {
    const kind = classifyLibraryFile(file);
    let result: AddAssetResult;
    try {
      if (kind === "image") result = await importImageFile(file);
      else if (kind === "svg") result = await importSvgFile(file);
      else if (kind === "video") result = await importVideoFile(file, opts);
      else
        result = {
          ok: false,
          error: `"${file.name}" isn't an image, SVG, or video.`,
        };
    } catch (err) {
      result = {
        ok: false,
        error: err instanceof Error ? err.message : `Couldn't add "${file.name}".`,
      };
    }
    out.push({ name: file.name, result });
  }
  return out;
}
