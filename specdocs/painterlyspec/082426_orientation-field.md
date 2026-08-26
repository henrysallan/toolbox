# Orientation fields + Image Flow Field node (2026-08-24)

The shared substrate for the painterly/NPR program (specs
082426_kuwahara.md, 082426_flow-guided-filters.md,
082426_line-extraction.md, 082426_painterly-non-flow.md,
082426_stroke-based-rendering.md). Nearly every advanced stylization
operator in the literature — anisotropic Kuwahara, LIC, coherence shock,
flow bilateral, FDoG, mosaic, stroke placement — consumes the same local
orientation + anisotropy estimate of the image. That estimate is the
reusable asset, so it becomes its own producer node and a wire
convention, not a per-node recomputation.

## Why the flow-field path is right here (decision)

The app already made this exact architectural bet once:
[velocity-field.ts](../src/engine/velocity-field.ts) (spec
archive/072526_flow-fields.md) established that 2D fields travel as plain
images — no new socket type — with producers (Perlin curl, Spline Flow
Field, Flow Obstacle) decoupled from consumers (Advect Image/Points,
Displace). Orientation fields extend that convention rather than minting
a parallel one. Payoffs:

- Every existing field producer can drive the new painterly consumers —
  a noise field, a spline's flow, a fluid sim's live `velocity` aux can
  steer Kuwahara/LIC/shock strokes. That's the motion-graphics win the
  per-pixel-filter literature never had.
- Every existing field consumer can ride the new Image Flow Field
  producer — Advect Points along an image's edges, Displace along its
  contours — for free.
