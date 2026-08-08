# Spec Addendum: Per-Parameter Keyframes and Track Editor

This addendum **replaces** the earlier Timeline node / Graph Editor spec.
The earlier model (Timeline nodes with internal keyframes)
is dropped in favor of a more conventional per-parameter keyframe system,
similar to After Effects.

SceneTime and Remap nodes are kept. They remain valid procedural
animation primitives. Wiring a SceneTime-driven chain into a parameter
overrides that parameter's keyframes for as long as the wire exists.

---

## 1. Per-parameter keyframing

### 1.1 Parameter row layout

Every parameter row in the node inspector lays out left-to-right as:

```
[ 👁 visibility ] [ name ] [ slider ] [ numeric value ] [ ◆ keyframe ]
```

- **Visibility toggle** (eye icon) sits to the **left of the slider**.
  Always present on every parameter for layout consistency — dim/disabled
  when the parameter is not animated, active when it is. Controls whether
  the parameter appears as a track in the Track Editor (see §3.1).
- **Keyframe toggle** (diamond) sits **to the right of the numeric value**.
  This is the single affordance for both enabling animation and inserting/
  removing keyframes at the playhead (see §1.2).

### 1.2 The keyframe toggle (diamond)

Every parameter on every node — scalar, vector, color, boolean, enum —
gets a diamond keyframe toggle. It is a single button whose meaning
depends on context (animation state and playhead position). Three visual
states:

- **Empty (hollow/dim)**: animation is off. Parameter is a constant.
  Clicking turns animation on and inserts the first keyframe at the
  current playhead with the parameter's current value.
- **Yellow (filled)**: animation is on; the playhead is *not* on an
  existing keyframe. Clicking inserts a new keyframe at the playhead.
- **Red (filled)**: animation is on; the playhead is exactly on an
  existing keyframe. Clicking removes that keyframe. If it was the last
  remaining keyframe, the parameter stays in animated-mode with no
  keyframes (auto-keyframing on subsequent edits will repopulate it).

To turn animation **off** entirely (preserving keyframe data), use the
right-click menu on the diamond → "Disable animation." Re-enabling from
the same menu restores the keyframes as they were. This non-destructive
disable matters — users toggle animation off to compare states without
losing work — but it is intentionally not the primary click action,
because primary-click is the much more frequent insert/remove gesture.

### 1.3 Boolean / enum / non-interpolatable parameters

Not every parameter type interpolates smoothly. Booleans, enums, and
discrete-valued parameters can still be keyframed but their interpolation
is implicitly **step** — the value snaps to the new keyframe's value at
the keyframe's time, with no in-between blending. Easing presets are
hidden in the right-click menu for these keyframes.

This means: yes, you can animate "blend mode = multiply at time 1.0,
blend mode = screen at time 2.5." The blend mode jumps at 2.5.

### 1.4 Wired parameters override keyframes

A parameter can be (a) constant, (b) animated via keyframes, or (c)
driven by an incoming wire from another node. These are mutually
exclusive at evaluation time, but keyframe data is preserved when a wire
is active.

Behavior:

- If a wire is connected to the parameter's input socket, the wire's
  value is used. Keyframes are ignored. The keyframe toggle is shown but
  visually muted, with a tooltip explaining "wired — disconnect to use
  keyframes."
- If the wire is disconnected, the parameter falls back to its previous
  state — keyframes if the toggle was on, constant value if not.
- The user cannot directly edit a wired parameter's value; it's read-
  only while wired.

This is the intentional choice that keeps SceneTime + Remap useful as a
parallel animation model. Users who want procedural animation wire it in;
users who want keyframe animation use the toggle. They don't mix on the
same parameter, but they coexist in the same graph and on different
parameters of the same node.

### 1.5 Time, ticks, and the playhead

All keyframe operations need a notion of "the current time," which comes
from the global scene playhead. There is one global playhead, controlled
by the play/pause/scrub UI above the canvas. Every keyframe insertion,
modification via canvas manipulation, or "go to next/previous keyframe"
operation references this single playhead.

**Storage unit: integer subframe ticks.** All time values — keyframe
positions, scene duration, playhead — are stored as integer ticks at a
fixed subframe resolution (e.g., 1000 ticks per frame). Integers, not
floats: equality comparisons are exact, sorting is unambiguous, and there
is no floating-point drift across long timelines.

