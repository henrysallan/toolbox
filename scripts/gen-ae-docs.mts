// Bundles src/lib/ae-export/docs/**/*.md into src/lib/ae-export/docs/generated.ts
// so the editor serves them over the MCP bridge (get_ae_docs) without a loader.
//
//   npx tsx scripts/gen-ae-docs.mts           write generated.ts
//   npx tsx scripts/gen-ae-docs.mts --check   exit 1 when it is stale
//
// scripts/ae-export/check-docs.mts runs the same freshness check in npm run check.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { AE_DOCS_OUT, renderAeDocsModule } from "./ae-export/docs-lib.mts";

const next = renderAeDocsModule();
const current = existsSync(AE_DOCS_OUT) ? readFileSync(AE_DOCS_OUT, "utf8") : "";
if (process.argv.includes("--check")) {
  if (current !== next) {
    console.error("src/lib/ae-export/docs/generated.ts is stale — run `npx tsx scripts/gen-ae-docs.mts`.");
    process.exit(1);
  }
  console.log("ae docs: up to date");
} else if (current !== next) {
  writeFileSync(AE_DOCS_OUT, next);
  console.log("wrote src/lib/ae-export/docs/generated.ts");
} else {
  console.log("ae docs: unchanged");
}
