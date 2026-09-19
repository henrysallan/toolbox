# Grain node v2 — technique survey + design (spec, 2026-09-16)

Research pass over how film / sensor / stylised grain is synthesised, how
each technique trades performance against realism and flexibility, and —
the part that hurts today — how grain can be animated smoothly instead of
re-rolled. Ends with a proposed node design and milestones. Nothing here is
implemented; the "Decision" blocks are recommendations for the design Q&A.

Related: [nodes/effect/grain.ts](../src/nodes/effect/grain.ts) (today's
node), [nodes/source/perlin-noise.ts](../src/nodes/source/perlin-noise.ts)
(W slice-blend + looping evolution, the closest precedent),
[archive/061626_looping-noise-evolution.md](archive/061626_looping-noise-evolution.md),
[TESTING.md](../TESTING.md) (how to measure any of this honestly).

---

## 0. Summary

- Grain is a **spatio-temporal random field**. Every technique below is a
  choice on one of four independent axes — per-sample distribution,
  spatial structure, temporal structure, application to the image — and
  the axes compose. The node should be organised that way rather than as
  a list of "looks".
- **Smooth evolution is a solved problem once one rule is followed:** any
  blend of independent noise frames must be renormalised by
  `1 / sqrt(Σ wᵢ²)`. Plain lerp between two grain frames drops contrast
  by 29 % at the midpoint (the "breathing" people see when they crossfade
  noise). With that rule, a short **moving-average kernel over hashed
  frames** (4–9 taps, Gaussian or cubic B-spline weights) gives
  deterministic, scrubbable, loopable, C²-smooth grain at ~1 hash per tap
  per pixel. This is the recommended default for `motion: smooth`.
- The jitter today has three separate causes (§1): the hash is
  discontinuous in `seed`, the node is not locked to project frames (a
  time-driven seed re-rolls at RAF rate, so the 60 Hz preview looks
  different from the 24 fps export), and the "Gaussian" is a bounded
  triangular distribution.
