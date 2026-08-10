"use client";

// MIDI piano-roll editor (specdocs/080926_midi-editor.md).
//
// Mounted by EffectsApp as a FULL-COVER sibling inside the primary
// viewport's clip wrapper while a MIDI Editor node is engaged
// (double-click / header Edit button). The preview canvas underneath
// stays mounted and evaluating — this component only covers it.
//
// M0: shell — keyboard gutter, bar/beat ruler, grid, playhead (with
// seek), pan/zoom. M1 (here): the Logic editing grammar —
// select/marquee/move/resize/delete/duplicate/velocity, Shift copy-drag,
// hold-B pencil, snap menu, copy/paste, F-fit. Every clip mutation goes
// through the
// pure note-ops.ts policy; commits are ONE onNotesChange per gesture
// with a nextGestureKey so undo lands one entry per gesture. M2 (here):
// audition via onPreviewNote (keybed click, pencil add, note-grab,
// throttled move-pitch), keybed pressed/selection highlights, and the
// loop-end marker with post-loop dimming.
//
// Hard constraints (see the spec's sharp-edges section):
//  - Never subscribe to the playback clock at this component's top level;
//    only PlayheadChrome leaves may re-render during playback.
//  - Own the wheel + middle-mouse events (container-level listeners,
//    preventDefault + stopPropagation) or the viewport pan/zoom
//    underneath bleeds through (TrackEditor.tsx:669-791 is the model).
//  - Esc closes via onClose; the hold-key hygiene rules apply to every
//    future quasimode (clear on keyup AND window blur).
//
// Coordinates: the note grid spans the editor's FULL width and the
// keybed gutter floats over its left edge (TrackEditor's label-card
// convention) — that is the convention `fit(width, dur, gutterPx)` and
// the ruler's tickToPx already assume, so playhead, ruler and notes all
// share one x origin with no per-layer offset.

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { NoteEvent } from "@/engine/types";
import { beatsToTicks } from "@/engine/audio-chain";
import { useTimelineView } from "../timeline/view";
import { LaneFrameTicks } from "../timeline/FrameTicks";
import { PlayheadHandle, PlayheadLine } from "../timeline/PlayheadChrome";
import {
  CLIP_EDGE_PX,
  COLOR_BG,
  COLOR_BORDER,
  COLOR_KEY_BLACK,
  COLOR_KEY_LABEL,
  COLOR_KEY_PRESSED,
  COLOR_KEY_SELECTED_BLACK,
  COLOR_KEY_SELECTED_WHITE,
  COLOR_KEY_WHITE,
  COLOR_KEYBED_SEP,
  COLOR_LOOP_DIM,
  COLOR_LOOP_MARKER,
  COLOR_MUTED,
  COLOR_NOTE_SELECTED_BORDER,
  COLOR_NOTE_STRIPE,
  COLOR_PITCH_OCTAVE_LINE,
  COLOR_PITCH_ROW_BLACK_BG,
  COLOR_TEXT,
  FIT_PAD,
  KEYBOARD_GUTTER_PX,
  LOOP_SILENT_NOTE_OPACITY,
  MARQUEE_BORDER,
  MARQUEE_FILL,
  NOTE_MIN_WIDTH_PX,
  RULER_HEIGHT,
  ZOOM_SENSITIVITY,
  noteVelocityBorder,
  noteVelocityFill,
} from "../timeline/theme";
import { clampPixelsPerTick } from "../timeline/view";
import { nextGestureKey } from "../timeline/keyframe-ops";
import { getEffectiveDevice } from "../input-device";
import { getShortcutScope } from "../shortcut-scope";
import { useCoarsePointer } from "@/lib/pointer-drag";
import { Dropdown } from "@/lib/param-controls";
import { BeatRuler, beatSpacing } from "./beat-ruler";
import {
  clampPitchOffset,
  PITCH_MAX,
  PITCH_MIN,
  usePitchView,
} from "./pitch-view";
import {
  addNote,
  adjustVelocity,
  cloneNotesForDrag,
  deleteNotes,
  duplicateNotes,
  ensureNoteIds,
  moveNotes,
  resizeNotes,
} from "./note-ops";
import {
  copyNotesToClipboard,
  DEFAULT_SNAP,
  pasteNotesFromClipboard,
  SNAP_OPTIONS,
  snapTicksFor,
  type SnapOption,
} from "./interaction";

export interface MidiEditorProps {
  nodeId: string;
  // The node's authored clip — READ-ONLY in M0 (M1 adds onNotesChange).
  notes: NoteEvent[];
  // Musical grid inputs. Note DATA is absolute integer scene ticks; only
  // the drawn grid derives from bpm.
  bpm: number;
  fps: number;
  ticksPerFrame: number;
  sceneDurationTicks: number;
  // Ruler click / playhead drag → scene seek (EffectsApp handleSeekTick).
  onSeekTick: (tick: number) => void;
  // Commit ONE new clip per user-visible gesture (release-only during
  // drags), with a nextGestureKey coalesce key so undo lands one entry
  // per gesture (M1; note-ops.ts owns the mutation policy).
  onNotesChange: (next: NoteEvent[], gestureKey: string) => void;
  // Velocity for pencil-drawn notes (the node's default_velocity param).
  defaultVelocity: number;
  // One-shot audition (M2): EffectsApp routes this to
  // audioEngine.previewNote through the wired downstream instrument (or
  // the fallback synth). Fire-and-forget; works with the transport
  // stopped (the engine's preview path handles the closed master).
  onPreviewNote: (pitch: number, velocity: number, durationSec: number) => void;
  // Region-loop params (mirrored from the node so the grid can draw the
  // loop marker + dim the silent post-loop area; the DEF does the actual
  // note tiling at compute).
  loopEnabled: boolean;
  loopEndBars: number;
  // Esc (and nothing else inside the editor) requests disengagement.
  onClose: () => void;
}

// C#, D#, F#, G#, A# — the black keys, by pitch class.
const BLACK_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);

function isBlackPitch(pitch: number): boolean {
  return BLACK_PITCH_CLASSES.has(((pitch % 12) + 12) % 12);
}

// MIDI octave naming: 60 = C4, so 0 = C-1 and 120 = C9.
function octaveLabel(pitch: number): string {
  return `C${Math.floor(pitch / 12) - 1}`;
}

const isTypingTarget = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  return (
    !!el &&
    (el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.isContentEditable)
  );
};

