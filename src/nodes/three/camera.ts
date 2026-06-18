import type { NodeDefinition } from "@/engine/types";
import type { CameraValue } from "@/engine/three-types";

// =====================================================================
// Camera — 3D scene camera (M1)
// =====================================================================
//
// Emits a `camera` descriptor (pure CPU data, no retained GPU object).
// Scene Render constructs/updates its own three camera from this each
// frame. Wire one into Scene Render's `camera` input — that's the "active
// camera" the scene renders from (spec §7). M1 uses position + a look-at
// target; a Transform 3D node + gizmo will generalize the framing later.

export const camera3DNode: NodeDefinition = {
  type: "camera-3d",
  name: "Camera",
  category: "3d",
  description:
    "A scene camera. Wire it into Scene Render's camera input to choose the view the scene renders from.",
  backend: "webgl2",
  inputs: [],
  params: [
    {
      name: "projection",
      label: "Projection",
      type: "enum",
      options: ["perspective", "orthographic"],
      default: "perspective",
    },
    { name: "fov", label: "FOV (°)", type: "scalar", min: 5, max: 120, step: 0.1, default: 45, visibleIf: (p) => p.projection !== "orthographic" },
    { name: "ortho_height", label: "Ortho height", type: "scalar", min: 0.1, max: 50, softMax: 10, step: 0.01, default: 3, visibleIf: (p) => p.projection === "orthographic" },
    { name: "near", label: "Near", type: "scalar", min: 0.001, max: 10, softMax: 1, step: 0.001, default: 0.1 },
    { name: "far", label: "Far", type: "scalar", min: 1, max: 10000, softMax: 1000, step: 1, default: 100 },
    { name: "pos_x", label: "Position X", type: "scalar", min: -50, max: 50, softMax: 10, step: 0.01, default: 2.4 },
    { name: "pos_y", label: "Position Y", type: "scalar", min: -50, max: 50, softMax: 10, step: 0.01, default: 1.8 },
    { name: "pos_z", label: "Position Z", type: "scalar", min: -50, max: 50, softMax: 10, step: 0.01, default: 2.4 },
    { name: "target_x", label: "Target X", type: "scalar", min: -50, max: 50, softMax: 10, step: 0.01, default: 0 },
    { name: "target_y", label: "Target Y", type: "scalar", min: -50, max: 50, softMax: 10, step: 0.01, default: 0 },
    { name: "target_z", label: "Target Z", type: "scalar", min: -50, max: 50, softMax: 10, step: 0.01, default: 0 },
    // Depth of field (bokeh). Applied by Scene Render's post-process.
    { name: "dof_enabled", label: "Depth of field", type: "boolean", default: false },
    { name: "dof_focus", label: "Focus distance", type: "scalar", min: 0.1, max: 100, softMax: 20, step: 0.01, default: 6, visibleIf: (p) => !!p.dof_enabled },
    { name: "dof_aperture", label: "Aperture", type: "scalar", min: 0, max: 0.2, softMax: 0.06, step: 0.001, default: 0.025, visibleIf: (p) => !!p.dof_enabled },
    { name: "dof_maxblur", label: "Max blur", type: "scalar", min: 0, max: 0.05, softMax: 0.02, step: 0.001, default: 0.01, visibleIf: (p) => !!p.dof_enabled },
  ],
  primaryOutput: "camera",
  auxOutputs: [],

  compute({ params }) {
    const projection =
      ((params.projection as string) ?? "perspective") === "orthographic"
        ? "orthographic"
        : "perspective";
    const out: CameraValue = {
      kind: "camera",
      projection,
      fov: (params.fov as number) ?? 45,
      near: (params.near as number) ?? 0.1,
      far: (params.far as number) ?? 100,
      orthoHeight: (params.ortho_height as number) ?? 3,
      position: [
        (params.pos_x as number) ?? 2.4,
        (params.pos_y as number) ?? 1.8,
        (params.pos_z as number) ?? 2.4,
      ],
      target: [
        (params.target_x as number) ?? 0,
        (params.target_y as number) ?? 0,
        (params.target_z as number) ?? 0,
      ],
      dof: params.dof_enabled
        ? {
            focus: (params.dof_focus as number) ?? 6,
            aperture: (params.dof_aperture as number) ?? 0.025,
            maxblur: (params.dof_maxblur as number) ?? 0.01,
          }
        : undefined,
    };
    return { primary: out };
  },
};
