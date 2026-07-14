// Cached data-URL encoding for save serialization.
//
// Media assets dominate save cost and rarely change between saves, but
// serializeParams used to re-encode every one on every save (a manual
// chunked String.fromCharCode + btoa loop — several full passes over the
// bytes plus GC churn). These helpers encode natively (FileReader / canvas)
// and cache the result per SOURCE OBJECT: Blobs, ArrayBuffers, and
// ImageBitmaps are immutable, so object identity is a sound cache key, and
// a WeakMap entry dies with its media. Unchanged assets serialize in ~0ms
// on every save after the first.
//
// INVARIANT (see specdocs/071426_save-optimization.md): media param values
// are replace-only. Code that produces new media content must mint a new
// Blob/bitmap — never write bytes or pixels behind an existing reference —
// or these caches will serve stale encodings.
//
// Memory: each entry retains the asset's base64 string (~1.33× its encoded
// file size) for the media object's lifetime — small next to the decoded
// RGBA bitmap the app already holds for it.

const blobCache = new WeakMap<Blob, string>();
const bufferCache = new WeakMap<ArrayBuffer, string>();
const bitmapCache = new WeakMap<ImageBitmap, string>();

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Blob → data-URL, cached per Blob. An untyped Blob would encode as
// application/octet-stream; `fallbackMime` rewrites the header so readers
// that key off the mime (e.g. the .toolbox asset extension map) keep
// working — pixel decoders sniff content and don't care.
export async function blobToDataUrl(
  blob: Blob,
  fallbackMime?: string
): Promise<string> {
  const hit = blobCache.get(blob);
  if (hit) return hit;
  let url = await readAsDataUrl(blob);
  if (!blob.type && fallbackMime) {
    const comma = url.indexOf(",");
    url = `data:${fallbackMime};base64,${url.slice(comma + 1)}`;
  }
  blobCache.set(blob, url);
  return url;
}

// Raw bytes → data-URL, cached per ArrayBuffer (font binaries).
export async function bufferToDataUrl(
  buffer: ArrayBuffer,
  mime: string
): Promise<string> {
  const hit = bufferCache.get(buffer);
  if (hit) return hit;
  const url = await readAsDataUrl(new Blob([buffer], { type: mime }));
  bufferCache.set(buffer, url);
  return url;
}

// ImageBitmap → PNG data-URL, cached per bitmap. Used for image params
// with no registered original bytes, and for paint snapshots (every paint
// edit mints a fresh snapshot bitmap, so identity doubles as a dirty flag).
export function bitmapToPngDataUrl(bmp: ImageBitmap): string {
  const hit = bitmapCache.get(bmp);
  if (hit) return hit;
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.drawImage(bmp, 0, 0);
  const url = canvas.toDataURL("image/png");
  bitmapCache.set(bmp, url);
  return url;
}

// Deserialize seeds the caches with the data-URLs it just decoded, so the
// first save after a load is cached too — and re-saves emit byte-identical
// data-URLs, keeping .toolbox content hashes stable across load/save
// cycles.
export function primeBlobDataUrl(blob: Blob, dataUrl: string): void {
  blobCache.set(blob, dataUrl);
}

export function primeBitmapDataUrl(bmp: ImageBitmap, dataUrl: string): void {
  bitmapCache.set(bmp, dataUrl);
}
