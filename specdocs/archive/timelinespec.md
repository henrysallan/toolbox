# Spec Addendum: Timeline, Remap, and Graph Editor

This addendum extends the v1 spec to cover the animation primitives and the
graph editor UI that sits inside the Timeline node.

Scope reminder: all data between nodes is GPU-native image or numeric data.
Timeline and Remap nodes are pure scalar operations — they do not touch
textures and are cheap to evaluate every frame.

---

## 0. Current state of the codebase (as of 2026-04-22)

Before reading the rest of this doc, understand what's already in place —
several assumptions in earlier drafts no longer hold.

**SceneTime node (`src/nodes/source/scene-time.ts`) is built and shipping
with richer behavior than "outputs time."** Its params are:

- `unit`: `seconds` or `frames` (reads `ctx.time` or `ctx.frame`).
- `mode`: `linear`, `pingpong`, or `stepped`.
- `period` (pingpong): triangle-wave period; value ramps `0→P→0`.
- `step_size` + `easing` (stepped): discrete steps with an eased fractional
  alpha. Easings include `step`, `linear`, `ease-in`, `ease-out`,
  `ease-in-out`, `ease-in-cubic`, `ease-out-cubic`, `smoothstep`,
  `smootherstep`.
- `scale`, `offset`: applied last.

It is marked `stable: false`, so the evaluator injects `ctx.time` into the
node's fingerprint each frame; only subgraphs that actually consume
SceneTime recompute — independent subgraphs stay cached. Downstream nodes
inherit the time-varying fingerprint automatically via `srcFp`
propagation. A Timeline node built on top of SceneTime does **not** need
`stable: false` itself.

Because SceneTime can already emit non-monotonic shapes (pingpong, step
with easing), the statement "Timelines are the primary animation
primitive" needs qualifying: SceneTime is a legitimate animation source
too. Timelines remain the primary primitive for *authored* curves —
SceneTime is the primary primitive for *parametric* time shapes.

**Exposed params + socket convention is built**
(`src/state/graph.ts`). Any scalar/vec2/vec3/vec4/color/boolean param can
be "exposed" on a node, producing a typed input socket handle named
`in:param:<name>`. When an edge connects, the incoming value overrides
the stored param at evaluation time. This means `outputMin` and
`outputMax` — and all four Remap range params — are drivable from other
scalar sources out of the box, with zero Timeline/Remap-specific work.
This resolves the "animated outputMin/outputMax" open question in §6.

**Custom parameter UIs are already a shipped pattern**
(`src/components/effects/ParamPanel.tsx`). `CurvesControl` renders an
SVG-based monotone-cubic tone-curve editor with selectable RGB channels;
`ColorRampControl` renders a gradient-stops editor; paint and
merge-layers also have bespoke controls. Any earlier claim that Timeline
would be "the first custom parameter UI" is wrong — it's following a
well-established pattern, not establishing one.

**ParamType `"curves"` is already taken** (`src/engine/types.ts`) — it's
the RGB tone-curve type used by color-correction. The Timeline's bezier
keyframe curve needs a distinct ParamType; this doc proposes
`"timeline_curve"` wherever it says "curves."

**Naming collision: "Timeline" is ambiguous.**
`src/components/effects/Timeline.tsx` already exists as the full-width
**playback scrubber bar** at the bottom of the app — play/pause, reset,
loop-frames input, FPS input, scrubbable track. It has nothing to do
with this spec's Timeline *node*. To avoid churn in file paths, this
doc refers to the UI component as the **playback bar** and reserves
"Timeline" (unqualified) for the node. If both survive, consider
renaming the UI component to `PlaybackBar.tsx` before the Timeline node
lands.

**React Flow (`@xyflow/react` v12) is the graph framework.** Nodes render
via a custom `EffectNode` and parameters via `ParamPanel`. The Timeline
node's graph editor lives inside ParamPanel (a right-side dock for the
selected node), not inside the React Flow canvas.

---

## 1. Timeline node

### 1.1 Role in the system

The Timeline node turns a normalized progress value into an animated scalar
by evaluating a user-authored bezier curve. It is the primary animation
primitive in the system.

Timelines do not know about time. They know only about a `t` input in the
0–1 range and a curve that maps `t` to an output value. Time enters the
system via the `SceneTime` source node, which feeds `t` (directly or
through a Remap) into the Timeline.

### 1.2 Inputs, outputs, parameters

- **Input**: `t` (scalar). Expected in 0–1 but any value is accepted; see
  wrap behavior below.
