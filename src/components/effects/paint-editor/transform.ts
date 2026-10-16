// Free transform for floating selections (101526_paint-selection-transform.md
// §5, M3) — the pure half: handle geometry, the drag → matrix math, gizmo
// hit-testing, and the matrix ⇄ readout decomposition. DOM-free, so
// scripts/check-paint-selection.mts tests it directly.
//
// Everything works on the float's affine `matrix` (source px → canvas px)
// and its CONTENT rect (the selected bbox in source px — the source itself
// carries a small transparent pad). A drag never touches pixels: it derives
// a new matrix from the matrix at press, so a whole session of scales /
// rotations resamples the source exactly once, at commit.
//
// Handles are numbered clockwise from the top-left corner:
//   0 ─ 1 ─ 2
//   7       3
//   6 ─ 5 ─ 4
// Even = corners, odd = edge midpoints; the opposite handle is (i + 4) % 8.

import {
  applyAffine,
  compose,
  translation,
  type Affine,
} from "./floating";
import type { PxRect } from "./selection";

export type DragKind = "move" | "scale" | "rotate" | "skew";

export function invertAffine(m: Affine): Affine {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return [1, 0, 0, 1, -e, -f];
  return [
    d / det,
    -b / det,
    -c / det,
    a / det,
    (c * f - d * e) / det,
    (b * e - a * f) / det,
  ];
}

// The 8 handle positions of `content`, in source px.
export function handlePoints(content: PxRect): [number, number][] {
  const x0 = content.x;
  const y0 = content.y;
  const x1 = content.x + content.w;
  const y1 = content.y + content.h;
  const xm = (x0 + x1) / 2;
  const ym = (y0 + y1) / 2;
  return [
    [x0, y0],
    [xm, y0],
    [x1, y0],
    [x1, ym],
    [x1, y1],
    [xm, y1],
    [x0, y1],
    [x0, ym],
  ];
}

export function contentCenter(content: PxRect): [number, number] {
  return [content.x + content.w / 2, content.y + content.h / 2];
}

const scaleAbout = (ax: number, ay: number, sx: number, sy: number): Affine =>
  compose(translation(ax, ay), compose([sx, 0, 0, sy, 0, 0], translation(-ax, -ay)));

// Non-zero scale with its sign kept, so dragging through the anchor flips
// rather than collapsing to a degenerate (uninvertible) matrix.
const nonZero = (s: number) =>
  Math.abs(s) < 1e-3 ? (s < 0 ? -1e-3 : 1e-3) : s;

export interface DragMods {
  // Corners scale proportionally by default; Shift frees them (Photoshop
  // 2019+). While rotating, Shift snaps to 15°.
  shift: boolean;
  // Scale about the content center instead of the opposite handle.
  alt: boolean;
}

// The float's new matrix for a handle drag: `m0` = matrix at press,
// `start` / `cur` = pointer at press / now, canvas px.
export function dragTransform(
  kind: Exclude<DragKind, "move">,
  handle: number,
  m0: Affine,
  content: PxRect,
  start: [number, number],
  cur: [number, number],
  mods: DragMods
): Affine {
  if (kind === "rotate") {
    const [cx, cy] = applyAffine(m0, ...contentCenter(content));
    let theta =
      Math.atan2(cur[1] - cy, cur[0] - cx) -
      Math.atan2(start[1] - cy, start[0] - cx);
    if (mods.shift) {
      const step = Math.PI / 12;
      theta = Math.round(theta / step) * step;
    }
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const rot: Affine = [cos, sin, -sin, cos, 0, 0];
    return compose(
      translation(cx, cy),
      compose(rot, compose(translation(-cx, -cy), m0))
    );
  }
  const inv = invertAffine(m0);
  const pts = handlePoints(content);
  const [hx, hy] = pts[handle];
  const [ax, ay] = mods.alt ? contentCenter(content) : pts[(handle + 4) % 8];
  const [px, py] = applyAffine(inv, cur[0], cur[1]);
  const corner = handle % 2 === 0;
  const horizontalEdge = handle === 1 || handle === 5; // top / bottom
  if (kind === "skew" && !corner) {
    // Slide the grabbed edge along itself; the opposite edge (or the
    // center, with Alt) stays put.
    const [sx0, sy0] = applyAffine(inv, start[0], start[1]);
    if (horizontalEdge) {
      const k = (px - sx0) / (hy - ay);
      const shear: Affine = [1, 0, k, 1, 0, 0];
      return compose(
        m0,
        compose(translation(ax, ay), compose(shear, translation(-ax, -ay)))
      );
    }
    const k = (py - sy0) / (hx - ax);
    const shear: Affine = [1, k, 0, 1, 0, 0];
    return compose(
      m0,
      compose(translation(ax, ay), compose(shear, translation(-ax, -ay)))
    );
  }
  let sx = corner || !horizontalEdge ? (px - ax) / (hx - ax) : 1;
  let sy = corner || horizontalEdge ? (py - ay) / (hy - ay) : 1;
  if (corner && !mods.shift) {
    // Proportional: the axis that moved further wins; each keeps its sign.
    const s = Math.max(Math.abs(sx), Math.abs(sy));
    sx = (sx < 0 ? -1 : 1) * s;
    sy = (sy < 0 ? -1 : 1) * s;
  }
  return compose(m0, scaleAbout(ax, ay, nonZero(sx), nonZero(sy)));
}

