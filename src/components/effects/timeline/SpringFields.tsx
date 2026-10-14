"use client";

// The `spring` easing's two params as compact number fields — damping
// (Reanimated's dampingRatio) and settle (where in the segment the spring
// comes to rest, shown in %). Used by the Graph Editor header and the
// easing overlay's readout, i.e. where bezier handles are edited for the
// other kinds. Typing commits on Enter / blur (one undo step, not one per
// keystroke); the spinner and arrow keys commit each step. Values are
// clamped by sanitizeSpringEasing before they reach the keyframe.

import { useState } from "react";
import {
  SPRING_DAMPING_MAX,
  SPRING_DAMPING_MIN,
  SPRING_SETTLE_MIN,
  sanitizeSpringEasing,
  type SpringEasing,
} from "@/engine/spring-easing";
import { COLOR_BG, COLOR_BORDER, COLOR_MUTED, COLOR_TEXT } from "./theme";

export interface SpringFieldsProps {
  // The params that play (defaults filled in).
  value: Required<SpringEasing>;
  onCommit(next: SpringEasing): void;
  // Field font size (the Graph Editor header uses 11, the overlay 9.5).
  fontSize?: number;
}

export function SpringFields({ value, onCommit, fontSize = 11 }: SpringFieldsProps) {
  const commit = (patch: Partial<SpringEasing>) => {
    const next = sanitizeSpringEasing({ ...value, ...patch });
    if (!next) return;
    if (next.dampingRatio === value.dampingRatio && next.settle === value.settle) return;
    onCommit(next);
  };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize, color: COLOR_MUTED }}>
      <NumberField
        label="damping"
        title={
          "Damping ratio (Reanimated's dampingRatio): below 1 bounces, 1 settles " +
          "without overshoot. Reanimated runs every value ≥ 1 as critically damped."
        }
        value={value.dampingRatio}
        display={(v) => v.toFixed(2)}
        step={0.05}
        min={SPRING_DAMPING_MIN}
        max={SPRING_DAMPING_MAX}
        fontSize={fontSize}
        onCommit={(v) => commit({ dampingRatio: v })}
      />
      <NumberField
        label="settle"
        suffix="%"
        title="Where in the segment the spring comes to rest (100% = at the next key)."
        value={value.settle * 100}
        display={(v) => String(Math.round(v))}
        step={5}
        min={SPRING_SETTLE_MIN * 100}
        max={100}
        fontSize={fontSize}
        onCommit={(v) => commit({ settle: v / 100 })}
      />
    </span>
  );
}

interface NumberFieldProps {
  label: string;
  suffix?: string;
  title: string;
  value: number;
  display(v: number): string;
  step: number;
  min: number;
  max: number;
  fontSize: number;
  onCommit(v: number): void;
}

function NumberField(p: NumberFieldProps) {
  // The text being typed; null while the field shows the committed value.
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? p.display(p.value);
  const commitText = (text: string) => {
    const n = Number(text);
    if (text.trim() !== "" && Number.isFinite(n)) p.onCommit(n);
    setDraft(null);
  };
  return (
    <label title={p.title} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
      {p.label}
      <input
        type="number"
        value={shown}
        step={p.step}
        min={p.min}
        max={p.max}
        onChange={(e) => {
          const text = e.target.value;
          // A spinner click arrives without a typed InputEvent: commit it.
          const typed = (e.nativeEvent as InputEvent).inputType;
          if (typed) setDraft(text);
          else commitText(text);
        }}
        onBlur={() => {
          if (draft !== null) commitText(draft);
        }}
        onKeyDown={(e) => {
          // Keep Delete / G / S / F … from reaching the editor's shortcuts.
          e.stopPropagation();
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
        style={{
          width: `${Math.max(3, p.display(p.max).length) + 2}ch`,
          background: COLOR_BG,
          color: COLOR_TEXT,
          border: `1px solid ${COLOR_BORDER}`,
          borderRadius: 3,
          padding: "0 3px",
          fontSize: p.fontSize,
          fontFamily: "var(--ui-font)",
        }}
      />
      {p.suffix}
    </label>
  );
}
