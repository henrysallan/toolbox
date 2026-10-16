// Asset Library import pipeline (specdocs/090326_asset-library.md §3): the
// one place that turns a picked file or a node's live param value into a
// library entry — kind classification, bytes, thumbnail, then the store op.
// Pure lib: no graph access, no React. EffectsApp's "Add to Assets" and
// the panel's Upload / OS-drop both land here. Every entry point takes a
// `target`: "server" (the per-user library, state/user-assets.ts) or
// "project" (the open project's own, state/project-library.ts).

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
import type { CloudMediaRef } from "@/lib/cloud-media";
import { getImageOriginal } from "@/lib/image-bytes";
import { svgFromSubpaths } from "@/lib/svg-write";
import {
  addProjectImage,
  addProjectPreset,
  addProjectSvg,
  addProjectVideo,
  inlineFragmentMedia,
  projectAssetBlob,
  type LibraryAddResult,
  type ProjectAsset,
} from "@/state/project-library";
import {
  getUserNodePresets,
  upsertUserNodePreset,
  type UserNodePreset,
} from "@/state/node-presets";
import {
  userAssetFilename,
  userAssetThumbUrl,
  userAssetUrl,
} from "@/lib/supabase/user-assets";
import {
  addImageAsset,
  addSvgAsset,
  addVideoAsset,
  imageExtForMime,
  type AddAssetResult,
  type UserAssetRow,
} from "@/state/user-assets";

export type { LibraryAddResult } from "@/state/project-library";

/** Which of the panel's two libraries an import lands in. */
export type LibraryTarget = "project" | "server";

function fromServer(res: AddAssetResult): LibraryAddResult {
  return res.ok
    ? { ok: true, name: res.row.name, duplicate: res.duplicate }
    : res;
}

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
  } = {},
  target: LibraryTarget = "server"
): Promise<LibraryAddResult> {
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
  if (target === "project") {
    return addProjectImage({
      bytes,
      mime,
      ext: imageExtForMime(mime) ?? "png",
      name,
      width,
      height,
      thumbCanvas,
    });
  }
  const thumb = await storageThumb(thumbCanvas);
  return fromServer(await addImageAsset({ bytes, mime, name, width, height, thumb }));
}

