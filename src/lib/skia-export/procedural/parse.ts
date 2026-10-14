// The Expression node's JavaScript, parsed — never evaluated — into an AST
// of the subset the procedural exporter compiles (specdocs/101326_skia-target.md
// §3.5e). The exporter generates its worklet / SkSL code from this AST, so a
// user string never reaches eval, `new Function` or the emitted bundle.
//
// The subset (everything else refuses, naming what it met):
//   numbers (decimal, 0x / 0o / 0b), true / false, identifiers (the node's
//   input variables and its globals), Math.<member>, calls of the globals
//   and Math functions, unary - + !, binary + - * / % **, comparisons
//   < <= > >= == != === !==, && ||, ?:, parentheses, and an array literal
//   [a, b, …] as the whole result (out_type vec2 / vec3 / vec4).
//
// It also reproduces how the node itself wraps the source (expression.ts
// compile): a source mentioning `return` is a statement block, anything else
// becomes `return (<source>);`. So the places where the EDITOR fails to
// compile — a bare expression ending in `;` or in a // comment (which
// swallows the closing parenthesis), `-x ** 2`, a `return` followed by a
// line break (ASI returns undefined) — are refusals here too, with the
// reason, instead of an export that differs from the editor's 0.

export type BinaryOp = "+" | "-" | "*" | "/" | "%" | "**" | "<" | "<=" | ">" | ">=" | "==" | "!=" | "===" | "!==";

export type ExprAst =
  | { k: "num"; v: number }
  | { k: "bool"; v: boolean }
  | { k: "id"; name: string }
  | { k: "math"; name: string }
  | { k: "unary"; op: "-" | "+" | "!"; a: ExprAst }
  | { k: "binary"; op: BinaryOp; a: ExprAst; b: ExprAst }
  | { k: "logical"; op: "&&" | "||"; a: ExprAst; b: ExprAst }
  | { k: "cond"; c: ExprAst; a: ExprAst; b: ExprAst }
  | { k: "call"; callee: { k: "id"; name: string } | { k: "math"; name: string }; args: ExprAst[] }
  | { k: "array"; items: ExprAst[] };

export type ParseResult =
  | { ok: true; empty: true }
  | { ok: true; empty: false; ast: ExprAst; mode: "bare" | "return" }
  | { ok: false; reason: string };

type Tok =
  | { t: "num"; v: number; at: number; text: string }
  | { t: "id"; v: string; at: number }
  | { t: "op"; v: string; at: number }
  | { t: "eof"; at: number };

// Strict-mode reserved words (and the literals the subset has no use for):
// as identifiers they are a SyntaxError, which the node turns into a 0.
const RESERVED = new Set(
  (
    "break case catch class const continue debugger default delete do else enum export extends finally for function if " +
    "implements import in instanceof interface let new null package private protected public return static super switch " +
    "this throw try typeof var void while with yield await undefined arguments eval"
  ).split(" ")
);

// Operators the subset refuses, longest first, with what to say.
const REFUSED_OPS: [string, string][] = [
  [">>>=", "assignment"],
  ["...", "spread syntax"],
  ["**=", "assignment"],
  ["<<=", "assignment"],
  [">>=", "assignment"],
  [">>>", "bitwise shifts"],
  ["&&=", "assignment"],
  ["||=", "assignment"],
  ["??=", "assignment"],
  ["=>", "arrow functions"],
  ["??", "the ?? operator"],
  ["?.", "optional chaining"],
  ["<<", "bitwise shifts"],
  [">>", "bitwise shifts"],
  ["++", "increment / decrement"],
  ["--", "increment / decrement"],
  ["+=", "assignment"],
  ["-=", "assignment"],
  ["*=", "assignment"],
  ["/=", "assignment"],
  ["%=", "assignment"],
  ["&=", "assignment"],
  ["|=", "assignment"],
  ["^=", "assignment"],
  ["&", "bitwise operators"],
  ["|", "bitwise operators"],
  ["^", "bitwise operators"],
  ["~", "bitwise operators"],
  ["{", "blocks and object literals"],
  ["}", "blocks and object literals"],
];
const OPS = ["===", "!==", "**", "<=", ">=", "==", "!=", "&&", "||", "<", ">", "+", "-", "*", "/", "%", "!", "?", ":", "(", ")", "[", "]", ",", ".", ";", "="];

