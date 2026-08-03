# Image → UV coercion (Blender-style domain warping)

Shipped 2026-07-30. Small feature: `uv` input sockets now accept `image`
wires directly.

## Motivation

In Blender you can plug one Noise Texture's `Fac` into another's `Vector`
input and get marbling: the scalar is broadcast to a vector `(f, f, f)`, so
the second noise is re-evaluated at coordinates driven by the first —
function composition where the warper's iso-contours become the base
pattern's veins. Our Noise node already has the receiving end (`uv_in`
re-evaluates procedurally at `texture(u_uvIn, v_uv).rg`), but nothing could
produce a noise-driven UV field: only Texture Coordinate and Math (uv mode)
emit `uv`, and neither accepts an image. Displace covers texture-space
warping, but the procedural re-evaluation path (infinite domain, no
resolution loss, no edge wrapping) was unreachable.

## Decision

`image` coerces to `uv` by **zero-copy re-wrap**: the ImageValue's texture is
re-labelled `{ kind: "uv" }`, R read as u, G as v. No shader pass — UV
fields already live in the same half-float RGBA pool textures as images
(`allocUv`), and every uv consumer samples `.rg`.

- **R/G as coordinates, not luminance broadcast.** Matches Math uv mode,
  velocity-field convention, and Displace's default channels. For grayscale
  images (R == G) the two are identical anyway — the `(f, f)` diagonal, i.e.
  exactly Blender's scalar broadcast. Curl noise's signed RG packing warps
  as a true vector field for free.
- **Replace, not add.** The coercion is a pure reinterpretation. Additive
  warps (`uv + strength * noise`) compose in-graph: Texture Coordinate +
  (image→uv) through Math (uv mode) ops.
- **Mask is NOT coercible to uv.** Mask textures are R-format; G samples 0,
  which would silently collapse v to zero. Route mask → image first.
- **No identity cache.** The wrapper is transient — built at
  input-resolution time, consumed inside the downstream compute, never
  stored. Caching is fingerprint-string based, so wrapper identity is
  irrelevant; aliasing the source texture is safe because the wrapper never
  outlives the compute call that receives it.

## Files touched

- `src/engine/graph-validation.ts` — `coercible()`: `image → uv` row
  (editor validation + AI-recipe validation, single-sourced; all editor
  paths funnel through `editorCanCoerce`).
- `src/engine/coerce.ts` — runtime re-wrap.
- `src/lib/ai/recipe-prompt.ts` — coercion list in the edit preamble.
- `src/nodes/source/perlin-noise.ts` — Noise description now advertises the
  UV-input warp.
- `specdocs/061226_devguide.md` — socket-coercion paragraph.

## Recipes

- **Marble:** Noise A `image` → Noise B `UV` → Color Ramp. Noise A's
  contour lines become B's iso-bands; ramp-clip into veins.
- **Swirl:** set the warper Noise to `curl` type first.
- **Iterated warp** (Quilez `f(p + n(p + n(p)))` flavor): chain
  Noise → Noise → Noise through UV inputs.
- Any UV-aware generator warps the same way: Image Source, Gradient,
  Voronoi, Math-in-uv chains.

## Notes / limits

- Displace remains the right tool for warping *raster content* (photos,
  video, arbitrary upstream comps); image→uv warping re-evaluates
  *generators* at new coordinates.
- Uploaded 8-bit media used as a UV source quantizes coordinates to 256
  levels per axis (visible banding under extreme magnification); pool-
  generated images (noise, gradients) are half-float and smooth.
- Premultiplied-alpha sources: `.rg` reads premultiplied values where
  alpha < 1 — same behavior as Displace's channel reads. Opaque generators
  are unaffected.
