# Color-ramp stops: full color UI + per-stop keyframe / expose / control

Every `color_ramp` param (Color Ramp node, Rasterize Spline / Text /
Shape Cells `fill_ramp`, …) gets first-class per-stop parameter treatment:

1. The selected stop's **color row** uses the standard `ColorControl`
   (swatch + hex field + H/S/L steppers) — same UI as e.g. Rasterize
   Spline's stroke color — instead of the bare `<input type="color">`.
2. **color / alpha / position** of each stop can be **keyframed**,
   **exposed as an input socket**, and **marked as an exported-app
   control**, with the same three buttons a normal param row has.

## Virtual key format

One name grammar shared by all three systems (animation map keys,
`exposedParams` entries, `controlParams` entries):

```
ramp_c:<paramName>:<stopId>   stop color     (hex; kf = RGBA tuple; socket vec4)
ramp_a:<paramName>:<stopId>   stop alpha     (scalar 0..1)
ramp_p:<paramName>:<stopId>   stop position  (scalar 0..1)
```

`<paramName>` is embedded (unlike `gpoint_*`) so the key resolves to a
specific ramp param — a def may declare more than one `color_ramp`.
Helpers live in [conventions.ts](../src/engine/conventions.ts):
`rampColorKey/rampAlphaKey/rampPositionKey` + `parseRampParamKey` +
`rampFieldSocketType`, plus `colorValueToHex` (hex-string | rgba-tuple →
hex — also the normalizer for ALL `color`-param overrides, see below).

## Evaluator (wire > keyframe > stored, per field)

- Exposed-param loop: a virtual ramp name resolves its socket type from
  the field (vec4 / scalar), finds the `in:param:<key>` edge, coerces,
  and stashes `{paramName, stopId, field, value}` (fingerprint entry
  identical to a literal exposed param).
- Animation block (after merge-layer + gpoint blocks): ramp keys
  evaluate ("color" / "scalar"), stops clone once per param,
  fields write back (color normalized to hex, alpha/position clamped)
  → `keyframeOverrides[paramName]`.
- The wire stash then applies ON TOP of the keyframe-resolved clone →
  `paramOverrides[paramName]`. Wire wins per field; other fields keep
  their keyframed values. Dangling stop ids no-op.

Compute functions are untouched — they keep receiving a plain
`ColorRampStop[]` with hex colors.

### Literal color params normalize the same way (follow-up fix)

Nodes read `color` params as hex strings (`hexToRgba(params.stroke_color
as string)` …), but the evaluator could hand them non-hex values from two
paths: a wired vec4 on an exposed color param (`socketToParamRaw`
returned the raw tuple → `hex.replace is not a function` in the node),
and keyframe interpolation (values were lerped AS tuples but literal
color keyframes store hex → `[null,null,null,"00"]` garbage between
keys). Both fixed centrally:

- keyframes.ts `interpolate` coerces color keyframe values through
  `toRgbaTuple` (hex or tuple in → tuple math), so hex-stored keyframes
  interpolate correctly (oklab/rgb per the block).
- evaluator.ts normalizes every resolved `color`-param override to hex
  via `colorValueToHex` — in `socketToParamRaw` (wire path) and after
  `evaluateKeyframesAt` (keyframe path). Nodes' "color params are hex"
  invariant now holds on every path; no node changes.

## Editor

- EffectsApp `onParamChange`: auto-keyframe mirror for `color_ramp`
  edits (diff stops by id; color keyframes store RGBA tuples like
  gpoint colors), plus **stop-removal cleanup** in the same pass:
  removed stop ids drop their animation keys, `exposedParams` /
  `controlParams` entries, and any edges into their sockets.
- ParamPanel passes `layerAnim` for `color_ramp` and a new `rampIo`
  API (isExposed/isDriven/toggleExposed/isControlled/toggleControl,
  all keyed by virtual name) down through `ParamControl`.
- `ColorRampControl` renders per-row: keyframe diamond (gpoint
  pattern), expose + control toggle buttons (same glyphs/colors as a
  param row). A wired (driven) field renders its control read-only.
  The live viewer passes neither prop → plain ramp UI, unchanged.
- EffectNode resolves virtual exposed names to typed sockets labeled
  `<param label> · <field> <n>` (n = the stop's 1-based sorted index).
- NodeEditor `resolveTargetSocketType` understands ramp keys (so
  validation/splice/fuzzy-connect work); TrackEditor labels the
  virtual lanes the same way.

## Export / live viewer

- `buildExportManifest` resolves virtual `controlParams` entries into
  synthesized ParamDefs (color, or 0..1 scalar) with the stop's
  current value baked as the default; `paramName` stays the virtual
  key.
- LiveViewer `onParamChange` detects ramp keys and patches the stops
  array inside the owning `color_ramp` param instead of writing a
  literal param.

No schema bump: `exposedParams`, `controlParams`, and the animation
map already serialize free-form string entries.
