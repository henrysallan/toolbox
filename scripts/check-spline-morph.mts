// Guards Spline Morph's N-shape Amount mapping: 0 is the first shape, 1 is
// the last, and the 0..1 slider splits evenly across the gaps (2 → 0/1,
// 3 → 0 / 0.5 / 1, 4 → 0 / 1/3 / 2/3 / 1). Also checks that a 2-shape
// chain matches the original pairwise morph, and that knots are seamless.
//
// And the correspondence modes: "resample" (the default) resamples every
// pair to Resolution even when the counts already match; "anchors" pairs
// same-count subpaths 1:1 as authored — Amount 0 / 1 hand back the inputs
// exactly, handles included, and handles lerp in between — still
// orientation-aligned, falling back to resampling only for a pair whose
// counts differ, and keeping a surplus subpath's authored anchors.
//
// Run: npx tsx scripts/check-spline-morph.mts
import type { SplineAnchor, SplineValue } from "../src/engine/types.ts";
import {
  applyMorph,
  applyMorphChain,
  buildMorphChain,
  buildMorphCorrespondence,
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

// --- correspondence modes ---------------------------------------------------

// A closed 4-anchor "blob" with hand-placed handles, offset by (dx, dy) with
// a per-shape handle scale so A and B share a count but differ in position
// AND handles — the "same points, moved" morph.
function blob(dx: number, dy: number, h: number): SplineValue {
  const sq: Array<[number, number]> = [
    [0.3, 0.3],
    [0.7, 0.3],
    [0.7, 0.7],
    [0.3, 0.7],
  ];
  const anchors: SplineAnchor[] = sq.map(([x, y], i) => {
    // Tangent runs along the square's travel direction at each corner.
    const dir: [number, number] = [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ][i] as [number, number];
    return {
      pos: [x + dx, y + dy],
      inHandle: [-dir[0] * h, -dir[1] * h],
      outHandle: [dir[0] * h, dir[1] * h],
    };
  });
  return { kind: "spline", subpaths: [{ anchors, closed: true }] };
}

function same2(
  a: readonly [number, number] | undefined,
  b: readonly [number, number] | undefined,
  eps = 0
): boolean {
  const ax = a?.[0] ?? 0;
  const ay = a?.[1] ?? 0;
  const bx = b?.[0] ?? 0;
  const by = b?.[1] ?? 0;
  return Math.abs(ax - bx) <= eps && Math.abs(ay - by) <= eps;
}

// Anchor-by-anchor equality of pos + both handles (exact by default).
function sameAnchors(x: SplineAnchor[], y: SplineAnchor[], eps = 0): boolean {
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) {
    if (!same2(x[i].pos, y[i].pos, eps)) return false;
    if (!same2(x[i].inHandle, y[i].inHandle, eps)) return false;
    if (!same2(x[i].outHandle, y[i].outHandle, eps)) return false;
  }
  return true;
}

// Reverse travel direction (anchor order + in/out swap) — same geometry,
// opposite winding, the way a user might have drawn B.
function reversed(s: SplineValue): SplineValue {
  return {
    kind: "spline",
    subpaths: s.subpaths.map((sub) => ({
      closed: sub.closed,
      anchors: sub.anchors
        .slice()
        .reverse()
        .map((a) => ({ pos: a.pos, inHandle: a.outHandle, outHandle: a.inHandle })),
    })),
  };
}

const A = blob(0, 0, 0.05);
const B = blob(0.1, 0.05, 0.12);

{
  // Default mode is unchanged: equal counts still resample to Resolution.
  const corr = buildMorphCorrespondence(A, B, RES);
  check(
    "resample (default) mode resamples an equal-count pair to Resolution",
    applyMorph(corr, 0).subpaths[0].anchors.length === RES &&
      applyMorph(corr, 0).subpaths[0].anchors.length !== A.subpaths[0].anchors.length
  );
  const legacy = buildMorphCorrespondence(A, B, RES, "resample");
  check(
    "explicit \"resample\" matches the default",
    sameAnchors(applyMorph(legacy, 0.3).subpaths[0].anchors, applyMorph(corr, 0.3).subpaths[0].anchors)
  );
}

{
  const corr = buildMorphCorrespondence(A, B, RES, "anchors");
  const at0 = applyMorph(corr, 0).subpaths[0].anchors;
  const at1 = applyMorph(corr, 1).subpaths[0].anchors;
  const atHalf = applyMorph(corr, 0.5).subpaths[0].anchors;
  check(
    "anchors mode keeps the authored anchor count",
    at0.length === 4 && at1.length === 4 && atHalf.length === 4
  );
  check(
    "anchors mode: Amount 0 is A exactly (positions + handles)",
    sameAnchors(at0, A.subpaths[0].anchors)
  );
  check(
    "anchors mode: Amount 1 is B exactly (positions + handles)",
    sameAnchors(at1, B.subpaths[0].anchors)
  );
  const mid: SplineAnchor[] = A.subpaths[0].anchors.map((a, i) => {
    const b = B.subpaths[0].anchors[i];
    return {
      pos: [(a.pos[0] + b.pos[0]) / 2, (a.pos[1] + b.pos[1]) / 2],
      inHandle: [(a.inHandle![0] + b.inHandle![0]) / 2, (a.inHandle![1] + b.inHandle![1]) / 2],
      outHandle: [(a.outHandle![0] + b.outHandle![0]) / 2, (a.outHandle![1] + b.outHandle![1]) / 2],
    };
  });
  check(
    "anchors mode: Amount 0.5 lerps positions AND handles per anchor",
    sameAnchors(atHalf, mid, 1e-12)
  );
  check(
    "anchors mode: closed flag survives",
    applyMorph(corr, 0.5).subpaths[0].closed === true
  );
  check(
    "splineMorph one-shot honors the mode",
    sameAnchors(splineMorph(A, B, 1, RES, "anchors").subpaths[0].anchors, B.subpaths[0].anchors)
  );
}

