// Driver subgraph → procedural program (ir.ts), for the React Native Skia
// export (specdocs/101326_skia-target.md §3.5e).
//
// Given the node wired into an exported value, compile everything upstream
// of it — Expression (the JS subset parse.ts accepts), LFO, Math (scalar
// mode), Scene Time, Random (seeded), Constant, Animated Value (keyframes,
// also on a wired clock) — into one program of the tick that reproduces the
// evaluator: each node's compute transcribed operation for operation, its
// params resolved wire > keyframes > constant exactly as evaluateGraph does
// (exposed-param wires through socketToParamRaw, keyframes as timeline
// tracks at the node's keyframe tick), wired inputs through coerceValue.
//
// Clocks. Every node reads the scoped clock the evaluator hands it: tick,
// time = tick / (ticksPerFrame · fps), frame = floor(tick / ticksPerFrame).
// The export plays the target on its own (layer-local) clock from 0, and a
// driver rides that same clock — exactly as a track does (the scene sampler
// evaluates the whole upstream closure on it). Retimed clocks inside the
// subgraph are honoured where the evaluator retimes: an Animated Value's
// wired `time` samples its keyframes at round(clock · ticks), an LFO's wired
// `clock` replaces its playhead. Clip windows on a driver (gates) refuse.
//
// Caching rules that change values, reproduced:
//   - Random (seeded) caches per frame: the value is computed once per
//     frame, from its params AT that frame — so the program evaluates its
//     params at the frame's tick, frame · ticksPerFrame, whatever the tick
//     inside the frame (the editor's first evaluation of a frame during
//     export / stepping is that tick);
//   - Expression's random() is mulberry32 seeded hash(nodeId) ^ (frame + φ)
//     per evaluation, drawn in JS evaluation order (the program threads the
//     RNG state through the expression, so a draw in an untaken ?: branch
//     doesn't advance it);
//   - Expression's source-text time gating (TIME_RE) only decides whether
//     the cache is consulted — its value is a pure function of the inputs
//     and the clock either way, so it needs nothing here.
//
// Refusals carry a reason. `sampleable` says whether a scene may fall back
// to sampling the producer per frame (every node upstream is a known,
// deterministic driver — only the compiler can't express it) or must refuse
// (an unknown or stateful node, Math.random, Random's frame mode).

import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import { computeMonotoneTangents, sanitizeFloatCurve } from "@/engine/float-curve";
import { EASINGS, CUSTOM_EASING } from "@/engine/easing";
import { parseTargetHandleKind } from "@/engine/graph-helpers";
import { getNodeDef } from "@/engine/registry";
import type { ExprInput } from "@/engine/types";
import { liveBlock, toTimelineKey } from "../drivers";
import type { TimelineTrack } from "../runtime/toolbox-timeline";
import { evaluateProgram, ENV_HELPERS, hashString, MATH_CONSTS, MATH_FNS, MATH_VARIADIC, type PExpr, type PStmt, type ProcCurve, type ProcProgram } from "./ir";
import { parseExpressionSource, variableNameProblem, type ExprAst } from "./parse";

// The node types this compiler knows (and the Skia layer offers as drivers).
export const PROCEDURAL_DRIVER_TYPES: ReadonlySet<string> = new Set([
  "expression",
  "lfo",
  "math",
  "scene-time",
  "random",
  "constant",
  "animated-value",
]);

// Expression's globals (expression.ts makeEnv) — the names a variable may
// not take, and what each reads.
export const EXPRESSION_ENV_KEYS = [
  "t", "time", "frame", "fps", "u", "PI", "TAU", "E",
  "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "abs", "sign", "sqrt", "cbrt", "pow", "exp", "log", "log2",
  "min", "max", "floor", "ceil", "round", "trunc", "hypot",
  "mod", "fract", "clamp", "saturate", "lerp", "mix", "step", "smoothstep", "random",
] as const;
const ENV_MATH = new Set(["sin", "cos", "tan", "asin", "acos", "atan", "atan2", "abs", "sign", "sqrt", "cbrt", "pow", "exp", "log", "log2", "min", "max", "floor", "ceil", "round", "trunc", "hypot"]);
const DEFAULT_EXPR_INPUTS: ExprInput[] = [{ id: "ein-x0", name: "x", default: 1 }];
// Math members that would make the export differ from the editor run to run.
const MATH_NONDETERMINISTIC = new Set(["random"]);
// Integer-only Math members: no SkSL form and no use in a driver.
const MATH_UNSUPPORTED = new Set(["imul", "clz32"]);

export interface ProceduralTimeline {
  fps: number;
  ticksPerFrame: number;
}

export type CompileResult =
  | { ok: true; program: ProcProgram; from: string; warnings: string[] }
  | { ok: false; reason: string; sampleable: boolean };

class Refusal extends Error {
  constructor(
    message: string,
    readonly sampleable: boolean
  ) {
    super(message);
  }
}

// A compiled node output: one expression per component (1 = scalar).
interface PVal {
  type: "scalar" | "vec2" | "vec3" | "vec4";
  comps: PExpr[];
}

const lit = (v: number): PExpr => ({ k: "lit", v });
const bin = (op: "+" | "-" | "*" | "/" | "%" | "**", a: PExpr, b: PExpr): PExpr => ({ k: "bin", op, a, b });
const cmp = (op: "<" | "<=" | ">" | ">=" | "==" | "!=", a: PExpr, b: PExpr): PExpr => ({ k: "cmp", op, a, b });
const call = (fn: string, ...args: PExpr[]): PExpr => ({ k: "call", fn, args });
const cond = (c: PExpr, a: PExpr, b: PExpr): PExpr => ({ k: "cond", c, a, b });

// Does `e` depend on anything but literals (tick, slots, tracks, randoms)?
function isPure(e: PExpr): boolean {
  switch (e.k) {
    case "lit":
      return true;
    case "slot":
    case "tick":
    case "track":
    case "rand":
      return false;
    case "bin":
    case "cmp":
    case "and":
    case "or":
      return isPure(e.a) && isPure(e.b);
    case "neg":
    case "not":
      return isPure(e.a);
    case "cond":
      return isPure(e.c) && isPure(e.a) && isPure(e.b);
    case "call":
      return e.args.every(isPure);
  }
}

