# AE export M4, lane 2: text animators, text on a path, keyed documents

Branch `claude/ae-m4-text-062e61`, 2026-10-21. Spec: `specdocs/091926_after-effects-handoff.md`
§4.7 and §10 (M4). Measured in After Effects **26.5 (26.5x89)**, headless through aerender,
under the AE lock. The owner's AE GUI was never scripted.

## Summary

Text that used to bake now exports as an editable AE text layer:

- **Animators** become AE text animators:
  - Type On, Opacity, Position, Scale, Rotation, Tracking and Color;
  - every direction × based on (character or word);
  - linear and eased drives, cascade and uniform.
- **Text on a path** becomes a mask plus Path Options.
- **Keyed documents** become Source Text hold keys.
- **Keyed colours** become Fill or Stroke Color animators.

Field-driven animators still bake, with the reason.

Against toolbox's own renders, glyph by glyph (Arial):

- **Selection:** every animator prop × direction × based-on lands within
  **0.15–1.3 %** of the property's range. That is the toolbox renderer's own
  pixel noise; AE against the engine's model is ≤ 0.18 %.
- **Path text:** within **0.42 px** and 0.41°.
- **Box text:** within **0.3 px**.

Three existing behaviours were wrong and are fixed here:

- A document's tracking must be an integer in ±1000; AE refused the old values.
- New text layers inherited **optical kerning**.
- Toolbox's plain-text path centred a line with its trailing letter spacing.
  The export shifted it at first; since 2026-10-21 the engine aligns plain
  text like the per-glyph path and the shift is gone.

## What maps

