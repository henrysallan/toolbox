"use client";

import { useEffect, useRef, useState } from "react";
import type { AiProgress } from "@/lib/ai/ai-progress";

export interface AiRecipePanelProps {
  signedIn: boolean;
  // When set, the panel edits this existing group; otherwise it generates a new
  // recipe from scratch.
  editTarget?: { name: string } | null;
  // Prior edit turns for this group (edit mode), oldest first.
  transcript?: { instruction: string; summary: string }[];
  onClearTranscript?: () => void;
  // Generates (or edits) → builds → validates → applies, emitting live progress
  // (the validation loop + Claude's summarized thinking). Resolving { ok: true }
  // means it landed; { ok: false, message } keeps the composer up.
  onSubmit: (
    prompt: string,
    onProgress: (e: AiProgress) => void
  ) => Promise<{ ok: boolean; message?: string }>;
  onClose: () => void;
  onOpenPreferences: () => void;
}

// AI Recipe composer — lives in the params panel (paramView === "ai-recipe").
// Chat layout: header pinned top, scrollable transcript in the middle, composer
// stuck to the bottom. Two modes: generate a new group, or edit an existing one.
export default function AiRecipePanel({
  signedIn,
  editTarget,
  transcript,
  onClearTranscript,
  onSubmit,
  onClose,
  onOpenPreferences,
}: AiRecipePanelProps) {
  const editing = !!editTarget;
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<AiProgress[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const turns = editing ? transcript ?? [] : [];

  // Focus on mount (parent remounts via key across generate/edit/group).
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);

  // Keep the newest activity in view. DOM side-effect (not state).
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, progress.length, busy]);

  const submit = async () => {
    const trimmed = prompt.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    setProgress([]);
    try {
      const res = await onSubmit(trimmed, (e) => setProgress((p) => [...p, e]));
      if (!res.ok)
        setError(
          res.message ??
            (editing
              ? "Couldn't apply that edit — try rephrasing."
              : "Couldn't build a valid recipe — try rephrasing.")
        );
      else if (editing) setPrompt(""); // edit stays open; generate unmounts
    } catch (e) {
      setError((e as Error)?.message ?? "Failed.");
    } finally {
      setBusy(false);
    }
  };

  const keyHint = !!error && /api key|preferences/i.test(error);

  return (
    <div
      style={{
        height: "100%",
        width: "100%",
        boxSizing: "border-box",
        overflow: "hidden",
        background: "#0a0a0a",
        fontFamily: "ui-monospace, monospace",
        color: "#e5e7eb",
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
          borderBottom: "1px solid #18181b",
        }}
      >
        <div
          style={{
            color: "#a1a1aa",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: 1,
            display: "flex",
            alignItems: "center",
            gap: 6,
            minWidth: 0,
          }}
        >
          <Sparkle color="#a78bfa" />
          <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {editing ? `Edit · ${editTarget!.name}` : "AI Recipe"}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          {editing && turns.length > 0 && onClearTranscript && (
            <button
              onClick={onClearTranscript}
              style={{
                background: "transparent",
                border: "none",
                color: "#71717a",
                fontFamily: "inherit",
                fontSize: 10,
                textDecoration: "underline",
                cursor: "pointer",
                padding: 0,
              }}
            >
              clear
            </button>
          )}
          <button
            onClick={onClose}
            title="Close"
            style={{
              background: "transparent",
              border: "none",
              color: "#71717a",
              fontFamily: "inherit",
              fontSize: 14,
              cursor: "pointer",
              lineHeight: 1,
              padding: 2,
            }}
          >
            ×
          </button>
        </div>
      </div>

      {/* Transcript (only this scrolls) */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "10px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {turns.map((t, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div
              style={{
                alignSelf: "flex-end",
                maxWidth: "88%",
                padding: "5px 9px",
                borderRadius: 10,
                background: "#27272a",
                color: "#e5e7eb",
                fontSize: 11,
                lineHeight: 1.45,
              }}
            >
              {t.instruction}
            </div>
            <div
              style={{
                display: "flex",
                gap: 5,
                alignItems: "flex-start",
                color: "#a1a1aa",
                fontSize: 11,
                lineHeight: 1.45,
                paddingLeft: 2,
              }}
            >
              <span style={{ marginTop: 1, flexShrink: 0 }}>
                <Sparkle color="#a78bfa" />
              </span>
              <span>{t.summary}</span>
            </div>
          </div>
        ))}
        {progress.map((e, i) => {
          const last = i === progress.length - 1;
          if (e.kind === "request")
            return (
              <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", color: "#71717a", fontSize: 11 }}>
                {busy && last ? <Pulse /> : <span style={{ color: "#52525b" }}>→</span>}
                <span>Asking Claude{e.attempt > 1 ? ` · attempt ${e.attempt}` : ""}…</span>
              </div>
            );
          if (e.kind === "thinking")
            return (
              <div
                key={i}
                style={{
                  display: "flex",
                  gap: 6,
                  alignItems: "flex-start",
                  color: "#8b8b94",
                  fontSize: 10.5,
                  lineHeight: 1.55,
                  background: "#121212",
                  border: "1px solid #1c1c1c",
                  borderRadius: 8,
                  padding: "6px 8px",
                }}
              >
                <span style={{ flexShrink: 0, marginTop: 1 }}>💭</span>
                <span style={{ whiteSpace: "pre-wrap" }}>{e.text}</span>
              </div>
            );
          if (e.kind === "invalid")
            return (
              <div key={i} style={{ color: "#d97706", fontSize: 10.5, lineHeight: 1.45 }}>
                ✗ attempt {e.attempt}: {e.errors.length} issue{e.errors.length > 1 ? "s" : ""} — fixing
                <div style={{ color: "#71717a", paddingLeft: 12, marginTop: 2 }}>{e.errors[0]}</div>
              </div>
            );
          if (e.kind === "applied")
            return (
              <div key={i} style={{ color: "#22c55e", fontSize: 10.5 }}>
                ✓ applied{e.summary ? ` — ${e.summary}` : ""}
              </div>
            );
          return null;
        })}
        {busy && progress.length === 0 && (
          <div style={{ display: "flex", gap: 6, alignItems: "center", color: "#a78bfa", fontSize: 11 }}>
            <Pulse /> working…
          </div>
        )}
      </div>

      {/* Composer (pinned to bottom) */}
      <div
        style={{
          flexShrink: 0,
          padding: "8px 10px 10px",
          borderTop: "1px solid #18181b",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {error && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ color: "#ef4444", fontSize: 11, lineHeight: 1.5 }}>{error}</div>
            {keyHint && (
              <button onClick={onOpenPreferences} style={smallBtn()}>
                Open Preferences
              </button>
            )}
          </div>
        )}

        <div
          style={{
            background: "#141414",
            border: `1px solid ${busy ? "#3f3f46" : "#27272a"}`,
            borderRadius: 10,
            padding: 8,
          }}
        >
          <textarea
            ref={inputRef}
            placeholder={editing ? "Describe a change…" : "Describe a node group to generate…"}
            value={prompt}
            disabled={busy}
            onChange={(e) => {
              setPrompt(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
            spellCheck={false}
            rows={2}
            style={{
              width: "100%",
              boxSizing: "border-box",
              background: "transparent",
              border: "none",
              outline: "none",
              color: "#e5e7eb",
              fontFamily: "inherit",
              fontSize: 12.5,
              lineHeight: 1.5,
              resize: "none",
              padding: 2,
              minHeight: 40,
              maxHeight: 140,
              opacity: busy ? 0.6 : 1,
            }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
            <div
              title="Model"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                padding: "3px 8px",
                borderRadius: 999,
                border: "1px solid #27272a",
                background: "#18181b",
                color: "#d4d4d8",
                fontSize: 11,
                userSelect: "none",
              }}
            >
              <Sparkle color="#a78bfa" /> Claude Opus 4.8
            </div>
            <div style={{ flex: 1 }} />
            <button
              onClick={submit}
              disabled={busy || !prompt.trim()}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "5px 12px",
                borderRadius: 999,
                border: "none",
                background: "#ede9fe",
                color: "#3b0764",
                fontFamily: "inherit",
                fontSize: 11,
                fontWeight: 600,
                cursor: busy || !prompt.trim() ? "default" : "pointer",
                opacity: busy || !prompt.trim() ? 0.45 : 1,
              }}
            >
              <Sparkle color="#3b0764" /> {busy ? (editing ? "Applying…" : "Generating…") : editing ? "Apply" : "Generate"}
            </button>
          </div>
        </div>

        {!signedIn && (
          <div style={{ color: "#a16207", fontSize: 10.5, lineHeight: 1.5 }}>
            Sign in and add a Claude API key in{" "}
            <button
              onClick={onOpenPreferences}
              style={{
                background: "transparent",
                border: "none",
                color: "#d4d4d8",
                fontFamily: "inherit",
                fontSize: 10.5,
                textDecoration: "underline",
                cursor: "pointer",
                padding: 0,
              }}
            >
              Preferences
            </button>{" "}
            to use your own quota.
          </div>
        )}
      </div>
    </div>
  );
}

function smallBtn(): React.CSSProperties {
  return {
    alignSelf: "flex-start",
    padding: "4px 10px",
    background: "transparent",
    border: "1px solid #3f3f46",
    color: "#e5e7eb",
    fontFamily: "inherit",
    fontSize: 11,
    borderRadius: 3,
    cursor: "pointer",
  };
}

function Sparkle({ color }: { color: string }) {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill={color} aria-hidden>
      <path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2z" />
    </svg>
  );
}

function Pulse() {
  return (
    <span
      style={{
        display: "inline-block",
        width: 7,
        height: 7,
        borderRadius: 999,
        background: "#7c3aed",
        animation: "aiRecipePulse 1s ease-in-out infinite",
      }}
    >
      <style>{`@keyframes aiRecipePulse{0%,100%{opacity:.35}50%{opacity:1}}`}</style>
    </span>
  );
}
