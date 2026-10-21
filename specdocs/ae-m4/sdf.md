# M4 lane 4 — SDF hard chains → native shape layers (results)

2026-10-21, branch `claude/ae-m4-sdf-bf28b4`. Spec: `specdocs/091926_after-effects-handoff.md`
§10 M4 ("SDF hard chains → Merge Paths"). Measured in After Effects 26.5 (26.5x89), headless through
`aerender` under the shared AE lock; the owner's AE GUI was never contacted.

## What shipped

- **`src/lib/ae-export/sdf-chain.ts`** — `sdfChainVerdict(consumer, graph)`: which SDF trees After
  Effects draws natively, and for the rest the node that stopped it and why. Pure; the planner and the
  scene walk share it.
- **`plan.ts` `planSdfChains`** — per graph, a hard chain under `sdf-rasterize` / `sdf-to-mask` /
  `sdf-to-spline` is `vector` (the consumer `approx` for its edges, every tree node `exact` with the AE
  object it becomes) and ONE segment; any other chain keeps the shader route with a note on the consumer
  (`SDF chain stays a shader region — sdf-smooth-union (blend): a smooth blend …`). A soft chain under
  `sdf-to-spline` bakes (its contour is traced on the GPU).
- **`scene/sdf.ts`** — the emitter (header comment has the whole model). Hooked from `shape.ts`
  (`emitVector` for the two image consumers, `geometry()` for `sdf-to-spline`); `masks.ts` / `effects.ts`
  never give an SDF contour the layer-mask route (an ALPHA matte instead); `style.ts`'s Stroke skips the
  per-anchor-width read on one.
- **GLSL table fix** — `src/lib/glsl-translation/classes.ts` lists every sdf / position tree node as
  `compiled` (`sdf-spline`, `sdf-from-image` `opaque`). `planTranslation` now refuses a consumer whose
  AST input comes from a node that cannot fuse ("an sdf tree compiles whole or not at all") instead of an
  empty region with no refusal. `scripts/check-glsl-translation.mts` requires every sdf / position
  producer to be classified (`compiled` unless texture-backed) and plans two SDF fixtures.
- Fixtures `s-boolean`, `s-soft`, `s-offsets`, `s-erode`, `s-chain`, `s-folds`, `s-tiles`,
  `s-animated`, `s-contour`, `s-shader`, `s-twist` (`scripts/fixtures/ae-export/graphs/sdf-fixtures.mts`,
  pushed onto `SCENE_FIXTURES`), snapshots, and the lane gate `scripts/ae-export/check-sdf.mts`
  (`npx tsx scripts/check-ae-export.mts sdf`).
- Docs: `ae-nodes/sdf-rasterize` (consumers), `sdf-circle` (leaves), `sdf-union` (booleans + offsets),
  `sdf-translate` (position chain) — family pages, the other types resolve through a new `aliases:`
  frontmatter key; an "SDF chains" section in `ae-conventions.md`.
- Measurement: `scripts/ae-export-spike/calibrate/sdf.mts` → `calibrate/measured/sdf.json`.

## The mapping

