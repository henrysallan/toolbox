import type { NodeOutput, Point, SocketValue, SplineValue } from "./types";

// Shared pivot-space math for the Transform node and its on-canvas gizmo.
// Global: pivot X/Y are canvas coords. Local: they are a fraction of the
// incoming geometry's bounding box (0.5, 0.5 = its center), so rotate/scale
// stay about the shape when upstream placement changes.

export type AABB = { minX: number; minY: number; maxX: number; maxY: number };

export function isLocalPivotSpace(space: unknown): boolean {
  return space === "local";
}

export function localPivot(
  bbox: AABB | null,
  pivotX: number,
  pivotY: number
): { x: number; y: number } {
  if (!bbox || bbox.maxX <= bbox.minX || bbox.maxY <= bbox.minY) {
    return { x: pivotX, y: pivotY };
  }
  return {
    x: bbox.minX + pivotX * (bbox.maxX - bbox.minX),
    y: bbox.minY + pivotY * (bbox.maxY - bbox.minY),
  };
}

export function splineAABB(s: SplineValue): AABB | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const sub of s.subpaths) {
    for (const a of sub.anchors) {
      if (a.pos[0] < minX) minX = a.pos[0];
      if (a.pos[0] > maxX) maxX = a.pos[0];
      if (a.pos[1] < minY) minY = a.pos[1];
      if (a.pos[1] > maxY) maxY = a.pos[1];
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

export function pointsAABB(pts: Point[]): AABB | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.pos[0] < minX) minX = p.pos[0];
    if (p.pos[0] > maxX) maxX = p.pos[0];
    if (p.pos[1] < minY) minY = p.pos[1];
    if (p.pos[1] > maxY) maxY = p.pos[1];
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

export function pointsPositionsAABB(
  positions: Float32Array,
  count: number
): AABB | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 2];
    const y = positions[i * 2 + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

export function geometryAABB(v: SocketValue | undefined): AABB | null {
  if (v?.kind === "spline") return splineAABB(v);
  if (v?.kind === "points") return pointsPositionsAABB(v.positions, v.count);
  return null;
}

export function socketValueFromOutput(
  output: NodeOutput | undefined,
  sourceHandle: string | undefined
): SocketValue | undefined {
  if (!output) return undefined;
  if (sourceHandle?.startsWith("out:aux:")) {
    return output.aux?.[sourceHandle.slice("out:aux:".length)];
  }
  return output.primary;
}

export function geometryAABBFromOutput(
  output: NodeOutput | undefined,
  sourceHandle: string | undefined
): AABB | null {
  return geometryAABB(socketValueFromOutput(output, sourceHandle));
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// Keep the visual pivot still when the user flips Canvas ↔ Source.
// Global→local stores the current canvas point as a bbox fraction;
// local→global writes that fraction back out as canvas coords.
export function remapPivotForSpaceChange(
  from: unknown,
  to: unknown,
  pivotX: number,
  pivotY: number,
  bbox: AABB | null
): { pivotX: number; pivotY: number } | null {
  const fromLocal = isLocalPivotSpace(from);
  const toLocal = isLocalPivotSpace(to);
  if (fromLocal === toLocal || !bbox) return null;
  if (toLocal) {
    const w = bbox.maxX - bbox.minX;
    const h = bbox.maxY - bbox.minY;
    if (w <= 0 || h <= 0) return null;
    return {
      pivotX: clamp01((pivotX - bbox.minX) / w),
      pivotY: clamp01((pivotY - bbox.minY) / h),
    };
  }
  const p = localPivot(bbox, pivotX, pivotY);
  return { pivotX: p.x, pivotY: p.y };
}
