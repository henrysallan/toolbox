"use client";

import { useEffect } from "react";

// Three-way confirm for File → New when the current project has
// unsaved work. Kept separate from SaveModal + PublicPrivateConfirm
// so each keeps its own single-purpose framing.

export interface NewProjectConfirmProps {
  open: boolean;
  // Short description of what "Save" will do from here — "overwrite
  // <name>", "save as …", "save a copy", so the user isn't left
  // guessing which branch they're about to hit.
  saveHint: string;
  // True when saving is impossible (signed out or similar) — then
  // we hide the Save button and only offer Don't Save / Cancel.
  canSave: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

export default function NewProjectConfirm({
  open,
  saveHint,
  canSave,
  onSave,
  onDiscard,
  onCancel,
}: NewProjectConfirmProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      onClick={onCancel}
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
          minWidth: 380,
          maxWidth: 440,
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
          Unsaved changes
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
          Save before starting a new project?
        </div>
        <div style={{ color: "#a1a1aa", lineHeight: 1.5, marginBottom: 14 }}>
          You have unsaved work in this project.{" "}
          {canSave ? saveHint : "Sign in to save."}
        </div>
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          <button onClick={onCancel} style={btnStyle()}>
            Cancel
          </button>
          <button
            onClick={onDiscard}
            style={{
              ...btnStyle(),
              background: "transparent",
              border: "1px solid #b91c1c",
              color: "#fecaca",
            }}
          >
            Don&apos;t save
          </button>
          {canSave && (
            <button
              onClick={onSave}
              style={{
                ...btnStyle(),
                background: "#16a34a",
                border: "1px solid #16a34a",
                color: "#dcfce7",
              }}
            >
              Save
            </button>
          )}
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
