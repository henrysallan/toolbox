# 3D update — geometry type, 3D points, instancing, face extrude, materials

Design spec for the second wave of 3D nodes, written with the owner across a
design Q&A (2026-08-10). Status: **M1–M4 + M4.5 (instances — §4.4) +
M6 (Tier 1 — 2026-08-11: Extrude Spline w/ winding-based holes, Lathe,
Transform 3D polymorphic over geometry|instances, 3D Array
linear/radial/grid, Instance Transform w/ all|gradient|random weights,
spot light, Scene Render background/fog/RoomEnvironment IBL)
implemented (M1–M4.5 2026-08-10;
typecheck/check/lint green + offline smokes). M2 verified live in the
viewport by the owner (after fixing the coerceValue points/points3d
routing — see the TESTING.md note this added: node smokes must push
inputs through coerceValue, the evaluator's wire path). M3's smoke pins
region counts (cube 6 / cylinder 3 / plane 1), watertight outward
stitching via exact signed volume (extrude-all cube = 1.6), index
wrapping, and the depth-0 passthrough. M4's smoke pins desc flow-through
+ sig movement, the Physical upgrade, and the texture bridge's contract
(≤1024 cap, flipY, sRGB-vs-linear per channel, identity-cached crossing,
deterministic per-material disposal) plus projection UV math for all
four modes. M5 (docs/polish + brainstorm) not started. Implementation
notes: Material's map inputs are named `*_map` (base_color_map, …) so
they never collide with the same-named color/scalar params; Texture
Projection reuses the standard pos_/rot_/scale_ param names so the
existing 3D viewport gizmo drives the projection volume; the bridge's
texture lifecycle is PER-MATERIAL via userData + the material 'dispose'
event rather than a global WeakMap, trading a duplicate upload in the
rare shared-desc case for deterministic GPU cleanup on three's context.**

Implementation note (M2): the `visibleIf` meta arg carries
`{ inputTypes }` — the node's RESOLVED input socket types read from the
stored resolveInputs result — rather than raw `connectedTypes`; same
information for this purpose, zero graph-walking in ParamPanel. Filter
Points' 3D bbox uses SEPARATE world-range params (`wx/wy/wz_min/max`,
default −10..10 = keep-all) instead of growing Z rows onto the 2D params,
whose [0,1] authored defaults would have clipped an origin-centered world
cloud.
This is the original 3D spec's M2–M4 territory
([archive/061626_3d-nodes-and-context.md](archive/061626_3d-nodes-and-context.md))
reshaped around what the owner actually wants next.

Read [061226_devguide.md](061226_devguide.md) first, then the original 3D
spec for the M1 architecture this builds on (isolated-context render bridge,
retained three objects in `ctx.state`, convergent dataflow into Scene
Render).

## Decisions from the Q&A (locked)

1. **Introduce the `geometry` socket type now** (the original spec's M2
   plan). Primitives emit `geometry`; modeling ops and the Material node
   chain on it (Houdini SOP style); a `geometry→object3d` coercion
   auto-wraps at the scene boundary so existing saved wires keep working.
2. **3D points = shared value, split wire type ("Option B").** One
   `PointsValue` representation grows optional `z` + `normals` typed
   arrays; the socket type is a distinct **`points3d`** when z is present.
   Existing utilities upgrade in place via input polymorphism (Filter
   Points first — no duplicate node). The editor refuses accidental 2D↔3D
   wires; crossings that mean something are explicit bridges. Rationale
   recorded below (§2.1) — the alternative (one `points` type everywhere)
   turns the devguide's five-times-fixed authored-space bug into a silent
   user-facing failure and silently strips z through the ~15 utility nodes
   that rebuild points via the legacy `Point[]` view.
3. **Bevel is deferred entirely** — a real edge bevel needs a half-edge
   mesh structure and is its own multi-week project. Parked in the backlog
   (§8) with the design constraints we already know (segments slider,
   `float_curve` profile UI — the param type already exists).
4. **Extrude = mesh face-extrude only** (index socket selects a logical
   face, default −1 = all faces). The spline→geometry extrude from the
   original spec stays in the backlog.
5. **Combine gains an "object" mode** (dynamic `object3d` inputs → one
   group). Scene Merge becomes `hidden: true` — registered for saved
   projects, gone from the menu.
6. **No `material` socket type in this update.** The Material node is
   flow-through (`geometry → Material → geometry`, spec §6 of the original
   doc); the material rides *inside* `GeometryValue`. A wireable material
   value can come later without redesign.

## Node list (this update)

| Node | In → Out | One-liner |
|---|---|---|
| 3D Scatter Points | geometry \| object3d → points3d | Area-weighted random points on a surface, with normals |
| 3D Copy to Points | geometry + points3d (or points, bridged) → object3d | InstancedMesh at every point, align-to-normal |
| Filter Points (upgrade) | points \| points3d → same type | Existing node goes polymorphic; bbox grows Z rows |
| Combine (upgrade) | +"object" mode: object3d ×N → object3d | Replaces Scene Merge in the menu |
| Extrude Faces | geometry → geometry | Offset a logical face (or all) along its normal, stitched sides |
| Material | geometry → geometry | PBR flow-through: base color, roughness, metalness, transmission, alpha; channels accept images |
| Texture Projection | geometry → geometry | Rewrites UVs: planar / box / cylindrical / spherical + TRS gizmo params |
| Realize Instances (M4.5) | instances → geometry | Explicit N×-vertex bake for modeling-chain interop on the copies |
| Instance Color (M4.5) | instances → instances | Per-copy tint (solid / seeded random / gradient) via three's instanceColor |

Primitives (Cube/Sphere/Plane/Cylinder/Cone/Torus) switch their primary
output `object3d → geometry` (§3.2). Import 3D stays `object3d`.

---

## 1. `geometry` — the modeling chain type

### 1.1 Value shape

