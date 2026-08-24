# GLB scene import — autoparse to a node group

Spec — 2026-08-16. Status: **implemented 2026-08-17** (M0–M4 in one
pass; M3 folded into M1/M2 since the fragment builder is one module).
Gates green: typecheck, `npm run check` (incl. the new
`check-model-group`), lint ratchet. **Open item: the M4 live-app
textured-GLB pass (UV orientation) has not been run yet** — do that
before trusting extracted base-color maps. Deviations from this spec as
written:

- The scene index + expansion rule live in **engine/model-cache.ts**,
  not `lib/model-scene-index.ts` — the engine must stay self-contained,
  the cache already owns the only parse, and the loader consults
  `shouldExpandModel` at parse time to decide whether base-color bitmaps
  are worth extracting before the raw scene is disposed.
  `state/model-group-fragment.ts` re-exports the rule so editor code and
  the check script read builder + rule from one module.
- `releaseModel` defers disposal by an **8s grace period**: the
  expansion holds a temporary editor token and the inserted nodes only
  acquire on their first eval; delete→undo within a beat shouldn't
  re-parse. Base-color bitmaps are handed to the expansion **take-once**
  (`takeModelBaseColorMaps`) so entry disposal never closes pixels the
  graph owns.
- A pick that does NOT expand resets a stale `"top:<i>"` `object`
  selection to `""` (new file, old sub-object indices are meaningless),
  riding the model-change undo entry.

Decisions from the design Q&A at the bottom.

