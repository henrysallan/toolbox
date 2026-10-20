// check-ae-export: the After Effects export gates (spec 091926_after-effects-handoff.md §6, §9).
//
// Runs every scripts/ae-export/check-*.mts in name order, in one process, and
// fails if any area reports failures. Each area file default-exports an async
// function returning its failure count (see scripts/ae-export/harness.mts).
//
//   npx tsx scripts/check-ae-export.mts            all areas
//   npx tsx scripts/check-ae-export.mts easing     areas whose file name contains "easing"

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "ae-export");
const filter = process.argv[2];
const files = readdirSync(dir)
  .filter((f) => /^check-.*\.mts$/.test(f) && (!filter || f.includes(filter)))
  .sort();

let failures = 0;
for (const f of files) {
  console.log(`\n${f}`);
  const mod = await import(pathToFileURL(join(dir, f)).href);
  const n: number = await mod.default();
  failures += n;
  if (n) console.log(`  → ${n} failed`);
}

console.log(
  failures === 0
    ? `\ncheck-ae-export: all passed (${files.length} areas)`
    : `\ncheck-ae-export: ${failures} FAILED`
);
process.exit(failures === 0 ? 0 : 1);
