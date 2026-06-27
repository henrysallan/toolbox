// Tier-3 video export. Captures every frame as PNG and pipes them
// through ffmpeg.wasm. Slowest option (PNG encode + WASM transcode in
// the main thread), but supports codecs the browser doesn't ship with —
// notably ProRes, H.265 with CRF tuning, and lossless H.264.
//
// Single-threaded core. Multi-threaded ffmpeg.wasm needs SharedArrayBuffer,
// which needs Cross-Origin-Opener-Policy + Cross-Origin-Embedder-Policy
// headers. Toolbox doesn't set those today, so we deliberately stay on
// the ST core to avoid silent failures. Speed is fine for short
// renders; if users push past 30s of 4K we'll need to add the headers
// and switch to `core-mt`.
//
// The ffmpeg-core blobs are loaded once per session from unpkg and
// cached as object URLs; subsequent exports skip the download.

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";
// Encoder + audio args: single source of truth shared with the Electron native
// ffmpeg process (electron/ffmpeg.js).
import { buildAudioArgs, buildEncoderArgs } from "./export-ffmpeg-args";

const FFMPEG_CORE_VERSION = "0.12.10";
// UMD build, NOT ESM. The ESM build uses relative import() statements
// (e.g. `import("./ffmpeg-core.wasm")`) that fail when the script is
// loaded from a `blob:` URL — blob URLs have no base for relative
// resolution. UMD ships a self-contained classic script that works.
const FFMPEG_BASE = `https://unpkg.com/@ffmpeg/core@${FFMPEG_CORE_VERSION}/dist/umd`;

let ffmpegSingleton: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;

// Exported so sibling exporters (GIF) can reuse the one loaded ffmpeg
// singleton instead of paying a second core download.
export async function getFfmpeg(
  onProgress?: (label: string, fraction: number) => void
): Promise<FFmpeg> {
  if (ffmpegSingleton) return ffmpegSingleton;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const ff = new FFmpeg();
    if (onProgress) onProgress("Loading ffmpeg core…", 0);
    const [coreURL, wasmURL] = await Promise.all([
      toBlobURL(`${FFMPEG_BASE}/ffmpeg-core.js`, "text/javascript"),
      toBlobURL(`${FFMPEG_BASE}/ffmpeg-core.wasm`, "application/wasm"),
    ]);
    if (onProgress) onProgress("Initializing ffmpeg…", 0);
    await ff.load({ coreURL, wasmURL });
    ffmpegSingleton = ff;
    return ff;
  })();
  return loadPromise;
}

export type FfmpegCodec =
  | "h264"
  | "h264-lossless"
  | "h265"
  | "prores"
  | "vp9"
  | "av1";

export type FfmpegContainer = "mp4" | "mov" | "webm" | "mkv";

export interface FfmpegExportOptions {
  canvas: HTMLCanvasElement;
  container: FfmpegContainer;
  codec: FfmpegCodec;
  // CRF is the quality knob for x264/x265/vp9/av1. 0 = lossless,
  // 18 ≈ visually lossless, 23 = default, 51 = worst. Ignored for
  // ProRes (which uses a discrete profile instead).
  crf: number;
  // Profile selector for ProRes. 0=proxy, 1=lt, 2=standard, 3=hq,
  // 4=4444, 5=4444xq.
  proresProfile: number;
  // Encode an alpha channel. Only honored for ProRes 4444 / 4444xq
  // (profile >= 4) — the only codec/profile in this tier that carries
  // transparency. Ignored otherwise.
  alpha?: boolean;
  fps: number;
  durationFrames: number;
  renderFrame: (frameIndex: number, timeSec: number) => void | Promise<void>;
  onProgress?: (label: string, fraction: number) => void;
  // Optional 16-bit PCM WAV bytes covering the export window. When present
  // it's written into the wasm FS and muxed as a second input.
  audioWav?: Uint8Array | null;
}

export function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) {
        reject(new Error("canvas.toBlob returned null"));
        return;
      }
      const buf = await blob.arrayBuffer();
      resolve(new Uint8Array(buf));
    }, "image/png");
  });
}

