// After Effects export — coordinates (spec 091926_after-effects-handoff.md
// §4.1, Appendix B).
//
// Toolbox authors 2-D geometry in canvas01: [0,1]² Y-down, x across the
// width, y width-relative and centered (engine/aspect.ts). AE layer space is
// Y-down pixels. The map is the spline rasterizer's (sim-kernel.ts
// authoredToPxY / subpathToCanvasPx): px = (x·W, y·W + (H − W)/2), handles
// and other deltas ×W on both axes. It is a similarity (one scale, one
// offset), so angles, rotation sign (clockwise-positive, both sides) and
// TRS composition order all carry over unchanged.
//
// uv01 (Gradient params, `v_uv`) is the one inversion: per-axis fractions of
// the raster, Y-UP, so px = (u·W, (1 − v)·H) — not width-relative.

import type { SplineAnchor, SplineSubpath } from "@/engine/types";
import { authoredToPxY, pxToAuthoredY } from "@/engine/sim-kernel";
import { aspectCorrectY, aspectUncorrectY } from "@/engine/aspect";
import { resolveStrokePx } from "@/engine/stroke-units";
import { roundCornersPerAnchor } from "@/engine/spline-math";
import type { AePath } from "../types";

export interface AeCanvas {
  width: number;
  height: number;
}

export type Vec2 = [number, number];

// ---- canvas01 ↔ layer px ---------------------------------------------------

export function canvasXToPx(x: number, c: AeCanvas): number {
  return x * c.width;
}

export function canvasYToPx(y: number, c: AeCanvas): number {
  return authoredToPxY(y, c.width, c.height);
}

export function pxToCanvasX(px: number, c: AeCanvas): number {
  return px / c.width;
}

export function pxToCanvasY(py: number, c: AeCanvas): number {
  return pxToAuthoredY(py, c.width, c.height);
}

export function canvasToPx(p: readonly [number, number], c: AeCanvas): Vec2 {
  return [canvasXToPx(p[0], c), canvasYToPx(p[1], c)];
}

export function pxToCanvas(p: readonly [number, number], c: AeCanvas): Vec2 {
  return [pxToCanvasX(p[0], c), pxToCanvasY(p[1], c)];
}

// A canvas01 delta (translation, handle offset): ×W on both axes.
export function canvasDeltaToPx(d: readonly [number, number], c: AeCanvas): Vec2 {
  return [d[0] * c.width, d[1] * c.width];
}

export function pxDeltaToCanvas(d: readonly [number, number], c: AeCanvas): Vec2 {
  return [d[0] / c.width, d[1] / c.width];
}

// The affine map x_ae = scale·x + offset per axis — what keys.ts needs to carry
// a canvas01 track into px with its easing intact (an affine map of a cubic is
// the same cubic).
export function canvasAxisAffine(axis: "x" | "y", c: AeCanvas): { scale: number; offset: number } {
  return axis === "x" ? { scale: c.width, offset: 0 } : { scale: c.width, offset: 0.5 * (c.height - c.width) };
}

// Width-relative lengths (radii, corner radii, canvas01 stroke widths): ×W.
export function widthRelativeToPx(r: number, c: AeCanvas): number {
  return r * c.width;
}

// Stroke metrics per engine/stroke-units.ts: `px` passes through, `%` is
// value/100 · W.
export function strokeWidthToPx(value: number, units: unknown, c: AeCanvas): number {
  return resolveStrokePx(value, units, c.width);
}

// ---- uv01 (Y-up, per-axis) -------------------------------------------------

export function uv01ToPx(p: readonly [number, number], c: AeCanvas): Vec2 {
  return [p[0] * c.width, (1 - p[1]) * c.height];
}

export function pxToUv01(p: readonly [number, number], c: AeCanvas): Vec2 {
  return [p[0] / c.width, 1 - p[1] / c.height];
}

export function uv01AxisAffine(axis: "u" | "v", c: AeCanvas): { scale: number; offset: number } {
  return axis === "u" ? { scale: c.width, offset: 0 } : { scale: -c.height, offset: c.height };
}

// uv01 ↔ canvas01: v_uv is (x, 1 − y_raster) and y_raster = aspectCorrectY(y).
export function uv01ToCanvas(p: readonly [number, number], c: AeCanvas): Vec2 {
  return [p[0], aspectUncorrectY(1 - p[1], c.width / c.height)];
}

export function canvasToUv01(p: readonly [number, number], c: AeCanvas): Vec2 {
  return [p[0], 1 - aspectCorrectY(p[1], c.width / c.height)];
}

// ---- angles (Appendix B) ---------------------------------------------------
// The layer transform and the Transform node are degrees; Sample Along Path
// angles and Copy to Points rotation fields are radians.

