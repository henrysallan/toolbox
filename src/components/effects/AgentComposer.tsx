"use client";

// The assistant's prompt box (spec 080826_claude-agent-panel.md §UI).
// Shared verbatim by the docked panel and the floating overlay — the overlay
// IS this component at rest, with the transcript surface appearing above it
// only once something has been sent.
//
// Shape and keybinding match AiRecipePanel's composer (Cmd/Ctrl+Enter to
// submit) so the two feel like one feature.

import { useEffect, useRef, useState } from "react";
import type { AgentStatus } from "@/lib/agent-bridge";
import { Sparkle, pill, smallBtn } from "./agent-ui";

export interface AgentComposerProps {
  status: AgentStatus;
  /** Host reachable AND the Claude Code binary present. */
  ready: boolean;
  busy: boolean;
  onSend: (text: string) => void;
  onInterrupt: () => void;
  autoFocus?: boolean;
  placeholder?: string;
}

export default function AgentComposer({
  status,
  ready,
  busy,
  onSend,
  onInterrupt,
  autoFocus,
  placeholder = "Describe what you want to make…",
}: AgentComposerProps) {
  const [prompt, setPrompt] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!autoFocus) return;
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [autoFocus]);

  const submit = () => {
    const t = prompt.trim();
    if (!t || busy || !ready) return;
    onSend(t);
    setPrompt("");
  };

  return (
    <div
      style={{
        background: "var(--tb-n-2)",
        border: `1px solid ${busy ? "var(--tb-n-9)" : "var(--tb-n-7)"}`,
        borderRadius: 10,
        padding: 8,
      }}
    >
      <textarea
        ref={inputRef}
        placeholder={placeholder}
        value={prompt}
        disabled={!ready}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
          // Keep editor shortcuts from firing while typing a prompt.
          e.stopPropagation();
        }}
        spellCheck={false}
        rows={2}
        style={{
          width: "100%",
          boxSizing: "border-box",
          background: "transparent",
          border: "none",
          outline: "none",
          color: "var(--tb-n-16)",
          fontFamily: "inherit",
          fontSize: 12.5,
          lineHeight: 1.5,
          resize: "none",
          padding: 2,
          minHeight: 40,
          maxHeight: 140,
          opacity: ready ? 1 : 0.6,
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
        <div
          title={
            ready && status.state === "ready" && status.claudeVersion
              ? `${status.model} · Claude Code ${status.claudeVersion}`
              : "Model"
          }
          style={pill()}
        >
          <Sparkle color="var(--tb-a-violet-400)" />{" "}
          {ready && status.state === "ready" ? status.model : "—"}
        </div>
        <div style={{ flex: 1 }} />
        {busy ? (
          <button onClick={onInterrupt} style={smallBtn()}>
            Stop
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!ready || !prompt.trim()}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "5px 12px",
              borderRadius: 999,
              border: "none",
              background: "var(--tb-t-violet-l-2)",
              color: "var(--tb-t-magenta-d-0)",
              fontFamily: "inherit",
              fontSize: 11,
              fontWeight: 600,
              cursor: !ready || !prompt.trim() ? "default" : "pointer",
              opacity: !ready || !prompt.trim() ? 0.45 : 1,
            }}
          >
            <Sparkle color="var(--tb-t-magenta-d-0)" /> Send
          </button>
        )}
      </div>
    </div>
  );
}
