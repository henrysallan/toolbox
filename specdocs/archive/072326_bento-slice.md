# Bento Slice — sliced-image assemble/split animation (spec, 2026-07-23)

A new image-modifier node, **Bento Slice** (`bento-slice`): slice the source
image into bento-box rectangles by recursive binary subdivision (split depth
driven by a luminance map), then offset every piece along a per-piece scatter
vector by a single **fac** scalar — animate fac and the image splits apart /
assembles. A stepped mode makes each piece travel an axis-aligned staircase
(2-step: slide in horizontally, then drop vertically into place), with one
easing curve applied to every leg.

Sibling of Adaptive Pixelate (072326_adaptive-pixelate.md) — same
CPU-authoritative-grid architecture, same driver conventions — but the render
is a scatter of moving instanced quads (Copy-to-Points precedent), not a
fullscreen cell-lookup pass, and the slicing is **binary bento cuts**
(varied rectangles), not a quadtree.

Design decisions locked with the owner (Q&A 2026-07-23):

- **Bento binary splits** — recursive alternating/longest-axis H/V cuts with
  jittered cut positions; the luminance map drives split depth. Not quadtree.
- **Per-piece random scatter** — seeded random direction (+ magnitude jitter)
  per piece; pieces converge from all sides.
- **N-step zigzag, 1–8** — steps alternate axes (axis-order toggle);
  1 = straight diagonal slide.
- **One easing dropdown** applied to every step (reusing the keyframe easing
  catalog), per the smoothstep a→b then b→c example.

## Node surface

```
Bento Slice  (image / modifier, webgl2)
inputs:
  image     image, required     — the source to slice
  size_map  mask, optional      — luminance driver for piece size (images
                                  coerce in as luminance × alpha, splines as
                                  their filled silhouette). Unwired → the
                                  source image's own luminance.
  (+ universal mask input — image input present, so it BLENDS the effect over
   the source. + universal opacity param.)
params:
  fac        scalar 0..1, default 0 — 0 = assembled (source image, modulo
             gap), 1 = fully scattered. THE animation input; keyframe or
             expose it.
  piece_min  scalar px 8..256 softMax 64, default 24 — split limit; no piece
             edge goes below this
  piece_max  scalar px 32..1024 softMax 512, default 256 — pieces larger than
             this always split (baseline subdivision)
  invert     bool, default false — bright drives SMALL pieces (detail);
             invert → bright drives large
  gamma      scalar 0.25..4, default 1 — driver response curve
  cut_jitter scalar 0..1, default 0.35 — 0: every cut at the center of the
             split axis; 1: cuts land anywhere in the 25–75% band
  seed       scalar int, default 0 — cut positions + scatter directions
  gap        scalar px 0..64, default 0 — shrink every piece symmetrically
             (bento gutters; visible at fac = 0 too, default keeps fac = 0
             byte-equal to the source)
  distance   scalar 0..2 softMax 1, default 0.75 — scatter travel, canvas-
             WIDTH fraction (stroke-units % convention)
  distance_jitter scalar 0..1, default 0.5 — per-piece random travel variation
  steps      scalar int 1..8, default 2 — staircase leg count; 1 = straight
             diagonal slide
  first_axis enum horizontal|vertical, default horizontal
             [visibleIf steps > 1] — which axis the ASSEMBLY travels first
             ("slides in from left, then drops" = horizontal)
  easing     enum, default in-out-sine — friendly option strings
             ("linear", "in-sine", …, "out-bounce", "out-elastic", "hold")
             mapped node-side onto the keyframe EasingPreset catalog
             (everything except customBezier). Applied to every leg. `hold`
             = pieces teleport leg-by-leg (deliberate; see math). Visible at
             steps = 1 too (the straight slide is eased).
  opacity    (OPACITY_PARAM)
outputs:
  primary  image  — pieces drawn at their fac-animated positions over
                    transparency
  aux      points — one point per piece at its CURRENT (animated) center
```

## Slicing: binary bento subdivision (CPU-authoritative)

Same authority argument as Adaptive Pixelate: one CPU cell list drives both
the draw and the points aux, so they can never disagree.

1. **Driver reduce (GPU, shared)** — Adaptive Pixelate's two-pass box reduce
   (`DRIVER_H_FS`/`DRIVER_V_FS` + `readDriver`) moves to
   `engine/driver-reduce.ts` and both nodes import it (devguide: shared
   helpers live engine-side). Bento reduces the driver to a uniform analysis
   grid: `analysisPx = max(2, piece_min / 4)`, grid `ceil(canvas /
   analysisPx)`, capped at 1M texels by doubling `analysisPx`.
2. **Readback + SAT (CPU)** — one `readImagePixels` on the small grid, then a
   summed-area table so any rect's driver average is O(1).
3. **Subdivision (CPU, pure)** — root = full canvas; recurse:
   - `d` = SAT average over the cell; `desired = mix(piece_max, piece_min,
     pow(invert ? 1-d : d, gamma))` (identical mapping to Adaptive Pixelate).
   - Split while `max(w, h) > desired`, and always while `max(w, h) >
     piece_max`. Depth cap 16.
   - Split axis = the longer side (ties → seeded coin flip).
   - Cut fraction `c = 0.5 + 0.25 * cut_jitter * (2·rand − 1)`, clamped to
     the band that keeps both children ≥ `piece_min` on the split axis; if
     that band is empty the axis can't split (and if neither axis can, emit).
   - `rand` = engine hash01 of (quantized cell center, depth, seed) — cuts
     are deterministic per seed and stable-ish under param nudges.
   - Emit `{x, y, w, h, depth}` px, y-down.

