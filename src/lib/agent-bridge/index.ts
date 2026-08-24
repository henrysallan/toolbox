// Editor side of the in-app assistant panel (spec 080826_claude-agent-panel.md,
// milestone 1).
//
// A plain WebSocket client (no React) that connects OUT to the local agent
// host (scripts/agent-host.mjs). Sibling of lib/mcp-bridge, and deliberately
// separate from it: that bridge is a command channel owned by an external
// Claude app, gated by a 4-digit pairing code, one editor at a time. This one
// is owned by Toolbox itself, gated by a high-entropy control token, and every
// window gets its own session.
//
// What it shares with mcp-bridge is the `cmd`/`result` frame shape, so the
// SAME BridgeHandlers table serves both — a tool call executes identically
// whether it arrived from Claude Desktop or from the in-app panel.
//
// Protocol frames:
//   page → host: {type:"hello", token, sessionKey, appVersion}
//                {type:"prompt", text} · {type:"interrupt"}
//                {type:"permission", requestId, behavior, message?}
//                {type:"result", id, ok, result?, error?}
//   host → page: {type:"ready", hostVersion, model, maxTurns}
//                {type:"denied", reason} · {type:"cmd", id, cmd, args}
//                {type:"event", message} · {type:"session", sdkSessionId}
//                {type:"permission_request", requestId, …}
//                {type:"closed"} · {type:"error", message}

import type { BridgeHandlers } from "@/lib/mcp-bridge";
import { isNative } from "@/lib/platform";

export const AGENT_HOST_URL = "ws://127.0.0.1:38276";

/**
 * Where the app is running, which decides whether an assistant session is
 * even possible.
 *
 * The agent host must run on the USER'S machine: it spawns their `claude`
 * binary and holds a socket to their browser. That makes this a local-only
 * feature, and the three environments need three different answers:
 *
 *   native  — Electron starts the host itself, so a missing host is a fault.
 *   local   — a developer running the repo; `npm run agent` is meaningful.
 *   hosted  — a normal web visitor. There is no repo to run anything in, and
 *             no way to reach a local host anyway: /api/agent-handshake reads
 *             the handshake file SERVER-side, which on a deployment is the
 *             server's disk, not theirs; and an https page cannot reliably
 *             open ws://127.0.0.1. Don't pretend otherwise — point at the
 *             desktop app.
 */
export type AgentEnvironment = "native" | "local" | "hosted";

/**
 * Whether the assistant can run here at all. Gate every entry point on this —
 * a hosted visitor should not be offered a feature that cannot start.
 *
 * Note this gates the ASSISTANT only. AI Recipe (its own API key) and the MCP
 * bridge (an external Claude app drives it) are unaffected and stay available
 * to everyone.
 */
export function isAgentAvailable(): boolean {
  return agentEnvironment() !== "hosted";
}

export function agentEnvironment(): AgentEnvironment {
  if (typeof window === "undefined") return "hosted";
  if (isNative) return "native";
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1"
    ? "local"
    : "hosted";
}

/**
 * Commands that change the document. Drives the checkpoint boundary — a
 * checkpoint is captured lazily, just before the first of these in an
 * iteration, so read-only exploration costs nothing.
 *
 * Mirrors MUTATING_TOOLS in scripts/toolbox-tool-defs.mjs, which is the source
 * of truth but can't be imported here: it pulls zod into the client bundle.
 * Keep the two in sync.
 */
export const MUTATING_COMMANDS = new Set([
  "insert_recipe",
  "edit_group",
  "set_param",
  "set_keyframes",
]);

/** Commands that end an iteration — the "look" in build → look → adjust. */
export const LOOK_COMMANDS = new Set(["screenshot", "screenshot_strip"]);

/** One message from the Agent SDK stream. Shape varies by `type`; the union
 *  is large (40+ variants) and grows, so consumers switch on the types they
 *  render and ignore the rest rather than exhaustively typing it. */
export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

/** A pending permission ask. Editor verbs are granted for the session, so
 *  this only fires for tools outside that set (spec §Permission). */
export interface AgentPermissionRequest {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  // Pre-rendered by the SDK — prefer these over rebuilding a sentence.
  displayName: string | null;
  title: string | null;
  description: string | null;
}

export type AgentStatus =
  | { state: "off" }
  | { state: "connecting" }
  | { state: "no-host" }
  | { state: "denied"; reason: string }
  | {
      state: "ready";
      hostVersion: string;
      model: string;
      maxTurns: number;
      // The host drives the user's INSTALLED Claude Code CLI, not a bundled
      // binary. Null path = not installed; the panel shows `binaryMessage`
      // instead of a composer that cannot work. `claudeVersion` is carried so
      // SDK↔CLI drift is visible rather than mysterious.
      claudeBin: string | null;
      claudeVersion: string | null;
      binaryMessage: string | null;
    };

export interface AgentClient {
  /** `context` is a short live-editor preamble the host prepends (M3). */
  send: (text: string, context?: string) => void;
  interrupt: () => void;
  answerPermission: (requestId: string, allow: boolean, message?: string) => void;
  close: () => void;
}

