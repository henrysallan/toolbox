// A compiled program (compile.ts, the Skia driver IR) → one After Effects
// expression (the project's JavaScript engine, ECMAScript 2018).
//
// The text is plain var / function JavaScript: helper functions (each the
// engine's own arithmetic, as skia-export/procedural/ir.ts fnImpl runs it),
// the toolbox tick from AE's `time`, one `var` per program statement, and the
// value last. Every operator is parenthesised, so nothing depends on
// precedence or ternary associativity (ExtendScript's left-associative ?:
// would still read it right if the engine were switched). Numbers print as
// their shortest round-trip form, so every literal is the double the program
// holds.
//
// The clock: toolbox evaluates a layer's interior on its local tick, local =
// comp tick − offsetTicks; AE's `time` is the time of the comp holding the
// layer. tick = time · fps · ticksPerFrame, snapped to the integer within
// 1e-6 (the Skia runtime's ticksAt), so frame-aligned times are the editor's
// exact ticks and sub-frame times (motion blur) interpolate the clock.

import { EASINGS } from "@/engine/easing";
import { ENV_HELPERS, MATH_FNS, MATH_VARIADIC, MULBERRY_STEP, type PExpr, type ProcProgram } from "@/lib/skia-export/procedural/ir";

// The last line of every compiled expression: what scaleExpression rewrites.
export const OUT_LINE = "tbxOut;";
export const HEADER_MARK = "// toolbox value graph";

export interface AeEmitOptions {
  fps: number;
  ticksPerFrame: number;
  // Comp tick − this = the toolbox clock (WalkClock.offsetTicks).
  offsetTicks: number;
  // Comment lines after the marker (provenance).
  header: string[];
  // Leaf tracks → the AE code that reads them live (compile.ts leafCode).
  leafCode?: ReadonlyMap<number, string>;
  // RNGs that are AE's seedRandom / random() (compile.ts aeRngs).
  aeRngs?: ReadonlySet<number>;
}

export function aeNumber(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "Infinity";
  if (v === -Infinity) return "(-Infinity)";
  if (Object.is(v, -0)) return "(-0)";
  return v < 0 ? `(${String(v)})` : String(v);
}

// ---- helpers (engine code; plain JavaScript) ---------------------------------------------

const ENV_SRC: Record<string, string> = {
  mod: "function tbxMod(a, b) { return b === 0 ? 0 : a - Math.floor(a / b) * b; }",
  fract: "function tbxFract(x) { return x - Math.floor(x); }",
  clamp: "function tbxClamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }",
  saturate: "function tbxSaturate(v) { return Math.min(Math.max(v, 0), 1); }",
  lerp: "function tbxLerp(a, b, k) { return a + (b - a) * k; }",
  mix: "function tbxMix(a, b, k) { return a + (b - a) * k; }",
  step: "function tbxStep(edge, x) { return x < edge ? 0 : 1; }",
  smoothstep:
    "function tbxSmoothstep(e0, e1, x) {\n  var d = e1 - e0;\n  var k = Math.min(Math.max(d === 0 ? 0 : (x - e0) / d, 0), 1);\n  return k * k * (3 - 2 * k);\n}",
};
const envName = (fn: string) => `tbx${fn[0].toUpperCase()}${fn.slice(1)}`;

const HASH01 =
  "function tbxHash01(seed, frame, salt) {\n" +
  "  var h = (seed | 0) ^ Math.imul(frame | 0, 0x27d4eb2d) ^ Math.imul(salt | 0, 0x165667b1);\n" +
  "  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);\n" +
  "  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);\n" +
  "  h ^= h >>> 16;\n" +
  "  return (h >>> 0) / 4294967296;\n" +
  "}";
const DRAW =
  "function tbxDraw(a) {\n" +
  "  var t = Math.imul(a ^ (a >>> 15), 1 | a);\n" +
  "  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;\n" +
  "  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;\n" +
  "}";
