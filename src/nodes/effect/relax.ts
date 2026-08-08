import type {
  InputSocketDef,
  NodeDefinition,
  PointsValue,
  SocketType,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import { makePoints } from "@/engine/points";

// Relax — iteratively even out geometry. Polymorphic via a `mode` header
// control (points / spline), the mode-anchored group-pick pattern so the
// UI socket refresh stays correct.
//
// Points: Houdini-style push-apart. Every pair closer than `radius`
// repels — each side accumulates ((radius − d)/2)·axis per pair,
// Jacobi-style (sum first, apply once per iteration, damped 0.5) so the
// result doesn't depend on point order. Coincident pairs separate along a
// deterministic per-index hashed angle — no Math.random, so output is
// stable frame to frame and cacheable. The classic use: de-clump a
// Scatter before Copy to Points.
//
// Splines: per-subpath Laplacian smoothing of anchor POSITIONS —
// pᵢ ← pᵢ + ½·(avg(neighbors) − pᵢ) per iteration. Open endpoints are
// pinned, closed subpaths wrap. Handles ride along unchanged (they're
// relative offsets); chain Set Spline Type to re-fit them afterwards.
//
// `mix` lerps the final positions back toward the originals in both modes.
// Pure and deterministic — normal fingerprint caching applies.
//
// Spec: specdocs/archive/071026_spline-points-nodes.md.

type Mode = "points" | "spline";

const innerType = (mode: Mode): SocketType =>
  mode === "spline" ? "spline" : "points";

// Deterministic separation angle for exactly-coincident pairs.
function hashedAngle(i: number, j: number): number {
  let h = (i * 73856093) ^ (j * 19349663);
  h = (h ^ (h >>> 13)) * 0x5bd1e995;
  h ^= h >>> 15;
  return ((h >>> 0) % 6283) / 1000; // [0, 2π)
}

function relaxPoints(
  src: PointsValue,
  radius: number,
  iterations: number,
  mix: number
): PointsValue {
  const N = src.count;
  const out = makePoints(N, {
    withScales: !!src.scales,
    withRotations: !!src.rotations,
    withGroupIndices: !!src.groupIndices,
  });
  if (src.scales) out.scales!.set(src.scales);
  if (src.rotations) out.rotations!.set(src.rotations);
  if (src.groupIndices) out.groupIndices!.set(src.groupIndices);

  const pos = new Float32Array(src.positions); // working copy
  if (radius > 0 && iterations > 0 && N > 1) {
    const disp = new Float32Array(N * 2);
    const cell = radius;
    for (let iter = 0; iter < iterations; iter++) {
      disp.fill(0);
      // Spatial hash: cell = radius, so all pairs within threshold live in
      // the same or an adjacent cell (the connect-points pattern).
      const grid = new Map<string, number[]>();
      for (let i = 0; i < N; i++) {
        const k = `${Math.floor(pos[i * 2] / cell)}|${Math.floor(pos[i * 2 + 1] / cell)}`;
        let arr = grid.get(k);
        if (!arr) {
          arr = [];
          grid.set(k, arr);
        }
        arr.push(i);
      }
      for (let i = 0; i < N; i++) {
        const ax = pos[i * 2];
        const ay = pos[i * 2 + 1];
        const cx = Math.floor(ax / cell);
        const cy = Math.floor(ay / cell);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const arr = grid.get(`${cx + dx}|${cy + dy}`);
            if (!arr) continue;
            for (let k = 0; k < arr.length; k++) {
              const j = arr[k];
              if (j <= i) continue;
              const ex = ax - pos[j * 2];
              const ey = ay - pos[j * 2 + 1];
              const d = Math.hypot(ex, ey);
              if (d >= radius) continue;
              const push = (radius - d) / 2;
              let ux: number;
              let uy: number;
              if (d > 1e-9) {
                ux = ex / d;
                uy = ey / d;
              } else {
                const ang = hashedAngle(i, j);
                ux = Math.cos(ang);
                uy = Math.sin(ang);
              }
              disp[i * 2] += ux * push;
              disp[i * 2 + 1] += uy * push;
              disp[j * 2] -= ux * push;
              disp[j * 2 + 1] -= uy * push;
            }
          }
        }
      }
      // Jacobi apply, damped so dense clusters don't overshoot.
      for (let i = 0; i < N * 2; i++) pos[i] += disp[i] * 0.5;
    }
  }
  for (let i = 0; i < N * 2; i++) {
    out.positions[i] = src.positions[i] + (pos[i] - src.positions[i]) * mix;
  }
  return out;
}

