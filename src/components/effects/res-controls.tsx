"use client";

import { useEffect, useRef, useState } from "react";
import { evalNumExpr } from "@/lib/num-expr";

// Shared resolution controls: the scrub-to-type numeric field, the
// aspect-lock chain toggle, and the preset list. Used by both resolution
// editors — the file-name dropdown (FileNameMenu) and Project Settings
// (ParamPanel) — so the two stay one design.

export const MIN_RES = 16;
export const MAX_RES = 8192;
// Pointer travel before a press on a res field counts as a scrub rather
// than a click-to-type. Matches AutoLayoutPanel's NumInput.
const SCRUB_PX = 3;

export const RES_PRESETS: Array<{ label: string; w: number; h: number }> = [
  { label: "512 × 512", w: 512, h: 512 },
  { label: "1024 × 1024", w: 1024, h: 1024 },
  { label: "2048 × 2048", w: 2048, h: 2048 },
  { label: "1280 × 720", w: 1280, h: 720 },
  { label: "1920 × 1080", w: 1920, h: 1080 },
  { label: "3840 × 2160", w: 3840, h: 2160 },
];

// Aspect lock. The ratio is snapshotted at the START of each gesture
// (pointer-down / entering type mode) rather than held in state: a
// scrub re-renders the parent on every frame, so reading the live
// canvasRes mid-drag would compound integer rounding and let the ratio
// drift. Snapshotting per-gesture is also self-healing — a project load
// or a preset pick between gestures is picked up for free.
export function useAspectLock(
  canvasRes: [number, number],
  onCanvasResChange: (res: [number, number]) => void
) {
  const [locked, setLocked] = useState(false);
  const ratioRef = useRef<number | null>(null);
  const snapRatio = () => {
    ratioRef.current = canvasRes[1] > 0 ? canvasRes[0] / canvasRes[1] : 1;
  };
  const clampRes = (n: number) =>
    Math.min(MAX_RES, Math.max(MIN_RES, Math.round(n)));
  // Locked edits drive the opposite axis off the snapshotted ratio. The
  // derived side is clamped independently, so pushing one axis to the
  // 16/8192 rail bends the ratio rather than blocking the drag.
  const applyWidth = (w: number) => {
    const r = ratioRef.current;
    if (locked && r && r > 0) onCanvasResChange([w, clampRes(w / r)]);
    else onCanvasResChange([w, canvasRes[1]]);
  };
  const applyHeight = (h: number) => {
    const r = ratioRef.current;
    if (locked && r && r > 0) onCanvasResChange([clampRes(h * r), h]);
    else onCanvasResChange([canvasRes[0], h]);
  };
  const toggle = () => {
    if (!locked) snapRatio();
    setLocked((v) => !v);
  };
  return { locked, toggle, snapRatio, applyWidth, applyHeight };
}

// Chain toggle between the W/H fields. Locked draws the connecting bar
// and makes an edit to either side drive the other.
export function AspectLock({
  locked,
  onToggle,
}: {
  locked: boolean;
  onToggle: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onToggle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-pressed={locked}
      aria-label="Lock aspect ratio"
      title={
        locked
          ? "Aspect ratio locked — editing one side scales the other. Click to unlink."
          : "Aspect ratio unlocked — width and height move independently. Click to link."
      }
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 18,
        height: 18,
        padding: 0,
        flexShrink: 0,
        background: "transparent",
        border: "none",
        color: locked
          ? "var(--tb-a-blue-400)"
          : hover
            ? "var(--tb-n-14)"
            : "var(--tb-n-10)",
        cursor: "pointer",
        transition: "color 120ms",
      }}
    >
      <svg
        width={14}
        height={14}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        aria-hidden
      >
        <path d="M9 17H7A5 5 0 0 1 7 7h2" />
        <path d="M15 7h2a5 5 0 1 1 0 10h-2" />
        {locked && <path d="M8 12h8" />}
      </svg>
    </button>
  );
}

