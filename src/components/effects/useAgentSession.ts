// React owner of the in-app assistant session (spec 080826_claude-agent-panel.md,
// milestones 1–3). Sibling of useMcpBridge: same ref-indirection trick for
// handlers, but it drives lib/agent-bridge instead of lib/mcp-bridge.
//
// Owns three things the shells don't:
//   • the connection (lazily opened, and NOT closed when a shell hides),
//   • the transcript,
//   • the checkpoint rail (M3) — graph snapshots taken at iteration
//     boundaries so an unattended run can be rewound.
//
// Handlers are read through a ref so tool calls close over fresh EffectsApp
// state without ever reconnecting the socket. This is deliberately the SAME
// ref the MCP bridge uses: one handler table, two drivers.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  LOOK_COMMANDS,
  MUTATING_COMMANDS,
  agentEnvironment,
  connectAgent,
  windowSessionKey,
  type AgentClient,
  type AgentEvent,
  type AgentPermissionRequest,
  type AgentStatus,
} from "@/lib/agent-bridge";
import type { BridgeHandlers } from "@/lib/mcp-bridge";
import { CURRENT_VERSION } from "@/lib/changelog";

/**
 * A rewind point. Captured lazily — just before the first document-mutating
 * tool call of an iteration — so a run that only looks around costs nothing.
 *
 * Granularity is per ITERATION, not per tool call (spec Decision 3): a tool
 * call is rarely the unit anyone wants back, whereas "before it tried the
 * version with the noise displacement" is. Per-call rewind is still available
 * through normal undo.
 */
export interface AgentCheckpoint {
  id: string;
  label: string;
  /** Transcript position, so the rail renders inline where it happened. */
  eventIndex: number;
  snap: unknown;
}

export interface AgentSessionDeps {
  /** Capture the current graph. Omitted → checkpoints are disabled. */
  snapshot?: () => unknown;
  /** Put a captured graph back. */
  restore?: (snap: unknown) => void;
  /** Short live-editor preamble sent with each prompt (M3). */
  buildContext?: () => string;
}

export interface AgentSession {
  status: AgentStatus;
  events: AgentEvent[];
  permission: AgentPermissionRequest | null;
  busy: boolean;
  checkpoints: AgentCheckpoint[];
  send: (text: string) => void;
  interrupt: () => void;
  answerPermission: (allow: boolean) => void;
  clear: () => void;
  /** Restore the graph AND truncate the transcript to match. */
  restoreCheckpoint: (id: string) => void;
}

