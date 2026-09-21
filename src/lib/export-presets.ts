// Video export presets + "what you actually get" (092126_export-presets-and-
// progress.md).
//
// The Output node used to expose the encoder pipeline raw: a quality tier
// (fast / high / max), a container list the tiers only partly honour, and one
// codec menu mixing WebCodecs names (avc, hevc…) with ffmpeg names (h264,
// prores…). Picking "hevc" under Max silently became x264 CRF 18; picking
// "mov" under High produced an .mp4. Presets name the outcome instead — a
// master, a review copy, a delivery file — and resolve to the same underlying
// settings the exporter always used. `custom` keeps the raw rows for people
// who want them, and every pre-preset save loads as `custom` with its old
// values intact (project.ts migration + `effectiveVideoPreset`).
//
// `describeVideoExport` is the single source of truth for what the pipeline
// does with a settings object: which encoder runs, what container / codec /
// chroma the file ends up with, what plays it, a size estimate, and the
// silent substitutions the exporter would make. The panel renders it under
// the export rows; exportVideo logs it.

export type VideoTier = "fast" | "high" | "max";
export type VideoContainer = "mp4" | "webm" | "mov" | "mkv";
export type VideoCodecId =
  | "avc"
  | "hevc"
  | "vp9"
  | "av1"
  | "h264"
  | "h264-lossless"
  | "h265"
  | "prores"
  | "qtrle";
export type ProresProfileName =
  | "proxy"
  | "lt"
  | "standard"
  | "hq"
  | "4444"
  | "4444xq";

export interface VideoExportSettings {
  tier: VideoTier;
  /** Container as requested; the tier may coerce it (see describe). */
  container: VideoContainer;
  /** Codec as requested; the tier may substitute (see describe). */
  codec: VideoCodecId;
  /** High tier (WebCodecs) target bitrate. */
  bitrateMbps: number;
  /** Max tier constant-quality knob for h264 / h265 / vp9 / av1. */
  crf: number;
  proresProfile: ProresProfileName;
  /** ProRes 4444 / 4444xq only. */
  alpha: boolean;
}

export type VideoPresetGroup =
  | "master"
  | "review"
  | "delivery"
  | "web"
  | "alpha"
  | "archive"
  | "preview";

export interface VideoPreset {
  id: string;
  label: string;
  group: VideoPresetGroup;
  settings: VideoExportSettings;
  /** One sentence for the panel: what this is for and what it costs. */
  blurb: string;
}

export const CUSTOM_VIDEO_PRESET = "custom";
export const DEFAULT_VIDEO_PRESET = "delivery-hevc-150";

