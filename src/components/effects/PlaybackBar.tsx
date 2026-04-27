"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

// Width-based picks for tick spacing. Tries ascending intervals until
// the minor-tick gap is at least MIN_TICK_PX wide. Major ticks land
// every 5th minor and carry the seconds label.
const NICE_INTERVALS = [
  0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300, 600,
];
const MIN_TICK_PX = 12;

function pickTickInterval(viewSpanSec: number, trackWidthPx: number) {
  if (trackWidthPx <= 0) return NICE_INTERVALS[NICE_INTERVALS.length - 1];
  for (const iv of NICE_INTERVALS) {
    const px = (iv / viewSpanSec) * trackWidthPx;
    if (px >= MIN_TICK_PX) return iv;
  }
  return NICE_INTERVALS[NICE_INTERVALS.length - 1];
}

export default function PlaybackBar({
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
  const [trackWidth, setTrackWidth] = useState(0);
  // Seconds shown at the left edge of the visible track. Pans negative
  // to look at "before zero" (a no-op time-wise but useful framing).
  const [viewOffset, setViewOffset] = useState(0);
  // Optional zoomed span — null means "follow the natural span" (loop
  // duration when set, otherwise the auto-growing buffer). Cmd+wheel
  // populates it so the user can zoom in/out around the cursor.
  // Double-clicking the track clears both pan and zoom.
  const [viewSpanOverride, setViewSpanOverride] = useState<number | null>(
    null
  );
  // Auto-grown span used when no loop is set. Monotonic — once the
  // playhead has reached, say, 23s the bucket sits at 30s and stays
  // there even if the user scrubs back to 2s. Without this latch, the
  // tick spacing would reflow on every backward scrub as the span
  // collapsed to a smaller bucket and pxPerSec changed underneath the
  // ticks.
  const [autoSpan, setAutoSpan] = useState(10);
  useEffect(() => {
    setAutoSpan((prev) => {
      const wanted = Math.max(10, Math.ceil((time + 1) / 10) * 10);
      return wanted > prev ? wanted : prev;
    });
  }, [time]);
  const loopDuration = loopFrames != null ? loopFrames / fps : null;
  const naturalSpan = loopDuration ?? autoSpan;
  const viewSpan = viewSpanOverride ?? naturalSpan;
  const viewEnd = viewOffset + viewSpan;
  const pxPerSec = trackWidth > 0 ? trackWidth / viewSpan : 0;

  // Track width — needed for the tick math + wheel-pan scaling.
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const update = () => setTrackWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const p = (clientX - rect.left) / rect.width;
      onSeek(Math.max(0, viewOffset + p * viewSpan));
    },
    [onSeek, viewOffset, viewSpan]
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

  // Two-finger scroll → pan the timeline view. Wheel binds imperatively
  // with passive:false so preventDefault works (otherwise the page
  // would also scroll on a horizontal trackpad gesture).
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (pxPerSec === 0) return;
      e.preventDefault();
      // Use whichever delta dominates so a vertical-only wheel still
      // pans, and so a diagonal trackpad gesture lands cleanly on one
      // axis instead of jittering between the two.
      const dx = e.deltaX || 0;
      const dy = e.deltaY || 0;
      const sx = Math.abs(dx) > Math.abs(dy) ? dx : dy;
      if (e.metaKey || e.ctrlKey) {
        // Cmd/Ctrl + wheel → horizontal zoom anchored at the cursor.
        // Negative delta (scroll up / two-fingers up) zooms in.
        const rect = el.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const tAt = viewOffset + mouseX / pxPerSec;
        const factor = Math.exp(sx * 0.005);
        const nextSpan = Math.max(0.1, Math.min(3600, viewSpan * factor));
        setViewSpanOverride(nextSpan);
        // Recompute pan so the cursor's time-point stays anchored:
        // tAt = newOffset + mouseX / (trackWidth / nextSpan)
        const nextPxPerSec = trackWidth / nextSpan;
        setViewOffset(tAt - mouseX / nextPxPerSec);
        return;
      }
      setViewOffset((prev) => prev + sx / pxPerSec);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [pxPerSec, viewOffset, viewSpan, trackWidth]);

  // Middle-click drag also pans.
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 1 || pxPerSec === 0) return;
      e.preventDefault();
      const startX = e.clientX;
      let curOffset = 0;
      setViewOffset((v) => {
        curOffset = v;
        return v;
      });
      const onMove = (ev: PointerEvent) => {
        setViewOffset(curOffset - (ev.clientX - startX) / pxPerSec);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    };
    el.addEventListener("pointerdown", onDown);
    return () => el.removeEventListener("pointerdown", onDown);
  }, [pxPerSec]);

  const handleTrackMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    onScrubStart();
    setDragging(true);
    seekFromClientX(e.clientX);
  };

  // Build tick positions in pixels.
  const ticks = useMemo(() => {
    if (trackWidth === 0) return [];
    const interval = pickTickInterval(viewSpan, trackWidth);
    const startTick = Math.floor(viewOffset / interval) * interval;
    const out: { x: number; major: boolean; label: string | null }[] = [];
    // Major every 5 minor ticks. Compute the major epoch off zero so
    // labels stay aligned regardless of pan.
    for (let t = startTick; t <= viewEnd + interval; t += interval) {
      const x = (t - viewOffset) * pxPerSec;
      if (x < -MIN_TICK_PX || x > trackWidth + MIN_TICK_PX) continue;
      const ratio = t / interval;
      const major = Math.round(ratio) % 5 === 0;
      out.push({
        x,
        major,
        label: major ? formatTickLabel(t) : null,
      });
    }
    return out;
  }, [trackWidth, viewSpan, viewOffset, viewEnd, pxPerSec]);

  // Playhead pixel position (only rendered if it lies in the visible
  // window — otherwise we hint with a small marker on the relevant edge).
  const playheadX = (time - viewOffset) * pxPerSec;
  const playheadVisible =
    pxPerSec > 0 && playheadX >= 0 && playheadX <= trackWidth;
  const playheadOffEdge =
    pxPerSec > 0 ? (playheadX < 0 ? "left" : playheadX > trackWidth ? "right" : null) : null;

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
      <PlaybackBarButton
        title="Reset to start"
        onClick={() => {
          onReset();
          // Re-frame the view so the playhead (now at t=0) is on screen.
          // Keep any zoom override the user dialed in — they probably
          // want to keep looking at the same scale, just from the start.
          setViewOffset(0);
        }}
      >
        <ResetIcon />
      </PlaybackBarButton>
      <PlaybackBarButton
        title={playing ? "Pause" : "Play"}
        onClick={onPlayPause}
        highlighted={playing}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </PlaybackBarButton>

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
        onDoubleClick={() => {
          setViewOffset(0);
          setViewSpanOverride(null);
        }}
        title="Click to scrub · two-finger / middle-drag to pan · ⌘+scroll to zoom · double-click to reset view"
        style={{
          flex: 1,
          minWidth: 0,
          height: 20,
          position: "relative",
          background: "#050505",
          border: "1px solid #27272a",
          borderRadius: 3,
          cursor: "pointer",
          userSelect: "none",
          overflow: "hidden",
        }}
      >
        {/* Centerline */}
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: 0,
            right: 0,
            height: 1,
            background: "#3f3f46",
            transform: "translateY(-0.5px)",
            pointerEvents: "none",
          }}
        />
        {/* Tick marks. Major ticks span ~80% height with a label
            beneath; minor ticks are short whiskers above and below the
            centerline. */}
        {ticks.map((t, i) => (
          <div key={i}>
            <div
              style={{
                position: "absolute",
                top: t.major ? 2 : "50%",
                left: t.x,
                width: 1,
                height: t.major ? 16 : 5,
                marginTop: t.major ? 0 : -2,
                background: t.major ? "#71717a" : "#52525b",
                pointerEvents: "none",
              }}
            />
            {t.label && (
              <div
                style={{
                  position: "absolute",
                  bottom: 1,
                  left: t.x + 3,
                  fontSize: 9,
                  color: "#71717a",
                  fontVariantNumeric: "tabular-nums",
                  pointerEvents: "none",
                  lineHeight: 1,
                }}
              >
                {t.label}
              </div>
            )}
          </div>
        ))}
        {/* Loop-end marker — if a loop is set, mark its right edge
            with a faint vertical line so the loop boundary is
            visually distinct from the rest of the (extended) track. */}
        {loopDuration != null && pxPerSec > 0 && (() => {
          const lx = (loopDuration - viewOffset) * pxPerSec;
          if (lx < 0 || lx > trackWidth) return null;
          return (
            <div
              style={{
                position: "absolute",
                top: 0,
                left: lx,
                width: 1,
                height: "100%",
                background: "#3f3f46",
                opacity: 0.7,
                pointerEvents: "none",
              }}
            />
          );
        })()}
        {/* Playhead — red vertical line. */}
        {playheadVisible && (
          <div
            style={{
              position: "absolute",
              top: -2,
              left: playheadX - 1,
              width: 2,
              height: "calc(100% + 4px)",
              background: "#ef4444",
              pointerEvents: "none",
            }}
          />
        )}
        {/* Off-edge indicator when the playhead is outside the
            visible window. */}
        {playheadOffEdge && (
          <div
            style={{
              position: "absolute",
              top: 4,
              [playheadOffEdge]: 4,
              fontSize: 10,
              color: "#ef4444",
              pointerEvents: "none",
              lineHeight: 1,
            }}
          >
            {playheadOffEdge === "left" ? "◀" : "▶"}
          </div>
        )}
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

