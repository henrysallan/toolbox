// The published ESM build exposes everything on the default export (its
// `.d.ts` advertising named exports is misleading), so default-import the
// engine and pull the type names separately.
import polygonClipping from "polygon-clipping";
import type { MultiPolygon, Ring } from "polygon-clipping";
import type { Bezier } from "bezier-js";
import type { SplineAnchor, SplineSubpath, SplineValue } from "./types";
import { subpathToBeziers } from "./spline-math";
import { cubicsToSubpath } from "./spline-trim";

// Geometric boolean operations on splines. Splines are bezier paths in
// [0,1]² Y-DOWN; a "boolean" only makes sense on the filled REGIONS they
// enclose, so we flatten each subpath into a polygon ring, hand the rings
// to a polygon-clipping engine, and convert the resulting rings back into
// (polygonal) spline subpaths.
//
// Intra-spline subpaths are combined with XOR before the op runs — that
// matches the even-odd fill rule the rest of the app rasterizes splines
// with (nested subpaths punch holes, e.g. the centre of an "O"), so what
// you subtract is exactly what you see filled.

export type SplineBooleanOp = "subtract" | "union" | "intersect" | "exclude";

// Self-combine op for a single spline's own subpaths (Spline Merge). Unlike
// the A/B boolean above, this reduces all subpaths of ONE spline together.
export type SplineMergeOp = "union" | "intersect" | "exclude";

// polygon-clipping rounds coordinates to a grid derived from their
// magnitude; [0,1] inputs sit right at the precision floor. Work in a
// scaled-up integer-ish space and divide back out on the way home.
// (Exported for spline-planar.ts — the Shape Builder face machinery works
// in the same scaled space.)
export const SCALE = 8192;

// Flatten one subpath into a closed ring of scaled [x,y] points. Open
// subpaths are treated as closed (fill semantics demand a region). `steps`
// line segments approximate each cubic — more = smoother, slower.
// (Exported for spline-planar.ts.)
export function subpathToRing(sub: SplineSubpath, steps: number): Ring {
  const segs = subpathToBeziers({ ...sub, closed: true });
  if (segs.length === 0) return [];
  const ring: Ring = [];
  for (const seg of segs) {
    const lut = seg.curve.getLUT(Math.max(2, steps));
    // Skip each segment's final point — it coincides with the next
    // segment's first (and the very last with the ring start), so this
    // yields a clean ring with no zero-length edges.
    for (let i = 0; i < lut.length - 1; i++) {
      ring.push([lut[i].x * SCALE, lut[i].y * SCALE]);
    }
  }
  return ring;
}

// A spline's filled region as a clean MultiPolygon. Each subpath becomes
// its own polygon and they're XOR-combined so even-odd holes survive.
function splineToGeom(spline: SplineValue, steps: number): MultiPolygon {
  const rings = spline.subpaths
    .filter((s) => s.anchors.length >= 2)
    .map((s) => subpathToRing(s, steps))
    .filter((r) => r.length >= 3);
  if (rings.length === 0) return [];
  // `xor` self-cleans each polygon (resolves self-intersections) and
  // applies even-odd between them. A single ring just comes back tidied.
  // First arg is required (non-rest), so split it off the spread.
  const geoms = rings.map((r) => [r] as [Ring]);
  return polygonClipping.xor(geoms[0], ...geoms.slice(1));
}

// Perpendicular distance of p from the line a→b, in scaled units.
function pointLineDist(
  p: [number, number],
  a: [number, number],
  b: [number, number]
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
}

// Drop vertices that sit (nearly) on the line between their neighbours.
// Boolean cuts introduce long straight runs of densely-sampled points;
// this keeps real curvature while shedding the redundant collinear ones.
function simplifyRing(ring: Ring, tol: number): Ring {
  const n = ring.length;
  if (n <= 4) return ring;
  const keep: boolean[] = new Array(n).fill(true);
  for (let i = 0; i < n; i++) {
    const prev = ring[(i - 1 + n) % n];
    const cur = ring[i];
    const next = ring[(i + 1) % n];
    if (pointLineDist(cur, prev, next) < tol) keep[i] = false;
  }
  const out: Ring = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(ring[i]);
  return out.length >= 3 ? out : ring;
}

