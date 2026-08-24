// Guards Spline Morph's N-shape Amount mapping: 0 is the first shape, 1 is
// the last, and the 0..1 slider splits evenly across the gaps (2 → 0/1,
// 3 → 0 / 0.5 / 1, 4 → 0 / 1/3 / 2/3 / 1). Also checks that a 2-shape
// chain matches the original pairwise morph, and that knots are seamless.
//
// Run: npx tsx scripts/check-spline-morph.mts
import type { SplineValue } from "../src/engine/types.ts";
import {
  applyMorph,
  applyMorphChain,
  buildMorphChain,
  splineMorph,
} from "../src/engine/spline-morph.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    failures++;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function line(y: number): SplineValue {
  return {
    kind: "spline",
    subpaths: [
      {
        anchors: [{ pos: [0.2, y] }, { pos: [0.8, y] }],
        closed: false,
      },
    ],
  };
}

function meanY(s: SplineValue): number {
  let sy = 0;
  let n = 0;
  for (const sub of s.subpaths) {
    for (const a of sub.anchors) {
      sy += a.pos[1];
      n++;
    }
  }
  return n === 0 ? NaN : sy / n;
}

function close(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

const RES = 16;
const a = line(0);
const b = line(0.5);
const c = line(1);
const d = line(0.25);

{
  const pair = splineMorph(a, b, 0.4, RES);
  const chain = applyMorphChain(buildMorphChain([a, b], RES), 0.4);
  check(
    "2-shape chain matches pairwise morph",
    close(meanY(pair), meanY(chain)) && close(meanY(pair), 0.2)
  );
}

{
  const corrs = buildMorphChain([a, b, c], RES);
  check("3-shape chain has 2 segments", corrs.length === 2);
  check("3-shape amount 0 is first", close(meanY(applyMorphChain(corrs, 0)), 0));
  check(
    "3-shape amount 0.5 is middle",
    close(meanY(applyMorphChain(corrs, 0.5)), 0.5)
  );
  check("3-shape amount 1 is last", close(meanY(applyMorphChain(corrs, 1)), 1));
  check(
    "3-shape amount 0.25 is halfway A→B",
    close(meanY(applyMorphChain(corrs, 0.25)), 0.25)
  );
  const atKnotFromLeft = applyMorph(corrs[0], 1);
  const atKnotFromRight = applyMorph(corrs[1], 0);
  check(
    "3-shape midpoint is seamless across segments",
    close(meanY(atKnotFromLeft), meanY(atKnotFromRight))
  );
}

{
  const corrs = buildMorphChain([a, b, c, d], RES);
  check("4-shape chain has 3 segments", corrs.length === 3);
  check(
    "4-shape amount 1/3 is second",
    close(meanY(applyMorphChain(corrs, 1 / 3)), 0.5)
  );
  check(
    "4-shape amount 2/3 is third",
    close(meanY(applyMorphChain(corrs, 2 / 3)), 1)
  );
  check("4-shape amount 1 is last", close(meanY(applyMorphChain(corrs, 1)), 0.25));
}

{
  check(
    "empty chain yields empty spline",
    applyMorphChain([], 0.5).subpaths.length === 0
  );
}

if (failures > 0) {
  console.error(`\ncheck-spline-morph: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncheck-spline-morph: all green");
