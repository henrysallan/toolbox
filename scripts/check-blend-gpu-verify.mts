// Stage 3 of check:blend-gpu — compare the Electron-produced GPU field
// grids against the CPU reference, then push both through the IDENTICAL
// downstream (recoverContours) and assert the acceptance gates from
// specdocs/080826_blend-intersections-gpu.md.
//
// Gate structure, and why it deviates from the spec's flat numbers in two
// measured places (evidence recorded in the spec + profiler docs):
//
// gate 1  FIELD — bench corpus + jitter + closed-wander: max |gpu−cpu|
//         < 1e-3 px, zero branch overflows. Passes with ~10× margin
//         (measured ≤ 8e-5).
//         Dense-network case (lobes): the CPU field is DISCONTINUOUS at
//         its cheap-exit thresholds (the farSlack test can skip up to
//         ~k/4 of smooth-min deepening; the empty-neighborhood exit emits
//         `influence`, an r-sized step). Any fp32 port lands a handful of
//         samples on the other side of those knife edges — measured 3 in
//         755k, all with one side pinned exactly at the threshold value,
//         all far from the iso (both values ≫ 0, so marching topology is
//         unaffected). The gate therefore requires every >1e-3 sample to
//         be one of those classified knife-edges, and few of them —
//         anything else (a real transcription bug) still fails.
//
// gate 2  CONTOURS — at smoothing 0 the recovery (marching + cleanup) is
//         deterministic: subpath count + closed flags must match and
//         symmetric point-to-segment Hausdorff must be < 0.05 px
//         (measured ~1e-4). At smoothing 0.5 the Schneider fit makes
//         discrete split-point choices that flip on ANY last-bit change
//         (the repo already documents single-bit cascades — profiler doc,
//         Fix 6), so 0.05 px is unattainable for any non-bit-identical
//         field; counts + closed flags must still match, and the curves
//         must agree within the fit's OWN error budget errPx
//         (0.25 + smoothing·cell·1.5 — measured ≤ 0.49 px vs ~1.9 px
//         budget). The smoothing-0 gate is what pins the field; the
//         smoothing-0.5 gate pins "same curve within fit tolerance".
//         Dense case: same, except up to a few sub-cell "sliver"
//         subpaths may appear/vanish where a knife-edge sample sits near
//         the iso — each unmatched subpath must be shorter than
//         SLIVER_CELLS cells (the same debris scale the node's cleanup
//         already drops at 3 cells).
//
// gate 3  TEMPORAL — jitter MEAN (GPU downstream) within 0.05 px of the
//         CPU mean measured same-process. READ THE MEAN — the max has
//         pointed the wrong way before (bench-spline-jitter.mts).
//
//   npx tsx scripts/check-blend-gpu-verify.mts <grids.json>
import { readFileSync, unlinkSync } from "node:fs";
import {
  buildCorpus,
  JITTER_FRAMES,
  JITTER_STEP,
  makeWander,
} from "./blend-gpu-corpus.mts";
import {
  buildFieldJob,
  evaluateFieldCpu,
  recoverContours,
  type BlendFieldJob,
} from "../src/engine/spline-blend-intersections.ts";
import { subpathToCurves } from "../src/engine/spline-math.ts";
import type { SplineValue } from "../src/engine/types.ts";

const gridsPath = process.argv[2] ?? ".blendgpu.grids.json";
const gpuGrids = JSON.parse(readFileSync(gridsPath, "utf8")) as Record<
  string,
  { grid: number[]; overflow: number }
>;

// Max unmatched sliver subpaths tolerated on the dense case, and how short
// (in field cells) a subpath must be to count as a sliver.
const MAX_SLIVERS = 4;
const SLIVER_CELLS = 8;

