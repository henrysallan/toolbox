# Wedge node — batch renders with swapped values (2026-07-10)

Goal: hit Render once and get N renders of the same tree, with designated
values swapped between iterations — a seed driving three noises, a Switch
index, a brand color, a text string — each render saved under an iterated
filename. Houdini calls this **wedging**; we adopt the name.

The Render Queue already batches *different Outputs*. This feature batches
*variations of one tree*, and composes with the queue (a queue row whose
Output has wedges upstream renders all its variations).

## Why a node (and not an override table)

There are only two ways a batch driver can reach a value on the left side
of the tree: flow the value through a wire, or write params out-of-band by
`nodeId`+`paramName` reference. We choose the wire:

- Exposed-param sockets + wire > keyframe > stored precedence already
  exist — a wedge value lands anywhere a wire can.
- Fingerprints invalidate exactly the branches downstream of the wedge;
  everything else stays cached across all N iterations for free.
- The sweep is visible on the canvas (no invisible per-render mutations),
  and auditioning variation 7 is just scrubbing a param.
- Param references dangle when nodes are deleted; wires heal/disconnect
  with existing machinery.

A per-row override table on the Render Queue (vary arbitrary params per
row without wires) remains a possible later addition; explicitly out of
scope here.

## The Wedge node

`type: "wedge"`, category `utility`, `src/nodes/source/wedge.ts`. No
inputs (`noMaskInput`), primary output only, retyped by the `type` param
(same pattern as Switch; `headerControl` on `type`).

Params:

