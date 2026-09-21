// check-export-presets: the video export presets and the "what you actually
// get" description (src/lib/export-presets.ts) plus the Output node rows
// that ride on them (092126_export-presets-and-progress.md). Pure half only —
// the panel rendering and the encoders themselves are live-app questions.
//
//   npx tsx scripts/check-export-presets.mts

import {
  CUSTOM_VIDEO_PRESET,
  DEFAULT_VIDEO_PRESET,
  FFMPEG_CODECS,
  VIDEO_PRESETS,
  VIDEO_PRESET_LABELS,
  VIDEO_PRESET_OPTIONS,
  WEBCODECS_CODECS,
  describeVideoExport,
  effectiveVideoPreset,
  getVideoPreset,
  resolveVideoExportSettings,
  type VideoExportContext,
} from "../src/lib/export-presets";
import { EXPORT_PARAMS } from "../src/nodes/output/output";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const desktop: VideoExportContext = {
  width: 3840,
  height: 3840,
  fps: 60,
  frames: 240,
  nativeEncoder: true,
};
const browser: VideoExportContext = { ...desktop, nativeEncoder: false };

// ---- the table --------------------------------------------------------------
{
  const ids = VIDEO_PRESETS.map((p) => p.id);
  check("presets: ids unique", new Set(ids).size === ids.length);
  check("presets: custom is not a table entry", !ids.includes(CUSTOM_VIDEO_PRESET));
  check(
    "presets: options = every id + custom, in table order",
    JSON.stringify(VIDEO_PRESET_OPTIONS) === JSON.stringify([...ids, CUSTOM_VIDEO_PRESET])
  );
  check("presets: every option has a label", VIDEO_PRESET_OPTIONS.every((o) => !!VIDEO_PRESET_LABELS[o]));
  check("presets: default is a real preset", !!getVideoPreset(DEFAULT_VIDEO_PRESET));
  for (const p of VIDEO_PRESETS) {
    const s = p.settings;
    const codecOk =
      s.tier === "fast" ||
      (s.tier === "high" && WEBCODECS_CODECS.includes(s.codec)) ||
      (s.tier === "max" && FFMPEG_CODECS.includes(s.codec));
    check(`preset ${p.id}: codec belongs to its tier`, codecOk, `${s.tier} / ${s.codec}`);
    check(`preset ${p.id}: has a blurb and a group`, p.blurb.length > 20 && !!p.group);
    // Nothing a preset promises may be silently substituted by the tier.
    const plan = describeVideoExport(s, desktop);
    const substituted = plan.warnings.some((w) => /will use|becomes \.|writes \.mp4/.test(w));
    check(`preset ${p.id}: no silent substitution on desktop`, !substituted, plan.warnings.join(" | "));
    check(`preset ${p.id}: file/encoder/plays/size lines`, plan.lines.length === 4 && plan.lines[0].startsWith("File: ."));
  }
}

// ---- effectiveVideoPreset / resolve ------------------------------------------
{
  check("effective: untouched node → default preset", effectiveVideoPreset({}) === DEFAULT_VIDEO_PRESET);
  check(
    "effective: pre-preset save with encoder rows → custom",
    effectiveVideoPreset({ videoQuality: "max", videoCodec: "prores" }) === CUSTOM_VIDEO_PRESET
  );
  check("effective: stored custom", effectiveVideoPreset({ videoPreset: "custom" }) === CUSTOM_VIDEO_PRESET);
  check("effective: stored preset", effectiveVideoPreset({ videoPreset: "master-prores-hq" }) === "master-prores-hq");
  check(
    "effective: unknown stored id → default (a removed preset)",
    effectiveVideoPreset({ videoPreset: "nope", videoQuality: "max" }) === DEFAULT_VIDEO_PRESET
  );

  const legacy = resolveVideoExportSettings({
    videoQuality: "max",
    videoFormat: "mkv",
    videoCodec: "prores",
    videoProresProfile: "4444",
    videoAlpha: false,
    videoCrf: 10,
    videoBitrateMbps: 33,
  });
  check(
    "resolve: custom keeps every legacy value",
    legacy.preset === "custom" &&
      legacy.tier === "max" &&
      legacy.container === "mkv" &&
      legacy.codec === "prores" &&
      legacy.proresProfile === "4444" &&
      legacy.alpha === false &&
      legacy.crf === 10 &&
      legacy.bitrateMbps === 33
  );
  const bare = resolveVideoExportSettings({ videoPreset: "custom" });
  check(
    "resolve: custom with nothing stored = the Output's old defaults",
    bare.tier === "high" &&
      bare.container === "mp4" &&
      bare.codec === "avc" &&
      bare.bitrateMbps === 16 &&
      bare.crf === 18 &&
      bare.proresProfile === "hq" &&
      bare.alpha === true
  );
  const master = resolveVideoExportSettings({ videoPreset: "master-prores-4444-alpha" });
  check(
    "resolve: preset supplies its table",
    master.tier === "max" && master.codec === "prores" && master.proresProfile === "4444" && master.alpha === true
  );
  const junkTypes = resolveVideoExportSettings({ videoPreset: "custom", videoQuality: 7, videoCodec: null, videoCrf: "x" });
  check("resolve: junk custom values fall back to defaults", junkTypes.tier === "high" && junkTypes.codec === "avc" && junkTypes.crf === 18);
}

