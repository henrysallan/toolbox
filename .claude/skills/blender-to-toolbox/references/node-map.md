# Blender geometry nodes → toolbox node map

Load this when translating. It is organised by **how a family translates**,
not alphabetically, because the strategy matters more than the name lookup.

**`get_catalog` is authoritative, not this file.** Toolbox node types and
param ranges change; this map records the *semantic* correspondence, which
is stable. Always confirm the type string and the param name/range against
the live catalog before building a recipe.

Legend: **✓ clean** · **≈ lossy** (lands, but drops something — say what) ·
**✗ none** (no equivalent — report it, do not fake it).

---

## 1. Primitives — mostly clean

| Blender | toolbox | Notes |
|---|---|---|
| `GeometryNodeMeshCube` | `cube-3d` | ✓ `size` is a single scalar; Blender's Size is a vector, so a non-uniform cube needs `scale_x/y/z`. |
| `GeometryNodeMeshUVSphere` | `sphere-3d` | ≈ segment counts are not exposed; `sweep_h`/`sweep_v` cover Blender's partial sphere. |
| `GeometryNodeMeshIcoSphere` | `polyhedron-3d` | ≈ `shape="icosahedron"` + `detail` (0–4). |
| `GeometryNodeMeshCylinder` | `cylinder-3d` | ≈ `sides` (default 48) + `arc` + `open_ended`. |
| `GeometryNodeMeshCone` | `cone-3d` | ≈ same extras; `sides=4` is a pyramid. |
| `GeometryNodeMeshCircle` | `circle-3d` | ≈ |
| `GeometryNodeMeshGrid` | `plane-3d` | ≈ **Vertex counts are lost.** `plane-3d` has `width`/`height` only. If the tree grids a plane in order to Set Position its vertices, the whole strategy fails — see §4. |
| `GeometryNodeMeshLine` | ✗ | Use `array-3d` with `mode="linear"`, or `spline-3d`. |
| (no Blender primitive) | `torus-3d` | Blender builds tori from a node group. Arc < 360 is a macaroni. |
| (no Blender primitive) | `capsule-3d` | ✓ radius + length (cylindrical midsection). |
| (no Blender primitive) | `rounded-cube-3d` | Separate from Cube (different topology). |
| (no Blender primitive) | `torus-knot-3d` | p/q winding integers. |
| (no Blender primitive) | `ring-3d` | Inner 0 = disc; single-sided like Plane. |

Every toolbox mesh primitive also has `flat_shade` (factory-level).

Every toolbox primitive carries its own TRS (`pos_*`, `rot_*`, `scale_*`) and
material (`color`, `metalness`, `roughness`). A Blender Transform node
immediately after a primitive should usually be **folded into the primitive's
params** instead of adding a `transform-3d`.

---

## 2. Instancing — the cleanest correspondence in the whole map

This family is why a Blender→toolbox translation is worth doing at all. The
scatter → instance → realize pipeline exists on both sides with the same
meaning.

| Blender | toolbox | Notes |
|---|---|---|
| `GeometryNodeDistributePointsOnFaces` | `scatter-points-3d` | ≈ see below. **Grid of points** (no mesh) → `scatter-points-3d` `mode="grid"` with `count_x/y/z` + `spacing_x/y/z`. |
| `GeometryNodeInstanceOnPoints` | `copy-to-points-3d` | ≈ see below |
| `GeometryNodeRealizeInstances` | `realize-instances-3d` | ✓ |
| `GeometryNodeRotateInstances` | `instance-transform-3d` | ≈ `rot_x/y/z` |
| `GeometryNodeScaleInstances` | `instance-transform-3d` | ≈ `scale_x/y/z` |
| `GeometryNodeTranslateInstances` | `instance-transform-3d` | ≈ `offset_x/y/z` |
| `GeometryNodeJoinGeometry` | ✗ at geometry level | Join at the **scene** level: `scene-render` takes several `object3d` inputs (dynamic sockets). |

**`scatter-points-3d` is count-based, Blender is density-based.**
Toolbox takes `count` (1–10000) + `seed` and distributes area-weighted uniform
random points. So:

- `distribute_method="POISSON"` → ✗. Poisson-disk and `Distance Min` have no
  equivalent. Say so; do not silently substitute random.
