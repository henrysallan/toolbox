# Stipple performance — animated input + packed mode (snapshot 2026-06-16)

Focused optimization pass on the **one hot path that matters**: an animated
source (video / evolving noise) feeding `mode: "packed"`. Packed-flow and the
grid/screen modes benefit incidentally but are not the target.

## Why that path was slow

Per the audit, with an animated upstream the input fingerprint changes every
frame, so Stipple recomputes every frame, and `src.texture` is a fresh object
each frame so the relax result is always stale (`ensureRelaxedTargets`). With
the default `pointCount` of 4000 (< `GPU_RELAX_MIN_POINTS` = 6000) the bake
runs the **synchronous CPU path**, which every frame:

1. `readImageToFloat32(src)` — full-canvas `readPixels` GPU→CPU stall
   (~33 MB at 1080p). **Dominant cost.**
2. `scatterPoints` — rejection sampling into fresh `number[]`s.
3. `relaxPositionsCPU` — K iterations, each allocating a `Map<number,number[]>`
   + two `Float32Array(n)`.
4. `finalizePoints` — `n` fresh `RawPoint` objects; static path then `.map`s
   another `n`.
5. `buildCellData` — fresh `Float32Array(cells*4)`.

The render shader is GPU-parallel and not the bottleneck here.

## Milestone 1 (this change) — two parts

### 1. Downsampled density sampler + user resolution slider

Scatter/relax only ever sample density at ~cell granularity (packed is capped
at ≤1 dot/cell), so reading the whole canvas back is wasted bandwidth.

- New helper `readDensityField`: blit `src` into a small RGBA texture (held on
  state, reused, reallocated only on size change) with a trivial passthrough
  shader, then `readImageToFloat32` *that*. The pooled target is LINEAR so the
  blit is a real bilinear downsample. Orientation-preserving (sample + write +
  readback all in the same v_uv space), so point positions are unaffected.
- `ScatterArgs.imgW/imgH` are repurposed to the **sampler dimensions** — they
  were already used only as the density-buffer size, so every CPU consumer and
  the WGSL kernel pick this up unchanged. The GPU `src` upload shrinks by the
  same factor for free.
- New param **`samplerResolution`** (label "Sampler Resolution", 0.5–8, step
  0.1, default 2.0, visible for packed + packed-flow). It is a multiple of the
  grid: `sampW = clamp(round(cellsX * samplerResolution), 4, src.width)` (same
  for Y). At default 2× on 1080p/grid-120 that's ~426×240 ≈ 1.6 MB vs 33 MB
  (~20×); at 1× it's ~80×. Capped at source size, so a high slider value
  degrades gracefully to the legacy full-res read. Added to `bakeKey`.

Back-compat note: existing saved projects load with `samplerResolution = 2.0`,
so packed/flow density gets slightly coarser (and faster) by default. Visual
shift is minor; raise the slider to recover full-res sampling.

### 2. Kill per-frame allocations in the CPU bake

A persistent `BakeScratch` on node state (grown, never shrunk; mirrors the
WebGPU buffer policy) holds all working buffers:

- `scatterInto` writes into `scratch.xs/ys` (typed), returns count `n`.
- `relaxInto` replaces the per-iteration `Map` with a **flat CSR counting
  sort** (`cellCount` → prefix-sum `cellStart` → `order`), reusing persistent
  `dx/dy`. Candidate set and tie-break order are identical to the old Map path
  (ascending point index within ascending cell), so results are bit-identical
  to the previous CPU bake — and it still matches the WGSL kernel's converged
  field.
- `finalizeInto` reuses a pooled `RawPoint[]` (objects mutated in place,
  `length` set to `n`) instead of allocating `n` objects.
- `fillCellDataStatic` writes the static-packed cell texture into a persistent
  `scratch.cellData`, dropping the `.map` + the fresh `Float32Array`.

The async **GPU path keeps allocating** (its `finalizePoints` runs in a
deferred callback; pooling across async is unsafe) — but it shares the
downsampled `readDensityField`, so its readback + upload shrink too. Scatter is
synchronous, so both paths use `scatterInto`.

Packed-flow shares `ensureRelaxedTargets`, so it inherits the downsample + CSR
relax. Its own `stepFlowDots` / `buildCellData(flowDots)` allocations are out of
scope for M1.

## Not in M1 (deferred)

- Render side: dynamic neighborhood radius (3×3 vs fixed 5×5) or instanced
  point sprites. Only matters at high resolution once the CPU side is fixed.
- GPU-resident scatter+sim. Cheap to revisit later *because* the downsample
  makes the source hop tiny — but unnecessary for the 4000-point default.
- Bake-cadence throttle (rebake at N Hz, render at 60).

## Verify

Feed a video or evolving-noise source into Stipple, set mode = packed. Confirm
the preview is materially smoother and the `samplerResolution` slider trades
visible density fidelity for speed. Check packed-flow and grid/screen still
render correctly.