// Ordered as the dropdown shows them: masters first, then review / delivery /
// web, then the special-purpose entries, custom last.
export const VIDEO_PRESETS: VideoPreset[] = [
  {
    id: "master-prores-4444",
    label: "Master · ProRes 4444 (mov)",
    group: "master",
    settings: {
      tier: "max",
      container: "mov",
      codec: "prores",
      bitrateMbps: 16,
      crf: 18,
      proresProfile: "4444",
      alpha: false,
    },
    blurb:
      "Apple ProRes 4444, 4:4:4, intra-only: grain and gradients survive, and every Mac decodes it in hardware. Very large files.",
  },
  {
    id: "master-prores-4444-alpha",
    label: "Master · ProRes 4444 + alpha (mov)",
    group: "master",
    settings: {
      tier: "max",
      container: "mov",
      codec: "prores",
      bitrateMbps: 16,
      crf: 18,
      proresProfile: "4444",
      alpha: true,
    },
    blurb:
      "The 4444 master with a straight alpha channel for Premiere, After Effects, Final Cut and Resolve. Desktop app only — the browser encoder writes alpha Apple decoders ignore.",
  },
  {
    id: "master-prores-hq",
    label: "Master · ProRes 422 HQ (mov)",
    group: "master",
    settings: {
      tier: "max",
      container: "mov",
      codec: "prores",
      bitrateMbps: 16,
      crf: 18,
      proresProfile: "hq",
      alpha: false,
    },
    blurb:
      "The 10-bit 4:2:2 mastering standard. Near visually lossless, hardware decode, about two thirds the size of 4444.",
  },
  {
    id: "review-h264-crf12",
    label: "Review · H.264 near-lossless CRF 12 (mov)",
    group: "review",
    settings: {
      tier: "max",
      container: "mov",
      codec: "h264",
      bitrateMbps: 16,
      crf: 12,
      proresProfile: "hq",
      alpha: false,
    },
    blurb:
      "x264 at constant quality 12: keeps grain at the cost of size, 8-bit 4:2:0, plays in QuickTime. Slow to encode at 4K.",
  },
  {
    id: "review-h264-crf16",
    label: "Review · H.264 high quality CRF 16 (mp4)",
    group: "review",
    settings: {
      tier: "max",
      container: "mp4",
      codec: "h264",
      bitrateMbps: 16,
      crf: 16,
      proresProfile: "hq",
      alpha: false,
    },
    blurb:
      "x264 constant quality 16 in an .mp4: visually clean, plays everywhere, a fraction of the master's size.",
  },
  {
    id: "delivery-hevc-150",
    label: "Delivery · HEVC hardware 150 Mbps (mp4)",
    group: "delivery",
    settings: {
      tier: "high",
      container: "mp4",
      codec: "hevc",
      bitrateMbps: 150,
      crf: 18,
      proresProfile: "hq",
      alpha: false,
    },
    blurb:
      "Apple's hardware HEVC encoder through WebCodecs: fast, small, plays on every Apple device. Grain softens under the bitrate cap.",
  },
  {
    id: "delivery-hevc-60",
    label: "Delivery · HEVC hardware 60 Mbps (mp4)",
    group: "delivery",
    settings: {
      tier: "high",
      container: "mp4",
      codec: "hevc",
      bitrateMbps: 60,
      crf: 18,
      proresProfile: "hq",
      alpha: false,
    },
    blurb:
      "Same hardware HEVC path at a sharing-friendly bitrate. Fine for smooth content; grain and noise will smear.",
  },
  {
    id: "web-h264-40",
    label: "Web · H.264 hardware 40 Mbps (mp4)",
    group: "web",
    settings: {
      tier: "high",
      container: "mp4",
      codec: "avc",
      bitrateMbps: 40,
      crf: 18,
      proresProfile: "hq",
      alpha: false,
    },
    blurb:
      "Hardware H.264 in an .mp4: the most universally playable file, browsers and Windows included.",
  },
  {
    id: "web-vp9",
    label: "Web · VP9 (webm)",
    group: "web",
    settings: {
      tier: "high",
      container: "webm",
      codec: "vp9",
      bitrateMbps: 30,
      crf: 18,
      proresProfile: "hq",
      alpha: false,
    },
    blurb:
      "VP9 WebM for browsers and the open web. Not a QuickTime format.",
  },
  {
    id: "alpha-qtrle",
    label: "Alpha · QuickTime Animation for AE / Premiere (mov)",
    group: "alpha",
    settings: {
      tier: "max",
      container: "mov",
      codec: "qtrle",
      bitrateMbps: 16,
      crf: 18,
      proresProfile: "hq",
      alpha: true,
    },
    blurb:
      "Lossless 8-bit RGBA with a straight alpha channel. Premiere and After Effects read it; QuickTime Player and Final Cut do not.",
  },
  {
    id: "archive-h264-lossless",
    label: "Archive · H.264 lossless 4:4:4 (mov)",
    group: "archive",
    settings: {
      tier: "max",
      container: "mov",
      codec: "h264-lossless",
      bitrateMbps: 16,
      crf: 0,
      proresProfile: "hq",
      alpha: false,
    },
    blurb:
      "Mathematically lossless 4:4:4. Multi-gigabit on grain and no hardware decoder anywhere — QuickTime cannot play it in real time. For ffmpeg, Resolve and archives.",
  },
  {
    id: "preview-fast",
    label: "Preview · quick real-time capture (mp4)",
    group: "preview",
    settings: {
      tier: "fast",
      container: "mp4",
      codec: "avc",
      bitrateMbps: 16,
      crf: 18,
      proresProfile: "hq",
      alpha: false,
    },
    blurb:
      "Records the live viewport at the project frame rate through MediaRecorder. Can drop frames; for quick checks only.",
  },
];

