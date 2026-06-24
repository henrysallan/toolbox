import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import type { NodeDefinition, RenderContext } from "@/engine/types";
import type { ModelFileParamValue } from "@/engine/types";
import type { Object3DValue } from "@/engine/three-types";

// =====================================================================
// Import 3D — load a GLB/glTF/OBJ model (M3-ish, lands early)
// =====================================================================
//
// Emits an `object3d` wrapping the loaded (retained) three.Object3D. The
// file is picked via the `model` param (model_file); loading is async, so
// the first eval kicks it off and a `pipeline-bump` re-evaluates when it
// lands. `fingerprintExtras` keys the cache on the file URL + load state so
// the just-loaded object isn't masked by a stale cache hit.
//
// Transform params match the primitives (pos/rot/scale) so the transform
// gizmo works on imported models too. OBJ has no embedded materials (a
// default is applied); GLB/glTF carry their own materials/textures.
// (DRACO-compressed GLBs aren't supported yet — no decoder wired.)

const DEG = Math.PI / 180;

interface ImportState {
  // Fallback when nothing is loaded yet (keeps a stable object3d so the
  // downstream scene/gizmo always have something to reference).
  empty: THREE.Group;
  object: THREE.Object3D | null;
  loadedUrl: string | null;
  loadingUrl: string | null;
}

function ensureState(ctx: RenderContext, nodeId: string): ImportState {
  const key = `import-3d:${nodeId}`;
  const existing = ctx.state[key] as ImportState | undefined;
  if (existing) return existing;
  const empty = new THREE.Group();
  empty.userData.nodeId = nodeId;
  const s: ImportState = {
    empty,
    object: null,
    loadedUrl: null,
    loadingUrl: null,
  };
  ctx.state[key] = s;
  return s;
}

function disposeObject(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = (mesh as THREE.Mesh).material;
    if (mat) {
      const mats = Array.isArray(mat) ? mat : [mat];
      for (const m of mats) {
        for (const k in m) {
          const v = (m as unknown as Record<string, unknown>)[k];
          if (v && (v as THREE.Texture).isTexture) (v as THREE.Texture).dispose();
        }
        m.dispose();
      }
    }
  });
}

function loadModel(url: string, format: string): Promise<THREE.Object3D> {
  if (format === "obj") {
    return new OBJLoader().loadAsync(url);
  }
  return new GLTFLoader().loadAsync(url).then((gltf) => gltf.scene);
}

function applyTransform(o: THREE.Object3D, params: Record<string, unknown>) {
  o.position.set(
    (params.pos_x as number) ?? 0,
    (params.pos_y as number) ?? 0,
    (params.pos_z as number) ?? 0
  );
  o.rotation.set(
    ((params.rot_x as number) ?? 0) * DEG,
    ((params.rot_y as number) ?? 0) * DEG,
    ((params.rot_z as number) ?? 0) * DEG
  );
  o.scale.set(
    (params.scale_x as number) ?? 1,
    (params.scale_y as number) ?? 1,
    (params.scale_z as number) ?? 1
  );
}

export const import3DNode: NodeDefinition = {
  type: "import-3d",
  name: "Import 3D",
  category: "3d",
  description:
    "Loads a 3D model (GLB / glTF / OBJ) as a scene object. Wire into the 3D Scene node.",
  backend: "webgl2",
  inputs: [],
  params: [
    { name: "model", label: "Model", type: "model_file", default: null },
    { name: "pos_x", label: "Position X", type: "scalar", min: -20, max: 20, softMax: 10, step: 0.01, default: 0 },
    { name: "pos_y", label: "Position Y", type: "scalar", min: -20, max: 20, softMax: 10, step: 0.01, default: 0 },
    { name: "pos_z", label: "Position Z", type: "scalar", min: -20, max: 20, softMax: 10, step: 0.01, default: 0 },
    { name: "rot_x", label: "Rotation X (°)", type: "scalar", min: -180, max: 180, step: 0.1, default: 0 },
    { name: "rot_y", label: "Rotation Y (°)", type: "scalar", min: -180, max: 180, step: 0.1, default: 0 },
    { name: "rot_z", label: "Rotation Z (°)", type: "scalar", min: -180, max: 180, step: 0.1, default: 0 },
    { name: "scale_x", label: "Scale X", type: "scalar", min: 0.001, max: 100, softMax: 10, step: 0.001, default: 1 },
    { name: "scale_y", label: "Scale Y", type: "scalar", min: 0.001, max: 100, softMax: 10, step: 0.001, default: 1 },
    { name: "scale_z", label: "Scale Z", type: "scalar", min: 0.001, max: 100, softMax: 10, step: 0.001, default: 1 },
  ],
  primaryOutput: "object3d",
  auxOutputs: [],

  // Bust the cache when the file changes or the async load completes.
  fingerprintExtras(params, ctx, nodeId) {
    const m = params.model as ModelFileParamValue | null | undefined;
    const url = m?.url ?? "";
    const st = ctx.state[`import-3d:${nodeId}`] as ImportState | undefined;
    const loaded = st && st.loadedUrl === url && url ? "1" : "0";
    return `${url}:${loaded}`;
  },

  compute({ params, ctx, nodeId }) {
    const st = ensureState(ctx, nodeId);
    const model = params.model as ModelFileParamValue | null | undefined;
    const url = model?.url ?? null;

    if (!url) {
      if (st.object) {
        disposeObject(st.object);
        st.object = null;
        st.loadedUrl = null;
      }
      applyTransform(st.empty, params);
      return { primary: { kind: "object3d", object: st.empty, variant: "group" } };
    }

    // Kick off (or replace) the load when the URL changes.
    if (url !== st.loadedUrl && url !== st.loadingUrl) {
      st.loadingUrl = url;
      loadModel(url, model?.format ?? "glb")
        .then((obj) => {
          if (st.loadingUrl !== url) {
            disposeObject(obj); // superseded by a newer pick
            return;
          }
          if (st.object) disposeObject(st.object);
          obj.userData.nodeId = nodeId;
          st.object = obj;
          st.loadedUrl = url;
          st.loadingUrl = null;
          window.dispatchEvent(new Event("pipeline-bump"));
        })
        .catch(() => {
          if (st.loadingUrl === url) st.loadingUrl = null;
        });
    }

    const out = st.object ?? st.empty;
    applyTransform(out, params);
    return { primary: { kind: "object3d", object: out, variant: "group" } };
  },

  dispose(ctx, nodeId) {
    const key = `import-3d:${nodeId}`;
    const st = ctx.state[key] as ImportState | undefined;
    if (st?.object) disposeObject(st.object);
    delete ctx.state[key];
  },
};
