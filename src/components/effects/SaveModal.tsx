"use client";

import { useEffect, useRef, useState } from "react";

export interface SaveModalProps {
  open: boolean;
  initialName?: string;
  onClose: () => void;
  // The handler owns async work (serialize + upload). Throwing surfaces the
  // message to the user; resolving normally closes the modal.
  onSave: (name: string) => Promise<void>;
  // Returns the colliding project row (or null) when the typed name
  // matches one of the user's existing projects. When non-null the
  // primary button relabels to "Overwrite" so the user knows the save
  // will replace an existing row rather than create a new one.
  findConflict?: (name: string) => { name: string } | null;
}

export default function SaveModal({
  open,
  initialName,
  onClose,
  onSave,
  findConflict,
}: SaveModalProps) {
  const [name, setName] = useState(initialName ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName(initialName ?? "");
      setError(null);
      setSaving(false);
      // Run after paint so the input is actually in the DOM when we focus.
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [open, initialName]);

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
    const trimmed = name.trim();
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
            marginBottom: 10,
            color: "#a1a1aa",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: 1,
          }}
        >
          Save project
        </div>
        <input
          ref={inputRef}
          type="text"
          placeholder="Project name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          spellCheck={false}
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "6px 8px",
            background: "#0a0a0a",
            border: "1px solid #27272a",
            color: "#e5e7eb",
            fontFamily: "inherit",
            fontSize: 12,
            borderRadius: 3,
            marginBottom: 10,
          }}
        />
        {(() => {
          const conflict = findConflict?.(name) ?? null;
          return (
            <>
              {conflict && (
                <div
                  style={{
                    color: "#facc15",
                    fontSize: 10,
                    marginBottom: 8,
                    lineHeight: 1.4,
                  }}
                >
                  A project named &ldquo;{conflict.name}&rdquo; already
                  exists — saving will overwrite it.
                </div>
              )}
              {error && (
                <div
                  style={{ color: "#ef4444", fontSize: 10, marginBottom: 8 }}
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
                  disabled={saving || !name.trim()}
                  style={{
                    ...btnStyle(),
                    background: conflict ? "#b45309" : "#16a34a",
                    border: `1px solid ${conflict ? "#b45309" : "#16a34a"}`,
                    color: conflict ? "#fef3c7" : "#dcfce7",
                    opacity: saving || !name.trim() ? 0.5 : 1,
                  }}
                >
                  {saving
                    ? conflict
                      ? "Overwriting…"
                      : "Saving…"
                    : conflict
                    ? "Overwrite"
                    : "Save"}
                </button>
              </div>
            </>
          );
        })()}
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
