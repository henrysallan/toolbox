import type { NodeDefinition, PointAttribute } from "@/engine/types";
import { copyPointsWith, EMPTY_POINTS } from "@/engine/points";
import {
  buildSpatialHash,
  cellStart,
  type SpatialHash,
} from "@/engine/sim-kernel";

// Attribute Transfer — copy a named channel from one point set onto
// another by proximity (081326_point-attributes.md M3). Scatter a grid,
// transfer `color` from image-sampled scatter points, etc.
//
//   nearest  — each target point takes the closest source point's value
//              (ring-expanding search over the spatial hash, so it always
//              resolves — no radius cliff).
//   weighted — distance-weighted average of source points within Radius
//              (linear falloff); targets with no source in range fall
//              back to nearest, so the result is always defined.
//
// Distances are authored units (Proximity Merge's convention). The
// channel lands on the target under the same name; the target's other
// channels carry through the copy untouched.

const MODE_OPTIONS = ["nearest", "weighted"] as const;

// Closest source index to (x, y): scan rings of cells outward from the
// seed cell; once any candidate exists, finish ONE extra ring (a nearer
// point can hide in the next ring's corner) and return the best.
function nearestIndex(
  hash: SpatialHash,
  pos: Float32Array,
  x: number,
  y: number
): number {
  const { gw, gh, cell, counts, entries } = hash;
  const cx = Math.max(0, Math.min(gw - 1, Math.floor(x / cell)));
  const cy = Math.max(0, Math.min(gh - 1, Math.floor(y / cell)));
  const maxRing = Math.max(gw, gh);
  let best = -1;
  let bestD2 = Infinity;
  let stopRing = Infinity;
  for (let ring = 0; ring <= maxRing && ring <= stopRing; ring++) {
    const x0 = cx - ring;
    const x1 = cx + ring;
    const y0 = cy - ring;
    const y1 = cy + ring;
    for (let gy = Math.max(0, y0); gy <= Math.min(gh - 1, y1); gy++) {
      const edgeRow = gy === y0 || gy === y1;
      for (let gx = Math.max(0, x0); gx <= Math.min(gw - 1, x1); gx++) {
        // Only the ring's perimeter — interior cells were prior rings.
        if (!edgeRow && gx !== x0 && gx !== x1) continue;
        const c = gy * gw + gx;
        const end = counts[c];
        for (let e = cellStart(hash, c); e < end; e++) {
          const j = entries[e];
          const dx = pos[j * 2] - x;
          const dy = pos[j * 2 + 1] - y;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2) {
            bestD2 = d2;
            best = j;
          }
        }
      }
    }
    if (best >= 0 && stopRing === Infinity) stopRing = ring + 1;
  }
  return best;
}

export const attributeTransferNode: NodeDefinition = {
  type: "attribute-transfer",
  name: "Attribute Transfer",
  category: "point",
  subcategory: "modifier",
  description:
    "Copies a named channel from a source point set onto the points by proximity: nearest source point, or a distance-weighted average within a radius (falling back to nearest outside it). The channel lands under the same name; a missing source channel passes the points through unchanged.",
  backend: "webgl2",
  inputs: [
    { name: "points", type: "points", required: true },
    { name: "source", type: "points", required: true },
  ],
  params: [
    {
      name: "attr_name",
      label: "Name",
      type: "string",
      default: "weight",
      placeholder: "attribute name",
      suggestAttrsFrom: "source",
      suggestAttrsRequire: true,
    },
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: MODE_OPTIONS as unknown as string[],
      default: "nearest",
    },
    {
      name: "radius",
      label: "Radius",
      type: "scalar",
      min: 0.001,
      max: 1,
      softMax: 0.25,
      step: 0.001,
      default: 0.1,
      visibleIf: (p) => p.mode === "weighted",
    },
  ],
  primaryOutput: "points",
  auxOutputs: [],

  compute({ inputs, params }) {
    const target = inputs.points;
    if (!target || target.kind !== "points") {
      return { primary: EMPTY_POINTS };
    }
    const source = inputs.source;
    const name = ((params.attr_name as string) ?? "").trim();
    const attr =
      source && source.kind === "points" && name
        ? source.attributes?.[name]
        : undefined;
    if (!attr || !source || source.kind !== "points" || source.count === 0) {
      return { primary: target };
    }

    const mode = ((params.mode as string) ?? "nearest") as
      | "nearest"
      | "weighted";
    const radius = Math.max(0.001, (params.radius as number) ?? 0.1);
    const sn = source.count;
    const spos = source.positions;
    const n = target.count;
    const k = attr.arity;
    const data = new Float32Array(n * k);
    // Cell size: the search radius for weighted; for nearest any scale
    // works — radius keeps ring counts sane on typical spreads.
    const hash = buildSpatialHash(spos, sn, radius, 1, 1);
    const { gw, gh, cell, counts, entries } = hash;
    const r2 = radius * radius;
    const acc = new Array<number>(k);

    for (let i = 0; i < n; i++) {
      const x = target.positions[i * 2];
      const y = target.positions[i * 2 + 1];
      let done = false;
      if (mode === "weighted") {
        let wsum = 0;
        for (let c = 0; c < k; c++) acc[c] = 0;
        const cx = Math.max(0, Math.min(gw - 1, Math.floor(x / cell)));
        const cy = Math.max(0, Math.min(gh - 1, Math.floor(y / cell)));
        for (let gy = Math.max(0, cy - 1); gy <= Math.min(gh - 1, cy + 1); gy++) {
          for (let gx = Math.max(0, cx - 1); gx <= Math.min(gw - 1, cx + 1); gx++) {
            const c0 = gy * gw + gx;
            const end = counts[c0];
            for (let e = cellStart(hash, c0); e < end; e++) {
              const j = entries[e];
              const dx = spos[j * 2] - x;
              const dy = spos[j * 2 + 1] - y;
              const d2 = dx * dx + dy * dy;
              if (d2 > r2) continue;
              const w = 1 - Math.sqrt(d2) / radius;
              wsum += w;
              for (let c = 0; c < k; c++) acc[c] += attr.data[j * k + c] * w;
            }
          }
        }
        if (wsum > 0) {
          for (let c = 0; c < k; c++) data[i * k + c] = acc[c] / wsum;
          done = true;
        }
      }
      if (!done) {
        const j = nearestIndex(hash, spos, x, y);
        if (j >= 0) {
          for (let c = 0; c < k; c++) data[i * k + c] = attr.data[j * k + c];
        }
      }
    }

    const result: PointAttribute = { arity: attr.arity, color: attr.color, data };
    return {
      primary: copyPointsWith(target, {
        attributes: { ...target.attributes, [name]: result },
      }),
    };
  },
};
