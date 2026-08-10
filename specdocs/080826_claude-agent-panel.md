# Claude agent panel — the generate loop, driven from inside the editor

Spec — 2026-08-08. Status: **design approved** (decisions at the bottom, one
open); implementation not started.

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

**Agent SDK API caveat.** The shape is settled — spawn the binary, consume a
typed message stream, register tools in-process, supply a permission callback,
resume and interrupt by session. Exact signatures must come from
`code.claude.com/docs/en/agent-sdk` at implementation time; do not write
against recalled names.

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

Iteration cap default: **8**. Small enough to bound a runaway, large enough
for the loop to be worth having; revisit with real usage.

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

## Panel

New `"assistant"` kind in `PANEL_KINDS` + `PANEL_LABELS`. Note the compat
caveat already documented at [layout/model.ts:15](../src/components/effects/layout/model.ts#L15):
an older build reading a tree containing an unknown kind rejects the whole
tree and falls back to the default preset. Layout only, project content
untouched — acceptable, but it means the panel should land in a release users
are expected to take, not a side branch.

**Render the structured event stream, not a terminal.** No PTY, no ANSI, no
xterm.js. The SDK emits typed messages and each maps to something native:

| Event | Renders as |
|---|---|
| Assistant text | Prose |
| `insert_recipe` call | A recipe chip — name + node count, click to select the inserted nodes |
| `set_param` / `edit_group` call | A param chip styled like the inspector row it edits |
| `screenshot` result | Inline thumbnail, click to compare against the previous iteration |
| Permission request | Inline Allow/Deny card |
| Iteration boundary | Divider + rubric grade + checkpoint marker |
| Usage / cost | Quiet footer line |

A raw-JSON toggle stays available for debugging the stream. It is a debug
affordance, not the default view.

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

**M1 — host + sessions.** `scripts/agent-host.mjs`; Agent SDK wired to the
local `claude` binary; `sessionId` on bridge frames; host-side session map;
in-process tool registration marshalling to existing handlers; Electron main
spawns and supervises. Panel renders the raw event stream, unstyled. Ship
gate: two windows, two independent sessions, neither stealing the other's
tools; a prompt round-trips and mutates the right graph.

**M2 — native panel.** `"assistant"` panel kind; typed event rendering per the
table above; session-scoped authorization; Allow/Deny card; agent-control
token. Ship gate: the loop is usable without reading JSON, and a
non-editor tool request visibly blocks on the card.

**M3 — the loop.** Composed system prompt with live editor context; rubric
generation from the brief; per-iteration grading; iteration cap and
no-progress stop; per-iteration checkpoints + rewind rail. Ship gate: "make me
a drifting particle field that feels underwater" runs unattended to a stop and
is rewindable to any iteration.

**M4 — animation.** Keyframe-aware strip sampling; curve-read-back
choreography; whatever the M3 loop turns out to need for motion. Scoped after
M3 ships, because M3 will change what we think this needs.

Devguide gets an "Assistant panel / agent host" section at M2, and the
security model recorded at the same time.

## Decisions (owner, 2026-08-08)

1. **Coexists with Claude Desktop.** Not a migration. The stdio server keeps
   working; this is a second driver.
2. **One session per window.** Bound at panel open; pop-outs included.
3. **Checkpoint granularity — OPEN.** Recommendation: per iteration, reasoning
   under "Permission and checkpoints". Per tool call is the alternative.
   Needs owner sign-off before M3; does not block M1–M2.
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
