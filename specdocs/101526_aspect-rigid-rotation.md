# Aspect-rigid rotation for Transform, Image / Video Source and Text

Status: **agreed and implemented** (2026-10-15, uncommitted on main). The
owner approved the plan as written: B for Transform / Image / Video, A for
Text, the v13 `legacySkew` flag, and Skia mirrors included. §10 lists what
was built. Follow-up to
[101526_layer-transforms-parenting.md](101526_layer-transforms-parenting.md)
M0 §2.

## 1. Problem

Transform's image mode (`TRANSFORM_FS`, `TRANSFORM_MATRIX_FS`), Image /
Video Source's TRS (`FIT_FS` + `bindTrsUniforms`) and Text
(`TEXT_TRANSFORM_FS`, text.ts ~line 690) rotate in raw canvas01 uv. canvas01
is anisotropic when W ≠ H: one x unit is W px and one y unit is H px. So a
rotation shears. On 1920×1080 a 45° rotate leaves the image's pixel axes at
**121.28°** (rigid = 90°), with an axis-length ratio of **0.563**
(`check-layer-transform-math.mts` prints this).

The on-canvas **TransformGizmo is already wrong for images**. It works in
authored space (y width-relative, `aspectUncorrectY` on the pointer), like
shapes, and its default bounds are `[0,1]²` authored. On 16:9 that means:

- the box spans canvas y −0.39 … 1.39, taller than the frame;
- a translate drag moves the image only H/W (56%) as far as the pointer,
  because the image reads `translateY` as 0.1·H px while the gizmo writes it
  as 0.1·W px;
- the rotate handle draws a rigid box while the image shears.

Skia mirrors copy the shear on purpose: Transform (Skia) `tbx_transform`, and
Image (Skia), whose native Group split is documented in skia/image.ts.

## 2. Math

Aspect `a = W / H`, and `C(x, y) = (x, aspectCorrectY(y)) = (x, 0.5 + (y − 0.5)·a)`.
`composeOpsToCanvasAffine(ops, a) = C · M · C⁻¹`. Expanding it for one TRS op
(`M = T(t)·T(p)·R(θ)·S·T(−p)`) and using `A = diag(1, a)`:

```
C·M·C⁻¹ = T(t_c) · T(p_c) · (A R A⁻¹) · S · T(−p_c)
  t_c = (tx, a·ty)          translate, canvas01
  p_c = (px, aspectCorrectY(py))
  A R A⁻¹ = [[cos, −sin/a], [a·sin, cos]]   (rigid in pixels)
  A S A⁻¹ = S                                (scale is unaffected)
```

So the conjugation changes three things: **rotation** (it becomes rigid),
**translateY** (×a), and **pivotY** (about 0.5). Scale, translateX, pivotX,
and the pivot (0.5, 0.5) all stay the same.

In the shaders the rotation fix is two lines around the existing rotate:
`p.y /= u_aspect; p = R·p; p.y *= u_aspect;`. When `u_aspect = 1.0` the
result is bit-identical to today (x/1·1 is exact in IEEE float), so legacy
nodes keep the same shader with `u_aspect = 1`. The translate and pivot
conversions happen in JS when binding uniforms.

## 3. Decision: translateY / pivotY semantics

**Recommended: switch fully (option B) for Transform and Image / Video
Source. Text only gets the rotation fix (option A).**

| | A: fix rotation only | **B: full switch** (recommended for Transform, Image, Video) |
|---|---|---|
| translateY | height-relative (0.1·H px), unchanged | width-relative (0.1·W px), like shapes |
| pivotY | canvas01 (0 = top edge) | authored (0.5 = center; on 16:9 the top edge is 0.219) |
| Render equals `composeOpsToCanvasAffine` | no | **yes**: the same function as the M1 layer compositor |
| Same Transform params move a shape and an image the same way | no | **yes** |
| Transform `aux:transform` (authored ops) means the same downstream | no (needs aspect-aware conversion) | **yes**, as is |
| Wired Gizmo → image lands where Gizmo → shape lands | only if the wired path is special-cased | **yes** |
| TransformGizmo matches the render | needs its own conversion layer | **yes**, once the image box = the frame in authored space |

