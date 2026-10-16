// Bundle entry for scripts/check-paint-canvas.cjs: exposes the Paint
// editor's canvas-compositing modules on window so the Electron gate can
// drive them against Chromium's real Canvas2D.
import * as selection from "../src/components/effects/paint-editor/selection";
import * as floating from "../src/components/effects/paint-editor/floating";
import * as transform from "../src/components/effects/paint-editor/transform";
import { floodFill, StrokeSession } from "../src/components/effects/paint-editor/engine";
import { DEFAULT_BRUSH_SETTINGS } from "../src/engine/types";

(window as unknown as Record<string, unknown>).PaintCanvas = {
  selection,
  floating,
  transform,
  StrokeSession,
  floodFill,
  DEFAULT_BRUSH_SETTINGS,
};
