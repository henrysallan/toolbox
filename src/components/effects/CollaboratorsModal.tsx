"use client";

import { useEffect, useState } from "react";
import {
  getOrCreateInviteLink,
  listCollaborators,
  removeCollaborator,
  resetInviteLink,
  type CollaboratorEntry,
  type InviteLink,
} from "@/lib/supabase/project-collaborators";

// Owner-only management for a shared project (M2 —
// specdocs/081426_shared-projects.md): the member list with remove, and
// the invite link. One live link per project: "Copy invite link" mints
// or reuses on first click (no row is created just by opening the
// modal); "Reset" revokes every live link and mints a fresh one, so a
// leaked URL dies immediately.
//
// Mount-conditional like NewLayoutPresetModal — parent renders it only
// while open, so open/close state lives outside.

export interface CollaboratorsModalProps {
  projectId: string;
  projectName: string;
  onClose: () => void;
}

function daysLeft(iso: string): number {
  return Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000));
}

export default function CollaboratorsModal({
  projectId,
  projectName,
  onClose,
}: CollaboratorsModalProps) {
  const [members, setMembers] = useState<CollaboratorEntry[] | null>(null);
  const [invite, setInvite] = useState<InviteLink | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    listCollaborators(projectId).then((list) => {
      if (alive) setMembers(list);
    });
    return () => {
      alive = false;
    };
  }, [projectId]);

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API can be unavailable (insecure origin, tests) —
      // same textarea fallback as RateProjectPopover's live-link copy.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        // ignore; the button still flips to "copied"
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleCopyLink = async () => {
    if (busy) return;
    if (invite) {
      await copyToClipboard(invite.url);
      return;
    }
    setBusy(true);
    try {
      const link = await getOrCreateInviteLink(projectId);
      if (link) {
        setInvite(link);
        await copyToClipboard(link.url);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const link = await resetInviteLink(projectId);
      setInvite(link);
      setCopied(false);
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (m: CollaboratorEntry) => {
    // Optimistic removal, resync on failure — same contract as the
    // LoadGrid rename/delete handlers.
    setMembers((cur) =>
      cur ? cur.filter((x) => x.user_id !== m.user_id) : cur
    );
    const ok = await removeCollaborator(projectId, m.user_id);
    if (!ok) {
      const fresh = await listCollaborators(projectId);
      setMembers(fresh);
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
          minWidth: 380,
          maxWidth: 440,
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
          Collaborators
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
          “{projectName}”
        </div>
        <div
          style={{ color: "var(--tb-n-13)", lineHeight: 1.5, marginBottom: 12 }}
        >
          Collaborators can open and save this project. Name, visibility
          and delete stay yours.
        </div>

        {/* invite link */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginBottom: 4,
          }}
        >
          <button
            onClick={handleCopyLink}
            disabled={busy}
            style={{
              ...btnStyle(busy),
              background: "var(--tb-a-green-600)",
              border: "1px solid var(--tb-a-green-600)",
              color: "var(--tb-a-green-100)",
            }}
          >
            {copied ? "Copied!" : "Copy invite link"}
          </button>
          {invite && (
            <button
              onClick={handleReset}
              disabled={busy}
              style={btnStyle(busy)}
              title="Revoke the current link and mint a new one"
            >
              Reset link
            </button>
          )}
        </div>
        <div
          style={{
            color: "var(--tb-n-10)",
            fontSize: 10,
            marginBottom: 12,
          }}
        >
          {invite
            ? `Anyone with the link can join · expires in ${daysLeft(invite.expiresAt)}d`
            : "Links let anyone join as an editor and expire after 7 days."}
        </div>

        {/* member list */}
        <div
          style={{
            borderTop: "1px solid var(--tb-n-7)",
            paddingTop: 10,
            display: "flex",
            flexDirection: "column",
            gap: 4,
            maxHeight: 220,
            overflowY: "auto",
          }}
        >
          {members === null ? (
            <div style={{ color: "var(--tb-n-10)" }}>Loading…</div>
          ) : members.length === 0 ? (
            <div style={{ color: "var(--tb-n-10)" }}>
              No collaborators yet — share an invite link.
            </div>
          ) : (
            members.map((m) => (
              <div
                key={m.user_id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span
                  style={{
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {m.display_name ?? "collaborator"}
                </span>
                <span style={{ color: "var(--tb-n-10)", fontSize: 10 }}>
                  {m.role}
                </span>
                <button
                  onClick={() => handleRemove(m)}
                  style={{
                    ...btnStyle(false),
                    border: "1px solid var(--tb-a-red-700)",
                    color: "var(--tb-a-red-200)",
                    padding: "2px 8px",
                  }}
                  title="Remove this collaborator"
                >
                  Remove
                </button>
              </div>
            ))
          )}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            marginTop: 14,
          }}
        >
          <button onClick={onClose} style={btnStyle(false)}>
            Done
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
