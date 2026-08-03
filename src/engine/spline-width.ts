// Variable-width stroke envelope (spec 072726_spline-animation-program.md
// M3). Each anchor may carry a `width` multiplier (absent = 1) on the
// consuming stroke's base thickness; this module turns a profiled subpath
// into a closed FILL polygon — the two offset sides of the path — so the
// Stroke node and the shared spline rasterizer can render tapered strokes.
//
// Sampling runs in CANVAS PX space (the same normalized→px mapping the
// rasterizer uses, applied to the ABSOLUTE control points — the mapping is
// affine per axis, so the mapped cubic is exact) for isotropic offsets on
// non-square canvases. Width interpolates smoothstep between anchors along
// each segment's own parameter. Open paths get round caps (matching the
// canvas stroke's round lineCap); closed paths become two opposite-winding
// rings — fill with the DEFAULT nonzero rule so the inner ring punches the
// hole and tight-corner self-overlaps stay solid.

import { Bezier } from "bezier-js";
import { aspectCorrectY } from "./aspect";
import { curveTangent } from "./spline-math";
import type { SplineSubpath } from "./types";

// Does this subpath carry a meaningful profile? (Consumers gate on this —
// unprofiled subpaths keep the plain canvas stroke.)
export function subpathHasWidthProfile(sub: SplineSubpath): boolean {
  return sub.anchors.some(
    (a) => a.width !== undefined && Math.abs(a.width - 1) > 1e-6
  );
}

export function splineHasWidthProfile(subpaths: SplineSubpath[]): boolean {
  return subpaths.some(subpathHasWidthProfile);
}

interface PxSegment {
  curve: Bezier;
  length: number;
  ia: number; // anchor index at the segment start
  ib: number; // anchor index at the segment end
}

