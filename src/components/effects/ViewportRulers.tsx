"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { claimPointerGesture } from "@/lib/pointer-claim";
import { TOUCH_DRAG_STYLE } from "@/lib/pointer-drag";
import {
  formatGuidePx,
  guidePosFromClient,
  rulerTickPlan,
  type ViewportGuide,
} from "@/lib/viewport-guides";
import { rectsEqual } from "./overlay-rect";
import { SplineContextMenu } from "./spline-editor/dock";

// Viewport rulers + guides (specdocs/091726_viewport-rulers.md). Rulers run
// along the top and one side of the PRIMARY viewport panel, graduated in
// project pixels and re-graduated as the canvas pans / zooms; dragging out
// of a ruler drops a full-viewport guide over the canvas, dragging a guide
// moves it, and dropping one back on a ruler (or off the panel) deletes it.
// Right-click a guide for Edit position… / Mirror / Delete. The guides
// themselves are plain data owned by EffectsApp (persisted per project);
// this component only reads and writes them. Snapping to guides lives in
// each gizmo (TransformGizmo, PrimitiveGizmo, the spline editor's snap
// service), which receive the same array.
//
// REACHING A GUIDE. The editing overlays sit between the pointer and the
// guide lines most of the time, so a press within a few px of a guide is
// intercepted by ONE window-level capture listener (it runs before the
// overlay underneath and before React's root handlers) when either:
//   - nothing that owns clicks is on top: the preview canvas itself, the
//     guide's own strip, or a surface tagged `data-guide-grab` — the
//     transform / primitive gizmos' move surfaces, where a press on a
//     guide line means the guide (Photoshop's Move-tool rule) and a
//     right-click means nothing else. Handles are never tagged, so a
//     handle snapped onto a guide is still the thing you grab; tools that
//     own their clicks (the pen, paint, the 3D orbit) are never tagged, so
//     a pen click lands an anchor ON the guide instead of moving it;
//   - or ⌘ / Ctrl is held — over anything but HTML controls. Photoshop's
//     "move a guide with any tool" chord.
// Plus every guide's MARKER on the ruler it crosses (a small cyan
// triangle): always reachable, drag to move, right-click for the menu.
// Hovering anywhere a press would grab highlights the guide.
//
// Renders as a `position: fixed` sibling of the viewport panels inside the
// clip-path container — the same arrangement as every other on-canvas
// overlay — rather than as a child of the viewport div, so the viewport's
// touch pan/pinch handler (bound on that div) never captures a ruler drag,
// and the clip-path keeps the bars from painting over neighbouring panels.
// Stacking, within that container: guide lines at z 1 sit UNDER the editing
// overlays (z 2); the ruler bars at z 3 sit over them so a handle near the
// panel edge never steals a drag-out. The menu / edit popover portal to
// <body> so they aren't clipped at the panel edge (the side ruler IS the
// panel edge).

export const RULER_SIZE = 16;
// The vertical ruler's side. After Effects and Photoshop hang it on the
// left; this project's owner asked for the right edge. One constant flips it.
export const VERTICAL_RULER_SIDE: "left" | "right" = "right";

// Guide hit strip (px each side of the hairline).
const GUIDE_HIT = 3;
// px along a ruler within which a press lands on a guide's marker.
const MARKER_HIT = 6;
const TICK_MAJOR = 7;
const TICK_MINOR = 3.5;
const LABEL_FONT = "9px var(--ui-font)";
// Elements a ⌘-grab must not steal from.
const CONTROL_SELECTOR =
  "button, input, select, textarea, a, [role='menu'], [data-guide-menu], [data-spline-menu]";

interface Props {
  canvas: HTMLCanvasElement | null;
  // Project resolution — the rulers read out in these pixels.
  canvasRes: [number, number];
  guides: ViewportGuide[];
  onGuidesChange: (next: ViewportGuide[]) => void;
}

interface DragState {
  kind: "new" | "move";
  axis: "x" | "y";
  // Provisional position (canvas fraction) — committed on release.
  pos: number;
  // Which existing guide is being moved (kind "move").
  index?: number;
  client: { x: number; y: number };
}

type Bar = "top" | "side";

