"use client";

import { useEffect, useRef, useState } from "react";
import { Spinner } from "./Spinner";

// One status message as recorded by EffectsApp's flashToast. `at` is a
// Date.now() epoch so the console can render a wall-clock timestamp.
export type ConsoleEntry = { id: number; text: string; at: number };

// The save/load (and node-progress) readout that used to render as the
// canvas-overlay ProgressBanner. While non-null the chip shows a spinner,
// the label, a percentage, and a thin bottom fill bar instead of the
// last toast message.
export type ProgressStatus = {
  label: string;
  progress: number;
  tone: "save" | "load";
};

const WINDOW_WIDTH = 380;
const TITLEBAR_HEIGHT = 24;

// Menu-bar status readout + message console. The chip lives in the nav
// bar's right cluster (left of the account button): it lights up while a
// toast is flashing (or a save/load is in progress), then dims to the
// most recent message. Clicking it opens a draggable console window
// listing the full message history.
export default function MessageConsole({
  toast,
  log,
  progress,
}: {
  toast: string | null;
  log: ConsoleEntry[];
  progress: ProgressStatus | null;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);

  const latest = toast ?? (log.length ? log[log.length - 1].text : null);
  if (progress == null && latest == null) return null;

  const active = toast != null;
  const isLoad = progress?.tone === "load";
  const pct = progress
    ? Math.max(0, Math.min(100, Math.round(progress.progress * 100)))
    : 0;
  // Progress takes over the chip's coloring: green for saves (matching
  // the flash tint), blue for loads — same tones the old banner used.
  const chipColor = progress
    ? isLoad
      ? "var(--tb-a-blue-300)"
      : "var(--tb-a-green-300)"
    : active
      ? "var(--tb-a-green-300)"
      : hover
        ? "var(--tb-n-13)"
        : "var(--tb-n-10)";
  const chipBg = progress
    ? isLoad
      ? "color-mix(in srgb, var(--tb-a-blue-500) 14%, transparent)"
      : "color-mix(in srgb, var(--tb-a-green-500) 14%, transparent)"
    : active
      ? "color-mix(in srgb, var(--tb-a-green-500) 14%, transparent)"
      : hover
        ? "var(--tb-n-4)"
        : "transparent";
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        height: "100%",
        // The chip sits inside the frameless build's drag region — keep it
        // interactive there.
        WebkitAppRegion: "no-drag",
      }}
    >
      <button
        title="Message history — click to open the console"
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          position: "relative",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          height: 16,
          padding: "0 8px",
          maxWidth: 280,
          overflow: "hidden",
          whiteSpace: "nowrap",
          background: chipBg,
          color: chipColor,
          border: "none",
          borderRadius: 8,
          fontFamily: "inherit",
          fontSize: 10,
          letterSpacing: 0.3,
          lineHeight: 1,
          cursor: "pointer",
          transition: "background 120ms, color 120ms",
        }}
      >
        {progress && (
          <Spinner size={10} stroke={1.5} color={chipColor} arc={0.28} />
        )}
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {progress ? progress.label : latest}
        </span>
        {progress && (
          <span style={{ fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
            {pct}%
          </span>
        )}
        {progress && (
          <span
            style={{
              position: "absolute",
              left: 0,
              bottom: 0,
              height: 2,
              width: `${pct}%`,
              background: chipColor,
              transition: "width 80ms linear",
            }}
          />
        )}
      </button>
      {open && <ConsoleWindow log={log} onClose={() => setOpen(false)} />}
    </div>
  );
}

function ConsoleWindow({
  log,
  onClose,
}: {
  log: ConsoleEntry[];
  onClose: () => void;
}) {
  // Fixed-position window; the title bar is the drag handle. Position is
  // lazily seeded near the top-right (under the chip) on first open.
  const [pos, setPos] = useState<{ x: number; y: number }>(() => ({
    x: Math.max(8, window.innerWidth - WINDOW_WIDTH - 16),
    y: 34,
  }));
  const [dragging, setDragging] = useState(false);
  const dragOffsetRef = useRef<{ dx: number; dy: number } | null>(null);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length]);

  return (
    <div
      style={{
        position: "fixed",
        left: pos.x,
        top: pos.y,
        width: WINDOW_WIDTH,
        zIndex: 3000,
        background: "var(--tb-n-3)",
        border: "1px solid var(--tb-n-7)",
        borderRadius: 6,
        boxShadow: "0 10px 32px rgba(0,0,0,0.6)",
        overflow: "hidden",
        fontFamily: "var(--code-font)",
        userSelect: "none",
      }}
    >
      <div
        onPointerDown={(e) => {
          e.preventDefault();
          dragOffsetRef.current = {
            dx: e.clientX - pos.x,
            dy: e.clientY - pos.y,
          };
          setDragging(true);
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const off = dragOffsetRef.current;
          if (!dragging || !off) return;
          // Clamp so the title bar always stays reachable.
          const x = Math.min(
            Math.max(e.clientX - off.dx, 48 - WINDOW_WIDTH),
            window.innerWidth - 48
          );
          const y = Math.min(
            Math.max(e.clientY - off.dy, 0),
            window.innerHeight - TITLEBAR_HEIGHT
          );
          setPos({ x, y });
        }}
        onPointerUp={() => {
          setDragging(false);
          dragOffsetRef.current = null;
        }}
        onPointerCancel={() => {
          setDragging(false);
          dragOffsetRef.current = null;
        }}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: TITLEBAR_HEIGHT,
          padding: "0 4px 0 10px",
          background: "var(--tb-n-1)",
          borderBottom: "1px solid var(--tb-n-7)",
          cursor: dragging ? "grabbing" : "grab",
          touchAction: "none",
        }}
      >
        <span
          style={{
            fontSize: 10,
            letterSpacing: 0.5,
            color: "var(--tb-n-13)",
          }}
        >
          Console
        </span>
        <button
          title="Close"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onClose}
          style={{
            width: 18,
            height: 18,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "transparent",
            border: "none",
            borderRadius: 3,
            color: "var(--tb-n-11)",
            fontSize: 11,
            lineHeight: 1,
            cursor: "pointer",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--tb-n-16)";
            e.currentTarget.style.background = "var(--tb-n-7)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--tb-n-11)";
            e.currentTarget.style.background = "transparent";
          }}
        >
          ✕
        </button>
      </div>
      <div
        ref={bodyRef}
        style={{
          maxHeight: 260,
          minHeight: 60,
          overflowY: "auto",
          padding: "6px 10px",
          fontSize: 10,
          lineHeight: 1.7,
          userSelect: "text",
          cursor: "auto",
        }}
      >
        {log.length === 0 ? (
          <div style={{ color: "var(--tb-n-10)" }}>No messages yet.</div>
        ) : (
          log.map((e) => (
            <div key={e.id} style={{ display: "flex", gap: 8 }}>
              <span
                style={{
                  color: "var(--tb-n-10)",
                  flexShrink: 0,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {formatTime(e.at)}
              </span>
              <span style={{ color: "var(--tb-n-15)", wordBreak: "break-word" }}>
                {e.text}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function formatTime(at: number) {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
