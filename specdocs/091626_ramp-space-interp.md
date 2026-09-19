# Ramp color space + interpolation curves (spec, 2026-09-16)

Every color ramp in the app (Color Ramp, Rasterize Spline fill / stroke /
gradient fill, Stroke, Diffusion Curves, ASCII, Shape Cells, SDF Material,
Instance Color, 3D Material toon bands) now samples through one engine
sampler with two orthogonal choices:

- `*_interp` — the **curve**: how the blend factor moves between stops.
- `*_space` — the **color space** the blend happens in.

## Problem

All ramps lerped 0–255 sRGB per channel with three curves (linear / ease /
constant). Two visible flaws: a muddy, darkened middle between saturated
hues (the sRGB "grey dead zone"), and either a kink at every stop
(linear) or a flat plateau around every stop (ease). Each backend also
carried its own copy of the math — a CPU string sampler, a float sampler,
three GLSL walkers (Color Ramp, ASCII ×2, Shape Cells), and two CPU LUT
bakes — so adding a mode meant six ports.

## Decision (design Q&A, 2026-09-16)

Spaces: sRGB (legacy default), linear RGB, OKLab, OKLCH short hue, OKLCH
long hue. HSL was considered and dropped (vivid but lightness wobbles);
CIELAB dropped in favour of OKLab (same job, no blue→purple drift).

Curves: linear, ease (smoothstep), smoother (quintic), sine, ease in, ease
out, cardinal (Catmull-Rom), monotone (Fritsch–Carlson), B-spline, Gaussian
smooth, constant. Per-stop midpoints were left out — they change the stop
schema, not the mode.

Dithering and premultiplied-alpha blending were surveyed and not taken.

**One sampler, every backend.** `makeColorRampSampler(stops, {interp,
space})` in engine/color-ramp.ts sorts + parses + converts the stops once,
fits tangents / bakes the smooth buffer once, and returns `(t, offset) →
rgba01`. `sampleColorRamp` (rgba() string) and `sampleColorRampRgba01`
wrap it for one-shot use and gained a fifth `space` argument. GPU nodes
bake a 1024-texel RGBA16F LUT from the same sampler (`getColorRampLut`,
cached per node in `ctx.state`, released in `dispose`) and read it with
one filtered fetch (`colorRampLutGlsl`); `constant` snaps to texel centres
in-shader so its steps stay hard (positions quantized to 1/1024). The
per-stop GLSL walkers are gone.

**Curve semantics.** Stops sorted by position, `t` clamped to the outer
stops, straight alpha interpolated with the same curve as color, `offset`
applied before evaluation (`offsetRampT`), so one sampler serves every
per-copy phase.

- Per-interval eases (`ease`, `smoother`, `sine`, `ease_in` = f²,
  `ease_out` = 1−(1−f)²) remap the bracket's blend factor.
- `cardinal`: Hermite through the stops with centred finite-difference
  tangents on the non-uniform knots (one-sided at the ends). C¹, no
  plateaus, can overshoot — the documented trade.
- `monotone`: same Hermite with Fritsch–Carlson-limited tangents; never
  leaves the range of the two bracketing stops.
- `bspline`: the stops are control points. Written in Hermite form (knot
  value (P₋₁+4P₀+P₁)/6, centred-difference tangent), which is exactly the
  uniform cubic B-spline for even spacing and stays C¹ for uneven. End
  phantoms are reflections (2P₀−P₁) so the ramp lands on its end colors;
  interior stops are approximated, not pinned.
- `smooth`: Gaussian blur of the linear ramp along t, σ = 4% of the ramp
  (`COLOR_RAMP_SMOOTH_SIGMA`, fixed; a width control is additive later).
  The signal is extended past each end by point reflection so the ends
  stay exact.
- `constant`: holds the left stop. Never mixes, so `space` is moot.

**Space semantics.** Stops convert to the working space, the curve runs
there, the result converts back and clamps.

- `linear`: decode → mix → encode.
- `oklab`: straight line in OKLab (the keyframe engine's color space;
  the conversions moved to engine/color-space.ts and are shared).
