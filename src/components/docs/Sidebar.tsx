"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  DOCS,
  slugPath,
  type DocPage,
  type DocSection,
} from "@/lib/docs/manifest";

// Collapsible two-level nav.
//
//   SECTION  (click row to expand/collapse)
//     Page
//       #anchor  (shown only when the page is the active one)
//       #anchor
//     Page
//
// Default open state: the section containing the current page.
// User toggles on any section header persist across renders. If
// the user navigates to a page in a different section (via prev/
// next, in-body link, or browser back), we auto-add that section
// to the open set without closing anything else — they never end
// up on a page whose section is collapsed.

export default function Sidebar() {
  const pathname = usePathname();
  const activeSection = findSectionForPath(pathname);

  // Default every section open on first render — users get to see
  // the full map before collapsing anything. Manual toggles
  // thereafter drive the state; the active-section reconciliation
  // below guarantees we never land on a page whose section is
  // collapsed.
  const [openSections, setOpenSections] = useState<Set<string>>(
    () => new Set(DOCS.map((s) => s.title))
  );
  const [seenActiveTitle, setSeenActiveTitle] = useState<string | null>(
    activeSection?.title ?? null
  );
  if ((activeSection?.title ?? null) !== seenActiveTitle) {
    setSeenActiveTitle(activeSection?.title ?? null);
    if (activeSection && !openSections.has(activeSection.title)) {
      setOpenSections((prev) => new Set([...prev, activeSection.title]));
    }
  }

  const toggle = (title: string) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      return next;
    });
  };

  return (
    <nav
      style={{
        width: 260,
        flexShrink: 0,
        borderRight: "1px solid #27272a",
        padding: "14px 10px 32px",
        background: "#0a0a0a",
        overflowY: "auto",
      }}
      className="thin-scrollbar"
      aria-label="Documentation navigation"
    >
      {DOCS.map((section) => (
        <SectionBlock
          key={section.title}
          section={section}
          open={openSections.has(section.title)}
          onToggle={() => toggle(section.title)}
          pathname={pathname}
        />
      ))}
    </nav>
  );
}

function SectionBlock({
  section,
  open,
  onToggle,
  pathname,
}: {
  section: DocSection;
  open: boolean;
  onToggle: () => void;
  pathname: string;
}) {
  return (
    <div style={{ marginBottom: 6 }}>
      <button
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "6px 8px",
          background: "transparent",
          border: "none",
          color: "#a1a1aa",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          fontFamily: "ui-monospace, monospace",
          cursor: "pointer",
          textAlign: "left",
          borderRadius: 3,
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "#e5e7eb")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "#a1a1aa")}
        aria-expanded={open}
      >
        <Chevron open={open} />
        <span style={{ flex: 1 }}>{section.title}</span>
      </button>
      {open && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 1,
            paddingLeft: 6,
          }}
        >
          {section.pages.map((page) => (
            <PageRow key={page.slug.join("/")} page={page} pathname={pathname} />
          ))}
        </div>
      )}
    </div>
  );
}

function PageRow({ page, pathname }: { page: DocPage; pathname: string }) {
  const href = slugPath(page.slug);
  const active = pathname === href;
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <Link
        href={href}
        style={{
          display: "block",
          padding: "5px 10px",
          fontSize: 13,
          color: active ? "#f4f4f5" : "#a1a1aa",
          background: active ? "#18181b" : "transparent",
          borderRadius: 3,
          textDecoration: "none",
          borderLeft: `2px solid ${active ? "#60a5fa" : "transparent"}`,
          transition: "background 80ms",
        }}
      >
        {page.title}
      </Link>
      {active && page.toc && page.toc.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginLeft: 14,
            borderLeft: "1px solid #27272a",
            paddingLeft: 8,
            marginTop: 2,
            marginBottom: 4,
          }}
        >
          {page.toc.map((item, i) =>
            item.kind === "group" ? (
              <div
                key={item.id}
                style={{
                  // Small uppercase divider for the generator /
                  // modifier / utility groupings on auto-generated
                  // node category pages. Non-clickable.
                  fontSize: 9,
                  color: "#52525b",
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  padding: "4px 0 2px",
                  marginTop: i === 0 ? 0 : 4,
                  fontFamily: "ui-monospace, monospace",
                }}
              >
                {item.title}
              </div>
            ) : (
              <a
                key={item.id}
                href={`#${item.id}`}
                style={{
                  fontSize: 12,
                  color: "#71717a",
                  textDecoration: "none",
                  padding: "2px 0",
                  lineHeight: 1.4,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "#d4d4d8")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "#71717a")}
              >
                {item.title}
              </a>
            )
          )}
        </div>
      )}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 10,
        height: 10,
        color: "#71717a",
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 120ms",
        fontSize: 9,
        lineHeight: 1,
      }}
      aria-hidden
    >
      ▶
    </span>
  );
}

function findSectionForPath(pathname: string): DocSection | null {
  for (const section of DOCS) {
    for (const page of section.pages) {
      if (slugPath(page.slug) === pathname) return section;
    }
  }
  return null;
}
