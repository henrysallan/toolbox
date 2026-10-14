"use client";

// Timeline markers on the playhead ruler (specdocs/101326_skia-target.md
// §3.5a, M3 lane B) — shared by the Tracks and Layers editors. The marker
// model and its segments are lib/timeline-markers.ts; this is only the
// drawing and the gestures:
//
//   click a chip          jump the playhead to the marker
//   drag a chip           move it (whole frames)
//   drag a range's end    resize the range
//   double-click a chip   rename it inline
//   right-click a chip    jump / rename / set range end at playhead /
//                         clear range / delete
//   right-click the ruler add a marker at the playhead or at that frame
//                         (the host ruler forwards its contextmenu through
//                         the MarkerRulerHandle)
//
// Point markers draw a thin band along the ruler's bottom edge for their
// segment (to the next point marker, or the scene end); ranged markers a
// band behind the chip. A chip whose marker has a problem (repeated name,
// past the scene end, empty span) is dashed / dimmed, with the reason in its
// tooltip. Edits commit once per gesture through `onChange`, which the
// editor turns into one undo step.

import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import type { ProjectTimeline } from "@/engine/keyframes";
import {
  addMarker,
  deriveSegments,
  removeMarker,
  updateMarker,
  type TimelineMarker,
} from "@/lib/timeline-markers";
import { playbackClock } from "@/state/playback-clock";
import { usePanelWindow } from "../layout/panel-window";
import {
  COLOR_BORDER,
  COLOR_MARKER,
  COLOR_MARKER_CHIP,
  COLOR_MARKER_SPAN,
  COLOR_MARKER_SPAN_ALT,
  COLOR_MARKER_TEXT,
  COLOR_MUTED,
  COLOR_TEXT,
} from "./theme";

export interface MarkerRulerProps {
  markers: readonly TimelineMarker[];
  timeline: ProjectTimeline;
  // The host ruler's transforms (px relative to the ruler's left edge).
  tickToPx(tick: number): number;
  pxToTick(px: number): number;
  // Visible ruler width, px. (The strip fills its host ruler's height.)
  width: number;
  // Omit for a read-only strip (click still jumps).
  onChange?(next: TimelineMarker[], label: string): void;
  onSeek(tick: number): void;
}

export interface MarkerRulerHandle {
  // Forward the host ruler's contextmenu (empty ruler space) here.
  onRulerContextMenu(e: ReactMouseEvent<HTMLElement>): void;
}

const CHIP_H = 12;
const CHIP_MAX_W = 160;
const DRAG_SLOP_PX = 3;

type Drag = {
  id: string;
  kind: "move" | "end";
  pointerId: number;
  startX: number;
  origFrame: number;
  origDuration: number;
  moved: boolean;
};

type Menu = {
  x: number;
  y: number;
  // null = the ruler's empty space.
  markerId: string | null;
  // The frame under the cursor.
  frame: number;
};