export const DEG_PER_RAD = 180 / Math.PI;

export function radToDeg(rad: number): number {
  return rad * DEG_PER_RAD;
}

export function degToRad(deg: number): number {
  return deg / DEG_PER_RAD;
}

// ---- splines → AE paths ----------------------------------------------------

const zero = (): Vec2 => [0, 0];

// One subpath → AE's Shape: vertices in layer px, relative tangents (a
// missing handle is [0, 0]). Toolbox's segment A → B is the cubic
// {A.pos, A.pos + A.outHandle, B.pos + B.inHandle, B.pos}; AE's is
// {v[i], v[i] + out[i], v[i+1] + in[i+1], v[i+1]} — the same slots, closed
// paths included (last → first through last.out and first.in).
export function subpathToAePath(sub: SplineSubpath, c: AeCanvas): AePath {
  const vertices: Vec2[] = [];
  const inTangents: Vec2[] = [];
  const outTangents: Vec2[] = [];
  for (const a of sub.anchors) {
    vertices.push(canvasToPx(a.pos, c));
    inTangents.push(a.inHandle ? canvasDeltaToPx(a.inHandle, c) : zero());
    outTangents.push(a.outHandle ? canvasDeltaToPx(a.outHandle, c) : zero());
  }
  return { vertices, inTangents, outTangents, closed: !!sub.closed };
}

// One AePath per subpath, in subpath order. Live corner radii are NOT applied
// here — planCorners decides between AE's Round Corners and baking them.
export function splineToAePaths(spline: { subpaths: readonly SplineSubpath[] }, c: AeCanvas): AePath[] {
  return spline.subpaths.map((s) => subpathToAePath(s, c));
}

// ---- live corners (SplineAnchor.cornerRadius) -------------------------------

// AE's Round Corners on one path, as lottie-web reproduces it
// (RoundCornersModifier.processPath): every vertex with both tangents zero —
// open-path endpoints excepted — becomes two vertices inset along each edge by
// min(radius, edge/2), each with a handle 0.5519 of the way back toward the
// corner. Toolbox's fillet differs in two places: it caps the inset at half of
// the SHORTER adjacent edge on both sides, and its handles are a true circular
// arc (R·4/3·tan(θ/4)), so the two agree only where the inset is uncapped and
// the corner near 90°. planCorners measures the difference instead of
// assuming it.
export const AE_ROUND_CORNER_KAPPA = 0.5519;

export function aeRoundCornersPath(path: AePath, radiusPx: number): AePath {
  const n = path.vertices.length;
  const out: AePath = { vertices: [], inTangents: [], outTangents: [], closed: path.closed };
  const isCorner = (i: number) =>
    path.inTangents[i][0] === 0 && path.inTangents[i][1] === 0 && path.outTangents[i][0] === 0 && path.outTangents[i][1] === 0;
  const k = AE_ROUND_CORNER_KAPPA;
  for (let i = 0; i < n; i++) {
    const v = path.vertices[i];
    if (!isCorner(i) || (!path.closed && (i === 0 || i === n - 1)) || !(radiusPx > 0)) {
      out.vertices.push([v[0], v[1]]);
      out.inTangents.push([path.inTangents[i][0], path.inTangents[i][1]]);
      out.outTangents.push([path.outTangents[i][0], path.outTangents[i][1]]);
      continue;
    }
    const prev = path.vertices[(i - 1 + n) % n];
    const next = path.vertices[(i + 1) % n];
    const inset = (to: Vec2): Vec2 => {
      const d = Math.hypot(to[0] - v[0], to[1] - v[1]);
      const f = d ? Math.min(d / 2, radiusPx) / d : 0;
      return [v[0] + (to[0] - v[0]) * f, v[1] + (to[1] - v[1]) * f];
    };
    // Toward the previous vertex: the in-side vertex, its OUT handle points
    // at the corner (lottie's oX = vX − (vX − cornerX)·k is absolute).
    const a = inset(prev);
    out.vertices.push(a);
    out.inTangents.push([0, 0]);
    out.outTangents.push([(v[0] - a[0]) * k, (v[1] - a[1]) * k]);
    const b = inset(next);
    out.vertices.push(b);
    out.inTangents.push([(v[0] - b[0]) * k, (v[1] - b[1]) * k]);
    out.outTangents.push([0, 0]);
  }
  return out;
}

export type AeCornerPlan =
  // No live corners: the raw paths.
  | { kind: "none"; paths: AePath[] }
  // One radius on every corner AE would round, and AE's fillet lands within
  // tolerance of toolbox's: raw paths + a Round Corners item of `radius` px.
  | { kind: "uniform"; radius: number; paths: AePath[]; maxDeviationPx: number }
  // Fillets baked into the vertices with toolbox's own math.
  | { kind: "baked"; paths: AePath[]; reason: string };