// One in-flight gesture (keyframe-ops policy: snapshot at pointer-down,
// rebuild from `originals` per move, commit once on release). All gesture
// kinds share the window-level move/up effect below.
type DragState =
  | { kind: "none" }
  | {
      // Rubber-band over empty grid. Coords are body-viewport px;
      // `additive` = Shift held at start (box merges into selection).
      kind: "marquee";
      startX: number;
      startY: number;
      curX: number;
      curY: number;
      additive: boolean;
    }
  | {
      kind: "move";
      originals: NoteEvent[];
      ids: Set<string>;
      anchorId: string;
      startClientX: number;
      startClientY: number;
      // Latched once the pointer clears the click-slop; a bare click
      // (never latched) applies the deferred selection semantics below.
      moved: boolean;
      // Shift held at pointerdown on the note BODY = copy-drag (owner
      // decision): the clone is minted only at the LATCH — before it,
      // `ids`/`anchorId`/`originals` describe the copy SOURCE; after it,
      // they describe the stacked clones (cloneNotesForDrag) riding a
      // normal move. An unlatched release never mints anything and keeps
      // Shift-click's toggle/extend meaning via the flags below.
      copy: boolean;
      // Click-without-drag on an already-selected note collapses the
      // selection to it; Shift-click on one toggles it OFF; Shift-click
      // on an UNSELECTED one extends the selection (deferred here since
      // the copy path must not touch selection at pointerdown). All
      // resolved at RELEASE — mutating at pointerdown would make a group
      // drag impossible to start from a selected note.
      collapseOnClick: boolean;
      toggleOffOnClick: boolean;
      addOnClick: boolean;
    }
  | {
      kind: "resize";
      originals: NoteEvent[];
      ids: Set<string>;
      anchorId: string;
      startClientX: number;
      moved: boolean;
    }
  | {
      kind: "velocity";
      originals: NoteEvent[];
      ids: Set<string>;
      anchorId: string;
      startClientY: number;
    }
  | {
      // Pencil add(+size): `base` already contains the fresh note (the
      // add happened at pointerdown); a drag live-resizes it from that
      // stable base. The WHOLE gesture is one "note-add" commit.
      kind: "pencil";
      base: NoteEvent[];
      noteId: string;
      startClientX: number;
      sized: boolean;
    };

// Pointer slop (px) before a note grab becomes a move — below this,
// release reads as a click (select).
const CLICK_SLOP_PX = 3;
// Alt+vertical-drag velocity gain per pixel (spec: -dy * 0.005).
const VELOCITY_PER_PX = 0.005;
// Minimum spacing between pitch-change auditions during a move drag.
const DRAG_PREVIEW_MS = 80;
// Keybed-click audition length, seconds.
const KEYBED_PREVIEW_SEC = 0.3;
// Move-drag pitch-change audition length, seconds.
const DRAG_PREVIEW_SEC = 0.15;

