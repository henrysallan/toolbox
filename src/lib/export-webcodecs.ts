// Tier-2 video export. Drives the pipeline frame-by-frame and feeds each
// rendered canvas into a WebCodecs-backed encoder via mediabunny. Wins
// over the MediaRecorder path:
//   * real (not best-effort) bitrate control
//   * deterministic frame rate — no dropped frames if rendering is slow,
//     since we step the clock manually rather than running real-time
//   * choice of codec (H.264 / H.265 / VP9 / AV1)
//   * H.264 High profile by default (better compression than the
//     MediaRecorder path's avc1.42E01E baseline)
//
// Falls back to throwing if WebCodecs / encoder for the requested codec
// isn't available — caller should catch and offer the MediaRecorder path
// or surface an error.
//
// Frame stepping uses `renderFrame()`, which evaluates the engine
// synchronously and blits to the visible canvas. We then await one
// microtask + capture the bitmap with `createImageBitmap` so the GPU
// has flushed before the encoder reads.

import {
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  WebMOutputFormat,
  Output,
  type VideoCodec,
} from "mediabunny";

export type WebCodecsContainer = "mp4" | "webm";
export type WebCodecsCodec = "avc" | "hevc" | "vp9" | "av1";

export interface WebCodecsExportOptions {
  canvas: HTMLCanvasElement;
  container: WebCodecsContainer;
  codec: WebCodecsCodec;
  bitrateBps: number;
  fps: number;
  durationFrames: number;
  // Called for each frame BEFORE we capture. Should set the timeline
  // clock and synchronously evaluate the graph. Frame index is 0..N-1.
  renderFrame: (frameIndex: number, timeSec: number) => void;
  // Fired once per frame. `label` is the human-readable status (e.g.
  // "Frame 42/240"), `fraction` is 0..1 for progress-bar fill.
  onProgress?: (label: string, fraction: number) => void;
}

// Maps our codec selection to the container's accepted codec strings,
// with a per-container fallback list when the requested codec isn't
// supported by the encoder. Returns null if no candidate is encodable.
async function pickCodec(
  container: WebCodecsContainer,
  preferred: WebCodecsCodec
): Promise<VideoCodec | null> {
  const { getFirstEncodableVideoCodec } = await import("mediabunny");
  // Mediabunny rejects mismatched codec/container pairs, so filter to
  // the legal set per container.
  const allowed: Record<WebCodecsContainer, VideoCodec[]> = {
    mp4: ["avc", "hevc", "av1", "vp9"],
    webm: ["vp9", "av1", "vp8"],
  };
  const order: VideoCodec[] = [
    preferred,
    ...allowed[container].filter((c) => c !== preferred),
  ].filter((c) => allowed[container].includes(c));
  return getFirstEncodableVideoCodec(order);
}

export async function exportVideoWebCodecs(
  opts: WebCodecsExportOptions
): Promise<{ blob: Blob; ext: string }> {
  if (typeof VideoEncoder === "undefined") {
    throw new Error(
      "WebCodecs (VideoEncoder) is not available in this browser. Try Chrome/Edge/Safari, or switch to Fast quality."
    );
  }

  const codec = await pickCodec(opts.container, opts.codec);
  if (!codec) {
    throw new Error(
      `No encodable codec found for ${opts.container}. Try a different container or quality preset.`
    );
  }

  const target = new BufferTarget();
  const format =
    opts.container === "mp4"
      ? new Mp4OutputFormat({ fastStart: "in-memory" })
      : new WebMOutputFormat();
  const output = new Output({ format, target });

  const source = new CanvasSource(opts.canvas, {
    codec,
    bitrate: Math.max(100_000, Math.round(opts.bitrateBps)),
    // 2-second GOP keeps editor scrubbing tolerable without wasting
    // bitrate on key-frame churn.
    keyFrameInterval: 2,
  });
  output.addVideoTrack(source, { frameRate: opts.fps });

  await output.start();

  const frameDuration = 1 / opts.fps;
  const startMs = performance.now();
  for (let i = 0; i < opts.durationFrames; i++) {
    const t = i / opts.fps;
    opts.renderFrame(i, t);
    // Yield once so the browser can flush the GL commands before the
    // encoder samples the canvas. Without this we'd capture the
    // previous frame's pixels under heavy graphs.
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    await source.add(t, frameDuration);
    if (opts.onProgress) {
      const done = i + 1;
      const elapsedSec = (performance.now() - startMs) / 1000;
      // Estimate remaining time from average per-frame cost so far.
      // Skips the first 4 frames where the encoder warms up.
      const eta =
        done > 4
          ? ((elapsedSec / done) * (opts.durationFrames - done))
          : null;
      const etaTxt = eta != null ? ` · ${formatEta(eta)} left` : "";
      opts.onProgress(
        `Frame ${done}/${opts.durationFrames}${etaTxt}`,
        done / opts.durationFrames
      );
    }
  }

  if (opts.onProgress) opts.onProgress("Finalizing…", 1);
  await output.finalize();
  const buffer = target.buffer;
  if (!buffer) throw new Error("Encoder produced no output");
  const mime =
    opts.container === "mp4" ? "video/mp4" : "video/webm";
  return {
    blob: new Blob([buffer], { type: mime }),
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