- Recommended technique ladder (§3, §6): **hash white** (today's cost) →
  **soft grain via a low-res noise buffer + separable blur** (2 small
  passes, continuous size/softness) → **Boolean disc model** (Newson et
  al., true film morphology, 3×3-cell search like Voronoi) → **AR-template
  tiling** (the AV1 / H.274 codec model; CPU template, GPU tiling, opens
  the door to *matching* grain from footage) → **scanned plates** (a wired
  image / video). Expensive models run through one shared **plate**
  execution path (small textures cached in `ctx.state`, K of them for the
  temporal kernel) so their per-frame cost is one fetch per tap.
- Realism knobs missing today that matter more than the noise algorithm:
  a **tonal response curve** (grain lives in the midtones/shadows, not in
  clipped whites), **working space** (display / linear / log),
  **per-channel size and intensity** (blue record heaviest, red coarsest —
  Nuke's defaults), grain **saturation**, and **resolution-independent
  size units**.

---

## 1. Today's node and why animating it jitters

[grain.ts](../src/nodes/effect/grain.ts): one fragment pass. Per pixel it
floor-quantises the pixel coordinate into `scale`-px cells, hashes
`vec3(cell, seed)` with Dave Hoskins' float `hash13`, sums two uniforms
for a "Gaussian", does the same three more times with offset seeds for
chromatic grain, and blends via seven mix modes. No input → grain on 50 %
grey. `seed` is a float the user animates for moving grain.

What is wrong with it as an *animated* grain source:

1. **Discontinuous in `seed`.** `hash13` is a hash: `seed = 1.0` and
   `seed = 1.01` are unrelated fields. There is no parameter whose small
   change produces a small change in the output, so "smooth evolution"
   cannot be expressed at all. (Noise fixes this with the W slice-blend;
   Grain has nothing.)
2. **Not frame-locked.** Wiring Scene Time (seconds) into `seed` re-rolls
   the field on every evaluation, i.e. at RAF rate in the editor. A 24 fps
   project previews with 60 Hz grain "buzz" and exports with 24 fps grain
   — the preview lies. Nuke, AE and every codec model re-roll grain **per
   project frame**.
3. **Float hash on large arguments.** `fract(p * 0.1031)` with
   `seed = time * k` or cell coordinates in the thousands at 4K quietly
   loses bits; Hoskins hashes are known to show lattice correlation in
   some argument ranges. The repo already moved Voronoi to an integer
   `pcg3d` for exactly this reason
   ([voronoi-geometry.ts:30](../src/engine/voronoi-geometry.ts#L30)).
4. **Triangular, not Gaussian.** `a + b - 1` of two uniforms is a
   triangular PDF: hard-bounded at ±1, std 0.408, no tails. Film grain has
   tails (occasional bright specks); the bounded shape reads as "digital
   static".
5. **Size = pixelation.** `floor(px / scale)` makes axis-aligned squares.
   Real grain of any size has soft, irregular, overlapping blobs. Above
   `scale ≈ 2` the node looks like a mosaic, not grain.
6. **Chromatic grain is RGB confetti.** Three fully independent channels
   with identical size. Film dye clouds are partially correlated across
   layers and have different size / intensity per layer.
7. **No tonal response.** Equal amplitude at black and white, so grain
   clips asymmetrically in highlights and shadows instead of fading where
   film (or a sensor) has none.
8. **Display-space only.** Additive grain in sRGB is fine for stylisation,
   wrong for "film", where grain is a density (log) phenomenon.
9. **Not resolution independent.** `scale` is render-resolution pixels
   (the facts block says so). Preview at 1080p, export at 4K, the look
   halves. Newson's model and the film-gauge units in §5.7 fix this.
10. **No grain-only view / output**, so matching or reusing the layer
    means deleting the input wire.

None of these is a bug in the classic sense; the node was scoped as "quick
film shimmer" in v0.0.4. They are the gap between that and a grain tool.

---

## 2. The model: four orthogonal axes

Think of the grain layer `g(x, y, t)` as a zero-mean random field that is
then *applied* to the image. Every technique in the literature and every
parameter in AE / Nuke / Resolve / UE / Unity sits on one of these axes:

| axis | question | examples |
| --- | --- | --- |
| **distribution** | what is one sample's PDF? | uniform, triangular, Gaussian, heavy-tailed, sparkle outliers, Boolean coverage |
| **spatial structure** | how are neighbouring samples correlated? | white, cell-quantised, blurred (soft), lattice/value noise, multi-octave, blue noise, Poisson discs, AR template, scanned plate, anisotropic |
| **temporal structure** | how is frame *t* correlated with *t±1*? | static, white per frame, hold N, crossfade, moving-average kernel, harmonic bank, advection/warp, feedback (OU), STBN slices |
| **application** | how does `g` reach the pixels? | amount, tonal response curve, working space, per-channel model, saturation, blend mode, alpha rule, clipping |

Spatial and temporal structure are (to first order) **separable**: a
spatial kernel shapes each frame, a temporal kernel blends frames. That is
what lets an expensive spatial model (Boolean discs) and a smooth temporal
model (moving average) be combined without a 3D algorithm.

---

## 3. Spatial / morphology techniques

Scoring: **cost** is per output pixel per channel in hash evaluations (H)
and texture fetches (F) at full resolution unless noted; "plate" means the
work happens once per grain frame in a small texture (§6). **Realism** is
about film / sensor plausibility; **flex** is how many looks it reaches.

| # | technique | cost | realism | flex | one-line verdict |
| --- | --- | --- | --- | --- | --- |
| A | hash white noise (today, fixed) | 1–2 H | ○○ | ○ | the floor; right for 1-px fine grain, wrong above |
| B | floor-quantised cells (today) | 1–2 H | ○ | ○ | keep only as `classic` for back-compat |
| C | lattice value noise at grain scale | 4 H bilinear / 16 H bicubic | ○○ | ○○ | soft blobs, faint grid; cheap continuous size |
| D | low-res white buffer + separable Gaussian blur, upsample | plate: ≈(2r+1)·2 F at 1/s² res, then 1–4 F | ○○○ | ○○○ | **the workhorse**: continuous size *and* softness, AE-like |
| E | multi-octave / mip-shaped spectrum | K F (mip LOD) | ○○○ | ○○○ | size *distribution* (irregularity) for the cost of a mip chain |
| F | blue noise / STBN / FAST plates | 1 F | ○○ (stylised) | ○○ | finest possible "even" grain; hides banding; needs shipped textures |
| G | Boolean disc model (Newson et al.) | 9 cells × n grains dist tests (~30–100 ops) | ○○○○○ | ○○○ | real morphology, intensity-dependent density, resolution independent |
| H | AR template + block tiling (AV1 / H.274) | CPU template (≈6k px × 24 MAC) + 1 F | ○○○○ | ○○○○ | codec-grade, parametric, **matchable** from footage |
| I | scanned plate (wired image / video) | 1 F + normalisation | ○○○○○ | ○○○○○ | truth, at the price of an asset |
| J | sensor model (shot + read + FPN + banding + chroma blotch) | 3–6 H + 1 small F | ○○○○ (digital) | ○○○ | a different family users will ask for |
| K | analog video snow (line-correlated) | 2–4 H | n/a (stylised) | ○○ | cheap 1-D variant of D |
| L | anisotropy / aspect | free (coordinate scale) | + | + | AE "Aspect Ratio"; anamorphic and streak looks |

### A/B. Hash white noise

Keep, but on an **integer** hash: `pcg3d(uvec3(px, py, frame))` → three
32-bit words → uniforms in `[0,1)`. It is already the repo's shared hash
(`PCG3D_GLSL` in [voronoi.ts:76](../src/nodes/source/voronoi.ts#L76),
bit-exact TS mirror in voronoi-geometry.ts), which also means a CPU
`check-grain.mts` can reproduce any pixel. Gaussian from the words: Box–
Muller from two uniforms yields *two* independent normals (use both:
luminance + one chroma), or Irwin–Hall (sum of 4 uniforms, std 0.577,
excess kurtosis −0.3, no transcendentals). Legacy `classic` keeps the
float hash so saved projects stay pixel-identical (§7.6).

### C. Lattice value noise

`vnoise`-style bilinear/bicubic interpolation of hashed lattice values at
`size` px spacing. Cheap continuous size, C¹ with B-spline weights, but
the regular lattice shows as a faint diamond/grid at large sizes. Two
lattices offset by half a cell, or a jittered lattice, hide it. Mostly
superseded by D once the plate path exists; worth having as the
no-intermediate-texture fallback (e.g. inside GLSL Expression).

### D. Blurred low-resolution white noise — the workhorse

Render white Gaussian noise into a buffer of `(W/s) × (H/s)` texels
(`s` = grain size in px), blur it with a separable Gaussian of σ_soft
(reuse `gaussianPlan` / `runSeparable` in
[engine/convolve](../src/engine/convolve/index.ts) — it already handles
boundary and a linear-light flag we would turn off), then sample it at
full resolution with bicubic filtering. This is what AE's *Size* +
*Softness* do; UE's *Texel Size* is the same idea with a fixed plate.

Two rules make it correct rather than approximate:

- **Renormalise variance after the blur.** A 2-D Gaussian of σ px applied
  to unit white noise leaves std `1 / (2σ√π)`: 0.28 at σ = 1, 0.14 at
  σ = 2, 0.07 at σ = 4. Compute the discrete kernel's `Σw²` per axis on
  the CPU (the plan has the taps) and scale by `1 / sqrt(Σwₓ² · Σw_y²)`, so
  *amount* means the same std at every softness. Without this, softness
  doubles as an amount slider and the two fight.
- **Upsample with a smooth filter.** Bilinear upsampling of a noise buffer
  produces a visible diamond lattice; a 4-tap bicubic (B-spline or
  Catmull-Rom) or bilinear on a 2× oversampled buffer does not.

Continuous `size` below 1 texel is "no buffer" (path A); above, the
buffer shrinks, so *larger grain is cheaper*. The buffer is a **plate**
(§6) and slots straight into the temporal kernel.

### E. Multi-octave spectrum (irregularity)

Real grain is not one size. Sum 2–3 plates at sizes `s, 2s, 4s` with
weights `1, ρ, ρ²` (renormalised) — fBm over white noise — or sample one
plate's mip chain at fractional LOD (each level halves the std: multiply
by `2^lod`). This is what Nuke's *irregularity* and Newson's log-normal
radius produce: clumps within a fine field. Cheap because the extra
octaves are smaller buffers.

### F. Blue noise / spatiotemporal blue noise / FAST

Void-and-cluster blue noise has no low-frequency energy, so at equal
amplitude it looks finer and more even than white noise and it hides
8-bit banding far better (the dither use case). NVIDIA's **spatiotemporal
blue noise** (Wolfe et al., EGSR 2022) is blue in space *and* along the
frame axis of a `128×128×64` volume, so successive frames are
well-distributed rather than independent — verified: independent
blue-noise textures per frame give a white temporal spectrum, STBN gives
"increased stability when filtered temporally". EA's **FAST noise**
(2024) goes further and optimises the volume for a specific temporal
filter (EMA α, Gaussian, box) — which is exactly our moving-average
kernel. Both are precomputed assets (~1 MB for a scalar 128×128×64 at 8
bits; the generation is minutes, not real-time). Ship a `64×64×32`
scalar slice set as an engine-side asset (invariant #1: engine
self-contained — no loader outside `src/engine`) and index it
`(x mod 64, y mod 64, frame mod 32)`. Realism is low (no clumping — the
opposite of film), but for "fine digital texture" and dithering it is the
best-looking cheapest option. The golden-ratio trick (offset one 2-D blue
texture by `fract(frame · 0.618)`) is the zero-asset fallback: cheap
decorrelation, but the temporal spectrum is not blue and it can strobe.

### G. Boolean disc model (Newson, Delon, Galerne 2017)

The physically-motivated one. Grains are discs centred on a Poisson point
process with (log-normal) random radii; the film's density at a point is
whether *any* disc covers it. Fitting the coverage probability to the
input intensity `u ∈ [0,1)` gives the grain density
`λ(u) = −ln(1 − u) / (π · E[R²])` with `E[R²] = r² + σ_r²` (constants to be
verified against the paper — the IPOL PDF was fetched but could not be
rendered during this pass). Newson renders each output pixel by Monte
Carlo: N Gaussian-jittered sample positions (σ_filter emulates scanner
blur), each tested for coverage against the grains of the neighbouring
cells. The output is not "image + noise": it is the image *re-synthesised
as grain*, so the noise statistics fall out of `u` automatically (near
zero at `u → 0`, maximal in the midtones, resolution independent because
grains live in continuous input coordinates).

Real-time adaptation for us: no Monte Carlo. Per output pixel, walk the
3×3 neighbouring cells of side ≈ 2·r_max (the Voronoi node's 3×3 lattice
search is the precedent and the cost model), pull `n` grains per cell
(n fixed at 2–4, existence gated by a hashed Bernoulli so the *expected*
count tracks `λ(u)` of the local intensity), compute an **analytic soft
coverage** `c = smoothstep(R+w, R−w, dist)` per grain (w = σ_filter), and
union them probabilistically `1 − Π(1 − cᵢ)`. Grain = coverage − u,
scaled by amount, so it still goes through the mix modes. Cost ≈ 9·n
distance tests + hashes per channel: heavy but bounded, and it only pays
off at sizes ≥ 2 px (8 mm / 16 mm looks, zoomed 35 mm) — below that it
degenerates to white noise, so the node should auto-fall back to D.
Run it through the plate path per channel to keep it off the 4K budget.

### H. Auto-regressive template + block tiling (AV1 / H.274)

Video codecs strip grain, transmit a parametric description, and
re-synthesise it after decode; the models are small, deterministic and
tuned to look like scanned film at video resolutions. Two standardised
families (both implemented in InterDigital's open **VFGS** — verified):

- **AV1 film grain synthesis** (spec §7.18.3; Norkin & Birkbeck, DCC
  2018): an LFSR draws Gaussian samples into a luma template of
  **73 × 82** (chroma 38 × 44 for 4:2:0), an auto-regressive filter of lag
  ≤ 3 (2·L·(L+1) = **24 luma coefficients**, +1 for chroma-from-luma)
  runs causally over the template to give it spatial correlation, a
  **piecewise-linear scaling function** of intensity (≤ 14 points)
  modulates it, and the picture is covered with **32 × 32 blocks** each
  reading the template at a random offset, blended at the 2-px seams with
  weights **(27, 17)** — note `27² + 17² = 1018 ≈ 32²`: the codec people
  chose *variance-preserving* seam blends, the same rule as §4.2. Output is
  non-normative (decoders may differ). (Numbers from memory of the spec;
  the spec page fetch was truncated — verify before quoting.)
- **H.274 / VSEI film grain characteristics SEI**: an intensity-interval
  model with per-interval gain and either a *frequency-filtering* model
  (DCT-domain band-pass with horizontal / vertical cut-offs on a
  pre-generated pattern) or an AR model; additive or multiplicative
  blending.

For us: the AR template is **~6k pixels × 24 MACs — trivial on the CPU
every grain frame**, uploaded as a plate; the GPU pass is the block
tiling with overlap blending. Per frame cost ≈ 1 fetch + seam blend. The
big flexibility win is later: the AV1 encoder side *estimates* AR
coefficients and the scaling curve from a denoised/original pair, which is
a **Match Grain** feature (AE Match Grain, Nuke F_ReGrain) we could build
on the same node: sample a flat patch of wired footage → fit AR(3) → the
node re-synthesises that grain anywhere. Weakness: at coarse stylised
sizes the 73 × 82 template repeats; use a GPU-generated 256² template
there.

### I. Scanned plates

Wire an image or video into a `plate` input: subtract its mean (0.5 by
convention, or the plate's own mean via a tiny mip readback once), scale
by amount, tile with a per-frame random offset (and optional flips) so a
small scan covers 4K without a visible period, or step through the video's
frames. Nuke's ScannedGrain, Resolve's grain presets and most "film
emulation" plugins are this. Realism is whatever the scan is; the node
adds nothing but placement, temporal handling and the application axis.

### J. Sensor noise (digital)

A distinct family, cheap and currently unreachable: **shot noise** with
variance ∝ signal in *linear* light (Gaussian with `σ = k·sqrt(Y_lin)`),
plus constant **read noise**, plus **fixed-pattern noise** (static per-pixel
offsets — the one legitimately *static* grain: hash of pixel only), plus
**row / column banding** (1-D hash along y or x, low-passed), plus
**low-frequency chroma blotch** (a coarse plate applied to chroma only,
the demosaic/denoise footprint), plus optional hot pixels (sparkle). Green
channel lower noise than R/B (twice the Bayer sites). Applied in linear,
encoded back — this is why digital noise looks flat in the shadows and
vanishes in highlights, the opposite of print grain.

### K. Analog video snow

White noise correlated along scanlines: a 1-D blur along x of per-line
hashed noise, sometimes with per-line gain jitter. Two hashes and a few
taps. Cheap, and pairs with the datamosh / VHS looks the toolbox already
courts.

### L. Anisotropy

Scale the sampling coordinate by `(1/aspect, aspect)` before hashing or
plate lookup. Free. Streak looks come from strongly anisotropic softness
(σₓ ≫ σ_y) in D.

---

## 4. Temporal evolution techniques

The user-facing ask: "the seed is easy to change but a smooth evolution is
hard to get." Below, `ε_k` is the k-th independent grain *frame* (a
spatial field from §3), `t` is the continuous grain-time in frames.

| # | technique | continuity | variance | random-access / scrub | loopable | cost | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | white per frame (`ε_⌊t⌋`), frame-locked | none (by design) | exact | ✓ | ✓ (mod P) | 1× | **film default**; fixes the RAF flicker |
| 2 | hold N frames | none, stepped | exact | ✓ | ✓ | 1× | stop-motion / 12 fps grain looks |
| 3 | crossfade held frames, variance-preserving (slerp) | C⁰ (C¹ with eased θ, but then it pulses) | exact | ✓ | ✓ | 2× | AE "Animate Smoothly"-class; ok, MA is better |
| 4 | **moving-average kernel over frames** (Gaussian / B-spline weights, renormalised) | C² (B-spline) / C^∞-like (Gaussian σ ≥ 1) | exact after renorm | ✓ | ✓ (mod P) | K× (4–9) | **recommended `smooth`** |
| 5 | harmonic bank `Σ aₖ cos(2πkt/P + φₖ(pixel))` | C^∞ | exact | ✓ | exact, any P | K× cos | exact loops without frame quantisation; near-Gaussian for K ≥ 6 |
| 6 | advection: drift `p + d(t)` / domain warp by curl noise | as smooth as `d` | exact | ✓ | ✓ if `d` loops | +1 noise | "crawl" instead of "fade"; combine with 4 |
| 7 | feedback OU / AR(1): `g_t = ρg_{t−1} + √(1−ρ²)ε_t` | C⁰ exponential | exact | ✗ (needs pre-roll) | ✗ | 1 F + 1 H | rejected for v1: `simulation:true` cost for nothing 4 doesn't give |
| 8 | STBN / FAST time slices | designed for filters | exact | ✓ | 32/64-frame period | 1 F | pairs with F; "even" fine texture under 4 |
| 9 | golden-ratio offset of one plate | none | exact | ✓ | ✗ | 1 F | zero-asset decorrelation; can strobe |
| 10 | flow-following (grain sticks to motion) | n/a | — | via nodes | — | external | composable today: Grain → Advect Image by Image Flow Field |

### 4.1 Frame locking (1) — the fix everyone gets for free

Grain-time derives from the project clock, never the evaluation:
`t = (ctx.tick / ctx.ticksPerFrame) · (rate / ctx.fps) + evolution`. With
`rate = 0` meaning "project fps", `⌊t⌋` changes exactly once per project
frame in preview *and* export. `fingerprintExtras` returns `⌊t⌋` (or `t`
quantised to 1/256 frame for `smooth`) only when `motion ≠ static`, so the
static node stays fully cached and an animated node recomputes at grain
rate, not RAF rate — strictly cheaper than today's time-wired seed. Same
pattern as Noise's `anim:${ctx.tick}` but coarser.

### 4.2 The variance rule (3, 4, 5)

For independent zero-mean unit-variance frames, `g = Σ wₖ εₖ` has variance
`Σ wₖ²`. Blends that sum to one do **not** preserve variance:

| blend | `Σw²` range | std swing |
| --- | --- | --- |
| linear lerp of 2 frames | 0.50 … 1.00 | **−29 %** at the midpoint (the classic breathing) |
| Catmull-Rom over 4 frames | 0.64 … 1.00 | −20 %, plus overshoot |
| cubic B-spline over 4 frames | 0.460 … 0.500 | −4 % |
| Gaussian σ = 0.5 frame (5 taps) | 0.48 … 0.64 | −13 % |
| Gaussian σ = 1 frame (9 taps) | 0.2821 … 0.2822 | 0.02 % |

So: always divide by `sqrt(Σ wₖ²)`. The weights depend only on `fract(t)`,
so they are K floats computed on the CPU per frame and uploaded as
uniforms with their norm — zero per-pixel cost. The 2-frame case
normalised is the **slerp** `g = a·cos θ + b·sin θ`, `θ = (π/2)·fract(t)`:
exact variance at every θ, which is what "variance-preserving blend" means
in the shader literature. It is C⁰ at frame boundaries (velocity flips
from `−a` to `c`); easing θ with smoothstep makes it C¹ but the motion
then stops at every knot — a visible cadence. The moving average has no
knots.

### 4.3 Moving-average kernel (4) — recommended `smooth`

```
// CPU, per frame:  t = grain time in frames; sigma = smoothness (frames)
K   = ceil(3*sigma) taps each side   (sigma 1 → 9 taps, 0.5 → 5, 2 → 13)
w_k = exp(-0.5 * ((k - fract(t)) / sigma)^2),  k = -K..K
norm = 1 / sqrt(sum(w_k^2))
// GPU, per pixel per channel:
g = 0.0;
for k in -K..K:  g += w[k] * gaussian(pcg3d(uvec3(px, py, uint(floor(t)) + k + seed)));
g *= norm;
```

Properties: deterministic and random-access (any frame from cold, so
scrubbing, Time Offset and export all work with no state), C^∞-smooth for
σ ≥ 1 with constant variance, temporal power spectrum
`|W(f)|²` = a Gaussian low-pass, loop-exact when the frame index is taken
`mod P` (the same white frames recur; the kernel wraps with them),
`sigma → 0` degenerates to technique 1 (hard per-frame grain) and
`smoothness × rate` reads as "grain lifetime in seconds". Cost is K hashes
per channel per pixel on the direct path — fine for luminance-only fine
grain up to 1080p — or **K plate fetches** when the spatial model is
anything heavier (§6), which is how Boolean or AR grain becomes smoothly
animated for the price of a few texture reads. Cubic B-spline weights
(4 taps, C², −4 % swing before renorm) are the budget setting.

The equivalent in the frequency domain is a *temporal Gaussian blur of
white noise*: spatial softness and temporal smoothness are literally the
same operation on different axes, which is a good story for the UI
(size / softness ↔ rate / smoothness).

### 4.4 Harmonic bank (5)

Per pixel, `g(t) = norm · Σ_{k=1..K} cos(2π k t / P + φₖ)` with `φₖ` from
the pixel hash. Exactly periodic in `P` (frames or seconds — no integer
constraint), C^∞, constant variance (`norm = sqrt(2/K)`), and the
amplitude spectrum `aₖ` shapes the speed. K = 1 is an arcsine
(bimodal, flickers between two levels); K ≥ 6 is close to Gaussian. Cost K
cosines per channel. Keep as the `loop` implementation for non-integer
periods, or drop it if `mod P` moving average covers the need (it does for
frame-timed loops).

### 4.5 Advection and warp (6)

Everything above makes grains **fade** in place; nothing **moves**. Two
cheap complements: a per-frame uniform drift `d(t)` from a slow 1-D noise
(the whole plate wanders, like gate weave on the grain layer only) and a
per-pixel domain warp `p + a · curl(p, t)` (the Noise node's curl type)
for a boiling texture. Both are coordinate offsets before the lookup — for
plates, one extra fetch at most. Best on coarse stylised grain; real film
never crawls, so presets leave them at 0.

### 4.6 Rejected: feedback OU (7)

`g_t = ρ g_{t−1} + √(1−ρ²) ε_t`, `ρ = exp(−dt/τ)` is the cheapest smooth
process (one previous-frame fetch) with an exponential autocorrelation —
but it needs a ping-pong state texture (Trails' pattern), `simulation:
true`, export pre-roll ([lib/sim-preroll.ts](../src/lib/sim-preroll.ts)),
and it pops on backward scrubs. The moving average gives a nicer kernel
with none of that. Note it if someone asks why grain isn't a sim.

### 4.7 What "smooth grain" looks like — expectations to set

Temporally smoothed *fine* grain reads as swimming static / low-light
video rather than film, because each speck fades over several frames.
That is a legitimate motion-design look, not a film look; the film presets
should default to `every frame`. Smoothing shines on **coarse** grain
(sizes ≥ 3 px), where blobs breathing in and out at 2–6 frame lifetimes
reads as a living texture, and on loops. Also note the compression angle:
per-frame fine white grain is the worst case for H.264/HEVC exports (the
encoder spends the bitrate on it and smears it into blotches); ProRes
carries it fine. Smoother or coarser grain compresses better — worth a
line in the docs.

---

## 5. Application axis

### 5.1 Distribution

`distribution: gaussian (default) | triangular | uniform | heavy` where
`heavy` is a Laplace (`−sign(u)·ln(1 − 2|u|)`, one log) or Gaussian /
sqrt(χ²) for a Student-t feel. Plus `sparkle` 0..1: with probability
`p ∝ sparkle²` per pixel per frame add a positive outlier of 2–4σ (dust
sparkle on scans, hot pixels on sensors). Amount is specified as **std in
working-space units**, whatever the distribution, so switching PDF does not
change perceived strength. (Today's `luminance = 0.15` triangular is
std 0.061; the migration keeps that exact math under `classic`.)

### 5.2 Tonal response

The single biggest realism gap. `response: float_curve` mapping input
luminance → amplitude multiplier, baked to a 256-entry LUT texture exactly
as [color-correction.ts](../src/nodes/effect/color-correction.ts) bakes its
curves (`buildLut256`, monotone cubic from
[engine/float-curve.ts](../src/engine/float-curve.ts)). Ship presets as
curve shapes:

- **flat** — today's behaviour.
- **negative scan** — strongest in shadows, tapering through midtones,
  gone at clip (a scanned negative's thin areas are the noisiest).
- **print** — a hump centred on the midtones, low at both ends.
- **digital** — `sqrt`-shaped in linear (shot noise), so heavy in shadows
  after encoding, nil in highlights.
- **protect highlights** — UE's *Highlights Min / Max* as a soft shoulder.

UE5 splits this into Shadows / Midtones / Highlights intensities with
`Shadows Max` / `Highlights Min` thresholds; Unity HDRP has one *Response*
slider ("the higher, the less noise in brighter areas" — verified). A
curve subsumes both and costs one fetch.

### 5.3 Colour model

Nuke Grain's defaults (verified) encode the received wisdom: size
R 3.3 / G 2.9 / B 2.5, intensity R 0.416 / G 0.46 / **B 0.85**,
irregularity 0.6 each — the blue record is the heaviest, the red the
coarsest. Expose `channel_intensity` and `channel_size` as R/G/B triplets
in an advanced group with those as the film default, and derive the
current `luminance` / `chromatic` pair from a **saturation** model
instead of three independent hashes: generate a luma grain `g_Y` and a
chroma pair `(g_Cb, g_Cr)` (Box–Muller's second normal is free), apply
`saturation` to the chroma pair, convert to RGB. `saturation = 0` is
today's monochrome grain, `1` is film-like partially correlated colour
grain, `2` is the RGB-confetti look. AE additionally offers *Tint* (a
colour bias to the grain); cheap to add.

### 5.4 Working space

`space: display | linear | log`. Display = today. Linear = decode → add →
encode (via [engine/color-space.ts](../src/engine/color-space.ts)'s sRGB
↔ linear, shared with the ramp work): shot-noise-like, fades in
highlights. Log = a Cineon-style `log2(lin + ε)` transfer, add, invert:
additive in log is multiplicative in linear, which is what film density
noise is, and it is why "film" presets look right only here. The response
curve is evaluated on the *pre-transform* luminance so its presets keep
their meaning across spaces.

### 5.5 Blend and clipping

Keep the seven mix modes (they are a compositing convenience, and every
one is identity at zero grain). Add a soft-clip toggle (`tanh` shoulder in
the last 5 %) so heavy grain at the ends of the range compresses rather
than flattens — the asymmetry of hard clipping is a big part of the
"digital" tell. AE's *Film* blend mode is roughly `space: log` + add.

### 5.6 Alpha

Straight alpha (invariant #4). Grain modulates RGB only, alpha passes
through; in semi-transparent edges scale amount by α so a feathered
cut-out does not sprout full-strength grain in its fringe. Standalone mode
(no input) keeps emitting opaque 0.5 grey + grain.

### 5.7 Size units and resolution independence

`size_unit: px | ‰ height | film gauge`. Per-mille of canvas height makes
the look survive 1080p → 4K export; **film gauge** (`35mm 4-perf`,
`S16`, `S8`) with `size` in micrometres is the principled version — the
node converts through the gauge width and the render width:

| gauge (frame width) | 1920 px wide | 4096 px wide |
| --- | --- | --- |
| 35 mm 4-perf (24.9 mm) | 13.0 µm/px | 6.1 µm/px |
| Super 16 (12.5 mm) | 6.5 µm/px | 3.0 µm/px |
| Super 8 (5.8 mm) | 3.0 µm/px | 1.4 µm/px |

Visible grain structure on modern colour negative is on the order of
5–15 µm dye clouds, so "35 mm at 1080p" is sub-pixel (fine hash grain) and
"Super 8 at 1080p" is 2–5 px blobs — the presets fall out of one number.
The Boolean model is resolution independent by construction (grains live
in canvas-relative coordinates); the others need the unit conversion at
plate-allocation time. Both fix gotcha #9.

---

## 6. Execution strategies and the cost budget

Three ways to run any spatial model, chosen by the node, not the user:

| path | when | per-frame work | notes |
| --- | --- | --- | --- |
| **direct** | `size ≤ 1 px`, hash models, K ≤ ~8 taps | K hashes × channels per output pixel | no intermediates; today's shape |
| **low-res buffer** | `size > 1`, models D/E | hashes at `(W/s)·(H/s)`, blur there, 1–4 F at full res | larger grain = cheaper |
| **plate ring** | models G/H/I, or `smooth` with any non-trivial model | render **one** new plate per grain frame into a ring of K (`ctx.state["grain:<id>"]`, sized `W/s × H/s` or a fixed 512²), composite with K fetches | expensive models pay once per grain frame, not per tap |

Plates are RGBA16F (`allocImage` is half-float — signed values are fine)
holding `(g_Y, g_Cb, g_Cr, unused)`. K plates can be one
`TEXTURE_2D_ARRAY` (GLSL Expression already uses `sampler2DArray`) or an
atlas; the ring index is `⌊t⌋ mod K`. Regenerate the whole ring when a
model/size/seed param changes (store the param fingerprint next to the
ring, as Bloom's persistent mip chain does in
[bloom.ts:248](../src/nodes/effect/bloom.ts#L248)); release in `dispose`.
Because plate content is a pure function of `(seed, frame index)` via the
integer hash, a ring rebuilt after a resolution change or an export
backend swap reproduces the same frames — **no `simulation` flag, no
pre-roll**, deterministic export.

Budget guidance (measure, don't assume — TESTING.md §3, level 3): today's
node is 8 float hashes/px. Keep the direct path under ~16 integer hashes
per pixel at 1080p; anything above routes through a buffer. The Boolean
model at n = 3 is ~27 coverage tests + hashes per channel — Voronoi-class
— and must be plate-only. `npm run bench:nodes` measures default params
only (§4 of TESTING.md), so add a bench variant per model or the ranking
will show the cheap default and nothing else.

---

## 7. Proposed node design

Same `type: "grain"`; the def grows modes. Params use the ParamPanel
`group` / `groupHeader` hint (types.ts) so the panel stays scannable.

### 7.1 Sockets

Inputs: `image` (optional, as today), `plate` (optional image — model I;
a video source works because it is an image per frame), universal `mask`.
Outputs: `image` (primary), aux `grain` (the grain layer alone on 0.5
grey, opaque — for Merge / Displace / matching). A `view` enum
(`result | grain`) mirrors AE's Viewing Mode for quick auditioning without
rewiring.

### 7.2 Params

| group | name | type | default | notes |
| --- | --- | --- | --- | --- |
| — | `preset` | enum | `custom` | AE/Nuke-style: `35mm fine`, `35mm 500T`, `16mm`, `super 8`, `digital ISO 800`, `digital ISO 6400`, `video snow`, `dither 1 LSB`. Physarum's pattern ([physarum.ts:737](../src/nodes/effect/physarum.ts#L737)): non-custom derives the look params from a table; switching to `custom` starts from where the preset left off. Generic gauge/speed names, not trademarks. |
| Model | `model` | enum | `fine` | `classic` (legacy exact) · `fine` (A) · `soft` (D+E) · `film` (G) · `parametric` (H) · `plate` (I) · `sensor` (J) · `video` (K) |
| Model | `size`, `size_unit`, `gauge` | scalar, enum, enum | 1, `px`, `35mm` | §5.7 |
| Model | `softness` | scalar 0..1 | 0.3 | blur σ as a fraction of size (D) |
| Model | `irregularity` | scalar 0..1 | 0.6 | octave mix (E) / radius σ_r (G) |
| Model | `aspect` | scalar 0.25..4 | 1 | L |
| Model | `distribution`, `sparkle` | enum, scalar | `gaussian`, 0 | §5.1 |
| Amount | `luminance`, `chromatic` | scalar | 0.15, 0 | kept; now std in working space |
| Amount | `saturation`, `tint` | scalar, color | 1, none | §5.3 |
| Amount | `channel_intensity`, `channel_size` | vec3 (advanced) | film defaults | Nuke's numbers |
| Amount | `response`, `response_preset` | float_curve, enum | flat | §5.2 |
| Amount | `space` | enum | `display` | §5.4 |
| Motion | `motion` | enum | `animated` | `static` (grain time = `evolution` alone) · `animated` (advances with the project clock) · `looping` (animated, frame index wrapped) |
| Motion | `rate` | scalar fps | 0 (= project fps) | grain frames per second; `fps / N` holds each grain frame N project frames, so a separate hold mode is unnecessary |
| Motion | `smoothness` | scalar frames | 0 | kernel σ, applies in every motion mode; 0 = hard cuts (bare node = new grain every frame) |
| Motion | `loop_frames` | scalar | 120 | visibleIf looping; project frames, converted to whole grain frames |
| Motion | `evolution` | scalar | 0 | **continuous** time offset, wire-able — the smooth successor to animating `seed`; with σ > 0 fractional values blend under the kernel |
| Motion | `drift`, `warp` | scalar | 0, 0 | §4.5 (M6) |
| — | `seed` | scalar int | 0 | which universe; integer semantics (continuous evolution lives in `evolution`) |
| Mix | `mix_mode`, `mix`, `soft_clip`, `view` | enum, scalar, bool, enum | as today, off, `result` | `soft_clip` is M3 |

(M1 implementation note: the spec's first draft had `every frame` /
`hold` / `smooth` as separate motion values. They collapsed into
`animated` + `rate` + `smoothness`: hold is `rate = fps/N`, smooth is
`smoothness > 0`, and making σ a plain param means a wired `evolution`
morphs smoothly in `static` too.)

`evolution` is the answer to the original complaint in one param: wire a
slow ramp (Scene Time × 0.2) with `smoothness` 1 for a continuous morph,
leave it alone for classic per-frame grain, key it for a hitch-free
"settle".

### 7.3 Caching, time, export

- `stable` stays default (cacheable). `fingerprintExtras` = `""` when
  `motion: static`; otherwise the quantised grain-time (§4.1). Wired
  `evolution` already fingerprints by value (`check-scalar-fp`).
- All time from `ctx.tick`; `ctx.frame` never used directly so sub-frame
  Time Offset shifts work. No `simulation`, no `retimeable: false`.
- Plate ring in `ctx.state`, rebuilt on demand, released in `dispose`
  (texture discipline, invariant #3).
- `gatesOutputs: true` if the `grain` aux is skipped when unconsumed
  (TESTING.md §5) — cheap enough that we may just always render it into
  the same pass.

### 7.4 Hash and Gaussian in GLSL

```glsl
uvec3 pcg3d(uvec3 v);                 // shared with Voronoi
vec3  unit01(uvec3 h) { return vec3(h) * (1.0 / 4294967296.0); }
// Two independent N(0,1) from one hash (Box–Muller); .z left for sparkle.
vec2 gauss2(uvec3 key) {
  vec3 u = unit01(pcg3d(key));
  float r = sqrt(-2.0 * log(max(u.x, 1e-7)));
  float a = 6.2831853 * u.y;
  return r * vec2(cos(a), sin(a));
}
```

`key = uvec3(cellX, cellY, frameIndex ^ (seed * 0x9E3779B9u))`. Integer
frame indices up to 2³² never lose precision, so a project that runs for
hours does not degrade.

### 7.5 Engine module

`src/engine/grain.ts` (engine-side, invariant #1): temporal kernel weights
+ norm (`grainKernel(t, sigma, mode)`), the variance-normalisation
factors for spatial blurs (`blurStdFactor(plan)`), size-unit conversion
(`grainSizePx(size, unit, gauge, canvasW, canvasH)`), preset table,
response-curve presets, and the CPU mirror of `gauss2`/`pcg3d` for the
gate. All pure, all testable offline.

### 7.6 Back-compat

Saved nodes have no `model` / `motion`. `migrateLoadedParams` in
[lib/project.ts](../src/lib/project.ts) sets `model: "classic"`,
`motion: "static"` when `model` is absent, and the `classic` path is the
current shader verbatim (float `hash13`, triangular sum, cell floor, seed
as float) — pixel-identical, including a seed wired to Scene Time. New
nodes default to `fine` / `every frame`. Param names `luminance`,
`chromatic`, `scale` (aliased to `size` with `size_unit: px`), `seed`,
`mix_mode`, `mix` keep their meaning (invariant #2). Schema bump noted in
project.ts as usual.

---

## 8. Milestones

- **M1 — foundations (biggest visible fix for the least code).** ✅
  (2026-09-16) Integer `pcg3d` hash (the GLSL now lives beside its TS
  mirror in engine/voronoi-geometry.ts, shared with Voronoi), true
  Gaussian / unit-variance triangular / uniform, frame locking,
  `motion: static | animated | looping` + `rate` + `smoothness` with the
  renormalised moving average, `evolution`, integer `seed`, `classic`
  migration (lib/project.ts), `grain` aux output + `view`. `size > 1`
  already renders a canvas/size plate and upsamples it with the
  variance-normalised B-spline (the plate path M2 builds on), so the
  fine model has a meaningful size from day one; softness / octaves /
  the plate ring are still M2. Gate: `scripts/check-grain.mts` (in
  `npm run check`) — `Σw² = 1` at every fractional time and σ, shift
  invariance, seamless `mod P` wrap, per-frame cache key, CPU mirror
  statistics, migration; the three shaders compile under
  `npm run check:shaders`.
- **M2 — the workhorse.** ✅ (2026-09-16) `soft` model: the noise plate
  blurred by `softness` cells through a dedicated two-pass shader whose
  1-D weights are normalised to Σw² = 1 (the plate is zero-mean noise, so
  variance, not the mean, is what a blur must preserve — `engine/convolve`
  was not reused because its premultiplied path would have scaled the
  signed plate channels by "alpha"), `irregularity` octaves at 2× / 4× cell
  size with (1, ρ, ρ²) weights renormalised to Σw² = 1, `aspect`
  (area-preserving cell stretch, also on `fine`). Size units: `px`,
  `1080p px` (scales with canvas height) and `um 35mm / super 16 / super 8`
  through `size_um` and the gauge width. No plate ring yet: the temporal
  kernel is linear, so blur(Σwₖεₖ) = Σwₖ blur(εₖ) and `smooth` already
  works with `soft` at plate resolution; the ring arrives with the first
  non-linear model (M4). The node bench has no per-node variant hook, so
  per-model cost is a live-profiler question (TESTING.md §3, level 3).
- **M3 — application realism.** ✅ (2026-09-16) `response_preset` /
  `response` curve baked to a 256-entry LUT on the node (flat, negative,
  print, digital, protect highlights, custom); `space` display / linear /
  log with the amount rescaled by the encode-slope ratio at mid grey so
  `luminance` keeps one meaning; `saturation` scales the chromatic
  grain's deviation about its own mean (0 = mono, 1 = today, 2 =
  confetti); `tint` + `tint_amount` as a luminance-correlated bias;
  `per_channel` with `size_r/g/b` (uv zoom of the plates, ≥ 1) and
  `intensity_r/g/b` seeded from Nuke's defaults; `soft_clip` tanh
  shoulders; grain scaled by the input's straight alpha; `preset` table
  (Physarum pattern — the row drives every look param, which hide until
  `custom`). Rows: 35mm fine, 35mm 500T, super 16, super 8, digital ISO
  800, digital ISO 6400 — approximations to tune by eye.
- **M4 — film morphology.** ✅ (2026-09-16) `film`: Boolean disc grains
  in one canvas-resolution pass (`quality` full / half / quarter divides
  it): 3×3 cells of side 2·R₉₅, four candidate grains per cell present
  with probability μ/4, μ = −ln(1−Y_cell)·density·S²/(πE[R²]), log-normal
  radius by `irregularity`, soft edge by `softness`, probabilistic union,
  deviation from the pixel's Y normalised by √(Y(1−Y)). The temporal
  kernel runs inside the pass (the union is non-linear), so cost scales
  with taps — smoothness ≤ 1 is the sensible range here. No plate ring
  after all: nothing needed one.
- **M5 — parametric + plate.** ✅ (2026-09-16) `parametric`: a 128²
  CPU template of separable AR(1) noise (`correlation` ρ, anisotropic by
  `aspect` through the correlation length; s = √((1−ρₓ²)(1−ρ_y²)) keeps
  unit variance; 16-texel warm-up margin) built from the kernel-blended
  white noise (AR is linear, so blending commutes with filtering) and
  uploaded per grain frame, tiled by the GPU in 32-texel blocks at hashed
  origins with AV1's 27/32 · 17/32 seam blend. Its CPU cost is the tap
  count × 20k texels — fine at smoothness 0, noticeable at σ 3. `plate`
  input: the wired image or video minus `plate_center` × `plate_gain`,
  tiled at `plate_scale` px per texel with a hashed offset and flips per
  grain frame, blended by the kernel; unwired falls back to `fine`.
  Match Grain dropped (design Q&A 5).
- **M6 — other families.** ✅ (2026-09-16) `sensor` (fixed pattern,
  row / column banding, coarse chroma blotch — component weights
  renormalised to Σw² = 1), `video` (streak × Size cells, per-line jitter
  and dropout), `kernel: gaussian | bspline` (the 4-tap budget kernel),
  `drift` (Catmull-Rom wander of hashed knots, px/s, wrapped lookup).
  Presets gained `video snow`; the digital presets moved to `sensor`,
  `35mm 500T` to `parametric`, `super 8` to `film`. Not done: `warp`
  (compose with Displace) and the harmonic-bank loop (looping through
  `mod P` frames covers frame-timed loops); STBN assets dropped (Q&A 3).

Spill-over worth its own line: Noise's W slice-blend has the same
variance dip (§4.2) — a `mix` of two fields through smoothstep. The same
`1/sqrt(Σw²)` fix applies there and would remove the contrast pulse when W
animates. Not in this scope.

---

## 9. Design Q&A — decided 2026-09-16

1. **Default motion:** presets decide; a bare node is `every frame`.
2. **`scale` → Size:** the UI label becomes "Size"; the stored param name
   stays `scale` (no keyframe / exposed-param / control migration to get
   wrong). `size_unit` (M2) sits beside it.
3. **STBN / FAST assets:** skipped. Technique F and the M6 asset line are
   out; the golden-ratio fallback is not pursued either.
4. **Plate resolution:** a `quality` enum in the style of Bloom's — exact
   (canvas / size) vs capped plate tiled with variance-preserving seams.
5. **Match Grain:** not wanted. The `plate` input covers "use real grain".
6. **Dither:** ignored for now — no `dither 1 LSB` preset; if it ever
   matters it belongs on the Output node where quantisation happens.

Implementation started the same day with M1 (see § 8).

---

## 10. References

Verified during this pass (fetched 2026-09-16):

- Foundry, *Nuke Reference Guide — Grain*: presets Kodak 5248 / 5279 /
  FX214 / GT5274 / 5217 / 5218; size R 3.3 G 2.9 B 2.5; irregularity 0.6;
  intensity R 0.416 G 0.46 B 0.85; seed 134; "a different grain pattern
  is produced for each frame".
- Wolfe, Morrical, Akenine-Möller, Ramamoorthi, *Spatiotemporal Blue
  Noise Masks*, EGSR 2022 (NVIDIA research page + GameWorks SDK repo):
  blue in space and time; independent per-frame blue noise is temporally
  white; void-and-cluster / simulated-annealing generation.
- Wolfe et al., *Filter-Adapted Spatio-Temporal Sampling*, 2024
  (arXiv 2310.15364; `github.com/electronicarts/fastnoise`): noise
  optimised per spatial (Gaussian/box/binomial) and temporal (EMA,
  Gaussian, box) filter.
- InterDigital, *Versatile Film Grain* (`github.com/InterDigitalInc/
  VersatileFilmGrain`): FGC SEI frequency-filtering and AR modes plus
  AFGS1/AV1, intensity intervals, additive vs multiplicative.
- Unity HDRP *Film Grain*: Type / Texture / Intensity / Response ("the
  less noise there is in brighter areas").
- Newson, Delon, Galerne, *Realistic Film Grain Rendering*, IPOL 2017
  (abstract page only; the PDF could not be rendered here) — Boolean
  model, Monte Carlo, arbitrary zoom, "physically realistic film grain
  model".
- Jarzynski & Olano, *Hash Functions for GPU Rendering*, JCGT 2020 —
  `pcg3d`, already in the repo.

From memory — pages unreachable (403 / empty) during research; verify
before quoting numbers or names in UI copy:

- Adobe After Effects *Add Grain* (Intensity, Size, Softness, Aspect
  Ratio, Channel Intensities/Size, Color: Saturation/Tint, Application:
  Blending Mode/Shadows/Midtones/Highlights, Animation: Animation Speed /
  Animate Smoothly / Random Seed, Blend with Original; film-stock
  presets) and *Match Grain* / *Remove Grain*.
- AV1 specification §7.18.3 film grain synthesis; Norkin & Birkbeck,
  *Film Grain Synthesis for AV1 Video Codec*, DCC 2018 (73×82 / 38×44
  templates, AR lag ≤ 3, 32×32 blocks, (27,17)/(23,22) overlap weights,
  ≤ 14-point scaling function).
- ITU-T H.274 film grain characteristics SEI (frequency-filtering and AR
  models, intensity intervals).
- Unreal Engine 5 *Film Grain* (Intensity, Intensity Shadows / Midtones /
  Highlights, Shadows Max, Highlights Min / Max, Texel Size, Texture).
- Newson et al. IPOL demo defaults (grain radius ≈ 0.1 px, σ_filter ≈
  0.8, ~800 Monte Carlo samples) and the density formula
  `λ(u) = −ln(1−u) / (π(r² + σ_r²))`.
- DaVinci Resolve *Film Grain* OFX (gauge/speed presets, size, strength,
  saturation, softness, texture, tonal range).

Standard results used without citation: Box–Muller, Irwin–Hall,
Ornstein–Uhlenbeck / AR(1) variance identity, `Σw²` variance of linear
combinations, `1/(2σ√π)` std of Gaussian-filtered white noise (numbers in
§4.2 / §3.D recomputed for this doc).
