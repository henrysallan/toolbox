// M0 spike, After Effects half (spec 091926_after-effects-handoff.md §10 M0).
//
// Builds every scripts/fixtures/ae-export/*.scene.json fixture into a package
// (scene.json + build.jsx + synthesized .ffx presets + footage), runs them
// through the real After Effects headless, reads the results back and checks
// them: easing against toolbox's easeOf, key times, structure, pixels.
//
//   npx tsx scripts/ae-export-spike/run.mts               all fixtures
//   npx tsx scripts/ae-export-spike/run.mts a-circle      fixtures whose name contains "a-circle"
//   npx tsx scripts/ae-export-spike/run.mts --no-ae       only write the packages
//   npx tsx scripts/ae-export-spike/run.mts --out DIR     package folder (default: a temp dir)
//
// How AE runs headless on macOS. aerender launches its own render core
// (aerendercore, bundle id com.adobe.aerendercore — a separate process; the
// After Effects GUI the owner may have open is never contacted), and the core
// runs `gAECommandLineRenderer.Render(<args>)` then quits. It has no flag to run
// a script, but it does run the user Scripts/Startup folder at launch. So for
// ONE aerender launch this copies hook.jsx there; the hook evaluates the
// driver named by TBX_AE_SPIKE_DRIVER (set only in aerender's environment) and
// is deleted again when aerender exits. The driver builds each package
// (build.jsx), probes it (probe.jsx) and queues the requested frames in the
// saved project ("TIFF Sequence with Alpha"); aerender's own Render then
// renders one frame of the last package with -s/-e and -OMtemplate — the route
// compare_ae_renders will use. A plain `aerender -project` per package (no
// hook) renders the queued frames, and the CLI frame is compared with the
// queued render of the same frame.
//
// In that startup context app.newProject() blocks, renderQueue.render() does
// nothing and layer.applyPreset() hangs the core (spec §13), so gradient
// presets are reported n/a here: they need build.jsx run in the AE app.
//
// Needs: After Effects 26.x at AE_DIR (default /Applications/Adobe After
// Effects 2026) and "Allow Scripts to Write Files and Access Network" ON (the
// probe writes probe.json; this script only reads that preference).

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

import { easeOf } from "@/engine/keyframes";
import { compareRgba } from "@/lib/glsl-translation/compare";
import { synthesizeGradientPreset } from "@/lib/ae-export/runtime/ffx";
import type { AeScene, AeShapeItem } from "@/lib/ae-export/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const FIXTURES = join(REPO, "scripts/fixtures/ae-export");
const BUILD_JSX = join(REPO, "src/lib/ae-export/runtime/build.jsx");
const AE_DIR = process.env.AE_DIR ?? "/Applications/Adobe After Effects 2026";
const AERENDER = join(AE_DIR, "aerender");
const PREFS_VERSION = process.env.AE_PREFS_VERSION ?? "26.5";
const PREFS = join(homedir(), "Library/Preferences/Adobe/After Effects", PREFS_VERSION);
const STARTUP = join(PREFS, "Scripts/Startup");
const HOOK = join(STARTUP, "zz_toolbox_ae_spike_hook.jsx");

const args = process.argv.slice(2);
const noAe = args.includes("--no-ae");
const outIdx = args.indexOf("--out");
const WORK = outIdx >= 0 ? resolve(args[outIdx + 1]) : join(tmpdir(), `toolbox-ae-spike-${Date.now()}`);
const filters = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");

// ---------------------------------------------------------------------------
// Per-fixture probes and checks
// ---------------------------------------------------------------------------

interface Sample {
  comp: string;
  layer: string;
  path: (string | number)[];
  times: number[];
  preExpression?: boolean;
}

interface Pixel {
  frame: number;
  x: number;
  y: number;
  // Straight-alpha 8-bit RGBA; null channels are not checked.
  want?: (number | null)[];
  pred?: (rgba: number[]) => boolean;
  tol?: number;
  label: string;
  // Needs a synthesized .ffx applied: only checkable when build.jsx ran in
  // the After Effects app (applyPreset hangs aerender's core).
  guiOnly?: boolean;
}

// Fraction of pixels with alpha > 0 inside [x0, y0, x1, y1).
interface Region {
  frame: number;
  box: [number, number, number, number];
  min?: number;
  max?: number;
  label: string;
}

interface Probe {
  samples?: Sample[];
  trees?: { comp: string; layer: string; path?: (string | number)[]; depth?: number }[];
  svg?: string;
  render?: { comp: string; frames: number[] };
  pixels?: Pixel[];
  regions?: Region[];
  // Trees of every layer in comps the scene did not name (an imported SVG).
  otherCompTrees?: number;
  // Preset id → where the gradient sits (ffx.ts GradientPresetInput.path);
  // omitted = ffx.ts's default path.
  presetPaths?: Record<string, { groups: number[]; item: number }>;
  verify?(probe: any, report: Report): void;
}

const frames = (fps: number, from: number, to: number) => {
  const out: number[] = [];
  for (let f = from; f <= to; f++) out.push(f / fps);
  return out;
};

