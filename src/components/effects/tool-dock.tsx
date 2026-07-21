"use client";

// Shared chrome for the on-canvas tool docks (Spline Draw, Paint): the outer
// floating shell, the vertically-sliding mode pill, standalone icon toggles,
// and the divider. Extracted from spline-editor/dock.tsx so the paint editor
// gets the identical visual language (071926_paint-toolkit.md). Docks own
// their tool lists and icons; this module owns geometry + interaction states.

import { useState, type ReactElement, type ReactNode } from "react";
import { MiniBarSlider } from "@/lib/param-controls";

// Segment size for a dock's mode pill (square icon buttons sit edge-to-edge
// so the sliding highlight is contiguous).
export const TOOL_BTN = 26;
export const TOOL_INSET = 2; // gap between a segment edge and its highlight

// Active-state palette — matches the spline editor's anchor blue.
export const DOCK_ACTIVE_STROKE = "#3b82f6";
export const DOCK_ACTIVE_FILL = "rgba(59, 130, 246, 0.18)";

// Outer floating shell, pinned in client coords by the caller (typically the
// canvas's containing panel rect) so it docks to the window corner rather
// than the letterboxed canvas edge, and stays put through splitter drags /
// resize / zoom. Pin with `left` OR `right` (px from the window's right
// edge); `row` lays children out horizontally (the top-right brush shelf).
export function DockShell({
  left,
  right,
  top,
  row,
  children,
}: {
  left?: number;
  right?: number;
  top: number;
  row?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        position: "fixed",
        left,
        right,
        top,
        display: "flex",
        flexDirection: row ? "row" : "column",
        alignItems: "center",
        gap: 4,
        padding: 3,
        background: "rgba(17, 17, 17, 0.9)",
        border: "1px solid #27272a",
        borderRadius: 6,
        boxShadow: "0 4px 12px rgba(0, 0, 0, 0.35)",
        pointerEvents: "auto",
        fontFamily: "ui-monospace, monospace",
      }}
    >
      {children}
    </div>
  );
}

export function DockDivider({ vertical }: { vertical?: boolean }) {
  return vertical ? (
    <div
      style={{
        width: 1,
        height: TOOL_BTN,
        margin: "0 1px",
        background: "#3f3f46",
      }}
    />
  ) : (
    <div
      style={{
        height: 1,
        width: TOOL_BTN,
        margin: "1px 0",
        background: "#3f3f46",
      }}
    />
  );
}

// Mode picker. A single active highlight (low-opacity blue fill + blue
// stroke) slides between the segments, and a neutral hover ghost slides to
// whichever segment is hovered — matching the app's PillToggle.
export function ModeSlider<T extends string>({
  items,
  value,
  onSelect,
}: {
  items: { id: T; label: string; icon: ReactElement }[];
  value: T;
  onSelect: (t: T) => void;
}) {
  const activeIdx = Math.max(
    0,
    items.findIndex((it) => it.id === value)
  );
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const ghostIdx = hoverIdx ?? activeIdx;
  return (
    <div
      onMouseLeave={() => setHoverIdx(null)}
      style={{ position: "relative", display: "flex", flexDirection: "column" }}
    >
      {/* Active highlight — slides vertically between segments. */}
      <div
        style={{
          position: "absolute",
          left: TOOL_INSET,
          right: TOOL_INSET,
          top: activeIdx * TOOL_BTN + TOOL_INSET,
          height: TOOL_BTN - TOOL_INSET * 2,
          background: DOCK_ACTIVE_FILL,
          border: `1px solid ${DOCK_ACTIVE_STROKE}`,
          borderRadius: 4,
          boxSizing: "border-box",
          transition: "top 0.16s cubic-bezier(0.4,0,0.2,1)",
          pointerEvents: "none",
        }}
      />
      {/* Hover ghost — slides to the hovered segment, shown only when hovering
          a non-active one. */}
      <div
        style={{
          position: "absolute",
          left: TOOL_INSET,
          right: TOOL_INSET,
          top: ghostIdx * TOOL_BTN + TOOL_INSET,
          height: TOOL_BTN - TOOL_INSET * 2,
          background: "rgba(255, 255, 255, 0.08)",
          borderRadius: 4,
          opacity: hoverIdx !== null && hoverIdx !== activeIdx ? 1 : 0,
          transition: "top 0.12s ease, opacity 0.12s ease",
          pointerEvents: "none",
        }}
      />
      {items.map((it, i) => {
        const active = i === activeIdx;
        return (
          <button
            key={it.id}
            type="button"
            title={it.label}
            aria-label={it.label}
            aria-pressed={active}
            onClick={() => onSelect(it.id)}
            onMouseEnter={() => setHoverIdx(i)}
            style={{
              position: "relative",
              zIndex: 1,
              width: TOOL_BTN,
              height: TOOL_BTN,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "transparent",
              color: active
                ? DOCK_ACTIVE_STROKE
                : hoverIdx === i
                  ? "#e4e4e7"
                  : "#a1a1aa",
              border: "none",
              cursor: "pointer",
              padding: 0,
              transition: "color 0.12s ease",
            }}
          >
            {it.icon}
          </button>
        );
      })}
    </div>
  );
}

// Compact labeled slider for dock shelves — the parameter panel's bar
// slider (MiniBarSlider: dark track + fill + leading-edge line + the
// dampened transparent native range, so Shift fine-tune and rAF
// coalescing come along) with a tiny label and numeric readout beside it.
export function DockHSlider({
  value,
  min,
  max,
  step,
  label,
  width = 64,
  format,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  label: string;
  width?: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        height: 20,
        padding: "0 2px",
      }}
    >
      <span style={{ fontSize: 9, lineHeight: 1, color: "#a1a1aa" }}>
        {label}
      </span>
      <div style={{ display: "flex", width }}>
        <MiniBarSlider
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={onChange}
          title={`${label} — hold Shift to fine-tune`}
        />
      </div>
      <span
        style={{
          fontSize: 9,
          lineHeight: 1,
          minWidth: 18,
          textAlign: "right",
          color: "#d4d4d8",
        }}
      >
        {format ? format(value) : String(Math.round(value))}
      </span>
    </div>
  );
}

// Standalone stateful icon toggle (also used for one-shot action buttons with
// active={false}). Low-opacity blue fill + blue stroke when active; a neutral
// wash on hover.
export function IconToggle({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: ReactElement;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: TOOL_BTN,
        height: TOOL_BTN,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: active
          ? DOCK_ACTIVE_FILL
          : hover
            ? "rgba(255, 255, 255, 0.08)"
            : "transparent",
        color: active ? DOCK_ACTIVE_STROKE : hover ? "#e4e4e7" : "#a1a1aa",
        border: `1px solid ${active ? DOCK_ACTIVE_STROKE : "transparent"}`,
        borderRadius: 4,
        boxSizing: "border-box",
        cursor: "pointer",
        padding: 0,
        transition:
          "background 0.12s ease, color 0.12s ease, border-color 0.12s ease",
      }}
    >
      {children}
    </button>
  );
}
