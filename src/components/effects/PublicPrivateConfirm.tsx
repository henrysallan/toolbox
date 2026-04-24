"use client";

import { useEffect } from "react";

// Tiny confirmation modal for the visibility toggle. Kept separate from
// SaveModal so it doesn't inherit the "save project" framing — this is
// purely a "are you sure?" prompt, with its own copy per direction.

export interface PublicPrivateConfirmProps {
  open: boolean;
  // true = user is toggling to public, false = toggling to private
  toPublic: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function PublicPrivateConfirm({
  open,
  toPublic,
  onCancel,
  onConfirm,
}: PublicPrivateConfirmProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel, onConfirm]);

  if (!open) return null;

  const title = toPublic ? "Make project public?" : "Make project private?";
  const body = toPublic
    ? "Anyone with the link will be able to view this project. You can flip it back to private at any time."
    : "Only you will be able to view this project. Existing links will stop working until you make it public again.";

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
          minWidth: 360,
          maxWidth: 420,
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
          Visibility
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
          {title}
        </div>
        <div style={{ color: "#a1a1aa", lineHeight: 1.5, marginBottom: 14 }}>
          {body}
        </div>
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          <button onClick={onCancel} style={btnStyle()}>
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{
              ...btnStyle(),
              background: toPublic ? "#16a34a" : "#b45309",
              border: `1px solid ${toPublic ? "#16a34a" : "#b45309"}`,
              color: toPublic ? "#dcfce7" : "#fef3c7",
            }}
          >
            {toPublic ? "Make public" : "Make private"}
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
