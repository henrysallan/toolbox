// React Native Skia export for SkSL Shader nodes (specdocs/101326_skia-target.md).
export { planSkiaExport, type SkiaExportPlan, type SkiaUniformBinding, type SkiaExportOptions } from "./plan";
export { emitSkiaBundle, SKIA_EXPORT_FORMAT, RN_SKIA_VERSION } from "./emit";
export { exportSkia, type SkiaExportRequest, type SkiaExportResult } from "./api";
// …and for Skia Canvas scenes (scene IR → JSX + timeline).
export { exportSkiaScene, type SkiaSceneExportOptions } from "./api";
export { planSceneExport, type ScenePlan, type PlannedBind, type BindPlan, type ScenePlanOptions } from "./scene-plan";
export { emitSceneBundle, SKIA_SCENE_EXPORT_FORMAT } from "./scene-emit";
export { makeSceneSampler } from "./scene-sample";
// Timeline markers → SEGMENTS + the clock module both bundles ship (M3).
export {
  exportSegments,
  clockModuleSource,
  manifestSegments,
  NO_EXPORT_SEGMENTS,
  type ExportSegment,
  type ExportSegments,
  type ExportMarker,
} from "./segments";
// The async asset pre-pass + the one URL → bytes seam (Wave 3 lane I).
export { collectSkiaExportAssets, resolveSkiaExportAssets, exportSkiaWithAssets, sceneAssetIds } from "./assets";
export { type SkiaExportAssets } from "./api";
export { registerSkiaAssetScheme, resolveSkiaAssetBytes, type SkiaAssetResolver } from "@/engine/skia/asset-bytes";
// …and the Reanimated-native animation mode (animation: "native", M3 lane D).
export { emitNativeEffect, emitNativeScene, NATIVE_EASINGS, type NativeEasingRow, type NativeEasingClass } from "./emit-native";
