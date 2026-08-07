# Blur — unified convolution node (2026-08-02)

Status: **M1 + M2 implemented** (M1 2026-08-03, M2 2026-08-05). M3–M4
designed, not built. Deviations from the original spec are marked ⚠
inline.

One `blur` node with a mode dropdown, over a shared engine-side convolution
core: premultiplied + linear-light boundary, N separable passes, weighted
recombine. Modes are **Gaussian** / **Bokeh** (complex separable circular +
procedural apertures) / **Convolve** (arbitrary kernel image, low-rank or
exact). `gaussian-blur` stays registered as a hidden alias of the same def.

## Motivation

[gaussian-blur.ts](../src/nodes/effect/gaussian-blur.ts) is 122 lines and is
the entire convolution story in the app. The Gaussian is the only
circularly-symmetric kernel that is linearly separable, which is exactly why
every blur in the tool reads soft and cheap — there is no way to get a
flat-topped disc with a hot rim out of it. That disc is most of the visual
gap between this and a real compositor.

Two correctness bugs ride along in the current node, and both get worse the
moment the kernel stops being a Gaussian:

- **It convolves straight alpha.** The engine is straight-alpha throughout
  (invariant #4) and `BLUR_FS` filters all four channels independently. The
  correct operation is premultiply → convolve → unpremultiply. A Gaussian's
  softness hides the fringing; a disc kernel with a bright rim will not, and
  it will read as "the new blur is broken."
- **It blurs in display space.** Nothing in the path linearizes, so
  highlights average toward dim grey instead of blowing out. This single
  change is most of what makes a blur look expensive.

Both are fixed once, in the core's boundary pass, so every mode inherits
them.

## Load-bearing constraints

**1. The texture pool is 16-bit; the FFT can't ride it.** `allocTexture` in
[gl.ts](../src/engine/gl.ts) only ever creates RGBA16F/R16F (RGBA8/R8
without `EXT_color_buffer_float`). Half-float carries a 10-bit mantissa, an
FFT compounds relative error across log2(N) butterfly stages, and the DC bin
accumulates ~N× the mean magnitude. So **`fft.ts` owns its own RGBA32F
targets outside `ctx.allocImage`.** RGBA32F is color-renderable in WebGL2
whenever `EXT_color_buffer_float` is present (already detected as
`hasColorBufferFloat`), and the FFT reads via `texelFetch`, so it needs no
float *linear* filtering. Corollary: **on the RGBA8 fallback path the exact
tier is unavailable** and must degrade to low-rank rather than render
garbage.

**2. No WebGPU in the hot path.** The WebGL↔WebGPU bridge is CPU-mediated
Float32Array, documented as fine ≤ ~1MB. A 1080p RGBA16F frame is ~16MB and
4K is ~66MB, so two round-trips per frame would eat the entire
"cost independent of kernel size" win that justifies the FFT. It ships as
WebGL2 ping-pong, `backend: "webgl2"` like every other mode. The transform is
swappable for a WebGPU Stockham compute FFT with **no node-level change**
once a shared-texture path exists — that's the intended improvement path,
not a rewrite.

**3. Engine self-containment** (invariant #1): the core lives in
`src/engine/convolve/`, no imports from `components/`, `state/`, or `lib/`.

**4. Saved-project back-compat** (invariant #2): the `gaussian-blur` type
string, its `radius` param, and the `sigma = radius × 0.5` mapping are
frozen.

**5. Texture discipline** (invariant #3): the core allocates and releases
every intermediate; it never releases its input.

## The one-backend thesis

Complex separable phasors and low-rank SVD are two ways to produce the same
execution shape — *N separable passes, weighted recombine* — so they are one
backend with two plan builders, not two features. The routing is invisible
to the user:

- **Circularly symmetric** apertures (disc, ring, soft) have analytic
  complex-phasor coefficients. Cheapest, exact-ish, no precompute.
- **Everything else** (hexagon, octagon, cat's-eye, star, and any user
  kernel image) rasterizes an aperture and runs SVD low-rank over it.

This matters for the node interface: the complex-separable trick only spans
circularly-symmetric kernels, so a naive design would strand "hexagonal
bokeh" in a different mode from "disc bokeh" — which is not how anyone
thinks about an aperture. Instead **Bokeh mode's `shape` enum covers both
families** and the backend picks the decomposition. `kernels.ts` owns the
aperture rasterizer and is shared by Bokeh's polygonal shapes and Convolve's
no-kernel-wired fallback.

## Node interface

Type `blur`, name **Blur**, category `image` / subcategory `modifier`.
`mode` gets `headerControl: { paramName: "mode" }` so it's switchable
without opening the panel — the Collect-family precedent, and warranted here
because the mode retypes the node's sockets.

**Common**

| param | type | notes |
| --- | --- | --- |
| `mode` | enum `gaussian` \| `bokeh` \| `convolve` | header control. `convolve` landed in M2 as planned — the options list grew, which needs no migration since saved values are strings. |
| `radius` | scalar px | min 0, **softMax 200**, no hard `max` — today's `max: 20` is the escape-hatch case `softMax` exists for. Default 0. |
| `linearize` | boolean | **default true.** "Blur in linear light" |

**Bokeh** (`visibleIf mode === "bokeh"`)

| param | type | notes |
| --- | --- | --- |
| `shape` | enum `disc` \| `ring` \| `soft` \| `hexagon` \| `octagon` \| `cats_eye` \| `star` | routes the decomposition. The first three are complex phasors; the rest rasterize (kernels.ts) and go through SVD. |
| `components` | int 1–4 | **⚠ Default 3, not 2.** Measured rather than assumed — see below. |
| `ring` | scalar 0–1 | donut-ness, `visibleIf shape === "ring"` |
| `rotation` | scalar deg | polygonal + cat's-eye only |

**Convolve** (`visibleIf mode === "convolve"`)

| param | type | notes |
| --- | --- | --- |
| `quality` | enum `low_rank` \| `exact` | ⚠ deferred to M3 — a two-option enum with only one option implemented is worse than no enum. Arrives with the FFT. |
| `rank` | int 1–8 | default 4. Also drives the polygonal bokeh shapes, which use the same decomposition. |
| `kernel_scale` | scalar | ⚠ **cut.** `radius` already sets the kernel's extent, so this was a second control over one thing. The whole kernel image is the kernel; `radius` says how far it reaches. |
| `normalize` | boolean | default true; divide by kernel sum so energy is preserved |
| `rotation` | scalar deg | polygonal + cat's-eye only |

**Inputs** — `resolveInputs` keyed off `mode`: `image` (required, always),
`kernel` (image, `mode === "convolve"`), `radius_map` (mask, M4). The
evaluator appends the universal `mask` on top.

> ⚠ **Two mask-ish inputs.** The universal `mask` blends the effect in;
> `radius_map` drives per-pixel radius. This is exactly the Text
> `mask`/`morph_mask` hazard the devguide already calls out — hence the
> explicit `radius_map` name rather than anything shorter.

## Architecture

```
src/engine/convolve/
  boundary.ts   premultiply + optional sRGB→linear in, inverse out
  index.ts      runSeparable(ctx, src, plan) — the N-pass + recombine core
  complex.ts    complex-phasor coefficient tables (1–4 components)
  svd.ts        kernel image → rank-r separable decomposition (CPU, cached)
  kernels.ts    procedural aperture raster (disc/ring/polygon/cat's-eye/star)
  fft.ts        the exact tier — owns its RGBA32F ping-pong targets
src/nodes/effect/blur.ts   the one NodeDefinition; thin dispatcher
```

**`boundary.ts` is the only place the alpha/colour convention is touched.**
One fullscreen pass in (premultiply, optionally sRGB→linear), one out (the
inverse). Every mode inherits correctness from it, and it is the single
place to audit when either convention changes.

**`index.ts`** takes a `SeparablePlan`:

```ts
type SeparablePlan = {
  components: ComponentPass[];   // each: 1D H taps, 1D V taps, recombine weight
  radiusSource:                  // ← shaped for M4 from day one
    | { kind: "uniform"; radius: number }
    | { kind: "map"; tex: WebGLTexture; min: number; max: number };
};
```

boundary-in → for each component { H pass → V pass } → weighted recombine →
boundary-out. Component intermediates are pool allocs, released before
return. **`radiusSource` carries the M4 shape from M1** — retrofitting
uniform→per-pixel through the core would touch every plan builder, so the
discriminant goes in now even though only `uniform` is constructed until M4.

**`svd.ts`** runs a one-sided Jacobi SVD on the greyscale kernel matrix
(≤129×129, CPU, sub-millisecond) and caches the result in a `WeakMap` keyed
on the kernel's `ImageValue` object — the devguide explicitly blesses
value-object identity as an "upstream recomputed" signal, so a static kernel
decomposes exactly once.

**`fft.ts`** — pow2 pad to ≥ (image + kernel − 1) per axis, zero-pad
(correct against premultiplied data, and matches how the engine treats
offscreen elsewhere). **Stockham** formulation, not Cooley-Tukey: it carries
its own data permutation, so fragment ping-pong needs no bit-reversal pass.
Two RGBA32F targets, one holding all four channels' real parts and one the
imaginary — so a full RGBA transform costs the same pass count as a single
channel. The kernel spectrum is precomputed once per (kernel, padded size)
and cached alongside the SVD cache. At 1080p padded to 2048 that's ~11
passes × 2 axes × 2 directions ≈ 44 fullscreen passes plus the complex
multiply — not free, but flat in radius, which is the whole point.

## Back-compat

- New def registers as type `blur`.
- `{ ...blurDef, type: "gaussian-blur", hidden: true }` — same compute,
  `mode` defaulting to `"gaussian"`, `sigma = radius × 0.5` preserved
  exactly. One code path, old saves keep loading, no duplicate menu entry.
- `migrateLoadedParams` ([project.ts](../src/lib/project.ts)) writes
  `linearize: false` onto any loaded `gaussian-blur` node whose `linearize`
  is undefined. **Old work stays colour-stable; new Blur nodes default on.**
- **Premultiply is deliberately NOT migrated.** It's a bugfix, not an
  aesthetic default, so existing projects' soft edges will lose their dark
  fringe. Intentional visual change, called out here so it isn't a surprise
  in review.
- Additive params only — **no schema bump** (stays 9).

## What M1 actually took (verified findings)

No hardcoded coefficient table ships. `complex.ts` fits (A, B) by least
squares against a target radial profile, which is what makes `disc` /
`ring` / `soft` one solver instead of three tables. Three things only
showed up once it was running:

- **⚠ The 2-parameter search was not good enough.** Constraining
  (a_j, b_j) to damped harmonics — a_j = aScale·(j+1), b_j = bScale·(j+1)
  — is a 2-parameter slice through a 2N-parameter space, and it is not
  even monotonic in component count: **4 components fit the disc WORSE
  than 3**, which would have shipped as "bokeh looks lumpy at high
  quality." The harmonic grid is now only the starting guess, followed by
  coordinate descent on each (a_j, b_j) independently. After that,
  undershoot falls monotonically 14.4% → 8.6% → 7.4% → 7.3% of peak
  across 1→4 components, and energy landing outside the nominal radius
  falls 4.1% → 0.86% → 0.10% → −0.28%.

- **⚠ Kernel undershoot produced NEGATIVE ALPHA.** A hard-edged kernel
  rings, and just outside a sharp boundary the dip goes below zero. In
  colour that is honest ringing; in alpha it is a negative coverage,
  which source-over downstream would composite as anti-coverage, and
  which the un-premultiply divide would use to flip the colour's sign.
  Measured at 156 negative-alpha pixels on a 2-component disc.
  `boundary.ts` now clamps alpha (and colour) at zero on the way out —
  **low only**, so HDR above 1 still passes through and highlights keep
  blooming into the kernel's shape.

- **⚠ `components: 1` renders rounded SQUARES, not discs.** The fit is
  poor enough at one component that the separable square support shows
  straight through. It is kept as a legal value (cheapest, and it is a
  usable soft look) but it is not a sensible default, and the default
  moved to 3 — the point where the disc goes properly flat, 8× less
  stray energy than 2, versus a slightly crisper edge for 3 more passes
  at 4.

Verification was the Electron GLSL/GPU harness (see the memory note on
headless shader checking): the real node against the real backend, with
pixel readback plus rendered PNGs. Confirmed no NaN, alpha energy
preserved to within 0.5%, a constant-coverage region round-tripping
through premultiply exactly, and — the actual point — Gaussian producing
soft blobs where `disc` produces hard-edged filled circles.

**Known limitations measured, not fixed:**

- Above `MAX_HALF_TAPS` (128) the tap stride exceeds 1px and the kernel
  undersamples. At radius 200 the disc profile visibly aliases. Bilinear
  filtering covers the mild case; the real fix is pre-downsampling the
  source, which M4's tile machinery wants anyway.
- A radius large relative to the canvas drives alpha very low, and
  un-premultiplying through a near-zero alpha amplifies half-float noise
  (measured RGB drift at radius 200 on a 192px canvas). Pathological
  case; noted rather than special-cased.
- ⚠ The M1 gate below says "pixel-identical". Weight tables ride an
  RGBA16F texture, so it is identical to within half-float weight
  quantization (~0.05% on the sum), not bit-exact.

## What M2 actually took

**⚠ `ComponentPass` became a discriminated union, and the SVD path got its
own shader pair** rather than generalizing M1's. The two structures really
are different: a complex component's kernel is EVEN, so its taps are a
half table that the shader mirrors and its recombination folds into the
vertical pass (2 horizontal + 1 vertical); an SVD term is an arbitrary
kernel, so it needs a full unmirrored table and is a plain real
convolution (1 horizontal + 1 vertical). Generalizing M1's shaders to
cover both would have meant per-tap branching in the verified-and-shipped
bokeh path for no gain. Additive instead: zero regression risk, and
`runSeparable` dispatches on `kind`.

**⚠ `rank` is a separate param from `components`, not one "quality" knob.**
They cap differently (4 vs 8) and mean different things — number of
complex phasor components versus number of rank-1 SVD terms. One slider
with two meanings reads simpler in a table and worse in the panel.

**The orientation flip is the part that needed real verification.** Cell
(row, col) of a screen-order kernel is a displacement of (col−h) right and
(row−h) down; true convolution samples `src(p − d)` so a point light
renders the aperture as drawn rather than rotated 180°; and the shaders
sample in Y-UP UV. Working it through, **exactly one axis reverses** —
columns — because on the row axis the convolution flip and the
screen-down/UV-up flip cancel. If both axes reverse, or neither, an
asymmetric kernel renders mirrored and no symmetric test would ever catch
it. Verified with a deliberately asymmetric Γ-shaped kernel: the rendered
highlights match the kernel image orientation exactly.

Kernel matrices cap at 65×65 (`MAX_KERNEL_HALF` 32), well under the
separable tap ceiling — the SVD is O(rank·n²) on the CPU and the visual
return flattens out well before that. Image kernels are cached in a
WeakMap keyed on the kernel `ImageValue` object (the devguide-sanctioned
"upstream recomputed" signal), so a static kernel pays the GPU readback
and the decomposition exactly once. Procedural apertures cache by
shape/size/rotation/rank in a plain Map — no GPU round trip at all, since
they rasterize on the CPU.

Verified on GPU: hexagon/octagon/star/cat's-eye all render as their
shapes with rotation working, arbitrary image kernels reproduce the drawn
kernel at every highlight, no NaN, no negative alpha on any SVD path (the
kernels are non-negative, so unlike the analytic disc there is no ringing
undershoot to clamp), and the M1 circular path is byte-for-byte unchanged
in behavior.

## Milestones

**M1 — core + Gaussian + Bokeh.** ✅ Shipped 2026-08-03. `boundary.ts`, `index.ts` with the full
`SeparablePlan` shape, `complex.ts`, `kernels.ts`, the node with all three
modes present but Convolve stubbed. Ships the premultiply/linear fix and the
disc. Verify by A/B against the current node: `mode: gaussian`,
`linearize: false` must be pixel-identical to today at the same radius.

**M2 — Convolve.** ✅ Shipped 2026-08-05. `svd.ts`, the `kernel` input socket, `rank`, and Bokeh's
polygonal shapes routing through the same decomposition. This is where "blur
by an arbitrary image you drop in" lands.

**M3 — exact tier.** `fft.ts` + the `quality` param, with the RGBA8-fallback
degrade path.

**M4 — spatially varying.** `radius_map` input, the `{ kind: "map" }` arm of
`radiusSource`, tile-based max-radius scatter-gather (Jimenez / Abadie) so
bright small things bloom into discs rather than smearing.

## Risks & open questions

- **1-component ringing** is severe enough to look like a bug. Default
  `components: 2`; consider hiding 1 behind the softMax-style escape hatch
  rather than offering it as a normal choice.
- **Low-rank kernels can go negative.** A rank-4 approximation of a hard
  aperture overshoots into negative lobes; clamp at recombine and accept the
  slight energy error, or renormalize. Decide against real kernels in M2.
- **`stable` / caching.** Every mode here is deterministic in its params and
  inputs, so the node stays `stable: true` (the default) and the fingerprint
  cache does the right thing. The kernel image arriving from a `stable:false`
  upstream is handled by the WeakMap keying, not by the node.
- Deferred deliberately: Laplacian kernel splatting (no reference
  implementation, from-paper only), and graph-level kernel fusion (two
  chained Gaussians collapsing to one) — the evaluator is a per-node
  fingerprint cache over a registry that is deliberately "a Map, nothing
  more", and cross-node rewriting is a large architectural cost for what is
  really user error.

## Follow-on (not in this spec)

**Structure tensor as a shared field.** The highest-leverage thing after
this, and it fits the codebase's grain exactly: it should be a documented
wire convention plus engine helpers, the literal sibling of
[velocity-field.ts](../src/engine/velocity-field.ts) (signed-RG image,
documented midlevel and orientation, isotropic units). Compute the tensor
field once, expose it as a node output, and "blur along the flow" becomes a
primitive that anisotropic Kuwahara, flow-based DoG, LIC, and edge-following
smear all fall out of. Worth its own spec.