const C1 = 1.70158;
const CUBIC = {
  easeOutBack: [1 / 3, 1 + C1 / 3, 2 / 3, 1],
  // Minimax fit (this spike, 2026-10-19); spec §4.2's 3-decimal
  // (0.380, 0.016, 0.640, 1.010) measures 0.2501%.
  easeInOutSineFit: [0.3628219912543504, -0.0015704922479194603, 0.6371780087450842, 1.001570492247425],
  easeOutCubic: [1 / 3, 1, 2 / 3, 1],
} as const;

// Normalized cubic-bezier easing, solved exactly (bisection to 1e-13).
function cubicEase([x1, y1, x2, y2]: readonly number[], t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const bx = (u: number) => 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    if (bx(mid) < t) lo = mid;
    else hi = mid;
  }
  const u = (lo + hi) / 2;
  const o = 1 - u;
  return 3 * o * o * u * y1 + 3 * o * u * u * y2 + u * u * u;
}

function sampleOf(probe: any, layer: string, mn: string): any {
  return probe.samples.find((s: any) => s && s.layer === layer && s.path[s.path.length - 1] === mn);
}

// max |AE − f| over a segment, in normalized value units.
function segmentError(s: any, t0: number, t1: number, v0: number, v1: number, f: (u: number) => number, dim?: number) {
  let worst = 0;
  let at = 0;
  s.values.forEach((raw: any, i: number) => {
    const t = s.timesUsed[i];
    if (t < t0 - 1e-9 || t > t1 + 1e-9) return;
    const v = dim === undefined ? raw : raw[dim];
    const u = (t - t0) / (t1 - t0);
    const err = Math.abs((v - v0) / (v1 - v0) - f(u));
    if (err > worst) {
      worst = err;
      at = t;
    }
  });
  return { worst, at };
}

