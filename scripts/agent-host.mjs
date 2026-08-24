// Toolbox agent host (spec 080826_claude-agent-panel.md, milestone 1).
//
// Hosts the in-app assistant panel's agent sessions. Unlike mcp-server.mjs —
// which is spawned BY the Claude app and relays its stdio tool calls to a
// single editor tab — this process is spawned by Toolbox itself and inverts
// the topology:
//
//   Toolbox window ──ws──▶ agent-host ──Agent SDK──▶ claude binary
//        ▲                     │                          │
//        └── cmd/result frames ┴◀── in-process MCP tools ──┘
//
// The agent's tools are registered IN-PROCESS (createSdkMcpServer), so a tool
// call is one hop back down the same socket the prompt arrived on. That is
// what makes sessions per-window: the socket IS the session identity.
//
// Auth is inherited, never implemented — the SDK spawns the user's logged-in
// `claude` binary, so inference bills to their subscription and no API key or
// credential ever passes through this process.
//
// Run:  npm run agent        (dev; prints the control token)
//       Electron main spawns it automatically (electron/agent.js)
//
// stdout carries the handshake line and nothing else; all logging is stderr.

import { WebSocketServer } from "ws";
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  BRIDGED_TOOLS,
  MUTATING_TOOLS,
  marshalResult,
  marshalError,
} from "./toolbox-tool-defs.mjs";

const VERSION = "0.1.0";
const PORT = Number(process.env.TOOLBOX_AGENT_PORT ?? 38276);

// Pinned deliberately: the CLI's own default follows the user's config (a
// smoke test resolved to claude-fable-5), and the panel must not change
// behaviour because someone reconfigured their terminal.
const MODEL = process.env.TOOLBOX_AGENT_MODEL ?? "claude-opus-5";

// Iteration cap (spec §The loop). Enforced at the SDK level.
const MAX_TURNS = Number(process.env.TOOLBOX_AGENT_MAX_TURNS ?? 8);

// Large tool results don't reach the model inline. Claude Code truncates them
// and writes the full text to a spill file under ~/.claude/…/tool-results/,
// expecting the agent to Read it back. get_catalog is ~174k chars, so it
// ALWAYS spills.
//
// This is why the panel behaved worse than the same tools under Claude
// Desktop / Claude Code: there, Read exists, the model quietly reads the
// spill, and nobody notices. With Read disabled the spill became a dead end —
// the model reported "no file access" and fell back to probing the graph with
// throwaway recipes to discover node types, which is exactly the failure a
// real session showed.
//
// So Read is enabled, but ONLY for spill files. It is not a filesystem grant:
// the path must sit under ~/.claude AND inside a tool-results directory. If
// that layout ever changes the model loses catalog recovery and says so —
// a visible failure rather than a silent widening of what it can read.
const SPILL_ROOT = join(homedir(), ".claude");

function isSpillPath(p) {
  if (typeof p !== "string" || !p) return false;
  const abs = resolve(p);
  return (
    (abs === SPILL_ROOT || abs.startsWith(SPILL_ROOT + sep)) &&
    abs.split(sep).includes("tool-results")
  );
}

// Everything else stays out of the model's context entirely. `tools:` sets the
// base set; disallowedTools is documented to REMOVE tools rather than merely
// refuse them, and is the belt to that braces — `tools: []` alone did not hold
// in a real session, because settings loaded from disk re-added built-ins
// (see settingSources below).
const ALLOWED_BUILTINS = ["Read"];
const DISALLOWED_TOOLS = [
  "Bash",
  "Write",
  "Edit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "TodoWrite",
  "Skill",
  "KillShell",
  "BashOutput",
];

// Where the Next route (src/app/api/agent-handshake/route.ts) reads the port
// and control token from. Keep this path in sync with that file.
const HANDSHAKE_FILE = join(tmpdir(), "toolbox-agent.json");

// ---------------------------------------------------------------------------
// Which `claude` binary to drive.
//
// The SDK ships its own — a 303MB per-platform executable it uses when
// pathToClaudeCodeExecutable is unset. We deliberately drive the USER'S
// installed CLI instead:
//
//   • Bundling would add ~300MB per platform to a 433MB app, and npm only
//     installs the HOST platform's optional package, so cross-building the
//     Windows target from macOS wouldn't have its binary at all.
//   • It would not remove the prerequisite anyway. Credentials live in the
//     OS keychain, not in the package, so a user who has never logged into
//     Claude has nothing regardless of which binary ships.
//
// The cost of this choice is version drift: the user's CLI may be older or
// newer than this SDK expects. That is why the resolved path and version are
// reported to the panel — drift should surface as information, not as
// mysterious breakage.
// ---------------------------------------------------------------------------
const CLAUDE_BIN_CANDIDATES = [
  join(homedir(), ".claude", "local", "claude"),
  join(homedir(), ".local", "bin", "claude"),
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
];