export async function exportVideoFfmpeg(
  opts: FfmpegExportOptions
): Promise<{ blob: Blob; ext: string }> {
  const ffmpeg = await getFfmpeg(opts.onProgress);

  const FRAME_SHARE = 0.6;
  const ENCODE_SHARE = 0.4;

  // Capture phase — write each frame as PNG into the wasm FS. Names
  // are zero-padded so ffmpeg's image2 demuxer reads them in order.
  const captureStart = performance.now();
  for (let i = 0; i < opts.durationFrames; i++) {
    const t = i / opts.fps;
    await opts.renderFrame(i, t);
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    const png = await canvasToPngBytes(opts.canvas);
    const name = `frame_${String(i).padStart(6, "0")}.png`;
    await ffmpeg.writeFile(name, png);
    if (opts.onProgress) {
      const done = i + 1;
      const elapsedSec = (performance.now() - captureStart) / 1000;
      const eta =
        done > 4
          ? (elapsedSec / done) * (opts.durationFrames - done)
          : null;
      const etaTxt = eta != null ? ` · ${formatEta(eta)} left` : "";
      opts.onProgress(
        `Capturing ${done}/${opts.durationFrames}${etaTxt}`,
        (done / opts.durationFrames) * FRAME_SHARE
      );
    }
  }

  // Audio input — write the WAV into the FS so ffmpeg can mux it.
  const hasAudio = !!opts.audioWav && opts.audioWav.byteLength > 0;
  if (hasAudio) {
    await ffmpeg.writeFile("audio.wav", opts.audioWav!);
  }

  const outputName = `out.${opts.container}`;
  const args = [
    "-framerate", String(opts.fps),
    "-i", "frame_%06d.png",
    ...(hasAudio ? ["-i", "audio.wav"] : []),
    ...buildEncoderArgs(opts.codec, opts.crf, opts.proresProfile, opts.alpha ?? false),
    ...(hasAudio ? buildAudioArgs(opts.container) : []),
    ...(hasAudio ? ["-shortest"] : []),
    "-r", String(opts.fps),
    outputName,
  ];

  // ffmpeg's progress callback fires as a 0..1 fraction plus `time` in
  // microseconds of the output media position. Convert that to a frame
  // count so the user sees the same kind of feedback as the capture
  // phase.
  const encodeStart = performance.now();
  const progressHandler = (e: { progress: number; time: number }) => {
    if (!opts.onProgress) return;
    const frac = Math.max(0, Math.min(1, e.progress));
    const frame = Math.min(
      opts.durationFrames,
      Math.max(0, Math.round((e.time / 1_000_000) * opts.fps))
    );
    const elapsedSec = (performance.now() - encodeStart) / 1000;
    // ffmpeg's progress can flicker early on; only show ETA after we
    // have a stable rate.
    const eta =
      frac > 0.05 && elapsedSec > 1
        ? elapsedSec * (1 - frac) / frac
        : null;
    const etaTxt = eta != null ? ` · ${formatEta(eta)} left` : "";
    opts.onProgress(
      `Encoding ${frame}/${opts.durationFrames}${etaTxt}`,
      FRAME_SHARE + frac * ENCODE_SHARE
    );
  };
  ffmpeg.on("progress", progressHandler);
  try {
    await ffmpeg.exec(args);
  } finally {
    ffmpeg.off("progress", progressHandler);
  }

  const data = await ffmpeg.readFile(outputName);
  const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data as string);

  // Best-effort cleanup so we don't leak frames into the next export.
  try {
    await ffmpeg.deleteFile(outputName);
    if (hasAudio) await ffmpeg.deleteFile("audio.wav");
    for (let i = 0; i < opts.durationFrames; i++) {
      await ffmpeg.deleteFile(`frame_${String(i).padStart(6, "0")}.png`);
    }
  } catch {
    // FS cleanup is best-effort — the singleton survives the export, so
    // even if this fails the next export will overwrite the same names.
  }

  const mime =
    opts.container === "mp4"
      ? "video/mp4"
      : opts.container === "mov"
        ? "video/quicktime"
        : opts.container === "webm"
          ? "video/webm"
          : "video/x-matroska";

  // Hand the decoded bytes to Blob WITHOUT the full-size copy the old code
  // made. readFile is typed Uint8Array<ArrayBufferLike>, which BlobPart
  // rejects because ArrayBufferLike includes SharedArrayBuffer — that type
  // (not any real need) is why the previous version copied into a second
  // buffer. On our single-threaded core (see top of file) the backing store
  // is always a regular ArrayBuffer, so narrow to it and pass a zero-copy
  // view; only the multi-threaded core would hand back a SAB, where we do
  // copy out. The old unconditional copy doubled peak memory at the tail of
  // the export and is exactly the kind of allocation that throws "Array
  // buffer allocation failed" on a multi-GB ProRes render.
  const buffer = bytes.buffer;
  const part: BlobPart =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer, bytes.byteOffset, bytes.byteLength)
      : new Uint8Array(bytes); // SAB (MT core only) → copy into a plain buffer
  return {
    blob: new Blob([part], { type: mime }),
    ext: opts.container,
  };
}

function formatEta(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "?";
  if (sec < 60) return `${Math.ceil(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.ceil(sec - m * 60);
  return `${m}m${s.toString().padStart(2, "0")}s`;
}
