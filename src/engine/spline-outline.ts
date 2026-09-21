// Stroke → silhouette. Sweep every subpath of a spline with a uniform
// thickness (times each anchor's `width` multiplier, same as the Rasterize
// Stroke envelope) and return the OUTLINE of the swept region as a closed
// polygonal spline — what Rasterize Stroke would paint, as geometry that
// can still feed Offset Path / Spline Boolean / Rasterize.
//
// Overlaps collapse: two subpaths crossing, a path folding back over
// itself, a tight corner whose inner offset loops — all resolve to one
// clean boundary. Closed subpaths keep their hole (a circle outlines to a
// ring), unlike Spline Merge's union which fills interiors.
//
// Construction. The sweep is built from simple pieces and UNIONED with
// polygon-clipping, which interprets self-crossing rings under the nonzero
// rule — exactly canvas stroking semantics:
//   - per bezier segment: one band ring (left offsets forward, right
//     offsets backward). Tangent-based offsets, so the ring self-crosses
//     where the curvature radius drops under the half-width; nonzero fills
//     that loop solid, like the canvas fill in spline-width.ts.
//   - per anchor between two segments (and the seam of a closed subpath):
//     a join piece — a disc (round), the outer triangle (bevel) or the
//     outer quad through the miter tip (miter, canvas miterLimit rule).
//   - per open end: a cap piece — a disc (round), a half-width extension
//     quad (square), or nothing (butt).
// Geometry runs in CANVAS PX space (aspect-corrected like the rasterizer,
// so circles stay round on non-square canvases) and is mapped back to
// canvas01 through the boolean engine's scaled coordinate space. Straight
// segments with a constant width are one quad; curves flatten to `steps`
// samples like Spline Boolean's `resolution`.

import polygonClipping from "polygon-clipping";
import type { MultiPolygon, Ring } from "polygon-clipping";
import { aspectUncorrectY } from "./aspect";
import { curveTangent } from "./spline-math";
import { SCALE, geomToSpline } from "./spline-boolean";
import { subpathToPxSegments, type PxSegment } from "./spline-width";
import type { SplineSubpath, SplineValue } from "./types";

export type OutlineCap = "round" | "butt" | "square";
export type OutlineJoin = "round" | "miter" | "bevel";

export interface OutlineOptions {
  // Full stroke thickness in canvas px (already units-resolved).
  thicknessPx: number;
  cap: OutlineCap;
  join: OutlineJoin;
  // Canvas semantics: ratio of the miter tip's distance from the corner to
  // the half-width; sharper joins than this bevel. Canvas default is 10.
  miterLimit: number;
  // Line segments per curved bezier segment.
  steps: number;
}

type Pt = [number, number];

const EMPTY: SplineValue = { kind: "spline", subpaths: [] };

// Smoothstep between anchor widths — the same ramp the width envelope
// uses, so a profiled stroke outlines to what Rasterize Stroke paints.
function widthAt(wa: number, wb: number, t: number): number {
  const u = t * t * (3 - 2 * t);
  return wa + (wb - wa) * u;
}

function isStraight(sub: SplineSubpath, seg: PxSegment): boolean {
  const a = sub.anchors[seg.ia];
  const b = sub.anchors[seg.ib];
  const zero = (h?: [number, number]) => !h || (h[0] === 0 && h[1] === 0);
  return zero(a.outHandle) && zero(b.inHandle);
}

// Polygon sides for a disc of radius r px: ~3 px of arc per side, clamped.
function discSides(r: number): number {
  return Math.max(12, Math.min(96, Math.ceil((2 * Math.PI * r) / 3)));
}

function disc(c: Pt, r: number): Pt[] {
  const n = discSides(r);
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]);
  }
  return out;
}

interface SegSamples {
  left: Pt[];
  right: Pt[];
  // Endpoint data for joins / caps.
  startPos: Pt;
  startTan: Pt;
  startHalf: number;
  endPos: Pt;
  endTan: Pt;
  endHalf: number;
}

function sampleSegment(
  sub: SplineSubpath,
  seg: PxSegment,
  widths: number[],
  thicknessPx: number,
  steps: number
): SegSamples | null {
  const wa = widths[seg.ia];
  const wb = widths[seg.ib];
  const straight = isStraight(sub, seg);
  const K = straight && Math.abs(wa - wb) < 1e-9 ? 1 : Math.max(1, steps);
  const left: Pt[] = [];
  const right: Pt[] = [];
  let startPos: Pt = [0, 0];
  let startTan: Pt = [1, 0];
  let startHalf = 0;
  let endPos: Pt = [0, 0];
  let endTan: Pt = [1, 0];
  let endHalf = 0;
  for (let k = 0; k <= K; k++) {
    const t = k / K;
    const p = seg.curve.get(t);
    const tan = curveTangent(seg.curve, t);
    const half = (thicknessPx * widthAt(wa, wb, t)) / 2;
    const nx = -tan[1];
    const ny = tan[0];
    left.push([p.x + nx * half, p.y + ny * half]);
    right.push([p.x - nx * half, p.y - ny * half]);
    if (k === 0) {
      startPos = [p.x, p.y];
      startTan = tan;
      startHalf = half;
    }
    if (k === K) {
      endPos = [p.x, p.y];
      endTan = tan;
      endHalf = half;
    }
  }
  if (left.length < 2) return null;
  return { left, right, startPos, startTan, startHalf, endPos, endTan, endHalf };
}

