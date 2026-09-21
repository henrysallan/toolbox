# Text node: px / % units for font size (resolution-independent text)

Status: plan, 2026-09-19. Not started.

## Problem

Text's `font_size`, `strokeWidth` and `letter_spacing` are literal canvas
pixels at the render resolution (`text.ts` facts: `"param:font_size":
"pixels"`, and the gotcha says so). Two consequences:

1. **Comp resize.** Author at 2K, switch the project to 4K for the final
   export, and every Text node renders at half its relative size. Strokes
   solved exactly this in #174 with a `units` toggle (`px` | `%`), so the
   user works around it for strokes but not for text.
2. **Preview scale.** `renderRes = canvasRes × previewScale`
   (`EffectsApp.tsx:1399`), and the export override renders at full size
   with previewScale deliberately not applied. A px Text node therefore
   looks *twice as large* in a 0.5× preview as it will in the export.
   `%` text is immune to this too.

`resolveStrokePx` / `strokeUnitsParam` in `src/engine/stroke-units.ts`
already encode the convention: `%` = value / 100 × **canvas width**, default
stays `px` so saved projects never change output. Text should reuse it
rather than invent a second convention.

## Design

### M1 — the toggle (core deliverable)

- **New param** `units` on Text via `strokeUnitsParam("units")` (segmented
  `px | %`, default `px`), placed directly after `font_size` in the param
  list. One toggle governs all three pixel metrics — `font_size`,
  `letter_spacing`, `strokeWidth` — mirroring Stroke, where one `units`
  covers thickness + dash/dot lengths. A per-metric toggle is more UI for
  no real gain: nobody wants a `%` size with a `px` stroke.
