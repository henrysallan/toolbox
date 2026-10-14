// check-spring-easing: the `spring` easing (engine/spring-easing.ts) — a
// keyframe segment that plays React Native Reanimated 4.7's withSpring,
// normalised to the segment (specdocs/101326_skia-target.md §3.5d).
//
//   1. sanitizer: sanitizeSpringEasing / resolveSpring gate junk and clamp;
//   2. endpoints: exactly 0 at A and exactly B from the rest point on, for
//      every config and every interpolable type;
//   3. regimes: ζ < 1 overshoots, ζ = 1 and ζ > 1 never do, and every
//      ζ ≥ 1 is one curve (Reanimated 4.7 has no over-damped branch);
//   4. monotone time: Reanimated's energy ratio never rises along the
//      segment, the rest time is the first passing double, once at rest a
//      segment stays at rest;
//   5. engine ↔ runtime (runtime/toolbox-timeline.ts) bit-identical (the
//      full-track identity lives in check-skia-export);
//   6. editor: tiles, the Graph Editor's sampler and the overlay ghost draw
//      the curve that plays; pair keys / writes / time flip carry params;
//   7. MCP vetting (engine/keyframe-easing-vet.ts);
//   8. save → load keeps spring keys verbatim and they play the same;
//   9. Reanimated parity: withSpring(B, springToReanimated(key, T)) from A,
//      stepped at frame timestamps exactly as valueSetter does — REAL
//      Reanimated source when skia-harness/node_modules is installed
//      (esbuild bundle; `logger` and `defineAnimation` stubbed), else the
//      transcription in scripts/fixtures/reanimated/spring-4.7.ts (which
//      this gate holds bit-identical to the real one whenever both exist);
//  10. springSksl compiles in CanvasKit (strict ES2) and matches the JS
//      curve within fp32 tolerance; springSkslCall / springToReanimated.
//
//   npx tsx scripts/check-spring-easing.mts

/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Minimal DOM stubs — @/lib/project (the persistence round trip) pulls the
// engine registry in.
const g = globalThis as any;
const stub = () => ({ getContext: () => null, style: {}, addEventListener() {} });
g.window ??= g;
g.self ??= g;
g.document ??= { createElement: stub, createElementNS: stub, fonts: { add() {}, forEach() {} }, body: { appendChild() {} }, addEventListener() {} };
g.navigator ??= { userAgent: "node" };
g.HTMLCanvasElement ??= class {};
g.OffscreenCanvas ??= class { getContext() { return null; } };
g.WebGL2RenderingContext ??= class {};

