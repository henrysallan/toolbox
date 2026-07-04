"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useUser } from "@/lib/auth-context";
import { platform } from "@/lib/platform";
import LoadGrid from "./LoadGrid";
import WindowControls from "./WindowControls";

interface Props {
  // Open a saved project by id (reuses the editor's load path).
  onLoad: (id: string) => void;
  // Open a recent local .toolbox by path (desktop Local tab).
  onLoadLocal?: (path: string) => void;
  // Start a fresh, empty project.
  onNewProject: () => void;
}

// How long the near-opaque dark veil is held before lightening to
// reveal the blurred editor underneath. Covers the editor's first
// paint / GL boot so the user only sees a clean dark screen + the
// modal while everything behind settles.
const REVEAL_DELAY_MS = 750;

// Inter, weight 680 — the branded pill face (see @font-face in globals.css).
const INTER = '"Inter", system-ui, -apple-system, sans-serif';

// Desktop build download. Points at the GitHub Releases "latest" redirect,
// which always resolves to the newest published release's asset with this
// exact name — so it never needs updating per release. The artifact name is
// pinned (no version) in package.json's build.mac.artifactName. 404s until
// the first release is published (`npm run desktop:publish`).
const DOWNLOAD_URL =
  "https://github.com/henrysallan/toolbox/releases/latest/download/Toolbox-arm64.dmg";

// First-load gateway: the reused Projects grid in a centred card, with a
// header row floating just above it — a "Welcome to Toolbox" pill (and, on
// web, a greyed Mac Download button) on the left, the account pill on the
// right. Sits on top of the (already mounted) editor; selecting a project
// or "New Project" dismisses it.
export default function Landing({ onLoad, onLoadLocal, onNewProject }: Props) {
  const { user, loading } = useUser();
  const signedIn = !!user;

  // Fade the card in on mount so the gateway doesn't pop.
  const [shown, setShown] = useState(false);
  // Two-phase backdrop: starts as a near-opaque dark veil (hides the
  // editor booting), then lightens to a translucent heavy blur once the
  // editor has had a moment to settle.
  const [revealed, setRevealed] = useState(false);
  // The Mac Download button is web-only. Detect native post-mount to avoid
  // an SSR hydration mismatch (renders nothing until we know).
  const [isWeb, setIsWeb] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    const t = setTimeout(() => setRevealed(true), REVEAL_DELAY_MS);
    setIsWeb(!platform.isNative);
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
      {/* Window controls (frameless desktop) — the menu bar is hidden behind
          the landing, so surface the traffic lights here, at the same top-left
          spot the menu bar uses. Self-gates to native; null on web. */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          height: 22,
          display: "flex",
          alignItems: "center",
          zIndex: 10,
        }}
      >
        <WindowControls />
      </div>

      {/* Download button — pinned to the browser window's upper-right corner
          (web only; greyed until desktop hosting exists). */}
      {isWeb && (
        <a
          href={DOWNLOAD_URL}
          title="Download Toolbox for macOS (Apple Silicon)"
          style={{
            position: "absolute",
            top: 16,
            right: 16,
            zIndex: 10,
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            height: 40,
            padding: "0 16px",
            background: "transparent",
            border: "1px solid #3f3f46",
            borderRadius: 999,
            fontFamily: INTER,
            fontWeight: 500,
            fontSize: 13,
            color: "#d4d4d8",
            cursor: "pointer",
            textDecoration: "none",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "#19191c";
            e.currentTarget.style.color = "#fafafa";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "#d4d4d8";
          }}
        >
          <AppleMark />
          Download
        </a>
      )}

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "min(900px, 92vw)",
          opacity: shown ? 1 : 0,
          transform: shown ? "translateY(0)" : "translateY(8px)",
          transition: "opacity 220ms ease, transform 220ms ease",
        }}
      >
        {/* Header row, floating just above the card. */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 12,
          }}
        >
          <div
            style={{
              fontFamily: INTER,
              fontWeight: 680,
              color: "#fafafa",
              whiteSpace: "nowrap",
              letterSpacing: -0.5,
              lineHeight: 1.02,
            }}
          >
            <span style={{ display: "block", fontSize: 20 }}>Welcome to</span>
            <span style={{ display: "block", fontSize: 60 }}>Toolbox</span>
          </div>

          <UserPill user={user} loading={loading} />
        </div>

        {/* Card — the projects grid, full width. */}
        <div
          style={{
            height: "min(560px, 80vh)",
            background: "#0a0a0a",
            border: "1px solid #27272a",
            borderRadius: 8,
            boxShadow: "0 20px 60px rgba(0, 0, 0, 0.6)",
            overflow: "hidden",
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
            onLoadLocal={onLoadLocal}
            onNewProject={onNewProject}
          />
        </div>
      </div>
    </div>
  );
}