const LFO_PHASE = "function tbxLfoPhase(tick, tps, f, ph) {\n  var raw = (tick / tps) * f + ph;\n  return ((raw % 1) + 1) % 1;\n}";
const TO_NUM = "function tbxToNum(v) { return Number.isFinite(v) ? v : 0; }";
const EVAL_CURVE =
  "function tbxEvalCurve(cx, cy, cm, x) {\n" +
  "  var n = cx.length;\n" +
  "  if (n === 0) return 0;\n" +
  "  if (n === 1) return cy[0];\n" +
  "  if (x <= cx[0]) return cy[0];\n" +
  "  if (x >= cx[n - 1]) return cy[n - 1];\n" +
  "  var i = 0;\n" +
  "  for (; i < n - 1; i++) {\n" +
  "    if (x <= cx[i + 1]) break;\n" +
  "  }\n" +
  "  var x0 = cx[i];\n" +
  "  var x1 = cx[i + 1];\n" +
  "  var h = x1 - x0;\n" +
  "  if (h === 0) return cy[i];\n" +
  "  var t = (x - x0) / h;\n" +
  "  var t2 = t * t;\n" +
  "  var t3 = t2 * t;\n" +
  "  var h00 = 2 * t3 - 3 * t2 + 1;\n" +
  "  var h10 = t3 - 2 * t2 + t;\n" +
  "  var h01 = -2 * t3 + 3 * t2;\n" +
  "  var h11 = t3 - t2;\n" +
  "  return h00 * cy[i] + h10 * h * cm[i] + h01 * cy[i + 1] + h11 * h * cm[i + 1];\n" +
  "}";

// engine/easing.ts: the in-curves, then EASINGS[name] from them.
const EASE_IN: Record<string, string> = {
  quad: "return t * t;",
  cubic: "return t * t * t;",
  quart: "return t * t * t * t;",
  quint: "return t * t * t * t * t;",
  sine: "return 1 - Math.cos((t * Math.PI) / 2);",
  expo: "return t <= 0 ? 0 : Math.pow(2, 10 * (t - 1));",
  circ: "return 1 - Math.sqrt(Math.max(0, 1 - t * t));",
  back: "return (1.70158 + 1) * t * t * t - 1.70158 * t * t;",
  elastic: "if (t <= 0) return 0;\n  if (t >= 1) return 1;\n  var c4 = (2 * Math.PI) / 3;\n  return -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * c4);",
  bounce: "return 1 - tbxOutBounce(1 - t);",
};
const OUT_BOUNCE =
  "function tbxOutBounce(t) {\n" +
  "  var n1 = 7.5625;\n" +
  "  var d1 = 2.75;\n" +
  "  if (t < 1 / d1) return n1 * t * t;\n" +
  "  if (t < 2 / d1) {\n    var u = t - 1.5 / d1;\n    return n1 * u * u + 0.75;\n  }\n" +
  "  if (t < 2.5 / d1) {\n    var v = t - 2.25 / d1;\n    return n1 * v * v + 0.9375;\n  }\n" +
  "  var w = t - 2.625 / d1;\n" +
  "  return n1 * w * w + 0.984375;\n" +
  "}";

// EASINGS[name] as a function body of `t` + the in-curves it calls.
function easingBody(name: string): { body: string; uses: string[] } {
  switch (name) {
    case "linear":
      return { body: "return t;", uses: [] };
    case "step":
      return { body: "return t < 1 ? 0 : 1;", uses: [] };
    case "smoothstep":
      return { body: "return t * t * (3 - 2 * t);", uses: [] };
    case "smootherstep":
      return { body: "return t * t * t * (t * (t * 6 - 15) + 10);", uses: [] };
    case "ease-in":
      return { body: "return tbxInQuad(t);", uses: ["quad"] };
    case "ease-out":
      return { body: "return 1 - tbxInQuad(1 - t);", uses: ["quad"] };
    case "ease-in-out":
      return { body: "return t < 0.5 ? tbxInQuad(2 * t) / 2 : 1 - tbxInQuad(2 * (1 - t)) / 2;", uses: ["quad"] };
  }
  const m = /^ease-(in|out|in-out)-(cubic|quart|quint|sine|expo|circ|back|elastic|bounce)$/.exec(name);
  if (!m) return easingBody("linear");
  const f = `tbxIn${m[2][0].toUpperCase()}${m[2].slice(1)}`;
  const body = m[1] === "in" ? `return ${f}(t);` : m[1] === "out" ? `return 1 - ${f}(1 - t);` : `return t < 0.5 ? ${f}(2 * t) / 2 : 1 - ${f}(2 * (1 - t)) / 2;`;
  return { body, uses: [m[2]] };
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9]/g, "_");