export const MarkerRuler = forwardRef<MarkerRulerHandle, MarkerRulerProps>(function MarkerRuler(
  { markers, timeline, tickToPx, pxToTick, width, onChange, onSeek },
  ref
) {
  const panelWin = usePanelWindow();
  const tpf = timeline.ticksPerFrame;
  const durationFrames = timeline.sceneDurationTicks / tpf;
  const maxFrame = Math.max(0, Math.ceil(durationFrames) - 1);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [preview, setPreview] = useState<{ id: string; frame: number; duration?: number } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);

  // What draws: the markers with the in-flight drag applied.
  const shown = useMemo(
    () =>
      preview
        ? updateMarker(markers, preview.id, {
            frame: preview.frame,
            ...(preview.duration !== undefined ? { duration: preview.duration } : {}),
          })
        : [...markers],
    [markers, preview]
  );
  const derived = useMemo(() => deriveSegments(shown, durationFrames), [shown, durationFrames]);
  const problemOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of derived.issues) if (!m.has(i.markerId)) m.set(i.markerId, i.message);
    return m;
  }, [derived]);
  const dupIds = useMemo(
    () => new Set(derived.issues.filter((i) => i.code === "duplicate-name").map((i) => i.markerId)),
    [derived]
  );

  const xOf = (frame: number) => tickToPx(frame * tpf);
  const pxPerFrame = Math.max(1e-6, tickToPx(tpf) - tickToPx(0));
  const playheadFrame = () => Math.round(playbackClock.get().tick / tpf);

  const commit = (next: TimelineMarker[], label: string) => onChange?.(next, label);

  // Rebuilt every render (no deps) so it always sees the current transforms.
  useImperativeHandle(ref, () => ({
    onRulerContextMenu(e) {
      if (!onChange) return;
      e.preventDefault();
      // The host ruler shares the transforms' origin (its left edge).
      const left = e.currentTarget.getBoundingClientRect().left;
      const frame = Math.min(maxFrame, Math.max(0, Math.round(pxToTick(e.clientX - left) / tpf)));
      setMenu({ x: e.clientX, y: e.clientY, markerId: null, frame });
    },
  }));

  const startDrag = (e: ReactPointerEvent<HTMLElement>, m: TimelineMarker, kind: Drag["kind"]) => {
    if (e.button !== 0) return;
    // The ruler under us scrubs on pointerdown — a marker gesture is not a
    // scrub. (No preventDefault: that would also swallow the dblclick.)
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({
      id: m.id,
      kind,
      pointerId: e.pointerId,
      startX: e.clientX,
      origFrame: m.frame,
      origDuration: m.duration ?? 0,
      moved: false,
    });
  };
  const moveDrag = (e: ReactPointerEvent<HTMLElement>) => {
    if (!drag || drag.pointerId !== e.pointerId || !onChange) return;
    const dx = e.clientX - drag.startX;
    if (!drag.moved && Math.abs(dx) < DRAG_SLOP_PX) return;
    if (!drag.moved) setDrag({ ...drag, moved: true });
    const df = Math.round(dx / pxPerFrame);
    if (drag.kind === "move") {
      setPreview({ id: drag.id, frame: Math.min(maxFrame, Math.max(0, drag.origFrame + df)) });
    } else {
      setPreview({ id: drag.id, frame: drag.origFrame, duration: Math.max(1, drag.origDuration + df) });
    }
  };
  const endDrag = (e: ReactPointerEvent<HTMLElement>, cancelled = false) => {
    if (!drag || drag.pointerId !== e.pointerId) return;
    const d = drag;
    const p = preview;
    setDrag(null);
    setPreview(null);
    if (cancelled) return;
    if (d.moved && p) {
      const m = markers.find((x) => x.id === d.id);
      if (!m) return;
      if (d.kind === "move" && p.frame !== m.frame) commit(updateMarker(markers, d.id, { frame: p.frame }), `Move marker "${m.name}"`);
      if (d.kind === "end" && p.duration !== m.duration) commit(updateMarker(markers, d.id, { duration: p.duration }), `Resize marker "${m.name}"`);
    } else if (!d.moved && d.kind === "move") {
      onSeek(d.origFrame * tpf);
    }
  };

  // Enter, Escape and blur can all end one edit; only the first counts.
  const editDone = useRef<string | null>(null);
  const beginRename = (id: string) => {
    editDone.current = null;
    setEditing(id);
  };
  const endRename = (id: string, value: string | null) => {
    if (editDone.current === id) return;
    editDone.current = id;
    setEditing(null);
    const m = markers.find((x) => x.id === id);
    if (!m || value === null) return;
    const next = updateMarker(markers, id, { name: value });
    if (next.find((x) => x.id === id)?.name !== m.name) commit(next, `Rename marker "${m.name}"`);
  };

  const add = (frame: number) => {
    const r = addMarker(markers, frame);
    commit(r.markers, "Add marker");
    beginRename(r.id);
  };

  // Chained ("next") segment bands, alternating weight so neighbours read apart.
  const bands = derived.segments.filter((s) => s.kind === "next");
  const visible = (x0: number, x1: number) => x1 >= -2 && x0 <= width + 2;

  return (
    <div
      data-marker-ruler=""
      style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }}
    >
      {bands.map((s, i) => {
        const x0 = xOf(s.startFrame);
        const x1 = xOf(s.endFrame);
        if (!visible(x0, x1)) return null;
        return (
          <div
            key={`band-${s.markerId}`}
            style={{
              position: "absolute",
              left: x0,
              width: Math.max(1, x1 - x0 - 1),
              bottom: 0,
              height: 2,
              background: i % 2 ? COLOR_MARKER_SPAN_ALT : COLOR_MARKER,
              opacity: 0.7,
            }}
          />
        );
      })}
      {shown.map((m, i) => {
        const x = xOf(m.frame);
        const xe = m.duration !== undefined ? xOf(m.frame + m.duration) : x;
        const next = shown[i + 1];
        const room = next ? xOf(next.frame) - x - 3 : CHIP_MAX_W;
        if (!visible(x, Math.max(xe, x + Math.min(CHIP_MAX_W, Math.max(room, 0))))) return null;
        const problem = problemOf.get(m.id);
        const dimmed = !!problem && !dupIds.has(m.id);
        const dragging = drag?.id === m.id && drag.moved;
        const tip =
          `${m.name} — frame ${m.frame}${m.duration !== undefined ? `–${m.frame + m.duration}` : ""}` +
          (problem ? `\n${problem}` : "") +
          (onChange ? "\nClick to jump · drag to move · double-click to rename · right-click for more" : "");
        return (
          <div key={m.id} style={{ opacity: dimmed ? 0.45 : 1 }}>
            {m.duration !== undefined && (
              <div
                style={{
                  position: "absolute",
                  left: x,
                  width: Math.max(1, xe - x),
                  top: 0,
                  height: CHIP_H + 1,
                  background: COLOR_MARKER_SPAN,
                  borderRight: `1px solid ${COLOR_MARKER}`,
                }}
              />
            )}
            <div
              style={{
                position: "absolute",
                left: x,
                top: 0,
                bottom: 0,
                width: 1,
                background: COLOR_MARKER,
                opacity: 0.9,
              }}
            />
            {editing === m.id ? (
              <input
                autoFocus
                defaultValue={m.name}
                maxLength={64}
                onFocus={(e) => e.currentTarget.select()}
                // The editors focus their own container on mousedown; a click
                // inside the field must not blur it.
                onPointerDown={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") endRename(m.id, e.currentTarget.value);
                  else if (e.key === "Escape") endRename(m.id, null);
                }}
                onBlur={(e) => endRename(m.id, e.currentTarget.value)}
                style={{
                  position: "absolute",
                  left: x,
                  top: 0,
                  height: CHIP_H + 1,
                  width: 120,
                  boxSizing: "border-box",
                  padding: "0 4px",
                  font: "9px/1 var(--ui-font)",
                  color: COLOR_TEXT,
                  background: "var(--tb-n-2)",
                  border: `1px solid ${COLOR_MARKER}`,
                  borderRadius: "0 3px 3px 0",
                  outline: "none",
                  pointerEvents: "auto",
                  zIndex: 3,
                }}
              />
            ) : (
              <div
                title={tip}
                onPointerDown={(e) => startDrag(e, m, "move")}
                onPointerMove={moveDrag}
                onPointerUp={(e) => endDrag(e)}
                onPointerCancel={(e) => endDrag(e, true)}
                onDoubleClick={(e) => {
                  if (!onChange) return;
                  e.stopPropagation();
                  beginRename(m.id);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (!onChange) return;
                  setMenu({ x: e.clientX, y: e.clientY, markerId: m.id, frame: m.frame });
                }}
                style={{
                  position: "absolute",
                  left: x,
                  top: 0,
                  height: CHIP_H,
                  maxWidth: Math.max(8, Math.min(CHIP_MAX_W, room)),
                  boxSizing: "border-box",
                  padding: "0 4px",
                  font: "9px/11px var(--ui-font)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  color: COLOR_MARKER_TEXT,
                  background: COLOR_MARKER_CHIP,
                  border: `1px ${dupIds.has(m.id) ? "dashed" : "solid"} ${COLOR_MARKER}`,
                  borderLeftWidth: 0,
                  borderRadius: "0 3px 3px 0",
                  cursor: onChange ? (dragging ? "grabbing" : "grab") : "pointer",
                  pointerEvents: "auto",
                  touchAction: "none",
                  zIndex: dragging ? 2 : 1,
                }}
              >
                {m.name}
              </div>
            )}
            {m.duration !== undefined && onChange && editing !== m.id && (
              <div
                title={`Drag to resize "${m.name}"`}
                onPointerDown={(e) => startDrag(e, m, "end")}
                onPointerMove={moveDrag}
                onPointerUp={(e) => endDrag(e)}
                onPointerCancel={(e) => endDrag(e, true)}
                style={{
                  position: "absolute",
                  left: xe - 3,
                  top: 0,
                  width: 6,
                  height: CHIP_H + 1,
                  cursor: "ew-resize",
                  pointerEvents: "auto",
                  touchAction: "none",
                  zIndex: 1,
                }}
              />
            )}
          </div>
        );
      })}
      {menu &&
        createPortal(
          <MarkerMenu
            menu={menu}
            marker={menu.markerId ? markers.find((m) => m.id === menu.markerId) ?? null : null}
            playheadFrame={playheadFrame()}
            onClose={() => setMenu(null)}
            onJump={(f) => onSeek(f * tpf)}
            onAdd={add}
            onRename={beginRename}
            onSetEnd={(m, f) => commit(updateMarker(markers, m.id, { duration: f - m.frame }), `Set range of "${m.name}"`)}
            onClearRange={(m) => commit(updateMarker(markers, m.id, { duration: undefined }), `Clear range of "${m.name}"`)}
            onDelete={(m) => commit(removeMarker(markers, m.id), `Delete marker "${m.name}"`)}
          />,
          // This editor's OWN body — a popped-out timeline must not drop its
          // menu into the main window.
          (panelWin ?? window).document.body
        )}
    </div>
  );
});

