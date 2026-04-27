"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  TimelineCurveHandleMode,
  TimelineCurvePoint,
  TimelineCurveValue,
} from "@/engine/types";
import {
  defaultTimelineCurve,
  evalTimelineCurveNormalized,
  sanitizeTimelineCurve,
} from "@/nodes/source/timeline/eval";

interface Props {
  value: TimelineCurveValue;
  onChange: (next: TimelineCurveValue) => void;
  // Last wrapped-t the evaluator stashed for this Timeline (0..1). Drawn
  // as a vertical guide with a draggable handle at the top.
  playheadT: number | null;
  // Total height of the editor area in px (excluding the resize handle
  // and footer). The width is whatever the parent provides.
  height: number;
  // Called when the user drags the playhead handle. The editor reports
  // a target time in seconds; the parent maps it onto its own playback
  // model (typically `time = t * sceneDuration`).
  onScrub?: (tNormalized: number) => void;
}

// View transform: maps logical 0..1 curve space into screen px. We allow
// panning (logical extent can extend past [0,1]) and horizontal-only zoom
// per spec ("two-finger pan left/right zooms in/out").
//
// Vertical viewport stays fixed at logical [0..1] for simplicity (spec §3.3
// out-of-bounds indicator pattern).
interface ViewTransform {
  // Logical-x at screen-x = 0.
  x0: number;
  // Logical-x at screen-x = width (so px-per-unit = width / (x1 - x0)).
  x1: number;
  // Logical-y at the bottom edge.
  y0: number;
  // Logical-y at the top edge.
  y1: number;
}

const PADDING = { top: 16, right: 24, bottom: 28, left: 32 };

function defaultView(): ViewTransform {
  return { x0: -0.05, x1: 1.05, y0: -0.05, y1: 1.05 };
}

type DragKind =
  | { kind: "none" }
  | {
      kind: "point";
      pointIdx: number;
      // For multi-select drags, all selected points move by the same delta.
      group: number[];
      startMouseX: number;
      startMouseY: number;
      // Snapshot of {x,y} per group index at drag start.
      starts: Map<number, { x: number; y: number }>;
      // For shift-axis-constrain: 'free' until first significant motion.
      axis: "free" | "x" | "y";
    }
  | {
      kind: "handle";
      pointIdx: number;
      side: "left" | "right";
      startMouseX: number;
      startMouseY: number;
      startHandle: { dx: number; dy: number };
      axis: "free" | "x" | "y";
    }
  | {
      kind: "pan";
      startMouseX: number;
      startMouseY: number;
      startView: ViewTransform;
    }
  | {
      kind: "scrub";
    }
  | {
      kind: "marquee";
      startMouseX: number;
      startMouseY: number;
      currentMouseX: number;
      currentMouseY: number;
    };

const HANDLE_MODES: TimelineCurveHandleMode[] = [
  "aligned",
  "mirrored",
  "free",
  "vector",
];

const EASING_PRESETS = [
  "Linear",
  "Ease In",
  "Ease Out",
  "Ease In-Out",
  "Hold",
] as const;
type EasingPreset = (typeof EASING_PRESETS)[number];

