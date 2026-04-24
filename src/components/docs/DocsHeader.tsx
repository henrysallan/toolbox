"use client";

import Link from "next/link";
import { CURRENT_VERSION } from "@/lib/changelog";

// Minimal top bar for /docs/*. Matches the MenuBar height so the
// docs page doesn't feel visually lopsided against the editor, but
// stripped down to the essentials: a "Toolbox" wordmark that links
// back to /, a "Docs" crumb, and the version on the right.

export default function DocsHeader() {
  return (
    <header
      style={{
        height: 22,
        flexShrink: 0,
        background: "#111113",
        borderBottom: "1px solid #27272a",
        display: "flex",
        alignItems: "stretch",
        // Header explicitly stays monospace so it reads as editor
        // chrome even though the article body uses Inter.
        fontFamily: "ui-monospace, monospace",
        fontSize: 11,
        color: "#e5e7eb",
        userSelect: "none",
      }}
    >
      <Link
        href="/"
        style={{
          display: "inline-flex",
          alignItems: "center",
          padding: "0 10px",
          color: "#e5e7eb",
          textDecoration: "none",
          fontWeight: 600,
        }}
        title="Back to editor"
      >
        Toolbox
      </Link>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          padding: "0 10px",
          color: "#71717a",
        }}
      >
        / Docs
      </span>
      <div style={{ flex: 1 }} />
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          padding: "0 10px",
          color: "#71717a",
          fontSize: 10,
          letterSpacing: 0.3,
        }}
      >
        v{CURRENT_VERSION}
      </span>
    </header>
  );
}