interface MarkerMenuProps {
  menu: Menu;
  marker: TimelineMarker | null;
  playheadFrame: number;
  onClose(): void;
  onJump(frame: number): void;
  onAdd(frame: number): void;
  onRename(id: string): void;
  onSetEnd(m: TimelineMarker, frame: number): void;
  onClearRange(m: TimelineMarker): void;
  onDelete(m: TimelineMarker): void;
}

function MarkerMenu({ menu, marker, playheadFrame, onClose, onJump, onAdd, onRename, onSetEnd, onClearRange, onDelete }: MarkerMenuProps) {
  // One plain row; disabled rows stay visible (muted) so the menu keeps its shape.
  const item = (label: string, run: () => void, opts: { disabled?: boolean; hint?: string } = {}) => (
    <div
      key={label}
      onClick={() => {
        if (opts.disabled) return;
        onClose();
        run();
      }}
      style={{
        padding: "6px 10px",
        cursor: opts.disabled ? "default" : "pointer",
        color: opts.disabled ? COLOR_MUTED : COLOR_TEXT,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 12,
      }}
      onMouseEnter={(e) => {
        if (!opts.disabled) e.currentTarget.style.background = "var(--tb-n-7)";
      }}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <span>{label}</span>
      {opts.hint && <span style={{ color: COLOR_MUTED, fontVariantNumeric: "tabular-nums" }}>{opts.hint}</span>}
    </div>
  );
  const divider = (k: string) => <div key={k} style={{ height: 1, background: COLOR_BORDER, margin: "2px 0" }} />;
  return (
    <>
      {/* Click-away layer. */}
      <div
        onPointerDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
        style={{ position: "fixed", inset: 0, zIndex: 999 }}
      />
      <div
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          position: "fixed",
          left: menu.x,
          top: menu.y,
          zIndex: 1000,
          background: "var(--tb-n-4)",
          color: COLOR_TEXT,
          border: `1px solid ${COLOR_BORDER}`,
          borderRadius: 4,
          boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
          minWidth: 180,
          fontSize: 12,
          fontFamily: "var(--ui-font)",
        }}
      >
        {marker ? (
          <>
            {item("Jump to marker", () => onJump(marker.frame), { hint: `f${marker.frame}` })}
            {item("Rename…", () => onRename(marker.id))}
            {divider("d1")}
            {item("Set range end at playhead", () => onSetEnd(marker, playheadFrame), {
              disabled: playheadFrame <= marker.frame,
              hint: `f${playheadFrame}`,
            })}
            {item("Clear range", () => onClearRange(marker), { disabled: marker.duration === undefined })}
            {divider("d2")}
            {item("Delete marker", () => onDelete(marker))}
          </>
        ) : (
          <>
            {item("Add marker at playhead", () => onAdd(playheadFrame), { hint: `f${playheadFrame}` })}
            {item("Add marker here", () => onAdd(menu.frame), { hint: `f${menu.frame}` })}
          </>
        )}
      </div>
    </>
  );
}