// ---- the printer ----------------------------------------------------------------------------

class Printer {
  helpers = new Map<string, string>();
  constructor(
    private prog: ProcProgram,
    private opts: AeEmitOptions
  ) {}

  private need(name: string, src: string) {
    if (!this.helpers.has(name)) this.helpers.set(name, src);
  }

  private inCurve(fam: string) {
    if (fam === "bounce") this.need("tbxOutBounce", OUT_BOUNCE);
    const f = `tbxIn${fam[0].toUpperCase()}${fam.slice(1)}`;
    this.need(f, `function ${f}(t) {\n  ${EASE_IN[fam]}\n}`);
  }

  // fnImpl "ease:<name>": clamp, curve, intensity blend.
  private ease(name: string): string {
    const known = name in EASINGS ? name : "linear";
    const fn = `tbxEase_${safe(known)}`;
    if (!this.helpers.has(fn)) {
      const { body, uses } = easingBody(known);
      uses.forEach((u) => this.inCurve(u));
      this.need(`${fn}_curve`, `function ${fn}_curve(t) {\n  ${body}\n}`);
      this.need(fn, `function ${fn}(t, intensity) {\n  var tt = Math.max(0, Math.min(1, t));\n  var eased = ${fn}_curve(tt);\n  return tt + intensity * (eased - tt);\n}`);
    }
    return fn;
  }

  // fnImpl "curve:<k>": the same through custom curve k.
  private curve(k: number): string {
    const fn = `tbxCurve${k}`;
    const c = this.prog.curves[k];
    if (!c) throw new Error(`no curve ${k}`);
    this.need("tbxEvalCurve", EVAL_CURVE);
    const arr = (a: number[]) => `[${a.map(aeNumber).join(", ")}]`;
    this.need(fn, `function ${fn}(t, intensity) {\n  var tt = Math.max(0, Math.min(1, t));\n  var eased = tbxEvalCurve(${arr(c.x)}, ${arr(c.y)}, ${arr(c.m)}, tt);\n  return tt + intensity * (eased - tt);\n}`);
    return fn;
  }

  expr(e: PExpr): string {
    switch (e.k) {
      case "lit":
        return aeNumber(e.v);
      case "slot":
        return `v${e.i}`;
      case "tick":
        return "tick";
      case "bin":
        return `(${this.expr(e.a)} ${e.op} ${this.expr(e.b)})`;
      case "cmp":
        return `(${this.expr(e.a)} ${e.op} ${this.expr(e.b)} ? 1 : 0)`;
      case "neg":
        return `(-${this.expr(e.a)})`;
      case "not":
        return `(${this.expr(e.a)} ? 0 : 1)`;
      case "and":
        return `(${this.expr(e.a)} && ${this.expr(e.b)})`;
      case "or":
        return `(${this.expr(e.a)} || ${this.expr(e.b)})`;
      case "cond":
        return `(${this.expr(e.c)} ? ${this.expr(e.a)} : ${this.expr(e.b)})`;
      case "call":
        return this.call(e.fn, e.args.map((a) => this.expr(a)));
      case "track": {
        const code = this.opts.leafCode?.get(e.t);
        if (code === undefined) throw new Error("a keyframe track has no AE form here");
        return `(${code})`;
      }
      case "rand":
        if (this.opts.aeRngs?.has(e.r)) return "random()";
        this.need("tbxDraw", DRAW);
        return `tbxDraw(r${e.r} = (r${e.r} + ${MULBERRY_STEP}) | 0)`;
    }
  }

