// emit-baked — `animation: "baked"`: the timeline compiled INTO the SkSL
// (specdocs/101326_skia-target.md §3.5b, M3 lane A).
//
// Every runtime-program uniform the planner resolved to a TRACK (or a
// per-frame SAMPLED series, or a compiled procedural driver) becomes SkSL
// evaluated from `iTime`, so the
// program needs no per-frame uniforms: the component only drives iTime from
// the master clock. Static uniforms stay uniforms. What can't live in a
// shader (a scene's transforms, path data, paint colors, gradient stops —
// anything outside a runtime program's uniforms) stays on the worklet
// timeline, and the manifest says which.
//
// What a baked uniform becomes, per program:
//
//   uniform float scale;   →  float scale;                 (a mutable global)
//   half4 main(float2 p)   →  half4 tbk_main(float2 p)     (the program's own)
//   + appended:
//     float tbk_tick(float s)          seconds → toolbox tick (fp32, snapped)
//     float tbk_v0(float tk) { … }     one function per track: the keys as
//                                      constants, an if-tree over segments,
//                                      presets as closed forms, cubicBezier /
//                                      customBezier via 8 Newton + 32
//                                      bisection steps (constant bounds),
//                                      spring (spring.ts springSksl, as
//                                      tbk_spring), hold, OKLab / RGB lerp,
//                                      quantize8 / quantizeAlpha, BindRef scale
//     float tbk_p0(float tk) { … }     one per procedural driver (an
//                                      Expression / LFO / Math / Scene Time
//                                      subgraph, procedural/emit-sksl.ts —
//                                      lane P, spec §3.5e), its keyframed
//                                      params as tbk_v tracks
//     void tbk_s0(float fr) { … }      one per sampled series: an unrolled
//                                      binary search over its kept frames
//                                      (ES2 has no const-array initialisers),
//                                      linear between frames
//     void tbk_bake() { … }            assigns every baked global
//     half4 main(float2 p) { tbk_bake(); return tbk_main(p); }
//
// The constants are the worklet runtime's own doubles: the value at every key
// (and every clamp / hold) is evaluateTrack() itself, OKLab key coordinates
// and segment deltas are precomputed in double. Only the interpolation runs
// in fp32 — check:skia-baked measures what that costs (per value and per
// pixel) against the worklet path. sin / cos / exp / exp2 / pow are
// polynomials over + − × ÷ floor (MATH below), not Skia's builtins, which
// its CPU backend approximates to ~1e-4 and every GPU driver does its own way.
//
// Time. iTime arrives as fp32 seconds. tick = iTime · fps · ticksPerFrame,
// snapped to the nearest integer tick within 1e-6 + 2.5e-7·tick (the fp32
// error of that product is ≤ 1.2e-7·tick), so frame-aligned clocks land on
// exact ticks and hold keys / segment boundaries resolve as in the editor.
// Integer ticks are exact in fp32 below 2^24 (279.6 s at 60 fps × 1000):
// longer scenes refuse.
//
// Color. A baked color is an sRGB number the shader computes — exactly what
// a color uniform is in every toolbox program (they are plain float4, never
// layout(color)). The program's own main, now tbk_main, still converts its
// sRGB result to the canvas's working space at the boundary
// (engine/skia/library/color-management.ts), so a baked color is the same
// color on sRGB and Display P3 canvases.
//
// Cost. Every pixel evaluates the clock and every baked function, but the
// branches are uniform (all from iTime), so a GPU runs one segment per track
// and one leaf per series (Skia's CPU backend runs every branch). A baked
// sampled ARRAY uniform (a ramp's stops) becomes a per-pixel global array.
//
// Deterministic: the SkSL depends only on the plan (track data, series,
// program text). Strict ES2: no array initialisers, no dynamic indexing,
// constant loop bounds, floor() for rounding.

import { NO_EXPORT_SEGMENTS, type ExportSegments } from "./segments";
import { rgbToOklab } from "@/engine/color-space";
import type { Bind, SkiaScene, SkslProgramIR } from "@/engine/skia/scene-ir";
import { emitSkiaBundle } from "./emit";
import { timelineConstSource } from "./emit-shared";
import type { SkiaExportPlan } from "./plan";
import { evaluateTrack, type TimelineSpring, type TimelineTrack } from "./runtime/toolbox-timeline";
import { compress, emitSceneBundle } from "./scene-emit";
import { collectBinds, isBind, type BindValue, type PlannedBind, type ScenePlan } from "./scene-plan";
import { springSksl, springSkslArgs } from "./spring";
import { bakeProcedural } from "./procedural/emit-sksl";
import type { ProcProgram } from "./procedural/ir";

// ---- limits ------------------------------------------------------------------------

export const BAKED_LIMITS = {
  // fp32 holds every integer tick exactly up to 2^24.
  maxTicks: 16_777_216,
  // Keys per baked track (code size: one branch per segment).
  trackKeys: 1024,
  // Kept frames per baked sampled series (after run compression).
  seriesFrames: 1024,
  // Float literals the sampled series of ONE program may emit (each kept
  // frame × each changing component × 2). Bounds program size and
  // CanvasKit compile time.
  seriesLiterals: 16_384,
} as const;

// "procedural": a compiled driver subgraph (procedural/emit-sksl.ts, spec §3.5e).
export type BakedKind = "track" | "sampled" | "procedural";

export interface BakedUniformInfo {
  name: string;
  kind: BakedKind;
  from: string;
  // SkSL type of the global that replaced the uniform.
  type: string;
  // Keys (track) or kept frames (sampled).
  points: number;
  // A color track (straight sRGB, like every program color — see the color
  // note above). Sampled series report false.
  color: boolean;
  // Scene exports: the bind ids the uniform had.
  bind?: string;
  path?: string;
}

export interface BakedProgramInfo {
  // Scene: the IR path of the program; effect: "effect".
  where: string;
  baked: BakedUniformInfo[];
  // Uniforms the program still declares (the component supplies them).
  uniforms: string[];
  // The program declared no iTime; baking added it (driven by the clock).
  addedTime?: boolean;
}

// ---- SkSL literals --------------------------------------------------------------------