function cssVar(el: Element, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

const insideRect = (x: number, y: number, r: DOMRect) =>
  x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

function overTopRuler(y: number, host: DOMRect): boolean {
  return y <= host.top + RULER_SIZE;
}
function overSideRuler(x: number, host: DOMRect): boolean {
  return VERTICAL_RULER_SIDE === "right"
    ? x >= host.right - RULER_SIZE
    : x <= host.left + RULER_SIZE;
}
function overRuler(x: number, y: number, host: DOMRect): boolean {
  return overTopRuler(y, host) || overSideRuler(x, host);
}
// The ruler a guide of `axis` is pulled out of — and dropped back onto to
// delete it: a horizontal guide's is the top ruler, a vertical guide's the
// side ruler. The OTHER ruler carries the guide's marker, and dragging that
// marker along it is how you slide the guide, so a release there is a move.
function overParallelRuler(
  axis: "x" | "y",
  x: number,
  y: number,
  host: DOMRect
): boolean {
  return axis === "y" ? overTopRuler(y, host) : overSideRuler(x, host);
}

// Client-px position of a guide's line.
function guideClient(g: ViewportGuide, crect: DOMRect): number {
  return g.axis === "x"
    ? crect.left + g.pos * crect.width
    : crect.top + g.pos * crect.height;
}

// Index of the guide whose line passes within `tol` px of (x, y), else null.
function guideNear(
  guides: readonly ViewportGuide[],
  crect: DOMRect,
  x: number,
  y: number,
  tol: number
): number | null {
  let best: number | null = null;
  let bestD = tol;
  for (let k = 0; k < guides.length; k++) {
    const g = guides[k];
    const d = Math.abs((g.axis === "x" ? x : y) - guideClient(g, crect));
    if (d <= bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

// The guide whose ruler MARKER sits within MARKER_HIT of a press on `bar`.
// The top bar carries the markers of VERTICAL guides (they cross it), the
// side bar those of horizontal ones.
function markerNear(
  guides: readonly ViewportGuide[],
  crect: DOMRect,
  bar: Bar,
  x: number,
  y: number
): number | null {
  const axis = bar === "top" ? "x" : "y";
  let best: number | null = null;
  let bestD = MARKER_HIT;
  for (let k = 0; k < guides.length; k++) {
    const g = guides[k];
    if (g.axis !== axis) continue;
    const d = Math.abs((axis === "x" ? x : y) - guideClient(g, crect));
    if (d <= bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

// Would a PLAIN press at (x, y) reach a guide? Only when what's on top owns
// no click of its own — see the header.
function grabFriendlyAt(
  x: number,
  y: number,
  previewCanvas: HTMLCanvasElement | null
): boolean {
  const top = document.elementFromPoint(x, y);
  if (!top) return false;
  if (top === previewCanvas) return true;
  return !!top.closest("[data-guide-grab]");
}

function controlAt(x: number, y: number): boolean {
  const top = document.elementFromPoint(x, y);
  return !!top?.closest(CONTROL_SELECTOR);
}

export default function ViewportRulers({
  canvas,
  canvasRes,
  guides,
  onGuidesChange,
}: Props) {
  // The canvas box (transformed by pan/zoom) and its viewport panel — both
  // in client px, refreshed the way every overlay does it (ResizeObserver +
  // window resize, which the shell also fires on pan/zoom and layout
  // changes; rectsEqual keeps the observer from feeding back on itself).
  const [canvasRect, setCanvasRect] = useState<DOMRect | null>(null);
  const [hostRect, setHostRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    // No synchronous seeding call and no reset on an absent canvas — both
    // would be setState in an effect body. Observing fires the callback
    // once immediately, which supplies the initial rects; the render guard
    // covers the null-canvas case.
    if (!canvas) return;
    const host = canvas.parentElement;
    const update = () => {
      const c = canvas.getBoundingClientRect();
      setCanvasRect((prev) => (rectsEqual(prev, c) ? prev : c));
      if (host) {
        const h = host.getBoundingClientRect();
        setHostRect((prev) => (rectsEqual(prev, h) ? prev : h));
      }
    };
    const ro = new ResizeObserver(update);
    ro.observe(canvas);
    if (host) ro.observe(host);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [canvas]);

  const [drag, setDrag] = useState<DragState | null>(null);
  // The guide a press right now would grab (line highlight).
  const [grabHoverGuide, setGrabHoverGuide] = useState<number | null>(null);
  // Ruler marker under the pointer — flips the bar's cursor to the guide's
  // own drag direction and brightens the marker.
  const [hoverMarker, setHoverMarker] = useState<{
    bar: Bar;
    index: number;
  } | null>(null);
  // Right-click menu on a guide (`index`), or on a bare ruler (index null
  // — offers Clear all guides). The edit popover replaces the menu.
  const [menu, setMenu] = useState<{
    index: number | null;
    x: number;
    y: number;
  } | null>(null);
  const [edit, setEdit] = useState<{ index: number; x: number; y: number } | null>(
    null
  );

  // Live mirrors for the drag runner and the window-level listeners, which
  // are bound once. Synced in an effect (assigning during render trips
  // react-hooks/refs); pointer events can't land between commit and effects.
  const canvasRef = useRef(canvas);
  const canvasRectRef = useRef(canvasRect);
  const hostRectRef = useRef(hostRect);
  const canvasResRef = useRef(canvasRes);
  const guidesRef = useRef(guides);
  const onGuidesChangeRef = useRef(onGuidesChange);
  const popoverOpenRef = useRef(false);
  useEffect(() => {
    canvasRef.current = canvas;
    canvasRectRef.current = canvasRect;
    hostRectRef.current = hostRect;
    canvasResRef.current = canvasRes;
    guidesRef.current = guides;
    onGuidesChangeRef.current = onGuidesChange;
    popoverOpenRef.current = menu !== null || edit !== null;
  });

  // --- the drag runner ----------------------------------------------------

  // The one gesture in flight (window pointer listeners + body cursor
  // lock). `cancel` tears it down without committing — Escape uses it.
  const activeDragRef = useRef<{ pointerId: number; cancel: () => void } | null>(
    null
  );

  // Begin a guide gesture: from a ruler (kind "new", `index` undefined) or
  // on an existing guide (kind "move"). Position comes from the pointer's
  // canvas fraction, rounded to the project pixel grid; the release decides
  // between commit and delete. Window listeners, not pointer capture: the
  // press is intercepted at the window with no element to capture on, and
  // mouse moves reach the window regardless (touch presses are implicitly
  // captured by their target).
  const beginDrag = useCallback(
    (
      pointerId: number,
      axis: "x" | "y",
      index: number | undefined,
      start: { x: number; y: number }
    ): boolean => {
      const crect = canvasRectRef.current;
      const host = hostRectRef.current;
      if (!crect || !host) return false;
      if (activeDragRef.current) return false;
      const [W, H] = canvasResRef.current;
      const posAt = (x: number, y: number) =>
        axis === "x"
          ? guidePosFromClient(x, crect.left, crect.width, W)
          : guidePosFromClient(y, crect.top, crect.height, H);
      const kind: DragState["kind"] = index === undefined ? "new" : "move";
      // Keep the press out of the graph's cursor facts (the Pointer node
      // must not see a guide drag as a click on the canvas).
      claimPointerGesture(pointerId);
      const body = document.body;
      const prevCursor = body.style.cursor;
      const prevSelect = body.style.userSelect;
      body.style.cursor = axis === "x" ? "ew-resize" : "ns-resize";
      body.style.userSelect = "none";
      let done = false;
      const teardown = () => {
        if (done) return;
        done = true;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        body.style.cursor = prevCursor;
        body.style.userSelect = prevSelect;
        activeDragRef.current = null;
        setDrag(null);
      };
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        setDrag({
          kind,
          axis,
          index,
          pos: posAt(ev.clientX, ev.clientY),
          client: { x: ev.clientX, y: ev.clientY },
        });
      };
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        teardown();
        const cur = guidesRef.current;
        // Off the panel, or back on the ruler this guide came out of =
        // delete (never add). The perpendicular ruler — the one with the
        // guide's marker — is just another place to release a move.
        const dropped =
          !insideRect(ev.clientX, ev.clientY, host) ||
          overParallelRuler(axis, ev.clientX, ev.clientY, host);
        if (kind === "new") {
          // A press-and-release on the ruler (never left it) adds nothing.
          if (dropped) return;
          onGuidesChangeRef.current([
            ...cur,
            { axis, pos: posAt(ev.clientX, ev.clientY) },
          ]);
        } else if (index !== undefined) {
          if (dropped) {
            onGuidesChangeRef.current(cur.filter((_, k) => k !== index));
          } else {
            const pos = posAt(ev.clientX, ev.clientY);
            if (cur[index] && cur[index].pos === pos) return;
            onGuidesChangeRef.current(
              cur.map((g, k) => (k === index ? { ...g, pos } : g))
            );
          }
        }
      };
      const onCancel = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        teardown();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      activeDragRef.current = { pointerId, cancel: teardown };
      setGrabHoverGuide(null);
      setHoverMarker(null);
      setMenu(null);
      setEdit(null);
      if (kind === "move") {
        setDrag({
          kind,
          axis,
          index,
          pos: posAt(start.x, start.y),
          client: start,
        });
      }
      return true;
    },
    []
  );

  // Tear the runner down if the component unmounts mid-gesture (rulers
  // toggled off with Shift+R while dragging).
  useEffect(() => () => activeDragRef.current?.cancel(), []);

  // Escape mid-drag cancels: the guide goes back where it was (or is never
  // added) and the eventual release is nobody's business.
  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      e.preventDefault();
      activeDragRef.current?.cancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [drag]);

  // --- reaching a guide over the canvas -----------------------------------

  // Which guide a press at (x, y) reaches, per the header's rules, or null.
  const grabTargetAt = useCallback(
    (x: number, y: number, chord: boolean): number | null => {
      const crect = canvasRectRef.current;
      const host = hostRectRef.current;
      if (!crect || !host) return null;
      if (!insideRect(x, y, host) || overRuler(x, y, host)) return null;
      const hit = guideNear(guidesRef.current, crect, x, y, GUIDE_HIT + 1);
      if (hit === null) return null;
      if (chord ? controlAt(x, y) : !grabFriendlyAt(x, y, canvasRef.current))
        return null;
      return hit;
    },
    []
  );

  // ONE capture-phase window listener for presses on guides over the
  // canvas. Stopping propagation here is what keeps the overlay underneath
  // (and React's root handlers) from acting on the same press: a left press
  // starts the move, a right press is held for the contextmenu event that
  // follows it (TransformGizmo's move surface would otherwise start a
  // translate on ANY button).
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (activeDragRef.current || popoverOpenRef.current) return;
      if (e.button !== 0 && e.button !== 2) return;
      const hit = grabTargetAt(e.clientX, e.clientY, e.metaKey || e.ctrlKey);
      if (hit === null) return;
      if (e.button === 0) {
        const g = guidesRef.current[hit];
        if (!beginDrag(e.pointerId, g.axis, hit, { x: e.clientX, y: e.clientY }))
          return;
      }
      e.stopPropagation();
      e.preventDefault();
    };
    const onContext = (e: MouseEvent) => {
      if (activeDragRef.current) return;
      const hit = grabTargetAt(e.clientX, e.clientY, e.metaKey || e.ctrlKey);
      if (hit === null) return;
      e.stopPropagation();
      e.preventDefault();
      setMenu({ index: hit, x: e.clientX, y: e.clientY });
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("contextmenu", onContext, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("contextmenu", onContext, true);
    };
  }, [beginDrag, grabTargetAt]);

  // Press on a ruler: on a guide's marker → move that guide; anywhere else
  // → drag a new guide out (the top ruler gives a horizontal one, the side
  // ruler a vertical one).
  const onBarDown = useCallback(
    (e: React.PointerEvent<HTMLElement>, bar: Bar) => {
      if (e.button !== 0) return;
      const crect = canvasRectRef.current;
      if (!crect) return;
      const hit = markerNear(guidesRef.current, crect, bar, e.clientX, e.clientY);
      const at = { x: e.clientX, y: e.clientY };
      const started =
        hit !== null
          ? beginDrag(e.pointerId, bar === "top" ? "x" : "y", hit, at)
          : beginDrag(e.pointerId, bar === "top" ? "y" : "x", undefined, at);
      if (started) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    [beginDrag]
  );
  const onBarMove = useCallback((e: React.PointerEvent<HTMLElement>, bar: Bar) => {
    const crect = canvasRectRef.current;
    if (!crect || activeDragRef.current) return;
    const hit = markerNear(guidesRef.current, crect, bar, e.clientX, e.clientY);
    setHoverMarker((prev) => {
      if (hit === null) return prev === null ? prev : null;
      return prev && prev.bar === bar && prev.index === hit
        ? prev
        : { bar, index: hit };
    });
  }, []);
  const onBarLeave = useCallback(
    () => setHoverMarker((prev) => (prev === null ? prev : null)),
    []
  );
  // Right-click a marker → that guide's menu; a bare ruler → Clear all.
  const onBarContext = useCallback(
    (e: React.MouseEvent<HTMLElement>, bar: Bar) => {
      e.preventDefault();
      e.stopPropagation();
      const crect = canvasRectRef.current;
      if (!crect || activeDragRef.current) return;
      const hit = markerNear(guidesRef.current, crect, bar, e.clientX, e.clientY);
      if (hit === null && guidesRef.current.length === 0) return;
      setMenu({ index: hit, x: e.clientX, y: e.clientY });
    },
    []
  );

  // Menu / popover dismissal: a press anywhere outside, or Escape.
  useEffect(() => {
    if (!menu && !edit) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.("[data-guide-menu]")) return;
      setMenu(null);
      setEdit(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      setMenu(null);
      setEdit(null);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [menu, edit]);

  // --- ruler graduation ---------------------------------------------------

  const topBarRef = useRef<HTMLCanvasElement | null>(null);
  const sideBarRef = useRef<HTMLCanvasElement | null>(null);
  // Pointer position while over the panel — the rulers draw a marker at it.
  // Ref + rAF redraw, not state: a per-pointermove re-render buys nothing.
  const hoverRef = useRef<{ x: number; y: number } | null>(null);

  const [W, H] = canvasRes;

  const draw = useCallback(() => {
    const top = topBarRef.current;
    const side = sideBarRef.current;
    if (!top || !side || !hostRect || !canvasRect) return;
    const dpr = window.devicePixelRatio || 1;
    const bg = cssVar(top, "--tb-n-2", "#1a1a1a");
    const border = cssVar(top, "--tb-n-7", "#3a3a3a");
    const tick = cssVar(top, "--tb-n-11", "#8a8a8a");
    const label = cssVar(top, "--tb-n-13", "#b0b0b0");
    const span = cssVar(top, "--tb-n-4", "#242424");
    const accent = cssVar(top, "--tb-a-cyan-400", "#22d3ee");
    const hover = hoverRef.current;
    const sideRight = VERTICAL_RULER_SIDE === "right";

    const size = (c: HTMLCanvasElement, w: number, h: number) => {
      const pw = Math.max(1, Math.round(w * dpr));
      const ph = Math.max(1, Math.round(h * dpr));
      if (c.width !== pw) c.width = pw;
      if (c.height !== ph) c.height = ph;
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
      const ctx = c.getContext("2d");
      if (!ctx) return null;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return ctx;
    };

    // Tick positions along one axis in bar-local px. `origin` = where
    // project 0 falls, `ppu` = screen px per project px.
    const ticksAlong = (
      origin: number,
      ppu: number,
      length: number,
      emit: (at: number, unit: number, major: boolean) => void
    ) => {
      if (!(ppu > 0) || !Number.isFinite(ppu)) return;
      const { major, minor } = rulerTickPlan(ppu);
      const step = minor * ppu;
      const per = Math.max(1, Math.round(major / minor));
      const k0 = Math.floor((0 - origin) / step);
      const k1 = Math.ceil((length - origin) / step);
      // Hard cap so a pathological zoom can't spin the loop.
      if (k1 - k0 > 4000) return;
      for (let k = k0; k <= k1; k++) {
        const at = origin + k * step;
        emit(at, k * minor, ((k % per) + per) % per === 0);
      }
    };

    // Guide markers on `bar`: the guides that CROSS it, at their position
    // along it (the dragged one follows the pointer). Drawn as small
    // triangles pointing at the canvas; the hovered one brightens.
    const markersOn = (bar: Bar): Array<{ at: number; hot: boolean }> => {
      const axis = bar === "top" ? "x" : "y";
      const out: Array<{ at: number; hot: boolean }> = [];
      for (let k = 0; k < guides.length; k++) {
        const g = guides[k];
        if (g.axis !== axis) continue;
        const moving = drag?.kind === "move" && drag.index === k;
        const pos = moving ? drag.pos : g.pos;
        const at =
          axis === "x"
            ? canvasRect.left - hostRect.left + pos * canvasRect.width
            : canvasRect.top - hostRect.top + pos * canvasRect.height;
        const hot =
          moving ||
          (hoverMarker?.bar === bar && hoverMarker.index === k) ||
          menu?.index === k ||
          edit?.index === k;
        out.push({ at, hot });
      }
      return out;
    };

    // Top bar — full panel width; the corner square belongs to it.
    {
      const w = hostRect.width;
      const h = RULER_SIZE;
      const ctx = size(top, w, h);
      if (ctx) {
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, w, h);
        const origin = canvasRect.left - hostRect.left;
        const ppu = canvasRect.width / Math.max(1, W);
        // Faint band over the canvas's extent so the document reads on
        // the ruler even when it is panned mostly out of view.
        ctx.fillStyle = span;
        ctx.fillRect(origin, 0, canvasRect.width, h);
        ctx.strokeStyle = tick;
        ctx.lineWidth = 1;
        ctx.fillStyle = label;
        ctx.font = LABEL_FONT;
        ctx.textBaseline = "alphabetic";
        ctx.textAlign = "left";
        ctx.beginPath();
        const labels: Array<[number, number]> = [];
        ticksAlong(origin, ppu, w, (at, unit, major) => {
          const x = Math.round(at) + 0.5;
          const len = major ? TICK_MAJOR : TICK_MINOR;
          ctx.moveTo(x, h);
          ctx.lineTo(x, h - len);
          if (major) labels.push([at, unit]);
        });
        ctx.stroke();
        for (const [at, unit] of labels) {
          ctx.fillText(String(unit), Math.round(at) + 3, 9);
        }
        for (const m of markersOn("top")) {
          const x = Math.round(m.at) + 0.5;
          ctx.fillStyle = accent;
          ctx.globalAlpha = m.hot ? 1 : 0.8;
          ctx.beginPath();
          ctx.moveTo(x - 4.5, h - 7);
          ctx.lineTo(x + 4.5, h - 7);
          ctx.lineTo(x, h - 1);
          ctx.closePath();
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        if (hover) {
          const hx = Math.round(hover.x - hostRect.left) + 0.5;
          ctx.strokeStyle = accent;
          ctx.beginPath();
          ctx.moveTo(hx, 0);
          ctx.lineTo(hx, h);
          ctx.stroke();
        }
        // Corner square where the two rulers meet.
        const cornerX = sideRight ? w - RULER_SIZE : 0;
        ctx.fillStyle = bg;
        ctx.fillRect(cornerX, 0, RULER_SIZE, h);
        ctx.fillStyle = tick;
        ctx.font = "8px var(--ui-font)";
        ctx.textAlign = "center";
        ctx.fillText("px", cornerX + RULER_SIZE / 2, 11);
        // Bottom edge + the corner's inner edge.
        ctx.strokeStyle = border;
        ctx.beginPath();
        ctx.moveTo(0, h - 0.5);
        ctx.lineTo(w, h - 0.5);
        const cx = sideRight ? cornerX + 0.5 : RULER_SIZE - 0.5;
        ctx.moveTo(cx, 0);
        ctx.lineTo(cx, h);
        ctx.stroke();
      }
    }

    // Side bar — full panel height (the top bar paints the corner over it).
    {
      const w = RULER_SIZE;
      const h = hostRect.height;
      const ctx = size(side, w, h);
      if (ctx) {
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, w, h);
        const origin = canvasRect.top - hostRect.top;
        const ppu = canvasRect.height / Math.max(1, H);
        ctx.fillStyle = span;
        ctx.fillRect(0, origin, w, canvasRect.height);
        // Ticks grow from the edge that touches the canvas.
        const inner = sideRight ? 0 : w;
        const dir = sideRight ? 1 : -1;
        ctx.strokeStyle = tick;
        ctx.lineWidth = 1;
        ctx.beginPath();
        const labels: Array<[number, number]> = [];
        ticksAlong(origin, ppu, h, (at, unit, major) => {
          const y = Math.round(at) + 0.5;
          const len = major ? TICK_MAJOR : TICK_MINOR;
          ctx.moveTo(inner, y);
          ctx.lineTo(inner + dir * len, y);
          if (major) labels.push([at, unit]);
        });
        ctx.stroke();
        ctx.fillStyle = label;
        ctx.font = LABEL_FONT;
        ctx.textBaseline = "alphabetic";
        ctx.textAlign = "left";
        for (const [at, unit] of labels) {
          ctx.save();
          if (sideRight) {
            // Reads top-to-bottom, glyph bodies toward the outer edge.
            ctx.translate(w - 7.5, Math.round(at) + 3);
            ctx.rotate(Math.PI / 2);
          } else {
            // Reads bottom-to-top (After Effects' left ruler).
            ctx.translate(7.5, Math.round(at) - 3);
            ctx.rotate(-Math.PI / 2);
          }
          ctx.fillText(String(unit), 0, 0);
          ctx.restore();
        }
        for (const m of markersOn("side")) {
          const y = Math.round(m.at) + 0.5;
          ctx.fillStyle = accent;
          ctx.globalAlpha = m.hot ? 1 : 0.8;
          ctx.beginPath();
          // Points at the canvas: left for a right-hand ruler.
          const tipX = inner + dir * 1;
          const baseX = inner + dir * 7;
          ctx.moveTo(baseX, y - 4.5);
          ctx.lineTo(baseX, y + 4.5);
          ctx.lineTo(tipX, y);
          ctx.closePath();
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        if (hover) {
          const hy = Math.round(hover.y - hostRect.top) + 0.5;
          ctx.strokeStyle = accent;
          ctx.beginPath();
          ctx.moveTo(0, hy);
          ctx.lineTo(w, hy);
          ctx.stroke();
        }
        ctx.strokeStyle = border;
        ctx.beginPath();
        const ex = sideRight ? 0.5 : w - 0.5;
        ctx.moveTo(ex, 0);
        ctx.lineTo(ex, h);
        ctx.stroke();
      }
    }
  }, [hostRect, canvasRect, W, H, guides, drag, hoverMarker, menu, edit]);

  useEffect(() => {
    draw();
  }, [draw]);

  // Pointer tracking over the panel: the ruler position marker (rAF
  // redraw off a ref) and the grab highlight (state, changes rarely).
  const drawRef = useRef(draw);
  useEffect(() => {
    drawRef.current = draw;
  });
  useEffect(() => {
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        drawRef.current();
      });
    };
    const onMove = (e: PointerEvent) => {
      const host = hostRectRef.current;
      const inside = !!host && insideRect(e.clientX, e.clientY, host);
      const next = inside ? { x: e.clientX, y: e.clientY } : null;
      const prev = hoverRef.current;
      if (next || prev) {
        hoverRef.current = next;
        schedule();
      }
      // Which guide a press would grab right now.
      const hit =
        inside && !activeDragRef.current && !popoverOpenRef.current
          ? grabTargetAt(e.clientX, e.clientY, e.metaKey || e.ctrlKey)
          : null;
      setGrabHoverGuide((p) => (p === hit ? p : hit));
    };
    window.addEventListener("pointermove", onMove);
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [grabTargetAt]);

  // --- menu actions ---------------------------------------------------------

  const deleteGuide = (index: number) => {
    onGuidesChange(guides.filter((_, k) => k !== index));
    setMenu(null);
  };
  // A one-off copy reflected across the canvas centre on the same axis
  // (x → 1 − x). Nothing to add when the guide IS the centre line or the
  // mirror already exists.
  const mirrorGuide = (index: number) => {
    const g = guides[index];
    setMenu(null);
    if (!g) return;
    const pos = 1 - g.pos;
    const exists = guides.some(
      (o) => o.axis === g.axis && Math.abs(o.pos - pos) < 1e-9
    );
    if (exists) return;
    onGuidesChange([...guides, { axis: g.axis, pos }]);
  };
  const setGuidePx = (index: number, px: number) => {
    const g = guides[index];
    setEdit(null);
    if (!g || !Number.isFinite(px)) return;
    const res = g.axis === "x" ? W : H;
    if (!(res > 0)) return;
    const pos = px / res;
    if (pos === g.pos) return;
    onGuidesChange(guides.map((o, k) => (k === index ? { ...o, pos } : o)));
  };

  if (!canvasRect || !hostRect) return null;

  const sideRight = VERTICAL_RULER_SIDE === "right";
  const sideLeft = sideRight ? hostRect.right - RULER_SIZE : hostRect.left;

  // A provisional line while the pointer is somewhere a release would
  // COMMIT (over the panel, off the guide's own ruler); the moved guide's
  // resting line hides for the duration.
  const provisional =
    drag &&
    insideRect(drag.client.x, drag.client.y, hostRect) &&
    !overParallelRuler(drag.axis, drag.client.x, drag.client.y, hostRect)
      ? drag
      : null;

  const guideLine = (
    key: string,
    g: { axis: "x" | "y"; pos: number },
    opts: { active: boolean; interactive: boolean }
  ) => {
    const at = guideClient(g, canvasRect);
    const vertical = g.axis === "x";
    const color = "var(--tb-a-cyan-400)";
    return (
      <div
        key={key}
        // The strip itself is a grab-friendly surface: when nothing covers
        // it, the window listener sees it on top and takes the press.
        data-guide-grab={opts.interactive ? "true" : undefined}
        style={{
          position: "fixed",
          left: vertical ? at - GUIDE_HIT : hostRect.left,
          top: vertical ? hostRect.top : at - GUIDE_HIT,
          width: vertical ? GUIDE_HIT * 2 + 1 : hostRect.width,
          height: vertical ? hostRect.height : GUIDE_HIT * 2 + 1,
          pointerEvents: opts.interactive ? "auto" : "none",
          cursor: vertical ? "ew-resize" : "ns-resize",
          ...TOUCH_DRAG_STYLE,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: vertical ? GUIDE_HIT : 0,
            top: vertical ? 0 : GUIDE_HIT,
            width: vertical ? 1 : "100%",
            height: vertical ? "100%" : 1,
            background: color,
            opacity: opts.active ? 1 : 0.8,
            boxShadow: opts.active ? `0 0 0 0.5px ${color}` : undefined,
          }}
        />
      </div>
    );
  };

  const topCursor = hoverMarker?.bar === "top" ? "ew-resize" : "ns-resize";
  const sideCursor = hoverMarker?.bar === "side" ? "ns-resize" : "ew-resize";
  const menuGuide = menu && menu.index !== null ? guides[menu.index] : null;
  const editGuide = edit ? guides[edit.index] : null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: 1,
      }}
    >
      {/* Guides — under the editing overlays (z 2), see the header. */}
      {guides.map((g, k) =>
        drag?.kind === "move" && drag.index === k
          ? null
          : guideLine(`g-${k}`, g, {
              active:
                grabHoverGuide === k ||
                (hoverMarker?.index === k) ||
                menu?.index === k ||
                edit?.index === k,
              interactive: !drag,
            })
      )}

      {/* Ruler bars + the in-flight guide, over the editing overlays. */}
      <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 3 }}>
        {provisional &&
          guideLine("g-drag", provisional, { active: true, interactive: false })}
        <canvas
          ref={sideBarRef}
          title="Drag onto the canvas for a vertical guide · drag a marker to move that guide, right-click it for options · drop a guide here to remove it"
          style={{
            position: "fixed",
            left: sideLeft,
            top: hostRect.top,
            width: RULER_SIZE,
            height: hostRect.height,
            pointerEvents: "auto",
            cursor: sideCursor,
            ...TOUCH_DRAG_STYLE,
          }}
          onPointerDown={(e) => onBarDown(e, "side")}
          onPointerMove={(e) => onBarMove(e, "side")}
          onPointerLeave={onBarLeave}
          onContextMenu={(e) => onBarContext(e, "side")}
        />
        <canvas
          ref={topBarRef}
          title="Drag onto the canvas for a horizontal guide · drag a marker to move that guide, right-click it for options · drop a guide here to remove it"
          style={{
            position: "fixed",
            left: hostRect.left,
            top: hostRect.top,
            width: hostRect.width,
            height: RULER_SIZE,
            pointerEvents: "auto",
            cursor: topCursor,
            ...TOUCH_DRAG_STYLE,
          }}
          onPointerDown={(e) => onBarDown(e, "top")}
          onPointerMove={(e) => onBarMove(e, "top")}
          onPointerLeave={onBarLeave}
          onContextMenu={(e) => onBarContext(e, "top")}
        />
        {drag && (
          <div
            style={{
              position: "fixed",
              left: drag.client.x + 12,
              top: drag.client.y + 12,
              padding: "2px 6px",
              background: "color-mix(in srgb, var(--tb-n-0) 88%, transparent)",
              color: "var(--tb-n-16)",
              border: "1px solid var(--tb-a-cyan-400)",
              borderRadius: 3,
              fontFamily: "var(--ui-font)",
              fontSize: 10,
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
              pointerEvents: "none",
            }}
          >
            {provisional
              ? `${drag.axis === "x" ? "X" : "Y"} ${formatGuidePx(
                  drag.pos,
                  drag.axis === "x" ? W : H
                )} px`
              : drag.kind === "move"
                ? "Release to remove"
                : "Drag onto the canvas"}
          </div>
        )}
      </div>

      {/* Right-click menu — portalled to <body> so the panel's clip-path
          can't cut it off at the side ruler. */}
      {menu &&
        createPortal(
          <div data-guide-menu style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 1000 }}>
            <div style={{ pointerEvents: "auto", display: "contents" }}>
              <SplineContextMenu
                x={Math.min(menu.x, window.innerWidth - 190)}
                y={Math.min(menu.y, window.innerHeight - 110)}
                items={
                  menu.index !== null && menuGuide
                    ? [
                        {
                          label: `Edit position… (${menuGuide.axis === "x" ? "X" : "Y"} ${formatGuidePx(
                            menuGuide.pos,
                            menuGuide.axis === "x" ? W : H
                          )} px)`,
                          onClick: () => {
                            const idx = menu.index as number;
                            setMenu(null);
                            setEdit({ index: idx, x: menu.x, y: menu.y });
                          },
                        },
                        {
                          label: "Mirror across centre",
                          onClick: () => mirrorGuide(menu.index as number),
                        },
                        {
                          label: "Delete guide",
                          onClick: () => deleteGuide(menu.index as number),
                        },
                      ]
                    : [
                        {
                          label: `Clear all guides (${guides.length})`,
                          onClick: () => {
                            setMenu(null);
                            onGuidesChange([]);
                          },
                        },
                      ]
                }
              />
            </div>
          </div>,
          document.body
        )}

      {/* Exact-position popover (Edit position…). Enter commits, Esc / a
          click elsewhere cancels. Any finite number is accepted — guides may
          sit off-canvas. */}
      {edit &&
        editGuide &&
        createPortal(
          <GuideEditPopover
            key={`edit-${edit.index}`}
            x={Math.min(edit.x, window.innerWidth - 230)}
            y={Math.min(edit.y, window.innerHeight - 90)}
            axis={editGuide.axis}
            valuePx={editGuide.pos * (editGuide.axis === "x" ? W : H)}
            resPx={editGuide.axis === "x" ? W : H}
            onCommit={(px) => setGuidePx(edit.index, px)}
            onCancel={() => setEdit(null)}
          />,
          document.body
        )}
    </div>
  );
}