Why **Text stays A**: its box (`boxWidth/boxHeight`), translate and pivot
are all uv01. Its bounds gizmo (PrimitiveGizmo `text` adapter) writes uv01,
and per-glyph copies already convert uv01 → canvas01
(092226_per-glyph-text.md §4). Text has no TransformValue in or out. Only
its rotation is wrong, so changing translate there would only add churn.
Text's rotate sign (`cos(−u_angle)`, opposite to Transform) stays as it is.

The wired-transform path (`TRANSFORM_MATRIX_FS`) switches to
`composeOpsToCanvasAffine(wired.ops, a)` in every case. A TransformValue is
authored space by definition, because the Gizmo node and shapes share it.

## 4. Compat

This changes the render of every rotated image or text on a non-square comp.
With B it also moves images whose `translateY ≠ 0` or `pivotY ≠ 0.5`.
Square comps render identically.

- **Schema v13.** Add a hidden boolean param `legacySkew` (default `false`)
  to `transform`, `image-source`, `video-source`, `text`, `skia-transform`
  and `skia-image` (`LEGACY_SKEW_TYPES` in project.ts). The v13 migration in `deserializeGraph` sets
  `legacySkew: true` on every node of those types in a ≤v12 save, so old
  projects render exactly as before.
- `legacySkew: true` keeps today's path (`u_aspect = 1`, raw uniforms,
  `composeOpsToAffine` for wired). The param panel then shows one checkbox,
  **"Legacy skew"**, visible only while it is on. Unticking it switches the
  node to rigid. It does **not** rewrite translate or pivot, so on a
  non-square comp, a node with a non-default translateY or pivotY jumps.
  Auto-rewriting keyframed values is a follow-up if the owner wants it.
- New nodes, recipes, MCP-built graphs and presets without the param get
  rigid behavior.
- The live viewer and export template load through the same
  `deserializeGraph`. Implementation verifies this, including published live
  links of old projects.
- Figma import writes Image Source TRS. `placeImage` changes
  `translateY = (cy − H/2) / W` (it was `/ H`). Text import is unchanged.
  `check-figma-import` follows.

## 5. TransformGizmo

- Image-mode nodes (Transform with an image input, Image / Video Source,
  Image (Skia)) that are **not** legacy get default bounds equal to the
  frame in authored space: `y ∈ [aspectUncorrectY(0), aspectUncorrectY(1)]`.
  The existing authored fwd / drag math then matches the render exactly.
  The new prop is `frameBounds`, and the gizmo derives the aspect from its
  canvas rect.
- Snap targets for top and bottom (today authored 0 / 1, which is wrong
  on non-square comps for shapes too) become `aspectUncorrectY(0 / 1)`, the
  real frame edges, the same as the ruler guides already do.
- Legacy nodes keep today's gizmo unchanged. Their render can't be
  expressed in the gizmo's rigid model anyway.
- The Text bounds gizmo is unchanged. It is uv01 and never drew rotation.

## 6. Skia mirrors

They follow the same flag. When not legacy:

- Transform (Skia) `tbx_transform` and Image (Skia) `tbx_image_fit` each
  take an `int legacySkew`, a mirrored param. They derive `a` from `res`,
  convert translateY / pivotY in the shader, and do the same `/=a … *=a`
  around the rotation, so the binds stay raw params.
- Image (Skia) drawing: three Groups, so every bind stays one param × a
  constant: `translate (0, o)` › `origin (pivotX·W, pivotY·W), translate
  t·W, rotate θ, scale (sx, sy)` › `translate (0, −o)`, with
  `o = (H − W) / 2`. legacySkew keeps the old two-Group shear split.