```ts
// engine/three-types.ts
export type GeometryValue = {
  kind: "geometry";
  // Retained BufferGeometry owned by the PRODUCING node's ctx.state —
  // consumers read, never mutate, never dispose (same ownership rule as
  // Object3DValue). LOCAL space, centered at origin.
  geometry: THREE.BufferGeometry;
  // TRS carried alongside, folded by transform-ish params/nodes and
  // applied at the object3d wrap. Modeling ops operate in local space and
  // pass this through untouched.
  transform: {
    position: [number, number, number];
    rotationEuler: [number, number, number]; // radians, XYZ order
    scale: [number, number, number];
  };
  // Material slot 0 (default when absent). Set by the Material node.
  // An array from day one so imported multi-material meshes and per-part
  // overrides need no type change later (original spec §6).
  materials: (MaterialDesc | null)[];
};

export type MaterialDesc = {
  kind: "material";
  baseColor: string | ImageValue;      // hex or texture
  roughness: number | ImageValue;
  metalness: number | ImageValue;
  transmission: number;                // MeshPhysicalMaterial territory
  ior: number;
  alpha: number | ImageValue;
  sig: string;                         // fingerprint of resolved channels
};
```

Runtime-only, never serialized — exactly like `sdf`/`element`/`particles`.
Persistent state is the producing node's params.

### 1.2 Mutate-vs-copy rule (the one that prevents shared-buffer bugs)

A modeling op **never mutates its input's BufferGeometry** — the upstream
value is shared via the fingerprint cache. It builds a NEW BufferGeometry
into its own `ctx.state`, keyed by (input value identity, params
signature). Value-object identity is the sound "upstream recomputed"
signal (devguide §Caching); a `WeakMap` keyed on the input `GeometryValue`
or a stored `lastInput` ref both work. Dispose tears the built geometry
down.

### 1.3 `geometry → object3d` coercion (the auto-wrap)

In coerce.ts: wrap the BufferGeometry in a `THREE.Mesh`, apply
`transform`, resolve `materials[0]` (or the shared default
MeshStandardMaterial), tag `userData.nodeId` when known. **Identity-cached
in a WeakMap** keyed on the GeometryValue (the spline→mask /
image↔element precedent) so a static geometry wraps once; the wrap
re-syncs transform/material when the value object is new. Material
resolution for `MaterialDesc` lives in one shared helper used by both this
coercion and 3D Copy to Points (§4.2) — `transmission > 0` upgrades to
`MeshPhysicalMaterial`, texture channels go through the texture bridge
(§6.2).

Editor side: add `geometry→object3d` to `coercible` in graph-helpers.ts.
This single entry is what keeps every saved `cube → 3D Scene` /
`cube → Scene Merge` wire working after primitives retype (§3.2).

### 1.4 Socket-type ripple (invariant #7 checklist — paid twice, once per type)

For **both** `geometry` and `points3d`: `types.ts` (SocketType union +
SocketValue), `coerce.ts`, `socketColor.ts`, graph-validation
(`coercible`; `editorCanCoerce` exceptions where polymorphic), `clips.ts`
`emptyClipOutput`, docs socket-legend page, SocketPeekPopover +
NodeInspectorPopup summaries (geometry: vertex/triangle/face counts +
material presence; points3d: count + "world-space" note — no 2D drawing,
that's the authored-space surface we're deliberately not lying on).

---

## 2. `points3d` — shared value, split wire

### 2.1 Why split the wire type (decision record)

2D `points` are **authored [0,1]², Y-down**; 3D points are **world-space,
Y-up, meters, unbounded**, and carry normals. One shared socket type would
make `3D Scatter → String Art` a legal wire that silently renders garbage
coordinates, and any 3D stream routed through an unported utility
(rebuilding via the legacy `Point[]` view, `pos: [x, y]`) would silently
drop z and normals — ~15 nodes rebuild that way. Splitting the wire type
converts both failure modes into a refused connection at drag time. The
value *representation* stays shared, so helpers and algorithms don't fork.
The devguide's "authored space, always" invariant for `points` survives
intact.

### 2.2 Value shape

```ts
// engine/types.ts — PointsValue gains two OPTIONAL arrays
export interface PointsValue {
  kind: "points";
  count: number;
  positions: Float32Array;          // count*2 — xy in BOTH dims' spaces
  z?: Float32Array;                 // count — presence ⇒ this is 3D data
  normals?: Float32Array;           // count*3 — surface normals (3D only)
  scales?: Float32Array;            // 2D semantics; unused by 3D consumers
  rotations?: Float32Array;         //   "
  groupIndices?: Int32Array;        // shared semantics (variant identity)
  points: Point[];                  // legacy 2D view — see rule below
}
```

- **Discriminator**: `z !== undefined` ⇔ the value is 3D ⇔ it rides a
  `points3d` socket. Helper `is3DPoints(v)` in points.ts; `makePoints`
  gains `withZ` / `withNormals` opts.
- **Space**: `points3d` xy+z are world-space Y-up. `positions` holds
  world xy (NOT authored) — the socket type is what licenses that.
- **Legacy-view rule**: `ensurePointArray()` is 2D-only. 3D producers and
  consumers read/write typed arrays directly — never the `Point[]` view.
  Guard: `ensurePointArray` warns (dev) when called on a 3D value, so an
  accidentally-shared code path announces itself instead of flattening.
- **No coercions** for `points3d` — with no canonical world↔canvas
  mapping, any implicit conversion would be dishonest. Bridges are nodes
  or explicit polymorphic inputs (§4.2).

### 2.3 Filter Points — the in-place polymorphic upgrade

The pattern to establish for every future utility upgrade (Jitter, Relax…):

- Input accepts `points | points3d` via an `editorCanCoerce` defType
  exception (the Transform/Displace-source precedent);
  `resolvePrimaryOutput` mirrors the connected input's type
  (`connectedTypes`), so the filtered stream re-advertises what came in.
  The splice path already handles output retyping via
  `projectPrimaryOutput`.
