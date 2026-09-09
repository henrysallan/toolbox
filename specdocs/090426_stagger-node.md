# Stagger — per-point timing as a channel (2026-09-04)

Status: **shipped** same day (node + `scripts/check-stagger.mts` guard +
docs). Decided directly from the pro/con investigation below; no separate
design Q&A round.

## Why

Cavalry's Stagger and After Effects' index-offset expression are the
missing mograph primitive on points: "each element starts a little after
the previous one." Before this node that logic lived inside a Point
Expression string (`clamp((t - index*spacing)/dur, 0, 1)`), invisible from
the graph, un-keyframable without `ch()` + Sync, and out of reach of the AI
recipe agent (which sets scalars fine but cannot reliably author code).
The concept had already been built twice, non-reusably: the Text node's
per-glyph `cascade` driver (engine/text-animators.ts) and the timeline's
keyframe stagger (timeline/keyframe-ops.ts). Neither reaches points.

The substrate was ready: named attributes (081326_point-attributes.md) with
the propagation law, `copyPointsWith`, the name-suggestion registry and the
`name` reference-wire aux. The consumer side — Map Attribute (scale /
rotation / position, with a 0–1 curve), Filter Points (attribute mode),
Copy to Points (`tint_attr` / `opacity_attr` / `pick_attr`), point-label
tokens — is what makes "downstream just reads phase" real for the classic
pop-in / fade-in / sprite-pick cases.

## Investigation summary (pros / cons that shaped the design)

Pros: timing becomes graph-visible, keyframable, exposable, agent-settable;
pure function of time (scrub/export exact, no pre-roll, retimeable by Time
Offset — unlike the sim-owned `age` channel); the reference wire works;
Map Attribute's curve is the easing (Text animators' "ease AFTER the
split" rule, reproduced as a two-node chain); cheap (CPU, ~250 lines);
matches M3's "Houdini-shaped toolkit, each a plain node" decision.

Cons: a third way to author a channel (Point Expression, Set Named
Attribute + Attribute Math); the consumer gap is real — nothing reads
attributes on Stroke width/color, Points to Spline, 3D instances
(`InstancesValue` has no attribute map — the M4 remaining gap) or image
nodes; design surface creeps (order / fit / loop / active semantics); fixed
channel names collide; per-frame downstream invalidation (inherent to any
animated channel; Point Expression with `t` already does it). "Sequence"
as a name collides with image sequences and devlist #138's NLE sense —
**Stagger** is the term Cavalry and our own timeline code use.

## The node

`stagger`, category point / modifier, CPU, `stable: true`, no mask input.
Inputs: `points` (required), `clock` (optional scalar). Output: `points`;
aux `name` (string — the reference wire, same as Set Named Attribute).

Params:

- `attr_name` — base channel name, default `phase`. Reserved / empty →
  pass-through. Renaming solves the two-Staggers-in-series collision.
- `order` — `index | reverse | center | edges | random | attribute`.
  `order_attr` (visible for `attribute`) reads ANY point column through
  `readPointAttr` — a named channel, a dotted component, or a built-in
  (`x`, `y`, `group`, …) — with `suggestAttrsRequire` + built-ins in the
  picker. Missing column → index order + the red tint.
- `unit` — `frames | seconds` (segmented). ONE unit for Spacing / Total /
  Duration / Jitter / Start AND the wired Clock. Default frames (Time
  Offset / Scene Time period convention).
- `mode` — `spacing` (`Spacing` per rank step) | `fit` (`Total`: the whole
  sequence, last start + Duration, lands on Total).
- `duration`, `jitter` (positive-only: nothing starts before Start),
  `seed` (shared by jitter and random order), `start`.
- `loop` — `off | cycle | ping-pong`, repeating the WHOLE sequence
  (period = last start − Start + Duration), periodic everywhere.
- `extras` (boolean) — also write `<name>_t0` and `<name>_active`.

Semantics (all internal math in frames; `fps` converts seconds):

- **Dense rank.** Ties share a step: a grid ordered by `y` starts a whole
  row at once; center-out starts symmetric pairs together. `steps` =
  distinct keys. `start_i = Start + rank_i × step + hash(seed,i) × Jitter`,
  `step = Spacing` or `max(0, Total − Duration) / (steps − 1)`.
- **phase** = clamp((T − (start_i − Start)) / Duration, 0, 1) where T is
  the local clock (clock − Start, loop-folded). Duration 0 → step function.
- **active** = 1 while in flight (0 ≤ rel < Duration) — Filter Points on it
  drops both unstarted and finished points. Duration 0 → never.
- **Clock.** Unwired: `ctx.tick / ctx.ticksPerFrame` (fractional frames —
  `ctx.frame` is floored). Wired: the scalar in the node's unit. That is
  the Animated Value affordance without `clockInput` — the node's OWN
  params stay on the outer clock (Time Offset's rule), only the stagger
  time is wired.
- **No easing param.** Consumers own shaping (Map Attribute's curve).
- **Caching.** `fingerprintExtras` stamps the scoped tick, so unwired it
  recomputes per tick (O(n)) and caches while paused — the time-dependent
  Point Expression contract. A wired static clock still recomputes per
  frame (the hook can't see wiring); accepted.

Recipe: Scatter → Stagger → Map Attribute (`phase` → scale, curve
ease-out) → Copy to Points (`opacity_attr: phase`).

## Deliberately deferred

- Spline anchors / subpaths domain (per-subpath draw-on stagger) — no
  spline consumer reads attributes for trim yet.
- 3D points — `points3d` can't ride `points` sockets and Set Named
  Attribute has no points3d target either (M4 remaining).
- Ordering by value (distance-proportional wave) instead of rank — do it
  today with Set Named Attribute + Attribute Math writing the channel,
  then Map Attribute; revisit if rank-only proves limiting.
- Knowing whether `clock` is wired inside `fingerprintExtras`.

## Verification

`npm run typecheck`, `npm run check` (includes `check-stagger.mts`: the
five orderings incl. dense ties on a named channel and on built-in `x`,
spacing vs fit incl. `Total < Duration` and single point, jitter bounds /
determinism / seed, start, loop cycle (incl. negative clock) and ping-pong,
seconds unit, wired clock in both units, fractional playhead, duration 0,
extras on/off, same-name replace, custom name, reserved / empty name
pass-through identity, empty inputs). Manual: Scatter → Stagger → Map
Attribute → Copy to Points, watch the Spreadsheet's `phase` column ramp
while scrubbing; Time Offset upstream shifts it.
