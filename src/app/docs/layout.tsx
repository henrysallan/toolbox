import type { ReactNode } from "react";
import DocsHeader from "@/components/docs/DocsHeader";
import Sidebar from "@/components/docs/Sidebar";

// Full-page shell for /docs/*. Deliberately renders no MenuBar /
// editor chrome — this is a standalone surface that takes over the
// viewport. Returning to the editor happens via a standard
// client-side navigation back to "/", which rehydrates from the
// session stash in EffectsShell.

export const metadata = {
  title: "Toolbox Docs",
};

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        width: "100%",
        background: "#0a0a0a",
        color: "#e5e7eb",
        // Default to Inter across the docs surface; header overrides
        // back to monospace so the top bar mirrors the editor chrome.
        fontFamily:
          "var(--font-inter), -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        fontSize: 13,
      }}
    >
      <DocsHeader />
      <div
        style={{
          display: "flex",
          flex: 1,
          minHeight: 0,
        }}
      >
        <Sidebar />
        <main
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "32px 48px 64px",
          }}
          className="thin-scrollbar"
        >
          <div style={{ maxWidth: 720, margin: "0 auto" }}>{children}</div>
        </main>
      </div>
    </div>
  );
}