**Display unit: frames.** Everything the user sees is in frames. The
ruler is marked in frames (with seconds shown as a secondary annotation
based on the project FPS). Playhead scrubbing snaps to whole frames by
default. Keyframe drags snap to whole frames by default; **holding Shift
during a drag** unlocks subframe positioning at full tick resolution.

**FPS is metadata, not a unit.** Changing the project FPS does *not*
rescale tick values. A keyframe at tick 144000 stays at tick 144000;
its position in frames and seconds shifts because frames are derived
from ticks via FPS. This means raising FPS makes the same animation
play back at the same wall-clock speed but with finer playback
sampling — it does not move keyframes around.

Scene duration is stored in ticks. Keyframes past the scene duration
still exist in the data but aren't reachable via playback unless the
duration is extended.

---

## 2. Inserting and editing keyframes

### 2.1 Inserting via the keyframe toggle

Clicking the diamond when animation is **off** turns animation on and
creates the first keyframe at the current playhead with the parameter's
current value. Clicking the diamond when animation is on inserts (or
removes, if exactly on a keyframe) at the playhead — see §1.2.

### 2.2 Auto-keyframing on parameter edit

When a parameter has animation on:

- Editing the parameter's value (via the numeric input, slider, or canvas
  manipulator) at a playhead frame *where no keyframe exists* inserts a
  new keyframe at the current playhead tick with the new value, using
  the user's default easing preset (configurable; default
  "ease-in-out").
- Editing the parameter's value at a playhead position *where a keyframe
  already exists at the same tick* updates that keyframe's value. Easing
  is unchanged.

Because time is integer ticks and the playhead snaps to whole frames by
default, the "same tick or not" check is exact — no fuzzy tolerance is
needed. (If the user shift-scrubbed to a subframe tick, that exact tick
governs the comparison.)

### 2.3 Auto-keyframing requires animation to be on

If the keyframe toggle (diamond) is **off** when the user edits a value
or drags a canvas handle, the edit just changes the constant value — no
keyframe is created and animation is not implicitly turned on. To start
animating, the user must click the diamond first. (This matches AE and
prevents accidental animation creation while exploring values.)

### 2.4 Manipulating values via the canvas

When the user drags a handle in the canvas (Transform node move/scale/
rotate, etc.), this is identical to editing the parameter's value
directly — §2.2 and §2.3 apply. The handle drag updates the underlying
parameter, which inserts or updates a keyframe at the current playhead
tick if (and only if) animation is on.

This is straightforward in this model because **the parameter and the
keyframes are colocated**. There is no upstream node to back-propagate
into. The handle drag → parameter update → keyframe write flow is local
to one node. The previous spec's back-propagation problem is structurally
gone.

If the parameter is wired (not animated via keyframes), the handle drag
fails or shows a "cannot edit — parameter is wired" indicator. The user
must disconnect the wire to manipulate via the canvas.

---

## 3. The Track Editor

The Track Editor replaces the Graph Editor's slot in the UI — it lives
where the graph editor previously did, full-width, expandable/
collapsable. Default state: collapsed when no animated parameters are
visible-toggled, expanded otherwise.

### 3.1 Visibility toggles

The **visibility toggle** (eye icon, left of the slider — see §1.1) is
present on every parameter row for layout consistency, but only does
something when the parameter is animated. For animated parameters it
controls whether the parameter shows up as a track in the Track Editor.

- Visibility off: parameter is animated but doesn't appear in the editor
  (saves vertical space, used for parameters whose animation is set and
  forgotten).
- Visibility on: parameter shows as a track in the editor.
- Parameter not animated: toggle is rendered dim/disabled and has no
  effect.

Default: visibility on when a parameter is first keyframed. User can
toggle off to declutter.

**Track Editor default expanded/collapsed state:** collapsed when zero
tracks are visibility-on; expanded when at least one is.

### 3.2 Track grouping

Tracks are grouped by node in the editor. Each node with at least one
visible animated parameter shows as a collapsible header bar with the
node's name. Beneath the header, each animated parameter shows as its
own track row.

