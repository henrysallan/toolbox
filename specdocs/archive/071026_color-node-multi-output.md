# Color node: multiple outputs + on-node swatch/picker controls

Devlist §415. Two parts: the Color (`color-literal`) node grows a `+`
button that adds more color outputs, and it pioneers **on-node param
controls** — a clickable color square per output row that opens a compact
picker popover (SV square + hue strip + hex field + eyedropper) directly
over the node.

## Multi-output model — declared params, fixed ceiling

NOT an array param. A `count` scalar (int 1..8, panel slider) plus
declared params `color` (Color 1), `color2` … `color8` (`visibleIf`
count ≥ n). Rationale: declared `color` params get keyframing, expose
(vec4 input socket), exported-app controls, autokey, and undo from the
existing machinery for free — an array param would need a fresh
virtual-key integration (evaluator + autokey + panel) for every one of
those. Ceiling of 8 is a pragmatic cap; the Color Ramp covers
gradient-sized palettes.

- Primary output stays `vec4` = color 1 (+ shared `alpha` param) —
  existing saves and wires are untouched; no schema bump (old saves
  simply have no `count` → defaults to 1).
- `resolveAuxOutputs(params)` mints `color2..colorN` vec4 outputs for
  count ≥ 2. The single `alpha` param applies to every output.
- Header `+` (EffectNode, like Merge/Collect) dispatches
  `effect-node-toggle {kind:"colorAddOutput"}`; the EffectsApp handler
  bumps `count` and re-resolves aux outputs. Shrinking `count` from the
  panel drops any edges wired to the removed outputs (cleanup in
  `onParamChange`, same pattern as ramp-stop removal).

## On-node controls

EffectNode renders, for `color-literal` only, a color swatch inside each
output row (primary + aux). Clicking a swatch opens
`ColorPickerPopover` (`src/lib/color-picker-popover.tsx` — lib-side so
the export bundle resolves it without an alias):

- saturation/value square + hue strip (HSV, pointer-drag, standard
  CSS-gradient construction), hex input field (draft/commit pattern
  copied from ColorControl), and an eyedropper button when the Chromium
  `EyeDropper` API exists.
- Anchored absolutely inside the node div ("directly over the node"),
  so it tracks pan/zoom with the node. `nodrag`/`nowheel` +
  stopPropagation keep xyflow gestures out; outside-click and Escape
  dismiss it.
- Edits dispatch `effect-node-param` — the existing bridge into
  `onParamChange`, so undo coalescing, autokey (a keyframed colorN
  keyframes from the node!), and socket re-resolution all fire
  naturally.
- The node gets a wider minWidth (220) to fit swatch + label rows.

The popover is deliberately a standalone component — it's the seed for
on-node controls on other nodes (gradient stops, paint color, …).

## Palette-from-image (follow-up)

The node gained an optional `image` input ("palette from"). When wired,
the stored colors are ignored and every output comes from a k-means
palette extraction over the image (`count` = palette size, color 1 =
most dominant). Pipeline in [color-literal.ts](../../src/nodes/source/color-literal.ts):

- GPU side: draw the image into a 32×32 alloc (statistical point-sample)
  and `ctx.readImageToFloat32` it — a negligible sync stall; the temp
  texture is released.
- CPU side (`extractPaletteFromPixels`, exported for tests): fully
  DETERMINISTIC k-means — no RNG, so a given image always yields the same
  palette and the eval cache stays coherent. Over-clusters (k+4, cap 12)
  with maximin seeding (mean-anchored farthest-point, so small distinct
  modes get seeds), 12 Lloyd iterations, then merges near-identical
  clusters (< 0.075 RGB distance, population-weighted) and returns the
  top-k by population — so k=1 is the dominant color, not the average.
  Transparent pixels (a < 0.1) are excluded; HDR clamps to 0..1; fewer
  distinct colors than k pads cyclically; a fully-transparent image
  falls back to the stored params.
- Caching: nothing extra — the wired image's fingerprint re-runs compute
  when it changes (video re-extracts per frame; static images extract
  once).
- UI: compute announces the palette via a "color-node-palette" window
  event AND a globalThis session store (`getExtractedPalette` — the
  segment-session pattern; compute doesn't re-run on cache hits so a
  remounting EffectNode seeds from the store). The on-node swatches
  mirror the extracted palette read-only ("Palette from image —
  disconnect to edit"); disconnecting reverts outputs and swatches to
  the stored params, which are never mutated.

## Universal picker (follow-up)

The same picker is now the app-wide color UI: `ColorSwatchPicker` (same
file) wraps a swatch button + a `position:fixed` PORTAL'd popover
(viewport-clamped, flips above when there's no room below; closes on
outside press / outer scroll / resize / Escape — the Dropdown pattern).
`ColorControl`'s swatch renders it instead of the native
`<input type="color">`, which covers every color param row, gradient
point, ramp stop, AND the live viewer / exported apps (ControlPanel
renders the shared ParamControl). AutoLayoutPanel's swatch uses it too.
EffectNode keeps the non-portal ColorPickerPopover anchored inside the
node div so it tracks graph pan/zoom.
