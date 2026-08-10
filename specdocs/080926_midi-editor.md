# MIDI Editor node — a Logic-style piano roll in the viewport

Spec — 2026-08-09. Status: **SHIPPED — all milestones** (M0/M1/M2, same
day). All gates green (typecheck / check incl. 29 note-ops cases / lint
ratchet / check:audio-live incl. the paused-preview scenario). M2 audition
rule as built: preview fires at pointerdown for EVERY note-grab gesture
except Alt-velocity; keybed keys light for selected pitches (live during
drags); loop marker + post-loop dimming render when the node loops.
Parent specs: 080826_audio-nodes.md (the `notes` domain),
080926_audio-v2-integration.md.

## As built — M0/M1 deltas and owner additions

- **Owner additions during M1** (2026-08-09): (a) **Shift-drag on a note
  = copy-drag** of the whole selection — Shift at POINTERDOWN selects the
  mode, Shift LIVE keeps meaning snap-bypass; the clone mints only when
  the drag latches past click-slop (a bare Shift-click stays a selection
  toggle), via `cloneNotesForDrag` (stacked, unresolved — dragged-wins
  resolution happens at the move's commit, so dragging clear preserves
  the originals). (b) **Region loop** on the node params (`loop`,
  `loop_end_bars`, `loop_repeats`): notes starting in [0, end) tile at
  compute; notes past the point are silent while looping; bpm folds into
  fingerprintExtras ONLY when looping so non-looping clips keep the
  identity fast path. (c — M2) **select-audition** (clicking a note
  previews it) and **keybed highlight** of selected pitches.
- **NoteEvent gained optional `id`** (editor identity; engine ignores it,
  generated notes omit it). Editor backfills via ensureNoteIds with a
  same-reference no-op contract.
- **Gesture preview** uses a base-identity pair (`{base, preview}`,
  ignored when props.notes ≠ base) instead of clear-on-props effects, and
  all ref mirrors live in effects — the React-19 hooks lint
  (set-state-in-effect, refs-in-render) gates NEW files strictly even
  though old monoliths are grandfathered. Follow this file's patterns.
- **previewNote (engine, shipped)**: instruments expose
  `triggerNote?`; `audioEngine.previewNote(stageId|null, …)` routes the
  chain SINK through an always-open preview gain while the transport is
  stopped (refcounted, timed release), falls back to a quiet built-in
  synth when nothing is wired/live. Harness: 0.175 RMS at the instrument
  tap with the transport stopped.
- check-note-ops.mts: 29 cases, in `npm run check`.

## What it is

A `midi-editor` node (audio/generator, like Step Pattern) whose authored
`NoteEvent[]` clip is edited in a **full piano-roll editor that covers the
primary viewport** while engaged. Logic Pro is the interaction reference;
the app's own timeline editors are the visual + machinery reference. The
node emits `notes` — instruments consume it exactly like Step Pattern's
output, so everything downstream (scheduling, export, transpose) already
works.

Owner decisions (2026-08-09):
1. **Engagement: double-click the node (or its header Edit button)** —
   not plain selection. Stays engaged until Esc or a DIFFERENT node is
   selected (empty-space deselect keeps it open). No accidental viewport
   swaps while arranging the graph.
2. **Absolute scene time.** The roll's ruler IS the scene timeline; bars
   and beats derive from project BPM (beatsToTicks). A note at bar 2
   plays at bar 2. Note data stays integer ticks — the GRID is
   BPM-derived, the DATA is not, so the def stays cacheable with no
   fingerprintExtras.
3. **Velocity: Logic-style color + Alt+vertical-drag** on a note (or
   selection). No velocity lane in v1.
4. **Audition: through the wired downstream instrument** when its live
   stage exists, else a quiet built-in preview synth — applies to note
   placement AND clicking the keyboard gutter.

## The node

- `type: "midi-editor"`, name "MIDI Editor", category audio, subcategory
  generator, `noMaskInput: true`, `primaryOutput: "notes"`, no inputs.
- Notes live in a `notes` param of NEW ParamType `"notes_clip"` —
  `NoteEvent[]` verbatim (types.ts:303 already defines the shape).
  Plain-JSON serialization needs ZERO project.ts work (spline_anchors
  precedent). `hidden: true` — it is editor-authored, like the spline
  param. Not keyframable.
- compute: emit `{ kind: "notes", notes }` passing the stored ARRAY BY
  REFERENCE (identity fast path downstream, same rule as instruments).
- Extra params: `default_velocity` (0..1, 0.8) — pencil's velocity for
  new notes (X-accent has no meaning here; velocity is per-note).
- On the node graph the node shows a compact chrome: note count + an
  **Edit** button on the header (the second engagement path).

