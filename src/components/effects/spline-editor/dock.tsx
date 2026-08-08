"use client";

// The Spline Draw overlay's floating chrome: the tool dock (mode pill +
// close-loop / delete-subpath toggles) and the anchor context menu. Split out
// of the monolith in M0 of specdocs/archive/071926_spline-draw-authoring-upgrade.md.
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
  showOnion,
  onionOn,
  onToggleOnion,
  showGhosts,
  ghostsOn,
  onToggleGhosts,
}: {
  left: number;
  top: number;
  tool: ToolMode;
  onSelectTool: (t: ToolMode) => void;
  closed: boolean;
  onToggleClosed: () => void;
  showDeleteSubpath: boolean;
  onDeleteSubpath: () => void;
  // Onion skinning (spec 072726 M1) — surfaced only while a neighboring
  // Path Animation keyframe ghost exists.
  showOnion?: boolean;
  onionOn?: boolean;
  onToggleOnion?: () => void;
  // Multi-node ghosts (spec 072726 M5) — surfaced only while another
  // Spline Draw node exists.
  showGhosts?: boolean;
  ghostsOn?: boolean;
  onToggleGhosts?: () => void;
}) {
  const items: { id: ToolMode; label: string; icon: ReactElement }[] = [
    { id: "pen", label: "Pen (P)", icon: <PenIcon /> },
    { id: "pencil", label: "Pencil — freehand (N)", icon: <PencilIcon /> },
    {
      id: "rect",
      label: "Rectangle (M) — Shift 1:1, Alt from centre",
      icon: <RectIcon />,
    },
    {
      id: "ellipse",
      label: "Ellipse (L) — Shift 1:1, Alt from centre",
      icon: <EllipseIcon />,
    },
    { id: "path", label: "Path select (V)", icon: <FilledArrowIcon /> },
    { id: "subpath", label: "Sub-path select (A)", icon: <OutlineArrowIcon /> },
    { id: "shape", label: "Shape Builder (B)", icon: <ShapeBuilderIcon /> },
    { id: "width", label: "Width tool (W)", icon: <WidthIcon /> },
    { id: "measure", label: "Measure (I)", icon: <RulerIcon /> },
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
      {/* Onion-skin toggle — ghosts of the neighboring Path Animation
          keyframes (prev red / next green). */}
      {showOnion && onToggleOnion && (
        <IconToggle
          active={!!onionOn}
          label="Onion skin (neighboring keyframes)"
          onClick={onToggleOnion}
        >
          <OnionIcon />
        </IconToggle>
      )}
      {/* Other-splines toggle — dim reference outlines of every other
          Spline Draw node (snappable; click one in a select tool to switch
          to editing it). */}
      {showGhosts && onToggleGhosts && (
        <IconToggle
          active={!!ghostsOn}
          label="Show other splines (snap + click to switch)"
          onClick={onToggleGhosts}
        >
          <GhostsIcon />
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
        background: "color-mix(in srgb, var(--tb-n-0) 97%, transparent)",
        border: "1px solid var(--tb-n-9)",
        borderRadius: 5,
        boxShadow: "0 6px 18px rgba(0, 0, 0, 0.45)",
        pointerEvents: "auto",
        fontFamily: "var(--ui-font)",
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
        color: hover ? "var(--tb-t-navy-d-0)" : "var(--tb-n-16)",
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

// Pen — a fountain-pen NIB: the classic leaf silhouette (pointed at the
// shoulder and the tip, widest in the middle) with a breather hole and the
// slit running down to the tip. Reads as "pen" at 14px and shares nothing
// with the pencil's diagonal implement.
function PenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M8 1.4C10.3 4.4 11.6 6.6 11.6 8.6C11.6 10.9 9.9 12.9 8 14.6C6.1 12.9 4.4 10.9 4.4 8.6C4.4 6.6 5.7 4.4 8 1.4Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="7.2" r="1.05" stroke="currentColor" strokeWidth="1.1" />
      <path
        d="M8 8.6V14.4"
        stroke="currentColor"
        strokeWidth="1.2"
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

// Rectangle primitive — a plain outlined box.
function RectIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect
        x="2.5"
        y="3.5"
        width="11"
        height="9"
        rx="0.5"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
      />
    </svg>
  );
}

// Ellipse primitive — a wide oval, so it never reads as the close-loop
// toggle's true circle.
function EllipseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <ellipse
        cx="8"
        cy="8"
        rx="5.5"
        ry="4.5"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
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

// Other-splines ghosts — a solid curve with a faint second curve behind it.
function GhostsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M2 6 C 5 2, 11 2, 14 6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        opacity="0.4"
      />
      <path
        d="M2 11 C 5 7, 11 7, 14 11"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Measure — a diagonal ruler with cross ticks.
function RulerIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M2.5 13.5 L 13.5 2.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M5 10 l 1.4 1.4 M8 7 l 1.4 1.4 M11 4 l 1.4 1.4"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Width tool — a tapered stroke: wide at one end, narrow at the other.
function WidthIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M2 11 C 5 11, 10 9.6, 14 8.6 C 10 7.6, 5 6.2, 2 6.2 C 3.2 7.8, 3.2 9.4, 2 11 Z"
        fill="currentColor"
        opacity="0.9"
      />
    </svg>
  );
}

// Onion skin — three offset outlines suggesting ghost frames.
function OnionIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle
        cx="6"
        cy="8"
        r="4"
        stroke="currentColor"
        strokeWidth="1.2"
        opacity="0.45"
      />
      <circle
        cx="8"
        cy="8"
        r="4"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <circle
        cx="10"
        cy="8"
        r="4"
        stroke="currentColor"
        strokeWidth="1.2"
        opacity="0.45"
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
