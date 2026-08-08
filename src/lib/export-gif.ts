// Animated GIF export. Two stages:
//   1. ffmpeg.wasm builds the base GIF from captured frames using a
//      palettegen/paletteuse pass — this owns color quantization (palette
//      size), dithering, and 1-bit transparency. Reuses the same ffmpeg
//      singleton as the "max" video tier (export-ffmpeg.ts), so GIF and
//      max-video share one core download.
//   2. gifsicle-wasm runs a lossy-LZW optimization pass (`--lossy=N -O3`)
//      when the user dials Lossy above 0 — the GIF analogue of a
//      compression slider. ffmpeg's gif encoder can't do lossy, hence the
//      second engine. gifsicle runs on the main thread, no SharedArrayBuffer
//      / COOP-COEP needed (same constraint the ffmpeg ST core lives under).
//
// See specdocs/archive/061826_gif-export-and-image-sequence.md.

import type { FFmpeg } from "@ffmpeg/ffmpeg";
import gifsicle from "gifsicle-wasm-browser";
import { canvasToPngBytes, getFfmpeg } from "./export-ffmpeg";

// The ffmpeg singleton is shared across the whole session and its MEMFS
// PERSISTS across exec() calls (the worker only resets the encoder between
// runs, not the filesystem). So a previous GIF export's frames + output
// linger and break the next run — stale frames bleed into a shorter export,
// or ffmpeg refuses to overwrite an existing out.gif. Clear our scratch files
// defensively before and after each export so every run starts clean.
async function cleanupGifFs(ffmpeg: FFmpeg): Promise<void> {
  try {
    const entries = await ffmpeg.listDir("/");
    for (const e of entries) {
      if (e.isDir) continue;
      if (
        e.name.startsWith("gframe_") ||
        e.name === "out.gif" ||
        e.name === "palette.png"
      ) {
        try {
          await ffmpeg.deleteFile(e.name);
        } catch {
          // Already gone / locked — ignore.
        }
      }
    }
  } catch {
    // listDir unavailable — nothing safe to do; the per-run -y still helps.
  }
}

export type GifDither = "none" | "bayer" | "floyd";

export interface GifExportOptions {
  canvas: HTMLCanvasElement;
  fps: number;
  durationFrames: number;
  // 2..256 — GIF palette size (color-quantization level).
  colors: number;
  dither: GifDither;
  // 0 = lossless LZW; higher = smaller file with more color error.
  lossy: number;
  // When true, source alpha below the threshold becomes GIF transparency;
  // otherwise frames are flattened onto black (fully opaque GIF).
  transparent: boolean;
  renderFrame: (frameIndex: number, timeSec: number) => void | Promise<void>;
  onProgress?: (label: string, fraction: number) => void;
}

// paletteuse dither token per UI choice. floyd_steinberg = error diffusion
// (smoothest, largest); bayer = ordered (cheap, structured); none = flat.
function ditherToken(d: GifDither): string {
  switch (d) {
    case "none":
      return "none";
    case "bayer":
      return "bayer:bayer_scale=3";
    case "floyd":
      return "floyd_steinberg";
  }
}

// Build the single-pass filter graph. palettegen + paletteuse via `split` so
// we never write an intermediate palette file. Transparency on: reserve a
// palette slot and key pixels below alpha 128. Off: flatten onto opaque black
// with `format`, which alpha-composites against the default black background
// (robust — no separate color/overlay input, which is timebase-fragile).
function buildFilter(
  colors: number,
  dither: GifDither,
  transparent: boolean
): string {
  const c = Math.max(2, Math.min(256, Math.round(colors)));
  const d = ditherToken(dither);
  if (transparent) {
    return (
      `[0:v]split[a][b];` +
      `[a]palettegen=max_colors=${c}:reserve_transparent=1[p];` +
      `[b][p]paletteuse=dither=${d}:alpha_threshold=128`
    );
  }
  return (
    `[0:v]format=rgba,format=rgb24,split[a][b];` +
    `[a]palettegen=max_colors=${c}:reserve_transparent=0[p];` +
    `[b][p]paletteuse=dither=${d}`
  );
}

// Sanity check a GIF byte buffer: header + trailer + non-trivial size. ffmpeg
// or gifsicle can "succeed" yet emit a truncated/empty file (e.g. a fragile
// filtergraph that produced zero frames) — better to surface that as an error
// than to hand the user a file that won't open.
function isLikelyValidGif(bytes: Uint8Array): boolean {
  if (bytes.length < 64) return false;
  if (bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46) return false; // "GIF"
  return bytes[bytes.length - 1] === 0x3b; // GIF trailer ';'
}

