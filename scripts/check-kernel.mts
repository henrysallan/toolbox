// check-kernel: exercises the vector kernel (kurbo/WASM) end to end through
// the real TS adapter — the same code path the Optimize Path node runs.
// Loads the COMMITTED artifact from public/wasm/v1, so it also catches a
// stale binary that drifted from the Rust source's expectations.
//
//   npx tsx scripts/check-kernel.mts
//
// Verification is independent of kurbo (spec §10.2): output curves are
// densely sampled in TS and checked against the analytic source shape.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import path from "node:path";

const g = globalThis as any;
g.window ??= g;
g.self ??= g;

const {
  initVectorKernelFromBytes,
  vectorKernelVersion,
  optimizeSpline,
} = await import("@/engine/vector-kernel");
type SplineValue = import("@/engine/types").SplineValue;
type SplineSubpath = import("@/engine/types").SplineSubpath;
type SplineAnchor = import("@/engine/types").SplineAnchor;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    failures++;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const wasmPath = path.join(process.cwd(), "public/wasm/v1/kernel_bg.wasm");
initVectorKernelFromBytes(readFileSync(wasmPath));
console.log(`kernel: ${vectorKernelVersion()}`);

// All tests run on a square 1000px canvas so normalized == px/1000.
const W = 1000;
const H = 1000;

// Sample every segment of a subpath densely (cubic eval, handles relative).
function samplePoints(sub: SplineSubpath, perSeg = 32): [number, number][] {
  const pts: [number, number][] = [];
  const segs: [SplineAnchor, SplineAnchor][] = [];
  for (let i = 1; i < sub.anchors.length; i++) {
    segs.push([sub.anchors[i - 1], sub.anchors[i]]);
  }
  if (sub.closed && sub.anchors.length > 1) {
    segs.push([sub.anchors[sub.anchors.length - 1], sub.anchors[0]]);
  }
  for (const [a, b] of segs) {
    const p0 = a.pos;
    const p1: [number, number] = [
      a.pos[0] + (a.outHandle?.[0] ?? 0),
      a.pos[1] + (a.outHandle?.[1] ?? 0),
    ];
    const p2: [number, number] = [
      b.pos[0] + (b.inHandle?.[0] ?? 0),
      b.pos[1] + (b.inHandle?.[1] ?? 0),
    ];
    const p3 = b.pos;
    for (let k = 0; k <= perSeg; k++) {
      const t = k / perSeg;
      const u = 1 - t;
      pts.push([
        u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
        u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
      ]);
    }
  }
  return pts;
}

// ---- 1. dense noisy circle polyline -> few smooth anchors, on-radius ----
{
  const n = 512;
  const anchors: SplineAnchor[] = [];
  for (let k = 0; k < n; k++) {
    const th = (k / n) * Math.PI * 2;
    // deterministic high-frequency jitter, ~±0.7px
    const r = 0.3 + 0.0007 * Math.sin(th * 113);
    anchors.push({ pos: [0.5 + r * Math.cos(th), 0.5 + r * Math.sin(th)] });
  }
  const src: SplineValue = {
    kind: "spline",
    subpaths: [{ anchors, closed: true, groupIndex: 7, driver: 0.25 }],
  };
  const out = optimizeSpline(
    src,
    { tolerancePx: 2, mode: "adaptive", cornerAngleDeg: 30 },
    W,
    H
  );
  const sub = out.subpaths[0];
  check(
    `noisy 512-gon circle collapses (${anchors.length} -> ${sub.anchors.length} anchors)`,
    sub.anchors.length < 64 && sub.anchors.length >= 3
  );
  const opt = optimizeSpline(
    src,
    { tolerancePx: 2, mode: "optimal", cornerAngleDeg: 30 },
    W,
    H
  );
  check(
    `optimal mode on noisy circle (${opt.subpaths[0].anchors.length} anchors)`,
    opt.subpaths[0].anchors.length <= 16
  );
  check("circle stays closed + keeps tags", sub.closed && sub.groupIndex === 7 && sub.driver === 0.25);
  let worst = 0;
  for (const [x, y] of samplePoints(sub)) {
    const rPx = Math.hypot((x - 0.5) * W, (y - 0.5) * H);
    worst = Math.max(worst, Math.abs(rPx - 300));
  }
  check(`circle deviation within tolerance (worst ${worst.toFixed(2)}px)`, worst < 3.5);
}

