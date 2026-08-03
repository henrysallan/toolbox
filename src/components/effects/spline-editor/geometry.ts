// Pure geometry helpers for the Spline Draw editor overlay (spline-editor/).
// No React, no refs — everything here takes explicit inputs. Split out of the
// monolith in M0 of specdocs/071926_spline-draw-authoring-upgrade.md.

import type { SplineAnchor, SplineSubpath } from "@/engine/types";
import type { SplineParamValue } from "@/nodes/source/spline-draw";

// `subpathsOf` copes with legacy save data where the param envelope was
// missing `subpaths` entirely. Treating that case as "no anchors yet" lets
// old projects load without crashing.
export const subpathsOf = (
  v: SplineParamValue | undefined | null
): SplineSubpath[] => v?.subpaths ?? [];

// Stable anchor identity (spec 072726 M6): a short random slug, minted by
// every op that creates an anchor. Keys the per-anchor keyframe tracks.
export function mintAnchorId(): string {
  return Math.random().toString(36).slice(2, 9);
}

// --- pure bezier helpers (px or norm, caller-consistent) -------------------

export function bezierAt(
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  t: number
): [number, number] {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return [
    w0 * p0[0] + w1 * p1[0] + w2 * p2[0] + w3 * p3[0],
    w0 * p0[1] + w1 * p1[1] + w2 * p2[1] + w3 * p3[1],
  ];
}

// Coarse-to-fine nearest-point projection onto a cubic. Returns the
// parameter t minimizing distance to `target`. Operates in whatever space
// the control points are given in (we feed it pixels so "nearest" matches
// what the user sees on a non-square canvas).
export function nearestTOnCubic(
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  target: [number, number]
): number {
  const dist2 = (t: number) => {
    const b = bezierAt(p0, p1, p2, p3, t);
    const dx = b[0] - target[0];
    const dy = b[1] - target[1];
    return dx * dx + dy * dy;
  };
  let bestT = 0;
  let bestD = Infinity;
  const N = 24;
  for (let k = 0; k <= N; k++) {
    const t = k / N;
    const d = dist2(t);
    if (d < bestD) {
      bestD = d;
      bestT = t;
    }
  }
  const lo = Math.max(0, bestT - 1 / N);
  const hi = Math.min(1, bestT + 1 / N);
  const M = 20;
  for (let k = 0; k <= M; k++) {
    const t = lo + ((hi - lo) * k) / M;
    const d = dist2(t);
    if (d < bestD) {
      bestD = d;
      bestT = t;
    }
  }
  return bestT;
}

export const vlen = (v: [number, number]) => Math.hypot(v[0], v[1]);

// Build an SVG path string for one subpath, mapping each normalized point to
// screen px via `toPx`. Shared by the active-subpath preview and the muted
// inactive-subpath outlines. Returns "" for subpaths with < 2 anchors.
export function subpathToPathD(
  anchors: SplineAnchor[],
  closed: boolean,
  toPx: (p: [number, number]) => { x: number; y: number }
): string {
  if (anchors.length < 2) return "";
  const firstPx = toPx(anchors[0].pos);
  let d = `M ${firstPx.x} ${firstPx.y}`;
  for (let i = 1; i < anchors.length; i++) {
    const prev = anchors[i - 1];
    const cur = anchors[i];
    const cp1 = prev.outHandle
      ? toPx([prev.pos[0] + prev.outHandle[0], prev.pos[1] + prev.outHandle[1]])
      : toPx(prev.pos);
    const cp2 = cur.inHandle
      ? toPx([cur.pos[0] + cur.inHandle[0], cur.pos[1] + cur.inHandle[1]])
      : toPx(cur.pos);
    const end = toPx(cur.pos);
    d += ` C ${cp1.x} ${cp1.y}, ${cp2.x} ${cp2.y}, ${end.x} ${end.y}`;
  }
  if (closed) {
    const last = anchors[anchors.length - 1];
    const a0 = anchors[0];
    const cp1 = last.outHandle
      ? toPx([last.pos[0] + last.outHandle[0], last.pos[1] + last.outHandle[1]])
      : toPx(last.pos);
    const cp2 = a0.inHandle
      ? toPx([a0.pos[0] + a0.inHandle[0], a0.pos[1] + a0.inHandle[1]])
      : toPx(a0.pos);
    const end = toPx(a0.pos);
    d += ` C ${cp1.x} ${cp1.y}, ${cp2.x} ${cp2.y}, ${end.x} ${end.y} Z`;
  }
  return d;
}

