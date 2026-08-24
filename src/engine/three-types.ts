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
// Wave 2 (081026_3d-geometry-points-materials.md) adds `geometry` — the
// modeling-chain type — plus MaterialDesc riding inside it (no `material`
// socket type; the Material node is flow-through per that spec §6).

import type * as THREE from "three";
// Type-only circular with ./types — legal (erased at runtime); types.ts
// imports our value types the same way.
import type { ImageValue } from "./types";
import type { ColorRampInterp, ColorRampStop } from "./color-ramp";

// A placed scene object: a mesh, a light, an InstancedMesh (Copy to
// Points), or a group of objects. Kind-tagged via `variant` so the
// renderer and future ops can branch without instanceof. The `object` is
// retained and owned by the producing node — consumers (Scene Render) add
// it to their scene but never dispose it.
export type Object3DValue = {
  kind: "object3d";
  object: THREE.Object3D;
  variant: "mesh" | "light" | "group" | "instanced";
};

// Raw mesh data flowing through the modeling chain (primitives → Extrude/
// Texture Projection/Material → scene). LOCAL space, origin-centered; the
// carried `transform` is applied only at the object3d wrap (coerce.ts /
// Copy to Points). Ownership follows the retained model: `geometry` is a
// BufferGeometry owned by the PRODUCING node's ctx.state — consumers read,
// never mutate, never dispose. A modeling op builds a NEW BufferGeometry
// in its own state keyed on (input value identity, params sig); it must
// never write into its input's buffers (081026 spec §1.2).
export type GeometryValue = {
  kind: "geometry";
  geometry: THREE.BufferGeometry;
  // Producing node's id — stamped onto the wrap mesh's userData so
  // viewport-pick ↔ graph-select keeps working through the coercion.
  nodeId?: string;
  transform: {
    position: [number, number, number];
    rotationEuler: [number, number, number]; // radians, XYZ order
    scale: [number, number, number];
  };
  // Material slot 0 applies to the whole mesh in v1; an array so imported
  // multi-material meshes / per-part overrides need no type change later.
  // null/absent slot ⇒ the shared default material at wrap time.
  materials: (MaterialDesc | null)[];
};

// A stream of copies of one source geometry — the instance domain
// (081026 spec §4.4). Per-instance TRS is SoA in the "copy at point i"
// frame; the resolver (three-geometry.ts) composes `TRS_i · M_source`
// into a retained InstancedMesh at the object3d boundary, keyed on
// `retainKey` — a stable object the PRODUCER retains across recomputes
// (its ctx.state), so the mesh survives cache churn and dies with the
// producer. Modifier convention: copy the value, REPLACE the arrays you
// change, share the rest (producers mint fresh arrays per recompute).
export type InstancesValue = {
  kind: "instances";
  source: GeometryValue;
  count: number;
  positions: Float32Array; // count*3, world
  quaternions: Float32Array; // count*4 (x, y, z, w)
  scales: Float32Array; // count*3
  // Optional per-instance linear-RGB tint → three's instanceColor.
  colors?: Float32Array; // count*3
  // Billboarding marker (M12): set by Align to Camera, APPLIED AT RENDER
  // TIME — with the marker's own camera position when its camera input is
  // wired (explicit "face THIS camera", updating through the fingerprint
  // chain as that camera animates), else with whichever camera is
  // rendering (Scene Render's camera for the output; the editor camera in
  // the orbit viewport — what makes billboards track an orbit live). The
  // stored quaternions stay the base orientation (used when the camera
  // sits on a copy, and by Realize Instances, which ignores billboarding
  // — it's a render effect, not geometry).
  // `baseQuats` is the quaternion array AS OF the Align node: modifiers
  // downstream of Align replace the top-level `quaternions` array (§4.4
  // copy-on-write), so `quaternions !== baseQuats` ⇒ a downstream delta
  // exists, and the render-time apply composes it ON TOP of the billboard
  // orientation (per copy: bbQ ⊗ base⁻¹ ⊗ now — the delta lands in the
  // billboarded frame, so an Instance Transform Z-spin after Align spins
  // cards in the view plane).
  billboard?: {
    mode: "full" | "y";
    face: "z" | "y";
    camera?: [number, number, number];
    baseQuats?: Float32Array;
  };
  retainKey: object;
};

// A 3D curve as pure CPU data (M11) — the unified spline-3d model on the
// wire: anchors + optional bezier handles ([in0, out0, …] flat, 2n) +
// closed/tension. Consumers rebuild a THREE.Curve via curveFromValue
// (nodes/three/curve-tube.ts). World-space coordinates. No coercions —
// curve3d only meets its own sockets (plus polymorphic upgrades like
// Points on Path).
export type Curve3DValue = {
  kind: "curve3d";
  mode: "smooth" | "bezier";
  points: [number, number, number][];
  handles?: [number, number, number][];
  closed: boolean;
  tension: number;
};

// Resolved PBR channel set, built by the Material node (M4) and by the
// primitives' color/metalness/roughness params as a default. Channels
// accepting textures hold an ImageValue reference — crossing into three's
// isolated context happens in the resolver (engine/three-geometry.ts) via
// identity-cached readback, never here. `sig` is a stable hash of the
// scalar channels + wired-texture identities so the resolver rebuilds the
// three material only when it moves.
export type MaterialDesc = {
  kind: "material";
  baseColor: string | ImageValue;
  roughness: number | ImageValue;
  metalness: number | ImageValue;
  transmission: number;
  ior: number;
  alpha: number | ImageValue;
  // Shading model (Tier 2): absent/"standard" = PBR (physical when
  // transmission > 0); "toon" = MeshToonMaterial with its band structure
  // baked from `toonRamp` (a full color ramp — multi-stop band colors at
  // arbitrary positions; interp "constant" = hard bands, linear/ease =
  // painterly gradients); "matcap" = MeshMatcapMaterial — a wired
  // baseColor IMAGE becomes the matcap texture, otherwise a generated
  // clay-ball default. Toon/matcap ignore rough/metal/transmission (no
  // lighting model for them there). Absent toonRamp on a toon desc =
  // the default 3-band ramp. Stop alpha is ignored (the gradient map is
  // an irradiance ramp — RGB only).
  shading?: "standard" | "toon" | "matcap";
  toonRamp?: { stops: ColorRampStop[]; interp: ColorRampInterp };
  // Surface-detail perturbation (the Bump node — flow-through like the
  // Material node). "bump" reads the image as a height map (three's
  // bumpMap/bumpScale); "normal" reads it as a tangent-space normal map
  // (normalMap/normalScale). Supported by all four material classes.
  bump?: { map: ImageValue; strength: number; mode: "bump" | "normal" };
  // Lineart (Material node toggle), realized at the object3d boundary as
  // EXTRA retained objects (not material properties): an inverted-hull
  // silhouette shell always; technique "quality" adds crease lines via
  // EdgesGeometry at `angle`° threshold (meshes only — instanced streams
  // draw the hull silhouette without crease lines).
  lineart?: {
    technique: "fast" | "quality";
    color: string;
    thickness: number; // world units, silhouette shell offset
    opacity: number;
    angle: number; // crease threshold in degrees (quality)
  };
  sig: string;
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
