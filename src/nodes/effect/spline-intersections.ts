import type {
  NodeDefinition,
  Point,
  PointsValue,
  SplineValue,
} from "@/engine/types";
import { subpathToBeziers } from "@/engine/spline-math";
import { pointsFromArray } from "@/engine/points";

// Emit a point at every crossing of an input spline's segments — the
// "nodes at the intersections" construction-drawing look. Feed the output
// into Copy to Points to stamp a marker glyph (square / circle / triangle)
// at each crossing.
//
// Pipeline: flatten each subpath to a polyline (straight 2-anchor subpaths
// stay exact — one segment, no sampling), then test segment pairs for
// interior crossings. By default only segments from DIFFERENT subpaths are
// tested — for a cluster of scattered shapes + construction lines, each
// shape and each line is its own subpath, so cross-subpath catches exactly
// the line×shape and line×line crossings the look is built from, and
// skips a convex shape's own (non-crossing) edges. `self_intersections`
// also tests within a subpath (for self-crossing polylines / star polygons).
//
// Classification: Point → Generator. Mirrors connect-points on the other
// side of the type boundary (spline in → points out, vs points in →
// spline out). Pure CPU geometry — no GL, engine-self-contained.
//
// Complexity: O(S²) over flattened segments with an AABB quick-reject. The
// node is cached (no time dependence), so it only recomputes when its
// input/params change; for typical cover-art sizes (hundreds–low thousands
// of segments) the squared loop is sub-millisecond. A segment spatial hash
// would matter past that, but long construction lines span many cells and
// would need true segment-cell rasterization to stay correct — deferred.

// Steps per CURVED cubic when flattening to a polyline. Straight cubics
// (no handles) collapse to a single segment regardless. 16 keeps a circle
// (4 cubics → 64 segments) visually round for crossing tests without
// exploding the pair count.
const FLATTEN_STEPS = 16;

// Two crossing points closer than this (UV) are merged — a line crossing a
// curve exactly at a flattened vertex is reported by both adjacent
// sub-segments, so dedup keeps it a single node.
const MERGE_DIST = 1e-4;

interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  sub: number; // owning subpath index — drives the same/cross-subpath gate
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// Interior intersection of two segments. Returns the crossing point when
// both parameters land inside [0,1] (inclusive — shared-vertex double hits
// are removed later by the merge pass), else null. Parallel/degenerate
// pairs return null.
function segIntersect(a: Seg, b: Seg): { x: number; y: number } | null {
  const x1 = a.x1, y1 = a.y1, x2 = a.x2, y2 = a.y2;
  const x3 = b.x1, y3 = b.y1, x4 = b.x2, y4 = b.y2;
  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(den) < 1e-12) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
  const u = ((x1 - x3) * (y1 - y2) - (y1 - y3) * (x1 - x2)) / den;
  const e = 1e-9;
  if (t < -e || t > 1 + e || u < -e || u > 1 + e) return null;
  return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
}

// Angle between two segments' directions, in degrees [0, 90]. Used by the
// `min_angle` filter to drop near-tangent / glancing crossings.
function crossAngleDeg(a: Seg, b: Seg): number {
  const d1x = a.x2 - a.x1, d1y = a.y2 - a.y1;
  const d2x = b.x2 - b.x1, d2y = b.y2 - b.y1;
  const l1 = Math.hypot(d1x, d1y);
  const l2 = Math.hypot(d2x, d2y);
  if (l1 < 1e-12 || l2 < 1e-12) return 0;
  const dot = (d1x * d2x + d1y * d2y) / (l1 * l2);
  return (Math.acos(Math.min(1, Math.abs(dot))) * 180) / Math.PI;
}

// Flatten one subpath into segments tagged with its subpath index. Straight
// cubics (control points coincident with endpoints) collapse to a single
// segment via getLUT(1); curved ones sample FLATTEN_STEPS sub-segments.
function flattenSubpath(
  sub: SplineValue["subpaths"][number],
  subIndex: number,
  out: Seg[]
): void {
  const beziers = subpathToBeziers(sub);
  for (const { curve } of beziers) {
    const p = curve.points;
    const straight =
      Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y) < 1e-7 &&
      Math.hypot(p[2].x - p[3].x, p[2].y - p[3].y) < 1e-7;
    const lut = curve.getLUT(straight ? 1 : FLATTEN_STEPS);
    for (let i = 0; i < lut.length - 1; i++) {
      const a = lut[i];
      const c = lut[i + 1];
      out.push({
        x1: a.x,
        y1: a.y,
        x2: c.x,
        y2: c.y,
        sub: subIndex,
        minX: Math.min(a.x, c.x),
        minY: Math.min(a.y, c.y),
        maxX: Math.max(a.x, c.x),
        maxY: Math.max(a.y, c.y),
      });
    }
  }
}

