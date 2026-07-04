# Liquid Glass node — spec (2026-06-29)

Design doc for a new **Liquid Glass** effect node that brings Apple-style
"liquid glass" refraction into the toolbox engine, adapting
[iyinchao/liquid-glass-studio](https://github.com/iyinchao/liquid-glass-studio)
(WebGL2 / GLSL, MIT). Read [061226_devguide.md](061226_devguide.md) first.

## 1. What the reference does (and what we keep)

The reference renders a draggable rounded-glass **panel** over a background.
Its `fragment-main.glsl` is a single fullscreen pass that, per pixel:

1. Evaluates a **rounded-rect / superellipse SDF** (`lib/sdf.glsl`), optionally
   `smin`-merged with a second circle that chases the mouse → the "liquid" blob.
2. Reads a separately **gaussian-blurred** copy of the background (`u_blurredBg`,
   two passes: `fragment-bg-hblur` → `fragment-bg-vblur`).
3. Inside the shape (`sdf < 0`):
   - Computes a **2D normal** from the SDF gradient (finite differences).
   - Derives an **edge/bevel factor** from Snell's law: distance-to-edge vs a
     thickness param → `thetaI/thetaT → -tan(thetaT - thetaI)`.
   - **Refraction**: samples the (blurred) backdrop offset along `normal *
     edgeFactor`.
   - **Chromatic dispersion**: R/G/B sampled at slightly different offsets
     (`N_R/N_G/N_B = 0.98/1.0/1.02`).
   - **Fresnel** edge brightening, **glare** (angular specular streak, computed
     in LCH via `lib/color.glsl`), **tint**, and a blur→sharp blend from edge to
     center (`u_blurEdge`).
   - Anti-aliases the boundary with a `smoothstep` against the raw background.

We keep the entire **optical model** (steps 5–9 of the reference's `STEP`
ladder — the earlier steps are debug visualizations). We **replace** the
shape/source plumbing with toolbox-native sockets, params, and the SDF system.

### The load-bearing constraint

Liquid glass **refracts what is behind it**. A node only sees its inputs, so the
glass node takes the **backdrop as an explicit `image` input** and outputs the
composited result. It cannot refract downstream layers (no backdrop-filter
semantics in a pure node graph). This is by design and shapes the whole node.

### What we deliberately do NOT copy

- `u_dpr` / `u_resolution1x` gymnastics. The engine renders at canvas-pixel
  resolution. We store SDF distance directly in **canvas pixels** and re-derive
  the edge math cleanly rather than porting the reference's magic constants.
- The `texture(tex, uv, lodBias)` dispersion hack (steps 6–8). Pooled textures
  have no mipmaps. We port the **explicit per-channel offset** dispersion from
  the reference's `getTextureDispersion` / final STEP 9 path.
- The reference's own background generator (`fragment-bg.glsl`: chessboard /
  image / shadow). Our backdrop is whatever image is wired in. (The drop
  **shadow** pass is a nice-to-have deferred to M2.)

## 2. Architecture — one SDF-texture seam

Every shape source funnels into a single **signed-distance-field texture**
(R16F, distance in **canvas pixels**, negative inside). The optical pass is
written once against that texture and is agnostic to where the field came from.
This is what lets "built-in shapes", "multi-shape merge", and "shape input
override" all coexist without branching the optics.

```
                       ┌─────────────────────────────────────────┐
backdrop image ──────► │  pre-pass A: separable gaussian blur      │──► u_blurredBg
                       │  (gaussian-blur.ts pattern, 2 passes)     │
                       └─────────────────────────────────────────┘
 built-in shapes ─┐    ┌─────────────────────────────────────────┐
 shape input  ────┼──► │  pre-pass B: build SDF distance texture   │──► u_sdf (R16F, px)
 (mask/sdf)       │    │  - built-ins: analytic smin in a shader   │
                  │    │  - mask/image input: computeSDF (JFA)     │
                  │    │  - sdf input: compileSdf → distance        │
                  │    │  - merge mode: replace | union(smin)      │
                  │    └─────────────────────────────────────────┘
                       ┌─────────────────────────────────────────┐
 backdrop ───────────► │  main optical pass (port of STEP 9):      │──► output image
 u_blurredBg ────────► │  normal (∇ of u_sdf) → Snell edge factor → │
 u_sdf ──────────────► │  refraction + dispersion + fresnel +      │
                       │  glare(LCH) + tint + edge/center blur      │
                       │  + smoothstep AA composite over backdrop   │
                       └─────────────────────────────────────────┘
```

