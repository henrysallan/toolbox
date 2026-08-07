# On-node color ramp + the `color_ramp` socket

Snapshot 2026-08-05. Two halves of the same complaint about ramps.

**M1 — the ramp becomes editable on the node body.** A Blender-style mini ramp
(gradient bar with draggable handles, a selected-stop row, an H/S/L/A field
row) rendered directly on the Color Ramp node, so nudging a stop no longer
costs a selection round-trip into the params panel.

**M2 — a ramp becomes a wire.** `color_ramp` joins the socket types, the Color
Ramp node gains a `ramp` aux output, and every `color_ramp` param in the app
gains an expose button. One authored ramp can then drive Stroke's colour,
Rasterize Spline's fill and stroke ramps, Ascii, Diffusion Curves — instead of
each node carrying its own hand-rebuilt copy.

## Problem

**Ramps are panel-only.** The ramp editor (`ColorRampControl`,
param-controls.tsx) is good, but it lives in the params panel. Every stop nudge
while looking at the graph is select-node → find the param → drag → look back.
The node body already hosts an editable text box (String, Text), a scalar
slider (Constant, Switch) and a colour swatch (the SDF family) via
`STRING_INPUT_PARAMS` / `SCALAR_INPUT_PARAMS` / `COLOR_SWATCH_PARAMS` in
EffectNode.tsx — ramps are the conspicuous omission, and they are the param
you most want to eyeball against the canvas.

**Ramps can't be shared.** Nine params across eight nodes are typed
`color_ramp`:

| node | params |
| --- | --- |
| `color-ramp` | `stops` |
| `stroke` | `color_ramp`, `repeat_colors` |
| `rasterize-spline` | `fill_ramp`, `stroke_ramp` |
| `ascii` | ×2 |
| `diffusion-curves` | ×2 |
| `sdf-material`, `shape-cells`, `text` | ×1 each |

Every one of them is an island. Authoring the same five-stop palette for a
spline's fill and its stroke means building it twice and re-editing it twice.
The Color Ramp *node* — the obvious place to author one — can only remap an
image's luminance; its ramp is not observable from outside.

The existing escape hatch is the per-stop expose (`ramp_c/a/p:<param>:<stopId>`
— engine/conventions.ts), which mints a vec4/scalar socket per stop *field*.
That is the right tool for animating one stop's colour from a wire. It is the
wrong tool for "use this palette over there": five stops is fifteen sockets,
and the stop *set* still can't change.

## Decision (design Q&A)

- **Registry, not auto-detection, for the on-node widget.** `RAMP_WIDGET_PARAMS:
  Record<defType, paramName>`, seeded with `"color-ramp": "stops"`, exactly like
  the three sibling registries above it. Auto-detecting "any node with a
  `color_ramp` param" would immediately put two ramps on Ascii, Stroke,
  Rasterize Spline and Diffusion Curves, and there is no honest rule for which
  one belongs on the body. Adding SDF Material later is a one-line entry.
- **Bar + stop row + H/S/L/A, and the node gets NARROWER.** The body carries
  the gradient bar (click to add, drag handles to move, ✕ to remove), a `n/N` +
  position row with the colour swatch, and the H/S/L/A fields beneath it. The
  ramp node's `minWidth` drops to **150** — below the 200 default, not above
  it. A ramp is a tall control; a node that is mostly gradient reads better
  than one padded out sideways to fit a single row of number fields. Two
  consequences follow from that floor, and both are the point rather than a
  compromise:
  - **H/S/L/A stacks 2×2**, not 4-across. Four labelled number fields in a row
    need ~260px of node (it is exactly what sizes Color / Solid Color, which
    keep their 260). The grid puts every channel one click away at 150 and
    stretches if the node is dragged wider.
  - **Interpolation stays in the panel**, with no `def.headerControl`. A
    header enum dropdown sets a width floor of its own — wide enough to read
    "constant" — which fights the whole point. It is a set-once choice, unlike
    the stop values you nudge against the canvas.
- **Reuse, don't reimplement.** `HslField` / `NumberField` (lib/number-field.tsx),
  `hexToHsl` / `hslToHex` / `sampleRampColor` / `sampleRampAlpha` /
  `withHexAlpha` / `hexAlpha01` (lib/param-controls.tsx) and `ColorPickerPopover`
  all already exist and are already reached from EffectNode. The widget is
  assembly, not new primitives.
- **No keyframe diamonds or expose buttons on the node.** Those stay panel-only.
  The on-node ramp is the quick-adjust surface; the panel remains the full one.
  (`ColorRampControl` keeps its per-stop diamonds and `RampIoButtons`.)
- **`color_ramp` is a CPU-descriptor socket**, in the established shape of
  `sdf` / `position` / `force` / `emitter`: `{ kind: "color_ramp"; stops;
  interp }`. No texture, so no ownership rules and nothing for `coerce.ts` to
  do — `coerceValue` short-circuits on `value.kind === target` and correctly
  falls through to `undefined` for everything else.
- **Aux output, not primary.** Color Ramp keeps `image` as its primary (it is
  still a luminance remap); the ramp rides as an aux `ramp` socket. Its `image`
  input relaxes to `required: false`, because "a Color Ramp used purely as a
  palette source" is now a legitimate graph and would otherwise trip
  `REQUIRED_INPUT_UNWIRED` (graph-validation.ts) forever.