const PROBES: Record<string, Probe> = {
  "a-circle": {
    samples: [
      { comp: "A Circle", layer: "Circle", path: ["ADBE Transform Group", "ADBE Position_0"], times: frames(30, 0, 30) },
      { comp: "A Circle", layer: "Circle", path: ["ADBE Transform Group", "ADBE Position_1"], times: frames(30, 15, 45) },
      { comp: "A Circle", layer: "Circle", path: ["ADBE Transform Group", "ADBE Scale"], times: frames(30, 0, 30) },
      { comp: "A Circle", layer: "Circle", path: ["ADBE Transform Group", "ADBE Opacity"], times: [0, 1.7, 53 / 30, 1.8, 1.9] },
      { comp: "A Circle", layer: "Clock probe", path: ["ADBE Transform Group", "ADBE Rotate Z"], times: [0.5, 1, 1.5] },
    ],
    trees: [{ comp: "A Circle", layer: "Circle", depth: 5 }],
    render: { comp: "A Circle", frames: [0, 15] },
    pixels: [
      // Frame 0: circle centre at (400, 300), r 120; the mask keeps layer x ≤ 70.
      { frame: 0, x: 340, y: 240, want: [51, 153, 255, 255], tol: 1, label: "inside circle and mask: fill color" },
      { frame: 0, x: 495, y: 300, want: [null, null, null, 0], label: "inside circle, outside the spline mask" },
      { frame: 0, x: 100, y: 100, want: [null, null, null, 0], label: "outside the circle" },
    ],
    verify(p, r) {
      const x = sampleOf(p, "Circle", "ADBE Position_0");
      const y = sampleOf(p, "Circle", "ADBE Position_1");
      const sc = sampleOf(p, "Circle", "ADBE Scale");
      const op = sampleOf(p, "Circle", "ADBE Opacity");
      const rot = sampleOf(p, "Clock probe", "ADBE Rotate Z");
      const back = segmentError(x, 0, 1, 400, 1400, (u) => easeOf("easeOutBack", u));
      const backCubic = segmentError(x, 0, 1, 400, 1400, (u) => cubicEase(CUBIC.easeOutBack, u));
      r.metric("easeOutBack: max |AE − easeOf| (31 frames)", back.worst, "normalized");
      r.check("easeOutBack is exact (≤ 1e-6 of the move)", back.worst <= 1e-6, back);
      r.metric("easeOutBack: max |AE − its cubic|", backCubic.worst, "normalized");
      const sine = segmentError(y, 0.5, 1.5, 300, 780, (u) => easeOf("easeInOutSine", u));
      const sineCubic = segmentError(y, 0.5, 1.5, 300, 780, (u) => cubicEase(CUBIC.easeInOutSineFit, u));
      r.metric("easeInOutSine best fit: max |AE − easeOf| (31 frames)", sine.worst, "normalized");
      r.check("easeInOutSine within 0.25%", sine.worst <= 0.0025, sine);
      r.metric("easeInOutSine: max |AE − the fitted cubic|", sineCubic.worst, "normalized");
      for (const d of [0, 1]) {
        const e = segmentError(sc, 0, 1, 100, d === 0 ? 150 : 80, (u) => easeOf("easeOutCubic", u), d);
        r.metric(`easeOutCubic on 2-D Scale dim ${d}: max |AE − easeOf|`, e.worst, "normalized");
        r.check(`Scale dim ${d} exact with 2 scene eases (padded to AE's 3)`, e.worst <= 1e-6, e);
      }
      r.check("hold keeps 100 until the next key", op.values[0] === 100 && op.values[1] === 100 && op.values[2] === 100, op.values);
      r.check("hold jumps to 40 at the key", op.values[3] === 40 && op.values[4] === 40, op.values);
      r.check("hold keys read back HOLD", op.keys[0].outInterp === "hold", op.keys[0]);
      r.fact("startTime-shifted layer (startTime 0.5): keyTime() of keys written at comp t=0.5 / 1.5", rot.keys.map((k: any) => k.t));
      r.fact("…and valueAtTime(0.5, 1.0, 1.5) (comp time)", rot.values);
      r.check(
        "key times are comp time: setValuesAtTimes(t) on a startTime-shifted layer reads back t",
        Math.abs(rot.keys[0].t - 0.5) < 1e-9 && Math.abs(rot.keys[1].t - 1.5) < 1e-9 && Math.abs(rot.values[1] - 45) < 1e-9,
        rot
      );
      r.fact("ease read back at the easeOutBack key (out)", x.keys[0].easeOut);
      r.check("interpolation reads back as written (x: linear→bezier, bezier→linear)",
        x.keys[0].inInterp === "linear" && x.keys[0].outInterp === "bezier" && x.keys[1].inInterp === "bezier" && x.keys[1].outInterp === "linear",
        x.keys.map((k: any) => [k.inInterp, k.outInterp]));
      r.check("ease reads back as written (speed 4701.58, influence 33.33)",
        Math.abs(x.keys[0].easeOut[0].speed - 4701.58) < 1e-6 && Math.abs(x.keys[0].easeOut[0].influence - 33.333333333333) < 1e-6, x.keys[0].easeOut);
      r.fact("Scale propertyValueType (2-D layer)", sc.pvt);
    },
  },

  "b-matte-blur": {
    samples: [{ comp: "B Matte Blur", layer: "Rig", path: ["ADBE Transform Group", "ADBE Position"], times: [0, 1, 2] }],
    trees: [{ comp: "B Matte Blur", layer: "Glow", path: ["ADBE Effect Parade"], depth: 4 }],
    render: { comp: "B Matte Blur", frames: [0, 25] },
    pixels: [
      // Screen of [255,128,26] over [13,26,77] in 8 bpc without linear blending.
      { frame: 0, x: 760, y: 300, want: [255, 141, 95, 255], tol: 3, label: "Screen of the glow over the background (inside the matte, outside the blur mask)" },
      { frame: 0, x: 835, y: 300, want: [255, 141, 95, 255], tol: 3, label: "right edge, outside the compositing mask: not blurred" },
      { frame: 0, x: 445, y: 300, pred: (c) => c[1] < 135 && c[1] > 26, label: "left edge, inside the compositing mask: blurred toward the background" },
      { frame: 0, x: 760, y: 480, want: [13, 26, 77, 255], tol: 2, label: "below the luma matte: background only" },
      { frame: 0, x: 760, y: 440, want: [13, 26, 77, 255], tol: 2, label: "frame 0: matte (parented to Rig) ends at y 420" },
      { frame: 25, x: 760, y: 440, want: [255, 141, 95, 255], tol: 3, label: "frame 25: Rig moved the matte down 30 px, so y 440 is inside" },
      { frame: 0, x: 100, y: 100, want: [13, 26, 77, 255], tol: 2, label: "the matte source itself is not rendered" },
    ],
    verify(p, r) {
      const glow = p.project.comps[0].layers.find((l: any) => l.name === "Glow");
      const matte = p.project.comps[0].layers.find((l: any) => l.name === "Matte");
      r.check("Gaussian Blur's compositing mask references mask 1", glow.effects[0].maskRefs.length === 1 && glow.effects[0].maskRefs[0] === 1, glow.effects);
      r.check("Gaussian Blur effect opacity 100", glow.effects[0].effectOpacity === 100, glow.effects[0]);
      r.check("the matte source reports isTrackMatte", matte.isTrackMatte === true, matte);
      r.check("Glow reads back SCREEN and LUMA", glow.blendingModeName === "SCREEN" && glow.trackMatteTypeName === "LUMA", [glow.blendingModeName, glow.trackMatteTypeName]);
      const rig = sampleOf(p, "Rig", "ADBE Position");
      r.check("spatial position without tangents moves in a straight line (±0.001 px)", Math.abs(rig.values[1][0] - 640) < 1e-9 && Math.abs(rig.values[1][1] - 390) < 1e-3, rig.values);
      r.metric("spatial position: |AE − linear| at the midpoint (arc-length sampling)", Math.abs(rig.values[1][1] - 390), "px");
      r.check("…and reads back zero spatial tangents", rig.keys.every((k: any) => k.spatialIn.every((v: number) => v === 0) && k.spatialOut.every((v: number) => v === 0)), rig.keys);
      const fx = p.trees[0]?.tree?.children?.[0];
      r.fact("Gaussian Blur 2 params (match name → value)", fx?.children?.filter((c: any) => c.type === "prop").map((c: any) => [c.mn, c.name, c.value]));
    },
  },

  "c-gradient": {
    svg: "footage/gradient.svg",
    otherCompTrees: 7,
    presetPaths: { ring: { groups: [0], item: 1 }, nested: { groups: [0, 0], item: 1 } },
    render: { comp: "Gradient", frames: [0] },
    pixels: [
      // "bar" uses ffx.ts's default path (group 0, item 2); its G-Fill is item 1.
      { frame: 0, x: 101, y: 150, want: [255, 0, 0, 255], tol: 4, label: "bar (preset path ≠ item): red stop at the start", guiOnly: true },
      { frame: 0, x: 250, y: 150, want: [128, 128, 0, 255], tol: 4, label: "bar: halfway red → green at 25%", guiOnly: true },
      { frame: 0, x: 400, y: 150, want: [0, 255, 0, 255], tol: 4, label: "bar: green stop at 50%", guiOnly: true },
      { frame: 0, x: 698, y: 150, want: [0, 0, 255, 255], tol: 4, label: "bar: blue stop at the end", guiOnly: true },
      { frame: 0, x: 350, y: 420, want: [255, 64, 255, 255], tol: 4, label: "ring (radial gradient stroke, exact path): 75% yellow → magenta", guiOnly: true },
      { frame: 0, x: 650, y: 330, want: [128, 128, 128, 255], tol: 4, label: "nested groups (exact path): black → white midpoint", guiOnly: true },
      { frame: 0, x: 600, y: 480, want: [128, 192, 128, 255], tol: 8, label: "SVG imported as shapes: cyan → orange midpoint" },
      // Shape layer seeded from the SVG at 50%: spans x 550..650, y 515..565.
      { frame: 0, x: 560, y: 530, want: [26, 242, 230, 255], tol: 10, label: "SVG-seeded shape layer keeps the native gradient (near the cyan end)" },
      { frame: 0, x: 600, y: 580, want: [255, 255, 255, 255], tol: 2, label: "…and the scene's own contents after it (white dot below the rect)" },
    ],
    verify(p, r) {
      if (p.build?.headless) {
        r.check("headless: build.jsx skipped all 3 presets with a warning (no crash)",
          (p.build.warnings ?? []).filter((w: string) => w.includes("not applied")).length === 3, p.build.warnings);
      }
      r.fact("ImportOptions.canImportAs on an SVG", p.svg);
      r.check("canImportAs(COMP_CROPPED_LAYERS) is true for an SVG", p.svg?.compCroppedLayers === true, p.svg);
      const svgComps = p.project.comps.filter((c: any) => c.name !== "Gradient");
      r.fact("SVG import: comps and layers", svgComps.map((c: any) => ({ name: c.name, w: c.width, h: c.height, layers: c.layers.map((l: any) => l.name + " (" + l.matchName + ")") })));
      const mns = JSON.stringify(p.trees ?? []);
      r.check("the SVG's gradient arrives as a native Gradient Fill", mns.includes("ADBE Vector Graphic - G-Fill"), "no G-Fill in the imported layers");
    },
  },

  "d-text": {
    samples: [
      { comp: "Text", layer: "Title", path: ["ADBE Text Properties", "ADBE Text Animators", 1, "ADBE Text Selectors", 1, "ADBE Text Percent Start"], times: [0, 0.5, 1] },
    ],
    trees: [{ comp: "Text", layer: "Title", path: ["ADBE Text Properties", "ADBE Text Animators"], depth: 6 }],
    render: { comp: "Text", frames: [0, 30] },
    regions: [
      { frame: 0, box: [240, 150, 1040, 300], max: 0.0005, label: "Title fully hidden by its opacity animator at frame 0" },
      { frame: 30, box: [240, 150, 1040, 300], min: 0.05, label: "Title visible once the selector start reaches 100%" },
      { frame: 0, box: [340, 420, 940, 620], min: 0.03, label: "Body box text renders" },
      { frame: 0, box: [300, 520, 980, 700], min: 0.005, label: "text on a mask path renders" },
    ],
    verify(p, r) {
      const L = (n: string) => p.project.comps[0].layers.find((l: any) => l.name === n);
      const t = L("Title").document;
      r.check("Title document: text (\\u2192 escape + quotes), font, size, tracking", t.text === "Toolbox \u2192 AE \"quoted\"" && t.font === "Arial-BoldMT" && t.fontSize === 96 && t.tracking === 50, t);
      r.check("Title document: fill and stroke", t.applyFill === true && t.applyStroke === true && t.strokeWidth === 4, t);
      const b = L("Body").document;
      r.check("Body is box text of 600 × 200", b.boxText === true && b.boxTextSize?.[0] === 600 && b.boxTextSize?.[1] === 200, b);
      r.check("Body leading 44", b.leading === 44 && b.autoLeading === false, b);
      r.fact("Body boxTextPos read back", b.boxTextPos);
      const o = L("On path").document;
      r.check("On path: allCaps", o.allCaps === true, o);
      r.check("Title and Body: not all caps, neutral faux/scale/baseline (the panel's last-used settings do not leak in)",
        [t, b].every((d: any) => d.allCaps === false && d.fauxBold === false && d.fauxItalic === false && d.horizontalScale === 1 && d.verticalScale === 1 && d.baselineShift === 0 && d.autoLeading === (d === t)),
        [t, b].map((d: any) => ({ allCaps: d.allCaps, fauxBold: d.fauxBold, fauxItalic: d.fauxItalic, h: d.horizontalScale, bs: d.baselineShift })));
      const sel = p.samples[0];
      r.check("selector start keys 0 → 100 over 1 s", sel && Math.abs(sel.values[1] - 50) < 1e-9 && sel.values[2] === 100, sel?.values);
      r.fact("build warnings (fonts)", p.build?.warnings);
    },
  },

  "e-kitchen-sink": {
    samples: [
      { comp: "Kitchen sink", layer: "Dot", path: ["ADBE Transform Group", "ADBE Position"], times: [0, 1, 2] },
      { comp: "Kitchen sink", layer: "Adjust", path: ["ADBE Transform Group", "ADBE Opacity"], times: [0, 0.5], preExpression: true },
      { comp: "Kitchen sink", layer: "Inner precomp", path: ["ADBE Time Remapping"], times: [0, 1, 2] },
      { comp: "Inner", layer: "Star", path: ["ADBE Root Vectors Group", 1, "ADBE Vectors Group", 4, "ADBE Vector Trim End"], times: [0, 0.5, 1] },
    ],
    trees: [
      { comp: "Inner", layer: "Star", path: ["ADBE Root Vectors Group"], depth: 8 },
      { comp: "Kitchen sink", layer: "Adjust", path: ["ADBE Effect Parade"], depth: 3 },
    ],
    render: { comp: "Kitchen sink", frames: [0, 24] },
    pixels: [{ frame: 0, x: 20, y: 980, pred: (c) => c[3] === 255, label: "base solid renders under the adjustment layer" }],
    verify(p, r) {
      const L = (n: string) => p.project.comps.find((c: any) => c.name === "Kitchen sink").layers.find((l: any) => l.name === n);
      const dot = sampleOf(p, "Dot", "ADBE Position");
      r.check("spatial tangents read back as written (z = 0 added on a 2-D layer)", JSON.stringify(dot.keys.map((k: any) => [k.spatialIn, k.spatialOut])) === JSON.stringify([[[0, 0, 0], [200, 0, 0]], [[-200, -300, 0], [0, 0, 0]]]),
        dot.keys.map((k: any) => [k.spatialIn, k.spatialOut]));
      const adj = sampleOf(p, "Adjust", "ADBE Opacity");
      r.check("expression applies without error (post-expression value at 0.5 s)", adj.expressionError === "" && Math.abs(adj.values[1] - (50 + 25 * Math.sin(1))) < 1e-6 && adj.pre[1] === 100,
        { err: adj.expressionError, values: adj.values, pre: adj.pre });
      const tr = sampleOf(p, "Inner precomp", "ADBE Time Remapping");
      r.check("time remap keys replace AE's defaults", tr.numKeys === 2 && Math.abs(tr.values[1] - 0.75) < 1e-9, tr);
      const trim = sampleOf(p, "Star", "ADBE Vector Trim End");
      r.check("keyed Trim Paths end inside a group", trim && Math.abs(trim.values[1] - 50) < 1e-9, trim?.values);
      r.check("3-D precomp layer", L("Inner precomp").threeDLayer === true);
      r.check("enabled: false hides the layer", L("Hidden").enabled === false);
      r.check("UTF-8 layer name survives the JSON reader", !!L("Path anim · café ✓"));
      r.check("blend modes read back: Dot CLASSIC_COLOR_DODGE, Blob silhouette alpha", L("Dot").blendingModeName === "CLASSIC_COLOR_DODGE" && /^SILHOUET+E_ALPHA$/.test(L("Path anim · café ✓").blendingModeName),
        [L("Dot").blendingModeName, L("Path anim · café ✓").blendingModeName]);
      const star = JSON.stringify(p.trees[0]?.tree ?? {});
      for (const mn of ["ADBE Vector Stroke Dash 3", "ADBE Vector Stroke Gap 3", "ADBE Vector Stroke Offset", "ADBE Vector Taper Start Width", "ADBE Vector Repeater Opacity 2", "ADBE Vector Merge Type", "ADBE Vector Offset Copies"])
        r.check(`Inner/Star contents hold ${mn}`, star.includes(`"mn":"${mn}"`));
      r.fact("Adjust effects", L("Adjust").effects);
      r.fact("build warnings", p.build?.warnings);
    },
  },
};

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

