// Types for the vendored EXR decoder fork (exr-core.js). The raw part
// header is the file's attribute map — index.ts shapes it into the typed
// ExrHeaderInfo the rest of the app consumes.

export interface ExrRawChannel {
  name: string;
  // 0 = UINT, 1 = HALF, 2 = FLOAT
  pixelType: number;
  pLinear: number;
  xSampling: number;
  ySampling: number;
}

export interface ExrRawPartHeader {
  channels: ExrRawChannel[];
  compression: string;
  dataWindow: { xMin: number; yMin: number; xMax: number; yMax: number };
  displayWindow: { xMin: number; yMin: number; xMax: number; yMax: number };
  // Part name attribute — present on multi-part files.
  name?: string;
  spec: {
    singleTile: boolean;
    longName: boolean;
    deepFormat: boolean;
    multiPart: boolean;
  };
  [attribute: string]: unknown;
}

export interface ExrDecodeOptions {
  part?: number;
  // Channel NAMES within the part landing in the RGBA output slots. A mono
  // mapping ({ r } only) broadcasts to RGB. Omitted ⇒ top-level R/G/B/A | Y.
  mapping?: { r?: string; g?: string; b?: string; a?: string };
  // Associated → straight alpha (divide RGB by A; A = 0 keeps RGB).
  unpremultiply?: boolean;
}

export interface ExrDecodeResult {
  width: number;
  height: number;
  // RGBA, straight alpha, rows top-first (ImageBitmap order).
  data: Float32Array;
}

export function parseExrHeaderParts(buffer: ArrayBuffer): ExrRawPartHeader[];
export function decodeExrToFloat(
  buffer: ArrayBuffer,
  options?: ExrDecodeOptions
): ExrDecodeResult;
