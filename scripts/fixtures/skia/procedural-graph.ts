// Procedural-driver fixtures (specdocs/101326_skia-target.md §3.5e,
// check:skia-procedural, the harness's ?bundle=procedural slot).
//
//   proceduralAuroraGraph(sksl)   Aurora (aurora.sksl) with its params on
//                                 procedural drivers instead of keyframes:
//     drift_x   LFO lfo (sine, 0.5 Hz, ×0.6 + 0.75)
//     scale     Expression scale_expr `3.4 + 0.5 * sin(t * 1.7) + 0.35 * x`,
//               x ← LFO wob (triangle, 0.25 Hz)
//     contrast  Expression contrast_expr `0.85 + 0.6 * y`, y ← Scene Time st
//               (ping-pong over 150 frames, ease-in-out-sine)
//     c2        Color glow (keyframed, OKLab) — a track, beside them
//   PROCEDURAL_CASES              driver subgraphs the gate evaluates at every
//                                 frame through the real evaluator and the
//                                 exported worklets: every LFO shape and clock,
//                                 every Math op, every Scene Time mode × easing
//                                 (custom curve included), Random, Constant,
//                                 Animated Value on a wired clock, and a
//                                 battery of Expression sources.
//
// Pure (no fs): the Electron parity page bundles it.

import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import { EASING_OPTIONS } from "@/engine/easing";
import { syncChannelInputs } from "@/engine/expr-channels";
import type { EasingPreset, KeyframeAnimationBlock } from "@/engine/keyframes";
import type { ExprInput } from "@/engine/types";
import type { SkiaGraphFixture } from "../../skia/fixture";
import { AURORA_FRAMES, AURORA_MARKERS, AURORA_TIMELINE } from "./aurora-graph";

export const PROCEDURAL_TIMELINE = AURORA_TIMELINE;
export const PROCEDURAL_FRAMES = AURORA_FRAMES;
export const PROCEDURAL_MARKERS = AURORA_MARKERS;
const TPF = PROCEDURAL_TIMELINE.ticksPerFrame;

type K = [frame: number, value: number | string, easing: EasingPreset];
export const block = (keys: K[]): KeyframeAnimationBlock => ({
  animated: true,
  trackVisible: true,
  keyframes: keys.map(([f, value, easingOut]) => ({ tick: f * TPF, value, easingOut })),
});

const edge = (source: string, target: string, targetHandle: string): GraphEdge => ({
  id: `${source}->${target}:${targetHandle}`,
  source,
  sourceHandle: "out:primary",
  target,
  targetHandle,
});

// An Expression node with variables `vars` (name → id suffix).
export function expressionNode(id: string, expression: string, vars: string[] = ["x"], extra: Record<string, unknown> = {}): GraphNode {
  const inputs: ExprInput[] = vars.map((name) => ({ id: `ein-${id}-${name}`, name, default: 1 }));
  return { id, type: "expression", params: { inputs, expression, out_type: "scalar", ...extra } };
}
export const exprInput = (id: string, name: string) => `in:in:ein-${id}-${name}`;

