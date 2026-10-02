// Coordinate plumbing for the Figma importer (specdocs/092326_figma-import.md).
//
// Figma hands us node-local geometry plus a node-local → root-frame affine.
// Toolbox splines live in authored space: [0,1]² Y-down where x spans the
// canvas width and y is WIDTH-relative about the canvas centre (the
// rasterizer scales y about 0.5 by W/H — engine/aspect.ts). With the canvas
// sized to the frame (W × H px) a frame pixel (px, py) lands at
//   x = px / W,  y = 0.5 + (py − H/2) / W
// so one affine (frameToSpline · node transform) carries a path straight
// from node-local px into spline space, exactly — affine maps keep béziers.

import type { SplineSubpath } from "@/engine/types";
import { parsePathDataTransformed } from "@/lib/svg-parse";
import type { FigmaTransform, FigmaVectorPath } from "./scene";

export type Affine = FigmaTransform;

export const IDENTITY_AFFINE: Affine = [
  [1, 0, 0],
  [0, 1, 0],
];

export function mulAffine(p: Affine, q: Affine): Affine {
  return [
    [
      p[0][0] * q[0][0] + p[0][1] * q[1][0],
      p[0][0] * q[0][1] + p[0][1] * q[1][1],
      p[0][0] * q[0][2] + p[0][1] * q[1][2] + p[0][2],
    ],
    [
      p[1][0] * q[0][0] + p[1][1] * q[1][0],
      p[1][0] * q[0][1] + p[1][1] * q[1][1],
      p[1][0] * q[0][2] + p[1][1] * q[1][2] + p[1][2],
    ],
  ];
}

export function invertAffine(m: Affine): Affine | null {
  const [[a, c, e], [b, d, f]] = m;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [
    [d / det, -c / det, (c * f - d * e) / det],
    [-b / det, a / det, (b * e - a * f) / det],
  ];
}

export function applyAffine(m: Affine, x: number, y: number): [number, number] {
  return [
    m[0][0] * x + m[0][1] * y + m[0][2],
    m[1][0] * x + m[1][1] * y + m[1][2],
  ];
}

// Root-frame px → authored spline space for a W × H frame (see header).
export function frameToSpline(W: number, H: number): Affine {
  return [
    [1 / W, 0, 0],
    [0, 1 / W, 0.5 - H / (2 * W)],
  ];
}

// Figma [[a, c, e], [b, d, f]] → svg-parse's [a, b, c, d, e, f].
function toSvgMatrix(m: Affine): [number, number, number, number, number, number] {
  return [m[0][0], m[1][0], m[0][1], m[1][1], m[0][2], m[1][2]];
}

// A closed Figma path usually returns to its start before the Z
// ("… L 0 0 Z" / "… C … 0 0 Z"), which parses as a duplicate final anchor
// and a zero-length closing segment — harmless for fills, but it puts a
// degenerate join into miter strokes and a stray anchor under the pen tool.
// Fold the duplicate into the first anchor (it carries the in-handle).
const CLOSE_EPS = 1e-6; // spline units ≈ 0.001 px on a 1000 px canvas

function foldClosingDuplicate(sub: SplineSubpath): SplineSubpath {
  if (!sub.closed || sub.anchors.length < 3) return sub;
  const first = sub.anchors[0];
  const last = sub.anchors[sub.anchors.length - 1];
  if (
    Math.abs(first.pos[0] - last.pos[0]) > CLOSE_EPS ||
    Math.abs(first.pos[1] - last.pos[1]) > CLOSE_EPS
  ) {
    return sub;
  }
  const anchors = sub.anchors.slice(0, -1);
  anchors[0] = last.inHandle
    ? { ...first, inHandle: last.inHandle }
    : { ...first };
  return { ...sub, anchors };
}

// Node-local Figma paths → spline subpaths through `m` (node-local →
// spline space). Subpaths with fewer than two anchors can't draw and are
// dropped.
export function pathsToSubpaths(
  paths: FigmaVectorPath[],
  m: Affine
): SplineSubpath[] {
  const svgM = toSvgMatrix(m);
  const out: SplineSubpath[] = [];
  for (const p of paths) {
    if (!p.data.trim()) continue;
    for (const sub of parsePathDataTransformed(p.data, svgM)) {
      const folded = foldClosingDuplicate(sub);
      if (folded.anchors.length >= 2) out.push(folded);
    }
  }
  return out;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// Control-point hull bounds of subpaths — conservative (a bézier lies inside
// its hull), which is what the "does this child poke outside the frame"
// test wants.
export function hullBounds(subpaths: SplineSubpath[]): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const visit = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const sub of subpaths) {
    for (const a of sub.anchors) {
      visit(a.pos[0], a.pos[1]);
      if (a.inHandle) visit(a.pos[0] + a.inHandle[0], a.pos[1] + a.inHandle[1]);
      if (a.outHandle) visit(a.pos[0] + a.outHandle[0], a.pos[1] + a.outHandle[1]);
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

// The four transformed corners of a node's w × h box, as bounds in the
// space `m` maps into.
export function boxBounds(m: Affine, w: number, h: number): Bounds {
  const pts = [
    applyAffine(m, 0, 0),
    applyAffine(m, w, 0),
    applyAffine(m, w, h),
    applyAffine(m, 0, h),
  ];
  return {
    minX: Math.min(...pts.map((p) => p[0])),
    minY: Math.min(...pts.map((p) => p[1])),
    maxX: Math.max(...pts.map((p) => p[0])),
    maxY: Math.max(...pts.map((p) => p[1])),
  };
}

export function boundsInside(inner: Bounds, outer: Bounds, eps = 1e-6): boolean {
  return (
    inner.minX >= outer.minX - eps &&
    inner.minY >= outer.minY - eps &&
    inner.maxX <= outer.maxX + eps &&
    inner.maxY <= outer.maxY + eps
  );
}

// True when the subpaths are exactly one straight-edged axis-aligned
// rectangle covering `b` — a frame background with no corner radius.
export function isPlainRect(subpaths: SplineSubpath[], b: Bounds, eps = 1e-6): boolean {
  if (subpaths.length !== 1) return false;
  const s = subpaths[0];
  if (s.anchors.length !== 4) return false;
  const curved = s.anchors.some(
    (a) =>
      (a.inHandle && Math.hypot(a.inHandle[0], a.inHandle[1]) > eps) ||
      (a.outHandle && Math.hypot(a.outHandle[0], a.outHandle[1]) > eps)
  );
  if (curved) return false;
  return s.anchors.every(
    (a) =>
      (Math.abs(a.pos[0] - b.minX) < eps || Math.abs(a.pos[0] - b.maxX) < eps) &&
      (Math.abs(a.pos[1] - b.minY) < eps || Math.abs(a.pos[1] - b.maxY) < eps)
  );
}