const SE = await import("@/engine/spring-easing");
const KF = await import("@/engine/keyframes");
const rt = await import("@/lib/skia-export/runtime/toolbox-timeline");
const SP = await import("@/lib/skia-export/spring");
const ED = await import("@/components/effects/timeline/easing-editor");
const { flipKeyframesInTime } = await import("@/components/effects/timeline/keyframe-clipboard");
const { vetKeyframeEasing, keyframeSpringReport } = await import("@/engine/keyframe-easing-vet");
import type { Keyframe, KeyframeAnimationBlock, SpringEasing } from "@/engine/keyframes";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${!cond && detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
const note = (s: string) => console.log(`     ${s}`);

const { springEase, resolveSpring, sanitizeSpringEasing, springRestTime, springEnergyFraction, springOmega } = SE;
const THR = SE.SPRING_ENERGY_THRESHOLD;
const ZETAS = [0.01, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99, 0.999, 0.9999, 1, 1.0001, 1.2, 2, 3.5, 10];
const SETTLES = [1, 0.9, 0.75, 0.5, 0.3, 0.1, 0.05];
const restU = (settle: number) => settle / SE.SPRING_SETTLE_MARGIN;
const blockOf = (keyframes: Keyframe[], colorSpace?: "oklab" | "rgb"): KeyframeAnimationBlock => ({
  animated: true,
  trackVisible: true,
  keyframes,
  ...(colorSpace ? { colorSpace } : {}),
});

// ---- 1. sanitizer ------------------------------------------------------------------------------
{
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  check(
    "sanitize: junk → null",
    [null, undefined, 3, "x", [], {}, { dampingRatio: "0.5" }, { dampingRatio: NaN }, { dampingRatio: Infinity }, { dampingRatio: 0 }, { dampingRatio: -1 }, { dampingRatio: 0.5, settle: "1" }, { dampingRatio: 0.5, settle: NaN }, { dampingRatio: 0.5, settle: 0 }].every(
      (v) => sanitizeSpringEasing(v) === null
    )
  );
  check(
    "sanitize: clamps ζ into [0.01, 10], settle into [0.05, 1], fills settle",
    same(sanitizeSpringEasing({ dampingRatio: 0.001 }), { dampingRatio: 0.01, settle: 1 }) &&
      same(sanitizeSpringEasing({ dampingRatio: 40, settle: 3 }), { dampingRatio: 10, settle: 1 }) &&
      same(sanitizeSpringEasing({ dampingRatio: 0.35, settle: 0.01 }), { dampingRatio: 0.35, settle: 0.05 }) &&
      same(sanitizeSpringEasing({ dampingRatio: 0.35, settle: 0.6, extra: 1 }), { dampingRatio: 0.35, settle: 0.6 })
  );
  check(
    "resolve (evaluation): never throws, junk → defaults, same clamps",
    same(resolveSpring(undefined), { zeta: 0.5, settle: 1 }) &&
      same(resolveSpring("junk"), { zeta: 0.5, settle: 1 }) &&
      same(resolveSpring({ dampingRatio: NaN, settle: -2 }), { zeta: 0.5, settle: 1 }) &&
      same(resolveSpring({ dampingRatio: 1e-9, settle: 1e-9 }), { zeta: 0.01, settle: 0.05 }) &&
      same(resolveSpring({ dampingRatio: 0.25, settle: 0.5 }), { zeta: 0.25, settle: 0.5 })
  );
  const junkKeys: Keyframe[] = [
    { tick: 0, value: 0, easingOut: "spring", spring: { dampingRatio: "bouncy" } as any },
    { tick: 1000, value: 1, easingOut: "linear" },
  ];
  const plain: Keyframe[] = [{ ...junkKeys[0], spring: undefined }, junkKeys[1]];
  let junkOk = true;
  for (let t = 0; t <= 1000; t += 7) {
    const a = KF.evaluateKeyframesAt(blockOf(junkKeys), "scalar", t);
    junkOk &&= Number.isFinite(a as number) && Object.is(a, KF.evaluateKeyframesAt(blockOf(plain), "scalar", t));
  }
  check("a junk `spring` on a key plays the default spring (never NaN)", junkOk);
}

// ---- 2. endpoints -------------------------------------------------------------------------------
{
  let bad = "";
  for (const z of ZETAS) {
    for (const settle of SETTLES) {
      const sp = { dampingRatio: z, settle };
      if (springEase(sp, 0) !== 0 || springEase(sp, -0.5) !== 0) bad ||= `start ${z}/${settle}`;
      if (springEase(sp, 1) !== 1 || springEase(sp, 1.5) !== 1) bad ||= `end ${z}/${settle}`;
      // From the snap (u = settle / 1.01) on: exactly 1.
      for (let i = 0; i <= 64; i++) {
        const u = restU(settle) * (1 + 1e-12) + (1 - restU(settle)) * (i / 64);
        if (u < 1 && springEase(sp, u) !== 1) bad ||= `rest ${z}/${settle} @${u}: ${springEase(sp, u)}`;
      }
      // …and not before it (the spring is still moving, however little).
      const before = springEase(sp, restU(settle) * (1 - 1e-6));
      if (before === 1) bad ||= `snapped early ${z}/${settle}`;
      if (Math.abs(before - 1) > Math.sqrt(THR) * 1.01) bad ||= `residual before the snap ${z}/${settle}: ${before - 1}`;
    }
  }
  check(
    `springEase: 0 at u ≤ 0, exactly 1 from u = settle/1.01 on and at u ≥ 1, residual before the snap ≤ √threshold (${ZETAS.length}×${SETTLES.length} configs)`,
    !bad,
    bad
  );

  // Through evaluateKeyframesAt on every interpolable type: the key values
  // exactly at the keys, B exactly from the rest point to the next key.
  const sp = { dampingRatio: 0.3, settle: 0.8 };
  const span = 90_000;
  const restTick = Math.ceil(span * restU(0.8)) + 1;
  const cases: [string, unknown, unknown][] = [
    ["scalar", -3.25, 7.5],
    ["vec2", [0.1, -2], [3, 4.5]],
    ["vec4", [0, 0, 0, 0], [1, -1, 2, 0.5]],
    ["color", "#ff7a45", "#1b2cff"],
    ["spline_anchors", { subpaths: [{ closed: false, anchors: [{ pos: [0, 0] }, { pos: [1, 0] }] }] }, { subpaths: [{ closed: false, anchors: [{ pos: [0.5, 1] }, { pos: [2, 0.25] }] }] }],
  ];
  let tbad = "";
  for (const [type, a, b] of cases) {
    const ks: Keyframe[] = [
      { tick: 0, value: a, easingOut: "spring", spring: sp },
      { tick: span, value: b, easingOut: "linear" },
    ];
    const at = (t: number) => KF.evaluateKeyframesAt(blockOf(ks), type as any, t);
    const atB = KF.evaluateKeyframesAt(blockOf([{ ...ks[1], tick: 0 }]), type as any, 0);
    if (JSON.stringify(at(0)) !== JSON.stringify(a)) tbad ||= `${type} at A`;
    if (JSON.stringify(at(span)) !== JSON.stringify(b)) tbad ||= `${type} at B`;
    for (const t of [restTick, restTick + 777, span - 1, span - 1e-6]) {
      const v = at(t);
      // Interpolation at t' = 1 is lerp(a, b, 1): b itself for numbers; the
      // color path rounds through OKLab, so compare it with the t = 1 lerp.
      const want = type === "color" ? KF.evaluateKeyframesAt(blockOf([{ ...ks[0], easingOut: "linear" }, ks[1]]), "color", span - 1e-9) : atB;
      if (type !== "color" && JSON.stringify(v) !== JSON.stringify(want)) tbad ||= `${type} @${t}: ${JSON.stringify(v)}`;
      if (type === "color" && (v as number[]).some((x, i) => Math.abs(x - (want as number[])[i]) > 1e-12)) tbad ||= `color @${t}`;
    }
  }
  check("evaluateKeyframesAt: key values exact at A and B; B from the rest point to the next key (scalar, vec2, vec4, color, spline)", !tbad, tbad);
}

// ---- 3. regimes ----------------------------------------------------------------------------------
{
  const N = 4000;
  const curve = (sp: SpringEasing) => Array.from({ length: N + 1 }, (_, i) => springEase(sp, i / N));
  const peaks = new Map<number, number>();
  let under = "";
  for (const z of ZETAS.filter((x) => x < 1)) {
    const c = curve({ dampingRatio: z });
    const peak = Math.max(...c);
    peaks.set(z, peak);
    // Reanimated's under-damped first overshoot: e^(−ζπ/√(1−ζ²)).
    const want = 1 + Math.exp((-z * Math.PI) / Math.sqrt(1 - z * z));
    if (z <= 0.9 && Math.abs(peak - want) > 2e-3) under ||= `ζ ${z}: peak ${peak} want ${want}`;
    if (z <= 0.9 && !(peak > 1)) under ||= `ζ ${z} never overshoots`;
  }
  check("ζ < 1 overshoots by Reanimated's e^(−ζπ/√(1−ζ²))", !under, under);
  let crit = "";
  for (const z of ZETAS.filter((x) => x >= 1)) {
    for (const settle of [1, 0.4]) {
      const c = curve({ dampingRatio: z, settle });
      for (let i = 1; i < c.length; i++) if (c[i] < c[i - 1] || c[i] > 1) crit ||= `ζ ${z}/${settle} @${i / N}`;
    }
  }
  check("ζ ≥ 1 never overshoots and never turns back", !crit, crit);
  const one = curve({ dampingRatio: 1, settle: 0.7 });
  const allSame = ZETAS.filter((x) => x > 1).every((z) => curve({ dampingRatio: z, settle: 0.7 }).every((v, i) => Object.is(v, one[i])));
  check("every ζ ≥ 1 is the same curve (Reanimated's critically damped branch ignores ζ)", allSame);
  const near = curve({ dampingRatio: 0.9999, settle: 0.7 });
  const gap = Math.max(...near.map((v, i) => Math.abs(v - one[i])));
  check(`ζ → 1⁻ meets the critical curve (ζ 0.9999 vs 1: max ${gap.toExponential(2)})`, gap < 2e-3, String(gap));
  const restTimes = ZETAS.map((z) => springRestTime(z));
  note(`rest time ω0·t at the snap: ${ZETAS.map((z, i) => `ζ ${z} → ${restTimes[i].toFixed(3)}`).join(", ")}`);
}

// ---- 4. monotone time -------------------------------------------------------------------------------
{
  let rise = "";
  let snap = "";
  for (const z of ZETAS) {
    const rest = springRestTime(z);
    // The first passing double: passes at rest, fails just before.
    const below = rest - Math.max(rest * 4e-16, Number.MIN_VALUE);
    if (!(springEnergyFraction(z, rest) <= THR) || springEnergyFraction(z, below) <= THR) {
      snap ||= `ζ ${z}: frac(rest) ${springEnergyFraction(z, rest)} frac(before) ${springEnergyFraction(z, below)}`;
    }
    // Energy never rises along the segment (dE/dt = −c·v²; rounding aside).
    let prev = Infinity;
    for (let i = 0; i <= 6000; i++) {
      const e = springEnergyFraction(z, (rest * 1.2 * i) / 6000);
      if (e > prev * (1 + 1e-9) + 1e-300) rise ||= `ζ ${z} @${i}: ${prev} → ${e}`;
      prev = e;
    }
    // Once at rest, every later u is at rest.
    for (const settle of [1, 0.35]) {
      let rested = false;
      for (let i = 0; i <= 3000; i++) {
        const v = springEase({ dampingRatio: z, settle }, i / 3000);
        if (rested && v !== 1) snap ||= `ζ ${z}/${settle} left rest at ${i / 3000}`;
        if (v === 1 && i > 0) rested = true;
      }
    }
  }
  check("Reanimated's energy ratio never rises along the segment", !rise, rise);
  check("rest time = the first double where Reanimated's energy test passes; once at rest, at rest", !snap, snap);
  // The time remap rides a monotone u: evaluateKeyframesAt at increasing
  // (fractional) ticks samples springEase at increasing u — same doubles.
  const ks: Keyframe[] = [
    { tick: 10_000, value: 2, easingOut: "spring", spring: { dampingRatio: 0.4, settle: 0.9 } },
    { tick: 130_000, value: -6, easingOut: "linear" },
  ];
  let remap = "";
  for (let t = 10_000; t <= 130_000; t += 113.37) {
    const u = (t - 10_000) / 120_000;
    const want = 2 + (-6 - 2) * springEase(ks[0].spring, u);
    const got = KF.evaluateKeyframesAt(blockOf(ks), "scalar", t);
    if (t > 10_000 && t < 130_000 && !Object.is(got, want)) remap ||= `@${t}: ${got} vs ${want}`;
  }
  check("evaluateKeyframesAt is lerp(A, B, springEase(u)) at every (fractional) tick", !remap, remap);
}

// ---- 5. engine ↔ runtime -------------------------------------------------------------------------------
{
  let bad = "";
  for (const z of ZETAS) if (!Object.is(rt.springRestTime(z), springRestTime(z))) bad ||= `rest ζ ${z}`;
  const springs: (SpringEasing | undefined)[] = [undefined, ...ZETAS.flatMap((z) => SETTLES.map((settle) => ({ dampingRatio: z, settle })))];
  for (const sp of springs) {
    const pre = SP.timelineSpringOf(sp);
    for (let i = -2; i <= 1002; i++) {
      const u = i / 1000 + (i % 7) * 1e-7;
      const e = springEase(sp, u);
      if (!Object.is(e, rt.springEase(sp as any, u)) || !Object.is(e, rt.springEase(pre, u))) bad ||= `${JSON.stringify(sp)} @${u}`;
    }
  }
  check(`runtime springRestTime / springEase (raw + precomputed rest) are bit-identical to the engine (${springs.length} configs × 1005 u)`, !bad, bad);
  check("easeOf('spring') is the default spring on both sides", [0.1, 0.37, 0.8].every((u) => Object.is(KF.easeOf("spring", u), springEase(undefined, u)) && Object.is(rt.easeOf("spring", u), KF.easeOf("spring", u))));
  const pre = SP.timelineSpringOf({ dampingRatio: 40, settle: 0 } as any);
  check("timelineSpringOf resolves (clamps) and precomputes the rest time", pre.dampingRatio === 10 && pre.settle === 1 && pre.rest === springRestTime(10));
}

// ---- 6. editor ---------------------------------------------------------------------------------------
{
  // Picker tiles: the Spring tile samples the default spring densely.
  check("spring is a built-in preset (pickers, shelf, MCP) labelled Spring", KF.EASING_PRESET_ORDER.includes("spring") && KF.EASING_PRESET_LABELS.spring === "Spring");
  const tile = KF.easingPathFor("spring", 100, 100, 40);
  const tilePts = tile.split(/[ML]/).filter((s) => s.trim()).length;
  check(`the Spring tile samples max(40, springPathSamples()) points (${tilePts})`, tilePts === Math.max(40, SE.springPathSamples()) + 1);
  // Graph Editor sampler: easeKeyframeOut(k, u) is exactly what plays.
  let gbad = "";
  for (const sp of [{ dampingRatio: 0.12, settle: 0.6 }, { dampingRatio: 1.5 }, undefined]) {
    const a: Keyframe = { tick: 0, value: 1, easingOut: "spring", ...(sp ? { spring: sp } : {}) };
    const b: Keyframe = { tick: 60_000, value: 4, easingOut: "linear" };
    const n = SE.springPathSamples(sp);
    for (let s = 1; s < n; s++) {
      const u = s / n;
      const drawn = 1 + KF.easeKeyframeOut(a, u) * 3;
      const plays = KF.evaluateKeyframesAt(blockOf([a, b]), "scalar", u * 60_000) as number;
      if (Math.abs(drawn - plays) > 1e-12) gbad ||= `${JSON.stringify(sp)} @${u}: ${drawn} vs ${plays}`;
    }
  }
  check("Graph Editor sampler (easeKeyframeOut) draws the curve that plays", !gbad, gbad);
  // Enough samples to follow the oscillation: ≥ 12 per cycle up to the cap.
  const cyc = (sp: SpringEasing) => (springOmega(sp) * Math.sqrt(1 - sp.dampingRatio ** 2)) / (2 * Math.PI);
  check(
    "springPathSamples keeps ≥ 12 points per oscillation (32 … 512)",
    [0.05, 0.1, 0.3, 0.7].every((z) => SE.springPathSamples({ dampingRatio: z }) >= Math.min(512, 12 * cyc({ dampingRatio: z }))) &&
      SE.springPathSamples({ dampingRatio: 1 }) === 32 && SE.springPathSamples({ dampingRatio: 0.01, settle: 0.05 }) === 512
  );
  // Overlay seed / ghost / pair key / write.
  const a: Keyframe = { tick: 0, value: 0, easingOut: "spring", spring: { dampingRatio: 0.25, settle: 0.5 } };
  const b: Keyframe = { tick: 1000, value: 1, easingOut: "linear" };
  const seed = ED.seedForPair(a, b);
  check(
    "overlay seed: a spring pair is a ghost carrying its resolved params",
    seed.source === "ghost" && seed.preset === "spring" && JSON.stringify(seed.spring) === JSON.stringify({ dampingRatio: 0.25, settle: 0.5 }) &&
      JSON.stringify(ED.seedForPair({ ...a, spring: undefined }, b).spring) === JSON.stringify({ dampingRatio: 0.5, settle: 1 })
  );
  const view = ED.fitEasingView(200, 20);
  const ghost = ED.ghostPathD("spring", view, 48, seed.spring);
  const pts = ghost.split(/[ML]/).filter((s) => s.trim()).map((s) => s.trim().split(/\s+/).map(Number));
  const n = pts.length - 1;
  const ghostOk =
    n === Math.max(48, SE.springPathSamples(seed.spring)) &&
    pts.every(([x, y], i) => {
      const p = ED.unitToPx(view, i / n, springEase(seed.spring, i / n));
      return Math.abs(p.x - x) <= 0.006 && Math.abs(p.y - y) <= 0.006;
    });
  check("overlay ghost samples the pair's own spring", ghostOk);
  const k2 = ED.easingKeyOf({ ...a, spring: { dampingRatio: 0.3, settle: 0.5 } }, b);
  check(
    "pair keys tell springs apart by params (so `mixed` shows), and match when equal",
    ED.easingKeyOf(a, b) !== k2 && ED.easingKeyOf(a, b) === ED.easingKeyOf({ ...a }, b) && ED.easingKeyOf({ ...a, spring: undefined }, b) === ED.easingKeyOf({ ...a, spring: { dampingRatio: 0.5 } }, b)
  );
  const lane: Keyframe[] = [
    { tick: 0, value: 0, easingOut: "linear" },
    { tick: 500, value: 1, easingOut: "cubicBezier", bezier: { x1: 0.1, y1: 0, x2: 0.9, y2: 1 } },
    { tick: 900, value: 2, easingOut: "linear" },
  ];
  const w = ED.applySpringToLane(lane, new Set([0, 500]), { dampingRatio: 0.4, settle: 0.9 });
  check(
    "applySpringToLane writes spring + params on the pair-owning keys only",
    w[0].easingOut === "spring" && w[0].spring?.dampingRatio === 0.4 && w[1].easingOut === "spring" && w[1].spring?.settle === 0.9 && w[2] === lane[2] && w[0].spring !== w[1].spring
  );
  const flipped = flipKeyframesInTime([
    { tick: 0, value: 0, easingOut: "spring", spring: { dampingRatio: 0.2 } },
    { tick: 10, value: 1, easingOut: "spring", spring: { dampingRatio: 0.7 } },
    { tick: 30, value: 2, easingOut: "linear", spring: { dampingRatio: 0.9 } },
  ]);
  check(
    "paste-flipped: a reversed spring segment keeps that segment's params",
    flipped[0].easingOut === "spring" && flipped[0].spring?.dampingRatio === 0.7 && flipped[1].spring?.dampingRatio === 0.2 && flipped[2].easingOut === "linear" && !("spring" in flipped[2]),
    JSON.stringify(flipped)
  );
}

// ---- 7. MCP vetting ------------------------------------------------------------------------------------
{
  const v = (raw: any, stepOnly = false) => vetKeyframeEasing(raw, stepOnly);
  const okOf = (r: ReturnType<typeof v>) => (r.ok ? JSON.stringify({ e: r.easingOut, s: r.spring }) : `ERR ${r.reason}`);
  check(
    "vet: presets pass, default easeInOutQuad, step-only → hold",
    okOf(v({ easing: "easeOutBack" })) === JSON.stringify({ e: "easeOutBack" }) && okOf(v({})) === JSON.stringify({ e: "easeInOutQuad" }) &&
      okOf(v({ easing: "spring", spring: { dampingRatio: 0.2 } }, true)) === JSON.stringify({ e: "hold" })
  );
  check(
    "vet: spring writes explicit params — defaults, partials, clamps",
    okOf(v({ easing: "spring" })) === JSON.stringify({ e: "spring", s: { dampingRatio: 0.5, settle: 1 } }) &&
      okOf(v({ easing: "spring", spring: { settle: 0.4 } })) === JSON.stringify({ e: "spring", s: { dampingRatio: 0.5, settle: 0.4 } }) &&
      okOf(v({ easing: "spring", spring: { dampingRatio: 0.001, settle: 2 } })) === JSON.stringify({ e: "spring", s: { dampingRatio: 0.01, settle: 1 } })
  );
  const err = (r: ReturnType<typeof v>, needle: string) => !r.ok && r.reason.includes(needle);
  check(
    "vet: refuses customBezier / cubicBezier / unknown names / junk spring / spring params on another easing",
    err(v({ easing: "customBezier" }), "graph editor") && err(v({ easing: "cubicBezier" }), "easing overlay") &&
      err(v({ easing: "boing" }), "spring") && err(v({ easing: 3 }), "Unknown") &&
      err(v({ easing: "spring", spring: { dampingRatio: "x" } }), "dampingRatio") && err(v({ easing: "spring", spring: [0.5] }), "dampingRatio") &&
      err(v({ easing: "spring", spring: { dampingRatio: -1 } }), "> 0") && err(v({ easing: "linear", spring: { dampingRatio: 0.5 } }), "only with")
  );
  check(
    "get_keyframes reports a spring key's params as they play",
    JSON.stringify(keyframeSpringReport({ tick: 0, value: 0, easingOut: "spring" })) === JSON.stringify({ spring: { dampingRatio: 0.5, settle: 1 } }) &&
      JSON.stringify(keyframeSpringReport({ tick: 0, value: 0, easingOut: "spring", spring: { dampingRatio: 20, settle: 0.3 } })) === JSON.stringify({ spring: { dampingRatio: 10, settle: 0.3 } }) &&
      JSON.stringify(keyframeSpringReport({ tick: 0, value: 0, easingOut: "linear", spring: { dampingRatio: 0.2 } })) === "{}"
  );
}

// ---- 8. save → load ------------------------------------------------------------------------------------
{
  const { deserializeGraph, serializeGraph, CURRENT_SCHEMA } = await import("@/lib/project");
  const ANIM: Record<string, KeyframeAnimationBlock> = {
    opacity: blockOf([
      { tick: 0, value: 0, easingOut: "spring", spring: { dampingRatio: 0.22, settle: 0.65 } },
      { tick: 30_000, value: 1, easingOut: "spring" },
      { tick: 75_000, value: 0.4, easingOut: "spring", spring: { dampingRatio: 1.4 } },
      { tick: 120_000, value: 0.9, easingOut: "linear" },
    ]),
  };
  const saved = {
    schemaVersion: CURRENT_SCHEMA,
    nodes: [{ id: "c", defType: "constant", position: { x: 0, y: 0 }, params: { value: 0 }, animation: ANIM }],
    edges: [],
  } as any;
  const json = JSON.parse(JSON.stringify(saved));
  const res = await deserializeGraph(json);
  const loaded = res.nodes[0]?.data.animation as Record<string, KeyframeAnimationBlock> | undefined;
  check("load keeps spring keys verbatim", JSON.stringify(loaded) === JSON.stringify(ANIM), JSON.stringify(loaded));
  const ser = JSON.parse(JSON.stringify(await serializeGraph(res.nodes as any, res.edges as any)));
  const again = (ser.nodes[0] as any)?.animation;
  check("save keeps spring keys verbatim", JSON.stringify(again) === JSON.stringify(ANIM));
  let play = "";
  for (let t = -100; t <= 125_000; t += 97.5) {
    if (!Object.is(KF.evaluateKeyframesAt(ANIM.opacity, "scalar", t), KF.evaluateKeyframesAt(again.opacity, "scalar", t))) play ||= `@${t}`;
  }
  check("the reloaded track plays the same doubles", !play, play);
}

// ---- 9. Reanimated parity -------------------------------------------------------------------------------
type Rea = { withSpring: (to: number, config?: any) => any; underDampedSpringCalculations: any; criticallyDampedSpringCalculations: any };
const harness = path.join(ROOT, "skia-harness/node_modules/react-native-reanimated");
const transcription: Rea = await import("./fixtures/reanimated/spring-4.7.ts");
let real: Rea | null = null;
// SPRING_EASING_TRANSCRIPTION=1 forces the CI path; SKIA_HARNESS_REQUIRED=1
// makes a missing harness a failure (as in check-skia-scene-export).
const forceTranscription = !!process.env.SPRING_EASING_TRANSCRIPTION;
if (!forceTranscription && fs.existsSync(path.join(harness, "src/animation/spring/index.ts"))) {
  const version = JSON.parse(fs.readFileSync(path.join(harness, "package.json"), "utf8")).version;
  check(`skia-harness pins react-native-reanimated 4.7.0 (found ${version})`, version === "4.7.0");
  const esbuild = await import("esbuild");
  const out = await esbuild.build({
    entryPoints: [path.join(harness, "src/animation/spring/index.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    logLevel: "silent",
    plugins: [
      {
        name: "stub-non-math",
        setup(b) {
          b.onResolve({ filter: /^\.\.\/util$|^\.\.\/\.\.\/common$/ }, (a) => ({ path: a.path, namespace: "stub" }));
          b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({
            loader: "js",
            contents:
              a.path === "../util"
                ? "export function defineAnimation(_s, factory) { return factory(); }\nexport function getReduceMotionForAnimation() { return false; }"
                : "export const logger = { warn() {} };",
          }));
        },
      },
    ],
  });
  const code = out.outputFiles[0].text;
  real = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  note(`Reanimated: the real source (${path.relative(ROOT, harness)}/src/animation/spring, ${code.length} bytes bundled)`);
} else {
  if (process.env.SKIA_HARNESS_REQUIRED && !forceTranscription) check("skia-harness has node_modules (npm --prefix skia-harness install)", false);
  note(
    `Reanimated: ${forceTranscription ? "SPRING_EASING_TRANSCRIPTION is set" : "skia-harness/node_modules is not installed"} — ` +
      "using the transcription (scripts/fixtures/reanimated/spring-4.7.ts). npm --prefix skia-harness install runs the real source too."
  );
}
const rea: Rea = real ?? transcription;

// valueSetter's loop: onStart(now), step(now), then step at each frame.
function runSpring(lib: Rea, from: number, to: number, config: any, stamps: number[]) {
  const a = lib.withSpring(to, config);
  a.onStart(a, from, stamps[0], undefined);
  const out: { t: number; v: number; done: boolean }[] = [];
  let done = false;
  for (const now of stamps) {
    if (!done) done = a.onFrame(a, now);
    out.push({ t: now - stamps[0], v: a.current, done });
  }
  return { frames: out, anim: a };
}

{
  // Seeded jitter (mulberry32) for irregular frame intervals.
  let seed = 0x5eed;
  const rand = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const t0 = 98_765.4321;
  const segments: [number, number][] = [[0, 1], [-37.5, 512.25], [3, -3], [1e-3, 2e-3], [1000, 1000.5]];
  let worst = 0;
  let worstAt = "";
  let drift = 0;
  let anaGap = 0;
  let restFrames = 0;
  let restBad = "";
  let finishedBefore = 0;
  let constBad = "";
  let transBad = "";
  let samples = 0;
  let configs = 0;
  let zetaExact = 0;
  for (const z of [0.03, 0.08, 0.15, 0.3, 0.5, 0.707, 0.9, 0.99, 1, 1.25, 4]) {
    for (const settle of [1, 0.7, 0.3, 0.08]) {
      for (const [segMs, fps, jitter] of [[400, 60, false], [1000, 30, false], [2500, 120, false], [5000, 24, false], [1500, 60, true]] as const) {
        const [A, B] = segments[configs % segments.length];
        configs++;
        const spring = { dampingRatio: z, settle };
        const cfg = SP.springToReanimated({ spring }, segMs);
        const h = 1000 / fps;
        const stamps = [t0];
        while (stamps[stamps.length - 1] - t0 < segMs + 3 * h) {
          const k = stamps.length;
          stamps.push(jitter ? stamps[k - 1] + h * (0.6 + 0.8 * rand()) : t0 + k * h);
        }
        const { frames, anim } = runSpring(rea, A, B, cfg, stamps);
        // Reanimated recomputes ζ and ω0 from the physics config: bit for bit?
        const omega0 = springOmega(spring) / (segMs / 1000);
        if (anim.omega0 !== omega0) constBad ||= `ω0 ${z}/${settle}/${segMs}: ${anim.omega0} vs ${omega0}`;
        if (anim.zeta === z) zetaExact++;
        else if (Math.abs(anim.zeta - z) > 4e-16 * z) constBad ||= `ζ ${z}: ${anim.zeta}`;
        if (real) {
          const tr = runSpring(transcription, A, B, cfg, stamps).frames;
          const i = tr.findIndex((f, j) => !Object.is(f.v, frames[j].v) || f.done !== frames[j].done);
          if (i >= 0) transBad ||= `${z}/${settle}/${segMs} frame ${i}: transcription ${tr[i].v} real ${frames[i].v}`;
        }
        const D = Math.abs(B - A);
        let doneAt = Infinity;
        for (const f of frames) {
          if (f.done && doneAt === Infinity) doneAt = f.t;
          if (f.t > segMs) break;
          const u = f.t / segMs;
          const want = A + (B - A) * springEase(spring, u);
          const d = Math.abs(f.v - want) / D;
          samples++;
          if (d > worst) {
            worst = d;
            worstAt = `ζ ${z} settle ${settle} T ${segMs} ms ${fps} fps${jitter ? " jitter" : ""} t ${f.t.toFixed(3)}: reanimated ${f.v} toolbox ${want}`;
          }
          // From toolbox's rest point on, Reanimated has finished: === B.
          if (u >= restU(settle)) {
            restFrames++;
            if (!(f.done && f.v === B)) restBad ||= `ζ ${z}/${settle}/${segMs}/${fps}: t ${f.t} u ${u} reanimated ${f.v} done ${f.done}`;
          }
          // Split the gap: Reanimated stepped vs its own analytic solution
          // from the start (per-frame integration), and toolbox vs that
          // analytic solution (units / rounding).
          if (!f.done) {
            const t = f.t / 1000;
            const x0 = A - B;
            const an =
              anim.zeta < 1
                ? rea.underDampedSpringCalculations({ toValue: B }, { zeta: anim.zeta, v0: 0, x0, omega0: anim.omega0, omega1: anim.omega1, t })
                : rea.criticallyDampedSpringCalculations({ toValue: B }, { v0: 0, x0, omega0: anim.omega0, t });
            drift = Math.max(drift, Math.abs(an.position - f.v) / D);
            anaGap = Math.max(anaGap, Math.abs(an.position - want) / D);
          }
        }
        if (doneAt <= segMs) finishedBefore++;
      }
    }
  }
  const TOL = 1e-9;
  check(
    `Reanimated withSpring(B, springToReanimated(key, T)) == toolbox at every frame timestamp, |Δ| ≤ ${TOL} × |B − A| (${configs} configs, ${samples} frames incl. jittered; worst ${worst.toExponential(2)})`,
    worst <= TOL,
    worstAt
  );
  note(`worst: ${worstAt}`);
  note(
    `of which: Reanimated's per-frame stepping vs its own analytic solution ≤ ${drift.toExponential(2)} × |B − A| ` +
      `(it re-solves from the current state each frame, so only rounding accumulates); toolbox vs that analytic solution ≤ ${anaGap.toExponential(2)}`
  );
  check(`from toolbox's rest point on, Reanimated has finished and holds B exactly (${restFrames} frames; ${finishedBefore}/${configs} runs finish before the segment ends)`, !restBad, restBad);
  check(`Reanimated recomputes ω0 bit-exactly and ζ to the ulp from the physics config (ζ exact in ${zetaExact}/${configs})`, !constBad, constBad);
  if (real) check("the transcription returns the real Reanimated's doubles, frame for frame", !transBad, transBad);

  // Duration form, for the record (why the exporter emits the physics form):
  // withSpring({ duration: T/1.5, dampingRatio }) with the default mass.
  const finish = (cfg: any) => {
    const st = [t0];
    for (let k = 1; k < 20_000; k++) st.push(t0 + k * 0.5);
    const f = runSpring(rea, 0, 1, cfg, st).frames.find((x) => x.done);
    return f ? f.t : NaN;
  };
  const rows = [[0.3, 300], [0.5, 300], [0.9, 1000], [1, 1000], [2, 1000]].map(([z, d]) => {
    const r = finish({ duration: d, dampingRatio: z }) / (1.5 * d);
    return `ζ ${z} ${d} ms: ${r.toFixed(2)}×`;
  });
  note(`Reanimated duration config, finish time ÷ 1.5·duration (default mass 4): ${rows.join(", ")}`);
}

// ---- 10. SkSL + helpers ---------------------------------------------------------------------------------
{
  const require = createRequire(path.join(ROOT, "package.json"));
  const CK = await require("canvaskit-wasm")();
  const W = 1024;
  // One W×1 RGBA_F32 row; r = the program's value at pixel i.
  const renderRow = (sksl: string, uniforms: number[]): Float32Array | string => {
    let err = "";
    const effect = CK.RuntimeEffect.Make(sksl, { onError: (e: string) => (err = e) });
    if (!effect) return err;
    const mem = CK.Malloc(Float32Array, W * 4);
    const surf = CK.MakeRasterDirectSurface(
      { width: W, height: 1, colorType: CK.ColorType.RGBA_F32, alphaType: CK.AlphaType.Premul, colorSpace: CK.ColorSpace.SRGB },
      mem,
      W * 16
    );
    const shader = effect.makeShader(uniforms);
    const paint = new CK.Paint();
    paint.setShader(shader);
    paint.setBlendMode(CK.BlendMode.Src);
    surf.getCanvas().drawPaint(paint);
    surf.flush();
    const px = Float32Array.from(mem.toTypedArray());
    paint.delete();
    shader.delete();
    surf.delete();
    CK.Free(mem);
    effect.delete();
    return px;
  };
  const f32 = Math.fround;
  const uAt = (i: number) => f32(i / (W - 1));
  // Skia's CPU raster backend approximates exp / sin / cos (it was built for
  // color math); GPUs don't. Measure that floor here, over the argument
  // ranges the spring uses, and budget the CPU comparison with it.
  const floor = (expr: string, js: (x: number) => number, scale: number, relative: boolean) => {
    const px = renderRow(`uniform float k; half4 main(float2 p) { float x = (p.x - 0.5) / ${W - 1}.0 * k; return half4(float4(${expr}, 0.0, 0.0, 1.0)); }`, [scale]);
    if (typeof px === "string") throw new Error(px);
    let e = 0;
    for (let i = 0; i < W; i++) {
      const x = f32(uAt(i) * f32(scale));
      const want = js(x);
      e = Math.max(e, Math.abs(px[i * 4] - want) / (relative ? Math.max(Math.abs(want), 1e-30) : 1));
    }
    return e;
  };
  const E_EXP = Math.max(floor("exp(-x)", (x) => Math.exp(-x), 30, true), floor("exp(-x)", (x) => Math.exp(-x), 1, true));
  const E_TRIG = Math.max(
    floor("sin(x)", Math.sin, 40, false),
    floor("cos(x)", Math.cos, 40, false),
    floor("sin(x)", Math.sin, 2, false),
    floor("cos(x)", Math.cos, 2, false)
  );
  note(`CanvasKit CPU builtins (this run): exp ≤ ${E_EXP.toExponential(2)} relative, sin/cos ≤ ${E_TRIG.toExponential(2)} absolute`);

  const prog = `${SP.springSksl}
uniform float zeta;
uniform float omega;
uniform float rest;
half4 main(float2 p) {
  float u = (p.x - 0.5) / ${W - 1}.0;
  return half4(float4(tbx_spring(u, zeta, omega, rest), 0.0, 0.0, 1.0));
}
`;
  const probe = renderRow(prog, [0.5, 20, 19]);
  check("springSksl compiles in CanvasKit (strict ES2: float only, no loops)", typeof probe !== "string", typeof probe === "string" ? probe : "");
  check("springSksl uses no loops, ints or ES3 builtins", !/\b(for|while|do|int|uint|round|tanh)\b/.test(SP.springSksl));
  if (typeof probe !== "string") {
    let refWorst = 0;
    let refAt = "";
    let cpuWorst = 0;
    let cpuAt = "";
    let cpuBad = "";
    let snaps = 0;
    let configs = 0;
    for (const z of [0.02, 0.1, 0.3, 0.5, 0.8, 0.97, 1, 3]) {
      for (const settle of [1, 0.6, 0.15]) {
        configs++;
        const sp = { dampingRatio: z, settle };
        const a = SP.springSkslArgs(sp);
        const px = renderRow(prog, [a.zeta, a.omega, a.rest]) as Float32Array;
        const c = z < 1 ? z / Math.sqrt(1 - z * z) : 0;
        for (let i = 0; i < W; i++) {
          const u = uAt(i);
          const js = springEase(sp, u);
          const ref = SP.springSkslReference(u, a.zeta, a.omega, a.rest);
          const cpu = px[i * 4];
          // fp32 can land a sample on the other side of the snap from the
          // double: there the two differ by the residual (≤ √threshold).
          const snapSide = (x: number) => x === 1;
          const flips = snapSide(js) !== snapSide(ref) || snapSide(ref) !== snapSide(cpu);
          if (flips) snaps++;
          const slack = flips ? Math.sqrt(THR) * 1.01 : 0;
          const dRef = Math.abs(ref - js);
          if (dRef - slack > refWorst) {
            refWorst = dRef - slack;
            refAt = `ζ ${z}/${settle} u ${u}: fp32 ${ref} js ${js}`;
          }
          // CPU budget: the measured builtin errors through the formula.
          const ou = f32(a.omega) * u;
          const env = z < 1 ? Math.exp(-z * ou) : Math.exp(-ou);
          const budget = 1.25 * env * (z < 1 ? (1 + c) * (E_TRIG + E_EXP) : E_EXP * (1 + ou)) + 4e-6;
          const dCpu = Math.abs(cpu - ref);
          if (dCpu > cpuWorst) {
            cpuWorst = dCpu;
            cpuAt = `ζ ${z}/${settle} u ${u}: cpu ${cpu} fp32 ${ref} (budget ${budget.toExponential(2)})`;
          }
          if (dCpu - slack > budget) cpuBad ||= `ζ ${z}/${settle} u ${u}: cpu ${cpu} fp32 ${ref} js ${js} budget ${budget}`;
        }
      }
    }
    check(
      `tbx_spring in fp32 (springSkslReference, GPU precision) == springEase within 2e-6 (${configs} configs × ${W} u; worst ${refWorst.toExponential(2)})`,
      refWorst <= 2e-6,
      refAt
    );
    check(
      `springSksl rendered by CanvasKit (CPU) == the fp32 reference within the measured builtin error (worst ${cpuWorst.toExponential(2)})`,
      !cpuBad,
      cpuBad
    );
    note(`worst CPU sample: ${cpuAt}${snaps ? `; ${snaps} samples where fp32 rounding moved the snap (held to √threshold)` : ""}`);
  }
  const call = SP.springSkslCall({ dampingRatio: 0.35, settle: 0.8 }, "t");
  const callProg = `${SP.springSksl}\nhalf4 main(float2 p) { float t = p.x / 100.0; return half4(${call}); }`;
  let callErr = "";
  const ce = CK.RuntimeEffect.Make(callProg, { onError: (e: string) => (callErr = e) });
  check(`springSkslCall emits a compiling call with fp32-exact literals (${call})`, !!ce && /^tbx_spring\(t, [-\d.e+]+, [-\d.e+]+, [-\d.e+]+\)$/.test(call), callErr);
  const args = SP.springSkslArgs({ dampingRatio: 0.35, settle: 0.8 });
  const lits = call.slice(call.indexOf(",") + 1, -1).split(",").map((s) => Number(s.trim()));
  check("…whose literals round-trip the fp32 args", lits.every((x, i) => Math.fround(x) === Math.fround([args.zeta, args.omega, args.rest][i])));

  let threw = 0;
  for (const bad of [0, -5, NaN, Infinity, "100" as any]) {
    try {
      SP.springToReanimated({ spring: { dampingRatio: 0.5 } }, bad);
    } catch {
      threw++;
    }
  }
  check("springToReanimated refuses a non-positive / non-finite segment length", threw === 5);
  const cfg = SP.springToReanimated({ easingOut: "spring", spring: { dampingRatio: 0.4, settle: 0.5 } } as any, 800);
  const cfg2 = SP.springToReanimated({ dampingRatio: 0.4, settle: 0.5 }, 800);
  check(
    "springToReanimated: the full physics config (mass 1, from rest, no clamping, default threshold), from a keyframe or its spring",
    JSON.stringify(Object.keys(cfg).sort()) === JSON.stringify(["damping", "energyThreshold", "mass", "overshootClamping", "stiffness", "velocity"]) &&
      cfg.mass === 1 && cfg.velocity === 0 && cfg.overshootClamping === false && cfg.energyThreshold === 6e-9 &&
      Object.is(cfg.stiffness, (springOmega({ dampingRatio: 0.4, settle: 0.5 }) / 0.8) ** 2) && JSON.stringify(cfg) === JSON.stringify(cfg2)
  );
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