// Common tangent axis (unit) for an anchor's handles: average of the out
// direction and the negated in direction (both point "along" the tangent).
export function handleAxis(a: SplineAnchor): [number, number] | null {
  let ax = 0;
  let ay = 0;
  if (a.outHandle) {
    const m = vlen(a.outHandle) || 1;
    ax += a.outHandle[0] / m;
    ay += a.outHandle[1] / m;
  }
  if (a.inHandle) {
    const m = vlen(a.inHandle) || 1;
    ax += -a.inHandle[0] / m;
    ay += -a.inHandle[1] / m;
  }
  const m = Math.hypot(ax, ay);
  if (m < 1e-6) {
    // Handles already directly opposed (cancel out) or degenerate — fall
    // back to whichever handle exists.
    if (a.outHandle) {
      const om = vlen(a.outHandle) || 1;
      return [a.outHandle[0] / om, a.outHandle[1] / om];
    }
    if (a.inHandle) {
      const im = vlen(a.inHandle) || 1;
      return [-a.inHandle[0] / im, -a.inHandle[1] / im];
    }
    return null;
  }
  return [ax / m, ay / m];
}

// "Align handles": make the two handles collinear (opposite directions),
// keeping each one's current length. Re-links the anchor to smooth.
export function alignHandles(a: SplineAnchor): SplineAnchor {
  if (!a.inHandle && !a.outHandle) return a;
  const axis = handleAxis(a);
  if (!axis) return a;
  const next: SplineAnchor = { ...a, broken: false };
  const lOut = a.outHandle ? vlen(a.outHandle) : a.inHandle ? vlen(a.inHandle) : 0;
  const lIn = a.inHandle ? vlen(a.inHandle) : a.outHandle ? vlen(a.outHandle) : 0;
  next.outHandle = [axis[0] * lOut, axis[1] * lOut];
  next.inHandle = [-axis[0] * lIn, -axis[1] * lIn];
  return next;
}

// "Even handles": collinear AND equal length (a perfect mirror), using the
// average of the present handle lengths. Re-links the anchor to smooth.
export function evenHandles(a: SplineAnchor): SplineAnchor {
  if (!a.inHandle && !a.outHandle) return a;
  const axis = handleAxis(a);
  if (!axis) return a;
  const lens: number[] = [];
  if (a.outHandle) lens.push(vlen(a.outHandle));
  if (a.inHandle) lens.push(vlen(a.inHandle));
  const L = lens.reduce((s, x) => s + x, 0) / lens.length;
  return {
    ...a,
    broken: false,
    outHandle: [axis[0] * L, axis[1] * L],
    inHandle: [-axis[0] * L, -axis[1] * L],
  };
}

// Reverse a subpath's travel direction: reverse anchor order AND swap each
// anchor's in/out handle (the outgoing control of a forward traversal is the
// incoming one walked backward) — identical geometry, flipped direction.
// All other anchor fields (broken, cornerRadius) ride along.
export function reverseSubpathAnchors(anchors: SplineAnchor[]): SplineAnchor[] {
  return anchors
    .slice()
    .reverse()
    .map((a) => ({ ...a, inHandle: a.outHandle, outHandle: a.inHandle }));
}

