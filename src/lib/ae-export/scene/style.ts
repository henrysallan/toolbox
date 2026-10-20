// Style nodes → Fill / Stroke / Gradient items (spec §4.5).
//
//   spline-fill       Fill; stack_subpaths (default) fills each subpath on
//                     its own (one group per subpath, nonzero) — off, one
//                     group with the node's rule
//   spline-stroke     Stroke: width (px / % of W), caps, joins, miter, ≤ 3
//                     dash pairs (dotted = dash 0 + round caps), Taper for a
//                     monotonic per-anchor width; a per-subpath color ramp →
//                     one group per subpath with its own color
//   rasterize-spline  Fill + Stroke, its gradient fill (linear / radial) →
//                     Gradient Fill per subpath with toolbox's own frame
//                     (spline-gradient-fill.ts), stops through an SVG seed
//                     or a synthesized .ffx (opts.gradientRoute)
//   bundled raster    a primitive's aux:image: Fill (even-odd) under a
//                     round-capped, round-joined Stroke, the node's opacity
//                     on the group
//
// Anything a style node does that AE cannot (repeats, per-subpath widths,
// ramps along the path, image fills, holes / layered overlap) throws
// BakeSignal: the segment bakes rather than exporting a wrong look.

import { normalizeRampInterp, normalizeRampSpace, type ColorRampStop } from "@/engine/color-ramp";
import { makeSubpathColorFn, type ColorRampBy } from "@/engine/spline-color-source";
import { makeSubpathGradientFn, type GradientCanvas } from "@/engine/spline-gradient-fill";
import { subpathHasWidthProfile } from "@/engine/spline-width";
import type { SplineSubpath } from "@/engine/types";
import { rampToAeStops } from "../convert";
import type { AeGradientStops, AeProp, AeRGB, AeShapeItem } from "../types";
import { colorProp, isAnimatedParam, scalarProp, staticNumber, type WalkCtx } from "./context";
import { sourceEndpoint } from "./graph";
import { BakeSignal, type Scope } from "./layers";
import { animatedUpstream, splineAt, type Geom } from "./shape";

export const STYLE_TYPES = new Set(["spline-fill", "spline-stroke", "rasterize-spline"]);

type Css = { rgb: AeRGB; a: number };
function parseCss(c: string): Css {
  const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/.exec(c);
  if (!m) return { rgb: [1, 1, 1], a: 1 };
  return { rgb: [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255], a: m[4] === undefined ? 1 : Number(m[4]) };
}

const widthMap = (ctx: WalkCtx, units: unknown) => ({ scale: units === "%" ? ctx.canvas.width / 100 : 1, offset: 0 });

function capOf(v: unknown): "butt" | "round" | "square" {
  return v === "butt" || v === "square" ? v : "round";
}
function joinOf(v: unknown): "miter" | "round" | "bevel" {
  return v === "miter" || v === "bevel" ? v : "round";
}

// The geometry's leaves as one group each — only when every item is a plain
// path, one per subpath.
function perSubpath(geom: Geom): AeShapeItem[][] | null {
  if (geom.items.length > 1 && geom.items.every((it) => it.kind === "path")) return geom.items.map((it) => [it]);
  return null;
}

export function styleGroups(scope: Scope, id: string, type: string, mode: "node" | "bundled", geom: Geom): AeShapeItem[] {
  const { ctx } = scope;
  const name = ctx.graph.name(id);
  if (mode === "bundled") return bundledStyle(scope, id, name, geom);
  if (type === "spline-fill") return fillStyle(scope, id, name, geom);
  if (type === "spline-stroke") return strokeStyle(scope, id, name, geom);
  return rasterizeStyle(scope, id, name, geom);
}

function fillItem(scope: Scope, id: string, param: string, rule: "nonzero" | "evenodd", fallback = "#ffffff"): AeShapeItem {
  const c = colorProp(scope.ctx, scope.clock, id, param, { shapeOrSolid: true, fallback });
  return { kind: "fill", color: c.color, opacity: c.opacity, rule };
}

