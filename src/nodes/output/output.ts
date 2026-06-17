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
  // `render` is a reference output: wire it into a Render Queue node to add
  // this Output as a queue item. It carries no value (the evaluator ignores
  // `render` edges) — it just links the two nodes organizationally.
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
    // ----- animated export (video / image sequence) --------------------
    // `exportMode` chooses between a single video file and a PNG/image
    // sequence (one still per frame). Both share the start/end frame range
    // and output fps below; the mode-specific params gate on this. See
    // specdocs/061726_png-sequence-export.md.
    {
      name: "exportMode",
      label: "Export mode",
      type: "enum",
      options: ["video", "sequence"],
      default: "video",
      control: "segmented",
    },
    // Frame range, shared by video and sequence. Half-open [start, end):
    // frame count = end − start (0..240 = 240 frames). Replaces the legacy
    // `videoFrames` duration; old saves migrate in project.ts.
    {
      name: "startFrame",
      label: "Start frame",
      type: "scalar",
      min: 0,
      max: 12000,
      step: 1,
      default: 0,
    },
    {
      name: "endFrame",
      label: "End frame",
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
      // Fast video is locked to the page's render fps because MediaRecorder
      // reads the live stream. High/Max video and the sequence exporter step
      // the clock manually, so they get a real, independent fps.
      visibleIf: (p) =>
        p.exportMode === "sequence" || p.videoQuality !== "fast",
    },
    // ----- video-only ---------------------------------------------------
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
      visibleIf: (p) => (p.exportMode ?? "video") === "video",
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
      visibleIf: (p) => (p.exportMode ?? "video") === "video",
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
      visibleIf: (p) =>
        (p.exportMode ?? "video") === "video" && p.videoQuality !== "fast",
    },
    {
      name: "videoBitrateMbps",
      label: "Bitrate (Mbps)",
      type: "scalar",
      min: 0.5,
      max: 200,
      step: 0.5,
      default: 16,
      visibleIf: (p) =>
        (p.exportMode ?? "video") === "video" && p.videoQuality !== "max",
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
        (p.exportMode ?? "video") === "video" &&
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
        (p.exportMode ?? "video") === "video" &&
        p.videoQuality === "max" &&
        p.videoCodec === "prores",
    },
    // ----- sequence-only ------------------------------------------------
    // How the per-frame stills are delivered. Mirrors the Render Queue's
    // `delivery` param (same string values). Frame format/quality come from
    // the shared `imageFormat` / `imageQuality` params above.
    {
      name: "seqDelivery",
      label: "Delivery",
      type: "enum",
      options: ["zip", "folder", "sequential"],
      default: "zip",
      visibleIf: (p) => p.exportMode === "sequence",
    },
  ],
  primaryOutput: null,
  auxOutputs: [{ name: "render", type: "render" }],
  compute() {
    // Engine blits our input image to the canvas after evaluation. The
    // `render` aux output carries no value — it's a reference link only.
    return {};
  },
};