// Ring (scaled, possibly explicitly closed) → straight-segment anchors in
// [0,1]². polygon-clipping closes rings, so a trailing duplicate of the
// first point is dropped.
function ringToAnchors(ring: Ring): SplineAnchor[] {
  let pts = ring;
  if (pts.length > 1) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) {
      pts = pts.slice(0, -1);
    }
  }
  return pts.map((p) => ({ pos: [p[0] / SCALE, p[1] / SCALE] }) as SplineAnchor);
}

// (Exported for spline-planar.ts.)
export function geomToSpline(geom: MultiPolygon): SplineValue {
  const tol = SCALE * 6e-5; // ≈ 0.5 scaled units
  const subpaths: SplineSubpath[] = [];
  for (const poly of geom) {
    for (const ring of poly) {
      // Strip polygon-clipping's closing duplicate BEFORE the cyclic
      // collinear cull. With the duplicate present, BOTH copies of the seam
      // vertex sit at zero distance from a neighbor line (each has itself
      // as a neighbor) and simplifyRing culled both — eating a genuine
      // corner whenever the ring's seam landed on one, which it always does
      // for crisp shapes (a boolean of two rectangles came back with a
      // clipped corner). ringToAnchors' own dedupe then no-ops.
      let open = ring;
      if (open.length > 1) {
        const a = open[0];
        const b = open[open.length - 1];
        if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) {
          open = open.slice(0, -1);
        }
      }
      const anchors = ringToAnchors(simplifyRing(open, tol));
      if (anchors.length >= 3) subpaths.push({ anchors, closed: true });
    }
  }
  return { kind: "spline", subpaths };
}

// Run a boolean op on two splines and return the resulting (polygonal)
// spline. Empty-input cases are handled explicitly so the clipping engine
// never sees a degenerate geometry.
export function splineBoolean(
  a: SplineValue,
  b: SplineValue,
  op: SplineBooleanOp,
  steps: number
): SplineValue {
  const geomA = splineToGeom(a, steps);
  const geomB = splineToGeom(b, steps);
  const emptyA = geomA.length === 0;
  const emptyB = geomB.length === 0;

  let result: MultiPolygon;
  switch (op) {
    case "subtract":
      result = emptyA ? [] : emptyB ? geomA : polygonClipping.difference(geomA, geomB);
      break;
    case "union":
      result = emptyA ? geomB : emptyB ? geomA : polygonClipping.union(geomA, geomB);
      break;
    case "intersect":
      result = emptyA || emptyB ? [] : polygonClipping.intersection(geomA, geomB);
      break;
    case "exclude":
      result = emptyA ? geomB : emptyB ? geomA : polygonClipping.xor(geomA, geomB);
      break;
    default:
      result = [];
  }
  return geomToSpline(result);
}

// Self-combine ALL subpaths of a single spline under one op and return the
// resulting (polygonal) spline. This is the difference from `splineToGeom`,
// which XORs subpaths together (even-odd fill): here `union` reduces every
// subpath's filled region into a true merged silhouette (overlaps disappear
// instead of punching even-odd holes), so a stroke of the result traces one
// clean outer outline. `intersect` keeps only the region common to all
// subpaths; `exclude` is the even-odd XOR (i.e. the old splineToGeom
// behavior, exposed as an op).
//
// Caveat: every subpath is treated as a solid region, so holes inside a
// single instance (e.g. the centre of an "O") fill in under `union`. That's
// the intended silhouette behavior for scattered/copied shapes.
export function splineSelfMerge(
  spline: SplineValue,
  op: SplineMergeOp,
  steps: number
): SplineValue {
  const rings = spline.subpaths
    .filter((s) => s.anchors.length >= 2)
    .map((s) => subpathToRing(s, steps))
    .filter((r) => r.length >= 3);
  if (rings.length === 0) return { kind: "spline", subpaths: [] };

  // Each subpath becomes its own single-ring polygon; combine them all.
  // First arg is required (non-rest), so split it off the spread — same
  // shape as splineToGeom's xor call.
  const geoms = rings.map((r) => [r] as [Ring]);
  const [first, ...rest] = geoms;
  let result: MultiPolygon;
  switch (op) {
    case "intersect":
      // A single subpath just self-cleans; two or more intersect down.
      result = polygonClipping.intersection(first, ...rest);
      break;
    case "exclude":
      result = polygonClipping.xor(first, ...rest);
      break;
    case "union":
    default:
      // union() with no rest self-cleans a lone ring (resolves
      // self-intersections), matching splineToGeom's single-ring path.
      result = polygonClipping.union(first, ...rest);
      break;
  }
  return geomToSpline(result);
}

