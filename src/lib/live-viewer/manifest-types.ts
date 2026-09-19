// Shared shape of the export/live manifest. The editor's
// `buildExportManifest` produces objects matching this; the LiveViewer
// component consumes them. Kept structurally identical to the original
// export-template copy so both code paths reuse the same renderer.

import type { ParamDef, ParamType } from "@/engine/types";
import type { LiveDesign } from "./design";

export type FileParamType =
  | "file"
  | "video_file"
  | "audio_file"
  | "svg_file"
  | "font"
  | "model_file";

export interface ExportManifestFileInput {
  nodeId: string;
  nodeName: string;
  paramName: string;
  paramType: FileParamType;
  label: string;
}

export interface ExportManifestControl {
  nodeId: string;
  nodeName: string;
  paramName: string;
  paramType: ParamType;
  label: string;
  def: ParamDef;
}

// Which editor overlay draws a shipped on-canvas GUI
// (specdocs/091726_live-gizmos.md): the TRS+pivot transform gizmo, the
// shape-primitive box / point handles, or the gradient handles.
export type LiveGizmoKind = "transform" | "primitive" | "gradient";

// One node whose on-canvas handles ship to the live link (the node-level
// Control toggle). The viewer renders a visibility row for it and, while
// visible, the overlay over the canvas. `nodeName` shares the dedupe
// counter with the node's param controls ("Transform (2)").
export interface ExportManifestGizmo {
  nodeId: string;
  nodeName: string;
  defType: string;
  kind: LiveGizmoKind;
}

export interface ExportManifest {
  appName: string;
  description?: string;
  outputNodeId: string;
  canvasRes: [number, number];
  fileInputs: ExportManifestFileInput[];
  controls: ExportManifestControl[];
  // On-canvas handles (091726_live-gizmos.md). Additive — a blob from
  // before the field renders no gizmo rows; schemaVersion stays 1.
  gizmos?: ExportManifestGizmo[];
  generatedAt: string;
  schemaVersion: 1;
  // Look-and-feel block (081426_live-link-designer.md), attached by the
  // manifest CALLERS (LiveClient / runExportApp) from
  // SavedProject.liveDesign, already validated through
  // fromSavedLiveDesign. Additive — absent means render exactly like the
  // pre-design viewer; old bundled viewers ignore it. schemaVersion
  // stays 1.
  design?: LiveDesign;
}