One sentence: STL/OBJ keep importing as a single merged `geometry`
(today's behavior); a GLB/glTF whose scene contains more than one object —
multiple meshes, or any lights/cameras — auto-expands into a **node
group** whose interior is real, editable nodes (one Import 3D per
top-level object, Light and Camera nodes with baked params, extracted
base-color textures wired through Material nodes) and whose group output
sockets carry each of them by name.

## Why

[import-3d.ts](../src/nodes/three/import-3d.ts) (2026-08-16 rework)
merges every mesh in the file into ONE BufferGeometry with world
transforms baked, seeds material slot 0 from the *first* standard
material found anywhere in the scene, and silently drops lights and
cameras. That's right for STL/OBJ (a bare shell of geometry) and wrong
for GLB, which is a *scene container*: a Blender export arrives with its
object list, per-object materials, its lighting rig, and its camera —
and today all of that collapses into one grey-ish lump.

The user-facing behavior we want: drop a GLB, get a group node named
after the file with `Body`, `Wheels`, `Key Light`, `Camera` sockets —
each mesh independently materialable/scatterable/animatable, the lights
and camera wired straight into Scene Render if you want the file's own
framing. Tab dives in; everything inside is ordinary nodes.

## Load-bearing precedents (all shipped)

- **Programmatic groups**: [group-fragment.ts](../src/state/group-fragment.ts)
  (`groupFragment`) assembles a node-group + boundary nodes structurally
  identical to Cmd+G, and EffectsApp's preset branch inserts the fragment
  via `cloneSubgraph` (fresh ids, scope retarget, root auto-layer-wrap).
  The expansion is "a preset computed from the file at drop time."
- **Dynamic per-file dropdown**: the EXR layer picker
  ([image-source.ts](../src/nodes/source/image-source.ts), `control:
  "exr_layer"`, `options: []`) reads its options off the loaded param
  value. The per-object picker on Import 3D is the same shape.
- **Async load → `pipeline-bump`** re-eval, and `fingerprintExtras`
  keying on url + load state: already in import-3d, carries over.
- **Material plumbing**: `geometry` carries material slots; the Material
  node's `base_color_map` image input overrides the texture channel; the
  engine→three texture crossing lives in three-geometry.ts (081026 §6.2).
- **Drop path**: EffectsApp `onAddFileNode` `kind === "model"` already
  builds the `ModelFileParamValue` and spawns the node.

## §1 Engine — per-object selection + shared model cache (M0)

**`object` param on import-3d.** New param `object` (string, default
`""`). `""` = merge the whole scene (today's behavior, and all STL/OBJ
ever use). `"top:<index>"` = merge only the subtree of that top-level
child of the scene root. Control is a new `model_object` dropdown
(EXR-layer-picker pattern) listing the loaded file's top-level objects;
hidden until a multi-object GLB is loaded.

**Per-object merge is LOCAL-frame.** The subtree merges with transforms
baked *relative to the top-level object's frame*, and the expansion
(§3) writes the object's decomposed world TRS into the node's existing
pos/rot/scale params. So each object lands where the file put it AND
stays movable/keyframable/gizmo-editable from that pose — the carried-
transform contract the primitives already follow. Non-decomposable
matrices (shear) fall back to world-frame baking with default params
(flagged in the scene index; rare). Whole-scene merge (`""`) keeps
world-frame baking exactly as today.

**Per-object material seed.** The subtree's first standard material
seeds slot 0 (scalars: base color / roughness / metalness) — an upgrade
even before grouping, since today the file-global first material wins.

**Shared refcounted model cache.** N interior nodes reference the same
URL; parsing N times (and retaining N copies of a 50 MB scene) is not
acceptable. Loading moves from per-node `ctx.state` to a module-level
cache keyed by URL: one parse → a `ParsedModel` (scene index + lazily
merged per-object geometries + whole-scene merge + extracted bitmaps).
Nodes acquire/release on first use / `dispose`; geometries dispose when
the refcount hits zero. `fingerprintExtras` becomes
`url : object : loadedFlag`.

## §2 Pure seam — scene index + fragment builder (M1)

Two modules so the graph-building logic is checkable offline (the
`npm run check` scripts stub DOM/GL — three parsing can't run there,
synthetic indexes can):

- **`src/lib/model-scene-index.ts`** — three scene → plain
  `SceneIndex`: `topObjects[{ index, name, meshCount,
  material { baseColor, roughness, metalness, hasBaseColorTex },
  trs | null /* shear fallback */ }]`, `lights[{ type, color,
  intensity, position, target }]` (KHR_lights_punctual via GLTFLoader),
  `cameras[{ projection, fov, near, far, position, target }]`. No GL,
  no bitmaps. Also the home of the **expansion rule**:
  `shouldExpand(index)` ⇔ format is glb/gltf AND (mesh-bearing
  topObjects > 1 OR lights ≥ 1 OR cameras ≥ 1).
- **`src/state/model-group-fragment.ts`** — `SceneIndex` (+ the shared
  `ModelFileParamValue` + optional extracted bitmaps) → `groupFragment`
  input: interior nodes, edges, `GroupOutputSpec[]`. Socket names =
  sanitized GLB object names, deduped (`Body`, `Body 2`), fallbacks
  `Mesh <i>` / `Light <i>` / `Camera <i>`. Mesh sockets are `geometry`,
  lights `object3d`, cameras `camera`.

Guard: **`scripts/check-model-group.mts`** over synthetic indexes —
expansion rule (single-mesh GLB stays plain; lights-only expands), name
dedup/sanitize, per-object node params (object token + baked TRS), the
shear fallback, material-chain wiring when `hasBaseColorTex`, and
fragment→`groupFragment` structural sanity (every output spec resolves
to an interior handle).

## §3 Editor — auto-expansion (M2)

- **Drop path** (`onAddFileNode`): for glb/gltf, parse first (dynamic
  import of GLTFLoader, editor-side), then either spawn the plain node
  (no expansion) or build the fragment and insert it through the
  existing preset branch (`cloneSubgraph` + compositionId re-tag),
  group named after the file. All interior import nodes share the
  *identical* `ModelFileParamValue` object — one URL, one cache entry.
- **Pick path** (Load Model on an existing node): on param commit the
  editor parses; if `shouldExpand`, the node is **converted in place** —
  replaced by the group at its position (one undo snapshot). Existing
  `out:primary` wires re-land on the group's first geometry socket
  (the least-wrong default; the user re-targets from the named sockets).
  Needs a small hook from the model param commit up to EffectsApp — the
  `effect-node-param` event route already crosses that boundary.
- **Interior layout**: meshes in a column at x=0, their Material chains
  (§5) to the right, lights/cameras in a column below, Group Output at
  the far right — same fixed-grid authoring style as presets.ts.

## §4 Lights & cameras (M3)

- **Light node gains target params** (additive): `target_x/y/z`,
  default 0, visible for directional/spot. Compute sets
  `light.target.position` and calls `light.target.updateMatrixWorld()`
  — the target is parentless, so its world matrix is exactly its local
  one; nothing else updates it. Defaults preserve today's aim-at-origin
  behavior for existing projects (no migration).
- **GLB lights** (KHR_lights_punctual): directional/point/spot map to
  the Light node's types; color/intensity/world-position bake into
  params; direction bakes as `target = position + worldForward`.
  Intensity units differ (candela/lux vs three's arbitrary scale) —
  bake the raw value, note it in the node description, let the user
  trim. GLBs carry no ambient; none is created.
- **GLB cameras**: projection/fov/near/far/world-position bake
  directly; the Camera node is look-at, so `target = position +
  worldForward × |position|` (falling back to 5 when the camera sits at
  the origin). DOF stays off.

## §5 Base-color textures (M4)

For each top-level object whose seed material carries a baseColor map:
extract `texture.image` → `createImageBitmap(img, { premultiplyAlpha:
"none" })` (the straight-alpha invariant — devguide § alpha), spawn an
Image Source node holding the bitmap (fileName chip `<object> basecolor`),
a Material node seeded with the object's scalars, wire
`image-source → material.base_color_map`, and route the mesh through it:
`import (object) → material → group output`. Objects without a texture
get no Material node — the import node's slot-0 seed already covers
scalars.

Notes / risks:

- **UV orientation must be verified live.** glTF UVs are top-left origin
  (GLTFLoader sets `flipY = false` on its own textures); the engine's
  crossing in three-geometry.ts uploads engine textures under its own
  conventions. Expect one flip to be needed somewhere — this is exactly
  the class of bug TESTING.md says stubbed checks can't see. Gate: a
  textured GLB in the live app before calling M4 done.
- **Color space**: baseColor is sRGB; the engine has no managed working
  space — hand pixels over untransformed, same as any PNG import.
- **Save size**: extracted bitmaps have no original encoded bytes, so
  the image inline path falls back to PNG re-encode on save. Acceptable;
  the R2 asset work (below) subsumes it later.

## §6 Persistence — explicitly out of scope

Model files don't survive save today (`ModelFileParamValue.url` is
stripped; re-pick on load). That is being solved by the **parallel R2
storage spec**, not here. Contract this feature keeps so the two
compose: every interior node referencing a file holds the *same*
`ModelFileParamValue` (same filename/URL), and the engine cache dedupes
by URL — so whatever per-file rehydration R2 lands (one asset, one
fetch) heals every referencing node at once, groups included.

## Milestones

- **M0** — engine: shared refcounted model cache; `object` param +
  `model_object` picker control; per-object local-frame merge +
  per-object material seed. Plain/whole-file behavior byte-identical.
- **M1** — pure seam: `model-scene-index.ts`, `model-group-fragment.ts`,
  `scripts/check-model-group.mts` in the `npm run check` roster.
- **M2** — editor: drop-path expansion, pick-path in-place conversion
  (first-socket rewire), naming, layout.
- **M3** — lights (+ Light target params) and cameras.
- **M4** — base-color texture extraction + Material wiring (live-app UV
  verification is part of the milestone).

Each milestone ships alone; M0/M1 are pure improvement even if M2 never
lands. Devguide (§ nodes, socket types are untouched — this is all
existing types) and the Import 3D node description update with M2.

## Gates

`npm run typecheck && npm run check` (new check script included) per
TESTING.md; M4 additionally requires a textured-GLB pass in the live
app (texture orientation is invisible to the stubbed checks).

## Decisions (design Q&A, 2026-08-16)

1. **Trigger**: auto-expand when the GLB is multi-object (>1 mesh-
   bearing top-level object, or any lights/cameras); single-bare-mesh
   GLBs stay a plain Import 3D node; STL/OBJ always plain. Applies to
   both drop and pick-into-node.
2. **Granularity**: split at **top-level objects** (subtrees merged) —
   matches the Blender object-list mental model; no per-leaf-mesh
   explosion.
3. **Materials**: per-object scalar PBR **plus extracted baseColor
   textures** wired through Material nodes. Roughness/metalness/alpha
   maps are backlog.
4. **Persistence**: deferred to the parallel R2 storage spec (§6).
