"use client";

import { useEffect, useRef, useState } from "react";
import {
  clearRating,
  getOwnRating,
  setRating,
  type ProjectRow,
} from "@/lib/supabase/projects";

function liveLinkFor(slug: string): string {
  if (typeof window === "undefined") return `/live/${slug}`;
  return `${window.location.origin}/live/${slug}`;
}

// Floating popover anchored to client (screen) coords — opened from
// LoadGrid's right-click handler on a project tile. Loads the user's
// existing rating async so the stars seed correctly; submitting
// upserts via setRating() and triggers the parent's refresh callback
// so the tile picks up the new aggregate. "Clear" deletes the row
// entirely.
//
// One rating per user per project is enforced by the DB schema (PK on
// `(project_id, user_id)`), so the upsert path is safe to fire
// multiple times.

export interface RateProjectPopoverProps {
  // Anchor — client (viewport) pixel coordinates from the right-click
  // event. The popover positions itself relative to these and clamps
  // to stay on-screen.
  x: number;
  y: number;
  row: ProjectRow;
  signedIn: boolean;
  onClose: () => void;
  // Called after a successful rate / clear — parent should refresh
  // the listing so the tile's avg + count display the new values.
  onChanged: () => void;
  // Present only for the user's own projects — adds a manage section.
  // Rename swaps the row for an inline field; commit hands the trimmed
  // new name up. The optimistic row update + persistence live in the
  // parent (same split as the folder menu).
  onRename?: (name: string) => void;
  // Confirm + optimistic removal also live in the parent.
  onDelete?: () => void;
  // Own rows only (M2 shared projects): opens the Collaborators modal
  // (member list + invite link). The modal itself lives in the parent —
  // this popover closes when it opens.
  onCollaborators?: () => void;
}

const STARS = [1, 2, 3, 4, 5] as const;