function bundledStyle(scope: Scope, id: string, name: string, geom: Geom): AeShapeItem[] {
  const { ctx, clock } = scope;
  const p = ctx.graph.params(id);
  if (ctx.graph.wireInto(id, "in:fill") && p.fill_enabled) throw new BakeSignal(`${name}: an image wired into its fill has no shape form here yet`);
  const contents: AeShapeItem[] = [...geom.items];
  if (p.stroke_enabled) {
    const c = colorProp(ctx, clock, id, "stroke_color", { shapeOrSolid: true });
    contents.push({
      kind: "stroke",
      color: c.color,
      opacity: c.opacity,
      width: scalarProp(ctx, clock, id, "stroke_thickness", { map: widthMap(ctx, p.stroke_units), fallback: 4 }),
      cap: "round",
      join: "round",
      miterLimit: 4,
    });
  }
  if (p.fill_enabled) contents.push(fillItem(scope, id, "fill_color", "evenodd"));
  const opacityKeyed = isAnimatedParam(ctx, id, "opacity");
  const op = staticNumber(ctx, id, "opacity", 1);
  return [
    {
      kind: "group",
      name,
      contents,
      ...(opacityKeyed || op !== 1 ? { transform: { opacity: scalarProp(ctx, clock, id, "opacity", { map: { scale: 100, offset: 0 }, fallback: 1 }) } } : {}),
    },
  ];
}

function fillStyle(scope: Scope, id: string, name: string, geom: Geom): AeShapeItem[] {
  const { ctx } = scope;
  const p = ctx.graph.params(id);
  const stack = p.stack_subpaths !== false;
  const rule = stack ? "nonzero" : p.rule === "nonzero" ? "nonzero" : "evenodd";
  const leaves = stack ? perSubpath(geom) : null;
  if (leaves) return leaves.map((items, i) => ({ kind: "group", name: `${name} ${i + 1}`, contents: [...items, fillItem(scope, id, "color", "nonzero")] }));
  return [{ kind: "group", name, contents: [...geom.items, fillItem(scope, id, "color", rule)] }];
}

// The evaluated subpaths of a style node's path input (static only).
function subpathsOf(scope: Scope, id: string, why: string): SplineSubpath[] {
  const { ctx } = scope;
  const w = ctx.graph.wireInto(id, "in:path");
  if (!w) return [];
  const ep = sourceEndpoint(w);
  if (animatedUpstream(ctx, w.source)) throw new BakeSignal(`${why} on animated geometry — the per-subpath values would change every frame`);
  return splineAt(scope, ep, scope.clock.inFrame).subpaths;
}

function strokeItem(scope: Scope, id: string, p: Record<string, unknown>, color: { color: AeProp<AeRGB>; opacity: AeProp<number> }, thicknessParam: string, unitsParam: string): AeShapeItem {
  const { ctx, clock } = scope;
  const style = String(p.style ?? "solid");
  const wm = widthMap(ctx, p[unitsParam]);
  const item: Extract<AeShapeItem, { kind: "stroke" }> = {
    kind: "stroke",
    color: color.color,
    opacity: color.opacity,
    width: scalarProp(ctx, clock, id, thicknessParam, { map: wm, fallback: 4 }),
    cap: style === "dotted" ? "round" : capOf(p.cap),
    join: joinOf(p.join),
    miterLimit: typeof p.miter_limit === "number" ? p.miter_limit : 10,
  };
  if (style === "dashed") {
    item.dashes = [{ dash: scalarProp(ctx, clock, id, "dash_length", { map: wm, fallback: 10 }), gap: scalarProp(ctx, clock, id, "dash_gap", { map: wm, fallback: 8 }) }];
    item.dashOffset = { v: 0 };
    ctx.report.note(id, "dashes → one Dash / Gap pair (Canvas and AE both start the pattern at each path's start)");
  } else if (style === "dotted") {
    item.dashes = [{ dash: { v: 0 }, gap: scalarProp(ctx, clock, id, "dot_spacing", { map: wm, fallback: 12 }) }];
    item.dashOffset = { v: 0 };
    ctx.report.note(id, "dotted → Dash 0 + Gap with round caps");
  }
  return item;
}