// ---------------------------------------------------------------------------
// Line mode ("Treat A as: line") — clip a spline's CURVES by another
// spline's filled region. Unlike the area booleans above, the subject is
// not a region: each subpath is cut where it crosses the cutter's boundary
// and only the pieces on the requested side survive — gaps in the stroke,
// not cutouts in the fill. Kept geometry stays TRUE BEZIER: crossings are
// found on the flattened curve (same `steps` resolution as the area path)
// but the ORIGINAL cubics are split at the crossing parameters. Closed
// subpaths that get cut become open arcs — the piece running through the
// closed seam is stitched continuous (one arc, no cap break); untouched
// subpaths pass through by reference; groupIndex tags survive. Each piece
// is classified by its own midpoint (even-odd, so cutter holes behave),
// which keeps tangential grazes from flipping everything downstream.
// ---------------------------------------------------------------------------

interface ClipEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// All boundary edges of a MultiPolygon (scaled coords). polygon-clipping
// rings may or may not repeat the first point — normalize either way.
function geomEdges(geom: MultiPolygon): ClipEdge[] {
  const edges: ClipEdge[] = [];
  for (const poly of geom) {
    for (const ring of poly) {
      let n = ring.length;
      if (n < 3) continue;
      const a0 = ring[0];
      const aN = ring[n - 1];
      if (Math.abs(a0[0] - aN[0]) < 1e-9 && Math.abs(a0[1] - aN[1]) < 1e-9) n--;
      for (let i = 0; i < n; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % n];
        if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) continue;
        edges.push({
          x1: a[0],
          y1: a[1],
          x2: b[0],
          y2: b[1],
          minX: Math.min(a[0], b[0]),
          minY: Math.min(a[1], b[1]),
          maxX: Math.max(a[0], b[0]),
          maxY: Math.max(a[1], b[1]),
        });
      }
    }
  }
  return edges;
}

// Even-odd point-in-region over every ring of the MultiPolygon (scaled
// coords). Counting across outer rings AND holes together IS the even-odd
// rule, so holes read as outside. (Exported for spline-planar.ts.)
export function pointInGeom(geom: MultiPolygon, x: number, y: number): boolean {
  let inside = false;
  for (const poly of geom) {
    for (const ring of poly) {
      const n = ring.length;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const yi = ring[i][1];
        const yj = ring[j][1];
        if (yi > y === yj > y) continue;
        const xCross =
          ring[j][0] + ((y - yj) / (yi - yj)) * (ring[i][0] - ring[j][0]);
        if (x < xCross) inside = !inside;
      }
    }
  }
  return inside;
}

// Intersection parameter of the sub-segment (ax,ay)→(bx,by) with `e`, as
// u ∈ [0,1] along the sub-segment — or null when they miss.
function subSegHit(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  e: ClipEdge
): number | null {
  const den = (ax - bx) * (e.y1 - e.y2) - (ay - by) * (e.x1 - e.x2);
  if (Math.abs(den) < 1e-12) return null;
  const t = ((ax - e.x1) * (e.y1 - e.y2) - (ay - e.y1) * (e.x1 - e.x2)) / den;
  const u = ((ax - e.x1) * (ay - by) - (ay - e.y1) * (ax - bx)) / den;
  const eps = 1e-9;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
  return Math.max(0, Math.min(1, t));
}

