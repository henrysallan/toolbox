"use client";

import { useCallback } from "react";

import { MiniBarSlider } from "@/lib/param-controls";

export interface ViewportMenuBarProps {
  /**
   * Leftmost slot — the tiled layout's panel-kind switcher chip lives
   * here (072726_window-tiling.md §3).
   */
  leading?: React.ReactNode;
  /** Project resolution (full export size). */
  projectRes: [number, number];
  /** Current preview scale, 1.0 = full res. */
  previewScale: number;
  onPreviewScaleChange: (scale: number) => void;
  /**
   * Right-aligned slot — viewport view options (the transparency-grid
   * toggle) sit here, on the same row as the resolution slider rather
   * than floating over the canvas.
   */
  trailing?: React.ReactNode;
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
  leading,
  projectRes,
  previewScale,
  onPreviewScaleChange,
  trailing,
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
        // Matches CompositionTabBar / the params header strip so the
        // panel-kind chips sit with identical margins in every panel.
        height: 24,
        display: "flex",
        alignItems: "center",
        gap: 8,
        // Right inset matches the left one so the trailing view-options
        // slot tucks into the corner instead of floating off it.
        padding: "0 4px",
        background: "var(--tb-n-0)",
        fontSize: 11,
        color: "var(--tb-n-13)",
        userSelect: "none",
        flexShrink: 0,
      }}
    >
      {leading}
      {/* Preview-scale bar slider — the app's standard MiniBarSlider chrome
          (track + fill + leading-edge line), with the percentage and the
          resulting render size read out inside the track itself. */}
      <div style={{ display: "flex", width: 170 }}>
        <MiniBarSlider
          value={pct}
          min={10}
          max={100}
          step={5}
          // Matches the panel-kind chip beside it (19×17).
          height={17}
          onChange={(v) => setScale(v / 100)}
          title="Preview render resolution. Independent from on-screen size and project export resolution. Lowering this speeds up live playback. Hold Shift to fine-tune."
          overlay={
            <>
              <span
                style={{
                  color: "var(--tb-n-16)",
                  fontVariantNumeric: "tabular-nums",
                  fontSize: 9,
                  lineHeight: 1,
                  paddingLeft: 6,
                }}
              >
                {pct}%
              </span>
              <span
                style={{
                  marginLeft: "auto",
                  color: "var(--tb-n-13)",
                  fontVariantNumeric: "tabular-nums",
                  fontSize: 9,
                  lineHeight: 1,
                  paddingRight: 6,
                }}
              >
                {renderW}×{renderH}
              </span>
            </>
          }
        />
      </div>
      {trailing && (
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          {trailing}
        </div>
      )}
    </div>
  );
}