- Blender `Density` is points per m². Convert with
  `count ≈ density × total_surface_area`, then **clamp to 10000** and report
  the clamp if you hit it.
- A `Density` field (texture-driven scatter) → ✗ in 3D. Density-by-texture is
  on the toolbox backlog. The 2D `scatter-points` node *does* take a `density`
  image input — another reason to consider the 2D target (§7).
- `scatter-points-3d` emits per-point **normals**, which is what makes
  `align_to_normal` work downstream.

**`copy-to-points-3d` takes params where Blender takes fields.**
Blender's Rotation and Scale inputs are per-point fields. Toolbox offers
`scale`, `scale_jitter`, `rotation_jitter`, `align_to_normal`, `seed`.

- Rotation wired from Distribute's `Rotation` output → `align_to_normal=true`.
  That is the single most common Blender idiom and it lands exactly.
- Random rotation/scale fields → `rotation_jitter` / `scale_jitter`.
- Anything else per-point (scale from a noise texture, from an attribute) →
  ✗ in 3D. Approximate with `instance-transform-3d`'s `factor` enum
  (`all` / `gradient` / `random`) or its `noise`/`image` inputs, and say it is
  an approximation.

---

## 3. Transform

| Blender | toolbox | Notes |
|---|---|---|
| `GeometryNodeTransform` | `transform-3d` | ✓ **but** convert axes and units — see SKILL.md. |

---

## 4. Set Position — the biggest hole

`GeometryNodeSetPosition` is the workhorse of Blender geometry nodes and has
**no 3D equivalent in toolbox**. Toolbox's `set-position` node is 2D only
(`spline` / `points`, `x`/`y` in normalized space).

There is no per-vertex 3D mesh editing anywhere in the toolbox catalog: no
Set Position, no vertex-domain attributes, no displacement modifier. When the
Blender tree's core idea is "grid a plane and displace its vertices by noise,"
that idea does not survive into toolbox 3D. Your options, in order of honesty:

1. **Report it as untranslated.** Correct when the displacement *is* the effect.
2. **`bump-3d`** if the displacement only needed to read as surface detail —
   it perturbs shading normals, not geometry. Silhouettes stay smooth.
3. **Retarget to 2D** (§7) — the 2D point pipeline has real per-point position
   writes via `point-expression` (`x = …; y = …`).

Never quietly drop a Set Position and present the result as a translation.

---

## 5. Mesh operations

