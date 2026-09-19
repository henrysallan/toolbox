// check-easing-editor: the pure half of the Tracks editor's easing overlay
// (specdocs/091726_easing-editor.md) — the `cubicBezier` easing kind and
// the pair / seed / view logic the overlay rides.
//
//   - cubicBezierEase is a CSS cubic-bezier time remap: the thirds curve is
//     the identity, the exact table entries reproduce t² / t³ / their
//     ease-outs, y overshoots, x is clamped so time stays monotonic.
//   - evaluateKeyframesAt plays a cubicBezier on a scalar exactly like the
//     same shape denormalized into customBezier handles, applies it to vec
//     / color lanes (the type-agnostic point), plays a shapeless key and an
//     unknown preset name as linear.
//   - normalizedBezierOfSegment reads every easing kind into the unit
//     square (exact / normalized handles / preset table / null), and
//     denormalize → normalize round-trips.
//   - easingPairsFor is the adjacency rule: both selected AND adjacent in
//     the lane, per lane, across lanes, step-only lanes left out; the
//     first pair is earliest-then-topmost.
//   - seedForPair / pairsUniform / applyBezierToLane behave as the spec
//     says; the view math keeps the cursor fixed under zoom.
//
//   npx tsx scripts/check-easing-editor.mts

import {
  EASING_PRESET_BEZIER,
  EASING_PRESET_ORDER,
  LINEAR_BEZIER,
  bezierHandlesForSegment,
  bezierPathFor,
  cubicBezierEase,
  evaluateKeyframesAt,
  normalizedBezierOfSegment,
  sanitizeBezierEasing,
  type BezierEasing,
  type EasingPreset,
  type Keyframe,
  type KeyframeAnimationBlock,
} from "@/engine/keyframes";
import {
  GRID_MIN_SIZE,
  OVERLAY_HEADER_H,
  OVERLAY_READOUT_H,
  SHELF_ROW_H,
  applyBezierToLane,
  applyPresetToLane,
  autoEasingName,
  bezierPathD,
  clampEasingView,
  clampHandle,
  easingPairsFor,
  firstEasingPair,
  fitEasingView,
  fitOverlay,
  ghostPathD,
  overlayHeightFor,
  pairsUniform,
  pxToUnit,
  sameBezier,
  seedForPair,
  trayHeightFor,
  trayRows,
  unitToPx,
  zoomEasingView,
  type EasingLane,
} from "@/components/effects/timeline/easing-editor";
import type { SelectionKey } from "@/components/effects/timeline/keyframe-ops";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
const sameShape = (a: BezierEasing | null, b: BezierEasing | null, eps = 1e-6) =>
  !!a &&
  !!b &&
  near(a.x1, b.x1, eps) &&
  near(a.y1, b.y1, eps) &&
  near(a.x2, b.x2, eps) &&
  near(a.y2, b.y2, eps);
const samples = Array.from({ length: 9 }, (_, i) => (i + 1) / 10);

// --- cubicBezierEase -------------------------------------------------------

check(
  "thirds curve is the identity",
  samples.every((t) => near(cubicBezierEase(LINEAR_BEZIER, t), t))
);
check(
  "easeInQuad table entry reproduces t² exactly",
  samples.every((t) => near(cubicBezierEase(EASING_PRESET_BEZIER.easeInQuad!, t), t * t))
);
check(
  "easeOutCubic table entry reproduces 1−(1−t)³ exactly",
  samples.every((t) =>
    near(cubicBezierEase(EASING_PRESET_BEZIER.easeOutCubic!, t), 1 - (1 - t) ** 3)
  )
);
check(
  "easeInCubic table entry reproduces t³ exactly",
  samples.every((t) => near(cubicBezierEase(EASING_PRESET_BEZIER.easeInCubic!, t), t ** 3))
);
{
  const back: BezierEasing = { x1: 0.3, y1: 1.6, x2: 0.6, y2: 1 };
  const max = Math.max(...samples.map((t) => cubicBezierEase(back, t)));
  check("a handle above the square overshoots past 1", max > 1.05, `max ${max.toFixed(3)}`);
}
{
  const wild: BezierEasing = { x1: 2, y1: 0, x2: -1, y2: 1 };
  const vals = samples.map((t) => cubicBezierEase(wild, t));
  const monotonic = vals.every((v, i) => i === 0 || v >= vals[i - 1] - 1e-9);
  check(
    "out-of-range x clamps: finite and monotonic",
    vals.every(Number.isFinite) && monotonic,
    vals.map((v) => v.toFixed(3)).join(" ")
  );
}
check(
  "endpoints pin to 0 and 1",
  cubicBezierEase({ x1: 0.1, y1: 3, x2: 0.9, y2: -2 }, 0) === 0 &&
    cubicBezierEase({ x1: 0.1, y1: 3, x2: 0.9, y2: -2 }, 1) === 1
);

