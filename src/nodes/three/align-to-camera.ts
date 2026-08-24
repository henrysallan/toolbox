import type { NodeDefinition } from "@/engine/types";
import type { CameraValue, InstancesValue } from "@/engine/three-types";

// =====================================================================
// Align to Camera — per-copy billboarding (M12, render-time)
// =====================================================================
//
// Marks an instance stream for billboarding. The ORIENTATION IS APPLIED
// AT RENDER TIME (engine/three-geometry.ts applyInstanceBillboards — the
// v1 baked descriptor orientations, which couldn't track a moving
// camera live), so:
//
//   camera UNWIRED — copies face whichever camera is rendering: the
//     scene camera in the output, the editor camera while orbiting the
//     viewport. Live everywhere, the default you usually want.
//   camera WIRED — copies lock to THAT camera's position (explicit and
//     legible in the graph; updates as that camera animates). Lets
//     billboards face camera A while camera B renders.
//
// Instances (not points) is the right domain: copies carry full
// quaternions, it composes with any instances source (Copy to Points,
// 3D Array), and positions/scales/colors pass through untouched (§4.4 —
// this node only sets the `billboard` marker). Realize Instances ignores
// the marker — billboarding is a render effect, not geometry.
//
// The marker snapshots `baseQuats` (the quaternion array as of this
// node), so an Instance Transform placed AFTER Align still reads: its
// rotation delta (now vs base, detected by §4.4 array replacement)
// composes on top of the billboard at render time — Z-spin spins cards
// in the view plane. Offsets/scales after Align already flow through
// (the apply reads the final stream's positions/scales).
//
//   mode full     — spherical: each copy faces the camera along its own
//                   line of sight (sprites, markers).
//   mode y locked — cylindrical: rotates only around world Y (trees,
//                   characters — no tipping as the camera rises).
//   face          — which local axis points at the camera: +Z (a Plane's
//                   facing side) or +Y (Copy's align-to-normal axis).

export const alignToCamera3DNode: NodeDefinition = {
  type: "align-to-camera-3d",
  name: "Align to Camera",
  category: "3d",
  description:
    "Turns every copy in an instance stream to face the camera (billboarding), applied live at render time. Leave the camera input empty to face whichever camera is looking — including the orbit viewport — or wire a specific Camera to lock to it. Y-locked mode only spins around the vertical (trees/characters).",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [
    { name: "instances", type: "instances", required: true },
    { name: "camera", type: "camera", required: false },
  ],
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["full", "y locked"],
      default: "full",
      control: "segmented",
    },
    {
      name: "face",
      label: "Facing axis",
      type: "enum",
      options: ["z", "y"],
      default: "z",
      control: "segmented",
    },
  ],
  primaryOutput: "instances",
  auxOutputs: [],

  compute({ inputs, params }) {
    const src = inputs.instances as InstancesValue | undefined;
    if (!src || src.kind !== "instances") return {};
    const camIn = inputs.camera;
    const out: InstancesValue = {
      ...src,
      billboard: {
        mode: ((params.mode as string) ?? "full") === "y locked" ? "y" : "full",
        face: ((params.face as string) ?? "z") === "y" ? "y" : "z",
        camera:
          camIn && camIn.kind === "camera"
            ? [...(camIn as CameraValue).position]
            : undefined,
        baseQuats: src.quaternions,
      },
    };
    return { primary: out };
  },
};
