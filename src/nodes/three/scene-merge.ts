import * as THREE from "three";
import type { NodeDefinition, InputSocketDef, RenderContext } from "@/engine/types";
import type { Object3DValue } from "@/engine/three-types";

// =====================================================================
// Scene Merge (M1) — combine many objects into one
// =====================================================================
//
// Collects up to 8 object3d inputs into one retained three.Group and emits
// it as a single object3d (variant "group"). Lets a scene exceed Scene
// Render's fixed input slots — chain merges (merge → merge) for more. Same
// clear-and-re-add membership reconciliation as Scene Render; the grouped
// objects are reparented under this node's group (fine for the normal
// single-consumer wiring).

const SLOTS = 8;

interface MergeState {
  group: THREE.Group;
}

const SLOT_INPUTS: InputSocketDef[] = Array.from({ length: SLOTS }, (_, i) => ({
  name: `object:${i + 1}`,
  label: `object ${i + 1}`,
  type: "object3d" as const,
  required: false,
}));

export const sceneMergeNode: NodeDefinition = {
  type: "scene-merge",
  name: "Scene Merge",
  category: "3d",
  description: "Combines several 3D objects into one group for the 3D Scene node.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: SLOT_INPUTS,
  params: [],
  primaryOutput: "object3d",
  auxOutputs: [],

  compute({ inputs, ctx, nodeId }: { inputs: Record<string, unknown>; ctx: RenderContext; nodeId: string }) {
    const key = `scene-merge:${nodeId}`;
    let st = ctx.state[key] as MergeState | undefined;
    if (!st) {
      st = { group: new THREE.Group() };
      st.group.userData.nodeId = nodeId;
      ctx.state[key] = st;
    }
    st.group.clear();
    for (let i = 1; i <= SLOTS; i++) {
      const v = inputs[`object:${i}`] as Object3DValue | undefined;
      if (v && v.kind === "object3d") st.group.add(v.object);
    }
    const out: Object3DValue = { kind: "object3d", object: st.group, variant: "group" };
    return { primary: out };
  },

  dispose(ctx: RenderContext, nodeId: string) {
    const st = ctx.state[`scene-merge:${nodeId}`] as MergeState | undefined;
    if (st) st.group.clear();
    delete ctx.state[`scene-merge:${nodeId}`];
  },
};
