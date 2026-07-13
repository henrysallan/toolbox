# Multi Stroke — Repeat Path node + Stroke repeats + float-curve param (2026-07-12)

Devlist #175 ("expand the stroke effects available… multi stroke, repeated
strokes with options for repeat inner, repeat outer, how many repeats,
spacing, with a float curve interface to control spacing"). Also folds in
the units fix for #174 ("stroke thickness changes when we change canvas
resolution").

Two delivery surfaces sharing one offset engine, plus one new generic
param type:

- **Repeat Path** — a new spline→spline modifier that emits N
  parallel-offset copies of the input path. Composable: feed the copies
  into Stroke, Trim Path, Spline Boolean, Rasterize Spline, anything.
- **Stroke node repeats** — a collapsible "Repeats" section on the
  existing Stroke node for the common one-node case, with per-repeat
  styling (thickness falloff, opacity falloff, color ramp) that a
  downstream-of-Repeat-Path stroke can't do.
- **`float_curve` param type** — a single-channel 0..1→0..1 curve editor,
  extracted from the RGB Curves machinery. Reusable anywhere a "shape this
  falloff" knob is wanted.

## Decisions (from design Q&A)

1. **Both architectures.** Repeat Path node for composability AND a
   repeats section on Stroke for per-repeat styling. Shared engine code so
   the two never drift.
2. **Fixed band, curve places.** The user sets a total band `width` +
   `count`; stroke i sits at offset `width × curve(i/(count−1))`. Identity
   curve = even spacing; ease curves bunch strokes toward the path or the
   band edge. Predictable outer bound (good for animation); the default
   linear curve starts at (0,0) so stroke 0 lies exactly on the source
   path.
3. **Normalized units + fix #174 here.** Repeat offsets are normalized
   (resolution-independent). Stroke's px-based metrics (thickness,
   dash/dot lengths) gain a `units` toggle — `px` (default, legacy) or
   `%` of canvas — resolved through one shared helper that Spline Draw /
   Rasterize Spline adopt too, closing #174.
4. **All three styling curves in v1 scope**: thickness falloff curve,
   opacity falloff curve, color ramp across repeats (Stroke node only —
   Repeat Path emits geometry and has no styling).

## Shared infrastructure

### `float_curve` param type (new ParamType)

A single monotone-cubic curve mapping x∈[0,1] → y∈[0,1]. Value is a plain
`CurvePoint[]` (`{id, x, y}`) — plain JSON, serializes as-is, **no schema
bump**.

