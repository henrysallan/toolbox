// Shared helpers for the NodeFacts mini-schema (specdocs/090626_node-facts.md):
// the vocabulary, a validator, a formatter for the `facts:` source block, and
// a scanner that finds NodeDefinition object literals under src/nodes so the
// codemod (apply-node-facts) and the gate (check-node-facts) agree on where a
// node's facts live and which source text an attribute name is checked
// against.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { NodeDefinition, NodeFacts } from "@/engine/types";
import { POINT_AGE_ATTR, RESERVED_POINT_ATTR_NAMES } from "@/engine/points";

export const COORD_SPACES = [
  "canvas01",
  "uv01",
  "raster",
  "pixels",
  "world3d",
  "time",
  "unitless",
] as const;

// Attribute names that may be cited without appearing as a literal in the
// node's own source (they are stamped by shared engine helpers).
export const WELL_KNOWN_ATTRS: ReadonlySet<string> = new Set([
  ...RESERVED_POINT_ATTR_NAMES,
  POINT_AGE_ATTR,
  "scale.x",
  "scale.y",
  "ix",
  "iy",
  "cellW",
  "cellH",
  "t",
  "phase",
  "phase_active",
  "keep",
  "weight",
  "subpath",
  "color",
  // Spline subpath fields stamped by engine helpers (spline-pack, growth
  // emitters): the per-subpath driver scalar and the width profile.
  "driver",
  "width",
]);

export const FACT_KEYS = ["space", "reads", "writes", "gotchas"] as const;
export const MAX_GOTCHAS = 8;
export const MAX_GOTCHA_LEN = 200;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// Default space per socket type — the table the catalog header states. Used
// to normalize authored `space` values that name a wire type ("points",
// "spline") instead of a space: the intent "accepts points or spline" maps
// to their default spaces, deduplicated.
export const SOCKET_TYPE_SPACE: Readonly<Record<string, (typeof COORD_SPACES)[number]>> = {
  spline: "canvas01",
  points: "canvas01",
  sdf: "canvas01",
  position: "canvas01",
  scalar_field: "canvas01",
  image: "raster",
  mask: "raster",
  uv: "raster",
  points3d: "world3d",
  geometry: "world3d",
  render: "world3d",
  audio: "time",
  notes: "time",
  scalar: "unitless",
  vec2: "unitless",
  vec3: "unitless",
  vec4: "unitless",
  vector: "unitless",
  color: "unitless",
  string: "unitless",
};

// Returns a copy of `facts` with socket-type names in `space` values replaced
// by their default spaces, plus a list of what changed (empty = untouched).
export function normalizeFacts(facts: unknown): { facts: unknown; notes: string[] } {
  if (!isPlainObject(facts) || !isPlainObject(facts.space)) return { facts, notes: [] };
  const notes: string[] = [];
  const space: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(facts.space)) {
    const mapOne = (x: unknown): unknown =>
      typeof x === "string" && x in SOCKET_TYPE_SPACE ? SOCKET_TYPE_SPACE[x] : x;
    if (Array.isArray(v)) {
      const mapped = [...new Set(v.map(mapOne))];
      if (mapped.some((m, i) => m !== v[i]) || mapped.length !== v.length)
        notes.push(`space["${k}"]: ${JSON.stringify(v)} → ${JSON.stringify(mapped)}`);
      space[k] = mapped.length === 1 ? mapped[0] : mapped;
    } else {
      const m = mapOne(v);
      if (m !== v) notes.push(`space["${k}"]: ${JSON.stringify(v)} → ${JSON.stringify(m)}`);
      space[k] = m;
    }
  }
  return { facts: { ...facts, space }, notes };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Returns a list of problems (empty = valid). `sources` is the text of every
