"use client";

import {
  addEdge,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import NodeEditor from "./NodeEditor";
import ParamPanel from "./ParamPanel";
import { feedWheel, wheelWantsZoom } from "./input-device";
// import CustomCursor from "./CustomCursor"; // temporarily disabled — using native cursor
import UserPreferencesModal from "./UserPreferencesModal";
import PaintOverlay from "./PaintOverlay";
import PlaybackBar from "./PlaybackBar";
import MenuBar from "./MenuBar";
import Landing from "./Landing";
import ViewportMenuBar from "./ViewportMenuBar";
import TransformContextBar from "./TransformContextBar";
import { registerAllNodes } from "@/nodes";
import { getNodeDef } from "@/engine/registry";
import { createEngineBackend, type EngineBackend } from "@/engine/gl";
import { awaitMediaSettle } from "@/engine/offline-settle";
import {
  evaluateGraph,
  type EvalCache,
  type GraphEdge,
  type GraphNode,
} from "@/engine/evaluator";
import {
  gpointCKey,
  gpointXKey,
  gpointYKey,
  layerOpacityKey,
  withMaskInput,
} from "@/engine/conventions";
import type { NodeDataPayload } from "@/state/graph";
import { parseTargetHandleKind } from "@/state/graph";
import {
  buildStarterGraph,
  cloneSubgraph,
  collectDescendantIds,
  connectToVirtualSocket,
  createLayer,
  defaultScopeFor,
  expandWithDescendants,
  getLayerChain,
  reorderLayers,
  splitLayer,
  groupSelection,
  makeInstanceNode,
  newEdgeId,
  removeGroupSocket,
  renameGroupSocket,
  ungroupNode,
} from "@/state/graph-ops";
import {
  GROUP_INPUT_TYPE,
  GROUP_OUTPUT_TYPE,
  GROUP_TYPE,
  LAYER_TYPE,
} from "@/engine/groups";
import { getPreset } from "@/state/presets";
import { newLayerId, type MergeLayer } from "@/nodes/effect/merge";
import { defaultAutoLayoutItem } from "@/nodes/effect/autolayout";
import { newRenderQueueItemId } from "@/nodes/output/render-queue";
import type {
  AutoLayoutItem,
  GradientPoint,
  RenderQueueItem,
  SvgFileParamValue,
} from "@/engine/types";
import { transformSpline } from "@/engine/spline-transform";
import { useHistory, useUndoShortcuts, type GraphSnapshot } from "@/state/history";
import {
  defaultFilename,
  downloadBlob,
  pickVideoMime,
  sanitizeFilename,
} from "@/lib/export";
import { platform, type FolderHandle } from "@/lib/platform";
import {
  deserializeGraph,
  generateThumbnail,
  incrementName,
  serializeGraph,
  type SavedProject,
} from "@/lib/project";
import {
  matchFilesToMissing,
  pickMediaFiles,
  pickMediaFilesViaInput,
  readStoredMediaFile,
  type MissingMedia,
} from "@/lib/media-relink";
import MediaRelinkModal, {
  type RelinkItem,
  type RelinkStatus,
} from "./MediaRelinkModal";
import {
  deleteProject as deleteProjectRow,
  listPrivateProjects,
  loadProject as loadProjectRow,
  renameProject as renameProjectRow,
  saveProject as saveProjectRow,
  setProjectVisibility as setProjectVisibilityRow,
  updateProject as updateProjectRow,
  type ProjectRow,
} from "@/lib/supabase/projects";
import { AuthProvider, useUser } from "@/lib/auth-context";
import SaveModal from "./SaveModal";
import ExportAppModal from "./ExportAppModal";
import NodeInspectorPopup from "./NodeInspectorPopup";
import { buildExportManifest } from "@/lib/export-manifest";
import {
  audioBufferToWav,
  renderExportAudioBuffer,
  type ExportAudioSpec,
} from "@/lib/export-audio";
import type { AudioFileParamValue, VideoFileParamValue } from "@/engine/types";
import PublicPrivateConfirm from "./PublicPrivateConfirm";
import NewProjectConfirm from "./NewProjectConfirm";
import {
  clearEditorSession,
  readEditorSession,
  writeEditorSession,
} from "@/state/editor-session";
import type { SaveState } from "./FileNameMenu";
import TransformGizmo from "./TransformGizmo";
import PrimitiveGizmo, {
  PRIMITIVE_GIZMO_ADAPTERS,
  type PrimitiveGizmoEnv,
} from "./PrimitiveGizmo";
import SplineEditorOverlay from "./SplineEditorOverlay";
import SegmentDotsOverlay from "./SegmentDotsOverlay";
import GradientOverlay from "./GradientOverlay";
import type { SegmentDot } from "@/lib/ai/segment";
import {
  clearLiveSegment,
  isSegmentLocked,
  runLiveSegment,
} from "@/lib/ai/segment-session";
import PointsOverlay from "./PointsOverlay";
import WebGPUParticleOverlay from "./WebGPUParticleOverlay";
import Scene3DViewport from "./Scene3DViewport";
import { resolveParticleTestCount } from "@/nodes/effect/webgpu-particle-test";
import { TrackEditor } from "./TrackEditor";
import { GraphEditor } from "./GraphEditor";
import { LayersEditor } from "./LayersEditor";
import {
  DEFAULT_TICKS_PER_FRAME,
  emptyAnimationBlock,
  evaluateKeyframesAt,
  isKeyframable,
  upsertKeyframe,
  type KeyframeAnimationBlock,
  type ProjectTimeline,
} from "@/engine/keyframes";
import type { ClipBlock } from "@/engine/clips";
import type { PointsValue } from "@/engine/types";
import type { SplineParamValue } from "@/nodes/source/spline-draw";

registerAllNodes();

// Fresh-session scaffold: Output + "Layer 1" with the starter chain
// inside (see buildStarterGraph). The editor opens inside the layer.
const STARTER = buildStarterGraph();
const INITIAL_NODES: Node<NodeDataPayload>[] = STARTER.nodes;
const INITIAL_EDGES: Edge[] = STARTER.edges;

// Node label from a loaded file name: drop the extension so the network
// reads as "sunset" rather than "sunset.jpg". Falls back to the raw name
// for extensionless files.
function fileLabel(name: string): string {
  return name.replace(/\.[^/.]+$/, "") || name;
}

// Hex → straight-alpha RGBA floats [r,g,b,a] in 0..1 — the form the keyframe
// engine interpolates colors in. Used to store a multipoint gradient point's
// color keyframe value from its hex (see the gradient_points autokey mirror).
function hexToRgba01Tuple(hex: string): [number, number, number, number] {
  const h = (hex || "#ffffff").replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  const a = s.length >= 8 ? parseInt(s.slice(6, 8), 16) : 255;
  return [
    (Number.isFinite(r) ? r : 255) / 255,
    (Number.isFinite(g) ? g : 255) / 255,
    (Number.isFinite(b) ? b : 255) / 255,
    (Number.isFinite(a) ? a : 255) / 255,
  ];
}

// Fingerprint that ignores positions.
const refIds = new WeakMap<object, number>();
let refCounter = 0;
function refId(obj: object, tag: string) {
  let id = refIds.get(obj);
  if (id == null) {
    id = ++refCounter;
    refIds.set(obj, id);
  }
  return `${tag}#${id}`;
}
function fp(v: unknown): string {
  if (v == null) return "_";
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean")
    return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(fp).join(",") + "]";
  if (typeof ImageBitmap !== "undefined" && v instanceof ImageBitmap) {
    return refId(v, "bmp");
  }
  if (
    typeof HTMLCanvasElement !== "undefined" &&
    v instanceof HTMLCanvasElement
  ) {
    // Treat the drawing canvas as a stable identity token; pixel mutations
    // are tracked via the sibling `snapshot` ImageBitmap.
    return refId(v, "cnv");
  }
  if (typeof v === "object")
    return (
      "{" +
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, val]) => k + ":" + fp(val))
        .join(",") +
      "}"
    );
  return "?";
}

// Bootstrap payload for the `/p/<slug>` editor route. When present,
// EffectsApp deserializes the supplied graph on mount and seeds the
// `currentProject` state from the supplied metadata, bypassing the
// session-storage rehydrate path. The rehydrate path stays in place
// for plain `/` navigation (e.g. /docs round-trips).
export interface InitialProjectPayload {
  id: string;
  name: string;
  isPublic: boolean;
  publicSlug: string | null;
  ownerId: string;
  authorName: string | null;
  graph: SavedProject;
}

// Resolve an Output node's animated-export frame range. Half-open
// [startFrame, endFrame): frame count = end − start. Falls back to the legacy
// `videoFrames` duration param for any in-memory node that predates the
// start/end split and never went through deserialize (old saves migrate in
// project.ts). Shared by exportVideo and exportSequence.
function resolveFrameRange(params: Record<string, unknown>): {
  startFrame: number;
  endFrame: number;
  durationFrames: number;
} {
  const startFrame = Math.max(0, Math.round((params.startFrame as number) ?? 0));
  const legacyDuration = (params.videoFrames as number) ?? 240;
  const endRaw = params.endFrame;
  const endFrame =
    typeof endRaw === "number"
      ? Math.round(endRaw)
      : startFrame + legacyDuration;
  const durationFrames = Math.max(1, endFrame - startFrame);
  return { startFrame, endFrame: startFrame + durationFrames, durationFrames };
}

export default function EffectsApp({
  initialProject,
}: {
  initialProject?: InitialProjectPayload;
} = {}) {
  return (
    <AuthProvider>
      <ReactFlowProvider>
        <EffectsShell initialProject={initialProject} />
      </ReactFlowProvider>
    </AuthProvider>
  );
}

