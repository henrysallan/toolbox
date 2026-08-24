"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ProjectSettings } from "./ParamPanel";

// Floating Project Settings anchored to the gear chip in a Parameters
// panel's header — the same resolution / frame-rate / tempo rows as the
// full-panel "project" param view (File → Project Settings… still opens
// that), without taking the panel over. Dismiss rules follow
// lib/param-controls' Dropdown (outside mousedown, Esc). Rendered
// through a portal into the anchor's own document so a chip in a
// popped-out panel window anchors, clamps and dismisses against that
// window (080226_panel-popout-windows.md §3).

const W = 380;
// Estimated height for viewport clamping (RateProjectPopover's
// approach): section header + three setting rows + padding.
const H = 175;
const MARGIN = 8;
// Chip bottom edge → popover top edge.
const GAP = 4;

export interface ProjectSettingsPopoverProps {
  // The gear chip that opened the popover. Anchor for positioning
  // (below it, right edges aligned) and exempt from outside-mousedown
  // dismiss so the chip's own onClick handles the close half of its
  // toggle without a close-then-reopen race.
  anchorEl: HTMLElement;
  canvasRes: [number, number];
  onCanvasResChange: (res: [number, number]) => void;
  fps: number;
  onFpsChange: (fps: number) => void;
  bpm: number;
  onBpmChange: (bpm: number) => void;
  onClose: () => void;
}

export default function ProjectSettingsPopover({
  anchorEl,
  canvasRes,
  onCanvasResChange,
  fps,
  onFpsChange,
  bpm,
  onBpmChange,
  onClose,
}: ProjectSettingsPopoverProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Place below the chip, right-aligned to it, clamped to the viewport
  // — re-clamped on window resize so it can't end up off-screen.
  useLayoutEffect(() => {
    const win = anchorEl.ownerDocument.defaultView ?? window;
    const place = () => {
      // The chip can unmount under an open popover (panel kind switched,
      // layout edited) — close instead of clamping to a stale rect.
      if (!anchorEl.isConnected) {
        onClose();
        return;
      }
      const r = anchorEl.getBoundingClientRect();
      const left = Math.max(
        MARGIN,
        Math.min(win.innerWidth - W - MARGIN, r.right - W)
      );
      const top = Math.max(
        MARGIN,
        Math.min(win.innerHeight - H - MARGIN, r.bottom + GAP)
      );
      setPos({ left, top });
    };
    place();
    win.addEventListener("resize", place);
    return () => win.removeEventListener("resize", place);
  }, [anchorEl, onClose]);

  // Click-outside + Escape dismiss, on the anchor's own window.
  useEffect(() => {
    const win = anchorEl.ownerDocument.defaultView ?? window;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      // The resolution Dropdown's list portals to <body>, so it's
      // outside our subtree — without this, picking a preset would read
      // as a click-away and close the popover before the pick lands
      // (same rule as FileNameMenu).
      if (t?.closest?.("[data-tb-dropdown]")) return;
      if (anchorEl.contains(t)) return;
      if (rootRef.current?.contains(t)) return;
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
  }, [anchorEl, onClose]);

  if (!pos) return null;

  return createPortal(
    <div
      ref={rootRef}
      style={{
        position: "fixed",
        left: pos.left,
        top: pos.top,
        width: W,
        boxSizing: "border-box",
        background: "var(--tb-n-1)",
        border: "1px solid var(--tb-n-7)",
        borderRadius: 6,
        boxShadow: "0 8px 28px rgba(0,0,0,0.5)",
        padding: 12,
        zIndex: 4000,
        color: "var(--tb-n-16)",
        fontFamily: "var(--ui-font)",
        fontSize: 11,
      }}
    >
      <ProjectSettings
        canvasRes={canvasRes}
        onCanvasResChange={onCanvasResChange}
        fps={fps}
        onFpsChange={onFpsChange}
        bpm={bpm}
        onBpmChange={onBpmChange}
      />
    </div>,
    anchorEl.ownerDocument.body
  );
}
