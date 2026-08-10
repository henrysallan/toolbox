// Deterministic bench for the CPU spline chain: blend-intersections ->
// spline-offset. Both are pure functions of their input, so this reproduces
// exactly across runs and across code changes.
//
// WHY THIS EXISTS RATHER THAN JUST PROFILING THE APP: the benchmark graph
// these nodes were found in drives them from Advect Points in `accumulate`
// mode, whose geometry evolves every frame AND resets whenever HMR reloads a
// module. So every before/after comparison taken from the live editor is
// confounded — the subpath count moves between runs, and subpath count is
// what these nodes cost scales on. Two of my own "measurements" showed a node
// I had not touched moving 20%. Fixed input is the only way to attribute a
// change to the change.
//
// The `perf-profiler` trace is still the right tool for finding WHICH node is
// hot in a real graph; this is the right tool for deciding whether an edit
// made that node faster.
//
// Run: npx tsx scripts/bench-spline-chain.mts [--json]
import { blendIntersections } from "../src/engine/spline-blend-intersections.ts";
import { offsetSubpath } from "../src/engine/spline-math.ts";
import type { SplineSubpath, SplineValue } from "../src/engine/types.ts";

const CANVAS = 1024;

// Mirrors the shape the real graph feeds these nodes: Advect Points ->
// Points to Spline (curve: linear) produces ONE open polyline subpath of ~100
// anchors that wanders and crosses itself many times. Cost for both nodes is
// driven by self-crossings, not anchor count, so a smooth non-crossing curve
// would under-report both by an order of magnitude.
function makeAdvectedPolyline(anchorCount: number, seedPhase: number): SplineValue {
  const anchors: SplineSubpath["anchors"] = [];
  for (let i = 0; i < anchorCount; i++) {
    const t = (i / anchorCount) * Math.PI * 2;
    // Coprime frequencies -> a dense self-crossing Lissajous wander.
    const x = 0.5 + 0.34 * Math.sin(3 * t + seedPhase) + 0.06 * Math.sin(11 * t);
    const y = 0.5 + 0.34 * Math.sin(5 * t) + 0.06 * Math.cos(7 * t + seedPhase);
    anchors.push({ pos: [x, y] });     // no handles: Points to Spline "linear"
  }
  return { kind: "spline", subpaths: [{ anchors, closed: false }] };
}

function countAnchors(s: SplineValue): number {
  let n = 0;
  for (const sub of s.subpaths) n += sub.anchors.length;
  return n;
}

// MIN across reps, not mean. These are single-threaded pure functions, so the
// fastest observed run is the one least polluted by GC and scheduler noise —
// the mean drifts ~10% run to run, which is the same size as some of the wins
// being measured, and that made two real improvements look like noise.
function time(reps: number, fn: () => void): number {
  fn(); // warm
  let best = Infinity;
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    fn();
    const dt = performance.now() - t0;
    if (dt < best) best = dt;
  }
  return best;
}

// Params taken from the real benchmark graph so the numbers are comparable to
// what the profiler reports there.
const BLEND_OPTS = { widthPx: 6, blendPx: 24, resolution: 288, smoothing: 0.5 };
const OFFSET_DISTANCE = -0.013;

const asJson = process.argv.includes("--json");
const rows: Record<string, unknown>[] = [];

for (const anchorCount of [50, 100, 200]) {
  const input = makeAdvectedPolyline(anchorCount, 0.7);

  let blended: SplineValue = { kind: "spline", subpaths: [] };
  const blendMs = time(7, () => {
    blended = blendIntersections(input, CANVAS, CANVAS, BLEND_OPTS);
  });

  const offsetMs = time(7, () => {
    for (const sub of blended.subpaths) offsetSubpath(sub, OFFSET_DISTANCE);
  });
  let offsetAnchors = 0;
  for (const sub of blended.subpaths) {
    const o = offsetSubpath(sub, OFFSET_DISTANCE);
    if (o) offsetAnchors += o.anchors.length;
  }

  const row = {
    inputAnchors: anchorCount,
    blendMs: +blendMs.toFixed(2),
    blendSubpaths: blended.subpaths.length,
    blendAnchors: countAnchors(blended),
    offsetMs: +offsetMs.toFixed(2),
    offsetAnchors,
    offsetUsPerSegment: +((offsetMs * 1000) / Math.max(1, countAnchors(blended))).toFixed(1),
  };
  rows.push(row);

  if (!asJson) {
    console.log(
      `in ${String(anchorCount).padStart(3)} anchors  ->  ` +
      `blend ${String(row.blendMs).padStart(7)}ms ` +
      `(${String(row.blendSubpaths).padStart(3)} subpaths, ${String(row.blendAnchors).padStart(4)} anchors)  ->  ` +
      `offset ${String(row.offsetMs).padStart(6)}ms ` +
      `(${String(row.offsetAnchors).padStart(5)} anchors, ${row.offsetUsPerSegment}µs/seg)`
    );
  }
}

if (asJson) console.log(JSON.stringify(rows, null, 2));
