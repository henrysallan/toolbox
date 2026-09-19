"use client";

// The Tracks editor's easing overlay (specdocs/091726_easing-editor.md):
// a unit-square curve editor pinned to the editor's upper-right corner.
// It shows ONE cubic-bezier easing — seeded from the first selected pair
// — and every handle drag fans the shape out to every selected pair via
// `onApply`. Anchors are locked at (0,0) / (1,1); clicking one reveals
// its handle. Handle x clamps to the segment, y is free (overshoot), and
// the view pans / zooms past the square with the node editor's gestures
// so an overshooting handle stays reachable. A preset shelf sits
// underneath — every built-in preset, then the project's saved easings
// and a "+" that saves the current curve (right-click a saved one to
// rename / delete) — and the bottom-left corner resizes the whole thing.
// All the pair / seed / view / layout math is in ./easing-editor.ts; this
// file is the DOM half.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BezierEasing, EasingPreset, SavedEasing } from "@/engine/keyframes";
import {
  EASING_PRESET_BEZIER,
  EASING_PRESET_LABELS,
  EASING_PRESET_ORDER,
  newSavedEasingId,
} from "@/engine/keyframes";
import { getEffectiveDevice, wheelWantsZoom } from "../input-device";
import { usePanelWindow } from "../layout/panel-window";
import { ownerWindow } from "../layout/panel-window-dom";
import { EasingTile } from "./EasingTile";
import {
  OVERLAY_HEADER_H,
  OVERLAY_READOUT_H,
  TRAY_DIVIDER,
  TRAY_GAP,
  TRAY_PAD_LEFT,
  TRAY_PAD_RIGHT,
  TRAY_PAD_Y,
  TRAY_TILE,
  autoEasingName,
  bezierPathD,
  clampEasingView,
  clampHandle,
  fitEasingView,
  fitOverlay,
  ghostPathD,
  panEasingView,
  pxToUnit,
  sameBezier,
  unitToPx,
  zoomEasingView,
  type EasingSeed,
  type EasingView,
  type ShelfMode,
} from "./easing-editor";
import { nextGestureKey } from "./keyframe-ops";
import { COLOR_BORDER, COLOR_MUTED, COLOR_TEXT } from "./theme";

// The square's edge in px. Resizable from the bottom-left corner; the
// chosen size is a per-machine view preference.
const SIZE_KEY = "easingEditor.size";
const DEFAULT_SIZE = 240;
const MIN_SIZE = 160;
const MAX_SIZE = 600;
// How much of the square the unit box uses at fit — the rest is canvas
// to pan around in and room for a modest overshoot without zooming.
const FIT_FRACTION = 0.24;
const MIN_SCALE = 24;
const MAX_SCALE = 6000;
const ZOOM_SENSITIVITY = 0.01;
const ANCHOR_R = 4.5;
const HANDLE_R = 4.5;
const HANDLE_HIT = 9;
const ANCHOR_HIT = 9;

// Every built-in preset the easing menus offer, minus customBezier (it
// needs hand-placed handles in the Graph Editor — nothing to apply here).
const BUILTIN_PRESETS: EasingPreset[] = EASING_PRESET_ORDER.filter(
  (p) => p !== "customBezier"
);

export interface EasingEditorOverlayProps {
  // The curve to show, or null when the selection holds no pair.
  seed: EasingSeed | null;
  pairCount: number;
  // The pairs don't all share one easing (the first drag makes them).
  mixed: boolean;
  // Why there is nothing to edit (shown in the empty state); falls back
  // to the generic "select two keyframes in a row" hint.
  emptyReason?: string | null;
  // Room below the overlay's top edge; the square shrinks so the whole
  // overlay (shelf included) fits.
  maxHeight?: number;
  onApply(bezier: BezierEasing, gestureKey: string): void;
  // A built-in shelf tile: write the named preset to every pair.
  onApplyPreset(preset: EasingPreset, gestureKey: string): void;
  onClose(): void;
  // The shelf's saved half — the project's saved easings (the same list
  // the Graph Editor's dropdown offers). Absent ⇒ no shelf at all.
  presets?: SavedEasing[];
  onSavePreset?(easing: SavedEasing): void;
  onRenamePreset?(id: string, name: string): void;
  onDeletePreset?(id: string): void;
}

type Anchor = "a" | "b";

