"use client";

import { useEffect } from "react";

// UI for the M3 advisory editing lease
// (specdocs/081426_shared-projects.md):
//
//   LeaseHeldDialog — shown right after opening a collaborative project
//     someone else is actively editing. Two ways out, neither blocking:
//     Open anyway (watch banner, saves will likely conflict) or Take
//     over (steal the lease — the other side learns at its next
//     heartbeat; it is protected by the save CAS, not the lease).
//
//   LeaseBanner — persistent strip under the menu bar: "watching"
//     (someone else is editing) or "lost" (someone took over while this
//     editor held the lease — Save a copy is the safe move).
//
// Both are advisory chrome — nothing here gates any action.

function timeAgo(iso: string | null): string | null {
  if (!iso) return null;
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(min) || min < 0) return null;
  if (min < 1) return "just now";
  if (min === 1) return "a minute ago";
  return `${min} minutes ago`;
}

export function LeaseHeldDialog({
  holderName,
  renewedAt,
  busy,
  onOpenAnyway,
  onTakeOver,
}: {
  holderName: string | null;
  renewedAt: string | null;
  busy: boolean;
  onOpenAnyway: () => void;
  onTakeOver: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenAnyway();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpenAnyway]);

  const who = holderName ?? "Someone";
  const when = timeAgo(renewedAt);

  return (
    <div
      onClick={busy ? undefined : onOpenAnyway}
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
          maxWidth: 460,
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
          Someone is editing
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
          {who} is editing this project{when ? ` (active ${when})` : ""}.
        </div>
        <div
          style={{ color: "var(--tb-n-13)", lineHeight: 1.5, marginBottom: 14 }}
        >
          You can open it anyway — saving will likely conflict with
          their work — or take over editing. Taking over doesn&apos;t
          block them; their next save resolves through the conflict
          dialog.
        </div>
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          <button
            onClick={onOpenAnyway}
            disabled={busy}
            style={btnStyle(busy)}
          >
            Open anyway
          </button>
          <button
            onClick={onTakeOver}
            disabled={busy}
            style={{
              ...btnStyle(busy),
              background: "var(--tb-a-green-600)",
              border: "1px solid var(--tb-a-green-600)",
              color: "var(--tb-a-green-100)",
            }}
          >
            Take over
          </button>
        </div>
      </div>
    </div>
  );
}

export function LeaseBanner({
  kind,
  name,
  onDismiss,
}: {
  kind: "watching" | "lost";
  name: string | null;
  onDismiss: () => void;
}) {
  const who = name ?? "Someone";
  const text =
    kind === "watching"
      ? `${who} is editing this project — saving will likely conflict.`
      : `${who} took over editing — Save a copy to keep your changes safe.`;
  const accent =
    kind === "watching" ? "var(--tb-a-yellow-400)" : "var(--tb-a-red-400)";
  return (
    <div
      style={{
        position: "fixed",
        top: 44,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        alignItems: "center",
        gap: 8,
        background: "var(--tb-n-3)",
        border: `1px solid var(--tb-n-7)`,
        borderLeft: `3px solid ${accent}`,
        borderRadius: 4,
        padding: "6px 10px",
        fontFamily: "var(--ui-font)",
        fontSize: 11,
        color: "var(--tb-n-16)",
        boxShadow: "0 6px 20px rgba(0,0,0,0.4)",
        zIndex: 1500,
        maxWidth: "70vw",
      }}
    >
      <span style={{ color: accent }}>●</span>
      <span>{text}</span>
      <button
        onClick={onDismiss}
        title="Dismiss"
        style={{
          background: "transparent",
          border: "none",
          color: "var(--tb-n-11)",
          fontFamily: "inherit",
          fontSize: 12,
          cursor: "pointer",
          padding: "0 2px",
        }}
      >
        ×
      </button>
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
