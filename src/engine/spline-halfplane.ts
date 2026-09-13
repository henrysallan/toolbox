import { Bezier } from "bezier-js";
import type { SplineAnchor, SplineSubpath, SplineValue } from "./types";
import { subpathToBeziers } from "./spline-math";
import { cubicsToSubpath } from "./spline-trim";

// Axis-aligned half-plane clip for Mirror's bisect mode. Keep the side
// named by `keep`, cut cubics that cross the plane, and leave originally
// closed subpaths that get cut as open arcs (endpoints on the plane so a
// later fill auto-closes along the chord). Open strokes stay open.

export const HALFPLANE_KEEP = ["x", "-x", "y", "-y"] as const;
export type HalfplaneKeep = (typeof HALFPLANE_KEEP)[number];

export function isHalfplaneKeep(v: unknown): v is HalfplaneKeep {
  return typeof v === "string" && (HALFPLANE_KEEP as readonly string[]).includes(v);
}

export function halfplaneAxis(keep: HalfplaneKeep): "x" | "y" {
  return keep === "y" || keep === "-y" ? "y" : "x";
}

export function onKeepSide(
  x: number,
  y: number,
  keep: HalfplaneKeep,
  cx: number,
  cy: number
): boolean {
  switch (keep) {
    case "x":
      return x >= cx;
    case "-x":
      return x <= cx;
    case "y":
      return y >= cy;
    case "-y":
      return y <= cy;
  }
}

export function onMirrorPlane(
  x: number,
  y: number,
  keep: HalfplaneKeep,
  cx: number,
  cy: number,
  eps = 1e-9
): boolean {
  return halfplaneAxis(keep) === "x" ? Math.abs(x - cx) <= eps : Math.abs(y - cy) <= eps;
}

function withSubpathMeta(dst: SplineSubpath, src: SplineSubpath): SplineSubpath {
  if (src.groupIndex === undefined && src.driver === undefined && !src.attrs) {
    return dst;
  }
  const out: SplineSubpath = { ...dst };
  if (src.groupIndex !== undefined) out.groupIndex = src.groupIndex;
  if (src.driver !== undefined) out.driver = src.driver;
  if (src.attrs) out.attrs = src.attrs;
  return out;
}

function snapPieceToPlane(
  piece: SplineSubpath,
  keep: HalfplaneKeep,
  cx: number,
  cy: number
): void {
  const axis = halfplaneAxis(keep);
  const plane = axis === "x" ? cx : cy;
  const snap = (a: SplineAnchor) => {
    const coord = axis === "x" ? a.pos[0] : a.pos[1];
    if (Math.abs(coord - plane) > 1e-5) return;
    if (axis === "x") a.pos = [plane, a.pos[1]];
    else a.pos = [a.pos[0], plane];
  };
  const n = piece.anchors.length;
  if (n === 0) return;
  snap(piece.anchors[0]);
  if (n > 1) snap(piece.anchors[n - 1]);
}

function cubicPlaneHits(curve: Bezier, axis: "x" | "y", plane: number): number[] {
  const line =
    axis === "x"
      ? { p1: { x: plane, y: -1e3 }, p2: { x: plane, y: 1e3 } }
      : { p1: { x: -1e3, y: plane }, p2: { x: 1e3, y: plane } };
  const ts = curve.getUtils().roots(curve.points, line);
  const out: number[] = [];
  for (const t of ts) {
    if (!Number.isFinite(t) || t < -1e-9 || t > 1 + 1e-9) continue;
    out.push(Math.max(0, Math.min(1, t)));
  }
  return out;
}

export function clipSplineByHalfPlane(
  spline: SplineValue,
  keep: HalfplaneKeep,
  cx: number,
  cy: number
): SplineValue {
  if (spline.subpaths.length === 0) return spline;
  const axis = halfplaneAxis(keep);
  const plane = axis === "x" ? cx : cy;
  const out: SplineSubpath[] = [];

  for (const sub of spline.subpaths) {
    const segs = subpathToBeziers(sub);
    const segCount = segs.length;
    if (segCount === 0) continue;

    const cuts: number[] = [];
    for (let si = 0; si < segCount; si++) {
      for (const t of cubicPlaneHits(segs[si].curve, axis, plane)) {
        const g = si + t;
        if (sub.closed) {
          cuts.push(g >= segCount - 1e-6 ? 0 : g);
        } else if (g > 1e-6 && g < segCount - 1e-6) {
          cuts.push(g);
        }
      }
    }
    cuts.sort((a, b) => a - b);
    const unique: number[] = [];
    for (const g of cuts) {
      if (unique.length === 0 || g - unique[unique.length - 1] > 1e-3) {
        unique.push(g);
      }
    }
    if (
      sub.closed &&
      unique.length >= 2 &&
      unique[0] <= 1e-3 &&
      unique[unique.length - 1] >= segCount - 1e-3
    ) {
      unique.pop();
    }

    const midOf = (g: number): { x: number; y: number } => {
      const raw = ((g % segCount) + segCount) % segCount;
      const gi = Math.min(segCount - 1, Math.floor(raw));
      const t = raw - gi;
      const p = segs[gi].curve.get(t);
      return { x: p.x, y: p.y };
    };
    const keepPiece = (g: number) => {
      const p = midOf(g);
      return onKeepSide(p.x, p.y, keep, cx, cy);
    };

    if (unique.length === 0) {
      if (keepPiece(segCount / 2)) out.push(sub);
      continue;
    }

    const spans: Array<[number, number]> = [];
    if (sub.closed) {
      for (let i = 0; i < unique.length; i++) {
        const ga = unique[i];
        const gb = i + 1 < unique.length ? unique[i + 1] : segCount + unique[0];
        spans.push([ga, gb]);
      }
    } else {
      spans.push([0, unique[0]]);
      for (let i = 0; i + 1 < unique.length; i++) {
        spans.push([unique[i], unique[i + 1]]);
      }
      spans.push([unique[unique.length - 1], segCount]);
    }

    for (const [ga, gb] of spans) {
      if (gb - ga <= 1e-6) continue;
      if (!keepPiece((ga + gb) / 2)) continue;
      const curves: Bezier[] = [];
      for (let gi = Math.floor(ga); gi < gb - 1e-9; gi++) {
        const idx = gi % segCount;
        const lo = Math.max(0, ga - gi);
        const hi = Math.min(1, gb - gi);
        if (hi - lo <= 1e-6) continue;
        curves.push(
          lo <= 1e-9 && hi >= 1 - 1e-9
            ? segs[idx].curve
            : segs[idx].curve.split(lo, hi)
        );
      }
      const piece = cubicsToSubpath(curves);
      if (piece && piece.anchors.length >= 2) {
        snapPieceToPlane(piece, keep, cx, cy);
        out.push(withSubpathMeta(piece, sub));
      }
    }
  }

  return { kind: "spline", subpaths: out };
}