// Split the segment between anchors i and j at parameter t via de Casteljau,
// preserving the curve shape exactly. A straight segment (no handles either
// side) gets a plain corner anchor; a curved one splits into two smooth
// halves. Returns the new anchors array + the inserted index, or null on a
// bad segment. Pure — ops.ts wraps it for the insert gesture, and the
// scissors cut composes it with cutSubpathAt (spec 071926 M4).
export function splitSegmentAnchors(
  anchors: SplineAnchor[],
  i: number,
  j: number,
  t: number
): { anchors: SplineAnchor[]; inserted: number } | null {
  const A = anchors[i];
  const B = anchors[j];
  if (!A || !B) return null;
  const straight = !A.outHandle && !B.inHandle;
  let inserted: SplineAnchor;
  const patchI: Partial<SplineAnchor> = {};
  const patchJ: Partial<SplineAnchor> = {};
  if (straight) {
    const x = A.pos[0] + (B.pos[0] - A.pos[0]) * t;
    const y = A.pos[1] + (B.pos[1] - A.pos[1]) * t;
    inserted = { id: mintAnchorId(), pos: [x, y] };
  } else {
    const P0 = A.pos;
    const P3 = B.pos;
    const P1: [number, number] = [
      P0[0] + (A.outHandle?.[0] ?? 0),
      P0[1] + (A.outHandle?.[1] ?? 0),
    ];
    const P2: [number, number] = [
      P3[0] + (B.inHandle?.[0] ?? 0),
      P3[1] + (B.inHandle?.[1] ?? 0),
    ];
    const lerp = (
      a: [number, number],
      b: [number, number]
    ): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const a1 = lerp(P0, P1);
    const b1 = lerp(P1, P2);
    const c1 = lerp(P2, P3);
    const d1 = lerp(a1, b1);
    const e1 = lerp(b1, c1);
    const f1 = lerp(d1, e1); // split point
    // |v|≈0 → drop the handle (undefined) rather than store a zero vector
    // that would render a degenerate dot on top of the anchor.
    const nz = (vx: number, vy: number): [number, number] | undefined =>
      Math.hypot(vx, vy) < 1e-6 ? undefined : [vx, vy];
    patchI.outHandle = nz(a1[0] - P0[0], a1[1] - P0[1]);
    patchJ.inHandle = nz(c1[0] - P3[0], c1[1] - P3[1]);
    inserted = {
      id: mintAnchorId(),
      pos: f1,
      inHandle: nz(d1[0] - f1[0], d1[1] - f1[1]),
      outHandle: nz(e1[0] - f1[0], e1[1] - f1[1]),
      broken: false,
    };
  }
  const out: SplineAnchor[] = [];
  for (let k = 0; k < anchors.length; k++) {
    let a = anchors[k];
    if (k === i && !straight) a = { ...a, ...patchI };
    if (k === j && !straight) a = { ...a, ...patchJ };
    out.push(a);
    if (k === i) out.push(inserted);
  }
  return { anchors: out, inserted: i + 1 };
}

// Scissors: cut a subpath at anchor `idx` (spec 071926 M4). A closed subpath
// opens there — the cut anchor appears at BOTH ends (start copy keeps its
// outHandle, end copy its inHandle, so every segment survives). An open
// subpath cut at an interior anchor becomes two subpaths sharing a copy of
// the cut anchor the same way. Endpoints of open subpaths (already ends) and
// degenerate cases return null. groupIndex rides on every piece.
export function cutSubpathAt(
  sub: SplineSubpath,
  idx: number
): SplineSubpath[] | null {
  const anchors = sub.anchors;
  const n = anchors.length;
  if (idx < 0 || idx >= n) return null;
  // The cut anchor appears in BOTH pieces — drop its id on the copies so
  // per-anchor tracks never resolve two anchors at once (the orphaned
  // tracks fall away in EffectsApp's cleanup pass).
  const dropOut = (a: SplineAnchor): SplineAnchor => {
    const c = { ...a };
    delete c.outHandle;
    delete c.id;
    return c;
  };
  const dropIn = (a: SplineAnchor): SplineAnchor => {
    const c = { ...a };
    delete c.inHandle;
    delete c.id;
    return c;
  };
  if (sub.closed) {
    if (n < 3) return null;
    const ordered: SplineAnchor[] = [dropIn(anchors[idx])];
    for (let k = 1; k < n; k++) ordered.push({ ...anchors[(idx + k) % n] });
    ordered.push(dropOut(anchors[idx]));
    return [{ ...sub, anchors: ordered, closed: false }];
  }
  if (n < 3 || idx === 0 || idx === n - 1) return null;
  const first = [
    ...anchors.slice(0, idx).map((a) => ({ ...a })),
    dropOut(anchors[idx]),
  ];
  const second = [
    dropIn(anchors[idx]),
    ...anchors.slice(idx + 1).map((a) => ({ ...a })),
  ];
  return [
    { ...sub, anchors: first, closed: false },
    { ...sub, anchors: second, closed: false },
  ];
}

