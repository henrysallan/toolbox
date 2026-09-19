// Toolbox MCP server (spec 070926_claude-mcp-bridge.md, milestone 1).
//
// Speaks MCP over stdio to the Claude app (Claude Code / Claude Desktop) and
// hosts a localhost WebSocket that the running Toolbox editor tab connects to
// via src/lib/mcp-bridge. Tools marshal to the tab; the tab executes against
// EffectsApp state and answers. This process is stateless glue — no engine,
// no graph.
//
// Register:   claude mcp add toolbox -- node scripts/mcp-server.mjs
// or run:     npm run mcp   (prints the pairing code, waits for the editor)
//
// Every Claude lane that registers toolbox spawns its own copy of this
// process, but there is one editor bridge port: the first copy to bind it is
// the hub, later copies proxy through it. See "Editor bridge — hub or proxy".
//
// IMPORTANT: stdout is the MCP protocol channel — all logging goes to stderr.

import { execSync } from "node:child_process";
import { createServer as createHttpServer, get as httpGet } from "node:http";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { createSourceReader } from "./mcp-source.mjs";
import { BRIDGED_TOOLS, marshalError, marshalResult } from "./toolbox-tool-defs.mjs";

const VERSION = "0.1.0";
const PORT = Number(process.env.TOOLBOX_MCP_PORT ?? 38275);
const CMD_TIMEOUT_MS = 10_000;

// 4-digit pairing code, minted once per server boot. The editor shows the
// code it received in a confirm dialog; the user checks it against this
// stderr line. Same boot ⇒ same code, so a page reload re-pairs silently.
const PAIRING_CODE = String(Math.floor(1000 + Math.random() * 9000));

const log = (...args) => console.error("[toolbox-mcp]", ...args);

// ---------------------------------------------------------------------------
// Client identity — WHO is on the other end of the stdio channel. With many
// Claude instances running, only one server wins the port, and the editor
// has no way to tell which; this snapshot is forwarded over the bridge so
// the Toolbox menu can show it. Best-effort throughout — nulls are fine.
// ---------------------------------------------------------------------------