// A monotonic per-anchor width profile on one subpath → Stroke Taper.
function taperOf(scope: Scope, id: string, subs: SplineSubpath[]): Extract<AeShapeItem, { kind: "stroke" }>["taper"] | null {
  const profiled = subs.filter(subpathHasWidthProfile);
  if (!profiled.length) return null;
  if (subs.length !== 1) throw new BakeSignal("per-anchor widths on several subpaths — AE's Taper is per stroke");
  const w = subs[0].anchors.map((a) => (typeof a.width === "number" ? a.width : 1));
  const up = w.every((x, i) => i === 0 || x >= w[i - 1] - 1e-9);
  const down = w.every((x, i) => i === 0 || x <= w[i - 1] + 1e-9);
  if (!up && !down) throw new BakeSignal("a non-monotonic width profile has no Stroke Taper form");
  const max = Math.max(...w);
  if (!(max > 0)) throw new BakeSignal("a zero-width profile");
  scope.ctx.report.approx(id, "per-anchor width → Stroke Taper (AE tapers linearly in length, toolbox lerps per anchor)");
  const first = (w[0] / max) * 100;
  const last = (w[w.length - 1] / max) * 100;
  return {
    startLength: { v: up ? 100 : 0 },
    endLength: { v: down ? 100 : 0 },
    startWidth: { v: up ? first : 100 },
    endWidth: { v: down ? last : 100 },
    startEase: { v: 0 },
    endEase: { v: 0 },
  };
}

function strokeStyle(scope: Scope, id: string, name: string, geom: Geom): AeShapeItem[] {
  const { ctx, clock } = scope;
  const p = ctx.graph.params(id);
  if (typeof p.repeats === "number" && p.repeats > 1) throw new BakeSignal("Stroke repeats (offset rings) — no exact AE form");
  if (p.thickness_source === "vary") throw new BakeSignal("Stroke thickness_source = vary (per-subpath widths)");
  if (p.close_open_paths) ctx.report.approx(id, "close_open_paths: AE strokes open paths open");
  // Stroke width maps to the widest anchor; the taper scales it down.
  const widthProfiled = !animatedUpstream(ctx, ctx.graph.wireInto(id, "in:path")?.source ?? id) ? subpathsOf(scope, id, "width profile") : [];
  const taper = taperOf(scope, id, widthProfiled);
  if (taper) {
    const max = Math.max(...widthProfiled[0].anchors.map((a) => (typeof a.width === "number" ? a.width : 1)));
    if (max !== 1) ctx.report.note(id, `stroke width × ${max.toFixed(3)} (the widest anchor)`);
  }
  const withTaper = (s: AeShapeItem): AeShapeItem => {
    if (!taper || s.kind !== "stroke") return s;
    const max = Math.max(...widthProfiled[0].anchors.map((a) => (typeof a.width === "number" ? a.width : 1)));
    const width = "v" in s.width ? { v: s.width.v * max } : s.width;
    return { ...s, width, taper };
  };
  if (p.color_source !== "ramp") {
    const c = colorProp(ctx, clock, id, "color", { shapeOrSolid: true });
    return [{ kind: "group", name, contents: [...geom.items, withTaper(strokeItem(scope, id, p, c, "thickness", "units"))] }];
  }
  const by = String(p.ramp_by ?? "index");
  if (by === "progress" || by === "attribute") throw new BakeSignal(`Stroke color ramp by ${by} varies along the path — AE's gradient stroke is spatial, not along the path`);
  if (isAnimatedParam(ctx, id, "color_ramp")) throw new BakeSignal("animated stroke ramp stops");
  const subs = subpathsOf(scope, id, `color ramp by ${by}`);
  const colorAt = makeSubpathColorFn(subs, {
    source: "ramp",
    flatColor: String(p.color ?? "#ffffff"),
    stops: Array.isArray(p.color_ramp) ? (p.color_ramp as ColorRampStop[]) : [],
    by: by as ColorRampBy,
    seed: Math.floor(typeof p.ramp_seed === "number" ? p.ramp_seed : 0),
    angleDeg: typeof p.ramp_angle === "number" ? p.ramp_angle : 0,
    interp: normalizeRampInterp(p.ramp_interp),
    space: normalizeRampSpace(p.ramp_space),
    attr: typeof p.driver_attr === "string" ? p.driver_attr : "",
  });
  const leaves = perSubpath(geom) ?? (subs.length <= 1 ? [geom.items] : null);
  if (!leaves || leaves.length !== Math.max(1, subs.length)) throw new BakeSignal("per-subpath stroke colors need one path per subpath (modifiers merge them here)");
  ctx.report.note(id, `color ramp by ${by} → ${leaves.length} strokes, one color each`);
  return leaves.map((items, i) => {
    const css = parseCss(colorAt(i, subs[i] ?? subs[0]));
    return { kind: "group", name: `${name} ${i + 1}`, contents: [...items, withTaper(strokeItem(scope, id, p, { color: { v: css.rgb }, opacity: { v: css.a * 100 } }, "thickness", "units"))] };
  });
}

