// The expression compiler's corpus (M4 lane 1, src/lib/ae-export/scene/
// expressions/): driver graphs for every rung-3 node and mode, each in its
// own toolbox layer and wired into one consumer — a scalar prop (a
// rectangle's rotation), a spatial pair (a circle's centre), a color, a
// Transform's TRS, an effect param through its linear map, an opacity
// product, a Gradient Ramp point — on the plain clock, an offset layer and
// a precomp; plus the cases that must stay sampled.
//
// Shared by scripts/ae-export/check-expressions.mts (offline: every
// expression in a node:vm AE shim against the sampled keys),
// fixtures.mts's p-expressions (a subset, snapshotted) and
// expressions-roundtrip.mts (After Effects' own valueAtTime for all of it).
// Each consumer is named after its case: a compiled expression's header
// ("// <case> · <property> ← …", line 2) says which case it belongs to.

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Edge } from "@xyflow/react";
import type { GraphBuilder } from "./fixtures.mts";

export const W = 1280;
export const H = 720;
export const FPS = 30;
export const FRAMES = 60;

// ---- the AE shim -------------------------------------------------------------------------------

// What a property expression sees in AE's JavaScript engine, enough for the
// compiled text (which reads only `time`, `seedRandom` and `random`) and
// the AE idioms a hand edit would reach for.
export function aeShim(time: number, fps: number) {
  let seed = 0;
  let timeless = false;
  let n = 0;
  const rand = () => {
    // Deterministic in (seed, time, draw): AE's own generator is not
    // replayable offline; what matters is that the text calls it.
    let h = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(timeless ? 0 : Math.round(time * fps * 1000), 0x85ebca6b) ^ Math.imul(++n, 0xc2b2ae35)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const lin = (t: number, t0: number, t1: number, v0: number, v1: number) => (t <= t0 ? v0 : t >= t1 ? v1 : v0 + ((t - t0) / (t1 - t0)) * (v1 - v0));
  const vec = (f: (a: number, b: number) => number) => (a: any, b: any) => (Array.isArray(a) ? a.map((x: number, i: number) => f(x, Array.isArray(b) ? b[i] : b)) : f(a, b));
  return {
    time,
    thisComp: { frameDuration: 1 / fps, width: W, height: H, duration: FRAMES / fps },
    thisLayer: { inPoint: 0, outPoint: FRAMES / fps },
    seedRandom: (s: number, tl = false) => {
      seed = s;
      timeless = tl;
      n = 0;
    },
    random: (a?: number, b?: number) => (a === undefined ? rand() : b === undefined ? rand() * a : a + rand() * (b - a)),
    linear: lin,
    ease: lin,
    add: vec((a, b) => a + b),
    sub: vec((a, b) => a - b),
    mul: vec((a, b) => a * b),
    div: vec((a, b) => a / b),
    length: (a: number[], b?: number[]) => Math.hypot(...a.map((x, i) => x - (b?.[i] ?? 0))),
    clamp: (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi),
  };
}

// ---- the corpus ---------------------------------------------------------------------------------

export interface Case {
  id: string;
  // Builds the driver in layer L; returns the endpoint wired into the
  // consumer (or wires it itself and returns null).
  build: (g: Graph, L: string, id: string) => string | null;
  consumer?: "rot" | "pos" | "color" | "trs" | "blur" | "alpha" | "ramp" | "none";
  // "exact" (default) · "random" (frame-mode Random: in range, varying) ·
  // a RegExp: refused — stays sampled, the report naming this reason.
  expect?: "exact" | "random" | RegExp;
  layer?: { clips?: unknown[] };
  // Inclusive range a "random" expression must stay in.
  range?: [number, number];
}

type Graph = GraphBuilder;

// An edge GraphBuilder.wire can't spell (an Expression variable's socket is
// `in:in:<id>`).
export function rawEdge(g: Graph, source: string, sourceHandle: string, target: string, targetHandle: string): void {
  g.edges.push({ id: `r${g.edges.length + 1}-${target}`, source, sourceHandle, target, targetHandle } as Edge);
}

const track = (keys: [number, number][]) => ({ animated: true, trackVisible: true, keyframes: keys.map(([f, v]) => ({ tick: f * 1000, value: v, easingOut: "linear" })) });

export const ramp = (g: Graph, L: string, id: string, scale = 0.125, offset = -3) => g.node(L, id, "scene-time", { unit: "frames", mode: "linear", scale, offset });
export const constant = (g: Graph, L: string, id: string, value: number) => g.node(L, id, "constant", { value, step: 0.001 });

const MATH_OPS = [
  "Add", "Subtract", "Multiply", "Divide", "Multiply Add", "Power", "Logarithm", "Square Root", "Inverse Square Root", "Absolute", "Exponent",
  "Minimum", "Maximum", "Less Than", "Greater Than", "Sign", "Compare", "Smooth Minimum", "Smooth Maximum",
  "Round", "Floor", "Ceiling", "Truncate", "Fraction", "Truncated Modulo", "Floored Modulo", "Wrap", "Snap", "Ping-Pong",
  "Sine", "Cosine", "Tangent", "Arcsine", "Arccosine", "Arctangent", "Arctan2", "Hyperbolic Sine", "Hyperbolic Cosine", "Hyperbolic Tangent",
  "To Radians", "To Degrees",
];
const EASINGS = ["linear", "step", "smoothstep", "smootherstep", "ease-in-out", "ease-out-cubic", "ease-in-quart", "ease-in-out-quint", "ease-in-sine", "ease-out-expo", "ease-in-circ", "ease-in-out-back", "ease-in-elastic", "ease-out-bounce", "custom"];
const CURVE = [
  { id: "c0", x: 0, y: 0.1 },
  { id: "c1", x: 0.3, y: 0.8 },
  { id: "c2", x: 0.3, y: 0.6 },
  { id: "c3", x: 0.7, y: 0.6 },
  { id: "c4", x: 1, y: 1 },
];
const EXPR_SOURCES: [string, string, string?][] = [
  ["sin", "sin(t * 2) * x + y"],
  ["return", "return clamp(x, 0.2, 0.8) * 3;"],
  ["mod", "mod(frame, 7) / 7 + fract(x)"],
  ["smooth", "smoothstep(0, 1, fract(t)) + step(0.5, fract(time)) + saturate(x)"],
  ["random", "random() * 0.5 + random() + x"],
  ["ternary", "x > 0.5 ? 1 : y < 0 ? -1 : 0"],
  ["pow", "pow(abs(x), 1.5) + hypot(x, y) + Math.max(x, y) + t ** 2"],
  ["lerp", "lerp(x, y, 0.25) + mix(x, y, 0.75) + atan2(y, x) + cbrt(x) + log2(1 + abs(x))"],
  ["consts", "trunc(x) + sign(y) + PI + TAU + E + fps + u + exp(-abs(x)) + Math.floor(x * 3) / 3"],
  ["logic", "(x > 0 && y > 0) || !(x < -1) ? round(x * 10) / 10 : ceil(y)"],
  ["vec2", "[cos(t), sin(t) + x]", "vec2"],
  ["vec4", "[saturate(x), 0.5, saturate(y), 1]", "vec4"],
];

export function cases(): Case[] {
  const out: Case[] = [];
  // --- constant, inside a moving graph --------------------------------------------------------
  for (const [m, extra] of [["float", { step: 0.25 }], ["integer", {}]] as const)
    out.push({
      id: `constant-${m}`,
      build(g, L, id) {
        g.node(L, `${id}-k`, "constant", { value: 1.37, mode: m, ...extra });
        ramp(g, L, `${id}-r`);
        g.node(L, id, "math", { operation: "Multiply" });
        g.wire(`${id}-k:out`, `${id}:in:a`);
        g.wire(`${id}-r:out`, `${id}:in:b`);
        return `${id}:out`;
      },
    });
  // --- math: every operation, with and without clamp; A and B ramps crossing 0 ---------------
  MATH_OPS.forEach((op, i) =>
    out.push({
      id: `math-${op.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      build(g, L, id) {
        // Power's base stays positive (a negative base to a fractional power
        // is NaN, which no scene value may hold).
        if (op === "Power") ramp(g, L, `${id}-a`, 0.05, 0.1);
        else ramp(g, L, `${id}-a`, 0.125, -3);
        ramp(g, L, `${id}-b`, op === "Power" ? 0.05 : 0.25, op === "Power" ? -1.5 : -7.5);
        g.node(L, id, "math", { operation: op, c: 0.5, clamp: i % 2 === 1 });
        g.wire(`${id}-a:out`, `${id}:in:a`);
        g.wire(`${id}-b:out`, `${id}:in:b`);
        return `${id}:out`;
      },
    })
  );
  out.push({
    id: "math-params-wired-c",
    build(g, L, id) {
      ramp(g, L, `${id}-a`, 0.1, 0.2);
      g.node(L, `${id}-c`, "lfo", { frequency: 0.7, amplitude: 0.3, offset: 0.4 });
      g.node(L, id, "math", { operation: "Wrap", b: -0.5 });
      g.wire(`${id}-a:out`, `${id}:in:a`);
      g.wire(`${id}-c:out`, `${id}:in:c`);
      return `${id}:out`;
    },
  });
  // --- clamp / lerp / remap / compare / logic ---------------------------------------------------
  for (const [name, lo, hi] of [["clamp", 0.25, 1.5], ["clamp-swapped", 1.5, -0.25]] as const)
    out.push({
      id: name,
      build(g, L, id) {
        ramp(g, L, `${id}-v`, 0.05, -1);
        g.node(L, id, "clamp", { lo, hi });
        g.wire(`${id}-v:out`, `${id}:in:value`);
        return `${id}:out`;
      },
    });
  out.push({
    id: "clamp-wired-hi",
    build(g, L, id) {
      ramp(g, L, `${id}-v`, 0.05, -1);
      g.node(L, `${id}-h`, "lfo", { shape: "triangle", frequency: 0.5, amplitude: 0.5, offset: 0.5 });
      g.node(L, id, "clamp", { lo: 0 });
      g.wire(`${id}-v:out`, `${id}:in:value`);
      g.wire(`${id}-h:out`, `${id}:in:hi`);
      return `${id}:out`;
    },
  });
  for (const clamp of [false, true])
    out.push({
      id: `lerp-scalar${clamp ? "-clamped" : ""}`,
      build(g, L, id) {
        ramp(g, L, `${id}-t`, 0.04, -0.5);
        g.node(L, `${id}-b`, "lfo", { frequency: 0.3, amplitude: 2 });
        g.node(L, id, "lerp", { type: "scalar", a_value: -1, clamp });
        g.wire(`${id}-t:out`, `${id}:in:t`);
        g.wire(`${id}-b:out`, `${id}:in:b`);
        return `${id}:out`;
      },
    });
  out.push({
    id: "lerp-vec2",
    build(g, L, id) {
      ramp(g, L, `${id}-x`, 0.01, 0.2);
      g.node(L, `${id}-y`, "lfo", { frequency: 0.4, amplitude: 0.2, offset: 0.5 });
      g.node(L, `${id}-a`, "combine-vec2", { y: 0.3 });
      g.node(L, `${id}-b`, "random", { shape: "vec2", seed: 7, lo: 0.2, hi: 0.8 });
      g.node(L, `${id}-t`, "lfo", { frequency: 0.25, amplitude: 0.5, offset: 0.5 });
      g.node(L, id, "lerp", { type: "vec2" });
      g.wire(`${id}-x:out`, `${id}-a:in:x`);
      g.wire(`${id}-y:out`, `${id}-a:in:y`);
      g.wire(`${id}-a:out`, `${id}:in:a`);
      g.wire(`${id}-b:out`, `${id}:in:b`);
      g.wire(`${id}-t:out`, `${id}:in:t`);
      return `${id}:out`;
    },
    consumer: "pos",
  });
  for (const [name, p] of [
    ["remap", { in_min: -1, in_max: 2, out_min: 10, out_max: -30 }],
    ["remap-clamped", { in_min: -1, in_max: 2, out_min: 0, out_max: 90, clamp: true }],
    ["remap-inverted", { in_min: 2, in_max: -1, out_min: 0, out_max: 1 }],
  ] as const)
    out.push({
      id: name,
      build(g, L, id) {
        ramp(g, L, `${id}-v`, 0.1, -2);
        g.node(L, id, "remap", p);
        g.wire(`${id}-v:out`, `${id}:in:input`);
        return `${id}:out`;
      },
    });
  for (const op of [">", "<", ">=", "<=", "==", "!="])
    out.push({
      id: `compare-${{ ">": "gt", "<": "lt", ">=": "ge", "<=": "le", "==": "eq", "!=": "ne" }[op]}`,
      build(g, L, id) {
        ramp(g, L, `${id}-a`, 0.125, -3);
        g.node(L, id, "compare", { op, b: 0.5, epsilon: 0.2 });
        g.wire(`${id}-a:out`, `${id}:in:a`);
        return `${id}:out`;
      },
    });
  for (const op of ["and", "or", "xor", "not"])
    out.push({
      id: `logic-${op}`,
      build(g, L, id) {
        g.node(L, `${id}-a`, "lfo", { shape: "square", frequency: 0.5 });
        g.node(L, `${id}-b`, "lfo", { shape: "square", frequency: 1.25, phase: 0.1 });
        g.node(L, `${id}-ga`, "compare", { op: ">", b: 0 });
        g.node(L, id, "logic", { op });
        g.wire(`${id}-a:out`, `${id}-ga:in:a`);
        g.wire(`${id}-ga:out`, `${id}:in:a`);
        g.wire(`${id}-b:out`, `${id}:in:b`);
        return `${id}:out`;
      },
    });
  // --- switch ---------------------------------------------------------------------------------------
  for (const [name, index] of [["switch-0", 0], ["switch-1", 1], ["switch-clamped", 9], ["switch-round", 0.6]] as const)
    out.push({
      id: name,
      build(g, L, id) {
        ramp(g, L, `${id}-a`, 0.1, 0);
        g.node(L, `${id}-b`, "lfo", { frequency: 2, amplitude: 3 });
        g.node(L, id, "switch", { index, slots: ["in0", "in1"] });
        g.wire(`${id}-a:out`, `${id}:in:in0`);
        g.wire(`${id}-b:out`, `${id}:in:in1`);
        return `${id}:out`;
      },
    });
  out.push({
    id: "switch-vec2-auto",
    build(g, L, id) {
      g.node(L, `${id}-a`, "random", { shape: "vec2", seed: 3, lo: 0.1, hi: 0.9 });
      ramp(g, L, `${id}-s`, 0.01, 0.2);
      g.node(L, id, "switch", { index: 1, slots: ["in0", "in1", "in2"] });
      g.wire(`${id}-s:out`, `${id}:in:in0`);
      g.wire(`${id}-a:out`, `${id}:in:in1`);
      return `${id}:out`;
    },
    consumer: "pos",
  });
  out.push({
    id: "switch-empty-slot",
    build(g, L, id) {
      ramp(g, L, `${id}-a`);
      g.node(L, id, "switch", { index: 1, slots: ["in0", "in1"] });
      g.wire(`${id}-a:out`, `${id}:in:in0`);
      return `${id}:out`;
    },
    expect: /empty/,
  });
  out.push({
    id: "switch-wired-index",
    build(g, L, id) {
      ramp(g, L, `${id}-a`);
      g.node(L, `${id}-i`, "lfo", { shape: "square", amplitude: 0.5, offset: 0.5 });
      g.node(L, id, "switch", { slots: ["in0", "in1"] });
      g.wire(`${id}-a:out`, `${id}:in:in0`);
      g.wire(`${id}-a:out`, `${id}:in:in1`);
      g.wire(`${id}-i:out`, `${id}:in:index`);
      return `${id}:out`;
    },
    expect: /wired index/,
  });
  // --- float curve ------------------------------------------------------------------------------------
  out.push({
    id: "float-curve",
    build(g, L, id) {
      ramp(g, L, `${id}-x`, 1 / 40, -0.2);
      g.node(L, id, "float-curve", { curve: CURVE });
      g.wire(`${id}-x:out`, `${id}:in:value`);
      return `${id}:out`;
    },
  });
  out.push({
    id: "float-curve-default",
    build(g, L, id) {
      g.node(L, `${id}-x`, "lfo", { frequency: 0.5, amplitude: 0.6, offset: 0.5 });
      g.node(L, id, "float-curve", {});
      g.wire(`${id}-x:out`, `${id}:in:value`);
      return `${id}:out`;
    },
  });
  // --- LFO -----------------------------------------------------------------------------------------------
  for (const shape of ["sine", "triangle", "sawtooth", "square"])
    out.push({
      id: `lfo-${shape}`,
      build(g, L, id) {
        g.node(L, id, "lfo", { shape, frequency: 0.7, phase: -0.3, amplitude: 20, offset: 5 });
        return `${id}:out`;
      },
    });
  for (const unit of ["seconds", "frames"])
    out.push({
      id: `lfo-clock-${unit}`,
      build(g, L, id) {
        ramp(g, L, `${id}-c`, unit === "frames" ? 2 : 0.05, 0.3);
        g.node(L, `${id}-f`, "lfo", { frequency: 0.1, amplitude: 0.5, offset: 1 });
        g.node(L, id, "lfo", { shape: "sine", clock_unit: unit, frequency: 1.5, amplitude: 10 });
        g.wire(`${id}-c:out`, `${id}:in:clock`);
        g.wire(`${id}-f:out`, `${id}:in:frequency`);
        return `${id}:out`;
      },
    });
  // --- Scene Time: unit × mode, easings ------------------------------------------------------------
  for (const unit of ["seconds", "frames"])
    for (const mode of ["linear", "pingpong", "sawtooth", "stepped"])
      out.push({
        id: `scene-time-${unit}-${mode}`,
        build(g, L, id) {
          g.node(L, id, "scene-time", { unit, mode, scale: 2.5, offset: -1, period_frames: 23, min: -2, max: 3, amplitude: 0.8, step_size: 1.5, step_seconds: 0.4, step_frames: 7, pingpong_easing: "ease-in-out-cubic", easing: "smoothstep" });
          return `${id}:out`;
        },
      });
  EASINGS.forEach((easing, i) =>
    out.push({
      id: `scene-time-ease-${easing}`,
      build(g, L, id) {
        g.node(L, id, "scene-time", { mode: i % 2 ? "stepped" : "pingpong", unit: "frames", step_frames: 9, period_frames: 17, easing, pingpong_easing: easing, ease_intensity: i % 3 === 0 ? 1 : i % 3 === 1 ? 0.5 : 1.5, easing_curve: CURVE, max: 10 });
        return `${id}:out`;
      },
    })
  );
  // --- Random ----------------------------------------------------------------------------------------
  for (const dist of ["uniform", "gauss"])
    out.push({
      id: `random-seeded-${dist}`,
      build(g, L, id) {
        g.node(L, id, "random", { mode: "seeded", distribution: dist, seed: 1234, lo: -20, hi: 40 });
        return `${id}:out`;
      },
    });
  out.push({
    id: "random-seeded-vec2",
    build(g, L, id) {
      g.node(L, id, "random", { shape: "vec2", mode: "seeded", distribution: "gauss", seed: 99, lo: 0.3, hi: 0.7 });
      return `${id}:out`;
    },
    consumer: "pos",
  });
  out.push({
    id: "random-frame-uniform",
    build(g, L, id) {
      g.node(L, id, "random", { mode: "frame", lo: -10, hi: 30 });
      return `${id}:out`;
    },
    expect: "random",
    range: [-10, 30],
  });
  out.push({
    id: "random-frame-gauss",
    build(g, L, id) {
      g.node(L, id, "random", { mode: "frame", distribution: "gauss", lo: 0, hi: 60 });
      return `${id}:out`;
    },
    expect: "random",
    range: [-1000, 1000],
  });
  // --- split / combine -------------------------------------------------------------------------------
  out.push({
    id: "split-combine",
    build(g, L, id) {
      g.node(L, `${id}-x`, "lfo", { frequency: 0.2, amplitude: 0.3, offset: 0.5 });
      ramp(g, L, `${id}-y`, 0.005, 0.4);
      g.node(L, `${id}-c`, "combine-vec2", {});
      g.node(L, `${id}-s`, "split-vec2", {});
      g.node(L, id, "combine-vec2", {});
      g.wire(`${id}-x:out`, `${id}-c:in:x`);
      g.wire(`${id}-y:out`, `${id}-c:in:y`);
      g.wire(`${id}-c:out`, `${id}-s:in:in`);
      g.wire(`${id}-s:aux:y`, `${id}:in:x`);
      g.wire(`${id}-s:out`, `${id}:in:y`);
      return `${id}:out`;
    },
    consumer: "pos",
  });
  // --- the Expression node -----------------------------------------------------------------------------
  for (const [name, src, outType] of EXPR_SOURCES)
    out.push({
      id: `expr-${name}`,
      build(g, L, id) {
        ramp(g, L, `${id}-x`, 0.05, -1);
        g.node(L, `${id}-y`, "lfo", { frequency: 0.3, amplitude: 1.5 });
        g.node(L, id, "expression", { expression: src, out_type: outType ?? "scalar", inputs: [{ id: "ein-x0", name: "x", default: 1 }, { id: "ein-y0", name: "y", default: 1 }] });
        rawEdge(g, `${id}-x`, "out:primary", id, "in:in:ein-x0");
        rawEdge(g, `${id}-y`, "out:primary", id, "in:in:ein-y0");
        return `${id}:out`;
      },
      consumer: outType === "vec2" ? "pos" : outType === "vec4" ? "color" : "rot",
    });
  for (const [name, src, why] of [
    ["expr-math-random", "Math.random() + x", /Math\.random/],
    ["expr-unknown", "foo(x) + t", /unknown function/],
    ["expr-string", '"a" + x', /strings/],
  ] as const)
    out.push({
      id: name,
      build(g, L, id) {
        ramp(g, L, `${id}-x`);
        g.node(L, id, "expression", { expression: src, inputs: [{ id: "ein-x0", name: "x", default: 1 }] });
        rawEdge(g, `${id}-x`, "out:primary", id, "in:in:ein-x0");
        return `${id}:out`;
      },
      expect: why,
    });
  // --- what stays sampled ---------------------------------------------------------------------------------
  out.push({
    id: "smooth",
    build(g, L, id) {
      g.node(L, `${id}-x`, "lfo", { shape: "square", frequency: 0.5 });
      g.node(L, id, "smooth", {});
      g.wire(`${id}-x:out`, `${id}:in:value`);
      return `${id}:out`;
    },
    expect: /smooth/,
  });
  out.push({
    id: "keyed-in-closure",
    build(g, L, id) {
      g.node(L, id, "lfo", { amplitude: 10 }, { frequency: track([[0, 0.5], [40, 2]]) });
      return `${id}:out`;
    },
    expect: /keyframed inside the driver graph/,
  });
  // --- consumers ----------------------------------------------------------------------------------------------
  out.push({ id: "consumer-trs", consumer: "trs", build: (g, L, id) => (g.node(L, id, "lfo", { frequency: 0.4, amplitude: 0.1 }), `${id}:out`) });
  out.push({ id: "consumer-blur", consumer: "blur", build: (g, L, id) => (g.node(L, id, "lfo", { shape: "triangle", frequency: 0.5, amplitude: 4, offset: 6 }), `${id}:out`) });
  out.push({ id: "consumer-alpha", consumer: "alpha", build: (g, L, id) => (g.node(L, id, "lfo", { frequency: 0.5, amplitude: 0.4, offset: 0.5 }), `${id}:out`) });
  out.push({ id: "consumer-ramp", consumer: "ramp", build: (g, L, id) => (g.node(L, id, "lfo", { frequency: 0.25, amplitude: 0.2, offset: 0.5 }), `${id}:out`) });
  // --- clocks -------------------------------------------------------------------------------------------------
  out.push({
    id: "clock-offset-layer",
    layer: { clips: [{ inTick: 10_000, outTick: 50_000, sourceInTick: 0, enabled: true }] },
    build: (g, L, id) => (g.node(L, id, "scene-time", { unit: "frames", scale: 3 }), `${id}:out`),
  });
  out.push({
    id: "clock-precomp",
    layer: {
      clips: [
        { inTick: 0, outTick: 20_000, sourceInTick: 0, enabled: true },
        { inTick: 30_000, outTick: 55_000, sourceInTick: 5_000, enabled: true },
      ],
    },
    build: (g, L, id) => (g.node(L, id, "lfo", { shape: "sawtooth", frequency: 1.1, amplitude: 45 }), `${id}:out`),
  });
  return out;
}

// The consumer of a case's driver, in its own layer.
export function addConsumer(g: Graph, L: string, id: string, kind: NonNullable<Case["consumer"]>, ep: string): void {
  const sq = (extra: Record<string, unknown> = {}, data: Record<string, unknown> = {}) =>
    g.node(L, `${id}--q`, "rectangle", { originX: 0.5, originY: 0.5, width: 0.1, height: 0.1, stroke_enabled: false, fill_enabled: true, fill_color: "#ff8800", ...extra }, undefined, data);
  if (kind === "rot") {
    sq({}, { exposedParams: ["rotate"], name: id });
    g.wire(ep, `${id}--q:param:rotate`);
    g.out(L, `${id}--q:aux:image`);
  } else if (kind === "pos") {
    g.node(L, `${id}--q`, "circle", { radiusX: 0.03, radiusY: 0.03, stroke_enabled: false, fill_enabled: true, fill_color: "#00ff88" }, undefined, { exposedParams: ["centerX", "centerY"], name: id });
    g.node(L, `${id}--s`, "split-vec2", {});
    g.wire(ep, `${id}--s:in:in`);
    g.wire(`${id}--s:out`, `${id}--q:param:centerX`);
    g.wire(`${id}--s:aux:y`, `${id}--q:param:centerY`);
    g.out(L, `${id}--q:aux:image`);
  } else if (kind === "color") {
    sq({}, { exposedParams: ["fill_color"], name: id });
    g.wire(ep, `${id}--q:param:fill_color`);
    g.out(L, `${id}--q:aux:image`);
  } else if (kind === "trs") {
    sq();
    g.node(L, `${id}--t`, "transform", { space: "global", pivotX: 0.4, scaleX: 1.5 }, undefined, { exposedParams: ["rotate", "translateX"], name: id });
    g.node(L, `${id}--m`, "math", { operation: "Multiply", b: 900 });
    g.wire(`${id}--q:out`, `${id}--t:in:image`);
    g.wire(ep, `${id}--t:param:translateX`);
    g.wire(ep, `${id}--m:in:a`);
    g.wire(`${id}--m:out`, `${id}--t:param:rotate`);
    g.node(L, `${id}--f`, "spline-fill", { color: "#3366ff" });
    g.wire(`${id}--t:out`, `${id}--f:in:path`);
    g.out(L, `${id}--f:out`);
  } else if (kind === "blur") {
    g.node(L, `${id}--g`, "gradient", { mode: "linear", color_a: "#000000", color_b: "#ffffff" });
    g.node(L, `${id}--b`, "blur", { radius: 4 }, undefined, { exposedParams: ["radius"], name: id });
    g.wire(`${id}--g:out`, `${id}--b:in:image`);
    g.wire(ep, `${id}--b:param:radius`);
    g.out(L, `${id}--b:out`);
  } else if (kind === "alpha") {
    g.node(L, `${id}--s`, "solid-color", { color: "#22aa44" }, undefined, { exposedParams: ["alpha"], name: id });
    g.wire(ep, `${id}--s:param:alpha`);
    g.out(L, `${id}--s:out`);
  } else if (kind === "ramp") {
    g.node(L, `${id}--g`, "gradient", { mode: "radial", center_y: 0.5, radius: 0.4, color_a: "#000000", color_b: "#ffffff" }, undefined, { exposedParams: ["center_x"], name: id });
    g.wire(ep, `${id}--g:param:center_x`);
    g.out(L, `${id}--g:out`);
  }
}

// Every prop with a compiled expression, with its path, comp fps and layer window.
export interface Found {
  path: (string | number)[];
  prop: any;
  fps: number;
  frames: [number, number];
  layer: string;
}
export function expressionProps(scene: any, mark: string): Found[] {
  const out: Found[] = [];
  scene.comps.forEach((comp: any, ci: number) =>
    comp.layers.forEach((L: any, li: number) => {
      const frames: [number, number] = [Math.round(L.inPoint * comp.fps), Math.round(L.outPoint * comp.fps) - 1];
      const visit = (x: any, path: (string | number)[]) => {
        if (!x || typeof x !== "object") return;
        if (typeof x.expression === "string" && x.expression.startsWith(mark)) out.push({ path, prop: x, fps: comp.fps, frames, layer: L.name });
        for (const [k, v] of Object.entries(x)) visit(v, [...path, Array.isArray(x) ? Number(k) : k]);
      };
      visit(L, ["comps", ci, "layers", li]);
    })
  );
  return out;
}
export const get = (o: any, path: (string | number)[]) => path.reduce((x, k) => (x == null ? x : x[k]), o);

// The sampled prop's value at comp frame f (keys at frame times, or static).
export function sampledAt(p: any, f: number, fps: number): number[] | undefined {
  if (!p) return undefined;
  const arr = (v: any) => (Array.isArray(v) ? v : [v]);
  if ("v" in p) return arr(p.v);
  const k = p.keys.find((k: any) => Math.abs(k.t - f / fps) < 1e-9);
  return k ? arr(k.v) : undefined;
}

export const same = (a: number, b: number) => a === b || (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));


// Every case's layer + driver + consumer into `g` (only the named cases,
// when given).
export function buildCorpus(g: Graph, only?: readonly string[]): Case[] {
  const picked = cases().filter((k) => !only || only.includes(k.id));
  for (const k of picked) {
    const L = g.layer(`L-${k.id}`, k.id, (k.layer ?? {}) as Parameters<GraphBuilder["layer"]>[2]);
    const ep = k.build(g, L, k.id);
    if (ep) addConsumer(g, L, k.id, k.consumer ?? "rot", ep);
  }
  return picked;
}

// The case a compiled expression belongs to (its header's second line).
export function caseOf(expression: string): string {
  return /^\/\/ (.*?) · /.exec(expression.split("\n")[1] ?? "")?.[1] ?? "?";
}

// The p-expressions fixture: one case per node type and consumer kind, both
// clocks, Random in both modes.
export const P_EXPRESSION_CASES = [
  "constant-integer",
  "math-floored-modulo",
  "math-smooth-minimum",
  "clamp-swapped",
  "lerp-vec2",
  "remap-inverted",
  "logic-xor",
  "switch-vec2-auto",
  "float-curve",
  "lfo-clock-frames",
  "lfo-square",
  "scene-time-ease-custom",
  "scene-time-seconds-stepped",
  "random-seeded-gauss",
  "random-frame-uniform",
  "split-combine",
  "expr-random",
  "expr-vec4",
  "consumer-trs",
  "consumer-blur",
  "consumer-alpha",
  "consumer-ramp",
  "clock-offset-layer",
  "clock-precomp",
] as const;
