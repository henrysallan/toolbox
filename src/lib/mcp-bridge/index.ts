// Editor side of the Claude MCP bridge (spec 070926_claude-mcp-bridge.md).
//
// A plain WebSocket client (no React) that connects OUT to the local
// toolbox-mcp server (scripts/mcp-server.mjs), confirms pairing, and executes
// the commands the server forwards from Claude's tool calls. Command handlers
// are supplied by the caller (EffectsApp via useMcpBridge) — this module owns
// only transport, pairing, and dispatch.
//
// Protocol frames:
//   server → page: {type:"hello", code, serverVersion}
//                  {type:"cmd", id, cmd, args} · {type:"replaced"}
//   page → server: {type:"pair", ok:true, code, appVersion}  (code echoes hello)
//                  {type:"result", id, ok, result?, error?}

export const MCP_BRIDGE_URL = "ws://127.0.0.1:38275";

// A command handler returns the JSON-serializable result (or a promise of
// one). Throwing (or rejecting) turns into an {ok:false, error} frame the
// server surfaces to the model as a readable tool error.
export type BridgeHandler = (args: Record<string, unknown>) => unknown;
export type BridgeHandlers = Record<string, BridgeHandler>;

export type BridgeStatus =
  | { state: "off" }
  | { state: "connecting" }
  // Waiting on the user to confirm the 4-digit code matches the server's.
  | { state: "pairing"; code: string }
  | { state: "connected"; code: string; serverVersion: string };

export interface BridgeClient {
  // Confirm the pairing code currently shown (no-op unless pairing).
  confirmPairing: () => void;
  // Tear down and stop reconnecting.
  close: () => void;
}

export interface BridgeOptions {
  url?: string;
  // Called on every status transition (connect/pair/close/retry).
  onStatus: (s: BridgeStatus) => void;
  // Live handler lookup — read through a ref so handlers can close over
  // fresh React state without reconnecting.
  getHandlers: () => BridgeHandlers;
  // Pairing codes the user already confirmed this session (auto-confirm on
  // reconnect against the same server boot).
  isCodeTrusted?: (code: string) => boolean;
  onCodeTrusted?: (code: string) => void;
  appVersion?: string;
}

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 5000;

export function connectBridge(opts: BridgeOptions): BridgeClient {
  const url = opts.url ?? MCP_BRIDGE_URL;
  let ws: WebSocket | null = null;
  let closed = false;
  let retryMs = RETRY_BASE_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let hello: { code: string; serverVersion: string } | null = null;

  const status = (s: BridgeStatus) => {
    if (!closed) opts.onStatus(s);
  };

  const pair = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN || !hello) return;
    // Echo the code from `hello` — the server validates it before pairing.
    ws.send(
      JSON.stringify({
        type: "pair",
        ok: true,
        code: hello.code,
        appVersion: opts.appVersion ?? "dev",
      })
    );
    opts.onCodeTrusted?.(hello.code);
    status({ state: "connected", code: hello.code, serverVersion: hello.serverVersion });
  };

  const runCommand = async (id: number, cmd: string, args: Record<string, unknown>) => {
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
    // The socket may have died while the handler ran.
    if (sock.readyState === WebSocket.OPEN) sock.send(frame);
  };

  const open = () => {
    if (closed) return;
    status({ state: "connecting" });
    hello = null;
    ws = new WebSocket(url);

    ws.onopen = () => {
      retryMs = RETRY_BASE_MS;
    };

    ws.onmessage = (ev) => {
      let msg: {
        type?: string;
        id?: number;
        cmd?: string;
        args?: Record<string, unknown>;
        code?: string;
        serverVersion?: string;
      };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === "hello" && msg.code) {
        hello = { code: msg.code, serverVersion: msg.serverVersion ?? "?" };
        if (opts.isCodeTrusted?.(msg.code)) pair();
        else status({ state: "pairing", code: msg.code });
        return;
      }
      if (msg.type === "cmd" && typeof msg.id === "number" && msg.cmd) {
        void runCommand(msg.id, msg.cmd, msg.args ?? {});
        return;
      }
      if (msg.type === "replaced") {
        // Another tab took over — stop for good rather than fighting it.
        closed = true;
        ws?.close();
        opts.onStatus({ state: "off" });
      }
    };

    ws.onclose = () => {
      ws = null;
      hello = null;
      if (closed) return;
      // Server not up (or dropped) — keep retrying until the user toggles off.
      status({ state: "connecting" });
      retryTimer = setTimeout(open, retryMs);
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    };
    ws.onerror = () => {
      // onclose follows and owns the retry.
    };
  };

  open();

  return {
    confirmPairing: pair,
    close: () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
      opts.onStatus({ state: "off" });
    },
  };
}
