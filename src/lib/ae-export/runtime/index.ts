// After Effects runtime: what a package ships besides scene.json (spec
// 091926_after-effects-handoff.md §5.1) — the static build.jsx interpreter,
// the synthesized gradient presets, and the scene validator both sides of
// the package boundary trust.

import { BUILD_JSX_SOURCE } from "./build-jsx.generated";

export { BUILD_JSX_SOURCE };
export {
  gradientColorsXml,
  gradientPresetPath,
  normalizeGradientStops,
  parseRifx,
  synthesizeGradientPreset,
  synthesizeScenePresets,
  type GradientPresetInput,
  type GradientPresetKind,
  type RifxNode,
} from "./ffx";
export { validateAeScene } from "./validate";

// Where build.jsx sits in a package, next to scene.json.
export const BUILD_JSX_FILE = "build.jsx";

// build.jsx's own version (it reports it in build-log.json).
export const BUILD_JSX_VERSION = /var BUILDER_VERSION = "([^"]+)"/.exec(BUILD_JSX_SOURCE)?.[1] ?? "unknown";

// Globals a host may set before evaluating build.jsx (see its header).
export const BUILD_JSX_GLOBALS = {
  quiet: "TBX_AE_QUIET",
  packageDir: "TBX_AE_PACKAGE",
  overwrite: "TBX_AE_OVERWRITE",
  result: "TBX_AE_RESULT",
} as const;
