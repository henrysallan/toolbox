// Pure ffmpeg encoder/audio argument builders — the SINGLE source of truth for
// codec / container / ProRes / alpha behavior. Shared by the web ffmpeg.wasm
// path (src/lib/export-ffmpeg.ts) and the Electron native ffmpeg process
// (electron/ffmpeg.js), so the two targets encode byte-identically and this
// finicky logic is maintained in one place.
//
// Plain CommonJS with no DOM/Node APIs: it only maps options → string[], so an
// ESM bundler (renderer) and the Electron main process (require) can both use
// it without a build step. Types live in the sibling .d.ts.
"use strict";

// Audio encoder + args per container. AAC for the mp4 family / mkv, Opus for
// webm. The caller adds `-shortest` to tie output length to the frame-exact
// video when the WAV runs a hair longer.
function buildAudioArgs(container) {
  if (container === "webm") {
    return ["-c:a", "libopus", "-b:a", "192k"];
  }
  return ["-c:a", "aac", "-b:a", "256k"];
}

// Maps the simplified UI codec onto an ffmpeg encoder + arg list.
function buildEncoderArgs(codec, crf, proresProfile, alpha) {
  switch (codec) {
    case "h264":
      // High profile, medium preset. yuv420p for broad compatibility.
      return [
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-preset", "medium",
        "-profile:v", "high",
        "-crf", String(crf),
      ];
    case "h264-lossless":
      // qp=0 is mathematically lossless. yuv444p preserves chroma.
      return [
        "-c:v", "libx264",
        "-pix_fmt", "yuv444p",
        "-preset", "veryslow",
        "-qp", "0",
      ];
    case "h265":
      return [
        "-c:v", "libx265",
        "-pix_fmt", "yuv420p",
        "-preset", "medium",
        "-crf", String(crf),
      ];
    case "prores": {
      // prores_ks; yuv422p10le is the standard 10-bit 4:2:2 format.
      //
      // Alpha lives only in the 4444 / 4444xq profiles (profile >= 4). When
      // requested there we switch to the alpha-bearing 4:4:4 format and pin
      // `-alpha_bits 16` (full-precision straight alpha): without an explicit
      // value some ffmpeg builds resolve alpha_bits to 0 and silently drop the
      // channel even with a yuva pixel format. Opaque 4444 uses plain
      // yuv444p10le; lower profiles stay 4:2:2.
      const wantsAlpha = alpha && proresProfile >= 4;
      const pixFmt = wantsAlpha
        ? "yuva444p10le"
        : proresProfile >= 4
          ? "yuv444p10le"
          : "yuv422p10le";
      return [
        "-c:v", "prores_ks",
        "-profile:v", String(proresProfile),
        "-pix_fmt", pixFmt,
        ...(wantsAlpha ? ["-alpha_bits", "16"] : []),
        "-vendor", "apl0",
      ];
    }
    case "vp9":
      return [
        "-c:v", "libvpx-vp9",
        "-pix_fmt", "yuv420p",
        "-b:v", "0",
        "-crf", String(crf),
        "-row-mt", "1",
      ];
    case "av1":
      // libaom-av1 is slow but ships with mainline ffmpeg. cpu-used 4 is a
      // sane middle-ground; lower = slower/better.
      return [
        "-c:v", "libaom-av1",
        "-pix_fmt", "yuv420p",
        "-crf", String(crf),
        "-b:v", "0",
        "-cpu-used", "4",
        "-row-mt", "1",
      ];
    default:
      throw new Error(`unknown codec: ${codec}`);
  }
}

module.exports = { buildAudioArgs, buildEncoderArgs };
