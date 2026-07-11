"use client";

// Pairing confirmation for the Claude MCP bridge (spec
// 070926_claude-mcp-bridge.md): shows the 4-digit code the connecting
// server sent; the user checks it against the code toolbox-mcp printed in
// the terminal. Confirming pairs the session; cancelling disconnects.

export interface McpPairingDialogProps {
  code: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function McpPairingDialog({
  code,
  onConfirm,
  onCancel,
}: McpPairingDialogProps) {
  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 2000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          minWidth: 360,
          background: "#18181b",
          border: "1px solid #27272a",
          borderRadius: 6,
          padding: 16,
          fontFamily: "ui-monospace, monospace",
          fontSize: 12,
          color: "#e5e7eb",
          boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
        }}
      >
        <div
          style={{
            marginBottom: 10,
            color: "#a1a1aa",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: 1,
          }}
        >
          Connect to Claude
        </div>
        <div style={{ lineHeight: 1.5, marginBottom: 12 }}>
          A local Claude bridge (toolbox-mcp) wants to control this editor.
          Confirm the code below matches the one printed in your terminal.
        </div>
        <div
          style={{
            textAlign: "center",
            fontSize: 28,
            letterSpacing: 8,
            padding: "10px 0",
            marginBottom: 14,
            background: "#0a0a0a",
            border: "1px solid #27272a",
            borderRadius: 3,
          }}
        >
          {code}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            onClick={onCancel}
            style={{
              background: "transparent",
              border: "1px solid #3f3f46",
              color: "#a1a1aa",
              fontSize: 11,
              padding: "5px 12px",
              borderRadius: 3,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            autoFocus
            style={{
              background: "#2563eb",
              border: "1px solid #2563eb",
              color: "#fff",
              fontSize: 11,
              padding: "5px 12px",
              borderRadius: 3,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Codes Match — Connect
          </button>
        </div>
      </div>
    </div>
  );
}
