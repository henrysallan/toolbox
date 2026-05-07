"use client";

import { useEffect, useState } from "react";
import {
  loadUserPreferences,
  saveUserPreferences,
  testHuggingFaceToken,
  testOpenAIKey,
} from "@/lib/supabase/user-preferences";

export interface UserPreferencesModalProps {
  open: boolean;
  signedIn: boolean;
  onClose: () => void;
  // Fired after a successful save so the parent can refresh its
  // cached preferences (used by the Image Generate node and any
  // future AI-driven nodes that need the key in-hand).
  onSaved?: () => void;
}

// Editor-wide preferences. Hosts:
//  - OpenAI API key  → Image Generate node + future AI nodes
//  - HuggingFace token → optional, unlocks gated transformers.js
//                        models (e.g. briaai/RMBG-2.0). Non-gated
//                        models work without it.
//
// Each field uses the same masked-input + show/hide + test +
// last-4-tail placeholder UX, factored into <KeyField/>.
export default function UserPreferencesModal({
  open,
  signedIn,
  onClose,
  onSaved,
}: UserPreferencesModalProps) {
  const [openaiKey, setOpenaiKey] = useState("");
  const [openaiSavedTail, setOpenaiSavedTail] = useState<string | null>(null);
  const [openaiDirty, setOpenaiDirty] = useState(false);

  const [hfToken, setHfToken] = useState("");
  const [hfSavedTail, setHfSavedTail] = useState<string | null>(null);
  const [hfDirty, setHfDirty] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // (Re)load preferences whenever the modal opens.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setOpenaiDirty(false);
    setHfDirty(false);
    if (!signedIn) {
      setOpenaiKey("");
      setOpenaiSavedTail(null);
      setHfToken("");
      setHfSavedTail(null);
      return;
    }
    setLoading(true);
    loadUserPreferences()
      .then((prefs) => {
        const ok = prefs.openaiApiKey ?? "";
        const hk = prefs.huggingfaceToken ?? "";
        setOpenaiKey(ok);
        setOpenaiSavedTail(ok ? ok.slice(-4) : null);
        setHfToken(hk);
        setHfSavedTail(hk ? hk.slice(-4) : null);
      })
      .finally(() => setLoading(false));
  }, [open, signedIn]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const submit = async () => {
    if (!signedIn || saving) return;
    setSaving(true);
    setError(null);
    const trimmedOpenai = openaiKey.trim();
    const trimmedHf = hfToken.trim();
    const res = await saveUserPreferences({
      openaiApiKey: trimmedOpenai === "" ? null : trimmedOpenai,
      huggingfaceToken: trimmedHf === "" ? null : trimmedHf,
    });
    setSaving(false);
    if (!res.ok) {
      setError(res.error ?? "Save failed");
      return;
    }
    onSaved?.();
    onClose();
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.65)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 2000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          minWidth: 480,
          maxWidth: 540,
          background: "#18181b",
          border: "1px solid #27272a",
          borderRadius: 6,
          padding: 16,
          fontFamily: "ui-monospace, monospace",
          fontSize: 12,
          color: "#e5e7eb",
          boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
          maxHeight: "85vh",
          overflowY: "auto",
        }}
      >
        <div
          style={{
            marginBottom: 12,
            color: "#a1a1aa",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: 1,
          }}
        >
          User Preferences
        </div>

        {!signedIn && (
          <div
            style={{
              padding: 10,
              border: "1px solid #b45309",
              background: "rgba(180, 83, 9, 0.1)",
              color: "#fde68a",
              borderRadius: 4,
              marginBottom: 12,
              lineHeight: 1.5,
            }}
          >
            Sign in to save preferences. Your settings are stored on
            the account so they follow you across devices.
          </div>
        )}

        <KeyField
          label="OpenAI API Key"
          description="Used by AI-driven nodes (Image Generate). Stored on your account; only ever sent directly to OpenAI from your browser. Leave blank to clear."
          placeholder="sk-…"
          value={openaiKey}
          savedTail={openaiSavedTail}
          dirty={openaiDirty}
          onChange={(v) => {
            setOpenaiKey(v);
            setOpenaiDirty(true);
          }}
          onTest={() => testOpenAIKey(openaiKey)}
          disabled={!signedIn || loading}
          enterToSave={submit}
        />

        <div style={{ height: 14 }} />

        <KeyField
          label="HuggingFace Token (optional)"
          description="Required only for GATED transformers.js models like briaai/RMBG-2.0. The non-gated rmbg-1.4 works without it. Get a Read token at huggingface.co/settings/tokens after accepting the model's license."
          placeholder="hf_…"
          value={hfToken}
          savedTail={hfSavedTail}
          dirty={hfDirty}
          onChange={(v) => {
            setHfToken(v);
            setHfDirty(true);
          }}
          onTest={() => testHuggingFaceToken(hfToken)}
          disabled={!signedIn || loading}
          enterToSave={submit}
        />

        {error && (
          <div
            style={{
              color: "#ef4444",
              fontSize: 11,
              marginTop: 12,
              marginBottom: 4,
            }}
          >
            {error}
          </div>
        )}

        <div
          style={{
            display: "flex",
            gap: 6,
            justifyContent: "flex-end",
            marginTop: 14,
          }}
        >
          <button onClick={onClose} style={btnStyle()}>
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!signedIn || saving || loading}
            style={{
              ...btnStyle(),
              background: "#16a34a",
              border: "1px solid #16a34a",
              color: "#dcfce7",
              opacity: !signedIn || saving || loading ? 0.5 : 1,
            }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// One masked-input + test-button row. Same UX shared between the
// OpenAI and HuggingFace fields.
function KeyField({
  label,
  description,
  placeholder,
  value,
  savedTail,
  dirty,
  onChange,
  onTest,
  disabled,
  enterToSave,
}: {
  label: string;
  description: string;
  placeholder: string;
  value: string;
  savedTail: string | null;
  dirty: boolean;
  onChange: (v: string) => void;
  onTest: () => Promise<{ ok: boolean; error?: string }>;
  disabled: boolean;
  enterToSave: () => void;
}) {
  const [reveal, setReveal] = useState(false);
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "testing" }
    | { kind: "ok" }
    | { kind: "err"; message: string }
  >({ kind: "idle" });

  useEffect(() => {
    setStatus({ kind: "idle" });
  }, [value]);

  const runTest = async () => {
    if (status.kind === "testing") return;
    setStatus({ kind: "testing" });
    const res = await onTest();
    if (res.ok) setStatus({ kind: "ok" });
    else setStatus({ kind: "err", message: res.error ?? "Failed" });
  };

  return (
    <div>
      <div
        style={{
          color: "#a1a1aa",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: 1,
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div
        style={{
          color: "#71717a",
          fontSize: 11,
          marginBottom: 8,
          lineHeight: 1.5,
        }}
      >
        {description}
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
        <input
          type={reveal ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") enterToSave();
          }}
          placeholder={
            savedTail ? `•••• •••• •••• ${savedTail}` : placeholder
          }
          spellCheck={false}
          disabled={disabled}
          style={{
            flex: 1,
            boxSizing: "border-box",
            padding: "6px 8px",
            background: "#0a0a0a",
            border: "1px solid #27272a",
            color: "#e5e7eb",
            fontFamily: "inherit",
            fontSize: 12,
            borderRadius: 3,
            opacity: disabled ? 0.5 : 1,
          }}
        />
        <button
          type="button"
          onClick={() => setReveal((v) => !v)}
          disabled={disabled}
          style={btnStyle()}
          title={reveal ? "Hide" : "Show"}
        >
          {reveal ? "Hide" : "Show"}
        </button>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <button
          type="button"
          onClick={runTest}
          disabled={
            disabled ||
            value.trim() === "" ||
            status.kind === "testing"
          }
          style={{
            ...btnStyle(),
            opacity:
              disabled ||
              value.trim() === "" ||
              status.kind === "testing"
                ? 0.5
                : 1,
          }}
        >
          {status.kind === "testing" ? "Testing…" : "Test connection"}
        </button>
        {status.kind === "ok" && (
          <span style={{ color: "#22c55e", fontSize: 11 }}>✓ Works</span>
        )}
        {status.kind === "err" && (
          <span style={{ color: "#ef4444", fontSize: 11 }}>
            ✗ {status.message}
          </span>
        )}
        {savedTail && !dirty && status.kind === "idle" && (
          <span style={{ color: "#a1a1aa", fontSize: 11 }}>
            Saved on file
          </span>
        )}
      </div>
    </div>
  );
}

function btnStyle(): React.CSSProperties {
  return {
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
