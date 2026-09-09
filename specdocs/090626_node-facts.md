# Node facts — a scannable mini-schema behind `description`

2026-09-06. Status: complete — schema, formatter, gate, codemod, skill, and the full
authoring pass (see §Results).

## Problem

The MCP `get_catalog` DSL and the docs reference both print each node's
free-text `description`. Those strings mix behavior with feature marketing,
and the operational facts an agent needs land wherever the prose put them —
Grid's ix/iy stamping was the last clause of the last sentence, and a model
building a graph from the catalog relied on it and missed it. With ~300
nodes, "write better prose" does not scale and cannot be linted.

## Design

A typed block on every visible `NodeDefinition` (`src/engine/types.ts`):

```ts
facts?: {
  space?: Record<SocketRef, CoordSpace | CoordSpace[] | SocketRef>;
  reads?: string[];   // "attr:<name>" | "time"
  writes?: string[];  // "attr:<name>"
  gotchas?: string[]; // one operational sentence each
};
```

- **space** is keyed per socket/param (`in:<name>` | `out` | `aux:<name>` |
  `param:<name>`), which is what makes polymorphic and multi-socket nodes
  representable: a value is a `CoordSpace`, a list of spaces (one per wire
  type a polymorphic input accepts), or a socket ref meaning "same space as
  that socket" (`out: "in:image"`). The catalog header states the default
  space per socket type, so per-node entries list only exceptions,
  position/size params, and follow-rules.
- **CoordSpace** = `canvas01` (authored 2D, width units, y scaled about 0.5
  by W/H) · `uv01` (per-axis raster fraction, not aspect-corrected) ·
  `raster` · `pixels` · `world3d` · `time` · `unitless`. `uv01` exists because
  Displace's amount is a UV offset, which is neither canvas01 nor pixels.
- **reads/writes** name point/spline attributes; the gate refuses a name
  that is not a string literal in the node's source (cheap hallucination
  check), except the engine's well-known names.
- **flags** are never authored: `simulation`, `unstable`, `terminal`,
  `no-mask`, `gates-outputs`, `retimeable`, `clock=<input>` derive from
  existing def fields (`catalogFlags` in `node-catalog.ts`).

The DSL prints fixed slots under each node, after the description:
`# space:` · `# reads:` · `# writes:` · `# flags:` · one `# !` per gotcha.
Two header lines (`SPACE_TABLE_DOC`, `FLAGS_DOC`) define the vocabulary
once. The docs page (`NodeRef.tsx`) renders the same lines through the same
formatter, so humans and the model read identical text.

`description` stays as the one-sentence "what it does"; trimming the
existing prose is a separate, later decision (the authoring pass records a
`summary` proposal per node for it).

## Tooling

- `scripts/node-facts-lib.mts` — vocabulary, `validateFacts`, the source
  block formatter, and a scanner that finds NodeDefinition literals under
  `src/nodes` (handles `type: CONST`, comment-separated literals, factory
  call sites, backend-variant duplicates).
- `scripts/apply-node-facts.mts <json|dir>` — validates each entry against
  the registered def, then inserts/replaces the `facts:` block above
  `backend:` (or under `name:` in factory call sites). Re-scans each file
  immediately before writing.
- `scripts/check-node-facts.mts` — the gate, in `npm run check`. Presence on
  every visible def, well-formedness, DSL rendering; `--expect <dir>` diffs
  registered facts against an authoring pass's JSON.
- `.claude/skills/node-facts/` — the authoring skill; `references/style.md`
  is the style guide with six hand-written gold examples (grid, blur,
  displace, sdf-circle, cube-3d, audio-filter). Symlinked into
  `~/.claude/skills`.
- Gotcha for script authors: an `.mts` script must reach `@/engine/registry`
  through a dynamic import *after* `registerAllNodes()`; a static import
  gets a second module instance under tsx that sees zero nodes.

## Authoring pass

292 nodes after the gold six, grouped into 26 batches of ~3.8k source lines
by file; one Sonnet agent per batch reads the style guide and the files,
writes `{type, facts, summary, uncertain}` JSON only, never touches the
repo. The codemod applies centrally; its SKIP lines are the validator's
findings and go back to the authoring agent. `check-node-facts --expect`
confirms what landed equals what was authored.

## Results

Complete (2026-09-06): 298/298 visible nodes carry facts — 6 gold plus
292 authored by Sonnet subagents over two runs (the first was cut
short by the account's monthly spend limit at ~100 nodes; the second, run
after the reset, finished the rest). `scripts/node-facts-baseline.json` is
gone: the gate now fails any visible def without facts outright. Agent
summaries and `uncertain` notes (18 nodes) are in
`archive/node-facts-review.md` — read the Uncertain section first; it is
where the schema's vocabulary strained (layout units of 1/1000 min(W,H),
resolution-scaled sim units, enum-dependent param meaning).

Observations from the pass:

- Validator rejections were almost all gotchas a few characters over the
  cap (raised 180 → 200; over-long survivors were split at a semicolon) and
  wire-type names used as spaces on polymorphic inputs; the codemod
  normalizes the latter through the socket-type default table.
- Two validator loosenings were needed and are deliberate: `driver` and
  `width` joined the well-known attribute list (spline subpath fields
  stamped by engine helpers, not in node files), and a bare object key
  (`attributes = { confidence: … }`) now counts as evidence of an attribute
  name alongside quoted literals.
- The facts surfaced real inconsistencies worth a look: several nodes emit
  points/positions as per-axis UV fractions rather than canvas01 (Bento
  Slice and Adaptive Pixelate `points` aux, Space Fill, Object Tracker
  boxes, Proximity Merge distance, Text and Autolayout translate/pivot);
  Reaction Diffusion's seed reads only R while its description claims R→U,
  G→V; ASCII's index aux ordering contradicts its own comment; Math's uv
  mode silently no-ops on log/smin/smax/wrap/atan2; SDF To Spline's
  `aspect_correct` is a no-op because its readback target is always square;
  Particle Simulator's WebGPU backend advertises a points aux it never
  emits; Image Generate's ref sockets are never read by compute().
- Sonnet agents stalled repeatedly on API timeouts in the first run; agents
  told to write each JSON right after reading its file preserved progress
  across stalls, agents that batched their writes lost everything. The
  second run used that instruction throughout and lost nothing.

## Follow-ups

- Apply the `summary` proposals as trimmed descriptions once reviewed.
- The validator could grow a measured `writes` check: run each point node
  headlessly with defaults and diff attribute names in vs out
  (`socket-inspect.ts` already exposes `attrNames`).
- The validator could later warn when a consumer reads an attribute nothing
  upstream writes, now that `writes` is data.
