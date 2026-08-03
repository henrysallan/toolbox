"use client";

import { useEffect } from "react";
import type { MissingMedia } from "@/lib/media-relink";

// Centered relink dialog shown after a project load when some video/audio
// files couldn't be silently restored. Lists every missing clip with a
// per-item status that updates as relink attempts run:
//   missing — not tried yet (or picker was cancelled)
//   ok      — relinked into its node
//   failed  — attempted but no stored handle and no matching pick
// The Relink button runs the handle-prompt + manual-pick flow in
// EffectsApp; closing leaves unlinked nodes as-is (their file references
// still survive a re-save).

export type RelinkStatus = "missing" | "ok" | "failed";

export interface RelinkItem {
  media: MissingMedia;
  status: RelinkStatus;
}

function formatSize(bytes?: number): string | null {
  if (bytes == null || !Number.isFinite(bytes)) return null;
  if (bytes >= 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function StatusBadge({ status }: { status: RelinkStatus }) {
  const cfg =
    status === "ok"
      ? { glyph: "✓", label: "relinked", color: "var(--tb-a-green-400)" }
      : status === "failed"
        ? { glyph: "✕", label: "not found", color: "var(--tb-a-red-400)" }
        : { glyph: "•", label: "missing", color: "var(--tb-a-yellow-400)" };
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        color: cfg.color,
        fontSize: 10,
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      <span style={{ fontSize: 11 }}>{cfg.glyph}</span>
      {cfg.label}
    </span>
  );
}

export default function MediaRelinkModal({
  open,
  items,
  busy,
  onRelink,
  onClose,
}: {
  open: boolean;
  items: RelinkItem[];
  busy: boolean;
  onRelink: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const unresolved = items.filter((i) => i.status !== "ok").length;
  const allOk = unresolved === 0;

  return (
    <div
      onClick={onClose}
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
          minWidth: 420,
          maxWidth: 520,
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
          Missing media
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
          {allOk
            ? "All media relinked"
            : `${unresolved} file${unresolved === 1 ? "" : "s"} need${
                unresolved === 1 ? "s" : ""
              } relinking`}
        </div>
        <div style={{ color: "var(--tb-n-13)", lineHeight: 1.5, marginBottom: 12 }}>
          Media files aren&apos;t stored with the project. Relink reads them
          from disk — previously granted files reconnect automatically, the
          rest match by filename from one picker.
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            maxHeight: 260,
            overflowY: "auto",
            marginBottom: 14,
          }}
        >
          {items.map((it, i) => {
            const size = formatSize(it.media.envelope.size);
            return (
              <div
                key={`${it.media.nodeId}:${it.media.paramName}:${i}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 8px",
                  background: "var(--tb-n-5)",
                  border: "1px solid var(--tb-n-7)",
                  borderRadius: 4,
                }}
              >
                <span
                  style={{
                    color: "var(--tb-n-11)",
                    fontSize: 9,
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                    flexShrink: 0,
                    width: 34,
                  }}
                >
                  {it.media.envelope.kind === "video_file" ? "video" : "audio"}
                </span>
                <span
                  title={it.media.envelope.filename}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: it.status === "ok" ? "var(--tb-n-15)" : "var(--tb-n-16)",
                  }}
                >
                  {it.media.envelope.filename}
                </span>
                {size && (
                  <span
                    style={{
                      color: "var(--tb-n-10)",
                      fontSize: 10,
                      flexShrink: 0,
                    }}
                  >
                    {size}
                  </span>
                )}
                <StatusBadge status={it.status} />
              </div>
            );
          })}
        </div>

        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            style={{
              padding: "4px 10px",
              background: "transparent",
              border: "1px solid var(--tb-n-9)",
              color: "var(--tb-n-16)",
              fontFamily: "inherit",
              fontSize: 11,
              borderRadius: 3,
              cursor: "pointer",
            }}
          >
            {allOk ? "Done" : "Skip for now"}
          </button>
          {!allOk && (
            <button
              onClick={onRelink}
              disabled={busy}
              style={{
                padding: "4px 14px",
                background: busy ? "#1e3a8a80" : "var(--tb-a-blue-900)",
                border: "1px solid var(--tb-a-blue-700)",
                color: "var(--tb-a-blue-200)",
                fontFamily: "inherit",
                fontSize: 11,
                borderRadius: 3,
                cursor: busy ? "default" : "pointer",
              }}
            >
              {busy ? "Relinking…" : "Relink…"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