Worst case ≈ (W/piece_min)·(H/piece_min) pieces — 1080p at default ≈ ≤3.6k,
fine for one instanced draw and per-eval CPU offset math.

**Grid caching:** the node caches normally (no `stable:false`), but fac
animates per frame, so the grid must not rebuild per fac tick. Internal
signature cache in `ctx.state` (text.ts precedent): rebuild the cell list +
scatter vectors only when the driver input's value-object identity or a
layout-param signature (piece_min/max, invert, gamma, cut_jitter, seed,
canvas dims, size_map wired-ness) changes. Fac/steps/easing/distance changes
reuse the grid and recompute offsets only (cheap). Video-driven size maps
re-slice per frame — same temporal-flicker caveat as Adaptive Pixelate;
workaround is a static/blurred map.

## Scatter + stepped-assembly math (CPU, per piece, per eval)

Scatter vector at fac = 1, px y-down:

```
θ = TAU · hash01(center, seed, "dir")
mag = distance · canvasW · (1 − distance_jitter · hash01(center, seed, "mag"))
S = (cos θ, sin θ) · mag
```

Assembly progress `a = 1 − fac`. The piece travels scattered → home along
`steps` legs. `steps = 1`: one straight leg `−S`. `steps = N ≥ 2`: legs
alternate axes starting with `first_axis` (in assembly order, so the LAST leg
is the other axis — 2-step horizontal-first = slide in sideways, then drop
into place); the H legs each cover `−Sx / nH`, the V legs `−Sy / nV`
(`nH = ceil/floor(N/2)` by first_axis).

Fac domain cut into N equal sub-ranges. For leg k at local
`u = a·N − k ∈ [0,1]`:

```
pos = home + S + Σ(legs < k) + easeOf(easing, u) · leg_k
```

Completed legs contribute fully, so `hold` (easeOf → 0 mid-leg) degenerates
to a leg-by-leg teleport — kept deliberately as a stylized stagger-snap.
Back/elastic overshoot works naturally (u can map outside [0,1] travel —
pieces overshoot their leg and settle).

The per-eval cost is a few ops × piece count; easing runs through the
engine's `easeOf` so motion matches keyframe easing exactly (no GLSL port,
no divergence).

## Render: instanced quad scatter

Copy-to-Points' pattern (private program + VAO + FBO + RGBA32F data texture
in `ctx.state`, straight-alpha source-over `blendFuncSeparate`, full GL-state
teardown): 2 texels per instance — texel 0 = home rect (cx, cy, w, h px,
y-down), texel 1 = current offset (dx, dy px). One
`drawArraysInstanced(TRIANGLE_STRIP, 0, 4, count)` over a transparent clear.

Vertex shader: corner from gl_VertexID, half-size `max(0.5, w/2 − gap/2)`,
quad centered at `home + offset` (px→NDC with the y flip at the GL boundary,
once); UVs sample the SAME gap-shrunk rect at the HOME position, so each quad
carries its source pixels with it. Fragment: plain source sample.

Draw order = recursion emit order (stable); overlapping mid-animation pieces
resolve by that order. At fac = 0 with gap = 0 the quads tile the canvas
exactly (cut positions are shared px coordinates — no cracks: adjacent
pieces' edges are the same float values).

## Points contract

Built with `makePoints(count, {withScales, withGroupIndices})`,
**unconditionally** (the loop-weave/consumedOutputs caching lesson — same
reasoning recorded in adaptive-pixelate.ts):

- `positions` — CURRENT piece centers (home + fac offset), normalized
  [0,1]², y-down. They animate with fac — wire into Copy-to-Points etc. and
  downstream systems ride the assembly.
- `scales` — `sx = w / piece_max`, `sy = h / piece_max` (ungapped cell dims —
  the grid is the geometry authority; gap is styling). Same
  relative-to-coarsest semantics as Adaptive Pixelate.
- `groupIndices` — subdivision depth (0 = never split).

## Conventions & hygiene

- Universal mask blends (image input present), universal opacity, bypass —
  nothing node-side (invariant #6).
- Missing image → transparent clear + `EMPTY_POINTS`.
- Degenerate clamps: `piece_max ≤ max(canvas w, h)` (root always splittable
  when canvas > piece_max), `piece_min ≤ piece_max / 2`, gap can't invert a
  quad (half-size floor 0.5px).
- Pool leases (driver targets) released before return; private GL objects
  deleted in `dispose`. Never touch input textures.
- No schema bump — new node type, plain JSON params.

## Future work (non-blocking)

- Per-piece **stagger** (pieces assemble sequentially, seeded order) — the
  classic assemble feel; cheap to add as `stagger` 0..1 remapping each
  piece's local fac window.
- Driver-weighted cut positions (cut at the luminance median — content-aware
  bento); the SAT already makes this O(axis) per cut.
- Per-step easing list (dynamic UI) if one-easing-for-all proves limiting.
- Temporal hysteresis for video-driven maps (shared problem with Adaptive
  Pixelate).

## Milestones

- **M1 — grid + core render**: extract `engine/driver-reduce.ts` (Adaptive
  Pixelate refactored onto it, zero behavior change); node file +
  registration; driver → SAT → bento subdivision; instanced render with gap;
  straight-slide fac (steps = 1) with per-piece random scatter + easing.
  Manual browser check: fac = 0 reproduces source; slicing follows the map.
- **M2 — stepped animation**: N-step zigzag legs + `first_axis` + per-leg
  easing incl. hold-teleport; verify the 2-step slide-in-then-drop reads
  right and overshoot easings settle cleanly.
- **M3 — points + ship**: points aux per contract; docs description;
  devguide + devlist updates; `npm run typecheck` + `npm run check` + lint
  ratchet.
