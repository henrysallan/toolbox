// GLSL ES 3.00 preprocessor + tokenizer for the fused-shader translator
// (ABI.md). The fused shaders come from the GLSL Expression template, so the
// preprocessor accepts exactly what that template and a careful author emit:
// `#version 300 es`, the null directive, and object-like `#define`s whose
// value is a constant (literals, operators, type constructors, built-in
// functions, other constant defines). Those are inlined token by token, the
// way the GLSL preprocessor would, so the parser sees GLSL's own reading of
// the text. Every other directive is refused with its line.

export interface GlslError {
  // 1-based line in the GLSL source handed to the translator.
  line: number;
  message: string;
}

export type TokKind = "id" | "float" | "int" | "uint" | "punct" | "eof";

export interface Tok {
  k: TokKind;
  v: string;
  line: number;
}

// Longest first: the lexer tries 3-, then 2-, then 1-character punctuators.
const PUNCT3 = ["<<=", ">>="];
const PUNCT2 = ["++", "--", "<<", ">>", "<=", ">=", "==", "!=", "&&", "||", "^^", "+=", "-=", "*=", "/=", "%=", "&=", "^=", "|="];
const PUNCT1 = "()[]{}.,;:?+-*/%<>!~&^|=";

// Identifiers a constant #define may reference besides other defines: type
// constructors and the built-in functions (constant expressions in GLSL ES
// 3.00 may call built-ins).
const DEFINE_SAFE_IDS = new Set([
  "true", "false",
  "float", "int", "uint", "bool",
  "vec2", "vec3", "vec4", "ivec2", "ivec3", "ivec4", "uvec2", "uvec3", "uvec4", "bvec2", "bvec3", "bvec4",
  "mat2", "mat3", "mat4", "mat2x2", "mat2x3", "mat2x4", "mat3x2", "mat3x3", "mat3x4", "mat4x2", "mat4x3", "mat4x4",
  "radians", "degrees", "sin", "cos", "tan", "asin", "acos", "atan", "sinh", "cosh", "tanh", "asinh", "acosh", "atanh",
  "pow", "exp", "log", "exp2", "log2", "sqrt", "inversesqrt", "abs", "sign", "floor", "trunc", "round", "roundEven",
  "ceil", "fract", "mod", "min", "max", "clamp", "mix", "step", "smoothstep", "length", "distance", "dot", "cross",
  "normalize",
]);

interface Line {
  text: string;
  line: number;
}

// Strip comments (keeping newlines so line numbers survive) and fold
// backslash-newline continuations into one logical line that keeps the
// first physical line's number.
function logicalLines(src: string): Line[] {
  let out = "";
  const n = src.length;
  for (let i = 0; i < n; ) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      out += " ";
      continue;
    }
    out += c;
    i++;
  }
  const phys = out.split("\n").map((l) => l.replace(/\r$/, ""));
  const lines: Line[] = [];
  for (let i = 0; i < phys.length; i++) {
    const line = i + 1;
    let text = phys[i];
    // The continued lines are consumed; later lines keep their own numbers.
    while (text.endsWith("\\") && i + 1 < phys.length) text = text.slice(0, -1) + phys[++i];
    lines.push({ text, line });
  }
  return lines;
}

const ID_START = /[A-Za-z_]/;
const ID_CHAR = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

function lexLine(text: string, line: number, errors: GlslError[]): Tok[] {
  const toks: Tok[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\f" || c === "\v") {
      i++;
      continue;
    }
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < n && ID_CHAR.test(text[j])) j++;
      toks.push({ k: "id", v: text.slice(i, j), line });
      i = j;
      continue;
    }
    if (DIGIT.test(c) || (c === "." && DIGIT.test(text[i + 1] ?? ""))) {
      const m = numberAt(text, i);
      if (!m) {
        errors.push({ line, message: `malformed number near "${text.slice(i, i + 12)}"` });
        i++;
        continue;
      }
      toks.push({ k: m.k, v: m.v, line });
      i += m.len;
      continue;
    }
    const three = text.slice(i, i + 3);
    const two = text.slice(i, i + 2);
    if (PUNCT3.includes(three)) {
      toks.push({ k: "punct", v: three, line });
      i += 3;
    } else if (PUNCT2.includes(two)) {
      toks.push({ k: "punct", v: two, line });
      i += 2;
    } else if (PUNCT1.includes(c)) {
      toks.push({ k: "punct", v: c, line });
      i++;
    } else {
      errors.push({ line, message: `unexpected character "${c}"` });
      i++;
    }
  }
  return toks;
}

