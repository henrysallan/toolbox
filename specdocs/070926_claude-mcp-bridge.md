# Claude MCP bridge — drive the editor from the Claude app

Spec — 2026-07-09. Status: **design approved** (decisions recorded at the
bottom); implementation not started.

## Why

The in-app AI Recipe flow works, but it's a fixed pipeline: prompt → one
Claude call through our `/api/generate-recipe` proxy → build/validate →
repair → insert. An MCP server flips the topology: **the Claude app (Claude
Desktop / Claude Code) becomes the agent**, and Toolbox exposes its verbs as
tools. That buys:

- **A real agentic loop.** Claude can look (screenshot), act (insert/edit),
  scrub (transport), look again, and iterate — visual validation instead of
  fire-and-forget. The repair loop stops being our hand-rolled 3-attempt cap
  and becomes Claude's own tool loop.
- **No proxy, no API key.** The user's Claude app subscription is the model.
  `/api/generate-recipe` + `edit-recipe` routes stay for the in-app panel but
  the MCP path doesn't touch them.
- **Composability.** Skills (markdown workflow packs for Claude Code /
  Desktop) can choreograph the tools: "generate → screenshot → critique →
  tweak params → re-screenshot", point-expression authoring (the
  070926_point-expression-prompt.md doc becomes a skill), perf triage, etc.
- Everything below the model layer is **already built and stays the trust
  boundary**: `buildNodeCatalog`, `buildRecipe`, `applyRecipeEdit`,
  `validateGraph`, `vetParamValue`, `validateParams`.

## Topology

The graph + engine live in a browser tab (web or the Electron renderer); an
MCP server is a separate process speaking stdio to the Claude app. Bridge the
gap with a localhost WebSocket — the pattern every editor MCP uses (Figma,
Blender, Godot):

```
Claude Desktop / Claude Code
        │ stdio (MCP)
   toolbox-mcp  (Node process, in-repo: scripts/mcp-server.mjs)
        │ WebSocket, 127.0.0.1:38275, JSON frames
   editor tab   (src/lib/mcp-bridge/ — WS client + command registry)
        │ registered handlers (refactored EffectsApp callbacks)
   EffectsApp state / engine
```

- The MCP server **hosts** the WS server; the page connects out. Works in
  `next dev`, the hosted app (Chrome allows loopback ws from secure
  contexts; Safari/Firefox caveat — desktop/dev unaffected), and Electron
  (renderer is plain Chromium). Zero editor-side ports.
- No editor connected ⇒ tools return a clear "open Toolbox and enable the
  Claude bridge" error instead of hanging.
- One editor tab at a time (last-connected wins, server tells the old tab).

## What exists to reuse (investigated)

- **Insert path**: `handleGenerateRecipe` (EffectsApp) = model call +
  commit block (pushGraph → scope resolution → `cloneSubgraph` → setNodes/
  setEdges → select/toast). Refactor: extract the commit block as
  `insertRecipeFragment(result, opts)`; both the in-app panel and the bridge
  call it. Same for `handleEditGroup` → `commitGroupEdit(groupId, edit)`.
- **Validation**: `generateRecipe`/`applyEditRecipe` minus the `post()` —
  i.e. `buildRecipe(rg)` + `validateGraph` directly; errors go back as the
  tool result and Claude self-repairs.
- **Catalog**: `buildCatalogDsl()` verbatim.
- **Screenshot**: `canvasRef.current.toBlob("image/png")` is proven
  (copyImageToClipboard); `exportImage` shows the `forcedTerminalRef` +
  `renderFrame` trick to snapshot a specific Output. Downscale to ≤1024px
  before returning (token cost).
- **Transport**: `playing`/`setPlaying`, `timeRef`/`fpsRef`,
  `renderFrame(time, fps, …)` — seek = set time + render once while paused.
- **Param edits**: route through the same onParamChange path the panel uses
  (undo snapshots + autokey + sim-zone mirroring for free), vetted by
  `vetParamValue`.

## Tool surface (v1)

Context (read-only, auto-approvable):
- `get_catalog()` — the node-catalog DSL (also exposed as an MCP resource so
  clients can cache it).
- `get_graph({ scope? })` — current graph at root or inside a group:
  `groupToSpec`-style JSON (nodes + settable params + edges + interface),
  plus selection and playhead. Root scope needs a sibling serializer
  (`graphToSpec`) generalizing `groupToSpec`.
- `get_status()` — project name, canvas size, fps, frame/loop range,
  playing?, selected node, current scope.

