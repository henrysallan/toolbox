"use client";

import type React from "react";
import type { DiamondState } from "@/engine/keyframes";

// Small clickable diamond used as the keyframe toggle on every parameter
// row. Three visual states (empty / yellow / red) mirror the parameter's
// animation state at the current playhead — see spec §1.2.

interface Props {
  state: DiamondState;
  // Greyed out and non-interactive when the param is wire-driven (§1.4).
  disabled?: boolean;
  onClick(): void;
  // Caller wires the right-click context menu (Disable/Enable animation,
  // and color-space picker on color params).
  onContextMenu?(e: React.MouseEvent): void;
  title?: string;
}

const SIZE = 10;

export default function KeyframeDiamond({
  state,
  disabled,
  onClick,
  onContextMenu,
  title,
}: Props) {
  const fill =
    state === "yellow"
      ? "#facc15"
      : state === "red"
      ? "#ef4444"
      : "transparent";
  const stroke =
    state === "yellow"
      ? "#facc15"
      : state === "red"
      ? "#ef4444"
      : "#52525b";
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        if (disabled) return;
        e.stopPropagation();
        onClick();
      }}
      onContextMenu={(e) => {
        if (disabled) return;
        if (onContextMenu) {
          e.preventDefault();
          e.stopPropagation();
          onContextMenu(e);
        }
      }}
      style={{
        background: "transparent",
        border: "none",
        padding: 0,
        margin: 0,
        width: SIZE + 4,
        height: SIZE + 4,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.4 : 1,
        lineHeight: 0,
      }}
    >
      <svg width={SIZE} height={SIZE} viewBox="0 0 14 14">
        <polygon
          points="7,1 13,7 7,13 1,7"
          fill={fill}
          stroke={stroke}
          strokeWidth={1.4}
          strokeLinejoin="miter"
        />
      </svg>
    </button>
  );
}
