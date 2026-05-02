"use client";

// Context bar that mounts above the preview viewport whenever a
// Transform-style node is selected. Hosts node-specific quick
// actions (flip H, flip V to start; future buttons can land in the
// same row). Sits in the canvas area's chrome above the actual
// canvas surface — independent of the rendered output.
//
// Designed as a thin stateless component: parents wire concrete
// handlers via props. Keeps the bar reusable for any node type
// that wants to expose canvas-adjacent actions.

interface Props {
  onFlipHorizontal: () => void;
  onFlipVertical: () => void;
}

export default function TransformContextBar({
  onFlipHorizontal,
  onFlipVertical,
}: Props) {
  return (
    <div
      style={{
        height: 26,
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "0 8px",
        background: "#0a0a0a",
        borderBottom: "1px solid #27272a",
        userSelect: "none",
        flexShrink: 0,
      }}
    >
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
    </div>
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
  return (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      style={{
        width: 22,
        height: 18,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        border: "1px solid transparent",
        borderRadius: 3,
        color: "#e5e7eb",
        cursor: "pointer",
        padding: 0,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "#1c1c1f";
        e.currentTarget.style.borderColor = "#27272a";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.borderColor = "transparent";
      }}
    >
      {children}
    </button>
  );
}

// Two triangles pointing inward toward a vertical center line —
// canonical "flip horizontal" affordance.
function FlipHorizontalIcon() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1={7} y1={2} x2={7} y2={12} strokeDasharray="1.5 1.5" />
      <path d="M2 4 L5 7 L2 10 Z" fill="currentColor" />
      <path d="M12 4 L9 7 L12 10 Z" fill="currentColor" />
    </svg>
  );
}

// Same glyph rotated 90° — triangles pointing inward toward a
// horizontal center line.
function FlipVerticalIcon() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1={2} y1={7} x2={12} y2={7} strokeDasharray="1.5 1.5" />
      <path d="M4 2 L7 5 L10 2 Z" fill="currentColor" />
      <path d="M4 12 L7 9 L10 12 Z" fill="currentColor" />
    </svg>
  );
}
