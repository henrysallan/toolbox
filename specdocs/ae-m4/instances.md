# M4 lane 3 — instances beyond plain grids (results)

Spec: `specdocs/091926_after-effects-handoff.md` §3 rung 4, §10 M4.
Branch `claude/ae-m4-instances-e0c99d`. Measured 2026-10-21 in After Effects
26.5 (26.5x89), headless through aerender under the AE lock; the owner's AE
GUI was never scripted.

## What maps now

Copy to Points in image mode used to map one case: a static Grid of one
plain shape → two Repeaters. Everything else became one precomp per point,
and modulation, picks, tint / opacity, draw order and animated points
baked. Now every copy is evaluated the way the node draws it, and
`scene/instances.ts` picks a form:

| case | AE form | fidelity |
|---|---|---|
| static copies on a lattice (Grid, Array point mode, any regular step vectors — a tilted Point Expression lattice too), one variant, identical but for position, one plain shape instance | that shape layer's contents + one Repeater per axis; the copy TRS (point rotation / scale × uniform modulation) is the instance group's transform | exact |
| … with an opacity exactly linear along each axis (`group · inner(col) · outer(row)`) | Repeater Start / End Opacity by AE's `i/n` rule (below), an axis flipped where needed, the group's opacity for the peak | exact (measured) |
| anything else | one precomp per variant, one layer per copy, up to the layer budget | exact at frames |
| `scale_mul` / `rotate_add` static | each copy's Scale / Rotation | exact |
| `scale_mul_default` / `rotate_add_default` keyed, static points | each copy's Scale / Rotation keys converted from the track (the authored eases, ×100·point scale / + point rotation) | the convert/ policy (easeOutBack exact; easeInOutCubic Editable best fit 0.22°) |
| wired modulation, animated points (Stagger phases, timed Point Expression, Modulate Points…) | per-copy keys every frame, linear stretches merged (a staggered hold → ramp → hold copy keeps 3 keys) | exact at frames |
| `tint_attr` | **Fill** (`ADBE Fill-0002` = instance colour × tint) on a flat-coloured instance, else **Channel Mixer** (`-0001/-0006/-0011` = 100 · tint) | exact |
| `opacity_attr` | layer opacity | exact |
| pick modes all / random / cycle / by index / target group / attribute / image (static pick field) over a Combine's items | the copy layer's source = that variant's precomp; replayed with the node's own `chooseVariantGroup` | exact |
| a pick that changes over time | one layer per variant a point uses, HOLD opacity keys | exact at frames |
| `draw_order` points order / by y / shuffled | layer order: variant-major, then the draw order (compute's packing) | exact |
| static `scale_field` / `rotate_field` / image pick | sampled per copy at export from `AeSceneOptions.fieldPixels` (image mode: the shader's bilinear R at the copy; spline mode: the node's own compute and ≤ 256 px luminance readback) | approx (8-bit readback) |
| Array, spline mode | the instance group (per-copy TRS about the canvas centre) + a Repeater per axis | exact |

Still bakes:
- a point count that changes over time;
- a draw order that changes over time (AE can't reorder layers over time);
- an animated image field, or no readback;
- points computed from an image upstream (Scatter density, Set Named
  Attribute from an image, a Point Expression field). The walk's GL-less
  evaluator has no pixels; before this lane these exported silently wrong
  when the image producer threw on the stub GL;
- `driver_field` in spline mode (a per-copy driver for downstream ramps);
- another image group than a Combine as the instance;
- text-mode copies;
- over the layer budget, unless "keep procedural" is set.

Toolbox has no radial point generator, so the spec's "radial arrays" map
to nothing new. A radial layout from a Point Expression is not a lattice
and explodes.

## Measured in After Effects

`npx tsx scripts/fixtures/ae-export/graphs/instances-roundtrip.mts` builds
the 8 `r-` fixtures, plus one range probe, through
`scripts/ae-export-spike/run.mts --fixtures`. That is 1 build launch of
12.2 s and 9 render launches of 6–9 s each, 99 s in all including the wait
for the lock. The script then:
- reads back every copy layer's Position / Scale / Rotation / Opacity and
  tint effect at the case frames (325 property samples) and the copy
  layers' stacking order;
- compares them with toolbox's copies (`instances-reference.mts`: the
  evaluated points plus the node's vertex-shader math and compute's
  variant packing, independent of the exporter);
- checks the rendered pixel at every copy centre that no other copy
  overlaps.

| fixture | copies checked | props: worst \|AE − toolbox\| | pixels (±3/255) |
|---|---|---|---|
| r-tint-opacity (Fill / Channel Mixer tint, index-ramp opacity) | 8 + 3 | position 3.1e-5 px, opacity 2.4e-6 %, Fill colour 5e-15, Mixer 3.3e-8 | 11/11, worst 2 |
| r-picks (random + shuffled, cycle + by y, attribute, all; 3 variants) | 10 + 9 + 6 + 6 | position 6.1e-5 px; order identical | 19/19, worst 0 |
| r-keyed (keyed scale × easeOutBack, rotate + easeInOutCubic) | 6 × 7 frames | scale 3e-13 %, rotation 0.222° (the Editable best fit) | 18/18 |
| r-stagger (Stagger → Modulate Points; timed Point Expression) | 6 × 8 + 5 × 5 frames | position 3.4e-5 px, scale 2e-6 %, rotation 4e-6° | 26/26 |
| r-switch (pick driven by a Stagger phase) | 4 points × 2 variants × 7 frames | order and visibility identical, position 3.1e-5 px | 12/12 |
| r-ramp (Repeater opacity ramps, 1-D and separable 2-D) | 5 + 9 | — | 14/14, worst 3 |
| r-array (Array spline + point mode, tilted lattice) | 8 + 6 + 12 | — | 26/26, worst 0 (a re-run after moving the spline array on-canvas) |
| r-field (static fields, image + spline mode) | 10 + 6 | position 3.1e-5 px, scale 1.5e-6 %, rotation 5.6e-7° | 16/16 |

The position residual is AE storing Position as 32-bit floats. The
layer-order checks in run.mts (scene vs AE, every comp) all pass.

### AE behaviours found

- **Repeater opacity runs `Start + (End − Start) · i / n` over copies
  `i = 0 … n−1`**, so the last copy never reaches End.
  - Measured: 5 copies set to Start 20 / End 100 rendered
    20 / 36 / 52 / 68 / 84 %.
  - Nested Repeaters multiply: a 3×3 at 40→100 / 50→100 gave every product
    within 1/255.
  - Toolbox's ramp runs `i/(n−1)`. So the exporter writes Start = v₀ and
    End = v₀ + (vₙ₋₁ − v₀) · n/(n−1).
  - When End would fall outside 0–100, the axis is flipped: the original
    sits at the axis's last copy, the step is negative and Composite is
    Below. Stacking is unobservable here anyway, since identical copies
    composite commutatively.
  - A ramp neither way fits explodes. Example: 0.2 → 1 over 3 copies would
    need End 140 % or Start −20 %.
- **AE refuses Repeater opacities outside 0–100**: "Value 140 out of range
  0 to 100", and the same for −20. `validateAeScene` now rejects them.
- AE's Repeater Scale compounds per copy about a fixed point, so even a
  linear per-copy scale is never a Repeater. That follows from the
  transform algebra; it was not measured.
- Every package logged one build problem: the OCIO startup project refuses
  `bitsPerChannel = 16`. This is the same finding as lanes 2, 5 and 6; their
  `build.jsx` fix sets `colorManagementSystem = 0` first. Colours and
  transforms still matched.

## Notes for the integrator

- Shared files, all additive:
  - `scene/types.ts`: `AeSceneOptions.fieldPixels`. EffectsApp's runner
    passes it as the last evaluated value read back through
    `EngineBackend.readImagePixels`.
    - It is resolution-dependent: the readback resamples the
      preview-resolution texture to the size asked.
    - A field whose node isn't in the last eval returns undefined, so it
      bakes.
  - `scene/context.ts`, `scene/index.ts`: pass `fieldPixels` through.
  - `scene/shape.ts`:
    - `animatedUpstream` now also counts tickDriven / `stable: false` defs
      and time in a def's fingerprint. A def with `fingerprintExtras` no
      longer counts `facts.reads: "time"` on its own (Gradient declares it
      for wave mode only).
    - `arrayGeom` hook; `staticPathGeom` extracted from `pathGeom` (same
      output).
    - No snapshot outside `j-` / `k-` / `r-` changed, and those two changed
      only in report wording.
  - `runtime/validate.ts`: Repeater opacities limited to 0–100.
  - `classes.ts`: the copy-to-points / array / grid / stagger notes; stagger
    fidelity → sampled.
  - `check-scene-facts.mts`: one call into `instances-facts.mts`.
  - `copy-to-points.ts`: exports `chooseVariantGroup`, `lumaReadbackSize`,
    `lumaSamplerOf` (same math).
  - `build.jsx`: untouched.
- `plan.ts`'s `readsTime` still comes from `facts.reads` only. So the plan
  may call a Stagger-driven Copy to Points static while the walk keys it,
  and call a non-wave Gradient animated. Aligning the two is a
  `plan.ts` / `editor.ts` change.
- Suggested TESTING.md line: `instances-roundtrip.mts` is the live check
  for Copy to Points copies. It needs AE 26.x and takes the AE lock.