export async function exportGif(
  opts: GifExportOptions
): Promise<{ blob: Blob; ext: string }> {
  const ffmpeg = await getFfmpeg(opts.onProgress);
  // Self-correcting: clear any leftovers from a prior (possibly crashed)
  // export so this run can't trip over stale frames or an existing out.gif.
  await cleanupGifFs(ffmpeg);

  // Capture (0.5), ffmpeg encode (0.4), gifsicle (0.1) — rough weighting so
  // the progress bar advances sensibly across the three phases (gifsicle now
  // always runs — see the normalize note below).
  const CAPTURE_SHARE = 0.5;
  const ENCODE_SHARE = 0.4;

  const captureStart = performance.now();
  for (let i = 0; i < opts.durationFrames; i++) {
    const t = i / opts.fps;
    await opts.renderFrame(i, t);
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    const png = await canvasToPngBytes(opts.canvas);
    const name = `gframe_${String(i).padStart(6, "0")}.png`;
    await ffmpeg.writeFile(name, png);
    if (opts.onProgress) {
      const done = i + 1;
      const elapsed = (performance.now() - captureStart) / 1000;
      const eta = done > 4 ? (elapsed / done) * (opts.durationFrames - done) : null;
      opts.onProgress(
        `Capturing ${done}/${opts.durationFrames}${
          eta != null ? ` · ${formatEta(eta)} left` : ""
        }`,
        (done / opts.durationFrames) * CAPTURE_SHARE
      );
    }
  }

  const filter = buildFilter(opts.colors, opts.dither, opts.transparent);

  if (opts.onProgress) opts.onProgress("Building palette…", CAPTURE_SHARE);

  const args = [
    // -y: overwrite out.gif without the interactive "[y/N]" prompt (there's
    // no stdin in the worker, so the prompt would otherwise wedge the run).
    "-y",
    "-framerate", String(opts.fps),
    "-i", "gframe_%06d.png",
    "-filter_complex", filter,
    "-r", String(opts.fps),
    "out.gif",
  ];

  const encodeStart = performance.now();
  const progressHandler = (e: { progress: number }) => {
    if (!opts.onProgress) return;
    const frac = Math.max(0, Math.min(1, e.progress));
    const elapsed = (performance.now() - encodeStart) / 1000;
    const eta = frac > 0.05 && elapsed > 1 ? (elapsed * (1 - frac)) / frac : null;
    opts.onProgress(
      `Encoding GIF${eta != null ? ` · ${formatEta(eta)} left` : ""}`,
      CAPTURE_SHARE + frac * ENCODE_SHARE
    );
  };
  ffmpeg.on("progress", progressHandler);
  try {
    await ffmpeg.exec(args);
  } finally {
    ffmpeg.off("progress", progressHandler);
  }

  const data = await ffmpeg.readFile("out.gif");
  const baseBytes =
    data instanceof Uint8Array ? data : new TextEncoder().encode(data as string);

  // Clear our scratch files now too (the next run also pre-cleans, but this
  // keeps the FS small between exports). out.gif is already read into bytes.
  await cleanupGifFs(ffmpeg);

  // Copy into a fresh ArrayBuffer-backed view (a SharedArrayBuffer-backed
  // Uint8Array isn't a valid BlobPart).
  const baseCopy = new Uint8Array(baseBytes.byteLength);
  baseCopy.set(baseBytes);

  console.log(
    `[gif] frames=${opts.durationFrames} ${opts.canvas.width}x${opts.canvas.height} ` +
      `base=${baseCopy.byteLength}B colors=${opts.colors} dither=${opts.dither} ` +
      `transparent=${opts.transparent} lossy=${opts.lossy}`
  );

  // ffmpeg returned success but the bytes aren't a valid GIF — fail loudly
  // (a clear toast) instead of downloading a file that won't open.
  if (!isLikelyValidGif(baseCopy)) {
    throw new Error(
      `GIF encode produced an invalid file (${baseCopy.byteLength} bytes). ` +
        `Try toggling Transparency or lowering Colors on this Output.`
    );
  }

  // ALWAYS normalize through gifsicle, even at lossy=0 — beyond shrinking the
  // file it rewrites the GIF into a structure macOS Preview / Quick Look will
  // open (raw ffmpeg palettegen GIFs render in browsers but Preview rejects
  // them). The command differs by transparency:
  //   • opaque  → -O3 (small; opaque animated GIFs open in Preview fine).
  //   • transp. → --unoptimize --disposal=background. Inter-frame transparency
  //     + "leave previous" disposal is exactly what macOS ImageIO chokes on,
  //     so expand every frame to a self-contained full frame and restore the
  //     canvas to (transparent) background between frames. Larger, but Preview
  //     opens it; sparse content (subject on transparent bg) still compresses
  //     well via LZW.
  // `--lossy` (when > 0) composes with either.
  if (opts.onProgress) {
    opts.onProgress(
      opts.lossy > 0 ? "Compressing (lossy)…" : "Finalizing…",
      CAPTURE_SHARE + ENCODE_SHARE
    );
  }
  const baseGif = () => ({
    blob: new Blob([baseCopy.buffer], { type: "image/gif" }) as Blob,
    ext: "gif",
  });
  const lossyArg =
    opts.lossy > 0
      ? ` --lossy=${Math.max(1, Math.min(200, Math.round(opts.lossy)))}`
      : "";
  const normalizeArgs = opts.transparent
    ? `--unoptimize --disposal=background${lossyArg}`
    : `-O3${lossyArg}`;
  let file: File | undefined;
  try {
    const out = await gifsicle.run({
      input: [
        { file: new Blob([baseCopy.buffer], { type: "image/gif" }), name: "in.gif" },
      ],
      command: [`${normalizeArgs} in.gif -o /out/out.gif`],
    });
    file = out?.[0];
  } catch (e) {
    console.warn("[gif] gifsicle pass failed; using raw ffmpeg gif:", e);
    return baseGif();
  }
  if (!file) {
    console.warn("[gif] gifsicle returned no file; using raw ffmpeg gif.");
    return baseGif();
  }
  const buf = await file.arrayBuffer();
  const outBytes = new Uint8Array(buf);
  if (!isLikelyValidGif(outBytes)) {
    console.warn(
      `[gif] gifsicle output invalid (${outBytes.byteLength}B); using raw ffmpeg gif.`
    );
    return baseGif();
  }
  console.log(`[gif] gifsicle ${normalizeArgs} → ${outBytes.byteLength}B`);
  if (opts.onProgress) opts.onProgress("Done", 1);
  return { blob: new Blob([buf], { type: "image/gif" }), ext: "gif" };
}

function formatEta(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "?";
  if (sec < 60) return `${Math.ceil(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.ceil(sec - m * 60);
  return `${m}m${s.toString().padStart(2, "0")}s`;
}
