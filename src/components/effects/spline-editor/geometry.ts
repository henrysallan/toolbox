// Pure geometry helpers for the Spline Draw editor overlay (spline-editor/).
// No React, no refs — everything here takes explicit inputs. Split out of the
// monolith in M0 of specdocs/archive/071926_spline-draw-authoring-upgrade.md.

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

// Global selection key — every subpath's anchors are selectable at once,
// so a selection cannot be a bare index into the active subpath.
export type SelKey = string;
export function selKey(sub: number, index: number): SelKey {
  return `${sub}:${index}`;
}
export function parseSelKey(k: SelKey): { sub: number; index: number } {
  const i = k.lastIndexOf(":");
  return { sub: Number(k.slice(0, i)), index: Number(k.slice(i + 1)) };
}
export function selectedOfSub(sel: Set<SelKey>, sub: number): Set<number> {
  const out = new Set<number>();
  for (const k of sel) {
    const p = parseSelKey(k);
    if (p.sub === sub) out.add(p.index);
  }
  return out;
}
export function groupSelKeys(
  keys: Iterable<SelKey>
): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const k of keys) {
    const { sub, index } = parseSelKey(k);
    let arr = out.get(sub);
    if (!arr) {
      arr = [];
      out.set(sub, arr);
    }
    arr.push(index);
  }
  return out;
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

// ---------------------------------------------------------------------------
// Merge selected anchors (M cursor menu).
//
// At Center: every selected point collapses to the selection centroid.
// Unselected anchors keep their order; extras in the selection are
// dropped (one slot remains per subpath, at the first selected index).
//
// If the selection spans two or more subpaths, those subpaths are then
// stitched into ONE open chain at the merged point. Only the selected
// pair is welded; the leftover pair become the new endpoints (merge them
// in a second step if you want those joined too). Two closed contours
// keep the cheapest pair of edges through M so two C-shapes meet along
// the short side instead of a figure-8 V. Merging both endpoints of a
// single open path still closes that path.
//
// By Distance: cluster selected points that sit within a pixel threshold,
// then run the same collapse+stitch per cluster.

const MERGE_POS_EPS = 1e-9;

function atPos(a: SplineAnchor, pos: [number, number]): boolean {
  return (
    Math.hypot(a.pos[0] - pos[0], a.pos[1] - pos[1]) < MERGE_POS_EPS
  );
}

function copyVec(
  v: [number, number] | undefined
): [number, number] | undefined {
  return v ? [v[0], v[1]] : undefined;
}

function weldMergePoint(
  tail: SplineAnchor,
  head: SplineAnchor,
  pos: [number, number]
): SplineAnchor {
  const weld: SplineAnchor = {
    ...tail,
    id: tail.id ?? head.id ?? mintAnchorId(),
    pos: [pos[0], pos[1]],
  };
  if (tail.inHandle) weld.inHandle = copyVec(tail.inHandle);
  else delete weld.inHandle;
  if (head.outHandle) weld.outHandle = copyVec(head.outHandle);
  else delete weld.outHandle;
  if (weld.inHandle && weld.outHandle) weld.broken = true;
  else delete weld.broken;
  return weld;
}

function makeCollapsedAnchor(
  members: SplineAnchor[],
  pos: [number, number],
  inFrom: SplineAnchor | undefined,
  outFrom: SplineAnchor | undefined
): SplineAnchor {
  const base = members[0] ?? { pos };
  const a: SplineAnchor = {
    ...base,
    id: base.id ?? mintAnchorId(),
    pos: [pos[0], pos[1]],
  };
  const inn = inFrom ? copyVec(inFrom.inHandle) : undefined;
  const out = outFrom ? copyVec(outFrom.outHandle) : undefined;
  if (inn) a.inHandle = inn;
  else delete a.inHandle;
  if (out) a.outHandle = out;
  else delete a.outHandle;
  if (inn && out) a.broken = true;
  else delete a.broken;
  let wSum = 0;
  let wN = 0;
  for (const m of members) {
    if (m.width != null) {
      wSum += m.width;
      wN++;
    }
  }
  if (wN > 0) a.width = wSum / wN;
  return a;
}

// One circular run of selected indices? (possibly wrapping on a closed path)
function selectedIsOneRun(
  n: number,
  closed: boolean,
  selected: Set<number>
): boolean {
  if (selected.size <= 1 || selected.size === n) return true;
  let groups = 0;
  for (let i = 0; i < n; i++) {
    if (!selected.has(i)) continue;
    const prev = closed ? (i - 1 + n) % n : i - 1;
    if (prev < 0 || !selected.has(prev)) groups++;
  }
  return groups === 1;
}

