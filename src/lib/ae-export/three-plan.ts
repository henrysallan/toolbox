// Which 3-D scenes rebuild natively in After Effects (M4 lane 5,
// specdocs/ae-m4/3d.md). planAeExport asks this for every Scene Render it
// reaches: when every object is an Import 3D model (optionally under
// Transform 3D) or a light, and the camera is a Camera node (or none), the
// scene becomes a 3-D precomp (Advanced 3D) — the same model file as an AE
// model layer, 3-D nulls for the Transform 3D parents, an AE camera and AE
// lights. Anything else (primitives, materials, fog, the room environment,
// depth of field) keeps today's bake of the whole Scene Render.

import type { AeExportEntry } from "./types";

export type Scene3dRole = "camera" | "light" | "model" | "transform";

export interface Scene3dPlanInput {
  sceneId: string;
  type(id: string): string | undefined;
  values(id: string): Record<string, unknown>;
  // Wires into a node: source node id + the target handle ("in:object:1"…).
  inputs(id: string): { fromId: string; toHandle: string }[];
}

export type Scene3dVerdict =
  | { native: true; members: Map<string, Scene3dRole>; notes: string[]; ortho: boolean }
  | { native: false; reason: string };

// Formats AE 24.1+ imports as a 3D model layer (FBX too, which toolbox does
// not load). Measured headless in 26.5: GLB and OBJ.
export const AE_MODEL_FORMATS: ReadonlySet<string> = new Set(["glb", "gltf", "obj"]);

const OBJECT_SOCKET = /^in:object:\d+$/;

export function planScene3d(inp: Scene3dPlanInput): Scene3dVerdict {
  const { sceneId } = inp;
  const v = inp.values(sceneId);
  const fog = String(v.fog ?? "none");
  if (fog !== "none") return { native: false, reason: `fog (${fog}) has no AE Advanced 3D form` };
  const env = String(v.environment ?? "none");
  if (env !== "none") return { native: false, reason: `the ${env} environment (image-based lighting) has no calibrated AE form` };

  const members = new Map<string, Scene3dRole>();
  const notes: string[] = [];
  let ortho = false;
  const wires = inp.inputs(sceneId);

  const cam = wires.find((w) => w.toHandle === "in:camera");
  if (cam) {
    const t = inp.type(cam.fromId);
    if (t !== "camera-3d") return { native: false, reason: `its camera comes from ${t ?? "an unknown node"}, not a Camera node` };
    const cv = inp.values(cam.fromId);
    if (cv.dof_enabled === true) return { native: false, reason: "the camera's depth of field (three's BokehPass) has no calibrated AE camera blur" };
    if (String(cv.projection ?? "perspective") === "orthographic") {
      ortho = true;
      notes.push("orthographic camera → an AE camera 2·10⁵ px away with a matching zoom (AE has no orthographic camera; silhouette IoU 0.997)");
    }
    members.set(cam.fromId, "camera");
  }

  // A model chain: Transform 3D* → Import 3D.
  const chain = (id: string, via: string): string | null => {
    const t = inp.type(id);
    if (t === "import-3d") {
      const mv = inp.values(id);
      const model = mv.model as { format?: unknown } | null | undefined;
      const format = String(model?.format ?? "glb");
      if (model && !AE_MODEL_FORMATS.has(format)) return `${id} is a ${format.toUpperCase()} model: AE imports GLB, glTF, OBJ and FBX`;
      const pick = String(mv.object ?? "");
      if (pick !== "") return `${id} picks one object of its file (${pick}): AE imports the whole file as one model layer`;
      members.set(id, "model");
      return null;
    }
    if (t === "transform-3d") {
      const src = inp.inputs(id).find((w) => w.toHandle === "in:source");
      // Unwired: renders nothing in toolbox either.
      const r = src ? chain(src.fromId, id) : null;
      if (r) return r;
      members.set(id, "transform");
      return null;
    }
    return `${t ?? "an unknown node"} (${id}) feeds ${via}: only Import 3D models (optionally under Transform 3D), lights and a camera rebuild natively`;
  };

  for (const w of wires) {
    if (!OBJECT_SOCKET.test(w.toHandle)) continue;
    const t = inp.type(w.fromId);
    if (t === "light-3d") {
      members.set(w.fromId, "light");
      continue;
    }
    const r = chain(w.fromId, sceneId);
    if (r) return { native: false, reason: r };
  }
  return { native: true, members, notes, ortho };
}

// The plan entries a native scene gives itself and its members.
export function scene3dEntry(role: Scene3dRole | "scene", ortho = false): AeExportEntry {
  switch (role) {
    case "scene":
      return { class: "layer", ae: "comp:advanced-3d", fidelity: "exact", note: "3-D scene → a 3-D precomp (Advanced 3D renderer) with an AE camera, lights and model layers; the precomp layer sits where the render did." };
    case "camera":
      return ortho
        ? { class: "layer", ae: "layer:camera", fidelity: "approx", note: "Orthographic camera → an AE camera 2·10⁵ px from its target, zoom = D·H/(512·ortho_height) (AE has no orthographic camera)." }
        : { class: "layer", ae: "layer:camera", fidelity: "exact", note: "AE camera: Point of Interest = target, Zoom = (H/2)/tan(fov/2), 512 px per world unit (framing measured within 0.13 px)." };
    case "light":
      return { class: "layer", ae: "layer:light", fidelity: "approx", note: "AE light. Advanced 3D lights in the encoded working space: intensity is the least-squares match over N·L (AE lights linearly in N·L, toolbox through the sRGB encode)." };
    case "model":
      return { class: "layer", ae: "layer:3d-model", fidelity: "approx", requires: ["footage"], note: "The same model file as an AE 3D model layer (Advanced 3D); AE renders the file's own PBR materials." };
    case "transform":
      return { class: "transform", ae: "layer:null", fidelity: "exact", note: "3-D null parenting its model (AE parenting = toolbox's composed transform)." };
  }
}