// Join piece where segment A ends and segment B begins at `c`. Returns
// null when the tangents are (near) collinear — the two bands already
// tile — or when the join would be degenerate.
function joinPiece(
  c: Pt,
  tanA: Pt,
  tanB: Pt,
  half: number,
  join: OutlineJoin,
  miterLimit: number
): Pt[] | null {
  if (half <= 1e-6) return null;
  const cross = tanA[0] * tanB[1] - tanA[1] * tanB[0];
  const dot = tanA[0] * tanB[0] + tanA[1] * tanB[1];
  const phi = Math.atan2(Math.abs(cross), dot); // turn angle, 0 = straight
  if (phi < 1e-3) return null;
  if (join === "round") return disc(c, half);
  // A full reversal has no outer side; the canvas draws nothing extra for
  // bevel/miter there either.
  if (phi > Math.PI - 1e-3) return null;
  // Left normal is (-ty, tx). A positive cross (turning toward the left
  // normal in Y-down screen space) puts the outer side on the RIGHT.
  const side = cross > 0 ? -1 : 1;
  const oa: Pt = [c[0] - tanA[1] * half * side, c[1] + tanA[0] * half * side];
  const ob: Pt = [c[0] - tanB[1] * half * side, c[1] + tanB[0] * half * side];
  if (join === "miter") {
    // Tip sits on the outer bisector at half / cos(phi/2); canvas bevels
    // when that ratio to the half-width exceeds miterLimit.
    const ratio = 1 / Math.cos(phi / 2);
    if (ratio <= miterLimit) {
      const bx = oa[0] - c[0] + (ob[0] - c[0]);
      const by = oa[1] - c[1] + (ob[1] - c[1]);
      const bm = Math.hypot(bx, by);
      if (bm > 1e-9) {
        const len = half * ratio;
        const tip: Pt = [c[0] + (bx / bm) * len, c[1] + (by / bm) * len];
        return [c, oa, tip, ob];
      }
    }
  }
  return [c, oa, ob];
}

// Cap piece at an open end. `out` is the unit direction pointing away
// from the path.
function capPiece(pos: Pt, out: Pt, half: number, cap: OutlineCap): Pt[] | null {
  if (half <= 1e-6 || cap === "butt") return null;
  if (cap === "round") return disc(pos, half);
  const nx = -out[1];
  const ny = out[0];
  return [
    [pos[0] + nx * half, pos[1] + ny * half],
    [pos[0] + nx * half + out[0] * half, pos[1] + ny * half + out[1] * half],
    [pos[0] - nx * half + out[0] * half, pos[1] - ny * half + out[1] * half],
    [pos[0] - nx * half, pos[1] - ny * half],
  ];
}

// All sweep pieces for one subpath, in canvas px.
function subpathPieces(
  sub: SplineSubpath,
  W: number,
  H: number,
  opts: OutlineOptions
): Pt[][] {
  const segs = subpathToPxSegments(sub, W, H);
  if (segs.length === 0) return [];
  const widths = sub.anchors.map((a) => Math.max(0, a.width ?? 1));
  const samples = segs.map((s) =>
    sampleSegment(sub, s, widths, opts.thicknessPx, opts.steps)
  );
  const pieces: Pt[][] = [];
  for (const s of samples) {
    if (!s) continue;
    // One self-crossing-tolerant ring: left side forward, right side back.
    pieces.push([...s.left, ...s.right.slice().reverse()]);
  }
  // Joins between consecutive segments (+ the seam when closed).
  const n = samples.length;
  const joinCount = sub.closed ? n : n - 1;
  for (let i = 0; i < joinCount; i++) {
    const a = samples[i];
    const b = samples[(i + 1) % n];
    if (!a || !b) continue;
    const piece = joinPiece(
      a.endPos,
      a.endTan,
      b.startTan,
      a.endHalf,
      opts.join,
      opts.miterLimit
    );
    if (piece) pieces.push(piece);
  }
  if (!sub.closed) {
    const first = samples.find((s) => s != null);
    const last = [...samples].reverse().find((s) => s != null);
    if (first) {
      const p = capPiece(
        first.startPos,
        [-first.startTan[0], -first.startTan[1]],
        first.startHalf,
        opts.cap
      );
      if (p) pieces.push(p);
    }
    if (last) {
      const p = capPiece(last.endPos, last.endTan, last.endHalf, opts.cap);
      if (p) pieces.push(p);
    }
  }
  return pieces;
}

// px → canvas01 → the boolean engine's scaled integer-ish space.
function toScaledRing(pts: Pt[], W: number, H: number): Ring {
  const aspect = W / H;
  return pts.map(
    (p) => [(p[0] / W) * SCALE, aspectUncorrectY(p[1] / H, aspect) * SCALE] as [
      number,
      number,
    ]
  );
}

// Outline `spline` stroked at `opts.thicknessPx` on a W×H canvas. Returns
// a closed polygonal spline (holes as separate rings, even-odd) or an
// empty spline when nothing would be painted.
export function outlineSpline(
  spline: SplineValue,
  W: number,
  H: number,
  opts: OutlineOptions
): SplineValue {
  if (!(opts.thicknessPx > 0)) return EMPTY;
  const w = Math.max(1, W);
  const h = Math.max(1, H);
  const rings: Ring[] = [];
  for (const sub of spline.subpaths) {
    if (sub.anchors.length < 2) continue;
    for (const piece of subpathPieces(sub, w, h, opts)) {
      if (piece.length >= 3) rings.push(toScaledRing(piece, w, h));
    }
  }
  if (rings.length === 0) return EMPTY;
  const geoms = rings.map((r) => [r] as [Ring]);
  const [first, ...rest] = geoms;
  let result: MultiPolygon;
  try {
    result = polygonClipping.union(first, ...rest);
  } catch {
    // polygon-clipping can throw on pathological near-degenerate input;
    // an empty frame beats a crashed evaluator.
    return EMPTY;
  }
  return geomToSpline(result);
}
