"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import type { SavedProject } from "@/lib/project";
import { buildExportManifest } from "@/lib/export-manifest";
import { fromSavedLiveDesign } from "@/lib/live-viewer/design";
import { LiveRoot } from "@/lib/live-viewer/live-root";
import {
  LiveLoadOverlay,
  liveLoadLabel,
  useLiveLoad,
} from "@/lib/live-viewer/LiveLoadOverlay";
import { editorPathForSlug } from "@/lib/project-url";
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
  // No fallback of its own: LiveClient's LiveLoadOverlay is already up
  // (server-rendered, so it's there before hydration) and stays through
  // the chunk load, the deserialize and the first frame via onLoadPhase.
  // Until 2026-09-16 this was "Loading live viewer…" in the `.fatal` red,
  // lifting the moment the chunk arrived.
  loading: () => null,
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
  // The editor's project-load veil, live-themed (LiveLoadOverlay): fills
  // as the viewer reports its phases, holds, fades once a frame is up.
  const { load, onLoadPhase, onFaded } = useLiveLoad();

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
        // parentId is what lets flattenGraph reconstruct group/layer
        // boundaries — without it every layer/group interior is treated
        // as root-level, the layer `in:content` splice never fires, and
        // computeNeededSet can't walk behind the active node into its
        // layers/groups, so interior controls vanish from the manifest.
        parentId: n.parentId,
        params: n.params,
        exposedParams: n.exposedParams,
        controlParams: n.controlParams,
        // Node-level control (091726_live-gizmos.md): the node's on-canvas
        // handles ship as a gizmo row + overlay. Same copy-through rule as
        // controlParams — dropping it here would silently drop the rows.
        controlGizmo: n.controlGizmo,
        // Custom slider ranges (right-click "Slider range" on a scalar) —
        // the manifest builder bakes these into each control's def so the
        // live panel's sliders span the same min / max / soft max as the
        // editor's. Dropping them here is what made /live ignore them.
        paramOverrides: n.paramOverrides,
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
    // The project's real resolution rides SavedScene.width/height (the
    // top-level compat mirror of the active composition's scene, written
    // on every save). 1024² only for saves genuinely predating it.
    const scene = graph.scene;
    const canvasRes: [number, number] =
      scene?.width !== undefined && scene?.height !== undefined
        ? [scene.width, scene.height]
        : [1024, 1024];
    const built = buildExportManifest({
      nodes,
      edges,
      appName: name,
      outputNodeId,
      canvasRes,
    });
    // Live-link design (081426_live-link-designer.md): validated as an
    // untrusted blob (this is a public row) and threaded onto the
    // manifest — the only place the viewer reads it from. Absent →
    // undefined → the viewer's built-in defaults.
    if (graph.liveDesign != null) {
      built.manifest.design = fromSavedLiveDesign(graph.liveDesign);
      // The author's canvas-size override (designer Export section)
      // retargets the whole viewer — render and capture.
      const res = built.manifest.design.export.resolution;
      if (res) built.manifest.canvasRes = res;
    }
    return built.manifest;
  }, [graph, name, outputNodeId]);

  if (!outputNodeId || !manifest) {
    return (
      <LiveRoot>
        <div className="fatal">
          This patch has no terminal output to render.
        </div>
      </LiveRoot>
    );
  }

  // Patch identity (name · by author · #code) renders INSIDE the panel,
  // at the top of its toolbar above the transport (ControlPanel
  // PanelTitleRow), with an "Editor" link to the project's /p/<slug>
  // page. Until 2026-09-16 it was a fixed bottom-left badge here, styled
  // with editor tokens the design block never touched.
  return (
    <LiveRoot design={manifest.design}>
      <LiveViewer
        graph={graph}
        manifest={manifest}
        title={{
          name,
          authorName,
          slug,
          editorHref: editorPathForSlug(slug),
        }}
        onLoadPhase={onLoadPhase}
      />
      {load && (
        <LiveLoadOverlay
          label={liveLoadLabel(name)}
          progress={load.progress}
          fading={load.fading}
          onFaded={onFaded}
        />
      )}
    </LiveRoot>
  );
}