// The process that spawned us is the Claude client itself (stdio MCP servers
// are direct children). Its command line distinguishes the Desktop app, the
// VS Code extension, and a terminal CLI.
function classifyHost() {
  let cmd;
  try {
    cmd = execSync(`ps -o command= -p ${process.ppid}`, { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
  if (!cmd) return null;
  if (/\.vscode[/-]|vscode/i.test(cmd)) return "VS Code";
  if (/\.cursor[/-]|cursor/i.test(cmd)) return "Cursor";
  if (/Claude(?: Desktop)?\.app|Claude Helper/i.test(cmd)) return "Claude Desktop";
  return cmd.split(/\s+/)[0]?.split("/").pop() || null;
}
const HOST = classifyHost();
const SERVER_CWD = process.cwd().replace(os.homedir(), "~");

// `app`/`appVersion` come from the MCP initialize handshake and are null
// until it completes (the oninitialized push below covers that race).
function clientIdentity() {
  const info = server.server.getClientVersion();
  return {
    app: info?.name ?? null,
    appVersion: info?.version ?? null,
    host: HOST,
    pid: process.ppid,
    cwd: SERVER_CWD,
  };
}

// ---------------------------------------------------------------------------
// Editor bridge — hub or proxy (spec 091126_mcp-proxy.md).
//
// Every Claude lane that has toolbox registered spawns its own copy of this
// script (Claude Desktop alone spawns two — chat and local agent mode; a
// Claude Code session adds a third), but there is ONE editor bridge port.
// The first instance to bind it is the HUB: it owns the editor socket and
// pairing exactly as before. Every later instance is a PROXY: it keeps its
// own stdio channel open (so its Claude lane stays connected instead of
// reporting "Server disconnected") and forwards tool calls to the hub over a
// peer WebSocket on the same port. When the hub's Claude quits, the port
// frees and the proxies race again — one is promoted to hub and the editor
// tab re-pairs with it.
//
// Peer frames (proxy ⇄ hub, path /peer):
//   proxy → hub: {type:"peer_hello", client, serverVersion}
//                {type:"call", id, cmd, args, timeoutMs}
//   hub → proxy: {type:"editor_status", connected, paired, appVersion, hub}
//                {type:"result", id, ok, result?, error?}
// ---------------------------------------------------------------------------
const PEER_PATH = "/peer";
const HUB_PROBE_PATH = "/toolbox-mcp";
const RACE_DEADLINE_MS = 10_000;
const PROXY_TIMEOUT_GRACE_MS = 2_000;

let mode = "starting"; // "starting" | "hub" | "proxy"
let editor = null; // hub: { ws, paired, appVersion }
const peers = new Set(); // hub: { ws, client }
let hub = null; // proxy: { ws, client, editorStatus }
let everAttached = false; // bound the port or reached a hub at least once
let nextId = 1;
const pending = new Map(); // id → { resolve, reject, timer }

const NOT_CONNECTED =
  "No Toolbox editor is connected. Open Toolbox and enable the bridge via " +
  `Toolbox menu → "Connect to Claude…" (pairing code ${PAIRING_CODE}).`;

function failPending(reason) {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
  pending.clear();
}

function settlePending(msg) {
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  clearTimeout(p.timer);
  if (msg.ok) p.resolve(msg.result);
  else p.reject(new Error(msg.error ?? "editor returned an error"));
}

function send(ws, frame) {
  try {
    ws.send(frame);
  } catch {
    // dead socket — its close handler does the cleanup
  }
}

function describeClient(c) {
  if (!c) return "unidentified client";
  const parts = [c.app ?? "unknown client"];
  if (c.host) parts.push(`via ${c.host}`);
  if (c.pid) parts.push(`pid ${c.pid}`);
  return parts.join(" ");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// CSWSH defense. WebSocket handshakes are exempt from the same-origin policy,
// so a plain loopback bind isn't enough: any web page the user visits can
// `new WebSocket("ws://127.0.0.1:38275")` and drive the editor. But browsers
// ALWAYS attach an `Origin` header to the handshake and a page can't forge it,
// so we reject any handshake whose Origin is a non-loopback web page. Absent
// Origin = a non-browser client (the CLI, the e2e harness, a peer) — no
// drive-by vector — and is allowed; a local malicious *process* is out of
// scope here (it already has code execution) and is the reason pairing also
// validates the echoed code below.
function isAllowedOrigin(origin) {
  if (!origin) return true; // non-browser client (no Origin header)
  try {
    const host = new URL(origin).hostname;
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "[::1]" ||
      host === "::1"
    );
  } catch {
    return false;
  }
}

// --- hub: the editor socket + pairing ---------------------------------------

function editorStatus() {
  return {
    connected: !!editor,
    paired: !!editor?.paired,
    appVersion: editor?.paired ? editor.appVersion : null,
  };
}

// What the editor sees as "who is on the other end": the hub's own client
// plus every proxy riding the bridge (the Toolbox menu tooltip lists them).
function hubIdentity() {
  return { ...clientIdentity(), peers: [...peers].map((p) => p.client).filter(Boolean) };
}

function pushClientInfo() {
  if (!editor) return;
  send(editor.ws, JSON.stringify({ type: "client_info", client: hubIdentity() }));
}

function broadcastEditorStatus() {
  if (peers.size === 0) return;
  const frame = JSON.stringify({ type: "editor_status", ...editorStatus(), hub: clientIdentity() });
  for (const p of peers) send(p.ws, frame);
}

function handleEditor(ws) {
  if (editor) {
    // Last-connected wins — tell the old tab it's been replaced.
    send(editor.ws, JSON.stringify({ type: "replaced" }));
    try {
      editor.ws.close();
    } catch {
      // already dead
    }
    failPending("Editor connection was replaced by a new tab.");
  }
  editor = { ws, paired: false, appVersion: null };
  log("editor connected, awaiting pairing confirmation…");
  send(
    ws,
    JSON.stringify({
      type: "hello",
      code: PAIRING_CODE,
      serverVersion: VERSION,
      client: hubIdentity(),
    })
  );
  broadcastEditorStatus();

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (editor?.ws !== ws) return; // a replaced tab's late frames
    if (msg.type === "pair" && msg.ok) {
      // The client must echo the exact pairing code it received in `hello`.
      // On its own this is weak (the code is in the frame we sent), but it
      // closes the "any {pair:ok} frame pairs you" foot-gun and pairs with the
      // Origin gate above: a browser drive-by can't complete the handshake at
      // all, so it never sees the code to echo.
      if (String(msg.code) !== PAIRING_CODE) {
        log("rejected pair frame with a missing/incorrect code");
        return;
      }
      editor.paired = true;
      editor.appVersion = msg.appVersion ?? "unknown";
      log(`paired with editor (app v${editor.appVersion})`);
      broadcastEditorStatus();
      return;
    }
    if (msg.type === "result") settlePending(msg);
  });

  ws.on("close", () => {
    if (editor?.ws === ws) {
      editor = null;
      log("editor disconnected");
      failPending("Editor disconnected mid-command.");
      broadcastEditorStatus();
    }
  });
  ws.on("error", () => {
    // close handler does the cleanup
  });
}

// A proxy's peer socket. Forwarded calls go through the same callEditor as
// the hub's own tools, so pairing, timeouts and error text are identical
// whichever Claude lane asked.
function handlePeer(ws) {
  const peer = { ws, client: null };
  peers.add(peer);
  log("peer connected — another toolbox-mcp instance is proxying through this one");
  send(ws, JSON.stringify({ type: "editor_status", ...editorStatus(), hub: clientIdentity() }));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === "peer_hello") {
      peer.client = msg.client ?? null;
      log(`peer identified: ${describeClient(peer.client)}`);
      pushClientInfo();
      return;
    }
    if (msg.type === "call" && typeof msg.id === "number" && typeof msg.cmd === "string") {
      callEditor(msg.cmd, msg.args ?? {}, msg.timeoutMs).then(
        (result) =>
          send(ws, JSON.stringify({ type: "result", id: msg.id, ok: true, result: result ?? null })),
        (e) =>
          send(
            ws,
            JSON.stringify({
              type: "result",
              id: msg.id,
              ok: false,
              error: e instanceof Error ? e.message : String(e),
            })
          )
      );
    }
  });

  ws.on("close", () => {
    peers.delete(peer);
    log(`peer disconnected: ${describeClient(peer.client)}`);
    pushClientInfo();
  });
  ws.on("error", () => {
    // close handler does the cleanup
  });
}

