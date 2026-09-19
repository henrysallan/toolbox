"use client";

// Canvas viewport pan / zoom — the state hook and the gesture bindings the
// editor's preview viewports use (EffectsApp v1 / v2 / WatchViewport), moved
// here on 2026-09-18 so the live link can offer the SAME gestures
// (091826_live-pan-zoom.md): trackpad scroll pans, pinch / ⌘-scroll zooms,
// a mouse wheel zooms (input-device.ts decides), middle-drag pans (⌘/Ctrl +
// middle-drag zooms), one finger / pen pans, two fingers pinch. Verbatim
// from EffectsApp apart from the `enabled` flag.
//
// Lives in lib/ because lib/live-viewer/ is bundled into the exported app;
// the two editor-tree imports are React-free leaves the template aliases
// (input-device, layout/panel-window-dom).

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { wheelWantsZoom } from "@/components/effects/input-device";
import { ownerWindow } from "@/components/effects/layout/panel-window-dom";

// Pan/zoom state for one preview viewport. Owns its own ref + state so
// each viewport can frame its preview independently when split.
export function useViewportPanZoom() {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<[number, number]>([0, 0]);
  const reset = useCallback(() => {
    setZoom(1);
    setPan([0, 0]);
  }, []);
  const isDefault = zoom === 1 && pan[0] === 0 && pan[1] === 0;
  return { viewportRef, zoom, pan, setZoom, setPan, reset, isDefault };
}