// --- evaluation --------------------------------------------------------------

const shape: BezierEasing = { x1: 0.2, y1: 1.3, x2: 0.7, y2: 0.9 };
const ticks = Array.from({ length: 19 }, (_, i) => (i + 1) * 500);
{
  const a: Keyframe = { tick: 0, value: 2, easingOut: "cubicBezier", bezier: shape };
  const b: Keyframe = { tick: 10000, value: 12, easingOut: "linear" };
  const viaCubic: KeyframeAnimationBlock = {
    animated: true,
    trackVisible: true,
    keyframes: [a, b],
  };
  const h = bezierHandlesForSegment(shape, a, b);
  const viaCustom: KeyframeAnimationBlock = {
    animated: true,
    trackVisible: true,
    keyframes: [
      {
        tick: 0,
        value: 2,
        easingOut: "customBezier",
        bezierHandles: { rightHandle: h.right, leftHandle: { dx: 0, dy: 0 } },
      },
      {
        tick: 10000,
        value: 12,
        easingOut: "linear",
        bezierHandles: { rightHandle: { dx: 0, dy: 0 }, leftHandle: h.left },
      },
    ],
  };
  check(
    "scalar cubicBezier ≡ the same shape as customBezier handles",
    ticks.every((t) =>
      near(
        evaluateKeyframesAt(viaCubic, "scalar", t) as number,
        evaluateKeyframesAt(viaCustom, "scalar", t) as number
      )
    )
  );
  check(
    "scalar cubicBezier = a + (b−a)·ease(t)",
    ticks.every((t) =>
      near(
        evaluateKeyframesAt(viaCubic, "scalar", t) as number,
        2 + 10 * cubicBezierEase(shape, t / 10000)
      )
    )
  );
}
{
  const block: KeyframeAnimationBlock = {
    animated: true,
    trackVisible: true,
    keyframes: [
      { tick: 0, value: [0, 10], easingOut: "cubicBezier", bezier: shape },
      { tick: 10000, value: [4, -10], easingOut: "linear" },
    ],
  };
  check(
    "vec2 cubicBezier remaps every component (type-agnostic)",
    ticks.every((t) => {
      const v = evaluateKeyframesAt(block, "vec2", t) as number[];
      const e = cubicBezierEase(shape, t / 10000);
      return near(v[0], 4 * e) && near(v[1], 10 - 20 * e);
    })
  );
}
{
  const block: KeyframeAnimationBlock = {
    animated: true,
    trackVisible: true,
    keyframes: [
      { tick: 0, value: "#000000", easingOut: "cubicBezier", bezier: shape },
      { tick: 10000, value: "#ffffff", easingOut: "linear" },
    ],
  };
  const v = evaluateKeyframesAt(block, "color", 5000);
  check(
    "color cubicBezier evaluates to a finite RGBA tuple",
    Array.isArray(v) && v.length === 4 && (v as number[]).every(Number.isFinite),
    JSON.stringify(v)
  );
}
{
  const block: KeyframeAnimationBlock = {
    animated: true,
    trackVisible: true,
    keyframes: [
      { tick: 0, value: 0, easingOut: "cubicBezier" },
      { tick: 10000, value: 1, easingOut: "linear" },
    ],
  };
  check(
    "a cubicBezier key without a shape plays linear",
    ticks.every((t) => near(evaluateKeyframesAt(block, "scalar", t) as number, t / 10000))
  );
}
{
  const block: KeyframeAnimationBlock = {
    animated: true,
    trackVisible: true,
    keyframes: [
      { tick: 0, value: 0, easingOut: "someFutureEasing" as EasingPreset },
      { tick: 10000, value: 1, easingOut: "linear" },
    ],
  };
  check(
    "an unknown preset name plays linear instead of NaN",
    ticks.every((t) => near(evaluateKeyframesAt(block, "scalar", t) as number, t / 10000))
  );
}
{
  const block: KeyframeAnimationBlock = {
    animated: true,
    trackVisible: true,
    keyframes: [
      { tick: 0, value: 0, easingOut: "hold", bezier: shape },
      { tick: 10000, value: 1, easingOut: "linear" },
    ],
  };
  check(
    "a stale `bezier` on a non-cubicBezier key is inert",
    ticks.every((t) => evaluateKeyframesAt(block, "scalar", t) === 0)
  );
}
check(
  "cubicBezier is not a picker tile",
  !EASING_PRESET_ORDER.includes("cubicBezier")
);

