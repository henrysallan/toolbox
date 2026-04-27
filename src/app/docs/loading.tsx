// Next.js renders this automatically while the docs route is
// fetching / rendering. Stylistically matches the editor's
// `ProgressBanner` (load tone — blue) so the route swap feels like
// part of the same family as save / load progress.

export default function DocsLoading() {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#0a0a0a",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "ui-monospace, monospace",
        fontSize: 11,
        color: "#e5e7eb",
        zIndex: 9999,
      }}
    >
      <div
        style={{
          minWidth: 180,
          padding: "8px 14px",
          background: "rgba(37, 99, 235, 0.9)",
          color: "#f0fdf4",
          border: "1px solid #3b82f6",
          borderRadius: 4,
          letterSpacing: 0.5,
          boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <span>loading docs</span>
        </div>
        <div
          style={{
            height: 3,
            background: "rgba(0,0,0,0.35)",
            borderRadius: 2,
            overflow: "hidden",
            position: "relative",
          }}
        >
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              height: "100%",
              width: "40%",
              background: "#93c5fd",
              borderRadius: 2,
              animation: "docs-loading-slide 1.1s ease-in-out infinite",
            }}
          />
        </div>
      </div>
      <style>{`
        @keyframes docs-loading-slide {
          0%   { transform: translateX(-100%); }
          50%  { transform: translateX(150%); }
          100% { transform: translateX(150%); }
        }
      `}</style>
    </div>
  );
}
