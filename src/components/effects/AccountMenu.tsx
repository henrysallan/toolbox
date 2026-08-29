"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useUser } from "@/lib/auth-context";

export default function AccountMenu() {
  const { user, loading } = useUser();
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
    const origin =
      typeof window !== "undefined" ? window.location.origin : "";
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

  // Avoid the "signed out" flash on first render by hiding until we know.
  if (loading) {
    return <div style={{ width: 60 }} />;
  }

  if (!user) {
    return (
      <button
        className="menubar-pill"
        onMouseDown={(e) => e.preventDefault()}
        onClick={signIn}
        style={{
          padding: "0 10px",
          color: "var(--tb-n-15)",
          border: "none",
          fontFamily: "inherit",
          fontSize: "inherit",
          cursor: "default",
        }}
      >
        Sign in
      </button>
    );
  }

  const metaName =
    (user.user_metadata?.full_name as string | undefined) ??
    (user.user_metadata?.name as string | undefined);
  const label = metaName ?? user.email ?? "user";
  const avatarUrl = user.user_metadata?.avatar_url as string | undefined;
  const initials = (metaName ?? user.email ?? "?")
    .split(/[\s@]+/)[0]
    .slice(0, 2)
    .toUpperCase();

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        className={`menubar-pill${open ? " is-open" : ""}`}
        onMouseDown={(e) => {
          e.preventDefault();
          setOpen((v) => !v);
        }}
        style={{
          padding: "0 10px",
          color: "var(--tb-n-16)",
          border: "none",
          fontFamily: "inherit",
          fontSize: "inherit",
          cursor: "default",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {avatarUrl ? (
          <span
            style={{
              width: 16,
              height: 16,
              borderRadius: "50%",
              background: `var(--tb-n-3) center/cover url(${avatarUrl})`,
            }}
          />
        ) : (
          <span
            style={{
              width: 16,
              height: 16,
              borderRadius: "50%",
              background: "var(--tb-n-9)",
              color: "var(--tb-n-16)",
              fontSize: 9,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 600,
            }}
          >
            {initials}
          </span>
        )}
        <span style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {label}
        </span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            minWidth: 220,
            background: "var(--tb-n-3)",
            border: "1px solid var(--tb-n-7)",
            borderRadius: 8,
            boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
            padding: 4,
            marginTop: 2,
          }}
        >
          <div
            style={{
              padding: "4px 10px",
              color: "var(--tb-n-11)",
              fontSize: 10,
              wordBreak: "break-all",
            }}
          >
            {user.email}
          </div>
          <div style={{ height: 1, background: "var(--tb-n-7)", margin: "4px 0" }} />
          <button
            onClick={signOut}
            style={{
              display: "block",
              width: "100%",
              padding: "4px 10px",
              boxSizing: "border-box",
              background: "transparent",
              border: "1px solid transparent",
              color: "var(--tb-n-16)",
              textAlign: "left",
              fontFamily: "inherit",
              fontSize: 11,
              cursor: "default",
              borderRadius: 5,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--tb-n-5)";
              e.currentTarget.style.borderColor = "var(--tb-n-12)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.borderColor = "transparent";
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
