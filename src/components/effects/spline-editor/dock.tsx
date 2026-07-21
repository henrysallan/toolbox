"use client";

// The Spline Draw overlay's floating chrome: the tool dock (mode pill +
// close-loop / delete-subpath toggles) and the anchor context menu. Split out
// of the monolith in M0 of specdocs/071926_spline-draw-authoring-upgrade.md.
// The generic dock chrome (shell, mode pill, icon toggle) now lives in
// ../tool-dock.tsx, shared with the Paint editor (071926_paint-toolkit.md).

import { useState, type ReactElement } from "react";
import {
  DockDivider,
  DockShell,
  IconToggle,
  ModeSlider,
} from "../tool-dock";
import type { ToolMode } from "./types";

// Tool dock, pinned to the viewport panel's upper-left. Positioned in client
// coords by the caller (the canvas's containing panel rect) so it docks to
// the window corner rather than the letterboxed canvas edge, and stays put
// through splitter drags / resize / zoom. Lives outside the SVG to keep its
// hit-testing simple.
export function ToolDock({
  left,
  top,
  tool,
  onSelectTool,
  closed,
  onToggleClosed,
  showDeleteSubpath,
  onDeleteSubpath,
}: {
  left: number;
  top: number;
  tool: ToolMode;
  onSelectTool: (t: ToolMode) => void;
  closed: boolean;
  onToggleClosed: () => void;
  showDeleteSubpath: boolean;
  onDeleteSubpath: () => void;
}) {
  const items: { id: ToolMode; label: string; icon: ReactElement }[] = [
    { id: "pen", label: "Pen (P)", icon: <PenIcon /> },
    { id: "pencil", label: "Pencil — freehand (N)", icon: <PencilIcon /> },
    { id: "path", label: "Path select (V)", icon: <FilledArrowIcon /> },
    { id: "subpath", label: "Sub-path select (A)", icon: <OutlineArrowIcon /> },
    { id: "shape", label: "Shape Builder (B)", icon: <ShapeBuilderIcon /> },
  ];
  return (
    <DockShell left={left} top={top}>
      {/* Mode picker — a vertically stacked segmented pill whose active
          highlight and hover ghost both slide between the segments. */}
      <ModeSlider items={items} value={tool} onSelect={onSelectTool} />
      {/* Divider before the standalone close-loop toggle. */}
      <DockDivider />
      {/* Close loop — a stateful toggle, not a mode, so it lives outside the
          sliding pill and lights up independently. */}
      <IconToggle active={closed} label="Close loop" onClick={onToggleClosed}>
        <LoopIcon />
      </IconToggle>
      {/* Delete the active subpath — only when there's more than one (we
          never reduce to an empty subpaths array). */}
      {showDeleteSubpath && (
        <IconToggle
          active={false}
          label="Delete sub-path (⌫)"
          onClick={onDeleteSubpath}
        >
          <TrashIcon />
        </IconToggle>
      )}
    </DockShell>
  );
}

// Right-click context menu — a generic vertical item list; the component
// builds the item set per target (anchor vs segment, selection size, corner
// radii present, endpoint-ness). Spec 071926 M4 grew this from the fixed
// anchor menu.
export function SplineContextMenu({
  x,
  y,
  items,
}: {
  x: number;
  y: number;
  items: Array<{ label: string; onClick: () => void }>;
}) {
  return (
    <div
      data-spline-menu
      style={{
        position: "fixed",
        left: x,
        top: y,
        minWidth: 150,
        padding: 4,
        background: "rgba(17, 17, 17, 0.97)",
        border: "1px solid #3f3f46",
        borderRadius: 5,
        boxShadow: "0 6px 18px rgba(0, 0, 0, 0.45)",
        pointerEvents: "auto",
        fontFamily: "ui-monospace, monospace",
        fontSize: 12,
        zIndex: 10,
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it) => (
        <MenuItem key={it.label} label={it.label} onClick={it.onClick} />
      ))}
    </div>
  );
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "5px 9px",
        background: hover ? "#0ea5e9" : "transparent",
        color: hover ? "#0b1220" : "#e4e4e7",
        border: "none",
        borderRadius: 3,
        cursor: "pointer",
        fontFamily: "inherit",
        fontSize: "inherit",
      }}
    >
      {label}
    </button>
  );
}

// Inline icons so we don't pull in an icon dependency for a few glyphs.
function PenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M11 2l3 3-8 8-4 1 1-4 8-8z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path
        d="M9 4l3 3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Pencil (freehand) — same diagonal implement as the pen, but with a double
// ferrule band near the eraser instead of the pen's single nib notch, so the
// two read as distinct glyphs at 14px.
function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M11 2l3 3-8 8-4 1 1-4 8-8z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path
        d="M9.5 3.5l3 3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M7.8 5.2l3 3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Path Select — a solid (filled) arrow cursor: "move the whole object".
function FilledArrowIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M3 2l6 12 1.8-4.2L15 8 3 2z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="currentColor"
      />
    </svg>
  );
}

// Sub-path Select — a hollow (outline) arrow cursor: "direct-select / edit
// anchors", mirroring Illustrator's white Direct Selection arrow.
function OutlineArrowIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M3 2l6 12 1.8-4.2L15 8 3 2z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

// Shape Builder — two overlapping shapes with the shared lens filled: "the
// overlap region is the thing you act on".
function ShapeBuilderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle
        cx="6"
        cy="6"
        r="4.5"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
      />
      <circle
        cx="10"
        cy="10"
        r="4.5"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
      />
      <path
        d="M8 4.55 A4.5 4.5 0 0 1 11.45 8 A4.5 4.5 0 0 1 8 11.45 A4.5 4.5 0 0 1 4.55 8 A4.5 4.5 0 0 1 8 4.55z"
        fill="currentColor"
        opacity="0.55"
      />
    </svg>
  );
}

function LoopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle
        cx="8"
        cy="8"
        r="5"
        stroke="currentColor"
        strokeWidth="1.6"
        fill="none"
      />
    </svg>
  );
}

function TrashIcon() {
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
