# Spline silhouette + per-spline fill (spec, 2026-07-05)

Fixes three gaps that show up in the **Copy to Points → (rect spline) → Rasterize
Spline** flow: overlapping copies can't be made opaque, can't be merged into one
silhouette, and can't be individually colored. Owner decisions (design Q&A
2026-07-05):

- **Dedicated nodes**, not one mega-node. New **Spline Merge** node handles the
  silhouette; per-spline color is added to **Rasterize Spline**.
- Silhouette must be a **true boolean union** — one clean outer stroke, no
  interior seams.
- Per-spline ramp fill offers **all three** index modes: by index, random
  (seeded), by group.

## The three problems (root cause)

1. **"X-ray" stacking.** [rasterize-spline.ts](../src/nodes/effect/rasterize-spline.ts)
   draws *all* fills, then *all* strokes in one combined pass
   (`drawSplineFill` loops subpaths → `drawSplineStroke` strokes them all at
   once). So every copy's outline floats above every fill; a later card's fill
   never occludes an earlier card's stroke. `stack_subpaths` only toggles
   per-subpath-union vs. even-odd holes on the *fill*; it never interleaves
   stroke with fill. → need a **layered/opaque** compositing mode.
2. **Union doesn't silhouette.** Spline Boolean is a two-input A/B op, but Copy
   to Points emits *one* spline with many subpaths (no B). And
   [engine/spline-boolean.ts `splineToGeom`](../src/engine/spline-boolean.ts)
   **XORs** a spline's own subpaths together (even-odd) before any op, so
   overlaps become holes/seams, never a merged region. → need a **self-union**
   that unions all subpaths of one spline.
3. **No per-spline color.** `drawSplineFill` uses one flat `fill_color` for every
   subpath, and Copy to Points copies from a *single* instance, so every output
   subpath shares one `groupIndex` — no per-copy handle to color by. → need
   per-subpath fill color driven by a `color_ramp`, indexed by the subpath's
   ordinal / a seeded hash / its groupIndex.

## Reused infrastructure

- **`color_ramp` param type** + `ColorRampStop` (`{id, position, color, alpha?}`)
  from [color-ramp.ts](../src/nodes/effect/color-ramp.ts). ParamPanel already
  renders `color_ramp` ([param-controls.tsx:2706](../src/lib/param-controls.tsx)).
  We sample it on the **CPU** (Canvas2D fills are CPU already) — a small
  `sampleColorRamp(stops, t, interp)` helper, mirroring the GLSL `sampleRamp`.
- **polygon-clipping** self-union in engine/spline-boolean.ts.
- `SplineSubpath.groupIndex`, `buildPath2D`/`hexToRgba` from
  [spline-raster.ts](../src/engine/spline-raster.ts).

---

## Node 1 — Spline Merge (new)

Single-input self-combine of a spline's subpaths into merged region(s). Primary
use: union overlapping copies from Copy to Points into one silhouette that
Rasterize Spline then fills + strokes with a single clean outline.

- **File:** `src/nodes/effect/spline-merge.ts`, registered in
  [src/nodes/index.ts](../src/nodes/index.ts).