export const VIDEO_PRESET_IDS: string[] = VIDEO_PRESETS.map((p) => p.id);
export const VIDEO_PRESET_OPTIONS: string[] = [
  ...VIDEO_PRESET_IDS,
  CUSTOM_VIDEO_PRESET,
];
export const VIDEO_PRESET_LABELS: Record<string, string> = Object.fromEntries([
  ...VIDEO_PRESETS.map((p) => [p.id, p.label] as const),
  [CUSTOM_VIDEO_PRESET, "Custom…"],
]);

export function getVideoPreset(id: unknown): VideoPreset | null {
  return VIDEO_PRESETS.find((p) => p.id === id) ?? null;
}

// The raw rows the presets replaced. A save that touched any of them and
// predates `videoPreset` keeps exactly that configuration under Custom.
export const LEGACY_VIDEO_KEYS = [
  "videoQuality",
  "videoFormat",
  "videoCodec",
  "videoBitrateMbps",
  "videoCrf",
  "videoProresProfile",
  "videoAlpha",
] as const;

export function hasLegacyVideoKeys(params: Record<string, unknown>): boolean {
  return LEGACY_VIDEO_KEYS.some((k) => params[k] !== undefined);
}

/**
 * Which preset governs `params`: the stored id when it is a known preset or
 * `custom`; otherwise `custom` for a pre-preset save that configured the raw
 * rows and the default preset for an untouched node. An unknown stored id
 * (a preset removed later) falls back to the default.
 */
export function effectiveVideoPreset(params: Record<string, unknown>): string {
  const v = params.videoPreset;
  if (v === CUSTOM_VIDEO_PRESET) return CUSTOM_VIDEO_PRESET;
  if (typeof v === "string" && getVideoPreset(v)) return v;
  if (v === undefined && hasLegacyVideoKeys(params)) return CUSTOM_VIDEO_PRESET;
  return DEFAULT_VIDEO_PRESET;
}

export function isCustomVideoPreset(params: Record<string, unknown>): boolean {
  return effectiveVideoPreset(params) === CUSTOM_VIDEO_PRESET;
}

const TIERS: readonly VideoTier[] = ["fast", "high", "max"];
const CONTAINERS: readonly VideoContainer[] = ["mp4", "webm", "mov", "mkv"];
const CODECS: readonly VideoCodecId[] = [
  "avc",
  "hevc",
  "vp9",
  "av1",
  "h264",
  "h264-lossless",
  "h265",
  "prores",
  "qtrle",
];
const PRORES_PROFILES: readonly ProresProfileName[] = [
  "proxy",
  "lt",
  "standard",
  "hq",
  "4444",
  "4444xq",
];

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : fallback;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * The settings the exporter runs with. Custom reads the raw rows with the
 * defaults the Output node always had (High / mp4 / avc / 16 Mbps / CRF 18 /
 * ProRes HQ / alpha on); a preset supplies its table.
 */