// ========================================================================
// account pill (top-right) — one long pill (avatar + name/email); clicking
// it opens a sign-out popover above. Signed-out shows a Google sign-in pill.
// ========================================================================

function UserPill({
  user,
  loading,
}: {
  user: ReturnType<typeof useUser>["user"];
  loading: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

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
    setOpen(false);
  };

  // Reserve height so the header row doesn't jump once auth resolves.
  if (loading) return <div style={{ height: 44, width: 120 }} />;

  if (!user) {
    return (
      <button
        onClick={signIn}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: 44,
          padding: "0 18px",
          background: "#fafafa",
          border: "none",
          borderRadius: 999,
          color: "#18181b",
          fontFamily: INTER,
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "#e5e7eb")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "#fafafa")}
      >
        <GoogleMark />
        Sign in with Google
      </button>
    );
  }

  const metaName =
    (user.user_metadata?.full_name as string | undefined) ??
    (user.user_metadata?.name as string | undefined);
  const avatarUrl = user.user_metadata?.avatar_url as string | undefined;
  const initials = (metaName ?? user.email ?? "?")
    .split(/[\s@]+/)[0]
    .slice(0, 2)
    .toUpperCase();

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          height: 44,
          padding: "0 16px 0 6px",
          background: "#0a0a0a",
          border: `1px solid ${open ? "#3f3f46" : "#27272a"}`,
          borderRadius: 999,
          cursor: "pointer",
          fontFamily: INTER,
          transition: "border-color 90ms",
        }}
      >
        {avatarUrl ? (
          <span
            style={{
              width: 32,
              height: 32,
              borderRadius: "50%",
              flexShrink: 0,
              background: `#18181b center/cover url(${avatarUrl})`,
            }}
          />
        ) : (
          <span
            style={{
              width: 32,
              height: 32,
              borderRadius: "50%",
              flexShrink: 0,
              background: "#3f3f46",
              color: "#e5e7eb",
              fontSize: 12,
              fontWeight: 600,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {initials}
          </span>
        )}
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "#e5e7eb",
            maxWidth: 200,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {metaName ?? "user"}
        </span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            bottom: "100%",
            right: 0,
            marginBottom: 6,
            minWidth: 160,
            background: "#18181b",
            border: "1px solid #27272a",
            borderRadius: 6,
            boxShadow: "0 6px 20px rgba(0, 0, 0, 0.5)",
            padding: 4,
          }}
        >
          <button
            onClick={signOut}
            style={{
              display: "block",
              width: "100%",
              padding: "6px 10px",
              background: "transparent",
              border: "none",
              color: "#e5e7eb",
              textAlign: "left",
              fontFamily: INTER,
              fontSize: 12,
              cursor: "pointer",
              borderRadius: 3,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "#27272a")}
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function AppleMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M11.18 8.48c-.02-1.5 1.22-2.22 1.28-2.26-.7-1.02-1.79-1.16-2.17-1.18-.92-.09-1.8.54-2.27.54-.47 0-1.19-.53-1.96-.51-1 .01-1.94.59-2.46 1.49-1.05 1.82-.27 4.5.75 5.98.5.72 1.09 1.53 1.87 1.5.75-.03 1.03-.48 1.94-.48.9 0 1.16.48 1.96.47.81-.01 1.32-.73 1.81-1.46.57-.83.81-1.64.82-1.68-.02-.01-1.57-.6-1.59-2.39-.01-.01 0 .01 0 .01l.29-.02zm-1.5-4.4c.41-.5.69-1.2.61-1.9-.59.02-1.31.4-1.74.9-.38.43-.71 1.13-.62 1.8.66.05 1.33-.34 1.75-.8z" />
    </svg>
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
