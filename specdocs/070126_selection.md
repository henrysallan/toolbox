# Element Selection — spec (2026-07-01)

Devlist #75: "Index selection nodes. Logic node (if/then, and/or/not,
equal/not-equal)." Also touches #110 (polymorphic Compare/Logic) and #155
(per-element field control of Set Position).

The ask, in the owner's words: a Blender-style selection system — an
"ID node" plus logic nodes (if, or, and, not, >, <, ==) that compare an
element's ID to a scalar and use the result to select; and a general
**Selector** node that accepts any multi-object data (points; splines,
treating each subpath **or** each anchor as a separate element via a mode
toggle).

## Starting point

The building blocks exist but are disconnected:

- [compare.ts](../src/nodes/effect/compare.ts) and
  [logic.ts](../src/nodes/effect/logic.ts) operate on **single scalars**
  (two numbers → `1.0`/`0.0`). No per-element notion.
- [filter-points.ts](../src/nodes/effect/filter-points.ts) hardcodes a
  bbox/mask predicate and **immediately deletes** non-matching points —
  selection and its consequence are fused.
- The only per-element identity today is `groupIndex` on
  [Point](../src/engine/types.ts) / `SplineSubpath`, set by Collect.
- `scalar_field` is **per-pixel image-domain** (an SDF AST), not
  per-element.

There is no per-element selection concept anywhere. That absence is the
whole design.

## Decisions (from design Q&A)

1. **Selection is a per-element weight channel baked onto the geometry
   value.** Not a new socket type, not a lazy field. `PointsValue` gains
   an optional `selection?: Float32Array` (0..1); `SplineAnchor` and
   `SplineSubpath` each gain an optional `selected?: number` (0..1). It
   rides existing `points`/`spline` wires. **Absent ⇒ "all selected"
   (weight 1)** so every legacy graph is unchanged. Weight is a **float,
   not a bool**, so soft/feathered selection (proportional editing) is
   free.
2. **Operators respect selection via a shared opt-in helper**, not a
   universal evaluator convention. Topology-changing ops (delete,
   resample) can't be half-applied, so each node opts in explicitly and
   blends with `out = mix(input, op(input), weight)`.
3. **v1 criterion is Index only** (element index / `groupIndex`, plus
   every-Nth and range). Image-field, position, random, and
   spline-specific criteria are v2 — the `criterion` enum is designed to
   grow.
4. **The "ID + Compare + Logic" wiring collapses into the Select node.**
   IDs are inherently per-element and can't flow through the scalar
   Compare/Logic nodes, so index-compare lives *inside* Select, and
   boolean combination happens via Select's inline `combine` param
   (chained Selects) — no abstract field graph.

## Data model

New optional per-element channel — mirrors how `scales`/`rotations`/
`groupIndices` already ride on the value:

```ts
// types.ts
interface SplineAnchor  { …; selected?: number }   // 0..1, absent ⇒ 1
interface SplineSubpath { …; selected?: number }   // 0..1, absent ⇒ 1
interface Point         { …; selected?: number }   // 0..1, absent ⇒ 1
type PointsValue = { …; selection?: Float32Array }  // len = count, absent ⇒ all 1
```

Semantics:

- **Absent channel ⇒ every element fully selected (weight 1).** An
  operator that reads selection on geometry that never met a Select node
  behaves exactly as today (acts on everything). This is the back-compat
  hinge.
- **Present channel ⇒ weight per element.** `0` = untouched, `1` = full
  effect, in-between = feathered.
- **Not serialized.** Selection is computed at eval by the Select node
  onto the runtime value (like a texture), never stored — only the Select
  node's *params* serialize. No schema bump. (Even for splines, whose
  anchors serialize via the `spline_anchors` param, `selected` is written
  onto the eval-time `SplineValue`, not the authored param.)
- **Propagation is opt-in, like the other channels.** Pass-through /
  attribute-preserving nodes copy it (filter-points already copies
  `scales`/`rotations`/`groupIndices` for kept points — same discipline).
  Topology-rebuilding nodes legitimately drop it. Selection is meant to be
  produced right before the operators that consume it, so the chain is
  short.

Touchpoints for the channel (M1):

- [types.ts](../src/engine/types.ts): the four optional fields above.
- [points.ts](../src/engine/points.ts): `makePoints({withSelection})`,
  `pointsFromArray` (detect `selected`), `ensurePointArray` (build it),
  `clonePoints` (clone it), `getSelection(p, i)` read helper (returns 1
  when absent).