  private call(fn: string, a: string[]): string {
    if (fn in MATH_FNS || MATH_VARIADIC.has(fn)) return `Math.${fn}(${a.join(", ")})`;
    if (fn in ENV_HELPERS) {
      const name = envName(fn);
      this.need(name, ENV_SRC[fn]);
      return `${name}(${a.join(", ")})`;
    }
    if (fn.startsWith("ease:")) return `${this.ease(fn.slice(5))}(${a.join(", ")})`;
    if (fn.startsWith("curve:")) return `${this.curve(Number(fn.slice(6)))}(${a.join(", ")})`;
    switch (fn) {
      case "toNum":
        this.need("tbxToNum", TO_NUM);
        return `tbxToNum(${a[0]})`;
      case "isFinite":
        return `(Number.isFinite(${a[0]}) ? 1 : 0)`;
      case "fixed6":
        return `parseFloat((${a[0]}).toFixed(6))`;
      case "seed32":
        return `(${a[0]} ^ ((${a[1]} >>> 0) + 2654435769))`;
      case "hash01":
        this.need("tbxHash01", HASH01);
        return `tbxHash01(${a.join(", ")})`;
      case "frameOf":
        return `Math.floor(${a[0]} / ${a[1]})`;
      case "lfoPhase":
        this.need("tbxLfoPhase", LFO_PHASE);
        return `tbxLfoPhase(${a.join(", ")})`;
    }
    throw new Error(`the function ${fn} has no AE form`);
  }
}

// The expression text: header, helpers, tick, statements, `result` (the
// value AE takes, from the printed output components).
export function emitAeExpression(prog: ProcProgram, outs: PExpr[], opts: AeEmitOptions, result: (outs: string[]) => string): string {
  const pr = new Printer(prog, opts);
  const lines: string[] = [];
  prog.body.forEach((s, i) => {
    if (s.k === "let") {
      const note = s.note ? `  // ${s.note.replace(/[\r\n\u2028\u2029]+/g, " ")}` : "";
      lines.push(`var v${i} = ${pr.expr(s.e)};${note}`);
    } else if (opts.aeRngs?.has(s.r)) lines.push(`seedRandom(${pr.expr(s.seed)}, false);`);
    else lines.push(`var r${s.r} = ${pr.expr(s.seed)};`);
  });
  const value = result(outs.map((o) => pr.expr(o)));
  const off = opts.offsetTicks ? ` - ${aeNumber(opts.offsetTicks)}` : "";
  const tick = [
    `var tick = time * ${aeNumber(opts.fps)} * ${aeNumber(opts.ticksPerFrame)};`,
    `tick = (Math.abs(tick - Math.round(tick)) < 1e-6 ? Math.round(tick) : tick)${off};`,
  ];
  return [
    HEADER_MARK,
    ...opts.header.map((h) => `// ${h.replace(/[\r\n\u2028\u2029]+/g, " ")}`),
    ...pr.helpers.values(),
    ...tick,
    ...lines,
    `var tbxOut = ${value};`,
    OUT_LINE,
  ].join("\n");
}

// A compiled expression × a constant (a prop someone rescales after the
// fact: an opacity product). Undefined when `expr` isn't one of ours.
export function scaleExpression(expr: string, s: number, dims: number): string | undefined {
  if (!expr.startsWith(HEADER_MARK) || !expr.endsWith(`\n${OUT_LINE}`)) return undefined;
  const head = expr.slice(0, expr.length - OUT_LINE.length);
  const k = aeNumber(s);
  if (dims === 1) return `${head}tbxOut = tbxOut * ${k};\n${OUT_LINE}`;
  return `${head}tbxOut = [${Array.from({ length: dims }, (_, i) => `tbxOut[${i}] * ${k}`).join(", ")}];\n${OUT_LINE}`;
}
