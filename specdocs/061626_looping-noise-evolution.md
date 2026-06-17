# Looping noise evolution — spec (2026-06-16)

## Problem

Noise drives a lot of our animation — patterns, randomization, organic
motion. The current way to animate it is to wire **Scene Time** into the
Noise node's `w` (W / Evolution) or `flow_time` param, or into Voronoi's
`w`. That works for open-ended motion but **does not loop**, which is what
we actually want most of the time (looping backgrounds, seamless textures,
exported loops).

Why it can't loop today:

- **W (Evolution)** is not real 4D noise. Each integer W hashes to a random
  faraway XY offset, and the field smoothstep-blends between consecutive
  slices ([perlin-noise.ts:362-406](../src/nodes/source/perlin-noise.ts#L362-L406),
  same code in [voronoi.ts:147](../src/nodes/source/voronoi.ts#L147)). The
  whole field is translated by that offset; "evolution" = the sample point
  walking to decorrelated regions. Ramp W linearly and let the master clock
  wrap 0→loop→0 and the field **pops** at the seam (snaps from a faraway
  slice back to the W=0 slice).
- The only seam-free option today is Scene Time's **ping-pong** mode, but
  that visibly *reverses* the evolution at the turn. There is no clean,
  always-forward loop.
- **Flow** (`type: flow`) is the exception — it rotates each cell's gradient
  by `cos(angle + t)` ([perlin-noise.ts:323](../src/nodes/source/perlin-noise.ts#L323)),
  so it is *already periodic* with period 2π. It just isn't exposed as
  "loop over N frames."

## Core idea: walk the evolution around a closed loop

Instead of moving the evolution in a straight line, move it around a
**circle**, so the end frame lands exactly back on the start frame. Because
the existing W mechanism is literally "translate the sample point by an
offset," walking that offset around a circle returns *exactly* to the start
— seamless, and always forward (no ping-pong):

```
period = End − Start                       (frames)
phase  = wrap01((frameNow − Start) / period)   // 0→1 over the window, repeats
θ      = 2π · phase
animOffset = Rate · (cos θ, sin θ)         // closed loop in offset space
```

- **Start / End (frames)** → the loop window = the period.
- **Rate** → the circle's radius = how much the field travels / changes
  across one loop. Small (≈0.2) = gentle drift; large (≈3+) = the field
  decorrelates over the loop and reads as a full morph (same character as
  dragging W today). Single seamless loop per window (no winding/loop-count
  param — decided 2026-06-16).
- **Animated** (boolean) → master toggle. Off = today's behavior, fully
  cached. On = drive the evolution internally from scene time and reveal
  Start / End / Rate.

`frameNow` is the *continuous* frame = `ctx.tick / ctx.ticksPerFrame` (not
`ctx.frame`) so motion stays smooth during slow/scrubbed playback; exports
land on integer frames anyway.

### Per-axis behavior

- **W slice-blend** (all Noise types except flow; all Voronoi): when
  Animated, bypass `hashOffset(W)` and add `animOffset` to the sample point
  instead. The static `w` slider is hidden while Animated is on.
- **Flow** (`type: flow`): even simpler — drive the rotation angle as
  `θ = 2π · phase` directly (it's already 2π-periodic), so it loops with no
  circle needed. `flow_time` is hidden while Animated is on.
- **Curl** (`type: curl`): same offset-translation path as W → use
  `animOffset`.

### Seam caveat to document in-UI

For the *project* to loop seamlessly, the noise must be at the same phase at
frame 0 and at `loopFrames`. That holds iff `loopFrames` is an integer
multiple of `period = End − Start`. Simplest correct default: set the window
to the full project loop. (Defaults are static so we can't read `loopFrames`
at param-default time — see Open questions for a "Match project loop"
convenience.)

## Implementation

### Shared helper (engine)

Add to [noise.ts](../src/engine/noise.ts) (engine is self-contained; nodes
may import from it — invariant #1):

```ts
// Continuous, seamless loop offset for animated noise evolution.
// Returns the vec2 to add to the noise sample point. period<=0 → [0,0].
export function loopEvolutionOffset(
  frameNow: number, start: number, end: number, rate: number
): [number, number] {
  const period = end - start;
  if (period <= 0 || rate === 0) return [0, 0];
  let phase = ((frameNow - start) / period) % 1;
  if (phase < 0) phase += 1;
  const theta = phase * Math.PI * 2;
  return [rate * Math.cos(theta), rate * Math.sin(theta)];
}
// And a flow variant returning just the angle 2π·phase for type=flow.
export function loopEvolutionPhase(
  frameNow: number, start: number, end: number
): number { /* wrap01 */ }
```

Both Noise and Voronoi import these. The offset is a single vec2 constant
across all pixels, so the shader needs **no new branch** — we add it to the
existing offset uniform (keep a separate `u_animOffset` so the user's
manual Offset X/Y still composes independently), and force `u_w = 0` when
Animated. The CPU `value` path ([perlin-noise.ts:763](../src/nodes/source/perlin-noise.ts#L763))
adds the same offset to `sx/sy` and skips the W-slice blend. Flow uses the
phase angle in place of `u_flowTime`.

### Params (Noise and Voronoi)

```
{ name: "animated", label: "Animated", type: "boolean", default: false }
{ name: "anim_start", label: "Start (frame)", type: "scalar", default: 0,   visibleIf: animated }
{ name: "anim_end",   label: "End (frame)",   type: "scalar", default: 120, visibleIf: animated }
{ name: "anim_rate",  label: "Rate",          type: "scalar", min: 0, max: 10, softMax: 4, default: 1, visibleIf: animated }
```

Plus `visibleIf: (p) => !p.animated` on the existing `w` row (and
`flow_time` row gets `type === "flow" && !animated`).

### Re-render each frame only when Animated

The node must recompute per frame while Animated, but stay cached otherwise
(today it has no `stable` flag, so it caches and only busts on param/input
change). Use `fingerprintExtras` rather than `stable: false`:

```ts
fingerprintExtras: (params, ctx) =>
  params.animated ? `f:${ctx.tick}` : "",
```

That keeps the static path's caching intact and only forces per-frame
recompute when looping is on. W=0 back-compat and existing saved projects
are untouched (new params default to off / today's values).

### Outputs

- **image** + **value** (CPU): covered by the offset/phase above.
- **field** (`scalar_field` AST → SDF graphs): the AST already carries
  `offsetX/offsetY` and `w` ([perlin-noise.ts:813](../src/nodes/source/perlin-noise.ts#L813)).
  When Animated, bake `animOffset` into the AST's offsets and set `w: 0`.
  The consuming SDF Rasterize node's own caching/`stable` story needs a
  look — treat field-output looping as a **stretch goal** (v1 = image +
  value).

## Scope (decided 2026-06-16)

- **In:** Noise node, Voronoi node — both share the W slice-blend, so both
  get the param block via the shared helper.
- **Out (for now):** Force Turbulence. Its `speed`
  ([force-turbulence.ts:32](../src/nodes/effect/force-turbulence.ts#L32))
  advects a curl field inside the stateful GPU particle simulator; looping a
  running sim is a different problem and doesn't map onto this offset trick.

## Milestones

1. **Helper + Noise (image/value).** `loopEvolutionOffset` /
   `loopEvolutionPhase` in noise.ts; `u_animOffset` uniform + `fingerprintExtras`;
   `animated`/`anim_start`/`anim_end`/`anim_rate` params with visibleIf;
   flow angle path. Verify a seam-free loop in the browser (set window =
   project loop, scrub across the wrap).
2. **Voronoi.** Same params + helper wiring; verify loop.
3. **Field output (stretch).** Bake offset into the AST; confirm SDF
   consumers recompute correctly while Animated.
4. **Docs.** Update the Noise/Voronoi in-app docs blurbs and the devguide
   "Animation & time" section to mention internal looping evolution.

## Open questions

- **"Match project loop" convenience.** A button/toggle that sets
  End = loopFrames (and Start = 0) so the seam caveat is automatic. Static
  defaults can't read `loopFrames`, so this needs a tiny ParamPanel
  affordance or a compute-time clamp. Worth it? (Leaning yes, as a v1.1.)
- **Rate units.** Radius is in noise-sample (`scale`) units, so the same
  Rate feels different at different `scale`. Acceptable, or normalize by
  scale so Rate is perceptually stable? (Leaning: leave raw, document it.)
