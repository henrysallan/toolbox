// Guards per-anchor "Insert key": which ids can take a key at a tick, and
// that insert pins the evaluated pose (not the rest pose) onto existing
// tracks. Path Animation and un-animated anchors stay no-ops.
//
//   npx tsx scripts/check-spline-anchor-keys.mts

import {
  anchorInKey,
  anchorOutKey,
  anchorPosKey,
  insertAnchorKeysAtTick,
  insertableAnchorIdsAtTick,
} from "../src/engine/conventions.ts";
import type { AnimationMap } from "../src/engine/keyframes.ts";
import type { SplineSubpath } from "../src/engine/types.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function close2(a: unknown, b: [number, number], eps = 1e-6): boolean {
  if (!Array.isArray(a) || a.length < 2) return false;
  return Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
}

function vecTrack(
  keys: Array<{ tick: number; value: [number, number] }>
): AnimationMap[string] {
  return {
    animated: true,
    trackVisible: true,
    keyframes: keys.map((k) => ({
      tick: k.tick,
      value: k.value,
      easingOut: "linear" as const,
    })),
  };
}

const spline = {
  subpaths: [
    {
      closed: false,
      anchors: [
        { id: "a", pos: [0.1, 0.2] as [number, number] },
        { id: "b", pos: [0.8, 0.9] as [number, number] },
      ],
    } satisfies SplineSubpath,
  ],
};

const seeded: AnimationMap = {
  [anchorPosKey("a")]: vecTrack([
    { tick: 0, value: [0, 0] },
    { tick: 100, value: [1, 1] },
  ]),
  [anchorInKey("a")]: vecTrack([{ tick: 0, value: [0, 0] }]),
  [anchorOutKey("a")]: vecTrack([{ tick: 0, value: [0, 0] }]),
};

{
  const at0 = insertableAnchorIdsAtTick(seeded, 0);
  check("seed tick is already keyed — not insertable", !at0.has("a"));
  const at50 = insertableAnchorIdsAtTick(seeded, 50);
  check("mid-segment tick is insertable", at50.has("a"));
  check("un-animated neighbor is not insertable", !at50.has("b"));
}

{
  const withPath: AnimationMap = {
    ...seeded,
    spline: {
      animated: true,
      trackVisible: true,
      keyframes: [{ tick: 0, value: spline, easingOut: "linear" }],
    },
  };
  check(
    "Path Animation hides insertable ids",
    insertableAnchorIdsAtTick(withPath, 50).size === 0
  );
  check(
    "Path Animation insert is a no-op",
    insertAnchorKeysAtTick(withPath, spline, 0, [0], 50) === null
  );
}

{
  const next = insertAnchorKeysAtTick(seeded, spline, 0, [0, 1], 50);
  check("insert returns a new map", !!next && next !== seeded);
  const pos = next?.[anchorPosKey("a")]?.keyframes.find((k) => k.tick === 50);
  check(
    "pos key pins interpolated pose, not rest pose",
    close2(pos?.value, [0.5, 0.5]),
    `got ${JSON.stringify(pos?.value)}`
  );
  const inn = next?.[anchorInKey("a")]?.keyframes.find((k) => k.tick === 50);
  const out = next?.[anchorOutKey("a")]?.keyframes.find((k) => k.tick === 50);
  check("in-handle also keyed at playhead", close2(inn?.value, [0, 0]));
  check("out-handle also keyed at playhead", close2(out?.value, [0, 0]));
  check(
    "un-animated neighbor is skipped",
    next?.[anchorPosKey("b")] === undefined
  );
}

{
  check(
    "insert on un-animated indexes is a no-op",
    insertAnchorKeysAtTick(seeded, spline, 0, [1], 50) === null
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll spline-anchor insert-key checks passed.");
