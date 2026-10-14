import type {
  NodeDefinition,
  NodeFacts,
  OutputSocketDef,
  ParamDef,
  RenderContext,
  SdfValue,
  SkiaShaderValue,
  SocketValue,
} from "@/engine/types";
import { bindDerived, bindParam, bindStatic, type Bind } from "@/engine/skia/scene-ir";
import type { ShaderExpr } from "@/engine/skia/shader-expr";
import { canvasKit, canvasKitError, canvasKitReady, ensureCanvasKit } from "@/engine/skia/canvaskit";
import { constExpr, mirrorParams, renderShaderPreview, SKSL_PREVIEW_OUTPUT } from "@/engine/skia/library";
import { hexToRgba01, instrumentSdfDefs } from "@/engine/skia/sdf/provenance";
import { compileSdfSksl, SKIA_SDF_CURVE_POINTS, SKIA_SDF_TERMINAL_UNIFORMS, type SkiaSdfMode } from "@/engine/skia/sdf/sksl";
import { computeMonotoneTangents, type CurvePoint } from "@/engine/float-curve";
import { sdfRasterizeNode } from "../sdf/rasterize";
import { sdfToMaskNode } from "../sdf/to-mask";
import { sdfToDistanceImageNode } from "../sdf/to-distance-image";
import { sdfBevelNode } from "../sdf/sdf-bevel";
import { sdfShadeNode } from "../sdf/shade";
import { sdfCircleNode } from "../sdf/circle";
import { sdfRectangleNode } from "../sdf/rectangle";
import { sdfLineSegmentNode } from "../sdf/line-segment";
import { sdfPolygonNode } from "../sdf/polygon";
import { sdfTriangleNode } from "../sdf/triangle";
import { sdfStarNode } from "../sdf/star";
import { sdfSplineNode } from "../sdf/spline";
import { sdfUnionNode } from "../sdf/union";
import { sdfIntersectionNode } from "../sdf/intersection";
import { sdfSubtractionNode } from "../sdf/subtraction";
import { sdfSmoothUnionNode } from "../sdf/smooth-union";
import { sdfSmoothIntersectionNode } from "../sdf/smooth-intersection";
import { sdfSmoothSubtractionNode } from "../sdf/smooth-subtraction";
import { sdfMorphNode } from "../sdf/morph";
import { sdfRoundNode } from "../sdf/round";
import { sdfOnionNode } from "../sdf/onion";
import { sdfMaterialNode } from "../sdf/material";
import { sdfTranslateNode } from "../sdf/sdf-translate";
import { sdfScaleNode } from "../sdf/sdf-scale";
import { sdfRotateNode } from "../sdf/sdf-rotate";
import { sdfRepeatNode } from "../sdf/sdf-repeat";
import { sdfMirrorNode } from "../sdf/sdf-mirror";
import { sdfPolarNode } from "../sdf/sdf-polar";
import { sdfTwistNode } from "../sdf/sdf-twist";

// The Skia SDF terminals (specdocs/101326_skia-target.md §3.2, Wave 2 family
// 5): SDF Rasterize / to Mask / to Distance Image / Bevel / Shade, mirrored
// param for param, emitting a `skia_shader` whose expression is a complete
// runtime program generated from the wired SDF tree (engine/skia/sdf/
// sksl.ts) — the shader-expr `program` variant, so a Skia Fill draws it
// as-is and any skia-* shader node can sample it as a child.
//
// The SDF tree nodes themselves stay data-only and are shared with the
// default layer (they carry `skia: { class: "sksl" }`); this module
// instruments their computes once so every generated uniform binds to the
// SDF node + param that produced it (engine/skia/sdf/provenance.ts) and a
// keyframed radius exports as a track.