// --- sanitize ------------------------------------------------------------------

check("sanitize: junk → null", sanitizeBezierEasing(null) === null && sanitizeBezierEasing("x") === null && sanitizeBezierEasing({}) === null);
check(
  "sanitize: non-finite → null",
  sanitizeBezierEasing({ x1: NaN, y1: 0, x2: 1, y2: 1 }) === null &&
    sanitizeBezierEasing({ x1: 0, y1: Infinity, x2: 1, y2: 1 }) === null
);
check(
  "sanitize: clamps x, keeps y",
  sameShape(sanitizeBezierEasing({ x1: -0.5, y1: -0.4, x2: 1.5, y2: 1.7 }), {
    x1: 0,
    y1: -0.4,
    x2: 1,
    y2: 1.7,
  })
);

// --- normalizedBezierOfSegment -------------------------------------------------

{
  const a: Keyframe = { tick: 0, value: 0, easingOut: "cubicBezier", bezier: shape };
  const b: Keyframe = { tick: 1000, value: 10, easingOut: "linear" };
  check("normalize: cubicBezier reads back exactly", sameShape(normalizedBezierOfSegment(a, b), shape));
}
{
  const a: Keyframe = {
    tick: 0,
    value: 0,
    easingOut: "customBezier",
    bezierHandles: { rightHandle: { dx: 420, dy: 0 }, leftHandle: { dx: 0, dy: 0 } },
  };
  const b: Keyframe = {
    tick: 1000,
    value: 10,
    easingOut: "linear",
    bezierHandles: { rightHandle: { dx: 0, dy: 0 }, leftHandle: { dx: -420, dy: 0 } },
  };
  check(
    "normalize: customBezier handles → unit square",
    sameShape(normalizedBezierOfSegment(a, b), { x1: 0.42, y1: 0, x2: 0.58, y2: 1 })
  );
  const flatA: Keyframe = {
    tick: 0,
    value: 5,
    easingOut: "customBezier",
    bezierHandles: { rightHandle: { dx: 300, dy: 0.5 }, leftHandle: { dx: 0, dy: 0 } },
  };
  const flatB: Keyframe = { tick: 1000, value: 5, easingOut: "linear" };
  const flat = normalizedBezierOfSegment(flatA, flatB);
  check(
    "normalize: a flat segment measures dy against 1 value unit",
    !!flat && near(flat.x1, 0.3) && near(flat.y1, 0.5),
    JSON.stringify(flat)
  );
}
{
  const a: Keyframe = { tick: 0, value: 0, easingOut: "easeInOutCubic" };
  const b: Keyframe = { tick: 1000, value: 1, easingOut: "linear" };
  check(
    "normalize: preset with a cubic equivalent → table entry",
    sameShape(normalizedBezierOfSegment(a, b), EASING_PRESET_BEZIER.easeInOutCubic!)
  );
  check(
    "normalize: bounce / hold have no single cubic → null",
    normalizedBezierOfSegment({ ...a, easingOut: "easeOutBounce" }, b) === null &&
      normalizedBezierOfSegment({ ...a, easingOut: "hold" }, b) === null
  );
}
{
  const a: Keyframe = { tick: 2000, value: -3, easingOut: "customBezier" };
  const b: Keyframe = { tick: 6000, value: 9, easingOut: "linear" };
  const h = bezierHandlesForSegment(shape, a, b);
  const roundTrip = normalizedBezierOfSegment(
    { ...a, bezierHandles: { rightHandle: h.right, leftHandle: { dx: 0, dy: 0 } } },
    { ...b, bezierHandles: { rightHandle: { dx: 0, dy: 0 }, leftHandle: h.left } }
  );
  check("denormalize → normalize round-trips", sameShape(roundTrip, shape));
}

