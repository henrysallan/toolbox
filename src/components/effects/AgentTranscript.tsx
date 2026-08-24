"use client";

// The assistant's event stream, rendered natively (spec
// 080826_claude-agent-panel.md §Rendering the stream). Shared by the docked
// panel and the floating overlay — neither owns any of this.
//
// Message shapes here are as OBSERVED from the SDK, not as documented. Two
// that matter: tool *results* arrive as `user` messages carrying
// `tool_use_result` (there is no `tool_result` type), and `system` carries a
// `subtype` that is mostly hook chatter and must be filtered rather than shown.

import { useEffect, useRef } from "react";
import type { AgentEvent, AgentPermissionRequest } from "@/lib/agent-bridge";
import type { AgentCheckpoint } from "./useAgentSession";
import {
  Pulse,
  Sparkle,
  bareTool,
  bubble,
  chip,
  prose,
  resultRow,
  smallBtn,
  truncate,
} from "./agent-ui";

export interface AgentTranscriptProps {
  events: AgentEvent[];
  permission: AgentPermissionRequest | null;
  busy: boolean;
  onAnswerPermission: (allow: boolean) => void;
  /** Shown when there is nothing yet (host status, install prompt, …). */
  placeholder?: string | null;
  /** Compact spacing for the overlay's smaller surface. */
  dense?: boolean;
  /** Rewind points, rendered inline where they were taken (M3). */
  checkpoints?: AgentCheckpoint[];
  onRestore?: (id: string) => void;
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
  content?: unknown;
  tool_use_id?: string;
  source?: { type?: string; media_type?: string; data?: string };
  data?: string;
  mimeType?: string;
}

function blocksOf(e: AgentEvent): ContentBlock[] {
  const m = e.message as { content?: ContentBlock[] } | undefined;
  return Array.isArray(m?.content) ? m.content : [];
}

/** Pull any inline images out of a tool result, whichever shape they take. */
function imagesOf(blocks: ContentBlock[]): string[] {
  const out: string[] = [];
  const visit = (b: ContentBlock) => {
    if (b.type === "image") {
      // Anthropic block form, and the flatter {data, mimeType} the MCP layer uses.
      const data = b.source?.data ?? b.data;
      const mime = b.source?.media_type ?? b.mimeType ?? "image/png";
      if (data) out.push(`data:${mime};base64,${data}`);
    }
    if (Array.isArray(b.content)) for (const c of b.content as ContentBlock[]) visit(c);
  };
  for (const b of blocks) visit(b);
  return out;
}

/** One-line gist of a tool call's arguments. */
function summarizeInput(tool: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  if (tool === "insert_recipe") {
    const r = o.recipe as { name?: string; nodes?: unknown[] } | undefined;
    const n = Array.isArray(r?.nodes) ? r!.nodes.length : 0;
    return `${r?.name ?? "recipe"}${n ? ` · ${n} nodes` : ""}`;
  }
  if (tool === "set_param")
    return `${o.nodeId ?? "?"}.${o.param ?? "?"} = ${formatValue(o.value)}`;
  if (tool === "edit_group") {
    const ops = Array.isArray(o.ops) ? o.ops.length : 0;
    return `${o.groupId ?? "?"} · ${ops} op${ops === 1 ? "" : "s"}`;
  }
  if (tool === "set_keyframes") {
    const keys = Array.isArray(o.keys) ? o.keys.length : 0;
    return `${o.nodeId ?? "?"}.${o.param ?? "?"} · ${keys} key${keys === 1 ? "" : "s"}`;
  }
  if (tool === "transport")
    return `${o.action ?? ""}${o.frame !== undefined ? ` ${o.frame}` : ""}`;
  if (tool === "screenshot" || tool === "screenshot_strip")
    return o.nodeId ? String(o.nodeId) : o.frame !== undefined ? `f${o.frame}` : "";
  for (const k of ["nodeId", "groupId", "param", "scope", "type"])
    if (typeof o[k] === "string") return String(o[k]);
  return "";
}

function formatValue(v: unknown): string {
  if (typeof v === "number") return String(Math.round(v * 1000) / 1000);
  if (typeof v === "string") return truncate(v, 24);
  if (Array.isArray(v)) return `[${v.length}]`;
  if (v && typeof v === "object") return "{…}";
  return String(v);
}