Normals come from **finite differences of `u_sdf`** (neighbor texel taps), not
analytic gradients — this is what unifies built-in and input-driven shapes. (For
a built-in-only fast path we *may* later compute analytic normals in the main
pass; not needed for correctness.)

### Why store distance in pixels in a texture

The edge/bevel math needs true distance-to-edge (`nmerged` in the reference) in a
consistent unit, compared against a thickness param. Canvas pixels is the natural
unit and matches what `computeSDF` (JFA) produces. R16F has ample precision for
the ±few-hundred-px band that matters near the edge. Use `ctx.allocMask()`
(R16F/R8) for `u_sdf`.

## 3. Node interface

- File: `src/nodes/effect/liquid-glass.ts`; register in
  [src/nodes/index.ts](src/nodes/index.ts) (`registerNode(liquidGlassNode)`).
- `type: "liquid-glass"` (immutable once shipped), `name: "Liquid Glass"`,
  `category: "image"`, `subcategory: "modifier"`, `backend: "webgl2"`,
  `primaryOutput: "image"`, `auxOutputs: []`.
- `stable`: leave default (cacheable). Motion comes from keyframes, which
  re-fingerprint; the node is deterministic given its inputs. Cheaper than Text.

### Inputs

| socket | type | required | role |
|---|---|---|---|
| `image` | `image` | yes | **Backdrop** — what's behind the glass. Output = backdrop + glass over its region. |
| `shape` | polymorphic (`mask` \| `image` \| `sdf`) | no | Overrides/augments the built-in shapes. Polymorphic via `resolveInputs` keyed on `connectedTypes.shape`. |
| (mask) | `mask` | auto | Universal mask input (`withMaskInput`) — gates **output** alpha as usual. Distinct from `shape`. |

`shape` resolution:
- wired `image`/`mask` (coverage) → `computeSDF(ctx, coverage, spreadPx)` (JFA)
  → distance MaskValue (see [sdf.ts](src/engine/sdf.ts), reused by Text).
- wired `sdf` → `compileSdf(root, …)` to a distance texture (the AST is
  re-evaluable; see the bevel mode in [sdf-compile.ts](src/engine/sdf-compile.ts)).
- a `merge` param picks **replace** (input shape only) or **union** (`smin`
  with the built-ins) when both are present.

### Outputs

- `primary: image` — backdrop with glass composited over the shape region,
  smoothstep-AA'd at the boundary, straight alpha.

### Params (grouped; ranges tuned in Phase 4)

**Shape A** (always on; gizmo-editable):
- `shapeType` enum: `rounded-rect | circle | superellipse`
- `x`, `y` (normalized [0,1], Y-down) — center
- `width`, `height` (normalized)
- `cornerRadius` (normalized), `roundness` (superellipse n, e.g. 2–8)

**Shape B** (`secondShape` boolean groupHeader → reveals; the "liquid" partner):
- same shape params as A, plus `merge` (smin k, the smooth-union radius).
  Keyframe B's `x`/`y` to get the reference's chase/meld.

**Glass / optics** (port of reference uniforms — names in parens):
- `thickness` (`u_refThickness`, px) — edge bevel depth
- `ior` (`u_refFactor`) — index of refraction
- `dispersion` (`u_refDispersion`) — chromatic spread (explicit R/G/B offsets)
- `blur` — backdrop gaussian radius (feeds `u_blurredBg`)
- `blurEdge` boolean (`u_blurEdge`) — center reads sharp vs blurred backdrop
- `fresnelRange`, `fresnelFactor`, `fresnelHardness`
- `glareFactor`, `glareRange`, `glareHardness`, `glareConvergence`,
  `glareOppositeFactor`, `glareAngle`