instrumentSdfDefs([
  sdfCircleNode,
  sdfRectangleNode,
  sdfLineSegmentNode,
  sdfPolygonNode,
  sdfTriangleNode,
  sdfStarNode,
  sdfSplineNode,
  sdfUnionNode,
  sdfIntersectionNode,
  sdfSubtractionNode,
  sdfSmoothUnionNode,
  sdfSmoothIntersectionNode,
  sdfSmoothSubtractionNode,
  sdfMorphNode,
  sdfRoundNode,
  sdfOnionNode,
  sdfMaterialNode,
  sdfTranslateNode,
  sdfScaleNode,
  sdfRotateNode,
  sdfRepeatNode,
  sdfMirrorNode,
  sdfPolarNode,
  sdfTwistNode,
]);

type EnumMap = Record<string, readonly number[]>;

interface TerminalSpec {
  type: string;
  name: string;
  mirror: NodeDefinition;
  mode: SkiaSdfMode;
  description: string;
  facts: NodeFacts;
  // Enum params whose shader value is not the option index (the mirror's
  // own option → int mapping), by option position.
  enumValues?: EnumMap;
  // Booleans the mirror reads as "on unless explicitly false".
  defaultOn?: readonly string[];
  unsupported?: (params: Record<string, unknown>) => string[];
  // SDF Shade's aux layers: one more program each, same SkSL, `channel` set.
  channels?: readonly { name: string; label: string; channel: number }[];
}

interface TerminalState {
  warned?: string | null;
}

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

// One terminal param → its uniform's bind. Scalars and colors bind as
// plain refs (tracks); booleans and enums as derived values (an animated
// one samples instead of refusing the export).
function terminalBind(def: ParamDef, raw: unknown, nodeId: string, spec: TerminalSpec): Bind<number | number[]> {
  const value = raw === undefined ? def.default : raw;
  switch (def.type) {
    case "color":
      return bindParam(hexToRgba01(value) ?? hexToRgba01(def.default) ?? [1, 1, 1, 1], nodeId, def.name);
    case "boolean": {
      const on = spec.defaultOn?.includes(def.name) ? value !== false : value === true;
      return bindDerived(on ? 1 : 0, [{ node: nodeId, param: def.name }]);
    }
    case "enum": {
      const options = def.options ?? [];
      const i = options.indexOf(String(value));
      const fallback = Math.max(0, options.indexOf(String(def.default)));
      const idx = i < 0 ? fallback : i;
      const v = spec.enumValues?.[def.name]?.[idx] ?? idx;
      return bindDerived(v, [{ node: nodeId, param: def.name }]);
    }
    default:
      return bindParam(num(value, num(def.default, 0)), nodeId, def.name);
  }
}

// A float_curve param as (x, y, monotone tangent, 0) per point plus a count —
// what engine/float-curve.ts sampleFloatCurve evaluates. Derived: a curve
// is one param, and an animated one samples.
function curvePoints(raw: unknown): CurvePoint[] {
  return Array.isArray(raw) ? (raw as CurvePoint[]) : [];
}

function curveBinds(raw: unknown, nodeId: string, param: string): Record<string, Bind<number | number[]>> {
  const pts = curvePoints(raw).slice(0, SKIA_SDF_CURVE_POINTS);
  const m = computeMonotoneTangents(pts);
  const packed = new Array<number>(SKIA_SDF_CURVE_POINTS * 4).fill(0);
  pts.forEach((pt, i) => packed.splice(i * 4, 3, pt.x, pt.y, m[i] ?? 0));
  const deps = [{ node: nodeId, param }];
  return { [param]: bindDerived(packed, deps), [`${param}_count`]: bindDerived(pts.length, deps) };
}