class Builder {
  body: PStmt[] = [];
  tracks: TimelineTrack[] = [];
  curves: ProcCurve[] = [];
  nodes: { id: string; type: string }[] = [];
  warnings: string[] = [];
  private memo = new Map<string, PVal>();
  private clocks = new Map<string, { time?: PExpr; frame?: PExpr }>();
  private visiting = new Set<string>();
  private nRng = 0;
  readonly byId: Map<string, GraphNode>;

  constructor(
    nodes: Map<string, GraphNode> | GraphNode[],
    readonly edges: GraphEdge[],
    readonly tl: ProceduralTimeline
  ) {
    this.byId = nodes instanceof Map ? nodes : new Map(nodes.map((n) => [n.id, n]));
  }

  // Constant-fold every subtree no clock reaches (the interpreter runs the
  // same JS operations, so a folded literal is the double the worklet would
  // compute there — and the SkSL backend gets it rounded once, not computed in
  // fp32). Only folding: no algebra (x + 0 is not x for x = −0).
  fold(e: PExpr): PExpr {
    if (e.k === "lit" || e.k === "slot" || e.k === "tick" || e.k === "rand") return e;
    let f: PExpr;
    switch (e.k) {
      case "bin":
      case "cmp":
        f = { ...e, a: this.fold(e.a), b: this.fold(e.b) };
        break;
      case "and":
      case "or": {
        const a = this.fold(e.a);
        // A literal left operand decides without evaluating the right one.
        if (a.k === "lit") return (e.k === "and" ? !a.v : !!a.v) ? a : this.fold(e.b);
        f = { k: e.k, a, b: this.fold(e.b) };
        break;
      }
      case "neg":
      case "not":
        f = { k: e.k, a: this.fold(e.a) };
        break;
      case "cond": {
        const c = this.fold(e.c);
        if (c.k === "lit") return this.fold(c.v ? e.a : e.b);
        f = { k: "cond", c, a: this.fold(e.a), b: this.fold(e.b) };
        break;
      }
      case "call":
        f = { k: "call", fn: e.fn, args: e.args.map((x) => this.fold(x)) };
        break;
      case "track":
        return { k: "track", t: e.t, at: this.fold(e.at) };
    }
    if (!isPure(f)) return f;
    return lit(evaluateProgram({ body: [], out: f, tracks: [], curves: this.curves, nodes: [], fps: this.tl.fps, ticksPerFrame: this.tl.ticksPerFrame }, 0));
  }

  // Bind `e` to a slot (literals, slots and the tick need none).
  let(e: PExpr, note?: string): PExpr {
    const f = this.fold(e);
    if (f.k === "lit" || f.k === "slot" || f.k === "tick") return f;
    this.body.push({ k: "let", e: f, ...(note ? { note } : {}) });
    return { k: "slot", i: this.body.length - 1 };
  }

  rng(seed: PExpr): number {
    const r = this.nRng++;
    this.body.push({ k: "rng", r, seed: this.fold(seed) });
    return r;
  }

  track(t: TimelineTrack): number {
    const key = JSON.stringify(t);
    const i = this.tracks.findIndex((x) => JSON.stringify(x) === key);
    if (i >= 0) return i;
    this.tracks.push(t);
    return this.tracks.length - 1;
  }

  curve(raw: unknown): number {
    const pts = sanitizeFloatCurve(raw, 0, 1);
    const c: ProcCurve = { x: pts.map((p) => p.x), y: pts.map((p) => p.y), m: computeMonotoneTangents(pts) };
    const key = JSON.stringify(c);
    const i = this.curves.findIndex((x) => JSON.stringify(x) === key);
    if (i >= 0) return i;
    this.curves.push(c);
    return this.curves.length - 1;
  }

  private clockOf(tick: PExpr) {
    const key = JSON.stringify(tick);
    let c = this.clocks.get(key);
    if (!c) this.clocks.set(key, (c = {}));
    return c;
  }
  // ctx.time = tick / (ticksPerFrame · fps) (evaluator.ts, scene-sample.ts).
  time(tick: PExpr): PExpr {
    const c = this.clockOf(tick);
    return (c.time ??= this.let(bin("/", tick, lit(this.tl.ticksPerFrame * this.tl.fps)), "time = tick / (ticksPerFrame · fps)"));
  }
  // ctx.frame = floor(tick / ticksPerFrame).
  frame(tick: PExpr): PExpr {
    const c = this.clockOf(tick);
    return (c.frame ??= this.let(call("frameOf", tick, lit(this.tl.ticksPerFrame)), "frame = floor(tick / ticksPerFrame)"));
  }

  // ---- graph access ---------------------------------------------------------------------

  node(id: string): GraphNode {
    const n = this.byId.get(id);
    if (!n) throw new Refusal(`a driver reads node "${id}", which is not in the graph`, false);
    return n;
  }

  // The edge feeding input socket `socket` of `n` (the first, as the
  // evaluator takes it), when the def declares that socket.
  inputEdge(n: GraphNode, socket: string): GraphEdge | undefined {
    return this.edges.find((e) => {
      if (e.target !== n.id) return false;
      const p = parseTargetHandleKind(e.targetHandle);
      return p?.kind === "input" && p.name === socket;
    });
  }

  paramEdge(n: GraphNode, param: string): GraphEdge | undefined {
    if (!(n.exposedParams ?? []).includes(param)) return undefined;
    return this.edges.find((e) => {
      if (e.target !== n.id) return false;
      const p = parseTargetHandleKind(e.targetHandle);
      return p?.kind === "param" && p.name === param;
    });
  }

  // A wired value coerced to a scalar socket (coerce.ts: scalar → itself;
  // a vector into a scalar socket is undefined — the consumer falls back).
  scalarFrom(edge: GraphEdge, tick: PExpr, what: string): PExpr {
    const v = this.compile(edge.source, edge.sourceHandle, tick);
    if (v.type !== "scalar") {
      throw new Refusal(`${what} is wired from a ${v.type} (${edge.source}) — a vector into a scalar socket coerces to nothing in the editor, so the value silently falls back; wire a scalar`, false);
    }
    return v.comps[0];
  }

