import type { ImageValue, NodeDefinition } from "@/engine/types";
import type { GeometryValue, MaterialDesc } from "@/engine/three-types";
import { makeMaterialDesc } from "@/engine/three-geometry";

// =====================================================================
// Bump — surface-detail perturbation (mesh shader node)
// =====================================================================
//
// Flow-through like the Material node: `geometry → Bump → geometry`,
// with slot 0's desc rebuilt to carry a `bump` channel. Two reads of the
// wired image:
//   bump   — height map: brightness differences perturb normals (three's
//            bumpMap/bumpScale). Any grayscale/noise image works.
//   normal — tangent-space normal map (the purple kind): bumpMap's
//            higher-fidelity sibling (normalMap/normalScale).
//
// Order-independent with Material: Bump AFTER Material perturbs the
// styled surface; Material AFTER Bump preserves the bump channel (its
// desc rebuild carries `bump` through). The texture crosses into three's
// isolated context via the standard bridge (identity-cached readback) at
// the object3d boundary — this node is pure CPU data, free per eval.
//
// If nothing upstream authored a material, the desc seeds from the
// default-material look (white, roughness 1) so adding Bump doesn't
// change the shading, only the surface detail.

export const bump3DNode: NodeDefinition = {
  type: "bump-3d",
  name: "Bump",
  category: "3d",
  description:
    "Adds surface detail to 3D geometry from an image — bump mode reads it as a height map (brightness = relief), normal mode reads it as a tangent-space normal map. Chain with Material in either order.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [
    { name: "geometry", type: "geometry", required: true },
    { name: "map", type: "image", required: true, label: "Map" },
  ],
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["bump", "normal"],
      default: "bump",
      control: "segmented",
    },
    {
      name: "strength",
      label: "Strength",
      type: "scalar",
      min: -3,
      max: 3,
      softMax: 2,
      step: 0.01,
      default: 1,
    },
  ],
  primaryOutput: "geometry",
  auxOutputs: [],

  compute({ inputs, params, nodeId }) {
    const src = inputs.geometry as GeometryValue | undefined;
    if (!src || src.kind !== "geometry") return {};
    const mapIn = inputs.map;
    if (!mapIn || mapIn.kind !== "image") return { primary: src };

    const base: Omit<MaterialDesc, "kind" | "sig"> = src.materials[0] ?? {
      // Match buildMaterial(null)'s default-material look.
      baseColor: "#ffffff",
      roughness: 1,
      metalness: 0,
      transmission: 0,
      ior: 1.5,
      alpha: 1,
    };
    const desc = makeMaterialDesc({
      ...base,
      bump: {
        map: mapIn as ImageValue,
        strength: (params.strength as number) ?? 1,
        mode: ((params.mode as string) ?? "bump") === "normal" ? "normal" : "bump",
      },
    });

    const out: GeometryValue = {
      ...src,
      nodeId,
      materials: [desc, ...src.materials.slice(1)],
    };
    return { primary: out };
  },
};
