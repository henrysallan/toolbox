import type {
  ExprInput,
  InputSocketDef,
  NodeDefinition,
  RenderContext,
  SocketType,
  SocketValue,
} from "@/engine/types";

// The Expression node lets you type a JavaScript math expression instead of
// wiring up a chain of Math/Compare/Lerp nodes. Each input socket is bound
// to a named variable (default `x`, then `y`, `z`, …); the `+` on the node
// header adds more. The expression is compiled once (cached on its source +
// the ordered variable names) and evaluated once per frame on the CPU.
//
// V1 is scalar: inputs evaluate as numbers (image/mask/audio coerce to a
// scalar via the engine's universal coercions), and the output is a scalar
// or a vec selected by `out_type`. Per-pixel image expressions (JS→GLSL)
// are a separate follow-up — see specdocs/062926_expression-node.md.

// ---------------------------------------------------------------------------
// Input-variable helpers (also imported by the editor's `+`-button handler).
// ---------------------------------------------------------------------------

export function newExprInputId(): string {
  return `ein-${Math.random().toString(36).slice(2, 8)}`;
}

// Variable-name auto-fill order. After these we fall back to in1, in2, …
const NAME_ORDER = ["x", "y", "z", "w", "a", "b", "c", "d", "e", "f"];

export function nextExprVarName(existing: string[]): string {
  for (const n of NAME_ORDER) if (!existing.includes(n)) return n;
  let i = 1;
  while (existing.includes(`in${i}`)) i++;
  return `in${i}`;
}

// Mint a fresh input entry whose name doesn't collide with the existing set.
export function newExprInput(existing: ExprInput[]): ExprInput {
  return {
    id: newExprInputId(),
    name: nextExprVarName(existing.map((e) => e.name)),
    default: 1,
  };
}

const DEFAULT_INPUTS: ExprInput[] = [{ id: "ein-x0", name: "x", default: 1 }];

// ---------------------------------------------------------------------------
// Expression evaluation.
// ---------------------------------------------------------------------------

// Time-dependent if the source mentions any of these globals — drives both
// the `stable`/fingerprint behavior (recompute per frame) and the per-frame
// PRNG reseed. Word-boundary so it doesn't trip on `width`, `format`, etc.
const TIME_RE = /\b(t|time|frame|random)\b/;

// A valid JS identifier (so it can be a Function parameter name). Reserved
// words are rejected at compile time via the thrown SyntaxError.
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

interface Compiled {
  source: string;
  varsKey: string;
  fn: ((...args: unknown[]) => unknown) | null;
  error: string | null;
}

interface ExprState {
  compiled?: Compiled;
  error: string | null;
  lastWarned?: string | null;
}

function getState(ctx: RenderContext, nodeId: string): ExprState {
  const key = `expression:${nodeId}`;
  let s = ctx.state[key] as ExprState | undefined;
  if (!s) {
    s = { error: null };
    ctx.state[key] = s;
  }
  return s;
}

// Surface compile/runtime errors to the console once per distinct message —
// the node outputs 0 on error, which is otherwise silent. (Inline panel
// display is a planned follow-up; see the spec.)
function warnOnce(state: ExprState, nodeId: string): void {
  if (state.error && state.error !== state.lastWarned) {
    console.warn(`[Expression ${nodeId}] ${state.error}`);
  }
  state.lastWarned = state.error;
}

