# Diffusion Curves node — spec (072726)

Vector primitive from Orzan et al. 2008, "Diffusion Curves: A Vector
Representation for Smooth-Shaded Images" (SIGGRAPH). A curve carries
colors on its left and right sides (varying along its length) plus a
blur amount; the image is the steady-state color diffusion from all
curves — a Poisson solve whose constraints are the curves' color
sources and the sharp color-jump gradient across each curve. Complex,
smooth-shaded gradients from a handful of drawn strokes.

## Design decisions (owner Q&A, 07-27)

1. **Colors: two shared ramps.** `left_colors` / `right_colors` are
   `color_ramp` params; stop position = t along the curve's arc length.
   The ramp UI *is* the paper's Cl/Cr attribute-control-point array —
   per-stop keyframing / expose / export controls for free. All
   subpaths of the input spline share the two ramps (each subpath
   re-spans them 0..1 by default). Differently-colored curve sets =
   multiple Diffusion Curves nodes composited via Merge — output alpha
   DIFFUSES like the color channels (per-stop ramp alpha), so a node's
   result can fade to transparent away from curves whose alpha says so.
   Constraint-level chaining (a second node adding constraints to the
   same solve) is future work — solved images don't sum, so a naive
   `field`-style add input would be wrong.
2. **Image-trace mode in v1** (paper §4.2). `color_source: image`
   samples the wired `trace` image at each color-source pixel instead
   of the ramps — draw a few strokes over a photo/video and the
   diffusion reconstructs a painterly version. Live per frame when the
   trace input animates (normal fingerprint cascade, no extra work).
3. **Full varying blur in v1** (paper §3.2.3). Blur along the curve =
   `blur_curve` (float_curve over t) × `blur_max` px. A second, cheaper
   Poisson solve diffuses the on-curve blur values into a blur map B
   (∆B = 0), then a spatially-varying separable Gaussian reblurs the
   color image with per-pixel radius B. Both passes skip entirely when
   `blur_max` is 0 (the default).

Out of scope (future work): automatic bitmap → curves extraction
(paper §4.3 — Canny/scale-space vectorization), per-curve independent
attribute UI, constraint-level node chaining, panning/zooming windowed
solves (solve is always canvas-res here).

## The math (paper §3.2, adapted)

Curves are sampled arc-length-uniformly into polyline segments. Three
constraint rasters at solve resolution:

