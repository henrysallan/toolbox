"use client";

// "Skia" chip beside a layer's name when its target is Skia
// (specdocs/101326_skia-target.md §3.1): on the layer node's header in the
// graph and on its row in the Layers editor.
export default function SkiaLayerBadge() {
  return (
    <span
      title="Skia layer: holds only nodes with a React Native Skia version, and exports for React Native"
      style={{
        display: "inline-flex",
        alignItems: "center",
        flexShrink: 0,
        padding: "0 5px",
        borderRadius: 999,
        background: "var(--tb-t-violet-d-2)",
        border: "1px solid var(--tb-a-violet-400)",
        color: "var(--tb-t-violet-l-1)",
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: 0.4,
        lineHeight: "13px",
      }}
    >
      Skia
    </span>
  );
}
