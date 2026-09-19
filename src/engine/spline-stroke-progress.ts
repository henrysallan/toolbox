import {
  makeColorRampSampler,
  rgba01ToCss,
  type ColorRampInterp,
  type ColorRampSpace,
  type ColorRampStop,
} from "./color-ramp";
import {
  buildWidthEnvelopePoints,
  sampleSubpathPolylinePx,
  subpathHasWidthProfile,
} from "./spline-width";
import type { SplineSubpath } from "./types";

// Along-path stroke coloring for Rasterize Spline / Stroke `ramp_by:
// progress` and `attribute`. Canvas2D has no native "gradient along a
// path" — a linear gradient is a spatial axis (the existing `position`
// mode) — so we flatten each subpath and paint short pieces, each with
// a linear gradient from color(t) to color(t+dt) along that chord.
// Default t is arc length of THAT subpath, 0 at its start / 1 at its
// end. `tAt` remaps that to an interpolated named channel.
//
// Profiled subpaths fill envelope quads (same tessellation as the
// variable-width renderer) so the taper and the color ramp share a
// sampling. Unprofiled subpaths keep a real canvas stroke so dashes
// and caps still apply; lineDashOffset continues the pattern across
// pieces.

export interface StrokeProgressOpts {
  W: number;
  H: number;
  thicknessPx: number;
  stops: ColorRampStop[];
  interp: ColorRampInterp;
  // Blend color space (091626_ramp-space-interp.md). Default sRGB.
  space?: ColorRampSpace;
  closeOpen: boolean;
  // Phase shift along the ramp; wraps past 1. 0 = no shift.
  offset?: number;
  // Remap each sample's arc-length t before sampling the ramp. Used by
  // Rasterize/Stroke `attribute` mode (interpolated named channel).
  // Missing / omitted → identity (progress).
  tAt?: (sub: SplineSubpath, arcT: number) => number;
}

export function paintStrokeAlongProgress(
  c2d: CanvasRenderingContext2D,
  subpaths: SplineSubpath[],
  opts: StrokeProgressOpts
) {
  const { W, H, thicknessPx, stops, interp, space, closeOpen, offset = 0, tAt } = opts;
  const savedDashOffset = c2d.lineDashOffset;
  const savedCap = c2d.lineCap;
  const sample = makeColorRampSampler(stops, { interp, space });

  for (const raw of subpaths) {
    const sub = closeOpen && !raw.closed ? { ...raw, closed: true } : raw;
    const colorAt = (arcT: number) =>
      rgba01ToCss(sample(tAt ? tAt(sub, arcT) : arcT, offset));
    if (subpathHasWidthProfile(sub) && thicknessPx > 0) {
      if (paintEnvelopeAlongProgress(c2d, sub, W, H, thicknessPx, colorAt)) {
        continue;
      }
    }
    paintPolylineAlongProgress(c2d, sub, W, H, colorAt, savedCap);
  }

  c2d.lineDashOffset = savedDashOffset;
  c2d.lineCap = savedCap;
}

function paintPolylineAlongProgress(
  c2d: CanvasRenderingContext2D,
  sub: SplineSubpath,
  W: number,
  H: number,
  colorAt: (t: number) => string,
  cap: CanvasLineCap
) {
  const samples = sampleSubpathPolylinePx(sub, W, H);
  if (samples.length < 2) return;
  let dist = 0;
  const last = samples.length - 2;
  for (let i = 0; i <= last; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-4) continue;
    const grad = c2d.createLinearGradient(a.x, a.y, b.x, b.y);
    grad.addColorStop(0, colorAt(a.t));
    grad.addColorStop(1, colorAt(b.t));
    c2d.strokeStyle = grad;
    // Round caps on interior pieces hide the chord joints; the authored
    // cap only matters at the true ends of an open path.
    const atStart = i === 0 && !sub.closed;
    const atEnd = i === last && !sub.closed;
    c2d.lineCap = atStart || atEnd ? cap : "round";
    c2d.lineDashOffset = -dist;
    c2d.beginPath();
    c2d.moveTo(a.x, a.y);
    c2d.lineTo(b.x, b.y);
    c2d.stroke();
    dist += len;
  }
}

function paintEnvelopeAlongProgress(
  c2d: CanvasRenderingContext2D,
  sub: SplineSubpath,
  W: number,
  H: number,
  thicknessPx: number,
  colorAt: (t: number) => string
): boolean {
  const pts = buildWidthEnvelopePoints(sub, W, H, thicknessPx);
  if (!pts) return false;
  const { left, right, t } = pts;
  const n = Math.min(left.length, right.length, t.length);
  if (n < 2) return false;
  for (let i = 0; i < n - 1; i++) {
    const l0 = left[i];
    const l1 = left[i + 1];
    const r0 = right[i];
    const r1 = right[i + 1];
    const cx0 = (l0[0] + r0[0]) * 0.5;
    const cy0 = (l0[1] + r0[1]) * 0.5;
    const cx1 = (l1[0] + r1[0]) * 0.5;
    const cy1 = (l1[1] + r1[1]) * 0.5;
    const path = new Path2D();
    path.moveTo(l0[0], l0[1]);
    path.lineTo(l1[0], l1[1]);
    path.lineTo(r1[0], r1[1]);
    path.lineTo(r0[0], r0[1]);
    path.closePath();
    if (Math.hypot(cx1 - cx0, cy1 - cy0) < 1e-4) {
      c2d.fillStyle = colorAt(t[i]);
    } else {
      const grad = c2d.createLinearGradient(cx0, cy0, cx1, cy1);
      grad.addColorStop(0, colorAt(t[i]));
      grad.addColorStop(1, colorAt(t[i + 1]));
      c2d.fillStyle = grad;
    }
    c2d.fill(path);
  }
  if (!pts.closed) {
    fillRoundCap(
      c2d,
      pts.startPos,
      [-pts.startTan[0], -pts.startTan[1]],
      pts.startHalf,
      1,
      colorAt(t[0] ?? 0)
    );
    fillRoundCap(
      c2d,
      pts.endPos,
      pts.endTan,
      pts.endHalf,
      1,
      colorAt(t[n - 1] ?? 1)
    );
  }
  return true;
}

function fillRoundCap(
  c2d: CanvasRenderingContext2D,
  pos: [number, number],
  tan: [number, number],
  half: number,
  dir: 1 | -1,
  color: string
) {
  if (half <= 0) return;
  const STEPS = 8;
  const nx = -tan[1];
  const ny = tan[0];
  const path = new Path2D();
  path.moveTo(pos[0] + nx * half, pos[1] + ny * half);
  for (let j = 1; j < STEPS; j++) {
    const ang = (j / STEPS) * Math.PI;
    const c = Math.cos(ang);
    const sn = Math.sin(ang) * dir;
    const dx = -tan[1] * c + tan[0] * sn;
    const dy = tan[0] * c + tan[1] * sn;
    path.lineTo(pos[0] + dx * half, pos[1] + dy * half);
  }
  path.lineTo(pos[0] - nx * half, pos[1] - ny * half);
  path.closePath();
  c2d.fillStyle = color;
  c2d.fill(path);
}
