import type { NodeDefinition, SplineSubpath } from "@/engine/types";
import { bindDerived, type Bind, type GradientStopIR, type RGBA, type ShaderIR, type SkiaNode } from "@/engine/skia/scene-ir";
import { rampInterpParam, rampSpaceParam, normalizeRampInterp, normalizeRampSpace, type ColorRampStop } from "@/engine/color-ramp";
import { rampToGradientStops, subpathGradientFrame, type GradientFrame, type GradientKind } from "@/engine/spline-gradient-fill";
import { makeSubpathDriverFn, type ColorRampBy } from "@/engine/spline-color-source";
import { makeCircleSubpath } from "../source/circle";
import { copyShape, geomSubpaths, modifyDrawing, num, subpathsToD, type ShapeNode } from "./paint-shared";

// Gradient Fill (Skia) — Rasterize Spline's `fill_source: gradient`
// (engine/spline-gradient-fill.ts) as a modifier over a drawing: each
// contour of each shape gets its own linear / radial / sweep gradient
// paint shader, laid out in that contour's frame exactly as
// makeSubpathGradientFn lays out the Canvas2D gradient — same origin
// (anchor mean), same "up" (origin → first anchor, handedness from the
// winding) or canvas angle, same extent along the axis, same scale.
//
// Color: Canvas2D (and so Rasterize Spline) only lerps gamma sRGB between
// stops, so the original already approximates every other interpolation /
// color space piecewise-linearly (rampToGradientStops: 16 linear segments
// per interval for OKLab / smooth ramps). This node ships THOSE stops, so
// sRGB gradients reproduce the original stop for stop; an OKLab ramp is
// exactly as approximate as the original. The IR stays a gradient; the
// renderer and the exporter lower it to a color-managed program
// (engine/skia/library/gradient-program.ts), so it interpolates in sRGB on
// a Display P3 canvas too.
// Conic: Canvas2D starts the ramp at the frame angle; a Skia sweep starts
// at +x, so the stops are rotated by the angle (with a hard seam stop pair)
// and the sweep keeps its default 0..360°.
//
// A shape with several contours is split into one shape per contour (as
// Rasterize Spline fills each subpath with its own gradient), which drops
// even-odd holes — Rasterize Spline's gradient fill stacks subpaths too.
// The shader replaces the paint color's RGB; its alpha still scales.

const KINDS = ["linear", "radial", "conic"] as const;
const VARY = ["none", "index", "random", "position"] as const;
const EPS = 1e-6;

function cssToRgba(css: string): RGBA {
  const m = /rgba?\(([^)]*)\)/.exec(css);
  const p = m ? m[1].split(",").map((s) => Number(s.trim())) : [255, 255, 255, 1];
  return [p[0] / 255, p[1] / 255, p[2] / 255, p.length > 3 ? p[3] : 1];
}

type Stop = { pos: number; color: RGBA };

// The stop list's color at u (piecewise linear, as the gradient draws it).
function stopAt(stops: Stop[], u: number): RGBA {
  if (!stops.length) return [0, 0, 0, 0];
  if (u <= stops[0].pos) return stops[0].color;
  for (let i = 1; i < stops.length; i++) {
    const b = stops[i];
    if (u <= b.pos) {
      const a = stops[i - 1];
      const t = b.pos - a.pos > 0 ? (u - a.pos) / (b.pos - a.pos) : 1;
      return a.color.map((x, k) => x + (b.color[k] - x) * t) as RGBA;
    }
  }
  return stops[stops.length - 1].color;
}

// A sweep from +x whose color at sweep fraction u is the ramp at
// frac(u − a): stops moved by +a, wrapped, with the seam (ramp end | ramp
// start) at a and the ends at the ramp's 1 − a. Always stops.length + 4
// stops, so a rotating frame keeps the scene's structure.
function rotateStops(stops: Stop[], a: number): Stop[] {
  const shifted = stops.map((s) => {
    const p = s.pos + a;
    return { pos: p >= 1 ? p - 1 : p, color: s.color };
  });
  const lo = shifted.filter((s, i) => stops[i].pos + a >= 1).sort((x, y) => x.pos - y.pos);
  const hi = shifted.filter((s, i) => stops[i].pos + a < 1).sort((x, y) => x.pos - y.pos);
  const end = stopAt(stops, 1 - a);
  const last = stops[stops.length - 1]?.color ?? end;
  const first = stops[0]?.color ?? end;
  return [{ pos: 0, color: end }, ...lo, { pos: a, color: last }, { pos: a, color: first }, ...hi, { pos: 1, color: end }];
}

// The outline a primitive without corners stands for: toolbox's circle
// (top, right, bottom, left — the first anchor on top, as Circle draws it)
// for circles and ovals, the rect's corners for a rounded rect.
function frameOutline(s: ShapeNode): SplineSubpath[] | null {
  const g = s.geom;
  if (g.k === "circle") return [makeCircleSubpath(g.cx.v, g.cy.v, g.r.v, g.r.v)];
  if (g.k === "oval") return [makeCircleSubpath(g.x.v + g.w.v / 2, g.y.v + g.h.v / 2, g.w.v / 2, g.h.v / 2)];
  if (g.k === "rect") {
    const [x, y, w, h] = [g.x.v, g.y.v, g.w.v, g.h.v];
    return [{ closed: true, anchors: [{ pos: [x, y] }, { pos: [x + w, y] }, { pos: [x + w, y + h] }, { pos: [x, y + h] }] }];
  }
  return null;
}