// ── Gizmo hit-testing (screen px) ────────────────────────────────────

export interface GizmoHit {
  kind: DragKind;
  handle: number; // −1 for move
}

const HANDLE_HIT = 7; // px around a handle
const ROTATE_RING = 26; // px beyond a corner that still rotates

function insidePolygon(pt: [number, number], poly: [number, number][]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (
      yi > pt[1] !== yj > pt[1] &&
      pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

// What a press at `pt` grabs, given the 8 handles in screen px (handle
// order above). Handles win, then the box interior moves, then a ring just
// outside each corner rotates; anywhere else still moves (Move tool).
// `skew` (Cmd/Ctrl held) turns an edge-handle grab into a skew.
export function hitGizmo(
  handles: [number, number][],
  pt: [number, number],
  skew: boolean
): GizmoHit {
  let best = -1;
  let bestD = HANDLE_HIT;
  handles.forEach(([x, y], i) => {
    const d = Math.hypot(pt[0] - x, pt[1] - y);
    if (d <= bestD) {
      best = i;
      bestD = d;
    }
  });
  if (best >= 0) {
    return { kind: skew && best % 2 === 1 ? "skew" : "scale", handle: best };
  }
  const box = [handles[0], handles[2], handles[4], handles[6]];
  if (insidePolygon(pt, box)) return { kind: "move", handle: -1 };
  for (const [x, y] of box) {
    if (Math.hypot(pt[0] - x, pt[1] - y) <= ROTATE_RING) {
      return { kind: "rotate", handle: -1 };
    }
  }
  return { kind: "move", handle: -1 };
}

// CSS resize cursor for a handle, from its on-screen direction out of the
// box center (so a rotated box gets rotated cursors).
export function handleCursor(
  handles: [number, number][],
  handle: number
): string {
  const cx = (handles[0][0] + handles[4][0]) / 2;
  const cy = (handles[0][1] + handles[4][1]) / 2;
  const [hx, hy] = handles[handle];
  let deg = (Math.atan2(hy - cy, hx - cx) * 180) / Math.PI;
  deg = ((deg % 180) + 180) % 180;
  if (deg < 22.5 || deg >= 157.5) return "ew-resize";
  if (deg < 67.5) return "nwse-resize";
  if (deg < 112.5) return "ns-resize";
  return "nesw-resize";
}

// ── Readout: matrix ⇄ { center, angle, scale, shear } ────────────────

export interface TransformReadout {
  // Canvas px of the content center.
  x: number;
  y: number;
  // Degrees, clockwise on screen (canvas y-down).
  angle: number;
  // Percent of the source's native size; negative = flipped.
  w: number;
  h: number;
  // Shear, as m / sx (kept through edits so typing a value never drops a
  // skew).
  shear: number;
}

// matrix linear part = R(θ) · [[sx, m], [0, sy]].
export function readTransform(m: Affine, content: PxRect): TransformReadout {
  const [a, b, c, d] = m;
  const sx = Math.hypot(a, b);
  const theta = Math.atan2(b, a);
  const shear = sx > 0 ? (a * c + b * d) / sx : 0;
  const sy = sx > 0 ? (a * d - b * c) / sx : 0;
  const [x, y] = applyAffine(m, ...contentCenter(content));
  return {
    x,
    y,
    angle: (theta * 180) / Math.PI,
    w: sx * 100,
    h: sy * 100,
    shear: sx > 0 ? shear / sx : 0,
  };
}

export function buildTransform(r: TransformReadout, content: PxRect): Affine {
  const theta = (r.angle * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const sx = nonZero(r.w / 100);
  const sy = nonZero(r.h / 100);
  const m = r.shear * sx;
  const a = sx * cos;
  const b = sx * sin;
  const c = m * cos - sy * sin;
  const d = m * sin + sy * cos;
  const [lx, ly] = contentCenter(content);
  return [a, b, c, d, r.x - (a * lx + c * ly), r.y - (b * lx + d * ly)];
}

// Mirror about the content center, in the float's own frame.
export function flipTransform(
  m: Affine,
  content: PxRect,
  axis: "h" | "v"
): Affine {
  const [cx, cy] = contentCenter(content);
  return compose(m, scaleAbout(cx, cy, axis === "h" ? -1 : 1, axis === "v" ? -1 : 1));
}
