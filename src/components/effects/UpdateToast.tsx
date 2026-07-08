"use client";

import type { UpdatePhase } from "./useDesktopUpdates";

// Corner progress toast for the desktop auto-update flow (spec 070826).
// Rendered by MenuBar; shown while an update downloads (bar + % + speed) and
// once it's ready (Restart button). Dismissable — the download keeps going and
// the Toolbox menu item still reflects the state.
export default function UpdateToast({
  status,
  onInstall,
  onDismiss,
}: {
  status: UpdatePhase;
  onInstall: () => void;
  onDismiss: () => void;
}) {
  if (status.phase !== "downloading" && status.phase !== "ready") return null;
  const downloading = status.phase === "downloading";
  return (
    <div
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 2000,
        width: 260,
        background: "#18181b",
        border: "1px solid #27272a",
        borderRadius: 6,
        boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
        padding: "10px 12px",
        fontFamily: "ui-monospace, monospace",
        fontSize: 11,
        color: "#e5e7eb",
        userSelect: "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>
          {downloading
            ? "Updating Toolbox…"
            : `Update ready${status.version ? ` — v${status.version}` : ""}`}
        </span>
        <button
          aria-label="Dismiss"
          title="Dismiss"
          onClick={onDismiss}
          style={{
            background: "transparent",
            border: "none",
            color: "#71717a",
            cursor: "default",
            fontSize: 12,
            padding: "0 0 0 8px",
            lineHeight: 1,
          }}
        >
          ✕
        </button>
      </div>
      {downloading ? (
        <>
          <div
            style={{
              marginTop: 8,
              height: 4,
              borderRadius: 2,
              background: "#27272a",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${Math.max(0, Math.min(100, status.percent))}%`,
                height: "100%",
                background: "#3b82f6",
                transition: "width 200ms linear",
              }}
            />
          </div>
          <div
            style={{
              marginTop: 6,
              display: "flex",
              justifyContent: "space-between",
              color: "#71717a",
              fontSize: 10,
            }}
          >
            <span>{Math.round(status.percent)}%</span>
            <span>{(status.bytesPerSecond / 1048576).toFixed(1)} MB/s</span>
          </div>
        </>
      ) : (
        <button
          onClick={onInstall}
          style={{
            marginTop: 10,
            width: "100%",
            padding: "5px 0",
            background: "#1e3a8a",
            border: "none",
            borderRadius: 4,
            color: "#e5e7eb",
            fontFamily: "inherit",
            fontSize: 11,
            cursor: "default",
          }}
        >
          Restart to Update
        </button>
      )}
    </div>
  );
}
