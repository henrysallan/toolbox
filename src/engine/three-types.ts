// =====================================================================
// 3D socket value types (M1)
// =====================================================================
//
// Runtime-only values, like sdf / element / particles — never serialized.
// The persistent state is the producing node's params; the fingerprint
// chain handles invalidation. These carry references to RETAINED three.js
// objects owned by the producing node's ctx.state (built in compute, torn
// down in dispose), so the dataflow doesn't rebuild three objects every
// frame — see specdocs/archive/061626_3d-nodes-and-context.md §3.3.
//
// three's type surface is imported type-only here (erased at runtime) so
// the rest of the engine type system doesn't couple to three. Only this
// file and the 3D nodes reference three.
//
// M1 scope: object3d + camera. `geometry` and `material` are deferred to
// M2 (modeling ops + the flow-through Material node force them); until
// then primitives emit `object3d` directly with a baked default material.

import type * as THREE from "three";

// A placed scene object: a mesh, a light, or a group of objects. Kind-
// tagged via `variant` so the renderer and future ops can branch without
// instanceof. The `object` is retained and owned by the producing node —
// consumers (Scene Render) add it to their scene but never dispose it.
export type Object3DValue = {
  kind: "object3d";
  object: THREE.Object3D;
  variant: "mesh" | "light" | "group";
};

// A camera descriptor. Pure CPU data (no retained GPU resource), so the
// renderer constructs/updates its own three camera from this each frame.
// M1 uses a position + look-at target rather than a full transform — the
// gizmo and a Transform 3D node will generalize this later.
export type CameraValue = {
  kind: "camera";
  projection: "perspective" | "orthographic";
  fov: number; // vertical FOV in degrees (perspective)
  near: number;
  far: number;
  orthoHeight?: number; // world-units of vertical extent (orthographic)
  position: [number, number, number];
  target: [number, number, number];
  // Depth-of-field (bokeh). Present ⇒ Scene Render post-processes with a
  // BokehPass. `focus` is the in-focus distance (world units) along the view
  // direction; `aperture` controls how fast things blur away from focus;
  // `maxblur` caps the blur radius.
  dof?: { focus: number; aperture: number; maxblur: number };
};
