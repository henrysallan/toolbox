# Transform node + primitive rotation improvements (2026-06-29)

A batch of fixes/features around the Transform node and spline primitives.

## 1. Rotation inversion fix (image mode) — BUG

Symptom: add a Rectangle → Transform, rotate → the image spins the wrong way.

Root cause: the image path warps in GL's Y-**up** uv space, while the spline
and point paths (and the on-canvas gizmo's `atan2`) work in CPU Y-**down**
space. The image shader negated the angle (`cos(-u_angle)`) for its
inverse-sampling warp, which combined with the Y-flip made `+rotate` read as
**CCW** for images but **CW** for spline/point/gizmo — so image rotation was
inverted relative to everything else.

Fix: `src/nodes/effect/transform.ts` — the image shader now uses `cos(u_angle)`
/ `sin(u_angle)` (positive), so `+rotate` = CW on screen in all three modes,
matching the gizmo. **Back-compat note:** this flips the visual rotation of any
existing saved project that used a nonzero rotate on an image-mode Transform
(they were authored against the inverted behavior). Accepted as a bug fix.

## 2. Rectangle rotation — FEATURE (devlist #85 area)

`src/nodes/source/rectangle.ts` gains a `rotate` (°) param. Applied via
`transformSpline` about the rectangle's own center (`originX`/`originY`) after
the subpath is built, so all three outputs (spline primary, image + element
aux) reflect it. Same +CW convention as the Transform node.

Limitation: the PrimitiveGizmo box stays axis-aligned (no rotation handle) —
rotation is a param-only control for now. (Circle has no rotate param: an
ellipse is rotationally symmetric about its center, so it'd be a no-op unless
we later want to rotate a trimmed arc.)

## 3. Local / global pivot space for spline & point transforms — FEATURE

`src/nodes/effect/transform.ts` gains a `space` enum (`global` | `local`,
segmented, default **global**).

- **Global** (default, unchanged): `pivotX`/`pivotY` are absolute canvas coords.
  Chaining a second Transform rotates/scales the shape about the canvas point,
  not the shape — usually not what you want.
- **Local**: `pivotX`/`pivotY` are a fraction of the INCOMING geometry's
  bounding box (0.5,0.5 = its center). So rotate/scale happen about the shape
  wherever an upstream transform placed it — "the anchor follows the previous
  transforms faithfully." `translate` stays in canvas units either way. Image
  mode ignores `space` (no intrinsic bounds; always canvas-space).

Implemented with `splineAABB` / `pointsAABB` + `localPivot` helpers that remap
the pivot fraction against the bbox (falls back to global on a degenerate bbox).

**Known limitation (v1):** the on-canvas TransformGizmo still draws its pivot
handle at the absolute `pivotX`/`pivotY` canvas coords, so in **local** mode the
gizmo's pivot marker and rotation don't visually match the actual (bbox-
relative) pivot. The param sliders are accurate; gizmo-awareness of local space
is a follow-up (the gizmo already knows the spline AABB via `boundsMin/Max`, so
it can remap — plus inverse-remap on pivot-drag writeback).

## 4. Retire the `mode` dropdown — auto-coerce from the wired type

`src/nodes/effect/transform.ts` no longer has a `mode` dropdown/`headerControl`.
Behavior is derived from the connected input's socket type, mirroring the
Displace node: `resolveInputs`/`resolvePrimaryOutput` read `ctx.connectedTypes.image`
(spline → spline, points → points, else image) and `compute` branches on the
actual `inputs.image.kind`. The `mode` param is kept but `hidden: true` so old
saved projects deserialize unchanged (behavior re-derives from the wire).

Editor plumbing: `NodeEditor.tsx` `isValidConnection` + `canCoerce` gained a
`transform` allow-entry so a spline/points output can connect to the Transform's
`in:image` socket even though it reads `image` before anything is connected
(same entries the `displace` node already had).

Net effect for the user: drop any of image / spline / points into a Transform
and it just works — one fewer click, no wrong-mode empty output.
