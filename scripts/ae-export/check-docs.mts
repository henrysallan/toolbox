// get_ae_docs content (src/lib/ae-export/docs): the generated module is fresh,
// the core docs exist, node docs name real node types, and getAeDocs resolves,
// caps and reports missing slugs.

import { existsSync, readFileSync } from "node:fs";
import { makeChecker, loadRegistry } from "./harness.mts";
import { AE_DOCS_OUT, renderAeDocsModule } from "./docs-lib.mts";

export default async function run(): Promise<number> {
  const c = makeChecker("docs");
  const fresh = existsSync(AE_DOCS_OUT) && readFileSync(AE_DOCS_OUT, "utf8") === renderAeDocsModule();
  c.check("docs/generated.ts is up to date (npx tsx scripts/gen-ae-docs.mts)", fresh);

  const { AE_DOCS, AE_CORE_DOC_SLUGS, getAeDocs, resolveAeDocSlugs } = await import("@/lib/ae-export/docs");
  for (const s of AE_CORE_DOC_SLUGS) c.check(`core doc ${s} exists`, !!AE_DOCS[s]?.body.trim());

  await loadRegistry();
  const { getNodeDef } = await import("@/engine/registry");
  const nodeSlugs = Object.keys(AE_DOCS).filter((s) => s.startsWith("ae-nodes/"));
  for (const s of nodeSlugs) {
    const type = s.slice("ae-nodes/".length);
    c.check(`${s} names a registered node type`, !!getNodeDef(type));
  }

  const core = getAeDocs();
  c.check("no args → the three core docs, in order", core.indexOf("## ae-conventions") < core.indexOf("## ae-host") && core.indexOf("## ae-host") < core.indexOf("## ae-parity"));
  c.check("types resolve to ae-nodes/<type>", resolveAeDocSlugs({ types: ["merge"] }).slugs.join() === "ae-nodes/merge");
  c.check("nodes/<type> is accepted as an alias", resolveAeDocSlugs({ slugs: ["nodes/merge"] }).slugs.join() === "ae-nodes/merge");
  c.check("unknown slugs are reported, not dropped", getAeDocs({ slugs: ["nope"] }).includes("No doc for: nope"));
  const capped = getAeDocs({ slugs: [...AE_CORE_DOC_SLUGS], cap: 500 });
  c.check("the size cap keeps the first doc and names what it cut", capped.includes("## ae-conventions") && capped.includes("Cut for size (500 chars): ae-host, ae-parity"));
  c.check("every doc fits the default cap on its own", Object.values(AE_DOCS).every((d) => d.body.length < 40_000));
  return c.failures;
}
