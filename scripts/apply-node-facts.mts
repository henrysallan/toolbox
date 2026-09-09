// apply-node-facts: codemod that writes NodeFacts into NodeDefinition source
// literals (specdocs/090626_node-facts.md). Input is one or more JSON files
// (or directories of them), each holding `{ type, facts }` or an array of
// those. Extra keys (summary, uncertain, notes) are ignored so an authoring
// agent can carry its own scratch fields.
//
//   npx tsx scripts/apply-node-facts.mts <facts.json | dir> [...] [--dry]
//
// Every entry is validated against the registered def before anything is
// written; invalid entries are reported and skipped, valid ones land. A type
// with several literals (backend variants) gets the block in each. An
// existing `facts:` block is replaced in place; otherwise the block goes just
// above `backend:` (or, for factory call sites without one, right under
// `name:`). Files are re-scanned immediately before writing so a concurrent
// edit elsewhere in the file is not clobbered.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerAllNodes } from "@/nodes";
import type { NodeFacts } from "@/engine/types";
import {
  exportedStringConsts,
  formatFactsBlock,
  normalizeFacts,
  scanAll,
  scanFile,
  sourcesFor,
  validateFacts,
  type DefLiteral,
} from "./node-facts-lib.mts";

// Register first, then reach the registry through a dynamic import: a static
// `@/engine/registry` import from an .mts script gets its own module instance
// (tsx's ESM/CJS split) that sees zero registered nodes.
registerAllNodes();
const { allNodeDefs, getNodeDef } = await import("@/engine/registry");

const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const paths = argv.filter((a) => !a.startsWith("--"));
if (paths.length === 0) {
  console.error("usage: tsx scripts/apply-node-facts.mts <facts.json | dir> [...] [--dry]");
  process.exit(2);
}

function expand(p: string): string[] {
  if (statSync(p).isDirectory())
    return readdirSync(p)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => join(p, f));
  return [p];
}

interface Entry {
  type: string;
  facts: unknown;
  _src: string;
}
const entries: Entry[] = [];
for (const p of paths) {
  for (const file of expand(p)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      console.log(`SKIP ${file}: ${(e as Error).message}`);
      continue;
    }
    for (const e of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!e || typeof e !== "object" || typeof (e as Entry).type !== "string") {
        console.log(`SKIP ${file}: entry without a string "type"`);
        continue;
      }
      entries.push({ type: (e as Entry).type, facts: (e as Entry).facts, _src: file });
    }
  }
}

const knownTypes = new Set(allNodeDefs().map((d) => d.type));
const literals = scanAll(knownTypes);
const consts = exportedStringConsts();

const byFile = new Map<string, { type: string; ordinal: number; facts: NodeFacts }[]>();
let skipped = 0;
let applied = 0;
for (const e of entries) {
  const def = getNodeDef(e.type);
  if (!def) {
    console.log(`SKIP ${e.type}: not a registered node type (${e._src})`);
    skipped++;
    continue;
  }
  const lits = literals.get(e.type);
  if (!lits?.length) {
    console.log(`SKIP ${e.type}: no NodeDefinition literal found under src/nodes — add facts by hand`);
    skipped++;
    continue;
  }
  const norm = normalizeFacts(e.facts);
  if (norm.notes.length) console.log(`note ${e.type}: normalized ${norm.notes.join("; ")}`);
  e.facts = norm.facts;
  const errs = validateFacts(def, e.facts, sourcesFor(lits));
  if (errs.length) {
    console.log(`SKIP ${e.type} (${e._src}):\n  - ${errs.join("\n  - ")}`);
    skipped++;
    continue;
  }
  const perFile = new Map<string, number>();
  for (const lit of lits) {
    const ordinal = perFile.get(lit.file) ?? 0;
    perFile.set(lit.file, ordinal + 1);
    const arr = byFile.get(lit.file) ?? [];
    arr.push({ type: e.type, ordinal, facts: e.facts as NodeFacts });
    byFile.set(lit.file, arr);
  }
}

for (const [file, edits] of byFile) {
  const fresh = scanFile(file, knownTypes, consts);
  const lines = readFileSync(file, "utf8").split("\n");
  const planned: { lit: DefLiteral; facts: NodeFacts }[] = [];
  for (const e of edits) {
    const lit = fresh.filter((l) => l.type === e.type)[e.ordinal];
    if (!lit) {
      console.log(`SKIP ${e.type}: literal moved in ${file} between scan and write — rerun`);
      skipped++;
      continue;
    }
    planned.push({ lit, facts: e.facts });
  }
  // Bottom-up so earlier line indices stay valid.
  const anchor = (l: DefLiteral) => l.factsStart ?? l.backendLine ?? l.nameLine + 1;
  planned.sort((a, b) => anchor(b.lit) - anchor(a.lit));
  for (const { lit, facts } of planned) {
    const block = formatFactsBlock(facts, lit.indent);
    if (lit.factsStart != null && lit.factsEnd != null) {
      lines.splice(lit.factsStart, lit.factsEnd - lit.factsStart + 1, ...block);
    } else if (lit.backendLine != null) {
      lines.splice(lit.backendLine, 0, ...block);
    } else {
      lines.splice(lit.nameLine + 1, 0, ...block);
    }
    console.log(`${dry ? "would write" : "ok"} ${lit.type} → ${file}:${anchor(lit) + 1}`);
    applied++;
  }
  if (!dry) writeFileSync(file, lines.join("\n"));
}

console.log(`\n${applied} literal(s) ${dry ? "would be " : ""}updated, ${skipped} entr${skipped === 1 ? "y" : "ies"} skipped`);
process.exit(skipped ? 1 : 0);