function resolveClaudeBinary() {
  const override = process.env.TOOLBOX_CLAUDE_BIN;
  if (override) return existsSync(override) ? override : null;
  // PATH first — respects nvm/volta/asdf shims and Windows installs.
  try {
    const found = execFileSync(
      process.platform === "win32" ? "where" : "which",
      ["claude"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    )
      .split(/\r?\n/)[0]
      .trim();
    if (found && existsSync(found)) return found;
  } catch {
    // not on PATH — fall through to the well-known locations
  }
  return CLAUDE_BIN_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

const CLAUDE_BIN = resolveClaudeBinary();

function claudeVersion() {
  if (!CLAUDE_BIN) return null;
  try {
    return execFileSync(CLAUDE_BIN, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
  } catch {
    return null;
  }
}

const CLAUDE_VERSION = claudeVersion();

const NO_BINARY_MESSAGE =
  "Claude Code isn't installed (or isn't on PATH). The assistant runs on your " +
  "own Claude subscription through the Claude Code CLI — install it and run " +
  "`claude` once to sign in, then reopen this panel.";

// 32 bytes of entropy, minted per boot. Deliberately NOT the MCP server's
// 4-digit pairing code: that gates "reorder my nodes" and is brute-forceable
// over a local socket in seconds; this gates "start an agent".
const CONTROL_TOKEN = randomBytes(32).toString("base64url");

const log = (...args) => console.error("[toolbox-agent]", ...args);

function tokenMatches(candidate) {
  if (typeof candidate !== "string") return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(CONTROL_TOKEN);
  // timingSafeEqual throws on length mismatch — check first, and still
  // compare so a wrong-length guess doesn't return measurably faster.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Origin gate. Same reasoning as mcp-server.mjs: WebSocket handshakes are
// exempt from the same-origin policy, so binding loopback isn't enough — any
// page the user visits could otherwise open a socket here. Browsers always
// attach an unforgeable Origin, so non-loopback origins are rejected. Absent
// Origin means a non-browser client, which has no drive-by vector; the control
// token below is what actually gates starting an agent.
// ---------------------------------------------------------------------------
function isAllowedOrigin(origin) {
  if (!origin) return true;
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

// ---------------------------------------------------------------------------
// Sessions. One per connected window — the socket is the identity, so two
// windows cannot see or steal each other's tools, transcript, or agent.
// ---------------------------------------------------------------------------
/**
 * @typedef {object} Session
 * @property {import("ws").WebSocket} ws
 * @property {boolean} authed
 * @property {string} key           renderer-supplied, survives reload
 * @property {object|null} q        the SDK Query (null until first prompt)
 * @property {object|null} input    streaming-input queue
 * @property {Map<number, object>} pending   tool calls awaiting the editor
 * @property {Map<string, object>} permits   permission asks awaiting the user
 * @property {number} nextId
 * @property {string|null} sdkSessionId
 */
const sessions = new Map(); // ws → Session

function send(session, frame) {
  if (session.ws.readyState !== session.ws.OPEN) return;
  try {
    session.ws.send(JSON.stringify(frame));
  } catch (e) {
    log(`send failed: ${e.message}`);
  }
}

function failPending(session, reason) {
  for (const [, p] of session.pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
  session.pending.clear();
  for (const [, p] of session.permits) {
    clearTimeout(p.timer);
    // Fail closed: an unanswered permission ask is a denial.
    p.resolve({ behavior: "deny", message: reason });
  }
  session.permits.clear();
}

/**
 * Marshal a tool call to THIS session's editor window and await its answer.
 * Mirrors mcp-server.mjs's callEditor, but scoped to one socket rather than a
 * single global editor slot.
 */
function callEditor(session, cmd, args, timeoutMs) {
  if (session.ws.readyState !== session.ws.OPEN)
    return Promise.reject(new Error("The Toolbox window disconnected."));
  const id = session.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pending.delete(id);
      reject(
        new Error(`The editor did not answer "${cmd}" within ${timeoutMs / 1000}s.`)
      );
    }, timeoutMs);
    session.pending.set(id, { resolve, reject, timer });
    send(session, { type: "cmd", id, cmd, args });
  });
}

/** Build the in-process MCP server exposing the bridged verbs for a session. */
function buildToolServer(session) {
  return createSdkMcpServer({
    name: "toolbox",
    version: VERSION,
    instructions:
      "Tools that drive the Toolbox editor window this conversation is " +
      "attached to. Every call acts on the user's live document.",
    tools: BRIDGED_TOOLS.map((def) =>
      tool(
        def.name,
        def.description,
        def.inputSchema,
        async (args) => {
          try {
            const result = await callEditor(
              session,
              def.name,
              args ?? {},
              def.timeoutMs
            );
            return marshalResult(def, result);
          } catch (e) {
            return marshalError(e);
          }
        },
        {
          annotations: {
            readOnlyHint: !def.mutates,
            destructiveHint: false,
            openWorldHint: false,
          },
        }
      )
    ),
  });
}

// ---------------------------------------------------------------------------
// Streaming input. One query() per session, fed by an async iterator, so the
// subprocess and its context stay alive across turns and interrupt() works.
// ---------------------------------------------------------------------------
function makeInputQueue() {
  const items = [];
  let waiting = null;
  let closed = false;
  return {
    push(text, context) {
      // The renderer knows what the user is looking at right now. Prepending
      // it saves an orientation round-trip and gives the model things it
      // cannot otherwise infer (which layer is selected, what was last
      // touched) — context Claude Desktop structurally cannot have.
      const content = context ? `${context}\n\n---\n\n${text}` : text;
      const msg = {
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
      };
      if (waiting) {
        const w = waiting;
        waiting = null;
        w({ value: msg, done: false });
      } else items.push(msg);
    },
    close() {
      closed = true;
      if (waiting) {
        const w = waiting;
        waiting = null;
        w({ value: undefined, done: true });
      }
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (items.length) {
          yield items.shift();
          continue;
        }
        if (closed) return;
        const next = await new Promise((r) => (waiting = r));
        if (next.done) return;
        yield next.value;
      }
    },
  };
}

const SYSTEM_PROMPT =
  "You are the assistant built into Toolbox, a node-graph motion design tool. " +
  "You are attached to one live editor window and act on the user's real " +
  "document through the toolbox tools.\n\n" +
  "Loop: call get_catalog once to learn the node vocabulary, get_graph to see " +
  "what exists (node ids are minted by the editor and cannot be guessed), " +
  "build, then LOOK at what you made with screenshot and judge it against " +
  "what the user asked for. Refine with set_param or edit_group rather than " +
  "rebuilding. For motion, use screenshot_strip with a frame count that " +
  "represents the movement, and prefer get_keyframes over screenshots when " +
  "the question is numeric.\n\n" +
  "get_catalog is large and will usually be saved to a file rather than " +
  "returned inline. That is normal — read that file back and carry on. NEVER " +
  "guess node type strings, and never probe for them by inserting throwaway " +
  "recipes; every type you use must come from the catalog.\n\n" +
  "WHERE TO BUILD. By default, build INTO the composition the user is " +
  "looking at: find the target layer with get_graph and add nodes to its " +
  "interior with edit_group's add_node / add_edge ops. insert_recipe wraps " +
  "everything it makes in a NEW node-group, which is right only when the " +
  "user asked for a reusable group or a self-contained effect. Do not wrap " +
  "work in a group just because it is convenient — it is not what people " +
  "mean by 'make me an X'.\n\n" +
  "HOW TO KNOW YOU ARE DONE. Before building, restate the request as a short " +
  "checklist of concrete, checkable criteria — things you could point at in a " +
  "render and say yes or no to. Keep it to the few that matter; do not pad " +
  "it. After each screenshot, grade the render against that checklist and say " +
  "which items pass and which do not.\n\n" +
  `Stop when every item passes, or after ${MAX_TURNS} build-and-look ` +
  "iterations, or as soon as two iterations in a row fail to improve any " +
  "item — grinding on the same failure is worse than reporting it. When you " +
  "stop, say plainly what works and what does not. If the request cannot be " +
  "done with the available nodes, say so instead of building something that " +
  "only approximately answers it.";

/** Start the agent for a session (lazy — first prompt only). */
function startQuery(session) {
  session.input = makeInputQueue();
  session.q = query({
    prompt: session.input,
    options: {
      systemPrompt: SYSTEM_PROMPT,
      model: MODEL,
      maxTurns: MAX_TURNS,
      // Three layers, because the first one alone was observed to fail:
      //   1. tools: []          — documented to disable built-ins
      //   2. disallowedTools    — removes them from the model's context
      //   3. canUseTool         — refuses anything that still gets through
      tools: ALLOWED_BUILTINS,
      disallowedTools: DISALLOWED_TOOLS,
      strictMcpConfig: true,
      mcpServers: { toolbox: buildToolServer(session) },
      permissionMode: "default",
      // SDK isolation mode. Omitting this loads ~/.claude/settings.json,
      // .claude/settings.json and .local.json "matching CLI defaults" — which
      // is how the user's own permissions, hooks and CLAUDE.md leaked into
      // panel sessions and put Read/Bash back on the table. A shipped feature
      // must not behave differently per developer's terminal config.
      settingSources: [],
      canUseTool: (toolName, input, opts) =>
        decidePermission(session, toolName, input, opts),
      // Drive the user's installed CLI rather than the SDK's bundled binary
      // — see the CLAUDE_BIN block above for why.
      pathToClaudeCodeExecutable: CLAUDE_BIN,
    },
  });

  void pumpEvents(session);
}

/**
 * Session-scoped authorization (spec §Permission and checkpoints). Editor
 * verbs are granted wholesale for the session's lifetime — prompting per
 * set_param would mean clicking Allow hundreds of times in an iteration loop.
 * Anything else raises a card in the panel and blocks the turn.
 */
function decidePermission(session, toolName, input, opts) {
  const bare = toolName.replace(/^mcp__toolbox__/, "");
  const known = BRIDGED_TOOLS.some((t) => t.name === bare);
  if (known) return Promise.resolve({ behavior: "allow", updatedInput: input });

  // Read exists solely to recover spilled tool results (see SPILL_ROOT).
  // Anything else it might be pointed at is refused without prompting — this
  // is not a filesystem grant the user can widen by clicking Allow.
  if (toolName === "Read") {
    const path = input?.file_path ?? input?.path;
    if (isSpillPath(path))
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    return Promise.resolve({
      behavior: "deny",
      message:
        "Read is limited to Claude Code's own tool-result spill files. Use " +
        "the toolbox tools to inspect the project.",
    });
  }

  const requestId = opts?.requestId ?? `p${session.nextId++}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      session.permits.delete(requestId);
      resolve({ behavior: "deny", message: "No answer from the user." });
    }, 120_000);
    session.permits.set(requestId, { resolve, timer });
    send(session, {
      type: "permission_request",
      requestId,
      toolName,
      input,
      // Pre-rendered by the SDK — the card uses these rather than
      // reconstructing a sentence from toolName + input.
      displayName: opts?.displayName ?? null,
      title: opts?.title ?? null,
      description: opts?.description ?? null,
    });
  });
}

/** Forward the SDK message stream to the window. */
async function pumpEvents(session) {
  try {
    for await (const msg of session.q) {
      // Hook chatter from the user's global Claude config is noise here.
      if (msg.type === "system" && String(msg.subtype ?? "").startsWith("hook_"))
        continue;
      if (msg.session_id && !session.sdkSessionId) {
        session.sdkSessionId = msg.session_id;
        send(session, { type: "session", sdkSessionId: msg.session_id });
      }
      send(session, { type: "event", message: msg });
    }
    send(session, { type: "closed" });
  } catch (e) {
    log(`session ${session.key} stream error: ${e.message}`);
    send(session, { type: "error", message: e.message });
  }
}

// ---------------------------------------------------------------------------
// Wire protocol (page ⇄ host)
//
//   page → host   {type:"hello", token, sessionKey, appVersion}
//                 {type:"prompt", text}
//                 {type:"interrupt"}
//                 {type:"permission", requestId, behavior, message?}
//                 {type:"result", id, ok, result?, error?}    ← tool answers
//
//   host → page   {type:"ready", hostVersion, model, maxTurns}
//                 {type:"denied", reason}
//                 {type:"cmd", id, cmd, args}                 ← tool calls
//                 {type:"event", message}                     ← SDK messages
//                 {type:"session", sdkSessionId}
//                 {type:"permission_request", requestId, …}
//                 {type:"closed"} · {type:"error", message}
//
// cmd/result deliberately share their shape with the MCP bridge so the
// renderer can dispatch both through the same handler table.
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({
  host: "127.0.0.1",
  port: PORT,
  verifyClient: ({ origin }) => {
    if (isAllowedOrigin(origin)) return true;
    log(`rejected handshake from disallowed Origin: ${origin}`);
    return false;
  },
});

wss.on("connection", (ws) => {
  /** @type {Session} */
  const session = {
    ws,
    authed: false,
    key: "?",
    q: null,
    input: null,
    pending: new Map(),
    permits: new Map(),
    nextId: 1,
    sdkSessionId: null,
  };
  sessions.set(ws, session);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (msg.type === "hello") {
      if (!tokenMatches(msg.token)) {
        log("rejected hello with a bad control token");
        send(session, { type: "denied", reason: "Bad control token." });
        ws.close();
        return;
      }
      session.authed = true;
      session.key = String(msg.sessionKey ?? "?").slice(0, 64);
      log(`window ${session.key} authorized (${sessions.size} connected)`);
      send(session, {
        type: "ready",
        hostVersion: VERSION,
        model: MODEL,
        maxTurns: MAX_TURNS,
        // Null when Claude Code isn't installed — the panel shows the
        // install prompt instead of a composer that can't work.
        claudeBin: CLAUDE_BIN,
        claudeVersion: CLAUDE_VERSION,
        binaryMessage: CLAUDE_BIN ? null : NO_BINARY_MESSAGE,
      });
      return;
    }

    // Everything past hello requires auth.
    if (!session.authed) return;

    if (msg.type === "prompt") {
      const text = String(msg.text ?? "").trim();
      if (!text) return;
      // Fail loudly and once, rather than spawning a query that dies opaquely.
      if (!CLAUDE_BIN) {
        send(session, { type: "error", message: NO_BINARY_MESSAGE });
        return;
      }
      if (!session.q) startQuery(session);
      session.input.push(
        text,
        typeof msg.context === "string" ? msg.context : null
      );
      return;
    }

    if (msg.type === "interrupt") {
      session.q?.interrupt?.().catch((e) => log(`interrupt failed: ${e.message}`));
      return;
    }

    if (msg.type === "permission") {
      const p = session.permits.get(msg.requestId);
      if (!p) return;
      session.permits.delete(msg.requestId);
      clearTimeout(p.timer);
      p.resolve(
        msg.behavior === "allow"
          ? { behavior: "allow" }
          : { behavior: "deny", message: msg.message ?? "Denied by the user." }
      );
      return;
    }

    if (msg.type === "result") {
      const p = session.pending.get(msg.id);
      if (!p) return;
      session.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error ?? "The editor returned an error."));
      return;
    }
  });

  ws.on("close", () => {
    sessions.delete(ws);
    failPending(session, "The Toolbox window disconnected.");
    session.input?.close();
    try {
      session.q?.close?.();
    } catch {
      // already gone
    }
    if (session.authed) log(`window ${session.key} closed (${sessions.size} left)`);
  });

  ws.on("error", () => {
    // close handler owns cleanup
  });
});

wss.on("error", (e) => {
  log(`WebSocket server error: ${e.message}`);
  if (e.code === "EADDRINUSE") {
    log(`port ${PORT} is in use — is another agent host running?`);
    process.exit(1);
  }
});

// ---------------------------------------------------------------------------
// Handshake: how the renderer learns the token.
//   Electron — main reads this file and hands the token to the window.
//   Web/dev  — /api/agent-handshake reads it for a signed-in user.
// Written 0600 and removed on exit; the token is per-boot.
// ---------------------------------------------------------------------------
// Announced on "listening", never before: the handshake is what tells the
// renderer (and the Next route) that the socket is up, so publishing it while
// the server is still binding hands out a token that ECONNREFUSEs.
wss.on("listening", () => {
  try {
    writeFileSync(
      HANDSHAKE_FILE,
      JSON.stringify({ port: PORT, token: CONTROL_TOKEN, pid: process.pid }),
      { mode: 0o600 }
    );
  } catch (e) {
    log(`could not write handshake file: ${e.message}`);
  }

  // One machine-readable line on stdout for a supervising parent.
  console.log(JSON.stringify({ ready: true, port: PORT, token: CONTROL_TOKEN }));

  log(`listening on ws://127.0.0.1:${PORT}`);
  log(`model ${MODEL}, maxTurns ${MAX_TURNS}`);
  log(
    CLAUDE_BIN
      ? `claude binary ${CLAUDE_BIN}${CLAUDE_VERSION ? ` (${CLAUDE_VERSION})` : ""}`
      : "claude binary NOT FOUND — sessions will refuse to start"
  );
  log(`handshake at ${HANDSHAKE_FILE}`);
  log(`${BRIDGED_TOOLS.length} tools: ${BRIDGED_TOOLS.map((t) => t.name).join(", ")}`);
  log(`mutating (session-granted): ${MUTATING_TOOLS.join(", ")}`);
});

function cleanup() {
  try {
    unlinkSync(HANDSHAKE_FILE);
  } catch {
    // already gone
  }
}
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    cleanup();
    process.exit(0);
  });
}