```
▼ Bloom
    ◆────◆──────◆──        threshold     [graph icon]
    ◆──────◆──────────     intensity     [graph icon]
▼ Transform
    ◆──◆────◆──────        translation.x [graph icon]
    ◆──◆────◆──────        translation.y [graph icon]
```

The node's header row is collapsible — clicking it hides all that node's
tracks (without affecting visibility toggles, just visual collapse).

The order of node groups in the editor matches the order parameters were
first keyframed (most recent at the bottom). User can drag node group
headers to reorder. Deferred to v1.5 if drag-reorder is too much for v1
— the auto-order is fine to start.

### 3.3 Track row anatomy

Each track row contains, left to right:

- The parameter name (e.g., "intensity" or "translation.x")
- A small **graph editor toggle** icon — clicking enters graph editor
  mode for that track (scalar tracks only; see §5)
- The track itself: a horizontal lane spanning the editor's full width,
  representing scene time
- Keyframes drawn as diamonds (or small shapes) at their scene-time
  positions
- Easing between keyframes shown subtly via the gap between diamonds
  (e.g., a thin curve preview, or a colored line indicating linear vs.
  eased) — keep this minimal so the editor doesn't become noisy

For vector parameters (vec2, vec3, vec4), the parameter is shown as
multiple tracks — one per component (`.x`, `.y`, `.z`, `.w`). Each
component is independently keyframed and edited. This matches AE.

For color parameters, the track shows a color ramp instead of diamonds —
each keyframe is a colored stop, and the ramp interpolates between them.
Right-clicking a stop opens its value/easing menu.

### 3.4 Time ruler

A horizontal ruler at the top of the editor shows scene time, marked
**primarily in frames**, with seconds shown as a smaller secondary
annotation derived from project FPS. The current playhead position is
drawn as a vertical line crossing all tracks. Clicking the ruler scrubs
the playhead — snapping to whole frames by default, with Shift held for
subframe scrubbing.

The editor's horizontal pan and zoom match the rest of the tool's
graph-style navigation (e.g., space-drag to pan, scroll to zoom). The
ruler's scale updates accordingly. At deep zoom levels the ruler shows
subframe tick marks.

### 3.5 Keyframe interaction

**Click a keyframe**: selects it. Shows its value and easing in a small
inspector at the bottom of the editor or in a popover. Multi-select via
shift-click and box-select.

**Drag a keyframe**: moves it in time, snapping to whole frames by
default. Hold **Shift** during the drag to position at subframe tick
resolution. Vertical drag is ignored (in the track editor; vertical
motion happens in the graph editor for scalar tracks).

**Box-select keyframes**: holding click on empty track space and
dragging creates a selection rectangle. All keyframes inside, across
multiple tracks, are selected.

**Bounding box transform on multi-select**: when 2+ keyframes are
selected, a bounding box appears around them. The user can:

- Drag the bounding box's interior to move all selected keyframes
  together in time
- Drag the left or right edge of the bounding box to **scale** the
  selected keyframes (proportional time stretch — keyframes move toward
  or away from the opposite edge)

This is the key retiming gesture. It enables the "stretch this whole
section to be longer" workflow in a way that matches AE's Alt-drag-end-
keyframe but works across multiple tracks at once.

**Right-click a keyframe**: opens a context menu with:
- **Set value...** — opens a numeric input (or color picker, etc.,
  depending on type)
- **Set easing**: submenu with presets — Linear, Ease In, Ease Out, Ease
  In-Out, Hold (step), Custom Bezier (only meaningful for scalar tracks
  in the graph editor)
- **Delete keyframe**

**Delete / Backspace with keyframes selected**: deletes them.

**Escape**: deselects.

### 3.6 Easing presets

Each keyframe stores an `easingOut` value — the interpolation from this
keyframe to the next. Presets:

- **Linear** — straight interpolation
- **Ease In** — slow start, fast end
- **Ease Out** — fast start, slow end
- **Ease In-Out** — slow start and end, fast middle
- **Hold** — value snaps; no interpolation. Holds until next keyframe.
- **Custom Bezier** — only available for scalar tracks. The keyframe
  additionally stores bezier handle data. Editable in the graph editor
  view (§5).

