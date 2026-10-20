// Bundled After Effects docs for agents (spec 091926_after-effects-handoff.md
// §7.5, the get_ae_docs tool): ae-conventions (units, time, alpha, color),
// ae-host (the Toolbox Shader plug-in and bundles), ae-parity (reading
// compare_ae_renders diffs), and ae-nodes/<type> mapping notes.
//
// The markdown lives next to this file (nodes/ holds the per-type notes);
// scripts/gen-ae-docs.mts bundles it into generated.ts, and
// scripts/ae-export/check-docs.mts fails when that is stale.

import { AE_DOCS } from "./generated";

export { AE_DOCS };
export type { AeDoc } from "./generated";

export const AE_CORE_DOC_SLUGS = ["ae-conventions", "ae-host", "ae-parity"] as const;

// Same budget as get_glsl_docs: well under the size where tool results spill.
export const AE_DOCS_CHAR_CAP = 40_000;

export interface GetAeDocsArgs {
  // Doc slugs ("ae-host", "ae-nodes/blur"); omitted = the core docs.
  slugs?: string[] | string;
  // Node types → their ae-nodes/<type> notes.
  types?: string[] | string;
  cap?: number;
}

function asList(v: string[] | string | undefined): string[] {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).map((s) => String(s).trim()).filter(Boolean);
}

export function resolveAeDocSlugs(args: GetAeDocsArgs): { slugs: string[]; missing: string[] } {
  const explicit = asList(args.slugs).map((s) => s.replace(/\.md$/, "").replace(/^nodes\//, "ae-nodes/"));
  const types = asList(args.types);
  const out: string[] = [];
  const missing: string[] = [];
  const push = (s: string) => {
    if (!out.includes(s)) out.push(s);
  };
  if (explicit.length === 0 && types.length === 0) for (const s of AE_CORE_DOC_SLUGS) push(s);
  for (const s of explicit) {
    if (AE_DOCS[s]) push(s);
    else missing.push(s);
  }
  for (const t of types) {
    const slug = `ae-nodes/${t}`;
    if (AE_DOCS[slug]) push(slug);
    else missing.push(slug);
  }
  return { slugs: out, missing };
}

export function getAeDocs(args: GetAeDocsArgs = {}): string {
  const { slugs, missing } = resolveAeDocSlugs(args);
  const cap = typeof args.cap === "number" && args.cap > 0 ? args.cap : AE_DOCS_CHAR_CAP;
  const parts: string[] = [];
  const cut: string[] = [];
  let used = 0;
  for (const slug of slugs) {
    const doc = AE_DOCS[slug];
    const block = `## ${slug} — ${doc.title}\n\n${doc.body.trim()}\n`;
    if (used + block.length > cap && parts.length > 0) {
      cut.push(slug);
      continue;
    }
    parts.push(block);
    used += block.length;
  }
  const trailer: string[] = [];
  if (cut.length) trailer.push(`Cut for size (${cap} chars): ${cut.join(", ")} — call get_ae_docs again with slugs=[…] for these.`);
  if (missing.length)
    trailer.push(`No doc for: ${missing.join(", ")} — the node's plan_ae_export note and classes.ts entry are what there is.`);
  trailer.push(`Available slugs: ${Object.keys(AE_DOCS).join(", ")}.`);
  return `${parts.join("\n---\n\n")}\n---\n${trailer.join("\n")}\n`;
}
