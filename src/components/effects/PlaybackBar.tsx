"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { evalNumExpr } from "@/lib/num-expr";
import { wheelWantsZoom } from "./input-device";
import { useClock } from "@/state/playback-clock";

interface Props {
  fps: number;
  loopFrames: number | null;
  onPlayPause: () => void;
  onReset: () => void;
  onSeek: (time: number) => void;
  onScrubStart: () => void;
  onScrubEnd: () => void;
  onLoopFramesChange: (frames: number | null) => void;
  // Track (curves) editor toggle — rendered as a button by Play. Optional so
  // layouts that manage the track editor elsewhere can omit it.
  tracksOpen?: boolean;
  onToggleTracks?: () => void;
}

// Width-based picks for tick spacing, in frames. Tries ascending
// intervals until the minor-tick gap is at least MIN_TICK_PX wide.
// Major ticks land every 5th minor and carry the frame-number label.
const NICE_FRAME_INTERVALS = [
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 3000, 6000, 18000, 36000,
];
const MIN_TICK_PX = 12;

function pickFrameTickInterval(viewSpanFrames: number, trackWidthPx: number) {
  if (trackWidthPx <= 0)
    return NICE_FRAME_INTERVALS[NICE_FRAME_INTERVALS.length - 1];
  for (const iv of NICE_FRAME_INTERVALS) {
    const px = (iv / viewSpanFrames) * trackWidthPx;
    if (px >= MIN_TICK_PX) return iv;
  }
  return NICE_FRAME_INTERVALS[NICE_FRAME_INTERVALS.length - 1];
}

