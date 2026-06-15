# Text node upgrade — design spec (draft 2026-06-14)

Owner-driven upgrade of the Text node across five threads:

1. **Per-glyph motion animators** (AE-style range selector + presets) — headline.
2. **Searchable Google Fonts database** (~1500 families, CDN-loaded) — backlog #144.
3. **Font weights / italics / variable axes for built-in fonts** (folds into #2; a slice ships earlier as a quick win).
4. **String input socket** — new `string` socket type, Text input becomes graph-drivable — backlog #146.
5. **Richer styling** — gradient fill, in-raster stroke, vertical alignment, case transform (+ optional per-char color).

Decisions locked in design Q&A (2026-06-14):
- Animators: **range-selector core + thin preset configs on top** (not preset-only).
- Font DB: **full Google catalog (~1500), distilled to JSON, CDN-loaded on demand**.
- String socket: **socket type + coercions + one producer node** (not socket-only).

Read [061226_devguide.md](061226_devguide.md) first — this spec assumes its vocabulary
(socket types, the evaluator, `consumedOutputs`, invariants #1–#7).

---

## 0. Current state (what we're building on)

- [text.ts](../src/nodes/source/text.ts): `stable:false` source node with a signature
  cache (`computeRasterSig` / `computePostSig`). Outputs **primary image**, **`sdf`**
  (JFA), **`spline`** (marching squares), **`element`** (Auto Layout). The two costly
  aux outputs are lazily gated on `consumedOutputs`.
- [text-raster.ts](../src/engine/text-raster.ts): the shared measure/wrap/draw core.
  Two paths — **FAST** (one `fillText` per line) and **MODULATED** (per-character
  draw with manual advance accumulation). The modulated path is the hook every
  per-glyph feature below extends.
- [font-axis.ts](../src/lib/font-axis.ts): per-character axis modulation
  (`constant / gradient / sine / random / cycle / perGlyph / maskDriven`) — already
  proves the per-glyph resolve model; the animator's range selector generalises it.
- [fonts.ts](../src/lib/fonts.ts): `ensureFontLoaded` injects a Google Fonts `<link>`
  (currently hardcoded `wght@100..900`), `registerCustomFont` parses `fvar` axes,
  `isFontReady` is the sync gate. `CURATED_FONTS` is a ~24-family enum.

Key facts that make this cheap:
- `font_variations` axis UI is gated on `custom_font?.axes` ([text.ts:396](../src/nodes/source/text.ts#L396))
  — so built-in fonts have **no** weight/axis control even though the data is loaded.
- `"string"` is already a `ParamType` ([types.ts:765](../src/engine/types.ts#L765)) but
  **not** a `SocketType`; `paramSocketType("string") → null`
  ([graph-helpers.ts:26](../src/engine/graph-helpers.ts#L26)) is the only thing blocking expose.

---

## 1. Per-glyph motion animators

### Model (AE semantics, engine-native)

An **animator** = a set of *property deltas* applied to glyphs, scaled per-glyph by a
**range selector**. Per glyph `i` the selector yields `s_i ∈ [0,1]`; each property is
blended `base → animatorValue` by `s_i`:

- position: `pos_i  += s_i · (Δx, Δy)`            (base delta = 0)
- scale:    `scale_i = lerp(1, animScale, s_i)`    (base = 1)
- rotation: `rot_i   = s_i · animRotate`           (deg, about glyph centre)
- opacity:  `α_i     = lerp(1, animOpacity, s_i)`  (base = 1)
- tracking: `track_i += s_i · animTracking`        (extra advance)
- color:    `fill_i  = lerp(fill, animColor, s_i)` (when "animate color" on)

**Range selector** (this is what gets keyframed to produce motion):

| field          | type            | meaning                                             |
|----------------|-----------------|-----------------------------------------------------|
| `selStart`     | scalar 0..1     | window start over the unit range                    |
| `selEnd`       | scalar 0..1     | window end                                          |
| `selOffset`    | scalar -1..1    | slides the window (the typewriter/stagger driver)   |
| `selUnits`     | enum            | `characters` \| `words` \| `lines`                  |
| `selShape`     | enum            | `square` \| `rampUp` \| `rampDown` \| `triangle` \| `smooth` |
| `selAmount`    | scalar 0..1     | global multiplier on `s_i`                           |
| `selEase`      | scalar -1..1    | ease high/low bias on the ramp                       |

`s_i = selAmount · shape( normalise(unitIndex_i, selStart, selEnd, selOffset), selShape, selEase )`.
`unitIndex_i` is char/word/line index normalised to `[0,1]` across the count of that unit.

Typewriter = opacity animator, `selShape=square`, keyframe `selOffset` (or `selEnd`)
`0→1`. Fade-up stagger = opacity+ΔposY animator, `selShape=smooth`, keyframe `selOffset`.

### Why declared ParamDefs (not a custom param type) for v1

Declared scalar `ParamDef`s get keyframing, the graph editor, exposing, and export
controls **for free** (devguide §"new node" 3). The selector's animatable fields
(`selStart/End/Offset/Amount/Ease`) and the property deltas are all scalars/colors →
all first-class keyframable. A custom `text_animators[]` array type (merge_layers
pattern) for **multiple stacked animators** is the v2 extension; v1 ships **one
animator** to prove the math without touching keyframes.ts.

Panel hygiene: gate every animator row behind `visibleIf: p => p.animEnabled === true`
(a boolean toggle) so the panel stays clean when unused.

New params (all on the Text node, grouped after styling):
`animEnabled` (bool) · `animPosX` `animPosY` (px) · `animScale` · `animRotate` (deg) ·
`animOpacity` (0..1) · `animTracking` (px) · `animColorEnabled` (bool) · `animColor` (color) ·
the 7 selector fields above.

### Rendering integration

- All animator math lives in **the MODULATED path of `drawTextBlock`**
  ([text-raster.ts:293](../src/engine/text-raster.ts#L293)). Any active animator forces
  the modulated path (extend the `isStyleAllConstant` gate with `style.animator != null`).
- Per glyph: `c2d.save(); translate(cx+adv/2, y); rotate; scale; globalAlpha=α_i;
  fillStyle=fill_i; fillText(centred); restore()` — extends the existing per-char loop.
- Derived outputs follow automatically: `sdf`/`spline` are read back from the same
  raster, so animated glyphs flow through to them. The `element` render path reuses
  `drawTextBlock` → animators apply in Auto Layout too. (maskDriven axes stay
  primary-only as today — mask coords are canvas space.)
- Caching: add the animator params to `computeRasterSig`. Because the selector fields
  are keyframed, `effectiveParams` (post wire>keyframe>constant merge) changes each
  frame during playback → sig changes → re-raster. `stable:false` already re-enters
  compute on every tick, so no new machinery.

### Presets

A small **preset dropdown** in ParamPanel (UI affordance, not engine state) that, on
pick, writes a **static** config of the params above (typewriter, fade-up, wave,
random-pop, scale-in) — it sets `animEnabled`, the property deltas, and a sensible
selector, then the user keyframes `selOffset`/`selEnd` themselves. **No auto-seeded
keyframes** (owner decision). "Thin configs on top of the core" = each preset is just a
`Partial<params>`. Lives in a `TEXT_ANIMATOR_PRESETS` table.

**Risk / cost**: per-glyph `save/restore` is more canvas2d calls; fine for typical
strings. Already `stable:false`, so per-frame raster during playback is the existing
cost profile (devguide §known-sharp-edges). **Position units: em-relative** (× font
size) so motion is resolution-independent — `animPosX/Y` are multiples of `font_size`.

---

## 2. Searchable Google Fonts database (#144) + weights/axes for all fonts

### Build script → JSON

`scripts/build-font-db.mjs` (run locally once, needs a Google Fonts Developer API key):
fetch the catalog → distill to `src/lib/font-db.json`:

```jsonc
{ "family": "Inter", "category": "sans-serif",
  "weights": [100,200,300,400,500,600,700,800,900],
  "italic": true,
  "axes": [{ "tag": "wght", "min": 100, "max": 900, "default": 400 },
           { "tag": "opsz", "min": 14, "max": 32, "default": 14 }],
  "popularity": 1 }
```

~1500 entries; keep it lean (drop subsets/file URLs we don't need) → a few hundred KB.
If payload matters, lazy-`import()` the JSON only when the picker opens. `CURATED_FONTS`
stays as the offline/system fallback list (Helvetica/Arial/etc. never hit the network).

### Searchable picker

New `ParamType: "google_font"` rendered in ParamPanel as a searchable combobox
(filter by name, grouped by category, live family preview in each row). **Change
`font_family`'s `type` from `enum` → `google_font`.** Back-compat is safe: the param
**name** and stored **value** (a family-name string) are unchanged — only the editor
widget changes (invariant #2 is about names/handles/values, not widgets).

### Dynamic loading + axes

- Generalise `googleFontsHref` ([fonts.ts:51](../src/lib/fonts.ts#L51)) to build the axis
  query from the db entry (`wght@…`, plus `opsz`, `slnt`, etc.) instead of the
  hardcoded `wght@100..900`.
- Resolve a family's axis list from **either** `custom_font.axes` **or** the db entry.
  Feed that into `styleFromParams` so `font_variations` UI + `applyAxisStyling` light up
  for built-in variable fonts. Update the `font_variations` `visibleIf` to also fire when
  the selected Google family has axes.

### Weights & italics (ships partly in M1, see milestones)

- `font_weight` (enum of the family's available weights, default 400) — feeds the weight
  slot in `applyAxisStyling`'s font shorthand; a `wght` axis value (if modulated) still
  overrides per glyph.
- `italic` (bool, gated on `family.italic`) — adds the `italic` style slot.
- The **quick-win slice** (M1): expose `font_weight` (100..900) + `italic` for *all*
  fonts immediately — the Google variable range is already downloaded, so no DB needed.
  The DB later refines the weight list to what each family actually ships.

**Caveat (note, not v1 blocker)**: CDN `<link>` loading works at runtime while online.
Exported standalone apps / offline keep relying on the CDN for now; bundling woff2 into
exports is a later milestone (consistent with devguide: fonts don't serialize today).

---

## 3. String input socket (#146)

New `string` socket so `text` (and downstream nodes) are graph-drivable. This is the
invariant-#7 type ripple — every touchpoint:

1. [types.ts](../src/engine/types.ts): add `"string"` to `SocketType`; add
   `export type StringValue = { kind: "string"; value: string }` and `| StringValue`
   to the `SocketValue` union.
2. [graph-helpers.ts:26](../src/engine/graph-helpers.ts#L26): `case "string": return "string"`
   in `paramSocketType`. **This alone makes Text's `text` param exposable** (ParamPanel
   already keys the expose button on `paramSocketType !== null`).
3. [coerce.ts](../src/engine/coerce.ts): add `scalar → string` (number → formatted text)
   and identity. (Optional later: `vec*/color → string`.) Mirror in:
4. [NodeEditor.tsx](../src/components/effects/NodeEditor.tsx) **both** `canCoerce` (~L692)
   and `isValidConnection` (~L986): `scalar → string`, `string → string`.
5. [socketColor.ts](../src/components/effects/socketColor.ts): pick an unused hue for
   `string` (proposal: `#a3e635` lime — distinct from scalar yellow and spline cyan).
6. [clips.ts:139](../src/engine/clips.ts#L139) `emptyClipOutput`:
   `case "string": return { primary: { kind: "string", value: "" } }`.
7. Docs/legend colour table if one enumerates socket types.

**Exposed-param resolution check**: when an exposed `string` param is wired, the
evaluator's wire-override merge must unwrap `StringValue.value → string` into
`effectiveParams.text` (the same path that unwraps `ScalarValue → number` for scalar
params). Verify/extend `resolveInputs`/override merge in the evaluator for non-numeric
param types — this is the one implementation unknown to confirm first.

### Producer node (day-one usefulness)

`src/nodes/source/text-value.ts` — **"Text Value"** (category `utility`):
- params: `value` (string) and an optional `precision`/`prefix`/`suffix` for the numeric
  path; input: optional `scalar`.
- compute: if the scalar input is wired, emit `prefix + format(n, precision) + suffix`;
  else emit the literal `value`.
- primaryOutput: `string`.

With `scalar → string` coercion + this node, any scalar source (audio level via
audio→scalar, math, a future counter) drives live text immediately.

---

## 4. Richer styling

All canvas2d, all in `text-raster.ts` `drawTextBlock`; low risk, high visual payoff.

- **Vertical alignment** `vAlign` enum (`top|middle|bottom`, default `middle` = current
  behavior). Adjust `startY` ([text-raster.ts:267](../src/engine/text-raster.ts#L267)).
- **Case transform** `textCase` enum (`none|upper|lower|title`). Apply to the string in
  `styleFromParams` / before `wrapStyledLines`. Pure, trivial, keyframe-irrelevant.
- **Gradient fill**: `fillMode` enum (`solid|linear|radial`) + reuse the existing
  `color_ramp` ParamType + `gradientAngle`. Build `c2d.createLinear/RadialGradient` as
  `fillStyle`. Interacts with animator color by multiply/tint.
- **In-raster stroke**: `strokeEnabled` (bool), `strokeWidth` (px), `strokeColor`,
  `strokeJoin` enum. `c2d.lineWidth/strokeStyle/lineJoin` + `strokeText` (drawn under the
  fill for an outline). Note: the spline **Stroke** node still exists for vector strokes;
  this is the inline convenience.
- **(Optional) per-character color modulation**: a color analogue of font-axis modes
  (gradient/cycle/random across glyphs). Defer unless wanted — gradient fill + animator
  color cover most needs.

---

## 5. Milestone plan (recommended order — reorderable)

Threads are independent; ordered by value-per-risk and momentum.

- **M1 — Quick styling + weights** *(small, immediate payoff, no new infra)*
  vAlign · case transform · gradient fill (`color_ramp`, whole-bbox) · in-raster stroke ·
  `font_weight` + `italic` for all fonts (CDN range already loaded). Touches only
  text.ts + text-raster.ts. *(Full per-family variable-axis exposure for built-in fonts
  waits for M4 — it needs the DB's axis metadata; `font_weight` covers weight now.)*

- **M2 — Per-glyph animators** *(headline)*
  Range-selector core + property deltas in `drawTextBlock` + single-animator params +
  preset dropdown. Pure text.ts/text-raster.ts; add params to `computeRasterSig`.

- **M3 — String socket (#146)**
  Type ripple (§3 touchpoints) + `scalar→string` coercion + Text input expose +
  Text Value producer node. Confirm exposed-param string unwrap in the evaluator first.

- **M4 — Font database (#144)**
  `build-font-db.mjs` → `font-db.json` · `google_font` searchable picker · per-family
  weights/axes wired to M1's UI · improved `googleFontsHref`. Largest infra slice.

- **M5 — (stretch)** multi-animator `text_animators[]` array param · per-char color
  modulation · woff2 bundling for offline/exported apps.

After each milestone: manual browser verification (no test runner) + update
[061226_devguide.md](061226_devguide.md)'s Text/known-edges notes.

---

## 6. Invariants & compatibility checklist

- **#1 engine self-containment**: all engine logic stays in `src/engine` + `src/nodes`;
  the `google_font` picker UI + preset dropdown live in `src/components` (UI only). The
  `font-db.json` lookup used *inside* the engine (axis resolution) must live engine-side
  or be passed in via params — keep the DB read in the UI/`src/lib` and pass resolved
  axes through `params`/style, OR put the json + a pure reader under `src/lib` reachable
  by nodes the way `fonts.ts` is today (fonts.ts is already imported by text.ts, so the
  precedent allows `src/lib` font helpers).
- **#2 back-compat**: no param **names** change. `font_family` keeps its name+string
  value (only widget type changes). New params default to current behavior
  (`animEnabled:false`, `vAlign:middle`, `fillMode:solid`, `strokeEnabled:false`,
  `font_weight:400`). Old saves render identically.
- **#7 type ripple**: §3 enumerates every `string` touchpoint.
- Keep the lazy `consumedOutputs` gating for `sdf`/`spline` intact through all edits.

---

## 7. Resolved decisions (owner, 2026-06-14)

1. **Animator position units** — **em-relative** (× `font_size`).
2. **Presets** — set **static params only**; user keyframes the selector. No auto-seed.
3. **Font DB payload** — **lazy-load** `font-db.json` on first picker open.
4. **String coercions** — **`scalar→string` only** for v1.
5. **Gradient** — measured over the **whole text bbox**.
