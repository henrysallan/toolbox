// The procedural driver IR (specdocs/101326_skia-target.md §3.5e): what a
// driver subgraph — Expression, LFO, Math, Scene Time, Random, Constant,
// Animated Value — compiles to, and what both backends print:
//
//   emit-js.ts    a worklet function of the tick (worklet / native modes),
//                 bit-for-bit the engine's evaluation: the same JS Math, the
//                 same operations in the same order and association;
//   emit-sksl.ts  an SkSL function of the tick (baked mode), fp32 with
//                 emit-baked's polynomial transcendentals.
//
// Every value is a JS number. Booleans (comparisons, `!`) are numberized to
// 1 / 0 where JavaScript would convert them anyway — arithmetic, Math
// arguments, truthiness and the node's own toNum all read a boolean as its
// number — so the printed JS is plain `number` code; the one place the two
// differ (=== between a boolean and a number) is refused by the compiler.
//
// A program is a list of statements (each a value slot, or an RNG seeded
// for one Expression evaluation) and one scalar result. Slots are only ever
// read after they are written, by later statements.

import { evaluateTrack, type TimelineTrack } from "../runtime/toolbox-timeline";
import { EASINGS } from "@/engine/easing";

export type ArithOp = "+" | "-" | "*" | "/" | "%" | "**";
export type CmpOp = "<" | "<=" | ">" | ">=" | "==" | "!=";

export type PExpr =
  | { k: "lit"; v: number }
  | { k: "slot"; i: number }
  // The tick the program is evaluated at (its argument).
  | { k: "tick" }
  | { k: "bin"; op: ArithOp; a: PExpr; b: PExpr }
  // 1 when the comparison holds, else 0.
  | { k: "cmp"; op: CmpOp; a: PExpr; b: PExpr }
  | { k: "neg"; a: PExpr }
  // JS `!a`, numberized: a ? 0 : 1.
  | { k: "not"; a: PExpr }
  // JS `a && b` / `a || b` (value semantics: the operand, not a boolean).
  | { k: "and" | "or"; a: PExpr; b: PExpr }
  // JS `c ? a : b` (JS truthiness of c).
  | { k: "cond"; c: PExpr; a: PExpr; b: PExpr }
  | { k: "call"; fn: FnName; args: PExpr[] }
  // evaluateTrack(tracks[t], at) — a keyframed param, an Animated Value.
  | { k: "track"; t: number; at: PExpr }
  // The next mulberry32 draw of RNG r (advances its state).
  | { k: "rand"; r: number };

export type PStmt =
  | { k: "let"; e: PExpr; note?: string }
  // RNG r's state for one Expression evaluation: an int32 seed.
  | { k: "rng"; r: number; seed: PExpr };

// A custom easing curve (float_curve), sanitized at export: points and the
// monotone-cubic tangents, both exactly as engine/float-curve.ts computes
// them.
export interface ProcCurve {
  x: number[];
  y: number[];
  m: number[];
}

export interface ProcProgram {
  // Statements in order; statement i (a `let`) writes slot i.
  body: PStmt[];
  out: PExpr;
  tracks: TimelineTrack[];
  curves: ProcCurve[];
  // The engine nodes compiled (provenance, manifest), in first-use order.
  nodes: { id: string; type: string }[];
  // Seconds per tick and ticks per frame (the scoped clock the evaluator
  // hands every node: time = tick / (ticksPerFrame · fps), frame =
  // floor(tick / ticksPerFrame)).
  fps: number;
  ticksPerFrame: number;
}

// ---- functions --------------------------------------------------------------------------
//
// Everything a program may call. `js` is the exact engine implementation the
// interpreter runs (and the JS backend prints as a helper or a Math call);
// arity is fixed so the printed TypeScript type-checks.

export type FnName = string;

// Math functions with fixed arity (min / max / hypot are variadic).
export const MATH_FNS: Record<string, number> = {
  abs: 1,
  acos: 1,
  acosh: 1,
  asin: 1,
  asinh: 1,
  atan: 1,
  atan2: 2,
  atanh: 1,
  cbrt: 1,
  ceil: 1,
  cos: 1,
  cosh: 1,
  exp: 1,
  expm1: 1,
  floor: 1,
  fround: 1,
  log: 1,
  log10: 1,
  log1p: 1,
  log2: 1,
  pow: 2,
  round: 1,
  sign: 1,
  sin: 1,
  sinh: 1,
  sqrt: 1,
  tan: 1,
  tanh: 1,
  trunc: 1,
};
export const MATH_VARIADIC = new Set(["min", "max", "hypot"]);
export const MATH_CONSTS: Record<string, number> = {
  PI: Math.PI,
  E: Math.E,
  LN2: Math.LN2,
  LN10: Math.LN10,
  LOG2E: Math.LOG2E,
  LOG10E: Math.LOG10E,
  SQRT2: Math.SQRT2,
  SQRT1_2: Math.SQRT1_2,
};