function posKey(pos: [number, number]): string {
  return `${pos[0]},${pos[1]}`;
}

// Collapse every cluster on a subpath in one walk so later clusters' keys
// don't go stale after an earlier collapse remaps indices.
function collapseSubpathClusters(
  sub: SplineSubpath,
  assignment: Map<number, [number, number]>
): SplineSubpath {
  if (assignment.size === 0) return sub;
  const anchors = sub.anchors;
  const n = anchors.length;
  const byPos = new Map<string, { pos: [number, number]; idxs: number[] }>();
  for (const [i, pos] of assignment) {
    if (i < 0 || i >= n) continue;
    const k = posKey(pos);
    let g = byPos.get(k);
    if (!g) {
      g = { pos, idxs: [] };
      byPos.set(k, g);
    }
    g.idxs.push(i);
  }
  if (byPos.size === 0) return sub;

  const collapsed = new Map<string, SplineAnchor>();
  for (const [k, g] of byPos) {
    const selected = new Set(g.idxs);
    const members = g.idxs.map((i) => anchors[i]);
    let inFrom: SplineAnchor | undefined;
    let outFrom: SplineAnchor | undefined;
    if (selectedIsOneRun(n, sub.closed, selected)) {
      for (const i of g.idxs) {
        const prev = sub.closed ? (i - 1 + n) % n : i - 1;
        if (prev < 0 || !selected.has(prev)) inFrom = anchors[i];
        const next = sub.closed ? (i + 1) % n : i + 1;
        if (next >= n || !selected.has(next)) outFrom = anchors[i];
      }
    }
    collapsed.set(k, makeCollapsedAnchor(members, g.pos, inFrom, outFrom));
  }

  const emitted = new Set<string>();
  const nextAnchors: SplineAnchor[] = [];
  for (let i = 0; i < n; i++) {
    const pos = assignment.get(i);
    if (!pos) {
      nextAnchors.push(anchors[i]);
      continue;
    }
    const k = posKey(pos);
    if (emitted.has(k)) continue;
    emitted.add(k);
    nextAnchors.push(collapsed.get(k)!);
  }
  if (nextAnchors.length === 0) return sub;
  if (emitted.size === 1 && nextAnchors.length === 1) {
    return { ...sub, anchors: nextAnchors, closed: false };
  }
  // Open path whose both endpoints were in this merge: dropping the extra
  // end and closing connects the remainder into a loop.
  const hadBothEnds = !sub.closed && assignment.has(0) && assignment.has(n - 1);
  const closed =
    nextAnchors.length >= 3 && (sub.closed || hadBothEnds);
  return { ...sub, anchors: nextAnchors, closed };
}

function subpathToMergeChains(
  sub: SplineSubpath,
  pos: [number, number]
): SplineAnchor[][] {
  const anchors = sub.anchors;
  const n = anchors.length;
  let mi = -1;
  for (let i = 0; i < n; i++) {
    if (atPos(anchors[i], pos)) {
      mi = i;
      break;
    }
  }
  if (mi < 0) return [];
  const M = anchors[mi];
  const copyM = (drop: "in" | "out" | "none", keepId: boolean): SplineAnchor => {
    const c: SplineAnchor = { ...M, pos: [pos[0], pos[1]] };
    if (!keepId) c.id = mintAnchorId();
    if (drop === "in") delete c.inHandle;
    if (drop === "out") delete c.outHandle;
    if (!(c.inHandle && c.outHandle)) delete c.broken;
    return c;
  };
  if (sub.closed) {
    if (n <= 1) return [[copyM("none", true)]];
    const rest: SplineAnchor[] = [];
    for (let k = 1; k < n; k++) rest.push(anchors[(mi + k) % n]);
    return [[copyM("in", true), ...rest, copyM("out", false)]];
  }
  const prefix = anchors.slice(0, mi);
  const suffix = anchors.slice(mi + 1);
  if (prefix.length === 0 && suffix.length === 0) {
    return [[copyM("none", true)]];
  }
  if (prefix.length === 0) return [[copyM("in", true), ...suffix]];
  if (suffix.length === 0) return [[...prefix, copyM("out", true)]];
  return [
    [...prefix, copyM("out", true)],
    [copyM("in", false), ...suffix],
  ];
}