  // A def input socket's value: the wire, else a flatten-injected group
  // default, else undefined (these sockets declare no defaultValue).
  input(n: GraphNode, socket: string, tick: PExpr, what: string): PExpr | undefined {
    const e = this.inputEdge(n, socket);
    if (e) return this.scalarFrom(e, tick, what);
    const o = n.inputOverrides?.[socket];
    if (o === undefined) return undefined;
    if (typeof o !== "number") throw new Refusal(`${what} takes a group default of type ${typeof o}`, false);
    return lit(o);
  }

  // The node's keyframe tick: ctx.tick, or — for a def with clockInput
  // (Animated Value) whose clock is wired — round(clock · ticks) while the
  // wired value is finite (evaluator.ts kfTick).
  kfTick(n: GraphNode, tick: PExpr): PExpr {
    const def = getNodeDef(n.type);
    const ci = def?.clockInput;
    if (!ci) return tick;
    const e = this.inputEdge(n, ci.input);
    if (!e) return tick;
    const c = this.let(this.scalarFrom(e, tick, `${n.type} "${n.id}" clock (${ci.input})`), `${n.id} clock`);
    const unit = ci.unitParam ? this.staticParam(n, ci.unitParam) : undefined;
    const ticks = unit === "seconds" ? bin("*", bin("*", c, lit(this.tl.ticksPerFrame)), lit(this.tl.fps)) : bin("*", c, lit(this.tl.ticksPerFrame));
    return this.let(cond(call("isFinite", c), call("round", ticks), tick), `${n.id} keyframe tick`);
  }

