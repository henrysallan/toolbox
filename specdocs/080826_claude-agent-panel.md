# Claude agent panel — the generate loop, driven from inside the editor

Spec — 2026-08-08. Status: **M1 in progress** (decisions at the bottom, one
open). Host, session isolation, renderer client, token handshake and Electron
supervision are built and checked; UI and packaging remain — see Milestones.

## Why

The MCP bridge (archive/070926_claude-mcp-bridge.md) works, and works better
than expected: Claude Desktop drives the editor, reads the graph, screenshots
the render, and iterates. It is also **cheap**, because inference is billed to
the user's Claude subscription rather than our API key — unlike the in-app
recipe features ([generate-recipe](../src/app/api/generate-recipe/route.ts),
[edit-recipe](../src/app/api/edit-recipe/route.ts)), which burn credits per
prompt and are one-shot: prompt in, graph out, no feedback, no iteration.

The gap is not capability. It is **where the driver lives**. Today the loop
runs in another application, so:

- The user context-switches to a chat window to art-direct their own canvas.
- The session has no idea which window, composition, or selection it is acting
  on — the bridge is one-editor-last-connected-wins.
- Nothing in the app can offer the loop as a feature. It is a power-user setup
  step (`claude mcp add toolbox …`), not a thing in the product.
- The choreography that makes the loop good has to live in a skill that Claude
  Desktop may or may not trigger.

Moving the driver in-window fixes all four, and buys one thing that is not
available from Desktop at all: **we own the system prompt.** The generate loop
stops being a skill that must be discovered and becomes the session's standing
instructions, always applied.

The end state this is aimed at: describe a design, and the agent builds the
graph, looks at the render, critiques it against the ask, adjusts, and repeats
until it matches — then later does the same for keyframes and motion.

### What this is not

Not a replacement for the Desktop path. That stays, unchanged, for
whole-repo work and for anyone who prefers it (Decision 1). The bridge server
keeps its stdio face; this adds a second driver, not a migration.

Not a new inference path. There is no way to spend a Pro/Max subscription from
our own code — subscription entitlement is consumed by **Claude Code**, which
owns its login. The panel drives the user's local Claude Code install via the
Agent SDK; auth is inherited, never implemented. Consequence, accepted: users
need Claude Code installed and logged in, the same category of dependency as
ffmpeg for native export.

## What exists today

