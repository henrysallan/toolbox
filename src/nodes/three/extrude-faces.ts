import * as THREE from "three";
import type {
  NodeDefinition,
  RenderContext,
} from "@/engine/types";
import type { GeometryValue } from "@/engine/three-types";

// =====================================================================
// 3D Extrude — logical-face extrusion (081026 spec §5)
// =====================================================================
//
// Detects LOGICAL faces (regions of connected triangles whose face
// normals agree within the angle threshold — a cube reads as 6 faces, a
// cylinder as side + 2 caps, a plane as 1) and extrudes the selected one
// (`faces` index; −1 = every region independently, Blender's "extrude
// individual faces") along the surface normal by `depth`, stitching the
// region's boundary edge loop with side-wall quads.
//
// Adjacency is by POSITION, not index — three's primitives duplicate
// vertices per face for normals/uvs (a Box has 24 verts), so shared edges
// only exist after canonicalizing positions (quantized 1e-5). Offsets are
// PER-VERTEX region normals (area-weighted average of the region's faces
// at that position): identical to the face normal on flat regions, and a
// correct radial inflate on curved ones — a single averaged region normal
// would collapse toward zero on a cylinder side.
//
// The face index WRAPS (floor-mod) into the region count, so driving it
// with a counter cycles faces; `face_count` (aux scalar) reports the
// region count for that. Region ids are deterministic: BFS seeded in
// triangle-index order, so a keyframed index never flickers.
//
// Output is a NON-INDEXED soup: unchanged + cap triangles carry the
// input's normals/uvs (an offset doesn't change orientation, so smooth
// shading survives); walls get flat normals + (edge-length × depth) UVs.
// §1.2 ownership: the built geometry lives in this node's ctx.state,
// rebuilt per compute, input buffers never touched. Depth ≈ 0 passes the
// input geometry through by reference.

// Region/edge analysis shared with 3D Bevel — engine/three-mesh.ts.
import { analyzeRegions } from "@/engine/three-mesh";

interface ExtrudeState {
  geometry: THREE.BufferGeometry | null;
  faceCount: number;
}

function ensureState(ctx: RenderContext, nodeId: string): ExtrudeState {
  const key = `extrude-3d:${nodeId}`;
  const existing = ctx.state[key] as ExtrudeState | undefined;
  if (existing) return existing;
  const st: ExtrudeState = { geometry: null, faceCount: 0 };
  ctx.state[key] = st;
  return st;
}