// Two-finger trackpad / mouse-wheel pan and Cmd-zoom on the given
// viewport, plus middle-click drag to pan. Listens at the window level
// and hit-tests the cursor against the viewport's rect, so the gesture
// applies to whichever viewport the cursor is over — even when a
// sibling overlay (paint, spline, gizmo, curve dock, etc.) sits visually
// between the cursor and the viewport's DOM subtree. Overlays that want
// to consume wheel themselves (the curve editor dock) call
// stopPropagation, which prevents the bubble path from reaching window.
//
// "The window level" means the window that owns the VIEWPORT, resolved
// via ownerDocument (layout/panel-window.ts) — not the module-scope
// `window`, which is always the main one. A popped-out viewport
// (080226_panel-popout-windows.md) lives in another document, where
// module-scope `window` would both miss the child's events and
// hit-test the main window's pointer coordinates against a rect from a
// different coordinate space.
export function useViewportGestures(
  viewportRef: RefObject<HTMLDivElement | null>,
  setPan: Dispatch<SetStateAction<[number, number]>>,
  setZoom: Dispatch<SetStateAction<number>>,
  // False detaches every listener — the live link attaches the gestures
  // only while the visitor's pan/zoom button is on (091826_live-pan-zoom.md).
  enabled = true
) {
  useEffect(() => {
    if (!enabled) return;
    const onWheel = (e: WheelEvent) => {
      const el = viewportRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      ) {
        return;
      }
      e.preventDefault();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = e.deltaX || 0;
      const dy = e.deltaY || 0;
      // Zoom on an explicit modifier OR when the active device is a mouse
      // (whose wheel should zoom rather than pan). See input-device.ts.
      const isZoom = wheelWantsZoom(e);
      if (isZoom) {
        const mag = Math.abs(dx) > Math.abs(dy) ? dx : dy;
        const factor = Math.exp(-mag * 0.005);
        setZoom((prevZoom) => {
          const nextZoom = Math.max(0.1, Math.min(8, prevZoom * factor));
          const ratio = nextZoom / prevZoom;
          setPan(([px, py]) => [
            px * ratio + (e.clientX - cx) * (1 - ratio),
            py * ratio + (e.clientY - cy) * (1 - ratio),
          ]);
          return nextZoom;
        });
        return;
      }
      setPan(([px, py]) => [px - dx, py - dy]);
    };
    const win = ownerWindow(viewportRef.current);
    win.addEventListener("wheel", onWheel, { passive: false });
    return () => win.removeEventListener("wheel", onWheel);
  }, [viewportRef, setPan, setZoom, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const win = ownerWindow(viewportRef.current);
    const onDown = (e: PointerEvent) => {
      if (e.button !== 1) return;
      const el = viewportRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      ) {
        return;
      }
      e.preventDefault();
      // Cmd/Ctrl + middle-drag zooms about the press point; plain middle-drag
      // pans. (Drag right zooms in.)
      const zoomDrag = e.metaKey || e.ctrlKey;
      const startX = e.clientX;
      const startY = e.clientY;
      let curPan: [number, number] = [0, 0];
      setPan((p) => {
        curPan = p;
        return p;
      });
      let curZoom = 1;
      setZoom((z) => {
        curZoom = z;
        return z;
      });
      // Press point relative to the viewport center (matches the wheel-zoom
      // anchoring math), held fixed while zooming.
      const aX = startX - (rect.left + rect.width / 2);
      const aY = startY - (rect.top + rect.height / 2);
      const onMove = (ev: PointerEvent) => {
        if (zoomDrag) {
          // Drag up zooms in.
          const factor = Math.exp(-(ev.clientY - startY) * 0.005);
          const nextZoom = Math.max(0.1, Math.min(8, curZoom * factor));
          const ratio = nextZoom / curZoom;
          setZoom(nextZoom);
          setPan([
            curPan[0] * ratio + aX * (1 - ratio),
            curPan[1] * ratio + aY * (1 - ratio),
          ]);
        } else {
          setPan([
            curPan[0] + (ev.clientX - startX),
            curPan[1] + (ev.clientY - startY),
          ]);
        }
      };
      const onUp = () => {
        win.removeEventListener("pointermove", onMove);
        win.removeEventListener("pointerup", onUp);
      };
      win.addEventListener("pointermove", onMove);
      win.addEventListener("pointerup", onUp);
    };
    win.addEventListener("pointerdown", onDown);
    return () => win.removeEventListener("pointerdown", onDown);
  }, [viewportRef, setPan, setZoom, enabled]);

  // Touch / Pencil pan + pinch-zoom on the canvas viewport.
  // Mirrors the wheel handler's pan/zoom semantics so the canvas
  // behaves the same on touch as it does on a trackpad. Wired
  // directly on the viewport element (not window) because we need
  // multi-touch state and want to passively skip touches that start
  // outside the viewport.
  //
  // One finger / one pen → pan.
  // Two fingers → pinch zooms about the midpoint, AND drag pans
  // by the midpoint delta (matches Figma / Procreate).
  // Mouse pointers are ignored here — those go through the wheel
  // and middle-button paths above.
  useEffect(() => {
    if (!enabled) return;
    const el = viewportRef.current;
    if (!el) return;
    // Track active touch/pen pointers by id. Only the first two
    // matter for pinch math; additional fingers are ignored until
    // one of the active two leaves.
    const active = new Map<number, { x: number; y: number }>();
    let lastPanX = 0;
    let lastPanY = 0;
    let lastDist = 0;

    const isAcceptedPointer = (e: PointerEvent) =>
      e.pointerType === "touch" || e.pointerType === "pen";

    const recompute = () => {
      const pts = Array.from(active.values());
      if (pts.length === 1) {
        lastPanX = pts[0].x;
        lastPanY = pts[0].y;
        lastDist = 0;
      } else if (pts.length >= 2) {
        const a = pts[0];
        const b = pts[1];
        lastPanX = (a.x + b.x) / 2;
        lastPanY = (a.y + b.y) / 2;
        lastDist = Math.hypot(b.x - a.x, b.y - a.y);
      }
    };

    const onDown = (e: PointerEvent) => {
      if (!isAcceptedPointer(e)) return;
      // Only own gestures that *started* over the canvas viewport.
      const rect = el.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      ) {
        return;
      }
      // Cap at two tracked pointers — third+ fingers are noise.
      if (active.size >= 2) return;
      active.set(e.pointerId, { x: e.clientX, y: e.clientY });
      recompute();
      el.setPointerCapture(e.pointerId);
    };

    const onMove = (e: PointerEvent) => {
      if (!active.has(e.pointerId)) return;
      // Don't let the page see the gesture — touch-action on the el
      // disables it for one-finger pans, but two-finger pinches still
      // need this for some browsers.
      e.preventDefault();
      active.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pts = Array.from(active.values());
      if (pts.length === 1) {
        const dx = pts[0].x - lastPanX;
        const dy = pts[0].y - lastPanY;
        lastPanX = pts[0].x;
        lastPanY = pts[0].y;
        setPan(([px, py]) => [px + dx, py + dy]);
      } else if (pts.length >= 2) {
        const a = pts[0];
        const b = pts[1];
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        // Pan by midpoint movement so two-finger drag pans the
        // viewport, same as a trackpad two-finger swipe.
        const dx = midX - lastPanX;
        const dy = midY - lastPanY;
        lastPanX = midX;
        lastPanY = midY;
        // Pinch about the midpoint, in viewport-center-relative
        // coords (mirrors the wheel-zoom math above).
        const factor = lastDist > 0 ? dist / lastDist : 1;
        lastDist = dist;
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        setZoom((prevZoom) => {
          const nextZoom = Math.max(0.1, Math.min(8, prevZoom * factor));
          const ratio = nextZoom / prevZoom;
          setPan(([px, py]) => [
            (px + dx) * ratio + (midX - cx) * (1 - ratio),
            (py + dy) * ratio + (midY - cy) * (1 - ratio),
          ]);
          return nextZoom;
        });
      }
    };

    const release = (e: PointerEvent) => {
      if (!active.has(e.pointerId)) return;
      active.delete(e.pointerId);
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        // Pointer was already released by the browser; ignore.
      }
      recompute();
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove, { passive: false });
    el.addEventListener("pointerup", release);
    el.addEventListener("pointercancel", release);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", release);
      el.removeEventListener("pointercancel", release);
    };
  }, [viewportRef, setPan, setZoom, enabled]);
}
