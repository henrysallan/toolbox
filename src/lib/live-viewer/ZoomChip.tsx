"use client";

// Zoom readout + reset chip over the live canvas (091826_live-pan-zoom.md):
// the live-link twin of the editor's ViewportZoomChip ("125% · reset",
// EffectsApp), shown only while the visitor's view is off the default
// framing. Click = back to fit; the pan/zoom capability stays on (the
// title-row button's off state is the other way back). Styled from the
// design token sheet (styles.css `.zoom-chip`) and placed on the side
// opposite the panel so a floating card never covers it. Shared by the
// viewer and the designer preview.

export function ZoomChip({
  zoom,
  onReset,
}: {
  zoom: number;
  onReset: () => void;
}) {
  return (
    <button
      type="button"
      className="zoom-chip"
      onClick={onReset}
      title="Reset the view to fit the canvas"
    >
      {Math.round(zoom * 100)}% · reset
    </button>
  );
}