The preset names match what motion designers expect. The actual bezier
control points for each preset are standard easing curves (e.g., Ease
In-Out is approximately `cubic-bezier(0.42, 0, 0.58, 1)`).

For non-scalar tracks (color, vec, bool, enum), Custom Bezier is hidden
from the menu — only the named presets apply. (Step is the only easing
for bool/enum.)

### 3.7 Navigation controls

The Track Editor uses the same navigation conventions as the rest of the
graph-editor surface in the tool:

- Space + drag to pan horizontally and vertically
- Scroll wheel (or pinch) to zoom horizontally
- Shift + scroll to zoom vertically (mostly affects spacing of tracks
  for legibility, not data)
- Home key to fit the visible scene duration to the editor width
- F key to focus on selected keyframes (zoom to selection bounds)

Keep these consistent with the node graph and the canvas, so users learn
one navigation pattern and reuse it everywhere.

---

## 4. Vector and color tracks

### 4.1 Vector tracks

A vec2/3/4 parameter splits into one track per component in the Track
Editor. Each component is independently keyframed; manipulating the
parameter in the canvas inserts keyframes on whichever components
changed.

Example: dragging a Transform node's translation handle in the canvas
inserts keyframes on `translation.x` and `translation.y` if both changed,
or just one if only one component moved.

The component tracks share the parameter's bounding-box selection — box-
selecting across `translation.x` and `translation.y` tracks selects
keyframes from both, and they move together as a group.

**Toggles for vector parameters in the inspector.** A vec2/3/4 parameter
shows a single keyframe diamond and a single visibility eye on the
parent parameter row. Both apply to all components together: clicking
the diamond inserts (or removes) a coincident keyframe across every
component. The component sub-rows underneath show their numeric values
and small non-interactive state indicators (color dot mirroring the
parent diamond's state) but do not have their own toggles. This keeps
the inspector visually quiet while preserving full per-component editing
in the Track Editor and Graph Editor (§5.3).

### 4.2 Color tracks

A color parameter is a single track, rendered as a color ramp. Keyframes
are stops with color swatches. Right-clicking a stop opens a color
picker plus easing dropdown.

Interpolation between color stops happens in a chosen color space —
default is **OKLab** (perceptually uniform; produces natural-looking
gradients). RGB linear interpolation is available as a per-keyframe
easing variant if the user wants explicit control. HSV is *not* exposed
by default — it's a footgun for animation (creates color rotation
through unwanted hues).

The color space used is a per-track property, set on the parameter's
**keyframe diamond** right-click menu (alongside "Disable animation"),
not per-keyframe. Default OKLab, overridable to RGB-linear for power
users.

### 4.3 Why not also splits color into channels

Briefly considered: showing color as four tracks (R, G, B, A). Decided
against — color stops as a single ramp track is closer to how designers
think about color animation (a sequence of colors over time) and is
visually clearer in the editor. Per-channel editing is graph-editor
territory, not track-editor territory, and we're not doing graph editing
for color in v1.

---

## 5. Graph Editor for scalar tracks

### 5.1 Entering graph editor mode

Clicking the graph icon on a scalar track toggles that single track into
graph editor mode. The track expands vertically (taking more space than
a normal track) and shows:

- The track's keyframes plotted in 2D: x is scene time, y is the
  parameter value
- The y-axis auto-ranges to the keyframes' value range, with some padding
- The bezier curve connecting the keyframes is drawn, respecting each
  keyframe's easing
