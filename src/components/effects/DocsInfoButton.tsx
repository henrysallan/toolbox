"use client";

import Link from "next/link";

// Tiny info button in the right cluster of the menu bar. Sits
// immediately to the left of VersionMenu. Plain <Link> so
// middle-click / Cmd-click / "Open in new tab" all behave natively;
// standard left-click does a client-side nav to /docs, which
// unmounts the editor — EffectsShell's cleanup effect stashes
// current state so coming back rehydrates seamlessly.

export default function DocsInfoButton() {
  return (
    <Link
      href="/docs"
      title="Documentation"
      aria-label="Open documentation"
      style={{
        height: "100%",
        padding: "0 6px",
        display: "inline-flex",
        alignItems: "center",
        color: "#a1a1aa",
        textDecoration: "none",
      }}
    >
      <span
        style={{
          width: 13,
          height: 13,
          borderRadius: "50%",
          border: "1px solid currentColor",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 9,
          fontStyle: "italic",
          fontFamily: "Georgia, serif",
          lineHeight: 1,
          fontWeight: 600,
        }}
      >
        i
      </span>
    </Link>
  );
}