export interface AgentOptions {
  url?: string;
  /** Control token, from /api/agent-handshake (web) or Electron preload. */
  token: string;
  /** Stable per-window id; survives reload so a session can be reattached. */
  sessionKey: string;
  onStatus: (s: AgentStatus) => void;
  onEvent: (e: AgentEvent) => void;
  onPermission: (r: AgentPermissionRequest) => void;
  /** Live handler lookup — read through a ref so handlers close over fresh
   *  editor state without reconnecting the socket. Same table as mcp-bridge. */
  getHandlers: () => BridgeHandlers;
  appVersion?: string;
}

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 5000;

export function connectAgent(opts: AgentOptions): AgentClient {
  const url = opts.url ?? AGENT_HOST_URL;
  let ws: WebSocket | null = null;
  let closed = false;
  let retryMs = RETRY_BASE_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let ready = false;
  // Prompts typed before the socket is up are held rather than dropped —
  // the panel opens and accepts input before the host has necessarily
  // finished connecting.
  const queued: { text: string; context?: string }[] = [];

  const status = (s: AgentStatus) => {
    if (!closed) opts.onStatus(s);
  };

  const post = (frame: Record<string, unknown>): boolean => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(frame));
    return true;
  };

  // Execute a tool call against the live editor and answer the host.
  const runCommand = async (
    id: number,
    cmd: string,
    args: Record<string, unknown>
  ) => {
    const sock = ws;
    if (!sock || sock.readyState !== WebSocket.OPEN) return;
    let frame: string;
    try {
      const handler = opts.getHandlers()[cmd];
      if (!handler) throw new Error(`Unknown command "${cmd}".`);
      const result = await handler(args ?? {});
      frame = JSON.stringify({ type: "result", id, ok: true, result: result ?? null });
    } catch (e) {
      frame = JSON.stringify({
        type: "result",
        id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    // The socket may have died while the handler ran (screenshots are slow).
    if (sock.readyState === WebSocket.OPEN) sock.send(frame);
  };

  const open = () => {
    if (closed) return;
    status({ state: "connecting" });
    ready = false;
    ws = new WebSocket(url);

    ws.onopen = () => {
      retryMs = RETRY_BASE_MS;
      post({
        type: "hello",
        token: opts.token,
        sessionKey: opts.sessionKey,
        appVersion: opts.appVersion ?? "dev",
      });
    };

    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      switch (msg.type) {
        case "ready": {
          ready = true;
          status({
            state: "ready",
            hostVersion: String(msg.hostVersion ?? "?"),
            model: String(msg.model ?? "?"),
            maxTurns: Number(msg.maxTurns ?? 0),
            claudeBin: (msg.claudeBin as string | null) ?? null,
            claudeVersion: (msg.claudeVersion as string | null) ?? null,
            binaryMessage: (msg.binaryMessage as string | null) ?? null,
          });
          // Flush anything typed while connecting.
          while (queued.length) {
            const q = queued.shift()!;
            post({ type: "prompt", text: q.text, context: q.context });
          }
          return;
        }
        case "denied": {
          // A bad token is not retryable — stop rather than reconnect-looping.
          closed = true;
          ws?.close();
          opts.onStatus({ state: "denied", reason: String(msg.reason ?? "Denied.") });
          return;
        }
        case "cmd": {
          if (typeof msg.id === "number" && typeof msg.cmd === "string")
            void runCommand(
              msg.id,
              msg.cmd,
              (msg.args as Record<string, unknown>) ?? {}
            );
          return;
        }
        case "permission_request": {
          opts.onPermission({
            requestId: String(msg.requestId),
            toolName: String(msg.toolName),
            input: (msg.input as Record<string, unknown>) ?? {},
            displayName: (msg.displayName as string | null) ?? null,
            title: (msg.title as string | null) ?? null,
            description: (msg.description as string | null) ?? null,
          });
          return;
        }
        case "event": {
          opts.onEvent(msg.message as AgentEvent);
          return;
        }
        case "session":
        case "closed":
          return;
        case "error": {
          opts.onEvent({ type: "host_error", message: String(msg.message ?? "") });
          return;
        }
      }
    };

    ws.onclose = () => {
      ws = null;
      if (closed) return;
      // No host running is the common case in the browser (the user hasn't
      // started `npm run agent`) — report it distinctly so the panel can say
      // something useful instead of spinning.
      status({ state: ready ? "connecting" : "no-host" });
      retryTimer = setTimeout(open, retryMs);
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    };
    ws.onerror = () => {
      // onclose follows and owns the retry.
    };
  };

  open();

  return {
    send: (text, context) => {
      if (!post({ type: "prompt", text, context })) queued.push({ text, context });
    },
    interrupt: () => {
      post({ type: "interrupt" });
    },
    answerPermission: (requestId, allow, message) => {
      post({
        type: "permission",
        requestId,
        behavior: allow ? "allow" : "deny",
        message,
      });
    },
    close: () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
      opts.onStatus({ state: "off" });
    },
  };
}

/**
 * Stable per-window session key. Kept in sessionStorage so a reload reattaches
 * to the same logical window rather than minting a new session, and so two
 * tabs never collide (sessionStorage is per-tab by definition).
 */
export function windowSessionKey(): string {
  const KEY = "toolbox.agent.sessionKey";
  try {
    const existing = sessionStorage.getItem(KEY);
    if (existing) return existing;
    const minted = crypto.randomUUID();
    sessionStorage.setItem(KEY, minted);
    return minted;
  } catch {
    // Storage unavailable — a per-load key still works, it just won't
    // survive a reload.
    return crypto.randomUUID();
  }
}
