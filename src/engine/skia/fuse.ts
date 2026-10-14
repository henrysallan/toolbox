// Fuser — compiles a ShaderExpr call tree into ONE runtime effect
// (specdocs/101326_skia-target.md §3.3; the emitted program's shape is
// documented at the top of shader-expr.ts).
//
// The signature of fuseShader / FuseOptions / FuseResult is frozen
// (2026-10-13); this body is lane L2's.
//
// What it emits, in order:
//   uniform float3 iResolution; uniform float iTime;
//   uniform shader s<k>;            one per distinct leaf / program child
//   uniform … n<node>_<param>;      one per call param (arrays for `count`)
//   <helpers>                       deduped by id, dependencies first
//   float4 c<k>(float2 uv)          child wrapper: uv (Y-up 0..1) → Skia px,
//                                   then un-premultiply and convert the
//                                   working-space sample to sRGB
//   float4 g<k>(float2 uv);         prototypes, so library functions can
//                                   call the gather functions defined below
//   <library functions>             each once by entry; a function with
//                                   GATHER inputs is emitted once per
//                                   distinct set of gather edges, the first
//                                   under its own name, later copies with
//                                   every `<entry>…` identifier suffixed
//                                   `_G<j>` (its `$in(` tokens differ)
//   float4 g<k>(float2 uv) { … }    one per distinct gather upstream
//   half4 main(float2 fc) { … }     evaluate at uv, convert the sRGB result
//                                   to the working space, premultiply ONCE
//
// Color management (library/color-management.ts): the math between the
// boundaries is gamma sRGB whatever the destination; `color` params are
// plain float4 uniforms holding sRGB numbers (no layout(color)).
//
// Inside main and each g<k>, every distinct subexpression is evaluated once
// into a local `v<j>` (calls dedupe by node id, children by content), and
// pure inputs are passed to the entry as those locals.
//
// Determinism: the SkSL depends only on the expression's STRUCTURE (function
// ids, node ids, param types, edges), never on bind values, so animating a
// value keeps the program text, and CanvasKit's compile cache, unchanged.
// The one exception is two leaves whose content becomes equal or unequal:
// equal leaves share a child.
//
// Problems (unknown function id, missing / extra input or param, a bind of
// the wrong shape, a library function that fails validation, one node id
// fused twice with different content) are reported, never thrown.

import type { Bind, ShaderIR, SkslProgramIR } from "./scene-ir";
import type { ShaderExpr } from "./shader-expr";
import {
  GATHER_TOKEN_RE,
  getSkslFunction,
  resolveHelpers,
  skslTypeOf,
  skslTypeWidth,
  validateSkslFunction,
  type SkslLibFunctionDef,
} from "./library/registry";
import "./library/helpers";
import "./library/core";
import { SKSL_CM_HELPER } from "./library/color-management";

export interface FuseOptions {
  // Canvas px — becomes iResolution's value.
  resolution: [number, number];
  // Seconds — iTime's value. Its bind carries no ref: the exporter drives
  // iTime from the master clock.
  time: number;
}

export type FuseResult =
  | { shader: ShaderIR; problems: [] }
  | { shader: null; problems: string[] };