| Blender | toolbox | Notes |
|---|---|---|
| `GeometryNodeExtrudeMesh` | `extrude-3d` | ≈ **faces only.** `mode="VERTICES"`/`"EDGES"` → ✗. `Offset` field → the uniform `depth` param. `faces=-1` extrudes every region independently (Blender's "Individual"). |
| Bevel (mesh) | `bevel-3d` | ≈ `width`/`segments`/`angle`. |
| `GeometryNodeSubdivisionSurface` | ✗ | No subdivision anywhere. |
| `GeometryNodeSubdivideMesh` | ✗ | |
| `GeometryNodeMeshBoolean` | ✗ in 3D | 2D spline booleans exist (`blend-intersections`, shape builder), but no mesh CSG. |
| `GeometryNodeDualMesh`, `…Triangulate`, `…SplitEdges`, `…MergeByDistance`, `…FlipFaces` | ✗ | No topology operators. |
| `GeometryNodeSetShadeSmooth` | ≈ `material-3d` | Shading only, not a topology flag. |
| `GeometryNodeMeshToPoints` | `mesh-to-points-3d` | ✓ **vertices only.** Blender's Edges / Faces / Corners modes → ✗. Emits `points3d` (world-space, with vertex normals). |

**Rule of thumb:** toolbox 3D is an *instancing and rendering annex*, not a
modeling kernel. Shape *generation* translates; topology *editing* mostly
does not.

Shader-side (not geometry nodes, but they show up in the same trees):

| Blender | toolbox | Notes |
|---|---|---|
| Principled BSDF | `material-3d` | ✓ base color / roughness / metalness / transmission / IOR / alpha / emissive / clearcoat / sheen. Texture sockets are `*_map` image inputs. |
| Ambient Occlusion (shader) | `ambient-occlusion-3d` | Bake: geometry in → UV-mapped grayscale image out. Wire into `material-3d`'s `ao_map` (or any other image channel). Split the geo **before** Material so the graph stays acyclic. |
| Image Texture → Principled input | Image Source / Perlin / AO bake → the matching `*_map` | Toolbox has no shader-graph; maps are images on the Material node. |
| Normal Map / Bump | `bump-3d` or Material `bump_map` | ✓ |

---

## 6. Curves

| Blender | toolbox | Notes |
|---|---|---|
| `GeometryNodeCurveToMesh` | `spline-3d` | ≈ round tube only (`radius`, `radial_segments`). An arbitrary profile curve → ✗. |
| `GeometryNodeCurveToMesh` (flat profile) | `extrude-spline-3d` | ≈ extrudes a 2D `spline` to depth, optional bevel. |
| Screw / Spin | `lathe-3d` | ≈ revolve a 2D `spline` profile; `sweep` is 0–1, not degrees. |
| `GeometryNodeCurvePrimitiveCircle` | `circle-3d` | ✓ |
| `GeometryNodeCurvePrimitiveLine` | `line` (2D spline) | ✓ Start/End → `startX/Y`, `endX/Y`. Direction mode → compute End from Start + Direction × Length, then write those four params. |
| `GeometryNodeCurveToPoints` | `spline-to-points` (2D) | `spline-3d` also exposes a `path_points` aux (`points3d`). |
| `GeometryNodeResampleCurve` | ≈ `points-on-path` | 2D. |

---

## 7. Fields, attributes, and utility — read §"The field problem" in SKILL.md first

**These only translate in the 2D `points` pipeline.** Toolbox's attribute
system operates on `points` (authored 2D), spline anchors, and spline
subpaths. `points3d` is produced by `scatter-points-3d` (surface or grid),
`mesh-to-points-3d`, and the 3D curve primitives' aux outputs (`spline-3d`,
`circle-3d`, `rect-3d`, `polygon-3d`), but only a few nodes consume it —
`copy-to-points-3d`, `project-to-screen-3d`, and `filter-points`. A 3D
point cloud can therefore be instanced onto, projected to screen, or
filtered, and nothing else: there is no 3D attribute math or 3D point
expression.

So: **a Blender tree whose substance is field math must be retargeted to the
2D pipeline, or reported as untranslatable.** Confirm the 3D producer/consumer
set against `get_catalog` before concluding — it is a young part of the app.

| Blender | toolbox (2D points) | Notes |
|---|---|---|
| `GeometryNodeStoreNamedAttribute`, `GeometryNodeCaptureAttribute` | `set-named-attribute` | `source`: constant / index / random / image. |
| `GeometryNodeInputNamedAttribute` | `attr("name")` inside `point-expression` | Per-element. Also a Spreadsheet column. For a single point's value as a scalar/vec2, `attribute-read`. |
| `GeometryNodeSampleIndex` | `attribute-read` | Points + name + index → scalar or vec2. Built-ins (`position`, `scale`, `index`, …) work too. |
| `ShaderNodeMath` (per-element) | `point-expression` | One line of JS. |
| `ShaderNodeMath` (uniform) | `math` | `operation` enum; also has a `uv` mode. |
| `GeometryNodeAttributeMath`-style chains | `attribute-math` | `add/subtract/multiply/divide/min/max/power/remap`, operand = constant or another attribute. |
| `ShaderNodeMapRange` | `map-attribute` or `attribute-math` `op="remap"` | `map-attribute` writes straight to scale / rotation / position x / position y. |
| `GeometryNodeBlurAttribute` | `attribute-blur` | `domain`: spatial or index. |
| `GeometryNodeSampleNearest`, `…Transfer` | `attribute-transfer` | `nearest` or `weighted` within `radius`. |
| `GeometryNodeInputPosition` | `px`, `py` in `point-expression` | |
| `GeometryNodeInputIndex`, `…ID` | `index`, `count` | |
| Index-offset timing chains (`Index` × spacing − `Scene Time` → clamped `Map Range`) | `stagger` | Writes a 0→1 `phase` channel per point: `order` (index / reverse / center / edges / random / attribute), `mode` spacing or fit, `duration`, `jitter`, `start`, `loop`, `unit`; optional `clock` scalar input. Read it with `map-attribute` (curve = easing), `filter-points` attribute mode, or `copy-to-points` `opacity_attr` / `pick_attr`. |
| `GeometryNodeInputNormal` | ✗ (2D) | 3D normals exist only inside `scatter-points-3d` → `align_to_normal`. |
| `FunctionNodeRandomValue` | `set-named-attribute` `source="random"` | Or a hash in `point-expression`. |
| `GeometryNodeSeparateGeometry`, `GeometryNodeDeleteGeometry` | `filter-points` | Modes: bbox / mask / index / random / attribute. Also `keep = …` in `point-expression`. |
| `GeometryNodeSwitch` | `switch` | `type="auto"` unifies wired types. |
| `ShaderNodeTexNoise` | `perlin-noise` | Three outputs: `image`, `value` (CPU scalar at a sampled position), `field` (per-pixel expression). |
| `ShaderNodeMix` / `MixRGB` | `lerp` | `type`: scalar / vec2 / points / spline. |
| `ShaderNodeClamp` | `clamp` | |
| `ShaderNodeFloatCurve` | `float-curve` | |
| `ShaderNodeCombineXYZ` / `SeparateXYZ` | `combine-vec2`, `vec3-literal` | 2D is vec2-centric. |
| `GeometryNodeAttributeStatistic` | ✗ | No reduction (sum/mean/min over elements). |
| `GeometryNodeAccumulateField` | ✗ | |
| `NodeGroupInput` / `NodeGroupOutput` | recipe `inputs` / `outputs` | Declared in the RecipeGraph envelope, not as node types. |
| `NodeReroute` | — | Dissolve during translation. Toolbox has reroutes but they carry no meaning. |