export default function AgentTranscript({
  events,
  permission,
  busy,
  onAnswerPermission,
  placeholder,
  dense,
  checkpoints,
  onRestore,
}: AgentTranscriptProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // eventIndex → checkpoint, so the rail renders where it was taken.
  const railAt = new Map<number, AgentCheckpoint>();
  for (const c of checkpoints ?? []) railAt.set(c.eventIndex, c);

  // Keep the newest activity in view. DOM side-effect (not state).
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length, busy, permission]);

  // tool_use id → name, so a result can be labelled by what asked for it.
  const toolNames = new Map<string, string>();
  for (const e of events)
    if (e.type === "assistant")
      for (const b of blocksOf(e))
        if (b.type === "tool_use" && b.id && b.name)
          toolNames.set(b.id, bareTool(b.name));

  return (
    <div
      ref={scrollRef}
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        padding: dense ? 8 : 10,
        display: "flex",
        flexDirection: "column",
        gap: dense ? 6 : 8,
      }}
    >
      {placeholder && (
        <div style={{ color: "var(--tb-n-11)", fontSize: 11, lineHeight: 1.5 }}>
          {placeholder}
        </div>
      )}

      {events.map((e, i) => {
        const cp = railAt.get(i);
        const rail = cp ? (
          <div
            key={`cp${i}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              margin: "2px 0",
              color: "var(--tb-n-10)",
              fontSize: 10,
            }}
          >
            <span style={{ height: 1, flex: 1, background: "var(--tb-n-4)" }} />
            <span style={{ whiteSpace: "nowrap" }}>{cp.label}</span>
            {onRestore && (
              <button
                onClick={() => onRestore(cp.id)}
                title="Restore the graph to this point and trim the transcript"
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--tb-n-12)",
                  fontFamily: "inherit",
                  fontSize: 10,
                  textDecoration: "underline",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                revert
              </button>
            )}
            <span style={{ height: 1, flex: 1, background: "var(--tb-n-4)" }} />
          </div>
        ) : null;

        const body = (() => {
        if (e.type === "local_user")
          return (
            <div key={i} style={bubble()}>
              {String(e.text ?? "")}
            </div>
          );

        if (e.type === "assistant") {
          const out: React.ReactNode[] = [];
          for (const [j, b] of blocksOf(e).entries()) {
            if (b.type === "text" && b.text?.trim())
              out.push(
                <div key={`x${j}`} style={prose()}>
                  <span style={{ marginTop: 1, flexShrink: 0 }}>
                    <Sparkle color="var(--tb-a-violet-400)" />
                  </span>
                  <span style={{ whiteSpace: "pre-wrap" }}>{b.text}</span>
                </div>
              );
            if (b.type === "tool_use") {
              const name = bareTool(String(b.name ?? "?"));
              const gist = summarizeInput(name, b.input);
              out.push(
                <div key={`t${j}`} style={chip()}>
                  <span style={{ color: "var(--tb-a-violet-400)", flexShrink: 0 }}>
                    <Sparkle color="var(--tb-a-violet-400)" />
                  </span>
                  <span style={{ color: "var(--tb-n-15)", flexShrink: 0 }}>{name}</span>
                  {gist && (
                    <span
                      title={gist}
                      style={{
                        color: "var(--tb-n-11)",
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {gist}
                    </span>
                  )}
                </div>
              );
            }
          }
          return out.length ? <div key={i} style={{ display: "contents" }}>{out}</div> : null;
        }

        // Tool results ride on `user` messages.
        if (e.type === "user") {
          const blocks = blocksOf(e);
          const imgs = imagesOf(blocks);
          if (imgs.length)
            return (
              <div key={i} style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingLeft: 12 }}>
                {imgs.map((src, k) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={k}
                    src={src}
                    alt="render"
                    style={{
                      maxWidth: dense ? 120 : 180,
                      maxHeight: dense ? 90 : 140,
                      borderRadius: 6,
                      border: "1px solid var(--tb-n-4)",
                      display: "block",
                    }}
                  />
                ))}
              </div>
            );
          const texts = blocks
            .flatMap((b) => (Array.isArray(b.content) ? (b.content as ContentBlock[]) : []))
            .filter((b) => b.type === "text");
          const first = texts[0]?.text ?? "";
          const who = blocks.find((b) => b.tool_use_id)?.tool_use_id;
          const label = who ? toolNames.get(who) : undefined;
          if (!first.trim()) return null;
          return (
            <div key={i} style={resultRow()}>
              {label ? `${label}: ` : ""}
              {truncate(first.trim(), dense ? 90 : 160)}
            </div>
          );
        }

        if (e.type === "rate_limit_event") {
          const info = e.rate_limit_info as { status?: string; resetsAt?: string } | undefined;
          if (!info?.status || info.status === "allowed") return null;
          return (
            <div key={i} style={{ color: "#d97706", fontSize: 10.5, lineHeight: 1.45 }}>
              rate limit: {info.status}
              {info.resetsAt ? ` — resets ${info.resetsAt}` : ""}
            </div>
          );
        }

        if (e.type === "result") {
          const turns = e.num_turns as number | undefined;
          const ms = e.duration_ms as number | undefined;
          return (
            <div key={i} style={{ color: "var(--tb-n-10)", fontSize: 10, paddingTop: 2 }}>
              done{turns ? ` · ${turns} turns` : ""}
              {ms ? ` · ${(ms / 1000).toFixed(1)}s` : ""}
            </div>
          );
        }

        if (e.type === "host_error")
          return (
            <div key={i} style={{ color: "var(--tb-a-red-500)", fontSize: 11, lineHeight: 1.45 }}>
              {String(e.message ?? "Host error.")}
            </div>
          );

        return null;
        })();

        if (!rail) return body;
        // A checkpoint sits immediately before the event it protects.
        return (
          <div key={`w${i}`} style={{ display: "contents" }}>
            {rail}
            {body}
          </div>
        );
      })}

      {busy && (
        <div
          style={{
            display: "flex",
            gap: 6,
            alignItems: "center",
            color: "var(--tb-a-violet-400)",
            fontSize: 11,
          }}
        >
          <Pulse /> working…
        </div>
      )}

      {permission && (
        <div
          style={{
            border: "1px solid var(--tb-n-7)",
            background: "var(--tb-n-2)",
            borderRadius: 8,
            padding: 8,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <div style={{ fontSize: 11, lineHeight: 1.45 }}>
            {permission.title ??
              `Allow ${permission.displayName ?? permission.toolName}?`}
          </div>
          {permission.description && (
            <div style={{ fontSize: 10.5, color: "var(--tb-n-11)", lineHeight: 1.45 }}>
              {permission.description}
            </div>
          )}
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => onAnswerPermission(true)} style={smallBtn()}>
              Allow
            </button>
            <button onClick={() => onAnswerPermission(false)} style={smallBtn()}>
              Deny
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