function EffectsShell({
  initialProject,
}: {
  initialProject?: InitialProjectPayload;
}) {
  // Rehydrate from the session stash if the user is returning from
  // a route change (e.g. /docs → back to /). Read once; if present,
  // seed every piece of React state below from the same snapshot so
  // they're all internally consistent on first paint.
  //
  // When `initialProject` is supplied (the /p/<slug> editor route),
  // its metadata seeds `currentProject` synchronously so the menu
  // bar pill shows the right name from the first paint. The graph
  // itself is deserialized asynchronously in an effect below — the
  // initial nodes/edges briefly show the empty default before the
  // load resolves.
  const rehydrate = initialProject ? null : readEditorSession();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<NodeDataPayload>>(
    rehydrate?.nodes ?? INITIAL_NODES
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(
    rehydrate?.edges ?? INITIAL_EDGES
  );
  const [selectedId, setSelectedId] = useState<string | null>(
    rehydrate?.selectedId ?? null
  );
  const [canvasRes, setCanvasRes] = useState<[number, number]>(
    rehydrate?.canvasRes ?? [1024, 1024]
  );

  // Media params (video/audio files) the last project load couldn't
  // silently relink — drives the relink modal, which tracks a per-item
  // status (missing / ok / failed) across relink attempts. Reset by
  // every load (deserializeGraph reports the fresh list, possibly empty).
  const [relinkItems, setRelinkItems] = useState<RelinkItem[]>([]);
  const [relinkBusy, setRelinkBusy] = useState(false);
  const setMissingMedia = useCallback((missing: MissingMedia[]) => {
    setRelinkItems(
      missing.map((media) => ({ media, status: "missing" as const }))
    );
  }, []);

  // /p/<slug> bootstrap. Runs once on mount when initialProject was
  // supplied; deserializes the saved graph and seeds the editor.
  // The graph payload was loaded server-side and passed in, so we
  // don't need to await any DB call here — the hop is purely from
  // SavedProject (JSON) to the live ReactFlow shape.
  useEffect(() => {
    if (!initialProject) return;
    let cancelled = false;
    (async () => {
      try {
        const { nodes: nextNodes, edges: nextEdges, scene, missingMedia } =
          await deserializeGraph(initialProject.graph);
        if (cancelled) return;
        setNodes(nextNodes);
        setEdges(nextEdges);
        setCurrentGroupId(defaultScopeFor(nextNodes));
        setMissingMedia(missingMedia);
        if (scene) {
          if ("loopFrames" in scene) setLoopFrames(scene.loopFrames ?? null);
          if (scene.fps !== undefined) setFps(scene.fps);
          if (scene.width !== undefined && scene.height !== undefined)
            setCanvasRes([scene.width, scene.height]);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[EffectsApp] /p/<slug> bootstrap failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
    // initialProject is captured at mount; route changes that swap
    // the slug remount the page (Next.js dynamic route default), so
    // we intentionally don't depend on it here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Preview render scale. Decouples the GL render resolution from
  // both the on-screen canvas size and the project export resolution
  // — lowering it gives the user a quick way to crank up fps during
  // live editing without touching the project. Persisted in
  // localStorage (not in the project file) since it's a per-machine
  // viewing preference, not project content.
  const [previewScale, setPreviewScale] = useState<number>(() => {
    if (typeof window === "undefined") return 1;
    const raw = window.localStorage.getItem("viewport.previewScale");
    const n = raw ? Number(raw) : 1;
    return Number.isFinite(n) && n > 0 && n <= 1 ? n : 1;
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("viewport.previewScale", String(previewScale));
  }, [previewScale]);
  const renderRes: [number, number] = useMemo(
    () => [
      Math.max(2, Math.round(canvasRes[0] * previewScale)),
      Math.max(2, Math.round(canvasRes[1] * previewScale)),
    ],
    [canvasRes, previewScale]
  );
  // Controls which panel the right-side parameters section is showing.
  // Selecting a node switches it to "node"; Project Settings flips it to
  // "project"; File → Load flips it to "load" (grid of saved projects).
  // First-load default: open the Load Projects browser. The user
  // arrives most often wanting to pick up an existing project (their
  // own private list when signed in, the public gallery otherwise),
  // so surfacing it immediately beats showing an empty node panel.
  // Skipped when:
  //   • rehydrate is present — the editor is restoring an in-progress
  //     session, so respect whichever view they had open.
  //   • initialProject is present — /p/<slug> route opens straight to
  //     a specific project; the load grid would just hide it.
  const [paramView, setParamView] = useState<"project" | "node" | "load">(
    rehydrate?.paramView ?? (initialProject ? "node" : "load")
  );
  // First-load landing gateway. Shown only on a clean visit to `/` —
  // skipped when arriving via /p/<slug> (initialProject) or when
  // restoring an in-progress session (rehydrate), since both already
  // resolve to a specific graph the user expects to see immediately.
  const [showLanding, setShowLanding] = useState(
    !initialProject && !rehydrate
  );
  // Once the menu bar has finished sliding in we drop its wrapper's
  // transform back to `none`. A lingering transform establishes a
  // stacking context that would trap the menu dropdowns beneath the
  // editor body — so it must only exist while actually animating.
  const [menuSettled, setMenuSettled] = useState(!showLanding);
  // Full-canvas mode: canvas fills the viewport, all other UI chrome
  // is hidden. Toggled via the F shortcut or the Window menu's "Full
  // Canvas" item. Esc exits.
  const [fullCanvas, setFullCanvas] = useState(false);
  // After-Effects-style layout. When on, the page splits into a
  // tabbed Parameters / Node Editor pane on the left, a canvas on
  // the right, an always-visible Tracks editor stretching across
  // the bottom, and the playback bar (timeline) below it. The
  // existing "default" layout is the alternative.
  const [timelineLayout, setTimelineLayout] = useState(false);
  // Active tab in the timeline-layout left pane. Defaults to
  // Parameters per the spec; the user can flip to the node editor
  // when they need to wire things up without leaving this layout.
  const [timelineLayoutTab, setTimelineLayoutTab] = useState<
    "params" | "nodes"
  >("params");
  // Split viewport: stacks two preview canvases vertically. Each canvas
  // has its own active terminal node — the per-node header gains a
  // second "A2" toggle (alongside "A1") so the user can independently
  // pick which subgraph drives which viewport. Toggled via Shift+S or
  // the Window menu.
  const [viewportSplit, setViewportSplit] = useState(false);
  // EffectNode reads this via the same `effect-node-toggle` event bus
  // it already uses for active/bypass — but it also needs the boolean
  // synchronously to decide whether to render the second toggle. Push
  // it as a window event so EffectNode can subscribe without prop
  // threading through React Flow's data-only API.
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("viewport-split-changed", {
        detail: { split: viewportSplit },
      })
    );
  }, [viewportSplit]);
  // Show an FPS counter in the menu bar. Reflects overall page render
  // rate via rAF — if anything blocks the main thread (React re-render,
  // MediaPipe stall, heavy graph eval) it shows up here.
  const [showFps, setShowFps] = useState(false);
  // When on, EffectNode subscribes to the post-eval timings event and
  // renders each node's compute() duration above its top-left corner.
  // Dispatched separately from showFps so users can pick how much
  // overlay noise they want.
  const [showNodeTimings, setShowNodeTimings] = useState(false);
  const showNodeTimingsRef = useRef(showNodeTimings);
  showNodeTimingsRef.current = showNodeTimings;
  // When the toggle goes off we send a single clearing event so
  // EffectNodes can drop their last-shown values.
  useEffect(() => {
    if (!showNodeTimings) {
      window.dispatchEvent(
        new CustomEvent("node-timings", { detail: null })
      );
    }
  }, [showNodeTimings]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return;
      }
      if (e.key === "f" || e.key === "F") {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        e.preventDefault();
        setFullCanvas((v) => !v);
      } else if (e.key === " ") {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        e.preventDefault();
        setPlaying((p) => !p);
      } else if ((e.key === "S" || e.key === "s") && e.shiftKey) {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        e.preventDefault();
        setViewportSplit((v) => !v);
      } else if (e.key === "0") {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        e.preventDefault();
        v1.reset();
        v2.reset();
      } else if (
        (e.key === "n" || e.key === "N" || e.code === "KeyN") &&
        (e.metaKey || e.ctrlKey) &&
        e.altKey &&
        !e.shiftKey
      ) {
        // Cmd+Alt+N (Ctrl+Alt+N on win/linux) → new project. Plain
        // Cmd+N is reserved by the browser for "new window" and isn't
        // deliverable to JS, so we use the Alt-modified variant.
        e.preventDefault();
        handleNewProjectRef.current();
      } else if (e.key === "Escape" && fullCanvas) {
        e.preventDefault();
        setFullCanvas(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullCanvas]);

  const enterBrowserFullscreen = useCallback(() => {
    const el = document.documentElement;
    if (!document.fullscreenElement) {
      el.requestFullscreen?.().catch((err) => {
        console.warn("requestFullscreen rejected:", err);
      });
    }
  }, []);

  // React Flow echoes one final onSelectionChange with the previously-
  // selected node after we programmatically deselect via setNodes
  // (during File → Load / Project Settings). Without a guard, that
  // echo calls onSelectNode(oldId) → setParamView("node"), undoing
  // the view switch we just made. This ref is set by the menu
  // handlers immediately before the deselect, and consumed on the
  // next onSelectNode to swallow exactly one stale echo.
  const suppressNextSelectionViewFlipRef = useRef(false);
  // Bumped after every save so the load grid refetches on next view.
  const [loadRefreshKey, setLoadRefreshKey] = useState(0);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  // User Preferences modal — Toolbox menu → User Preferences. Hosts
  // the BYO OpenAI key for AI-driven nodes plus future editor-wide
  // settings.
  const [userPrefsOpen, setUserPrefsOpen] = useState(false);
  // Export App modal — populated with the target Output node id when the
  // user hits Export App from either the node header or ParamPanel.
  const [exportApp, setExportApp] = useState<{ outputNodeId: string } | null>(
    null
  );
  const [exportAppBusy, setExportAppBusy] = useState(false);
  // Node IDs whose data inspector is currently open. The eval loop
  // captures their inputs each frame; the popups read from
  // inspectSnapshotsRef. Stored as an array so React equality is cheap;
  // converted to a Set per-eval.
  const [inspectIds, setInspectIds] = useState<string[]>([]);
  const inspectIdsRef = useRef<Set<string>>(new Set());
  inspectIdsRef.current = new Set(inspectIds);
  const inspectSnapshotsRef = useRef<
    Map<
      string,
      {
        inputs: Record<string, import("@/engine/types").SocketValue | undefined>;
        output: import("@/engine/types").NodeOutput | undefined;
      }
    >
  >(new Map());
  // Bumped after each eval that touched at least one inspected node so the
  // popups re-render. rAF-throttled inside the eval loop to avoid React
  // thrash when the graph runs at 60fps.
  const [inspectTick, setInspectTick] = useState(0);
  const inspectRafRef = useRef<number | null>(null);
  const scheduleInspectBump = useCallback(() => {
    if (inspectRafRef.current != null) return;
    inspectRafRef.current = requestAnimationFrame(() => {
      inspectRafRef.current = null;
      setInspectTick((n) => n + 1);
    });
  }, []);
  // Click-outside dismissal: a click anywhere that isn't an inspector
  // panel or an `i` toggle closes the most-recently-opened inspector.
  // We close one at a time (LIFO) so a user with several open can dismiss
  // them one click at a time, the same way stacked modals usually behave.
  useEffect(() => {
    if (inspectIds.length === 0) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      // Allow clicks inside any inspector panel.
      if (target.closest("[data-node-inspector]")) return;
      // Allow clicks on an `i` toggle — that path drives toggling itself.
      if (target.closest("[data-node-inspect-toggle]")) return;
      const last = inspectIds[inspectIds.length - 1];
      setInspectIds((prev) => prev.filter((x) => x !== last));
      inspectSnapshotsRef.current.delete(last);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [inspectIds]);
  // When set, plain "Save" silently overwrites this row; cleared only by
  // switching to a different project (Load or Save As creating a new row).
  const [currentProject, setCurrentProject] = useState<
    | {
        id: string;
        name: string;
        isPublic: boolean;
        // Mirrors projects.public_slug. Carried so the file-name menu
        // can build the /p/<slug> editor link without a separate fetch.
        // null when the project isn't currently public.
        publicSlug: string | null;
        // user_id of whoever authored this row. Used to gate Save /
        // rename / visibility-toggle: when the viewer isn't the owner,
        // Save forks a private copy (`_copy`) instead of attempting a
        // DB update that RLS would reject.
        ownerId: string;
        // Display name of the author when the viewer doesn't own the
        // row (used for the "by <name>" hint). null when it's the
        // viewer's own project.
        authorName: string | null;
      }
    | null
  >(
    initialProject
      ? {
          id: initialProject.id,
          name: initialProject.name,
          isPublic: initialProject.isPublic,
          publicSlug: initialProject.publicSlug,
          ownerId: initialProject.ownerId,
          authorName: initialProject.authorName,
        }
      : (rehydrate?.currentProject ?? null)
  );
  // Menu-bar pill status. Flips to "dirty" on any graph push, back to
  // "saved" on successful save/load, and to "error" when a save fails.
  // The DB doesn't track is_public yet; we hold it locally so the toggle
  // UI can ship today — when the column lands, the save/load paths each
  // have a single place to start persisting it.
  const [saveState, setSaveState] = useState<SaveState>(
    rehydrate?.saveState ?? "saved"
  );
  // Visibility confirm modal: `null` closed, otherwise the direction
  // the user is trying to toggle to.
  const [pendingVisibility, setPendingVisibility] = useState<
    null | { toPublic: boolean }
  >(null);
  // Mirror of the user's private-project list, used purely for
  // client-side name-collision detection in the Save As modal and
  // the file-name pill. Backed by the `listPrivateProjects` cache so
  // this typically costs zero extra egress — the same call warms the
  // Load grid too.
  //
  // Declared up here (before the save/rename handlers that consume
  // it via findConflict) so JS module initialization sees the helper
  // before the useCallbacks close over it.
  const [privateRows, setPrivateRows] = useState<ProjectRow[]>([]);
  const findConflict = useCallback(
    (name: string, excludeId?: string): ProjectRow | null => {
      const trimmed = name.trim();
      if (!trimmed) return null;
      return (
        privateRows.find(
          (r) => r.name === trimmed && r.id !== excludeId
        ) ?? null
      );
    },
    [privateRows]
  );
  const { user } = useUser();
  const signedIn = !!user;
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Default to a 50/50 split between canvas and the right column. The SSR
  // pass uses a placeholder; we swap to half the viewport on mount to avoid
  // a hydration mismatch.
  const [rightColWidth, setRightColWidth] = useState(520);
  useEffect(() => {
    setRightColWidth(Math.floor(window.innerWidth / 2));
  }, []);
  const [bottomRowHeight, setBottomRowHeight] = useState(280);

  const backendRef = useRef<EngineBackend | null>(null);
  const evalCacheRef = useRef<EvalCache>(new Map());
  // Outputs map from the most recent evaluateGraph pass. The eval cache
  // only holds STABLE nodes — uncacheable sources (Video, Webcam: stable:
  // false) never land there, so panel-side readers (getRefImageBlob, the
  // Segment bake driver) fall back to this for their pixels. Holding the
  // ref also pins the transient output textures (they're GC-freed once
  // unreferenced), so a one-frame-old read stays valid.
  const lastEvalOutputsRef = useRef<ReturnType<
    typeof evaluateGraph
  >["outputs"] | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Second preview canvas, only mounted in split-viewport mode. Driven
  // by the same evaluator on each tick — see renderFrame for the
  // double-pass eval. Overlays (paint / spline / gizmo) stay anchored
  // to the primary canvas to keep their pointer math simple.
  const canvas2Ref = useRef<HTMLCanvasElement | null>(null);
  const [backendReady, setBackendReady] = useState(false);
  // Per-viewport pan/zoom. Two viewports each carry independent state so
  // the user can frame each preview separately when split. The
  // underlying canvas resolution doesn't change — only the on-screen
  // transform — so overlays anchored via getBoundingClientRect stay
  // aligned. Reset both with "0".
  const v1 = useViewportPanZoom();
  const v2 = useViewportPanZoom();
  // Bind each viewport's wheel + middle-click handlers to its own ref.
  useViewportGestures(v1.viewportRef, v1.setPan, v1.setZoom);
  useViewportGestures(v2.viewportRef, v2.setPan, v2.setZoom);
  // Mouse-vs-trackpad detection. One capture-phase wheel listener feeds the
  // sticky detector so every pan/zoom handler shares one device read,
  // regardless of which surface ultimately consumes the event. See
  // input-device.ts / specdocs/061726_mouse-input-ux.md.
  useEffect(() => {
    const onWheel = (e: WheelEvent) => feedWheel(e);
    window.addEventListener("wheel", onWheel, { capture: true, passive: true });
    return () =>
      window.removeEventListener("wheel", onWheel, { capture: true });
  }, []);
  // Overlays subscribe to window "resize" to refresh their cached rect.
  // Overlays only ride viewport 1, so only its transform needs to fire
  // the resize event.
  useEffect(() => {
    window.dispatchEvent(new Event("resize"));
  }, [v1.zoom, v1.pan]);
  // Vertical split between the two preview viewports. Lives as a
  // fraction of the canvas-area height so the divider can be dragged.
  const [viewportSplitRatio, setViewportSplitRatio] = useState(0.5);
  // Incremented when a source needs the pipeline to re-evaluate while
  // nothing else has changed. High-frequency bumpers (webcam ~30Hz,
  // MediaPipe trackers, audio meters) would otherwise trigger a React
  // re-render of this whole shell per event — at 30+Hz that tanks
  // interactivity regardless of what the pipeline itself is doing.
  //
  // Collapse multiple bumps within one animation frame into a single
  // state update. React re-renders at most once per rAF tick, no
  // matter how many events fire.
  const [pipelineBumpKey, setPipelineBumpKey] = useState(0);
  useEffect(() => {
    let scheduled = false;
    const onBump = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        setPipelineBumpKey((n) => n + 1);
      });
    };
    window.addEventListener("pipeline-bump", onBump);
    return () => window.removeEventListener("pipeline-bump", onBump);
  }, []);

  // Live cursor position in canvas UV. The ref carries the fresh value so
  // the render context always sees the current pointer; `cursorTick` is a
  // rAF-throttled state bump so paused pipelines re-evaluate on move.
  const cursorRef = useRef<{ x: number; y: number; active: boolean }>({
    x: 0.5,
    y: 0.5,
    active: false,
  });
  const [cursorTick, setCursorTick] = useState(0);
  // Mirror playback flags into a ref so the pointermove listener
  // (which lives in a setup-once useEffect) can read the live value
  // without re-binding listeners on every play / pause toggle.
  const playbackActiveRef = useRef(false);
  useEffect(() => {
    let rafId: number | null = null;
    let lastBumpedActive = false;
    let lastBumpedX = -1;
    let lastBumpedY = -1;
    const scheduleBump = () => {
      if (rafId != null) return;
      // While playback is running the renderFrame effect is already
      // scheduled every frame from the playback rAF — bumping
      // cursorTick on top would just queue an extra render per
      // pointermove. Skipping here keeps the cursor-driven re-render
      // path scoped to the paused case it was intended for.
      if (playbackActiveRef.current) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        // Skip the state churn entirely when nothing changed since
        // the last bump. This is what guards against the runaway
        // re-render React was tripping on — repeated `setState((n)
        // => n + 1)` calls with identical incoming pointer state.
        const c = cursorRef.current;
        if (
          c.active === lastBumpedActive &&
          Math.abs(c.x - lastBumpedX) < 1e-4 &&
          Math.abs(c.y - lastBumpedY) < 1e-4
        ) {
          return;
        }
        lastBumpedActive = c.active;
        lastBumpedX = c.x;
        lastBumpedY = c.y;
        setCursorTick((n) => n + 1);
      });
    };
    const onMove = (e: PointerEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      // DOM y-down → pipeline y-up. All pipeline textures treat v_uv.y = 0
      // as the bottom of the frame, so we flip the pointer value here.
      const yDom = (e.clientY - rect.top) / rect.height;
      const y = 1 - yDom;
      const inside = x >= 0 && x <= 1 && yDom >= 0 && yDom <= 1;
      const prev = cursorRef.current;
      cursorRef.current = { x, y, active: inside };
      // Only nudge a re-render when the pointer is actually inside
      // the canvas (or just left it). Pointer movement anywhere else
      // on the page has no bearing on what the pipeline produces, so
      // there's no point re-rendering for it.
      if (inside || prev.active) scheduleBump();
    };
    const onLeave = () => {
      const prev = cursorRef.current;
      cursorRef.current = { ...prev, active: false };
      if (prev.active) scheduleBump();
    };
    window.addEventListener("pointermove", onMove);
    document.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", onLeave);
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, []);

  // Timeline / playback state.
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [fps, setFps] = useState(60);
  const [loopFrames, setLoopFrames] = useState<number | null>(null);
  // Per-parameter keyframe time model. `time` (seconds) remains the
  // source of truth for playback (RAF still ticks in seconds); `tick` is
  // the integer tick representation derived from time × fps × tpf, used
  // by the keyframe evaluator and Track Editor for exact equality.
  const ticksPerFrame = DEFAULT_TICKS_PER_FRAME;
  const currentTick = Math.round(time * fps * ticksPerFrame);
  const sceneDurationTicks =
    (loopFrames != null && loopFrames > 0 ? loopFrames : fps * 5) *
    ticksPerFrame;
  const projectTimeline: ProjectTimeline = {
    ticksPerFrame,
    fps,
    sceneDurationTicks,
  };
  // Track Editor + Graph Editor UI state.
  const [trackEditorOpen, setTrackEditorOpen] = useState(false);
  const [trackEditorHeight, setTrackEditorHeight] = useState(280);
  // Slide-up animation for the default-layout dock. `mounted` keeps the
  // dock in the DOM through its exit slide; `shown` drives the transform
  // (false = parked below the canvas, true = expanded into view).
  const [trackDockMounted, setTrackDockMounted] = useState(false);
  const [trackDockShown, setTrackDockShown] = useState(false);
  useEffect(() => {
    if (trackEditorOpen) {
      setTrackDockMounted(true);
      const id = requestAnimationFrame(() => setTrackDockShown(true));
      return () => cancelAnimationFrame(id);
    }
    setTrackDockShown(false);
    const t = setTimeout(() => setTrackDockMounted(false), 260);
    return () => clearTimeout(t);
  }, [trackEditorOpen]);
  const [dockTab, setDockTab] = useState<"tracks" | "graph" | "layers">(
    "layers"
  );
  // Node-group scope: which group's interior the node editor shows.
  // undefined = root. Navigation state, deliberately NOT part of undo
  // history — undoing a group creation while inside it falls back to
  // root via the stale-scope effect below. A fresh or rehydrated
  // single-layer project opens inside its layer.
  const [currentGroupId, setCurrentGroupId] = useState<string | undefined>(
    () => defaultScopeFor(rehydrate?.nodes ?? INITIAL_NODES)
  );
  const currentGroupIdRef = useRef(currentGroupId);
  currentGroupIdRef.current = currentGroupId;
  // When on, the tracks editor only shows lanes for nodes that are
  // currently selected in the node editor. Keeps the dock readable
  // when a graph has dozens of animated parameters.
  const [tracksSelectedOnly, setTracksSelectedOnly] = useState(false);
  const [graphNormalizeY, setGraphNormalizeY] = useState(false);
  const [graphRefitVersion, setGraphRefitVersion] = useState(0);
  const [trackFitVersion, setTrackFitVersion] = useState(0);
  const [collapsedTrackNodes, setCollapsedTrackNodes] = useState<Set<string>>(
    new Set()
  );
  // During scrubbing the RAF advancer is suspended so the drag can set time
  // directly without a running playback stepping on the mouse. `playing`
  // itself isn't touched, so clearing `scrubbing` restores the prior state —
  // a timeline that was paused before the drag stays paused.
  const [scrubbing, setScrubbing] = useState(false);
  // Keep the cursor-bump effect's "should I bump?" check in sync with
  // playback. The renderFrame loop already runs every frame while
  // playing, so an extra cursor-driven re-render is redundant — and
  // was the source of the runaway re-render loop.
  useEffect(() => {
    playbackActiveRef.current = playing && !scrubbing;
  }, [playing, scrubbing]);

  // Refs let the history hook read the latest graph state without having to
  // thread it through every undoable action's dependency list.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;
  // Mirror refs for every piece of editor-session state so the
  // unmount cleanup below can snapshot the latest values without
  // reopening the whole "state in closures" problem. Kept as a
  // cluster right next to nodesRef so future additions know where
  // to land.
  const currentProjectRef = useRef(currentProject);
  currentProjectRef.current = currentProject;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  // When a 3D node is selected, the bound Scene Render id — used to retarget
  // the preview eval so its scene populates/publishes for the orbit viewport.
  // Assigned from the `active3DSceneRenderId` memo further down.
  const viewport3DTargetRef = useRef<string | null>(null);
  const paramViewRef = useRef(paramView);
  paramViewRef.current = paramView;
  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;
  const canvasResRef = useRef(canvasRes);
  canvasResRef.current = canvasRes;

  // Capsule for surviving a same-tab route change (e.g. docs "i"
  // button). Effect has empty deps on purpose: we only want the
  // cleanup to fire on true unmount, not on every state change.
  useEffect(() => {
    return () => {
      writeEditorSession({
        nodes: nodesRef.current,
        edges: edgesRef.current,
        currentProject: currentProjectRef.current,
        selectedId: selectedIdRef.current,
        paramView: paramViewRef.current,
        saveState: saveStateRef.current,
        canvasRes: canvasResRef.current,
      });
    };
  }, []);

  const getGraphSnapshot = useCallback(
    (): GraphSnapshot => ({
      nodes: nodesRef.current,
      edges: edgesRef.current,
    }),
    []
  );
  const applyGraphSnapshot = useCallback(
    (snap: GraphSnapshot) => {
      setNodes(snap.nodes);
      setEdges(snap.edges);
    },
    [setNodes, setEdges]
  );
  // Restoring paint pixels is only half of undo — the pipeline's input is the
  // `snapshot` ImageBitmap stashed on the paint param, so we refresh it from
  // the just-restored canvas and swap it in.
  const onPaintRestore = useCallback(
    (nodeId: string, canvas: HTMLCanvasElement) => {
      createImageBitmap(canvas).then((bmp) => {
        setNodes((prev) =>
          prev.map((n) =>
            n.id === nodeId
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    params: {
                      ...n.data.params,
                      paint: { canvas, snapshot: bmp },
                    },
                  },
                }
              : n
          )
        );
      });
    },
    [setNodes]
  );

  const {
    pushGraph: rawPushGraph,
    pushPaint: rawPushPaint,
    undo: rawUndo,
    redo: rawRedo,
    canUndo,
    canRedo,
  } = useHistory({
    getGraphSnapshot,
    applyGraphSnapshot,
    onPaintRestore,
  });
  // Wrap the history mutators so any graph/paint change — including
  // undo/redo — transparently marks the menu-bar pill as dirty. Saves
  // and loads are the only paths that flip back to "saved".
  const pushGraph = useCallback<typeof rawPushGraph>(
    (before, coalesceKey) => {
      rawPushGraph(before, coalesceKey);
      setSaveState("dirty");
    },
    [rawPushGraph]
  );
  const pushPaint = useCallback<typeof rawPushPaint>(
    (snap) => {
      rawPushPaint(snap);
      setSaveState("dirty");
    },
    [rawPushPaint]
  );
  const undo = useCallback(() => {
    rawUndo();
    setSaveState("dirty");
  }, [rawUndo]);
  const redo = useCallback(() => {
    rawRedo();
    setSaveState("dirty");
  }, [rawRedo]);
  useUndoShortcuts(undo, redo);

  useEffect(() => {
    try {
      // Drop stale cache — old GL textures belong to the outgoing backend,
      // which destroys them on teardown. No need to individually release.
      evalCacheRef.current = new Map();
      const backend = createEngineBackend(renderRes[0], renderRes[1]);
      backendRef.current = backend;
      setBackendReady(true);
      return () => {
        backend.destroy();
        backendRef.current = null;
        setBackendReady(false);
      };
    } catch (e) {
      console.error("Engine init failed", e);
    }
  }, [renderRes]);

  const startVResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = rightColWidth;
    // Default layout: column lives on the right, dragging left
    // grows it (mouse moves toward the column). Timeline layout
    // flips the body to row-reverse, so the column sits on the
    // left and the same intuition (mouse moves toward the column =
    // grow) requires the opposite sign on dx.
    const reverse = timelineLayout;
    const onMove = (ev: MouseEvent) => {
      const dx = reverse ? ev.clientX - startX : startX - ev.clientX;
      setRightColWidth(
        Math.max(320, Math.min(window.innerWidth - 320, startW + dx))
      );
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [rightColWidth, timelineLayout]);

  const startHResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = bottomRowHeight;
    const onMove = (ev: MouseEvent) => {
      const dy = startY - ev.clientY;
      setBottomRowHeight(
        Math.max(120, Math.min(window.innerHeight - 160, startH + dy))
      );
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  }, [bottomRowHeight]);

  const structFp = useMemo(() => {
    const parts: string[] = [];
    for (const n of nodes) {
      const expo = (n.data.exposedParams ?? []).slice().sort().join(",");
      parts.push(
        `N:${n.id}:${n.data.defType}:${n.data.active ? 1 : 0}:${
          n.data.active2 ? 1 : 0
        }:${n.data.bypassed ? 1 : 0}:${fp(n.data.params)}:X=${expo}`
      );
    }
    for (const e of edges) {
      parts.push(
        `E:${e.source}|${e.sourceHandle}|${e.target}|${e.targetHandle}`
      );
    }
    return parts.sort().join(";");
  }, [nodes, edges]);

  // True while a deterministic offline (WebCodecs / ffmpeg) export is
  // stepping the clock itself. Two jobs:
  //   1. The time-driven eval effect bails (it would double-render each
  //      frame, and a stray trigger could capture the wrong frame).
  //   2. It flows into ctx.offline so nodes with async/deferred-settle
  //      work (the WebGPU stipple relax) run synchronously instead —
  //      otherwise the export captures stale/seed frames.
  // The live/MediaRecorder path leaves this false (it's realtime; the
  // continuous loop lets deferred results catch up).
  const offlineRenderingRef = useRef(false);

  // When set, forces the terminal/active node for the render — used by the
  // export paths so a batch render captures the *specific* Output being
  // exported, not whatever the user happens to have set Active. Cleared back
  // to null when the export finishes.
  const forcedTerminalRef = useRef<string | null>(null);

  // Imperative render entry point. Pulls graph + cursor from refs so it
  // can be called both from the React-driven render effect AND from the
  // offline export loops, where we need to step time deterministically
  // without going through React's render cycle. `playingHint` lets the
  // caller force the playing flag (so audio/anim parts of the graph
  // advance correctly during offline encoding).
  const renderFrame = useCallback(
    (renderTime: number, renderFps: number, playingHint: boolean) => {
      const backend = backendRef.current;
      const canvas = canvasRef.current;
      if (!backend || !backendReady || !canvas) return;

      const currentNodes = nodesRef.current;
      const currentEdges = edgesRef.current;
      const graphNodes: GraphNode[] = currentNodes.map((n) => ({
        id: n.id,
        type: n.data.defType,
        parentId: n.data.parentId,
        params: n.data.params,
        exposedParams: n.data.exposedParams,
        animation: n.data.animation,
        clips: n.data.clips,
        bypassed: !!n.data.bypassed,
      }));
      const activeNodeId =
        forcedTerminalRef.current ??
        (currentNodes.find((n) => n.data.active)?.id ?? null);
      const activeNodeId2 =
        currentNodes.find((n) => n.data.active2)?.id ?? null;
      // When nothing is explicitly set Active, preview the selected node's
      // own image (primary image, or its `image` aux) on the canvas — so a
      // freshly-added node (e.g. a spline primitive) is viewable without
      // wiring it to an Output.
      // A 3D selection retargets the preview to its bound Scene Render so
      // that node evaluates and publishes its scene for the orbit viewport
      // (the 2D preview it produces sits hidden under the viewport overlay).
      const previewNodeId = !activeNodeId
        ? viewport3DTargetRef.current ?? selectedIdRef.current
        : null;
      const graphEdges: GraphEdge[] = currentEdges.map((e) => ({
        id: e.id,
        source: e.source,
        sourceHandle: e.sourceHandle ?? "out:primary",
        target: e.target,
        targetHandle: e.targetHandle ?? "in:image",
      }));

      const tpf = DEFAULT_TICKS_PER_FRAME;
      const ctx = backend.makeContext(
        renderTime,
        Math.floor(renderTime * renderFps),
        cursorRef.current,
        playingHint,
        {
          tick: Math.round(renderTime * renderFps * tpf),
          ticksPerFrame: tpf,
          fps: renderFps,
        },
        offlineRenderingRef.current
      );
      const inspectSet = inspectIdsRef.current;
      const result = evaluateGraph(
        graphNodes,
        graphEdges,
        ctx,
        evalCacheRef.current,
        activeNodeId,
        inspectSet.size > 0 ? inspectSet : undefined,
        previewNodeId
      );
      lastEvalOutputsRef.current = result.outputs;
      // Bail when the error set is unchanged. evaluateGraph returns a
      // fresh object every frame, so a naive setErrors(result.errors)
      // changes the reference every render — and triggers the
      // [errors]-dep effect below to call setNodes again, which can
      // cascade into React's "Maximum update depth exceeded" guard
      // when other state is also churning. Shallow equality is enough
      // since errors is a flat string-keyed map.
      setErrors((prev) => {
        const next = result.errors;
        const prevKeys = Object.keys(prev);
        const nextKeys = Object.keys(next);
        if (prevKeys.length !== nextKeys.length) return next;
        for (const k of nextKeys) if (prev[k] !== next[k]) return next;
        return prev;
      });

      // Stash inspect snapshots for the popups. Inputs come from the
      // eval result; outputs are pulled from the same `outputs` map the
      // engine just produced. Snapshots are intentionally shallow — the
      // popup reads them on the same frame, so the underlying texture /
      // canvas references stay alive.
      if (inspectSet.size > 0 && result.inspectInputs) {
        const next = new Map(inspectSnapshotsRef.current);
        for (const id of inspectSet) {
          const snap = result.inspectInputs.get(id);
          next.set(id, {
            inputs: snap?.inputs ?? {},
            output: result.outputs.get(id),
          });
        }
        // Drop entries for ids no longer being inspected.
        for (const k of next.keys()) {
          if (!inspectSet.has(k)) next.delete(k);
        }
        inspectSnapshotsRef.current = next;
        scheduleInspectBump();
      }

      if (showNodeTimingsRef.current) {
        window.dispatchEvent(
          new CustomEvent("node-timings", { detail: result.timings })
        );
      }

      const blitOrPlaceholder = (
        target: HTMLCanvasElement,
        image:
          | { image: { kind: string } }
          | null
          | undefined,
        placeholder: string
      ) => {
        if (image && (image as { image: { kind: string } }).image.kind === "image") {
          ctx.blitToCanvas(
            (image as unknown as { image: import("@/engine/types").ImageValue })
              .image,
            target
          );
        } else {
          const c2d = target.getContext("2d");
          if (c2d) {
            c2d.fillStyle = "#111";
            c2d.fillRect(0, 0, target.width, target.height);
            c2d.fillStyle = "#52525b";
            c2d.font = "14px ui-monospace, monospace";
            c2d.fillText(placeholder, 20, target.height / 2);
          }
        }
      };

      blitOrPlaceholder(
        canvas,
        result.terminalImage,
        "Connect an Output node to preview."
      );

      // Split mode: re-evaluate the graph with the second active node
      // so its terminal can drive the second canvas. The eval cache is
      // shared, so any subgraph the two viewports have in common is
      // reused on this second pass — only the unique branches re-run.
      const canvas2 = canvas2Ref.current;
      if (canvas2) {
        const result2 = evaluateGraph(
          graphNodes,
          graphEdges,
          ctx,
          evalCacheRef.current,
          activeNodeId2,
          inspectSet.size > 0 ? inspectSet : undefined
        );
        blitOrPlaceholder(
          canvas2,
          result2.terminalImage,
          "Set a node Active 2 to preview here."
        );
      }
    },
    [backendReady]
  );
  const renderFrameRef = useRef(renderFrame);
  renderFrameRef.current = renderFrame;

  useEffect(() => {
    if (offlineRenderingRef.current) return;
    renderFrame(time, fps, playing && !scrubbing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    structFp,
    backendReady,
    time,
    fps,
    pipelineBumpKey,
    cursorTick,
    playing,
    scrubbing,
    // Re-render when the selection changes so the selected-node preview
    // (when nothing is set Active) updates on the canvas.
    selectedId,
  ]);

  // Capture the selected node's points output after each pipeline run so
  // PointsOverlay has fresh dots to draw. Reads the evaluator cache
  // directly — it holds the most recent NodeOutput per node regardless
  // of whether the eval effect ran on the same tick as the selection
  // change. Dep list tracks both selection and pipeline invalidation.
  useEffect(() => {
    if (!selectedId) {
      setSelectedPoints((prev) => (prev === null ? prev : null));
      return;
    }
    const entry = evalCacheRef.current.get(selectedId);
    const primary = entry?.output.primary;
    if (primary && primary.kind === "points") {
      // Bail when the same reference comes back so we don't burn a
      // re-render per playback frame just because the eval output
      // is a new object that contains the same data.
      setSelectedPoints((prev) => (prev === primary ? prev : primary));
    } else {
      setSelectedPoints((prev) => (prev === null ? prev : null));
    }
  }, [selectedId, structFp, time, pipelineBumpKey, cursorTick]);

  // Wall-clock RAF playback. `time` is measured in seconds and advances by
  // real elapsed dt each frame (so a dropped frame doesn't shorten scene
  // duration). The optional `loopFrames` value, divided by the current `fps`,
  // defines the wrap point in seconds. Scrubbing suspends the advancer.
  useEffect(() => {
    if (!playing || scrubbing) return;
    let raf = 0;
    let prev = performance.now();
    const tick = (now: number) => {
      const dt = (now - prev) / 1000;
      prev = now;
      setTime((t) => {
        let next = t + dt;
        if (loopFrames != null) {
          const loopSecs = loopFrames / fps;
          if (loopSecs > 0 && next >= loopSecs) next = next % loopSecs;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, scrubbing, loopFrames, fps]);

  // Propagate errors back into node data for rendering.
  useEffect(() => {
    setNodes((prev) =>
      prev.map((n) =>
        n.data.error === errors[n.id]
          ? n
          : { ...n, data: { ...n.data, error: errors[n.id] } }
      )
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [errors]);

  const onConnect = useCallback(
    (connection: Connection) => {
      pushGraph(getGraphSnapshot());

      // Wiring into a virtual boundary socket (Group Input / Group
      // Output's trailing "+") mints a real socket typed after the far
      // end and lands the edge there instead.
      const virtual = connectToVirtualSocket(
        nodesRef.current,
        edgesRef.current,
        connection
      );
      if (virtual) {
        setNodes(virtual.nodes);
        setEdges(virtual.edges);
        return;
      }

      // If we're dropping a UV edge on a Math node in scalar mode, promote
      // it to UV mode so the target socket is properly typed and all of
      // the node's inputs/outputs line up. Equivalent to the user
      // manually switching the Mode param first.
      const sourceNode = nodesRef.current.find((n) => n.id === connection.source);
      const targetNode = nodesRef.current.find((n) => n.id === connection.target);
      const shouldPromoteMath =
        targetNode?.data.defType === "math" &&
        targetNode.data.params.mode === "scalar" &&
        sourceOutputType(sourceNode, connection.sourceHandle ?? null) === "uv";
      if (shouldPromoteMath && targetNode) {
        setNodes((prev) =>
          prev.map((n) => {
            if (n.id !== targetNode.id) return n;
            const nextParams = { ...n.data.params, mode: "uv" };
            const def = getNodeDef(n.data.defType);
            const resolved = def?.resolveInputs?.(nextParams);
            const nextPrimary =
              def?.resolvePrimaryOutput?.(nextParams) ?? n.data.primaryOutput;
            const resolvedAux = def?.resolveAuxOutputs?.(nextParams);
            return {
              ...n,
              data: {
                ...n.data,
                params: nextParams,
                primaryOutput: nextPrimary,
                inputs: resolved
                  ? withMaskInput(resolved, def).map((i) => ({
                      name: i.name,
                      label: i.label,
                      type: i.type,
                      hidden: i.hidden,
                    }))
                  : n.data.inputs,
                auxOutputs: resolvedAux
                  ? resolvedAux.map((a) => ({
                      name: a.name,
                      type: a.type,
                      disabled: a.disabled,
                    }))
                  : n.data.auxOutputs,
              },
            };
          })
        );
      }

      // Copy-to-Points: if the incoming edge targets the `instance` socket
      // and its source type differs from the node's current mode, flip
      // mode to match. Lets users plug any of image/spline/points into
      // the same socket without touching the params panel — socket type,
      // output type, and downstream edge validity all update in one pass.
      const srcForCopy = sourceOutputType(
        sourceNode,
        connection.sourceHandle ?? null
      );
      const copySocketTypeToMode: Record<string, string> = {
        image: "image",
        image_group: "image",
        spline: "spline",
        points: "point",
      };
      const shouldPromoteCopy =
        targetNode?.data.defType === "copy-to-points" &&
        connection.targetHandle === "in:instance" &&
        srcForCopy != null &&
        copySocketTypeToMode[srcForCopy] != null &&
        targetNode.data.params.mode !== copySocketTypeToMode[srcForCopy];
      if (shouldPromoteCopy && targetNode && srcForCopy) {
        const nextMode = copySocketTypeToMode[srcForCopy];
        setNodes((prev) =>
          prev.map((n) => {
            if (n.id !== targetNode.id) return n;
            const nextParams = { ...n.data.params, mode: nextMode };
            const def = getNodeDef(n.data.defType);
            const resolved = def?.resolveInputs?.(nextParams);
            const nextPrimary =
              def?.resolvePrimaryOutput?.(nextParams) ?? n.data.primaryOutput;
            return {
              ...n,
              data: {
                ...n.data,
                params: nextParams,
                primaryOutput: nextPrimary,
                inputs: resolved
                  ? withMaskInput(resolved, def).map((i) => ({
                      name: i.name,
                      label: i.label,
                      type: i.type,
                      hidden: i.hidden,
                    }))
                  : n.data.inputs,
              },
            };
          })
        );
      }

      // Auto Layout slots accept the `element` type. Two affordances when
      // a wire lands on a slot:
      let conn = connection;
      const alSlotId = conn.targetHandle?.startsWith("in:item:")
        ? conn.targetHandle.slice("in:item:".length)
        : null;
      if (alSlotId && targetNode?.data.defType === "autolayout") {
        // 1. Redirect a primary IMAGE wire to the source's `element` aux
        //    when it has one (Image Source, Frame, Circle, Rectangle,
        //    Text...). The element output carries the raw, intrinsically-
        //    sized content and ignores the source's own canvas fit /
        //    transform — which is what you want inside a layout. The image
        //    output bakes those in (a full-canvas texture), so wiring it
        //    leaks the upstream framing downstream. Generic images (Blur,
        //    Merge, …) have no element aux and fall through to the
        //    image→element coercion unchanged.
        if (
          conn.sourceHandle === "out:primary" &&
          sourceNode?.data.primaryOutput === "image" &&
          sourceNode.data.auxOutputs?.some(
            (a) => a.name === "element" && a.type === "element"
          )
        ) {
          conn = { ...conn, sourceHandle: "out:aux:element" };
        }
        // 2. Honor the source element's advisory preferredSizing the first
        //    time a wire lands. Image Source's element is bitmap-px (far
        //    larger than the layout wants), so its slot defaults to fixed;
        //    everything else keeps the hug/hug default. Slots the user
        //    already retyped are left alone.
        if (
          conn.sourceHandle === "out:aux:element" &&
          sourceNode?.data.defType === "image-source"
        ) {
          setNodes((prev) =>
            prev.map((n) => {
              if (n.id !== targetNode.id) return n;
              const items = (n.data.params.items as AutoLayoutItem[]) ?? [];
              const nextItems = items.map((it) =>
                it.id === alSlotId &&
                it.widthMode === "hug" &&
                it.heightMode === "hug"
                  ? {
                      ...it,
                      widthMode: "fixed" as const,
                      heightMode: "fixed" as const,
                    }
                  : it
              );
              return {
                ...n,
                data: {
                  ...n.data,
                  params: { ...n.data.params, items: nextItems },
                },
              };
            })
          );
        }
      }

      setEdges((eds) => {
        const filtered = eds.filter(
          (e) =>
            !(
              e.target === conn.target &&
              e.targetHandle === conn.targetHandle
            )
        );
        return addEdge(conn, filtered);
      });
    },
    [setEdges, setNodes, pushGraph, getGraphSnapshot]
  );

  // Resolve the socket-type emitted by a given output handle. Mirrors what
  // NodeEditor's `resolveSourceSocketType` does, but scoped to just the bit
  // we need here.
  function sourceOutputType(
    node: Node<NodeDataPayload> | undefined,
    handle: string | null
  ): string | null {
    if (!node || !handle) return null;
    if (handle === "out:primary") return node.data.primaryOutput ?? null;
    if (handle.startsWith("out:aux:")) {
      const name = handle.slice("out:aux:".length);
      return node.data.auxOutputs.find((a) => a.name === name)?.type ?? null;
    }
    return null;
  }

  // Last pane cursor position in flow coordinates. Captured by NodeEditor
  // via React Flow's `screenToFlowPosition`; used below to seed newly-added
  // nodes near the user's attention point instead of a random corner.
  const lastPanePointerRef = useRef<{ x: number; y: number } | null>(null);

  // Internal copy/paste clipboard. Holds snapshots of selected nodes plus
  // any edges that live *between* the selected nodes so paste preserves the
  // subgraph's wiring. Lives as a ref — no need to re-render on writes.
  const clipboardRef = useRef<{
    nodes: Node<NodeDataPayload>[];
    edges: Edge[];
  } | null>(null);

  // Detect the source-node type a File should flow into. Checks MIME
  // first (reliable on macOS Finder drops and most clipboard paths),
  // falls back to extension for cases where the OS didn't tag the
  // file. Returns null for anything we can't auto-route.
  function detectFileKind(
    file: File
  ): "image" | "video" | "audio" | "svg" | null {
    const mime = file.type;
    if (mime === "image/svg+xml") return "svg";
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    const n = file.name.toLowerCase();
    if (n.endsWith(".svg")) return "svg";
    if (/\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(n)) return "image";
    if (/\.(mp4|webm|mov|m4v|avi|mkv)$/i.test(n)) return "video";
    if (/\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(n)) return "audio";
    return null;
  }

  // makeInstanceNode + scope stamp: every interactively-created node
  // lands in the scope the user is currently looking at. All runtime
  // node-creation paths must go through here (the module-level
  // INITIAL_NODES / new-project scaffold stay at root by design).
  const spawnNode = useCallback(
    (type: string, position: { x: number; y: number }) => {
      const n = makeInstanceNode(type, position);
      n.data.parentId = currentGroupIdRef.current;
      return n;
    },
    []
  );

  // Declared up here (ahead of the clipboard / structural handlers that
  // consume them) — a brief status toast and the group-scope navigation
  // primitives.
  const [toast, setToast] = useState<string | null>(null);
  const toastTimeoutRef = useRef<number | null>(null);
  const flashToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    toastTimeoutRef.current = window.setTimeout(() => setToast(null), 1500);
  }, []);
  useEffect(
    () => () => {
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    },
    []
  );

  // Change scope and drop the selection — selected nodes from the old
  // scope would be hidden but still selected (Delete would eat them
  // invisibly).
  const navigateScope = useCallback(
    (groupId: string | undefined) => {
      setCurrentGroupId(groupId);
      setSelectedId(null);
      setNodes((prev) =>
        prev.map((n) => (n.selected ? { ...n, selected: false } : n))
      );
    },
    [setNodes, setSelectedId]
  );

  const handleDiveIntoGroup = useCallback(
    (groupId: string) => {
      const g = nodesRef.current.find((n) => n.id === groupId);
      if (!g) return;
      if (g.data.defType !== GROUP_TYPE && g.data.defType !== LAYER_TYPE) {
        return;
      }
      navigateScope(groupId);
    },
    [navigateScope]
  );

  const handleScopeUp = useCallback(() => {
    const cur = currentGroupIdRef.current;
    if (!cur) return;
    const g = nodesRef.current.find((n) => n.id === cur);
    navigateScope(g?.data.parentId);
  }, [navigateScope]);

  // If the scope group vanishes from the graph (undo of the group's
  // creation, deletion from outside, project load), fall back to root.
  // Navigation state is not part of undo history, so this is the only
  // guard needed.
  useEffect(() => {
    if (currentGroupId && !nodes.some((n) => n.id === currentGroupId)) {
      setCurrentGroupId(undefined);
    }
  }, [nodes, currentGroupId]);

  // Create a source node for a dropped / pasted file. Mirrors the
  // per-ParamType registration path ParamPanel uses when the user
  // picks a file interactively — we get the same param value shape
  // either way (ImageBitmap / SvgFileParamValue / VideoFileParamValue
  // / AudioFileParamValue). Runs async because registration reads
  // file metadata; the node spawns as soon as the load resolves.
  const onAddFileNode = useCallback(
    async (file: File, flowPos: { x: number; y: number }) => {
      const kind = detectFileKind(file);
      if (!kind) return;

      let nodeType: string;
      let paramValue: unknown;
      try {
        if (kind === "image") {
          nodeType = "image-source";
          const bmp = await createImageBitmap(file);
          // Stash the file name on the bitmap for the param panel chip
          // (cosmetic; the GL upload ignores it).
          try {
            (bmp as unknown as { fileName?: string }).fileName = file.name;
          } catch {}
          paramValue = bmp;
        } else if (kind === "svg") {
          nodeType = "svg-source";
          const mod = await import("@/lib/svg-parse");
          const text = await file.text();
          paramValue = mod.parseSvg(text, file.name);
        } else if (kind === "video") {
          nodeType = "video-source";
          const mod = await import("@/lib/video");
          paramValue = await mod.registerVideoFile(file, flashToast);
        } else {
          nodeType = "audio-source";
          const mod = await import("@/lib/audio");
          paramValue = await mod.registerAudioFile(file);
        }
      } catch (err) {
        // Bad SVG text, corrupt video metadata, unsupported codec, etc.
        // Surface without crashing the editor — user can retry with a
        // different file. Toast so the failure isn't silent.
        // eslint-disable-next-line no-console
        console.warn(`Failed to load ${kind}:`, err);
        flashToast(
          err instanceof Error ? err.message : `Failed to load ${kind}`
        );
        return;
      }

      pushGraph(getGraphSnapshot());
      const newNode = spawnNode(nodeType, flowPos);
      newNode.data.params = { ...newNode.data.params, file: paramValue };
      // Match the Load-button path: a dropped image/video names its node.
      if (kind === "image" || kind === "video") {
        newNode.data.name = fileLabel(file.name);
      }
      // Strict root: a media drop at root becomes its own layer (named
      // after the file), with the source wired into the layer's Group
      // Output so it shows immediately.
      if (!currentGroupIdRef.current) {
        const res = createLayer(nodesRef.current, edgesRef.current, {
          name: fileLabel(file.name),
        });
        const go = res.nodes.find(
          (n) =>
            n.data.parentId === res.layerId &&
            n.data.defType === GROUP_OUTPUT_TYPE
        );
        newNode.data.parentId = res.layerId;
        const out = newNode.data.primaryOutput;
        const goSocket =
          out === "image" ? "in:image" : out === "audio" ? "in:audio" : null;
        setNodes([...res.nodes, newNode]);
        setEdges(
          go && goSocket
            ? [
                ...res.edges,
                {
                  id: newEdgeId(),
                  source: newNode.id,
                  sourceHandle: "out:primary",
                  target: go.id,
                  targetHandle: goSocket,
                },
              ]
            : res.edges
        );
        navigateScope(res.layerId);
        return;
      }
      setNodes((prev) => [...prev, newNode]);
    },
    [pushGraph, getGraphSnapshot, setNodes, setEdges, spawnNode, navigateScope, flashToast]
  );

  // Read the upstream node's primary IMAGE output as a PNG blob.
  // Used by the Image Generate panel to package its connected
  // ref_a/b/c sockets and ship the bytes to OpenAI as input_image
  // content parts on each turn.
  //
  // Reads the most-recent eval result rather than re-running the
  // upstream node — the source's bitmap is whatever the pipeline
  // produced on the last frame, which is what the user sees on the
  // canvas (and what they intend to feed to the model). The eval cache
  // covers stable nodes; uncacheable sources (Video, Webcam) are read
  // from the last pass's outputs map instead.
  const getRefImageBlob = useCallback(
    async (sourceNodeId: string): Promise<Blob | null> => {
      const entry = evalCacheRef.current.get(sourceNodeId);
      const primary =
        entry?.output.primary ??
        lastEvalOutputsRef.current?.get(sourceNodeId)?.primary;
      if (!primary || primary.kind !== "image") return null;
      const backend = backendRef.current;
      if (!backend) return null;
      const ctx = backend.makeContext(0, 0);
      const tmp = document.createElement("canvas");
      tmp.width = primary.width;
      tmp.height = primary.height;
      ctx.blitToCanvas(primary, tmp);
      return await new Promise<Blob | null>((resolve) => {
        tmp.toBlob((b) => resolve(b), "image/png");
      });
    },
    []
  );

  // Drop an Image-Generate thumbnail onto the node editor → spawn
  // an Image Source node owning its own copy of the bitmap. The new
  // node is decoupled from the originating Image Generate node;
  // re-running prompts there or deleting it doesn't affect this
  // node's image.
  const onAddImageNodeFromImageGen = useCallback(
    async (
      payload: { privatePath: string; format: string },
      flowPos: { x: number; y: number }
    ) => {
      try {
        const { downloadPrivate } = await import(
          "@/lib/supabase/image-gen"
        );
        const blob = await downloadPrivate(payload.privatePath);
        if (!blob) {
          console.warn(
            "image-gen drop: failed to download",
            payload.privatePath
          );
          return;
        }
        const bitmap = await createImageBitmap(blob);
        pushGraph(getGraphSnapshot());
        const newNode = spawnNode("image-source", flowPos);
        newNode.data.params = { ...newNode.data.params, file: bitmap };
        setNodes((prev) => [...prev, newNode]);
      } catch (err) {
        console.warn("image-gen drop failed:", err);
      }
    },
    [pushGraph, getGraphSnapshot, setNodes, spawnNode]
  );

  const onAddNode = useCallback(
    (
      type: string,
      pendingWire?: {
        sourceNodeId: string;
        sourceHandle: string;
        sourceType: string;
      }
    ) => {
      pushGraph(getGraphSnapshot());
      const base = lastPanePointerRef.current ?? { x: 200, y: 200 };
      // A tiny jitter keeps repeated adds from overlapping pixel-for-pixel.
      const jitter = { x: (Math.random() - 0.5) * 24, y: (Math.random() - 0.5) * 24 };
      const pos = { x: base.x + jitter.x, y: base.y + jitter.y };

      // Compound: "layer" creates a new layer (node + fixed boundary
      // nodes) and splices it into the top of the root chain. Offered
      // only by the root add menus.
      if (type === "layer") {
        const res = createLayer(nodesRef.current, edgesRef.current);
        setNodes(res.nodes);
        setEdges(res.edges);
        setSelectedId(res.layerId);
        setParamView("node");
        return;
      }

      // Compound: "simulation-zone" creates a Start + End pair with a
      // shared zone_id. Start lands at `pos`; End is offset to the right
      // so the pair is pre-arranged. They're NOT pre-wired to each other
      // — the user wires the compute between them. Auto-wire from a
      // dropped source wire doesn't apply to compound nodes — skip.
      if (type === "simulation-zone") {
        const zoneId = `zone-${Math.random().toString(36).slice(2, 10)}`;
        const start = spawnNode("simulation-start", pos);
        const end = spawnNode("simulation-end", {
          x: pos.x + 380,
          y: pos.y,
        });
        start.data.params = { ...start.data.params, zone_id: zoneId };
        end.data.params = { ...end.data.params, zone_id: zoneId };
        setNodes((prev) => [...prev, start, end]);
        return;
      }

      // Compound: "preset:<id>" inserts a canned subgraph (a node-group)
      // from the Presets menu. Same insertion path as paste —
      // cloneSubgraph mints fresh ids and retargets the group shell into
      // the current scope; at root (a strict layer chain) it auto-wraps
      // into a new layer just like handlePasteNodes.
      if (type.startsWith("preset:")) {
        const preset = getPreset(type.slice("preset:".length));
        if (!preset) return;
        const frag = preset.build();
        let targetScope = currentGroupIdRef.current;
        let baseNodes = nodesRef.current;
        let baseEdges = edgesRef.current;
        let wrapped: string | null = null;
        if (!targetScope) {
          const res = createLayer(baseNodes, baseEdges);
          baseNodes = res.nodes;
          baseEdges = res.edges;
          targetScope = res.layerId;
          wrapped = res.layerId;
        }
        const minX = Math.min(...frag.nodes.map((n) => n.position.x));
        const minY = Math.min(...frag.nodes.map((n) => n.position.y));
        const offset = { x: pos.x - minX, y: pos.y - minY };
        const { nodes: newNodes, edges: newEdges } = cloneSubgraph(
          frag.nodes,
          frag.edges,
          offset,
          { parentId: targetScope }
        );
        setNodes([
          ...baseNodes.map((n) => (n.selected ? { ...n, selected: false } : n)),
          ...newNodes,
        ]);
        setEdges([...baseEdges, ...newEdges]);
        const groupClone = newNodes.find(
          (n) => n.data.defType === GROUP_TYPE
        );
        if (wrapped) {
          flashToast("preset added to a new layer");
          navigateScope(wrapped);
          // navigateScope clears selection — keep the dropped group selected.
          setNodes((prev) =>
            prev.map((n) =>
              newNodes.some((c) => c.id === n.id) ? { ...n, selected: true } : n
            )
          );
        }
        if (groupClone) setSelectedId(groupClone.id);
        setParamView("node");
        return;
      }

      const newNode = spawnNode(type, pos);

      // Auto-wire: the user dropped a live wire on empty pane and
      // then picked this node from the search popup. Try to connect
      // from their source handle to a compatible input on the new
      // node. Mirrors `isValidConnection` + the onConnect promotion
      // rules for math (uv) and copy-to-points (instance).
      let autoEdge: Edge | null = null;
      if (pendingWire) {
        const def = getNodeDef(type);
        if (def) {
          const srcType = pendingWire.sourceType;
          // Apply mode promotions BEFORE picking an input, because
          // these changes alter which sockets are present. Same logic
          // the onConnect handler runs when an edge lands on an
          // already-existing node.
          if (
            def.type === "math" &&
            srcType === "uv" &&
            newNode.data.params.mode === "scalar"
          ) {
            newNode.data.params = { ...newNode.data.params, mode: "uv" };
          }
          if (def.type === "copy-to-points") {
            const nextMode =
              srcType === "image" || srcType === "image_group"
                ? "image"
                : srcType === "spline"
                  ? "spline"
                  : srcType === "points"
                    ? "point"
                    : null;
            if (nextMode && newNode.data.params.mode !== nextMode) {
              newNode.data.params = {
                ...newNode.data.params,
                mode: nextMode,
              };
            }
          }
          // Refresh the resolved input/output socket lists after any
          // param mutation so the edge target matches what the evaluator
          // will see.
          const resolvedInputs = withMaskInput(
            def.resolveInputs?.(newNode.data.params) ?? def.inputs,
            def
          );
          newNode.data.inputs = resolvedInputs.map((i) => ({
            name: i.name,
            label: i.label,
            type: i.type,
            hidden: i.hidden,
          }));
          newNode.data.primaryOutput =
            def.resolvePrimaryOutput?.(newNode.data.params) ??
            def.primaryOutput;
          const resolvedAux =
            def.resolveAuxOutputs?.(newNode.data.params) ?? def.auxOutputs;
          newNode.data.auxOutputs = resolvedAux.map((a) => ({
            name: a.name,
            type: a.type,
            disabled: a.disabled,
          }));

          // Pick a target input. Prefer an exact type match; fall
          // back to a coercion-compatible one. Copy-to-points'
          // polymorphic `instance` socket accepts image/spline/points.
          let targetInput: string | null = null;
          for (const i of resolvedInputs) {
            if (i.type === srcType) {
              targetInput = i.name;
              break;
            }
          }
          if (!targetInput) {
            const canCoerce = (s: string, t: string): boolean => {
              if (s === t) return true;
              if (s === "mask" && t === "image") return true;
              if (s === "image" && t === "mask") return true;
              if (
                s === "scalar" &&
                (t === "vec2" || t === "vec3" || t === "vec4" || t === "uv")
              )
                return true;
              if (s === "uv" && t === "scalar" && def.type === "math")
                return true;
              if ((s === "image" || s === "mask") && t === "scalar")
                return true;
              if (s === "audio" && t === "scalar") return true;
              if (s === "image" && t === "element") return true;
              if (s === "element" && t === "image") return true;
              return false;
            };
            for (const i of resolvedInputs) {
              if (canCoerce(srcType, i.type)) {
                targetInput = i.name;
                break;
              }
            }
            // Copy-to-Points instance socket is permissive by design.
            if (
              !targetInput &&
              def.type === "copy-to-points" &&
              (srcType === "image" ||
                srcType === "image_group" ||
                srcType === "spline" ||
                srcType === "points")
            ) {
              targetInput = "instance";
            }
          }

          if (targetInput) {
            // Dragging a primary IMAGE wire into a fresh Auto Layout slot:
            // prefer the source's `element` aux (raw, intrinsically sized,
            // no baked-in canvas fit) over the image→element coercion —
            // mirrors the redirect in onConnect.
            let autoSourceHandle = pendingWire.sourceHandle;
            if (
              def.type === "autolayout" &&
              targetInput.startsWith("item:") &&
              pendingWire.sourceHandle === "out:primary" &&
              pendingWire.sourceType === "image"
            ) {
              const src = nodesRef.current.find(
                (n) => n.id === pendingWire.sourceNodeId
              );
              if (
                src?.data.auxOutputs?.some(
                  (a) => a.name === "element" && a.type === "element"
                )
              ) {
                autoSourceHandle = "out:aux:element";
              }
            }
            autoEdge = {
              id: `e-auto-${pendingWire.sourceNodeId}-${newNode.id}-${targetInput}`,
              source: pendingWire.sourceNodeId,
              sourceHandle: autoSourceHandle,
              target: newNode.id,
              targetHandle: `in:${targetInput}`,
            };
          }
        }
      }

      // Select the new node (deselecting others) so it previews on the
      // canvas immediately and its params open — "add and see it" with no
      // extra click. setSelectedId mirrors the flag for the param panel /
      // canvas preview without waiting on React Flow's selection echo.
      setNodes((prev) => [
        ...prev.map((n) => (n.selected ? { ...n, selected: false } : n)),
        { ...newNode, selected: true },
      ]);
      if (autoEdge) {
        setEdges((prev) => [...prev, autoEdge as Edge]);
      }
      setSelectedId(newNode.id);
      setParamView("node");
    },
    [setNodes, setEdges, setSelectedId, setParamView, pushGraph, getGraphSnapshot, spawnNode, navigateScope, flashToast]
  );

  // "Convert Editable" (SVG Source param panel): spawn a Spline Draw node
  // holding the SVG's paths as editable beziers. The SVG's current transform
  // is baked into the geometry so the editable spline lands where the SVG
  // renders, and its stroke/fill style is copied so it looks identical. The
  // SVG node is left intact (non-destructive).
  const convertSvgToEditable = useCallback(
    (svgNodeId: string) => {
      const svgNode = nodesRef.current.find((n) => n.id === svgNodeId);
      if (!svgNode || svgNode.data.defType !== "svg-source") return;
      const p = svgNode.data.params;
      const file = p.file as SvgFileParamValue | null | undefined;
      const rawSubs = file?.subpaths ?? [];
      if (rawSubs.length === 0) {
        flashToast("No SVG paths to convert");
        return;
      }
      const baked = transformSpline(
        { kind: "spline", subpaths: rawSubs },
        {
          translateX: (p.translateX as number) ?? 0,
          translateY: (p.translateY as number) ?? 0,
          scaleX: (p.scaleX as number) ?? 1,
          scaleY: (p.scaleY as number) ?? 1,
          rotateDeg: (p.rotate as number) ?? 0,
          pivotX: (p.pivotX as number) ?? 0.5,
          pivotY: (p.pivotY as number) ?? 0.5,
        }
      );

      pushGraph(getGraphSnapshot());
      const node = spawnNode("spline-draw", {
        x: svgNode.position.x + 320,
        y: svgNode.position.y,
      });
      // Land it in the SVG node's scope, not just the viewed scope.
      node.data.parentId = svgNode.data.parentId;
      node.data.params = {
        ...node.data.params,
        spline: { subpaths: baked.subpaths },
        // Mirror the SVG node's stroke/fill so the editable copy looks the same.
        stroke_enabled: !!p.stroke_enabled,
        stroke_thickness:
          p.stroke_thickness ?? node.data.params.stroke_thickness,
        stroke_color: p.stroke_color ?? node.data.params.stroke_color,
        fill_enabled: !!p.fill_enabled,
        fill_color: p.fill_color ?? node.data.params.fill_color,
        fill_fit: p.fill_fit ?? node.data.params.fill_fit,
      };
      setNodes((prev) => [
        ...prev.map((n) => (n.selected ? { ...n, selected: false } : n)),
        { ...node, selected: true },
      ]);
      setSelectedId(node.id);
      setParamView("node");
      flashToast("Converted to editable spline");
    },
    [
      spawnNode,
      setNodes,
      setSelectedId,
      setParamView,
      pushGraph,
      getGraphSnapshot,
      flashToast,
    ]
  );

  const handleCopyNodes = useCallback(() => {
    const selected = nodesRef.current.filter((n) => n.selected);
    if (selected.length === 0) return;
    // Selected groups travel with their interiors — copying just the
    // shell would paste a group with no contents.
    const ids = expandWithDescendants(
      nodesRef.current,
      selected.map((n) => n.id)
    );
    const internalEdges = edgesRef.current.filter(
      (e) => ids.has(e.source) && ids.has(e.target)
    );
    clipboardRef.current = {
      nodes: nodesRef.current
        .filter((n) => ids.has(n.id))
        .map((n) => ({ ...n, selected: false })),
      edges: internalEdges,
    };
  }, []);

  const handlePasteNodes = useCallback(() => {
    const clip = clipboardRef.current;
    if (!clip || clip.nodes.length === 0) return;
    pushGraph(getGraphSnapshot());
    // Offset the paste. Prefer anchoring to the last pane-pointer position
    // (so it lands where attention is); fall back to a small fixed offset.
    const pointer = lastPanePointerRef.current;
    let offset: { x: number; y: number };
    if (pointer) {
      // Shift the whole subgraph so its top-left corner sits at the pointer.
      const minX = Math.min(...clip.nodes.map((n) => n.position.x));
      const minY = Math.min(...clip.nodes.map((n) => n.position.y));
      offset = { x: pointer.x - minX, y: pointer.y - minY };
    } else {
      offset = { x: 24, y: 24 };
    }
    // Paste lands in the scope the user is looking at, which may differ
    // from where the copy happened (retarget applies to top-level
    // clones only; group interiors keep pointing at their cloned
    // shells). At root — where only layers live — the pasted nodes
    // auto-wrap into a fresh layer instead.
    let targetScope = currentGroupIdRef.current;
    let baseNodes = nodesRef.current;
    let baseEdges = edgesRef.current;
    let wrapped: string | null = null;
    if (
      !targetScope &&
      !clip.nodes.every((n) => n.data.defType === LAYER_TYPE)
    ) {
      const res = createLayer(baseNodes, baseEdges);
      baseNodes = res.nodes;
      baseEdges = res.edges;
      targetScope = res.layerId;
      wrapped = res.layerId;
    }
    const { nodes: newNodes, edges: newEdges } = cloneSubgraph(
      clip.nodes,
      clip.edges,
      offset,
      { parentId: targetScope }
    );
    setNodes([
      ...baseNodes.map((n) => (n.selected ? { ...n, selected: false } : n)),
      ...newNodes,
    ]);
    setEdges([...baseEdges, ...newEdges]);
    if (wrapped) {
      flashToast("pasted into a new layer");
      navigateScope(wrapped);
      // navigateScope clears selection; keep the pasted clones selected
      // so the user can immediately move them.
      setNodes((prev) =>
        prev.map((n) =>
          newNodes.some((c) => c.id === n.id) ? { ...n, selected: true } : n
        )
      );
    }
  }, [
    pushGraph,
    getGraphSnapshot,
    setNodes,
    setEdges,
    flashToast,
    navigateScope,
  ]);

  // Shift+D duplicate: clone every selected node, preserving any edges
  // whose endpoints are both inside the selection. Mirrors copy+paste
  // semantics (offset, selection swap) but skips the clipboard so the
  // user's actual paste buffer isn't disturbed.
  const handleDuplicateSelection = useCallback(() => {
    const selected = nodesRef.current.filter((n) => n.selected);
    if (selected.length === 0) return;
    pushGraph(getGraphSnapshot());
    // Selected groups duplicate with their interiors (fresh ids + zone
    // remap — see cloneSubgraph).
    const ids = expandWithDescendants(
      nodesRef.current,
      selected.map((n) => n.id)
    );
    const { nodes: newNodes, edges: newEdges } = cloneSubgraph(
      nodesRef.current.filter((n) => ids.has(n.id)),
      edgesRef.current,
      { x: 32, y: 32 }
    );
    setNodes((prev) => [
      ...prev.map((n) => ({ ...n, selected: false })),
      ...newNodes,
    ]);
    setEdges((prev) => [...prev, ...newEdges]);
  }, [pushGraph, getGraphSnapshot, setNodes, setEdges]);

  // Shift+M: wrap the selected nodes' image/mask outputs in a new Merge
  // node. Every image/mask output counts — a node's primary output and
  // any of its (enabled) aux outputs each become their own layer. The
  // leftmost selected node's first output (ties broken by vertical
  // position; primary before aux within a node) becomes the `base`
  // layer; the rest stack on top in that same order. Selected nodes with
  // no image/mask output are ignored, and the shortcut no-ops if none
  // qualify.
  const handleMergeSelection = useCallback(() => {
    // The output handles a node exposes that the merge can consume,
    // primary first so it lands lower in the layer stack than its auxes.
    const imageOutputsOf = (n: Node<NodeDataPayload>): string[] => {
      const handles: string[] = [];
      if (n.data.primaryOutput === "image" || n.data.primaryOutput === "mask") {
        handles.push("out:primary");
      }
      for (const a of n.data.auxOutputs ?? []) {
        if (a.disabled) continue;
        if (a.type === "image" || a.type === "mask") {
          handles.push(`out:aux:${a.name}`);
        }
      }
      return handles;
    };

    const eligible = nodesRef.current
      .filter((n) => n.selected)
      .map((n) => ({ node: n, handles: imageOutputsOf(n) }))
      .filter((e) => e.handles.length > 0)
      .sort(
        (a, b) =>
          a.node.position.x - b.node.position.x ||
          a.node.position.y - b.node.position.y
      );
    if (eligible.length === 0) return;

    // Flatten to one wire-source per image/mask output, preserving node
    // order and primary-before-aux order within each node.
    const sources = eligible.flatMap((e) =>
      e.handles.map((handle) => ({ nodeId: e.node.id, handle }))
    );

    pushGraph(getGraphSnapshot());

    const [base, ...layerSources] = sources;
    // One fresh layer slot per non-base source so the merge's resolved
    // input sockets line up exactly with the wires added below.
    const layers: MergeLayer[] = layerSources.map(() => ({
      id: newLayerId(),
      mode: "normal",
      opacity: 1,
    }));

    // Drop the merge to the right of the selection, vertically centered
    // on the nodes it consumes.
    const rightEdge = Math.max(...eligible.map((e) => e.node.position.x));
    const avgY =
      eligible.reduce((s, e) => s + e.node.position.y, 0) / eligible.length;
    const merge = spawnNode("merge", { x: rightEdge + 360, y: avgY });
    merge.data.params = { ...merge.data.params, layers };
    // Recompute the resolved input sockets so the dynamic `layer:*`
    // handles exist for the edges below (and for the node renderer).
    const def = getNodeDef("merge");
    if (def) {
      const resolved = withMaskInput(
        def.resolveInputs?.(merge.data.params) ?? def.inputs,
        def
      );
      merge.data.inputs = resolved.map((i) => ({
        name: i.name,
        label: i.label,
        type: i.type,
        hidden: i.hidden,
      }));
    }
    merge.selected = true;

    const newEdges: Edge[] = [
      {
        id: newEdgeId(),
        source: base.nodeId,
        sourceHandle: base.handle,
        target: merge.id,
        targetHandle: "in:base",
      },
      ...layerSources.map((src, i) => ({
        id: newEdgeId(),
        source: src.nodeId,
        sourceHandle: src.handle,
        target: merge.id,
        targetHandle: `in:layer:${layers[i].id}`,
      })),
    ];

    setNodes((prev) => [
      ...prev.map((n) => (n.selected ? { ...n, selected: false } : n)),
      merge,
    ]);
    setEdges((prev) => [...prev, ...newEdges]);
    setSelectedId(merge.id);
    setParamView("node");
  }, [
    pushGraph,
    getGraphSnapshot,
    setNodes,
    setEdges,
    setSelectedId,
    setParamView,
    spawnNode,
  ]);

  // Viewport shelf-tool spawner (the spline-primitive buttons that live
  // in the viewport menubar). Drops a new source node into the network;
  // when a Merge node is the current target — selected, or active in the
  // viewport — the new node's image output is wired straight in as a
  // fresh layer, so stacking up a composite is one click per primitive.
  const handleAddShelfNode = useCallback(
    (type: string) => {
      pushGraph(getGraphSnapshot());

      // Best image/mask output handle on a node, or null if it has none.
      const imageOutputHandle = (n: Node<NodeDataPayload>): string | null => {
        if (
          n.data.primaryOutput === "image" ||
          n.data.primaryOutput === "mask"
        ) {
          return "out:primary";
        }
        const aux = (n.data.auxOutputs ?? []).find(
          (a) => !a.disabled && (a.type === "image" || a.type === "mask")
        );
        return aux ? `out:aux:${aux.name}` : null;
      };

      // Strict root: shelf tools redirect into a fresh layer, wired to
      // its Group Output when the primitive has an image output.
      if (!currentGroupIdRef.current) {
        const res = createLayer(nodesRef.current, edgesRef.current);
        const go = res.nodes.find(
          (n) =>
            n.data.parentId === res.layerId &&
            n.data.defType === GROUP_OUTPUT_TYPE
        );
        const base = lastPanePointerRef.current ?? { x: 200, y: 200 };
        const node = spawnNode(type, base);
        node.data.parentId = res.layerId;
        node.selected = true;
        const handle = imageOutputHandle(node);
        // Navigate first — navigateScope clears selection flags, and the
        // fresh node should come out selected.
        navigateScope(res.layerId);
        setNodes([...res.nodes, node]);
        setEdges(
          go && handle
            ? [
                ...res.edges,
                {
                  id: newEdgeId(),
                  source: node.id,
                  sourceHandle: handle,
                  target: go.id,
                  targetHandle: "in:image",
                },
              ]
            : res.edges
        );
        setSelectedId(node.id);
        setParamView("node");
        return;
      }

      // Target Merge: one that's selected (explicit pick wins) or, failing
      // that, the one parked as the active viewport output.
      const selId = selectedIdRef.current;
      const target =
        nodesRef.current.find(
          (n) =>
            n.data.defType === "merge" && (n.id === selId || n.selected)
        ) ??
        nodesRef.current.find(
          (n) => n.data.defType === "merge" && n.data.active
        ) ??
        null;

      // Position: stack to the left of the merge (nudged down per existing
      // layer) when wiring; otherwise drop at the last pane cursor.
      let pos: { x: number; y: number };
      if (target) {
        const layerCount = (
          (target.data.params.layers as MergeLayer[]) ?? []
        ).length;
        pos = {
          x: target.position.x - 360,
          y: target.position.y + layerCount * 96,
        };
      } else {
        const base = lastPanePointerRef.current ?? { x: 200, y: 200 };
        pos = { x: base.x, y: base.y };
      }

      const newNode = spawnNode(type, pos);
      const handle = target ? imageOutputHandle(newNode) : null;

      if (!target || !handle) {
        // No merge to wire into (or the new node has no image output) —
        // just add it, selected, so its gizmo / pen overlay opens.
        setNodes((prev) => [
          ...prev.map((n) => (n.selected ? { ...n, selected: false } : n)),
          { ...newNode, selected: true },
        ]);
        setSelectedId(newNode.id);
        setParamView("node");
        return;
      }

      // Wire the new node in as a fresh layer on the target merge.
      const layer: MergeLayer = { id: newLayerId(), mode: "normal", opacity: 1 };
      const nextParams = {
        ...target.data.params,
        layers: [
          ...((target.data.params.layers as MergeLayer[]) ?? []),
          layer,
        ],
      };
      let nextInputs = target.data.inputs;
      const def = getNodeDef("merge");
      if (def) {
        const resolved = withMaskInput(
          def.resolveInputs?.(nextParams) ?? def.inputs,
          def
        );
        nextInputs = resolved.map((i) => ({
          name: i.name,
          label: i.label,
          type: i.type,
          hidden: i.hidden,
        }));
      }

      const edge: Edge = {
        id: newEdgeId(),
        source: newNode.id,
        sourceHandle: handle,
        target: target.id,
        targetHandle: `in:layer:${layer.id}`,
      };

      setNodes((prev) => [
        ...prev.map((n) => {
          if (n.id === target.id) {
            return {
              ...n,
              data: { ...n.data, params: nextParams, inputs: nextInputs },
            };
          }
          return n.selected ? { ...n, selected: false } : n;
        }),
        { ...newNode, selected: true },
      ]);
      setEdges((prev) => [...prev, edge]);
      setSelectedId(newNode.id);
      setParamView("node");
    },
    [
      pushGraph,
      getGraphSnapshot,
      navigateScope,
      setNodes,
      setEdges,
      setSelectedId,
      setParamView,
      spawnNode,
    ]
  );

  // Context-menu / standalone Duplicate: clone the source node at a small
  // offset so it's visibly distinct. No exterior edge surgery — the clone
  // starts disconnected and the user wires it up themselves. Groups
  // deep-copy their interior (nodes + interior edges) so the duplicate
  // is self-contained.
  const handleDuplicateNode = useCallback(
    (nodeId: string) => {
      const src = nodesRef.current.find((n) => n.id === nodeId);
      if (!src) return;
      pushGraph(getGraphSnapshot());
      const ids = expandWithDescendants(nodesRef.current, [nodeId]);
      const { nodes: newNodes, edges: newEdges } = cloneSubgraph(
        nodesRef.current.filter((n) => ids.has(n.id)),
        edgesRef.current,
        { x: 32, y: 32 }
      );
      setNodes((prev) => [
        ...prev.map((n) => ({ ...n, selected: false })),
        ...newNodes,
      ]);
      if (newEdges.length > 0) setEdges((prev) => [...prev, ...newEdges]);
    },
    [pushGraph, getGraphSnapshot, setNodes, setEdges]
  );

  // Alt-drag duplicate: Figma-style. A clone takes the node's original
  // position AND all of its connections, while the node the user is
  // dragging (the original) becomes a freshly-disconnected copy that
  // follows the cursor. Implemented via edge-redirect so we don't have to
  // intervene in React Flow's active drag.
  const handleDuplicateOnDrag = useCallback(
    (nodeId: string) => {
      const src = nodesRef.current.find((n) => n.id === nodeId);
      if (!src) return;
      pushGraph(getGraphSnapshot());
      // Groups deep-copy their interior; the redirect below only ever
      // touches exterior edges since nothing wires directly into a
      // group shell from inside it.
      const ids = expandWithDescendants(nodesRef.current, [nodeId]);
      const { nodes: newNodes, edges: newEdges, idMap } = cloneSubgraph(
        nodesRef.current.filter((n) => ids.has(n.id)),
        edgesRef.current,
        { x: 0, y: 0 }
      );
      const cloneId = idMap.get(nodeId)!;
      // The user keeps dragging the original — the clone must not steal
      // selection.
      for (const n of newNodes) n.selected = false;
      setNodes((prev) => [...prev, ...newNodes]);
      setEdges((prev) => [
        ...prev.map((e) => ({
          ...e,
          source: e.source === nodeId ? cloneId : e.source,
          target: e.target === nodeId ? cloneId : e.target,
        })),
        ...newEdges,
      ]);
    },
    [pushGraph, getGraphSnapshot, setNodes, setEdges]
  );

  // Wire-gesture actions from NodeEditor. `combine` stamps a junction
  // waypoint on each listed edge (data.waypoint in flow coords — renders
  // as a shared trunk + dot). `cut` removes the listed edges outright.
  const handleCombineWires = useCallback(
    (edgeIds: string[], midpointFlow: [number, number]) => {
      if (edgeIds.length === 0) return;
      pushGraph(getGraphSnapshot());
      const idSet = new Set(edgeIds);
      setEdges((prev) =>
        prev.map((e) =>
          idSet.has(e.id)
            ? {
                ...e,
                data: {
                  ...(e.data ?? {}),
                  waypoint: midpointFlow,
                },
              }
            : e
        )
      );
    },
    [pushGraph, getGraphSnapshot, setEdges]
  );
  const handleCutWires = useCallback(
    (edgeIds: string[]) => {
      if (edgeIds.length === 0) return;
      pushGraph(getGraphSnapshot());
      const idSet = new Set(edgeIds);
      setEdges((prev) => prev.filter((e) => !idSet.has(e.id)));
    },
    [pushGraph, getGraphSnapshot, setEdges]
  );

  // Splice an existing edge around a just-dropped node. NodeEditor has
  // already confirmed socket compatibility (via the same canCoerce
  // logic isValidConnection uses) and picked the input/output handles,
  // so here we only remove the old edge and add two new ones. Also
  // apply the same mode-promotion the onConnect path runs — if the
  // node is math in scalar mode receiving uv, flip; if copy-to-points
  // with a fresh instance type, flip.
  const handleSpliceNode = useCallback(
    (args: {
      nodeId: string;
      edgeId: string;
      inputName: string;
      outputHandle: string;
    }) => {
      const oldEdge = edgesRef.current.find((e) => e.id === args.edgeId);
      if (!oldEdge) return;
      const nodeList = nodesRef.current;
      const splicedNode = nodeList.find((n) => n.id === args.nodeId);
      if (!splicedNode) return;
      // Strict root: root edges are the layer chain (+ Output wiring) —
      // only layer nodes may splice into them.
      if (
        !splicedNode.data.parentId &&
        splicedNode.data.defType !== LAYER_TYPE
      ) {
        return;
      }
      const sourceNode = nodeList.find((n) => n.id === oldEdge.source);
      if (!sourceNode) return;
      // Resolve the source-side socket type of the old edge — same as
      // NodeEditor's probe, but we need it here for mode promotion.
      let srcType: string | null = null;
      if (oldEdge.sourceHandle === "out:primary") {
        srcType = sourceNode.data.primaryOutput ?? null;
      } else if (oldEdge.sourceHandle?.startsWith("out:aux:")) {
        const auxName = oldEdge.sourceHandle.slice("out:aux:".length);
        srcType =
          sourceNode.data.auxOutputs.find((a) => a.name === auxName)?.type ??
          null;
      }

      pushGraph(getGraphSnapshot());

      // Apply promotion to the spliced node (mode + dependent socket
      // lists). Mirror the logic in onConnect / onAddNode(pendingWire).
      const def = getNodeDef(splicedNode.data.defType);
      let promoted = splicedNode;
      if (def && srcType) {
        let nextParams = promoted.data.params;
        if (
          def.type === "math" &&
          srcType === "uv" &&
          nextParams.mode === "scalar"
        ) {
          nextParams = { ...nextParams, mode: "uv" };
        } else if (
          def.type === "copy-to-points" &&
          args.inputName === "instance"
        ) {
          const nextMode =
            srcType === "image"
              ? "image"
              : srcType === "spline"
                ? "spline"
                : srcType === "points"
                  ? "point"
                  : null;
          if (nextMode && nextParams.mode !== nextMode) {
            nextParams = { ...nextParams, mode: nextMode };
          }
        }
        if (nextParams !== promoted.data.params) {
          const resolvedInputs = withMaskInput(
            def.resolveInputs?.(nextParams) ?? def.inputs,
            def
          );
          const nextAux =
            def.resolveAuxOutputs?.(nextParams) ?? def.auxOutputs;
          promoted = {
            ...promoted,
            data: {
              ...promoted.data,
              params: nextParams,
              inputs: resolvedInputs.map((i) => ({
                name: i.name,
                label: i.label,
                type: i.type,
                hidden: i.hidden,
              })),
              primaryOutput:
                def.resolvePrimaryOutput?.(nextParams) ??
                def.primaryOutput,
              auxOutputs: nextAux.map((a) => ({
                name: a.name,
                type: a.type,
                disabled: a.disabled,
              })),
            },
          };
        }
      }

      const newIncoming: Edge = {
        id: `e-splice-${args.edgeId}-in-${Math.random()
          .toString(36)
          .slice(2, 8)}`,
        source: oldEdge.source,
        sourceHandle: oldEdge.sourceHandle,
        target: args.nodeId,
        targetHandle: `in:${args.inputName}`,
      };
      const newOutgoing: Edge = {
        id: `e-splice-${args.edgeId}-out-${Math.random()
          .toString(36)
          .slice(2, 8)}`,
        source: args.nodeId,
        sourceHandle: args.outputHandle,
        target: oldEdge.target,
        targetHandle: oldEdge.targetHandle,
      };

      if (promoted !== splicedNode) {
        setNodes((prev) =>
          prev.map((n) => (n.id === args.nodeId ? promoted : n))
        );
      }
      setEdges((prev) => [
        ...prev.filter((e) => e.id !== args.edgeId),
        newIncoming,
        newOutgoing,
      ]);
    },
    [pushGraph, getGraphSnapshot, setEdges, setNodes]
  );

  // Waypoint drag: start pushes a single undo snapshot for the whole
  // gesture; each `onDrag` call moves every edge whose waypoint clusters
  // near the dragged edge's waypoint, so junctions stay intact under
  // drag. The cluster is resolved once per drag from the snapshot that
  // existed at drag-start (captured in a ref) — recomputing the cluster
  // on every move would let edges "leak" out as waypoints diverge
  // mid-drag.
  const waypointDragClusterRef = useRef<Set<string> | null>(null);
  const handleWaypointDragStart = useCallback(
    (edgeId: string) => {
      const edge = edgesRef.current.find((e) => e.id === edgeId);
      const wp = edge?.data?.waypoint as [number, number] | undefined;
      if (!wp) {
        waypointDragClusterRef.current = new Set();
        return;
      }
      // Cluster tolerance is generous — any edges within 2 flow units
      // (< 1 pixel at most zoom levels) of each other count as "the same
      // junction." After a combine gesture the waypoints are pixel-
      // identical, so this is effectively a set-equality check.
      const cluster = new Set<string>();
      for (const e of edgesRef.current) {
        const ewp = e.data?.waypoint as [number, number] | undefined;
        if (!ewp) continue;
        if (Math.hypot(ewp[0] - wp[0], ewp[1] - wp[1]) < 2) {
          cluster.add(e.id);
        }
      }
      waypointDragClusterRef.current = cluster;
      pushGraph(getGraphSnapshot());
    },
    [pushGraph, getGraphSnapshot]
  );
  const handleWaypointDrag = useCallback(
    (_edgeId: string, newFlowPos: [number, number]) => {
      const cluster = waypointDragClusterRef.current;
      if (!cluster || cluster.size === 0) return;
      setEdges((prev) =>
        prev.map((e) =>
          cluster.has(e.id)
            ? {
                ...e,
                data: {
                  ...(e.data ?? {}),
                  waypoint: newFlowPos,
                },
              }
            : e
        )
      );
    },
    [setEdges]
  );

  // Strip every edge that touches this node. Used by cmd-drag to "float" a
  // node out of its connections in one gesture.
  const handleDetachNode = useCallback(
    (nodeId: string) => {
      const hasEdges = edgesRef.current.some(
        (e) => e.source === nodeId || e.target === nodeId
      );
      if (!hasEdges) return;
      pushGraph(getGraphSnapshot());
      setEdges((prev) =>
        prev.filter((e) => e.source !== nodeId && e.target !== nodeId)
      );
    },
    [pushGraph, getGraphSnapshot, setEdges]
  );

  const onParamChange = useCallback(
    (
      nodeId: string,
      paramName: string,
      value: unknown,
      // Optional override for the undo-coalescing key. Multi-param
      // drags (the on-canvas Transform gizmo writes scaleX + scaleY +
      // translateX + translateY in a single move) need every patched
      // param to share one key — otherwise each param mints its own
      // history entry and a single drag turns into hundreds of tiny
      // undos. Default is per-param so single-slider drags coalesce
      // the same way they used to.
      coalesceKey?: string
    ) => {
      // Coalesce rapid same-param changes (slider drags, color-ramp moves,
      // curve point drags) into a single undo entry keyed by node+param.
      // Paint param updates are internal-only — pipeline snapshots and undo
      // restores trigger them — and are excluded to keep those flows linear.
      if (paramName !== "paint") {
        pushGraph(
          getGraphSnapshot(),
          coalesceKey ?? `param:${nodeId}:${paramName}`
        );
      }
      const tickAtEdit = currentTick;
      setNodes((prev) =>
        prev.map((n) => {
          if (n.id !== nodeId) return n;
          // Auto-keyframe: if this param is animated and not driven by a
          // wire, write a keyframe at the current tick instead of (or
          // in addition to, for round-trip) the constant. We always
          // write the constant too — if the user later disables
          // animation, the constant becomes the visible value.
          const animBlock = n.data.animation?.[paramName];
          const isAnimated =
            !!animBlock &&
            animBlock.animated &&
            isKeyframable(
              getNodeDef(n.data.defType)?.params.find(
                (p) => p.name === paramName
              )?.type ?? "string"
            );
          let nextAnimation = n.data.animation;
          if (isAnimated && animBlock) {
            const updated = upsertKeyframe(
              animBlock,
              tickAtEdit,
              value,
              "easeInOut"
            );
            nextAnimation = { ...n.data.animation, [paramName]: updated };
          }
          // Per-layer opacity auto-keyframe (Merge): an edit to the
          // merge_layers array that changes a layer's opacity mirrors
          // into that layer's virtual block (layer_opacity:<id>) when it
          // is animated — same contract as scalar params. The constant
          // is still written below for the animation-off round-trip.
          if (Array.isArray(value)) {
            const pdefType = getNodeDef(n.data.defType)?.params.find(
              (p) => p.name === paramName
            )?.type;
            if (pdefType === "merge_layers") {
              const before =
                (n.data.params[paramName] as MergeLayer[] | undefined) ?? [];
              for (const layer of value as MergeLayer[]) {
                const prev = before.find((b) => b.id === layer.id);
                if (!prev || prev.opacity === layer.opacity) continue;
                const key = layerOpacityKey(layer.id);
                const blk = nextAnimation?.[key];
                if (blk?.animated) {
                  nextAnimation = {
                    ...nextAnimation,
                    [key]: upsertKeyframe(
                      blk,
                      tickAtEdit,
                      layer.opacity,
                      "easeInOut"
                    ),
                  };
                }
              }
            }
            // Per-point x/y/color auto-keyframe (multipoint Gradient): an edit
            // to the gradient_points array mirrors each changed sub-value into
            // its virtual block when that block is animated. Color is stored
            // as an RGBA tuple to match the keyframe engine's color interp.
            if (pdefType === "gradient_points") {
              const before =
                (n.data.params[paramName] as GradientPoint[] | undefined) ?? [];
              for (const pt of value as GradientPoint[]) {
                const prev = before.find((b) => b.id === pt.id);
                if (!prev) continue;
                const tryKey = (
                  key: string,
                  changed: boolean,
                  kfValue: unknown
                ) => {
                  if (!changed) return;
                  const blk = nextAnimation?.[key];
                  if (blk?.animated) {
                    nextAnimation = {
                      ...nextAnimation,
                      [key]: upsertKeyframe(blk, tickAtEdit, kfValue, "easeInOut"),
                    };
                  }
                };
                tryKey(gpointXKey(pt.id), prev.x !== pt.x, pt.x);
                tryKey(gpointYKey(pt.id), prev.y !== pt.y, pt.y);
                tryKey(
                  gpointCKey(pt.id),
                  prev.color !== pt.color,
                  hexToRgba01Tuple(
                    typeof pt.color === "string" ? pt.color : "#ffffff"
                  )
                );
              }
            }
          }
          const nextParams = { ...n.data.params, [paramName]: value };
          const def = getNodeDef(n.data.defType);
          // If this param is half of an active chain-link, write the
          // partner's value too. Numeric guards skip the link if either
          // side isn't currently a finite number.
          const link = def?.linkedPairs?.find(
            (p) => p.a === paramName || p.b === paramName
          );
          if (link) {
            const key = `${link.a}:${link.b}`;
            const lock = n.data.linkedParams?.[key];
            if (lock && typeof value === "number" && isFinite(value)) {
              if (paramName === link.a) {
                nextParams[link.b] = value * lock.ratio;
              } else {
                // Partner edited — invert the ratio. Guard against zero
                // ratios that would otherwise divide-by-zero.
                if (lock.ratio !== 0) {
                  nextParams[link.a] = value / lock.ratio;
                } else {
                  nextParams[link.a] = 0;
                }
              }
              // Linked-keyframe mirror: when the edited param is being
              // auto-keyframed, force a keyframe on the partner too at
              // the same tick. Enable the partner's animation block if
              // it isn't already.
              if (isAnimated) {
                const partnerName =
                  paramName === link.a ? link.b : link.a;
                const partnerValue = nextParams[partnerName];
                if (
                  typeof partnerValue === "number" &&
                  isFinite(partnerValue)
                ) {
                  const partnerCur =
                    nextAnimation?.[partnerName] ?? emptyAnimationBlock();
                  const partnerEnabled = {
                    ...partnerCur,
                    animated: true,
                  };
                  const partnerNext = upsertKeyframe(
                    partnerEnabled,
                    tickAtEdit,
                    partnerValue,
                    "easeInOut"
                  );
                  nextAnimation = {
                    ...nextAnimation,
                    [partnerName]: partnerNext,
                  };
                }
              }
            }
          }
          const resolved = def?.resolveInputs?.(nextParams);
          const nextPrimary =
            def?.resolvePrimaryOutput?.(nextParams) ?? n.data.primaryOutput;
          const resolvedAux = def?.resolveAuxOutputs?.(nextParams);
          // Loading a clip renames the node to the file (extension dropped)
          // so the network reads as "sunset" / "clip-03" instead of a wall
          // of identical "Image Source" labels. Image bitmaps stash the
          // name as `fileName`; video values carry `filename`.
          let nextName = n.data.name;
          if (paramName === "file") {
            const raw =
              n.data.defType === "image-source"
                ? (value as { fileName?: string } | null | undefined)?.fileName
                : n.data.defType === "video-source"
                  ? (value as { filename?: string } | null | undefined)
                      ?.filename
                  : undefined;
            if (raw) nextName = fileLabel(raw);
          }
          return {
            ...n,
            data: {
              ...n.data,
              name: nextName,
              params: nextParams,
              animation: nextAnimation,
              primaryOutput: nextPrimary,
              inputs: resolved
                ? withMaskInput(resolved, def).map((i) => ({
                    name: i.name,
                    label: i.label,
                    type: i.type,
                    hidden: i.hidden,
                  }))
                : n.data.inputs,
              auxOutputs: resolvedAux
                ? resolvedAux.map((a) => ({
                    name: a.name,
                    type: a.type,
                    disabled: a.disabled,
                  }))
                : n.data.auxOutputs,
            },
          };
        })
      );
    },
    [setNodes, pushGraph, getGraphSnapshot, currentTick]
  );

  // Per-parameter animation block read/write. Used by ParamPanel and the
  // Track Editor; undo coalesces the same way as onParamChange.
  const getAnimation = useCallback(
    (nodeId: string, paramName: string): KeyframeAnimationBlock | undefined => {
      const n = nodesRef.current.find((x) => x.id === nodeId);
      return n?.data.animation?.[paramName];
    },
    []
  );
  const onAnimationChange = useCallback(
    (
      nodeId: string,
      paramName: string,
      next: KeyframeAnimationBlock | undefined,
      // Batch gestures (multi-track move / scale / stagger) pass a single
      // shared key so every param write in the gesture coalesces into one
      // undo step. Single edits default to a per-param key.
      coalesceKey?: string
    ) => {
      pushGraph(getGraphSnapshot(), coalesceKey ?? `anim:${nodeId}:${paramName}`);
      const tickAtEdit = currentTick;
      setNodes((prev) =>
        prev.map((n) => {
          if (n.id !== nodeId) return n;
          const cur = n.data.animation ?? {};
          let nextAnim: typeof cur;
          if (next === undefined) {
            const { [paramName]: _drop, ...rest } = cur;
            void _drop;
            nextAnim = rest;
          } else {
            nextAnim = { ...cur, [paramName]: next };
          }

          // Linked-keyframe mirror: when this op inserts a keyframe at
          // the playhead OR enables animation on a linked param, do
          // the same to the partner using the partner's current
          // effective value at the playhead.
          if (next) {
            const def = getNodeDef(n.data.defType);
            const link = def?.linkedPairs?.find(
              (p) => p.a === paramName || p.b === paramName
            );
            const lock = link
              ? n.data.linkedParams?.[`${link.a}:${link.b}`]
              : undefined;
            if (link && lock) {
              const partnerName =
                paramName === link.a ? link.b : link.a;
              const prevBlock = cur[paramName];
              const newKfAtTick = next.keyframes.some(
                (k) => k.tick === tickAtEdit
              );
              const prevKfAtTick =
                prevBlock?.keyframes.some((k) => k.tick === tickAtEdit) ??
                false;
              const didInsertHere = newKfAtTick && !prevKfAtTick;
              const didEnable =
                next.animated && !(prevBlock?.animated ?? false);
              if (didInsertHere || didEnable) {
                // Compute partner's value at the playhead. Prefer the
                // partner's keyframe-evaluated value if it's already
                // animated; otherwise use its constant.
                const partnerBlock = nextAnim[partnerName];
                const partnerEvaluated =
                  partnerBlock && partnerBlock.animated
                    ? evaluateKeyframesAt(
                        partnerBlock,
                        "scalar",
                        tickAtEdit
                      )
                    : undefined;
                const partnerConstant = n.data.params[partnerName];
                const partnerValue =
                  typeof partnerEvaluated === "number"
                    ? partnerEvaluated
                    : typeof partnerConstant === "number"
                      ? partnerConstant
                      : undefined;
                if (
                  typeof partnerValue === "number" &&
                  isFinite(partnerValue)
                ) {
                  const partnerCur =
                    nextAnim[partnerName] ?? emptyAnimationBlock();
                  const partnerEnabled = {
                    ...partnerCur,
                    animated: true,
                  };
                  nextAnim = {
                    ...nextAnim,
                    [partnerName]: upsertKeyframe(
                      partnerEnabled,
                      tickAtEdit,
                      partnerValue,
                      "easeInOut"
                    ),
                  };
                }
              }
            }
          }

          return {
            ...n,
            data: {
              ...n.data,
              animation:
                Object.keys(nextAnim).length > 0 ? nextAnim : undefined,
            },
          };
        })
      );
    },
    [setNodes, pushGraph, getGraphSnapshot, currentTick]
  );

  // Set/clear a node's timeline clip windows (Track Editor clip bars). Clip
  // drags fire many times per gesture, so coalesce the whole drag under one
  // undo entry keyed by node id — same pattern as slider drags. An empty
  // array is normalized to undefined so the field disappears when the last
  // window is removed.
  const onClipChange = useCallback(
    (nodeId: string, next: ClipBlock[] | undefined) => {
      pushGraph(getGraphSnapshot(), `clip:${nodeId}`);
      const normalized = next && next.length > 0 ? next : undefined;
      setNodes((prev) =>
        prev.map((n) =>
          n.id === nodeId
            ? { ...n, data: { ...n.data, clips: normalized } }
            : n
        )
      );
    },
    [setNodes, pushGraph, getGraphSnapshot]
  );

  // Per-instance slider range override. `null` clears the entry so a
  // future engine update to the param def's defaults takes effect.
  const onParamRangeChange = useCallback(
    (
      nodeId: string,
      paramName: string,
      override: { min?: number; max?: number; softMax?: number } | null
    ) => {
      pushGraph(getGraphSnapshot(), `range:${nodeId}:${paramName}`);
      setNodes((prev) =>
        prev.map((n) => {
          if (n.id !== nodeId) return n;
          const cur = n.data.paramOverrides ?? {};
          let nextOverrides: Record<
            string,
            { min?: number; max?: number; softMax?: number }
          >;
          if (override === null) {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { [paramName]: _drop, ...rest } = cur;
            nextOverrides = rest;
          } else {
            nextOverrides = { ...cur, [paramName]: override };
          }
          const next = {
            ...n,
            data: {
              ...n.data,
              paramOverrides:
                Object.keys(nextOverrides).length > 0
                  ? nextOverrides
                  : undefined,
            },
          };
          return next;
        })
      );
    },
    [setNodes, pushGraph, getGraphSnapshot]
  );

  // Flip the chain-link state for a `linkedPairs` entry on a node.
  // Linking captures the current `b / a` ratio so subsequent edits to
  // either side preserve the proportion. Unlinking clears the entry.
  const onToggleParamLink = useCallback(
    (nodeId: string, pairKey: string) => {
      pushGraph(getGraphSnapshot(), `link:${nodeId}:${pairKey}`);
      setNodes((prev) =>
        prev.map((n) => {
          if (n.id !== nodeId) return n;
          const def = getNodeDef(n.data.defType);
          const pair = def?.linkedPairs?.find(
            (p) => `${p.a}:${p.b}` === pairKey
          );
          if (!pair) return n;
          const cur = n.data.linkedParams ?? {};
          const isLinked = !!cur[pairKey];
          let nextLinked = { ...cur };
          if (isLinked) {
            delete nextLinked[pairKey];
          } else {
            const aVal = n.data.params[pair.a];
            const bVal = n.data.params[pair.b];
            const a = typeof aVal === "number" && isFinite(aVal) ? aVal : 1;
            const b = typeof bVal === "number" && isFinite(bVal) ? bVal : 1;
            // Capture ratio b/a so editing a → b preserves proportion.
            // If a is 0 we can't form a meaningful ratio; fall back to
            // 1:1, which means "keep them equal from now on".
            const ratio = a !== 0 ? b / a : 1;
            nextLinked[pairKey] = { ratio };
          }
          return {
            ...n,
            data: {
              ...n.data,
              linkedParams:
                Object.keys(nextLinked).length > 0 ? nextLinked : undefined,
            },
          };
        })
      );
    },
    [setNodes, pushGraph, getGraphSnapshot]
  );

  // Drop edges whose target handle no longer exists on the node — e.g. after
  // a merge layer was removed, a gradient mode change dropped the angle_mod
  // socket, or a param was un-exposed. Also drops edges whose SOURCE aux
  // output was retracted (e.g. Spline Draw's image output disappears when
  // both stroke and fill are off).
  useEffect(() => {
    setEdges((prev) => {
      const byId = new Map(nodes.map((n) => [n.id, n]));
      return prev.filter((e) => {
        const src = byId.get(e.source);
        if (src && e.sourceHandle?.startsWith("out:aux:")) {
          const auxName = e.sourceHandle.slice("out:aux:".length);
          if (!src.data.auxOutputs.some((a) => a.name === auxName)) return false;
        }
        const tgt = byId.get(e.target);
        if (!tgt) return false;
        if (!e.targetHandle) return true;
        const parsed = parseTargetHandleKind(e.targetHandle);
        if (!parsed) return true;
        if (parsed.kind === "input") {
          return tgt.data.inputs.some((i) => i.name === parsed.name);
        }
        // param socket: keep if the param is still in the node's exposedParams
        return (tgt.data.exposedParams ?? []).includes(parsed.name);
      });
    });
  }, [nodes, setEdges]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ id: string; kind: string }>).detail;
      if (!detail) return;
      if (
        detail.kind === "toggleActive" ||
        detail.kind === "toggleActive2" ||
        detail.kind === "toggleBypass" ||
        detail.kind === "mergeAddLayer" ||
        detail.kind === "autolayoutAddItem" ||
        detail.kind === "queueAddItem" ||
        detail.kind === "trailsReset"
      ) {
        pushGraph(getGraphSnapshot());
      }
      if (detail.kind === "toggleActive") {
        setNodes((prev) =>
          prev.map((n) => ({
            ...n,
            data: { ...n.data, active: n.id === detail.id ? !n.data.active : false },
          }))
        );
      } else if (detail.kind === "toggleActive2") {
        setNodes((prev) =>
          prev.map((n) => ({
            ...n,
            data: {
              ...n.data,
              active2: n.id === detail.id ? !n.data.active2 : false,
            },
          }))
        );
      } else if (detail.kind === "toggleBypass") {
        setNodes((prev) =>
          prev.map((n) =>
            n.id === detail.id
              ? { ...n, data: { ...n.data, bypassed: !n.data.bypassed } }
              : n
          )
        );
      } else if (detail.kind === "trailsReset") {
        // Increments a hidden `_reset_counter` param. The trails compute
        // compares against its stored lastResetCounter and wipes history
        // when they differ — no direct access into ctx.state needed from here.
        setNodes((prev) =>
          prev.map((n) => {
            if (n.id !== detail.id) return n;
            const cur = (n.data.params._reset_counter as number) ?? 0;
            return {
              ...n,
              data: {
                ...n.data,
                params: { ...n.data.params, _reset_counter: cur + 1 },
              },
            };
          })
        );
      } else if (detail.kind === "toggleInspect") {
        // Open / close the data inspector for this node. Toggling off
        // also drops the cached snapshot so a stale frame doesn't flash
        // if the user re-opens it before a new eval runs.
        setInspectIds((prev) => {
          if (prev.includes(detail.id)) {
            inspectSnapshotsRef.current.delete(detail.id);
            return prev.filter((x) => x !== detail.id);
          }
          return [...prev, detail.id];
        });
      } else if (detail.kind === "mergeAddLayer") {
        setNodes((prev) =>
          prev.map((n) => {
            if (n.id !== detail.id) return n;
            const current = (n.data.params.layers as MergeLayer[]) ?? [];
            const nextLayers: MergeLayer[] = [
              ...current,
              { id: newLayerId(), mode: "normal", opacity: 1 },
            ];
            const def = getNodeDef(n.data.defType);
            const nextParams = { ...n.data.params, layers: nextLayers };
            const resolved = def?.resolveInputs?.(nextParams);
            return {
              ...n,
              data: {
                ...n.data,
                params: nextParams,
                inputs: resolved
                  ? withMaskInput(resolved, def).map((i) => ({
                      name: i.name,
                      label: i.label,
                      type: i.type,
                      hidden: i.hidden,
                    }))
                  : n.data.inputs,
              },
            };
          })
        );
      } else if (detail.kind === "autolayoutAddItem") {
        setNodes((prev) =>
          prev.map((n) => {
            if (n.id !== detail.id) return n;
            const current = (n.data.params.items as AutoLayoutItem[]) ?? [];
            const nextItems: AutoLayoutItem[] = [
              ...current,
              defaultAutoLayoutItem(),
            ];
            const def = getNodeDef(n.data.defType);
            const nextParams = { ...n.data.params, items: nextItems };
            const resolved = def?.resolveInputs?.(nextParams);
            return {
              ...n,
              data: {
                ...n.data,
                params: nextParams,
                inputs: resolved
                  ? withMaskInput(resolved, def).map((i) => ({
                      name: i.name,
                      label: i.label,
                      type: i.type,
                      hidden: i.hidden,
                    }))
                  : n.data.inputs,
              },
            };
          })
        );
      } else if (detail.kind === "queueAddItem") {
        setNodes((prev) =>
          prev.map((n) => {
            if (n.id !== detail.id) return n;
            const current = (n.data.params.items as RenderQueueItem[]) ?? [];
            const nextItems: RenderQueueItem[] = [
              ...current,
              { id: newRenderQueueItemId(), kind: "video", frame: 0 },
            ];
            const def = getNodeDef(n.data.defType);
            const nextParams = { ...n.data.params, items: nextItems };
            const resolved = def?.resolveInputs?.(nextParams);
            return {
              ...n,
              data: {
                ...n.data,
                params: nextParams,
                inputs: resolved
                  ? withMaskInput(resolved, def).map((i) => ({
                      name: i.name,
                      label: i.label,
                      type: i.type,
                      hidden: i.hidden,
                    }))
                  : n.data.inputs,
              },
            };
          })
        );
      }
    };
    window.addEventListener("effect-node-toggle", handler);
    return () => window.removeEventListener("effect-node-toggle", handler);
  }, [setNodes, pushGraph, getGraphSnapshot]);

  // "Match Aspect" button inside the image / video load controls dispatches
  // the source's pixel dims here. We keep the project's current longest side
  // and swing only the aspect: a 1024×1024 project with a 16:9 source
  // becomes 1024×576; a portrait source becomes 576×1024.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (
        e as CustomEvent<{ width: number; height: number }>
      ).detail;
      const sw = detail?.width ?? 0;
      const sh = detail?.height ?? 0;
      if (sw <= 0 || sh <= 0) return;
      const srcAspect = sw / sh;
      const [cw, ch] = canvasResRef.current;
      const longest = Math.max(cw, ch);
      const clamp = (v: number) => Math.max(16, Math.min(8192, Math.round(v)));
      const next: [number, number] =
        srcAspect >= 1
          ? [clamp(longest), clamp(longest / srcAspect)]
          : [clamp(longest * srcAspect), clamp(longest)];
      setCanvasRes(next);
    };
    window.addEventListener("project-match-aspect", handler);
    return () => window.removeEventListener("project-match-aspect", handler);
  }, [setCanvasRes]);

  // Inline header controls (dropdowns on the node body) dispatch this
  // event to set a param value. Routes through onParamChange so every
  // normal param-change side effect — undo history, resolveInputs /
  // resolvePrimaryOutput / resolveAuxOutputs — fires naturally.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{
        id: string;
        name: string;
        value: unknown;
      }>).detail;
      if (!detail) return;
      onParamChange(detail.id, detail.name, detail.value);
    };
    window.addEventListener("effect-node-param", handler);
    return () => window.removeEventListener("effect-node-param", handler);
  }, [onParamChange]);

  const onToggleParamExposed = useCallback(
    (nodeId: string, paramName: string) => {
      pushGraph(getGraphSnapshot());
      let wasExposed = false;
      setNodes((prev) =>
        prev.map((n) => {
          if (n.id !== nodeId) return n;
          const current = n.data.exposedParams ?? [];
          const has = current.includes(paramName);
          wasExposed = has;
          const next = has
            ? current.filter((p) => p !== paramName)
            : [...current, paramName];
          return { ...n, data: { ...n.data, exposedParams: next } };
        })
      );
      // When removing the socket, drop any edge that was feeding it.
      if (wasExposed) {
        setEdges((prev) =>
          prev.filter((e) => {
            if (e.target !== nodeId) return true;
            const parsed = parseTargetHandleKind(e.targetHandle ?? "");
            return !(parsed?.kind === "param" && parsed.name === paramName);
          })
        );
      }
    },
    [setNodes, setEdges, pushGraph, getGraphSnapshot]
  );

  const onToggleParamControl = useCallback(
    (nodeId: string, paramName: string) => {
      pushGraph(getGraphSnapshot());
      setNodes((prev) =>
        prev.map((n) => {
          if (n.id !== nodeId) return n;
          const current = n.data.controlParams ?? [];
          const has = current.includes(paramName);
          const next = has
            ? current.filter((p) => p !== paramName)
            : [...current, paramName];
          return { ...n, data: { ...n.data, controlParams: next } };
        })
      );
    },
    [setNodes, pushGraph, getGraphSnapshot]
  );

  // Capture drag starts so a whole drag (many `position` changes with
  // `dragging: true`) collapses into one undo entry keyed by drag end.
  const dragStartSnapRef = useRef<GraphSnapshot | null>(null);
  const onNodesChangeWithHistory = useCallback(
    (changes: NodeChange<Node<NodeDataPayload>>[]) => {
      for (const c of changes) {
        if (c.type === "position") {
          if (c.dragging === true) {
            if (!dragStartSnapRef.current) {
              dragStartSnapRef.current = getGraphSnapshot();
            }
          } else if (c.dragging === false) {
            if (dragStartSnapRef.current) {
              pushGraph(dragStartSnapRef.current);
              dragStartSnapRef.current = null;
            }
          }
        } else if (c.type === "remove") {
          // Deleting a node typically triggers edge removals in the same
          // dispatch batch — coalesce them under one "rf-remove" entry.
          pushGraph(getGraphSnapshot(), "rf-remove");
        }
      }
      // Cascade group deletion: removing a group shell also removes its
      // interior (recursively) and any edges touching it — otherwise the
      // orphans linger invisible in the flat array. deleteElements only
      // knows about the shell, so the cascade is appended here, at the
      // single chokepoint every removal flows through.
      const removedIds = changes
        .filter((c) => c.type === "remove")
        .map((c) => c.id);
      if (removedIds.length > 0) {
        const dead = new Set([
          ...removedIds,
          ...collectDescendantIds(nodesRef.current, removedIds),
        ]);
        // Deleting a root layer heals the chain: the layer below
        // reconnects to whatever the deleted one fed (the layer above,
        // or Output). Compute the full survivor graph and apply it
        // directly — RF's incremental change path can't express the
        // re-wire.
        const removedRootLayer = removedIds.some((id) => {
          const n = nodesRef.current.find((x) => x.id === id);
          return n && n.data.defType === LAYER_TYPE && !n.data.parentId;
        });
        if (removedRootLayer) {
          const order = getLayerChain(nodesRef.current, edgesRef.current)
            .map((n) => n.id)
            .filter((id) => !dead.has(id));
          const survivors = nodesRef.current.filter((n) => !dead.has(n.id));
          const survEdges = edgesRef.current.filter(
            (e) => !dead.has(e.source) && !dead.has(e.target)
          );
          const res = reorderLayers(survivors, survEdges, order);
          setNodes(res.nodes);
          setEdges(res.edges);
          return;
        }
        if (dead.size > removedIds.length) {
          changes = [
            ...changes,
            ...[...dead]
              .filter((id) => !removedIds.includes(id))
              .map((id) => ({ type: "remove" as const, id })),
          ];
          const edgeRemovals = edgesRef.current
            .filter((e) => dead.has(e.source) || dead.has(e.target))
            .map((e) => ({ type: "remove" as const, id: e.id }));
          if (edgeRemovals.length > 0) onEdgesChange(edgeRemovals);
        }
      }
      onNodesChange(changes);
    },
    [onNodesChange, onEdgesChange, pushGraph, getGraphSnapshot, setNodes, setEdges]
  );
  const onEdgesChangeWithHistory = useCallback(
    (changes: EdgeChange[]) => {
      for (const c of changes) {
        if (c.type === "remove") {
          pushGraph(getGraphSnapshot(), "rf-remove");
        }
      }
      onEdgesChange(changes);
    },
    [onEdgesChange, pushGraph, getGraphSnapshot]
  );

  // --- Export ---------------------------------------------------------------
  // Video export drives live playback through the timeline while a
  // MediaRecorder reads the canvas. That keeps us to a single code path and
  // zero dependencies; the tradeoff vs. offline WebCodecs encoding is that
  // recording is real-time and any dropped frames show up in the output.
  const timeRef = useRef(time);
  timeRef.current = time;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const fpsRef = useRef(fps);
  fpsRef.current = fps;
  const loopFramesRef = useRef(loopFrames);
  loopFramesRef.current = loopFrames;

  // `mode === "live"` is the MediaRecorder path — banner shows a
  // countdown. `mode === "offline"` is WebCodecs / ffmpeg.wasm — banner
  // shows a progress bar from `progress` (0..1) and a label.
  const [recording, setRecording] = useState<
    | { mode: "live"; totalSec: number; startedAt: number }
    | { mode: "offline"; label: string; progress: number }
    | null
  >(null);
  const recordingRef = useRef(recording);
  recordingRef.current = recording;

  // Render Queue batch progress. Shown as an "Item i/N · <name>" line above
  // the per-item export banner. Separate from `recording` so each item's own
  // export still drives its overlay while the batch tracks the outer loop.
  const [queueProgress, setQueueProgress] = useState<{
    index: number;
    total: number;
    name: string;
    // Which Render Queue node is running and which of its rows is
    // rendering — lets the param panel and the canvas node highlight the
    // matching row. itemId is null during the trailing zip step.
    nodeId: string;
    itemId: string | null;
  } | null>(null);
  const queueRenderingRef = useRef(false);

  // Drives the save/load progress banner. `progress` is a 0..1 value; the
  // banner renders it as a percentage plus a thin fill bar.
  const [progressStatus, setProgressStatus] = useState<{
    label: string;
    progress: number;
    tone: "save" | "load";
  } | null>(null);

  // Nodes that do async work (model downloads, etc.) dispatch
  // `node-progress` events. EffectsApp listens and forwards to the same
  // banner used for save/load so the user gets consistent progress UX
  // regardless of which subsystem is loading.
  useEffect(() => {
    const onProgress = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { label: string; progress: number; tone?: "save" | "load" }
        | null
        | undefined;
      if (!detail) {
        setProgressStatus(null);
        return;
      }
      setProgressStatus({
        label: detail.label,
        progress: detail.progress,
        tone: detail.tone ?? "load",
      });
    };
    window.addEventListener("node-progress", onProgress);
    return () => window.removeEventListener("node-progress", onProgress);
  }, []);
  // Cmd+G — collapse the selection into a group. graph-ops owns socket
  // creation, edge surgery, and cycle refusal; refusals surface as a
  // toast.
  const handleGroupSelection = useCallback(() => {
    // Strict root: layers live at root and can't be grouped — Cmd+G
    // only works inside a layer (or deeper).
    if (!currentGroupIdRef.current) {
      flashToast("Cmd+G is disabled at root — group inside a layer");
      return;
    }
    const selectedIds = new Set(
      nodesRef.current.filter((n) => n.selected).map((n) => n.id)
    );
    if (selectedIds.size === 0) return;
    const res = groupSelection(
      nodesRef.current,
      edgesRef.current,
      selectedIds,
      currentGroupIdRef.current
    );
    if (!res.ok) {
      flashToast(res.error);
      return;
    }
    pushGraph(getGraphSnapshot());
    setNodes(res.nodes);
    setEdges(res.edges);
    setSelectedId(res.groupId);
    setParamView("node");
  }, [
    pushGraph,
    getGraphSnapshot,
    setNodes,
    setEdges,
    setSelectedId,
    setParamView,
    flashToast,
  ]);

  // Cmd+Shift+G — dissolve every selected group back into the current
  // scope. Multiple selected groups dissolve in one undo step.
  const handleUngroupSelection = useCallback(() => {
    const selectedGroups = nodesRef.current.filter(
      (n) => n.selected && n.data.defType === GROUP_TYPE
    );
    if (selectedGroups.length === 0) {
      flashToast("Select a group to ungroup");
      return;
    }
    pushGraph(getGraphSnapshot());
    let curNodes = nodesRef.current;
    let curEdges = edgesRef.current;
    for (const g of selectedGroups) {
      const res = ungroupNode(curNodes, curEdges, g.id);
      if (!res.ok) continue;
      curNodes = res.nodes;
      curEdges = res.edges;
    }
    setNodes(curNodes);
    setEdges(curEdges);
    setSelectedId(null);
  }, [
    pushGraph,
    getGraphSnapshot,
    setNodes,
    setEdges,
    setSelectedId,
    flashToast,
  ]);

  // Rename a node (today surfaced for group shells in the ParamPanel;
  // breadcrumbs and the Layers editor read the same data.name).
  const handleRenameNode = useCallback(
    (nodeId: string, rawName: string) => {
      const name = rawName.trim();
      if (!name) return;
      const node = nodesRef.current.find((n) => n.id === nodeId);
      if (!node || node.data.name === name) return;
      pushGraph(getGraphSnapshot());
      setNodes((prev) =>
        prev.map((n) =>
          n.id === nodeId ? { ...n, data: { ...n.data, name } } : n
        )
      );
    },
    [pushGraph, getGraphSnapshot, setNodes]
  );

  // Rename / remove a socket on a Group Input / Group Output node —
  // edge handles on both faces of the boundary are rewritten/dropped by
  // graph-ops.
  const handleRenameGroupSocket = useCallback(
    (nodeId: string, oldName: string, newName: string) => {
      const res = renameGroupSocket(
        nodesRef.current,
        edgesRef.current,
        nodeId,
        oldName,
        newName
      );
      if (!res) return;
      pushGraph(getGraphSnapshot());
      setNodes(res.nodes);
      setEdges(res.edges);
    },
    [pushGraph, getGraphSnapshot, setNodes, setEdges]
  );

  const handleRemoveGroupSocket = useCallback(
    (nodeId: string, name: string) => {
      const res = removeGroupSocket(
        nodesRef.current,
        edgesRef.current,
        nodeId,
        name
      );
      if (!res) return;
      pushGraph(getGraphSnapshot());
      setNodes(res.nodes);
      setEdges(res.edges);
    },
    [pushGraph, getGraphSnapshot, setNodes, setEdges]
  );

  // Scope-filtered view for the node editor: nodes outside the current
  // group scope get React Flow's `hidden` flag (positions persist, and
  // edges with a hidden endpoint hide automatically). Identity is
  // preserved for nodes whose flag is already correct so React Flow
  // only re-renders on actual scope changes.
  const scopedNodes = useMemo(
    () =>
      nodes.map((n) => {
        const hidden = n.data.parentId !== currentGroupId;
        return !!n.hidden === hidden ? n : { ...n, hidden };
      }),
    [nodes, currentGroupId]
  );

  // Scope trail for the breadcrumb row: project name at root, then one
  // crumb per group down to the current scope.
  const breadcrumbs = useMemo(() => {
    const chain: { id: string | null; name: string }[] = [];
    let cur: string | undefined = currentGroupId;
    for (let guard = 0; cur && guard < 100; guard++) {
      const g = nodes.find((n) => n.id === cur);
      if (!g) break;
      chain.unshift({ id: g.id, name: g.data.name });
      cur = g.data.parentId;
    }
    return [
      { id: null, name: currentProject?.name ?? "Untitled" },
      ...chain,
    ];
  }, [nodes, currentGroupId, currentProject]);

  // --- Layers editor wiring ------------------------------------------------

  // Ordered root layer chain (bottom → top) — the Layers editor renders
  // it reversed (top of stack first).
  const layerChain = useMemo(
    () => getLayerChain(nodes, edges),
    [nodes, edges]
  );

  const handleReorderLayers = useCallback(
    (orderedBottomToTop: string[]) => {
      pushGraph(getGraphSnapshot());
      const res = reorderLayers(
        nodesRef.current,
        edgesRef.current,
        orderedBottomToTop
      );
      setNodes(res.nodes);
      setEdges(res.edges);
    },
    [pushGraph, getGraphSnapshot, setNodes, setEdges]
  );

  const handleAddLayerFromEditor = useCallback(
    (kind: "empty" | "text" | "image" | "video") => {
      const content =
        kind === "text"
          ? "text"
          : kind === "image"
            ? "image-source"
            : kind === "video"
              ? "video-source"
              : undefined;
      const name =
        kind === "empty"
          ? undefined
          : kind[0].toUpperCase() + kind.slice(1);
      pushGraph(getGraphSnapshot());
      const res = createLayer(nodesRef.current, edgesRef.current, {
        content,
        name,
      });
      setNodes(res.nodes);
      setEdges(res.edges);
      setSelectedId(res.layerId);
      setParamView("node");
    },
    [pushGraph, getGraphSnapshot, setNodes, setEdges, setSelectedId, setParamView]
  );

  // Visibility = bypass (the layer passes its stack through). Reuse the
  // existing toggle-bypass event so undo / fingerprinting are handled.
  const handleToggleLayerVisibility = useCallback((nodeId: string) => {
    window.dispatchEvent(
      new CustomEvent("effect-node-toggle", {
        detail: { id: nodeId, kind: "toggleBypass" },
      })
    );
  }, []);

  const handleSelectLayer = useCallback(
    (nodeId: string) => {
      setNodes((prev) =>
        prev.map((n) =>
          n.selected === (n.id === nodeId)
            ? n
            : { ...n, selected: n.id === nodeId }
        )
      );
      setSelectedId(nodeId);
      setParamView("node");
    },
    [setNodes, setSelectedId, setParamView]
  );

  // Cmd+Shift+D: split a layer at the playhead into two distinct layers
  // (deep copy + chain insert; in/out set by the split). No-op when the
  // playhead isn't inside the layer's span.
  const handleSplitLayer = useCallback(
    (nodeId: string, splitTick: number) => {
      const res = splitLayer(
        nodesRef.current,
        edgesRef.current,
        nodeId,
        splitTick,
        (loopFramesRef.current != null && loopFramesRef.current > 0
          ? loopFramesRef.current
          : fpsRef.current * 5) * ticksPerFrame
      );
      if (!res) return;
      pushGraph(getGraphSnapshot());
      setNodes(res.nodes);
      setEdges(res.edges);
      setSelectedId(res.newLayerId);
      setParamView("node");
    },
    [
      pushGraph,
      getGraphSnapshot,
      setNodes,
      setEdges,
      setSelectedId,
      setParamView,
      ticksPerFrame,
    ]
  );

  const getOutputParams = useCallback((nodeId: string) => {
    const node = nodesRef.current.find((n) => n.id === nodeId);
    return node?.data.defType === "output" ? node.data.params : null;
  }, []);

  // The source feeding the Output node's `audio` socket, distilled to the
  // params the export muxer needs. Handles both Audio Source (primary audio)
  // and Video Source (audio aux output). Null when nothing is wired in or the
  // source isn't an audio-capable node.
  const getOutputAudioSpec = useCallback(
    (outputNodeId: string): ExportAudioSpec | null => {
      const edge = edgesRef.current.find(
        (e) => e.target === outputNodeId && e.targetHandle === "in:audio"
      );
      if (!edge) return null;
      const node = nodesRef.current.find((n) => n.id === edge.source);
      if (!node) return null;
      const p = node.data.params;
      const volume = Math.max(0, Math.min(1, (p.volume as number) ?? 1));
      if (node.data.defType === "audio-source") {
        const file = (p.file as AudioFileParamValue | null) ?? null;
        return {
          nodeId: node.id,
          mode: (p.mode as "file" | "microphone") ?? "file",
          url: file?.url ?? null,
          element: file?.element ?? null,
          volume,
          loop: !!p.loop,
          sync: !!p.sync_to_scene_time,
          startOffset: (p.start_offset as number) ?? 0,
        };
      }
      if (node.data.defType === "video-source") {
        // Image sequences carry no audio.
        if ((p.source_kind ?? "video") === "sequence") return null;
        const file = (p.file as VideoFileParamValue | null) ?? null;
        return {
          nodeId: node.id,
          mode: "file",
          url: file?.url ?? null,
          element: file?.video ?? null,
          volume,
          loop: !!p.loop,
          sync: !!p.sync_to_scene_time,
          startOffset: (p.start_offset as number) ?? 0,
        };
      }
      return null;
    },
    []
  );

  // Live audio track for the Fast (MediaRecorder) path. File-mode clips
  // expose one via captureStream(); mic-mode reads the live MediaStream off
  // the node's compute state. Returns null if unavailable.
  const getLiveAudioTrack = useCallback(
    (spec: ExportAudioSpec): MediaStreamTrack | null => {
      try {
        if (spec.mode === "microphone") {
          const st = backendRef.current?.state?.[
            `audio-source:${spec.nodeId}`
          ] as { micStream?: MediaStream } | undefined;
          return st?.micStream?.getAudioTracks?.()[0] ?? null;
        }
        const el = spec.element as
          | (HTMLMediaElement & {
              captureStream?: () => MediaStream;
              mozCaptureStream?: () => MediaStream;
            })
          | null;
        if (!el) return null;
        const cs = el.captureStream?.() ?? el.mozCaptureStream?.();
        return cs?.getAudioTracks?.()[0] ?? null;
      } catch {
        return null;
      }
    },
    []
  );

  const exportImage = useCallback(
    (nodeId: string) => {
      const canvas = canvasRef.current;
      const params = getOutputParams(nodeId);
      if (!canvas || !params) return;
      const format = (params.imageFormat as string) ?? "png";
      const quality = (params.imageQuality as number) ?? 0.92;
      const base = sanitizeFilename((params.filename as string) ?? "");
      const mime = `image/${format}`;
      const useQuality = format === "jpeg" || format === "webp";
      canvas.toBlob(
        (blob) => {
          if (!blob) return;
          downloadBlob(blob, base ? `${base}.${format}` : defaultFilename(format));
        },
        mime,
        useQuality ? quality : undefined
      );
    },
    [getOutputParams]
  );

  const copyImageToClipboard = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // ClipboardItem only accepts PNG reliably — format-specific exports go
    // through the download path above.
    const blob = await new Promise<Blob | null>((r) =>
      canvas.toBlob((b) => r(b), "image/png")
    );
    if (!blob) return;
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      flashToast("copied");
    } catch (e) {
      console.error("Copy to clipboard failed:", e);
    }
  }, [flashToast]);

  const exportVideo = useCallback(
    async (
      nodeId: string,
      // When `sink` is provided (batch render), the finished blob is handed
      // back instead of being downloaded — the Render Queue collects them
      // and delivers the whole batch at the end.
      opts?: { sink?: (blob: Blob, ext: string) => void }
    ) => {
      // The re-entrancy lock guards the standalone Export button. Batch (sink)
      // calls are already serialized by renderQueue's queueRenderingRef, and
      // recordingRef lags React state between awaited iterations — so don't let
      // a stale `recording` value abort every item after the first.
      if (recordingRef.current && !opts?.sink) return;
      const canvas = canvasRef.current;
      const params = getOutputParams(nodeId);
      if (!canvas || !params) return;
      const deliver = (blob: Blob, ext: string) => {
        if (opts?.sink) opts.sink(blob, ext);
        else
          downloadBlob(
            blob,
            base ? `${base}.${ext}` : defaultFilename(ext)
          );
      };

      const quality =
        (params.videoQuality as "fast" | "high" | "max") ?? "high";
      const container =
        (params.videoFormat as "mp4" | "webm" | "mov" | "mkv") ?? "mp4";
      // Frame range, half-open [startFrame, endFrame): count = end − start.
      // `videoFrames` is the legacy duration param (old saves migrate to
      // start/end in project.ts, but read it as a fallback here too).
      const { startFrame, durationFrames } = resolveFrameRange(params);
      const bitrateMbps = (params.videoBitrateMbps as number) ?? 16;
      const base = sanitizeFilename((params.filename as string) ?? "");
      const previewFps = fpsRef.current;
      const exportFps =
        quality === "fast"
          ? previewFps
          : Math.max(1, (params.videoFps as number) ?? previewFps);

      const savedTime = timeRef.current;
      const savedPlaying = playingRef.current;

      // ---- Fast / live path (MediaRecorder) ------------------------------
      if (quality === "fast") {
        const liveContainer = container === "webm" ? "webm" : "mp4";
        // Pull a live audio track (file or mic) from the wired Audio Source
        // and mix it into the captured stream. Picked before the mime so we
        // can request an audio-capable codec string when there's audio.
        const audioSpec = getOutputAudioSpec(nodeId);
        const audioTrack = audioSpec ? getLiveAudioTrack(audioSpec) : null;
        const picked = pickVideoMime(liveContainer, !!audioTrack);
        if (!picked) {
          console.error("No supported video codec in this browser");
          return;
        }
        const totalSec = durationFrames / previewFps;
        const stream = canvas.captureStream(previewFps);
        if (audioTrack) stream.addTrack(audioTrack);
        const recorder = new MediaRecorder(stream, {
          mimeType: picked.mime,
          videoBitsPerSecond: Math.round(bitrateMbps * 1_000_000),
        });
        const chunks: Blob[] = [];
        recorder.ondataavailable = (e) => {
          if (e.data.size) chunks.push(e.data);
        };
        const done = new Promise<Blob>((resolve) => {
          recorder.onstop = () => {
            const type = picked.mime.split(";")[0];
            resolve(new Blob(chunks, { type }));
          };
        });

        // Capture the specific Output being exported, not whatever node the
        // user has set Active. The eval effect drives the live canvas during
        // playback, so route the override through forcedTerminalRef.
        forcedTerminalRef.current = nodeId;
        try {
          setTime(startFrame / previewFps);
          await new Promise<void>((r) => {
            requestAnimationFrame(() => requestAnimationFrame(() => r()));
          });

          setPlaying(true);
          recorder.start();
          setRecording({
            mode: "live",
            totalSec,
            startedAt: performance.now(),
          });

          await new Promise((r) => setTimeout(r, totalSec * 1000));
          recorder.stop();
        } finally {
          forcedTerminalRef.current = null;
          setPlaying(savedPlaying);
          setTime(savedTime);
          setRecording(null);
        }

        const blob = await done;
        deliver(blob, picked.ext);
        return;
      }

      // ---- Offline path (WebCodecs or ffmpeg.wasm) ------------------------
      // Both rely on `renderFrameRef.current(t, fps, true)` to step the
      // pipeline synchronously. We pass `playing: true` so animation
      // nodes that gate on it (audio sources, particle systems, etc.)
      // still advance during the export render.
      setPlaying(false);
      // Take over rendering: the export loop drives the canvas imperatively
      // (below), so the time-driven eval effect must not also render — see
      // offlineRenderingRef. Without this each frame would render twice.
      offlineRenderingRef.current = true;
      // Render the specific Output being exported, regardless of which node is
      // set Active in the UI. Cleared in the finally below.
      forcedTerminalRef.current = nodeId;
      setRecording({ mode: "offline", label: "Preparing…", progress: 0 });

      const renderAt = async (frameIndex: number, _t: number) => {
        // The exporter counts from 0; offset by startFrame so the export
        // window is [startFrame, startFrame + durationFrames). Ignore the
        // exporter's own `t` and compute the real project time here.
        const t = (startFrame + frameIndex) / exportFps;
        // setTime only advances the visible timeline cursor for progress
        // feedback — with the eval effect guarded by offlineRenderingRef it
        // no longer triggers a redundant render of the same frame.
        setTime(t);
        // Pass 1 issues any async media work (video seeks to the exact
        // target time). Nodes register a settle promise; if any did, wait
        // for the decode to land, then render again to upload the now-
        // correct frames before the encoder captures. Without this, video
        // sources record stale frames and multiple videos drift out of
        // sync — the deterministic export's job is to be frame-accurate.
        const backend = backendRef.current;
        renderFrameRef.current?.(t, exportFps, true);
        const settled = backend
          ? await awaitMediaSettle(backend.state)
          : false;
        if (settled) renderFrameRef.current?.(t, exportFps, true);
      };

      try {
        // Render the wired audio into a buffer covering the export window
        // (file mode only — mic has no deterministic offline form). Shared
        // by both offline encoders; null when no file audio is connected.
        const audioSpec = getOutputAudioSpec(nodeId);
        let audioBuffer: AudioBuffer | null = null;
        if (audioSpec) {
          try {
            audioBuffer = await renderExportAudioBuffer(
              audioSpec,
              durationFrames / exportFps,
              startFrame / exportFps
            );
          } catch (e) {
            console.warn(
              "Audio render for export failed; exporting video only:",
              e
            );
          }
        }

        let result: { blob: Blob; ext: string };
        if (quality === "high") {
          const { exportVideoWebCodecs } = await import("@/lib/export-webcodecs");
          // High-tier codec menu intersected with what mediabunny accepts
          // for the chosen container. Defaults to AVC for mp4, VP9 for webm.
          const rawCodec = (params.videoCodec as string) ?? "avc";
          type WC = "avc" | "hevc" | "vp9" | "av1";
          const wcAllowed: WC[] = ["avc", "hevc", "vp9", "av1"];
          const codec: WC = (
            wcAllowed.includes(rawCodec as WC) ? rawCodec : "avc"
          ) as WC;
          const wcContainer =
            container === "webm" ? "webm" : "mp4";
          result = await exportVideoWebCodecs({
            canvas,
            container: wcContainer,
            codec,
            bitrateBps: Math.round(bitrateMbps * 1_000_000),
            fps: exportFps,
            durationFrames,
            audioBuffer,
            renderFrame: renderAt,
            onProgress: (label, frac) =>
              setRecording({
                mode: "offline",
                label,
                progress: frac,
              }),
          });
        } else {
          const rawCodec = (params.videoCodec as string) ?? "h264";
          type FC =
            | "h264" | "h264-lossless" | "h265" | "prores" | "vp9" | "av1";
          const ffAllowed: FC[] = [
            "h264", "h264-lossless", "h265", "prores", "vp9", "av1",
          ];
          // If the user left a webcodecs-only codec selected when
          // switching to Max, fall back to h264 silently.
          const codec: FC = (
            ffAllowed.includes(rawCodec as FC) ? rawCodec : "h264"
          ) as FC;
          const proresName = (params.videoProresProfile as string) ?? "hq";
          const proresMap: Record<string, number> = {
            proxy: 0, lt: 1, standard: 2, hq: 3, "4444": 4, "4444xq": 5,
          };
          const proresProfile = proresMap[proresName] ?? 3;
          const crf = (params.videoCrf as number) ?? 18;
          // Mirror the Output node's ParamDef default (true): unedited and
          // pre-existing saves have no stored value, so default to emitting
          // alpha for 4444/4444xq. Ignored for non-4444 profiles.
          const alpha = (params.videoAlpha as boolean) ?? true;
          // ProRes is only compatible with mov/mkv; nudge the user.
          const ffContainer =
            (codec === "prores" && container === "mp4")
              ? "mov"
              : (codec === "prores" && container === "webm")
                ? "mov"
                : container;

          // ---- Native ffmpeg (Electron) ----------------------------------
          // Stream RGBA frames to a real ffmpeg process: no wasm heap limit,
          // multi-threaded, writes straight to disk. This is the fix for big
          // exports. Only the standalone Export path (no Render Queue sink)
          // uses it for now — batch collection still needs in-memory blobs.
          if (platform.canEncodeNative && platform.encodeVideo && !opts?.sink) {
            const session = await platform.encodeVideo(
              {
                width: canvas.width,
                height: canvas.height,
                fps: exportFps,
                durationFrames,
                container: ffContainer,
                codec,
                crf,
                proresProfile,
                alpha,
                audioWav: audioBuffer ? audioBufferToWav(audioBuffer) : undefined,
                suggestedName: base
                  ? `${base}.${ffContainer}`
                  : defaultFilename(ffContainer),
              },
              (label, frac) =>
                setRecording({ mode: "offline", label, progress: frac })
            );
            if (!session) return; // user cancelled the Save dialog
            // Offscreen 2D canvas to read straight-alpha RGBA8 (same fidelity
            // as the wasm path's canvas.toBlob, but skips PNG encode).
            const rgbaCanvas = document.createElement("canvas");
            rgbaCanvas.width = canvas.width;
            rgbaCanvas.height = canvas.height;
            const rgbaCtx = rgbaCanvas.getContext("2d", {
              willReadFrequently: true,
            });
            try {
              for (let i = 0; i < durationFrames; i++) {
                await renderAt(i, 0);
                await new Promise<void>((r) => requestAnimationFrame(() => r()));
                rgbaCtx?.clearRect(0, 0, rgbaCanvas.width, rgbaCanvas.height);
                rgbaCtx?.drawImage(canvas, 0, 0);
                const data = rgbaCtx?.getImageData(
                  0, 0, rgbaCanvas.width, rgbaCanvas.height
                ).data;
                if (data) await session.writeFrame(new Uint8Array(data.buffer));
                setRecording({
                  mode: "offline",
                  label: `Encoding ${i + 1}/${durationFrames}`,
                  progress: (i + 1) / durationFrames,
                });
              }
              await session.finish();
            } catch (e) {
              await session.abort().catch(() => {});
              throw e;
            }
            flashToast(
              `Exported ${durationFrames} frame${durationFrames === 1 ? "" : "s"}`
            );
            return;
          }

          const { exportVideoFfmpeg } = await import("@/lib/export-ffmpeg");
          result = await exportVideoFfmpeg({
            canvas,
            container: ffContainer,
            codec,
            crf,
            proresProfile,
            alpha,
            fps: exportFps,
            durationFrames,
            audioWav: audioBuffer ? audioBufferToWav(audioBuffer) : null,
            renderFrame: renderAt,
            onProgress: (label, frac) =>
              setRecording({ mode: "offline", label, progress: frac }),
          });
        }

        deliver(result.blob, result.ext);
      } catch (err) {
        console.error("Video export failed:", err);
        const msg = err instanceof Error ? err.message : "Export failed";
        flashToast(msg);
      } finally {
        // Hand rendering back to the eval effect before restoring state, so
        // the restored time/playing values drive a normal render again.
        offlineRenderingRef.current = false;
        forcedTerminalRef.current = null;
        setPlaying(savedPlaying);
        setTime(savedTime);
        setRecording(null);
      }
    },
    [getOutputParams, getOutputAudioSpec, getLiveAudioTrack, flashToast]
  );

  // Render a single still for a Render Queue image item: step the offline
  // clock to the requested frame, render it deterministically (waiting for
  // any async media seeks), then read the canvas. Returns the blob + ext.
  const renderImageToBlobAtFrame = useCallback(
    async (
      nodeId: string,
      frame: number
    ): Promise<{ blob: Blob; ext: string } | null> => {
      const canvas = canvasRef.current;
      const params = getOutputParams(nodeId);
      if (!canvas || !params) return null;
      const format = (params.imageFormat as string) ?? "png";
      const quality = (params.imageQuality as number) ?? 0.92;
      const useQuality = format === "jpeg" || format === "webp";
      const fps = fpsRef.current;
      const t = Math.max(0, frame) / Math.max(1, fps);

      const savedTime = timeRef.current;
      const savedPlaying = playingRef.current;
      setPlaying(false);
      offlineRenderingRef.current = true;
      // Capture this Output's image, not whatever node is set Active.
      forcedTerminalRef.current = nodeId;
      try {
        setTime(t);
        const backend = backendRef.current;
        renderFrameRef.current?.(t, fps, true);
        const settled = backend ? await awaitMediaSettle(backend.state) : false;
        if (settled) renderFrameRef.current?.(t, fps, true);
        // Yield so the GL commands flush before we read pixels back.
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        const blob = await new Promise<Blob | null>((res) =>
          canvas.toBlob(
            (b) => res(b),
            `image/${format}`,
            useQuality ? quality : undefined
          )
        );
        return blob ? { blob, ext: format } : null;
      } finally {
        offlineRenderingRef.current = false;
        forcedTerminalRef.current = null;
        setPlaying(savedPlaying);
        setTime(savedTime);
      }
    },
    [getOutputParams]
  );

  // Export an image sequence: render one still per frame across the Output's
  // [startFrame, endFrame) range and deliver per its `seqDelivery` mode —
  // single zip (default), streamed into a chosen folder (File System Access),
  // or one download per frame. Same deterministic two-pass offline render as
  // renderImageToBlobAtFrame, but takes over rendering once and loops.
  const exportSequence = useCallback(
    async (nodeId: string) => {
      if (recordingRef.current || queueRenderingRef.current) return;
      const canvas = canvasRef.current;
      const params = getOutputParams(nodeId);
      if (!canvas || !params) return;

      const { startFrame, endFrame, durationFrames } = resolveFrameRange(params);
      if (durationFrames <= 0) {
        flashToast("End frame must be after start frame");
        return;
      }
      const format = (params.imageFormat as string) ?? "png";
      const quality = (params.imageQuality as number) ?? 0.92;
      const useQuality = format === "jpeg" || format === "webp";
      const delivery =
        (params.seqDelivery as "zip" | "folder" | "sequential") ?? "zip";
      const fps = Math.max(
        1,
        (params.videoFps as number) ?? fpsRef.current
      );
      // Frame number is zero-padded to the width of the last frame (min 4),
      // e.g. `myrender.0000.png`. Files are named by their true frame index.
      const base =
        sanitizeFilename((params.filename as string) ?? "") ||
        defaultFilename(format).replace(/\.[^.]+$/, "");
      const pad = Math.max(4, String(Math.max(0, endFrame - 1)).length);
      const nameFor = (frame: number) =>
        `${base}.${String(frame).padStart(pad, "0")}.${format}`;

      // Folder mode: prompt for a destination up front. Native = OS folder
      // dialog; web = File System Access (Chromium only).
      let folder: FolderHandle | null = null;
      if (delivery === "folder") {
        if (!platform.isNative && !("showDirectoryPicker" in window)) {
          flashToast("Folder mode needs a Chromium browser");
          return;
        }
        folder = await platform.pickSaveFolder();
        // null = cancelled (web also returns null if unsupported, handled above).
        if (!folder) return;
      }

      const savedTime = timeRef.current;
      const savedPlaying = playingRef.current;
      setPlaying(false);
      offlineRenderingRef.current = true;
      forcedTerminalRef.current = nodeId;
      setRecording({ mode: "offline", label: "Preparing…", progress: 0 });

      const collected: { blob: Blob; name: string }[] = [];
      let written = 0;
      try {
        for (let i = 0; i < durationFrames; i++) {
          const frame = startFrame + i;
          const t = frame / fps;
          setTime(t);
          // Two-pass deterministic render: issue any async media seeks, wait
          // for them to settle, then render again so the encoder captures the
          // correct frame (matches renderImageToBlobAtFrame / the exporters).
          const backend = backendRef.current;
          renderFrameRef.current?.(t, fps, true);
          const settled = backend
            ? await awaitMediaSettle(backend.state)
            : false;
          if (settled) renderFrameRef.current?.(t, fps, true);
          // Yield so the GL commands flush before we read pixels back.
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
          const blob = await new Promise<Blob | null>((res) =>
            canvas.toBlob(
              (b) => res(b),
              `image/${format}`,
              useQuality ? quality : undefined
            )
          );
          if (blob) {
            const name = nameFor(frame);
            if (delivery === "folder" && folder) {
              await folder.writeFile(name, blob);
            } else if (delivery === "sequential") {
              downloadBlob(blob, name);
            } else {
              collected.push({ blob, name });
            }
            written++;
          }
          setRecording({
            mode: "offline",
            label: `Frame ${i + 1}/${durationFrames}`,
            progress: (i + 1) / durationFrames,
          });
        }

        if (delivery === "zip" && collected.length) {
          setRecording({ mode: "offline", label: "zipping…", progress: 1 });
          const JSZip = (await import("jszip")).default;
          const zip = new JSZip();
          for (const c of collected) zip.file(c.name, c.blob);
          const zipBlob = await zip.generateAsync({ type: "blob" });
          downloadBlob(zipBlob, `${base}.zip`);
        }
        flashToast(`Rendered ${written} frame${written === 1 ? "" : "s"}`);
      } catch (err) {
        console.error("Sequence export failed:", err);
        flashToast(err instanceof Error ? err.message : "Sequence export failed");
      } finally {
        offlineRenderingRef.current = false;
        forcedTerminalRef.current = null;
        setPlaying(savedPlaying);
        setTime(savedTime);
        setRecording(null);
      }
    },
    [getOutputParams, flashToast]
  );

  // Animated GIF export. Same deterministic offline render scaffold as
  // exportVideo's high/max tiers (frame-stepped, media-settled), but the
  // frames are piped through export-gif.ts (ffmpeg palettegen + gifsicle
  // lossy) instead of a video encoder. No audio. See
  // specdocs/061826_gif-export-and-image-sequence.md.
  const exportGif = useCallback(
    async (nodeId: string) => {
      if (recordingRef.current || queueRenderingRef.current) return;
      const canvas = canvasRef.current;
      const params = getOutputParams(nodeId);
      if (!canvas || !params) return;

      const { startFrame, durationFrames } = resolveFrameRange(params);
      if (durationFrames <= 0) {
        flashToast("End frame must be after start frame");
        return;
      }
      const exportFps = Math.max(1, (params.videoFps as number) ?? fpsRef.current);
      const base = sanitizeFilename((params.filename as string) ?? "");

      const colors = Math.round((params.gifColors as number) ?? 256);
      const dither = ((params.gifDither as string) ?? "floyd") as
        | "none"
        | "bayer"
        | "floyd";
      const lossy = Math.round((params.gifLossy as number) ?? 0);
      const transparent = !!params.gifTransparent;

      const savedTime = timeRef.current;
      const savedPlaying = playingRef.current;

      setPlaying(false);
      offlineRenderingRef.current = true;
      forcedTerminalRef.current = nodeId;
      setRecording({ mode: "offline", label: "Preparing…", progress: 0 });

      const renderAt = async (frameIndex: number) => {
        const t = (startFrame + frameIndex) / exportFps;
        setTime(t);
        const backend = backendRef.current;
        renderFrameRef.current?.(t, exportFps, true);
        const settled = backend ? await awaitMediaSettle(backend.state) : false;
        if (settled) renderFrameRef.current?.(t, exportFps, true);
      };

      try {
        const { exportGif: runGifExport } = await import("@/lib/export-gif");
        const result = await runGifExport({
          canvas,
          fps: exportFps,
          durationFrames,
          colors,
          dither,
          lossy,
          transparent,
          renderFrame: renderAt,
          onProgress: (label, progress) =>
            setRecording({ mode: "offline", label, progress }),
        });
        downloadBlob(
          result.blob,
          base ? `${base}.${result.ext}` : defaultFilename(result.ext)
        );
      } catch (err) {
        console.error("GIF export failed:", err);
        flashToast(err instanceof Error ? err.message : "GIF export failed");
      } finally {
        offlineRenderingRef.current = false;
        forcedTerminalRef.current = null;
        setPlaying(savedPlaying);
        setTime(savedTime);
        setRecording(null);
      }
    },
    [getOutputParams, flashToast]
  );

  // Step the offline clock through a list of frames and hand the upstream
  // node's rendered pixels to a callback at each one — the Segment node's
  // bake driver. Same deterministic two-pass render as the offline
  // exporters (issue async media seeks, await settle, render again), but
  // reading a specific node's output instead of the canvas. The callback
  // may be slow (ML inference per frame) — the clock simply waits; return
  // false from it to stop early.
  const captureNodeFrames = useCallback(
    async (
      sourceNodeId: string,
      frames: number[],
      onFrame: (frame: number, blob: Blob) => Promise<boolean | void>
    ): Promise<void> => {
      const fps = fpsRef.current;
      const savedTime = timeRef.current;
      const savedPlaying = playingRef.current;
      setPlaying(false);
      offlineRenderingRef.current = true;
      try {
        for (const frame of frames) {
          const t = Math.max(0, frame) / Math.max(1, fps);
          setTime(t);
          const backend = backendRef.current;
          renderFrameRef.current?.(t, fps, true);
          const settled = backend
            ? await awaitMediaSettle(backend.state)
            : false;
          if (settled) renderFrameRef.current?.(t, fps, true);
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
          // Stable upstreams live in the eval cache; uncacheable ones
          // (Video/Webcam) only exist in the last pass's outputs map.
          const entry = evalCacheRef.current.get(sourceNodeId);
          const primary =
            entry?.output.primary ??
            lastEvalOutputsRef.current?.get(sourceNodeId)?.primary;
          if (!primary || primary.kind !== "image" || !backend) {
            throw new Error(
              "Couldn't read the upstream image — make the Segment node's chain visible on the canvas (set it or a downstream node Active), then retry."
            );
          }
          const blitCtx = backend.makeContext(0, 0);
          const tmp = document.createElement("canvas");
          tmp.width = primary.width;
          tmp.height = primary.height;
          blitCtx.blitToCanvas(primary, tmp);
          const blob = await new Promise<Blob | null>((res) =>
            tmp.toBlob((b) => res(b), "image/png")
          );
          if (!blob) throw new Error("Failed to read frame pixels.");
          const cont = await onFrame(frame, blob);
          if (cont === false) break;
        }
      } finally {
        offlineRenderingRef.current = false;
        setPlaying(savedPlaying);
        setTime(savedTime);
      }
    },
    []
  );

  // Resolve a Render Queue node into its ordered rows, each paired with the
  // Output node wired into the matching `item:<id>` socket (or null). Used by
  // both the batch runner and the param panel.
  const resolveQueueItems = useCallback((queueNodeId: string) => {
    const queue = nodesRef.current.find((n) => n.id === queueNodeId);
    if (!queue) return [];
    const items = (queue.data.params.items as RenderQueueItem[]) ?? [];
    return items.map((item) => {
      const edge = edgesRef.current.find(
        (e) =>
          e.target === queueNodeId &&
          e.targetHandle === `in:item:${item.id}`
      );
      const output = edge
        ? nodesRef.current.find((n) => n.id === edge.source) ?? null
        : null;
      return { item, output };
    });
  }, []);

  // Batch render: walk the queue's rows in order, render each connected
  // Output (video via exportVideo's sink, image via renderImageToBlobAtFrame),
  // and deliver per the node's `delivery` mode — sequential downloads, a
  // single zip, or streamed into a chosen folder (File System Access).
  const renderQueue = useCallback(
    async (queueNodeId: string) => {
      if (recordingRef.current || queueRenderingRef.current) return;
      const queue = nodesRef.current.find((n) => n.id === queueNodeId);
      if (!queue) return;
      const delivery =
        (queue.data.params.delivery as "sequential" | "zip" | "folder") ??
        "sequential";
      const resolved = resolveQueueItems(queueNodeId).filter((r) => r.output);
      if (resolved.length === 0) {
        flashToast("Render Queue is empty");
        return;
      }

      queueRenderingRef.current = true;

      // Folder mode: prompt for a destination directory up front. Native = OS
      // folder dialog; web = File System Access (Chromium only).
      let folder: FolderHandle | null = null;
      if (delivery === "folder") {
        if (!platform.isNative && !("showDirectoryPicker" in window)) {
          queueRenderingRef.current = false;
          flashToast("Folder mode needs a Chromium browser");
          return;
        }
        folder = await platform.pickSaveFolder();
        if (!folder) {
          // Cancelled (or unsupported on web, handled above).
          queueRenderingRef.current = false;
          return;
        }
      }

      const collected: { blob: Blob; name: string }[] = [];
      const usedNames = new Set<string>();
      const skipped: string[] = [];
      const total = resolved.length;
      try {
        for (let i = 0; i < resolved.length; i++) {
          const { item, output } = resolved[i];
          if (!output) continue;
          setQueueProgress({
            index: i,
            total,
            name: output.data.name ?? "output",
            nodeId: queueNodeId,
            itemId: item.id,
          });
          const p = output.data.params;
          const baseName =
            sanitizeFilename((p.filename as string) ?? "") ||
            (output.data.name ?? `item-${i + 1}`);

          const out: { blob: Blob | null; ext: string } = {
            blob: null,
            ext: "",
          };
          if (item.kind === "video") {
            await exportVideo(output.id, {
              sink: (b, e) => {
                out.blob = b;
                out.ext = e;
              },
            });
          } else {
            const r = await renderImageToBlobAtFrame(output.id, item.frame);
            if (r) {
              out.blob = r.blob;
              out.ext = r.ext;
            }
          }
          if (!out.blob) {
            // Render produced nothing (e.g. the offline encoder bailed). Record
            // it so the end-of-run toast reports the gap instead of silently
            // delivering a short batch.
            skipped.push(output.data.name ?? `item ${i + 1}`);
            continue;
          }

          // De-dupe filenames within the batch.
          let name = `${baseName}.${out.ext}`;
          let n = 2;
          while (usedNames.has(name)) name = `${baseName}-${n++}.${out.ext}`;
          usedNames.add(name);

          if (delivery === "folder" && folder) {
            await folder.writeFile(name, out.blob);
          } else if (delivery === "sequential") {
            downloadBlob(out.blob, name);
          } else {
            collected.push({ blob: out.blob, name });
          }
        }

        if (delivery === "zip" && collected.length) {
          setQueueProgress({
            index: total,
            total,
            name: "zipping…",
            nodeId: queueNodeId,
            itemId: null,
          });
          const JSZip = (await import("jszip")).default;
          const zip = new JSZip();
          for (const c of collected) zip.file(c.name, c.blob);
          const zipBlob = await zip.generateAsync({ type: "blob" });
          const zipName =
            sanitizeFilename((queue.data.name as string) ?? "") ||
            "render-queue";
          downloadBlob(zipBlob, `${zipName}.zip`);
        }
        const done = usedNames.size;
        flashToast(
          skipped.length
            ? `Rendered ${done}/${total} — ${skipped.length} failed: ${skipped.join(", ")}`
            : `Rendered ${done} item${done === 1 ? "" : "s"}`
        );
      } catch (err) {
        console.error("Render queue failed:", err);
        flashToast(err instanceof Error ? err.message : "Render queue failed");
      } finally {
        queueRenderingRef.current = false;
        forcedTerminalRef.current = null;
        setQueueProgress(null);
      }
    },
    [resolveQueueItems, exportVideo, renderImageToBlobAtFrame, flashToast]
  );

  const onOpenExportApp = useCallback(
    (outputNodeId: string) => {
      setExportApp({ outputNodeId });
    },
    []
  );

  // Run the full client-side export pipeline: build manifest, fetch the
  // pre-built export-template artifacts from public/, package into a zip,
  // trigger the browser download. All steps run in this tab; no server.
  const runExportApp = useCallback(
    async (args: { appName: string; description?: string }) => {
      const session = exportApp;
      if (!session) return;
      setExportAppBusy(true);
      try {
        const { manifest } = buildExportManifest({
          nodes: nodesRef.current,
          edges: edgesRef.current,
          appName: args.appName,
          description: args.description,
          outputNodeId: session.outputNodeId,
          canvasRes,
        });
        const graphJson = await serializeGraph(
          nodesRef.current,
          edgesRef.current,
          undefined,
          {
            loopFrames: loopFramesRef.current,
            fps: fpsRef.current,
            width: canvasResRef.current[0],
            height: canvasResRef.current[1],
          }
        );
        const distManifest = (await fetch(
          "/export-template/v1/manifest.json"
        ).then((r) => r.json())) as {
          built: boolean;
          reason?: string;
          distFiles: string[];
          sourceFiles: string[];
        };
        if (!distManifest.built) {
          throw new Error(
            "Export template not built. Run `npm run install:export-template && npm run build:export-template` and try again."
          );
        }
        const singleFileHtml = await fetch(
          "/export-template/v1/index.html"
        ).then((r) => r.text());
        const fetchAll = async (
          base: string,
          paths: string[]
        ): Promise<Record<string, string | Uint8Array>> => {
          const out: Record<string, string | Uint8Array> = {};
          await Promise.all(
            paths.map(async (p) => {
              const resp = await fetch(`${base}/${p}`);
              const isText =
                p.endsWith(".html") ||
                p.endsWith(".js") ||
                p.endsWith(".css") ||
                p.endsWith(".json") ||
                p.endsWith(".ts") ||
                p.endsWith(".tsx") ||
                p.endsWith(".md") ||
                p.endsWith(".svg");
              out[p] = isText
                ? await resp.text()
                : new Uint8Array(await resp.arrayBuffer());
            })
          );
          return out;
        };
        const [distFiles, sourceFiles] = await Promise.all([
          fetchAll("/export-template/v1/dist", distManifest.distFiles),
          fetchAll("/export-template/v1/source", distManifest.sourceFiles),
        ]);
        const { packageExportApp } = await import("@/lib/export-packager");
        const blob = await packageExportApp({
          appName: args.appName,
          description: args.description,
          manifest,
          graphJson,
          template: { singleFileHtml, distFiles, sourceFiles },
        });
        const slug =
          args.appName.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") ||
          "app";
        downloadBlob(blob, `${slug}.zip`);
        setExportApp(null);
      } catch (err) {
        console.error("Export App failed:", err);
        flashToast(
          err instanceof Error ? err.message : "Export App failed"
        );
      } finally {
        setExportAppBusy(false);
      }
    },
    [exportApp, canvasRes, flashToast]
  );

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (
        e as CustomEvent<{
          id: string;
          kind: "image" | "video" | "sequence" | "gif" | "app" | "queue";
        }>
      ).detail;
      if (!detail) return;
      if (detail.kind === "image") exportImage(detail.id);
      else if (detail.kind === "video") exportVideo(detail.id);
      else if (detail.kind === "sequence") exportSequence(detail.id);
      else if (detail.kind === "gif") exportGif(detail.id);
      else if (detail.kind === "app") onOpenExportApp(detail.id);
      else if (detail.kind === "queue") renderQueue(detail.id);
    };
    window.addEventListener("effect-node-export", handler);
    return () => window.removeEventListener("effect-node-export", handler);
  }, [exportImage, exportVideo, exportSequence, exportGif, onOpenExportApp, renderQueue]);

  // --- Save / Load ----------------------------------------------------------
  // Progress budget: serialize/deserialize gets the first 70%, the network
  // round-trip gets the tail. The upload/download step has no native
  // progress, so we hold at 70% until the call resolves then snap to 100%.
  const SERIALIZE_SHARE = 0.7;

  async function saveToRow(
    name: string,
    mode: "insert" | "update",
    existingId?: string
  ): Promise<{ id: string } | null> {
    const graph = await serializeGraph(
      nodesRef.current,
      edgesRef.current,
      (f) =>
        setProgressStatus({
          label: "saving",
          progress: f * SERIALIZE_SHARE,
          tone: "save",
        }),
      {
        loopFrames: loopFramesRef.current,
        fps: fpsRef.current,
        width: canvasResRef.current[0],
        height: canvasResRef.current[1],
      }
    );
    const canvas = canvasRef.current;
    const thumbnail = canvas ? generateThumbnail(canvas, 256) : null;
    setProgressStatus({ label: "saving", progress: SERIALIZE_SHARE, tone: "save" });
    if (mode === "update" && existingId) {
      const ok = await updateProjectRow(existingId, graph, thumbnail);
      if (!ok) return null;
      setProgressStatus({ label: "saving", progress: 1, tone: "save" });
      return { id: existingId };
    }
    const result = await saveProjectRow(name, graph, thumbnail);
    if (!result) return null;
    setProgressStatus({ label: "saving", progress: 1, tone: "save" });
    return result;
  }

  // Modal callback. Creates a NEW row by default; when the typed name
  // matches an existing project of the user's, overwrites that row
  // instead so "Untitled + Save" can't silently duplicate-then-
  // accumulate. The modal's button label reflects the current
  // collision state, so the user has already consented to either
  // branch by the time this runs.
  const handleSaveAsProject = useCallback(
    async (name: string) => {
      if (!signedIn || !user) throw new Error("Sign in to save projects.");
      const conflict = findConflict(name);
      try {
        if (conflict) {
          // Overwrite path — write the current graph into the
          // colliding row. updateProject leaves name + is_public
          // untouched, which is what we want: we're just replacing
          // the graph.
          const result = await saveToRow(name, "update", conflict.id);
          if (!result) {
            setSaveState("error");
            throw new Error("Save failed — check RLS policy / network.");
          }
          setCurrentProject({
            id: conflict.id,
            name: conflict.name,
            isPublic: conflict.is_public,
            publicSlug: conflict.public_slug,
            ownerId: user.id,
            authorName: null,
          });
          setSaveState("saved");
          setLoadRefreshKey((n) => n + 1);
          flashToast(`overwrote ${conflict.name}`);
          return;
        }
        const result = await saveToRow(name, "insert");
        if (!result) {
          setSaveState("error");
          throw new Error("Save failed — check RLS policy / network.");
        }
        setCurrentProject({
          id: result.id,
          name,
          isPublic: false,
          publicSlug: null,
          ownerId: user.id,
          authorName: null,
        });
        setSaveState("saved");
        setLoadRefreshKey((n) => n + 1);
        flashToast(`saved as ${name}`);
      } catch (err) {
        setSaveState("error");
        throw err;
      } finally {
        setProgressStatus(null);
      }
    },
    // saveToRow closes over refs, flashToast, and setters — all stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signedIn, user, findConflict, flashToast]
  );

  // Silent overwrite when we own the current row; forks a private copy
  // (name + "_copy") if we're on someone else's public project; falls
  // through to Save As if there's no row at all.
  //
  // Return value distinguishes the outcomes so callers that want to
  // chain behavior on a successful save (e.g. File → New) can: "saved"
  // and "failed" are immediate, "opened-modal" means the Save As modal
  // is now open and the actual save hasn't happened yet.
  const handleSave = useCallback(async (): Promise<
    "saved" | "opened-modal" | "failed" | "skipped"
  > => {
    if (!signedIn || !user) return "skipped";
    if (!currentProject) {
      setSaveModalOpen(true);
      return "opened-modal";
    }
    const isMine = currentProject.ownerId === user.id;
    if (!isMine) {
      // Copy-on-save: RLS would reject an update against someone
      // else's row anyway. Create our own private copy under a
      // derived name instead.
      const copyName = `${currentProject.name}_copy`;
      try {
        const result = await saveToRow(copyName, "insert");
        if (!result) {
          setSaveState("error");
          flashToast("save failed");
          return "failed";
        }
        setCurrentProject({
          id: result.id,
          name: copyName,
          isPublic: false,
          publicSlug: null,
          ownerId: user.id,
          authorName: null,
        });
        setSaveState("saved");
        setLoadRefreshKey((n) => n + 1);
        flashToast("saved a copy");
        return "saved";
      } catch (e) {
        // Surface the real reason — a thrown serialize/thumbnail error here
        // was previously swallowed, leaving only a bare "save failed".
        console.error("save failed (copy):", e);
        setSaveState("error");
        flashToast("save failed");
        return "failed";
      } finally {
        setProgressStatus(null);
      }
    }
    try {
      const result = await saveToRow(
        currentProject.name,
        "update",
        currentProject.id
      );
      if (result) {
        setSaveState("saved");
        flashToast("saved");
        setLoadRefreshKey((n) => n + 1);
        return "saved";
      }
      setSaveState("error");
      flashToast("save failed");
      return "failed";
    } catch (e) {
      // Surface the real reason — a thrown serialize/thumbnail error here was
      // previously swallowed, leaving only a bare "save failed" with no clue.
      console.error("save failed (update):", e);
      setSaveState("error");
      flashToast("save failed");
      return "failed";
    } finally {
      setProgressStatus(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, user, currentProject, flashToast]);

  // New row, name derived from the current one by incrementing any trailing
  // digits (foo → foo_01, foo_01 → foo_02, foo_99 → foo_100). Becomes the
  // new current project.
  const handleSaveIncremental = useCallback(async () => {
    if (!signedIn || !user || !currentProject) return;
    const newName = incrementName(currentProject.name);
    try {
      const result = await saveToRow(newName, "insert");
      if (!result) {
        setSaveState("error");
        flashToast("save failed");
        return;
      }
      // New rows are always owned by the current user (RLS requires
      // user_id = auth.uid() on insert) and default to private — even
      // when incrementing off someone else's public project.
      setCurrentProject({
        id: result.id,
        name: newName,
        isPublic: false,
        publicSlug: null,
        ownerId: user.id,
        authorName: null,
      });
      setSaveState("saved");
      setLoadRefreshKey((n) => n + 1);
      flashToast(`saved as ${newName}`);
    } catch {
      setSaveState("error");
    } finally {
      setProgressStatus(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, user, currentProject, flashToast]);

  const handleLoadProject = useCallback(
    async (id: string) => {
      try {
        setProgressStatus({ label: "loading", progress: 0.05, tone: "load" });
        const saved = await loadProjectRow(id);
        if (!saved) return;
        setProgressStatus({
          label: "loading",
          progress: 1 - SERIALIZE_SHARE,
          tone: "load",
        });
        pushGraph(getGraphSnapshot());
        const { nodes: nextNodes, edges: nextEdges, scene, missingMedia } =
          await deserializeGraph(
            saved.graph,
            (f) =>
              setProgressStatus({
                label: "loading",
                progress: 1 - SERIALIZE_SHARE + f * SERIALIZE_SHARE,
                tone: "load",
              })
          );
        setNodes(nextNodes);
        setEdges(nextEdges);
        setCurrentGroupId(defaultScopeFor(nextNodes));
        setMissingMedia(missingMedia);
        // Restore scene-level state (loop length, fps). Pre-v2 saves
        // omit `scene` entirely — leave the user's current values
        // untouched in that case. `loopFrames` can legitimately be
        // null (= no loop), so check for the key's presence rather
        // than truthiness.
        if (scene) {
          if ("loopFrames" in scene) setLoopFrames(scene.loopFrames ?? null);
          if (scene.fps !== undefined) setFps(scene.fps);
          if (scene.width !== undefined && scene.height !== undefined)
            setCanvasRes([scene.width, scene.height]);
        }
        setSelectedId(null);
        setParamView("node");
        setCurrentProject({
          id,
          name: saved.name,
          isPublic: saved.is_public,
          publicSlug: saved.public_slug,
          ownerId: saved.user_id,
          // Only bother carrying the author label when the viewer
          // doesn't own the row — own-project rename/toggle paths
          // don't need it.
          authorName:
            user && saved.user_id === user.id
              ? null
              : saved.author?.display_name ?? null,
        });
        // Load applies a graph snapshot via setNodes/setEdges, which
        // doesn't flow through pushGraph — so saveState isn't auto-
        // flipped to "dirty". Explicitly mark clean.
        setSaveState("saved");
        setProgressStatus({ label: "loading", progress: 1, tone: "load" });
      } finally {
        setProgressStatus(null);
      }
    },
    [pushGraph, getGraphSnapshot, setNodes, setEdges, user, setMissingMedia]
  );

  // --- Local .toolbox files (File → Save to File / Load…) ------------------
  // Self-contained project files, independent of the cloud. The base name of
  // the last opened/saved file so a round-trip keeps its name even though a
  // file-loaded project has no cloud row (currentProject stays null).
  const projectFileNameRef = useRef<string | null>(null);

  const sanitizeFileName = (name: string): string =>
    name.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "project";

  const handleSaveToFile = useCallback(async () => {
    try {
      setProgressStatus({ label: "saving", progress: 0.1, tone: "save" });
      const graph = await serializeGraph(
        nodesRef.current,
        edgesRef.current,
        (f) =>
          setProgressStatus({ label: "saving", progress: f * 0.8, tone: "save" }),
        {
          loopFrames: loopFramesRef.current,
          fps: fpsRef.current,
          width: canvasResRef.current[0],
          height: canvasResRef.current[1],
        }
      );
      const canvas = canvasRef.current;
      const thumbnailDataUrl = canvas ? generateThumbnail(canvas, 256) : null;
      const name =
        currentProject?.name ?? projectFileNameRef.current ?? "Untitled";
      const { writeProjectFile, TOOLBOX_EXTENSION } = await import(
        "@/lib/project-file"
      );
      const blob = await writeProjectFile({ name, graph, thumbnailDataUrl });
      setProgressStatus({ label: "saving", progress: 1, tone: "save" });
      projectFileNameRef.current = name;
      downloadBlob(blob, `${sanitizeFileName(name)}.${TOOLBOX_EXTENSION}`);
    } catch (e) {
      console.error("Save to file failed:", e);
      flashToast(e instanceof Error ? e.message : "Could not save project file");
    } finally {
      setProgressStatus(null);
    }
  }, [currentProject, flashToast]);

  // Relink-modal action. Two passes, both inside the click's user
  // activation:
  //   1. Stored file handles — silently granted ones read immediately;
  //      the rest pop the browser's lightweight re-grant prompt.
  //   2. Whatever's left gets one multi-select picker; picks are matched
  //      back to nodes by filename (+size when known).
  // Per-item results land back in `relinkItems` so the modal shows a
  // ✓ / ✕ next to every file. Cancelling the picker leaves untried items
  // "missing" (amber); items that were attempted but found no match read
  // "failed" (red). Both stay clickable for another attempt.
  const relinkBusyRef = useRef(false);
  const relinkMissingMedia = useCallback(async () => {
    if (relinkBusyRef.current) return;
    const pending = relinkItems.filter((i) => i.status !== "ok");
    if (pending.length === 0) return;
    relinkBusyRef.current = true;
    setRelinkBusy(true);
    try {
      const status = new Map<MissingMedia, RelinkStatus>(
        relinkItems.map((i) => [i.media, i.status])
      );
      let relinked = 0;
      const apply = async (m: MissingMedia, file: File): Promise<boolean> => {
        try {
          const value =
            m.envelope.kind === "video_file"
              ? await (await import("@/lib/video")).registerVideoFile(file)
              : await (await import("@/lib/audio")).registerAudioFile(file);
          onParamChange(m.nodeId, m.paramName, value);
          status.set(m, "ok");
          relinked++;
          return true;
        } catch (err) {
          console.warn(`Relink failed for ${m.envelope.filename}:`, err);
          status.set(m, "failed");
          return false;
        }
      };

      const remaining: MissingMedia[] = [];
      for (const i of pending) {
        const file = await readStoredMediaFile(i.media.envelope, {
          allowPrompt: true,
        });
        if (!(file && (await apply(i.media, file)))) remaining.push(i.media);
      }

      if (remaining.length > 0) {
        const kinds = new Set(remaining.map((m) => m.envelope.kind));
        const kind =
          kinds.size > 1
            ? ("media" as const)
            : kinds.has("video_file")
              ? ("video" as const)
              : ("audio" as const);
        let files = await pickMediaFiles({ kind, multiple: true });
        if (files === "unsupported") {
          files = await pickMediaFilesViaInput({ kind, multiple: true });
        }
        if (files && files.length > 0) {
          const matched = matchFilesToMissing(files, remaining);
          for (const m of remaining) {
            const f = matched.get(m);
            if (f) await apply(m, f);
            else status.set(m, "failed");
          }
        }
        // files === null / empty → picker cancelled: leave statuses as
        // they were so untried items stay "missing", not "failed".
      }

      setRelinkItems((prev) =>
        prev.map((i) => ({ ...i, status: status.get(i.media) ?? i.status }))
      );
      if (relinked > 0) {
        flashToast(
          `Relinked ${relinked} media file${relinked === 1 ? "" : "s"}`
        );
      }
    } catch (err) {
      // Belt-and-braces: every step above guards itself, but an
      // unexpected throw must not end as an invisible unhandled
      // rejection — that reads as "the button does nothing".
      console.error("Relink failed:", err);
      flashToast(err instanceof Error ? err.message : "Relink failed");
    } finally {
      relinkBusyRef.current = false;
      setRelinkBusy(false);
    }
  }, [relinkItems, onParamChange, flashToast]);

  // Load a .toolbox File into the editor. Shared by the OS Open dialog / file
  // input and by the desktop "Local" recents tab.
  const loadToolboxFile = useCallback(
    async (file: File) => {
      try {
        setProgressStatus({ label: "loading", progress: 0.1, tone: "load" });
        const { readProjectFile } = await import("@/lib/project-file");
        const { name, graph } = await readProjectFile(file);
        pushGraph(getGraphSnapshot());
        const { nodes: nextNodes, edges: nextEdges, scene, missingMedia } =
          await deserializeGraph(graph, (f) =>
            setProgressStatus({
              label: "loading",
              progress: 0.1 + f * 0.9,
              tone: "load",
            })
          );
        suppressNextSelectionViewFlipRef.current = true;
        setNodes(nextNodes);
        setEdges(nextEdges);
        setCurrentGroupId(defaultScopeFor(nextNodes));
        setMissingMedia(missingMedia);
        if (scene) {
          if ("loopFrames" in scene) setLoopFrames(scene.loopFrames ?? null);
          if (scene.fps !== undefined) setFps(scene.fps);
          if (scene.width !== undefined && scene.height !== undefined)
            setCanvasRes([scene.width, scene.height]);
        }
        setSelectedId(null);
        setParamView("node");
        // A file-loaded project has no cloud row — cloud Save falls through
        // to Save As. Remember the name for the next Save to File.
        setCurrentProject(null);
        projectFileNameRef.current =
          file.name.replace(/\.toolbox$/i, "") || name;
        setSaveState("saved");
        setProgressStatus({ label: "loading", progress: 1, tone: "load" });
      } catch (e) {
        console.error("Open project file failed:", e);
        flashToast(e instanceof Error ? e.message : "Could not open project file");
      } finally {
        setProgressStatus(null);
      }
    },
    [pushGraph, getGraphSnapshot, setNodes, setEdges, flashToast, setMissingMedia]
  );

  const handleOpenProjectFile = useCallback(() => {
    // Native: OS Open dialog. Web: <input type="file">.
    if (platform.isNative) {
      void platform.pickOpenFiles({ kind: "toolbox" }).then((files) => {
        const file = files?.[0];
        if (file) void loadToolboxFile(file);
      });
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".toolbox,application/zip";
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void loadToolboxFile(file);
    };
    input.click();
  }, [loadToolboxFile]);

  // Open a recent local .toolbox (desktop "Local" tab) by its stored path.
  const handleOpenLocalRecent = useCallback(
    async (p: string) => {
      const res = await platform.recents?.open(p);
      if (!res) {
        flashToast("Couldn't open — the file may have moved or been deleted.");
        return;
      }
      const name = res.name.toLowerCase().endsWith(".toolbox")
        ? res.name
        : `${res.name}.toolbox`;
      await loadToolboxFile(new File([res.bytes], name, { type: "application/zip" }));
    },
    [loadToolboxFile, flashToast]
  );

  // Rename via the file-name pill. If the target name doesn't collide,
  // it's a simple metadata update. If it DOES collide with another of
  // the user's projects, we interpret the click — which the pill has
  // already relabeled "Overwrite" — as "take over that name": write
  // the current graph into the colliding row, point the pill at it,
  // and delete the abandoned source row so there aren't two rows with
  // the same name.
  const handleRenameProject = useCallback(
    async (next: string) => {
      if (!signedIn || !user || !currentProject) return;
      if (currentProject.ownerId !== user.id) return;
      const trimmed = next.trim();
      if (!trimmed || trimmed === currentProject.name) return;
      const conflict = findConflict(trimmed, currentProject.id);
      if (conflict) {
        // Overwrite flow: serialize current graph into the target row.
        // Reuse the save-progress banner so the UX matches a save.
        try {
          const ok = await saveToRow(trimmed, "update", conflict.id);
          if (!ok) {
            setSaveState("error");
            flashToast("overwrite failed");
            return;
          }
          // Best-effort: drop the source row so the user doesn't end
          // up with duplicate entries. RLS scopes this to own rows,
          // which it has to be for the rename-in-pill to be available
          // in the first place.
          await deleteProjectRow(currentProject.id);
          setCurrentProject({
            id: conflict.id,
            name: conflict.name,
            isPublic: conflict.is_public,
            publicSlug: conflict.public_slug,
            ownerId: user.id,
            authorName: null,
          });
          setSaveState("saved");
          setLoadRefreshKey((n) => n + 1);
          flashToast(`overwrote ${conflict.name}`);
        } catch {
          setSaveState("error");
        } finally {
          setProgressStatus(null);
        }
        return;
      }
      const ok = await renameProjectRow(currentProject.id, trimmed);
      if (!ok) {
        setSaveState("error");
        flashToast("rename failed");
        return;
      }
      setCurrentProject({ ...currentProject, name: trimmed });
      setLoadRefreshKey((n) => n + 1);
      flashToast(`renamed to ${trimmed}`);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signedIn, user, currentProject, findConflict, flashToast]
  );

  // Visibility toggle: guard on ownership (RLS would reject otherwise)
  // then open the confirm modal. The actual DB write lands inside
  // handleConfirmVisibility after the user OKs the direction.
  const handleRequestToggleVisibility = useCallback(
    (next: boolean) => {
      if (!currentProject || !user) return;
      if (currentProject.ownerId !== user.id) return;
      setPendingVisibility({ toPublic: next });
    },
    [currentProject, user]
  );

  const handleConfirmVisibility = useCallback(async () => {
    if (!pendingVisibility || !currentProject || !user) {
      setPendingVisibility(null);
      return;
    }
    if (currentProject.ownerId !== user.id) {
      setPendingVisibility(null);
      return;
    }
    const next = pendingVisibility.toPublic;
    const result = await setProjectVisibilityRow(currentProject.id, next);
    if (!result.ok) {
      setSaveState("error");
      flashToast("visibility update failed");
      setPendingVisibility(null);
      return;
    }
    setCurrentProject({
      ...currentProject,
      isPublic: next,
      // The toggle return surfaces the slug (minted on first
      // public-flip, cleared on private-flip) so the file-name menu's
      // "Copy editor link" button lights up immediately, no reload.
      publicSlug: result.slug,
    });
    flashToast(next ? "now public" : "now private");
    setLoadRefreshKey((n) => n + 1);
    setPendingVisibility(null);
  }, [pendingVisibility, currentProject, user, flashToast]);

  // ----------------------------------------------------------------------
  // Private-project list refresh
  //
  // Warms the list cache on sign-in and whenever `loadRefreshKey`
  // bumps (every save / rename / visibility / delete invalidates
  // the shared cache and bumps that key). Feeds `findConflict`
  // above so the Save As modal and file-name pill can relabel their
  // buttons synchronously as the user types.
  // ----------------------------------------------------------------------

  useEffect(() => {
    if (!signedIn) {
      setPrivateRows([]);
      return;
    }
    let cancelled = false;
    listPrivateProjects().then((rows) => {
      if (!cancelled) setPrivateRows(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [signedIn, loadRefreshKey]);

  // ----------------------------------------------------------------------
  // File → New
  // ----------------------------------------------------------------------

  const [newConfirmOpen, setNewConfirmOpen] = useState(false);
  // When true, a successful Save As (from SaveModal) will be chained
  // into resetToFreshProject. Cleared if the save modal is cancelled.
  const [pendingNewAfterSave, setPendingNewAfterSave] = useState(false);

  const resetToFreshProject = useCallback(() => {
    // Seed a new graph from scratch — don't reuse the module-level
    // STARTER directly since its node IDs were frozen at import time;
    // building fresh gives unique IDs. Open inside Layer 1 so a new
    // project feels exactly like the pre-layers app.
    const fresh = buildStarterGraph();
    // Suppress the echo-selection-change paramView flip, same rule
    // as File → Load / Project Settings.
    suppressNextSelectionViewFlipRef.current = true;
    setNodes(fresh.nodes);
    setEdges(fresh.edges);
    setCurrentGroupId(fresh.layerId);
    setSelectedId(null);
    setParamView("node");
    setCurrentProject(null);
    projectFileNameRef.current = null;
    setSaveState("saved");
    // Drop any survival snapshot from a prior session — otherwise a
    // docs round-trip after File → New would resurrect the graph
    // the user explicitly walked away from.
    clearEditorSession();
  }, [setNodes, setEdges]);

  const handleNewProject = useCallback(() => {
    // Nothing to lose — skip the confirm.
    if (saveState === "saved") {
      resetToFreshProject();
      return;
    }
    setNewConfirmOpen(true);
  }, [saveState, resetToFreshProject]);
  // Mirrored on a ref so the early-mounted keydown handler (Cmd+N) can
  // call the latest closure without recreating the listener every time
  // saveState changes.
  const handleNewProjectRef = useRef(handleNewProject);
  handleNewProjectRef.current = handleNewProject;

  const handleNewConfirmSave = useCallback(async () => {
    if (!signedIn || !user) {
      // Saving isn't possible — treat Save as Don't Save so the user
      // isn't stuck. The confirm modal already hides the Save button
      // in this case, but guard here too in case of a race.
      setNewConfirmOpen(false);
      resetToFreshProject();
      return;
    }
    if (!currentProject) {
      // No row yet — hand off to the Save As modal. After that save
      // resolves, the wrapped onSave handler fires resetToFreshProject
      // via pendingNewAfterSave.
      setPendingNewAfterSave(true);
      setNewConfirmOpen(false);
      setSaveModalOpen(true);
      return;
    }
    const outcome = await handleSave();
    if (outcome === "saved") {
      setNewConfirmOpen(false);
      resetToFreshProject();
    }
    // On "failed" we leave the confirm modal open so the user can
    // retry or choose Don't Save / Cancel.
  }, [
    signedIn,
    user,
    currentProject,
    handleSave,
    resetToFreshProject,
  ]);

  const handleNewConfirmDiscard = useCallback(() => {
    setNewConfirmOpen(false);
    resetToFreshProject();
  }, [resetToFreshProject]);

  // Wraps the normal Save As handler so the pending-new flow can
  // chain reset after a successful save. For the regular Save As
  // menu path, pendingNewAfterSave is always false — wrapper is a
  // pass-through.
  const handleSaveAsWithMaybeReset = useCallback(
    async (name: string) => {
      await handleSaveAsProject(name);
      // Only reached on success — handleSaveAsProject throws on
      // failure, surfacing the error in SaveModal.
      if (pendingNewAfterSave) {
        setPendingNewAfterSave(false);
        resetToFreshProject();
      }
    },
    [handleSaveAsProject, pendingNewAfterSave, resetToFreshProject]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key !== "s" && e.key !== "S") return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;
      e.preventDefault();
      if (!signedIn) return;
      if (e.shiftKey) setSaveModalOpen(true);
      else handleSave();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [signedIn, handleSave]);

  // Cmd/Ctrl + C / V — internal node clipboard. Deliberately defers to the
  // browser when the user is focused in a text field so native copy-paste
  // of textarea content (e.g. the Text node's string param) still works.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.shiftKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;
      if (e.key === "c" || e.key === "C") {
        e.preventDefault();
        handleCopyNodes();
      }
      // Cmd+V is handled by a `paste` event listener in NodeEditor so
      // we can inspect the clipboard contents: OS-clipboard files
      // become source nodes, otherwise the internal node clipboard
      // pastes as before.
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleCopyNodes]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || !e.shiftKey) return;
      if (e.key !== "C" && e.key !== "c") return;
      // Avoid clobbering text-field copy in inputs/textareas.
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;
      e.preventDefault();
      copyImageToClipboard();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [copyImageToClipboard]);

  const isParamDriven = useCallback(
    (nodeId: string, paramName: string) => {
      const start = edges.find((e) => {
        if (e.target !== nodeId) return false;
        const parsed = parseTargetHandleKind(e.targetHandle ?? "");
        return parsed?.kind === "param" && parsed.name === paramName;
      });
      if (!start) return false;
      // Resolve through group boundaries the same way the flatten pass
      // does: a wire from a Group Input (or a group shell's output)
      // only drives the param when the chain reaches a real producer.
      // A dead end (shell socket unwired outside, group output unwired
      // inside) means the stored param value is live — not driven.
      let cur = start;
      for (let hops = 0; hops <= edges.length; hops++) {
        const src = nodes.find((n) => n.id === cur.source);
        if (!src) return false;
        const auxName = cur.sourceHandle?.startsWith("out:aux:")
          ? cur.sourceHandle.slice("out:aux:".length)
          : null;
        if (src.data.defType === GROUP_INPUT_TYPE) {
          const shellId = src.data.parentId;
          const outer =
            auxName && shellId
              ? edges.find(
                  (e) =>
                    e.target === shellId && e.targetHandle === `in:${auxName}`
                )
              : undefined;
          if (!outer) return false;
          cur = outer;
          continue;
        }
        if (src.data.defType === GROUP_TYPE) {
          const groupOutput = nodes.find(
            (n) =>
              n.data.parentId === src.id &&
              n.data.defType === GROUP_OUTPUT_TYPE
          );
          const inner =
            auxName && groupOutput
              ? edges.find(
                  (e) =>
                    e.target === groupOutput.id &&
                    e.targetHandle === `in:${auxName}`
                )
              : undefined;
          if (!inner) return false;
          cur = inner;
          continue;
        }
        return true;
      }
      return true;
    },
    [edges, nodes]
  );

  const onPlayPause = useCallback(() => {
    setPlaying((p) => !p);
  }, []);
  const onReset = useCallback(() => {
    setTime(0);
  }, []);
  const onSeek = useCallback((t: number) => {
    setTime(Math.max(0, t));
  }, []);
  const onScrubStart = useCallback(() => {
    setScrubbing(true);
  }, []);
  const onScrubEnd = useCallback(() => {
    setScrubbing(false);
  }, []);

  // Paint input is gated on SELECTION. The overlay is visually invisible —
  // strokes only appear through the pipeline as rendered by the ACTIVE node,
  // so you can paint and see the end-of-chain result live.
  const activePaintNode = selectedId
    ? nodes.find(
        (n) => n.id === selectedId && n.data.defType === "paint"
      )
    : undefined;

  // 3D orbit viewport binding (M1b). Active when the selection is a Scene
  // Render, or a 3D node (object3d/camera output) that feeds one — in which
  // case we bind to the nearest downstream Scene Render. Drives both the
  // preview-eval retarget (so the scene publishes) and the overlay mount.
  const active3DSceneRenderId = useMemo<string | null>(() => {
    if (!selectedId) return null;
    const sel = nodes.find((n) => n.id === selectedId);
    if (!sel) return null;
    if (sel.data.defType === "scene-render") return sel.id;
    const out = getNodeDef(sel.data.defType)?.primaryOutput;
    if (out !== "object3d" && out !== "camera") return null;
    // BFS forward along edges to the nearest Scene Render.
    const adj = new Map<string, string[]>();
    for (const e of edges) {
      const arr = adj.get(e.source);
      if (arr) arr.push(e.target);
      else adj.set(e.source, [e.target]);
    }
    const seen = new Set<string>([selectedId]);
    let frontier = [selectedId];
    while (frontier.length) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const t of adj.get(id) ?? []) {
          if (seen.has(t)) continue;
          seen.add(t);
          const tn = nodes.find((n) => n.id === t);
          if (tn?.data.defType === "scene-render") return tn.id;
          next.push(t);
        }
      }
      frontier = next;
    }
    return null;
  }, [selectedId, nodes, edges]);
  viewport3DTargetRef.current = active3DSceneRenderId;

  // The Camera node wired into the bound Scene Render's camera input (if
  // it's a camera-3d we can drive its params from the viewport). Null when
  // nothing/an unsupported source is wired → viewport's look-through is
  // then view-only.
  const active3DCameraNodeId = useMemo<string | null>(() => {
    if (!active3DSceneRenderId) return null;
    const e = edges.find(
      (e) => e.target === active3DSceneRenderId && e.targetHandle === "in:camera"
    );
    if (!e) return null;
    const src = nodes.find((n) => n.id === e.source);
    return src?.data.defType === "camera-3d" ? src.id : null;
  }, [active3DSceneRenderId, edges, nodes]);

  // Transform-gizmo target: the selected node, when it's a 3D object with
  // writable transform params (primitives have pos+rot; lights have pos).
  // Scene Merge (no transform params) and cameras are excluded.
  const active3DGizmo = useMemo<{
    id: string | null;
    canRotate: boolean;
    canScale: boolean;
  }>(() => {
    const none = { id: null, canRotate: false, canScale: false };
    if (!selectedId || !active3DSceneRenderId) return none;
    const n = nodes.find((nn) => nn.id === selectedId);
    if (!n) return none;
    const def = getNodeDef(n.data.defType);
    if (def?.primaryOutput !== "object3d") return none;
    const hasPos = def.params.some((p) => p.name === "pos_x");
    if (!hasPos) return none;
    return {
      id: selectedId,
      canRotate: def.params.some((p) => p.name === "rot_x"),
      canScale: def.params.some((p) => p.name === "scale_x"),
    };
  }, [selectedId, active3DSceneRenderId, nodes]);

  // Show the pivot gizmo for any selected node whose definition opts in via
  // `supportsTransformGizmo` and exposes the expected param names. Today
  // that's Transform and SVG Source; Text and Auto Layout use the bounds
  // gizmo instead (PRIMITIVE_GIZMO_ADAPTERS), which resizes against an
  // anchored opposite edge rather than scaling around a pivot.
  const activeTransformNode = selectedId
    ? nodes.find((n) => {
        if (n.id !== selectedId) return false;
        const def = getNodeDef(n.data.defType);
        return !!def?.supportsTransformGizmo;
      })
    : undefined;

  // On-canvas shape handles for a selected spline primitive (Circle,
  // Rectangle, …). Driven by the adapter map so new primitives opt in
  // there without touching this wiring.
  const activePrimitiveNode = selectedId
    ? nodes.find(
        (n) =>
          n.id === selectedId &&
          !!PRIMITIVE_GIZMO_ADAPTERS[n.data.defType]
      )
    : undefined;

  // Pen-tool overlay: active whenever a Spline Draw node is selected.
  const activeSplineNode = selectedId
    ? nodes.find(
        (n) => n.id === selectedId && n.data.defType === "spline-draw"
      )
    : undefined;

  // Gradient handle overlay: active for a selected Gradient node in linear,
  // radial, or multipoint mode (polar/wave have no positional handles yet).
  const activeGradientNode = selectedId
    ? nodes.find((n) => {
        if (n.id !== selectedId || n.data.defType !== "gradient") return false;
        const m = (n.data.params.mode as string) ?? "linear";
        if (m === "linear" || m === "radial" || m === "multipoint") return true;
        // The radial ring wave gets a draggable center handle.
        return (
          m === "wave" &&
          ((n.data.params.wave_mode as string) ?? "linear") === "ring"
        );
      })
    : undefined;

  // The spline to show in the pen-tool overlay at the current playhead. When
  // "Path Animation" is keyframed, that's the interpolated shape (so the
  // editor handles sit on the rendered/animated curve and on-canvas edits
  // branch from what's displayed — autokey then writes a keyframe here);
  // otherwise the stored constant.
  const activeSplineValue: SplineParamValue | null = (() => {
    if (!activeSplineNode) return null;
    const stored =
      (activeSplineNode.data.params.spline as SplineParamValue | undefined) ?? {
        subpaths: [{ anchors: [], closed: false }],
      };
    const block = activeSplineNode.data.animation?.spline;
    if (block && block.animated && block.keyframes.length > 0) {
      const v = evaluateKeyframesAt(block, "spline_anchors", currentTick);
      if (v) return v as SplineParamValue;
    }
    return stored;
  })();

  // Dot-prompt overlay: active whenever a Segment Anything node in dots
  // mode is selected (the auto modes are point-free). Clicks place/remove
  // dots; each edit re-runs the live (single-frame) segmentation against
  // the upstream image.
  const activeSegmentNode = selectedId
    ? nodes.find(
        (n) =>
          n.id === selectedId &&
          n.data.defType === "segment-anything" &&
          ((n.data.params.mode as string) ?? "dots") === "dots"
      )
    : undefined;

  // WebGPU Particle Test (Phase 0 spike). Presence-driven: the overlay
  // mounts whenever any node of this type exists in the graph, no
  // selection required. We only support one at a time — extras would
  // need their own canvases.
  const webgpuParticleTest = useMemo(
    () => nodes.find((n) => n.data.defType === "webgpu-particle-test"),
    [nodes]
  );

  // Preview dots for any selected node whose primary output is a points
  // value. Populated by the pipeline-eval effect after each render pass.
  // Stored as the typed-array PointsValue (not a materialized Point[])
  // so PointsOverlay can read positions without a per-frame alloc.
  const [selectedPoints, setSelectedPoints] = useState<PointsValue | null>(
    null
  );

  // ---------------------------------------------------------------------
  // Shared building blocks for the layouts.
  //
  // The two layouts (default + timeline) need the same NodeEditor,
  // ParamPanel, dock body, and PlaybackBar — extracting them here keeps
  // a single source of truth for the props each receives so the
  // layouts only differ in how the pieces are arranged on screen.
  // ---------------------------------------------------------------------
  const nodeEditorJsx = (
    <NodeEditor
      nodes={scopedNodes}
      edges={edges}
      onNodesChange={onNodesChangeWithHistory}
      onEdgesChange={onEdgesChangeWithHistory}
      onConnect={onConnect}
      onSelectNode={(id) => {
        if (suppressNextSelectionViewFlipRef.current) {
          suppressNextSelectionViewFlipRef.current = false;
          return;
        }
        setSelectedId(id);
        if (id) setParamView("node");
      }}
      onAddNode={onAddNode}
      onPanePointer={(p) => {
        lastPanePointerRef.current = p;
      }}
      onDuplicateOnDrag={handleDuplicateOnDrag}
      onDetachNode={handleDetachNode}
      onDuplicateNode={handleDuplicateNode}
      onDuplicateSelection={handleDuplicateSelection}
      onMergeSelection={handleMergeSelection}
      onCopyNodes={handleCopyNodes}
      onPasteNodes={handlePasteNodes}
      onAddFileNode={onAddFileNode}
      onAddImageNodeFromImageGen={onAddImageNodeFromImageGen}
      onCombineWires={handleCombineWires}
      onCutWires={handleCutWires}
      onSpliceNode={handleSpliceNode}
      onWaypointDragStart={handleWaypointDragStart}
      onWaypointDrag={handleWaypointDrag}
      onGroupSelection={handleGroupSelection}
      onUngroupSelection={handleUngroupSelection}
      onDiveIntoGroup={handleDiveIntoGroup}
      onScopeUp={handleScopeUp}
      breadcrumbs={breadcrumbs}
      onNavigateScope={(id) => navigateScope(id ?? undefined)}
      atRoot={currentGroupId == null}
      viewportOverlay={
        inspectIds.length > 0
          ? inspectIds.map((id) => {
              const n = nodes.find((x) => x.id === id);
              if (!n) return null;
              void inspectTick;
              return (
                <NodeInspectorPopup
                  key={`inspect-${id}`}
                  node={n}
                  snapshot={inspectSnapshotsRef.current.get(id)}
                />
              );
            })
          : null
      }
    />
  );

  // Single 0..1 fraction for the queue item currently rendering. Offline
  // encoders (WebCodecs / ffmpeg) report it per frame via `recording`.
  // Realtime MediaRecorder captures report nothing, but they play the
  // timeline live — the app re-renders every frame — so elapsed wall time
  // over the capture window is exact (the playhead itself can wrap when
  // the project loop is shorter than the capture, so don't use `time`).
  const queueItemProgress = !queueProgress
    ? null
    : recording?.mode === "offline"
      ? recording.progress
      : recording?.mode === "live"
        ? Math.min(
            1,
            (performance.now() - recording.startedAt) /
              1000 /
              Math.max(recording.totalSec, 1e-3)
          )
        : null;

  // Mirror the batch state to the canvas: EffectNode draws inline per-row
  // progress bars on Render Queue nodes. Event-based (like `node-timings`)
  // so node components don't need new props threaded through React Flow.
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("render-queue-progress", {
        detail: queueProgress
          ? {
              nodeId: queueProgress.nodeId,
              activeItemId: queueProgress.itemId,
              itemProgress: queueItemProgress,
            }
          : null,
      })
    );
  }, [queueProgress, queueItemProgress]);

  const paramPanelJsx = (
    <ParamPanel
      nodes={nodes}
      selectedId={selectedId}
      mode={paramView}
      canvasRes={canvasRes}
      onCanvasResChange={setCanvasRes}
      fps={fps}
      onFpsChange={setFps}
      onParamChange={onParamChange}
      onConvertToEditable={convertSvgToEditable}
      onToggleParamExposed={onToggleParamExposed}
      onToggleParamControl={onToggleParamControl}
      onExportApp={onOpenExportApp}
      onParamRangeChange={onParamRangeChange}
      onToggleParamLink={onToggleParamLink}
      isParamDriven={isParamDriven}
      currentTick={currentTick}
      getAnimation={getAnimation}
      onAnimationChange={onAnimationChange}
      onSeekTick={(tick) => onSeek(tick / (fps * ticksPerFrame))}
      onRenameNode={handleRenameNode}
      onRenameGroupSocket={handleRenameGroupSocket}
      onRemoveGroupSocket={handleRemoveGroupSocket}
      signedIn={signedIn}
      currentUserId={user?.id ?? null}
      onLoadProject={handleLoadProject}
      onLoadLocal={handleOpenLocalRecent}
      loadRefreshKey={loadRefreshKey}
      projectId={currentProject?.id ?? null}
      edges={edges}
      getRefImageBlob={getRefImageBlob}
      captureNodeFrames={captureNodeFrames}
      sceneFrames={
        loopFrames != null && loopFrames > 0 ? loopFrames : fps * 5
      }
      queueRender={
        queueProgress
          ? {
              nodeId: queueProgress.nodeId,
              activeItemId: queueProgress.itemId,
              itemProgress: queueItemProgress,
            }
          : null
      }
      onSelectNode={(nodeId) => {
        setNodes((prev) =>
          prev.map((n) => ({ ...n, selected: n.id === nodeId }))
        );
        setSelectedId(nodeId);
        setParamView("node");
      }}
    />
  );

  // The body of the dock — the toolbar with tab buttons and the
  // active editor (Tracks or Graph). Used both as the absolute-
  // positioned overlay in the default layout and as the bottom strip
  // in the timeline layout. The wrapping container differs between
  // layouts so its `flexShrink: 0` lives outside this fragment.
  const dockBodyJsx = (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          // Equal margin on all sides around the buttons.
          padding: 6,
          background: "#000",
          borderBottom: "1px solid #27272a",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <DockTabToggle value={dockTab} onChange={setDockTab} />
          {dockTab !== "graph" && (
            <StaggerControl ticksPerFrame={ticksPerFrame} />
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {dockTab === "tracks" && (
            <>
              <DockButton
                active={tracksSelectedOnly}
                onClick={() => setTracksSelectedOnly((v) => !v)}
                title={
                  tracksSelectedOnly
                    ? "Showing tracks for selected nodes only — click to show all"
                    : "Show tracks only for nodes selected in the node editor"
                }
              >
                selected only
              </DockButton>
              <DockButton
                onClick={() => setTrackFitVersion((v) => v + 1)}
                title="Fit scene to width"
              >
                fit
              </DockButton>
            </>
          )}
          {dockTab === "graph" && (
            <>
              <DockButton
                active={graphNormalizeY}
                onClick={() => setGraphNormalizeY((v) => !v)}
                title={
                  graphNormalizeY
                    ? "Normalize on — y-axis fits each curve to its own range"
                    : "Normalize off — y-axis uses the parameter's declared range"
                }
              >
                normalize
              </DockButton>
              <DockButton
                onClick={() => setGraphRefitVersion((v) => v + 1)}
                title="Refresh: re-fit y-axis to current keyframes"
              >
                ↻
              </DockButton>
            </>
          )}
          {!timelineLayout && (
            <DockButton onClick={() => setTrackEditorOpen(false)} title="Close">
              ▼
            </DockButton>
          )}
        </div>
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {dockTab === "layers" ? (
          <LayersEditor
            layers={layerChain}
            timeline={projectTimeline}
            currentTick={currentTick}
            selectedId={selectedId}
            onScrub={(tick) => onSeek(tick / (fps * ticksPerFrame))}
            onClipChange={onClipChange}
            onSelectLayer={handleSelectLayer}
            onDiveLayer={handleDiveIntoGroup}
            onToggleVisibility={handleToggleLayerVisibility}
            onReorder={handleReorderLayers}
            onAddLayer={handleAddLayerFromEditor}
            onSplitLayer={handleSplitLayer}
            nodes={nodes}
            edges={edges}
            getAnimation={getAnimation}
            onAnimationChange={onAnimationChange}
            fitVersion={trackFitVersion}
          />
        ) : dockTab === "tracks" ? (
          <TrackEditor
            // Scope-follow: Tracks shows only the nodes in the scope the
            // node editor is currently viewing (the layer/group you've
            // dived into), so the two stay coherent. Layer nodes are
            // excluded — the Layers tab owns them (their opacity
            // keyframes live in the per-layer twirl-down there). The
            // "selected only" filter applies on top.
            nodes={(() => {
              const scoped = nodes.filter(
                (n) =>
                  n.data.parentId === currentGroupId &&
                  n.data.defType !== LAYER_TYPE
              );
              return tracksSelectedOnly
                ? scoped.filter((n) => n.selected)
                : scoped;
            })()}
            allNodes={nodes}
            edges={edges}
            timeline={projectTimeline}
            currentTick={currentTick}
            playing={playing}
            onScrub={(tick) => onSeek(tick / (fps * ticksPerFrame))}
            onAnimationChange={onAnimationChange}
            onClipChange={onClipChange}
            fitVersion={trackFitVersion}
            collapsedNodeIds={collapsedTrackNodes}
            onToggleCollapsed={(nodeId) =>
              setCollapsedTrackNodes((prev) => {
                const next = new Set(prev);
                if (next.has(nodeId)) next.delete(nodeId);
                else next.add(nodeId);
                return next;
              })
            }
            onSelectNode={(nodeId) => {
              setNodes((prev) =>
                prev.map((n) => ({ ...n, selected: n.id === nodeId }))
              );
              setSelectedId(nodeId);
              setParamView("node");
            }}
          />
        ) : (
          <GraphEditor
            // Not scope-filtered: the graph view is a global curve
            // pinboard — a track is shown only when its `graphVisible`
            // flag is on, which the user sets explicitly. This also
            // surfaces a group's promoted params (keyframes live on deep
            // interior nodes outside the current scope).
            nodes={nodes}
            timeline={projectTimeline}
            currentTick={currentTick}
            onAnimationChange={onAnimationChange}
            onScrub={(tick) => onSeek(tick / (fps * ticksPerFrame))}
            normalizeY={graphNormalizeY}
            refitVersion={graphRefitVersion}
          />
        )}
      </div>
    </>
  );

  const playbackBarJsx = !fullCanvas && (
    <PlaybackBar
      playing={playing}
      time={time}
      fps={fps}
      loopFrames={loopFrames}
      onPlayPause={onPlayPause}
      onReset={onReset}
      onSeek={onSeek}
      onScrubStart={onScrubStart}
      onScrubEnd={onScrubEnd}
      onLoopFramesChange={setLoopFrames}
      tracksOpen={trackEditorOpen}
      onToggleTracks={
        timelineLayout
          ? undefined
          : () => setTrackEditorOpen((o) => !o)
      }
    />
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        // 100dvh tracks the *visible* viewport — on iPad Safari the
        // URL bar shrinks the viewport when shown, and 100vh would
        // park the bottom of the timeline below the address bar. dvh
        // re-evaluates as the bar shows/hides. Falls back to 100vh on
        // browsers that don't support dvh (none of the current iPad
        // Safari versions, but the inline @supports keeps older
        // engines unbroken).
        height: "100dvh",
        // Tailwind doesn't generate a dvh utility under our config;
        // inline-style fallback for max breadth.
        width: "100%",
        background: "#000",
        color: "#e5e7eb",
        fontFamily: "ui-monospace, monospace",
        fontSize: 12,
      }}
    >
      <div style={{ display: fullCanvas ? "none" : "contents" }}>
      <div
        onTransitionEnd={(e) => {
          // Slide-in finished → remove the transform so no stacking
          // context lingers to trap the menu dropdowns.
          if (e.propertyName === "transform" && !showLanding) {
            setMenuSettled(true);
          }
        }}
        style={{
          flexShrink: 0,
          // Slide the menu bar in from offscreen-top once the landing
          // gateway is dismissed. While the landing is up it sits just
          // above the viewport; its layout slot is always reserved so
          // the editor below never shifts when it arrives. Once settled
          // the transform is dropped entirely (see menuSettled).
          transform: showLanding
            ? "translateY(-110%)"
            : menuSettled
              ? undefined
              : "translateY(0)",
          transition: "transform 380ms cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      >
      <MenuBar
        onUndo={undo}
        onRedo={redo}
        canUndo={canUndo}
        canRedo={canRedo}
        onOpenProjectSettings={() => {
          // Deselect so switching back to the node view doesn't silently
          // resurrect whichever node happened to be selected when the
          // user opened Project Settings. Clear React Flow's per-node
          // `.selected` flag too — setSelectedId alone leaves the node
          // visually highlighted in the flow pane. Same rule for Load.
          suppressNextSelectionViewFlipRef.current = true;
          setSelectedId(null);
          setNodes((prev) =>
            prev.map((n) => (n.selected ? { ...n, selected: false } : n))
          );
          setParamView("project");
        }}
        onNewProject={handleNewProject}
        onSave={handleSave}
        onSaveAs={() => setSaveModalOpen(true)}
        onSaveAsNamed={handleSaveAsProject}
        onSaveIncremental={handleSaveIncremental}
        canSaveIncremental={signedIn && !!currentProject}
        onOpenLoad={() => {
          suppressNextSelectionViewFlipRef.current = true;
          setSelectedId(null);
          setNodes((prev) =>
            prev.map((n) => (n.selected ? { ...n, selected: false } : n))
          );
          setParamView("load");
        }}
        onOpenProjectFile={handleOpenProjectFile}
        onSaveToFile={handleSaveToFile}
        canvasRes={canvasRes}
        onCanvasResChange={setCanvasRes}
        projectName={currentProject?.name ?? "Untitled"}
        projectId={currentProject?.id ?? null}
        saveState={saveState}
        isPublic={currentProject?.isPublic ?? false}
        publicSlug={currentProject?.publicSlug ?? null}
        // When the viewer doesn't own the loaded row, rename and the
        // visibility toggle need to be disabled — Save still works, but
        // it forks a private copy instead of overwriting.
        ownedByMe={
          !currentProject ||
          (!!user && currentProject.ownerId === user.id)
        }
        authorName={currentProject?.authorName ?? null}
        onRenameProject={handleRenameProject}
        onRequestToggleVisibility={handleRequestToggleVisibility}
        findNameConflict={(name) =>
          findConflict(name, currentProject?.id)
        }
        onAddNode={(type) => onAddNode(type)}
        atRoot={currentGroupId == null}
        fullCanvas={fullCanvas}
        onToggleFullCanvas={() => setFullCanvas((v) => !v)}
        onEnterBrowserFullscreen={enterBrowserFullscreen}
        showFps={showFps}
        onToggleShowFps={() => setShowFps((v) => !v)}
        showNodeTimings={showNodeTimings}
        onToggleShowNodeTimings={() => setShowNodeTimings((v) => !v)}
        viewportSplit={viewportSplit}
        onToggleViewportSplit={() => setViewportSplit((v) => !v)}
        timelineLayout={timelineLayout}
        onToggleTimelineLayout={() => setTimelineLayout((v) => !v)}
        onOpenUserPreferences={() => setUserPrefsOpen(true)}
      />
      </div>
      </div>
      {/* Body wrapper. Default layout = canvas left, right column
          (NodeEditor over ParamPanel). Timeline layout = canvas right,
          a tabbed Parameters/Node Editor pane on the left, plus a
          tracks strip pinned beneath this row (rendered after the
          closing wrapper div below). flex-direction: row-reverse in
          timeline mode flips the existing left/right ordering with no
          structural changes to the children. */}
      <div
        style={{
          display: "flex",
          flexDirection: timelineLayout ? "row-reverse" : "row",
          flex: 1,
          minHeight: 0,
          width: "100%",
          // Outer gap so framed panels float off the window edges; the
          // inter-panel gaps come from the gutter dividers between them.
          // No bottom gap here — the timeline / playback strips below own
          // their own top spacing so seams stay single-width. Full-canvas
          // mode goes edge-to-edge with no chrome.
          padding: fullCanvas
            ? 0
            : `${PANEL_GAP}px ${PANEL_GAP}px 0 ${PANEL_GAP}px`,
          background: "#000",
        }}
      >
      <section
        style={{
          flex: 1,
          minWidth: 0,
          position: "relative",
          display: "flex",
          flexDirection: "column",
          ...(fullCanvas ? null : PANEL_FRAME),
        }}
      >
        {!fullCanvas && (
          <ViewportMenuBar
            projectRes={canvasRes}
            previewScale={previewScale}
            onPreviewScaleChange={setPreviewScale}
            onAddPrimitive={handleAddShelfNode}
          />
        )}
        {!fullCanvas && activeTransformNode && (
          <TransformContextBar
            // Flip = invert the corresponding scale around the pivot.
            // The transform shader applies scale around pivot, so a
            // negative scale produces a mirror across the pivot's
            // perpendicular axis. Coalesce key keyed on the node id so
            // a click is one undo entry.
            onFlipHorizontal={() => {
              const id = activeTransformNode.id;
              const cur = activeTransformNode.data.params.scaleX;
              const v = typeof cur === "number" ? cur : 1;
              onParamChange(id, "scaleX", -v, `flip:${id}`);
            }}
            onFlipVertical={() => {
              const id = activeTransformNode.id;
              const cur = activeTransformNode.data.params.scaleY;
              const v = typeof cur === "number" ? cur : 1;
              onParamChange(id, "scaleY", -v, `flip:${id}`);
            }}
          />
        )}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            position: "relative",
            display: "flex",
            flexDirection: "column",
            background: "#050505",
            padding: fullCanvas ? 0 : 12,
            overflow: "hidden",
          }}
        >
          <div
            ref={v1.viewportRef}
            style={{
              flex: viewportSplit ? viewportSplitRatio : 1,
              minHeight: 0,
              minWidth: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              position: "relative",
              width: "100%",
              overflow: "hidden",
              // Suppress system pan/zoom inside the canvas viewport
              // so our touch handler (one-finger pan, two-finger
              // pinch) gets exclusive control. Page-level pinch is
              // already disabled via the viewport meta.
              touchAction: "none",
            }}
          >
            <canvas
              ref={canvasRef}
              width={renderRes[0]}
              height={renderRes[1]}
              style={{
                maxWidth: "100%",
                maxHeight: "100%",
                background:
                  "repeating-conic-gradient(#1a1a1a 0% 25%, #0f0f0f 0% 50%) 0 0 / 24px 24px",
                border: "1px solid #111112",
                transform: `translate(${v1.pan[0]}px, ${v1.pan[1]}px) scale(${v1.zoom})`,
                transformOrigin: "center center",
              }}
            />
            {viewportSplit && <ViewportLabel label="1" />}
            {!v1.isDefault && (
              <ViewportZoomChip
                label={`${Math.round(v1.zoom * 100)}% · reset`}
                onClick={v1.reset}
              />
            )}
          </div>
          {viewportSplit && (
            <Divider
              orientation="horizontal"
              onPointerDown={(e) => {
                // Drag the divider — proportional resize between the
                // two viewports. Snap-clamped so neither viewport can
                // collapse fully.
                e.preventDefault();
                const startY = e.clientY;
                const parent = (e.currentTarget as HTMLDivElement)
                  .parentElement;
                if (!parent) return;
                const total = parent.clientHeight;
                const startRatio = viewportSplitRatio;
                const onMove = (ev: PointerEvent) => {
                  const dy = ev.clientY - startY;
                  const next = Math.max(
                    0.1,
                    Math.min(0.9, startRatio + dy / Math.max(1, total))
                  );
                  setViewportSplitRatio(next);
                };
                const onUp = () => {
                  window.removeEventListener("pointermove", onMove);
                  window.removeEventListener("pointerup", onUp);
                };
                window.addEventListener("pointermove", onMove);
                window.addEventListener("pointerup", onUp);
              }}
            />
          )}
          {viewportSplit && (
            <div
              ref={v2.viewportRef}
              style={{
                flex: 1 - viewportSplitRatio,
                minHeight: 0,
                minWidth: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                position: "relative",
                width: "100%",
                touchAction: "none",
                overflow: "hidden",
              }}
            >
              <canvas
                ref={canvas2Ref}
                width={renderRes[0]}
                height={renderRes[1]}
                style={{
                  maxWidth: "100%",
                  maxHeight: "100%",
                  background:
                    "repeating-conic-gradient(#1a1a1a 0% 25%, #0f0f0f 0% 50%) 0 0 / 24px 24px",
                  border: "1px solid #27272a",
                  transform: `translate(${v2.pan[0]}px, ${v2.pan[1]}px) scale(${v2.zoom})`,
                  transformOrigin: "center center",
                }}
              />
              <ViewportLabel label="2" />
              {!v2.isDefault && (
                <ViewportZoomChip
                  label={`${Math.round(v2.zoom * 100)}% · reset`}
                  onClick={v2.reset}
                />
              )}
            </div>
          )}
          {activePaintNode && (
            <PaintOverlay
              nodeId={activePaintNode.id}
              params={activePaintNode.data.params}
              canvasRes={canvasRes}
              onParamChange={onParamChange}
              onStrokeCommit={(nodeId, canvas, before) =>
                pushPaint({ nodeId, canvas, imageData: before })
              }
            />
          )}
          {selectedPoints && selectedPoints.count > 0 && backendReady && (
            <PointsOverlay
              canvas={canvasRef.current}
              value={selectedPoints}
            />
          )}
          {active3DSceneRenderId && backendReady && (
            <Scene3DViewport
              canvas={canvasRef.current}
              sceneRenderId={active3DSceneRenderId}
              cameraNodeId={active3DCameraNodeId}
              gizmoNodeId={active3DGizmo.id}
              gizmoCanRotate={active3DGizmo.canRotate}
              gizmoCanScale={active3DGizmo.canScale}
              onParamChange={onParamChange}
            />
          )}
          {webgpuParticleTest && backendReady && (
            <WebGPUParticleOverlay
              canvas={canvasRef.current}
              count={resolveParticleTestCount(
                webgpuParticleTest.data.params.count
              )}
              gravity={
                typeof webgpuParticleTest.data.params.gravity === "number"
                  ? webgpuParticleTest.data.params.gravity
                  : 0.8
              }
              damping={
                typeof webgpuParticleTest.data.params.damping === "number"
                  ? webgpuParticleTest.data.params.damping
                  : 0.999
              }
              pointSizePx={
                typeof webgpuParticleTest.data.params.pointSize === "number"
                  ? webgpuParticleTest.data.params.pointSize
                  : 2.5
              }
              seedNonce={
                typeof webgpuParticleTest.data.params.seed === "number"
                  ? webgpuParticleTest.data.params.seed
                  : 0
              }
            />
          )}
          {activeSplineNode && backendReady && (
            <SplineEditorOverlay
              canvas={canvasRef.current}
              value={
                activeSplineValue ?? {
                  subpaths: [{ anchors: [], closed: false }],
                }
              }
              onChange={(next) =>
                onParamChange(activeSplineNode.id, "spline", next)
              }
            />
          )}
          {activeSegmentNode && backendReady && (
            <SegmentDotsOverlay
              canvas={canvasRef.current}
              dots={
                (activeSegmentNode.data.params.dots as SegmentDot[]) ?? []
              }
              locked={isSegmentLocked(activeSegmentNode.id)}
              onChange={(next) => {
                const id = activeSegmentNode.id;
                onParamChange(id, "dots", next);
                // Re-segment immediately so the cutout tracks each click.
                // The session queue is latest-wins, so rapid clicks
                // converge on the final dot set.
                if (next.length === 0) {
                  clearLiveSegment(id);
                  return;
                }
                const inEdge = edgesRef.current.find(
                  (e) => e.target === id && e.targetHandle === "in:image"
                );
                if (inEdge) {
                  void runLiveSegment(id, next, () =>
                    getRefImageBlob(inEdge.source)
                  );
                }
              }}
            />
          )}
          {activeTransformNode && backendReady && (() => {
            // Read the effective param value at the current playhead.
            // For animated params, this returns the keyframe-evaluated
            // value so the on-canvas handles track the animation as the
            // user scrubs. For constant or wired params, falls back to
            // the stored constant.
            const animMap = activeTransformNode.data.animation;
            const effective = (name: string, fallback: number): number => {
              const block = animMap?.[name];
              if (block && block.animated && block.keyframes.length > 0) {
                const v = evaluateKeyframesAt(block, "scalar", currentTick);
                if (typeof v === "number") return v;
              }
              const raw = activeTransformNode.data.params[name];
              return typeof raw === "number" ? raw : fallback;
            };
            // Spline-mode bounds: hug the actual spline geometry instead
            // of the unit canvas box. We pull the spline value off the
            // upstream node's most recent eval result; if the upstream
            // hasn't evaluated yet (or isn't a spline), fall back to
            // canvas bounds. Anchors-only AABB — close enough at typical
            // spline densities and avoids per-frame Bézier eval.
            let boundsMin: [number, number] | undefined;
            let boundsMax: [number, number] | undefined;
            const isSplineMode =
              activeTransformNode.data.params.mode === "spline";
            if (isSplineMode) {
              const inEdge = edges.find(
                (e) =>
                  e.target === activeTransformNode.id &&
                  e.targetHandle === "in:image"
              );
              const srcOut = inEdge
                ? evalCacheRef.current.get(inEdge.source)
                : undefined;
              const splineVal = srcOut?.output?.primary;
              if (splineVal && splineVal.kind === "spline") {
                let minX = Infinity;
                let minY = Infinity;
                let maxX = -Infinity;
                let maxY = -Infinity;
                for (const sub of splineVal.subpaths) {
                  for (const a of sub.anchors) {
                    if (a.pos[0] < minX) minX = a.pos[0];
                    if (a.pos[0] > maxX) maxX = a.pos[0];
                    if (a.pos[1] < minY) minY = a.pos[1];
                    if (a.pos[1] > maxY) maxY = a.pos[1];
                  }
                }
                if (Number.isFinite(minX) && maxX - minX > 1e-4 && maxY - minY > 1e-4) {
                  boundsMin = [minX, minY];
                  boundsMax = [maxX, maxY];
                }
              }
            }
            return (
              <TransformGizmo
                canvas={canvasRef.current}
                pivotX={effective("pivotX", 0.5)}
                pivotY={effective("pivotY", 0.5)}
                translateX={effective("translateX", 0)}
                translateY={effective("translateY", 0)}
                scaleX={effective("scaleX", 1)}
                scaleY={effective("scaleY", 1)}
                rotate={effective("rotate", 0)}
                boundsMin={boundsMin}
                boundsMax={boundsMax}
                onChange={(patch) => {
                  const id = activeTransformNode.id;
                  // Single coalescing key for the whole drag so a 60-
                  // frame gizmo manipulation yields one undo entry,
                  // not one-per-(param × frame).
                  const key = `gizmo:${id}`;
                  for (const [k, v] of Object.entries(patch)) {
                    if (typeof v === "number")
                      onParamChange(id, k, v, key);
                  }
                }}
              />
            );
          })()}
          {/* Shape-primitive handles (Circle, Rectangle, …) — move the
              center, drag edges/corners to resize. Reads effective
              (keyframe-aware) params; writes coalesce into one undo entry. */}
          {activePrimitiveNode && backendReady && (() => {
            const node = activePrimitiveNode;
            const adapter = PRIMITIVE_GIZMO_ADAPTERS[node.data.defType];
            if (!adapter) return null;
            const animMap = node.data.animation;
            const get = (name: string, fallback: number): number => {
              const block = animMap?.[name];
              if (block && block.animated && block.keyframes.length > 0) {
                const v = evaluateKeyframesAt(block, "scalar", currentTick);
                if (typeof v === "number") return v;
              }
              const raw = node.data.params[name];
              return typeof raw === "number" ? raw : fallback;
            };
            // Solved container px size — lets Auto Layout's hug axes
            // display their actual bounds. The aux element's measure is
            // pure CPU; the cache entry is from the latest eval.
            let solvedSize: { width: number; height: number } | null = null;
            if (node.data.defType === "autolayout") {
              const out = evalCacheRef.current.get(node.id)?.output;
              const el = out?.aux?.element;
              if (el && el.kind === "element") {
                try {
                  solvedSize = el.measure({});
                } catch {
                  solvedSize = null;
                }
              }
            }
            const env: PrimitiveGizmoEnv = {
              canvasWidth: canvasRes[0],
              canvasHeight: canvasRes[1],
              getRaw: (name) => node.data.params[name],
              solvedSize,
            };
            const { cx, cy, hx, hy } = adapter.read(get, env);
            return (
              <PrimitiveGizmo
                canvas={canvasRef.current}
                cx={cx}
                cy={cy}
                hx={hx}
                hy={hy}
                anchorResize={adapter.anchorResize}
                onChange={(patch) => {
                  const id = node.id;
                  const key = `gizmo:${id}`;
                  for (const [name, value] of adapter.write(patch, env)) {
                    onParamChange(id, name, value, key);
                  }
                }}
              />
            );
          })()}
          {/* Gradient handles — linear endpoints (line + 2 dots) or the
              radial center/radius. Reads keyframe-aware params; writes
              coalesce into one undo entry per drag. Gradient param space is
              Y-up UV; the overlay flips Y. */}
          {activeGradientNode && backendReady && (() => {
            const node = activeGradientNode;
            const animMap = node.data.animation;
            const get = (name: string, fallback: number): number => {
              const block = animMap?.[name];
              if (block && block.animated && block.keyframes.length > 0) {
                const v = evaluateKeyframesAt(block, "scalar", currentTick);
                if (typeof v === "number") return v;
              }
              const raw = node.data.params[name];
              return typeof raw === "number" ? raw : fallback;
            };
            const rawMode = (node.data.params.mode as string) ?? "linear";
            const rawWave = (node.data.params.wave_mode as string) ?? "linear";
            const mode =
              rawMode === "radial"
                ? "radial"
                : rawMode === "multipoint"
                  ? "multipoint"
                  : rawMode === "wave" && rawWave === "ring"
                    ? "ring"
                    : "linear";
            // Multipoint dots: positions are keyframe-effective (per-point
            // virtual gpoint_x/y tracks), colors are the stored hex.
            const storedPoints =
              (node.data.params.points as GradientPoint[] | undefined) ?? [];
            const effPoints = storedPoints.map((pt) => ({
              id: pt.id,
              x: get(gpointXKey(pt.id), pt.x),
              y: get(gpointYKey(pt.id), pt.y),
              color: typeof pt.color === "string" ? pt.color : "#ffffff",
            }));
            return (
              <GradientOverlay
                canvas={canvasRef.current}
                mode={mode}
                startX={get("start_x", 0)}
                startY={get("start_y", 0.5)}
                endX={get("end_x", 1)}
                endY={get("end_y", 0.5)}
                centerX={get("center_x", 0.5)}
                centerY={get("center_y", 0.5)}
                radius={get("radius", 0.5)}
                points={effPoints}
                onChange={(updates) => {
                  const id = node.id;
                  const key = `gizmo:${id}`;
                  for (const [name, value] of updates) {
                    onParamChange(id, name, value, key);
                  }
                }}
                onPointChange={(pointId, x, y) => {
                  // Update only the dragged point's x/y in the STORED array
                  // (not the effective positions), so other keyframed points
                  // aren't baked. Autokey mirrors x/y when their tracks are on.
                  const stored =
                    (node.data.params.points as GradientPoint[] | undefined) ??
                    [];
                  const next = stored.map((p) =>
                    p.id === pointId ? { ...p, x, y } : p
                  );
                  onParamChange(node.id, "points", next, `gizmo:${node.id}`);
                }}
              />
            );
          })()}
          {/* Track Editor dock — anchored to the bottom edge of the canvas
              area. Toggled by the curves button in the PlaybackBar (next to
              Play). Suppressed in timeline-layout mode, where the dock body
              lives in its own bottom strip instead. */}
          {!timelineLayout && trackDockMounted && (
            <div
              style={{
                position: "absolute",
                left: PANEL_GAP,
                right: PANEL_GAP,
                bottom: PANEL_GAP,
                height: trackEditorHeight,
                background: "#0a0a0a",
                // Match the framed panels: thin stroke + slightly rounded
                // corners, floated a hair off the viewport edges.
                ...PANEL_FRAME,
                display: "flex",
                flexDirection: "column",
                zIndex: 5,
                // Slide up from below the canvas on open (and back down on
                // close); the canvas area clips the parked state.
                transform: trackDockShown
                  ? "translateY(0)"
                  : `translateY(calc(100% + ${PANEL_GAP}px))`,
                transition: "transform 240ms cubic-bezier(0.16, 1, 0.3, 1)",
              }}
            >
              {/* Resize handle — overlaid on the top edge (absolute) so it
                  doesn't add layout height above the toolbar. Sits over the
                  toolbar's top padding, clear of the buttons. */}
              <div
                title="Drag to resize"
                onMouseDown={(e) => {
                  e.preventDefault();
                  const startY = e.clientY;
                  const startH = trackEditorHeight;
                  const onMove = (ev: MouseEvent) => {
                    const dy = startY - ev.clientY;
                    setTrackEditorHeight(
                      Math.max(120, Math.min(700, startH + dy))
                    );
                  };
                  const onUp = () => {
                    window.removeEventListener("mousemove", onMove);
                    window.removeEventListener("mouseup", onUp);
                  };
                  window.addEventListener("mousemove", onMove);
                  window.addEventListener("mouseup", onUp);
                }}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  height: 6,
                  cursor: "row-resize",
                  zIndex: 10,
                }}
              />
              {dockBodyJsx}
            </div>
          )}
          {recording && <RecordingBanner state={recording} />}
          {queueProgress && <QueueBanner state={queueProgress} />}
          {progressStatus && <ProgressBanner status={progressStatus} />}
          <MediaRelinkModal
            open={relinkItems.length > 0}
            items={relinkItems}
            busy={relinkBusy}
            onRelink={relinkMissingMedia}
            onClose={() => setRelinkItems([])}
          />
          {toast && (
            <div
              style={{
                position: "absolute",
                top: 20,
                left: 20,
                padding: "4px 10px",
                background: "rgba(22, 163, 74, 0.95)",
                color: "#dcfce7",
                border: "1px solid #22c55e",
                borderRadius: 4,
                fontFamily: "ui-monospace, monospace",
                fontSize: 11,
                letterSpacing: 0.5,
                boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
                pointerEvents: "none",
              }}
            >
              {toast}
            </div>
          )}
        </div>
      </section>

      <Divider
        orientation="vertical"
        gutter
        hidden={fullCanvas}
        onMouseDown={startVResize}
      />

      <div
        style={{
          width: rightColWidth,
          flexShrink: 0,
          display: fullCanvas ? "none" : "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        {timelineLayout ? (
          // Timeline layout: this column lives on the LEFT (the
          // wrapper above flips order via row-reverse) and shows a
          // tabbed Parameters / Node Editor pane instead of the
          // stacked NodeEditor + ParamPanel.
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              background: "#0a0a0a",
              ...PANEL_FRAME,
            }}
          >
            <div
              style={{
                display: "flex",
                gap: 0,
                padding: "2px 8px",
                background: "#111114",
                borderBottom: "1px solid #27272a",
                flexShrink: 0,
              }}
            >
              {(["params", "nodes"] as const).map((t) => {
                const active = timelineLayoutTab === t;
                return (
                  <button
                    key={t}
                    onClick={() => setTimelineLayoutTab(t)}
                    style={{
                      background: active ? "#0a0a0a" : "transparent",
                      border: "1px solid #3f3f46",
                      borderBottom: active
                        ? "1px solid #0a0a0a"
                        : "1px solid #3f3f46",
                      color: active ? "#fafafa" : "#a1a1aa",
                      padding: "2px 12px",
                      marginRight: 2,
                      marginBottom: -1,
                      fontFamily: "ui-monospace, monospace",
                      fontSize: 10,
                      cursor: "pointer",
                      borderTopLeftRadius: 3,
                      borderTopRightRadius: 3,
                    }}
                  >
                    {t === "params" ? "Parameters" : "Node Editor"}
                  </button>
                );
              })}
            </div>
            <section
              style={{
                flex: 1,
                minHeight: 0,
                background: "#0a0a0a",
                display: "flex",
                flexDirection: "column",
              }}
            >
              {timelineLayoutTab === "params"
                ? paramPanelJsx
                : nodeEditorJsx}
            </section>
          </div>
        ) : (
          <>
            <section
              style={{
                flex: 1,
                minHeight: 0,
                background: "#0a0a0a",
                ...PANEL_FRAME,
              }}
            >
              {nodeEditorJsx}
            </section>

            <Divider
              orientation="horizontal"
              gutter
              onMouseDown={startHResize}
            />

            <section
              style={{
                height: bottomRowHeight,
                minHeight: 0,
                flexShrink: 0,
                background: "#0a0a0a",
                ...PANEL_FRAME,
              }}
            >
              {paramPanelJsx}
            </section>
          </>
        )}
      </div>
      </div>
      {/* Timeline-layout bottom strip: tracks editor full width, with
          the playback bar beneath it. The default layout pins the
          PlaybackBar as a sibling here too, just without the tracks
          strip on top. */}
      {timelineLayout && (
        <div
          style={{
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            background: "#000",
            // Side gutters match the framed panels above; the gutter
            // divider provides the top seam (and the resize handle).
            padding: `0 ${PANEL_GAP}px`,
          }}
        >
          <Divider
            orientation="horizontal"
            gutter
            onMouseDown={(e) => {
              e.preventDefault();
              const startY = e.clientY;
              const startH = trackEditorHeight;
              const onMove = (ev: MouseEvent) => {
                const dy = startY - ev.clientY;
                setTrackEditorHeight(
                  Math.max(120, Math.min(700, startH + dy))
                );
              };
              const onUp = () => {
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
              };
              window.addEventListener("mousemove", onMove);
              window.addEventListener("mouseup", onUp);
            }}
          />
          <div
            style={{
              height: trackEditorHeight,
              background: "#0a0a0a",
              display: "flex",
              flexDirection: "column",
              ...PANEL_FRAME,
            }}
          >
            {dockBodyJsx}
          </div>
        </div>
      )}
      {playbackBarJsx && (
        <div
          style={{
            flexShrink: 0,
            background: "#000",
            // No vertical gap and only a hair of side inset, so the timeline
            // sits tight and spans a touch wider than the panels above.
            padding: "0 1px",
          }}
        >
          {playbackBarJsx}
        </div>
      )}
      <SaveModal
        open={saveModalOpen}
        onClose={() => {
          setSaveModalOpen(false);
          // Cancelling the save during a File → New flow aborts the
          // chained reset — otherwise clicking Cancel would silently
          // still nuke the user's unsaved work.
          setPendingNewAfterSave(false);
        }}
        onSave={handleSaveAsWithMaybeReset}
        findConflict={(name) => findConflict(name)}
      />
      {(() => {
        if (!exportApp) return null;
        const node = nodes.find((n) => n.id === exportApp.outputNodeId);
        if (!node) return null;
        // Recompute the manifest on every render the modal is open. The
        // graph + name + description change frequently, so the manifest
        // and warnings always reflect the live state — cheap pure fn.
        const initialName = currentProject?.name || "my-app";
        const built = buildExportManifest({
          nodes,
          edges,
          appName: initialName,
          outputNodeId: exportApp.outputNodeId,
          canvasRes,
        });
        // Rough size estimate: serialized graph length plus per-asset
        // overhead. The packager enforces the real 25 MB cap; the
        // estimate is just a conservative pre-check.
        const estimate = JSON.stringify(built.manifest).length;
        // Alt output for split-viewport: let the user pick the other
        // active terminal as the export target.
        const alt = nodes.find(
          (n) => n.id !== node.id && (n.data.active2 || n.data.active)
        );
        return (
          <ExportAppModal
            open
            onClose={() => setExportApp(null)}
            initialAppName={initialName}
            outputNode={{ id: node.id, name: node.data.name }}
            altOutputNode={
              alt ? { id: alt.id, name: alt.data.name } : null
            }
            onPickOutputNode={(id) => setExportApp({ outputNodeId: id })}
            manifest={built.manifest}
            warnings={built.warnings}
            estimatedSizeBytes={estimate}
            busy={exportAppBusy}
            onExport={(args) => {
              void runExportApp(args);
            }}
          />
        );
      })()}
      <PublicPrivateConfirm
        open={!!pendingVisibility}
        toPublic={pendingVisibility?.toPublic ?? false}
        onCancel={() => setPendingVisibility(null)}
        onConfirm={handleConfirmVisibility}
      />
      <NewProjectConfirm
        open={newConfirmOpen}
        canSave={signedIn}
        saveHint={newSaveHint(currentProject, user?.id)}
        onCancel={() => setNewConfirmOpen(false)}
        onDiscard={handleNewConfirmDiscard}
        onSave={handleNewConfirmSave}
      />
      <UserPreferencesModal
        open={userPrefsOpen}
        signedIn={signedIn}
        onClose={() => setUserPrefsOpen(false)}
      />
      {/* First-load gateway. Mounts over the editor; picking a project
          loads it in place, "New Project" seeds a fresh graph. Either
          path dismisses the landing. */}
      {showLanding && (
        <Landing
          onLoad={(id) => {
            setShowLanding(false);
            handleLoadProject(id);
          }}
          onLoadLocal={(p) => {
            setShowLanding(false);
            void handleOpenLocalRecent(p);
          }}
          onNewProject={() => {
            setShowLanding(false);
            resetToFreshProject();
          }}
        />
      )}
      {/* <CustomCursor /> temporarily disabled — using native cursor */}
    </div>
  );
}

