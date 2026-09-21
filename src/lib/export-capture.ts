// Export frame capture — the CPU half of "read the frame straight off the
// GPU".
//
// Until 2026-09-21 every exporter captured frames by copying the on-screen
// preview canvas (drawImage → getImageData, or canvas.toBlob). That made an
// export hostage to whatever Chromium was doing with that canvas: an
// occluded window, a hibernated or resource-starved 2D canvas, or a
// compositor that had not presented yet all hand back the LAST picture, and
// the video "freezes a few frames in" while the engine keeps rendering. The
// 2026-09-20 case: a desktop 3840² lossless export animated for a handful of
// frames and then held one image, the same project exported fine at 960²,
// and the perf trace showed all 240 frames evaluated with a fresh grain key
// — the freeze was entirely downstream of the engine.
//
// Frames now come from EngineBackend.readImagePixels — the terminal texture
// itself — as RGBA8, straight alpha, row 0 = visual top: exactly what
// ffmpeg's rawvideo input and ImageData both want. This module turns those
// bytes into the shapes the encoders take (Blob / PNG bytes) and keeps the
// per-frame bookkeeping (checksums, identical-frame runs) that would have
// put the freeze in the log on the first run.

export type RGBA8 = Uint8ClampedArray<ArrayBuffer>;

// Which progress bar an exporter's onProgress update belongs to. The frame
// loop (render + capture + hand-off) is `capture`; whatever the encoder
// reports about frames it has actually written is `encode`. The two run
// concurrently on the native path and one bar cannot show both — that is
// why the old single bar jumped between 120/240 and 61/240.
export type ExportPhase = "capture" | "encode";

export type ExportProgress = (
  label: string,
  fraction: number,
  phase?: ExportPhase
) => void;

export interface CapturedFrame {
  px: RGBA8;
  width: number;
  height: number;
}

// Encode raw RGBA8 rows into an image Blob via an OffscreenCanvas (DOM
// canvas fallback where OffscreenCanvas is missing). NOTE: 2D canvases store
// premultiplied alpha, so pixels with partial alpha lose a little precision
// on the way through — the same loss canvas.toBlob always had. The raw
// video path (CapturedFrame.px straight into ffmpeg) keeps alpha byte-exact.
export async function rgbaToBlob(
  frame: CapturedFrame,
  type = "image/png",
  quality?: number
): Promise<Blob> {
  const { px, width, height } = frame;
  if (px.length !== width * height * 4) {
    throw new Error(
      `rgbaToBlob: ${px.length} bytes is not ${width}×${height}×4`
    );
  }
  const imageData = new ImageData(px, width, height);
  if (typeof OffscreenCanvas !== "undefined") {
    const oc = new OffscreenCanvas(width, height);
    const ctx = oc.getContext("2d");
    if (!ctx) throw new Error("rgbaToBlob: OffscreenCanvas 2D context unavailable");
    ctx.putImageData(imageData, 0, 0);
    return oc.convertToBlob(quality != null ? { type, quality } : { type });
  }
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("rgbaToBlob: 2D context unavailable");
  ctx.putImageData(imageData, 0, 0);
  return new Promise<Blob>((resolve, reject) => {
    c.toBlob(
      (b) =>
        b
          ? resolve(b)
          : reject(new Error(`rgbaToBlob: toBlob returned null for ${type}`)),
      type,
      quality
    );
  });
}

export async function rgbaToBytes(
  frame: CapturedFrame,
  type = "image/png",
  quality?: number
): Promise<Uint8Array> {
  const blob = await rgbaToBlob(frame, type, quality);
  return new Uint8Array(await blob.arrayBuffer());
}

// Cheap frame fingerprint: FNV-1a over the byte length plus ~4096 pixels
// sampled on a fixed stride across the whole buffer (every byte when the
// buffer is small). Collisions do not matter — its only job is to notice
// "identical to the previous frame" runs, which is what a stalled capture
// looks like and what a still graph looks like too; see FrameRunTracker.
export const CHECKSUM_SAMPLES = 4096;

export function frameChecksum(px: ArrayLike<number>): number {
  const n = px.length;
  let h = 0x811c9dc5;
  const mix = (v: number) => {
    h ^= v & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  mix(n);
  mix(n >>> 8);
  mix(n >>> 16);
  mix(n >>> 24);
  if (n <= CHECKSUM_SAMPLES * 4) {
    for (let i = 0; i < n; i++) mix(px[i]);
    return h >>> 0;
  }
  // Whole pixels, so a sample always reads a complete RGBA quad.
  const stride = Math.max(4, Math.floor(n / 4 / CHECKSUM_SAMPLES) * 4);
  for (let i = 0; i + 3 < n; i += stride) {
    mix(px[i]);
    mix(px[i + 1]);
    mix(px[i + 2]);
    mix(px[i + 3]);
  }
  return h >>> 0;
}

// Runs of identical captured frames. A still graph legitimately produces
// one long run, so `suspicious` is phrased as a hint in the UI, never an
// error — but a run covering most of a 240-frame export of an animated
// graph is exactly the freeze this module exists to catch.
export class FrameRunTracker {
  frames = 0;
  distinct = 0;
  longestRun = 0;
  longestRunStart = 0;
  currentRun = 0;
  currentRunStart = 0;
  private last: number | null = null;

  push(checksum: number): void {
    if (this.last === checksum) {
      this.currentRun++;
    } else {
      this.distinct++;
      this.currentRun = 1;
      this.currentRunStart = this.frames;
      this.last = checksum;
    }
    if (this.currentRun > this.longestRun) {
      this.longestRun = this.currentRun;
      this.longestRunStart = this.currentRunStart;
    }
    this.frames++;
  }

  // At least 20 frames captured, and one unchanging picture spans ten or
  // more of them AND at least half the export.
  get suspicious(): boolean {
    return (
      this.frames >= 20 &&
      this.longestRun >= 10 &&
      this.longestRun * 2 >= this.frames
    );
  }

  summary(): {
    frames: number;
    distinctFrames: number;
    longestIdenticalRun: number;
    longestRunStartFrame: number;
  } {
    return {
      frames: this.frames,
      distinctFrames: this.distinct,
      longestIdenticalRun: this.longestRun,
      longestRunStartFrame: this.longestRunStart,
    };
  }
}

// The ffmpeg.wasm worker rejects with plain strings (`e.toString()`), so an
// `err instanceof Error ? err.message : "Export failed"` toast said only
// "Export failed" for every real ffmpeg problem. Normalise before showing.
export function toError(e: unknown, fallback = "Export failed"): Error {
  if (e instanceof Error) return e;
  if (typeof e === "string" && e.trim()) return new Error(e.trim());
  if (
    e &&
    typeof e === "object" &&
    typeof (e as { message?: unknown }).message === "string" &&
    ((e as { message: string }).message as string).trim()
  ) {
    return new Error((e as { message: string }).message);
  }
  return new Error(fallback);
}
