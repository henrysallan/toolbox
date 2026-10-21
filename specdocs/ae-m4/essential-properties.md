# M4 lane 6 — exposed knobs → After Effects controls

Results, 2026-10-21, for spec `091926_after-effects-handoff.md` §10 M4
("exposed knobs → Essential Properties"). Branch
`claude/ae-m4-essential-props-4117ed`. Measured in After Effects
**26.5 (26.5x89)**, headless through `aerender` under the AE lock. The
owner's AE GUI was never contacted.

## The answer to "does it work headless?"

**Yes.** `Property.addToMotionGraphicsTemplateAs(comp, name)` and
`AVLayer.essentialProperty` both work in aerender's render core. An
Essential Properties override set by script survives save and reopen. When
the saved project renders, the override reaches the precomp's internal
properties through expressions that read the precomp's own controls. The
fallback (Expression Controls on the precomp layer) is not needed and isn't
built.

Probe: `npx tsx scripts/ae-export-spike/essential/probe.mts` (plus
`--second` and `--ocio`).

| question | measured |
|---|---|
| Expression Control match names and params | `ADBE Slider Control` / `ADBE Angle Control` / `ADBE Point Control` / `ADBE Color Control` / `ADBE Checkbox Control`, each with one value param `<match>-0001`. Point is TwoD_SPATIAL; Color is COLOR, read as `[r, g, b, a]` |
| Dropdown Menu Control (`ADBE Dropdown Control`) | Once added, its match name is `Pseudo/@@<id>`. `menu.setPropertyParameters(items)` works headless and returns the new param. The effect gets a **new** `Pseudo/@@…` match name and its display name is **reset** to "Dropdown Menu Control", so set the items first and the name after. The value is 1-based (max = item count), addressed `#1` |
| `addToMotionGraphicsTemplateAs(comp, name)` headless | true for all six controls and for a shape property (Fill Opacity); `canAddToMotionGraphicsTemplate` true |
| Essential Graphics order | each add lands at the **top** of the list (adds A, B, C read back C, B, A), so the builder adds in reverse |
| `comp.motionGraphicsTemplateName` | "Untitled" by default; settable by script |
| `AVLayer.essentialProperty` | `ADBE Layer Overrides`, one property per controller, named after it, match name = the controller's (`ADBE Slider Control-0001`…) |
| override by script | `essentialProperty.property(name).setValue(v)` works (dropdown included). `setValueAtTime` keys it (linear at mid: 50 between 10 and 90). `canSetExpression` is true |
| override in a render | two precomp layers of one comp, one overridden: the render shows its own Radius 70 / red, the other the comp's Radius 30 / green |
| reading an override from outside | `thisComp.layer("B").essentialProperty("EP Radius")` in an expression = 70 |
| an expression naming a layer / comp / effect that doesn't exist yet | `expressionError` is set ("Expression disabled. … missing or does not exist") but `expressionEnabled` stays true. It **evaluates correctly** once the target exists (60 = 2·30, the cross-comp value 17). The stale message clears when the expression is re-assigned |
| OCIO startup project (found on the way) | the untouched startup project had `colorManagementSystem` 1 (OCIO), 32 bpc, working space "None", from AE's sticky "AE Last Project Settings" pref. OCIO refuses `bitsPerChannel` 16 ("Not supported for OCIO color managed mode"). There is no `ColorManagementSystem` enum in 26.5 ExtendScript; `colorManagementSystem = 0` (Adobe) sets, and then 16 bpc and the sRGB working space take |

## The mapping

| toolbox | After Effects |
|---|---|
| a Control-toggled param (`controlParams`, listed by `buildExportManifest` as the live panel lists it) | an Expression Control on **one `Controls` null at the top of the main comp**, named `<node> · <param label>` |
| a node-group's promoted input (Group Input socket → interior param or widget data socket, unwired after flatten) | the group renders as a **precomp of its own** (forced, even for one layer) with its own `Controls` null. Its controls are in that comp's **Essential Graphics** (named after the socket), so each precomp layer shows them under Essential Properties |
| a toolbox layer's promoted input | the same: the layer's content becomes a precomp and the main comp's layer for it is that precomp layer |
| a promoted input of a group that never renders as its own precomp (its output is a spline a style outside consumes) | the main `Controls` null, named `<group> · <socket>` |
| a param wired straight from a Constant whose `value` is a knob | that Constant's knob: the walk's graph view hides the wire, so the consumer converts and links like a knob of its own. The expression snaps to the Constant's step, as its compute does |