// Numeric field. Drag horizontally to scrub, click to type (math
// expressions allowed: "1920/2"). Ported from AutoLayoutPanel's NumInput
// so the numeric fields behave identically everywhere.
export function ResField({
  label,
  value,
  onCommit,
  onGestureStart,
  min = MIN_RES,
  max = MAX_RES,
  perPx = 2,
}: {
  label: string;
  value: number;
  onCommit: (n: number) => void;
  // Fired before the value can change — lets the parent snapshot the
  // aspect ratio for the duration of the gesture.
  onGestureStart?: () => void;
  min?: number;
  max?: number;
  // Value change per pixel of drag. 2 sweeps the usual 512–4096
  // resolution range; smaller ranges (fps, bpm) want 1. Shift = ×0.25.
  perPx?: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // Latest value/callbacks reachable from the pointer handlers without
  // re-binding them mid-drag.
  const valueRef = useRef(value);
  const onCommitRef = useRef(onCommit);
  const onGestureStartRef = useRef(onGestureStart);
  useEffect(() => {
    valueRef.current = value;
    onCommitRef.current = onCommit;
    onGestureStartRef.current = onGestureStart;
  });
  const scrub = useRef<{
    startX: number;
    startVal: number;
    moved: boolean;
  } | null>(null);
  const raf = useRef<number | null>(null);
  const pending = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (raf.current != null) cancelAnimationFrame(raf.current);
    },
    []
  );

  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const emit = (v: number) => {
    const r = Math.round(v);
    if (r !== valueRef.current) onCommitRef.current(r);
  };
  // Coalesce scrub updates to one per frame — each commit re-renders the
  // panel and re-evaluates the pipeline at the new resolution.
  const flush = () => {
    raf.current = null;
    if (pending.current != null) {
      emit(pending.current);
      pending.current = null;
    }
  };
  const queue = (v: number) => {
    pending.current = v;
    if (raf.current == null) raf.current = requestAnimationFrame(flush);
  };
  // Commit the in-flight value synchronously on release: closing the
  // dropdown right after a drag unmounts us, and the cleanup below would
  // otherwise cancel the frame still holding the user's final value.
  const flushNow = () => {
    if (raf.current != null) {
      cancelAnimationFrame(raf.current);
      raf.current = null;
    }
    if (pending.current != null) {
      emit(pending.current);
      pending.current = null;
    }
  };

  const beginEdit = () => {
    onGestureStartRef.current?.();
    setDraft(String(valueRef.current));
    setEditing(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  };
  const commit = (raw: string) => {
    setEditing(false); // display falls back to `value` — invalid input reverts
    const p = evalNumExpr(raw); // plain numbers or math: "1920/2", "24*8"
    const n = p === null ? NaN : Math.round(p);
    if (!Number.isFinite(n) || n < min || n > max) return;
    emit(n);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLInputElement>) => {
    if (editing || e.button !== 0) return;
    e.preventDefault(); // decide click-vs-scrub on release
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture unsupported — events still fire */
    }
    onGestureStartRef.current?.();
    scrub.current = {
      startX: e.clientX,
      startVal: valueRef.current,
      moved: false,
    };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLInputElement>) => {
    const s = scrub.current;
    if (!s) return;
    const dx = e.clientX - s.startX;
    if (!s.moved && Math.abs(dx) < SCRUB_PX) return;
    s.moved = true;
    queue(clamp(s.startVal + dx * (e.shiftKey ? 0.25 : 1) * perPx));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLInputElement>) => {
    const s = scrub.current;
    scrub.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (s?.moved) flushNow();
    else if (s) beginEdit(); // clean click → type
  };
  const onPointerCancel = () => {
    if (scrub.current?.moved) flushNow();
    scrub.current = null;
  };

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="decimal"
      aria-label={label}
      title="Drag to scrub · click to type"
      value={editing ? draft : String(value)}
      onChange={(e) => editing && setDraft(e.target.value)}
      onMouseDown={(e) => {
        if (!editing) e.preventDefault(); // suppress focus until release
      }}
      onFocus={() => {
        if (!editing) beginEdit();
      }}
      onBlur={(e) => editing && commit(e.target.value)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        else if (e.key === "Escape") {
          setEditing(false);
          (e.target as HTMLInputElement).blur();
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          onGestureStartRef.current?.();
          const d = (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1);
          emit(clamp((valueRef.current || 0) + d));
        }
      }}
      style={{
        // border-box: there's no global reset, and the padding bump would
        // otherwise widen these and starve the preset select beside them.
        width: 60,
        // Matched to the preset Dropdown and the visibility toggle so the
        // controls beside each other share one height.
        height: 30,
        boxSizing: "border-box",
        background: "var(--tb-n-0)",
        border: "1px solid var(--tb-n-7)",
        color: "var(--tb-n-16)",
        fontFamily: "inherit",
        fontSize: 11,
        borderRadius: 10,
        padding: "0 10px",
        outline: "none",
        cursor: editing ? "text" : "ew-resize",
      }}
    />
  );
}
