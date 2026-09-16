// Value-writing operations (and the query helpers that pair with them) for
// the Spline Draw editor overlay. `makeSplineOps(env)` is called every render
// by the component; every function reads live data through the env refs and
// writes through `env.onChangeRef` — one onChange per user-visible operation,
// so undo coalescing stays intact. Split out of the monolith in M0 of
// specdocs/archive/071926_spline-draw-authoring-upgrade.md.

import { applyShapeBuilderOp, type FaceRef } from "@/engine/spline-planar";
import type { SplineAnchor, SplineSubpath } from "@/engine/types";
import type { SplineParamValue } from "@/nodes/source/spline-draw";
import type { BBoxHandle, DragState, SplineEditorEnv } from "./types";
import { MERGE_DISTANCE_R } from "./constants";
import {
  autoSmoothHandles,
  bezierAt,
  clusterKeysByDistance,
  cutSubpathAt,
  groupSelKeys,
  harmonizeAnchor,
  mergeAnchorsAt,
  mergeByClusters,
  mintAnchorId,
  nearestTOnCubic,
  parseSelKey,
  reverseSubpathAnchors,
  selKey,
  splitSegmentAnchors,
  subpathsOf,
  type SelKey,
} from "./geometry";

export type SplineOps = ReturnType<typeof makeSplineOps>;