export function proceduralAuroraGraph(sksl: string): { nodes: GraphNode[]; edges: GraphEdge[]; targetId: string } {
  const inputs: ExprInput[] = syncChannelInputs([], sksl);
  const chan = (name: string) => {
    const row = inputs.find((e) => e.name === name);
    if (!row) throw new Error(`aurora.sksl declares no channel "${name}"`);
    return `in:in:${row.id}`;
  };
  const nodes: GraphNode[] = [
    { id: "lfo", type: "lfo", params: { shape: "sine", clock_unit: "seconds", frequency: 0.5, phase: 0, amplitude: 0.6, offset: 0.75 } },
    { id: "wob", type: "lfo", params: { shape: "triangle", clock_unit: "seconds", frequency: 0.25, phase: 0.1, amplitude: 1, offset: 0 } },
    expressionNode("scale_expr", "3.4 + 0.5 * sin(t * 1.7) + 0.35 * x"),
    {
      id: "st",
      type: "scene-time",
      params: { unit: "seconds", mode: "pingpong", period_frames: 150, min: 0, max: 1, amplitude: 1, pingpong_easing: "ease-in-out-sine", ease_intensity: 1 },
    },
    expressionNode("contrast_expr", "0.85 + 0.6 * y", ["y"]),
    {
      id: "glow",
      type: "color-literal",
      params: { color: "#ff7a45", alpha: 1, count: 1 },
      animation: {
        color: block([
          [0, "#ff7a45", "easeInOutQuad"],
          [150, "#ff3d8b", "easeInOutQuad"],
          [300, "#ff7a45", "linear"],
        ]),
      },
    },
    { id: "aurora", type: "sksl-shader", params: { inputs, expression: sksl, on_error: "transparent" } },
  ];
  const edges: GraphEdge[] = [
    edge("wob", "scale_expr", exprInput("scale_expr", "x")),
    edge("st", "contrast_expr", exprInput("contrast_expr", "y")),
    edge("lfo", "aurora", chan("drift_x")),
    edge("scale_expr", "aurora", chan("scale")),
    edge("contrast_expr", "aurora", chan("contrast")),
    edge("glow", "aurora", chan("c2")),
  ];
  return { nodes, edges, targetId: "aurora" };
}

// ---- driver cases ------------------------------------------------------------------------

export interface ProceduralCase {
  name: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  // The driver whose primary output is the value (scalar unless `component`).
  out: string;
  // Read one component of a vector driver (vec2..4 → the bind's component).
  component?: number;
  // The case draws integer-hashed randoms (Random / random()): no baked form.
  random?: boolean;
  // A discontinuous value (square wave, step easing, comparisons, floor…):
  // the baked fp32 copy may land on the other side of a jump at a frame
  // where the double sits on it — the gate reports those frames.
  jumps?: boolean;
  // The baked backend refuses this case, with a reason matching this.
  bakeRefusal?: RegExp;
}

const MATH_OPS = [
  "Add", "Subtract", "Multiply", "Divide", "Multiply Add", "Power", "Logarithm", "Square Root", "Inverse Square Root", "Absolute", "Exponent",
  "Minimum", "Maximum", "Less Than", "Greater Than", "Sign", "Compare", "Smooth Minimum", "Smooth Maximum",
  "Round", "Floor", "Ceiling", "Truncate", "Fraction", "Truncated Modulo", "Floored Modulo", "Wrap", "Snap", "Ping-Pong",
  "Sine", "Cosine", "Tangent", "Arcsine", "Arccosine", "Arctangent", "Arctan2", "Hyperbolic Sine", "Hyperbolic Cosine", "Hyperbolic Tangent",
  "To Radians", "To Degrees",
];
const MATH_JUMPS = new Set(["Less Than", "Greater Than", "Sign", "Compare", "Round", "Floor", "Ceiling", "Truncate", "Fraction", "Truncated Modulo", "Floored Modulo", "Wrap", "Snap", "Divide", "Logarithm"]);

