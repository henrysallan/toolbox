// Value-writing operations (and the query helpers that pair with them) for
// the Spline Draw editor overlay. `makeSplineOps(env)` is called every render
// by the component; every function reads live data through the env refs and
// writes through `env.onChangeRef` — one onChange per user-visible operation,
// so undo coalescing stays intact. Split out of the monolith in M0 of
// specdocs/071926_spline-draw-authoring-upgrade.md.

import { applyShapeBuilderOp, type FaceRef } from "@/engine/spline-planar";
import type { SplineAnchor, SplineSubpath } from "@/engine/types";
import type { SplineParamValue } from "@/nodes/source/spline-draw";
import type { BBoxHandle, DragState, SplineEditorEnv } from "./types";
import {
  autoSmoothHandles,
  bezierAt,
  cutSubpathAt,
  harmonizeAnchor,
  mintAnchorId,
  nearestTOnCubic,
  reverseSubpathAnchors,
  splitSegmentAnchors,
  subpathsOf,
} from "./geometry";

export type SplineOps = ReturnType<typeof makeSplineOps>;

export function makeSplineOps(env: SplineEditorEnv) {
  // The anchor-level helpers below operate on the ACTIVE subpath
  // (activeSubpathRef.current). Reads return [] if the value arrives without
  // any subpaths; writes materialize the active subpath on first touch.
  const readAnchors = (v: SplineParamValue): SplineAnchor[] =>
    subpathsOf(v)[env.activeSubpathRef.current]?.anchors ?? [];

  const withSubpathPatch = (
    cur: SplineParamValue,
    patch: Partial<SplineSubpath>
  ): SplineParamValue => {
    const subpaths = subpathsOf(cur);
    const base: SplineSubpath[] =
      subpaths.length > 0 ? subpaths : [{ anchors: [], closed: false }];
    return {
      ...cur,
      subpaths: base.map((s, i) =>
        i === env.activeSubpathRef.current ? { ...s, ...patch } : s
      ),
    };
  };

  // Switch the active subpath, clearing the anchor selection (indices are
  // per-subpath, so they don't carry across).
  const selectSubpath = (i: number) => {
    env.setActiveSubpath(i);
    env.setSelected(new Set());
    // Re-selecting a subpath means you may want to extend it again.
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
    env.setSelected(new Set(anchors.map((_, i) => i)));
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
  const insertAnchorOnSegment = (i: number, j: number, t: number) => {
    const cur = env.valueRef.current;
    const res = splitSegmentAnchors(readAnchors(cur), i, j, t);
    if (!res) return;
    env.onChangeRef.current(withSubpathPatch(cur, { anchors: res.anchors }));
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
  const cutAtAnchor = (idx: number) => {
    const sub = subpathsOf(env.valueRef.current)[env.activeSubpathRef.current];
    if (!sub) return;
    applyCutPieces(cutSubpathAt(sub, idx));
  };
  const cutAtSegmentPoint = (i: number, j: number, t: number) => {
    const sub = subpathsOf(env.valueRef.current)[env.activeSubpathRef.current];
    if (!sub) return;
    const res = splitSegmentAnchors(sub.anchors, i, j, t);
    if (!res) return;
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
    if (endpointIndex === undefined && sel.has(0) && sel.has(n - 1)) {
      toggleClosed();
      return;
    }
    let e: number | null = null;
    if (endpointIndex !== undefined) {
      if (endpointIndex === 0 || endpointIndex === n - 1) e = endpointIndex;
    } else if (sel.size === 1) {
      const s = [...sel][0];
      if (s === 0 || s === n - 1) e = s;
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
    const anchors = readAnchors(env.valueRef.current);
    const sel = [...env.selectedRef.current].filter((i) => anchors[i]);
    if (sel.length < 2) return;
    const avg = sel.reduce((s, i) => s + anchors[i].pos[axis], 0) / sel.length;
    const patches = new Map<number, Partial<SplineAnchor>>();
    for (const i of sel) {
      const pos: [number, number] = [anchors[i].pos[0], anchors[i].pos[1]];
      pos[axis] = avg;
      patches.set(i, { pos });
    }
    patchAnchors(patches);
  };
  const distributeSelected = (axis: 0 | 1) => {
    const anchors = readAnchors(env.valueRef.current);
    const sel = [...env.selectedRef.current].filter((i) => anchors[i]);
    if (sel.length < 3) return;
    const sorted = sel
      .slice()
      .sort((a, b) => anchors[a].pos[axis] - anchors[b].pos[axis]);
    const lo = anchors[sorted[0]].pos[axis];
    const hi = anchors[sorted[sorted.length - 1]].pos[axis];
    const patches = new Map<number, Partial<SplineAnchor>>();
    sorted.forEach((idx, k) => {
      const pos: [number, number] = [anchors[idx].pos[0], anchors[idx].pos[1]];
      pos[axis] = lo + ((hi - lo) * k) / (sorted.length - 1);
      patches.set(idx, { pos });
    });
    patchAnchors(patches);
  };

  const updateAnchor = (i: number, patch: Partial<SplineAnchor>) => {
    const cur = env.valueRef.current;
    const anchors = readAnchors(cur);
    const next = withSubpathPatch(cur, {
      anchors: anchors.map((a, idx) => (idx === i ? { ...a, ...patch } : a)),
    });
    env.onChangeRef.current(next);
  };

  // Patch several anchors in one onChange. Needed when a single gesture
  // (segment drag, align/even on a multi-selection) must touch more than one
  // anchor: calling updateAnchor twice in a row would have the second read a
  // stale value (React hasn't re-rendered yet) and clobber the first.
  const patchAnchors = (patches: Map<number, Partial<SplineAnchor>>) => {
    const cur = env.valueRef.current;
    const anchors = readAnchors(cur);
    const next = withSubpathPatch(cur, {
      anchors: anchors.map((a, idx) => {
        const p = patches.get(idx);
        return p ? { ...a, ...p } : a;
      }),
    });
    env.onChangeRef.current(next);
  };

  // Apply a position delta to many anchors at once. Used for group drags
  // when the user moves a multi-selection in select mode. Handle offsets
  // are stored relative to pos, so they ride along automatically.
  const moveAnchors = (
    starts: Map<number, [number, number]>,
    dx: number,
    dy: number
  ) => {
    const cur = env.valueRef.current;
    const anchors = readAnchors(cur);
    const next = withSubpathPatch(cur, {
      anchors: anchors.map((a, idx) => {
        const start = starts.get(idx);
        if (!start) return a;
        return { ...a, pos: [start[0] + dx, start[1] + dy] };
      }),
    });
    env.onChangeRef.current(next);
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

  const deleteAnchorIndices = (indices: Set<number>) => {
    if (indices.size === 0) return;
    const cur = env.valueRef.current;
    const anchors = readAnchors(cur);
    const next = withSubpathPatch(cur, {
      anchors: anchors.filter((_, idx) => !indices.has(idx)),
    });
    env.onChangeRef.current(next);
  };

  const deleteAnchor = (i: number) => {
    const cur = env.valueRef.current;
    const anchors = readAnchors(cur);
    const next = withSubpathPatch(cur, {
      anchors: anchors.filter((_, idx) => idx !== i),
    });
    env.onChangeRef.current(next);
    // Reindex the selection: anchors after `i` shift down by one, the
    // deleted index drops out. Without this the selection points at
    // stale slots after a delete.
    if (env.selectedRef.current.size > 0) {
      const nextSel = new Set<number>();
      for (const s of env.selectedRef.current) {
        if (s === i) continue;
        nextSel.add(s > i ? s - 1 : s);
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
  const targetsFor = (index: number): number[] => {
    const sel = env.selectedRef.current;
    if (sel.has(index) && sel.size > 1) return [...sel];
    return [index];
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
    excludeActive: Set<number> | null
  ): Array<{ x: number; y: number }> => {
    const subs = subpathsOf(env.valueRef.current);
    const out: Array<{ x: number; y: number }> = [];
    for (let s = 0; s < subs.length; s++) {
      const anchors = subs[s]?.anchors ?? [];
      for (let i = 0; i < anchors.length; i++) {
        if (
          excludeActive &&
          s === env.activeSubpathRef.current &&
          excludeActive.has(i)
        ) {
          continue;
        }
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
    op: (a: SplineAnchor) => SplineAnchor
  ) => {
    const anchors = readAnchors(env.valueRef.current);
    const patches = new Map<number, Partial<SplineAnchor>>();
    for (const idx of targetsFor(index)) {
      const a = anchors[idx];
      if (!a) continue;
      const r = op(a);
      patches.set(idx, {
        inHandle: r.inHandle,
        outHandle: r.outHandle,
        broken: r.broken,
      });
    }
    if (patches.size) patchAnchors(patches);
  };

  // Harmonize (spec 080226 M2): slide each qualifying target anchor along
  // its handle axis to G2 curvature continuity (geometry.ts owns the math).
  // Non-qualifying anchors (broken, endpoints, straight sides) skip
  // silently; one patchAnchors for the lot.
  const harmonizeAnchors = (index: number) => {
    const cur = env.valueRef.current;
    const sub = subpathsOf(cur)[env.activeSubpathRef.current];
    if (!sub) return;
    const patches = new Map<number, Partial<SplineAnchor>>();
    for (const idx of targetsFor(index)) {
      const patch = harmonizeAnchor(sub.anchors, sub.closed, idx);
      if (patch) patches.set(idx, patch);
    }
    if (patches.size) patchAnchors(patches);
  };

  return {
    readAnchors,
    withSubpathPatch,
    selectSubpath,
    selectAllAnchors,
    addAnchorAt,
    findInsertOnSpline,
    insertAnchorOnSegment,
    updateAnchor,
    patchAnchors,
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
  };
}