Vision:
- `screenshot({ nodeId?, frame?, maxSize? })` — PNG of the preview (or a
  specific Output via forced-terminal render; optional seek-then-snapshot
  while paused). Returns MCP image content. **v1 is single-frame only.**
  v2: `screenshot_strip({ start?, end?, every? })` — sample every N frames
  (5/10-ish) across a range and tile into ONE image. The cadence/count is
  deliberately a tool arg, not fixed: the SKILL decides contextually how
  many frames are representative for the motion being judged (a slow drift
  needs 3, a stagger burst needs 8) so context stays small.

Mutation (each pushes an undo snapshot; returns issues/warnings):
- `insert_recipe({ recipe })` — RecipeGraph JSON → buildRecipe → validate →
  insert (same wrap-into-layer semantics as the panel). Returns real node
  ids + the group id for follow-up edits.
- `edit_group({ groupId, ops })` — RecipeEdit ops → applyRecipeEdit →
  validate → commit. Channel-by-name wiring and expression channel
  auto-sync apply (recipe-builder).
- `set_param({ nodeId, param, value })` — single vetted param write through
  the panel path.
- `validate_expression({ source })` — Point Expression `validateParams`
  (compile + smoke-run) without touching the graph; lets Claude check code
  before inserting.

Transport:
- `transport({ action: "play"|"pause"|"seek", frame? })`, and `set_loop({
  start, end })` later.

Deliberately NOT tools (v1): arbitrary JS eval, file/save/load, export/render
(long-running; Render Queue integration is a v2 question), Supabase anything.

## Protocol & bridge module

- Frames: `{ id, cmd, args }` → `{ id, ok: true, result }` /
  `{ id, ok: false, error }`. Screenshots ride as base64 in `result`.
  Version handshake on connect (`{ hello, bridgeVersion, appVersion }`).
- Single-flight per command with a timeout (default 10s; screenshot 30s);
  the server queues.
- `src/lib/mcp-bridge/index.ts`: `connectBridge(url, handlers)` — reconnect
  with backoff, status events. EffectsApp owns a `useMcpBridge(handlers)`
  hook; handlers close over the refactored callbacks. UI: a menu toggle
  ("Connect to Claude") + status dot + a toast per mutating command
  (`"Claude: inserted recipe 'Orbit dots'"`) so agent actions are visible.
- Server: `scripts/mcp-server.mjs`, deps `@modelcontextprotocol/sdk` + `ws`
  (devDependencies). Registered in the Claude app via
  `claude mcp add toolbox -- node scripts/mcp-server.mjs` or Claude
  Desktop's config JSON. Stateless: tools marshal to the socket.

## Security

- Bind 127.0.0.1 only. Bridge is **opt-in per session** (menu toggle;
  optional "auto-connect in dev" pref).
- Pairing: server prints a 4-digit code on boot; the app's connect dialog
  shows the code it received — user confirms once per server boot. (Cheap,
  stops a random local page/process from driving the editor.)
- All mutations flow through the existing recipe trust boundary + undo
  history; nothing bypasses `SETTABLE_PARAM_TYPES`/`vetParamValue`.
- Expressions authored via MCP run as JS in the page — identical trust to
  the existing in-app AI feature and manual paste; `validate_expression`
  gates syntax/runtime errors, not intent.

## Skills layer (the choreography)

MCP provides verbs; skills encode workflows. Ship in-repo under
`.claude/skills/` (works for Claude Code here; copyable to `~/.claude` for
global use):

- `toolbox-generate` — the core loop: get_catalog → draft RecipeGraph →
  insert_recipe → fix returned issues → screenshot → critique against the
  user's ask → set_param / edit_group → re-screenshot. Encodes judgment:
  tweak params before rebuilding; seek to 2–3 representative frames before
  judging motion; stop after N iterations and report.
- `toolbox-point-expression` — wraps 070926_point-expression-prompt.md and
  adds the tool steps (validate_expression → edit_group set_param →
  screenshot at two phases).
- Later: `toolbox-audit` (describe a graph back), `toolbox-perf`.

claude.ai (web/mobile) needs a **remote** MCP server — out of scope v1;
the path there is packaging the local server as a Desktop Extension
(.mcpb) or tunneling with auth. Claude Desktop + Claude Code cover the
studio use case now.

## Milestones

1. **Skeleton** — mcp-server.mjs (stdio MCP + WS host + pairing code),
   bridge module + menu toggle + status, tools: `get_status`,
   `get_catalog`. Verify from Claude Code: `claude mcp add`, ask "what
   nodes exist?".
   ✅ **Shipped 2026-07-10**: `scripts/mcp-server.mjs` (stderr-only logging
   — stdout is the MCP channel), `src/lib/mcp-bridge/index.ts` (plain WS
   client, reconnect/backoff, replaced-tab handling),
   `useMcpBridge.ts` (session persistence: enabled flag + trusted pairing
   code survive reload; new server boot re-prompts), `McpPairingDialog.tsx`,
   Toolbox-menu toggle in MenuBar, handlers in EffectsApp. `npm run mcp`
   runs the server; `npm run check:mcp` is a headless e2e (real MCP client
   ⇄ server ⇄ real bridge module: not-connected error → pairing gate →
   paired round-trips → disconnect error).