// The Edit position… popover: one numeric field in project pixels.
function GuideEditPopover({
  x,
  y,
  axis,
  valuePx,
  resPx,
  onCommit,
  onCancel,
}: {
  x: number;
  y: number;
  axis: "x" | "y";
  valuePx: number;
  resPx: number;
  onCommit: (px: number) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(() => {
    const r = Math.round(valuePx);
    return Math.abs(valuePx - r) < 1e-6 ? String(r) : valuePx.toFixed(2);
  });
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);
  const commit = () => {
    const v = Number(text.trim());
    if (!Number.isFinite(v)) {
      onCancel();
      return;
    }
    onCommit(v);
  };
  return (
    <div
      data-guide-menu
      style={{
        position: "fixed",
        left: x,
        top: y,
        zIndex: 1000,
        padding: 8,
        background: "color-mix(in srgb, var(--tb-n-0) 97%, transparent)",
        border: "1px solid var(--tb-n-9)",
        borderRadius: 5,
        boxShadow: "0 6px 18px rgba(0, 0, 0, 0.45)",
        fontFamily: "var(--ui-font)",
        fontSize: 11,
        color: "var(--tb-n-13)",
        display: "flex",
        alignItems: "center",
        gap: 6,
        pointerEvents: "auto",
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span style={{ color: "var(--tb-n-16)", fontWeight: 600 }}>
        {axis === "x" ? "X" : "Y"}
      </span>
      <input
        ref={inputRef}
        type="number"
        step="any"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
          // Keep the keystrokes out of the editor's shortcut handlers.
          e.stopPropagation();
        }}
        style={{
          width: 84,
          padding: "3px 6px",
          background: "var(--tb-n-1)",
          color: "var(--tb-n-16)",
          border: "1px solid var(--tb-n-7)",
          borderRadius: 3,
          fontFamily: "inherit",
          fontSize: 11,
          fontVariantNumeric: "tabular-nums",
          outline: "none",
        }}
      />
      <span style={{ whiteSpace: "nowrap" }}>px of {resPx}</span>
      <button
        type="button"
        onClick={commit}
        style={{
          padding: "3px 8px",
          background: "var(--tb-a-navy-deep)",
          color: "var(--tb-a-blue-200)",
          border: "1px solid var(--tb-a-navy-tint)",
          borderRadius: 3,
          cursor: "pointer",
          fontFamily: "inherit",
          fontSize: 11,
        }}
      >
        Set
      </button>
    </div>
  );
}
