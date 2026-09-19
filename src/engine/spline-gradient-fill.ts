import type { SplineSubpath } from "./types";
import { aspectCorrectY } from "./aspect";
import {
  COLOR_RAMP_MAX_STOPS,
  makeColorRampSampler,
  normalizeRampInterp,
  normalizeRampSpace,
  rgba01ToCss,
  type ColorRampInterp,
  type ColorRampSampler,
  type ColorRampSpace,
  type ColorRampStop,
} from "./color-ramp";
import { makeSubpathDriverFn, type ColorRampBy } from "./spline-color-source";

// Per-subpath gradient fill for Rasterize Spline's `fill_source: gradient`
// (091026_local-gradient-fill.md). Ramp mode resolves ONE color per
// subpath; this lays the ramp out as a Canvas2D gradient inside each
// subpath's own frame, so Circle → Copy to Points → Rasterize gives every
// copy its own linear / radial / conic gradient.
//
// The frame is derived from the geometry alone — Copy to Points does not
// record a copy's rotation or scale on the subpath — and is consistent
// across copies because every copy is a transform of one instance:
//   origin  = mean of the anchors (affine-covariant; the centroid the
//             `position` ramp mode uses)
//   shape   = "up" is the direction from the origin to the FIRST anchor,
//             handedness from the outline's winding, so the axis rotates
//             and mirrors with each copy. angle 0 reads left→right on an
//             unrotated Circle (its first anchor is the top).
//   canvas  = the angle is in canvas space (every copy lit alike).
//   extent  = min/max projection of the sampled outline on the axis, so
//             the ramp's ends land on the shape's edge at any angle;
//             radial uses the max outline distance from the origin.
//
// Engine-side (invariant #1) so the export bundle keeps it.

export type GradientKind = "linear" | "radial" | "conic";
export type GradientFrame = "shape" | "canvas";
export type GradientVary = "none" | ColorRampBy;

export interface SubpathGradientConfig {
  kind: GradientKind;
  frame: GradientFrame;
  angleDeg: number; // linear axis / conic start, degrees (0 = left→right)
  scale: number; // span multiplier about the middle (linear / radial)
  offset: number; // ramp phase; non-zero wraps (offsetRampT)
  stops: ColorRampStop[];
  interp: ColorRampInterp;
  // Blend color space (091626_ramp-space-interp.md). Default sRGB.
  space?: ColorRampSpace;
  // Per-subpath phase shift: shift = offset + varyAmount × driver t, with
  // t from the shared subpath driver (index / random / group / position /
  // driver). "none" = every subpath gets the same phase.
  vary: GradientVary;
  varyAmount: number;
  seed: number;
  varyAngleDeg: number; // position axis for vary === "position"
  attr?: string; // named channel for vary === "driver"
}

export interface SubpathGradientFrame {
  cx: number; // origin (anchor mean), authored [0,1]² Y-down
  cy: number;
  dirX: number; // unit gradient axis
  dirY: number;
  angle: number; // axis angle, radians, Y-down (0 = +x, 90° = +y)
  minProj: number; // outline extent along the axis, relative to the origin
  maxProj: number;
  radius: number; // max outline distance from the origin
}

// The subset of CanvasRenderingContext2D the resolver needs — lets the
// offline check hand in a recording fake.
export interface GradientCanvas {
  createLinearGradient(
    x0: number,
    y0: number,
    x1: number,
    y1: number
  ): CanvasGradient;
  createRadialGradient(
    x0: number,
    y0: number,
    r0: number,
    x1: number,
    y1: number,
    r1: number
  ): CanvasGradient;
  createConicGradient(startAngle: number, x: number, y: number): CanvasGradient;
}

const SAMPLES_PER_CUBIC = 8;

// Walk the subpath's outline as fill sees it: every segment, closed back
// to the first anchor. Straight segments contribute their end point only;
// curved ones are sampled SAMPLES_PER_CUBIC times.
function forEachOutlineSample(
  sub: SplineSubpath,
  fn: (x: number, y: number) => void
): void {
  const a = sub.anchors;
  const n = a.length;
  if (n === 0) return;
  fn(a[0].pos[0], a[0].pos[1]);
  if (n < 2) return;
  for (let i = 0; i < n; i++) {
    const p = a[i];
    const q = a[(i + 1) % n];
    const h1 = p.outHandle;
    const h2 = q.inHandle;
    if (!h1 && !h2) {
      fn(q.pos[0], q.pos[1]);
      continue;
    }
    const x0 = p.pos[0];
    const y0 = p.pos[1];
    const x1 = h1 ? x0 + h1[0] : x0;
    const y1 = h1 ? y0 + h1[1] : y0;
    const x3 = q.pos[0];
    const y3 = q.pos[1];
    const x2 = h2 ? x3 + h2[0] : x3;
    const y2 = h2 ? y3 + h2[1] : y3;
    for (let k = 1; k <= SAMPLES_PER_CUBIC; k++) {
      const t = k / SAMPLES_PER_CUBIC;
      const u = 1 - t;
      const b0 = u * u * u;
      const b1 = 3 * u * u * t;
      const b2 = 3 * u * t * t;
      const b3 = t * t * t;
      fn(
        b0 * x0 + b1 * x1 + b2 * x2 + b3 * x3,
        b0 * y0 + b1 * y1 + b2 * y2 + b3 * y3
      );
    }
  }
}

