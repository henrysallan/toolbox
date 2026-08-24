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
// 3D Scatter Points — surface scatter (081026 spec §4.1)
// =====================================================================
//
// Area-weighted uniform random points on a mesh surface, emitted as
// `points3d` (world-space, with per-point surface normals for Copy to
// Points' align-to-normal). Deterministic: cumulative triangle-area table
// + mulberry32(seed) — same PRNG family as 2D Scatter.
//
// The `source` input is polymorphic (geometry | object3d — editorCanCoerce
// exception + CONNECTED_TYPE_RETYPE_NODES):
//   geometry — sample its triangles in local space, then apply the value's
//              carried TRS so emitted points are world-space; normals go
//              through the normal matrix (inverse-transpose, so non-uniform
//              scale doesn't shear them).
//   object3d — traverse for meshes and sample across ALL of them under one
//              global area weighting, applying each mesh's world matrix.
//              This is what makes an imported GLB scatterable. Instanced
//              meshes and lights are skipped (v1).
//
// Pure CPU, cost is per-recompute (fingerprint cache) — same profile as
// 2D Scatter. Density-by-texture is backlog (081026 spec §8).

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One sampleable triangle: vertex positions (world space) + the face
// normal (world space, unit) + its world-space area for the weight table.
interface Tri {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  cx: number; cy: number; cz: number;
  nx: number; ny: number; nz: number;
  area: number;
}

// Gather world-space triangles from one BufferGeometry under `matrix`.
function collectTriangles(
  geom: THREE.BufferGeometry,
  matrix: THREE.Matrix4,
  out: Tri[]
): void {
  const pos = geom.getAttribute("position");
  if (!pos) return;
  const index = geom.getIndex();
  const triCount = Math.floor((index ? index.count : pos.count) / 3);
  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const vc = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    va.fromBufferAttribute(pos, i0).applyMatrix4(matrix);
    vb.fromBufferAttribute(pos, i1).applyMatrix4(matrix);
    vc.fromBufferAttribute(pos, i2).applyMatrix4(matrix);
    // Cross(ab, ac): length = 2·area, direction = face normal. Computing
    // it from WORLD-space vertices bakes the normal matrix in for free
    // (and flips handedness correctly under negative scale).
    ab.subVectors(vb, va);
    ac.subVectors(vc, va);
    ab.cross(ac);
    const twoArea = ab.length();
    if (twoArea <= 0 || !isFinite(twoArea)) continue;
    out.push({
      ax: va.x, ay: va.y, az: va.z,
      bx: vb.x, by: vb.y, bz: vb.z,
      cx: vc.x, cy: vc.y, cz: vc.z,
      nx: ab.x / twoArea, ny: ab.y / twoArea, nz: ab.z / twoArea,
      area: twoArea / 2,
    });
  }
}

function trianglesFromInput(
  src: GeometryValue | Object3DValue
): Tri[] {
  const tris: Tri[] = [];
  if (src.kind === "geometry") {
    const t = src.transform;
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(...t.position),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...t.rotationEuler)),
      new THREE.Vector3(...t.scale)
    );
    collectTriangles(src.geometry, m, tris);
    return tris;
  }
  // object3d: world matrices reflect each node's local TRS chain.
  src.object.updateMatrixWorld(true);
  src.object.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!(mesh as THREE.Object3D & { isMesh?: boolean }).isMesh) return;
    if ((mesh as unknown as { isInstancedMesh?: boolean }).isInstancedMesh)
      return; // v1: skip instanced copies
    collectTriangles(mesh.geometry, mesh.matrixWorld, tris);
  });
  return tris;
}

export const scatterPoints3DNode: NodeDefinition = {
  type: "scatter-points-3d",
  name: "3D Scatter Points",
  category: "3d",
  description:
    "Scatters points across a 3D surface — area-weighted uniform, with per-point surface normals. Wire a primitive's geometry (or an imported model) in; feed the points to 3D Copy to Points or Filter Points. Deterministic per seed.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [{ name: "source", type: "geometry", required: true }],
  // Adopts object3d when that's what's wired (imported scenes, groups).
  resolveInputs(params, ctx): InputSocketDef[] {
    const t: SocketType =
      ctx?.connectedTypes?.source === "object3d" ? "object3d" : "geometry";
    return [{ name: "source", type: t, required: true }];
  },
  params: [
    {
      name: "count",
      label: "Count",
      type: "scalar",
      min: 1,
      max: 10000,
      softMax: 2000,
      step: 1,
      default: 500,
    },
    {
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 999,
      step: 1,
      default: 0,
    },
  ],
  primaryOutput: "points3d",
  auxOutputs: [],

  compute({ inputs, params }) {
    const src = inputs.source as GeometryValue | Object3DValue | undefined;
    const count = Math.max(
      1,
      Math.min(10000, Math.round((params.count as number) ?? 500))
    );
    if (!src || (src.kind !== "geometry" && src.kind !== "object3d")) {
      return { primary: makePoints(0, { withZ: true }) };
    }

    const tris = trianglesFromInput(src);
    if (tris.length === 0) {
      return { primary: makePoints(0, { withZ: true }) };
    }

    // Cumulative area table → binary search picks a triangle with
    // probability ∝ its area (uniform density over the whole surface).
    const cum = new Float64Array(tris.length);
    let total = 0;
    for (let i = 0; i < tris.length; i++) {
      total += tris[i].area;
      cum[i] = total;
    }

    const rand = mulberry32(((params.seed as number) ?? 0) + 1);
    const out: PointsValue = makePoints(count, {
      withZ: true,
      withNormals: true,
    });
    for (let i = 0; i < count; i++) {
      const r = rand() * total;
      // Binary search: first cum[k] ≥ r.
      let lo = 0;
      let hi = tris.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] < r) lo = mid + 1;
        else hi = mid;
      }
      const tri = tris[lo];
      // Uniform barycentric sample (the sqrt trick).
      const su = Math.sqrt(rand());
      const v = rand();
      const b0 = 1 - su;
      const b1 = su * (1 - v);
      const b2 = su * v;
      out.positions[i * 2] = b0 * tri.ax + b1 * tri.bx + b2 * tri.cx;
      out.positions[i * 2 + 1] = b0 * tri.ay + b1 * tri.by + b2 * tri.cy;
      out.z![i] = b0 * tri.az + b1 * tri.bz + b2 * tri.cz;
      out.normals![i * 3] = tri.nx;
      out.normals![i * 3 + 1] = tri.ny;
      out.normals![i * 3 + 2] = tri.nz;
    }
    return { primary: out };
  },
};
