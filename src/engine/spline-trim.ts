import { Bezier } from "bezier-js";
import type { SplineAnchor, SplineSubpath, SplineValue } from "./types";
import {
  measureSpline,
  sampleAttrsOntoAnchors,
  subpathToCurves,
  type SplineLengths,
  type SubpathLengths,
} from "./spline-math";
import {
  cubicArcLength,
  cubicParamAtLength,
  cubicSpeed,
  type CubicSpeed,
} from "./cubic-arc-length";
import {
  makeSubpathDriverFn,
  type ColorRampBy,
} from "./spline-color-source";

// Trim Paths — keep only the arc-length window [start, end] of a spline.
// Combined mode (default) measures across ALL subpaths concatenated into one
// length domain (After Effects "Trim Paths → Trim Multiple Shapes:
// Simultaneously"). Per-subpath mode runs the same window on each subpath's
// own length (AE "Individually"), with start/end/offset optionally sourced
// per subpath from a named attribute or the shared driver keys (index /
// random / group / position / driver). Animating the window (keyframed
// scalars) draws a stroke on/off. An optional `offset` slides the whole
// window along the domain cyclically (AE's Offset): the window wraps at the
// ends, so a shifted window can straddle the seam — part re-emerging at the
// start while the rest still shows at the end. Offset is unbounded (taken
// mod 1), so keyframing 0→N loops the trim N times. Pure, engine-side; the
// boundary cubics are split with bezier-js. See
// specdocs/archive/062526_node-expansion.md.
//
// Two measures place a fraction on the path:
//   arc length  the exact arc-length point (cubic-arc-length.ts). What
//               React Native Skia's <Path start end> and After Effects do,
//               and what Trim Path nodes made since 2026-10-16 use.
//   segment     the original (pre-2026-10-16) mapping, kept bit-for-bit so
//               saved Trim Paths and the primitives' bundled trim sliders
//               keep their timing: the fraction picks its segment by
//               bezier-js arc length, then lands at the curve parameter
//               t = (length into the segment) / (segment length). A cubic's
//               parameter is not its length, so the cut drifts inside each
//               segment — on a handle-less line it runs along the
//               smoothstep 3t² − 2t³ (up to ~10 % of that segment's length
//               away from the true point), on a curve with uneven handles
//               further.

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export const TRIM_MEASURES = ["arc length", "segment"] as const;
export type TrimMeasure = (typeof TRIM_MEASURES)[number];

// Per-subpath measurement plus, in the arc-length measure, each segment's
// speed polynomial (the inverse length → t needs it at the cut segments).
interface TrimLengths extends SplineLengths {
  speeds: CubicSpeed[][] | null;
}

// measureSpline's shape with every segment measured by cubicArcLength, so
// the window's fractions and the cut inside a segment share one integrator.
function measureSplineArc(subpaths: SplineSubpath[]): TrimLengths {
  const perSubpath: SubpathLengths[] = [];
  const offsets: number[] = [];
  const speeds: CubicSpeed[][] = [];
  let acc = 0;
  for (const sub of subpaths) {
    const curves = subpathToCurves(sub);
    const segments: SubpathLengths["segments"] = [];
    const cumulative: number[] = [];
    const subSpeeds: CubicSpeed[] = [];
    let subAcc = 0;
    for (const curve of curves) {
      const k = cubicSpeed(curve);
      const length = cubicArcLength(k);
      segments.push({ curve, length });
      subSpeeds.push(k);
      subAcc += length;
      cumulative.push(subAcc);
    }
    offsets.push(acc);
    perSubpath.push({ segments, cumulative, total: subAcc });
    speeds.push(subSpeeds);
    acc += subAcc;
  }
  return { perSubpath, offsets, total: acc, speeds };
}

function measureTrim(subpaths: SplineSubpath[], measure: TrimMeasure): TrimLengths {
  if (measure === "arc length") return measureSplineArc(subpaths);
  return { ...measureSpline({ kind: "spline", subpaths } as SplineValue), speeds: null };
}

