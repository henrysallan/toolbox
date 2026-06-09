"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useUser } from "@/lib/auth-context";
import LoadGrid from "./LoadGrid";

interface Props {
  // Open a saved project by id (reuses the editor's load path).
  onLoad: (id: string) => void;
  // Start a fresh, empty project.
  onNewProject: () => void;
}

// How long the near-opaque dark veil is held before lightening to
// reveal the blurred editor underneath. Covers the editor's first
// paint / GL boot so the user only sees a clean dark screen + the
// modal while everything behind settles.
const REVEAL_DELAY_MS = 750;

// First-load gateway: a centred card with account info on the left and
// the reused Projects grid on the right. Sits on top of the (already
// mounted) editor; selecting a project or "New Project" dismisses it.
export default function Landing({ onLoad, onNewProject }: Props) {
  const { user, loading } = useUser();
  const signedIn = !!user;

  // Fade the card in on mount so the gateway doesn't pop.
  const [shown, setShown] = useState(false);
  // Two-phase backdrop: starts as a near-opaque dark veil (hides the
  // editor booting), then lightens to a translucent heavy blur once the
  // editor has had a moment to settle.
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    const t = setTimeout(() => setRevealed(true), REVEAL_DELAY_MS);
    return () => {
      cancelAnimationFrame(id);
      clearTimeout(t);
    };
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        // Dark veil while initializing → translucent once revealed. The
        // blur stays constant (heavy) so only the veil's alpha animates,
        // which is far smoother than transitioning the blur itself.
        background: revealed ? "rgba(0, 0, 0, 0.35)" : "rgba(0, 0, 0, 0.97)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        transition: "background-color 600ms ease",
        fontFamily: "ui-monospace, monospace",
      }}
    >
      <div
        style={{
          display: "flex",
          width: "min(900px, 92vw)",
          height: "min(580px, 84vh)",
          background: "#0a0a0a",
          border: "1px solid #27272a",
          borderRadius: 8,
          boxShadow: "0 20px 60px rgba(0, 0, 0, 0.6)",
          overflow: "hidden",
          opacity: shown ? 1 : 0,
          transform: shown ? "translateY(0)" : "translateY(8px)",
          transition: "opacity 220ms ease, transform 220ms ease",
        }}
      >
        <AccountPane user={user} loading={loading} />
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            // LoadGrid's root applies margin:-12 to span its parent's
            // padding, so the 12px here is what gives the grid its inset.
            padding: 12,
          }}
        >
          <LoadGrid
            signedIn={signedIn}
            currentUserId={user?.id ?? null}
            onLoad={onLoad}
            onNewProject={onNewProject}
          />
        </div>
      </div>
    </div>
  );
}

// ========================================================================
// account pane (left)
// ========================================================================

function AccountPane({
  user,
  loading,
}: {
  user: ReturnType<typeof useUser>["user"];
  loading: boolean;
}) {
  const signIn = async () => {
    const supabase = createClient();
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${origin}/auth/callback` },
    });
  };

  const signOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
  };

  const metaName =
    (user?.user_metadata?.full_name as string | undefined) ??
    (user?.user_metadata?.name as string | undefined);
  const avatarUrl = user?.user_metadata?.avatar_url as string | undefined;
  const initials = (metaName ?? user?.email ?? "?")
    .split(/[\s@]+/)[0]
    .slice(0, 2)
    .toUpperCase();

  return (
    <div
      style={{
        width: 240,
        flexShrink: 0,
        borderRight: "1px solid #27272a",
        background: "#0c0c0e",
        display: "flex",
        flexDirection: "column",
        padding: 18,
        color: "#e5e7eb",
      }}
    >
      {/* Brand */}
      <div style={{ fontSize: 15, letterSpacing: 0.5, color: "#fafafa" }}>
        toolbox
      </div>
      <div style={{ fontSize: 10, color: "#52525b", marginTop: 2 }}>
        node-based effects
      </div>

      <div style={{ flex: 1 }} />

      {/* Account block */}
      {loading ? (
        <div style={{ fontSize: 11, color: "#52525b" }}>…</div>
      ) : user ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {avatarUrl ? (
              <span
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: "50%",
                  flexShrink: 0,
                  background: `#18181b center/cover url(${avatarUrl})`,
                }}
              />
            ) : (
              <span
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: "50%",
                  flexShrink: 0,
                  background: "#3f3f46",
                  color: "#e5e7eb",
                  fontSize: 13,
                  fontWeight: 600,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {initials}
              </span>
            )}
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 12,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {metaName ?? "user"}
              </div>
              <div
                style={{
                  fontSize: 10,
                  color: "#71717a",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {user.email}
              </div>
            </div>
          </div>
          <button
            onClick={signOut}
            style={{
              padding: "6px 10px",
              background: "transparent",
              border: "1px solid #27272a",
              borderRadius: 4,
              color: "#a1a1aa",
              fontFamily: "inherit",
              fontSize: 11,
              cursor: "pointer",
              textAlign: "center",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "#161619";
              e.currentTarget.style.color = "#e5e7eb";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = "#a1a1aa";
            }}
          >
            Sign out
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 11, color: "#71717a", lineHeight: 1.5 }}>
            Sign in to save your work and see your private projects.
          </div>
          <button
            onClick={signIn}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              padding: "8px 10px",
              background: "#fafafa",
              border: "none",
              borderRadius: 4,
              color: "#18181b",
              fontFamily: "inherit",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "#e5e7eb")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "#fafafa")}
          >
            <GoogleMark />
            Sign in with Google
          </button>
        </div>
      )}
    </div>
  );
}

function GoogleMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 18 18" aria-hidden>
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.34A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.94H.96a9 9 0 0 0 0 8.12l3.01-2.34z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.47.9 11.43 0 9 0A9 9 0 0 0 .96 4.94l3.01 2.34C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  );
}
