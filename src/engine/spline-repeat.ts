import type { SplineAnchor, SplineSubpath } from "./types";
import { offsetSubpath } from "./spline-math";
import { type CurvePoint, sampleFloatCurve } from "./float-curve";

// Multi-stroke offset engine, shared by the Repeat Path node (spline→spline)
// and the Stroke node's Repeats section (spec: 071226_multi-stroke.md).
//
// Fixed-band model: `count` strokes span a band of total `width`; stroke i
// sits at offset `width × spacingCurve(i/(count−1))`. The default linear
// curve starts at (0,0), so stroke 0 lies exactly on the source path and an
// identity curve gives even spacing.
//
// Offsets are computed in CANVAS-PIXEL space — anchors scale by (W, H),
// offset by `width × curve(t) × W` px, scale back — so rings stay uniformly
// spaced on non-square canvases. The distance unit is therefore canvas-
// width-relative (0.02 = 2% of canvas width in every direction), matching
// the SDF compiler's `u_aspectCorrect` convention.
//
// Direction semantics: for CLOSED subpaths the winding is normalized via
// the shoelace signed area so `outer` always expands and `inner` always
// contracts, regardless of authoring direction. OPEN subpaths have no
// interior — inner/outer degrade to side-of-travel (inner = left, outer =
// right). `both` mirrors every non-zero offset to both sides (count is
// strokes per side; an offset-0 stroke is emitted once).

export type RepeatDirection = "outer" | "inner" | "both";

export interface RepeatStrokeOpts {
  count: number; // total strokes incl. the base (≥1); per side for `both`
  direction: RepeatDirection;
  width: number; // normalized band width (canvas-width fraction)
  spacingCurve: CurvePoint[];
  widthPx: number;
  heightPx: number;
}

// One ring of the multi-stroke. `t` is the normalized repeat index
// (i/(count−1), 0 when count === 1) — the Stroke node feeds it to its
// styling curves/ramp. Rings are ordered by t ascending (base → band edge),
// so a rasterizer drawing in order paints later repeats on top.
export interface RepeatStroke {
  t: number;
  subpaths: SplineSubpath[];
}

function scaleAnchor(a: SplineAnchor, sx: number, sy: number): SplineAnchor {
  const out: SplineAnchor = { ...a, pos: [a.pos[0] * sx, a.pos[1] * sy] };
  if (a.inHandle) out.inHandle = [a.inHandle[0] * sx, a.inHandle[1] * sy];
  if (a.outHandle) out.outHandle = [a.outHandle[0] * sx, a.outHandle[1] * sy];
  return out;
}

function scaleSubpath(
  sub: SplineSubpath,
  sx: number,
  sy: number
): SplineSubpath {
  return {
    ...sub,
    anchors: sub.anchors.map((a) => scaleAnchor(a, sx, sy)),
  };
}

// Point on the cubic from anchor a to anchor b at parameter t. Handles are
// offsets from their anchor; a missing handle collapses the control point
// onto the anchor (straight line) — same convention as subpathToBeziers.
function cubicPointAt(
  a: SplineAnchor,
  b: SplineAnchor,
  t: number
): [number, number] {
  const p0x = a.pos[0];
  const p0y = a.pos[1];
  const c1x = a.outHandle ? p0x + a.outHandle[0] : p0x;
  const c1y = a.outHandle ? p0y + a.outHandle[1] : p0y;
  const p3x = b.pos[0];
  const p3y = b.pos[1];
  const c2x = b.inHandle ? p3x + b.inHandle[0] : p3x;
  const c2y = b.inHandle ? p3y + b.inHandle[1] : p3y;
  const u = 1 - t;
  const uu = u * u;
  const tt = t * t;
  return [
    uu * u * p0x + 3 * uu * t * c1x + 3 * u * tt * c2x + tt * t * p3x,
    uu * u * p0y + 3 * uu * t * c1y + 3 * u * tt * c2y + tt * t * p3y,
  ];
}

// Shoelace signed area of a closed subpath, sampled at each anchor plus each
// segment's cubic midpoint (anchors alone mis-handle 2-anchor closed shapes,
// where the polygon degenerates to a zero-area line). Only the SIGN is used.
export function subpathSignedArea(sub: SplineSubpath): number {
  const anchors = sub.anchors;
  const n = anchors.length;
  if (n < 2) return 0;
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = anchors[i];
    const b = anchors[(i + 1) % n];
    pts.push(a.pos);
    if (i < n - 1 || sub.closed) pts.push(cubicPointAt(a, b, 0.5));
  }
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    area += p[0] * q[1] - q[0] * p[1];
  }
  return area / 2;
}

// Offset every subpath by `distancePx` (in pixel space), winding-normalized
// so a positive distance always EXPANDS closed subpaths (and offsets open
// ones to the right of travel). Subpaths that degenerate under the offset
// are dropped.
function offsetSubpathsPx(
  scaled: { sub: SplineSubpath; expandSign: number }[],
  distancePx: number,
  sx: number,
  sy: number
): SplineSubpath[] {
  const out: SplineSubpath[] = [];
  for (const { sub, expandSign } of scaled) {
    const off = offsetSubpath(sub, distancePx * expandSign);
    if (!off) continue;
    // Scale back to normalized space, re-carrying the source subpath's
    // non-geometry fields (groupIndex tags survive the round-trip).
    out.push({ ...sub, ...scaleSubpath(off, 1 / sx, 1 / sy) });
  }
  return out;
}

export function buildRepeatStrokes(
  subpaths: SplineSubpath[],
  opts: RepeatStrokeOpts
): RepeatStroke[] {
  const count = Math.max(1, Math.round(opts.count));
  const sx = Math.max(1, opts.widthPx);
  const sy = Math.max(1, opts.heightPx);
  const bandPx = opts.width * sx;

  // Pre-scale once; per-subpath expand sign from the winding (closed) or
  // the side-of-travel convention (open: +1 = right of travel).
  const scaled = subpaths
    .filter((s) => s.anchors.length >= 2)
    .map((sub) => ({
      sub: scaleSubpath(sub, sx, sy),
      expandSign:
        sub.closed && subpathSignedArea(sub) > 0 ? -1 : 1,
    }));
  if (scaled.length === 0) return [];

  const strokes: RepeatStroke[] = [];
  const emit = (t: number, distancePx: number) => {
    if (distancePx === 0) {
      // Identity ring — return the ORIGINAL subpaths untouched (no px
      // round-trip), so a static base path keeps value identity.
      strokes.push({
        t,
        subpaths: subpaths.filter((s) => s.anchors.length >= 2),
      });
      return;
    }
    const offs = offsetSubpathsPx(scaled, distancePx, sx, sy);
    if (offs.length > 0) strokes.push({ t, subpaths: offs });
  };

  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    const curved = sampleFloatCurve(opts.spacingCurve, t);
    const d = bandPx * curved;
    if (opts.direction === "both") {
      if (d === 0) emit(t, 0);
      else {
        emit(t, -d);
        emit(t, d);
      }
    } else {
      emit(t, opts.direction === "inner" ? -d : d);
    }
  }
  return strokes;
}
