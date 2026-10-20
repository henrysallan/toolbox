// The AE package (spec §5.1, §5.3): scene build → files on disk or a zip, plus
// the optional "Build in After Effects" step.
//
// CONTRACT STUB — committed before wave 2. The package lane implements the
// runner and mounts it in EffectsApp; the modal lane's ExportAeModal calls an
// AeExportRunner it is handed and never reaches into EffectsApp itself.

import type { AeExportPolicy } from "../types";
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
}

export type AeExportRunner = (opts: AeExportOptions) => Promise<AeExportResult>;

// Progress the runner reports while it bakes / encodes / builds.
export interface AeExportProgress {
  phase: "plan" | "scene" | "bake" | "encode" | "write" | "build";
  done: number;
  total: number;
  label?: string;
}