export function importImageFile(
  file: File,
  target: LibraryTarget = "server"
): Promise<LibraryAddResult> {
  return importImageBlob(file, stripExt(file.name), { filename: file.name }, target);
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
  exrThumb?: () => HTMLCanvasElement | null,
  target: LibraryTarget = "server"
): Promise<LibraryAddResult> {
  if (value instanceof ImageBitmap) {
    const original = getImageOriginal(value);
    const thumbCanvas = thumbFromBitmap(value);
    if (original && imageExtForMime(original.type)) {
      return importImageBlob(
        original,
        name,
        { thumbCanvas, width: value.width, height: value.height },
        target
      );
    }
    const png = await bitmapToPngBlob(value);
    if (!png) return { ok: false, error: "PNG encode failed." };
    return importImageBlob(
      png,
      name,
      { thumbCanvas, width: value.width, height: value.height },
      target
    );
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
  return importImageBlob(
    blob,
    name,
    { thumbCanvas, width: value.width, height: value.height },
    target
  );
}

// --- SVG ---------------------------------------------------------------------

/** SVG markup → library (validated by the real parser first). */
export async function importSvgText(
  text: string,
  name: string,
  target: LibraryTarget = "server"
): Promise<LibraryAddResult> {
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
  return addSvg(text, name, parsed, target);
}

async function addSvg(
  text: string,
  name: string,
  parsed: SvgFileParamValue,
  target: LibraryTarget
): Promise<LibraryAddResult> {
  const thumbCanvas = thumbFromSpline(parsed.subpaths, parsed.aspect);
  if (target === "project")
    return addProjectSvg({ text, name, aspect: parsed.aspect, thumbCanvas });
  const thumb = await storageThumb(thumbCanvas);
  return fromServer(await addSvgAsset({ text, name, aspect: parsed.aspect, thumb }));
}

export async function importSvgFile(
  file: File,
  target: LibraryTarget = "server"
): Promise<LibraryAddResult> {
  return importSvgText(await file.text(), stripExt(file.name), target);
}

/**
 * SVG Source's param → library. The node keeps only parsed geometry, so
 * the document is synthesized (lib/svg-write.ts) — one format for every
 * SVG asset regardless of provenance.
 */
export async function importSvgSourceValue(
  value: SvgFileParamValue,
  name: string,
  target: LibraryTarget = "server"
): Promise<LibraryAddResult> {
  const text = svgFromSubpaths(value.subpaths, value.aspect, name);
  return addSvg(text, name, value, target);
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
  opts: { cloudMedia: boolean },
  target: LibraryTarget = "server"
): Promise<LibraryAddResult> {
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
  return addVideo(
    {
      ref,
      filename: file.name,
      name: stripExt(file.name),
      size: file.size,
      duration: frame?.duration ?? null,
      width: frame?.width ?? null,
      height: frame?.height ?? null,
    },
    frame?.canvas ?? null,
    target
  );
}

async function addVideo(
  input: {
    ref: CloudMediaRef;
    filename: string;
    name: string;
    size: number;
    duration: number | null;
    width: number | null;
    height: number | null;
  },
  thumbCanvas: HTMLCanvasElement | null,
  target: LibraryTarget
): Promise<LibraryAddResult> {
  if (target === "project") return addProjectVideo({ ...input, thumbCanvas });
  const thumb = await storageThumb(thumbCanvas);
  return fromServer(await addVideoAsset({ ...input, thumb }));
}

/**
 * Video Source's param → library. The clip must already be in R2 (the
 * registry holds its ref); the thumbnail samples the value's own URL on
 * a private element so playback is never disturbed.
 */
export async function importVideoSourceValue(
  value: VideoFileParamValue,
  name: string,
  target: LibraryTarget = "server"
): Promise<LibraryAddResult> {
  const ref = getCloudMediaRef(value.filename, value.size);
  if (!ref)
    return { ok: false, error: explainMissingRef(value.filename, value.size) };
  const frame = await thumbFromVideoUrl(value.url);
  return addVideo(
    {
      ref,
      filename: value.filename ?? `${name}.${ref.ext}`,
      name,
      size: value.size ?? 0,
      duration: Number.isFinite(value.duration) ? value.duration : null,
      width: value.width || null,
      height: value.height || null,
    },
    frame?.canvas ?? null,
    target
  );
}

// --- batch ---------------------------------------------------------------------

export interface ImportOutcome {
  name: string;
  result: LibraryAddResult;
}

/** Upload Asset… / OS drop: sequential (uploads are heavy), never throws. */
export async function importFilesToLibrary(
  files: File[],
  opts: { cloudMedia: boolean; target: LibraryTarget }
): Promise<ImportOutcome[]> {
  const out: ImportOutcome[] = [];
  for (const file of files) {
    const kind = classifyLibraryFile(file);
    let result: LibraryAddResult;
    try {
      if (kind === "image") result = await importImageFile(file, opts.target);
      else if (kind === "svg") result = await importSvgFile(file, opts.target);
      else if (kind === "video")
        result = await importVideoFile(file, opts, opts.target);
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

// --- copy between libraries -------------------------------------------------------
//
// A card's Copy to Project / Copy to Server. Media re-runs the target's own
// add pipeline (fresh thumbnail, the target's dedup); a thumbnail that can't
// be regenerated (EXR, video) is carried over from the source card.

async function thumbCanvasFromUrl(
  url: string | null | undefined
): Promise<HTMLCanvasElement | null> {
  if (!url) return null;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return (await thumbFromBlob(await resp.blob()))?.canvas ?? null;
  } catch {
    return null;
  }
}

/** Server library row → this project's library. */
export async function copyServerAssetToProject(
  row: UserAssetRow
): Promise<LibraryAddResult> {
  const filename = userAssetFilename(row);
  if (row.kind === "video") {
    if (!row.owner)
      return { ok: false, error: "That video asset has no cloud reference." };
    return addProjectVideo({
      ref: { hash: row.hash, ext: row.ext, owner: row.owner },
      filename,
      name: row.name,
      size: row.size,
      duration: row.duration,
      width: row.width,
      height: row.height,
      thumbCanvas: await thumbCanvasFromUrl(userAssetThumbUrl(row)),
    });
  }
  const url = userAssetUrl(row);
  if (!url) return { ok: false, error: "Couldn't resolve that asset." };
  const resp = await fetch(url);
  if (!resp.ok)
    return { ok: false, error: `Couldn't fetch "${row.name}" (${resp.status}).` };
  const blob = new Blob([await resp.blob()], { type: row.mime });
  if (row.kind === "svg") return importSvgText(await blob.text(), row.name, "project");
  return importImageBlob(
    blob,
    row.name,
    {
      filename,
      width: row.width,
      height: row.height,
      thumbCanvas:
        row.mime === "image/x-exr"
          ? await thumbCanvasFromUrl(userAssetThumbUrl(row))
          : undefined,
    },
    "project"
  );
}

/** Server node preset → this project's library. */
export function copyServerPresetToProject(p: UserNodePreset): LibraryAddResult {
  return addProjectPreset({ name: p.name, fragment: p.fragment, thumb: p.thumbnail });
}

/** This project's library item → the Server library. */
export async function copyProjectAssetToServer(
  item: ProjectAsset
): Promise<LibraryAddResult> {
  if (item.fragment) {
    const lower = item.name.toLowerCase();
    if (getUserNodePresets().some((p) => p.name.toLowerCase() === lower))
      return { ok: true, name: item.name, duplicate: true };
    upsertUserNodePreset(
      item.name,
      await inlineFragmentMedia(item.fragment),
      item.thumb
    );
    return { ok: true, name: item.name, duplicate: false };
  }
  if (item.video) {
    return addVideo(
      {
        ref: { hash: item.video.hash, ext: item.video.ext, owner: item.video.owner },
        filename: item.video.filename,
        name: item.name,
        size: item.video.size,
        duration: item.duration,
        width: item.width,
        height: item.height,
      },
      await thumbCanvasFromUrl(item.thumb),
      "server"
    );
  }
  if (!item.media) return { ok: false, error: "Couldn't resolve that asset." };
  const blob = await projectAssetBlob(item);
  if (item.kind === "svg") return importSvgText(await blob.text(), item.name, "server");
  const mime = item.media.mime || blob.type;
  return importImageBlob(
    blob,
    item.name,
    {
      filename: item.media.filename,
      width: item.width,
      height: item.height,
      thumbCanvas:
        mime === "image/x-exr" ? await thumbCanvasFromUrl(item.thumb) : undefined,
    },
    "server"
  );
}