2. **Eyes** — `get_graph`, `screenshot` (incl. downscale + forced-terminal
   variant + paused seek). Verify: "what am I looking at?" describes the
   canvas.
   ✅ **Shipped 2026-07-10**: `graphToSpec` (recipe-edit.ts) generalizes
   `groupToSpec` to any scope incl. root (GroupSpecNode gained a display
   `name`); screenshot renders explicitly (never captures a half-frame),
   downsizes to ≤1024px default, restores the paused playhead after a
   seek/forced-terminal peek, and returns MCP image content.
3. **Hands** — refactor `insertRecipeFragment`/`commitGroupEdit` out of the
   panel handlers (behavior-neutral for the in-app flow), tools:
   `insert_recipe`, `edit_group`, `set_param`, `validate_expression`.
   Verify: generate → iterate → undo works from the app side.
   ✅ **Shipped 2026-07-10**: `commitRecipeFragment` extracted from
   handleGenerateRecipe (shared by panel + bridge); edit_group extracts the
   fragment, runs `applyRecipeEdit` + `validateGraph` synchronously (no
   staleness window, unlike the async panel flow) and commits in place;
   set_param vets via `vetParamValue` then routes through `onParamChange`
   (undo/autokey/sim-zone mirroring), warning when the param is keyframed;
   all handlers live in `components/effects/mcp-handlers.ts`
   (`buildMcpHandlers(deps)`, deps rebuilt per render, read via ref).
   HARD_BUILD_CODES / HARD_OP_CODES are exported from the generate/edit
   clients so the bridge validates with the identical split.
   **edit_group targets layers too** (2026-07-10): the handler accepts
   node-group OR layer ids — a layer's interior patches identically, and
   the layer shell's own params (blendMode etc.) are settable since LAYER
   isn't in the edit path's STRUCTURAL set. applyRecipeEdit gained an
   explicit "can't remove the scope being edited" guard (for groups the
   STRUCTURAL check already covered it; a layer shell needed it — removing
   it would orphan the interior). `aiAuthored` is only stamped on
   node-groups, so layers keep their normal chrome.
4. **Motion** — `transport`, seek-aware screenshots. Verify: "make it
   slower" loop with before/after screenshots.
   ✅ **Shipped 2026-07-10**: play/pause/seek (seek = setTime; the paused
   evaluator re-renders on state change).

4b. **Animation + motion vision** (added 2026-07-10, owner-requested):
   - `get_keyframes({nodeId, param?})` — a track's keys as {frame, value,
     easing}, or (no param) the whole-node overview: every keyed track +
     which params are keyframable (isKeyframable ∩ SETTABLE).
   - `set_keyframes({nodeId, param, keys, animated?})` — REPLACE-track
     semantics (deterministic for the model). Frames→ticks via
     DEFAULT_TICKS_PER_FRAME; values vetted per-key with `vetParamValue`;
     easing validated against EASING_PRESET_ORDER (customBezier rejected —
     hand-authored only; step-only types forced to hold); default easing
     easeInOutQuad. Empty keys clears the track; `animated:false` keeps
     keys but disables. Routes through EffectsApp's `onAnimationChange`,
     so undo coalescing + linked-pair keyframe mirroring apply.
   - `screenshot_strip({frames? | start/end/every, nodeId?, maxSize?})` —
     2–12 frames rendered and tiled into ONE near-square grid (cells
     labelled `f<frame>`, whole grid ≤ maxSize, default 1400), playhead
     restored after. The cadence is a tool arg on purpose — the skill
     picks what's representative.
5. **Skills + docs** — the two SKILL.md files, README section, devguide
   note, devlist entry.

## Decisions (owner, 2026-07-09)

1. **Mutation gating** — auto-apply with undo snapshot + in-app toast. No
   Accept/Reject step.
2. **Pairing UX** — 4-digit confirm code, printed by the server and shown
   in the app's connect dialog. (Electron auto-spawn stays a possible later
   convenience, not v1.)
3. **`set_param` scope** — any node in the project, not just AI-authored
   groups.
4. **Screenshots** — single frame in v1. Plan for a later `screenshot_strip`
   sampling every ~5/10 frames, with the SKILL contextually choosing the
   frame count so representative motion fits without blowing up the context
   window.
5. **Export/render tools** — out of scope, period.
6. **Skills** — live in the repo (`.claude/skills/`). Publishing (npm
   package / Desktop Extension for other users) is a non-goal for now;
   revisit only if the bridge ever ships to end users.