// Expression sources the gate compiles (each with x ← LFO, y ← Scene Time).
export const EXPRESSION_SOURCES: { src: string; random?: boolean; jumps?: boolean; out?: string; component?: number }[] = [
  { src: "x" },
  { src: "sin(t * 1.7) * 0.5 + x * 0.25" },
  { src: "x ** 2 - y ** 3 + 2 ** -x" },
  { src: "(-x) ** 2 + (x * 3) % 1.25 - (x * -3.5) % 0.75", jumps: true },
  { src: "x > 0 ? x * 2 : -x / 3", jumps: true },
  { src: "(x > 0.25) + (y < 0.5) * 2 - !(x > 0)", jumps: true },
  { src: "x > 0 && y || 0.25", jumps: true },
  { src: "(x <= y) == (y >= 0.5) ? 1 : 0", jumps: true },
  { src: "x === y ? 2 : x !== 0.5 ? 1 : 0", jumps: true },
  { src: "true + false * 2 + (x > 0) * 0.5", jumps: true },
  { src: "clamp(x * 3, -1, 1) + saturate(y * 2) + lerp(1, 2, y) + mix(x, y, 0.3)" },
  { src: "smoothstep(-0.5, 0.5, x) + smoothstep(0.2, 0.2, y) + step(0.3, y)", jumps: true },
  { src: "mod(t, 0.7) + fract(x * 2.5) + mod(x, 0)", jumps: true },
  { src: "sqrt(abs(x)) + cbrt(x) + exp(y) + log(1 + y) + log2(2 + x) + pow(abs(x), 1.5)" },
  { src: "tan(x) + asin(x * 0.9) + acos(y) + atan(x * 4) + atan2(x, y - 0.5)" },
  { src: "Math.sinh(x) + Math.cosh(y) + Math.tanh(x * 3) + Math.asinh(x) + Math.acosh(1 + y) + Math.atanh(x * 0.5)" },
  { src: "Math.log10(1 + y) + Math.log1p(y) + Math.expm1(x) + Math.hypot(x, y, 1) + Math.fround(x)" },
  { src: "min(x, y) + max(x, y, 0.2) + floor(x * 4) + ceil(y * 3) + round(x * 5) + trunc(x * 2.5) + sign(x)", jumps: true },
  { src: "PI * x + TAU * y + E + Math.PI + Math.SQRT2 + Math.LN2 + fps / 60 + u" },
  { src: "frame / 300 + time - t" },
  { src: "return x * 2 + 1;" },
  { src: "return (x + y)" },
  { src: "1 / (x - x)" },
  { src: "Math.sqrt(-1 - y) + x" },
  { src: "random()", random: true, jumps: true },
  { src: "x > 0 ? random() : random() + random() * 2", random: true, jumps: true },
  { src: "random() * 0.5 + random() + (x > 0 && random())", random: true, jumps: true },
  { src: "[x * 2, y + random()]", random: true, jumps: true, out: "vec2", component: 1 },
  { src: "[x * 2, y]", out: "vec2", component: 0 },
  { src: "[x, y, x + y]", out: "vec3", component: 2 },
  { src: "x + y", out: "vec4", component: 3 },
  { src: "[x, y]", out: "vec4", component: 3 },
  { src: "[x, y]", out: "scalar" },
  { src: "" },
];

