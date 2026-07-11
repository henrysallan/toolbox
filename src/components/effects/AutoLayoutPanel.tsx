"use client";

import { useEffect, useRef, useState } from "react";
import type { Node } from "@xyflow/react";
import type { NodeDataPayload } from "@/state/graph";
import type { AutoLayoutItem, SizeMode } from "@/engine/types";
import { defaultAutoLayoutItem } from "@/nodes/effect/autolayout";
import {
  diamondStateFor,
  findKeyframeAt,
  removeKeyframeAt,
  upsertKeyframe,
  type KeyframeAnimationBlock,
} from "@/engine/keyframes";
import KeyframeDiamond from "./KeyframeDiamond";
import { ColorSwatchPicker } from "@/lib/color-picker-popover";

// Figma-style parameters panel for the Auto Layout node: an icon direction
// toggle, a 3×3 alignment grid, inline W/H sizing, gap + spacing, padding,
// fill, the per-item sizing list, and a collapsible canvas-placement block.
// All values write straight to the node's params; keyframable scalars keep
// their diamond so gap / padding / size still animate.

interface Props {
  node: Node<NodeDataPayload>;
  onParamChange: (nodeId: string, paramName: string, value: unknown) => void;
  currentTick?: number;
  getAnimation?: (
    nodeId: string,
    paramName: string
  ) => KeyframeAnimationBlock | undefined;
  onAnimationChange?: (
    nodeId: string,
    paramName: string,
    next: KeyframeAnimationBlock | undefined
  ) => void;
  onSeekTick?: (tick: number) => void;
}

const ACCENT = "#3b82f6";
const PANEL_BG = "#18181b";
const FIELD_BG = "#0f0f12";
const BORDER = "#2a2a30";
const TEXT = "#d4d4d8";
const MUTED = "#8a8a93";

// 3×3 alignment grid → param value. Row/col map to the 9 LAYOUT_ALIGN
// options; the center is the bare "center" string.
const V_NAMES = ["top", "center", "bottom"] as const;
const H_NAMES = ["left", "center", "right"] as const;
function alignAt(row: number, col: number): string {
  const v = V_NAMES[row];
  const h = H_NAMES[col];
  if (v === "center" && h === "center") return "center";
  return `${v}-${h}`;
}
function alignRowCol(align: string): [number, number] {
  if (align === "center") return [1, 1];
  const [v, h] = align.split("-");
  const row = V_NAMES.indexOf(v as (typeof V_NAMES)[number]);
  const col = H_NAMES.indexOf(h as (typeof H_NAMES)[number]);
  return [row < 0 ? 1 : row, col < 0 ? 1 : col];
}

// ---------------------------------------------------------------------

