"use client";

import { useCallback } from "react";

export interface ViewportMenuBarProps {
  /** Project resolution (full export size). */
  projectRes: [number, number];
  /** Current preview scale, 1.0 = full res. */
  previewScale: number;
  onPreviewScaleChange: (scale: number) => void;
}

/**
 * Lightweight menubar that sits above the preview viewport.
 *
 * Hosts the preview-resolution slider, which decouples the GL render
 * resolution from both the on-screen canvas display size and the
 * project export resolution. Lower preview scale = fewer pixels per
 * shader pass = higher fps for live editing. Export paths still use
 * the full project resolution.
 */
export default function ViewportMenuBar({
  projectRes,
  previewScale,
  onPreviewScaleChange,
}: ViewportMenuBarProps) {
  const setScale = useCallback(
    (s: number) => {
      const clamped = Math.max(0.1, Math.min(1, s));
      onPreviewScaleChange(Math.round(clamped * 100) / 100);
    },
    [onPreviewScaleChange]
  );

  const renderW = Math.max(2, Math.round(projectRes[0] * previewScale));
  const renderH = Math.max(2, Math.round(projectRes[1] * previewScale));
  const pct = Math.round(previewScale * 100);

  return (
    <div
      style={{
        height: 22,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "0 10px",
        background: "#0a0a0a",
        borderBottom: "1px solid #27272a",
        fontSize: 11,
        color: "#a1a1aa",
        userSelect: "none",
        flexShrink: 0,
      }}
    >
      <input
        title="Preview render resolution. Independent from on-screen size and project export resolution. Lowering this speeds up live playback."
        type="range"
        min={10}
        max={100}
        step={5}
        value={pct}
        onChange={(e) => setScale(Number(e.target.value) / 100)}
        style={{ width: 110, accentColor: "#52525b", height: 14 }}
        aria-label="Preview resolution scale"
      />
      <span
        style={{
          color: "#e4e4e7",
          fontVariantNumeric: "tabular-nums",
          minWidth: 30,
          fontSize: 10,
        }}
      >
        {pct}%
      </span>
      <span
        style={{
          color: "#52525b",
          fontVariantNumeric: "tabular-nums",
          fontSize: 10,
        }}
      >
        {renderW}×{renderH}
      </span>
      <div style={{ marginLeft: "auto", color: "#52525b", fontSize: 10 }}>
        Project: {projectRes[0]}×{projectRes[1]}
      </div>
    </div>
  );
}
