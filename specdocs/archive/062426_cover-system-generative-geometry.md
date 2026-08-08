# Cover System → generative-geometry node primitives (spec — 2026-06-24)

## Goal

A colleague vibecoded a standalone React tool, `CoverSystemGenerator`
(`cover-system-generator.jsx`): a **seeded generative-geometry system** that
emits print-cover artwork as SVG. A `mulberry32` PRNG (seeded by a hashed
string) drives **five "engines"** — scattered rect/circle clusters with
construction lines and intersection markers, a polar dot lattice, and
times-table string-art — plus a seed-driven crop.

Rather than port it as one bespoke node, we **reverse-engineer it into the
node graph**: reuse the toolbox's existing procedural-geometry subsystem,
add **two small reusable primitives** for the operations that don't exist
yet, and express each engine as a **node-group with promoted params**. The
output of the JSX is static; expressed natively, every knob becomes
keyframable and exportable as a live-app control.

## Decisions (from design Q&A, 2026-06-24)

1. **Approach: hybrid.** Two new reusable primitive nodes + per-family
   node-groups with promoted params. Not a single monolithic "Cover" node
   (bespoke, not rewireable) and not primitives-only (would skip 3 of 5
   engines).
2. **Output: both.** Each family group's `group-output` exposes a `spline`
   socket (vector, stays editable downstream) **and** an `image` socket
   (rasterized via internal `stroke`/`rasterize-spline` + `merge`). Vector
   for compositing/booleans/further editing; image for drop-in use.
3. **Determinism via the existing seed model.** `scatter-points` already
   uses `mulberry32` with an integer `seed` param — the *same* PRNG family
   as her tool. Her string-seed + sequential-seed contact sheet becomes a
   single scalar `seed` param you scrub or keyframe.

## Why this decomposes better than a raster-compositor would

The toolbox already has a Houdini-lite procedural subsystem — this is the
load-bearing finding:

- [scatter-points.ts](../../src/nodes/effect/scatter-points.ts) — seeded
  scatter of N points, `mulberry32`, per-point rotation/scale + jitter.
  **Identical determinism model to the JSX.**
- [copy-to-points.ts](../../src/nodes/effect/copy-to-points.ts) — instance an
  image / spline / points at every point with per-point transform, plus
  `scale_field` (sample an image at each point → per-copy size) and variant
  pick (random/cycle/image). This is "stamp a shape/glyph at each location."
- [array.ts](../../src/nodes/effect/array.ts) — tile an instance into a 2D
  grid; **point mode yields a regular point lattice** (seed with
  `source/point.ts`).
- [points-on-path.ts](../../src/nodes/effect/points-on-path.ts) — N evenly
  arc-length-spaced points along a spline.
- [connect-points.ts](../../src/nodes/effect/connect-points.ts) — join point
  pairs (distance-based).
- Native dashed strokes ([stroke.ts](../../src/nodes/effect/stroke.ts),
  [rasterize-spline.ts](../../src/nodes/effect/rasterize-spline.ts)), shape
  sources (`circle`, `rectangle`), `sdf/to-spline`, `merge`, `transform`,
  `gradient`, `polar-coords`, `math`.

### Per-engine capability map

| Engine | Primitive recipe | Status |
|---|---|---|
| **Diffraction** | `point` → `Array`(point grid) → radial field (`gradient`+`polar-coords`+`math`) → `copy-to-points`(dot, `scale_field`); shape mix via image-group variants | ✅ buildable today |
| **Inters Grid** | `scatter-points`×tiers → `copy-to-points`(circle/rect) **+** `Array`(point grid) → `copy-to-points`(glyph) | ✅ buildable today |
| **Envelope** | `rectangle`→spline → `points-on-path`(N) → **String Art** (`i→(i·k) mod N`) → `stroke` | ⚠ needs primitive B |
| **Rectilinear** | `scatter-points`×tiers → `copy-to-points`(rect) + line splines → **Spline Intersections** → `copy-to-points`(marker) | ⚠ needs primitive A |
| **Intersected** | `scatter-points`×tiers → `copy-to-points`(circle, dashed variants) → **Spline Intersections** → marker | ⚠ needs primitive A |

Everything maps **except two operations**, and they are the aesthetic
signatures of the tool — which is exactly why they're worth building as
general primitives, not single-use glue.

## New primitive A — Spline Intersections (`spline-intersections`)

