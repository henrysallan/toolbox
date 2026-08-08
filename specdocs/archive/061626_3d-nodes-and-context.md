# 3D Nodes & the 3D Context — Proposal

A working spec for adding a 3D node family and a 3D rendering context to
Toolbox, backed by three.js. Written with the owner across a design Q&A
(2026-06-16). Status: **design agreed, not yet implemented.** Render bridge
decided: **separate three.js context + GPU canvas upload (path B), 8-bit
beauty, no AOVs in v1** — see §4. This removes the risky shared-context GL
work; Milestone 0 is now a low-stakes integration spike.

Read [061226_devguide.md](../061226_devguide.md) first. This spec assumes the
engine model described there (full-canvas RGBA16F textures, the flatten
pass, the layer/group machinery, the fingerprint cache, offline-settle).

---

## 1. The vision

A new family of nodes that build and render 3D scenes:

- **Geometry**: primitives (Cube, Sphere, Plane, Cylinder, Cone, Torus,
  Points), importers (GLB/glTF, FBX, OBJ), modeling ops (Extrude, Bevel,
  Subdivide, later Boolean/Remesh/Displace), instancing (Scatter, Copy to
  Points).
- **Scene objects**: Lights (Point/Directional/Spot/Area/Env), Cameras,
  Materials.
- The **whole scene lives in the graph**. The viewport shows a live
  three.js scene instead of the 2D preview canvas when a 3D node is
  selected, with orbit/pan/zoom, overlay toggles (grid, axes), and a 3D
  transform gizmo.
- **2D↔3D interop**: build a shader/texture in the 2D context, pipe it
  into a Material; render the scene to an image and pipe that back into 2D
  post-processing. (Render passes / AOVs — depth, normal, mattes — are a
  post-v1 add; see §8.)

The hard question this spec answers: **in 2D everything converges to one
image stream, so "what's active" is obvious. In 3D the scene is
heterogeneous — geometry, lights, cameras, materials — so what defines the
scene and what contributes to it?** The answer is a *convergent dataflow*
that reuses machinery we already have.

---


## 2. Core decision: a convergent 3D context, not an ambient scene

The scene is **convergent like the 2D graph**, just with new socket types.
Everything that contributes to the render flows into a **Scene Output**
node. Then:

> **What's in the scene = what reaches Scene Output.**

