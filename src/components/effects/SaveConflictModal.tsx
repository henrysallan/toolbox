"use client";

import { useEffect } from "react";

// Save-conflict resolution for shared projects (M1 —
// specdocs/081426_shared-projects.md): the compare-and-swap in
// updateProject matched zero rows, i.e. someone (a collaborator, or
// this user in another window) saved a newer version after this editor
// loaded its copy. Nothing has been written. The three ways out:
//
//   Save a copy   — safe default; fork the local state to a new private
//                   row and leave the newer save alone.
//   Overwrite     — push the local state anyway, CAS'd against the
//                   FRESH stamp shown in this dialog (so a third save
//                   racing the dialog re-conflicts instead of being
//                   silently clobbered).
//   Discard       — throw away local changes and reload the newer save.
//
// Kept separate from NewProjectConfirm/PublicPrivateConfirm so each
// keeps its own single-purpose framing.

export interface SaveConflictModalProps {
  open: boolean;
  projectName: string;
  // Display name of whoever made the newer save. Null when unknown
  // (pre-migration DB, missing profile) — copy degrades to "someone".
  updatedByName: string | null;
  // ISO stamp of the newer save; drives the "N minutes ago" hint.
  updatedAt: string | null;
  // True while a chosen action is running — disables the buttons so a
  // double-click can't fire two saves.
  busy: boolean;
  onSaveCopy: () => void;
  onOverwrite: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

// "just now" / "4 minutes ago" / "2 hours ago" / locale date. Coarse on
// purpose — the dialog only needs to convey "how stale am I".
function timeAgo(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min === 1) return "a minute ago";
  if (min < 60) return `${min} minutes ago`;
  const hr = Math.round(min / 60);
  if (hr === 1) return "an hour ago";
  if (hr < 24) return `${hr} hours ago`;
  return new Date(iso).toLocaleString();
}

export default function SaveConflictModal({
  open,
  projectName,
  updatedByName,
  updatedAt,
  busy,
  onSaveCopy,
  onOverwrite,
  onDiscard,
  onCancel,
}: SaveConflictModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const who = updatedByName ?? "someone";
  const when = timeAgo(updatedAt);

  return (
    <div
      onClick={busy ? undefined : onCancel}
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
          maxWidth: 460,
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
          Save conflict
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
          {who} saved a newer version of “{projectName}”
          {when ? ` ${when}` : ""}.
        </div>
        <div
          style={{ color: "var(--tb-n-13)", lineHeight: 1.5, marginBottom: 14 }}
        >
          Your save was not written. Save your work as a copy, overwrite
          the newer version, or discard your changes and load it.
        </div>
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          <button onClick={onCancel} disabled={busy} style={btnStyle(busy)}>
            Cancel
          </button>
          <button
            onClick={onDiscard}
            disabled={busy}
            style={{
              ...btnStyle(busy),
              background: "transparent",
              border: "1px solid var(--tb-a-red-700)",
              color: "var(--tb-a-red-200)",
            }}
          >
            Discard mine
          </button>
          <button
            onClick={onOverwrite}
            disabled={busy}
            style={{
              ...btnStyle(busy),
              background: "transparent",
              border: "1px solid var(--tb-a-red-700)",
              color: "var(--tb-a-red-200)",
            }}
          >
            Overwrite
          </button>
          <button
            onClick={onSaveCopy}
            disabled={busy}
            style={{
              ...btnStyle(busy),
              background: "var(--tb-a-green-600)",
              border: "1px solid var(--tb-a-green-600)",
              color: "var(--tb-a-green-100)",
            }}
          >
            Save a copy
          </button>
        </div>
      </div>
    </div>
  );
}

function btnStyle(busy: boolean): React.CSSProperties {
  return {
    padding: "4px 10px",
    background: "transparent",
    border: "1px solid var(--tb-n-9)",
    color: "var(--tb-n-16)",
    fontFamily: "inherit",
    fontSize: 11,
    borderRadius: 3,
    cursor: busy ? "default" : "pointer",
    opacity: busy ? 0.5 : 1,
  };
}