class ParseError extends Error {}
const fail = (msg: string): never => {
  throw new ParseError(msg);
};

const isWs = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\v" || c === "\f" || c === "\u00a0" || c === "\ufeff" || c === "\u2028" || c === "\u2029";
const isNl = (c: string) => c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029";
const isIdStart = (c: string) => /[A-Za-z_$]/.test(c);
const isIdPart = (c: string) => /[A-Za-z0-9_$]/.test(c);

function tokenize(src: string): { toks: Tok[]; newlineBefore: Set<number>; endsInLineComment: boolean } {
  const toks: Tok[] = [];
  const newlineBefore = new Set<number>();
  let nl = false;
  let endsInLineComment = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (isWs(c)) {
      if (isNl(c)) nl = true;
      i++;
      continue;
    }
    if (src.startsWith("//", i)) {
      let j = i + 2;
      while (j < src.length && !isNl(src[j])) j++;
      if (j >= src.length) endsInLineComment = true;
      i = j;
      continue;
    }
    if (src.startsWith("/*", i)) {
      const j = src.indexOf("*/", i + 2);
      if (j < 0) fail("an unterminated /* comment");
      if (/[\n\r\u2028\u2029]/.test(src.slice(i, j))) nl = true;
      i = j + 2;
      continue;
    }
    if (nl) newlineBefore.add(toks.length);
    nl = false;
    const at = i;
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let m = /^0[xX][0-9a-fA-F]+|^0[oO][0-7]+|^0[bB][01]+/.exec(src.slice(i));
      let text: string;
      if (m) text = m[0];
      else {
        m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
        text = m![0];
        if (/^0\d/.test(text)) fail(`the number "${text}" (a leading zero is a legacy octal literal — a strict-mode SyntaxError, so the editor outputs 0)`);
      }
      const after = src[i + text.length] ?? "";
      if (after === "n") fail(`the BigInt literal "${text}n"`);
      if (after === "_") fail(`numeric separators ("${text}_…")`);
      if (isIdPart(after)) fail(`"${text}${after}…" (a number directly followed by a name is a SyntaxError)`);
      const v = Number(text);
      if (Number.isNaN(v)) fail(`the number "${text}"`);
      toks.push({ t: "num", v, at, text });
      i += text.length;
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < src.length && isIdPart(src[j])) j++;
      toks.push({ t: "id", v: src.slice(i, j), at });
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") fail("strings and template literals");
    if (c === "\\") fail("escape sequences (\\u…) in names");
    if (c === "#" || c === "@") fail(`"${c}" (private names / decorators)`);
    const refused = REFUSED_OPS.find(([op]) => src.startsWith(op, i));
    const op = OPS.find((o) => src.startsWith(o, i));
    if (refused && (!op || refused[0].length > op.length)) fail(`${refused[1]} ("${refused[0]}")`);
    if (!op) fail(c.charCodeAt(0) > 127 ? `the character "${c}" (only ASCII names and operators)` : `the character "${c}"`);
    if (op === "=") fail('assignment ("=")');
    toks.push({ t: "op", v: op!, at });
    i += op!.length;
  }
  toks.push({ t: "eof", at: src.length });
  return { toks, newlineBefore, endsInLineComment };
}

class Parser {
  private i = 0;
  constructor(private toks: Tok[]) {}

  peek(): Tok {
    return this.toks[this.i];
  }
  next(): Tok {
    return this.toks[this.i++];
  }
  isOp(v: string): boolean {
    const t = this.peek();
    return t.t === "op" && t.v === v;
  }
  eatOp(v: string): boolean {
    if (!this.isOp(v)) return false;
    this.i++;
    return true;
  }
  expectOp(v: string, what: string): void {
    if (!this.eatOp(v)) fail(`${what} (expected "${v}", found ${this.describe(this.peek())})`);
  }
  describe(t: Tok): string {
    return t.t === "eof" ? "the end" : t.t === "num" ? `"${t.text}"` : `"${t.v}"`;
  }
  get index(): number {
    return this.i;
  }

