import type {
  InputSocketDef,
  NodeDefinition,
  SocketType,
  SplineValue,
} from "@/engine/types";
import {
  EMPTY_POINTS,
  isWritablePointAttr,
  pointAttrSchema,
  readPointAttrColumn,
  withPointAttr,
} from "@/engine/points";
import {
  buildSpatialHash,
  cellStart,
  type SpatialHash,
} from "@/engine/sim-kernel";
import {
  flattenSplineAnchorPositions,
  readSplineAnchorChannel,
  writeSplineAnchorChannel,
} from "@/engine/spline-attrs";

// Attribute Transfer — copy a named channel from one set onto another
// by proximity (081326_point-attributes.md M3). Scatter a grid, transfer
// `color` from image-sampled scatter points, etc. Source and target can
// each be points or spline anchors (flattened to authored xy).
//
//   nearest  — each target takes the closest source's value (ring-
//              expanding search over the spatial hash, so it always
//              resolves — no radius cliff). With fallback=zero, a
//              source outside Radius is rejected and the target gets 0.
//   weighted — distance-weighted average of sources within Radius
//              (linear falloff). Misses (nothing in range) use Fallback:
//              nearest (always defined) or zero.
//
// Distances are authored units (Proximity Merge's convention). The
// channel lands on the target under the same name; the target's other
// channels carry through untouched.
//
// Built-in columns transfer too, when both sides are points: name
// `rotation`, `scale` / `scale.x` / `scale.y`, `position` / `x` / `y`, or
// `group`, and the value is read off the source's typed arrays and stored
// into the target's through the unified attribute API (points.ts
// `readPointAttrColumn` / `withPointAttr`, 092026_unified-attributes.md).
// `group` is an identity tag, so it always takes the nearest source and
// rounds; `index`, `z` and normals are read-only and pass the target
// through. Spline anchors carry none of these fields, so a built-in name
// with a spline on either side passes through as well.

const MODE_OPTIONS = ["nearest", "weighted"] as const;
const FALLBACK_OPTIONS = ["nearest", "zero"] as const;

const TARGET_OPTIONS = ["points", "spline anchors"] as const;
type Target = (typeof TARGET_OPTIONS)[number];

const EMPTY_SPLINE: SplineValue = { kind: "spline", subpaths: [] };

function innerTypeFor(target: Target): SocketType {
  return target === "points" ? "points" : "spline";
}

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

function transferChannel(
  spos: Float32Array,
  sn: number,
  srcData: Float32Array,
  k: number,
  tpos: Float32Array,
  n: number,
  mode: "nearest" | "weighted",
  radius: number,
  fallback: "nearest" | "zero"
): Float32Array {
  const data = new Float32Array(n * k);
  const hash = buildSpatialHash(spos, sn, radius, 1, 1);
  const { gw, gh, cell, counts, entries } = hash;
  const r2 = radius * radius;
  const acc = new Array<number>(k);

  for (let i = 0; i < n; i++) {
    const x = tpos[i * 2];
    const y = tpos[i * 2 + 1];
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
            for (let c = 0; c < k; c++) acc[c] += srcData[j * k + c] * w;
          }
        }
      }
      if (wsum > 0) {
        for (let c = 0; c < k; c++) data[i * k + c] = acc[c] / wsum;
        done = true;
      }
    }
    // Miss: leave the zero-initialized slot (fallback=zero) or copy the
    // unbounded nearest source. In nearest mode, fallback=zero still
    // finds the closest source, then rejects it when it's outside radius.
    if (!done && !(fallback === "zero" && mode === "weighted")) {
      const j = nearestIndex(hash, spos, x, y);
      if (j >= 0) {
        if (fallback === "zero") {
          const dx = spos[j * 2] - x;
          const dy = spos[j * 2 + 1] - y;
          if (dx * dx + dy * dy > r2) continue;
        }
        for (let c = 0; c < k; c++) data[i * k + c] = srcData[j * k + c];
      }
    }
  }
  return data;
}

