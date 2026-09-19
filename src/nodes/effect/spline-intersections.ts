import type {
  NodeDefinition,
  Point,
  PointsValue,
  SplineValue,
} from "@/engine/types";
import { subpathToBeziers } from "@/engine/spline-math";
import { pointsFromArray } from "@/engine/points";
import { hash01 } from "@/engine/spline-color-source";

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
// Orientation (`align`): every crossing is made by exactly two segments, so
// each point can carry the tangent or normal of one of them in `rotation`
// (same baked-angle convention as Points on Path — Copy to Points reads it
// with no extra wiring). Which of the two crossing splines supplies the
// direction is the `pick` mode: `alternating` walks A, B, A, B over the
// emitted points; `random` flips a seeded per-point coin. "A" is the
// segment discovered first — the lower subpath index, or in self mode the
// earlier stretch of the same path.
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

// One crossing: its position plus the direction angle (radians, atan2 in
// canvas01 Y-down — the same frame Points on Path bakes) of each of the two
// segments that made it. `ta` is segment A (discovered first: lower subpath
// index, or the earlier stretch of the path in self mode), `tb` segment B.
interface Crossing {
  x: number;
  y: number;
  ta: number;
  tb: number;
}

// Direction of travel along a flattened segment, as an angle.
function segAngle(s: Seg): number {
  return Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
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
    "Emit a point at every crossing of the input spline's segments — the 'nodes at intersections' construction-drawing look. Feed the output into Copy to Points to stamp a marker at each crossing. By default only segments from different subpaths are tested (so a cluster of shapes + lines marks line×shape and line×line crossings); enable Self-intersections for self-crossing polylines. Align to spline bakes each point's rotation from the tangent or normal of one of the two splines that cross there — Pick spline chooses which: Alternating takes them in turn from point to point, Random flips a seeded coin per point. The original spline passes through on the aux output so one wire carries both the drawing and its nodes.",
  facts: {
    writes: ["attr:rotation"],
    gotchas: [
      "By default only segments from different subpaths are tested; self_intersections adds within-subpath tests but skips adjacent segments (they share a construction vertex, not a crossing).",
      "Curves are flattened to polylines first (16 steps per curved cubic, 1 for a straight 2-anchor subpath), so a crossing inside a tight curve can be missed between sample steps.",
      "density thins evenly by taking every Nth crossing (step = round(1/density)), not a random subset; max_points then caps the result in discovery order.",
      "min_angle drops glancing crossings below that angle between the two segments' directions.",
      "Near-duplicate crossings from shared flattened vertices are merged within 1e-4 of spline coordinate units.",
      "align=tangent/normal writes attr:rotation (radians) from one of the two crossing segments' directions plus align_offset degrees; normal is tangent+90°; align=off leaves rotation unset.",
      "pick=alternating uses segment A (lower subpath index; in self mode the earlier stretch) on even emitted indices and B on odd; pick=random is a seeded per-point coin keyed by emitted index.",
    ],
  },
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
    {
      // Bake a per-point orientation into `rotation` from one of the two
      // crossing segments' directions — `tangent` = its angle of travel,
      // `normal` = perpendicular (+90°). `off` leaves rotation unset
      // (back-compat: older saves emit exactly the points they did before).
      // Same vocabulary and convention as Points on Path's Align to path.
      name: "align",
      label: "Align to spline",
      type: "enum",
      options: ["off", "tangent", "normal"],
      control: "segmented",
      default: "off",
    },
    {
      // Which of the two splines meeting at a crossing supplies the
      // direction. `alternating`: A, B, A, B over the emitted points, so
      // adjacent markers face along different splines. `random`: a seeded
      // per-point coin flip (index-stable — a static drawing keeps its
      // assignment; `seed` reshuffles it).
      name: "pick",
      label: "Pick spline",
      type: "enum",
      options: ["alternating", "random"],
      control: "segmented",
      default: "alternating",
      visibleIf: (p) => p.align !== "off",
    },
    {
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 10000,
      step: 1,
      default: 1,
      visibleIf: (p) => p.align !== "off" && p.pick === "random",
    },
    {
      // Extra spin on top of the aligned angle (degrees) — flip a normal
      // 180° or nudge the facing. Hidden when not aligning.
      name: "align_offset",
      label: "Angle offset",
      type: "scalar",
      min: -180,
      max: 180,
      step: 1,
      default: 0,
      visibleIf: (p) => p.align !== "off",
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
    const align = (params.align as string) ?? "off";
    const pick = (params.pick as string) ?? "alternating";
    const seed = Math.floor((params.seed as number) ?? 1);
    const alignOffsetRad = (((params.align_offset as number) ?? 0) * Math.PI) / 180;
    // Normal = tangent turned +90°, matching Points on Path.
    const normalTurn = align === "normal" ? Math.PI / 2 : 0;

    // Flatten every subpath, tagging each segment with its subpath index.
    const segs: Seg[] = [];
    for (let s = 0; s < spline.subpaths.length; s++) {
      flattenSubpath(spline.subpaths[s], s, segs);
    }

    // Collect crossings. AABB reject first; then the same/cross-subpath
    // gate; then the parametric test + angle filter. Same-subpath adjacent
    // segments share a vertex by construction, so skip them in self mode.
    const raw: Crossing[] = [];
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
        raw.push({ x: pt.x, y: pt.y, ta: segAngle(A), tb: segAngle(B) });
      }
    }

    // Merge near-duplicate points (shared-vertex double hits) via a grid
    // bucket — same spatial-hash trick connect-points uses, sized to
    // MERGE_DIST so any duplicate lands in the same or a neighbor cell.
    const merged: Crossing[] = [];
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

    // Even decimation by density, then the render cap. With `align` on, the
    // pick runs over the EMITTED index (after decimation), so the A/B
    // pattern reads as strictly alternating in the output and the random
    // assignment is keyed to the points that actually exist.
    const step = density >= 1 ? 1 : Math.max(1, Math.round(1 / Math.max(density, 1e-6)));
    const out: Point[] = [];
    for (let i = 0; i < merged.length; i++) {
      if (i % step !== 0) continue;
      const c = merged[i];
      const p: Point = { pos: [c.x, c.y] };
      if (align !== "off") {
        const k = out.length;
        const useB =
          pick === "random" ? hash01(k, seed) < 0.5 : (k & 1) === 1;
        p.rotation = (useB ? c.tb : c.ta) + normalTurn + alignOffsetRad;
      }
      out.push(p);
      if (out.length >= maxPoints) break;
    }

    const points: PointsValue = pointsFromArray(out);
    // Pass the source spline through so a single wire carries both the
    // drawing and its intersection nodes.
    return { primary: points, aux: { spline } };
  },
};