// ---- 2. rectangle corners preserved exactly ----
{
  const rect: SplineValue = {
    kind: "spline",
    subpaths: [
      {
        anchors: [
          { pos: [0.2, 0.2] },
          { pos: [0.8, 0.2] },
          { pos: [0.8, 0.6] },
          { pos: [0.2, 0.6] },
        ],
        closed: true,
      },
    ],
  };
  const out = optimizeSpline(
    rect,
    { tolerancePx: 0.5, mode: "adaptive", cornerAngleDeg: 30 },
    W,
    H
  );
  const sub = out.subpaths[0];
  const cornersSurvive =
    sub.anchors.length === 4 &&
    sub.anchors.every(
      (a) =>
        rect.subpaths[0].anchors.some(
          (s) => Math.hypot(a.pos[0] - s.pos[0], a.pos[1] - s.pos[1]) * W < 0.01
        )
    );
  check(`rectangle corners preserved (${sub.anchors.length} anchors)`, cornersSurvive);
}

// ---- 3. an exact cubic reproduces near-verbatim at tight tolerance ----
{
  const src: SplineValue = {
    kind: "spline",
    subpaths: [
      {
        anchors: [
          { pos: [0.1, 0.5], outHandle: [0.15, -0.3] },
          { pos: [0.9, 0.5], inHandle: [-0.15, -0.3] },
        ],
        closed: false,
      },
    ],
  };
  const out = optimizeSpline(
    src,
    { tolerancePx: 0.05, mode: "adaptive", cornerAngleDeg: 30 },
    W,
    H
  );
  const a = samplePoints(src.subpaths[0]);
  const b = samplePoints(out.subpaths[0], Math.ceil((a.length - 1) / Math.max(1, out.subpaths[0].anchors.length - 1)));
  let worst = 0;
  for (const [x, y] of a) {
    let best = Infinity;
    for (const [x2, y2] of b) {
      best = Math.min(best, Math.hypot((x - x2) * W, (y - y2) * H));
    }
    worst = Math.max(worst, best);
  }
  check(
    `exact cubic reproduces (${out.subpaths[0].anchors.length} anchors, worst ${worst.toFixed(3)}px)`,
    out.subpaths[0].anchors.length <= 3 && worst < 0.6
  );
}

// ---- 4. degenerate inputs pass through, don't throw ----
{
  const src: SplineValue = {
    kind: "spline",
    subpaths: [
      { anchors: [{ pos: [0.5, 0.5] }], closed: false },
      { anchors: [{ pos: [0.1, 0.1] }, { pos: [0.2, 0.2] }], closed: false },
    ],
  };
  const out = optimizeSpline(
    src,
    { tolerancePx: 0.5, mode: "adaptive", cornerAngleDeg: 30 },
    W,
    H
  );
  check(
    "degenerate subpaths pass through",
    out.subpaths.length === 2 && out.subpaths[0].anchors.length === 1
  );
}

// ---- 4b. smoothing denoises: fewer anchors on jittery input ----
{
  const n = 512;
  const anchors: SplineAnchor[] = [];
  for (let k = 0; k < n; k++) {
    const th = (k / n) * Math.PI * 2;
    const r = 0.3 + 0.0007 * Math.sin(th * 113);
    anchors.push({ pos: [0.5 + r * Math.cos(th), 0.5 + r * Math.sin(th)] });
  }
  const src: SplineValue = { kind: "spline", subpaths: [{ anchors, closed: true }] };
  const base = { tolerancePx: 2, mode: "adaptive", cornerAngleDeg: 30 } as const;
  const rough = optimizeSpline(src, { ...base }, W, H);
  const smooth = optimizeSpline(src, { ...base, smoothing: 0.6 }, W, H);
  const nr = rough.subpaths[0].anchors.length;
  const ns = smooth.subpaths[0].anchors.length;
  let worst = 0;
  for (const [x, y] of samplePoints(smooth.subpaths[0])) {
    const rPx = Math.hypot((x - 0.5) * W, (y - 0.5) * H);
    worst = Math.max(worst, Math.abs(rPx - 300));
  }
  check(
    `smoothing reduces anchors (${nr} -> ${ns}) and stays on shape (worst ${worst.toFixed(2)}px)`,
    ns < nr && ns < 40 && worst < 3.5
  );
}

