# Pointer Interaction — click, click-drag, and direct manipulation

Spec (2026-08-17). Supersedes the archived brainstorm
`specdocs/archive/click-interaction.md` (routes #1–#7 surveyed there; this
doc is the buildable design). Decisions resolved with the owner:

- **Both surfaces are the bar**: the editor viewport and exported apps /
  live links are equally first-class. (LiveViewer already mirrors the
  editor's cursor plumbing, so parity is an invariant, not a feature.)
- **Full v1 scope**: Pointer node + signal utilities (Trigger Envelope,
  Sample & Hold) + Hit Region + direct manipulation (Drag Points,
  Draggable).
- **New Pointer node** for the signal vocabulary; the existing Cursor node
  stays a visual generator (and gains a `position` aux as a side fix).
- **Editor gating**: presses consumed by an active overlay gesture (gizmo
  drag, spline tool, paint stroke, 3D viewport drive) are suppressed from
  the graph; bare-canvas presses flow.

## 1. The event-encoding rule (why the design looks like this)

The graph is pull-based and re-entrant: several `evaluateGraph` runs can
happen per animation frame (socket peek, spreadsheet, Iterate / Time
Offset nested evals, bake). A "pulse flag cleared after read" therefore
fires on whichever eval reads it first — silently wrong.

**Rule: the host publishes monotonic FACTS on `ctx.cursor`; nodes derive
edges themselves by diffing against `ctx.state`.** Facts never reset
mid-frame; deriving is idempotent under repeated evals. Corollary: nodes
read ONLY `ctx.cursor` — never the DOM — so record/replay and synthetic
input (MCP-driven interaction tests) later reduce to feeding recorded
fact streams with zero node changes.

### 1.1 `CursorState` extension (engine/types.ts)

```ts
interface CursorState {
  x: number; y: number;        // canvas UV, Y-UP (existing)
  active: boolean;             // existing
  pressed?: boolean;           // existing level — semantics unchanged
  serial?: number;             // NEW — increments once per published snapshot (per rAF)
  pressCount?: number;         // NEW — monotonic, +1 per unsuppressed press-in-canvas
  releaseCount?: number;       // NEW — monotonic
  pressX?: number; pressY?: number;     // NEW — latest press position, canvas UV Y-UP
  releaseX?: number; releaseY?: number; // NEW
  pressTimeMs?: number; releaseTimeMs?: number; // NEW — performance.now()
  gestureMaxDistPx?: number;   // NEW — max travel from press point, CSS px,
                               // reset at press, frozen after release
}
```

All new fields optional (embedder-compat, same as `pressed`). The
`gl.ts` `makeContext` fallback default grows to include them zeroed —
today it omits `pressed` entirely; fix that while in there. Offline
export contexts carry the zeroed default, so interaction nodes emit rest
values deterministically.

### 1.2 Snapshot-per-frame publishing

Event listeners accumulate into a pending record; the capture module
**commits an immutable snapshot once per rAF** (before the eval), bumping
`serial`. Every eval in that rAF — including nested Iterate / Time Offset
evals — sees identical facts.

`serial` is what makes one-frame pulses derivable while paused (when
`ctx.frame` doesn't advance but cursor-bump re-evals do run):

```ts
// per node, in ctx.state:
if (cursor.pressCount !== st.lastPressCount) {
  st.lastPressCount = cursor.pressCount;
  st.pressPulseSerial = cursor.serial;
}
const press = st.pressPulseSerial === cursor.serial ? 1 : 0;
```

Idempotent within a frame; clears on the next snapshot. This recipe (and
its release/click siblings) lives in one shared helper —
`src/engine/cursor-signals.ts`, pure, engine-side — used by every
consuming node so nobody re-derives it subtly wrong.

### 1.3 Click vs drag discrimination

Split: **the host measures, the node thresholds.** Pointermove events
between frames are invisible to nodes, so the host tracks
`gestureMaxDistPx` (CSS px, screen-perceived). A node reads it at the
release edge: under its `slop` param ⇒ *click*; over ⇒ it was a *drag*.
Drag-active while held = `gestureMaxDistPx > slop`.

### 1.4 Shared capture module (de-duplication, load-bearing)

`EffectsApp.tsx:1894-2014` and `LiveViewer.tsx:94-156` are near
line-for-line duplicates today. Before growing the schema, extract
`src/lib/cursor-capture.ts`: owns the listeners (capture-phase
down/up/cancel, bubble move, leave), the UV math + Y flip, the
press-started-inside rule, gesture tracking, snapshot commit, and the
claim check (§1.5). Both hosts mount it against their preview element and
read snapshots from it. LiveViewer keeps its rAF-always loop; EffectsApp
keeps its cursorTick paused-re-eval bump.

### 1.5 Editor gesture suppression (pointer claims)

New tiny module `src/lib/pointer-claim.ts`: overlays call
`claimPointer(pointerId)` when a gesture begins and `releaseClaim` when
it ends. The capture module treats a claimed gesture as suppressed: the
press never increments `pressCount`, `pressed` stays false, and no
release edge fires at its end. Position keeps flowing (hover is never
suppressed).

Ordering subtlety, solved by snapshot commit: the window-level
capture-phase pointerdown fires BEFORE the overlay's bubble-phase handler
starts its gesture — so the claim arrives *after* the press is recorded.
Because the snapshot commits at the NEXT rAF, a claim made during the
same event-loop turn retroactively marks that pending press suppressed.
No overlay changes to capture phase needed.

Claim sites (add at gesture start / end): TransformGizmo,
PrimitiveGizmo, spline-editor drag.ts (all tools), paint-editor strokes,
GradientOverlay, MotionPathOverlay, SegmentDotsOverlay,
KeyerSampleOverlay, Scene3DViewport (orbit/pan/dot-drag/axis-drag).
Live viewer has no overlays — nothing to claim; exported apps are always
fully live.

## 2. Coordinate + flag conventions (state once, obey everywhere)

- Position-typed outputs are **authored space**: `[0,1]² Y-DOWN`,
  `x = cursor.x`, `y = aspectUncorrectY(1 − cursor.y, W/H)` — so they
  wire straight into Transform translate, point positions, force
  centers. Exactly cursor-trail-points' conversion; the authored-space
  aspect bug has been fixed five times, hence this bullet.
- Distances (slop, grab radius) compare in **pixel space with width
  scaling on BOTH axes** (`dx*W, dy*W`) so radii bound circles
  (cursor-trail-points.ts:240 precedent).
- Every consuming node: `stable: false`, `retimeable: false`, and
  `fingerprintExtras` folding a **change token** (counts + quantized
  x/y), not raw floats-per-move where avoidable — the two-tier idiom
  (cursor.ts folds raw; cursor-trail-points folds a token).
- Interaction state is **runtime-only** (like sim state): not saved, not
  exported; `reset` inputs and loop-clear params follow the
  cursor-trail-points precedent.
- Wall-clock (`performance.now()`) for anything that must respond while
  the editor is paused; `ctx.time` only behind an explicit clock param.

## 3. The nodes

### 3.1 Pointer (source/pointer.ts) — the signal vocabulary

Utility category, CPU-only. Description mentions "mouse", "click",
"drag", "touch" for add-menu search.

- **Primary**: `position` (vec2, authored, live cursor).
- **Aux**: `held` (scalar level) · `press` / `release` / `click` (scalar
  pulses; click = release with travel ≤ slop) · `click_position` (vec2,
  latches per click) · `drag_active` (scalar level) · `drag_delta`
  (vec2, current gesture displacement, authored units) · `drag_offset`
  (vec2, **accumulated across gestures** — the virtual-scrub output) ·
  `duration` (scalar, seconds held) · `click_count` (scalar, monotonic).
- **Inputs**: `reset` (scalar >0.5 zeros `drag_offset`, `click_position`,
  `click_count`, holds while high — Accumulator's reset grammar).
- **Params**: `slop` (px, default 4) · `axis` (both/x/y, applies to drag
  outputs) · `sensitivity` (scale on `drag_offset`, default 1) ·
  `clear_on_loop` (bool, default off — zeroes accumulated state when the
  timeline wraps).

Side fix, independent: existing Cursor node gains a `position` vec2 aux
(authored space) — shortest-path.ts:33 and devlist:97 already assume it.

### 3.2 Trigger Envelope (effect/trigger-envelope.ts)

Pulse → motion. Input `trigger` (scalar; rising edge through 0.5 starts
the envelope, so both pulses and levels work). Output scalar 0→1→0.

- Params: `attack` / `hold` / `release` (seconds) · `attack_curve` /
  `release_curve` (existing easing presets) · `retrigger`
  (restart | ignore-while-active) · `clock` (wall | timeline, default
  wall — timeline makes audio-beat-driven envelopes deterministic and
  export-renderable; this node is equally an audio-reactivity tool).

### 3.3 Sample & Hold (effect/sample-hold.ts)

Inputs `value` + `trigger`; output latches `value` on each rising edge.
`type` param (scalar | vec2 | vec3 | vec4) retypes via `resolveInputs`
(Switch precedent). `initial` param: zero | follow-until-first-trigger
(default follow). Generalizes sticky-click-position to any signal
(latch an audio level per beat, a random per click…).

### 3.4 Hit Region (effect/hit-region.ts) — the button primitive

Input `region` (mask — so spline→mask coercion makes ANY shape a
button; image thresholds work too). Gates pointer signals on the region
with **grab semantics**: hit-test at press time; the gesture stays owned
until release even if the cursor exits (how real buttons behave).

- Aux outputs: `hover` (level) · `press` / `click` (pulses, gesture must
  START inside) · `held` (level while owning the gesture) · `drag_delta`
  (vec2, owned gesture only).
- Params: `threshold` (mask ≥, default 0.5) · `slop` (px).
- Hit test = 1×1 `readImagePixels` at the cursor (image→scalar coercion
  precedent). Perf: cache by (quantized position, region fingerprint) so
  the readback runs only when either moved; press-time tests are
  one-shot.

### 3.5 Drag Points (effect/drag-points.ts) — direct manipulation, points

The DAG-cycle escape: "drag the thing" needs the hit region to follow
the thing, which depends on the drag output. Answer: **state lives
inside the node.**

Points in → points out with per-point interactive offsets stored in
`ctx.state`. Hit-tests the cursor against input-position-PLUS-stored-
offset (px space, width-scaled), grabs the nearest point within
`grab_radius` (px, default 16), moves it while held. Output built with
`copyPointsWith` (attributes/z/groups survive).

- Aux: `active_index` (scalar, −1 when none) · `grabbed` (level).
- Input `reset` clears all offsets. `clear_on_loop` param.
- **Known limitation (state in doc + node description)**: offsets are
  keyed by index; if the upstream point set reorders or changes count,
  offsets reset (count change) or land on the wrong points (reorder).
  Works best on stable point sets — Grid, Spline to Points with fixed
  count, authored points. A stable-id attribute is the future fix.

### 3.6 Draggable (effect/draggable.ts) — direct manipulation, shapes

Input `handle` (mask; splines coerce). Internal accumulated `offset`
vec2. **Hit-test trick: sample the UN-translated mask at
`cursor − offset`** — equivalent to sampling the translated mask at the
cursor, so the handle follows its own drag with no mask re-render and no
cycle. Primary output `offset` (vec2, authored units); aux `held`,
`hover`, `press`.

Canonical recipe (docs page): `Shape → Draggable.handle`;
`Shape → Transform ← Draggable.offset` (added to translate). DAG, and
the visible shape tracks the drag exactly.

## 4. Interactions with existing systems

- **Accumulator gates on `ctx.playing`** — fine for its purpose, but the
  Pointer node's own accumulation (drag_offset, click_count) must NOT be
  playback-gated, or editor-paused interaction dies. Live viewer always
  "plays", so this only shows in the editor. (Optionally later: a
  "run while paused" param on Accumulator so `press → Accumulator`
  counters work paused too.)
- **Keyframe precedence** (wire > keyframes) means wiring interaction
  into a param displaces its keyframes — expected, same as any wire.
- **Time Offset / Iterate**: `retimeable:false` on every consumer makes
  them closure boundaries (outer value fed in), same as Cursor today.
- **Offline export**: zeroed cursor default ⇒ rest values; interactive
  output is the live-link surface. Verify during M0 whether
  viewer-export.ts GIF/video capture records live interaction state
  (it captures the running canvas, so it should — confirm).
- **`pipeline-bump`**: Pointer-family nodes fire it (cursor-trail-points
  precedent) so paused-editor interaction keeps re-evaluating.

## 5. Milestones

- **M0 — facts + capture + claims.** SHIPPED 2026-08-17 (typecheck /
  check / lint:ratchet green; `scripts/check-cursor-capture.mts` guards
  the state machine — 44 assertions. Manual pass still owed: Cursor
  Trail Points press-draw in the editor AND a live link, per §5 M0).
  `CursorState` extension; extract
  `src/lib/cursor-capture.ts` (both hosts ride it — behavior-identical
  for existing consumers, verify Cursor Trail Points press-draw in
  editor AND a live link); `gl.ts` default fixed; snapshot-per-rAF with
  `serial`; `pointer-claim.ts` + claim calls in the overlay sites;
  `engine/cursor-signals.ts` edge-derivation helpers (pure — candidate
  for a `scripts/check-cursor-signals.mts` guard on the
  snapshot/claim/edge logic).
- **M1 — Pointer node** + Cursor `position` aux + docs manifest page.
  SHIPPED 2026-08-17 (all gates green; check-cursor-capture grew an
  end-to-end Pointer section — capture core → signals → compute,
  including authored-space conversion at aspect 2 and the fingerprint
  pulse-tail). Docs needed no manifest work: node-category pages
  auto-generate from the registry, so Pointer appears on
  /docs/nodes/utility from its def. Manual pass owed with M0's: wire
  Pointer.click → anything visible in the editor and in a live link.
- **M2 — Trigger Envelope + Sample & Hold.** SHIPPED 2026-08-17 (gates
  green; deterministic envelope coverage in check-cursor-capture rides
  the timeline clock).
- **M3 — Hit Region.** SHIPPED 2026-08-18 (gates green; grab semantics
  covered in check-cursor-capture via the exported pure deriveHitRegion
  + a synthetic disk field). The planned readback cache was dropped
  deliberately: a pooled mask texture's identity says nothing about its
  content, so a cached hit test can silently read stale — one 1×1
  sample-at-UV pass + readback per eval (two on press edges) instead.
- **M4 — Drag Points + Draggable.** SHIPPED 2026-08-18 (gates green;
  coverage includes the offset-compensated grab — the moved shape
  grabs at its new position, not its rest position — and re-entrant
  release passes). Also fixed in this pass: pulse-driven `+=` side
  effects fold once per pass via serial guards (Pointer's drag_offset /
  click_count double-applied under peek-forced second evals).

### Shipped alongside: Cursor node value-identity fix (2026-08-18)

Cursor → Copy to Points `scale_field` / `rotate_field` (and Modulate
Points) never responded to the pointer: those consumers key their CPU
field-readback caches on ImageValue OBJECT identity ("new object =
upstream recomputed"), and Cursor returned its persistent state-owned
wrappers while redrawing the textures in place — so the field was read
once and frozen. Cursor now mints fresh wrapper objects per eval (same
textures). Rule for any future in-place-redrawing producer: **identity
must track content — redrawn-in-place ⇒ re-wrap.**

### Shipped alongside: field-sampling aspect drift fix (2026-08-18)

The identity fix exposed a second latent bug: every "sample an image at
a point's position" path sampled at the point's raw AUTHORED coords
instead of its canvas position — invisible with noise fields, but a
localized Cursor falloff visibly drifted on non-square canvases (and
the Copy to Points GPU path was additionally y-MIRRORED: it sampled a
y-up texture at y-down coords). Fixed in all four samplers: Copy to
Points' instanced VS (fields now sample at the aspect-corrected,
flipped instance center), Copy to Points' CPU luma sampler (also serves
the image-driven variant pick), Modulate Points, and Sample Texture at
Points. Convention now enforced everywhere: authored y →
0.5 + (y − 0.5) × aspect before sampling a canvas-space texture; each
sampler owns its own buffer-orientation flip. Caveat: projects that
used a vertical-gradient scale/rotate field on the GPU path were
compensating for the mirror — their response flips to the (correct)
orientation.
- **M5 — polish.** Devguide + node-catalog descriptions (AI recipes see
  the new vocabulary), docs pages for the direct-manipulation recipes,
  live-link end-to-end pass on desktop + iPad (touch parity is free via
  pointer events — verify, don't assume).

## 6. Deferred (designed-for, not built)

Multiple buttons + modifier keys · double-click / long-press (add as
Pointer params later; timestamps already in the facts) · multi-touch
("Touches → points" node — additive once capture tracks non-primary
pointers) · 3D picking (raycast `object3d` — own project) · keyboard ·
record/replay onto the timeline (the facts-only rule keeps it a pure
addition) · stable point ids for Drag Points across regenerating sets.
