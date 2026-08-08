# Alpha channel on color params (spec, 2026-07-20)

Give fill/stroke color params a real alpha channel — an A control next to
H/S/L everywhere a color is edited — so transparency is tweakable per
color (fill vs stroke independently), keyframable, wirable, and honored
in exports. Opt-in per param; no schema bump.

## Current state (why this is cheap)

The value format is a hex string, and half the system already speaks
8-digit `#rrggbbaa`:

- **The spline render core parses it today.** `hexToRgba`
  ([spline-raster.ts](../../src/engine/spline-raster.ts)) and `hexToRgba01`
  ([spline-fill.ts](../../src/engine/spline-fill.ts)) both handle 8-digit
  hex — their comments explicitly anticipate a picker that emits it.
  Rasterize Spline, Stroke, Fill, and spline-color-source all consume
  through them.
- **Canvas-2D consumers get it free.** Text passes hex straight to
  `fillStyle`/`strokeStyle` (text-raster.ts), and Canvas accepts
  `#rrggbbaa` natively.
- **Exposed color params are already vec4 sockets**
  (graph-helpers.ts `paramSocketType`) — wires carry alpha now; it's
  dropped at the boundary.
- **Keyframes already interpolate RGBA tuples** (keyframes.ts
  `interpolate` case "color"; virtual keys — `gpoint_c`, `ramp_c` —
  store RGBA tuples; ramp stops have a separate alpha field already).
- **Serialization is untouched.** Hex strings are plain JSON; 8-digit
  round-trips as-is, old 6-digit saves read as opaque. No schema bump.

What actively drops alpha — three documented "param colors are RGB"
chokepoints plus the UI:

1. `normalizeHex` in [param-controls.tsx](../../src/lib/param-controls.tsx)
   AND its local twin in
   [color-picker-popover.tsx](../../src/lib/color-picker-popover.tsx) —
   both strip the `aa` bytes.
2. `colorValueToHex` ([conventions.ts](../../src/engine/conventions.ts)) —
   the tuple→hex normalization for wired/keyframed colors.
3. `toRgbaTuple` ([keyframes.ts](../../src/engine/keyframes.ts)) — hex→tuple
   pins alpha to 1.
4. ColorControl renders H/S/L rows but no A; ColorPickerPopover has no
   alpha slider; the live-viewer/exported-app control
   ([ExportParamControl.tsx](../../src/lib/live-viewer/ExportParamControl.tsx))
   is a native `<input type="color">`, which can never do alpha.

## The hazard (why opt-in, not a global flip)

