// SkSL library registry — the shared helpers and the per-node library
// functions the fuser (engine/skia/fuse.ts) compiles into one runtime effect
// (specdocs/101326_skia-target.md §3.3; the contract is shader-expr.ts).
//
// Two tables, both keyed by stable id:
//   helpers    hashes, sRGB/OKLab, simplex… — emitted once per program, in
//              dependency order (helpers.ts registers the built-in set);
//   functions  one per `skia-*` shader node, registered by defineSkslNode
//              when the node module loads (define-node.ts).
//
// Registration never throws: a malformed function is stored anyway and
// validateSkslFunction() lists what is wrong. The fuser reports those
// problems for any program that uses the function, and check:skia-library
// fails while any registered function has one.

import type { SkslHelper, SkslLibFunction, SkslParamType } from "../shader-expr";

// One library-function parameter. `count` makes it a uniform ARRAY of that
// length (`uniform float n3_stops_pos[16]`), passed to the entry as an array
// argument; read it with a loop index only (Skia's ES2 rule). Additive over
// the frozen SkslLibFunction param shape, which is the `count`-less case.
export interface SkslLibParam {
  name: string;
  type: SkslParamType;
  count?: number;
}

export interface SkslLibFunctionDef extends SkslLibFunction {
  params: SkslLibParam[];
  // ---- the cost model and the stage splitter (engine/skia/split.ts) ----
  // Additive 2026-10-14 (Wave 3 lane S); all optional.
  //
  // Gather inputs whose taps land on texel CENTRES whenever the function
  // itself is evaluated at one (integer pixel offsets, clamped with
  // tbx_texel_clamp): sharpen, edge detect, kuwahara. A split reads a
  // rendered upstream there with one texel fetch; any other gather input
  // (an off-grid tap) reads it bilinearly from the four centres around the
  // tap (tbx.split.bilinear@1), the GL texture's own filter.
  gridTaps?: string[];
  // The real taps per gather input at these call params (bind values), for
  // the `at: "params"` cost readout (estimateShaderCost). The SPLIT decision
  // never reads it: it is structural (declared taps), so an animated radius
  // cannot change the exported scene's structure between frames.
  tapsAt?: (params: Record<string, number | number[]>) => Record<string, number>;
  // The function's own relative ALU cost at these params (`cost` is the
  // declared one), for the same readout.
  costAt?: (params: Record<string, number | number[]>) => number;
  // It can return straight color outside [0, 1] (sharpen's overshoot, edge
  // detect's magnitude × strength). A layer is a color image that clips
  // there, where the fused program and the GL node's fp16 texture keep the
  // value, so the splitter never renders an expression containing it into
  // a layer. check:skia-split audits every shader node at its defaults.
  unbounded?: boolean;
}

const helpers = new Map<string, SkslHelper>();
const functions = new Map<string, SkslLibFunctionDef>();

export function registerSkslHelper(helper: SkslHelper): void {
  helpers.set(helper.id, helper);
}

export function getSkslHelper(id: string): SkslHelper | undefined {
  return helpers.get(id);
}

// Re-registering an id replaces it (module hot reload re-runs defineSkslNode).
export function registerSkslFunction(fn: SkslLibFunctionDef): void {
  functions.set(fn.id, fn);
}

export function getSkslFunction(id: string): SkslLibFunctionDef | undefined {
  return functions.get(id);
}

