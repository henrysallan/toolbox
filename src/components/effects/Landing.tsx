"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useUser } from "@/lib/auth-context";
import { platform } from "@/lib/platform";
import { setGatewayInputLock } from "@/lib/shortcut-freeze";
import LoadGrid from "./LoadGrid";
import WindowControls from "./WindowControls";

interface Props {
  // Open a saved project by id (reuses the editor's load path).
  onLoad: (id: string) => void;
  // Open a recent local .toolbox by path (desktop Local tab).
  onLoadLocal?: (path: string) => void;
  // Start a fresh, empty project.
  onNewProject: () => void;
  // Present only when the landing was re-opened over a live editor
  // (Toolbox menu → the version row). Dismisses it without touching the
  // loaded project; absent on the first-load gateway, where there is no
  // project to go back to. Also switches off the boot veil — the editor
  // behind is already painted, so covering it would just flash dark.
  onClose?: () => void;
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
// Version-less asset names so the "latest release" redirect is a stable URL.
const DOWNLOAD_MAC =
  "https://github.com/henrysallan/toolbox/releases/latest/download/Toolbox-arm64.dmg";
const DOWNLOAD_WIN =
  "https://github.com/henrysallan/toolbox/releases/latest/download/Toolbox-Setup.exe";

// First-load gateway: the reused Projects grid in a centred card, with a
// header row floating just above it — a "Welcome to Toolbox" pill (and, on
// web, a greyed Mac Download button) on the left, the account pill on the
// right. Sits on top of the (already mounted) editor; selecting a project
// or "New Project" dismisses it.
export default function Landing({
  onLoad,
  onLoadLocal,
  onNewProject,
  onClose,
}: Props) {
  const { user, loading } = useUser();
  const signedIn = !!user;

  // Fade the card in on mount so the gateway doesn't pop.
  const [shown, setShown] = useState(false);
  // Two-phase backdrop: starts as a near-opaque dark veil (hides the
  // editor booting), then lightens to a translucent heavy blur once the
  // editor has had a moment to settle. A re-open skips straight to the
  // translucent state — there's nothing booting to hide.
  const [revealed, setRevealed] = useState(!!onClose);
  // The Mac Download button is web-only. Detect native post-mount to avoid
  // an SSR hydration mismatch (renders nothing until we know).
  const [isWeb, setIsWeb] = useState(false);
  // Windows caption buttons sit top-right; macOS traffic lights top-left.
  const [isWindows, setIsWindows] = useState(false);
  // Web download button: lead with the visitor's OS (sniffed from navigator).
  const [downloadWin, setDownloadWin] = useState(false);
  // Maximize toggle: grows the projects card to near-fullscreen. The
  // maximized width/height below are sized so the header's pills clear the
  // web download cluster (top-right) and the card bottom clears the privacy
  // link (bottom-left) — see the clearance math at each value.
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    const t = setTimeout(() => setRevealed(true), REVEAL_DELAY_MS);
    setIsWeb(!platform.isNative);
    setIsWindows(platform.isNative && platform.os === "windows");
    setDownloadWin(platform.os === "windows");
    return () => {
      cancelAnimationFrame(id);
      clearTimeout(t);
    };
  }, []);

  // The editor stays mounted (and interactive) behind the veil: its
  // hotkeys, clipboard paste, wheel-pan and middle-click handlers all
  // listen on `window`, and the wheel/middle-click ones hit-test the
  // cursor against viewport rects — DOM occlusion doesn't protect them.
  // Lock all of that out at the capture phase for as long as the landing
  // is up (shortcut-freeze.ts). Blur whatever held focus so keystrokes
  // can't keep typing into an editor field behind the veil — the gate
  // deliberately exempts editable targets so the landing's own rename
  // fields keep working.
  useEffect(() => {
    setGatewayInputLock(true);
    (document.activeElement as HTMLElement | null)?.blur?.();
    return () => setGatewayInputLock(false);
  }, []);

  // Escape backs out to the project underneath (re-open only). Bubble
  // phase, so anything that stops propagation first — the folder rename
  // field in the grid — still gets Escape to itself.
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (t?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName ?? ""))
        return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        // Above the whole editor chrome ladder (080226_timeline-modal-panel.md
        // §Z-order: timeline dock 900, PlaybackBar 950, MenuBar 1000) and below
        // the blocking dialogs at 2000. A bare 50 used to work only because the
        // landing paints later in DOM order than the un-z-indexed chrome — once
        // the timeline dock and PlaybackBar took explicit z-indexes they began
        // punching through the veil.
        zIndex: 1500,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        // Opaque veil while initializing → translucent once revealed. The
        // blur stays constant (heavy) so only the veil's alpha animates,
        // which is far smoother than transitioning the blur itself.
        //
        // The revealed veil rides --tb-sink rather than a fixed black, so it
        // pushes the editor AWAY from the foreground in whichever direction
        // the theme wants: darker under dark mode, lighter under light. A
        // black scrim over a light editor just looked like a dimmed screen.
        background: revealed
          ? "color-mix(in srgb, var(--tb-sink) 35%, transparent)"
          : "color-mix(in srgb, var(--tb-n-0) 97%, transparent)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        transition: "background-color 600ms ease",
        fontFamily: "var(--ui-font)",
      }}
    >
      {/* Window controls (frameless desktop) — the menu bar is hidden behind
          the landing, so surface them here at the same corner the menu bar uses:
          top-left on macOS (traffic lights), top-right on Windows (caption
          buttons). Self-gates to native; null on web. */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: isWindows ? undefined : 0,
          right: isWindows ? 0 : undefined,
          height: isWindows ? 32 : 22,
          display: "flex",
          alignItems: "center",
          zIndex: 10,
        }}
      >
        <WindowControls />
      </div>

      {/* Download — pinned to the browser window's upper-right corner (web
          only). Leads with the visitor's OS; the other platform sits below as a
          quieter link so both builds stay one click away. */}
      {isWeb && (
        <div
          style={{
            position: "absolute",
            top: 16,
            right: 16,
            zIndex: 10,
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: 6,
          }}
        >
          <DownloadPill
            href={downloadWin ? DOWNLOAD_WIN : DOWNLOAD_MAC}
            os={downloadWin ? "windows" : "mac"}
          />
          <a
            href={downloadWin ? DOWNLOAD_MAC : DOWNLOAD_WIN}
            title={
              downloadWin
                ? "Download Toolbox for macOS (Apple Silicon)"
                : "Download Toolbox for Windows (x64)"
            }
            style={{
              fontFamily: INTER,
              fontSize: 11,
              color: "var(--tb-n-11)",
              textDecoration: "none",
              cursor: "pointer",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--tb-n-15)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--tb-n-11)";
            }}
          >
            Also for {downloadWin ? "macOS" : "Windows"}
          </a>
        </div>
      )}

      {/* Privacy policy — quiet corner link, mirroring the download
          cluster's inset. Plain <Link> (same rationale as DocsInfoButton):
          client-side nav to the docs, native middle/Cmd-click behavior. */}
      <Link
        href="/docs/privacy"
        style={{
          position: "absolute",
          bottom: 16,
          left: 16,
          zIndex: 10,
          fontFamily: INTER,
          fontSize: 11,
          color: "color-mix(in srgb, var(--tb-n-11) 55%, transparent)",
          textDecoration: "none",
          cursor: "pointer",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = "var(--tb-n-13)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color =
            "color-mix(in srgb, var(--tb-n-11) 55%, transparent)";
        }}
      >
        Privacy policy
      </Link>

      {/* Maximize toggle — upper-left green circle, borrowing the macOS
          traffic-light green (WindowControls' fullscreen light) so it reads
          as a zoom control. On native macOS it sits BELOW the real traffic
          lights (strip is 22px tall) so it doesn't read as a fourth light. */}
      <button
        onClick={() => setMaximized((v) => !v)}
        title={maximized ? "Restore size" : "Expand projects browser"}
        aria-label={
          maximized ? "Restore projects browser size" : "Expand projects browser"
        }
        style={{
          position: "absolute",
          top: isWeb || isWindows ? 16 : 34,
          left: 16,
          zIndex: 10,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "#28c840",
          border: "1px solid rgba(0, 0, 0, 0.15)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          cursor: "pointer",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "#1aab29")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "#28c840")}
      >
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden>
          <path
            d={maximized ? "M1 4h6" : "M4 1v6M1 4h6"}
            stroke="#0d5c16"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          // Maximized: 16px inset each side, matching the corner links.
          width: maximized ? "calc(100vw - 32px)" : "min(900px, 92vw)",
          opacity: shown ? 1 : 0,
          // `undefined` (not translateY(0)) once shown: a live transform
          // would make this wrapper the containing block for the grid's
          // position:fixed overlays (context menus, drag ghost), shifting
          // them by the wrapper's offset from the viewport origin.
          transform: shown ? undefined : "translateY(8px)",
          transition: "opacity 220ms ease, transform 220ms ease, width 240ms ease",
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
              color: "var(--tb-n-17)",
              whiteSpace: "nowrap",
              letterSpacing: -0.5,
              lineHeight: 1.02,
            }}
          >
            <span style={{ display: "block", fontSize: 20 }}>Welcome to</span>
            <span style={{ display: "block", fontSize: 60 }}>Toolbox</span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {onClose && <BackPill onClick={onClose} />}
            <UserPill user={user} loading={loading} />
          </div>
        </div>

        {/* Card — the projects grid, full width. */}
        <div
          style={{
            // Maximized: 100vh minus 200px of chrome. The wrapper is
            // flex-centered, so with the 94px header that leaves 53px
            // margins top and bottom — the header's right-side pills
            // (y≈91–135) clear the web download cluster (ends y≈76), and
            // the card bottom stays ~23px above the privacy link. The
            // outer max() means a short window never shrinks below the
            // normal size.
            height: maximized
              ? "max(min(560px, 80vh), calc(100vh - 200px))"
              : "min(560px, 80vh)",
            transition: "height 240ms ease",
            background: "var(--tb-n-0)",
            border: "1px solid var(--tb-n-7)",
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

// Escape hatch shown only when the landing was re-opened over a live
// editor: leaves the loaded project exactly as it was. Sized to the
// account pill beside it.
function BackPill({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="Return to the current project (Esc)"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        height: 44,
        padding: "0 16px",
        background: "transparent",
        border: "1px solid var(--tb-n-7)",
        borderRadius: 999,
        fontFamily: INTER,
        fontWeight: 500,
        fontSize: 13,
        color: "var(--tb-n-15)",
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--tb-n-9)";
        e.currentTarget.style.color = "var(--tb-n-17)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--tb-n-7)";
        e.currentTarget.style.color = "var(--tb-n-15)";
      }}
    >
      <svg width="13" height="13" viewBox="0 0 12 12" fill="none" aria-hidden>
        <path
          d="M7.5 2 3.5 6l4 4"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      Back to project
    </button>
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
          background: "var(--tb-n-17)",
          border: "none",
          borderRadius: 999,
          color: "var(--tb-n-3)",
          fontFamily: INTER,
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--tb-n-16)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "var(--tb-n-17)")}
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
          background: "var(--tb-n-0)",
          border: `1px solid ${open ? "var(--tb-n-9)" : "var(--tb-n-7)"}`,
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
              background: `var(--tb-n-3) center/cover url(${avatarUrl})`,
            }}
          />
        ) : (
          <span
            style={{
              width: 32,
              height: 32,
              borderRadius: "50%",
              flexShrink: 0,
              background: "var(--tb-n-9)",
              color: "var(--tb-n-16)",
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
            color: "var(--tb-n-16)",
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
            background: "var(--tb-n-3)",
            border: "1px solid var(--tb-n-7)",
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
              color: "var(--tb-n-16)",
              textAlign: "left",
              fontFamily: INTER,
              fontSize: 12,
              cursor: "pointer",
              borderRadius: 3,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--tb-n-7)")}
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

// The primary download button — a rounded pill matching the visitor's OS.
function DownloadPill({ href, os }: { href: string; os: "mac" | "windows" }) {
  const isWin = os === "windows";
  return (
    <a
      href={href}
      title={
        isWin
          ? "Download Toolbox for Windows (x64)"
          : "Download Toolbox for macOS (Apple Silicon)"
      }
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        height: 40,
        padding: "0 16px",
        background: "transparent",
        border: "1px solid var(--tb-n-9)",
        borderRadius: 999,
        fontFamily: INTER,
        fontWeight: 500,
        fontSize: 13,
        color: "var(--tb-n-15)",
        cursor: "pointer",
        textDecoration: "none",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--tb-n-3)";
        e.currentTarget.style.color = "var(--tb-n-17)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = "var(--tb-n-15)";
      }}
    >
      {isWin ? <WindowsMark /> : <AppleMark />}
      Download for {isWin ? "Windows" : "macOS"}
    </a>
  );
}

function WindowsMark() {
  // Simplified four-pane Windows mark, monochrome to match AppleMark.
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M0 0h7v7H0zM9 0h7v7H9zM0 9h7v7H0zM9 9h7v7H9z" />
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