- No SocketType ripple (invariant #7): no coerce.ts, socketColor,
  NodeEditor validation, or clips changes.

## Encoding (extends the velocity convention, does not fork it)

An **orientation field** is a velocity-field image with the previously
unused B channel populated:

```
R = 0.5 + tx * 0.5     unit tangent, velocity encoding (midlevel 0.5)
G = 0.5 + ty * 0.5
B = coherence A ∈ [0,1] (anisotropy: (λ1−λ2)/(λ1+λ2), 0 = isotropic)
A = 1
```

- **t is the tangent** (direction ALONG edges — eigenvector of the
  structure tensor's minor eigenvalue), Y-DOWN, unit length. Same axis
  conventions as velocity-field.ts: consumers stepping in Y-UP v_uv
  space use `uv ± vec2(t.x, -t.y * aspect) * k`.
- **Sign canonicalization:** orientation is π-periodic (t and −t name
  the same orientation). Producers encode the representative with
  `tx > 0` (ties: `ty ≥ 0`). Consumers that only need an axis (Kuwahara
  ellipse, bilateral, shock, FDoG) use it directly; consumers that WALK
  streamlines (LIC, stroke traces) must step sign-coherently — flip the
  sampled tangent when `dot(t, prevStep) < 0` — or the near-vertical
  canonicalization seam kinks every path. The helper GLSL below owns
  this so no consumer hand-rolls it.
- **Velocity images are valid orientation inputs.** Existing producers
  write B = 0, which honestly decodes as "no anisotropy". Consumers
  that want elliptic behavior from such fields expose an
  `anisotropy` source param (see the consumer contract). Consumers of
  plain velocity ignore B, as they already do.
- Inherited caveat, verbatim from velocity-field.ts: never matte an
  encoded field (transparent black decodes as t = (−1,−1), A = 0);
  matte the consumer's output.

New engine module **`src/engine/orientation-field.ts`** (the
velocity-field.ts pattern: a documented header that IS the convention,
plus inline-able GLSL):

- `ORIENTATION_DECODE_GLSL` — `vec2 decodeTangent(vec4 c)` (reuses the
  velocity decode + normalize-guard for near-zero), `float
  decodeCoherence(vec4 c)` (c.b), `vec2 coherentStep(vec2 t, vec2 prev)`
  (the sign-coherent walk helper).
- `ORIENTATION_ENCODE_GLSL` — canonicalize sign, encode, write A.
- `ORIENTATION_NEUTRAL` clear color `[0.5, 0.5, 0, 1]`.

## The Image Flow Field node

- **Type/name:** `image-flow-field`, "Image Flow Field", category
  `image`, subcategory `modifier`, file
  `src/nodes/effect/image-flow-field.ts`. Sits beside Spline Flow Field
  in the add menu; `noMaskInput`.
- **Input:** `source` (image; mask coerces in).
- **Primary output:** the orientation field (image, encoded as above).
- **Aux:** `coherence` (mask) — A as a grayscale field, for driving
  anything mask-typed (stipple density, scatter density, XDoG ε…).
  Cheap (one extra pass), built unconditionally (loop-weave rule — this
  node caches).
- **Params:**
  - `method`: `tensor` (default) / `etf`.
    - `tensor` — Sobel structure tensor: pass 1 luminance gradient →
      (gx², gx·gy, gy²) packed RGB; passes 2–3 separable Gaussian blur
      of the tensor (σ = `smooth`, px); pass 4 eigen-decompose →
      encode. Smoothing TENSORS (not angles) is the whole point — it is
      immune to the π-wraparound that makes angle blurring wrong.
    - `etf` — Kang's Edge Tangent Flow: seed from the tensor result,
      then `iterations` (1–4) of the nonlinear tangent smoothing
      (neighbor tangents weighted by magnitude difference + alignment,
      radius `smooth`). Longer, more coherent strokes; ~iterations ×
      2 passes dearer. This is also what makes a separate "FBL" node
      unnecessary — flow bilateral with an ETF field wired in IS Kang's
      FBL (082426_flow-guided-filters.md).
  - `pre_blur` (σ before the gradient, default ~1px — noise gate),
    `smooth` (tensor σ / ETF radius, default ~4px, softMax 16),
    `iterations` (ETF only, visibleIf).
- **Luminance for the gradient is coverage-weighted**: `dot(rgb, W) * a`
  — matching the image→mask coercion semantics, so a shape on
  transparency gets its silhouette's orientation, not the cleared
  surround's.
- **Tensor blur is local separable-Gaussian passes, NOT convolve/.**
  The convolve backend's boundary.ts premultiplies/un-premultiplies and
  optionally sRGB-converts — correct for color, wrong for packed tensor
  data. Two small dedicated passes; RGBA16F pool textures are ample for
  a normalized tensor.
- Pure function of inputs → normal fingerprint caching. Static images
  compute the field once.

## Consumer contract (applies to every node in the sibling specs)

- Optional `field` input (image). **Unwired → the node computes its own
  internal tensor field** at fixed decent defaults (pre_blur 1,
  smooth 4) so every painterly node works standalone — the Adaptive
  Pixelate "driver unwired → use the source itself" precedent. Wired →
  use it verbatim, which is both the perf win (one field, many
  consumers) and the creative win (non-image-driven flow).
- Read anisotropy from B; nodes whose look depends on it expose how to
  handle B = 0 fields (see 082426_kuwahara.md `anisotropy` param).
- **Premultiply rule for all painterly region filters** (Kuwahara,
  bilateral, shock, oilify, SNN): average/select in PREMULTIPLIED color,
  un-premultiply on write, alpha clamped low. Straight-alpha averaging
  at soft edges is exactly the darkened-fringe bug convolve/boundary.ts
  exists to prevent — same rationale, inlined per shader (these are
  single-pass filters, not convolve plans).

## Visualization

No new machinery: the Flow Blur node (082426_flow-guided-filters.md)
with a noise image input IS the standard LIC field visualization. The
`coherence` aux previews in the socket-peek popover like any mask.

## Verification

- `npm run typecheck && npm run check`; `npm run check:shaders` (new
  GLSL).
- Correctness probes: a linear gradient image → constant tangent
  perpendicular to the gradient, coherence ≈ 1; a flat image →
  coherence ≈ 0 everywhere; a circle silhouette → tangents tangent to
  the rim, seam-free rotation through the tx-canonicalization boundary
  when consumed by Flow Blur (this is the case that catches sign bugs).
- `npm run bench:nodes` for the ETF path at max iterations.

## Milestones

- **M1:** engine/orientation-field.ts + Image Flow Field (`tensor`
  method) + coherence aux. Unblocks every consumer spec.
- **M2:** `etf` method.
- **M3 (opportunistic):** field-space utilities if demand appears —
  e.g. a Field Math node (rotate 90° = tangent↔gradient swap, blend two
  fields). Deliberately not designed yet.