  // AssignmentExpression ≈ ConditionalExpression (no assignment in the subset).
  expr(): ExprAst {
    const c = this.or();
    if (!this.eatOp("?")) return c;
    const a = this.expr();
    this.expectOp(":", "a ?: without its ':'");
    const b = this.expr();
    return { k: "cond", c, a, b };
  }
  or(): ExprAst {
    let a = this.and();
    while (this.eatOp("||")) a = { k: "logical", op: "||", a, b: this.and() };
    return a;
  }
  and(): ExprAst {
    let a = this.equality();
    while (this.eatOp("&&")) a = { k: "logical", op: "&&", a, b: this.equality() };
    return a;
  }
  equality(): ExprAst {
    let a = this.relational();
    for (;;) {
      const op = ["===", "!==", "==", "!="].find((o) => this.isOp(o)) as BinaryOp | undefined;
      if (!op) return a;
      this.i++;
      a = { k: "binary", op, a, b: this.relational() };
    }
  }
  relational(): ExprAst {
    let a = this.additive();
    for (;;) {
      const t = this.peek();
      if (t.t === "id" && (t.v === "in" || t.v === "instanceof")) fail(`the "${t.v}" operator`);
      const op = ["<=", ">=", "<", ">"].find((o) => this.isOp(o)) as BinaryOp | undefined;
      if (!op) return a;
      this.i++;
      a = { k: "binary", op, a, b: this.additive() };
    }
  }
  additive(): ExprAst {
    let a = this.multiplicative();
    for (;;) {
      const op = ["+", "-"].find((o) => this.isOp(o)) as BinaryOp | undefined;
      if (!op) return a;
      this.i++;
      a = { k: "binary", op, a, b: this.multiplicative() };
    }
  }
  multiplicative(): ExprAst {
    let a = this.exponent();
    for (;;) {
      const op = ["*", "/", "%"].find((o) => this.isOp(o)) as BinaryOp | undefined;
      if (!op) return a;
      this.i++;
      a = { k: "binary", op, a, b: this.exponent() };
    }
  }
  // ExponentiationExpression: UnaryExpression | UpdateExpression ** ExponentiationExpression.
  // A unary operator directly left of ** is a SyntaxError in JS.
  exponent(): ExprAst {
    const startsUnary = ["-", "+", "!"].some((o) => this.isOp(o));
    const a = this.unary();
    if (!this.isOp("**")) return a;
    if (startsUnary) fail("a unary operator directly before ** (\"-x ** 2\" is a SyntaxError — write (-x) ** 2 or -(x ** 2))");
    this.i++;
    return { k: "binary", op: "**", a, b: this.exponent() };
  }
  unary(): ExprAst {
    for (const op of ["-", "+", "!"] as const) {
      if (this.eatOp(op)) return { k: "unary", op, a: this.unary() };
    }
    const t = this.peek();
    if (t.t === "id" && (t.v === "typeof" || t.v === "void" || t.v === "delete" || t.v === "await")) fail(`the "${t.v}" operator`);
    return this.postfix();
  }
  postfix(): ExprAst {
    const p = this.primary();
    if (this.isOp("(")) {
      if (p.k !== "id" && p.k !== "math") fail("calling something that isn't a function name");
      this.i++;
      const args: ExprAst[] = [];
      if (!this.eatOp(")")) {
        for (;;) {
          args.push(this.expr());
          if (this.eatOp(")")) break;
          this.expectOp(",", "a call's arguments");
          if (this.isOp(")")) fail("a trailing comma in a call");
        }
      }
      const call: ExprAst = { k: "call", callee: p as { k: "id"; name: string } | { k: "math"; name: string }, args };
      if (this.isOp("(") || this.isOp(".") || this.isOp("[")) fail("calling, indexing or reading a member of a call's result");
      return call;
    }
    if (this.isOp(".") || this.isOp("[")) fail(p.k === "id" ? `member access on "${p.name}" (only Math.<name>)` : "member access / indexing");
    return p;
  }
  primary(): ExprAst {
    const t = this.next();
    if (t.t === "num") return { k: "num", v: t.v };
    if (t.t === "id") {
      if (t.v === "true" || t.v === "false") return { k: "bool", v: t.v === "true" };
      if (t.v === "Math") {
        this.expectOp(".", "Math used without a member");
        const m = this.next();
        if (m.t !== "id") fail(`Math.${this.describe(m)}`);
        return { k: "math", name: (m as { v: string }).v };
      }
      if (RESERVED.has(t.v)) fail(`the reserved word "${t.v}"`);
      return { k: "id", name: t.v };
    }
    if (t.t === "op" && t.v === "(") {
      const e = this.expr();
      if (this.isOp(",")) fail("the comma operator");
      this.expectOp(")", "an unclosed parenthesis");
      return e;
    }
    if (t.t === "op" && t.v === "[") {
      const items: ExprAst[] = [];
      if (this.eatOp("]")) return { k: "array", items };
      for (;;) {
        if (this.isOp(",")) fail("an array with holes");
        items.push(this.expr());
        if (this.eatOp("]")) break;
        this.expectOp(",", "an array's elements");
        if (this.isOp("]")) fail("a trailing comma in an array");
      }
      return { k: "array", items };
    }
    return fail(`${this.describe(t)} where a value belongs`);
  }
}