Controls by param type: scalar → Slider (Angle when the label has ° or the
name is a rotation), boolean → Checkbox, enum → Dropdown Menu (menu =
option labels), color → Color, vec2 → Point.

**A control holds the knob's toolbox value**, the number toolbox's panel
shows. The expression on each driven property converts it with the walk's
own maps. At rest, every expression gives its property's own value, which
the offline gate checks for every link. What links, and how:

| consumer | expression |
|---|---|
| `scalarProp` (radii, sizes, stroke width, trim, roundness, polystar radii, text rotation…) | `a·control + b`, the call's own affine map |
| `pairProp` (ellipse size, rect size / position, text pivot / translate / scale…) | per component: `a·control + b`, `value[i]` for components that aren't knobs |
| `colorProp` (fills, strokes, solids, text, effect colors) | the Color Control. A keyed knob's OKLab expression or dense keys go on the **control** |
| TRS (`nodeTransform`: Transform, Gizmo, a toolbox layer, image transforms) | Rotation = control (degrees); Scale = `Math.max(0.0001, c)·100` per axis; Anchor = the pivot map (canvas, or the static bounding box for `space=local`); Position = pivot px + W·translate. If something else moves on that axis, it becomes `value + a·(c − c₀)`, which is exact while the knob itself is static |
| a toolbox layer's opacity | `content% · control` |
| calibrated effect params (`calibration.ts`) | affine maps (`linear`) → `a·control + b`; enum maps → Dropdown, `[ae values…][control − 1]`; bool maps → `control != 0 ? on : off` |
| Toolbox Shader sliders | the control directly (a promoted channel, or a Constant knob wired into the channel) |

A keyed knob's keys and eases go on the control; the driven property is
static plus the expression.

What does **not** link (the report says why, per knob):
- a knob inside baked footage, or in a shader region that bakes: **baked**;
- a knob feeding a value graph (math, remap…): sampled per frame, until the
  expression compiler asks `knobExpression()` for its leaves;