export const splineIntersectionsNode: NodeDefinition = {
  type: "spline-intersections",
  name: "Spline Intersections",
  category: "point",
  subcategory: "generator",
  description:
    "Emit a point at every crossing of the input spline's segments — the 'nodes at intersections' construction-drawing look. Feed the output into Copy to Points to stamp a marker at each crossing. By default only segments from different subpaths are tested (so a cluster of shapes + lines marks line×shape and line×line crossings); enable Self-intersections for self-crossing polylines. The original spline passes through on the aux output so one wire carries both the drawing and its nodes.",
  backend: "webgl2",
  inputs: [{ name: "spline", type: "spline", required: true }],
  params: [
    {
      // Fraction of crossings kept, decimated evenly (1 = all). Mirrors the
      // reference tool's "Nodes" thinning.
      name: "density",
      label: "Density",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 1,
    },
    {
      name: "self_intersections",
      label: "Self-intersections",
      type: "boolean",
      default: false,
    },
    {
      // Drop glancing crossings whose segments meet below this angle.
      name: "min_angle",
      label: "Min angle",
      type: "scalar",
      min: 0,
      max: 90,
      step: 1,
      default: 0,
    },
    {
      // Render cap — crossings past this are dropped (discovery order).
      name: "max_points",
      label: "Max points",
      type: "scalar",
      min: 1,
      max: 8000,
      softMax: 3000,
      step: 1,
      default: 3000,
    },
  ],
  primaryOutput: "points",
  auxOutputs: [{ name: "spline", type: "spline" }],

  compute({ inputs, params }) {
    const src = inputs.spline;
    const spline: SplineValue =
      src?.kind === "spline" ? src : { kind: "spline", subpaths: [] };

    const density = Math.max(0, Math.min(1, (params.density as number) ?? 1));
    const self = !!params.self_intersections;
    const minAngle = Math.max(0, (params.min_angle as number) ?? 0);
    const maxPoints = Math.max(1, Math.floor((params.max_points as number) ?? 3000));

    // Flatten every subpath, tagging each segment with its subpath index.
    const segs: Seg[] = [];
    for (let s = 0; s < spline.subpaths.length; s++) {
      flattenSubpath(spline.subpaths[s], s, segs);
    }

    // Collect crossings. AABB reject first; then the same/cross-subpath
    // gate; then the parametric test + angle filter. Same-subpath adjacent
    // segments share a vertex by construction, so skip them in self mode.
    const raw: { x: number; y: number }[] = [];
    const N = segs.length;
    for (let i = 0; i < N; i++) {
      const A = segs[i];
      for (let j = i + 1; j < N; j++) {
        const B = segs[j];
        if (A.maxX < B.minX || B.maxX < A.minX) continue;
        if (A.maxY < B.minY || B.maxY < A.minY) continue;
        if (A.sub === B.sub) {
          if (!self) continue;
          if (j === i + 1) continue; // adjacent — shared vertex, not a crossing
        }
        const pt = segIntersect(A, B);
        if (!pt) continue;
        if (minAngle > 0 && crossAngleDeg(A, B) < minAngle) continue;
        raw.push(pt);
      }
    }

    // Merge near-duplicate points (shared-vertex double hits) via a grid
    // bucket — same spatial-hash trick connect-points uses, sized to
    // MERGE_DIST so any duplicate lands in the same or a neighbor cell.
    const merged: { x: number; y: number }[] = [];
    const grid = new Map<string, number[]>();
    const cell = MERGE_DIST;
    const md2 = MERGE_DIST * MERGE_DIST;
    for (const p of raw) {
      const cx = Math.floor(p.x / cell);
      const cy = Math.floor(p.y / cell);
      let dup = false;
      check: for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const arr = grid.get(`${cx + dx}|${cy + dy}`);
          if (!arr) continue;
          for (const idx of arr) {
            const q = merged[idx];
            const ex = q.x - p.x;
            const ey = q.y - p.y;
            if (ex * ex + ey * ey <= md2) {
              dup = true;
              break check;
            }
          }
        }
      }
      if (dup) continue;
      const idx = merged.length;
      merged.push(p);
      const key = `${cx}|${cy}`;
      let arr = grid.get(key);
      if (!arr) {
        arr = [];
        grid.set(key, arr);
      }
      arr.push(idx);
    }

    // Even decimation by density, then the render cap.
    const step = density >= 1 ? 1 : Math.max(1, Math.round(1 / Math.max(density, 1e-6)));
    const out: Point[] = [];
    for (let i = 0; i < merged.length; i++) {
      if (i % step !== 0) continue;
      out.push({ pos: [merged[i].x, merged[i].y] });
      if (out.length >= maxPoints) break;
    }

    const points: PointsValue = pointsFromArray(out);
    // Pass the source spline through so a single wire carries both the
    // drawing and its intersection nodes.
    return { primary: points, aux: { spline } };
  },
};
