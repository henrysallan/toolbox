// check-skia-native: the Reanimated-native export mode gate
// (`animation: "native"`, src/lib/skia-export/emit-native.ts;
// specdocs/101326_skia-target.md §3.5c, §1.3). No GPU, no device:
//
//   1. the easing table (NATIVE_EASINGS) against Reanimated 4.7's own Easing:
//      every toolbox easing has a row; "exact" rows equal toolbox's easeOf
//      bit for bit, "ulp" rows to ≤ 1e-15 (and not exactly — the class is
//      honest), each "custom" row's nearest Reanimated function misses by
//      > 1e-4, Easing.bezier lands within BEZIER_TOLERANCE for ordinary
//      shapes and the emitter swaps in toolbox's solver for one that misses.
//      Reanimated's Easing is the transcription in reanimated-easing.ts —
//      and, when skia-harness is installed, the real
//      node_modules/react-native-reanimated/src/Easing.ts too, asserted
//      bit-identical to it;
//   2. the emitted code for every easing kind matches
//      scripts/fixtures/skia/snapshots/native-*/ (--update rewrites them);
//   3. playback: every native value, played by a Reanimated stand-in
//      (scripts/skia/reanimated-sim.ts — and Reanimated's real animation
//      sources when installed, asserted to play the same doubles) on a steady
//      60 Hz display clock, stays within 2e-5 of its range of the worklet
//      value at every frame, with no frame of lag — web and native start
//      semantics alike; jittered clocks are reported, not asserted;
//   3c. playSegment(…, { from: "current" }) from another frame's values:
//      scalars start exactly where they are, colors within 1/255 of the color
//      on screen, a color's fade runs on its first move's timing and easing
//      (1 − its eased fraction; a linear glide over a lead; a hold's wait),
//      and every value joins from "start"'s frames by the end of that move
//      and stays — the transcription and Reanimated's real sources alike;
//   4. color progress mapping: colorAt(track, progresses) is evaluateTrack's
//      color, bit for bit, for every segment of every color track (OKLab, RGB,
//      holds, overshooting easings, springs, 8-bit snaps with keyed or node
//      alpha);
//   5. refusals and edge cases (unknown easing, a customBezier that can't be a
//      withTiming, a segment running at frame 0, springs, keys past the end),
//      and the worklet default staying byte-identical;
//   6. the emitted bundles type-check in skia-harness (react-native-skia 3.4.0
//      + Reanimated 4.7; skipped with a notice without skia-harness/
//      node_modules, SKIA_HARNESS_REQUIRED=1 fails instead), and the harness
//      slots (src/bundle-native*) are what the exporter writes today;
//   7. worklet declaration order: no top-level worklet in the shipped runtime
//      or an emitted module calls one declared below it (the worklets Babel
//      plugin makes them non-hoisted consts, so that throws "Cannot access …
//      before initialization" on device and on React Native web).
//
//   npx tsx scripts/check-skia-native.mts [--update]