export default function PlaybackBar({
  fps,
  loopFrames,
  onPlayPause,
  onReset,
  onSeek,
  onScrubStart,
  onScrubEnd,
  onLoopFramesChange,
  tracksOpen,
  onToggleTracks,
}: Props) {
  // Clock reads come straight from the playback store — this component
  // re-renders per frame BY DESIGN (it draws the playhead + frame
  // readout); subscribing here keeps that off the shell's props.
  const time = useClock((s) => s.time);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  // Cursor x (px within the track) while hovering — drives the faded
  // playhead-preview line. Null when the cursor is off the track.
  const [hoverX, setHoverX] = useState<number | null>(null);
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
    const onMove = (ev: PointerEvent) => seekFromClientX(ev.clientX);
    const onUp = () => {
      setDragging(false);
      onScrubEnd();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    // pointercancel is what iPadOS sends instead of pointerup when it takes
    // the gesture — without it the scrub never ends and playback stays held.
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
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
      // Zoom on an explicit modifier OR when the device is a mouse (its wheel
      // zooms); otherwise a trackpad two-finger scroll pans the timeline.
      if (wheelWantsZoom(e)) {
        // Wheel → horizontal zoom anchored at the cursor.
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

  // Middle-drag pans the timeline; Cmd/Ctrl + middle-drag zooms the time axis
  // about the press point. stopPropagation keeps the preview canvas's
  // window-level middle-drag handler from also panning the canvas (bug #2).
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 1 || pxPerSec === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = el.getBoundingClientRect();
      const startX = e.clientX;
      const startY = e.clientY;
      const anchorX = startX - rect.left;
      const zoom = e.metaKey || e.ctrlKey;
      const startOffset = viewOffset;
      const startSpan = viewSpan;
      const startPxPerSec = pxPerSec;
      // Time-point under the press, held fixed while zooming.
      const tAt = startOffset + anchorX / startPxPerSec;
      const onMove = (ev: PointerEvent) => {
        if (zoom) {
          // Drag up zooms in (shrinks the visible span).
          const factor = Math.exp((ev.clientY - startY) * 0.005);
          const nextSpan = Math.max(0.1, Math.min(3600, startSpan * factor));
          setViewSpanOverride(nextSpan);
          const nextPxPerSec = trackWidth / nextSpan;
          setViewOffset(tAt - anchorX / nextPxPerSec);
        } else {
          setViewOffset(startOffset - (ev.clientX - startX) / startPxPerSec);
        }
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
  }, [pxPerSec, viewOffset, viewSpan, trackWidth]);

  const handleTrackPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    onScrubStart();
    setDragging(true);
    seekFromClientX(e.clientX);
  };

  // Build tick positions in pixels. Tick spacing is picked in frames
  // so labels read as integer frame numbers regardless of fps.
  const ticks = useMemo(() => {
    if (trackWidth === 0) return [];
    const viewSpanFrames = viewSpan * fps;
    const viewOffsetFrames = viewOffset * fps;
    const viewEndFrames = viewEnd * fps;
    const interval = pickFrameTickInterval(viewSpanFrames, trackWidth);
    const startTick = Math.floor(viewOffsetFrames / interval) * interval;
    const pxPerFrame = pxPerSec / fps;
    const out: { x: number; major: boolean; label: string | null }[] = [];
    // Major every 5 minor ticks. Compute the major epoch off zero so
    // labels stay aligned regardless of pan.
    for (let f = startTick; f <= viewEndFrames + interval; f += interval) {
      const x = (f - viewOffsetFrames) * pxPerFrame;
      if (x < -MIN_TICK_PX || x > trackWidth + MIN_TICK_PX) continue;
      const ratio = f / interval;
      const major = Math.round(ratio) % 5 === 0;
      out.push({
        x,
        major,
        label: major ? `${Math.round(f)}` : null,
      });
    }
    return out;
  }, [trackWidth, viewSpan, viewOffset, viewEnd, pxPerSec, fps]);

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
        background: "var(--tb-frame)",
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "0 12px",
        fontFamily: "var(--ui-font)",
        fontSize: 11,
        color: "var(--tb-n-16)",
        flexShrink: 0,
        width: "100%",
        boxSizing: "border-box",
      }}
    >
      <TransportButtons
        onPlayPause={onPlayPause}
        onReset={() => {
          onReset();
          // Re-frame the view so the playhead (now at t=0) is on screen.
          // Keep any zoom override the user dialed in — they probably
          // want to keep looking at the same scale, just from the start.
          setViewOffset(0);
        }}
      />
      {onToggleTracks && (
        <PlaybackBarButton
          title={tracksOpen ? "Hide Track Editor" : "Open Track Editor"}
          onClick={onToggleTracks}
          highlighted={tracksOpen}
        >
          <CurvesIcon />
        </PlaybackBarButton>
      )}

      <div
        ref={trackRef}
        onPointerDown={handleTrackPointerDown}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setHoverX(e.clientX - rect.left);
        }}
        onMouseLeave={() => setHoverX(null)}
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
          background: "var(--tb-n-0)",
          border: "1px solid var(--tb-n-7)",
          borderRadius: 3,
          cursor: "pointer",
          userSelect: "none",
          overflow: "hidden",
          // The scrub track owns its gesture end to end.
          touchAction: "none",
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
            background: "var(--tb-n-9)",
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
                background: t.major ? "var(--tb-n-10)" : "var(--tb-n-8)",
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
                  color: "var(--tb-n-10)",
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
                background: "var(--tb-n-9)",
                opacity: 0.7,
                pointerEvents: "none",
              }}
            />
          );
        })()}
        {/* Hover preview — a faded red line mirroring the playhead that
            tracks the cursor. Hidden while scrubbing, since the real
            playhead is already snapped to the cursor then. */}
        {hoverX != null && !dragging && (
          <div
            style={{
              position: "absolute",
              top: -2,
              left: hoverX - 1,
              width: 2,
              height: "calc(100% + 4px)",
              background: "var(--tb-a-red-500)",
              opacity: 0.3,
              pointerEvents: "none",
            }}
          />
        )}
        {/* Playhead — red vertical line. */}
        {playheadVisible && (
          <div
            style={{
              position: "absolute",
              top: -2,
              left: playheadX - 1,
              width: 2,
              height: "calc(100% + 4px)",
              background: "var(--tb-a-red-500)",
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
              color: "var(--tb-a-red-500)",
              pointerEvents: "none",
              lineHeight: 1,
            }}
          >
            {playheadOffEdge === "left" ? "◀" : "▶"}
          </div>
        )}
      </div>

      <LoopInput value={loopFrames} onCommit={onLoopFramesChange} />

      <FrameInput
        frame={Math.floor(time * fps)}
        onJump={(f) => onSeek(f / fps)}
      />
    </div>
  );
}

// Play + skip-to-start. Shared with the timeline dock header so both
// surfaces stay one visual and one click-handler pair. Subscribes to
// `playing` here so a second mount doesn't force EffectsApp to tick.
export function TransportButtons({
  onPlayPause,
  onReset,
}: {
  onPlayPause: () => void;
  onReset: () => void;
}) {
  const playing = useClock((s) => s.playing);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <PlaybackBarButton title="Reset to start" onClick={onReset}>
        <ResetIcon />
      </PlaybackBarButton>
      <PlaybackBarButton
        title={playing ? "Pause" : "Play"}
        onClick={onPlayPause}
        highlighted={playing}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </PlaybackBarButton>
    </div>
  );
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
  const color = highlighted ? "var(--tb-t-cyan-l-0)" : hover ? "var(--tb-n-16)" : "var(--tb-n-11)";
  const border = highlighted
    ? "var(--tb-a-emerald-800)"
    : hover
      ? "var(--tb-n-9)"
      : "var(--tb-n-7)";
  const background = highlighted
    ? "#047857"
    : hover
      ? "var(--tb-n-5)"
      : "var(--tb-n-0)";
  return (
    <button
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 28,
        height: 20,
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
function CurvesIcon() {
  // An ease curve between two keyframe dots — the track/curves editor.
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <path
        d="M1.5 11 C 5 11, 5 2, 11.5 2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <circle cx="1.5" cy="11" r="1.4" fill="currentColor" />
      <circle cx="11.5" cy="2" r="1.4" fill="currentColor" />
    </svg>
  );
}

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