The "nodes at every crossing" construction-drawing look (Rectilinear,
Intersected, optionally Envelope). No existing node computes crossings:
`connect-points` is distance-based, `spline-boolean` does areas.

- **Category:** `point` / generator. Pure CPU geometry (like
  `connect-points`) → satisfies engine self-containment (invariant #1).
- **Input:** `spline` (one set; subpaths may be lines, rects, or
  circle-as-bezier from `copy-to-points`/`sdf-to-spline`).
- **Algorithm:** flatten each subpath to a polyline at an adaptive
  tolerance, then all-pairs segment×segment intersection, spatial-hash
  accelerated (lift the grid-bucket approach from `connect-points`). Circle
  crossings come out approximate (bezier flattening) rather than via the
  exact circle-circle formula the JSX uses — acceptable for a visual tool.
- **Output:** `points` at each crossing (primary). Then `copy-to-points`
  stamps any marker glyph (square/circle/triangle), reproducing her
  switchable node shape.
- **Params:** `thin` (0..1, even decimation — mirrors her `p.nodes` `step`),
  `self_intersections` (on/off), `min_angle` (drop near-tangent crossings),
  `max_points` (render cap — the JSX caps at 2500/3000/8000; log when hit
  per the "no silent caps" convention).
- **Reuse beyond covers:** markers on any grid/construction overlay,
  contact graphs, lattice decoration.

## New primitive B — String Art (`string-art`)

Envelope's entire identity: connect ordered point `i` to `(i·k + offset)
mod N`. `connect-points` joins by *proximity* — wrong topology.

- **Category:** `spline` / generator. Pure CPU. (Decision: a dedicated node
  rather than a mode on `connect-points` — different topology, keeps both
  nodes' contracts clean and back-compat trivial.)
- **Input:** `points` (ordered; from `points-on-path`, scatter, anything).
- **Output:** `spline` (the chords). Passthrough `points` aux like
  `connect-points`.
- **Params:** `k` (multiplier), `k2` + `layer2` (her optional second pass),
  `offset`, `modulus` (default = point count). Feed the chord output into
  **primitive A** to reproduce her per-crossing markers on the envelope.
- **Reuse beyond covers:** string-art / curve-stitch / harmonograph motifs.

## Per-family node-groups (promoted params)

Each family is a saved node-group; `group-output` carries `spline` +
`image`; `resolvePromotedParams` surfaces the family's knobs on the group
node. Suggested promoted sets mirror her sliders:

- **Diffraction:** rings/spacing, band freq, sharpness, dot size, primary/
  secondary shape, shape mix, seed.
- **Inters Grid:** sets, size, spread, dashed, rect-ratio, lines, line span,
  stroke, grid spacing/padding/node-size/shape, seed.
- **Envelope:** points, k, k2 (+layer2), stroke, intersections (primitive A
  thin), seed.
- **Rectilinear:** sets, size, spread, dashed, lines, line span, nodes
  (thin), stroke, diagonals, node shape, seed.
- **Intersected:** sets, size, spread, nodes (thin), dashed, rect-ratio,
  lines, line span, stroke, seed.

### Known fidelity divergences (call these out, don't hide them)

- **Tiers** (her "1 large · 1 medium · 2/4 small" cluster) → approximated by
  2–3 `scatter-points` nodes (low count, per-tier scale) positioned around a
  cluster center via `transform`, then `merge`d. Not the exact
  angle/distance-from-center placement rule, but the same visual family.
- **Construction-line "span"** (in-shape ↔ edge-to-edge morph) → exposed as
  a line-length / endpoint-lerp scalar on the line splines. Approximate.
- **Seed-driven crop/zoom** → a `transform` at the group output keyed off
  seed. Optional; can ship without it first.
- **Diffraction ring function** → the exact
  `pow(0.5+0.5·cos(freq·r − phase + amp·cos(m·θ+ψ)), sharp)` + gaussian bump
  is the fiddliest to match with `gradient`+`polar-coords`+`math`; aim for
  the band *look*, not the formula.

## Payoffs over the static JSX (the reason to do this natively)

- **Animation:** `seed`, `line span`, `band freq`, crop/zoom all keyframe.
  Her sequential-seed contact sheet → a scrubbable/animatable seed.
- **Live-app export:** promoted group params flow into `controlParams` →
  exported-app control panels and `/live/[slug]` for free
  (`buildExportManifest`).
- **Composability:** vector output feeds `spline-boolean`, `offset-path`,
  fill-image, etc. — far past what the SVG-copy workflow allowed.

## Files

New:
- `src/nodes/effect/spline-intersections.ts` — primitive A. Model on
  [connect-points.ts](../../src/nodes/effect/connect-points.ts) (spatial hash,
  pure geometry, passthrough aux).
- `src/nodes/effect/string-art.ts` — primitive B. Model on `connect-points.ts`
  (points→spline generator).
- Register both in [src/nodes/index.ts](../../src/nodes/index.ts).
- `src/presets/` (or `public/presets/*.json`) — the five family subgraphs as
  serialized fragments `{ name, description, schemaVersion, nodes, edges }`,
  **authored already-grouped** (a `node-group` + boundary nodes + promoted
  interface baked in). Plus a small preset registry/loader
  (`src/presets/index.ts`) — a list parallel to the node registry.

Edited:
- [NodeBrowserDropdown.tsx](../../src/components/effects/NodeBrowserDropdown.tsx)
  + [NodeSearchPopup.tsx](../../src/components/effects/NodeSearchPopup.tsx) — add a
  `"presets"` entry to `CATEGORY_ORDER` and feed preset entries (pseudo-type
  `preset:<id>`) alongside `allNodeDefs()`.
- [EffectsApp.tsx](../../src/components/effects/EffectsApp.tsx) `onAddNode` —
  detect `preset:<id>`, load the fragment, `cloneSubgraph(nodes, edges,
  offset, { parentId: currentScope })`, select the result. Mirrors the
  existing hardcoded compound entries (`layer`, `simulation-zone`) and the
  paste path (`handlePasteNodes`), incl. its root→layer auto-wrap.
- `specdocs/devguide.md` — note the two primitives + the Presets mechanism
  once shipped (per the "keep devguide updated" rule).
- In-app docs page picks up both nodes from their defs automatically.

## Milestones

1. **Primitives.** Ship `spline-intersections` + `string-art` as
   standalone nodes; verify visually; register + docs. (No covers yet —
   these stand on their own.)
2. **Buildable-today families.** Diffraction + Inters Grid as node-groups to
   validate the end-to-end pipeline (no new-node dependency).
3. **Primitive-dependent families.** Envelope (string-art), Rectilinear +
   Intersected (spline-intersections) as node-groups.
4. **Expose + export.** Promote params per group; wire `controlParams`;
   keyframe pass on seed/freq/span/crop.
5. **Presets distribution.** Ship the five groups as a new **Presets**
   add-menu category (see decided design below) so a user drops in a
   pre-wired "Cover: Diffraction" instead of rebuilding the graph.

## Build log

- **M1 — primitives (done, 2026-06-24).** `spline-intersections` +
  `string-art` written, registered, typecheck + lint clean. Not yet
  browser-verified.
- **Preset infrastructure (done, 2026-06-24) — pulled ahead of M2/M3.**
  Rationale: family groups can't be inserted or tested until the insertion
  mechanism exists, and the mechanism is the part verifiable in code (the
  group content needs visual tuning). Shipped:
  - `src/state/presets.ts` — `PresetDef` + `PRESETS` registry + a reusable
    `groupFragment` helper that assembles a node-group + boundary nodes the
    way `groupSelection` does (generator group: no inputs, output sockets
    wired to the interior terminal).
  - `EffectsApp.onAddNode` — `preset:<id>` branch: `build()` → `cloneSubgraph`
    (fresh ids, retarget to current scope) → insert; root auto-wraps into a
    new layer, mirroring `handlePasteNodes`.
  - `NodeBrowserDropdown` + `NodeSearchPopup` — a "Presets" category
    (browsable + searchable; shown at root too).
  - First preset authored: **Cover · Envelope** (`Circle → Points on Path →
    String Art → Stroke`), outputs image + chord spline. Exercises the M1
    `string-art` primitive end-to-end.
  - First preset shipped: Cover · Envelope. **Needs a browser pass.**
- **M2 + M3 — all five families (done, 2026-06-25).** Diffraction, Inters
  Grid, Rectilinear, Intersected added to `state/presets.ts`. Key
  simplification: every family composites at the spline level via `Collect`
  (which concatenates spline inputs) + one `Stroke`/`Fill` — **no `Merge`**,
  no dynamic-socket wiring. A shared `splineRenderTail` helper handles the
  collect→render→outputs tail.
- **Group-as-Active preview fix (done, 2026-06-25).** Marking a group (or its
  Group Output) Active showed "Connect an Output node to preview" because
  flatten dissolves group shells before eval, so the active id matched no
  node. Fix: `resolvePreviewProducer` (flatten.ts) remaps a structural
  Active/preview target to the interior producer feeding the group's image
  output; the evaluator applies it before flatten + the needed-set and
  previews the exact resolved handle. Selecting a group now previews it too.
- **M4 — param promotion + export controls (done, 2026-06-25).** A `promote`
  option on `groupFragment` surfaces chosen interior params as editable,
  **keyframable** sliders on the group node's panel (Group Input socket →
  exposed deep param; ParamPanel renders these for a group shell) and flags
  them `controlParams` so exported apps / live links get the knobs. Promoted
  per family: Envelope (Points, K); Diffraction (Grid X/Y, Dot scale); Inters
  Grid (Shapes, Seed, Grid X/Y); Rectilinear / Intersected (Shapes·Circles,
  Seed, Nodes). Each promoted param also becomes an optional group input
  socket you can drive with a Constant/LFO. **Needs a browser pass.**

## Presets feature (decided design, 2026-06-24)

A preset = a serialized subgraph fragment, **authored already-grouped**,
inserted from a new "Presets" add-menu category. This is an
**insertion-time-only** concept — once dropped, it's an ordinary node-group
that saves/loads through the normal path. No schema bump, no serialization
change, no engine change.

Why it's low-risk: the hard parts already exist and are proven —
- `cloneSubgraph` ([graph-ops.ts](../../src/state/graph-ops.ts)) already clones a
  node+edge fragment with **fresh ids**, remapped edges, remapped interior
  `parentId`, and fresh `zone_id`s — exactly what an insert needs.
- `serializeGraph`/`deserializeGraph` ([project.ts](../../src/lib/project.ts))
  already round-trip nodes+edges+`parentId`+groups, and run param migrations
  on load — so a preset file rides the same `schemaVersion` + migration path
  as any saved project (store `schemaVersion` in each preset file).
- Compound menu entries (`layer`, `simulation-zone`) and `buildStarterGraph`
  are existing prior art for "an add-menu entry that mints multiple wired
  nodes."

The only genuinely new surface: a preset **registry + loader** (data), and
the **menu + `onAddNode`** wiring (see Files). Author presets by building the
group in-editor (Cmd+G, promote params) then serializing the selection to a
fragment — `handleCopyNodes` already produces `{ nodes, edges }`; a dev-only
"copy as preset JSON" affordance can come later, MVP hand-places the file.

Risks to honor: (a) at **root scope** a preset must land inside a layer
(root is a strict layer chain since schema v4) — reuse `handlePasteNodes`'s
auto-wrap. (b) A preset using the new primitives can only instantiate once
those nodes are **registered** — hence primitives ship first (M1).

## Resolved open questions (2026-06-24)

- **`math` cos/pow** — ✅ confirmed. [math.ts](../../src/nodes/effect/math.ts)
  exposes `Cosine`, `Sine`, `Power` (+ `Arctan2`, etc.), and runs in a
  per-pixel **UV mode** and a **scalar_field** mode. Diffraction band field =
  `uv-coords`/`gradient` → `polar-coords` (r, θ) → `math` (UV) for
  `cos(freq·r + amp·cos(m·θ))`, fed as `copy-to-points` `scale_field`.
- **`circle`/`rectangle` → spline** — ✅ resolved, simpler than feared. Both
  source nodes are **already spline generators** (`category: "spline"`,
  primary output = a closed cubic spline — see
  [circle.ts](../../src/nodes/source/circle.ts)). Feed them straight into
  `copy-to-points` (spline mode) → primitive A. No SDF detour;
  `sdf-to-spline` (marching-squares, CPU readback) stays as a heavier
  fallback only if needed.
- **Preset distribution** — ✅ resolved; see "Presets feature" above.

## Remaining risks

- **Scope check:** M1+M2 alone (two primitives + the two zero-new-code
  families) may already deliver enough value to stop and reassess before
  building the tier/line-span approximations for the other three.
- **Diffraction field fidelity:** the exact ring function is still an
  approximation target, not a guarantee (see fidelity divergences above).