// Resolve one subpath's gradient frame. `null` for an empty subpath.
export function subpathGradientFrame(
  sub: SplineSubpath,
  frame: GradientFrame,
  angleDeg: number
): SubpathGradientFrame | null {
  const a = sub.anchors;
  if (a.length === 0) return null;
  let cx = 0;
  let cy = 0;
  for (const an of a) {
    cx += an.pos[0];
    cy += an.pos[1];
  }
  cx /= a.length;
  cy /= a.length;

  // Outline pass 1: signed area (handedness) + radius. Shoelace over the
  // sampled outline; the sign flips under a mirror, which is what lets a
  // mirrored copy's gradient mirror too.
  let area2 = 0;
  let r2 = 0;
  let px = NaN;
  let py = NaN;
  let fx = 0;
  let fy = 0;
  let first = true;
  forEachOutlineSample(sub, (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 > r2) r2 = d2;
    if (first) {
      fx = dx;
      fy = dy;
      first = false;
    } else {
      area2 += px * dy - dx * py;
    }
    px = dx;
    py = dy;
  });
  if (!first) area2 += px * fy - fx * py; // close the polygon
  const hand = area2 < 0 ? -1 : 1;

  let angle: number;
  if (frame === "shape") {
    const dx = a[0].pos[0] - cx;
    const dy = a[0].pos[1] - cy;
    // "up" = origin → first anchor; "right" = up rotated a quarter turn
    // in the outline's handedness. Degenerate first anchor → canvas.
    const up = dx * dx + dy * dy > 1e-18 ? Math.atan2(dy, dx) : -Math.PI / 2;
    angle = up + hand * (Math.PI / 2 + (angleDeg * Math.PI) / 180);
  } else {
    angle = (angleDeg * Math.PI) / 180;
  }
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);

  // Outline pass 2: extent along the axis.
  let minProj = Infinity;
  let maxProj = -Infinity;
  forEachOutlineSample(sub, (x, y) => {
    const p = (x - cx) * dirX + (y - cy) * dirY;
    if (p < minProj) minProj = p;
    if (p > maxProj) maxProj = p;
  });
  return {
    cx,
    cy,
    dirX,
    dirY,
    angle,
    minProj,
    maxProj,
    radius: Math.sqrt(r2),
  };
}

export interface GradientStop {
  pos: number; // 0..1 along the gradient
  color: string; // rgba(...)
}

const EPS = 1e-6;
// Canvas2D only lerps in gamma sRGB between stops, so any other curve or
// color space is approximated piecewise-linearly with this many segments
// per interval. 16 keeps a smoothstep / OKLab arc within a step of 8-bit
// output over a typical span.
const CURVE_SUBDIV = 16;

// Canvas needs subdivision whenever the true ramp between two knots is not
// a straight line in gamma sRGB.
function needsSubdivision(interp: ColorRampInterp, space: ColorRampSpace): boolean {
  if (interp === "constant") return false;
  return interp !== "linear" || space !== "srgb";
}

// Convert a color ramp into Canvas2D gradient stops that reproduce
// `sampleColorRamp(stops, u, interp, offset, space)` along u ∈ [0,1]:
//   linear/sRGB — a stop per ramp stop (Canvas lerps between them)
//   constant    — two stops per interval so each holds its left color
//   anything else — each interval subdivided into CURVE_SUBDIV linear
//                   segments (the curve / color space, piecewise-linear)
// A non-zero offset wraps (offsetRampT), so the point where t crosses
// 1 → 0 gets a doubled stop: the seam a ramp with unequal ends shows.
export function rampToGradientStops(
  stops: ColorRampStop[],
  interp: ColorRampInterp,
  offset = 0,
  space: ColorRampSpace = "srgb"
): GradientStop[] {
  const i = normalizeRampInterp(interp);
  const s = normalizeRampSpace(space);
  return rampToGradientStopsWith(
    makeColorRampSampler(stops, { interp: i, space: s }),
    stops,
    i,
    s,
    offset
  );
}

