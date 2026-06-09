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
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  WebMOutputFormat,
  Output,
  type AudioCodec,
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
  // Optional audio track to mux alongside the video (already rendered to
  // cover the full export window). Skipped when null or when no audio
  // codec is encodable for the container.
  audioBuffer?: AudioBuffer | null;
  // Called for each frame BEFORE we capture. Sets the timeline clock and
  // evaluates the graph. May be async (e.g. to await video seeks settling
  // for a deterministic frame); the loop awaits it. Frame index is 0..N-1.
  renderFrame: (frameIndex: number, timeSec: number) => void | Promise<void>;
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

// First encodable audio codec legal for the container. mp4 muxes AAC
// (Opus as a fallback); webm is Opus/Vorbis. Returns null when the browser
// can't encode any of them.
async function pickAudioCodec(
  container: WebCodecsContainer,
  numberOfChannels: number,
  sampleRate: number
): Promise<AudioCodec | null> {
  const { getFirstEncodableAudioCodec } = await import("mediabunny");
  const allowed: AudioCodec[] =
    container === "mp4" ? ["aac", "opus"] : ["opus", "vorbis"];
  return getFirstEncodableAudioCodec(allowed, {
    numberOfChannels,
    sampleRate,
  });
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

  // Audio track (optional). Must be added before output.start(); the
  // samples themselves are encoded after the video loop. If no audio codec
  // is encodable for this container we silently skip — the video still
  // exports rather than failing the whole render.
  let audioSource: AudioBufferSource | null = null;
  if (opts.audioBuffer) {
    const audioCodec = await pickAudioCodec(
      opts.container,
      opts.audioBuffer.numberOfChannels,
      opts.audioBuffer.sampleRate
    );
    if (audioCodec) {
      audioSource = new AudioBufferSource({ codec: audioCodec, bitrate: 192_000 });
      output.addAudioTrack(audioSource);
    }
  }

  await output.start();

  const frameDuration = 1 / opts.fps;
  const startMs = performance.now();
  for (let i = 0; i < opts.durationFrames; i++) {
    const t = i / opts.fps;
    await opts.renderFrame(i, t);
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

  // Encode the whole audio buffer in one shot (mediabunny streams it into
  // the muxer). Done after the frames so the video track's timeline is
  // already established.
  if (audioSource && opts.audioBuffer) {
    if (opts.onProgress) opts.onProgress("Encoding audio…", 1);
    await audioSource.add(opts.audioBuffer);
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
