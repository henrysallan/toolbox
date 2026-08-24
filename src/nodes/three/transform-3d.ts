import * as THREE from "three";
import type {
  InputSocketDef,
  NodeDefinition,
  ParamDef,
  SocketType,
} from "@/engine/types";
import type { GeometryValue, InstancesValue } from "@/engine/three-types";

// =====================================================================
// Transform 3D (M6, 081026 spec)
// =====================================================================
//
// The missing basic: move/rotate/scale anything in the modeling chain.
// Polymorphic source (the Filter Points pattern — editorCanCoerce +
// CONNECTED_TYPE_RETYPE_NODES):
//
//   geometry  — params TRS composes ONTO the carried transform (matrix
//               multiply, then decompose back to TRS — shear from
//               non-uniform-scale-under-rotation collapses in the
//               decompose, the standard three approximation). Buffers
//               untouched; this is metadata-only, effectively free.
//   instances — transforms the whole cloud: positions through the matrix,
//               orientations premultiplied, scales component-multiplied.
//
// Standard pos_/rot_/scale_ param names ⇒ the 3D viewport gizmo drives
// this node when selected.

const DEG = Math.PI / 180;

const TRS_PARAMS: ParamDef[] = [
  { name: "pos_x", label: "Position X", type: "scalar", min: -10, max: 10, softMax: 5, step: 0.01, default: 0 },
  { name: "pos_y", label: "Position Y", type: "scalar", min: -10, max: 10, softMax: 5, step: 0.01, default: 0 },
  { name: "pos_z", label: "Position Z", type: "scalar", min: -10, max: 10, softMax: 5, step: 0.01, default: 0 },
  { name: "rot_x", label: "Rotation X (°)", type: "scalar", min: -180, max: 180, step: 0.1, default: 0 },
  { name: "rot_y", label: "Rotation Y (°)", type: "scalar", min: -180, max: 180, step: 0.1, default: 0 },
  { name: "rot_z", label: "Rotation Z (°)", type: "scalar", min: -180, max: 180, step: 0.1, default: 0 },
  { name: "scale_x", label: "Scale X", type: "scalar", min: 0.01, max: 10, softMax: 4, step: 0.01, default: 1 },
  { name: "scale_y", label: "Scale Y", type: "scalar", min: 0.01, max: 10, softMax: 4, step: 0.01, default: 1 },
  { name: "scale_z", label: "Scale Z", type: "scalar", min: 0.01, max: 10, softMax: 4, step: 0.01, default: 1 },
];

export const transform3DNode: NodeDefinition = {
  type: "transform-3d",
  name: "Transform 3D",
  category: "3d",
  description:
    "Moves, rotates, and scales 3D geometry or an instance stream. Chain after Extrude Spline / Lathe / Realize Instances (whose outputs sit at the origin) to place them; the viewport gizmo drives it.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [{ name: "source", type: "geometry", required: true }],
  resolveInputs(params, ctx): InputSocketDef[] {
    const t: SocketType =
      ctx?.connectedTypes?.source === "instances" ? "instances" : "geometry";
    return [{ name: "source", type: t, required: true }];
  },
  params: TRS_PARAMS,
  primaryOutput: "geometry",
  resolvePrimaryOutput(params, ctx): SocketType {
    return ctx?.connectedTypes?.source === "instances"
      ? "instances"
      : "geometry";
  },
  auxOutputs: [],

  compute({ inputs, params, nodeId }) {
    const src = inputs.source as GeometryValue | InstancesValue | undefined;
    if (!src || (src.kind !== "geometry" && src.kind !== "instances"))
      return {};

    const mDelta = new THREE.Matrix4().compose(
      new THREE.Vector3(
        (params.pos_x as number) ?? 0,
        (params.pos_y as number) ?? 0,
        (params.pos_z as number) ?? 0
      ),
      new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          ((params.rot_x as number) ?? 0) * DEG,
          ((params.rot_y as number) ?? 0) * DEG,
          ((params.rot_z as number) ?? 0) * DEG
        )
      ),
      new THREE.Vector3(
        (params.scale_x as number) ?? 1,
        (params.scale_y as number) ?? 1,
        (params.scale_z as number) ?? 1
      )
    );

    if (src.kind === "geometry") {
      const t = src.transform;
      const mCarried = new THREE.Matrix4().compose(
        new THREE.Vector3(...t.position),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(...t.rotationEuler)),
        new THREE.Vector3(...t.scale)
      );
      const m = mDelta.multiply(mCarried);
      const p = new THREE.Vector3();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      m.decompose(p, q, s);
      const e = new THREE.Euler().setFromQuaternion(q);
      const out: GeometryValue = {
        ...src,
        nodeId,
        transform: {
          position: [p.x, p.y, p.z],
          rotationEuler: [e.x, e.y, e.z],
          scale: [s.x, s.y, s.z],
        },
      };
      return { primary: out };
    }

    // Instances: transform the cloud (fresh arrays — §4.4 convention).
    const n = src.count;
    const positions = new Float32Array(n * 3);
    const quaternions = new Float32Array(n * 4);
    const scales = new Float32Array(n * 3);
    const qDelta = new THREE.Quaternion();
    const pDelta = new THREE.Vector3();
    const sDelta = new THREE.Vector3();
    mDelta.decompose(pDelta, qDelta, sDelta);
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    for (let i = 0; i < n; i++) {
      p.set(
        src.positions[i * 3],
        src.positions[i * 3 + 1],
        src.positions[i * 3 + 2]
      ).applyMatrix4(mDelta);
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
      q.set(
        src.quaternions[i * 4],
        src.quaternions[i * 4 + 1],
        src.quaternions[i * 4 + 2],
        src.quaternions[i * 4 + 3]
      ).premultiply(qDelta);
      quaternions[i * 4] = q.x;
      quaternions[i * 4 + 1] = q.y;
      quaternions[i * 4 + 2] = q.z;
      quaternions[i * 4 + 3] = q.w;
      scales[i * 3] = src.scales[i * 3] * sDelta.x;
      scales[i * 3 + 1] = src.scales[i * 3 + 1] * sDelta.y;
      scales[i * 3 + 2] = src.scales[i * 3 + 2] * sDelta.z;
    }
    const out: InstancesValue = {
      ...src,
      positions,
      quaternions,
      scales,
    };
    return { primary: out };
  },
};
