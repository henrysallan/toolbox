// Shared shape of the export/live manifest. The editor's
// `buildExportManifest` produces objects matching this; the LiveViewer
// component consumes them. Kept structurally identical to the original
// export-template copy so both code paths reuse the same renderer.

import type { ParamDef, ParamType } from "@/engine/types";

export type FileParamType =
  | "file"
  | "video_file"
  | "audio_file"
  | "svg_file"
  | "font";

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

export interface ExportManifest {
  appName: string;
  description?: string;
  outputNodeId: string;
  canvasRes: [number, number];
  fileInputs: ExportManifestFileInput[];
  controls: ExportManifestControl[];
  generatedAt: string;
  schemaVersion: 1;
}