- Modes on 3D input: **bbox** grows Z min/Z max rows (world-space ranges,
  min −10 / max 10 / step 0.01 — not the 2D [0,1] rows); **index** and
  **random** work unchanged (count-based, space-blind); **mask** is 2D-only
  (authored-space sampling) — on a 3D input it passes everything through
  unchanged and the panel notes it.
- Compute must rebuild via typed arrays (carry z/normals/groupIndices
  through the keep-mask), not `ensurePointArray` — this is the first node
  that exercises the §2.2 legacy-view rule.
- **`visibleIf` extension (additive)**: `visibleIf` currently receives
  only params; the Z rows and the mask-mode note need the connected input
  type. Extend the signature to
  `(params, meta?: { connectedTypes?: Record<string, SocketType> })` —
  ParamPanel passes the second arg, existing single-arg predicates are
  untouched. Verify ParamPanel is the only call site before assuming.

---

## 3. Scene-side changes

### 3.1 Combine "object" mode; Scene Merge retired from the menu

`collect.ts` mode enum gains `"object"`: sockets type `object3d`
(N=1–26 as today), output `object3d`. Compute holds a retained
`THREE.Group` in `ctx.state` (Combine gets its first `dispose`), clears +
re-adds each eval — Scene Merge's exact membership reconciliation.
Children order = socket order; no groupIndex analog needed (a THREE.Group
preserves order; a future per-object pick can read child index).
`geometry` inputs work through the §1.3 coercion — wiring a primitive
straight into Combine is legal and auto-wraps.