type Drag =
  | { kind: "none" }
  | { kind: "handle"; anchor: Anchor; gestureKey: string }
  // Single-finger pan (touch / pen), captured on the SVG. The start view
  // is normalized (see below).
  | { kind: "touchPan"; startX: number; startY: number; startView: EasingView };

function readStoredSize(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SIZE_KEY);
    const n = raw == null ? NaN : Number(raw);
    if (!Number.isFinite(n)) return null;
    return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(n)));
  } catch {
    return null;
  }
}

function storeSize(size: number) {
  try {
    window.localStorage.setItem(SIZE_KEY, String(Math.round(size)));
  } catch {
    // Private mode / quota — the size just isn't remembered.
  }
}

// The view lives NORMALIZED to the square (a 1×1 canvas), and is scaled
// to px at render / hit-test time. A resize — the grip, or the dock
// getting shorter — then keeps the framing for free.
const scaleView = (v: EasingView, r: number): EasingView => ({
  scale: v.scale * r,
  ox: v.ox * r,
  oy: v.oy * r,
});

export function EasingEditorOverlay(props: EasingEditorOverlayProps) {
  const {
    seed,
    pairCount,
    mixed,
    emptyReason,
    maxHeight,
    onApply,
    onApplyPreset,
    onClose,
    presets,
    onSavePreset,
    onRenamePreset,
    onDeletePreset,
  } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  // The overlay only mounts after the dock button is clicked — never in a
  // server render — so the remembered size can seed the state directly.
  const [preferredSize, setPreferredSize] = useState(
    () => readStoredSize() ?? DEFAULT_SIZE
  );
  const tray = presets
    ? { builtins: BUILTIN_PRESETS.length, saved: presets.length }
    : null;
  const { size: S, shelf: shelfMode } = fitOverlay(
    preferredSize,
    maxHeight,
    tray,
    MIN_SIZE
  );
  const [nview, setNView] = useState<EasingView>(() =>
    fitEasingView(1, FIT_FRACTION)
  );
  const view = scaleView(nview, S);
  const commitView = (px: EasingView) => setNView(scaleView(px, 1 / S));
  const fit = () => setNView(fitEasingView(1, FIT_FRACTION));
  // Which anchors show their handle. Spec: click an anchor to reveal.
  const [shown, setShown] = useState<Set<Anchor>>(() => new Set());
  const [drag, setDrag] = useState<Drag>({ kind: "none" });
  // The shape under the pointer mid-drag. The parent writes every move
  // through and re-renders with the same numbers; this keeps the handle
  // glued to the cursor even if that round trip lags a frame.
  const [dragShape, setDragShape] = useState<BezierEasing | null>(null);
  const [hover, setHover] = useState<Anchor | "h-a" | "h-b" | null>(null);
  const [middleDrag, setMiddleDrag] = useState<"pan" | "zoom" | null>(null);

  const shape = dragShape ?? seed?.bezier ?? null;

  // Latest values for the window-level listeners (Escape, middle-drag
  // pan, wheel), which are bound once. Written after commit.
  const latest = useRef({ shape, onApply, drag, nview, S });
  useEffect(() => {
    latest.current = { shape, onApply, drag, nview, S };
  });

  // ----- Wheel — the node editor's rule (input-device.ts): a trackpad's
  // two-finger scroll pans and pinch / ⌘-scroll zooms; a mouse wheel
  // zooms. Native + non-passive so preventDefault works, and
  // stopPropagation so the Tracks editor's own container-level wheel
  // handler (which would pan the timeline) never sees it — gestures act
  // on whatever the pointer is over.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const dx = e.deltaX || 0;
      const dy = e.deltaY || 0;
      const sz = latest.current.S;
      const px = scaleView(latest.current.nview, sz);
      let next: EasingView;
      if (wheelWantsZoom(e)) {
        const mag =
          getEffectiveDevice() === "mouse" || Math.abs(dy) >= Math.abs(dx)
            ? dy
            : dx;
        next = zoomEasingView(
          px,
          Math.exp(-mag * ZOOM_SENSITIVITY),
          mx,
          my,
          MIN_SCALE,
          MAX_SCALE
        );
      } else {
        next = panEasingView(px, -dx, -dy);
      }
      setNView(scaleView(clampEasingView(next, sz), 1 / sz));
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  // ----- Middle-button drag pans (the node editor's panOnDrag [1]);
  // Ctrl / ⌘ + middle-drag zooms about the press point, drag up to zoom
  // in — the same chord the Tracks editor uses on its time axis. Native,
  // on the overlay root: it runs before the Tracks editor's
  // container-level middle-button listener (an ancestor) and its
  // stopPropagation keeps the timeline still.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      const sz = latest.current.S;
      const startPx = scaleView(latest.current.nview, sz);
      const startX = e.clientX;
      const startY = e.clientY;
      const zooming = e.metaKey || e.ctrlKey;
      // Zoom anchor: the press point in the square's own px (a press on
      // the header or shelf still zooms about where it landed).
      const svgRect = svgRef.current?.getBoundingClientRect();
      const ax = svgRect ? startX - svgRect.left : sz / 2;
      const ay = svgRect ? startY - svgRect.top : sz / 2;
      const win = ownerWindow(el);
      setMiddleDrag(zooming ? "zoom" : "pan");
      const onMove = (ev: PointerEvent) => {
        const next = zooming
          ? zoomEasingView(
              startPx,
              Math.exp(-(ev.clientY - startY) * ZOOM_SENSITIVITY),
              ax,
              ay,
              MIN_SCALE,
              MAX_SCALE
            )
          : panEasingView(startPx, ev.clientX - startX, ev.clientY - startY);
        setNView(scaleView(clampEasingView(next, sz), 1 / sz));
      };
      const onUp = () => {
        setMiddleDrag(null);
        win.removeEventListener("pointermove", onMove);
        win.removeEventListener("pointerup", onUp);
        win.removeEventListener("pointercancel", onUp);
      };
      win.addEventListener("pointermove", onMove);
      win.addEventListener("pointerup", onUp);
      win.addEventListener("pointercancel", onUp);
    };
    el.addEventListener("pointerdown", onDown);
    return () => el.removeEventListener("pointerdown", onDown);
  }, []);

  // ----- Left button / touch on the SVG: a shown handle → shape drag
  // (one undo entry per drag); an anchor → toggle its handle; empty
  // space → hide the handles (a finger or pen pans instead — the node
  // editor's single-touch pan).
  const localPoint = (e: { clientX: number; clientY: number }) => {
    const rect = svgRef.current?.getBoundingClientRect();
    return rect
      ? { x: e.clientX - rect.left, y: e.clientY - rect.top }
      : { x: 0, y: 0 };
  };
  const hitHandle = (px: number, py: number): Anchor | null => {
    if (!shape) return null;
    const order: Anchor[] = ["a", "b"];
    for (const a of order) {
      if (!shown.has(a)) continue;
      const p =
        a === "a"
          ? unitToPx(view, shape.x1, shape.y1)
          : unitToPx(view, shape.x2, shape.y2);
      if (Math.hypot(p.x - px, p.y - py) <= HANDLE_HIT) return a;
    }
    return null;
  };
  const hitAnchor = (px: number, py: number): Anchor | null => {
    const a = unitToPx(view, 0, 0);
    if (Math.hypot(a.x - px, a.y - py) <= ANCHOR_HIT) return "a";
    const b = unitToPx(view, 1, 1);
    if (Math.hypot(b.x - px, b.y - py) <= ANCHOR_HIT) return "b";
    return null;
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const { x, y } = localPoint(e);
    const h = shape ? hitHandle(x, y) : null;
    if (h && shape) {
      svgRef.current?.setPointerCapture(e.pointerId);
      setDragShape(shape);
      setDrag({
        kind: "handle",
        anchor: h,
        gestureKey: nextGestureKey("easing-editor"),
      });
      return;
    }
    const anchor = hitAnchor(x, y);
    if (anchor) {
      setShown((prev) => {
        const next = new Set(e.shiftKey ? prev : []);
        if (prev.has(anchor) && (e.shiftKey || prev.size === 1)) {
          next.delete(anchor);
        } else {
          next.add(anchor);
        }
        return next;
      });
      return;
    }
    if (e.pointerType === "touch" || e.pointerType === "pen") {
      svgRef.current?.setPointerCapture(e.pointerId);
      setDrag({ kind: "touchPan", startX: x, startY: y, startView: nview });
      return;
    }
    // Bare click on empty space hides the handles.
    setShown(new Set());
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const { x, y } = localPoint(e);
    if (drag.kind === "handle") {
      const cur = shape;
      if (!cur) return;
      const u = pxToUnit(view, x, y);
      const c = clampHandle(u.x, u.y);
      const next: BezierEasing =
        drag.anchor === "a"
          ? { ...cur, x1: c.x, y1: c.y }
          : { ...cur, x2: c.x, y2: c.y };
      setDragShape(next);
      onApply(next, drag.gestureKey);
      return;
    }
    if (drag.kind === "touchPan") {
      const startPx = scaleView(drag.startView, S);
      commitView(
        clampEasingView(
          panEasingView(startPx, x - drag.startX, y - drag.startY),
          S
        )
      );
      return;
    }
    // Hover feedback when idle.
    const h = shape ? hitHandle(x, y) : null;
    if (h) {
      setHover(h === "a" ? "h-a" : "h-b");
      return;
    }
    setHover(hitAnchor(x, y));
  };

  const endDrag = (e: React.PointerEvent<SVGSVGElement>) => {
    if (drag.kind === "none") return;
    try {
      svgRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      // Capture may already be gone (pointercancel) — nothing to release.
    }
    setDrag({ kind: "none" });
    setDragShape(null);
  };

  // Escape while dragging a handle: put the shape back (the parent's
  // history already coalesced the gesture into one entry, so a single
  // undo also does it — but Esc is the reflex).
  useEffect(() => {
    if (drag.kind !== "handle") return;
    const startShape = seed?.bezier;
    const win = ownerWindow(svgRef.current);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const d = latest.current.drag;
      if (d.kind === "handle" && startShape) {
        latest.current.onApply(startShape, d.gestureKey);
      }
      setDrag({ kind: "none" });
      setDragShape(null);
    };
    win.addEventListener("keydown", onKey);
    return () => win.removeEventListener("keydown", onKey);
    // Only re-arm when a drag starts; `seed` at that moment is the
    // pre-drag shape (the parent hasn't written anything yet).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag.kind]);

  // ----- Resize from the bottom-left corner (the overlay is pinned to
  // the upper right, so that's the free corner). Square stays square;
  // the normalized view keeps the framing.
  const onResizeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const startSize = S;
    let last = startSize;
    const onMove = (ev: PointerEvent) => {
      const grow = Math.max(startX - ev.clientX, ev.clientY - startY);
      last = Math.min(
        MAX_SIZE,
        Math.max(MIN_SIZE, Math.round(startSize + grow))
      );
      setPreferredSize(last);
    };
    const onUp = () => {
      storeSize(last);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };

  // ----- Geometry for the render.
  const o = unitToPx(view, 0, 0);
  const t = unitToPx(view, 1, 1);
  const boxX = Math.min(o.x, t.x);
  const boxY = Math.min(o.y, t.y);
  const boxW = Math.abs(t.x - o.x);
  const boxH = Math.abs(t.y - o.y);
  const h1 = shape ? unitToPx(view, shape.x1, shape.y1) : null;
  const h2 = shape ? unitToPx(view, shape.x2, shape.y2) : null;
  const ghost =
    seed && seed.source === "ghost" && seed.ghost && !dragShape
      ? ghostPathD(seed.ghost, view)
      : null;

  const status = (() => {
    if (!seed) return null;
    const segs = `${pairCount} segment${pairCount === 1 ? "" : "s"}`;
    if (mixed) return `${segs} · mixed`;
    if (seed.preset) return `${segs} · ${EASING_PRESET_LABELS[seed.preset]}`;
    return segs;
  })();

  const cursor =
    middleDrag === "zoom"
      ? "ns-resize"
      : middleDrag === "pan" || drag.kind === "touchPan"
        ? "grabbing"
        : drag.kind === "handle"
          ? "grabbing"
          : hover === "h-a" || hover === "h-b"
            ? "grab"
            : hover
              ? "pointer"
              : "default";

  const fmt = (n: number) => (Math.abs(n) < 5e-3 ? "0.00" : n.toFixed(2));

  return (
    <div
      ref={rootRef}
      data-easing-editor="true"
      // Nothing that starts here may start a lane gesture underneath.
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      style={{
        position: "relative",
        width: S,
        maxHeight,
        display: "flex",
        flexDirection: "column",
        background: "color-mix(in srgb, var(--tb-n-1) 92%, transparent)",
        border: `1px solid ${COLOR_BORDER}`,
        borderRadius: 6,
        boxShadow: "0 6px 18px rgba(0,0,0,0.45)",
        color: COLOR_TEXT,
        font: "10px/1.2 var(--ui-font)",
        userSelect: "none",
        overflow: "hidden",
        backdropFilter: "blur(6px)",
        cursor:
          middleDrag === "zoom"
            ? "ns-resize"
            : middleDrag === "pan"
              ? "grabbing"
              : undefined,
      }}
    >
      {/* Header: title · status · fit · close */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          height: OVERLAY_HEADER_H,
          flex: "0 0 auto",
          padding: "0 4px 0 8px",
          borderBottom: `1px solid ${COLOR_BORDER}`,
        }}
      >
        <span style={{ fontWeight: 600, letterSpacing: 0.2 }}>Easing</span>
        <span
          style={{
            color: COLOR_MUTED,
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {status}
        </span>
        <OverlayButton title="Fit the 0–1 square" onClick={fit}>
          ⌂
        </OverlayButton>
        <OverlayButton title="Close the easing editor" onClick={onClose}>
          ✕
        </OverlayButton>
      </div>

      {/* The square */}
      <svg
        ref={svgRef}
        width={S}
        height={S}
        viewBox={`0 0 ${S} ${S}`}
        style={{ display: "block", flex: "0 0 auto", cursor, touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => {
          if (drag.kind === "none") setHover(null);
        }}
        onDoubleClick={fit}
      >
        {/* Unit square + linear reference */}
        <rect
          x={boxX}
          y={boxY}
          width={boxW}
          height={boxH}
          fill="var(--tb-n-2)"
          stroke="var(--tb-n-6)"
        />
        {[0.25, 0.5, 0.75].map((g) => (
          <g key={g} stroke="var(--tb-n-4)" strokeWidth={1}>
            <line
              x1={boxX + g * boxW}
              y1={boxY}
              x2={boxX + g * boxW}
              y2={boxY + boxH}
            />
            <line
              x1={boxX}
              y1={boxY + g * boxH}
              x2={boxX + boxW}
              y2={boxY + g * boxH}
            />
          </g>
        ))}
        <line
          x1={o.x}
          y1={o.y}
          x2={t.x}
          y2={t.y}
          stroke="var(--tb-n-6)"
          strokeDasharray="3 3"
        />
        <text
          x={o.x - 4}
          y={o.y + 4}
          textAnchor="end"
          fontSize={9}
          fill={COLOR_MUTED}
        >
          0
        </text>
        <text
          x={t.x + 4}
          y={t.y + 3}
          textAnchor="start"
          fontSize={9}
          fill={COLOR_MUTED}
        >
          1
        </text>

        {seed && shape ? (
          <>
            {/* Ghost: the real curve of a preset no cubic expresses */}
            {ghost && (
              <path
                d={ghost}
                fill="none"
                stroke={COLOR_MUTED}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                opacity={0.8}
              />
            )}
            {/* The curve */}
            <path
              d={bezierPathD(shape, view)}
              fill="none"
              stroke="var(--tb-a-blue-500)"
              strokeWidth={ghost ? 1.25 : 1.75}
              strokeLinecap="round"
              opacity={ghost ? 0.6 : 1}
            />
            {/* Handle arms + knobs, per revealed anchor */}
            {shown.has("a") && h1 && (
              <g>
                <line x1={o.x} y1={o.y} x2={h1.x} y2={h1.y} stroke={COLOR_MUTED} />
                <circle
                  cx={h1.x}
                  cy={h1.y}
                  r={HANDLE_R}
                  fill={hover === "h-a" || (drag.kind === "handle" && drag.anchor === "a") ? "var(--tb-a-amber-400)" : "var(--tb-a-blue-400)"}
                  stroke="var(--tb-n-0)"
                  strokeWidth={1.5}
                />
              </g>
            )}
            {shown.has("b") && h2 && (
              <g>
                <line x1={t.x} y1={t.y} x2={h2.x} y2={h2.y} stroke={COLOR_MUTED} />
                <circle
                  cx={h2.x}
                  cy={h2.y}
                  r={HANDLE_R}
                  fill={hover === "h-b" || (drag.kind === "handle" && drag.anchor === "b") ? "var(--tb-a-amber-400)" : "var(--tb-a-blue-400)"}
                  stroke="var(--tb-n-0)"
                  strokeWidth={1.5}
                />
              </g>
            )}
            {/* Locked anchors */}
            <circle
              cx={o.x}
              cy={o.y}
              r={ANCHOR_R}
              fill={shown.has("a") ? "var(--tb-a-amber-400)" : hover === "a" ? "var(--tb-n-14)" : "var(--tb-n-11)"}
              stroke="var(--tb-n-0)"
              strokeWidth={1.5}
            />
            <circle
              cx={t.x}
              cy={t.y}
              r={ANCHOR_R}
              fill={shown.has("b") ? "var(--tb-a-amber-400)" : hover === "b" ? "var(--tb-n-14)" : "var(--tb-n-11)"}
              stroke="var(--tb-n-0)"
              strokeWidth={1.5}
            />
            {shown.size === 0 && drag.kind === "none" && (
              <text
                x={S / 2}
                y={S - 8}
                textAnchor="middle"
                fontSize={9}
                fill={COLOR_MUTED}
              >
                click an anchor for its handle
              </text>
            )}
          </>
        ) : (
          <foreignObject x={0} y={0} width={S} height={S}>
            <div
              style={{
                width: S,
                height: S,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                textAlign: "center",
                padding: "0 28px",
                boxSizing: "border-box",
                color: COLOR_MUTED,
                font: "10px/1.5 var(--ui-font)",
              }}
            >
              {emptyReason ??
                "Select two or more keyframes in a row to shape their easing"}
            </div>
          </foreignObject>
        )}
      </svg>

      {/* Readout */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          height: OVERLAY_READOUT_H,
          flex: "0 0 auto",
          borderTop: `1px solid ${COLOR_BORDER}`,
          color: COLOR_MUTED,
          fontFamily: "var(--mono-font, ui-monospace, monospace)",
          fontSize: 9.5,
          letterSpacing: 0.2,
        }}
      >
        {shape ? (
          <>
            <span style={{ color: shown.has("a") ? COLOR_TEXT : undefined }}>
              {fmt(shape.x1)}, {fmt(shape.y1)}
            </span>
            <span>·</span>
            <span style={{ color: shown.has("b") ? COLOR_TEXT : undefined }}>
              {fmt(shape.x2)}, {fmt(shape.y2)}
            </span>
          </>
        ) : (
          <span>—</span>
        )}
      </div>

      {/* Preset shelf */}
      {presets && (
        <PresetShelf
          mode={shelfMode}
          saved={presets}
          current={shape}
          // Only a user-shaped curve should light a built-in tile by shape
          // match — a ghost's parked linear handles are not "linear".
          matchByShape={
            !!seed && (seed.source === "bezier" || seed.source === "custom")
          }
          activePreset={seed?.preset ?? null}
          canApply={!!seed}
          onPickBuiltin={(p) => onApplyPreset(p, nextGestureKey("easing-preset"))}
          onPickSaved={(p) => onApply(p, nextGestureKey("easing-preset"))}
          onSave={
            onSavePreset && shape
              ? () =>
                  onSavePreset({
                    id: newSavedEasingId(),
                    name: autoEasingName(presets),
                    x1: shape.x1,
                    y1: shape.y1,
                    x2: shape.x2,
                    y2: shape.y2,
                  })
              : undefined
          }
          onRename={onRenamePreset}
          onDelete={onDeletePreset}
        />
      )}

      {/* Invisible resize grip — bottom-left corner */}
      <div
        title="Drag to resize"
        onPointerDown={onResizeDown}
        style={{
          position: "absolute",
          left: 0,
          bottom: 0,
          width: 16,
          height: 16,
          cursor: "nesw-resize",
          touchAction: "none",
          zIndex: 1,
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------
// Preset shelf
// ---------------------------------------------------------------------

interface PresetShelfProps {
  // "grid" wraps the tiles into rows; "row" is one horizontally scrolling
  // strip for short docks (fitOverlay decides).
  mode: ShelfMode;
  saved: SavedEasing[];
  current: BezierEasing | null;
  matchByShape: boolean;
  activePreset: EasingPreset | null;
  canApply: boolean;
  onPickBuiltin(p: EasingPreset): void;
  onPickSaved(p: SavedEasing): void;
  // Absent ⇒ nothing to save right now (no curve) — the "+" dims.
  onSave?(): void;
  onRename?(id: string, name: string): void;
  onDelete?(id: string): void;
}

function PresetShelf(props: PresetShelfProps) {
  const {
    mode,
    saved,
    current,
    matchByShape,
    activePreset,
    canApply,
    onPickBuiltin,
    onPickSaved,
    onSave,
    onRename,
    onDelete,
  } = props;
  const shelfRef = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(
    null
  );
  const alreadySaved = !!current && saved.some((p) => sameBezier(p, current));
  const builtinActive = (p: EasingPreset) => {
    if (activePreset === p) return true;
    if (!matchByShape || !current) return false;
    const eq = EASING_PRESET_BEZIER[p];
    return !!eq && sameBezier(current, eq);
  };

  // The shelf scrolls itself — sideways as a row, down as an overflowing
  // grid. Native, so it can stop the Tracks editor's container-level
  // wheel handler (which preventDefaults everything and would pan the
  // lane list) from swallowing the gesture.
  useEffect(() => {
    const el = shelfRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const dx = e.deltaX || 0;
      const dy = e.deltaY || 0;
      if (mode === "row") {
        el.scrollLeft += Math.abs(dx) > Math.abs(dy) ? dx : dy;
      } else {
        el.scrollTop += dy;
      }
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [mode]);

  const row = mode === "row";
  const tiles: React.CSSProperties = {
    display: "flex",
    flexWrap: row ? "nowrap" : "wrap",
    gap: TRAY_GAP,
    flex: "0 0 auto",
  };
  return (
    <div
      ref={shelfRef}
      style={{
        flex: "0 1 auto",
        minHeight: 0,
        display: row ? "flex" : "block",
        alignItems: row ? "center" : undefined,
        // Row: one strip, scrolled sideways. Grid: last resort when even
        // the smallest square can't fit — scroll rather than clip.
        overflowX: row ? "auto" : "hidden",
        overflowY: row ? "hidden" : "auto",
        scrollbarWidth: "none",
        padding: `${TRAY_PAD_Y}px ${TRAY_PAD_RIGHT}px ${TRAY_PAD_Y}px ${TRAY_PAD_LEFT}px`,
        borderTop: `1px solid ${COLOR_BORDER}`,
        boxSizing: "border-box",
      }}
    >
      {/* Built-ins — the same tiles as the easing menus */}
      <div style={tiles}>
        {BUILTIN_PRESETS.map((p) => (
          <EasingTile
            key={p}
            preset={p}
            size={TRAY_TILE}
            disabled={!canApply}
            label={`${EASING_PRESET_LABELS[p]} — apply to the selected pairs`}
            active={builtinActive(p)}
            onClick={() => onPickBuiltin(p)}
          />
        ))}
      </div>
      <div
        style={
          row
            ? {
                width: 1,
                alignSelf: "stretch",
                flex: "0 0 auto",
                background: COLOR_BORDER,
                margin: `0 ${(TRAY_DIVIDER - 1) / 2}px`,
              }
            : {
                height: 1,
                background: COLOR_BORDER,
                margin: `${(TRAY_DIVIDER - 1) / 2}px 0`,
              }
        }
      />
      {/* Saved — the project's own, plus "+" */}
      <div style={tiles}>
        {saved.map((p) => (
          <EasingTile
            key={p.id}
            preset="cubicBezier"
            bezier={p}
            size={TRAY_TILE}
            disabled={!canApply}
            label={`${p.name} — click to apply, right-click to rename`}
            active={!!current && sameBezier(p, current)}
            onClick={() => onPickSaved(p)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMenu({ id: p.id, x: e.clientX, y: e.clientY });
            }}
          />
        ))}
        <PlusTile
          disabled={!onSave || alreadySaved}
          title={
            !onSave
              ? "Select keyframes to have a curve to save"
              : alreadySaved
                ? "This curve is already a preset"
                : "Save the current curve as a preset (this project)"
          }
          onClick={() => onSave?.()}
        />
      </div>
      {menu && (
        <PresetMenu
          preset={saved.find((p) => p.id === menu.id) ?? null}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onRename={onRename}
          onDelete={onDelete}
        />
      )}
    </div>
  );
}

function PlusTile(props: { disabled: boolean; title: string; onClick(): void }) {
  const [hover, setHover] = useState(false);
  const { disabled, title, onClick } = props;
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onClick();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: TRAY_TILE,
        height: TRAY_TILE,
        padding: 0,
        background: hover && !disabled ? "var(--tb-n-7)" : "transparent",
        border: `1px dashed ${hover && !disabled ? "var(--tb-n-10)" : COLOR_BORDER}`,
        borderRadius: 4,
        color: disabled ? COLOR_MUTED : COLOR_TEXT,
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? "default" : "pointer",
        fontSize: 14,
        lineHeight: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        outline: "none",
      }}
    >
      +
    </button>
  );
}

// Right-click menu on a saved preset: a name field (Enter / clicking away
// commits) and Delete. Portaled to this editor's own window (a popped-out
// timeline must not drop it into the main window).
function PresetMenu(props: {
  preset: SavedEasing | null;
  x: number;
  y: number;
  onClose(): void;
  onRename?(id: string, name: string): void;
  onDelete?(id: string): void;
}) {
  const { preset, x, y, onClose, onRename, onDelete } = props;
  const panelWin = usePanelWindow();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [name, setName] = useState(preset?.name ?? "");
  useEffect(() => {
    const win = ownerWindow(rootRef.current);
    const onDown = (e: MouseEvent) => {
      if (rootRef.current?.contains(e.target as globalThis.Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    win.addEventListener("mousedown", onDown);
    win.addEventListener("keydown", onKey);
    return () => {
      win.removeEventListener("mousedown", onDown);
      win.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  if (!preset) return null;
  const commit = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== preset.name) onRename?.(preset.id, trimmed);
    onClose();
  };
  return createPortal(
    <div
      ref={rootRef}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: "fixed",
        left: x,
        top: y,
        zIndex: 1000,
        background: "var(--tb-n-4)",
        color: COLOR_TEXT,
        border: `1px solid ${COLOR_BORDER}`,
        borderRadius: 4,
        boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
        padding: 8,
        width: 180,
        font: "11px/1.2 var(--ui-font)",
      }}
    >
      <div
        style={{
          color: COLOR_MUTED,
          fontSize: 9,
          textTransform: "uppercase",
          letterSpacing: 1,
          marginBottom: 6,
        }}
      >
        Preset name
      </div>
      <input
        autoFocus
        type="text"
        value={name}
        spellCheck={false}
        disabled={!onRename}
        onChange={(e) => setName(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          // Keep the Tracks editor's shortcuts (Delete, G/S/R…) out of
          // the field.
          e.stopPropagation();
        }}
        onBlur={commit}
        style={{
          width: "100%",
          background: "var(--tb-n-1)",
          border: `1px solid ${COLOR_BORDER}`,
          color: COLOR_TEXT,
          fontFamily: "var(--ui-font)",
          fontSize: 11,
          padding: "3px 6px",
          borderRadius: 3,
          boxSizing: "border-box",
          outline: "none",
        }}
      />
      {onDelete && (
        <div
          onClick={() => {
            onDelete(preset.id);
            onClose();
          }}
          onMouseEnter={(e) =>
            ((e.currentTarget as HTMLDivElement).style.background = "var(--tb-n-7)")
          }
          onMouseLeave={(e) =>
            ((e.currentTarget as HTMLDivElement).style.background = "transparent")
          }
          style={{
            marginTop: 8,
            padding: "5px 6px",
            borderRadius: 3,
            cursor: "pointer",
            color: "var(--tb-a-red-300, #f28b82)",
          }}
        >
          Delete preset
        </div>
      )}
    </div>,
    (panelWin ?? window).document.body
  );
}

function OverlayButton(props: {
  title: string;
  onClick(): void;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      title={props.title}
      onClick={props.onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 18,
        height: 18,
        padding: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: hover ? "var(--tb-n-5)" : "transparent",
        border: `1px solid ${hover ? "var(--tb-n-8)" : "transparent"}`,
        borderRadius: 3,
        color: hover ? COLOR_TEXT : COLOR_MUTED,
        fontSize: 10,
        lineHeight: 1,
        cursor: "pointer",
        outline: "none",
      }}
    >
      {props.children}
    </button>
  );
}