// --- pairs ----------------------------------------------------------------------

const kf = (tick: number, easingOut: EasingPreset = "easeInQuad", extra: Partial<Keyframe> = {}): Keyframe => ({
  tick,
  value: tick / 1000,
  easingOut,
  ...extra,
});
const laneP: EasingLane = {
  keyframes: [kf(0), kf(10000), kf(20000), kf(30000)],
  paramType: "scalar",
  rowIdx: 1,
};
const laneQ: EasingLane = {
  keyframes: [kf(5000), kf(15000)],
  paramType: "vec2",
  rowIdx: 2,
};
const laneFlag: EasingLane = {
  keyframes: [kf(0, "hold", { value: true }), kf(10000, "hold", { value: false })],
  paramType: "boolean",
  rowIdx: 3,
};
const lanes = new Map<string, EasingLane>([
  ["n\u0000p", laneP],
  ["n\u0000q", laneQ],
  ["n\u0000flag", laneFlag],
]);
const getLane = (nodeId: string, paramName: string) => lanes.get(`${nodeId}\u0000${paramName}`);
const sel = (param: string, ...ticks: number[]): SelectionKey[] =>
  ticks.map((tick) => ({ nodeId: "n", paramName: param, tick }));
const pairKeys = (pairs: { aTick: number; bTick: number }[]) => pairs.map((p) => `${p.aTick}-${p.bTick}`).join(" ");

{
  const { pairs } = easingPairsFor(sel("p", 0, 10000, 20000), getLane);
  check(
    "pairs: three in a row → two segments, the last key keeps its own easing",
    pairKeys(pairs) === "0-10000 10000-20000",
    pairKeys(pairs)
  );
}
check(
  "pairs: a skipped key breaks the chain",
  pairKeys(easingPairsFor(sel("p", 0, 30000), getLane).pairs) === ""
);
check(
  "pairs: non-adjacent third key contributes nothing",
  pairKeys(easingPairsFor(sel("p", 0, 10000, 30000), getLane).pairs) === "0-10000"
);
{
  const { pairs } = easingPairsFor([...sel("p", 10000, 20000), ...sel("q", 5000, 15000)], getLane);
  check(
    "pairs: collected across lanes",
    pairs.length === 2 && pairs.some((p) => p.paramName === "q" && p.aTick === 5000),
    pairKeys(pairs)
  );
  const first = firstEasingPair(pairs);
  check(
    "first pair: earliest in time wins across lanes",
    first?.paramName === "q" && first.aTick === 5000
  );
}
{
  const tie = firstEasingPair([
    { nodeId: "n", paramName: "q", aTick: 0, bTick: 1, rowIdx: 2 },
    { nodeId: "n", paramName: "p", aTick: 0, bTick: 1, rowIdx: 1 },
  ]);
  check("first pair: a tie goes to the topmost lane", tie?.paramName === "p");
}
check(
  "pairs: a single column across lanes is no pair",
  easingPairsFor([...sel("p", 0), ...sel("q", 5000)], getLane).pairs.length === 0
);
{
  const r = easingPairsFor(sel("flag", 0, 10000), getLane);
  check("pairs: step-only lanes are left out and flagged", r.pairs.length === 0 && r.skippedStepOnly);
}
check(
  "pairs: a lane the editor can't see is skipped",
  easingPairsFor(sel("missing", 0, 1), getLane).pairs.length === 0
);

// --- seeds ---------------------------------------------------------------------