// Segment cubics with ABSOLUTE control points mapped through the
// rasterizer's normalized→px mapping.
function subpathToPxSegments(
  sub: SplineSubpath,
  W: number,
  H: number
): PxSegment[] {
  const anchors = sub.anchors;
  const n = anchors.length;
  if (n < 2) return [];
  const aspect = W / H;
  const px = (p: [number, number]): [number, number] => [
    p[0] * W,
    aspectCorrectY(p[1], aspect) * H,
  ];
  const out: PxSegment[] = [];
  const seg = (ia: number, ib: number) => {
    const a = anchors[ia];
    const b = anchors[ib];
    const p0 = px(a.pos);
    const p1 = px(
      a.outHandle ? [a.pos[0] + a.outHandle[0], a.pos[1] + a.outHandle[1]] : a.pos
    );
    const p2 = px(
      b.inHandle ? [b.pos[0] + b.inHandle[0], b.pos[1] + b.inHandle[1]] : b.pos
    );
    const p3 = px(b.pos);
    const curve = new Bezier(p0[0], p0[1], p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
    let length: number;
    try {
      length = curve.length();
      if (!Number.isFinite(length) || length < 0) throw new Error();
    } catch {
      length = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
    }
    out.push({ curve, length, ia, ib });
  };
  for (let i = 0; i < n - 1; i++) seg(i, i + 1);
  if (sub.closed) seg(n - 1, 0);
  return out;
}

export interface WidthEnvelopePoints {
  // Offset sides, in path order, client-px space. For closed subpaths they
  // form two rings; for open ones the caller joins them with the caps.
  left: Array<[number, number]>;
  right: Array<[number, number]>;
  closed: boolean;
  // Endpoint data for the open-path round caps.
  startPos: [number, number];
  startTan: [number, number];
  startHalf: number;
  endPos: [number, number];
  endTan: [number, number];
  endHalf: number;
}

// Sample the envelope's two sides. Pure — Path2D assembly is split out so
// this half is testable off-browser. Null on degenerate input.
export function buildWidthEnvelopePoints(
  sub: SplineSubpath,
  W: number,
  H: number,
  thicknessPx: number
): WidthEnvelopePoints | null {
  if (thicknessPx <= 0) return null;
  const segs = subpathToPxSegments(sub, W, H);
  if (segs.length === 0) return null;
  const total = segs.reduce((s, x) => s + x.length, 0);
  if (total < 1e-3) return null;
  const widths = sub.anchors.map((a) => Math.max(0, a.width ?? 1));

  const left: Array<[number, number]> = [];
  const right: Array<[number, number]> = [];
  let startTan: [number, number] = [1, 0];
  let endTan: [number, number] = [1, 0];
  let startPos: [number, number] = [0, 0];
  let endPos: [number, number] = [0, 0];
  let startHalf = 0;
  let endHalf = 0;

  segs.forEach((s, si) => {
    const wa = widths[s.ia];
    const wb = widths[s.ib];
    // Sample density scales with arc length; every segment keeps enough
    // samples that curvature and the width ramp both read smoothly.
    const K = Math.max(8, Math.min(64, Math.ceil(s.length / 4)));
    const k0 = si === 0 ? 0 : 1; // segment joins share a sample
    for (let k = k0; k <= K; k++) {
      const t = k / K;
      const u = t * t * (3 - 2 * t); // smoothstep between anchor widths
      const w = wa + (wb - wa) * u;
      const p = s.curve.get(t);
      const tan = curveTangent(s.curve, t);
      const half = (thicknessPx * w) / 2;
      const nx = -tan[1];
      const ny = tan[0];
      left.push([p.x + nx * half, p.y + ny * half]);
      right.push([p.x - nx * half, p.y - ny * half]);
      if (si === 0 && k === k0) {
        startPos = [p.x, p.y];
        startTan = tan;
        startHalf = half;
      }
      if (si === segs.length - 1 && k === K) {
        endPos = [p.x, p.y];
        endTan = tan;
        endHalf = half;
      }
    }
  });
  if (left.length < 2) return null;
  return {
    left,
    right,
    closed: sub.closed,
    startPos,
    startTan,
    startHalf,
    endPos,
    endTan,
    endHalf,
  };
}

// Append a semicircular cap around `pos`: sweep from +normal to −normal
// through ±tangent. `dir` = +1 sweeps through the forward tangent (end cap),
// −1 through the reverse (start cap).
function capPoints(
  path: Path2D,
  pos: [number, number],
  tan: [number, number],
  half: number,
  dir: 1 | -1
) {
  const STEPS = 8;
  for (let j = 1; j < STEPS; j++) {
    const ang = (j / STEPS) * Math.PI;
    const c = Math.cos(ang);
    const sn = Math.sin(ang) * dir;
    const dx = -tan[1] * c + tan[0] * sn;
    const dy = tan[0] * c + tan[1] * sn;
    path.lineTo(pos[0] + dx * half, pos[1] + dy * half);
  }
}

// The envelope as a fillable Path2D (client-px space). Fill with the
// DEFAULT nonzero rule: closed subpaths emit two opposite-winding rings
// (the right side reversed) so the interior punches out, and tight-corner
// self-overlaps stay solid instead of even-odd flickering.
export function buildWidthEnvelopePath(
  sub: SplineSubpath,
  W: number,
  H: number,
  thicknessPx: number
): Path2D | null {
  const pts = buildWidthEnvelopePoints(sub, W, H, thicknessPx);
  if (!pts) return null;
  const path = new Path2D();
  const { left, right } = pts;
  if (pts.closed) {
    path.moveTo(left[0][0], left[0][1]);
    for (let i = 1; i < left.length; i++) path.lineTo(left[i][0], left[i][1]);
    path.closePath();
    const rl = right.length;
    path.moveTo(right[rl - 1][0], right[rl - 1][1]);
    for (let i = rl - 2; i >= 0; i--) path.lineTo(right[i][0], right[i][1]);
    path.closePath();
    return path;
  }
  path.moveTo(left[0][0], left[0][1]);
  for (let i = 1; i < left.length; i++) path.lineTo(left[i][0], left[i][1]);
  capPoints(path, pts.endPos, pts.endTan, pts.endHalf, 1);
  for (let i = right.length - 1; i >= 0; i--) {
    path.lineTo(right[i][0], right[i][1]);
  }
  capPoints(path, pts.startPos, [-pts.startTan[0], -pts.startTan[1]], pts.startHalf, 1);
  path.closePath();
  return path;
}
