import type { SplineSubpath } from "./types";
import { hexToRgba } from "./spline-raster";
import {
  sampleColorRamp,
  type ColorRampInterp,
  type ColorRampStop,
} from "./color-ramp";

// Per-subpath color sourcing, shared by Rasterize Spline's fill and the Stroke
// node's stroke color. A spline can carry many subpaths (Copy to Points, SVG
// glyphs, Spline Merge Flow regions); this resolves each subpath's color from
// a flat value or a color ramp keyed by ordinal index, a seeded hash, the
// subpath's groupIndex, its centroid projected on a steerable axis, or the
// producer-authored `driver` scalar carried on the subpath itself (e.g.
// Space Fill's per-line weight — 072726_space-fill.md).
//
// Engine-side (invariant #1) so it stays in the export bundle. Returns an
// `rgba(...)` string ready for a Canvas2D fillStyle/strokeStyle.

export type ColorRampBy = "index" | "random" | "group" | "position" | "driver";

export interface SubpathColorConfig {
  source: "flat" | "ramp";
  flatColor: string; // hex (or any CSS color hexToRgba accepts)
  stops: ColorRampStop[];
  by: ColorRampBy;
  seed: number;
  angleDeg: number; // gradient axis for `position` mode
  interp: ColorRampInterp;
}

// Deterministic per-subpath hash → [0, 1) for the "random" mode. Index-stable
// so a static spline keeps its color assignment; the seed reshuffles. Same mix
// as Copy to Points' hash01.
export function hash01(index: number, seed: number): number {
  let h = (index * 374761393 + seed * 668265263) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

// Mean anchor position (normalized [0,1] Y-DOWN) — a cheap centroid stand-in.
// Used by `position` mode so color keys on WHERE a region sits rather than its
// array index, staying stable when the subpath count/order churns frame to
// frame (e.g. Spline Merge Flow re-extracts its contours every frame).
function subpathCentroid(sub: SplineSubpath): [number, number] {
  const a = sub.anchors;
  if (a.length === 0) return [0.5, 0.5];
  let cx = 0;
  let cy = 0;
  for (const an of a) {
    cx += an.pos[0];
    cy += an.pos[1];
  }
  return [cx / a.length, cy / a.length];
}

// The driver half of per-subpath sourcing: resolve each subpath's t in
// [0,1] from the configured `by` mode. Shared by the color source below
// and Stroke's per-subpath thickness (any future per-subpath channel
// should key off this too, so index/random/group/position mean the same
// thing everywhere). Spec: 071826_copy-identity-stroke-width.md.
export interface SubpathDriverConfig {
  by: ColorRampBy;
  seed: number;
  angleDeg: number; // gradient axis for `position` mode
}

export function makeSubpathDriverFn(
  subpaths: SplineSubpath[],
  cfg: SubpathDriverConfig
): (i: number, sub: SplineSubpath) => number {
  const by = cfg.by ?? "index";
  const seed = Math.floor(cfg.seed ?? 0);
  const angleRad = ((cfg.angleDeg ?? 0) * Math.PI) / 180;
  const N = subpaths.length;

  let groups: number[] = [];
  if (by === "group") {
    const set = new Set<number>();
    for (const s of subpaths) set.add(s.groupIndex ?? 0);
    groups = Array.from(set).sort((a, b) => a - b);
  }

  // position mode: project each centroid onto the gradient axis, normalized so
  // the unit square maps to [0,1] exactly (no overshoot at diagonal angles).
  const ca = Math.cos(angleRad);
  const sa = Math.sin(angleRad);
  const projHalf = 0.5 * (Math.abs(ca) + Math.abs(sa)) || 1;

  return (i, sub) => {
    if (by === "random") return hash01(i, seed);
    if (by === "driver") {
      // Producer-authored scalar; subpaths without one sit at mid-ramp.
      const d = sub.driver;
      return typeof d === "number" && Number.isFinite(d)
        ? Math.min(1, Math.max(0, d))
        : 0.5;
    }
    if (by === "group") {
      const gi = groups.indexOf(sub.groupIndex ?? 0);
      return groups.length > 1 ? gi / (groups.length - 1) : 0;
    }
    if (by === "position") {
      const [cx, cy] = subpathCentroid(sub);
      const proj = (cx - 0.5) * ca + (cy - 0.5) * sa;
      return Math.min(1, Math.max(0, 0.5 + proj / (2 * projHalf)));
    }
    return N > 1 ? i / (N - 1) : 0;
  };
}

// Build a per-subpath color resolver over `subpaths`. With `source: "flat"`
// every subpath gets the flat color; with `"ramp"` each subpath samples the
// ramp by the configured `by` mode.
export function makeSubpathColorFn(
  subpaths: SplineSubpath[],
  cfg: SubpathColorConfig
): (i: number, sub: SplineSubpath) => string {
  const flat = hexToRgba(cfg.flatColor ?? "#ffffff");
  if (cfg.source !== "ramp") return () => flat;

  const stops = Array.isArray(cfg.stops) ? cfg.stops : [];
  const interp = cfg.interp ?? "linear";
  const driverAt = makeSubpathDriverFn(subpaths, cfg);
  return (i, sub) => sampleColorRamp(stops, driverAt(i, sub), interp);
}