  // A scalar param, resolved wire > keyframes > constant (undefined: the
  // param is absent — the compute's `?? default` applies).
  param(n: GraphNode, name: string, tick: PExpr): PExpr | undefined {
    const what = `${n.type} "${n.id}" ${name}`;
    const e = this.paramEdge(n, name);
    if (e) return this.scalarFrom(e, tick, what);
    const def = getNodeDef(n.type);
    const pdef = def?.params.find((p) => p.name === name);
    const block = liveBlock(n, name);
    if (block && pdef) {
      if (pdef.type !== "scalar") throw new Refusal(`${what} is keyframed (${pdef.type}) — only scalar driver params compile`, true);
      if (block.keyframes.some((k) => typeof k.value !== "number" || !Number.isFinite(k.value))) throw new Refusal(`${what} has a keyframe that isn't a finite number`, false);
      const t = this.track({ kind: "scalar", keys: block.keyframes.map((k) => toTimelineKey(k, "scalar")) });
      return { k: "track", t, at: this.kfTick(n, tick) };
    }
    const v = n.params[name];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "number") throw new Refusal(`${what} holds ${JSON.stringify(v)}, not a number`, false);
    return lit(v);
  }

  // An enum / boolean / string param the program bakes in: refused when it
  // animates (keyframed or wired).
  staticParam(n: GraphNode, name: string): unknown {
    if (liveBlock(n, name)) throw new Refusal(`${n.type} "${n.id}" ${name} is keyframed — only its numeric params may animate in a compiled driver`, true);
    if (this.paramEdge(n, name)) throw new Refusal(`${n.type} "${n.id}" ${name} is wired — only its numeric params may be driven in a compiled driver`, true);
    return n.params[name];
  }

  // ---- nodes ---------------------------------------------------------------------------

  compile(id: string, handle: string, tick: PExpr): PVal {
    const key = `${id}|${handle}|${JSON.stringify(tick)}`;
    const hit = this.memo.get(key);
    if (hit) return hit;
    if (this.visiting.has(key)) throw new Refusal(`the driver graph has a cycle through "${id}"`, false);
    this.visiting.add(key);
    const n = this.node(id);
    if (!PROCEDURAL_DRIVER_TYPES.has(n.type)) {
      const def = getNodeDef(n.type);
      throw new Refusal(
        `"${id}" (${n.type}) feeds the driver — it isn't one the exporter compiles (Expression, LFO, Math, Scene Time, Random, Constant, Animated Value)${def?.stable === false ? "; it is stateful or time-driven" : ""}`,
        false
      );
    }
    if (n.bypassed) throw new Refusal(`driver "${id}" (${n.type}) is bypassed`, false);
    if (n.clips?.some((c) => c.enabled)) throw new Refusal(`driver "${id}" (${n.type}) sits on a clip window — a gated driver doesn't compile`, false);
    if (handle !== "out:primary") throw new Refusal(`driver "${id}" is read through ${handle} — only a driver's primary output compiles`, false);
    if (!this.nodes.some((x) => x.id === id)) this.nodes.push({ id, type: n.type });
    let v: PVal;
    switch (n.type) {
      case "constant":
        v = this.constant(n, tick);
        break;
      case "animated-value":
        v = this.animatedValue(n, tick);
        break;
      case "lfo":
        v = this.lfo(n, tick);
        break;
      case "math":
        v = this.math(n, tick);
        break;
      case "scene-time":
        v = this.sceneTime(n, tick);
        break;
      case "random":
        v = this.random(n, tick);
        break;
      case "expression":
        v = this.expression(n, tick);
        break;
      default:
        throw new Refusal(`"${id}" (${n.type}) has no procedural lowering`, false);
    }
    v = { type: v.type, comps: v.comps.map((c, i) => this.let(c, `${n.id}${v.comps.length > 1 ? `[${i}]` : ""} (${n.type})`)) };
    this.visiting.delete(key);
    this.memo.set(key, v);
    return v;
  }

  // constant.ts: parseFloat((Math.round(raw / step) * step).toFixed(6)),
  // then Math.round in integer mode.
  constant(n: GraphNode, tick: PExpr): PVal {
    const mode = this.staticParam(n, "mode");
    const rawStep = this.staticParam(n, "step");
    const s = typeof rawStep === "number" && rawStep > 0 ? rawStep : 0.001;
    const step = mode === "integer" ? Math.max(1, Math.round(s)) : s;
    const raw = this.param(n, "value", tick) ?? lit(0);
    let v = call("fixed6", bin("*", call("round", bin("/", raw, lit(step))), lit(step)));
    if (mode === "integer") v = call("round", v);
    return { type: "scalar", comps: [v] };
  }

  // animated-value.ts: params.value (wired > keyframes at the keyframe tick >
  // static), non-finite → 0.
  animatedValue(n: GraphNode, tick: PExpr): PVal {
    const v = this.param(n, "value", tick) ?? lit(0);
    return { type: "scalar", comps: [call("toNum", v)] };
  }

  // lfo.ts compute.
  lfo(n: GraphNode, tick: PExpr): PVal {
    const shape = (this.staticParam(n, "shape") as string) ?? "sine";
    if (!["sine", "triangle", "sawtooth", "square"].includes(shape)) throw new Refusal(`LFO "${n.id}" has an unknown shape "${shape}"`, false);
    const unit = this.staticParam(n, "clock_unit");
    const clockIn = this.input(n, "clock", tick, `LFO "${n.id}" clock`);
    let t: PExpr;
    if (clockIn) {
      const c = this.let(clockIn, `${n.id} clock`);
      const fps = this.tl.fps > 0 ? this.tl.fps : 60;
      t = cond(call("isFinite", c), unit === "frames" ? bin("/", c, lit(fps)) : c, this.time(tick));
    } else t = this.time(tick);
    const pick = (name: string, dflt: number) => this.input(n, name, tick, `LFO "${n.id}" ${name}`) ?? this.param(n, name, tick) ?? lit(dflt);
    const frequency = pick("frequency", 1);
    const phase = pick("phase", 0);
    const amplitude = pick("amplitude", 1);
    const offset = pick("offset", 0);
    // ((t · frequency + phase) % 1 + 1) % 1 — on the playhead as one call,
    // so the SkSL backend can reduce the tick by the period first (fp32).
    const p = this.let(
      clockIn
        ? bin("%", bin("+", bin("%", bin("+", bin("*", t, frequency), phase), lit(1)), lit(1)), lit(1))
        : call("lfoPhase", tick, lit(this.tl.ticksPerFrame * this.tl.fps), frequency, phase),
      `${n.id} phase`
    );
    let w: PExpr;
    switch (shape) {
      case "sine":
        w = call("sin", bin("*", bin("*", lit(2), lit(Math.PI)), p));
        break;
      case "triangle":
        w = bin("-", bin("*", lit(4), call("abs", bin("-", p, lit(0.5)))), lit(1));
        break;
      case "sawtooth":
        w = bin("-", bin("*", lit(2), p), lit(1));
        break;
      default:
        w = cond(cmp("<", p, lit(0.5)), lit(1), lit(-1));
    }
    return { type: "scalar", comps: [bin("+", bin("*", w, amplitude), offset)] };
  }

  // math.ts compute, scalar path (evalOp + clamp).
  math(n: GraphNode, tick: PExpr): PVal {
    const mode = this.staticParam(n, "mode") ?? "scalar";
    if (mode !== "scalar") throw new Refusal(`Math "${n.id}" runs in ${String(mode)} mode — only scalar Math compiles (uv mode is a per-pixel shader)`, false);
    const op = (this.staticParam(n, "operation") as string) ?? "Add";
    const clampOn = !!this.staticParam(n, "clamp");
    const def = getNodeDef("math");
    const sockets = new Set((def?.resolveInputs?.(n.params, { connectedTypes: {} }) ?? def?.inputs ?? []).map((s) => s.name));
    const read = (name: "a" | "b" | "c") => {
      const fromWire = sockets.has(name) ? this.input(n, name, tick, `Math "${n.id}" ${name}`) : undefined;
      return this.let(fromWire ?? this.param(n, name, tick) ?? lit(0), `${n.id}.${name}`);
    };
    const a = read("a");
    const b = read("b");
    const c = read("c");
    const zero = lit(0);
    const smoothMin = (x: PExpr, y: PExpr, k: PExpr): PExpr => {
      const h = this.let(call("max", lit(0), call("min", lit(1), bin("+", lit(0.5), bin("/", bin("*", lit(0.5), bin("-", y, x)), k)))), `${n.id} smooth h`);
      const oneMinusH = bin("-", lit(1), h);
      return cond(cmp("<=", k, zero), call("min", x, y), bin("-", bin("+", bin("*", y, oneMinusH), bin("*", x, h)), bin("*", bin("*", k, h), bin("-", lit(1), h))));
    };
    let v: PExpr;
    switch (op) {
      case "Add":
        v = bin("+", a, b);
        break;
      case "Subtract":
        v = bin("-", a, b);
        break;
      case "Multiply":
        v = bin("*", a, b);
        break;
      case "Divide":
        v = cond(cmp("==", b, zero), zero, bin("/", a, b));
        break;
      case "Multiply Add":
        v = bin("+", bin("*", a, b), c);
        break;
      case "Power":
        v = call("pow", a, b);
        break;
      case "Logarithm":
        v = cond({ k: "or", a: { k: "or", a: cmp("<=", a, zero), b: cmp("<=", b, zero) }, b: cmp("==", b, lit(1)) }, zero, bin("/", call("log", a), call("log", b)));
        break;
      case "Square Root":
        v = cond(cmp("<", a, zero), zero, call("sqrt", a));
        break;
      case "Inverse Square Root":
        v = cond(cmp("<=", a, zero), zero, bin("/", lit(1), call("sqrt", a)));
        break;
      case "Absolute":
        v = call("abs", a);
        break;
      case "Exponent":
        v = call("exp", a);
        break;
      case "Minimum":
        v = call("min", a, b);
        break;
      case "Maximum":
        v = call("max", a, b);
        break;
      case "Less Than":
        v = cmp("<", a, b);
        break;
      case "Greater Than":
        v = cmp(">", a, b);
        break;
      case "Sign":
        v = call("sign", a);
        break;
      case "Compare":
        v = cmp("<=", call("abs", bin("-", a, b)), c);
        break;
      case "Smooth Minimum":
        v = smoothMin(a, b, c);
        break;
      case "Smooth Maximum":
        v = { k: "neg", a: smoothMin(this.let({ k: "neg", a }), this.let({ k: "neg", a: b }), c) };
        break;
      case "Round":
        v = call("round", a);
        break;
      case "Floor":
        v = call("floor", a);
        break;
      case "Ceiling":
        v = call("ceil", a);
        break;
      case "Truncate":
        v = call("trunc", a);
        break;
      case "Fraction":
        v = bin("-", a, call("floor", a));
        break;
      case "Truncated Modulo":
        v = cond(cmp("==", b, zero), zero, bin("-", a, bin("*", call("trunc", bin("/", a, b)), b)));
        break;
      case "Floored Modulo":
        v = cond(cmp("==", b, zero), zero, bin("-", a, bin("*", call("floor", bin("/", a, b)), b)));
        break;
      case "Wrap": {
        const range = this.let(bin("-", c, b), `${n.id} wrap range`);
        v = cond(cmp("==", range, zero), b, bin("-", a, bin("*", call("floor", bin("/", bin("-", a, b), range)), range)));
        break;
      }
      case "Snap":
        v = cond(cmp("==", b, zero), a, bin("*", call("round", bin("/", a, b)), b));
        break;
      case "Ping-Pong": {
        const two = this.let(bin("*", lit(2), b), `${n.id} 2·scale`);
        const phased = this.let(bin("%", bin("+", bin("%", a, two), two), two), `${n.id} phased`);
        v = cond(cmp("==", b, zero), zero, bin("-", b, call("abs", bin("-", phased, b))));
        break;
      }
      case "Sine":
        v = call("sin", a);
        break;
      case "Cosine":
        v = call("cos", a);
        break;
      case "Tangent":
        v = call("tan", a);
        break;
      case "Arcsine":
        v = call("asin", call("max", lit(-1), call("min", lit(1), a)));
        break;
      case "Arccosine":
        v = call("acos", call("max", lit(-1), call("min", lit(1), a)));
        break;
      case "Arctangent":
        v = call("atan", a);
        break;
      case "Arctan2":
        v = call("atan2", a, b);
        break;
      case "Hyperbolic Sine":
        v = call("sinh", a);
        break;
      case "Hyperbolic Cosine":
        v = call("cosh", a);
        break;
      case "Hyperbolic Tangent":
        v = call("tanh", a);
        break;
      case "To Radians":
        v = bin("/", bin("*", a, lit(Math.PI)), lit(180));
        break;
      case "To Degrees":
        v = bin("/", bin("*", a, lit(180)), lit(Math.PI));
        break;
      default:
        throw new Refusal(`Math "${n.id}" has an unknown operation "${op}"`, false);
    }
    if (clampOn) v = call("max", lit(0), call("min", lit(1), v));
    return { type: "scalar", comps: [v] };
  }

  // engine/easing.ts applyEasingOrCurve(name, t, intensity, params.easing_curve).
  ease(n: GraphNode, name: string, t: PExpr, intensity: PExpr): PExpr {
    if (name === CUSTOM_EASING) {
      if (this.paramEdge(n, "easing_curve")) throw new Refusal(`Scene Time "${n.id}" takes its custom easing curve from a wire — only a drawn (static) curve compiles`, true);
      if (liveBlock(n, "easing_curve")) throw new Refusal(`Scene Time "${n.id}" easing_curve is keyframed`, true);
      return call(`curve:${this.curve(n.params.easing_curve)}`, t, intensity);
    }
    return call(`ease:${name in EASINGS ? name : "linear"}`, t, intensity);
  }

  // scene-time.ts compute.
  sceneTime(n: GraphNode, tick: PExpr): PVal {
    const unit = (this.staticParam(n, "unit") as string) ?? "seconds";
    const mode = (this.staticParam(n, "mode") as string) ?? "linear";
    const tpf = this.tl.ticksPerFrame;
    const frames = () => (tpf > 0 ? this.let(bin("/", tick, lit(tpf)), "fractional frame") : this.frame(tick));
    const base = unit === "frames" ? frames() : this.time(tick);
    const intensity = this.param(n, "ease_intensity", tick) ?? lit(1);
    const p = (name: string, dflt: number) => this.param(n, name, tick) ?? lit(dflt);
    if (mode === "pingpong" || mode === "sawtooth") {
      const full = this.let(call("max", lit(1e-4), p("period_frames", 120)), `${n.id} period`);
      const fr = frames();
      const phased = this.let(bin("%", bin("+", bin("%", fr, full), full), full), `${n.id} phased`);
      let t: PExpr;
      if (mode === "sawtooth") t = bin("/", phased, full);
      else {
        const half = this.let(bin("/", full, lit(2)), `${n.id} half`);
        t = bin("/", bin("-", half, call("abs", bin("-", phased, half))), half);
      }
      const easing = (this.staticParam(n, "pingpong_easing") as string) ?? "linear";
      const eased = this.let(this.ease(n, easing, t, intensity), `${n.id} eased`);
      const lo = this.let(p("min", 0));
      const hi = this.let(p("max", 1));
      const amp = p("amplitude", 1);
      const center = bin("/", bin("+", lo, hi), lit(2));
      const span = bin("-", hi, lo);
      return { type: "scalar", comps: [bin("+", center, bin("*", bin("*", bin("-", eased, lit(0.5)), span), amp))] };
    }
    const offset = p("offset", 0);
    if (mode === "stepped") {
      const duration = this.let(call("max", lit(1e-4), unit === "frames" ? p("step_frames", 12) : p("step_seconds", 1)), `${n.id} step duration`);
      const size = p("step_size", 1);
      const easing = (this.staticParam(n, "easing") as string) ?? "smoothstep";
      const idx = this.let(call("floor", bin("/", base, duration)), `${n.id} step index`);
      const alpha = bin("-", bin("/", base, duration), idx);
      const eased = this.ease(n, easing, alpha, intensity);
      return { type: "scalar", comps: [bin("+", bin("*", bin("+", idx, eased), size), offset)] };
    }
    if (mode !== "linear") throw new Refusal(`Scene Time "${n.id}" has an unknown mode "${mode}"`, false);
    return { type: "scalar", comps: [bin("+", bin("*", base, p("scale", 1)), offset)] };
  }

  // random.ts compute, seeded mode. The node caches per frame (computed
  // once, at the frame's first evaluation), so its params are read at the
  // frame's tick.
  random(n: GraphNode, tick: PExpr): PVal {
    const mode = (this.staticParam(n, "mode") as string) ?? "seeded";
    if (mode !== "seeded") throw new Refusal(`Random "${n.id}" is in frame mode (Math.random() every evaluation) — the editor itself never repeats it; use seeded mode`, false);
    const shape = (this.staticParam(n, "shape") as string) ?? "scalar";
    const dist = (this.staticParam(n, "distribution") as string) ?? "uniform";
    const frame = this.frame(tick);
    const ft = this.let(bin("*", frame, lit(this.tl.ticksPerFrame)), `${n.id} frame tick`);
    const lo = this.let(this.param(n, "lo", ft) ?? lit(0));
    const hi = this.let(this.param(n, "hi", ft) ?? lit(1));
    const seed = this.let(this.param(n, "seed", ft) ?? lit(0));
    const u = (salt: number) => call("hash01", seed, frame, lit(salt));
    let rx: PExpr;
    let ry: PExpr;
    if (dist === "gauss") {
      const center = this.let(bin("/", bin("+", lo, hi), lit(2)));
      const sigma = this.let(bin("/", bin("/", bin("-", hi, lo), lit(2)), lit(3)));
      const gauss = (u1: PExpr, u2: PExpr) =>
        bin("*", call("sqrt", bin("*", lit(-2), call("log", call("max", u1, lit(1e-9))))), call("cos", bin("*", bin("*", lit(2), lit(Math.PI)), u2)));
      rx = bin("+", center, bin("*", gauss(u(1), u(2)), sigma));
      ry = bin("+", center, bin("*", gauss(u(3), u(4)), sigma));
    } else {
      rx = bin("+", lo, bin("*", u(1), bin("-", hi, lo)));
      ry = bin("+", lo, bin("*", u(2), bin("-", hi, lo)));
    }
    return shape === "vec2" ? { type: "vec2", comps: [rx, ry] } : { type: "scalar", comps: [rx] };
  }

  // expression.ts compute.
  expression(n: GraphNode, tick: PExpr): PVal {
    // (params.inputs ?? DEFAULT_INPUTS, as expression.ts reads it.)
    const entries = Array.isArray(n.params.inputs) ? (n.params.inputs as ExprInput[]) : DEFAULT_EXPR_INPUTS;
    const source = typeof n.params.expression === "string" ? n.params.expression : "";
    if (n.params.expression !== undefined && typeof n.params.expression !== "string") throw new Refusal(`Expression "${n.id}" source isn't a string`, false);
    const outType = (this.staticParam(n, "out_type") as string) ?? "scalar";
    if (this.paramEdge(n, "expression") || liveBlock(n, "expression")) throw new Refusal(`Expression "${n.id}" source is wired or keyframed`, false);
    const width = outType === "scalar" ? 1 : outType === "vec2" ? 2 : outType === "vec3" ? 3 : outType === "vec4" ? 4 : 0;
    if (!width) throw new Refusal(`Expression "${n.id}" outputs ${outType === "curve" ? "a float curve (out_type curve)" : `"${outType}"`} — only scalar and vector outputs drive a value`, false);
    const type = (width === 1 ? "scalar" : `vec${width}`) as PVal["type"];
    const where = `Expression "${n.id}"`;
    const names = entries.map((e) => e.name);
    const nameProblem = variableNameProblem(names, EXPRESSION_ENV_KEYS);
    if (nameProblem) throw new Refusal(`${where}: ${nameProblem}`, true);
    const parsed = parseExpressionSource(source);
    if (!parsed.ok) throw new Refusal(`${where}: \`${source.trim().slice(0, 60)}\` uses ${parsed.reason}, which the exporter doesn't compile`, true);
    if (parsed.empty) return { type, comps: new Array(width).fill(lit(0)) };

    // Each variable: its wire (coerced to a scalar), else its row default
    // (itself defaulting to 1).
    const vars = new Map<string, PExpr>();
    entries.forEach((e) => {
      const socket = `in:${e.id}`;
      const wired = this.input(n, socket, tick, `${where} variable "${e.name}"`);
      if (wired) {
        vars.set(e.name, this.let(wired, `${n.id}.${e.name}`));
        return;
      }
      const d = e.default ?? 1;
      if (typeof d !== "number") throw new Refusal(`${where} variable "${e.name}" defaults to ${JSON.stringify(d)}, not a number`, false);
      vars.set(e.name, lit(d));
    });

    let rngIdx: number | null = null;
    const rand = (): PExpr => {
      if (rngIdx === null) rngIdx = this.rng(call("seed32", lit(hashString(n.id)), this.frame(tick)));
      return { k: "rand", r: rngIdx };
    };
    const ex = new ExprCompiler(this, n.id, vars, tick, rand);
    const root = parsed.ast;
    if (root.k === "array") {
      if (width === 1) {
        // raw[0] (the other elements draw after it, so they can't change it).
        return { type, comps: [root.items.length ? call("toNum", ex.value(root.items[0])) : lit(0)] };
      }
      // Every element in order — one evaluation, one RNG sequence.
      const items = root.items.map((it, i) => this.let(ex.value(it), `${n.id}[${i}]`));
      return { type, comps: Array.from({ length: width }, (_, i) => (i < items.length ? call("toNum", items[i]) : lit(0))) };
    }
    const s = this.let(call("toNum", ex.value(root)), `${n.id} = ${source.trim().replace(/\s+/g, " ").slice(0, 60)}`);
    return { type, comps: new Array(width).fill(s) };
  }
}

