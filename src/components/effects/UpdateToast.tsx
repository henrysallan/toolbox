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
        background: "var(--tb-n-3)",
        border: "1px solid var(--tb-n-7)",
        borderRadius: 6,
        boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
        padding: "10px 12px",
        fontFamily: "var(--ui-font)",
        fontSize: 11,
        color: "var(--tb-n-16)",
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
            color: "var(--tb-n-11)",
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
              background: "var(--tb-n-7)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${Math.max(0, Math.min(100, status.percent))}%`,
                height: "100%",
                background: "var(--tb-a-blue-500)",
                transition: "width 200ms linear",
              }}
            />
          </div>
          <div
            style={{
              marginTop: 6,
              display: "flex",
              justifyContent: "space-between",
              color: "var(--tb-n-11)",
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
            background: "var(--tb-a-blue-900)",
            border: "none",
            borderRadius: 4,
            color: "var(--tb-n-16)",
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
