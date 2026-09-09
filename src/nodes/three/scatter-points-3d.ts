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
// 3D Scatter Points — surface scatter (081026 spec §4.1) + grid mode
// =====================================================================
//
// Two modes:
//   surface — area-weighted uniform random points on a mesh surface,
//             emitted as `points3d` (world-space, with per-point surface
//             normals for Copy to Points' align-to-normal). Deterministic:
//             cumulative triangle-area table + mulberry32(seed) — same
//             PRNG family as 2D Scatter. The `source` input is polymorphic
//             (geometry | object3d — editorCanCoerce exception +
//             CONNECTED_TYPE_RETYPE_NODES):
//               geometry — sample its triangles in local space, then apply
//                          the value's carried TRS so emitted points are
//                          world-space; normals go through the normal
//                          matrix (inverse-transpose, so non-uniform
//                          scale doesn't shear them).
//               object3d — traverse for meshes and sample across ALL of
//                          them under one global area weighting, applying
//                          each mesh's world matrix. This is what makes
//                          an imported GLB scatterable. Instanced meshes
//                          and lights are skipped (v1).
//   grid    — ignores the source input (socket hides) and emits a
//             centered X×Y×Z lattice. Count + spacing per axis, same
//             vocabulary as 3D Array's grid. Normals are world-up so
//             Copy to Points' align-to-normal still seats copies.
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

function gridPoints(params: Record<string, unknown>): PointsValue {
  const cx = Math.max(1, Math.round((params.count_x as number) ?? 5));
  const cy = Math.max(1, Math.round((params.count_y as number) ?? 5));
  const cz = Math.max(1, Math.round((params.count_z as number) ?? 5));
  const sx = (params.spacing_x as number) ?? 0.5;
  const sy = (params.spacing_y as number) ?? 0.5;
  const sz = (params.spacing_z as number) ?? 0.5;
  // 32³ = 32768 — a complete lattice always fits; don't truncate mid-grid.
  const n = Math.min(32768, cx * cy * cz);
  const out: PointsValue = makePoints(n, { withZ: true, withNormals: true });
  let i = 0;
  for (let z = 0; z < cz && i < n; z++) {
    for (let y = 0; y < cy && i < n; y++) {
      for (let x = 0; x < cx && i < n; x++) {
        out.positions[i * 2] = (x - (cx - 1) / 2) * sx;
        out.positions[i * 2 + 1] = (y - (cy - 1) / 2) * sy;
        out.z![i] = (z - (cz - 1) / 2) * sz;
        out.normals![i * 3] = 0;
        out.normals![i * 3 + 1] = 1;
        out.normals![i * 3 + 2] = 0;
        i++;
      }
    }
  }
  return out;
}

export const scatterPoints3DNode: NodeDefinition = {
  type: "scatter-points-3d",
  name: "3D Scatter Points",
  category: "3d",
  description:
    "Scatters points across a 3D surface — area-weighted uniform, with per-point surface normals — or emits a centered X×Y×Z grid (no input). Wire a primitive's geometry (or an imported model) into Surface mode; feed the points to 3D Copy to Points or Filter Points. Deterministic per seed.",
  facts: {
    space: {
      "param:spacing_x": "world3d",
      "param:spacing_y": "world3d",
      "param:spacing_z": "world3d",
    },
    gotchas: [
      "mode=grid ignores the source input entirely and emits a centered X×Y×Z lattice from count_x/y/z and spacing_x/y/z, with normals fixed at world-up (0,1,0).",
      "Surface-mode traversal of an object3d input skips instanced meshes and lights (v1); only ordinary Mesh nodes contribute triangles to the area-weighted sample.",
      "Degenerate triangles (zero-area or non-finite) are silently dropped from the sampling table before scattering.",
      "Grid point count caps at 32,768 (32³) so a full lattice is never truncated mid-grid; count_x/y/z's own 32 max exactly reaches that ceiling.",
    ],
  },
  backend: "webgl2",
  noMaskInput: true,
  inputs: [{ name: "source", type: "geometry", required: true }],
  // Surface: adopts object3d when that's what's wired (imported scenes,
  // groups). Grid: no source socket — the lattice is param-driven.
  resolveInputs(params, ctx): InputSocketDef[] {
    const mode = (params.mode as string) ?? "surface";
    if (mode === "grid") return [];
    const t: SocketType =
      ctx?.connectedTypes?.source === "object3d" ? "object3d" : "geometry";
    return [{ name: "source", type: t, required: true }];
  },
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["surface", "grid"],
      default: "surface",
      control: "segmented",
    },
    {
      name: "count",
      label: "Count",
      type: "scalar",
      min: 1,
      max: 10000,
      softMax: 2000,
      step: 1,
      default: 500,
      visibleIf: (p) => p.mode !== "grid",
    },
    {
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 999,
      step: 1,
      default: 0,
      visibleIf: (p) => p.mode !== "grid",
    },
    {
      name: "count_x",
      label: "Count X",
      type: "scalar",
      min: 1,
      max: 32,
      step: 1,
      default: 5,
      visibleIf: (p) => p.mode === "grid",
    },
    {
      name: "count_y",
      label: "Count Y",
      type: "scalar",
      min: 1,
      max: 32,
      step: 1,
      default: 5,
      visibleIf: (p) => p.mode === "grid",
    },
    {
      name: "count_z",
      label: "Count Z",
      type: "scalar",
      min: 1,
      max: 32,
      step: 1,
      default: 5,
      visibleIf: (p) => p.mode === "grid",
    },
    {
      name: "spacing_x",
      label: "Spacing X",
      type: "scalar",
      min: 0.01,
      max: 5,
      step: 0.01,
      default: 0.5,
      visibleIf: (p) => p.mode === "grid",
    },
    {
      name: "spacing_y",
      label: "Spacing Y",
      type: "scalar",
      min: 0.01,
      max: 5,
      step: 0.01,
      default: 0.5,
      visibleIf: (p) => p.mode === "grid",
    },
    {
      name: "spacing_z",
      label: "Spacing Z",
      type: "scalar",
      min: 0.01,
      max: 5,
      step: 0.01,
      default: 0.5,
      visibleIf: (p) => p.mode === "grid",
    },
  ],
  linkedPairs: [
    { a: "count_x", b: "count_y" },
    { a: "count_x", b: "count_z" },
    { a: "spacing_x", b: "spacing_y" },
    { a: "spacing_x", b: "spacing_z" },
  ],
  primaryOutput: "points3d",
  auxOutputs: [],

  compute({ inputs, params }) {
    const mode = (params.mode as string) ?? "surface";
    if (mode === "grid") {
      return { primary: gridPoints(params) };
    }

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