// file holding a NodeDefinition literal for this def — attribute names must
// appear there as string literals unless they are WELL_KNOWN_ATTRS, which is
// the cheap ground-truth check against a hallucinated name.
export function validateFacts(
  def: NodeDefinition,
  facts: unknown,
  sources: string[]
): string[] {
  const errs: string[] = [];
  if (!isPlainObject(facts)) return ["facts must be an object"];
  for (const k of Object.keys(facts)) {
    if (!(FACT_KEYS as readonly string[]).includes(k)) errs.push(`unknown key "${k}"`);
  }

  const defaults: Record<string, unknown> = {};
  for (const p of def.params) defaults[p.name] = p.default;
  function safe<T>(fn: (() => T) | undefined): T | undefined {
    try {
      return fn?.();
    } catch {
      return undefined;
    }
  }
  const inputNames = new Set<string>(def.inputs.map((i) => i.name));
  for (const i of safe(() => def.resolveInputs?.(defaults, { connectedTypes: {} })) ?? [])
    inputNames.add(i.name);
  const auxNames = new Set<string>(def.auxOutputs.map((a) => a.name));
  for (const a of safe(() => def.resolveAuxOutputs?.(defaults)) ?? []) auxNames.add(a.name);
  const paramNames = new Set(def.params.map((p) => p.name));
  const src = sources.join("\n");
  const nameInSource = (n: string) =>
    new RegExp(`name: ["'\`]${escapeRe(n)}["'\`]`).test(src);
  const hasOut = def.primaryOutput != null || !!def.resolvePrimaryOutput;

  const refProblem = (ref: string): string | null => {
    if (ref === "out") return hasOut ? null : `"out" but the node has no primary output`;
    if (ref === "*" || ref === "in:*") return null;
    const m = ref.match(/^(in|aux|param):([A-Za-z_][A-Za-z0-9_]*)$/);
    if (!m) return `bad socket ref "${ref}" (use in:<name> | out | aux:<name> | param:<name>)`;
    const [, kind, name] = m;
    if (kind === "param") return paramNames.has(name) ? null : `unknown param "${name}"`;
    if (kind === "in")
      return inputNames.has(name) || nameInSource(name) ? null : `unknown input "${name}"`;
    return auxNames.has(name) || nameInSource(name) ? null : `unknown aux "${name}"`;
  };
  const isSpace = (v: unknown): v is (typeof COORD_SPACES)[number] =>
    typeof v === "string" && (COORD_SPACES as readonly string[]).includes(v);

  if (facts.space !== undefined) {
    if (!isPlainObject(facts.space)) errs.push("space must be an object");
    else {
      for (const [k, v] of Object.entries(facts.space)) {
        const kp = refProblem(k);
        if (kp) errs.push(`space key: ${kp}`);
        if (typeof v === "string") {
          if (!isSpace(v)) {
            const vp = refProblem(v);
            if (vp)
              errs.push(
                `space["${k}"]: "${v}" is neither a space (${COORD_SPACES.join("|")}) nor a socket ref`
              );
            else if (v === k) errs.push(`space["${k}"] refers to itself`);
          }
        } else if (Array.isArray(v)) {
          if (v.length === 0) errs.push(`space["${k}"]: empty list`);
          for (const s of v) if (!isSpace(s)) errs.push(`space["${k}"]: "${s}" is not a space`);
        } else errs.push(`space["${k}"]: must be a space, a list of spaces, or a socket ref`);
      }
    }
  }
  if (
    def.resolvePrimaryOutput &&
    !(isPlainObject(facts.space) && ("out" in facts.space || "*" in facts.space))
  ) {
    errs.push('polymorphic output (resolvePrimaryOutput) needs space.out (e.g. "in:input")');
  }

  for (const key of ["reads", "writes"] as const) {
    const arr = facts[key];
    if (arr === undefined) continue;
    if (!Array.isArray(arr)) {
      errs.push(`${key} must be an array`);
      continue;
    }
    for (const item of arr) {
      if (typeof item !== "string") {
        errs.push(`${key}: non-string entry`);
        continue;
      }
      if (item === "time") {
        if (key === "writes") errs.push('writes: "time" is not writable');
        continue;
      }
      const m = item.match(/^attr:([A-Za-z_][A-Za-z0-9_.]*)$/);
      if (!m) {
        errs.push(`${key}: "${item}" must be attr:<name>${key === "reads" ? " or time" : ""}`);
        continue;
      }
      const name = m[1];
      if (WELL_KNOWN_ATTRS.has(name)) continue;
      // Quoted literal, or a bare object key (`attributes = { confidence: ... }`).
      const literal = new RegExp(`["'\`]${escapeRe(name)}["'\`]|\\b${escapeRe(name)}\\s*:`);
      if (!literal.test(src)) {
        errs.push(
          `${key}: attr "${name}" does not appear as a string literal or object key in the node's source — misnamed?`
        );
      }
    }
  }

  if (facts.gotchas !== undefined) {
    if (!Array.isArray(facts.gotchas)) errs.push("gotchas must be an array");
    else {
      if (facts.gotchas.length > MAX_GOTCHAS)
        errs.push(`gotchas: ${facts.gotchas.length} entries (max ${MAX_GOTCHAS}) — keep the sharp ones`);
      for (const g of facts.gotchas) {
        if (typeof g !== "string") {
          errs.push("gotchas: non-string entry");
          continue;
        }
        if (!g.trim()) errs.push("empty gotcha");
        if (g.length > MAX_GOTCHA_LEN)
          errs.push(`gotcha too long (${g.length} > ${MAX_GOTCHA_LEN}): "${g.slice(0, 50)}…"`);
        if (/\n/.test(g)) errs.push("gotcha contains a newline");
        if (/^\s*[!\-•*]/.test(g)) errs.push(`gotcha starts with a bullet marker: "${g.slice(0, 30)}…"`);
      }
    }
  }
  return errs;
}

