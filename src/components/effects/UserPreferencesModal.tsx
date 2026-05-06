"use client";

import { useEffect, useRef, useState } from "react";
import {
  loadUserPreferences,
  saveUserPreferences,
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

// Editor-wide preferences. v1 hosts a single field — the OpenAI API
// key used by AI nodes that bring-your-own-key. Future fields land
// here without further design work.
export default function UserPreferencesModal({
  open,
  signedIn,
  onClose,
  onSaved,
}: UserPreferencesModalProps) {
  const [key, setKey] = useState("");
  // Track whether a key was already saved on the server so we can
  // (a) show "•••• <last 4>" instead of leaking the full value when
  // the modal opens, and (b) keep the user's edits distinct from a
  // "no change" save.
  const [savedTail, setSavedTail] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testStatus, setTestStatus] = useState<
    | { kind: "idle" }
    | { kind: "testing" }
    | { kind: "ok" }
    | { kind: "err"; message: string }
  >({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // (Re)load preferences whenever the modal opens.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setTestStatus({ kind: "idle" });
    setDirty(false);
    setReveal(false);
    if (!signedIn) {
      setKey("");
      setSavedTail(null);
      return;
    }
    setLoading(true);
    loadUserPreferences()
      .then((prefs) => {
        const k = prefs.openaiApiKey ?? "";
        setKey(k);
        setSavedTail(k ? k.slice(-4) : null);
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
    const trimmed = key.trim();
    const res = await saveUserPreferences({
      // Empty input = clear the saved key.
      openaiApiKey: trimmed === "" ? null : trimmed,
    });
    setSaving(false);
    if (!res.ok) {
      setError(res.error ?? "Save failed");
      return;
    }
    onSaved?.();
    onClose();
  };

  const runTest = async () => {
    if (testStatus.kind === "testing") return;
    setTestStatus({ kind: "testing" });
    const res = await testOpenAIKey(key);
    if (res.ok) setTestStatus({ kind: "ok" });
    else setTestStatus({ kind: "err", message: res.error ?? "Failed" });
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
          minWidth: 460,
          maxWidth: 520,
          background: "#18181b",
          border: "1px solid #27272a",
          borderRadius: 6,
          padding: 16,
          fontFamily: "ui-monospace, monospace",
          fontSize: 12,
          color: "#e5e7eb",
          boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
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

        <div
          style={{
            color: "#a1a1aa",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: 1,
            marginBottom: 6,
          }}
        >
          OpenAI API Key
        </div>
        <div
          style={{
            color: "#71717a",
            fontSize: 11,
            marginBottom: 8,
            lineHeight: 1.5,
          }}
        >
          Used by AI-driven nodes (Image Generate, etc.). The key is
          stored on your account and only ever sent directly to
          OpenAI from your browser. Leave blank to clear.
        </div>

        <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
          <input
            ref={inputRef}
            type={reveal ? "text" : "password"}
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setDirty(true);
              setTestStatus({ kind: "idle" });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder={
              savedTail
                ? `•••• •••• •••• ${savedTail}`
                : "sk-…"
            }
            spellCheck={false}
            disabled={!signedIn || loading}
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
              opacity: !signedIn || loading ? 0.5 : 1,
            }}
          />
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            disabled={!signedIn}
            style={btnStyle()}
            title={reveal ? "Hide key" : "Show key"}
          >
            {reveal ? "Hide" : "Show"}
          </button>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 14,
          }}
        >
          <button
            type="button"
            onClick={runTest}
            disabled={
              !signedIn ||
              key.trim() === "" ||
              testStatus.kind === "testing"
            }
            style={{
              ...btnStyle(),
              opacity:
                !signedIn ||
                key.trim() === "" ||
                testStatus.kind === "testing"
                  ? 0.5
                  : 1,
            }}
          >
            {testStatus.kind === "testing"
              ? "Testing…"
              : "Test connection"}
          </button>
          {testStatus.kind === "ok" && (
            <span style={{ color: "#22c55e", fontSize: 11 }}>
              ✓ Key works
            </span>
          )}
          {testStatus.kind === "err" && (
            <span style={{ color: "#ef4444", fontSize: 11 }}>
              ✗ {testStatus.message}
            </span>
          )}
          {savedTail && !dirty && testStatus.kind === "idle" && (
            <span style={{ color: "#a1a1aa", fontSize: 11 }}>
              Saved key on file
            </span>
          )}
        </div>

        {error && (
          <div
            style={{
              color: "#ef4444",
              fontSize: 11,
              marginBottom: 10,
            }}
          >
            {error}
          </div>
        )}

        <div
          style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}
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
