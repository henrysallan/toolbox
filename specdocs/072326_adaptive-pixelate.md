# Adaptive Pixelate — non-constant pixel grids (spec, 2026-07-23)

> **Status: implemented** (same day) — all three milestones landed in
> `src/nodes/effect/adaptive-pixelate.ts`. Deviations from the plan below:
> **lattice** doesn't share the finest-grid cell-rect texture (its CDF cuts
> aren't aligned to finest-grid texels, so that lookup would misassign
> boundary pixels) — instead cuts round to integer px and upload as two
> per-canvas-pixel axis LUTs (W×1 + H×1 RGBA32F: center + size per axis),
> which makes the pixel-granularity lookup exact; `sample` is always
> visible (not quadtree-only); and the `size` param serves uniform mode
> while `block_min`/`block_max` serve the other two. Point scale semantics
> shipped as proposed (relative to `block_max`) — flag if that should
> change before this sees real projects.

A new image-modifier node, **Adaptive Pixelate** (`adaptive-pixelate`), for
building pixellation *systems* rather than one fixed mosaic: the pixel grid
itself is non-constant, with block size driven by a luminance map — either a
separate wired map input or the source's own luminance. The existing
`pixelate` node is untouched (uniform grid, shipped type string — back-compat
invariant #2); this node supersedes it for new work and includes its uniform
grid as the trivial baseline mode.

Design decisions locked with the owner (Q&A 2026-07-23):

- **Three grid modes in one node**: `uniform` | `quadtree` | `lattice`.
- **Points aux output** (block centers + scale + level tag) — the
  system-building hook into Copy-to-Points / Point Expression / simulators.
- **Minimal in-node styling**: clean block sampling only (center vs.
  area-average). No gaps/shapes/palettes — styling happens downstream via the
  points output or ordinary image nodes.

## Node surface

```
Adaptive Pixelate  (image / modifier, webgl2)
inputs:
  image     image, required     — the source to pixelate
  size_map  mask, optional      — luminance driver for block size.
                                  mask-typed so images coerce in as
                                  luminance × alpha and splines coerce as
                                  their filled silhouette (wire a Circle
                                  straight in). Unwired → the source
                                  image's own luminance drives size.
  (+ universal mask input — evaluator-applied; image input present, so it
   BLENDS the effect over the source. + universal opacity param.)
params:
  mode         enum uniform|quadtree|lattice, default quadtree,
               headerControl (dropdown on the node header)
  size         scalar px, 2..256 softMax 64, default 16    [visibleIf uniform]
  block_min    scalar px, 2..128 softMax 32, default 8     [visibleIf !uniform]
  block_max    scalar px, 8..512 softMax 128, default 64   [visibleIf !uniform]
  invert       bool, default false  — bright drives SMALL blocks (detail);
               invert → bright drives large
  gamma        scalar 0.25..4, default 1 — driver response curve
  sample       enum center|average, default center — block color from the
               block's center texel vs. its area average
  lattice_axes enum both|columns|rows, default both       [visibleIf lattice]
  opacity      (OPACITY_PARAM)
outputs:
  primary  image  — the pixelated image
  aux      points — one point per cell (see contract below)
```

Driver → size mapping (shared by quadtree + lattice; the one formula both the
GPU pass and the CPU grid builder use):

```
d = per-cell average of driver (0..1)
t = pow(invert ? 1-d : d, gamma)
desiredSize = mix(block_max, block_min, t)      // bright → fine by default
```

Quadtree subdivision rule: split a cell (size `s`, level `L`) into 4 while
`desiredSize(d_cell) < s && L < levels`, where
`levels = clamp(ceil(log2(block_max / block_min)), 1, 8)` and the coarsest
cell is `block_max` px (so `block_min` is the subdivision *limit*; the actual
finest cell is `block_max / 2^levels`). The decision at each level uses the
driver **averaged over that cell**, so the grid is coherent — no seams.

Lattice rule: importance-sample the grid lines from the driver's row/column
profiles. `density(x) = 1 / desiredSize(colAvg(x))`; total columns
`N = round(∫ density dx)`; line positions at the inverse CDF of `i/N`
(clamped so no cell is under `block_min` or over `block_max`). Same for rows.
`lattice_axes` drops one axis (columns-only = variable vertical strips —
scanline systems).

## Architecture: CPU-authoritative grid

The naive per-pixel approach (each fragment reads the map and picks its own
cell size) tears at size boundaries — rejected in the Q&A. And a pure-GPU
quadtree walk (mip pyramid + per-fragment level descent) would need a second,
CPU-side reimplementation of the same subdivision logic to build the points
output, with float-rounding divergence between the two producing
point/image mismatches on threshold cells. Instead **one CPU grid is the
single authority for both outputs**:

1. **Driver build (GPU)** — one pass renders the driver at *finest-grid
   resolution* (`ceil(canvas / finestCell)` texels; each texel = box average
   of its cell footprint). Source: the coerced `size_map` mask texture, or,
   unwired, luminance × alpha of the source image (matching the image→mask
   coercion convention). Sub-sized pool alloc (`allocImage({width,height})`).
2. **Readback (CPU)** — `ctx.readImagePixels` on that small target. Typical
   cost: 1080p at default params → 480×270 texels (~0.5MB); this is the
   per-recompute stall and it's the whole reason the driver is reduced on the
   GPU first. Static drivers cost nothing after the first eval (normal
   fingerprint caching); video/webcam drivers pay it per frame like every
   other readback-consuming node (image-mask colliders, image→scalar).
3. **Grid build (CPU, pure)** — box-reduce the readback into a pyramid
   (quadtree), or sum row/col profiles + CDF (lattice), or nothing (uniform);
   emit the cell list `{x, y, w, h, level}` in px. Pure function → unit-testable
   when a runner lands; keep it in the node file or a small
   `engine/adaptive-grid.ts` if it grows.
4. **Cell-index upload (GPU)** — pack the grid into an RGBA32F texture at
   finest-grid resolution: each texel stores the rect (center x, center y,
   w, h in px) of the cell covering it. Quadtree/lattice/uniform cells are all
   unions of finest-grid texels, so this lookup is exact. Private texture in
   `ctx.state` (NEAREST, no pool — pool textures are RGBA16F canvas-sized).
5. **Image pass (GPU)** — one fullscreen pass: `texelFetch` the cell rect →
   sample the source at the cell center (`sample: center`), or
   `textureLod(mippedSource, center, log2(cellSize))` (`sample: average`).
   Average mode keeps a private mipmapped copy of the source
   (copy pass + `generateMipmap` per recompute; RGBA16F is filterable +
   renderable in WebGL2 so this is legal, and mip-approximate box average is
   visually right).
6. **Points build (CPU)** — same cell list → `makePoints`.

Y-flip note (convention #4): the CPU grid is computed in y-down normalized
space like all CPU geometry; the readback rows and the cell-index texture
sampling flip at the GL boundary exactly once — follow the
marching-squares readback precedent.

## Points contract

Built with `makePoints(count, {withScales, withGroupIndices})`:

- `positions` — cell centers, normalized [0,1]², **y-down** (CPU convention).
- `scales` — `sx = w / block_max`, `sy = h / block_max` (uniform mode:
  `/ size`, so always 1). Rationale: size a Copy-to-Points instance to match
  a coarsest block once; finer cells scale down proportionally, and
  animating `block_max` rescales the whole system coherently. **Open
  question for owner**: is relative-to-coarsest right, or should scales be
  canvas-width fractions? Cheap to change pre-ship, breaking after.
- `groupIndices` — quadtree: subdivision level (0 = coarsest); uniform /
  lattice: 0. Group Pick / ramp-by-group then styles per detail level free.
- No color attribute (PointsValue has none) — the graph idiom for colored
  systems is `aux points → Sample Texture at Points ← primary image`.

**Points are built unconditionally, NOT gated on `consumedOutputs`.** This
node caches (it is not `stable:false`), and consumption is not part of the
fingerprint — a cache entry built while points were unconsumed would serve
empty points forever once wired (the loop-weave lesson, 072226 audit #5;
advect-points trails precedent). The cost is acceptable because the grid is
already CPU-side for the image pass — points are a free byproduct.

## Caching, state, conventions

- Standard fingerprint caching — pure function of inputs + params. No
  `stable:false`, no `fingerprintExtras`. An animated driver re-fingerprints
  through its input; a static graph caches as a constant.
- Private GL objects (cell-index texture, mipped source copy) live in
  `ctx.state["adaptive-pixelate:<nodeId>"]`, reallocated only on dimension
  change, deleted in `dispose`. Pool leases (driver target, output) follow
  texture discipline #3: release intermediates before returning, never
  inputs.
- Universal mask blends (image input present), universal opacity applies —
  nothing implemented node-side (invariant #6).
- Empty/missing image input → transparent clear + empty points, same shape
  as the old pixelate.
- Degenerate sizes clamp: `block_max ≤ min(canvas w, h)`, `block_min <
  block_max` (panel `linkedPairs` not needed; clamp in compute).

## Costs & future work (non-blocking)

- Worst case scales with finest-grid area: `block_min: 2` at 4K →
  ~1920×1080 readback + RGBA32F upload per recompute (~16MB/frame). Fine
  paused/static; heavy for video at extreme settings. Future escape hatch if
  profiling demands: a pure-GPU pyramid-walk image path used only when the
  points output is unwired (needs the consumedOutputs/caching story solved —
  see above — so explicitly out of scope now).
- Temporal stability: a video-driven quadtree flickers where cell averages
  cross the subdivide threshold. Future: hysteresis / driver temporal
  smoothing (needs feedback state). Note in docs; workaround today is a
  Gaussian Blur on the size map.
- Grid offset/scroll param (animated mosaics), cell aspect: deliberately cut
  from v1 (minimal-styling decision). Old Pixelate keeps its `aspect`.
- Conway/Game-of-Life-style cellular systems (devlist #~570) could later
  consume the lattice via the points output — no coupling now.

## Milestones

- **M1 — core node**: node file + registration; `uniform` + `quadtree` modes
  end-to-end (driver pass → readback → CPU grid → cell-index upload → image
  pass, center sampling); mapping params (invert/gamma/min/max); universal
  conventions verified (mask blend, opacity, bypass). Manual browser check
  incl. a video-driven size map.
- **M2 — lattice + average**: lattice mode (profiles → CDF → lines,
  `lattice_axes`); `sample: average` (mipped copy + textureLod); clamps +
  degenerate-input hardening.
- **M3 — points + ship**: points aux per the contract (unconditional build,
  scale/groupIndex semantics settled with owner); docs description; devguide
  + devlist updates; `npm run typecheck` + `npm run check` + lint ratchet.
