// check-node-facts: the NodeFacts gate (specdocs/090626_node-facts.md).
// Every visible NodeDefinition must carry `facts`; each facts block must be
// well-formed (socket refs exist, spaces are in the vocabulary, attribute
// names appear in the def's source, gotchas are short), and the catalog DSL
// must render the header tables and one `# space:` line per node that has
// one. `--expect <dir>` additionally diffs the registered facts against JSON
// files produced by an authoring pass (what apply-node-facts consumed).
//
// Ratchet: a visible def without facts is tolerated only while its type is
// listed in scripts/node-facts-baseline.json — the not-yet-authored remainder
// of the 2026-09-06 bulk pass. A NEW visible def without facts fails. After an
// authoring run, pass --update-baseline to shrink the list (never grow it by
// hand).
//
//   npx tsx scripts/check-node-facts.mts [--expect <dir>] [--update-baseline]
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerAllNodes } from "@/nodes";
import { normalizeFacts, scanAll, sourcesFor, validateFacts } from "./node-facts-lib.mts";

function canon(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, (x as Record<string, unknown>)[k]]))
      : x
  );
}

// Register first, then reach the registry through a dynamic import: a static
// `@/engine/registry` import from an .mts script gets its own module instance
// (tsx's ESM/CJS split) that sees zero registered nodes.
registerAllNodes();
const { allNodeDefs } = await import("@/engine/registry");
const { buildNodeCatalog, formatCatalogDsl, FLAGS_DOC, SPACE_TABLE_DOC, Y_ORIENT_DOC } = await import(
  "@/engine/node-catalog"
);

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const defs = allNodeDefs();
const visible = defs.filter((d) => !d.hidden);
const literals = scanAll(new Set(defs.map((d) => d.type)));

const missing: string[] = [];
let invalid = 0;
for (const def of visible) {
  if (!def.facts) {
    missing.push(def.type);
    continue;
  }
  const errs = validateFacts(def, def.facts, sourcesFor(literals.get(def.type)));
  if (errs.length) {
    invalid++;
    console.log(`FAIL ${def.type}:\n  - ${errs.join("\n  - ")}`);
  }
}
const BASELINE = "scripts/node-facts-baseline.json";
const baseline = new Set<string>(
  existsSync(BASELINE) ? (JSON.parse(readFileSync(BASELINE, "utf8")).missing as string[]) : []
);
const newMissing = missing.filter((t) => !baseline.has(t));
const stale = [...baseline].filter((t) => !missing.includes(t));
console.log(`info facts on ${visible.length - missing.length}/${visible.length} visible nodes; ${missing.length} pending in ${BASELINE}`);
check(
  "no visible node lacks facts beyond the baseline",
  newMissing.length === 0,
  newMissing.length ? `${newMissing.length} new: ${newMissing.join(", ")} — author with the node-facts skill` : undefined
);
if (process.argv.includes("--update-baseline")) {
  writeFileSync(BASELINE, JSON.stringify({ missing: [...missing].sort() }, null, 2) + "\n");
  console.log(`info wrote ${BASELINE} (${missing.length} pending)`);
} else if (stale.length) {
  console.log(`info ${stale.length} baseline entr${stale.length === 1 ? "y" : "ies"} now carry facts — run with --update-baseline to shrink the list`);
}
check("every facts block is well-formed", invalid === 0, invalid ? `${invalid} invalid` : undefined);

const dsl = formatCatalogDsl(buildNodeCatalog(defs));
check("catalog DSL header carries the space table", dsl.includes(SPACE_TABLE_DOC));
check("catalog DSL header carries Y orientation", dsl.includes(Y_ORIENT_DOC));
check("catalog DSL header carries the flags doc", dsl.includes(FLAGS_DOC));
const withSpace = visible.filter((d) => d.facts?.space && Object.keys(d.facts.space).length).length;
const rendered = (dsl.match(/^    # space: /gm) ?? []).length;
check("every space fact renders in the DSL", rendered >= withSpace, `${rendered} rendered / ${withSpace} declared`);

const ei = process.argv.indexOf("--expect");
if (ei >= 0) {
  const dir = process.argv[ei + 1];
  if (!dir) {
    console.error("--expect needs a directory");
    process.exit(2);
  }
  const byType = new Map(defs.map((d) => [d.type, d]));
  let compared = 0;
  const mismatched: string[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const parsed = JSON.parse(readFileSync(join(dir, f), "utf8"));
    for (const e of Array.isArray(parsed) ? parsed : [parsed]) {
      const def = byType.get(e.type);
      if (!def) continue;
      compared++;
      // Key-order-insensitive, after the same normalization the codemod applies.
      if (canon(def.facts ?? null) !== canon(normalizeFacts(e.facts ?? null).facts)) mismatched.push(e.type);
    }
  }
  check(
    `registered facts match ${dir}`,
    mismatched.length === 0,
    mismatched.length ? `${mismatched.length}/${compared} differ: ${mismatched.join(", ")}` : `${compared} compared`
  );
}

console.log(`\ncheck-node-facts: ${failures === 0 ? "all passed" : `${failures} failure(s)`}`);
process.exit(failures ? 1 : 0);
