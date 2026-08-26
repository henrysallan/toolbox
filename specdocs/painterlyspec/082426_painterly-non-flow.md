# Non-flow painterly modes: Oilify, Morphology, soft Posterize, watercolor & mosaic notes (2026-08-24)

The grouping of stylization work that does NOT consume the orientation
field. Two new nodes, one param addition, and two explicitly-scoped
non-nodes.

---

## 1. Oilify (`oilify`)

The classic local-histogram mode filter: per pixel, bucket the
neighborhood's intensities, output the average color of the modal
bucket. Cheap, dumb, distinctly oily — a different look from Kuwahara
(flat pooled blobs vs directional facets), worth having beside it.

- **Type/name:** `oilify`, "Oilify", `src/nodes/effect/oilify.ts`,
  category `image` / `modifier`.
- **Inputs:** `source` (image). No field input — that's the point of
  this grouping.
- **Params:**
  - `radius` (px, default 5, softMax 16 — cost is radius² × one
    histogram pass).
  - `levels` — histogram bucket count (default 20, 4–32). Low levels =
    chunkier pooling.
  - `dynamics` — exponent sharpening the modal bucket's win (soft
    blend of top buckets ↔ hard mode).
  - `mode` — `oil` (default) / `snn`. SNN (symmetric nearest neighbor:
    for each symmetric sample pair keep the one closer in color to the
    center, average the kept set) is a related edge-preserving smoother
    on the same O(radius²) walk — a mode, not a node, because it shares
    the input/params/cost shape and no one wires them differently.
- Single pass; fixed-size float histogram array in the shader (levels
  ≤ 32 keeps it in registers-ish; document that levels is the register
  pressure knob if a driver misbehaves).
- Premultiply rule (082426_orientation-field.md consumer contract —
  applies here too: modal averages in premultiplied color).
- Universal mask/opacity.

---

## 2. Morphology (`morphology`)

Dilate/erode/open/close — a general raster op the app simply lacks
(grep: nothing under src/nodes; the sdf.ts hits are SDF rounding). It
unblocks watercolor edge-darkening below, silhouette
thickening/choking for keyed footage, and mask cleanup generally.
Ships in this program because watercolor needs it, but it's a
first-class utility.

- **Type/name:** `morphology`, "Morphology",
  `src/nodes/effect/morphology.ts`, category `image` / `modifier`.
- **Inputs:** `source` (image; mask coerces in and back out via the
  standard coercions — no special casing).
- **Params:** `op` (`dilate` / `erode` / `open` / `close`), `radius`
  (px, default 2, softMax 12), `metric` (`disc` default / `square` —
  square is separable two-pass and cheap; disc runs the honest r² walk
  up to the softMax), `channels` (`alpha` default / `rgba` — alpha-only
  is the silhouette/matte case and skips color work).
- Open/close = two passes of the same shader with op swapped.
- Operates on straight alpha deliberately (min/max, not averaging — no
  premultiply requirement; note this asymmetry with the region
  filters in the file header).

---

## 3. Posterize `softness` (param addition, no new node)

Winnemöller 2006's soft luminance quantization is the missing piece of
the toon/cel stack — hard Posterize bands shimmer on video and alias
on gradients. Extend the existing
[posterize.ts](../src/nodes/effect/posterize.ts):

- New scalar param `softness` (0–1, **default 0 = byte-identical
  legacy output** — the back-compat rule; no schema bump, absent param
  reads as 0).
- In `quant()`: replace the hard `floor(v·steps + 0.5)` snap with a
  smoothstep of width `softness / steps` around each boundary,
  optionally scaled by local luminance gradient magnitude (one extra
  neighborhood tap pair) so transitions stay tight on real edges and
  soften only across shallow gradients — that gradient scaling is the
  part of Winnemöller worth keeping; expose as bool `adaptive`
  (default on, only sampled when softness > 0).
- The toon preset (state/presets.ts): Flow Bilateral → Posterize
  (luma, softness ~0.4) → Merge ← Line Art. Registered once Flow
  Bilateral + Line Art exist.

---

## 4. Watercolor — a preset, not a node (decision)

The app already owns the serious version: Watercolor Ink is a real
CA fluid/pigment sim. Bousseau 2006 is a cheap FILTER pipeline —
pigment density noise, edge darkening, wobbled edges — and every stage
already exists or lands above:

    source → [Flow Bilateral (abstraction)] →
    granulation: Merge multiply ← Perlin Noise (low-freq, remapped) →
    edge darkening: Morphology (erode, alpha) → Edge-band via
      subtract/Merge, multiplied back →
    wobble: Displace ← Perlin Noise (small amplitude)

Ship it as add-menu preset "Watercolor (filter)" (canned node-group
fragment) with a docs note distinguishing it from Watercolor Ink
(sim = wet media over time; preset = still-look filter, video-safe,
cache-friendly). If the preset proves popular and the graph is too
fiddly to tune, THEN consider a wrapper node — not before.

---

## 5. Mosaic / stipple — mostly owned already (scoping note)

- Stippling: the Stipple node's `packed` / `packed-flow` modes are
  already Secord-adjacent (density-weighted sampling + relaxation +
  temporal identity). No new work in this program.
- Hausner 2001 mosaic = Voronoi cells + an ORIENTATION field steering
  the CVT metric. The Voronoi node + stipple's WebGPU relax own the
  pieces, but wiring an orientation field into a CVT iteration is real
  design work (metric warping, per-cell rotation for tile rendering)
  and belongs with the points/instancing program —
  deferred to 082426_stroke-based-rendering.md M3, where the
  field-sampling attribute machinery it needs already lands. Nothing
  in this spec blocks it.

---

## Verification

- `typecheck` / `check` / `check:shaders` (three shader touches:
  oilify, morphology, posterize edit).
- Posterize regression: softness 0 must be byte-identical to today's
  output on a test still (readImagePixels compare, both modes rgb and
  luma) — this is the one place we touch shipped behavior.
- Oilify probe: photo at levels 8 vs 24 — pooling granularity moves;
  SNN mode on noisy footage — flat regions smooth, edges hold.
- Morphology probe: text silhouette dilate/erode round-trip (close)
  seals counters at radius ≥ stroke gap; alpha mode leaves RGB
  untouched.
- `bench:nodes` for oilify (the r²·histogram one).

## Milestones

- **M1:** Morphology (unblocks watercolor preset; independently
  useful).
- **M2:** Posterize softness + toon preset (after Flow Bilateral).
- **M3:** Oilify (modes oil + snn).
- **M4:** Watercolor preset.