- **`src/engine/float-curve.ts` (new)** — the model moves engine-side,
  exactly the `engine/color-ramp.ts` precedent (engine rasterizers must
  sample it without an engine→nodes import, invariant #1):
  - `CurvePoint`, `sanitizeFloatCurve(v)`, `defaultFloatCurve(y0, y1)`
    (configurable endpoints — spacing wants (0,0)→(1,1), thickness/opacity
    multipliers want the flat identity (0,1)→(1,1)).
  - `computeMonotoneTangents` + `evalMonotoneCubic` MOVE here from
    [color-correction.ts](../src/nodes/effect/color-correction.ts)
    (Fritsch–Carlson, unchanged); color-correction re-exports them for
    back-compat with existing importers (rgb-curves, RgbCurvesPanel).
  - `sampleFloatCurve(points, x)` — tangents + eval in one call, with a
    tiny WeakMap tangent cache keyed on the points array (param values
    round-trip by reference, so identity is a sound cache key).
- **types.ts** — add `"float_curve"` to the ParamType union. `ParamDef`
  needs nothing new (default carries the endpoint choice).
- **Param UI** — generalize the existing curve editor in
  [param-controls.tsx](../src/lib/param-controls.tsx) (the `curves`
  renderer's drag/add/remove/double-click-delete logic) into a
  single-channel `FloatCurveEditor`; the `curves` type keeps its
  channel-tabbed wrapper around it. Rendered inline in the param row,
  compact (~96px tall), with a small "reset" affordance like the RGB
  Curves panel.
- **keyframes.ts** — NOT keyframable (like `curves`); `isKeyframable`
  already defaults false, no change needed. Exposing as an input socket
  and export-app controls: also out of scope v1 (like `curves`).
- **Checklist ripple (recipe step 5)**: types.ts union ✓, ParamPanel
  renderer ✓, keyframes default-false ✓, export-manifest — unsupported
  control type (skipped at manifest build like `curves`), serialization —
  plain JSON ✓.

### `src/engine/spline-repeat.ts` (new) — the offset engine

One function both surfaces call:

```ts
buildRepeatStrokes(subpaths, opts: {
  count: number;            // total strokes incl. the base (≥1)
  direction: "inner" | "outer" | "both";
  width: number;            // normalized band width (canvas-width fraction)
  spacingCurve: CurvePoint[];
  widthPx: number; heightPx: number;   // for isotropic offsetting
}): { t: number; subpaths: SplineSubpath[] }[]
```

- **t** = `i/(count−1)` (0 when count=1) — the normalized repeat index the
  Stroke node feeds to its styling curves/ramp.
- **Offsets are computed in canvas-pixel space** so rings stay uniformly
  spaced on non-square canvases: scale anchors/handles by (W, H), offset
  by `width × curve(t) × W` px via `offsetSubpath`
  ([spline-math.ts](../src/engine/spline-math.ts)), scale back. The
  distance unit is therefore **canvas-width–relative**, matching the SDF
  compiler's `u_aspectCorrect` convention. (Offset Path's existing raw
  normalized-space offset is anisotropic on non-square canvases; changing
  it would alter saved looks, so it stays — noted as a candidate follow-up
  behind a param.)
- **Winding normalization**: for each closed subpath compute the shoelace
  signed area and flip the offset sign so `outer` always expands and
  `inner` always contracts, regardless of authoring direction. For open
  subpaths inner/outer degrade to side-of-travel (inner = left, outer =
  right); document this in both node descriptions.
- **`both`** mirrors every non-zero offset to ±: count is strokes *per
  side*; a stroke at offset 0 (curve(0)=0) is emitted once, not twice.
- **Known limitation (accepted)**: parallel curves self-intersect at
  concave regions once the offset exceeds the curvature radius — same
  behavior Offset Path has today. No clipping pass in v1.
- Cost is CPU bezier-js work per repeat × subpath. Both callers cache by
  signature (below), so it only runs on geometry-affecting edits.

## Repeat Path node (new)

`src/nodes/effect/repeat-path.ts`, registered in nodes/index.ts.

- `type: "spline-repeat"` (immutable), name **Repeat Path**, category
  `spline` / `modifier`, spline in → spline out.
- Params:
  - `count` — scalar int, 1–64, softMax 16, default 3.
  - `direction` — enum `outer | inner | both`, default `outer`.
  - `width` — scalar, 0–0.5, softMax 0.2, step 0.001, default 0.05
    (normalized, width-relative).
  - `spacing_curve` — `float_curve`, default `defaultFloatCurve(0, 1)`.
- Compute: flatten `buildRepeatStrokes` results into one `SplineValue`,
  tagging each repeat's subpaths with `groupIndex = repeat index` so
  group-aware downstream nodes (per-group ramp fills, Shortest Path
  group selects…) can address rings individually. This overwrites any
  incoming groupIndex tags — same "one identity per emitted group"
  stance as Points to Spline.
- Pure CPU deterministic modifier — no state, no `stable:false`; the
  fingerprint cache handles it. count=1 with curve(0)=0 returns the input
  subpaths pass-through (tagged), so the default insert is near-free.

## Stroke node repeats + styling

All new params sit in a "Repeats" group on
[stroke.ts](../src/nodes/effect/stroke.ts), inert at defaults — old saves
load with identical output, **no schema bump** (params merge into
defaults; nothing renamed).

- `repeats` — scalar int, 1–32, softMax 8, default 1. Everything below
  `visibleIf: p.repeats > 1`.
- `repeat_direction` — enum `outer | inner | both`, default `outer`.
- `repeat_width` — scalar 0–0.5, softMax 0.2, default 0.05 (normalized).
- `repeat_spacing` — `float_curve`, default (0,0)→(1,1).
- `repeat_thickness` — `float_curve`, default flat (0,1)→(1,1); lineWidth
  multiplier per repeat.
- `repeat_opacity` — `float_curve`, default flat (0,1)→(1,1); globalAlpha
  per repeat.
- `repeat_color_mode` — enum `solid | ramp`, default `solid`.
- `repeat_colors` — `color_ramp`, `visibleIf: repeat_color_mode === "ramp"`;
  sampled at t per repeat via the existing engine-side `sampleColorRamp`
  ([color-ramp.ts](../src/engine/color-ramp.ts) — already returns a
  Canvas2D-ready `rgba()` string). Ramp-stop virtual keys (keyframe/
  expose/control) work here for free — the machinery keys off the param
  type, not the node.

Compute changes:

- The raster loop becomes: for each repeat i (inner→outer order so outer
  rings draw last), `buildPath2D` its offset subpaths, set
  lineWidth/strokeStyle/globalAlpha from the curves/ramp at t, stroke.
  Dash/dot/cap/join setup is unchanged and applies to every ring.
- **Two-tier cache** inside the existing signature scheme: a `geomSig`
  (spline identity + repeats/direction/width/spacing curve + W/H) guards
  the `buildRepeatStrokes` + `Path2D[]` build, kept in node state; the
  full `sig` (geomSig + styling) guards the raster. Color/opacity/
  thickness edits re-stroke cached Path2Ds without re-running bezier-js
  offsets.

## Units toggle — closes #174

Root cause of #174: stroke metrics are absolute px, so the same project
at a different canvas resolution draws visually thinner/thicker strokes.

- **`src/engine/stroke-units.ts` (new tiny helper)**:
  `resolveStrokePx(value, units, ctx)` → `units === "%" ? value/100 *
  ctx.width : value` (width-relative, consistent with repeat spacing).
- Stroke node gains `units` — enum `px | %`, default `px` (legacy
  behavior for old saves). It governs `thickness`, `dash_length`,
  `dash_gap`, `dot_spacing`. Labels stay px-phrased; the docs description
  explains the toggle.
- Same param + helper applied to the other px-thickness rasterizers:
  **Spline Draw**, **Rasterize Spline**, **spline-raster-aux** (whichever
  of their stroke params are px-based). Each keeps `px` as its default —
  #174 is fixed by opting a project into `%`, never by silently changing
  saved output.

## Milestones

1. **float_curve foundation** — engine/float-curve.ts (move + new
   helpers, color-correction re-exports), types.ts union,
   `FloatCurveEditor` extraction in param-controls.tsx, `curves` renderer
   re-based on it. Verify RGB Curves is pixel-identical after the
   refactor.
2. **Offset engine + Repeat Path node** — engine/spline-repeat.ts
   (winding normalization, px-space isotropic offsets, `both` mirroring),
   repeat-path.ts node, registration, groupIndex tagging. Verify on
   circle (closed, both windings), open S-curve, compound path (letter
   with hole), non-square canvas (rings stay concentric).
3. **Stroke repeats + styling** — params, two-tier cache, styling curves
   + ramp sampling, draw-order. Verify dashed/dotted styles per ring,
   ramp virtual-key keyframing on `repeat_colors`, and that repeats=1
   output is byte-identical to today's.
4. **Units toggle (#174)** — stroke-units.ts, `units` param on Stroke +
   Spline Draw + Rasterize Spline + spline-raster-aux. Verify a `%`
   project renders proportionally at 720p vs 4K.
5. **Docs + bookkeeping** — node descriptions (docs pages derive from
   defs), devlist #174/#175 annotations, devguide "sharp edges"/recipes
   touch-ups (new param type noted in the recipe-step-5 list).

## Verification (manual, per devguide)

- `npm run typecheck` + `npm run check` + lint ratchet.
- Old-project load: a saved Stroke renders identically (defaults inert);
  RGB Curves projects unaffected by the helper move.
- Cache behavior: dragging color/opacity doesn't re-run offsets (log or
  perf-profile once during dev); playback with a static multi-stroke hits
  the fingerprint cache (no per-frame re-raster).
- Export: multi-stroke renders identically in offline video export and in
  an exported app (engine self-containment — everything new lives under
  src/engine + src/nodes).
