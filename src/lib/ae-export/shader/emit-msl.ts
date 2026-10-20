// MSL printer for a checked fused-GLSL program (ABI.md, "Bundle source").
// Prints exactly what check.ts annotated: names (renamed for keywords and
// shadowing), the resolved built-in / constructor forms, and C++ precedence
// (GLSL's, so parentheses appear only where the tree needs them).

import type { Expr, FnDecl, Stmt, VarDecl } from "./ast";
import type { Checked, UniformInfo } from "./check";
import { isPure } from "./check";
import { HELPERS } from "./builtins";
import { components, isMatrix, isScalar, isVector, mslTypeName, sameTy, type Ty } from "./glsl-types";
import type { GlslError } from "./tokenize";

export const MSL_ABI_VERSION = 1;

// Header line every bundle source starts with (validate.ts looks for it).
export const MSL_HEADER = `// Toolbox Shader bundle source, MSL ABI v${MSL_ABI_VERSION} — translated from GLSL ES 3.00 by toolbox (src/lib/ae-export/shader). Do not edit; see source.glsl.`;

// Helper emission order (stable output).
const HELPER_ORDER = ["tbx_mod", "tbx_isign", "tbx_radians", "tbx_degrees", "tbx_matrixCompMult", "tbx_outerProduct", "tbx_inverse"];

const POOL_ARRAY: Record<string, string> = { slider: "sliders", checkbox: "checkboxes", color: "colors" };

// C++ precedence levels (higher binds tighter).
const PREC: Record<string, number> = {
  "||": 3,
  "&&": 4,
  "|": 5,
  "^": 6,
  "&": 7,
  "==": 8,
  "!=": 8,
  "<": 9,
  ">": 9,
  "<=": 9,
  ">=": 9,
  "<<": 10,
  ">>": 10,
  "+": 11,
  "-": 11,
  "*": 12,
  "/": 12,
  "%": 12,
};
const P_COMMA = 1;
const P_ASSIGN = 2;
const P_UNARY = 13;
const P_POSTFIX = 14;
const P_PRIMARY = 15;

export interface EmitResult {
  msl: string;
  // lineMap[i] = the GLSL line behind MSL line i + 1 (0 = generated).
  lineMap: number[];
  errors: GlslError[];
}

class Printer {
  lines: string[] = [];
  map: number[] = [];
  depth = 0;
  line(text: string, glslLine = 0) {
    this.lines.push(text ? "  ".repeat(this.depth) + text : "");
    this.map.push(glslLine);
  }
}