// Short "here's what Save will do" string for the confirm modal.
// Mirrors the branching in handleSave so the button's effect isn't
// a surprise.
function newSaveHint(
  currentProject: { name: string; ownerId: string } | null,
  userId: string | undefined
): string {
  if (!currentProject) return "You'll be prompted for a name first.";
  const isMine = !!userId && currentProject.ownerId === userId;
  if (!isMine) {
    return `Saving will fork a private copy named "${currentProject.name}_copy".`;
  }
  return `Save will overwrite "${currentProject.name}".`;
}

function ProgressBanner({
  status,
}: {
  status: { label: string; progress: number; tone: "save" | "load" };
}) {
  const pct = Math.max(0, Math.min(100, Math.round(status.progress * 100)));
  const isSave = status.tone === "save";
  const bg = isSave ? "rgba(22, 163, 74, 0.9)" : "rgba(37, 99, 235, 0.9)";
  const border = isSave ? "#22c55e" : "#3b82f6";
  const fillFg = isSave ? "#86efac" : "#93c5fd";
  return (
    <div
      style={{
        position: "absolute",
        top: 20,
        left: "50%",
        transform: "translateX(-50%)",
        minWidth: 160,
        padding: "6px 12px",
        background: bg,
        color: "#f0fdf4",
        border: `1px solid ${border}`,
        borderRadius: 4,
        fontFamily: "ui-monospace, monospace",
        fontSize: 11,
        letterSpacing: 0.5,
        boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
        pointerEvents: "none",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <span>{status.label}</span>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>{pct}%</span>
      </div>
      <div
        style={{
          marginTop: 4,
          height: 3,
          background: "rgba(0,0,0,0.35)",
          borderRadius: 2,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: fillFg,
            transition: "width 80ms linear",
          }}
        />
      </div>
    </div>
  );
}

// Pan/zoom state for one preview viewport. Owns its own ref + state so
// each viewport can frame its preview independently when split.
function useViewportPanZoom() {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<[number, number]>([0, 0]);
  const reset = useCallback(() => {
    setZoom(1);
    setPan([0, 0]);
  }, []);
  const isDefault = zoom === 1 && pan[0] === 0 && pan[1] === 0;
  return { viewportRef, zoom, pan, setZoom, setPan, reset, isDefault };
}

// Two-finger trackpad / mouse-wheel pan and Cmd-zoom on the given
// viewport, plus middle-click drag to pan. Listens at the window level
// and hit-tests the cursor against the viewport's rect, so the gesture
// applies to whichever viewport the cursor is over — even when a
// sibling overlay (paint, spline, gizmo, curve dock, etc.) sits visually
// between the cursor and the viewport's DOM subtree. Overlays that want
// to consume wheel themselves (the curve editor dock) call
// stopPropagation, which prevents the bubble path from reaching window.
function useViewportGestures(
  viewportRef: React.RefObject<HTMLDivElement | null>,
  setPan: React.Dispatch<React.SetStateAction<[number, number]>>,
  setZoom: React.Dispatch<React.SetStateAction<number>>
) {
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      const el = viewportRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      ) {
        return;
      }
      e.preventDefault();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = e.deltaX || 0;
      const dy = e.deltaY || 0;
      // Zoom on an explicit modifier OR when the active device is a mouse
      // (whose wheel should zoom rather than pan). See input-device.ts.
      const isZoom = wheelWantsZoom(e);
      if (isZoom) {
        const mag = Math.abs(dx) > Math.abs(dy) ? dx : dy;
        const factor = Math.exp(-mag * 0.005);
        setZoom((prevZoom) => {
          const nextZoom = Math.max(0.1, Math.min(8, prevZoom * factor));
          const ratio = nextZoom / prevZoom;
          setPan(([px, py]) => [
            px * ratio + (e.clientX - cx) * (1 - ratio),
            py * ratio + (e.clientY - cy) * (1 - ratio),
          ]);
          return nextZoom;
        });
        return;
      }
      setPan(([px, py]) => [px - dx, py - dy]);
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [viewportRef, setPan, setZoom]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (e.button !== 1) return;
      const el = viewportRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      ) {
        return;
      }
      e.preventDefault();
      // Cmd/Ctrl + middle-drag zooms about the press point; plain middle-drag
      // pans. (Drag right zooms in.)
      const zoomDrag = e.metaKey || e.ctrlKey;
      const startX = e.clientX;
      const startY = e.clientY;
      let curPan: [number, number] = [0, 0];
      setPan((p) => {
        curPan = p;
        return p;
      });
      let curZoom = 1;
      setZoom((z) => {
        curZoom = z;
        return z;
      });
      // Press point relative to the viewport center (matches the wheel-zoom
      // anchoring math), held fixed while zooming.
      const aX = startX - (rect.left + rect.width / 2);
      const aY = startY - (rect.top + rect.height / 2);
      const onMove = (ev: PointerEvent) => {
        if (zoomDrag) {
          // Drag up zooms in.
          const factor = Math.exp(-(ev.clientY - startY) * 0.005);
          const nextZoom = Math.max(0.1, Math.min(8, curZoom * factor));
          const ratio = nextZoom / curZoom;
          setZoom(nextZoom);
          setPan([
            curPan[0] * ratio + aX * (1 - ratio),
            curPan[1] * ratio + aY * (1 - ratio),
          ]);
        } else {
          setPan([
            curPan[0] + (ev.clientX - startX),
            curPan[1] + (ev.clientY - startY),
          ]);
        }
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [viewportRef, setPan, setZoom]);

  // Touch / Pencil pan + pinch-zoom on the canvas viewport.
  // Mirrors the wheel handler's pan/zoom semantics so the canvas
  // behaves the same on touch as it does on a trackpad. Wired
  // directly on the viewport element (not window) because we need
  // multi-touch state and want to passively skip touches that start
  // outside the viewport.
  //
  // One finger / one pen → pan.
  // Two fingers → pinch zooms about the midpoint, AND drag pans
  // by the midpoint delta (matches Figma / Procreate).
  // Mouse pointers are ignored here — those go through the wheel
  // and middle-button paths above.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    // Track active touch/pen pointers by id. Only the first two
    // matter for pinch math; additional fingers are ignored until
    // one of the active two leaves.
    const active = new Map<number, { x: number; y: number }>();
    let lastPanX = 0;
    let lastPanY = 0;
    let lastDist = 0;

    const isAcceptedPointer = (e: PointerEvent) =>
      e.pointerType === "touch" || e.pointerType === "pen";

    const recompute = () => {
      const pts = Array.from(active.values());
      if (pts.length === 1) {
        lastPanX = pts[0].x;
        lastPanY = pts[0].y;
        lastDist = 0;
      } else if (pts.length >= 2) {
        const a = pts[0];
        const b = pts[1];
        lastPanX = (a.x + b.x) / 2;
        lastPanY = (a.y + b.y) / 2;
        lastDist = Math.hypot(b.x - a.x, b.y - a.y);
      }
    };

    const onDown = (e: PointerEvent) => {
      if (!isAcceptedPointer(e)) return;
      // Only own gestures that *started* over the canvas viewport.
      const rect = el.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      ) {
        return;
      }
      // Cap at two tracked pointers — third+ fingers are noise.
      if (active.size >= 2) return;
      active.set(e.pointerId, { x: e.clientX, y: e.clientY });
      recompute();
      el.setPointerCapture(e.pointerId);
    };

    const onMove = (e: PointerEvent) => {
      if (!active.has(e.pointerId)) return;
      // Don't let the page see the gesture — touch-action on the el
      // disables it for one-finger pans, but two-finger pinches still
      // need this for some browsers.
      e.preventDefault();
      active.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pts = Array.from(active.values());
      if (pts.length === 1) {
        const dx = pts[0].x - lastPanX;
        const dy = pts[0].y - lastPanY;
        lastPanX = pts[0].x;
        lastPanY = pts[0].y;
        setPan(([px, py]) => [px + dx, py + dy]);
      } else if (pts.length >= 2) {
        const a = pts[0];
        const b = pts[1];
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        // Pan by midpoint movement so two-finger drag pans the
        // viewport, same as a trackpad two-finger swipe.
        const dx = midX - lastPanX;
        const dy = midY - lastPanY;
        lastPanX = midX;
        lastPanY = midY;
        // Pinch about the midpoint, in viewport-center-relative
        // coords (mirrors the wheel-zoom math above).
        const factor = lastDist > 0 ? dist / lastDist : 1;
        lastDist = dist;
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        setZoom((prevZoom) => {
          const nextZoom = Math.max(0.1, Math.min(8, prevZoom * factor));
          const ratio = nextZoom / prevZoom;
          setPan(([px, py]) => [
            (px + dx) * ratio + (midX - cx) * (1 - ratio),
            (py + dy) * ratio + (midY - cy) * (1 - ratio),
          ]);
          return nextZoom;
        });
      }
    };

    const release = (e: PointerEvent) => {
      if (!active.has(e.pointerId)) return;
      active.delete(e.pointerId);
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        // Pointer was already released by the browser; ignore.
      }
      recompute();
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove, { passive: false });
    el.addEventListener("pointerup", release);
    el.addEventListener("pointercancel", release);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", release);
      el.removeEventListener("pointercancel", release);
    };
  }, [viewportRef, setPan, setZoom]);
}