class Report {
  failures = 0;
  lines: string[] = [];
  data: Record<string, unknown> = {};
  constructor(private fixture: string) {}
  check(label: string, ok: boolean, detail?: unknown) {
    if (!ok) this.failures++;
    const extra = ok || detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 400)}`;
    this.lines.push(`  ${ok ? "ok  " : "FAIL"} ${label}${extra}`);
  }
  metric(label: string, v: number, unit: string) {
    this.data[label] = v;
    this.lines.push(`  num  ${label}: ${unit === "normalized" ? `${(v * 100).toFixed(5)}%` : `${v} ${unit}`}`);
  }
  fact(label: string, v: unknown) {
    this.data[label] = v;
    this.lines.push(`  fact ${label}: ${JSON.stringify(v)}`);
  }
  print() {
    console.log(`\n${this.fixture}`);
    for (const l of this.lines) console.log(l);
  }
}

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

function gradientItems(items: AeShapeItem[], out: Extract<AeShapeItem, { kind: "gradient-fill" | "gradient-stroke" }>[] = []) {
  for (const it of items) {
    if (it.kind === "group") gradientItems(it.contents, out);
    else if (it.kind === "gradient-fill" || it.kind === "gradient-stroke") out.push(it);
  }
  return out;
}

function writePackage(name: string, scene: AeScene, raw: string, probe: Probe): string {
  const dir = join(WORK, `${name}.aepkg`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "presets"), { recursive: true });
  mkdirSync(join(dir, "footage"), { recursive: true });
  mkdirSync(join(dir, "renders"), { recursive: true });
  // Verbatim, so the fixtures' \\u escapes and raw UTF-8 both reach build.jsx.
  writeFileSync(join(dir, "scene.json"), raw);
  copyFileSync(BUILD_JSX, join(dir, "build.jsx"));
  const grads = scene.comps.flatMap((c) => c.layers.flatMap((l) => gradientItems(l.contents ?? [])));
  for (const p of scene.presets) {
    const it = grads.find((g) => g.preset === p.id);
    if (!it) throw new Error(`${name}: preset ${p.id} has no gradient item`);
    writeFileSync(join(dir, p.path), synthesizeGradientPreset({ kind: it.kind === "gradient-stroke" ? "stroke" : "fill", stops: it.stops, path: probe.presetPaths?.[p.id] }));
  }
  return dir;
}

async function writeFootage(dir: string, scene: AeScene) {
  for (const f of scene.footage) {
    const dest = join(dir, f.path);
    mkdirSync(dirname(dest), { recursive: true });
    const asset = join(FIXTURES, "assets", basename(f.path));
    if (existsSync(asset)) copyFileSync(asset, dest);
    else if (basename(f.path) === "dot.png") {
      // A 64×64 straight-alpha disc, generated so no binary lives in the repo.
      const n = 64;
      const px = Buffer.alloc(n * n * 4);
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          const d = Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2);
          const o = (y * n + x) * 4;
          px[o] = 255;
          px[o + 1] = 200;
          px[o + 2] = 0;
          px[o + 3] = d < 28 ? 255 : 0;
        }
      await sharp(px, { raw: { width: n, height: n, channels: 4 } }).png().toFile(dest);
    } else throw new Error(`no asset for ${f.path}`);
  }
}

const js = (v: unknown) => JSON.stringify(v).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

function driverSource(pkgs: { name: string; dir: string; probe: Probe; scene: AeScene }[]): string {
  const L = [
    "// Generated by scripts/ae-export-spike/run.mts — one spike run.",
    "$.global.TBX_AE_QUIET = true;",
    "$.global.TBX_AE_OVERWRITE = true;",
    "app.setSavePreferencesOnQuit(false);",
    "(function () {",
    "  function note(dir, name, e) {",
    "    var f = new File(dir + '/' + name); f.encoding = 'UTF-8'; f.lineFeed = 'Unix';",
    "    if (f.open('w')) { f.write(String(e) + (e && e.line ? ' (line ' + e.line + ')' : '') + '\\n'); f.close(); }",
    "  }",
  ];
  for (const p of pkgs) {
    const cfg = {
      out: join(p.dir, "probe.json"),
      samples: p.probe.samples ?? [],
      trees: p.probe.trees ?? [],
      svg: p.probe.svg ? join(p.dir, p.probe.svg) : undefined,
      otherCompTrees: p.probe.otherCompTrees ? { exclude: p.scene.comps.map((c) => c.name), depth: p.probe.otherCompTrees } : undefined,
      render: p.probe.render ? [{ comp: p.probe.render.comp, frames: p.probe.render.frames, dir: join(p.dir, "renders"), prefix: "rq" }] : [],
    };
    L.push(
      `  $.global.TBX_AE_PACKAGE = ${js(p.dir)};`,
      "  $.global.TBX_AE_RESULT = null;",
      `  try { $.evalFile(new File(${js(join(p.dir, "build.jsx"))})); } catch (e) { note(${js(p.dir)}, 'driver-build-error.txt', e); }`,
      `  $.global.TBX_SPIKE_PROBE = ${js(cfg)};`,
      `  try { $.evalFile(new File(${js(join(HERE, "probe.jsx"))})); } catch (e) { note(${js(p.dir)}, 'driver-probe-error.txt', e); }`
    );
  }
  L.push("}());", "");
  return L.join("\n");
}

function removeHook() {
  if (existsSync(HOOK)) rmSync(HOOK);
}

function runAerender(env: Record<string, string>, aeArgs: string[], log: string): Promise<number> {
  return new Promise((res) => {
    const child = spawn(AERENDER, aeArgs, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => chunks.push(d));
    child.on("close", (code) => {
      writeFileSync(log, Buffer.concat(chunks));
      res(code ?? -1);
    });
  });
}

async function readTiff(path: string) {
  const img = sharp(path);
  const meta = await img.metadata();
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height, channels: info.channels, meta };
}

// rq_f<frame>_<n>.tif (probe-queued) or cli_<frame>.tif (aerender -s/-e).
function framesIn(dir: string, prefix: string): Map<number, string> {
  const out = new Map<number, string>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const q = new RegExp(`^${prefix}_f(\\d+)_\\d+\\.tif$`).exec(f);
    const c = new RegExp(`^${prefix}_(\\d+)\\.tif$`).exec(f);
    if (q) out.set(parseInt(q[1], 10), join(dir, f));
    else if (c) out.set(parseInt(c[1], 10), join(dir, f));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const fixtureFiles = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".scene.json"))
  .filter((f) => !filters.length || filters.some((x) => f.includes(x)))
  .sort();
if (!fixtureFiles.length) throw new Error("no fixtures matched");
mkdirSync(WORK, { recursive: true });
console.log(`packages: ${WORK}`);

const pkgs: { name: string; dir: string; probe: Probe; scene: AeScene }[] = [];
for (const f of fixtureFiles) {
  const name = f.replace(/\.scene\.json$/, "");
  const raw = readFileSync(join(FIXTURES, f), "utf8");
  const scene = JSON.parse(raw) as AeScene;
  const dir = writePackage(name, scene, raw, PROBES[name] ?? {});
  await writeFootage(dir, scene);
  pkgs.push({ name, dir, probe: PROBES[name] ?? {}, scene });
}
if (noAe) {
  console.log(`wrote ${pkgs.length} package(s); --no-ae, not running After Effects`);
  process.exit(0);
}
if (!existsSync(AERENDER)) throw new Error(`aerender not found at ${AERENDER} (set AE_DIR)`);
const prefsTxt = join(PREFS, `Adobe After Effects ${PREFS_VERSION} Prefs.txt`);
if (existsSync(prefsTxt) && !/"Pref_SCRIPTING_FILE_NETWORK_SECURITY" = "1"/.test(readFileSync(prefsTxt, "latin1"))) {
  console.log("note: \"Allow Scripts to Write Files and Access Network\" looks OFF — probe.json cannot be written. Not changing it.");
}

const driver = join(WORK, "driver.jsx");
writeFileSync(driver, driverSource(pkgs));
const last = pkgs[pkgs.length - 1];
const lastMain = last.scene.comps.find((c) => c.id === last.scene.main)!;
const cliFrame = last.probe.render?.frames[0] ?? 0;
const aeArgs = [
  "-project", join(WORK, `${last.name}.aep`),
  "-comp", lastMain.name,
  "-RStemplate", "Best Settings",
  "-OMtemplate", "TIFF Sequence with Alpha",
  "-output", join(last.dir, "renders", "cli_[#####].tif"),
  "-s", String(cliFrame),
  "-e", String(cliFrame),
  "-sound", "OFF",
];

removeHook();
mkdirSync(STARTUP, { recursive: true });
copyFileSync(join(HERE, "hook.jsx"), HOOK);
const cleanup = () => removeHook();
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
const t0 = Date.now();
let code: number;
try {
  code = await runAerender({ TBX_AE_SPIKE_DRIVER: driver }, aeArgs, join(WORK, "aerender.log"));
} finally {
  removeHook();
}
const seconds = (Date.now() - t0) / 1000;
console.log(`aerender (build + probe) exited ${code} after ${seconds.toFixed(1)} s (log: ${join(WORK, "aerender.log")}); startup hook removed: ${!existsSync(HOOK)}`);

// The probes queued their frames in each saved project; a plain aerender
// launch per project renders them (no hook involved).
const renderSeconds: Record<string, number> = {};
for (const p of pkgs) {
  if (!p.probe.render) continue;
  const t1 = Date.now();
  const rc = await runAerender({}, ["-project", join(WORK, `${p.name}.aep`), "-sound", "OFF"], join(WORK, `aerender-${p.name}.log`));
  renderSeconds[p.name] = (Date.now() - t1) / 1000;
  console.log(`aerender -project ${p.name}.aep exited ${rc} after ${renderSeconds[p.name].toFixed(1)} s`);
}

let failures = 0;
const results: Record<string, unknown> = { aerenderExit: code, seconds, renderSeconds, work: WORK };
for (const p of pkgs) {
  const r = new Report(p.name);
  for (const err of ["driver-build-error.txt", "driver-probe-error.txt", "hook-error.txt"]) {
    const ef = join(p.dir, err);
    if (existsSync(ef)) r.check(err, false, readFileSync(ef, "utf8"));
  }
  const probePath = join(p.dir, "probe.json");
  if (!existsSync(probePath)) {
    r.check("probe.json written", false, "missing");
    r.print();
    failures += r.failures;
    continue;
  }
  const probe = JSON.parse(readFileSync(probePath, "utf8"));
  // Times the probe sampled, for the error measures.
  probe.samples?.forEach((s: any, i: number) => s && (s.timesUsed = p.probe.samples![i].times));
  const build = probe.build;
  r.check("build.jsx finished ok", build?.ok === true, build?.problems);
  r.check("no build problems", (build?.problems ?? ["missing"]).length === 0, build?.problems);
  if (build?.warnings?.length) r.fact("build warnings", build.warnings);
  r.check(`saved ${p.name}.aep next to the package`, typeof build?.saved === "string" && existsSync(build.saved), build?.saved);
  r.check("build-log.json written", existsSync(join(p.dir, "build-log.json")));
  r.fact("build seconds", build?.seconds);
  r.fact("$.fileName inside an $.evalFile'd script", probe.fileName);
  if (probe.errors?.length) r.check("probe errors", false, probe.errors);
  r.fact("output module", probe.outputModule);
  const proj = probe.project;
  r.fact("project settings read back", {
    bitsPerChannel: proj?.bitsPerChannel, workingSpace: proj?.workingSpace, linearBlending: proj?.linearBlending,
    linearizeWorkingSpace: proj?.linearizeWorkingSpace, expressionEngine: proj?.expressionEngine,
  });
  const ps = p.scene.project;
  r.check("project settings took", proj && proj.bitsPerChannel === ps.bitsPerChannel && proj.linearBlending === ps.linearBlending &&
    (ps.workingSpace === undefined || proj.workingSpace === ps.workingSpace) && proj.expressionEngine === ps.expressionEngine, proj);
  // Layer order: scene layers[0] = AE index 1.
  for (const c of p.scene.comps) {
    const ac = proj?.comps?.find((x: any) => x.name === c.name);
    const names = ac?.layers?.map((l: any) => l.name);
    r.check(`${c.name}: layer order matches the scene (top first)`, JSON.stringify(names) === JSON.stringify(c.layers.map((l) => l.name)), names);
    for (const l of c.layers) {
      const al = ac?.layers?.find((x: any) => x.name === l.name);
      if (!al) continue;
      const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
      r.check(`${c.name}/${l.name}: in/out/start`, near(al.inPoint, l.inPoint) && near(al.outPoint, l.outPoint) && near(al.startTime, l.startTime),
        [al.inPoint, al.outPoint, al.startTime]);
      if (l.origin?.length) r.check(`${c.name}/${l.name}: origin in the layer comment`, al.comment === `toolbox: ${l.origin.join(", ")}`, al.comment);
      if (l.parent) {
        const pn = c.layers.find((x) => x.id === l.parent)?.name;
        r.check(`${c.name}/${l.name}: parent`, al.parent === pn, al.parent);
      }
      if (l.matte) {
        const mn = c.layers.find((x) => x.id === l.matte!.layer)?.name;
        r.check(`${c.name}/${l.name}: track matte by reference → ${mn} (${l.matte.type})`, al.trackMatteLayer === mn && al.hasTrackMatte === true, al);
        r.fact(`${c.name}/${l.name}: trackMatteType read back`, al.trackMatteType);
      }
    }
  }
  p.probe.verify?.(probe, r);

  // Pixels.
  const rq = framesIn(join(p.dir, "renders"), "rq");
  if (p.probe.render) {
    r.check(`rendered ${p.probe.render.frames.length} frame(s) as TIFF`, p.probe.render.frames.every((f) => rq.has(f)), [...rq.keys()]);
    r.fact("render queue status", probe.renderStatus);
  }
  const decoded = new Map<number, Awaited<ReturnType<typeof readTiff>>>();
  for (const [f, path] of rq) decoded.set(f, await readTiff(path));
  const first = decoded.values().next().value;
  if (first) r.fact("TIFF as decoded", { width: first.width, height: first.height, channels: first.channels, depth: first.meta.depth, bitsPerSample: first.meta.bitsPerSample, extraSamples: (first.meta as any).extraSamples });
  const headless = build?.headless === true;
  for (const px of p.probe.pixels ?? []) {
    if (px.guiOnly && headless) {
      r.lines.push(`  n/a  frame ${px.frame} (${px.x}, ${px.y}) ${px.label} — headless build, preset not applied`);
      continue;
    }
    const img = decoded.get(px.frame);
    if (!img) {
      r.check(px.label, false, `frame ${px.frame} not rendered`);
      continue;
    }
    const o = (px.y * img.width + px.x) * 4;
    const a = img.data[o + 3];
    // AE writes premultiplied TIFFs ("Premultiplied (Matted)" in the
    // template): unpremultiply for straight-alpha expectations.
    const un = (c: number) => (a ? Math.round((c * 255) / a) : 0);
    const got = [un(img.data[o]), un(img.data[o + 1]), un(img.data[o + 2]), a];
    const tol = px.tol ?? 2;
    const ok = px.pred ? px.pred(got) : px.want!.every((w, i) => w === null || Math.abs(got[i] - w) <= tol);
    r.check(`frame ${px.frame} (${px.x}, ${px.y}) ${px.label}`, ok, { got, want: px.want ?? "predicate" });
  }
  for (const rg of p.probe.regions ?? []) {
    const img = decoded.get(rg.frame);
    if (!img) {
      r.check(rg.label, false, `frame ${rg.frame} not rendered`);
      continue;
    }
    const [x0, y0, x1, y1] = rg.box;
    let on = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (img.data[(y * img.width + x) * 4 + 3] > 0) on++;
    const cov = on / ((x1 - x0) * (y1 - y0));
    r.check(`frame ${rg.frame} ${rg.label} (coverage ${cov.toFixed(4)})`, (rg.min === undefined || cov >= rg.min) && (rg.max === undefined || cov <= rg.max), cov);
  }
  if (p === last) {
    const cli = framesIn(join(p.dir, "renders"), "cli").get(cliFrame);
    r.check(`aerender -s ${cliFrame} -e ${cliFrame} -OMtemplate "TIFF Sequence with Alpha" wrote one frame`, !!cli);
    const mine = decoded.get(cliFrame);
    if (cli && mine) {
      const other = await readTiff(cli);
      const m = compareRgba(mine.data, other.data, mine.width, mine.height);
      r.fact("compareRgba(render-queue frame, aerender CLI frame)", m);
      r.check("the CLI render matches the render-queue render", m.verdict === "match" && m.meanAbs === 0, m);
    }
  }
  r.print();
  failures += r.failures;
  results[p.name] = { failures: r.failures, data: r.data };
}
writeFileSync(join(WORK, "results.json"), JSON.stringify(results, null, 2));
console.log(failures ? `\nspike: ${failures} FAILED (results: ${join(WORK, "results.json")})` : `\nspike: all checks passed (results: ${join(WORK, "results.json")})`);
process.exit(failures ? 1 : 0);
