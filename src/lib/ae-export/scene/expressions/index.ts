// The value-graph → AE expression compiler, as the scene walk uses it (spec
// 091926_after-effects-handoff.md §3 rung 3, M4 lane 1).
//
// A walk site that would sample a wired driver per frame asks exprProp first:
// it names the toolbox params the AE property reads (wired → the driver's
// value graph, compiled; static → exprLeaf), how they become the AE value
// (`out`, in the IR, operation for operation what the site's sampler does),
// and the sampler itself (`oracle`). The compiled program is checked against
// that oracle at every frame of the layer's window before it is used — so an
// expression property shows exactly the per-frame keys it replaces at every
// frame, and stays live between and beyond them. Anything the compiler
// refuses, or a program that disagrees anywhere, falls back to the sampled
// keys with the reason in the report.
//
// Inside the walk an expression property is a one-key prop ({ keys: [k],
// dims, expression }): every site that tells static from animated by `"v" in`
// then treats it as animated, which it is. finalizeExpressionProps turns
// those into { v, expression } once the scene is built, so the AE project has
// no stray keyframe.

import type { PExpr } from "@/lib/skia-export/procedural/ir";
import { evaluateProgram } from "@/lib/skia-export/procedural/ir";
import { getNodeDef } from "@/engine/registry";
import type { AeProp, AeScene } from "../../types";
import type { WalkClock, WalkCtx } from "../context";
import { sourceEndpoint } from "../graph";
import { AeBuilder, compileEndpoint, finishProgram, Refusal, type ExprLeaf } from "./compile";
import { emitAeExpression, HEADER_MARK } from "./emit";

export { AE_EXTRA_VALUE_TYPES, type ExprLeaf } from "./compile";
export { emitAeExpression, scaleExpression, HEADER_MARK, OUT_LINE } from "./emit";

// A static value a compiled expression reads: a value node's param or group
// input inside the driver graph, or the consumer's own static param beside a
// wired one. Exposed knobs and group inputs arrive here as their current
// value (flatten folds them in). The Essential Properties lane links them:
// return { value, code } with `code` the AE expression that reads the live
// control, and the compiled expression reads that instead of the literal
// (the per-frame check still runs on `value`).
export function exprLeaf(ctx: WalkCtx, nodeId: string, param: string, value: number): ExprLeaf {
  void ctx;
  void nodeId;
  void param;
  return { value };
}

// What an AE property reads: a consumer param (wire > keys > constant; keys
// refuse), or a driver endpoint directly (`component` of its value, the
// sampler's numbersOf(value)[component] ?? fallback).
export type ExprInput = { node: string; param: string; fallback: number } | { endpoint: string; component?: number; fallback: number };

export interface ExprPropSpec {
  // The property, for the report and the expression's header ("radiusX").
  label: string;
  // The consumer's node id (its report line).
  owner: string;
  inputs: ExprInput[];
  // The AE value's components from the inputs' values, in AE units.
  out: (v: PExpr[]) => PExpr[];
  // The site's own sampler: the AE value at a tick of the layer's clock, one
  // number per `out` component — the per-frame keys this replaces.
  oracle: (tick: number) => number[];
  // Components of the scene value (a color is 3 while the expression
  // returns [r, g, b, 1]); 1 → a number. Default: every `out` component.
  keyLength?: number;
  // Leave the report to the caller's commit() (a site that needs several
  // props compiled before it uses any of them).
  defer?: boolean;
}

export type ExprPropResult = { prop: AeProp<unknown>; commit: () => void } | { refused: string };

const lit = (v: number): PExpr => ({ k: "lit", v });

// ---- the IR the sites write -----------------------------------------------------------------

