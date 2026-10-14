// Procedural programs → SkSL functions of the tick, for `animation: "baked"`
// (specdocs/101326_skia-target.md §3.5e; emit-baked.ts bakes them like a
// track). fp32 throughout, strict ES2 (no ternary-free tricks needed: ?: is
// ES2; no round / trunc / tanh builtins, so those are written out).
//
// Transcendentals go through emit-baked's polynomials (tbk_sin / tbk_cos /
// tbk_exp2 / tbk_log2 — CanvasKit's CPU builtins are ~1e-4 off) and the
// helpers below, built only from + − × ÷ floor abs sqrt. Keyframed params
// and Animated Values are BakeGen tracks (tbk_v<k>), called at whatever
// tick the program computes for them (a wired clock's round(clock · ticks)).
//
// What can't bake (refused with the reason; export with animation
// "worklet"): integer hashing — Expression's random() and the Random node,
// whose 32-bit imul / xor / >>> have no fp32 form in ES2 — and non-finite
// constants.

import type { BakeGen } from "../emit-baked";
import type { PExpr, ProcCurve, ProcProgram } from "./ir";

// emit-baked.ts skslFloat (a JS double as an SkSL float literal), restated so
// this module and emit-baked don't import each other at runtime.
function skslFloat(x: number): string {
  if (!Number.isFinite(x)) throw new Error(`non-finite constant ${x}`);
  if (Math.abs(x) > 3.4e38) throw new Error(`constant ${x} overflows fp32`);
  if (Object.is(x, -0)) return "-0.0";
  const s = String(x);
  if (/e/i.test(s)) {
    const [m, e] = s.split(/e/i);
    return `${m.includes(".") ? m : `${m}.0`}e${e}`;
  }
  return s.includes(".") ? s : `${s}.0`;
}

const lit = (x: number): string => {
  const s = skslFloat(x);
  return s.startsWith("-") ? `(${s})` : s;
};

