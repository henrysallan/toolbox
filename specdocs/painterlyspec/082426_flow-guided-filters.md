# Flow-guided filters: Flow Blur, Coherence Shock, Flow Bilateral (2026-08-24)

Three nodes that consume the orientation field
(082426_orientation-field.md) with different operators. Each is its own
node — same granularity as Blur / Sharpen / Edge Detect — and all three
follow the consumer contract (optional `field` input, internal tensor
fallback, premultiply rule, aspect-scaled Y steps).

All are pure/stateless → normal fingerprint caching, scrub-safe,
offline-exact. None is a simulation.

---

## 1. Flow Blur (line integral convolution)

Smear each pixel along the streamline of the field — the Van Gogh
operator, and (fed white noise) THE standard field visualization.

- **Type/name:** `flow-blur`, "Flow Blur", `src/nodes/effect/flow-blur.ts`,
  category `image` / `modifier`.
- **Inputs:** `source` (image), `field` (optional — consumer contract).
  Unlike Advect Image (which back-traces to a single source sample),
  this AVERAGES the samples along the ±walk: a 1D blur bent along the
  flow. Kinship note for the docs page: Advect = transport, Flow Blur
  = smear.
- **Params:** `length` (canvas-width units, the ± integration
  half-length), `samples` (per side, default 16, softMax 48),
  `falloff` (`box` / `gauss`), `mode` (`tangent` default / `velocity` —
  velocity mode walks the field's RG as a velocity, tangent mode walks
  sign-coherently via `coherentStep` so π-periodic orientation fields
  don't kink at the canonicalization seam).
- **Pass structure:** single pass, two inner walks (±), re-sampling the
  field each step (curved streamlines, the Advect Image precedent).
  Step rule `uv ± vec2(t.x, -t.y*aspect) * k` per the convention.
- Universal mask/opacity as usual.

Cost: samples × 2 field reads + source reads per pixel — comparable to
Advect Image at equal steps; bench it.

---

## 2. Coherence Shock (`shock-filter`)

Smooth along the flow, sharpen across it via directional
dilation/erosion — the strongest single painterly operator in the
literature; produces the crisp fluid brush edges Kuwahara can't.
(Weickert 2003; Kyprianidis & Kang 2011.)

- **Type/name:** `shock-filter`, "Coherence Shock",
  `src/nodes/effect/shock-filter.ts`, category `image` / `modifier`.
- **Inputs:** `source`, `field` (optional).
- **Params:** `iterations` (1–8, default 3), `radius` (px reach of the
  directional min/max per iteration), `smooth_along` (σ of the
  along-flow blur per iteration), `amount` (blend of shock result over
  the smoothed base).
- **Per iteration, 3 passes:** (a) 1D Gaussian along tangent (the flow
  smoothing); (b) second-derivative sign across the flow (gradient
  direction) — Laplacian-of-smoothed sampled along the gradient axis;
  (c) directional dilate/erode: walk ± along the GRADIENT direction
  `radius` px, take max where the sign says ridge, min where valley.
  Ping-pong two pool textures across iterations; release intermediates
  before returning (texture discipline).
- **Temporal note (the research's warning, resolved):** iterative ≠
  stateful. Iterations run to completion inside one compute — a pure
  function of (source, field, params) — so there is nothing to drift
  between frames. The actual temporal risk is the ACROSS-frame
  stability of the field itself, which is why the internal fallback
  uses the tensor (not per-pixel gradient) estimate. Do not "optimize"
  this into a one-iteration-per-frame accumulator; that would need
  simulation semantics (state, preroll, reset) for zero benefit.
- **Field is sampled once per iteration from the SAME input field** —
  the reference re-estimates orientation per iteration on the evolving
  image; we deliberately don't (cost, and the fixed field is more
  stable for animation). Escape hatch if the look demands it: `refine`
  bool (M2) re-runs the internal tensor between iterations; wired
  fields never refine.

---

## 3. Flow Bilateral (`flow-bilateral`)

Orientation-aligned separable bilateral (Kyprianidis & Döllner 2008):
one 1D bilateral pass along the gradient axis, one along the tangent
axis, iterated. Much cheaper than a true 2D bilateral, looks better on
flowing regions, and is the standard abstraction base under soft
quantization (the toon stack — see 082426_painterly-non-flow.md).

- **Type/name:** `flow-bilateral`, "Flow Bilateral",
  `src/nodes/effect/flow-bilateral.ts`, category `image` / `modifier`.
- **Inputs:** `source`, `field` (optional).
- **Params:** `iterations` (1–4, default 2 — each iteration is the
  along+across pass pair), `sigma_s` (spatial σ, px), `sigma_r` (range
  σ, color distance in premultiplied RGB), `across_scale` (multiplier
  on the across-flow σ; < 1 preserves edges harder).
- Two shaders (along/across differ only in which decoded axis they
  walk — one shader + a uniform), ping-pong pool textures.
- **Kang's FBL is NOT a separate node.** FBL = this node with an
  ETF-method Image Flow Field wired into `field` (the ETF field's
  longer coherent strokes are the whole difference). The docs page for
  this node should say exactly that.

---

## Shared verification

- `typecheck`, `check`, `check:shaders` (three new shader families —
  the blend-equivalence gate matters for shock's min/max walks).
- Probes: Flow Blur over white noise + Image Flow Field of a circle →
  concentric streaks, no seam at the vertical tangent (the
  sign-coherence test); Shock on a soft-blurred photo → crisp painterly
  edges, byte-stable across repeated evals at a paused playhead (purity
  test — fingerprint cache must hit); Bilateral 4-iter on video →
  flat regions calm, edges intact, no shimmer.
- `bench:nodes` for all three; shock at iterations 8 is the one to
  watch.

## Milestones

- **M1:** Flow Blur (it doubles as the field debugger — build first).
- **M2:** Flow Bilateral.
- **M3:** Coherence Shock (+ the Painterly preset upgrade in
  082426_kuwahara.md).
- **M4 (demand-gated):** shock `refine` toggle.