function reverseChain(anchors: SplineAnchor[]): SplineAnchor[] {
  return reverseSubpathAnchors(anchors);
}

function chainStartsAt(chain: SplineAnchor[], pos: [number, number]): boolean {
  return chain.length > 0 && atPos(chain[0], pos);
}
function chainEndsAt(chain: SplineAnchor[], pos: [number, number]): boolean {
  return chain.length > 0 && atPos(chain[chain.length - 1], pos);
}

function stitchChains(
  chains: SplineAnchor[][],
  pos: [number, number]
): SplineAnchor[] {
  if (chains.length === 0) return [];
  const unused = chains
    .filter((c) => c.length > 0)
    .sort((a, b) => b.length - a.length);
  let walk = unused.shift() ?? [];
  const weldOntoEnd = (chain: SplineAnchor[]) => {
    if (walk.length === 0) {
      walk = chain;
      return;
    }
    walk = [
      ...walk.slice(0, -1),
      weldMergePoint(walk[walk.length - 1], chain[0], pos),
      ...chain.slice(1),
    ];
  };
  while (unused.length > 0) {
    const ends = chainEndsAt(walk, pos);
    const starts = chainStartsAt(walk, pos);
    let pick = -1;
    let reverse = false;
    let prepend = false;
    for (let i = 0; i < unused.length; i++) {
      const c = unused[i];
      if (ends && chainStartsAt(c, pos)) {
        pick = i;
        break;
      }
      if (ends && chainEndsAt(c, pos)) {
        pick = i;
        reverse = true;
        break;
      }
      if (starts && chainEndsAt(c, pos)) {
        pick = i;
        prepend = true;
        break;
      }
      if (starts && chainStartsAt(c, pos)) {
        pick = i;
        reverse = true;
        prepend = true;
        break;
      }
    }
    if (pick < 0) {
      const c = unused.shift()!;
      if (ends && chainEndsAt(c, pos)) weldOntoEnd(reverseChain(c));
      else if (ends && chainStartsAt(c, pos)) weldOntoEnd(c);
      else if (starts && chainEndsAt(c, pos)) {
        walk = [
          ...c.slice(0, -1),
          weldMergePoint(c[c.length - 1], walk[0], pos),
          ...walk.slice(1),
        ];
      } else walk = [...walk, ...c];
      continue;
    }
    let c = unused.splice(pick, 1)[0];
    if (reverse) c = reverseChain(c);
    if (prepend) {
      walk = [
        ...c.slice(0, -1),
        weldMergePoint(c[c.length - 1], walk[0], pos),
        ...walk.slice(1),
      ];
    } else weldOntoEnd(c);
  }
  // Collapse immediately-adjacent copies of the merge point.
  const tight: SplineAnchor[] = [];
  for (const a of walk) {
    const prev = tight[tight.length - 1];
    if (prev && atPos(prev, pos) && atPos(a, pos)) {
      tight[tight.length - 1] = weldMergePoint(prev, a, pos);
    } else tight.push(a);
  }
  return tight;
}

