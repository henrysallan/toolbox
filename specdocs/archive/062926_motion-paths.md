# Motion paths for animated position (devlist #160)

Status: **v1 implemented** (2026-06-29).

## Goal

When a node's XY position is keyframed, draw the trajectory on the preview
canvas: a dashed line through the position over time, with a draggable marker
at each keyframe — like the motion path in any MoGraph package.

## The "disconnected XY" question

X and Y position are two **independent** scalar keyframe tracks
(`translateX`/`translateY`, `centerX`/`centerY`, …). They can have different
keyframe ticks and different easing. This turns out not to be a problem:

- **Drawing the path:** sample each track independently with
  `evaluateKeyframesAt` at small tick increments and plot `(x(t), y(t))`. The
  path naturally shows whatever curvature the two tracks' separate easing/timing
  produce. (There is **no shared spatial bezier** — you can't grab a tangent
  handle and bend the curve in space. The curve shape is a consequence of the
  per-axis easing only. Accepted for v1.)
- **The markers:** a marker at tick `T` represents the **full** position
  `(x(T), y(T))`, placed at the **union** of the X and Y keyframe ticks.
- **Dragging a marker:** writes a keyframe to **both** the X and Y param at tick
  `T` (inserting on whichever track lacks one there, enabling animation if
  needed). This unifies the two tracks at the moments the user cares about and
  matches AE-style behavior.

## Decisions

- **Drag semantics:** set both X and Y at `T` (confirmed with owner).
- **v1 scope:** full feature — path + draggable markers (confirmed).
- **Display guard:** show the draggable path only when **both** axes are
  animated (`animated && keyframes.length > 0`) and their union has ≥2 distinct
  ticks. Rationale: if only one axis is animated, dragging along the constant
  axis would insert that axis's *only* keyframe → a single constant value
  across the whole timeline (a surprising global shift). Requiring both
  animated keeps every drag an edit among existing keyframes. Relaxable later
  (e.g. a read-only path when only one axis animates).
- **Anchor point:** for translate-driven nodes the marker sits at
  `translate + pivot` (so the current-frame marker coincides with the gizmo's
  pivot handle); for centered primitives it's the center param directly.
- **No spatial-bezier editing** in v1 (only the keyframe points move).
- **No clamping** of dragged positions — motion paths routinely run off-canvas.

## Implementation map

- `src/components/effects/MotionPathOverlay.tsx` — the overlay. Standalone
  (mirrors the other overlays' `getBoundingClientRect` + `ResizeObserver` +
  `rectsEqual` pattern). Props: the two `KeyframeAnimationBlock`s, constant
  fallbacks, pure `toCenter`/`fromCenter` mappings (param-value ↔ normalized
  canvas center), an `aspectCorrect` flag (must match the host gizmo's `toPx`),
  `currentTick`, `ticksPerFrame`, and `onPointDrag(tick, xVal, yVal)`. Renders
  a faint trajectory `<polyline>` (per-segment subsampled so eased curves are
  smooth), **equal-time speed dots** (sampled at uniform time steps — ~one per
  frame, clamped 8–160 — so screen spacing reflects speed: close = slow, spread
  = fast, an eased segment fans them out to show acceleration), and a rotated-
  square "diamond" per union keyframe tick (the playhead's is highlighted).
  Drag is delta-based off the marker's start center.
- `src/components/effects/PrimitiveGizmo.tsx` — `PrimitiveGizmoAdapter` gains an
  optional `motionPath: { x, y, toCenter?, fromCenter? }`. Populated for
  `circle` (centerX/Y, identity), `rectangle` (originX/Y, identity),
  `liquid-glass` (posX/Y, identity), `text` and `autolayout` (translateX/Y, with
  a +0.5 center offset). `toCenter`/`fromCenter` default to identity.
- `src/components/effects/EffectsApp.tsx`:
  - `onMotionPathPointChange(nodeId, xParam, yParam, tick, xVal, yVal,
    coalesceKey)` — one `pushGraph` + one `setNodes` that `upsertKeyframe`s both
    axes at `tick` (enabling `animated`). Writes off-playhead (the tick comes
    from the dragged marker, not `currentTick`), so it can't route through
    `onParamChange`'s autokey. The shared `motionpath:<id>` coalesce key makes a
    whole drag one undo entry.
  - Mounted as a sibling **after** each gizmo inside the
    `activeTransformNode` / `activePrimitiveNode` blocks (so its diamonds paint
    on top and win pointer events, while the rest of the overlay is
    `pointer-events:none` and the gizmo still handles drags on empty canvas).
    Transform supplies its binding inline (translateX/Y, `aspectCorrect`,
    pivot-offset center); primitives read it from `adapter.motionPath`
    (`aspectCorrect:false`).

## Coordinate notes

- Transform/SVG Source use the aspect-corrected mapping (`aspectCorrectY` /
  `aspectUncorrectY`), matching `TransformGizmo.toPx`. Center =
  `(translateX + pivotX, translateY + pivotY)`.
- Spline primitives map `[0,1]²` linearly to the displayed canvas (no aspect
  correction), matching `PrimitiveGizmo.toPx`.

## Possible follow-ups

- Click a marker (without dragging) to seek the playhead to its tick.
- A read-only path when only one axis is animated.
- ~~On-path velocity ticks~~ — DONE: equal-time speed dots (see above).
- Optional spatial-tangent editing if/when X and Y are ever expressed as a
  single 2D position param.