export const ir = {
  lit,
  add: (a: PExpr, b: PExpr): PExpr => ({ k: "bin", op: "+", a, b }),
  sub: (a: PExpr, b: PExpr): PExpr => ({ k: "bin", op: "-", a, b }),
  mul: (a: PExpr, b: PExpr): PExpr => ({ k: "bin", op: "*", a, b }),
  // m.scale · v + m.offset — the walk's `apply` (context.ts), same order
  // (the identity map is v itself: 1·v + 0 only turns −0 into 0).
  affine: (v: PExpr, m: { scale: number; offset: number }): PExpr =>
    m.scale === 1 && m.offset === 0 ? v : { k: "bin", op: "+", a: { k: "bin", op: "*", a: lit(m.scale), b: v }, b: lit(m.offset) },
  // x < 0 ? 0 : x > 1 ? 1 : x — context.ts clamp01.
  clamp01: (x: PExpr): PExpr => ({ k: "cond", c: { k: "cmp", op: "<", a: x, b: lit(0) }, a: lit(0), b: { k: "cond", c: { k: "cmp", op: ">", a: x, b: lit(1) }, a: lit(1), b: x } }),
  max: (a: PExpr, b: PExpr): PExpr => ({ k: "call", fn: "max", args: [a, b] }),
};

// ---- param access (the walk's own rules, context.ts) -----------------------------------------

function driverOf(ctx: WalkCtx, nodeId: string, param: string): string | undefined {
  const w = ctx.graph.wireInto(nodeId, `in:param:${param}`);
  return w ? sourceEndpoint(w) : undefined;
}

