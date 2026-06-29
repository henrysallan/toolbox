"use client";

import { useEffect, useRef, useState } from "react";

export interface AiRecipePanelProps {
  signedIn: boolean;
  // When set, the panel edits this existing group; otherwise it generates a new
  // recipe from scratch.
  editTarget?: { name: string } | null;
  // Generates (or edits) → builds → validates → applies. Resolving { ok: true }
  // means it landed and the parent switches the panel to the node view;
  // { ok: false, message } keeps the composer up with the message.
  onSubmit: (prompt: string) => Promise<{ ok: boolean; message?: string }>;
  onClose: () => void;
  onOpenPreferences: () => void;
}

const GEN_EXAMPLES = [
  "halftone dots driven by image luminance",
  "scatter circles on a grid, then stroke them",
  "rgb-split / chromatic aberration on an image",
  "concentric rings from a point lattice",
];
const EDIT_EXAMPLES = [
  "make the dots bigger",
  "add a blur before the output",
  "double the point count",
  "expose the rotation as a knob",
];

// AI Recipe composer — lives in the params panel (paramView === "ai-recipe").
// Two modes: generate a new group, or edit an existing one (editTarget set).
export default function AiRecipePanel({
  signedIn,
  editTarget,
  onSubmit,
  onClose,
  onOpenPreferences,
}: AiRecipePanelProps) {
  const editing = !!editTarget;
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // State resets across generate/edit/different-group are handled by a `key`
  // on the parent (remount), so this only needs to focus on mount.
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);

  const submit = async () => {
    const trimmed = prompt.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await onSubmit(trimmed);
      if (!res.ok)
        setError(
          res.message ??
            (editing
              ? "Couldn't apply that edit — try rephrasing."
              : "Couldn't build a valid recipe — try rephrasing.")
        );
      else if (editing) {
        // Edit keeps the panel open for iterative refinement; clear the box.
        setPrompt("");
      }
      // Generate success: the parent flips paramView to "node"; panel unmounts.
    } catch (e) {
      setError((e as Error)?.message ?? "Failed.");
    } finally {
      setBusy(false);
    }
  };

  const examples = editing ? EDIT_EXAMPLES : GEN_EXAMPLES;
  const keyHint = !!error && /api key|preferences/i.test(error);

  return (
    <div
      style={{
        height: "100%",
        width: "100%",
        boxSizing: "border-box",
        overflowY: "auto",
        background: "#0a0a0a",
        fontFamily: "ui-monospace, monospace",
        color: "#e5e7eb",
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div
          style={{
            color: "#a1a1aa",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: 1,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <Sparkle color="#a78bfa" /> {editing ? "Edit with AI" : "AI Recipe"}
        </div>
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

      {/* Context chip (edit mode) */}
      {editing && (
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            alignSelf: "flex-start",
            padding: "3px 8px",
            borderRadius: 999,
            border: "1px solid #3f3f46",
            background: "#18181b",
            color: "#d4d4d8",
            fontSize: 11,
          }}
        >
          <Sparkle color="#a78bfa" /> Editing: {editTarget!.name}
        </div>
      )}

      <div style={{ color: "#71717a", fontSize: 11, lineHeight: 1.5 }}>
        {editing
          ? "Describe a change to this group. It's applied, validated, and fully undo-able."
          : "Describe a node group in plain words. It's assembled from existing nodes, validated, and dropped on the canvas."}
      </div>

      {/* Composer card */}
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
          rows={3}
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
            resize: "vertical",
            padding: 2,
            minHeight: 56,
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
            {busy ? (
              <>
                <Pulse /> {editing ? "Applying…" : "Generating…"}
              </>
            ) : (
              <>
                <Sparkle color="#3b0764" /> {editing ? "Apply" : "Generate"}
              </>
            )}
          </button>
        </div>
      </div>

      {/* Status / error */}
      {busy && (
        <div style={{ color: "#a78bfa", fontSize: 11 }}>
          {editing ? "applying + validating the edit…" : "generating + validating recipe…"} this can
          take a few seconds.
        </div>
      )}
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

      {!signedIn && !busy && (
        <div style={{ color: "#a16207", fontSize: 10.5, lineHeight: 1.5 }}>
          Tip: sign in and add a Claude API key in{" "}
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

      {/* Examples */}
      <div style={{ marginTop: 2 }}>
        <div
          style={{
            color: "#52525b",
            fontSize: 9.5,
            textTransform: "uppercase",
            letterSpacing: 1,
            marginBottom: 6,
          }}
        >
          Try
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {examples.map((ex) => (
            <button
              key={ex}
              onClick={() => {
                if (busy) return;
                setPrompt(ex);
                inputRef.current?.focus();
              }}
              style={{
                textAlign: "left",
                padding: "4px 8px",
                borderRadius: 6,
                border: "1px solid #27272a",
                background: "#141414",
                color: "#a1a1aa",
                fontFamily: "inherit",
                fontSize: 10.5,
                cursor: busy ? "default" : "pointer",
                lineHeight: 1.4,
              }}
            >
              {ex}
            </button>
          ))}
        </div>
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
