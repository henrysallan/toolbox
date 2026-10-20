// convert/easing.ts (spec 091926_after-effects-handoff.md §4.2, Appendix A):
// Bodymovin's speed/influence formula both ways, Appendix A's worked numbers,
// and every row of AE_EASINGS measured against easeOf — once on the
// normalized plan, once through the whole key pipeline (numericTrackToAe →
// evaluateAeKeys, AE's own semantics) — held to the row's recorded error.

import { makeChecker } from "./harness.mts";
import { sameUpToFloatNoise } from "../skia/snapshot-diff.ts";
import {
  EASING_PRESET_ORDER,
  easeOf,
  easeKeyframeOut,
  evaluateKeyframesAt,
  type EasingPreset,
  type Keyframe,
  type KeyframeAnimationBlock,
} from "@/engine/keyframes";
import {
  AE_EASINGS,
  aeEaseToCubic,
  aeEasingRow,
  cubicToAeEase,
  evaluateAeKeys,
  numericTrackToAe,
  pieceEases,
  planError,
  type AeEasePlan,
} from "@/lib/ae-export/convert";

const ALL_PRESETS: EasingPreset[] = [...EASING_PRESET_ORDER, "cubicBezier", "easeIn", "easeOut", "easeInOut"];

function track(keys: Keyframe[]): KeyframeAnimationBlock {
  return { animated: true, trackVisible: true, keyframes: keys };
}

// A 1 s, 0 → 100 segment at 60 fps through the whole pipeline; max
// |AE − easeOf·100| / 100 over `n` + 1 times (continuous, not just frames).
function pipelineError(preset: EasingPreset, fidelity: "editable" | "exact", n = 20000): { err: number; keys: number; dense: number } {
  const block = track([
    { tick: 0, value: 0, easingOut: preset },
    { tick: 60000, value: 100, easingOut: "linear" },
  ]);
  const r = numericTrackToAe(block, "scalar", { fps: 60, fidelity });
  if ("v" in r.prop) return { err: NaN, keys: 0, dense: 0 };
  let m = 0;
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const have = evaluateAeKeys(r.prop.keys, u, "perDim")[0];
    const want = 100 * easeOf(preset, u);
    m = Math.max(m, Math.abs(have - want) / 100);
  }
  return { err: m, keys: r.prop.keys.length, dense: r.report.dense.length };
}