// A JS double as an SkSL float literal (SkSL parses it to the nearest
// double, then rounds to fp32 — the same value Float32Array upload gives).
export function skslFloat(x: number): string {
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

// Negative literals parenthesised, for `a + (-0.5) * t`.
function lit(x: number): string {
  const s = skslFloat(x);
  return s.startsWith("-") ? `(${s})` : s;
}

function vecLit(xs: number[]): string {
  return xs.length === 1 ? lit(xs[0]) : `float${xs.length}(${xs.map(skslFloat).join(", ")})`;
}

// ---- shared helpers (emitted once per program, when used) ---------------------------------

function factorial(n: number): number {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}

// c0 + x·(c1 + x·(c2 + …)), as SkSL.
function horner(x: string, c: number[]): string {
  return c.length === 1 ? skslFloat(c[0]) : `${skslFloat(c[0])} + ${x} * (${horner(x, c.slice(1))})`;
}

// The transcendentals are written out instead of calling sin / cos / exp2 /
// pow: Skia's CPU backend approximates those to ~1e-4 (measured in
// CanvasKit 0.41.0: sin 1.9e-4 abs, exp2 5.7e-5 rel, pow 9.6e-5 rel) and GPU
// drivers each have their own. These use only + − × ÷ floor abs, so every
// IEEE fp32 target computes (nearly) the same bits, within ~1e-7 of the
// double the worklet computes.
const MATH = [
  `// 2^x, |x| ≤ 30: x = n + f, n = floor(x + 0.5); e^(f·ln 2) to degree 7`,
  `// (error < 6e-9), 2^n by exact halvings / doublings.`,
  `float tbk_exp2(float x) {`,
  `  float n = floor(x + 0.5);`,
  `  float f = (x - n) * ${skslFloat(Math.LN2)};`,
  `  float p = ${horner("f", [0, 1, 2, 3, 4, 5, 6, 7].map((k) => 1 / factorial(k)))};`,
  `  float s = 1.0;`,
  `  for (int i = 0; i < 30; i++) {`,
  `    if (float(i) >= abs(n)) break;`,
  `    s *= n < 0.0 ? 0.5 : 2.0;`,
  `  }`,
  `  return p * s;`,
  `}`,
  ``,
  `// log2(x), x > 0: x = m · 2^e, m ∈ [√½, √2] by exact halvings / doublings;`,
  `// ln m = 2·atanh(s), s = (m − 1) / (m + 1), to s^9 (error < 1e-9).`,
  `float tbk_log2(float x) {`,
  `  float m = x;`,
  `  float e = 0.0;`,
  `  for (int i = 0; i < 64; i++) {`,
  `    if (m >= ${skslFloat(Math.SQRT1_2)}) break;`,
  `    m *= 2.0;`,
  `    e -= 1.0;`,
  `  }`,
  `  for (int i = 0; i < 64; i++) {`,
  `    if (m <= ${skslFloat(Math.SQRT2)}) break;`,
  `    m *= 0.5;`,
  `    e += 1.0;`,
  `  }`,
  `  float s = (m - 1.0) / (m + 1.0);`,
  `  float s2 = s * s;`,
  `  float l = 2.0 * s * (1.0 + s2 * (${skslFloat(1 / 3)} + s2 * (0.2 + s2 * (${skslFloat(1 / 7)} + s2 * ${skslFloat(1 / 9)}))));`,
  `  return e + l * ${skslFloat(Math.LOG2E)};`,
  `}`,
  ``,
  `float tbk_exp(float x) {`,
  `  return tbk_exp2(x * ${skslFloat(Math.LOG2E)});`,
  `}`,
  ``,
  `float tbk_pow(float x, float y) {`,
  `  return tbk_exp2(y * tbk_log2(x));`,
  `}`,
  ``,
  `// sin / cos: x − 2πk (k = round(x / 2π); 2π split so k · hi is exact), folded`,
  `// into [−π/2, π/2], then Taylor to degree 13 / 12 (error < 1e-8).`,
  `float tbk_sin(float x) {`,
  `  float k = floor(x * ${skslFloat(1 / (2 * Math.PI))} + 0.5);`,
  `  float r = x - k * 6.28125 - k * ${skslFloat(2 * Math.PI - 6.28125)};`,
  `  if (r > ${skslFloat(Math.PI / 2)}) r = ${skslFloat(Math.PI)} - r;`,
  `  if (r < ${skslFloat(-Math.PI / 2)}) r = ${skslFloat(-Math.PI)} - r;`,
  `  float r2 = r * r;`,
  `  return r * (${horner("r2", [1, 3, 5, 7, 9, 11, 13].map((k, i) => (i % 2 ? -1 : 1) / factorial(k)))});`,
  `}`,
  ``,
  `float tbk_cos(float x) {`,
  `  float k = floor(x * ${skslFloat(1 / (2 * Math.PI))} + 0.5);`,
  `  float r = abs(x - k * 6.28125 - k * ${skslFloat(2 * Math.PI - 6.28125)});`,
  `  float sg = 1.0;`,
  `  if (r > ${skslFloat(Math.PI / 2)}) {`,
  `    r = ${skslFloat(Math.PI)} - r;`,
  `    sg = -1.0;`,
  `  }`,
  `  float r2 = r * r;`,
  `  return sg * (${horner("r2", [0, 2, 4, 6, 8, 10, 12].map((k, i) => (i % 2 ? -1 : 1) / factorial(k)))});`,
  `}`,
].join("\n");


// Lane C's spring (spring.ts springSksl: Reanimated 4.7's withSpring from
// rest, normalised to the segment), renamed into the tbk_ namespace and with
// its exp / sin / cos routed to the polynomials above (the arithmetic is
// otherwise verbatim; check:skia-baked bounds it against springSkslReference).
const SPRING = springSksl
  .replace(/\btbx_spring\b/g, "tbk_spring")
  .replace(/(?<![\w.])(exp|sin|cos)\s*\(/g, (_m, f: string) => `tbk_${f}(`)
  .trimEnd();

export const BAKED_HELPERS = {
  math: MATH,
  spring: SPRING,
  bezier: [
    `// x(u) = x for the CSS-style curve (0, x1, x2, 1): 8 Newton steps, then 32`,
    `// bisection steps — toolbox-timeline.ts solveBezierX, line for line.`,
    `float tbk_bez_x(float x1, float x2, float x) {`,
    `  if (x <= 0.0) return 0.0;`,
    `  if (x >= 1.0) return 1.0;`,
    `  float u = x;`,
    `  for (int i = 0; i < 8; i++) {`,
    `    float bez = 3.0 * (1.0 - u) * (1.0 - u) * u * x1 + 3.0 * (1.0 - u) * u * u * x2 + u * u * u;`,
    `    float err = bez - x;`,
    `    if (abs(err) < 1e-7) return u;`,
    `    float d = 3.0 * (1.0 - u) * (1.0 - u) * x1 + 6.0 * (1.0 - u) * u * (x2 - x1) + 3.0 * u * u * (1.0 - x2);`,
    `    if (d < 1e-6) break;`,
    `    u = clamp(u - err / d, 0.0, 1.0);`,
    `  }`,
    `  float lo = 0.0;`,
    `  float hi = 1.0;`,
    `  for (int i = 0; i < 32; i++) {`,
    `    u = (lo + hi) / 2.0;`,
    `    float bez = 3.0 * (1.0 - u) * (1.0 - u) * u * x1 + 3.0 * (1.0 - u) * u * u * x2 + u * u * u;`,
    `    if (bez < x) lo = u;`,
    `    else hi = u;`,
    `  }`,
    `  return (lo + hi) / 2.0;`,
    `}`,
    ``,
    `// cubicBezierEase: a normalized time remap (x1 / x2 already clamped).`,
    `float tbk_cubic(float t, float x1, float y1, float x2, float y2) {`,
    `  if (t <= 0.0) return 0.0;`,
    `  if (t >= 1.0) return 1.0;`,
    `  float u = tbk_bez_x(x1, x2, t);`,
    `  float o = 1.0 - u;`,
    `  return 3.0 * o * o * u * y1 + 3.0 * o * u * u * y2 + u * u * u;`,
    `}`,
  ].join("\n"),
  oklab: [
    `float tbk_l2s(float c) {`,
    `  return c <= 0.0031308 ? c * 12.92 : 1.055 * tbk_pow(c, ${skslFloat(1 / 2.4)}) - 0.055;`,
    `}`,
    ``,
    `// OKLab → gamma sRGB (engine/color-space.ts oklabToRgb).`,
    `float3 tbk_oklab_srgb(float3 lab) {`,
    `  float l_ = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;`,
    `  float m_ = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;`,
    `  float s_ = lab.x - 0.0894841775 * lab.y - 1.291485548 * lab.z;`,
    `  float l = l_ * l_ * l_;`,
    `  float m = m_ * m_ * m_;`,
    `  float s = s_ * s_ * s_;`,
    `  return float3(`,
    `    tbk_l2s(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),`,
    `    tbk_l2s(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),`,
    `    tbk_l2s(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s));`,
    `}`,
  ].join("\n"),
  q8: [
    `// 8 bits per channel, as the hex round trip (Math.round → floor(x + 0.5)).`,
    `float4 tbk_q8(float4 v) {`,
    `  return clamp(floor(v * 255.0 + 0.5), 0.0, 255.0) / 255.0;`,
    `}`,
  ].join("\n"),
} as const;

type HelperId = keyof typeof BAKED_HELPERS;
const HELPER_ORDER: HelperId[] = ["math", "spring", "bezier", "oklab", "q8"];

// ---- easing closed forms --------------------------------------------------------------------

const KNOWN_PRESETS = new Set([
  "linear",
  "easeInSine",
  "easeOutSine",
  "easeInOutSine",
  "easeIn",
  "easeInQuad",
  "easeOut",
  "easeOutQuad",
  "easeInOut",
  "easeInOutQuad",
  "easeInCubic",
  "easeOutCubic",
  "easeInOutCubic",
  "easeInExpo",
  "easeOutExpo",
  "easeInBack",
  "easeOutBack",
  "easeOutBounce",
  "easeOutElastic",
  "hold",
  "customBezier",
  "cubicBezier",
  "spring",
]);

// `float t = <eased u>;` for one preset — toolbox-timeline.ts easeOf, with
// integer powers as products and the transcendentals as tbk_ polynomials
// (MATH above).
function easeLines(preset: string): string[] {
  const HALF_PI = lit(Math.PI / 2);
  const PI = lit(Math.PI);
  const c1 = 1.70158;
  const c3 = c1 + 1;
  switch (preset) {
    case "easeInSine":
      return [`float t = 1.0 - tbk_cos(u * ${HALF_PI});`];
    case "easeOutSine":
      return [`float t = tbk_sin(u * ${HALF_PI});`];
    case "easeInOutSine":
      return [`float t = -(tbk_cos(${PI} * u) - 1.0) / 2.0;`];
    case "easeIn":
    case "easeInQuad":
      return [`float t = u * u;`];
    case "easeOut":
    case "easeOutQuad":
      return [`float t = 1.0 - (1.0 - u) * (1.0 - u);`];
    case "easeInOut":
    case "easeInOutQuad":
      return [`float q = -2.0 * u + 2.0;`, `float t = u < 0.5 ? 2.0 * u * u : 1.0 - (q * q) / 2.0;`];
    case "easeInCubic":
      return [`float t = u * u * u;`];
    case "easeOutCubic":
      return [`float i = 1.0 - u;`, `float t = 1.0 - i * i * i;`];
    case "easeInOutCubic":
      return [`float q = -2.0 * u + 2.0;`, `float t = u < 0.5 ? 4.0 * u * u * u : 1.0 - (q * q * q) / 2.0;`];
    case "easeInExpo":
      return [`float t = u == 0.0 ? 0.0 : tbk_exp2(10.0 * u - 10.0);`];
    case "easeOutExpo":
      return [`float t = u == 1.0 ? 1.0 : 1.0 - tbk_exp2(-10.0 * u);`];
    case "easeInBack":
      return [`float t = ${lit(c3)} * u * u * u - ${lit(c1)} * u * u;`];
    case "easeOutBack":
      return [`float i = u - 1.0;`, `float t = 1.0 + ${lit(c3)} * i * i * i + ${lit(c1)} * i * i;`];
    case "easeOutBounce": {
      const n1 = 7.5625;
      const d1 = 2.75;
      return [
        `float t;`,
        `if (u < ${lit(1 / d1)}) {`,
        `  t = ${lit(n1)} * u * u;`,
        `} else if (u < ${lit(2 / d1)}) {`,
        `  float x = u - ${lit(1.5 / d1)};`,
        `  t = ${lit(n1)} * x * x + 0.75;`,
        `} else if (u < ${lit(2.5 / d1)}) {`,
        `  float x = u - ${lit(2.25 / d1)};`,
        `  t = ${lit(n1)} * x * x + 0.9375;`,
        `} else {`,
        `  float x = u - ${lit(2.625 / d1)};`,
        `  t = ${lit(n1)} * x * x + 0.984375;`,
        `}`,
      ];
    }
    case "easeOutElastic":
      return [`float t = u == 0.0 ? 0.0 : u == 1.0 ? 1.0 : tbk_exp2(-10.0 * u) * tbk_sin((u * 10.0 - 0.75) * ${lit((Math.PI * 2) / 3)}) + 1.0;`];
    default:
      // linear, customBezier on a color track (a time remap only applies to
      // scalars), and names this build doesn't know (the runtime's easeOf
      // falls back to linear too).
      return [`float t = u;`];
  }
}

// A spring key's (ζ, Ω, rest) exactly as the worklet runtime's springEase
// reads them: spring.ts springSkslArgs (the clamps), with the key's own
// precomputed rest time when it carries one.
function springArgsOf(s: TimelineSpring | undefined): { zeta: number; omega: number; rest: number } {
  const a = springSkslArgs(s);
  if (!s || typeof s.rest !== "number" || s.rest === a.rest) return a;
  return { zeta: a.zeta, omega: (a.omega / a.rest) * s.rest, rest: s.rest };
}

// ---- the generator --------------------------------------------------------------------------

// Where a baked value lands: a mutable global (vector / array element).
export interface BakeTarget {
  name: string;
  // Element type: float, float2..4, int.
  type: string;
  width: number;
  // Array length (uniform arrays).
  count?: number;
}

function lvalue(t: BakeTarget, c: number): string {
  const e = t.count !== undefined ? `${t.name}[${Math.floor(c / t.width)}]` : t.name;
  return t.width > 1 ? `${e}.${"xyzw"[c % t.width]}` : e;
}

function indent(lines: string[], by: string): string[] {
  return lines.map((l) => (l ? by + l : l));
}

export class BakeGen {
  readonly helpers = new Set<HelperId>();
  readonly fns: string[] = [];
  readonly problems: string[] = [];
  readonly warnings: string[] = [];
  private nTrack = 0;
  private nSeries = 0;
  seriesLiterals = 0;

  constructor(readonly timeline: { fps: number; ticksPerFrame: number }) {}

  // SkSL for `float tbk_tick(float s)`.
  tickSource(): string {
    const k = this.timeline.fps * this.timeline.ticksPerFrame;
    return [
      `// Seconds → toolbox tick (ticksAt). fp32: frame-aligned clocks snap to their`,
      `// exact integer tick (the product's error is ≤ 1.2e-7 · tick).`,
      `float tbk_tick(float s) {`,
      `  float tk = s * ${lit(k)};`,
      `  float r = floor(tk + 0.5);`,
      `  return abs(tk - r) < 1e-6 + 2.5e-7 * abs(tk) ? r : tk;`,
      `}`,
    ].join("\n");
  }

  // One track as `<float|float4> tbk_v<k>(float tk)`. Null (and a problem)
  // when it can't bake.
  track(track: TimelineTrack, label: string): { fn: string; width: number } | null {
    const keys = track.keys;
    const color = track.kind === "color";
    const bad = (why: string) => {
      this.problems.push(`${label}: ${why}`);
      return null;
    };
    if (!keys.length) return bad("the track has no keys.");
    if (keys.length > BAKED_LIMITS.trackKeys) return bad(`${keys.length} keys — baked tracks are capped at ${BAKED_LIMITS.trackKeys}; export with animation "worklet".`);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (!Number.isFinite(k.tick)) return bad(`key ${i} has a non-finite tick.`);
      if (i && k.tick < keys[i - 1].tick) return bad(`keys are out of tick order at key ${i}.`);
      if (Math.abs(k.tick) >= BAKED_LIMITS.maxTicks) return bad(`key ${i} sits at tick ${k.tick}, past fp32's exact-integer range (2^24 ticks).`);
      const v = k.value;
      const ok = color
        ? Array.isArray(v) && v.length >= 4 && v.slice(0, 4).every((x) => typeof x === "number" && Number.isFinite(x))
        : typeof v === "number" && Number.isFinite(v);
      if (!ok) return bad(`key ${i} holds ${JSON.stringify(v)}, not a ${color ? "4-component color" : "finite number"}.`);
      if (!KNOWN_PRESETS.has(k.easing) && i < keys.length - 1) {
        this.warnings.push(`${label}: key ${i} uses an easing this build doesn't know ("${k.easing}") — baked as linear, as the worklet runtime plays it.`);
      }
    }
    if (track.kind === "scalar" && track.scale !== undefined && !Number.isFinite(track.scale)) return bad("the track's scale is not finite.");

    const name = `tbk_v${this.nTrack++}`;
    const type = color ? "float4" : "float";
    // The worklet's own value at a tick: every constant the function returns.
    const at = (tick: number): string => {
      const v = evaluateTrack(track, tick);
      return Array.isArray(v) ? vecLit(v.slice(0, 4)) : lit(v);
    };
    const T = (i: number) => lit(keys[i].tick);
    const scaled = (expr: string) => (track.kind === "scalar" && track.scale !== undefined ? `(${expr}) * ${lit(track.scale)}` : expr);

    const leaf = (i: number): string[] => {
      const p = keys[i];
      const q = keys[i + 1];
      if (p.easing === "hold") return [`return ${at(p.tick)};`];
      const span = q.tick - p.tick;
      const out = [`if (tk == ${T(i)}) return ${at(p.tick)};`, `float u = (tk - ${T(i)}) / ${lit(span)};`];
      if (p.easing === "customBezier" && !color) {
        // The 2D cubic the Graph Editor draws (handles in value units).
        this.helpers.add("bezier");
        const y0 = p.value as number;
        const y3 = q.value as number;
        const dv = y3 - y0;
        const right = p.right ?? { dx: span * 0.33, dy: dv * 0.33 };
        const left = q.left ?? { dx: -span * 0.33, dy: -dv * 0.33 };
        const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
        const x1 = clamp01(span > 0 ? right.dx / span : 0);
        const x2 = clamp01(span > 0 ? 1 + left.dx / span : 1);
        const y1 = y0 + right.dy;
        const y2 = y3 + left.dy;
        out.push(
          `float w = tbk_bez_x(${lit(x1)}, ${lit(x2)}, u);`,
          `float o = 1.0 - w;`,
          `return ${scaled(`o * o * o * ${lit(y0)} + 3.0 * o * o * w * ${lit(y1)} + 3.0 * o * w * w * ${lit(y2)} + w * w * w * ${lit(y3)}`)};`
        );
        return out;
      }
      if (p.easing === "spring") {
        this.helpers.add("spring");
        this.helpers.add("math");
        const a = springArgsOf(p.spring);
        out.push(`float t = tbk_spring(u, ${lit(a.zeta)}, ${lit(a.omega)}, ${lit(a.rest)});`);
      } else if (p.easing === "cubicBezier") {
        this.helpers.add("bezier");
        const e = p.bezier ?? { x1: 1 / 3, y1: 1 / 3, x2: 2 / 3, y2: 2 / 3 };
        const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
        out.push(`float t = tbk_cubic(u, ${lit(clamp01(e.x1))}, ${lit(e.y1)}, ${lit(clamp01(e.x2))}, ${lit(e.y2)});`);
      } else {
        const eased = easeLines(p.easing);
        if (eased.some((l) => /\btbk_(sin|cos|exp2)\(/.test(l))) this.helpers.add("math");
        out.push(...eased);
      }
      if (!color) {
        const a = p.value as number;
        out.push(`return ${scaled(`${lit(a)} + ${lit((q.value as number) - a)} * t`)};`);
        return out;
      }
      const a = p.value as number[];
      const b = q.value as number[];
      if ((track.colorSpace ?? "oklab") === "rgb") {
        out.push(`float3 c = ${vecLit(a.slice(0, 3))} + ${vecLit([0, 1, 2].map((k) => b[k] - a[k]))} * t;`);
      } else {
        this.helpers.add("oklab");
        this.helpers.add("math");
        const A = rgbToOklab(a[0], a[1], a[2]);
        const B = rgbToOklab(b[0], b[1], b[2]);
        out.push(`float3 c = tbk_oklab_srgb(${vecLit(A)} + ${vecLit([0, 1, 2].map((k) => B[k] - A[k]))} * t);`);
      }
      // Alpha interpolates with the color unless the track pins it (a Color
      // node's own alpha after the hex round trip).
      const alpha = `${lit(a[3])} + ${lit(b[3] - a[3])} * t`;
      if (!track.quantize8) out.push(`return float4(c, ${alpha});`);
      else {
        this.helpers.add("q8");
        out.push(track.quantizeAlpha ? `return tbk_q8(float4(c, ${alpha}));` : `return float4(tbk_q8(float4(c, 0.0)).rgb, ${lit(track.alpha ?? 1)});`);
      }
      return out;
    };

    // Segments with a span, by start key; consecutive ones are contiguous.
    const segs: number[] = [];
    for (let i = 0; i + 1 < keys.length; i++) if (keys[i].tick < keys[i + 1].tick) segs.push(i);
    const tree = (lo: number, hi: number): string[] => {
      if (lo === hi) return leaf(segs[lo]);
      const mid = (lo + hi + 1) >> 1;
      return [`if (tk < ${T(segs[mid])}) {`, ...indent(tree(lo, mid - 1), "  "), `} else {`, ...indent(tree(mid, hi), "  "), `}`];
    };
    const first = keys[0].tick;
    const last = keys[keys.length - 1].tick;
    const body = [`if (tk <= ${lit(first)}) return ${at(first)};`, `if (tk >= ${lit(last)}) return ${at(last)};`];
    if (segs.length) body.push(...tree(0, segs.length - 1));
    else body.push(`return ${at(last)};`);
    this.fns.push(
      `// ${label.replace(/\n/g, " ")} — ${keys.length} key${keys.length === 1 ? "" : "s"}${color ? `, ${track.colorSpace ?? "oklab"}${track.quantize8 ? ", 8-bit" : ""}` : ""}${track.scale !== undefined ? `, × ${track.scale}` : ""}\n` +
        `${type} ${name}(float tk) {\n${indent(body, "  ").join("\n")}\n}`
    );
    return { fn: name, width: color ? 4 : 1 };
  }

  // A per-frame series (the worklet's seriesLerp / seriesLerpN over the same
  // compressed frames), assigned into `target`. Returns the bake statements:
  // a constant init of every component, then the series call that overwrites
  // the components that move.
  series(values: BindValue[], target: BakeTarget, label: string): string[] | null {
    const bad = (why: string) => {
      this.problems.push(`${label}: ${why}`);
      return null;
    };
    const flat = values.map((v) => (typeof v === "number" ? [v] : Array.isArray(v) ? v : null));
    const L = target.width * (target.count ?? 1);
    if (flat.some((v) => !v || v.length !== L || v.some((x) => typeof x !== "number" || !Number.isFinite(x)))) {
      return bad(`a sampled frame isn't ${L} finite number${L === 1 ? "" : "s"} (the uniform's ${target.type}${target.count ? `[${target.count}]` : ""}).`);
    }
    if (target.type === "int" && target.count !== undefined) return bad("an int array uniform can't bake.");
    const s = compress(values, "lerp");
    if (s.f.length > BAKED_LIMITS.seriesFrames) {
      return bad(`a sampled series of ${s.f.length} distinct frames — baked series are capped at ${BAKED_LIMITS.seriesFrames} frames; export with animation "worklet".`);
    }
    const v = s.v.map((x) => (typeof x === "number" ? [x] : (x as number[])));
    const moving: number[] = [];
    for (let c = 0; c < L; c++) if (v.some((x) => !Object.is(x[c], v[0][c]))) moving.push(c);
    this.seriesLiterals += L + moving.length * s.f.length * 2;
    if (this.seriesLiterals > BAKED_LIMITS.seriesLiterals) {
      return bad(`the program's sampled series need ${this.seriesLiterals} constants — baking caps them at ${BAKED_LIMITS.seriesLiterals} per program; export with animation "worklet".`);
    }
    const assign = (c: number, expr: string) => `${lvalue(target, c)} = ${target.type === "int" ? `int(${expr})` : expr};`;

    // Init: frame 0's value, element by element.
    const init: string[] = [];
    const n = target.count ?? 1;
    for (let e = 0; e < n; e++) {
      const comps = v[0].slice(e * target.width, (e + 1) * target.width);
      const lhs = target.count !== undefined ? `${target.name}[${e}]` : target.name;
      init.push(`${lhs} = ${target.type === "int" ? `int(${lit(comps[0])})` : vecLit(comps)};`);
    }
    if (!moving.length) return init;

    const name = `tbk_s${this.nSeries++}`;
    const F = (i: number) => lit(s.f[i]);
    const leaf = (i: number): string[] => {
      const a = v[i];
      const b = v[i + 1];
      const out = [`float u = (fr - ${F(i)}) / ${lit(s.f[i + 1] - s.f[i])};`];
      for (const c of moving) out.push(assign(c, Object.is(a[c], b[c]) ? lit(a[c]) : `${lit(a[c])} + ${lit(b[c] - a[c])} * u`));
      return out;
    };
    const tree = (lo: number, hi: number): string[] => {
      if (lo === hi) return leaf(lo);
      const mid = (lo + hi + 1) >> 1;
      return [`if (fr < ${F(mid)}) {`, ...indent(tree(lo, mid - 1), "  "), `} else {`, ...indent(tree(mid, hi), "  "), `}`];
    };
    const lastI = s.f.length - 1;
    const body = [
      `if (fr <= ${F(0)}) return;`,
      `if (fr >= ${F(lastI)}) {`,
      ...indent(moving.map((c) => assign(c, lit(v[lastI][c]))), "  "),
      `  return;`,
      `}`,
      ...(lastI > 0 ? tree(0, lastI - 1) : []),
    ];
    this.fns.push(
      `// ${label.replace(/\n/g, " ")} — ${s.f.length} kept frames, ${moving.length} of ${L} components move\n` +
        `void ${name}(float fr) {\n${indent(body, "  ").join("\n")}\n}`
    );
    return [...init, `${name}(fr);`];
  }

  // Everything appended to a program: helpers, the clock, the functions,
  // tbk_bake and the new main.
  block(bakeStatements: string[], usesFrame: boolean, mainType: string): string {
    const tpf = this.timeline.ticksPerFrame;
    const bake = [
      `float tk = tbk_tick(iTime);`,
      ...(usesFrame
        ? [
            `// The toolbox frame (exact on frame ticks, as frameAt()).`,
            `float fr = floor(tk / ${lit(tpf)} + 0.5);`,
            `if (fr * ${lit(tpf)} != tk) fr = tk / ${lit(tpf)};`,
          ]
        : []),
      ...bakeStatements,
    ];
    return [
      ``,
      `// ---- toolbox: the animation, baked into the shader (animation: "baked") ----`,
      `// Generated from the toolbox timeline; every value above that this block`,
      `// assigns was a per-frame uniform in the worklet export.`,
      ...HELPER_ORDER.filter((h) => this.helpers.has(h)).flatMap((h) => ["", BAKED_HELPERS[h]]),
      ``,
      this.tickSource(),
      ...this.fns.flatMap((f) => ["", f]),
      ``,
      `void tbk_bake() {`,
      ...indent(bake, "  "),
      `}`,
      ``,
      `${mainType} main(float2 tbk_p) {`,
      `  tbk_bake();`,
      `  return tbk_main(tbk_p);`,
      `}`,
      ``,
    ].join("\n");
  }
}

// ---- program rewriting ------------------------------------------------------------------------

export interface UniformDecl {
  name: string;
  type: string;
  count?: number;
  color: boolean;
}

const WIDTH: Record<string, number> = { float: 1, half: 1, int: 1, float2: 2, half2: 2, vec2: 2, float3: 3, half3: 3, vec3: 3, float4: 4, half4: 4, vec4: 4 };

function declRe(name: string): RegExp {
  return new RegExp(`^([ \\t]*)(layout\\s*\\([^)]*\\)\\s*)?uniform\\s+(\\w+)\\s+${name}\\s*(?:\\[\\s*(\\d+)\\s*\\])?\\s*;`, "m");
}

export function findUniformDecl(sksl: string, name: string): UniformDecl | null {
  const m = declRe(name).exec(sksl);
  if (!m) return null;
  return { name, type: m[3], ...(m[4] ? { count: Number(m[4]) } : {}), color: !!m[2] && /\bcolor\b/.test(m[2]) };
}

export function bakeTargetOf(d: UniformDecl): BakeTarget | string {
  const width = WIDTH[d.type];
  if (!width) return `uniform ${d.name} is a ${d.type} — only float, float2..4 and int uniforms bake.`;
  const type = d.type.startsWith("half") ? d.type.replace("half", "float") : d.type.startsWith("vec") ? d.type.replace("vec", "float") : d.type;
  return { name: d.name, type, width, ...(d.count !== undefined ? { count: d.count } : {}) };
}

const MAIN_RE = /\b(half4|float4|vec4)(\s+)main(\s*\()/g;

// The program with `names` turned into globals, main renamed tbk_main and
// `block` appended (and `uniform float iTime;` prepended when missing).
function rewriteProgram(sksl: string, names: string[], gen: BakeGen, bake: string[], usesFrame: boolean, where: string): { sksl: string; addedTime: boolean } | null {
  if (/\btbk_\w*/.test(sksl)) {
    gen.problems.push(`${where}: the program already uses identifiers starting with "tbk_" — the baked timeline reserves that prefix.`);
    return null;
  }
  let out = sksl;
  for (const n of names) {
    const re = declRe(n);
    if (!re.test(out)) {
      gen.problems.push(`${where}: couldn't find the declaration of uniform ${n} to bake it.`);
      return null;
    }
    out = out.replace(re, (_m, ws: string, _layout: string | undefined, type: string, count: string | undefined) => {
      const t = type.startsWith("half") ? type.replace("half", "float") : type;
      return `${ws}${t} ${n}${count ? `[${count}]` : ""}; // baked: tbk_bake() assigns it`;
    });
  }
  const mains = [...out.matchAll(MAIN_RE)];
  if (!mains.length) {
    gen.problems.push(`${where}: no \`half4 main(float2 …)\` to wrap.`);
    return null;
  }
  const mainType = mains[mains.length - 1][1];
  out = out.replace(MAIN_RE, (_m, t: string, ws: string, paren: string) => `${t}${ws}tbk_main${paren}`);
  const addedTime = !/\buniform\s+float\s+iTime\s*;/.test(out);
  if (addedTime) out = `uniform float iTime; // added by the baked timeline (the master clock)\n${out}`;
  return { sksl: `${out.replace(/\s*$/, "\n")}${gen.block(bake, usesFrame, mainType)}`, addedTime };
}

function durationProblem(durationTicks: number): string | null {
  return durationTicks >= BAKED_LIMITS.maxTicks
    ? `The scene is ${durationTicks} ticks long — baked timelines evaluate time in fp32, exact only below 2^24 = ${BAKED_LIMITS.maxTicks} ticks (${(BAKED_LIMITS.maxTicks / 60_000).toFixed(1)} s at 60 fps); shorten the scene or export with animation "worklet".`
    : null;
}

// The statement assigning a track (or several, or one component of one)
// into a target; null + a problem when the shapes disagree.
function trackAssign(gen: BakeGen, tracks: TimelineTrack[], pick: number | undefined, target: BakeTarget, label: string): string | null {
  if (target.count !== undefined) {
    gen.problems.push(`${label}: a track can't drive the uniform array ${target.name}[${target.count}].`);
    return null;
  }
  const fns = tracks.map((t, i) => gen.track(t, tracks.length > 1 ? `${label} [${i}]` : label));
  if (fns.some((f) => !f)) return null;
  const calls = fns.map((f) => `${f!.fn}(tk)`);
  let expr: string;
  let width: number;
  if (fns.length === 1) {
    if (pick !== undefined && fns[0]!.width > 1) {
      expr = `${calls[0]}.${"xyzw"[pick]}`;
      width = 1;
    } else {
      expr = calls[0];
      width = fns[0]!.width;
    }
  } else {
    if (fns.some((f) => f!.width !== 1)) {
      gen.problems.push(`${label}: a vector of color tracks can't bake.`);
      return null;
    }
    expr = `float${fns.length}(${calls.join(", ")})`;
    width = fns.length;
  }
  if (width !== target.width) {
    gen.problems.push(`${label}: the track yields ${width} value${width === 1 ? "" : "s"} but uniform ${target.name} is a ${target.type}.`);
    return null;
  }
  return `${target.name} = ${target.type === "int" ? `int(${expr})` : expr};`;
}

// The statement assigning a procedural driver (a scalar program of the tick,
// procedural/emit-sksl.ts) into a target; null + a problem when it can't bake.
function procAssign(gen: BakeGen, prog: ProcProgram, target: BakeTarget, label: string): string | null {
  if (target.count !== undefined || target.width !== 1) {
    gen.problems.push(`${label}: a procedural driver yields one value but uniform ${target.name} is a ${target.type}${target.count !== undefined ? `[${target.count}]` : ""}.`);
    return null;
  }
  const r = bakeProcedural(gen, prog, label);
  if (!r) return null;
  return `${target.name} = ${target.type === "int" ? `int(${r.fn}(tk))` : `${r.fn}(tk)`};`;
}

// ---- the SkSL Shader node export (M0 bundle) ----------------------------------------------------

export interface BakeEffectResult {
  plan: SkiaExportPlan | null;
  program: BakedProgramInfo | null;
  problems: string[];
  warnings: string[];
}

export function bakeSkiaPlan(plan: SkiaExportPlan): BakeEffectResult {
  const gen = new BakeGen(plan.timeline);
  const animated = plan.uniforms.filter((u) => u.track || u.expr);
  const program: BakedProgramInfo = { where: "effect", baked: [], uniforms: plan.uniforms.filter((u) => !u.track && !u.expr).map((u) => u.name) };
  if (!animated.length) return { plan, program, problems: [], warnings: [] };
  const dur = durationProblem(plan.timeline.durationTicks);
  if (dur) return { plan: null, program: null, problems: [dur], warnings: [] };
  const bake: string[] = [];
  for (const u of animated) {
    const label = `Uniform "${u.name}" (${u.from})`;
    const decl = findUniformDecl(plan.sksl, u.name);
    if (!decl) {
      gen.problems.push(`${label}: the program declares no uniform ${u.name}.`);
      continue;
    }
    const target = bakeTargetOf(decl);
    if (typeof target === "string") {
      gen.problems.push(`${label}: ${target}`);
      continue;
    }
    if (u.expr) {
      const stmt = procAssign(gen, u.expr, target, label);
      if (!stmt) continue;
      bake.push(stmt);
      program.baked.push({ name: u.name, kind: "procedural", from: u.from, type: target.type, points: u.expr.tracks.reduce((n, t) => n + t.keys.length, 0), color: false });
      continue;
    }
    const stmt = trackAssign(gen, [u.track!], undefined, target, label);
    if (!stmt) continue;
    bake.push(stmt);
    program.baked.push({ name: u.name, kind: "track", from: u.from, type: target.type, points: u.track!.keys.length, color: u.track!.kind === "color" });
  }
  if (gen.problems.length) return { plan: null, program: null, problems: gen.problems, warnings: gen.warnings };
  const r = rewriteProgram(plan.sksl, program.baked.map((b) => b.name), gen, bake, false, "The SkSL program");
  if (!r) return { plan: null, program: null, problems: gen.problems, warnings: gen.warnings };
  const warnings = [...gen.warnings];
  return {
    plan: { ...plan, sksl: r.sksl, usesTime: true, uniforms: plan.uniforms.filter((u) => !u.track && !u.expr), warnings: [...plan.warnings, ...warnings] },
    program,
    problems: [],
    warnings,
  };
}

const HEADER = (what: string) =>
  `// Generated by toolbox — ${what}.\n// Do not edit by hand: change the SkSL Shader node and export again.\n`;

function staticLit(v: number | number[] | undefined): string {
  return JSON.stringify(v);
}

// The M0 bundle with the animation inside effect.ts: timeline.ts supplies the
// clock and the static uniforms only, and toolbox-timeline.ts isn't shipped.
export function emitBakedSkiaBundle(
  plan: SkiaExportPlan,
  runtimeSource: string,
  segments: ExportSegments = NO_EXPORT_SEGMENTS
): { files: Record<string, string> | null; problems: string[]; warnings: string[] } {
  const b = bakeSkiaPlan(plan);
  if (!b.plan || !b.program) return { files: null, problems: b.problems, warnings: b.warnings };
  const baked = b.plan;
  const files = emitSkiaBundle(baked, runtimeSource, segments);
  delete files["toolbox-timeline.ts"];

  // (emit.ts's provenance comment, restated for the baked program.)
  files["effect.ts"] = files["effect.ts"].replace(
    /\/\/ Prelude \(first (\d+) lines\) \+ the node's source[\s\S]*?compiled it with CanvasKit /,
    (_m, n: string) =>
      `// Prelude (first ${n} lines) + the node's source + the color-managed main, then\n` +
      `// — animation: "baked" —\n` +
      `// the timeline as SkSL functions of iTime (the tbk_ block at the end): the\n` +
      `// animated uniforms are globals the program assigns itself. Checked with CanvasKit `
  );

  const fields = baked.uniforms.map((u) => `    ${u.name}: ${staticLit(u.value)}, // ${u.from}`).join("\n");
  files["timeline.ts"] =
    HEADER("the animation timeline") +
    timelineConstSource(baked.timeline) +
    `\nexport const CANVAS = { width: ${baked.canvas.width}, height: ${baked.canvas.height} } as const;\n` +
    `\n// animation: "baked" — every animated uniform is evaluated inside the SkSL from\n` +
    `// iTime (effect.ts). Per frame the shader needs only the clock, the canvas\n` +
    `// size and the static uniforms. width/height are the canvas size in points.\n` +
    `export function sampleUniforms(seconds: number, width: number, height: number) {\n` +
    `  "worklet";\n` +
    `  return {\n    iResolution: [width, height, 1],\n    iTime: seconds,\n${fields ? `${fields}\n` : ""}  };\n}\n`;

  const m = JSON.parse(files["manifest.json"]) as Record<string, unknown>;
  const bakedNames = new Map(b.program.baked.map((x) => [x.name, x]));
  m.animation = "baked";
  m.uniforms = plan.uniforms.map((u) => ({
    name: u.name,
    kind: u.kind,
    animated: !!u.track || !!u.expr,
    keys: u.track?.keys.length ?? 0,
    from: u.from,
    ...(u.expr ? { procedural: { nodes: u.expr.nodes.map((n) => `${n.type} ${n.id}`) } } : {}),
    ...(bakedNames.has(u.name) ? { baked: true } : {}),
  }));
  m.baked = {
    note: "Animated uniforms are SkSL functions of iTime inside the program; the component drives iTime from the master clock and supplies the static uniforms. No worklet timeline ships (toolbox-timeline.ts is omitted).",
    time: `tick = iTime × ${baked.timeline.fps * baked.timeline.ticksPerFrame} in fp32, snapped to the nearest integer tick within 1e-6 + 2.5e-7·tick; scenes must stay below 2^24 ticks`,
    programs: [b.program],
    worklet: { binds: 0 },
    limits: BAKED_LIMITS,
  };
  m.warnings = baked.warnings;
  files["manifest.json"] = JSON.stringify(m, null, 2) + "\n";
  return { files, problems: [], warnings: baked.warnings };
}

// ---- Skia Canvas scenes ----------------------------------------------------------------------

export interface BakeSceneResult {
  plan: ScenePlan | null;
  programs: BakedProgramInfo[];
  // Animated binds left on the worklet timeline (outside runtime programs,
  // or a program's clock).
  worklet: PlannedBind[];
  problems: string[];
  warnings: string[];
}

function isProgram(x: unknown): x is SkslProgramIR {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return typeof o.sksl === "string" && !!o.uniforms && typeof o.uniforms === "object" && Array.isArray(o.children);
}

// The scene with its runtime programs rewritten. Every Bind object is kept
// by identity (the emitter looks binds up by object), only the containers on
// the way to a program are copied; a program shared by two paths is baked
// once.
export function bakeScenePlan(plan: ScenePlan): BakeSceneResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  const programs: BakedProgramInfo[] = [];
  const done = new Map<SkslProgramIR, SkslProgramIR>();
  const addedBinds: { path: string; bind: Bind<number> }[] = [];
  const timeline = { fps: plan.timeline.fps, ticksPerFrame: plan.timeline.ticksPerFrame };
  let anyBaked = false;

  const bakeProgram = (p: SkslProgramIR, path: string): SkslProgramIR => {
    const hit = done.get(p);
    if (hit) return hit;
    // Children first (they're programs of their own).
    const children = p.children.map((c, i) => ({ ...c, shader: mapNode(c.shader, `${path}.children.${i}.shader`) as typeof c.shader }));
    const gen = new BakeGen(timeline);
    const bake: string[] = [];
    const info: BakedProgramInfo = { where: path, baked: [], uniforms: [] };
    const kept: Record<string, Bind<number | number[]>> = {};
    let usesFrame = false;
    for (const [name, b] of Object.entries(p.uniforms)) {
      const pb = plan.bindFor.get(b as Bind<unknown>);
      const kind = pb?.plan.kind;
      if (!pb || (kind !== "track" && kind !== "sampled" && kind !== "expr")) {
        kept[name] = b;
        continue;
      }
      const label = `${pb.path} (${pb.plan.kind === "track" || pb.plan.kind === "sampled" || pb.plan.kind === "expr" ? pb.plan.from : ""})`;
      if (name === "iTime") {
        gen.problems.push(`${label}: iTime is ${kind} here, not the scene clock — a baked program needs iTime to be the master clock; export with animation "worklet".`);
        continue;
      }
      const decl = findUniformDecl(p.sksl, name);
      if (!decl) {
        gen.problems.push(`${label}: the program declares no uniform ${name}.`);
        continue;
      }
      const target = bakeTargetOf(decl);
      if (typeof target === "string") {
        gen.problems.push(`${label}: ${target}`);
        continue;
      }
      if (pb.plan.kind === "expr") {
        // A compiled driver; a BindRef scale multiplies after it, as
        // evaluateTrack's does.
        const stmt = procAssign(gen, pb.plan.program, target, label);
        if (!stmt) continue;
        const scale = pb.plan.scale;
        bake.push(scale === undefined ? stmt : stmt.replace(/;$/, ` * ${lit(scale)};`));
        info.baked.push({ name, kind: "procedural", from: pb.plan.from, type: target.type, points: pb.plan.program.tracks.reduce((n, t) => n + t.keys.length, 0), color: false, bind: pb.id, path: pb.path });
      } else if (pb.plan.kind === "track") {
        const stmt = trackAssign(gen, pb.plan.tracks, pb.plan.pick, target, label);
        if (!stmt) continue;
        bake.push(stmt);
        info.baked.push({ name, kind: "track", from: pb.plan.from, type: target.type, points: pb.plan.tracks.reduce((n, t) => n + t.keys.length, 0), color: pb.plan.tracks.some((t) => t.kind === "color"), bind: pb.id, path: pb.path });
      } else {
        const stmts = gen.series(pb.plan.values, target, label);
        if (!stmts) continue;
        usesFrame = true;
        bake.push(...stmts);
        info.baked.push({ name, kind: "sampled", from: pb.plan.from, type: target.type + (target.count !== undefined ? `[${target.count}]` : ""), points: compress(pb.plan.values, "lerp").f.length, color: false, bind: pb.id, path: pb.path });
      }
    }
    const unchanged = () => {
      const same = children.every((c, i) => c.shader === p.children[i].shader);
      const out = same ? p : { ...p, children };
      done.set(p, out);
      return out;
    };
    warnings.push(...gen.warnings);
    if (gen.problems.length || !info.baked.length) {
      problems.push(...gen.problems);
      return unchanged();
    }
    anyBaked = true;
    // The program's clock must be the master clock.
    const tb = p.uniforms.iTime;
    const tplan = tb ? plan.bindFor.get(tb as Bind<unknown>)?.plan : undefined;
    if (tb && tplan?.kind !== "clock") {
      problems.push(`${path}: iTime is bound ${tplan ? `as ${tplan.kind}` : "statically"} — a baked program reads the master clock through iTime; export with animation "worklet".`);
    }
    const r = rewriteProgram(p.sksl, info.baked.map((x) => x.name), gen, bake, usesFrame, path);
    if (!r) {
      problems.push(...gen.problems);
      return unchanged();
    }
    if (r.addedTime) {
      const bind: Bind<number> = { v: 0 };
      kept.iTime = bind;
      addedBinds.push({ path: `${path}.uniforms.iTime`, bind });
      info.addedTime = true;
    }
    info.uniforms = Object.keys(kept);
    programs.push(info);
    const out: SkslProgramIR = { ...p, sksl: r.sksl, uniforms: kept, children };
    done.set(p, out);
    return out;
  };

  const mapNode = (x: unknown, path: string): unknown => {
    if (isBind(x)) return x;
    if (Array.isArray(x)) {
      const out = x.map((c, i) => mapNode(c, `${path}.${i}`));
      return out.every((c, i) => c === x[i]) ? x : out;
    }
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      let changed = false;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o)) {
        const nv = k === "program" && isProgram(v) ? bakeProgram(v, `${path}.program`) : mapNode(v, `${path}.${k}`);
        if (nv !== v) changed = true;
        out[k] = nv;
      }
      return changed ? out : x;
    }
    return x;
  };

  const root = mapNode(plan.scene.root, "root") as SkiaScene["root"];
  if (anyBaked) {
    const dur = durationProblem(plan.timeline.durationTicks);
    if (dur) problems.unshift(dur);
  }
  const worklet = (binds: PlannedBind[]) => binds.filter((b) => b.plan.kind === "track" || b.plan.kind === "sampled" || b.plan.kind === "clock" || b.plan.kind === "expr");
  if (problems.length) return { plan: null, programs, worklet: [], problems, warnings };
  if (!anyBaked) return { plan, programs: [], worklet: worklet(plan.binds), problems: [], warnings };

  // Re-collect the binds over the baked tree: a baked uniform's path is gone,
  // every other path keeps its PlannedBind (and id); an added iTime is a clock.
  const scene: SkiaScene = { ...plan.scene, root };
  const byPath = new Map(plan.binds.map((b) => [b.path, b]));
  let extra = 0;
  const found = collectBinds(scene.root);
  const binds: PlannedBind[] = found.map((fb) => {
    const known = byPath.get(fb.path);
    if (known) return known;
    // (By bind as well as path: a program the tree reaches twice — a
    // filter that draws its content more than once, Bloom (Skia) — is
    // baked once, so its added iTime sits at every path that reaches it.)
    if (addedBinds.some((a) => a.path === fb.path || a.bind === fb.bind)) return { id: `bk${extra++}`, path: fb.path, role: "number", plan: { kind: "clock", from: "master clock (seconds) — added by the baked timeline" } };
    throw new Error(`bakeScenePlan: no bind for ${fb.path}`);
  });
  const bindFor = new Map<Bind<unknown>, PlannedBind>();
  found.forEach((fb, i) => {
    if (!bindFor.has(fb.bind)) bindFor.set(fb.bind, binds[i]);
  });
  const left = worklet(binds).filter((b) => b.plan.kind !== "clock");
  if (left.length) {
    warnings.push(
      `${left.length} animated bind${left.length === 1 ? "" : "s"} outside runtime programs (${left
        .slice(0, 4)
        .map((b) => b.path)
        .join(", ")}${left.length > 4 ? ", …" : ""}) stay on the worklet timeline (timeline.ts) — only program uniforms bake into SkSL.`
    );
  }
  return {
    plan: { ...plan, scene, binds, bindFor, warnings: [...plan.warnings, ...warnings] },
    programs,
    worklet: worklet(binds),
    problems: [],
    warnings,
  };
}