// Bind the bridge port. Resolves once listening; rejects (EADDRINUSE) when
// another instance already owns it.
function startHub() {
  return new Promise((resolve, reject) => {
    // We own the http server so a plain GET on HUB_PROBE_PATH identifies a
    // peer-capable hub. A proxy checks this BEFORE opening a peer socket: an
    // older toolbox-mcp without peer support treats every connection as an
    // editor tab and would evict the real one.
    const http = createHttpServer((req, res) => {
      if (req.url === HUB_PROBE_PATH) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ toolboxMcp: VERSION, role: "hub", client: clientIdentity() }));
        return;
      }
      res.writeHead(426, { "content-type": "text/plain" });
      res.end("Upgrade Required");
    });
    const wss = new WebSocketServer({
      server: http,
      verifyClient: ({ origin, req }) => {
        if (req.url === PEER_PATH) {
          // Peers are other toolbox-mcp processes — never a browser, and a
          // browser always sends Origin, so any Origin here is a drive-by page.
          if (origin) log(`rejected peer handshake carrying a browser Origin: ${origin}`);
          return !origin;
        }
        if (isAllowedOrigin(origin)) return true;
        log(`rejected WebSocket handshake from disallowed Origin: ${origin}`);
        return false;
      },
    });
    wss.on("connection", (ws, req) => {
      if (req.url === PEER_PATH) handlePeer(ws);
      else handleEditor(ws);
    });
    // `ws` forwards the http server's errors onto the WebSocketServer, so the
    // bind failure (EADDRINUSE) arrives here — an unhandled 'error' on wss
    // would take the whole process down.
    let listening = false;
    wss.on("error", (e) => {
      if (listening) {
        log(`hub server error: ${e.message}`);
        return;
      }
      try {
        wss.close();
      } catch {
        // never opened
      }
      reject(e);
    });
    http.listen(PORT, "127.0.0.1", () => {
      listening = true;
      resolve();
    });
  });
}