// The Expression node's env helpers (expression.ts makeEnv), verbatim.
export const ENV_HELPERS: Record<string, { arity: number; js: (...a: number[]) => number; src: string }> = {
  mod: {
    arity: 2,
    js: (a, b) => (b === 0 ? 0 : a - Math.floor(a / b) * b),
    src: `function tbxMod(a: number, b: number): number {\n  "worklet";\n  return b === 0 ? 0 : a - Math.floor(a / b) * b;\n}`,
  },
  fract: {
    arity: 1,
    js: (x) => x - Math.floor(x),
    src: `function tbxFract(x: number): number {\n  "worklet";\n  return x - Math.floor(x);\n}`,
  },
  clamp: {
    arity: 3,
    js: (v, lo, hi) => Math.min(Math.max(v, lo), hi),
    src: `function tbxClamp(v: number, lo: number, hi: number): number {\n  "worklet";\n  return Math.min(Math.max(v, lo), hi);\n}`,
  },
  saturate: {
    arity: 1,
    js: (v) => Math.min(Math.max(v, 0), 1),
    src: `function tbxSaturate(v: number): number {\n  "worklet";\n  return Math.min(Math.max(v, 0), 1);\n}`,
  },
  lerp: {
    arity: 3,
    js: (a, b, k) => a + (b - a) * k,
    src: `function tbxLerp(a: number, b: number, k: number): number {\n  "worklet";\n  return a + (b - a) * k;\n}`,
  },
  mix: {
    arity: 3,
    js: (a, b, k) => a + (b - a) * k,
    src: `function tbxMix(a: number, b: number, k: number): number {\n  "worklet";\n  return a + (b - a) * k;\n}`,
  },
  step: {
    arity: 2,
    js: (edge, x) => (x < edge ? 0 : 1),
    src: `function tbxStep(edge: number, x: number): number {\n  "worklet";\n  return x < edge ? 0 : 1;\n}`,
  },
  smoothstep: {
    arity: 3,
    js: (e0, e1, x) => {
      const d = e1 - e0;
      const k = Math.min(Math.max(d === 0 ? 0 : (x - e0) / d, 0), 1);
      return k * k * (3 - 2 * k);
    },
    src: `function tbxSmoothstep(e0: number, e1: number, x: number): number {\n  "worklet";\n  const d = e1 - e0;\n  const k = Math.min(Math.max(d === 0 ? 0 : (x - e0) / d, 0), 1);\n  return k * k * (3 - 2 * k);\n}`,
  },
};
export const helperName = (env: string) => `tbx${env[0].toUpperCase()}${env.slice(1)}`;

// ---- node helpers (engine code, verbatim) ----------------------------------------------------