67 `type: "color"` params across ~30 node files, many with a **local
`hexToRgb` copy** that `parseInt`s the whole string (solid-color.ts,
stipple.ts, voronoi.ts, gradient.ts, wedge.ts, sdf/*…). Feed one an
8-digit hex and the byte offsets shift — colors silently corrupt. So the
UI must never emit 8-digit hex to a param whose node hasn't been
verified. Hence:

## Design

### 1. `alpha?: true` on the color ParamDef

One optional flag in types.ts. Contract:

- **Without the flag** (default): today's behavior verbatim — controls
  emit 6-digit, `normalizeHex` strips `aa`, `colorValueToHex` drops
  tuple alpha. Un-audited nodes can never receive 8 digits.
- **With the flag**: controls emit 8-digit hex **only when alpha < 1**,
  6-digit when opaque. Existing project values stay byte-identical when
  a node opts in; a fully-opaque tweak still writes 6-digit (stable
  saves, and other tooling that assumes 6-digit keeps working until
  someone actually dials alpha down).
- Parse rule everywhere: 6-digit ⇒ a=1; 8-digit ⇒ trailing byte is
  straight (non-premultiplied) alpha — consistent with the engine-wide
  straight-alpha invariant (devguide § coordinate conventions).

### 2. UI

- **ColorControl**: an A row (0–100) after H/S/L, rendered only when the
  def opts in. `normalizeHex` gains an alpha-preserving mode
  (`normalizeHex(s, {alpha: true})`), gated by the flag — same for the
  popover's local copy.
- **ColorPickerPopover**: an alpha strip under the hue strip
  (checkerboard underlay, current-color gradient), 8-digit hex field
  accepted, `PICKER_HEIGHT` bump behind an `alpha` prop so non-opted
  hosts keep the compact layout. Eyedropper (returns 6-digit sRGBHex)
  **preserves** the current alpha rather than resetting it.
- **Swatches** (ColorSwatchPicker, on-node Color swatches): checkerboard
  underlay when alpha < 1 so transparency is visible at a glance.

### 3. Engine plumbing

- `toRgbaTuple` (keyframes.ts): parse digits 6–8 → tuple alpha.
  Unconditional — tuples are internal. Verify `lerpRgbaOklab` carries
  alpha linearly (oklab is 3-channel; alpha lerps outside it).
- `colorValueToHex` (conventions.ts): grow an `alpha` arg; emit `aa`
  when true and tuple alpha < 1. Callers pass the def's flag —
  `socketToParamRaw` (evaluator.ts) needs the flag threaded in (it
  currently takes only ParamType), same for the animated-readout path
  (`animatedValueAt`) and the virtual-key clone blocks.
- Wired vec4 → opted-in color param now honors the wire's alpha (the
  evaluator comment "The tuple's alpha is dropped" flips to flag-gated).
- Keyframing needs nothing else: color keyframes store the hex verbatim,
  so 8-digit keyframes interpolate correctly once `toRgbaTuple` parses
  them. Autokey/diamond paths go through the same normalize points.

### 4. First wave: fill & stroke params

Opt in the params whose render paths already honor 8-digit hex (or need
a one-line parser swap):

- **Spline Draw** `stroke_color` / `fill_color`, **Rasterize Spline**
  `fill_color` / `stroke_color`, **Stroke** `color`, **Fill** `color` —
  all through spline-raster/spline-fill; pure flag flip.
- **All spline primitives + SVG Source** — SPLINE_RASTER_PARAMS
  (spline-raster-aux.ts) is spread into Circle/Rectangle/Arrow/Arc/…,
  and SVG Source renders through the same rasterizeSplineAux, so one
  flip covers the whole family (came out broader than planned — the
  shared param module made it free).
- **Text** fill + stroke colors, **Point Labels** `color` —
  Canvas-native (verbatim into fill/strokeStyle); flag flip. Text's
  per-char color animators keep their own opaque min/max colors.
- ~~**Stipple**~~ — MOVED TO WAVE 2 at implementation time: its colors
  are GL accumulation-shader uniforms (vec3) behind a whole-string
  local parser, dot alpha needs real shader semantics (coverage-
  normalized accumulation over an in-shader background composite), and
  the background already pairs a `backgroundAlpha` scalar. The local
  parser is hardened to slice rgb (8-digit can't corrupt), flag stays
  off so the A field never silently no-ops.

Nodes that pair a color with an existing separate alpha/opacity param
(the `hexToRgba(hex, alpha)` override pattern): hex alpha and the paired
slider **multiply** — decided per node at opt-in time; today's override
semantics (hex `aa` wins when present) is corrected to multiply where
both exist.

### 5. Live viewer / exported apps

FOUND AT IMPLEMENTATION TIME: the live viewer's ControlPanel renders
the SHARED `ParamControl` (param-controls.tsx), so the alpha-enabled
ColorControl + picker arrive there for free once § 2 lands — the
manifest's deep-cloned ParamDef carries the `alpha` flag. The old
ExportParamControl.tsx (native `<input type="color">`) is unreferenced
legacy; it was still swapped to `ColorSwatchPicker` (with a new
`disabled` prop) for consistency should it be revived. Exported apps
need `npm run build:export-template` to pick up the lib changes
(dist + public copies are gitignored build outputs).

## Out of scope (wave 2+)

- **GL-uniform color sources** (Solid Color, Gradient, Voronoi, Shape
  Cells, sdf/*…): each needs its vec3 uniform widened or alpha
  multiplied in, plus a per-node look at compositing. Adopt gradually —
  the flag makes each a small, independent PR. Solid Color is the
  highest-value wave-2 target (a translucent full-canvas wash).
- **Wedge color mode**: emits vec4 with a=1 today; parsing 8-digit into
  the 4th component is a 2-line follow-up.
- Universal `OPACITY_PARAM` is unchanged — it fades a node's whole
  output; per-color alpha is orthogonal (fill vs stroke independently).
- No new ParamType, no storage flip for non-opted params, no schema
  bump.

## Milestones

1. **Plumbing + picker.** ParamDef flag; both `normalizeHex` copies;
   ColorControl A row; popover alpha strip + checkerboard swatches;
   `toRgbaTuple`; flag-threaded `colorValueToHex` /
   `socketToParamRaw` / `animatedValueAt`. Verify on one opted-in test
   param: 8-digit round-trips save/load; keyframe between a=1 and a=0
   fades; wired vec4 alpha lands; a NON-opted param still never
   receives 8 digits (type a `#rrggbbaa` hex into its field — alpha is
   stripped).
2. **Fill/stroke wave.** Opt in Spline Draw, the spline primitives +
   SVG Source (via SPLINE_RASTER_PARAMS), Rasterize Spline, Stroke,
   Fill, Text, Point Labels (Stipple deferred — see § 4). Verify:
   translucent fill over translucent stroke composites correctly
   (straight alpha — no double-darkening at soft edges); qtrle/ProRes
   alpha export of a half-transparent fill matches the preview.
3. **Exported apps.** Shared-ParamControl path confirmed (see § 5);
   ExportParamControl swapped for consistency; ColorSwatchPicker gains
   `disabled`; template rebuilt. Verify: an exported app +
   `/live/[slug]` show the alpha control on an opted-in param and the
   render updates live.

Ship note: update the devguide (§ recipes — "adding a ParamType"
adjacent) with the alpha-flag contract when milestone 1 lands.