type StaticType = "num" | "bool" | "mix";

// One Expression's AST → IR (numberized; see ir.ts).
class ExprCompiler {
  constructor(
    private b: Builder,
    private nodeId: string,
    private vars: Map<string, PExpr>,
    private tick: PExpr,
    private rand: () => PExpr
  ) {}

  private where(): string {
    return `Expression "${this.nodeId}"`;
  }
  private refuse(msg: string, sampleable = true): never {
    throw new Refusal(`${this.where()}: ${msg}`, sampleable);
  }

  value(a: ExprAst): PExpr {
    return this.c(a).e;
  }

  private c(a: ExprAst): { e: PExpr; t: StaticType } {
    switch (a.k) {
      case "num":
        return { e: lit(a.v), t: "num" };
      case "bool":
        return { e: lit(a.v ? 1 : 0), t: "bool" };
      case "id":
        return { e: this.ident(a.name), t: "num" };
      case "math": {
        if (a.name in MATH_CONSTS) return { e: lit(MATH_CONSTS[a.name]), t: "num" };
        return this.refuse(`Math.${a.name} used as a value`);
      }
      case "unary": {
        const x = this.c(a.a);
        if (a.op === "-") return { e: { k: "neg", a: x.e }, t: "num" };
        if (a.op === "+") return { e: x.e, t: "num" }; // +x of a number (or a 1 / 0) is itself
        return { e: { k: "not", a: x.e }, t: "bool" };
      }
      case "binary": {
        const x = this.c(a.a);
        const y = this.c(a.b);
        switch (a.op) {
          case "+":
          case "-":
          case "*":
          case "/":
          case "%":
          case "**":
            return { e: bin(a.op, x.e, y.e), t: "num" };
          case "===":
          case "!==":
            if (x.t !== y.t || x.t === "mix") this.refuse(`${a.op} between a ${x.t === "num" ? "number" : x.t === "bool" ? "boolean" : "boolean-or-number"} and a ${y.t === "num" ? "number" : y.t === "bool" ? "boolean" : "boolean-or-number"} (strict equality doesn't convert — write == or compare like with like)`);
            return { e: cmp(a.op === "===" ? "==" : "!=", x.e, y.e), t: "bool" };
          default:
            return { e: cmp(a.op, x.e, y.e), t: "bool" };
        }
      }
      case "logical": {
        const x = this.c(a.a);
        const y = this.c(a.b);
        return { e: { k: a.op === "&&" ? "and" : "or", a: x.e, b: y.e }, t: x.t === y.t ? x.t : "mix" };
      }
      case "cond": {
        const c = this.c(a.c);
        const x = this.c(a.a);
        const y = this.c(a.b);
        return { e: cond(c.e, x.e, y.e), t: x.t === y.t ? x.t : "mix" };
      }
      case "call":
        return { e: this.call(a.callee, a.args), t: "num" };
      case "array":
        return this.refuse("an array literal inside an expression");
    }
  }