// Helpers this backend adds (beyond emit-baked's MATH), with their deps.
const HELPERS: Record<string, { deps: string[]; src: string }> = {
  num: { deps: [], src: `float tbk_num(float x) {\n  return abs(x) <= 3.4e38 ? x : 0.0;\n}` },
  trunc: { deps: [], src: `float tbk_trunc(float x) {\n  return x < 0.0 ? -floor(-x) : floor(x);\n}` },
  // JS a % b (truncated: the sign of a).
  rem: { deps: ["trunc"], src: `float tbk_rem(float a, float b) {\n  return a - b * tbk_trunc(a / b);\n}` },
  // JS Math.pow / **: small integer exponents by repeated products (exact
  // to rounding), negative bases by parity, the rest exp2(y · log2 |x|).
  powjs: {
    deps: ["rem"],
    src: [
      `float tbk_powjs(float x, float y) {`,
      `  if (y == 0.0) return 1.0;`,
      `  if (y == floor(y) && abs(y) <= 16.0) {`,
      `    float b = y < 0.0 ? 1.0 / x : x;`,
      `    float r = 1.0;`,
      `    for (int i = 0; i < 16; i++) {`,
      `      if (float(i) >= abs(y)) break;`,
      `      r *= b;`,
      `    }`,
      `    return r;`,
      `  }`,
      `  float ax = abs(x);`,
      `  if (ax == 0.0) return y > 0.0 ? 0.0 : 3.4e38;`,
      `  float r = tbk_exp2(y * tbk_log2(ax));`,
      `  if (x < 0.0) {`,
      `    if (y != floor(y)) return 0.0;`,
      `    if (tbk_rem(y, 2.0) != 0.0) r = -r;`,
      `  }`,
      `  return r;`,
      `}`,
    ].join("\n"),
  },
  // atan: |x| > 1 → π/2 − atan(1/x); |x| > tan(π/8) → π/4 + atan((x − 1)/(x + 1));
  // then the odd series to x^23 (|x| ≤ 0.4143: error < 1e-10).
  atan: {
    deps: [],
    src: [
      `float tbk_atan(float x) {`,
      `  float sg = x < 0.0 ? -1.0 : 1.0;`,
      `  float a = abs(x);`,
      `  bool inv = a > 1.0;`,
      `  if (inv) a = 1.0 / a;`,
      `  float off = 0.0;`,
      `  if (a > ${skslFloat(Math.SQRT2 - 1)}) {`,
      `    off = ${skslFloat(Math.PI / 4)};`,
      `    a = (a - 1.0) / (a + 1.0);`,
      `  }`,
      `  float a2 = a * a;`,
      `  float p = a * (${hornerOdd()});`,
      `  float r = off + p;`,
      `  if (inv) r = ${skslFloat(Math.PI / 2)} - r;`,
      `  return sg * r;`,
      `}`,
    ].join("\n"),
  },
  atan2: {
    deps: ["atan"],
    src: [
      `float tbk_atan2(float y, float x) {`,
      `  if (x > 0.0) return tbk_atan(y / x);`,
      `  if (x < 0.0) return y >= 0.0 ? tbk_atan(y / x) + ${skslFloat(Math.PI)} : tbk_atan(y / x) - ${skslFloat(Math.PI)};`,
      `  return y > 0.0 ? ${skslFloat(Math.PI / 2)} : y < 0.0 ? ${skslFloat(-Math.PI / 2)} : 0.0;`,
      `}`,
    ].join("\n"),
  },
  asin: { deps: ["atan2"], src: `float tbk_asin(float x) {\n  return tbk_atan2(x, sqrt(max((1.0 - x) * (1.0 + x), 0.0)));\n}` },
  acos: { deps: ["atan2"], src: `float tbk_acos(float x) {\n  return tbk_atan2(sqrt(max((1.0 - x) * (1.0 + x), 0.0)), x);\n}` },
  tan: { deps: [], src: `float tbk_tan(float x) {\n  return tbk_sin(x) / tbk_cos(x);\n}` },
  log: { deps: [], src: `float tbk_log(float x) {\n  return tbk_log2(x) * ${skslFloat(Math.LN2)};\n}` },
  log10: { deps: [], src: `float tbk_log10(float x) {\n  return tbk_log2(x) * ${skslFloat(Math.LOG10E * Math.LN2)};\n}` },
  cbrt: { deps: [], src: `float tbk_cbrt(float x) {\n  if (x == 0.0) return 0.0;\n  return sign(x) * tbk_exp2(tbk_log2(abs(x)) / 3.0);\n}` },
  sinh: { deps: [], src: `float tbk_sinh(float x) {\n  float e = tbk_exp(x);\n  return (e - 1.0 / e) * 0.5;\n}` },
  cosh: { deps: [], src: `float tbk_cosh(float x) {\n  float e = tbk_exp(x);\n  return (e + 1.0 / e) * 0.5;\n}` },
  tanh: { deps: [], src: `float tbk_tanh(float x) {\n  if (abs(x) > 10.0) return sign(x);\n  float e = tbk_exp(2.0 * x);\n  return (e - 1.0) / (e + 1.0);\n}` },
  asinh: { deps: ["log"], src: `float tbk_asinh(float x) {\n  float a = abs(x);\n  return sign(x) * tbk_log(a + sqrt(a * a + 1.0));\n}` },
  acosh: { deps: ["log"], src: `float tbk_acosh(float x) {\n  return tbk_log(x + sqrt(max((x - 1.0) * (x + 1.0), 0.0)));\n}` },
  atanh: { deps: ["log"], src: `float tbk_atanh(float x) {\n  return 0.5 * tbk_log((1.0 + x) / (1.0 - x));\n}` },
  modjs: { deps: [], src: `float tbk_modjs(float a, float b) {\n  return b == 0.0 ? 0.0 : a - floor(a / b) * b;\n}` },
  smoothstepjs: {
    deps: [],
    src: `float tbk_smoothstepjs(float e0, float e1, float x) {\n  float d = e1 - e0;\n  float k = clamp(d == 0.0 ? 0.0 : (x - e0) / d, 0.0, 1.0);\n  return k * k * (3.0 - 2.0 * k);\n}`,
  },
  and: { deps: [], src: `float tbk_and(float a, float b) {\n  return a != 0.0 ? b : a;\n}` },
  or: { deps: [], src: `float tbk_or(float a, float b) {\n  return a != 0.0 ? a : b;\n}` },
  // engine/easing.ts bases (in-shapes), transcendentals as polynomials.
  inQuad: { deps: [], src: `float tbk_inQuad(float t) {\n  return t * t;\n}` },
  inCubic: { deps: [], src: `float tbk_inCubic(float t) {\n  return t * t * t;\n}` },
  inQuart: { deps: [], src: `float tbk_inQuart(float t) {\n  return t * t * t * t;\n}` },
  inQuint: { deps: [], src: `float tbk_inQuint(float t) {\n  return t * t * t * t * t;\n}` },
  inSine: { deps: [], src: `float tbk_inSine(float t) {\n  return 1.0 - tbk_cos((t * ${skslFloat(Math.PI)}) / 2.0);\n}` },
  inExpo: { deps: [], src: `float tbk_inExpo(float t) {\n  return t <= 0.0 ? 0.0 : tbk_exp2(10.0 * (t - 1.0));\n}` },
  // (1 − t)(1 + t), not 1 − t²: exact for t near 1, where √ amplifies.
  inCirc: { deps: [], src: `float tbk_inCirc(float t) {\n  return 1.0 - sqrt(max(0.0, (1.0 - t) * (1.0 + t)));\n}` },
  inBack: { deps: [], src: `float tbk_inBack(float t) {\n  return ${skslFloat(1.70158 + 1)} * t * t * t - 1.70158 * t * t;\n}` },
  inElastic: {
    deps: [],
    src: `float tbk_inElastic(float t) {\n  if (t <= 0.0) return 0.0;\n  if (t >= 1.0) return 1.0;\n  return -tbk_exp2(10.0 * t - 10.0) * tbk_sin((t * 10.0 - 10.75) * ${skslFloat((2 * Math.PI) / 3)});\n}`,
  },
  outBounce: {
    deps: [],
    src: [
      `float tbk_outBounce(float t) {`,
      `  if (t < ${skslFloat(1 / 2.75)}) return 7.5625 * t * t;`,
      `  if (t < ${skslFloat(2 / 2.75)}) {`,
      `    float u = t - ${skslFloat(1.5 / 2.75)};`,
      `    return 7.5625 * u * u + 0.75;`,
      `  }`,
      `  if (t < ${skslFloat(2.5 / 2.75)}) {`,
      `    float u = t - ${skslFloat(2.25 / 2.75)};`,
      `    return 7.5625 * u * u + 0.9375;`,
      `  }`,
      `  float u = t - ${skslFloat(2.625 / 2.75)};`,
      `  return 7.5625 * u * u + 0.984375;`,
      `}`,
    ].join("\n"),
  },
  inBounce: { deps: ["outBounce"], src: `float tbk_inBounce(float t) {\n  return 1.0 - tbk_outBounce(1.0 - t);\n}` },
};