// Splitter handle. Renders a thin 1px visual line but keeps a wider
// (default 5px) hit-target so it's easy to grab. The visible line
// stays centered inside the hit zone via flex.
// Blender-style panel chrome. Each editor area is enclosed in a thin
// bordered, slightly rounded rect; areas are separated by a tiny gutter
// that doubles (invisibly) as the resize handle — the gap around where
// borders meet.
const PANEL_GAP = 3;
// Resize grab zone for gutter dividers. Wider than the visible gap so
// it's easy to grab; the extra width overlaps the neighbouring panel
// edges via negative margins, so the *visible* gap stays PANEL_GAP.
const GUTTER_HIT = 11;
const PANEL_FRAME: React.CSSProperties = {
  border: "1px solid #222225",
  borderRadius: 5,
  overflow: "hidden",
};

function Divider({
  orientation,
  hit = 5,
  thickness = 1,
  color = "#27272a",
  hidden = false,
  gutter = false,
  onPointerDown,
  onMouseDown,
}: {
  orientation: "horizontal" | "vertical";
  hit?: number;
  thickness?: number;
  color?: string;
  hidden?: boolean;
  // Gutter mode: the gap between two framed panels *is* the handle —
  // no visible line, just the resize cursor over the gap.
  gutter?: boolean;
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onMouseDown?: (e: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const isH = orientation === "horizontal";
  // Negative margin reclaims the grab zone's extra width so it nets out
  // to PANEL_GAP of layout while overlapping the panels for easy grabbing.
  const bleed = -(GUTTER_HIT - PANEL_GAP) / 2;
  const gutterStyle: React.CSSProperties = gutter
    ? isH
      ? { height: GUTTER_HIT, marginTop: bleed, marginBottom: bleed, position: "relative", zIndex: 10 }
      : { width: GUTTER_HIT, marginLeft: bleed, marginRight: bleed, position: "relative", zIndex: 10 }
    : { height: isH ? hit : "auto", width: isH ? "auto" : hit };
  return (
    <div
      onPointerDown={onPointerDown}
      onMouseDown={onMouseDown}
      style={{
        flexShrink: 0,
        display: hidden ? "none" : "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: isH ? "row-resize" : "col-resize",
        alignSelf: "stretch",
        background: "transparent",
        ...gutterStyle,
      }}
    >
      {!gutter && (
        <div
          style={{
            background: color,
            height: isH ? thickness : "100%",
            width: isH ? "100%" : thickness,
          }}
        />
      )}
    </div>
  );
}

function ViewportZoomChip({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title="Reset canvas zoom & pan (0)"
      style={{
        position: "absolute",
        right: 8,
        bottom: 8,
        background: "#18181b",
        color: "#a1a1aa",
        border: "1px solid #3f3f46",
        borderRadius: 3,
        padding: "3px 8px",
        fontFamily: "ui-monospace, monospace",
        fontSize: 10,
        cursor: "pointer",
        zIndex: 4,
      }}
    >
      {label}
    </button>
  );
}

function ViewportLabel({ label }: { label: string }) {
  return (
    <div
      style={{
        position: "absolute",
        top: 6,
        left: 6,
        padding: "1px 6px",
        background: "rgba(17, 17, 17, 0.85)",
        color: "#a1a1aa",
        border: "1px solid #27272a",
        borderRadius: 3,
        fontFamily: "ui-monospace, monospace",
        fontSize: 10,
        pointerEvents: "none",
        zIndex: 3,
      }}
    >
      {label}
    </div>
  );
}

// Stagger control — a square button (three stacked lines) next to the
// dock toggle. Clicking pops a small panel above with a frame-offset
// number field (type or drag). It drives the keyframe stagger in the
// active editor via window CustomEvents: the editor snapshots its
// multi-lane selection on "begin", applies the per-lane offset on each
// "keyframe-stagger", and drops the snapshot on "end". If the selection
// is confined to a single lane/layer, the editor doesn't respond and
// the panel says so.
function StaggerControl({ ticksPerFrame }: { ticksPerFrame: number }) {
  const [open, setOpen] = useState(false);
  const [frames, setFrames] = useState(0);
  const [hasEffect, setHasEffect] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(
    null
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    window.dispatchEvent(new CustomEvent("keyframe-stagger-end"));
  }, []);

  const toggle = () => {
    if (open) {
      close();
      return;
    }
    let responded = false;
    window.dispatchEvent(
      new CustomEvent("keyframe-stagger-begin", {
        detail: { respond: () => (responded = true) },
      })
    );
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setAnchor({ left: r.left, top: r.top });
    setHasEffect(responded);
    setFrames(0);
    setOpen(true);
  };

  // Push the current frame offset to the editor whenever it changes.
  useEffect(() => {
    if (!open || !hasEffect) return;
    window.dispatchEvent(
      new CustomEvent("keyframe-stagger", {
        detail: { stepTicks: frames * ticksPerFrame },
      })
    );
  }, [frames, open, hasEffect, ticksPerFrame]);

  // Click-outside closes (and commits, since edits are applied live).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as globalThis.Node;
      if (!rootRef.current?.contains(t) && !popRef.current?.contains(t)) {
        close();
      }
    };
    const id = window.setTimeout(
      () => window.addEventListener("mousedown", onDown),
      0
    );
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open, close]);

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        ref={btnRef}
        type="button"
        title="Stagger selected keyframes across layers/tracks"
        onClick={toggle}
        style={{
          width: 26,
          height: 26,
          borderRadius: 5,
          background: open ? "#1b2741" : "#0a0a0a",
          border: `1px solid ${open ? "#26375f" : "#27272a"}`,
          color: open ? "#bfdbfe" : "#8a8a90",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
        }}
      >
        <svg width={12} height={12} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
          <line x1={2} y1={3} x2={10} y2={3} />
          <line x1={2} y1={6} x2={10} y2={6} />
          <line x1={2} y1={9} x2={10} y2={9} />
        </svg>
      </button>
      {open && anchor &&
        createPortal(
          <div
            ref={popRef}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              position: "fixed",
              // Anchor the panel's bottom 6px above the button (portaled
              // to body so the dock's overflow/transform can't clip it).
              left: anchor.left,
              top: anchor.top - 6,
              transform: "translateY(-100%)",
              zIndex: 1000,
              background: "#18181b",
              border: "1px solid #27272a",
              borderRadius: 6,
              boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
              padding: 8,
              width: 160,
            }}
          >
          <div
            style={{
              color: "#71717a",
              fontSize: 9,
              textTransform: "uppercase",
              letterSpacing: 1,
              marginBottom: 6,
            }}
          >
            Stagger
          </div>
          {hasEffect ? (
            <StaggerNumber value={frames} onChange={setFrames} />
          ) : (
            <div style={{ color: "#52525b", fontSize: 10, lineHeight: 1.4 }}>
              Select keyframes across two or more layers/tracks first.
            </div>
          )}
          </div>,
          document.body
        )}
    </div>
  );
}

