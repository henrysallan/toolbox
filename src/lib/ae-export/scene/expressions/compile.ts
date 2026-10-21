// The value graph → one procedural program (spec 091926_after-effects-handoff.md
// §3 rung 3, M4 lane 1). The program is the Skia exporter's driver IR
// (skia-export/procedural/ir.ts) and most of its lowering is that exporter's
// Builder — Expression, LFO, Math, Scene Time, Random (seeded), Constant —
// each node's compute transcribed operation for operation, params resolved
// wire > keyframes > constant, wires through coerceValue. emit.ts prints the
// program as one After Effects expression.
//
// What this file adds over the Skia Builder:
//   - the rest of rung 3: Clamp, Lerp (scalar / vec2), Remap (scalar mode),
//     Compare, Logic, Switch (constant index), Float Curve (its monotone
//     cubic inlined segment by segment), Split / Combine Vec2 and the Vec2 /
//     Vec3 / Color literals — all in the IR's own operations, so the
//     interpreter (evaluateProgram) and every backend read them unchanged;
//   - Random in frame mode (Math.random() every evaluation in the editor):
//     AE's own `seedRandom(seed, false); random()` — the same statistics, a
//     different (but render-stable) draw; emit.ts prints the RNG as such;
//   - leaves: a value node's static param (an exposed knob or a group input
//     folded in by flatten) goes through exprLeaf (index.ts), the one place
//     the Essential Properties lane links them to a live control;
//   - keyframes inside the closure refuse (AE has no inline form of toolbox's
//     eases yet): the walk samples that property as before.
//
// A refusal is a reason string; the walk then samples the driver per frame.

import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import { computeMonotoneTangents, sanitizeFloatCurve } from "@/engine/float-curve";
import { readSwitchSlots, switchTypeIsAuto, unifySocketTypes } from "@/engine/graph-helpers";
import { getNodeDef } from "@/engine/registry";
import type { SocketType } from "@/engine/types";
import { liveBlock } from "@/lib/skia-export/drivers";
import { Builder, prune, Refusal, type ProceduralTimeline, type PVal } from "@/lib/skia-export/procedural/compile";
import type { PExpr, ProcProgram } from "@/lib/skia-export/procedural/ir";

export { Refusal };

// Rung-3 node types the AE compiler knows on top of the Skia Builder's.
export const AE_EXTRA_VALUE_TYPES: ReadonlySet<string> = new Set([
  "clamp",
  "lerp",
  "remap",
  "compare",
  "logic",
  "switch",
  "float-curve",
  "split-vec2",
  "combine-vec2",
  "vec2-literal",
  "vec3-literal",
  "color-literal",
]);

// A static value a program reads (a value node's param or a group input), as
// exprLeaf resolves it: the toolbox value, and optionally the AE code that
// reads it live (the Essential Properties lane). Without code it prints as
// the literal.
export interface ExprLeaf {
  value: number;
  code?: string;
}
export type LeafResolver = (node: GraphNode, name: string, value: number) => ExprLeaf;

const lit = (v: number): PExpr => ({ k: "lit", v });
const bin = (op: "+" | "-" | "*" | "/" | "%" | "**", a: PExpr, b: PExpr): PExpr => ({ k: "bin", op, a, b });
const cmp = (op: "<" | "<=" | ">" | ">=" | "==" | "!=", a: PExpr, b: PExpr): PExpr => ({ k: "cmp", op, a, b });
const call = (fn: string, ...args: PExpr[]): PExpr => ({ k: "call", fn, args });
const cond = (c: PExpr, a: PExpr, b: PExpr): PExpr => ({ k: "cond", c, a, b });
const max = (a: PExpr, b: PExpr) => call("max", a, b);
const min = (a: PExpr, b: PExpr) => call("min", a, b);

type VecType = "scalar" | "vec2" | "vec3" | "vec4";
const widthOf = (t: VecType) => (t === "scalar" ? 1 : Number(t.slice(3)));

