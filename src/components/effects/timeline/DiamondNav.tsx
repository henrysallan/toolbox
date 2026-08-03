"use client";

// Lane-label keyframe cluster: ‹ ◆ › — chevrons jump the playhead to
// the previous / next keyframe; the diamond toggles a key at the
// playhead (empty / yellow / red, same as the param panel). Shared by
// the Tracks and Layers editors. Subscribes to the clock itself
// (per-diamond leaf subscription) so the host editor doesn't need the
// tick at its top level.

import { useClock } from "@/state/playback-clock";
import {
  diamondStateFor,
  type KeyframeAnimationBlock,
} from "@/engine/keyframes";
import {
  COLOR_DIAMOND_NAV,
  COLOR_DIAMOND_NAV_EMPTY,
  COLOR_NAV_CHEVRON,
  COLOR_NAV_CHEVRON_OFF,
} from "./theme";

export function DiamondNav({
  block,
  onToggle,
  onSeek,
}: {
  block: KeyframeAnimationBlock | undefined;
  onToggle: () => void;
  onSeek: (tick: number) => void;
}) {
  const currentTick = useClock((s) => s.tick);
  const st = diamondStateFor(block, currentTick);
  // Red (a keyed value that's been overridden) stays loud — it's a
  // warning. Yellow is the resting state, so it's muted to sit back on
  // the gutter card.
  const col =
    st === "red"
      ? "var(--tb-a-red-500)"
      : st === "yellow"
        ? COLOR_DIAMOND_NAV
        : COLOR_DIAMOND_NAV_EMPTY;
  let prev: number | null = null;
  let next: number | null = null;
  for (const k of block?.keyframes ?? []) {
    if (k.tick < currentTick && (prev == null || k.tick > prev)) prev = k.tick;
    if (k.tick > currentTick && (next == null || k.tick < next)) next = k.tick;
  }
  const navBtn = (dir: "prev" | "next", target: number | null) => (
    <button
      type="button"
      title={dir === "prev" ? "Jump to previous keyframe" : "Jump to next keyframe"}
      disabled={target == null}
      onClick={(e) => {
        e.stopPropagation();
        if (target != null) onSeek(target);
      }}
      style={{
        width: 10,
        height: 12,
        flexShrink: 0,
        background: "transparent",
        border: "none",
        padding: 0,
        cursor: target == null ? "default" : "pointer",
        color: target == null ? COLOR_NAV_CHEVRON_OFF : COLOR_NAV_CHEVRON,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <svg
        width={7}
        height={9}
        viewBox="0 0 7 9"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ transform: dir === "prev" ? "rotate(180deg)" : "none" }}
      >
        <path d="M2 1.5 L5 4.5 L2 7.5" />
      </svg>
    </button>
  );
  return (
    <span
      style={{ display: "flex", alignItems: "center", gap: 3, flexShrink: 0 }}
    >
      {navBtn("prev", prev)}
      <button
        type="button"
        title="Toggle keyframe at playhead"
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        style={{
          width: 8,
          height: 8,
          flexShrink: 0,
          transform: "rotate(45deg)",
          background: st === "empty" ? "transparent" : col,
          border: `1px solid ${st === "empty" ? COLOR_DIAMOND_NAV_EMPTY : col}`,
          padding: 0,
          cursor: "pointer",
        }}
      />
      {navBtn("next", next)}
    </span>
  );
}
