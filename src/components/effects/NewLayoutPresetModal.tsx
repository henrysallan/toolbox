"use client";

import { useEffect, useRef, useState } from "react";

export interface NewLayoutPresetModalProps {
  onClose: () => void;
  // Saves the CURRENT window arrangement under `name`. Throwing surfaces
  // the message; resolving closes the modal.
  onSave: (name: string) => Promise<void> | void;
  // Existing preset names (user presets only) — typing one relabels the
  // primary button to Replace, matching upsertLayoutPreset's by-name
  // overwrite.
  existingNames: string[];
}

// Window → Layouts → + New Preset…. Captures the live layout tree (the
// parent reads it at save time) under a user-supplied name.
//
// Mounted only while open — the parent's conditional render gives every
// open a fresh, empty field without a reset effect.
export default function NewLayoutPresetModal({
  onClose,
  onSave,
  existingNames,
}: NewLayoutPresetModalProps) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Run after paint so the input is actually in the DOM when we focus.
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const trimmed = name.trim();
  const conflict = existingNames.some(
    (n) => n.toLowerCase() === trimmed.toLowerCase()
  );

  const submit = async () => {
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(trimmed);
      onClose();
    } catch (e) {
      setError((e as Error)?.message ?? "Save failed");
      setSaving(false);
    }
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
          minWidth: 360,
          background: "var(--tb-n-3)",
          border: "1px solid var(--tb-n-7)",
          borderRadius: 6,
          padding: 16,
          fontFamily: "var(--ui-font)",
          fontSize: 12,
          color: "var(--tb-n-16)",
          boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
        }}
      >
        <div
          style={{
            marginBottom: 10,
            color: "var(--tb-n-13)",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: 1,
          }}
        >
          New layout preset
        </div>
        <div
          style={{ marginBottom: 10, color: "var(--tb-n-11)", lineHeight: 1.5 }}
        >
          Saves the current window arrangement to your profile.
        </div>
        <input
          ref={inputRef}
          type="text"
          placeholder="Preset name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          spellCheck={false}
          maxLength={40}
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "6px 8px",
            background: "var(--tb-n-0)",
            border: "1px solid var(--tb-n-7)",
            color: "var(--tb-n-16)",
            fontFamily: "inherit",
            fontSize: 12,
            borderRadius: 3,
            marginBottom: 10,
          }}
        />
        {conflict && (
          <div
            style={{
              color: "var(--tb-a-yellow-400)",
              fontSize: 10,
              marginBottom: 8,
              lineHeight: 1.4,
            }}
          >
            A preset named &ldquo;{trimmed}&rdquo; already exists — saving
            will replace it.
          </div>
        )}
        {error && (
          <div style={{ color: "var(--tb-a-red-500)", fontSize: 10, marginBottom: 8 }}>
            {error}
          </div>
        )}
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={btnStyle()}>
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={saving || !trimmed}
            style={{
              ...btnStyle(),
              background: conflict ? "var(--tb-a-amber-700)" : "var(--tb-a-green-600)",
              border: `1px solid ${conflict ? "var(--tb-a-amber-700)" : "var(--tb-a-green-600)"}`,
              color: conflict ? "var(--tb-a-amber-100)" : "var(--tb-a-green-100)",
              opacity: saving || !trimmed ? 0.5 : 1,
            }}
          >
            {saving ? "Saving…" : conflict ? "Replace" : "Save Preset"}
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
    border: "1px solid var(--tb-n-9)",
    color: "var(--tb-n-16)",
    fontFamily: "inherit",
    fontSize: 11,
    borderRadius: 3,
    cursor: "pointer",
  };
}