export function useAgentSession(
  handlersRef: React.MutableRefObject<BridgeHandlers>,
  /**
   * Any shell is showing the session (docked panel, tiled panel, overlay).
   * Once connected the session stays alive even when every shell is closed —
   * dismissing the overlay mid-run must not kill the work.
   */
  visible: boolean,
  deps: AgentSessionDeps = {}
): AgentSession {
  const [status, setStatus] = useState<AgentStatus>({ state: "off" });
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [permission, setPermission] = useState<AgentPermissionRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkpoints, setCheckpoints] = useState<AgentCheckpoint[]>([]);

  const clientRef = useRef<AgentClient | null>(null);
  const connectingRef = useRef(false);
  // Mirrors of state that tool-call callbacks need to read synchronously.
  const eventCountRef = useRef(0);
  const iterationRef = useRef(1);
  const armedRef = useRef(true);
  // Updated in an effect, not during render: callers pass a fresh object
  // literal every render, and tool callbacks read this asynchronously.
  const depsRef = useRef(deps);
  useEffect(() => {
    depsRef.current = deps;
  });

  // --- checkpoint rail ----------------------------------------------------

  const captureIfArmed = useCallback(() => {
    if (!armedRef.current) return;
    const take = depsRef.current.snapshot;
    if (!take) return;
    armedRef.current = false;
    const n = iterationRef.current;
    setCheckpoints((prev) => [
      ...prev,
      {
        id: `cp${n}-${prev.length}`,
        label: n === 1 ? "before first change" : `before iteration ${n}`,
        eventIndex: eventCountRef.current,
        snap: take(),
      },
    ]);
  }, []);

  const endIteration = useCallback(() => {
    iterationRef.current += 1;
    armedRef.current = true;
  }, []);

  const restoreCheckpoint = useCallback((id: string) => {
    setCheckpoints((prev) => {
      const i = prev.findIndex((c) => c.id === id);
      if (i < 0) return prev;
      const cp = prev[i];
      depsRef.current.restore?.(cp.snap);
      // Truncate the transcript to match, so what the user sees and what the
      // document contains agree. A run in flight is stopped first — letting
      // it keep mutating a rewound graph is how you get an incoherent state.
      clientRef.current?.interrupt();
      setBusy(false);
      setEvents((evs) => evs.slice(0, cp.eventIndex));
      eventCountRef.current = cp.eventIndex;
      armedRef.current = true;
      return prev.slice(0, i);
    });
  }, []);

  // --- handler wrapping ---------------------------------------------------
  // Checkpoints are driven from the COMMAND path, not from the event stream:
  // the snapshot has to be taken before the mutation is applied, and only the
  // command path is ordered with respect to it.
  const getWrappedHandlers = useCallback((): BridgeHandlers => {
    const base = handlersRef.current;
    const wrapped: BridgeHandlers = {};
    for (const cmd of Object.keys(base)) {
      wrapped[cmd] = async (args) => {
        if (MUTATING_COMMANDS.has(cmd)) captureIfArmed();
        const result = await base[cmd](args);
        // A "look" ends the build→look→adjust cycle, so the next mutation
        // belongs to a new iteration and earns its own checkpoint.
        if (LOOK_COMMANDS.has(cmd)) endIteration();
        return result;
      };
    }
    return wrapped;
  }, [handlersRef, captureIfArmed, endIteration]);

  // --- connection ---------------------------------------------------------

  useEffect(() => {
    if (!visible) return;
    if (clientRef.current || connectingRef.current) return;
    // A hosted visitor has no local host to reach and the handshake route
    // would read the SERVER's disk. Don't probe at all — the status stays
    // "off" and agentReadiness turns that into the right explanation. (No
    // setStatus here on purpose: it would both trip set-state-in-effect and
    // risk an SSR/client mismatch, since the environment isn't knowable on
    // the server.)
    if (agentEnvironment() === "hosted") return;
    connectingRef.current = true;
    let cancelled = false;

    // The token is per host boot and can't be read from the page, so it comes
    // from the local Next route. Electron uses the same path — the desktop
    // build serves the real app on loopback.
    void (async () => {
      setStatus({ state: "connecting" });
      let token: string;
      let port: number;
      try {
        const res = await fetch("/api/agent-handshake");
        const body = await res.json();
        if (!res.ok || !body.running) {
          connectingRef.current = false;
          if (!cancelled) setStatus({ state: "no-host" });
          return;
        }
        token = body.token;
        port = body.port;
      } catch {
        connectingRef.current = false;
        if (!cancelled) setStatus({ state: "no-host" });
        return;
      }
      if (cancelled) {
        connectingRef.current = false;
        return;
      }

      clientRef.current = connectAgent({
        url: `ws://127.0.0.1:${port}`,
        token,
        sessionKey: windowSessionKey(),
        appVersion: CURRENT_VERSION,
        onStatus: setStatus,
        onEvent: (e) => {
          eventCountRef.current += 1;
          setEvents((prev) => [...prev, e]);
          // `result` is the SDK's terminal message for a turn.
          if (e.type === "result" || e.type === "host_error") setBusy(false);
        },
        onPermission: setPermission,
        getHandlers: getWrappedHandlers,
      });
      connectingRef.current = false;
    })();

    // Only abandons an in-flight connect; an established one is kept.
    return () => {
      cancelled = true;
    };
  }, [visible, getWrappedHandlers]);

  // Unmount only — the window is going away, so take the session with it.
  useEffect(
    () => () => {
      clientRef.current?.close();
      clientRef.current = null;
    },
    []
  );

  // --- actions ------------------------------------------------------------

  const send = useCallback((text: string) => {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    // A new instruction starts a new iteration, so it earns its own
    // checkpoint even if the previous one never mutated anything.
    armedRef.current = true;
    eventCountRef.current += 1;
    setEvents((prev) => [
      ...prev,
      { type: "local_user", text: t } as unknown as AgentEvent,
    ]);
    clientRef.current?.send(t, depsRef.current.buildContext?.());
  }, []);

  const interrupt = useCallback(() => {
    clientRef.current?.interrupt();
    setBusy(false);
  }, []);

  const answerPermission = useCallback(
    (allow: boolean) => {
      if (!permission) return;
      clientRef.current?.answerPermission(permission.requestId, allow);
      setPermission(null);
    },
    [permission]
  );

  const clear = useCallback(() => {
    setEvents([]);
    setCheckpoints([]);
    eventCountRef.current = 0;
    iterationRef.current = 1;
    armedRef.current = true;
  }, []);

  return {
    status,
    events,
    permission,
    busy,
    checkpoints,
    send,
    interrupt,
    answerPermission,
    clear,
    restoreCheckpoint,
  };
}