export default function TimelineCurveEditor({
  value,
  onChange,
  playheadT,
  height,
  onScrub,
}: Props) {
  const safeValue = useMemo(() => sanitizeTimelineCurve(value), [value]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [width, setWidth] = useState(800);
  const [view, setView] = useState<ViewTransform>(defaultView);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [drag, setDrag] = useState<DragKind>({ kind: "none" });
  const [menu, setMenu] = useState<
    | { x: number; y: number; pointIdx: number; sub: null | "mode" | "easing" }
    | null
  >(null);
  // Snapshot value at drag start so we can compute deltas without losing
  // precision through repeated rounding.
  const valueRef = useRef(safeValue);
  valueRef.current = safeValue;

  const innerW = Math.max(40, width - PADDING.left - PADDING.right);
  const innerH = Math.max(40, height - PADDING.top - PADDING.bottom);

  // Track container width.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setWidth(el.clientWidth);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Coordinate helpers.
  const xToScreen = useCallback(
    (lx: number) => {
      const t = (lx - view.x0) / (view.x1 - view.x0);
      return PADDING.left + t * innerW;
    },
    [view, innerW]
  );
  const yToScreen = useCallback(
    (ly: number) => {
      // y=0 at bottom, y=1 at top.
      const t = (ly - view.y0) / (view.y1 - view.y0);
      return PADDING.top + (1 - t) * innerH;
    },
    [view, innerH]
  );
  const screenToX = useCallback(
    (sx: number) => {
      const t = (sx - PADDING.left) / innerW;
      return view.x0 + t * (view.x1 - view.x0);
    },
    [view, innerW]
  );
  const screenToY = useCallback(
    (sy: number) => {
      const t = 1 - (sy - PADDING.top) / innerH;
      return view.y0 + t * (view.y1 - view.y0);
    },
    [view, innerH]
  );

  // Hit testing radii (screen px).
  const POINT_HIT = 9;
  const HANDLE_HIT = 7;

  function getMousePos(e: React.MouseEvent | MouseEvent) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function pointAt(sx: number, sy: number): number | null {
    const cps = valueRef.current.controlPoints;
    for (let i = 0; i < cps.length; i++) {
      const px = xToScreen(cps[i].x);
      const py = yToScreen(cps[i].y);
      if (Math.hypot(px - sx, py - sy) <= POINT_HIT) return i;
    }
    return null;
  }

  function handleAt(
    sx: number,
    sy: number
  ): { idx: number; side: "left" | "right" } | null {
    // Only handles for selected points are hit-testable.
    const cps = valueRef.current.controlPoints;
    for (const i of selected) {
      const cp = cps[i];
      if (!cp) continue;
      // Don't show a left-handle for index 0 or right-handle for last.
      if (i > 0) {
        const hx = xToScreen(cp.x + cp.leftHandle.dx);
        const hy = yToScreen(cp.y + cp.leftHandle.dy);
        if (Math.hypot(hx - sx, hy - sy) <= HANDLE_HIT)
          return { idx: i, side: "left" };
      }
      if (i < cps.length - 1) {
        const hx = xToScreen(cp.x + cp.rightHandle.dx);
        const hy = yToScreen(cp.y + cp.rightHandle.dy);
        if (Math.hypot(hx - sx, hy - sy) <= HANDLE_HIT)
          return { idx: i, side: "right" };
      }
    }
    return null;
  }

  // ----- Wheel: pan or zoom (Cmd/Ctrl) -----
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      // Don't let our gesture bubble out and drive the surrounding canvas
      // viewport's pan/zoom too.
      e.stopPropagation();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      // Trackpads send small deltaX/deltaY; mouse wheels send deltaY in
      // larger steps. We use both axes — pan moves in both, and Cmd-zoom
      // applies to whichever axis (or both) the gesture moved on.
      const dx = e.deltaX || 0;
      const dy = e.deltaY || 0;
      const isZoom = e.metaKey || e.ctrlKey;
      setView((prev) => {
        const xSpan = prev.x1 - prev.x0;
        const ySpan = prev.y1 - prev.y0;
        if (isZoom) {
          // Independent x/y zoom around the mouse cursor. Horizontal
          // gesture → x-zoom; vertical → y-zoom; diagonal → both. The
          // anchor point (logical coord at mouse) stays fixed in each
          // axis we're actively zooming.
          const tx = (mx - PADDING.left) / Math.max(1, innerW);
          const ty = 1 - (my - PADDING.top) / Math.max(1, innerH);
          const lxAt = prev.x0 + tx * xSpan;
          const lyAt = prev.y0 + ty * ySpan;
          let x0 = prev.x0;
          let x1 = prev.x1;
          let y0 = prev.y0;
          let y1 = prev.y1;
          // Trackpads tend to send tiny crosstalk on the other axis; only
          // zoom an axis whose delta is meaningful relative to the other.
          const ax = Math.abs(dx);
          const ay = Math.abs(dy);
          const dom = Math.max(ax, ay);
          const xActive = dom > 0.01 && ax >= dom * 0.25;
          const yActive = dom > 0.01 && ay >= dom * 0.25;
          if (xActive) {
            const factor = Math.exp(dx * 0.005);
            const nextSpan = Math.max(0.05, Math.min(20, xSpan * factor));
            x0 = lxAt - tx * nextSpan;
            x1 = x0 + nextSpan;
          }
          if (yActive) {
            const factor = Math.exp(dy * 0.005);
            const nextSpan = Math.max(0.05, Math.min(20, ySpan * factor));
            y0 = lyAt - ty * nextSpan;
            y1 = y0 + nextSpan;
          }
          return { x0, x1, y0, y1 };
        }
        // Pan: each axis delta scrolls its own axis. Vertical delta moves
        // logical-y in the matching screen direction (deltaY > 0 = scroll
        // down → view shifts down → logical y0/y1 decrease).
        const xPxPerUnit = innerW / xSpan;
        const yPxPerUnit = innerH / ySpan;
        const dLx = dx / xPxPerUnit;
        const dLy = dy / yPxPerUnit;
        return {
          x0: prev.x0 + dLx,
          x1: prev.x1 + dLx,
          y0: prev.y0 - dLy,
          y1: prev.y1 - dLy,
        };
      });
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [innerW, innerH]);

  // ----- Mouse interactions -----
  function commit(next: TimelineCurveValue) {
    onChange(next);
  }

  function setPoint(i: number, patch: Partial<TimelineCurvePoint>) {
    const cps = valueRef.current.controlPoints.map((p, idx) =>
      idx === i ? { ...p, ...patch } : p
    );
    commit({ controlPoints: cps });
  }

  function setMultiplePoints(updates: Map<number, Partial<TimelineCurvePoint>>) {
    const cps = valueRef.current.controlPoints.map((p, idx) => {
      const patch = updates.get(idx);
      return patch ? { ...p, ...patch } : p;
    });
    commit({ controlPoints: cps });
  }

  function deletePoint(i: number) {
    const cps = valueRef.current.controlPoints;
    if (i === 0 || i === cps.length - 1) return;
    const next = cps.filter((_, idx) => idx !== i);
    commit({ controlPoints: next });
  }

  function addPointAt(lx: number, ly: number) {
    const cps = valueRef.current.controlPoints;
    const x = Math.max(0, Math.min(1, lx));
    // Insertion index — keep sorted by x, but never before 0 or after last.
    let insertAt = cps.length - 1;
    for (let i = 0; i < cps.length - 1; i++) {
      if (x >= cps[i].x && x <= cps[i + 1].x) {
        insertAt = i + 1;
        break;
      }
    }
    // Slope from neighbors for a sensible default tangent.
    const prev = cps[insertAt - 1];
    const next = cps[insertAt];
    const slope =
      next && prev
        ? (next.y - prev.y) / Math.max(1e-6, next.x - prev.x)
        : 0;
    const tan = 0.1;
    const newPoint: TimelineCurvePoint = {
      x,
      y: ly,
      handleMode: "aligned",
      leftHandle: { dx: -tan, dy: -tan * slope },
      rightHandle: { dx: tan, dy: tan * slope },
    };
    const out = [...cps.slice(0, insertAt), newPoint, ...cps.slice(insertAt)];
    commit({ controlPoints: out });
    return insertAt;
  }

  // Mouse-down on the SVG — dispatch to point/handle/marquee/pan.
  function onMouseDown(e: React.MouseEvent) {
    if (menu) setMenu(null);
    const { x, y } = getMousePos(e);
    // Middle button → pan.
    if (e.button === 1) {
      e.preventDefault();
      setDrag({ kind: "pan", startMouseX: x, startMouseY: y, startView: view });
      return;
    }
    if (e.button !== 0) return;

    // Right click handled in onContextMenu.
    const handleHit = handleAt(x, y);
    if (handleHit) {
      const cp = valueRef.current.controlPoints[handleHit.idx];
      const startHandle =
        handleHit.side === "left" ? cp.leftHandle : cp.rightHandle;
      setDrag({
        kind: "handle",
        pointIdx: handleHit.idx,
        side: handleHit.side,
        startMouseX: x,
        startMouseY: y,
        startHandle: { ...startHandle },
        axis: e.shiftKey ? "free" : "free",
      });
      return;
    }

    const ptHit = pointAt(x, y);
    if (ptHit !== null) {
      // Plain click: if hitting an already-selected point keep the
      // multi-selection (so we can drag the group); otherwise single-
      // select. Shift+click on a point begins an axis-constrained drag of
      // that single point — it does not toggle selection.
      let nextSel = new Set(selected);
      if (!nextSel.has(ptHit)) nextSel = new Set([ptHit]);
      setSelected(nextSel);
      const cps = valueRef.current.controlPoints;
      const starts = new Map<number, { x: number; y: number }>();
      for (const i of nextSel) starts.set(i, { x: cps[i].x, y: cps[i].y });
      setDrag({
        kind: "point",
        pointIdx: ptHit,
        group: [...nextSel],
        startMouseX: x,
        startMouseY: y,
        starts,
        axis: "free",
      });
      return;
    }

    // Empty canvas. Shift+click → add point. Else marquee.
    if (e.shiftKey) {
      const lx = screenToX(x);
      const ly = screenToY(y);
      const newIdx = addPointAt(lx, ly);
      setSelected(new Set([newIdx]));
      return;
    }
    setSelected(new Set());
    setDrag({
      kind: "marquee",
      startMouseX: x,
      startMouseY: y,
      currentMouseX: x,
      currentMouseY: y,
    });
  }

  // Window-level move/up to keep dragging when cursor leaves the SVG.
  useEffect(() => {
    if (drag.kind === "none") return;
    function onMove(ev: MouseEvent) {
      const { x, y } = getMousePos(ev);
      if (drag.kind === "pan") {
        const xSpan = drag.startView.x1 - drag.startView.x0;
        const ySpan = drag.startView.y1 - drag.startView.y0;
        const dLx = ((x - drag.startMouseX) / innerW) * xSpan;
        const dLy = ((y - drag.startMouseY) / innerH) * ySpan;
        setView({
          x0: drag.startView.x0 - dLx,
          x1: drag.startView.x1 - dLx,
          y0: drag.startView.y0 + dLy,
          y1: drag.startView.y1 + dLy,
        });
        return;
      }
      if (drag.kind === "scrub") {
        if (onScrub) {
          const lx = screenToX(x);
          const wrapped = lx - Math.floor(lx);
          onScrub(wrapped);
        }
        return;
      }
      if (drag.kind === "marquee") {
        setDrag({ ...drag, currentMouseX: x, currentMouseY: y });
        return;
      }
      if (drag.kind === "point") {
        let dx = x - drag.startMouseX;
        let dy = y - drag.startMouseY;
        let axis = drag.axis;
        if (ev.shiftKey && axis === "free") {
          if (Math.hypot(dx, dy) > 4) {
            axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
            setDrag({ ...drag, axis });
          }
        }
        if (!ev.shiftKey && axis !== "free") {
          axis = "free";
          setDrag({ ...drag, axis });
        }
        if (axis === "x") dy = 0;
        if (axis === "y") dx = 0;
        const span = view.x1 - view.x0;
        const dLx = dx * (span / innerW);
        const dLy = -dy / innerH;
        const cps = valueRef.current.controlPoints;
        const updates = new Map<number, Partial<TimelineCurvePoint>>();
        for (const i of drag.group) {
          const start = drag.starts.get(i);
          if (!start) continue;
          let nx = start.x + dLx;
          const ny = start.y + dLy;
          // Endpoints locked on x.
          if (i === 0) nx = 0;
          else if (i === cps.length - 1) nx = 1;
          else {
            // Clamp to neighbors (no reorder via drag).
            const left = cps[i - 1].x;
            const right = cps[i + 1].x;
            nx = Math.max(left + 1e-4, Math.min(right - 1e-4, nx));
          }
          updates.set(i, { x: nx, y: ny });
        }
        setMultiplePoints(updates);
        return;
      }
      if (drag.kind === "handle") {
        let dx = x - drag.startMouseX;
        let dy = y - drag.startMouseY;
        let axis = drag.axis;
        if (ev.shiftKey && axis === "free") {
          if (Math.hypot(dx, dy) > 4) {
            axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
            setDrag({ ...drag, axis });
          }
        }
        if (!ev.shiftKey && axis !== "free") {
          axis = "free";
          setDrag({ ...drag, axis });
        }
        if (axis === "x") dy = 0;
        if (axis === "y") dx = 0;
        const span = view.x1 - view.x0;
        const dLx = dx * (span / innerW);
        const dLy = -dy / innerH;
        const cp = valueRef.current.controlPoints[drag.pointIdx];
        if (!cp) return;
        if (cp.handleMode === "vector") return;
        const newDx = drag.startHandle.dx + dLx;
        const newDy = drag.startHandle.dy + dLy;
        let leftHandle = cp.leftHandle;
        let rightHandle = cp.rightHandle;
        if (drag.side === "left") {
          leftHandle = { dx: newDx, dy: newDy };
          if (cp.handleMode === "aligned") {
            const len = Math.hypot(cp.rightHandle.dx, cp.rightHandle.dy);
            const mag = Math.hypot(newDx, newDy);
            if (mag > 1e-6) {
              rightHandle = {
                dx: -newDx * (len / mag),
                dy: -newDy * (len / mag),
              };
            }
          } else if (cp.handleMode === "mirrored") {
            rightHandle = { dx: -newDx, dy: -newDy };
          }
        } else {
          rightHandle = { dx: newDx, dy: newDy };
          if (cp.handleMode === "aligned") {
            const len = Math.hypot(cp.leftHandle.dx, cp.leftHandle.dy);
            const mag = Math.hypot(newDx, newDy);
            if (mag > 1e-6) {
              leftHandle = {
                dx: -newDx * (len / mag),
                dy: -newDy * (len / mag),
              };
            }
          } else if (cp.handleMode === "mirrored") {
            leftHandle = { dx: -newDx, dy: -newDy };
          }
        }
        setPoint(drag.pointIdx, { leftHandle, rightHandle });
        return;
      }
    }
    function onUp() {
      if (drag.kind === "marquee") {
        // Finalize selection.
        const x0 = Math.min(drag.startMouseX, drag.currentMouseX);
        const x1 = Math.max(drag.startMouseX, drag.currentMouseX);
        const y0 = Math.min(drag.startMouseY, drag.currentMouseY);
        const y1 = Math.max(drag.startMouseY, drag.currentMouseY);
        const cps = valueRef.current.controlPoints;
        const next = new Set<number>();
        for (let i = 0; i < cps.length; i++) {
          const sx = xToScreen(cps[i].x);
          const sy = yToScreen(cps[i].y);
          if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) next.add(i);
        }
        setSelected(next);
      }
      setDrag({ kind: "none" });
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag, innerW, innerH, view, xToScreen, yToScreen, screenToX, onScrub]);

  // Keyboard: delete / escape.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setSelected(new Set());
        setMenu(null);
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selected.size === 0) return;
        // Don't delete if focus is in an input.
        const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
        if (tag === "input" || tag === "textarea") return;
        e.preventDefault();
        const cps = valueRef.current.controlPoints;
        const last = cps.length - 1;
        const keep = cps.filter(
          (_, i) => i === 0 || i === last || !selected.has(i)
        );
        setSelected(new Set());
        commit({ controlPoints: keep });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  // ----- Right-click menu -----
  function onContextMenu(e: React.MouseEvent) {
    const { x, y } = getMousePos(e);
    const ptHit = pointAt(x, y);
    if (ptHit === null) return;
    e.preventDefault();
    setSelected(new Set([ptHit]));
    setMenu({ x: e.clientX, y: e.clientY, pointIdx: ptHit, sub: null });
  }

  function applyEasingPreset(idx: number, preset: EasingPreset) {
    const cps = valueRef.current.controlPoints;
    const cp = cps[idx];
    if (!cp) return;
    let leftHandle = cp.leftHandle;
    let rightHandle = cp.rightHandle;
    let mode = cp.handleMode;
    const TAN = 0.15;
    if (preset === "Linear") {
      mode = "aligned";
      leftHandle = { dx: -TAN, dy: 0 };
      rightHandle = { dx: TAN, dy: 0 };
    } else if (preset === "Ease In") {
      mode = "free";
      leftHandle = { dx: -TAN, dy: 0 };
      rightHandle = { dx: TAN, dy: -TAN };
    } else if (preset === "Ease Out") {
      mode = "free";
      leftHandle = { dx: -TAN, dy: TAN };
      rightHandle = { dx: TAN, dy: 0 };
    } else if (preset === "Ease In-Out") {
      mode = "aligned";
      leftHandle = { dx: -TAN, dy: TAN };
      rightHandle = { dx: TAN, dy: -TAN };
    } else if (preset === "Hold") {
      mode = "vector";
      leftHandle = { dx: 0, dy: 0 };
      rightHandle = { dx: 0, dy: 0 };
    }
    const updates = new Map<number, Partial<TimelineCurvePoint>>();
    updates.set(idx, { handleMode: mode, leftHandle, rightHandle });
    setMultiplePoints(updates);
  }

  function setHandleMode(idx: number, mode: TimelineCurveHandleMode) {
    const cp = valueRef.current.controlPoints[idx];
    if (!cp) return;
    let leftHandle = cp.leftHandle;
    let rightHandle = cp.rightHandle;
    if (mode === "vector") {
      leftHandle = { dx: 0, dy: 0 };
      rightHandle = { dx: 0, dy: 0 };
    } else if (mode === "mirrored") {
      // Force exact mirror from current right handle.
      leftHandle = { dx: -rightHandle.dx, dy: -rightHandle.dy };
    } else if (mode === "aligned") {
      // Force colinearity using right handle's direction, preserving lengths.
      const rLen = Math.hypot(rightHandle.dx, rightHandle.dy);
      const lLen = Math.hypot(leftHandle.dx, leftHandle.dy);
      if (rLen > 1e-6 && lLen > 1e-6) {
        leftHandle = {
          dx: -rightHandle.dx * (lLen / rLen),
          dy: -rightHandle.dy * (lLen / rLen),
        };
      }
    }
    setPoint(idx, { handleMode: mode, leftHandle, rightHandle });
  }

  function resetHandles(idx: number) {
    const cps = valueRef.current.controlPoints;
    const prev = cps[idx - 1];
    const next = cps[idx + 1];
    const slope =
      next && prev
        ? (next.y - prev.y) / Math.max(1e-6, next.x - prev.x)
        : 0;
    const tan = 0.1;
    setPoint(idx, {
      handleMode: "aligned",
      leftHandle: { dx: -tan, dy: -tan * slope },
      rightHandle: { dx: tan, dy: tan * slope },
    });
  }

  // ----- Render -----
  const cps = safeValue.controlPoints;
  const pathD = useMemo(() => buildPath(cps, xToScreen, yToScreen), [
    cps,
    xToScreen,
    yToScreen,
  ]);

  // Out-of-bounds Y indicators per point.
  const oobIndicators = cps
    .map((p, i) => {
      if (p.y >= 0 && p.y <= 1) return null;
      const sx = xToScreen(p.x);
      const sy = p.y > 1 ? PADDING.top + 4 : PADDING.top + innerH - 4;
      const sym = p.y > 1 ? "▲" : "▼";
      return { i, sx, sy, sym };
    })
    .filter((v): v is { i: number; sx: number; sy: number; sym: string } => !!v);

  // Greyed-out region masks (logical x outside [0,1]).
  const leftMaskW = Math.max(0, xToScreen(0) - PADDING.left);
  const rightMaskX = Math.min(PADDING.left + innerW, xToScreen(1));
  const rightMaskW = Math.max(0, PADDING.left + innerW - rightMaskX);

  const playheadX = playheadT != null ? xToScreen(playheadT) : null;

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height,
        background: "#0a0a0a",
        position: "relative",
        userSelect: "none",
        fontFamily: "ui-monospace, monospace",
        fontSize: 10,
        color: "#a1a1aa",
      }}
    >
      <svg
        ref={svgRef}
        width={width}
        height={height}
        style={{
          display: "block",
          cursor:
            drag.kind === "pan"
              ? "grabbing"
              : drag.kind === "scrub"
                ? "ew-resize"
                : "default",
        }}
        onMouseDown={onMouseDown}
        onContextMenu={onContextMenu}
      >
        {/* In-range background */}
        <rect
          x={PADDING.left}
          y={PADDING.top}
          width={innerW}
          height={innerH}
          fill="#111114"
          stroke="#27272a"
        />
        {/* Out-of-range left/right masks */}
        {leftMaskW > 0 && (
          <rect
            x={PADDING.left}
            y={PADDING.top}
            width={leftMaskW}
            height={innerH}
            fill="#050505"
          />
        )}
        {rightMaskW > 0 && (
          <rect
            x={rightMaskX}
            y={PADDING.top}
            width={rightMaskW}
            height={innerH}
            fill="#050505"
          />
        )}

        {/* Gridlines at logical 0, 0.25, 0.5, 0.75, 1 (only those visible) */}
        {[0, 0.25, 0.5, 0.75, 1].map((g) => {
          const sx = xToScreen(g);
          if (sx < PADDING.left || sx > PADDING.left + innerW) return null;
          const major = g === 0 || g === 1;
          return (
            <g key={`gx-${g}`}>
              <line
                x1={sx}
                y1={PADDING.top}
                x2={sx}
                y2={PADDING.top + innerH}
                stroke={major ? "#3f3f46" : "#27272a"}
                strokeDasharray={major ? undefined : "2 3"}
              />
              <text
                x={sx}
                y={PADDING.top + innerH + 14}
                textAnchor="middle"
                fill="#52525b"
              >
                {g.toFixed(2)}
              </text>
            </g>
          );
        })}
        {[0, 0.25, 0.5, 0.75, 1].map((g) => {
          const sy = yToScreen(g);
          return (
            <g key={`gy-${g}`}>
              <line
                x1={PADDING.left}
                y1={sy}
                x2={PADDING.left + innerW}
                y2={sy}
                stroke={g === 0 || g === 1 ? "#3f3f46" : "#27272a"}
                strokeDasharray={g === 0 || g === 1 ? undefined : "2 3"}
              />
              <text
                x={PADDING.left - 6}
                y={sy + 3}
                textAnchor="end"
                fill="#52525b"
              >
                {g.toFixed(2)}
              </text>
            </g>
          );
        })}

        {/* Curve */}
        <path
          d={pathD}
          fill="none"
          stroke="#60a5fa"
          strokeWidth={1.5}
        />

        {/* Handles (only for selected points) */}
        {[...selected].map((i) => {
          const cp = cps[i];
          if (!cp) return null;
          const sx = xToScreen(cp.x);
          const sy = yToScreen(cp.y);
          const lx = xToScreen(cp.x + cp.leftHandle.dx);
          const ly = yToScreen(cp.y + cp.leftHandle.dy);
          const rx = xToScreen(cp.x + cp.rightHandle.dx);
          const ry = yToScreen(cp.y + cp.rightHandle.dy);
          return (
            <g key={`h-${i}`}>
              {i > 0 && (
                <>
                  <line
                    x1={sx}
                    y1={sy}
                    x2={lx}
                    y2={ly}
                    stroke="#52525b"
                  />
                  <rect
                    x={lx - 4}
                    y={ly - 4}
                    width={8}
                    height={8}
                    fill="#fbbf24"
                    stroke="#92400e"
                    style={{ cursor: "move" }}
                  />
                </>
              )}
              {i < cps.length - 1 && (
                <>
                  <line
                    x1={sx}
                    y1={sy}
                    x2={rx}
                    y2={ry}
                    stroke="#52525b"
                  />
                  <rect
                    x={rx - 4}
                    y={ry - 4}
                    width={8}
                    height={8}
                    fill="#fbbf24"
                    stroke="#92400e"
                    style={{ cursor: "move" }}
                  />
                </>
              )}
            </g>
          );
        })}

        {/* Control points */}
        {cps.map((p, i) => {
          const sx = xToScreen(p.x);
          const sy = yToScreen(Math.max(0, Math.min(1, p.y)));
          const isSel = selected.has(i);
          return (
            <circle
              key={`p-${i}`}
              cx={sx}
              cy={sy}
              r={isSel ? 5 : 4}
              fill={isSel ? "#60a5fa" : "#0a0a0a"}
              stroke="#60a5fa"
              strokeWidth={1.5}
              style={{ cursor: "move" }}
            />
          );
        })}

        {/* Out-of-bounds indicators */}
        {oobIndicators.map(({ i, sx, sy, sym }) => (
          <text
            key={`oob-${i}`}
            x={sx}
            y={sy}
            textAnchor="middle"
            fill="#f59e0b"
            fontSize={10}
          >
            {sym}
          </text>
        ))}

        {/* Playhead — vertical guide plus a draggable handle at the top
            edge for direct scrubbing. Only the handle starts a scrub
            drag, so panning/clicking the empty graph still works. */}
        {playheadX != null &&
          playheadX >= PADDING.left &&
          playheadX <= PADDING.left + innerW && (
            <g>
              <line
                x1={playheadX}
                y1={PADDING.top}
                x2={playheadX}
                y2={PADDING.top + innerH}
                stroke="#22c55e"
                strokeWidth={1}
                opacity={0.8}
              />
              {onScrub && (
                <polygon
                  points={`${playheadX - 6},${PADDING.top - 10} ${playheadX + 6},${PADDING.top - 10} ${playheadX + 6},${PADDING.top - 2} ${playheadX},${PADDING.top + 3} ${playheadX - 6},${PADDING.top - 2}`}
                  fill="#22c55e"
                  stroke="#14532d"
                  strokeWidth={1}
                  style={{ cursor: "ew-resize" }}
                  onMouseDown={(e) => {
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    e.preventDefault();
                    setDrag({ kind: "scrub" });
                    const lx = screenToX(playheadX);
                    onScrub(lx - Math.floor(lx));
                  }}
                />
              )}
            </g>
          )}

        {/* Marquee */}
        {drag.kind === "marquee" && (
          <rect
            x={Math.min(drag.startMouseX, drag.currentMouseX)}
            y={Math.min(drag.startMouseY, drag.currentMouseY)}
            width={Math.abs(drag.currentMouseX - drag.startMouseX)}
            height={Math.abs(drag.currentMouseY - drag.startMouseY)}
            fill="rgba(96, 165, 250, 0.1)"
            stroke="#60a5fa"
            strokeDasharray="3 3"
          />
        )}
      </svg>

      {/* Status footer */}
      <div
        style={{
          position: "absolute",
          left: 8,
          bottom: 4,
          color: "#52525b",
          pointerEvents: "none",
        }}
      >
        {cps.length} pts · {selected.size} sel · view [
        {view.x0.toFixed(2)}, {view.x1.toFixed(2)}]
      </div>

      {menu && (
        <ContextMenu
          menu={menu}
          point={cps[menu.pointIdx]}
          isFirstOrLast={
            menu.pointIdx === 0 || menu.pointIdx === cps.length - 1
          }
          onClose={() => setMenu(null)}
          onSetMode={(mode) => setHandleMode(menu.pointIdx, mode)}
          onPreset={(p) => applyEasingPreset(menu.pointIdx, p)}
          onResetHandles={() => resetHandles(menu.pointIdx)}
          onDelete={() => {
            deletePoint(menu.pointIdx);
            setSelected(new Set());
            setMenu(null);
          }}
          onSetValue={(yVal) => setPoint(menu.pointIdx, { y: yVal })}
          onSetPosition={(xVal) => {
            const cps2 = valueRef.current.controlPoints;
            const i = menu.pointIdx;
            if (i === 0 || i === cps2.length - 1) return;
            const left = cps2[i - 1].x;
            const right = cps2[i + 1].x;
            const clamped = Math.max(
              left + 1e-4,
              Math.min(right - 1e-4, xVal)
            );
            setPoint(i, { x: clamped });
          }}
          onSubmenu={(sub) => setMenu({ ...menu, sub })}
        />
      )}
    </div>
  );
}

