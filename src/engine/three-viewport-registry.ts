// =====================================================================
// 3D viewport registry (M1b)
// =====================================================================
//
// A module-level bridge that lets the editor's live orbit viewport reach a
// Scene Render node's retained three.Scene without the engine importing
// from the UI layer. Scene Render publishes its scene + current camera
// descriptor here each eval; the Scene3DViewport component reads it and
// renders that SAME scene with its OWN renderer + an ephemeral editor
// camera (two renderers can traverse one scene graph — the single-parent
// rule is about the scene tree, not renderers). See spec §7 and
// 061626_3d-nodes-and-context.md §3.3.
//
// Engine-side (components may import engine; not vice-versa — invariant
// #1). Mirrors the module-level stash precedent in state/editor-session.ts.

import type * as THREE from "three";
import type { CameraValue } from "./three-types";

export interface SceneRenderHandle {
  scene: THREE.Scene;
  // The scene camera wired into Scene Render (for the viewport's
  // "look through camera" toggle). Null when none is wired.
  cameraDesc: CameraValue;
}

const registry = new Map<string, SceneRenderHandle>();

export function publishSceneRender(
  nodeId: string,
  handle: SceneRenderHandle
): void {
  registry.set(nodeId, handle);
}

export function getSceneRender(nodeId: string): SceneRenderHandle | undefined {
  return registry.get(nodeId);
}

export function unpublishSceneRender(nodeId: string): void {
  registry.delete(nodeId);
}
