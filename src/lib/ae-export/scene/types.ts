// The scene walk's contract (spec 091926_after-effects-handoff.md §5.2):
// what buildAeSceneForEditor takes and returns. Re-exported by scene/index.ts,
// which the package lane (export_ae_package, the modal's runner) imports.
//
// Agreed before wave 2 with the package and modal lanes; fields may be added
// here, but renaming or removing one needs a note to the coordinating session.

import type { AeEditorEnv } from "../editor";
import type { AeBakeCodec, AeExportPlan, AeScene, AeShaderBundle } from "../types";

// Per-node choices from the export modal (§5.4):
//   bake        render the node's output to footage (and everything feeding it)
//   skip        drop the node: its main input passes through (a source → nothing)
//   procedural  never bake it — a region containing it that would bake is a
//               problem instead (the export is refused with the reason); a
//               Copy to Points over the layer budget explodes anyway (warned)
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
  // scene.generatedAt (ISO). Default: now. Gates pin it for snapshots.
  generatedAt?: string;
  // How gradient stops reach AE (spec §13 "The gradient route"):
  //   svg  (default) an SVG-seeded shape layer wherever the gradient can own
  //        its layer (works headless and in the app); synthesized .ffx presets
  //        for gradients inside composed contents
  //   ffx  .ffx presets everywhere (toolbox's own shape structure kept)
  // Every .ffx preset needs build.jsx to run in the After Effects app: a
  // headless aerender build shows AE's default gradient (reported).
  gradientRoute?: "ffx" | "svg";
  // Added by the instances lane (M4): the pixels of a STATIC image field the
  // walk samples at export time — Copy to Points' scale / rotate fields and
  // its image pick. `endpoint` ("<id>:out" | "<id>:aux:<name>") is the
  // field's producer; return its RGBA8 readback at width × height, row 0 =
  // the visual top (EngineBackend.readImagePixels of the last evaluated
  // value: a static field is the same at every frame). Undefined, or no
  // hook (offline callers), and the copies that need it bake.
  fieldPixels?: (endpoint: string, width: number, height: number) => ArrayLike<number> | undefined;
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
  // Added by the scene lane: the clock the endpoint runs on. The endpoint
  // lives inside a toolbox layer whose interior clock is offset from the
  // composition's (local tick = comp tick − offsetTicks): render comp frame f
  // of `frames` at local tick f·ticksPerFrame − offsetTicks (renderSettledFrameAt
  // with forcedTerminalRef pinned to `output` already does this when it renders
  // the comp frame). 0 at the composition root.
  offsetTicks?: number;
  // Why it bakes (the report line).
  reason?: string;
}

// Source media the package copies into footage/ (Image/Video Source assets,
// imported models). `source.ref` is the toolbox node id whose `file` /
// `sequence` param holds the media — the package writer resolves it from the
// project's asset store the way the export manifest does.
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