function relaxSubpath(
  sub: SplineSubpath,
  iterations: number,
  mix: number
): SplineSubpath {
  const n = sub.anchors.length;
  const out: SplineSubpath = {
    anchors: sub.anchors.map((a) => ({ ...a, pos: [a.pos[0], a.pos[1]] })),
    closed: sub.closed,
  };
  if (sub.groupIndex !== undefined) out.groupIndex = sub.groupIndex;
  if (n < 3 || iterations <= 0 || mix <= 0) return out;

  let cur = new Float32Array(n * 2);
  let next = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    cur[i * 2] = sub.anchors[i].pos[0];
    cur[i * 2 + 1] = sub.anchors[i].pos[1];
  }
  const closed = !!sub.closed;
  for (let iter = 0; iter < iterations; iter++) {
    next.set(cur);
    const start = closed ? 0 : 1;
    const end = closed ? n : n - 1;
    for (let i = start; i < end; i++) {
      const ip = (i - 1 + n) % n;
      const inx = (i + 1) % n;
      const avgX = (cur[ip * 2] + cur[inx * 2]) / 2;
      const avgY = (cur[ip * 2 + 1] + cur[inx * 2 + 1]) / 2;
      next[i * 2] = cur[i * 2] + (avgX - cur[i * 2]) * 0.5;
      next[i * 2 + 1] = cur[i * 2 + 1] + (avgY - cur[i * 2 + 1]) * 0.5;
    }
    const tmp = cur;
    cur = next;
    next = tmp;
  }
  for (let i = 0; i < n; i++) {
    const a = out.anchors[i];
    a.pos[0] += (cur[i * 2] - a.pos[0]) * mix;
    a.pos[1] += (cur[i * 2 + 1] - a.pos[1]) * mix;
  }
  return out;
}

export const relaxNode: NodeDefinition = {
  type: "relax",
  name: "Relax",
  category: "utility",
  description:
    "Iteratively even out geometry. Points: push apart every pair closer than the radius (de-clump a Scatter). Splines: Laplacian-smooth anchor positions along each subpath (endpoints pinned, closed wraps; handles unchanged). Mix blends back toward the original.",
  backend: "webgl2",
  headerControl: { paramName: "mode" },
  inputs: [{ name: "in", type: "points", required: true }],
  resolveInputs(params): InputSocketDef[] {
    const mode = ((params.mode as string) ?? "points") as Mode;
    return [{ name: "in", type: innerType(mode), required: true, label: "In" }];
  },
  params: [
    {
      name: "mode",
      label: "Type",
      type: "enum",
      options: ["points", "spline"],
      default: "points",
    },
    {
      name: "iterations",
      label: "Iterations",
      type: "scalar",
      min: 1,
      max: 100,
      softMax: 20,
      step: 1,
      default: 5,
    },
    {
      name: "mix",
      label: "Mix",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 1,
    },
    {
      name: "radius",
      label: "Radius",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.25,
      step: 0.001,
      default: 0.05,
      visibleIf: (p) => ((p.mode as string) ?? "points") === "points",
    },
  ],
  primaryOutput: "points",
  resolvePrimaryOutput(params): SocketType {
    return innerType(((params.mode as string) ?? "points") as Mode);
  },
  auxOutputs: [],

  compute({ inputs, params }) {
    const mode = ((params.mode as string) ?? "points") as Mode;
    const iterations = Math.max(
      0,
      Math.floor((params.iterations as number) ?? 5)
    );
    const mix = Math.max(0, Math.min(1, (params.mix as number) ?? 1));

    if (mode === "spline") {
      const src = inputs.in;
      if (!src || src.kind !== "spline") {
        const empty: SplineValue = { kind: "spline", subpaths: [] };
        return { primary: empty };
      }
      const out: SplineValue = {
        kind: "spline",
        subpaths: src.subpaths.map((sub) => relaxSubpath(sub, iterations, mix)),
      };
      return { primary: out };
    }

    const src = inputs.in;
    if (!src || src.kind !== "points") {
      return { primary: makePoints(0) };
    }
    const radius = Math.max(0, (params.radius as number) ?? 0.05);
    return { primary: relaxPoints(src, radius, iterations, mix) };
  },
};
