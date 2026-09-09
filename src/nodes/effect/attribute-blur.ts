import type {
  InputSocketDef,
  NodeDefinition,
  PointAttribute,
  SocketType,
  SplineValue,
} from "@/engine/types";
import { copyPointsWith, EMPTY_POINTS } from "@/engine/points";
import { buildSpatialHash, cellStart } from "@/engine/sim-kernel";
import {
  flattenSplineAnchorPositions,
  readSplineAnchorChannel,
  writeSplineAnchorChannel,
} from "@/engine/spline-attrs";

// Attribute Blur — smooth a named channel across neighbors
// (081326_point-attributes.md M3). Each iteration moves every element's
// value toward its neighborhood mean by Strength.
//
// Two domains:
//   spatial — neighbors within Radius, weighted by a linear falloff.
//             Radius is authored units (Proximity Merge's distance
//             convention); the sim-kernel spatial hash runs over
//             normalized space (W = H = 1), so each iteration visits a
//             3×3 cell block per point instead of all pairs. Spline
//             anchors share one hash (authored xy).
//   index   — a 1-2-1 kernel along order (edge-clamped). The right
//             domain for path-ordered points (Points from Spline, Points
//             on Path). On spline anchors the kernel runs per subpath
//             and wraps when the subpath is closed.
//
// Positions never change — this is a per-element transform on one
// channel; everything else carries through. A missing channel passes
// through unchanged.

const DOMAIN_OPTIONS = ["spatial", "index"] as const;

const TARGET_OPTIONS = ["points", "spline anchors"] as const;
type Target = (typeof TARGET_OPTIONS)[number];

const EMPTY_SPLINE: SplineValue = { kind: "spline", subpaths: [] };

function innerTypeFor(target: Target): SocketType {
  return target === "points" ? "points" : "spline";
}

type IndexRun = { start: number; count: number; closed: boolean };

function blurSpatial(
  pos: Float32Array,
  n: number,
  k: number,
  cur: Float32Array,
  next: Float32Array,
  radius: number,
  iterations: number,
  strength: number
): Float32Array {
  const hash = buildSpatialHash(pos, n, radius, 1, 1);
  const { gw, gh, cell, counts, entries } = hash;
  const r2 = radius * radius;
  const mean = new Array<number>(k);
  let a = cur;
  let b = next;
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) {
      const x = pos[i * 2];
      const y = pos[i * 2 + 1];
      // Self at weight 1 seeds the mean, so an isolated point holds.
      let wsum = 1;
      for (let c = 0; c < k; c++) mean[c] = a[i * k + c];
      const cx = Math.max(0, Math.min(gw - 1, Math.floor(x / cell)));
      const cy = Math.max(0, Math.min(gh - 1, Math.floor(y / cell)));
      for (let gy = Math.max(0, cy - 1); gy <= Math.min(gh - 1, cy + 1); gy++) {
        for (let gx = Math.max(0, cx - 1); gx <= Math.min(gw - 1, cx + 1); gx++) {
          const c0 = gy * gw + gx;
          const end = counts[c0];
          for (let e = cellStart(hash, c0); e < end; e++) {
            const j = entries[e];
            if (j === i) continue;
            const dx = pos[j * 2] - x;
            const dy = pos[j * 2 + 1] - y;
            const d2 = dx * dx + dy * dy;
            if (d2 > r2) continue;
            const w = 1 - Math.sqrt(d2) / radius;
            wsum += w;
            for (let c = 0; c < k; c++) mean[c] += a[j * k + c] * w;
          }
        }
      }
      for (let c = 0; c < k; c++) {
        const m = mean[c] / wsum;
        const v = a[i * k + c];
        b[i * k + c] = v + (m - v) * strength;
      }
    }
    [a, b] = [b, a];
  }
  return a;
}

function neighborsOf(
  i: number,
  n: number,
  runs: IndexRun[] | undefined
): [number, number] {
  if (!runs) {
    return [Math.max(0, i - 1), Math.min(n - 1, i + 1)];
  }
  for (const run of runs) {
    if (i < run.start || i >= run.start + run.count) continue;
    const li = i - run.start;
    const c = run.count;
    if (c <= 1) return [i, i];
    if (run.closed) {
      return [
        run.start + ((li - 1 + c) % c),
        run.start + ((li + 1) % c),
      ];
    }
    return [
      run.start + Math.max(0, li - 1),
      run.start + Math.min(c - 1, li + 1),
    ];
  }
  return [i, i];
}

