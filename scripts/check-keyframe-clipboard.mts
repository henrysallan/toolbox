// check-keyframe-clipboard: the shared keyframe clipboard behind the Tracks
// editor's Cmd+C / Cmd+V and the Graph editor's empty-space right-click
// menu (Copy / Paste / Paste flipped).
//
//   - reverseEasingPreset swaps every ease-in with its ease-out (and the
//     legacy easeIn/easeOut aliases); in-outs, linear, hold and the
//     mirror-less bounce/elastic come back unchanged.
//   - reverseBezierEasing reflects the shape through the unit square's
//     centre: an involution, and the easeInQuad table entry becomes the
//     easeOutQuad one.
//   - flipKeyframesInTime mirrors ticks about the span midpoint (integers
//     stay integers), keeps values, and — the point — a flipped block
//     evaluates at t exactly as the original does at min+max−t across
//     linear / preset / cubicBezier / customBezier (explicit and default
//     handles) segments, on scalars and vecs. Flipping twice is identity.
//   - flipClipboardItems mirrors a multi-lane clipboard about the WHOLE
//     span so lanes stay aligned, and keeps offset 0 on the first key.
//   - buildPasteUpdates re-anchors at a tick, replaces a colliding key,
//     sorts, marks the block animated, drops sub-zero ticks and skips a
//     lane whose block is gone.
//
//   npx tsx scripts/check-keyframe-clipboard.mts

import {
  EASING_PRESET_BEZIER,
  evaluateKeyframesAt,
  type BezierEasing,
  type EasingPreset,
  type Keyframe,
  type KeyframeAnimationBlock,
} from "@/engine/keyframes";
import {
  buildPasteUpdates,
  clipboardItemsFrom,
  flipClipboardItems,
  flipKeyframesInTime,
  getKeyframeClipboard,
  reverseBezierEasing,
  reverseEasingPreset,
  setKeyframeClipboard,
} from "@/components/effects/timeline/keyframe-clipboard";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
const sameShape = (a: BezierEasing, b: BezierEasing, eps = 1e-9) =>
  near(a.x1, b.x1, eps) &&
  near(a.y1, b.y1, eps) &&
  near(a.x2, b.x2, eps) &&
  near(a.y2, b.y2, eps);
const block = (keyframes: Keyframe[]): KeyframeAnimationBlock => ({
  animated: true,
  trackVisible: true,
  keyframes,
});

// --- reverseEasingPreset -----------------------------------------------------

{
  const pairs: [EasingPreset, EasingPreset][] = [
    ["easeIn", "easeOut"],
    ["easeInSine", "easeOutSine"],
    ["easeInQuad", "easeOutQuad"],
    ["easeInCubic", "easeOutCubic"],
    ["easeInExpo", "easeOutExpo"],
    ["easeInBack", "easeOutBack"],
  ];
  check(
    "every ease-in ↔ ease-out pair swaps both ways",
    pairs.every(
      ([i, o]) => reverseEasingPreset(i) === o && reverseEasingPreset(o) === i
    )
  );
  const fixed: EasingPreset[] = [
    "linear",
    "easeInOut",
    "easeInOutSine",
    "easeInOutQuad",
    "easeInOutCubic",
    "hold",
    "customBezier",
    "cubicBezier",
    "easeOutBounce",
    "easeOutElastic",
  ];
  check(
    "symmetric and mirror-less presets come back unchanged",
    fixed.every((p) => reverseEasingPreset(p) === p)
  );
}

// --- reverseBezierEasing -----------------------------------------------------

{
  const e: BezierEasing = { x1: 0.2, y1: 1.3, x2: 0.7, y2: 0.9 };
  check(
    "reversing a shape twice is the identity",
    sameShape(reverseBezierEasing(reverseBezierEasing(e)), e)
  );
  check(
    "reversed easeInQuad table entry is the easeOutQuad one",
    sameShape(
      reverseBezierEasing(EASING_PRESET_BEZIER.easeInQuad!),
      EASING_PRESET_BEZIER.easeOutQuad!
    )
  );
  check(
    "reversed easeInCubic table entry is the easeOutCubic one",
    sameShape(
      reverseBezierEasing(EASING_PRESET_BEZIER.easeInCubic!),
      EASING_PRESET_BEZIER.easeOutCubic!
    )
  );
}

// --- flipKeyframesInTime -----------------------------------------------------

// A scalar lane exercising every reversible easing kind: preset, linear,
// cubicBezier shape, customBezier with explicit handles, customBezier
// riding the chord-third defaults.
const scalar: Keyframe[] = [
  { tick: 1000, value: 0, easingOut: "easeInQuad" },
  { tick: 4000, value: 10, easingOut: "linear" },
  {
    tick: 6000,
    value: 4,
    easingOut: "cubicBezier",
    bezier: { x1: 0.1, y1: 1.4, x2: 0.8, y2: 0.7 },
  },
  {
    tick: 9000,
    value: 12,
    easingOut: "customBezier",
    bezierHandles: {
      rightHandle: { dx: 700, dy: 5 },
      leftHandle: { dx: -400, dy: 2 },
    },
  },
  {
    tick: 13000,
    value: -3,
    easingOut: "customBezier",
    bezierHandles: {
      rightHandle: { dx: 1500, dy: -6 },
      leftHandle: { dx: -1200, dy: -1 },
    },
  },
  { tick: 15000, value: 5, easingOut: "easeOutCubic" },
];

