"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Props {
  playing: boolean;
  time: number;
  fps: number;
  loopFrames: number | null;
  onPlayPause: () => void;
  onReset: () => void;
  onSeek: (time: number) => void;
  onScrubStart: () => void;
  onScrubEnd: () => void;
  onFpsChange: (fps: number) => void;
  onLoopFramesChange: (frames: number | null) => void;
}

export default function Timeline({
  playing,
  time,
  fps,
  loopFrames,
  onPlayPause,
  onReset,
  onSeek,
  onScrubStart,
  onScrubEnd,
  onFpsChange,
  onLoopFramesChange,
}: Props) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const loopDuration = loopFrames != null ? loopFrames / fps : null;
  // When no loop is set, the track scales to accommodate the current time —
  // grows in 10s steps so the playhead doesn't fly off the end.
  const displayMax = loopDuration ?? Math.max(10, Math.ceil((time + 1) / 10) * 10);
  const pct = Math.max(0, Math.min(1, time / displayMax));

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const p = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      onSeek(p * displayMax);
    },
    [onSeek, displayMax]
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (ev: MouseEvent) => seekFromClientX(ev.clientX);
    const onUp = () => {
      setDragging(false);
      onScrubEnd();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging, seekFromClientX, onScrubEnd]);

  const handleTrackMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    onScrubStart();
    setDragging(true);
    seekFromClientX(e.clientX);
  };

  return (
    <div
      style={{
        height: 44,
        background: "#0a0a0a",
        borderTop: "1px solid #27272a",
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "0 12px",
        fontFamily: "ui-monospace, monospace",
        fontSize: 11,
        color: "#e5e7eb",
        flexShrink: 0,
        width: "100%",
        boxSizing: "border-box",
      }}
    >
      <TimelineButton title="Reset to start" onClick={onReset}>
        ⏮
      </TimelineButton>
      <TimelineButton
        title={playing ? "Pause" : "Play"}
        onClick={onPlayPause}
        highlighted={playing}
      >
        {playing ? "⏸" : "▶"}
      </TimelineButton>

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          color: "#71717a",
          marginLeft: 4,
        }}
      >
        loop
        <LoopInput value={loopFrames} onCommit={onLoopFramesChange} />
        <span style={{ color: "#52525b" }}>frames</span>
      </label>

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          color: "#71717a",
        }}
      >
        fps
        <FpsInput value={fps} onCommit={onFpsChange} />
      </label>

      <div
        ref={trackRef}
        onMouseDown={handleTrackMouseDown}
        style={{
          flex: 1,
          minWidth: 0,
          height: 20,
          position: "relative",
          background: "#18181b",
          border: "1px solid #27272a",
          borderRadius: 3,
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            height: "100%",
            width: `${pct * 100}%`,
            background: "#1e3a8a",
            opacity: 0.55,
            pointerEvents: "none",
          }}
        />
        <div
          style={{
            position: "absolute",
            top: -2,
            left: `calc(${pct * 100}% - 1px)`,
            width: 2,
            height: "calc(100% + 4px)",
            background: "#60a5fa",
            pointerEvents: "none",
          }}
        />
      </div>

      <div
        style={{
          minWidth: 120,
          textAlign: "right",
          color: "#a1a1aa",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {time.toFixed(3)}s
        <span style={{ color: "#52525b" }}>
          {" / "}
          {loopDuration != null ? `${loopDuration.toFixed(3)}s` : "∞"}
        </span>
      </div>
    </div>
  );
}

function TimelineButton({
  onClick,
  title,
  children,
  highlighted,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  highlighted?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: 28,
        height: 24,
        background: highlighted ? "#047857" : "#18181b",
        color: highlighted ? "#d1fae5" : "#e5e7eb",
        border: `1px solid ${highlighted ? "#065f46" : "#27272a"}`,
        borderRadius: 3,
        cursor: "pointer",
        fontSize: 12,
        lineHeight: 1,
        padding: 0,
        fontFamily: "inherit",
      }}
    >
      {children}
    </button>
  );
}

function LoopInput({
  value,
  onCommit,
}: {
  value: number | null;
  onCommit: (v: number | null) => void;
}) {
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  useEffect(() => {
    setDraft(value == null ? "" : String(value));
  }, [value]);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      if (value !== null) onCommit(null);
      return;
    }
    const n = Math.round(parseFloat(trimmed));
    if (!Number.isFinite(n) || n < 1) {
      setDraft(value == null ? "" : String(value));
      return;
    }
    if (n !== value) onCommit(n);
  };
  return (
    <input
      type="text"
      value={draft}
      placeholder="∞"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        else if (e.key === "Escape") {
          setDraft(value == null ? "" : String(value));
          (e.target as HTMLInputElement).blur();
        }
      }}
      style={{
        width: 56,
        background: "#0a0a0a",
        border: "1px solid #27272a",
        color: "#e5e7eb",
        fontFamily: "inherit",
        fontSize: 11,
        padding: "2px 4px",
        textAlign: "right",
      }}
    />
  );
}

function FpsInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);
  const commit = () => {
    const n = Math.round(parseFloat(draft));
    if (!Number.isFinite(n) || n < 1 || n > 240) {
      setDraft(String(value));
      return;
    }
    if (n !== value) onCommit(n);
  };
  return (
    <input
      type="number"
      value={draft}
      min={1}
      max={240}
      step={1}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      style={{
        width: 48,
        background: "#0a0a0a",
        border: "1px solid #27272a",
        color: "#e5e7eb",
        fontFamily: "inherit",
        fontSize: 11,
        padding: "2px 4px",
      }}
    />
  );
}
