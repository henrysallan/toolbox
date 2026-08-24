import * as THREE from "three";
import type { NodeDefinition, RenderContext } from "@/engine/types";
import type { GeometryValue, InstancesValue } from "@/engine/three-types";

// =====================================================================
// Realize Instances — instances → geometry bake (081026 spec §4.4)
// =====================================================================
//
// The explicit exit from the instance domain: bakes every copy into ONE
// real BufferGeometry so the modeling chain works on the result (Extrude
// the copies, Scatter on the copies, project UVs across them…). This is
// deliberately a node, not a coercion — it multiplies vertex data by the
// instance count, and that cost belongs visibly in the graph.
//
// Per copy the full transform is TRS_i · M_source (same composition as
// the scene resolver, so realized and instanced renders overlay
// exactly). Normals go through each copy's normal matrix
// (inverse-transpose — correct under the non-uniform source transform).
// Output carries an IDENTITY transform: instances live in world space,
// so the bake is already placed. Instance colors are per-instance, not
// per-vertex — they don't survive realization (a realized mesh has one
// material); tint before realizing has no effect downstream, by design.
//
// Vertex budget guard: count × source verts is capped (~2M) — beyond it
// the bake clamps the instance count and warns, instead of silently
// building a browser-killing buffer.

const MAX_VERTS = 2_000_000;

interface RealizeState {
  geometry: THREE.BufferGeometry | null;
}

export const realizeInstances3DNode: NodeDefinition = {
  type: "realize-instances-3d",
  name: "Realize Instances",
  category: "3d",
  description:
    "Bakes an instance stream into one real geometry so modeling nodes (Extrude, Texture Projection, Scatter…) can operate on the copies. Costs count × vertices — that's the point of it being an explicit node.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [{ name: "instances", type: "instances", required: true }],
  params: [],
  primaryOutput: "geometry",
  auxOutputs: [],

  compute({ inputs, ctx, nodeId }) {
    const src = inputs.instances as InstancesValue | undefined;
    if (!src || src.kind !== "instances") return {};
    const key = `realize-instances-3d:${nodeId}`;
    let st = ctx.state[key] as RealizeState | undefined;
    if (!st) {
      st = { geometry: null };
      ctx.state[key] = st;
    }

    const srcGeom = src.source.geometry;
    const pos = srcGeom.getAttribute("position") as THREE.BufferAttribute;
    if (!pos) return {};
    const nrm = srcGeom.getAttribute("normal") as
      | THREE.BufferAttribute
      | undefined;
    const uv = srcGeom.getAttribute("uv") as THREE.BufferAttribute | undefined;
    const index = srcGeom.getIndex();
    const vertsPer = pos.count;

    let count = src.count;
    const total = count * vertsPer;
    if (total > MAX_VERTS) {
      count = Math.max(1, Math.floor(MAX_VERTS / vertsPer));
      console.warn(
        `Realize Instances: ${src.count} × ${vertsPer} verts exceeds the ` +
          `${MAX_VERTS} budget — realizing the first ${count} instances.`
      );
    }

    const outPos = new Float32Array(count * vertsPer * 3);
    const outNrm = nrm ? new Float32Array(count * vertsPer * 3) : null;
    const outUv = uv ? new Float32Array(count * vertsPer * 2) : null;
    const outIndex = index
      ? count * vertsPer > 65535
        ? new Uint32Array(count * index.count)
        : new Uint16Array(count * index.count)
      : null;

    // Source pre-transform, composed once.
    const t = src.source.transform;
    const mSrc = new THREE.Matrix4().compose(
      new THREE.Vector3(...t.position),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...t.rotationEuler)),
      new THREE.Vector3(...t.scale)
    );

    const m = new THREE.Matrix4();
    const nMat = new THREE.Matrix3();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const v = new THREE.Vector3();

    for (let i = 0; i < count; i++) {
      p.set(
        src.positions[i * 3],
        src.positions[i * 3 + 1],
        src.positions[i * 3 + 2]
      );
      q.set(
        src.quaternions[i * 4],
        src.quaternions[i * 4 + 1],
        src.quaternions[i * 4 + 2],
        src.quaternions[i * 4 + 3]
      );
      s.set(src.scales[i * 3], src.scales[i * 3 + 1], src.scales[i * 3 + 2]);
      m.compose(p, q, s).multiply(mSrc);
      nMat.getNormalMatrix(m);

      const vBase = i * vertsPer;
      for (let k = 0; k < vertsPer; k++) {
        v.fromBufferAttribute(pos, k).applyMatrix4(m);
        outPos[(vBase + k) * 3] = v.x;
        outPos[(vBase + k) * 3 + 1] = v.y;
        outPos[(vBase + k) * 3 + 2] = v.z;
        if (outNrm && nrm) {
          v.fromBufferAttribute(nrm, k).applyMatrix3(nMat).normalize();
          outNrm[(vBase + k) * 3] = v.x;
          outNrm[(vBase + k) * 3 + 1] = v.y;
          outNrm[(vBase + k) * 3 + 2] = v.z;
        }
        if (outUv && uv) {
          outUv[(vBase + k) * 2] = uv.getX(k);
          outUv[(vBase + k) * 2 + 1] = uv.getY(k);
        }
      }
      if (outIndex && index) {
        const iBase = i * index.count;
        for (let k = 0; k < index.count; k++) {
          outIndex[iBase + k] = index.getX(k) + vBase;
        }
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(outPos, 3));
    if (outNrm) geom.setAttribute("normal", new THREE.BufferAttribute(outNrm, 3));
    if (outUv) geom.setAttribute("uv", new THREE.BufferAttribute(outUv, 2));
    if (outIndex) geom.setIndex(new THREE.BufferAttribute(outIndex, 1));

    if (st.geometry) st.geometry.dispose();
    st.geometry = geom;

    const out: GeometryValue = {
      kind: "geometry",
      geometry: geom,
      nodeId,
      // World-space bake — already placed.
      transform: {
        position: [0, 0, 0],
        rotationEuler: [0, 0, 0],
        scale: [1, 1, 1],
      },
      materials: src.source.materials,
    };
    return { primary: out };
  },

  dispose(ctx: RenderContext, nodeId: string) {
    const key = `realize-instances-3d:${nodeId}`;
    const st = ctx.state[key] as RealizeState | undefined;
    if (st?.geometry) st.geometry.dispose();
    delete ctx.state[key];
  },
};