// 1 − a²/3 + a⁴/5 − … to a^22 (Horner in a2).
function hornerOdd(): string {
  const c = Array.from({ length: 12 }, (_, k) => (k % 2 ? -1 : 1) / (2 * k + 1));
  const h = (i: number): string => (i === c.length - 1 ? skslFloat(c[i]) : `${skslFloat(c[i])} + a2 * (${h(i + 1)})`);
  return h(0);
}

// engine/easing.ts EASINGS[name] in SkSL (+ the base it needs).
function easingSksl(name: string): { expr: (t: string) => string; base?: string } {
  switch (name) {
    case "step":
      return { expr: (t) => `(${t} < 1.0 ? 0.0 : 1.0)` };
    case "smoothstep":
      return { expr: (t) => `${t} * ${t} * (3.0 - 2.0 * ${t})` };
    case "smootherstep":
      return { expr: (t) => `${t} * ${t} * ${t} * (${t} * (${t} * 6.0 - 15.0) + 10.0)` };
    case "ease-in":
      return { expr: (t) => `tbk_inQuad(${t})`, base: "inQuad" };
    case "ease-out":
      return { expr: (t) => `1.0 - tbk_inQuad(1.0 - ${t})`, base: "inQuad" };
    case "ease-in-out":
      return { expr: (t) => `(${t} < 0.5 ? tbk_inQuad(2.0 * ${t}) / 2.0 : 1.0 - tbk_inQuad(2.0 * (1.0 - ${t})) / 2.0)`, base: "inQuad" };
  }
  const m = /^ease-(in|out|in-out)-(cubic|quart|quint|sine|expo|circ|back|elastic|bounce)$/.exec(name);
  if (m) {
    const base = `in${m[2][0].toUpperCase()}${m[2].slice(1)}`;
    const f = `tbk_${base}`;
    const expr =
      m[1] === "in"
        ? (t: string) => `${f}(${t})`
        : m[1] === "out"
          ? (t: string) => `1.0 - ${f}(1.0 - ${t})`
          : (t: string) => `(${t} < 0.5 ? ${f}(2.0 * ${t}) / 2.0 : 1.0 - ${f}(2.0 * (1.0 - ${t})) / 2.0)`;
    return { expr, base };
  }
  return { expr: (t) => t };
}

