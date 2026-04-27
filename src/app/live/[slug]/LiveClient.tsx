"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import type { SavedProject } from "@/lib/project";
import { buildExportManifest } from "@/lib/export-manifest";
import { registerAllNodes } from "@/nodes";
import "@/lib/live-viewer/styles.css";

// The manifest builder calls getNodeDef() to look up each node's param
// types — that requires the registry to be populated. Without this
// line, registerAllNodes only runs inside the dynamically-imported
// LiveViewer, AFTER buildExportManifest has already produced an empty
// manifest. registerNode is idempotent so the second call from
// LiveViewer is a no-op.
registerAllNodes();

// LiveViewer touches WebGL and global window state at module scope, so
// import it client-only — server-render would either crash or pre-
// allocate state we'd then throw away.
const LiveViewer = dynamic(() => import("@/lib/live-viewer/LiveViewer"), {
  ssr: false,
  loading: () => <div className="fatal">Loading live viewer…</div>,
});

interface Props {
  slug: string;
  name: string;
  authorName: string | null;
  graph: SavedProject;
}

// Heuristic for "which terminal node should the live link render?". The
// editor stores `active: true` on the terminal currently driving viewport
// 1; we honor that. If the graph somehow lacks an active terminal we fall
// back to the first node with `terminal: true` in the saved data, then
// finally the first Output-typed node.
function pickOutputNodeId(graph: SavedProject): string | null {
  for (const n of graph.nodes) {
    if (n.active) return n.id;
  }
  for (const n of graph.nodes) {
    if (n.defType === "output") return n.id;
  }
  return null;
}

export default function LiveClient({ slug, name, authorName, graph }: Props) {
  const outputNodeId = useMemo(() => pickOutputNodeId(graph), [graph]);

  // We need a manifest to drive the viewer's panel. The same builder the
  // editor uses runs in-browser here — pure data, no DB access — and the
  // graph has already been deserialized for us. We pass dummy nodes/edges
  // built from the SavedProject because the manifest builder expects the
  // editor's React-Flow shape.
  const manifest = useMemo(() => {
    if (!outputNodeId) return null;
    const nodes = graph.nodes.map((n) => ({
      id: n.id,
      type: "effect" as const,
      position: n.position,
      data: {
        defType: n.defType,
        params: n.params,
        exposedParams: n.exposedParams,
        controlParams: n.controlParams,
        active: n.active,
        bypassed: n.bypassed,
        // The manifest builder doesn't inspect these; keep the type
        // shape happy with zero-effort defaults.
        name: n.defType,
        inputs: [],
        auxOutputs: [],
        primaryOutput: null,
      },
    }));
    const edges = graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle ?? undefined,
      target: e.target,
      targetHandle: e.targetHandle ?? undefined,
    }));
    const built = buildExportManifest({
      nodes,
      edges,
      appName: name,
      outputNodeId,
      // The saved graph doesn't carry canvas resolution today (it lives
      // in editor state, not the project). Default to 1024² — the same
      // value the editor seeds new projects with.
      canvasRes: [1024, 1024],
    });
    return built.manifest;
  }, [graph, name, outputNodeId]);

  if (!outputNodeId || !manifest) {
    return (
      <main className="live-root">
        <div className="fatal">
          This patch has no terminal output to render.
        </div>
      </main>
    );
  }

  return (
    <main className="live-root">
      <LiveViewer graph={graph} manifest={manifest} />
      <ShareCorner slug={slug} name={name} authorName={authorName} />
    </main>
  );
}

function ShareCorner({
  slug,
  name,
  authorName,
}: {
  slug: string;
  name: string;
  authorName: string | null;
}) {
  // Bottom-left badge identifying the patch and (optionally) its author.
  // No interaction yet — copy/share is the editor's job. Kept terse so
  // it stays out of the way of the canvas.
  return (
    <div
      style={{
        position: "fixed",
        left: 12,
        bottom: 12,
        padding: "6px 10px",
        background: "rgba(15, 15, 17, 0.85)",
        border: "1px solid #27272a",
        borderRadius: 4,
        color: "#a1a1aa",
        fontFamily: "ui-monospace, monospace",
        fontSize: 10,
        letterSpacing: 0.3,
        pointerEvents: "none",
      }}
    >
      <span style={{ color: "#e5e7eb" }}>{name}</span>
      {authorName && (
        <span style={{ marginLeft: 6, color: "#71717a" }}>
          · by {authorName}
        </span>
      )}
      <span style={{ marginLeft: 6, color: "#52525b" }}>· #{slug.slice(0, 6)}</span>
    </div>
  );
}
