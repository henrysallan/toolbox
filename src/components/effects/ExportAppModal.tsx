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
  // Whole-bundle estimate (template + serialized graph). Null while the
  // async estimate (graph serialization + template manifest fetch) is
  // still computing.
  estimatedSizeBytes: number | null;
  // The portion the 25 MB cap actually applies to: serialized graph
  // (embedded media) + manifest. Null while computing.
  estimatedContentBytes: number | null;
  // True when the project uses ML nodes (bg-remove / segment / depth), so
  // the bundle keeps the ~22 MB ONNX runtime.
  mlRuntimeIncluded: boolean;
  busy: boolean;
  onExport: (args: { appName: string; description?: string }) => void;
}

// Mirrors SIZE_CAP_BYTES in lib/export-packager.ts — the cap on USER
// content (graph + manifest), not the fixed template weight.
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
    estimatedContentBytes,
    mlRuntimeIncluded,
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

  const overSize =
    estimatedContentBytes !== null && estimatedContentBytes >= SIZE_CAP_BYTES;
  const trimmedName = appName.trim();
  const exportDisabled = busy || overSize || trimmedName.length === 0;

  const submit = () => {
    if (exportDisabled) return;
    onExport({
      appName: trimmedName,
      description: description.trim().length > 0 ? description.trim() : undefined,
    });
  };

  const sizeMb =
    estimatedSizeBytes !== null
      ? (estimatedSizeBytes / 1024 / 1024).toFixed(2)
      : null;
  const contentMb =
    estimatedContentBytes !== null
      ? (estimatedContentBytes / 1024 / 1024).toFixed(2)
      : null;
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
          background: "var(--tb-n-3)",
          border: "1px solid var(--tb-n-7)",
          borderRadius: 6,
          padding: 16,
          fontFamily: "var(--ui-font)",
          fontSize: 11,
          color: "var(--tb-n-16)",
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
              color: "var(--tb-n-13)",
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
              border: "1px solid var(--tb-n-9)",
              color: "var(--tb-n-13)",
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
            <div style={{ color: "var(--tb-n-13)" }}>{outputNode.name}</div>
          )}
        </div>

        <div style={{ marginBottom: 10 }}>
          <div style={labelStyle()}>File inputs (auto-included)</div>
          {manifest.fileInputs.length === 0 ? (
            <div style={{ color: "var(--tb-n-11)" }}>
              (none — this app has no file inputs)
            </div>
          ) : (
            <div style={listStyle()}>
              {manifest.fileInputs.map((fi) => (
                <div key={`${fi.nodeId}::${fi.paramName}`} style={rowStyle()}>
                  <span style={{ color: "var(--tb-a-blue-400)" }}>✓</span>
                  <span style={{ color: "var(--tb-n-16)" }}>{fi.nodeName}</span>
                  <span style={{ color: "var(--tb-n-10)" }}>—</span>
                  <span style={{ color: "var(--tb-n-13)" }}>{fi.label}</span>
                  <span style={{ color: "var(--tb-n-10)" }}>({fi.paramType})</span>
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
                color: "var(--tb-n-11)",
                lineHeight: 1.5,
                background: "var(--tb-n-1)",
                border: "1px solid var(--tb-n-5)",
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
                  <span style={{ color: "var(--tb-a-blue-400)" }}>•</span>
                  <span style={{ color: "var(--tb-n-16)" }}>{c.nodeName}</span>
                  <span style={{ color: "var(--tb-n-10)" }}>—</span>
                  <span style={{ color: "var(--tb-n-13)" }}>{c.label}</span>
                  <span style={{ color: "var(--tb-n-10)" }}>({c.paramType})</span>
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
                    color: "var(--tb-a-yellow-400)",
                    alignItems: "flex-start",
                    lineHeight: 1.4,
                  }}
                >
                  <span style={{ color: "var(--tb-a-yellow-400)", fontWeight: 700 }}>!</span>
                  <span style={{ color: "var(--tb-a-yellow-400)" }}>{w.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{ marginBottom: 8 }}>
          <div style={labelStyle()}>Output size</div>
          <div style={{ color: "var(--tb-n-13)" }}>
            {manifest.canvasRes[0]} × {manifest.canvasRes[1]}
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={labelStyle()}>Estimated bundle size</div>
          <div style={{ color: overSize ? "var(--tb-a-red-500)" : "var(--tb-n-13)" }}>
            {sizeMb === null ? "computing…" : `${sizeMb} MB`}
            {mlRuntimeIncluded && (
              <span style={{ color: "var(--tb-n-13)" }}>
                {" "}
                (includes the ~22 MB ML runtime — the graph uses
                bg-remove / segment / depth)
              </span>
            )}
            {overSize && (
              <span style={{ color: "var(--tb-a-red-500)" }}>
                {" "}
                (project content is {contentMb} MB — over the 25 MB cap;
                remove or shrink embedded media to export)
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
            borderTop: "1px solid var(--tb-n-7)",
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
              background: "var(--tb-a-blue-900)",
              border: "1px solid var(--tb-a-blue-900)",
              color: "var(--tb-a-blue-200)",
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
    color: "var(--tb-n-11)",
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
    background: "var(--tb-n-0)",
    border: "1px solid var(--tb-n-7)",
    color: "var(--tb-n-16)",
    fontFamily: "inherit",
    fontSize: 11,
    borderRadius: 3,
    outline: "none",
  };
}

function listStyle(): React.CSSProperties {
  return {
    background: "var(--tb-n-1)",
    border: "1px solid var(--tb-n-5)",
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
    border: "1px solid var(--tb-n-9)",
    color: "var(--tb-n-16)",
    fontFamily: "inherit",
    fontSize: 11,
    borderRadius: 3,
    cursor: "pointer",
  };
}