function anchorIsCorner(a: SplineAnchor): boolean {
  const z = (h?: [number, number]) => !h || (h[0] === 0 && h[1] === 0);
  return z(a.inHandle) && z(a.outHandle);
}

// Max distance between two paths' curves (dense samples per segment), or
// Infinity when their vertex counts differ.
export function pathDeviationPx(a: AePath, b: AePath, samplesPerSegment = 16): number {
  const n = a.vertices.length;
  if (n !== b.vertices.length || a.closed !== b.closed) return Infinity;
  const segs = a.closed ? n : n - 1;
  let m = 0;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    for (let s = 0; s <= samplesPerSegment; s++) {
      const t = s / samplesPerSegment;
      const pa = pathPoint(a, i, j, t);
      const pb = pathPoint(b, i, j, t);
      m = Math.max(m, Math.hypot(pa[0] - pb[0], pa[1] - pb[1]));
    }
  }
  return m;
}

function pathPoint(p: AePath, i: number, j: number, t: number): Vec2 {
  const p0 = p.vertices[i];
  const p3 = p.vertices[j];
  const p1: Vec2 = [p0[0] + p.outTangents[i][0], p0[1] + p.outTangents[i][1]];
  const p2: Vec2 = [p3[0] + p.inTangents[j][0], p3[1] + p.inTangents[j][1]];
  const o = 1 - t;
  const a = o * o * o;
  const b = 3 * o * o * t;
  const cc = 3 * o * t * t;
  const d = t * t * t;
  return [a * p0[0] + b * p1[0] + cc * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + cc * p2[1] + d * p3[1]];
}

// Per-anchor cornerRadius → AE. Uniform Round Corners only when (1) every
// anchor AE would round (handle-less, not an open endpoint, in a subpath of
// ≥ 3 anchors — toolbox leaves shorter ones alone, AE does not) carries the
// same radius, (2) no anchor uses a chamfer / scoop style, and (3) AE's fillet
// lands within `tolerancePx` of toolbox's on every subpath. Otherwise the
// fillets are baked with toolbox's roundCornersPerAnchor.
export function planCorners(
  spline: { subpaths: readonly SplineSubpath[] },
  c: AeCanvas,
  opts: { tolerancePx?: number } = {}
): AeCornerPlan {
  const tol = opts.tolerancePx ?? 0.25;
  const raw = splineToAePaths(spline, c);
  const eps = 1e-6;
  let any = false;
  let radius: number | undefined;
  let uniform = true;
  let why = "";
  for (const s of spline.subpaths) {
    const n = s.anchors.length;
    s.anchors.forEach((a, i) => {
      const r = a.cornerRadius ?? 0;
      const live = r > eps && anchorIsCorner(a);
      if (live) any = true;
      if (live && a.cornerStyle) {
        uniform = false;
        why ||= `corner style "${a.cornerStyle}" has no Round Corners form`;
      }
      const aeRounds = anchorIsCorner(a) && (s.closed || (i > 0 && i < n - 1));
      if (!aeRounds) return;
      if (n < 3) {
        if (r > eps || n === 2) {
          uniform = false;
          why ||= "a subpath under 3 anchors (AE rounds it, toolbox does not)";
        }
        return;
      }
      if (radius === undefined) radius = r;
      else if (Math.abs(r - radius) > eps * Math.max(1, radius)) {
        uniform = false;
        why ||= "corner radii differ between anchors";
      }
    });
  }
  if (!any) return { kind: "none", paths: raw };
  const baked = () => splineToAePaths({ subpaths: roundCornersPerAnchor(spline.subpaths as SplineSubpath[]) }, c);
  if (!uniform || radius === undefined || !(radius > eps)) {
    return { kind: "baked", paths: baked(), reason: why || "not every corner carries a radius" };
  }
  const radiusPx = widthRelativeToPx(radius, c);
  const ours = baked();
  let dev = 0;
  for (let i = 0; i < raw.length; i++) dev = Math.max(dev, pathDeviationPx(aeRoundCornersPath(raw[i], radiusPx), ours[i]));
  if (dev <= tol) return { kind: "uniform", radius: radiusPx, paths: raw, maxDeviationPx: dev };
  return {
    kind: "baked",
    paths: ours,
    reason: Number.isFinite(dev)
      ? `AE's Round Corners lands ${dev.toFixed(2)} px from toolbox's fillet (capped insets or non-right corners)`
      : "AE's Round Corners changes the vertex count differently from toolbox's fillet",
  };
}
