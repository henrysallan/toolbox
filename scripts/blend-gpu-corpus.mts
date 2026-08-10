// Shared corpus for the Blend Intersections GPU-field equivalence gate
// (check:blend-gpu). One module so the emit stage (packs textures for the
// Electron harness) and the verify stage (recomputes CPU references) can
// never drift onto different inputs.
//
// The corpus is the bench-spline-chain shape (3 sizes × 2 phases of the
// advected-wander polyline), plus the 12-frame jitter sweep from
// bench-spline-jitter.mts (gate 3), plus the bench:nodes 8-lobe network —
// the multi-subpath closed-and-crossing input that stresses branch count
// and the seam-wrap merge hardest.
import type { SplineSubpath, SplineValue } from "../src/engine/types.ts";
import type { BlendIntersectionsOptions } from "../src/engine/spline-blend-intersections.ts";

export const JITTER_STEP = 0.004;
export const JITTER_FRAMES = 12;

export interface BlendGpuCase {
  name: string;
  spline: SplineValue;
  canvasW: number;
  canvasH: number;
  opts: BlendIntersectionsOptions;
  // Which gates the case participates in.
  jitterFrame?: number; // gate 3 ordering
  // Dense-network case (hundreds of output subpaths): field equivalence is
  // checked per-sample with knife-edge classification instead of a flat
  // 1e-3 max — see check-blend-gpu-verify.mts for the reasoning.
  dense?: boolean;
}

const OPTS: BlendIntersectionsOptions = {
  widthPx: 6,
  blendPx: 24,
  resolution: 288,
  smoothing: 0.5,
};

// Mirrors makeAdvectedPolyline in bench-spline-chain.mts / makeInput in
// bench-spline-jitter.mts.
export function makeWander(n: number, phase: number): SplineValue {
  const anchors: SplineSubpath["anchors"] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    anchors.push({
      pos: [
        0.5 + 0.34 * Math.sin(3 * t + phase) + 0.06 * Math.sin(11 * t),
        0.5 + 0.34 * Math.sin(5 * t) + 0.06 * Math.cos(7 * t + phase),
      ],
    });
  }
  return { kind: "spline", subpaths: [{ anchors, closed: false }] };
}

// Mirrors makeSpline in scripts/bench/harness.ts (bench:nodes).
export function makeLobes(): SplineValue {
  const subpaths: SplineSubpath[] = [];
  for (let s = 0; s < 8; s++) {
    const anchors: SplineSubpath["anchors"] = [];
    const fx = 3 + (s % 4);
    const fy = 2 + ((s * 3) % 5);
    const phase = (s / 8) * Math.PI;
    for (let a = 0; a < 24; a++) {
      const t = (a / 24) * Math.PI * 2;
      const x = 0.5 + Math.sin(fx * t + phase) * 0.36;
      const y = 0.5 + Math.sin(fy * t) * 0.36;
      const dx = Math.cos(fx * t + phase) * fx * 0.02;
      const dy = Math.cos(fy * t) * fy * 0.02;
      anchors.push({
        pos: [x, y],
        inHandle: [x - dx, y - dy],
        outHandle: [x + dx, y + dy],
      });
    }
    subpaths.push({ anchors, closed: true });
  }
  return { kind: "spline", subpaths };
}

export function buildCorpus(): BlendGpuCase[] {
  const cases: BlendGpuCase[] = [];
  for (const n of [50, 100, 200]) {
    for (const phase of [0.7, 1.9]) {
      cases.push({
        name: `wander-${n}-${phase}`,
        spline: makeWander(n, phase),
        canvasW: 1024,
        canvasH: 1024,
        opts: OPTS,
      });
    }
  }
  // Closed single wander — seam-wrap coverage at normal density (none of
  // the bench-corpus cases are closed, and the wrap merge is the subtlest
  // part of the branch clustering).
  {
    const closed = makeWander(100, 0.7);
    closed.subpaths = closed.subpaths.map((s) => ({ ...s, closed: true }));
    cases.push({
      name: "wander-closed-100-0.7",
      spline: closed,
      canvasW: 1024,
      canvasH: 1024,
      opts: OPTS,
    });
  }
  cases.push({
    name: "lobes-1920x1080",
    spline: makeLobes(),
    canvasW: 1920,
    canvasH: 1080,
    opts: OPTS,
    dense: true,
  });
  for (let f = 0; f < JITTER_FRAMES; f++) {
    cases.push({
      name: `jitter-${f}`,
      spline: makeWander(100, 0.7 + f * JITTER_STEP),
      canvasW: 1024,
      canvasH: 1024,
      opts: OPTS,
      jitterFrame: f,
    });
  }
  return cases;
}
