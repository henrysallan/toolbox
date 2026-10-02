"use client";

import { useState } from "react";

// Quick actions for the selected Transform-style node (flip H, flip V
// to start; future buttons can land in the same group). Renders into
// the viewport menu bar's trailing slot, just left of the view-option
// toggles and split from them by a hairline, so the toggles stay
// pinned to the corner while this group comes and goes with the
// selection — and the canvas below never shifts. Same 19×17 chip
// chrome as the toggles, minus the pressed state: these are one-shot
// actions, not switches.
//
// Designed as a thin stateless component: parents wire concrete
// handlers via props. Keeps the group reusable for any node type
// that wants to expose canvas-adjacent actions.

interface Props {
  onFlipHorizontal: () => void;
  onFlipVertical: () => void;
}

export default function TransformContextActions({
  onFlipHorizontal,
  onFlipVertical,
}: Props) {
  return (
    <>
      <ContextButton
        title="Flip horizontal — mirrors across the pivot's Y axis"
        onClick={onFlipHorizontal}
      >
        <FlipHorizontalIcon />
      </ContextButton>
      <ContextButton
        title="Flip vertical — mirrors across the pivot's X axis"
        onClick={onFlipVertical}
      >
        <FlipVerticalIcon />
      </ContextButton>
      <span
        aria-hidden
        style={{
          width: 1,
          height: 11,
          margin: "0 2px",
          background: "var(--tb-n-7)",
        }}
      />
    </>
  );
}

function ContextButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 19,
        height: 17,
        padding: 0,
        display: "grid",
        placeItems: "center",
        boxSizing: "border-box",
        background: hover ? "var(--tb-n-4)" : "var(--tb-n-3)",
        border: `1px solid ${hover ? "var(--tb-n-9)" : "var(--tb-n-7)"}`,
        borderRadius: 3,
        color: hover ? "var(--tb-n-16)" : "var(--tb-n-13)",
        cursor: "pointer",
        transition: "background 80ms, border-color 80ms, color 80ms",
      }}
    >
      {children}
    </button>
  );
}

// Two triangles pointing inward toward a dashed vertical axis —
// canonical "flip horizontal" affordance. Drawn on the same 11-unit
// grid as the view-toggle glyphs beside it.
function FlipHorizontalIcon() {
  return (
    <svg
      width={11}
      height={11}
      viewBox="0 0 11 11"
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1={5.5} y1={1} x2={5.5} y2={10} strokeDasharray="2 1.5" />
      <path d="M1 3 L3.5 5.5 L1 8 Z" fill="currentColor" />
      <path d="M10 3 L7.5 5.5 L10 8 Z" fill="currentColor" />
    </svg>
  );
}

// Same glyph rotated 90° — triangles pointing inward toward a
// horizontal axis.
function FlipVerticalIcon() {
  return (
    <svg
      width={11}
      height={11}
      viewBox="0 0 11 11"
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1={1} y1={5.5} x2={10} y2={5.5} strokeDasharray="2 1.5" />
      <path d="M3 1 L5.5 3.5 L8 1 Z" fill="currentColor" />
      <path d="M3 10 L5.5 7.5 L8 10 Z" fill="currentColor" />
    </svg>
  );
}
