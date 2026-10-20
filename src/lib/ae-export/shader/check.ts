// Semantic pass for the fused-GLSL translator: resolves names and overloads,
// types every expression (GLSL ES 3.00 has no implicit conversions, so the
// types are exact), classifies the uniforms against the Toolbox Shader ABI,
// and refuses — with the GLSL line — anything the MSL side can't express.
// The emitter (emit-msl.ts) only prints what this pass annotated.

import type { Expr, FnDecl, FnSig, Program, Stmt, StructDecl, Sym, TypeSpec, VarDecl } from "./ast";
import { BUILTIN_NAMES, resolveBuiltin } from "./builtins";
import {
  builtinType,
  components,
  elemOf,
  glslName,
  isMatrix,
  isNumeric,
  isScalar,
  isVector,
  mat,
  sameTy,
  scalarOf,
  T,
  vec,
  withArray,
  type Ty,
} from "./glsl-types";
import { isMslReserved } from "./names";
import type { GlslError } from "./tokenize";

// How one channel uniform reaches the program (bundle.ts assigns these from
// the node's channels; glslToMsl auto-assigns float / bool / vec4 / LUTs when
// none are given).
export type MslBinding =
  | { kind: "slider"; slot: number }
  | { kind: "checkbox"; slot: number }
  | { kind: "color"; slot: number }
  | { kind: "enum"; value: number }
  | { kind: "lut"; index: number };

export type ImageSlot = "a" | "b" | "c" | "d";

export interface UniformInfo {
  name: string;
  msl: string;
  ty: Ty;
  line: number;
  role: "image" | "template" | "channel" | "lut";
  image?: ImageSlot;
  binding?: MslBinding;
}

export interface StructInfo {
  decl: StructDecl;
  msl: string;
  fields: { name: string; msl: string; ty: Ty }[];
}

export interface Checked {
  program: Program;
  errors: GlslError[];
  uniforms: UniformInfo[];
  structs: Map<string, StructInfo>;
  main?: FnDecl;
  // Members instead of shade()'s parameter / local, because a helper reads
  // v_uv (or gl_FragCoord) / touches fragColor.
  memberUv: boolean;
  memberOut: boolean;
  helpers: Set<string>;
  inputs: Set<ImageSlot>;
  readsTime: boolean;
}

const ERR: Ty = { b: "void", n: 1, m: 0, s: "<error>" };
const isErr = (t: Ty | undefined) => t === ERR;

const TEMPLATE_UNIFORMS: Record<string, Ty> = {
  u_res: vec("float", 2),
  u_time: T.float,
  u_frame: T.float,
  u_aspect: T.float,
};
const IMAGE_UNIFORMS: Record<string, ImageSlot> = { u_a: "a", u_b: "b", u_c: "c", u_d: "d" };
const LUT_RE = /^u_(?:ramp|curve)_[A-Za-z_][A-Za-z0-9_]*$/;
const SWIZZLE_SETS = ["xyzw", "rgba", "stpq"];

class Scope {
  vars = new Map<string, Sym>();
  constructor(public parent: Scope | null) {}
  lookup(name: string): Sym | undefined {
    return this.vars.get(name) ?? this.parent?.lookup(name);
  }
}

interface FnCtx {
  decl: FnDecl;
  isMain: boolean;
  calls: Set<FnSig>;
  refs: Set<string>;
  loopDepth: number;
  switchDepth: number;
}