- **The wire carries stops only, for now.** `socketToParamRaw` returns the bare
  `ColorRampStop[]`, so every consumer keeps working untouched — they all do
  `Array.isArray(params.x)` and hand the result to `sampleColorRamp` — and
  saved projects keep storing an array (invariant #2). The consequence, stated
  so it is a decision and not a surprise: **a ramp set to `ease` or `constant`
  on the source node samples `linear` once wired into Stroke.** `ColorRampValue`
  carries `interp` regardless, so lighting it up later (a `<ramp>_interp`
  sibling param on consumers) is purely additive.
- **Whole-ramp wire wins; per-stop applies on top.** Both expose mechanisms now
  coexist on the same param. A whole-ramp wire lands in `paramOverrides` and
  replaces the array; the per-stop `ramp_*` wires apply after keyframe
  resolution, matched by stop id. Where the upstream ramp reuses the id, the
  per-stop wire still lands; where it doesn't, it no-ops. That ordering is
  already what evaluator.ts does — this spec just names it as the contract.

## M1 — on-node ramp widget

`src/components/effects/EffectNode.tsx`:

```ts
const RAMP_WIDGET_PARAMS: Record<string, string> = {
  "color-ramp": "stops",
};
```

`NodeColorRamp` renders below the socket rows, in the same
`borderTop: 1px solid var(--tb-n-7)` section every other on-node widget uses —
at the 150px floor:

```
┌ Color Ramp        ┐
│ ● image   image ● │
│            ramp ● │   ← M2
├───────────────────┤
│ ▓▓▓▓▒▒▒░░░░░░░░░░ │   ← gradient over checker
│  ▲        ▲       │   ← handles, drag to move
│ 2/3 [0.500] [■] × │
│ H[210]    S[100]  │
│ L[ 50]    A[100]  │
└───────────────────┘
```

Behaviour, matching `ColorRampControl` so the two surfaces agree:

- Click the bar (not a handle) inserts a stop at that position, sampling the
  current ramp for its colour and alpha, and selects it.
- Drag a handle to move it; `pointermove`/`pointerup` bind to
  `usePanelWindow() ?? window` so a popped-out pane works. The position is
  `(clientX - rect.left) / rect.width`, which is zoom-invariant (both terms are
  post-zoom screen px).
- ✕ removes the selected stop; disabled at one stop.
- The swatch opens `ColorPickerPopover` anchored inside the node div, so it
  tracks graph pan/zoom. It runs `alpha: true` against
  `withHexAlpha(stop.color, stop.alpha)` and splits the result back into the
  model's separate `color` (6-digit) + `alpha` (0..1) fields.
- Edits dispatch the whole stops array through `effect-node-param`, so undo
  coalescing (`param:<id>:stops`), autokey and the ramp-stop-removal cleanup in
  `onParamChange` all apply unchanged.
- `useNodeConnections` on `in:param:stops` — a wired ramp (M2) renders the bar
  read-only and dims the fields, same contract as `NodeScalarSlider`.

Node `minWidth` for a ramp node is **150** — its own branch, deliberately not
shared with the `hasOutSwatch` (Color / Solid Color) 260 branch even though
both render H/S/L/A fields, because those lay them out 4-across and this one
does not.

## M2 — the `color_ramp` socket type

Invariant #7's ripple list, and what each site actually needs:

| file | change |
| --- | --- |
| `engine/types.ts` | `SocketType` += `"color_ramp"`; `ColorRampValue = { kind: "color_ramp"; stops: ColorRampStop[]; interp: ColorRampInterp }` into `SocketValue` |
| `engine/graph-helpers.ts` | `paramSocketType`: `case "color_ramp": return "color_ramp"` |
| `engine/coerce.ts` | nothing — identity short-circuits, no cross-type coercion is meaningful |
| `engine/evaluator.ts` | `socketToParamRaw`: `case "color_ramp": return sv.kind === "color_ramp" ? sv.stops : undefined` |
| `engine/clips.ts` | `emptyClipOutput`: an empty-stops ramp |
| `components/effects/socketColor.ts` | one dark/light pair, then `npm run gen:theme-css` |
| NodeEditor validation ×2 | nothing — both route through `coercible`, whose `src === tgt` line already covers it |
| `nodes/effect/color-ramp.ts` | `auxOutputs: [{ name: "ramp", type: "color_ramp" }]`; return it from `compute`; `image` input → `required: false` |

The expose button on every other ramp param is **derived, not authored** —
ParamPanel computes `exposable = paramSocketType(p.type) !== null`, so the
`graph-helpers.ts` line above is what turns it on for Stroke, Rasterize Spline,
Ascii, Diffusion Curves, SDF Material, Shape Cells and Text simultaneously. No
per-node work, and no consumer edits: the override arrives as the same
`ColorRampStop[]` those nodes already read.

Socket hue: coral `#f87962` dark / `#ca3a23` light. Picked by measuring the
OKLCH hue angle of every shipped socket colour and taking the widest usable
gap — 31° between `particles` (16°) and `vector` (48°) — so it reads distinctly
from both the pink-red particle descriptors and pure orange. The light value is
the house derivation (cap OKLCH L at 0.56, chroma ×1.15). The wide blue gap
(spline 212° → image 255°) was rejected: `rasterize-spline` carries a spline
input, an image output AND two ramp params, so a blue ramp wire would be
ambiguous on exactly the node that needs it most.

## Verification

`npm run typecheck`, `npm run check`, `npm run lint:ratchet`, and
`npm run check:theme-css` after `gen:theme-css`.