// ---- 4c. cull specks drops short subpaths, keeps real ones ----
{
  const speck: import("@/engine/types").SplineSubpath = {
    anchors: [
      { pos: [0.5, 0.5] },
      { pos: [0.502, 0.5] },
      { pos: [0.502, 0.502] },
    ],
    closed: false,
  };
  const line: import("@/engine/types").SplineSubpath = {
    anchors: [{ pos: [0.1, 0.1] }, { pos: [0.5, 0.1] }, { pos: [0.9, 0.1] }],
    closed: false,
  };
  const src: SplineValue = { kind: "spline", subpaths: [speck, line] };
  const base = { tolerancePx: 0.5, mode: "adaptive", cornerAngleDeg: 30 } as const;
  const kept = optimizeSpline(src, { ...base }, W, H);
  const culled = optimizeSpline(src, { ...base, cullMinLengthPx: 20 }, W, H);
  check(
    `cull specks (${kept.subpaths.length} -> ${culled.subpaths.length} subpaths)`,
    kept.subpaths.length === 2 && culled.subpaths.length === 1
  );
}

// ---- 5. optimal mode beats adaptive on segment count ----
{
  const n = 256;
  const anchors: SplineAnchor[] = [];
  for (let k = 0; k < n; k++) {
    const th = (k / n) * Math.PI * 2;
    anchors.push({ pos: [0.5 + 0.3 * Math.cos(th), 0.5 + 0.3 * Math.sin(th)] });
  }
  const src: SplineValue = { kind: "spline", subpaths: [{ anchors, closed: true }] };
  const opts = { tolerancePx: 0.25, cornerAngleDeg: 30 } as const;
  const adaptive = optimizeSpline(src, { ...opts, mode: "adaptive" }, W, H);
  const optimal = optimizeSpline(src, { ...opts, mode: "optimal" }, W, H);
  const na = adaptive.subpaths[0].anchors.length;
  const no = optimal.subpaths[0].anchors.length;
  check(`optimal <= adaptive segment count (${no} vs ${na})`, no <= na && no <= 12);
}

// ---- 6. spike star: thin tips pin exactly (fold + straight-run bugs) ----
// Guards two interlocking regressions: (a) corner detection must not fold
// past 90° (near-reversal spike tips were classified smooth and rounded),
// (b) exactly-straight runs must not send the fitter into exponential
// bisection (the flank runs this star produces once tips split correctly).
{
  const apexDeg = [10, 20, 45, 90, 150];
  const anchors: SplineAnchor[] = [];
  const spikeTips: [number, number][] = [];
  const m = apexDeg.length;
  for (let k = 0; k < m; k++) {
    const phi = (k / m) * Math.PI * 2;
    const rIn = 0.2;
    const rTip = 0.38;
    const halfW = Math.tan(((apexDeg[k] / 2) * Math.PI) / 180) * (rTip - rIn);
    const baseA = [0.5 + rIn * Math.cos(phi - halfW / rIn), 0.5 + rIn * Math.sin(phi - halfW / rIn)];
    const tip: [number, number] = [0.5 + rTip * Math.cos(phi), 0.5 + rTip * Math.sin(phi)];
    const baseB = [0.5 + rIn * Math.cos(phi + halfW / rIn), 0.5 + rIn * Math.sin(phi + halfW / rIn)];
    spikeTips.push(tip);
    const lerp = (a: number[], b: number[], t: number) =>
      [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] as [number, number];
    for (let s = 0; s < 10; s++) anchors.push({ pos: lerp(baseA, tip, s / 10) });
    for (let s = 0; s < 10; s++) anchors.push({ pos: lerp(tip, baseB, s / 10) });
  }
  const src: SplineValue = { kind: "spline", subpaths: [{ anchors, closed: true }] };
  for (const mode of ["adaptive", "optimal"] as const) {
    const t0 = Date.now();
    const out = optimizeSpline(src, { tolerancePx: 1, mode, cornerAngleDeg: 30 }, W, H);
    const ms = Date.now() - t0;
    let worst = 0;
    for (const [tx, ty] of spikeTips) {
      let best = Infinity;
      for (const sub of out.subpaths) {
        for (const a of sub.anchors) {
          best = Math.min(best, Math.hypot((a.pos[0] - tx) * W, (a.pos[1] - ty) * H));
        }
      }
      worst = Math.max(worst, best);
    }
    check(
      `spike star ${mode}: tips pinned (worst ${worst.toFixed(3)}px, ${out.subpaths[0].anchors.length} anchors, ${ms}ms)`,
      worst < 0.01 && ms < 5000
    );
  }
}

if (failures > 0) {
  console.error(`\ncheck-kernel: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncheck-kernel: all green");
