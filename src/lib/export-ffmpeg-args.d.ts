// Types for the shared (CommonJS) encoder-arg builders in export-ffmpeg-args.js.
// The renderer imports the .js for runtime and these declarations for types;
// the .js file itself is never type-checked.

export type FfmpegCodec =
  | "h264"
  | "h264-lossless"
  | "h265"
  | "prores"
  | "qtrle"
  | "vp9"
  | "av1";

export type FfmpegContainer = "mp4" | "mov" | "webm" | "mkv";

export function buildAudioArgs(container: FfmpegContainer): string[];

export function buildEncoderArgs(
  codec: FfmpegCodec,
  crf: number,
  proresProfile: number,
  alpha: boolean
): string[];
