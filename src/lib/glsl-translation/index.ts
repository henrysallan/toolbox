// Graph → GLSL translation support (spec 091626_graph-to-glsl.md): the
// class table, the planner, and the bundled docs the `get_glsl_docs` tool
// serves. Nothing here touches GL or React — the MCP handler and the gate
// both import from this one place.

import { GLSL_DOCS, type GlslDoc } from "./docs.generated";
import { translationEntry } from "./classes";

export { planTranslation, proposeFrames, parseEndpoint } from "./plan";
export type { PlanInput, PlanNode, PlanEdge, PlanNodeInfo, TranslationPlan } from "./plan";
export {
  TRANSLATION_CLASSES,
  FUSABLE_CLASSES,
  translationEntry,
  isClassified,
} from "./classes";
export type { TranslationClass, TranslationEntry } from "./classes";
export { GLSL_DOCS };
export type { GlslDoc };
export {
  COMPARE_DEFAULTS,
  compareRgba,
  describeMetrics,
  diffHeatRgba,
  verdictOf,
} from "./compare";
export type { CompareMetrics } from "./compare";

// Always served first unless the caller passes explicit slugs without it.
export const CORE_DOC_SLUGS = ["conventions", "fusion", "parity"] as const;

// Under the spill threshold Claude Code applies to tool results (the panel
// spec measured ~174k chars for get_catalog; keep well clear).
export const DOCS_CHAR_CAP = 40_000;

export interface GetGlslDocsArgs {
  slugs?: string[] | string;
  types?: string[] | string;
  // Override the size cap (tests).
  cap?: number;
}

function asList(v: string[] | string | undefined): string[] {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).map((s) => String(s).trim()).filter(Boolean);
}

// Resolve node types to their doc slugs through the class table. Types
// without a doc (or unknown types) come back under `missing` so the agent
// hears about them instead of assuming the doc was read.
export function resolveDocSlugs(args: GetGlslDocsArgs): { slugs: string[]; missing: string[] } {
  const explicit = asList(args.slugs);
  const types = asList(args.types);
  const out: string[] = [];
  const missing: string[] = [];
  const push = (s: string) => {
    if (!out.includes(s)) out.push(s);
  };
  // Core docs lead unless the caller gave slugs and left them out on purpose.
  if (explicit.length === 0) for (const s of CORE_DOC_SLUGS) push(s);
  for (const s of explicit) {
    const slug = s.replace(/\.md$/, "");
    if (GLSL_DOCS[slug]) push(slug);
    else missing.push(slug);
  }
  for (const t of types) {
    const entry = translationEntry(t);
    if (entry.doc && GLSL_DOCS[`nodes/${entry.doc}`]) push(`nodes/${entry.doc}`);
    else missing.push(`nodes/${entry.doc ?? t}`);
  }
  return { slugs: out, missing };
}

// The tool result: concatenated markdown with one `## <slug>` header per
// doc, capped in size, and a trailer naming what was missing or cut.
export function getGlslDocs(args: GetGlslDocsArgs = {}): string {
  const { slugs, missing } = resolveDocSlugs(args);
  const cap = typeof args.cap === "number" && args.cap > 0 ? args.cap : DOCS_CHAR_CAP;
  const parts: string[] = [];
  const cut: string[] = [];
  let used = 0;
  for (const slug of slugs) {
    const doc = GLSL_DOCS[slug];
    const block = `## ${slug} — ${doc.title}\n\n${doc.body.trim()}\n`;
    if (used + block.length > cap && parts.length > 0) {
      cut.push(slug);
      continue;
    }
    parts.push(block);
    used += block.length;
  }
  const trailer: string[] = [];
  if (cut.length)
    trailer.push(
      `Cut for size (${cap} chars): ${cut.join(", ")} — call get_glsl_docs again with slugs=[…] for these.`
    );
  if (missing.length)
    trailer.push(
      `No doc for: ${missing.join(", ")} — use get_node_source on the node type and port its shader directly.`
    );
  trailer.push(`Available slugs: ${Object.keys(GLSL_DOCS).join(", ")}.`);
  return `${parts.join("\n---\n\n")}\n---\n${trailer.join("\n")}\n`;
}