export function proceduralCases(): ProceduralCase[] {
  const cases: ProceduralCase[] = [];
  // Shared sources: an LFO and a Scene Time (a continuous ping-pong, so a
  // jump in a case is the case's own) to feed the operands.
  const src = (): GraphNode[] => [
    { id: "src_lfo", type: "lfo", params: { shape: "sine", frequency: 0.37, phase: 0.13, amplitude: 1.3, offset: 0.05 } },
    { id: "src_st", type: "scene-time", params: { unit: "seconds", mode: "pingpong", period_frames: 194, min: 0, max: 1, amplitude: 1, pingpong_easing: "linear" } },
  ];

  // LFO: every shape, on the playhead, a wired clock in frames / seconds,
  // keyframed + wired params.
  for (const shape of ["sine", "triangle", "sawtooth", "square"]) {
    cases.push({
      name: `LFO ${shape}`,
      nodes: [{ id: "l", type: "lfo", params: { shape, frequency: 1.5, phase: 0.2, amplitude: 0.8, offset: 0.1 } }],
      edges: [],
      out: "l",
      jumps: shape === "square" || shape === "sawtooth",
    });
  }
  cases.push({
    name: "LFO sine, non-integer period, negative phase",
    nodes: [{ id: "l", type: "lfo", params: { shape: "sine", frequency: 0.7, phase: -0.35, amplitude: 1, offset: 0 } }],
    edges: [],
    out: "l",
  });
  cases.push({
    name: "LFO on a wired clock (Scene Time frames, clock_unit frames)",
    nodes: [
      { id: "clk", type: "scene-time", params: { unit: "frames", mode: "linear", scale: 0.5, offset: 3 } },
      { id: "l", type: "lfo", params: { shape: "sine", clock_unit: "frames", frequency: 1, phase: 0, amplitude: 1, offset: 0 } },
    ],
    edges: [edge("clk", "l", "in:clock")],
    out: "l",
  });
  cases.push({
    name: "LFO on a wired clock (Expression seconds) with wired frequency + keyframed amplitude",
    nodes: [
      expressionNode("clk", "t * 0.8 + 0.1"),
      { id: "f", type: "constant", params: { value: 2, mode: "float", step: 0.001 }, animation: { value: block([[0, 0.5, "linear"], [300, 3, "easeInOutCubic"]]) } },
      {
        id: "l",
        type: "lfo",
        params: { shape: "triangle", clock_unit: "seconds", frequency: 1, phase: 0, amplitude: 1, offset: 0 },
        animation: { amplitude: block([[0, 0.2, "easeOutBack"], [150, 1, "linear"], [300, 0.4, "linear"]]) },
      },
    ],
    edges: [edge("clk", "l", "in:clock"), edge("f", "l", "in:frequency")],
    out: "l",
    jumps: true,
  });
  cases.push({
    name: "LFO with an exposed, wired phase param and a keyframed offset",
    nodes: [
      ...src(),
      {
        id: "l",
        type: "lfo",
        params: { shape: "sine", frequency: 0.5, phase: 0, amplitude: 1, offset: 0 },
        exposedParams: ["phase"],
        animation: { offset: block([[0, 0, "spring"], [120, 1, "linear"]]) },
      },
    ],
    edges: [edge("src_st", "l", "in:param:phase")],
    out: "l",
  });

  // Math: every op on three moving operands — a an LFO crossing 0, b a
  // ping-pong in [1.2, 2.4] (away from the 0 / 1 poles of Divide and
  // Logarithm), c an Animated Value ramp.
  for (const op of MATH_OPS) {
    cases.push({
      name: `Math ${op}`,
      nodes: [
        ...src(),
        { id: "bb", type: "scene-time", params: { unit: "seconds", mode: "pingpong", period_frames: 230, min: 1.2, max: 2.4, amplitude: 1, pingpong_easing: "ease-in-out-quad" } },
        { id: "k", type: "animated-value", params: { value: 0.35, unit: "frames" }, animation: { value: block([[0, -0.6, "linear"], [300, 0.9, "linear"]]) } },
        { id: "m", type: "math", params: { mode: "scalar", operation: op, a: 0, b: 0, c: 0.25, clamp: false } },
      ],
      edges: [edge("src_lfo", "m", "in:a"), edge("bb", "m", "in:b"), edge("k", "m", "in:c")],
      out: "m",
      jumps: MATH_JUMPS.has(op) || op === "Ping-Pong",
    });
  }
  cases.push({
    name: "Math Multiply Add, clamp, params (B unwired, keyframed)",
    nodes: [
      ...src(),
      { id: "m", type: "math", params: { mode: "scalar", operation: "Multiply Add", a: 0, b: 2, c: 0.5, clamp: true }, animation: { b: block([[0, 0.5, "easeInOutSine"], [300, 3, "linear"]]) } },
    ],
    edges: [edge("src_lfo", "m", "in:a")],
    out: "m",
    jumps: true,
  });
  cases.push({
    name: "Math Sine reading param B wired into a hidden socket (1-input op ignores it)",
    nodes: [...src(), { id: "m", type: "math", params: { mode: "scalar", operation: "Sine", a: 0.5, b: 9 } }],
    edges: [edge("src_lfo", "m", "in:b")],
    out: "m",
  });

  // Scene Time: modes × units, every easing name on ping-pong / sawtooth /
  // stepped, a custom curve, keyframed intensity.
  for (const [unit, mode] of [["seconds", "linear"], ["frames", "linear"]] as const) {
    cases.push({ name: `Scene Time ${mode} (${unit})`, nodes: [{ id: "s", type: "scene-time", params: { unit, mode, scale: 0.7, offset: -0.2 } }], edges: [], out: "s" });
  }
  const easings = [...EASING_OPTIONS, "custom", "no-such-easing"];
  easings.forEach((easing, i) => {
    const mode = i % 3 === 0 ? "pingpong" : i % 3 === 1 ? "sawtooth" : "stepped";
    const params: Record<string, unknown> = {
      unit: i % 2 ? "frames" : "seconds",
      mode,
      period_frames: 70 + i,
      min: -0.5,
      max: 1.5,
      amplitude: 0.9,
      pingpong_easing: easing,
      easing,
      step_size: 0.4,
      step_seconds: 0.45,
      step_frames: 17,
      ease_intensity: 1 + (i % 4) * 0.25,
      offset: 0.1,
      easing_curve: [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 0.3, y: 0.6 },
        { id: "c", x: 0.31, y: 0.62 },
        { id: "d", x: 0.7, y: 0.2 },
        { id: "e", x: 1, y: 1 },
      ],
    };
    // (Penner's expo / elastic in-shapes jump at 0 — inExpo(0⁺) = 2⁻¹⁰ — so a
    // ramp landing a hair off its end in fp32 reads the other side.)
    cases.push({ name: `Scene Time ${mode} / ${easing}`, nodes: [{ id: "s", type: "scene-time", params }], edges: [], out: "s", jumps: mode !== "pingpong" || easing === "step" || /expo|elastic/.test(easing) });
  });
  cases.push({
    name: "Scene Time stepped, keyframed intensity + step size",
    nodes: [
      {
        id: "s",
        type: "scene-time",
        params: { unit: "seconds", mode: "stepped", step_seconds: 0.6, step_size: 1, easing: "ease-in-out-back", ease_intensity: 1, offset: 0 },
        animation: { ease_intensity: block([[0, 0, "linear"], [300, 2, "linear"]]), step_size: block([[0, 0.5, "hold"], [150, 2, "linear"]]) },
      },
    ],
    edges: [],
    out: "s",
    jumps: true,
  });

  // Random (seeded): uniform / gauss, scalar / vec2 component, keyframed lo / hi.
  for (const [dist, shape, comp] of [["uniform", "scalar", undefined], ["gauss", "scalar", undefined], ["uniform", "vec2", 1], ["gauss", "vec2", 1]] as const) {
    cases.push({
      name: `Random ${dist} ${shape}${comp !== undefined ? `[${comp}]` : ""}`,
      nodes: [
        {
          id: "r",
          type: "random",
          params: { mode: "seeded", shape, distribution: dist, seed: 1234, lo: -1, hi: 2 },
          animation: { hi: block([[0, 1, "linear"], [300, 5, "easeOutCubic"]]) },
        },
      ],
      edges: [],
      out: "r",
      ...(comp !== undefined ? { component: comp } : {}),
      random: true,
      jumps: true,
    });
  }

  // Constant: keyframed float with a step, integer mode, wired.
  cases.push({
    name: "Constant keyframed, step 0.25",
    nodes: [{ id: "c", type: "constant", params: { value: 1, mode: "float", step: 0.25 }, animation: { value: block([[0, -3, "easeInOutQuad"], [300, 7.3, "linear"]]) } }],
    edges: [],
    out: "c",
    jumps: true,
  });
  cases.push({
    name: "Constant integer mode, wired from an LFO",
    nodes: [...src(), { id: "c", type: "constant", params: { value: 1, mode: "integer", step: 2 }, exposedParams: ["value"] }],
    edges: [edge("src_lfo", "c", "in:param:value")],
    out: "c",
    jumps: true,
  });
  cases.push({
    name: "Constant float, fine step (the toFixed(6) round trip)",
    nodes: [{ id: "c", type: "constant", params: { value: 1, mode: "float", step: 0.001 }, animation: { value: block([[0, 0.12345, "linear"], [300, 0.6789, "linear"]]) } }],
    edges: [],
    out: "c",
    jumps: true,
  });

  // Animated Value on a wired clock: ping-pong frames (a time warp), an
  // Expression in seconds, a non-finite clock (falls back to the playhead).
  const avKeys = block([[0, 0, "easeOutElastic"], [60, 1, "cubicBezier"], [150, -0.5, "spring"], [240, 0.8, "hold"], [270, 0.2, "linear"]]);
  avKeys.keyframes[1].bezier = { x1: 0.3, y1: -0.4, x2: 0.6, y2: 1.4 };
  cases.push({
    name: "Animated Value on a ping-pong clock (frames)",
    nodes: [
      { id: "clk", type: "scene-time", params: { unit: "frames", mode: "pingpong", period_frames: 200, min: 0, max: 280, amplitude: 1, pingpong_easing: "ease-in-out-quad" } },
      { id: "av", type: "animated-value", params: { value: 0, unit: "frames" }, animation: { value: avKeys } },
    ],
    edges: [edge("clk", "av", "in:time")],
    out: "av",
    jumps: true,
  });
  cases.push({
    name: "Animated Value on an Expression clock (seconds)",
    nodes: [expressionNode("clk", "4.5 - t * 0.9"), { id: "av", type: "animated-value", params: { value: 0, unit: "seconds" }, animation: { value: avKeys } }],
    edges: [edge("clk", "av", "in:time")],
    out: "av",
    jumps: true,
  });
  cases.push({
    name: "Animated Value on a clock that goes non-finite (falls back to the playhead)",
    nodes: [expressionNode("clk", "frame < 100 ? 1 / 0 : frame"), { id: "av", type: "animated-value", params: { value: 0, unit: "frames" }, animation: { value: avKeys } }],
    edges: [edge("clk", "av", "in:time")],
    out: "av",
    jumps: true,
    // 1 / 0 folds to an Infinity literal, which SkSL can't spell.
    bakeRefusal: /non-finite constant/,
  });

  // Expression battery (x ← an LFO, y ← a sawtooth Scene Time).
  EXPRESSION_SOURCES.forEach((e, i) => {
    const id = `e${i}`;
    cases.push({
      name: `Expression \`${e.src}\`${e.out ? ` (${e.out}${e.component !== undefined ? `[${e.component}]` : ""})` : ""}`,
      nodes: [...src(), expressionNode(id, e.src, ["x", "y"], e.out ? { out_type: e.out } : {})],
      edges: [edge("src_lfo", id, exprInput(id, "x")), edge("src_st", id, exprInput(id, "y"))],
      out: id,
      ...(e.component !== undefined ? { component: e.component } : {}),
      ...(e.random ? { random: true } : {}),
      ...(e.jumps ? { jumps: true } : {}),
    });
  });
  cases.push({
    name: "Expression with an unwired variable (its default) and a chain of Expressions",
    nodes: [
      { id: "a", type: "expression", params: { inputs: [{ id: "ein-a-x", name: "x", default: 0.4 }, { id: "ein-a-k", name: "k", default: 2.5 }], expression: "x * k + sin(t)", out_type: "scalar" } },
      expressionNode("b", "x * x - 0.5"),
    ],
    edges: [edge("a", "b", exprInput("b", "x"))],
    out: "b",
  });
  return cases;
}

// compare:skia: Aurora (SkSL) on procedural drivers vs the native Noise →
// Color Ramp on the same drivers would need the native chain rewired; the
// parity slot covers the export, so this fixture just renders the node.
export const fixture: SkiaGraphFixture = {
  description: "Aurora (SkSL Shader) on procedural drivers: LFO, Expression ← LFO, Expression ← Scene Time, a Color track",
  timeline: PROCEDURAL_TIMELINE,
  frames: PROCEDURAL_FRAMES,
  size: 512,
  build: ({ text }) => {
    const g = proceduralAuroraGraph(text("aurora.sksl"));
    return { nodes: g.nodes, edges: g.edges };
  },
};