- **Primary output**: scalar. The curve evaluated at `t`.
- **Parameters**:
  - `outputMin` (scalar, default 0): the value returned when the curve's
    lowest point is evaluated. Exposable as a socket (see §0).
  - `outputMax` (scalar, default 1): the value returned when the curve's
    highest point is evaluated. Exposable as a socket (see §0).
  - `curve` (ParamType `timeline_curve`): the authored curve. Stored as
    control-point data (§4) and edited via the graph editor (§3), which
    renders when ParamPanel sees this param type. Not driveable as a
    socket — curve shape is design-time, not signal-time.

Because SceneTime can emit values well outside 0–1 (it emits seconds or
frames by default), the typical hookup is
`SceneTime → Remap (→ 0..1) → Timeline`. Timeline's internal `fract(t)`
wrap (§1.3) makes a direct `SceneTime → Timeline` connection work too
— it just loops once per second when SceneTime emits seconds.

The curve is authored in a normalized 0–1 × 0–1 space. The `outputMin` and
`outputMax` parameters scale the output at evaluation time. This keeps the
curve reusable at any value range without re-authoring.

### 1.3 Wrap behavior

`t` values outside 0–1 wrap via `fract(t)`. A `t` of 1.2 evaluates as 0.2.
A `t` of -0.1 evaluates as 0.9.

This is the only wrap mode in v1 and is not user-configurable.

The rationale: the Timeline is a *shape*, not a clip. If a user wants
clamp-at-end behavior, they either (a) feed a clamped `t` (via a Remap
node with clamping, or via `min(sceneTime, 1.0)` at the source), or (b)
place keyframes so the curve holds the start and end values flat past the
active region.

This decision is load-bearing for the mental model: Timelines always loop,
so sequential animation is always done by *placement of keyframes within
the 0–1 track* combined with *timing control upstream via Remaps*. It is
never done by "this timeline runs from second 3 to second 6."

### 1.4 Unified keyframe-and-bezier model

A Timeline's curve is a sequence of **control points**. Each control point
has:

- A **position** in the normalized 0–1 track (x-axis).
- A **value** in the normalized 0–1 output (y-axis). The `outputMin` and
  `outputMax` parameters scale this at evaluation time.
- A **left handle** (bezier tangent on the incoming side): relative offset
  `{ dx, dy }` from the point.
- A **right handle** (bezier tangent on the outgoing side): relative
  offset `{ dx, dy }` from the point.
- A **handle mode**: one of `aligned` (left and right handles are
  collinear, mirrored in direction — default), `mirrored` (collinear and
  equal length — the smoothest option), `free` (left and right move
  independently, allowing sharp corners), or `vector` (handles collapse
  to zero length, producing a straight line into/out of the point).

There is no separate concept of a "keyframe with easing." A control point
**is** a keyframe, and the bezier handles on either side **are** the
easing. This unification is deliberate — it's one model, one UI, one
serialization shape.

Presets like "ease-in," "ease-out," "linear" are offered in the control
point's right-click menu (§3.6) as shortcuts that set the handle offsets
to standard values. Users can still drag handles freely afterward.

### 1.5 Evaluation

To evaluate the curve at `t`:

1. Wrap `t` via `fract(t)`.
2. Find the two control points surrounding the wrapped `t` (the curve is
   stored sorted by x-position; use binary search).
3. Solve the cubic bezier segment between those two points for the
   y-value at the wrapped `t`. This is a standard 1D bezier evaluation
   given the two endpoints and their adjacent handles.
4. Scale the result from 0–1 into `[outputMin, outputMax]`:
   `output = outputMin + y * (outputMax - outputMin)`.
5. Return the scaled value.

Edge cases:

- If the curve has zero control points, output equals `outputMin`.
- If the curve has one control point, output equals that point's value
  (scaled).
- The first control point must be at x=0 and the last at x=1. The graph
  editor enforces this — users cannot delete the endpoints, and cannot
  drag them off the left or right edges. Their y-values are freely
  editable.

### 1.6 Default curve on node creation

A new Timeline node starts with two control points:
- `{ x: 0, y: 0, handleMode: aligned, handles: defaults }`
- `{ x: 1, y: 1, handleMode: aligned, handles: defaults }`

This gives a default linear ramp from 0 to 1. Users immediately see a
working curve they can modify.

---

## 2. Remap node

### 2.1 Role

