import type {
  ExprInput,
  InputSocketDef,
  NodeDefinition,
  PointsValue,
  RenderContext,
  SplineValue,
} from "@/engine/types";
import {
  measureSpline,
  sampleSplineAt,
  type SplineLengths,
} from "@/engine/spline-math";

// Point Expression — the per-element field-expression primitive.
//
// The scalar Expression node (expression.ts) evaluates ONCE per frame. This
// node evaluates a JS block ONCE PER POINT over an incoming `points` value,
// so you can compute a point's new position / scale / rotation as a function
// of its own `index` (and `count`, `groupIndex`, current attributes, the
// frame clock, wired uniforms, and — optionally — samples of a guide spline).
//
// This is what lets you rebuild Blender-geometry-nodes "field" graphs: things
// like `curve_id = floor(index/slots)`, `phase = fract(... - frame/600)`,
// index-hashed random windows, exponential easing, and gated hops — none of
// which the bake-based points model could express before.
//
// Env & write model mirror expression.ts as closely as possible:
//   READ per point:  index, count, groupIndex, px, py, rot0, sx0, sy0
//   WRITE per point:  x(=px) y(=py) rot(=rot0) sx(=sx0) sy(=sy0)
//                     scale(=1, uniform mult) keep(=true, cull when falsy)
//   CLOCK/MATH:       t, time, frame, fps, PI, TAU, trig, clamp, lerp,
//                     smoothstep, fract, mod, ... (same whitelist)
//   RANDOM:           rand(seed) — deterministic, frame-INDEPENDENT (index
//                     hashing); random() — per-frame mulberry32 (animated).
//   PATH (optional `path` spline input):
//                     pathCount(), pathLen(sub?), pathPos(factor, sub?),
//                     pathX/pathY/pathAngle(factor, sub?)
//
// The block uses assignments (not `return`). Final scale = sx*scale, sy*scale.
// Points with a falsy `keep` are dropped — count shrinks, matching Blender's
// Delete Geometry (Copy to Points then instances fewer copies).

// Named-var socket helpers reused from the scalar Expression node.
export { newExprInput } from "./expression";

// Recompute the cache every frame only when the source is time-dependent —
// same predicate as expression.ts. `rand` is deliberately NOT here (it's
// frame-independent), so an index-hashed-only expression caches statically.
const TIME_RE = /\b(t|time|frame|random)\b/;
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const DEFAULT_EXPRESSION = `// read:  index, count, groupIndex, px, py, rot0, sx0, sy0
// write: x, y, rot, sx, sy, scale, keep   (declare temps with let/const)
x = px;
y = py;`;

// ---------------------------------------------------------------------------
// Deterministic hashes (both cache-safe: same inputs → same output).
// ---------------------------------------------------------------------------

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

