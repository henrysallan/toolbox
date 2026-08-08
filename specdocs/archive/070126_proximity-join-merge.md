# Proximity Join/Merge — spec (2026-07-01)

Devlist #50: "some way to do proximity join/merge for splines (accept
multiple splines — always add an extra empty socket like the render
queue node — or a spline group as input)."

## Starting point

`src/nodes/effect/proximity-merge.ts` already exists and is committed
(b62289d). Today it:

- Takes a **single** `in` socket (spline OR points, via a `mode`
  header control) plus an optional `t` scalar.
- **Merges by snapping**: clusters anchors/points that fall within a
  UV-space `distance` into O(N²) union-find groups and moves each member
  to its cluster centroid. `animate` exposes `t` (0..1) to lerp positions
  toward the centroid; `dedupe` collapses each cluster to one item once
  `t≈1`.
- Explicitly **punts on subpath-to-subpath topology joins** ("a later
  Join node can pick that up").

It already accepts a "spline group" on its single socket (a Collect'd
multi-subpath `SplineValue`). What's missing from #50: (1) **multiple
auto-growing input sockets**, and (2) the actual **join** (stitching
subpath endpoints — a topology change).

## Decisions (from design Q&A)

1. **One node, `op` mode toggle.** Extend `proximity-merge` in place
   (type string unchanged for back-compat; display name → "Proximity
   Join/Merge"). Add an `op` param: `join | snap`.
   - `snap` = today's centroid clustering (no topology change).
   - `join` = endpoint stitching (topology change) — new.
2. **Extend the existing node** rather than add a second one — keeps the
   points mode + animate/dedupe machinery.

## Node shape (after)

```
type:  "proximity-merge"          (unchanged — saves reference it)
name:  "Proximity Join/Merge"
category: "utility"               (unchanged; handles spline + points)
headerControl: { paramName: "mode" }   // spline | points  (unchanged)

params:
  mode      enum   spline | points            (unchanged; header control)
  op        enum   join | snap                 NEW; visibleIf mode==spline
                   control: "segmented"        (points → always snap)
  distance  scalar 0..1 softMax .2  def .05    (unchanged)
  animate   bool   def false                   (unchanged)
  t         scalar 0..1 def 1  visibleIf animate   (unchanged)
  dedupe    bool   def false                    (unchanged; snap-only UI)
  slots     string[]  def ["in"]  hidden        NEW; see "Auto-grow"

inputs (resolveInputs):
  one socket per name in `slots`, typed by `mode` (spline|points)
  + `t` scalar (only when animate)              (unchanged)
  + universal mask appended by withMaskInput    (unchanged)

primaryOutput: spline | points  (resolvePrimaryOutput by mode)  (unchanged)
```

## Auto-grow input sockets

Requirement: "always add an extra empty socket." The render queue grows
via a manual **+** button; the intent here is true **auto-grow** — wiring
the spare socket spawns the next spare, so the user never manages a count.

Constraint discovered: the UI only re-derives a node's rendered sockets
from `resolveInputs(params)` (`refreshNodeSockets`, the param-change
handlers). `connectedTypes` is available **only inside the evaluator**, so
pure connectedTypes-based auto-grow won't render. Socket *count* must be
param-backed (as with Merge's `layers` / Render Queue's `items`).

**Mechanism — slots derived from edges (undo-safe):**

- `slots: string[]` param holds the socket names. Default `["in"]` so a
  fresh node shows one empty `in` socket, and legacy saves (single `in`
  socket, edge `in:in`) keep working with zero migration.
- `resolveInputs` renders one socket per `slots` entry (typed by `mode`),
  then `t`, then mask.
- A single **normalization `useEffect` in EffectsApp**, keyed on
  `edges`/`nodes`, keeps every `proximity-merge` node's `slots` equal to:
  **(connected socket names, stable order) + exactly one trailing empty
  spare.** Connected names = target handles of edges into the node,
  excluding `t` and `mask`. The spare keeps its name while empty; a fresh
  unique name is minted only when the previous spare gets wired.
- The effect writes `slots` + `data.inputs` via `setNodes` **without**
  `pushGraph` — slots are a pure function of edges (which *are* in undo
  history), so after any undo/redo/paste the effect re-derives them.
  No history pollution, no infinite loop (only setNodes when the derived
  list differs by value).

Ordering note: on connect, the evaluator runs with the *current* slots
(spare already carries the new edge → compute reads it correctly); the
effect appends the next spare a beat later. compute is never wrong, the
new empty socket just appears on the following render.

This covers both #50 input forms: multiple sockets (auto-grow) **and** a
spline group (any single socket accepts a Collect'd multi-subpath value).

## Compute

1. **Gather + concatenate.** For each name in `slots`, read
   `inputs[name]`; keep those matching `mode`'s kind. Concatenate all
   connected inputs into one working value (spline: flatten all subpaths;
   points: concat all points). Incoming `groupIndex` is preserved but not
   re-tagged — this node merges *across* inputs by design.
2. **Resolve `t`.** As today: `t` = scalar input ?? `t` param, clamped
   0..1; forced to 1 when `animate` is off.
3. **Dispatch on `op`** (spline mode; points mode is always snap):
   - `snap` → existing `mergeSpline` / `mergePoints` on the concatenated
     value (unchanged behavior, now fed by many sockets).
   - `join` → `joinSpline` (below).

### `joinSpline` (endpoint stitching)

Operates on **open** subpaths' free endpoints across the whole
concatenated spline. Closed subpaths have no free ends → pass through
untouched. Coordinates are normalized UV (aspect-anisotropic — matches
the existing snap, which also compares raw UV distance; documented
limitation, consistent with the node's current behavior).

Endpoints: for each open subpath, `head` = anchors[0].pos, `tail` =
anchors[last].pos.

1. **Candidate pairs.** All endpoint pairs from *different* subpaths
   within `distance`. Sort ascending by squared distance.
2. **Greedy matching.** Each endpoint matches at most once. Walk sorted
   pairs; accept a pair when both endpoints are still free and joining
   them doesn't merge a chain with itself prematurely (self-close handled
   in step 5). Accepting welds `chainA`'s end to `chainB`'s end,
   reversing a chain's orientation as needed so the shared endpoints are
   adjacent. Chains are tracked with union-find over subpath ids plus
   per-chain ordered subpath lists and head/tail endpoint bookkeeping.
3. **Flatten each chain** to a single anchor list in chain order,
   reversing member subpaths where the matching required it (reversing a
   subpath swaps every anchor's `inHandle`/`outHandle` and reverses the
   array).
4. **Weld joints.** At each internal joint the two coincident anchors
   collapse to one: `pos` = midpoint of the two endpoints; the merged
   anchor keeps the *incoming* segment's `inHandle` and the *outgoing*
   segment's `outHandle` (a corner join that respects both tangents;
   `broken` set when the two handles aren't colinear). No smoothing is
   invented.
5. **Self-close.** If a finished chain's two remaining free ends are
   within `distance`, weld them the same way and set `closed = true`.
6. Emit welded chains + the untouched closed subpaths as the result
   `SplineValue`.

**Animate/`t` interaction (parallel to snap's dedupe gate):** topology
can't be half-applied, so the real stitch commits only at `t ≥ 1−ε`
(always, when `animate` is off). With `animate` on and `t < 1`, no
topology change: each matched endpoint just lerps toward its weld
midpoint by `t`, so paths visibly slide together; at `t = 1` the stitch
lands with no pop. This reuses the existing `animate`/`t` plumbing and
mirrors snap's "count reduction gated at t=1" philosophy.

## Back-compat

- `type` string unchanged; `slots` defaults to `["in"]` so the legacy
  single-socket saves load and evaluate identically (one input, snap
  default `op`). No schema bump, no migration.
- `op` defaults to `join`? No — default **`snap`** would silently change
  existing saved nodes' output. Existing nodes have no `op` param; the
  node reads `op ?? "snap"` so **loaded projects keep today's snap
  behavior**. Newly-added nodes also default `snap` in the param def (the
  join mode is opt-in via the toggle). *(If we'd rather new nodes default
  to join, set the ParamDef default to "join" while compute still reads
  `?? "snap"` for the missing-param legacy case — decide during impl;
  spec ships snap-default to be safe.)*

## Milestones

- **M1 — Multi-input auto-grow.** `slots` param + `resolveInputs` +
  concatenation in compute; EffectsApp normalization effect. Snap works
  across all inputs. Legacy `in` socket preserved.
- **M2 — Join mode.** `op` param + `joinSpline` (steps 1–6) + the `t`
  gate. Points mode stays snap-only.
- **M3 — Polish + docs.** Handle continuity at welds, self-close, node
  description update, manual verification, devguide/devlist update.

## Verification (manual — no test runner)

- Three separate line-segment splines (e.g. three Spline Draw / SVG
  sources) into three auto-grown sockets; `op = join`; confirm they
  stitch into one continuous path when endpoints are within `distance`,
  and into a closed loop when the chain's ends meet.
- A Collect'd spline group into a single socket → same join result.
- `op = snap` reproduces today's centroid behavior across multiple
  inputs; `animate`+`t` slides then commits at 1.
- Disconnect a middle socket → slots normalize back to "connected + one
  spare"; undo/redo keeps sockets in sync with edges.
- Points mode: multi-input concat + snap; join hidden.