export const TRIM_SOURCES = [
  "value",
  "attribute",
  "index",
  "random",
  "group",
  "position",
  "driver",
] as const;
export type TrimSource = (typeof TRIM_SOURCES)[number];

function isTrimSource(v: unknown): v is TrimSource {
  return typeof v === "string" && (TRIM_SOURCES as readonly string[]).includes(v);
}

// Carry groupIndex / driver / named attrs onto a cut piece. Trim is a
// window on the same subpath, not a new identity.
function withSubpathMeta(dst: SplineSubpath, src: SplineSubpath): SplineSubpath {
  if (
    src.groupIndex === undefined &&
    src.driver === undefined &&
    !src.attrs
  ) {
    return dst;
  }
  const out: SplineSubpath = { ...dst };
  if (src.groupIndex !== undefined) out.groupIndex = src.groupIndex;
  if (src.driver !== undefined) out.driver = src.driver;
  if (src.attrs) out.attrs = src.attrs;
  return out;
}

// Named subpath channel → scalar. Vectors contribute component 0. Missing
// or empty name returns undefined so the caller can fall back to the slider.
export function readSubpathAttrScalar(
  sub: SplineSubpath,
  name: string
): number | undefined {
  const n = name.trim();
  if (!n) return undefined;
  const v = sub.attrs?.[n];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (Array.isArray(v) && typeof v[0] === "number" && Number.isFinite(v[0])) {
    return v[0];
  }
  return undefined;
}

export function makeTrimSourceFn(
  subpaths: SplineSubpath[],
  source: unknown,
  fallback: number,
  opts: { attrName?: string; seed?: number; angleDeg?: number } = {}
): (i: number, sub: SplineSubpath) => number {
  const src: TrimSource = isTrimSource(source) ? source : "value";
  if (src === "value") return () => fallback;
  if (src === "attribute") {
    const name = opts.attrName ?? "";
    return (_i, sub) => readSubpathAttrScalar(sub, name) ?? fallback;
  }
  const driverAt = makeSubpathDriverFn(subpaths, {
    by: src as ColorRampBy,
    seed: opts.seed ?? 0,
    angleDeg: opts.angleDeg ?? 0,
  });
  return driverAt;
}

// Rebuild an OPEN subpath from a contiguous chain of bezier-js cubics. Each
// cubic contributes its endpoint as an anchor; in/out handles come from the
// adjacent control points — the same reconstruction `offsetSubpath` uses.
// Exported for the other cut-a-curve consumers (spline-boolean's line mode).
export function cubicsToSubpath(curves: Bezier[]): SplineSubpath | null {
  if (curves.length === 0) return null;
  const anchors: SplineAnchor[] = [];
  const head = curves[0].points;
  anchors.push({
    pos: [head[0].x, head[0].y],
    outHandle: [head[1].x - head[0].x, head[1].y - head[0].y],
  });
  for (let i = 0; i < curves.length; i++) {
    const p = curves[i].points;
    const endAnchor: SplineAnchor = {
      pos: [p[3].x, p[3].y],
      inHandle: [p[2].x - p[3].x, p[2].y - p[3].y],
    };
    const next = curves[i + 1];
    if (next) {
      const nc1 = next.points[1];
      endAnchor.outHandle = [nc1.x - p[3].x, nc1.y - p[3].y];
    }
    anchors.push(endAnchor);
  }
  return { anchors, closed: false };
}

