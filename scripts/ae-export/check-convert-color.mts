// convert/color.ts (spec 091926_after-effects-handoff.md §4.3, §11.4): the
// dense-key counts §4.3 measured, the OKLab expression run under an AE
// expression shim against toolbox's own color evaluation, accept-RGB's ΔE
// report, and color ramps sampled into gradient stops.

import { runInNewContext } from "node:vm";
import { makeChecker } from "./harness.mts";
import { type EasingPreset, type Keyframe, type KeyframeAnimationBlock } from "@/engine/keyframes";
import { makeColorRampSampler, type ColorRampStop } from "@/engine/color-ramp";
import type { AeKey, AeRGB } from "@/lib/ae-export/types";
import {
  colorSegmentsNeeded,
  colorTrackToAe,
  colorTrackValueAt,
  denseColorTrackToAe,
  evaluateAeGradient,
  evaluateAeKeys,
  frameTime,
  rampToAeStops,
  type Rgba,
} from "@/lib/ae-export/convert";

const block = (keys: Keyframe[], colorSpace?: "oklab" | "rgb"): KeyframeAnimationBlock => ({ animated: true, trackVisible: true, keyframes: keys, ...(colorSpace ? { colorSpace } : {}) });
const k = (tick: number, value: unknown, easingOut: EasingPreset = "linear", extra: Partial<Keyframe> = {}): Keyframe => ({ tick, value, easingOut, ...extra });

// AE's expression globals for one property: numKeys, key(i) (1-based, {time,
// value} with 4-component colors), time, value. The expression's completion
// value is its result, as in AE.
function runExpression(src: string, keys: AeKey<AeRGB>[], time: number): number[] {
  const key = (i: number) => ({ time: keys[i - 1].t, value: [...keys[i - 1].v, 1] });
  return runInNewContext(src, { numKeys: keys.length, key, time, value: [0, 0, 0, 1] }) as number[];
}

