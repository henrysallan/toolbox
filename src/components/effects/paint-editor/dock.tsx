"use client";

// The Paint overlay's floating chrome (071926_paint-toolkit.md,
// 101526_paint-selection-transform.md), built from
// the shared dock primitives in ../tool-dock.tsx so it matches Spline
// Draw's visual language exactly. Two pieces: the top-left tool dock (mode
// pill brush / eraser / blur / fill / eyedropper + Clear, and Flatten when
// an image is wired into the node) and the
// top-right brush shelf (Size + Hardness sliders + the Edit Brush button
// that toggles the floating Brush Editor window; with a marquee tool active
// it swaps for the selection shelf: combine mode + select all / deselect /
// invert).

import { useState, type ReactElement } from "react";
import {
  DOCK_ACTIVE_FILL,
  DOCK_ACTIVE_STROKE,
  DockDivider,
  DockHSlider,
  DockShell,
  IconToggle,
  ModeSlider,
} from "../tool-dock";
import type { SelectionMode } from "./selection";
import type { TransformReadout } from "./transform";
import type { PaintTool } from "./types";

export function PaintToolDock({
  left,
  top,
  tool,
  onSelectTool,
  onClear,
  onFlatten,
  flattening = false,
  marqueeVariant,
  lassoVariant,
}: {
  left: number;
  top: number;
  tool: PaintTool;
  onSelectTool: (t: PaintTool) => void;
  // The marquee and lasso families share one slot each, showing the last
  // used variant (clicking the active slot flips it — handled upstream).
  marqueeVariant: "marquee-rect" | "marquee-ellipse";
  lassoVariant: "lasso" | "lasso-poly";
  onClear: () => void;
  // Present only while an image is wired in.
  onFlatten?: () => void;
  // A Flatten readback is in flight — shown as the pressed state.
  flattening?: boolean;
}) {
  const items: { id: PaintTool; label: string; icon: ReactElement }[] = [
    {
      id: "move",
      label:
        "Move / transform (V) — drag to move, handles scale / rotate (Cmd skews), Alt-drag duplicates, arrows nudge",
      icon: <MoveIcon />,
    },
    marqueeVariant === "marquee-rect"
      ? {
          id: "marquee-rect",
          label: "Rectangular marquee (M; click again or Shift+M for elliptical)",
          icon: <MarqueeRectIcon />,
        }
      : {
          id: "marquee-ellipse",
          label: "Elliptical marquee (M; click again or Shift+M for rectangular)",
          icon: <MarqueeEllipseIcon />,
        },
    lassoVariant === "lasso"
      ? {
          id: "lasso",
          label: "Lasso (L; click again or Shift+L for polygonal)",
          icon: <LassoIcon />,
        }
      : {
          id: "lasso-poly",
          label:
            "Polygonal lasso (L) — click vertices, close on the first or double-click, Backspace drops one, Shift snaps 45°",
          icon: <PolyLassoIcon />,
        },
    { id: "wand", label: "Magic wand (W)", icon: <WandIcon /> },
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
      <IconToggle
        active={false}
        label={onFlatten ? "Clear strokes and erasures" : "Clear canvas"}
        onClick={onClear}
      >
        <ClearIcon />
      </IconToggle>
      {/* Bake the wired-in image into the layer (undoable): from then on
          upstream changes stop showing through. */}
      {onFlatten && (
        <IconToggle
          active={flattening}
          label="Flatten input into the layer"
          onClick={onFlatten}
        >
          <FlattenIcon />
        </IconToggle>
      )}
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

// Top-right shelf for the Move tool (101526 §5): the transform readout —
// W / H % of native size, angle, and the center's X / Y in canvas px, all
// editable (Enter or blur applies; editing a plain selection lifts it) —
// flips, and, while pixels float, keep (Enter) / put back (Escape).
export function PaintMoveShelf({
  right,
  top,
  floating,
  readout,
  onReadoutChange,
  onFlip,
  onCommit,
  onCancel,
}: {
  right: number;
  top: number;
  floating: boolean;
  // Null = nothing selected (just the hint).
  readout: TransformReadout | null;
  onReadoutChange: (patch: Partial<TransformReadout>) => void;
  onFlip: (axis: "h" | "v") => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  if (!readout) {
    return (
      <DockShell right={right} top={top} row>
        <span style={SHELF_HINT}>Select something to move or transform it</span>
      </DockShell>
    );
  }
  return (
    <DockShell right={right} top={top} row>
      <DockNumberField
        label="W"
        value={readout.w}
        digits={1}
        suffix="%"
        onCommit={(v) => onReadoutChange({ w: v })}
      />
      <DockNumberField
        label="H"
        value={readout.h}
        digits={1}
        suffix="%"
        onCommit={(v) => onReadoutChange({ h: v })}
      />
      <DockNumberField
        label="∠"
        value={readout.angle}
        digits={1}
        suffix="°"
        onCommit={(v) => onReadoutChange({ angle: v })}
      />
      <DockNumberField
        label="X"
        value={readout.x}
        digits={0}
        onCommit={(v) => onReadoutChange({ x: v })}
      />
      <DockNumberField
        label="Y"
        value={readout.y}
        digits={0}
        onCommit={(v) => onReadoutChange({ y: v })}
      />
      <DockDivider vertical />
      <IconToggle active={false} label="Flip horizontal" onClick={() => onFlip("h")}>
        <FlipHIcon />
      </IconToggle>
      <IconToggle active={false} label="Flip vertical" onClick={() => onFlip("v")}>
        <FlipVIcon />
      </IconToggle>
      {floating && (
        <>
          <DockDivider vertical />
          <IconToggle active={false} label="Commit (Enter)" onClick={onCommit}>
            <CheckIcon />
          </IconToggle>
          <IconToggle active={false} label="Cancel (Escape)" onClick={onCancel}>
            <CrossIcon />
          </IconToggle>
        </>
      )}
    </DockShell>
  );
}

const SHELF_HINT = {
  fontSize: 11,
  color: "var(--tb-n-13)",
  padding: "0 6px",
  whiteSpace: "nowrap",
} as const;

// A compact numeric field: shows `value` rounded until focused, then edits
// freely; Enter / blur commits a finite number, Escape reverts.
function DockNumberField({
  label,
  value,
  digits,
  suffix,
  onCommit,
}: {
  label: string;
  value: number;
  digits: number;
  suffix?: string;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value.toFixed(digits);
  const commit = () => {
    if (draft === null) return;
    const v = parseFloat(draft);
    setDraft(null);
    if (Number.isFinite(v) && v.toFixed(digits) !== value.toFixed(digits)) {
      onCommit(v);
    }
  };
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 3,
        fontSize: 10,
        color: "var(--tb-n-13)",
      }}
    >
      {label}
      <input
        value={shown}
        onFocus={(e) => {
          setDraft(value.toFixed(digits));
          e.currentTarget.select();
        }}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
        style={{
          width: 42,
          height: 20,
          boxSizing: "border-box",
          padding: "0 4px",
          fontSize: 11,
          fontFamily: "var(--ui-font)",
          fontVariantNumeric: "tabular-nums",
          // Same tokens as the resolution fields (res-controls.tsx).
          color: "var(--tb-n-16)",
          background: "var(--tb-n-0)",
          border: "1px solid var(--tb-n-7)",
          borderRadius: 4,
          outline: "none",
        }}
      />
      {suffix && <span>{suffix}</span>}
    </label>
  );
}

// Top-right shelf while a marquee tool is active: the combine mode for an
// unmodified drag (Shift / Alt / Shift+Alt at press override it, as in
// Photoshop) and the whole-selection actions.
export function PaintSelectionShelf({
  right,
  top,
  mode,
  onModeChange,
  hasSelection,
  onSelectAll,
  onDeselect,
  onInvert,
  onSelectPainted,
  modifyPx,
  onModifyPxChange,
  onModify,
  wand,
}: {
  right: number;
  top: number;
  mode: SelectionMode;
  onModeChange: (m: SelectionMode) => void;
  hasSelection: boolean;
  onSelectAll: () => void;
  onDeselect: () => void;
  onInvert: () => void;
  onSelectPainted: () => void;
  modifyPx: number;
  onModifyPxChange: (px: number) => void;
  onModify: (op: "feather" | "expand" | "contract") => void;
  // Magic wand settings row (wand tool only).
  wand: {
    tolerance: number;
    contiguous: boolean;
    antiAlias: boolean;
    onTolerance: (v: number) => void;
    onContiguous: (v: boolean) => void;
    onAntiAlias: (v: boolean) => void;
  } | null;
}) {
  const modes: { id: SelectionMode; label: string; icon: ReactElement }[] = [
    { id: "new", label: "New selection", icon: <SelNewIcon /> },
    { id: "add", label: "Add to selection (Shift)", icon: <SelAddIcon /> },
    {
      id: "subtract",
      label: "Subtract from selection (Alt)",
      icon: <SelSubtractIcon />,
    },
    {
      id: "intersect",
      label: "Intersect with selection (Shift+Alt)",
      icon: <SelIntersectIcon />,
    },
  ];
  return (
    <>
    <DockShell right={right} top={top} row>
      {modes.map((m) => (
        <IconToggle
          key={m.id}
          active={mode === m.id}
          label={m.label}
          onClick={() => onModeChange(m.id)}
        >
          {m.icon}
        </IconToggle>
      ))}
      <DockDivider vertical />
      <IconToggle active={false} label="Select all (Cmd+A)" onClick={onSelectAll}>
        <SelAllIcon />
      </IconToggle>
      {hasSelection && (
        <>
          <IconToggle
            active={false}
            label="Deselect (Cmd+D)"
            onClick={onDeselect}
          >
            <SelNoneIcon />
          </IconToggle>
          <IconToggle
            active={false}
            label="Select inverse (Cmd+Shift+I)"
            onClick={onInvert}
          >
            <SelInvertIcon />
          </IconToggle>
        </>
      )}
      <IconToggle
        active={false}
        label="Select painted pixels (the layer's alpha)"
        onClick={onSelectPainted}
      >
        <SelPaintedIcon />
      </IconToggle>
    </DockShell>
    {/* Modify: grow / shrink / soften the selection's edge by N px. */}
    {hasSelection && (
      <DockShell right={right} top={top + SHELF_ROW} row>
        <DockNumberField
          label="Modify"
          value={modifyPx}
          digits={0}
          suffix="px"
          onCommit={(v) => onModifyPxChange(Math.max(1, Math.min(500, Math.round(v))))}
        />
        <DockTextButton label="Feather" onClick={() => onModify("feather")} />
        <DockTextButton label="Expand" onClick={() => onModify("expand")} />
        <DockTextButton label="Contract" onClick={() => onModify("contract")} />
      </DockShell>
    )}
    {wand && (
      <DockShell
        right={right}
        top={top + SHELF_ROW * (hasSelection ? 2 : 1)}
        row
      >
        <DockHSlider
          label="Tolerance"
          value={wand.tolerance}
          min={0}
          max={1}
          step={0.01}
          width={64}
          format={(v) => `${Math.round(v * 255)}`}
          onChange={(v) => wand.onTolerance(Math.round(v * 100) / 100)}
        />
        <DockTextButton
          label="Contiguous"
          active={wand.contiguous}
          onClick={() => wand.onContiguous(!wand.contiguous)}
        />
        <DockTextButton
          label="Anti-alias"
          active={wand.antiAlias}
          onClick={() => wand.onAntiAlias(!wand.antiAlias)}
        />
      </DockShell>
    )}
    </>
  );
}

// Vertical spacing between stacked shelf rows.
const SHELF_ROW = 40;

// A small text button for shelf actions / toggles (`active` = pressed).
function DockTextButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      style={{
        height: 22,
        padding: "0 7px",
        fontSize: 11,
        fontFamily: "var(--ui-font)",
        color: active ? "var(--tb-n-17)" : "var(--tb-n-13)",
        background: active ? DOCK_ACTIVE_FILL : "transparent",
        border: `1px solid ${active ? DOCK_ACTIVE_STROKE : "var(--tb-n-7)"}`,
        borderRadius: 4,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

// Inline icons, matching the spline dock's 14px stroke style.

const DASH = "2 1.6";

function LassoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M8 3c3.6 0 6 1.6 6 3.6S11.6 10 8.4 10C5 10 2.5 8.6 2.5 6.6 2.5 4.6 4.8 3 8 3zM4.6 9.4c-.6 1-.4 2.2.6 2.8.9.6.8 1.6-.2 2.3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeDasharray={DASH}
      />
    </svg>
  );
}

function PolyLassoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M3 4.5 9.5 2l4 4.5-3 5.5-6-1.5z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
        strokeDasharray={DASH}
      />
    </svg>
  );
}

function WandIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M2.5 13.5l7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path
        d="M11.5 1.5v2.5M11.5 6.5V9M8 5h2.5M12.5 5H15M9.4 2.9l1.2 1.2M13.6 2.9l-1.2 1.2"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SelPaintedIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M3 11c1.5-4 3.5-6 6-6.5 2-.4 3.5.6 3.5 2.2 0 2.6-3.5 3.4-5.5 5.3"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <rect x="1.5" y="1.5" width="13" height="13" stroke="currentColor" strokeWidth="1" strokeDasharray={DASH} />
    </svg>
  );
}

// Move — four-way arrows.
function MoveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M8 1.5v13M1.5 8h13M8 1.5 6.2 3.3M8 1.5l1.8 1.8M8 14.5l-1.8-1.8M8 14.5l1.8-1.8M1.5 8l1.8-1.8M1.5 8l1.8 1.8M14.5 8l-1.8-1.8M14.5 8l-1.8 1.8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FlipHIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M8 2v12" stroke="currentColor" strokeWidth="1.1" strokeDasharray="1.6 1.6" />
      <path d="M6 4 2 12h4zM10 4l4 8h-4z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function FlipVIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M2 8h12" stroke="currentColor" strokeWidth="1.1" strokeDasharray="1.6 1.6" />
      <path d="M4 6 12 2v4zM4 10l8 4v-4z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M3 8.5l3.2 3L13 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function MarqueeRectIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect
        x="2.5"
        y="3.5"
        width="11"
        height="9"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeDasharray={DASH}
      />
    </svg>
  );
}

function MarqueeEllipseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <ellipse
        cx="8"
        cy="8"
        rx="5.5"
        ry="4.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeDasharray={DASH}
      />
    </svg>
  );
}

// Combine-mode glyphs: two overlapping squares, the result filled.
function SelNewIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="3" y="3" width="10" height="10" rx="1" fill="currentColor" opacity="0.85" />
    </svg>
  );
}

function SelAddIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M2 2h7v3h5v9H7v-3H2z" fill="currentColor" opacity="0.85" />
    </svg>
  );
}

function SelSubtractIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M2 2h7v3H5v4H2z" fill="currentColor" opacity="0.85" />
      <rect x="5.5" y="5.5" width="8" height="8" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function SelIntersectIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="2.5" y="2.5" width="8" height="8" stroke="currentColor" strokeWidth="1" />
      <rect x="5.5" y="5.5" width="8" height="8" stroke="currentColor" strokeWidth="1" />
      <rect x="5.5" y="5.5" width="5" height="5" fill="currentColor" opacity="0.85" />
    </svg>
  );
}

function SelAllIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="2.5" y="2.5" width="11" height="11" stroke="currentColor" strokeWidth="1.3" strokeDasharray={DASH} />
      <rect x="5" y="5" width="6" height="6" fill="currentColor" opacity="0.85" />
    </svg>
  );
}

function SelNoneIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="2.5" y="2.5" width="11" height="11" stroke="currentColor" strokeWidth="1.3" strokeDasharray={DASH} />
      <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function SelInvertIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="2" width="12" height="12" fill="currentColor" opacity="0.85" />
      <rect x="5" y="5" width="6" height="6" fill="var(--tb-n-0)" stroke="currentColor" strokeWidth="1" strokeDasharray={DASH} />
    </svg>
  );
}

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

function FlattenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M8 2.5 2.5 5.25 8 8l5.5-2.75L8 2.5ZM2.5 8.75 8 11.5l5.5-2.75M2.5 11.5 8 14.25l5.5-2.75"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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
