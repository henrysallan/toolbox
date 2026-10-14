import type { RenderContext } from "@/engine/types";
import { bindParam, bindStatic, type Bind, type GeomIR, type PaintIR, type SkiaNode, type TransformIR } from "@/engine/skia/scene-ir";
import { hexToRgba01 } from "@/engine/spline-fill";

// Shared by the native Skia primitives (skia-circle / skia-rect / skia-line,
// specdocs/101326_skia-target.md §7 Wave 2 family 7). They take the
// spline primitives' params verbatim (canvas01, the bundled stroke / fill)
// and emit React Native Skia's own primitives with DIRECT binds: every
// geometry value is one param × a constant, so a keyframed or driven param
// exports as an exact timeline track instead of a sampled path.
//
// canvas01 → canvas px is Rasterize Spline's mapping (buildPath2D):
//   x_px = x·W        y_px = H/2 + (y − ½)·W = y·W + (H − W)/2
// One uniform scale W on both axes, plus a y shift on a non-square canvas.
// The scale rides on BindRef.scale; the shift is a static outer Group
// translate (withCanvasOffset), so no bind is affine.

export const DEG = Math.PI / 180;

export const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

export interface Canvas01 {
  // canvas01 → px scale (the canvas width).
  W: number;
  // The y shift, (H − W) / 2.
  off: number;
}

export function canvas01Of(ctx: Pick<RenderContext, "width" | "height">): Canvas01 {
  return { W: ctx.width, off: (ctx.height - ctx.width) / 2 };
}

// A scalar param as IR: `p × scale`, tagged so the exporter ships the
// param's track scaled. `clamp0` mirrors the spline primitives'
// Math.max(0, …): a key that overshoots below 0 then draws what the node
// draws, and the export's per-frame check samples that value instead.
export function scaledParam(
  nodeId: string,
  params: Record<string, unknown>,
  name: string,
  dflt: number,
  scale: number,
  clamp0 = false
): Bind<number> {
  const raw = num(params[name], dflt);
  const p = clamp0 ? Math.max(0, raw) : raw;
  return scale === 1 ? bindParam(p, nodeId, name) : { v: p * scale, ref: { node: nodeId, param: name, scale } };
}

function colorParam(nodeId: string, params: Record<string, unknown>, name: string): Bind<[number, number, number, number]> {
  return bindParam(hexToRgba01(typeof params[name] === "string" ? (params[name] as string) : "#ffffff"), nodeId, name);
}

// The bundled raster params (SPLINE_RASTER_PARAMS) as paints, in the
// rasterizer's draw order: fill, then the stroke over it. Stroke caps and
// joins are round, as rasterizeSplineAux strokes; stroke_units=% is a
// fraction of the canvas width (resolveStrokePx).
export function primitivePaints(
  nodeId: string,
  params: Record<string, unknown>,
  c: Canvas01,
  o: { fill: boolean }
): PaintIR[] {
  const out: PaintIR[] = [];
  const opacity = () => bindParam(num(params.opacity, 1), nodeId, "opacity");
  // Truthiness, exactly as rasterizeSplineAux reads them.
  if (o.fill && !!params.fill_enabled) {
    out.push({ style: "fill", color: colorParam(nodeId, params, "fill_color"), opacity: opacity(), antiAlias: true });
  }
  if (!!params.stroke_enabled) {
    const scale = params.stroke_units === "%" ? c.W / 100 : 1;
    out.push({
      style: "stroke",
      color: colorParam(nodeId, params, "stroke_color"),
      opacity: opacity(),
      strokeWidth: scaledParam(nodeId, params, "stroke_thickness", 4, scale, true),
      strokeCap: "round",
      strokeJoin: "round",
      antiAlias: true,
    });
  }
  return out;
}

// One shape per paint; `geom` is called per shape so no Bind object is
// shared between two places in the tree.
export function shapesOf(nodeId: string, paints: PaintIR[], geom: () => GeomIR): SkiaNode[] {
  return paints.map((paint) => ({ k: "shape", id: nodeId, geom: geom(), paint }));
}

export function groupOf(nodeId: string, children: SkiaNode[], transform?: TransformIR): SkiaNode {
  return { k: "group", id: nodeId, ...(transform ? { transform } : {}), children };
}

// The (H − W)/2 y shift as a static Group translate around the drawing —
// only on a non-square canvas (it is constant for the whole export).
export function withCanvasOffset(nodeId: string, node: SkiaNode, c: Canvas01): SkiaNode {
  if (c.off === 0) return node;
  return groupOf(nodeId, [node], { translate: [bindStatic(0), bindStatic(c.off)] });
}