function defineSkiaSdfTerminal(spec: TerminalSpec): NodeDefinition {
  const params = mirrorParams(spec.mirror, spec.mirror.params.map((p) => p.name));
  const byName = new Map(params.map((p) => [p.name, p]));
  const stateKey = (nodeId: string) => `skia-sdf:${nodeId}`;
  const channels = spec.channels ?? [];

  const warnOnce = (ctx: RenderContext, nodeId: string, msgs: string[]) => {
    const state = (ctx.state[stateKey(nodeId)] ??= {}) as TerminalState;
    const msg = msgs.length ? msgs.join(" ") : null;
    if (msg && state.warned !== msg) console.warn(`[${spec.name} ${nodeId}] ${msg}`);
    state.warned = msg;
  };

  const build = (
    sdf: SocketValue | undefined,
    p: Record<string, unknown>,
    nodeId: string,
    ctx: RenderContext
  ): { expr: ShaderExpr; problems: string[] } => {
    const problems = spec.unsupported?.(p) ?? [];
    const transparent = () => constExpr(nodeId, [0, 0, 0, 0]);
    if (problems.length) return { expr: transparent(), problems };
    // Unwired: the mirror clears to transparent.
    if (!sdf || sdf.kind !== "sdf") return { expr: transparent(), problems: [] };
    const terminal: Record<string, Bind<number | number[]>> = {};
    for (const [param, type] of SKIA_SDF_TERMINAL_UNIFORMS[spec.mode]) {
      if (param === "channel") {
        terminal.channel = bindStatic(0);
        continue;
      }
      if (type === "curve") {
        Object.assign(terminal, curveBinds(p[param], nodeId, param));
        continue;
      }
      const def = byName.get(param);
      if (def) terminal[param] = terminalBind(def, p[param], nodeId, spec);
    }
    const r = compileSdfSksl((sdf as SdfValue).root, spec.mode, { resolution: [ctx.width, ctx.height], terminal });
    if (!r.program) return { expr: transparent(), problems: r.problems };
    return { expr: { k: "program", program: r.program, node: nodeId }, problems: [] };
  };

  const channelExpr = (expr: ShaderExpr, channel: number, nodeId: string): ShaderExpr => {
    if (expr.k !== "program") return expr;
    return {
      k: "program",
      node: `${nodeId}:${channel}`,
      program: { ...expr.program, uniforms: { ...expr.program.uniforms, t_channel: bindStatic(channel) } },
    };
  };

  const transparentImage = (ctx: RenderContext) => {
    const out = ctx.allocImage();
    ctx.clearTarget(out, [0, 0, 0, 0]);
    return out;
  };

  const preview = (ctx: RenderContext, expr: ShaderExpr, problems: string[]) => {
    const kit = canvasKit();
    if (!kit) {
      const err = canvasKitError();
      if (err) problems.push(err);
      else void ensureCanvasKit().catch(() => {});
      return transparentImage(ctx);
    }
    // A constant (the unwired / refused output) previews as a clear.
    if (expr.k !== "program") return transparentImage(ctx);
    const r = renderShaderPreview(ctx, kit, { k: "runtime", program: expr.program }, ctx.width, ctx.height);
    problems.push(...r.problems);
    return r.image ?? transparentImage(ctx);
  };

  const auxOutputs: OutputSocketDef[] = [
    {
      name: SKSL_PREVIEW_OUTPUT,
      label: "Preview",
      type: "image",
      description:
        "The generated runtime shader rendered by CanvasKit at the canvas size — the program React Native Skia runs. For viewing only; Skia layers consume the shader output.",
    },
    ...channels.map<OutputSocketDef>((c) => ({
      name: c.name,
      label: c.label,
      type: "skia_shader",
      description: `The ${c.label.toLowerCase()} layer as its own shader (same program, channel ${c.channel}).`,
    })),
  ];

  return {
    type: spec.type,
    name: spec.name,
    category: spec.mirror.category,
    description: spec.description,
    searchAliases: ["sdf", "skia", "sksl", "react native", spec.mirror.name.toLowerCase()],
    facts: spec.facts,
    backend: "webgl2",
    noMaskInput: true,
    gatesOutputs: true,
    skia: { class: "sksl", mirrors: spec.mirror.type },
    inputs: [{ name: "sdf", type: "sdf", required: true, label: "SDF" }],
    params,
    primaryOutput: "skia_shader",
    auxOutputs,
    // CanvasKit readiness, so the transparent preview rendered before the
    // WASM landed is not served from cache afterwards.
    fingerprintExtras() {
      return canvasKitReady() ? "ck1" : "ck0";
    },
    compute({ inputs, params: p, ctx, nodeId, consumedOutputs }) {
      const { expr, problems } = build(inputs.sdf, p, nodeId, ctx);
      const value = (e: ShaderExpr): SkiaShaderValue => ({
        kind: "skia_shader",
        expr: e,
        ...(problems.length ? { problems: [...problems] } : {}),
      });
      const wants = (h: string) => !consumedOutputs || consumedOutputs.has(h);
      const aux: Record<string, SocketValue> = {};
      for (const c of channels) if (wants(`aux:${c.name}`)) aux[c.name] = value(channelExpr(expr, c.channel, nodeId));
      // Data-only evaluations (the exporter, Node gates) have no GL.
      const canRender = typeof ctx.allocImage === "function";
      if (canRender && wants(`aux:${SKSL_PREVIEW_OUTPUT}`)) aux[SKSL_PREVIEW_OUTPUT] = preview(ctx, expr, problems);
      warnOnce(ctx, nodeId, problems);
      return { primary: value(expr), ...(Object.keys(aux).length ? { aux } : {}) };
    },
    dispose(ctx, nodeId) {
      delete ctx.state[stateKey(nodeId)];
    },
    validateParams(p) {
      return spec.unsupported?.(p) ?? [];
    },
  };
}