### 2D instancing (often the better landing site)

| Blender | toolbox (2D) | Notes |
|---|---|---|
| `GeometryNodeDistributePointsOnFaces` | `scatter-points` | Takes a **`density` image input** — texture-driven scatter, which the 3D node cannot do. |
| `GeometryNodeInstanceOnPoints` | `copy-to-points` | Far richer than the 3D version: `scale_field` / `rotate_field` image inputs, `pick_mode` by attribute / index / group, per-point `tint_attr` and `opacity_attr`. |
| `GeometryNodeMeshGrid` (as a point source) | `grid` (2D) or `scatter-points-3d` `mode="grid"` | 2D: `countX`/`countY`. 3D: `count_x/y/z` + `spacing_x/y/z`. |

---

## 8. Things with no Blender counterpart worth reaching for

When a Blender tree is *approximating* something toolbox does natively, prefer
the native node and say you substituted:

- `behavioral-growth`, `accretive-growth` — space colonization / DLA / L-system
  growth that Blender needs a whole tree to fake.
- `advect-points` — flow-field advection with trail output; also takes the
  particle-sim force nodes (Point / Vortex / Wind / Gravity / Turbulence / Drag).
- `vector-field` — SDF or image → signed-RG velocity (attract / repel / orbit /
  isoline). Wire into Advect, Displace, or Point Expression `fieldX()`/`fieldY()`.
- `ambient-occlusion-3d` — UV-space AO bake (geometry → image) for Material
  `ao_map` or any other map channel.
- `points-to-surface`, `connect-points`, `proximity-merge`.
- `points-to-spline` `layout="grid"` — walk a Grid's rows and columns (uses
  stamped `ix`/`iy`, or set `columns` = Grid `countX`). `gridWalk` is
  `rows` / `columns` / `both` (default both). Chain mode (default)
  is a zigzag in index order; do not use Connect Points after a warp.
- `points-to-spline` `layout="stride"` — every `stride` consecutive points
  become one subpath (`stride=2` is pairs). Inverse of tagging
  `groupIndex = floor(index/k)` then chaining.
- `points-to-spline` `layout="zip"` — pair corresponding points across
  `groupIndex` groups (Collect two curves, then zip = connect a_i to b_i).
  Do not reach for Point Expression `index % n` for this.
- `taper-spline` — per-anchor scale of offset-from-pivot by a curve over
  path progress (taper / flare / envelope). Modulate Splines is one scale
  per whole subpath; Trim Path is an arc-length window.

---

## 9. Reporting template

End every translation with this, so the user knows exactly what they got:

```
Translated:   <n> Blender nodes → <m> toolbox nodes (group id <id>)
Approximated: <blender node> → <toolbox node> — <what changed>
Dropped:      <blender node> — <why there is no equivalent>
Clamped:      <param> <blender value> → <toolbox value> (range <lo>..<hi>)
```