- `type` enum: **scalar / color / vec2 / string** — output socket type via
  `paramSocketType` (color → vec4). Covers seeds/indices (scalar), palette
  sweeps (color), positions (vec2), copy variants (string → Text's `text`).
  vec3/vec4 are trivial follow-ons if ever needed.
- `mode` (scalar only; other types are always `values`):
  - `values` (default) — explicit list, the new `wedge_values` param type.
  - `range` — `start` + `step` × `count`.
  - `random` — `count`, `min`, `max`, `seed`; values come from a
    deterministic hash of (seed, index) (triple32, same primitive as Point
    Expression's `rand`) so variation i is stable across sessions/machines.
  - `index` — emits the iteration index itself (count param only). This is
    the "just give me `i`" mode for Switch indices and Math-derived seeds.
- `preview` — integer scalar, clamped to count−1. The value emitted
  whenever no batch is running (editor, live viewer, exported apps).
  Scrubbing it auditions variations live on the preview canvas.
- `enabled` boolean (default on) — off ⇒ the node reports count 1 to the
  batch driver and always emits the preview value. This is "render just
  this variation" without unwiring anything.

`compute`: `effectiveIndex = clamp(ctx.wedgeIndex ?? preview, 0, count−1)`
→ resolve the value for the active mode. Pure CPU, no GL.

Caching: the node is **not** `stable:false`. Params (preview, values, …)
are already in the fingerprint; the only external input is
`ctx.wedgeIndex`, folded in via `fingerprintExtras` → `wedge:<effectiveIndex>`.
Within one variation the node caches as a constant; between variations
exactly the downstream branches recompute.

### `wedge_values` param type

Typed list editor in ParamPanel: add / remove / reorder rows; row editor
per `type` (number field, color swatch, vec2 pair, text field — reuse the
controls in param-controls.tsx; the type-driven row pattern exists in
`expr_inputs`). Plain-JSON serialization (scalars, RGBA tuples, vec2
tuples, strings) — no media envelope, no schema bump (new node type +
param type only, no wire-shape change). Not keyframable, no virtual keys,
no exported-app control support in v1. Ripple checklist from the devguide
"new ParamType" recipe applies (types.ts union → ParamPanel renderer →
`isKeyframable` no → export-manifest no → serialization plain JSON).

## Engine plumbing

- `RenderContext.wedgeIndex?: number` (types.ts) + a trailing optional
  param on `makeContext` (gl.ts). Undefined everywhere except inside a
  batch export loop — editor preview, live viewer, and exported apps all
  fall through to `preview`.
- EffectsApp holds a `wedgeIndexRef` (mirroring `offlineRenderingRef`)
  threaded into the single `renderFrame` ctx construction
  (EffectsApp ~line 1407). All exporters already drive frames through that
  path, so the plumbing is one ref + one argument.

## Batch semantics (zip, last value holds)

- `resolveWedges(outputNodeId)`: `flattenGraph` (so wedges inside groups /
  layer interiors and wires into exposed params are all plain edges), then
  reverse reachability from the Output — the same walk as
  `computeNeededSet`. Collect reachable, enabled wedge nodes.
- `batchCount = max(counts)` over those wedges (1 if none). **Zipped, not
  Cartesian**: iteration v gives every wedge index v; a wedge whose own
  count is smaller clamps — its **last value repeats** for the remaining
  iterations. (Wedge A: 3 values, wedge B: 4 ⇒ 4 renders; A's third value
  holds for render 4.) No product mode — deliberately; it can be a later
  `combine` option if ever justified.
- The loop wraps the existing single-render paths unchanged: for
  v in 0..batchCount−1 → set `wedgeIndexRef` → run the existing exporter
  (`exportVideo` / `renderImageToBlobAtFrame` / `exportSequence` /
  `exportGif`) → resolve filename tokens → deliver. `finally` restores
  `wedgeIndexRef = undefined`.
- The eval cache is *not* cleared between iterations — wedge-independent
  branches (the video layer, the static background) render once and stay
  hot for the whole batch. This is a headline perf property; don't break it.

## Filename tokens

Resolved by a shared helper (new `src/lib/export-naming.ts`), applied to
the Output's `filename` param at delivery time in every export path:

- `{i}` — iteration index, 0-based. `{i:3}` — zero-padded to width 3.
- `{wedge}` — the first wedge's current value; `{wedge:Name}` — the value
  of the wedge node whose display name matches (sanitized,
  case-insensitive). Stringification: scalar with trimmed decimals, color
  as hex, vec2 as `x-y`, string sanitized via `sanitizeFilename`.
- No token present and batchCount > 1 ⇒ auto-append `_{i:3}` so batches
  never fall back to the `-2` de-dupe suffix.
- Tokens are inert-but-valid in single renders (i = 0), and apply to the
  sequence-export base name (frame numbers append after, as today).

## Driver integration

- **Standalone Export (any Output)** — yes, not queue-only. When
  `resolveWedges` finds wedges, the Export panel shows "renders N
  variations" and the existing delivery machinery covers fan-out: reuse
  the `seqDelivery`-style choices (sequential downloads / zip / folder)
  for any batched export, not just sequences.
- **Render Queue** — each row resolves its own Output's wedges and renders
  count files into the batch; row shows a ×N badge; the queue's existing
  `delivery` collects everything. `queueProgress` gains a variation
  dimension ("item 2/3 · variation 5/12"); the recording banner likewise
  shows "variation v+1/N" during offline encodes.
- Cancel paths restore `wedgeIndexRef` and report partial delivery like
  the queue's `skipped` list does today.
- History hygiene: the driver never writes node params — the value arrives
  via ctx — so undo/redo and the saved graph are untouched by a batch run.

## Nice free consequences

- Scrubbing `preview` in the panel = live variation audition.
- `preview` can be marked user-controllable later → exported apps get a
  variation scrubber for free (out of scope v1, but nothing blocks it).
- Wedge → Switch (`index` socket) muxes *any* switchable type (images,
  points, splines) through a scalar wedge — many-data-types coverage
  beyond the wedge's own output types.

## Milestones

1. **Node + plumbing.** `wedge_values` param type (types.ts union), wedge
   node def with scalar `values`/`index` modes + `preview` + `enabled`,
   `ctx.wedgeIndex` + `makeContext` arg + `fingerprintExtras`, ParamPanel
   list editor (scalar rows), register node. Verify: scrub preview drives
   a seed live; caching busts correctly.
2. **Batch driver, standalone Export.** `resolveWedges`, the iteration
   loop around exportImage/exportVideo, filename tokens
   (export-naming.ts), progress + cancel, delivery reuse. Verify: one
   Output, seed wedge ×5 → 5 correctly-named files; static branch renders
   once (timings).
3. **Render Queue + remaining exporters.** Queue rows × variations,
   progress dims, exportSequence/exportGif coverage.
4. **Value types + modes.** color / vec2 / string rows, `range` /
   `random` modes, `{wedge:Name}` tokens, Export-panel "N variations"
   readout, ×N queue badge.
5. **Docs + devguide.** In-app docs page for the node; devguide section
   (batch/wedge rendering + the ctx.wedgeIndex invariant note).

## Status (2026-07-10 — all milestones landed)

M1–M5 are implemented. Where things live:

- `src/nodes/source/wedge.ts` — the node. `type` (scalar / color / vec2 /
  string, header dropdown, retypes the output via `resolvePrimaryOutput`);
  scalar gets `values`/`range`/`random`/`index` modes, other types are
  always value lists; `preview`, `enabled`, fingerprintExtras on the
  clamped effective index. Exports `wedgeIterationCount` / `wedgeValueAt` /
  `wedgeTokenValue` for the drivers.
- `src/engine/types.ts` + `gl.ts` — `wedge_values` ParamType,
  `WedgeValueItem`, `ctx.wedgeIndex` (+ `makeContext` arg).
- `src/lib/wedge-batch.ts` — `resolveWedgeBatchInfo`: the shared flatten +
  reverse-BFS resolver (count + reachable wedges), used by the export
  drivers AND the UI readouts; fast-paths to count 1 when the graph has no
  wedges.
- `src/lib/export-naming.ts` — `{i}` / `{i:N}` / `{wedge}` /
  `{wedge:Name}` tokens, `_{i:3}` auto-append, `stripWedgeTokens` for the
  sequence zip name. Token values sanitized. Unit-tested (scratch
  harnesses, ~45 assertions).
- `src/lib/param-controls.tsx` — `wedge_values` row editor keyed by the
  sibling `type` param (number / color swatch / vec2 pair / text rows;
  scalar add-button extrapolates the last delta).
- `EffectsApp.tsx` — `wedgeIndexRef` → renderFrame ctx; `exportWedged`
  (standalone image/video), wedge loops inside `exportSequence` (single
  shared zip/folder across variations), `exportGif` (one GIF per
  variation), and `renderQueue` (rows × variations, queue progress shows
  "name · 5/12", toast counts files); `exportVideo` gained `labelPrefix`
  ("Variation 2/5 — Encoding…").
- `ParamPanel.tsx` — `OutputWedgeReadout` ("Export renders N wedge
  variations" pill on Output nodes) + ×N badge on Render Queue rows.
- Docs: the node self-documents on the auto-generated Utility Nodes page;
  devguide has a "Wedge batch rendering" bullet under Export.

Accepted caveats:

- **Standalone image/video batch delivery is sequential downloads** (the
  queue's default) — route through a Render Queue for zip/folder.
  Sequence batches DO share one zip/folder.
- **Batched videos always use the wasm encoder** — the native-ffmpeg path
  requires a Save dialog per file (`!opts.sink` gate), same limitation the
  Render Queue already has.
- **Layer Output exports don't batch**: the fixed group-output id
  dissolves in the flatten pass, so `resolveWedgeBatch` sees count 1 and
  falls through to the plain single render.
- The AI-recipe catalog treats `wedge_values` as placeable-not-settable
  (same class as merge_layers/expr_inputs).

## Out of scope

- Per-row param override tables on the Render Queue (option C from the
  design discussion).
- Cartesian-product combine mode.
- Wedging graph *structure* (different wirings per variation) — use
  Switch.
- Headless/CLI batch rendering (the manifest-shaped batch is a natural
  future seed for it).
- Exported-app variation controls (noted above; trivial later).