| Piece | Where | Verdict |
|---|---|---|
| 18 MCP tools | [scripts/mcp-server.mjs](../scripts/mcp-server.mjs) | **Sufficient.** See below — the tool surface is not the gap |
| Editor-side handlers | [mcp-handlers.ts](../src/components/effects/mcp-handlers.ts) | Reuse verbatim; the agent host calls the same command names |
| Bridge client + reconnect | [src/lib/mcp-bridge/index.ts](../src/lib/mcp-bridge/index.ts) | Reuse; extend frames with a session id |
| Connection ownership | [useMcpBridge.ts](../src/components/effects/useMcpBridge.ts) | Reuse the shape; per-window session state is new |
| Pairing dialog | [McpPairingDialog.tsx](../src/components/effects/McpPairingDialog.tsx) | Reuse for the Desktop path; **not sufficient** to gate agent spawn |
| Tiled panel system | `PANEL_KINDS` in [layout/model.ts](../src/components/effects/layout/model.ts#L20) | Add an `"assistant"` kind — one line + label |
| Node-side spawning | [electron/server.js](../electron/server.js) | Precedent: main already spawns and supervises a Node child |
| One-shot AI recipes | [recipe-prompt.ts](../src/lib/ai/recipe-prompt.ts), [anthropic-key.ts](../src/lib/ai/anthropic-key.ts) | Untouched. Different billing, different UX, keeps working |

**The tool surface is already coarse-to-fine and already covers animation
state.** Worth writing down explicitly so we do not add tools we have:

| Need | Tool | Note |
|---|---|---|
| Build structure in one shot | `insert_recipe` | The coarse move. Cheaper than N × `add_node` round-trips |
| Refine what the render revealed | `set_param`, `edit_group` | The fine move |
| Visual feedback | `screenshot`, `screenshot_strip` | Deterministic explicit render, not a raced grab |
| Read/write motion numerically | `get_keyframes`, `set_keyframes` | Structured state beats pixels for anything numeric |
| Orientation | `get_status`, `get_catalog`, `get_graph` | |
| Time | `transport` | |
| Expressions | `validate_expression` | Gates syntax, not intent |
| Engine source | `get_node_source`, `read_source`, `search_source` | |
| Cost | `set_perf_capture`, `get_perf`, `get_perf_frame` | 080726_perf-profiler.md |

Gaps, in priority order — note that none of them are tools:

1. **No driver we control.** The loop only runs if a human types into another
   app. Everything else here follows from this.
2. **No session identity.** `mcp-server.mjs` holds `editor = null` — one
   connection, last-connected wins. Two windows fight.
3. **No choreography in-repo.** `.claude/skills/` was specced in the bridge doc
   and never shipped. The judgment that makes the loop good — tweak params
   before rebuilding, sample 2–3 frames before judging motion, stop after N —
   exists only as prose in that spec.
4. **No stopping criterion.** Nothing tells the agent what "done" is, so an
   unattended loop either quits early or grinds.
5. **No rewind.** Mutations land on the live document with an undo snapshot
   each (bridge Decision 1). Thirty iterations of autonomous work is not
   recoverable by Cmd-Z × 400.
6. **Pairing is too weak for this.** A 4-digit code is ~10k guesses over a
   local socket. It gates "reorder my nodes"; it must not gate "spawn an agent
   with bash".

## Topology

The bridge inverts. Today the agent is upstream of the server; here the editor
is, and the host holds both ends.

```
Toolbox renderer  (assistant panel)
   │  ws 127.0.0.1 — chat frames + tool frames, all carrying sessionId
   ▼
toolbox-agent host (node)  ──Agent SDK──▶  claude binary   [subscription auth]
   │                                            │
   └──── in-process MCP tools  ◀────────────────┘
         (marshal back over the same socket to the originating window)
```

The agent's tools are registered **in-process in the host**, not behind a
second stdio server. The host is already holding the window's socket, so a
tool call is one hop to the same handlers the Desktop path uses. This deletes
a process and a serialization boundary from the loop's inner cost.

Launching, one implementation, two packagings:

- **Electron** — main spawns the host at boot and supervises it, exactly as it
  does the standalone Next server. Invisible to the user.
- **Web / dev** — `npm run agent` alongside `npm run dev`, mirroring
  `npm run mcp`.

The renderer connects to a localhost WebSocket either way, so there is no
preload/IPC path to write and no branching in app code. Electron is a
packaging decision, not an architectural one.

### Agent SDK — verified, not assumed

`@anthropic-ai/claude-agent-sdk` **0.3.229**, smoke-tested 2026-08-13 against
`claude` 2.1.153 at `/usr/local/bin/claude`. All four M1 preconditions pass:
subscription auth with no `ANTHROPIC_API_KEY` in env; an in-process MCP tool
registered, offered, called, and its result consumed; built-in tools fully
absent; permission callback invoked.

**The published docs page disagrees with the shipped types. Trust the types.**
`code.claude.com/docs/en/agent-sdk/typescript` documents `canUseTool` as
`(request: {toolName, toolUse, requestId}) => {allowed: boolean}`. The shipped
`sdk.d.ts` has:

```ts
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal, toolUseID, requestId, suggestions?, title?,
             displayName?, description?, blockedPath?, decisionReason?, ... }
) => Promise<PermissionResult | null>;

type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[] }
  | { behavior: 'deny';  message: string; interrupt?: boolean };
```

Writing the documented shape fails at runtime with a permission-system error
that the model reports back as a tool failure — it does **not** surface as an
exception. Pin the SDK version and read `sdk.d.ts` on upgrade.

Three findings that shape the design:

- **`tools: []` + `strictMcpConfig: true` removes built-ins entirely.** Bash /
  Read / Write are not offered, so they are never attempted — a stronger
  guarantee than denying them in `canUseTool`, and how the security decision
  below is actually enforced. `canUseTool` stays as a belt-and-braces deny.
- **`options.displayName` / `title` / `description` are pre-rendered prompt
  text** ("Get Status"). The Allow/Deny card uses them rather than
  reconstructing a sentence from `toolName` + input.
- **Pin the model.** The CLI defaulted to `claude-fable-5` (per `modelUsage`
  in the result message). The panel passes `model` explicitly so behaviour
  does not drift with the user's CLI config.

Also available and worth using: `startup()` pre-warms the subprocess (a cold
one-tool round trip measured 6.6s wall, warm is materially better);
`resumeSessionAt` + `resumeDropsTurn` give **truncating resume**, which is
exactly what the checkpoint rail needs to keep transcript and document
consistent on rewind; `maxTurns` enforces the iteration cap at the SDK level.

## Session model

One agent session per **window** (Decision 2), bound at panel open.

- Every bridge frame gains `sessionId`. The host keeps
  `sessionId → { agentSession, socket, checkpoints, cwd }`.
- `mcp-handlers.ts` is untouched — routing is entirely host-side.
- The Desktop path keeps its existing single-editor slot; it is a distinct
  connection kind on the same server, not a session.
- Session working directory is the **project**, not the repo. This loop is for
  making work, not for editing the engine. `read_source` / `search_source`
  stay available as read-only orientation, which is what they already are.
- Pop-out windows (080226_panel-popout-windows.md) each own a session if they
  host an assistant panel. Falls out of the model; no special case.

## The loop

Three pieces, all currently missing, all cheap individually. Together they are
the difference between a chat panel and something you can leave running.

### Standing instructions

The generate choreography moves from an unshipped skill into the session's
system prompt, composed by the host at session start: the loop itself
(`get_catalog` → draft → `insert_recipe` → fix returned issues → `screenshot`
→ critique → `set_param` → re-screenshot), plus the judgment — prefer param
tweaks over rebuilds, sample representative frames before judging motion,
report and stop rather than grinding.

Composed per session, not a static file, so it can carry live context: the
current composition, selection, canvas size, and which nodes the user was last
touching. That is context the Desktop path structurally cannot have.

### Stopping criterion

The user's brief is turned into a short explicit rubric at session start —
concrete, gradeable claims, not vibes. The agent grades each render against it
and stops on pass, on a hard iteration cap, or on no-progress (two consecutive
iterations with no rubric movement). Both the rubric and the per-iteration
grade are surfaced in the panel, so the user can see *why* it kept going.

Iteration cap default: **8**, enforced via `maxTurns`. Small enough to bound a
runaway, large enough for the loop to be worth having; revisit with real usage.

**The real budget is the rate limit, not dollars.** The stream emits
`rate_limit_event` with `{status, resetsAt, rateLimitType, overageStatus,
isUsingOverage}`, and the terminal `result` message carries `total_cost_usd`
— but on a subscription that figure is nominal, not a charge. An unattended
loop that burns the user's Pro window is the actual failure mode, so:
surface `rate_limit_event` in the panel, stop the loop cleanly on a limited
status rather than letting turns fail, and show `resetsAt`. `maxBudgetUsd`
is the wrong guard here and is not used.

### Permission and checkpoints

Bridge Decision 1 (auto-apply + undo snapshot + toast) is right for a human
typing one instruction at a time, and wrong for unattended iteration in both
directions — too noisy to confirm each call, too lossy to rely on undo.

Split it:

- **Authorize at the session, not the call.** Starting a session grants graph
  mutation (`insert_recipe`, `set_param`, `edit_group`, `set_keyframes`,
  `transport`) for its duration. No per-call prompt. Anything outside that set
  — filesystem writes, bash, network — raises an inline Allow/Deny card in the
  panel and blocks the turn.
- **Checkpoint per iteration** (Decision 3, open): snapshot the graph at each
  loop boundary, not each tool call. Per-call is the obvious alternative and I
  think it is wrong: it is high-frequency, most calls are individually
  meaningless, and the unit a user actually wants to rewind to is "before it
  tried the version with the noise displacement" — an iteration. Per-call
  granularity is still reachable through normal undo.
- The panel shows checkpoints as a rail; clicking one restores the graph and
  truncates the transcript to match, so the agent's context and the document
  stay consistent. Rewinding mid-run interrupts the session first.

## UI

Two entry points, **one implementation**. The transcript renderer and the
composer are shared components; the two entry points are shells that host
them. Do not fork the rendering.

Both derive their look from [AiRecipePanel.tsx](../src/components/effects/AiRecipePanel.tsx),
which already establishes the visual language for "talking to Claude" in this
app: pinned uppercase 10px header with the violet `Sparkle`, scrollable middle,
composer pinned bottom in a `--tb-n-2` rounded rect with a `--tb-n-7` border,
a model pill, and a violet submit pill. Reuse the tokens and the components
(`Sparkle`, `Pulse`, `smallBtn`) rather than restyling — the agent panel should
read as the same feature family as AI Recipe, not a second dialect.
`Cmd/Ctrl+Enter` submits, matching the existing composer.

### 1. Docked panel

New `"assistant"` kind in `PANEL_KINDS` + `PANEL_LABELS`
([layout/model.ts](../src/components/effects/layout/model.ts#L20)). Layout is
`AiRecipePanel`'s three-band structure verbatim — header / scrolling transcript
/ pinned composer — filling its tile.

Compat caveat, already documented at
[layout/model.ts:15](../src/components/effects/layout/model.ts#L15): an older
build reading a tree containing an unknown kind rejects the **whole tree** and
falls back to the default preset. Layout only, project content untouched — but
it means this lands in a release users are expected to take, not a side branch.

### 2. Floating overlay

Opened from the pie menu ([PieMenu.tsx](../src/components/effects/PieMenu.tsx),
`shift+space`) or the Edit menu ([MenuBar.tsx:481](../src/components/effects/MenuBar.tsx#L481)).
For the quick "ask for a thing without rearranging my workspace" case.

- **Position** — horizontally centred, anchored to the bottom of the viewport
  with enough bottom padding that it reads as floating *on top of* the
  timeline rather than docked into it. Fixed width (~560px), not full-bleed.
- **Composer** — the shared composer block, unchanged. This is the resting
  state: before anything is sent, the overlay is just the prompt box.
- **Response surface** — a rounded rect that appears directly above the
  composer on first send. It opens at a base height, then **expands to ~1.5×
  that height once messages arrive**, and scrolls internally beyond that. It
  never grows to fill the screen; the overlay stays a heads-up surface.
- **Dismiss** — `Esc` or click-outside. Dismissing does **not** end the
  session (see below).

### Session continuity across shells

A window has one session (Decision 2), and both shells are views onto it.
Dismissing the overlay leaves the session running; reopening it — or opening
the docked panel — shows the same transcript, mid-flight tool calls included.
Users will start something in the overlay and then want the full panel to
watch it work, and that must not mean starting over.

### Rendering the stream

**Structured events, not a terminal.** No PTY, no ANSI, no xterm.js. Message
shapes below are as observed from the SDK, not as documented — note in
particular that tool *results* arrive as `user` messages, and that `system`
carries a `subtype` (largely hook noise that should be filtered, not shown).

| Stream event | Source | Renders as |
|---|---|---|
| Assistant prose | `assistant` → `message.content[].text` | Prose |
| `insert_recipe` call | `assistant` → `content[].tool_use` | Recipe chip: name + node count; click selects the inserted nodes |
| `set_param` / `edit_group` call | same | Param chip styled like the inspector row it edits |
| `screenshot` result | `user` → `tool_use_result` | Inline thumbnail; click to compare against the previous iteration |
| Permission request | `canUseTool` callback | Inline Allow/Deny card, labelled from `options.displayName` / `description` |
| Rate limit | `rate_limit_event` | Inline warning + `resetsAt`; halts the loop |
| Iteration boundary | host-synthesised | Divider + rubric grade + checkpoint marker |
| Cost / turns / duration | `result` → `total_cost_usd`, `num_turns`, `usage` | Quiet footer line |
| Hook chatter | `system` (`subtype: hook_started`, …) | Not rendered |

`includePartialMessages` enables token-level streaming for the prose case;
worth it in the panel, and the existing `Pulse` component already covers the
pre-first-token state.

A raw-JSON toggle stays available for debugging. It is a debug affordance,
not the default view.

## Security

The existing model was sized for graph mutation. Agent spawn is a different
blast radius and needs its own gate.

- **Frame classes.** Tool frames (existing verbs, existing trust boundary) keep
  today's rules. **Agent-control frames** — create session, send prompt,
  approve permission — require a separate, high-entropy token minted per host
  boot and delivered to the renderer out of band (Electron: over IPC at window
  creation; web: printed by `npm run agent`, pasted once, stored per session
  like the existing trusted code).
- The 4-digit pairing code stays for the Desktop path only. It is not extended
  to cover agent control.
- Origin checking as-is — the CSWSH reasoning in
  [mcp-server.mjs](../scripts/mcp-server.mjs) is sound and unchanged.
- All graph mutation continues through `SETTABLE_PARAM_TYPES` / `vetParamValue`
  and the recipe trust boundary. The agent gets no privileged path.
- Non-graph tools (bash, file write) are **not enabled** in M1–M3. The session
  is scoped to editor verbs. Enabling them is a later decision with its own
  spec, and the Allow/Deny card exists from M2 so the mechanism is proven
  before the capability arrives.

## Animation — deferred, and honestly hard

Claude sees images. Motion has to arrive as frames, and judging easing,
timing, or whether a move *feels* right from a 3-frame strip is thin. This is
the part of the vision most likely to disappoint, so it gets its own milestone
and its own feedback design rather than being assumed to fall out of the
graph loop.

Two things already point the way:

- **Sample smarter, not more.** `screenshot_strip` currently samples evenly.
  Frames at keyframe boundaries and easing extrema carry far more signal per
  token than uniform spacing.
- **Prefer numbers over pixels for numeric work.** `get_keyframes` already
  returns the curve — control points, interpolation, timing. For "make the
  ease-out snappier", reading the curve back beats looking at a render of it.

Neither is a new tool. Both are choreography, which is why M4 is mostly prompt
and sampling work.

## Milestones

**M1 — host + sessions.** Ship gate: two windows, two independent sessions,
neither stealing the other's tools; a prompt round-trips and mutates the right
graph.

Done:

- [scripts/toolbox-tool-defs.mjs](../scripts/toolbox-tool-defs.mjs) — the 12
  bridged editor verbs as shared data (name, description, zod schema, timeout,
  `mutates`, `resultKind`) plus result/error marshalling. Written so
  `mcp-server.mjs` can fold onto it; it has uncommitted work in flight, so its
  inline copies were left alone. **Until that lands, edits must be mirrored.**
- [scripts/agent-host.mjs](../scripts/agent-host.mjs) — WebSocket host, one
  session per socket, in-process MCP tools marshalling back down the
  originating socket, streaming-input query per session, interrupt,
  session-scoped permission, 32-byte control token, handshake file.
- [src/lib/agent-bridge/index.ts](../src/lib/agent-bridge/index.ts) — renderer
  client. Shares the `cmd`/`result` frame shape with `mcp-bridge`, so the same
  `BridgeHandlers` table serves both drivers.
- [src/app/api/agent-handshake/route.ts](../src/app/api/agent-handshake/route.ts)
  — token delivery, same-origin gated, with a pid liveness check.
- [electron/agent.js](../electron/agent.js) + main wiring — `utilityProcess`
  supervision, env allowlist forwarding `PATH`/`HOME` (needed to find the
  binary and read `~/.claude`) and deliberately **not** `ANTHROPIC_API_KEY`.
- [scripts/check-agent-host.mts](../scripts/check-agent-host.mts) —
  `npm run check:agent-host`. 12 checks, all passing: bad token rejected, two
  windows authorize independently, each window's tool calls reach only itself,
  each sees only its own state, and only `mcp__toolbox__*` tools are ever
  called. Makes real inference calls, so it is **not** part of `npm run check`.

- [src/components/effects/useAgentSession.ts](../src/components/effects/useAgentSession.ts)
  — React owner. Connects **lazily**, only while the panel is open: each
  session is a real `claude` subprocess, so an always-on socket per window
  would be a subprocess doing nothing. Reads the same `mcpHandlersRef` the MCP
  bridge uses — one handler table, two drivers.
- [src/components/effects/AgentPanel.tsx](../src/components/effects/AgentPanel.tsx)
  — M1 view. AiRecipePanel's three-band shell and tokens, with the event list
  rendered close to raw (prose, tool name + arg gist, result summaries, rate
  limits, permission card). M2 replaces the list body, not the shell.
- `EffectsApp` wiring via the existing `paramView` seam (+ `"agent"` pseudo-type
  in `onAddNode`, matching how `ai-recipe` already works), and an
  "Assistant…" pseudo-entry in `NodeSearchPopup` at both root and group scope.
  `paramView: "agent"` is excluded from session persistence — the host-side
  session is gone by the time a reload would restore it.

Verified end to end: handshake file written 0600 and removed on exit; the Next
route serves the token to a same-origin request and refuses a cross-origin one;
typecheck clean; `lint:ratchet` 120 errors vs 120 baseline (no new).

Remaining:

- **Packaging.** `scripts/` is not in electron-builder's `files` allowlist and
  `node_modules` is excluded, and `@anthropic-ai/claude-agent-sdk` ships a
  per-platform binary (`…-darwin-x64`) which the Windows build must also
  resolve. `electron/agent.js` therefore starts the host in unpackaged runs
  only; packaged builds skip it and the panel reports the host unavailable.
  Needs its own pass before the desktop app can ship this.

**M2 — native UI.** Ship gate: the loop is usable without reading JSON; a
prompt started in the overlay is still live when the docked panel is opened;
a non-editor tool request visibly blocks on the card.

Done:

- [agent-ui.tsx](../src/components/effects/agent-ui.tsx) — shared primitives
  (Sparkle/Pulse, the style vocabulary, `agentReadiness`). One place, so the
  two shells can't drift.
- [AgentTranscript.tsx](../src/components/effects/AgentTranscript.tsx) — typed
  rendering per the table: recipe chips carrying name + node count, param
  chips reading `node.param = value`, inline screenshot thumbnails, rate-limit
  warnings, the Allow/Deny card, hook chatter filtered out. Builds a
  `tool_use id → name` map so results are labelled by what asked for them.
- [AgentComposer.tsx](../src/components/effects/AgentComposer.tsx) — the prompt
  box, shared verbatim. Stops keydown propagation so editor shortcuts don't
  fire while typing.
- [AgentPanel.tsx](../src/components/effects/AgentPanel.tsx) — docked shell,
  now just a header around the two shared components.
- [AgentOverlay.tsx](../src/components/effects/AgentOverlay.tsx) — floating
  shell. Centred, `bottom: 96` so it reads as sitting over the timeline, 560px.
  Composer only at rest; response surface appears on first send at 180px and
  expands to 270px (1.5×) once a reply arrives, scrolling beyond. Esc and
  click-outside dismiss; an "open panel" link hands the live session to the
  docked shell.
- **Session continuity.** `useAgentSession` connects on first visible and
  tears down *only* on unmount — there is deliberately no teardown when
  `visible` goes false, which is what lets the overlay be dismissed mid-run.
  Owned in `EffectsApp` above both shells.
- Edit-menu entry (`MenuBar` → `onOpenAssistant`) alongside the existing
  add-menu pseudo-entry.

- **`"assistant"` panel kind** in `PANEL_KINDS` / `PANEL_LABELS`, with a
  sparkle icon in `PanelKindMenu` and a render branch in `EffectsApp`. A tiled
  assistant leaf counts as showing the session, so docking connects it exactly
  as opening the overlay does. Tiled hosting drops the close button (the kind
  menu owns that) and renders the kind chip inline, matching `PerfPanel`.
  Compat caveat from `layout/model.ts` applies: an older build rejects a whole
  layout tree containing an unknown kind.

**M3 — the loop.** Ship gate: "make me a drifting particle field that feels
underwater" runs unattended to a stop and is rewindable to any iteration.

Done:

- **Live editor context.** The `prompt` frame carries a `context` preamble the
  host prepends to the user message — project, canvas size, fps, node count,
  selected node. Saves an orientation round-trip and supplies things the model
  cannot infer, which is context the Claude Desktop path structurally cannot
  have. Built from refs at send time.
- **Rubric + stopping criterion** (system prompt): restate the request as a
  short checklist of checkable criteria before building, grade each render
  against it, and stop on all-pass, on the iteration cap, or on two
  consecutive iterations with no improvement.
- **Iteration cap** — `maxTurns` (default 8), stated in the prompt so the
  model paces itself rather than being cut off mid-thought.
- **Checkpoint rail.** `useAgentSession` wraps the handler table and snapshots
  the graph lazily — just before the first *mutating* command of an iteration,
  so read-only exploration costs nothing. An iteration ends at a "look"
  (`screenshot` / `screenshot_strip`), which is the real rhythm of
  build → look → adjust. Driven from the COMMAND path, not the event stream:
  the snapshot must be ordered before the mutation, and only the command path
  is. Reuses `getGraphSnapshot` / `applyGraphSnapshot`, the same primitives
  undo rides on.
- **Rewind.** Checkpoints render inline in the transcript with a "revert"
  action. Restoring puts the graph back, interrupts any run in flight (letting
  it keep mutating a rewound graph is how you get an incoherent document), and
  truncates the transcript so what the user sees and what the document holds
  agree.

Remaining:

- **Verification.** The loop's behaviour under a real brief is unproven —
  `check:agent-host` covers transport, isolation, tool scoping and catalog
  recovery, not whether the rubric actually converges. That needs real runs.
- The **no-progress stop** is prompt-level, not enforced in code. If models
  grind through it anyway, it needs to become a host-side check on rubric
  grades across iterations.

**M4 — animation.** Keyframe-aware strip sampling; curve-read-back
choreography; whatever the M3 loop turns out to need for motion. Scoped after
M3 ships, because M3 will change what we think this needs.

Devguide gets an "Assistant panel / agent host" section at M2, and the
security model recorded at the same time.

## Decisions (owner, 2026-08-08)

1. **Coexists with Claude Desktop.** Not a migration. The stdio server keeps
   working; this is a second driver.
2. **One session per window.** Bound at panel open; pop-outs included.
3. **Checkpoint granularity — per iteration** (implemented 2026-08-13 under
   the standing recommendation; owner did not object when M3 was greenlit).
   Reasoning under "Permission and checkpoints": a tool call is rarely the
   unit anyone wants back, whereas "before it tried the version with the noise
   displacement" is. Per-call rewind remains available through normal undo.
   Revisit if real runs show iterations are too coarse to be useful.
4. **Subscription auth via the local Claude Code binary.** Users install and
   log into Claude Code themselves. No credential handling in our code, and no
   attempt at a subscription-backed endpoint of our own.
5. **Working directory is the project, not the repo.** Source tools stay
   read-only orientation.
6. **Tool surface is closed for M1–M3.** The 18 existing verbs are the surface.
   New tools require evidence from a real loop failure, not anticipation.
7. **The in-app recipe node is untouched.** Different billing, different UX,
   still useful for a quick one-shot. Convergence — the node becoming the
   agent scoped to one subtree — is a later question, not this spec's.
8. **Two entry points, one implementation.** Docked panel and floating
   overlay are shells around shared transcript/composer components, styled
   from `AiRecipePanel`. Dismissing the overlay does not end the session.
9. **SDK pinned at 0.3.229**, verified by smoke test. The published docs
   contradict the shipped `sdk.d.ts` on `canUseTool`; the types win. Re-verify
   on any upgrade — the failure mode is silent (surfaces as a tool error the
   model narrates, not an exception).
10. **Built-ins removed except a scoped `Read`** (revised 2026-08-13 after the
    first real session). Originally `tools: []`, on the theory that the panel
    should offer nothing but editor verbs. That was wrong, for two reasons
    found by running it:

    - **`tools: []` did not hold.** A real session was still offered `Read`
      and `Bash`, because omitting `settingSources` loads
      `~/.claude/settings.json` et al — "matches CLI defaults" — and the
      user's own config re-added them. Fixed with `settingSources: []` (SDK
      isolation mode) plus an explicit `disallowedTools`. A shipped feature
      must not vary with each developer's terminal config.
    - **Large tool results never arrive inline.** Claude Code truncates them
      and spills the full text to `~/.claude/…/tool-results/`, expecting the
      agent to `Read` it back. `get_catalog` is ~174k chars, so it ALWAYS
      spills. Under Claude Desktop / Claude Code this is invisible because
      `Read` exists. With `Read` disabled the spill became a dead end: the
      model reported "no file access", then probed for node types by
      inserting throwaway recipes — which is precisely the garbage a real
      session produced.

    So `Read` is enabled and gated in `canUseTool` to paths under
    `~/.claude` that contain a `tool-results` segment. It is not a filesystem
    grant and cannot be widened by the user clicking Allow; an arbitrary path
    is refused outright. `MAX_MCP_OUTPUT_TOKENS` is NOT the lever — raising it
    changed nothing.

    Covered by three checks: no shell/write tool is reachable, an arbitrary
    path is refused, and a 111k-char catalog is recovered in full.
11. **Build into the current composition, not into a new group** (owner,
    2026-08-13). `insert_recipe` always wraps its output in a node-group,
    which is wrong for "make me an X" — the first real session produced an
    unwanted wrapper. The system prompt now directs building into the target
    layer's interior via `edit_group` add_node/add_edge, reserving
    `insert_recipe` for genuinely reusable groups. Choreography only; the
    shared MCP handler is unchanged. If this proves insufficient, the deeper
    fix is an `asGroup: false` option on `insert_recipe`, which would change
    the tool surface Claude Desktop also sees and so needs its own decision.
11. **Drive the user's installed CLI, don't bundle one** (owner, 2026-08-13).
    The SDK ships a 303MB per-platform binary and uses it unless
    `pathToClaudeCodeExecutable` is set. We set it.

    | | Bundle it | Use the user's (chosen) |
    |---|---|---|
    | App size | 433MB → ~736MB | +4.3MB |
    | Cross-build | npm installs only the HOST platform's optional package, so `desktop:build:win` from macOS has no Windows binary | unaffected |
    | Version drift | none — matched pair | **real risk**, mitigated by reporting the resolved path + version to the panel |
    | Install prerequisite | **not removed** | not removed |

    The decisive point is the last row: credentials live in the OS keychain,
    not in the package, so bundling still leaves a user who never logged into
    Claude with nothing. It buys version pinning at ~300MB and a cross-build
    problem, and does not buy away the prerequisite. Verified the SDK loads
    and runs with its platform package absent, so the exclusion is real.
    Revisit only if shipping to people who have never used Claude Code — and
    note that would still require solving an interactive login flow.
12. **Model is `claude-opus-5`** (owner, 2026-08-13), overridable via
    `TOOLBOX_AGENT_MODEL`. Verified accepted and actually used.
13. **This is a LOCAL-ONLY feature** (2026-08-13). The agent host must run on
    the user's machine — it spawns their `claude` binary and holds a socket to
    their browser — so there are exactly two supported environments:

    | Environment | How the host starts |
    |---|---|
    | Desktop app (Electron) | `electron/agent.js` starts it automatically |
    | Local dev (`localhost`) | the developer runs `npm run agent` |
    | **Hosted web** | **not supported** |

    A hosted visitor cannot run it and cannot be made to. There is no repo to
    run `npm` in; `/api/agent-handshake` reads the handshake file
    **server-side**, which on a deployment is the server's disk rather than
    theirs; and an `https` page cannot reliably open `ws://127.0.0.1` anyway.
    A local companion binary would solve only the first of those.

    So `agentEnvironment()` classifies native / local / hosted, hosted never
    probes for a host, and each environment gets its own explanation —
    "`npm run agent`" is a developer instruction and was previously shown to
    everyone, which is meaningless to a web visitor. Hosted is pointed at the
    desktop app instead.

    The alternative that would work on hosted web is running inference
    server-side on an API key — which is the billing model this whole spec
    exists to avoid (see §Why). Not a gap to close; a boundary to state.
14. **Hosted web is gated OUT of the entry points** (owner, 2026-08-13), not
    merely shown a message. Withheld there: the Edit-menu "Assistant…" item,
    the add-menu pseudo-entry, and `assistant` in the panel-kind menu.
    **Unaffected and available to everyone: AI Recipe and the MCP bridge** —
    different features, different billing, no local host required.

    Two things this deliberately does NOT do:

    - **`PANEL_KINDS` still contains `assistant`.** That list is also what the
      layout validators check, and `model.ts` documents that an unknown kind
      makes a build reject the ENTIRE tree and fall back to the default
      preset. Dropping it would mean a layout saved in the desktop app blows
      up when the same project is opened in a browser. The menu is filtered;
      the kind stays legal. (The current kind is also never filtered out of
      its own menu, so a panel already set to `assistant` can still be
      changed away from.)
    - **The panel itself is not gated.** If a desktop-made layout with an
      assistant leaf is opened on the web it renders and explains that it
      needs the desktop app, rather than silently vanishing.

    Gating is read during render rather than from state, which is safe
    because every gated surface only reaches the DOM after a click — long
    after hydration — so the SSR pass never disagrees with the client. The
    panel is left ungated for the same reason in reverse: it CAN render at
    first paint, so gating it would risk a hydration mismatch.
