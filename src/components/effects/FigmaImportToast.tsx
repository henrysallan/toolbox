"use client";

import { useEffect, useRef, useState } from "react";

// Result card for a Figma paste (specdocs/092326_figma-import.md): what
// landed, what didn't map (the importer's notes), and — when the comp's
// aspect differs from the frame's — a one-click resolution match. Positions
// are frame-relative, so a different aspect stretches text / images and
// crops shapes until the comp matches.

export interface FigmaImportNotice {
  id: number;
  frameName: string;
  layers: number;
  nodes: number;
  frame: [number, number];
  canvas: [number, number];
  warnings: string[];
}

export function aspectDiffers(a: [number, number], b: [number, number]): boolean {
  return Math.abs(a[0] / a[1] - b[0] / b[1]) > 0.005 * (b[0] / b[1]);
}

// Every imported shape rasterizes at comp size, so a comp far bigger than
// the frame costs memory for detail the design doesn't have.
function compMuchLarger(canvas: [number, number], frame: [number, number]): boolean {
  return canvas[0] * canvas[1] > 2 * frame[0] * frame[1];
}

export default function FigmaImportToast({
  notice,
  onMatch,
  onDismiss,
}: {
  notice: FigmaImportNotice;
  onMatch: (size: [number, number]) => void;
  onDismiss: () => void;
}) {
  const [open, setOpen] = useState(false);
  const aspectOff = aspectDiffers(notice.canvas, notice.frame);
  const mismatch = aspectOff || compMuchLarger(notice.canvas, notice.frame);
  const quiet = !mismatch && notice.warnings.length === 0;

  // Nothing to act on → get out of the way. The parent re-renders every
  // frame during playback, so the timer must not restart on a new
  // onDismiss identity — read it through a ref.
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  });
  useEffect(() => {
    if (!quiet) return;
    const t = window.setTimeout(() => dismissRef.current(), 6000);
    return () => window.clearTimeout(t);
  }, [quiet, notice.id]);

  const [fw, fh] = notice.frame;
  const button = {
    background: "var(--tb-n-5)",
    border: "1px solid var(--tb-n-7)",
    borderRadius: 4,
    color: "var(--tb-n-16)",
    font: "inherit",
    padding: "3px 8px",
    cursor: "default",
  } as const;

  return (
    <div
      role="status"
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 2000,
        width: 300,
        background: "var(--tb-n-3)",
        border: "1px solid var(--tb-n-7)",
        borderRadius: 6,
        boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
        padding: "10px 12px",
        fontFamily: "var(--ui-font)",
        fontSize: 11,
        color: "var(--tb-n-16)",
        userSelect: "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          Imported “{notice.frameName}”
        </span>
        <button
          aria-label="Dismiss"
          title="Dismiss"
          onClick={onDismiss}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--tb-n-11)",
            cursor: "default",
            fontSize: 12,
            padding: 0,
            lineHeight: 1,
          }}
        >
          ✕
        </button>
      </div>
      <div style={{ color: "var(--tb-n-11)", marginTop: 4 }}>
        {notice.layers} layer{notice.layers === 1 ? "" : "s"} → {notice.nodes} nodes
      </div>
      {mismatch && (
        <div style={{ marginTop: 8, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <span style={{ color: "var(--tb-n-11)" }}>
            Comp is {notice.canvas[0]}×{notice.canvas[1]}; the frame is {fw}×{fh}
            {aspectOff ? "." : " — every shape renders at comp size."}
          </span>
          <button style={button} onClick={() => onMatch([fw, fh])}>
            Match {fw}×{fh}
          </button>
        </div>
      )}
      {notice.warnings.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <button
            onClick={() => setOpen((v) => !v)}
            style={{ ...button, background: "transparent", border: "none", padding: 0, color: "var(--tb-n-12)" }}
          >
            {open ? "▾" : "▸"} {notice.warnings.length} note{notice.warnings.length === 1 ? "" : "s"}
          </button>
          {open && (
            <ul style={{ margin: "6px 0 0", paddingLeft: 16, color: "var(--tb-n-11)", maxHeight: 180, overflowY: "auto", userSelect: "text" }}>
              {notice.warnings.map((w, i) => (
                <li key={i} style={{ marginBottom: 3 }}>
                  {w}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
