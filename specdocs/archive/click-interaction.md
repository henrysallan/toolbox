# Click / Interaction System

Brainstorm doc — surveys ways to expose mouse-click (and broader pointer)
events into the node graph. The graph is currently pull-based and per-frame:
every node always emits a value. Events don't fit cleanly into that model,
so this doc is really about *how to encode an event as a continuous signal
that downstream nodes can consume*.

What we have today:

- `Cursor` node — outputs cursor position and a B/W mask. `ctx.cursor` is
  `{ x, y, active }`. No notion of buttons.
- Per-frame evaluation. Nodes that read `ctx.time` / `ctx.cursor` mark
  themselves `stable: false` so the evaluator re-runs them.

What's missing: any way for a click to *do* something in the graph.

---

## Routes

### 1. Pulse scalar — "click happened this frame"

Output is `1.0` on the frame of mousedown, `0.0` otherwise. Downstream
multiplies things by it.

- **Pros:** trivial to add. Composes with existing scalar math.
- **Cons:** one-frame spike is hard to use raw — usually wants a holdoff
  or decay envelope to be visible.
- **Pairs with:** a new **Trigger Envelope** utility node (attack / hold /
  release / curve) so users can stretch a 1-frame spike into any shape.

### 2. Held-state scalar — "is the mouse currently down"

Output is `1.0` while button is held, `0.0` otherwise. Different mode
than #1.

- **Use cases:** apply force while dragging, gate a particle emitter,
  paint into a Trails node only while held, freeze playback while held.
- Cheap to ship alongside #1 — same plumbing.

### 3. Click count — monotonic integer

Increments by one per click. Downstream detects "new click" by diffing
against the previous value (Smooth/Lerp gives you `prev`, or add a small
**Edge Detect** utility node).

- **Pros:** survives paused playback better than #1 — the count persists.
- **Cons:** awkward shape (int that grows unboundedly). Only really
  useful with a diff-helper.

### 4. Sticky click position — `vec2`

Latches to the last click's coordinates and stays there. Built on the
cursor's position output but frozen on click.

- **Use cases:** "click to place this thing here" — drop a node onto an
  obstacle position, particle attractor center, spawn point.
- Turns the cursor from a hover-tool into a placement-tool.
- Nearly free once mousedown plumbing exists.

### 5. Click-aware modes on specific nodes

Instead of a general click signal, give specific producer nodes a
"trigger on click" mode: Particle Emitter that bursts on click,
Reaction-Diffusion that seeds at click positions, Spline Draw with
click-to-add-anchor.

- **Pros:** discoverable — feature shows up where it's needed.
- **Cons:** every node re-invents input plumbing. Better as a follow-up
  *after* a generic click signal exists, layered on top.

### 6. Click history buffer — `points`

A small ring of recent click events (position, maybe timestamp). Emits
as a `points` socket so downstream Copy-to-Points etc. just works.

- **Use cases:** "ripples emanate from every recent tap", "draw a
  polyline through my last 8 clicks".
- Reuses existing socket type — no schema change.
- Buffer size + decay rules become params.

### 7. Record / replay onto the timeline

Click events recorded during playback get baked as keyframes on a track.
Replay re-fires them deterministically.

- **Pros:** big — turns interactions into reproducible animation.
- **Cons:** large scope, ties into the existing track editor and
  keyframe evaluator. Own project.

---

## Recommended starting point

**#1 + #2 + a Trigger Envelope utility node.** Smallest change that
covers most click patterns:

- Cursor node (or new dedicated **Mouse** node) gains two outputs:
  - `pressed` — pulse scalar (1.0 on click frame)
  - `held` — sticky scalar (1.0 while down)
- New **Trigger Envelope** node: pulse in → decaying envelope out, with
  attack / hold / release / curve params.
- Optionally fold in #4 (sticky click position vec2) — nearly free once
  mousedown is already in the context.

Everything else (count, history, click-aware modes, replay) is reachable
later by users composing #1/#2 with future utility nodes.

---

## Engine-level work required

- `ctx.cursor` grows: `pressed: boolean`, `held: boolean`. Optional:
  `lastClickX`, `lastClickY` for the sticky position.
- `EffectsApp` canvas captures `mousedown` / `mouseup` and pushes them
  into the cursor state on RenderContext.
- Subtle bit: how the context resets between frames. `held` persists
  across frames. `pressed` is set on the frame of the mousedown event
  and cleared the next frame — so the click pulse only fires once,
  regardless of how many evaluations run.
- Touch parity: same plumbing should fire on `touchstart` / `touchend`
  on iPad — pulse on touch-begin, held while finger is down.
- Nodes that consume click state set `stable: false` so the evaluator
  re-runs them. Already the convention for cursor-aware nodes.

---

## Out of scope (for v1)

- Multiple buttons (right / middle click). Single primary button only.
- Double-click detection. Compose from #3 (count) + a time-since helper
  if needed.
- Drag start / end events. The combination of #1 (pressed pulse) and #2
  (held state) is enough — a "drag start" is `pressed`, "drag end" is
  the falling edge of `held`. Edge Detect node would expose both
  generically.
- Keyboard. Same architecture would extend to it later but stays out
  of this pass.