{
  const b = kf(1000);
  const s1 = seedForPair(kf(0, "cubicBezier", { bezier: shape }), b);
  check("seed: cubicBezier → exact", s1.source === "bezier" && sameShape(s1.bezier, shape));
  const s2 = seedForPair(kf(0, "easeInOutCubic"), b);
  check(
    "seed: preset → table entry, names the preset",
    s2.source === "preset" &&
      s2.preset === "easeInOutCubic" &&
      sameShape(s2.bezier, EASING_PRESET_BEZIER.easeInOutCubic!)
  );
  const s3 = seedForPair(kf(0, "easeOutBounce"), b);
  check(
    "seed: bounce → ghost with linear handles, names the preset",
    s3.source === "ghost" &&
      s3.ghost === "easeOutBounce" &&
      s3.preset === "easeOutBounce" &&
      sameShape(s3.bezier, LINEAR_BEZIER)
  );
  const s4 = seedForPair(kf(0, "hold"), b);
  check("seed: hold → ghost", s4.source === "ghost" && s4.ghost === "hold");
  check("seed: a user shape names no preset", s1.preset === undefined);
  const h = bezierHandlesForSegment(shape, kf(0), b);
  const s5 = seedForPair(
    kf(0, "customBezier", { bezierHandles: { rightHandle: h.right, leftHandle: { dx: 0, dy: 0 } } }),
    { ...b, bezierHandles: { rightHandle: { dx: 0, dy: 0 }, leftHandle: h.left } }
  );
  check("seed: customBezier → normalized handles", s5.source === "custom" && sameShape(s5.bezier, shape));
}

// --- uniform + apply -----------------------------------------------------------

{
  const pairs = easingPairsFor(sel("p", 0, 10000, 20000), getLane).pairs;
  const keysOf =
    (ks: Keyframe[]) =>
    (p: { aTick: number; bTick: number }): [Keyframe, Keyframe] | undefined => {
      const a = ks.find((k) => k.tick === p.aTick);
      const b = ks.find((k) => k.tick === p.bTick);
      return a && b ? [a, b] : undefined;
    };
  check("uniform: same preset everywhere", pairsUniform(pairs, keysOf(laneP.keyframes)));
  const mixed = laneP.keyframes.map((k, i) => (i === 1 ? { ...k, easingOut: "easeOutQuad" as const } : k));
  check("uniform: differing presets → mixed", !pairsUniform(pairs, keysOf(mixed)));
  const equivalent = laneP.keyframes.map((k, i) =>
    i === 1 ? { ...k, easingOut: "cubicBezier" as const, bezier: EASING_PRESET_BEZIER.easeInQuad! } : k
  );
  check(
    "uniform: a cubicBezier equal to the preset's cubic counts as the same",
    pairsUniform(pairs, keysOf(equivalent))
  );
  const bounces = laneP.keyframes.map((k) => ({ ...k, easingOut: "easeOutBounce" as const }));
  check("uniform: presets without a cubic compare by name", pairsUniform(pairs, keysOf(bounces)));

  const original = laneP.keyframes.map((k) => ({ ...k, bezierHandles: { rightHandle: { dx: 1, dy: 1 }, leftHandle: { dx: -1, dy: -1 } } }));
  const snapshot = JSON.stringify(original);
  const written = applyBezierToLane(original, new Set(pairs.map((p) => p.aTick)), shape);
  check(
    "apply: only pair-owning keys become cubicBezier",
    written[0].easingOut === "cubicBezier" &&
      written[1].easingOut === "cubicBezier" &&
      written[2].easingOut === "easeInQuad" &&
      written[3].easingOut === "easeInQuad" &&
      sameShape(written[0].bezier ?? null, shape) &&
      sameShape(written[1].bezier ?? null, shape)
  );
  check(
    "apply: handles, values and ticks untouched; input not mutated",
    written.every((k, i) => k.tick === original[i].tick && k.value === original[i].value && k.bezierHandles === original[i].bezierHandles) &&
      JSON.stringify(original) === snapshot
  );
  check("apply: the written shape is a copy", written[0].bezier !== shape);
  const named = applyPresetToLane(written, new Set(pairs.map((p) => p.aTick)), "easeOutBounce");
  check(
    "apply preset: pair-owning keys take the named preset, the rest keep theirs",
    named[0].easingOut === "easeOutBounce" &&
      named[1].easingOut === "easeOutBounce" &&
      named[2].easingOut === "easeInQuad" &&
      named[3].easingOut === "easeInQuad" &&
      named[0].bezier === written[0].bezier
  );
  const reread = pairs.map((p) => seedForPair(written.find((k) => k.tick === p.aTick)!, written.find((k) => k.tick === p.bTick)!));
  check(
    "apply → seed: every pair reads the shape back and the set is uniform",
    reread.every((s) => s.source === "bezier" && sameShape(s.bezier, shape)) && pairsUniform(pairs, keysOf(written))
  );
}

