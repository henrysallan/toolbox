"use client";

import { useEffect, useRef, useState } from "react";
import {
  clearRating,
  getOwnRating,
  setRating,
  type ProjectRow,
} from "@/lib/supabase/projects";

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
}

const STARS = [1, 2, 3, 4, 5] as const;

export default function RateProjectPopover({
  x,
  y,
  row,
  signedIn,
  onClose,
  onChanged,
}: RateProjectPopoverProps) {
  const [ownRating, setOwnRating] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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
  const W = 220;
  const H = 110;
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
        background: "#18181b",
        border: "1px solid #27272a",
        borderRadius: 4,
        boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
        padding: 10,
        zIndex: 4000,
        fontFamily: "ui-monospace, monospace",
        fontSize: 11,
        color: "#e5e7eb",
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
          color: "#a1a1aa",
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
        <div style={{ color: "#71717a", padding: "6px 0" }}>
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
                  color: n <= display ? "#facc15" : "#3f3f46",
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
              color: "#71717a",
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
                  border: "1px solid #3f3f46",
                  color: "#a1a1aa",
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
    </div>
  );
}
