# Spline Draw — animation & interop program (onion skin, per-anchor keys, width, blend, SVG, ghosts)

Status: agreed 2026-07-27 (design Q&A done). Successor program to
071926_spline-draw-authoring-upgrade.md, building on the spline-editor/
module architecture and the optional-anchor-field pattern (`broken`,
`cornerRadius`) it established.

Decisions from the Q&A (owner-confirmed):

- **Per-anchor keyframing = per-anchor virtual-key tracks** (ramp-stop
  pattern). A Spline Draw uses EITHER per-anchor tracks OR the legacy
  whole-shape Path Animation morph — no layering. Old saves untouched.
- **Width profile stores a thickness MULTIPLIER** per anchor (1 = base);
  animating base thickness scales the whole profile, and profiles stay
  meaningful across px/% stroke units.
- **Multi-node editing v1 = ghosts + snap + click-to-switch** (full
  simultaneous co-editing deferred).
- Blend is an EXTENSION of Spline Interpolate (it already builds the
  interpolated family), not a new node.

## M1 — Onion skinning for Path Animation

While editing a spline whose "Path Animation" is keyframed, ghost the
NEIGHBORING KEYFRAME shapes (not playhead offsets): previous keyframe in
red (#f87171), next in green (#4ade80) — the classic animator convention —
as dashed, non-interactive outlines under the editing chrome, run through
the effective-geometry fillet like every preview. `SplineEditorOverlayAtTick`
(GizmoTickOverlays) already owns the animation block: it finds the stored
keyframe values strictly before/after the playhead tick and passes them as
`onionPrev`/`onionNext` props. Dock gains an onion toggle (default ON),
visible only when a ghost exists.

## M2 — SVG Export node

`svg-export` (spline category, utility): spline input + styling params
(stroke on/width/color, fill on/color, even-odd), an "Export SVG" action in
the panel that snapshots the CURRENT playhead's evaluated input and saves a
standalone .svg via `platform.saveFile` (native dialogs on desktop).
Mapping: cubic beziers → `<path>` C commands verbatim; normalized coords ×
canvas resolution with the same aspect-correct y mapping the rasterizer
uses; viewBox = canvas WxH. Devlist #176. Compute stashes the latest input
spline in `ctx.state` so the panel action can grab it without re-evaluating.

**Shipped extension — spline taps on Output and Layer Output.** Both render
targets carry the same capability inline, so the SVG is a product of the
composition (or of one layer) rather than a separate node you have to keep
wired. Shared machinery: the SAME `svgExportStashKey(nodeId)` stash and the
same `SVG_STYLE_PARAMS` (exported from svg-export.ts and declared by every
surface), so EffectsApp's single `exportSvgNode` serves all three. Wiring a
tap reveals an on-node **SVG** button next to Image/Video (`SvgExportButton`
in EffectNode.tsx — self-gating on the connection, so the default chrome is
unchanged) and, in the panel, the styling rows plus an "Export SVG →" twin.
Empty tap ⇒ nothing renders and nothing is stashed.

- **Composition Output** — a plain optional `spline` input; its own compute
  writes the stash.
- **Layer Output** — a third entry in `LAYER_OUTPUT_SOCKETS`
  (`image`/`audio`/**`spline`**). It has no compute of its own (flatten
  dissolves every group boundary), so flatten PUSHES the tap onto the layer
  shell's new hidden `in:spline` — exactly the route `image` → `in:content`
  already took, now table-driven via `LAYER_OUTPUT_TO_LAYER_INPUT` — and
  `layer.compute` stashes under the LAYER's id. `exportSvgNode` maps a Layer
  Output to its `parentId` to find that stash, while styling params still
  come from the Layer Output (which owns the layer's export config). The
  evaluator's gated-layer edge drop covers `in:spline` alongside
  `in:content`, so a layer outside its clip window keeps no interior spline
  branch alive.
- **Back-compat, no schema bump.** Layers saved before the socket existed
  store `sockets: [image, audio]`. Since a fixed boundary's interface is
  immutable, `resolveOutputBoundarySockets` (groups.ts) treats
  LAYER_OUTPUT_SOCKETS as the source of truth and appends anything missing;
  `group-output.resolveInputs` and the read-only socket panel both go
  through it so they can't disagree. Handle ids are name-based, so
  appending can't disturb existing edges.

`EXPORT_PARAMS` stays the Layer-Output-mirrored list — the SVG rows are
appended on the Output def only, and both places that mirror the comp
Output's export config (`ParamPanel`'s LayerOutputExportSettings,
`graph-ops`'s layer seeding) now read `EXPORT_PARAMS` directly instead of
the whole def; the layer panel appends the SVG rows itself, gated on the
wire. Filename falls back to `filename` → node name → `"spline"`.

Caveat inherited from the node version: the stash only refreshes on evals
that reach the stashing node. With a **viewport-Active node** set (the sole
eval target, per `computeNeededSet`), or on a gated/bypassed layer (whose
compute is skipped), the snapshot can be stale.

## M3 — Width profiles

`SplineAnchor` gains `width?: number` — a multiplier on the consuming
stroke's base thickness (absent = 1). Optional field ⇒ no schema bump;
lerps in Path Animation (`lerpSpline`) like cornerRadius.

Editor: a **Width tool** (6th mode, key `W`): each anchor of the active
subpath shows a pair of widgets offset perpendicular to the path tangent;
dragging either sets the multiplier symmetrically (HUD shows `× 1.40`).
Widget base distance derives from the node's own stroke thickness when its
stroke is enabled, else a fixed px base. Right-click → "Reset width".

Engine: `buildWidthEnvelopePath` (spline-width.ts) — sample the subpath in
px space (aspect-correct, exact affine-mapped cubics), smoothstep the
anchor multipliers along each segment, offset ±(thickness × mult)/2 per
side; open paths get round caps, closed ones two opposite-winding rings
(nonzero fill punches the hole and keeps tight-corner self-overlaps solid).
Consumed by the **Stroke node** and the shared `rasterizeSplineAux` (so
Spline Draw's own raster preview matches). Precedence as shipped: a
profiled subpath renders via the envelope FILL — dash/dot are ignored for
it (fills don't dash — profile wins); **Repeats win over profiles** (rings
apply only at repeats = 1, so one profiled anchor never disables the whole
Repeats feature). Widget scale shipped SYMBOLIC (16px per ×1) rather than
thickness-derived — predictable at any zoom/units; the node raster shows
the true envelope live. Element outputs keep flat stroke (v1).

## M4 — Blend (Spline Interpolate: distribute along a spine)

Spline Interpolate gains an optional `spine` spline input + placement
params: when wired, each family member (inputs + in-betweens, in chain
order) moves to an even arc-length station along the spine (centroid →
station), with optional rotate-to-tangent. Unwired spine = today's behavior
exactly. Uses measureSpline/sampleSplineAt + transformSpline.

## M5 — Multi-node ghosts + snap + switch

While the overlay edits one Spline Draw node, every OTHER Spline Draw
node's spline renders as a dim ghost outline (effective geometry,
keyframe-aware at the tick). Their anchors join the snapping targets. In
the select tools (path/subpath), clicking a ghost switches the overlay to
that node (EffectsApp selection change); pen/pencil clicks keep drawing.
Dock toggle "Show other splines" (default on). GizmoTickOverlays passes
`others: {nodeId, value}[]` + an `onSelectNode` callback.

## M6 — Per-anchor keyframing (ids + tracks)

Two halves, shippable separately:

**M6a — stable anchor ids.** `SplineAnchor.id?: string` (short random),
minted by every editor op that creates an anchor; existing anchors get ids
lazily the first time per-anchor animation touches them. Optional field, no
migration.

**M6b — per-anchor tracks.** Virtual keys on the spline param (the
ramp-stop pattern): `anchor_p:<id>` (pos, vec2), `anchor_in:<id>` /
`anchor_out:<id>` (handle offsets, vec2 — a missing handle IS [0,0], so
vec2 lerp is exact). Evaluator resolves them onto a cloned spline before
compute; EffectsApp autokey mirrors anchor/handle drags into the dragged
anchors' tracks at the playhead; deleting an anchor drops its tracks in the
same onParamChange pass (ramp-stop precedent). EITHER/OR with whole-shape
Path Animation: if the `spline` block itself is animated, per-anchor tracks
are ignored (and the panel steers you to one system at a time). Track
Editor shows per-anchor diamonds (vec2 ⇒ diamonds only, like other
non-scalars); the overlay keeps editing the evaluated shape and branches
edits from what's displayed, exactly like Path Animation today.

## Invariants touched

- Optional anchor fields only (`width`, `id`) — plain JSON, no schema bump.
- Engine self-containment: buildWidthEnvelope + SVG path serialization live
  engine-side; spline-editor/ stays components-side.
- One onChange per gesture; virtual keys follow the documented ramp-stop
  recipe (evaluator clone-block + autokey mirror + cleanup on removal).
- Width/dash incompatibility documented rather than silently mangled.