- `tint` color + `tintOpacity` (`u_tint` rgb + a)
- `OPACITY_PARAM` (universal; never hand-roll opacity)

## 4. Coordinate / alpha / aspect rules (invariant #4)

- Shape params are normalized **[0,1] Y-down**. The SDF pre-pass flips to GL
  Y-up where it samples; the gizmo adapter stays Y-down.
- **Aspect correctness**: a round corner must stay round on non-square canvases.
  The built-in SDF uses the aspect-correct distance path (cf. `u_aspectCorrect`
  in the SDF compiler / [aspect.ts](src/engine/aspect.ts)). Decide this
  explicitly — do not normalize naively by one axis.
- **Straight alpha** throughout; manual Porter-Duff source-over for the glass
  composite. Boundary AA via `smoothstep` on `u_sdf` (reference's final `mix`).

## 5. Texture discipline (invariant #3)

Per eval the node allocs: `blurTmp` + `blurred` (separable blur), `sdf` (R16F),
and `output`. Release `blurTmp` after the vertical blur; release `blurred` and
`sdf` after the main pass; return `output`. Never release inputs. If `shape` is
a coverage mask, key the JFA result off the input value-object identity
(WeakMap) so it only recomputes when the upstream actually changed (devguide
caching guidance).

## 6. On-canvas gizmo

Add a `liquid-glass` adapter to `PRIMITIVE_GIZMO_ADAPTERS`
([PrimitiveGizmo.tsx](src/components/effects/PrimitiveGizmo.tsx)), keyed by node
type, `anchorResize: true` (box-style like Text/Auto Layout). `read`/`write` map
Shape A's `x`/`y` (center) ↔ `cx`/`cy` and `width`/`height` ↔ `hx*2`/`hy*2` in
normalized [0,1]². Shape B is params-only in M1 (a second gizmo is a later
nicety). This is a **UI-side** change only — no engine coupling.

## 7. Build phases (all under the "M1" the owner asked for)

Sequenced so each phase is independently visible in the preview:

- **Phase 1 — core optics (single panel).** Backdrop blur pre-pass + one
  built-in rounded-rect/superellipse → pixel-distance texture + main optical
  pass (normal, Snell edge factor, refraction, explicit-offset dispersion,
  Fresnel, glare-in-LCH, tint, edge/center blur, AA composite). Delivers the
  faithful single-panel liquid-glass look.
- **Phase 2 — liquid merge.** Shape B + `smin` in the SDF pre-pass; keyframable
  positions → blobby melding.
- **Phase 3 — shape input override.** Polymorphic `shape` socket: mask/image →
  `computeSDF` (JFA); `sdf` → `compileSdf` to distance; `merge` = replace |
  union. Now text-shaped or SDF-tree glass works.
- **Phase 4 — gizmo + polish + docs.** `PRIMITIVE_GIZMO_ADAPTERS` adapter; tune
  ranges/`softMax`; in-app docs page (descriptions from the def); manual verify
  in browser.

### Deferred to M2+

Rotation; N>2 built-in shapes (array param + virtual keys); the reference's drop
**shadow** pass; WebGPU backend; spring/auto-liquid dynamics (toolbox gets
motion from keyframes, so this is optional).

## 8. Risks / open questions

- **Normal precision** from a distance *texture* vs analytic gradient. Mitigation:
  R16F + multi-tap central differences; optional analytic fast path for
  built-in-only later. Low risk near the edge where it matters.
- **Dispersion** must be explicit per-channel offset sampling (no LOD bias).
  Ported from STEP 9 / `getTextureDispersion`.
- **Backdrop alpha**: where the backdrop is transparent, refraction samples
  transparency; tint/fresnel/glare still show. Acceptable; document it.
- **Cost**: blur + JFA + optical pass per frame when the backdrop animates. Cap
  `blur` radius; JFA only on `shape` change. Comparable to Text→Merge.
- **sdf-input distance mode**: confirm the cheapest way to get raw signed
  distance out of `compileSdf` (a distance-emit mode vs rasterize→JFA) during
  Phase 3.

## 9. Implementation status (2026-06-29)

Shipped — [src/nodes/effect/liquid-glass.ts](../src/nodes/effect/liquid-glass.ts),
registered in [src/nodes/index.ts](../src/nodes/index.ts):

- **Phase 1 (core optics)** ✓ — backdrop blur pre-pass + analytic rounded-rect/
  superellipse SDF in pixel space + the full STEP-9 optical port (Snell edge
  refraction, explicit per-channel dispersion, Fresnel, LCH glare, tint,
  edge→center blur, smoothstep-AA composite). NaN-safe normals.
- **Phase 2 (liquid merge)** ✓ — Shape B + `smin`, behind the `secondShape`
  toggle, keyframable.
- **Phase 3 (shape input)** ✓ — optional `shape` **SDF** input. The wired SDF
  is compiled to an analytic distance expression (`compileSdfSnippet` in
  [sdf-compile.ts](../src/engine/sdf-compile.ts)) and **inlined** into the glass
  shader — evaluated analytically for distance and finite-difference normals, at
  built-in quality. `shapeMode` = replace | merge. Shader cached by
  `structuralHash(root)`, so animating SDF params only rebinds uniforms.
  - **Pivoted away from image/JFA.** The first cut took an image/mask `shape`
    and jump-flooded it to a distance field. JFA fields have faceted gradients
    (Voronoi cells) + axis seams → blocky normals → a moiré/grid look that no
    amount of blurring fixed. Rasterize→JFA fundamentally can't match an
    analytic SDF; the comparison (built-in circle vs image-circle) made this
    obvious. The `sdf` input gives every shape the built-in circle's quality.
  - **How to use any shape:** SDF primitives/booleans/smooth-union → `shape`
    (blobby liquid melds via SDF Smooth Union); splines via **Spline → SDF
    Spline → `shape`**; a raster only via a manual SDF if desired (not the path).
- **Phase 4 (gizmo + docs)** ✓ — `liquid-glass` adapter added to
  `PRIMITIVE_GIZMO_ADAPTERS` (anchored bounds box on Shape A); docs page
  auto-generates from the registry (`NodeCategoryPage category="image"`).

Design refinements made during the build (both improve quality): Phase 1/2 use
**analytic in-shader SDF** rather than a distance texture (higher quality,
simpler, aspect-correct corners for free) — the texture seam from §2 is used
only for the external `shape` input. Caught & fixed a GLSL bug in review:
`half` is reserved in GLSL ES 3.00 (renamed the SDF params).

Verified: `tsc --noEmit` clean, `eslint` clean on the new file, dev server
compiles + registers the node via HMR. **Not yet done: a real-browser visual
pass** — the optics defaults are educated first guesses and will likely want
tuning once seen on real footage.

## 10. References

- Reference shaders (fetched, MIT): `fragment-main.glsl`, `lib/sdf.glsl`,
  `lib/color.glsl` (LCH stack), `lib/math.glsl` (`safeAsin`), `fragment-bg*.glsl`.
- Codebase: [chromatic-aberration.ts](src/nodes/effect/chromatic-aberration.ts),
  [displace.ts](src/nodes/effect/displace.ts) (two inputs),
  [gaussian-blur.ts](src/nodes/effect/gaussian-blur.ts) (separable blur),
  [rasterize.ts](src/nodes/sdf/rasterize.ts) + [sdf-compile.ts](src/engine/sdf-compile.ts),
  [sdf.ts](src/engine/sdf.ts) (`computeSDF` JFA),
  [conventions.ts](src/engine/conventions.ts) (`OPACITY_PARAM`, `withMaskInput`),
  [PrimitiveGizmo.tsx](src/components/effects/PrimitiveGizmo.tsx),
  [types.ts](src/engine/types.ts) (NodeDefinition / ParamDef / RenderContext).
