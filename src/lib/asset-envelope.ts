// Shared vocabulary for "asset envelopes" — the { kind, dataUrl } / { kind,
// asset } objects that serializeParams emits for binary media (images,
// paint layers, EXR stills, fonts). Both persistence containers extract
// these inline data-URLs into deduped, content-hashed binary assets and
// leave a reference behind:
//   - the .toolbox zip (lib/project-file.ts) — assets/<hash>.<ext> entries;
//   - the cloud Storage path (lib/supabase/project-assets.ts) — objects at
//     <user>/<project>/<hash>.<ext>.
// One definition of the envelope shape keeps the two readers/writers in
// lockstep. See specdocs/071426_cloud-asset-storage.md.

// An inline asset as serializeParams emits it: any envelope object carrying
// a `data:` URL under `dataUrl` (image files, paint layers, EXR, fonts).
export function isInlineAsset(
  val: unknown
): val is { kind?: string; dataUrl: string } {
  return (
    !!val &&
    typeof val === "object" &&
    typeof (val as { dataUrl?: unknown }).dataUrl === "string" &&
    (val as { dataUrl: string }).dataUrl.startsWith("data:")
  );
}

// An extracted asset reference (dataUrl swapped for a content-hash id).
// The cloud path (v9) also stores `ext` so a ref resolves to a Storage path
// without a lookup; the .toolbox path resolves ext via the manifest and
// omits it. Other envelope fields (font family/filename/axes, exr filename)
// ride alongside untouched.
export interface AssetRef {
  kind?: string;
  asset: string;
  ext?: string;
}

export function isAssetRef(val: unknown): val is AssetRef {
  return (
    !!val &&
    typeof val === "object" &&
    typeof (val as { asset?: unknown }).asset === "string"
  );
}

// Decode a data-URL to bytes + mime natively (fetch handles base64 and
// URL-encoded forms) — far cheaper than a per-char atob loop over large
// media, and no giant intermediate binary string.
export async function dataUrlToBytes(
  dataUrl: string
): Promise<{ bytes: Uint8Array; mime: string }> {
  const blob = await (await fetch(dataUrl)).blob();
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    mime: blob.type || "application/octet-stream",
  };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/x-exr": "exr",
  "font/ttf": "ttf",
};

export function mimeToExt(mime: string): string {
  return MIME_TO_EXT[mime] ?? "bin";
}

// Mimes whose bytes are already compressed: DEFLATE gains ~nothing and used
// to dominate .toolbox save CPU, so they're stored raw. Also used by the
// cloud path to set an accurate Storage content-type.
export const PRECOMPRESSED_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/x-exr",
]);
