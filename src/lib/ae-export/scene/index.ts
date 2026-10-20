// The exporter walk (spec 091926_after-effects-handoff.md §5.2): editor graph →
// AeScene + everything the package writer must produce next to scene.json.
//
// CONTRACT STUB — committed before wave 2 so the scene lane (implements this),
// the package lane (calls it from export_ae_package / the modal's runner) and
// the modal lane agree on one shape. The scene lane may extend these types;
// renaming or removing a field needs a note to the coordinating session.

import type { Edge } from "@xyflow/react";
import type { GraphNode } from "@/state/graph-ops";
import type { AeEditorEnv } from "../editor";
import type { AeBakeCodec, AeExportPlan, AeScene, AeShaderBundle } from "../types";

// Per-node choices from the export modal (§5.4).
export type AeNodeOverride = "bake" | "skip" | "procedural";

export interface AeSceneOptions {
  // The same env planAeExportForEditor takes (policy, composition, scope …),
  // so the plan and the walk agree on ids.
  env: AeEditorEnv;
  overrides?: Record<string, AeNodeOverride>;
  // Shader regions the agent already fused: region target endpoint
  // (AeShaderRegion.target) → id of the glsl-expression node that replaces it
  // (inserted unwired downstream, as the graph-to-glsl loop leaves it). A
  // region without an entry bakes (or is refused when baking is off).
  fused?: Record<string, string>;
  // Package + main comp name.
  name: string;
  toolboxVersion: string;
}

// Frames the package writer renders and encodes before AE can open the scene.
export interface AeBakeRequest {
  // AeFootage id in scene.footage.
  id: string;
  // Endpoint to render: "<id>:out" | "<id>:aux:<name>".
  output: string;
  // Inclusive composition frames.
  frames: [number, number];
  size: [number, number];
  codec: AeBakeCodec;
  // Package-relative path, e.g. "footage/<id>.mov".
  path: string;
}

// Source media the package copies into footage/ (Image/Video Source assets,
// imported models).
export interface AeAssetCopy {
  id: string;
  path: string;
  source: { kind: "image" | "video" | "svg" | "model"; ref: string };
}

export interface AeSceneBuild {
  plan: AeExportPlan;
  scene: AeScene;
  bakes: AeBakeRequest[];
  // → shaders/<bundle.id>.tbxfx
  bundles: AeShaderBundle[];
  // → presets/*.ffx (runtime/ffx.ts)
  presets: { id: string; path: string; bytes: Uint8Array }[];
  // Other text files the scene references (SVG gradient seeds, …).
  files: { path: string; text: string }[];
  assets: AeAssetCopy[];
  // Non-empty ⇒ the export is refused, with these reasons.
  problems: string[];
  warnings: string[];
}

export function buildAeSceneForEditor(_nodes: GraphNode[], _edges: Edge[], _opts: AeSceneOptions): AeSceneBuild {
  throw new Error("buildAeSceneForEditor: not implemented yet (AE export wave 2, scene lane)");
}
