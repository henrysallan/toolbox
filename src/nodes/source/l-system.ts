import type {
  NodeDefinition,
  PointsValue,
  RenderContext,
  SplineValue,
} from "@/engine/types";
import { EMPTY_POINTS } from "@/engine/points";
import {
  computeBranchIds,
  computeDaVinciWidths,
  emitGrowth,
  EMPTY_TRACE,
  type GrowthEmitOptions,
  type GrowthIdMode,
  type GrowthTrace,
} from "@/engine/growth-emit";

// L-System — Lindenmayer string rewriting with a turtle interpreter
// (specdocs/archive/080226_l-system.md). Split out of Accretive Growth, whose
// modes are all stochastic spatial processes constrained by a region;
// this one executes a grammar and shares only the emission layer.
//
// Trace-and-slice timeline, same as the growth family: the whole
// structure is expanded ONCE into a trace cached in ctx.state, and
// `progress` slices it. Scrubbing either way is free.
//
// Two independent animation inputs, and they mean different things:
//   `progress`   reveals a FIXED structure outward, level by level.
//   `iterations` morphs BETWEEN structural levels (fractional values
//                grow the newest generation out of its parents). This one
//                re-expands the grammar, so it is the expensive one.

// Rewriting is exponential; these are the guards.
const MAX_SYMBOLS = 2_000_000;
const MAX_LEVELS = 12;

function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}