// A GradientCanvas that records what makeSubpathGradientFn asks for.
interface Recorded {
  kind: "linear" | "radial";
  a: [number, number];
  b: [number, number];
  stops: { pos: number; color: string }[];
}
function recordingCanvas(out: Recorded[]): GradientCanvas {
  const grad = (r: Recorded) => {
    out.push(r);
    return { addColorStop: (pos: number, color: string) => r.stops.push({ pos, color }) } as unknown as CanvasGradient;
  };
  return {
    createLinearGradient: (x0, y0, x1, y1) => grad({ kind: "linear", a: [x0, y0], b: [x1, y1], stops: [] }),
    createRadialGradient: (x0, y0, _r0, _x1, _y1, r1) => grad({ kind: "radial", a: [x0, y0], b: [x0 + r1, y0], stops: [] }),
    createConicGradient: () => {
      throw new BakeSignal("conic gradient fill — no AE gradient type");
    },
  };
}

function stopsOf(r: Recorded): AeGradientStops {
  const colors: AeGradientStops["colors"] = [];
  const opacities: AeGradientStops["opacities"] = [];
  for (const s of r.stops) {
    const c = parseCss(s.color);
    colors.push({ offset: Math.max(0, Math.min(1, s.pos)), color: c.rgb });
    opacities.push({ offset: Math.max(0, Math.min(1, s.pos)), opacity: c.a });
  }
  return { colors, opacities };
}

const enableStroke = (p: Record<string, unknown>) => p.enable_stroke !== false;