{
  // Alignment still runs: B drawn in the opposite direction pairs each
  // anchor with its nearest counterpart instead of twisting the shape.
  const corr = buildMorphCorrespondence(A, reversed(B), RES, "anchors");
  const atHalf = applyMorph(corr, 0.5).subpaths[0].anchors;
  const expected = A.subpaths[0].anchors.map((a, i) => {
    const b = B.subpaths[0].anchors[i];
    return [(a.pos[0] + b.pos[0]) / 2, (a.pos[1] + b.pos[1]) / 2] as [number, number];
  });
  const key = (p: readonly [number, number]) => `${p[0].toFixed(9)},${p[1].toFixed(9)}`;
  const got = atHalf.map((a) => key(a.pos)).sort();
  const want = expected.map(key).sort();
  check(
    "anchors mode still aligns orientation (reversed B → nearest-anchor pairing)",
    atHalf.length === 4 && got.every((k, i) => k === want[i]),
    `got ${got.join(" | ")} want ${want.join(" | ")}`
  );
  check(
    "anchors mode: reversed B at Amount 1 has B's geometry (positions)",
    applyMorph(corr, 1)
      .subpaths[0].anchors.map((a) => key(a.pos))
      .sort()
      .every((k, i) => k === B.subpaths[0].anchors.map((a) => key(a.pos)).sort()[i])
  );
}

{
  // A count mismatch degrades to the resample look for that pair only.
  const five: SplineValue = {
    kind: "spline",
    subpaths: [
      {
        closed: true,
        anchors: [
          { pos: [0.3, 0.3] },
          { pos: [0.5, 0.25] },
          { pos: [0.7, 0.3] },
          { pos: [0.7, 0.7] },
          { pos: [0.3, 0.7] },
        ],
      },
    ],
  };
  const corr = buildMorphCorrespondence(A, five, RES, "anchors");
  check(
    "anchors mode falls back to Resolution resampling on a count mismatch",
    applyMorph(corr, 0).subpaths[0].anchors.length === RES
  );
}

{
  // Surplus subpath (A has two, B one): the unmatched one collapses to its
  // centroid while keeping its authored anchors — no resample.
  const tri = {
    closed: true,
    anchors: [
      { pos: [0.1, 0.1] },
      { pos: [0.2, 0.1] },
      { pos: [0.15, 0.2] },
    ] as SplineAnchor[],
  };
  const twoSubs: SplineValue = {
    kind: "spline",
    subpaths: [A.subpaths[0], tri],
  };
  const corr = buildMorphCorrespondence(twoSubs, B, RES, "anchors");
  check("anchors mode pairs every subpath", corr.length === 2);
  const surplus = corr.find((p) => p.aAnchors.length === 3);
  check(
    "anchors mode: surplus subpath keeps its 3 authored anchors",
    !!surplus && surplus.aAnchors.length === 3 && surplus.bAnchors.length === 3
  );
  const c = surplus?.bAnchors[0].pos;
  check(
    "anchors mode: surplus subpath collapses to its centroid",
    !!surplus &&
      surplus.bAnchors.every((a) => same2(a.pos, c, 0)) &&
      same2(c, [0.15, 0.4 / 3], 1e-12)
  );
}

{
  // Chain in anchors mode: the knot is the shared shape exactly and the
  // authored count survives every segment.
  const C = blob(-0.05, 0.1, 0.02);
  const corrs = buildMorphChain([A, B, C], RES, "anchors");
  check("anchors mode chain has 2 segments", corrs.length === 2);
  check(
    "anchors mode chain keeps 4 anchors across the whole sweep",
    [0, 0.25, 0.5, 0.75, 1].every(
      (t) => applyMorphChain(corrs, t).subpaths[0].anchors.length === 4
    )
  );
  check(
    "anchors mode chain: knot from the left is B exactly",
    sameAnchors(applyMorph(corrs[0], 1).subpaths[0].anchors, B.subpaths[0].anchors)
  );
  check(
    "anchors mode chain: knot from the right equals knot from the left",
    sameAnchors(
      applyMorph(corrs[1], 0).subpaths[0].anchors,
      applyMorph(corrs[0], 1).subpaths[0].anchors
    )
  );
  check(
    "anchors mode chain: Amount 1 is the last shape exactly",
    sameAnchors(applyMorphChain(corrs, 1).subpaths[0].anchors, C.subpaths[0].anchors)
  );
}

if (failures > 0) {
  console.error(`\ncheck-spline-morph: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncheck-spline-morph: all green");