const TERMINAL_GOTCHA =
  "Outputs a Skia shader generated from the wired tree (values as uniforms, so animating any SDF param never recompiles); feed Skia Fill, or preview via the preview output.";
const REFUSED_GOTCHA =
  "SDF Displace, SDF From Image / Text's SDF, Material ramp mode and splines over 128 segments have no Skia lowering: the node emits transparent and names the reason.";

export const skiaSdfRasterizeNode = defineSkiaSdfTerminal({
  type: "skia-sdf-rasterize",
  name: "SDF Rasterize (Skia)",
  mirror: sdfRasterizeNode,
  mode: "rasterize",
  description:
    "Skia-layer SDF Rasterize: compiles the wired SDF tree (primitives, booleans, smooth ops, position ops, materials) into one SkSL runtime shader — the program React Native Skia runs. Same params as SDF Rasterize: foreground / background fill, contour, softness in pixels, aspect correction.",
  facts: {
    space: { "param:contour_width": "pixels", "param:softness": "pixels" },
    gotchas: [
      TERMINAL_GOTCHA,
      "softness and contour_width are pixels at render resolution (1 px = 1/max(width, height) in SDF space), exactly as SDF Rasterize; the AA is analytic, never derivative-based.",
      "Every SDF param binds to its own node + param, so keyframes on a radius or a wired Animated Value export as a timeline track.",
      REFUSED_GOTCHA,
    ],
  },
});

export const skiaSdfToMaskNode = defineSkiaSdfTerminal({
  type: "skia-sdf-to-mask",
  name: "SDF to Mask (Skia)",
  mirror: sdfToMaskNode,
  mode: "mask",
  description:
    "Skia-layer SDF to Mask: the wired SDF tree as a white-on-black SkSL shader at the chosen iso-level, feathered by Softness (px), optionally inverted. Same params as SDF to Mask.",
  facts: {
    space: { "param:threshold": "canvas01", "param:softness": "pixels" },
    gotchas: [
      TERMINAL_GOTCHA,
      "threshold is a canvas-UV distance (positive shrinks, negative grows); softness is pixels at render resolution.",
      "The output is opaque gray (m, m, m, 1), like SDF to Mask's image — use a blend mode, not alpha, to matte with it.",
      REFUSED_GOTCHA,
    ],
  },
});

