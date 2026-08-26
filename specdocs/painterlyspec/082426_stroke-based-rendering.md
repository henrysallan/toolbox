# Stroke-based rendering — the geometry path (2026-08-24)

Hertzmann 1998 / Litwinowicz 1997: painterly rendering as PLACED
STROKES — instanced brush quads with position from blue noise,
orientation from the flow field, color from the source, coarse-to-fine
layers. The research note's framing is exactly right for this app:
**this is not a per-pixel filter and must not live inside a painterly
node — it's the points/instancing pipeline.** Almost all of it already
exists; this spec is one small node change, one dependency callout,
and presets.

Depends on 082426_orientation-field.md. Neural variants (Paint
Transformer etc.) are out of scope — no ONNX detour.

## What already exists (the recombination inventory)

| Stroke-rendering need | Owned by |
|---|---|
| Blue-noise placement, density from image/spline | Scatter Points (rejection sampling; Relax for de-clumping) |
| Stroke color from source | Sample Texture at Points → color attribute (081326_point-attributes.md M-series) → Copy to Points instance color |
| Size from a map | Sample Texture at Points (`target: scale`, already shipped) |
| Brush stamp instancing | Copy to Points (image instances, alpha-bbox-cropped quads, variants via `pick_mode` for stamp libraries) |
| Streamline strokes as geometry | Advect Points → Spline Trails / Connect Points (a stroke that FOLLOWS the field, not just tilts) |
| Coarse-to-fine layering | Merge stack (or Iterate), radius decreasing per layer |
| "Paint where the canvas differs from the source" | Merge `difference` of source vs current layer → mask → next layer's Scatter density |

## The one node change: field sampling into attributes

**Sample Texture at Points grows a `field` source mode.** Today its
`channel` enum is luminance/r/g/b/a and `target` is scale/rotation.
Add:

- `channel: "field angle"` — decode the sampled pixel per
  engine/orientation-field.ts (`decodeTangent`), write
  `atan2` of the tangent as the attribute value. With
  `target: rotation` this is THE stroke-orientation primitive: scatter
  → sample flow angle → Copy to Points, and every brush quad lies
  along the flow.
- `channel: "field coherence"` — B channel decoded (drive scale or a
  named attribute: strong-flow areas get long strokes).
- Angle units follow the node's existing rotation convention;
  remap lo..hi still applies (lets users add a spread).

Deliberately NOT a new "Sample Flow at Points" node — the existing
node's name promises exactly this ("the base primitive for drive
geometry from an image"), and the field is an image on the wire.

**Coordination note:** scatter-points.ts, map-attribute.ts,
points-on-path.ts and the attribute nodes are mid-flight in the
owner's working tree right now (081326 point-attributes program).
This change waits for that to land and rides the propagation-law
patterns it establishes; re-read the files at implementation time
(concurrent-WIP rule).

## Dependency callout: instance color

The full Hertzmann look needs per-stroke color = source color at the
point. That is 081326's color-attribute → "Instance Color" path on
Copy to Points. If that milestone hasn't landed when this program gets
here, it becomes this spec's real M2 — implemented per 081326's data
model (arity-3/4 `color`-tagged attribute; Copy to Points tints each
stamp's premultiplied quad by it), not a parallel mechanism.

## Presets (the deliverable users see)

1. **"Brush Strokes"** — Image Flow Field → Scatter Points (density =
   source luminance) → Sample Texture at Points ×2 (field angle →
   rotation; luminance → scale) → Copy to Points (bundled default
   stamp: a soft elongated dab authored as a Paint-node bitmap in the
   preset fragment — presets embed media, the user swaps their own) →
   Merge over a Flow Bilateral base. One graph, every knob exposed.
2. **"Painted Layers"** (after instance color) — three Brush Strokes
   layers, radius 3:2:1, layers 2–3's Scatter density wired from a
   Merge-difference mask of source vs the accumulated stack —
   Hertzmann's refinement loop as an acyclic 3-layer graph. If three
   copies prove unwieldy, an Iterate-zone variant is the follow-up
   (collect sockets already merge per-iteration outputs); start with
   the explicit stack — it's more legible and per-layer tweakable.
3. **"Field Streamers"** — Scatter (sparse) → Advect Points →
   Spline Trails → Stroke (taper via width tools) — the vector-stroke
   look, exportable as SVG through the existing taps.

## Mosaic (deferred from 082426_painterly-non-flow.md §5)

**M3:** Hausner-style mosaic = the orientation field steering a CVT.
**Decided (owner, 2026-08-24): it lives in the Voronoi node** — a
`field` input warping the cell metric (stretch cells along the local
tangent, weighted by coherence), riding Voronoi's existing
cells/edges/centers derivation so tile rendering (centers → Copy to
Points with field-angle rotation) and cell outlines come free. Stipple
stays untouched. Design addendum still needed for the metric-warp
math + relaxation before implementation.

## Verification

- `typecheck` / `check` (the Sample Texture change touches the
  attribute propagation law — filter/gather paths must carry the new
  writes; the 081326 checks cover the law itself).
- Probe: circle image → Image Flow Field → preset 1: dabs align
  tangentially around the rim with no vertical-seam flip (the
  π-canonicalization test again, now through the CPU decode path —
  keep the TS decode bit-consistent with the GLSL, the
  voronoi-geometry pcg3d precedent for CPU/GPU agreement).
- Temporal: preset 1 on video — stamps must not pop as the field
  animates (Scatter's seed is frame-stable; the field samples move
  smoothly).

## Milestones

- **M1:** Sample Texture at Points field modes + preset 1 + preset 3.
- **M2:** instance color dependency (if not already landed via 081326)
  + preset 2.
- **M3:** mosaic design Q&A → addendum spec.