| toolbox | AE | fidelity |
|---|---|---|
| static document (font, size, tracking, leading, case, alignment, box, fill, stroke) | TextDocument; tracking **rounded to an integer, clamped ±1000**, the rest as a px Tracking animator; `autoKernType` Metrics | approx (glyph metrics) |
| keyed size / spacing / leading / weight / box / stroke width / enums | Source Text **hold** keys: one per frame while a number moves, at toolbox's keys otherwise | sampled (exact per frame) |
| keyed `color` / `strokeColor` | Fill / Stroke Color animator over every character, the colour track on it (the OKLab expression the shapes use) | exact (as shapes) |
| keyed `color` alpha | layer opacity keys (× a static node opacity), per-frame when both move | exact / sampled |
| Type On | Opacity 0, selected by 1 − t' | see below |
| Opacity | Fill (+ Stroke) Opacity, so it multiplies Type On like toolbox's alpha product | see below |
| Position / Rotation / Tracking (px, After) | additive; a "base" animator carries min when it is not 0 (none when max is 0: selection 1 − t') | see below |
| Scale | multiplicative; base = min, varying = max/min (or the min = 0 / rest branches) | see below |
| Color | chain-lerp; base = min unless one end is the text's own fill | see below |
| linear cascade (forward, backward, center, edges) | Range Selector(s) in **index** units, the amount keys on **Offset**; center / edges = Ramp Up + Ramp Down combined by **Min / Max** | **exact** |
| eased cascade | the Range Selector's Ease High / Low when the minimax fit is within 0.5 % (policy editable) or 1e-4 (exact) | exact (smoothstep) / approx (sine 0.019 %, circ 0.04 %, quad 0.22 %) |
| other easings, random order, custom curves | Expression Selector replaying toolbox's formula; its own Amount holds the amount keys (read as `value`) | **exact** (custom: a 257-sample table, ≤ 2e-4) |
| overshooting easings (back, elastic) | the property carries the overshoot K (1.1 for back) and the selection is divided by it | exact |
| uniform driver | a Range Selector over every unit, Amount = 100·t' (keys mapped, or per frame when eased) | exact / sampled |
| Tracking by word | Expression Selector over **characters** that rebuilds toolbox's words from `text.sourceText` | **exact** |
| scale / rotation pivot | a "Pivot" animator: Anchor Point = Position = (0, −middle·size); word-based → Anchor Point Grouping Word | exact |
| text on a path | the spline → a mask (mode None); start / center / end → left / centre / right; offset × arc length → First Margin (Last for end; keyed when either moves); flip → Reverse Path; side → baseline shift −(middle ± ½)·size | approx (see below) |

These still bake, with reasons:

- field drivers;
- a keyed animator softness, direction, seed, easing, by or driver;
- scale or rotation animators based on both characters and words;
- a multi-subpath text path;
- an animated `path_enabled`;
- gradient or image fills (plan.ts now says so too);
- variable axes driven by a mask.

## AE behaviour, measured (`calibrate/text-probe.mts`, `measured/text-probe-{1..5}.json`)

Ten separated block glyphs per comp. Each glyph's alpha, size, centroid and
colour answer one question.

| question | answer |
|---|---|
| Range Selector model | **≡ lottie-web's `getMult`**: a ramp sampled at the unit centre i + ½ between s = Start·N/100 + o and e = End·N/100 + o. Square = coverage of the unit's cell. Ease Low > 0 → x1 = L/100, < 0 → y1 = −L/100; Ease High → x2 = 1 − H/100 or y2 = 1 + H/100, a cubic bezier on the clamped ramp. 16 shapes / eases / modes match the recorded renders within 0.0018 (gate). |
| ranges | Percent Start / End / Offset are limited to **±100** (`setValue(150)` throws). Index units allow ±99999. Amount and Ease are ±100. |
| Randomize Order | a seeded permutation of the units, not toolbox's independent hash. |
| Min / Max modes | combine the selections as min / max. |
| line breaks | `\r` is not counted as a character. **Words** count only non-space runs: a space isn't selected. |
| Expression Selector | output is clamped to ±100 % (negative allowed); an array selects per dimension. Its Amount is ThreeD, keyable and readable as `value`. `String(text.sourceText)` gives the text with `\r` breaks. `textIndex` is 1-based. |
| stacking | Position, Anchor Point, Rotation and Tracking **add**; Scale **multiplies**. Opacity, Fill / Stroke Opacity and Fill / Stroke Color **move from the value so far toward the animator's** by the selection, so the last one wins at 100 %. Opacity × Fill Opacity multiply. Fill Opacity leaves the stroke alone. |
| pivot | a character scales and rotates about (advance centre, baseline). An animator's **Anchor Point moves the glyph by −anchor**, and anchors sum across animators. Grouping Word pivots about the word's ink centre on the baseline. |
| tracking | the document's tracking is 1/1000 em, **integer, ±1000**. A non-integer throws ("is not an integer"), so does 1500. An animator's **Tracking Amount is px**. Tracking Type needs its own `addProperty("ADBE Text Track Type")`. Centring ignores the trailing tracking, as toolbox's per-glyph path does. |
| kerning | a new text layer inherits **Optical** kerning (`autoKernType` 11414). Metrics (11413) gives Arial "I" pitches within 0.04 px of toolbox at 40 px and 0.03 px at 72 px; optical was 0.74 / 2.1 px off. |
| Path Options | left: the first glyph starts at **First Margin**. Right: the run ends at the path end **+ Last Margin**. Centred: midpoint **+ First + Last**. Reverse Path runs from the end with the glyphs turned 180°. Baseline shift moves toward the glyphs' top. Text past an end continues straight. |
| first baseline of box text | per font, about the typo ascender: Arial 0.715, Helvetica 0.7167, Times New Roman 0.6993, Courier New 0.6122, Georgia 0.7544, Menlo 0.7571 em. |
| startup project | OCIO-managed (`colorManagementSystem` 1); `bitsPerChannel = 16` then throws. build.jsx sets 0 (Adobe) first. |

## Toolbox's own metrics (`calibrate/text.mts` metric_*)

Toolbox draws with `textBaseline = "middle"`. Chrome's middle is not the hhea
midpoint (Arial: 0.275 em measured vs 0.347 hhea). Measured at 120 px, ±0.004 em:

- Arial 0.275
- Helvetica 0.3167
- Times New Roman 0.2667
- Courier New 0.2667
- Georgia 0.275
- Menlo 0.2583

These, with AE's first baselines above, are the tables in `scene/text.ts`. After
them, AE − toolbox baseline is **0 px for all six fonts**.

Inter keeps the scene lane's 0.364 / 0.72, for two reasons: tbx-render drew
nothing for it (the face didn't load in time), and AE here has only Brex's Inter
variants.

## Derivation: a linear cascade is a Range Selector

Toolbox: t_i = clamp01((a − pos_i(1 − w))/w), with N units and w the softness.

**Forward.** pos_i = i/(N − 1), so t_i is a ramp in i:

- D = w(N − 1)/(1 − w) units wide;
- its ends move D/w units per unit of amount.

That is Ramp Down with Start = ½ − D, End = ½ and Offset = (D/w)·a, all in index
units.

**Backward** is the mirror: Ramp Up with Start = N − ½, End = N − ½ + D and
Offset = −(D/w)·a.

**Center** is min(Ramp Up, Ramp Down) about c = (N − 1)/2, with D = w(N − 1)/(2(1 − w)).

**Edges** is max(Ramp Down, Ramp Up).

**N = 1** uses D = 1 and Offset = a/w.

**The complement** (1 − t') swaps the ramps and Min ↔ Max. The ease is monotone,
so it commutes with Min / Max.

Amounts outside 0–1 saturate in both, so Offset needs no clamp.
`check-convert-text` holds this to 2e-12 over directions × N ∈ {1, 2, 3, 10, 17}
× softness ∈ {1e-4 … 0.99} × both senses × amounts −0.1 … 1.1.

## Calibration: toolbox vs AE renders (`calibrate/text.mts`, `measured/text.json`)

- **Toolbox side:** the real engine (tbx-render).
- **AE side:** the same graph through `buildAeSceneForEditor` → one merged scene
  → the real build.jsx → aerender, 16 bpc.
- **The text:** ten Arial "I"s at 40 px, letter spacing 60 px, which also
  exercises the ±1000 split.
- **Sampling:** the amount is keyed 0 → 1 over 24 frames; frames 3, 7, 11, 15 and
  19 are read.
- **Per glyph:**
  - alpha — mass against a reference;
  - offset — centroid;
  - scale — major-axis spread;
  - angle — second moments;
  - spacing — centroid shift;
  - colour — mean.

  Each is read against a reference render **in the same renderer**: the same
  layout with an identity animator, so both sides use toolbox's per-glyph path.

**Errors** are the worst over glyphs and frames, as a percentage of the
property's range:

- "AE vs model" compares AE against the engine's `resolveGlyphAnim`.
- "toolbox render vs model" is the measurement floor, in property units.

| prop (range) | based on | forward | backward | center | edges | random | AE vs model, worst | toolbox render vs model |
|---|---|---|---|---|---|---|---|---|
| typeon (alpha 0→1) | char | 0.18 | 0.16 | 0.18 | 0.16 | 0.15 | 0.002 | 0.0018 |
| typeon (alpha 0→1) | word | 0.17 | 0.17 | 0.17 | 0.16 | 0.16 | 0.002 | 0.0018 |
| opacity (alpha 0.2→1) | char | 0.19 | 0.19 | 0.18 | 0.19 | 0.29 | 0.003 | 0.0023 |
| opacity (alpha 0.2→1) | word | 0.14 | 0.14 | 0.14 | 0.11 | 0.26 | 0.003 | 0.0021 |
| position (40 px) | char | 1.23 | 1.23 | 1.23 | 1.11 | 1.23 | 0.090 | 0.52 px |
| position (40 px) | word | 0.79 | 0.79 | 0.63 | 0.79 | 1.23 | 0.085 | 0.48 px |
| scale (0.4→1.6) | char | 0.49 | 0.44 | 0.50 | 0.48 | 0.42 | 0.349 | 0.0055 |
| scale (0.4→1.6) | word | 0.20 | 0.23 | 0.23 | 0.15 | 0.27 | 0.349 | 0.0055 |
| rotation (60°) | char | 0.84 | 0.31 | 0.12 | 0.34 | 0.36 | 0.136 | 0.42° |
| rotation (60°) | word | 0.06 | 0.10 | 0.10 | 0.05 | 0.10 | 0.020 | 0.058° |
| tracking (30 px) | char | 1.25 | 1.25 | 1.15 | 1.31 | 1.33 | 0.181 | 0.39 px |
| tracking (30 px) | word | 0.89 | 1.25 | 1.06 | 1.06 | 1.09 | 0.142 | 0.36 px |
| color (red→blue) | char | 0.23 | 0.18 | 0.23 | 0.21 | 0.22 | 0.194 | 0.0011 |
| color (red→blue) | word | 0.21 | 0.21 | 0.18 | 0.21 | 0.23 | 0.191 | 0.0012 |

How to read the table:

- Position, rotation and tracking errors are the toolbox render's integer-pixel
  glyph placement (0.5 px). AE against the model is ≤ 0.07 px / 0.08°.
- Scale's constant 0.35 % is the spread measure's anti-aliasing bias at small
  scales; it is the same in every case.
- Colour's 0.19 % is toolbox's rounding of animated colours to 8 bits.

**Tracking by word** came out **115–150 %** off on the first pass: AE's Words
leave the spaces out, while toolbox's word owns the space after it. The
expression route above fixed it.

Easing routes and branches (AE vs toolbox / AE vs model, %):

| case | route | AE − toolbox | AE − model |
|---|---|---|---|
| rotation, smoothstep | Range + Ease 33.33 / 33.33 (exact) | 0.16 | 0.033 |
| opacity, ease-in-out-sine | Range + Ease 36.4 / 36.4 (fit 0.019 %) | 0.28 | 0.021 |
| typeon, ease-in-quad | Range + Ease (fit 0.22 %) | 0.18 | 0.002 |
| position, ease-out-back | Expression, headroom 1.1 | 1.23 | 0.068 |
| scale centre, ease-in-cubic | Expression | 0.37 | 0.349 |
| typeon, ease-out-bounce, softness 0.6 | Expression | 0.16 | 0.002 |
| opacity, softness 0.9 / 0.05 | Range | 0.26 / 0.12 | 0.003 |
| opacity / position, uniform (linear / eased) | Range, Amount keys / per frame | 0.28 / 1.11 | 0.002 / 0.097 |
| opacity 0.2 → 0.6, position ±10 / −30, rotation −20 → 40 | base + varying animators | 0.21 / 1.24 / 0.64 | 0.003 / 0.099 / 0.097 |
| scale 0 → 1 centre | min = 0 branch (Min / Max) | 0.45 | 0.505 |
| colour, white → green (rest at the fill) | one animator | 0.18 | 0.186 |

Text on an arc (radius 420 px, 110°, ten "I"s, spacing 20 px), with glyphs
matched in order:

| case | max Δ position | along path | normal | max Δ angle |
|---|---|---|---|---|
| centre | 0.34 px | 0.01 ± 0.18 | −0.18 ± 0.29 | 0.23° |
| start | 0.29 | −0.12 ± 0.20 | −0.08 ± 0.28 | 0.16° |
| end | 0.27 | 0.05 ± 0.13 | −0.10 ± 0.25 | 0.13° |
| start, offset 0.15 | 0.33 | −0.04 ± 0.18 | −0.16 ± 0.32 | 0.18° |
| centre, offset 0.1 | 0.29 | 0.01 ± 0.18 | −0.15 ± 0.28 | 0.41° |
| above | 0.42 | 0.02 ± 0.20 | −0.24 ± 0.40 | 0.38° |
| below | 0.41 | −0.01 ± 0.14 | −0.20 ± 0.39 | 0.20° |
| flip | 0.34 | 0.06 ± 0.18 | −0.25 ± 0.34 | 0.41° |
| + rotation animator | 0.24 | 0.06 ± 0.16 | −0.14 ± 0.22 | 0.11° |

Before the two metric fixes:

- **Optical kerning** gave ±3.2 px along the path (±6.9 px start / end).
- **The hhea middle** gave −3.0 px normal.

Documents (box text, plain, so toolbox's fast path):

| case | max Δ position |
|---|---|
| keyed size 32 → 72 | 0.18 / 0.76 / 0.22 px (frames 0 / 12 / 24) |
| keyed weight 400 → 700 | 0.29 px |
| keyed colour | 0.23 px, Δrgb ≤ 0.0013 |

The fast path's −spacing/2 shift took the horizontal error from 15 px to 0.01 px.
Since 2026-10-21 the engine draws plain text where the shift put it (centred
without the trailing gap, ≤ 0.25 px from the per-glyph path in Chromium), so
the export no longer shifts; AE was not re-run for that change.

## Exact vs approx

- **Exact** (AE ≡ toolbox's formula):
  - linear cascades in every direction;
  - Ease High / Low for smoothstep;
  - Expression Selectors (other easings, random, word tracking, custom curves
    to 2e-4);
  - uniform drivers;
  - the stacking and pivot;
  - keyed colours (as shapes).
- **Approx:**
  - eased cascades that take the Range Selector fit (sine 0.019 %, circ 0.04 %,
    quad 0.22 % of the range; the report names the number);
  - glyph metrics for unlisted fonts (the Inter default);
  - text past a path end (toolbox stacks it on the end point, AE continues
    straight);
  - animators on wrapped box text (toolbox's wrap drops the spaces where lines
    break; AE counts them).
- **Sampled:** keyed numeric document params (a hold key per frame); eased
  uniform amounts; keyed animator min / max.

## Not measured

- 32 bpc, the AE app (GUI) build, Windows.
- **Fonts other than the six above.** Inter in toolbox (the default face) and in
  AE (not installed here) wasn't measured.
- **Position x on curved paths.** AE moves a character's Position x along the
  path's curve; toolbox moves it straight along the tangent. Only a rotation
  animator on a path was measured.
- **Rendered checks still owed:**
  - the Stroke Opacity / keyed Stroke Color animators (structure is
    gate-checked only);
  - Letter Spacing beyond ±1000 with a keyed size;
  - multi-line cascades (AE's `\r` exclusion is probed, toolbox's is the same in
    code).
- Variable-font axes, ligatures (AE's inherited `ligature` setting isn't reset).

## Files and gates

- `src/lib/ae-export/convert/text.ts` (new):
  - the AE Range Selector model;
  - toolbox's drive;
  - the planner (`planTextSelector`);
  - the ease fit;
  - the Expression Selector builder;
  - an AE stacking model (`aeTextModel`) for checks.
- `src/lib/ae-export/scene/text.ts`:
  - the walk;
  - the per-font metric tables;
  - the fast-path shift;
  - the tracking split.
- `types.ts`:
  - `AeTextDocument.baselineShift`;
  - `AeTextAnimator.selectors` (`selector` optional);
  - `AeTextSelectorMode`, `AeTextRangeSelector`, `AeTextExpressionSelector`;
  - `AeTextPathOptions`;
  - `text.pathOptions` and `text.anchorGrouping`.
- `runtime/validate.ts`:
  - selector shapes, ranges, modes and expressions;
  - Path Options;
  - animator property value shapes;
  - document tracking (an integer in ±1000).
- `runtime/build.jsx`:
  - Range and Expression selectors with Mode and Amount;
  - Path Options;
  - Anchor Point Grouping;
  - baseline shift;
  - Metrics kerning;
  - the OCIO → Adobe step.

  Hash pin updated in `electron/ae-core.js`.
- `plan.ts`: field-driven animators, keyed animator shape params and gradient /
  image fills bake.
- `classes.ts`: the text note.
- Docs: `docs/ae-conventions.md` (Text), `docs/nodes/text.md`, `docs/generated.ts`.
- Gates:
  - `scripts/ae-export/check-convert-text.mts` (new);
  - `check-scene-facts` (Q facts; the text-animator fact now expects AE
    animators);
  - fixtures `q-text-animators`, `q-text-path`, `q-text-doc` with snapshots;
  - `e-text`'s snapshot: the box moves 3 px (fast-path shift), plus the class note.
- Harness:
  - `scripts/ae-export-spike/calibrate/text-probe.mts` + `text.jsx` (AE behaviour);
  - `text.mts` + `text-build.jsx` + `text-glyphs.mts` (toolbox vs AE).

  Measured data is in `calibrate/measured/text*.json`.

Live round trip: `npx tsx scripts/fixtures/ae-export/graphs/roundtrip.mts q- e-text` builds
all four packages headless with 0 problems, and every probe passes.

## For the integrator

- **build.jsx `applyProject`:** the OCIO step (`colorManagementSystem = 0`
  before `bitsPerChannel`) is also added by lanes 5 and 6. Keep one copy when
  merging, then re-run `gen-runtime.mts` and update the hash pin.
- **`AeTextAnimator.selector` is now optional** (`selectors` is the M4 form).
  Nothing outside text reads it.
- **Toolbox bug, fixed in the engine 2026-10-21:** the plain-text fast path
  (canvas `letterSpacing`) centred or right-aligned a line *including* its
  trailing letter spacing, while the per-glyph path (animators) excluded it,
  so turning on an animator moved letter-spaced text by spacing / 2. Both
  paths now wrap, measure and align by the visible width
  (`text-raster.ts`), and the export's compensating shift is gone.
- **Intermittent launch failure:** an aerender launch now and then never reaches
  the startup hook (no job JSON, exit 0), seen right after another checkout's
  run. `text.mts` retries up to three times.