  private ident(name: string): PExpr {
    const v = this.vars.get(name);
    if (v) return v;
    switch (name) {
      case "t":
      case "time":
        return this.b.time(this.tick);
      case "frame":
        return this.b.frame(this.tick);
      case "fps":
        return lit(this.b.tl.fps);
      case "u":
        return lit(0);
      case "PI":
        return lit(Math.PI);
      case "TAU":
        return lit(Math.PI * 2);
      case "E":
        return lit(Math.E);
      case "Infinity":
        return lit(Infinity);
      case "NaN":
        return lit(NaN);
    }
    if ((EXPRESSION_ENV_KEYS as readonly string[]).includes(name)) return this.refuse(`the function "${name}" used as a value (call it)`);
    return this.refuse(`the unknown name "${name}" (neither an input variable nor a global — the editor throws a ReferenceError and outputs 0)`);
  }

  private call(callee: { k: "id"; name: string } | { k: "math"; name: string }, argAsts: ExprAst[]): PExpr {
    const name = callee.name;
    const label = callee.k === "math" ? `Math.${name}` : name;
    if (callee.k === "id" && this.vars.has(name)) this.refuse(`calling the variable "${name}"`);
    if (callee.k === "math" && MATH_NONDETERMINISTIC.has(name)) {
      this.refuse(`Math.${name}() (a different value every evaluation, run to run — use random(), which is seeded per node and frame)`, false);
    }
    if (callee.k === "math" && MATH_UNSUPPORTED.has(name)) this.refuse(`Math.${name} (integer bit math)`);
    if (callee.k === "id" && name === "random") {
      if (argAsts.length) this.refuse("random() takes no arguments");
      return this.rand();
    }
    const isMath = callee.k === "math" ? name in MATH_FNS || MATH_VARIADIC.has(name) : ENV_MATH.has(name);
    const args = argAsts.map((x) => this.value(x));
    if (isMath) {
      const arity = MATH_FNS[name];
      if (arity !== undefined && args.length !== arity) this.refuse(`${label} takes ${arity} argument${arity === 1 ? "" : "s"}, got ${args.length}`);
      return call(name, ...args);
    }
    if (callee.k === "id" && name in ENV_HELPERS) {
      const arity = ENV_HELPERS[name].arity;
      if (args.length !== arity) this.refuse(`${name} takes ${arity} argument${arity === 1 ? "" : "s"}, got ${args.length}`);
      return call(name, ...args);
    }
    if (callee.k === "math") return this.refuse(`Math.${name}, which isn't a Math function the exporter knows`);
    if (MATH_CONSTS[name] !== undefined || ["t", "time", "frame", "fps", "u", "PI", "TAU", "E"].includes(name)) return this.refuse(`calling "${name}", which isn't a function`);
    return this.refuse(`the unknown function "${name}" (the editor throws and outputs 0)`);
  }
}