// Frame-independent per-seed hash → [0,1). This is the "Random Value hashed on
// Index" primitive: same seed always yields the same value, so window starts /
// gates stay put across frames (and the node caches statically). triple32
// (Wellons) — strong avalanche on *sequential* integer seeds (0,1,2,…), the
// exact input pattern here. The trailing `>>> 0` keeps it unsigned before the
// divide (a signed result would fold the range into the bottom half).
function hash01(seed: number): number {
  let x = seed >>> 0;
  x ^= x >>> 17;
  x = Math.imul(x, 0xed5ad4bb);
  x ^= x >>> 11;
  x = Math.imul(x, 0xac4c1b51);
  x ^= x >>> 15;
  x = Math.imul(x, 0x31848bab);
  x ^= x >>> 14;
  return (x >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------
// Path sampling helpers — bound over the wired spline + its measured lengths.
// ---------------------------------------------------------------------------

interface PathEnv {
  pathCount: () => number;
  pathLen: (sub?: number) => number;
  pathPos: (factor: number, sub?: number) => [number, number];
  pathX: (factor: number, sub?: number) => number;
  pathY: (factor: number, sub?: number) => number;
  pathAngle: (factor: number, sub?: number) => number;
}

function makePathEnv(
  spline: SplineValue | null,
  lengths: SplineLengths | null
): PathEnv {
  if (!spline || !lengths || lengths.total <= 0) {
    const zero2: [number, number] = [0, 0];
    return {
      pathCount: () => 0,
      pathLen: () => 0,
      pathPos: () => zero2,
      pathX: () => 0,
      pathY: () => 0,
      pathAngle: () => 0,
    };
  }
  const nSub = lengths.perSubpath.length;
  // Map a per-subpath factor to the global [0,1] t sampleSplineAt expects.
  const globalT = (factor: number, sub?: number): number => {
    const f = factor - Math.floor(factor); // fract → loop
    if (sub === undefined) return f;
    const k = Math.max(0, Math.min(nSub - 1, sub | 0));
    const m = lengths.perSubpath[k];
    if (!m || m.total <= 0) return lengths.offsets[k] / lengths.total;
    return (lengths.offsets[k] + f * m.total) / lengths.total;
  };
  const pathLen = (sub?: number): number => {
    if (sub === undefined) return lengths.total;
    const k = Math.max(0, Math.min(nSub - 1, sub | 0));
    return lengths.perSubpath[k]?.total ?? 0;
  };
  const pathPos = (factor: number, sub?: number): [number, number] =>
    sampleSplineAt(spline, lengths, globalT(factor, sub)).pos;
  return {
    pathCount: () => nSub,
    pathLen,
    pathPos,
    pathX: (factor, sub) => pathPos(factor, sub)[0],
    pathY: (factor, sub) => pathPos(factor, sub)[1],
    pathAngle: (factor, sub) => {
      const tan = sampleSplineAt(spline, lengths, globalT(factor, sub)).tangent;
      return Math.atan2(tan[1], tan[0]);
    },
  };
}

// ---------------------------------------------------------------------------
// Env (built once per frame; constant across points).
// ---------------------------------------------------------------------------

function makeEnv(
  ctx: RenderContext,
  nodeId: string,
  path: PathEnv
): Record<string, unknown> {
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
    rand: (seed: number) => hash01(seed | 0),
    random: () => rng(),
    pathCount: path.pathCount,
    pathLen: path.pathLen,
    pathPos: path.pathPos,
    pathX: path.pathX,
    pathY: path.pathY,
    pathAngle: path.pathAngle,
  };
}

const ENV_KEYS = Object.keys(
  makeEnv(
    { time: 0, frame: 0, fps: 60 } as RenderContext,
    "sample",
    makePathEnv(null, null)
  )
).join(",");

// The mutable per-point record injected into every call. Reused across points
// (fields overwritten each iteration) so V8 stays monomorphic with zero
// per-point allocation.
interface PointCtx {
  index: number;
  count: number;
  groupIndex: number;
  px: number;
  py: number;
  rot0: number;
  sx0: number;
  sy0: number;
}

// Compiled function: (…namedVars, __env, __pt) → [x, y, sx, sy, scale, rot,
// keep] (keep as 0/1). The block runs against writable locals initialised from
// the point; we read them back after.
type CompiledFn = (...args: unknown[]) => unknown;

interface Compiled {
  source: string;
  varsKey: string;
  fn: CompiledFn | null;
  error: string | null;
}

interface ExprState {
  compiled?: Compiled;
  error: string | null;
  lastWarned?: string | null;
}

function getState(ctx: RenderContext, nodeId: string): ExprState {
  const key = `point-expression:${nodeId}`;
  let s = ctx.state[key] as ExprState | undefined;
  if (!s) {
    s = { error: null };
    ctx.state[key] = s;
  }
  return s;
}

function warnOnce(state: ExprState, nodeId: string): void {
  if (state.error && state.error !== state.lastWarned) {
    console.warn(`[Point Expression ${nodeId}] ${state.error}`);
  }
  state.lastWarned = state.error;
}

function compile(source: string, varNames: string[]): Compiled {
  const varsKey = varNames.join(",");
  for (const n of varNames) {
    if (!IDENT_RE.test(n)) {
      return { source, varsKey, fn: null, error: `Invalid variable name: "${n}"` };
    }
  }
  const seen = new Set<string>();
  for (const n of varNames) {
    if (seen.has(n)) {
      return { source, varsKey, fn: null, error: `Duplicate variable: "${n}"` };
    }
    seen.add(n);
  }
  const body = source.trim();
  try {
    // Per-point locals are declared from __pt; the user's block mutates the
    // writable ones; we return the packed result. A stray `return` in the
    // user block early-exits → we detect the non-array below and keep the
    // point unchanged.
    const fn = new Function(
      ...varNames,
      "__env",
      "__pt",
      `"use strict";
const{${ENV_KEYS}}=__env;
let index=__pt.index,count=__pt.count,groupIndex=__pt.groupIndex,px=__pt.px,py=__pt.py,rot0=__pt.rot0,sx0=__pt.sx0,sy0=__pt.sy0;
let x=px,y=py,rot=rot0,sx=sx0,sy=sy0,scale=1,keep=true;
${body}
return [x,y,sx,sy,scale,rot,keep?1:0];`
    ) as CompiledFn;
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

function toNum(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const EMPTY: PointsValue = {
  kind: "points",
  count: 0,
  positions: new Float32Array(0),
  points: [],
};

export const pointExpressionNode: NodeDefinition = {
  type: "point-expression",
  name: "Point Expression",
  category: "point",
  subcategory: "modifier",
  description:
    "Run a JavaScript expression once per point to compute its new position, " +
    "scale, and rotation from its own `index` (and `count`, `groupIndex`, " +
    "current px/py/rot0/sx0/sy0, the `frame`/`t` clock, and wired uniforms). " +
    "Set `keep=false` to cull a point. Wire a spline into `path` to sample " +
    "guide curves with pathPos(factor, sub) / pathLen(sub) / pathAngle(...). " +
    "Deterministic rand(seed) hashes on index for stable per-point randomness; " +
    "random() varies per frame. This is the per-element field primitive — the " +
    "per-point counterpart to the once-per-frame Expression node.",
  backend: "webgl2",
  // Pure CPU eval. fingerprintExtras folds ctx.time in only when the source is
  // time-dependent, so static per-point expressions cache as constants.
  stable: true,
  noMaskInput: true,
  inputs: [
    { name: "points", type: "points", required: true },
    { name: "path", type: "spline", required: false },
  ],
  resolveInputs(params): InputSocketDef[] {
    const entries = (params.inputs as ExprInput[]) ?? [];
    return [
      { name: "points", type: "points", required: true },
      { name: "path", type: "spline", required: false, label: "Path" },
      ...entries.map<InputSocketDef>((e) => ({
        name: `in:${e.id}`,
        label: e.name,
        type: "scalar",
        required: false,
      })),
    ];
  },
  params: [
    {
      name: "inputs",
      label: "Inputs",
      type: "expr_inputs",
      default: [],
    },
    {
      name: "expression",
      label: "Expression",
      type: "string",
      multiline: true,
      default: DEFAULT_EXPRESSION,
    },
    {
      name: "on_error",
      label: "On error",
      type: "enum",
      options: ["passthrough", "zero"],
      default: "passthrough",
    },
  ],
  primaryOutput: "points",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const src = inputs.points;
    if (!src || src.kind !== "points" || src.count === 0) {
      return { primary: EMPTY };
    }

    const entries = (params.inputs as ExprInput[]) ?? [];
    const source = (params.expression as string) ?? "";
    const varNames = entries.map((e) => e.name);
    const onErrorZero = (params.on_error as string) === "zero";

    const state = getState(ctx, nodeId);
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
    const fn = state.compiled.fn;
    if (!fn) {
      // Compile error (or empty) → pass the points through untouched.
      return { primary: src };
    }

    // Named uniform args (wired scalar wins, else the per-socket default).
    const baseArgs: unknown[] = entries.map((e) => {
      const sock = inputs[`in:${e.id}`];
      if (sock && sock.kind === "scalar") return sock.value;
      return e.default ?? 1;
    });

    // Path env (measured once per frame).
    const pathSrc =
      inputs.path && inputs.path.kind === "spline" ? inputs.path : null;
    const pathEnv = makePathEnv(
      pathSrc,
      pathSrc ? measureSpline(pathSrc) : null
    );
    const env = makeEnv(ctx, nodeId, pathEnv);

    const n = src.count;
    const inPos = src.positions;
    const inScales = src.scales;
    const inRots = src.rotations;
    const inGroups = src.groupIndices;

    const outPos = new Float32Array(n * 2);
    const outScales = new Float32Array(n * 2);
    const outRots = new Float32Array(n);
    const outGroups = inGroups ? new Int32Array(n) : undefined;
    let kept = 0;
    let runtimeErr = false;

    const pt: PointCtx = {
      index: 0,
      count: n,
      groupIndex: 0,
      px: 0,
      py: 0,
      rot0: 0,
      sx0: 1,
      sy0: 1,
    };

    for (let i = 0; i < n; i++) {
      const px = inPos[i * 2];
      const py = inPos[i * 2 + 1];
      const sx0 = inScales ? inScales[i * 2] : 1;
      const sy0 = inScales ? inScales[i * 2 + 1] : 1;
      const rot0 = inRots ? inRots[i] : 0;
      pt.index = i;
      pt.groupIndex = inGroups ? inGroups[i] : 0;
      pt.px = px;
      pt.py = py;
      pt.rot0 = rot0;
      pt.sx0 = sx0;
      pt.sy0 = sy0;

      let x = px;
      let y = py;
      let sxOut = sx0;
      let syOut = sy0;
      let rotOut = rot0;
      let keep = true;
      try {
        const raw = fn(...baseArgs, env, pt);
        if (Array.isArray(raw)) {
          x = toNum(raw[0], px);
          y = toNum(raw[1], py);
          const sx = toNum(raw[2], sx0);
          const sy = toNum(raw[3], sy0);
          const scale = toNum(raw[4], 1);
          sxOut = sx * scale;
          syOut = sy * scale;
          rotOut = toNum(raw[5], rot0);
          keep = !!raw[6];
        }
        // Non-array (e.g. the user block `return`ed) → keep the point as-is.
      } catch (e) {
        if (!runtimeErr) {
          state.error = e instanceof Error ? e.message : String(e);
          warnOnce(state, nodeId);
          runtimeErr = true;
        }
        if (onErrorZero) {
          x = 0;
          y = 0;
          sxOut = 0;
          syOut = 0;
          rotOut = 0;
        }
        // passthrough (default): leave x/y/scale/rot at the point's originals.
      }

      if (!keep) continue;
      outPos[kept * 2] = x;
      outPos[kept * 2 + 1] = y;
      outScales[kept * 2] = sxOut;
      outScales[kept * 2 + 1] = syOut;
      outRots[kept] = rotOut;
      if (outGroups) outGroups[kept] = pt.groupIndex;
      kept++;
    }

    if (!runtimeErr) {
      state.error = null;
      state.lastWarned = null;
    }

    if (kept === 0) return { primary: EMPTY };

    const out: PointsValue =
      kept === n
        ? {
            kind: "points",
            count: n,
            positions: outPos,
            scales: outScales,
            rotations: outRots,
            groupIndices: outGroups,
            points: [],
          }
        : {
            kind: "points",
            count: kept,
            positions: outPos.slice(0, kept * 2),
            scales: outScales.slice(0, kept * 2),
            rotations: outRots.slice(0, kept),
            groupIndices: outGroups ? outGroups.slice(0, kept) : undefined,
            points: [],
          };
    return { primary: out };
  },

  fingerprintExtras(params, ctx) {
    const src = (params.expression as string) ?? "";
    return TIME_RE.test(src) ? `t:${ctx.time}` : "";
  },

  dispose(ctx, nodeId) {
    delete ctx.state[`point-expression:${nodeId}`];
  },
};