export function emitBakedSceneBundle(
  plan: ScenePlan,
  runtimeSource: string,
  segments: ExportSegments = NO_EXPORT_SEGMENTS
): { files: Record<string, string> | null; problems: string[]; warnings: string[] } {
  const b = bakeScenePlan(plan);
  if (!b.plan) return { files: null, problems: b.problems, warnings: b.warnings };
  const files = emitSceneBundle(b.plan, runtimeSource, segments);
  const m = JSON.parse(files["manifest.json"]) as Record<string, unknown>;
  const left = b.worklet.filter((x) => x.plan.kind !== "clock");
  // Program ids as effects.ts numbers them (deduped by SkSL, first use).
  const effects = [...files["effects.ts"].matchAll(/export const (SKSL_\d+) = (".*");/g)].map((x) => ({ id: x[1], sksl: JSON.parse(x[2]) as string }));
  const programOf = (where: string) => {
    const at = where.split(".").slice(1).reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), b.plan!.scene.root) as SkslProgramIR | undefined;
    return effects.find((e) => e.sksl === at?.sksl)?.id;
  };
  m.animation = "baked";
  m.baked = {
    note: "Runtime-program uniforms driven by tracks or sampled series are SkSL functions of iTime inside the program; the component drives iTime from the master clock. Everything else that animates (transforms, path data, paint colors, gradient stops — anything outside a program's uniforms) stays on the worklet timeline (timeline.ts → sampleBinds).",
    time: `tick = iTime × ${plan.timeline.fps * plan.timeline.ticksPerFrame} in fp32, snapped to the nearest integer tick within 1e-6 + 2.5e-7·tick; scenes must stay below 2^24 ticks`,
    programs: b.programs.map((p) => ({ program: programOf(p.where), ...p })),
    worklet: {
      binds: left.length,
      kinds: left.reduce<Record<string, number>>((acc, x) => ({ ...acc, [x.plan.kind]: (acc[x.plan.kind] ?? 0) + 1 }), {}),
      paths: left.map((x) => x.path),
    },
    limits: BAKED_LIMITS,
  };
  files["manifest.json"] = JSON.stringify(m, null, 2) + "\n";
  return { files, problems: [], warnings: b.plan.warnings };
}