function formatTickLabel(sec: number): string {
  // Tabular display: drop trailing zeros for whole-seconds; show one
  // decimal for sub-second intervals so 0.5 doesn't render as "0".
  const abs = Math.abs(sec);
  if (abs < 1) return sec.toFixed(2).replace(/\.?0+$/, "") + "s" || "0s";
  if (Number.isInteger(sec)) return `${sec}s`;
  return `${sec.toFixed(1)}s`;
}

function PlaybackBarButton({
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
  const [hover, setHover] = useState(false);
  // Idle: muted grey so a static bar feels quiet. Hover brightens to
  // signal interactivity. Highlighted (e.g. playing) wins over both.
  const color = highlighted ? "#d1fae5" : hover ? "#e5e7eb" : "#71717a";
  const border = highlighted
    ? "#065f46"
    : hover
      ? "#3f3f46"
      : "#27272a";
  const background = highlighted
    ? "#047857"
    : hover
      ? "#1f1f23"
      : "#18181b";
  return (
    <button
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 28,
        height: 24,
        background,
        color,
        border: `1px solid ${border}`,
        borderRadius: 3,
        cursor: "pointer",
        fontSize: 12,
        lineHeight: 1,
        padding: 0,
        fontFamily: "inherit",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {children}
    </button>
  );
}

// Stroke-only icons. Use currentColor so PlaybackBarButton's hover/
// highlighted color flow through automatically.
function PlayIcon() {
  return (
    <svg width="10" height="12" viewBox="0 0 10 12" fill="none">
      <path
        d="M1.5 1 L8.5 6 L1.5 11 Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="10" height="12" viewBox="0 0 10 12" fill="none">
      <line
        x1="3"
        y1="1.5"
        x2="3"
        y2="10.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <line
        x1="7"
        y1="1.5"
        x2="7"
        y2="10.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ResetIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <line
        x1="2"
        y1="1.5"
        x2="2"
        y2="10.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M10 1.5 L4 6 L10 10.5 Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
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
        borderRadius: 3,
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
