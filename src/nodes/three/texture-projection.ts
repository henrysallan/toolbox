import * as THREE from "three";
import type { NodeDefinition, ParamDef, RenderContext } from "@/engine/types";
import type { GeometryValue } from "@/engine/three-types";

// =====================================================================
// Texture Projection — UV generator (081026 spec §6.3)
// =====================================================================
//
// `geometry → geometry` that REWRITES the uv attribute by projecting the
// mesh through a placeable projection volume (the TRS params — named
// pos_/rot_/scale_ so the standard 3D viewport gizmo drives the volume
// when this node is selected). Vertices transform into projection space
// (inverse TRS; the unit volume spans [-0.5, 0.5]) and map:
//
//   planar      — straight (x, y): a slide projector along the volume's Z.
//   box         — per-vertex dominant NORMAL axis picks one of the three
//                 planar pairs (triplanar-lite; discretized per vertex, so
//                 smooth meshes seam at axis switches — fine for the
//                 noise/pattern wrapping this exists for).
//   cylindrical — angle around the volume's Y axis × height.
//   spherical   — angle × inclination of the normalized direction.
//
// Output is a deep clone with the new uv (positions/normals cloned too —
// sharing attribute objects across BufferGeometries would tangle three's
// per-geometry GPU buffer lifecycle for a modest memory win; §1.2's
// never-mutate rule stays trivially true). Retained in ctx.state,
// rebuilt per compute, previous build disposed. Camera-mode projection is
// backlog (§8).

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

type Mode = "planar" | "box" | "cylindrical" | "spherical";

interface ProjState {
  geometry: THREE.BufferGeometry | null;
}

export const textureProjection3DNode: NodeDefinition = {
  type: "texture-projection-3d",
  name: "Texture Projection",
  category: "3d",
  description:
    "Generates UVs by projecting the geometry through a placeable volume — planar, box (triplanar-lite), cylindrical, or spherical. Position/rotate/scale the volume with the params (or the viewport gizmo); a Material's image maps then follow the projection.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [{ name: "geometry", type: "geometry", required: true }],
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["planar", "box", "cylindrical", "spherical"],
      default: "planar",
    },
    ...TRS_PARAMS,
  ],
  primaryOutput: "geometry",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const src = inputs.geometry as GeometryValue | undefined;
    if (!src || src.kind !== "geometry") return {};
    const key = `texture-projection-3d:${nodeId}`;
    let st = ctx.state[key] as ProjState | undefined;
    if (!st) {
      st = { geometry: null };
      ctx.state[key] = st;
    }

    const mode = ((params.mode as string) ?? "planar") as Mode;
    const inv = new THREE.Matrix4()
      .compose(
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
      )
      .invert();
    // Direction transform for box mode's axis pick: rotation only.
    const invRot = new THREE.Quaternion()
      .setFromEuler(
        new THREE.Euler(
          ((params.rot_x as number) ?? 0) * DEG,
          ((params.rot_y as number) ?? 0) * DEG,
          ((params.rot_z as number) ?? 0) * DEG
        )
      )
      .invert();

    const geom = src.geometry.clone();
    const pos = geom.getAttribute("position") as THREE.BufferAttribute;
    const nrm = geom.getAttribute("normal") as THREE.BufferAttribute | undefined;
    const count = pos.count;
    const uvs = new Float32Array(count * 2);

    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    const TAU = Math.PI * 2;
    for (let i = 0; i < count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(inv);
      let u = 0;
      let v = 0;
      let m: Mode = mode;
      if (m === "box" && !nrm) m = "planar";
      switch (m) {
        case "planar":
          u = p.x + 0.5;
          v = p.y + 0.5;
          break;
        case "box": {
          n.fromBufferAttribute(nrm!, i).applyQuaternion(invRot);
          const ax = Math.abs(n.x);
          const ay = Math.abs(n.y);
          const az = Math.abs(n.z);
          if (ax >= ay && ax >= az) {
            u = p.z + 0.5;
            v = p.y + 0.5;
          } else if (ay >= ax && ay >= az) {
            u = p.x + 0.5;
            v = p.z + 0.5;
          } else {
            u = p.x + 0.5;
            v = p.y + 0.5;
          }
          break;
        }
        case "cylindrical":
          u = Math.atan2(p.x, p.z) / TAU + 0.5;
          v = p.y + 0.5;
          break;
        case "spherical": {
          const len = p.length() || 1;
          u = Math.atan2(p.x, p.z) / TAU + 0.5;
          v = 1 - Math.acos(Math.max(-1, Math.min(1, p.y / len))) / Math.PI;
          break;
        }
      }
      uvs[i * 2] = u;
      uvs[i * 2 + 1] = v;
    }
    geom.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));

    if (st.geometry) st.geometry.dispose();
    st.geometry = geom;

    const out: GeometryValue = { ...src, nodeId, geometry: geom };
    return { primary: out };
  },

  dispose(ctx: RenderContext, nodeId: string) {
    const key = `texture-projection-3d:${nodeId}`;
    const st = ctx.state[key] as ProjState | undefined;
    if (st?.geometry) st.geometry.dispose();
    delete ctx.state[key];
  },
};