Remap takes a scalar in and outputs a scalar, rescaled from an arbitrary
input range to an arbitrary output range. It's the glue that lets users
do timing manipulation (when an animation plays, how fast, offset from
scene time) and value manipulation (converting between scales, e.g.
mapping a 0–1 timeline output into a -10 to 10 rotation range).

### 2.2 Inputs, outputs, parameters

- **Input**: `value` (scalar).
- **Primary output**: scalar.
- **Parameters**:
  - `inputMin` (scalar, default 0)
  - `inputMax` (scalar, default 1)
  - `outputMin` (scalar, default 0)
  - `outputMax` (scalar, default 1)
  - `clamp` (boolean, default false) — when true, input is clamped to
    `[inputMin, inputMax]` before remapping.

### 2.3 Evaluation

```
if clamp:
  value = clamp(value, inputMin, inputMax)
normalized = (value - inputMin) / (inputMax - inputMin)
output = outputMin + normalized * (outputMax - outputMin)
```

Negative input ranges, inverted output ranges (outputMin > outputMax),
and crossing-zero ranges are all valid. They produce reflections and
inversions as expected from the math.

Divide-by-zero case (`inputMin == inputMax`): return `outputMin`. Don't
crash.

### 2.4 Why arbitrary ranges

- Users need to work in scene seconds, not always 0–1 normalized.
  SceneTime might output seconds directly (e.g. 0–10); a Remap with
  `inputMin=3, inputMax=6, outputMin=0, outputMax=1` converts "seconds
  3–6 of the scene" into "a fresh 0–1 window for a Timeline to consume."
- Users need output ranges that match what they're driving. A rotation
  might want -180 to 180. An opacity wants 0 to 1. A displacement scale
  might want 0 to 50 pixels. Remap is the adapter.
- Full remap makes Remap itself a useful creative node, not just a
  timing utility. It's the primary way scalars get into the ranges other
  nodes expect.

---

## 3. Graph editor UI

### 3.1 Placement and layout

The graph editor is a full-width panel that lives inside the Timeline
node's entry in the parameter panel. Default state is **collapsed** — a
compact row showing the curve as a small thumbnail preview alongside the
node's other parameters (`outputMin`, `outputMax`).

Clicking an expand affordance (caret or expand icon on the thumbnail)
opens the editor to its full size, occupying the full width of the
parameter panel and a substantial vertical region (suggested default:
300px tall, user-resizable via a drag handle on the bottom edge).
Collapse returns it to the thumbnail row.

Only one Timeline node's graph editor is expanded at a time. Selecting a
different Timeline node collapses the previous one and expands the new
one if its editor was previously expanded (state is per-node).

### 3.2 Coordinate system

The editor shows a 0–1 × 0–1 grid:

- X axis is the normalized track, left to right, 0 at the left edge, 1
  at the right.
- Y axis is the normalized value, 0 at the bottom, 1 at the top.
- Gridlines at 0.25, 0.5, 0.75 on both axes, lightly rendered.
- The curve is rendered as a smooth bezier path using the stored control
  points and their handles.

The editor does **not** show `outputMin`/`outputMax`-scaled values on
the axes. The curve is always authored in normalized space. The scaling
parameters remain visible in the parameter row alongside the editor so
users can see them but they don't change the editor's axes.

### 3.3 Interactions

**Shift + Left click on empty canvas**: adds a new control point at the
clicked position. The new point is created with `aligned` handle mode and
default handle offsets (tangent length ~0.1 in x, slope interpolated from
neighboring points to produce a smooth default). The new point is
immediately selected.

**Left click on a control point**: selects it. Previous selection is
deselected (single-selection only in v1; multi-select deferred). When
selected:
- The point is rendered filled/highlighted.
- Both bezier handles appear as small squares connected to the point by
  thin lines.
- The point becomes draggable.

**Left click on empty canvas (without shift)**: deselects the current
point.

**Drag a control point**: moves it in both x and y. Constraints:
- Cannot be dragged past its left or right neighbor on the x-axis (no
  reordering via drag; see right-click menu for reorder via delete+add).
- First and last points are locked to x=0 and x=1 respectively; only
  their y-values are draggable.
- Y can go outside 0–1 visually (the curve is authored in normalized
  space but the editor doesn't hard-clamp — users may want overshoot
  curves). The editor's viewport expands vertically as needed, or shows
  an out-of-bounds indicator. Pick one; suggest the latter for simplicity.

