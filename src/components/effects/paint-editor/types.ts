// Shared types for the Paint editor overlay (071926_paint-toolkit.md,
// 101526_paint-selection-transform.md).

export type PaintTool =
  | "move"
  | "marquee-rect"
  | "marquee-ellipse"
  | "lasso"
  | "lasso-poly"
  | "wand"
  | "brush"
  | "eraser"
  | "blur"
  | "fill"
  | "eyedropper";

export function isMarqueeTool(
  t: PaintTool
): t is "marquee-rect" | "marquee-ellipse" {
  return t === "marquee-rect" || t === "marquee-ellipse";
}

export function isLassoTool(t: PaintTool): t is "lasso" | "lasso-poly" {
  return t === "lasso" || t === "lasso-poly";
}

// Every tool that makes a selection (and so shows the selection shelf and
// reads Shift / Alt as add / subtract).
export function isSelectionTool(t: PaintTool): boolean {
  return isMarqueeTool(t) || isLassoTool(t) || t === "wand";
}