// ---------------------------------------------------------------------------
// Source formatting — the `facts: {...},` block as it appears in a def
// ---------------------------------------------------------------------------

export function formatFactsBlock(facts: NodeFacts, indent: string): string[] {
  const I2 = indent + "  ";
  const I3 = indent + "    ";
  const q = (s: string) => JSON.stringify(s);
  const key = (k: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : q(k));
  const out: string[] = [];
  if (facts.space && Object.keys(facts.space).length) {
    const pairs = Object.entries(facts.space).map(
      ([k, v]) => `${key(k)}: ${Array.isArray(v) ? `[${v.map(q).join(", ")}]` : q(v)}`
    );
    const inline = `${I2}space: { ${pairs.join(", ")} },`;
    if (inline.length <= 100) out.push(inline);
    else {
      out.push(`${I2}space: {`);
      for (const p of pairs) out.push(`${I3}${p},`);
      out.push(`${I2}},`);
    }
  }
  for (const k of ["reads", "writes", "gotchas"] as const) {
    const arr = facts[k];
    if (!arr?.length) continue;
    const inline = `${I2}${k}: [${arr.map(q).join(", ")}],`;
    if (inline.length <= 100) out.push(inline);
    else {
      out.push(`${I2}${k}: [`);
      for (const s of arr) out.push(`${I3}${q(s)},`);
      out.push(`${I2}],`);
    }
  }
  if (out.length === 0) return [`${indent}facts: {},`];
  return [`${indent}facts: {`, ...out, `${indent}},`];
}

// ---------------------------------------------------------------------------
// Scanner — NodeDefinition object literals in source
// ---------------------------------------------------------------------------

export interface DefLiteral {
  file: string;
  type: string;
  indent: string;
  // 0-based line indices into the file.
  typeLine: number;
  nameLine: number;
  // Same-indent `backend:` line — the insertion anchor for plain defs. Null
  // for factory call sites (makePrimitiveNode({...})) that omit it.
  backendLine: number | null;
  // Existing `facts:` block, inclusive, or null.
  factsStart: number | null;
  factsEnd: number | null;
  objectEnd: number;
}

