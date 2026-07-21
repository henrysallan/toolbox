# Iterate zone — two nodes, inline, always (spec, 2026-07-19, rev 3)

Presentation + structure of the Iterate feature
([071826_iterate-node.md](071826_iterate-node.md) has the evaluation
architecture; this doc supersedes its three-node editor shape).

**Rev 2 (owner call):** an Iterate is simply a zone — no collapsed view,
no toggle, no diving. **Rev 3 (owner call):** the zone is exactly TWO
nodes — the loop params live on the Iteration Input, the collected
output comes off the Iteration Output, and the separate "Iterate" shell
node is gone.

## Structure

- **Iteration Output** (`iterate`) — the engine-side shell. It computes
  (nested evaluation of the members, K times per frame regardless of tap
  count — one pass evaluates every tap's branch via the evaluator's
  `extraTargets`), anchors membership (members' `parentId` = its id),
  and collects: wiring a member into its **virtual input** mints a
  collect socket — any number of them, each with its own same-named
  grouped aux output (image → `image_group`, spline/points → merged with
  `groupIndex` = iteration). It also carries hidden `zi__<name>`
  passthrough inputs (below).
- **Iteration Input** (`iterate-input`, a member) — the loop params:
  `count`, `seed`, and **`random_min` / `random_max`** (the per-iteration
  `random` value maps into that range). Aux outputs during the nested
  eval: `index` (0…K−1), `t` (0…1 across the loop), `random`. Its `in:`
  side is the zone's exterior face: passthrough sockets mint via its
  virtual input (or from the inside via its virtual output), and
  exterior wires land there.
- **Passthrough plumbing:** flatten reroutes
  `exterior → (Iteration Input in:<name>)` onto the shell's hidden
  `in:zi__<name>` — so the value evaluates outer-side once — and the
  shell re-injects it each iteration through `ctx.iteration.values`,
  which the Iteration Input's compute re-emits on its same-named aux
  output. The collect tap (`member → shell in:<socket>`) rides the
  interior record at flatten (its source doesn't exist in the outer
  graph).
- Membership stays `parentId`; the members (Iteration Input included)
  render inline, permanently, inside the tinted underlay (bbox = shell ∪
  members, no grow-to-overlap; label "Iterate ×K" reads count off the
  Iteration Input). No diving (`isEnterableScope` excludes iterate), no
  breadcrumbs.
- **Loop params animate.** The Iteration Input never runs through the
  outer evaluator, so the shell resolves count/seed/random_min/
  random_max itself with the house **wire > keyframe > constant**
  precedence: keyframes evaluate off the stashed node's animation at the
  scoped clock (layer-local time included); an exterior wire into an
  EXPOSED loop param reroutes at flatten onto the shell's hidden
  `zi__param__<name>` input (same mechanism as passthroughs) and wins.
  Caching is inherited — wired values ride the shell's input
  fingerprints, and any animated member block already folds ctx.tick
  into the interior hash. Members wiring into their own Iteration Input
  is rejected (circular). Behavior notes: `random` is hash01(i, seed) —
  independent of count — so an animated count adds/removes iterations at
  the tail without reshuffling existing ones; an animated random range
  shifts the whole population smoothly inside the moving band.

## Interaction rules

Cross-scope wires are valid only for the zone's legal crossings
(NodeEditor `isValidConnection`; onConnect executes the routing):

1. **member → its own shell** — the collect tap (or virtual mint).
2. **exterior → Iteration Input** — landing on the exterior face
   (existing passthrough socket or its virtual port).
3. **exterior → member (stay as wired)** — the wire remains exactly as
   drawn; nothing is minted and nothing visibly reroutes. Engine-side,
   flatten mirrors each crossing edge onto a per-edge hidden shell input
   (`zi__e_<edgeId>`, raw/uncoerced), and the shell's compute
   synthesizes an eval-only `iterate-feed` node that re-emits the value
   inside each iteration (cached across iterations — the value is
   loop-constant). Explicit passthrough sockets still exist via the
   Iteration Input's virtual ports for those who want a tidy interface;
   they're just never auto-created.
4. **member → exterior** — auto-mints a collect socket on the shell and
   routes through it (reusing an existing tap for the same member
   output). The only gate is the honest type one: the exterior target
   must accept the GROUPED result (image arrives as image_group — feed
   it to Copy to Points / Group Pick / Merge Group, not an image-only
   socket).
5. **iteration values → exterior (PENDING wires)** — the Iteration
   Input's aux outputs wire freely to any same-scope consumer. The wire
   is inert (the consumer sees its socket default) until the chain is
   piped into the Iteration Output — the "build outside, pipe in" flow.

**Absorb on tap** (`absorbIntoIterateZone`): wiring an exterior node
into the Iteration Output lands the tap AND expands the zone to swallow
that node plus its upstream nodes that depend on iteration values (the
pending-wire chain). Inputs from nodes that stay outside keep their
wires exactly as drawn (rule 3 handles them); outputs from absorbed
nodes to outside consumers mint deduped collect sockets (the exiting
value changes TYPE — the grouped collection — so an explicit socket is
honest there); pending wires into the absorbed chain simply come alive.
Unabsorbable closures (layers, Outputs, other zones' machinery) refuse
cleanly.

Everything else cross-scope is rejected (that's just circular wiring —
e.g. a member driving its own zone's Iteration Input). Other
interactions:

- **Shell drag moves the zone**: dragging the Iteration Output carries
  every member (drag-start position snapshot, absolute deltas — no
  drift; members already in the drag selection are skipped).
- **Absorb by drop**: a single dragged node whose center lands in a
  zone rect joins it. `reparentNode` refuses boundary nodes (Iteration
  Input included), cycles, and moves that would leave an edge crossing
  scopes (toast).
- **Leave by Cmd/Ctrl-drag**: plain drags never remove membership — the
  zone stretches around the member (the rect is the members' union).
  Cmd/Ctrl-drag ending outside the zone (rect computed WITHOUT the
  dragged node, or exit would be geometrically impossible) reparents it
  up to the shell's scope — and since Cmd-drag already means
  detach-with-heal, the wires that would block the move are stripped by
  the same gesture. Shells themselves never reparent by drag (a zone
  inside a zone is a nested Iterate, which doesn't evaluate).

## Deferred

- Socket rename/remove UI for the Iteration Input's passthroughs.
- Compact chrome; zone-style rendering for groups/layers.

## Verify

Add an Iterate: exactly two nodes + tint appear. Set count/seed/random
range on the Iteration Input; wire `random` into a Circle's exposed
radius; wire the Circle into the Iteration Output (virtual port mints
the collect socket) → its aux output feeds Copy to Points as variants.
Drag the Iteration Output → the whole zone moves. Drag a node in/out of
the tint → reparents; wire exterior→member → passthrough auto-mints;
member→exterior → collect auto-mints (or is refused once one exists).
