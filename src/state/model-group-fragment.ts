// GLB scene → node-group fragment (081626_glb-scene-import.md §2).
//
// Pure assembly: takes the parsed file's ModelSceneIndex (from the shared
// model cache) and builds the expansion group — one Import 3D per
// top-level object (same shared ModelFileParamValue, `object` token, the
// object's world TRS baked into its pose params), a Light / Camera node
// per scene light/camera with the file's values baked, optional
// base-color texture chains (Image Source → Material.base_color_map),
// and every one of them on a named group output socket. The result rides
// `groupFragment` (structurally a Cmd+G group) and inserts through the
// preset path (cloneSubgraph), so it's an ordinary group once dropped.
//
// No three, no DOM (ImageBitmaps pass through opaquely) — guarded by
// scripts/check-model-group.mts with synthetic indexes.

import type { Edge } from "@xyflow/react";
import type { ModelFileParamValue } from "@/engine/types";
import {
  modelObjectToken,
  type ModelSceneIndex,
} from "@/engine/model-cache";
import {
  makeInstanceNode,
  newEdgeId,
  refreshNodeSockets,
  type GraphNode,
} from "@/state/graph-ops";
import { groupFragment, type GroupOutputSpec } from "@/state/group-fragment";
import { VIRTUAL_SOCKET } from "@/engine/groups";

const RAD2DEG = 180 / Math.PI;

// The expansion rule lives engine-side (the loader consults it at parse
// time for base-color extraction); re-exported here so editor code and
// the check script read builder + rule from one module.
export { shouldExpandModel } from "@/engine/model-cache";

// Group socket names are handle ids (`in:<name>` / `out:aux:<name>`), so
// ":" must not survive; empty names fall back per kind.
function sanitizeSocketName(raw: string, fallback: string): string {
  const s = raw.replace(/:/g, " ").replace(/\s+/g, " ").trim();
  return s || fallback;
}

function dedupeName(used: Set<string>, name: string): string {
  let n = name;
  let i = 2;
  while (used.has(n)) n = `${name} ${i++}`;
  used.add(n);
  return n;
}

function node(
  type: string,
  pos: { x: number; y: number },
  params?: Record<string, unknown>
): GraphNode {
  const n = makeInstanceNode(type, pos);
  if (params) n.data.params = { ...n.data.params, ...params };
  return refreshNodeSockets(n);
}

function edge(
  a: GraphNode,
  sourceHandle: string,
  b: GraphNode,
  targetHandle: string
): Edge {
  return {
    id: newEdgeId(),
    source: a.id,
    sourceHandle,
    target: b.id,
    targetHandle,
  };
}

export function modelGroupFragment(opts: {
  index: ModelSceneIndex;
  // Shared by EVERY interior import node — one URL, one cache entry, and
  // the future per-file rehydration (R2 spec) heals the whole group at
  // once (081626 §6).
  model: ModelFileParamValue;
  name: string; // group display name (usually the file label)
  // M4: extracted baseColor bitmaps keyed by top-level object index.
  baseColorMaps?: Map<number, ImageBitmap>;
}): { nodes: GraphNode[]; edges: Edge[] } {
  const { index, model } = opts;
  const interior: GraphNode[] = [];
  const edges: Edge[] = [];
  const outputs: GroupOutputSpec[] = [];
  const used = new Set<string>([VIRTUAL_SOCKET]);
  let y = 0;

  for (const obj of index.objects) {
    const imp = node(
      "import-3d",
      { x: 0, y },
      {
        model,
        object: modelObjectToken(obj.index),
        // Bake the object's world pose so it lands where the file put it
        // and stays movable from there. Shear fallback (trs null): the
        // geometry is already world-baked, params stay default.
        ...(obj.trs
          ? {
              pos_x: obj.trs.position[0],
              pos_y: obj.trs.position[1],
              pos_z: obj.trs.position[2],
              rot_x: obj.trs.rotationEuler[0] * RAD2DEG,
              rot_y: obj.trs.rotationEuler[1] * RAD2DEG,
              rot_z: obj.trs.rotationEuler[2] * RAD2DEG,
              scale_x: obj.trs.scale[0],
              scale_y: obj.trs.scale[1],
              scale_z: obj.trs.scale[2],
            }
          : {}),
      }
    );
    imp.data.name = obj.label;
    interior.push(imp);

    const sockName = dedupeName(
      used,
      sanitizeSocketName(obj.name, obj.label)
    );
    const bitmap = opts.baseColorMaps?.get(obj.index);
    if (bitmap) {
      // Textured object: Image Source → Material.base_color_map, mesh
      // routed through the Material node (scalars re-seeded there).
      const img = node("image-source", { x: 300, y }, { file: bitmap });
      img.data.name = `${obj.label} basecolor`;
      const mat = node(
        "material-3d",
        { x: 620, y },
        obj.seed
          ? {
              base_color: obj.seed.baseColor,
              roughness: obj.seed.roughness,
              metalness: obj.seed.metalness,
            }
          : {}
      );
      mat.data.name = `${obj.label} material`;
      interior.push(img, mat);
      edges.push(
        edge(imp, "out:primary", mat, "in:geometry"),
        edge(img, "out:primary", mat, "in:base_color_map")
      );
      outputs.push({
        from: { nodeId: mat.id, handle: "out:primary" },
        name: sockName,
        type: "geometry",
      });
    } else {
      outputs.push({
        from: { nodeId: imp.id, handle: "out:primary" },
        name: sockName,
        type: "geometry",
      });
    }
    y += 200;
  }

  for (const l of index.lights) {
    const lt = node(
      "light-3d",
      { x: 0, y },
      {
        type: l.kind,
        color: l.color,
        intensity: l.intensity,
        pos_x: l.position[0],
        pos_y: l.position[1],
        pos_z: l.position[2],
        target_x: l.target[0],
        target_y: l.target[1],
        target_z: l.target[2],
        ...(l.kind === "spot"
          ? {
              angle: l.angleDeg ?? 40,
              penumbra: l.penumbra ?? 0.25,
              distance: l.distance ?? 0,
            }
          : {}),
      }
    );
    lt.data.name = l.label;
    interior.push(lt);
    outputs.push({
      from: { nodeId: lt.id, handle: "out:primary" },
      name: dedupeName(used, sanitizeSocketName(l.name, l.label)),
      type: "object3d",
    });
    y += 200;
  }

  for (const c of index.cameras) {
    const cam = node(
      "camera-3d",
      { x: 0, y },
      {
        projection: c.projection,
        fov: c.fov,
        near: c.near,
        far: c.far,
        ...(c.orthoHeight !== undefined ? { ortho_height: c.orthoHeight } : {}),
        pos_x: c.position[0],
        pos_y: c.position[1],
        pos_z: c.position[2],
        target_x: c.target[0],
        target_y: c.target[1],
        target_z: c.target[2],
      }
    );
    cam.data.name = c.label;
    interior.push(cam);
    outputs.push({
      from: { nodeId: cam.id, handle: "out:primary" },
      name: dedupeName(used, sanitizeSocketName(c.name, c.label)),
      type: "camera",
    });
    y += 200;
  }

  return groupFragment({
    name: opts.name,
    interior,
    edges,
    outputs,
  });
}
