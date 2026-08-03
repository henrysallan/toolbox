"use client";

// One easing-preset preview tile (the curve thumbnail button used by the
// easing pickers in TrackEditor, LayersEditor and GraphEditor — grid
// geometry stays with each menu; the tile itself is shared).

import { useState } from "react";
import { easingPathFor, type EasingPreset } from "@/engine/keyframes";
import { COLOR_BORDER } from "./theme";

export interface EasingTileProps {
  preset: EasingPreset;
  size: number;
  disabled: boolean;
  label: string;
  // Highlight as the current preset (GraphEditor's context menu marks
  // the clicked keyframe's easing).
  active?: boolean;
  onClick(): void;
}

export function EasingTile(props: EasingTileProps) {
  const { preset, size, disabled, label, active, onClick } = props;
  const [hover, setHover] = useState(false);
  const inset = 4;
  const w = size - inset * 2;
  const h = size - inset * 2;
  const path = easingPathFor(preset, w, h, 40);
  return (
    <button
      type="button"
      title={label}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onClick();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: size,
        height: size,
        padding: 0,
        background: active
          ? "var(--tb-a-blue-900)"
          : hover && !disabled
            ? "var(--tb-n-7)"
            : "var(--tb-n-1)",
        border: `1px solid ${
          active ? "var(--tb-a-blue-500)" : hover && !disabled ? "var(--tb-n-9)" : COLOR_BORDER
        }`,
        borderRadius: 4,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.35 : 1,
        // `active` already marks the current preset; the browser's focus
        // ring on top of it just reads as a stray blue box in the menu.
        outline: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
        {/* baseline & ceiling */}
        <line
          x1={0}
          y1={h * 0.82}
          x2={w}
          y2={h * 0.82}
          stroke="var(--tb-n-8)"
          strokeWidth={1}
        />
        <line
          x1={0}
          y1={h * 0.18}
          x2={w}
          y2={h * 0.18}
          stroke="var(--tb-n-8)"
          strokeWidth={1}
        />
        <path
          d={path}
          fill="none"
          stroke={active || (hover && !disabled) ? "var(--tb-a-amber-400)" : "var(--tb-a-blue-500)"}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