- **`engine/selection.ts` (new):** read/write/combine + the operator mix
  helper (below). Engine-side so nodes stay import-clean (invariant #1).

Note: this is deliberately shaped so a future **named-attribute bag**
(`attributes?: Record<string, Float32Array>`, with `"selection"` as one
convention) is an additive v2 — nothing here forecloses it.

## Domains — the mode toggle

Selection is written over a chosen **domain**:

- **Points** (`mode: points`) → per-point. Element index = point index;
  `group` source = `groupIndices[i]`.
- **Spline** (`mode: spline`) with a **`domain` toggle**:
  - `anchor` → per-anchor (Blender's Point domain). Element index =
    global anchor index across all subpaths; `group` source = the owning
    subpath's `groupIndex`.
  - `subpath` → per-subpath (Blender's Curve domain). Element index =
    subpath index; `group` source = `groupIndex`.

When an anchor-level operator reads a **subpath-domain** selection, every
anchor inherits its subpath's weight (`anchor.selected ??
subpath.selected ?? 1`).

## Select node

```
type:  "select"                       (immutable once shipped)
name:  "Select"
category: "utility"                   (handles points + spline, like proximity-merge)
headerControl: { paramName: "mode" }  // points | spline
noMaskInput: true                     // selection isn't an image blend

params:
  mode      enum   points | spline                       header control
  domain    enum   anchor | subpath   visibleIf mode==spline   (points ⇒ implicit point domain)
  criterion enum   index              v1: only "index"; enum reserved to grow
                   control: "segmented"

  // --- index criterion ---
  source    enum   index | group      which per-element integer to test
  op        enum   > < >= <= == != every-nth range    default ">"
  value     scalar def 0              integer-ish threshold  (hidden for every-nth/range)
  stride    scalar def 2  min 1       visibleIf op==every-nth
  offset    scalar def 0              visibleIf op==every-nth
  range_min scalar def 0              visibleIf op==range
  range_max scalar def 0              visibleIf op==range

  // --- fold with incoming selection ---
  combine   enum   replace | add | subtract | intersect | invert   default replace
                   control: "segmented"

inputs (resolveInputs):
  one socket "in" typed by mode (points | spline)
  + optional "value" scalar (overrides the `value` param — wire>param, as usual)

primaryOutput: points | spline  (resolvePrimaryOutput by mode)
               — the SAME geometry, with the selection channel written.
```

`combine` gives the and/or/not behavior inline for the common chained
case (Select → Select → …), so v1 needs no separate two-input logic node:

- `replace` — overwrite existing selection with the predicate.
- `add` — `max(existing, predicate)` (OR).
- `subtract` — `existing * (1 − predicate)`.
- `intersect` — `min(existing, predicate)` (AND).
- `invert` — ignore the predicate; emit `1 − existing`.

(A two-input **Combine Selection** node — for merging selections from two
*different* geometry branches — is deferred to v2.)

## Compute

1. Read `in`; bail to an empty/passthrough value if the kind doesn't
   match `mode`.
2. Enumerate the domain's elements (points; spline anchors or subpaths).
   For each, compute its integer key: `index` = ordinal, or `group` =
   `groupIndex ?? 0`.
3. Evaluate the predicate → `pred ∈ {0,1}` per element:
   - `>,<,>=,<=,==,!=` against `value` (`==`/`!=` are integer-exact here,
     no epsilon — these are indices).
   - `every-nth` → `(index − offset) % stride === 0 && index >= offset`.
   - `range` → `index >= min(range_min,range_max) && index <=
     max(range_min,range_max)`.
4. Read the element's existing weight `w0` (from the incoming channel, or
   1 if absent), fold per `combine` → `w1`.
5. Write `w1` onto the domain's selection channel of a **cloned** value
   (clone so the upstream cache isn't mutated — `clonePoints` /
   structuredClone of subpaths). Emit.

All-1 result ⇒ may emit the input unchanged (no channel needed). All-0 is
valid (nothing selected).

## Operator helper (`engine/selection.ts`) and opt-in set

A single shared helper so operators mask their effect uniformly:

```ts
// weight for element i on either domain; 1 when no selection present.
getWeight(value, domain, i): number

// convenience for the common "compute op result, then lerp by weight":
mixByWeight(original, operated, w): T     // scalar/vec2/anchor-pos lerp
```

Each opting-in operator: compute its full effect per element, then
`pos = lerp(origPos, newPos, w)` (and analogously for scale/rotation).
Weight `0` ⇒ element passes through untouched; the operator must also
**preserve** the incoming selection channel on its output so a
Select → Op → Op chain keeps masking.

**v1 opt-in set** (highest value, all per-element, all non-topology):

- [set-position.ts](../src/nodes/effect/set-position.ts) — move only
  selected (this is also the #155 win).
- [transform.ts](../src/nodes/effect/transform.ts) (point/spline modes).
- Jitter, [modulate-points.ts](../src/nodes/effect/modulate-points.ts),
  Smooth, Round Corners.

**Soft selection / falloff:** because weight is a float, a follow-on
"Grow/Feather Selection" step (distance smoothstep from the selected set)
makes any of these ops feather with zero per-op work. Specced as a v1.5
node, not blocking.

## Consumers / terminals

- **Delete (new node, `delete-selected`)** — removes selected elements
  (invert toggle keeps them instead), compacting like filter-points
  already does. filter-points stays for its bbox/mask convenience (a
  later "by selection" mode there is optional). Weight is thresholded at
  `> 0.5` for the delete decision.
- **Separate (v2)** — two outputs, selected / unselected, for branch-and-
  remerge.
- **Selection → Mask (v2)** — rasterize the selection (splat points / fill
  subpaths) into an image mask, round-tripping selection into the
  image-field world.

## On-canvas visualization

When the Select node (or a downstream node) is active, highlight selected
elements in the viewport — tint/halo weighted by selection value (orange,
Blender-style). This is what makes the system usable and is part of M1.
Reuses the existing overlay plumbing (SplineEditorOverlay / point
overlays); draws selected anchors/points brighter, unselected dimmed.

## Back-compat

- No new SocketType ⇒ invariant #7's 7-touchpoint ripple does **not**
  apply. Only `coerce.ts`/`socketColor.ts` are untouched (points/spline
  colors and the (few) point/spline coercions carry the value object
  through; nodes that rebuild the value drop the channel, which is fine).
- New `select` and `delete-selected` type strings; no existing type
  repurposed. Selection channel is optional everywhere ⇒ every saved
  project loads and evaluates identically. No schema bump.

## Deferred to v2 (enum/design reserved now)

- Criteria: **image-field** (sample a wired image at each element's UV →
  threshold or use luma as soft weight — the noise/gradient/SDF/audio-
  spectral hook), **position** (bbox / radius / above-below-line /
  inside-spline point-in-polygon), **random** (seeded hash → probability),
  **spline-specific** (curvature, segment length, param-`t` endpoints,
  open/closed), **proximity/density** (nearest-K, neighbor count).
- Two-input **Combine Selection** node; **Separate**; **Selection → Mask**;
  **Grow/Feather** falloff.
- **Named-attribute bag** generalization (`selection` becomes one of many
  attributes that can also drive scale/color/opacity).

## Milestones

- **M1 — Selection channel + Select node + viz.** The four optional
  fields in types.ts; points.ts helper updates; `engine/selection.ts`
  read/write/combine; the Select node (index/group, all ops incl
  every-nth + range, all combine modes, points + spline anchor/subpath
  domains); on-canvas highlight. Selection is *producible and visible*.
- **M2 — Operators respect it + Delete.** `mixByWeight` helper wired into
  the v1 opt-in set (Set Position, Transform, Jitter, Modulate Points,
  Smooth, Round Corners), each preserving the channel; `delete-selected`
  node. Selection is now *consequential*.
- **M3 — Polish + docs.** Grow/Feather falloff node; docs page; devguide
  "Groups & layers"/socket notes update; devlist #75 marked done and the
  v2 criteria noted; manual verification.

## Verification (manual — no test runner)

- Scatter Points → Select (mode points, source index, `op = every-nth`,
  stride 3) → viewport shows every 3rd point highlighted.
- The same selection → Set Position → only highlighted points move; the
  rest hold. Chain a second Set Position → still only the selected subset
  moves (channel survived the first op).
- SVG Source (multi-subpath) → Select (mode spline, domain subpath,
  source group, `op = ==`, value = 1) → only that letter/region
  highlights; Delete → it's removed, others intact.
- Spline domain anchor, `op = range` [0..0] → only first anchor of each
  subpath selected; Round Corners → only those corners round.
- Chained Selects: Select(index > 5) then Select(combine = intersect,
  every-nth 2) → the AND of the two predicates. Swap to `add`/`subtract`
  → OR / minus behave as specified.
- Legacy project with a Set Position on unselected geometry (no Select in
  the chain) → behaves exactly as before (absent channel ⇒ weight 1).