// context.ts staticNumber: a one-key block's value, else the stored param.
function staticValue(ctx: WalkCtx, nodeId: string, param: string, fallback: number): number {
  const b = ctx.graph.block(nodeId, param);
  if (b && b.keyframes.length === 1) {
    const v = b.keyframes[0].value;
    return typeof v === "number" ? v : Array.isArray(v) ? ((v as number[])[0] ?? fallback) : fallback;
  }
  const v = ctx.graph.params(nodeId)[param];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function inputTerm(ctx: WalkCtx, b: AeBuilder, inp: ExprInput, drivers: string[]): PExpr {
  if ("endpoint" in inp) {
    drivers.push(inp.endpoint);
    return compileEndpoint(b, inp.endpoint).comps[inp.component ?? 0] ?? lit(inp.fallback);
  }
  const d = driverOf(ctx, inp.node, inp.param);
  if (d) {
    drivers.push(d);
    return compileEndpoint(b, d).comps[0];
  }
  if ((ctx.graph.block(inp.node, inp.param)?.keyframes.length ?? 0) > 1) throw new Refusal(`${inp.param} is keyframed beside a wired param of the same AE property`, true);
  const n = ctx.graph.node(inp.node);
  const v = staticValue(ctx, inp.node, inp.param, inp.fallback);
  return n ? b.leaf(n, inp.param, v) : lit(v);
}

const sameNumber = (a: number, b: number) => a === b || (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

const typeName = (t: string) => getNodeDef(t)?.name ?? t;

// The expression property for `spec`, or why it stays sampled.
export function exprProp(ctx: WalkCtx, clock: WalkClock, spec: ExprPropSpec): ExprPropResult {
  if (ctx.policy.drivers === "keys") return { refused: 'policy.drivers is "keys"' };
  const tl = { fps: ctx.fps, ticksPerFrame: ctx.tpf };
  const b = new AeBuilder(ctx.graph.flat.byId, ctx.graph.flat.wires, tl, (n, name, value) => exprLeaf(ctx, n.id, name, value));
  const drivers: string[] = [];
  try {
    const terms = spec.inputs.map((i) => inputTerm(ctx, b, i, drivers));
    if (!drivers.length) throw new Refusal("nothing it reads is wired", true);
    const { program, outs } = finishProgram(b, spec.out(terms), tl);
    const f0 = clock.inFrame;
    const f1 = Math.max(clock.inFrame, clock.outFrame - 1);
    const tickOf = (f: number) => f * ctx.tpf - clock.offsetTicks;
    // The static value under the expression: toolbox's at the first frame —
    // or, for AE's own RNG (the editor re-rolls Math.random()), the
    // program's own deterministic draw there.
    const first = b.aeRngs.size ? outs.map((o) => evaluateProgram({ ...program, out: o }, tickOf(f0))) : spec.oracle(tickOf(f0));
    // Everything but AE's own RNG must equal the sampler at every frame.
    if (!b.aeRngs.size) {
      for (let f = f0; f <= f1; f++) {
        const want = f === f0 ? first : spec.oracle(tickOf(f));
        for (let i = 0; i < outs.length; i++) {
          const got = evaluateProgram({ ...program, out: outs[i] }, tickOf(f));
          if (!sameNumber(got, want[i])) throw new Refusal(`the compiled expression gives ${got} at frame ${f} where toolbox gives ${want[i]} (component ${i})`, true);
        }
      }
    }
    const n = spec.keyLength ?? outs.length;
    const v = n === 1 ? first[0] : first.slice(0, n);
    // A value graph that is constant here (no clock, no live leaf) is a
    // static value, as a sampler that never changes is.
    if (!b.aeRngs.size && outs.every((o) => o.k === "lit")) {
      const commit = () => ctx.report.note(spec.owner, `${spec.label}: driven by ${[...new Set(drivers)].join(", ")}, constant here → a static value`);
      if (!spec.defer) commit();
      return { prop: { v }, commit };
    }
    const from = b.nodes.map((n) => `${typeName(n.type)} "${ctx.graph.name(n.id)}"`).join(" ← ");
    const expression = emitAeExpression(
      program,
      outs,
      {
        fps: ctx.fps,
        ticksPerFrame: ctx.tpf,
        offsetTicks: clock.offsetTicks,
        header: [`${ctx.graph.name(spec.owner)} · ${spec.label} ← ${from}`, "Generated by the toolbox AE export from the value graph, on this layer's toolbox clock."],
        leafCode: b.leafCode,
        aeRngs: b.aeRngs,
      },
      (o) => (o.length === 1 ? o[0] : `[${o.join(", ")}]`)
    );
    // Report: the consumer, every compiled node, Random by mode.
    const exact = !b.aeRngs.size;
    const commit = () => {
      ctx.report.note(spec.owner, `${spec.label}: driven by ${[...new Set(drivers)].join(", ")} → a live AE expression${exact ? ` (equal to toolbox at every frame ${f0}–${f1})` : ""}`);
      // Random first: exactAfterAll clears the plan's approx seed only on a
      // line with no other notes yet.
      for (const r of b.randoms) {
        if (r.mode === "seeded") ctx.report.exactAfterAll(r.id, "seeded: the expression hashes (seed, frame) exactly as the editor does — the same numbers");
        else ctx.report.approx(r.id, "frame mode re-rolls Math.random() every evaluation in the editor: AE draws seedRandom(seed, false) + random() — the same distribution, different (render-stable) numbers");
      }
      for (const x of b.nodes) {
        // A driver the plan didn't list (one feeding a fused node) gets its line.
        if (!ctx.plan.layers.some((L) => L.nodes.some((pn) => pn.id === x.id))) ctx.report.ensure(x.id, x.type, "expression", ctx.graph.name(x.id));
        ctx.report.note(x.id, `compiled into the AE expression on ${ctx.graph.name(spec.owner)} ${spec.label}`);
      }
    };
    if (!spec.defer) commit();
    return { prop: { keys: [{ t: f0 / ctx.fps, v, inInterp: "linear", outInterp: "linear" }], dims: Math.min(4, Math.max(1, n)) as 1 | 2 | 3 | 4, expression }, commit };
  } catch (e) {
    if (e instanceof Refusal) return { refused: e.message };
    // An emitter or lowering gap is a fallback, not a failed export.
    return { refused: `the expression compiler stopped: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// One-key expression props → { v, expression } (see the header), in place —
// props are shared by reference across the scene.
export function finalizeExpressionProps(scene: AeScene): void {
  const seen = new Set<object>();
  const visit = (x: unknown): void => {
    if (!x || typeof x !== "object" || seen.has(x)) return;
    seen.add(x);
    if (Array.isArray(x)) {
      x.forEach(visit);
      return;
    }
    const o = x as Record<string, unknown>;
    if (typeof o.expression === "string" && o.expression.startsWith(HEADER_MARK) && Array.isArray(o.keys) && o.keys.length === 1) {
      const k = o.keys[0] as { v: unknown };
      const expression = o.expression;
      for (const key of Object.keys(o)) delete o[key];
      o.v = k.v;
      o.expression = expression;
      return;
    }
    for (const v of Object.values(o)) visit(v);
  };
  visit(scene.comps);
}