// Deterministic PRNG (mulberry32) so `random()` is cache-safe: same node +
// same frame → same sequence. Animated noise comes from mixing the frame in.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// The whitelisted globals exposed to every expression, rebuilt each eval so
// the time values are current. `random` is reseeded per frame so a static
// expression using it caches as a constant while an animated one varies.
function makeEnv(ctx: RenderContext, nodeId: string): Record<string, unknown> {
  const M = Math;
  const rng = mulberry32(hashString(nodeId) ^ ((ctx.frame >>> 0) + 0x9e3779b9));
  return {
    t: ctx.time,
    time: ctx.time,
    frame: ctx.frame,
    fps: ctx.fps,
    PI: M.PI,
    TAU: M.PI * 2,
    E: M.E,
    sin: M.sin,
    cos: M.cos,
    tan: M.tan,
    asin: M.asin,
    acos: M.acos,
    atan: M.atan,
    atan2: M.atan2,
    abs: M.abs,
    sign: M.sign,
    sqrt: M.sqrt,
    cbrt: M.cbrt,
    pow: M.pow,
    exp: M.exp,
    log: M.log,
    log2: M.log2,
    min: M.min,
    max: M.max,
    floor: M.floor,
    ceil: M.ceil,
    round: M.round,
    trunc: M.trunc,
    hypot: M.hypot,
    mod: (a: number, b: number) => (b === 0 ? 0 : a - Math.floor(a / b) * b),
    fract: (x: number) => x - Math.floor(x),
    clamp: (v: number, lo: number, hi: number) =>
      Math.min(Math.max(v, lo), hi),
    saturate: (v: number) => Math.min(Math.max(v, 0), 1),
    lerp: (a: number, b: number, k: number) => a + (b - a) * k,
    mix: (a: number, b: number, k: number) => a + (b - a) * k,
    step: (edge: number, x: number) => (x < edge ? 0 : 1),
    smoothstep: (e0: number, e1: number, x: number) => {
      const d = e1 - e0;
      const k = Math.min(Math.max(d === 0 ? 0 : (x - e0) / d, 0), 1);
      return k * k * (3 - 2 * k);
    },
    random: () => rng(),
  };
}