// What a consumer reads from a driver: its whole scalar output, or one
// component of a vector param after coerceValue's widening (scalar →
// broadcast; vec2 → vec3 / vec4 pads z = 0, w = 1; vec3 → vec4 pads w = 1).
export interface DriverTarget {
  // The consumer's socket type.
  socket: "scalar" | "vec2" | "vec3" | "vec4";
  // The component the bind reads (vector sockets).
  component?: number;
}

function provenance(nodes: { id: string; type: string }[]): string {
  const name = (t: string) => getNodeDef(t)?.name ?? t;
  return `procedural: ${nodes.map((n) => `${name(n.type)} ${n.id}`).join(" ← ")}`;
}

// Compile the driver feeding a value through `edge` (its source node and
// handle). `nodes` is the flattened graph (an id map is fine).
export function compileDriver(
  edge: Pick<GraphEdge, "source" | "sourceHandle">,
  nodes: Map<string, GraphNode> | GraphNode[],
  edges: GraphEdge[],
  timeline: ProceduralTimeline,
  target: DriverTarget = { socket: "scalar" }
): CompileResult {
  const b = new Builder(nodes, edges, timeline);
  try {
    const v = b.compile(edge.source, edge.sourceHandle, { k: "tick" });
    let out: PExpr;
    const width = (t: PVal["type"] | DriverTarget["socket"]) => (t === "scalar" ? 1 : Number(t.slice(3)));
    if (target.socket === "scalar") {
      if (v.type !== "scalar") throw new Refusal(`the driver outputs a ${v.type} into a scalar value — a vector into a scalar socket coerces to nothing in the editor`, false);
      out = v.comps[0];
    } else {
      const c = target.component;
      if (c === undefined) throw new Refusal(`a whole ${target.socket} bind can't take a procedural driver — bind one component per value`, false);
      if (v.type === "scalar") out = v.comps[0];
      else {
        const from = width(v.type);
        const to = width(target.socket);
        if (from > to) throw new Refusal(`the driver outputs a ${v.type} into a ${target.socket} — narrowing coerces to nothing in the editor`, false);
        out = c < from ? v.comps[c] : c === 3 ? lit(1) : lit(0);
      }
    }
    const program: ProcProgram = {
      body: b.body,
      out,
      tracks: b.tracks,
      curves: b.curves,
      nodes: b.nodes,
      fps: timeline.fps,
      ticksPerFrame: timeline.ticksPerFrame,
    };
    return { ok: true, program: prune(program), from: provenance(b.nodes), warnings: b.warnings };
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, reason: e.message, sampleable: e.sampleable && upstreamAllDrivers(edge.source, nodes, edges) };
    throw e;
  }
}

