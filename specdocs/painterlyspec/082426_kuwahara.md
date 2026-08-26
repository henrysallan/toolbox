# Kuwahara node (2026-08-24)

The flagship painterly region filter. Depends on
082426_orientation-field.md (encoding + consumer contract). One node,
two modes — the lineage's dead ends are deliberately not shipped.

## Scope decisions

- **No classic 4-box Kuwahara.** Blocky, and its discrete sector
  selection flickers badly frame-to-frame — fatal in a video tool.
  Papari's generalized form subsumes it at the same cost class.
- **No LUT textures.** Sector weights use the Kyprianidis 2012
  closed-form polynomial approximation — cheaper, no texture
  dependency, and the reason this variant is the one to build for a
  shader pipeline.
- **Anisotropic is the default mode.** Its continuous sector weighting
  + ellipse alignment is what made the technique video-stable; the
  isotropic `generalized` mode stays as the cheaper/rounder stylistic
  option, not the default.

## Node

- **Type/name:** `kuwahara`, "Kuwahara", category `image`, subcategory
  `modifier`, file `src/nodes/effect/kuwahara.ts`.
- **Inputs:** `source` (image), `field` (image, optional — the consumer
  contract: unwired → internal structure tensor at fixed defaults;
  wired → any orientation/velocity field steers the strokes).
- **Output:** image. Universal mask blends effect over source (base
  image input wired ⇒ evaluator blend semantics), universal opacity via
  `OPACITY_PARAM`.
- **Params:**
  - `radius` — brush radius in px (default 6, softMax 24; escape hatch
    beyond). Cost is O(radius²) per pixel; see Cost.
  - `mode` — `anisotropic` (default) / `generalized`.
  - `sharpness` — the q exponent on inverse sector variance (how hard
    the winning sector dominates; low = soft blend, high = crisp
    facets).
  - `hardness` — sector-boundary softness of the polynomial weights.
  - `anisotropy` (visibleIf anisotropic) — scales the ellipse
    eccentricity driven by field coherence (B). At 0 the ellipse is a
    circle (≡ generalized); at 1 the standard α mapping; above 1
    exaggerated streaking. **B = 0 fields (plain velocity producers)
    therefore behave isotropically by default** — honest, and the
    `min_coherence` floor param (default 0) lets a user force elliptic
    strokes from a velocity-only field.
  - `smooth` (visibleIf field unwired… params can't see wires — so:
    always visible, labeled "Internal Field Smooth", ignored when
    `field` is wired; doc row notes it) — internal tensor σ.
- **Passes:** [3 internal field passes when unwired] → one filter pass.
  The filter pass walks the (2r+1)² disc once, accumulating mean +
  second moment into N = 8 sector accumulators via the polynomial
  weight function evaluated in ellipse-transformed coordinates
  (rotate by tangent angle, scale axes by 1±anisotropy·A), then blends
  sector means by inverse-variance^q. Arrays of 8 vec4 accumulators —
  watch register pressure on the fragment shader; if a mid-tier GPU
  chokes, split RGB/A accumulation before splitting sectors.
- Premultiply rule per the infrastructure spec (sector means in
  premultiplied color; un-premultiply out; clamp alpha low).
- Pure + stateless → normal caching. Paused editing costs nothing on
  static graphs.

## Cost & the multi-scale question

radius 24 ≈ 2400 taps/px — heavy at 4K but honest, and `bench:nodes`
will rank it. Kyprianidis 2011's pyramid variant (large radii at
pyramid cost, less mush) is **M2, only if users actually push radius**:
it changes the pass structure (mip build + per-level filter + join) for
a benefit that starts around radius > ~16. Don't build it
speculatively.

## Presets

Add-menu preset "Painterly" (state/presets.ts canned fragment):
Image Flow Field → Kuwahara (anisotropic) → Coherence Shock → Line Art
(XDoG, multiply-composited via Merge) — the research's "covers most of
what people mean by painterly" stack, shipped as a preset instead of a
modes-monolith node. The graph IS the convenience wrapper here; a
Painterly meganode would recompute the tensor per mode and hide the
composability that makes this app interesting.

## Verification

- `npm run typecheck && npm run check && npm run check:shaders`.
- Look checks (live app): sector facets follow a circle rim (wire
  Image Flow Field explicitly, then unwire — identical result at the
  same smooth value proves the internal path); Perlin `curl` wired into
  `field` with `min_coherence` 0.8 → streaks along the noise flow.
- Temporal: scrub a video source — no per-frame sector popping at
  default params (the reason this variant exists).
- `npm run bench:nodes` at radius 6 and 24; record both in the spec's
  PR notes.

## Milestones

- **M1:** node with both modes, internal field fallback, preset wired
  once shock + line art exist (until then the preset ships as
  Flow Field → Kuwahara only).
- **M2 (demand-gated):** pyramid multi-scale for large radii.