- ImageShader mapping (`imageLocalMatrix` / the bundle's `imageMatrix`):
  rigid by default, with `legacySkew?: true` on the mapping / ExportImage for
  the old formula. The legacy arithmetic is unchanged, op for op.

## 7. Gate

Built as specced (§10). The planned design: extend
`scripts/check-layer-transform-math.mts` with a CPU mirror of the new shader
inverse (`p.y /= a; R; p.y *= a`) and these checks:

1. Rigid: pixel axes at 90° with equal lengths on 16:9, for Transform /
   Image / Video (B) and Text (A).
2. B nodes land a canvas point exactly where `composeOpsToCanvasAffine`
   does, over 200 random ops.
3. Legacy (`u_aspect = 1`, raw uniforms) reproduces the old formula exactly.
4. Text A keeps uv01 translate: the pivot lands at `pivot + translate` in
   uv01.
5. The gizmo's frame bounds map back to canvas `[0,1]²` under
   `aspectCorrectY`.
6. The migration sets `legacySkew` on ≤v12 nodes and leaves v13 nodes alone
   (in `check-persistence`, or here).

The "known skew" / "measurement" line becomes a gated PASS for the rigid
path. `check:shaders` covers the edited GLSL and SkSL.

## 8. Docs

- Node facts: update the Transform / Image / Video / Text / Skia
  gotchas, via the `node-facts` skill.
- 092226_per-glyph-text.md §4 and the gotcha list: rotation no longer
  skews, except on legacy nodes.
- 092326_figma-import.md (the image-fill row, M2, M3): Image Source and
  Text rotate rigidly. Baking rotation into the bitmap is no longer
  required, but changing the importer is a separate follow-up.
- 101526_layer-transforms-parenting.md §2 "Not changed" points here.

## 9. Out of scope

- Auto Layout's `PLACE_TRANSFORM_FS`.
- SVG Source (it rotates in raw [0,1]² before the aspect correction; its own
  gotcha).
- Rewriting translate / pivot when "Legacy skew" is unticked.
- Figma importer using live rotation.

## 10. What was built (2026-10-15)

- **Core** (transform-value.ts): `LEGACY_SKEW_PARAM`, `isLegacySkew`, and
  `trsAspect(params, W, H)` (1 for legacy). `imageTrsUniforms(params,
  aspect, authoredY)` converts translate / pivot Y for B and leaves them
  raw at aspect 1 or for Text. `bindTrsUniforms` now takes the aspect.
  `imageTrsInverseUv` is the shaders' inverse, transcribed for the gate.
- **GL**: `u_aspect` with `p.y /= u_aspect; R; p.y *= u_aspect` in
  TRANSFORM_FS, Image Source FIT_FS, VIDEO_FIT_FS and both Text transform
  shaders. On Transform's wired path, `composeOpsToCanvasAffine` replaces
  `composeOpsToAffine` unless the node is legacy. Text's post-pass signature
  includes `legacySkew`.
- **Compat**: CURRENT_SCHEMA 13. The migration in `deserializeGraph` covers
  projects, `.toolbox` files, fragments and presets, the live viewer and the
  export template. The "Legacy skew" checkbox only shows while the flag is
  on (on Transform, only in image mode).
- **Gizmo**: the `frameBounds` prop on TransformGizmo is set by
  TransformGizmoAtTick for non-legacy `image-source` / `video-source` /
  `skia-image`, and for Transform with no geometry bounds. Top / bottom
  snaps go to the real frame edges for every TransformGizmo.
- **Figma import**: `placeImage` uses `translateY = (cy − H/2) / W`.
- **Gates**:
  - check-layer-transform-math: inverse ≡ canvas affine, rigid
    Transform / Text axes, Text uv01 pivot, legacy bit-identical,
    `trsAspect`, gizmo frame corners.
  - New check-aspect-rigid (in `npm run check`): param on every type,
    Skia mirrors share the def, the v12 → v13 migration plus re-save, and
    Transform's uniforms on a stub GL.
  - check:shaders: the four new shaders compile, and stage 6's GPU
    diamond is rigid at `u_aspect = W/H` and sheared at 1.
  - check-skia-warp: the transcription follows the uniforms, plus a
    legacy case.
  - check-skia-assets: the rigid and legacy nests and the Group algebra
    for both. `skia-harness/src/bundle-image` was regenerated (images.ts).
- **Not verified**: pixels in the live editor app, which needs Google
  sign-in. Square comps are unchanged by construction.
