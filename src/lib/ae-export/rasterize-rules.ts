// What a Rasterize Spline bakes for, decided from its params and wiring alone
// — shared by the planner (plan.ts) and the walk (scene/style.ts), so the
// plan's "baked" list is the walk's. Geometry-dependent reasons (a gradient
// or hole punching on animated geometry) stay with each side's own checks.
//
// overlap = layered and holes / fill_holes are not here: the walk maps them
// (one group per subpath / per hole island, stacked in toolbox's order).

export function rasterizeBakeReason(p: Record<string, unknown>, wired: (input: string) => boolean): string | null {
  const fillOn = p.enable_fill !== false;
  const strokeOn = p.enable_stroke !== false;
  if (wired("fill") && ((fillOn && p.image_fill !== false) || (strokeOn && p.image_stroke === true)))
    return "Rasterize Spline image fill / stroke (a wired fill image)";
  if (strokeOn) {
    if (p.thickness_source === "vary") return "Rasterize Spline thickness_source = vary";
    if (p.cap === "arrowhead" && p.style !== "dotted" && !p.close_open_paths && (p.arrow_start === true || p.arrow_end !== false)) return "Rasterize Spline arrow heads";
    if (p.stroke_source === "ramp") return "Rasterize Spline stroke ramp";
  }
  if (fillOn) {
    if (p.fill_source === "ramp") return "Rasterize Spline fill ramp by subpath — per-subpath fills not mapped yet";
    if (p.fill_source === "gradient" && p.gradient_kind === "conic") return "conic gradient fill — no AE gradient type";
    if (p.fill_source === "gradient" && p.gradient_vary && p.gradient_vary !== "none") return "gradient_vary (per-subpath phase)";
  }
  return null;
}

// Hole punching changes the fill (fill only, as toolbox draws it).
export const punchesHoles = (p: Record<string, unknown>) => p.enable_fill !== false && (p.holes === true || p.fill_holes === true);
