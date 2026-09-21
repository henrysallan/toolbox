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
//
// Limits worth knowing (measured 2026-09-18 against the exact core):
// @ffmpeg/core 0.12.10 is ffmpeg 5.1 built without asm and with a hard
// 2 GiB heap, and has no libaom. `h264-lossless` at 4000² with preset
// veryslow runs out of that heap after ~8 frames; ffmpeg then exits 1 and
// leaves a truncated out.mp4 behind. This file now checks the exit code
// and quotes ffmpeg's log instead of delivering that file.
//
// Frames come from the caller's `capturePng` — a direct GPU readback of the
// terminal texture (lib/export-capture.ts), never the on-screen canvas.

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";
// Encoder + audio args: single source of truth shared with the Electron native
// ffmpeg process (electron/ffmpeg.js).
import { buildAudioArgs, buildEncoderArgs } from "./export-ffmpeg-args";
import { frameChecksum, toError, type ExportProgress } from "./export-capture";
import type { ExportLog } from "./export-log";

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
    try {
      const [coreURL, wasmURL] = await Promise.all([
        toBlobURL(`${FFMPEG_BASE}/ffmpeg-core.js`, "text/javascript"),
        toBlobURL(`${FFMPEG_BASE}/ffmpeg-core.wasm`, "application/wasm"),
      ]);
      if (onProgress) onProgress("Initializing ffmpeg…", 0);
      await ff.load({ coreURL, wasmURL });
    } catch (e) {
      // A failed download must not poison every later export.
      loadPromise = null;
      throw toError(e, "ffmpeg.wasm failed to load");
    }
    ffmpegSingleton = ff;
    return ff;
  })();
  return loadPromise;
}

// Drop the shared core so the next export reloads a fresh one. Used after a
// wasm-level abort, which leaves the module unusable but the singleton alive
// — previously every export for the rest of the session failed.
export function resetFfmpeg(): void {
  try {
    ffmpegSingleton?.terminate();
  } catch {
    // already gone
  }
  ffmpegSingleton = null;
  loadPromise = null;
}

// A wasm abort surfaces as "Aborted(...)" / RuntimeError / out-of-bounds
// text; a plain non-zero ffmpeg exit does not, and the core stays usable.
function isFatalCoreError(e: Error): boolean {
  return /Aborted|RuntimeError|out of bounds|unreachable|Cannot enlarge|OOM/i.test(
    e.message
  );
}

function tailOf(lines: string[], n: number): string {
  return lines.slice(-n).join("\n");
}

/**
 * Run one ffmpeg command on the shared core. Mirrors ffmpeg's own log to
 * the export log at debug level, turns a non-zero exit into an Error that
 * quotes the log tail (the old code never looked at the code, and a later
 * `readFile` "succeeded" on a truncated output), and normalises the
 * worker's string rejections into real Errors.
 */
export async function runFfmpeg(
  ffmpeg: FFmpeg,
  args: string[],
  opts: {
    label: string;
    log?: ExportLog;
    onProgress?: (e: { progress: number; time: number }) => void;
  }
): Promise<void> {
  const lines: string[] = [];
  const onLog = ({ message }: { type: string; message: string }) => {
    lines.push(message);
    if (lines.length > 300) lines.shift();
    opts.log?.debug(`[ffmpeg.wasm] ${message}`);
  };
  ffmpeg.on("log", onLog);
  if (opts.onProgress) ffmpeg.on("progress", opts.onProgress);
  let code: number;
  const t0 = performance.now();
  try {
    opts.log?.info(`${opts.label}: ffmpeg ${args.join(" ")}`);
    code = await ffmpeg.exec(args);
  } catch (e) {
    const err = toError(e, "ffmpeg.wasm failed");
    if (isFatalCoreError(err)) {
      opts.log?.error(
        "ffmpeg.wasm core aborted — dropping the instance so the next export reloads it"
      );
      resetFfmpeg();
    }
    throw new Error(`${opts.label}: ${err.message}\n${tailOf(lines, 20)}`);
  } finally {
    ffmpeg.off("log", onLog);
    if (opts.onProgress) ffmpeg.off("progress", opts.onProgress);
  }
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  if (code !== 0) {
    opts.log?.error(`${opts.label}: ffmpeg exited with code ${code} after ${secs}s`);
    throw new Error(
      `${opts.label}: ffmpeg exited with code ${code}\n${tailOf(lines, 20)}`
    );
  }
  opts.log?.info(`${opts.label}: ffmpeg finished in ${secs}s`);
}

export type FfmpegCodec =
  | "h264"
  | "h264-lossless"
  | "h265"
  | "prores"
  | "qtrle"
  | "vp9"
  | "av1";

