// Tiny arithmetic evaluator for numeric text fields: lets users type
// "1920/2", "24*8+1", "-.5*3" etc. and commit the computed value.
// Supports + - * /, parentheses, unary sign, decimals and exponents.
// Returns null for anything that doesn't parse cleanly or doesn't
// produce a finite number (e.g. "1/0") — callers treat null as
// "revert to the previous value", same as parseFloat garbage before.
//
// Deliberately NOT eval()/Function(): only this grammar, nothing else.

export function evalNumExpr(input: string): number | null {
  const s = input.trim();
  if (s === "") return null;
  let i = 0;

  const skipWs = () => {
    while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  };

  // expr := term (('+' | '-') term)*
  const expr = (): number => {
    let v = term();
    for (;;) {
      skipWs();
      const c = s[i];
      if (c === "+" || c === "-") {
        i++;
        const r = term();
        v = c === "+" ? v + r : v - r;
      } else return v;
    }
  };

  // term := unary (('*' | '/') unary)*
  const term = (): number => {
    let v = unary();
    for (;;) {
      skipWs();
      const c = s[i];
      if (c === "*" || c === "/") {
        i++;
        const r = unary();
        v = c === "*" ? v * r : v / r;
      } else return v;
    }
  };

  // unary := ('+' | '-')* primary
  const unary = (): number => {
    skipWs();
    if (s[i] === "-") {
      i++;
      return -unary();
    }
    if (s[i] === "+") {
      i++;
      return unary();
    }
    return primary();
  };

  // primary := number | '(' expr ')'
  const primary = (): number => {
    skipWs();
    if (s[i] === "(") {
      i++;
      const v = expr();
      skipWs();
      if (s[i] !== ")") throw new Error("expected )");
      i++;
      return v;
    }
    // number := digits [. digits] | . digits, optional e-notation
    const m = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(i));
    if (!m) throw new Error("expected number");
    i += m[0].length;
    return parseFloat(m[0]);
  };

  try {
    const v = expr();
    skipWs();
    if (i !== s.length) return null; // trailing garbage — reject the lot
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}