// expression.ts mulberry32, split at its state update: `a` is the state after
// `a = (a + 0x6d2b79f5) | 0`.
export function mulberryDraw(a: number): number {
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
export const MULBERRY_STEP = 0x6d2b79f5;

// expression.ts hashString (FNV-1a), for the node id — a constant at export.
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// random.ts hash01.
export function hash01(seed: number, frame: number, salt: number): number {
  let h = (seed | 0) ^ Math.imul(frame | 0, 0x27d4eb2d) ^ Math.imul(salt | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// expression.ts toNum (fallback 0).
export function toNum(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

// engine/float-curve.ts evalMonotoneCubic over a ProcCurve.
export function evalCurve(c: ProcCurve, x: number): number {
  const n = c.x.length;
  if (n === 0) return 0;
  if (n === 1) return c.y[0];
  if (x <= c.x[0]) return c.y[0];
  if (x >= c.x[n - 1]) return c.y[n - 1];
  let i = 0;
  for (; i < n - 1; i++) {
    if (x <= c.x[i + 1]) break;
  }
  const x0 = c.x[i];
  const x1 = c.x[i + 1];
  const h = x1 - x0;
  if (h === 0) return c.y[i];
  const t = (x - x0) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * c.y[i] + h10 * h * c.m[i] + h01 * c.y[i + 1] + h11 * h * c.m[i + 1];
}

// The interpreter's implementation of every FnName. "ease:<name>" is
// engine/easing.ts applyEasing (clamp, curve, intensity blend) for one
// named curve; "curve:<k>" the same through custom curve k; "seed32" the
// Expression RNG's per-frame seed; the rest are the Math functions, the
// env helpers, the node helpers and two engine idioms (toNum, the Constant
// node's toFixed(6) round trip, Number.isFinite).
export function fnImpl(fn: FnName, prog: Pick<ProcProgram, "curves">): (...a: number[]) => number {
  if (fn.startsWith("ease:")) {
    const name = fn.slice(5);
    const e = EASINGS[name] ?? EASINGS.linear;
    return (t, intensity) => {
      const tt = Math.max(0, Math.min(1, t));
      const eased = e(tt);
      return tt + intensity * (eased - tt);
    };
  }
  if (fn.startsWith("curve:")) {
    const c = prog.curves[Number(fn.slice(6))];
    return (t, intensity) => {
      const tt = Math.max(0, Math.min(1, t));
      const eased = evalCurve(c, tt);
      return tt + intensity * (eased - tt);
    };
  }
  if (fn in MATH_FNS || MATH_VARIADIC.has(fn)) return (Math as unknown as Record<string, (...a: number[]) => number>)[fn];
  if (fn in ENV_HELPERS) return ENV_HELPERS[fn].js;
  switch (fn) {
    case "toNum":
      return toNum;
    case "isFinite":
      return (v) => (Number.isFinite(v) ? 1 : 0);
    case "fixed6":
      return (v) => parseFloat(v.toFixed(6));
    case "seed32":
      return (h, frame) => h ^ ((frame >>> 0) + 0x9e3779b9);
    case "hash01":
      return hash01;
    case "frameOf":
      return (tick, tpf) => Math.floor(tick / tpf);
    case "lfoPhase":
      // lfo.ts: t = ctx.time = tick / (ticksPerFrame · fps); raw = t · f + phase.
      return (tick, tps, f, ph) => {
        const raw = (tick / tps) * f + ph;
        return ((raw % 1) + 1) % 1;
      };
  }
  throw new Error(`procedural: unknown function ${fn}`);
}

// ---- the interpreter ----------------------------------------------------------------------
//
// Evaluates a program at a tick with the same JS operations the printed
// worklet performs, in the same order — the planner checks a scene's expr
// binds against the sampled producer with it (no eval, no generated code).

export function evaluateProgram(prog: ProcProgram, tick: number): number {
  const slots: number[] = [];
  const rng: number[] = [];
  const fns = new Map<string, (...a: number[]) => number>();
  const fnOf = (fn: string) => {
    let f = fns.get(fn);
    if (!f) fns.set(fn, (f = fnImpl(fn, prog)));
    return f;
  };
  const ev = (e: PExpr): number => {
    switch (e.k) {
      case "lit":
        return e.v;
      case "slot":
        return slots[e.i];
      case "tick":
        return tick;
      case "bin": {
        const a = ev(e.a);
        const b = ev(e.b);
        switch (e.op) {
          case "+":
            return a + b;
          case "-":
            return a - b;
          case "*":
            return a * b;
          case "/":
            return a / b;
          case "%":
            return a % b;
          case "**":
            return a ** b;
        }
        break;
      }
      case "cmp": {
        const a = ev(e.a);
        const b = ev(e.b);
        switch (e.op) {
          case "<":
            return a < b ? 1 : 0;
          case "<=":
            return a <= b ? 1 : 0;
          case ">":
            return a > b ? 1 : 0;
          case ">=":
            return a >= b ? 1 : 0;
          case "==":
            return a == b ? 1 : 0;
          case "!=":
            return a != b ? 1 : 0;
        }
        break;
      }
      case "neg":
        return -ev(e.a);
      case "not":
        return ev(e.a) ? 0 : 1;
      case "and": {
        const a = ev(e.a);
        return a ? ev(e.b) : a;
      }
      case "or": {
        const a = ev(e.a);
        return a ? a : ev(e.b);
      }
      case "cond":
        return ev(e.c) ? ev(e.a) : ev(e.b);
      case "call": {
        const args = e.args.map(ev);
        return fnOf(e.fn)(...args);
      }
      case "track":
        return evaluateTrack(prog.tracks[e.t], ev(e.at)) as number;
      case "rand":
        rng[e.r] = (rng[e.r] + MULBERRY_STEP) | 0;
        return mulberryDraw(rng[e.r]);
    }
    throw new Error(`procedural: bad expression ${JSON.stringify(e)}`);
  };
  for (const s of prog.body) {
    if (s.k === "let") slots.push(ev(s.e));
    else {
      rng[s.r] = ev(s.seed);
      slots.push(0);
    }
  }
  return ev(prog.out);
}

// Every function a program calls, every track / curve it reads, whether it
// draws randoms — for the backends' helper lists and refusals.
export function programUses(prog: ProcProgram): { fns: Set<string>; random: boolean } {
  const fns = new Set<string>();
  let random = false;
  const visit = (e: PExpr): void => {
    switch (e.k) {
      case "bin":
      case "cmp":
      case "and":
      case "or":
        visit(e.a);
        visit(e.b);
        return;
      case "neg":
      case "not":
        visit(e.a);
        return;
      case "cond":
        visit(e.c);
        visit(e.a);
        visit(e.b);
        return;
      case "call":
        fns.add(e.fn);
        e.args.forEach(visit);
        return;
      case "track":
        visit(e.at);
        return;
      case "rand":
        random = true;
        return;
      default:
        return;
    }
  };
  for (const s of prog.body) {
    if (s.k === "let") visit(s.e);
    else {
      random = true;
      visit(s.seed);
    }
  }
  visit(prog.out);
  return { fns, random };
}