export const extrudeFaces3DNode: NodeDefinition = {
  type: "extrude-3d",
  name: "3D Extrude",
  category: "3d",
  description:
    "Extrudes a logical face of the input geometry along its normal, stitching side walls at the boundary. Face index −1 extrudes every face independently; the index wraps around the face count (see the face_count output). Angle sets how far normals may differ and still count as one face — lower it for per-facet extrusion (spiky sphere).",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [{ name: "geometry", type: "geometry", required: true }],
  params: [
    {
      name: "depth",
      label: "Depth",
      type: "scalar",
      min: -2,
      max: 2,
      step: 0.001,
      default: 0.25,
    },
    {
      name: "faces",
      label: "Face index",
      type: "scalar",
      min: -1,
      max: 128,
      softMax: 32,
      step: 1,
      default: -1,
    },
    {
      name: "angle",
      label: "Angle (°)",
      type: "scalar",
      min: 0.1,
      max: 180,
      softMax: 60,
      step: 0.1,
      default: 30,
    },
  ],
  primaryOutput: "geometry",
  auxOutputs: [{ name: "face_count", type: "scalar", label: "face count" }],

  compute({ inputs, params, ctx, nodeId }) {
    const src = inputs.geometry as GeometryValue | undefined;
    if (!src || src.kind !== "geometry") return {};
    const st = ensureState(ctx, nodeId);

    const depth = (params.depth as number) ?? 0.25;
    const facesParam = Math.round((params.faces as number) ?? -1);
    const angle = (params.angle as number) ?? 30;

    const analysis = analyzeRegions(src.geometry, angle);
    if (!analysis) return {};
    const { tris, regions, regionOf, canonicalPos } = analysis;
    st.faceCount = regions.length;
    const faceCountOut = { kind: "scalar" as const, value: regions.length };

    // Depth ~0: pass the input geometry through by reference (no build).
    if (Math.abs(depth) < 1e-6) {
      if (st.geometry) {
        st.geometry.dispose();
        st.geometry = null;
      }
      const out: GeometryValue = { ...src, nodeId };
      return { primary: out, aux: { face_count: faceCountOut } };
    }

    // Selected regions: all, or the wrapped single index.
    const selected = new Set<number>();
    if (facesParam < 0) {
      for (let r = 0; r < regions.length; r++) selected.add(r);
    } else {
      selected.add(facesParam % regions.length);
    }

    const srcPos = src.geometry.getAttribute("position") as THREE.BufferAttribute;
    const srcNrm = src.geometry.getAttribute("normal") as
      | THREE.BufferAttribute
      | undefined;
    const srcUv = src.geometry.getAttribute("uv") as
      | THREE.BufferAttribute
      | undefined;

    // Per-region, per-canonical-vertex offset directions (area-weighted
    // average of the region's face normals at that position, normalized).
    const offsetDirs = new Map<number, Map<number, [number, number, number]>>();
    for (const r of selected) {
      const dirs = new Map<number, [number, number, number]>();
      for (const t of regions[r]) {
        const tt = tris[t];
        for (const c of [tt.c0, tt.c1, tt.c2]) {
          let d = dirs.get(c);
          if (!d) {
            d = [0, 0, 0];
            dirs.set(c, d);
          }
          d[0] += tt.nx * tt.area;
          d[1] += tt.ny * tt.area;
          d[2] += tt.nz * tt.area;
        }
      }
      for (const d of dirs.values()) {
        const len = Math.hypot(d[0], d[1], d[2]);
        if (len > 1e-12) {
          d[0] /= len;
          d[1] /= len;
          d[2] /= len;
        }
      }
      offsetDirs.set(r, dirs);
    }

    // Boundary edges per selected region: directed edges (as wound in the
    // region's triangles) that appear exactly once within the region.
    interface Wall {
      region: number;
      ca: number;
      cb: number; // canonical endpoints, directed a→b (region CCW)
    }
    const walls: Wall[] = [];
    for (const r of selected) {
      const dirCount = new Map<string, { ca: number; cb: number; n: number }>();
      const addEdge = (ca: number, cb: number) => {
        const uk = ca < cb ? `${ca}:${cb}` : `${cb}:${ca}`;
        const e = dirCount.get(uk);
        if (e) e.n++;
        else dirCount.set(uk, { ca, cb, n: 1 });
      };
      // Interior edges appear twice within a consistently-wound region
      // (opposite directions), boundary edges once — keeping n === 1
      // yields the boundary WITH its region-CCW winding direction.
      for (const t of regions[r]) {
        const tt = tris[t];
        addEdge(tt.c0, tt.c1);
        addEdge(tt.c1, tt.c2);
        addEdge(tt.c2, tt.c0);
      }
      for (const e of dirCount.values()) {
        if (e.n === 1) walls.push({ region: r, ca: e.ca, cb: e.cb });
      }
    }

    // ---- emit the soup ------------------------------------------------
    const wallTriCount = walls.length * 2;
    const outTriCount = tris.length + wallTriCount;
    const positions = new Float32Array(outTriCount * 9);
    const normals = new Float32Array(outTriCount * 9);
    const uvs = srcUv ? new Float32Array(outTriCount * 6) : null;

    const writeVert = (
      slot: number,
      vi: number,
      off: [number, number, number] | null
    ) => {
      const p3 = slot * 3;
      positions[p3] = srcPos.getX(vi) + (off ? off[0] * depth : 0);
      positions[p3 + 1] = srcPos.getY(vi) + (off ? off[1] * depth : 0);
      positions[p3 + 2] = srcPos.getZ(vi) + (off ? off[2] * depth : 0);
      if (srcNrm) {
        normals[p3] = srcNrm.getX(vi);
        normals[p3 + 1] = srcNrm.getY(vi);
        normals[p3 + 2] = srcNrm.getZ(vi);
      }
      if (uvs && srcUv) {
        uvs[slot * 2] = srcUv.getX(vi);
        uvs[slot * 2 + 1] = srcUv.getY(vi);
      }
    };

    let slot = 0;
    for (let t = 0; t < tris.length; t++) {
      const tt = tris[t];
      const r = regionOf[t];
      const dirs = selected.has(r) ? offsetDirs.get(r) : undefined;
      if (dirs) {
        writeVert(slot++, tt.i0, dirs.get(tt.c0) ?? null);
        writeVert(slot++, tt.i1, dirs.get(tt.c1) ?? null);
        writeVert(slot++, tt.i2, dirs.get(tt.c2) ?? null);
        // Face normals unchanged for FLAT regions; for curved ones the
        // inflate slightly changes them, but the carried smooth normals
        // remain the right shading (same as three's own morphs).
        if (!srcNrm) {
          flatNormal(positions, normals, slot - 3);
        }
      } else {
        writeVert(slot++, tt.i0, null);
        writeVert(slot++, tt.i1, null);
        writeVert(slot++, tt.i2, null);
        if (!srcNrm) flatNormal(positions, normals, slot - 3);
      }
    }

    // Walls. Directed edge a→b wound with the region CCW (outward), base
    // at the ORIGINAL positions, top at the offset positions — triangles
    // (A, B, B') and (A, B', A') face outward for positive depth.
    for (const w of walls) {
      const dirs = offsetDirs.get(w.region)!;
      const oa = dirs.get(w.ca) ?? ([0, 0, 0] as [number, number, number]);
      const ob = dirs.get(w.cb) ?? ([0, 0, 0] as [number, number, number]);
      const ax = canonicalPos[w.ca * 3];
      const ay = canonicalPos[w.ca * 3 + 1];
      const az = canonicalPos[w.ca * 3 + 2];
      const bx = canonicalPos[w.cb * 3];
      const by = canonicalPos[w.cb * 3 + 1];
      const bz = canonicalPos[w.cb * 3 + 2];
      const atx = ax + oa[0] * depth;
      const aty = ay + oa[1] * depth;
      const atz = az + oa[2] * depth;
      const btx = bx + ob[0] * depth;
      const bty = by + ob[1] * depth;
      const btz = bz + ob[2] * depth;
      const eLen = Math.hypot(bx - ax, by - ay, bz - az);
      const dAbs = Math.abs(depth);

      const emit = (
        p: [number, number, number][],
        uv: [number, number][]
      ) => {
        const base = slot * 3;
        for (let k = 0; k < 3; k++) {
          positions[base + k * 3] = p[k][0];
          positions[base + k * 3 + 1] = p[k][1];
          positions[base + k * 3 + 2] = p[k][2];
          if (uvs) {
            uvs[slot * 2 + k * 2] = uv[k][0];
            uvs[slot * 2 + k * 2 + 1] = uv[k][1];
          }
        }
        flatNormal(positions, normals, slot);
        slot += 3;
      };
      emit(
        [
          [ax, ay, az],
          [bx, by, bz],
          [btx, bty, btz],
        ],
        [
          [0, 0],
          [eLen, 0],
          [eLen, dAbs],
        ]
      );
      emit(
        [
          [ax, ay, az],
          [btx, bty, btz],
          [atx, aty, atz],
        ],
        [
          [0, 0],
          [eLen, dAbs],
          [0, dAbs],
        ]
      );
    }

    // Retained output geometry: dispose the previous build, keep the new.
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geom.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    if (uvs) geom.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    if (st.geometry) st.geometry.dispose();
    st.geometry = geom;

    const out: GeometryValue = {
      kind: "geometry",
      geometry: geom,
      nodeId,
      transform: src.transform,
      materials: src.materials,
    };
    return { primary: out, aux: { face_count: faceCountOut } };
  },

  dispose(ctx, nodeId) {
    const st = ctx.state[`extrude-3d:${nodeId}`] as ExtrudeState | undefined;
    if (st?.geometry) st.geometry.dispose();
    delete ctx.state[`extrude-3d:${nodeId}`];
  },
};

// Write the flat face normal for the triangle occupying slots s..s+2.
function flatNormal(
  positions: Float32Array,
  normals: Float32Array,
  s: number
): void {
  const b = s * 3;
  const ax = positions[b];
  const ay = positions[b + 1];
  const az = positions[b + 2];
  const ux = positions[b + 3] - ax;
  const uy = positions[b + 4] - ay;
  const uz = positions[b + 5] - az;
  const vx = positions[b + 6] - ax;
  const vy = positions[b + 7] - ay;
  const vz = positions[b + 8] - az;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len;
  ny /= len;
  nz /= len;
  for (let k = 0; k < 3; k++) {
    normals[b + k * 3] = nx;
    normals[b + k * 3 + 1] = ny;
    normals[b + k * 3 + 2] = nz;
  }
}