// Extract the portion of `sub` between arc lengths [lo, hi] in the subpath's
// OWN length domain (`m`, its measurement; `speeds` its segments' speed
// polynomials in the arc-length measure, null in the segment measure). Each
// segment is clipped to the window independently (a boundary that lands on
// a segment join is handled by adjacent clips — no degenerate split(1,1) at
// the seam). Returns an open subpath, or null when the window is degenerate.
function trimSubpathByLength(
  sub: SplineSubpath,
  m: SubpathLengths,
  speeds: CubicSpeed[] | null,
  lo: number,
  hi: number
): SplineSubpath | null {
  if (m.total <= 0 || m.segments.length === 0) return null;
  lo = Math.max(0, Math.min(m.total, lo));
  hi = Math.max(0, Math.min(m.total, hi));
  if (hi - lo <= 1e-9) return null;

  const curves: Bezier[] = [];
  let prevCum = 0;
  for (let i = 0; i < m.segments.length; i++) {
    const seg = m.segments[i];
    const cum = m.cumulative[i];
    // Overlap of [lo,hi] with this segment's arc range [prevCum, cum].
    if (seg.length > 1e-12 && hi > prevCum && lo < cum) {
      // Length into the segment → curve parameter: exact arc length, or
      // the segment measure's linear map (see the header).
      const k = speeds?.[i];
      const toT = (len: number): number =>
        k ? cubicParamAtLength(k, len, seg.length) : clamp01(len / seg.length);
      const segLo = toT(lo - prevCum);
      const segHi = toT(hi - prevCum);
      if (segHi - segLo > 1e-6) {
        // Whole segment → use it directly; otherwise split out the sub-arc.
        curves.push(
          segLo <= 0 && segHi >= 1 ? seg.curve : seg.curve.split(segLo, segHi)
        );
      }
    }
    prevCum = cum;
  }
  const dst = cubicsToSubpath(curves);
  if (!dst) return null;
  const total = m.total;
  sampleAttrsOntoAnchors(sub, dst.anchors, lo / total, hi / total);
  return dst;
}

// Extract one non-wrapping window [s, e] (fractions, 0 ≤ s < e ≤ 1) using a
// pre-computed measurement. The per-subpath loop of the original trim.
function trimWindow(
  subpaths: SplineSubpath[],
  lengths: TrimLengths,
  s: number,
  e: number
): SplineSubpath[] {
  const total = lengths.total;
  const loLen = s * total;
  const hiLen = e * total;

  const out: SplineSubpath[] = [];
  for (let i = 0; i < subpaths.length; i++) {
    const subStart = lengths.offsets[i];
    const subTotal = lengths.perSubpath[i].total;
    if (subTotal <= 0) continue;
    const subEnd = subStart + subTotal;
    const lo = Math.max(loLen, subStart);
    const hi = Math.min(hiLen, subEnd);
    if (hi - lo <= 1e-9) continue; // no overlap with this subpath
    if (lo <= subStart + 1e-9 && hi >= subEnd - 1e-9) {
      out.push(subpaths[i]); // wholly inside — keep as-is (closed preserved)
      continue;
    }
    const trimmed = trimSubpathByLength(
      subpaths[i],
      lengths.perSubpath[i],
      lengths.speeds?.[i] ?? null,
      lo - subStart,
      hi - subStart
    );
    if (trimmed && trimmed.anchors.length >= 2) {
      out.push(withSubpathMeta(trimmed, subpaths[i]));
    }
  }
  return out;
}

// Join two open cut pieces that meet at the wrap seam into one continuous
// open subpath: `a` ends exactly where `b` begins (the closed loop's own
// start/end anchor), so the joint anchor takes a's arriving in-handle and
// b's departing out-handle.
function joinAtSeam(a: SplineSubpath, b: SplineSubpath): SplineSubpath {
  const aEnd = a.anchors[a.anchors.length - 1];
  const bStart = b.anchors[0];
  const joint: SplineAnchor = { pos: bStart.pos };
  if (aEnd.inHandle) joint.inHandle = aEnd.inHandle;
  if (bStart.outHandle) joint.outHandle = bStart.outHandle;
  return withSubpathMeta(
    {
      anchors: [...a.anchors.slice(0, -1), joint, ...b.anchors.slice(1)],
      closed: false,
    },
    a
  );
}