export const skiaSdfToDistanceImageNode = defineSkiaSdfTerminal({
  type: "skia-sdf-to-distance-image",
  name: "SDF to Distance Image (Skia)",
  mirror: sdfToDistanceImageNode,
  mode: "distance",
  description:
    "Skia-layer SDF to Distance Image: the signed distance as an SkSL shader ramp — inside → Inside Color, the boundary → Zero Color, outside → Outside Color over ±Range. Same params as SDF to Distance Image.",
  facts: {
    space: { "param:range": "canvas01" },
    gotchas: [
      TERMINAL_GOTCHA,
      "range is a canvas-UV distance (same units as a shape's radius), not pixels.",
      REFUSED_GOTCHA,
    ],
  },
});

export const skiaSdfBevelNode = defineSkiaSdfTerminal({
  type: "skia-sdf-bevel",
  name: "SDF Bevel (Skia)",
  mirror: sdfBevelNode,
  mode: "bevel",
  description:
    "Skia-layer SDF Bevel: two-light bevel shading of the wired SDF tree as one SkSL shader (the distance is evaluated at the pixel and four neighbours for the normal). Same params as SDF Bevel.",
  // HIGHLIGHT_BLENDS screen / add / linear-dodge / normal → the shader's
  // 0 screen, 1 add, 2 normal (sdf-bevel.ts highlightBlendToInt).
  enumValues: { highlight_blend: [0, 1, 1, 2] },
  facts: {
    space: { "param:depth": "canvas01", "param:soften": "pixels" },
    gotchas: [
      TERMINAL_GOTCHA,
      "Light directions are computed in the shader from the angle / elevation degrees, so each angle exports as its own track.",
      "The tree is evaluated five times per pixel (centre + four taps); keep deep trees in mind on phones.",
      REFUSED_GOTCHA,
    ],
  },
});

export const skiaSdfShadeNode = defineSkiaSdfTerminal({
  type: "skia-sdf-shade",
  name: "SDF Shade (Skia)",
  mirror: sdfShadeNode,
  mode: "shade",
  description:
    "Skia-layer SDF Shade: fill, colour bleed, relief lighting, glow and contours of the wired SDF tree composited in one SkSL shader. Same params as SDF Shade; the normal / height / glow / bleed / mask layers are extra shader outputs.",
  defaultOn: ["bleed_inside", "aspect_correct"],
  unsupported: (p) =>
    p.height_mode === "curve" && curvePoints(p.height_curve).length > SKIA_SDF_CURVE_POINTS
      ? [`height_curve has ${curvePoints(p.height_curve).length} points; the Skia port takes up to ${SKIA_SDF_CURVE_POINTS}`]
      : [],
  channels: [
    { name: "normal", label: "Normal", channel: 1 },
    { name: "height", label: "Height", channel: 2 },
    { name: "glow", label: "Glow", channel: 3 },
    { name: "bleed", label: "Bleed", channel: 4 },
    { name: "mask", label: "Mask", channel: 5 },
  ],
  facts: {
    space: {
      "param:softness": "pixels",
      "param:soften": "pixels",
      "param:contour_width": "pixels",
      "param:depth": "canvas01",
      "param:glow_radius": "canvas01",
      "param:bleed_radius": "canvas01",
    },
    gotchas: [
      TERMINAL_GOTCHA,
      "height_mode=curve rebuilds SDF Shade's 8-bit curve LUT in-shader from up to 16 curve points; more points are refused.",
      "The aux layers are shaders (same SkSL, a different channel uniform), not images; height and mask are opaque gray.",
      REFUSED_GOTCHA,
    ],
  },
});

export const SKIA_SDF_TERMINALS: readonly NodeDefinition[] = [
  skiaSdfRasterizeNode,
  skiaSdfToMaskNode,
  skiaSdfToDistanceImageNode,
  skiaSdfBevelNode,
  skiaSdfShadeNode,
];
