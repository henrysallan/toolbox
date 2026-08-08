# Image fill + gradient overlays & multi-point — spec (2026-06-15)

Design doc for two related primitive/source upgrades:

1. **Image fill** — let a shape's fill be driven by a wired image input
   instead of only a flat color, with a fill-fit mode (window / contain /
   cover). Applies to Spline Draw, Circle, Rectangle, SVG Source, Text.
2. **Gradient node** — on-canvas handles for linear (two endpoints + line)
   and radial (center + radius), and a new **multi point** gradient mode
   (N color points placed in 2D, smooth IDW blend, keyframable positions).

Read [061226_devguide.md](../061226_devguide.md) first. Coordinate, alpha,
texture-discipline and back-compat invariants there are binding.

---

## Part A — Image fill for shape primitives

### A.0 Current state (what we're changing)

Fill is a flat color rasterized on a CPU Canvas-2D, then blitted with a
Y-flip shader. Three near-identical implementations exist:

- [spline-draw.ts](../../src/nodes/source/spline-draw.ts) — inline raster.
- [svg-source.ts](../../src/nodes/source/svg-source.ts) — inline raster.
- [spline-raster-aux.ts](../../src/nodes/source/spline-raster-aux.ts) —
  shared by [circle.ts](../../src/nodes/source/circle.ts) +
  [rectangle.ts](../../src/nodes/source/rectangle.ts).
- [text.ts](../../src/nodes/source/text.ts) — its own glyph raster with an
  existing `fillMode` (solid / linear / radial via `fillStops`).

All four sources currently declare `inputs: []`.

### A.1 New params / sockets (all four spline-based nodes)

Add to the bundled stroke/fill param set (and mirror in spline-draw &
svg-source which don't use the shared set yet — see A.4):

- `fill` **input socket**, `type: "image"`, `required: false`. Because
  `mask→image` and `element→image` coercions already exist, this socket
  transparently accepts masks and elements too — no extra coercion entries
  needed.
- `fill_fit` **enum param**: `window` (default) | `contain` | `cover`.
  `visibleIf: fill_enabled`. Only meaningful when the `fill` socket is
  wired; harmless otherwise.

Keep `fill_color` — it's the fallback when nothing is wired into `fill`.
`fill_enabled` still gates fill entirely (color or image).

Nodes need `resolveInputs` to expose the `fill` socket (svg/spline-draw add
it unconditionally; circle/rect get it via a shared `resolveInputs` in the
aux module). Exposing it unconditionally is fine — an unused optional input
is free.

### A.2 GPU composite design (replaces flat-fill-only blit)

The input image is a GL texture; the current fill is a CPU canvas. So fill
moves GPU-side as a **coverage-mask + composite**:

1. CPU canvas renders **two separable coverage layers** instead of one
   baked image:
   - fill region as solid **white on transparent** → uploaded to
     `fillMaskTex` (alpha = fill coverage; anti-aliased edges preserved).
   - stroke as its **stroke color on transparent** → `strokeTex` (straight
     alpha, drawn exactly as today).
   Both can share one canvas if drawn to separate textures in two passes,
   or two small canvases. Two passes on one canvas is simplest (clear →
   fill-white → upload → clear → stroke → upload).
2. Composite fragment shader (one fullscreen draw into the output image):
   ```glsl
   // uv = v_uv; masks are row-0-top so sample with (uv.x, 1.0 - uv.y).
   vec2 m = vec2(v_uv.x, 1.0 - v_uv.y);
   float cov = texture(u_fillMask, m).a;
   vec4 fillCol = (u_hasFillImage == 1)
       ? texture(u_fillImage, fillUv)     // straight-alpha image sample
       : vec4(u_fillColor, 1.0);
   vec4 fill = vec4(fillCol.rgb, fillCol.a * cov);   // modulate by coverage
   vec4 strokeCol = texture(u_stroke, m);            // already straight-alpha
   outColor = over(strokeCol, fill);                 // stroke OVER fill
   ```
   `over()` = manual Porter-Duff source-over, straight alpha (match
   merge.ts BLEND_FS). When `u_hasFillImage == 0` this reduces to today's
   flat fill, so the solid path is unchanged in appearance.

`fillUv` selects the fill-fit mode:
- **window**: `fillUv = v_uv` — the shape is a window onto the full-canvas
  image (consistent with "everything is a full-canvas texture").
- **contain / cover**: remap `v_uv` into the **shape's bbox** so the image
  is fit inside the shape's bounds. Needs the spline bbox (we already
  compute one in `splineBbox`, aux module) passed as `u_bboxMin/u_bboxSize`
  uniforms; contain vs cover differ by min/max of the per-axis scale,
  exactly like the element fit math already in `buildSplineElement`.