- **category** `spline`, **subcategory** `modifier`. Engine-self-contained
  (invariant #1) — pure CPU geometry.
- **Inputs:** `path` (spline, required). *(No fill/stroke raster here — it stays
  a geometry node; wire its spline into Rasterize Spline to draw. Keeps
  single-responsibility, unlike Spline Boolean which carries a raster aux.)*
- **Primary output:** `spline`.
- **Params:**
  - `operation` enum `["union","intersect","exclude"]`, default `union`.
    - **union** — merged silhouette (the headline case).
    - **intersect** — region common to all subpaths.
    - **exclude** — even-odd XOR (today's `splineToGeom` behavior, exposed).
  - `resolution` scalar 3..96 (softMax 48), default 24 — curve flattening steps,
    same meaning as Spline Boolean.

### Engine change

Add to [engine/spline-boolean.ts](../src/engine/spline-boolean.ts) (it already
owns the ring/flatten/geom↔spline machinery):

```ts
export type SplineMergeOp = "union" | "intersect" | "exclude";

// Combine ALL subpaths of a single spline under one op. Unlike splineToGeom
// (which XORs subpaths for even-odd fill), this reduces the per-subpath rings
// with the chosen boolean so union yields a true merged silhouette.
export function splineSelfMerge(
  spline: SplineValue,
  op: SplineMergeOp,
  steps: number
): SplineValue
```

Implementation: build one `MultiPolygon` per subpath (each subpath ring →
`[ring]`), then reduce with `polygonClipping.union / intersection / xor`. Feed
the result through the existing `geomToSpline` (simplify + close). Guard
degenerate cases (0/1 subpath → tidy passthrough). Reuse `subpathToRing`,
`simplifyRing`, `geomToSpline`, `SCALE`.

**Caveat (documented, v1):** union treats every subpath as a solid region, so
holes inside a single instance (e.g. a letter "O") fill in. Acceptable for the
silhouette use-case; a future "respect even-odd within groups" refinement can
group by `groupIndex` before merging if it's ever wanted. Note it in the node
description.

---

## Node 2 — Rasterize Spline additions

Two new axes on the existing node. **Both default to today's behavior** so saved
projects are byte-identical (invariant #2).

### A. Overlap mode (fixes X-ray) — `overlap`

```
{ name: "overlap", label: "Overlap", type: "enum",
  options: ["flatten", "layered"], default: "flatten" }
```

- **flatten** (current): all fills, then all strokes on top. Strokes always
  visible ("x-ray"). Unchanged code path.
- **layered**: iterate subpaths in order; for each, fill *then* stroke before the
  next. A later copy's opaque fill occludes earlier copies' strokes → solid
  stacked cards. Respects Copy to Points' `draw_order` (its spline output is
  already emitted in draw order, so subpath array order == stack order).

`stack_subpaths` / `fill_rule` only apply in **flatten** mode (layered is
inherently per-subpath). Gate their `visibleIf` on `overlap !== "layered"`.

### B. Fill source (per-spline color) — `fill_source`

```
{ name: "fill_source", label: "Fill source", type: "enum",
  options: ["flat", "ramp"], default: "flat",
  visibleIf: p => p.enable_fill !== false }
```

- **flat** (current): single `fill_color`.
- **ramp**: each subpath gets a color sampled from a `color_ramp`, by `ramp_by`:

```
{ name: "fill_ramp", label: "Fill ramp", type: "color_ramp",
  default: [{id:"a",position:0,color:"#ffffff"},{id:"b",position:1,color:"#000000"}],
  visibleIf: p => p.enable_fill !== false && p.fill_source === "ramp" }

{ name: "ramp_by", label: "Ramp by", type: "enum",
  options: ["index", "random", "group"], default: "index",
  visibleIf: ... fill_source === "ramp" }

{ name: "ramp_seed", label: "Seed", type: "scalar", min:0, max:9999, step:1,
  default:0, visibleIf: ... ramp_by === "random" }

{ name: "ramp_interp", label: "Ramp interpolation", type: "enum",
  options: ["linear","ease","constant"], default:"linear",
  visibleIf: ... fill_source === "ramp" }
```

Per subpath `i` of `N`, sample factor `t`:
- **index** → `t = N > 1 ? i / (N - 1) : 0` (gradient sweeping across copies in
  draw order).
- **random** → `t = hash01(i, ramp_seed)` (seeded per-copy; reshuffle via seed).
  Reuse the same `hash01` as copy-to-points.
- **group** → `t = groupIndex → normalized over the distinct groups present`
  (distinct-sorted, like Copy to Points' `collectDistinctGroupIndices`; single
  distinct group → `t = 0`).

Then `color = sampleColorRamp(fill_ramp, t, ramp_interp)`, used as that subpath's
`c2d.fillStyle`. Works in both `flatten` and `layered` — but **layered** is what
makes overlaps read as distinct opaque cards (the intended combo).

### Precedence / interaction

- Wired **`fill` image** input still wins when present (unchanged): image fill >
  ramp > flat color. Ramp is a *flat-canvas* fill mode; if someone wires an image
  and picks ramp, the image path runs and ramp is ignored (document it).
- Ramp colors **fill only**; stroke keeps its single `stroke_color`. (Defaulted —
  a "stroke follows ramp" toggle is a cheap future add if wanted.)
- Extend the flat-path cache `sig` in `compute` with `overlap`, `fill_source`,
  `fill_ramp` (stringified stops), `ramp_by`, `ramp_seed`, `ramp_interp` so
  re-raster triggers correctly.

### New helper

`sampleColorRamp(stops: ColorRampStop[], t: number, interp): string` in a shared
engine spot (e.g. extend [spline-raster.ts](../src/engine/spline-raster.ts) or a
small `engine/color-ramp-sample.ts`) returning an rgba() string — CPU mirror of
the GLSL `sampleRamp` (sort stops, bracket `t`, lerp; ease=smoothstep,
constant=left stop; honor per-stop `alpha`). Keep it engine-side so it stays in
the export bundle (invariant #1). `ColorRampStop` currently lives in
`nodes/effect/color-ramp.ts`; move/re-export the interface engine-side (or
duplicate the tiny type) so the engine helper doesn't import from `nodes/` into
`engine/` in the wrong direction — put the shared type in engine.

---

## Target graph after this

```
Rectangle ─spline─▶ Copy to Points ─spline─▶ Spline Merge (union) ─spline─▶ Rasterize Spline
                    (scatter/copy)            = silhouette                    fill + single stroke

  …or skip Spline Merge and set Rasterize Spline overlap=layered,
     fill_source=ramp, ramp_by=random  → opaque per-copy colored cards
```

Both problems solved with composable nodes; the user picks silhouette (merge) or
stacked-colored-cards (layered + ramp) — or merge THEN ramp for a single
silhouette filled by one ramp color.

## Milestones

1. **Engine self-union.** `splineSelfMerge` + `SplineMergeOp` in
   engine/spline-boolean.ts. Verify union of overlapping rects → one ring;
   intersect/exclude sane. (Pure fn — easy to eyeball in isolation.)
2. **Spline Merge node** + registration + docs description. Wire
   Copy-to-Points → Spline Merge → Rasterize Spline, confirm clean silhouette
   with one outer stroke.
3. **Overlap mode** on Rasterize Spline (`flatten`/`layered`); gate
   `stack_subpaths`/`fill_rule` visibility. Confirm layered occludes strokes.
4. **`sampleColorRamp` helper** + move `ColorRampStop` engine-side.
5. **Fill-source ramp** params + per-subpath color loop; extend cache sig.
   Verify index/random/group all read right; seed reshuffles; interp modes.
6. Update [061226_devguide.md](061226_devguide.md): new node in the count/repo
   map, note the Rasterize Spline overlap+ramp modes and `splineSelfMerge` in the
   "Image fill for shapes" sharp-edge bullet.

## Back-compat / invariants

- New params default to current behavior; no schema bump (params are additive,
  `migrateLoadedParams` not needed). Spline Merge is a brand-new `type` string.
- Engine stays self-contained: all geometry + ramp sampling live under
  `src/engine`; nodes only orchestrate.
- Texture discipline in Rasterize Spline unchanged (still one baked canvas → one
  blit for the flat/ramp path; image-fill path untouched).

## Open (deferred, not blocking)

- "Stroke follows ramp" toggle.
- Spline Merge "respect even-odd holes within groups" (needs per-copy grouping;
  Copy to Points would have to tag copies with a per-copy index, which it doesn't
  today).
- Per-spline **random rotation/scale of color** or multi-ramp — out of scope.