export function resolveVideoExportSettings(
  params: Record<string, unknown>
): VideoExportSettings & { preset: string } {
  const preset = effectiveVideoPreset(params);
  const table = getVideoPreset(preset);
  if (table) return { preset, ...table.settings };
  return {
    preset: CUSTOM_VIDEO_PRESET,
    tier: pick(params.videoQuality, TIERS, "high"),
    container: pick(params.videoFormat, CONTAINERS, "mp4"),
    codec: pick(params.videoCodec, CODECS, "avc"),
    bitrateMbps: num(params.videoBitrateMbps, 16),
    crf: num(params.videoCrf, 18),
    proresProfile: pick(params.videoProresProfile, PRORES_PROFILES, "hq"),
    // Mirrors the ParamDef default (true): picking a 4444 profile almost
    // always means "I want the alpha".
    alpha: params.videoAlpha === undefined ? true : !!params.videoAlpha,
  };
}

// ---------------------------------------------------------------------------
// What the pipeline actually does with a settings object.
// ---------------------------------------------------------------------------

export const WEBCODECS_CODECS: readonly VideoCodecId[] = ["avc", "hevc", "vp9", "av1"];
export const FFMPEG_CODECS: readonly VideoCodecId[] = [
  "h264",
  "h264-lossless",
  "h265",
  "prores",
  "qtrle",
  "vp9",
  "av1",
];

export interface VideoExportPlan {
  tier: VideoTier;
  /** Container the file really gets. */
  container: VideoContainer;
  /** Codec that really encodes. */
  codec: VideoCodecId;
  /** Human name of the encoder that runs. */
  encoder: string;
  /** e.g. "ProRes 4444 · 10-bit 4:4:4 + alpha". */
  format: string;
  /** Who plays it. */
  playback: string;
  /** Estimated bytes for the export window, or null when content-dependent. */
  estimatedBytes: number | null;
  /** Why the estimate is null, or how it was made. */
  sizeNote: string;
  /** Silent substitutions and known traps for this combination. */
  warnings: string[];
  /** Panel-ready lines (format, encoder, playback, size). */
  lines: string[];
}

export interface VideoExportContext {
  width: number;
  height: number;
  fps: number;
  frames: number;
  /** Desktop app with the native ffmpeg available. */
  nativeEncoder: boolean;
}

// Apple's published ProRes data rates, expressed as bits per pixel per frame
// (3840×2160 @ 59.94 → 289 / 655 / 943 / 1414 / 2121 / 3182 Mbps).
const PRORES_BPP: Record<ProresProfileName, number> = {
  proxy: 0.58,
  lt: 1.32,
  standard: 1.9,
  hq: 2.85,
  "4444": 4.27,
  "4444xq": 6.4,
};

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