export function fuseShader(expr: ShaderExpr, opts: FuseOptions): FuseResult {
  switch (expr.k) {
    case "leaf":
      return { shader: expr.shader, problems: [] };
    case "program":
      return { shader: { k: "runtime", program: expr.program }, problems: [] };
    case "call":
      break;
  }
  try {
    const f = new Fuser();
    const program = f.run(expr, opts);
    if (f.problems.length || !program) return { shader: null, problems: dedupe(f.problems) };
    return { shader: { k: "runtime", program }, problems: [] };
  } catch (err) {
    return { shader: null, problems: [`fuser error: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

// The builtin binds every fused program declares.
export function builtinUniforms(opts: FuseOptions): Record<string, Bind<number | number[]>> {
  return {
    iResolution: { v: [opts.resolution[0], opts.resolution[1], 1] },
    iTime: { v: opts.time },
  };
}

// Node ids → identifier fragments, injectively: [A-Za-z0-9] stay, every
// other character (underscore included) becomes `_` + 2 hex digits, or
// `_u` + 6 hex digits past U+00FF. "noise-3" → "noise_2d3".
export function skslNodeIdent(id: string): string {
  let out = "";
  for (const ch of id) {
    if (/^[A-Za-z0-9]$/.test(ch)) {
      out += ch;
      continue;
    }
    const cp = ch.codePointAt(0) ?? 0;
    out += cp < 0x100 ? `_${cp.toString(16).padStart(2, "0")}` : `_u${cp.toString(16).padStart(6, "0")}`;
  }
  return out;
}

// The uniform a call param becomes.
export function skslUniformName(node: string, param: string): string {
  return `n${skslNodeIdent(node)}_${param}`;
}

// ---- cost ------------------------------------------------------------------------

export interface ShaderCostNode {
  node: string;
  fn: string;
  // Evaluations per output pixel (gather fan-out multiplies).
  evaluations: number;
  // evaluations × the function's relative ALU cost (one simplex octave ≈ 1).
  cost: number;
}

export interface ShaderCost {
  evaluations: number;
  cost: number;
  nodes: ShaderCostNode[];
}

// Taps assumed for a gather whose fan-out follows a param (the planner's
// convention, lib/glsl-translation/classes.ts).
export const PARAM_TAPS = 9;

// Per-pixel cost of the program fuseShader would emit for `expr`: each call
// counts once per evaluation of the body it sits in (main, or a gather
// function invoked `taps` times per evaluation of its caller). A child
// sample (leaf / program) counts one evaluation at cost 1. Unknown
// functions count at cost 1, so the estimate never throws.
export function estimateShaderCost(expr: ShaderExpr): ShaderCost {
  const byNode = new Map<string, ShaderCostNode>();
  const visit = (e: ShaderExpr, mult: number, seen: Set<string>, depth: number) => {
    if (depth > 256) return;
    const key = exprKey(e);
    if (seen.has(key)) return;
    seen.add(key);
    const fn = e.k === "call" ? getSkslFunction(e.fn) : undefined;
    const id = e.k === "leaf" ? key : e.node;
    const label = e.k === "call" ? e.fn : e.k;
    const unit = e.k === "call" ? (fn?.cost ?? 1) : 1;
    const row = byNode.get(id) ?? { node: id, fn: label, evaluations: 0, cost: 0 };
    row.evaluations += mult;
    row.cost += mult * unit;
    byNode.set(id, row);
    if (e.k !== "call") return;
    for (const [name, input] of Object.entries(e.inputs)) {
      const decl = fn?.inputs.find((i) => i.name === name);
      if (decl?.mode === "gather") {
        const taps = decl.taps === "param" ? PARAM_TAPS : (decl.taps ?? 1);
        visit(input, mult * taps, new Set(), depth + 1);
      } else {
        visit(input, mult, seen, depth + 1);
      }
    }
  };
  visit(expr, 1, new Set(), 0);
  const nodes = [...byNode.values()];
  return {
    evaluations: nodes.reduce((s, n) => s + n.evaluations, 0),
    cost: nodes.reduce((s, n) => s + n.cost, 0),
    nodes,
  };
}

// ---- implementation ---------------------------------------------------------------

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

// Dedupe key: calls and programs by node id, leaves by content.
function exprKey(e: ShaderExpr): string {
  switch (e.k) {
    case "call":
      return `call:${e.node}`;
    case "program":
      return `program:${e.node}`;
    case "leaf":
      return `leaf:${JSON.stringify(e.shader)}`;
  }
}

// Full content of a node's expression, to catch one node id fused twice with
// different content (inputs by key: they are checked when visited).
function exprContent(e: ShaderExpr): string {
  switch (e.k) {
    case "call": {
      const params = Object.keys(e.params)
        .sort()
        .map((k) => [k, e.params[k]?.v]);
      const inputs = Object.keys(e.inputs)
        .sort()
        .map((k) => [k, exprKey(e.inputs[k])]);
      return JSON.stringify([e.fn, params, inputs]);
    }
    case "program":
      return JSON.stringify(e.program);
    case "leaf":
      return exprKey(e);
  }
}

interface Body {
  locals: Map<string, string>;
  lines: string[];
  result?: string;
}

interface FnUse {
  name: string;
  source: string;
}

class Fuser {
  problems: string[] = [];
  private uniformDecls: string[] = [];
  private uniforms: Record<string, Bind<number | number[]>> = {};
  private children: { name: string; shader: ShaderIR }[] = [];
  private childByKey = new Map<string, number>();
  private gathers: Body[] = [];
  private gatherByKey = new Map<string, number>();
  private fnUses: FnUse[] = [];
  private fnUseByKey = new Map<string, string>();
  private fnCopies = new Map<string, number>();
  private fnOrder: SkslLibFunctionDef[] = [];
  private validated = new Set<string>();
  private content = new Map<string, { owner: ShaderExpr; content: string | null }>();
  private declaredNodes = new Set<string>();
  private onPath = new Set<ShaderExpr>();

  run(root: ShaderExpr, opts: FuseOptions): SkslProgramIR | null {
    Object.assign(this.uniforms, builtinUniforms(opts));
    const main: Body = { locals: new Map(), lines: [] };
    const top = this.evalIn(main, root, 0);
    if (this.problems.length) return null;

    const helperIds: string[] = [SKSL_CM_HELPER];
    for (const fn of this.fnOrder) helperIds.push(...(fn.uses ?? []));
    const helpers = resolveHelpers(helperIds);
    this.problems.push(...helpers.problems);
    if (this.problems.length) return null;

    const out: string[] = [];
    const calls = this.fnOrder.map((f) => f.id);
    out.push(`// Fused by toolbox (engine/skia/fuse.ts): ${calls.join(", ")}`);
    out.push("uniform float3 iResolution;");
    out.push("uniform float iTime;");
    for (const c of this.children) out.push(`uniform shader ${c.name};`);
    out.push(...this.uniformDecls);
    for (const h of helpers.order) out.push("", `// ---- ${h.id}`, h.source.trim());
    if (this.children.length) out.push("", "// ---- children (Skia px, premultiplied working space → uv, straight sRGB)");
    this.children.forEach((c, k) => {
      out.push(
        `float4 c${k}(float2 uv) {`,
        `  return tbx_cm_child(float4(${c.name}.eval(float2(uv.x * iResolution.x, (1.0 - uv.y) * iResolution.y))));`,
        `}`
      );
    });
    if (this.gathers.length) {
      out.push("");
      this.gathers.forEach((_g, k) => out.push(`float4 g${k}(float2 uv);`));
    }
    for (const u of this.fnUses) out.push("", u.source.trim());
    this.gathers.forEach((g, k) => {
      out.push("", `float4 g${k}(float2 uv) {`, ...g.lines.map((l) => `  ${l}`), `  return ${g.result ?? "float4(0.0)"};`, `}`);
    });
    out.push(
      "",
      "half4 main(float2 fc) {",
      "  float2 uv = float2(fc.x / iResolution.x, 1.0 - fc.y / iResolution.y);",
      ...main.lines.map((l) => `  ${l}`),
      `  float4 c = ${top};`,
      "  return tbx_cm_out(c);",
      "}"
    );
    return {
      sksl: out.join("\n") + "\n",
      uniforms: this.uniforms,
      children: this.children,
      fused: calls,
    };
  }

  // Evaluate `e` at the body's `uv`; returns the local holding it.
  private evalIn(body: Body, e: ShaderExpr, depth: number): string {
    const key = exprKey(e);
    this.checkContent(e, key);
    const hit = body.locals.get(key);
    if (hit) return hit;
    if (depth > 256 || this.onPath.has(e)) {
      this.problems.push("shader expression is cyclic or nested deeper than 256 calls");
      return "float4(0.0)";
    }
    let rhs: string;
    if (e.k === "call") {
      this.onPath.add(e);
      rhs = this.callIn(body, e, depth);
      this.onPath.delete(e);
    } else {
      rhs = `c${this.child(e, key)}(uv)`;
    }
    const local = `v${body.locals.size}`;
    body.locals.set(key, local);
    body.lines.push(`float4 ${local} = ${rhs};`);
    return local;
  }

  // The same node id must mean the same content everywhere it appears.
  // Compared only when a different object turns up under a known id (the
  // evaluator hands one value object to every consumer).
  private checkContent(e: ShaderExpr, key: string) {
    if (e.k === "leaf") return;
    const prev = this.content.get(key);
    if (!prev) {
      this.content.set(key, { owner: e, content: null });
      return;
    }
    if (prev.owner === e) return;
    prev.content ??= exprContent(prev.owner);
    if (prev.content !== exprContent(e)) {
      this.problems.push(`node ${e.node} appears twice in one shader with different content`);
    }
  }

  private child(e: Extract<ShaderExpr, { k: "leaf" | "program" }>, key: string): number {
    const known = this.childByKey.get(key);
    if (known !== undefined) return known;
    const k = this.children.length;
    this.children.push({
      name: `s${k}`,
      shader: e.k === "leaf" ? e.shader : { k: "runtime", program: e.program },
    });
    this.childByKey.set(key, k);
    return k;
  }

  private callIn(body: Body, e: Extract<ShaderExpr, { k: "call" }>, depth: number): string {
    const at = `node ${e.node} (${e.fn})`;
    const fn = getSkslFunction(e.fn);
    if (!fn) {
      this.problems.push(`${at}: unknown library function "${e.fn}"`);
      return "float4(0.0)";
    }
    if (!this.validated.has(fn.id)) {
      this.validated.add(fn.id);
      this.problems.push(...validateSkslFunction(fn));
    }
    for (const name of Object.keys(e.inputs)) {
      if (!fn.inputs.some((i) => i.name === name)) this.problems.push(`${at}: unknown input "${name}"`);
    }
    const args: string[] = [];
    const gatherMap: string[] = [];
    for (const decl of fn.inputs) {
      const input = e.inputs[decl.name];
      if (!input) {
        this.problems.push(`${at}: input "${decl.name}" is missing`);
        continue;
      }
      if (decl.mode === "gather") gatherMap.push(`g${this.gather(input, depth)}`);
      else args.push(this.evalIn(body, input, depth + 1));
    }
    const name = this.useFn(fn, gatherMap);
    const uniforms = this.declareParams(e, fn, at);
    return `${name}(uv, iResolution.xy${[...uniforms, ...args].map((a) => `, ${a}`).join("")})`;
  }

  // The g<k> that evaluates `e` at its own uv argument.
  private gather(e: ShaderExpr, depth: number): number {
    const key = exprKey(e);
    const known = this.gatherByKey.get(key);
    if (known !== undefined) return known;
    const k = this.gathers.length;
    const body: Body = { locals: new Map(), lines: [] };
    this.gathers.push(body);
    this.gatherByKey.set(key, k);
    body.result = this.evalIn(body, e, depth + 1);
    return k;
  }

  private useFn(fn: SkslLibFunctionDef, gatherMap: string[]): string {
    const useKey = `${fn.id}|${gatherMap.join(",")}`;
    const known = this.fnUseByKey.get(useKey);
    if (known) return known;
    const copy = this.fnCopies.get(fn.id) ?? 0;
    this.fnCopies.set(fn.id, copy + 1);
    if (copy === 0) this.fnOrder.push(fn);
    const name = copy === 0 ? fn.entry : `${fn.entry}_G${copy}`;
    const gathers = fn.inputs.filter((i) => i.mode === "gather").map((i) => i.name);
    let source = fn.source.replace(GATHER_TOKEN_RE, (_m, input: string) => {
      const idx = gathers.indexOf(input);
      return `${idx >= 0 ? gatherMap[idx] : input}(`;
    });
    if (copy > 0) source = source.replace(new RegExp(`\\b${fn.entry}(\\w*)`, "g"), `${name}$1`);
    this.fnUses.push({ name, source: `// ---- ${fn.id}${copy > 0 ? ` (gather copy ${copy})` : ""}\n${source.trim()}` });
    this.fnUseByKey.set(useKey, name);
    return name;
  }

  // Declares the call's uniforms (once per node) and returns their names in
  // the entry's param order.
  private declareParams(e: Extract<ShaderExpr, { k: "call" }>, fn: SkslLibFunctionDef, at: string): string[] {
    const names = fn.params.map((p) => skslUniformName(e.node, p.name));
    if (this.declaredNodes.has(e.node)) return names;
    this.declaredNodes.add(e.node);
    for (const k of Object.keys(e.params)) {
      if (!fn.params.some((p) => p.name === k)) this.problems.push(`${at}: unknown param "${k}"`);
    }
    fn.params.forEach((p, i) => {
      const name = names[i];
      const bind = e.params[p.name];
      if (!bind) {
        this.problems.push(`${at}: param "${p.name}" has no bind`);
        return;
      }
      const width = skslTypeWidth(p.type);
      const want = p.count !== undefined ? p.count * width : width;
      const v = bind.v;
      const ok = want === 1 && p.count === undefined ? typeof v === "number" : Array.isArray(v) && v.length === want;
      if (!ok) {
        const got = Array.isArray(v) ? `${v.length} numbers` : typeof v;
        this.problems.push(`${at}: param "${p.name}" is ${p.type}${p.count ? `[${p.count}]` : ""} (${want} number${want === 1 ? "" : "s"}) but its bind holds ${got}`);
        return;
      }
      if (name in this.uniforms) {
        this.problems.push(`${at}: uniform ${name} collides with another call's`);
        return;
      }
      // `color` params stay sRGB numbers: no layout(color) (the math is sRGB;
      // main converts its result instead — library/color-management.ts).
      const decl = `uniform ${skslTypeOf(p.type)} ${name}${p.count !== undefined ? `[${p.count}]` : ""};`;
      this.uniformDecls.push(decl);
      this.uniforms[name] = bind;
    });
    return names;
  }
}