Texture discipline: the composite owns no input textures (never release
`u_fillImage`). The mask/stroke textures are persistent per-node state
(like today's `rasterTex`), torn down in `dispose`.

### A.3 Cache / fingerprint

- The `fill` input participates in the node fingerprint automatically
  (input fingerprints are part of the eval hash). Good — when the upstream
  image recomputes, the composite re-runs.
- The CPU mask re-raster signature (`lastSig`) gains `fill_fit` and a flag
  for "image fill active" but does **not** depend on image pixels (those
  live in the composite shader, not the CPU canvas). So dragging only the
  upstream image re-composites without re-rasterizing the path. 

### A.4 Shared helper (de-dup)

The spline-draw / svg-source / spline-raster-aux raster code is ~90%
identical and about to grow the composite logic. Extract a single helper
(engine-side or `nodes/source/`-side to respect engine self-containment):

```
fillRaster(ctx, nodeId, subpaths, params, fillImage?) -> ImageValue | null
```

that owns: mask+stroke raster, the composite shader, fit math, state &
dispose. Circle/Rect already call into the aux module; point spline-draw
and svg-source at the same helper. This is the lowest-risk way to get all
four behaving identically.

The Auto Layout `element` output (`buildSplineElement`) is a **deferred
CPU render with no access to the input GL texture**, so it keeps solid
fill. Image fill applies to the `image` aux output only. (Documented
limitation; revisit only if a use case appears.)

### A.5 Text (own milestone — A is heaviest here)

Text owns a richer fill model (`fillMode`: solid/linear/radial +
`fillStops`). Add:
- `fillMode` gains an **`image`** option.
- a `fill` image input socket (via `resolveInputs`).
- When `fillMode === "image"` and `fill` is wired: render glyph coverage to
  a mask, then composite the input image through it (same shader family as
  A.2). `fill_fit` applies, bbox = the text's tight glyph bounds.
- Text is `stable:false`; the composite is cheap and runs in the existing
  per-frame path. Gate the mask build on `consumedOutputs` as Text already
  does for its other outputs.

---

## Part B — Gradient node

[gradient.ts](../../src/nodes/source/gradient.ts) is one FS with 4 modes
(linear/radial/polar/wave). **Important coordinate note:** the gradient
samples in `v_uv` (**Y-UP**, v=0 at bottom) and `center_x/y` feed `u_center`
in that same Y-up space. This is *opposite* the Y-DOWN CPU convention the
box gizmo (PrimitiveGizmo) assumes. **All gradient overlay math stores
positions Y-up and flips once at the screen boundary.**

### B.1 Linear: two endpoints + connecting line

Reparametrize linear from `angle`-only to **two endpoints**:

- New params `start_x, start_y, end_x, end_y` (scalars, keyframable, Y-up
  UV). Defaults reproduce today's look: `start=(0,0.5)`, `end=(1,0.5)`.
- Shader linear branch becomes the standard projection:
  ```glsl
  vec2 se = u_end - u_start;
  t = dot(uv - u_start, se) / max(dot(se, se), 1e-6);
  ```
  When `start=(0,0.5)`,`end=(1,0.5)` this is a horizontal 0→1 ramp.
- **Back-compat migration (invariant #2):** old saves store `angle` and no
  endpoints. Add a load migration (project.ts deserialize, gradient nodes):
  if `start_x` absent and `angle` present, seed
  `start = 0.5 - 0.5*dir`, `end = 0.5 + 0.5*dir` where
  `dir = (cos θ, sin θ)`. This exactly reproduces the legacy
  `t = dot(uv-0.5, dir)+0.5`. Keep `angle` registered as a hidden/legacy
  param (don't repurpose the name).
- `angle_mod` image input still modulates direction (rotate `se` by the
  sampled angle), so the modulator socket survives.

Overlay: two draggable endpoint handles joined by a line; dragging either
writes its `*_x/_y`. Reads keyframe-effective values.

### B.2 Radial: center + radius handle

Params already exist (`center_x/y`, `radius`). **No shader change.** Overlay
only: a circle outline at `center` with radius `radius`, a center handle
(drag → `center_x/y`) and one handle on the circumference (drag → `radius`,
distance from center). Y-up → flip for screen.

### B.3 New mode: "multi point"

A 2D color field: N points each with a color + X/Y, smoothly blended by
**inverse-distance weighting (Shepard / IDW)** with an adjustable falloff.

**Param type.** New `ParamType` `"gradient_points"` holding
`GradientPoint[]` = `{ id: string; x: number; y: number; color: string }`
(positions Y-up UV). Default ~3 points. This follows the
`merge_layers` / `autolayout_items` / `color_ramp` array-param precedent.

Touch points for a new ParamType (devguide §"new node" step 5):
- `types.ts`: add to `ParamType` union + `GradientPoint` interface.
- `ParamPanel.tsx`: a renderer — list of rows (color swatch + X + Y +
  remove), an "add point" button. Model on the `color_ramp` / `merge_layers`
  editors.
- `keyframes.ts` `isKeyframable`: the array param itself is **not** directly
  keyframable; per-point sub-values are (see below).
- `export-manifest.ts`: decide control support (likely not user-exposable
  initially; skip).
- serialization: plain JSON, round-trips as-is.

**Shader.** New mode branch with uniform arrays (cap `MAX_POINTS = 16`):
```glsl
uniform int   u_ptCount;
uniform vec2  u_ptPos[MAX_POINTS];
uniform vec3  u_ptCol[MAX_POINTS];
uniform float u_idwPower;     // falloff exponent, e.g. 2.0
// per pixel:
vec3 acc = vec3(0.0); float wsum = 0.0;
for (i < u_ptCount) {
  float d = max(distance(uv, u_ptPos[i]), 1e-4);
  float w = 1.0 / pow(d, u_idwPower);
  acc += w * u_ptCol[i]; wsum += w;
}
outColor = vec4(acc / max(wsum, 1e-6), u_alpha);
```
Add `idw_power` (a.k.a. "Falloff") scalar param, `visibleIf: mode ==
"multipoint"`. Cap enforced in the panel ("add" disabled at 16). The
existing `softness` post-curve can still apply or be hidden for this mode
(TBD during impl — likely hide).

**Keyframable point positions.** Use the **virtual-keyframe** pattern
(precedent: merge-layer `layer_opacity:<id>`): per-point virtual scalar
tracks `gpoint_x:<id>` and `gpoint_y:<id>` (and optionally `gpoint_c:<id>`
for color). The gradient node, before compute, resolves each point's
effective x/y from its virtual block at the current tick (wire > keyframe >
stored). ParamPanel renders a keyframe diamond per point row that targets
these virtual tracks. This is the trickiest piece; it gets dedicated
milestone attention.

### B.4 GradientOverlay component

New `src/components/effects/GradientOverlay.tsx`, mounted in EffectsApp when
a `gradient` node is selected (mirror the `activePrimitiveNode` /
`activeSplineNode` blocks). Sub-renders by `mode`:
- `linear` → two endpoint handles + line.
- `radial` → center + radius circle.
- `multipoint` → one draggable colored dot per point.

Reads keyframe-effective params via the same `get(name, fallback)` helper
the PrimitiveGizmo block uses. Writes via
`onParamChange(id, name, val, "gizmo:"+id)` for single-undo-per-drag.
Multi-point dot drags write the virtual `gpoint_x/y:<id>` tracks (autokey
then records keyframes there). **All handle positions flip Y** between Y-up
param space and screen.

---

## Coordinate / invariant checklist

- [ ] Gradient overlay: Y-up param ↔ Y-down screen flip (every handle).
- [ ] Straight alpha throughout the fill composite; `over()` matches
      merge.ts; `UNPACK_PREMULTIPLY_ALPHA_WEBGL` stays disabled on uploads.
- [ ] Texture discipline: composite never releases `fill` input; mask/
      stroke textures are per-node state freed in `dispose`.
- [ ] Back-compat: `angle`→endpoints migration; `angle` param kept hidden;
      no param name repurposed; new `gradient_points` type loads cleanly in
      old projects (absent → default).
- [ ] New SocketType? No — `fill` reuses `image`. New ParamType
      (`gradient_points`) ripples per devguide step 5 (types/ParamPanel/
      keyframes/export-manifest/serialize). `image` input coercion already
      covers mask/element.
- [ ] `resolveInputs` exposes `fill` (and Text's), `canCoerce`/
      `isValidConnection` unaffected (image socket already valid target).

## Milestones (each independently shippable + browser-verifiable)

- **M1 — Image fill plumbing. ✅ (2026-06-15)** Image fill folded into the
  shared `spline-raster-aux` helper (coverage+stroke layers + composite
  shader, flat path kept for the no-image case); `fill` input + `fill_fit`
  enum on Spline Draw, Circle, Rectangle, SVG Source; the latter two routed
  through the shared helper (dedup). Verify: wire Gradient/Image into a
  Circle fill; toggle window/contain/cover.
- **M2 — Text image fill. ✅ (2026-06-15)** `fillMode: image` + `fill` input;
  separate glyph-coverage + stroke layers composited (fill over stroke) via a
  no-flip transform; `fill_fit` uses the text box rect. Element output keeps
  solid fill (documented limitation).
- **M3 — Gradient linear endpoints. ✅ (2026-06-15)** Linear reparametrized to
  start/end (4 keyframable scalars); `angle` retired to wave-only + retained;
  load migration seeds endpoints from legacy `angle` (project.ts
  `migrateLoadedParams`). `GradientOverlay` mounts for a selected Gradient in
  linear/radial mode — linear endpoints+line; **radial center+radius handle
  also implemented here** (params already existed → folds M4 in).
- **M4 — Gradient radial overlay.** ✅ Folded into M3 (GradientOverlay radial
  branch).
- **M5 — Multi-point mode. ✅ (2026-06-15)** `gradient_points` ParamType +
  `GradientPoint` + IDW (Shepard) shader branch + `idw_power` ("Falloff") +
  `GradientPointsControl` panel editor (color + X/Y rows, add/remove, cap 16)
  + GradientOverlay draggable colored dots. `softness` hidden in multipoint.
- **M6 — Multi-point keyframing. ✅ (2026-06-15)** Virtual `gpoint_x/y:<id>`
  (scalar) + `gpoint_c:<id>` (RGBA) tracks resolved in the evaluator (clone-
  and-override, mirroring layer_opacity); per-point diamonds in the panel;
  autokey mirror in EffectsApp.onParamChange (color stored as RGBA tuple);
  canvas dot drags write the stored array + autokey. Overlay dots show
  keyframe-effective positions.
- **M7 — Docs + devguide.** In-app docs pages reflect new params; update
  061226_devguide.md (gradient overlay, image-fill, new ParamType).

## Resolved (2026-06-15)

- Multi-point **color** keyframing IS included (M6) via `gpoint_c:<id>`.
- `softness` is **hidden** in multipoint mode; a dedicated **Falloff**
  (`idw_power`) control drives the blend.

## Open questions / risks

- IDW point cap (16) — enough? Bump to 32 if needed (uniform array size).
- Whether `fill_fit` contain should letterbox transparent or clamp at the
  bbox edge (spec: transparent letterbox, cover never letterboxes).
- Whether `fill_fit` contain/cover should also clip to the bbox or just
  remap UV (remap-only is simpler; edges outside bbox sample clamped).