// color-literal.ts hexToRgb, verbatim (8-digit hex included).
function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(s, 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

export class AeBuilder extends Builder {
  // Leaf tracks: track index → the AE code that reads the leaf live.
  readonly leafCode = new Map<number, string>();
  // RNGs that are AE's own seedRandom / random() (Random's frame mode).
  readonly aeRngs = new Set<number>();
  // Random nodes compiled, by mode (the report: seeded is exact, frame approx).
  readonly randoms: { id: string; mode: "seeded" | "frame" }[] = [];
  private aeMemo = new Map<string, PVal>();
  private aeVisiting = new Set<string>();

  constructor(
    nodes: Map<string, GraphNode> | GraphNode[],
    edges: GraphEdge[],
    tl: ProceduralTimeline,
    private leafOf: LeafResolver
  ) {
    super(nodes, edges, tl);
  }

  // A static leaf → a literal, or (with code) a slot that reads its
  // single-key track — never folded, so the code survives to the emitter.
  leaf(n: GraphNode, name: string, value: number): PExpr {
    const l = this.leafOf(n, name, value);
    if (l.code === undefined) return lit(l.value);
    // Its own track (Builder.track dedupes equal ones: two leaves of one
    // value must keep their own code).
    this.tracks.push({ kind: "scalar", keys: [{ tick: 0, value: l.value, easing: "hold" }] });
    const t = this.tracks.length - 1;
    this.leafCode.set(t, l.code);
    this.body.push({ k: "let", e: { k: "track", t, at: { k: "tick" } }, note: `${n.id}.${name} (live)` });
    return { k: "slot", i: this.body.length - 1 };
  }

  // wire > keyframes > constant, as the Skia Builder — except that keys
  // refuse and a static value is a leaf. One key is that key's value (what
  // the evaluator reads from a one-key block).
  override param(n: GraphNode, name: string, tick: PExpr): PExpr | undefined {
    const what = `${n.type} "${n.id}" ${name}`;
    if (this.paramEdge(n, name)) return super.param(n, name, tick);
    const block = liveBlock(n, name);
    if (block) {
      if (block.keyframes.length > 1) throw new Refusal(`${what} is keyframed inside the driver graph (AE has no inline form of toolbox's eases yet)`, true);
      const v = block.keyframes[0].value;
      if (typeof v !== "number" || !Number.isFinite(v)) throw new Refusal(`${what} has a keyframe that isn't a finite number`, false);
      return this.leaf(n, name, v);
    }
    const v = n.params[name];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "number") throw new Refusal(`${what} holds ${JSON.stringify(v)}, not a number`, false);
    return this.leaf(n, name, v);
  }

  // A def input: the wire, else a flatten-injected group default (a leaf).
  override input(n: GraphNode, socket: string, tick: PExpr, what: string): PExpr | undefined {
    const e = this.inputEdge(n, socket);
    if (e) return this.scalarFrom(e, tick, what);
    const o = n.inputOverrides?.[socket];
    if (o === undefined) return undefined;
    if (typeof o !== "number") throw new Refusal(`${what} takes a group default of type ${typeof o}`, false);
    return this.leaf(n, socket, o);
  }

  // A wired value coerced to a vector socket (coerce.ts): same kind passes,
  // a scalar broadcasts, a narrower vector widens (z = 0, w = 1); a wider one
  // coerces to nothing (undefined — the node falls back).
  vecFrom(edge: GraphEdge, target: Exclude<VecType, "scalar">, tick: PExpr): PExpr[] | undefined {
    const v = this.compile(edge.source, edge.sourceHandle, tick);
    const to = widthOf(target);
    if (v.type === target) return v.comps;
    if (v.type === "scalar") return new Array(to).fill(v.comps[0]);
    const from = widthOf(v.type);
    if (from > to) return undefined;
    return Array.from({ length: to }, (_, i) => (i < from ? v.comps[i] : i === 3 ? lit(1) : lit(0)));
  }

  override compile(id: string, handle: string, tick: PExpr): PVal {
    const n = this.node(id);
    if (!AE_EXTRA_VALUE_TYPES.has(n.type)) return super.compile(id, handle, tick);
    const key = `${id}|${handle}|${JSON.stringify(tick)}`;
    const hit = this.aeMemo.get(key);
    if (hit) return hit;
    if (this.aeVisiting.has(key)) throw new Refusal(`the driver graph has a cycle through "${id}"`, false);
    this.aeVisiting.add(key);
    if (n.bypassed) throw new Refusal(`driver "${id}" (${n.type}) is bypassed`, false);
    if (n.clips?.some((c) => c.enabled)) throw new Refusal(`driver "${id}" (${n.type}) sits on a clip window — a gated driver doesn't compile`, false);
    const aux = handle.startsWith("out:aux:") ? handle.slice(8) : null;
    if (handle !== "out:primary" && !(aux && ((n.type === "split-vec2" && aux === "y") || (n.type === "color-literal" && /^color\d+$/.test(aux)))))
      throw new Refusal(`driver "${id}" (${n.type}) is read through ${handle} — only its value outputs compile`, false);
    if (!this.nodes.some((x) => x.id === id)) this.nodes.push({ id, type: n.type });
    let v: PVal;
    switch (n.type) {
      case "clamp":
        v = this.clamp(n, tick);
        break;
      case "lerp":
        v = this.lerp(n, tick);
        break;
      case "remap":
        v = this.remap(n, tick);
        break;
      case "compare":
        v = this.compare(n, tick);
        break;
      case "logic":
        v = this.logic(n, tick);
        break;
      case "switch":
        v = this.switchNode(n, tick);
        break;
      case "float-curve":
        v = this.floatCurve(n, tick);
        break;
      case "split-vec2":
        v = this.splitVec2(n, tick, aux === "y" ? 1 : 0);
        break;
      case "combine-vec2":
        v = this.combineVec2(n, tick);
        break;
      case "vec2-literal":
      case "vec3-literal": {
        const names = n.type === "vec2-literal" ? ["x", "y"] : ["x", "y", "z"];
        v = { type: n.type === "vec2-literal" ? "vec2" : "vec3", comps: names.map((p) => this.param(n, p, tick) ?? lit(0)) };
        break;
      }
      case "color-literal":
        v = this.colorLiteral(n, tick, aux ? Number(aux.slice(5)) : 1);
        break;
      default:
        throw new Refusal(`"${id}" (${n.type}) has no AE lowering`, false);
    }
    v = { type: v.type, comps: v.comps.map((c, i) => this.let(c, `${n.id}${v.comps.length > 1 ? `[${i}]` : ""} (${n.type})`)) };
    this.aeVisiting.delete(key);
    this.aeMemo.set(key, v);
    return v;
  }

  // A scalar from the like-named input socket, else the param, else `dflt`
  // (clamp / compare / logic / combine-vec2 / float-curve read them so).
  private scalarIn(n: GraphNode, name: string, tick: PExpr, dflt: number): PExpr {
    return this.input(n, name, tick, `${n.type} "${n.id}" ${name}`) ?? this.param(n, name, tick) ?? lit(dflt);
  }

  // clamp.ts: lo / hi swapped when lo > hi, then max(lo, min(hi, v)).
  private clamp(n: GraphNode, tick: PExpr): PVal {
    const v = this.let(this.scalarIn(n, "value", tick, 0), `${n.id}.value`);
    const lo0 = this.let(this.scalarIn(n, "lo", tick, 0), `${n.id}.lo`);
    const hi0 = this.let(this.scalarIn(n, "hi", tick, 1), `${n.id}.hi`);
    const swap = this.let(cmp(">", lo0, hi0), `${n.id} lo > hi`);
    const lo = cond(swap, hi0, lo0);
    const hi = cond(swap, lo0, hi0);
    return { type: "scalar", comps: [max(lo, min(hi, v))] };
  }

  // lerp.ts, scalar and vec2 types (points / splines are geometry).
  private lerp(n: GraphNode, tick: PExpr): PVal {
    const type = this.staticParam(n, "type") ?? "scalar";
    if (type !== "scalar" && type !== "vec2") throw new Refusal(`Lerp "${n.id}" lerps ${String(type)} — only scalar and vec2 lerps are values`, false);
    let t = this.input(n, "t", tick, `Lerp "${n.id}" t`) ?? this.param(n, "t", tick) ?? lit(0.5);
    if (this.staticParam(n, "clamp")) t = max(lit(0), min(lit(1), t));
    const tt = this.let(t, `${n.id}.t`);
    const mix = (a: PExpr, b: PExpr) => bin("+", a, bin("*", bin("-", b, a), tt));
    if (type === "scalar") {
      const a = this.let(this.input(n, "a", tick, `Lerp "${n.id}" a`) ?? this.param(n, "a_value", tick) ?? lit(0));
      const b = this.let(this.input(n, "b", tick, `Lerp "${n.id}" b`) ?? this.param(n, "b_value", tick) ?? lit(1));
      return { type: "scalar", comps: [mix(a, b)] };
    }
    const vec = (s: "a" | "b") => {
      const e = this.inputEdge(n, s);
      return (e && this.vecFrom(e, "vec2", tick)) ?? [lit(0), lit(0)];
    };
    const a = vec("a").map((c) => this.let(c));
    const b = vec("b").map((c) => this.let(c));
    return { type: "vec2", comps: [mix(a[0], b[0]), mix(a[1], b[1])] };
  }

  // remap.ts, scalar mode: t = (v − in_min) / max(in_max − in_min, 1e-6),
  // optionally clamped, out_min + t·(out_max − out_min). The input socket
  // has no param fallback (an unwired input reads 0).
  private remap(n: GraphNode, tick: PExpr): PVal {
    const mode = this.staticParam(n, "mode") ?? "scalar";
    if (mode === "image") throw new Refusal(`Remap "${n.id}" runs in image mode (a per-pixel shader)`, false);
    if (this.inputEdge(n, "input_field")) throw new Refusal(`Remap "${n.id}" remaps a field`, false);
    const v = this.input(n, "input", tick, `Remap "${n.id}" input`) ?? lit(0);
    const inMin = this.let(this.param(n, "in_min", tick) ?? lit(0), `${n.id}.in_min`);
    const inMax = this.param(n, "in_max", tick) ?? lit(1);
    const outMin = this.let(this.param(n, "out_min", tick) ?? lit(0), `${n.id}.out_min`);
    const outMax = this.param(n, "out_max", tick) ?? lit(1);
    const range = max(bin("-", inMax, inMin), lit(1e-6));
    let t = bin("/", bin("-", v, inMin), range);
    if (this.staticParam(n, "clamp")) t = max(lit(0), min(lit(1), t));
    return { type: "scalar", comps: [bin("+", outMin, bin("*", t, bin("-", outMax, outMin)))] };
  }

  // compare.ts: 1 / 0; == and != within epsilon.
  private compare(n: GraphNode, tick: PExpr): PVal {
    const a = this.let(this.scalarIn(n, "a", tick, 0), `${n.id}.a`);
    const b = this.let(this.scalarIn(n, "b", tick, 0), `${n.id}.b`);
    const op = (this.staticParam(n, "op") as string) ?? ">";
    switch (op) {
      case ">":
      case "<":
      case ">=":
      case "<=":
        return { type: "scalar", comps: [cmp(op, a, b)] };
      case "==":
      case "!=": {
        const eps = this.param(n, "epsilon", tick) ?? lit(1e-4);
        return { type: "scalar", comps: [cmp(op === "==" ? "<=" : ">", call("abs", bin("-", a, b)), eps)] };
      }
    }
    throw new Refusal(`Compare "${n.id}" has an unknown op "${op}"`, false);
  }

  // logic.ts: any non-zero is true; 1 / 0. `not` reads a only.
  private logic(n: GraphNode, tick: PExpr): PVal {
    const op = (this.staticParam(n, "op") as string) ?? "and";
    const truth = (x: PExpr) => cmp("!=", x, lit(0));
    const a = truth(this.let(this.scalarIn(n, "a", tick, 0), `${n.id}.a`));
    if (op === "not") return { type: "scalar", comps: [cmp("==", a, lit(0))] };
    // Logic's resolveInputs drops b for `not` only: read it for the others.
    const b = truth(this.let(this.scalarIn(n, "b", tick, 0), `${n.id}.b`));
    switch (op) {
      case "and":
        return { type: "scalar", comps: [{ k: "and", a, b }] };
      case "or":
        return { type: "scalar", comps: [{ k: "or", a, b }] };
      case "xor":
        return { type: "scalar", comps: [cmp("!=", a, b)] };
    }
    throw new Refusal(`Logic "${n.id}" has an unknown op "${op}"`, false);
  }

  // The resolved output type of a wire's source (the evaluator's
  // connectedTypes, for Switch's auto type).
  private sourceType(e: GraphEdge): SocketType | undefined {
    const src = this.byId.get(e.source);
    const def = src && getNodeDef(src.type);
    if (!src || !def) return undefined;
    if (e.sourceHandle.startsWith("out:aux:")) return def.auxOutputs?.find((a) => a.name === e.sourceHandle.slice(8))?.type;
    try {
      return def.resolvePrimaryOutput?.(src.params, { connectedTypes: {} }) ?? def.primaryOutput ?? undefined;
    } catch {
      return def.primaryOutput ?? undefined;
    }
  }

  // switch.ts with a constant index: round, clamp into the slots, pass the
  // picked slot through (coerced to the switch's type). A wired index, or a
  // pick of an empty slot (the switch outputs nothing), refuses.
  private switchNode(n: GraphNode, tick: PExpr): PVal {
    if (this.inputEdge(n, "index")) throw new Refusal(`Switch "${n.id}" has a wired index — only a constant index compiles`, true);
    const slots = readSwitchSlots(n.params);
    const raw = this.param(n, "index", tick) ?? lit(0);
    const f = this.fold(raw);
    if (f.k !== "lit") throw new Refusal(`Switch "${n.id}" index is not a constant`, true);
    let i = Math.round(f.v);
    if (!Number.isFinite(i)) i = 0;
    if (i < 0) i = 0;
    if (i > slots.length - 1) i = slots.length - 1;
    const e = this.inputEdge(n, slots[i]);
    if (!e) throw new Refusal(`Switch "${n.id}" picks slot ${slots[i]}, which is empty (the switch outputs nothing)`, false);
    let type: SocketType;
    const t = n.params.type;
    if (switchTypeIsAuto(t)) {
      const wired = slots.map((s) => {
        const w = this.inputEdge(n, s);
        return w ? this.sourceType(w) : undefined;
      });
      type = unifySocketTypes(wired) ?? "scalar";
    } else type = typeof t === "string" ? (t as SocketType) : "scalar";
    if (type === "scalar") return { type: "scalar", comps: [this.scalarFrom(e, tick, `Switch "${n.id}" ${slots[i]}`)] };
    if (type === "vec2" || type === "vec3" || type === "vec4") {
      const comps = this.vecFrom(e, type, tick);
      if (!comps) throw new Refusal(`Switch "${n.id}" picks a wider vector than its ${type} type (it coerces to nothing)`, false);
      return { type, comps };
    }
    throw new Refusal(`Switch "${n.id}" switches ${type} values — only scalar / vector switches are values`, false);
  }

  // float-curve.ts: sampleFloatCurve(sanitizeFloatCurve(curve), v) — the
  // monotone cubic (engine/float-curve.ts evalMonotoneCubic) unrolled over
  // the static points: below the first x the first y, past the last the
  // last, else the first segment whose right end is ≥ x.
  private floatCurve(n: GraphNode, tick: PExpr): PVal {
    if (this.paramEdge(n, "curve") || liveBlock(n, "curve")) throw new Refusal(`Float Curve "${n.id}" curve is wired or keyframed`, true);
    const pts = sanitizeFloatCurve(n.params.curve, 0, 1);
    const m = computeMonotoneTangents(pts);
    const x = this.let(this.scalarIn(n, "value", tick, 0.5), `${n.id}.value`);
    const last = pts.length - 1;
    // One body per segment (t, t², t³ bound once each), chained from the
    // last back so the first segment whose right end is ≥ x wins — the
    // loop's break. x < the last x there, so the last segment needs no test.
    let seg: PExpr | undefined;
    for (let i = last - 1; i >= 0; i--) {
      const x0 = pts[i].x;
      const h = pts[i + 1].x - x0;
      let body: PExpr;
      if (h === 0) body = lit(pts[i].y);
      else {
        const t = this.let(bin("/", bin("-", x, lit(x0)), lit(h)), `${n.id} segment ${i} t`);
        const t2 = this.let(bin("*", t, t));
        const t3 = this.let(bin("*", t2, t));
        const h00 = bin("+", bin("-", bin("*", lit(2), t3), bin("*", lit(3), t2)), lit(1));
        const h10 = bin("+", bin("-", t3, bin("*", lit(2), t2)), t);
        const h01 = bin("+", bin("*", lit(-2), t3), bin("*", lit(3), t2));
        const h11 = bin("-", t3, t2);
        body = bin(
          "+",
          bin("+", bin("+", bin("*", h00, lit(pts[i].y)), bin("*", bin("*", h10, lit(h)), lit(m[i]))), bin("*", h01, lit(pts[i + 1].y))),
          bin("*", bin("*", h11, lit(h)), lit(m[i + 1]))
        );
      }
      seg = seg === undefined ? body : cond(cmp("<=", x, lit(pts[i + 1].x)), body, seg);
    }
    const out = cond(cmp("<=", x, lit(pts[0].x)), lit(pts[0].y), cond(cmp(">=", x, lit(pts[last].x)), lit(pts[last].y), seg ?? lit(pts[0].y)));
    return { type: "scalar", comps: [out] };
  }

  // split-vec2.ts: x (primary) / y (aux); a non-vec2 input reads 0.
  private splitVec2(n: GraphNode, tick: PExpr, i: 0 | 1): PVal {
    const e = this.inputEdge(n, "in");
    if (!e) return { type: "scalar", comps: [lit(0)] };
    const v = this.compile(e.source, e.sourceHandle, tick);
    // coerceValue: vec2 passes, a scalar broadcasts; anything else is nothing.
    if (v.type === "vec2") return { type: "scalar", comps: [v.comps[i]] };
    if (v.type === "scalar") return { type: "scalar", comps: [v.comps[0]] };
    return { type: "scalar", comps: [lit(0)] };
  }

  // combine-vec2.ts.
  private combineVec2(n: GraphNode, tick: PExpr): PVal {
    return { type: "vec2", comps: [this.scalarIn(n, "x", tick, 0), this.scalarIn(n, "y", tick, 0)] };
  }

  // color-literal.ts: [r, g, b, alpha] of color slot k (its hex), no palette.
  private colorLiteral(n: GraphNode, tick: PExpr, k: number): PVal {
    if (this.inputEdge(n, "image")) throw new Refusal(`Color "${n.id}" takes its palette from an image`, false);
    const count = Math.max(1, Math.min(64, Math.floor(typeof n.params.count === "number" ? n.params.count : 1)));
    if (k > count) throw new Refusal(`Color "${n.id}" has no color ${k}`, false);
    const name = k <= 1 ? "color" : `color${k}`;
    if (liveBlock(n, name) || this.paramEdge(n, name)) throw new Refusal(`Color "${n.id}" ${name} is keyframed or wired`, true);
    const hex = n.params[name];
    const [r, g, b] = hexRgb(typeof hex === "string" ? hex : "#ffffff");
    const a = this.param(n, "alpha", tick) ?? lit(1);
    return { type: "vec4", comps: [this.leaf(n, `${name}.r`, r), this.leaf(n, `${name}.g`, g), this.leaf(n, `${name}.b`, b), a] };
  }

  // random.ts. Seeded mode is the Skia lowering (hash01 of seed and frame —
  // the editor's own numbers). Frame mode draws Math.random() every
  // evaluation in the editor, so no export repeats it: AE's seedRandom(seed,
  // false) + random() — uniform draws that change per frame and are stable
  // across renders — through the same lo / hi / gauss arithmetic.
  override random(n: GraphNode, tick: PExpr): PVal {
    const mode = (this.staticParam(n, "mode") as string) ?? "seeded";
    if (mode === "seeded") {
      this.randoms.push({ id: n.id, mode: "seeded" });
      return super.random(n, tick);
    }
    if (mode !== "frame") throw new Refusal(`Random "${n.id}" has an unknown mode "${mode}"`, false);
    this.randoms.push({ id: n.id, mode: "frame" });
    const shape = (this.staticParam(n, "shape") as string) ?? "scalar";
    const dist = (this.staticParam(n, "distribution") as string) ?? "uniform";
    const lo = this.let(this.param(n, "lo", tick) ?? lit(0));
    const hi = this.let(this.param(n, "hi", tick) ?? lit(1));
    // The seed: a hash of the node id (seedRandom's offset).
    let h = 2166136261;
    for (let i = 0; i < n.id.length; i++) h = Math.imul(h ^ n.id.charCodeAt(i), 16777619);
    const r = this.rng(lit((h >>> 0) % 100000));
    this.aeRngs.add(r);
    const u = (): PExpr => ({ k: "rand", r });
    // Draws in the editor's order: u1, u2 (then u3, u4 for gauss).
    const u1 = this.let(u());
    const u2 = this.let(u());
    let rx: PExpr;
    let ry: PExpr;
    if (dist === "gauss") {
      const u3 = this.let(u());
      const u4 = this.let(u());
      const center = this.let(bin("/", bin("+", lo, hi), lit(2)));
      const sigma = this.let(bin("/", bin("/", bin("-", hi, lo), lit(2)), lit(3)));
      const gauss = (a: PExpr, b: PExpr) => bin("*", call("sqrt", bin("*", lit(-2), call("log", call("max", a, lit(1e-9))))), call("cos", bin("*", bin("*", lit(2), lit(Math.PI)), b)));
      rx = bin("+", center, bin("*", gauss(u1, u2), sigma));
      ry = bin("+", center, bin("*", gauss(u3, u4), sigma));
    } else {
      rx = bin("+", lo, bin("*", u1, bin("-", hi, lo)));
      ry = bin("+", lo, bin("*", u2, bin("-", hi, lo)));
    }
    return shape === "vec2" ? { type: "vec2", comps: [rx, ry] } : { type: "scalar", comps: [rx] };
  }
}