// Compact frames field: drag horizontally to scrub, or click to type.
function StaggerNumber({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(String(value));
  const dragRef = useRef<{ startX: number; startVal: number; moved: boolean } | null>(
    null
  );
  useEffect(() => {
    if (!editing) setText(String(value));
  }, [value, editing]);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (Math.abs(e.clientX - d.startX) > 2) d.moved = true;
      onChange(d.startVal + Math.round((e.clientX - d.startX) / 5));
    };
    const onUp = () => {
      const d = dragRef.current;
      if (d && !d.moved) setEditing(true);
      dragRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [onChange]);
  const commit = () => {
    const n = parseInt(text, 10);
    onChange(Number.isFinite(n) ? n : 0);
    setEditing(false);
  };
  return editing ? (
    <input
      autoFocus
      type="text"
      value={text}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setEditing(false);
      }}
      style={{
        width: "100%",
        background: "#0a0a0a",
        border: "1px solid #3f3f46",
        color: "#e5e7eb",
        fontFamily: "ui-monospace, monospace",
        fontSize: 12,
        padding: "4px 6px",
        borderRadius: 4,
        boxSizing: "border-box",
      }}
    />
  ) : (
    <div
      onMouseDown={(e) => {
        dragRef.current = { startX: e.clientX, startVal: value, moved: false };
      }}
      title="Drag to scrub, click to type — frames offset per layer step"
      style={{
        width: "100%",
        background: "#0a0a0a",
        border: "1px solid #27272a",
        color: "#e5e7eb",
        fontFamily: "ui-monospace, monospace",
        fontSize: 12,
        padding: "4px 6px",
        borderRadius: 4,
        boxSizing: "border-box",
        cursor: "ew-resize",
        userSelect: "none",
        display: "flex",
        justifyContent: "space-between",
      }}
    >
      <span>{value}</span>
      <span style={{ color: "#52525b" }}>frames</span>
    </div>
  );
}

