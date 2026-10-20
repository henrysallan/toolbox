// Recursive-descent parser for the GLSL ES 3.00 fragment subset (ABI.md).
// Precedence and associativity are GLSL's (= C's, plus `^^` between `&&`
// and `||`). A syntax error is fatal and reported with its line; refusals of
// valid-but-unsupported GLSL are collected and parsing goes on.

import type { Expr, FnDecl, ParamDecl, Program, Stmt, StructDecl, TopDecl, TypeSpec, VarDecl } from "./ast";
import { builtinType, UNSUPPORTED_TYPES } from "./glsl-types";
import type { GlslError, Tok } from "./tokenize";

class SyntaxError_ extends Error {
  constructor(
    public line: number,
    message: string
  ) {
    super(message);
  }
}

const PRECISION = new Set(["highp", "mediump", "lowp"]);
const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "<<=", ">>=", "&=", "^=", "|="]);

// Binary operators by precedence level, loosest first.
const BIN_LEVELS: string[][] = [
  ["||"],
  ["^^"],
  ["&&"],
  ["|"],
  ["^"],
  ["&"],
  ["==", "!="],
  ["<", ">", "<=", ">="],
  ["<<", ">>"],
  ["+", "-"],
  ["*", "/", "%"],
];

export function parseGlsl(tokens: Tok[]): { program: Program; errors: GlslError[] } {
  const errors: GlslError[] = [];
  const structs = new Set<string>();
  let p = 0;

  const peek = (o = 0): Tok => tokens[Math.min(p + o, tokens.length - 1)];
  const at = (v: string, o = 0) => {
    const t = peek(o);
    return (t.k === "punct" || t.k === "id") && t.v === v;
  };
  const next = (): Tok => tokens[Math.min(p++, tokens.length - 1)];
  const fail = (msg: string, t: Tok = peek()): never => {
    throw new SyntaxError_(t.line, msg);
  };
  const expect = (v: string): Tok => {
    if (!at(v)) fail(`expected "${v}" but found ${describe(peek())}`);
    return next();
  };
  const refuse = (line: number, message: string) => errors.push({ line, message });
  const ident = (what: string): Tok => {
    const t = peek();
    if (t.k !== "id") fail(`expected ${what} but found ${describe(t)}`);
    return next();
  };
  const isTypeName = (t: Tok) => t.k === "id" && (builtinType(t.v) !== null || structs.has(t.v) || UNSUPPORTED_TYPES.has(t.v));

  const decls: TopDecl[] = [];
  try {
    while (peek().k !== "eof") {
      const d = topLevel();
      if (d) decls.push(d);
    }
  } catch (e) {
    if (e instanceof SyntaxError_) errors.push({ line: e.line, message: `syntax error: ${e.message}` });
    else throw e;
  }
  return { program: { decls }, errors };

  // -------------------------------------------------------------------------
  // Top level
  // -------------------------------------------------------------------------

  function topLevel(): TopDecl | null {
    const start = peek();
    if (at(";")) {
      next();
      return null;
    }
    if (at("precision")) {
      next();
      if (!PRECISION.has(peek().v)) fail("expected a precision qualifier");
      next();
      typeSpec();
      expect(";");
      return null;
    }
    let isConst = false;
    let storage: "uniform" | "in" | "out" | null = null;
    for (;;) {
      const t = peek();
      if (t.k !== "id") break;
      if (t.v === "const") isConst = true;
      else if (t.v === "uniform" || t.v === "in" || t.v === "out") {
        if (storage) fail(`two storage qualifiers ("${storage}" and "${t.v}")`);
        storage = t.v;
      } else if (PRECISION.has(t.v)) {
        /* dropped (ABI.md: precision qualifiers) */
      } else if (t.v === "layout") {
        next();
        skipParens();
        continue;
      } else if (t.v === "flat" || t.v === "smooth" || t.v === "centroid" || t.v === "invariant") {
        refuse(t.line, `the "${t.v}" qualifier is not supported`);
      } else break;
      next();
    }
    if (at("struct")) {
      const s = structDecl();
      if (!at(";")) fail("declare struct variables separately from the struct (struct S { … }; S s;)");
      next();
      if (isConst || storage) refuse(s.line, "qualifiers on a struct declaration are not supported");
      return s;
    }
    const type = typeSpec();
    const nameTok = ident("a name");
    if (at("(")) {
      if (isConst || storage) refuse(nameTok.line, `qualifiers on function "${nameTok.v}" are not supported`);
      return fnDecl(type, nameTok);
    }
    const vars = declarators(nameTok);
    expect(";");
    if (storage === "uniform" || storage === "in" || storage === "out") {
      if (vars.length !== 1 || vars[0].init || vars[0].array) {
        refuse(start.line, `${storage} declarations must be one plain variable each`);
      }
      if (storage === "uniform") return { k: "uniform", type, name: vars[0].name, line: nameTok.line };
      return { k: "io", dir: storage, type, name: vars[0].name, line: nameTok.line };
    }
    return { k: "global", isConst, type, vars, line: nameTok.line };
  }

  function skipParens() {
    expect("(");
    let depth = 1;
    while (depth > 0) {
      const t = next();
      if (t.k === "eof") fail("unterminated (");
      if (t.v === "(") depth++;
      else if (t.v === ")") depth--;
    }
  }

  function structDecl(): StructDecl {
    const kw = expect("struct");
    const name = ident("a struct name");
    expect("{");
    const fields: StructDecl["fields"] = [];
    while (!at("}")) {
      while (PRECISION.has(peek().v)) next();
      const type = typeSpec();
      for (;;) {
        const f = ident("a field name");
        let array: Expr | "unsized" | undefined;
        if (at("[")) array = arraySuffix();
        fields.push({ type, name: f.v, array, line: f.line });
        if (at(",")) {
          next();
          continue;
        }
        break;
      }
      expect(";");
    }
    expect("}");
    structs.add(name.v);
    return { k: "struct", name: name.v, fields, line: kw.line };
  }

  function typeSpec(): TypeSpec {
    const t = peek();
    if (!isTypeName(t)) fail(`expected a type but found ${describe(t)}`);
    next();
    if (UNSUPPORTED_TYPES.has(t.v)) refuse(t.line, `type "${t.v}" is not supported (only sampler2D textures and float/int/uint/bool scalars, vectors and matrices)`);
    const spec: TypeSpec = { name: t.v, line: t.line };
    if (at("[")) spec.array = arraySuffix();
    return spec;
  }

  function arraySuffix(): Expr | "unsized" {
    expect("[");
    if (at("]")) {
      next();
      return "unsized";
    }
    const e = expression();
    expect("]");
    return e;
  }

  function declarators(first: Tok): VarDecl[] {
    const vars: VarDecl[] = [];
    let nameTok = first;
    for (;;) {
      const v: VarDecl = { name: nameTok.v, line: nameTok.line };
      if (at("[")) v.array = arraySuffix();
      if (at("=")) {
        next();
        if (at("{")) fail("brace initializer lists are not GLSL ES 3.00 — use a constructor");
        v.init = assignment();
      }
      vars.push(v);
      if (!at(",")) break;
      next();
      nameTok = ident("a name");
    }
    return vars;
  }

  function fnDecl(ret: TypeSpec, nameTok: Tok): FnDecl {
    expect("(");
    const params: ParamDecl[] = [];
    if (at("void") && at(")", 1)) next();
    while (!at(")")) {
      const line = peek().line;
      let qual: ParamDecl["qual"] = "in";
      for (;;) {
        const t = peek();
        if (t.v === "const" || PRECISION.has(t.v)) next();
        else if (t.v === "in" || t.v === "out" || t.v === "inout") {
          qual = t.v;
          next();
        } else break;
      }
      const type = typeSpec();
      const param: ParamDecl = { qual, type, line };
      if (peek().k === "id" && !isTypeName(peek())) {
        param.name = next().v;
        if (at("[")) param.array = arraySuffix();
      }
      params.push(param);
      if (!at(",")) break;
      next();
    }
    expect(")");
    const fn: FnDecl = { k: "fn", ret, name: nameTok.v, params, line: nameTok.line };
    if (at(";")) {
      next();
      return fn;
    }
    fn.body = block();
    return fn;
  }

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------

  function block(): Stmt & { k: "block" } {
    const open = expect("{");
    const body: Stmt[] = [];
    while (!at("}")) {
      if (peek().k === "eof") fail("unterminated block", open);
      body.push(statement());
    }
    expect("}");
    return { k: "block", body, line: open.line };
  }

  function looksLikeDecl(): boolean {
    const t = peek();
    if (t.k !== "id") return false;
    if (t.v === "const" || PRECISION.has(t.v)) return true;
    if (!isTypeName(t)) return false;
    if (peek(1).k === "id") return true;
    if (!at("[", 1)) return false;
    // `float[3] x` (declaration) vs `float[3](…)` (array constructor).
    let depth = 0;
    for (let o = 1; ; o++) {
      const u = peek(o);
      if (u.k === "eof") return false;
      if (u.v === "[") depth++;
      else if (u.v === "]" && --depth === 0) return peek(o + 1).k === "id";
    }
  }

  function declStatement(): Stmt {
    const line = peek().line;
    let isConst = false;
    while (peek().v === "const" || PRECISION.has(peek().v)) {
      if (next().v === "const") isConst = true;
    }
    const type = typeSpec();
    const vars = declarators(ident("a variable name"));
    expect(";");
    return { k: "decl", isConst, type, vars, line };
  }

  function statement(): Stmt {
    const t = peek();
    const line = t.line;
    if (at("{")) return block();
    if (at(";")) {
      next();
      return { k: "empty", line };
    }
    if (t.k === "id") {
      switch (t.v) {
        case "precision":
          // A precision statement in a body: dropped like the file-scope one.
          next();
          if (!PRECISION.has(peek().v)) fail("expected a precision qualifier");
          next();
          typeSpec();
          expect(";");
          return { k: "empty", line };
        case "struct":
          refuse(line, "local struct declarations are not supported — declare the struct at file scope");
          structDecl();
          expect(";");
          return { k: "empty", line };
        case "if": {
          next();
          expect("(");
          const c = expression();
          expect(")");
          const th = statement();
          let el: Stmt | undefined;
          if (at("else")) {
            next();
            el = statement();
          }
          return { k: "if", c, t: th, f: el, line };
        }
        case "for": {
          next();
          expect("(");
          let init: Stmt | undefined;
          if (at(";")) next();
          else if (looksLikeDecl()) init = declStatement();
          else {
            init = { k: "expr", e: expression(), line };
            expect(";");
          }
          const c = at(";") ? undefined : expression();
          expect(";");
          const step = at(")") ? undefined : expression();
          expect(")");
          return { k: "for", init, c, step, body: statement(), line };
        }
        case "while": {
          next();
          expect("(");
          if (looksLikeDecl()) fail("declarations in a while condition are not supported");
          const c = expression();
          expect(")");
          return { k: "while", c, body: statement(), line };
        }
        case "do": {
          next();
          const body = statement();
          expect("while");
          expect("(");
          const c = expression();
          expect(")");
          expect(";");
          return { k: "do", body, c, line };
        }
        case "switch": {
          next();
          expect("(");
          const e = expression();
          expect(")");
          expect("{");
          const body: Stmt[] = [];
          while (!at("}")) {
            if (peek().k === "eof") fail("unterminated switch");
            if (at("case")) {
              const l = next().line;
              const ce = expression();
              expect(":");
              body.push({ k: "case", e: ce, line: l });
            } else if (at("default")) {
              const l = next().line;
              expect(":");
              body.push({ k: "case", line: l });
            } else body.push(statement());
          }
          expect("}");
          return { k: "switch", e, body, line };
        }
        case "break":
        case "continue":
        case "discard":
          next();
          expect(";");
          return { k: t.v, line };
        case "return": {
          next();
          if (at(";")) {
            next();
            return { k: "return", line };
          }
          const e = expression();
          expect(";");
          return { k: "return", e, line };
        }
        case "case":
        case "default":
          fail(`"${t.v}" outside a switch`);
      }
      if (looksLikeDecl()) return declStatement();
    }
    const e = expression();
    expect(";");
    return { k: "expr", e, line };
  }

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------

  function expression(): Expr {
    let e = assignment();
    while (at(",")) {
      const line = next().line;
      e = { k: "comma", l: e, r: assignment(), line };
    }
    return e;
  }

  function assignment(): Expr {
    const l = conditional();
    const t = peek();
    if (t.k === "punct" && ASSIGN_OPS.has(t.v)) {
      next();
      return { k: "assign", op: t.v, l, r: assignment(), line: t.line };
    }
    return l;
  }

  function conditional(): Expr {
    const c = binary(0);
    if (!at("?")) return c;
    const line = next().line;
    const t = expression();
    expect(":");
    const f = assignment();
    return { k: "cond", c, t, f, line };
  }

  function binary(level: number): Expr {
    if (level >= BIN_LEVELS.length) return unary();
    let l = binary(level + 1);
    for (;;) {
      const t = peek();
      if (t.k !== "punct" || !BIN_LEVELS[level].includes(t.v)) return l;
      next();
      l = { k: "bin", op: t.v, l, r: binary(level + 1), line: t.line };
    }
  }

  function unary(): Expr {
    const t = peek();
    if (t.k === "punct" && ["++", "--", "+", "-", "!", "~"].includes(t.v)) {
      next();
      return { k: "un", op: t.v, e: unary(), line: t.line };
    }
    return postfix(primary());
  }

  function postfix(e: Expr): Expr {
    for (;;) {
      const t = peek();
      if (at("[")) {
        next();
        const i = expression();
        expect("]");
        e = { k: "index", e, i, line: t.line };
      } else if (at(".")) {
        next();
        const name = ident("a field or swizzle");
        if (name.v === "length" && at("(")) {
          next();
          expect(")");
          e = { k: "length", e, line: name.line };
        } else e = { k: "field", e, name: name.v, line: name.line };
      } else if (at("++") || at("--")) {
        next();
        e = { k: "post", op: t.v as "++" | "--", e, line: t.line };
      } else return e;
    }
  }

  function args(): Expr[] {
    expect("(");
    const out: Expr[] = [];
    if (at("void") && at(")", 1)) next();
    while (!at(")")) {
      out.push(assignment());
      if (!at(",")) break;
      next();
    }
    expect(")");
    return out;
  }

  function primary(): Expr {
    const t = peek();
    if (t.k === "float" || t.k === "int" || t.k === "uint") {
      next();
      return { k: "lit", lit: t.k, text: t.v, line: t.line };
    }
    if (at("(")) {
      next();
      const e = expression();
      expect(")");
      return e;
    }
    if (t.k === "id") {
      if (t.v === "true" || t.v === "false") {
        next();
        return { k: "lit", lit: "bool", text: t.v, line: t.line };
      }
      next();
      if (isTypeName(t) && at("[")) {
        const array = arraySuffix();
        if (!at("(")) fail(`expected "(" after array type ${t.v}[…]`);
        return { k: "call", callee: t.v, array, args: args(), line: t.line };
      }
      if (at("(")) return { k: "call", callee: t.v, args: args(), line: t.line };
      if (isTypeName(t)) fail(`type "${t.v}" used as a value`, t);
      return { k: "id", name: t.v, line: t.line };
    }
    return fail(`unexpected ${describe(t)}`);
  }
}

function describe(t: Tok): string {
  if (t.k === "eof") return "end of input";
  return `"${t.v}"`;
}