export function describeVideoExport(
  s: VideoExportSettings,
  ctx: VideoExportContext
): VideoExportPlan {
  const warnings: string[] = [];
  const px = Math.max(1, ctx.width) * Math.max(1, ctx.height);
  const seconds = ctx.frames / Math.max(1, ctx.fps);
  const bigForWasm = px * ctx.frames > 1920 * 1080 * 120; // ~1080p × 2 s of frames

  const tier = s.tier;
  let container = s.container;
  let codec = s.codec;
  let encoder: string;
  let format: string;
  let playback: string;
  let estimatedBytes: number | null = null;
  let sizeNote = "content-dependent";

  const fromBitrate = (mbps: number) => {
    estimatedBytes = (mbps * 1e6 * seconds) / 8;
    sizeNote = `${mbps} Mbps target × ${seconds.toFixed(1)} s`;
  };

  if (tier === "fast") {
    // MediaRecorder: mp4 or webm only, browser picks the codec.
    if (container !== "webm") container = "mp4";
    codec = container === "webm" ? "vp9" : "avc";
    encoder = "MediaRecorder (browser, real-time capture of the live viewport)";
    format = container === "webm" ? "VP9 / VP8 · 8-bit 4:2:0" : "H.264 · 8-bit 4:2:0";
    playback = "everywhere the container plays";
    fromBitrate(s.bitrateMbps);
    warnings.push(
      "Real-time capture: frames drop when the graph cannot keep up, and the output fps is locked to the project fps."
    );
  } else if (tier === "high") {
    // WebCodecs via mediabunny: mp4 or webm, codec from the WebCodecs set.
    if (!WEBCODECS_CODECS.includes(codec)) {
      warnings.push(
        `"${codec}" is an ffmpeg codec; the High tier encodes with WebCodecs and will use avc (H.264) instead. Pick a Max-tier preset for ${codec}.`
      );
      codec = "avc";
    }
    if (container !== "webm" && container !== "mp4") {
      warnings.push(`The High tier writes .mp4, not .${container}.`);
      container = "mp4";
    }
    if (container === "webm" && (codec === "avc" || codec === "hevc")) {
      warnings.push("WebM cannot carry H.264 / HEVC; VP9 will be used.");
      codec = "vp9";
    }
    if (container === "mp4" && codec === "vp9") {
      // legal, just unusual
      warnings.push("VP9 in .mp4 plays in browsers but not in QuickTime.");
    }
    encoder = "WebCodecs (the OS encoder, hardware where available) via mediabunny";
    format =
      codec === "hevc"
        ? "HEVC · 8-bit 4:2:0"
        : codec === "avc"
          ? "H.264 · 8-bit 4:2:0"
          : codec === "vp9"
            ? "VP9 · 8-bit 4:2:0"
            : "AV1 · 8-bit 4:2:0";
    playback =
      codec === "hevc"
        ? "QuickTime, every Apple device, Chrome / Edge on capable hardware; Windows may need the HEVC extension"
        : codec === "avc"
          ? "everywhere"
          : "browsers and VLC; not QuickTime";
    fromBitrate(s.bitrateMbps);
    if (s.bitrateMbps < 60 && px >= 3000 * 3000) {
      warnings.push(
        `${s.bitrateMbps} Mbps is low for ${ctx.width}×${ctx.height} — noise and grain will smear. 100–200 Mbps keeps them at this size.`
      );
    }
  } else {
    // Max: ffmpeg, native on desktop, wasm in the browser.
    if (!FFMPEG_CODECS.includes(codec)) {
      const sub: VideoCodecId = codec === "hevc" ? "h265" : "h264";
      warnings.push(
        `"${codec}" is a WebCodecs codec name; the Max tier runs ffmpeg and will use ${sub} instead.`
      );
      codec = sub;
    }
    const needsMov = codec === "prores" || codec === "qtrle";
    if (needsMov && (container === "mp4" || container === "webm")) {
      warnings.push(`${codec === "prores" ? "ProRes" : "QuickTime Animation"} needs a .mov; the .${container} choice becomes .mov.`);
      container = "mov";
    }
    if ((codec === "vp9" || codec === "av1") && (container === "mp4" || container === "mov")) {
      warnings.push(`${codec.toUpperCase()} in .${container} plays in browsers but not in QuickTime.`);
    }
    const lib =
      codec === "h264" || codec === "h264-lossless"
        ? "libx264"
        : codec === "h265"
          ? "libx265"
          : codec === "prores"
            ? "prores_ks"
            : codec === "qtrle"
              ? "qtrle"
              : codec === "vp9"
                ? "libvpx-vp9"
                : "libaom-av1";
    encoder = ctx.nativeEncoder
      ? `ffmpeg 9 (desktop, native) · ${lib}`
      : `ffmpeg.wasm (browser, single-threaded, 2 GiB limit) · ${lib}`;

    if (codec === "prores") {
      const p = s.proresProfile;
      const alpha = s.alpha && (p === "4444" || p === "4444xq");
      const name =
        p === "4444xq" ? "ProRes 4444 XQ" : p === "4444" ? "ProRes 4444" : p === "hq" ? "ProRes 422 HQ" : p === "standard" ? "ProRes 422" : p === "lt" ? "ProRes 422 LT" : "ProRes 422 Proxy";
      format = `${name} · ${p === "4444" || p === "4444xq" ? "4:4:4" : "10-bit 4:2:2"}${alpha ? " + straight alpha" : ""}`;
      playback = "QuickTime, Final Cut, Premiere, After Effects, Resolve — hardware decode on Apple Silicon";
      const bpp = PRORES_BPP[p] * (alpha ? 1.15 : 1);
      estimatedBytes = (bpp * px * ctx.frames) / 8;
      sizeNote = `Apple's ProRes data rate (~${bpp.toFixed(1)} bits/px) × ${ctx.frames} frames`;
      if (alpha && !ctx.nativeEncoder) {
        warnings.push(
          "Browser build: the wasm ffmpeg (5.1) writes ProRes alpha that Apple decoders ignore. Export from the desktop app for a transparent master."
        );
      }
      if (s.alpha && !(p === "4444" || p === "4444xq")) {
        warnings.push("Only the 4444 / 4444 XQ profiles carry alpha; this profile exports opaque.");
      }
    } else if (codec === "qtrle") {
      format = "QuickTime Animation (RLE) · 8-bit RGBA, straight alpha, lossless";
      playback = "Premiere and After Effects (their own decoder); QuickTime Player and Final Cut cannot open it";
      sizeNote = "lossless RLE: tiny for flat cut-outs, larger than ProRes on busy full-frame content";
    } else if (codec === "h264-lossless") {
      format = "H.264 High 4:4:4 Predictive · 8-bit 4:4:4 · mathematically lossless";
      playback = "ffmpeg-based players, Resolve; no hardware decoder anywhere — QuickTime cannot keep up above ~1080p";
      sizeNote = "content-dependent; grain-heavy 3840² measured 4.7–9 Gbps (2–4.5 GB per 4 s)";
      warnings.push(
        "Lossless H.264 is an archive format: expect multi-gigabit files that QuickTime and Preview will not play smoothly."
      );
    } else if (codec === "h264" || codec === "h265") {
      const name = codec === "h264" ? "H.264 High" : "HEVC Main";
      format = `${name} · 8-bit 4:2:0 · constant quality CRF ${s.crf}`;
      playback =
        codec === "h264"
          ? "everywhere; QuickTime plays it (software decode above 4K)"
          : "QuickTime and Apple devices; Windows may need the HEVC extension";
      sizeNote =
        s.crf <= 12
          ? "content-dependent; CRF 12 on grain lands near 2–3 bits/px"
          : s.crf <= 18
            ? "content-dependent; CRF 16–18 on grain measured ~1.3 bits/px (635 MB per 4 s at 4000²)"
            : "content-dependent; higher CRF = smaller";
    } else {
      format = `${codec.toUpperCase()} · 8-bit 4:2:0 · CRF ${s.crf}`;
      playback = "browsers and VLC; not QuickTime";
      sizeNote = "content-dependent";
      if (codec === "av1" && !ctx.nativeEncoder) {
        warnings.push("Browser build: the wasm ffmpeg has no AV1 encoder; this export will fail. Use the desktop app or VP9.");
      }
    }
    if (!ctx.nativeEncoder && bigForWasm && (codec === "h264-lossless" || codec === "prores" || codec === "qtrle")) {
      warnings.push(
        "Browser build: lossless / ProRes / Animation at this size exceeds the wasm encoder's 2 GiB memory. Use the desktop app, a smaller Scale, or a PNG sequence."
      );
    }
  }

  const dur = `${ctx.frames} frames · ${seconds.toFixed(1)} s at ${ctx.width}×${ctx.height}`;
  const lines = [
    `File: .${container} · ${format}`,
    `Encoder: ${encoder}`,
    `Plays in: ${playback}`,
    estimatedBytes != null
      ? `Size: about ${formatBytes(estimatedBytes)} for ${dur} (${sizeNote})`
      : `Size: ${sizeNote} — ${dur}`,
  ];

  return {
    tier,
    container,
    codec,
    encoder,
    format,
    playback,
    estimatedBytes,
    sizeNote,
    warnings,
    lines,
  };
}
