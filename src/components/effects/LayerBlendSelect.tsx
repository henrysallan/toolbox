"use client";

import { useRef, type ReactNode } from "react";
import { BLEND_MODE_ORDER, blendModeLabel } from "@/nodes/effect/merge";

// Compact native <select>s for the Layers editor row and the Layer node's
// bottom edge (specdocs/101526_layer-transforms-parenting.md §6–§7).
// Native, so the option list is OS-drawn and works in a popped-out panel
// window with no portal. Always drawn as a control (fill + border) so it
// reads at a glance; hover brightens the border, focus turns it blue.
//
// Pointer / mouse / double-click are stopped: inside a React Flow node that
// keeps a tap from dragging the node (with `nodrag`), and in the Layers
// editor it keeps the row's select / reorder / dive gestures from starting.
const REST_BG = "var(--tb-n-3)";
const REST_BORDER = "var(--tb-n-7)";
const HOVER_BORDER = "var(--tb-n-10)";

export function QuietSelect({
  value,
  onChange,
  width,
  title,
  dim = false,
  onPointerDown,
  onKeyDown,
  onMouseEnter,
  onMouseLeave,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  width: number;
  title: string;
  // Muted text for the "nothing set" value (normal blend, no parent).
  dim?: boolean;
  onPointerDown?: (e: React.PointerEvent<HTMLSelectElement>) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLSelectElement>) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  children: ReactNode;
}) {
  return (
    <select
      className="nodrag nopan"
      value={value}
      title={title}
      onPointerDown={(e) => {
        e.stopPropagation();
        onPointerDown?.(e);
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width,
        flexShrink: 0,
        height: 18,
        fontSize: 10,
        fontFamily: "var(--ui-font)",
        color: dim ? "var(--tb-n-12)" : "var(--tb-n-16)",
        background: REST_BG,
        border: `1px solid ${REST_BORDER}`,
        borderRadius: 4,
        padding: "0 2px",
        cursor: "pointer",
        outline: "none",
      }}
      onMouseEnter={(e) => {
        if (e.currentTarget.ownerDocument.activeElement !== e.currentTarget) {
          e.currentTarget.style.borderColor = HOVER_BORDER;
        }
        onMouseEnter?.();
      }}
      onMouseLeave={(e) => {
        onMouseLeave?.();
        if (e.currentTarget.ownerDocument.activeElement === e.currentTarget) return;
        e.currentTarget.style.borderColor = REST_BORDER;
      }}
      onFocus={(e) => {
        e.currentTarget.style.borderColor = "var(--tb-a-blue-400)";
      }}
      onBlur={(e) => {
        e.currentTarget.style.borderColor = REST_BORDER;
      }}
    >
      {children}
    </select>
  );
}

// A layer's blend mode. `mix` (legacy alias of normal) is offered only to a
// layer already using it, matching the param panel's intent that it stay
// load-only.
export default function LayerBlendSelect({
  value,
  onChange,
  width = 88,
}: {
  value: string;
  onChange: (mode: string) => void;
  width?: number;
}) {
  const modes = BLEND_MODE_ORDER.filter((m) => m !== "mix" || value === "mix");
  return (
    <QuietSelect
      value={value}
      onChange={onChange}
      width={width}
      title={`Blend mode: ${blendModeLabel(value)}`}
      dim={value === "normal"}
    >
      {modes.map((m) => (
        <option key={m} value={m}>
          {blendModeLabel(m)}
        </option>
      ))}
    </QuietSelect>
  );
}

export interface ParentOption {
  id: string;
  label: string;
  // A layer that would close a loop (itself, or one of its descendants).
  disabled?: boolean;
}

const NONE = "";
const EXTERNAL = "__external__";

// A layer's parent (§7). "None" or another layer; loop-closing layers are
// disabled. A hand-wired non-layer parent shows read-only as ⟨name⟩ — pick
// None to clear it. Alt held while opening the menu = AE's Alt-parent: the
// child jumps instead of holding its place (`keepInPlace` false).
export function LayerParentSelect({
  value,
  external,
  options,
  onChange,
  onHoverParent,
  width = 88,
}: {
  value: string | null;
  // Display name of a non-layer parent, when that's what's wired.
  external?: string | null;
  options: readonly ParentOption[];
  onChange: (parentId: string | null, keepInPlace: boolean) => void;
  // The parent row to highlight while the control is hovered.
  onHoverParent?: (parentId: string | null) => void;
  width?: number;
}) {
  // Alt arrives on the pointerdown that opens the OS menu; the change event
  // that follows carries no modifiers. A ref: the hover highlight
  // re-renders between opening and picking.
  const altAtOpen = useRef(false);
  const current = external ? EXTERNAL : (value ?? NONE);
  const name = external ?? options.find((o) => o.id === value)?.label ?? "None";
  return (
    <QuietSelect
      value={current}
      width={width}
      title={`Parent: ${name}${external ? " (wired in the node editor)" : ""} · Alt-pick to jump instead of holding position`}
      dim={current === NONE}
      onPointerDown={(e) => {
        altAtOpen.current = e.altKey;
      }}
      // A keyboard pick (focus + arrows) takes Alt from that key press.
      onKeyDown={(e) => {
        altAtOpen.current = e.altKey;
      }}
      onMouseEnter={() => onHoverParent?.(external ? null : value)}
      onMouseLeave={() => onHoverParent?.(null)}
      onChange={(v) => {
        if (v === EXTERNAL) return;
        onChange(v === NONE ? null : v, !altAtOpen.current);
      }}
    >
      <option value={NONE}>None</option>
      {external && (
        <option value={EXTERNAL} disabled>
          {`⟨${external}⟩`}
        </option>
      )}
      {options.map((o) => (
        <option key={o.id} value={o.id} disabled={o.disabled}>
          {o.disabled ? `${o.label} (loop)` : o.label}
        </option>
      ))}
    </QuietSelect>
  );
}
