"use client";

import { useEffect, useRef } from "react";
import { CHANGELOG, CURRENT_VERSION } from "@/lib/changelog";

// Changelog popover, opened from the Toolbox menu (it used to be its own
// menu-bar button). Controlled: the parent owns `open`. Fixed below the menu
// bar near the top-left; click-outside or Escape dismisses.
export default function ChangelogPopover({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
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
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      className="thin-scrollbar"
      style={{
        position: "fixed",
        top: 26,
        left: 8,
        width: 300,
        maxHeight: 440,
        overflowY: "auto",
        background: "#18181b",
        border: "1px solid #27272a",
        borderRadius: 4,
        boxShadow: "0 8px 24px rgba(0,0,0,0.55)",
        padding: "10px 12px",
        fontSize: 11,
        color: "#e5e7eb",
        zIndex: 2000,
        fontFamily: "ui-monospace, monospace",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 8,
          paddingBottom: 6,
          borderBottom: "1px solid #27272a",
        }}
      >
        <span style={{ fontWeight: 600, letterSpacing: 0.3 }}>
          Changelog
        </span>
        <span style={{ color: "#71717a", fontSize: 10 }}>
          v{CURRENT_VERSION}
        </span>
      </div>
      {CHANGELOG.map((entry, i) => (
        <div
          key={entry.version}
          style={{
            paddingBottom: 8,
            marginBottom: i === CHANGELOG.length - 1 ? 0 : 8,
            borderBottom:
              i === CHANGELOG.length - 1 ? "none" : "1px solid #27272a",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              marginBottom: 6,
            }}
          >
            <span style={{ fontWeight: 600 }}>v{entry.version}</span>
            <span style={{ color: "#71717a", fontSize: 10 }}>{entry.date}</span>
          </div>
          <Section title="What's new" items={entry.added} />
          <Section title="What's changed" items={entry.changed} />
        </div>
      ))}
    </div>
  );
}

function Section({ title, items }: { title: string; items: string[] }) {
  return (
    <div style={{ marginTop: 4 }}>
      <div
        style={{
          color: "#a1a1aa",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          marginBottom: 2,
        }}
      >
        {title}
      </div>
      {items.length === 0 ? (
        <div style={{ color: "#52525b", fontSize: 11, paddingLeft: 2 }}>—</div>
      ) : (
        <ul
          style={{
            margin: 0,
            paddingLeft: 14,
            listStyle: "disc",
            color: "#d4d4d8",
            lineHeight: 1.45,
          }}
        >
          {items.map((it, i) => (
            <li key={i} style={{ marginBottom: 2 }}>
              {it}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