// Chevron step button living inside a counter rect, flush with its edge —
// one click steps the value by a single frame, saving a focus-type-enter
// round trip. Borderless: the wrapping rect owns the border/background.
function StepChevron({
  dir,
  title,
  disabled,
  onStep,
}: {
  dir: "left" | "right";
  title: string;
  disabled?: boolean;
  onStep: () => void;
}) {
  const [hover, setHover] = useState(false);
  const active = hover && !disabled;
  return (
    <button
      onClick={onStep}
      title={title}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 14,
        alignSelf: "stretch",
        background: active ? "var(--tb-n-5)" : "transparent",
        color: disabled ? "var(--tb-n-9)" : active ? "var(--tb-n-16)" : "var(--tb-n-11)",
        border: "none",
        cursor: disabled ? "default" : "pointer",
        padding: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "inherit",
      }}
    >
      <svg width="7" height="9" viewBox="0 0 7 9" fill="none">
        <path
          d={dir === "left" ? "M5 1 L2 4.5 L5 8" : "M2 1 L5 4.5 L2 8"}
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

// Shared shell for the counter fields: one bordered rect holding both
// chevrons and the bare input, so the steppers read as part of the counter
// rather than separate buttons. overflow hidden keeps hover fills inside
// the rounded corners.
function counterRectStyle(focused: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "stretch",
    background: "var(--tb-n-0)",
    border: `1px solid ${focused ? "var(--tb-n-9)" : "var(--tb-n-7)"}`,
    borderRadius: 3,
    overflow: "hidden",
  };
}

// Current-frame readout that doubles as a jump field: shows the live frame
// while idle, and on entering a number seeks to that frame. Editing freezes
// the displayed value so playback updates don't fight what you're typing.
function FrameInput({
  frame,
  onJump,
}: {
  frame: number;
  onJump: (frame: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(frame));
  const commit = () => {
    setEditing(false);
    const p = evalNumExpr(draft); // plain numbers or math: "24*8", "300/2"
    const n = p === null ? NaN : Math.round(p);
    if (!Number.isFinite(n) || n < 0) {
      setDraft(String(frame));
      return;
    }
    onJump(n);
  };
  return (
    <div style={counterRectStyle(editing)}>
      <StepChevron
        dir="left"
        title="Back one frame"
        disabled={frame <= 0}
        onStep={() => onJump(Math.max(0, frame - 1))}
      />
      <input
        type="text"
        value={editing ? draft : String(frame)}
        title="Current frame — type a frame number to jump there"
        onFocus={() => {
          setDraft(String(frame));
          setEditing(true);
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          else if (e.key === "Escape") {
            setEditing(false);
            (e.target as HTMLInputElement).blur();
          }
        }}
        style={{
          width: 40,
          background: "transparent",
          border: "none",
          outline: "none",
          color: "var(--tb-n-13)",
          fontFamily: "inherit",
          fontSize: 11,
          padding: "2px 0",
          textAlign: "center",
          fontVariantNumeric: "tabular-nums",
        }}
      />
      <StepChevron
        dir="right"
        title="Forward one frame"
        onStep={() => onJump(frame + 1)}
      />
    </div>
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
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    setDraft(value == null ? "" : String(value));
  }, [value]);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      if (value !== null) onCommit(null);
      return;
    }
    const p = evalNumExpr(trimmed); // plain numbers or math: "24*8", "300/2"
    const n = p === null ? NaN : Math.round(p);
    if (!Number.isFinite(n) || n < 1) {
      setDraft(value == null ? "" : String(value));
      return;
    }
    if (n !== value) onCommit(n);
  };
  return (
    <div style={counterRectStyle(focused)}>
      <StepChevron
        dir="left"
        title="Loop length −1 frame"
        disabled={value == null || value <= 1}
        onStep={() => {
          if (value != null && value > 1) onCommit(value - 1);
        }}
      />
      <input
        type="text"
        value={draft}
        placeholder="Loop"
        title="Loop length in frames — empty plays without looping"
        onFocus={() => setFocused(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          else if (e.key === "Escape") {
            setDraft(value == null ? "" : String(value));
            (e.target as HTMLInputElement).blur();
          }
        }}
        style={{
          width: 40,
          background: "transparent",
          border: "none",
          outline: "none",
          color: "var(--tb-n-16)",
          fontFamily: "inherit",
          fontSize: 11,
          padding: "2px 0",
          textAlign: "center",
        }}
      />
      <StepChevron
        dir="right"
        title="Loop length +1 frame"
        onStep={() => onCommit((value ?? 0) + 1)}
      />
    </div>
  );
}