// Compile the source into a function of (…vars, __env). Accepts either a
// bare expression (`a + b`) or a statement block with an explicit `return`.
function compile(source: string, varNames: string[]): Compiled {
  const varsKey = varNames.join(",");
  // Reject bad variable names up front so the error names the culprit
  // instead of surfacing as an opaque `new Function` SyntaxError.
  for (const n of varNames) {
    if (!IDENT_RE.test(n)) {
      return {
        source,
        varsKey,
        fn: null,
        error: `Invalid variable name: "${n}"`,
      };
    }
  }
  const seen = new Set<string>();
  for (const n of varNames) {
    if (seen.has(n)) {
      return { source, varsKey, fn: null, error: `Duplicate variable: "${n}"` };
    }
    seen.add(n);
  }
  const trimmed = source.trim();
  if (!trimmed) {
    return { source, varsKey, fn: null, error: null }; // empty → outputs 0
  }
  const hasReturn = /\breturn\b/.test(trimmed);
  const body = hasReturn ? trimmed : `return (${trimmed});`;
  try {
    // env globals are destructured from the trailing __env arg so the
    // expression sees `sin`, `t`, etc. without polluting a real scope.
    const fn = new Function(
      ...varNames,
      "__env",
      `"use strict";const{${ENV_KEYS}}=__env;${body}`
    ) as (...args: unknown[]) => unknown;
    return { source, varsKey, fn, error: null };
  } catch (e) {
    return {
      source,
      varsKey,
      fn: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// Destructure list for the env — derived once from a sample env so it can't
// drift from makeEnv.
const ENV_KEYS = Object.keys(
  makeEnv(
    { time: 0, frame: 0, fps: 60 } as RenderContext,
    "sample"
  )
).join(",");

function toNum(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

type VecType = "vec2" | "vec3" | "vec4";
type OutType = "scalar" | VecType;
const VEC_LEN: Record<VecType, number> = { vec2: 2, vec3: 3, vec4: 4 };

// Build a properly-typed vec SocketValue from a components array (assumed to
// already hold at least VEC_LEN[kind] finite numbers).
function makeVec(kind: VecType, c: number[]): SocketValue {
  switch (kind) {
    case "vec2":
      return { kind, value: [c[0], c[1]] };
    case "vec3":
      return { kind, value: [c[0], c[1], c[2]] };
    default:
      return { kind: "vec4", value: [c[0], c[1], c[2], c[3]] };
  }
}

export const expressionNode: NodeDefinition = {
  type: "expression",
  name: "Expression",
  category: "utility",
  description:
    "Type a JavaScript math expression instead of wiring a chain of Math " +
    "nodes. Each input socket is a named variable (x, y, z…); the + adds " +
    "more. Outputs a scalar or vector. Globals: t, frame, PI, TAU, sin, " +
    "cos, clamp, lerp, smoothstep, random, and the rest of Math.",
  backend: "webgl2",
  // Pure CPU eval with no GL work. fingerprintExtras folds in ctx.time only
  // when the source is time-dependent, so static expressions cache as
  // constants and animated ones recompute each frame.
  stable: true,
  // Scalar/vector node — the universal mask input would be meaningless.
  noMaskInput: true,
  inputs: [{ name: "in:ein-x0", label: "x", type: "scalar", required: false }],
  resolveInputs(params) {
    const entries = (params.inputs as ExprInput[]) ?? DEFAULT_INPUTS;
    // Every socket is declared `scalar`: the engine's universal coercions
    // already let scalar / image / mask / audio sources connect (image and
    // audio collapse to a representative scalar). Vec inputs are a planned
    // follow-up (they need a vec→scalar connection rule).
    return entries.map<InputSocketDef>((e) => ({
      name: `in:${e.id}`,
      label: e.name,
      type: "scalar",
      required: false,
    }));
  },
  params: [
    {
      name: "inputs",
      label: "Inputs",
      type: "expr_inputs",
      default: DEFAULT_INPUTS,
    },
    {
      name: "expression",
      label: "Expression",
      type: "string",
      multiline: true,
      default: "x",
    },
    {
      name: "out_type",
      label: "Output",
      type: "enum",
      options: ["scalar", "vec2", "vec3", "vec4"],
      default: "scalar",
    },
  ],
  primaryOutput: "scalar",
  resolvePrimaryOutput(params) {
    return (params.out_type as SocketType) ?? "scalar";
  },
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const entries = (params.inputs as ExprInput[]) ?? DEFAULT_INPUTS;
    const source = (params.expression as string) ?? "";
    const outType = ((params.out_type as OutType) ?? "scalar") as OutType;
    const varNames = entries.map((e) => e.name);

    const state = getState(ctx, nodeId);
    // Recompile only when the source string or the ordered variable names
    // change.
    const varsKey = varNames.join(",");
    if (
      !state.compiled ||
      state.compiled.source !== source ||
      state.compiled.varsKey !== varsKey
    ) {
      state.compiled = compile(source, varNames);
      state.error = state.compiled.error;
      warnOnce(state, nodeId);
    }

    const zero = (): SocketValue => {
      if (outType === "scalar") return { kind: "scalar", value: 0 };
      const len = VEC_LEN[outType];
      const v = new Array(len).fill(0);
      return { kind: outType, value: v as never };
    };

    const fn = state.compiled.fn;
    if (!fn) {
      // Compile error (or empty expression) → output zero. Error text is
      // parked on state for the panel to surface.
      return { primary: zero() };
    }

    // Bind each variable: connected scalar value, else the per-socket
    // default (which itself defaults to 1).
    const args: unknown[] = entries.map((e) => {
      const sock = inputs[`in:${e.id}`];
      if (sock && sock.kind === "scalar") return sock.value;
      return e.default ?? 1;
    });
    args.push(makeEnv(ctx, nodeId));

    let raw: unknown;
    try {
      raw = fn(...args);
      state.error = null;
      state.lastWarned = null;
    } catch (e) {
      state.error = e instanceof Error ? e.message : String(e);
      warnOnce(state, nodeId);
      return { primary: zero() };
    }

    if (outType === "scalar") {
      const v = Array.isArray(raw) ? toNum(raw[0]) : toNum(raw);
      return { primary: { kind: "scalar", value: v } };
    }

    const len = VEC_LEN[outType];
    let comps: number[];
    if (Array.isArray(raw)) {
      comps = Array.from({ length: len }, (_, i) => toNum(raw[i]));
    } else {
      // A single number broadcasts to every component (matches the engine's
      // scalar→vec coercion).
      const s = toNum(raw);
      comps = new Array(len).fill(s);
    }
    return { primary: { kind: outType, value: comps as never } };
  },

  fingerprintExtras(params, ctx) {
    const src = (params.expression as string) ?? "";
    // Time-dependent expressions must bust the cache every frame; static
    // ones return "" and cache as a constant.
    return TIME_RE.test(src) ? `t:${ctx.time}` : "";
  },

  dispose(ctx, nodeId) {
    delete ctx.state[`expression:${nodeId}`];
  },
};
