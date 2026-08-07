"use client";

// The app's universal numeric input: `NumberField` (type / drag-to-scrub /
// stepper) plus the `HslField` label+field pairing the color controls use.
//
// Why its own module rather than living in param-controls: the color picker
// (@/lib/color-picker-popover) needs these fields for its H/S/L/A row, and
// param-controls already imports ColorSwatchPicker from the picker — so
// importing back would cycle. Both sides import from here instead.
//
// Keep it free of editor-only deps: the export bundle resolves @/lib
// directly, and this is reached from the live viewer / exported apps.

import React, { useEffect, useRef, useState } from "react";
import { evalNumExpr } from "@/lib/num-expr";

// Decimal places a step implies, read off its decimal representation so
// fractional steps ≥ 1 keep their digits (0.01 → 2, 1.2 → 1, 2 → 0 — the
// old log10 form floored 1.2 to 0 and displayed 2.4 as "2"). Exponent
// notation (1e-7) has no "." to count; fall back to the log10 bound.
function stepDecimals(step: number): number {
  const s = String(step);
  if (s.includes("e") || s.includes("E"))
    return step < 1 ? Math.min(6, Math.ceil(-Math.log10(step))) : 0;
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : Math.min(6, s.length - dot - 1);
}

// Format a number for display, trimming float noise to the precision the
// step implies (step 0.01 → 2 decimals) and dropping trailing zeros.
export function formatNum(v: number, step: number): string {
  if (!Number.isFinite(v)) return "0";
  const decimals = step > 0 ? stepDecimals(step) : 0;
  let s = v.toFixed(decimals);
  if (s.indexOf(".") >= 0) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

// One arrow button in NumberField's stepper. Holds-to-repeat like a native
// spin button: an initial step, then a delayed accelerating repeat. Reads
// the step action through a ref so the repeat always uses the latest value.
export function StepButton({
  dir,
  onStep,
  title,
}: {
  dir: "up" | "down";
  onStep: () => void;
  title: string;
}) {
  const onStepRef = useRef(onStep);
  onStepRef.current = onStep;
  const timers = useRef<{ to: number | null; iv: number | null }>({
    to: null,
    iv: null,
  });
  const stop = () => {
    if (timers.current.to != null) window.clearTimeout(timers.current.to);
    if (timers.current.iv != null) window.clearInterval(timers.current.iv);
    timers.current = { to: null, iv: null };
  };
  useEffect(() => stop, []);
  const start = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault(); // don't steal focus from / blur the input
    e.stopPropagation();
    onStepRef.current();
    timers.current.to = window.setTimeout(() => {
      timers.current.iv = window.setInterval(() => onStepRef.current(), 55);
    }, 300);
  };
  return (
    <button
      type="button"
      title={title}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      tabIndex={-1}
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        border: "none",
        padding: 0,
        margin: 0,
        cursor: "pointer",
        color: "var(--tb-n-13)",
        lineHeight: 0,
      }}
    >
      <svg width={7} height={4} viewBox="0 0 8 5" aria-hidden>
        <polyline
          points={dir === "up" ? "1.5,3.5 4,1.5 6.5,3.5" : "1.5,1.5 4,3.5 6.5,1.5"}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

export const SCRUB_THRESHOLD = 3; // px of movement before a press becomes a scrub