export function emitMsl(c: Checked): EmitResult {
  const out = new Printer();
  const errors: GlslError[] = [];
  const structName = (s: string) => c.structs.get(s)?.msl ?? s;
  const tyName = (t: Ty) => mslTypeName(t, structName);
  let inMain = false;
  let switchTop = false;

  out.line(MSL_HEADER);
  for (const h of HELPER_ORDER) {
    if (!c.helpers.has(h)) continue;
    for (const l of HELPERS[h].split("\n")) out.line(l);
  }

  // Program scope, source order: structs, `constant` consts, baked picks.
  for (const d of c.program.decls) {
    if (d.k === "struct") {
      const info = c.structs.get(d.name)!;
      out.line(`struct ${info.msl} {`, d.line);
      out.depth++;
      for (const f of info.fields) out.line(`${tyName(f.ty)} ${f.msl};`, d.line);
      out.depth--;
      out.line("};", d.line);
    } else if (d.k === "global" && d.isConst) {
      for (const v of d.vars) if (v.sym && !v.sym.member) out.line(`constant ${tyName(v.sym.ty)} ${v.sym.msl} = ${initText(v)};`, v.line);
    } else if (d.k === "uniform") {
      const u = c.uniforms.find((x) => x.name === d.name);
      if (u?.binding?.kind === "enum") out.line(`constant int ${u.msl} = ${u.binding.value};`, d.line);
    }
  }

  const luts = c.uniforms.filter((u) => u.role === "lut").sort((a, b) => lutIndex(a) - lutIndex(b));
  const channels = c.uniforms.filter((u) => u.role === "channel" && u.binding?.kind !== "enum");

  out.line("struct TbxProgram {");
  out.depth++;
  out.line("float2 u_res; float u_time; float u_frame; float u_aspect;");
  out.line("TbxImage u_a, u_b, u_c, u_d;");
  for (const u of luts) out.line(`TbxImage ${u.msl};`, u.line);
  for (const u of channels) out.line(`${tyName(u.ty)} ${u.msl};`, u.line);
  if (c.memberUv) out.line("float2 v_uv{};");
  if (c.memberOut) out.line("float4 fragColor{};");
  for (const d of c.program.decls) {
    if (d.k !== "global") continue;
    for (const v of d.vars) {
      if (!v.sym?.member) continue;
      const t = tyName(v.sym.ty);
      if (d.isConst) out.line(`const ${t} ${v.sym.msl} = ${initText(v)};`, v.line);
      else out.line(v.init ? `${t} ${v.sym.msl} = ${initText(v)};` : `${t} ${v.sym.msl}{};`, v.line);
    }
  }

  out.line("");
  out.line("TbxProgram(constant TbxUniforms& U,");
  out.line("           TbxImage a, TbxImage b, TbxImage c, TbxImage d,");
  out.line("           TbxImage l0, TbxImage l1, TbxImage l2, TbxImage l3,");
  out.line("           TbxImage l4, TbxImage l5, TbxImage l6, TbxImage l7)");
  const inits = ["u_res(U.res)", "u_time(U.time)", "u_frame(U.frame)", "u_aspect(U.aspect)", "u_a(a)", "u_b(b)", "u_c(c)", "u_d(d)"];
  for (const u of luts) inits.push(`${u.msl}(l${lutIndex(u)})`);
  out.line(`  : ${inits.slice(0, 4).join(", ")},`);
  out.line(`    ${inits.slice(4).join(", ")}`);
  out.line("{");
  out.depth++;
  for (const u of channels) {
    const b = u.binding!;
    if (b.kind === "slider" || b.kind === "color") out.line(`this->${u.msl} = U.${POOL_ARRAY[b.kind]}[${b.slot - 1}];`, u.line);
    else if (b.kind === "checkbox") out.line(`this->${u.msl} = U.checkboxes[${b.slot - 1}] != 0;`, u.line);
  }
  out.depth--;
  out.line("}");

  for (const d of c.program.decls) {
    if (d.k !== "fn" || !d.body) continue;
    out.line("");
    fn(d);
  }
  out.depth--;
  out.line("};");

  return { msl: out.lines.join("\n") + "\n", lineMap: out.map, errors };

  // -----------------------------------------------------------------------

  function lutIndex(u: UniformInfo): number {
    return u.binding?.kind === "lut" ? u.binding.index : 0;
  }

  function fn(d: FnDecl) {
    inMain = d === c.main;
    if (inMain) {
      out.line("float4 shade(float2 v_uv) {", d.line);
      out.depth++;
      if (c.memberUv) out.line("this->v_uv = v_uv;");
      out.line(c.memberOut ? "fragColor = float4(0.0f);" : "float4 fragColor = float4(0.0f);");
    } else {
      const sig = d.sig!;
      const params = d.params.map((p, i) => {
        const t = tyName(sig.params[i].ty);
        const name = p.sym ? ` ${p.sym.msl}` : "";
        return p.qual === "in" ? `${t}${name}` : `thread ${t}&${name}`;
      });
      out.line(`${tyName(sig.ret)} ${sig.msl}(${params.join(", ")}) {`, d.line);
      out.depth++;
    }
    for (const s of d.body!.body) stmt(s);
    if (inMain) out.line("return fragColor;");
    out.depth--;
    out.line("}");
    inMain = false;
  }

  // -----------------------------------------------------------------------
  // Statements
  // -----------------------------------------------------------------------

  function body(s: Stmt) {
    out.depth++;
    if (s.k === "block") for (const b of s.body) stmt(b);
    else stmt(s);
    out.depth--;
  }

  function stmt(s: Stmt) {
    const wasSwitchTop = switchTop;
    if (s.k !== "case") switchTop = false;
    try {
      stmtInner(s, wasSwitchTop);
    } finally {
      switchTop = wasSwitchTop;
    }
  }

  function stmtInner(s: Stmt, atSwitchTop: boolean) {
    switch (s.k) {
      case "block":
        out.line("{", s.line);
        body(s);
        out.line("}");
        return;
      case "decl":
        for (const v of s.vars) {
          const t = tyName(v.sym!.ty);
          if (atSwitchTop) {
            // C++ won't jump past an initialized declaration (GLSL will):
            // declare bare, then assign.
            out.line(`${t} ${v.sym!.msl};`, v.line);
            out.line(`${v.sym!.msl} = ${v.init ? ex(v.init, P_ASSIGN) : `${t}{}`};`, v.line);
          } else out.line(`${declText(s.isConst, v)};`, v.line);
        }
        return;
      case "expr":
        out.line(`${ex(s.e, P_COMMA)};`, s.line);
        return;
      case "if": {
        out.line(`if (${ex(s.c, P_COMMA)}) {`, s.line);
        body(s.t);
        let f = s.f;
        while (f && f.k === "if") {
          out.line(`} else if (${ex(f.c, P_COMMA)}) {`, f.line);
          body(f.t);
          f = f.f;
        }
        if (f) {
          out.line("} else {");
          body(f);
        }
        out.line("}");
        return;
      }
      case "for": {
        let init = "";
        if (s.init?.k === "decl") {
          const d = s.init;
          const types = new Set(d.vars.map((v) => tyName(v.sym!.ty)));
          if (types.size > 1) errors.push({ line: d.line, message: "a for-init declaring variables of different types is not supported — declare them before the loop" });
          init = `${d.isConst ? "const " : ""}${[...types][0]} ${d.vars.map((v) => declNamePart(v)).join(", ")}`;
        } else if (s.init?.k === "expr") init = ex(s.init.e, P_COMMA);
        const c = s.c ? ex(s.c, P_COMMA) : "";
        const step = s.step ? ex(s.step, P_COMMA) : "";
        out.line(`for (${init}; ${c}; ${step}) {`, s.line);
        body(s.body);
        out.line("}");
        return;
      }
      case "while":
        out.line(`while (${ex(s.c, P_COMMA)}) {`, s.line);
        body(s.body);
        out.line("}");
        return;
      case "do":
        out.line("do {", s.line);
        body(s.body);
        out.line(`} while (${ex(s.c, P_COMMA)});`, s.c.line);
        return;
      case "switch":
        out.line(`switch (${ex(s.e, P_COMMA)}) {`, s.line);
        out.depth++;
        for (const b of s.body) {
          if (b.k === "case") {
            out.line(b.e ? `case ${ex(b.e, P_COMMA)}:` : "default:", b.line);
            continue;
          }
          out.depth++;
          switchTop = true;
          stmt(b);
          switchTop = false;
          out.depth--;
        }
        out.depth--;
        out.line("}");
        return;
      case "case":
        return;
      case "break":
      case "continue":
        out.line(`${s.k};`, s.line);
        return;
      case "discard":
        // The output is undefined after a discard in toolbox (the pool
        // target is not cleared); the host writes transparent.
        out.line("return float4(0.0f);", s.line);
        return;
      case "return":
        if (inMain) out.line("return fragColor;", s.line);
        else out.line(s.e ? `return ${ex(s.e, P_COMMA)};` : "return;", s.line);
        return;
      case "empty":
        return;
    }
  }

  function declNamePart(v: VarDecl): string {
    if (v.init) return `${v.sym!.msl} = ${initText(v)}`;
    return `${v.sym!.msl}{}`;
  }

  function declText(isConst: boolean, v: VarDecl): string {
    const t = tyName(v.sym!.ty);
    // Uninitialized locals are value-initialized: ANGLE (toolbox's WebGL)
    // zero-initializes them, so the host matches toolbox, not just GLSL.
    return `${isConst ? "const " : ""}${t} ${declNamePart(v)}`;
  }

  // Array constructors print as brace init in a declaration (ABI.md table).
  function initText(v: VarDecl): string {
    const e = v.init!;
    if (e.k === "call" && e.call?.kind === "array") return `{${e.args.map((a) => ex(a, P_ASSIGN)).join(", ")}}`;
    return ex(e, P_ASSIGN);
  }

  // -----------------------------------------------------------------------
  // Expressions
  // -----------------------------------------------------------------------

  function ex(e: Expr, min: number): string {
    const [text, prec] = exInner(e);
    return prec < min ? `(${text})` : text;
  }

  function exInner(e: Expr): [string, number] {
    switch (e.k) {
      case "lit":
        return [literal(e.lit, e.text), P_PRIMARY];
      case "id":
        return [e.sym!.msl, e.sym!.name === "gl_FragCoord" ? P_POSTFIX : P_PRIMARY];
      case "bin": {
        if (e.op === "^^") return [`(${ex(e.l, 9)} != ${ex(e.r, 9)})`, P_PRIMARY];
        const p = PREC[e.op];
        if ((e.op === "==" || e.op === "!=") && e.l.ty && isVector(e.l.ty)) {
          // GLSL vector == is one bool (all components); MSL's is a bvec.
          const fn = e.op === "==" ? "all" : "any";
          return [`${fn}(${ex(e.l, 9)} ${e.op} ${ex(e.r, 9)})`, P_POSTFIX];
        }
        return [`${ex(e.l, p)} ${e.op} ${ex(e.r, p + 1)}`, p];
      }
      case "un": {
        let operand = ex(e.e, P_UNARY);
        // `- -x` must not print as `--x`.
        if ((e.op === "-" || e.op === "+") && /^[-+]/.test(operand)) operand = `(${operand})`;
        return [`${e.op}${operand}`, P_UNARY];
      }
      case "post":
        return [`${ex(e.e, P_POSTFIX)}${e.op}`, P_POSTFIX];
      case "assign":
        return [`${ex(e.l, P_UNARY)} ${e.op} ${ex(e.r, P_ASSIGN)}`, P_ASSIGN];
      case "cond":
        return [`${ex(e.c, 3)} ? ${ex(e.t, P_COMMA)} : ${ex(e.f, P_ASSIGN)}`, P_ASSIGN];
      case "comma":
        return [`${ex(e.l, P_COMMA)}, ${ex(e.r, P_ASSIGN)}`, P_COMMA];
      case "index":
        return [`${ex(e.e, P_POSTFIX)}[${ex(e.i, P_COMMA)}]`, P_POSTFIX];
      case "field":
        return [`${ex(e.e, P_POSTFIX)}.${e.swizzle ?? e.member ?? e.name}`, P_POSTFIX];
      case "length":
        return [String(e.value ?? 0), P_PRIMARY];
      case "call":
        return [callText(e), P_POSTFIX];
    }
  }

  function callText(e: Expr & { k: "call" }): string {
    const args = e.args.map((a) => ex(a, P_ASSIGN));
    const info = e.call!;
    switch (info.kind) {
      case "user":
        return `${info.sig.msl}(${args.join(", ")})`;
      case "builtin":
        return info.impl.emit(args, (i, p) => ex(e.args[i], p));
      case "struct":
        return `${structName(info.ty.s!)}{${args.join(", ")}}`;
      case "array":
        return `${tyName(info.ty)}{${args.join(", ")}}`;
      case "ctor":
        return ctorText(info.ty, e.args);
    }
  }

  // Convert an argument's base type (GLSL constructors convert; spell it).
  function conv(a: Expr, base: Ty["b"], n: number): string {
    const t = a.ty!;
    if (t.b === base) return ex(a, P_ASSIGN);
    const target = n > 1 ? `${base}${n}` : base;
    return `${target}(${ex(a, P_ASSIGN)})`;
  }

  function ctorText(t: Ty, args: Expr[]): string {
    const name = tyName(t);
    const a0 = args[0];
    const t0 = a0.ty!;
    if (isScalar(t)) {
      // float(v) / float(m) take the first component.
      if (isVector(t0)) return `${name}(${ex(a0, P_POSTFIX)}.x)`;
      if (isMatrix(t0)) return `${name}(${ex(a0, P_POSTFIX)}[0][0])`;
      return `${name}(${ex(a0, P_ASSIGN)})`;
    }
    if (isVector(t)) {
      if (args.length === 1 && isScalar(t0)) return `${name}(${conv(a0, t.b, 1)})`;
      // One vector: MSL's converting constructor does the base change.
      if (args.length === 1 && isVector(t0)) return `${name}(${t0.n > t.n ? `${ex(a0, P_POSTFIX)}.${"xyzw".slice(0, t.n)}` : ex(a0, P_ASSIGN)})`;
      const parts: string[] = [];
      let have = 0;
      for (const a of args) {
        const at = a.ty!;
        const k = components(at);
        const take = Math.min(k, t.n - have);
        let text: string;
        if (take < k) {
          // GLSL drops the unused tail of the last argument; MSL needs a swizzle.
          text = take === 1 ? `${ex(a, P_POSTFIX)}.x` : `${ex(a, P_POSTFIX)}.${"xyzw".slice(0, take)}`;
          if (at.b !== t.b) text = `${take > 1 ? `${t.b}${take}` : t.b}(${text})`;
        } else text = conv(a, t.b, k);
        parts.push(text);
        have += take;
      }
      return `${name}(${parts.join(", ")})`;
    }
    // Matrices (columns × rows, column-major on both sides).
    const C = t.m;
    const R = t.n;
    if (args.length === 1 && isScalar(t0)) return `${name}(${conv(a0, "float", 1)})`;
    if (args.length === 1 && isMatrix(t0)) {
      if (sameTy(t0, t)) return `${name}(${ex(a0, P_ASSIGN)})`;
      const m = ex(a0, P_POSTFIX);
      const cols: string[] = [];
      for (let i = 0; i < C; i++) {
        if (i < t0.m) {
          if (t0.n >= R) cols.push(t0.n === R ? `${m}[${i}]` : `${m}[${i}].${"xyzw".slice(0, R)}`);
          else {
            const tail = [];
            for (let j = t0.n; j < R; j++) tail.push(j === i ? "1.0f" : "0.0f");
            cols.push(`float${R}(${m}[${i}], ${tail.join(", ")})`);
          }
        } else {
          const comps = [];
          for (let j = 0; j < R; j++) comps.push(j === i ? "1.0f" : "0.0f");
          cols.push(`float${R}(${comps.join(", ")})`);
        }
      }
      return `${name}(${cols.join(", ")})`;
    }
    // A component list regrouped into R-component columns.
    const cols: string[] = [];
    let pieces: { text: string; k: number }[] = [];
    let filled = 0;
    for (const a of args) {
      const at = a.ty!;
      const k = components(at);
      let off = 0;
      while (off < k) {
        const take = Math.min(k - off, R - filled);
        let text: string;
        if (take === k) text = conv(a, "float", k);
        else {
          if (!isPure(a)) errors.push({ line: a.line, message: "a vector argument spans two matrix columns — assign it to a variable first" });
          const sw = "xyzw".slice(off, off + take);
          text = `${ex(a, P_POSTFIX)}.${sw}`;
          if (at.b !== "float") text = `${take > 1 ? `float${take}` : "float"}(${text})`;
        }
        pieces.push({ text, k: take });
        filled += take;
        off += take;
        if (filled === R) {
          cols.push(pieces.length === 1 && pieces[0].k === R ? pieces[0].text : `float${R}(${pieces.map((p) => p.text).join(", ")})`);
          pieces = [];
          filled = 0;
        }
      }
    }
    return `${name}(${cols.join(", ")})`;
  }
}

// GLSL literal → MSL literal: floats get an f suffix (MSL has no double).
function literal(kind: string, text: string): string {
  if (kind === "float") return `${text.replace(/[fF]$/, "")}f`;
  return text;
}