## Editor architecture — cover, never unmount

**HAZARD (from the integration map): if the primary `<canvas>` unmounts,
`renderFrame` bails (EffectsApp.tsx:2384), evals stop, and
`audioEngine.reconcile` (evaluator.ts:1969) stops with them — the editor
would silence the audio it authors.** So the piano roll is a FULL-COVER
SIBLING overlay inside the primary viewport's clipPath wrapper (the
Scene3DViewport pattern, EffectsApp.tsx:11499), mounted next to the other
overlays (~:11538). The canvas stays in the tree (optionally
`visibility: hidden` while covered); evals, watch-viewport blits, and the
audio engine keep running.

Engagement state: `midiEditNodeId: string | null` in EffectsApp — set by
NodeEditor double-click on a midi-editor node and by the header Edit
button; cleared by Esc (editor's own handler) and by `selectedId`
changing to a different node. NOT gated on `showGizmos` (that toggle is
for on-canvas handles).

The editor is **DOM/SVG like every other editor in the app** (no 2D
canvas — hover states, shortcut scopes, and portal menus all assume DOM;
note counts here are small).

## Layout & machinery reuse (per the integration map)

- **Horizontal**: `useTimelineView` as-is (tick↔px, cursor-anchored zoom,
  `fit(width, sceneDurationTicks, KEYBOARD_GUTTER_PX)`).
- **Vertical**: new `usePitchView` sibling hook (~40 lines): `noteRowPx`
  (zoomable row height), `viewPitchOffset`, `pitchToPx`/`pxToPitch`,
  clamp to MIDI 0..127. Black-key rows get a darker wash (Logic).
- **Keyboard gutter** on the left: white/black keys, octave labels
  (C2/C3…), click = audition that pitch. Width feeds `fit`'s gutter arg
  and `PlayheadLine`/`PlayheadHandle`'s `leftOffset`.
- **Ruler**: bars/beats/divisions ladder (new `beatSpacing()` beside
  ruler.ts's frame ladder; conversions via beatsToTicks + ctx-equivalent
  project bpm from props). Bar numbers like Logic's 1 2 3. Frame ticks
  (`FrameTicks.tsx`) available as a secondary row later — v1 is musical
  only.
- **Theme**: reuse timeline theme.ts metrics/zoom tokens wholesale; add
  NOTE tokens (fresh hue + a velocity ramp — low-velocity cool/dim →
  high-velocity hot, Logic-style) TO theme.ts (single-palette rule).
- **Playhead**: PlayheadLine + PlayheadHandle as-is (self-subscribing
  clock leaves). HARD CONSTRAINT: the editor shell never reads the tick
  at top level — playback must re-render only the playhead leaves.
  Ruler click/drag seeks (PlayheadHandle's onStartScrub).
- **Pan/zoom**: copy TrackEditor's container-level wheel + middle-mouse
  handlers wholesale (TrackEditor.tsx:669-791), including
  `getEffectiveDevice()` idioms: trackpad two-finger = pan (both axes —
  vertical pans pitch), Cmd/Ctrl+wheel = horizontal zoom about cursor,
  mouse wheel = zoom, Shift = vertical scroll; middle-drag = pan.
  MUST `preventDefault`/`stopPropagation` (container listener,
  passive:false) — the window-level viewport pan/zoom
  (useViewportGestures) hit-tests the viewport rect underneath and will
  bleed through otherwise (the documented curve-dock escape hatch).

## Interactions (Logic grammar)

- **Left click**: select note (Shift extends). Click empty = deselect;
  drag empty = marquee (timeline MARQUEE_* tokens).
- **Drag note** = move (time + pitch together). Snap: division dropdown
  (Bar, 1/1..1/32, Off; default 1/16) — snap the note HEAD to the grid
  (clip-ops precedent), Shift bypasses snap (app-wide policy). Vertical
  = chromatic; moving previews the note at its new pitch (throttled).
- **Drag note edge** (right edge, CLIP_EDGE_PX slop) = resize; min
  length one division (snapped) or 1 tick (unsnapped).
- **Hold B** = pencil quasimode (PaintOverlay hold-pattern: keydown sets,
  keyup AND window blur clear; e.repeat/modifier/isTyping guards;
  pointer-inside-rect gate). Click = add note at last-used length
  (default: one division) at `default_velocity`; click-drag = add and
  size in one gesture. Release B → back to select. The bare-B collision
  audit is clean: paint/spline `b` handlers only mount for THEIR
  selected node types, which are mutually exclusive with an engaged
  midi editor; TrackEditor's Cmd/Ctrl+B is behind the modifier bail.
- **Alt+vertical-drag** on a note/selection = velocity (color updates
  live). Alt+click shows a small velocity readout.
- **Delete/Backspace** = delete selection (scope-gated:
  `getShortcutScope() === "midi"`, spline precedent — must not delete
  the graph node). **Cmd/Ctrl+A** select all. **Cmd/Ctrl+D** duplicate
  selection one grid division later. Copy/paste within the editor
  (internal clipboard) — cross-node paste later.
- **F** = fit notes (or whole scene when empty) — TrackEditor
  focusSelection precedent.
- All note mutations go through a pure **`note-ops.ts`** (copy
  clip-ops/keyframe-ops policy: drag-start snapshot → rebuild from
  originals per move → commit on release; gesture-delta clamping at
  tick 0; per-pitch-row overlap policy = DRAGGED WINS, stationary notes
  trim/drop under the moved ones). Covered by a new
  `scripts/check-note-ops.mts` in `npm run check`.
- **Writes**: one `onParamChange(nodeId, "notes", next, gestureKey)` per
  user-visible operation (release-only during drags), gestureKey from
  `nextGestureKey("note-<op>")` — standard graph undo, one entry per
  gesture. NO paint-style undo lane (notes are small JSON).

## Audition (previewNote)

New optional instrument contract + engine method (integration-map
design):

- `StageHandles.triggerNote?(pitch, velocity, durationSec)` — one line in
  each instrument adapter (`triggerAttackRelease(..., undefined, vel)`),
  synth/fm via midiToFreq, sampler via note name.
- `audioEngine.previewNote(instrumentStageId | null, pitch, velocity,
  durationSec)`: fires the live instrument stage's triggerNote; when no
  live instrument exists (nothing wired / never evaluated), a lazily
  created built-in preview synth (quiet, plain Tone.Synth) plays
  instead.
- **The paused-master problem (flagged by the scout — PROTOTYPE FIRST,
  M2's first task)**: master gain is 0 while the timeline is stopped, so
  a preview through the real chain would be inaudible exactly when
  authoring happens. Design: engine keeps a dedicated always-open
  `previewGain → destination`; while NOT playing, previewNote
  temporarily connects the instrument's chain SINK output to previewGain
  for `durationSec + tail` then disconnects (you hear the note through
  YOUR effects). While playing, the normal master path is open — no
  extra connection (no doubling). Known accepted edge: a free-running
  generator sharing the same chain sounds during the preview window.
  The fallback synth routes straight to previewGain.
- The editor auditions on: pencil note-add, keyboard-gutter click, and
  (throttled) pitch change during a move drag. Which instrument: BFS
  forward from the midi node's `notes` output to the first instrument
  node (the active3DSceneRenderId forward-walk precedent), then
  `previewNote(thatNodeId, …)`.

## Sharp edges (pre-answered)

- Cover, never unmount the primary canvas (above).
- Editor shell must not subscribe to the clock (playhead leaves only).
- Wheel/middle-mouse bleed-through into viewport pan/zoom — container
  listeners + stopPropagation, both axes.
- The primary viewport is NOT detachable, so no `ownerWindow` concerns
  for v1 (the editor lives only in the main window).
- Quasimode hygiene: clear held-B on window blur or the mode wedges.
- `notes_clip` ParamType ripple is SMALL (types union + ParamPanel
  exclusion alongside paint/spline_anchors + isKeyframable false +
  export-manifest exclusion); no socket-type ripple (`notes` socket
  already exists).
- Back-compat: new node type only; no existing types/params change.

## Milestones

- **M0 — Shell** (one owner; EffectsApp monolith surgery): node def +
  `notes_clip` param type + engagement state (double-click, Edit
  button, Esc/select-away close) + full-cover panel with keyboard
  gutter, bar/beat ruler, grid, playhead (seek included), pan/zoom.
  Renders existing notes read-only. Exit: engage/disengage cleanly with
  video playing underneath (watch a second viewport leaf to confirm
  evals never stop); playhead tracks playback with no shell re-render.
- **M1 — Editing** (one owner, mostly inside MidiEditor + pure
  note-ops.ts): select/marquee/move/resize/delete/duplicate/velocity,
  hold-B pencil, snap menu, F-fit, undo coalescing,
  check-note-ops.mts. Exit: author the Logic screenshot's phrase from
  scratch; every gesture = one undo entry; `npm run check` green.
- **M2 — Audition + polish**: previewNote prototype FIRST (paused-master
  routing), then triggerNote adapters, engine method, fallback synth,
  keyboard-click + pencil + drag-pitch auditions, harness scenario
  (previewNote through a live synth stage → tap RMS while transport
  stopped). Exit: place notes deaf-free while paused.
