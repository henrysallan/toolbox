"use client";

// Lightweight table of contents card. Authors pass their section
// IDs + titles explicitly (matches the `id` prop on <H2/>). We
// intentionally skip a DOM scan — page components render server-
// side-ish and the manual list is tiny to maintain. When the TOC
// gets long enough to be annoying, a compiler-assisted version
// can replace this without changing the author-side shape.

export interface TocItem {
  id: string;
  title: string;
}

export default function InPageToc({ items }: { items: TocItem[] }) {
  if (items.length === 0) return null;
  return (
    <nav
      aria-label="On this page"
      style={{
        padding: "10px 14px",
        background: "#111113",
        border: "1px solid #27272a",
        borderRadius: 4,
        margin: "0 0 28px",
      }}
    >
      <div
        style={{
          color: "#71717a",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          marginBottom: 6,
          fontFamily: "ui-monospace, monospace",
        }}
      >
        On this page
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {items.map((it) => (
          <a
            key={it.id}
            href={`#${it.id}`}
            style={{
              fontSize: 13,
              color: "#d4d4d8",
              textDecoration: "none",
              padding: "2px 0",
              lineHeight: 1.5,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "#93c5fd")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "#d4d4d8")}
          >
            {it.title}
          </a>
        ))}
      </div>
    </nav>
  );
}