function str(v: unknown, fb: string): string {
  return typeof v === "string" ? v : fb;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

interface Preset {
  axiom: string;
  rules: string;
  angle: number;
  startAngle: number;
  iterations: number;
}

const PRESETS: Record<string, Preset> = {
  fern: {
    axiom: "X",
    rules: "X=F+[[X]-X]-F[-FX]+X\nF=FF",
    angle: 25,
    startAngle: -90,
    iterations: 5,
  },
  bush: {
    axiom: "F",
    rules: "F=FF+[+F-F-F]-[-F+F+F]",
    angle: 22.5,
    startAngle: -90,
    iterations: 4,
  },
  plant: {
    axiom: "F",
    rules: "F=F[+F]F[-F]F",
    angle: 25.7,
    startAngle: -90,
    iterations: 4,
  },
  tree: {
    axiom: "F",
    rules: "F=F[+F]F[-F][F]",
    angle: 20,
    startAngle: -90,
    iterations: 4,
  },
  koch: {
    axiom: "F",
    rules: "F=F+F-F-F+F",
    angle: 90,
    startAngle: 0,
    iterations: 3,
  },
  hilbert: {
    axiom: "A",
    rules: "A=-BF+AFA+FB-\nB=+AF-BFB-FA+",
    angle: 90,
    startAngle: 0,
    iterations: 5,
  },
  dragon: {
    axiom: "FX",
    rules: "X=X+YF+\nY=-FX-Y",
    angle: 90,
    startAngle: 0,
    iterations: 10,
  },
  sierpinski: {
    axiom: "F-G-G",
    rules: "F=F-G+F+G-F\nG=GG",
    angle: 120,
    startAngle: 0,
    iterations: 5,
  },
};

// ---------------------------------------------------------------------------
// Grammar
// ---------------------------------------------------------------------------

interface Alternative {
  text: string;
  weight: number;
}

// `A=F[+A]` or, stochastically, `A=0.7:F[+A] | 0.3:F[-A]`.
function parseRules(src: string): Map<number, Alternative[]> {
  const out = new Map<number, Alternative[]>();
  for (const rawLine of src.split(/[\n;]/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const lhs = line.slice(0, eq).trim();
    if (lhs.length !== 1) continue;
    const alts: Alternative[] = [];
    for (const rawAlt of line.slice(eq + 1).split("|")) {
      const alt = rawAlt.trim();
      if (!alt) continue;
      const colon = alt.indexOf(":");
      if (colon > 0) {
        const w = Number(alt.slice(0, colon).trim());
        if (Number.isFinite(w) && w > 0) {
          alts.push({ text: alt.slice(colon + 1).trim(), weight: w });
          continue;
        }
      }
      alts.push({ text: alt, weight: 1 });
    }
    if (alts.length > 0) out.set(lhs.charCodeAt(0), alts);
  }
  return out;
}

interface Expansion {
  chars: Uint16Array;
  length: number;
  levels: number;
}

function expand(
  axiom: string,
  rules: Map<number, Alternative[]>,
  levels: number,
  rng: () => number
): Expansion {
  let chars = new Uint16Array(axiom.length);
  for (let i = 0; i < axiom.length; i++) chars[i] = axiom.charCodeAt(i);
  let length = axiom.length;

  const chosen: (string | null)[] = [];
  for (let level = 0; level < levels; level++) {
    void level;
    // Sizing and writing must agree symbol-for-symbol. Drawing from the
    // PRNG in BOTH passes would give the write pass different alternatives
    // than the ones the buffer was sized for — silently truncating output
    // wherever a stochastic rule picked a longer branch the second time.
    // So the choice is made once, here, and cached.
    chosen.length = length;
    let outLen = 0;
    let overflow = false;
    for (let i = 0; i < length; i++) {
      const alts = rules.get(chars[i]);
      if (!alts) {
        chosen[i] = null;
        outLen += 1;
      } else {
        const text = pickAlt(alts, rng).text;
        chosen[i] = text;
        outLen += text.length;
      }
      if (outLen > MAX_SYMBOLS) {
        overflow = true;
        break;
      }
    }
    if (overflow) break;

    const nc = new Uint16Array(outLen);
    let w = 0;
    for (let i = 0; i < length; i++) {
      const text = chosen[i];
      if (text === null) {
        nc[w] = chars[i];
        w++;
        continue;
      }
      for (let k = 0; k < text.length; k++) {
        nc[w] = text.charCodeAt(k);
        w++;
      }
    }
    chars = nc;
    length = w;
  }
  return { chars, length, levels };
}

function pickAlt(alts: Alternative[], rng: () => number): Alternative {
  if (alts.length === 1) return alts[0];
  let total = 0;
  for (const a of alts) total += a.weight;
  let r = rng() * total;
  for (const a of alts) {
    r -= a.weight;
    if (r <= 0) return a;
  }
  return alts[alts.length - 1];
}

// ---------------------------------------------------------------------------
// Turtle
// ---------------------------------------------------------------------------

interface TurtleParams {
  angle: number;
  angleJitter: number;
  lengthPx: number;
  lengthDecay: number;
  tropismX: number;
  tropismY: number;
  tropismStrength: number;
  originX: number;
  originY: number;
  startAngle: number;
  maxElements: number;
  tipWidth: number;
  frac: number;
}

const CH_F = 70;
const CH_G = 71;
const CH_f = 102;
const CH_g = 103;
const CH_PLUS = 43;
const CH_MINUS = 45;
const CH_PIPE = 124;
const CH_OPEN = 91;
const CH_CLOSE = 93;

function runTurtle(
  ex: Expansion,
  W: number,
  H: number,
  p: TurtleParams,
  rng: () => number
): GrowthTrace {
  const cap = p.maxElements;
  const x = new Float32Array(cap);
  const y = new Float32Array(cap);
  const parent = new Int32Array(cap);
  const depth = new Int32Array(cap);
  const heading = new Float32Array(cap);
  const rootOf = new Int32Array(cap);
  let count = 0;

  const addNode = (
    px: number,
    py: number,
    par: number,
    dep: number,
    head: number,
    root: number
  ): number => {
    x[count] = px;
    y[count] = py;
    parent[count] = par;
    depth[count] = dep;
    heading[count] = head;
    rootOf[count] = root;
    return count++;
  };

  let tx = p.originX * W;
  let ty = p.originY * H;
  let th = (p.startAngle * Math.PI) / 180;
  let tnode = addNode(tx, ty, -1, 0, th, 0);
  let tdepth = 0;
  let tlen = p.lengthPx;

  // Bracket stack: discrete turtle state (node, depth) and continuous
  // state (position, heading, length) saved together.
  const stackI: number[] = [];
  const stackF: number[] = [];
  const angleRad = (p.angle * Math.PI) / 180;

  for (let i = 0; i < ex.length && count < cap; i++) {
    const c = ex.chars[i];
    if (c === CH_F || c === CH_G || c === CH_f || c === CH_g) {
      const draws = c === CH_F || c === CH_G;
      let hx = Math.cos(th);
      let hy = Math.sin(th);
      if (p.tropismStrength > 0) {
        hx += p.tropismX * p.tropismStrength;
        hy += p.tropismY * p.tropismStrength;
        const l = Math.hypot(hx, hy) || 1;
        hx /= l;
        hy /= l;
      }
      const nx = tx + hx * tlen;
      const ny = ty + hy * tlen;
      if (draws) {
        tnode = addNode(nx, ny, tnode, tdepth + 1, Math.atan2(hy, hx), rootOf[tnode]);
        tdepth++;
      } else {
        // A non-drawing move breaks the chain: the next segment starts a
        // disconnected subtree rather than a phantom edge across the gap.
        tnode = addNode(nx, ny, -1, 0, Math.atan2(hy, hx), count);
        tdepth = 0;
      }
      tx = nx;
      ty = ny;
      tlen *= p.lengthDecay;
    } else if (c === CH_PLUS || c === CH_MINUS) {
      let a = angleRad;
      if (p.angleJitter > 0) a *= 1 + (rng() - 0.5) * 2 * p.angleJitter;
      th += c === CH_PLUS ? -a : a;
    } else if (c === CH_PIPE) {
      th += Math.PI;
    } else if (c === CH_OPEN) {
      stackI.push(tnode, tdepth);
      stackF.push(tx, ty, th, tlen);
    } else if (c === CH_CLOSE) {
      if (stackI.length >= 2) {
        tdepth = stackI.pop()!;
        tnode = stackI.pop()!;
        tlen = stackF.pop()!;
        th = stackF.pop()!;
        ty = stackF.pop()!;
        tx = stackF.pop()!;
      }
    }
  }

  if (count === 0) return EMPTY_TRACE;

  // The turtle walks depth-first, so raw order reveals one branch at a
  // time — a pen drawing the plant. Re-index by depth so `progress` grows
  // the structure outward level by level, matching every Accretive Growth
  // mode. Sorting by (depth, turtleOrder) preserves parent[i] < i, since a
  // parent is always exactly one level shallower.
  const order = new Int32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  const sorted = Array.from(order).sort((a, b) =>
    depth[a] !== depth[b] ? depth[a] - depth[b] : a - b
  );
  const remap = new Int32Array(count);
  for (let k = 0; k < count; k++) remap[sorted[k]] = k;

  const ox = new Float32Array(count);
  const oy = new Float32Array(count);
  const oparent = new Int32Array(count);
  const odepth = new Int32Array(count);
  const oheading = new Float32Array(count);
  const oroot = new Int32Array(count);
  const oiter = new Int32Array(count);
  let maxDepth = 0;
  for (let k = 0; k < count; k++) {
    const s = sorted[k];
    ox[k] = x[s];
    oy[k] = y[s];
    oparent[k] = parent[s] >= 0 ? remap[parent[s]] : -1;
    odepth[k] = depth[s];
    oheading[k] = heading[s];
    oroot[k] = remap[rootOf[s]] ?? 0;
    oiter[k] = depth[s];
    if (depth[s] > maxDepth) maxDepth = depth[s];
  }

  // Fractional `iterations`: retract the DEEPEST ring toward its parents
  // so the newest growth extends smoothly instead of the whole structure
  // popping between integer levels.
  //
  // The obvious implementation — tagging each symbol with the rewrite
  // generation that produced it and scaling the newest generation — does
  // not work, and measuring is what showed it. A production like
  // `F=F[+F]F[-F]F` rewrites EVERY drawing symbol on every pass, so after
  // the final pass every symbol carries the newest generation and the
  // entire plant shrinks by `frac` rather than just its tips.
  //
  // Depth is the honest signal for "newest". Elements at max depth are
  // provably leaves, so moving them toward their parents drags nothing
  // with them and needs no second turtle run.
  if (p.frac > 0 && maxDepth > 0) {
    for (let k = 0; k < count; k++) {
      if (odepth[k] !== maxDepth) continue;
      const par = oparent[k];
      if (par < 0) continue;
      ox[k] = ox[par] + (ox[k] - ox[par]) * p.frac;
      oy[k] = oy[par] + (oy[k] - oy[par]) * p.frac;
    }
  }

  const iters = Math.max(1, maxDepth);
  const birth = new Float32Array(count);
  for (let i = 0; i < count; i++) birth[i] = oiter[i] / iters;

  return {
    count,
    x: ox,
    y: oy,
    parent: oparent,
    depth: odepth,
    iter: oiter,
    birth,
    width: computeDaVinciWidths(oparent, count, p.tipWidth),
    heading: oheading,
    root: oroot,
    branch: computeBranchIds(oparent, count),
    iters,
  };
}

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

interface LSystemState {
  trace: GrowthTrace | null;
  traceSig: string;
  emitKey: string;
  emitTrace: GrowthTrace | null;
  emitSpline: SplineValue | null;
  emitPoints: PointsValue | null;
}

const stateKey = (nodeId: string) => `l-system:${nodeId}`;

function getState(ctx: RenderContext, nodeId: string): LSystemState {
  let s = ctx.state[stateKey(nodeId)] as LSystemState | undefined;
  if (!s) {
    s = {
      trace: null,
      traceSig: "",
      emitKey: "",
      emitTrace: null,
      emitSpline: null,
      emitPoints: null,
    };
    ctx.state[stateKey(nodeId)] = s;
  }
  return s;
}

const isCustom = (p: Record<string, unknown>): boolean =>
  p.preset === "custom";

export const lSystemNode: NodeDefinition = {
  type: "l-system",
  name: "L-System",
  category: "spline",
  subcategory: "generator",
  description:
    "Grow botanical and fractal structures from a rewriting grammar — a short rule set expanded a few times and drawn by a turtle. Pick a preset (fern, bush, plant, tree, Koch, Hilbert, dragon, Sierpinski) and shape it with Angle, Length and Length decay, or switch to Custom and write your own productions: one per line as `F=F[+F]F[-F]F`, with `F`/`G` drawing, `f`/`g` moving without drawing, `+`/`-` turning, and `[`/`]` saving and restoring the turtle. Rules can be stochastic — `A=0.7:F[+A] | 0.3:F[-A]` — which, with Angle jitter and Tropism (a global bend, for gravity or light), is what stops L-system plants looking like clip art. Two separate animation inputs: Progress reveals the finished structure outward level by level, while Iterations is fractional and morphs between structural levels, extending the newest tips out of their parents. Branch thickness follows Da Vinci's rule on the anchor width channel and age rides the subpath driver channel, so Stroke ramps can colour by either.",
  backend: "webgl2",
  noMaskInput: true,
  headerControl: { paramName: "preset" },
  inputs: [],
  params: [
    {
      name: "preset",
      label: "Preset",
      type: "enum",
      options: [
        "fern",
        "bush",
        "plant",
        "tree",
        "koch",
        "hilbert",
        "dragon",
        "sierpinski",
        "custom",
      ],
      default: "fern",
    },
    {
      name: "axiom",
      label: "Axiom",
      type: "string",
      default: "X",
      visibleIf: isCustom,
    },
    {
      name: "rules",
      label: "Rules",
      type: "string",
      default: "X=F+[[X]-X]-F[-FX]+X\nF=FF",
      visibleIf: isCustom,
    },
    {
      name: "iterations",
      label: "Iterations",
      type: "scalar",
      min: 0,
      max: MAX_LEVELS,
      step: 0.01,
      default: 5,
    },
    {
      name: "progress",
      label: "Progress",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 1,
    },
    {
      name: "use_preset_shape",
      label: "Preset angle",
      type: "boolean",
      default: true,
      visibleIf: (p) => p.preset !== "custom",
    },
    {
      name: "angle",
      label: "Angle",
      type: "scalar",
      min: 0,
      max: 180,
      step: 0.1,
      default: 25,
      visibleIf: (p) => p.preset === "custom" || p.use_preset_shape === false,
    },
    {
      name: "angle_jitter",
      label: "Angle jitter",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
    },
    {
      name: "length",
      label: "Length",
      type: "scalar",
      min: 0.0005,
      max: 0.2,
      softMax: 0.1,
      step: 0.0005,
      default: 0.04,
    },
    {
      name: "length_decay",
      label: "Length decay",
      type: "scalar",
      min: 0.5,
      max: 1.2,
      step: 0.005,
      default: 0.9,
    },
    {
      name: "tropism_angle",
      label: "Tropism angle",
      type: "scalar",
      min: -180,
      max: 180,
      step: 1,
      default: 90,
    },
    {
      name: "tropism_strength",
      label: "Tropism",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
    },
    {
      name: "origin_x",
      label: "Origin X",
      type: "scalar",
      min: -0.5,
      max: 1.5,
      step: 0.005,
      default: 0.5,
    },
    {
      name: "origin_y",
      label: "Origin Y",
      type: "scalar",
      min: -0.5,
      max: 1.5,
      step: 0.005,
      default: 0.92,
    },
    {
      name: "start_angle",
      label: "Start angle",
      type: "scalar",
      min: -180,
      max: 180,
      step: 1,
      default: -90,
      visibleIf: (p) => p.preset === "custom" || p.use_preset_shape === false,
    },
    {
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 10000,
      step: 1,
      default: 0,
    },
    {
      name: "max_elements",
      label: "Max elements",
      type: "scalar",
      min: 100,
      max: 200000,
      softMax: 50000,
      step: 1,
      default: 20000,
    },
    {
      name: "emit",
      label: "Emit",
      type: "enum",
      options: ["limbs", "branches", "segments"],
      default: "limbs",
    },
    {
      name: "tip_width",
      label: "Tip width",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.1,
    },
    {
      name: "id_mode",
      label: "ID mode",
      type: "enum",
      options: ["branch", "depth", "root", "birth"],
      default: "branch",
    },
    {
      name: "id_groups",
      label: "ID groups",
      type: "scalar",
      min: 2,
      max: 32,
      step: 1,
      default: 6,
      visibleIf: (p) => p.id_mode === "birth",
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [{ name: "points", type: "points" }],

  compute({ params, ctx, nodeId }) {
    const state = getState(ctx, nodeId);
    const W = ctx.width;
    const H = ctx.height;

    const presetName = str(params.preset, "fern");
    const preset = PRESETS[presetName];
    // A preset supplies the grammar AND its natural angle / heading; the
    // numeric params still win when the user has moved them, which is why
    // preset selection writes through to them in the UI rather than
    // hiding them.
    const axiom = preset ? preset.axiom : str(params.axiom, "F");
    const rulesSrc = preset ? preset.rules : str(params.rules, "");
    // A preset carries the turn angle its grammar was designed around —
    // Koch and Hilbert are meaningless at 25 degrees, Sierpinski needs
    // 120. Rather than silently overriding a slider the user can see, the
    // preset's shape applies only while `use_preset_shape` is on, and the
    // manual rows appear the moment it is turned off.
    const usePresetShape = preset ? params.use_preset_shape !== false : false;
    const angle = usePresetShape
      ? preset!.angle
      : clamp(num(params.angle, 25), 0, 180);
    const startAngle = usePresetShape
      ? preset!.startAngle
      : clamp(num(params.start_angle, -90), -180, 180);
    const iterations = clamp(
      num(params.iterations, preset ? preset.iterations : 4),
      0,
      MAX_LEVELS
    );

    const seed = Math.max(0, Math.round(num(params.seed, 0)));
    const levels = Math.ceil(iterations);
    const frac = iterations - Math.floor(iterations);

    const tropRad =
      (clamp(num(params.tropism_angle, 90), -180, 180) * Math.PI) / 180;
    const tp: TurtleParams = {
      angle,
      angleJitter: clamp(num(params.angle_jitter, 0), 0, 1),
      lengthPx: clamp(num(params.length, 0.04), 0.0005, 0.2) * W,
      lengthDecay: clamp(num(params.length_decay, 0.9), 0.5, 1.2),
      tropismX: Math.cos(tropRad),
      tropismY: Math.sin(tropRad),
      tropismStrength: clamp(num(params.tropism_strength, 0), 0, 1),
      originX: clamp(num(params.origin_x, 0.5), -0.5, 1.5),
      originY: clamp(num(params.origin_y, 0.92), -0.5, 1.5),
      startAngle,
      maxElements: clamp(
        Math.round(num(params.max_elements, 20000)),
        100,
        200000
      ),
      tipWidth: clamp(num(params.tip_width, 0.1), 0, 1),
      frac,
    };

    const traceSig = [
      presetName,
      usePresetShape ? 1 : 0,
      axiom,
      rulesSrc,
      iterations,
      W,
      H,
      seed,
      tp.angle,
      tp.angleJitter,
      tp.lengthPx,
      tp.lengthDecay,
      tp.tropismX,
      tp.tropismY,
      tp.tropismStrength,
      tp.originX,
      tp.originY,
      tp.startAngle,
      tp.maxElements,
      tp.tipWidth,
    ].join("|");

    if (!state.trace || state.traceSig !== traceSig) {
      const rules = parseRules(rulesSrc);
      const ex = expand(axiom, rules, levels, mulberry32(seed));
      state.trace = runTurtle(ex, W, H, tp, mulberry32(seed ^ 0x5eed));
      state.traceSig = traceSig;
      state.emitTrace = null;
    }
    const trace = state.trace;
    if (trace.count === 0) {
      return {
        primary: { kind: "spline", subpaths: [] } satisfies SplineValue,
        aux: { points: EMPTY_POINTS },
      };
    }

    const eo: GrowthEmitOptions = {
      progress: clamp(num(params.progress, 1), 0, 1),
      emit:
        params.emit === "segments"
          ? "segments"
          : params.emit === "branches"
            ? "branches"
            : "limbs",
      idMode:
        typeof params.id_mode === "string"
          ? (params.id_mode as GrowthIdMode)
          : "branch",
      idGroups: clamp(Math.round(num(params.id_groups, 6)), 2, 32),
      width: W,
      height: H,
    };
    const emitKey = [eo.progress, eo.emit, eo.idMode, eo.idGroups, W, H].join(
      "|"
    );
    if (
      state.emitTrace !== trace ||
      state.emitKey !== emitKey ||
      !state.emitSpline ||
      !state.emitPoints
    ) {
      const { spline, points } = emitGrowth(trace, eo);
      state.emitSpline = spline;
      state.emitPoints = points;
      state.emitKey = emitKey;
      state.emitTrace = trace;
    }

    return { primary: state.emitSpline, aux: { points: state.emitPoints } };
  },

  dispose(ctx, nodeId) {
    delete ctx.state[stateKey(nodeId)];
  },
};