{
  const flipped = flipKeyframesInTime(scalar);
  const min = 1000;
  const max = 15000;
  check(
    "ticks mirror about the span midpoint and stay sorted",
    flipped.map((k) => k.tick).join(",") ===
      scalar
        .map((k) => min + max - k.tick)
        .reverse()
        .join(","),
    flipped.map((k) => k.tick).join(",")
  );
  check(
    "values ride along (first key in time becomes last)",
    flipped[0].value === 5 && flipped[flipped.length - 1].value === 0
  );
  check(
    "ticks stay integers",
    flipped.every((k) => Number.isInteger(k.tick))
  );
  check(
    "segment easings move to the segment's new start, mirrored",
    // old 1000→4000 easeInQuad becomes new 12000→15000 easeOutQuad; old
    // 13000→15000 customBezier becomes new 1000→3000 customBezier; the
    // old last key's dangling easeOutCubic lands on the new last key as
    // easeInCubic.
    flipped[flipped.length - 2].easingOut === "easeOutQuad" &&
      flipped[0].easingOut === "customBezier" &&
      flipped[flipped.length - 1].easingOut === "easeInCubic",
    flipped.map((k) => k.easingOut).join(",")
  );
  const orig = block(scalar);
  const flip = block(flipped);
  const ticks: number[] = [];
  for (let t = min; t <= max; t += 250) ticks.push(t);
  const worst = ticks.reduce((m, t) => {
    const a = evaluateKeyframesAt(orig, "scalar", min + max - t) as number;
    const b = evaluateKeyframesAt(flip, "scalar", t) as number;
    return Math.max(m, Math.abs(a - b));
  }, 0);
  check(
    "flipped scalar plays the original backwards (every easing kind)",
    worst < 1e-6,
    `max |Δ| ${worst.toExponential(2)}`
  );
  const twice = flipKeyframesInTime(flipped);
  check(
    "flipping twice restores ticks, values and easings",
    twice.every(
      (k, i) =>
        k.tick === scalar[i].tick &&
        k.value === scalar[i].value &&
        k.easingOut === scalar[i].easingOut
    )
  );
  check(
    "flipping twice restores custom handles and bezier shapes",
    twice.every((k, i) => {
      const s = scalar[i];
      const hOk =
        !s.bezierHandles ||
        (near(k.bezierHandles!.rightHandle.dx, s.bezierHandles.rightHandle.dx) &&
          near(k.bezierHandles!.rightHandle.dy, s.bezierHandles.rightHandle.dy) &&
          near(k.bezierHandles!.leftHandle.dx, s.bezierHandles.leftHandle.dx) &&
          near(k.bezierHandles!.leftHandle.dy, s.bezierHandles.leftHandle.dy));
      const bOk = !s.bezier || sameShape(k.bezier!, s.bezier);
      return hOk && bOk;
    })
  );
}

{
  // A customBezier segment with NO stored handles rides the chord-third
  // defaults, which are time-symmetric — the flip must still play back
  // exactly, and must not invent handles.
  const bare: Keyframe[] = [
    { tick: 0, value: 1, easingOut: "customBezier" },
    { tick: 2000, value: 3, easingOut: "customBezier" },
    { tick: 5000, value: -2, easingOut: "linear" },
  ];
  const flipped = flipKeyframesInTime(bare);
  const worst = [250, 700, 1000, 1900, 2500, 3300, 4100, 4750].reduce((m, t) => {
    const a = evaluateKeyframesAt(block(bare), "scalar", 5000 - t) as number;
    const b = evaluateKeyframesAt(block(flipped), "scalar", t) as number;
    return Math.max(m, Math.abs(a - b));
  }, 0);
  check(
    "default-handle customBezier flips exactly and stays handle-less",
    worst < 1e-6 && flipped.every((k) => !k.bezierHandles),
    `max |Δ| ${worst.toExponential(2)}`
  );
}