export function allSkslHelpers(): SkslHelper[] {
  return [...helpers.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function allSkslFunctions(): SkslLibFunctionDef[] {
  return [...functions.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---- validation ------------------------------------------------------------------

export const SKSL_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// `$name(` — a gather input read at another uv (rewritten by the fuser).
export const GATHER_TOKEN_RE = /\$([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

function stripSkslComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, "");
}

// Problems with a function's DECLARATION, independent of any call: bad
// names, an entry the source never defines, `$x(` tokens that name no
// gather input, a helper id that isn't registered, an entry another
// function already owns. Compile errors are CanvasKit's to find (the gate
// compiles every registered function).
export function validateSkslFunction(fn: SkslLibFunctionDef): string[] {
  const out: string[] = [];
  const at = `library function ${fn.id}`;
  if (!SKSL_IDENT_RE.test(fn.entry) || fn.entry.includes("__")) {
    out.push(`${at}: entry "${fn.entry}" is not a usable SkSL identifier`);
  }
  const code = stripSkslComments(fn.source);
  if (!new RegExp(`\\bfloat4\\s+${fn.entry}\\s*\\(`).test(code)) {
    out.push(`${at}: source defines no \`float4 ${fn.entry}(…)\``);
  }
  const names = new Set<string>(["uv", "res"]);
  for (const p of fn.params) {
    if (!SKSL_IDENT_RE.test(p.name) || p.name.includes("__")) {
      out.push(`${at}: param "${p.name}" is not a usable SkSL identifier`);
    }
    if (names.has(p.name)) out.push(`${at}: "${p.name}" is declared twice`);
    names.add(p.name);
    if (p.count !== undefined && !(Number.isInteger(p.count) && p.count >= 1 && p.count <= 256)) {
      out.push(`${at}: param "${p.name}" has count ${p.count} (expected an integer 1..256)`);
    }
  }
  const gathers = new Set<string>();
  for (const i of fn.inputs) {
    if (!SKSL_IDENT_RE.test(i.name) || i.name.includes("__")) {
      out.push(`${at}: input "${i.name}" is not a usable SkSL identifier`);
    }
    if (names.has(i.name)) out.push(`${at}: "${i.name}" is declared twice`);
    names.add(i.name);
    if (i.mode === "gather") gathers.add(i.name);
  }
  const used = new Set<string>();
  for (const m of code.matchAll(GATHER_TOKEN_RE)) {
    used.add(m[1]);
    if (!gathers.has(m[1])) {
      out.push(`${at}: \`$${m[1]}(\` names no gather input (declare it in inputs with mode "gather")`);
    }
  }
  for (const g of gathers) {
    if (!used.has(g)) out.push(`${at}: gather input "${g}" is never read — sample it as \`$${g}(uv2)\``);
  }
  if (/\$/.test(code.replace(GATHER_TOKEN_RE, ""))) {
    out.push(`${at}: stray "$" outside a \`$input(\` gather token`);
  }
  for (const h of fn.uses ?? []) {
    if (!helpers.has(h)) out.push(`${at}: uses unknown helper "${h}"`);
  }
  for (const other of functions.values()) {
    if (other.id !== fn.id && other.entry === fn.entry) {
      out.push(`${at}: entry "${fn.entry}" is also the entry of ${other.id}`);
    }
  }
  return out;
}

// Helpers a set of ids pulls in, dependencies first, each once. Order is the
// first-use order of a depth-first walk, so it is deterministic for a given
// sequence of ids. Unknown ids are reported, cycles are broken and reported.
export function resolveHelpers(ids: readonly string[]): { order: SkslHelper[]; problems: string[] } {
  const order: SkslHelper[] = [];
  const problems: string[] = [];
  const done = new Set<string>();
  const onStack = new Set<string>();
  const visit = (id: string, from: string) => {
    if (done.has(id)) return;
    const h = helpers.get(id);
    if (!h) {
      problems.push(`unknown SkSL helper "${id}" (used by ${from})`);
      done.add(id);
      return;
    }
    if (onStack.has(id)) {
      problems.push(`SkSL helper cycle through "${id}"`);
      return;
    }
    onStack.add(id);
    for (const dep of h.uses ?? []) visit(dep, `helper ${id}`);
    onStack.delete(id);
    done.add(id);
    order.push(h);
  };
  for (const id of ids) visit(id, "a library function");
  return { order, problems };
}

// SkSL declaration type for one param (fuser uniforms, entry signatures).
export function skslTypeOf(t: SkslParamType): string {
  return t === "color" ? "float4" : t;
}

// Float count of one value of a param type (an array multiplies by count).
export function skslTypeWidth(t: SkslParamType): number {
  switch (t) {
    case "float":
    case "int":
      return 1;
    case "float2":
      return 2;
    case "float3":
      return 3;
    case "float4":
    case "color":
      return 4;
  }
}
