// Public API for EXR support. Engine-side (invariant #1) so the export
// bundle carries it. Spec: specdocs/070926_exr-color-pipeline.md.
//
//   parseExrHeader(buffer)  — cheap, header-only (≈1ms on a 4K file); run at
//                             file-pick time to enumerate layers.
//   groupExrLayers(header)  — heuristic layer list for the UI dropdown.
//   decodeExrAsync(...)     — worker-pool decode to RGBA Float32 (straight
//                             alpha, rows top-first, HDR values intact).
//   decodeExrSync(...)      — same, on the calling thread (offline/tests).
import { parseExrHeaderParts, decodeExrToFloat } from "./exr-core";
import type { ExrDecodeResult } from "./exr-core";
import {
  shapeExrHeader,
  type ExrHeaderInfo,
  type ExrLayer,
} from "./layers";

export { groupExrLayers, findExrLayer, shapeExrHeader } from "./layers";
export type {
  ExrHeaderInfo,
  ExrLayer,
  ExrLayerMapping,
  ExrPartInfo,
  ExrChannelInfo,
} from "./layers";
export { decodeExrAsync, exrDecodeBacklog } from "./decode-pool";
export type { ExrDecodeResult } from "./exr-core";

// OpenEXR magic: 0x76 0x2F 0x31 0x01 (little-endian int32 20000630).
export function isExrBytes(bytes: ArrayBuffer | Uint8Array): boolean {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return (
    u8.length >= 4 &&
    u8[0] === 0x76 &&
    u8[1] === 0x2f &&
    u8[2] === 0x31 &&
    u8[3] === 0x01
  );
}

export function isExrFilename(name: string | undefined | null): boolean {
  return /\.exr$/i.test(name ?? "");
}

// Type guard for the `file` param's EXR variant (Image Source holds either a
// plain ImageBitmap or an ExrImageParamValue). ImageBitmap is referenced
// defensively — this also runs during SSR where it doesn't exist.
export function isExrImageValue(
  v: unknown
): v is import("@/engine/types").ExrImageParamValue {
  return (
    !!v &&
    typeof v === "object" &&
    (typeof ImageBitmap === "undefined" || !(v instanceof ImageBitmap)) &&
    (v as { kind?: string }).kind === "exr"
  );
}

export function parseExrHeader(buffer: ArrayBuffer): ExrHeaderInfo {
  return shapeExrHeader(parseExrHeaderParts(buffer));
}

export interface ExrLayerDecodeOptions {
  layer?: ExrLayer;
  unpremultiply?: boolean;
}

export function decodeExrSync(
  buffer: ArrayBuffer,
  opts: ExrLayerDecodeOptions = {}
): ExrDecodeResult {
  return decodeExrToFloat(buffer, {
    part: opts.layer?.part ?? 0,
    mapping: opts.layer?.mapping,
    unpremultiply: opts.unpremultiply,
  });
}

// Worker-pool decode of one layer. `buffer` is TRANSFERRED to the worker —
// hand over a fresh ArrayBuffer (blob.arrayBuffer()), never a retained one.
export async function decodeExrLayerAsync(
  buffer: ArrayBuffer,
  opts: ExrLayerDecodeOptions = {}
): Promise<ExrDecodeResult> {
  const { decodeExrAsync } = await import("./decode-pool");
  return decodeExrAsync(buffer, {
    part: opts.layer?.part ?? 0,
    mapping: opts.layer?.mapping,
    unpremultiply: opts.unpremultiply,
  });
}