export function checkProgram(
  program: Program,
  identifiers: Iterable<string>,
  bindings: Record<string, MslBinding> | undefined
): Checked {
  const errors: GlslError[] = [];
  const err = (line: number, message: string) => errors.push({ line, message });

  // Every identifier spelled anywhere, so renames never collide with one.
  const taken = new Set<string>(identifiers);
  const fresh = (base: string): string => {
    for (let k = 1; k < 10_000; k++) {
      let c = `${base}_${k}`;
      if (isMslReserved(c)) c += "_"; // FLT_MAX_1 could be a macro; FLT_MAX_1_ can't
      if (!taken.has(c) && !isMslReserved(c)) {
        taken.add(c);
        return c;
      }
    }
    throw new Error(`no free MSL name for "${base}"`);
  };
  const safeNames = new Map<string, string>();
  // Keyword rename (ABI.md "Names"): `<name>_`, deterministic per name.
  const safe = (name: string): string => {
    if (!isMslReserved(name)) return name;
    let s = safeNames.get(name);
    if (!s) {
      s = !taken.has(`${name}_`) && !isMslReserved(`${name}_`) ? `${name}_` : fresh(name);
      taken.add(s);
      safeNames.set(name, s);
    }
    return s;
  };

  const structs = new Map<string, StructInfo>();
  const fns = new Map<string, FnSig[]>();
  const uniforms: UniformInfo[] = [];
  const global = new Scope(null);
  const helpers = new Set<string>();
  const fnCtxs: FnCtx[] = [];
  let main: FnDecl | undefined;
  let inVar: Sym | undefined;
  let outVar: Sym | undefined;
  // gl_FragCoord is the only gl_ input with an exact host equivalent:
  // v_uv × u_res is the pixel centre, Y-up, like gl_FragCoord.xy.
  const fragCoord: Sym = { kind: "builtin", name: "gl_FragCoord", msl: "float4(v_uv * u_res, 0.5f, 1.0f)", ty: vec("float", 4) };
  let lutAuto = 0;
  const autoSlots = { slider: 0, checkbox: 0, color: 0 };

  // ---------------------------------------------------------------------
  // Types
  // ---------------------------------------------------------------------

  function baseType(spec: TypeSpec): Ty {
    const b = builtinType(spec.name);
    if (b) return b;
    if (structs.has(spec.name)) return { b: "struct", n: 1, m: 0, s: spec.name };
    err(spec.line, `unknown type "${spec.name}"`);
    return ERR;
  }

  // The declared type with its array suffix folded. -1 = unsized (taken
  // from the initializer).
  function declType(spec: TypeSpec, nameArray: Expr | "unsized" | undefined, line: number, scope: Scope): Ty {
    const base = baseType(spec);
    if (isErr(base)) return ERR;
    if (spec.array !== undefined && nameArray !== undefined) {
      err(line, "arrays of arrays are not supported");
      return ERR;
    }
    const arr = spec.array ?? nameArray;
    if (arr === undefined) return base;
    if (base.b === "sampler") {
      err(line, "arrays of samplers are not supported");
      return ERR;
    }
    if (arr === "unsized") return withArray(base, -1);
    const n = foldInt(arr, scope);
    if (n === undefined || n < 1) {
      err(line, "array size must be a positive constant integer expression");
      return ERR;
    }
    return withArray(base, n);
  }

  // ---------------------------------------------------------------------
  // Pass 1: file scope
  // ---------------------------------------------------------------------

  for (const d of program.decls) {
    switch (d.k) {
      case "struct": {
        if (structs.has(d.name) || builtinType(d.name)) {
          err(d.line, `struct "${d.name}" redeclares a type`);
          break;
        }
        const fields: StructInfo["fields"] = [];
        const seen = new Set<string>();
        for (const f of d.fields) {
          if (seen.has(f.name)) err(f.line, `duplicate field "${f.name}"`);
          seen.add(f.name);
          const ty = declType(f.type, f.array, f.line, global);
          if (ty.a === -1) err(f.line, "struct fields need an explicit array size");
          if (ty.b === "sampler") err(f.line, "samplers inside structs are not supported");
          fields.push({ name: f.name, msl: safe(f.name), ty });
        }
        const info: StructInfo = { decl: d, msl: safe(d.name), fields };
        d.msl = info.msl;
        structs.set(d.name, info);
        break;
      }
      case "uniform":
        declareUniform(d.type, d.name, d.line);
        break;
      case "io": {
        const ty = baseType(d.type);
        if (d.dir === "in") {
          if (inVar) err(d.line, "only one `in` variable (the template's v_uv) is supported");
          else if (!sameTy(ty, vec("float", 2))) err(d.line, `the \`in\` variable must be vec2 (the template's v_uv), not ${glslName(ty)}`);
          inVar = { kind: "builtin", name: d.name, msl: "v_uv", ty };
          declareGlobal(inVar, d.line);
        } else {
          if (outVar) err(d.line, "only one `out` variable (the template's fragColor) is supported");
          else if (!sameTy(ty, vec("float", 4))) err(d.line, `the \`out\` variable must be vec4 (the template's fragColor), not ${glslName(ty)}`);
          outVar = { kind: "builtin", name: d.name, msl: "fragColor", ty };
          declareGlobal(outVar, d.line);
        }
        break;
      }
      case "global":
        for (const v of d.vars) {
          let ty = declType(d.type, v.array, v.line, global);
          if (ty.b === "sampler") {
            err(v.line, "sampler variables must be uniforms");
            ty = ERR;
          }
          if (d.isConst && !v.init) err(v.line, `const "${v.name}" needs an initializer`);
          if (v.init) ty = checkInit(v, ty, global, null);
          else if (ty.a === -1) {
            err(v.line, "an unsized array needs an initializer");
            ty = ERR;
          }
          const sym: Sym = { kind: d.isConst ? "const" : "global", name: v.name, msl: safe(v.name), ty };
          if (d.isConst && v.init && (ty.b === "int" || ty.b === "uint") && isScalar(ty)) sym.constValue = foldInt(v.init, global);
          if (d.isConst && v.init) sym.member = !constexprSafe(v.init);
          if (!d.isConst) sym.member = true;
          v.sym = sym;
          declareGlobal(sym, v.line);
        }
        break;
      case "fn":
        declareFn(d);
        break;
    }
  }

  if (!outVar) err(1, "no `out vec4 fragColor` — the translator expects the GLSL Expression template");
  if (!main) err(1, "no `void main()` definition");

  // ---------------------------------------------------------------------
  // Pass 2: function bodies
  // ---------------------------------------------------------------------

  for (const d of program.decls) {
    if (d.k !== "fn" || !d.body || !d.sig) continue;
    const ctx: FnCtx = { decl: d, isMain: d === main, calls: new Set(), refs: new Set(), loopDepth: 0, switchDepth: 0 };
    fnCtxs.push(ctx);
    const scope = new Scope(global);
    d.params.forEach((p, i) => {
      if (!p.name) return;
      const ty = d.sig!.params[i].ty;
      const sym: Sym = { kind: "param", name: p.name, msl: safe(p.name), ty, outParam: p.qual !== "in" };
      if (scope.vars.has(p.name)) err(p.line, `duplicate parameter "${p.name}"`);
      p.sym = sym;
      scope.vars.set(p.name, sym);
    });
    // The body shares the parameters' scope (GLSL: redeclaring a param in
    // the outermost block is an error, as in C++).
    for (const s of d.body.body) stmt(s, scope, ctx);
  }

  // ---------------------------------------------------------------------
  // Reachability: inputs and the clock are what main() can actually reach.
  // ---------------------------------------------------------------------

  const inputs = new Set<ImageSlot>();
  let readsTime = false;
  const reach = new Set<FnCtx>();
  const byDecl = new Map(fnCtxs.map((c) => [c.decl, c]));
  const stack = fnCtxs.filter((c) => c.isMain);
  while (stack.length) {
    const c = stack.pop()!;
    if (reach.has(c)) continue;
    reach.add(c);
    for (const sig of c.calls) {
      const callee = sig.decl && byDecl.get(sig.decl);
      if (callee) stack.push(callee);
    }
  }
  for (const c of reach) {
    for (const r of c.refs) {
      if (r in IMAGE_UNIFORMS) inputs.add(IMAGE_UNIFORMS[r]);
      if (r === "u_time" || r === "u_frame") readsTime = true;
    }
  }
  let memberUv = false;
  let memberOut = false;
  for (const c of fnCtxs) {
    if (c.isMain) continue;
    if (inVar && c.refs.has(inVar.name)) memberUv = true;
    if (c.refs.has("gl_FragCoord")) memberUv = true;
    if (outVar && c.refs.has(outVar.name)) memberOut = true;
  }

  return { program, errors, uniforms, structs, main, memberUv, memberOut, helpers, inputs, readsTime };

  // ---------------------------------------------------------------------
  // Declarations
  // ---------------------------------------------------------------------

  function declareGlobal(sym: Sym, line: number) {
    if (global.vars.has(sym.name) || fns.has(sym.name)) err(line, `"${sym.name}" is declared twice`);
    global.vars.set(sym.name, sym);
  }

  function declareUniform(spec: TypeSpec, name: string, line: number) {
    const ty = declType(spec, undefined, line, global);
    if (isErr(ty)) return;
    const info: UniformInfo = { name, msl: safe(name), ty, line, role: "channel" };
    if (name in IMAGE_UNIFORMS) {
      if (ty.b !== "sampler") err(line, `${name} must be a sampler2D`);
      info.role = "image";
      info.image = IMAGE_UNIFORMS[name];
    } else if (name in TEMPLATE_UNIFORMS) {
      if (!sameTy(ty, TEMPLATE_UNIFORMS[name])) err(line, `${name} must be ${glslName(TEMPLATE_UNIFORMS[name])}`);
      info.role = "template";
    } else if (ty.b === "sampler") {
      if (!LUT_RE.test(name)) {
        err(line, `sampler "${name}" is neither an image input (u_a…u_d) nor a ramp/curve LUT (u_ramp_* / u_curve_*)`);
        return;
      }
      info.role = "lut";
      const b = bindings?.[name] ?? { kind: "lut", index: lutAuto++ };
      if (b.kind !== "lut") err(line, `uniform ${name} is a sampler but its binding is "${b.kind}"`);
      info.binding = b;
    } else if (name.startsWith("u_")) {
      err(line, `unknown template uniform "${name}"`);
      return;
    } else {
      const want = sameTy(ty, T.float)
        ? "slider"
        : sameTy(ty, T.bool)
          ? "checkbox"
          : sameTy(ty, vec("float", 4))
            ? "color"
            : sameTy(ty, T.int)
              ? "enum"
              : null;
      if (!want) {
        err(line, `uniform ${glslName(ty)} ${name}: channel uniforms must be float (slider), bool (checkbox), vec4 (color) or int (a baked pick)`);
        return;
      }
      const given = bindings?.[name];
      if (!given && want === "enum") {
        err(line, `int uniform "${name}" needs a baked value (pick channels are baked into the shader)`);
        return;
      }
      const b: MslBinding = given ?? { kind: want as "slider" | "checkbox" | "color", slot: ++autoSlots[want as "slider" | "checkbox" | "color"] };
      if (b.kind !== want) err(line, `uniform ${glslName(ty)} ${name} cannot bind to a ${b.kind}`);
      info.binding = b;
    }
    uniforms.push(info);
    const sym: Sym = { kind: "uniform", name, msl: info.msl, ty };
    if (info.binding?.kind === "enum") {
      sym.kind = "const";
      sym.constValue = info.binding.value;
    }
    declareGlobal(sym, line);
  }

  function declareFn(d: FnDecl) {
    const ret = declType(d.ret, undefined, d.line, global);
    if (ret.a === -1) err(d.line, "functions cannot return unsized arrays");
    if (ret.b === "sampler") err(d.line, "functions cannot return samplers");
    const params: FnSig["params"] = d.params.map((p) => {
      const ty = declType(p.type, p.array, p.line, global);
      if (ty.a === -1) err(p.line, "array parameters need an explicit size");
      if (ty.b === "sampler" && p.qual !== "in") err(p.line, "sampler parameters must be `in`");
      if (ty.b === "void") err(p.line, "void parameter");
      return { ty, qual: p.qual };
    });
    if (d.name === "main") {
      if (!d.body) return; // prototype
      if (main) err(d.line, "main() is defined twice");
      if (ret.b !== "void" || params.length) err(d.line, "main must be `void main()`");
      main = d;
    } else if (d.name.startsWith("gl_")) err(d.line, `"${d.name}" is reserved`);
    if (BUILTIN_NAMES.has(d.name)) err(d.line, `"${d.name}" redefines a built-in function`);
    if (global.vars.has(d.name)) err(d.line, `"${d.name}" is already a variable`);
    const list = fns.get(d.name) ?? [];
    let sig = list.find((s) => s.params.length === params.length && s.params.every((p, i) => sameTy(p.ty, params[i].ty)));
    if (sig) {
      if (d.body && sig.decl?.body) err(d.line, `function "${d.name}" is defined twice with the same parameters`);
      if (!sameTy(sig.ret, ret)) err(d.line, `function "${d.name}" redeclared with a different return type`);
    } else {
      sig = { name: d.name, msl: d.name === "main" ? "shade" : safe(d.name), params, ret, decl: null };
      list.push(sig);
      fns.set(d.name, list);
    }
    if (d.body) {
      sig.decl = d;
      sig.params = params;
    }
    d.sig = sig;
  }

  // Global / local initializer: check, fill an unsized array's length.
  function checkInit(v: VarDecl, ty: Ty, scope: Scope, ctx: FnCtx | null): Ty {
    const it = expr(v.init!, scope, ctx);
    if (isErr(ty) || isErr(it)) return isErr(ty) ? ERR : ty;
    if (ty.a === -1) {
      if (it.a === undefined || !sameTy(elemOf(it), elemOf(ty))) {
        err(v.line, `cannot initialize ${glslName(elemOf(ty))}[] from ${glslName(it)}`);
        return ERR;
      }
      return it;
    }
    if (!sameTy(ty, it)) err(v.line, `cannot initialize ${glslName(ty)} "${v.name}" with ${glslName(it)}`);
    return ty;
  }

  // ---------------------------------------------------------------------
  // Statements
  // ---------------------------------------------------------------------

  function stmt(s: Stmt, scope: Scope, ctx: FnCtx) {
    switch (s.k) {
      case "block": {
        const inner = new Scope(scope);
        for (const b of s.body) stmt(b, inner, ctx);
        return;
      }
      case "decl":
        for (const v of s.vars) declareLocal(s.isConst, s.type, v, scope, ctx);
        return;
      case "expr":
        expr(s.e, scope, ctx);
        return;
      case "if":
        cond(s.c, scope, ctx, "if");
        stmt(s.t, new Scope(scope), ctx);
        if (s.f) stmt(s.f, new Scope(scope), ctx);
        return;
      case "for": {
        const loop = new Scope(scope);
        if (s.init) stmt(s.init, loop, ctx);
        if (s.c) cond(s.c, loop, ctx, "for");
        if (s.step) expr(s.step, loop, ctx);
        ctx.loopDepth++;
        stmt(s.body, new Scope(loop), ctx);
        ctx.loopDepth--;
        return;
      }
      case "while":
        cond(s.c, scope, ctx, "while");
        ctx.loopDepth++;
        stmt(s.body, new Scope(scope), ctx);
        ctx.loopDepth--;
        return;
      case "do":
        ctx.loopDepth++;
        stmt(s.body, new Scope(scope), ctx);
        ctx.loopDepth--;
        cond(s.c, scope, ctx, "do-while");
        return;
      case "switch": {
        const t = expr(s.e, scope, ctx);
        if (!isErr(t) && !(isScalar(t) && (t.b === "int" || t.b === "uint"))) err(s.line, "switch needs an int or uint selector");
        const inner = new Scope(scope);
        ctx.switchDepth++;
        const seen = new Set<number>();
        for (const b of s.body) {
          if (b.k === "case") {
            if (!b.e) continue;
            const ct = expr(b.e, inner, ctx);
            const v = foldInt(b.e, inner);
            if (v === undefined) err(b.line, "case labels must be constant integer expressions");
            else if (seen.has(v)) err(b.line, `duplicate case ${v}`);
            else seen.add(v);
            if (!isErr(ct) && !isErr(t) && !sameTy(ct, t)) err(b.line, "case label type differs from the switch selector");
          } else stmt(b, inner, ctx);
        }
        ctx.switchDepth--;
        return;
      }
      case "case":
        err(s.line, "case label outside a switch");
        return;
      case "break":
        if (!ctx.loopDepth && !ctx.switchDepth) err(s.line, "break outside a loop or switch");
        return;
      case "continue":
        if (!ctx.loopDepth) err(s.line, "continue outside a loop");
        return;
      case "discard":
        // main() returns transparent for it (emit-msl.ts); a helper can't
        // end the invocation.
        if (!ctx.isMain) err(s.line, "discard is only supported in main() (it returns transparent); in a helper, return a flag instead");
        return;
      case "return": {
        const want = ctx.decl.sig?.ret ?? T.void;
        if (!s.e) {
          if (want.b !== "void" && !isErr(want)) err(s.line, `missing return value in "${ctx.decl.name}"`);
          return;
        }
        const t = expr(s.e, scope, ctx);
        if (!isErr(t) && !isErr(want) && !sameTy(t, want)) err(s.line, `return ${glslName(t)} from a function returning ${glslName(want)}`);
        return;
      }
      case "empty":
        return;
    }
  }

  function cond(e: Expr, scope: Scope, ctx: FnCtx | null, what: string) {
    const t = expr(e, scope, ctx);
    if (!isErr(t) && !sameTy(t, T.bool)) err(e.line, `${what} condition must be bool, not ${glslName(t)}`);
  }

  function declareLocal(isConst: boolean, spec: TypeSpec, v: VarDecl, scope: Scope, ctx: FnCtx) {
    let ty = declType(spec, v.array, v.line, scope);
    if (ty.b === "sampler") {
      err(v.line, "local sampler variables are not supported — pass the uniform directly");
      ty = ERR;
    }
    if (isConst && !v.init) err(v.line, `const "${v.name}" needs an initializer`);
    // GLSL: the new name's scope starts AFTER its initializer, so
    // `float k = k * 2.0;` reads the outer k. Check the initializer first.
    if (v.init) ty = checkInit(v, ty, scope, ctx);
    else if (ty.a === -1) {
      err(v.line, "an unsized array needs an initializer");
      ty = ERR;
    }
    if (ty.b === "void" && !isErr(ty)) err(v.line, "void variable");
    if (scope.vars.has(v.name)) err(v.line, `"${v.name}" is already declared in this scope`);
    // C++ starts the scope at the declarator, so a shadowing local gets a
    // fresh MSL name and the initializer still reads the outer one.
    const shadows = !!scope.lookup(v.name) || fns.has(v.name) || structs.has(v.name);
    const sym: Sym = { kind: "local", name: v.name, msl: shadows ? fresh(v.name) : safe(v.name), ty };
    if (isConst && v.init && (ty.b === "int" || ty.b === "uint") && isScalar(ty)) sym.constValue = foldInt(v.init, scope);
    v.sym = sym;
    scope.vars.set(v.name, sym);
  }

  // ---------------------------------------------------------------------
  // Expressions
  // ---------------------------------------------------------------------

  function expr(e: Expr, scope: Scope, ctx: FnCtx | null): Ty {
    const t = exprInner(e, scope, ctx);
    e.ty = t;
    return t;
  }

  function exprInner(e: Expr, scope: Scope, ctx: FnCtx | null): Ty {
    switch (e.k) {
      case "lit":
        return e.lit === "float" ? T.float : e.lit === "int" ? T.int : e.lit === "uint" ? T.uint : T.bool;
      case "id": {
        let sym = scope.lookup(e.name);
        if (!sym && e.name === "gl_FragCoord") sym = fragCoord;
        if (!sym) {
          if (e.name.startsWith("gl_")) err(e.line, `${e.name} is not available in the Toolbox Shader host (only gl_FragCoord maps: v_uv × u_res)`);
          else if (fns.has(e.name)) err(e.line, `function "${e.name}" used as a value`);
          else err(e.line, `undeclared identifier "${e.name}"`);
          return ERR;
        }
        e.sym = sym;
        // File-scope names only: reachability reads inputs / the clock and
        // helpers' use of v_uv / fragColor off these.
        if (sym.kind !== "local" && sym.kind !== "param") ctx?.refs.add(sym.name);
        return sym.ty;
      }
      case "bin":
        return binary(e, scope, ctx);
      case "un": {
        const t = expr(e.e, scope, ctx);
        if (isErr(t)) return ERR;
        if (e.op === "!") {
          if (!sameTy(t, T.bool)) return typeErr(e.line, `! needs a bool, not ${glslName(t)}`);
          return t;
        }
        if (e.op === "~") {
          if (!(t.a === undefined && t.m === 0 && (t.b === "int" || t.b === "uint"))) return typeErr(e.line, `~ needs an int or uint`);
          return t;
        }
        if (!isNumeric(t) || t.b === "bool") return typeErr(e.line, `unary ${e.op} needs a number, not ${glslName(t)}`);
        if (e.op === "++" || e.op === "--") assignable(e.e, `${e.op}`);
        return t;
      }
      case "post": {
        const t = expr(e.e, scope, ctx);
        if (isErr(t)) return ERR;
        if (!isNumeric(t)) return typeErr(e.line, `${e.op} needs a number`);
        assignable(e.e, e.op);
        return t;
      }
      case "assign": {
        const lt = expr(e.l, scope, ctx);
        const rt = expr(e.r, scope, ctx);
        assignable(e.l, "assignment");
        if (isErr(lt) || isErr(rt)) return lt;
        if (e.op === "=") {
          if (!sameTy(lt, rt)) return typeErr(e.line, `cannot assign ${glslName(rt)} to ${glslName(lt)}`);
          return lt;
        }
        const r = arith(e.op.slice(0, -1), lt, rt, e.line);
        if (!isErr(r) && !sameTy(r, lt)) return typeErr(e.line, `${glslName(lt)} ${e.op} ${glslName(rt)} changes the type`);
        return lt;
      }
      case "cond": {
        cond(e.c, scope, ctx, "?:");
        const a = expr(e.t, scope, ctx);
        const b = expr(e.f, scope, ctx);
        if (isErr(a) || isErr(b)) return ERR;
        if (!sameTy(a, b)) return typeErr(e.line, `?: branches differ (${glslName(a)} vs ${glslName(b)})`);
        if (a.a !== undefined) return typeErr(e.line, "?: on arrays is not supported");
        return a;
      }
      case "comma":
        expr(e.l, scope, ctx);
        return expr(e.r, scope, ctx);
      case "call":
        return call(e, scope, ctx);
      case "index": {
        const t = expr(e.e, scope, ctx);
        const it = expr(e.i, scope, ctx);
        if (isErr(t) || isErr(it)) return ERR;
        if (!(isScalar(it) && (it.b === "int" || it.b === "uint"))) return typeErr(e.line, "index must be an int or uint");
        if (t.a !== undefined) return elemOf(t);
        if (isMatrix(t)) return vec("float", t.n);
        if (isVector(t)) return scalarOf(t);
        return typeErr(e.line, `cannot index ${glslName(t)}`);
      }
      case "field": {
        const t = expr(e.e, scope, ctx);
        if (isErr(t)) return ERR;
        if (t.b === "struct" && t.a === undefined) {
          const f = structs.get(t.s!)?.fields.find((x) => x.name === e.name);
          if (!f) return typeErr(e.line, `struct ${t.s} has no field "${e.name}"`);
          e.member = f.msl;
          return f.ty;
        }
        if (isVector(t) || (isScalar(t) && t.b !== "struct")) {
          if (isScalar(t)) return typeErr(e.line, `cannot swizzle a scalar (.${e.name})`);
          const set = SWIZZLE_SETS.find((s) => [...e.name].every((c) => s.includes(c)));
          if (!set || e.name.length > 4) return typeErr(e.line, `bad swizzle ".${e.name}"`);
          const idx = [...e.name].map((c) => set.indexOf(c));
          if (idx.some((i) => i >= t.n)) return typeErr(e.line, `swizzle ".${e.name}" reads past ${glslName(t)}`);
          // MSL has xyzw and rgba; stpq maps to xyzw.
          e.swizzle = set === "stpq" ? idx.map((i) => "xyzw"[i]).join("") : e.name;
          return e.name.length === 1 ? scalarOf(t) : vec(t.b, e.name.length);
        }
        return typeErr(e.line, `${glslName(t)} has no field "${e.name}"`);
      }
      case "length": {
        const t = expr(e.e, scope, ctx);
        if (isErr(t)) return ERR;
        if (t.a !== undefined) e.value = t.a;
        else if (isMatrix(t)) e.value = t.m;
        else if (isVector(t)) e.value = t.n;
        else return typeErr(e.line, `.length() on ${glslName(t)}`);
        return T.int;
      }
    }
  }

  function typeErr(line: number, message: string): Ty {
    err(line, message);
    return ERR;
  }

  function assignable(e: Expr, what: string) {
    const why = lvalueProblem(e);
    if (why) err(e.line, `${what}: ${why}`);
  }

  function lvalueProblem(e: Expr): string | null {
    switch (e.k) {
      case "id": {
        const s = e.sym;
        if (!s) return null;
        if (s.kind === "local" || s.kind === "param" || s.kind === "global") return null;
        if (s === outVar) return null;
        if (s.kind === "const") return `"${s.name}" is const`;
        if (s.kind === "uniform") return `uniform "${s.name}" is read-only`;
        return `"${s.name}" is read-only`;
      }
      case "field":
        if (e.swizzle && new Set(e.swizzle).size !== e.swizzle.length) return `swizzle ".${e.name}" repeats a component`;
        return lvalueProblem(e.e);
      case "index":
        return lvalueProblem(e.e);
      default:
        return "not an lvalue";
    }
  }

  function binary(e: Expr & { k: "bin" }, scope: Scope, ctx: FnCtx | null): Ty {
    const l = expr(e.l, scope, ctx);
    const r = expr(e.r, scope, ctx);
    if (isErr(l) || isErr(r)) return ERR;
    switch (e.op) {
      case "&&":
      case "||":
      case "^^":
        if (!sameTy(l, T.bool) || !sameTy(r, T.bool)) return typeErr(e.line, `${e.op} needs bool operands`);
        return T.bool;
      case "<":
      case ">":
      case "<=":
      case ">=":
        if (!isScalar(l) || !sameTy(l, r) || l.b === "bool") return typeErr(e.line, `${e.op} needs two scalars of one numeric type (use lessThan() etc. for vectors)`);
        return T.bool;
      case "==":
      case "!=":
        if (!sameTy(l, r)) return typeErr(e.line, `${e.op} compares ${glslName(l)} with ${glslName(r)}`);
        if (isMatrix(l) || l.a !== undefined || l.b === "struct" || l.b === "sampler")
          return typeErr(e.line, `${e.op} on ${glslName(l)} is not supported — compare components`);
        return T.bool;
      default:
        return arith(e.op, l, r, e.line);
    }
  }

  // + - * / % << >> & | ^ (also the compound assignments).
  function arith(op: string, l: Ty, r: Ty, line: number): Ty {
    if (l.a !== undefined || r.a !== undefined || l.b === "struct" || r.b === "struct" || l.b === "sampler" || r.b === "sampler")
      return typeErr(line, `${op} on ${glslName(l)} and ${glslName(r)}`);
    if (l.b === "bool" || r.b === "bool") return typeErr(line, `${op} on bool`);
    if (op === "<<" || op === ">>") {
      // GLSL: int and uint may mix in a shift; the result is the left type.
      if (l.b === "float" || r.b === "float" || isMatrix(l) || isMatrix(r)) return typeErr(line, `${op} needs integers`);
      if (!(isScalar(r) || r.n === l.n)) return typeErr(line, `${op} shift count must be a scalar or match`);
      return l;
    }
    if (l.b !== r.b) return typeErr(line, `${op} mixes ${glslName(l)} and ${glslName(r)} (GLSL has no implicit conversions)`);
    if (op === "%" || op === "&" || op === "|" || op === "^") {
      if (l.b === "float" || isMatrix(l) || isMatrix(r)) return typeErr(line, `${op} needs integers`);
    }
    if (op === "*" && (isMatrix(l) || isMatrix(r))) {
      if (isMatrix(l) && isMatrix(r)) {
        if (l.m !== r.n) return typeErr(line, `cannot multiply ${glslName(l)} by ${glslName(r)}`);
        return mat(r.m, l.n);
      }
      if (isMatrix(l) && isVector(r)) {
        if (l.m !== r.n) return typeErr(line, `cannot multiply ${glslName(l)} by ${glslName(r)}`);
        return vec("float", l.n);
      }
      if (isVector(l) && isMatrix(r)) {
        if (l.n !== r.n) return typeErr(line, `cannot multiply ${glslName(l)} by ${glslName(r)}`);
        return vec("float", r.m);
      }
    }
    if (sameTy(l, r)) return l;
    if (isScalar(l)) return r;
    if (isScalar(r)) return l;
    return typeErr(line, `${op} on ${glslName(l)} and ${glslName(r)}`);
  }

  // ---------------------------------------------------------------------
  // Calls and constructors
  // ---------------------------------------------------------------------

  function call(e: Expr & { k: "call" }, scope: Scope, ctx: FnCtx | null): Ty {
    const argTys = e.args.map((a) => expr(a, scope, ctx));
    if (argTys.some(isErr)) return ERR;
    const bt = builtinType(e.callee);

    if (e.array !== undefined) {
      const elem = bt ?? (structs.has(e.callee) ? ({ b: "struct", n: 1, m: 0, s: e.callee } as Ty) : null);
      if (!elem) return typeErr(e.line, `unknown array element type "${e.callee}"`);
      if (elem.b === "sampler" || elem.b === "void") return typeErr(e.line, `arrays of ${e.callee} are not supported`);
      const n = e.array === "unsized" ? e.args.length : foldInt(e.array, scope);
      if (n === undefined || n < 1) return typeErr(e.line, "array constructor size must be a positive constant");
      if (n !== e.args.length) return typeErr(e.line, `${e.callee}[${n}] constructor has ${e.args.length} arguments`);
      for (let i = 0; i < argTys.length; i++)
        if (!sameTy(argTys[i], elem)) return typeErr(e.line, `array element ${i} is ${glslName(argTys[i])}, not ${glslName(elem)}`);
      const ty = withArray(elem, n);
      e.call = { kind: "array", ty };
      return ty;
    }

    if (bt) {
      if (bt.b === "void" || bt.b === "sampler") return typeErr(e.line, `cannot construct ${e.callee}`);
      const problem = ctorProblem(bt, argTys, e.args);
      if (problem) return typeErr(e.line, `${e.callee}(…): ${problem}`);
      e.call = { kind: "ctor", ty: bt };
      return bt;
    }

    const st = structs.get(e.callee);
    if (st) {
      const ty: Ty = { b: "struct", n: 1, m: 0, s: e.callee };
      if (argTys.length !== st.fields.length) return typeErr(e.line, `${e.callee}(…) needs ${st.fields.length} arguments`);
      for (let i = 0; i < argTys.length; i++)
        if (!sameTy(argTys[i], st.fields[i].ty))
          return typeErr(e.line, `${e.callee}(…) field "${st.fields[i].name}" is ${glslName(st.fields[i].ty)}, got ${glslName(argTys[i])}`);
      e.call = { kind: "struct", ty };
      return ty;
    }

    const overloads = fns.get(e.callee);
    if (overloads) {
      const sig = overloads.find((s) => s.params.length === argTys.length && s.params.every((p, i) => sameTy(p.ty, argTys[i])));
      if (!sig) return typeErr(e.line, `no overload of ${e.callee}(${argTys.map(glslName).join(", ")})`);
      if (sig.name === "main") return typeErr(e.line, "main() cannot be called");
      sig.params.forEach((p, i) => {
        if (p.qual !== "in") outArg(e.args[i], `argument ${i + 1} of ${e.callee}`);
      });
      e.call = { kind: "user", sig };
      ctx?.calls.add(sig);
      return sig.ret;
    }

    const b = resolveBuiltin(e.callee, argTys, e.args);
    if (b === null) return typeErr(e.line, `unknown function "${e.callee}"`);
    if ("error" in b) return typeErr(e.line, b.error);
    for (const i of b.outArgs ?? []) outArg(e.args[i], `argument ${i + 1} of ${e.callee}`);
    for (const h of b.helpers ?? []) helpers.add(h);
    e.call = { kind: "builtin", name: e.callee, impl: b };
    return b.ret;
  }

  function outArg(a: Expr, what: string) {
    const why = lvalueProblem(a);
    if (why) {
      err(a.line, `${what} is an out/inout parameter: ${why}`);
      return;
    }
    // MSL can't bind a `thread T&` to a vector element (swizzle or v[i]).
    let x: Expr = a;
    for (;;) {
      if (x.k === "field" && x.swizzle) break;
      if (x.k === "index" && x.e.ty && isVector(x.e.ty)) break;
      if (x.k === "field" || x.k === "index") {
        x = x.e;
        continue;
      }
      return;
    }
    err(a.line, `${what} is an out/inout parameter: MSL can't pass a vector component or swizzle by reference — copy it to a local, call, and copy back`);
  }

  // Why a built-in constructor's arguments don't fit, or null.
  function ctorProblem(t: Ty, args: Ty[], nodes: Expr[]): string | null {
    if (!args.length) return "needs arguments";
    for (const a of args) {
      if (a.a !== undefined || a.b === "struct" || a.b === "sampler" || a.b === "void") return `cannot build from ${glslName(a)}`;
    }
    if (isScalar(t)) return args.length === 1 ? null : "a scalar constructor takes one argument";
    if (args.length === 1 && isScalar(args[0])) return null; // splat / diagonal
    if (isVector(t)) {
      if (args.length === 1 && isMatrix(args[0])) return "building a vector from a matrix is not supported";
      if (args.some(isMatrix)) return "mixing matrices into a vector constructor is not supported";
      let have = 0;
      for (let i = 0; i < args.length; i++) {
        if (have >= t.n) return "too many arguments";
        have += components(args[i]);
      }
      if (have < t.n) return `needs ${t.n} components, got ${have}`;
      return null;
    }
    // Matrix.
    if (args.length === 1 && isMatrix(args[0])) {
      if (args[0].m === t.m && args[0].n === t.n) return null;
      return isPure(nodes[0]) ? null : "resizing a matrix expression — assign it to a variable first";
    }
    if (args.some(isMatrix)) return "mixing a matrix with other arguments is not supported";
    let have = 0;
    let col = 0;
    for (let i = 0; i < args.length; i++) {
      const c = components(args[i]);
      // A vector that straddles two columns is read twice: only plain names.
      if (isVector(args[i]) && Math.floor(col / t.n) !== Math.floor((col + c - 1) / t.n) && !isPure(nodes[i]))
        return "a vector argument spans two columns — assign it to a variable first";
      have += c;
      col += c;
    }
    if (have !== t.m * t.n) return `needs ${t.m * t.n} components, got ${have}`;
    return null;
  }

  // ---------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------

  function foldInt(e: Expr, scope: Scope): number | undefined {
    switch (e.k) {
      case "lit":
        if (e.lit !== "int" && e.lit !== "uint") return undefined;
        return parseIntLiteral(e.text);
      case "id": {
        const s = scope.lookup(e.name);
        return s?.constValue;
      }
      case "length":
        if (e.value !== undefined) return e.value;
        if (!e.e.ty) expr(e, scope, null);
        return e.value;
      case "un": {
        const v = foldInt(e.e, scope);
        if (v === undefined) return undefined;
        return e.op === "-" ? -v : e.op === "+" ? v : e.op === "~" ? ~v : undefined;
      }
      case "bin": {
        const a = foldInt(e.l, scope);
        const b = foldInt(e.r, scope);
        if (a === undefined || b === undefined) return undefined;
        switch (e.op) {
          case "+":
            return (a + b) | 0;
          case "-":
            return (a - b) | 0;
          case "*":
            return Math.imul(a, b);
          case "/":
            return b === 0 ? undefined : Math.trunc(a / b);
          case "%":
            return b === 0 ? undefined : a % b;
          case "<<":
            return a << b;
          case ">>":
            return a >> b;
          case "&":
            return a & b;
          case "|":
            return a | b;
          case "^":
            return a ^ b;
        }
        return undefined;
      }
      case "call":
        if ((e.callee === "int" || e.callee === "uint") && e.args.length === 1) return foldInt(e.args[0], scope);
        return undefined;
      default:
        return undefined;
    }
  }

  // Can this const initializer live at program scope as `constant`? MSL
  // refuses initializers that need code at load time ("global constructors"),
  // so a built-in call (sqrt(2.0)) or a vector == (all(…)) keeps the const
  // as a TbxProgram member instead.
  function constexprSafe(e: Expr): boolean {
    switch (e.k) {
      case "lit":
        return true;
      case "id":
        return e.sym?.kind === "const" && !e.sym.member;
      case "bin":
        if ((e.op === "==" || e.op === "!=") && e.l.ty && isVector(e.l.ty)) return false;
        return constexprSafe(e.l) && constexprSafe(e.r);
      case "un":
        return constexprSafe(e.e);
      case "cond":
        return constexprSafe(e.c) && constexprSafe(e.t) && constexprSafe(e.f);
      case "call":
        if (e.call?.kind === "builtin" || e.call?.kind === "user") return false;
        return e.args.every(constexprSafe);
      case "field":
      case "index":
        return constexprSafe(e.e) && (e.k !== "index" || constexprSafe(e.i));
      case "length":
        return true;
      default:
        return false;
    }
  }
}

// A side-effect-free expression that may be printed more than once.
export function isPure(e: Expr): boolean {
  switch (e.k) {
    case "id":
    case "lit":
      return true;
    case "field":
      return isPure(e.e);
    case "index":
      return isPure(e.e) && isPure(e.i);
    default:
      return false;
  }
}

export function parseIntLiteral(text: string): number {
  const t = text.replace(/[uU]$/, "");
  if (/^0[xX]/.test(t)) return parseInt(t.slice(2), 16) | 0;
  if (/^0[0-7]+$/.test(t)) return parseInt(t, 8) | 0;
  return parseInt(t, 10) | 0;
}

