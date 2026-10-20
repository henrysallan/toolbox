// The AE package (spec §5.1, §5.3): scene build → files on disk or a zip, plus
// the optional "Build in After Effects" step.
//
// The modal lane's ExportAeModal calls an AeExportRunner it is handed and
// never reaches into EffectsApp itself. The runner (runner.ts) is built from
// deps EffectsApp supplies; files.ts assembles the static files and the
// README report, sinks.ts writes a folder (desktop) or a zip (web).

import type { AeExportPlan, AeExportPolicy } from "../types";
import type { AeNodeOverride } from "../scene";

export interface AeExportOptions {
  policy: Partial<AeExportPolicy>;
  overrides: Record<string, AeNodeOverride>;
  // See AeSceneOptions.fused.
  fused: Record<string, string>;
  name: string;
  // "zip" downloads (web, or desktop by choice); "folder" writes the package
  // folder through the desktop app (a picked folder; nested paths allowed).
  destination: "zip" | "folder";
  // Desktop only: after writing, build the .aep in After Effects.
  build: boolean;
}

export interface AeExportResult {
  ok: boolean;
  // Where the package went (folder path on desktop, file name for a zip).
  location?: string;
  // The plan's readable report plus what was baked / approximated.
  report: string;
  problems: string[];
  warnings: string[];
  built?: { ok: boolean; log: string; aep?: string };
  // Every path in the package, README.txt first.
  files?: string[];
}

export type AeExportRunner = (opts: AeExportOptions) => Promise<AeExportResult>;

// Progress the runner reports while it bakes / encodes / builds.
export interface AeExportProgress {
  phase: "plan" | "scene" | "bake" | "encode" | "write" | "build";
  done: number;
  total: number;
  label?: string;
}

// Props of src/components/effects/ExportAeModal.tsx (§5.4). The modal lane
// builds the component against this; the package lane mounts it in
// EffectsApp and supplies every callback. Kept React-free so the contract
// lives with the runner.
export interface AeExportModalProps {
  open: boolean;
  onClose(): void;
  defaultName: string;
  // Re-plan with the modal's current options (cheap, synchronous).
  replan(policy: Partial<AeExportPolicy>, overrides: Record<string, AeNodeOverride>): AeExportPlan;
  run: AeExportRunner;
  // Desktop app with After Effects found.
  canBuildInAe: boolean;
  // Desktop app (folder destination available).
  canWriteFolder: boolean;
  // Opens the agent panel and sends this prompt (the modal builds the text).
  onConvertWithClaude(prompt: string): void;
  // Live progress while `run` is in flight (the host passes the latest).
  progress?: AeExportProgress | null;
}

export {
  AE_PACKAGE_EXT,
  MANIFEST_FILE,
  README_FILE,
  SCENE_FILE,
  aePackageBaseName,
  aePackageNeeds,
  aePackagePaths,
  aePackageReport,
  aeReadme,
  assembleAePackage,
  endpointTarget,
  shaderBundlePath,
  vetPackagePath,
} from "./files";
export type { AeAssembly, AeAssembleOptions, AeBakeOutcome, AePackageFile, AePackageManifest } from "./files";
export { bakeEncodeSpec, createAeExportRunner } from "./runner";
export type { AeBakeEncoder, AeFrameRenderer, AePackageSink, AeRenderedTick, AeRunnerDeps } from "./runner";
export { buildZipBlob, folderSink, zipSink } from "./sinks";
export type { ZipBakeEncoder, ZipSinkOptions } from "./sinks";
