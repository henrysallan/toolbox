import type { NodeDefinition, ParamDef } from "@/engine/types";
import {
  SVG_STYLE_PARAMS,
  svgExportStashKey,
  type SvgExportStash,
} from "./svg-export";

// The export configuration params, shared verbatim between the composition
// Output node (below) and each **Layer Output** (the fixed `group-output`
// inside a layer — see specdocs/071526_layer-output-export-settings.md).
// A Layer Output stores its own copy on the node instance so a layer can be
// rendered in a different form than the comp (e.g. a transparent qtrle of
// one layer). Both surfaces render this one list, so a param added here
// shows up in both panels automatically.
export const EXPORT_PARAMS: ParamDef[] = [
    {
      name: "filename",
      label: "Filename",
      type: "string",
      default: "",
      placeholder: "auto (timestamp)",
    },
    // ----- export resolution (073126_export-resolution-and-app-slim.md) --
    // Applies to every export product (image / video / sequence / GIF).
    // canvas = project canvas resolution (the default, and the pre-existing
    // behavior — except exports no longer inherit the preview render
    // scale); scale = canvas × multiplier (supersampling / quick proxies);
    // custom = explicit W×H for delivery specs that differ from the
    // working res. Resolved by resolveExportResolution (lib/export.ts);
    // video paths round down to even dims (H.264/H.265 reject odd sizes).
    {
      name: "resolution",
      label: "Resolution",
      type: "enum",
      options: ["canvas", "scale", "custom"],
      default: "canvas",
      control: "segmented",
    },
    {
      name: "resScale",
      label: "Scale",
      type: "scalar",
      min: 0.25,
      max: 4,
      step: 0.05,
      default: 1,
      visibleIf: (p) => p.resolution === "scale",
    },
    {
      name: "resWidth",
      label: "Width",
      type: "scalar",
      min: 16,
      max: 8192,
      step: 1,
      default: 1920,
      visibleIf: (p) => p.resolution === "custom",
    },
    {
      name: "resHeight",
      label: "Height",
      type: "scalar",
      min: 16,
      max: 8192,
      step: 1,
      default: 1080,
      visibleIf: (p) => p.resolution === "custom",
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
      options: ["video", "sequence", "gif"],
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
      // reads the live stream. High/Max video, the sequence exporter, and GIF
      // all step the clock manually, so they get a real, independent fps.
      visibleIf: (p) =>
        p.exportMode === "sequence" ||
        p.exportMode === "gif" ||
        p.videoQuality !== "fast",
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
      //   max:  h264, h264-lossless, h265, prores, qtrle, vp9, av1
      // qtrle = QuickTime Animation: lossless RGBA with a straight alpha
      // channel that After Effects AND DaVinci Resolve both read (ffmpeg's
      // ProRes 4444 alpha isn't reliably honored by either). Max tier only,
      // forced to a .mov container; always alpha-bearing.
      options: [
        "avc",
        "hevc",
        "vp9",
        "av1",
        "h264",
        "h264-lossless",
        "h265",
        "prores",
        "qtrle",
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
        p.videoCodec !== "qtrle" &&
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
    {
      name: "videoAlpha",
      label: "Transparency (alpha)",
      type: "boolean",
      // Only the ProRes 4444 / 4444xq profiles carry an alpha channel, so
      // the toggle is gated on those. On = straight-alpha 4:4:4 export
      // (yuva444p10le); off = opaque 4:4:4. Defaults on because picking a
      // 4444 profile almost always means "I want the alpha." mov/mkv only —
      // selecting ProRes already forces the container away from mp4/webm.
      default: true,
      visibleIf: (p) =>
        (p.exportMode ?? "video") === "video" &&
        p.videoQuality === "max" &&
        p.videoCodec === "prores" &&
        (p.videoProresProfile === "4444" ||
          p.videoProresProfile === "4444xq"),
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
    // ----- gif-only -----------------------------------------------------
    // Animated GIF export. Palette + transparency + dithering come from a
    // palettegen pass; `gifLossy` drives a lossy-LZW optimization pass
    // (gifsicle) — the GIF analogue of a compression slider. Frame range +
    // Output FPS above are shared (GIF delay = round(100/fps) centiseconds).
    // See specdocs/061826_gif-export-and-image-sequence.md.
    {
      name: "gifColors",
      label: "Colors",
      type: "scalar",
      // GIF palettes hold up to 256 entries. Fewer = smaller file, more
      // banding. This is the color-quantization level.
      min: 2,
      max: 256,
      step: 1,
      default: 256,
      visibleIf: (p) => p.exportMode === "gif",
    },
    {
      name: "gifDither",
      label: "Dithering",
      type: "enum",
      // none = flat bands (smallest); bayer = ordered (cheap, structured);
      // floyd = error-diffusion (smoothest gradients, largest).
      options: ["none", "bayer", "floyd"],
      default: "floyd",
      visibleIf: (p) => p.exportMode === "gif",
    },
    {
      name: "gifLossy",
      label: "Lossy",
      type: "scalar",
      // 0 = lossless LZW. Higher allows more color error between adjacent
      // pixels for a smaller file (gifsicle --lossy). 30–80 is a sane range;
      // past ~100 artifacts get visible.
      min: 0,
      max: 200,
      softMax: 100,
      step: 1,
      default: 0,
      visibleIf: (p) => p.exportMode === "gif",
    },
    {
      name: "gifTransparent",
      label: "Transparency",
      type: "boolean",
      // When on, source alpha below the threshold becomes GIF transparency
      // (1-bit). When off, the GIF is fully opaque (alpha flattened).
      default: false,
      visibleIf: (p) => p.exportMode === "gif",
    },
];

export const outputNode: NodeDefinition = {
  type: "output",
  name: "Output",
  category: "output",
  description:
    "Terminal node. Its input image is rendered to the visible canvas by the engine. Wire a spline into the optional `spline` input to unlock an SVG button alongside Image and Video — it saves that path at the current playhead as a standalone .svg, styled by the stroke/fill params that appear with it.",
  backend: "webgl2",
  terminal: true,
  // Audio is optional — the visual pipeline doesn't depend on it, and
  // requiring it would force users into a specific graph shape. Audio
  // Source handles play/pause itself via ctx.playing; Output just needs
  // the node to be "needed" so it evaluates.
  inputs: [
    { name: "image", type: "image", required: true },
    { name: "audio", type: "audio", required: false },
    // Vector side-channel. Whatever spline lands here is snapshotted at the
    // playhead into ctx.state under the SVG Export node's stash key, so the
    // node's "SVG" button saves it as a standalone .svg next to the raster /
    // video products. The engine never renders it — the canvas still shows
    // `image`, and Output declares no primary output, so the terminal
    // preview is unaffected. Same stash key + SVG_STYLE_PARAMS names as the
    // SVG Export node, which is what lets EffectsApp's single exporter serve
    // both surfaces.
    { name: "spline", type: "spline", required: false },
  ],
  // `render` is a reference output: wire it into a Render Queue node to add
  // this Output as a queue item. It carries no value (the evaluator ignores
  // `render` edges) — it just links the two nodes organizationally.
  //
  // NOTE: EXPORT_PARAMS is the list a **Layer Output** mirrors; the SVG
  // styling rows are Output-only (a Layer Output has no spline input), so
  // they're appended here rather than added to EXPORT_PARAMS.
  params: [...EXPORT_PARAMS, ...SVG_STYLE_PARAMS],
  primaryOutput: null,
  auxOutputs: [{ name: "render", type: "render" }],
  compute({ inputs, ctx, nodeId }) {
    // Engine blits our input image to the canvas after evaluation. The
    // `render` aux output carries no value — it's a reference link only.
    const spline = inputs.spline;
    if (spline && spline.kind === "spline" && spline.subpaths.length > 0) {
      const stash: SvgExportStash = {
        subpaths: spline.subpaths,
        width: ctx.width,
        height: ctx.height,
      };
      ctx.state[svgExportStashKey(nodeId)] = stash;
    } else {
      delete ctx.state[svgExportStashKey(nodeId)];
    }
    return {};
  },

  dispose(ctx, nodeId) {
    delete ctx.state[svgExportStashKey(nodeId)];
  },
};