// --- view math -----------------------------------------------------------------

{
  const v = fitEasingView(220, 28);
  const o = unitToPx(v, 0, 0);
  const t = unitToPx(v, 1, 1);
  check("view: fit puts (0,0) bottom-left and (1,1) top-right", near(o.x, 28) && near(o.y, 192) && near(t.x, 192) && near(t.y, 28));
  const u = pxToUnit(v, 100, 50);
  const back = unitToPx(v, u.x, u.y);
  check("view: px ↔ unit round-trips", near(back.x, 100) && near(back.y, 50));
  const z = zoomEasingView(v, 1.7, 100, 50, 20, 4000);
  const under = pxToUnit(z, 100, 50);
  check("view: zoom keeps the point under the cursor fixed", near(under.x, u.x) && near(under.y, u.y) && near(z.scale, v.scale * 1.7));
  const clamped = zoomEasingView(v, 100, 0, 0, 20, 300);
  check("view: zoom clamps to the scale range", near(clamped.scale, 300));
  check("view: handle x clamps, y is free", clampHandle(1.4, -0.3).x === 1 && clampHandle(-2, 2.5).x === 0 && clampHandle(0.5, 2.5).y === 2.5);
  const d = bezierPathD(shape, v);
  check("view: curve path is one cubic", d.startsWith("M ") && (d.match(/ C /g) ?? []).length === 1, d);
  const g = ghostPathD("hold", v);
  check("view: hold ghost is the step", (g.match(/ L /g) ?? []).length === 2, g);
  const gb = ghostPathD("easeOutBounce", v, 24);
  check("view: sampled ghost has every sample", (gb.match(/ L /g) ?? []).length === 24);

  // Pan clamp: the unit square can be pushed around but never out of the
  // canvas — at least `margin` px of it stays inside on each axis.
  const far = clampEasingView({ scale: v.scale, ox: 5000, oy: -5000 }, 220, 24);
  check(
    "view: pan clamp keeps the square reachable (pushed off to the right / top)",
    near(far.ox, 220 - 24) && near(far.oy, 24),
    JSON.stringify(far)
  );
  const farLeft = clampEasingView({ scale: v.scale, ox: -5000, oy: 5000 }, 220, 24);
  check(
    "view: pan clamp keeps the square reachable (pushed off to the left / bottom)",
    near(farLeft.ox, 24 - v.scale) && near(farLeft.oy, 220 - 24 + v.scale),
    JSON.stringify(farLeft)
  );
  check("view: pan clamp leaves an in-range view untouched", clampEasingView(v, 220, 24) === v);
  const big = zoomEasingView(v, 30, 110, 110, 20, 6000);
  const bigClamped = clampEasingView(big, 220, 24);
  check(
    "view: a zoomed-in square still intersects the canvas after the clamp",
    bigClamped.ox <= 220 - 24 && bigClamped.ox + bigClamped.scale >= 24 && bigClamped.oy >= 24 && bigClamped.oy - bigClamped.scale <= 220 - 24
  );
}

// --- tray helpers -----------------------------------------------------------