export function listNodeFiles(root = "src/nodes"): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir)) {
      const p = join(dir, ent);
      if (statSync(p).isDirectory()) {
        if (ent !== "node_modules") walk(p);
      }
      else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

// A def literal is a `type: "<known type>",` line (or `type: CONST,` with a
// same-file string const) whose previous non-blank line opens an object and
// whose next few same-indent lines include `name:`. That shape is unique to
// NodeDefinition literals: params/sockets put `name:` before `type:`.
export function scanFile(
  file: string,
  knownTypes: ReadonlySet<string>,
  extraConsts: ReadonlyMap<string, string> = new Map()
): DefLiteral[] {
  const lines = readFileSync(file, "utf8").split("\n");
  const consts = new Map<string, string>(extraConsts);
  for (const l of lines) {
    const m = l.match(/^(?:export )?const ([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]+)"/);
    if (m) consts.set(m[1], m[2]);
  }
  const out: DefLiteral[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)type: (?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*)),\s*$/);
    if (!m) continue;
    const indent = m[1];
    const type = m[2] ?? consts.get(m[3]!);
    if (!type || !knownTypes.has(type)) continue;
    // Previous code line (skipping blanks and comments) must open an object.
    let p = i - 1;
    while (p >= 0 && (lines[p].trim() === "" || /^\s*(\/\/|\/\*|\*)/.test(lines[p]))) p--;
    if (p < 0 || !/[{(]\s*$/.test(lines[p])) continue;
    let nameLine = -1;
    for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j++) {
      if (lines[j].startsWith(`${indent}name:`)) {
        nameLine = j;
        break;
      }
    }
    if (nameLine < 0) continue;
    const outer = indent.slice(0, Math.max(0, indent.length - 2));
    const closeRe = new RegExp(`^${escapeRe(outer)}[})]`);
    let backendLine: number | null = null;
    let factsStart: number | null = null;
    let factsEnd: number | null = null;
    let objectEnd = lines.length - 1;
    for (let j = i + 1; j < lines.length; j++) {
      if (closeRe.test(lines[j])) {
        objectEnd = j;
        break;
      }
      if (backendLine == null && lines[j].startsWith(`${indent}backend:`)) backendLine = j;
      if (factsStart == null && lines[j].startsWith(`${indent}facts:`)) {
        factsStart = j;
        if (/^\s*facts: \{.*\},?\s*$/.test(lines[j])) factsEnd = j;
        else {
          const endRe = new RegExp(`^${escapeRe(indent)}\\},?\\s*$`);
          for (let k = j + 1; k < lines.length; k++) {
            if (endRe.test(lines[k])) {
              factsEnd = k;
              break;
            }
          }
          if (factsEnd == null) factsEnd = j;
        }
      }
    }
    out.push({ file, type, indent, typeLine: i, nameLine, backendLine, factsStart, factsEnd, objectEnd });
  }
  return out;
}

// Type-string consts exported from anywhere under src (`export const
// SWITCH_TYPE = "switch"`), so a def written as `type: SWITCH_TYPE,` resolves
// even when the const lives in another module.
export function exportedStringConsts(root = "src"): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of listNodeFiles(root)) {
    if (file.includes("/node_modules/")) continue;
    for (const l of readFileSync(file, "utf8").split("\n")) {
      const m = l.match(/^export const ([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]+)"/);
      if (m) out.set(m[1], m[2]);
    }
  }
  return out;
}

export function scanAll(knownTypes: ReadonlySet<string>, root = "src/nodes"): Map<string, DefLiteral[]> {
  const byType = new Map<string, DefLiteral[]>();
  const consts = exportedStringConsts();
  for (const file of listNodeFiles(root)) {
    for (const lit of scanFile(file, knownTypes, consts)) {
      const arr = byType.get(lit.type) ?? [];
      arr.push(lit);
      byType.set(lit.type, arr);
    }
  }
  return byType;
}

export function sourcesFor(lits: DefLiteral[] | undefined): string[] {
  const files = [...new Set((lits ?? []).map((l) => l.file))];
  return files.map((f) => readFileSync(f, "utf8"));
}