// Harmonize (G2 curvature continuity — spec 080226 M2, the Glyphs
// "harmonise" behavior). For a smooth anchor B (both handles present and
// nearly opposed), the two adjacent cubics' endpoint curvatures at B are
// κ_in = (2/3)·d1/a² and κ_out = (2/3)·d2/b², where a/b are the handle
// lengths and d1/d2 the perpendicular distances of the NEIGHBOR controls
// from the handle line. Since the controls C_in/C_out and B are collinear,
// sliding B along that line with the controls FIXED changes only a and b
// (a + b = |C_out − C_in|); curvature matches when a/b = √(d1/d2). Returns
// the patch (new pos + recomputed handle offsets) or null when the anchor
// doesn't qualify (missing/uneven handles, endpoint, straight side, or
// already harmonized).
export function harmonizeAnchor(
  anchors: SplineAnchor[],
  closed: boolean,
  i: number
): Partial<SplineAnchor> | null {
  const n = anchors.length;
  const a = anchors[i];
  if (!a?.inHandle || !a.outHandle) return null;
  const hasPrev = closed || i > 0;
  const hasNext = closed || i < n - 1;
  if (!hasPrev || !hasNext || n < 2) return null;
  const li = Math.hypot(a.inHandle[0], a.inHandle[1]);
  const lo = Math.hypot(a.outHandle[0], a.outHandle[1]);
  if (li < 1e-9 || lo < 1e-9) return null;
  // Smooth prerequisite: handles opposed within ~3° — harmonizing a broken
  // corner is ill-defined (Align Handles first).
  const opp =
    (a.inHandle[0] * a.outHandle[0] + a.inHandle[1] * a.outHandle[1]) /
    (li * lo);
  if (opp > -0.9986) return null;
  const B = a.pos;
  const Cin: [number, number] = [B[0] + a.inHandle[0], B[1] + a.inHandle[1]];
  const Cout: [number, number] = [
    B[0] + a.outHandle[0],
    B[1] + a.outHandle[1],
  ];
  const prev = anchors[(i - 1 + n) % n];
  const next = anchors[(i + 1) % n];
  const P1: [number, number] = prev.outHandle
    ? [prev.pos[0] + prev.outHandle[0], prev.pos[1] + prev.outHandle[1]]
    : [prev.pos[0], prev.pos[1]];
  const P2: [number, number] = next.inHandle
    ? [next.pos[0] + next.inHandle[0], next.pos[1] + next.inHandle[1]]
    : [next.pos[0], next.pos[1]];
  const axx = Cout[0] - Cin[0];
  const axy = Cout[1] - Cin[1];
  const L = Math.hypot(axx, axy);
  if (L < 1e-9) return null;
  const ux = axx / L;
  const uy = axy / L;
  const distToLine = (q: [number, number]) =>
    Math.abs((q[0] - Cin[0]) * uy - (q[1] - Cin[1]) * ux);
  const d1 = distToLine(P1);
  const d2 = distToLine(P2);
  // A straight (zero-curvature) side can't be matched by sliding — skip.
  if (d1 < 1e-9 || d2 < 1e-9) return null;
  const s1 = Math.sqrt(d1);
  const s2 = Math.sqrt(d2);
  const t = s1 / (s1 + s2);
  const Bx = Cin[0] + axx * t;
  const By = Cin[1] + axy * t;
  if (Math.hypot(Bx - B[0], By - B[1]) < 1e-9) return null; // already G2
  return {
    pos: [Bx, By],
    inHandle: [Cin[0] - Bx, Cin[1] - By],
    outHandle: [Cout[0] - Bx, Cout[1] - By],
  };
}

// Derive handle auto-fill vectors for converting a corner anchor to smooth.
// Uses the adjacent anchors for a simple tangent; falls back to a small
// horizontal handle when the anchor is isolated (only one in the path).
export function autoSmoothHandles(
  anchors: SplineAnchor[],
  i: number
): { inHandle: [number, number]; outHandle: [number, number] } {
  const a = anchors[i];
  const prev = i > 0 ? anchors[i - 1] : null;
  const next = i < anchors.length - 1 ? anchors[i + 1] : null;
  let tx = 0;
  let ty = 0;
  if (prev && next) {
    tx = next.pos[0] - prev.pos[0];
    ty = next.pos[1] - prev.pos[1];
  } else if (prev) {
    tx = a.pos[0] - prev.pos[0];
    ty = a.pos[1] - prev.pos[1];
  } else if (next) {
    tx = next.pos[0] - a.pos[0];
    ty = next.pos[1] - a.pos[1];
  } else {
    tx = 0.1;
    ty = 0;
  }
  const mag = Math.hypot(tx, ty) || 1;
  // Handle length = ~1/3 of the tangent span, matching Illustrator's
  // default Auto Smooth.
  const L = mag / 3;
  const ux = (tx / mag) * L;
  const uy = (ty / mag) * L;
  return { inHandle: [-ux, -uy], outHandle: [ux, uy] };
}
