// React owner of the Claude MCP bridge connection (spec
// 070926_claude-mcp-bridge.md). Wraps lib/mcp-bridge's plain client in
// editor state: the menu toggle, the pairing dialog's confirm/cancel, and
// session persistence (bridge enabled + trusted pairing code survive a
// reload; a NEW server boot mints a new code and re-prompts).
//
// Handlers are read through a ref so they can close over fresh EffectsApp
// state without ever reconnecting the socket.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  connectBridge,
  type BridgeClient,
  type BridgeHandlers,
  type BridgeStatus,
} from "@/lib/mcp-bridge";
import { CURRENT_VERSION } from "@/lib/changelog";

const TRUST_KEY = "toolbox.mcp.trustedCode";
const ENABLED_KEY = "toolbox.mcp.enabled";

function sget(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function sset(key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // storage unavailable — pairing just re-prompts
  }
}

export interface McpBridge {
  status: BridgeStatus;
  // Menu action: off → connect, anything else → disconnect.
  toggle: () => void;
  // Pairing dialog buttons.
  confirmPairing: () => void;
  cancelPairing: () => void;
}

export function useMcpBridge(
  handlersRef: React.MutableRefObject<BridgeHandlers>
): McpBridge {
  const [status, setStatus] = useState<BridgeStatus>({ state: "off" });
  const clientRef = useRef<BridgeClient | null>(null);

  const stop = useCallback(() => {
    clientRef.current?.close();
    clientRef.current = null;
    sset(ENABLED_KEY, null);
  }, []);

  const start = useCallback(() => {
    if (clientRef.current) return;
    sset(ENABLED_KEY, "1");
    clientRef.current = connectBridge({
      onStatus: setStatus,
      getHandlers: () => handlersRef.current,
      isCodeTrusted: (code) => sget(TRUST_KEY) === code,
      onCodeTrusted: (code) => sset(TRUST_KEY, code),
      appVersion: CURRENT_VERSION,
    });
  }, [handlersRef]);

  const toggle = useCallback(() => {
    if (clientRef.current) stop();
    else start();
  }, [start, stop]);

  const confirmPairing = useCallback(() => {
    clientRef.current?.confirmPairing();
  }, []);

  // Declining the code tears the whole connection down (don't idle-retry
  // against a server the user just refused).
  const cancelPairing = useCallback(() => stop(), [stop]);

  // Same-session reload with the bridge enabled → reconnect quietly (the
  // trusted-code check keeps it dialog-free against the same server boot).
  useEffect(() => {
    if (sget(ENABLED_KEY) === "1") start();
    return () => {
      clientRef.current?.close();
      clientRef.current = null;
    };
  }, [start]);

  return { status, toggle, confirmPairing, cancelPairing };
}
