"use client";

import Link from "next/link";
import { flatPages, slugPath, type DocPage } from "@/lib/docs/manifest";

// Prev/next footer driven by manifest order. Shown under every
// article so a linear read-through from Welcome onward is one
// click per step.

export default function PrevNext({ currentSlug }: { currentSlug: string[] }) {
  const pages = flatPages();
  const joined = currentSlug.join("/");
  const idx = pages.findIndex((p) => p.slug.join("/") === joined);
  if (idx === -1) return null;
  const prev = idx > 0 ? pages[idx - 1] : null;
  const next = idx < pages.length - 1 ? pages[idx + 1] : null;
  if (!prev && !next) return null;
  return (
    <div
      style={{
        marginTop: 48,
        paddingTop: 16,
        borderTop: "1px solid #27272a",
        display: "flex",
        gap: 12,
        justifyContent: "space-between",
      }}
    >
      <PrevNextCard page={prev} direction="prev" />
      <PrevNextCard page={next} direction="next" />
    </div>
  );
}

function PrevNextCard({
  page,
  direction,
}: {
  page: DocPage | null;
  direction: "prev" | "next";
}) {
  if (!page) {
    // Keep layout symmetric when one end is missing.
    return <div style={{ flex: 1 }} />;
  }
  const align = direction === "prev" ? "flex-start" : "flex-end";
  const textAlign: "left" | "right" = direction === "prev" ? "left" : "right";
  return (
    <Link
      href={slugPath(page.slug)}
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: align,
        padding: "10px 12px",
        background: "#111113",
        border: "1px solid #27272a",
        borderRadius: 4,
        textDecoration: "none",
        color: "#e5e7eb",
      }}
    >
      <span
        style={{
          color: "#71717a",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          textAlign,
          width: "100%",
        }}
      >
        {direction === "prev" ? "← Previous" : "Next →"}
      </span>
      <span style={{ fontSize: 13, marginTop: 2, textAlign, width: "100%" }}>
        {page.title}
      </span>
    </Link>
  );
}
