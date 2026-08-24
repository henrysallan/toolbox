// =====================================================================
// Spline → three conversion helpers (M6, 081026 spec)
// =====================================================================
//
// The authored→world mapping for the spline-to-3D bridges (Extrude
// Spline, Lathe). Authored spline space is [0,1]², Y-DOWN, ISOTROPIC in
// canvas-width units (y offsets scale by W just like x — see the aspect
// note in copy-to-points.ts), so the world mapping needs NO aspect
// correction: center at the authored midpoint, flip Y for world Y-up,
// scale by `size` world units per authored unit:
//
//   wx = (ax − 0.5) · size      wy = (0.5 − ay) · size
//
// Handles on SplineAnchor are RELATIVE offsets from pos (absent handle ⇒
// the control point IS the anchor — a straight segment), matching
// spline-raster.ts's Path2D construction.

import * as THREE from "three";
import type { SplineSubpath, SplineValue } from "./types";

function mapX(x: number, size: number): number {
  return (x - 0.5) * size;
}
function mapY(y: number, size: number): number {
  return (0.5 - y) * size;
}

// Append one subpath to a ShapePath (closing open subpaths — the fill
// convention; extrusion needs closed contours).
function appendSubpath(
  path: THREE.ShapePath,
  sub: SplineSubpath,
  size: number
): void {
  const a = sub.anchors;
  if (a.length < 2) return;
  path.moveTo(mapX(a[0].pos[0], size), mapY(a[0].pos[1], size));
  const segs = sub.closed ? a.length : a.length - 1;
  for (let i = 0; i < segs; i++) {
    const from = a[i];
    const to = a[(i + 1) % a.length];
    const c1x = from.outHandle ? from.pos[0] + from.outHandle[0] : from.pos[0];
    const c1y = from.outHandle ? from.pos[1] + from.outHandle[1] : from.pos[1];
    const c2x = to.inHandle ? to.pos[0] + to.inHandle[0] : to.pos[0];
    const c2y = to.inHandle ? to.pos[1] + to.inHandle[1] : to.pos[1];
    path.bezierCurveTo(
      mapX(c1x, size),
      mapY(c1y, size),
      mapX(c2x, size),
      mapY(c2y, size),
      mapX(to.pos[0], size),
      mapY(to.pos[1], size)
    );
  }
  // Open subpaths: ShapePath has no closePath; the extrude tessellator
  // closes the contour implicitly (Shape autoClose behavior at fill).
}

// All subpaths → THREE.Shape[] with winding-based hole assignment.
// User-drawn winding is arbitrary, so try both readings and keep the one
// that yields shapes; drawn-opposite-winding subpaths become holes
// (draw the hole the other way round — v1 caveat, spec M6).
export function splineToShapes(spline: SplineValue, size: number): THREE.Shape[] {
  const path = new THREE.ShapePath();
  let any = false;
  for (const sub of spline.subpaths) {
    if (sub.anchors.length >= 2) {
      appendSubpath(path, sub, size);
      any = true;
    }
  }
  if (!any) return [];
  const cw = path.toShapes(false);
  if (cw.length > 0) return cw;
  return path.toShapes(true);
}

// Sample one subpath's bezier chain to a world-space polyline —
// `perSegment` samples per bezier span. Used by Lathe's profile.
export function sampleSubpathWorld(
  sub: SplineSubpath,
  size: number,
  perSegment: number
): [number, number][] {
  const a = sub.anchors;
  if (a.length === 0) return [];
  if (a.length === 1) return [[mapX(a[0].pos[0], size), mapY(a[0].pos[1], size)]];
  const out: [number, number][] = [];
  const segs = sub.closed ? a.length : a.length - 1;
  out.push([mapX(a[0].pos[0], size), mapY(a[0].pos[1], size)]);
  for (let i = 0; i < segs; i++) {
    const from = a[i];
    const to = a[(i + 1) % a.length];
    const p0x = from.pos[0];
    const p0y = from.pos[1];
    const p1x = from.outHandle ? p0x + from.outHandle[0] : p0x;
    const p1y = from.outHandle ? p0y + from.outHandle[1] : p0y;
    const p3x = to.pos[0];
    const p3y = to.pos[1];
    const p2x = to.inHandle ? p3x + to.inHandle[0] : p3x;
    const p2y = to.inHandle ? p3y + to.inHandle[1] : p3y;
    for (let k = 1; k <= perSegment; k++) {
      const t = k / perSegment;
      const u = 1 - t;
      const x =
        u * u * u * p0x + 3 * u * u * t * p1x + 3 * u * t * t * p2x + t * t * t * p3x;
      const y =
        u * u * u * p0y + 3 * u * u * t * p1y + 3 * u * t * t * p2y + t * t * t * p3y;
      out.push([mapX(x, size), mapY(y, size)]);
    }
  }
  return out;
}
