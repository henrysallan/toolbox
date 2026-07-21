"use client";

// The Paint overlay's floating chrome (071926_paint-toolkit.md), built from
// the shared dock primitives in ../tool-dock.tsx so it matches Spline
// Draw's visual language exactly. Two pieces: the top-left tool dock (mode
// pill brush / eraser / blur / fill / eyedropper + a Clear action) and the
// top-right brush shelf (Size + Hardness sliders + the Edit Brush button
// that toggles the floating Brush Editor window).

import type { ReactElement } from "react";
import {
  DockDivider,
  DockHSlider,
  DockShell,
  IconToggle,
  ModeSlider,
} from "../tool-dock";
import type { PaintTool } from "./types";

export function PaintToolDock({
  left,
  top,
  tool,
  onSelectTool,
  onClear,
}: {
  left: number;
  top: number;
  tool: PaintTool;
  onSelectTool: (t: PaintTool) => void;
  onClear: () => void;
}) {
  const items: { id: PaintTool; label: string; icon: ReactElement }[] = [
    { id: "brush", label: "Brush (B)", icon: <BrushIcon /> },
    { id: "eraser", label: "Eraser (E)", icon: <EraserIcon /> },
    { id: "blur", label: "Blur", icon: <BlurIcon /> },
    { id: "fill", label: "Fill (G)", icon: <FillIcon /> },
    {
      id: "eyedropper",
      label: "Eyedropper (I, or Alt-click)",
      icon: <EyedropperIcon />,
    },
  ];
  return (
    <DockShell left={left} top={top}>
      <ModeSlider items={items} value={tool} onSelect={onSelectTool} />
      <DockDivider />
      {/* Clear the whole canvas — a one-shot action (undoable), not a mode. */}
      <IconToggle active={false} label="Clear canvas" onClick={onClear}>
        <ClearIcon />
      </IconToggle>
    </DockShell>
  );
}

// Top-right shelf: quick brush controls. Size mirrors the node's `size`
// param (same value the [ / ] shortcuts step); Hardness patches the brush
// blob's field. Both write through onParamChange so undo/autokey and the
// panel/editor readouts stay in sync.
export function PaintBrushShelf({
  right,
  top,
  size,
  hardness,
  onSizeChange,
  onHardnessChange,
  onEditBrush,
}: {
  right: number;
  top: number;
  size: number;
  hardness: number;
  onSizeChange: (v: number) => void;
  onHardnessChange: (v: number) => void;
  onEditBrush: () => void;
}) {
  return (
    <DockShell right={right} top={top} row>
      {/* Ranges mirror the panel's size ParamDef: the slider spans min..
          softMax (1..120) exactly like ScalarSliderRow; larger values are
          still reachable via the panel's number input or [ / ] keys (the
          readout shows them, the bar just pins). */}
      <DockHSlider
        label="Size"
        value={size}
        min={1}
        max={120}
        step={1}
        width={56}
        onChange={(v) => onSizeChange(Math.round(v))}
      />
      <DockHSlider
        label="Hardness"
        value={hardness}
        min={0}
        max={1}
        step={0.01}
        width={48}
        format={(v) => `${Math.round(v * 100)}`}
        onChange={(v) => onHardnessChange(Math.round(v * 100) / 100)}
      />
      <DockDivider vertical />
      <IconToggle active={false} label="Edit Brush…" onClick={onEditBrush}>
        <AdjustIcon />
      </IconToggle>
    </DockShell>
  );
}

// Inline icons, matching the spline dock's 14px stroke style.

// Brush — angled handle with a bristle head.
function BrushIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M13.5 2.5c-2.5.5-5.5 3-7 5l2 2c2-1.5 4.5-4.5 5-7z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M6 8c-1.6.2-2.6 1-3 3-.2 1-.8 1.6-1.5 2 1.2.6 3.3.7 4.5-.5 1-.9 1.2-2 1-2.7"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Eraser — the classic tilted block with a wipe line.
function EraserIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M9.5 2.5l4 4L8 12H5l-2.5-2.5 7-7z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M6.5 5.5l4 4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M3 14h10"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Blur — a water drop.
function BlurIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M8 2s4.5 4.8 4.5 8a4.5 4.5 0 01-9 0C3.5 6.8 8 2 8 2z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M6 10a2 2 0 002 2"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Fill — a tipping paint bucket with a drip.
function FillIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M7.5 2.5l5 5-4.5 4.5a1.4 1.4 0 01-2 0l-3-3a1.4 1.4 0 010-2l4.5-4.5z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M7.5 2.5L6 1"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M13.5 10.5s1.5 1.7 1.5 2.7a1.5 1.5 0 01-3 0c0-1 1.5-2.7 1.5-2.7z"
        fill="currentColor"
      />
    </svg>
  );
}

// Eyedropper — pipette at 45°.
function EyedropperIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M10.5 5.5l-6 6-1 2.5 2.5-1 6-6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path
        d="M9.5 3.5l1.5-1.5a1.4 1.4 0 012 0l1 1a1.4 1.4 0 010 2L12.5 6.5l-3-3z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
        fill="currentColor"
      />
    </svg>
  );
}

// Adjustments — three sliders with offset knobs (the Edit Brush button).
function AdjustIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M2 4.5h12M2 8h12M2 11.5h12"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <circle cx="10.5" cy="4.5" r="1.7" fill="currentColor" />
      <circle cx="5" cy="8" r="1.7" fill="currentColor" />
      <circle cx="11.5" cy="11.5" r="1.7" fill="currentColor" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M3 4h10M6.5 4V3h3v1M5 4l.7 9h4.6L11 4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