// --- proxy: ride another instance's bridge -----------------------------------

// What holds the port? {kind:"hub", info} for a peer-capable toolbox-mcp hub;
// "refused" when nothing answers (the holder is mid-shutdown or mid-startup);
// "foreign" for anything else — typically an older toolbox-mcp without peer
// support, which we must never open a peer socket against (see startHub).
function probeHub() {
  return new Promise((resolve) => {
    const req = httpGet(
      { host: "127.0.0.1", port: PORT, path: HUB_PROBE_PATH, timeout: 1000 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              const info = JSON.parse(body);
              if (info?.role === "hub") return resolve({ kind: "hub", info });
            } catch {
              // not ours
            }
          }
          resolve({ kind: "foreign", status: res.statusCode });
        });
      }
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve({ kind: "refused" }));
  });
}

// Open the peer socket to the hub. Resolves true once attached (the socket's
// close handler then owns re-racing), false if the handshake never opened.
function attachToHub(info) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${PEER_PATH}`);
    let opened = false;
    ws.on("open", () => {
      opened = true;
      hub = { ws, client: info?.client ?? null, editorStatus: null };
      mode = "proxy";
      everAttached = true;
      send(ws, JSON.stringify({ type: "peer_hello", client: clientIdentity(), serverVersion: VERSION }));
      log(`proxying through the hub (${describeClient(hub.client)}) on ws://127.0.0.1:${PORT}`);
      resolve(true);
    });
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === "editor_status") {
        if (hub?.ws === ws) {
          hub.editorStatus = msg;
          hub.client = msg.hub ?? hub.client;
        }
        return;
      }
      if (msg.type === "result") {
        settlePending(msg);
        return;
      }
      if (msg.type === "hello") {
        // Only an older hub answers a peer socket with an editor hello — and
        // it has just evicted the real editor tab to do so. Nothing to be
        // gained by staying attached.
        log("the port holder answered the peer socket as if we were an editor tab — older toolbox-mcp still running? Exiting.");
        process.exit(1);
      }
    });
    ws.on("close", () => {
      if (hub?.ws === ws) {
        hub = null;
        mode = "starting";
        failPending("The toolbox-mcp hub went away mid-command — retry in a moment.");
        log("hub connection closed — racing for the port again");
        void race();
      }
      if (!opened) resolve(false);
    });
    ws.on("error", () => {
      // close handler does the cleanup
    });
  });
}

// Become the hub if the port is free, otherwise attach to whoever holds it.
// Runs at boot and again whenever a hub we were riding goes away. Gives up
// (exit 1, so the Claude host reports a real failure) only when nothing
// usable answers within RACE_DEADLINE_MS of boot or when the port belongs to
// something that isn't a peer-capable hub.
async function race() {
  const startedAt = Date.now();
  let attempt = 0;
  for (;;) {
    try {
      await startHub();
      const promoted = everAttached;
      mode = "hub";
      everAttached = true;
      log(`${promoted ? "promoted to hub" : "editor bridge: hub"} on ws://127.0.0.1:${PORT}`);
      log(`pairing code: ${PAIRING_CODE}`);
      return;
    } catch (e) {
      if (e?.code !== "EADDRINUSE") {
        log(`editor bridge failed to start: ${e?.message ?? e}`);
        process.exit(1);
      }
    }
    const probe = await probeHub();
    if (probe.kind === "hub" && (await attachToHub(probe.info))) return;
    if (probe.kind === "foreign") {
      log(
        `port ${PORT} is held by something that isn't a peer-capable toolbox-mcp hub ` +
          `(HTTP ${probe.status}) — an older toolbox-mcp still running? Exiting.`
      );
      process.exit(1);
    }
    if (!everAttached && Date.now() - startedAt > RACE_DEADLINE_MS) {
      log(`could not bind port ${PORT} or reach a hub within ${RACE_DEADLINE_MS / 1000}s — exiting`);
      process.exit(1);
    }
    attempt += 1;
    await sleep(Math.min(250 * 2 ** attempt, 2000));
  }
}