// Same, with a prebuilt sampler — makeSubpathGradientFn builds one sampler
// and reuses it across every per-copy phase (the smooth / spline modes do
// real work at construction).
function rampToGradientStopsWith(
  sample: ColorRampSampler,
  stops: ColorRampStop[],
  interp: ColorRampInterp,
  space: ColorRampSpace,
  offset: number
): GradientStop[] {
  const sorted = [...stops]
    .filter((s) => typeof s.position === "number")
    .sort((a, b) => a.position - b.position)
    .slice(0, COLOR_RAMP_MAX_STOPS);
  const wrap = Math.abs(offset) > 1e-8;
  const frac = (x: number) => x - Math.floor(x);
  const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

  const knotSet = new Set<number>([0, 1]);
  for (const s of sorted) {
    knotSet.add(clamp01(wrap ? frac(s.position - offset) : s.position));
  }
  const seam = wrap ? frac(-offset) : -1;
  const hasSeam = wrap && seam > EPS && seam < 1 - EPS;
  if (hasSeam) knotSet.add(seam);
  const knots = [...knotSet].sort((a, b) => a - b);

  const color = (u: number) => rgba01ToCss(sample(u, offset));
  const subdiv = needsSubdivision(interp, space);
  const out: GradientStop[] = [];
  const K = knots.length;
  for (let i = 0; i < K; i++) {
    const u = knots[i];
    if (interp === "constant") {
      if (i < K - 1) {
        const c = color(Math.min(1 - EPS, u + EPS));
        out.push({ pos: u, color: c });
        out.push({ pos: knots[i + 1], color: c });
      }
      continue;
    }
    if (hasSeam && Math.abs(u - seam) < 1e-9) {
      out.push({ pos: u, color: color(u - EPS) });
      out.push({ pos: u, color: color(u + EPS) });
    } else {
      // With wrap, u=1 folds onto u=0's t (frac); sample just inside so
      // an integer offset can't land the end stop on the first color.
      out.push({ pos: u, color: color(wrap && i === K - 1 ? 1 - EPS : u) });
    }
    if (subdiv && i < K - 1) {
      const next = knots[i + 1];
      for (let j = 1; j < CURVE_SUBDIV; j++) {
        const v = u + ((next - u) * j) / CURVE_SUBDIV;
        out.push({ pos: v, color: color(v) });
      }
    }
  }
  return out;
}

// Build the per-subpath gradient resolver. Returns a CanvasGradient in
// device pixels (same aspect-corrected mapping as buildPath2D), or a
// solid `rgba()` string when the frame is degenerate (a point, a zero
// span) so the fill never silently paints nothing.
export function makeSubpathGradientFn(
  c2d: GradientCanvas,
  subpaths: SplineSubpath[],
  cfg: SubpathGradientConfig,
  W: number,
  H: number
): (i: number, sub: SplineSubpath) => string | CanvasGradient {
  const aspect = W / H;
  const toPxX = (x: number) => x * W;
  const toPxY = (y: number) => aspectCorrectY(y, aspect) * H;
  const scale = Math.min(100, Math.max(0.01, cfg.scale ?? 1));
  const stops = Array.isArray(cfg.stops) ? cfg.stops : [];
  const interp = normalizeRampInterp(cfg.interp);
  const space = normalizeRampSpace(cfg.space);
  const sample = makeColorRampSampler(stops, { interp, space });
  const baseOffset = Number.isFinite(cfg.offset) ? cfg.offset : 0;
  const amount = Number.isFinite(cfg.varyAmount) ? cfg.varyAmount : 0;
  const varyAt =
    cfg.vary && cfg.vary !== "none" && amount !== 0
      ? makeSubpathDriverFn(subpaths, {
          by: cfg.vary,
          seed: Math.floor(cfg.seed ?? 0),
          angleDeg: cfg.varyAngleDeg ?? 0,
          attr: cfg.attr,
        })
      : null;

  // Stop lists depend only on the phase; quantize so thousands of copies
  // share a handful of lists.
  const stopCache = new Map<number, GradientStop[]>();
  const stopsFor = (shift: number): GradientStop[] => {
    const key = Math.round(shift * 1024);
    let list = stopCache.get(key);
    if (!list) {
      list = rampToGradientStopsWith(sample, stops, interp, space, key / 1024);
      stopCache.set(key, list);
    }
    return list;
  };

  return (i, sub) => {
    const shift = baseOffset + (varyAt ? amount * varyAt(i, sub) : 0);
    const solid = () => rgba01ToCss(sample(0.5, shift));
    const fr = subpathGradientFrame(sub, cfg.frame, cfg.angleDeg ?? 0);
    if (!fr) return solid();
    let g: CanvasGradient;
    if (cfg.kind === "radial") {
      const r = fr.radius * scale;
      if (!(r > EPS)) return solid();
      const cx = toPxX(fr.cx);
      const cy = toPxY(fr.cy);
      // Y is aspect-corrected to share X's pixel scale, so an authored
      // radius maps uniformly: r × W.
      g = c2d.createRadialGradient(cx, cy, 0, cx, cy, r * W);
    } else if (cfg.kind === "conic") {
      g = c2d.createConicGradient(fr.angle, toPxX(fr.cx), toPxY(fr.cy));
    } else {
      const mid = (fr.minProj + fr.maxProj) / 2;
      const half = ((fr.maxProj - fr.minProj) / 2) * scale;
      if (!(half > EPS)) return solid();
      const ax = fr.cx + fr.dirX * (mid - half);
      const ay = fr.cy + fr.dirY * (mid - half);
      const bx = fr.cx + fr.dirX * (mid + half);
      const by = fr.cy + fr.dirY * (mid + half);
      g = c2d.createLinearGradient(toPxX(ax), toPxY(ay), toPxX(bx), toPxY(by));
    }
    for (const s of stopsFor(shift)) g.addColorStop(s.pos, s.color);
    return g;
  };
}
