import * as THREE from "three";
import type {
  NodeDefinition,
  PointsValue,
} from "@/engine/types";
import type { CameraValue } from "@/engine/three-types";
import { makePoints } from "@/engine/points";
import { aspectUncorrectY } from "@/engine/aspect";

// =====================================================================
// Project to Screen — the honest 3D→2D points bridge (Tier 2)
// =====================================================================
//
// World-space `points3d` → authored 2D `points` through a scene camera:
// the crossing the split-wire type system reserved for an explicit node.
// This is what lets the ENTIRE 2D point toolkit track 3D objects — Point
// Labels calling out scattered copies, Connect Points drawing leader
// lines, trails following a projected path — all locked to the render,
// because the projection uses the same camera math as Scene Render
// (wire the SAME Camera node into both).
//
// Unwired camera = Scene Render's default view (mirrored constants), so
// the no-camera preview matches too. Points behind the camera are
// CULLED (compacted out — count can shrink; groupIndices survive so
// per-index pairing still works on what remains). Off-screen-but-in-
// front points are kept: authored coordinates outside [0,1] are legal
// and let leader lines run off-canvas honestly.
//
// Output y is aspect-UNcorrected: authored space is isotropic in
// canvas-width units and every 2D renderer aspect-corrects on the way to
// pixels, so we pre-invert (engine/aspect.ts) — the projected dot lands
// on the rendered pixel.

const DEFAULT_CAMERA: CameraValue = {
  // Mirrors Scene Render's DEFAULT_CAMERA — keep in sync.
  kind: "camera",
  projection: "perspective",
  fov: 45,
  near: 0.1,
  far: 100,
  position: [2.4, 1.8, 2.4],
  target: [0, 0, 0],
};

export const projectToScreen3DNode: NodeDefinition = {
  type: "project-to-screen-3d",
  name: "Project to Screen",
  category: "3d",
  description:
    "Projects 3D points into 2D screen-space points through a scene camera — wire the same Camera into this and Scene Render, and the 2D point toolkit (labels, connect lines, trails…) tracks the 3D render exactly. Points behind the camera are dropped.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [
    { name: "points", type: "points3d", required: true },
    { name: "camera", type: "camera", required: false },
  ],
  params: [],
  primaryOutput: "points",
  auxOutputs: [],

  compute({ inputs, ctx }) {
    const src = inputs.points as PointsValue | undefined;
    if (!src || src.kind !== "points" || src.z === undefined) {
      return { primary: makePoints(0) };
    }
    const camIn = inputs.camera;
    const desc =
      camIn && camIn.kind === "camera"
        ? (camIn as CameraValue)
        : DEFAULT_CAMERA;

    const aspect = ctx.width / ctx.height;
    let camera: THREE.Camera;
    if (desc.projection === "orthographic") {
      const halfH = (desc.orthoHeight ?? 3) / 2;
      const halfW = halfH * aspect;
      camera = new THREE.OrthographicCamera(
        -halfW,
        halfW,
        halfH,
        -halfH,
        desc.near,
        desc.far
      );
    } else {
      camera = new THREE.PerspectiveCamera(
        desc.fov,
        aspect,
        desc.near,
        desc.far
      );
    }
    camera.position.set(...desc.position);
    camera.lookAt(...desc.target);
    (camera as THREE.PerspectiveCamera).updateProjectionMatrix?.();
    camera.updateMatrixWorld(true);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

    const n = src.count;
    const outX = new Float32Array(n);
    const outY = new Float32Array(n);
    const outGroup = src.groupIndices ? new Int32Array(n) : null;
    let kept = 0;
    const v = new THREE.Vector3();
    const view = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      v.set(src.positions[i * 2], src.positions[i * 2 + 1], src.z[i]);
      // Cull behind the near plane (view-space z is negative in front).
      view.copy(v).applyMatrix4(camera.matrixWorldInverse);
      if (view.z > -desc.near) continue;
      v.project(camera);
      // NDC → canvas UV (v down) → authored (aspect-uncorrected).
      outX[kept] = (v.x + 1) / 2;
      outY[kept] = aspectUncorrectY((1 - v.y) / 2, aspect);
      if (outGroup && src.groupIndices) outGroup[kept] = src.groupIndices[i];
      kept++;
    }

    const out = makePoints(kept, {
      withGroupIndices: !!outGroup,
    });
    for (let i = 0; i < kept; i++) {
      out.positions[i * 2] = outX[i];
      out.positions[i * 2 + 1] = outY[i];
      if (outGroup && out.groupIndices) out.groupIndices[i] = outGroup[i];
    }
    return { primary: out };
  },
};