// --- the one call every tool makes -------------------------------------------

function callEditor(cmd, args = {}, timeoutMs = CMD_TIMEOUT_MS) {
  if (mode === "proxy") return callViaHub(cmd, args, timeoutMs);
  if (mode !== "hub")
    return Promise.reject(
      new Error(
        "The editor bridge is still starting up (or re-attaching after its hub went away) — retry in a moment."
      )
    );
  if (!editor) return Promise.reject(new Error(NOT_CONNECTED));
  if (!editor.paired)
    return Promise.reject(
      new Error(
        "The editor is connected but pairing isn't confirmed yet — confirm " +
          `code ${PAIRING_CODE} in the Toolbox dialog.`
      )
    );
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Editor did not answer "${cmd}" within ${timeoutMs / 1000}s.`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    editor.ws.send(JSON.stringify({ type: "cmd", id, cmd, args }));
  });
}

// The hub runs its own timeout first (and its error text names the real
// cause — no editor, unpaired, editor silent); ours is only a backstop for a
// hub that vanishes without closing the socket.
function callViaHub(cmd, args, timeoutMs) {
  const sock = hub?.ws;
  if (!sock || sock.readyState !== WebSocket.OPEN)
    return Promise.reject(new Error("The toolbox-mcp hub is not reachable right now — retry in a moment."));
  const id = nextId++;
  const budget = timeoutMs + PROXY_TIMEOUT_GRACE_MS;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`The toolbox-mcp hub did not answer "${cmd}" within ${budget / 1000}s.`));
    }, budget);
    pending.set(id, { resolve, reject, timer });
    sock.send(JSON.stringify({ type: "call", id, cmd, args, timeoutMs }));
  });
}

// ---------------------------------------------------------------------------
// MCP tools. Results marshal to text content; errors become isError results
// so the model can read and react (repair loop).
// ---------------------------------------------------------------------------
const server = new McpServer(
  { name: "toolbox", version: VERSION },
  {
    instructions:
      "Toolbox editor tool set. Load this whole bundle with ONE tool_search " +
      'for "toolbox" — do not search screenshot, set_param, and search_source ' +
      "separately. Tools: get_status, get_catalog, get_graph, get_recent_edits, " +
      "get_node_data, screenshot, screenshot_strip, insert_recipe, edit_group, " +
      "set_param, get_keyframes, set_keyframes, validate_expression, " +
      "get_shader_errors, transport, tidy, plan_glsl_translation, " +
      "get_glsl_docs, compare_renders, get_node_source, read_source, search_source, " +
      "set_perf_capture, get_perf, get_perf_frame.",
  }
);

// The initialize handshake (where clientInfo arrives) can complete after an
// editor tab has already received its hello — push the completed identity so
// the tab never sticks on nulls.
server.server.oninitialized = () => {
  const info = server.server.getClientVersion();
  log(`MCP client: ${info?.name ?? "?"} v${info?.version ?? "?"}${HOST ? ` (${HOST})` : ""}`);
  // A proxy re-announces itself to the hub (its first peer_hello may have
  // gone out before the handshake filled in app/appVersion); the hub pushes
  // the completed identity straight to the editor tab.
  if (mode === "proxy" && hub)
    send(hub.ws, JSON.stringify({ type: "peer_hello", client: clientIdentity(), serverVersion: VERSION }));
  else pushClientInfo();
};

// Source-reading tools (spec 071226_mcp-node-source-tools.md). These read the
// repo checkout directly — no bridge round-trip, so they work unpaired. The
// paired editor's version (when it differs from this checkout) triggers the
// GitHub-tag fallback so Claude reads the code the user is actually running.
const source = createSourceReader();
const pairedAppVersion = () =>
  mode === "proxy"
    ? hub?.editorStatus?.paired
      ? (hub.editorStatus.appVersion ?? null)
      : null
    : editor?.paired
      ? editor.appVersion
      : null;
function sourceResult(r) {
  return r.error ? toolError(new Error(r.error)) : textResult(r.text);
}

function textResult(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  return { content: [{ type: "text", text }] };
}

function toolError(e) {
  return {
    content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
    isError: true,
  };
}

function toolboxDesc(text) {
  return text.startsWith("[toolbox]") ? text : `[toolbox] ${text}`;
}

for (const def of BRIDGED_TOOLS) {
  server.registerTool(
    def.name,
    { description: toolboxDesc(def.description), inputSchema: def.inputSchema },
    async (args) => {
      try {
        const result = await callEditor(def.name, args ?? {}, def.timeoutMs);
        return marshalResult(def, result);
      } catch (e) {
        return marshalError(e);
      }
    }
  );
}

server.registerTool(
  "get_node_source",
  {
    description: toolboxDesc(
      "Read the actual source of a node from the public repo — use this to " +
      "understand HOW a node works beyond its catalog summary, or to explain " +
      "to the user exactly how to build a tree. Pass a `type` from " +
      "get_catalog; returns the node's definition file (line-numbered) plus " +
      "the `@/engine/*` helpers it imports (the real math usually lives " +
      "there — follow up with read_source). Prefer get_catalog for a quick " +
      "interface check; reach here when you need behavior, not just sockets. " +
      "Cite file:line when explaining behavior to the user."
    ),
    inputSchema: {
      type: z.string().describe("A node type string from get_catalog (e.g. \"spline-merge\")."),
    },
  },
  async ({ type }) => {
    try {
      return sourceResult(await source.getNodeSource({ type, appVersion: pairedAppVersion() }));
    } catch (e) {
      return toolError(e);
    }
  }
);

server.registerTool(
  "read_source",
  {
    description: toolboxDesc(
      "Read a file from the engine or node source (scope: src/nodes/ + " +
      "src/engine/ — where node behavior and the shared math live, e.g. " +
      "coerce.ts, types.ts, evaluator.ts, spline-boolean.ts). Line-numbered; " +
      "pass `start`/`end` (1-based, inclusive) to read a slice of a big file. " +
      "Use get_node_source first to find the right file for a node."
    ),
    inputSchema: {
      path: z.string().describe("Repo-relative path under src/nodes/ or src/engine/."),
      start: z.number().optional().describe("First line (1-based, inclusive)."),
      end: z.number().optional().describe("Last line (1-based, inclusive)."),
    },
  },
  async ({ path, start, end }) => {
    try {
      return sourceResult(await source.readSource({ path, start, end, appVersion: pairedAppVersion() }));
    } catch (e) {
      return toolError(e);
    }
  }
);

server.registerTool(
  "search_source",
  {
    description: toolboxDesc(
      "Regex-search the engine + node source (src/nodes/ + src/engine/) and " +
      "get `path:line: text` matches — the way to FIND where something is " +
      "defined or used before reading it (a symbol, a socket type, a coercion, " +
      "a shader key). `pattern` is a JavaScript regex source; optional `glob` " +
      "filters paths (e.g. \"*.ts\", \"src/engine/*\"). Capped at 200 matches."
    ),
    inputSchema: {
      pattern: z.string().describe("JavaScript regex source (case-sensitive)."),
      glob: z.string().optional().describe("Path filter, e.g. \"*.ts\" or \"src/engine/*\"."),
    },
  },
  async ({ pattern, glob }) => {
    try {
      return sourceResult(await source.searchSource({ pattern, glob, appVersion: pairedAppVersion() }));
    } catch (e) {
      return toolError(e);
    }
  }
);

// --- performance (spec 080726_perf-profiler.md M2) --------------------------

server.registerTool(
  "set_perf_capture",
  {
    description: toolboxDesc(
      "Arm or disarm the evaluator performance trace. Capture is OFF by " +
      "default and costs nothing until armed. Level 1 records per-node time " +
      "and WHY each node recomputed; level 2 adds data volume (point/subpath " +
      "counts), texture create/delete churn, and fingerprint size. Arming " +
      "always clears the previous trace, so the sequence is: " +
      "set_perf_capture -> drive the workload (transport play, a set_param " +
      "edit, a scrub) -> get_perf. The editor only evaluates on playback, a " +
      "param change, or a graph change — an idle editor records no frames."
    ),
    inputSchema: {
      level: z
        .number()
        .optional()
        .describe("0 = off, 1 = timings + reasons, 2 = + volume/churn (default)."),
      frames: z
        .number()
        .optional()
        .describe("Ring size in frames (default 600, ~10s at 60fps)."),
    },
  },
  async ({ level, frames }) => {
    try {
      return textResult(await callEditor("set_perf_capture", { level, frames }));
    } catch (e) {
      return toolError(e);
    }
  }
);

server.registerTool(
  "get_perf",
  {
    description: toolboxDesc(
      "Aggregated performance summary of the captured frames. Returns frame " +
      "stats (mean/p50/p95/max eval ms, effective fps), a phase breakdown per " +
      "frame (flatten, topo, fingerprint, compute, post, blit, plus an " +
      "`unattributed` residual), texture churn, and the top nodes by cost — " +
      "each with p95, recompute RATE and dominant REASON (`hit`, `params`, " +
      "`input`, `unstable`, `anim`, `extras`, `cold`), plus ns-per-point where " +
      "the node emits points. Also returns `poisonRoots`: uncacheable nodes " +
      "(stable:false and friends) ranked by how much DOWNSTREAM recompute " +
      "they force — usually the most actionable number in the payload, since " +
      "a node whose reason is `input` is being dragged by an ancestor rather " +
      "than doing anything wrong itself. Pass groupBy:\"type\" to collapse " +
      "instances and see which KIND of node is expensive."
    ),
    inputSchema: {
      frames: z
        .number()
        .optional()
        .describe("Only summarize the most recent N frames (default: all)."),
      top: z.number().optional().describe("How many nodes to return (default 20)."),
      groupBy: z
        .enum(["node", "type"])
        .optional()
        .describe('"type" collapses instances by node type.'),
    },
  },
  async ({ frames, top, groupBy }) => {
    try {
      return textResult(await callEditor("get_perf", { frames, top, groupBy }));
    } catch (e) {
      return toolError(e);
    }
  }
);

server.registerTool(
  "get_perf_frame",
  {
    description: toolboxDesc(
      "One frame's complete node list by sequence number — use it to " +
      "interrogate a spike found in get_perf's aggregate (e.g. why p95 is far " +
      "above p50). Samples tagged depth > 0 come from inside an Iterate " +
      "interior and their time is ALREADY counted in the enclosing shell's " +
      "depth-0 sample, so sum only depth-0 entries for a frame total."
    ),
    inputSchema: {
      seq: z.number().describe("Frame sequence number, from a get_perf frame."),
    },
  },
  async ({ seq }) => {
    try {
      return textResult(await callEditor("get_perf_frame", { seq }));
    } catch (e) {
      return toolError(e);
    }
  }
);

// ---------------------------------------------------------------------------
await server.connect(new StdioServerTransport());
log(`ready — MCP on stdio; racing for the editor bridge port ${PORT}`);
void race();

// The MCP client (Claude app / test harness) owns this process's lifetime:
// when the stdio channel closes — clean shutdown OR client crash — exit so
// the WebSocket server releases the port instead of living on as an orphan.
server.server.onclose = () => {
  log("stdio channel closed — shutting down");
  process.exit(0);
};
process.stdin.on("end", () => {
  log("stdin ended — shutting down");
  process.exit(0);
});