// Scrubbable number field: drag horizontally to change the value (the
// scalar-slider convention used across the app), click to type, arrows to
// step. Scrub emits are rAF-coalesced so a fast drag doesn't re-eval the
// graph per pointer event.
const SCRUB_PX = 3;
function NumInput({
  value,
  onChange,
  disabled,
  min = 0,
  max,
  step = 1,
  width = "100%",
}: {
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  min?: number;
  max?: number;
  step?: number;
  width?: number | string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const scrub = useRef<{ startX: number; startVal: number; moved: boolean } | null>(
    null
  );
  const raf = useRef<number | null>(null);
  const pending = useRef<number | null>(null);
  // Keep the latest value/onChange reachable from the pointer handlers
  // (synced after commit, not during render).
  useEffect(() => {
    valueRef.current = value;
    onChangeRef.current = onChange;
  });
  useEffect(
    () => () => {
      if (raf.current != null) cancelAnimationFrame(raf.current);
    },
    []
  );

  const clamp = (v: number) => {
    let r = v;
    if (typeof min === "number") r = Math.max(min, r);
    if (typeof max === "number") r = Math.min(max, r);
    return r;
  };
  const emit = (v: number) => {
    const r = round(v);
    if (r !== valueRef.current) onChangeRef.current(r);
  };
  const flush = () => {
    raf.current = null;
    if (pending.current != null) {
      emit(pending.current);
      pending.current = null;
    }
  };
  const queue = (v: number) => {
    pending.current = v;
    if (raf.current == null) raf.current = requestAnimationFrame(flush);
  };

  const beginEdit = () => {
    setDraft(String(round(valueRef.current)));
    setEditing(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  };
  const commit = (raw: string) => {
    setEditing(false);
    const n = parseFloat(raw.trim());
    if (Number.isFinite(n)) emit(clamp(n));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLInputElement>) => {
    if (editing || disabled || e.button !== 0) return;
    e.preventDefault(); // decide click-vs-scrub on release
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture unsupported — events still fire */
    }
    scrub.current = { startX: e.clientX, startVal: valueRef.current, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLInputElement>) => {
    const s = scrub.current;
    if (!s) return;
    const dx = e.clientX - s.startX;
    if (!s.moved && Math.abs(dx) < SCRUB_PX) return;
    s.moved = true;
    // With a finite range, cross it in ~250px; otherwise scale per-pixel
    // sensitivity to the value's magnitude so big unit values move fast and
    // small ones stay fine. Shift = precision.
    const span = typeof max === "number" && max > min ? max - min : null;
    const base =
      span != null ? span / 250 : Math.max(step, (Math.abs(s.startVal) || 50) / 100);
    const perPx = base * (e.shiftKey ? 0.2 : 1);
    queue(clamp(s.startVal + dx * perPx));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLInputElement>) => {
    const s = scrub.current;
    scrub.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (s && !s.moved && !disabled) beginEdit(); // clean click → type
  };

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="decimal"
      value={editing ? draft : Number.isFinite(value) ? String(round(value)) : ""}
      disabled={disabled}
      title={disabled ? undefined : "Drag to scrub · click to type"}
      onChange={(e) => editing && setDraft(e.target.value)}
      onMouseDown={(e) => {
        if (!editing) e.preventDefault(); // suppress focus until release
      }}
      onFocus={() => {
        if (!editing && !disabled) beginEdit();
      }}
      onBlur={(e) => editing && commit(e.target.value)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        else if (e.key === "Escape") {
          setEditing(false);
          (e.target as HTMLInputElement).blur();
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const d = (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : step);
          emit(clamp((valueRef.current || 0) + d));
        }
      }}
      style={{
        width,
        background: FIELD_BG,
        border: `1px solid ${BORDER}`,
        borderRadius: 6,
        color: disabled ? MUTED : TEXT,
        fontFamily: "ui-monospace, monospace",
        fontSize: 11,
        padding: "5px 7px",
        boxSizing: "border-box",
        outline: "none",
        cursor: disabled ? "default" : editing ? "text" : "ew-resize",
      }}
    />
  );
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// NumInput for the gap/padding column. Flexes but caps its width so the
// field stays compact (the keyframe + toggle sit right after it rather
// than being pushed to the far edge of a full-width box).
function FlexNum(props: {
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <div style={{ flex: 1, minWidth: 40, maxWidth: 96 }}>
      <NumInput {...props} width="100%" />
    </div>
  );
}

function ColorSwatch({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <ColorSwatchPicker
      value={value}
      onChange={onChange}
      swatchStyle={{
        width: 28,
        height: 24,
        border: `1px solid ${BORDER}`,
        borderRadius: 6,
      }}
    />
  );
}

// Prev/next keyframe chevron — jumps the playhead to the neighbouring key.
// Same glyph + behaviour as the scalar-row carets in ParamPanel.
function Caret({
  dir,
  disabled,
  onClick,
}: {
  dir: "prev" | "next";
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={disabled ? "No keyframe that way" : "Jump to keyframe"}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onClick();
      }}
      style={{
        background: "transparent",
        border: "none",
        padding: 0,
        margin: 0,
        width: 11,
        height: 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.25 : 0.7,
        lineHeight: 0,
        color: "#a1a1aa",
      }}
    >
      <svg width="7" height="10" viewBox="0 0 7 10" fill="none">
        <path
          d={dir === "prev" ? "M5 1 L1 5 L5 9" : "M2 1 L6 5 L2 9"}
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

// Keyframe control bound to a node param: ‹ ◆ › — prev caret, diamond, next
// caret. First diamond click starts an animated block at the current value;
// thereafter it toggles a key at the playhead. Carets seek to neighbours.
function KeyframeControl({
  node,
  name,
  value,
  currentTick,
  getAnimation,
  onAnimationChange,
  onSeekTick,
}: {
  node: Node<NodeDataPayload>;
  name: string;
  value: number;
} & Pick<
  Props,
  "currentTick" | "getAnimation" | "onAnimationChange" | "onSeekTick"
>) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && menuRef.current?.contains(t)) return;
      setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  if (!getAnimation || !onAnimationChange) return null;
  const tick = currentTick ?? 0;
  const block = getAnimation(node.id, name);
  const animated = !!block?.animated;
  const ticks = block?.keyframes?.map((k) => k.tick) ?? [];
  const prev = ticks
    .filter((t) => t < tick)
    .reduce<number | null>((m, t) => (m === null || t > m ? t : m), null);
  const next = ticks
    .filter((t) => t > tick)
    .reduce<number | null>((m, t) => (m === null || t < m ? t : m), null);

  // Right-click menu — mirrors the scalar-row diamond: toggle the whole
  // animation off (keeps keys, stops animating) or clear every keyframe.
  const disableEnable = () => {
    if (!block) {
      onAnimationChange(node.id, name, {
        animated: true,
        trackVisible: true,
        keyframes: [],
      });
    } else {
      onAnimationChange(node.id, name, { ...block, animated: !block.animated });
    }
    setMenuOpen(false);
  };
  const removeAll = () => {
    onAnimationChange(node.id, name, undefined);
    setMenuOpen(false);
  };

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 1, flexShrink: 0 }}>
      {onSeekTick && (
        <Caret
          dir="prev"
          disabled={prev === null}
          onClick={() => prev !== null && onSeekTick(prev)}
        />
      )}
      <div style={{ position: "relative", display: "inline-flex" }}>
        <KeyframeDiamond
          state={diamondStateFor(block, tick)}
          title={`Keyframe ${name} · right-click for options`}
          onClick={() => {
            if (!block || !block.animated) {
              onAnimationChange(node.id, name, {
                animated: true,
                trackVisible: true,
                keyframes: [{ tick, value, easingOut: "easeInOut" }],
              });
            } else if (findKeyframeAt(block, tick)) {
              onAnimationChange(node.id, name, removeKeyframeAt(block, tick));
            } else {
              onAnimationChange(
                node.id,
                name,
                upsertKeyframe(block, tick, value, "easeInOut")
              );
            }
          }}
          onContextMenu={() => setMenuOpen((v) => !v)}
        />
        {menuOpen && (
          <div
            ref={menuRef}
            style={{
              position: "absolute",
              top: "100%",
              right: 0,
              marginTop: 4,
              background: "#111113",
              border: "1px solid #1f1f23",
              borderRadius: 4,
              padding: 4,
              zIndex: 1000,
              display: "flex",
              flexDirection: "column",
              minWidth: 150,
              boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
            }}
          >
            <button onClick={disableEnable} style={menuItemStyle()}>
              {animated ? "Disable animation" : "Enable animation"}
            </button>
            <button
              onClick={removeAll}
              style={menuItemStyle(false, !block)}
              disabled={!block}
            >
              Remove keyframes
            </button>
          </div>
        )}
      </div>
      {onSeekTick && (
        <Caret
          dir="next"
          disabled={next === null}
          onClick={() => next !== null && onSeekTick(next)}
        />
      )}
    </div>
  );
}

