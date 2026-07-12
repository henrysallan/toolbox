// Lint ratchet — fail CI only when lint ERRORS grow, per file.
//
// The repo carries a known pile of pre-existing lint errors (mostly React 19
// hooks rules vs the ref-mirror pattern; see riskfix-plan 070826 §2). A
// plain `eslint` gate would be red on every push until that cleanup lands,
// which trains everyone to ignore the job. This script makes the job a real
// signal: it compares the current per-file error counts against the
// committed baseline (scripts/lint-baseline.json) and fails only if any
// file has MORE errors than the baseline allows. New files start at zero.
//
// Per-file (not one repo-wide total) so a new error can't hide behind an
// unrelated fix elsewhere. Moving code between files therefore needs a
// deliberate re-baseline — that's intended friction.
//
// Warnings are reported but never gate.
//
// Usage:
//   npm run lint:ratchet             # compare against the baseline
//   npm run lint:ratchet -- --update # rewrite the baseline to match reality
//
// When you FIX errors, run --update and commit the new baseline so the
// ratchet tightens behind you. When the total hits zero, delete the
// baseline and this script, and gate on plain `eslint`.

import { ESLint } from "eslint";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const baselinePath = path.join(repoRoot, "scripts", "lint-baseline.json");
const update = process.argv.includes("--update");

interface LintMessage {
  severity: number;
  line: number;
  column: number;
  ruleId: string | null;
  message: string;
}
interface LintResult {
  filePath: string;
  messages: LintMessage[];
}

// Lint through the Node API — same flat config (eslint.config.mjs), same
// file set as a bare `eslint` run, no subprocess/PATH games.
let results: LintResult[];
try {
  const eslint = new ESLint({ cwd: repoRoot });
  results = (await eslint.lintFiles(["."])) as LintResult[];
} catch (err) {
  console.error("eslint failed to run (config error?):", err);
  process.exit(2);
}

// Current per-file error counts (repo-relative, zero-count files omitted).
const current = new Map<string, number>();
const errorDetails = new Map<string, LintMessage[]>();
let warningTotal = 0;
for (const r of results) {
  const rel = path.relative(repoRoot, r.filePath);
  const errors = r.messages.filter((m) => m.severity === 2);
  warningTotal += r.messages.length - errors.length;
  if (errors.length > 0) {
    current.set(rel, errors.length);
    errorDetails.set(rel, errors);
  }
}
const currentTotal = [...current.values()].reduce((a, b) => a + b, 0);

if (update) {
  const sorted = Object.fromEntries(
    [...current.entries()].sort(([a], [b]) => a.localeCompare(b))
  );
  writeFileSync(baselinePath, JSON.stringify(sorted, null, 2) + "\n");
  console.log(
    `Baseline updated: ${currentTotal} error(s) across ${current.size} file(s).`
  );
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error(
    `No baseline at ${path.relative(repoRoot, baselinePath)} — run ` +
      "`npm run lint:ratchet -- --update` and commit it."
  );
  process.exit(2);
}
const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<
  string,
  number
>;
const baselineTotal = Object.values(baseline).reduce((a, b) => a + b, 0);

// Regressions: any file above its baseline allowance (new files allow 0).
const regressions: Array<{ file: string; was: number; now: number }> = [];
for (const [file, now] of current) {
  const was = baseline[file] ?? 0;
  if (now > was) regressions.push({ file, was, now });
}
// Improvements: files now below their allowance (or clean entirely).
let improved = 0;
for (const [file, was] of Object.entries(baseline)) {
  const now = current.get(file) ?? 0;
  if (now < was) improved += was - now;
}

console.log(
  `lint ratchet: ${currentTotal} error(s) now vs ${baselineTotal} in baseline; ` +
    `${warningTotal} warning(s) (warnings never gate).`
);

if (regressions.length > 0) {
  console.error("\nNEW lint errors (above the committed baseline):\n");
  for (const { file, was, now } of regressions) {
    console.error(`  ${file}: ${now} error(s), baseline allows ${was}`);
    const msgs = errorDetails.get(file) ?? [];
    // Print enough to act on without flooding the log.
    for (const m of msgs.slice(0, 20)) {
      console.error(
        `    ${m.line}:${m.column}  ${m.ruleId ?? "?"}  ${m.message.split("\n")[0]}`
      );
    }
    if (msgs.length > 20) console.error(`    … ${msgs.length - 20} more`);
  }
  console.error(
    "\nFix the new errors (preferred), or — if this is a deliberate move/" +
      "rename — re-baseline with `npm run lint:ratchet -- --update` and " +
      "commit scripts/lint-baseline.json.\n"
  );
  process.exit(1);
}

if (improved > 0) {
  console.log(
    `${improved} error(s) fixed vs baseline — tighten the ratchet: ` +
      "`npm run lint:ratchet -- --update` and commit the baseline."
  );
}
console.log("ALL GREEN ✅ (no new lint errors)");