export const skiaGradientFillNode: NodeDefinition = {
  type: "skia-gradient-fill",
  name: "Gradient Fill (Skia)",
  category: "spline",
  subcategory: "modifier",
  description:
    "Fills every contour of every shape in a Skia drawing with its own linear, radial or conic gradient, laid out in the contour's frame like Rasterize Spline's gradient fill. Each gradient draws and exports as a small color-managed runtime shader (sRGB interpolation on every canvas, Display P3 iPhones included). Ramps in OKLab or smooth interpolation ship as the same piecewise-linear stops Rasterize Spline draws.",
  searchAliases: ["skia", "gradient", "gradient fill", "linear gradient", "radial gradient", "conic", "react native"],
  facts: {
    gotchas: [
      "gradient_frame=shape takes up as contour center → first anchor (handedness from winding), angle 0 = left→right on an unrotated Circle; canvas fixes the angle, as in Rasterize Spline.",
      "Skia gradients lerp in sRGB: OKLab / smooth ramps ship as Rasterize Spline's own 16-segments-per-interval stop list, so they match it, not the exact ramp.",
      "Renders and exports as a runtime shader (a native RN gradient shifts up to ~48/255 on a P3 iPhone); cost grows per stop — a 49-stop OKLab ramp is ~7× a native gradient on a GPU.",
      "Multi-contour shapes split into one shape per contour (even-odd holes are lost, as with Rasterize Spline's stacked gradient fill); an export needs the contour count to hold still.",
      "An animated gradient_offset can add or drop the wrap seam's stops, which changes the scene's structure; keep it constant (or always non-zero) to export.",
      "gradient_vary group / driver need spline attributes a drawing doesn't carry; only index / random / position are offered.",
    ],
  },
  backend: "webgl2",
  skia: { class: "native", mirrors: "rasterize-spline" },
  noMaskInput: true,
  inputs: [{ name: "drawing", label: "Drawing", type: "skia_draw", required: true }],
  params: [
    {
      name: "fill_ramp",
      label: "Gradient",
      type: "color_ramp",
      default: [
        { id: "stop-a", position: 0, color: "#ffffff" },
        { id: "stop-b", position: 1, color: "#000000" },
      ] as ColorRampStop[],
    },
    rampInterpParam({ name: "ramp_interp" }),
    rampSpaceParam({ name: "ramp_space" }),
    { name: "gradient_kind", label: "Kind", type: "enum", options: [...KINDS], default: "linear" },
    { name: "gradient_frame", label: "Frame", type: "enum", options: ["shape", "canvas"], default: "shape" },
    {
      name: "gradient_angle",
      label: "Angle",
      type: "scalar",
      min: -180,
      max: 180,
      step: 1,
      default: 0,
      visibleIf: (p) => p.gradient_kind !== "radial",
    },
    {
      name: "gradient_scale",
      label: "Scale",
      type: "scalar",
      min: 0.1,
      max: 4,
      step: 0.01,
      default: 1,
      visibleIf: (p) => p.gradient_kind !== "conic",
    },
    { name: "gradient_offset", label: "Offset", type: "scalar", min: -1, max: 1, step: 0.01, default: 0 },
    { name: "gradient_vary", label: "Vary by", type: "enum", options: [...VARY], default: "none" },
    {
      name: "gradient_vary_amount",
      label: "Vary amount",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
      visibleIf: (p) => (p.gradient_vary ?? "none") !== "none",
    },
    {
      name: "ramp_seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 9999,
      step: 1,
      default: 0,
      visibleIf: (p) => p.gradient_vary === "random",
    },
    {
      name: "ramp_angle",
      label: "Vary angle",
      type: "scalar",
      min: -180,
      max: 180,
      step: 1,
      default: 0,
      visibleIf: (p) => p.gradient_vary === "position",
    },
  ],
  primaryOutput: "skia_draw",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const W = ctx.width;
    const H = ctx.height;
    const kind: GradientKind = KINDS.includes(params.gradient_kind as GradientKind) ? (params.gradient_kind as GradientKind) : "linear";
    const frame: GradientFrame = params.gradient_frame === "canvas" ? "canvas" : "shape";
    const angleDeg = num(params.gradient_angle, 0);
    const scale = Math.min(100, Math.max(0.01, num(params.gradient_scale, 1)));
    const ramp = Array.isArray(params.fill_ramp) ? (params.fill_ramp as ColorRampStop[]) : [];
    const interp = normalizeRampInterp(params.ramp_interp);
    const space = normalizeRampSpace(params.ramp_space);
    const baseOffset = num(params.gradient_offset, 0);
    const vary = VARY.includes(params.gradient_vary as (typeof VARY)[number]) ? (params.gradient_vary as (typeof VARY)[number]) : "none";
    const amount = num(params.gradient_vary_amount, 0.5);
    // Stop lists by quantized phase, as makeSubpathGradientFn shares them.
    const stopCache = new Map<number, Stop[]>();
    const stopsFor = (shift: number): Stop[] => {
      const key = Math.round(shift * 1024);
      let list = stopCache.get(key);
      if (!list) {
        list = rampToGradientStops(ramp, interp, key / 1024, space).map((s) => ({ pos: s.pos, color: cssToRgba(s.color) }));
        stopCache.set(key, list);
      }
      return list;
    };
    // Derived from this node's params and the drawing's geometry (deps: []
    // with the shape re-id'd to this node: the exporter walks both).
    const d = <T,>(v: T): Bind<T> => bindDerived(v, []);
    const xy = (x: number, y: number): [Bind<number>, Bind<number>] => [d(x), d(y)];
    const stopIR = (stops: Stop[]): GradientStopIR[] => stops.map((s) => ({ pos: d(s.pos), color: d(s.color) }));

    const shaderFor = (sub: SplineSubpath, shift: number): ShaderIR => {
      const stops = stopsFor(shift);
      const solid = (): ShaderIR => ({ k: "color", color: d(stopAt(stops, 0.5)) });
      const fr = subpathGradientFrame(sub, frame, angleDeg);
      if (!fr) return solid();
      if (kind === "radial") {
        const r = fr.radius * scale;
        if (!(r > EPS)) return solid();
        return { k: "radial", c: xy(fr.cx, fr.cy), r: d(r), stops: stopIR(stops) };
      }
      if (kind === "conic") {
        const a = (((fr.angle / (2 * Math.PI)) % 1) + 1) % 1;
        return { k: "sweep", c: xy(fr.cx, fr.cy), stops: stopIR(rotateStops(stops, a)) };
      }
      const mid = (fr.minProj + fr.maxProj) / 2;
      const half = ((fr.maxProj - fr.minProj) / 2) * scale;
      if (!(half > EPS)) return solid();
      return {
        k: "linear",
        start: xy(fr.cx + fr.dirX * (mid - half), fr.cy + fr.dirY * (mid - half)),
        end: xy(fr.cx + fr.dirX * (mid + half), fr.cy + fr.dirY * (mid + half)),
        stops: stopIR(stops),
      };
    };

    // Pass 1: every contour of the drawing, in draw order — `vary` indexes
    // them as Rasterize Spline indexes a spline's subpaths (a stacked Fill
    // (Skia) is one shape per subpath, but still one index sequence).
    const problems: string[] = [];
    const contours = new Map<ShapeNode, { subs: SplineSubpath[]; split: boolean }>();
    const all: SplineSubpath[] = [];
    const collect = (n: SkiaNode) => {
      if (n.k === "group") return n.children.forEach(collect);
      if (n.k !== "shape") return;
      const g = geomSubpaths(n.geom);
      if (g && "problem" in g) {
        problems.push(`Gradient Fill (Skia) "${nodeId}": ${g.problem}; left unfilled by the gradient.`);
        return;
      }
      // Circles, ovals and rounded rects keep their geometry; their frame
      // comes from the outline toolbox would draw for them.
      const subs = g ? g.subpaths.filter((x) => x.anchors.length >= 1) : frameOutline(n);
      if (!subs || !subs.length) return;
      contours.set(n, { subs, split: !!g && subs.length > 1 });
      all.push(...subs);
    };
    const input = inputs.drawing;
    if (input?.kind === "skia_draw") collect(input.node);
    // The vary driver reads authored coordinates (canvas01, y
    // aspect-corrected), the space Rasterize Spline's subpaths are in.
    const authored = all.map((sub) => ({
      ...sub,
      anchors: sub.anchors.map((a) => ({ ...a, pos: [a.pos[0] / W, 0.5 + (a.pos[1] - H / 2) / W] as [number, number] })),
    }));
    const varyAt =
      vary !== "none" && amount !== 0
        ? makeSubpathDriverFn(authored, { by: vary as ColorRampBy, seed: Math.floor(num(params.ramp_seed, 0)), angleDeg: num(params.ramp_angle, 0) })
        : null;
    let next = 0;
    // Pass 2: the gradients.
    const out = modifyDrawing(
      inputs.drawing,
      nodeId,
      (s: ShapeNode): SkiaNode => {
        const c0 = contours.get(s);
        if (!c0) return s;
        const { subs, split } = c0;
        const one = (sub: SplineSubpath): ShapeNode => {
          const c = copyShape(s, nodeId);
          if (split) c.geom = { k: "path", d: d(subpathsToD([sub])), fillType: "winding" };
          const i = next++;
          c.paint.shader = shaderFor(sub, baseOffset + (varyAt ? amount * varyAt(i, authored[i]) : 0));
          return c;
        };
        if (!split) return one(subs[0]);
        return { k: "group", id: nodeId, children: subs.map((sub) => one(sub)) };
      },
      problems
    );
    return { primary: out };
  },
};
