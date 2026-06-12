// The published ESM build exposes everything on the default export (its
// `.d.ts` advertising named exports is misleading), so default-import the
// engine and pull the type names separately.
import polygonClipping from "polygon-clipping";
import type { MultiPolygon, Ring } from "polygon-clipping";
import type { SplineAnchor, SplineSubpath, SplineValue } from "./types";
import { subpathToBeziers } from "./spline-math";

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

// polygon-clipping rounds coordinates to a grid derived from their
// magnitude; [0,1] inputs sit right at the precision floor. Work in a
// scaled-up integer-ish space and divide back out on the way home.
const SCALE = 8192;

// Flatten one subpath into a closed ring of scaled [x,y] points. Open
// subpaths are treated as closed (fill semantics demand a region). `steps`
// line segments approximate each cubic — more = smoother, slower.
function subpathToRing(sub: SplineSubpath, steps: number): Ring {
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

function geomToSpline(geom: MultiPolygon): SplineValue {
  const tol = SCALE * 6e-5; // ≈ 0.5 scaled units
  const subpaths: SplineSubpath[] = [];
  for (const poly of geom) {
    for (const ring of poly) {
      const anchors = ringToAnchors(simplifyRing(ring, tol));
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
