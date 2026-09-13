"use client";

import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { AuthProvider, useUser } from "@/lib/auth-context";
import { editorPathForSlug } from "@/lib/project-url";

// Shown by /p/<slug> when the slug exists but the visitor isn't the
// owner (or a collaborator). Never receives the graph — the server
// withholds it. Sign-in returns to this same URL so the owner lands
// in the editor after OAuth.

export default function PrivateProjectGate({ slug }: { slug: string }) {
  return (
    <AuthProvider>
      <GateCard slug={slug} />
    </AuthProvider>
  );
}

function GateCard({ slug }: { slug: string }) {
  const { user, loading } = useUser();

  const signIn = async () => {
    const supabase = createClient();
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const next = editorPathForSlug(slug);
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });
  };

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
          boxShadow: "0 12px 32px rgba(0, 0, 0, 0.5)",
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
          Toolbox
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
          Private project
        </div>
        <p
          style={{
            color: "var(--tb-n-13)",
            lineHeight: 1.5,
            margin: "0 0 14px",
          }}
        >
          {loading
            ? "Checking your session…"
            : user
              ? `This project is private. You're signed in as ${user.email ?? "another account"} — log in with an account that has access to request access.`
              : "Log in to request access."}
        </p>
        {!loading && (
          <button
            onClick={signIn}
            style={{
              padding: "6px 14px",
              background: "var(--tb-a-green-600)",
              border: "1px solid var(--tb-a-green-600)",
              color: "var(--tb-a-green-100)",
              fontFamily: "inherit",
              fontSize: 12,
              borderRadius: 3,
              cursor: "pointer",
            }}
          >
            {user ? "Switch account" : "Log in"}
          </button>
        )}
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
