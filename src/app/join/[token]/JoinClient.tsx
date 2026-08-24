"use client";

import { useState } from "react";
import Link from "next/link";
import {
  redeemProjectInvite,
  type InvitePreview,
} from "@/lib/supabase/project-collaborators";
import { AuthProvider, useUser } from "@/lib/auth-context";

// Client half of /join/<token>: shows who invited you to what, and an
// explicit Join button. The server preview's status was computed with
// the REQUEST's auth cookie, so 'owner'/'member' are already accurate
// for the signed-in visitor; the signed-out state is handled here
// (sign in happens in the main app — this page just says so).
//
// After a successful redeem the project lands in the Shared tab, so
// "Open Toolbox" is a plain link to the app root — no deep-link
// plumbing needed.

export interface JoinClientProps {
  token: string;
  initial: InvitePreview;
}

export default function JoinClient(props: JoinClientProps) {
  return (
    <AuthProvider>
      <JoinCard {...props} />
    </AuthProvider>
  );
}

function JoinCard({ token, initial }: JoinClientProps) {
  const { user, loading } = useUser();
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const owner = initial.ownerName ?? "A Toolbox user";

  const handleJoin = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await redeemProjectInvite(token);
      if ("error" in res) {
        setError(res.error);
      } else {
        setJoined(true);
      }
    } finally {
      setBusy(false);
    }
  };

  let body: React.ReactNode;
  if (initial.status === "revoked" || initial.status === "expired") {
    body = (
      <p style={pStyle}>
        This invite link has {initial.status === "revoked" ? "been revoked" : "expired"}.
        Ask {owner} for a fresh one.
      </p>
    );
  } else if (joined) {
    body = (
      <p style={pStyle}>
        You&apos;re in — “{initial.projectName}” is now in your{" "}
        <strong>Shared</strong> tab.
      </p>
    );
  } else if (initial.status === "owner") {
    body = <p style={pStyle}>This is your own project.</p>;
  } else if (initial.status === "member") {
    body = (
      <p style={pStyle}>
        You&apos;re already a collaborator — find “{initial.projectName}”
        in your <strong>Shared</strong> tab.
      </p>
    );
  } else if (loading) {
    body = <p style={pStyle}>Checking your session…</p>;
  } else if (!user) {
    body = (
      <p style={pStyle}>
        Sign in to Toolbox first, then reopen this link to accept the
        invite.
      </p>
    );
  } else {
    body = (
      <>
        <p style={pStyle}>
          Joining makes you an editor: you can open and save this
          project. Name, visibility and delete stay with the owner.
        </p>
        {error && (
          <p style={{ ...pStyle, color: "var(--tb-a-red-400)" }}>{error}</p>
        )}
        <button
          onClick={handleJoin}
          disabled={busy}
          style={{
            padding: "6px 14px",
            background: "var(--tb-a-green-600)",
            border: "1px solid var(--tb-a-green-600)",
            color: "var(--tb-a-green-100)",
            fontFamily: "inherit",
            fontSize: 12,
            borderRadius: 3,
            cursor: busy ? "default" : "pointer",
            opacity: busy ? 0.5 : 1,
          }}
        >
          {busy ? "Joining…" : "Join project"}
        </button>
      </>
    );
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--tb-n-1)",
        fontFamily: "var(--ui-font)",
        color: "var(--tb-n-16)",
        padding: 16,
      }}
    >
      <div
        style={{
          minWidth: 340,
          maxWidth: 440,
          background: "var(--tb-n-3)",
          border: "1px solid var(--tb-n-7)",
          borderRadius: 6,
          padding: 20,
          fontSize: 12,
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
          Project invite
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
          {owner} invited you to “{initial.projectName}”
        </div>
        {body}
        <div style={{ marginTop: 16 }}>
          <Link
            href="/"
            style={{
              color: "var(--tb-n-13)",
              fontSize: 11,
              textDecoration: "underline",
            }}
          >
            Open Toolbox
          </Link>
        </div>
      </div>
    </div>
  );
}

const pStyle: React.CSSProperties = {
  color: "var(--tb-n-13)",
  lineHeight: 1.5,
  margin: "0 0 12px",
};