check(
  "sameBezier: within tolerance is the same, beyond is not",
  sameBezier(shape, { ...shape, y1: shape.y1 + 5e-4 }) && !sameBezier(shape, { ...shape, y1: shape.y1 + 0.01 })
);
check("autoEasingName: first free number, case-insensitive", autoEasingName([]) === "Easing 1");
check(
  "autoEasingName: skips taken names",
  autoEasingName([{ name: "Easing 1" }, { name: "easing 2" }, { name: "Snap" }]) === "Easing 3" &&
    autoEasingName([{ name: "Easing 2" }]) === "Easing 1"
);
{
  const d = bezierPathFor(shape, 28, 28);
  check("bezierPathFor: one cubic in the tile box", d.startsWith("M 0 ") && (d.match(/ C /g) ?? []).length === 1 && d.endsWith(`28.00 ${(28 * 0.18).toFixed(2)}`), d);
}

// --- shelf layout / fit-to-height ----------------------------------------------

{
  const tray = { builtins: 17, saved: 0 };
  check("shelf: rows wrap with the width", trayRows(17, 240) === 3 && trayRows(17, 600) === 1 && trayRows(0, 240) === 0);
  check("shelf: the saved block always has the + tile", trayHeightFor(240, { builtins: 0, saved: 0 }) > 0);
  check("shelf: no tray → no height", trayHeightFor(240, null) === 0 && overlayHeightFor(240, null) === OVERLAY_HEADER_H + 240 + OVERLAY_READOUT_H);
  const wider = trayHeightFor(600, tray);
  const narrower = trayHeightFor(240, tray);
  check("shelf: a wider overlay needs fewer rows", wider < narrower, `${wider} vs ${narrower}`);
  check(
    "shelf: narrowing the square makes the grid taller, not shorter",
    trayHeightFor(160, tray) > trayHeightFor(240, tray)
  );
  const none = fitOverlay(240, undefined, tray, 160);
  check("fit: no maxHeight → preferred size, grid", none.size === 240 && none.shelf === "grid");
  const roomy = fitOverlay(240, 2000, tray, 160);
  check("fit: enough room → preferred size, grid", roomy.size === 240 && roomy.shelf === "grid");
  const snug = fitOverlay(240, overlayHeightFor(240, tray), tray, 160);
  check("fit: exactly enough room still takes the grid", snug.size === 240 && snug.shelf === "grid");
  const gridShrunk = fitOverlay(240, overlayHeightFor(220, tray), tray, 160);
  check(
    "fit: a little short → a slightly smaller square keeps the grid",
    gridShrunk.shelf === "grid" &&
      gridShrunk.size <= 220 &&
      gridShrunk.size >= GRID_MIN_SIZE &&
      overlayHeightFor(gridShrunk.size, tray) <= overlayHeightFor(220, tray),
    JSON.stringify(gridShrunk)
  );
  const tight = fitOverlay(240, 300, tray, 160);
  check(
    "fit: a short dock collapses the shelf to one row and gives the square the rest",
    tight.shelf === "row" &&
      tight.size === 300 - OVERLAY_HEADER_H - OVERLAY_READOUT_H - SHELF_ROW_H &&
      tight.size >= 160,
    JSON.stringify(tight)
  );
  // Grid heights at 240…200 range 407…436 (non-monotonic: the tiles per
  // row drop at 216), so 400 fits no grid at all while the row form
  // (22 + 240 + 20 + 42 = 324) fits with the full square.
  const rowBig = fitOverlay(240, 400, tray, 160);
  check(
    "fit: when the grid can't fit even at its floor, the row keeps the full square",
    rowBig.shelf === "row" && rowBig.size === 240,
    JSON.stringify(rowBig)
  );
  const tiny = fitOverlay(240, 100, tray, 160);
  check("fit: never below the minimum (the overlay then overflows)", tiny.size === 160 && tiny.shelf === "row");
  const bare = fitOverlay(240, 250, null, 160);
  check(
    "fit: without a shelf the square just takes the room",
    bare.size === 250 - OVERLAY_HEADER_H - OVERLAY_READOUT_H && bare.shelf === "grid",
    JSON.stringify(bare)
  );
  check(
    "fit: monotonic in the available height",
    fitOverlay(240, 350, tray, 160).size >= tight.size && roomy.size >= gridShrunk.size
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall easing-editor checks passed");