// Compile the value at `endpoint` ("<id>:out" | "<id>:aux:<name>") of the
// flattened graph on the clock `tl`. Throws Refusal.
export function compileEndpoint(b: AeBuilder, endpoint: string): { type: VecType; comps: PExpr[] } {
  const aux = /^(.*):aux:(.+)$/.exec(endpoint);
  const id = aux ? aux[1] : endpoint.replace(/:out$/, "");
  const handle = aux ? `out:aux:${aux[2]}` : "out:primary";
  const v = b.compile(id, handle, { k: "tick" });
  return { type: v.type, comps: v.comps };
}

// The finished program for a list of output components (AE units): the
// components bound to slots, then pruned to what any of them reads (prune
// marks from `out`, so a carrier call holds them all while it runs; the
// carrier is never evaluated or printed).
export function finishProgram(b: AeBuilder, outs: PExpr[], tl: ProceduralTimeline): { program: ProcProgram; outs: PExpr[] } {
  const bound = outs.map((o) => b.let(o));
  const all: ProcProgram = { body: b.body, out: { k: "call", fn: "__outs", args: bound }, tracks: b.tracks, curves: b.curves, nodes: b.nodes, fps: tl.fps, ticksPerFrame: tl.ticksPerFrame };
  const p = prune(all);
  const kept = (p.out as Extract<PExpr, { k: "call" }>).args;
  return { program: { ...p, out: kept[0] ?? lit(0) }, outs: kept };
}
