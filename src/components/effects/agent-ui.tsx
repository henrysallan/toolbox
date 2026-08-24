"use client";

// Shared visual primitives for the assistant surfaces (spec
// 080826_claude-agent-panel.md §UI). The docked panel and the floating
// overlay are SHELLS around the same transcript and composer — these are the
// bits both need, kept in one place so the two can't drift.
//
// Deliberately the same vocabulary as AiRecipePanel (violet Sparkle, the
// --tb-n-* ramp, pill buttons): the assistant should read as the same feature
// family as AI Recipe, not a second dialect.

import type { CSSProperties } from "react";
import { agentEnvironment, type AgentStatus } from "@/lib/agent-bridge";

/**
 * Both shells need the same answer to "can the user type yet, and if not,
 * why?". Connected to the host is NOT enough — the host drives the user's
 * installed Claude Code CLI, so a missing binary means there is nothing to
 * send to.
 */
export function agentReadiness(status: AgentStatus): {
  ready: boolean;
  line: string;
} {
  switch (status.state) {
    case "ready":
      return {
        ready: !!status.claudeBin,
        line: status.binaryMessage ?? status.model,
      };
    // "off" and "no-host" get the same explanation: a hosted visitor never
    // even probes, so their status stays "off".
    case "off":
    case "no-host": {
      // "Run npm run agent" is a DEVELOPER instruction and is nonsense to a
      // web visitor, who has no repo and no terminal in the relevant sense.
      const env = agentEnvironment();
      if (env === "hosted")
        return {
          ready: false,
          line:
            "The assistant runs Claude on your own machine, so it needs the " +
            "Toolbox desktop app — it can't run in a hosted browser tab.",
        };
      if (env === "native")
        return {
          ready: false,
          line:
            status.state === "off"
              ? "Starting the assistant…"
              : "The assistant host didn't start. Restarting Toolbox usually fixes it.",
        };
      return {
        ready: false,
        line:
          status.state === "off"
            ? "Starting the assistant…"
            : "Agent host isn't running — start it with `npm run agent`.",
      };
    }
    case "denied":
      return { ready: false, line: status.reason };
    case "connecting":
      return { ready: false, line: "connecting…" };
    default:
      return { ready: false, line: "off" };
  }
}

export function Sparkle({ color }: { color: string }) {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill={color} aria-hidden>
      <path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2z" />
    </svg>
  );
}

export function Pulse() {
  return (
    <span
      style={{
        display: "inline-block",
        width: 7,
        height: 7,
        borderRadius: 999,
        background: "#7c3aed",
        animation: "agentPulse 1s ease-in-out infinite",
      }}
    >
      <style>{`@keyframes agentPulse{0%,100%{opacity:.35}50%{opacity:1}}`}</style>
    </span>
  );
}

export function bubble(): CSSProperties {
  return {
    alignSelf: "flex-end",
    maxWidth: "88%",
    padding: "5px 9px",
    borderRadius: 10,
    background: "var(--tb-n-7)",
    color: "var(--tb-n-16)",
    fontSize: 11,
    lineHeight: 1.45,
  };
}

export function prose(): CSSProperties {
  return {
    display: "flex",
    gap: 5,
    alignItems: "flex-start",
    color: "var(--tb-n-13)",
    fontSize: 11,
    lineHeight: 1.45,
    paddingLeft: 2,
  };
}

/** A tool call, styled like an inspector row rather than a log line. */
export function chip(): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    maxWidth: "100%",
    padding: "3px 8px",
    borderRadius: 7,
    border: "1px solid var(--tb-n-4)",
    background: "var(--tb-n-2)",
    fontSize: 10.5,
    minWidth: 0,
  };
}

export function resultRow(): CSSProperties {
  return {
    color: "var(--tb-n-11)",
    fontSize: 10.5,
    paddingLeft: 12,
    lineHeight: 1.45,
  };
}

export function pill(): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 5,
    padding: "3px 8px",
    borderRadius: 999,
    border: "1px solid var(--tb-n-7)",
    background: "var(--tb-n-3)",
    color: "var(--tb-n-15)",
    fontSize: 11,
    userSelect: "none",
  };
}

export function smallBtn(): CSSProperties {
  return {
    padding: "4px 10px",
    background: "transparent",
    border: "1px solid var(--tb-n-9)",
    color: "var(--tb-n-16)",
    fontFamily: "inherit",
    fontSize: 11,
    borderRadius: 3,
    cursor: "pointer",
  };
}

export function linkBtn(): CSSProperties {
  return {
    background: "transparent",
    border: "none",
    color: "var(--tb-n-11)",
    fontFamily: "inherit",
    fontSize: 10,
    textDecoration: "underline",
    cursor: "pointer",
    padding: 0,
  };
}

export function closeBtn(): CSSProperties {
  return {
    background: "transparent",
    border: "none",
    color: "var(--tb-n-11)",
    fontFamily: "inherit",
    fontSize: 14,
    cursor: "pointer",
    lineHeight: 1,
    padding: 2,
  };
}

export function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Bare tool name — the SDK prefixes in-process MCP tools. */
export function bareTool(name: string) {
  return name.replace(/^mcp__toolbox__/, "");
}
