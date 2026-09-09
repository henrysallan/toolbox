import * as THREE from "three";
import type {
  InputSocketDef,
  NodeDefinition,
  PointsValue,
  SocketType,
} from "@/engine/types";
import type { GeometryValue, Object3DValue } from "@/engine/three-types";
import { makePoints } from "@/engine/points";

// =====================================================================
// 3D Mesh to Points — vertex domain → points3d
// =====================================================================
//
// One point per mesh vertex (the position-attribute domain, not unique
// spatial corners — three's primitives duplicate verts per face for
// hard normals, so a Box emits 24 points at 8 corners). World-space,
// with per-vertex normals when the mesh carries them (transformed by
// the inverse-transpose so non-uniform scale doesn't shear them).
//
// The `source` input is polymorphic (geometry | object3d — same
// editorCanCoerce exception + CONNECTED_TYPE_RETYPE_NODES as Scatter):
//   geometry — vertices in local space, then the value's carried TRS
//              so emitted points are world-space.
//   object3d — traverse for meshes and concatenate ALL of them,
//              applying each mesh's world matrix. Instanced meshes
//              skipped (v1), matching Scatter.

interface Vert {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
}

const v = new THREE.Vector3();
const n = new THREE.Vector3();
const nMat = new THREE.Matrix3();

function collectVertices(
  geom: THREE.BufferGeometry,
  matrix: THREE.Matrix4,
  out: Vert[]
): void {
  const pos = geom.getAttribute("position");
  if (!pos) return;
  const nrm = geom.getAttribute("normal");
  nMat.getNormalMatrix(matrix);
  const count = pos.count;
  for (let i = 0; i < count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(matrix);
    if (!isFinite(v.x) || !isFinite(v.y) || !isFinite(v.z)) continue;
    if (nrm) {
      n.fromBufferAttribute(nrm, i).applyMatrix3(nMat);
      const len = n.length();
      if (len > 0 && isFinite(len)) n.multiplyScalar(1 / len);
      else n.set(0, 1, 0);
    } else {
      n.set(0, 1, 0);
    }
    out.push({ x: v.x, y: v.y, z: v.z, nx: n.x, ny: n.y, nz: n.z });
  }
}

function verticesFromInput(src: GeometryValue | Object3DValue): Vert[] {
  const verts: Vert[] = [];
  if (src.kind === "geometry") {
    const t = src.transform;
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(...t.position),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...t.rotationEuler)),
      new THREE.Vector3(...t.scale)
    );
    collectVertices(src.geometry, m, verts);
    return verts;
  }
  src.object.updateMatrixWorld(true);
  src.object.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!(mesh as THREE.Object3D & { isMesh?: boolean }).isMesh) return;
    if ((mesh as unknown as { isInstancedMesh?: boolean }).isInstancedMesh)
      return;
    collectVertices(mesh.geometry, mesh.matrixWorld, verts);
  });
  return verts;
}

export const meshToPoints3DNode: NodeDefinition = {
  type: "mesh-to-points-3d",
  name: "3D Mesh to Points",
  category: "3d",
  description:
    "Emits one point per mesh vertex. Wire a primitive's geometry (or an imported model) in; feed the points to 3D Copy to Points or Filter Points. Vertex normals come along when the mesh has them.",
  facts: {
    gotchas: [
      "One point per entry in the position attribute (the vertex domain, not unique corners); three's primitives duplicate verts per face for hard normals, so a Box emits 24 points for 8 corners.",
      "geometry input: local-space vertices transformed by the value's carried TRS into world space; object3d input: traverses and concatenates every mesh found, each via its own world matrix.",
      "Instanced meshes are skipped when the input is object3d, matching Scatter Points 3D.",
      "Per-vertex normals are transformed by the inverse-transpose of the matrix and renormalized; a mesh with no normal attribute gets a constant (0,1,0) normal.",
      "Non-finite transformed vertex positions (NaN/Infinity) are silently dropped from the output.",
    ],
  },
  backend: "webgl2",
  noMaskInput: true,
  inputs: [{ name: "source", type: "geometry", required: true }],
  resolveInputs(_params, ctx): InputSocketDef[] {
    const t: SocketType =
      ctx?.connectedTypes?.source === "object3d" ? "object3d" : "geometry";
    return [{ name: "source", type: t, required: true }];
  },
  params: [],
  primaryOutput: "points3d",
  auxOutputs: [],

  compute({ inputs }) {
    const src = inputs.source as GeometryValue | Object3DValue | undefined;
    if (!src || (src.kind !== "geometry" && src.kind !== "object3d")) {
      return { primary: makePoints(0, { withZ: true }) };
    }

    const verts = verticesFromInput(src);
    const count = verts.length;
    if (count === 0) {
      return { primary: makePoints(0, { withZ: true }) };
    }

    const out: PointsValue = makePoints(count, {
      withZ: true,
      withNormals: true,
    });
    for (let i = 0; i < count; i++) {
      const vt = verts[i];
      out.positions[i * 2] = vt.x;
      out.positions[i * 2 + 1] = vt.y;
      out.z![i] = vt.z;
      out.normals![i * 3] = vt.nx;
      out.normals![i * 3 + 1] = vt.ny;
      out.normals![i * 3 + 2] = vt.nz;
    }
    return { primary: out };
  },
};
