---
name: blender-to-toolbox
description: Translate a Blender geometry-nodes network into a toolbox node graph, using the Blender MCP to read the tree and the toolbox MCP to build it. Use when the user wants to port, convert, translate, or recreate a Blender geometry nodes setup in toolbox, or asks what a .blend's node tree would look like in toolbox.
---

# Blender geometry nodes → toolbox

Read a geometry-node tree out of a live Blender session, translate it, and
build it in a live toolbox editor.

The hard part is **not** the name lookup. It is that Blender geometry nodes is
a *field* system over *mesh domains*, and toolbox is a *uniform-param* system
over *images, 2D points, and instanced 3D geometry*. Most of the work is
deciding what a per-element field collapses into, and being straight about
what does not survive. §"The field problem" is the core of this skill.

## Prerequisites

Both MCP servers must be connected and live:

- **Blender**: the addon panel connected (`get_addon_status`). The .blend
  must be open with the object carrying the Geometry Nodes modifier.
- **toolbox**: the editor paired with `npm run mcp` (`get_status` returns
  project name, canvas size, fps).

If either is down, say so and stop — there is nothing useful to do blind.

## Workflow

### 1. Orient

Call `get_status` and `get_catalog` (toolbox) once. The catalog is ~550 lines
of compact DSL and is **authoritative** — `references/node-map.md` records
semantics, but type strings and param ranges come from the live catalog.

### 2. Extract the Blender tree

Send `scripts/extract_geonodes.py` as the `code` argument of
`execute_blender_code`. Do not improvise a dump script; the canned one exists
because ad-hoc dumps reliably lose four things:

- **default values on unconnected inputs**, where most of a tree's real
  configuration lives (a scatter node's density is a socket, not a property)
- **node-level enum properties** — a Math node means nothing without
  `operation=MULTIPLY`, a Mix without `blend_type`, a Capture without `domain`
- **modifier-level inputs**, which live on the *object*, not in the tree.
  A tree-only read reports group defaults and silently misses everything the
  user actually tuned. The script prints these first, and they **override**
  the tree's own defaults wherever both appear.
- mode-hidden sockets, muted nodes, nested groups, reroutes

Edit the CONFIG block at the top before sending if the file is large — set
`TREE_FILTER` to scope the dump rather than letting it truncate.

### 3. Choose the target pipeline — decide this before translating

Toolbox has two pipelines that can receive a geometry-nodes tree, and picking
the wrong one wastes the whole translation.

**3D (`geometry` → `instances` → `scene-render` → `image`)** — right when the
tree is about *shape generation and instancing*: primitives, transforms,
extrude/bevel/lathe, scatter-on-surface, instance-on-points.

Its ceiling is low and you must know it up front: **no Set Position, no
subdivision, no boolean, no topology operators, and no 3D attribute system at
all.** `points3d` is produced by `scatter-points-3d` and, as aux outputs, by
the 3D curve primitives (`spline-3d`, `circle-3d`, `rect-3d`, `polygon-3d`) —
but it is consumed by only **two** nodes: `copy-to-points-3d` and
`project-to-screen-3d`. So a 3D point cloud can be instanced onto or projected
to screen, and nothing else: no 3D point expression, attribute math, or
attribute filtering exists. Verify that consumer set against `get_catalog`;
it is a young part of the app.

**2D (`points` → point/attribute nodes → `image`)** — right when the tree's
substance is *field math on points*: named attributes, per-point randomisation,
attribute blur/transfer, density-driven scatter, delete-by-attribute.

This pipeline is much richer. It has a real named-attribute system
(`set-named-attribute`, `attribute-math`, `attribute-blur`,
`attribute-transfer`, `map-attribute`), arbitrary per-point JS
(`point-expression`), texture-driven scatter density, and per-point instance
scale/rotation/tint fields on `copy-to-points`.

**So a scatter-and-vary tree usually translates better into toolbox's 2D
pipeline than its 3D one**, even though the Blender original was 3D — because
that is where the field machinery lives. Toolbox is a 2D motion-design tool
with a 3D annex. If the tree's output is ultimately a rendered image anyway,
2D is often the more faithful target.

State which pipeline you chose and why before you build.

### 4. Translate

Work node family by node family against `references/node-map.md`, applying
the field procedure below and the conventions in §"Coordinates, units, ranges".

### 5. Build, then verify

Build with `insert_recipe` (see §Building). Then **look at it**:

- toolbox `screenshot`, or `screenshot_strip` for anything animated
- Blender `get_viewport_screenshot`
- compare them and report the difference in words

A translation you have not looked at is a guess. Finish with the reporting
template in `references/node-map.md` §9 so the user knows precisely what
landed, what was approximated, and what was dropped.

## The field problem

In Blender, nearly any input can be driven by a **field** — a per-element
function evaluated on a domain (point / edge / face / corner / instance /
curve). In toolbox, params are single uniform values, and per-element variation
exists only through specific escape hatches.

For every **linked** input socket in the Blender tree, walk this in order:

1. **Is the chain actually constant?** Trace it back. If no per-element source
   feeds it (no Position, Index, Normal, ID, Random Value, or named
   attribute — only literals and math), then **evaluate it yourself and write
   the resulting number into a toolbox param.** This resolves the majority of
   real-world field chains. A tree that looks terrifying is usually mostly this.

2. **Does it match a known idiom?** Some field patterns have exact toolbox
   equivalents:
   - Distribute's `Rotation`/`Normal` → Instance on Points' `Rotation`
     ⇒ `copy-to-points-3d.align_to_normal = true`
   - `Random Value` → Rotation / Scale ⇒ `rotation_jitter` / `scale_jitter`
   - Map Range on an attribute ⇒ `map-attribute` (writes straight to scale /
     rotation / position)

3. **Is the target 2D points?** Then the field is expressible. Use
   `point-expression` (per-point JS: reads `index`, `count`, `px`, `py`,
   `attr("name")`; writes `x`, `y`, `rot`, `sx`, `sy`, `scale`, `keep`), or a
   named-attribute chain when the value must persist downstream or show up in
   the Spreadsheet. Validate the source with `validate_expression` **before**
   inserting it — assignments only, never `return`, declare temps with
   `let`/`const`.

4. **Is it spatially varying, with a field input on the consumer?** Several
   nodes take an image or noise instead of a scalar — `scatter-points.density`,
   `copy-to-points.scale_field` / `rotate_field`,
   `instance-transform-3d.noise` / `image`, `adaptive-pixelate.size_map`. Wire
   `perlin-noise` (or any image) in. Toolbox's `image→uv` coercion is Blender's
   Fac→Vector domain warp, and works on any `uv` input.

5. **Otherwise it does not translate.** Report it. Do not silently substitute a
   constant for a field and present the result as a port — a mean value where
   the whole point was the variation is a wrong answer that looks right.

**Domains.** Blender's point / edge / face / corner domains have no toolbox
counterpart beyond points. Toolbox attribute targets are `points`, spline
anchors, and spline subpaths. Any tree doing face- or edge-domain work
(`Extrude Mesh` selections, `Edge Angle`, corner attributes) is out of scope —
say so early rather than half-building it.

## Coordinates, units, ranges

These produce silent, plausible-looking wrongness. Check every one.

**Axes.** Blender is **Z-up**; toolbox 3D is **Y-up** (three-native), same as
glTF. For positions and scales:

```
toolbox.x =  blender.x
toolbox.y =  blender.z
toolbox.z = -blender.y
```

Scale is unsigned, so it maps `(sx, sy, sz) → (sx, sz, sy)` with no negation.

**Rotations.** Blender's Python API returns **radians**; toolbox params are
**degrees** — multiply by `180/π`. The axis remap applies to rotations too
(`(rot_x, rot_y, rot_z) → (rot_x, rot_z, −rot_y)`), but that component swap is
only exact for a **single-axis** rotation. A compound Euler triple changes
rotation order under the frame change, so the naive remap is wrong in general:
verify compound rotations visually against the Blender viewport and adjust,
rather than trusting the arithmetic.

**Scene scale.** Both sides are nominally metres, but toolbox 3D params are
range-clamped (`pos_*` ±10, `scale_*` 0.01–10, primitive sizes 0.01–10). A
Blender scene at architectural scale does not fit. Rescale the whole scene by
a single factor and say what factor you used — do not clamp node by node,
which silently distorts proportions.

**2D target space.** The 2D pipeline is normalized **[0,1]², Y-DOWN**
(row 0 = top) — not metres and not Y-up. Projecting 3D world coordinates into
it is a deliberate decision (which axes, what framing); state it.

**Param ranges.** Every param in `get_catalog` carries its range. Blender values
routinely exceed them (`scatter-points-3d.count` caps at 10000;
`scatter-points` at 4096). Clamp, and **report every clamp** — a count reduced
40× changes the look completely.

## Building

`insert_recipe` takes a RecipeGraph and inserts it as a **node group**. Its
full contract is in the tool description; the parts that bite:

- `type` strings must come from `get_catalog`.
- Edges: `from` is `"<id>:out"` or `"<id>:aux:<name>"`; `to` is
  `"<id>:in:<socket>"` or `"<id>:param:<name>"`.
- Local node ids are yours; **real ids are minted at insert**. To refine, call
  `get_graph` with `scope=<groupId>` and then `edit_group` against the real ids.
- Declare the group's boundary with `inputs`/`outputs` in the recipe envelope —
  Blender's Group Input / Group Output nodes become these, not node types.
- The group must be acyclic. Blender trees are too, so a cycle means you
  mistranslated something.

**Build incrementally.** Insert the skeleton first — source → transform →
scatter → instance → (`scene-render` for 3D) — and screenshot it. Then patch
detail on with `edit_group`, which is explicitly a change-by-exception tool.
A 40-node recipe that fails validation in one shot is far harder to debug than
four small ones, and validation errors come back as tool errors you must fix
and retry.

For a 3D chain the terminal is `scene-render` (takes `object3d` inputs —
`geometry` coerces in one-way — plus an optional `camera`; outputs `image`).
Add `camera-3d` and `light-3d` when the Blender scene's framing matters; the
defaults are not the Blender camera.

## Honesty rules

- Never present an approximation as a port. Name it.
- Never drop a node silently. If `Set Position` had no landing site, the
  headline is "the displacement did not translate," not "done."
- If the tree's core mechanism is out of scope (subdivision, booleans,
  face-domain fields), say that **before** building a partial version, and let
  the user decide whether a partial port is worth having.
