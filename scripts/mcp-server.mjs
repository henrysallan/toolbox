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
// IMPORTANT: stdout is the MCP protocol channel — all logging goes to stderr.

import { execSync } from "node:child_process";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
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
// Editor connection (one at a time; last-connected wins).
// ---------------------------------------------------------------------------
let editor = null; // { ws, paired, appVersion }
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

// CSWSH defense. WebSocket handshakes are exempt from the same-origin policy,
// so a plain loopback bind isn't enough: any web page the user visits can
// `new WebSocket("ws://127.0.0.1:38275")` and drive the editor. But browsers
// ALWAYS attach an `Origin` header to the handshake and a page can't forge it,
// so we reject any handshake whose Origin is a non-loopback web page. Absent
// Origin = a non-browser client (the CLI, the e2e harness) — no drive-by
// vector — and is allowed; a local malicious *process* is out of scope here
// (it already has code execution) and is the reason pairing also validates the
// echoed code below.
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

const wss = new WebSocketServer({
  host: "127.0.0.1",
  port: PORT,
  verifyClient: ({ origin }) => {
    if (isAllowedOrigin(origin)) return true;
    log(`rejected WebSocket handshake from disallowed Origin: ${origin}`);
    return false;
  },
});

wss.on("connection", (ws) => {
  if (editor) {
    // Last-connected wins — tell the old tab it's been replaced.
    try {
      editor.ws.send(JSON.stringify({ type: "replaced" }));
      editor.ws.close();
    } catch {
      // already dead
    }
    failPending("Editor connection was replaced by a new tab.");
  }
  editor = { ws, paired: false, appVersion: null };
  log("editor connected, awaiting pairing confirmation…");
  ws.send(
    JSON.stringify({
      type: "hello",
      code: PAIRING_CODE,
      serverVersion: VERSION,
      client: clientIdentity(),
    })
  );

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
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
      return;
    }
    if (msg.type === "result") {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error ?? "editor returned an error"));
    }
  });

  ws.on("close", () => {
    if (editor?.ws === ws) {
      editor = null;
      log("editor disconnected");
      failPending("Editor disconnected mid-command.");
    }
  });
  ws.on("error", () => {
    // close handler does the cleanup
  });
});

wss.on("error", (e) => {
  log(`WebSocket server error: ${e.message}`);
  if (e.code === "EADDRINUSE") {
    log(`port ${PORT} is in use — is another toolbox-mcp running?`);
    process.exit(1);
  }
});

function callEditor(cmd, args = {}, timeoutMs = CMD_TIMEOUT_MS) {
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

// ---------------------------------------------------------------------------
// MCP tools. Results marshal to text content; errors become isError results
// so the model can read and react (repair loop).
// ---------------------------------------------------------------------------
const server = new McpServer({ name: "toolbox", version: VERSION });

// The initialize handshake (where clientInfo arrives) can complete after an
// editor tab has already received its hello — push the completed identity so
// the tab never sticks on nulls.
server.server.oninitialized = () => {
  const info = server.server.getClientVersion();
  log(`MCP client: ${info?.name ?? "?"} v${info?.version ?? "?"}${HOST ? ` (${HOST})` : ""}`);
  try {
    editor?.ws.send(JSON.stringify({ type: "client_info", client: clientIdentity() }));
  } catch {
    // editor gone — the next hello carries it anyway
  }
};

// Source-reading tools (spec 071226_mcp-node-source-tools.md). These read the
// repo checkout directly — no bridge round-trip, so they work unpaired. The
// paired editor's version (when it differs from this checkout) triggers the
// GitHub-tag fallback so Claude reads the code the user is actually running.
const source = createSourceReader();
const pairedAppVersion = () => (editor?.paired ? editor.appVersion : null);
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

for (const def of BRIDGED_TOOLS) {
  server.registerTool(
    def.name,
    { description: def.description, inputSchema: def.inputSchema },
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
    description:
      "Read the actual source of a node from the public repo — use this to " +
      "understand HOW a node works beyond its catalog summary, or to explain " +
      "to the user exactly how to build a tree. Pass a `type` from " +
      "get_catalog; returns the node's definition file (line-numbered) plus " +
      "the `@/engine/*` helpers it imports (the real math usually lives " +
      "there — follow up with read_source). Prefer get_catalog for a quick " +
      "interface check; reach here when you need behavior, not just sockets. " +
      "Cite file:line when explaining behavior to the user.",
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
    description:
      "Read a file from the engine or node source (scope: src/nodes/ + " +
      "src/engine/ — where node behavior and the shared math live, e.g. " +
      "coerce.ts, types.ts, evaluator.ts, spline-boolean.ts). Line-numbered; " +
      "pass `start`/`end` (1-based, inclusive) to read a slice of a big file. " +
      "Use get_node_source first to find the right file for a node.",
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
    description:
      "Regex-search the engine + node source (src/nodes/ + src/engine/) and " +
      "get `path:line: text` matches — the way to FIND where something is " +
      "defined or used before reading it (a symbol, a socket type, a coercion, " +
      "a shader key). `pattern` is a JavaScript regex source; optional `glob` " +
      "filters paths (e.g. \"*.ts\", \"src/engine/*\"). Capped at 200 matches.",
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
    description:
      "Arm or disarm the evaluator performance trace. Capture is OFF by " +
      "default and costs nothing until armed. Level 1 records per-node time " +
      "and WHY each node recomputed; level 2 adds data volume (point/subpath " +
      "counts), texture create/delete churn, and fingerprint size. Arming " +
      "always clears the previous trace, so the sequence is: " +
      "set_perf_capture -> drive the workload (transport play, a set_param " +
      "edit, a scrub) -> get_perf. The editor only evaluates on playback, a " +
      "param change, or a graph change — an idle editor records no frames.",
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
    description:
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
      "instances and see which KIND of node is expensive.",
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
    description:
      "One frame's complete node list by sequence number — use it to " +
      "interrogate a spike found in get_perf's aggregate (e.g. why p95 is far " +
      "above p50). Samples tagged depth > 0 come from inside an Iterate " +
      "interior and their time is ALREADY counted in the enclosing shell's " +
      "depth-0 sample, so sum only depth-0 entries for a frame total.",
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
log(`ready — MCP on stdio, editor bridge on ws://127.0.0.1:${PORT}`);
log(`pairing code: ${PAIRING_CODE}`);

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