{
  // Vec lane: values are arrays and the cubicBezier remap applies to
  // every component.
  const vec: Keyframe[] = [
    { tick: 0, value: [0, 10], easingOut: "easeInSine" },
    {
      tick: 3000,
      value: [5, 0],
      easingOut: "cubicBezier",
      bezier: { x1: 0.3, y1: 0, x2: 0.4, y2: 1.2 },
    },
    { tick: 7000, value: [-1, 2], easingOut: "linear" },
  ];
  const flipped = flipKeyframesInTime(vec);
  const worst = [500, 1500, 2900, 3100, 4500, 6000, 6900].reduce((m, t) => {
    const a = evaluateKeyframesAt(block(vec), "vec2", 7000 - t) as number[];
    const b = evaluateKeyframesAt(block(flipped), "vec2", t) as number[];
    return Math.max(m, Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
  }, 0);
  check(
    "flipped vec2 plays the original backwards",
    worst < 1e-6,
    `max |Δ| ${worst.toExponential(2)}`
  );
}

{
  const hold: Keyframe[] = [
    { tick: 0, value: 1, easingOut: "hold" },
    { tick: 1000, value: 2, easingOut: "linear" },
  ];
  const flipped = flipKeyframesInTime(hold);
  check(
    "hold stays hold on the mirrored segment",
    flipped[0].easingOut === "hold" && flipped[0].value === 2
  );
  check(
    "single key and empty lane are fixed points",
    flipKeyframesInTime([]).length === 0 &&
      flipKeyframesInTime([hold[0]])[0].tick === 0
  );
}

// --- clipboard store + flipClipboardItems -----------------------------------

{
  setKeyframeClipboard([]);
  check("empty copy clears the clipboard", getKeyframeClipboard() === null);
  const items = clipboardItemsFrom([
    { nodeId: "a", paramName: "x", keyframe: { tick: 2000, value: 0, easingOut: "linear" } },
    { nodeId: "a", paramName: "x", keyframe: { tick: 3000, value: 1, easingOut: "easeInQuad" } },
    { nodeId: "b", paramName: "y", keyframe: { tick: 5000, value: 7, easingOut: "linear" } },
  ]);
  check(
    "offsets are relative to the earliest key across lanes",
    items.map((i) => i.offsetTicks).join(",") === "0,1000,3000"
  );
  setKeyframeClipboard(items);
  check("copy is readable back", getKeyframeClipboard()?.items.length === 3);

  const flipped = flipClipboardItems(items);
  const byLane = (n: string) =>
    flipped
      .filter((i) => i.nodeId === n)
      .map((i) => i.offsetTicks)
      .sort((p, q) => p - q);
  check(
    "multi-lane flip mirrors about the WHOLE span (lane b to 0, lane a to 2000/3000)",
    byLane("b").join(",") === "0" && byLane("a").join(",") === "2000,3000"
  );
  check(
    "flipped offsets still start at 0 so the anchor lands on the first key",
    Math.min(...flipped.map((i) => i.offsetTicks)) === 0
  );
  check(
    "item keyframe ticks agree with their offsets",
    flipped.every((i) => i.keyframe.tick === i.offsetTicks)
  );
  const laneA = flipped
    .filter((i) => i.nodeId === "a")
    .sort((p, q) => p.offsetTicks - q.offsetTicks);
  // Lane a was 2000 (linear) → 3000 (easeInQuad, dangling). Flipped, the
  // new first key's outgoing segment is the old linear one; the new last
  // key inherits the old dangling easing, mirrored.
  check(
    "per-lane easing reversal applies inside a multi-lane flip",
    laneA[0].keyframe.easingOut === "linear" &&
      laneA[1].keyframe.easingOut === "easeOutQuad",
    laneA.map((i) => i.keyframe.easingOut).join(",")
  );
}

// --- buildPasteUpdates ------------------------------------------------------

{
  const blocks = new Map<string, KeyframeAnimationBlock>([
    [
      "a|x",
      {
        animated: false,
        trackVisible: true,
        keyframes: [
          { tick: 0, value: 9, easingOut: "linear" },
          { tick: 6000, value: 8, easingOut: "linear" },
        ],
      },
    ],
  ]);
  const items = clipboardItemsFrom([
    { nodeId: "a", paramName: "x", keyframe: { tick: 100, value: 1, easingOut: "hold" } },
    { nodeId: "a", paramName: "x", keyframe: { tick: 1100, value: 2, easingOut: "linear" } },
    { nodeId: "gone", paramName: "z", keyframe: { tick: 100, value: 0, easingOut: "linear" } },
  ]);
  const updates = buildPasteUpdates(items, 5000, (n, p) => blocks.get(`${n}|${p}`));
  check("a lane whose block is gone is skipped", updates.length === 1);
  const u = updates[0];
  check(
    "pasted keys land at anchor + offset, colliding key replaced, sorted",
    u.block.keyframes.map((k) => `${k.tick}:${k.value}`).join(" ") ===
      "0:9 5000:1 6000:2",
    u.block.keyframes.map((k) => `${k.tick}:${k.value}`).join(" ")
  );
  check("paste marks the block animated", u.block.animated === true);
  check(
    "pastedTicks reports the placed ticks",
    u.pastedTicks.slice().sort((p, q) => p - q).join(",") === "5000,6000"
  );
  check("easing travels with the pasted key", u.block.keyframes[1].easingOut === "hold");
  const neg = buildPasteUpdates(items, -600, (n, p) => blocks.get(`${n}|${p}`));
  // Anchor −600: the offset-0 key would land at −600 (dropped), the
  // offset-1000 key lands at 400.
  check(
    "keys that would land before tick 0 are dropped",
    neg[0].block.keyframes.map((k) => k.tick).join(",") === "0,400,6000",
    neg[0].block.keyframes.map((k) => k.tick).join(",")
  );
}

console.log(failures === 0 ? "\ncheck-keyframe-clipboard: all passed" : `\n${failures} FAILED`);
if (failures > 0) process.exit(1);
