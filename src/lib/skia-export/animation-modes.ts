// The timeline shapes a React Native Skia export can ship (spec
// 101326_skia-target.md §3.5) — SkiaExportRequest.animation, as the param
// panel's export action and the MCP plan_skia_export / export_skia tools
// offer them. Light on purpose: no exporter imports, so the panel and the
// MCP handlers can load it without the lazy exporter chunk.

import type { SkiaExportRequest } from "./api";

export type SkiaAnimationMode = NonNullable<SkiaExportRequest["animation"]>;

// The export action's / MCP's choices, default first.
export const SKIA_ANIMATION_MODES: readonly {
  id: SkiaAnimationMode;
  label: string;
  hint: string;
}[] = [
  {
    id: "worklet",
    label: "Worklet timeline",
    hint: "Every track replayed by Reanimated worklets on one master clock: frame-exact on any display, scrubbable, segments via useToolboxClock.",
  },
  {
    id: "baked",
    label: "Baked into the shader",
    hint: "The keyframes compiled into the SkSL as functions of iTime: one program, no per-frame JS. For ambient loops.",
  },
  {
    id: "native",
    label: "Reanimated native",
    hint: "One shared value per animated param on withTiming / withSpring, for app code to interrupt or hand to gestures. Exact on a steady 60 Hz clock; a late frame can push a step one frame late.",
  },
];

export function isSkiaAnimationMode(v: unknown): v is SkiaAnimationMode {
  return SKIA_ANIMATION_MODES.some((m) => m.id === v);
}