// Clip `subject`'s curves by `cutter`'s filled region, keeping the pieces
// on the given side. Returns the subject unchanged (same object) when the
// cutter is empty and we keep the outside.
export function clipSplineByRegion(
  subject: SplineValue,
  cutter: SplineValue,
  keep: "outside" | "inside",
  steps: number
): SplineValue {
  if (subject.subpaths.length === 0) return subject;
  const geom = splineToGeom(cutter, steps);
  if (geom.length === 0) {
    return keep === "outside" ? subject : { kind: "spline", subpaths: [] };
  }
  const edges = geomEdges(geom);
  const lutN = Math.max(2, steps);

  const out: SplineSubpath[] = [];
  const keepPiece = (inside: boolean) =>
    keep === "inside" ? inside : !inside;

  for (const sub of subject.subpaths) {
    const segs = subpathToBeziers(sub);
    const segCount = segs.length;
    if (segCount === 0) continue;

    // Global crossing parameters g ∈ (0, segCount): cubic index + local t.
    const cuts: number[] = [];
    for (let si = 0; si < segCount; si++) {
      const lut = segs[si].curve.getLUT(lutN);
      // Cubic-level AABB quick-reject against each edge.
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of lut) {
        const sx = p.x * SCALE;
        const sy = p.y * SCALE;
        if (sx < minX) minX = sx;
        if (sy < minY) minY = sy;
        if (sx > maxX) maxX = sx;
        if (sy > maxY) maxY = sy;
      }
      for (const e of edges) {
        if (e.minX > maxX || e.maxX < minX || e.minY > maxY || e.maxY < minY) {
          continue;
        }
        for (let k = 0; k < lut.length - 1; k++) {
          const u = subSegHit(
            lut[k].x * SCALE,
            lut[k].y * SCALE,
            lut[k + 1].x * SCALE,
            lut[k + 1].y * SCALE,
            e
          );
          if (u === null) continue;
          const g = si + (k + u) / (lut.length - 1);
          if (g > 1e-6 && g < segCount - 1e-6) cuts.push(g);
        }
      }
    }
    cuts.sort((a, b) => a - b);
    // Dedupe near-identical crossings (a hit at a LUT vertex registers on
    // both adjacent sub-segments; a hit at a shared ring vertex on both
    // edges). Precision is ~1/steps anyway; each piece's midpoint test is
    // authoritative, so merging near-cuts only drops sliver pieces.
    const unique: number[] = [];
    for (const g of cuts) {
      if (unique.length === 0 || g - unique[unique.length - 1] > 1e-3) {
        unique.push(g);
      }
    }

    const midOf = (g: number): boolean => {
      const gi = Math.min(segCount - 1, Math.floor(g % segCount));
      const t = (g % segCount) - gi;
      const p = segs[gi].curve.get(t);
      return pointInGeom(geom, p.x * SCALE, p.y * SCALE);
    };

    if (unique.length === 0) {
      // No crossings — the whole subpath is on one side. Keep by reference
      // (closed flag + handles intact).
      if (keepPiece(midOf(segCount / 2))) out.push(sub);
      continue;
    }

    // Spans between consecutive cuts. Closed subpaths wrap: the last span
    // continues through the seam into the first (one continuous arc).
    const spans: Array<[number, number]> = [];
    if (sub.closed) {
      for (let i = 0; i < unique.length; i++) {
        const ga = unique[i];
        const gb = i + 1 < unique.length ? unique[i + 1] : segCount + unique[0];
        spans.push([ga, gb]);
      }
    } else {
      spans.push([0, unique[0]]);
      for (let i = 0; i + 1 < unique.length; i++) {
        spans.push([unique[i], unique[i + 1]]);
      }
      spans.push([unique[unique.length - 1], segCount]);
    }

    for (const [ga, gb] of spans) {
      if (gb - ga <= 1e-6) continue;
      if (!keepPiece(midOf((ga + gb) / 2))) continue;
      // Original cubics split at the span ends; whole cubics pass as-is.
      const curves: Bezier[] = [];
      for (let gi = Math.floor(ga); gi < gb - 1e-9; gi++) {
        const idx = gi % segCount;
        const lo = Math.max(0, ga - gi);
        const hi = Math.min(1, gb - gi);
        if (hi - lo <= 1e-6) continue;
        curves.push(
          lo <= 1e-9 && hi >= 1 - 1e-9
            ? segs[idx].curve
            : segs[idx].curve.split(lo, hi)
        );
      }
      const piece = cubicsToSubpath(curves);
      if (piece && piece.anchors.length >= 2) {
        if (sub.groupIndex !== undefined) piece.groupIndex = sub.groupIndex;
        out.push(piece);
      }
    }
  }

  return { kind: "spline", subpaths: out };
}