// Arrays may only be the whole result (the node reads raw[0] or the
// components); anywhere else JS would coerce them to strings.
function checkArrays(a: ExprAst, root: boolean): void {
  switch (a.k) {
    case "array":
      if (!root) fail("an array literal inside an expression (only as the whole result, for vec outputs)");
      a.items.forEach((x) => checkArrays(x, false));
      return;
    case "unary":
      return checkArrays(a.a, false);
    case "binary":
    case "logical":
      checkArrays(a.a, false);
      return checkArrays(a.b, false);
    case "cond":
      checkArrays(a.c, false);
      checkArrays(a.a, false);
      return checkArrays(a.b, false);
    case "call":
      return a.args.forEach((x) => checkArrays(x, false));
    default:
      return;
  }
}

// Parse an Expression node's `expression` param.
export function parseExpressionSource(source: string): ParseResult {
  const trimmed = source.trim();
  if (!trimmed) return { ok: true, empty: true };
  // expression.ts: `/\breturn\b/.test(trimmed) ? trimmed : \`return (${trimmed});\``
  const statement = /\breturn\b/.test(trimmed);
  try {
    const { toks, newlineBefore, endsInLineComment } = tokenize(trimmed);
    const p = new Parser(toks);
    let ast: ExprAst;
    if (statement) {
      const first = p.next();
      if (first.t !== "id" || first.v !== "return") {
        fail("statements before the `return` (only a single `return <expression>` block compiles)");
      }
      if (newlineBefore.has(p.index)) fail("a line break right after `return` (JavaScript inserts a ; there and returns undefined — the editor outputs 0)");
      ast = p.expr();
      p.eatOp(";");
      if (p.peek().t !== "eof") fail(`more statements after the \`return\` (found ${p.describe(p.peek())})`);
    } else {
      if (endsInLineComment) fail("a // comment at the end of a bare expression (the node appends \");\", which the comment swallows — the editor fails to compile and outputs 0)");
      ast = p.expr();
      if (p.isOp(";")) fail("a ; in a bare expression (the node wraps it as return (…;); — a SyntaxError, the editor outputs 0; drop the ; or write `return …;`)");
      if (p.isOp(",")) fail("the comma operator");
      if (p.peek().t !== "eof") fail(`${p.describe(p.peek())} after the end of the expression`);
    }
    checkArrays(ast, true);
    return { ok: true, empty: false, ast, mode: statement ? "return" : "bare" };
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, reason: e.message };
    throw e;
  }
}

// The node's variable names as `new Function` parameters next to the
// destructured env (expression.ts compile + ENV_KEYS): a name the editor
// can't compile (invalid, duplicate, reserved, shadowing a global, or
// `Math`, which would break every Math.* read) → the reason.
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
export function variableNameProblem(names: string[], envKeys: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const n of names) {
    if (!IDENT_RE.test(n)) return `the variable name "${n}" is invalid (the editor refuses it and outputs 0)`;
    if (seen.has(n)) return `the variable "${n}" is declared twice (the editor refuses it and outputs 0)`;
    seen.add(n);
    if (RESERVED.has(n) || n === "true" || n === "false" || n === "__env") return `the variable name "${n}" is a reserved word (a SyntaxError — the editor outputs 0)`;
    if (envKeys.includes(n)) return `the variable "${n}" shadows the global of that name (a SyntaxError in the node's wrapper — the editor outputs 0)`;
    if (n === "Math") return `the variable "Math" hides the Math object (every Math.* read throws — the editor outputs 0)`;
  }
  return null;
}
