"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useUser } from "@/lib/auth-context";
import { useOwnHandle } from "@/lib/use-own-handle";
import { claimHandle, clearOwnHandleCache } from "@/lib/supabase/profiles";
import {
  describeHandleProblem,
  normalizeHandle,
} from "@/lib/vanity-slug";

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
    clearOwnHandleCache();
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
          <HandleRow />
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

// The user's profile handle — the "@hallan" half of a named live link
// (specdocs/092126_vanity-live-links.md). Seeded from the email at signup;
// editable here. Enter / Save commits, Escape cancels. "Taken" comes from
// the DB's unique index; shape problems are caught client-side first.
function HandleRow() {
  const { handle, loaded } = useOwnHandle();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      const t = setTimeout(() => inputRef.current?.select(), 20);
      return () => clearTimeout(t);
    }
  }, [editing]);

  const begin = () => {
    setDraft(handle ?? "");
    setError(null);
    setEditing(true);
  };
  const cancel = () => {
    setEditing(false);
    setError(null);
  };
  const commit = async () => {
    if (busy) return;
    const norm = normalizeHandle(draft);
    if (!norm.ok) {
      setError(describeHandleProblem(norm.problem));
      return;
    }
    if (norm.handle === handle) {
      cancel();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await claimHandle(norm.handle);
      if (res.ok) {
        setEditing(false);
        return;
      }
      switch (res.reason) {
        case "taken":
          setError("That handle is taken.");
          break;
        case "invalid":
          setError(
            res.problem
              ? describeHandleProblem(res.problem)
              : "That handle isn't valid."
          );
          break;
        case "migration":
          setError("Handles aren't enabled on this database yet.");
          break;
        case "signed-out":
          setError("Sign in again to change your handle.");
          break;
        default:
          setError("Couldn't save the handle. Try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  // The live preview of what will be stored, as the user types.
  const preview = editing ? normalizeHandle(draft) : null;

  return (
    <div
      style={{
        padding: "2px 10px 6px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontSize: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span style={{ color: "var(--tb-n-11)" }}>handle</span>
        {!editing && (
          <button
            type="button"
            onClick={begin}
            title="Your handle is the @name in named live links: toolbox.design/@handle/project"
            style={{
              background: "transparent",
              border: "1px solid var(--tb-n-9)",
              color: "var(--tb-n-15)",
              fontFamily: "inherit",
              fontSize: 10,
              padding: "1px 8px",
              borderRadius: 999,
              cursor: "pointer",
            }}
          >
            {handle ? "Change" : "Claim"}
          </button>
        )}
      </div>
      {!editing ? (
        <div
          style={{
            color: handle ? "var(--tb-n-16)" : "var(--tb-n-10)",
            fontFamily: "var(--mono-font, ui-monospace, monospace)",
            fontSize: 11,
            wordBreak: "break-all",
          }}
        >
          {!loaded ? "…" : handle ? `@${handle}` : "no handle yet"}
        </div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ color: "var(--tb-n-12)" }}>@</span>
            <input
              ref={inputRef}
              value={draft}
              disabled={busy}
              onChange={(e) => {
                setDraft(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancel();
                }
              }}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              aria-label="Handle"
              style={{
                flex: 1,
                minWidth: 0,
                background: "var(--tb-n-0)",
                border: "1px solid var(--tb-n-7)",
                borderRadius: 6,
                color: "var(--tb-n-16)",
                fontFamily: "var(--mono-font, ui-monospace, monospace)",
                fontSize: 11,
                padding: "3px 6px",
                outline: "none",
              }}
            />
          </div>
          {preview && preview.ok && preview.handle !== draft.trim() && (
            <div style={{ color: "var(--tb-n-11)" }}>
              will be saved as <span style={{ color: "var(--tb-n-14)" }}>@{preview.handle}</span>
            </div>
          )}
          {error && <div style={{ color: "var(--tb-a-red-400)" }}>{error}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 4 }}>
            <button
              type="button"
              onClick={cancel}
              disabled={busy}
              style={{
                background: "transparent",
                border: "1px solid var(--tb-n-9)",
                color: "var(--tb-n-15)",
                fontFamily: "inherit",
                fontSize: 10,
                padding: "2px 8px",
                borderRadius: 999,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void commit()}
              disabled={busy}
              style={{
                background: "var(--tb-a-green-600)",
                border: "1px solid var(--tb-a-green-600)",
                color: "var(--tb-a-green-100)",
                fontFamily: "inherit",
                fontSize: 10,
                padding: "2px 10px",
                borderRadius: 999,
                cursor: "pointer",
                opacity: busy ? 0.6 : 1,
              }}
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
