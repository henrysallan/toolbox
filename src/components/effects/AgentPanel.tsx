"use client";

// Docked assistant shell (spec 080826_claude-agent-panel.md §UI, entry 1).
//
// One of TWO shells over the same session — the other is AgentOverlay. Both
// render AgentTranscript + AgentComposer; neither owns transcript state, so
// switching between them mid-run shows the same conversation still going.
//
// Layout is AiRecipePanel's three bands verbatim: pinned header, scrolling
// middle, composer stuck to the bottom.

import type { AgentEvent, AgentPermissionRequest, AgentStatus } from "@/lib/agent-bridge";
import AgentComposer from "./AgentComposer";
import AgentTranscript from "./AgentTranscript";
import type { AgentCheckpoint } from "./useAgentSession";
import { Sparkle, agentReadiness, closeBtn, linkBtn } from "./agent-ui";

export interface AgentPanelProps {
  status: AgentStatus;
  events: AgentEvent[];
  permission: AgentPermissionRequest | null;
  busy: boolean;
  onSend: (text: string) => void;
  onInterrupt: () => void;
  onAnswerPermission: (allow: boolean) => void;
  onClear: () => void;
  checkpoints?: AgentCheckpoint[];
  onRestore?: (id: string) => void;
  /** Params-panel host only — a tiled panel is closed via its kind menu. */
  onClose?: () => void;
  /** Tiled-panel host only — the kind chip, rendered inline in the header. */
  kindMenu?: React.ReactNode;
}

export default function AgentPanel({
  status,
  events,
  permission,
  busy,
  onSend,
  onInterrupt,
  onAnswerPermission,
  onClear,
  checkpoints,
  onRestore,
  onClose,
  kindMenu,
}: AgentPanelProps) {
  const { ready, line } = agentReadiness(status);

  return (
    <div
      style={{
        height: "100%",
        width: "100%",
        boxSizing: "border-box",
        overflow: "hidden",
        background: "var(--tb-n-0)",
        fontFamily: "var(--ui-font)",
        color: "var(--tb-n-16)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header (pinned) */}
      <div
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "10px 10px 8px",
          borderBottom: "1px solid var(--tb-n-3)",
        }}
      >
        <div
          style={{
            color: "var(--tb-n-13)",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: 1,
            display: "flex",
            alignItems: "center",
            gap: 6,
            minWidth: 0,
          }}
        >
          {kindMenu ?? <Sparkle color="var(--tb-a-violet-400)" />}
          {!kindMenu && <span>Assistant</span>}
          <span
            title={line}
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              flexShrink: 0,
              background: ready
                ? "var(--tb-a-green-500)"
                : status.state === "connecting"
                  ? "var(--tb-a-violet-400)"
                  : "var(--tb-n-9)",
            }}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          {events.length > 0 && (
            <button onClick={onClear} style={linkBtn()}>
              clear
            </button>
          )}
          {onClose && (
            <button onClick={onClose} title="Close" style={closeBtn()}>
              ×
            </button>
          )}
        </div>
      </div>

      <AgentTranscript
        events={events}
        permission={permission}
        busy={busy}
        onAnswerPermission={onAnswerPermission}
        placeholder={ready ? null : line}
        checkpoints={checkpoints}
        onRestore={onRestore}
      />

      {/* Composer (pinned to bottom) */}
      <div
        style={{
          flexShrink: 0,
          padding: "8px 10px 10px",
          borderTop: "1px solid var(--tb-n-3)",
        }}
      >
        <AgentComposer
          status={status}
          ready={ready}
          busy={busy}
          onSend={onSend}
          onInterrupt={onInterrupt}
          autoFocus
        />
      </div>
    </div>
  );
}