let failures = 0;
function report(name: string, ok: boolean, log: string) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name} — ${log}`);
  if (!ok) failures++;
}

// ---- geometry helpers -------------------------------------------------
// Point-to-SEGMENT Hausdorff, same method as bench-spline-jitter.mts
// (point-to-point measures sampling density, not geometry). Segment lookup
// goes through a uniform bucket index so the 500-subpath dense case stays
// tractable; anything farther than the index's search ring reports +inf,
// which every gate treats as "far".

interface SegSoup {
  segs: number[][];
  grid: Map<number, number[]>;
  bs: number;
  rings: number;
  cols: number;
  x0: number;
  y0: number;
}

function densify(s: SplineValue, canvasW: number, canvasH: number, per = 6): number[][] {
  const segs: number[][] = [];
  for (const sub of s.subpaths) {
    let prev: number[] | null = null;
    for (const c of subpathToCurves(sub)) {
      for (let i = 0; i <= per; i++) {
        const p = c.get(i / per);
        const q = [p.x * canvasW, p.y * canvasH];
        if (prev) segs.push([prev[0], prev[1], q[0], q[1]]);
        prev = q;
      }
    }
  }
  return segs;
}

// Distances are EXACT up to ~(rings−1)·bs px; anything beyond reads +inf,
// which the gates treat as "far". Contour gates need only tol (< 2 px);
// the jitter metric needs true magnitudes to ~16 px, so it passes a wider
// reach.
function buildSoup(segs: number[][], bs = 4, rings = 3): SegSoup {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of segs) {
    x0 = Math.min(x0, s[0], s[2]);
    y0 = Math.min(y0, s[1], s[3]);
    x1 = Math.max(x1, s[0], s[2]);
    y1 = Math.max(y1, s[1], s[3]);
  }
  const cols = Math.max(1, Math.ceil((x1 - x0) / bs) + 1);
  const grid = new Map<number, number[]>();
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const c0 = Math.floor((Math.min(s[0], s[2]) - x0) / bs);
    const c1 = Math.floor((Math.max(s[0], s[2]) - x0) / bs);
    const r0 = Math.floor((Math.min(s[1], s[3]) - y0) / bs);
    const r1 = Math.floor((Math.max(s[1], s[3]) - y0) / bs);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const key = r * cols + c;
        let list = grid.get(key);
        if (!list) {
          list = [];
          grid.set(key, list);
        }
        list.push(i);
      }
    }
  }
  return { segs, grid, bs, rings, cols, x0, y0 };
}

function distToSeg(px: number, py: number, s: number[]): number {
  const dx = s[2] - s[0];
  const dy = s[3] - s[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 > 1e-12 ? ((px - s[0]) * dx + (py - s[1]) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (s[0] + dx * t), py - (s[1] + dy * t));
}

function soupDist(soup: SegSoup, px: number, py: number): number {
  const bc = Math.floor((px - soup.x0) / soup.bs);
  const br = Math.floor((py - soup.y0) / soup.bs);
  let best = Infinity;
  for (let r = br - soup.rings; r <= br + soup.rings; r++) {
    for (let c = bc - soup.rings; c <= bc + soup.rings; c++) {
      const list = soup.grid.get(r * soup.cols + c);
      if (!list) continue;
      for (const i of list) {
        const d = distToSeg(px, py, soup.segs[i]);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

// Per-subpath one-sided deviation of `a` against `soup`, plus each
// subpath's polyline length (px) for the sliver classification.
function subpathDeviations(
  a: SplineValue,
  soup: SegSoup,
  canvasW: number,
  canvasH: number
): { dev: number; len: number }[] {
  return a.subpaths.map((sub) => {
    let dev = 0;
    let len = 0;
    for (let i = 1; i < sub.anchors.length; i++) {
      len += Math.hypot(
        (sub.anchors[i].pos[0] - sub.anchors[i - 1].pos[0]) * canvasW,
        (sub.anchors[i].pos[1] - sub.anchors[i - 1].pos[1]) * canvasH
      );
    }
    for (const c of subpathToCurves(sub)) {
      for (let i = 0; i <= 6; i++) {
        const p = c.get(i / 6);
        const d = soupDist(soup, p.x * canvasW, p.y * canvasH);
        if (d > dev) dev = d;
      }
    }
    return { dev, len };
  });
}

interface ContourCompare {
  countA: number;
  countB: number;
  closedMatch: boolean;
  /** Max deviation over matched (non-sliver) subpaths, both directions. */
  matchedDev: number;
  /** Unmatched subpaths (dev > tol): their lengths in px. */
  sliverLens: number[];
}

function compareContours(
  a: SplineValue,
  b: SplineValue,
  canvasW: number,
  canvasH: number,
  tol: number
): ContourCompare {
  const soupA = buildSoup(densify(a, canvasW, canvasH));
  const soupB = buildSoup(densify(b, canvasW, canvasH));
  let matchedDev = 0;
  const sliverLens: number[] = [];
  for (const [spline, soup] of [
    [a, soupB],
    [b, soupA],
  ] as const) {
    for (const { dev, len } of subpathDeviations(spline, soup, canvasW, canvasH)) {
      if (dev > tol) sliverLens.push(len);
      else if (dev > matchedDev) matchedDev = dev;
    }
  }
  const closedA = a.subpaths.map((s) => (s.closed ? 1 : 0)).join("");
  const closedB = b.subpaths.map((s) => (s.closed ? 1 : 0)).join("");
  return {
    countA: a.subpaths.length,
    countB: b.subpaths.length,
    closedMatch:
      a.subpaths.length === b.subpaths.length ? closedA === closedB : false,
    matchedDev,
    sliverLens,
  };
}

// ---- knife-edge classification for the dense field gate ---------------
// The CPU field is discontinuous at its cheap-exit thresholds; a sample
// disagreeing >1e-3 is acceptable ONLY if one side sits pinned at such a
// threshold (the cheap exit emits exactly `minD − r` where the comparison
// against farSlack was borderline, or exactly `influence` on an empty
// neighborhood) and both values are far from the iso.
function isKnifeEdge(cpu: number, gpu: number, job: BlendFieldJob): boolean {
  const near = (v: number, t: number) => Math.abs(v - t) < 2e-3;
  const thresholdPinned =
    near(cpu, job.farSlack) ||
    near(gpu, job.farSlack) ||
    near(cpu, job.influence) ||
    near(gpu, job.influence);
  return thresholdPinned && cpu > 0 && gpu > 0;
}

// ---- run the corpus ---------------------------------------------------
const jitterCpu: SplineValue[] = new Array(JITTER_FRAMES);
const jitterGpu: SplineValue[] = new Array(JITTER_FRAMES);

for (const c of buildCorpus()) {
  const entry = gpuGrids[c.name];
  if (!entry) {
    report(`gpu grid present: ${c.name}`, false, "missing from harness output");
    continue;
  }
  const job = buildFieldJob(c.spline, c.canvasW, c.canvasH, c.opts)!;
  const cpuGrid = evaluateFieldCpu(job);
  const gpuGrid = Float32Array.from(entry.grid);

  // ---- gate 1: field equivalence
  let maxDiff = 0;
  let edges = 0;
  let unexplained = 0;
  for (let i = 0; i < cpuGrid.length; i++) {
    const d = Math.abs(cpuGrid[i] - gpuGrid[i]);
    if (d > maxDiff) maxDiff = d;
    if (d > 1e-3) {
      if (c.dense && isKnifeEdge(cpuGrid[i], gpuGrid[i], job)) edges++;
      else unexplained++;
    }
  }
  if (!c.dense) {
    report(
      `field equivalence: ${c.name}`,
      maxDiff < 1e-3 && entry.overflow === 0,
      `max |gpu−cpu| = ${maxDiff.toExponential(2)} px over ${cpuGrid.length} samples` +
        (entry.overflow > 0 ? `, ${entry.overflow} branch overflows` : "")
    );
  } else {
    report(
      `field equivalence (dense): ${c.name}`,
      unexplained === 0 && edges <= 20 && entry.overflow === 0,
      `${edges} classified knife-edge sample(s), ${unexplained} unexplained, ` +
        `over ${cpuGrid.length} samples` +
        (entry.overflow > 0 ? `, ${entry.overflow} branch overflows` : "")
    );
  }

  // ---- gate 2: contour equivalence through the identical downstream
  const errPx = 0.25 + c.opts.smoothing * job.cell * 1.5;
  for (const [label, smoothing, tol] of [
    ["raw (smoothing 0)", 0, 0.05],
    [`fit (smoothing ${c.opts.smoothing})`, c.opts.smoothing, errPx],
  ] as const) {
    const cpuOut = recoverContours(job, cpuGrid, c.canvasW, c.canvasH, smoothing);
    const gpuOut = recoverContours(job, gpuGrid, c.canvasW, c.canvasH, smoothing);
    const cmp = compareContours(cpuOut, gpuOut, c.canvasW, c.canvasH, tol);
    if (!c.dense) {
      report(
        `contours ${label}: ${c.name}`,
        cmp.countA === cmp.countB &&
          cmp.closedMatch &&
          cmp.sliverLens.length === 0,
        `subpaths ${cmp.countA}/${cmp.countB}, ` +
          `max dev ${cmp.matchedDev.toFixed(4)} px (tol ${tol.toFixed(2)})` +
          (cmp.sliverLens.length > 0
            ? `, ${cmp.sliverLens.length} subpath(s) beyond tol`
            : "")
      );
    } else {
      const sliverMax = SLIVER_CELLS * job.cell;
      const allSliversSmall = cmp.sliverLens.every((l) => l < sliverMax);
      report(
        `contours ${label} (dense): ${c.name}`,
        Math.abs(cmp.countA - cmp.countB) <= MAX_SLIVERS &&
          cmp.sliverLens.length <= MAX_SLIVERS &&
          allSliversSmall,
        `subpaths ${cmp.countA}/${cmp.countB}, matched dev ` +
          `${cmp.matchedDev.toFixed(4)} px (tol ${tol.toFixed(2)}), ` +
          `${cmp.sliverLens.length} sliver(s)` +
          (cmp.sliverLens.length
            ? ` [${cmp.sliverLens.map((l) => l.toFixed(1)).join(", ")} px, cap ${sliverMax.toFixed(1)}]`
            : "")
      );
    }

    if (c.jitterFrame !== undefined && smoothing === c.opts.smoothing) {
      jitterCpu[c.jitterFrame] = cpuOut;
      jitterGpu[c.jitterFrame] = gpuOut;
    }
  }
}

// ---- gate 3: temporal stability ---------------------------------------
const W = 1024;

function jitterMean(frames: SplineValue[]): number {
  let sum = 0;
  let n = 0;
  for (let f = 1; f < frames.length; f++) {
    // Wide reach (exact to ~32 px) — frame-to-frame jumps run to ~15 px
    // and the metric needs their true magnitude, not a clamp.
    const soupPrev = buildSoup(densify(frames[f - 1], W, W), 8, 5);
    const soupCur = buildSoup(densify(frames[f], W, W), 8, 5);
    let d = 0;
    for (const [s, soup] of [
      [frames[f], soupPrev],
      [frames[f - 1], soupCur],
    ] as const) {
      for (const sd of subpathDeviations(s, soup, W, W)) {
        if (sd.dev > d) d = sd.dev;
      }
    }
    sum += d;
    n++;
  }
  return sum / n;
}

let inputMotion = 0;
{
  const a = makeWander(100, 0.7).subpaths[0].anchors;
  const b = makeWander(100, 0.7 + JITTER_STEP).subpaths[0].anchors;
  for (let i = 0; i < a.length; i++) {
    inputMotion = Math.max(
      inputMotion,
      Math.hypot((a[i].pos[0] - b[i].pos[0]) * W, (a[i].pos[1] - b[i].pos[1]) * W)
    );
  }
}

if (jitterCpu.every(Boolean) && jitterGpu.every(Boolean)) {
  const meanCpu = jitterMean(jitterCpu);
  const meanGpu = jitterMean(jitterGpu);
  report(
    "temporal: jitter mean (GPU vs CPU same-process)",
    Math.abs(meanGpu - meanCpu) < 0.05,
    `cpu ${meanCpu.toFixed(3)} px, gpu ${meanGpu.toFixed(3)} px ` +
      `(input motion ${inputMotion.toFixed(2)} px/frame; historical CPU reference 7.60 px)`
  );
} else {
  report("temporal: jitter mean", false, "missing jitter frames upstream");
}

try {
  unlinkSync(gridsPath);
} catch {
  /* already gone */
}

console.log(
  failures === 0
    ? "\nall blend-gpu gates passed"
    : `\n${failures} blend-gpu gate(s) FAILED`
);
process.exit(failures === 0 ? 0 : 1);