export function makeSplineOps(env: SplineEditorEnv) {
  // The anchor-level helpers below operate on the ACTIVE subpath
  // (activeSubpathRef.current). Reads return [] if the value arrives without
  // any subpaths; writes materialize the active subpath on first touch.
  const readAnchors = (v: SplineParamValue): SplineAnchor[] =>
    subpathsOf(v)[env.activeSubpathRef.current]?.anchors ?? [];

  const anchorsOf = (sub: number): SplineAnchor[] =>
    subpathsOf(env.valueRef.current)[sub]?.anchors ?? [];

  const withSubpathPatchAt = (
    cur: SplineParamValue,
    idx: number,
    patch: Partial<SplineSubpath>
  ): SplineParamValue => {
    const subpaths = subpathsOf(cur);
    const base: SplineSubpath[] =
      subpaths.length > 0 ? subpaths : [{ anchors: [], closed: false }];
    return {
      ...cur,
      subpaths: base.map((s, i) => (i === idx ? { ...s, ...patch } : s)),
    };
  };

  const withSubpathPatch = (
    cur: SplineParamValue,
    patch: Partial<SplineSubpath>
  ): SplineParamValue =>
    withSubpathPatchAt(cur, env.activeSubpathRef.current, patch);

  // Switch the active subpath. Selection is global (`sub:index` keys) so
  // it survives the switch — clicking a point on another subpath no longer
  // throws away the rest of the selection.
  const selectSubpath = (i: number) => {
    env.activeSubpathRef.current = i;
    env.setActiveSubpath(i);
    env.setPenSealed(false);
  };

  // Select every anchor of a subpath (defaults to the active one) — the
  // double-click-a-segment / double-click-a-subpath "select the whole path"
  // gesture. Takes an explicit index because the caller may be activating a
  // different subpath in the same batch (activeSubpathRef only catches up on
  // the next render).
  const selectAllAnchors = (subpathIndex?: number) => {
    const idx = subpathIndex ?? env.activeSubpathRef.current;
    const anchors = subpathsOf(env.valueRef.current)[idx]?.anchors ?? [];
    env.setSelected(new Set(anchors.map((_, i) => selKey(idx, i))));
  };

  const addAnchorAt = (nx: number, ny: number) => {
    const cur = env.valueRef.current;
    const anchors = readAnchors(cur);
    const next = withSubpathPatch(cur, {
      anchors: [...anchors, { id: mintAnchorId(), pos: [nx, ny] }],
    });
    env.onChangeRef.current(next);
    return anchors.length;
  };

  // Project a client point onto the nearest spot on any segment of the path.
  // Returns the segment endpoints (i, j) and parameter t plus the projected
  // px point, or null when there are no segments. Used for the shift-insert
  // affordance in add mode.
  const findInsertOnSpline = (
    cx: number,
    cy: number
  ): { i: number; j: number; t: number; x: number; y: number } | null => {
    const sub = subpathsOf(env.valueRef.current)[env.activeSubpathRef.current];
    const anchors = sub?.anchors ?? [];
    const closed = sub?.closed ?? false;
    const n = anchors.length;
    const count = closed ? n : n - 1;
    if (count < 1) return null;
    let best:
      | { i: number; j: number; t: number; x: number; y: number; d: number }
      | null = null;
    for (let s = 0; s < count; s++) {
      const i = s;
      const j = (s + 1) % n;
      const A = anchors[i];
      const B = anchors[j];
      const p0 = env.normToPx(A.pos);
      const p1 = A.outHandle
        ? env.normToPx([A.pos[0] + A.outHandle[0], A.pos[1] + A.outHandle[1]])
        : p0;
      const p3 = env.normToPx(B.pos);
      const p2 = B.inHandle
        ? env.normToPx([B.pos[0] + B.inHandle[0], B.pos[1] + B.inHandle[1]])
        : p3;
      const c0: [number, number] = [p0.x, p0.y];
      const c1: [number, number] = [p1.x, p1.y];
      const c2: [number, number] = [p2.x, p2.y];
      const c3: [number, number] = [p3.x, p3.y];
      const t = nearestTOnCubic(c0, c1, c2, c3, [cx, cy]);
      const b = bezierAt(c0, c1, c2, c3, t);
      const d = Math.hypot(b[0] - cx, b[1] - cy);
      if (!best || d < best.d) best = { i, j, t, x: b[0], y: b[1], d };
    }
    if (!best) return null;
    return { i: best.i, j: best.j, t: best.t, x: best.x, y: best.y };
  };

  // Insert a new anchor on the segment between anchors i and j at parameter t
  // (de Casteljau split — geometry.ts owns the math).
  const insertAnchorOnSegment = (
    i: number,
    j: number,
    t: number,
    subpathIndex?: number
  ) => {
    const idx = subpathIndex ?? env.activeSubpathRef.current;
    const cur = env.valueRef.current;
    const res = splitSegmentAnchors(anchorsOf(idx), i, j, t);
    if (!res) return;
    env.onChangeRef.current(
      withSubpathPatchAt(cur, idx, { anchors: res.anchors })
    );
    env.lastAnchorRef.current = res.inserted;
  };

  // Replace the active subpath with the pieces a scissors cut produced —
  // one onChange, selection cleared (indices restructure).
  const applyCutPieces = (pieces: SplineSubpath[] | null) => {
    if (!pieces) return;
    const cur = env.valueRef.current;
    const subs = subpathsOf(cur);
    const ai = env.activeSubpathRef.current;
    const outSubs = [...subs.slice(0, ai), ...pieces, ...subs.slice(ai + 1)];
    env.onChangeRef.current({ ...cur, subpaths: outSubs });
    env.setSelected(new Set());
  };

  // Scissors (spec 071926 M4): cut the active subpath at an anchor, or at a
  // point on a segment (split first, then cut at the minted anchor).
  const cutAtAnchor = (idx: number, subpathIndex?: number) => {
    const si = subpathIndex ?? env.activeSubpathRef.current;
    const sub = subpathsOf(env.valueRef.current)[si];
    if (!sub) return;
    env.activeSubpathRef.current = si;
    env.setActiveSubpath(si);
    applyCutPieces(cutSubpathAt(sub, idx));
  };
  const cutAtSegmentPoint = (
    i: number,
    j: number,
    t: number,
    subpathIndex?: number
  ) => {
    const si = subpathIndex ?? env.activeSubpathRef.current;
    const sub = subpathsOf(env.valueRef.current)[si];
    if (!sub) return;
    const res = splitSegmentAnchors(sub.anchors, i, j, t);
    if (!res) return;
    env.activeSubpathRef.current = si;
    env.setActiveSubpath(si);
    applyCutPieces(cutSubpathAt({ ...sub, anchors: res.anchors }, res.inserted));
  };

  // Join (spec 071926 M4, key J): with BOTH endpoints of the open active
  // subpath selected → close the loop. Otherwise, from one endpoint (the
  // argument, or the single selected endpoint), find the nearest endpoint of
  // any OTHER open subpath and concatenate the two into one subpath —
  // reversing sides as needed so travel flows through the seam. Coincident
  // endpoints (< 1e-3 normalized) WELD into one anchor (keeping the arrival
  // and departure handles, broken); farther apart, a straight connector
  // segment appears. One onChange.
  const joinPath = (endpointIndex?: number) => {
    const cur = env.valueRef.current;
    const subs = subpathsOf(cur);
    const ai = env.activeSubpathRef.current;
    const active = subs[ai];
    if (!active || active.closed || active.anchors.length < 2) return;
    const n = active.anchors.length;
    const sel = env.selectedRef.current;
    if (
      endpointIndex === undefined &&
      sel.has(selKey(ai, 0)) &&
      sel.has(selKey(ai, n - 1))
    ) {
      toggleClosed();
      return;
    }
    let e: number | null = null;
    if (endpointIndex !== undefined) {
      if (endpointIndex === 0 || endpointIndex === n - 1) e = endpointIndex;
    } else if (sel.size === 1) {
      const { sub, index } = parseSelKey([...sel][0]);
      if (sub === ai && (index === 0 || index === n - 1)) e = index;
    }
    if (e === null) return;
    const ep = active.anchors[e].pos;
    let best: { si: number; atStart: boolean; d: number } | null = null;
    for (let si = 0; si < subs.length; si++) {
      if (si === ai) continue;
      const s = subs[si];
      if (s.closed || s.anchors.length < 2) continue;
      const ends: Array<[number, boolean]> = [
        [0, true],
        [s.anchors.length - 1, false],
      ];
      for (const [idx, atStart] of ends) {
        const p = s.anchors[idx].pos;
        const d = Math.hypot(p[0] - ep[0], p[1] - ep[1]);
        if (!best || d < best.d) best = { si, atStart, d };
      }
    }
    if (!best) return;
    // Orient: active ends at e; the other subpath starts at its matched end.
    const aAnchors =
      e === n - 1 ? active.anchors : reverseSubpathAnchors(active.anchors);
    const other = subs[best.si];
    const oAnchors = best.atStart
      ? other.anchors
      : reverseSubpathAnchors(other.anchors);
    const tail = aAnchors[aAnchors.length - 1];
    const head = oAnchors[0];
    const dist = Math.hypot(
      head.pos[0] - tail.pos[0],
      head.pos[1] - tail.pos[1]
    );
    let merged: SplineAnchor[];
    if (dist < 1e-3) {
      const weld: SplineAnchor = { pos: tail.pos };
      if (tail.inHandle) weld.inHandle = tail.inHandle;
      if (head.outHandle) weld.outHandle = head.outHandle;
      if (weld.inHandle && weld.outHandle) weld.broken = true;
      merged = [...aAnchors.slice(0, -1), weld, ...oAnchors.slice(1)];
    } else {
      merged = [...aAnchors, ...oAnchors];
    }
    const target = best.si;
    const outSubs = subs
      .map((s, i2) =>
        i2 === ai ? { ...s, anchors: merged, closed: false } : s
      )
      .filter((_, i2) => i2 !== target);
    env.onChangeRef.current({ ...cur, subpaths: outSubs });
    env.setActiveSubpath(ai > target ? ai - 1 : ai);
    env.setSelected(new Set());
  };

  // Reverse the active subpath's travel direction (chevron shows it; matters
  // for Stroke ramps, trim, text-on-path).
  const reverseActiveSubpath = () => {
    const cur = env.valueRef.current;
    const sub = subpathsOf(cur)[env.activeSubpathRef.current];
    if (!sub || sub.anchors.length < 2) return;
    env.onChangeRef.current(
      withSubpathPatch(cur, { anchors: reverseSubpathAnchors(sub.anchors) })
    );
    env.setSelected(new Set());
  };

  // Alignment (backlog #84): set the selected anchors' x (axis 0) or y
  // (axis 1) to the selection's average; distribute spaces them evenly
  // between the selection's extremes along that axis. Handles ride along
  // (offsets). One patchAnchors each.
  const alignSelected = (axis: 0 | 1) => {
    const subs = subpathsOf(env.valueRef.current);
    const items: Array<{ k: SelKey; pos: [number, number] }> = [];
    for (const k of env.selectedRef.current) {
      const { sub, index } = parseSelKey(k);
      const a = subs[sub]?.anchors[index];
      if (a) items.push({ k, pos: a.pos });
    }
    if (items.length < 2) return;
    const avg = items.reduce((s, it) => s + it.pos[axis], 0) / items.length;
    const patches = new Map<SelKey, Partial<SplineAnchor>>();
    for (const it of items) {
      const pos: [number, number] = [it.pos[0], it.pos[1]];
      pos[axis] = avg;
      patches.set(it.k, { pos });
    }
    patchBySelKey(patches);
  };
  const distributeSelected = (axis: 0 | 1) => {
    const subs = subpathsOf(env.valueRef.current);
    const items: Array<{ k: SelKey; pos: [number, number] }> = [];
    for (const k of env.selectedRef.current) {
      const { sub, index } = parseSelKey(k);
      const a = subs[sub]?.anchors[index];
      if (a) items.push({ k, pos: a.pos });
    }
    if (items.length < 3) return;
    const sorted = items
      .slice()
      .sort((a, b) => a.pos[axis] - b.pos[axis]);
    const lo = sorted[0].pos[axis];
    const hi = sorted[sorted.length - 1].pos[axis];
    const patches = new Map<SelKey, Partial<SplineAnchor>>();
    sorted.forEach((it, k) => {
      const pos: [number, number] = [it.pos[0], it.pos[1]];
      pos[axis] = lo + ((hi - lo) * k) / (sorted.length - 1);
      patches.set(it.k, { pos });
    });
    patchBySelKey(patches);
  };

  // Same target set as modal G/S/R: Path Select → every anchor; otherwise
  // the selection, or the whole active subpath when nothing is selected.
  const editTargets = (): Array<{ k: SelKey; a: SplineAnchor }> => {
    const subs = subpathsOf(env.valueRef.current);
    const out: Array<{ k: SelKey; a: SplineAnchor }> = [];
    const add = (sub: number, index: number) => {
      const a = subs[sub]?.anchors[index];
      if (a) out.push({ k: selKey(sub, index), a });
    };
    if (env.tool === "path") {
      for (let s = 0; s < subs.length; s++) {
        const n = subs[s]?.anchors.length ?? 0;
        for (let i = 0; i < n; i++) add(s, i);
      }
      return out;
    }
    const sel = env.selectedRef.current;
    if (sel.size > 0) {
      for (const k of sel) {
        const p = parseSelKey(k);
        add(p.sub, p.index);
      }
      if (out.length > 0) return out;
    }
    const ai = env.activeSubpathRef.current;
    const n = subs[ai]?.anchors.length ?? 0;
    for (let i = 0; i < n; i++) add(ai, i);
    return out;
  };

  // Slide the target set so its bounding-box center sits on the canvas
  // midline (0.5) of `axis` — 0 = horizontal (center X), 1 = vertical
  // (center Y). Handles ride along as offsets.
  const centerSelected = (axis: 0 | 1) => {
    const items = editTargets();
    if (items.length === 0) return;
    let lo = Infinity;
    let hi = -Infinity;
    for (const it of items) {
      const v = it.a.pos[axis];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const delta = 0.5 - (lo + hi) / 2;
    if (!Number.isFinite(delta) || Math.abs(delta) < 1e-12) return;
    const patches = new Map<SelKey, Partial<SplineAnchor>>();
    for (const it of items) {
      const pos: [number, number] = [it.a.pos[0], it.a.pos[1]];
      pos[axis] += delta;
      patches.set(it.k, { pos });
    }
    patchBySelKey(patches);
  };

  // Flip the target set across its bounding-box center on `axis` —
  // 0 = mirror horizontally (across a vertical line), 1 = mirror
  // vertically (across a horizontal line). Handle offsets flip on the
  // same axis so the curve reflects with the anchors.
  const mirrorSelected = (axis: 0 | 1) => {
    const items = editTargets();
    if (items.length === 0) return;
    let lo = Infinity;
    let hi = -Infinity;
    for (const it of items) {
      const v = it.a.pos[axis];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const pivot = (lo + hi) / 2;
    if (!Number.isFinite(pivot)) return;
    const sx = axis === 0 ? -1 : 1;
    const sy = axis === 1 ? -1 : 1;
    const flipH = (
      v: [number, number] | undefined
    ): [number, number] | undefined =>
      v ? ([v[0] * sx, v[1] * sy] as [number, number]) : v;
    const patches = new Map<SelKey, Partial<SplineAnchor>>();
    for (const it of items) {
      const a = it.a;
      const patch: Partial<SplineAnchor> = {
        pos: [
          axis === 0 ? 2 * pivot - a.pos[0] : a.pos[0],
          axis === 1 ? 2 * pivot - a.pos[1] : a.pos[1],
        ],
      };
      const inn = flipH(a.inHandle);
      const out = flipH(a.outHandle);
      if (inn) patch.inHandle = inn;
      if (out) patch.outHandle = out;
      patches.set(it.k, patch);
    }
    patchBySelKey(patches);
  };

  const commitMerge = (
    result: {
      subpaths: SplineSubpath[];
      active: number;
      mergedKey: SelKey;
    } | null
  ) => {
    if (!result) return;
    const cur = env.valueRef.current;
    env.onChangeRef.current({ ...cur, subpaths: result.subpaths });
    env.setActiveSubpath(result.active);
    env.setSelected(new Set([result.mergedKey]));
    env.lastAnchorRef.current = parseSelKey(result.mergedKey).index;
  };

  // Merge At Center: collapse the current selection onto its centroid, then
  // stitch every involved subpath into one chain at that point.
  const mergeSelectedAtCenter = () => {
    const sel = env.selectedRef.current;
    if (sel.size < 2) return;
    const subs = subpathsOf(env.valueRef.current);
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const k of sel) {
      const { sub, index } = parseSelKey(k);
      const a = subs[sub]?.anchors[index];
      if (!a) continue;
      sx += a.pos[0];
      sy += a.pos[1];
      n++;
    }
    if (n < 2) return;
    commitMerge(mergeAnchorsAt(subs, sel, [sx / n, sy / n]));
  };

  // Merge By Distance: cluster selected anchors that sit within
  // MERGE_DISTANCE_R pixels, then collapse+stitch each cluster. No close
  // pairs → no-op (use At Center).
  const mergeSelectedByDistance = () => {
    const sel = env.selectedRef.current;
    if (sel.size < 2) return;
    const subs = subpathsOf(env.valueRef.current);
    const items: Array<{
      key: SelKey;
      pos: [number, number];
      px: { x: number; y: number };
    }> = [];
    for (const k of sel) {
      const { sub, index } = parseSelKey(k);
      const a = subs[sub]?.anchors[index];
      if (!a) continue;
      items.push({ key: k, pos: a.pos, px: env.normToPx(a.pos) });
    }
    const clusters = clusterKeysByDistance(items, MERGE_DISTANCE_R);
    if (clusters.length === 0) return;
    commitMerge(mergeByClusters(subs, clusters));
  };

  const patchBySelKey = (patches: Map<SelKey, Partial<SplineAnchor>>) => {
    if (patches.size === 0) return;
    const cur = env.valueRef.current;
    const grouped = groupSelKeys(patches.keys());
    env.onChangeRef.current({
      ...cur,
      subpaths: subpathsOf(cur).map((s, si) => {
        const idxs = grouped.get(si);
        if (!idxs) return s;
        return {
          ...s,
          anchors: s.anchors.map((a, ai) => {
            const p = patches.get(selKey(si, ai));
            return p ? { ...a, ...p } : a;
          }),
        };
      }),
    });
  };

  const updateAnchor = (
    i: number,
    patch: Partial<SplineAnchor>,
    subpathIndex?: number
  ) => {
    const idx = subpathIndex ?? env.activeSubpathRef.current;
    patchBySelKey(new Map([[selKey(idx, i), patch]]));
  };

  // Patch several anchors of one subpath in one onChange. Needed when a
  // single gesture (segment drag, align/even on a multi-selection) must
  // touch more than one anchor: calling updateAnchor twice in a row would
  // have the second read a stale value (React hasn't re-rendered yet) and
  // clobber the first.
  const patchAnchors = (
    patches: Map<number, Partial<SplineAnchor>>,
    subpathIndex?: number
  ) => {
    const idx = subpathIndex ?? env.activeSubpathRef.current;
    const mapped = new Map<SelKey, Partial<SplineAnchor>>();
    for (const [i, p] of patches) mapped.set(selKey(idx, i), p);
    patchBySelKey(mapped);
  };

  // Apply a position delta to many anchors at once (any subpath). Used for
  // group drags when the user moves a multi-selection. Handle offsets are
  // stored relative to pos, so they ride along automatically.
  const moveAnchors = (
    starts: Map<SelKey, [number, number]>,
    dx: number,
    dy: number
  ) => {
    const patches = new Map<SelKey, Partial<SplineAnchor>>();
    for (const [k, start] of starts) {
      patches.set(k, { pos: [start[0] + dx, start[1] + dy] });
    }
    patchBySelKey(patches);
  };

  // Path Select move: translate every anchor of every subpath by (dx, dy) in
  // normalized space, computed from a start snapshot. Handle offsets are
  // relative to pos, so they ride along. Bakes into the spline geometry.
  const translateWholePath = (
    start: SplineParamValue,
    dx: number,
    dy: number
  ) => {
    const subs = subpathsOf(start).map((s) => ({
      ...s,
      anchors: s.anchors.map((a) => ({
        ...a,
        pos: [a.pos[0] + dx, a.pos[1] + dy] as [number, number],
      })),
    }));
    env.onChangeRef.current({ ...start, subpaths: subs });
  };

  // Scale every subpath about `pivot` (normalized space) by (sx, sy), from a
  // start snapshot. Preserves the `broken` flag and all anchor fields (unlike
  // engine/transformSpline, which rebuilds anchors and drops `broken`). Handle
  // offsets are deltas, so they scale but don't translate.
  const scaleWholePath = (
    start: SplineParamValue,
    pivot: [number, number],
    sx: number,
    sy: number
  ) => {
    const subs = subpathsOf(start).map((s) => ({
      ...s,
      anchors: s.anchors.map((a) => ({
        ...a,
        pos: [
          pivot[0] + (a.pos[0] - pivot[0]) * sx,
          pivot[1] + (a.pos[1] - pivot[1]) * sy,
        ] as [number, number],
        inHandle: a.inHandle
          ? ([a.inHandle[0] * sx, a.inHandle[1] * sy] as [number, number])
          : a.inHandle,
        outHandle: a.outHandle
          ? ([a.outHandle[0] * sx, a.outHandle[1] * sy] as [number, number])
          : a.outHandle,
      })),
    }));
    env.onChangeRef.current({ ...start, subpaths: subs });
  };

  // Resolve a bounding-box handle drag into a scale about the anchored
  // (opposite) edge/corner. `nx,ny` is the live pointer in normalized space.
  const applyBBoxDrag = (
    d: Extract<DragState, { kind: "bbox" }>,
    nx: number,
    ny: number,
    shift: boolean
  ) => {
    const { minX, minY, maxX, maxY } = d.startBox;
    const w0 = Math.max(1e-4, maxX - minX);
    const h0 = Math.max(1e-4, maxY - minY);
    const h: BBoxHandle = d.handle;
    const movesL = h === "l" || h === "tl" || h === "bl";
    const movesR = h === "r" || h === "tr" || h === "br";
    const movesT = h === "t" || h === "tl" || h === "tr";
    const movesB = h === "b" || h === "bl" || h === "br";
    // Anchor point = the opposite edge/corner (stays fixed). For edge drags
    // the unmoved axis pivots on its min (keeps that axis put, scale 1).
    const pivotX = movesL ? maxX : minX;
    const pivotY = movesT ? maxY : minY;
    let sx = movesL ? (maxX - nx) / w0 : movesR ? (nx - minX) / w0 : 1;
    let sy = movesT ? (maxY - ny) / h0 : movesB ? (ny - minY) / h0 : 1;
    const MIN = 0.02;
    if (sx < MIN) sx = MIN;
    if (sy < MIN) sy = MIN;
    // Shift on a corner locks aspect to the dominant axis.
    const isCorner = h === "tl" || h === "tr" || h === "br" || h === "bl";
    if (shift && isCorner) {
      const s = Math.abs(sx - 1) > Math.abs(sy - 1) ? sx : sy;
      sx = s;
      sy = s;
    }
    scaleWholePath(d.startValue, [pivotX, pivotY], sx, sy);
    return { sx, sy }; // applied scale, for the drag HUD readout
  };

  const deleteAnchorIndices = (indices: Set<SelKey>) => {
    if (indices.size === 0) return;
    const cur = env.valueRef.current;
    const grouped = groupSelKeys(indices);
    env.onChangeRef.current({
      ...cur,
      subpaths: subpathsOf(cur).map((s, si) => {
        const idxs = grouped.get(si);
        if (!idxs) return s;
        const drop = new Set(idxs);
        return { ...s, anchors: s.anchors.filter((_, i) => !drop.has(i)) };
      }),
    });
  };

  const deleteAnchor = (i: number) => {
    const cur = env.valueRef.current;
    const ai = env.activeSubpathRef.current;
    const anchors = readAnchors(cur);
    const next = withSubpathPatch(cur, {
      anchors: anchors.filter((_, idx) => idx !== i),
    });
    env.onChangeRef.current(next);
    // Reindex the selection: anchors after `i` on this subpath shift down
    // by one; other subpaths' keys are unchanged.
    if (env.selectedRef.current.size > 0) {
      const nextSel = new Set<SelKey>();
      for (const k of env.selectedRef.current) {
        const p = parseSelKey(k);
        if (p.sub !== ai) {
          nextSel.add(k);
          continue;
        }
        if (p.index === i) continue;
        nextSel.add(selKey(p.sub, p.index > i ? p.index - 1 : p.index));
      }
      env.setSelected(nextSel);
    }
  };

  // Toggle subpath.closed on the current subpath. Single source of
  // truth — downstream nodes (Stroke, Resample, Fill, etc.) all read
  // `subpath.closed` from the spline value, so flipping it here
  // propagates everywhere that cares.
  const toggleClosed = () => {
    const cur = env.valueRef.current;
    const wasClosed =
      subpathsOf(cur)[env.activeSubpathRef.current]?.closed ?? false;
    const next = withSubpathPatch(cur, { closed: !wasClosed });
    env.onChangeRef.current(next);
  };

  // Pen-on-empty when the active subpath is closed (or none exists): append a
  // fresh subpath seeded with the first anchor and make it active. Returns the
  // new active subpath index (its first anchor is index 0).
  const startNewSubpath = (nx: number, ny: number): number => {
    const cur = env.valueRef.current;
    const subs = subpathsOf(cur);
    const newSubs: SplineSubpath[] = [
      ...subs,
      { anchors: [{ id: mintAnchorId(), pos: [nx, ny] }], closed: false },
    ];
    const newActive = newSubs.length - 1;
    env.onChangeRef.current({ ...cur, subpaths: newSubs });
    env.setActiveSubpath(newActive);
    env.setSelected(new Set());
    // We're now drawing this fresh subpath — clear any prior "sealed" state.
    env.setPenSealed(false);
    return newActive;
  };

  // Commit a finished subpath (a pencil stroke, a stamped primitive) in ONE
  // onChange — so one undo entry. Reuses the active subpath when it exists
  // and is still empty (a fresh node's seed subpath) so we don't strand an
  // orphan; otherwise appends. The new subpath becomes active, the anchor
  // selection clears, and the pen unseals so it can extend the result.
  const appendSubpath = (anchors: SplineAnchor[], closed: boolean) => {
    const cur = env.valueRef.current;
    const subs = subpathsOf(cur);
    const activeIdx = env.activeSubpathRef.current;
    // An out-of-range active index — e.g. a stale index after undo, before
    // the clamp effect runs — must NOT read as "empty", or the map below
    // matches nothing and the whole shape is dropped.
    const reuseEmpty =
      activeIdx >= 0 &&
      activeIdx < subs.length &&
      (subs[activeIdx]?.anchors.length ?? 0) === 0;
    const newSubs: SplineSubpath[] = reuseEmpty
      ? subs.map((s, i) => (i === activeIdx ? { ...s, anchors, closed } : s))
      : [...subs, { anchors, closed }];
    const newActive = reuseEmpty ? activeIdx : newSubs.length - 1;
    env.onChangeRef.current({ ...cur, subpaths: newSubs });
    env.setActiveSubpath(newActive);
    env.setSelected(new Set());
    env.setPenSealed(false);
    env.lastAnchorRef.current = anchors.length - 1;
  };

  // Remove the active subpath (keeping ≥ 1 — never an empty subpaths array).
  // No-op when only one subpath exists. Clamps the active index to a neighbor.
  const deleteActiveSubpath = () => {
    const cur = env.valueRef.current;
    const subs = subpathsOf(cur);
    if (subs.length <= 1) return;
    const idx = env.activeSubpathRef.current;
    const newSubs = subs.filter((_, i) => i !== idx);
    env.onChangeRef.current({ ...cur, subpaths: newSubs });
    env.setActiveSubpath(Math.max(0, Math.min(idx, newSubs.length - 1)));
    env.setSelected(new Set());
  };

  const toggleCornerSmooth = (i: number) => {
    const anchors = readAnchors(env.valueRef.current);
    const a = anchors[i];
    if (!a) return;
    const hasHandles = !!a.inHandle || !!a.outHandle;
    if (hasHandles) {
      // Smooth → corner: strip handles. updateAnchor merges via
      // `{ ...a, ...patch }`, so simply omitting `inHandle` /
      // `outHandle` in the patch leaves the existing values in
      // place — bug! We need to explicitly overwrite them with
      // undefined so the spread drops them. JSON.stringify omits
      // undefined-valued props on save, so the cleaned anchor
      // round-trips correctly.
      updateAnchor(i, {
        inHandle: undefined,
        outHandle: undefined,
        broken: undefined,
      });
    } else {
      // Corner → smooth: auto-tangent from neighbors.
      const { inHandle, outHandle } = autoSmoothHandles(anchors, i);
      updateAnchor(i, { inHandle, outHandle });
    }
  };

  // Resolve which anchors a context-menu action applies to: the whole
  // selection if the right-clicked anchor is part of a multi-selection,
  // otherwise just the clicked anchor.
  const targetsFor = (index: number, subpathIndex?: number): SelKey[] => {
    const sub = subpathIndex ?? env.activeSubpathRef.current;
    const k = selKey(sub, index);
    const sel = env.selectedRef.current;
    if (sel.has(k) && sel.size > 1) return [...sel];
    return [k];
  };

  // Resolve one Shape Builder gesture (spec 071926 M3): one onChange — so
  // one undo entry — per gesture. The subpath list restructures, so the
  // active index and anchor selection reset.
  const applyShapeBuilder = (
    faces: FaceRef[],
    op: "merge" | "delete"
  ) => {
    const cur = env.valueRef.current;
    const stored = subpathsOf(cur);
    const next = applyShapeBuilderOp(stored, faces, op);
    if (next === stored) return; // gesture resolved to nothing
    env.onChangeRef.current({ ...cur, subpaths: next });
    env.setActiveSubpath(0);
    env.setSelected(new Set());
  };

  // All anchor positions in client px, for the snapping service (snapping.ts):
  // every anchor of every subpath, minus `excludeActive` indices of the
  // ACTIVE subpath (the dragged ones — an anchor must not snap to itself; a
  // pen click excludes the whole active subpath so a new point never lands
  // exactly on a neighbor and mints a degenerate segment).
  const anchorSnapTargets = (
    exclude: Set<SelKey> | null
  ): Array<{ x: number; y: number }> => {
    const subs = subpathsOf(env.valueRef.current);
    const out: Array<{ x: number; y: number }> = [];
    for (let s = 0; s < subs.length; s++) {
      const anchors = subs[s]?.anchors ?? [];
      for (let i = 0; i < anchors.length; i++) {
        if (exclude && exclude.has(selKey(s, i))) continue;
        out.push(env.normToPx(anchors[i].pos));
      }
    }
    // Other Spline Draw nodes' anchors (multi-node ghosts, spec 072726 M5) —
    // empty when ghosts are hidden.
    for (const p of env.ghostSnapPx) out.push(p);
    return out;
  };

  const applyHandleOp = (
    index: number,
    op: (a: SplineAnchor) => SplineAnchor,
    subpathIndex?: number
  ) => {
    const subI = subpathIndex ?? env.activeSubpathRef.current;
    const patches = new Map<SelKey, Partial<SplineAnchor>>();
    for (const k of targetsFor(index, subI)) {
      const { sub, index: idx } = parseSelKey(k);
      const a = anchorsOf(sub)[idx];
      if (!a) continue;
      const r = op(a);
      patches.set(k, {
        inHandle: r.inHandle,
        outHandle: r.outHandle,
        broken: r.broken,
      });
    }
    if (patches.size) patchBySelKey(patches);
  };

  // Harmonize (spec 080226 M2): slide each qualifying target anchor along
  // its handle axis to G2 curvature continuity (geometry.ts owns the math).
  // Non-qualifying anchors (broken, endpoints, straight sides) skip
  // silently; one patchAnchors for the lot.
  const harmonizeAnchors = (index: number, subpathIndex?: number) => {
    const subI = subpathIndex ?? env.activeSubpathRef.current;
    const patches = new Map<SelKey, Partial<SplineAnchor>>();
    for (const k of targetsFor(index, subI)) {
      const { sub, index: idx } = parseSelKey(k);
      const sp = subpathsOf(env.valueRef.current)[sub];
      if (!sp) continue;
      const patch = harmonizeAnchor(sp.anchors, sp.closed, idx);
      if (patch) patches.set(k, patch);
    }
    if (patches.size) patchBySelKey(patches);
  };

  return {
    readAnchors,
    anchorsOf,
    withSubpathPatch,
    selectSubpath,
    selectAllAnchors,
    addAnchorAt,
    findInsertOnSpline,
    insertAnchorOnSegment,
    updateAnchor,
    patchAnchors,
    patchBySelKey,
    moveAnchors,
    translateWholePath,
    scaleWholePath,
    applyBBoxDrag,
    deleteAnchorIndices,
    deleteAnchor,
    toggleClosed,
    startNewSubpath,
    appendSubpath,
    deleteActiveSubpath,
    toggleCornerSmooth,
    targetsFor,
    applyHandleOp,
    harmonizeAnchors,
    anchorSnapTargets,
    applyShapeBuilder,
    cutAtAnchor,
    cutAtSegmentPoint,
    joinPath,
    reverseActiveSubpath,
    alignSelected,
    distributeSelected,
    centerSelected,
    mirrorSelected,
    mergeSelectedAtCenter,
    mergeSelectedByDistance,
  };
}
