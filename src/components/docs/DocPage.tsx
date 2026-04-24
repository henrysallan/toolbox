"use client";

import { Children, isValidElement, useState, type ReactNode } from "react";

// Typography primitives for doc pages. Pages import H1 / H2 / P / etc.
// so styling lives in one place and can be re-skinned without walking
// every article. H2 and H3 accept an optional `id`; hovering their
// text reveals a "#" chip that copies a deep link to the clipboard.

// Slugify a heading's text so IDs are predictable for manually-written
// TOC entries and copy-link URLs. Falls back to "section-N" when the
// child isn't plain text.
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-");
}

// Best-effort string extraction from ReactNode children. Deep trees
// are rare for headings, but the recursion handles them.
function childrenToText(nodes: ReactNode): string {
  let out = "";
  Children.forEach(nodes, (c) => {
    if (typeof c === "string" || typeof c === "number") out += String(c);
    else if (isValidElement(c)) {
      out += childrenToText(
        (c.props as { children?: ReactNode })?.children
      );
    }
  });
  return out;
}

export function H1({ children }: { children: ReactNode }) {
  return (
    <h1
      style={{
        fontSize: 30,
        fontWeight: 700,
        color: "#f4f4f5",
        margin: "0 0 6px",
        letterSpacing: -0.3,
        lineHeight: 1.15,
      }}
    >
      {children}
    </h1>
  );
}

export function Lede({ children }: { children: ReactNode }) {
  return (
    <p
      style={{
        fontSize: 15,
        color: "#a1a1aa",
        margin: "0 0 28px",
        lineHeight: 1.6,
      }}
    >
      {children}
    </p>
  );
}

// Linkable heading. Renders "#" chip on hover; clicking copies the
// full URL with anchor to clipboard and flashes a checkmark.
function LinkableHeading({
  level,
  id,
  children,
}: {
  level: 2 | 3;
  id?: string;
  children: ReactNode;
}) {
  const derivedId = id ?? slugify(childrenToText(children));
  const [hover, setHover] = useState(false);
  const [copied, setCopied] = useState(false);
  const Tag = level === 2 ? "h2" : "h3";
  const style =
    level === 2
      ? {
          fontSize: 20,
          fontWeight: 600,
          color: "#f4f4f5",
          margin: "28px 0 10px",
          paddingTop: 10,
          borderTop: "1px solid #27272a",
          lineHeight: 1.25,
        }
      : {
          fontSize: 15,
          fontWeight: 600,
          color: "#e5e7eb",
          margin: "20px 0 8px",
          lineHeight: 1.3,
        };
  return (
    <Tag
      id={derivedId}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setCopied(false);
      }}
      style={{
        ...style,
        // Offset anchor jumps so the heading doesn't hide under the
        // fixed-position docs header.
        scrollMarginTop: 32,
        display: "flex",
        alignItems: "baseline",
        gap: 8,
      }}
    >
      <span>{children}</span>
      <button
        aria-label="Copy link to this section"
        onClick={() => {
          const base = window.location.href.split("#")[0];
          navigator.clipboard
            .writeText(`${base}#${derivedId}`)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            })
            .catch(() => {});
        }}
        style={{
          background: "transparent",
          border: "none",
          padding: 0,
          color: copied ? "#34d399" : "#71717a",
          cursor: "pointer",
          fontSize: 13,
          opacity: hover || copied ? 1 : 0,
          transition: "opacity 120ms",
          fontFamily: "ui-monospace, monospace",
        }}
      >
        {copied ? "✓" : "#"}
      </button>
    </Tag>
  );
}

export function H2({
  id,
  children,
}: {
  id?: string;
  children: ReactNode;
}) {
  return (
    <LinkableHeading level={2} id={id}>
      {children}
    </LinkableHeading>
  );
}

export function H3({
  id,
  children,
}: {
  id?: string;
  children: ReactNode;
}) {
  return (
    <LinkableHeading level={3} id={id}>
      {children}
    </LinkableHeading>
  );
}

export function P({ children }: { children: ReactNode }) {
  return (
    <p
      style={{
        fontSize: 14,
        color: "#d4d4d8",
        lineHeight: 1.7,
        margin: "0 0 14px",
      }}
    >
      {children}
    </p>
  );
}

export function UL({ children }: { children: ReactNode }) {
  return (
    <ul
      style={{
        fontSize: 14,
        color: "#d4d4d8",
        lineHeight: 1.7,
        paddingLeft: 22,
        margin: "0 0 14px",
      }}
    >
      {children}
    </ul>
  );
}

export function OL({ children }: { children: ReactNode }) {
  return (
    <ol
      style={{
        fontSize: 14,
        color: "#d4d4d8",
        lineHeight: 1.7,
        paddingLeft: 22,
        margin: "0 0 14px",
      }}
    >
      {children}
    </ol>
  );
}

export function LI({ children }: { children: ReactNode }) {
  return <li style={{ marginBottom: 5 }}>{children}</li>;
}

// Inline keyboard chip (e.g. ⌘S). Explicit monospace + small caps
// feel so it reads as a key regardless of the surrounding font.
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 6px",
        background: "#18181b",
        border: "1px solid #3f3f46",
        borderRadius: 3,
        color: "#e5e7eb",
        fontFamily: "ui-monospace, monospace",
        fontSize: 11,
        lineHeight: 1.4,
      }}
    >
      {children}
    </span>
  );
}

// Inline monospace for node names, paths, literals.
export function Code({ children }: { children: ReactNode }) {
  return (
    <code
      style={{
        padding: "0 4px",
        background: "#18181b",
        border: "1px solid #27272a",
        borderRadius: 3,
        color: "#e4e4e7",
        fontFamily: "ui-monospace, monospace",
        fontSize: 12,
      }}
    >
      {children}
    </code>
  );
}

// Simple two-column table for shortcut lists or parameter docs.
export function Table({ children }: { children: ReactNode }) {
  return (
    <table
      style={{
        width: "100%",
        borderCollapse: "collapse",
        fontSize: 13,
        color: "#d4d4d8",
        margin: "4px 0 18px",
      }}
    >
      {children}
    </table>
  );
}

export function Th({ children }: { children: ReactNode }) {
  return (
    <th
      style={{
        textAlign: "left",
        padding: "6px 10px",
        color: "#a1a1aa",
        fontSize: 11,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        fontWeight: 600,
        borderBottom: "1px solid #27272a",
      }}
    >
      {children}
    </th>
  );
}

export function Td({ children }: { children: ReactNode }) {
  return (
    <td
      style={{
        padding: "6px 10px",
        borderBottom: "1px solid #1a1a1d",
        verticalAlign: "top",
      }}
    >
      {children}
    </td>
  );
}

// Callout / note card used to call out tips, warnings, or context
// that shouldn't visually get lost in body prose.
export function Note({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: "info" | "warning";
}) {
  const border = tone === "warning" ? "#b45309" : "#3f3f46";
  const bg = tone === "warning" ? "#1f1408" : "#111113";
  return (
    <div
      style={{
        border: `1px solid ${border}`,
        borderLeftWidth: 3,
        background: bg,
        padding: "10px 14px",
        borderRadius: 4,
        margin: "4px 0 14px",
        fontSize: 13.5,
        color: "#d4d4d8",
        lineHeight: 1.6,
      }}
    >
      {children}
    </div>
  );
}
