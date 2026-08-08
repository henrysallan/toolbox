# Auto Layout (devlist #142) — implementation plan

Figma-style auto layout as a node: pipe N inputs in, choose horizontal/vertical,
alignment, padding, gap; children size as fixed / hug-contents / fill-container;
layouts nest. This doc locks the architecture decided in design discussion
(2026-06-12) and breaks the work into milestones.

## Implementation status — SHIPPED (2026-06-12, M1–M4)

All four milestones landed. Files: engine/{layout,element,text-raster}.ts,
nodes/effect/autolayout.ts, nodes/source/frame.ts, plus the integration
touches listed in §6. Notable deltas from the plan as written:

- `wrapImageAsElement` (engine/element.ts) serves the coercion, Frame, AND
  trim — trim re-wraps the slot's `sourceImage` with the alpha-bbox region
  instead of a bespoke trimmed-element type. Regions support negative
  width/height for flipped sampling (Image Source's Y-down bitmap upload).
- The element → image coercion result is identity-cached in a WeakMap
  keyed on the ElementValue (same invalidation logic as the trim bbox), so
  per-eval coercion cost is near-zero on cache-hit upstreams.
- preferredSizing-on-first-wire ships minimally: only Image Source's
  element aux stamps its slot fixed/fixed (in EffectsApp's onConnect);
  every other source keeps the hug/hug slot default. Spec marked the field
  advisory; runtime `preferredSizing` is populated everywhere regardless.
- Text element ignores maskDriven axis modulation (mask coordinates are
  canvas-space, which doesn't exist inside a layout rect) — primary only.
- Space-between on a hug main axis packs with gap 0 (no leftover to
  distribute); n ≤ 1 falls back to packed, as specced.
- Aux element `measure` honors `maxWidth` by re-solving under the forced
  width when the container hugs (so nested hug heights reflect wrapped
  text), and clamps hug heights to `maxHeight`.
- Text being `stable:false` means Auto Layout recomputes per frame during
  playback when a Text element is wired — same cost profile as Text→Merge.

### Follow-up (same day): bounds gizmos + text box

Owner feedback after first build: symmetric scale gizmos are wrong for
box-like nodes — dragging an edge should move THAT edge and anchor the
rest, and Auto Layout manipulation should edit real bounds, not scale.

- PrimitiveGizmo (the Circle/Rectangle center+extents gizmo) gained an
  `anchorResize` mode (dragged edge/corner tracks the pointer, opposite
  side anchored; shift on a corner squares off the anchor) and env-aware
  adapters (canvas dims, raw param access, solved container size).
- **Text** now has a text box: `boxWidth`/`boxHeight` (fractions of the
  canvas, 1×1 default = exact pre-box rendering, so old saves are
  unchanged) + a "Wrap in box" toggle that word-wraps the primary raster
  at the box width. Alignment is box-relative; vertical centering is
  within the box; box position rides translateX/Y (the transform
  post-pass). Gizmo: bounds-based ("text" adapter); scale/rotate/pivot
  are panel/keyframe-only now (gizmo box ignores them when non-default).
- **Auto Layout**'s gizmo ("autolayout" adapter) edits translate +
  width/height in units; resizing an axis flips it hug → fixed
  (Figma-style); hug axes display the solved container size (read from
  the eval cache's aux element `measure({})`).

### Follow-up 2: aspect-aware elements + native splines + image routing

Owner feedback: (1) spline primitives should work natively, holding
ratio as the layout resizes; (2) a fill/fill/cover image blew up and
clipped vertically once the container got wide; (3) an image's upstream
canvas-fit leaked downstream when wired in.

Root cause of (1)+(2): image/spline elements reported a *fixed* natural
size and ignored layout constraints, so one axis stayed pinned at full
canvas/bitmap pixels while the other grew. Fix:

- **`aspectFitMeasure(naturalW, naturalH, constraints)`** (engine/
  element.ts): when the layout constrains one axis, return the
  proportional other axis; with both, contain preserving ratio; with
  none, natural size (Figma "hug = pixel size"). Used by the image→
  element coercion, Image Source's element, and the new spline element.
  This is what makes them "maintain ratio and scale with changing
  dimensions." Text wraps instead, so it doesn't use this. Frame keeps
  its authored fixed size (it's the explicit-box escape hatch).
- **layout.ts**: pass 1 now hands a hug-width child its fixed height as
  `maxHeight`, so "fixed height + hug width" ratio-locks (pass 2 already
  fed resolved width to hug heights). Net: hug axes track the other axis
  and keep ratio; fill+cover no longer explodes when wide (the cover
  crop only happens at a genuinely fixed mismatched container size, which
  is the user's explicit choice).
- **Spline primitives → `element` aux** (Circle, Rectangle via
  spline-raster-aux `buildSplineElement`): natural size = the shape's
  bbox in canvas px (aspect correction makes bbox aspect == visual
  aspect, so a circle is square, a 2:1 rect is 2:1); measure is aspect-
  aware; render maps the bbox into the slot per fit (contain/cover/
  stretch), scaling the stroke and insetting it so it isn't clipped.
  `buildPath2DWith` (engine/spline-raster.ts) generalizes the canvas
  path builder with a caller-supplied point map. The `element` socket is
  always exposed (so you can wire it even before enabling stroke/fill;
  un-styled falls back to a flat fill so it's visible). No more
  rasterize-then-coerce.
- (3) **onConnect / onAddNode redirect**: dropping a node's primary
  IMAGE wire onto an Auto Layout slot auto-redirects to that source's
  `element` aux when it has one (Image Source, Frame, Circle, Rectangle,
  Text). The element output carries raw intrinsic content and ignores the
  source's canvas fit/transform; the image output bakes them into a full-
  canvas texture (that's the leak). Generic images (Blur, Merge) have no
  element aux and fall through to the image→element coercion unchanged.

### Follow-up 3: alignment governs content-within-slot

A fill child with `fit: contain` (e.g. a square rect in a wider-than-tall
slot) sat centered even under `center-left`, because the fit logic
hard-centered the content. Now the container's `align` ALSO governs where
fitted content sits within its slot when fit leaves slack (contain
letterbox / cover crop): `ElementValue.render` gained `alignX`/`alignY`
opts; Auto Layout passes `splitAlign(align)` to every child render. The
image fit shader pivots its sampling around an align-derived output
center (`axisAlignCenter` in element.ts) instead of a fixed 0.5; the
spline element offsets its draw rect the same way. `stretch` has no slack
so it's a no-op; `hug` slots have no slack either. Text keeps its own
`alignment` param (its render ignores these opts), and a nested layout
positions its own children by its own align.

## Decisions (locked)

1. **New `element` socket type** — a deferred, intrinsically-sized renderable,
   following the SDF-socket precedent (plain data + runtime-only handles,
   terminal node does the GL work). Plain `image` wires still work everywhere
   via coercion, so `Image Source → Blur → Auto Layout` is legal with zero
   extra nodes (see Coercion + Trim below).
2. **Nesting is first-class.** Auto Layout consumes elements and also *emits*
   one, so hug propagates up and fill propagates down through nested layouts.
3. **Per-child sizing config lives on the Auto Layout node** as per-slot rows
   (the `merge_layers` pattern: array param + dynamic sockets keyed by stable
   ids), not on upstream nodes.
4. **Text reflow ships in v1.** No back-propagation: the Text node exposes an
   element whose measure/render closures re-run its own rasterizer under
   width constraints supplied forward by the layout pass.
5. **Abstract layout units**, resolution-independent: `1 unit = 1/1000 of the
   canvas's smaller dimension` (≈1.08 px on a 1080p canvas, so values feel
   like pixels). All Auto Layout / Frame dimensions (padding, gap, fixed
   sizes, corner radius) are in units.
6. **Container features v1**: direction (H/V), 9-position alignment grid,
   symmetric padding X/Y, gap + "space between" mode, per-axis fixed-or-hug
   container sizing, background fill + corner radius, full canvas-placement
   transform (gizmo-compatible).
7. **Raw images** default to a full-canvas-sized element, with a per-slot
   **"trim transparent"** toggle that measures the alpha bounding box.
8. **Deferred**: child-centers `points` aux output, per-slot align-self,
   per-side padding, clip-content, grow weights, image_group bulk input,
   spline children, staggered-reveal hooks.

---

## 1. The `element` data type

`src/engine/types.ts`:

```ts
// Constraints flow FORWARD into measure — this is how text reflow works
// without back-propagating params. All px values are canvas pixels.
export interface LayoutConstraints {
  maxWidth?: number;   // undefined = unconstrained
  maxHeight?: number;
}
export interface ElementSize { width: number; height: number }

export type SizeMode = "fixed" | "hug" | "fill";

// Intrinsically-sized renderable. Like SdfValue, this is runtime-only —
// closures and texture refs are never serialized; params on the producing
// node are the persistent state, and the fingerprint chain (producer params
// → producer fp → consumer input fp) already handles invalidation.
export type ElementValue = {
  kind: "element";
  // Natural size under constraints. Pure CPU (canvas2d measureText at
  // most). May be called several times per layout pass; must be cheap
  // and re-entrant.
  measure(constraints: LayoutConstraints): ElementSize;
  // Render content into an exactly width×height texture. CALLER OWNS the
  // returned texture and must release it after compositing. Must be safe
  // to call repeatedly (each call allocates fresh). `fit` is honored by
  // raster-content elements (wrapped images); intrinsic renderers (text,
  // nested layouts) ignore it.
  render(
    ctx: RenderContext,
    width: number,
    height: number,
    opts?: { fit?: "contain" | "cover" | "stretch" }
  ): ImageValue;
  // Default slot sizing when first wired (text → hug/hug, wrapped
  // full-canvas image → fixed-ish… see slot defaults). Advisory only.
  preferredSizing?: { width: SizeMode; height: SizeMode };
  // Present when this element wraps a plain texture (coercion or Frame
  // around an image). Lets Auto Layout's per-slot "trim" re-derive the
  // content rect from alpha. NOT owned by the element — never release.
  sourceImage?: ImageValue;
};
```

Add `"element"` to `SocketType` and `ElementValue` to the `SocketValue` union.

**Lifetime rules** (consistent with engine norms):
- Closures are valid while the producing node's cache entry is alive — same
  contract as `SdfValue.segmentTexture`. Consumers only invoke them inside
  their own `compute()`, during the same eval or while fingerprints hold.
- `render()` results are owned by the caller; Auto Layout releases each
  child texture right after blitting it into the container raster.
- `emptyClipOutput` (engine/clips.ts) gets an `element` case: zero-size
  measure, 1×1 transparent render.

## 2. Layout units

`src/engine/layout.ts`:

```ts
// 1 unit = 1/1000 of min(canvasW, canvasH). Same px count on both axes
// (unlike normalized [0,1] coords), so padding/gap are isotropic on
// non-square canvases, and everything scales when the project resolution
// changes. ≈1 px at 1080p so values read like pixels.
export function unitToPx(units: number, ctx: { width: number; height: number }): number {
  return (units * Math.min(ctx.width, ctx.height)) / 1000;
}
```

Known wrinkle, accepted for v1: Text font size stays in canvas px, so a
resolution change scales layout geometry but not glyph size. Follow-up
candidate: a units mode for font size (noted in Deferred).

## 3. Coercion (the "blur after image" guarantee)

`src/engine/coerce.ts` gains two rules; `canCoerce` in NodeEditor.tsx and
`isValidConnection` get matching entries so wires connect in the UI.

- **image → element**: wrap the texture. `measure` returns the image's own
  px dimensions (= canvas-sized for anything mid-pipeline); `render`
  samples the full texture into the rect honoring `fit` (reuse the
  image-source FIT_FS math); `sourceImage` set. This is what makes ANY
  existing image chain wirable into Auto Layout directly.
- **element → image**: render at natural size (clamped to canvas), composite
  centered onto a transparent canvas-sized image. This makes element wires
  acceptable to every existing image consumer and powers previews.

**Trim (per-slot toggle).** When a slot has `trim: true` and its element has
`sourceImage`, Auto Layout measures the alpha bbox: blit to a ≤256px proxy,
one readPixels, scan alpha > 1/255, scale rect up. Cached in a
`WeakMap<ImageValue, Rect>` — sound invalidation for free, because a cache-hit
upstream returns the *same* `ImageValue` object, and any recompute produces a
new one. (Bbox precision is ~canvas/256; fine for layout.) The trimmed
element's natural size becomes the bbox, and render samples the sub-rect.
Per-frame cost only when upstream actually changes per frame.

## 4. Layout algorithm (Figma semantics)

Pure CPU module in `src/engine/layout.ts` — no GL, fully unit-testable-shaped
(pure functions of inputs → rects) even though the repo has no test runner.

Inputs: direction, alignment (9-pos), spacing mode (`packed` |
`space-between`), gap, paddingX/Y, container per-axis mode (fixed|hug) +
fixed sizes, and per-child `{ widthMode, heightMode, width, height, fit,
trim }` + the child's `measure`.

1. **Resolve widths first, then heights** (sufficient for horizontal text
   reflow): a child's resolved width is — fixed → units→px; hug →
   `measure({})`; fill → share of leftover (main axis) or container inner
   width (cross axis).
2. **Fill distribution** (main axis): `leftover = innerMain − Σ(fixed+hug)
   − gaps`, split equally among fill children, clamped ≥ 0.
3. **Fill-in-hug rule**: when the container hugs an axis, fill children on
   that axis are treated as hug for measurement (then the container size
   equals the hug total, so they end up identical — matches Figma's
   degenerate-case behavior).
4. **Heights**: fixed → units; fill → inner cross (or leftover if vertical
   main); hug → `measure({ maxWidth: resolvedWidth })` — this call is the
   text-wrap moment.
5. **Space-between**: ignores gap, distributes leftover between items;
   n ≤ 1 falls back to packed + alignment.
6. **Alignment grid** sets main-axis packing (start/center/end) and
   cross-axis alignment.
7. **Pixel-snap** every rect (round x, y, w, h) for crisp text.
8. **Stacking/order** = socket order; later slots draw over earlier ones
   (matches Merge).

Composite pass: allocate an exact container-px texture
(`ctx.allocImage({width, height})` — sub-canvas allocs are already
supported), clear transparent, draw rounded-rect background (radius in
units) when enabled, then for each child `render(w, h, {fit})` → positioned
source-over blit (Merge's source-over math) → release child texture.

Canvas placement: the container raster is centered on the canvas, then the
standard transform block (translateX/Y, scaleX/Y, rotate, pivotX/Y) places
it — same pattern as the Text node's built-in transform, reusing a
positioned-quad shader. `supportsTransformGizmo: true`.

## 5. Node specs

### Auto Layout — `src/nodes/effect/autolayout.ts`
- `type: "autolayout"`, name "Auto Layout", category `image` / `modifier`,
  backend webgl2.
- **Inputs**: dynamic `item:<id>` sockets typed `element`, generated by
  `resolveInputs` from the `items` param (merge_layers pattern; stable ids
  via `ali-xxxxxx`). Universal mask input appends as usual.
- **Params**:
  - `items` — new param type `"autolayout_items"`:
    `{ id, widthMode, heightMode, width, height, fit, trim }[]`
    (defaults: hug/hug — or the element's `preferredSizing` when first
    wired — `fit: "cover"`, `trim: false`, width/height 200 units).
  - `direction` enum `horizontal | vertical`.
  - `align` enum, 9 options (`top-left` … `bottom-right`).
  - `spacing` enum `packed | space-between`.
  - `gap`, `paddingX`, `paddingY` — scalars, units, keyframable for free.
  - `widthMode` / `heightMode` enums `fixed | hug`; `width` / `height`
    scalars (units), `visibleIf` fixed.
  - `bgEnabled` boolean, `bgColor` color, `cornerRadius` scalar (units).
  - `OPACITY_PARAM` + the 7 transform params (gizmo contract).
- **Outputs**: primary `image` (canvas composite — previews naturally);
  aux `element` (the container as an element: measure = run solver,
  render(w,h) = re-solve at that size + composite — this is nesting).
- Compute is fully constraint-driven from day 1, so the aux element is the
  same code path as the primary, just with externally-supplied size.

### Frame — `src/nodes/source/frame.ts` (category `image` / `utility`)
The explicit sizing adapter — wrap any image chain in a known rect:
- Input: `image` (required). Params: `width`, `height` (units), `fit`
  (`cover | contain | stretch`, default cover).
- Primary output: `element`. Aux output `image` (render at natural size,
  centered, transparent surround) so the preview canvas and the evaluator's
  aux-image fallback work.

### Text — changes to `src/nodes/source/text.ts`
- Extract the raster core (measure + line layout + draw, both fast and
  per-char-modulated paths) into `src/engine/text-raster.ts`, parameterized
  by optional `maxWidth` with word-wrap (split on whitespace, measure words
  with current styling; modulated path wraps on median-axis measures —
  good enough). Existing node behavior unchanged: unconstrained = no wrap,
  only `\n`.
- Add aux output `element`: measure runs wrap+measure to tight line bounds
  (line widths, lineCount × lineHeight); render rasterizes at exactly the
  rect into an owned texture. `preferredSizing: hug/hug`. The node's
  built-in transform params do NOT apply to the element (the layout owns
  placement) — document in the socket description.

### Image Source — small addition
Aux `element` output: natural size = bitmap px, render = FIT_FS sampling
with fit opt. Gets correct aspect + crisp resampling without a Frame node.

## 6. UI integration

- `socketColor.ts`: `element: "#818cf8"` (indigo — distinct from image blue
  and the vec lavender).
- `NodeEditor.tsx`: add `image ↔ element` to `isValidConnection` (line
  ~984) and `canCoerce` (line ~692).
- `ParamPanel.tsx`: renderer for `autolayout_items` — per-row: W/H mode
  dropdowns + number fields (shown when fixed), fit dropdown, trim toggle,
  remove button. Mirror the merge_layers row styling.
- `EffectsApp.tsx`: replicate the merge affordances for autolayout —
  "wire into the node body appends a fresh slot" (the `newLayerId` block at
  ~2193) and the + button path (~2025). Factor a small shared helper if it
  stays readable; duplicating ~30 lines is also fine.
- `graph-helpers.ts` / docs page: `element` shows up automatically from the
  defs; verify socket tooltips read sensibly.

## 7. Caching & memory checklist

- Auto Layout is cacheable (`stable` default true): fingerprint = params +
  input fps, which transitively covers every child param change.
- Child `render()` textures released immediately after compositing.
- Trim bbox: WeakMap keyed on source ImageValue identity (see §3).
- Aux element closures capture this eval's inputs; safe because consumers
  run in the same eval and cache entries pin upstream outputs (same
  contract SDF textures rely on today).
- Offline export: everything here is synchronous — no settle work needed.

## 8. Milestones

**M1 — Engine foundations.** types.ts (`element`, constraints, SizeMode,
union entries, `autolayout_items` ParamType), layout.ts (units + solver,
pure), coerce.ts both rules, clips.ts empty case, socketColor, NodeEditor
validation. Nothing user-visible yet.

**M2 — Frame + Auto Layout nodes.** Frame node; Auto Layout with
fixed/hug/fill for image-backed elements, trim, container modes, bg,
transform+gizmo, registration in nodes/index.ts; ParamPanel rows;
EffectsApp slot-append affordances. Acceptance: wire Image Source → Blur →
Auto Layout (coerced, trim on), plus a Frame'd image; H/V, padding, gap,
alignment, space-between, hug container all behave; gap/padding keyframe.

**M3 — Text reflow + Image Source element.** Extract text-raster.ts with
maxWidth wrap; Text element aux; Image Source element aux. Acceptance:
vertical layout, text slot width=fill → wraps to container; hug container
hugs the wrapped block; editing text params reflows live.

**M4 — Nesting + polish.** Verify autolayout-in-autolayout (hug-up,
fill-down through two levels), pixel-snap audit at odd resolutions /
non-square canvases, docs descriptions, tick devlist #142, changelog entry.

## 9. Deferred / open

- Child-centers `points` aux (composes with copy-to-points; cheap later).
- Per-slot align-self override; per-side padding; wrap (multi-row flow).
- Clip-content toggle (children currently overflow visibly like Figma's
  default); grow weights for fill.
- image_group bulk input for data-driven lists (all slots share defaults).
- Spline/points children (rasterize first for now).
- Font size in layout units (closes the resolution-independence gap).
- Opacity param currently fades the primary composite only, not the aux
  element when nested — revisit if it bites.