// Per-BakeGen state: helpers already appended, function counter.
const STATE = new WeakMap<BakeGen, { helpers: Set<string>; n: number; eases: Set<string>; curves: Map<string, string> }>();
function stateOf(gen: BakeGen) {
  let s = STATE.get(gen);
  if (!s) STATE.set(gen, (s = { helpers: new Set(), n: 0, eases: new Set(), curves: new Map() }));
  return s;
}

function need(gen: BakeGen, id: string): void {
  const st = stateOf(gen);
  if (st.helpers.has(id)) return;
  const h = HELPERS[id];
  for (const d of h.deps) need(gen, d);
  st.helpers.add(id);
  // emit-baked's MATH block (tbk_sin / cos / exp / exp2 / log2 / pow).
  if (/\btbk_(sin|cos|exp2?|log2|pow)\(/.test(h.src)) gen.helpers.add("math");
  gen.fns.push(h.src);
}

function easeFn(gen: BakeGen, name: string): string {
  const st = stateOf(gen);
  const id = name.replace(/[^A-Za-z0-9]/g, "_");
  const fn = `tbk_ease_${id}`;
  if (st.eases.has(name)) return fn;
  const e = easingSksl(name);
  if (e.base) need(gen, e.base);
  gen.helpers.add("math");
  st.eases.add(name);
  gen.fns.push(`// engine/easing.ts applyEasing("${name}", t, intensity)\nfloat ${fn}(float t, float intensity) {\n  float tt = clamp(t, 0.0, 1.0);\n  float eased = ${e.expr("tt")};\n  return tt + intensity * (eased - tt);\n}`);
  return fn;
}

// A custom easing curve: the monotone cubic unrolled over its segments, then
// the intensity blend.
function curveFn(gen: BakeGen, c: ProcCurve): string {
  const st = stateOf(gen);
  const key = JSON.stringify(c);
  const hit = st.curves.get(key);
  if (hit) return hit;
  const fn = `tbk_curve${st.curves.size}`;
  st.curves.set(key, fn);
  const n = c.x.length;
  const lines: string[] = [`float ${fn}(float t, float intensity) {`, `  float x = clamp(t, 0.0, 1.0);`, `  float eased;`];
  if (n === 0) lines.push(`  eased = 0.0;`);
  else if (n === 1) lines.push(`  eased = ${lit(c.y[0])};`);
  else {
    lines.push(`  if (x <= ${lit(c.x[0])}) eased = ${lit(c.y[0])};`, `  else if (x >= ${lit(c.x[n - 1])}) eased = ${lit(c.y[n - 1])};`);
    for (let i = 0; i < n - 1; i++) {
      const h = c.x[i + 1] - c.x[i];
      const body =
        h === 0
          ? `eased = ${lit(c.y[i])};`
          : `{ float u = (x - ${lit(c.x[i])}) / ${lit(h)}; float u2 = u * u; float u3 = u2 * u; ` +
            `eased = (2.0 * u3 - 3.0 * u2 + 1.0) * ${lit(c.y[i])} + (u3 - 2.0 * u2 + u) * ${lit(h * c.m[i])} + (-2.0 * u3 + 3.0 * u2) * ${lit(c.y[i + 1])} + (u3 - u2) * ${lit(h * c.m[i + 1])}; }`;
      lines.push(`  else if (x <= ${lit(c.x[i + 1])}) ${body}`);
    }
    lines.push(`  else eased = ${lit(c.y[n - 1])};`);
  }
  lines.push(`  return x + intensity * (eased - x);`, `}`);
  gen.fns.push(`// engine/float-curve.ts evalMonotoneCubic (custom easing curve), then applyEasingOrCurve's blend.\n${lines.join("\n")}`);
  return fn;
}

class Refuse extends Error {}

// Bake one program as `float tbk_p<k>(float tk)`. Null (and a problem on
// `gen`) when it can't.
export function bakeProcedural(gen: BakeGen, prog: ProcProgram, label: string): { fn: string } | null {
  const st = stateOf(gen);
  const trackFns = new Map<number, string>();
  const p = (e: PExpr): string => {
    switch (e.k) {
      case "lit":
        if (!Number.isFinite(e.v)) throw new Refuse(`a non-finite constant (${e.v})`);
        return lit(e.v);
      case "slot":
        return `s${e.i}`;
      case "tick":
        return "tk";
      case "bin":
        if (e.op === "%") {
          need(gen, "rem");
          return `tbk_rem(${p(e.a)}, ${p(e.b)})`;
        }
        if (e.op === "**") {
          need(gen, "powjs");
          return `tbk_powjs(${p(e.a)}, ${p(e.b)})`;
        }
        return `(${p(e.a)} ${e.op} ${p(e.b)})`;
      case "cmp":
        return `(${p(e.a)} ${e.op} ${p(e.b)} ? 1.0 : 0.0)`;
      case "neg":
        return `(-${p(e.a)})`;
      case "not":
        return `(${p(e.a)} != 0.0 ? 0.0 : 1.0)`;
      case "and":
      case "or":
        need(gen, e.k);
        return `tbk_${e.k}(${p(e.a)}, ${p(e.b)})`;
      case "cond":
        return `(${p(e.c)} != 0.0 ? ${p(e.a)} : ${p(e.b)})`;
      case "track": {
        let fn = trackFns.get(e.t);
        if (!fn) {
          const r = gen.track(prog.tracks[e.t], `${label} — keyframes ${e.t}`);
          if (!r) throw new Refuse("a keyframe track that doesn't bake (above)");
          if (r.width !== 1) throw new Refuse("a color track inside a driver");
          fn = r.fn;
          trackFns.set(e.t, fn);
        }
        return `${fn}(${p(e.at)})`;
      }
      case "rand":
        throw new Refuse("Expression random() (mulberry32's 32-bit integer math has no fp32 SkSL form)");
      case "call":
        return callSksl(e, p);
    }
  };
  const callSksl = (e: Extract<PExpr, { k: "call" }>, pr: (x: PExpr) => string): string => {
    const f = e.fn;
    const a = e.args.map(pr);
    const unary = (fn: string, helper?: string) => {
      if (helper) need(gen, helper);
      return `${fn}(${a[0]})`;
    };
    if (f.startsWith("ease:")) return `${easeFn(gen, f.slice(5))}(${a[0]}, ${a[1]})`;
    if (f.startsWith("curve:")) return `${curveFn(gen, prog.curves[Number(f.slice(6))])}(${a[0]}, ${a[1]})`;
    switch (f) {
      case "abs":
      case "floor":
      case "ceil":
      case "sign":
      case "sqrt":
        return `${f}(${a[0]})`;
      case "fround":
        return a[0];
      case "toNum":
        // expression.ts toNum: a non-finite result reads 0. ES2 has no isinf /
        // isnan: NaN fails the comparison, ±Inf the bound.
        need(gen, "num");
        return `tbk_num(${a[0]})`;
      case "isFinite":
        return `(abs(${a[0]}) <= 3.4e38 ? 1.0 : 0.0)`;
      case "fixed6":
        // toFixed(6) moves a value by ≤ 5e-7 — below fp32's resolution above 8.
        return a[0];
      case "round":
        return `floor(${a[0]} + 0.5)`;
      case "trunc":
        return unary("tbk_trunc", "trunc");
      case "sin":
      case "cos":
        gen.helpers.add("math");
        return `tbk_${f}(${a[0]})`;
      case "exp":
      case "log2":
        gen.helpers.add("math");
        return `tbk_${f}(${a[0]})`;
      case "tan":
      case "log":
      case "log10":
      case "cbrt":
      case "sinh":
      case "cosh":
      case "tanh":
      case "asinh":
      case "acosh":
      case "atanh":
      case "atan":
      case "asin":
      case "acos":
        return unary(`tbk_${f}`, f);
      case "expm1":
        gen.helpers.add("math");
        return `(tbk_exp(${a[0]}) - 1.0)`;
      case "log1p":
        need(gen, "log");
        return `tbk_log(1.0 + ${a[0]})`;
      case "pow":
        need(gen, "powjs");
        return `tbk_powjs(${a[0]}, ${a[1]})`;
      case "atan2":
        need(gen, "atan2");
        return `tbk_atan2(${a[0]}, ${a[1]})`;
      case "min":
      case "max":
        if (!a.length) throw new Refuse(`Math.${f}() with no arguments (±Infinity)`);
        return a.reduceRight((acc, x) => `${f}(${x}, ${acc})`);
      case "hypot":
        return a.length ? `sqrt(${a.map((x) => `${x} * ${x}`).join(" + ")})` : "0.0";
      case "mod":
        need(gen, "modjs");
        return `tbk_modjs(${a[0]}, ${a[1]})`;
      case "fract":
        return `(${a[0]} - floor(${a[0]}))`;
      case "clamp":
        return `min(max(${a[0]}, ${a[1]}), ${a[2]})`;
      case "saturate":
        return `min(max(${a[0]}, 0.0), 1.0)`;
      case "lerp":
      case "mix":
        return `(${a[0]} + (${a[1]} - ${a[0]}) * ${a[2]})`;
      case "step":
        return `(${a[1]} < ${a[0]} ? 0.0 : 1.0)`;
      case "smoothstep":
        need(gen, "smoothstepjs");
        return `tbk_smoothstepjs(${a[0]}, ${a[1]}, ${a[2]})`;
      case "frameOf":
        // floor(tick / ticksPerFrame); the bias keeps an exact frame tick from
        // flooring a frame low when the division rounds down in fp32.
        return `floor(${a[0]} / ${a[1]} + 1e-4)`;
      case "lfoPhase":
        return lfoPhase(e.args, a);
      case "seed32":
      case "hash01":
        throw new Refuse(`${f === "hash01" ? "the Random node" : "Expression random()"} (32-bit integer hashing has no fp32 SkSL form)`);
    }
    throw new Refuse(`${f}, which has no SkSL form`);
  };
  // lfo.ts's phase on the playhead, (tick / tps) · f + phase. In fp32 the
  // product would round at ulp(t · f) — 2.4e-7 of a cycle once two cycles
  // have passed, 1.5e-6 on a sine. With a constant frequency the tick is
  // reduced first: M = the period rounded to whole ticks, tick = q · M + r
  // (integers below 2^24: exact), and since M · K = 1 + ε (K = f / tps,
  // ε computed in double), phase = fract(r · K + q · ε + phase) — r · K
  // stays below one cycle, q · ε is tiny, so the phase keeps fp32's
  // resolution at 10 s as at 0.
  const lfoPhase = (args: PExpr[], a: string[]): string => {
    const [, tps, f] = args;
    need(gen, "rem");
    if (tps.k === "lit" && f.k === "lit" && f.v !== 0) {
      const K = f.v / tps.v;
      const M = Math.round(Math.abs(1 / K));
      if (M >= 1 && M < 16_777_216) {
        const eps = M * K - Math.sign(K);
        const r = `tbk_rem(${a[0]}, ${lit(M)})`;
        const q = `((${a[0]} - ${r}) / ${lit(M)})`;
        return `tbk_fract1(${r} * ${lit(K)}${eps === 0 ? "" : ` + floor(${q} + 0.5) * ${lit(eps)}`} + ${a[3]})`;
      }
    }
    return `tbk_fract1((${a[0]} / ${a[1]}) * ${a[2]} + ${a[3]})`;
  };
  try {
    const lines: string[] = [];
    prog.body.forEach((s, i) => {
      if (s.k === "rng") throw new Refuse("Expression random() (mulberry32's 32-bit integer math has no fp32 SkSL form)");
      lines.push(`  float s${i} = ${p(s.e)};${s.note ? ` // ${s.note.replace(/\n/g, " ").replace(/\*\//g, "* /")}` : ""}`);
    });
    const ret = p(prog.out);
    if (lines.some((l) => l.includes("tbk_fract1(")) || ret.includes("tbk_fract1(")) {
      if (!st.helpers.has("fract1")) {
        st.helpers.add("fract1");
        need(gen, "rem");
        // ((raw % 1) + 1) % 1, JS order.
        gen.fns.push(`float tbk_fract1(float raw) {\n  return tbk_rem(tbk_rem(raw, 1.0) + 1.0, 1.0);\n}`);
      }
    }
    const fn = `tbk_p${st.n++}`;
    gen.fns.push(`// ${label.replace(/\n/g, " ")} — procedural (${prog.nodes.map((n) => `${n.type} ${n.id}`).join(", ")})\nfloat ${fn}(float tk) {\n${lines.join("\n")}${lines.length ? "\n" : ""}  return ${ret};\n}`);
    return { fn };
  } catch (e) {
    if (e instanceof Refuse) {
      gen.problems.push(`${label}: ${e.message} — export with animation "worklet".`);
      return null;
    }
    throw e;
  }
}
