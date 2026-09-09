---
name: node-facts
description: Author or refresh the NodeFacts block (space / reads / writes / gotchas) for one or more toolbox nodes from their source, apply it with the codemod, and run the gate. Use when adding a node, when a node's behavior or units changed, when check-node-facts fails, or when a node's MCP catalog entry misled someone.
---

# node-facts

Facts are the scannable mini-schema next to `description` on every visible
node. Read [references/style.md](references/style.md) first, every time — it
holds the vocabulary, the rules the gate enforces, and six gold examples.

## Steps

1. Resolve the targets: a type string, a file, or "whatever is missing"
   (`npx tsx scripts/check-node-facts.mts` lists missing and invalid types).
   Find the literal with `grep -rn 'type: "<type>",' src/nodes`; the 3D
   primitives are factory calls in `src/nodes/three/primitives.ts` and
   `curve-primitives.ts`.
2. Read the whole node file. Follow the imports that decide units and
   attributes (shader source, `@/engine/convolve`, `@/engine/points` helpers,
   the aspect helper). The math outranks labels, comments, and the current
   description.
3. Write one JSON per node into a scratch directory:
   `{ "type", "facts", "summary", "uncertain" }` per the style guide. When
   refreshing, start from the existing `facts` block and change only what the
   code contradicts.
4. Apply: `npx tsx scripts/apply-node-facts.mts <dir-or-file>`. Every SKIP
   line is a validator finding — fix the JSON and rerun. Never hand-edit the
   `facts:` block around the codemod; it replaces the block in place.
5. Gate: `npx tsx scripts/check-node-facts.mts`, then `npm run typecheck`.
6. Read the result the way the model will: `npx tsx scripts/dump-node-catalog.mts`
   and grep the type in `specdocs/archive/node-catalog.dsl.txt`. A line that
   reads as marketing or restates the schema gets cut.

## Bulk pass

For many nodes, fan out one agent per batch of files (~4k source lines each)
carrying this style guide and its file list; agents write JSON only, never
touch the repo; apply and gate centrally, then send the SKIP list back to the
agent that produced it. The first full pass (2026-09-06) is described in
`specdocs/090626_node-facts.md`.