function blurIndex(
  n: number,
  k: number,
  cur: Float32Array,
  next: Float32Array,
  iterations: number,
  strength: number,
  runs?: IndexRun[]
): Float32Array {
  let a = cur;
  let b = next;
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) {
      const [prev, succ] = neighborsOf(i, n, runs);
      for (let c = 0; c < k; c++) {
        const m =
          (a[prev * k + c] + a[i * k + c] * 2 + a[succ * k + c]) / 4;
        const v = a[i * k + c];
        b[i * k + c] = v + (m - v) * strength;
      }
    }
    [a, b] = [b, a];
  }
  return a;
}

export const attributeBlurNode: NodeDefinition = {
  type: "attribute-blur",
  name: "Attribute Blur",
  category: "point",
  subcategory: "modifier",
  description:
    "Smooths a named channel on points or spline anchors: each iteration moves every element's value toward its neighborhood mean. Spatial domain averages neighbors within a radius; Index domain averages adjacent elements in order (per-subpath, wrapping when closed). A missing channel passes through unchanged.",
  facts: {
    space: { out: "in:points", "param:radius": "canvas01" },
    gotchas: [
      "radius is canvas01 units, matching Proximity Merge's authored-xy distance convention (raw dx/dy between positions, no aspect term).",
      "domain=index on point targets treats the whole array as one flat, edge-clamped sequence (no wrap); only spline-anchor mode splits per subpath and wraps closed ones.",
      "spatial domain seeds each element's mean with its own value at weight 1, so an element with no neighbors within radius is left unchanged regardless of strength.",
    ],
  },
  backend: "webgl2",
  inputs: [{ name: "points", type: "points", required: true }],
  resolveInputs(params): InputSocketDef[] {
    const target = ((params.target as string) ?? "points") as Target;
    return [
      {
        name: "points",
        type: innerTypeFor(target),
        required: true,
        label: target === "points" ? "Points" : "Spline",
      },
    ];
  },
  params: [
    {
      name: "attr_name",
      label: "Name",
      type: "string",
      default: "weight",
      placeholder: "attribute name",
      suggestAttrsFrom: "points",
      suggestAttrsRequire: true,
    },
    {
      name: "target",
      label: "Target",
      type: "enum",
      options: TARGET_OPTIONS as unknown as string[],
      default: "points",
    },
    {
      name: "domain",
      label: "Domain",
      type: "enum",
      options: DOMAIN_OPTIONS as unknown as string[],
      default: "spatial",
    },
    {
      name: "radius",
      label: "Radius",
      type: "scalar",
      min: 0.001,
      max: 1,
      softMax: 0.25,
      step: 0.001,
      default: 0.05,
      visibleIf: (p) => p.domain !== "index",
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
      name: "strength",
      label: "Strength",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 1,
    },
  ],
  primaryOutput: "points",
  resolvePrimaryOutput(params): SocketType {
    return innerTypeFor(((params.target as string) ?? "points") as Target);
  },
  auxOutputs: [],

  compute({ inputs, params }) {
    const target = ((params.target as string) ?? "points") as Target;
    const name = ((params.attr_name as string) ?? "").trim();
    const domain = ((params.domain as string) ?? "spatial") as
      | "spatial"
      | "index";
    const radius = Math.max(0.001, (params.radius as number) ?? 0.05);
    const iterations = Math.max(
      1,
      Math.min(100, Math.round((params.iterations as number) ?? 5))
    );
    const strength = Math.min(
      Math.max((params.strength as number) ?? 1, 0),
      1
    );

    if (target === "spline anchors") {
      const src = inputs.points;
      if (!src || src.kind !== "spline") return { primary: EMPTY_SPLINE };
      const attr = name ? readSplineAnchorChannel(src, name) : undefined;
      if (!attr) return { primary: src };
      const { count: n, positions, runs } = flattenSplineAnchorPositions(src);
      const k = attr.arity;
      const cur = new Float32Array(attr.data.subarray(0, n * k));
      const next = new Float32Array(n * k);
      const data =
        domain === "spatial"
          ? blurSpatial(positions, n, k, cur, next, radius, iterations, strength)
          : blurIndex(n, k, cur, next, iterations, strength, runs);
      return {
        primary: writeSplineAnchorChannel(src, name, data, attr.arity),
      };
    }

    const src = inputs.points;
    if (!src || src.kind !== "points") return { primary: EMPTY_POINTS };
    const attr = name ? src.attributes?.[name] : undefined;
    if (!attr) return { primary: src };

    const n = src.count;
    const k = attr.arity;
    const cur = new Float32Array(attr.data.subarray(0, n * k));
    const next = new Float32Array(n * k);
    const data =
      domain === "spatial"
        ? blurSpatial(src.positions, n, k, cur, next, radius, iterations, strength)
        : blurIndex(n, k, cur, next, iterations, strength);

    const result: PointAttribute = {
      arity: attr.arity,
      color: attr.color,
      data,
    };
    return {
      primary: copyPointsWith(src, {
        attributes: { ...src.attributes, [name]: result },
      }),
    };
  },
};