/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotDrift } from "./skia/snapshot-diff.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UPDATE = process.argv.includes("--update");

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { exportSkia } = await import("@/lib/skia-export");
const native = await import("@/lib/skia-export/emit-native");
const { ReanimatedEasing } = await import("@/lib/skia-export/reanimated-easing");
const rt = await import("@/lib/skia-export/runtime/toolbox-timeline");
const { EASING_PRESET_ORDER } = await import("@/engine/keyframes");
const { springToReanimated } = await import("@/lib/skia-export/spring");
const { loadNativeModule, playNative, playNativeFromCurrent, driftRows, realReanimatedAvailable, HARNESS_REANIMATED } = await import("./skia/native-drift.ts");
const { frameTime } = await import("./skia/reanimated-sim.ts");
const { checkExportable, typecheckBundle } = await import("./skia/export-check.ts");
const aurora = await import("./fixtures/skia/aurora.ts");
const { auroraSceneGraph } = await import("./fixtures/skia/aurora-scene-graph.ts");
const easings = await import("./fixtures/skia/easings-graph.ts");
const sceneFx = await import("./fixtures/skia/scene-fixture.ts");
import type { GraphNode } from "@/engine/evaluator";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${!cond && detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
function note(s: string) {
  console.log(`     ${s}`);
}

const runtimeSource = fs.readFileSync(path.join(ROOT, "src/lib/skia-export/runtime/toolbox-timeline.ts"), "utf8");
const CANVAS = { width: 512, height: 512 };

// ---- the bundles under test -------------------------------------------------------------
type Files = Record<string, string>;
function exportNative(g: { nodes: GraphNode[]; edges: any[]; targetId: string }, timeline: any, name: string, animation: "native" | "worklet" | undefined = "native") {
  return exportSkia({ nodes: g.nodes, edges: g.edges, targetId: g.targetId, name, canvas: CANVAS, timeline, runtimeSource, animation });
}
const auroraG = aurora.auroraGraph();
// The harness slots ship lane B's AURORA_MARKERS (export-skia.mts does the same).
const AURORA_TL = { ...aurora.AURORA_TIMELINE, markers: aurora.AURORA_MARKERS };
const bundles: { name: string; slot: string; timeline: any; files: Files }[] = [];
{
  const a = exportNative(auroraG, AURORA_TL, "Aurora");
  const e = exportNative(easings.easingsGraph(), easings.EASINGS_TIMELINE, "Easings");
  const s = exportNative({ ...auroraSceneGraph(aurora.AURORA_SKSL), targetId: "skc" }, AURORA_TL, "Aurora (Skia layer)");
  check("Aurora (SkSL Shader) exports in native mode", !!a.files, a.problems.join(" | "));
  check("the every-easing fixture exports in native mode", !!e.files, e.problems.join(" | "));
  check("Aurora (Skia layer) exports in native mode", !!s.files, s.problems.join(" | "));
  if (a.files) bundles.push({ name: "native-aurora", slot: "bundle-native", timeline: AURORA_TL, files: a.files });
  if (e.files) bundles.push({ name: "native-easings", slot: "bundle-native-easings", timeline: easings.EASINGS_TIMELINE, files: e.files });
  if (s.files) bundles.push({ name: "native-aurora-scene", slot: "bundle-native-scene", timeline: AURORA_TL, files: s.files });
}
const byName = (n: string) => bundles.find((b) => b.name === n)!;
const manifestOf = (f: Files) => JSON.parse(f["manifest.json"]);

// ---- 1. the easing table vs Reanimated's Easing ------------------------------------------
const realEasingPath = path.join(HARNESS_REANIMATED, "src", "Easing.ts");
// SKIA_NATIVE_TRANSCRIPTION=1 forces the CI path (no harness): transcriptions only.
const useReal = !process.env.SKIA_NATIVE_TRANSCRIPTION && realReanimatedAvailable() && fs.existsSync(realEasingPath);
let realEasing: any = null;
if (useReal) {
  const version = JSON.parse(fs.readFileSync(path.join(HARNESS_REANIMATED, "package.json"), "utf8")).version;
  check(`skia-harness pins react-native-reanimated ${native.NATIVE_REANIMATED_VERSION} (found ${version})`, version === native.NATIVE_REANIMATED_VERSION);
  realEasing = (await import(realEasingPath)).Easing;
  note(`Reanimated Easing: imported from ${path.relative(ROOT, realEasingPath)} AND transcribed (src/lib/skia-export/reanimated-easing.ts), asserted identical`);
} else {
  if (process.env.SKIA_HARNESS_REQUIRED && !process.env.SKIA_NATIVE_TRANSCRIPTION) check("skia-harness has node_modules (npm --prefix skia-harness install)", false);
  note(
    `Reanimated Easing + animations: transcribed only (src/lib/skia-export/reanimated-easing.ts, scripts/skia/reanimated-sim.ts) — ${process.env.SKIA_NATIVE_TRANSCRIPTION ? "SKIA_NATIVE_TRANSCRIPTION is set" : "skia-harness/node_modules is not installed"}`
  );
}
const evalEasing = (E: any, code: string): ((t: number) => number) => {
  const v = new Function("Easing", `return ${code};`)(E);
  return typeof v === "function" ? v : v.factory();
};
const GRID: number[] = [];
for (let i = 0; i <= 20000; i++) GRID.push(i / 20000);
let seed = 12345;
const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
for (let i = 0; i < 20000; i++) GRID.push(rand());
GRID.push(1e-9, 0.5 - 1e-12, 0.5, 0.5 + 1e-12, 1 - 1e-9, 1 / 2.75, 2 / 2.75, 2.5 / 2.75);
const maxDiff = (f: (t: number) => number, g: (t: number) => number) => GRID.reduce((m, t) => Math.max(m, Math.abs(f(t) - g(t))), 0);

{
  // Transcription == the real source.
  if (realEasing) {
    const exprs = [
      ...native.NATIVE_EASINGS.flatMap((r) => [r.reanimated, r.candidate]).filter((x): x is string => !!x && !x.includes("(x1") && !x.includes("normalised") && !x.startsWith("withSpring")),
      "Easing.bezier(0.42, 0, 0.58, 1)",
      "Easing.bezier(0.2, 1.6, 0.3, -0.4)",
      "Easing.bezier(1, 0, 0, 1)",
      "Easing.steps(1, false)",
    ];
    const bad = exprs.filter((c) => GRID.some((t) => !Object.is(evalEasing(ReanimatedEasing, c)(t), evalEasing(realEasing, c)(t))));
    check(`the Easing transcription plays Reanimated's own source bit for bit (${exprs.length} expressions × ${GRID.length} t)`, !bad.length, bad.join(", "));
  }
  const E = realEasing ?? ReanimatedEasing;
  const all = [...new Set([...EASING_PRESET_ORDER, "easeIn", "easeOut", "easeInOut", "cubicBezier", "spring"])];
  const rows = new Map(native.NATIVE_EASINGS.map((r) => [r.easing, r]));
  const missing = all.filter((e) => !rows.has(e));
  check(`every toolbox easing has a native mapping row (${all.length})`, !missing.length, missing.join(", "));
  const table: string[] = [];
  for (const r of native.NATIVE_EASINGS) {
    if (r.cls === "exact" || r.cls === "ulp") {
      const d = maxDiff(evalEasing(E, r.reanimated!), (t) => rt.easeOf(r.easing, t));
      table.push(`${r.easing.padEnd(15)} ${r.reanimated!.padEnd(34)} ${r.cls.padEnd(6)} max |Δ| ${d.toExponential(1)}`);
      if (r.cls === "exact") check(`${r.easing} → ${r.reanimated} is toolbox's curve bit for bit`, d === 0, `max |Δ| ${d}`);
      else check(`${r.easing} → ${r.reanimated} equals toolbox's to the last ulp (and isn't bit-exact)`, d > 0 && d <= 1e-15, `max |Δ| ${d}`);
    } else if (r.cls === "custom") {
      const d = maxDiff(evalEasing(E, r.candidate!), (t) => rt.easeOf(r.easing, t));
      table.push(`${r.easing.padEnd(15)} ${"toolbox's easeOf (worklet)".padEnd(34)} custom candidate ${r.candidate} misses by ${d.toExponential(1)}`);
      check(`${r.easing}: Reanimated's ${r.candidate} is NOT toolbox's curve (max |Δ| ${d.toExponential(2)}), so it ships toolbox's`, d > 1e-4);
    } else table.push(`${r.easing.padEnd(15)} ${(r.reanimated ?? "—").padEnd(34)} ${r.cls}`);
  }
  for (const line of table) note(line);

  // Easing.bezier: within tolerance for ordinary shapes, swapped for steep ones.
  const ok = [
    { x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
    { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 },
    { x1: 0.2, y1: 1.6, x2: 0.3, y2: -0.4 },
    { x1: 0.9, y1: 0, x2: 0.1, y2: 1 },
  ];
  const steep = [
    { x1: 1, y1: 0, x2: 0, y2: 1 },
    { x1: 0, y1: 1, x2: 1, y2: 0 },
  ];
  for (const b of ok) {
    const fromReal = maxDiff(evalEasing(E, `Easing.bezier(${b.x1}, ${b.y1}, ${b.x2}, ${b.y2})`), (t) => rt.cubicBezierEase(b, t));
    check(`Easing.bezier(${Object.values(b).join(", ")}) lands within ${native.BEZIER_TOLERANCE} of toolbox's solver (${fromReal.toExponential(1)})`, fromReal <= native.BEZIER_TOLERANCE * 1.5 && native.bezierSolverError(b) <= native.BEZIER_TOLERANCE);
  }
  for (const b of steep) {
    check(`Easing.bezier(${Object.values(b).join(", ")}) misses toolbox's curve (${native.bezierSolverError(b).toExponential(1)}), so the emitter refuses to use it`, native.bezierSolverError(b) > native.BEZIER_TOLERANCE);
  }
}

// ---- 2. snapshots -------------------------------------------------------------------------------
const SNAP = path.join(ROOT, "scripts/fixtures/skia/snapshots");
function readTree(dir: string, base = dir): Files {
  const out: Files = {};
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) Object.assign(out, readTree(p, base));
    else out[path.relative(base, p).replace(/\.snap$/, "")] = fs.readFileSync(p, "utf8");
  }
  return out;
}
function snapshot(name: string, got: Files) {
  const dir = path.join(SNAP, name);
  const want = Object.fromEntries(Object.entries(got).filter(([f]) => f !== "toolbox-timeline.ts"));
  if (UPDATE) {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [f, text] of Object.entries(want)) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, `${f}.snap`), text);
    }
    note(`updated snapshots/${name} (${Object.keys(want).length} files)`);
    return;
  }
  const have = readTree(dir);
  const names = [...new Set([...Object.keys(have), ...Object.keys(want)])].sort();
  let drift = "";
  for (const f of names) {
    if (!(f in have)) drift ||= `${f} is new (run with --update)`;
    else if (!(f in want)) drift ||= `${f} is no longer emitted`;
    // Text exact, numbers to 1e-12: raw doubles differ in the last ulp
    // between V8 builds (snapshots written on macOS, CI on Linux).
    else drift ||= snapshotDrift(f, have[f], want[f]);
  }
  check(`emitted files match snapshots/${name} (${names.length} files)`, !drift, drift ? `${drift}\n       (npx tsx scripts/check-skia-native.mts --update after a deliberate change)` : "");
}
for (const b of bundles) snapshot(b.name, b.files);
{
  const e = byName("native-easings")?.files["animations.ts"] ?? "";
  const kinds: [string, RegExp][] = [
    ["exact Reanimated easings", /easing: Easing\.inOut\(Easing\.quad\)/],
    ["last-ulp Reanimated easings", /easing: Easing\.out\(Easing\.back\(1\.70158\)\)/],
    ["toolbox worklet easings (expo, elastic)", /const tbxEaseInExpo = \(t: number\) => \{\n {2}"worklet";\n {2}return easeOf\("easeInExpo", t\);/],
    ["Easing.bezier for an ordinary cubic", /Easing\.bezier\(0\.42, 0, 0\.58, 1\)/],
    ["toolbox's solver for a steep cubic", /return cubicBezierEase\(TBXBEZIER0_SHAPE, t\)/],
    ["normalised customBezier handles", /Easing\.bezier\(0\.45, 1\.3, 0\.8, 1\.4\)/],
    ["holds as withDelay + an instant withTiming", /withDelay\(frames\(93\), withTiming\(0\.2, \{ duration: 0 \}\)\)/],
    ["a leading hold as a stepped withTiming", /withTiming\(1, \{ duration: frames\(57\), easing: Easing\.steps\(1, false\) \}\)/],
    ["the lead as a timed wait", /\/\/ f0 → f10 wait at 0\n\s+withTiming\(0, \{ duration: frames\(10\), easing: Easing\.linear \}\)/],
    ["springs as withSpring (physics config)", /withSpring\(1, \{ stiffness: [\d.]+, damping: [\d.]+, mass: 1, velocity: 0, overshootClamping: false, energyThreshold: 6e-9 \}\)/],
    ["a rest wait after an early-settling spring", /\/\/ … rest at 1 to f57\n\s+withTiming\(1, \{ duration: frames\(19\)/],
    ["color progress shared values", /export function c_oklabProgress2Animation/],
    ["a spring on a color's progress", /withDelay\(frames\(30\), withSpring\(1, /],
    // (with segments: colorFrom — colorAt plus the from "current" fade, colorAt exactly at weight 0)
    ["the colorAt mix in a derived value", /useDerivedValue\(\(\) => colorFrom\(TRACKS\.c_oklab, \[c_oklabProgress0\.value, c_oklabProgress1\.value, c_oklabProgress2\.value\], c_oklabFromOffset\.value, c_oklabFromWeight\.value\)\)/],
    ["a color's from-\"current\" fade per segment", /export function c_oklabFromSegmentAnimation\(segment: SegmentName\): number/],
    ["one frame-aligned start for every value", /scheduleOnUI\(\(\) => \{\n\s+"worklet";\n(\s+\/\/[^\n]*\n)+\s+requestAnimationFrame\(\(\) => \{/],
  ];
  for (const [what, re] of kinds) check(`emitted animations.ts writes ${what}`, re.test(e));
  const fx = manifestOf(byName("native-easings").files).native;
  const cls = new Set(fx.values.flatMap((v: any) => v.steps.map((s: any) => s.class)));
  check(`the fixture covers every mapping class (${[...cls].sort().join(", ")})`, ["exact", "ulp", "solver", "custom", "hold", "physics"].every((c) => cls.has(c)));
}

// ---- 3. playback on a steady 60 Hz clock ---------------------------------------------------------
const steady = { fps: 60 };
for (const b of bundles) {
  const m = manifestOf(b.files).native;
  const h = await loadNativeModule(b.files);
  const frames = b.timeline.sceneDurationTicks / b.timeline.ticksPerFrame;
  for (const platform of ["web", "native"] as const) {
    const series = playNative(h.mod, m, frames, steady, platform);
    const rows = driftRows(series, h.mod.TRACKS, h.mod.evaluateTrack, b.timeline);
    const bad = rows.filter((r) =>
      r.kind === "color" ? r.maxAbs > 1 / 255 + 1e-12 : r.range > 0 ? r.maxAbs / r.range > 2e-5 : r.maxAbs > 1e-12
    );
    const lag = rows.reduce((n, r) => n + r.lagOne, 0);
    const worst = rows.reduce((a, r) => Math.max(a, r.kind === "color" ? 0 : r.maxAbs / (r.range || 1)), 0);
    check(
      `${b.name} (${platform} start): ${rows.length} values × ${frames} frames within 2e-5 of range of the worklet value (worst ${worst.toExponential(1)}), no frame of lag`,
      !bad.length && lag === 0,
      `${bad.map((r) => `${r.key} ${r.maxAbs.toExponential(2)} @f${r.maxAt}`).join(", ")}${lag ? ` · ${lag} frames one late` : ""}`
    );
  }
  if (useReal) {
    const real = await loadNativeModule(b.files, { reanimated: "real" });
    let differ = 0;
    for (const clock of [steady, { fps: 60, jitterMs: 0.5, seed: 3 }]) {
      for (const platform of ["web", "native"] as const) {
        const a = playNative(h.mod, m, frames, clock, platform);
        const c = playNative(real.mod, m, frames, clock, platform);
        for (const k of Object.keys(a)) a[k].forEach((v, f) => (JSON.stringify(v) === JSON.stringify(c[k][f]) ? 0 : differ++));
      }
    }
    real.dispose();
    check(`${b.name}: the simulator plays what Reanimated 4.7's real animation sources play, bit for bit (steady + jittered clock, both starts)`, differ === 0, `${differ} samples differ`);
  }
  // Jittered vsync: reported (native mode's documented limit), not asserted.
  for (const jitterMs of [0.05, 1]) {
    const clock = { fps: 60, jitterMs, seed: 7 };
    const rows = driftRows(playNative(h.mod, m, frames, clock, "native"), h.mod.TRACKS, h.mod.evaluateTrack, b.timeline, (f) => (frameTime(clock, f) - frameTime(clock, 0)) / 1000);
    const sc = rows.filter((r) => r.kind === "scalar" && r.range > 0);
    const worst = sc.reduce((a, r) => (r.maxAbs / r.range > a.v ? { v: r.maxAbs / r.range, k: r.key } : a), { v: 0, k: "" });
    note(
      `${b.name} on a ±${jitterMs} ms jittered vsync: worst ${(worst.v * 100).toFixed(2)}% of range (${worst.k}), ${rows.reduce((n, r) => n + r.lagOne, 0)} value-frames one frame late, colors ≤ ${Math.round(rows.filter((r) => r.kind === "color").reduce((a, r) => Math.max(a, r.maxAbs), 0) * 255)}/255`
    );
  }
  h.dispose();
}

// ---- 3b. segments (lane B markers → playSegment) ------------------------------------------------------
{
  const e = byName("native-easings");
  const anim = e.files["animations.ts"];
  const eSegs = manifestOf(e.files).segments ?? [];
  check(
    `the easings fixture's markers give ${eSegs.length} named segments, in toolbox-clock.ts and the manifest`,
    eSegs.length >= 4 && /export const SEGMENTS = \{/.test(e.files["toolbox-clock.ts"] ?? "")
  );
  check(
    "animations.ts plays them: per-value <key>SegmentAnimation(segment), SEGMENT_STARTS, playSegment()",
    /export function e_springSegmentAnimation\(segment: SegmentName/.test(anim) && /export const SEGMENT_STARTS/.test(anim) && /const playSegment = useCallback/.test(anim)
  );
  note(`easings: segment edges inside key segments become ${(anim.match(/const tbxCut\d+ = /g) ?? []).length} exact cuts of toolbox's curve (tbxCut*)`);
  for (const bundle of bundles) {
    const man = manifestOf(bundle.files);
    const segs: { name: string; frames: [number, number] }[] = man.segments ?? [];
    if (!segs.length) continue;
    const h = await loadNativeModule(bundle.files);
    const real = useReal ? await loadNativeModule(bundle.files, { reanimated: "real" }) : null;
    for (const s of segs) {
      const [a, b] = s.frames;
      const n = b - a + 1;
      let worst = 0;
      let lag = 0;
      let bad = "";
      let differ = 0;
      for (const platform of ["web", "native"] as const) {
        const series = playNative(h.mod, man.native, n, steady, platform, s.name);
        const rows = driftRows(series, h.mod.TRACKS, h.mod.evaluateTrack, bundle.timeline, (f) => (a + f) / bundle.timeline.fps);
        for (const r of rows) {
          const rel = r.kind === "color" ? 0 : r.maxAbs / (r.range || 1);
          worst = Math.max(worst, rel);
          lag += r.lagOne;
          if ((r.kind === "color" ? r.maxAbs > 1 / 255 + 1e-12 : r.range > 0 ? rel > 2e-5 : r.maxAbs > 1e-12) && !bad) bad = `${r.key} ${r.maxAbs.toExponential(2)} @+${r.maxAt}`;
        }
        if (real) {
          const c = playNative(real.mod, man.native, n, steady, platform, s.name);
          for (const k of Object.keys(series)) series[k].forEach((v, f) => (JSON.stringify(v) === JSON.stringify(c[k][f]) ? 0 : differ++));
        }
      }
      check(
        `${bundle.name} playSegment("${s.name}") (f${a}–f${b}): every value within 2e-5 of range of the worklet value at every frame (worst ${worst.toExponential(1)}), no frame of lag${real ? ", same doubles as Reanimated's real sources" : ""}`,
        !bad && !lag && !differ,
        `${bad}${lag ? ` · ${lag} late` : ""}${differ ? ` · ${differ} samples differ from the real sources` : ""}`
      );
    }
    h.dispose();
    real?.dispose();
  }
}

// ---- 3c. playSegment(…, { from: "current" }): an interruption -----------------------------------------
// Every value starts where it is — scalars run their first step from there,
// colors fade the color on screen out over the segment's first move along
// that move's own timing and easing — and from the end of that move on plays
// exactly what from "start" plays. "Where it is": the worklet value at a
// frame inside another stretch of the timeline (what the screen shows when
// app code interrupts it).
{
  const sameV = (a: number | number[], b: number | number[]) => JSON.stringify(a) === JSON.stringify(b);
  const maxD = (a: number | number[], b: number | number[]) =>
    Array.isArray(a) && Array.isArray(b) ? Math.max(...a.map((x, i) => Math.abs(x - b[i]))) : Math.abs((a as number) - (b as number));
  for (const bundle of bundles) {
    const man = manifestOf(bundle.files);
    const segs: { name: string; frames: [number, number] }[] = man.segments ?? [];
    if (!segs.length) continue;
    check(`${bundle.name}: the manifest says what from "current" does`, typeof man.native.fromCurrent === "string" && /colorFrom/.test(man.native.fromCurrent));
    const h = await loadNativeModule(bundle.files);
    const real = useReal ? await loadNativeModule(bundle.files, { reanimated: "real" }) : null;
    const total = bundle.timeline.sceneDurationTicks / bundle.timeline.ticksPerFrame;
    let colorsTested = 0;
    for (const s of segs) {
      const [a, b] = s.frames;
      const n = b - a + 1;
      // Interrupt from a frame well away from the segment's start.
      const at = (a + Math.round(total * 0.37)) % total;
      const current: Record<string, number | number[]> = {};
      for (const v of man.native.values) current[v.key] = h.mod.evaluateTrack(h.mod.TRACKS[v.key], at * bundle.timeline.ticksPerFrame);
      let bad = "";
      let start0 = 0;
      let color0 = 0;
      let jumped = 0;
      let moved = 0;
      let differ = 0;
      for (const platform of ["web", "native"] as const) {
        const fromStart = playNative(h.mod, man.native, n, steady, platform, s.name);
        const cur = playNativeFromCurrent(h.mod, man.native, n, steady, platform, s.name, current);
        if (real) {
          const c = playNativeFromCurrent(real.mod, man.native, n, steady, platform, s.name, current);
          for (const k of Object.keys(cur.series)) cur.series[k].forEach((v, f) => (sameV(v, c.series[k][f]) ? 0 : differ++));
        }
        for (const v of man.native.values) {
          const S = cur.series[v.key];
          const R = fromStart[v.key];
          const segAnim = h.mod[`${v.key.replace(/[^A-Za-z0-9_$]/g, "_")}SegmentAnimation`];
          // (a) it starts where it is — unless it doesn't move in the
          // segment at all, when it jumps as from "start" (as a scalar does).
          const jumps = sameV(S[0], R[0]) && sameV(S[n - 1], R[0]) && sameV(R[0], R[n - 1]);
          if (!jumps) {
            if (v.kind === "scalar") {
              if (segAnim && !Object.is(S[0], current[v.key])) bad ||= `${s.name} ${v.key}: starts at ${S[0]}, not the current ${current[v.key]}`;
              start0 = Math.max(start0, maxD(S[0], current[v.key]));
            } else {
              // (before lane C a color jumped to the segment's start color:
              // what from "start" shows at +0)
              jumped = Math.max(jumped, maxD(R[0], current[v.key]));
              color0 = Math.max(color0, maxD(S[0], current[v.key]));
              if (maxD(S[0], current[v.key]) > 1 / 255 + 1e-12) bad ||= `${s.name} ${v.key}: starts at ${JSON.stringify(S[0])}, not the current ${JSON.stringify(current[v.key])}`;
            }
          }
          // (b) it joins toolbox's frames (from "start") before the segment
          // ends and stays on them; a color is on them on every frame its
          // fade is 0 (colorFrom is colorAt there) and its fade reaches 0.
          // (8-bit snapped colors can coincide for a frame mid-fade.)
          let lastDiff = -1;
          for (let f = 0; f < n; f++) if (!sameV(S[f], R[f])) lastDiff = f;
          if (lastDiff >= n - 1) bad ||= `${s.name} ${v.key}: never joins from "start" (last ${JSON.stringify(S[n - 1])} vs ${JSON.stringify(R[n - 1])})`;
          if (v.kind === "color" && cur.weights[v.key]) {
            const w = cur.weights[v.key];
            if (w[n - 1] !== 0 || w.some((x, f) => x === 0 && !sameV(S[f], R[f]))) bad ||= `${s.name} ${v.key}: off toolbox's frames with its fade at 0, or the fade never ends`;
          }
          if (!sameV(S[0], R[0])) moved++;
          // (c) a color's fade has its first move's timing and easing: with no
          // lead it is 1 − that progress's eased fraction at every frame; with
          // a lead it is a linear glide over the lead; it reaches 0 when the
          // move (or the lead) ends and stays there.
          if (v.kind === "color" && cur.weights[v.key]) {
            const w = cur.weights[v.key];
            const ps = cur.progress[v.key];
            const k0 = ps.findIndex((p) => p.some((x) => x !== p[0]));
            if (k0 < 0 || jumps) continue;
            colorsTested++;
            const p = ps[k0];
            const lead = p.findIndex((x, f) => f + 1 < n && p[f + 1] !== x);
            const end = p.findIndex((x, f) => f >= lead && p.slice(f).every((y) => y === x));
            const isHold = p.slice(0, end).every((x) => x === p[0]);
            if (isHold) {
              if (!(w.slice(0, end).every((x) => x === 1) && w.slice(end).every((x) => x === 0))) bad ||= `${s.name} ${v.key}: a hold's fade must wait, then drop at +${end}`;
            } else if (lead === 0) {
              const p0 = p[0];
              const p1 = p[end];
              for (let f = 0; f <= end; f++) {
                const want = 1 - (p[f] - p0) / (p1 - p0);
                if (Math.abs(w[f] - want) > 1e-9) {
                  bad ||= `${s.name} ${v.key}: fade ${w[f]} at +${f}, the move's eased fraction says ${want}`;
                  break;
                }
              }
              if (!w.slice(end).every((x) => x === 0)) bad ||= `${s.name} ${v.key}: fade not 0 from +${end}`;
            } else {
              // (≤ 1e-5: every duration ends 1 µs early, FRAME_MARGIN_MS)
              for (let f = 0; f <= lead; f++) if (Math.abs(w[f] - Math.max(0, 1 - f / lead)) > 1e-5) bad ||= `${s.name} ${v.key}: a ${lead}-frame lead must glide linearly (${w[f]} at +${f})`;
              if (!w.slice(lead).every((x) => x === 0)) bad ||= `${s.name} ${v.key}: fade not 0 after the lead`;
            }
          }
        }
      }
      check(
        `${bundle.name} playSegment("${s.name}", { from: "current" }) from f${at}: ${moved / 2} values leave where they are (scalars exactly, colors within ${Math.round(color0 * 255)}/255 — they used to jump up to ${Math.round(jumped * 255)}/255), color fades follow the first move's curve, everything joins from "start"'s frames by the end of that move and stays${real ? "; same doubles as Reanimated's real sources" : ""}`,
        !bad && !differ && start0 === 0,
        `${bad}${differ ? ` · ${differ} samples differ from the real sources` : ""}`
      );
    }
    if (bundle.name !== "native-aurora-scene") check(`${bundle.name}: from "current" exercised colors (${colorsTested})`, colorsTested > 0);
    h.dispose();
    real?.dispose();
  }
}

// ---- 4. color progress → toolbox's color ----------------------------------------------------------
{
  const e = byName("native-easings");
  const h = await loadNativeModule(e.files);
  const colorTracks: [string, any][] = Object.entries(h.mod.TRACKS).filter(([, t]: any) => t.kind === "color") as any;
  // Plus a Color-node style track: node alpha, no alpha snap; and an unsnapped one.
  const base = colorTracks[0][1];
  colorTracks.push(["(node alpha 0.4)", { ...base, quantizeAlpha: undefined, alpha: 0.4 }], ["(no 8-bit snap)", { ...base, quantize8: false, quantizeAlpha: undefined }]);
  let samples = 0;
  let bad = "";
  for (const [name, track] of colorTracks) {
    const ks = track.keys;
    for (let k = 0; k + 1 < ks.length; k++) {
      const prev = ks[k];
      const span = ks[k + 1].tick - prev.tick;
      for (let i = 0; i <= 400; i++) {
        const u = i / 400;
        const tick = prev.tick + u * span;
        if (tick !== Math.round(tick) && Math.abs(tick - Math.round(tick)) < 1e-6) continue;
        const rawT = span > 0 ? (tick - prev.tick) / span : 0;
        // The progress Reanimated would hold: toolbox's own eased fraction.
        const p =
          prev.easing === "hold"
            ? rawT >= 1
              ? 1
              : 0
            : rawT <= 0
              ? 0
              : rawT >= 1
                ? 1
                : prev.easing === "cubicBezier"
                  ? rt.cubicBezierEase(prev.bezier ?? { x1: 1 / 3, y1: 1 / 3, x2: 2 / 3, y2: 2 / 3 }, rawT)
                  : prev.easing === "spring"
                    ? rt.springEase(prev.spring, rawT)
                    : rt.easeOf(prev.easing, rawT);
        const progress = ks.slice(0, -1).map((_: unknown, j: number) => (j < k ? 1 : j === k ? p : 0));
        const got = h.mod.colorAt(track, progress);
        const want = rt.evaluateTrack(track, tick) as number[];
        samples++;
        if (!got.every((x: number, c: number) => Object.is(x, want[c]))) bad ||= `${name} segment ${k} (${prev.easing}) u=${u}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`;
      }
    }
  }
  check(`colorAt(progress) is evaluateTrack's color bit for bit (${colorTracks.length} tracks, ${samples} samples: OKLab, RGB, hold, overshoot, spring, 8-bit snaps)`, !bad, bad);
  h.dispose();
}

// ---- 5. refusals, edge cases, the default ------------------------------------------------------------
{
  const TL = { fps: 60, ticksPerFrame: 1000, sceneDurationTicks: 120_000 };
  const { syncChannelInputs } = await import("@/engine/expr-channels");
  // One SkSL node whose channel `v` carries `keys` (lane L4 channel keyframes).
  const run = (keys: any[], name: string) => {
    const sksl = `// ch("v", 0, -10, 10)\nhalf4 main(float2 p) { return half4(v, 0.0, 0.0, 1.0); }\n`;
    const node: GraphNode = {
      id: "fx",
      type: "sksl-shader",
      params: { inputs: syncChannelInputs([], sksl), expression: sksl, on_error: "transparent" },
      animation: { "ch:v": { animated: true, trackVisible: true, keyframes: keys } },
    };
    return exportSkia({ nodes: [node], edges: [], targetId: "fx", name, canvas: CANVAS, timeline: TL, runtimeSource, animation: "native" });
  };
  const unknown = run([{ tick: 0, value: 0, easingOut: "wobble" }, { tick: 60_000, value: 1, easingOut: "linear" }], "u");
  check("refuses an easing with no Reanimated mapping", !unknown.files && unknown.problems.some((p) => p.includes('"wobble" has no Reanimated mapping')), unknown.problems.join(" | "));
  const loopy = run(
    [
      { tick: 0, value: 1, easingOut: "customBezier", bezierHandles: { rightHandle: { dx: 10_000, dy: 2 }, leftHandle: { dx: 0, dy: 0 } } },
      { tick: 60_000, value: 1, easingOut: "linear", bezierHandles: { rightHandle: { dx: 0, dy: 0 }, leftHandle: { dx: -10_000, dy: 2 } } },
    ],
    "c"
  );
  check("refuses a customBezier between equal keys whose handles move the value", !loopy.files && loopy.problems.some((p) => p.includes("can't leave and come back")), loopy.problems.join(" | "));
  const flat = run(
    [
      { tick: 0, value: 1, easingOut: "customBezier", bezierHandles: { rightHandle: { dx: 10_000, dy: 0 }, leftHandle: { dx: 0, dy: 0 } } },
      { tick: 60_000, value: 1, easingOut: "linear" },
    ],
    "f"
  );
  check("…but a flat one between equal keys is a constant withTiming", !!flat.files, flat.problems.join(" | "));
  // Played on a steady clock, every value within 2e-5 of range of the
  // worklet value at every frame?
  const exact = async (files: Files | null) => {
    if (!files) return "no bundle";
    const h = await loadNativeModule(files);
    const rows = driftRows(playNative(h.mod, manifestOf(files).native, 121, steady, "native"), h.mod.TRACKS, h.mod.evaluateTrack, TL);
    h.dispose();
    const bad = rows.filter((r) => (r.range > 0 ? r.maxAbs / r.range > 2e-5 : r.maxAbs > 1e-12) || r.lagOne);
    return bad.map((r) => `${r.key} ${r.maxAbs.toExponential(2)} @f${r.maxAt}`).join(", ");
  };
  const before = run([{ tick: -30_000, value: 0, easingOut: "easeInOutCubic" }, { tick: 30_000, value: 1, easingOut: "linear" }], "b");
  const beforeBad = await exact(before.files);
  check(
    "a segment already running at frame 0 plays as an exact cut of toolbox's curve (tbxCut), not a refusal",
    !!before.files && /const tbxCut0 = /.test(before.files["animations.ts"]) && !beforeBad,
    before.problems.join(" | ") || beforeBad
  );
  const beforeHold = run([{ tick: -30_000, value: 0.5, easingOut: "hold" }, { tick: 30_000, value: 1, easingOut: "linear" }], "bh");
  check("…a hold running at frame 0 starts from its value", !!beforeHold.files && /starts at 0\.5/.test(beforeHold.files["animations.ts"]), beforeHold.problems.join(" | "));
  const past = run([{ tick: 0, value: 0, easingOut: "easeOutBack" }, { tick: 180_000, value: 1, easingOut: "linear" }], "p");
  const pastBad = await exact(past.files);
  check("…and one that ends after the scene stops on the scene's last frame, exactly", !!past.files && /cut to f0–f120/.test(past.files["animations.ts"]) && !pastBad, past.problems.join(" | ") || pastBad);
  const zeroSpring = run([{ tick: 0, value: 0, easingOut: "spring", spring: { dampingRatio: 0.5 } }, { tick: 0, value: 1, easingOut: "spring" }, { tick: 60_000, value: 2, easingOut: "linear" }], "z");
  check("a zero-length spring segment is an instant step, not a withSpring", !!zeroSpring.files && !zeroSpring.problems.length, zeroSpring.problems.join(" | "));
  const spr = run([{ tick: 0, value: 0, easingOut: "spring", spring: { dampingRatio: 0.4, settle: 0.5 } }, { tick: 60_000, value: 1, easingOut: "linear" }], "s");
  const cfg = springToReanimated({ dampingRatio: 0.4, settle: 0.5 }, 1000);
  check(
    "a spring segment emits withSpring with springToReanimated's config, then rests to the next key",
    !!spr.files && spr.files["animations.ts"].includes(`withSpring(1, { stiffness: ${cfg.stiffness}, damping: ${cfg.damping}, mass: 1, velocity: 0, overshootClamping: false, energyThreshold: 6e-9 })`) && /rest at 1 to f60/.test(spr.files["animations.ts"]),
    spr.problems.join(" | ")
  );
  // The default stays the worklet bundle.
  const g = aurora.auroraGraph();
  const dflt = exportSkia({ nodes: g.nodes, edges: g.edges, targetId: g.targetId, name: "Aurora", canvas: CANVAS, timeline: AURORA_TL, runtimeSource });
  const work = exportNative(g, AURORA_TL, "Aurora", "worklet");
  check("animation \"worklet\" (and no animation) is the unchanged worklet bundle", JSON.stringify(dflt.files) === JSON.stringify(work.files) && !!dflt.files?.["timeline.ts"]?.includes("sampleUniforms"));
  const committed = fs.readFileSync(path.join(ROOT, "skia-harness/src/bundle/timeline.ts"), "utf8");
  check("…byte for byte what the committed worklet slot (skia-harness/src/bundle) holds", dflt.files?.["timeline.ts"] === committed);
}

// ---- 6. type-check + the harness slots ------------------------------------------------------------------
{
  // One harness type-check run for every bundle, each in its own folder.
  const all: Files = {};
  for (const b of bundles) for (const [f, text] of Object.entries(b.files)) all[`${b.name}/${f}`] = text;
  const tc = typecheckBundle(all, "native");
  if (!tc.ran) note(tc.output);
  check(`the native bundles type-check in skia-harness (react-native-skia 3.4.0, Reanimated 4.7)${tc.ran ? "" : " — skipped"}`, tc.ok, tc.output);
  const g = sceneFx.sceneFixtureGraph();
  const sc = await checkExportable({ nodes: g.nodes, edges: g.edges, canvasId: g.canvasId, canvas: sceneFx.SCENE_CANVAS, timeline: sceneFx.SCENE_TIMELINE, slot: "native-scene-fixture", animation: "native", typecheck: true });
  check("the scene fixture (paths, text, images, sampled + track binds) exports in native mode", !!sc.files && !sc.problems.length, sc.problems.join(" | "));
  check(`…and type-checks in skia-harness${sc.typecheck.ran ? "" : " — skipped"}`, sc.typecheck.ok, sc.typecheck.output);
  if (sc.files) {
    const scene = sc.files["ToolboxScene.tsx"];
    const m = manifestOf(sc.files).native;
    check(
      "…its track binds read native shared values; sampled ones the native clock",
      m.values.length > 0 && /const time = A\.clock;/.test(scene) && /\.\.\.sampleBinds\(time\.value\)/.test(scene) && !/useToolboxClock/.test(scene)
    );
  }
  for (const b of bundles) {
    const dir = path.join(ROOT, "skia-harness/src", b.slot);
    const have = readTree(dir);
    const stale = Object.entries(b.files).filter(([f, text]) => !f.endsWith(".b64") && have[f] !== text).map(([f]) => f);
    const fixture = b.name === "native-easings" ? "easings" : b.name === "native-aurora" ? "aurora" : "aurora-scene";
    check(
      `skia-harness/src/${b.slot} is today's export`,
      !stale.length,
      `${stale.join(", ")} differ — npx tsx scripts/export-skia.mts --fixture ${fixture} --animation native --out skia-harness/src/${b.slot}`
    );
  }
}

// ---- 7. worklet declaration order (the TDZ trap) ------------------------------------------------------------
{
  // Top-level declarations in order; a worklet's body may only name worklets
  // declared above it.
  const order = (src: string): string[] => {
    const decl = /^(?:export )?(?:function (\w+)\(|const (\w+) = (?:\([^)]*\)(?:: [\w[\]<>]+)? =>|function))/gm;
    const found: { name: string; at: number }[] = [];
    for (let m = decl.exec(src); m; m = decl.exec(src)) found.push({ name: m[1] ?? m[2], at: m.index });
    const errs: string[] = [];
    found.forEach((d, i) => {
      const body = src.slice(d.at, found[i + 1]?.at ?? src.length);
      if (!/^\s*"worklet";/m.test(body.split("\n").slice(1, 3).join("\n"))) return;
      for (const later of found.slice(i + 1)) if (new RegExp(`\\b${later.name}\\(`).test(body)) errs.push(`${d.name} calls ${later.name}, declared below it`);
    });
    return errs;
  };
  check("order() catches a worklet calling one declared below it", order(`function a() {\n  "worklet";\n  return b();\n}\nfunction b() {\n  "worklet";\n  return 1;\n}\n`).length === 1);
  const rtErr = order(runtimeSource);
  check("the shipped runtime (toolbox-timeline.ts) declares every worklet above its callers", !rtErr.length, rtErr.join("; "));
  const emitted: string[] = [];
  for (const b of bundles) for (const f of ["animations.ts", "toolbox-native.ts", "timeline.ts"]) if (b.files[f]) emitted.push(...order(b.files[f]).map((e) => `${b.name}/${f}: ${e}`));
  check("…and so does every emitted native module", !emitted.length, emitted.join("; "));
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