function menuItemStyle(active?: boolean, disabled?: boolean): React.CSSProperties {
  return {
    background: active ? "#1f2937" : "transparent",
    border: "none",
    color: disabled ? "#3f3f46" : active ? "#93c5fd" : "#d4d4d8",
    fontFamily: "inherit",
    fontSize: 11,
    textAlign: "left",
    padding: "6px 8px",
    borderRadius: 3,
    cursor: disabled ? "default" : "pointer",
    whiteSpace: "nowrap",
  };
}

// Two-state sliding pill (hug / fixed). The active segment's highlight
// slides between equal-width halves.
function PillToggle({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const segPct = 100 / options.length;
  // The hover ghost sits under the hovered segment (falls back to the
  // active one so it slides smoothly between positions); it only shows
  // when hovering a non-active segment.
  const ghostIdx = hoverIdx ?? idx;
  return (
    <div
      onMouseLeave={() => setHoverIdx(null)}
      style={{
        position: "relative",
        display: "flex",
        width: "100%",
        background: FIELD_BG,
        border: `1px solid ${BORDER}`,
        borderRadius: 999,
        padding: 2,
      }}
    >
      {/* Active highlight */}
      <div
        style={{
          position: "absolute",
          top: 2,
          bottom: 2,
          left: `calc(${idx * segPct}% + 2px)`,
          width: `calc(${segPct}% - 4px)`,
          background: "#3f3f46",
          borderRadius: 999,
          transition: "left 0.14s ease",
        }}
      />
      {/* Hover ghost — low-opacity pill that slides to the hovered option */}
      <div
        style={{
          position: "absolute",
          top: 2,
          bottom: 2,
          left: `calc(${ghostIdx * segPct}% + 2px)`,
          width: `calc(${segPct}% - 4px)`,
          background: "rgba(255,255,255,0.08)",
          borderRadius: 999,
          opacity: hoverIdx !== null && hoverIdx !== idx ? 1 : 0,
          transition: "left 0.12s ease, opacity 0.12s ease",
          pointerEvents: "none",
        }}
      />
      {options.map((o, i) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            onMouseEnter={() => setHoverIdx(i)}
            style={{
              position: "relative",
              zIndex: 1,
              flex: 1,
              minWidth: 0,
              padding: "3px 4px",
              border: "none",
              background: "transparent",
              color: active ? "#fff" : hoverIdx === i ? "#d4d4d8" : MUTED,
              fontSize: 10,
              cursor: "pointer",
              fontFamily: "inherit",
              textTransform: "capitalize",
              whiteSpace: "nowrap",
              transition: "color 0.12s ease",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// Left-aligned labelled row: [icon + label (fixed col)] [children…]. The
// fixed label column keeps every field's left edge aligned down the panel;
// narrow it (labelWidth) for short single-letter labels like W/H so the
// value field sits right next to them.
function Row({
  label,
  icon,
  labelWidth = 44,
  gap = 8,
  children,
}: {
  label?: string;
  icon?: React.ReactNode;
  labelWidth?: number;
  gap?: number;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap }}>
      <span
        style={{
          color: MUTED,
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: labelWidth,
          flexShrink: 0,
        }}
      >
        {icon}
        {label}
      </span>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------

export default function AutoLayoutPanel({
  node,
  onParamChange,
  currentTick,
  getAnimation,
  onAnimationChange,
  onSeekTick,
}: Props) {
  const p = node.data.params as Record<string, unknown>;
  const num = (name: string, def: number): number =>
    typeof p[name] === "number" ? (p[name] as number) : def;
  const str = (name: string, def: string): string =>
    typeof p[name] === "string" ? (p[name] as string) : def;
  const bool = (name: string): boolean => p[name] === true;
  const set = (name: string, v: unknown) => onParamChange(node.id, name, v);

  const [showTransform, setShowTransform] = useState(false);
  // Drag-to-reorder state for the items list. dragIdx = the row being
  // dragged; overIdx = the row it's hovering. Dropping reorders the items
  // param — and because the node's `item:<id>` input sockets are keyed by
  // id (resolveInputs maps items in order), the sockets reorder with them
  // and every connected wire follows its id automatically.
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  const direction = str("direction", "horizontal");
  const horizontal = direction === "horizontal";
  const align = str("align", "center");
  const [aRow, aCol] = alignRowCol(align);
  const spacing = str("spacing", "packed");
  const spaceBetween = spacing === "space-between";
  const widthMode = str("widthMode", "hug");
  const heightMode = str("heightMode", "hug");
  const bgEnabled = bool("bgEnabled");
  const strokeEnabled = bool("strokeEnabled");
  const items = Array.isArray(p.items) ? (p.items as AutoLayoutItem[]) : [];

  const kf = (name: string, value: number) => (
    <KeyframeControl
      node={node}
      name={name}
      value={value}
      currentTick={currentTick}
      getAnimation={getAnimation}
      onAnimationChange={onAnimationChange}
      onSeekTick={onSeekTick}
    />
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 14,
        color: TEXT,
        fontFamily: "ui-monospace, monospace",
        fontSize: 11,
      }}
    >
      {/* ---- Layout block ---- */}
      <Block>
        {/* W / H sizing — label left · narrow value · keyframe ·
            hug/fixed pill. The direction toggle rides the W row, pushed
            to the right edge. */}
        <Row label="W" labelWidth={14}>
          <NumInput
            value={num("width", 600)}
            onChange={(v) => set("width", v)}
            disabled={widthMode !== "fixed"}
            min={1}
            width={56}
          />
          {widthMode === "fixed" && kf("width", num("width", 600))}
          <div style={{ width: 116 }}>
            <PillToggle
              value={widthMode}
              options={[
                { value: "hug", label: "Hug" },
                { value: "fixed", label: "Fixed" },
              ]}
              onChange={(m) => set("widthMode", m)}
            />
          </div>
          <div style={{ marginLeft: "auto" }}>
            <Segment
              options={[
                { value: "horizontal", icon: <DirIcon horizontal /> },
                { value: "vertical", icon: <DirIcon horizontal={false} /> },
              ]}
              value={direction}
              onChange={(v) => set("direction", v)}
            />
          </div>
        </Row>
        <Row label="H" labelWidth={14}>
          <NumInput
            value={num("height", 600)}
            onChange={(v) => set("height", v)}
            disabled={heightMode !== "fixed"}
            min={1}
            width={56}
          />
          {heightMode === "fixed" && kf("height", num("height", 600))}
          <div style={{ width: 116 }}>
            <PillToggle
              value={heightMode}
              options={[
                { value: "hug", label: "Hug" },
                { value: "fixed", label: "Fixed" },
              ]}
              onChange={(m) => set("heightMode", m)}
            />
          </div>
        </Row>

        {/* Alignment grid + gap/padding, side by side */}
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <AlignGrid
            row={aRow}
            col={aCol}
            horizontal={horizontal}
            distribute={spaceBetween}
            onPick={(r, c) => set("align", alignAt(r, c))}
          />
          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              gap: 10,
              justifyContent: "center",
              alignSelf: "stretch",
            }}
          >
            <Row label="Gap" icon={<GapIcon />}>
              <FlexNum
                value={num("gap", 20)}
                onChange={(v) => set("gap", v)}
                disabled={spaceBetween}
              />
              {!spaceBetween && kf("gap", num("gap", 20))}
              <IconButton
                active={spaceBetween}
                title="Space between (distribute items)"
                onClick={() =>
                  set("spacing", spaceBetween ? "packed" : "space-between")
                }
              >
                <SpaceBetweenIcon />
              </IconButton>
            </Row>
            <Row label="X" icon={<PadHIcon />}>
              <FlexNum value={num("paddingX", 20)} onChange={(v) => set("paddingX", v)} />
              {kf("paddingX", num("paddingX", 20))}
            </Row>
            <Row label="Y" icon={<PadVIcon />}>
              <FlexNum value={num("paddingY", 20)} onChange={(v) => set("paddingY", v)} />
              {kf("paddingY", num("paddingY", 20))}
            </Row>
          </div>
        </div>
      </Block>

      {/* ---- Fill block ---- */}
      <Block>
        <FieldRow label="Background">
          <span
            role="switch"
            aria-checked={bgEnabled}
            onClick={() => set("bgEnabled", !bgEnabled)}
            style={{ display: "inline-flex", cursor: "pointer" }}
          >
            <Switch checked={bgEnabled} />
          </span>
        </FieldRow>
        {bgEnabled && (
          <FieldRow label="Fill" grow>
            <ColorSwatch
              value={str("bgColor", "#18181b")}
              onChange={(v) => set("bgColor", v)}
            />
          </FieldRow>
        )}

        <FieldRow label="Stroke">
          <span
            role="switch"
            aria-checked={strokeEnabled}
            onClick={() => set("strokeEnabled", !strokeEnabled)}
            style={{ display: "inline-flex", cursor: "pointer" }}
          >
            <Switch checked={strokeEnabled} />
          </span>
        </FieldRow>
        {strokeEnabled && (
          <>
            <FieldRow label="Color" grow>
              <ColorSwatch
                value={str("strokeColor", "#ffffff")}
                onChange={(v) => set("strokeColor", v)}
              />
            </FieldRow>
            <FieldRow label="Width" grow>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <NumInput
                  value={num("strokeWidth", 4)}
                  onChange={(v) => set("strokeWidth", v)}
                  width={56}
                />
                {kf("strokeWidth", num("strokeWidth", 4))}
              </div>
            </FieldRow>
          </>
        )}

        {(bgEnabled || strokeEnabled) && (
          <FieldRow label="Radius" grow>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <NumInput
                value={num("cornerRadius", 0)}
                onChange={(v) => set("cornerRadius", v)}
                width={56}
              />
              {kf("cornerRadius", num("cornerRadius", 0))}
            </div>
          </FieldRow>
        )}
      </Block>

      {/* ---- Items block ---- */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <SectionLabel>
          <span>Items</span>
          <button
            onClick={() => set("items", [...items, defaultAutoLayoutItem()])}
            title="Add item slot"
            style={addBtnStyle}
          >
            + add
          </button>
        </SectionLabel>
        {items.length === 0 && (
          <div style={{ color: MUTED, fontStyle: "italic" }}>
            Wire elements into the node, or press “add”.
          </div>
        )}
        {items.map((it, i) => (
          <ItemRow
            key={it.id}
            index={i}
            item={it}
            onChange={(next) =>
              set(
                "items",
                items.map((x) => (x.id === it.id ? next : x))
              )
            }
            onRemove={() => set("items", items.filter((x) => x.id !== it.id))}
            dnd={{
              isOver: overIdx === i && dragIdx !== null && dragIdx !== i,
              dragging: dragIdx === i,
              onDragStart: () => setDragIdx(i),
              onDragOver: (e) => {
                e.preventDefault();
                if (overIdx !== i) setOverIdx(i);
              },
              onDrop: (e) => {
                e.preventDefault();
                const from = dragIdx;
                setDragIdx(null);
                setOverIdx(null);
                if (from === null || from === i) return;
                const next = items.slice();
                const [moved] = next.splice(from, 1);
                next.splice(i, 0, moved);
                set("items", next);
              },
              onDragEnd: () => {
                setDragIdx(null);
                setOverIdx(null);
              },
            }}
          />
        ))}
      </div>

      {/* ---- Canvas placement (collapsible) ---- */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <SectionLabel>
          <button
            onClick={() => setShowTransform((s) => !s)}
            style={{
              ...addBtnStyle,
              borderColor: "transparent",
              color: MUTED,
              padding: 0,
            }}
          >
            {showTransform ? "▾" : "▸"} Canvas placement
          </button>
        </SectionLabel>
        {showTransform && (
          <Block>
            <TwoUp>
              <Labeled label="X">
                <NumInput value={num("translateX", 0)} onChange={(v) => set("translateX", v)} min={-2} max={2} step={0.01} />
              </Labeled>
              {kf("translateX", num("translateX", 0))}
              <Labeled label="Y">
                <NumInput value={num("translateY", 0)} onChange={(v) => set("translateY", v)} min={-2} max={2} step={0.01} />
              </Labeled>
              {kf("translateY", num("translateY", 0))}
            </TwoUp>
            <TwoUp>
              <Labeled label="Scale X">
                <NumInput value={num("scaleX", 1)} onChange={(v) => set("scaleX", v)} min={0.01} max={10} step={0.01} />
              </Labeled>
              {kf("scaleX", num("scaleX", 1))}
              <Labeled label="Scale Y">
                <NumInput value={num("scaleY", 1)} onChange={(v) => set("scaleY", v)} min={0.01} max={10} step={0.01} />
              </Labeled>
              {kf("scaleY", num("scaleY", 1))}
            </TwoUp>
            <TwoUp>
              <Labeled label="Rotate">
                <NumInput value={num("rotate", 0)} onChange={(v) => set("rotate", v)} min={-360} max={360} step={0.5} />
              </Labeled>
              {kf("rotate", num("rotate", 0))}
              <Labeled label="Opacity">
                <NumInput value={num("opacity", 1)} onChange={(v) => set("opacity", v)} min={0} max={1} step={0.01} />
              </Labeled>
              {kf("opacity", num("opacity", 1))}
            </TwoUp>
          </Block>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Layout helpers

function Block({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        background: PANEL_BG,
        border: `1px solid ${BORDER}`,
        borderRadius: 8,
        padding: 10,
      }}
    >
      {children}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        color: MUTED,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        fontSize: 10,
      }}
    >
      {children}
    </div>
  );
}

function FieldRow({
  label,
  icon,
  grow,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  grow?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        flex: grow ? 1 : undefined,
      }}
    >
      <span
        style={{
          color: MUTED,
          display: "flex",
          alignItems: "center",
          gap: 6,
          minWidth: 0,
        }}
      >
        {icon}
        {label}
      </span>
      {children}
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1 }}>
      <span style={{ color: MUTED, fontSize: 10 }}>{label}</span>
      {children}
    </label>
  );
}

function TwoUp({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>{children}</div>
  );
}

interface ItemDnd {
  isOver: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}

function ItemRow({
  index,
  item,
  onChange,
  onRemove,
  dnd,
}: {
  index: number;
  item: AutoLayoutItem;
  onChange: (next: AutoLayoutItem) => void;
  onRemove: () => void;
  dnd?: ItemDnd;
}) {
  const axis = (
    which: "width" | "height",
    modeKey: "widthMode" | "heightMode"
  ) => (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flex: 1, minWidth: 0 }}>
      <span style={{ color: MUTED, width: 11, flexShrink: 0 }}>
        {which === "width" ? "W" : "H"}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <PillToggle
          value={item[modeKey]}
          options={[
            { value: "hug", label: "Hug" },
            { value: "fixed", label: "Fixed" },
            { value: "fill", label: "Fill" },
          ]}
          onChange={(v) => onChange({ ...item, [modeKey]: v as SizeMode })}
        />
      </div>
      {item[modeKey] === "fixed" && (
        <NumInput
          value={item[which]}
          onChange={(v) => onChange({ ...item, [which]: v })}
          min={0}
          width={42}
        />
      )}
    </div>
  );
  return (
    <div
      onDragOver={dnd?.onDragOver}
      onDrop={dnd?.onDrop}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: 8,
        background: PANEL_BG,
        border: `1px solid ${dnd?.isOver ? ACCENT : BORDER}`,
        borderRadius: 8,
        opacity: dnd?.dragging ? 0.4 : 1,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ color: MUTED, display: "flex", alignItems: "center", gap: 6 }}>
          {dnd && (
            <span
              draggable
              onDragStart={dnd.onDragStart}
              onDragEnd={dnd.onDragEnd}
              title="Drag to reorder"
              style={{ cursor: "grab", display: "inline-flex", color: MUTED }}
            >
              <GripIcon />
            </span>
          )}
          item {index + 1}
        </span>
        <button onClick={onRemove} title="Remove item" style={removeBtnStyle}>
          remove
        </button>
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        {axis("width", "widthMode")}
        {axis("height", "heightMode")}
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <PillToggle
            value={item.fit}
            options={[
              { value: "cover", label: "Cover" },
              { value: "contain", label: "Contain" },
              { value: "stretch", label: "Stretch" },
            ]}
            onChange={(v) => onChange({ ...item, fit: v as AutoLayoutItem["fit"] })}
          />
        </div>
        <div
          role="switch"
          aria-checked={item.trim}
          title="Trim to the alpha bounding box (image-backed elements)"
          onClick={() => onChange({ ...item, trim: !item.trim })}
          style={{
            display: "flex",
            gap: 6,
            alignItems: "center",
            color: MUTED,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <Switch checked={item.trim} />
          trim
        </div>
      </div>
    </div>
  );
}

