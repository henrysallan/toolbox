# MCP node-source tools — let Claude read the engine

Spec — 2026-07-12. Status: **shipped 2026-07-12** (all three milestones).
Extends 070926_claude-mcp-bridge.md.

## Why

The bridge's `get_catalog` is the interface summary — one DSL line per node.
That's enough to wire a correct graph, but not to answer *why does this node
behave this way* or to teach the user *how to build a tree well*. Today the
model either guesses from the catalog description or hallucinates node
internals. The repo is public (github.com/henrysallan/toolbox); the node
defs and the engine helpers they call ARE the ground truth. Give the agent
read access and both use cases open up:

- **Deeper understanding on demand** — before wiring an unfamiliar node,
  read its `compute`, its param semantics, the coercions that apply.
  ("Why does image→mask matte by silhouette?" → coerce.ts says
  luminance × alpha, with the exact rationale in a comment.)
- **Grounded user education** — "how should I build X?" answers can cite
  real behavior (file:line) instead of plausible-sounding fiction.

## Topology — server-side tools, not bridge commands

Every existing tool marshals over the WebSocket to the editor tab. These
three DON'T: the MCP server is a Node process launched **from the repo
checkout** (`node scripts/mcp-server.mjs`), so the source sits on disk next
to it. Tools read with `node:fs` — no bridge round-trip, and they work even
when no editor is connected/paired. The compiled site never serves source;
it doesn't need to.

**GitHub is the version-skew fallback, not the primary path.** The pairing
handshake already carries `appVersion`. If the paired editor's version ≠ the
checkout's `package.json` version (user runs the hosted app or a packaged
desktop build against a drifted checkout), `get_node_source`/`read_source`
fetch `https://raw.githubusercontent.com/henrysallan/toolbox/v<appVersion>/<path>`
so Claude reads the code the user is actually running. In-memory cache per
(ref, path) per boot; tag-404 or offline falls back to local with a
`versionNote` in the result. Unpaired ⇒ local, no note. This also
future-proofs the distributed-server case (.mcpb) the bridge spec parked —
a server without a checkout flips to GitHub-only.

## Tool surface (read-only, auto-approvable)

- `get_node_source({ type })` — resolve a catalog type string to its file
  under `src/nodes/` and return the full source (line-numbered), plus:
  the resolved repo path, and the file's `@/engine/*` import list as
  follow-up pointers ("the real spline math is in engine/spline-boolean.ts").
  Unknown type ⇒ error listing near-miss suggestions.
- `read_source({ path, start?, end? })` — read any file under the allowed
  scope: **`src/nodes/` + `src/engine/`** (where behavior actually lives —
  types.ts, coerce.ts, evaluator.ts, the domain math). Line-numbered;
  optional line range; files > ~1500 lines without a range return the head
  plus a "pass a range" note instead of blowing up context. Path-traversal
  guarded (resolve + prefix check, reject `..`/absolute escapes).
- `search_source({ pattern, glob? })` — regex search over the same scope,
  returning `path:line: text` matches (capped ~200, cap noted in the
  result). **Local checkout only** — GitHub has no per-tag grep API; when
  version-skewed the result carries the same `versionNote`. This is what
  turns a source dive into a loop instead of path-guessing.

Tool descriptions must steer economy: catalog first; source only when the
catalog/docs answer isn't enough; cite `file:line` when explaining behavior
to the user. (Same philosophy as screenshot_strip's "don't default to
many".)

## The type→file index

Built lazily once per boot (and per fetched ref), by walking `src/nodes/`
and matching def headers — a def's `type:` line is immediately followed by
`name:` (`/type:\s*"([a-z0-9_-]+)",\s*\n\s*name:/g`), which skips the
`type:` noise in param/input declarations and handles multi-def files
(three/primitives.ts registers six). Legacy hidden aliases registered in
index.ts (`{...def, type: "<old>", hidden: true}`) map onto the same file
by scanning index.ts for those literals. A type that misses the index falls
back to a scoped grep for `"<type>"` before erroring.

## Security

Read-only over a public repo — nothing new is disclosed. The scope
(`src/nodes/` + `src/engine/`) is exactly the subtree exported apps already
ship verbatim (engine self-containment invariant), so it contains no
secrets by construction. Traversal guard keeps the tools inside it anyway.

## Non-goals

- No write/patch tools — the mutation path stays the recipe trust boundary.
- No whole-repo scope (UI/EffectsApp dives) — revisit if real sessions
  want it; widening is a one-line scope change.
- No docs-layer resources yet (in-app docs pages, devguide concept
  sections) — deferred by owner; judge after seeing real sessions.

## Milestones

1. **Local read** — the three tools against the checkout: type→file index,
   scope + traversal guard, line-numbered output, range/cap behavior,
   near-miss suggestions. Extend `npm run check:mcp` (tools need no editor,
   so the e2e covers them without the bridge). Verify from Claude Code:
   "how does spline-merge's union actually work?" answers with
   engine/spline-boolean.ts specifics.
   ✅ **Shipped 2026-07-12**: [scripts/mcp-source.mjs](../../scripts/mcp-source.mjs)
   (`createSourceReader()` — type index built from the local `src/nodes` walk
   via the `type:`→`name:` header regex + hidden-alias resolution through
   index.ts imports; scoped path guard; grep fallback + near-miss suggestions;
   1500-line cap on unranged reads). Three tools registered in
   `scripts/mcp-server.mjs`. `check-mcp.mts` gained six source-tool checks
   that run BEFORE pairing (proving the tools need no bridge).
2. **Version-skew fallback** — compare handshake `appVersion` vs local
   package.json; tagged raw.githubusercontent fetch + per-boot cache +
   `versionNote`; offline/404 fallback to local. Verify by pairing a
   deliberately version-bumped editor.
   ✅ **Shipped 2026-07-12**: `skewRef()` gates on a semver `appVersion` that
   differs from the checkout's `package.json` version (non-semver like
   "unknown"/"e2e" ⇒ local, no note); `loadFile()` fetches
   `raw.githubusercontent.com/…/v<appVersion>/<path>`, caches by (ref, path)
   incl. remembering 404s, and degrades to local with a fallback note on
   404/offline. Verified against the real v0.3.0 tag (returns the pinned
   older file, distinct from local) and a bogus v9.9.9 (404 → local, ~370ms,
   no hang). `search_source` stays local-only with a skew note.
3. **Docs** — devguide note, bridge-spec cross-reference, devlist tick.
   Update SYSTEM_PREAMBLE/skills only if sessions show the model not
   reaching for the tools when it should.
   ✅ **Shipped 2026-07-12**: devguide repo-map note on
   `scripts/mcp-source.mjs`; devlist #178 ticked; this doc's milestones
   marked shipped. Preamble/skill nudges deferred until real sessions show a
   need.

## Decisions (owner, 2026-07-12)

1. **Source of truth** — local checkout first; GitHub raw pinned to the
   paired app's version tag as the skew/distribution fallback. (Owner asked
   how the compiled site could serve files — it can't and doesn't need to;
   the server runs from the checkout. GitHub covers skew + future .mcpb.)
2. **Scope** — `src/nodes/` + `src/engine/`, not nodes-only (compute()
   almost always delegates to engine helpers) and not whole-repo.
3. **Search** — yes, `search_source` ships in v1; it's what makes dives
   agentic.
4. **Docs layer** (in-app docs as tools/resources, devguide concept
   resource) — not now; source tools only, revisit after real usage.
