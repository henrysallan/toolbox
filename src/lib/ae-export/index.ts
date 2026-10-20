// After Effects export (spec 091926_after-effects-handoff.md) — the public
// surface. Lanes add their exports here as they land (convert/, runtime/,
// shader/, scene/, package/). editor.ts is not re-exported: it pulls the
// engine + registry, so import "@/lib/ae-export/editor" where that is wanted
// (the MCP handler loads it lazily).

export * from "./types";
export {
  AE_EXPORT_CLASSES,
  AE_MISSING_BLEND_MODES,
  AE_STRUCTURAL_TYPES,
  LIVE_INPUT_TYPES,
  SDF_CHAIN_TYPES,
  aeBlendModeOf,
  aeExportEntry,
  isAeClassified,
  isGlslFusable,
} from "./classes";
export { describeAePlan, planAeExport, resolveAePolicy } from "./plan";
export type { AePlanInput, AePlanLayerInput, AePlanTrack, PlanEdge, PlanNode, PlanNodeInfo } from "./plan";