export default function RateProjectPopover({
  x,
  y,
  row,
  signedIn,
  onClose,
  onChanged,
  onRename,
  onDelete,
  onCollaborators,
}: RateProjectPopoverProps) {
  const [ownRating, setOwnRating] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const liveSlug = row.is_public ? row.public_slug : null;
  const liveUrl = liveSlug ? liveLinkFor(liveSlug) : null;

  const copyLive = async () => {
    if (!liveUrl) return;
    try {
      await navigator.clipboard.writeText(liveUrl);
    } catch {
      // Fall back to a transient textarea selection — clipboard API
      // can be unavailable on insecure origins or during automated
      // tests. The visual confirmation still fires.
      const ta = document.createElement("textarea");
      ta.value = liveUrl;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        // ignore; UI still flips to "copied" so the user sees something
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  // Load existing rating on open. While it's pending we show the
  // popover with no stars filled — feels snappier than waiting on a
  // round-trip before rendering anything.
  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    getOwnRating(row.id).then((r) => {
      if (!cancelled) setOwnRating(r);
    });
    return () => {
      cancelled = true;
    };
  }, [row.id, signedIn]);

  // Click-outside + Escape dismiss.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as globalThis.Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const submit = async (n: number) => {
    if (!signedIn || busy) return;
    setBusy(true);
    const ok = await setRating(row.id, n);
    setBusy(false);
    if (ok) {
      setOwnRating(n);
      onChanged();
      onClose();
    }
  };

  const reset = async () => {
    if (!signedIn || busy || ownRating === null) return;
    setBusy(true);
    const ok = await clearRating(row.id);
    setBusy(false);
    if (ok) {
      setOwnRating(null);
      onChanged();
      onClose();
    }
  };

  // Clamp to viewport — prevents the popover from jutting off-screen
  // when the user right-clicks a tile near the bottom-right corner.
  // Height grows when the share / manage sections are rendered so we
  // still fit on small viewports.
  const manage = !!(onRename || onDelete || onCollaborators);
  const W = 240;
  const H =
    (liveUrl ? 180 : 120) + (manage ? 62 : 0) + (onCollaborators ? 24 : 0);
  const vw = typeof window !== "undefined" ? window.innerWidth : 0;
  const vh = typeof window !== "undefined" ? window.innerHeight : 0;
  const left = Math.max(8, Math.min(vw - W - 8, x));
  const top = Math.max(8, Math.min(vh - H - 8, y));

  const display = hovered ?? ownRating ?? 0;

  return (
    <div
      ref={rootRef}
      style={{
        position: "fixed",
        left,
        top,
        width: W,
        background: "var(--tb-n-3)",
        border: "1px solid var(--tb-n-7)",
        borderRadius: 4,
        boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
        padding: 10,
        zIndex: 4000,
        fontFamily: "var(--ui-font)",
        fontSize: 11,
        color: "var(--tb-n-16)",
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        // Right-click inside the popover shouldn't re-trigger the
        // tile's onContextMenu and re-open this popover.
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div
        style={{
          color: "var(--tb-n-13)",
          fontSize: 9,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          marginBottom: 4,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        Rate · {row.name}
      </div>
      {!signedIn ? (
        <div style={{ color: "var(--tb-n-11)", padding: "6px 0" }}>
          Sign in to rate.
        </div>
      ) : (
        <>
          <div
            style={{ display: "flex", gap: 2, marginBottom: 6 }}
            onMouseLeave={() => setHovered(null)}
          >
            {STARS.map((n) => (
              <button
                key={n}
                onClick={() => submit(n)}
                onMouseEnter={() => setHovered(n)}
                disabled={busy}
                aria-label={`${n} star${n === 1 ? "" : "s"}`}
                style={{
                  width: 28,
                  height: 28,
                  background: "transparent",
                  border: "none",
                  cursor: busy ? "wait" : "pointer",
                  color: n <= display ? "var(--tb-a-yellow-400)" : "var(--tb-n-9)",
                  fontSize: 22,
                  lineHeight: "22px",
                  padding: 0,
                  fontFamily: "inherit",
                }}
              >
                ★
              </button>
            ))}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 6,
              fontSize: 10,
              color: "var(--tb-n-11)",
            }}
          >
            <span>
              {row.ratings_count > 0
                ? `Avg ${(row.ratings_avg ?? 0).toFixed(1)} (${row.ratings_count})`
                : "No ratings yet"}
            </span>
            {ownRating !== null && (
              <button
                onClick={reset}
                disabled={busy}
                style={{
                  background: "transparent",
                  border: "1px solid var(--tb-n-9)",
                  color: "var(--tb-n-13)",
                  fontSize: 9,
                  padding: "2px 6px",
                  borderRadius: 3,
                  cursor: busy ? "wait" : "pointer",
                  fontFamily: "inherit",
                }}
              >
                Clear
              </button>
            )}
          </div>
        </>
      )}
      {liveUrl && (
        <div
          style={{
            marginTop: 10,
            paddingTop: 10,
            borderTop: "1px solid var(--tb-n-7)",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <div
            style={{
              color: "var(--tb-n-13)",
              fontSize: 9,
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            Live link
          </div>
          <div
            style={{
              fontSize: 10,
              color: "var(--tb-n-13)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={liveUrl}
          >
            {liveUrl.replace(/^https?:\/\//, "")}
          </div>
          <button
            onClick={copyLive}
            style={{
              alignSelf: "flex-start",
              background: copied ? "var(--tb-a-emerald-800)" : "transparent",
              border: `1px solid ${copied ? "var(--tb-a-emerald-800)" : "var(--tb-n-9)"}`,
              color: copied ? "var(--tb-a-emerald-200)" : "var(--tb-n-16)",
              fontSize: 10,
              padding: "2px 8px",
              borderRadius: 3,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            {copied ? "Copied" : "Copy live link"}
          </button>
        </div>
      )}
      {!liveUrl && row.is_public === false && (
        <div
          style={{
            marginTop: 10,
            paddingTop: 10,
            borderTop: "1px solid var(--tb-n-7)",
            color: "var(--tb-n-10)",
            fontSize: 10,
          }}
        >
          Make this project public to get a shareable live link.
        </div>
      )}
      {manage && (
        <div
          style={{
            marginTop: 10,
            paddingTop: 6,
            borderTop: "1px solid var(--tb-n-7)",
            display: "flex",
            flexDirection: "column",
            gap: 1,
          }}
        >
          {onCollaborators && (
            <ActionRow
              label="Collaborators…"
              onClick={() => {
                // Close first — the modal renders from the parent, and
                // stacking it under a live popover reads as broken.
                onClose();
                onCollaborators();
              }}
            />
          )}
          {onRename &&
            (renaming ? (
              <RenameField
                initial={row.name}
                onCommit={(name) => {
                  setRenaming(false);
                  const trimmed = name.trim();
                  if (!trimmed || trimmed === row.name) return;
                  onRename(trimmed);
                  onClose();
                }}
                onCancel={() => setRenaming(false)}
              />
            ) : (
              <ActionRow label="Rename" onClick={() => setRenaming(true)} />
            ))}
          {onDelete && (
            <ActionRow
              label="Delete…"
              danger
              onClick={() => {
                // Close first so the parent's window.confirm doesn't
                // block with the popover still up — same order as the
                // folder menu.
                onClose();
                onDelete();
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

// Menu-style row for the manage section — mirrors the folder context
// menu's items (LoadGrid's FolderMenuPopover) so both right-click menus
// read as one family.
function ActionRow({
  label,
  danger,
  onClick,
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  const [hot, setHot] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        background: hot
          ? danger
            ? "var(--tb-t-red-d-1)"
            : "var(--tb-n-6)"
          : "transparent",
        border: "none",
        borderRadius: 3,
        color: danger ? "var(--tb-a-red-400)" : "var(--tb-n-16)",
        fontFamily: "inherit",
        fontSize: 11,
        padding: "5px 8px",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

// Inline rename field — same commit contract as LoadGrid's
// FolderNameInput: Enter/blur commit once, Escape cancels. Escape stops
// propagation so it cancels the rename without also closing the popover
// (the popover's window-level key listener sits behind it).
function RenameField({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const doneRef = useRef(false);
  const finish = (fn: () => void) => {
    if (doneRef.current) return;
    doneRef.current = true;
    fn();
  };
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(() => onCommit(value));
        else if (e.key === "Escape") finish(onCancel);
      }}
      onBlur={() => finish(() => onCommit(value))}
      style={{
        width: "100%",
        boxSizing: "border-box",
        background: "var(--tb-n-1)",
        border: "1px solid var(--tb-a-navy-tint)",
        borderRadius: 3,
        color: "var(--tb-n-16)",
        fontFamily: "inherit",
        fontSize: 11,
        padding: "4px 7px",
        outline: "none",
      }}
    />
  );
}
