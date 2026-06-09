"use client";

import { useCallback, useState } from "react";

export interface ViewportMenuBarProps {
  /** Project resolution (full export size). */
  projectRes: [number, number];
  /** Current preview scale, 1.0 = full res. */
  previewScale: number;
  onPreviewScaleChange: (scale: number) => void;
  /**
   * Spline-primitive shelf buttons (right side of the bar). Spawns a new
   * source node of the given type; the parent wires it into the active /
   * selected Merge node when there is one.
   */
  onAddPrimitive?: (type: "circle" | "rectangle" | "spline-draw") => void;
}

type PrimitiveType = "circle" | "rectangle" | "spline-draw";

const PRIMITIVES: {
  type: PrimitiveType;
  title: string;
  icon: React.ReactNode;
}[] = [
  {
    type: "circle",
    title: "Add Circle (spline)",
    icon: (
      <circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" />
    ),
  },
  {
    type: "rectangle",
    title: "Add Rectangle (spline)",
    icon: (
      <rect
        x="3.5"
        y="3.5"
        width="9"
        height="9"
        rx="1"
        fill="none"
        stroke="currentColor"
      />
    ),
  },
  {
    type: "spline-draw",
    title: "Draw Spline (pen tool)",
    icon: (
      <path
        d="M3 13 L9 4 L13 8 L3 13 Z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
      />
    ),
  },
];

function ShelfButton({
  title,
  icon,
  onClick,
}: {
  title: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 20,
        height: 18,
        padding: 0,
        border: "none",
        borderRadius: 3,
        background: hover ? "#27272a" : "transparent",
        color: hover ? "#e4e4e7" : "#a1a1aa",
        cursor: "pointer",
      }}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" strokeWidth="1.4">
        {icon}
      </svg>
    </button>
  );
}

/**
 * Lightweight menubar that sits above the preview viewport.
 *
 * Hosts the preview-resolution slider, which decouples the GL render
 * resolution from both the on-screen canvas display size and the
 * project export resolution. Lower preview scale = fewer pixels per
 * shader pass = higher fps for live editing. Export paths still use
 * the full project resolution.
 */
export default function ViewportMenuBar({
  projectRes,
  previewScale,
  onPreviewScaleChange,
  onAddPrimitive,
}: ViewportMenuBarProps) {
  const setScale = useCallback(
    (s: number) => {
      const clamped = Math.max(0.1, Math.min(1, s));
      onPreviewScaleChange(Math.round(clamped * 100) / 100);
    },
    [onPreviewScaleChange]
  );

  const renderW = Math.max(2, Math.round(projectRes[0] * previewScale));
  const renderH = Math.max(2, Math.round(projectRes[1] * previewScale));
  const pct = Math.round(previewScale * 100);

  return (
    <div
      style={{
        height: 22,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "0 10px",
        background: "#0a0a0a",
        fontSize: 11,
        color: "#a1a1aa",
        userSelect: "none",
        flexShrink: 0,
      }}
    >
      <input
        title="Preview render resolution. Independent from on-screen size and project export resolution. Lowering this speeds up live playback."
        type="range"
        min={10}
        max={100}
        step={5}
        value={pct}
        onChange={(e) => setScale(Number(e.target.value) / 100)}
        style={{ width: 110, accentColor: "#52525b", height: 14 }}
        aria-label="Preview resolution scale"
      />
      <span
        style={{
          color: "#e4e4e7",
          fontVariantNumeric: "tabular-nums",
          minWidth: 30,
          fontSize: 10,
        }}
      >
        {pct}%
      </span>
      <span
        style={{
          color: "#52525b",
          fontVariantNumeric: "tabular-nums",
          fontSize: 10,
        }}
      >
        {renderW}×{renderH}
      </span>

      {/* Right-aligned spline-primitive shelf. */}
      {onAddPrimitive && (
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 2,
          }}
        >
          {PRIMITIVES.map((p) => (
            <ShelfButton
              key={p.type}
              title={p.title}
              icon={p.icon}
              onClick={() => onAddPrimitive(p.type)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