**Drag a bezier handle**: moves that handle. Constraint depends on the
point's handle mode:
- `aligned`: the opposite handle rotates to match (direction mirrored,
  length preserved).
- `mirrored`: the opposite handle mirrors exactly (direction and
  length).
- `free`: only the dragged handle moves.
- `vector`: handles are locked at zero length; dragging has no effect
  (or switches the mode to `free` — suggest switching, with a subtle
  cursor hint).

**Right click a control point**: opens a custom context menu. See §3.6.

**Right click empty canvas**: no action in v1. (Could later offer
"paste point" etc.)

**Delete / Backspace with a point selected**: deletes the point, unless
it's the first or last (those cannot be deleted).

**Escape**: deselects the current point.

### 3.4 Hover states

- Hovering over a control point: cursor becomes a move cursor; the point
  subtly highlights.
- Hovering over a bezier handle (when visible): cursor becomes a move
  cursor; the handle subtly highlights.
- Hovering over empty canvas while Shift is held: cursor becomes a
  crosshair or plus cursor to signal "click to add."
- Hovering over empty canvas otherwise: default cursor. A faint preview
  of the curve's y-value at the hover x may be shown as a vertical
  guide — optional, nice-to-have.

### 3.5 Playhead indicator

When the graph editor is expanded and the graph is currently evaluating
(e.g. scene time is playing), a vertical line is drawn at the current
wrapped `t` value of this Timeline node. This lets users see where on
the curve their animation currently is.

The playhead is read-only in v1 (not scrubbable by clicking in the
editor). Scrubbing comes from the **playback bar** at the bottom of the
app (the file `Timeline.tsx`, which despite its name is the scrubber,
not this node — see §0).

Implementation note: the evaluator currently exposes per-node
*fingerprints* back to the UI but not per-node *resolved input values*.
To render the playhead, extend `EvalResult` to also expose each node's
primary input values (or at minimum, the resolved `t` for Timeline
nodes). Alternatively, Timeline's `compute` can stash its own last `t`
in `ctx.state` keyed by `nodeId`, and the editor reads that. Latter is
cheaper and keeps the evaluator contract unchanged.

### 3.6 Right-click context menu on a control point

The menu contains:

- **Handle mode** (submenu): Aligned / Mirrored / Free / Vector — check
  mark next to the current mode.
- **Easing presets** (submenu): Linear / Ease In / Ease Out / Ease In-Out
  / Hold (step). Selecting a preset sets the handles on both sides of the
  selected point to standard values matching that easing. "Hold" sets
  handle mode to `vector` and positions the next point's left handle so
  the value snaps flat until the next control point.
- **Reset handles**: restores default handle offsets for the current mode.
- **Set value…**: opens a small numeric input to type an exact y-value.
- **Set position…**: opens a small numeric input to type an exact x-value
  (clamped to stay between neighbors).
- **Delete point**: removes the point. Disabled for first/last points.

---

## 4. Serialization

Timeline node state is stored as part of the graph JSON (from the main
spec, §9). The Timeline node's `params` map contains three entries:

- `outputMin: number`
- `outputMax: number`
- `curve: TimelineCurveValue` — a new ParamType `"timeline_curve"`,
  added to `ParamType` in `src/engine/types.ts`. (Do **not** reuse
  `"curves"`; that's already in use for RGB tone curves in
  color-correction.)

The value shape of `TimelineCurveValue` is:

```ts
type TimelineCurveValue = {
  controlPoints: Array<{
    x: number;      // 0..1, enforced
    y: number;      // typically 0..1, not hard-clamped
    handleMode: "aligned" | "mirrored" | "free" | "vector";
    leftHandle:  { dx: number; dy: number };
    rightHandle: { dx: number; dy: number };
  }>;
};
```

Wrapping the control-point array inside an object (rather than using a
bare array as the param value) leaves room for per-curve metadata later
(labels, color-coded channels, etc.) without a breaking format change.

Control points are stored sorted by x. The default value for the param
is a two-point linear ramp (see §1.6).

Remap node state is just its four scalar parameters plus the `clamp`
boolean — no special serialization needed. All four range params are
exposable as sockets (see §0), which is the primary way users will
animate them.

---

## 5. Implementation notes

- **Custom parameter UI is not new.** ParamPanel already renders bespoke
  editors for `curves` (monotone-cubic tone curves, used by
  color-correction), `color_ramp`, `paint`, and `merge_layers`. The
  Timeline graph editor follows the same pattern: add a
  `param.type === "timeline_curve"` branch in
  `src/components/effects/ParamPanel.tsx` that renders a
  `TimelineCurveEditor` React component, identical in shape to how
  `CurvesControl` is wired. Expanded/collapsed layout and the
  full-width-inside-ParamPanel docking are the new pieces; the
  integration seam is well-trodden.