| toolbox | AE |
|---|---|
| sdf-circle | Ellipse, size 2·(r + δ)·W |
| sdf-rectangle | Rect, size (w, h)·W + 2δ, Roundness r + δ (shrinking: max(r + δ, 0)) |
| sdf-line-segment | capsule: Rect \|b − a\| + 2(t + δ) × 2(t + δ), Roundness t + δ, turned about the midpoint |
| sdf-polygon | Polystar polygon, rotation 0, outer radius r + δ / cos(π/n) (sharp) |
| sdf-star | Polystar star, rotation 0, inner r·sin(π/m − π/n)/sin(π/m); δ ≠ 0 → Offset Paths, Round join |
| sdf-triangle | Path; δ ≠ 0 → Offset Paths, Round join |
| union / intersection / subtraction | operand groups, Merge Paths Add / Intersect / Subtract (first operand kept) |
| smooth-* at smoothness ≤ 0 | the hard boolean |
| round (r), onion (t) | offsets on the leaves (δ += r; onion = offset +t minus offset −t) |
| translate / rotate / scale | group Position (tx·W, −ty·W) / Rotation −deg about the pivot / Scale ·100 about c |
| mirror | kept half (Intersect with the half-plane if crossed) + reflection (Scale −100), Merge Add |
| repeat | Repeater per axis (Offset = first cell); overflow → clipped to the cell; bounded edges keep overflow |
| polar (whole n) | Repeater ×n, Rotation 360/n, Anchor = c, over the wedge (clipped if crossed) |
| sdf-rasterize | Fill (foreground, fg_alpha) under a centred contour Stroke (2·contour_width px) over a comp Rect (background) |
| sdf-to-mask | white on black (invert swaps); threshold → δ |
| sdf-to-spline | the tree's outline as its consumer's geometry; iso → δ; clipped to the [0, 1]² tracing square |
| edge softness ≥ 1.5 px | Gaussian Blur 2 on the fill layer, Blurriness √(soft²/5 − 1/12)/0.2858, the background on its own layer |

Why the offsets are exact: round is d − r and onion |d| − t; max(a, b) − r = max(a − r, b − r) (and min
alike), and under subtraction max(a, −b) − r = max(a − r, −(b + r)), so an offset reaches every leaf, with
its sign flipped under a subtracted side. Each leaf offsets exactly: circle / capsule radius, rounded box
(grow: corner + δ; erode: max(corner − δ, 0)), polygon (polySdf is the edge-LINE distance, so its offsets
stay sharp), star / triangle (exact SDFs: the Minkowski offset, Offset Paths Round join). onion(X) =
round_t(X) − round_−t(X) is exact for any tree; a centred stroke would only be exact on an exact leaf (its
band follows the true distance, toolbox's the min / max).

**Round Corners is not the SDF round**: it fillets corners inward and keeps the size, while d − r grows
the shape by r everywhere (a 200-px square + round 20 is 240 px across). The rounded primitive (Rect size +
2r, Roundness + r; Ellipse + 2r) and Offset Paths are what is exact — measured below.

**Polystar roundness (κ 0.55) never enters**: SDF polygon offsets are sharp (bigger / smaller polygons) and
star / triangle offsets are circular arcs (Offset Paths), not Polystar's tangent-bulged roundness.

## Measured in After Effects

`npx tsx scripts/ae-export-spike/calibrate/sdf.mts` — each `s-` fixture through the real scene walk,
built by `build.jsx` headless (run.mts), its probe frame rendered ("TIFF Sequence with Alpha",
unpremultiplied), against toolbox's real engine (Electron, tbx-render) at 1280 × 720. **Every AE probe
pixel passes** (Merge Subtract order, the hexagon hole, the ring, the capsule, the −30° plank, the
squashed circle, the y-flipped translate, the mirror's kept half, bounded copies −1 / +1 and no +2, the
polar copy at 120° and none at 90°, clipped tile overflow, the keyed radius and translate at frame 24, the
merged contour stroke, the traced-circle matte).

Coverage bias = Σ(toolbox − AE coverage) / AE edge pixels: the mean outward offset of toolbox's edge.

| fixture | softness | mean | max | > 16/255 | bias px |
|---|---|---|---|---|---|
| s-boolean (contour) | 1 | 0.0003 | 0.236 | 0.62 % | +0.002 |
| s-offsets (to-mask, Offset Paths) | 1 | 0.0007 | 0.180 | 0.53 % | −0.039 |
| s-erode (erosions, grown polygon) | 1 | 0.0007 | 0.179 | 0.49 % | −0.043 |
| s-chain (rotate / scale / translate) | 1 | 0.0003 | 0.279 | 0.21 % | −0.039 |
| s-chain, aspect_correct off | 1 | 0.0002 | 0.281 | 0.09 % | −0.033 |
| s-folds (mirror, repeat, polar) | 1 | 0.0007 | 0.174 | 0.51 % | −0.040 |
| s-tiles (45 clipped copies) | 1 | 0.0012 | 0.183 | 1.43 % | −0.051 |
| s-soft (walk: blurred fill + bg layer) | 3 | 0.0002 | 0.192 | 0.002 % | −0.005 |
| s-contour (stroke + matte) | — | 0.0002 | 0.130 | 0.42 % | +0.011 |

- **Geometry is exact**: every bias is within ±0.05 px — the boolean, offset, fold and Repeater
  constructions land where the distance field's zero set is. The differences are edge pixels.
- **Edge anti-aliasing.** AE's coverage AA ≈ toolbox at softness 0.5 (s-boolean > 16/255: 0.62 % at 1 px →
  0.11 % at 0.5). Softness sweep with the fill blurred (×0 = no blur; the Blurriness map ×0.8 / 1 / 1.2):

  | s-offsets (fill) | ×0 | ×0.8 | ×1 | ×1.2 |
  |---|---|---|---|---|
  | softness 2: > 16/255 / max | 1.19 % / 0.331 | 0.70 % / 0.136 | **0.028 % / 0.103** | 0.001 % / 0.103 |
  | softness 4: > 16/255 / max | 2.53 % / 0.415 | 1.48 % / 0.156 | **0.003 % / 0.117** | 0.004 % / 0.104 |

  The map's own scale is the best of the three on > 2/255 (1.41 % vs 1.64 / 1.93 at 2 px). At softness
  1 px (Blurriness 1.20, an earlier run) the blur moved > 16/255 by under 0.05 points (s-offsets 0.53 → 0.50
  %, s-chain 0.21 → 0.18 %), so the blur starts at **1.5 px**: below that one shape layer, AE's own AA.