Scene Merge: `hidden: true` (stays registered — saved projects load;
back-compat invariant #2). Its docs entry points at Combine.

### 3.2 Primitives emit `geometry`

`makePrimitiveNode` keeps ALL current params (size/TRS/color/metalness/
roughness) and its retained state, but the retained object becomes the
BufferGeometry (+ a default-material MaterialDesc built from the color/
metal/rough params), and `primaryOutput` becomes `"geometry"`. The TRS
params fold into `GeometryValue.transform`. Saved wires into object3d
sockets survive via the coercion; the WeakMap wrap keeps per-eval cost
~zero. The old baked `THREE.Mesh` state shape dies with the code that
built it (runtime-only — nothing serialized changes).

Modeling ops downstream see local-space geometry (transform rides along
untouched); Scatter is the one consumer that must compose the transform
in (§4.1).

---

## 4. Instancing trio

### 4.1 3D Scatter Points

- **Input**: `source` — polymorphic `geometry | object3d`
  (`editorCanCoerce` exception). geometry: sample its triangles, then
  apply its carried transform so emitted points are world-space. object3d:
  traverse for meshes, sample across all of them, apply each mesh's world
  matrix — this is what makes an imported GLB scatterable.
- **Params**: `count` (1–10000, softMax 2000), `seed`. Distribution:
  area-weighted uniform (cumulative triangle-area table + mulberry32, the
  scatter-points PRNG precedent → deterministic).
- **Output**: `points3d` with `z` + `normals` (face normal of the sampled
  triangle, transformed by the inverse-transpose for non-uniform scale).
- Density-by-texture/vertex-color needs UV sampling + readback — backlog,
  mirroring 2D Scatter's density input shape when it lands.
- CPU cost is per-recompute, not per-frame (fingerprint cache); count slider
  drags rebuild — same profile as 2D Scatter.

### 4.2 3D Copy to Points

- **Inputs**: `instance` — `geometry` (the thing to copy); `points` —
  polymorphic `points3d | points`. **2D points are the explicit bridge**:
  authored [0,1]² maps onto a plane — params `plane` (enum `XZ` ground /
  `XY` billboard, default XZ) + `plane_size` (world units, default 2,
  centered on origin, authored y → +z on XZ so screen-down maps to
  "toward viewer").
- **Params**: `align_to_normal` (bool, default on; no normals → world-up
  alignment), `scale` (uniform base), `scale_jitter` (0–1),
  `rotation_jitter` (degrees, around the normal/up axis), `seed`.
- **Output**: `object3d`, variant `"instanced"` (add to the
  Object3DValue variant union): a retained `THREE.InstancedMesh` sharing
  the instance geometry's BufferGeometry (no copy) and its resolved
  material (§1.3's shared helper). Rebuild the InstancedMesh when count or
  the instance geometry changes; otherwise write matrices +
  `instanceMatrix.needsUpdate`. Matrix compose: T(point) ·
  R(normal-align · jitter) · S(scale · jitter) · instance's own carried
  transform.
- groupIndex variant picking (2D Copy's pick modes) — backlog; v1 is one
  instance geometry.

### 4.3 Filter Points upgrade — §2.3 (listed here for milestone grouping).

### 4.4 `instances` — first-class instancing (M4.5 addendum, agreed 2026-08-10)

Post-M4 owner Q&A: Copy to Points emitting a baked `object3d`
(InstancedMesh) is a dead end for per-instance modification (material /
scale / rotation), and realizing to `geometry` by default would destroy
the instancing perf win (N×verts real geometry per recompute). So
instances become a **socket type** — the Blender-GN instance-domain model
adapted to our wire system, and the third application of the
"shared-value / split-wire / auto-wrap at the boundary" pattern:

- **`InstancesValue`**: `source` (a GeometryValue — geometry ref +
  material slots + the instance's own pre-transform), `count`, and
  per-instance TRS SoA (`positions` ×3, `quaternions` ×4, `scales` ×3) in
  the "copy at point i" frame (the resolver composes `TRS_i · M_source`),
  plus optional `colors` (×3, linear — three's native `instanceColor`)
  and a `retainKey` — a stable object the producer retains across
  recomputes, which the resolver keys its retained InstancedMesh on
  (the geometry→object3d wrap trick, one level up).
- **Copy to Points emits `instances`**; the `instances → object3d`
  coercion resolves at the scene boundary, so Scene Render / Combine
  wiring is untouched. Instance modifiers are ordinary nodes on the
  stream. Value convention: modifiers copy the value and REPLACE the
  arrays they change, sharing the rest (producers mint fresh arrays per
  recompute; consumers only read).
- **Realize Instances** (`instances → geometry`) is the explicit bake for
  modeling-chain interop on the copies — cost visible in the graph, not
  hidden in a default. Output carries an identity transform (instances
  are world-space).
- **Instance Color** is the first modifier (solid / seeded random A↔B /
  index gradient → `instanceColor` tint, free on three's side).
  Per-instance FULL materials resolve later as material-index batches
  (one InstancedMesh per index under a group); Instance Transform and
  scatter-on-instances go to the brainstorm backlog.

---

## 5. Extrude Faces

- **Input**: `geometry`; **face index** exposed as a param AND input
  socket (scalar, integer step, min −1, default −1 = all faces — per the
  Q&A, "default is everything").
- **Params**: `depth` (world units, −2–2 soft, can be negative = inset
  direction), `faces` (the index param above).
- **Logical faces**, not triangles: region-grow over triangle adjacency
  (shared-POSITION edge graph — three's primitives duplicate vertices per
  face, so edges only exist after canonicalizing positions) merging
  neighbors whose face normals agree within an **`angle` param (default
  30°)**. One fixed threshold cannot deliver both "cylinder side is one
  face" (adjacent facets differ 7.5°) and "sphere is per-triangle facets"
  (neighbors differ ~5–11°) — as-implemented, 30° gives cube 6 / cylinder
  3 / plane 1 / sphere 1 (inflate), and lowering the angle below the
  facet angle gives the spiky-ball per-facet extrude. Face ordering is
  **deterministic** (region-grow seeded in triangle-index order) so a
  keyframed/wired index doesn't flicker between evals; the index **wraps
  mod face_count** so a counter cycles faces. Aux output `face_count`
  (scalar) so users can drive/inspect the index range. Offsets are
  PER-VERTEX region normals (area-weighted), not one averaged region
  normal — identical on flat faces, a correct radial inflate on curved
  regions where the average collapses toward zero.
- **Algorithm** (indexed BufferGeometry in, indexed out): duplicate the
  selected region's vertices, offset along the region's average normal ×
  depth, re-point the region's triangles at the duplicates, stitch the
  region's boundary edge loop with side quads (two triangles each), then
  recompute normals (flat-shaded sides; `toNonIndexed` + recompute is
  acceptable v1 if seam quality demands it). Original UVs survive on the
  cap; side walls get edge-length × depth UVs.
- Non-manifold input: region-grow and boundary-loop extraction tolerate
  open meshes (a Plane extrudes into a slab wall); degenerate output is
  acceptable v1 for pathological imports.
- §1.2 mutate-vs-copy rule applies: build into own state, sig =
  (input identity, depth, face index).

---

## 6. Materials

### 6.1 Material node (flow-through)

`geometry → Material → geometry`: copies the value (NOT the buffers —
same BufferGeometry ref, same transform) with `materials[0]` replaced by
a `MaterialDesc` built from params. Positional application semantics
(original spec §6): split the geo stream after the node ⇒ same material
both branches; before ⇒ different.

- **Channels** (the owner's list): `base_color` (color param + `image`
  input), `roughness` (scalar + `image` input), `metalness` (scalar +
  `image` input), `transmission` (scalar) + `ior` (1–2.5, default 1.5,
  visibleIf transmission > 0), `alpha` (scalar + `image` input).
- Wired image beats the scalar/color param per channel (the universal
  param-precedence feel). `sig` = stable hash of scalar channels + each
  wired ImageValue's identity tick — the resolver (§1.3's shared helper)
  rebuilds the three material only when sig moves.
- three mapping: `MeshStandardMaterial` normally;
  `transmission > 0` ⇒ `MeshPhysicalMaterial` (+ ior). `alpha < 1` or an
  alpha texture ⇒ `transparent: true`. baseColor texture tagged sRGB;
  roughness/metalness/alpha textures linear (original spec §5).
- Emissive / normal map / clearcoat: backlog — the MaterialDesc shape
  extends without ripple.

### 6.2 The texture bridge (the one real technical wrinkle)

Engine pool textures live on the **engine's** GL context; three runs on
its **own isolated context** (path B — original spec §4). WebGL cannot
share textures across contexts, so an `image` channel must cross by
copy: `readImagePixels` (FBO readback — the devguide-sanctioned path) →
`THREE.DataTexture`. Rules:

- **Identity-cached**: WeakMap keyed on the ImageValue → DataTexture; a
  static texture crosses ONCE. Animated inputs re-cross per upstream
  recompute (value identity moves), which is the honest cost.
- **Capped resolution**: readback at ≤1024px on the long side (material
  textures don't need canvas res; a 1080p RGBA readback per frame is the
  "~1 MB fast" threshold blown ×8). Param later if someone needs full res.
- Future path (A) — shared-context — removes the copy entirely; the node
  graph doesn't change (original spec §4's reversibility argument).

### 6.3 Texture Projection

`geometry → geometry`, rewrites the `uv` attribute (a copied attribute on
a cloned-attributes geometry — positions/normals/index shared by
reference, §1.2 rule applies to the attribute, not the whole buffer set).

- **Modes**: `planar` (project along local +Z of the projection volume),
  `box` (per-triangle dominant-axis planar — the triplanar-lite that
  makes noise/texture wrapping a cube look right), `cylindrical`
  (θ/height), `spherical` (θ/φ).
- **Params**: mode + projection-volume TRS (pos/rot/scale ×3 — the
  standard 9, same layout as primitives) mapping world→projection space.
  UVs = projection-space coordinates in [0,1] across the volume.
- Camera-mode projection (project through a wired `camera`) — backlog;
  it wants frustum math + per-frame reproject and pairs with AOVs.

---

## 7. Milestones

**M1 — Type plumbing (the enabling PR).** `geometry` + `points3d` through
the full invariant-#7 ripple (§1.4). `GeometryValue`/`MaterialDesc` in
three-types.ts; `PointsValue.z/normals` + `is3DPoints` + `makePoints`
opts + the `ensurePointArray` dev guard. `geometry→object3d` WeakMap
coercion + `coercible` entry. Primitives retype to `geometry` (§3.2).
Combine "object" mode + Scene Merge hidden (§3.1). Verify: an existing
saved 3D project (primitive→merge→scene) loads and renders identically.

**M2 — Instancing trio.** 3D Scatter Points (§4.1) → 3D Copy to Points
(§4.2) → Filter Points polymorphic upgrade + the `visibleIf` meta arg
(§2.3). Demo graph: Sphere → Scatter → Copy(Cube instances) → Combine →
3D Scene, filtered by Z band.

**M3 — Extrude Faces (§5).** Face detection + deterministic ordering +
`face_count` aux first, then the extrude itself. Verify on cube (6),
cylinder (3), plane (1, open-mesh path), sphere (spiky ball).

**M4 — Materials.** Material node (§6.1) + texture bridge (§6.2), then
Texture Projection (§6.3). Demo: 2D noise → Material roughness on a
sphere; Gradient → base_color via planar projection.

**M6 — Tier 1 of the basic-nodes brainstorm (agreed 2026-08-11; built
before M5 so docs cover the final family).** The bridges + cheap wins:

- **Extrude Spline** (spline → geometry): authored [0,1]² Y-down maps
  isotropically to world (authored units are canvas-width units, so no
  aspect correction: `wx=(x−0.5)·size`, `wy=(0.5−y)·size`), subpaths →
  one THREE.ShapePath → `toShapes` (winding-based hole detection — try
  CW then CCW; even-odd robustness is a polish item), ExtrudeGeometry
  with bevel opts, z-centered. Text 3D = Text's spline aux wired in
  (recipe, not a node). Lean surface: no TRS/material params — that's
  Transform 3D / Material.
- **Lathe** (spline → geometry): first-subpath profile sampled along its
  beziers, x-distance from authored center = radius, revolved about Y
  (LatheGeometry; radial segments + sweep).
- **Transform 3D**: polymorphic geometry | instances (the Filter Points
  pattern). Geometry: params TRS composes onto the carried transform
  (matrix multiply + decompose). Instances: transforms the whole cloud's
  SoA. Standard param names ⇒ the viewport gizmo drives it.
- **3D Array** (geometry → instances): linear / radial / grid — instancing
  without points. Radial gets sweep + outward alignment.
- **Instance Transform** (instances → instances): world offset + local
  rotation + scale, scaled per copy by a factor mode (all / index
  gradient / seeded random) — index-staggered motion loops.
- **Spot light** (Light node type enum grows; angle/penumbra/distance).
- **Scene Render**: background (transparent/solid), fog (linear/exp2),
  environment IBL (three RoomEnvironment via PMREMGenerator — no HDR
  file needed; `scene.environmentIntensity`). This is what makes
  metalness/transmission actually read.

**M6.5 — the `noise_field` bridge (owner ask, 2026-08-11, implemented).**
The Noise node goes dual-purpose 2D/3D: a new `field3d` aux output
(`noise_field` socket type — a small CPU descriptor of the SAME params:
type/scale/octaves/persistence/lacunarity/offset/seed/W/contrast) that
world-space consumers evaluate via `sampleNoiseField(field, x, y, z)` →
[0,1] (engine/noise.ts). Backed by true 3D noise (snoise3/cnoise3/vnoise3
+ fbm3, W-slice evolution kept as a SEPARATE axis since z is spatial now)
— deterministic and in the 2D family's visual character, but NOT
bit-mirrors of the GLSL (nothing overlays a shader render, so the voronoi
pcg3d rule doesn't apply). One world unit spans `scale` noise units; no
canvas aspect. Animated/looping evolution folds into the field's offset
exactly like the image path, so a looping noise loops the 3D field too.
First consumer: **Instance Transform's `noise` input** — the field
sampled at each copy's pre-delta position replaces the index-based weight
(spatially coherent displacement; animate W and waves travel through the
copies), with a `Centered` toggle mapping [0,1] → [−0.5, 0.5]. Plumbing
note: `visibleIf` meta grew a `wired` map (which inputs have edges) so
rows can swap on a STATIC optional socket being connected — `inputTypes`
only answers for polymorphic sockets. Next consumers when they land:
Displace, scatter density.

**M7 — Tier 2 picks (owner ask, 2026-08-11, implemented).** Three items
promoted from the brainstorm's Tier 2:

- **Project to Screen** (points3d + camera → 2D `points`): the honest
  3D→2D crossing the type system reserved. Mirrors Scene Render's camera
  math (same Camera node wired into both ⇒ projected points land on the
  rendered pixels; unwired = the same default view). NDC → canvas-UV →
  aspect-UNcorrected authored y (engine/aspect.ts), so 2D renderers'
  correction round-trips exactly. Behind-near-plane points are culled
  (compacted; groupIndices survive); off-screen-but-in-front points keep
  their out-of-[0,1] coords for honest leader lines.
- **Instance Color "image" mode**: sample a wired image at each copy's
  world position through the XZ/XY planar mapping (the Copy to Points
  bridge convention, inverted), ≤256px identity-cached readback (the 2D
  Scatter density pattern), sRGB→linear via THREE.Color.setRGB.
- **Material toon/matcap shading**: `shading` enum on the Material node +
  MaterialDesc (in the sig). Toon = MeshToonMaterial with a generated
  N-band NearestFilter gradient map (`toon_steps`, per-material cached,
  dies with the material); matcap = MeshMatcapMaterial where a wired
  base-color image IS the matcap, else a generated lit-clay-ball default
  (module singleton). PBR rows hide off-standard; toon/matcap force
  transmission 0 so materialClassFor is unambiguous. The resolver's
  Standard↔Physical switch generalized to a four-way class compare
  (classOfMaterial — Physical checked before Standard, it's a subclass);
  the instances resolver inherits it via its rebuild-on-sig path.

**M8 — 3D Bevel (owner ask, 2026-08-12, implemented).** The node parked
at the original Q&A, in its agreed constrained-v1 shape: feature edges by
angle threshold (region machinery extracted to engine/three-mesh.ts,
shared with 3D Extrude), uniform width, `segments`, and the
**`float_curve` profile** (flat-1 = round, flat-0 = chamfer, dips =
grooves; t=0/1 pinned to the surfaces). Construction: per-region tangent
INSET (mitered at region corners, clamped; open-mesh boundaries don't
bevel) → per-edge ARC STRIPS blending chord→arc by the profile, where
the arc is the circle TANGENT TO BOTH FACES at their inset points
(center C = P + (a+b)/(1+â·b̂) — sweeping around the edge point itself
scoops inward, a bug the signed-volume smoke caught as round measuring
LESS than chamfer) → corner holes (≥3 features) ordered by region
adjacency and triangulated FROM THEIR OWN RIM (an invented apex must sit
exactly on the missing sphere octant or it dents — the centroid apex
measurably wound all corner tris inward; rim fans can't dent; spherical
corner grids are the known upgrade). Winding is self-correcting per
triangle (flat-vs-smooth normal comparison). Width clamps at 45% of the
shortest CORNER-ADJACENT feature edge only (clamping on all feature
edges would cap a 48-segment cylinder rim's bevel at one segment
length). Known v1 traits: mitered ends swell the edge radius slightly
toward corners (still face-tangent and inside the silhouette — cube
volume converges just above the constant-radius analytic), smooth-shaded
strips, UVs zeroed on new faces. Verified: manifold (every edge used
exactly 2×), zero inward triangles, chamfer < round volume, monotone
segment refinement, cylinder rim shoulder matches the tangent-arc
analytic, sphere passthrough. Per-edge selection stays future work (§8).

**M9 — light gizmos (owner ask, 2026-08-13, implemented).** Blender-style
viewport representation of the selected light
(components/effects/light-gizmo.ts, mounted in Scene3DViewport's HELPERS
scene — the second render pass, so it can never leak into the rendered
image, same guarantee as the transform gizmo). Synced per frame from the
live three.Light that the selection's TransformControls already resolves
by nodeId — zero new props/plumbing. Conventions: point = orange center
dot + two concentric dashed rings, billboarded and screen-constant
(scaled by camera distance); directional = icon + dashed aim line to the
light's target (world origin) ending in a yellow interest dot; spot =
those + the cone outline (4 side lines + base rim; length = `distance`,
or the aim distance when ∞, so the rim lands where the light does);
ambient = hidden. All materials depth-test-off (editor affordances read
over geometry). Dash spacing is in pre-scale local units, so ring dashes
stay screen-constant and the aim line keeps a fixed dash count. Headless
smoke pins visibility branching, billboarding, screen scaling, aim/target
placement, and the cone's tan(angle)·length math.

**M10 — 3D Spline (owner ask, 2026-08-13, implemented).**
Viewport-authored 3D curve with per-point transform controls:

- **Node** (nodes/three/spline-3d.ts): Catmull-Rom through world-space
  control points (`points` — a new `vec3_list` ParamType: viewport-only
  like spline_anchors, hidden from the panel, plain-JSON, not keyframable
  — the whitelist in keyframes.ts makes new types safe by default).
  Params: closed / tension / tube radius / radial segments / resolution /
  sample count. Outputs: `geometry` (TubeGeometry along the curve) + aux
  `path_points` (`points3d` sampled evenly, curve TANGENTS in the normals
  channel — Copy to Points' align-to-normal orients copies along the
  path; Project to Screen tracks the curve in 2D). Smooth-through-points
  is the v1 authoring model; per-anchor bezier handles (two more gizmos
  per point) are the recorded follow-up.
- **Editing rig** (Scene3DViewport): each point renders as a pickable
  screen-constant billboarded dot + a dashed control polyline, in the
  HELPERS scene (never in the render). Click a dot → it takes the ONE
  shared TransformControls (forced translate; the node-gizmo path guards
  against detaching spline dots, and restores the toolbar's mode when a
  normal node reattaches); drags write the whole points array through
  onParamChange with the per-gesture coalesce key (one undo per drag).
  Mid-drag the dot is the source of truth (prop echo skipped). +/− HUD
  pills insert-after-selected (midpoint toward the next point) and
  remove (min 2). Selection is keyed to the node id — switching nodes
  derives to none, no reset effect (the React-19 hooks rules disallow
  new render-time ref writes and setState-in-effect; new ref mirrors
  sync in an every-render effect instead — rAF reads tolerate the
  one-frame staleness).
- EffectsApp passes `splineNodeId`/`splinePoints` when the selection is a
  spline-3d (falling back to the exported SPLINE3D_DEFAULT_POINTS).

**M10.5 — Bezier Path + rig ergonomics (owner ask, 2026-08-13,
implemented).**

- **3D Bezier Path** (nodes/three/bezier-path-3d.ts): the pen tool's 3D
  cousin — cubic bezier chain with per-anchor in/out handles, all
  viewport-edited. Data model: the SAME `vec3_list` param with a
  STRIDE-3 convention ([anchor, in, out] per point, world-space
  ABSOLUTE) — every entry stays a plain draggable vec3, which is what
  lets ONE editing rig serve both curve nodes; the anchor-carries-
  handles rule lives in the rig's write-back (companion entries offset
  by the anchor's delta, computed against one snapshot so repeated
  objectChange events stay self-consistent). Curve = CubicBezierCurve3
  chain in a CurvePath (closed adds the wrap segment); tube + tangent
  path-points via the extracted shared builder
  (nodes/three/curve-tube.ts — spline-3d refactored onto it,
  regression-checked). First anchor's in / last's out are inert on open
  paths, engage when Closed.
- **Rig ergonomics**: click targets are now invisible hit discs ~2.3×
  the visible dot (the visible dot rides as a child; raycast is
  non-recursive against the discs); hover shows a pointer cursor +
  1.3× white highlight (rAF-rendered via a ref — no React state), idle
  only (suppressed mid-orbit/mid-drag). Bezier mode styles by
  index % 3 — anchors large/gray, handles smaller/sky-blue with
  anchor→handle tether lines (rebuilt per frame); the dashed polyline
  is points-mode-only. HUD +/− operates on whole triples in bezier
  mode (insert-after-selected at the segment midpoint with tangent
  handles, or extend past the end; remove keeps ≥ 2 anchors).

**M10.6 — unified curve node + mirrored handles (owner ask, 2026-08-14,
implemented).** 3D Spline is ONE node with a smooth/bezier `mode` (header
dropdown) instead of two nodes. The design that makes the switch safe:

- **Split-array storage** — `points` stays the plain anchor list (M10
  saves load unchanged; mode defaults to smooth) and bezier handles live
  in a second hidden vec3_list `handles` ([in0, out0, …] flat,
  world-absolute). No stride ambiguity, no conversion on mode flip.
- **Lossless smooth→bezier** — missing/mismatched handles are
  synthesized from the Catmull-Rom tangents ((next − prev)/6 — on closed
  curves the EXACT tension-0.5 CR→bezier conversion, smoke-pinned to
  match; endpoint-clamped on open ones). EffectsApp materializes the
  effective handles for the rig via the exported helper so dots always
  sit on the rendered curve; the rig writes the full array on first
  handle edit.
- **`handle_mode` mirrored/free** (default mirrored, rig-enforced):
  dragging a handle reflects its partner across the anchor (2·anchor −
  pos); free leaves the partner alone. Compute never reads it.
- **Rig protocol** — dot indices: anchors < n, handles at n + 2g (+1 for
  out). Anchor drags write both params under one coalesce key (single
  undo); +/− resolves a selected handle to its anchor and edits both
  arrays. `bezier-path-3d` (the one-day-old separate node) is
  registered-hidden back-compat — computes, no viewport editing.

**M11 — curve primitives + the `curve3d` type (owner ask, 2026-08-14,
implemented).** The socket type the Sweep backlog was waiting on, born
from "make Points on Path work in 3D":

- **`curve3d`** — a 3D curve as pure CPU data (Curve3DValue: the unified
  spline-3d model — anchors + optional bezier handles + closed/tension,
  world-space). ONE interpreter, `curveFromValue` (curve-tube.ts), so
  bezier-vs-smooth semantics can't drift between producers and
  consumers. No coercions. Color: spline's cyan shifted deeper (the
  points/points3d family treatment).
- **Producers**: 3D Spline grows a `curve` aux (compute refactored to
  build the descriptor first, then interpret — tube and consumers read
  the identical curve). New **3D Rectangle / Circle / Polygon**
  (nodes/three/curve-primitives.ts, one factory): parametric closed
  curves in the local XY plane, standard TRS params baked into
  WORLD-space curve coordinates at compute (gizmo places them; consumers
  never see a transform). Straight edges = bezier with zero-length
  handles; circle = 4-anchor kappa bezier (<0.1% radial error,
  smoke-pinned). Each emits the family triple: tube geometry primary +
  `curve` + `path_points` aux. Spiral/star/arc extend the factory later.
- **Points on Path polymorphic** (the sixth in-place upgrade):
  `path` accepts `curve3d`, output retypes to `points3d`; count /
  animate+offset (the sliding stream — now along 3D curves) / align all
  apply, with align ≠ off putting curve TANGENTS in the normals channel.
  The 2D-only auxes (positions UV, viz) stay empty on a 3D input
  (resolveAuxOutputs can't see connectedTypes — acceptable).

**M12 — Align to Camera (owner ask, 2026-08-14; reworked to render-time
same day after "doesn't update live").** Per-copy billboarding as an
INSTANCES-domain node (the owner weighed points-level vs instances-level;
instances won because copies carry full quaternions — points only have
the normals channel, which belongs to surface data — and it composes
with any instances source, Array included, leaving
positions/scales/colors untouched per §4.4).

The v1 BAKED orientations from the camera descriptor at eval time — so
billboards only moved when the camera NODE's params changed, and never
tracked the orbit viewport. The fix moves billboarding to RENDER TIME:
the node is a MARKER (`InstancesValue.billboard = {mode, face,
camera?}`), the instances resolver stashes it on the InstancedMesh, and
`applyInstanceBillboards` (three-geometry.ts) rewrites instance matrices
before every render — Scene Render calls it with the render camera,
Scene3DViewport with the live editor camera each rAF. Camera input
semantics (owner's intelligibility point): UNWIRED = face whichever
camera is rendering (live everywhere — the default you want); WIRED =
pinned to that camera's position (explicit in the graph; animates
through the fingerprint chain; lets billboards face camera A while
camera B renders). Modes: full (spherical) / y-locked (cylindrical, no
tipping) via Object3D.lookAt's non-camera construction; `face` = +Z (a
Plane's facing side) or +Y (Copy's align-to-normal axis). Realize
Instances ignores the marker (billboarding is a render effect, not
geometry). Apply cost is O(copies) matrix composes per render with
module-scope scratch — no allocation. Smoke pins live re-facing on
camera moves, all modes, the pinned-camera path, and array sharing.

**M13 — Owner batch (2026-08-16): weights, ramps, lineart, bump,
import-as-geometry, auto-slots.** Seven asks landed in one pass, all
gates green, 26-assertion smoke (`smoke-3d-batch2.mts`):

- **Overlays-toggle bug**: the app's gizmo toggle unmounted
  Scene3DViewport entirely, killing orbit/pan. The viewport now stays
  mounted whenever a 3D node is active; the toggle rides in as
  `showOverlays` and hides every VISUAL (grid/axes pass, light gizmo,
  transform gizmo — detached so its invisible handles can't swallow
  drags — spline rig, toolbars, teal border) while the input layer
  keeps navigating.
- **Instance Transform after Align to Camera** now composes: the
  billboard marker snapshots `baseQuats` (the quaternion array as of
  Align); §4.4 copy-on-write means a downstream rotation shows up as a
  REPLACED array, and `applyInstanceBillboards` applies the per-copy
  delta (`bbQ ⊗ base⁻¹ ⊗ now`) in the billboarded frame — a Z-spin
  spins cards in the view plane while they keep facing the camera
  (smoke-pinned both ways). Offsets/scales after Align already flowed
  (the apply reads the final stream's arrays).
- **Instance Transform image weight**: `image` input (Cursor is the
  motivating wire) samples luminance at each copy's position through
  the Instance Color planar mapping (`plane` xz/xy + `plane_size`,
  ≤256px identity-cached readback). Noise AND image wired ⇒ weights
  multiply; `centered` applies to the combined spatial weight; the
  index-based Weight-by modes hide when either is wired.
- **Instance Color gradient rework** (owner: "world space with X Y Z
  rotation control", "ramp ui + ramp input"): gradient mode projects
  copy positions onto +Y rotated by rot X/Y/Z, auto-normalized over the
  cloud's extent, colored through a `color_ramp` PARAM (stop editor on
  the node; a wired Color Ramp `ramp` output overrides it via the
  standard param-wire path) + `ramp_interp`. Ramp bakes to a 256-entry
  LUT per eval (the CPU sampler re-sorts stops per call). Colors sRGB→
  linear like the image path. Index gradient retired; A/B stays for
  solid/random.
- **Material lineart** (toggle + technique with the perf/quality
  tradeoff the owner asked for): `MaterialDesc.lineart {technique,
  color, thickness, opacity, angle}`, realized at the object3d boundary
  as EXTRA retained children — never material props. `fast` = inverted
  hull (BackSide MeshBasicMaterial, vertex pushed along object-space
  normal via onBeforeCompile — pre-instanceMatrix, so instanced copies
  outline correctly); `quality` adds crease LineSegments from
  EdgesGeometry at the angle threshold (hairline; meshes only).
  Instanced hulls are child InstancedMeshes SHARING the base
  instanceMatrix attribute — billboard rewrites carry the outline for
  free.
- **Bump node** (`bump-3d`): flow-through `geometry → geometry`,
  writes `MaterialDesc.bump {map, strength, mode: bump|normal}` →
  bumpMap/bumpScale or normalMap/normalScale in applyDesc (all four
  material classes). Material's desc rebuild carries `bump` through,
  so the two nodes chain in either order.
- **Toon bands = a color ramp** (owner follow-up, 2026-08-17): the
  `toon_steps` scalar retired for `toon_ramp` (color_ramp param — stop
  editor on the node, wire a Color Ramp `ramp` output to share a
  palette) + `toon_interp` defaulting to CONSTANT (hard bands;
  linear/ease melt them into painterly gradients).
  `MaterialDesc.toonRamp {stops, interp}`; the resolver bakes 256
  texels via the shared CPU ramp sampler, stops converted sRGB→linear
  (gradientMap has no colorspace decode and lighting is linear),
  NearestFilter for constant so edges stay razor. Default = 3 bands
  black / #bcbcbc / white at 0 / ⅓ / ⅔ — #bcbcbc is linear-0.5, pixel
  parity with the retired grayscale default. Stop alpha ignored (it's
  an irradiance ramp). Cached per material keyed on serialized stops;
  smoke `smoke-3d-toon-ramp.mts` (15 assertions) pins bands, tinted
  multi-stop, filters, linear-light conversion, and cache keying.
- **Import 3D → geometry out** (owner call) + **STL** + **drag-drop**:
  the node now merges every mesh in the file (world transforms baked,
  attribute sets normalized to position/normal/uv) into ONE
  BufferGeometry and emits a GeometryValue — imports enter the
  modeling chain (Bevel/Material/Scatter/Copy). First standard
  material's scalars seed slot 0 (embedded textures can't cross the
  context boundary — Material node for full control). Old object3d
  wires keep working via the geometry→object3d coercion. STLLoader
  added (`model_file.format` +"stl"); dropping .glb/.gltf/.obj/.stl on
  the node editor spawns a pre-loaded Import 3D (detectFileKind
  "model" → `model` param, named like image/video drops).
- **3D Scene auto-slots**: `resolveInputs` keeps one empty object slot
  past the highest wired one (floor 4, cap 16); compute scans to the
  cap. `scene-render` joined CONNECTED_TYPE_RETYPE_NODES so the
  edges-keyed resync rewrites the socket LIST as wires land/leave.

**M5 — Polish + docs.** Peek/inspector summaries for both types, docs
pages (socket legend + node pages), devguide + this-spec status updates,
perf sanity via the bench harness (scatter/copy at 2k instances). Then the
**basic-3D-nodes brainstorm** (§8 seeds it) as its own Q&A.

Order fixed by dependency only at M1; M2–M4 can reorder if appetite
shifts. Each milestone lands green on the TESTING.md gates.

---

## 8. Backlog (seeded for the brainstorm — not committed)

Deferred from this Q&A: **Bevel** (half-edge structure; segments +
`float_curve` profile; per-edge selection), **Extrude Spline** (spline →
geometry, the original marquee 2D→3D bridge), scatter density inputs,
Copy-to-Points variant picking (groupIndex parity with 2D), camera-mode
texture projection, wireable `material` values.

Original-spec carryovers: Transform 3D node + 3D gizmo, viewport
pick↔select, Lathe, Subdivide, Displace (image→geometry), Spot/Area/Env
lights + HDR/IBL, AOVs (depth/normal/mattes — the path-(A) trigger),
Text 3D, Boolean (manifold-3d wasm?), Wireframe/Edges-to-splines
(3D→2D!), Points/point-cloud primitive rendering, drive-camera-from-view.

---

## 9. Devguide updates on ship

Repo-map rows for new node files; socket-types section (+2 types, the
points3d space rule beside the authored-space invariant — state it as
"points = authored, points3d = world Y-up, the TYPE is the space tag");
coercion list (+geometry→object3d); the §1.2 mutate-vs-copy rule under
Caching; Combine/Scene Merge note; the §6.2 texture-bridge cost note.
