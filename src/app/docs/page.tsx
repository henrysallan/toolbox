import Link from "next/link";
import { DOCS, slugPath } from "@/lib/docs/manifest";
import { H1, Lede } from "@/components/docs/DocPage";

// /docs landing. Renders the manifest as a browse-able index with
// a short blurb per page — cheap TOC for newcomers who don't know
// what's here yet. Individual pages live under /docs/<slug...>.

export default function DocsIndex() {
  return (
    <>
      <H1>Documentation</H1>
      <Lede>
        Guides, references, and reading material for Toolbox. Pick a
        section below or use the sidebar.
      </Lede>
      {DOCS.map((section) => (
        <section key={section.title} style={{ marginBottom: 28 }}>
          <h2
            style={{
              fontSize: 11,
              color: "#71717a",
              textTransform: "uppercase",
              letterSpacing: 0.5,
              margin: "0 0 10px",
              paddingBottom: 6,
              borderBottom: "1px solid #27272a",
            }}
          >
            {section.title}
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {section.pages.map((page) => (
              <Link
                key={page.slug.join("/")}
                href={slugPath(page.slug)}
                style={{
                  display: "block",
                  padding: "10px 12px",
                  background: "#111113",
                  border: "1px solid #27272a",
                  borderRadius: 4,
                  textDecoration: "none",
                  color: "#e5e7eb",
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  {page.title}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: "#a1a1aa",
                    marginTop: 2,
                    lineHeight: 1.5,
                  }}
                >
                  {page.summary}
                </div>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