// Toggle switch — a pill track with a sliding circular knob. Stands in
// for a checkbox (the "circle" the design calls for).
function Switch({ checked }: { checked: boolean }) {
  return (
    <span
      style={{
        position: "relative",
        display: "inline-block",
        width: 30,
        height: 18,
        borderRadius: 999,
        border: `1px solid ${checked ? ACCENT : BORDER}`,
        background: checked ? ACCENT : FIELD_BG,
        transition: "background 0.14s ease",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: checked ? 14 : 2,
          width: 12,
          height: 12,
          borderRadius: 999,
          background: "#fff",
          transition: "left 0.14s ease",
        }}
      />
    </span>
  );
}

// ---------------------------------------------------------------------
// Small controls + icons

function Segment({
  options,
  value,
  onChange,
}: {
  options: { value: string; icon: React.ReactNode }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 2,
        background: FIELD_BG,
        border: `1px solid ${BORDER}`,
        borderRadius: 6,
        padding: 2,
      }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            title={o.value}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 30,
              height: 22,
              borderRadius: 4,
              border: "none",
              cursor: "pointer",
              background: active ? "#3f3f46" : "transparent",
              color: active ? "#fff" : MUTED,
            }}
          >
            {o.icon}
          </button>
        );
      })}
    </div>
  );
}