function rasterizeStyle(scope: Scope, id: string, name: string, geom: Geom): AeShapeItem[] {
  const { ctx, clock } = scope;
  const p = ctx.graph.params(id);
  if ((p.overlap ?? "flatten") !== "flatten") throw new BakeSignal(`Rasterize Spline overlap = ${String(p.overlap)}`);
  if (p.holes || p.fill_holes) throw new BakeSignal("Rasterize Spline hole punching");
  for (const k of ["image_fill", "image_stroke"]) if (ctx.graph.wireInto(id, `in:${k}`)) throw new BakeSignal(`Rasterize Spline ${k} (an image fill)`);
  if (p.thickness_source === "vary") throw new BakeSignal("Rasterize Spline thickness_source = vary");
  if (p.cap === "arrowhead" && enableStroke(p) && p.style !== "dotted" && !p.close_open_paths && (p.arrow_start === true || p.arrow_end !== false))
    throw new BakeSignal("Rasterize Spline arrow heads");
  const groups: AeShapeItem[] = [];
  const strokeOn = p.enable_stroke !== false;
  const fillOn = p.enable_fill !== false;
  const stroke = () => {
    if (p.stroke_source === "ramp") throw new BakeSignal("Rasterize Spline stroke ramp");
    const c = colorProp(ctx, clock, id, "stroke_color", { shapeOrSolid: true, fallback: "#000000" });
    return strokeItem(scope, id, p, c, "thickness", "units");
  };
  const rule: "nonzero" | "evenodd" = p.stack_subpaths !== false ? "nonzero" : p.fill_rule === "nonzero" ? "nonzero" : "evenodd";
  if (!fillOn || p.fill_source === "flat" || p.fill_source === undefined) {
    const contents: AeShapeItem[] = [...geom.items];
    if (strokeOn) contents.push(stroke());
    if (fillOn) contents.push(fillItem(scope, id, "fill_color", rule));
    return [{ kind: "group", name, contents }];
  }
  if (p.fill_source === "ramp") throw new BakeSignal("Rasterize Spline fill ramp by subpath — per-subpath fills not mapped yet");
  // Gradient fill: toolbox's per-subpath frame, recorded in comp px.
  if (p.gradient_kind === "conic") throw new BakeSignal("conic gradient fill — no AE gradient type");
  if (p.gradient_vary && p.gradient_vary !== "none") throw new BakeSignal("gradient_vary (per-subpath phase)");
  for (const k of ["fill_ramp", "gradient_angle", "gradient_scale", "gradient_offset"])
    if (isAnimatedParam(ctx, id, k)) throw new BakeSignal(`animated ${k} — AE gradient stops / points from a preset are static`);
  const subs = subpathsOf(scope, id, "gradient fill");
  const rec: Recorded[] = [];
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const fn = makeSubpathGradientFn(recordingCanvas(rec), subs, {
    kind: p.gradient_kind === "radial" ? "radial" : "linear",
    frame: p.gradient_frame === "canvas" ? "canvas" : "shape",
    angleDeg: typeof p.gradient_angle === "number" ? p.gradient_angle : 0,
    scale: typeof p.gradient_scale === "number" ? p.gradient_scale : 1,
    offset: typeof p.gradient_offset === "number" ? p.gradient_offset : 0,
    stops: Array.isArray(p.fill_ramp) ? (p.fill_ramp as ColorRampStop[]) : [],
    interp: normalizeRampInterp(p.ramp_interp),
    space: normalizeRampSpace(p.ramp_space),
    vary: "none",
    varyAmount: 0,
    seed: 0,
    varyAngleDeg: 0,
  }, W, H);
  const leaves = perSubpath(geom) ?? (subs.length <= 1 ? [geom.items] : null);
  if (!leaves || leaves.length !== Math.max(1, subs.length)) throw new BakeSignal("per-subpath gradients need one path per subpath");
  const ramp = rampToAeStops(Array.isArray(p.fill_ramp) ? (p.fill_ramp as ColorRampStop[]) : [], { interp: p.ramp_interp as string, space: p.ramp_space as string, tolerance255: ctx.policy.colorTolerance });
  if (!ramp.exact) ctx.report.note(id, `ramp (${String(p.ramp_space ?? "srgb")}, ${String(p.ramp_interp ?? "linear")}) → ${ramp.stops.colors.length} sRGB stops within ${ramp.maxError255.toFixed(1)}/255`);
  leaves.forEach((items, i) => {
    const before = rec.length;
    const g = fn(i, subs[i] ?? subs[0]);
    const contents: AeShapeItem[] = [...items];
    if (strokeOn) contents.push(stroke());
    if (typeof g === "string" || rec.length === before) {
      const css = parseCss(typeof g === "string" ? g : "rgba(255,255,255,1)");
      contents.push({ kind: "fill", color: { v: css.rgb }, opacity: { v: css.a * 100 }, rule });
    } else {
      const r = rec[rec.length - 1];
      const offset = typeof p.gradient_offset === "number" ? p.gradient_offset : 0;
      const stops = offset === 0 && ramp.exact ? ramp.stops : stopsOf(r);
      contents.push({ kind: "gradient-fill", type: r.kind, start: { v: r.a }, end: { v: r.b }, stops, opacity: { v: 100 }, rule });
    }
    groups.push({ kind: "group", name: leaves.length > 1 ? `${name} ${i + 1}` : name, contents });
  });
  return groups;
}
