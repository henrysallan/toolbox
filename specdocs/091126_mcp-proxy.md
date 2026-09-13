# Toolbox MCP: one bridge, many Claude lanes (spec, 2026-09-11)

`scripts/mcp-server.mjs` now runs as a **hub** or a **proxy**. The first
instance to bind the editor bridge port (38275) is the hub and owns the
editor socket and pairing exactly as before; every later instance proxies
its tool calls through the hub over a peer WebSocket on the same port,
and is promoted to hub if the hub's Claude quits.

## Problem

Every Claude lane that has `toolbox` registered spawns its own copy of the
server. Claude Desktop alone spawns two (its chat lane and its local agent
mode lane, within ~300 ms of each other); a Claude Code session in VS Code
or a terminal adds another. The bridge port is fixed on both sides
(`MCP_BRIDGE_URL` in src/lib/mcp-bridge, `TOOLBOX_MCP_PORT` on the server),
so only one copy could bind it, and the old server called `process.exit(1)`
on `EADDRINUSE`. Desktop then reported "Server disconnected" for the losing
lane and its tools were gone, while the editor tab happily paired with the
winner — which was often the *other* lane. Of 208 server boots in
`~/Library/Logs/Claude/mcp-server-toolbox.log` on 2026-09-11, 177 ended
this way. The failure is invisible from both ends: the editor says
"Claude Connected", the chat has no toolbox tools.

## Decision (design Q&A, 2026-09-11)

Three options were weighed: (1) the losing instance proxies through the
winner; (2) each server picks a free port from a range and the editor
probes the range and pairs with all of them; (3) the loser stays alive but
answers every tool call with "another instance owns the bridge". (1) was
chosen: it is the only one that makes every lane work without touching the
editor's single-socket design. Its costs, accepted knowingly:

- **Pairing consent widens.** Confirming one code authorizes every Claude
  lane on the machine, including ones started later. The origin gate is
  the real defense (a browser page can never reach the peer path); the
  code echo only ever closed the "any pair frame pairs you" foot-gun, and a
  local process was already out of scope.
- **The hub's lifetime is everyone's.** When the hub's Claude quits, all
  proxies lose their upstream and must re-race; the editor re-pairs with
  the promoted server (fresh boot ⇒ fresh code ⇒ the confirm dialog comes
  back, exactly as a server restart did before).
- **Several agents can drive one editor** with no locking. Fine for a
  person using one chat at a time; noted, not solved.
- **Identity in the menu tooltip** would otherwise be the hub's alone —
  so the hub tells the editor which peers ride the bridge (below).

## Design

Roles and lifecycle (`race()` in mcp-server.mjs):

1. Connect the MCP stdio transport first (so the host's initialize never
   waits on the port), then race.
2. `startHub()` binds `127.0.0.1:PORT`. Success ⇒ `mode = "hub"`; log the
   pairing code as before.
3. `EADDRINUSE` ⇒ `probeHub()`: a plain `GET /toolbox-mcp` on the port.
   - `200 {role:"hub"}` ⇒ `attachToHub()`: open `ws://127.0.0.1:PORT/peer`
     (no Origin header — the `ws` client never sends one unless asked),
     send `peer_hello`, `mode = "proxy"`.
   - connection refused ⇒ the holder is mid-shutdown or mid-startup: back
     off (250 ms → 2 s) and race again.
   - anything else (e.g. the `426 Upgrade Required` an older server's
     WebSocketServer answers) ⇒ **exit 1**. An older hub treats every
     connection as an editor tab and would evict the real one, so a peer
     socket is never opened against it. This is the pre-change behavior
     and only bites during the rollout, until every running server is the
     new script.
4. Never bound or attached within 10 s of boot ⇒ exit 1 (the host sees a
   real failure, as before). Once attached, retry forever — the host owns
   the process's lifetime through stdin.
5. Hub socket closes ⇒ `mode = "starting"`, pending calls fail with a
   retry hint, race again. The first proxy to bind is promoted (logs
   "promoted to hub"); the rest re-attach to it.

Hub side:

- `verifyClient` routes on `req.url`. `/peer` admits only handshakes with
  **no** Origin header (browsers always send one); every other path keeps
  the loopback-only editor gate.
- `handlePeer()` answers `{type:"call", id, cmd, args, timeoutMs}` by
  running the same `callEditor()` the hub's own tools use, so pairing
  state, timeouts and error text are identical whichever lane asked.
  `editor_status` frames (connected / paired / appVersion / hub identity)
  go to every peer on connect and on every editor transition — a proxy's
  source tools use it for the checkout-vs-running-version skew check.
- The hub's `hello` and `client_info` frames carry `client.peers`, the
  identities of every attached proxy; it re-sends `client_info` whenever
  a peer joins, identifies itself, or leaves. `useMcpBridge` already
  refreshes status on `client_info`; MenuBar's tooltip appends an
  "also serving …" line per peer.

Proxy side:

- `callEditor()` becomes `callViaHub()`: same id/pending map, budget =
  the tool's timeout + 2 s so the hub's more specific error (no editor,
  unpaired, editor silent) wins the race against the backstop.
- `oninitialized` re-sends `peer_hello` so the hub gets app/appVersion
  once the proxy's own MCP handshake lands.
- Source tools (`get_node_source` / `read_source` / `search_source`) stay
  local — they never touch the bridge.

Unchanged: the editor still holds exactly one socket and never learns
which lane a given command came from; the pairing dialog, trusted-code
persistence, and the `replaced` last-tab-wins rule are as before.

## Milestones

1. Server hub/proxy + `check-mcp` coverage (peer-path origin rejection,
   second server proxies tool calls, image + error marshalling across the
   hop, source tools local, hub death ⇒ promotion ⇒ editor re-pairs) —
   **done 2026-09-11**.
2. Editor tooltip lists peers (`BridgeClientInfo.peers`) — **done**.
3. Follow-ups, not in scope here: Desktop-aware pairing copy (the dialog
   still says "printed in your terminal", which Desktop users can't see —
   the hello frame's `client.host` already says when it's Desktop);
   trust-by-client-identity so the dialog stops returning on every hub
   restart; surfacing the origin rejection in the editor instead of an
   endless "Connecting…" (the hosted site is not a loopback origin).

## Verification

`npm run check:mcp` (not part of `npm run check` — it spawns real servers
on port 38299). After changing the server, **restart Claude Desktop**: the
copies it already has running are the old script, and a new proxy refuses
to attach to them (step 3 above) exactly as the old server refused to
share the port.
