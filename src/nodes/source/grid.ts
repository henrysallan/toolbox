import type { NodeDefinition } from "@/engine/types";
import { makePoints } from "@/engine/points";

// Rectangular grid of points. The multi-point sibling of Point: feeds
// Copy to Points, Connect Points, Point Labels, etc. with a regular
// X×Y lattice. Two spacing modes (same vocabulary as Array's sizeMode):
// "fit" spans a fixed width/height and derives the gap from the counts;
// "step" takes an explicit gap and lets the footprint grow. Both modes
// center the grid on (x, y), so switching modes doesn't move it.
//
// See specdocs/archive/071926_grid-node.md.

export const gridNode: NodeDefinition = {
  type: "grid",
  name: "Grid",
  category: "point",
  subcategory: "generator",
  description:
    "Emit an X×Y grid of points. Fit mode spreads the counts across a fixed width/height; Step mode uses an explicit gap between points so the grid grows with the counts.",
  backend: "webgl2",
  inputs: [],
  params: [
    {
      name: "countX",
      label: "Count X",
      type: "scalar",
      min: 1,
      max: 64,
      step: 1,
      default: 5,
    },
    {
      name: "countY",
      label: "Count Y",
      type: "scalar",
      min: 1,
      max: 64,
      step: 1,
      default: 5,
    },
    {
      name: "spacingMode",
      label: "Spacing",
      type: "enum",
      options: ["fit", "step"],
      default: "fit",
    },
    {
      name: "width",
      label: "Width",
      type: "scalar",
      min: 0,
      max: 2,
      softMax: 1,
      step: 0.001,
      default: 0.8,
      visibleIf: (p) => p.spacingMode !== "step",
    },
    {
      name: "height",
      label: "Height",
      type: "scalar",
      min: 0,
      max: 2,
      softMax: 1,
      step: 0.001,
      default: 0.8,
      visibleIf: (p) => p.spacingMode !== "step",
    },
    {
      name: "spacingX",
      label: "Spacing X",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.5,
      step: 0.001,
      default: 0.1,
      visibleIf: (p) => p.spacingMode === "step",
    },
    {
      name: "spacingY",
      label: "Spacing Y",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.5,
      step: 0.001,
      default: 0.1,
      visibleIf: (p) => p.spacingMode === "step",
    },
    {
      name: "x",
      label: "Center X",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "y",
      label: "Center Y",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
    },
  ],
  linkedPairs: [
    { a: "countX", b: "countY" },
    { a: "width", b: "height" },
    { a: "spacingX", b: "spacingY" },
  ],
  primaryOutput: "points",
  auxOutputs: [],

  compute({ params }) {
    const cols = Math.max(1, Math.floor((params.countX as number) ?? 5));
    const rows = Math.max(1, Math.floor((params.countY as number) ?? 5));
    const mode = (params.spacingMode as string) ?? "fit";
    const cx = (params.x as number) ?? 0.5;
    const cy = (params.y as number) ?? 0.5;

    // Gap between neighbors per axis. A 1-count axis has span 0 and
    // collapses onto the center line in both modes.
    const stepX =
      mode === "step"
        ? ((params.spacingX as number) ?? 0.1)
        : cols > 1
          ? ((params.width as number) ?? 0.8) / (cols - 1)
          : 0;
    const stepY =
      mode === "step"
        ? ((params.spacingY as number) ?? 0.1)
        : rows > 1
          ? ((params.height as number) ?? 0.8) / (rows - 1)
          : 0;

    const originX = cx - (stepX * (cols - 1)) / 2;
    const originY = cy - (stepY * (rows - 1)) / 2;

    const out = makePoints(cols * rows);
    const pos = out.positions;
    let i = 0;
    for (let iy = 0; iy < rows; iy++) {
      const py = originY + stepY * iy;
      for (let ix = 0; ix < cols; ix++) {
        pos[i * 2] = originX + stepX * ix;
        pos[i * 2 + 1] = py;
        i++;
      }
    }
    return { primary: out };
  },
};