export function MidiEditor({
  nodeId,
  notes,
  bpm,
  fps,
  ticksPerFrame,
  sceneDurationTicks,
  onSeekTick,
  onNotesChange,
  defaultVelocity,
  onPreviewNote,
  loopEnabled,
  loopEndBars,
  onClose,
}: MidiEditorProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // The lanes/grid viewport (below the ruler). Everything that converts a
  // clientX measures against THIS rect so every gesture shares the
  // tickToPx origin.
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const {
    pixelsPerTick,
    viewTickOffset,
    setViewTickOffset,
    tickToPx,
    pxToTick,
    zoomTo,
    fit,
  } = useTimelineView();
  const {
    rowPx,
    viewPitchOffset,
    setViewPitchOffset,
    pitchToY,
    yToPitch,
    centerOn,
  } = usePitchView();

  const [containerWidth, setContainerWidth] = useState(0);
  const [bodyHeight, setBodyHeight] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);
  const [closeHover, setCloseHover] = useState(false);

  // ---- M1 editing state ----
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [drag, setDrag] = useState<DragState>({ kind: "none" });
  // Hold-B pencil quasimode (keyup and window blur both clear it).
  const [pencilMode, setPencilMode] = useState(false);
  const [snapOption, setSnapOption] = useState<SnapOption>(DEFAULT_SNAP);
  // The in-flight gesture's live preview. Non-null from the first
  // pointermove until the COMMITTED clip comes back as props — props lag
  // the commit by a render, so clearing at commit time would flash one
  // frame of the stale pre-gesture clip. Cleared on props identity change
  // instead (effect below); gesture starts additionally snapshot from
  // displayNotes, so even a laggard parent can never hand a new gesture a
  // stale baseline.
  // Preview pairs carry the props identity they were built AGAINST: when
  // the commit round-trips (or an external edit lands) the base stops
  // matching and the render DERIVES its way back to props — no
  // setState-in-effect (react-hooks rule) and still no one-frame flash of
  // the stale pre-gesture clip.
  const [pendingPair, setPendingPair] = useState<{
    base: NoteEvent[];
    preview: NoteEvent[];
  } | null>(null);
  const pendingRef = useRef<NoteEvent[] | null>(null);
  const notesPropRef = useRef(notes);
  useEffect(() => {
    notesPropRef.current = notes;
    // A new clip identity also retires the event-time mirror; gesture
    // starts re-arm it. (Refs may be written in effects, never in render.)
    pendingRef.current = null;
  }, [notes]);
  const setPending = useCallback((next: NoteEvent[] | null) => {
    pendingRef.current = next;
    setPendingPair(
      next === null ? null : { base: notesPropRef.current, preview: next }
    );
  }, []);

  // Selection and gestures need ids. Render from an ids-complete clip
  // IMMEDIATELY (a gesture can start before the commit round-trips) and
  // reconcile the store once per external clip identity. Loop-guarded:
  // ensureNoteIds returns the SAME reference when nothing was missing,
  // and the committed array comes back complete.
  const notesWithIds = useMemo(() => ensureNoteIds(notes), [notes]);
  const onNotesChangeRef = useRef(onNotesChange);
  useEffect(() => {
    onNotesChangeRef.current = onNotesChange;
  });
  useEffect(() => {
    if (notesWithIds !== notes) {
      onNotesChangeRef.current(notesWithIds, nextGestureKey("note-ids"));
    }
  }, [notes, notesWithIds]);

  // What the user sees: the gesture preview when one is in flight AND
  // still based on the current props identity, else the authored clip.
  // Param writes still happen once per gesture, on release.
  const displayNotes =
    pendingPair && pendingPair.base === notes
      ? pendingPair.preview
      : notesWithIds;

  // One release-time commit per user-visible gesture.
  const commit = useCallback(
    (next: NoteEvent[], kind: string) => {
      setPending(next); // hold the preview until the committed props land
      onNotesChangeRef.current(next, nextGestureKey(kind));
    },
    [setPending]
  );

  const coarse = useCoarsePointer();
  // Right-edge resize slop, doubled for fingertips.
  const edgePx = (coarse ? 2 : 1) * CLIP_EDGE_PX;

  // ---- Audition (M2) ----
  // Fire-and-forget previews; the engine's preview path works with the
  // transport stopped. Effect-mirrored (react-hooks/refs: no render-time
  // ref writes) so window-level handlers always call the current prop.
  const onPreviewNoteRef = useRef(onPreviewNote);
  useEffect(() => {
    onPreviewNoteRef.current = onPreviewNote;
  });
  // Preview a note shape: tick duration → seconds, clamped so short
  // notes still speak and whole-bar notes don't drone.
  const previewNoteTicks = useCallback(
    (pitch: number, velocity: number, durationTicks: number) => {
      onPreviewNoteRef.current(
        pitch,
        velocity,
        Math.min(1.0, Math.max(0.08, durationTicks / (ticksPerFrame * fps)))
      );
    },
    [ticksPerFrame, fps]
  );
  // Move-drag pitch audition memo: last previewed row + timestamp for
  // the ≥DRAG_PREVIEW_MS throttle. Event-time only (written in pointer
  // handlers, never during render).
  const dragPreviewRef = useRef<{ pitch: number | null; t: number }>({
    pitch: null,
    t: 0,
  });

  // Keybed pressed key (audition in flight) — cleared on any release,
  // wherever the pointer ends up, and on window blur.
  const [pressedPitch, setPressedPitch] = useState<number | null>(null);
  useEffect(() => {
    if (pressedPitch === null) return;
    const clear = () => setPressedPitch(null);
    window.addEventListener("pointerup", clear);
    window.addEventListener("pointercancel", clear);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("pointerup", clear);
      window.removeEventListener("pointercancel", clear);
      window.removeEventListener("blur", clear);
    };
  }, [pressedPitch]);

  // Keybed highlight (owner addition): every row a SELECTED note
  // occupies. Derived from displayNotes so the lit keys follow the
  // preview pitches during a move drag.
  const selectedPitches = useMemo(() => {
    const set = new Set<number>();
    if (selection.size === 0) return set;
    for (const n of displayNotes) {
      if (n.id && selection.has(n.id)) set.add(Math.round(n.pitch));
    }
    return set;
  }, [displayNotes, selection]);

  // Esc closes. Window-level so it works regardless of focus, but gated
  // off text fields; cleared on unmount.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ---- Size tracking (TrackEditor's ResizeObserver pattern) ----
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      setContainerWidth(el.clientWidth);
      setBodyHeight(Math.max(0, el.clientHeight - RULER_HEIGHT));
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- Fit on mount ----
  // Horizontal: whole scene, tick 0 just right of the keybed. Vertical:
  // centered on the authored notes' pitch range, or C2..C4 for an empty
  // clip (the register new notes usually land in).
  const fitDoneRef = useRef(false);
  useEffect(() => {
    if (fitDoneRef.current) return;
    if (containerWidth <= 0 || bodyHeight <= 0) return;
    fit(containerWidth, sceneDurationTicks, KEYBOARD_GUTTER_PX);
    let lo = 36; // C2
    let hi = 60; // C4
    if (notes.length > 0) {
      lo = PITCH_MAX;
      hi = PITCH_MIN;
      for (const n of notes) {
        const p = Math.max(PITCH_MIN, Math.min(PITCH_MAX, Math.round(n.pitch)));
        if (p < lo) lo = p;
        if (p > hi) hi = p;
      }
    }
    centerOn(bodyHeight, lo, hi);
    fitDoneRef.current = true;
  }, [containerWidth, bodyHeight, sceneDurationTicks, notes, fit, centerOn]);

  // ---- Musical grid ----
  // The grid is BPM-derived; the note data is not (owner decision 2).
  const ticksPerBeat = useMemo(
    () => Math.max(1, beatsToTicks(1, bpm, ticksPerFrame, fps)),
    [bpm, ticksPerFrame, fps]
  );
  const spacing = useMemo(
    () => beatSpacing(pixelsPerTick, ticksPerBeat),
    [pixelsPerTick, ticksPerBeat]
  );

  // Snap grid in ticks (null = Off). Shift ALSO bypasses per gesture —
  // read off the event at pointermove time (keyframe-ops policy), never
  // from state.
  const gridSnapTicks = useMemo(
    () => snapTicksFor(snapOption, bpm, ticksPerFrame, fps),
    [snapOption, bpm, ticksPerFrame, fps]
  );
  // "One division" for verbs that need a size even with snap Off (pencil
  // default length, Cmd/Ctrl+D offset): fall back to a 1/16.
  const divisionTicks =
    gridSnapTicks ?? Math.max(1, Math.round(ticksPerBeat / 4));

  // Loop end in ticks (fixed 4/4: a bar is 4 beats). Null = loop off →
  // no marker, no dimming. The DEF does the actual note tiling; this is
  // purely the "notes past here are silent" affordance.
  const loopEndTick = loopEnabled
    ? beatsToTicks(loopEndBars * 4, bpm, ticksPerFrame, fps)
    : null;

  // Pencil length memory: last DRAG-SIZED note length, remembered across
  // adds for the session; plain clicks consume it without updating it.
  // Null until the first drag-size → one snap division.
  const lastPencilLenRef = useRef<number | null>(null);

  // Live values for the stable window-level handlers (paint/spline ref
  // pattern — the keydown handler must not re-subscribe per render).
  const liveRef = useRef({
    displayNotes,
    selection,
    divisionTicks,
    dragActive: false,
    containerWidth,
    bodyHeight,
  });
  useEffect(() => {
    // Mirrored in an effect, not in render (react-hooks/refs): effects
    // run before any user event can fire the window-level handlers that
    // read this.
    liveRef.current = {
      displayNotes,
      selection,
      divisionTicks,
      dragActive: drag.kind !== "none",
      containerWidth,
      bodyHeight,
    };
  });

  // ---- Wheel: device-idiom pan/zoom (adapted from TrackEditor:669-738) ----
  // Bound to the whole container so wheel events anywhere in the editor
  // (keybed and ruler included) are consumed here and never bubble down
  // to the window-level viewport pan/zoom underneath us.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      // Consume EVERY wheel while the editor is up — even branches that
      // end up doing nothing must not leak to the viewport below.
      e.preventDefault();
      e.stopPropagation();
      const rect = bodyRef.current?.getBoundingClientRect();
      const dx = e.deltaX || 0;
      const dy = e.deltaY || 0;
      const overGrid =
        !!rect &&
        e.clientX >= rect.left + KEYBOARD_GUTTER_PX &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;
      const scrollPitch = (d: number) =>
        setViewPitchOffset((prev) =>
          clampPitchOffset(prev - d / rowPx, bodyHeight, rowPx)
        );

      // Mouse: the wheel zooms the time axis about the cursor (over the
      // grid). Shift, or scrolling over the keybed/ruler, scrolls pitch
      // instead. macOS reports Shift+wheel as deltaX, so the scroll
      // branch takes whichever axis carries the notches.
      if (getEffectiveDevice() === "mouse") {
        if (e.shiftKey || !overGrid || !rect) {
          scrollPitch(dy !== 0 ? dy : dx);
          return;
        }
        const mx = e.clientX - rect.left;
        const mag = Math.abs(dx) > Math.abs(dy) ? dx : dy;
        zoomTo(mx, pxToTick(mx), pixelsPerTick * Math.exp(-mag * ZOOM_SENSITIVITY));
        return;
      }

      // Trackpad, Cmd/Ctrl held (a pinch arrives as a ctrlKey wheel) =
      // horizontal zoom about the cursor. Dominant axis: pinch reports
      // deltaY, Cmd + two-finger-x reports deltaX.
      if ((e.metaKey || e.ctrlKey) && rect) {
        const mx = e.clientX - rect.left;
        const mag = Math.abs(dx) > Math.abs(dy) ? dx : dy;
        if (mag !== 0) {
          zoomTo(mx, pxToTick(mx), pixelsPerTick * Math.exp(-mag * ZOOM_SENSITIVITY));
        }
        return;
      }

      // Trackpad two-finger pan moves BOTH axes: horizontal pans time,
      // vertical pans pitch (the keybed scrolls with the grid).
      if (dy !== 0) scrollPitch(dy);
      if (dx !== 0) setViewTickOffset((prev) => prev + dx / pixelsPerTick);
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [
    pxToTick,
    pixelsPerTick,
    rowPx,
    bodyHeight,
    zoomTo,
    setViewTickOffset,
    setViewPitchOffset,
  ]);

  // ---- Middle-button drag: pan both axes (TrackEditor:750-791) ----
  // Ancestor-level listener + stopPropagation, so the window-level
  // viewport middle-pan underneath never sees button 1 while the editor
  // is up. Cmd/Ctrl + middle-drag keeps TrackEditor's vertical-zoom
  // grammar for the time axis.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 1) return;
      e.stopPropagation();
      e.preventDefault();
      const rect = bodyRef.current?.getBoundingClientRect();
      const startX = e.clientX;
      const startY = e.clientY;
      const startTickOffset = viewTickOffset;
      const startPitchOffset = viewPitchOffset;
      const startPpt = pixelsPerTick;
      const zoomDrag = e.metaKey || e.ctrlKey;
      const anchorX = rect ? startX - rect.left : 0;
      const tickAt = startTickOffset + anchorX / startPpt;
      const onMove = (ev: PointerEvent) => {
        if (zoomDrag) {
          // Drag up zooms in (larger pixels-per-tick).
          const factor = Math.exp(-(ev.clientY - startY) * ZOOM_SENSITIVITY);
          zoomTo(anchorX, tickAt, startPpt * factor);
          return;
        }
        setViewTickOffset(startTickOffset - (ev.clientX - startX) / startPpt);
        setViewPitchOffset(
          clampPitchOffset(
            startPitchOffset + (ev.clientY - startY) / rowPx,
            bodyHeight,
            rowPx
          )
        );
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    };
    el.addEventListener("pointerdown", onDown);
    return () => el.removeEventListener("pointerdown", onDown);
  }, [
    viewTickOffset,
    viewPitchOffset,
    pixelsPerTick,
    rowPx,
    bodyHeight,
    zoomTo,
    setViewTickOffset,
    setViewPitchOffset,
  ]);

  // ---- Seek (ruler click + playhead-handle drag) ----
  // Clamped at 0; frame snapping is deliberately NOT applied to seeks.
  const seekAtClientX = useCallback(
    (clientX: number) => {
      const rect = bodyRef.current?.getBoundingClientRect();
      if (!rect) return;
      onSeekTick(Math.max(0, pxToTick(clientX - rect.left)));
    },
    [onSeekTick, pxToTick]
  );

  useEffect(() => {
    if (!scrubbing) return;
    const onMove = (e: PointerEvent) => seekAtClientX(e.clientX);
    const onUp = () => setScrubbing(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", onUp);
    };
  }, [scrubbing, seekAtClientX]);

  // ---- Note gestures (M1) ----
  // Grab a note: adjust the selection (grabbed-but-unselected replaces,
  // or adds with Shift), then classify the gesture — Alt = velocity,
  // right-edge slop = resize, else move. Baseline snapshots come from
  // displayNotes so a gesture starting before the previous commit's
  // round-trip still sees what the user sees.
  const onNotePointerDown = useCallback(
    (e: React.PointerEvent, n: NoteEvent) => {
      if (e.button !== 0) return;
      const id = n.id;
      if (!id) return;
      const rect = bodyRef.current?.getBoundingClientRect();
      if (!rect) return;
      e.stopPropagation(); // the body handler must not also start a marquee
      e.preventDefault();
      pendingRef.current = null; // new gesture — no preview yet

      // AUDITION RULE (owner): pointerdown on a note bar previews it,
      // ONCE, for every gesture except Alt (velocity — you're editing
      // loudness, and hearing the OLD velocity would lie). This covers
      // plain click, Shift-extend, copy-drag and resize grabs uniformly;
      // marquee never previews (it starts in the empty-grid handler),
      // and nothing re-fires at the unlatched release of a move.
      if (!e.altKey) {
        previewNoteTicks(n.pitch, n.velocity, n.durationTicks);
      }
      // Arm the move-drag pitch audition from the grabbed row (a copy
      // drag's clone starts on the same row, so continuity holds across
      // the latch).
      dragPreviewRef.current = {
        pitch: Math.round(n.pitch),
        t: performance.now(),
      };

      const wasSelected = selection.has(id);
      const originals = displayNotes;

      // Classify before touching the selection: Alt wins over Shift
      // (velocity, never a copy), then the right-edge slop (resize),
      // then Shift = copy-drag, then plain move.
      const px = e.clientX - rect.left;
      const x = tickToPx(n.startTick);
      const w = Math.max(NOTE_MIN_WIDTH_PX, n.durationTicks * pixelsPerTick);
      // Edge zone caps at half the bar so thin notes stay movable; bars
      // under 8px are move-only (the grip is unhittable anyway).
      const edgeZone = Math.min(edgePx, Math.max(2, w / 2));
      const onEdge = !e.altKey && w >= 8 && px >= x + w - edgeZone;

      if (!e.altKey && !onEdge && e.shiftKey) {
        // Copy-drag, latch-deferred: pointerdown decides NOTHING yet —
        // the clone is minted (and the selection rewritten) only when
        // the slop latches, so an unlatched Shift-click keeps its
        // toggle/extend meaning without ever minting ids. The copy
        // SOURCE is the current selection, or just the grabbed note
        // when it isn't selected (no Shift-extend in this path).
        setDrag({
          kind: "move",
          originals,
          ids: wasSelected ? new Set(selection) : new Set([id]),
          anchorId: id,
          startClientX: e.clientX,
          startClientY: e.clientY,
          moved: false,
          copy: true,
          collapseOnClick: false,
          toggleOffOnClick: wasSelected,
          addOnClick: !wasSelected,
        });
        return;
      }

      // Non-copy paths keep the grab-selection rule: an unselected
      // grabbed note joins (Shift, alt/edge gestures only) or replaces
      // the selection before the drag.
      let ids: Set<string>;
      if (wasSelected) {
        ids = new Set(selection);
      } else if (e.shiftKey) {
        ids = new Set(selection);
        ids.add(id);
        setSelection(ids);
      } else {
        ids = new Set([id]);
        setSelection(ids);
      }

      if (e.altKey) {
        setDrag({
          kind: "velocity",
          originals,
          ids,
          anchorId: id,
          startClientY: e.clientY,
        });
        return;
      }
      if (onEdge) {
        setDrag({
          kind: "resize",
          originals,
          ids,
          anchorId: id,
          startClientX: e.clientX,
          moved: false,
        });
        return;
      }
      setDrag({
        kind: "move",
        originals,
        ids,
        anchorId: id,
        startClientX: e.clientX,
        startClientY: e.clientY,
        moved: false,
        copy: false,
        // Shift+body never reaches here, so toggle-off can't apply.
        collapseOnClick: wasSelected && ids.size > 1,
        toggleOffOnClick: false,
        addOnClick: false,
      });
    },
    [selection, displayNotes, tickToPx, pixelsPerTick, edgePx, previewNoteTicks]
  );

  // Empty grid: pencil-add when B is held, else marquee (a zero-area
  // marquee is the click-empty deselect). Keybed clicks (x < gutter) are
  // not grid clicks — the keybed auditions in M2.
  const onBodyPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      const rect = bodyRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (x < KEYBOARD_GUTTER_PX) return;
      e.preventDefault();
      pendingRef.current = null;

      if (pencilMode) {
        const { notes: added, id } = addNote(
          displayNotes,
          {
            pitch: yToPitch(y),
            velocity: defaultVelocity,
            startTick: Math.max(0, pxToTick(x)),
            durationTicks: lastPencilLenRef.current ?? divisionTicks,
          },
          { snapTicks: e.shiftKey ? null : gridSnapTicks }
        );
        setPending(added); // the fresh note previews immediately
        // Audition the add ONCE per gesture (drag-resize moves don't
        // re-fire) — from the note as it actually landed (post-snap,
        // post-clamp), not the raw pointer math.
        const fresh = added.find((nn) => nn.id === id);
        if (fresh) {
          previewNoteTicks(fresh.pitch, fresh.velocity, fresh.durationTicks);
        }
        setDrag({
          kind: "pencil",
          base: added,
          noteId: id,
          startClientX: e.clientX,
          sized: false,
        });
        return;
      }

      if (!e.shiftKey) setSelection(new Set());
      setDrag({
        kind: "marquee",
        startX: x,
        startY: y,
        curX: x,
        curY: y,
        additive: e.shiftKey,
      });
    },
    [
      pencilMode,
      displayNotes,
      yToPitch,
      pxToTick,
      defaultVelocity,
      divisionTicks,
      gridSnapTicks,
      setPending,
      previewNoteTicks,
    ]
  );

  // Keybed click = audition that pitch (M2). The keybed is an
  // instrument, not the grid: it never deselects notes and never starts
  // a marquee/pencil gesture (stopPropagation + the body handler's own
  // gutter check both guarantee it).
  const onKeybedPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      const rect = bodyRef.current?.getBoundingClientRect();
      if (!rect) return;
      e.stopPropagation();
      e.preventDefault();
      const pitch = yToPitch(e.clientY - rect.top);
      setPressedPitch(pitch);
      onPreviewNoteRef.current(pitch, defaultVelocity, KEYBED_PREVIEW_SEC);
    },
    [yToPitch, defaultVelocity]
  );

  // Window-level move/up for the active gesture. Every move REBUILDS the
  // preview from the drag-start snapshot via note-ops (never from the
  // previous move's output); release commits at most once.
  useEffect(() => {
    if (drag.kind === "none") return;
    // Shift bypasses snap for the gesture — read at pointermove time.
    const snapFor = (e: PointerEvent) => (e.shiftKey ? null : gridSnapTicks);

    const onMove = (e: PointerEvent) => {
      const rect = bodyRef.current?.getBoundingClientRect();
      if (!rect) return;
      switch (drag.kind) {
        case "marquee":
          setDrag({
            ...drag,
            curX: e.clientX - rect.left,
            curY: e.clientY - rect.top,
          });
          return;
        case "move": {
          let d = drag;
          if (!d.moved) {
            if (
              Math.abs(e.clientX - d.startClientX) < CLICK_SLOP_PX &&
              Math.abs(e.clientY - d.startClientY) < CLICK_SLOP_PX
            ) {
              return;
            }
            if (d.copy) {
              // THE LATCH mints the copy (deferred from pointerdown):
              // clones stack on their sources unresolved and become the
              // gesture — base swaps to originals+clones, ids/anchor to
              // the clone set, and the selection follows. Resolution
              // happens through moveNotes' normal dragged-wins commit.
              // Note Shift is usually still held here (it STARTED the
              // copy), and Shift-at-pointermove keeps meaning
              // snap-bypass — so a copy-drag starts unsnapped until
              // Shift is released. Accepted (owner decision).
              const { notes: base, newIds } = cloneNotesForDrag(
                d.originals,
                d.ids
              );
              // cloneNotesForDrag appends clones in the originals'
              // order, so the grabbed note's clone sits at its index
              // among the selected sources.
              const selectedInOrder = d.originals.filter(
                (n) => n.id && d.ids.has(n.id)
              );
              const anchorIdx = selectedInOrder.findIndex(
                (n) => n.id === d.anchorId
              );
              const cloneAnchorId =
                base[d.originals.length + Math.max(0, anchorIdx)]?.id;
              if (newIds.size > 0 && cloneAnchorId) {
                d = {
                  ...d,
                  moved: true,
                  originals: base,
                  ids: newIds,
                  anchorId: cloneAnchorId,
                };
                setSelection(newIds);
              } else {
                // Degenerate (id-less source) — fall back to a plain move.
                d = { ...d, moved: true, copy: false };
              }
            } else {
              d = { ...d, moved: true };
            }
            setDrag(d);
          }
          const next = moveNotes(
            d.originals,
            d.ids,
            d.anchorId,
            (e.clientX - d.startClientX) / pixelsPerTick,
            // Higher pitch is up: y decreasing = pitch increasing.
            Math.round((d.startClientY - e.clientY) / rowPx),
            { snapTicks: snapFor(e) }
          );
          setPending(next);
          // Pitch-change audition (move + copy-drag only; resize can't
          // change pitch and velocity drags must not chirp): read the
          // anchor's EFFECTIVE row out of the rebuilt clip — that bakes
          // in moveNotes' rail clamps — and fire only when it differs
          // from the last previewed row, at most every DRAG_PREVIEW_MS.
          // A change landing inside the throttle window fires on a later
          // move instead (the ref keeps the OLD row until we fire).
          const anchorNow = next.find((nn) => nn.id === d.anchorId);
          if (anchorNow) {
            const row = Math.round(anchorNow.pitch);
            const memo = dragPreviewRef.current;
            const now = performance.now();
            if (row !== memo.pitch && now - memo.t >= DRAG_PREVIEW_MS) {
              dragPreviewRef.current = { pitch: row, t: now };
              onPreviewNoteRef.current(
                row,
                anchorNow.velocity,
                DRAG_PREVIEW_SEC
              );
            }
          }
          return;
        }
        case "resize": {
          if (!drag.moved && Math.abs(e.clientX - drag.startClientX) < 2) {
            // Without slop, a bare click on the edge would snap the end
            // to the grid — a resize the user never asked for.
            return;
          }
          if (!drag.moved) setDrag({ ...drag, moved: true });
          setPending(
            resizeNotes(
              drag.originals,
              drag.ids,
              drag.anchorId,
              pxToTick(e.clientX - rect.left),
              { snapTicks: snapFor(e) }
            )
          );
          return;
        }
        case "velocity":
          setPending(
            adjustVelocity(
              drag.originals,
              drag.ids,
              -(e.clientY - drag.startClientY) * VELOCITY_PER_PX
            )
          );
          return;
        case "pencil": {
          if (!drag.sized && Math.abs(e.clientX - drag.startClientX) < 2) {
            return;
          }
          if (!drag.sized) setDrag({ ...drag, sized: true });
          setPending(
            resizeNotes(
              drag.base,
              new Set([drag.noteId]),
              drag.noteId,
              pxToTick(e.clientX - rect.left),
              { snapTicks: snapFor(e) }
            )
          );
          return;
        }
      }
    };

    const onUp = () => {
      const pending = pendingRef.current;
      switch (drag.kind) {
        case "marquee": {
          // Intersection selects: a note is in when its bar TOUCHES the
          // box on both axes (containment not required).
          const { displayNotes: ns, selection: sel } = liveRef.current;
          const x0 = Math.min(drag.startX, drag.curX);
          const x1 = Math.max(drag.startX, drag.curX);
          const y0 = Math.min(drag.startY, drag.curY);
          const y1 = Math.max(drag.startY, drag.curY);
          const t0 = pxToTick(x0);
          const t1 = pxToTick(x1);
          const hit = new Set<string>();
          for (const n of ns) {
            if (!n.id) continue;
            if (n.startTick > t1 || n.startTick + n.durationTicks < t0) {
              continue;
            }
            const p = Math.round(n.pitch);
            if (p < PITCH_MIN || p > PITCH_MAX) continue;
            const top = pitchToY(p);
            if (top > y1 || top + rowPx < y0) continue;
            hit.add(n.id);
          }
          if (drag.additive) {
            const merged = new Set(sel);
            for (const id of hit) merged.add(id);
            setSelection(merged);
          } else {
            setSelection(hit);
          }
          break;
        }
        case "move": {
          if (!drag.moved) {
            // A click, not a drag — deferred selection semantics (a
            // copy-drag that never latched lands here too: no clones
            // were minted, and Shift-click keeps its meaning).
            if (drag.toggleOffOnClick) {
              setSelection((prev) => {
                const next = new Set(prev);
                next.delete(drag.anchorId);
                return next;
              });
            } else if (drag.addOnClick) {
              setSelection((prev) => {
                const next = new Set(prev);
                next.add(drag.anchorId);
                return next;
              });
            } else if (drag.collapseOnClick) {
              setSelection(new Set([drag.anchorId]));
            }
          } else if (drag.copy) {
            // A LATCHED copy always commits: the clones exist only in
            // the preview, so even a zero-delta drop must land them
            // (stacked in place, Logic's option-drag behavior) rather
            // than strand them in pendingNotes with no props round-trip
            // to clear it. drag.originals is the post-latch cloned base.
            commit(pending ?? drag.originals, "note-copy-drag");
          } else if (pending && pending !== drag.originals) {
            commit(pending, "note-move");
          }
          break;
        }
        case "resize": {
          if (pending && pending !== drag.originals) {
            commit(pending, "note-resize");
          }
          break;
        }
        case "velocity": {
          // adjustVelocity returns a fresh array for any nonzero delta
          // even when every note clamped to where it already was — check
          // the values so a no-op drag doesn't burn an undo entry.
          if (
            pending &&
            pending !== drag.originals &&
            (pending.length !== drag.originals.length ||
              pending.some(
                (n, i) => n.velocity !== drag.originals[i].velocity
              ))
          ) {
            commit(pending, "note-velocity");
          }
          break;
        }
        case "pencil": {
          // The whole add(+size) is ONE commit.
          const finalClip = pending ?? drag.base;
          commit(finalClip, "note-add");
          if (drag.sized) {
            const fresh = finalClip.find((n) => n.id === drag.noteId);
            if (fresh) lastPencilLenRef.current = fresh.durationTicks;
          }
          setSelection(new Set([drag.noteId]));
          break;
        }
      }
      setDrag({ kind: "none" });
    };

    const onCancel = () => {
      // The system stole the gesture (blur, pointercancel) — drop the
      // preview, commit nothing.
      setPending(null);
      setDrag({ kind: "none" });
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onCancel);
    };
  }, [
    drag,
    pixelsPerTick,
    rowPx,
    pxToTick,
    pitchToY,
    gridSnapTicks,
    commit,
    setPending,
  ]);

  // ---- F: fit to the notes' extent (whole scene when empty) ----
  const fitToNotes = useCallback(() => {
    const { displayNotes: ns, containerWidth: w, bodyHeight: h } =
      liveRef.current;
    if (w <= 0 || h <= 0) return;
    if (ns.length === 0) {
      // Empty clip: the M0 mount framing — whole scene, C2..C4.
      fit(w, sceneDurationTicks, KEYBOARD_GUTTER_PX);
      centerOn(h, 36, 60);
      return;
    }
    let t0 = Infinity;
    let t1 = -Infinity;
    let lo = PITCH_MAX;
    let hi = PITCH_MIN;
    for (const n of ns) {
      if (n.startTick < t0) t0 = n.startTick;
      if (n.startTick + n.durationTicks > t1) {
        t1 = n.startTick + n.durationTicks;
      }
      const p = Math.max(PITCH_MIN, Math.min(PITCH_MAX, Math.round(n.pitch)));
      if (p < lo) lo = p;
      if (p > hi) hi = p;
    }
    const usable = Math.max(50, w - KEYBOARD_GUTTER_PX);
    const pps = clampPixelsPerTick((usable * FIT_PAD) / Math.max(1, t1 - t0));
    // view.fit's padding contract, anchored at the notes' first tick
    // instead of 0: the extent fills FIT_PAD of the usable span with the
    // margin split around it.
    zoomTo(KEYBOARD_GUTTER_PX + (usable * (1 - FIT_PAD)) / 2, t0, pps);
    centerOn(h, lo, hi);
  }, [fit, zoomTo, centerOn, sceneDurationTicks]);

  // ---- Keyboard (window-level, mounted-only) ----
  // B arms the pencil quasimode for anyone (it only changes what a click
  // INSIDE the editor does); the destructive/selection verbs are gated on
  // the midi shortcut scope (spline precedent) so Delete pressed while
  // working in the node graph still deletes the graph node, and OUR
  // Delete never falls through to it.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();

      if (k === "b" && !mod && !e.altKey && !e.shiftKey) {
        if (!e.repeat) setPencilMode(true);
        return;
      }

      const live = liveRef.current;
      if (e.key === "Delete" || e.key === "Backspace") {
        if (getShortcutScope() !== "midi" || live.dragActive) return;
        e.preventDefault();
        if (live.selection.size === 0) return;
        const next = deleteNotes(live.displayNotes, live.selection);
        if (next !== live.displayNotes) {
          commit(next, "note-delete");
          setSelection(new Set());
        }
        return;
      }
      if (mod && k === "a") {
        if (getShortcutScope() !== "midi") return;
        e.preventDefault();
        const all = new Set<string>();
        for (const n of live.displayNotes) if (n.id) all.add(n.id);
        setSelection(all);
        return;
      }
      if (mod && k === "d") {
        if (getShortcutScope() !== "midi" || live.dragActive) return;
        e.preventDefault(); // Cmd+D bookmarks otherwise
        if (live.selection.size === 0) return;
        const { notes: next, newIds } = duplicateNotes(
          live.displayNotes,
          live.selection,
          live.divisionTicks
        );
        if (next !== live.displayNotes) {
          commit(next, "note-duplicate");
          setSelection(newIds);
        }
        return;
      }
      if (mod && k === "c") {
        if (getShortcutScope() !== "midi") return;
        if (live.selection.size === 0) return; // let the browser have it
        e.preventDefault();
        copyNotesToClipboard(live.displayNotes, live.selection);
        return;
      }
      if (mod && k === "v") {
        if (getShortcutScope() !== "midi" || live.dragActive) return;
        const pasted = pasteNotesFromClipboard(live.displayNotes);
        if (!pasted) return;
        e.preventDefault();
        commit(pasted.notes, "note-paste");
        setSelection(pasted.newIds);
        return;
      }
      if (k === "f" && !mod && !e.altKey && !e.shiftKey) {
        if (getShortcutScope() !== "midi") return;
        e.preventDefault();
        fitToNotes();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      // Unconditional (no modifier/typing guards): a wedged quasimode is
      // worse than a spurious clear.
      if (e.key === "b" || e.key === "B") setPencilMode(false);
    };
    const onBlur = () => setPencilMode(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [commit, fitToNotes]);

  // ---- Visible pitch rows ----
  // Row washes, octave lines and keybed keys all walk this one list;
  // ~bodyHeight/rowPx entries, re-derived per render (pans re-render the
  // shell anyway — playback does NOT, see the clock constraint above).
  const rows: { p: number; y: number }[] = [];
  if (bodyHeight > 0 && rowPx > 0) {
    const pHi = Math.min(PITCH_MAX, Math.ceil(viewPitchOffset) - 1);
    const pLo = Math.max(
      PITCH_MIN,
      Math.floor(viewPitchOffset - bodyHeight / rowPx) - 1
    );
    for (let p = pHi; p >= pLo; p--) rows.push({ p, y: pitchToY(p) });
  }

  const noteHeight = Math.max(3, rowPx - 1);

  return (
    <div
      ref={containerRef}
      data-shortcut-scope="midi"
      data-midi-editor-node={nodeId}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 40,
        background: COLOR_BG,
        color: COLOR_TEXT,
        // Match the timeline editors' typography — one surface family.
        font: "10px/1.2 var(--ui-font)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        userSelect: "none",
      }}
    >
      {/* Header strip: bar/beat ruler across the full width, the keybed
          corner cell floating over its left edge, close button at the
          right. The ruler owns the seek gesture. */}
      <div
        style={{
          height: RULER_HEIGHT,
          minHeight: RULER_HEIGHT,
          position: "relative",
          borderBottom: "1px solid var(--tb-n-5)",
        }}
      >
        <div
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            seekAtClientX(e.clientX);
            setScrubbing(true);
          }}
          style={{
            position: "absolute",
            inset: 0,
            cursor: "ew-resize",
            overflow: "hidden",
            // The ruler owns the scrub gesture — opt out of browser
            // panning so a touch can't cancel the drag to scroll.
            touchAction: "none",
          }}
        >
          <BeatRuler
            width={containerWidth}
            height={RULER_HEIGHT}
            tickToPx={tickToPx}
            pxToTick={pxToTick}
            ticksPerBeat={ticksPerBeat}
            majorBeats={spacing.majorBeats}
            minorBeats={spacing.minorBeats}
          />
          {/* Playhead handle (self-subscribing leaf) */}
          <PlayheadHandle
            tickToPx={tickToPx}
            visibleWidth={containerWidth}
            onStartScrub={() => setScrubbing(true)}
          />
          {/* Loop-end marker in the ruler (same x origin as the grid).
              pointerEvents none — the ruler keeps the seek gesture. */}
          {loopEndTick !== null &&
            (() => {
              const lx = tickToPx(loopEndTick);
              if (lx < 0 || lx > containerWidth) return null;
              return (
                <div
                  aria-hidden
                  style={{
                    position: "absolute",
                    left: lx,
                    top: 0,
                    bottom: 0,
                    pointerEvents: "none",
                  }}
                >
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      top: 0,
                      bottom: 0,
                      width: 1,
                      background: COLOR_LOOP_MARKER,
                    }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      left: 3,
                      bottom: 2,
                      fontSize: 7,
                      letterSpacing: 0.6,
                      color: COLOR_LOOP_MARKER,
                    }}
                  >
                    LOOP
                  </div>
                </div>
              );
            })()}
        </div>
        {/* Corner cell — covers the ruler under the keybed column. */}
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: KEYBOARD_GUTTER_PX,
            background: COLOR_BG,
            borderRight: `1px solid ${COLOR_BORDER}`,
            display: "flex",
            alignItems: "center",
            paddingLeft: 8,
            color: COLOR_MUTED,
            letterSpacing: 0.6,
          }}
        >
          MIDI
        </div>
        {/* Snap division — a sibling of the ruler layer, so its clicks
            never reach the seek gesture. Shift bypasses per gesture. */}
        <div
          style={{
            position: "absolute",
            right: 26,
            top: 2,
            width: 58,
            zIndex: 2,
          }}
        >
          <Dropdown
            value={snapOption}
            options={[...SNAP_OPTIONS]}
            onChange={(v) => setSnapOption(v as SnapOption)}
            title="Snap grid (Shift bypasses while dragging)"
          />
        </div>
        <button
          onClick={onClose}
          onMouseEnter={() => setCloseHover(true)}
          onMouseLeave={() => setCloseHover(false)}
          title="Close (Esc)"
          style={{
            position: "absolute",
            right: 4,
            top: 4,
            width: 16,
            height: 16,
            padding: 0,
            border: "none",
            borderRadius: 3,
            background: closeHover ? "var(--tb-n-3)" : COLOR_BG,
            color: closeHover ? COLOR_TEXT : COLOR_MUTED,
            fontSize: 12,
            lineHeight: "16px",
            textAlign: "center",
            cursor: "pointer",
          }}
        >
          ×
        </button>
      </div>

      {/* Grid viewport. The note grid spans the full width; the keybed
          floats over its left edge (opaque, so the playhead line and
          panned-left notes disappear under it, not over it). */}
      <div
        ref={bodyRef}
        onPointerDown={onBodyPointerDown}
        style={{
          flex: 1,
          minHeight: 0,
          position: "relative",
          overflow: "hidden",
          // The grid owns its gestures — without this a touch drag gets
          // claimed by the browser before the first move.
          touchAction: "none",
          cursor: pencilMode
            ? "crosshair"
            : drag.kind === "resize" || drag.kind === "pencil"
              ? "ew-resize"
              : drag.kind === "velocity"
                ? "ns-resize"
                : drag.kind === "move" && drag.moved
                  ? "grabbing"
                  : "default",
        }}
      >
        {/* Black-key row washes + octave lines (fixed backdrop). */}
        <div aria-hidden style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
          {rows.map(({ p, y }) =>
            isBlackPitch(p) ? (
              <div
                key={p}
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: y,
                  height: rowPx,
                  background: COLOR_PITCH_ROW_BLACK_BG,
                }}
              />
            ) : null
          )}
          {rows.map(({ p, y }) =>
            p % 12 === 0 ? (
              // The octave boundary sits UNDER each C row (between B and C).
              <div
                key={`oct-${p}`}
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: y + rowPx - 1,
                  height: 1,
                  background: COLOR_PITCH_OCTAVE_LINE,
                }}
              />
            ) : null
          )}
        </div>

        {/* Beat/division gridlines — FrameTicks fed beat units. */}
        <LaneFrameTicks
          width={containerWidth}
          tickToPx={tickToPx}
          pxToTick={pxToTick}
          ticksPerFrame={ticksPerBeat}
          majorFrames={spacing.majorBeats}
          minorFrames={spacing.minorBeats}
        />

        {/* Notes — rendered from the gesture preview when one is in
            flight (displayNotes), else the authored clip. The layer
            itself stays inert so empty-grid clicks fall through to the
            marquee/pencil handler; each note bar opts back in. */}
        <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
          {displayNotes.map((n, i) => {
            const x = tickToPx(n.startTick);
            const w = Math.max(NOTE_MIN_WIDTH_PX, n.durationTicks * pixelsPerTick);
            if (x + w < 0 || x > containerWidth) return null;
            // Fractional pitch is legal (detune) — draw on the nearest row.
            const p = Math.round(n.pitch);
            if (p < PITCH_MIN || p > PITCH_MAX) return null;
            const y = pitchToY(p);
            if (y + rowPx < 0 || y > bodyHeight) return null;
            const selected = !!n.id && selection.has(n.id);
            return (
              <div
                key={n.id ?? `i${i}`}
                onPointerDown={(e) => onNotePointerDown(e, n)}
                style={{
                  position: "absolute",
                  left: x,
                  top: y + 0.5,
                  width: w,
                  height: noteHeight,
                  boxSizing: "border-box",
                  background: noteVelocityFill(n.velocity),
                  // Selection is an outline; the fill stays velocity.
                  border: `1px solid ${
                    selected
                      ? COLOR_NOTE_SELECTED_BORDER
                      : noteVelocityBorder(n.velocity)
                  }`,
                  borderRadius: 2,
                  // A note STARTING at/after the loop end is silent
                  // while looping (the def drops it) — fade the bar
                  // itself, over and above the region wash, so silent
                  // notes read differently from the still-audible tail
                  // of a note that starts before the marker.
                  opacity:
                    loopEndTick !== null && n.startTick >= loopEndTick
                      ? LOOP_SILENT_NOTE_OPACITY
                      : undefined,
                  pointerEvents: "auto",
                  touchAction: "none",
                }}
              >
                {/* Right-edge resize affordance — cursor only; the hit
                    routes through the parent handler's edge test. */}
                {w >= 8 && (
                  <div
                    style={{
                      position: "absolute",
                      right: 0,
                      top: 0,
                      bottom: 0,
                      width: Math.min(edgePx, Math.max(2, w / 2)),
                      cursor: "ew-resize",
                    }}
                  />
                )}
                {/* Logic's inner duration stripe — only when it has room. */}
                {w >= 10 && rowPx >= 9 && (
                  <div
                    style={{
                      position: "absolute",
                      left: 2,
                      right: 2,
                      top: "50%",
                      marginTop: -1,
                      height: 2,
                      borderRadius: 1,
                      background: COLOR_NOTE_STRIPE,
                      pointerEvents: "none",
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>

        {/* Loop region (M2): dim everything right of the loop end —
            notes there are silent while looping — plus the marker line.
            z=1: above the note bars, below the keybed. No interaction
            in this pass (the param panel drives loop_end_bars). */}
        {loopEndTick !== null &&
          (() => {
            const lx = tickToPx(loopEndTick);
            if (lx >= containerWidth) return null;
            return (
              <>
                <div
                  aria-hidden
                  style={{
                    position: "absolute",
                    left: Math.max(0, lx),
                    top: 0,
                    bottom: 0,
                    width: containerWidth - Math.max(0, lx),
                    background: COLOR_LOOP_DIM,
                    pointerEvents: "none",
                    zIndex: 1,
                  }}
                />
                {lx >= 0 && (
                  <div
                    aria-hidden
                    style={{
                      position: "absolute",
                      left: lx,
                      top: 0,
                      bottom: 0,
                      width: 1,
                      background: COLOR_LOOP_MARKER,
                      pointerEvents: "none",
                      zIndex: 1,
                    }}
                  />
                )}
              </>
            );
          })()}

        {/* Marquee rubber-band (under the keybed's z=2, like the notes). */}
        {drag.kind === "marquee" && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              left: Math.min(drag.startX, drag.curX),
              top: Math.min(drag.startY, drag.curY),
              width: Math.abs(drag.curX - drag.startX),
              height: Math.abs(drag.curY - drag.startY),
              background: MARQUEE_FILL,
              border: MARQUEE_BORDER,
              pointerEvents: "none",
              zIndex: 1,
            }}
          />
        )}

        {/* Velocity readout while Alt-dragging (Logic shows the number). */}
        {drag.kind === "velocity" &&
          (() => {
            const anchor = displayNotes.find((n) => n.id === drag.anchorId);
            if (!anchor) return null;
            return (
              <div
                aria-hidden
                style={{
                  position: "absolute",
                  left: tickToPx(anchor.startTick),
                  top: pitchToY(Math.round(anchor.pitch)) - 15,
                  padding: "1px 4px",
                  background: "var(--tb-n-2)",
                  border: `1px solid ${COLOR_BORDER}`,
                  borderRadius: 3,
                  color: COLOR_TEXT,
                  fontSize: 9,
                  pointerEvents: "none",
                  zIndex: 3,
                }}
              >
                {anchor.velocity.toFixed(2)}
              </div>
            );
          })()}

        {/* Playhead line (self-subscribing leaf — the shell never reads
            the clock). */}
        <PlayheadLine tickToPx={tickToPx} visibleWidth={containerWidth} />

        {/* Keybed gutter — floats over the grid's left edge and scrolls
            vertically WITH the pitch view. Click = audition (M2). */}
        <div
          onPointerDown={onKeybedPointerDown}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: KEYBOARD_GUTTER_PX,
            zIndex: 2,
            background: COLOR_KEY_WHITE,
            borderRight: `1px solid ${COLOR_BORDER}`,
            overflow: "hidden",
            cursor: "pointer",
            touchAction: "none",
          }}
        >
          {rows.map(({ p, y }) => (
            <React.Fragment key={p}>
              {isBlackPitch(p) && (
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    top: y,
                    width: "60%",
                    height: rowPx,
                    background: COLOR_KEY_BLACK,
                    borderRadius: "0 2px 2px 0",
                  }}
                />
              )}
              {/* Pressed (audition) beats the selection highlight; both
                  wash only the KEY — 60% width on a black row, full row
                  on a white one — so legibility holds on both. */}
              {(pressedPitch === p || selectedPitches.has(p)) && (
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    top: y,
                    width: isBlackPitch(p) ? "60%" : "100%",
                    height: rowPx,
                    background:
                      pressedPitch === p
                        ? COLOR_KEY_PRESSED
                        : isBlackPitch(p)
                          ? COLOR_KEY_SELECTED_BLACK
                          : COLOR_KEY_SELECTED_WHITE,
                    borderRadius: isBlackPitch(p) ? "0 2px 2px 0" : 0,
                    pointerEvents: "none",
                  }}
                />
              )}
              {/* Separator where two white keys meet: below C and below F. */}
              {(p % 12 === 0 || p % 12 === 5) && (
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    top: y + rowPx - 1,
                    height: 1,
                    background: COLOR_KEYBED_SEP,
                  }}
                />
              )}
              {p % 12 === 0 && rowPx >= 8 && (
                <div
                  style={{
                    position: "absolute",
                    right: 4,
                    top: y,
                    height: rowPx,
                    lineHeight: `${rowPx}px`,
                    fontSize: 8,
                    color: COLOR_KEY_LABEL,
                  }}
                >
                  {octaveLabel(p)}
                </div>
              )}
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
