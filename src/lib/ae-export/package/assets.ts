// Bytes for the footage the scene copies into footage/ (AeAssetCopy). The
// scene walk records `source.ref` as the toolbox node id whose `file` param
// holds the media; EffectsApp looks the node up and hands its `file` here.
//
// image  a decoded ImageBitmap: its registered original bytes when they are
//        a PNG (footage/<id>.png), else a PNG re-encode of the bitmap.
// video  a VideoFileParamValue: the original file behind its ObjectURL (the
//        scene keeps the container's extension).

import { bitmapToPngDataUrl } from "@/lib/data-url";
import { getImageOriginal } from "@/lib/image-bytes";
import type { AeAssetCopy } from "../scene";

const isUrl = (s: string) => /^(?:https?:|blob:|data:|\/)/.test(s);

async function fetchBytes(url: string): Promise<Uint8Array | null> {
  const res = await fetch(url);
  return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
}

export async function aeAssetBytes(copy: AeAssetCopy, file: unknown): Promise<Uint8Array | null> {
  if (isUrl(copy.source.ref)) return fetchBytes(copy.source.ref);
  if (!file || typeof file !== "object") return null;
  if (copy.source.kind === "video") {
    const url = (file as { url?: unknown }).url;
    return typeof url === "string" && isUrl(url) ? fetchBytes(url) : null;
  }
  if (copy.source.kind !== "image" || typeof ImageBitmap === "undefined" || !(file instanceof ImageBitmap)) return null;
  const original = getImageOriginal(file);
  if (original && original.type.toLowerCase() === "image/png") return new Uint8Array(await original.arrayBuffer());
  if (typeof document === "undefined") return null;
  return fetchBytes(bitmapToPngDataUrl(file));
}