// For gates and tools: every track a baked bundle would compile, as a
// standalone SkSL probe that writes the values at `iTime` to pixels
// (component k of value j at x = j·4 + k) — check:skia-baked reads it back
// from an F32 surface.
export function bakedProbeProgram(
  tracks: { track: TimelineTrack; label: string }[],
  timeline: { fps: number; ticksPerFrame: number }
): { sksl: string; widths: number[]; problems: string[] } {
  const gen = new BakeGen(timeline);
  const fns = tracks.map((t) => gen.track(t.track, t.label));
  if (gen.problems.length) return { sksl: "", widths: [], problems: gen.problems };
  const lines = [
    `uniform float iTime;`,
    ...HELPER_ORDER.filter((h) => gen.helpers.has(h)).flatMap((h) => ["", BAKED_HELPERS[h]]),
    "",
    gen.tickSource(),
    ...gen.fns.flatMap((f) => ["", f]),
    "",
    `half4 main(float2 p) {`,
    `  float tk = tbk_tick(iTime);`,
    `  float x = floor(p.x);`,
    ...fns.flatMap((f, j) =>
      Array.from({ length: f!.width }, (_, k) => {
        const v = f!.width === 1 ? `${f!.fn}(tk)` : `${f!.fn}(tk).${"xyzw"[k]}`;
        return `  if (x < ${lit(j * 4 + k + 0.5)}) return half4(${v}, 0.0, 0.0, 1.0);`;
      })
    ),
    `  return half4(0.0);`,
    `}`,
  ];
  return { sksl: lines.join("\n"), widths: fns.map((f) => f!.width), problems: [] };
}

