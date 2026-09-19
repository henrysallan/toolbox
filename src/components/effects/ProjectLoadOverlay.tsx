"use client";

import { useEffect, useRef } from "react";
import { setGatewayInputLock } from "@/lib/shortcut-freeze";
import {
  PROJECT_LOAD_BAR_MS,
  PROJECT_LOAD_FADE_MS,
} from "@/lib/load-overlay-timing";

// The cadence (min hold, fade, bar ease, waitAnimationFrames) lives in
// lib/load-overlay-timing so the live viewer's veil (LiveLoadOverlay) can
// share it without pulling editor code into the exported app; re-exported
// here for EffectsApp, which drives the reveal.
export {
  PROJECT_LOAD_MIN_MS,
  PROJECT_LOAD_FADE_MS,
  PROJECT_LOAD_BAR_MS,
  waitAnimationFrames,
} from "@/lib/load-overlay-timing";

export default function ProjectLoadOverlay({
  name,
  progress,
  fading,
  onFaded,
}: {
  name: string;
  progress: number;
  fading: boolean;
  onFaded: () => void;
}) {
  const onFadedRef = useRef(onFaded);
  useEffect(() => {
    onFadedRef.current = onFaded;
  });

  // Same capture-phase gate the landing uses: the editor stays mounted
  // (and would otherwise take hotkeys / wheel-pan) under this veil.
  useEffect(() => {
    if (fading) {
      setGatewayInputLock(false);
      return;
    }
    setGatewayInputLock(true);
    return () => setGatewayInputLock(false);
  }, [fading]);

  useEffect(() => {
    if (!fading) return;
    const t = window.setTimeout(
      () => onFadedRef.current(),
      PROJECT_LOAD_FADE_MS + 80
    );
    return () => window.clearTimeout(t);
  }, [fading]);

  const trimmed = name.trim();
  const label = trimmed ? `Loading ${trimmed} project` : "Loading project";
  const pct = Math.max(0, Math.min(1, progress));

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      onTransitionEnd={(e) => {
        if (e.propertyName === "opacity" && fading) onFadedRef.current();
      }}
      style={{
        position: "absolute",
        inset: 0,
        // Below MenuBar (1000) and PlaybackBar (950); the overlay is
        // clipped to the tiled region so those stay visible either way.
        zIndex: 800,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--tb-frame)",
        opacity: fading ? 0 : 1,
        transition: `opacity ${PROJECT_LOAD_FADE_MS}ms ease`,
        pointerEvents: fading ? "none" : "auto",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 10,
          width: 280,
          maxWidth: "calc(100% - 48px)",
        }}
      >
        <div
          style={{
            color: "var(--tb-n-13)",
            fontSize: 12,
            letterSpacing: 0.2,
            lineHeight: "16px",
            height: 16,
            width: "100%",
            minWidth: 0,
            textAlign: "center",
            userSelect: "none",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {label}
        </div>
        <div
          style={{
            width: "100%",
            height: 2,
            background: "var(--tb-n-6)",
            borderRadius: 1,
            overflow: "hidden",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: `${pct * 100}%`,
              height: "100%",
              background: "var(--tb-n-16)",
              transition: `width ${PROJECT_LOAD_BAR_MS}ms ease-out`,
            }}
          />
        </div>
      </div>
    </div>
  );
}