- The Timeline evaluation code (§1.5) is shared between the engine (for
  per-frame evaluation inside the node's `compute`) and the graph editor
  (for rendering the curve path). Factor it into a pure function — e.g.
  `src/nodes/source/timeline/eval.ts` — that both can import. Keep it
  free of React and WebGL deps.

- **`stable` flag on the node.** Do *not* mark the Timeline node
  `stable: false`. It is a pure function of its input `t` and its
  `curve` param. Time-varying behavior propagates automatically because
  the upstream SceneTime node is `stable: false` and its fingerprint
  (which includes `ctx.time`) carries through to Timeline's input
  fingerprint (`srcFp`). Same for Remap. Marking either as unstable
  would defeat caching when `t` happens not to change frame-to-frame
  (e.g. paused playback, or a held `stepped`-mode SceneTime value).

- Rendering the bezier curve in the editor: use SVG's native cubic
  bezier path commands (`M x0 y0 C c1x c1y c2x c2y x1 y1 …`) segment-by-
  segment between control points. This is exact and cheaper than
  sampling.

- Hit-testing for control points and handles: use simple radius checks
  in screen space (e.g. 8px radius for points, 6px for handles). No
  need for anything fancy. `CurvesControl` in ParamPanel is a working
  reference for this pattern.

- **Playhead data path.** See §3.5 implementation note. Preferred approach
  is stashing the last-evaluated `t` on `ctx.state[\`timeline:${nodeId}:t\`]`
  from within `compute`, and having the editor read it via a tick
  driven off `time` in EffectsApp. This keeps the evaluator's contract
  unchanged.

- **Right-click menu.** React Flow ships context-menu primitives for the
  canvas, but the graph editor is rendered inside ParamPanel, not inside
  the canvas, so those primitives don't apply. Build the menu as a
  standard React portal/absolute-positioned element attached to the
  editor's container; hide on outside click and on `Escape`.

---

## 6. Unresolved questions

These are worth thinking about before implementation starts, but they're
not blockers — reasonable defaults exist for all of them.

- **Undo/redo inside the graph editor.** The main spec defers undo to
  v1.1. Does that include curve edits, or should the graph editor ship
  with local undo from day one? Curve editing without undo is frustrating
  in a way general parameter editing isn't.

- **Multi-select of control points.** Useful for "shift these three
  points to the right together." Deferred to v1.1 unless it feels
  essential in early use.

- **Copying curves between Timeline nodes.** No mechanism in v1. Users
  re-author. If this becomes painful, add a "copy curve / paste curve"
  option on the node's right-click menu in the node graph.

- **Per-segment easing presets vs per-point.** The current model attaches
  handles to points, so an "ease out" preset on point N affects the
  segment leaving point N and (if aligned) the segment entering point
  N+1. This can be confusing — "I set ease-out on point 2 but it also
  changed how point 1 looks." Alternative is to treat the segment
  between points as the unit of easing. Sticking with the point-based
  model for v1 because it matches the unified data structure; flag for
  reconsideration if it confuses users.

- **Curve out-of-bounds visuals.** When a point's y is dragged above 1 or
  below 0, does the editor's vertical range expand, or do we show an
  indicator and leave the point visually at the edge? Recommend: show
  indicator, don't expand, keep the editor's visible range stable at
  0–1.

- ~~**Evaluation of `outputMin`/`outputMax` when animated.**~~ Resolved
  by the existing `exposedParams` mechanism (see §0). Any scalar param
  on any node can already be exposed as an input socket and driven by
  another scalar source; no Timeline-specific design is needed. The
  scaling step in §1.5 runs per-frame against whatever values the
  evaluator resolves for `outputMin`/`outputMax` on that frame — which
  may come from the stored param value or, when exposed, from an
  incoming edge. Worth a once-over in QA but not an open design
  question.

- **Naming.** See §0. `src/components/effects/Timeline.tsx` is already
  the playback-bar component. Before the Timeline *node* lands, decide
  whether to rename the UI component (recommended: `PlaybackBar.tsx`)
  or pick a different name for the node (e.g. `Curve`, `Keyframe`).
  Shipping both under "Timeline" will create onboarding confusion and
  search noise in the codebase.