This is the whole trick. `computeNeededSet`
([evaluator.ts:246-296](../../src/engine/evaluator.ts#L246-L296)) already
walks backward from the terminal and prunes disconnected branches. Point
that walk at Scene Output and "what's active / what contributes" falls out
**for free**, using the exact mechanism the 2D graph uses. No new "active
scene" concept is invented. Lights and cameras aren't special — they
contribute *because they reach Scene Output*, same as geometry.

### Contexts nest; boundary nodes convert

A **context** is defined by (a) which socket types are legal inside it and
(b) what boundary nodes convert at its edges. Contexts nest:

```
2D root  ⊃  [3D context]  ⊃  [2D material context]  ⊃  …
            ↑ Scene In/Out    ↑ Material In/Out
            (boundary nodes = context transitions)
```

- **2D root** is the document. Speaks `image`/`mask`/`scalar`/`spline`/…
  and ultimately an Output node's image. This stays the parent context.
- A **3D context** speaks the new 3D socket types (below) and converts to
  image(s) at its Scene Output boundary.
- A **material** is a 2D context *inside* 3D — dive into a Material node
  and you're authoring a 2D shader graph whose outputs bind to material
  channels.

Context-agnostic CPU values (`scalar`, `vec*`, `spline`, `points`,
`image`) are legal raw material in *both* — a scalar drives extrude depth,
a spline becomes an extrude profile, a points set drives scatter, an image
becomes a texture. The boundary only gates the **3D-only** types and the
render conversion.

---

## 3. Engine prerequisites

### 3.1 New socket types

```ts
// engine/types.ts — SocketType union
export type SocketType = …
  | "geometry"   // mesh data + material slot(s) + a local transform
  | "object3d"   // a placed scene object: mesh / light / camera / group
  | "material"   // a resolved material descriptor (output of a 2D ctx)
  | "camera";    // a camera descriptor (projection + transform)
```

Four new types. Per **invariant #7** (devguide §Invariants) a SocketType
addition ripples through: `types.ts` (union + `SocketValue`),
`coerce.ts`, `socketColor.ts`, NodeEditor validation (`canCoerce` /
`isValidConnection`, ×2 places), `clips.ts` `emptyClipOutput`, and the
docs/colors legend. Resist the temptation to add one type per thing —
**lights stay `object3d`** (kind-tagged); only `camera` earns its own type
because the renderer selects it distinctly.

### 3.2 Value representations (runtime-only, retained-backed)

Like `sdf` / `element` / `particles`, these are **runtime-only values —
never serialized**. The persistent state is the producing node's params
(primitive dims, transform, material channels, import file handle). The
fingerprint chain handles invalidation; values carry GPU/CPU handles whose
lifetime matches the producing node's cache entry.

```ts
// Geometry: CPU descriptor of mesh data, plus material assignment(s) and a
// local transform. Backed by a retained three.BufferGeometry keyed on the
// producing nodeId (see §3.3 reconciliation) — the value holds a handle,
// not raw buffers re-uploaded every frame.
export type GeometryValue = {
  kind: "geometry";
  source: GeometryHandle;          // retained BufferGeometry ref + build sig
  transform: Transform3D;          // TRS folded as nodes chain
  // Material slots. v1 fills slot 0; multi-slot is ready from day one so an
  // imported GLB's N materials and per-part overrides cost nothing later.
  materials: (MaterialValue | null)[];
  groups?: { start: number; count: number; slot: number }[]; // submesh→slot
};

// Object3D: a placed thing in the scene. Kind-tags meshes/lights/groups.
export type Object3DValue = {
  kind: "object3d";
  node: Object3DHandle;            // retained three.Object3D ref
  variant: "mesh" | "light" | "group" | "instanced";
};

export type MaterialValue = {
  kind: "material";
  // Resolved PBR channels. Each channel is a constant OR a 2D image
  // (the output of the material's interior 2D context).
  basecolor: ImageValue | [number, number, number, number];
  metalness: ImageValue | number;
  roughness: ImageValue | number;
  normal?: ImageValue;
  emissive?: ImageValue | [number, number, number];
  opacity?: ImageValue | number;
  sig: string;                     // fingerprint of resolved channels
};

export type CameraValue = {
  kind: "camera";
  projection: "perspective" | "orthographic";
  fov: number; near: number; far: number; ortho?: { height: number };
  transform: Transform3D;
};
```

`Transform3D` is the standard TRS (position vec3, quaternion or euler,
scale vec3). Transform nodes fold onto it; Scatter/Copy-to-Points bake
per-instance transforms into an InstancedMesh.

### 3.3 Retained scene + reconciliation (the perf model)

Pure dataflow would rebuild three objects every eval — too slow. The fix
slots into the existing model: **dataflow produces descriptors; a
reconciler keyed on `nodeId` diffs them against retained three objects
held in `ctx.state["3d:<nodeId>"]`** (React-reconciliation style).

The fingerprint cache already returns the *same value-object identity* on a
cache hit (devguide §Caching), so "this node didn't change" is free —
reconciliation only touches nodes whose fingerprint moved. Retained
objects are torn down in `dispose(ctx, nodeId)`.

Bonus: nodeId-tagged three objects (`object3d.userData.nodeId`) give
**viewport-pick ↔ graph-select** bidirectionally, and let the gizmo find
the three object for a selected node.

### 3.4 The 3D context container — a layer-style computing group

The 3D context is a **layer-style computing container**, not a pure group.
Per the devguide and confirmed in code:

- **Plain groups** ([flatten.ts:82-248](../../src/engine/flatten.ts#L82-L248))
  are dissolved — boundary nodes vanish and wires splice through. They
  never compute.
- **Layers** ([layer.ts:67-115](../../src/nodes/group/layer.ts#L67-L115))
  keep their shell node in the flattened graph and **compute**; the
  flatten pass rewires the interior's result onto a hidden `content` input
  ([flatten.ts:189-211](../../src/engine/flatten.ts#L189-L211)); the interior
  runs on layer-local time
  ([evaluator.ts:447-573](../../src/engine/evaluator.ts#L447-L573)).

The 3D container follows the **layer pattern** with two differences:

1. The hidden rewired inputs are **3D-typed** (`__objects__: object3d`,
   `__camera__: camera`) instead of `content: image`.
2. The container's `compute()` runs a **three.js render** instead of a
   blend, returning `{ primary: image, aux: { depth, normal, … } }`.

Concretely:

| Piece | Mirrors | Behavior |
|---|---|---|
| **3D Scene** container shell | `layer` node | Stays in flattened graph; computes the render. Exterior outputs = beauty image (primary) + AOV aux. Auto-managed (users don't configure it directly). |
| **Scene Input** (interior) | `group-input` ([group-input.ts](../../src/nodes/group/group-input.ts)) | Exterior 2D/scalar/spline/image values → interior outputs. Dissolved; wires splice through. Carries context-agnostic types only. |
| **Scene Output** (interior) | `group-output` but **typed for 3D** | Interior inputs: `objects` (object3d) + `camera` (camera). Render-settings params live here (resolution, AOV toggles, background, tone-map). Flatten rewires its inputs onto the container's hidden inputs. |

The interior 3D nodes evaluate in the **same single flat pass** as
everything else — the evaluator doesn't care about socket types, it just
calls `compute()` and passes values along edges. So the 3D nodes produce
geometry/object3d/material/camera values in topo order; the container's
compute consumes the converged `objects` + `camera` and renders.

**`computeNeededSet` reaches into the interior automatically**: the 2D
Output pulls the container, the container's hidden `__objects__`/
`__camera__` inputs were rewired from Scene Output, so the walk continues
back through the 3D subgraph. Disconnected 3D branches never compute —
exactly the 2D semantics.

### 3.5 The collection problem (many objects, one scene)

A scene with 50 objects must not mean 50 wires into Scene Output. We
already solve this twice — `merge.ts` dynamic sockets and the
`image_group`/`collect.ts` pattern. A **Scene Merge** node (dynamic
`object3d` inputs → one grouped `object3d`) is a direct copy of merge.ts's
dynamic-socket machinery. Scene Output then takes one merged `objects`
input + one `camera`.

---

## 4. The 3D→2D render bridge (Milestone 0 spike)

Scene Output / the container must turn a three scene into engine textures
the 2D pool can sample. The engine owns **one WebGL2 context** with a
strict state contract — `drawFullscreen` hardcodes `disable(DEPTH_TEST)`,
`disable(BLEND)`, a shared VAO, straight (non-premultiplied) alpha, linear
RGBA16F textures ([gl.ts:377-386](../../src/engine/gl.ts#L377-L386)). three.js
clobbers most of that (enables BLEND, depth, scissor, binds its own
FBOs/VAOs/programs). Three candidate paths. **v1 takes (B)** — with AOVs
out of scope (§8) there's no hard need for float, so the isolated-context
path's simplicity and zero state-collision risk win:

**(B) Separate context + canvas-texture upload (CHOSEN for v1).**
three owns its own canvas/context; the engine pulls its result with
`texImage2D(TEXTURE_2D, …, threeCanvas)` into a pool texture — a GPU-side
copy, **no CPU Float32 roundtrip** (the inverse of `blitToGLCanvas`'s
MediaPipe path, [gl.ts:394-438](../../src/engine/gl.ts#L394-L438)). Zero state
collision — three's context and the engine's never touch. Cost: 8-bit
beauty (the canvas drawing buffer is RGBA8, not float), so the 3D render
enters the 16F pipeline at 8-bit and heavy downstream grading/bloom could
band. Acceptable for v1; reversible to (A) later without touching the node
graph.

**(A) Shared context, zero-copy (future upgrade — for HDR beauty or AOVs).**
`new WebGLRenderer({ canvas, context: ctx.gl })` adopts the engine's
context. three renders into a `WebGLRenderTarget` whose `.texture` the
engine samples directly — **no copy**. Wrap every three render in a GL
state save/restore barrier and call `renderer.resetState()` after engine
draws. State to save/restore (from the gl.ts audit): `BLEND`, `DEPTH_TEST`,
`SCISSOR_TEST`, `FRAMEBUFFER_BINDING`, `VERTEX_ARRAY_BINDING`,
`CURRENT_PROGRAM`, `VIEWPORT`, `activeTexture`. Float render target ⇒ keeps
**16F precision** and enables AOVs (depth/normal *require* float). Risk:
state collisions. **Deferred** — only pursue when HDR beauty fidelity or
AOVs justify it; the node graph is unchanged, only the bridge behind Scene
Output swaps.

**(C) Separate context + Float32 readback.** The WebGPU-bridge precedent
([gl.ts:139-226](../../src/engine/gl.ts#L139-L226),
`readImageToFloat32`/`uploadFloat32ToImage`). **Rejected for realtime**: a
1080p RGBA16F readback is ~33 MB/frame, far past the "~1 MB fast"
threshold. Viable only for a small AOV or offline.

---

## 5. Conventions (decide up front — devguide §Coordinate conventions)

The engine is disciplined about coordinates/alpha/color; 3D must declare
its own conventions at the boundary or we'll fight upside-down,
wrong-gamma renders forever.

- **World space**: three-native — **Y-up, right-handed**, CCW front faces.
  Primitives default to ~1 world unit; the editor camera frames the
  origin. (Note the contrast with engine CPU geometry, which is **Y-down**
  normalized — the conversion happens in nodes that bridge 2D→3D, e.g.
  Extrude reading a Y-down spline.)
- **Render target stays linear** (`renderer.outputColorSpace =
  LinearSRGBColorSpace`) to match the RGBA16F pipeline; the 2D context owns
  the view transform / tone-map (or Scene Output exposes an optional
  tonemap param). Textures fed *into* materials are tagged sRGB or linear
  per channel (basecolor sRGB, roughness/normal/metalness linear).
- **Y-flip at the sample boundary**: three's render-target texture is
  Y-up; the engine samples `v_uv` Y-up too, but the orientation of three's
  output vs. the engine's full-canvas convention must be pinned with one
  explicit flip (same discipline as text.ts / marching-squares). Decide
  once, document at the bridge.
- **Straight alpha** out of the render (premultiplied off), to match the
  engine's manual source-over compositing.
- **Aspect**: the render uses the canvas aspect; the camera's aspect is
  driven from `ctx.width/height`.

---

## 6. Materials: flow-through application (decided)

Material is applied by **geometry flowing through** a Material node —
`geometry → [Material] → geometry` — the Houdini Material-SOP model. This
resolves the "where does the material apply if the geo stream splits?"
ambiguity: application is **positional**. Split *after* the Material node ⇒
same material on both branches; split *before* ⇒ different materials per
branch.

Consequences (baked into §3.2):

- **`geometry` carries material slot(s).** The Material node sets slot 0
  (default material if none). The value type holds *multiple* slots from
  day one even though v1 applies to "all" — so an imported GLB's existing
  materials and per-part overrides need no type change later. The Material
  node gets an optional **target** (slot/submesh group, default "all").
- **A Material is a 2D context.** Dive into a Material node → a 2D shader
  graph whose outputs bind to PBR channels (basecolor / metalness /
  roughness / normal / emissive / opacity). This is where "build a 2D
  shader, pipe it into the material" lives. Reuses the image-fill plumbing
  conceptually (an `image` input per channel).
- **Instanceable material networks (deferred).** End-state: the material
  *definition* is referenceable separately from its application point (a
  project-level material asset addressed by id; the flow-through node
  points at one — again the Material-SOP precedent). v1 keeps the network
  **inline** (edit by diving in). The only thing to protect now: don't bake
  the definition into a single node's identity in a way that blocks "two
  nodes reference the same material" later.

---

## 7. Cameras & the viewport

Two distinct camera concepts:

- **Editor/viewport camera** — ephemeral, **not in the graph**. Drives
  orbit/pan/zoom while authoring (Blender's viewport camera).
- **Camera nodes** — real scene cameras wired into Scene Output's `camera`
  input. The "active camera" is unambiguously *the one wired there*.

**Viewport toggle button** (shown when a 3D node is selected): flips
between the editor camera and the active camera (the one piped into Scene
Output's camera input).

- Looking through the active camera is **view-only by default**. Optional
  "drive camera from view" mode writes orbit/pan/zoom back into the Camera
  node's transform params (autokey, same path as the gizmo) — Blender's
  "lock camera to view." Optional, post-v1.
- **No camera wired ⇒ no render** (show a hint), or fall back to the editor
  camera as a convenience — pick during M1.
- Selecting a Camera node draws its **frustum overlay** and puts the gizmo
  on it.

### Viewport interaction & overlays

When a 3D node is selected, the preview shows the live three scene with
orbit/pan/zoom. Contextual viewport HUD buttons: camera toggle, grid
on/off, axes on/off, gizmo mode (translate/rotate/scale). The 3D transform
gizmo drives the selected primitive's / Transform node's TRS params
(the 3D analog of `supportsTransformGizmo` + the 7 standard params —
[types.ts:1026-1028](../../src/engine/types.ts#L1026)). Viewport-pick selects
the corresponding graph node via the nodeId tag (§3.3).

---

## 8. AOVs / render passes (post-v1)

**Cut from v1.** AOVs (depth, normal, position, albedo, per-object mattes
as aux image outputs on Scene Output) are the deep 2D↔3D payoff — pull
depth, do 2D depth-of-field / fog / relighting in the 2D context — but they
need **float precision** (8-bit depth is useless), which forces render path
(A) and its shared-context GL risk (§4). Dropping them is what lets v1 ship
on the simple isolated-context path (B).

The design stays AOV-ready so adding them later is a bridge swap, not a
redesign: Scene Output just grows aux image outputs, gated by
`consumedOutputs` ([types.ts:919-933](../../src/engine/types.ts#L919-L933)) so
an unconsumed AOV costs nothing (the same gate Text uses for its JFA/spline
outputs). The trigger to do the path-(A) work is "we want AOVs" or "8-bit
beauty bands under grading."

---

## 9. Node catalog

**v1 (Milestones 1–3):**

- **Primitives**: Cube/Box, Sphere (UV), Plane, Cylinder, Cone, Torus.
- **Camera**: Camera (perspective/orthographic).
- **Lights**: Point, Directional, Ambient (Spot/Area/Env follow).
- **Material**: Material (PBR, flow-through, 2D-context interior).
- **Transform 3D**: TRS, gizmo.
- **Scene Merge**: dynamic object3d inputs → grouped object3d.
- **Scene Input / Scene Output**: the context boundary.
- **Extrude** (spline → geometry — the headline 2D→3D bridge) + **Lathe**.

**Fast-follow (Milestones 4–5):**

- **Import 3D**: GLB/glTF first, then FBX/OBJ. Async load → `pipeline-bump`
  + offline-settle; source file via media-relink (like video/audio/fonts).
- **Modeling**: Bevel, Subdivide, Displace (image→geometry).
- **Instancing**: Scatter (on surface), Copy to Points (3D points, or 2D
  points → plane) → InstancedMesh-backed object3d.
- **Lights**: Spot, Area, Environment (HDR/IBL).
- **Points / Point Cloud** primitive.
- **AOVs**: depth, normal, mattes (gated by the path-(A) spike).

Categorization (devguide §NodeDefinition): a new top-level menu bucket
likely makes sense (`3d`), or fold under existing `image`/`utility` with a
subcategory — decide when wiring the menu. New node `type` strings are
back-compat-safe (invariant #2); never repurpose an existing one.

---

## 10. Persistence, export, async

- **Values are runtime-only** (§3.2) — no serialization changes for the
  socket values themselves. Node params serialize as usual.
- **Container/group subtype**: the 3D Scene container is a group subtype
  (like layer). The saved group node needs a `subtype: "scene"` (or
  equivalent) flag; check whether this needs a `CURRENT_SCHEMA` bump in
  [project.ts](../../src/lib/project.ts) or rides existing group serialization
  — confirm during M1.
- **Importers** don't serialize their source mesh files → **media-relink**
  ([media-relink.ts](../../src/lib/media-relink.ts)), same flow as video.
- **Export**: the container renders to an image that flows into the 2D
  graph, so image/video export and the live/exported-app pipeline work
  **unchanged** — the 3D context is "just another image source" to the
  root. three's `render()` is synchronous (good for frame-stepped offline
  export); async importers/HDR loads must settle synchronously under
  `ctx.offline` (offline-settle.ts pattern, devguide §Export).
- **Engine self-containment (invariant #1)**: all 3D code lives under
  `src/engine/` + `src/nodes/` (three.js imported there). The export bundle
  copies the engine subtree verbatim, so three.js must be reachable from
  engine-side code only — no leakage into `src/components`/`src/lib`.

---

## 11. Milestones

**M0 — Render-bridge integration spike (low-stakes).** Bring three.js into
engine-side code. Prove path (B): three renders a lit cube on its own
isolated context/canvas; the engine pulls it via
`texImage2D(…, threeCanvas)` into a pool texture; composite it in the 2D
graph and confirm subsequent 2D draws are uncorrupted (they will be —
contexts are isolated). Pin the Y-flip and color handling at the boundary
(§5). Measure the per-frame upload cost. No state-barrier gymnastics; this
de-risks the integration before the node work.

**M1 — The 3D context.** Layer-style container + Scene Input / Scene
Output boundary nodes + flatten rewire of `__objects__`/`__camera__` +
needed-set reaching the interior. One primitive (Cube), one light, one
Camera, beauty render to the container's image output. Live orbit/pan/zoom
viewport when a 3D node is selected. Dive-in/breadcrumb scoping (reuse
group UI).

**M2 — Materials & transforms.** Material flow-through with a 2D-context
interior + PBR channels + image-into-channel. Transform 3D + 3D gizmo +
viewport-pick↔graph-select. More primitives (Sphere/Plane/Cylinder/Cone/
Torus). Scene Merge (dynamic sockets).

**M3 — Modeling & the 2D→3D bridge.** Extrude (spline → geometry) + Lathe —
the marquee interop. Bevel/Subdivide. Import GLB (relink + offline-settle).
Camera frustum overlay, grid/axes overlays.

**M4 — Instancing & AOVs.** Scatter, Copy to Points (InstancedMesh).
Depth/normal/matte AOVs + 2D consumption (gated by M0 path). Spot/Area/Env
lights, HDR/IBL.

**M5 — Polish.** Drive-camera-from-view, export validation across all
tiers, docs page, performance pass on reconciliation.

---

## 12. Open questions / decisions still to make

1. **8-bit beauty acceptance** (path B): confirm in M0 that the 3D render
   at 8-bit holds up under the grading/bloom you actually use. The trigger
   to invest in path (A) is banding here, or wanting AOVs.
2. **Menu bucket**: new top-level `3d` category vs. subcategory under
   existing buckets.
3. **No-camera behavior**: render nothing + hint, or fall back to editor
   camera.
4. **Where geometry becomes object3d**: confirmed light touch — Scene
   Merge/Output auto-wrap raw `geometry` into a mesh with identity
   transform; Transform/Scatter/Copy-to-Points/Light/Camera/Import produce
   `object3d` directly. Users rarely think about the boundary.
5. **Schema bump** for the scene container subtype (§10).
6. **Tone-mapping ownership**: Scene Output param vs. a dedicated 2D node.
