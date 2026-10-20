// Bundled After Effects docs for agents (spec §7.5 get_ae_docs): ae-conventions,
// ae-host, ae-parity, and ae-nodes/<type> mapping notes.
//
// CONTRACT STUB — committed before wave 2. The docs lane fills the content
// (and likely a generated module, like src/lib/glsl-translation/docs); the
// package lane wires the get_ae_docs bridged tool to getAeDocs.

export const AE_CORE_DOC_SLUGS = ["ae-conventions", "ae-host", "ae-parity"] as const;

export interface GetAeDocsArgs {
  // Doc slugs ("ae-host", "ae-nodes/blur"); omitted = the core docs.
  slugs?: string[];
}

export function getAeDocs(args: GetAeDocsArgs = {}): string {
  const slugs = args.slugs?.length ? args.slugs : [...AE_CORE_DOC_SLUGS];
  return `get_ae_docs: not written yet (requested: ${slugs.join(", ")}). Use specdocs/091926_after-effects-handoff.md §4 and src/lib/ae-export/shader/ABI.md meanwhile.`;
}
