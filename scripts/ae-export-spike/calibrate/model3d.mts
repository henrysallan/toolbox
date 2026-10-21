// Test models for the 3D lane (M4 lane 5, specdocs/ae-m4/3d.md): small GLB and
// OBJ files written from structure, so toolbox (three's loaders) and After
// Effects import byte-identical geometry.
//
//   axes    a unit cube at the origin plus three 0.3 cubes at +X, +Y, +Z —
//           shows axis directions and framing (sharp silhouette corners).
//   sphere  a UV sphere, radius 1 — every N·L, for the light calibration.
//
// One material per file (toolbox merges a model into one slot, so per-mesh
// materials would not compare). glTF units are metres = toolbox world units.

export interface TestMesh {
  positions: number[]; // xyz per vertex
  normals: number[];
  indices: number[];
}

// A cube of side `s` centred on `c`, 24 vertices (flat faces).
export function cube(s: number, c: [number, number, number] = [0, 0, 0]): TestMesh {
  const h = s / 2;
  const faces: { n: [number, number, number]; u: [number, number, number]; v: [number, number, number] }[] = [
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
  ];
  const m: TestMesh = { positions: [], normals: [], indices: [] };
  for (const f of faces) {
    const base = m.positions.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      for (let k = 0; k < 3; k++) m.positions.push(c[k] + h * (f.n[k] + a * f.u[k] + b * f.v[k]));
      m.normals.push(...f.n);
    }
    m.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return m;
}

export function sphere(r = 1, rings = 48, segs = 96): TestMesh {
  const m: TestMesh = { positions: [], normals: [], indices: [] };
  for (let i = 0; i <= rings; i++) {
    const th = (i / rings) * Math.PI;
    for (let j = 0; j <= segs; j++) {
      const ph = (j / segs) * 2 * Math.PI;
      const n = [Math.sin(th) * Math.cos(ph), Math.cos(th), -Math.sin(th) * Math.sin(ph)];
      m.positions.push(n[0] * r, n[1] * r, n[2] * r);
      m.normals.push(...n);
    }
  }
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < segs; j++) {
      const a = i * (segs + 1) + j;
      const b = a + segs + 1;
      m.indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  return m;
}

export function merge(...parts: TestMesh[]): TestMesh {
  const m: TestMesh = { positions: [], normals: [], indices: [] };
  for (const p of parts) {
    const base = m.positions.length / 3;
    m.positions.push(...p.positions);
    m.normals.push(...p.normals);
    m.indices.push(...p.indices.map((i) => i + base));
  }
  return m;
}

export function axesModel(): TestMesh {
  return merge(cube(1), cube(0.3, [1, 0, 0]), cube(0.3, [0, 1, 0]), cube(0.3, [0, 0, 1]));
}

export interface TestMaterial {
  baseColor: [number, number, number]; // linear, glTF's convention
  metallic: number;
  roughness: number;
}

const pad4 = (n: number) => (n + 3) & ~3;

// One mesh, one node, one material → a binary glTF 2.0 file.
export function writeGlb(mesh: TestMesh, mat: TestMaterial, name = "model"): Uint8Array {
  const nv = mesh.positions.length / 3;
  const pos = new Float32Array(mesh.positions);
  const nor = new Float32Array(mesh.normals);
  const idx = new Uint32Array(mesh.indices);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nv; i++)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], pos[i * 3 + k]);
      max[k] = Math.max(max[k], pos[i * 3 + k]);
    }
  const bin = new Uint8Array(pos.byteLength + nor.byteLength + idx.byteLength);
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(new Uint8Array(nor.buffer), pos.byteLength);
  bin.set(new Uint8Array(idx.buffer), pos.byteLength + nor.byteLength);
  const json = {
    asset: { version: "2.0", generator: "toolbox ae-export 3d lane" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name }],
    meshes: [{ name, primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{ name: `${name}-mat`, pbrMetallicRoughness: { baseColorFactor: [...mat.baseColor, 1], metallicFactor: mat.metallic, roughnessFactor: mat.roughness } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: nv, type: "VEC3", min, max },
      { bufferView: 1, componentType: 5126, count: nv, type: "VEC3" },
      { bufferView: 2, componentType: 5125, count: idx.length, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: nor.byteLength, target: 34962 },
      { buffer: 0, byteOffset: pos.byteLength + nor.byteLength, byteLength: idx.byteLength, target: 34963 },
    ],
    buffers: [{ byteLength: bin.byteLength }],
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jl = pad4(jsonBytes.length);
  const bl = pad4(bin.length);
  const out = new Uint8Array(12 + 8 + jl + 8 + bl);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // "glTF"
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, jl, true);
  dv.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.fill(0x20, 20, 20 + jl);
  out.set(jsonBytes, 20);
  dv.setUint32(20 + jl, bl, true);
  dv.setUint32(24 + jl, 0x004e4942, true); // "BIN\0"
  out.set(bin, 28 + jl);
  return out;
}

export function writeObj(mesh: TestMesh, name = "model"): string {
  const lines = [`# toolbox ae-export 3d lane test model`, `o ${name}`];
  for (let i = 0; i < mesh.positions.length; i += 3) lines.push(`v ${mesh.positions[i]} ${mesh.positions[i + 1]} ${mesh.positions[i + 2]}`);
  for (let i = 0; i < mesh.normals.length; i += 3) lines.push(`vn ${mesh.normals[i]} ${mesh.normals[i + 1]} ${mesh.normals[i + 2]}`);
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = [mesh.indices[i] + 1, mesh.indices[i + 1] + 1, mesh.indices[i + 2] + 1];
    lines.push(`f ${a}//${a} ${b}//${b} ${c}//${c}`);
  }
  return lines.join("\n") + "\n";
}
