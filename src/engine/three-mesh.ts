// =====================================================================
// Shared mesh analysis for 3D modeling ops (extracted from extrude-faces
// for Bevel — 081026 spec M8)
// =====================================================================
//
// Region detection over a BufferGeometry: canonical position ids
// (quantized 1e-5 — three's primitives duplicate vertices per face, so
// shared edges only exist after canonicalization), an undirected
// edge→triangles map, and BFS region-grow merging across edges whose
// face normals agree within the angle threshold. Deterministic: BFS
// seeded in triangle-index order.

import * as THREE from "three";

const QUANT = 1e5;

export interface TriInfo {
  i0: number;
  i1: number;
  i2: number; // original vertex indices
  c0: number;
  c1: number;
  c2: number; // canonical position ids
  nx: number;
  ny: number;
  nz: number; // unit face normal
  area: number;
}

export interface MeshAnalysis {
  tris: TriInfo[];
  regions: number[][]; // region id → tri ids (ascending)
  regionOf: Int32Array; // tri id → region id
  canonicalPos: Float32Array; // canonical id → xyz
  edgeTris: Map<string, number[]>; // edgeKey → adjacent tri ids
}

export function edgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export function analyzeRegions(
  geom: THREE.BufferGeometry,
  angleDeg: number
): MeshAnalysis | null {
  const pos = geom.getAttribute("position");
  if (!pos) return null;
  const index = geom.getIndex();
  const triCount = Math.floor((index ? index.count : pos.count) / 3);
  if (triCount === 0) return null;

  const canon = new Map<string, number>();
  const canonXyz: number[] = [];
  const canonOf = (vi: number): number => {
    const x = pos.getX(vi);
    const y = pos.getY(vi);
    const z = pos.getZ(vi);
    const key = `${Math.round(x * QUANT)},${Math.round(y * QUANT)},${Math.round(z * QUANT)}`;
    let id = canon.get(key);
    if (id === undefined) {
      id = canonXyz.length / 3;
      canon.set(key, id);
      canonXyz.push(x, y, z);
    }
    return id;
  };

  const tris: TriInfo[] = [];
  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const vc = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    va.fromBufferAttribute(pos as THREE.BufferAttribute, i0);
    vb.fromBufferAttribute(pos as THREE.BufferAttribute, i1);
    vc.fromBufferAttribute(pos as THREE.BufferAttribute, i2);
    ab.subVectors(vb, va);
    ac.subVectors(vc, va);
    ab.cross(ac);
    const twoArea = ab.length();
    if (twoArea <= 1e-12) continue; // degenerate
    tris.push({
      i0,
      i1,
      i2,
      c0: canonOf(i0),
      c1: canonOf(i1),
      c2: canonOf(i2),
      nx: ab.x / twoArea,
      ny: ab.y / twoArea,
      nz: ab.z / twoArea,
      area: twoArea / 2,
    });
  }

  const edgeTris = new Map<string, number[]>();
  for (let t = 0; t < tris.length; t++) {
    const { c0, c1, c2 } = tris[t];
    for (const k of [edgeKey(c0, c1), edgeKey(c1, c2), edgeKey(c2, c0)]) {
      const arr = edgeTris.get(k);
      if (arr) arr.push(t);
      else edgeTris.set(k, [t]);
    }
  }

  const cosThresh = Math.cos((Math.max(0.1, angleDeg) * Math.PI) / 180);
  const regionOf = new Int32Array(tris.length).fill(-1);
  const regions: number[][] = [];
  for (let seed = 0; seed < tris.length; seed++) {
    if (regionOf[seed] !== -1) continue;
    const id = regions.length;
    const members: number[] = [];
    const queue = [seed];
    regionOf[seed] = id;
    while (queue.length) {
      const t = queue.pop()!;
      members.push(t);
      const tt = tris[t];
      for (const k of [
        edgeKey(tt.c0, tt.c1),
        edgeKey(tt.c1, tt.c2),
        edgeKey(tt.c2, tt.c0),
      ]) {
        for (const other of edgeTris.get(k)!) {
          if (regionOf[other] !== -1) continue;
          const ot = tris[other];
          const dot = tt.nx * ot.nx + tt.ny * ot.ny + tt.nz * ot.nz;
          if (dot >= cosThresh) {
            regionOf[other] = id;
            queue.push(other);
          }
        }
      }
    }
    members.sort((a, b) => a - b);
    regions.push(members);
  }

  return {
    tris,
    regions,
    regionOf,
    canonicalPos: new Float32Array(canonXyz),
    edgeTris,
  };
}