// GLSL ES 3.00 literals: decimal / octal / hex ints with an optional u
// suffix; floats with a fraction or exponent and an optional f suffix.
function numberAt(text: string, i: number): { k: "float" | "int" | "uint"; v: string; len: number } | null {
  const rest = text.slice(i);
  const hex = /^0[xX][0-9a-fA-F]+([uU]?)/.exec(rest);
  if (hex) return { k: hex[1] ? "uint" : "int", v: hex[0], len: hex[0].length };
  const flt = /^(?:[0-9]+\.[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?[fF]?|^[0-9]+[eE][+-]?[0-9]+[fF]?/.exec(rest);
  if (flt) {
    if (ID_CHAR.test(rest[flt[0].length] ?? "")) return null;
    return { k: "float", v: flt[0], len: flt[0].length };
  }
  const int = /^[0-9]+([uU]?)/.exec(rest);
  if (int) {
    if (ID_CHAR.test(rest[int[0].length] ?? "")) return null;
    if (/^0[0-9]/.test(int[0]) && /[89]/.test(int[0])) return null; // bad octal
    return { k: int[1] ? "uint" : "int", v: int[0], len: int[0].length };
  }
  return null;
}

export interface Preprocessed {
  tokens: Tok[];
  errors: GlslError[];
  defines: string[];
}

export function preprocessAndTokenize(src: string): Preprocessed {
  const errors: GlslError[] = [];
  const macros = new Map<string, Tok[]>();
  const tokens: Tok[] = [];
  let sawCode = false;

  for (const { text, line } of logicalLines(src)) {
    const trimmed = text.trim();
    if (trimmed.startsWith("#")) {
      directive(trimmed.slice(1).trim(), line);
      continue;
    }
    const lexed = lexLine(text, line, errors);
    if (lexed.length) sawCode = true;
    for (const t of lexed) expandInto(t, line, tokens, new Set());
  }
  tokens.push({ k: "eof", v: "", line: src.split("\n").length });
  return { tokens, errors, defines: [...macros.keys()] };

  function directive(body: string, line: number) {
    if (body === "") return; // the null directive
    const name = /^[A-Za-z_]+/.exec(body)?.[0] ?? "";
    const rest = body.slice(name.length);
    if (name === "version") {
      if (rest.trim() !== "300 es") errors.push({ line, message: `only "#version 300 es" is supported (got "#version${rest}")` });
      else if (sawCode) errors.push({ line, message: "#version must come before any code" });
      return;
    }
    if (name === "define") {
      const m = /^\s+([A-Za-z_][A-Za-z0-9_]*)(\(?)(.*)$/.exec(rest);
      if (!m) {
        errors.push({ line, message: `malformed #define: "#${body}"` });
        return;
      }
      const [, macro, paren, value] = m;
      if (paren) {
        errors.push({ line, message: `function-like #define ${macro}(…) is not supported — write a function instead` });
        return;
      }
      if (macros.has(macro)) {
        errors.push({ line, message: `#define ${macro} redefines an earlier #define` });
        return;
      }
      if (macro.startsWith("GL_") || macro.startsWith("__")) {
        errors.push({ line, message: `#define ${macro} uses a reserved name` });
        return;
      }
      const toks = lexLine(value, line, errors);
      for (const t of toks) {
        if (t.k === "id" && !macros.has(t.v) && !DEFINE_SAFE_IDS.has(t.v)) {
          errors.push({
            line,
            message: `#define ${macro} is not a constant (it references "${t.v}") — only constant #defines are inlined; use a const variable or a function`,
          });
          return;
        }
        if (t.k === "punct" && (t.v === "{" || t.v === "}" || t.v === ";" || t.v.endsWith("=") && !["==", "!=", "<=", ">="].includes(t.v))) {
          errors.push({ line, message: `#define ${macro} is not a constant expression ("${t.v}")` });
          return;
        }
      }
      if (!toks.length) {
        errors.push({ line, message: `#define ${macro} has no value — only constant #defines are supported` });
        return;
      }
      macros.set(macro, toks);
      return;
    }
    errors.push({ line, message: `preprocessor directive "#${body}" is not supported (only #version 300 es and constant #define)` });
  }

  function expandInto(t: Tok, line: number, out: Tok[], active: Set<string>) {
    const body = t.k === "id" ? macros.get(t.v) : undefined;
    if (!body || active.has(t.v)) {
      out.push({ ...t, line });
      return;
    }
    active.add(t.v);
    for (const b of body) expandInto(b, line, out, active);
    active.delete(t.v);
  }
}
