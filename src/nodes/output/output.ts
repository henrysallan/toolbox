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
    {
      name: "videoFormat",
      label: "Video format",
      type: "enum",
      options: ["mp4", "webm"],
      default: "mp4",
    },
    {
      name: "videoFrames",
      label: "Duration (frames)",
      type: "scalar",
      min: 1,
      max: 6000,
      step: 1,
      default: 240,
    },
    {
      name: "videoBitrateMbps",
      label: "Bitrate (Mbps)",
      type: "scalar",
      min: 0.5,
      max: 50,
      step: 0.5,
      default: 8,
    },
  ],
  primaryOutput: null,
  auxOutputs: [],
  compute() {
    // Engine blits our input image to the canvas after evaluation.
    return {};
  },
};