function distPos(a: [number, number], b: [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function mergeIndexOf(sub: SplineSubpath, pos: [number, number]): number {
  return sub.anchors.findIndex((a) => atPos(a, pos));
}

// 1 neighbor for an open endpoint, 2 for an interior or closed corner.
function mergePorts(sub: SplineSubpath, mi: number): number[] {
  const n = sub.anchors.length;
  if (n < 2 || mi < 0) return [];
  if (sub.closed) {
    if (n < 3) return [];
    return [(mi - 1 + n) % n, (mi + 1) % n];
  }
  const ports: number[] = [];
  if (mi > 0) ports.push(mi - 1);
  if (mi < n - 1) ports.push(mi + 1);
  return ports;
}

function otherOpenEnd(n: number, mi: number): number | null {
  if (mi === 0) return n - 1;
  if (mi === n - 1) return 0;
  return null;
}

function leftoverPort(
  sub: SplineSubpath,
  mi: number,
  ports: number[],
  keep: number
): number | null {
  if (ports.length === 2) return ports[0] === keep ? ports[1] : ports[0];
  if (!sub.closed) return otherOpenEnd(sub.anchors.length, mi);
  return null;
}

function copyAnchor(a: SplineAnchor, swapHandles: boolean): SplineAnchor {
  const c: SplineAnchor = { ...a };
  if (a.inHandle) c.inHandle = [a.inHandle[0], a.inHandle[1]];
  if (a.outHandle) c.outHandle = [a.outHandle[0], a.outHandle[1]];
  if (swapHandles) {
    const inn = c.inHandle;
    c.inHandle = c.outHandle;
    c.outHandle = inn;
    if (!c.inHandle) delete c.inHandle;
    if (!c.outHandle) delete c.outHandle;
    if (!(c.inHandle && c.outHandle)) delete c.broken;
  }
  return c;
}

// Inclusive walk from `from` to `to` that never visits `avoid` (unless
// from/to is that index). Tries forward then backward. Backward swaps
// in/out handles so the cubics still follow the new travel direction.
function walkArc(
  anchors: SplineAnchor[],
  from: number,
  to: number,
  avoid: number,
  closed: boolean
): SplineAnchor[] | null {
  const n = anchors.length;
  const tryDir = (step: 1 | -1): SplineAnchor[] | null => {
    const out: SplineAnchor[] = [];
    let i = from;
    const swap = step === -1;
    for (let k = 0; k <= n; k++) {
      if (i === avoid && i !== from && i !== to) return null;
      out.push(copyAnchor(anchors[i], swap));
      if (i === to && (k > 0 || from === to)) return out;
      const next = closed ? (i + step + n) % n : i + step;
      if (!closed && (next < 0 || next >= n)) return null;
      i = next;
      if (k > 0 && i === from) return null;
    }
    return null;
  };
  return tryDir(1) ?? tryDir(-1);
}

// Join two contours at the selected merge point M into ONE open chain.
// Only the selected pair is welded; the leftover pair become the new
// endpoints (merge those next if you want them joined too). The cheapest
// pairing of neighbors through M is kept so two C-shapes meet along the
// short side instead of a figure-8 V.
function joinTwoContoursAt(
  a: SplineSubpath,
  b: SplineSubpath,
  pos: [number, number]
): SplineAnchor[] | null {
  const mi = mergeIndexOf(a, pos);
  const mj = mergeIndexOf(b, pos);
  if (mi < 0 || mj < 0) return null;
  const portsA = mergePorts(a, mi);
  const portsB = mergePorts(b, mj);
  if (portsA.length === 0 || portsB.length === 0) return null;

  let best: {
    keepA: number;
    keepB: number;
    leftA: number;
    leftB: number;
    cost: number;
  } | null = null;
  for (const keepA of portsA) {
    const leftA = leftoverPort(a, mi, portsA, keepA);
    if (leftA == null) continue;
    for (const keepB of portsB) {
      const leftB = leftoverPort(b, mj, portsB, keepB);
      if (leftB == null) continue;
      const cost =
        distPos(a.anchors[keepA].pos, pos) +
        distPos(b.anchors[keepB].pos, pos) +
        distPos(a.anchors[leftA].pos, b.anchors[leftB].pos);
      if (!best || cost < best.cost) {
        best = { keepA, keepB, leftA, leftB, cost };
      }
    }
  }
  if (!best) return null;

  const arcA = walkArc(a.anchors, best.leftA, best.keepA, mi, a.closed);
  const arcB = walkArc(b.anchors, best.keepB, best.leftB, mj, b.closed);
  if (!arcA || !arcB || arcA.length === 0 || arcB.length === 0) return null;

  const M: SplineAnchor = {
    ...a.anchors[mi],
    id: a.anchors[mi].id ?? b.anchors[mj].id ?? mintAnchorId(),
    pos: [pos[0], pos[1]],
  };
  delete M.inHandle;
  delete M.outHandle;
  delete M.broken;
  const walk = [...arcA, M, ...arcB];
  // Leftover pair are now open endpoints — drop the handles that used to
  // point at M along the unused pairing (those arms are gone).
  const start = walk[0];
  const end = walk[walk.length - 1];
  if (start) delete start.inHandle;
  if (end) delete end.outHandle;
  if (start && !(start.inHandle && start.outHandle)) delete start.broken;
  if (end && !(end.inHandle && end.outHandle)) delete end.broken;
  return walk;
}

function stitchSubpathsAt(
  subs: SplineSubpath[],
  indices: number[],
  pos: [number, number]
): SplineSubpath[] {
  const uniq = [...new Set(indices)].filter(
    (i) => i >= 0 && i < subs.length
  );
  if (uniq.length < 2) return subs;
  if (uniq.length === 2) {
    const loop = joinTwoContoursAt(subs[uniq[0]], subs[uniq[1]], pos);
    if (loop && loop.length >= 3) {
      const home = Math.min(...uniq);
      const drop = new Set(uniq.filter((i) => i !== home));
      const merged: SplineSubpath = {
        ...subs[home],
        anchors: loop,
        closed: false,
      };
      return subs
        .map((s, i) => (i === home ? merged : s))
        .filter((_, i) => !drop.has(i));
    }
  }
  const chains: SplineAnchor[][] = [];
  for (const i of uniq) {
    for (const c of subpathToMergeChains(subs[i], pos)) chains.push(c);
  }
  const walk = stitchChains(chains, pos);
  if (walk.length === 0) return subs;
  let closed = false;
  let anchors = walk;
  if (
    walk.length >= 3 &&
    atPos(walk[0], pos) &&
    atPos(walk[walk.length - 1], pos)
  ) {
    // Both leftover ends are copies of M — weld them into a closed loop.
    anchors = [
      weldMergePoint(walk[walk.length - 1], walk[0], pos),
      ...walk.slice(1, -1),
    ];
    closed = anchors.length >= 3;
  }
  const home = Math.min(...uniq);
  const drop = new Set(uniq.filter((i) => i !== home));
  const first = uniq.find((i) => i === home)!;
  const merged: SplineSubpath = {
    ...subs[first],
    anchors,
    closed,
  };
  return subs
    .map((s, i) => (i === home ? merged : s))
    .filter((_, i) => !drop.has(i));
}

export type MergeCluster = {
  keys: SelKey[];
  pos: [number, number];
};

export function clusterKeysByDistance(
  items: Array<{ key: SelKey; pos: [number, number]; px: { x: number; y: number } }>,
  thresholdPx: number
): MergeCluster[] {
  const n = items.length;
  if (n < 2) return [];
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const unite = (a: number, b: number) => {
    const pa = find(a);
    const pb = find(b);
    if (pa !== pb) parent[pa] = pb;
  };
  const t2 = thresholdPx * thresholdPx;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = items[i].px.x - items[j].px.x;
      const dy = items[i].px.y - items[j].px.y;
      if (dx * dx + dy * dy <= t2) unite(i, j);
    }
  }
  const groups = new Map<number, typeof items>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) {
      g = [];
      groups.set(r, g);
    }
    g.push(items[i]);
  }
  const out: MergeCluster[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    let sx = 0;
    let sy = 0;
    for (const it of g) {
      sx += it.pos[0];
      sy += it.pos[1];
    }
    out.push({
      keys: g.map((it) => it.key),
      pos: [sx / g.length, sy / g.length],
    });
  }
  return out;
}