function IconButton({
  active,
  title,
  onClick,
  children,
}: {
  active?: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 26,
        height: 24,
        borderRadius: 6,
        border: `1px solid ${active ? ACCENT : BORDER}`,
        background: active ? "rgba(59,130,246,0.18)" : FIELD_BG,
        color: active ? "#93c5fd" : MUTED,
        cursor: "pointer",
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}

// 3×3 alignment grid. The selected cell shows item-preview bars oriented by
// direction (and spread when distributing); the rest show faint dots.
function AlignGrid({
  row,
  col,
  horizontal,
  distribute,
  onPick,
}: {
  row: number;
  col: number;
  horizontal: boolean;
  distribute: boolean;
  onPick: (r: number, c: number) => void;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, 1fr)",
        gridTemplateRows: "repeat(3, 1fr)",
        gap: 2,
        width: 104,
        height: 104,
        background: FIELD_BG,
        border: `1px solid ${BORDER}`,
        borderRadius: 8,
        padding: 4,
        flexShrink: 0,
      }}
    >
      {Array.from({ length: 9 }, (_, idx) => {
        const r = Math.floor(idx / 3);
        const c = idx % 3;
        const selected = r === row && c === col;
        return (
          <button
            key={idx}
            onClick={() => onPick(r, c)}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
              background: selected ? "rgba(59,130,246,0.16)" : "transparent",
            }}
            onMouseEnter={(e) => {
              if (!selected) e.currentTarget.style.background = "#26262c";
            }}
            onMouseLeave={(e) => {
              if (!selected) e.currentTarget.style.background = "transparent";
            }}
          >
            {selected ? (
              <Bars horizontal={horizontal} distribute={distribute} />
            ) : (
              <span
                style={{
                  width: 3,
                  height: 3,
                  borderRadius: 3,
                  background: "#52525b",
                }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

// The item-preview marks inside the selected align cell.
function Bars({ horizontal, distribute }: { horizontal: boolean; distribute: boolean }) {
  const bar = horizontal
    ? { width: 2.5, height: 12, borderRadius: 2 }
    : { width: 12, height: 2.5, borderRadius: 2 };
  return (
    <div
      style={{
        display: "flex",
        flexDirection: horizontal ? "row" : "column",
        gap: distribute ? 4 : 2,
        alignItems: "center",
      }}
    >
      {[0, 1, 2].map((i) => (
        <span key={i} style={{ ...bar, background: ACCENT }} />
      ))}
    </div>
  );
}

function DirIcon({ horizontal }: { horizontal: boolean }) {
  // Three bars: side-by-side for horizontal flow, stacked for vertical.
  const bar = horizontal
    ? { width: 2.5, height: 11 }
    : { width: 11, height: 2.5 };
  return (
    <div
      style={{
        display: "flex",
        flexDirection: horizontal ? "row" : "column",
        gap: 2,
        alignItems: "center",
      }}
    >
      {[0, 1, 2].map((i) => (
        <span key={i} style={{ ...bar, background: "currentColor", borderRadius: 2 }} />
      ))}
    </div>
  );
}

function GripIcon() {
  // Six-dot drag grip.
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
      {[3, 7].map((cx) =>
        [3, 7, 11].map((cy) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={1.1} />
        ))
      )}
    </svg>
  );
}

function GapIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <rect x="1" y="2" width="3.5" height="9" rx="1" fill="currentColor" />
      <rect x="8.5" y="2" width="3.5" height="9" rx="1" fill="currentColor" />
      <path d="M6.5 4v5M5 6.5h3" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function PadHIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <rect x="1.5" y="1.5" width="10" height="10" rx="1.5" stroke="currentColor" />
      <rect x="3.5" y="3.5" width="6" height="6" rx="1" fill="currentColor" opacity="0.5" />
      <path d="M1.5 6.5h2M9.5 6.5h2" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function PadVIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <rect x="1.5" y="1.5" width="10" height="10" rx="1.5" stroke="currentColor" />
      <rect x="3.5" y="3.5" width="6" height="6" rx="1" fill="currentColor" opacity="0.5" />
      <path d="M6.5 1.5v2M6.5 9.5v2" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function SpaceBetweenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <rect x="1" y="3" width="2.5" height="8" rx="1" fill="currentColor" />
      <rect x="10.5" y="3" width="2.5" height="8" rx="1" fill="currentColor" />
      <path d="M5 7h4M5 7l1.2-1.2M5 7l1.2 1.2M9 7L7.8 5.8M9 7L7.8 8.2" stroke="currentColor" strokeWidth="0.9" />
    </svg>
  );
}

const addBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: `1px solid ${BORDER}`,
  color: MUTED,
  fontSize: 10,
  padding: "2px 8px",
  borderRadius: 6,
  cursor: "pointer",
  fontFamily: "inherit",
};

const removeBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #3f3f46",
  color: MUTED,
  fontSize: 10,
  padding: "1px 6px",
  borderRadius: 4,
  cursor: "pointer",
  fontFamily: "inherit",
};