export default async function run(): Promise<number> {
  const c = makeChecker("convert-color");

  // --- §4.3's counts: uniform linear-RGB pieces within 2/255 of the OKLab line
  const pairs: [string, Rgba, Rgba, number | null][] = [
    ["red→blue", [1, 0, 0, 1], [0, 0, 1, 1], 63],
    ["orange→teal", [1, 0.5, 0, 1], [0, 0.5, 0.5, 1], 56],
    ["black→white", [0, 0, 0, 1], [1, 1, 1, 1], 9],
    ["navy→sky", [0.05, 0.1, 0.3, 1], [0.55, 0.8, 1, 1], 3],
    ["red→green", [1, 0, 0, 1], [0, 1, 0, 1], null],
  ];
  for (const [label, a, b, want] of pairs) {
    const n = colorSegmentsNeeded(a, b, (u) => u, 2);
    if (want === null) c.check(`${label}: more than 64 segments (§4.3: "exceeds 64")`, n === null);
    else c.check(`${label}: ${n} segments for ≤ 2/255 (§4.3: ${want} ± 1)`, n !== null && Math.abs(n - want) <= 1);
  }
  c.check("red→blue fits in ≤ 64 segments", (colorSegmentsNeeded([1, 0, 0, 1], [0, 0, 1, 1], (u) => u, 2) ?? 99) <= 64);
  c.check("an RGB-space track needs one segment", colorSegmentsNeeded([1, 0, 0, 1], [0, 0, 1, 1], (u) => u, 2, { space: "rgb" }) === 1);

  // --- dense keys on a real track, verified at frames -----------------------
  const rb = block([k(0, "#ff0000"), k(60000, "#0000ff")]);
  const d1 = denseColorTrackToAe(rb, { fps: 60, fidelity: "editable" });
  c.check(`dense red→blue over 1 s: ${d1.perSegment[0]} pieces, ${d1.report.maxError255.toFixed(2)}/255 at frames`, d1.report.maxError255 <= 2 && d1.perSegment[0] <= 64 && "keys" in d1.prop && d1.prop.keys.every((kk) => kk.outInterp === "linear" || kk.outInterp === "hold"));
  const mixed = block([
    k(0, "#ff0000", "easeOutBounce"),
    k(30000, "#00ff00", "hold"),
    k(45000, "#2040ff", "spring", { spring: { dampingRatio: 0.4 } }),
    k(75000, "#ffcc00", "cubicBezier", { bezier: { x1: 0.7, y1: -0.4, x2: 0.2, y2: 1.3 } }),
    k(105000, "#101010"),
  ]);
  const d2 = denseColorTrackToAe(mixed, { fps: 30, fidelity: "editable" });
  c.check(`dense, mixed easings (bounce / hold / spring / cubicBezier): ${d2.report.maxError255.toFixed(2)}/255 at frames, hold kept`, d2.report.maxError255 <= 2 && "keys" in d2.prop && d2.prop.keys.some((kk) => kk.outInterp === "hold"));

  // --- expression parity ---------------------------------------------------
  // Every preset in one track, plus hold / spring / cubicBezier / customBezier.
  const presets: EasingPreset[] = ["linear", "easeInSine", "easeOutSine", "easeInOutSine", "easeInQuad", "easeOutQuad", "easeInOutQuad", "easeInCubic", "easeOutCubic", "easeInOutCubic", "easeInExpo", "easeOutExpo", "easeInBack", "easeOutBack", "easeOutBounce", "easeOutElastic", "easeIn", "easeOut", "easeInOut"];
  const hexes = ["#ff0000", "#0000ff", "#00ff80", "#ff8000", "#008080", "#202060", "#ffffff", "#000000", "#c000ff", "#33aa11"];
  const keys: Keyframe[] = presets.map((p, i) => k(i * 13000 + (i % 3) * 700, hexes[i % hexes.length], p));
  let tick = keys[keys.length - 1].tick;
  keys.push(k((tick += 11000), "#808000", "hold"));
  keys.push(k((tick += 9000), "#ff00ff", "spring", { spring: { dampingRatio: 0.25 } }));
  keys.push(k((tick += 20000), "#00ffff", "cubicBezier", { bezier: { x1: 0.1, y1: 1.6, x2: 0.4, y2: -0.2 } }));
  keys.push(k((tick += 12000), "#123456", "customBezier"));
  keys.push(k((tick += 15000), "#fedcba"));
  const all = block(keys);
  const fps = 30;
  const ex = colorTrackToAe(all, { fps, fidelity: "editable", policy: "expression" });
  const prop = ex.prop;
  c.check("expression mode: keys = toolbox's colors at toolbox's times, plus the expression", "keys" in prop && prop.keys.length === keys.length && typeof prop.expression === "string");
  if ("keys" in prop && prop.expression) {
    let worst = 0;
    let at = 0;
    const tEnd = prop.keys[prop.keys.length - 1].t;
    // Sample times with their exact toolbox ticks: frames (tick = f·1000,
    // which lands ON key ticks — a hold → spring boundary sits on one) and
    // 400 off-frame times.
    const times: { t: number; tick: number; frame: boolean }[] = [];
    for (let f = -5; f <= Math.ceil(tEnd * fps) + 5; f++) times.push({ t: frameTime(f, { fps }), tick: f * 1000, frame: true });
    for (let i = 0; i < 400; i++) {
      const t = tEnd * ((i * 0.6180339887) % 1);
      times.push({ t, tick: t * 1000 * fps, frame: false });
    }
    let frames = 0;
    for (const { t, tick, frame } of times) {
      const have = runExpression(prop.expression, prop.keys, t);
      const want = colorTrackValueAt(all, tick);
      if (frame) frames++;
      for (let ch = 0; ch < 3; ch++) {
        const e = Math.abs(have[ch] - want[ch]);
        if (e > worst) {
          worst = e;
          at = t;
        }
      }
    }
    c.check(
      `expression ≡ toolbox's OKLab evaluation — every preset, hold, spring, cubicBezier, customBezier — at ${frames} frames + 400 off-frame times (worst ${worst.toExponential(1)} at ${at.toFixed(3)} s)`,
      worst < 1e-9
    );
    const bad = runExpression(prop.expression.replace("var E = ", "var E = [];\nvar E_unused = "), prop.keys, prop.keys[1].t * 0.5);
    c.check("…a segment E does not describe (keys added in AE) plays linear, not NaN", bad.every((x) => Number.isFinite(x)));
  }
  c.check("auto on a shape / solid color → expression (§11.4)", colorTrackToAe(rb, { fps: 60, fidelity: "editable", policy: "auto", drivesShapeOrSolid: true }).report.mode === "expression");
  c.check("auto elsewhere → dense (§11.4)", colorTrackToAe(rb, { fps: 60, fidelity: "editable", policy: "auto" }).report.mode === "dense");

  // --- accept RGB -------------------------------------------------------------
  const rgbRb = colorTrackToAe(block([k(0, "#ff0000", "easeInOutCubic"), k(60000, "#0000ff")]), { fps: 60, fidelity: "editable", policy: "rgb" });
  c.check(`accept-RGB red→blue: reports the worst ΔE_OK (${rgbRb.report.worstDeltaE?.toFixed(1)}) and ${rgbRb.report.maxError255.toFixed(0)}/255`, (rgbRb.report.worstDeltaE ?? 0) > 5 && rgbRb.report.fidelity === "approx" && "keys" in rgbRb.prop && rgbRb.prop.keys.length === 2);
  const mid = "keys" in rgbRb.prop ? evaluateAeKeys(rgbRb.prop.keys, 0.5, "color").map((x) => Math.round(x * 255)) : [];
  c.check(`…AE's RGB midpoint is [128, 0, 128] (got ${mid.join(", ")})`, mid.join() === "128,0,128");
  const native = colorTrackToAe(block([k(0, "#ff0000", "easeOutBack"), k(30000, "#0000ff", "easeInOutSine"), k(60000, "#00ff00")], "rgb"), { fps: 60, fidelity: "editable", policy: "dense" });
  c.check(`an RGB-space track exports natively with its eases (${native.report.maxError255.toExponential(1)}/255)`, native.report.mode === "native" && native.report.maxError255 < 0.5);
  const alpha = colorTrackToAe(block([k(0, "#ff000080", "easeOutQuad"), k(30000, "#ff0000ff")]), { fps: 30, fidelity: "editable", policy: "dense" });
  c.check("alpha in 8-digit hex rides a separate opacity track (50% → 100%)", !!alpha.alpha && "keys" in alpha.alpha && Math.abs((alpha.alpha.keys[0].v as number) - (128 / 255) * 100) < 1e-9);

  // --- ramps → gradient stops ------------------------------------------------
  const stops: ColorRampStop[] = [
    { id: "a", position: 0, color: "#ff0000" },
    { id: "b", position: 0.35, color: "#00ff00", alpha: 0.6 },
    { id: "c", position: 1, color: "#0000ff" },
  ];
  const srgb = rampToAeStops(stops, { interp: "linear", space: "srgb" });
  c.check(`srgb + linear maps 1:1 (${srgb.stops.colors.length} stops, ${srgb.maxError255.toExponential(1)}/255)`, srgb.exact && srgb.stops.colors.length === 3 && srgb.maxError255 < 1e-9);
  // Measured 2026-10-20 (greedy chords + fine fix-up, tolerance 1/255).
  const RECORDED: Record<string, number> = { "linear/linear": 37, "oklab/linear": 36, "oklch/linear": 50, "oklch_long/linear": 70, "srgb/ease": 21, "oklab/smooth": 30 };
  for (const [space, interp] of [
    ["linear", "linear"],
    ["oklab", "linear"],
    ["oklch", "linear"],
    ["oklch_long", "linear"],
    ["srgb", "ease"],
    ["oklab", "smooth"],
  ] as const) {
    const r = rampToAeStops(stops, { interp, space, tolerance255: 1 });
    // Independent re-measure on a different grid against the engine sampler.
    const s = makeColorRampSampler(stops, { interp, space });
    let m = 0;
    for (let i = 0; i <= 5000; i++) {
      const t = i / 5000;
      const have = evaluateAeGradient(r.stops, t);
      const want = s(t);
      for (let ch = 0; ch < 4; ch++) m = Math.max(m, Math.abs(have[ch] - want[ch]) * 255);
    }
    const key = `${space}/${interp}`;
    c.check(`${key} ramp: ${r.stops.colors.length} stops within 1/255 (${m.toFixed(3)}/255)`, m <= 1 && r.stops.colors.length === r.stops.opacities.length);
    c.check(`${key} ramp: stop count ${r.stops.colors.length} (recorded ${RECORDED[key]} ± 2)`, Math.abs(r.stops.colors.length - RECORDED[key]) <= 2);
  }
  const constant = rampToAeStops(stops, { interp: "constant", space: "oklab" });
  let cm = 0;
  const cs = makeColorRampSampler(stops, { interp: "constant", space: "oklab" });
  for (let i = 0; i <= 999; i++) {
    const t = (i + 0.5) / 1000;
    const have = evaluateAeGradient(constant.stops, t);
    const want = cs(t);
    for (let ch = 0; ch < 4; ch++) cm = Math.max(cm, Math.abs(have[ch] - want[ch]) * 255);
  }
  c.check(`constant ramp → hard steps (coincident stops), ${cm.toExponential(1)}/255 off the edges`, constant.exact && cm < 1e-6);
  return c.failures;
}
