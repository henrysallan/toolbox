import type { NodeDefinition, PointAttribute } from "@/engine/types";
import { copyPointsWith, EMPTY_POINTS } from "@/engine/points";
import { buildSpatialHash, cellStart } from "@/engine/sim-kernel";

// Attribute Blur — smooth a named point channel across neighbors
// (081326_point-attributes.md M3). Each iteration moves every point's
// value toward its neighborhood mean by Strength.
//
// Two domains:
//   spatial — neighbors within Radius, weighted by a linear falloff.
//             Radius is authored units (Proximity Merge's distance
//             convention); the sim-kernel spatial hash runs over
//             normalized space (W = H = 1), so each iteration visits a
//             3×3 cell block per point instead of all pairs.
//   index   — a 1-2-1 kernel along point order (edge-clamped). The right
//             domain for path-ordered points (Points from Spline, Points
//             on Path), where "neighbor" means adjacent on the path.
//
// Positions never change — this is a per-point transform on one channel;
// everything else carries through the copy. A missing channel passes the
// points through unchanged.

const DOMAIN_OPTIONS = ["spatial", "index"] as const;

export const attributeBlurNode: NodeDefinition = {
  type: "attribute-blur",
  name: "Attribute Blur",
  category: "point",
  subcategory: "modifier",
  description:
    "Smooths a named point channel: each iteration moves every point's value toward its neighborhood mean. Spatial domain averages neighbors within a radius; Index domain averages adjacent points in order (right for path-ordered points). A missing channel passes through unchanged.",
  backend: "webgl2",
  inputs: [{ name: "points", type: "points", required: true }],
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
  auxOutputs: [],

  compute({ inputs, params }) {
    const src = inputs.points;
    if (!src || src.kind !== "points") return { primary: EMPTY_POINTS };
    const name = ((params.attr_name as string) ?? "").trim();
    const attr = name ? src.attributes?.[name] : undefined;
    if (!attr) return { primary: src };

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

    const n = src.count;
    const k = attr.arity;
    let cur = new Float32Array(attr.data.subarray(0, n * k));
    let next = new Float32Array(n * k);
    const mean = new Array<number>(k);

    if (domain === "spatial") {
      const pos = src.positions;
      const hash = buildSpatialHash(pos, n, radius, 1, 1);
      const { gw, gh, cell, counts, entries } = hash;
      const r2 = radius * radius;
      for (let it = 0; it < iterations; it++) {
        for (let i = 0; i < n; i++) {
          const x = pos[i * 2];
          const y = pos[i * 2 + 1];
          // Self at weight 1 seeds the mean, so an isolated point holds.
          let wsum = 1;
          for (let c = 0; c < k; c++) mean[c] = cur[i * k + c];
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
                for (let c = 0; c < k; c++) mean[c] += cur[j * k + c] * w;
              }
            }
          }
          for (let c = 0; c < k; c++) {
            const m = mean[c] / wsum;
            const v = cur[i * k + c];
            next[i * k + c] = v + (m - v) * strength;
          }
        }
        [cur, next] = [next, cur];
      }
    } else {
      // index domain — 1-2-1 kernel, edge-clamped.
      for (let it = 0; it < iterations; it++) {
        for (let i = 0; i < n; i++) {
          const prev = Math.max(0, i - 1);
          const succ = Math.min(n - 1, i + 1);
          for (let c = 0; c < k; c++) {
            const m =
              (cur[prev * k + c] + cur[i * k + c] * 2 + cur[succ * k + c]) /
              4;
            const v = cur[i * k + c];
            next[i * k + c] = v + (m - v) * strength;
          }
        }
        [cur, next] = [next, cur];
      }
    }

    const result: PointAttribute = {
      arity: attr.arity,
      color: attr.color,
      data: cur,
    };
    return {
      primary: copyPointsWith(src, {
        attributes: { ...src.attributes, [name]: result },
      }),
    };
  },
};
