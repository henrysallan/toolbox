import type { NodeDefinition, RenderContext } from "@/engine/types";
import type { ModelFileParamValue } from "@/engine/types";
import type { GeometryValue } from "@/engine/three-types";
import {
  acquireModel,
  releaseModel,
  resolveModelGeometry,
  type ModelCacheEntry,
  type ModelFormat,
} from "@/engine/model-cache";

// =====================================================================
// Import 3D — load a GLB/glTF/OBJ/STL model as GEOMETRY
// =====================================================================
//
// Emits a `geometry` value (2026-08-16 rework — was object3d), so an
// imported model enters the modeling chain like any primitive: Bevel it,
// Material it, Scatter on it, Copy it to points.
//
// Loading/parsing lives in the shared refcounted model cache
// (engine/model-cache.ts, 081626_glb-scene-import.md §1) — N nodes on the
// same file parse it once. The `object` param selects what this node
// emits: "" merges the whole scene with world transforms baked (today's
// behavior for STL/OBJ and single-object files), "top:<i>" emits one
// top-level scene object merged in its LOCAL frame — the GLB scene-group
// expansion pairs that with the object's world TRS baked into this
// node's pos/rot/scale params, so each object lands posed as the file
// placed it and stays movable/keyframable from there.
//
// Materials: a merged mesh has one slot, so the selection's first
// standard material seeds slot 0 as scalar channels (base color /
// roughness / metalness — embedded textures can't cross into the engine;
// wire a Material node for full control). STL/OBJ-without-MTL get the
// default material.
//
// Loading is async: the first eval kicks it off and the cache's
// `pipeline-bump` re-evaluates when it lands. `fingerprintExtras` keys
// the cache on the file URL + load state so the just-loaded geometry
// isn't masked by a stale cache hit (the `object` selection is ordinary
// params and fingerprints on its own).
// (DRACO-compressed GLBs aren't supported yet — no decoder wired.)

const DEG = Math.PI / 180;

// Per-context node state; doubles as the cache-ref identity token.
interface ImportState {
  url: string | null;
  entry: ModelCacheEntry | null;
}

function ensureState(ctx: RenderContext, nodeId: string): ImportState {
  const key = `import-3d:${nodeId}`;
  const existing = ctx.state[key] as ImportState | undefined;
  if (existing) return existing;
  const s: ImportState = { url: null, entry: null };
  ctx.state[key] = s;
  return s;
}

export const import3DNode: NodeDefinition = {
  type: "import-3d",
  name: "Import 3D",
  category: "3d",
  description:
    "Loads a 3D model (GLB / glTF / OBJ / STL) as geometry — bevel it, apply a Material, scatter points on it, or wire it straight into the 3D Scene. The Object picker emits one scene object; \"All\" merges the file. Drop a file onto the node editor to create this node pre-loaded.",
  backend: "webgl2",
  inputs: [],
  params: [
    { name: "model", label: "Model", type: "model_file", default: null },
    {
      name: "object",
      label: "Object",
      type: "enum",
      options: [],
      default: "",
      control: "model_object",
      // Only scene-container formats have objects to pick from.
      visibleIf: (p) => {
        const m = p.model as ModelFileParamValue | null | undefined;
        return !!m && (m.format === "glb" || m.format === "gltf");
      },
    },
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
  primaryOutput: "geometry",
  auxOutputs: [],

  // Bust the cache when the file changes or the async load completes.
  fingerprintExtras(params, ctx, nodeId) {
    const m = params.model as ModelFileParamValue | null | undefined;
    const url = m?.url ?? "";
    const st = ctx.state[`import-3d:${nodeId}`] as ImportState | undefined;
    const status =
      st && st.url === url && url ? st.entry?.status ?? "loading" : "none";
    return `${url}:${status}`;
  },

  compute({ params, ctx, nodeId }) {
    const st = ensureState(ctx, nodeId);
    const model = params.model as ModelFileParamValue | null | undefined;
    const url = model?.url ?? null;

    if (st.url && st.url !== url) {
      releaseModel(st.url, st);
      st.url = null;
      st.entry = null;
    }
    if (!url) return {};
    if (!st.entry) {
      st.entry = acquireModel(url, (model?.format ?? "glb") as ModelFormat, st);
      st.url = url;
    }

    const sel = resolveModelGeometry(st.entry, (params.object as string) ?? "");
    if (!sel) return {};

    const out: GeometryValue = {
      kind: "geometry",
      geometry: sel.geometry,
      nodeId,
      transform: {
        position: [
          (params.pos_x as number) ?? 0,
          (params.pos_y as number) ?? 0,
          (params.pos_z as number) ?? 0,
        ],
        rotationEuler: [
          ((params.rot_x as number) ?? 0) * DEG,
          ((params.rot_y as number) ?? 0) * DEG,
          ((params.rot_z as number) ?? 0) * DEG,
        ],
        scale: [
          (params.scale_x as number) ?? 1,
          (params.scale_y as number) ?? 1,
          (params.scale_z as number) ?? 1,
        ],
      },
      materials: [sel.material],
    };
    return { primary: out };
  },

  dispose(ctx, nodeId) {
    const key = `import-3d:${nodeId}`;
    const st = ctx.state[key] as ImportState | undefined;
    if (st?.url) releaseModel(st.url, st);
    delete ctx.state[key];
  },
};
