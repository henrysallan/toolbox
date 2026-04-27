import type { NodeDefinition } from "@/engine/types";

export const outputNode: NodeDefinition = {
  type: "output",
  name: "Output",
  category: "output",
  description:
    "Terminal node. Its input image is rendered to the visible canvas by the engine.",
  backend: "webgl2",
  terminal: true,
  // Audio is optional — the visual pipeline doesn't depend on it, and
  // requiring it would force users into a specific graph shape. Audio
  // Source handles play/pause itself via ctx.playing; Output just needs
  // the node to be "needed" so it evaluates.
  inputs: [
    { name: "image", type: "image", required: true },
    { name: "audio", type: "audio", required: false },
  ],
  params: [
    {
      name: "filename",
      label: "Filename",
      type: "string",
      default: "",
      placeholder: "auto (timestamp)",
    },
    {
      name: "imageFormat",
      label: "Image format",
      type: "enum",
      options: ["png", "jpeg", "webp"],
      default: "png",
    },
    {
      name: "imageQuality",
      label: "Quality",
      type: "scalar",
      min: 0.1,
      max: 1,
      step: 0.01,
      default: 0.92,
      visibleIf: (p) =>
        p.imageFormat === "jpeg" || p.imageFormat === "webp",
    },
    // ----- video --------------------------------------------------------
    // Three quality tiers:
    //   fast — MediaRecorder. Real-time capture, ~25 Mbps cap, every browser.
    //   high — WebCodecs offline. True bitrate, frame-stepped, no drops.
    //   max  — ffmpeg.wasm. ProRes/H.265/lossless, slowest but best quality.
    {
      name: "videoQuality",
      label: "Quality preset",
      type: "enum",
      options: ["fast", "high", "max"],
      default: "high",
    },
    {
      name: "videoFormat",
      label: "Container",
      type: "enum",
      // Container choices depend on the encoder. mediabunny only writes
      // mp4/webm; ffmpeg writes mov/mkv too. We expose the union and
      // validate at export time — anything illegal falls back gracefully.
      options: ["mp4", "webm", "mov", "mkv"],
      default: "mp4",
    },
    {
      name: "videoCodec",
      label: "Codec",
      type: "enum",
      // Per-quality codec menus would need a dependent enum; flatten
      // and validate at export time instead.
      //   fast: not used (MediaRecorder picks)
      //   high: avc, hevc, vp9, av1
      //   max:  h264, h264-lossless, h265, prores, vp9, av1
      options: [
        "avc",
        "hevc",
        "vp9",
        "av1",
        "h264",
        "h264-lossless",
        "h265",
        "prores",
      ],
      default: "avc",
      visibleIf: (p) => p.videoQuality !== "fast",
    },
    {
      name: "videoFrames",
      label: "Duration (frames)",
      type: "scalar",
      min: 1,
      max: 12000,
      step: 1,
      default: 240,
    },
    {
      name: "videoFps",
      label: "Output FPS",
      type: "scalar",
      min: 1,
      max: 120,
      step: 1,
      default: 60,
      // Fast mode is locked to the page's render fps because
      // MediaRecorder reads the live stream. High/Max step the clock
      // manually so they get a real, independent fps.
      visibleIf: (p) => p.videoQuality !== "fast",
    },
    {
      name: "videoBitrateMbps",
      label: "Bitrate (Mbps)",
      type: "scalar",
      min: 0.5,
      max: 200,
      step: 0.5,
      default: 16,
      visibleIf: (p) => p.videoQuality !== "max",
    },
    {
      name: "videoCrf",
      label: "Quality (CRF)",
      type: "scalar",
      // 0 = lossless, 18 = visually lossless, 23 = default, 28 = small.
      // Lower = better quality, larger file.
      min: 0,
      max: 51,
      step: 1,
      default: 18,
      visibleIf: (p) =>
        p.videoQuality === "max" &&
        p.videoCodec !== "prores" &&
        p.videoCodec !== "h264-lossless",
    },
    {
      name: "videoProresProfile",
      label: "ProRes profile",
      type: "enum",
      // proxy / lt / standard / hq / 4444 / 4444xq
      options: ["proxy", "lt", "standard", "hq", "4444", "4444xq"],
      default: "hq",
      visibleIf: (p) =>
        p.videoQuality === "max" && p.videoCodec === "prores",
    },
  ],
  primaryOutput: null,
  auxOutputs: [],
  compute() {
    // Engine blits our input image to the canvas after evaluation.
    return {};
  },
};