export const attributeTransferNode: NodeDefinition = {
  type: "attribute-transfer",
  name: "Attribute Transfer",
  category: "point",
  subcategory: "modifier",
  description:
    "Copies a named channel, or a built-in column (rotation, scale, position, group), from a source onto a target by proximity: nearest source, or a distance-weighted average within a radius. When nothing is in range, Fallback copies the nearest source or writes zero. Source and target can each be points or spline anchors; a named channel lands under the same name, while a built-in lands in the target's own rotation / scale / position / group data (points on both sides). A missing source channel passes the target through unchanged.",
  facts: {
    space: { "param:radius": "canvas01", out: "in:points" },
    reads: ["attr:rotation", "attr:scale", "attr:position", "attr:group"],
    writes: ["attr:rotation", "attr:scale", "attr:position", "attr:group"],
    gotchas: [
      "mode=nearest ring-searches outward until it finds a source (ignores radius) unless fallback=zero, which keeps only a source within radius and writes 0 otherwise.",
      "mode=weighted averages sources within radius with linear falloff (weight = 1 − d/radius) over a 3×3 hash neighborhood; fallback=nearest copies the closest source on a miss, fallback=zero writes 0.",
      "radius is compared against authored point/spline-anchor positions (canvas01-scale distances, matching Proximity Merge), not pixels or UV.",
      "A named channel keeps the source's arity and color flag (a vec3 color arrives flagged as color); a missing source channel passes the target through unchanged.",
      "attr_name=rotation / scale(.x/.y) / position (x/y) / group lands in the target's own field (points on both sides only), never as a named channel; a single-axis name keeps the other axis.",
      "group always takes the nearest source (mode=weighted is ignored for it) and rounds to an integer tag; fallback=zero writes a literal 0 to a built-in, so a missed scale collapses to 0.",
      "index, z and nx/ny/nz are read-only and pass the target through, as does any built-in name with spline anchors on either side.",
    ],
  },
  backend: "webgl2",
  inputs: [
    { name: "points", type: "points", required: true },
    { name: "source", type: "points", required: true },
  ],
  resolveInputs(params): InputSocketDef[] {
    const target = ((params.target as string) ?? "points") as Target;
    const sourceTarget = ((params.source_target as string) ?? "points") as Target;
    return [
      {
        name: "points",
        type: innerTypeFor(target),
        required: true,
        label: target === "points" ? "Points" : "Spline",
      },
      {
        name: "source",
        type: innerTypeFor(sourceTarget),
        required: true,
        label: sourceTarget === "points" ? "Source" : "Source spline",
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
      suggestAttrsFrom: "source",
      suggestAttrsRequire: true,
      // Offer the built-in columns compute can store back (rotation,
      // scale(.x/.y), position/x/y, group). index / z / normals have no
      // home on the target, so they stay out of the picker and tint red.
      suggestAttrsIncludeBuiltins: true,
      suggestAttrsBuiltinFilter: isWritablePointAttr,
    },
    {
      name: "target",
      label: "Target",
      type: "enum",
      options: TARGET_OPTIONS as unknown as string[],
      default: "points",
    },
    {
      name: "source_target",
      label: "Source",
      type: "enum",
      options: TARGET_OPTIONS as unknown as string[],
      default: "points",
    },
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: MODE_OPTIONS as unknown as string[],
      default: "nearest",
    },
    {
      name: "fallback",
      label: "Fallback",
      type: "enum",
      options: FALLBACK_OPTIONS as unknown as string[],
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
      visibleIf: (p) => p.mode === "weighted" || p.fallback === "zero",
    },
  ],
  primaryOutput: "points",
  resolvePrimaryOutput(params): SocketType {
    return innerTypeFor(((params.target as string) ?? "points") as Target);
  },
  auxOutputs: [],

  compute({ inputs, params }) {
    const targetKind = ((params.target as string) ?? "points") as Target;
    const sourceKind = ((params.source_target as string) ?? "points") as Target;
    const name = ((params.attr_name as string) ?? "").trim();
    const mode = ((params.mode as string) ?? "nearest") as
      | "nearest"
      | "weighted";
    const fallback = ((params.fallback as string) ?? "nearest") as
      | "nearest"
      | "zero";
    const radius = Math.max(0.001, (params.radius as number) ?? 0.1);
    const target = inputs.points;
    const source = inputs.source;

    const emptyPrimary =
      targetKind === "points" ? EMPTY_POINTS : EMPTY_SPLINE;
    if (
      !target ||
      (targetKind === "points" && target.kind !== "points") ||
      (targetKind === "spline anchors" && target.kind !== "spline")
    ) {
      return { primary: emptyPrimary };
    }

    // A built-in column (rotation / scale / position / group) rides the
    // typed arrays on both sides, so it needs points on both sides — with
    // a spline anywhere the name has no home and the target passes
    // through. Non-writable built-ins (index, z, normals) pass through
    // too; the picker filter tints them.
    const schema = pointAttrSchema(name);
    if (schema && (sourceKind !== "points" || targetKind !== "points")) {
      return { primary: target };
    }
    if (schema && !schema.writable) return { primary: target };

    let sn = 0;
    let spos: Float32Array | undefined;
    let srcData: Float32Array | undefined;
    let k: 1 | 2 | 3 | 4 = 1;
    let srcColor: boolean | undefined;
    if (schema) {
      if (source && source.kind === "points" && source.count > 0) {
        const col = readPointAttrColumn(source, name);
        if (col) {
          sn = source.count;
          spos = source.positions;
          srcData = col.data;
          k = col.arity;
        }
      }
    } else if (sourceKind === "spline anchors") {
      if (source && source.kind === "spline" && name) {
        const ch = readSplineAnchorChannel(source, name);
        if (ch) {
          const flat = flattenSplineAnchorPositions(source);
          sn = flat.count;
          spos = flat.positions;
          srcData = ch.data;
          k = ch.arity;
        }
      }
    } else if (source && source.kind === "points" && name) {
      const attr = source.attributes?.[name];
      if (attr && source.count > 0) {
        sn = source.count;
        spos = source.positions;
        srcData = attr.data;
        k = attr.arity;
        srcColor = attr.color;
      }
    }
    if (!spos || !srcData || sn === 0) {
      return { primary: target };
    }

    if (targetKind === "spline anchors" && target.kind === "spline") {
      const flat = flattenSplineAnchorPositions(target);
      if (flat.count === 0) return { primary: target };
      const data = transferChannel(
        spos,
        sn,
        srcData,
        k,
        flat.positions,
        flat.count,
        mode,
        radius,
        fallback
      );
      return {
        primary: writeSplineAnchorChannel(target, name, data, k),
      };
    }

    if (target.kind !== "points") return { primary: EMPTY_POINTS };
    const n = target.count;
    // An identity tag cannot be averaged: `group` (kind int) always takes
    // the nearest source (fallback still applies) and rounds on write.
    const effectiveMode = schema?.kind === "int" ? "nearest" : mode;
    const data = transferChannel(
      spos,
      sn,
      srcData,
      k,
      target.positions,
      n,
      effectiveMode,
      radius,
      fallback
    );
    return {
      primary: withPointAttr(target, name, data, { arity: k, color: srcColor }),
    };
  },
};