- **The contour with softness past its width** does not follow the blur (s-boolean at 4 px: 2.1 % →
  2.4 %): toolbox's band becomes one peaked smoothstep from 0 to width + softness. Reported `approx`.
- **bg_alpha 0** (s-animated): straight-alpha max 0.85 / premultiplied 0.37 on edge pixels — toolbox mixes
  an edge pixel's straight colour toward the background colour (`mix(bg, fg, m)` with alpha m), a fringe
  AE's fill doesn't have. Reported `approx`.
- **sdf-to-spline**: toolbox's traced contour (resolution 512) sits **~0.7 px right** of the SDF zero set
  (the traced-circle matte: toolbox centroid x 1000.71, AE 1000.00; y matches at the canvas centre); AE's
  outline is the exact one. A toolbox tracing bias (it looks like an i/(w − 1) vs (i + ½)/w grid mapping
  in the marching-squares step) — a follow-up, not exported.
- The round trip ran with aerender's startup project in **OCIO, 32 bpc** (`colorManagementSystem` 1 — the
  sticky "last project settings"; lanes 2 and 6 own the build.jsx fix), so each build logged one
  `bitsPerChannel` problem. Colours matched at every probe; the numbers above are geometry / AA.

## Not measured / not done

- Animated structure (a keyed side count, copies, mirror axis) refuses; animated radii, offsets,
  translations and spacing are keyed (exact when one keyed param drives the property, else per frame).
- Large erosions that change a star's / triangle's topology are not searched for beyond "vanishes past the
  inscribed radius" (it bakes when a shape appears / vanishes inside the window).
- `sdf-spline` with a closed simple spline could map to its path (even-odd) natively; it stays shader /
  bake (its distance is a per-eval texture), per the lane brief.
- Per-shape materials under a rasterize keep the shader route (toolbox colours by nearest surface).
- 16 / 32 bpc Adobe colour management, Windows, the AE app (only aerender's core).
