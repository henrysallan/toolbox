"use client";

import { useEffect, useState } from "react";
import {
  deleteRecoverySnapshot,
  listRecoverySnapshots,
  UNTITLED_BUCKET,
  type RecoverySnapshotMeta,
} from "@/lib/recovery-autosave";

// File → Recover Autosave… (M4 first slice —
// specdocs/081426_shared-projects.md). Lists the local recovery
// snapshots newest-first; Restore hands the id up (the parent
// deserializes it into the editor as UNSAVED work — restoring never
// touches any cloud row until the user explicitly saves). Snapshots
// survive a restore — only an explicit save or Delete removes them.
//
// Mount-conditional like CollaboratorsModal — parent renders it only
// while open.

export interface RecoveryModalProps {
  onRestore: (snapshot: RecoverySnapshotMeta) => void;
  onClose: () => void;
}

function when(ts: number): string {
  const min = Math.round((Date.now() - ts) / 60_000);
  if (min < 1) return "just now";
  if (min === 1) return "a minute ago";
  if (min < 60) return `${min} minutes ago`;
  const hr = Math.round(min / 60);
  if (hr === 1) return "an hour ago";
  if (hr < 24) return `${hr} hours ago`;
  return new Date(ts).toLocaleString();
}

export default function RecoveryModal({
  onRestore,
  onClose,
}: RecoveryModalProps) {
  const [rows, setRows] = useState<RecoverySnapshotMeta[] | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    listRecoverySnapshots().then((list) => {
      if (alive) setRows(list);
    });
    return () => {
      alive = false;
    };
  }, []);

  const handleDelete = async (id: number) => {
    setRows((cur) => (cur ? cur.filter((r) => r.id !== id) : cur));
    await deleteRecoverySnapshot(id);
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
          minWidth: 400,
          maxWidth: 480,
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
          Recover autosave
        </div>
        <div
          style={{ color: "var(--tb-n-13)", lineHeight: 1.5, marginBottom: 12 }}
        >
          Snapshots of unsaved work, taken every couple of minutes while
          you edit and kept on this machine only. Restoring opens the
          snapshot as unsaved work — nothing is written until you save.
        </div>
        <div
          style={{
            borderTop: "1px solid var(--tb-n-7)",
            paddingTop: 10,
            display: "flex",
            flexDirection: "column",
            gap: 4,
            maxHeight: 260,
            overflowY: "auto",
          }}
        >
          {rows === null ? (
            <div style={{ color: "var(--tb-n-10)" }}>Loading…</div>
          ) : rows.length === 0 ? (
            <div style={{ color: "var(--tb-n-10)" }}>
              No autosaves yet — snapshots appear after a couple of
              minutes of unsaved changes.
            </div>
          ) : (
            rows.map((r) => (
              <div
                key={r.id}
                style={{ display: "flex", alignItems: "center", gap: 8 }}
              >
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {r.name}
                  {r.bucket === UNTITLED_BUCKET && (
                    <span
                      style={{ color: "var(--tb-n-10)", marginLeft: 6 }}
                    >
                      (unsaved)
                    </span>
                  )}
                </span>
                <span
                  style={{
                    color: "var(--tb-n-10)",
                    fontSize: 10,
                    flexShrink: 0,
                  }}
                >
                  {when(r.savedAt)}
                </span>
                <button
                  onClick={() => onRestore(r)}
                  style={{
                    ...btnStyle(),
                    padding: "2px 8px",
                    background: "var(--tb-a-green-600)",
                    border: "1px solid var(--tb-a-green-600)",
                    color: "var(--tb-a-green-100)",
                  }}
                >
                  Restore
                </button>
                <button
                  onClick={() => void handleDelete(r.id)}
                  title="Delete this snapshot"
                  style={{
                    ...btnStyle(),
                    padding: "2px 8px",
                    border: "1px solid var(--tb-a-red-700)",
                    color: "var(--tb-a-red-200)",
                  }}
                >
                  Delete
                </button>
              </div>
            ))
          )}
        </div>
        <div
          style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}
        >
          <button onClick={onClose} style={btnStyle()}>
            Close
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