- structural params (a stroke on/off, a polygon's point count), gradient
  stops (not scriptable), Merge layer blend / opacity keys, strings, vec3,
  ramps: **unlinked**;
- a wired param (the wire wins);
- a pivot on `space=local` over a moving bounding box, a TRS knob on a
  transform that is sampled because another TRS param is wired, and a knob
  that is keyed together with another moving term on the same Position
  axis.

### For the expression compiler (lane 1)

`knobExpression(ctx, nodeId, param): string | null` in
`src/lib/ae-export/scene/knobs.ts` (re-exported from `scene/index.ts`). It
returns an AE expression for the knob's toolbox value, or null when the
param is not a knob:
- a number for Slider / Angle (a Constant knob: snapped to its step);
- `(c != 0)` for a Checkbox;
- the option string for a Dropdown;
- `[r, g, b, a]` 0–1 for a Color;
- `[x, y]` for a Point.

The result carries a placeholder (`$tbxKnob<k>l<n>$`). The walk's final pass
(`KnobRegistry.finish`) resolves it to the right `Controls` layer for
whichever comp the compiled expression lands in: `thisComp` in the knob's
home comp, `comp("<home>")` elsewhere. Embed the string unchanged in any
`expression` field. `validateAeScene` refuses a scene with an unresolved
placeholder. A Constant knob's wire is already hidden from the walk's graph,
so the compiler sees that param as unwired and static.

## Where it lives

- `src/lib/ae-export/scene/knobs.ts`: `KnobRegistry` (discovery, the
  Constant-wire graph view, the link methods, forced group precomps, the
  final pass and report lines) and `knobExpression`.
- Hooks, one or two lines each: `context.ts` (`scalarProp`, `pairProp`,
  `colorProp`, `WalkCtx.knobs`; `scaleProp` now scales a prop's expression
  with its value, so a linked opacity under a layer's opacity stays exact); `trs.ts` (`nodeTransform`); `layers.ts`
  (`collapse(…, force)`, a toolbox layer's precomp home, layer opacity);
  `effects.ts` (`mapParam`); `shader.ts` (TBX sliders); `index.ts`
  (registry, `render` wrapper, `finish`).
- `types.ts`: `AeEffect.menuItems`, `AeEffect.essential`,
  `AePlanReport.controls` (`AeControlLine`, `AeControlKind`).
- `runtime/build.jsx`:
  - Dropdown items before the name;
  - Essential Graphics adds per comp, last and in reverse, then
    `motionGraphicsTemplateName`;
  - expressions that recorded an error re-assigned once every comp exists
    (any that still fail become build warnings);
  - `colorManagementSystem = 0` before the bit depth;
  - a Controls line in the summary.
- `runtime/validate.ts`:
  - `menuItems` only on a Dropdown, and not empty;
  - a Dropdown's value must be `#1`;
  - `essential` unique per comp and only on Expression Controls;
  - no unresolved placeholders;
  - `report.controls`.
- `package/files.ts`: a "Controls (exposed knobs)" section in the README /
  report, only when the scene has knobs.
- Docs: a Controls section in `docs/ae-conventions.md`;
  `docs/generated.ts` regenerated.

## Verification

- **Offline:**
  - `npx tsx scripts/check-ae-export.mts controls` (50 checks):
    - the U fixtures, structure and report;
    - every linked expression, evaluated in a shim of AE's expression
      objects, equals its property at rest, and equals the scene walk of
      the same change made in toolbox;
    - variations: a keyed knob, a local pivot, displace's affine `amountX`
      and enum `channelX` (Dropdown), a toolbox layer's promoted input and
      opacity, a solid's alpha knob under a 50 % layer, a spline group,
      baked / structural / value-graph knobs, a Toolbox Shader channel,
      `knobExpression`;
    - the validator rules.
  - Snapshots `u-controls`, `u-group-essential`. The facts, package-scenes,
    runtime and package-paths areas pass.
- **Live (headless):**
  - `npx tsx scripts/ae-export-spike/essential/roundtrip.mts`, **27 / 27
    checks**. One aerender launch builds both packages with build.jsx (no
    problems, no warnings) and changes the controls as an AE user would:
    - `u-controls`: Rotate 30 → 45°, Translate X 100 → 200 px, Size 0.125
      → 0.1875, Paint orange → `#0066ff` on the Controls null. Rotation,
      Position, Rectangle Size and Fill Color read back equal to toolbox's
      walk of the same change, to 1e-3; Size is 240.64 because of the
      Constant's step snap. The render shows the moved, turned, recolored
      chip.
    - `u-group-essential`: the precomp's Essential Graphics are
      `Radius, Color`, in order, under the template name. The main comp's
      precomp layer shows them at the toolbox values. Overriding them
      (Radius 150 px, red) renders red at r = 130 and empty at r = 160,
      while the precomp rendered alone stays green at 90 px.
  - `npx tsx scripts/fixtures/ae-export/graphs/roundtrip.mts u-` (the scene
    lane's probe pixels): both fixtures pass.

## For the integrator

- `build.jsx` changed, so the `BUILD_JSX_SHA256` pin in `electron/ae-core.js`
  and `build-jsx.generated.ts` are updated on this branch. Other lanes'
  build.jsx edits will conflict on the pin: re-run `gen-runtime.mts` and
  re-pin after merging.
- **The OCIO startup project** (above) hits every lane's headless build
  today: one "bitsPerChannel … OCIO" build problem per package. The
  `colorManagementSystem = 0` line in `applyProject` fixes it. See the note
  `ae-m4-essential-props-ocio.md` in the shared notes folder.
- **Pre-existing, not fixed here (scene lane):** `scene/shader.ts` looks up
  a wired GLSL channel as `in:${p.name}`, but GLSL Expression channel
  sockets are `in:<channel id>`, so their handle is `in:in:<id>`. A wired
  channel is therefore never sampled; it exports its row default.
  `knobs.ts`'s Toolbox Shader link resolves the id itself.
- `context.ts` (`pairProp` / `colorProp` gained a `knobs?: false` option,
  used to compute the plain prop under a link) and `index.ts` (the graph
  passed to the walk is `knobs.graph`) are touched by the instances lane
  too; the hunks are small and apart.

## Not done / not measured

- The expression compiler's use of `knobExpression` (lane 1, after merge).
- Point Controls: no native consumer reads a vec2 param, so they are
  reachable only through `knobExpression`.
- Merge per-layer blend / opacity knobs (`mlayer:`), ramp stop knobs,
  string knobs (Source Text), vec3 (3D Point Control).
- 32 bpc, the AE app build (headless only), Windows.
- A keyed knob read through two clocks: the control's keys follow the first
  link's clock.