export function mergeByClusters(
  subs: SplineSubpath[],
  clusters: MergeCluster[]
): { subpaths: SplineSubpath[]; active: number; mergedKey: SelKey } | null {
  if (clusters.length === 0) return null;
  const assignment = new Map<number, Map<number, [number, number]>>();
  for (const cluster of clusters) {
    for (const k of cluster.keys) {
      const { sub, index } = parseSelKey(k);
      let m = assignment.get(sub);
      if (!m) {
        m = new Map();
        assignment.set(sub, m);
      }
      m.set(index, cluster.pos);
    }
  }
  let next = subs.map((s, si) => {
    const asg = assignment.get(si);
    if (!asg) return s;
    return collapseSubpathClusters(s, asg);
  });
  for (const cluster of clusters) {
    const idxs: number[] = [];
    for (let si = 0; si < next.length; si++) {
      if (next[si].anchors.some((a) => atPos(a, cluster.pos))) idxs.push(si);
    }
    if (idxs.length >= 2) next = stitchSubpathsAt(next, idxs, cluster.pos);
  }
  // Prefer selecting the first cluster's merged point.
  const pos = clusters[0].pos;
  let active = 0;
  let mergedIndex = 0;
  for (let si = 0; si < next.length; si++) {
    const i = next[si].anchors.findIndex((a) => atPos(a, pos));
    if (i >= 0) {
      active = si;
      mergedIndex = i;
      break;
    }
  }
  if (next.length === 0) return null;
  return {
    subpaths: next,
    active,
    mergedKey: selKey(active, mergedIndex),
  };
}

export function mergeAnchorsAt(
  subs: SplineSubpath[],
  keys: Iterable<SelKey>,
  pos: [number, number]
): { subpaths: SplineSubpath[]; active: number; mergedKey: SelKey } | null {
  const list = [...keys];
  if (list.length < 2) return null;
  return mergeByClusters(subs, [{ keys: list, pos }]);
}