// ---- describeVideoExport: substitutions, coercions, estimates ----------------
{
  const hevcUnderMax = describeVideoExport(
    { ...resolveVideoExportSettings({ videoPreset: "custom" }), tier: "max", codec: "hevc", container: "mov" },
    desktop
  );
  check(
    "describe: hevc under Max → h265 with a warning",
    hevcUnderMax.codec === "h265" && hevcUnderMax.warnings.some((w) => w.includes("will use h265"))
  );
  const h264UnderHigh = describeVideoExport(
    { ...resolveVideoExportSettings({ videoPreset: "custom" }), tier: "high", codec: "h264", container: "mov" },
    desktop
  );
  check(
    "describe: h264 + mov under High → avc in .mp4, two warnings",
    h264UnderHigh.codec === "avc" &&
      h264UnderHigh.container === "mp4" &&
      h264UnderHigh.warnings.some((w) => w.includes("avc")) &&
      h264UnderHigh.warnings.some((w) => w.includes(".mp4"))
  );
  const proresMp4 = describeVideoExport(
    { ...resolveVideoExportSettings({ videoPreset: "master-prores-hq" }), container: "mp4" },
    desktop
  );
  check("describe: ProRes in mp4 → .mov", proresMp4.container === "mov" && proresMp4.warnings.some((w) => w.includes(".mov")));

  const lossless = describeVideoExport(resolveVideoExportSettings({ videoPreset: "archive-h264-lossless" }), desktop);
  check(
    "describe: lossless H.264 warns about playback and gives no size",
    lossless.estimatedBytes === null && lossless.warnings.some((w) => /QuickTime/.test(w))
  );

  const hevc150 = describeVideoExport(resolveVideoExportSettings({ videoPreset: "delivery-hevc-150" }), desktop);
  check(
    "describe: 150 Mbps × 4 s = 75 MB",
    hevc150.estimatedBytes === 75_000_000 && hevc150.lines[3].includes("75 MB"),
    String(hevc150.estimatedBytes)
  );
  const prores4444 = describeVideoExport(resolveVideoExportSettings({ videoPreset: "master-prores-4444" }), desktop);
  check(
    "describe: ProRes 4444 at 3840² × 240 frames ≈ 1.9 GB",
    prores4444.estimatedBytes !== null && prores4444.estimatedBytes > 1.8e9 && prores4444.estimatedBytes < 2.0e9,
    String(prores4444.estimatedBytes)
  );
  const alphaWeb = describeVideoExport(resolveVideoExportSettings({ videoPreset: "master-prores-4444-alpha" }), browser);
  check(
    "describe: ProRes alpha in the browser warns (wasm ffmpeg 5.1)",
    alphaWeb.warnings.some((w) => /Browser build/.test(w) && /alpha/.test(w))
  );
  const av1Web = describeVideoExport(
    { ...resolveVideoExportSettings({ videoPreset: "custom" }), tier: "max", codec: "av1", container: "mkv" },
    browser
  );
  check("describe: av1 in the browser warns (no libaom)", av1Web.warnings.some((w) => /AV1/.test(w)));
  const fast = describeVideoExport(resolveVideoExportSettings({ videoPreset: "preview-fast" }), desktop);
  check("describe: fast tier → mp4 / avc + drop-frame warning", fast.container === "mp4" && fast.codec === "avc" && fast.warnings.length === 1);
  const lowBitrate = describeVideoExport(resolveVideoExportSettings({ videoPreset: "custom" }), desktop);
  check(
    "describe: 16 Mbps at 3840² warns that grain will smear",
    lowBitrate.warnings.some((w) => /grain will smear/.test(w))
  );
}

// ---- the Output node rows ---------------------------------------------------
{
  const byName = new Map(EXPORT_PARAMS.map((p) => [p.name, p]));
  const preset = byName.get("videoPreset");
  check("output: videoPreset row exists with the preset options and default", !!preset && preset.default === DEFAULT_VIDEO_PRESET && JSON.stringify(preset.options) === JSON.stringify(VIDEO_PRESET_OPTIONS));
  const vis = (name: string, p: Record<string, unknown>) => byName.get(name)?.visibleIf?.(p) ?? true;
  const presetVideo = { exportMode: "video", videoPreset: "master-prores-hq" };
  const customVideo = { exportMode: "video", videoPreset: "custom", videoQuality: "max", videoCodec: "prores", videoProresProfile: "4444" };
  check("output: encoder rows hidden under a preset", !vis("videoQuality", presetVideo) && !vis("videoCodec", presetVideo) && !vis("videoFormat", presetVideo));
  check("output: encoder rows shown under custom", vis("videoQuality", customVideo) && vis("videoCodec", customVideo) && vis("videoFormat", customVideo) && vis("videoProresProfile", customVideo) && vis("videoAlpha", customVideo));
  check("output: preset row hidden for sequence / gif", !vis("videoPreset", { exportMode: "sequence" }) && !vis("videoPreset", { exportMode: "gif" }));
  check("output: Output FPS hidden for the fast preset, shown for a stepped one", !vis("videoFps", { exportMode: "video", videoPreset: "preview-fast" }) && vis("videoFps", presetVideo));
  check("output: a pre-preset save (no videoPreset, raw rows) shows the raw rows", vis("videoQuality", { exportMode: "video", videoQuality: "max", videoCodec: "h264" }));
}

if (failures > 0) {
  console.log(`\ncheck-export-presets: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall passed");
