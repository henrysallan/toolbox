# Animated param readouts (2026-07-15)

Keyframed params used to render frozen in the param panel: the canvas
animated but every slider/field/swatch showed the stored constant. Now a
control whose param is animating displays the **keyframe-evaluated value at
the playhead**, so it visibly moves while scrubbing or playing.

## The one rule

Display value = the keyframe step of the evaluator's
`wire > keyframe > constant` merge, computed by the shared helper

```
animatedValueAt(block, paramType, tick, stored)   // engine/conventions.ts
```

- block missing / `animated:false` / no keyframes → `stored` (unchanged UI).
- `color` normalizes to hex via `colorValueToHex`, exactly like
  `effectiveParams` (interpolation returns 0..1 RGBA tuples between keys).
- **Driven params are excluded** — the wire wins over keyframes and the row
  already renders dimmed; we can't cheaply know the wire's live value, so
  driven controls keep showing the stored constant.

Display-only, always: edits still write against the **stored** params.
That round-trips because EffectsApp's autokey inserts the edit as a
keyframe at the same tick the control displayed — after an edit,
evaluated(tick) === what the user just set.

## Where it applies

- **ParamRow** (ParamPanel.tsx): all keyframable types — scalar sliders,
  vec2/3/4 fields, color, boolean, enum. Also group-shell "remote control"
  rows (they render the interior param's ParamRow).
- **AutoLayoutPanel**: its `num()` reads are animation-aware, so W/H, gap,
  padding, stroke, corner radius, and the canvas-placement transforms follow.
- **Virtual-key sub-controls** (param-controls.tsx, via the small
  `animScalarAt`/`animColorHexAt` wrappers around `LayerAnimApi`):
  - Merge layer opacity (MiniBarSlider + number field).
  - Gradient points x/y/color.
  - Color-ramp stops — bar gradient, handle positions/colors (re-sorted by
    *display* position since animated positions can cross), and the selected
    stop's color/alpha/position fields. Per-stop wired fields keep stored
    (wire > keyframe per FIELD, matching evaluator + `drivenStyle`).
    Click-to-add samples the **displayed** ramp so the new stop's constant
    matches what was clicked.
- Live viewer / exported apps are untouched — they pass no `layerAnim` /
  `paramName`, and the helpers fall through to stored values.

## Diamond capture fix (rode along)

Inserting a keyframe mid-segment used to capture the stored constant,
snapping the curve. ParamRow, the AutoLayout KeyframeControl seeds, and the
virtual-key diamonds now capture the **evaluated** value — pin, don't snap —
matching TrackEditor's `toggleKeyAtPlayhead`, which already did this.

## Why it re-renders at all

ParamPanel subscribes to the playback clock store (`useClock(s => s.tick)`,
071026_clock-store.md) and already re-rendered per tick for diamond states;
readouts ride the same render. Pushing the subscription into leaf rows is
still the noted follow-up optimization if the whole-panel render ever shows
up in profiles.

## Known boundaries

- **On-node controls don't animate** (the Color node's header swatches on
  the graph canvas): EffectNode deliberately doesn't subscribe to the clock —
  animating swatches would re-render graph nodes 60×/s. Revisit only with a
  leaf-level subscription.
- Typing in ColorControl's hex field *while playing* an animated color gets
  clobbered by the per-frame prop sync — pause to type. Scalar NumberFields
  are immune (draft state while editing).