- `oklch` / `oklch_long`: polar OKLab. Hues are unwrapped across the
  sorted stops BEFORE the curve is fitted (CSS Color 4 `shorter` /
  `longer` rules per interval; achromatic stops borrow the nearest
  chromatic neighbour's hue). Out-of-gamut results are gamut-mapped the
  CSS way: keep L and hue, binary-search chroma down until it fits. Two
  identical hues under `oklch_long` make a full turn (rainbow), as CSS.

**Canvas2D (Rasterize Spline gradient fill).** `rampToGradientStops`
subdivides each knot interval into 16 linear segments whenever the true
ramp is not a straight sRGB line (any curve but linear, or any space but
sRGB); linear × sRGB stays one stop per ramp stop and constant keeps its
doubled stops. `makeSubpathGradientFn` builds one sampler and reuses it
across every quantized per-copy phase.

**Back-compat.** Saved params hold one of the original three interp
values, which are unchanged in meaning; `space` is absent and reads as
`srgb` (`normalizeRampSpace`), so every existing project renders
identically. Unknown values normalize to the defaults. `ColorRampValue`
carries `space` alongside `interp` (still not applied at the wired end).

Not covered: the ramp editor's CSS preview bar still draws linear sRGB
(it has no access to its sibling params); GLSL Expression `ramp()`
channels stay linear (no interp param there); dithering; per-stop
midpoints; premultiplied alpha.

## Params

Every ramp-bearing node declares its interp enum via `rampInterpParam`
and a sibling space enum via `rampSpaceParam` (shared options + labels):

| node | interp | space | default interp |
| --- | --- | --- | --- |
| Color Ramp | `interpolation` | `space` | linear |
| Rasterize Spline fill / gradient | `ramp_interp` | `ramp_space` | linear |
| Rasterize Spline stroke | `stroke_ramp_interp` | `stroke_ramp_space` | linear |
| Stroke | `ramp_interp` | `ramp_space` | linear |
| Diffusion Curves | `ramp_interp` | `ramp_space` | linear |
| ASCII fg / bg | `fg_ramp_interp` / `bg_ramp_interp` | `fg_ramp_space` / `bg_ramp_space` | linear |
| Shape Cells | `interpolation` | `space` | constant |
| SDF Material | `interpolation` | `space` | linear |
| Instance Color | `ramp_interp` | `ramp_space` | linear |
| Material (toon) | `toon_interp` | `toon_space` | constant |

Space default is always `srgb`.

## Code

- [engine/color-space.ts](../src/engine/color-space.ts) — sRGB ↔ linear ↔
  OKLab ↔ OKLCH, CSS-style chroma-reduction gamut map. Shared with
  keyframes.ts.
- [engine/color-ramp.ts](../src/engine/color-ramp.ts) — option
  vocabularies + labels, `normalizeRamp*`, `rampInterpParam` /
  `rampSpaceParam`, `makeColorRampSampler`, `buildColorRampLutData`,
  `getColorRampLut` / `releaseColorRampLut`, `colorRampLutGlsl`.
- [engine/spline-gradient-fill.ts](../src/engine/spline-gradient-fill.ts) —
  subdivision rule, prebuilt sampler per gradient fn.
- [scripts/check-color-ramp.mts](../scripts/check-color-ramp.mts) — every
  curve lands on the stops (or approximates, for bspline), monotone never
  overshoots, splines are C¹ at a stop where linear kinks, per-interval
  eases match their formulas, OKLab mid-grey L = 0.5, OKLCH short vs long
  hue direction + gamut, grey-stop hue borrowing, LUT texel-centre bake,
  every node declares the full vocabulary. In `npm run check`.
- [scripts/check-gradient-fill.mts](../scripts/check-gradient-fill.mts) —
  subdivision for non-sRGB / non-linear, constant ignores space.
- [scripts/emit-shaders.mts](../scripts/emit-shaders.mts) — the Color Ramp,
  ASCII main and Shape Cells shaders (the three `colorRampLutGlsl` hosts)
  now compile + link under `npm run check:shaders`.

## Milestones

- **M1 — space + interp everywhere.** ✅ (2026-09-16) Everything above.
- **M2 (open) — ramp editor preview** honours interp/space (needs sibling
  param access in `ColorRampControl`; Chromium supports
  `linear-gradient(in oklch …)` natively).
- **M3 (open) — dithering** on the GPU ramp paths; GPU gradient fill
  (091026 M2) to escape the 8-bit Canvas.
