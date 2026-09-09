// Guards Points on Path's per-subpath count allocation: Equal keeps
// Count on every positive-length subpath; By length scales Count so
// the longest gets that many and shorter ones get proportionally fewer.
// Also: named spline channels interpolate onto the emitted points.
//
//   npx tsx scripts/check-points-on-path.mts

import type { SplineValue } from "../src/engine/types.ts";
import {
  perSubpathCounts,
  samplePathPoints,
} from "../src/nodes/effect/points-on-path.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function same(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

{
  check("empty", same(perSubpathCounts([], 24, false, 4096), []));
  check(
    "equal: Count on each positive-length subpath",
    same(perSubpathCounts([1, 2, 3], 10, false, 4096), [10, 10, 10])
  );
  check(
    "equal: zero-length subpaths emit nothing",
    same(perSubpathCounts([1, 0, 1], 8, false, 4096), [8, 0, 8])
  );
  check(
    "equal: pre-caps by nSubs so total stays ≤ maxPoints",
    same(perSubpathCounts([1, 1, 1, 1], 100, false, 10), [2, 2, 2, 2])
  );
}

{
  check(
    "by length: equal lengths match Equal",
    same(perSubpathCounts([5, 5, 5], 12, true, 4096), [12, 12, 12])
  );
  check(
    "by length: 2:1 ratio halves the shorter",
    same(perSubpathCounts([2, 1], 10, true, 4096), [10, 5])
  );
  check(
    "by length: longest gets Count, others scale",
    same(perSubpathCounts([4, 2, 1], 8, true, 4096), [8, 4, 2])
  );
  check(
    "by length: tiny subpath still gets at least 1",
    same(perSubpathCounts([100, 1], 10, true, 4096), [10, 1])
  );
  check(
    "by length: all-zero lengths emit nothing",
    same(perSubpathCounts([0, 0], 24, true, 4096), [0, 0])
  );
  check(
    "by length: zero-length stays 0 while siblings scale",
    same(perSubpathCounts([2, 0, 1], 10, true, 4096), [10, 0, 5])
  );
  const scaled = perSubpathCounts([10, 5, 5], 2000, true, 100);
  const total = scaled.reduce((a, b) => a + b, 0);
  check(
    "by length: scales down when the total would exceed maxPoints",
    total <= 100 && scaled[0] >= scaled[1] && scaled[1] === scaled[2],
    `got ${scaled.join(",")} (total ${total})`
  );
}

{
  const line: SplineValue = {
    kind: "spline",
    subpaths: [
      {
        closed: false,
        attrs: { tag: 7 },
        anchors: [
          { pos: [0, 0.5], attrs: { weight: 0, tint: [1, 0, 0] } },
          { pos: [1, 0.5], attrs: { weight: 1, tint: [0, 0, 1] } },
        ],
      },
    ],
  };
  const sampled = samplePathPoints(line, {
    count: 3,
    domain: "combined",
    countMode: "equal",
    animate: false,
    offset: 0,
    align: "off",
    alignOffsetDeg: 0,
  });
  const w = sampled.attrRows.map((r) => r?.weight as number);
  const midTint = sampled.attrRows[1]?.tint as number[];
  check(
    "combined: interpolates anchor attrs; copies subpath attrs",
    sampled.positions.length === 3 &&
      Math.abs(w[0] - 0) < 1e-6 &&
      Math.abs(w[1] - 0.5) < 1e-5 &&
      Math.abs(w[2] - 1) < 1e-6 &&
      sampled.attrRows[0]?.tag === 7 &&
      sampled.attrRows[2]?.tag === 7 &&
      Math.abs(midTint[0] - 0.5) < 1e-5 &&
      Math.abs(midTint[2] - 0.5) < 1e-5
  );
}

{
  const two: SplineValue = {
    kind: "spline",
    subpaths: [
      {
        closed: false,
        groupIndex: 0,
        attrs: { tag: 1 },
        anchors: [
          { pos: [0, 0], attrs: { weight: 0 } },
          { pos: [0.4, 0], attrs: { weight: 1 } },
        ],
      },
      {
        closed: false,
        groupIndex: 1,
        attrs: { tag: 2 },
        anchors: [
          { pos: [0, 0.5], attrs: { weight: 10 } },
          { pos: [0.4, 0.5], attrs: { weight: 10 } },
        ],
      },
    ],
  };
  const sampled = samplePathPoints(two, {
    count: 2,
    domain: "per subpath",
    countMode: "equal",
    animate: false,
    offset: 0,
    align: "off",
    alignOffsetDeg: 0,
  });
  check(
    "per subpath: each sample inherits that subpath's attrs",
    sampled.positions.length === 4 &&
      sampled.groups[0] === 0 &&
      sampled.groups[2] === 1 &&
      sampled.attrRows[0]?.tag === 1 &&
      sampled.attrRows[2]?.tag === 2 &&
      (sampled.attrRows[2]?.weight as number) === 10
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall passed");
