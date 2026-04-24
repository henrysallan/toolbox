"use client";

import { useEffect, useRef, useState } from "react";
import { CHANGELOG, CURRENT_VERSION } from "@/lib/changelog";

// Small version/changelog dropdown that lives in the menu bar. Deliberately
// narrow — the menu bar's vertical real estate is tight, so we cap the body
// and let it scroll instead of growing.

export default function VersionMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        onMouseDown={(e) => {
          e.preventDefault();
          setOpen((v) => !v);
        }}
        title="Version & changelog"
        style={{
          height: "100%",
          padding: "0 8px",
          background: open ? "#27272a" : "transparent",
          color: "#a1a1aa",
          border: "none",
          fontFamily: "inherit",
          fontSize: 10,
          cursor: "default",
          letterSpacing: 0.3,
        }}
      >
        v{CURRENT_VERSION}
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            width: 280,
            maxHeight: 320,
            overflowY: "auto",
            background: "#18181b",
            border: "1px solid #27272a",
            borderRadius: 4,
            boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
            padding: "8px 10px",
            marginTop: 2,
            fontSize: 11,
            color: "#e5e7eb",
          }}
          className="thin-scrollbar"
        >
          {CHANGELOG.map((entry, i) => (
            <div
              key={entry.version}
              style={{
                paddingBottom: 8,
                marginBottom: i === CHANGELOG.length - 1 ? 0 : 8,
                borderBottom:
                  i === CHANGELOG.length - 1
                    ? "none"
                    : "1px solid #27272a",
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
                <span style={{ color: "#71717a", fontSize: 10 }}>
                  {entry.date}
                </span>
              </div>
              <Section title="What's new" items={entry.added} />
              <Section title="What's changed" items={entry.changed} />
            </div>
          ))}
        </div>
      )}
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
        <div style={{ color: "#52525b", fontSize: 11, paddingLeft: 2 }}>
          —
        </div>
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