// Trim a spline (as subpaths) to the arc-length fraction window [start, end],
// optionally slid along the domain by `offset` (cyclic, any value — taken
// mod 1). A partially-included closed subpath becomes open. When the shifted
// window wraps past the end of the domain it re-enters at the start, emitting
// the tail piece then the head piece; if the seam falls inside a single
// closed loop the two pieces are stitched into one continuous subpath (so a
// stroke sliding around a circle never shows cap breaks). Returns the input
// unchanged when not trimming (identity fast-path), or [] when the window is
// empty (including start >= end). `measure` places the fractions on the path
// (see the header); the window math above is the same in both.
export function trimSubpaths(
  subpaths: SplineSubpath[],
  start: number,
  end: number,
  offset = 0,
  measure: TrimMeasure = "arc length"
): SplineSubpath[] {
  if (!subpaths || subpaths.length === 0) return subpaths;
  const s = clamp01(Number.isFinite(start) ? start : 0);
  const e = clamp01(Number.isFinite(end) ? end : 1);
  if (s <= 0 && e >= 1) return subpaths; // full window — offset can't matter
  if (e - s <= 1e-9) return []; // empty window

  const oRaw = Number.isFinite(offset) ? offset : 0;
  let o = oRaw - Math.floor(oRaw); // wrap to [0, 1)
  if (o <= 1e-9 || o >= 1 - 1e-9) o = 0;

  const lengths = measureTrim(subpaths, measure);
  if (lengths.total <= 0) return subpaths;
  if (o === 0) return trimWindow(subpaths, lengths, s, e);

  let lo = s + o;
  if (lo >= 1) lo -= 1; // s ≤ 1 and o < 1, so one subtract re-enters [0, 1)
  const hi = lo + (e - s);
  if (hi <= 1) return trimWindow(subpaths, lengths, lo, hi);

  // Window straddles the seam: emit [lo, 1] then [0, hi−1].
  const tail = 1 - lo > 1e-9 ? trimWindow(subpaths, lengths, lo, 1) : [];
  const head = hi - 1 > 1e-9 ? trimWindow(subpaths, lengths, 0, hi - 1) : [];

  // The seam joins the END of the last nonzero-length subpath to the START
  // of the first — the same physical point only when they're one closed
  // loop. (Both pieces are then guaranteed genuine open cuts: a window with
  // an interior edge can't wholly contain a subpath spanning the domain.)
  let firstIdx = -1;
  let lastIdx = -1;
  for (let i = 0; i < subpaths.length; i++) {
    if (lengths.perSubpath[i].total <= 0) continue;
    if (firstIdx < 0) firstIdx = i;
    lastIdx = i;
  }
  const seamInsideLoop =
    firstIdx >= 0 && firstIdx === lastIdx && !!subpaths[firstIdx].closed;
  if (seamInsideLoop && tail.length > 0 && head.length > 0) {
    return [
      ...tail.slice(0, -1),
      joinAtSeam(tail[tail.length - 1], head[0]),
      ...head.slice(1),
    ];
  }
  return [...tail, ...head];
}

// Per-subpath trim: each subpath is its own length domain. Resolvers supply
// that subpath's start / end / offset (uniform sliders, a named attribute,
// or a shared driver key). Empty windows drop the subpath.
export function trimSubpathsEach(
  subpaths: SplineSubpath[],
  startAt: (i: number, sub: SplineSubpath) => number,
  endAt: (i: number, sub: SplineSubpath) => number,
  offsetAt: (i: number, sub: SplineSubpath) => number,
  measure: TrimMeasure = "arc length"
): SplineSubpath[] {
  if (!subpaths || subpaths.length === 0) return subpaths;
  const out: SplineSubpath[] = [];
  for (let i = 0; i < subpaths.length; i++) {
    const sub = subpaths[i];
    const trimmed = trimSubpaths(
      [sub],
      startAt(i, sub),
      endAt(i, sub),
      offsetAt(i, sub),
      measure
    );
    for (let j = 0; j < trimmed.length; j++) out.push(trimmed[j]);
  }
  return out;
}
