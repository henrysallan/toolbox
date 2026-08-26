# Line Art node — XDoG / FDoG (2026-08-24)

The "ink" layer: nearly every good painterly composite is a region
filter (Kuwahara / bilateral / shock) with a line layer over it. One
node covers the family — XDoG's tunable soft threshold sweeps from
clean line art through charcoal to hatching, and flow integration
(FDoG) is a toggle on the same machinery, not a second node.

Depends on 082426_orientation-field.md (consumer contract). Distinct
from Edge Detect (Sobel/Prewitt gradient magnitude — a measurement);
this node is a STYLIZATION with authored thresholds and coherent,
hand-drawn-looking contours.

## Node

- **Type/name:** `line-art`, "Line Art", `src/nodes/effect/line-art.ts`,
  category `image` / `modifier`.
- **Inputs:** `source` (image), `field` (optional; used only when
  `flow` is on — consumer contract fallback applies), `paper`
  (optional mask — modulates the threshold per-pixel for
  hatching/charcoal texture; wire noise, a scan, or the Image Flow
  Field `coherence` aux).
- **Output:** image — **ink on transparency** (straight alpha, ink
  color × coverage), so it composites over any region filter through
  Merge without a matte step. `invert` swaps to paper-on-transparency.
- **Params:**
  - `flow` (bool, default on) — off: isotropic XDoG (two Gaussian
    blurs, difference); on: FDoG — the DoG is taken 1D ACROSS the flow
    (gradient axis), then integrated ALONG the tangent streamline
    (sign-coherent walk, `coherentStep`), which is what makes contours
    coherent instead of speckly.
  - `size` — σ of the smaller Gaussian (px).
  - `contrast` (k) — σ ratio (default 1.6).
  - `sharpen` (p) — the XDoG sharpening weight on the fine pass.
  - `threshold` (ε) and `softness` (φ) — the tanh soft threshold. φ
    high = binary line art; low = continuous charcoal tones.
  - `flow_length` (visibleIf flow) — tangent integration half-length.
  - `color` (ink color, alpha-capable per the archive/072026_color-alpha
    opt-in rules — the spline-raster hex path is the safe parse
    precedent; verify the local parse handles 8 digits before enabling).
- **Passes:** flow off — 2 blur passes + 1 combine. Flow on — 1
  across-flow 1D DoG pass + 1 along-flow integration pass + combine.
  All small separable passes; pool textures; release intermediates.
- Luminance input is coverage-weighted (`lum × a`, matching the
  orientation-field spec) so silhouettes on transparency contour their
  actual shape.
- Universal mask + opacity as usual.

## Composite pattern (docs + preset material)

- Toon: Flow Bilateral → Posterize (luma, soft — see
  082426_painterly-non-flow.md) → Merge ← Line Art (source-over).
- Painterly: the 082426_kuwahara.md preset gains Line Art multiplied
  over the shock output.
- Hatching: `paper` = tiled directional noise, φ low, threshold mid —
  worth shipping as a third preset once the node lands.

## Verification

- `typecheck` / `check` / `check:shaders`.
- Probes: flow off vs on over a photo — FDoG must visibly consolidate
  broken contours; φ sweep from ~0.01 → 100 must move smoothly from
  charcoal to binary with no banding step; ink-on-transparency alpha
  verified over a colored backdrop through Merge (no dark fringe —
  straight-alpha discipline).
- Temporal: video source, flow on — contour crawl should be visibly
  calmer than Edge Detect on the same footage; that's the demo.
- `bench:nodes`.

## Milestones

Single milestone — the node with both paths and the `paper` input.
(Presets ride the other specs' milestones.)
