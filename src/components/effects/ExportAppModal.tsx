"use client";

import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import type { ExportManifest, ExportWarning } from "@/lib/export-manifest";

interface Props {
  open: boolean;
  onClose: () => void;
  initialAppName: string;
  initialDescription?: string;
  outputNode: { id: string; name: string };
  altOutputNode?: { id: string; name: string } | null;
  onPickOutputNode?: (id: string) => void;
  manifest: ExportManifest;
  warnings: ExportWarning[];
  estimatedSizeBytes: number;
  busy: boolean;
  onExport: (args: { appName: string; description?: string }) => void;
}

const SIZE_CAP_BYTES = 25 * 1024 * 1024;

export default function ExportAppModal(props: Props): JSX.Element | null {
  const {
    open,
    onClose,
    initialAppName,
    initialDescription,
    outputNode,
    altOutputNode,
    onPickOutputNode,
    manifest,
    warnings,
    estimatedSizeBytes,
    busy,
    onExport,
  } = props;

  const [appName, setAppName] = useState(initialAppName);
  const [description, setDescription] = useState(initialDescription ?? "");
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open && !wasOpen.current) {
      setAppName(initialAppName);
      setDescription(initialDescription ?? "");
    }
    wasOpen.current = open;
  }, [open, initialAppName, initialDescription]);

  useEffect(() => {
    if (!open) return;
    // Esc → close (only while modal is open).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const overSize = estimatedSizeBytes >= SIZE_CAP_BYTES;
  const trimmedName = appName.trim();
  const exportDisabled = busy || overSize || trimmedName.length === 0;

  const submit = () => {
    if (exportDisabled) return;
    onExport({
      appName: trimmedName,
      description: description.trim().length > 0 ? description.trim() : undefined,
    });
  };

  const sizeMb = (estimatedSizeBytes / 1024 / 1024).toFixed(2);
  const visibleWarnings = warnings.filter((w) => w.kind !== "no-controls");

  return (
    <div
      // Backdrop click → close.
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
          width: 460,
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "calc(100vh - 32px)",
          overflowY: "auto",
          background: "#18181b",
          border: "1px solid #27272a",
          borderRadius: 6,
          padding: 16,
          fontFamily: "ui-monospace, monospace",
          fontSize: 11,
          color: "#e5e7eb",
          boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 12,
          }}
        >
          <div
            style={{
              color: "#a1a1aa",
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: 1,
            }}
          >
            Export App
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "transparent",
              border: "1px solid #3f3f46",
              color: "#a1a1aa",
              fontFamily: "inherit",
              fontSize: 11,
              borderRadius: 3,
              padding: "0 6px",
              lineHeight: "16px",
              cursor: "pointer",
            }}
          >
            ×
          </button>
        </div>

        <div style={{ marginBottom: 10 }}>
          <div style={labelStyle()}>Name</div>
          <input
            type="text"
            value={appName}
            onChange={(e) => setAppName(e.target.value)}
            spellCheck={false}
            style={inputStyle()}
          />
        </div>

        <div style={{ marginBottom: 10 }}>
          <div style={labelStyle()}>Description</div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            spellCheck={false}
            style={{
              ...inputStyle(),
              resize: "vertical",
              minHeight: 56,
              fontFamily: "inherit",
            }}
          />
        </div>

        <div style={{ marginBottom: 10 }}>
          <div style={labelStyle()}>Output</div>
          {altOutputNode && onPickOutputNode ? (
            <select
              value={outputNode.id}
              onChange={(e) => onPickOutputNode(e.target.value)}
              style={{
                ...inputStyle(),
                appearance: "auto",
                cursor: "pointer",
              }}
            >
              <option value={outputNode.id}>{outputNode.name}</option>
              <option value={altOutputNode.id}>{altOutputNode.name}</option>
            </select>
          ) : (
            <div style={{ color: "#a1a1aa" }}>{outputNode.name}</div>
          )}
        </div>

        <div style={{ marginBottom: 10 }}>
          <div style={labelStyle()}>File inputs (auto-included)</div>
          {manifest.fileInputs.length === 0 ? (
            <div style={{ color: "#71717a" }}>
              (none — this app has no file inputs)
            </div>
          ) : (
            <div style={listStyle()}>
              {manifest.fileInputs.map((fi) => (
                <div key={`${fi.nodeId}::${fi.paramName}`} style={rowStyle()}>
                  <span style={{ color: "#60a5fa" }}>✓</span>
                  <span style={{ color: "#e5e7eb" }}>{fi.nodeName}</span>
                  <span style={{ color: "#52525b" }}>—</span>
                  <span style={{ color: "#a1a1aa" }}>{fi.label}</span>
                  <span style={{ color: "#52525b" }}>({fi.paramType})</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ marginBottom: 10 }}>
          <div style={labelStyle()}>
            Controls ({manifest.controls.length})
          </div>
          {manifest.controls.length === 0 ? (
            <div
              style={{
                color: "#71717a",
                lineHeight: 1.5,
                background: "#111113",
                border: "1px solid #1f1f23",
                borderRadius: 3,
                padding: "6px 8px",
              }}
            >
              No controls selected. Mark params with the &lsquo;control&rsquo;
              toggle to expose them in the exported app. (You can still
              export — the app will just have play/pause, reset, and any
              file inputs.)
            </div>
          ) : (
            <div style={listStyle()}>
              {manifest.controls.map((c) => (
                <div key={`${c.nodeId}::${c.paramName}`} style={rowStyle()}>
                  <span style={{ color: "#60a5fa" }}>•</span>
                  <span style={{ color: "#e5e7eb" }}>{c.nodeName}</span>
                  <span style={{ color: "#52525b" }}>—</span>
                  <span style={{ color: "#a1a1aa" }}>{c.label}</span>
                  <span style={{ color: "#52525b" }}>({c.paramType})</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {visibleWarnings.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <div style={labelStyle()}>Warnings</div>
            <div style={listStyle()}>
              {visibleWarnings.map((w, i) => (
                <div
                  key={`${w.kind}::${w.nodeId ?? ""}::${w.paramName ?? ""}::${i}`}
                  style={{
                    ...rowStyle(),
                    color: "#facc15",
                    alignItems: "flex-start",
                    lineHeight: 1.4,
                  }}
                >
                  <span style={{ color: "#facc15", fontWeight: 700 }}>!</span>
                  <span style={{ color: "#facc15" }}>{w.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{ marginBottom: 8 }}>
          <div style={labelStyle()}>Output size</div>
          <div style={{ color: "#a1a1aa" }}>
            {manifest.canvasRes[0]} × {manifest.canvasRes[1]}
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={labelStyle()}>Estimated bundle size</div>
          <div style={{ color: overSize ? "#ef4444" : "#a1a1aa" }}>
            {sizeMb} MB
            {overSize && (
              <span style={{ color: "#ef4444" }}>
                {" "}
                (over 25 MB cap — remove embedded assets to export)
              </span>
            )}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            gap: 6,
            justifyContent: "space-between",
            alignItems: "center",
            paddingTop: 10,
            borderTop: "1px solid #27272a",
          }}
        >
          <button onClick={onClose} style={btnStyle()}>
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={exportDisabled}
            style={{
              ...btnStyle(),
              background: "#1e3a8a",
              border: "1px solid #1e3a8a",
              color: "#bfdbfe",
              opacity: exportDisabled ? 0.5 : 1,
              cursor: exportDisabled ? "not-allowed" : "pointer",
            }}
          >
            {busy ? "Exporting…" : "Export →"}
          </button>
        </div>
      </div>
    </div>
  );
}

function labelStyle(): React.CSSProperties {
  return {
    color: "#71717a",
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 4,
  };
}

function inputStyle(): React.CSSProperties {
  return {
    width: "100%",
    boxSizing: "border-box",
    padding: "6px 8px",
    background: "#0a0a0a",
    border: "1px solid #27272a",
    color: "#e5e7eb",
    fontFamily: "inherit",
    fontSize: 11,
    borderRadius: 3,
    outline: "none",
  };
}

function listStyle(): React.CSSProperties {
  return {
    background: "#111113",
    border: "1px solid #1f1f23",
    borderRadius: 3,
    padding: "6px 8px",
    display: "flex",
    flexDirection: "column",
    gap: 3,
  };
}

function rowStyle(): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 11,
  };
}

function btnStyle(): React.CSSProperties {
  return {
    padding: "4px 10px",
    background: "transparent",
    border: "1px solid #3f3f46",
    color: "#e5e7eb",
    fontFamily: "inherit",
    fontSize: 11,
    borderRadius: 3,
    cursor: "pointer",
  };
}