// Every node feeding `id` (itself included) is a known driver type — a scene
// may then sample the producer instead (deterministic per tick).
function upstreamAllDrivers(id: string, nodes: Map<string, GraphNode> | GraphNode[], edges: GraphEdge[]): boolean {
  const byId = nodes instanceof Map ? nodes : new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const n = byId.get(cur);
    if (!n || !PROCEDURAL_DRIVER_TYPES.has(n.type)) return false;
    for (const e of edges) if (e.target === cur) stack.push(e.source);
  }
  return true;
}

// Drop statements nothing reads (a vec2's unused component, a smooth-min
// helper a branch never needs…), renumbering slots. RNG statements and every
// `let` that draws a random stay: a draw advances the state later draws see.
function prune(p: ProcProgram): ProcProgram {
  const used = new Set<number>();
  const draws = (e: PExpr): boolean => {
    switch (e.k) {
      case "rand":
        return true;
      case "bin":
      case "cmp":
      case "and":
      case "or":
        return draws(e.a) || draws(e.b);
      case "neg":
      case "not":
        return draws(e.a);
      case "cond":
        return draws(e.c) || draws(e.a) || draws(e.b);
      case "call":
        return e.args.some(draws);
      case "track":
        return draws(e.at);
      default:
        return false;
    }
  };
  const mark = (e: PExpr): void => {
    switch (e.k) {
      case "slot":
        used.add(e.i);
        return;
      case "bin":
      case "cmp":
      case "and":
      case "or":
        mark(e.a);
        mark(e.b);
        return;
      case "neg":
      case "not":
        mark(e.a);
        return;
      case "cond":
        mark(e.c);
        mark(e.a);
        mark(e.b);
        return;
      case "call":
        e.args.forEach(mark);
        return;
      case "track":
        mark(e.at);
        return;
      default:
        return;
    }
  };
  mark(p.out);
  // Walk backwards: a kept statement keeps what it reads.
  const keep = new Array(p.body.length).fill(false);
  const rngUsed = new Set<number>();
  const rngOf = (e: PExpr, out: Set<number>): void => {
    if (e.k === "rand") out.add(e.r);
    else if (e.k === "bin" || e.k === "cmp" || e.k === "and" || e.k === "or") {
      rngOf(e.a, out);
      rngOf(e.b, out);
    } else if (e.k === "neg" || e.k === "not") rngOf(e.a, out);
    else if (e.k === "cond") {
      rngOf(e.c, out);
      rngOf(e.a, out);
      rngOf(e.b, out);
    } else if (e.k === "call") e.args.forEach((x) => rngOf(x, out));
    else if (e.k === "track") rngOf(e.at, out);
  };
  rngOf(p.out, rngUsed);
  for (let i = p.body.length - 1; i >= 0; i--) {
    const s = p.body[i];
    if (s.k === "let") {
      // A draw on an RNG whose later draws are read keeps its place.
      const rs = new Set<number>();
      rngOf(s.e, rs);
      const advancesUsed = draws(s.e) && [...rs].some((r) => rngUsed.has(r));
      if (used.has(i) || advancesUsed) {
        keep[i] = true;
        mark(s.e);
        rs.forEach((r) => rngUsed.add(r));
      }
    } else if (rngUsed.has(s.r)) {
      keep[i] = true;
      mark(s.seed);
    }
  }
  const remap = new Map<number, number>();
  const body: PStmt[] = [];
  p.body.forEach((s, i) => {
    if (!keep[i]) return;
    remap.set(i, body.length);
    body.push(s);
  });
  const re = (e: PExpr): PExpr => {
    switch (e.k) {
      case "slot":
        return { k: "slot", i: remap.get(e.i)! };
      case "bin":
      case "cmp":
        return { ...e, a: re(e.a), b: re(e.b) };
      case "and":
      case "or":
        return { k: e.k, a: re(e.a), b: re(e.b) };
      case "neg":
      case "not":
        return { k: e.k, a: re(e.a) };
      case "cond":
        return { k: "cond", c: re(e.c), a: re(e.a), b: re(e.b) };
      case "call":
        return { k: "call", fn: e.fn, args: e.args.map(re) };
      case "track":
        return { k: "track", t: e.t, at: re(e.at) };
      default:
        return e;
    }
  };
  const nb = body.map((s): PStmt => (s.k === "let" ? { ...s, e: re(s.e) } : { ...s, seed: re(s.seed) }));
  // Tracks / curves nothing reads any more stay (indices are stable); cheap.
  return { ...p, body: nb, out: re(p.out) };
}
