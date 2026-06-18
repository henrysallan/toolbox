import * as THREE from "three";
import type { NodeDefinition, RenderContext } from "@/engine/types";
import type { Object3DValue } from "@/engine/three-types";

// =====================================================================
// Light — 3D scene light (M1)
// =====================================================================
//
// Emits an `object3d` (variant "light") wrapping a retained three.Light.
// Lights contribute to the scene by reaching Scene Render, same as any
// other object — they aren't special-cased (spec §2). Changing the light
// TYPE rebuilds the three object and returns a fresh ref; Scene Render's
// clear-and-re-add reconciliation drops the old one automatically.

type LightType = "directional" | "point" | "ambient";

interface LightState {
  light: THREE.Light;
  type: LightType;
}

function makeLight(type: LightType): THREE.Light {
  switch (type) {
    case "point":
      return new THREE.PointLight(0xffffff, 10);
    case "ambient":
      return new THREE.AmbientLight(0xffffff, 0.6);
    case "directional":
    default:
      return new THREE.DirectionalLight(0xffffff, 3);
  }
}

function ensureState(
  ctx: RenderContext,
  nodeId: string,
  type: LightType
): LightState {
  const key = `light-3d:${nodeId}`;
  const existing = ctx.state[key] as LightState | undefined;
  if (existing && existing.type === type) return existing;
  // First build, or the type changed → swap the retained object. (Lights
  // hold no GPU resources we use here — no shadow maps — so dropping the
  // old ref is enough; GC reclaims it once the scene drops it.)
  const light = makeLight(type);
  light.userData.nodeId = nodeId;
  const s: LightState = { light, type };
  ctx.state[key] = s;
  return s;
}

export const light3DNode: NodeDefinition = {
  type: "light-3d",
  name: "Light",
  category: "3d",
  description:
    "A scene light (directional, point, or ambient). Wire it into Scene Render alongside your objects.",
  backend: "webgl2",
  inputs: [],
  params: [
    {
      name: "type",
      label: "Type",
      type: "enum",
      options: ["directional", "point", "ambient"],
      default: "directional",
    },
    { name: "color", label: "Color", type: "color", default: "#ffffff" },
    { name: "intensity", label: "Intensity", type: "scalar", min: 0, max: 50, softMax: 10, step: 0.01, default: 3 },
    { name: "pos_x", label: "Position X", type: "scalar", min: -20, max: 20, softMax: 10, step: 0.01, default: 3, visibleIf: (p) => p.type !== "ambient" },
    { name: "pos_y", label: "Position Y", type: "scalar", min: -20, max: 20, softMax: 10, step: 0.01, default: 5, visibleIf: (p) => p.type !== "ambient" },
    { name: "pos_z", label: "Position Z", type: "scalar", min: -20, max: 20, softMax: 10, step: 0.01, default: 2, visibleIf: (p) => p.type !== "ambient" },
  ],
  primaryOutput: "object3d",
  auxOutputs: [],

  compute({ params, ctx, nodeId }) {
    const type = ((params.type as string) ?? "directional") as LightType;
    const { light } = ensureState(ctx, nodeId, type);

    light.color.set((params.color as string) ?? "#ffffff");
    light.intensity = (params.intensity as number) ?? 3;
    if (type !== "ambient") {
      light.position.set(
        (params.pos_x as number) ?? 3,
        (params.pos_y as number) ?? 5,
        (params.pos_z as number) ?? 2
      );
      // DirectionalLight shines from position toward its target, which
      // defaults to the world origin — exactly what we want for M1.
    }

    const out: Object3DValue = { kind: "object3d", object: light, variant: "light" };
    return { primary: out };
  },

  dispose(ctx, nodeId) {
    delete ctx.state[`light-3d:${nodeId}`];
  },
};
