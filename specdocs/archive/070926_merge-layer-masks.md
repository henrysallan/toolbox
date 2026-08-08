# Merge per-layer masks + spline→mask coercion (2026-07-09)

Two related changes that make "use a shape as a matte" a first-class wire:

1. **Spline → mask coercion.** A spline output (Rectangle, Circle, Spline
   Draw, any spline chain) now wires directly into ANY mask socket. The
   coercion rasterizes the shape's **filled silhouette** — even-odd fill,
   open subpaths closed for fill, aspect-corrected, canvas-sized — via the
   shared `buildPath2D`, uploads it once, and identity-caches the resulting
   `MaskValue` per `SplineValue` (a cache-hit upstream returns the same
   object, so a static shape pays the canvas fill + upload once; an animated
   spline re-rasterizes per recompute, same cost profile as Rasterize
   Spline). This is what makes "pipe a rectangle primitive into the mask
   input on an Image Source" work without routing through the primitive's
   raster aux output — and independent of its stroke/fill styling (the old
   image→mask route reads luminance×alpha, so a dark fill mattes dim; the
   silhouette doesn't care).

2. **Merge: per-layer mask inputs, universal mask removed.** Merge now
   declares `noMaskInput` and instead shows a `mask`-typed input underneath
   **every image input**: `mask:base` ("base mask") under `base`, and
   `mask:<layerId>` ("mask N") under each `layer:<layerId>`. Each mask is
   the matte for that layer of the merge.

## Matte semantics

A layer matte multiplies into the layer's **effective alpha** exactly like a
per-pixel opacity slider: `srcA = b.a * u_opacity * matte` in BLEND_FS. RGB
is untouched (straight-alpha convention; blend modes keep reading the
un-matted layer color, the same way the opacity slider already worked). The
base matte is a pre-pass (`merge/matte-blit`, `c.a *= m`) that seeds the
blend chain — or draws straight into the output on the no-layers path.

Uniform detail: `u_hasMatte` defaults to 0, so the **Layer node** — which
shares BLEND_FS for its stack compositing and never sets the new uniforms —
keeps its exact behavior. The shared shader key was bumped
(`merge/blend` → `merge/blend-v2`, in both merge.ts and layer.ts) because
`getShader` caches by key alone and a hot-reloading dev session would
otherwise be served the pre-matte program.

## Back-compat (schema v7)

The old universal mask on Merge blended `mix(base, merged, m)`. Under
source-over that is pixel-identical to matting **every layer** by `m` while
the base stays un-matted:

    mix(base, srcover(base, layer), m) == srcover(base, layer·m)

So `deserializeGraph` fans a ≤v6 Merge's `in:mask` edge out into one
`in:mask:<layerId>` edge per layer (ids `<edgeId>::mask<i>`); the base mask
is left unwired. A zero-layer Merge's mask edge just drops (it had no visual
effect — the merged output WAS the base). Non-merge `in:mask` edges (the
universal matte on every other node) are untouched. `CURRENT_SCHEMA = 7`.

Equivalence is exact for `normal`; for other blend modes it matches the old
behavior in the same way the opacity slider always has (alpha-only scaling).

## Files touched

- `src/engine/coerce.ts` — spline→mask (`splineToMask`, WeakMap cache,
  scratch canvas on ctx.state, flip-Y + `r*a` coverage upload shader).
- `src/components/effects/NodeEditor.tsx` — `canCoerce` + `isValidConnection`
  allow spline→mask (shift-drop fuzzy connect inherits it).
- `src/engine/graph-validation.ts` — `coercible` allows spline→mask (AI
  recipe validation).
- `src/nodes/effect/merge.ts` — noMaskInput; interleaved mask sockets in
  `inputs`/`resolveInputs`; MATTE_BLIT_FS; u_matte/u_hasMatte in BLEND_FS;
  per-layer matte + base-matte pre-pass in compute.
- `src/nodes/group/layer.ts` — shared blend shader key bump only.
- `src/lib/project.ts` — schema v7 + fan-out migration.
- `src/lib/ai/recipe-prompt.ts` — coercion lists + universal-mask caveat.

Nothing else needed: every UI path (node spawn, load, param change, merge's
`+` button, auto-merge, shelf tools) re-derives sockets from
`resolveInputs(params)`, and the generic stale-edge pruner in EffectsApp
drops a removed layer's mask edge when its socket disappears. Mask sockets
fingerprint like any input, so caching busts correctly.

## Verified

- `tsc --noEmit` and eslint clean (NodeEditor's 9 react-hooks/refs errors
  pre-exist).
- Node-side check: `resolveInputs` emits base / base mask / layer 1 /
  mask 1 / layer 2 / mask 2 in order; `coercible("spline","mask")` true.
- Migration fan-out logic exercised against multi-merge / zero-layer /
  non-merge cases.
- Manual browser QA still to do (no test runner): rectangle→Image Source
  mask cutout; per-layer merge mattes incl. base mask; a ≤v6 save with a
  Merge universal mask loads with equivalent output; Layer-node stacks
  render unchanged.