- Bezier handles appear on selected keyframes (only meaningful for
  keyframes whose easing is Custom Bezier — for preset easings, the
  handles are read-only previews of the preset's shape)

Only one scalar track can be in graph editor mode at a time. Toggling
another track's graph icon collapses the previous one.

### 5.2 Editing in graph editor mode

- Drag a keyframe in 2D to change both its time and its value
- Drag a bezier handle (when keyframe's easing is Custom Bezier) to
  shape the curve
- Right-click a keyframe → "Set easing → Custom Bezier" to enable handle
  editing on that keyframe
- All other interactions (multi-select, delete, value editing via
  inspector) work the same as in track view

### 5.3 Why graph editor is scalar-only

Vector components are graph-editable individually (one component is
itself scalar). Color and bool/enum are not scalar and don't have
meaningful graph representations. The graph editor restriction to scalars
keeps the editor focused and avoids weird semi-broken modes.

For vec2/3/4 parameters, the user enters graph editor mode on one
component at a time. This is fine — they're rarely needed for all
components simultaneously.

---

## 6. Data model

### 6.1 Per-parameter keyframe data

Each animated parameter on a node stores, alongside its constant value,
an animation block:

```
{
  animated: true | false,           // matches the keyframe diamond state (off vs on)
  trackVisible: true | false,       // matches the visibility eye toggle
  keyframes: [
    {
      tick: number,                  // integer subframe ticks, absolute scene time
      value: <type-dependent>,       // matches parameter type
      easingOut: "linear" | "easeIn" | "easeOut" | "easeInOut" |
                 "hold" | "customBezier",
      // only present if easingOut is "customBezier" and parameter is scalar:
      bezierHandles?: {
        rightHandle: { dx: number, dy: number },  // dx in ticks (float), dy in value units (float)
        // the next keyframe's leftHandle is the incoming tangent for this segment
        leftHandle:  { dx: number, dy: number }
      }
    }
  ],
  // for color tracks only:
  colorSpace?: "oklab" | "rgb"
}
```

Notes:

- `tick` is an **integer** — exact equality, no floating drift.
- Project metadata (separate from any single parameter) holds:
  `ticksPerFrame` (e.g., 1000), `fps`, and `sceneDurationTicks`. Frames
  and seconds are derived from ticks at display time.
- Bezier handle `dx`/`dy` are floats — they describe curve geometry, not
  keyframe positions, so they don't need to be tick-quantized.

When `animated: false`, the keyframes are preserved but unused at
evaluation. When `animated: true` but a wire is connected to the
parameter, same — keyframes preserved, unused.

Vector parameters store keyframes per-component:

```
{
  // for a vec2 parameter
  x: { animated, keyframes, ... },
  y: { animated, keyframes, ... }
}
```

Each component is independently animatable and the toggles in the param
row act on all components together (toggling animation on for a vec2
toggles all its components on; the visibility toggle similarly applies
to all).

### 6.2 Evaluation

To evaluate an animated parameter at playhead tick `t`:

1. If a wire is connected, use the wire's value. Done.
2. If `animated: false`, use the constant value. Done.
3. Otherwise, find the keyframes surrounding `t`:
   - If `t` is before the first keyframe's tick, return the first
     keyframe's value (clamp).
   - If `t` is after the last keyframe's tick, return the last
     keyframe's value (clamp).
   - If `t` exactly equals a keyframe's tick, return that keyframe's
     value.
   - Otherwise, interpolate between the two surrounding keyframes
     using the earlier keyframe's `easingOut`, the type's interpolation
     function (lerp for scalar/vec, OKLab/RGB for color, step for
     bool/enum), and the bezier handles if applicable. The interpolation
     parameter is `(t - prev.tick) / (next.tick - prev.tick)`, computed
     in tick space.

### 6.3 Serialization

The animation block is part of the node's parameter data and serializes
naturally with the rest of the graph JSON (per the main spec §9).
Version the keyframe schema in case of future changes (e.g., adding new
easing types).

---

## 7. SceneTime and Remap (unchanged)

These nodes stay in the spec exactly as previously defined. They produce
scalar values that can be wired into any parameter. When wired, they
override that parameter's keyframe data (which is preserved but unused).

This gives users two coexisting animation models:

- **Keyframe animation** (per-parameter, AE-style) — for hand-crafted
  motion design, eased transitions, sequenced animations
- **Procedural animation** (SceneTime + math + Remap) — for repeating
  patterns, audio-reactive animation, MIDI-driven animation,
  mathematically defined motion

Both are valid; users choose per parameter. This is the right scope for
v1 — neither model alone covers the full range of what creative tools
need to do.

---

## 8. Removed from earlier specs

For clarity, the following are explicitly **removed** from the prior
spec:

- **Timeline node** (with internal bezier curve, t-input, and graph
  editor)
- **Clip node** (with start/end timing and internal keyframes)
- **Clip Editor** (the proposed always-visible track view based on Clip
  nodes)
- **Back-propagation from canvas to upstream Clips** (the messy problem
  this addendum exists to avoid)

Their conceptual roles are absorbed:

- Timeline / Clip's "keyframes with easing" → per-parameter keyframes
- Clip Editor → Track Editor (now keyed off parameters, not Clip nodes)
- Clip's start/end retiming → box-select keyframes and bounding-box-
  scale them, across one or many tracks
- Back-propagation problem → eliminated structurally; manipulations
  write directly to local parameter keyframes

---

## 9. Open questions

- **Default easing preset.** Suggest "Ease In-Out" as the default for
  newly auto-inserted keyframes. Linear is too sterile, hold is too
  staccato, ease in-out reads as smooth motion. Configurable in user
  settings.

- **Keyframe interpolation across wired-then-unwired parameters.** If a
  parameter has keyframes, then a wire is connected (overriding), then
  the wire is disconnected — at the moment of disconnect, does
  evaluation jump to the nearest keyframe value, or does it smoothly
  hand off? Suggest: hard cut. The wire's last value is irrelevant once
  disconnected; keyframes resume at their stored values. Anything
  smoother is a v1.5 feature.

- **Tick resolution.** 1000 ticks per frame is the working assumption —
  divides cleanly, fits in 32-bit ints for very long timelines, and is
  finer than any user could care about. Lock in v1; revisit only if a
  workflow needs more.

- **Performance with many animated parameters.** A scene with 50+
  animated parameters means 50+ keyframe evaluations per frame. Each is
  cheap (binary search + interpolation), so total cost is negligible
  even at hundreds. No optimization needed in v1.

- **Copy/paste of keyframes across parameters.** AE supports this and
  it's useful. Defer to v1.5; not blocking.

- **Visual indicator for "auto-keyframe just happened."** When a
  parameter edit creates a new keyframe (rather than updating an
  existing one), a brief flash on the new keyframe in the track editor
  helps users notice the implicit data creation. Worth including in v1.

---

## 10. Implementation context (codebase audit)

This appendix captures what's already in the repo as of 2026-04-28 so an
implementing agent doesn't have to re-discover it. File paths and line
numbers are accurate at the time of writing — verify before relying on
them.

### 10.1 What gets deleted (and what to salvage from it)

The old Timeline node and its dedicated curve editor are being removed
per §8. They are concretely:

- [src/nodes/source/timeline.ts](src/nodes/source/timeline.ts) —
  Timeline source node. Produces a periodic scalar by evaluating an
  internal bezier curve at a wrapped `t`. Has internal/external time
  modes and stashes its evaluated `t` in `ctx.state["timeline:<id>:t"]`
  so the editor can render a playhead. **Delete the node.**
- [src/components/effects/TimelineCurveEditor.tsx](src/components/effects/TimelineCurveEditor.tsx)
  (~1430 lines) — the dedicated curve editor for the Timeline node.
  **Delete as a Timeline-bound surface**, but **salvage** for the new
  Graph Editor in §5:
  - Cubic bezier evaluation and SVG path drawing (~line 1079)
  - Drag/handle-mode logic ("aligned" / "mirrored" / "free" / "vector")
    and easing presets (~lines 106–112, 649–681)
  - Multi-select via shift-click and box-select (~lines 589–600)
  - Pan/zoom view-transform pattern (~lines 42–50, 254–325)
  - Playhead scrubbing pattern (~lines 957–990)
- The `timeline_curve` `ParamType` and `TimelineCurveValue` /
  `TimelineCurvePoint` types in
  [src/engine/types.ts](src/engine/types.ts) (~lines 368–378) — only
  used by the Timeline node; remove with it.

The old curve uses **per-point `leftHandle`/`rightHandle` tangents with
handle modes**. The new spec uses **per-keyframe named easing presets
plus an optional Custom Bezier with handles** (§3.6, §6.1). When
porting bezier code to the new Graph Editor, the on-disk shape is
different: easing is named, handles are optional and only present for
`customBezier`.

### 10.2 What stays (and how it integrates)

- **SceneTime** node: [src/nodes/source/scene-time.ts](src/nodes/source/scene-time.ts).
  Produces scalar from `ctx.time` (seconds) or `ctx.frame`. Marked
  `stable: false` so the evaluator fingerprints with `ctx.time`.
- **Remap** node: [src/nodes/effect/remap.ts](src/nodes/effect/remap.ts).
  Polymorphic scalar/image; in scalar mode does `[in_min,in_max] →
  [out_min,out_max]`.
- The **wired-overrides-keyframes** rule (§1.4) plugs into the existing
  exposed-param + edge-resolution path in the evaluator (see §10.6).

### 10.3 Time and the playhead today

- `RenderContext` ([src/engine/types.ts:557+](src/engine/types.ts#L557))
  currently exposes `time: number` (**seconds, float**) and `frame:
  number` (integer). No tick concept exists.
- Global playhead lives in React state inside
  [src/components/effects/EffectsApp.tsx](src/components/effects/EffectsApp.tsx)
  around line 543: `const [time, setTime] = useState(0)` (seconds),
  `const [fps, setFps] = useState(60)`, `const [loopFrames,
  setLoopFrames] = useState<number | null>(null)`.
- There is **no scene-duration field** today — only an optional loop in
  frames. The new spec needs `sceneDurationTicks` as project metadata.

To implement the tick model from §1.5:

1. Add project metadata `{ ticksPerFrame: 1000, fps: number,
   sceneDurationTicks: number }` somewhere durable (e.g. on the graph
   payload alongside nodes/edges, or a new `project` block).
2. Extend `RenderContext` with `tick: number` (integer, absolute) so
   nodes/evaluator have a single source of truth. Keep `time` and
   `frame` as derived fields for backwards compatibility with SceneTime
   et al. (`time = tick / (ticksPerFrame * fps)`, `frame = floor(tick /
   ticksPerFrame)`).
3. The React playhead becomes `tick: number`, scrubbed in whole-frame
   increments (Shift = subframe, per §3.4/§3.5).

### 10.4 Where animation data lives in serialization

Today, `NodeDataPayload` in [src/state/graph.ts:10-51](src/state/graph.ts#L10-L51)
stores params flat: `params: Record<string, unknown>`. There is no
animation metadata.

Two viable shapes for the per-parameter animation block (§6.1):

- **Sibling map** *(recommended for clarity)*: add `animation?:
  Record<string, KeyframeAnimationBlock>` next to `params`. Constant
  values stay in `params`; animation lives in `animation` keyed by the
  same param name. Serializes cleanly, easy to omit when not animated,
  doesn't pollute the params namespace.
- **Inline namespace prefix**: store under
  `params["_animation:translateX"]`. Less invasive to existing param
  iteration but uglier and easy to leak into UI.

Pick sibling map. Update `NodeDataPayload` and the JSON loader/saver
together.

### 10.5 Param row surgery (where the toggles attach)

The inspector row to modify is `ParamRow` in
[src/components/effects/ParamPanel.tsx:463-632](src/components/effects/ParamPanel.tsx#L463-L632).
Today it renders: label, "exposed/control" buttons, a "driven" badge
when wired, and a `ParamControl` widget (slider/checkbox/etc.).

Per §1.1 the new layout is:

```
[ 👁 visibility ] [ name ] [ slider ] [ numeric value ] [ ◆ keyframe ]
```

- Add the eye **left of the slider area** (so it sits before the
  control, not before the label — re-read §1.1).
- Add the diamond **right of the numeric value**.
- Reuse the existing "driven" badge logic for the wired-state visual
  muting from §1.4: the diamond is shown but greyed out when
  `isParamDriven(nodeId, paramName)` is true.

### 10.6 Evaluation hook point

The evaluator resolves wired param overrides in
[src/engine/evaluator.ts:359-407](src/engine/evaluator.ts#L359-L407).
For each `exposedParams` entry, it looks up incoming edges to
`in:param:<paramName>`, coerces the source output to the param's socket
type, and merges the result into an effective param map before calling
the node's compute.

The keyframe evaluation (§6.2) plugs in **at the same point** with this
precedence:

1. Wire override (existing logic) — wins.
2. Else, if `animation[paramName]?.animated === true`, evaluate
   keyframes at `ctx.tick`.
3. Else, use the constant from `params[paramName]`.

Coerce the keyframe-evaluated value through the same socket-type
coercion used today so vec/color/scalar handling stays uniform.

### 10.7 Which param types can actually be keyframed

`paramSocketType` in
[src/engine/graph-helpers.ts:26-41](src/engine/graph-helpers.ts#L26-L41)
restricts **wirable** types to scalar, boolean, vec2, vec3, vec4, color.
Other types (enum, file, paint, curves, spline_anchors, etc.) cannot be
wired today.

Per the spec, **keyframes are broader than wires**: §1.3 explicitly
allows keyframing booleans and enums (with step interpolation).
Implementing agents should not gate keyframe support on
`paramSocketType` — gate on a separate check that includes scalar, vec,
color, boolean, enum. File / paint / curves / spline_anchors stay
non-keyframable in v1.

### 10.8 Canvas manipulator drag flow (§2.4)

Transform-style on-canvas handles are in
[src/components/effects/TransformGizmo.tsx](src/components/effects/TransformGizmo.tsx),
shown when a node sets `supportsTransformGizmo: true`. The gizmo
updates params (`translateX`, `translateY`, `scaleX`, `scaleY`,
`rotate`, `pivotX`, `pivotY`) via a parent callback that writes back to
the node's params record.

To implement §2.4 / §2.3:

- Route gizmo writes through the same code path as numeric/slider
  edits, so the auto-keyframe rules apply uniformly.
- That code path needs to know: is animation on for this param, and is
  the playhead exactly on a keyframe tick? The path then decides
  insert / update / no-op.
- If the param is wired, the gizmo should be visually disabled (already
  the convention for wired params in the inspector — extend to canvas).

### 10.9 Polymorphic node sockets

Several nodes change their input sockets dynamically based on params,
via a `resolveInputs(params)` function on the node def — Timeline does
this for internal/external mode, Transform does it for image/uv mode,
Math does it for scalar/uv mode. The Track Editor and inspector should
read the *current* effective sockets rather than caching a static list,
so wired-vs-keyframe visual state stays correct after a mode flip.

### 10.10 Linked params

Transform nodes support `linkedParams` (e.g. `scaleX:scaleY` with a
ratio); editing one updates the other proportionally. **v1: do not
auto-keyframe the linked partner.** If a user edits `scaleX` while
linked and animation is on, only `scaleX` gets a keyframe; `scaleY`'s
new value is written as a constant unless its own animation is also on.
This avoids surprising cross-param keyframe creation. Revisit in v1.5
once people have used it.

### 10.11 Files likely to change

- New: `src/components/effects/TrackEditor.tsx` (multi-track editor,
  ruler, selection, bounding-box transform)
- New: `src/components/effects/GraphEditor.tsx` (scalar-only graph view
  per §5, salvaged from `TimelineCurveEditor.tsx`)
- New: `src/components/effects/KeyframeDiamond.tsx` (the toggle,
  three-color states, right-click menu)
- New: `src/components/effects/TrackVisibilityEye.tsx`
- Modify: `src/components/effects/ParamPanel.tsx` — row layout
- Modify: `src/components/effects/EffectsApp.tsx` — tick playhead, FPS,
  scene duration; mount Track Editor where graph editor lived
- Modify: `src/engine/types.ts` — `Keyframe`, `KeyframeAnimationBlock`
  types; extend `RenderContext` with `tick`
- Modify: `src/engine/evaluator.ts` — keyframe evaluation between wire
  override and constant fallback
- Modify: `src/state/graph.ts` — `NodeDataPayload.animation` sibling
  map
- Delete: `src/nodes/source/timeline.ts`,
  `src/components/effects/TimelineCurveEditor.tsx`, the
  `timeline_curve` ParamType branch and its types
- Modify: `src/nodes/index.ts` — drop the Timeline registration

### 10.12 Coordinate conventions (don't mix these up)

- **Canvas / gizmo space**: normalized [0,1]² with **Y-down** (0 = top).
- **Spline space**: normalized [0,1]² Y-down.
- **Track Editor x-axis**: ticks (display: frames). Y-axis in the Graph
  Editor is parameter value, auto-ranged.
- **Bezier handles in §6.1**: `dx` is in **ticks** (float), `dy` is in
  **value units** of the parameter (float). Not pixels, not
  normalized — store in semantic units so zoom changes don't rewrite
  data.