function buildPath(
  cps: TimelineCurvePoint[],
  xToScreen: (x: number) => number,
  yToScreen: (y: number) => number
): string {
  if (cps.length === 0) return "";
  if (cps.length === 1) {
    const sx = xToScreen(cps[0].x);
    const sy = yToScreen(cps[0].y);
    return `M ${sx} ${sy}`;
  }
  let d = `M ${xToScreen(cps[0].x)} ${yToScreen(cps[0].y)}`;
  for (let i = 0; i < cps.length - 1; i++) {
    const a = cps[i];
    const b = cps[i + 1];
    const c1x = xToScreen(a.x + a.rightHandle.dx);
    const c1y = yToScreen(a.y + a.rightHandle.dy);
    const c2x = xToScreen(b.x + b.leftHandle.dx);
    const c2y = yToScreen(b.y + b.leftHandle.dy);
    const x = xToScreen(b.x);
    const y = yToScreen(b.y);
    d += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${x} ${y}`;
  }
  return d;
}

// ===== Context menu =====

interface ContextMenuProps {
  menu: { x: number; y: number; pointIdx: number; sub: null | "mode" | "easing" };
  point: TimelineCurvePoint | undefined;
  isFirstOrLast: boolean;
  onClose: () => void;
  onSetMode: (m: TimelineCurveHandleMode) => void;
  onPreset: (p: EasingPreset) => void;
  onResetHandles: () => void;
  onDelete: () => void;
  onSetValue: (y: number) => void;
  onSetPosition: (x: number) => void;
  onSubmenu: (sub: null | "mode" | "easing") => void;
}

function ContextMenu({
  menu,
  point,
  isFirstOrLast,
  onClose,
  onSetMode,
  onPreset,
  onResetHandles,
  onDelete,
  onSetValue,
  onSetPosition,
  onSubmenu,
}: ContextMenuProps) {
  const [showValue, setShowValue] = useState(false);
  const [showPos, setShowPos] = useState(false);
  const [valueDraft, setValueDraft] = useState(
    point ? String(point.y) : "0"
  );
  const [posDraft, setPosDraft] = useState(point ? String(point.x) : "0");

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (target.closest("[data-timeline-menu]")) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  if (!point) return null;

  const itemStyle: React.CSSProperties = {
    padding: "5px 10px",
    cursor: "pointer",
    fontSize: 11,
    color: "#e5e7eb",
    fontFamily: "ui-monospace, monospace",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  };
  const disabledStyle: React.CSSProperties = {
    ...itemStyle,
    color: "#52525b",
    cursor: "not-allowed",
  };

  return (
    <div
      data-timeline-menu
      style={{
        position: "fixed",
        left: menu.x,
        top: menu.y,
        background: "#18181b",
        border: "1px solid #27272a",
        borderRadius: 4,
        boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
        minWidth: 180,
        zIndex: 1000,
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.sub === "mode" && (
        <>
          {HANDLE_MODES.map((m) => (
            <div
              key={m}
              style={itemStyle}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "#27272a")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
              onClick={() => {
                onSetMode(m);
                onClose();
              }}
            >
              <span>{m[0].toUpperCase() + m.slice(1)}</span>
              <span>{point.handleMode === m ? "✓" : ""}</span>
            </div>
          ))}
          <Divider />
          <div
            style={itemStyle}
            onClick={() => onSubmenu(null)}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = "#27272a")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
          >
            ← Back
          </div>
        </>
      )}
      {menu.sub === "easing" && (
        <>
          {EASING_PRESETS.map((p) => (
            <div
              key={p}
              style={itemStyle}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "#27272a")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
              onClick={() => {
                onPreset(p);
                onClose();
              }}
            >
              {p}
            </div>
          ))}
          <Divider />
          <div
            style={itemStyle}
            onClick={() => onSubmenu(null)}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = "#27272a")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
          >
            ← Back
          </div>
        </>
      )}
      {menu.sub === null && (
        <>
          <div
            style={itemStyle}
            onClick={() => onSubmenu("mode")}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = "#27272a")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
          >
            <span>Handle mode</span>
            <span>›</span>
          </div>
          <div
            style={itemStyle}
            onClick={() => onSubmenu("easing")}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = "#27272a")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
          >
            <span>Easing presets</span>
            <span>›</span>
          </div>
          <div
            style={itemStyle}
            onClick={() => {
              onResetHandles();
              onClose();
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = "#27272a")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
          >
            Reset handles
          </div>
          <Divider />
          {showValue ? (
            <div style={{ ...itemStyle, cursor: "default" }}>
              <span>y =</span>
              <input
                autoFocus
                value={valueDraft}
                onChange={(e) => setValueDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const n = parseFloat(valueDraft);
                    if (Number.isFinite(n)) onSetValue(n);
                    onClose();
                  } else if (e.key === "Escape") {
                    onClose();
                  }
                }}
                style={inputStyle}
              />
            </div>
          ) : (
            <div
              style={itemStyle}
              onClick={() => setShowValue(true)}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "#27272a")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
            >
              Set value…
            </div>
          )}
          {showPos ? (
            <div style={{ ...itemStyle, cursor: "default" }}>
              <span>x =</span>
              <input
                autoFocus
                value={posDraft}
                onChange={(e) => setPosDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const n = parseFloat(posDraft);
                    if (Number.isFinite(n)) onSetPosition(n);
                    onClose();
                  } else if (e.key === "Escape") {
                    onClose();
                  }
                }}
                style={inputStyle}
                disabled={isFirstOrLast}
              />
            </div>
          ) : (
            <div
              style={isFirstOrLast ? disabledStyle : itemStyle}
              onClick={isFirstOrLast ? undefined : () => setShowPos(true)}
              onMouseEnter={(e) => {
                if (!isFirstOrLast)
                  e.currentTarget.style.background = "#27272a";
              }}
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
            >
              Set position…
            </div>
          )}
          <Divider />
          <div
            style={isFirstOrLast ? disabledStyle : itemStyle}
            onClick={isFirstOrLast ? undefined : onDelete}
            onMouseEnter={(e) => {
              if (!isFirstOrLast)
                e.currentTarget.style.background = "#7f1d1d";
            }}
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
          >
            Delete point
          </div>
        </>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: 80,
  background: "#0a0a0a",
  border: "1px solid #27272a",
  color: "#e5e7eb",
  fontFamily: "ui-monospace, monospace",
  fontSize: 11,
  padding: "2px 4px",
  textAlign: "right",
};

function Divider() {
  return (
    <div
      style={{
        height: 1,
        background: "#27272a",
        margin: "2px 0",
      }}
    />
  );
}

// Tiny thumbnail preview of a curve. Used in ParamPanel's collapsed row.
export function TimelineCurveThumbnail({
  value,
  width = 80,
  height = 28,
  active = false,
}: {
  value: TimelineCurveValue;
  width?: number;
  height?: number;
  active?: boolean;
}) {
  const safe = sanitizeTimelineCurve(value);
  const samples = 32;
  let d = "";
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const y = evalTimelineCurveNormalized(safe, t);
    const sx = t * width;
    const sy = (1 - Math.max(0, Math.min(1, y))) * height;
    d += i === 0 ? `M ${sx} ${sy}` : ` L ${sx} ${sy}`;
  }
  return (
    <svg
      width={width}
      height={height}
      style={{
        background: "#111114",
        border: `1px solid ${active ? "#60a5fa" : "#27272a"}`,
        borderRadius: 2,
        display: "block",
      }}
    >
      <path d={d} fill="none" stroke="#60a5fa" strokeWidth={1.2} />
    </svg>
  );
}
