import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { getSceneRender } from "@/engine/three-viewport-registry";

// Export a 3D Scene node's live scene contents as a downloadable GLB.
// Reads the scene the node published to the viewport registry (so the node
// must have evaluated — selecting it does that), runs GLTFExporter in binary
// mode, and triggers a browser download.
export async function exportSceneGLB(nodeId: string): Promise<void> {
  const handle = getSceneRender(nodeId);
  if (!handle) {
    console.warn("[scene-glb-export] no published scene for node", nodeId);
    return;
  }
  const exporter = new GLTFExporter();
  const result = (await exporter.parseAsync(handle.scene, {
    binary: true,
  })) as ArrayBuffer;
  const blob = new Blob([result], { type: "model/gltf-binary" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "scene.glb";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
