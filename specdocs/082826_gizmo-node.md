# Gizmo node + `transform` socket (2026-08-28)

Share one on-canvas TRS+pivot control across many consumers. Today the
transform gizmo is glued to the Transform node (and SVG Source): select it,
drag handles, those params live on that node, and they only apply to *its*
input. Placing two Points the same way means duplicating constants into each
`position` vec2 — and that still only shares translation.

This splits authoring from application: a `transform` value on a wire, a
Gizmo node that authors it through the existing handles, and an optional
`transform` input on primitives and Transform.

Closest analog is the SDF `position` pipeline (Position Translate emits a
value; Circle consumes it) and `color_ramp` (one ramp, many consumers). This
is the CPU/geometry version — one node carries the full affine instead of a
chain of Translate / Rotate / Scale.

## Decisions

- **`transform` is a CPU-descriptor socket**, same family as `color_ramp` /
  `force` / SDF `position`. No texture, no coercions (`coerceValue` matches
  on `kind === target` and refuses everything else).
- **Gizmo authors; Transform applies.** Gizmo has no geometry. Transform
  stays the operator that applies an affine to image / spline / points.
  Giving Transform a `transform` aux out would work, but then every shared
  placement needs a dummy Transform sitting on some geometry.
- **Primitives compose; Transform replaces.** Circle / Rect / Point (etc.)
  generate as they do today, then apply the incoming transform — identity is
  a no-op, so wiring a default Gizmo does not jump the shape. Transform the
  node, when `transform` is wired, uses that value *instead of* its own TRS
  params (hide those rows and its own gizmo). Tile stays. Extra local offset
  belongs on another Gizmo in between, not mixed into Transform's params.
- **Gizmo in → Gizmo out composes.** Parent applies after local
  (`world = parent ∘ local`, local first). Same parenting model as AE nulls.
- **Pivot on a Gizmo is canvas-space.** Source vs Canvas only makes sense
  with incoming geometry. Transform-the-node keeps its Pivot-from control
  when using its own params; a wired `transform` already baked a pivot.
- **Selecting the Gizmo shows the handles**, not selecting a consumer.
  Primitive gizmos hide when `transform` is wired (`hideWhenWired`), because
  they would sit at the rest pose. Size stays in the params panel for M1.
- **Gizmo rest box is a 0.3×0.3 square** about the canvas center
  `(0.35,0.35)–(0.65,0.65)`, not the unit canvas and not any consumer's
  bounds. It is a null, not a bounds overlay.
- **Out of scope for M1:** Text / SVG / Auto Layout transform inputs (they
  already have their own gizmos); SDF primitives (they have the `position`
  AST); size handles in world space; parented gizmo widget in parent space
  (handles edit local TRS in canvas space even when a parent is wired — data
  composes correctly, the widget may not sit on the composed result).

## Value

```
TransformOp = {
  translateX, translateY,   // canvas offset, default 0
  scaleX, scaleY,           // default 1
  rotateDeg,                // clockwise on screen, default 0
  pivotX, pivotY,           // canvas coords, default 0.5
}

TransformValue = {
  kind: "transform";
  ops: TransformOp[];       // applied first-to-last; [] = identity
}
```

Math per op matches Transform / `transformSpline` today:
`T · P · R · S · P⁻¹` in authored [0,1]² Y-down. Point instance rotation
adds; instance scale multiplies (absolute scale factors). Image consumers
fold the op list to one 2×3 affine and inverse-sample.

Empty `ops` is identity. Identity ops are dropped on emit so a default
Gizmo with a parent passes the parent through unchanged.

## Gizmo node

- **Type / placement:** `gizmo`, name "Gizmo", category `utility`,
  `src/nodes/effect/gizmo.ts`. `noMaskInput`. `stable: true`.
  `supportsTransformGizmo: true` (same param names as Transform's TRS).
- **Input:** optional `transform` (compose with a parent Gizmo).
- **Output:** primary `transform`.
- **Params:** `translateX/Y`, `scaleX/Y` (linked pair), `rotate`, `pivotX/Y`.
  No `space`, no tile, no geometry input.
- **On-canvas:** existing `TransformGizmo` against the rest box above,
  `pivotSpace: "global"`. Motion path on translate + pivot, same as Transform.

## Consumers (M1)

Optional `transform` input, required: false. Unwired = today's behavior.

| node | when wired |
|---|---|
| Circle, Rectangle, Polygon, Star, Arc, Spiral, Cross, Sine Wave, Arrow | generate + trim as today, then apply |
| Point | emit as today (vec2 `position` still overrides x/y), then apply. Transform wins over vec2 as the *outer* placement. |
| Transform | incoming value **replaces** own TRS; hide TRS/`space` rows and the node's gizmo. Tile still uses the folded affine. |

Spline primitives share `TRANSFORM_INPUT` next to `SPLINE_FILL_INPUT` and
run apply *before* the bundled raster so the `image` / `element` aux match.

## Socket-type ripple (invariant #7)

`transform` joins `SocketType` / `SocketValue`. Also: `socketColor.ts` +
`npm run gen:theme-css`; `clips.ts` empty = identity; `time-offset.ts`
carried set (CPU descriptor, like `color_ramp`); Switch `TYPES`;
`ValueSummary` (kind + op count). No `paramSocketType` mapping — this is a
socket, not a param type. No coerce rows.

Wire hue: cyan-300, a cousin of spline (`#22d3ee`) the way `points3d` is a
cousin of `points` — `{ dark: "#67e8f9", light: "#0e7490" }`.

## Files

- `src/engine/types.ts` — type + value
- `src/engine/transform-value.ts` — compose, apply spline/points, fold to affine
- `src/nodes/effect/gizmo.ts` — the node
- `src/nodes/effect/transform.ts` — input + replace
- spline primitives + `point.ts` + `spline-raster-aux.ts`
- `src/components/effects/GizmoTickOverlays.tsx` — rest box for `gizmo`
- `src/components/effects/EffectsApp.tsx` — hide Transform gizmo when wired
- `src/components/effects/PrimitiveGizmo.tsx` — `hideWhenWired: ["transform"]`
- `scripts/check-gizmo-transform.mts`

## Milestones

M1 (this doc, one pass): socket + math + Gizmo + consumers above + hide
rules + check script. Verified with `npm run typecheck` + `npm run check`
(matrix image path is GLSL — `check:shaders` if that shader is in the emit
list; CPU paths are the check script).

M2 (follow-ups, not this pass): world-space size handles; parent-space
gizmo widget; Text / SVG / Auto Layout inputs.