// Shared button for the track/graph dock header. Near-invisible border at
// rest (so the bar reads clean), a subtle hover, and a soft blue highlight
// when toggled on. Tabs and toggles use `active`; momentary actions omit it.
// Segmented Tracks/Graph toggle: both options live in one rounded frame
// with a single blue highlight that slides between them on selection.
function DockTabToggle({
  value,
  onChange,
}: {
  value: "tracks" | "graph" | "layers";
  onChange: (v: "tracks" | "graph" | "layers") => void;
}) {
  const tabs = [
    { key: "layers", label: "Layers" },
    { key: "tracks", label: "Tracks" },
    { key: "graph", label: "Graph" },
  ] as const;
  const idx = tabs.findIndex((t) => t.key === value);
  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        background: "#0a0a0a",
        border: "1px solid #27272a",
        borderRadius: 5,
        padding: 2,
      }}
    >
      {/* Sliding highlight — one button-width, translated to the active tab. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: 2,
          bottom: 2,
          left: 2,
          width: `calc(${100 / tabs.length}% - 2px)`,
          background: "#1b2741",
          border: "1px solid #26375f",
          borderRadius: 4,
          transform: `translateX(${Math.max(0, idx) * 100}%)`,
          transition: "transform 220ms cubic-bezier(0.16, 1, 0.3, 1)",
          pointerEvents: "none",
        }}
      />
      {tabs.map((t) => {
        const active = value === t.key;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            style={{
              position: "relative",
              zIndex: 1,
              flex: 1,
              minWidth: 60,
              padding: "3px 14px",
              background: "transparent",
              border: "none",
              borderRadius: 4,
              color: active ? "#bfdbfe" : "#8a8a90",
              fontFamily: "ui-monospace, monospace",
              fontSize: 10,
              lineHeight: 1,
              cursor: "pointer",
              transition: "color 150ms",
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function DockButton({
  children,
  onClick,
  title,
  active = false,
  pad = "3px 10px",
}: {
  children: React.ReactNode;
  onClick: () => void;
  title?: string;
  active?: boolean;
  pad?: string;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: active ? "#1b2741" : hover ? "#19191c" : "transparent",
        border: `1px solid ${active ? "#26375f" : hover ? "#2a2a2e" : "#171719"}`,
        color: active ? "#bfdbfe" : hover ? "#e5e7eb" : "#8a8a90",
        padding: pad,
        fontFamily: "ui-monospace, monospace",
        fontSize: 10,
        lineHeight: 1,
        cursor: "pointer",
        borderRadius: 3,
        transition: "background 80ms, border-color 80ms, color 80ms",
      }}
    >
      {children}
    </button>
  );
}

// Outer batch banner for the Render Queue — sits just above the per-item
// RecordingBanner so the user sees both "Item 2/5" and that item's own
// progress at once.
function QueueBanner({
  state,
}: {
  state: { index: number; total: number; name: string };
}) {
  return (
    <div
      style={{
        position: "absolute",
        top: 64,
        left: "50%",
        transform: "translateX(-50%)",
        padding: "6px 12px",
        background: "rgba(24, 24, 27, 0.95)",
        color: "#e4e4e7",
        border: "1px solid #3f3f46",
        borderRadius: 4,
        fontFamily: "ui-monospace, monospace",
        fontSize: 11,
        letterSpacing: 0.5,
        minWidth: 220,
        textAlign: "center",
        boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
        pointerEvents: "none",
      }}
    >
      {`Render Queue · item ${Math.min(state.index + 1, state.total)}/${
        state.total
      } · ${state.name}`}
    </div>
  );
}

function RecordingBanner({
  state,
}: {
  state:
    | { mode: "live"; totalSec: number; startedAt: number }
    | { mode: "offline"; label: string; progress: number };
}) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (state.mode !== "live") return;
    let raf = 0;
    const tick = () => {
      setNow(performance.now());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state.mode]);

  const text =
    state.mode === "live"
      ? `REC ${Math.max(
          0,
          state.totalSec - Math.max(0, (now - state.startedAt) / 1000)
        ).toFixed(1)}s remaining`
      : `REC ${state.label}`;

  return (
    <div
      style={{
        position: "absolute",
        top: 20,
        left: "50%",
        transform: "translateX(-50%)",
        padding: "6px 12px",
        background: "rgba(220, 38, 38, 0.9)",
        color: "#fef2f2",
        border: "1px solid #ef4444",
        borderRadius: 4,
        fontFamily: "ui-monospace, monospace",
        fontSize: 11,
        letterSpacing: 0.5,
        minWidth: 220,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
        pointerEvents: "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: "#fca5a5",
            boxShadow: "0 0 8px #ef4444",
          }}
        />
        {text}
      </div>
      {state.mode === "offline" && (
        <div
          style={{
            position: "relative",
            height: 3,
            background: "rgba(0,0,0,0.4)",
            borderRadius: 2,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              width: `${Math.max(0, Math.min(1, state.progress)) * 100}%`,
              background: "#fca5a5",
              transition: "width 80ms linear",
            }}
          />
        </div>
      )}
    </div>
  );
}