// Numeric field with three input modes: type (free-form — can be emptied,
// commits to 0 on blank), drag-to-scrub (press + move horizontally), and a
// custom up/down stepper. A clean click (press + release without moving)
// enters text-edit mode; a press that moves scrubs instead. The underlying
// element is a text input so partial entries ("", "-", "1.") don't fight a
// controlled numeric value.
export function NumberField({
  value,
  onChange,
  min,
  max,
  step = 1,
  width = 56,
  borderColor = "var(--tb-n-7)",
  title,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  width?: number | string;
  borderColor?: string;
  title?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const scrub = useRef<{ startX: number; startVal: number; moved: boolean } | null>(
    null
  );
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // rAF-coalesce scrub emits so a fast drag doesn't re-eval the graph per
  // pointer event (same idea as the slider's dampening).
  const raf = useRef<number | null>(null);
  const pending = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (raf.current != null) cancelAnimationFrame(raf.current);
    },
    []
  );

  const clamp = (v: number) => {
    if (typeof min === "number") v = Math.max(min, v);
    if (typeof max === "number") v = Math.min(max, v);
    return v;
  };
  const snap = (v: number) => {
    if (!step || step <= 0) return v;
    return parseFloat((Math.round(v / step) * step).toFixed(6));
  };
  const emit = (v: number) => {
    if (v !== valueRef.current) onChangeRef.current(v);
  };
  const stepBy = (sign: number) => emit(clamp(snap(valueRef.current + sign * step)));

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
    setDraft(formatNum(valueRef.current, step));
    setEditing(true);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    });
  };
  const commit = () => {
    const t = draft.trim();
    let next: number;
    if (t === "") {
      next = 0; // blank confirms to 0
    } else {
      const p = evalNumExpr(t); // plain numbers or math: "1920/2", "24*8+1"
      if (p === null) {
        setEditing(false); // garbage — revert to the live value
        return;
      }
      next = p;
    }
    setEditing(false);
    emit(clamp(next));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLInputElement>) => {
    if (editing) return; // already typing — let the caret behave normally
    if (e.button !== 0) return;
    e.preventDefault(); // suppress auto-focus; decide click-vs-scrub on release
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // not all environments support capture; scrub still works via events
    }
    scrub.current = { startX: e.clientX, startVal: value, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLInputElement>) => {
    const s = scrub.current;
    if (!s) return;
    const dx = e.clientX - s.startX;
    if (!s.moved && Math.abs(dx) < SCRUB_THRESHOLD) return;
    s.moved = true;
    const span =
      typeof min === "number" && typeof max === "number" && max > min
        ? max - min
        : null;
    // Cross the whole range in ~250px; no range → 1 step/px. Shift = fine.
    const perPx = (span != null ? span / 250 : step || 1) * (e.shiftKey ? 0.2 : 1);
    queue(clamp(snap(s.startVal + dx * perPx)));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLInputElement>) => {
    const s = scrub.current;
    scrub.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    if (s && !s.moved) beginEdit(); // clean click → edit
  };

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "stretch",
        width,
        height: 18,
        background: "var(--tb-n-0)",
        border: `1px solid ${borderColor}`,
        borderRadius: 3,
        boxSizing: "border-box",
        overflow: "hidden",
      }}
    >
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        value={editing ? draft : formatNum(value, step)}
        title={title ?? "Drag to scrub · click to type · math ok (1920/2, 24*8)"}
        onChange={(e) => editing && setDraft(e.target.value)}
        onFocus={() => {
          if (!editing) beginEdit();
        }}
        onBlur={commit}
        // Belt-and-suspenders focus suppression: keep a press from focusing
        // the field until we've decided it's a click (not a scrub). Once
        // editing, let clicks position the caret normally.
        onMouseDown={(e) => {
          if (!editing) e.preventDefault();
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          else if (e.key === "Escape") {
            setEditing(false);
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            stepBy(1);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            stepBy(-1);
          }
        }}
        style={{
          flex: 1,
          minWidth: 0,
          background: "transparent",
          border: "none",
          outline: "none",
          color: "var(--tb-n-12)",
          fontFamily: "inherit",
          fontSize: 10,
          padding: "1px 3px",
          cursor: editing ? "text" : "ew-resize",
        }}
      />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: 11,
          flexShrink: 0,
          borderLeft: "1px solid color-mix(in srgb, var(--tb-lift) 18%, transparent)",
        }}
      >
        <StepButton dir="up" title="Increase" onStep={() => stepBy(1)} />
        <StepButton dir="down" title="Decrease" onStep={() => stepBy(-1)} />
      </div>
    </div>
  );
}

// A single labelled 0..max channel field — the H/S/L/A cells shared by the
// inline ColorControl row and the picker popover's numeric row. `grow`
// makes the pair fill its flex track instead of sitting at `width`, which
// is how the popover fits three or four of them across a fixed panel.
export function HslField({
  label,
  value,
  max,
  onChange,
  width = 42,
  grow = false,
  title,
}: {
  label: string;
  value: number;
  max: number;
  onChange: (v: number) => void;
  width?: number | string;
  grow?: boolean;
  title?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        minWidth: 0,
        ...(grow ? { flex: 1 } : null),
      }}
    >
      <span style={{ color: "var(--tb-n-10)", fontSize: 9, flexShrink: 0 }}>
        {label}
      </span>
      <NumberField
        value={value}
        onChange={(v) => onChange(v)}
        min={0}
        max={max}
        step={1}
        width={grow ? "100%" : width}
        title={title ?? `${label} (0–${max})`}
      />
    </div>
  );
}
