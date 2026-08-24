"use client";

// Floating assistant shell (spec 080826_claude-agent-panel.md §UI, entry 2).
//
// The "ask for something without rearranging my workspace" surface: opened
// from the pie menu or the Edit menu, centred horizontally and anchored near
// the bottom so it reads as sitting ON TOP of the timeline rather than docked
// into it.
//
// At rest it is just the composer. A response surface appears above it on the
// first send, opens at a base height, expands to ~1.5× once messages actually
// arrive, and scrolls beyond that — it never grows to fill the screen, because
// the point of this surface is to stay heads-up. The docked panel is where you
// go to watch a long run.
//
// Dismissing does NOT end the session (that lives above both shells in
// useAgentSession) — reopening, here or in the panel, finds the work still
// running.

import { useEffect, useRef } from "react";
import type { AgentEvent, AgentPermissionRequest, AgentStatus } from "@/lib/agent-bridge";
import AgentComposer from "./AgentComposer";
import AgentTranscript from "./AgentTranscript";
import type { AgentCheckpoint } from "./useAgentSession";
import { Sparkle, agentReadiness, closeBtn } from "./agent-ui";

export interface AgentOverlayProps {
  status: AgentStatus;
  events: AgentEvent[];
  permission: AgentPermissionRequest | null;
  busy: boolean;
  onSend: (text: string) => void;
  onInterrupt: () => void;
  onAnswerPermission: (allow: boolean) => void;
  checkpoints?: AgentCheckpoint[];
  onRestore?: (id: string) => void;
  onClose: () => void;
  /** Switch to the docked panel, carrying the session across. */
  onExpandToPanel: () => void;
}

const WIDTH = 560;
const BASE_H = 180;
const EXPANDED_H = Math.round(BASE_H * 1.5);

export default function AgentOverlay({
  status,
  events,
  permission,
  busy,
  onSend,
  onInterrupt,
  onAnswerPermission,
  checkpoints,
  onRestore,
  onClose,
  onExpandToPanel,
}: AgentOverlayProps) {
  const { ready, line } = agentReadiness(status);
  const rootRef = useRef<HTMLDivElement>(null);

  // Anything sent at all → the surface exists. Anything came BACK → expand.
  const hasSent = events.length > 0;
  const hasReply = events.some((e) => e.type !== "local_user");
  const surfaceH = hasReply || permission ? EXPANDED_H : BASE_H;

  // Escape closes. Capture phase so it beats editor-level Escape handlers,
  // and only when the overlay owns the keystroke.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Click outside dismisses. Pointerdown (not click) so it fires before the
  // canvas starts a drag underneath.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);

  return (
    <div
      ref={rootRef}
      style={{
        position: "absolute",
        left: "50%",
        transform: "translateX(-50%)",
        // Clear of the timeline rather than flush against it.
        bottom: 96,
        width: WIDTH,
        maxWidth: "calc(100vw - 48px)",
        zIndex: 60,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        fontFamily: "var(--ui-font)",
        color: "var(--tb-n-16)",
      }}
    >
      {(hasSent || !ready) && (
        <div
          style={{
            height: surfaceH,
            display: "flex",
            flexDirection: "column",
            background: "var(--tb-n-0)",
            border: "1px solid var(--tb-n-4)",
            borderRadius: 12,
            overflow: "hidden",
            boxShadow: "0 12px 32px rgba(0,0,0,0.32)",
            transition: "height 140ms ease",
          }}
        >
          <div
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "7px 9px 5px",
              borderBottom: "1px solid var(--tb-n-3)",
              color: "var(--tb-n-13)",
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: 1,
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Sparkle color="var(--tb-a-violet-400)" /> Assistant
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                onClick={onExpandToPanel}
                title="Open in the params panel"
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--tb-n-11)",
                  fontFamily: "inherit",
                  fontSize: 10,
                  textTransform: "none",
                  letterSpacing: 0,
                  textDecoration: "underline",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                open panel
              </button>
              <button onClick={onClose} title="Close" style={closeBtn()}>
                ×
              </button>
            </span>
          </div>

          <AgentTranscript
            events={events}
            permission={permission}
            busy={busy}
            onAnswerPermission={onAnswerPermission}
            placeholder={ready ? null : line}
            checkpoints={checkpoints}
            onRestore={onRestore}
            dense
          />
        </div>
      )}

      <div style={{ boxShadow: "0 12px 32px rgba(0,0,0,0.32)", borderRadius: 10 }}>
        <AgentComposer
          status={status}
          ready={ready}
          busy={busy}
          onSend={onSend}
          onInterrupt={onInterrupt}
          autoFocus
          placeholder="Describe what you want to make…"
        />
      </div>
    </div>
  );
}