- **Reference dimension: canvas width**, same as stroke-units and the
  `canvas01` coordinate space. Height (CSS `vh`-style) or `min(W,H)`
  (Auto Layout's 1/1000 unit) are defensible for type, but a third
  convention is worse than a slightly unusual one; and for the motivating
  case (same aspect, higher res) they are identical. Note in the gotcha that
  changing aspect (16:9 → 9:16) still changes text relative to height.
- **Resolution point.** `styleFromParams(params, family)` gains a
  `canvasWidth` argument and resolves the three metrics through
  `resolveStrokePx(value, params.units, canvasWidth)` before building
  `TextStyle`. Everything downstream already consumes resolved px:
  - the primary raster and image-fill coverage/stroke layers
    (`renderTextLayer`),
  - the `element` aux output (`measure`/`render` reuse `style`),
  - the `instances` aux output (`base: style`), which Copy to Points text
    mode and Point Labels rasterize at `ctx.width` — so `%` text placed on
    points scales correctly for free,
  - text-on-path's `side` offset (`size × 0.5`).
  `strokeFromParams` needs the same treatment (it is called separately for
  the image-fill stroke layer).
- **Raster signature.** Add `u: params.units` to `computeRasterSig`. `W`/`H`
  are already in the sig, so a `%` node re-rasterizes on a canvas resize
  with no other change.
- **Slider ranges.** `font_size` is `min 4 · max 1000 · softMax 200 · step 1`;
  in `%` the useful range is `0.1…20` and a hard `min 4` would forbid every
  sane value (4% of a 4K frame is 154 px). Two options:
  - *(recommended)* keep one param and make the range units-aware. `stepFrom`
    and `maxFrom` already exist as UI-only hints that ParamPanel applies
    and the export manifest bakes (`types.ts:1661`, `:1672`). Add
    `minFrom` and `softMaxFrom` with identical semantics, then on the three
    metrics return the `%` range when `params.units === "%"`. Relabel
    `Size (px)` → `Size` (the toggle sits beside it; `label` cannot be a
    function).
  - *(rejected)* parallel `font_size_pct` params gated by `visibleIf`.
    Clean ranges, but three more params, split keyframe tracks, and the MCP
    catalog / recipes / AE mapping all have to know two names for one thing.
- **Facts.** Keep `"param:font_size": "pixels"` (Stroke keeps `pixels` for
  `thickness` too — the vocabulary has no conditional space) and rewrite the
  existing gotcha: "font_size, strokeWidth and letter_spacing default to raw
  pixels; units=% resolves them as a percent of canvas width so the look
  holds across resolutions and preview scales." Run the node-facts gate.
- **No project-version bump.** Default `px`, additive param, old saves load
  unchanged (`migrateLoadedParams` untouched).

### M2 — convert the value when the toggle flips

Stroke does *not* convert (`4 px` becomes `4 %` = 41 px at 1024). For text
the whole point is "it looks right at 2K, keep it that way at 4K", so
flipping to `%` should preserve what is on screen:

- `strokeUnitsParam(name, visibleIf, { governs: string[] })` — the units
  def declares which sibling params it scales. New optional ParamDef hook
  `onEnumChange?: (from, to, params, env: { canvasWidth }) =>
  Partial<Record<string, number>>` returns the rescaled siblings
  (`px → %`: v / W × 100; `% → px`: v / 100 × W).
- `EffectsApp.onParamChange` (`EffectsApp.tsx:6651`) applies the returned
  patch in the same undo step, and multiplies every keyframe value in the
  governed params' `KeyframeAnimationBlock`s by the same factor
  (`AnimationMap` is keyed per param, so this is a map over
  `block.keyframes[i].value`). Easing handles are in normalized segment
  space and need no change.
- **Which width?** Use the project `canvasRes[0]`, not `ctx.width`. At
  previewScale 0.5 the preview is lying about px text (see Problem §2); the
  conversion should preserve the *export* look, and after the flip the
  preview becomes correct too. Say so in the toggle's tooltip.
- Retrofit: pass `governs` for Stroke / Rasterize Spline / Spline Draw /
  spline-raster-aux / Spline Pack / Blend Intersections so they get the same
  conversion. Opt-in per node, so it can ship for Text alone first.

### M3 — sibling text nodes (optional)

`points-to-text.ts` and `point-labels.ts` each have their own `size` param
labelled `Size (px)` (fallback when no Text node is wired into `style`).
Give them the same `units` toggle through the same helper. Point Labels
already folds canvas size into its cache fingerprint for pixel units, so
only the resolution call changes.

### Out of scope / later

- A project-level "new Text nodes default to %" preference. Precedent says
  defaults never change saved output; a preference is the right place if it
  is ever wanted.
- AE handoff (`091926_after-effects-handoff.md`): AE `TextDocument.fontSize`
  is comp pixels, so the exporter resolves `%` against the export comp width
  — one line in the text mapper once that project starts.

## Files

| File | Change |
|---|---|
| `src/nodes/source/text.ts` | `units` param; `styleFromParams` / `strokeFromParams` take `canvasWidth` and resolve via `resolveStrokePx`; `u` in raster sig; range hints on the three metrics; facts gotcha; label |
| `src/engine/stroke-units.ts` | `governs` option + `onEnumChange` (M2) |
| `src/engine/types.ts` | `minFrom`, `softMaxFrom` (M1); `onEnumChange` (M2) |
| `src/components/effects/ParamPanel.tsx` | apply `minFrom` / `softMaxFrom` next to the existing `maxFrom` / `stepFrom` handling |
| `src/lib/export-manifest.ts` | bake `minFrom` / `softMaxFrom` like `maxFrom` (check-export-manifest guards this) |
| `src/components/effects/EffectsApp.tsx` | `onParamChange`: apply `onEnumChange` patch + keyframe rescale (M2) |
| `src/nodes/effect/points-to-text.ts`, `point-labels.ts` | `units` toggle (M3) |
| `scripts/check-text-units.mts` + `package.json` `check` | new gate (below) |

## Verification

The `check-*` scripts stub DOM and GL, so the gate tests the pure half:

- extract the metric resolution into a pure exported helper
  (`resolveTextMetrics(params, canvasWidth) → { size, letterSpacing,
  strokeWidth }`) and assert: `px` is a pass-through regardless of width;
  `%` scales linearly with width; the raster sig differs between `px` and
  `%` at equal values and is stable when only `previewScale` would change
  a `%` node's *relative* look;
- M2: `px → % → px` round-trips at a fixed width; keyframe values rescale by
  the same factor and ticks/easings are untouched.

Then `npm run typecheck`, `npm run check` (includes `check-node-facts` and
`check-export-manifest`), `npm run lint:ratchet` per TESTING.md §1. Live
pass: a Text node at 1920×1080 in `%`, project set to 3840×2160 → identical
framing; previewScale 0.5 vs export override → identical framing; toggle
`px → %` at previewScale 1 → no visible change (M2).