- **Color sources C + mask M**: 1px-wide bands at distance ±d (d = 3px,
  paper's value) along the curve normal, colored by the interpolated
  left/right ramp color (or the trace image sampled at the band pixel's
  own position). Sources sit OFF the curve so left/right don't overlap
  on the pixel grid; the on-curve gradient constraint keeps the
  transition sharp. Where curves crowd (thin structures, intersections,
  high curvature) nearest-segment-wins replaces the paper's stencil
  discard — one constraint per pixel, no double-draw artifacts.
- **Gradient constraint → RHS r**: on-curve pixels carry the vector
  field w = (cl − cr)·N (per RGBA channel — alpha jumps diffuse too).
  Rasterize Wx, Wy, then one difference pass builds the Poisson RHS
  r = div w (backward differences), and Wx/Wy are released. The solve
  is ∆I = div w with I = C where M says so (Dirichlet), Neumann
  (clamped-fetch) at canvas edges.
- **Blur sources**: on-curve pixels carry σ(t) = blur_curve(t)·blur_max.
  ∆B = 0 solve, no RHS.

**Multigrid** (paper's schedule): restrict C/M/r down a pyramid
(mask-weighted 2×2 average for C, average for M, 2×2 SUM for r — the
h² scaling of the 5-point stencil RHS across levels), solve coarsest →
finest with `5·i·quality` Jacobi iterations per level (i = level index,
fine = 1), bilinear-prolongating each solution as the next level's
initial guess. Jacobi update: `I = M ≥ ¼ ? C : (ΣI_neighbors − r)/4`.
Sanity test: one straight vertical line, red left / blue right, blur 0
→ a hard red/blue step image; alpha-0 stops → result fades out.

## Node

`diffusion-curves` — **Diffusion Curves**, category `spline` /
`modifier`, backend `webgl2`, file `src/nodes/effect/diffusion-curves.ts`.
Stateless steady-state solve → **normal caching** (no `stable:false`):
a static graph pays nothing per frame; keyframed splines / video trace
recompute via the ordinary fingerprint cascade.

Inputs: `spline` (required) · `trace` (image, optional — image-trace
color source) · universal mask (mattes — no base input).

Params:
- `color_source` enum `ramps | image` (segmented, default `ramps`;
  `image` falls back to ramps when nothing is wired).
- `left_colors`, `right_colors` (`color_ramp`, per-stop alpha honored)
  + `ramp_interp` (linear/ease/constant, shared by both ramps).
- `t_domain` enum `per curve | whole spline` (default `per curve`):
  each subpath re-spans the ramps 0..1, or all subpaths share one
  concatenated arc-length domain (rasterize-spline's global-t).
- `blur_max` scalar px (0..64, softMax 24, default 0) + `blur_curve`
  (float_curve over t, default flat 1 — so blur_max alone gives
  uniform blur; the curve shapes it along the stroke).
- `quality` scalar 1..4 (default 2) — Jacobi iteration multiplier.
- `resolution` scalar 0.25..1 (default 1) — solve-grid scale (fluid-sim
  precedent); below 1 the result upsamples LINEAR to canvas. Sharp
  edges ARE the point, so default full res; the knob is the perf
  escape hatch for animated curves.
- `source_distance` scalar px 1..8 (default 3) — the paper's d.
- `view` enum `result | sources | blur map` (debug, fluid-sim
  precedent).
- `OPACITY_PARAM`.

Output: primary `image` (RGBA, straight alpha). No aux outputs in v1.

## GPU implementation — all fullscreen passes, no custom geometry

CPU prep (per recompute): sample each subpath arc-length-uniformly
(~2.5px spacing, global cap 2048 samples — spacing degrades gracefully
past the cap), closed subpaths append a wrap duplicate of sample 0 so
every segment is a consecutive pair. Per sample: position (px, y-down),
unit normal (rot90 tangent), cl/cr RGBA (numeric ramp sampling — new
`sampleColorRampRgba` in engine/color-ramp.ts beside the existing
string sampler), σ, and a valid-segment flag. Packed into a node-owned
**RGBA32F data texture** (N wide × 4 rows: pos+normal / cl / cr /
(σ, validSeg)) via the adaptive-pixelate `uploadDataTexture` pattern —
32F because half-float positions wobble ~1px at 2K canvases. Lives in
`ctx.state["diffusion-curves:<id>"]`, deleted in `dispose`.

Passes (targets are pool RGBA16F unless noted):

1. **Nearest** — brute-force point-to-segment over all N segments,
   ONCE, into a node-owned RGBA32F target (synthetic ImageValue target,
   adaptive-pixelate's `ensureMipCopy` precedent): per pixel
   (segIdx, u, signedDist, absDist). Every later raster is a cheap
   texelFetch through this. O(N·pixels) — the dominant cost (~10-30ms
   at 1024²/1k segments), paid only on recompute.
2. **Sources C** (band |dist − d| ≤ 0.5) + **mask M** — colors from the
   data texture lerped along u, side by sign(signedDist); trace mode
   samples the trace image at the pixel's own UV instead. Two cheap
   passes (single-target drawFullscreen).
3. **Wx / Wy** (on-curve band) → **RHS r** via one backward-difference
   pass; Wx/Wy released.
4. **engine/poisson.ts** — `solvePoisson(ctx, {color, mask, rhs?},
   {quality, resolution})`: the multigrid machinery above, reusable
   (future Poisson-editing nodes, gradient-domain tricks). Pyramid
   levels are pool sub-sized allocs, released on exit.
5. **Blur map B** — same solver, no RHS; skipped when blur is off.
6. **Variable blur** — separable H+V gather, per-dest-pixel radius
   B(p) clamped to blur_max (≤64 → ≤129 taps worst case, only when
   cranked).
7. **View/debug** branch, universal opacity/mask via the evaluator.

All intermediates released before return (invariant #3); the two
node-owned 32F textures persist across computes (size-checked, rebuilt
on canvas resize).

## Milestones

- **M1** — poisson.ts + node: ramps, sharp solve, t_domain, quality /
  resolution / view, registration + docs description. Verify: step-image
  sanity test, non-square canvas, cache behavior while paused.
- **M2** — image-trace mode (`color_source`, `trace` input): photo
  stylization; video trace recomputes per frame.
- **M3** — blur pipeline (`blur_max`, `blur_curve`, blur-map solve,
  variable blur pass, `blur map` view).
- Ship: devguide sharp-edges entry + this spec cross-linked.

## Notes / caveats

- Textures thinner than ~2d can't hold both source bands — the gradient
  constraint alone defines the transition there (paper's eyebrow case);
  nearest-wins makes this deterministic.
- Matting the OUTPUT is fine; matting can't be used to window the solve
  itself (global solution — paper §3.2.4).
- Curve intersections diffuse-compete exactly as the paper describes
  (§6.2, Fig 10); splitting curves / adding stops is the user-side fix.
- `float_curve` params aren't keyframable (house rule) — animate blur
  via `blur_max`; the curve is the static profile.