export type FfmpegContainer = "mp4" | "mov" | "webm" | "mkv";

export interface FfmpegExportOptions {
  // PNG bytes of the frame `renderFrame` just produced — a direct GPU
  // readback (export-capture.ts), so what the encoder gets is what the
  // graph rendered, whatever the on-screen canvas is doing.
  capturePng: () => Promise<Uint8Array>;
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
  // Two phases: `capture` while frames are rendered into the wasm FS,
  // `encode` while ffmpeg runs. Each phase's fraction is its own 0..1.
  onProgress?: ExportProgress;
  // Optional 16-bit PCM WAV bytes covering the export window. When present
  // it's written into the wasm FS and muxed as a second input.
  audioWav?: Uint8Array | null;
  // Export log: settings, per-frame timings + checksums, ffmpeg's output.
  log?: ExportLog;
}

export async function exportVideoFfmpeg(
  opts: FfmpegExportOptions
): Promise<{ blob: Blob; ext: string }> {
  const log = opts.log;
  const ffmpeg = await getFfmpeg(opts.onProgress);

  const outputName = `out.${opts.container}`;
  const hasAudio = !!opts.audioWav && opts.audioWav.byteLength > 0;
  const written: string[] = [];

  try {
    // Capture phase — write each frame as PNG into the wasm FS. Names
    // are zero-padded so ffmpeg's image2 demuxer reads them in order.
    const captureStart = performance.now();
    let pngBytes = 0;
    for (let i = 0; i < opts.durationFrames; i++) {
      const t = i / opts.fps;
      const tRender = performance.now();
      await opts.renderFrame(i, t);
      const tCapture = performance.now();
      const png = await opts.capturePng();
      const tWrite = performance.now();
      const name = `frame_${String(i).padStart(6, "0")}.png`;
      await ffmpeg.writeFile(name, png);
      written.push(name);
      pngBytes += png.byteLength;
      // Identical PNGs mean identical pixels (deterministic encoder), so the
      // checksum doubles as the frozen-capture detector here too.
      log?.frame(
        i,
        opts.durationFrames,
        {
          render: tCapture - tRender,
          capture: tWrite - tCapture,
          write: performance.now() - tWrite,
        },
        frameChecksum(png),
        png.byteLength
      );
      if (opts.onProgress) {
        const done = i + 1;
        const elapsedSec = (performance.now() - captureStart) / 1000;
        const eta =
          done > 4
            ? (elapsedSec / done) * (opts.durationFrames - done)
            : null;
        const etaTxt = eta != null ? ` · ${formatEta(eta)} left` : "";
        opts.onProgress(
          `Rendering ${done}/${opts.durationFrames}${etaTxt}`,
          done / opts.durationFrames,
          "capture"
        );
      }
    }
    log?.info(
      `captured ${opts.durationFrames} PNG frames (${(pngBytes / 1048576).toFixed(
        1
      )} MiB) in ${((performance.now() - captureStart) / 1000).toFixed(1)}s`
    );

    // Audio input — write the WAV into the FS so ffmpeg can mux it.
    if (hasAudio) {
      await ffmpeg.writeFile("audio.wav", opts.audioWav!);
      written.push("audio.wav");
      log?.info(`audio: ${opts.audioWav!.byteLength} bytes WAV muxed as second input`);
    }

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
        frac,
        "encode"
      );
    };
    written.push(outputName);
    opts.onProgress?.(`Encoding 0/${opts.durationFrames}`, 0, "encode");
    await runFfmpeg(ffmpeg, args, { label: "encode", log, onProgress: progressHandler });
    opts.onProgress?.("Finalizing…", 1, "encode");

    let data: Uint8Array | string;
    try {
      data = await ffmpeg.readFile(outputName);
    } catch (e) {
      throw new Error(
        `reading ${outputName} back from ffmpeg.wasm failed: ${toError(e).message}`
      );
    }
    const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data as string);
    if (bytes.byteLength === 0) {
      throw new Error(`ffmpeg produced an empty ${outputName}`);
    }
    log?.info(`encoded ${outputName}: ${(bytes.byteLength / 1048576).toFixed(1)} MiB`);

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
  } finally {
    // Best-effort cleanup, on failure too: a failed run used to leave every
    // frame behind in the wasm FS. The singleton survives the export, so
    // even if this fails the next export overwrites the same names.
    for (const name of written) {
      try {
        await ffmpeg.deleteFile(name);
      } catch {
        // missing or the core is gone — nothing to free
      }
    }
  }
}

function formatEta(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "?";
  if (sec < 60) return `${Math.ceil(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.ceil(sec - m * 60);
  return `${m}m${s.toString().padStart(2, "0")}s`;
}