export default async function run(): Promise<number> {
  const c = makeChecker("convert-easing");

  // --- Bodymovin round trip -------------------------------------------------
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let worst = 0;
  for (let i = 0; i < 500; i++) {
    const cu = { x1: 0.001 + 0.999 * rnd(), y1: -1 + 3 * rnd(), x2: 0.999 * rnd(), y2: -1 + 3 * rnd() };
    const D = 0.1 + 3 * rnd();
    const dv = (rnd() < 0.5 ? -1 : 1) * (0.5 + 500 * rnd());
    const e = cubicToAeEase(cu, D, dv);
    const back = aeEaseToCubic(e.out, e.in, D, dv)!;
    worst = Math.max(worst, Math.abs(back.x1 - cu.x1), Math.abs(back.y1 - cu.y1), Math.abs(back.x2 - cu.x2), Math.abs(back.y2 - cu.y2));
  }
  c.check(`cubic → (speed, influence) → cubic round trip, 500 random shapes (worst ${worst.toExponential(2)})`, worst < 1e-11);
  const clamped = cubicToAeEase({ x1: 0, y1: 0.2, x2: 1, y2: 0.8 }, 1, 100);
  c.near("x1 = 0 clamps to AE's 0.1% influence", clamped.out.influence, 0.1, 1e-12);
  c.near("…keeping the control point's height (speed = 0.2·100 / 0.001)", clamped.out.speed, 20000, 1e-6);
  c.near("x2 = 1 clamps the in influence the same way", clamped.in.influence, 0.1, 1e-12);
  c.check("a flat segment has no normalized inverse", aeEaseToCubic({ speed: 0, influence: 33 }, { speed: 0, influence: 33 }, 1, 0) === null);

  // --- Appendix A (1 s, 100 px) --------------------------------------------
  const a1 = cubicToAeEase({ x1: 1 / 3, y1: 1, x2: 2 / 3, y2: 1 }, 1, 100);
  c.near("App. A easeOutCubic out influence 33.33", a1.out.influence, 100 / 3, 1e-9);
  c.near("App. A easeOutCubic out speed 300", a1.out.speed, 300, 1e-9);
  c.near("App. A easeOutCubic in speed 0", a1.in.speed, 0, 1e-9);
  const back = aeEasingRow("easeOutBack")!.editable as Extract<AeEasePlan, { kind: "pieces" }>;
  c.near("App. A easeOutBack out speed 470.16", pieceEases(back.pieces[0], 1, 100).out.speed, 470.158, 1e-9);
  const css = cubicToAeEase({ x1: 0.455, y1: 0.03, x2: 0.515, y2: 0.955 }, 1, 100);
  c.near("App. A CSS easeInOutQuad out (45.5, 6.59)", css.out.speed, 6.593406593406594, 1e-9);
  c.near("App. A CSS easeInOutQuad in influence 48.5", css.in.influence, 48.5, 1e-9);
  c.near("App. A CSS easeInOutQuad in speed 9.28", css.in.speed, 9.278350515463918, 1e-9);
  const bounce = aeEasingRow("easeOutBounce")!.editable as Extract<AeEasePlan, { kind: "pieces" }>;
  const bs = bounce.pieces.map((p) => pieceEases(p, 1, 100));
  const want = [
    [0, 550],
    [-275, 275],
    [-137.5, 137.5],
    [-68.75, 68.75],
  ];
  c.check(
    "App. A bounce as 5 keys: speeds 0/550, −275/275, −137.5/137.5, −68.75/68.75 at 33.33%",
    bs.length === 4 &&
      bs.every((e, i) => Math.abs(e.out.speed - want[i][0]) < 1e-9 && Math.abs(e.in.speed - want[i][1]) < 1e-9 && Math.abs(e.out.influence - 100 / 3) < 1e-9 && Math.abs(e.in.influence - 100 / 3) < 1e-9),
    bs.map((e) => [e.out.speed, e.in.speed])
  );

  // Snapshot: the AE keys of App. A's three single-segment rows (1 s, 0 → 100 px).
  const snap = (["easeOutCubic", "easeOutBack", "easeOutBounce"] as EasingPreset[]).map((p) => {
    const r = numericTrackToAe(track([{ tick: 0, value: 0, easingOut: p }, { tick: 60000, value: 100, easingOut: "linear" }]), "scalar", { fps: 60, fidelity: "editable" });
    return { p, keys: "keys" in r.prop ? r.prop.keys : r.prop };
  });
  const SNAPSHOT =
    '[{"p":"easeOutCubic","keys":[{"t":0,"v":0,"inInterp":"linear","outInterp":"bezier","easeOut":[{"influence":33.33333333333333,"speed":300.00000000000006}]},{"t":1,"v":100,"inInterp":"bezier","outInterp":"linear","easeIn":[{"influence":33.33333333333334,"speed":0}]}]},{"p":"easeOutBack","keys":[{"t":0,"v":0,"inInterp":"linear","outInterp":"bezier","easeOut":[{"influence":33.33333333333333,"speed":470.15800000000013}]},{"t":1,"v":100,"inInterp":"bezier","outInterp":"linear","easeIn":[{"influence":33.33333333333334,"speed":0}]}]},{"p":"easeOutBounce","keys":[{"t":0,"v":0,"inInterp":"linear","outInterp":"bezier","easeOut":[{"influence":33.33333333333333,"speed":0}]},{"t":0.36363636363636365,"v":100,"inInterp":"bezier","outInterp":"bezier","easeIn":[{"influence":33.33333333333333,"speed":550}],"easeOut":[{"influence":33.33333333333333,"speed":-275}]},{"t":0.7272727272727273,"v":100,"inInterp":"bezier","outInterp":"bezier","easeIn":[{"influence":33.33333333333333,"speed":275}],"easeOut":[{"influence":33.33333333333333,"speed":-137.5}]},{"t":0.9090909090909091,"v":100,"inInterp":"bezier","outInterp":"bezier","easeIn":[{"influence":33.33333333333334,"speed":137.5}],"easeOut":[{"influence":33.333333333333336,"speed":-68.75}]},{"t":1,"v":100,"inInterp":"bezier","outInterp":"linear","easeIn":[{"influence":33.333333333333336,"speed":68.75}]}]}]';
  const have = JSON.stringify(snap);
  c.check("App. A key snapshot (easeOutCubic / easeOutBack / bounce) up to float noise", sameUpToFloatNoise(have, SNAPSHOT, 1e-9), have);

  // --- the table -------------------------------------------------------------
  for (const p of ALL_PRESETS) c.check(`AE_EASINGS has a row for ${p}`, !!aeEasingRow(p));
  c.check("AE_EASINGS rows are unique", new Set(AE_EASINGS.map((r) => r.easing)).size === AE_EASINGS.length);

  console.log("    preset            policy    keys  measured     recorded   §4.2");
  for (const row of AE_EASINGS) {
    for (const policy of ["editable", "exact"] as const) {
      const plan = row[policy];
      const recorded = row.error[policy];
      const spec = row.spec?.[policy];
      let measured: number;
      let keys = 2;
      if (plan.kind === "pieces" || plan.kind === "linear") {
        if (row.cls === "direct") continue; // fixtures below
        measured = planError(plan, (u) => easeOf(row.easing, u));
        const pipe = pipelineError(row.easing, policy);
        keys = pipe.keys;
        c.check(
          `${row.easing} ${policy}: pipeline (AE semantics) ≡ the plan (${(pipe.err * 100).toFixed(5)}% vs ${(measured * 100).toFixed(5)}%)`,
          Math.abs(pipe.err - measured) <= 1e-9 && pipe.dense === 0
        );
      } else if (plan.kind === "hold") {
        const r = numericTrackToAe(track([{ tick: 0, value: 0, easingOut: "hold" }, { tick: 60000, value: 100, easingOut: "linear" }]), "scalar", { fps: 60, fidelity: policy });
        const ks = "keys" in r.prop ? r.prop.keys : [];
        const at = (t: number) => evaluateAeKeys(ks, t)[0];
        measured = Math.max(Math.abs(at(0.5)), Math.abs(at(0.999999)), Math.abs(at(1) - 100)) / 100;
        c.check(`hold ${policy}: HOLD on both sides`, ks[0]?.outInterp === "hold" && ks[1]?.inInterp === "hold");
      } else if (plan.kind === "sampled") {
        // Spring: dense keys, exact at frames.
        const block = track([
          { tick: 0, value: 0, easingOut: "spring", spring: { dampingRatio: 0.35 } },
          { tick: 60000, value: 100, easingOut: "linear" },
        ]);
        const r = numericTrackToAe(block, "scalar", { fps: 60, fidelity: policy });
        const ks = "keys" in r.prop ? r.prop.keys : [];
        measured = 0;
        for (let f = 0; f <= 60; f++) {
          const want = evaluateKeyframesAt(block, "scalar", f * 1000) as number;
          measured = Math.max(measured, Math.abs(evaluateAeKeys(ks, f / 60)[0] - want) / 100);
        }
        keys = ks.length;
        c.check(`spring ${policy}: dense keys at every frame`, ks.length === 61 && r.report.dense.length === 1 && r.report.fidelity === "sampled");
      } else continue;
      c.check(
        `${row.easing} ${policy}: ${(measured * 100).toFixed(5)}% within ±${(row.tolerance * 100).toPrecision(2)}% of recorded ${(recorded * 100).toFixed(5)}%`,
        Math.abs(measured - recorded) <= row.tolerance
      );
      // §4.2's numbers are 2-decimal displays (its expo "0.09%" is the 0.098% floor).
      if (spec !== undefined) c.check(`${row.easing} ${policy}: no worse than §4.2 (${(spec * 100).toFixed(2)}%, display-rounded)`, measured <= spec + 1e-4);
      console.log(
        `    ${row.easing.padEnd(17)} ${policy.padEnd(9)} ${String(keys).padStart(4)}  ${(measured * 100).toFixed(5).padStart(9)}%  ${(recorded * 100).toFixed(5).padStart(9)}%  ${spec === undefined ? "—" : (spec * 100).toFixed(2) + "%"}`
      );
    }
  }
  c.check("Editable worst case ≤ 0.6% (§4.2's policy statement)", AE_EASINGS.every((r) => r.error.editable <= 0.006));
  c.check("Exact worst case ≤ 0.1% (the expo floor, easeOf's own 2⁻¹⁰ jump)", AE_EASINGS.every((r) => r.error.exact <= 0.001));
  c.near("M0 cross-check: easeInOutSine fit = the 0.0076% AE measured", aeEasingRow("easeInOutSine")!.error.editable, 0.0000765, 2e-7);

  // --- direct rows -----------------------------------------------------------
  // cubicBezier: Bodymovin's formula on the key's own shape; toolbox's solver
  // stops at |x error| < 1e-7, so the two land ~1e-7 apart.
  // A handle ON its key (x1 = 0 / x2 = 1) is below AE's 0.1% influence: the
  // nearest AE curve misses by ~3e-4 (an AE limit, inside every tolerance).
  for (const [bz, tol] of [
    [{ x1: 0.2, y1: 1.4, x2: 0.3, y2: 0.9 }, 2e-6],
    [{ x1: 0.9, y1: -0.3, x2: 0.05, y2: 1.2 }, 2e-6],
    [{ x1: 0, y1: 0, x2: 1, y2: 1 }, 5e-4],
  ] as const) {
    const block = track([
      { tick: 0, value: 10, easingOut: "cubicBezier", bezier: bz },
      { tick: 45000, value: -30, easingOut: "linear" },
    ]);
    const r = numericTrackToAe(block, "scalar", { fps: 60, fidelity: "editable" });
    let m = 0;
    for (let i = 0; i <= 4000; i++) {
      const tick = (45000 * i) / 4000;
      const want = evaluateKeyframesAt(block, "scalar", tick) as number;
      m = Math.max(m, Math.abs(evaluateAeKeys("keys" in r.prop ? r.prop.keys : [], tick / 60000)[0] - want) / 40);
    }
    c.check(`cubicBezier ${JSON.stringify(bz)}: AE ≡ toolbox to ${m.toExponential(1)} (≤ ${tol})`, m <= tol);
  }
  // customBezier: the handles ARE AE's handles (tick / value units), flat
  // segments included (no normalization by Δv).
  for (const [label, kf] of [
    ["overshooting handles", { right: { dx: 9000, dy: 70 }, left: { dx: -20000, dy: 15 } }],
    ["flat segment with a bump", { right: { dx: 15000, dy: 40 }, left: { dx: -15000, dy: 40 } }],
    ["default handles (straight)", null],
  ] as const) {
    const flat = label.startsWith("flat");
    const block = track([
      { tick: 0, value: 20, easingOut: "customBezier", ...(kf ? { bezierHandles: { rightHandle: kf.right, leftHandle: { dx: 0, dy: 0 } } } : {}) },
      { tick: 60000, value: flat ? 20 : 80, easingOut: "linear", ...(kf ? { bezierHandles: { rightHandle: { dx: 0, dy: 0 }, leftHandle: kf.left } } : {}) },
    ]);
    const r = numericTrackToAe(block, "scalar", { fps: 60, fidelity: "editable" });
    let m = 0;
    for (let i = 0; i <= 4000; i++) {
      const tick = (60000 * i) / 4000;
      const want = evaluateKeyframesAt(block, "scalar", tick) as number;
      m = Math.max(m, Math.abs(evaluateAeKeys("keys" in r.prop ? r.prop.keys : [], tick / 60000)[0] - want));
    }
    c.check(`customBezier, ${label}: AE ≡ toolbox to ${m.toExponential(1)} value units`, m <= 1e-4 && r.report.dense.length === 0);
  }
  // A non-scalar customBezier plays linear (toolbox's rule), so it exports linear.
  const v2 = numericTrackToAe(
    track([
      { tick: 0, value: [0, 0], easingOut: "customBezier" },
      { tick: 60000, value: [10, 20], easingOut: "linear" },
    ]),
    "vec2",
    { fps: 60, fidelity: "editable" }
  );
  c.check("customBezier on a vec2 exports LINEAR (toolbox plays it linear)", "keys" in v2.prop && v2.prop.keys[0].outInterp === "linear");
  void easeKeyframeOut;
  return c.failures;
}
