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
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import NodeEditor, { PROJECT_CRUMB_ID, type PendingWire } from "./NodeEditor";
import { CompositionTabBar } from "./CompositionTabBar";
import { ProjectView } from "./ProjectView";
import { AssetsView, type AssetItem } from "./AssetsView";
import ParamPanel from "./ParamPanel";
import {
  LayoutRegion,
  PANEL_FRAME,
  PANEL_GAP,
  GUTTER_HIT,
  GUTTER_HIT_COARSE,
} from "./layout/LayoutRegion";
import { PanelKindMenu } from "./layout/PanelKindMenu";
import { PanelPopout } from "./layout/PanelPopout";
import { broadcastAppEvent, ownerWindow } from "./layout/panel-window";
import {
  computeRects,
  countLeavesOfKind,
  fromSavedLayout,
  largestLeaf,
  makeDefaultTree,
  PANEL_LABELS,
  toSavedLayout,
  type LayoutTree,
  type PanelKind,
} from "./layout/model";
import {
  assignKind,
  attachLeaf,
  joinAt,
  removeLeaf,
  setRatio,
  splitLeaf as splitLayoutLeaf,
  swapLeaves,
} from "./layout/ops";
import {
  layoutPresetEntries,
  loadLayoutPresets,
  resolveLayoutPreset,
  saveLayoutPresets,
  upsertLayoutPreset,
  type LayoutPreset,
} from "./layout/presets";
import NewLayoutPresetModal from "./NewLayoutPresetModal";
import { feedWheel, wheelWantsZoom } from "./input-device";
import { applyStoredUiFont } from "./ui-font";
import { applyStoredTheme } from "./theme/theme";
// import CustomCursor from "./CustomCursor"; // temporarily disabled — using native cursor
import UserPreferencesModal from "./UserPreferencesModal";
import PaintOverlay from "./paint-editor/PaintOverlay";
import PlaybackBar from "./PlaybackBar";
import MenuBar from "./MenuBar";
import { type ConsoleEntry } from "./MessageConsole";
import Landing from "./Landing";
import ViewportMenuBar from "./ViewportMenuBar";
import TransformContextBar from "./TransformContextBar";
import PieMenu, { type PieMenuItem } from "./PieMenu";
import {
  SaveIcon,
  ProjectsIcon,
  AssetsIcon,
  NewProjectIcon,
  FullCanvasIcon,
  SplitViewportIcon,
  AddNodeIcon,
} from "./pie-menu-icons";
import { registerAllNodes } from "@/nodes";
import { getNodeDef } from "@/engine/registry";
import { createEngineBackend, type EngineBackend } from "@/engine/gl";
import { awaitMediaSettle } from "@/engine/offline-settle";
import {
  disposeAllNodeState,
  evaluateGraph,
  type EvalCache,
  type GraphEdge,
  type GraphNode,
} from "@/engine/evaluator";
import { splineToSvg } from "@/engine/svg-serialize";
import {
  svgExportStashKey,
  type SvgExportStash,
} from "@/nodes/output/svg-export";
import {
  anchorInKey,
  anchorOutKey,
  anchorPosKey,
  anchorTrackId,
  gpointCKey,
  gpointXKey,
  gpointYKey,
  isAnchorTrackKey,
  layerOpacityKey,
  rampAlphaKey,
  rampColorKey,
  rampPositionKey,
  resolveAnchorTracks,
  withMaskInput,
} from "@/engine/conventions";
import type { SplineAnchor, SplineSubpath } from "@/engine/types";
import type { ColorRampStop } from "@/engine/color-ramp";
import type { NodeDataPayload } from "@/state/graph";
import { parseTargetHandleKind, newCompositionId } from "@/state/graph";
import { FRAME_TYPE, SWITCH_TYPE } from "@/engine/graph-helpers";
import {
  computeFrameRects,
  FRAME_DEFAULT_H,
  FRAME_DEFAULT_W,
  FRAME_PADDING,
} from "./FrameNode";
import {
  buildStarterGraph,
  belongsToComposition,
  cloneCompositionNodes,
  absorbIntoIterateZone,
  cloneSubgraph,
  collectDescendantIds,
  connectAcrossIterateBoundary,
  connectToVirtualSocket,
  createComposition,
  createLayer,
  defaultScopeFor,
  deleteCompositionNodes,
  expandWithDescendants,
  getLayerChain,
  insertReroutesOnEdges,
  reorderLayers,
  resolveComposition,
  splitLayer,
  groupSelection,
  makeInstanceNode,
  makeIterateNodes,
  makeSplineEditable,
  newEdgeId,
  reparentNode,
  removeGroupSocket,
  renameGroupSocket,
  ungroupNode,
  withUpdatedParams,
} from "@/state/graph-ops";
import {
  GROUP_INPUT_TYPE,
  GROUP_OUTPUT_TYPE,
  GROUP_TYPE,
  ITERATE_TYPE,
  LAYER_TYPE,
} from "@/engine/groups";
import { editorCanCoerce } from "@/engine/graph-validation";
import { getPreset } from "@/state/presets";
import { newLayerId, type MergeLayer } from "@/nodes/effect/merge";
import { MAX_COLORS, colorParamName } from "@/nodes/source/color-literal";
import { newExprInput } from "@/nodes/effect/expression";
import { defaultAutoLayoutItem } from "@/nodes/effect/autolayout";
import { newRenderQueueItemId } from "@/nodes/output/render-queue";
import { wedgeTokenValue } from "@/nodes/source/wedge";
import {
  resolveWedgeBatchInfo,
  type WedgeBatchInfo,
} from "@/lib/wedge-batch";
import {
  resolveWedgeName,
  stripWedgeTokens,
  type WedgeTokenSource,
} from "@/lib/export-naming";
import type {
  AutoLayoutItem,
  ExprInput,
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
  resolveExportResolution,
  sanitizeFilename,
} from "@/lib/export";
import { outputNeedsSimPreroll } from "@/lib/sim-preroll";
import {
  platform,
  type FolderHandle,
  type AssetsFolderHandle,
} from "@/lib/platform";
import {
  clearRecentProjects,
  listRecentProjects,
  notifyRecentProjectsChanged,
  openLocalRecentFile,
  pickAndRecordLocalToolbox,
  recordCloudRecent,
  removeCloudRecent,
  renameCloudRecent,
  subscribeRecentProjects,
  supportsLocalFileRecents,
  type RecentProjectEntry,
} from "@/lib/recent-projects";
import {
  decodeImageFileEnvelope,
  deserializeGraph,
  generateThumbnail,
  incrementName,
  serializeGraph,
  type PendingMedia,
  type SavedProject,
  type SavedComposition,
} from "@/lib/project";
import {
  matchFilesToMissing,
  pickMediaFiles,
  pickMediaFilesViaInput,
  readStoredMediaFile,
  type MissingMedia,
} from "@/lib/media-relink";
import { registerImageOriginal } from "@/lib/image-bytes";
import { playbackClock } from "@/state/playback-clock";
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
import AiRecipePanel from "./AiRecipePanel";
import McpPairingDialog from "./McpPairingDialog";
import { useMcpBridge } from "./useMcpBridge";
import { buildMcpHandlers } from "./mcp-handlers";
import type { BridgeHandlers } from "@/lib/mcp-bridge";
import { generateRecipe } from "@/lib/ai/generate-recipe-client";
import { editGroupRecipe } from "@/lib/ai/edit-recipe-client";
import type { AiProgress } from "@/lib/ai/ai-progress";
import {
  appendTurn as appendEditTurn,
  clearTranscript as clearEditTranscript,
  getTranscript as getEditTranscript,
  type RecipeChatTurn,
} from "@/state/recipe-chat";
import {
  parseFragmentText,
  writeFragmentToClipboard,
} from "@/lib/fragment-clipboard";
import {
  startPointerDrag,
  useCoarsePointer,
  TOUCH_DRAG_STYLE,
} from "@/lib/pointer-drag";
import ExportAppModal from "./ExportAppModal";
import NodeInspectorPopup from "./NodeInspectorPopup";
import SocketPeekPopover from "./SocketPeekPopover";
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
import { PRIMITIVE_GIZMO_ADAPTERS } from "./PrimitiveGizmo";
import {
  GradientOverlayAtTick,
  PrimitiveGizmoAtTick,
  SplineEditorOverlayAtTick,
  TransformGizmoAtTick,
} from "./GizmoTickOverlays";
import SegmentDotsOverlay from "./SegmentDotsOverlay";
import KeyerSampleOverlay, {
  type KeyerSourcePixels,
} from "./KeyerSampleOverlay";
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
import type { PointsValue, SocketType, ResolveCtx } from "@/engine/types";

registerAllNodes();

// Fresh-session scaffold: Output + "Layer 1" with the starter chain
// inside (see buildStarterGraph). The editor opens inside the layer.
const STARTER = buildStarterGraph();
const INITIAL_NODES: Node<NodeDataPayload>[] = STARTER.nodes;
const INITIAL_EDGES: Edge[] = STARTER.edges;
// A fresh project is one composition holding the starter graph (v5). The
// registry's scene materializes from the live loop/fps/resolution on save.
const INITIAL_COMPOSITIONS: SavedComposition[] = [
  { id: STARTER.compositionId, name: "Composition 1" },
];

// Tag any untagged nodes into a composition. Called when leaving a
// composition so freshly-created (still-untagged) nodes commit to the comp
// they were made in, rather than leaking into the next one via the
// defensive membership predicate. Returns the same array reference when
// nothing changed, so callers can skip a setState.
// Editor-only relabel + blue tint for a layer node and its boundary nodes,
// and "Composition Output" for the comp-root Output (#159). Only overrides a
// still-default name, so user renames win. `typeById` maps node id → defType.
function layerDisplayFor(
  n: Node<NodeDataPayload>,
  typeById: Map<string, string>
): { displayName?: string; layerAccent?: boolean } {
  const t = n.data.defType;
  if (t === LAYER_TYPE) return { layerAccent: true };
  const parentType = n.data.parentId ? typeById.get(n.data.parentId) : undefined;
  if (parentType === LAYER_TYPE) {
    if (t === GROUP_INPUT_TYPE)
      return {
        layerAccent: true,
        displayName: n.data.name === "Group Input" ? "Layer Input" : undefined,
      };
    if (t === GROUP_OUTPUT_TYPE)
      return {
        layerAccent: true,
        displayName: n.data.name === "Group Output" ? "Layer Output" : undefined,
      };
  }
  if (t === "output" && !n.data.parentId && n.data.name === "Output")
    return { displayName: "Composition Output" };
  return {};
}

// Classify an assets-folder file by extension (Assets view + drag-to-create).
function kindFromExt(ext: string): AssetItem["kind"] {
  const e = ext.toLowerCase();
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(e)) return "image";
  if (e === "svg") return "svg";
  if (["mp4", "mov", "webm", "mkv", "m4v", "avi"].includes(e)) return "video";
  if (["mp3", "wav", "m4a", "aac", "ogg", "flac"].includes(e)) return "audio";
  if (["ttf", "otf", "woff", "woff2"].includes(e)) return "font";
  return "other";
}

function tagUntaggedInto(
  nodes: Node<NodeDataPayload>[],
  compositionId: string
): Node<NodeDataPayload>[] {
  let changed = false;
  const out = nodes.map((n) => {
    if (n.data.compositionId) return n;
    changed = true;
    return { ...n, data: { ...n.data, compositionId } };
  });
  return changed ? out : nodes;
}

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

// Node types that retype their input sockets purely from `connectedTypes`
// (what's wired in) with NO stored `mode` param to fall back on. Copy-to-
// Points / Math also retype, but they're param-backed (onConnect flips their
// `mode`), so their stored sockets stay correct. These have no such anchor, so
// an edges-keyed effect must resolve + write their sockets, and the param-
// change path must not overwrite them without `connectedTypes`. Transform /
// Displace also retype their primary OUTPUT to match; Scatter Points only
// retypes its `density` input (its output is always `points`) — the resync
// handles both since it reads each node's own resolvePrimaryOutput.
const CONNECTED_TYPE_RETYPE_NODES = new Set([
  "transform",
  "displace",
  "scatter-points",
  // Mirror: spline-resting `source` retypes to points (and its output
  // follows). See specdocs/072026_mirror-node.md.
  "mirror",
  // Reroute: a wildcard passthrough whose `value` input + output adopt the
  // type wired in. See specdocs/071326_reroute-node.md.
  "reroute",
  // Switch: on "auto" (the default) every numbered slot AND the output adopt
  // the unified type of whatever is wired in — a Reroute with N inputs.
  SWITCH_TYPE,
]);

// --- timeline dock (080226_timeline-modal-panel.md) -----------------------
//
// The dock (Layers / Tracks / Graph) has two hosts: the floating modal
// the PlaybackBar's curves button opens, and any `timeline` leaf in the
// tiled layout. Both render the same body; `host` only decides what
// sits left of the tab toggle (close ✕ vs. the panel-kind chip).

export type DockTab = "tracks" | "graph" | "layers";
/** Instance id of the floating dock (panels key off their leaf id). */
const DOCK_MODAL_ID = "modal";

/**
 * Transparency checker behind every viewport canvas (primary, split #2, and
 * each tiled watch viewport). Painted by the canvas element's own CSS
 * background, so it reads through wherever the rendered frame has alpha —
 * including the "nothing to preview" case, where the blit clears the canvas
 * to transparent rather than filling a plate.
 *
 * Steps 9/5 rather than the 3/1 pair the small swatch checkers use: at the
 * bottom of the ramp two adjacent-ish steps differ by ~4 L*, which at
 * canvas scale is indistinguishable from black — the whole point of the
 * checker is that "transparent" doesn't read as "black output". 9 vs 5 is
 * ~15 L* apart in dark mode and mirrors to a normal light checker.
 */
const VIEWPORT_CHECKER =
  "repeating-conic-gradient(var(--tb-n-9) 0% 25%, var(--tb-n-5) 0% 50%) 0 0 / 24px 24px";
/**
 * What sits behind the canvas with the checker toggled OFF — a flat plate,
 * so alpha reads as one solid field instead of a grid. AE's transparency
 * grid and Cavalry's checker both work this way; black in dark mode, white
 * in light, which is what `--tb-frame` already means everywhere else.
 */
const VIEWPORT_FLAT = "var(--tb-frame)";
/** localStorage key for the checker toggle (per-machine, not project data). */
const VIEWPORT_CHECKER_KEY = "viewport.checker";
/** Same, for the on-canvas GUI (gizmo/handle overlay) toggle. */
const VIEWPORT_GIZMOS_KEY = "viewport.gizmos";

// Every control in the dock toolbar — the tab toggle, the buttons either
// side of it, the stagger popover trigger, the panel-kind chip — is
// forced to this exact height with box-sizing: border-box, so the row
// lines up regardless of each control's own padding and border.
const DOCK_CTRL_H = 22;
// Nested radii must be concentric or the inner corners bulge past the
// outer curve: inner = outer − the gap between them (the toggle's 2px
// padding). See DockTabToggle.
const DOCK_RADIUS = 6;
const DOCK_RADIUS_INNER = DOCK_RADIUS - 2;

/** Floating-dock geometry, CSS px in viewport coordinates. */
interface DockRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
const DOCK_MIN_W = 320;
const DOCK_MIN_H = 160;
const DOCK_DEFAULT_H = 280;
/** Vertical band the modal may occupy — below the menu bar, above the
 *  playback bar. Both are fixed-height chrome, so the band is a constant
 *  rather than a measurement: MenuBar is 22 (32 on the frameless desktop
 *  build — the taller value wins here) and PlaybackBar is 44. The dock
 *  renders UNDER both anyway; this just keeps it reachable. */
const DOCK_TOP_INSET = 32;
const DOCK_BOTTOM_INSET = 44;
/** Keep at least this much of the drag bar on screen horizontally. */
const DOCK_EDGE_KEEP = 80;
const DOCK_RECT_KEY = "timeline.modal.rect";
const DOCK_OPEN_KEY = "timeline.modal.open";

/** Bottom-anchored, full-width-ish — where the dock used to open. */
function defaultDockRect(): DockRect {
  const vw = typeof window === "undefined" ? 1280 : window.innerWidth;
  const vh = typeof window === "undefined" ? 800 : window.innerHeight;
  return {
    x: PANEL_GAP,
    y: Math.max(
      DOCK_TOP_INSET,
      vh - DOCK_BOTTOM_INSET - DOCK_DEFAULT_H - PANEL_GAP
    ),
    w: Math.max(DOCK_MIN_W, vw - PANEL_GAP * 2),
    h: DOCK_DEFAULT_H,
  };
}

/**
 * Fit a rect inside the current window. Runs on every restore (a rect
 * saved on a large display must not come back offscreen on a laptop)
 * and on resize.
 */
function clampDockRect(r: DockRect): DockRect {
  if (typeof window === "undefined") return r;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const maxH = Math.max(DOCK_MIN_H, vh - DOCK_TOP_INSET - DOCK_BOTTOM_INSET);
  const w = Math.max(DOCK_MIN_W, Math.min(r.w, Math.max(DOCK_MIN_W, vw)));
  const h = Math.max(DOCK_MIN_H, Math.min(r.h, maxH));
  return {
    w,
    h,
    // Horizontally the drag bar just has to stay reachable, so the box
    // may hang off either edge as long as DOCK_EDGE_KEEP of it shows.
    x: Math.max(DOCK_EDGE_KEEP - w, Math.min(r.x, vw - DOCK_EDGE_KEEP)),
    // Vertically the whole toolbar must stay in the band between the
    // menu bar and the playback bar.
    y: Math.max(DOCK_TOP_INSET, Math.min(r.y, vh - DOCK_BOTTOM_INSET - h)),
  };
}

function readSavedDockRect(): DockRect | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(DOCK_RECT_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<DockRect>;
    if (
      typeof p.x !== "number" ||
      typeof p.y !== "number" ||
      typeof p.w !== "number" ||
      typeof p.h !== "number" ||
      ![p.x, p.y, p.w, p.h].every(Number.isFinite)
    ) {
      return null;
    }
    return clampDockRect({ x: p.x, y: p.y, w: p.w, h: p.h });
  } catch {
    return null;
  }
}

export default function EffectsApp({
  initialProject,
}: {
  initialProject?: InitialProjectPayload;
} = {}) {
  return (
    <AuthProvider>
      {/* No shell-level ReactFlowProvider: with the tiled layout each
          Node Editor pane wraps itself in its own provider so duplicate
          panes get independent stores/cameras (072726_window-tiling.md
          §5). Nothing outside those panes consumes the store. */}
      <EffectsShell initialProject={initialProject} />
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

  // Composition registry (v5): the project's compositions and which one is
  // active. A single composition exists until the Project view (M3/M4) can
  // create more; everything here is a no-op for that one-comp case but is
  // the foundation the tab bar / browser build on. The active comp's scene
  // is materialized from the live loop/fps/resolution at save time.
  const [compositions, setCompositions] = useState<SavedComposition[]>(
    rehydrate?.compositions ?? INITIAL_COMPOSITIONS
  );
  const [activeCompositionId, setActiveCompositionId] = useState<string>(
    rehydrate?.activeCompositionId ?? STARTER.compositionId
  );
  // Which compositions show as tabs (decision 5). In M3 a project opens with
  // every composition as a tab; closing removes it from the bar (never
  // deletes the comp). The Project view (M4) is the home that can reopen one.
  const [openCompositionIds, setOpenCompositionIds] = useState<string[]>(() =>
    (rehydrate?.compositions ?? INITIAL_COMPOSITIONS).map((c) => c.id)
  );
  // "project" swaps the node editor for the Project view (file browser); the
  // preview/timeline keep rendering the last-active comp while it's open.
  const [view, setView] = useState<"editor" | "project">("editor");
  // Bumped to re-render the Project view's title after a local (file)
  // project rename — the file name lives on a ref, not reactive state.
  const [, setProjectNameTick] = useState(0);
  // External assets folder (the assets/ beside a desktop .toolbox, or a folder
  // the user picked). Drives the Assets view's "Folder" section. See M-A3.
  const [assetsFolder, setAssetsFolder] = useState<AssetsFolderHandle | null>(
    null
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

  // Streamed media (v9 Storage images). A cloud load returns these deferred
  // rather than blocking on their network fetch, so the graph is interactive
  // immediately; we fetch them in parallel here and patch each into its node
  // when it lands. `mediaLoadRef` holds the in-flight batch so a save can
  // await it (never serialize a not-yet-loaded image to null). Node ids still
  // loading are broadcast via `node-media-loading` for the per-node spinner.
  const mediaLoadRef = useRef<Promise<void> | null>(null);
  // Values that have LANDED from an in-flight stream, keyed
  // `${nodeId} ${paramName}`, recorded synchronously as each fetch
  // settles. A save awaits `mediaLoadRef`, but the last patch's `setNodes` may
  // not have COMMITTED before serialize reads the render-mirror `nodesRef`, so
  // that image would serialize as null (and its Storage object then be pruned
  // — the same data loss as #1b, via a different door). overlayLandedMedia
  // patches these onto the graph at serialize time, independent of React's
  // commit timing; a cleanup effect drops each entry once it's committed so a
  // later user edit of the param isn't clobbered. See 072226 audit #1a.
  const landedMediaRef = useRef<Map<string, unknown>>(new Map());
  const streamPendingMedia = useCallback(
    (pending: PendingMedia[]) => {
      // A new load supersedes any prior load's landed media.
      landedMediaRef.current.clear();
      if (pending.length === 0) {
        mediaLoadRef.current = null;
        broadcastAppEvent(
          () =>
            new CustomEvent("node-media-loading", { detail: new Set<string>() })
        );
        return;
      }
      let left = pending.slice();
      const emit = () =>
        broadcastAppEvent(
          () =>
            new CustomEvent("node-media-loading", {
              detail: new Set(left.map((p) => p.nodeId)),
            })
        );
      emit();
      const patch = (nodeId: string, paramName: string, value: unknown) =>
        setNodes((prev) =>
          prev.map((n) =>
            n.id === nodeId
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    params: { ...n.data.params, [paramName]: value },
                  },
                }
              : n
          )
        );
      const one = async (pm: PendingMedia) => {
        const landedKey = `${pm.nodeId} ${pm.paramName}`;
        try {
          const bmp = await decodeImageFileEnvelope(pm.envelope.dataUrl ?? "");
          patch(pm.nodeId, pm.paramName, bmp);
          // Record synchronously so a save that resumes before React commits
          // this patch still serializes the landed bitmap (see landedMediaRef).
          landedMediaRef.current.set(landedKey, bmp);
        } catch (e) {
          console.warn(`[load] streamed image failed for ${pm.nodeId}`, e);
          // Keep the envelope in the param so a re-save preserves the ref
          // (it round-trips as a Storage URL) instead of dropping the image.
          patch(pm.nodeId, pm.paramName, pm.envelope);
          landedMediaRef.current.set(landedKey, pm.envelope);
        } finally {
          left = left.filter((x) => x !== pm);
          emit();
          // Nudge the engine to re-evaluate now that a texture is available.
          window.dispatchEvent(new Event("pipeline-bump"));
        }
      };
      const promise = Promise.allSettled(pending.map(one)).then(() => {
        if (mediaLoadRef.current === promise) mediaLoadRef.current = null;
      });
      mediaLoadRef.current = promise;
    },
    [setNodes]
  );

  // Overlay any landed-but-maybe-not-yet-committed streamed media onto a nodes
  // array before serializing it. Fixes the save-during-stream race where
  // `nodesRef` (a render-time mirror) still holds null for an image whose
  // patch hasn't committed. Skips entries already reflected in the array. See
  // 072226 audit #1a.
  const overlayLandedMedia = useCallback(
    (arr: Node<NodeDataPayload>[]): Node<NodeDataPayload>[] => {
      const landed = landedMediaRef.current;
      if (landed.size === 0) return arr;
      return arr.map((n) => {
        let params: Record<string, unknown> | null = null;
        for (const [key, value] of landed) {
          const sep = key.indexOf(" ");
          if (key.slice(0, sep) !== n.id) continue;
          const pname = key.slice(sep + 1);
          if (n.data.params[pname] === value) continue; // already committed
          if (!params) params = { ...n.data.params };
          params[pname] = value;
        }
        return params ? { ...n, data: { ...n.data, params } } : n;
      });
    },
    []
  );

  // Once a landed value is reflected in committed state, drop its entry — the
  // overlay is no longer needed and keeping it could clobber a later user edit
  // of that param.
  useEffect(() => {
    const landed = landedMediaRef.current;
    if (landed.size === 0) return;
    for (const [key, value] of landed) {
      const sep = key.indexOf(" ");
      const n = nodes.find((nn) => nn.id === key.slice(0, sep));
      if (n && n.data.params[key.slice(sep + 1)] === value) landed.delete(key);
    }
  }, [nodes]);

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
        const {
          nodes: nextNodes,
          edges: nextEdges,
          scene,
          compositions: nextComps,
          activeCompositionId: nextActiveComp,
          missingMedia,
          pendingMedia,
        } = await deserializeGraph(initialProject.graph, undefined, {
          deferRemoteMedia: true,
        });
        if (cancelled) return;
        setNodes(nextNodes);
        setEdges(nextEdges);
        setCompositions(nextComps);
        setActiveCompositionId(nextActiveComp);
        setOpenCompositionIds(nextComps.map((c) => c.id));
        setView("editor");
        setAssetsFolder(null);
        setCurrentGroupId(defaultScopeFor(nextNodes, nextActiveComp));
        setMissingMedia(missingMedia);
        streamPendingMedia(pendingMedia);
        frameGraph();
        if (scene) {
          if ("loopFrames" in scene) setLoopFrames(scene.loopFrames ?? null);
          if (scene.fps !== undefined) setFps(scene.fps);
          if (scene.width !== undefined && scene.height !== undefined)
            setCanvasRes([scene.width, scene.height]);
        }
        // Per-project tiled layout (M4) — public /p/ loads apply the
        // author's layout too (owner decision, spec §6).
        applyLoadedLayout(
          (initialProject.graph as { layout?: unknown }).layout
        );
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
  // Transparency checker behind every viewport canvas. On by default; the
  // toggle in the primary viewport's upper-right corner swaps it for a flat
  // plate (AE's transparency grid, Cavalry's checker). Same per-machine
  // viewing-preference rule as previewScale above — localStorage, never the
  // project file. One switch drives all viewports: primary, split #2, and
  // every tiled watch window, since it's a way of LOOKING at alpha rather
  // than a property of any one panel.
  const [showChecker, setShowChecker] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(VIEWPORT_CHECKER_KEY) !== "0";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(VIEWPORT_CHECKER_KEY, showChecker ? "1" : "0");
  }, [showChecker]);
  const canvasBackdrop = showChecker ? VIEWPORT_CHECKER : VIEWPORT_FLAT;
  // On-canvas GUI for the selection — transform/primitive/gradient handles,
  // the spline pen, points/segment dots, the 3D orbit viewport's grid+axes.
  // Every one of those is selection-driven, so one global switch IS "hide
  // the selected node's GUI": with it off the canvas shows the rendered
  // frame and nothing else. Same per-machine viewing-preference rule as the
  // checker above — localStorage, never the project file.
  //
  // Deliberately NOT gated: the Paint brush surface and the WebGPU particle
  // overlay. The first is the paint tool itself (hiding it would silently
  // make the node unpaintable), the second draws actual output rather than
  // chrome.
  const [showGizmos, setShowGizmos] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(VIEWPORT_GIZMOS_KEY) !== "0";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(VIEWPORT_GIZMOS_KEY, showGizmos ? "1" : "0");
  }, [showGizmos]);
  // Export resolution override (073126_export-resolution-and-app-slim.md).
  // While set, the engine renders at exactly this size — previewScale is
  // deliberately not applied, so exports never inherit a lowered preview
  // render scale. Setting it rides the same backend-recreation effect as a
  // project-resolution change (the battle-tested path); the preview canvas
  // element resizes with renderRes, so every capture route (toBlob,
  // captureStream, native-ffmpeg readback) sees the export size with no
  // per-path changes. Managed by beginExportResolution/endExportResolution.
  const [exportResOverride, setExportResOverride] = useState<
    [number, number] | null
  >(null);
  const renderRes: [number, number] = useMemo(
    () =>
      exportResOverride ?? [
        Math.max(2, Math.round(canvasRes[0] * previewScale)),
        Math.max(2, Math.round(canvasRes[1] * previewScale)),
      ],
    [canvasRes, previewScale, exportResOverride]
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
  const [paramView, setParamView] = useState<
    "project" | "node" | "load" | "ai-recipe" | "assets"
  >(
    rehydrate?.paramView ?? (initialProject ? "node" : "load")
  );
  // First-load landing gateway. Shown only on a clean visit to `/` —
  // skipped when arriving via /p/<slug> (initialProject) or when
  // restoring an in-progress session (rehydrate), since both already
  // resolve to a specific graph the user expects to see immediately.
  const [showLanding, setShowLanding] = useState(
    !initialProject && !rehydrate
  );
  // True once the landing has been re-opened over a live editor (Toolbox
  // menu → the version row). That copy is dismissable — the project it
  // covers is still loaded — whereas the first-load gateway has nothing
  // to go back to and stays until a project is chosen.
  const [landingReopened, setLandingReopened] = useState(false);
  // Once the menu bar has finished sliding in we drop its wrapper's
  // transform back to `none`. A lingering transform establishes a
  // stacking context that would trap the menu dropdowns beneath the
  // editor body — so it must only exist while actually animating.
  const [menuSettled, setMenuSettled] = useState(!showLanding);
  // Full-canvas mode: canvas fills the viewport, all other UI chrome
  // is hidden. Toggled via the F shortcut or the Window menu's "Full
  // Canvas" item. Esc exits.
  const [fullCanvas, setFullCanvas] = useState(false);
  // Radial quick-action "pie" menu (Shift+Space, opens at the cursor).
  // Holds the screen-px origin where the chord was pressed, or null when
  // closed. Spec: specdocs/071326_pie-menu.md.
  const [pieMenu, setPieMenu] = useState<{ x: number; y: number } | null>(null);
  // The tiled window layout (072726_window-tiling.md): one tree of
  // splits/leaves replaces the old fixed default/timeline layouts,
  // which live on as Window-menu presets. Persists per-project
  // (SavedProject.layout, M4) and across the docs round-trip (session
  // stash); a fresh session starts on the default preset.
  const [layoutTree, setLayoutTree] = useState<LayoutTree>(
    () => rehydrate?.layoutTree ?? makeDefaultTree()
  );
  const layoutComputed = useMemo(() => computeRects(layoutTree), [layoutTree]);
  // Panels popped out into their own OS windows (M1 — viewport only;
  // 080226_panel-popout-windows.md). A detached leaf LEAVES layoutTree
  // (so no split ratio describes a hole) and lives here instead,
  // keeping its leaf id — which is what lets the watch-canvas registry
  // and the per-pane stashes carry on working untouched.
  const [detachedPanels, setDetachedPanels] = useState<
    { id: string; panel: PanelKind }[]
  >([]);
  // Primary viewport — hosts the engine blit target (canvasRef), every
  // editing overlay/gizmo, the tracks dock and the Shift+S A/B split;
  // other viewport leaves are watch windows (blit-only). Election is
  // STICKY: the current primary keeps the role while it remains a live
  // viewport leaf, so splitting it (M2) or adding viewports never
  // teleports the canvas + overlays into a different pane (that would
  // remount them). Falls back to the first viewport leaf in tree order.
  const [primaryViewportLeafId, setPrimaryViewportLeafId] = useState<
    string | null
  >(() => {
    if (rehydrate?.primaryViewportLeafId) return rehydrate.primaryViewportLeafId;
    for (const id of layoutComputed.order) {
      if (layoutComputed.leaves.get(id)?.panel === "viewport") return id;
    }
    return null;
  });
  useEffect(() => {
    // Functional update returns the same id while the primary is still
    // valid, so React bails and no cascading render happens.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPrimaryViewportLeafId((prev) => {
      const viewports = layoutComputed.order.filter(
        (id) => layoutComputed.leaves.get(id)?.panel === "viewport"
      );
      return prev && viewports.includes(prev)
        ? prev
        : (viewports[0] ?? null);
    });
  }, [layoutComputed]);
  // Signature of the viewport leaf SET — the state-driven eval effect
  // keys on it so a freshly-added watch viewport paints immediately.
  // Ratio-only drags deliberately don't re-eval. Detached viewports
  // count: a popped-out window would otherwise stay blank until some
  // unrelated edit triggered the next eval.
  const viewportLeafSig = useMemo(
    () =>
      [
        ...layoutComputed.order.filter(
          (id) => layoutComputed.leaves.get(id)?.panel === "viewport"
        ),
        ...detachedPanels
          .filter((d) => d.panel === "viewport")
          .map((d) => d.id),
      ].join("|"),
    [layoutComputed, detachedPanels]
  );
  const handleSetLayoutRatio = useCallback(
    (splitId: string, ratio: number) => {
      setLayoutTree((t) => setRatio(t, splitId, ratio));
    },
    []
  );
  const handleAssignPanelKind = useCallback(
    (leafId: string, kind: PanelKind) => {
      // A detached leaf isn't in the tree — retype the pop-out entry
      // instead, so its window swaps editors in place.
      if (detachedIdsRef.current.has(leafId)) {
        setDetachedPanels((d) =>
          d.map((e) => (e.id === leafId ? { ...e, panel: kind } : e))
        );
        return;
      }
      setLayoutTree((t) => assignKind(t, leafId, kind));
    },
    []
  );
  // Corner-drag split commit (M2). The new leaf clones the source's
  // kind (Blender semantics); the original keeps its id, so the sticky
  // primary election and panel content never move.
  const handleSplitLeaf = useCallback(
    (
      leafId: string,
      dir: "row" | "col",
      ratio: number,
      firstIsNew: boolean
    ) => {
      setLayoutTree((t) => splitLayoutLeaf(t, leafId, dir, ratio, firstIsNew));
    },
    []
  );
  // Join-drag commits (M3). Swap trades the two leaves' panel kinds;
  // join swallows the target's side of the lowest separating split
  // (LayoutRegion's preview already showed exactly what closes, and it
  // refuses merges that would remove every viewport leaf).
  const handleSwapPanels = useCallback((a: string, b: string) => {
    setLayoutTree((t) => swapLeaves(t, a, b));
  }, []);
  const handleJoinPanels = useCallback((keepId: string, removeId: string) => {
    setLayoutTree((t) => joinAt(t, keepId, removeId));
  }, []);
  // Pop-out (M1). The SYNCHRONOUS authority on what's detached: the
  // close path can fire twice (the child's `pagehide` and the
  // `win.closed` poll race), and re-homing twice would graft a second
  // leaf into the tree. State alone can't guard that — a render may not
  // have happened in between.
  const detachedIdsRef = useRef(new Set<string>());
  const handleDetachPanel = useCallback(
    (leafId: string, panel: PanelKind) => {
      // The primary viewport owns canvasRef and every overlay/gizmo —
      // undetachable until those are window-aware (spec §5).
      if (leafId === primaryViewportLeafId) return;
      const next = removeLeaf(layoutTree, leafId);
      // null = it was the last leaf; unchanged = no such leaf.
      if (!next || next === layoutTree) return;
      // Same invariant the kind menu and the join gesture enforce, now
      // scoped to the MAIN window: it always keeps a viewport.
      if (countLeavesOfKind(next, "viewport") === 0) return;
      detachedIdsRef.current.add(leafId);
      setLayoutTree(next);
      setDetachedPanels((d) =>
        d.some((e) => e.id === leafId) ? d : [...d, { id: leafId, panel }]
      );
    },
    [layoutTree, primaryViewportLeafId]
  );
  // Coming home: the panel grafts back beside the biggest leaf, split
  // across that leaf's longer edge. Deterministic, and it never has to
  // remember a parent split that may have been joined away while the
  // window was open.
  const handleRehomePanel = useCallback(
    (leafId: string, panel: PanelKind) => {
      if (!detachedIdsRef.current.delete(leafId)) return;
      const aspect = window.innerWidth / Math.max(1, window.innerHeight);
      setDetachedPanels((d) => d.filter((e) => e.id !== leafId));
      setLayoutTree((t) => {
        const target = largestLeaf(t, aspect);
        if (!target) return t;
        return attachLeaf(t, target.id, panel, target.dir).tree;
      });
    },
    []
  );
  // Window → Layouts. Built-in presets live in code; the user's saved
  // ones come from their profile (layout/presets.ts — localStorage +
  // user_preferences.layout_presets). Applying one swaps the whole tree.
  const [layoutPresets, setLayoutPresets] = useState<LayoutPreset[]>([]);
  const applyLayoutPreset = useCallback(
    (id: string) => {
      const tree = resolveLayoutPreset(id, layoutPresets);
      // A preset whose stored blob failed validation resolves to null —
      // leave the current arrangement alone rather than yanking the user
      // back to the default.
      if (tree) setLayoutTree(tree);
    },
    [layoutPresets]
  );
  // Live refs for the save paths + session stash (the callback-with-
  // refs pattern every save site here uses).
  const layoutTreeRef = useRef(layoutTree);
  layoutTreeRef.current = layoutTree;
  const primaryViewportLeafIdRef = useRef(primaryViewportLeafId);
  primaryViewportLeafIdRef.current = primaryViewportLeafId;
  // Apply a loaded project's saved layout (M4). Malformed or absent →
  // the default preset, so every project opens with a deterministic
  // arrangement (File → New deliberately keeps the current layout —
  // nothing calls this on that path).
  const applyLoadedLayout = useCallback((savedLayout: unknown) => {
    setLayoutTree(fromSavedLayout(savedLayout) ?? makeDefaultTree());
  }, []);
  // Overlays cache canvas rects and refresh on window "resize"; every
  // structural layout change moves panels, so fire it once per change
  // (divider drags additionally fire per-move inside LayoutRegion).
  useEffect(() => {
    window.dispatchEvent(new Event("resize"));
  }, [layoutTree]);
  // Watch-viewport canvas registry (leaf id → canvas). renderFrame
  // blits the terminal image to every registered canvas after the
  // primary one.
  const watchCanvasesRef = useRef(new Map<string, HTMLCanvasElement>());
  const registerWatchCanvas = useCallback(
    (leafId: string, el: HTMLCanvasElement | null) => {
      if (el) watchCanvasesRef.current.set(leafId, el);
      else watchCanvasesRef.current.delete(leafId);
    },
    []
  );
  // Split viewport: stacks two preview canvases vertically. Each canvas
  // has its own active terminal node — the per-node header gains a
  // second "A2" toggle (alongside "A1") so the user can independently
  // pick which subgraph drives which viewport. Toggled via Shift+S or
  // the Window menu.
  const [viewportSplit, setViewportSplit] = useState(false);
  // Bumped after a project is opened so NodeEditor re-frames the whole
  // graph (the mount-only `fitView` prop can't catch an in-place node
  // swap). See NodeEditor's `frameSignal` prop.
  const [frameGraphSignal, setFrameGraphSignal] = useState(0);
  const frameGraph = useCallback(() => setFrameGraphSignal((n) => n + 1), []);
  // EffectNode reads this via the same `effect-node-toggle` event bus
  // it already uses for active/bypass — but it also needs the boolean
  // synchronously to decide whether to render the second toggle. Push
  // it as a window event so EffectNode can subscribe without prop
  // threading through React Flow's data-only API.
  useEffect(() => {
    broadcastAppEvent(
      () =>
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
      broadcastAppEvent(() => new CustomEvent("node-timings", { detail: null }));
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
        // Shift+F is the node editor's frame-selection chord (073026) —
        // leave it alone or it can never reach NodeEditor's handler.
        if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
        e.preventDefault();
        setFullCanvas((v) => !v);
      } else if (e.key === " " && e.shiftKey) {
        // Shift+Space → open the radial pie menu at the cursor. Guard
        // against key auto-repeat so a held chord opens it exactly once.
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.repeat) return;
        e.preventDefault();
        setPieMenu({ x: lastPointerRef.current.x, y: lastPointerRef.current.y });
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
  // The group currently being edited by the AI panel (paramView "ai-recipe"
  // with a target ⇒ edit mode; no target ⇒ generate mode).
  const [editTarget, setEditTarget] = useState<{ groupId: string; name: string } | null>(null);
  const editTargetRef = useRef(editTarget);
  editTargetRef.current = editTarget;
  // Local-cache chat transcript for the group being edited (mirrors the store
  // for rendering; the store is the source of truth).
  const [editTranscript, setEditTranscript] = useState<RecipeChatTurn[]>([]);
  // User Preferences modal — Toolbox menu → User Preferences. Hosts
  // the BYO OpenAI key for AI-driven nodes plus future editor-wide
  // settings.
  const [userPrefsOpen, setUserPrefsOpen] = useState(false);
  // New-layout-preset modal — Window → Layouts → + New Preset….
  const [newLayoutPresetOpen, setNewLayoutPresetOpen] = useState(false);
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
  // Output-socket peek (hover an output handle ~2s — EffectNode dispatches
  // `socket-peek`, SocketPeekPopover renders). While set, the eval loop
  // forces the peeked node into the needed set (extraTargets) and marks the
  // hovered handle consumed (extraConsumed) so unwired branches and gated
  // aux outputs produce real data. The ref mirrors state so renderFrame
  // reads the current target without re-subscribing.
  const [socketPeek, setSocketPeek] = useState<{
    nodeId: string;
    handle: string;
    anchorY: number;
  } | null>(null);
  const socketPeekRef = useRef<typeof socketPeek>(null);
  socketPeekRef.current = socketPeek;
  // "Make Editable" bake pending on a node the eval cache hasn't seen
  // (disconnected branch / consumption-gated spline aux never built).
  // renderFrame forces the node into the next pass exactly like a peek —
  // extraTargets + the spline handle marked consumed — then calls
  // makeEditableCompleteRef with the fresh outputs. The completion handler
  // is declared much further down (needs pushGraph/setNodes/etc.), hence
  // the ref indirection (same pattern as mcpHandlersRef).
  const pendingBakeRef = useRef<{ nodeId: string; handle: string } | null>(
    null
  );
  const makeEditableCompleteRef = useRef<((nodeId: string) => void) | null>(
    null
  );
  const peekHideTimerRef = useRef<number | null>(null);
  const clearSocketPeek = useCallback(() => {
    if (peekHideTimerRef.current !== null) {
      window.clearTimeout(peekHideTimerRef.current);
      peekHideTimerRef.current = null;
    }
    socketPeekRef.current = null;
    setSocketPeek(null);
  }, []);
  // Popover hover grace: entering the popover cancels a pending hide
  // (the pointer traveled from the socket into the panel), leaving it
  // dismisses immediately.
  const holdSocketPeek = useCallback(() => {
    if (peekHideTimerRef.current !== null) {
      window.clearTimeout(peekHideTimerRef.current);
      peekHideTimerRef.current = null;
    }
  }, []);
  useEffect(() => {
    const onPeek = (e: Event) => {
      const detail = (
        e as CustomEvent<{
          id: string;
          handle: string;
          anchorY?: number;
          hide?: boolean;
        }>
      ).detail;
      if (!detail) return;
      if (detail.hide) {
        const cur = socketPeekRef.current;
        if (!cur || cur.nodeId !== detail.id || cur.handle !== detail.handle) {
          return;
        }
        // Grace window before hiding so the pointer can reach the popover.
        if (peekHideTimerRef.current !== null) {
          window.clearTimeout(peekHideTimerRef.current);
        }
        peekHideTimerRef.current = window.setTimeout(() => {
          peekHideTimerRef.current = null;
          socketPeekRef.current = null;
          setSocketPeek(null);
        }, 250);
        return;
      }
      if (peekHideTimerRef.current !== null) {
        window.clearTimeout(peekHideTimerRef.current);
        peekHideTimerRef.current = null;
      }
      const next = {
        nodeId: detail.id,
        handle: detail.handle,
        anchorY: detail.anchorY ?? 0,
      };
      // Ref first: the pipeline-bump eval below must already see the
      // target when it runs.
      socketPeekRef.current = next;
      setSocketPeek(next);
      window.dispatchEvent(new Event("pipeline-bump"));
    };
    window.addEventListener("socket-peek", onPeek);
    return () => window.removeEventListener("socket-peek", onPeek);
  }, []);
  // Deleting (or scoping away) the peeked node closes the popover — its
  // EffectNode unmount also dispatches a hide, this covers replace-graph
  // paths (undo, load) that swap node arrays wholesale.
  useEffect(() => {
    if (socketPeek && !nodes.some((n) => n.id === socketPeek.nodeId)) {
      clearSocketPeek();
    }
  }, [nodes, socketPeek, clearSocketPeek]);
  // CPU readback for the peek popover's texture thumbnails — the engine's
  // pooled readback FBO, never blitToCanvas+getImageData (which resizes
  // the hidden canvas).
  const readPeekPixels = useCallback(
    (
      image:
        | import("@/engine/types").ImageValue
        | import("@/engine/types").MaskValue
        | import("@/engine/types").UvValue,
      width: number,
      height: number
    ) => {
      const backend = backendRef.current;
      if (!backend) return null;
      // readImagePixels types ImageValue but samples any texture-backed
      // value — mask/uv share the {texture,width,height} shape.
      return backend
        .makeContext(0, 0)
        .readImagePixels(
          image as import("@/engine/types").ImageValue,
          width,
          height
        );
    },
    []
  );
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
        // Row version (projects.updated_at) this editor is based on —
        // set at load and after each save, passed to updateProject as
        // the compare-and-swap guard so a stale window can't silently
        // clobber a save made elsewhere. Absent/null = no guard (e.g. a
        // freshly inserted row, or pre-plumbing paths).
        updatedAt?: string | null;
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
  // Layout presets follow the user, so (re)load whenever the signed-in
  // identity changes — signing in mid-session pulls the cloud copy over
  // the local-only one.
  useEffect(() => {
    let alive = true;
    loadLayoutPresets().then((list) => {
      if (alive) setLayoutPresets(list);
    });
    return () => {
      alive = false;
    };
  }, [user?.id]);
  // Window → Layouts → + New Preset…: capture the live tree under a name.
  const saveLayoutPreset = useCallback(
    (name: string) => {
      const next = upsertLayoutPreset(
        layoutPresets,
        name,
        layoutTreeRef.current
      );
      setLayoutPresets(next);
      void saveLayoutPresets(next);
    },
    [layoutPresets]
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
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
  // Apply the persisted UI-font choice (--ui-font on <html>). Post-hydration
  // on purpose; the editor renders one frame in the default mono at worst.
  useEffect(() => {
    applyStoredUiFont();
  }, []);
  // Same for the theme (--tb-* on <html>). The pre-paint script in
  // app/layout.tsx has normally already done this — re-running here makes the
  // module the authority after hydration and repairs a stale trim cache.
  useEffect(() => {
    applyStoredTheme();
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
  // Raw screen-px cursor position, tracked on every pointermove — the
  // keydown that opens the pie menu carries no mouse coords, so we read
  // the last-known pointer from here. Also the origin the pie's "Add
  // Node" item hands to the node-search popup.
  const lastPointerRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const cursorRef = useRef<{
    x: number;
    y: number;
    active: boolean;
    pressed: boolean;
  }>({
    x: 0.5,
    y: 0.5,
    active: false,
    pressed: false,
  });
  const [cursorTick, setCursorTick] = useState(0);
  // Mirror playback flags into a ref so the pointermove listener
  // (which lives in a setup-once useEffect) can read the live value
  // without re-binding listeners on every play / pause toggle.
  const playbackActiveRef = useRef(false);
  useEffect(() => {
    let rafId: number | null = null;
    let lastBumpedActive = false;
    let lastBumpedPressed = false;
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
          c.pressed === lastBumpedPressed &&
          Math.abs(c.x - lastBumpedX) < 1e-4 &&
          Math.abs(c.y - lastBumpedY) < 1e-4
        ) {
          return;
        }
        lastBumpedActive = c.active;
        lastBumpedPressed = c.pressed;
        lastBumpedX = c.x;
        lastBumpedY = c.y;
        setCursorTick((n) => n + 1);
      });
    };
    const onMove = (e: PointerEvent) => {
      lastPointerRef.current = { x: e.clientX, y: e.clientY };
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
      cursorRef.current = { x, y, active: inside, pressed: prev.pressed };
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
    // Primary-button press that STARTS inside the preview canvas box =
    // the drawing gesture (ctx.cursor.pressed — Cursor Trail Points).
    // Capture phase so overlay handlers that preventDefault their
    // pointerdown can't hide the press from the pipeline.
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const xr = (e.clientX - rect.left) / rect.width;
      const yr = (e.clientY - rect.top) / rect.height;
      if (xr < 0 || xr > 1 || yr < 0 || yr > 1) return;
      cursorRef.current = { ...cursorRef.current, pressed: true };
      scheduleBump();
    };
    const onUp = () => {
      const prev = cursorRef.current;
      if (!prev.pressed) return;
      cursorRef.current = { ...prev, pressed: false };
      scheduleBump();
    };
    window.addEventListener("pointermove", onMove);
    document.addEventListener("pointerleave", onLeave);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, []);

  // Timeline / playback state. The clock lives in the playback-clock
  // STORE (specdocs/071026_clock-store.md), not React state, and the
  // shell does NOT subscribe to it — playback no longer re-renders the
  // ~10k-line shell per frame. Consumers that track the playhead
  // (PlaybackBar, TrackEditor, the gizmo overlays, …) each hold their own
  // `useClock` subscription; the shell's own logic reads
  // `playbackClock.get()` at run time.
  // Writers keep the setState signature (value or updater) so the ~30
  // existing call sites — transport, seeks, export save/restore — stay
  // verbatim.
  const setTime = useCallback(
    (v: number | ((t: number) => number)) => {
      playbackClock.set({
        time: typeof v === "function" ? v(playbackClock.get().time) : v,
      });
    },
    []
  );
  const setPlaying = useCallback(
    (v: boolean | ((p: boolean) => boolean)) => {
      playbackClock.set({
        playing:
          typeof v === "function" ? v(playbackClock.get().playing) : v,
      });
    },
    []
  );
  // A fresh editor mount starts at t=0, paused — same as the old
  // useState(0)/useState(false). The module store would otherwise carry
  // the previous mount's playhead across a docs round-trip (the
  // editor-session stash deliberately doesn't include time).
  useEffect(() => {
    playbackClock.set({ time: 0, playing: false });
  }, []);
  const [fps, setFps] = useState(60);
  const [loopFrames, setLoopFrames] = useState<number | null>(null);
  // Per-parameter keyframe time model. `time` (seconds) remains the
  // source of truth for playback (RAF still ticks in seconds); `tick` is
  // the integer tick representation derived from time × fps × tpf, used
  // by the keyframe evaluator and Track Editor for exact equality.
  const ticksPerFrame = DEFAULT_TICKS_PER_FRAME;
  // Keep the store's tick derivation in sync with the project fps.
  // Callbacks that need the tick *at call time* (autokey) read
  // `playbackClock.get().tick` directly.
  useEffect(() => {
    playbackClock.configure({ fps, ticksPerFrame });
  }, [fps, ticksPerFrame]);
  const sceneDurationTicks =
    (loopFrames != null && loopFrames > 0 ? loopFrames : fps * 5) *
    ticksPerFrame;
  // Memoized: this object goes to LayersEditor/TrackEditor/GraphEditor as a
  // prop — a fresh identity every render (i.e. every rAF tick during
  // playback) would defeat any memoization below it.
  const projectTimeline: ProjectTimeline = useMemo(
    () => ({ ticksPerFrame, fps, sceneDurationTicks }),
    [ticksPerFrame, fps, sceneDurationTicks]
  );
  // Track Editor + Graph Editor UI state. The dock's floating host —
  // open state and geometry — is per-MACHINE window furniture, not
  // project content, so it lives in localStorage (same call as
  // viewport.previewScale). SSR renders it closed at the default rect
  // and the effect below rehydrates, so the markup stays deterministic.
  const [trackEditorOpen, setTrackEditorOpen] = useState(false);
  const [dockRect, setDockRect] = useState<DockRect>(defaultDockRect);
  const dockRectRef = useRef(dockRect);
  dockRectRef.current = dockRect;
  const [dockHydrated, setDockHydrated] = useState(false);
  useEffect(() => {
    const saved = readSavedDockRect();
    if (saved) setDockRect(saved);
    else setDockRect(clampDockRect(defaultDockRect()));
    try {
      if (window.localStorage.getItem(DOCK_OPEN_KEY) === "1") {
        setTrackEditorOpen(true);
      }
    } catch {
      /* private mode — open state just doesn't persist */
    }
    setDockHydrated(true);
  }, []);
  useEffect(() => {
    if (!dockHydrated) return;
    try {
      window.localStorage.setItem(DOCK_RECT_KEY, JSON.stringify(dockRect));
    } catch {
      /* ignore */
    }
  }, [dockRect, dockHydrated]);
  useEffect(() => {
    if (!dockHydrated) return;
    try {
      window.localStorage.setItem(DOCK_OPEN_KEY, trackEditorOpen ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [trackEditorOpen, dockHydrated]);
  // Shrinking the window must not strand the dock offscreen.
  useEffect(() => {
    const onResize = () => setDockRect((r) => clampDockRect(r));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // Slide-up animation for the floating dock. `mounted` keeps the dock
  // in the DOM through its exit slide; `shown` drives the transform
  // (false = parked below the window edge, true = at its rect).
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
  // Drag (by the toolbar's empty middle) and 8-way resize. Both write
  // the rect through the same clamp, so the dock can never be dragged
  // or sized out of reach. Suppressed while the slide-in is still
  // running so a stray press can't fight the transition.
  const [dockDragging, setDockDragging] = useState(false);
  // Touch primary → fatter grab zones on the dock's chrome. See the
  // handle array in the modal render for why corners grow more than edges.
  const coarsePointer = useCoarsePointer();
  const dockEdgeHit = coarsePointer ? 12 : 6;
  const dockCornerHit = coarsePointer ? 24 : 12;
  const startDockDrag = (e: React.PointerEvent<HTMLElement>) => {
    // Only the bar itself — not its buttons or the cluster wrappers.
    if (e.target !== e.currentTarget) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const start = dockRectRef.current;
    const started = startPointerDrag(e, {
      cursor: "grabbing",
      onMove: (ev) => {
        setDockRect(
          clampDockRect({
            ...start,
            x: start.x + (ev.clientX - startX),
            y: start.y + (ev.clientY - startY),
          })
        );
      },
      onUp: () => setDockDragging(false),
      // iOS pulled the gesture (scroll takeover, palm, backgrounding) —
      // put the dock back where it was rather than stranding it mid-move.
      onCancel: () => {
        setDockDragging(false);
        setDockRect(clampDockRect(start));
      },
    });
    if (!started) return;
    e.preventDefault();
    setDockDragging(true);
  };
  /** `edge` is any combination of n/s/e/w — corners pass two. */
  const startDockResize = (e: React.PointerEvent<HTMLElement>, edge: string) => {
    const startX = e.clientX;
    const startY = e.clientY;
    const start = dockRectRef.current;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      // Work in EDGES, not origin+size: only the dragged edges move, so
      // the opposite ones stay pinned. Each is clamped against both the
      // min size and the window, which is what keeps a north drag past
      // the menu bar from pushing the bottom edge down instead of just
      // stopping (an origin+size formulation rubber-bands there).
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = start.x;
      let top = start.y;
      let right = start.x + start.w;
      let bottom = start.y + start.h;
      if (edge.includes("e")) {
        right = Math.min(vw, Math.max(left + DOCK_MIN_W, right + dx));
      }
      if (edge.includes("w")) {
        left = Math.max(0, Math.min(right - DOCK_MIN_W, left + dx));
      }
      if (edge.includes("s")) {
        bottom = Math.min(
          vh - DOCK_BOTTOM_INSET,
          Math.max(top + DOCK_MIN_H, bottom + dy)
        );
      }
      if (edge.includes("n")) {
        top = Math.max(
          DOCK_TOP_INSET,
          Math.min(bottom - DOCK_MIN_H, top + dy)
        );
      }
      setDockRect({ x: left, y: top, w: right - left, h: bottom - top });
    };
    const started = startPointerDrag(e, {
      onMove,
      onUp: () => setDockDragging(false),
      onCancel: () => {
        setDockDragging(false);
        setDockRect(start);
      },
    });
    if (!started) return;
    e.preventDefault();
    e.stopPropagation();
    setDockDragging(true);
  };
  // Per-instance dock tab. The dock can be up in two hosts at once —
  // the floating modal and any number of `timeline` panels — and they
  // must not fight over which editor shows, so the tab is keyed by
  // instance id (DOCK_MODAL_ID / `leaf:<leafId>`) instead of global.
  // The dock's OTHER toggles stay global on purpose: they're either
  // preferences (selected-only, normalize, collapsed rows) or one-shot
  // action counters (fit, refit), and sharing those across hosts is
  // what you want — a "fit" fits every open dock.
  const [dockTabs, setDockTabs] = useState<Record<string, DockTab>>({});
  const dockTabFor = (instanceId: string): DockTab =>
    dockTabs[instanceId] ?? "tracks";
  const setDockTabFor = (instanceId: string, tab: DockTab) =>
    setDockTabs((prev) => ({ ...prev, [instanceId]: tab }));
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
  // During scrubbing the RAF driver is suspended so the drag can set time
  // directly without a running playback stepping on the mouse. `playing`
  // itself isn't touched, so clearing `scrubbing` restores the prior state —
  // a timeline that was paused before the drag stays paused.
  // (playbackActiveRef — the cursor-bump gate — is kept in sync by the
  // playback driver's store subscription, further down.)
  const [scrubbing, setScrubbing] = useState(false);

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
  const compositionsRef = useRef(compositions);
  compositionsRef.current = compositions;
  const activeCompositionIdRef = useRef(activeCompositionId);
  activeCompositionIdRef.current = activeCompositionId;
  const openCompositionIdsRef = useRef(openCompositionIds);
  openCompositionIdsRef.current = openCompositionIds;
  const assetsFolderRef = useRef(assetsFolder);
  assetsFolderRef.current = assetsFolder;
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
        // The AI Recipe composer is a transient view — never restore into it
        // across a docs round-trip; fall back to the node panel.
        paramView:
          paramViewRef.current === "ai-recipe" ||
          paramViewRef.current === "assets"
            ? "node"
            : paramViewRef.current,
        saveState: saveStateRef.current,
        canvasRes: canvasResRef.current,
        compositions: compositionsRef.current,
        activeCompositionId: activeCompositionIdRef.current,
        layoutTree: layoutTreeRef.current,
        primaryViewportLeafId: primaryViewportLeafIdRef.current,
      });
    };
  }, []);

  const getGraphSnapshot = useCallback(
    (): GraphSnapshot => ({
      nodes: nodesRef.current,
      edges: edgesRef.current,
      compositions: compositionsRef.current,
      activeCompositionId: activeCompositionIdRef.current,
    }),
    []
  );
  const applyGraphSnapshot = useCallback(
    (snap: GraphSnapshot) => {
      const prevActive = activeCompositionIdRef.current;
      setNodes(snap.nodes);
      setEdges(snap.edges);
      // Restore the composition registry (v5) so undo/redo of a comp
      // create/delete stays consistent with the nodes.
      if (snap.compositions) {
        const comps = snap.compositions;
        setCompositions(comps);
        const ids = new Set(comps.map((c) => c.id));
        setOpenCompositionIds((prev) => {
          const next = prev.filter((id) => ids.has(id));
          if (snap.activeCompositionId && !next.includes(snap.activeCompositionId))
            next.push(snap.activeCompositionId);
          return next.length ? next : comps.map((c) => c.id);
        });
      }
      if (snap.activeCompositionId)
        setActiveCompositionId(snap.activeCompositionId);
      // Re-scope only when the composition changed or the viewed scope node
      // vanished (e.g. undoing a comp create that removed the layer we were
      // in) — normal same-comp undos keep the user's current scope.
      setCurrentGroupId((cur) => {
        const activeChanged =
          !!snap.activeCompositionId && snap.activeCompositionId !== prevActive;
        const scopeGone = !!cur && !snap.nodes.some((n) => n.id === cur);
        return activeChanged || scopeGone
          ? defaultScopeFor(snap.nodes, snap.activeCompositionId)
          : cur;
      });
    },
    [setNodes, setEdges]
  );
  // Restoring paint pixels is only half of undo — the pipeline's input is the
  // `snapshot` ImageBitmap stashed on the paint param, so we refresh it from
  // the just-restored canvas and swap it in.
  const onPaintRestore = useCallback(
    (nodeId: string, canvas: HTMLCanvasElement) => {
      // premultiplyAlpha "none": paint snapshots must be straight-alpha —
      // WebGL ignores UNPACK_PREMULTIPLY_ALPHA_WEBGL for ImageBitmaps, and a
      // premultiplied upload double-applies alpha downstream (grey fringes
      // on soft strokes). Matches paint-editor/PaintOverlay's snapshot().
      createImageBitmap(canvas, { premultiplyAlpha: "none" }).then((bmp) => {
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
        // Run every node's dispose before dropping the backend: GL textures
        // die with the context either way, but DOM-side state (Text's hidden
        // canvases, media elements) would otherwise outlive it.
        try {
          disposeAllNodeState(backend.makeContext(0, 0));
        } catch (e) {
          console.error("node-state dispose on backend teardown failed", e);
        }
        backend.destroy();
        backendRef.current = null;
        setBackendReady(false);
      };
    } catch (e) {
      console.error("Engine init failed", e);
    }
  }, [renderRes]);

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

  // Wedge batch-render iteration. Set by the batch export driver around each
  // variation's render (exportWedged) and flowed into ctx.wedgeIndex by
  // renderFrame; undefined during normal editing, so Wedge nodes emit their
  // `preview` value. Never a React state — it must not trigger renders, and
  // the export loops read it synchronously. See
  // specdocs/071026_wedge-render-batching.md.
  const wedgeIndexRef = useRef<number | undefined>(undefined);

  // When set, forces the terminal/active node for the render — used by the
  // export paths so a batch render captures the *specific* Output being
  // exported, not whatever the user happens to have set Active. Cleared back
  // to null when the export finishes.
  const forcedTerminalRef = useRef<string | null>(null);

  // Preview dots for any selected node whose primary output is a points
  // value. Refreshed by renderFrame after each interactive render pass.
  // Stored as the typed-array PointsValue (not a materialized Point[])
  // so PointsOverlay can read positions without a per-frame alloc.
  const [selectedPoints, setSelectedPoints] = useState<PointsValue | null>(
    null
  );

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

      // Render only the active composition (v5). resolveComposition is a
      // no-op for a single composition; with several it isolates the one on
      // screen so other comps' Outputs / active nodes don't drive the preview.
      const { nodes: currentNodes, edges: currentEdges } = resolveComposition(
        nodesRef.current,
        edgesRef.current,
        activeCompositionIdRef.current
      );
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
        offlineRenderingRef.current,
        wedgeIndexRef.current
      );
      const inspectSet = inspectIdsRef.current;
      // Socket peek: force the peeked node to evaluate (it may be on a
      // disconnected branch) and mark the hovered handle consumed so
      // consumedOutputs-gating nodes build it. Skipped during offline
      // export — no popover is visible and the forced branch would only
      // slow the render.
      const peek = offlineRenderingRef.current ? null : socketPeekRef.current;
      // Make Editable bake target — forced into the pass the same way as a
      // peek so a disconnected/gated spline output produces real data.
      const bake = offlineRenderingRef.current ? null : pendingBakeRef.current;
      const forced = [peek, bake].filter(
        (f): f is { nodeId: string; handle: string } => !!f
      );
      const peekOpts = forced.length
        ? {
            extraTargets: forced.map((f) => f.nodeId),
            extraConsumed: forced.reduce((m, f) => {
              const key =
                f.handle === "out:primary"
                  ? "primary"
                  : f.handle.replace(/^out:/, "");
              m.set(f.nodeId, [...(m.get(f.nodeId) ?? []), key]);
              return m;
            }, new Map<string, string[]>()),
          }
        : undefined;
      const result = evaluateGraph(
        graphNodes,
        graphEdges,
        ctx,
        evalCacheRef.current,
        activeNodeId,
        inspectSet.size > 0 ? inspectSet : undefined,
        previewNodeId,
        peekOpts
      );
      lastEvalOutputsRef.current = result.outputs;
      // Re-render the peek popover with this pass's value (rAF-coalesced,
      // same tick as the inspector popups).
      if (peek) scheduleInspectBump();
      // Finish a pending Make Editable bake now that the target evaluated.
      // One-shot: clear before completing so a failure can't loop.
      if (bake) {
        pendingBakeRef.current = null;
        makeEditableCompleteRef.current?.(bake.nodeId);
      }
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
        broadcastAppEvent(
          () => new CustomEvent("node-timings", { detail: result.timings })
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
            // Nothing to show (no Active node, no wired Output). Clear to
            // transparent rather than filling a dark plate — the canvas
            // element's CSS checker then reads through, which is the same
            // "this is empty / transparent" signal a fully transparent
            // frame gives. The hint text still paints on top.
            c2d.clearRect(0, 0, target.width, target.height);
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

      // Tiled watch viewports (072726_window-tiling.md §5): every
      // non-primary viewport panel registers its canvas here and gets
      // the same terminal image — independent pan/zoom, one eval.
      for (const watchCanvas of watchCanvasesRef.current.values()) {
        blitOrPlaceholder(
          watchCanvas,
          result.terminalImage,
          "Connect an Output node to preview."
        );
      }

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

      // Refresh PointsOverlay's dots from this pass. Lived in a [time]-dep
      // effect before the shell detached from the clock; running after
      // every interactive render keeps the same cadence. Offline export
      // frames skip it (per-frame setState churn with no visible overlay).
      // Bails on same-reference so a points selection doesn't burn a shell
      // re-render per frame when the dots haven't changed.
      if (!offlineRenderingRef.current) {
        const selId = selectedIdRef.current;
        const primary = selId
          ? evalCacheRef.current.get(selId)?.output.primary
          : undefined;
        if (primary && primary.kind === "points") {
          setSelectedPoints((prev) => (prev === primary ? prev : primary));
        } else {
          setSelectedPoints((prev) => (prev === null ? prev : null));
        }
      }
    },
    [backendReady]
  );
  const renderFrameRef = useRef(renderFrame);
  renderFrameRef.current = renderFrame;

  // STATE-driven eval: graph edits, params (structFp), fps, pipeline bumps
  // (font load / video frame / image gen), cursor moves, and selection
  // changes re-render the current frame. Clock-driven renders (playback,
  // seeks, scrubs) come from the imperative driver below — `time` and
  // `playing` are store state, not React state, and are read at run time.
  useEffect(() => {
    if (offlineRenderingRef.current) return;
    const clock = playbackClock.get();
    renderFrame(clock.time, fps, clock.playing && !scrubbing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    structFp,
    backendReady,
    fps,
    pipelineBumpKey,
    cursorTick,
    scrubbing,
    // Re-render when the selection changes so the selected-node preview
    // (when nothing is set Active) updates on the canvas.
    selectedId,
    // Toggling split view mounts/unmounts the second canvas; re-render so it
    // paints immediately instead of showing a blank checkerboard until an
    // unrelated eval (cursor move, param edit) happens to fire. See 072226
    // audit #7 / editor quick win.
    viewportSplit,
    // Same rule for tiled watch viewports: a layout change that adds a
    // viewport leaf must paint it now, not on the next unrelated eval.
    viewportLeafSig,
  ]);

  // CLOCK-driven eval — the playback driver, imperative and outside React
  // (clock-store spec, shell detach). While playing, a rAF loop advances
  // the store clock by real elapsed dt (so a dropped frame doesn't shorten
  // scene duration; `loopFrames / fps` defines the wrap point in seconds,
  // and the wrap is what sim zones watch to re-seed) and calls renderFrame
  // directly. While paused or scrubbing, any time/playing write to the
  // store — transport seeks, timeline scrubs, export state restores —
  // schedules ONE coalesced render on the next animation frame with a
  // false playing hint, exactly what the old eval effect's `time`/`playing`
  // deps produced. Detached consumers (playheads, diamonds, readouts)
  // re-render through their own store subscriptions.
  useEffect(() => {
    let raf = 0; // playing-loop handle
    let oneShot = 0; // pending paused-render handle
    let prev = 0;
    const step = (now: number) => {
      raf = requestAnimationFrame(step);
      const dt = (now - prev) / 1000;
      prev = now;
      let next = playbackClock.get().time + dt;
      if (loopFrames != null) {
        const loopSecs = loopFrames / fps;
        if (loopSecs > 0 && next >= loopSecs) next = next % loopSecs;
      }
      playbackClock.set({ time: next });
      if (!offlineRenderingRef.current) {
        renderFrameRef.current(next, fps, true);
      }
    };
    // Start/stop the loop to match the play state; returns whether it's
    // running. Also keeps the cursor-bump gate in sync (its old
    // [playing, scrubbing] effect can't fire anymore — the shell doesn't
    // re-render on play state).
    const syncLoop = () => {
      const active = playbackClock.get().playing && !scrubbing;
      playbackActiveRef.current = active;
      if (active && !raf) {
        if (oneShot) {
          cancelAnimationFrame(oneShot);
          oneShot = 0;
        }
        prev = performance.now();
        raf = requestAnimationFrame(step);
      } else if (!active && raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      return active;
    };
    let last = playbackClock.get();
    const onStoreChange = () => {
      const s = playbackClock.get();
      const changed = s.time !== last.time || s.playing !== last.playing;
      last = s;
      if (syncLoop() || !changed || oneShot) return;
      oneShot = requestAnimationFrame(() => {
        oneShot = 0;
        // Re-check at fire time: an export can take over rendering
        // between the store write and this frame.
        if (offlineRenderingRef.current) return;
        renderFrameRef.current(playbackClock.get().time, fps, false);
      });
    };
    const unsub = playbackClock.subscribe(onStoreChange);
    syncLoop();
    return () => {
      unsub();
      if (raf) cancelAnimationFrame(raf);
      if (oneShot) cancelAnimationFrame(oneShot);
    };
  }, [scrubbing, loopFrames, fps]);

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

  // Auto-grow the input sockets of Proximity Join/Merge and Spline Interpolate
  // nodes: keep each one's `slots` param equal to (connected sockets, in stable
  // order) + exactly one trailing empty spare. Derived purely from edges, so
  // it's undo-safe (edges are in history; slots follow them) and needs no
  // pushGraph snapshot. Runs whenever edges change — connect fills a spare →
  // next spare appears; disconnect prunes the emptied middle. (The `t`/`mask`
  // name exclusions below are for Proximity Merge; Spline Interpolate has
  // neither input, so they're inert there.)
  //
  // Merge grows here too, but grow-only: once every layer's image socket is
  // wired, append a fresh layer so there's always an open one. No pruning —
  // merge layers carry user state (mode/opacity/enabled), so emptied layers
  // are only removed explicitly via the layers param UI.
  useEffect(() => {
    setNodes((prev) => {
      let changed = false;
      const next = prev.map((n) => {
        if (n.data.defType === "merge") {
          const layers = Array.isArray(n.data.params.layers)
            ? (n.data.params.layers as MergeLayer[])
            : [];
          const connected = new Set<string>();
          for (const e of edges) {
            if (e.target !== n.id) continue;
            const parsed = parseTargetHandleKind(e.targetHandle ?? "");
            if (parsed?.kind === "input") connected.add(parsed.name);
          }
          if (!layers.every((l) => connected.has(`layer:${l.id}`))) return n;
          changed = true;
          return withUpdatedParams(n, {
            ...n.data.params,
            layers: [
              ...layers,
              { id: newLayerId(), mode: "normal", opacity: 1 },
            ],
          });
        }
        if (
          n.data.defType !== "proximity-merge" &&
          n.data.defType !== "spline-interpolate" &&
          n.data.defType !== "sdf-smooth-union"
        )
          return n;
        // Each auto-grow node's starting slot list. SDF Smooth Union
        // seeds with its original a/b socket names so saved projects
        // keep their wires.
        const seed =
          n.data.defType === "sdf-smooth-union" ? ["a", "b"] : ["in"];
        const raw = n.data.params.slots;
        const current: string[] =
          Array.isArray(raw) &&
          raw.every((x) => typeof x === "string") &&
          raw.length
            ? (raw as string[])
            : seed;
        // Socket names wired into this node (exclude the t + mask inputs).
        const connected = new Set<string>();
        for (const e of edges) {
          if (e.target !== n.id) continue;
          const parsed = parseTargetHandleKind(e.targetHandle ?? "");
          if (parsed?.kind !== "input") continue;
          // Fixed (non-slot) sockets these nodes declare alongside the
          // auto-grow list: t/mask, and Spline Interpolate's blend spine
          // (spec 072726 M4) — wiring them must not mint a slot.
          if (
            parsed.name === "t" ||
            parsed.name === "mask" ||
            parsed.name === "spine" ||
            // SDF Smooth Union's scalar Smoothness input.
            parsed.name === "smoothness"
          )
            continue;
          connected.add(parsed.name);
        }
        // Keep connected slots in their current order, append any newly
        // connected names, then one empty spare (reuse the existing empty
        // slot's name while it stays empty so the DOM socket is stable).
        const kept = current.filter((s) => connected.has(s));
        for (const name of connected) if (!kept.includes(name)) kept.push(name);
        let spare = current.find((s) => !connected.has(s));
        if (spare === undefined || kept.includes(spare)) {
          let k = 0;
          const taken = new Set(kept);
          while (taken.has(`s${k}`)) k++;
          spare = `s${k}`;
        }
        const desired = [...kept, spare];
        if (
          desired.length === current.length &&
          desired.every((s, i) => s === current[i])
        ) {
          return n;
        }
        changed = true;
        return withUpdatedParams(n, { ...n.data.params, slots: desired });
      });
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edges]);

  // Sync the socket types of the connectedTypes-retyping nodes that have NO
  // stored `mode` param (Transform, Displace). Their inputs + primary output
  // retype from whatever's wired (image / spline / points) via resolveInputs /
  // resolvePrimaryOutput reading `connectedTypes` — but the generic socket-
  // refresh paths call those resolvers WITHOUT a connectedTypes map, so the
  // node's stored `data.primaryOutput` stays "image". Consequence: the engine
  // displaces/transforms a wired spline correctly, but the node's OUTPUT socket
  // still reads "image" in the UI, so you can't wire the result into a spline
  // consumer. Derive the types from edges here (undo-safe — edges are in
  // history; no pushGraph needed) and write the resolved sockets back. The
  // small fixpoint lets a chain of these nodes (Transform → Displace) converge
  // in one pass.
  // Re-run the poly-socket sync when edges change OR any node's output type
  // changes — an upstream mode flip (Copy-to-Points image→spline, Math) can
  // change what a Transform/Displace sees without touching edges. Positions /
  // most param edits don't alter this string, so drags don't re-run it; the
  // effect's changed-guard makes the extra run a no-op once converged.
  // A retype node's own params also feed its resolvers (Switch's Count mints
  // slots, its Type pins the family), and the param-edit path deliberately
  // leaves these nodes' sockets alone — so their params belong in the
  // signature too, or a Count bump wouldn't grow the node until the next edge
  // change. Only for the retype set: the other nodes' params churn constantly
  // and re-running this for them would be pure waste.
  const polyOutTypeSig = useMemo(
    () =>
      nodes
        .map((n) =>
          CONNECTED_TYPE_RETYPE_NODES.has(n.data.defType)
            ? `${n.id}:${n.data.primaryOutput ?? ""}:${JSON.stringify(n.data.params)}`
            : `${n.id}:${n.data.primaryOutput ?? ""}`
        )
        .join("|"),
    [nodes]
  );
  useEffect(() => {
    setNodes((prev) => {
      if (!prev.some((n) => CONNECTED_TYPE_RETYPE_NODES.has(n.data.defType))) {
        return prev;
      }
      const byId = new Map(prev.map((n) => [n.id, n]));
      // Working map of each node's resolved primary-output type, seeded from
      // the stored values and iterated so poly-node chains settle.
      const outType = new Map<string, string | null | undefined>();
      for (const n of prev) {
        outType.set(n.id, n.data.primaryOutput);
      }
      const connectedTypesOf = (
        nodeId: string
      ): Record<string, SocketType | undefined> => {
        const ct: Record<string, SocketType | undefined> = {};
        for (const e of edges) {
          if (e.target !== nodeId) continue;
          const tp = parseTargetHandleKind(e.targetHandle ?? "");
          if (tp?.kind !== "input") continue;
          const src = byId.get(e.source);
          if (!src) continue;
          let t: string | null | undefined;
          if (e.sourceHandle === "out:primary") {
            t = outType.get(src.id);
          } else if (e.sourceHandle?.startsWith("out:aux:")) {
            const an = e.sourceHandle.slice("out:aux:".length);
            t = src.data.auxOutputs.find((a) => a.name === an)?.type;
          }
          if (t) ct[tp.name] = t as SocketType;
        }
        return ct;
      };
      for (let pass = 0; pass < prev.length; pass++) {
        let moved = false;
        for (const n of prev) {
          if (!CONNECTED_TYPE_RETYPE_NODES.has(n.data.defType)) continue;
          const def = getNodeDef(n.data.defType);
          if (!def) continue;
          const rc: ResolveCtx = { connectedTypes: connectedTypesOf(n.id) };
          const next =
            def.resolvePrimaryOutput?.(n.data.params, rc) ?? def.primaryOutput;
          if (outType.get(n.id) !== next) {
            outType.set(n.id, next);
            moved = true;
          }
        }
        if (!moved) break;
      }
      let changed = false;
      const nextNodes = prev.map((n) => {
        if (!CONNECTED_TYPE_RETYPE_NODES.has(n.data.defType)) return n;
        const def = getNodeDef(n.data.defType);
        if (!def) return n;
        const rc: ResolveCtx = { connectedTypes: connectedTypesOf(n.id) };
        const nextPrimary =
          def.resolvePrimaryOutput?.(n.data.params, rc) ?? def.primaryOutput;
        const nextInputs = withMaskInput(
          def.resolveInputs?.(n.data.params, rc) ?? def.inputs,
          def
        ).map((i) => ({
          name: i.name,
          label: i.label,
          type: i.type,
          hidden: i.hidden,
        }));
        const nextAux = (
          def.resolveAuxOutputs?.(n.data.params) ?? def.auxOutputs
        ).map((a) => ({
          name: a.name,
          label: a.label,
          type: a.type,
          disabled: a.disabled,
        }));
        if (
          n.data.primaryOutput === nextPrimary &&
          JSON.stringify(n.data.inputs) === JSON.stringify(nextInputs) &&
          JSON.stringify(n.data.auxOutputs) === JSON.stringify(nextAux)
        ) {
          return n;
        }
        changed = true;
        return {
          ...n,
          data: {
            ...n.data,
            primaryOutput: nextPrimary,
            inputs: nextInputs,
            auxOutputs: nextAux,
          },
        };
      });
      return changed ? nextNodes : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edges, polyOutTypeSig]);

  const onConnect = useCallback(
    (connection: Connection) => {
      pushGraph(getGraphSnapshot());

      // Piping an EXTERIOR node into an Iteration Output absorbs it —
      // and its iteration-dependent upstream chain (the nodes with
      // pending index/t/random wires) — into the zone
      // (071926_iterate-zone-view.md: build outside, pipe in, the
      // highlight grows). Land the wire first (virtual mint or plain
      // edge), then expand membership; crossing edges heal through the
      // boundary machinery inside the absorb op.
      {
        const tgt = nodesRef.current.find((n) => n.id === connection.target);
        const src = nodesRef.current.find((n) => n.id === connection.source);
        if (
          tgt?.data.defType === ITERATE_TYPE &&
          src &&
          src.data.parentId === tgt.data.parentId
        ) {
          const base = connectToVirtualSocket(
            nodesRef.current,
            edgesRef.current,
            connection
          ) ?? {
            nodes: nodesRef.current,
            edges: [
              ...edgesRef.current.filter(
                (e) =>
                  !(
                    e.target === connection.target &&
                    e.targetHandle === connection.targetHandle
                  )
              ),
              {
                id: newEdgeId(),
                source: connection.source,
                sourceHandle: connection.sourceHandle,
                target: connection.target,
                targetHandle: connection.targetHandle,
              },
            ],
          };
          const absorbed = absorbIntoIterateZone(
            base.nodes,
            base.edges,
            tgt.id,
            src.id
          );
          setNodes(absorbed?.nodes ?? base.nodes);
          setEdges(absorbed?.edges ?? base.edges);
          return;
        }
      }

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

      // A wire drawn across an Iterate zone's boundary auto-mints the
      // boundary socket and routes through it
      // (071926_iterate-zone-view.md — auto-interface).
      const zoneRouted = connectAcrossIterateBoundary(
        nodesRef.current,
        edgesRef.current,
        connection
      );
      if (zoneRouted) {
        // No toast needed — the minted boundary socket + the two landed
        // wires make the routing visible in place.
        setNodes(zoneRouted.nodes);
        setEdges(zoneRouted.edges);
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
          prev.map((n) =>
            n.id === targetNode.id
              ? withUpdatedParams(n, { ...n.data.params, mode: "uv" })
              : n
          )
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
        text_instance: "text",
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
          prev.map((n) =>
            n.id === targetNode.id
              ? // withUpdatedParams also re-resolves aux outputs — this
                // inline copy had drifted and skipped them.
                withUpdatedParams(n, { ...n.data.params, mode: nextMode })
              : n
          )
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
  // primitives. The toast renders as a compact chip in the MenuBar's
  // right cluster (left of the account button); every message is also
  // appended to `consoleLog`, the history shown by the chip's draggable
  // console window (MessageConsole.tsx).
  const [toast, setToast] = useState<string | null>(null);
  const [consoleLog, setConsoleLog] = useState<ConsoleEntry[]>([]);
  const consoleIdRef = useRef(0);
  const toastTimeoutRef = useRef<number | null>(null);
  const flashToast = useCallback((message: string) => {
    setToast(message);
    setConsoleLog((prev) => {
      const next = prev.concat({
        id: ++consoleIdRef.current,
        text: message,
        at: Date.now(),
      });
      // Cap the history so a long session can't grow it unbounded.
      return next.length > 200 ? next.slice(next.length - 200) : next;
    });
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    toastTimeoutRef.current = window.setTimeout(() => setToast(null), 1500);
  }, []);
  useEffect(
    () => () => {
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    },
    []
  );

  // ---- Claude MCP bridge (spec 070926_claude-mcp-bridge.md) ----
  // The handler map is assembled further down (buildMcpHandlers needs
  // callbacks that aren't declared yet — commitRecipeFragment,
  // onParamChange, the time/fps/playing refs); the bridge reads it through
  // this ref at command time, so declaration order only matters here.
  const mcpHandlersRef = useRef<BridgeHandlers>({});
  const mcp = useMcpBridge(mcpHandlersRef);
  const mcpState = mcp.status.state;
  const prevMcpStateRef = useRef(mcpState);
  useEffect(() => {
    const prev = prevMcpStateRef.current;
    prevMcpStateRef.current = mcpState;
    if (prev === mcpState) return;
    if (mcpState === "connected") flashToast("Claude connected");
    else if (prev === "connected") flashToast("Claude disconnected");
  }, [mcpState, flashToast]);

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

  // Zone-view drop-to-reparent (071926_iterate-zone-view.md): NodeEditor
  // hit-tests the drag against expanded zone rects; legality
  // (boundary/cycle/wire rules) lives in the pure graph-op.
  const handleReparentNode = useCallback(
    (nodeId: string, newParentId: string | undefined) => {
      const res = reparentNode(
        nodesRef.current,
        edgesRef.current,
        nodeId,
        newParentId
      );
      if (!res) {
        flashToast("can't cross the zone boundary with wires attached");
        return;
      }
      pushGraph(getGraphSnapshot());
      setNodes(res.nodes);
      const shell = nodesRef.current.find((n) => n.id === newParentId);
      flashToast(
        shell?.data.defType === ITERATE_TYPE
          ? "moved into the zone"
          : "moved out of the zone"
      );
    },
    [pushGraph, getGraphSnapshot, setNodes, flashToast]
  );

  // Cosmetic tint / bold from the right-click menu
  // (073026_node-cosmetics-and-frames.md). One pushGraph + one setNodes =
  // one undo step; clearing deletes the field so untouched nodes stay
  // envelope-free in saves.
  const handleStyleNodes = useCallback(
    (ids: string[], patch: { tint?: string | null; bold?: boolean }) => {
      if (ids.length === 0) return;
      const idSet = new Set(ids);
      pushGraph(getGraphSnapshot());
      setNodes((prev) =>
        prev.map((n) => {
          if (!idSet.has(n.id)) return n;
          const data = { ...n.data };
          if (patch.tint !== undefined) {
            if (patch.tint === null) delete data.tint;
            else data.tint = patch.tint;
          }
          if (patch.bold !== undefined) {
            if (patch.bold) data.bold = true;
            else delete data.bold;
          }
          return { ...n, data };
        })
      );
    },
    [pushGraph, getGraphSnapshot, setNodes]
  );

  // Frame membership from drag gestures (NodeEditor owns the hit-test —
  // computeFrameRects — so "visually inside" and "joins" agree).
  const handleSetNodeFrame = useCallback(
    (nodeId: string, frameId: string | undefined) => {
      const node = nodesRef.current.find((n) => n.id === nodeId);
      if (!node || node.data.frameId === frameId) return;
      pushGraph(getGraphSnapshot());
      setNodes((prev) =>
        prev.map((n) => {
          if (n.id !== nodeId) return n;
          const data = { ...n.data };
          if (frameId) data.frameId = frameId;
          else delete data.frameId;
          return { ...n, data };
        })
      );
      flashToast(frameId ? "added to frame" : "removed from frame");
    },
    [pushGraph, getGraphSnapshot, setNodes, flashToast]
  );

  // Shift+F — frame the selection (073026_node-cosmetics-and-frames.md).
  // Selected nodes outside the current scope resolve up their parent chain
  // to their scope-level ancestor (selecting Iterate-zone members frames
  // the shell); frames themselves never nest. With nothing selected, an
  // empty default-size frame lands at the cursor to be filled by dragging
  // nodes in.
  const handleFrameSelection = useCallback(() => {
    const all = nodesRef.current;
    const scope = currentGroupIdRef.current;
    const byId = new Map(all.map((n) => [n.id, n]));
    const memberIds = new Set<string>();
    for (const n of all) {
      if (!n.selected) continue;
      let cur: typeof n | undefined = n;
      for (
        let hops = 0;
        cur && cur.data.parentId !== scope && hops < all.length;
        hops++
      ) {
        cur = cur.data.parentId ? byId.get(cur.data.parentId) : undefined;
      }
      if (cur && cur.data.parentId === scope && cur.data.defType !== FRAME_TYPE) {
        memberIds.add(cur.id);
      }
    }
    pushGraph(getGraphSnapshot());
    if (memberIds.size === 0) {
      const base = lastPanePointerRef.current ?? { x: 200, y: 200 };
      const frame = spawnNode(FRAME_TYPE, base);
      setNodes((prev) => [...prev, frame]);
      flashToast("empty frame added — drag nodes in");
      return;
    }
    // Fit the new frame around its members immediately (the reconciliation
    // effect below would snap it next commit anyway; doing it here avoids a
    // one-frame flash of the default box).
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const id of memberIds) {
      const m = byId.get(id)!;
      minX = Math.min(minX, m.position.x);
      minY = Math.min(minY, m.position.y);
      maxX = Math.max(maxX, m.position.x + (m.measured?.width ?? 220));
      maxY = Math.max(maxY, m.position.y + (m.measured?.height ?? 100));
    }
    const frame = spawnNode(FRAME_TYPE, {
      x: minX - FRAME_PADDING,
      y: minY - FRAME_PADDING,
    });
    frame.data.uiWidth = maxX - minX + FRAME_PADDING * 2;
    frame.data.uiHeight = maxY - minY + FRAME_PADDING * 2;
    setNodes((prev) => [
      ...prev.map((n) =>
        memberIds.has(n.id)
          ? { ...n, data: { ...n.data, frameId: frame.id } }
          : n
      ),
      frame,
    ]);
    flashToast(`framed ${memberIds.size} node${memberIds.size === 1 ? "" : "s"}`);
  }, [pushGraph, getGraphSnapshot, setNodes, spawnNode, flashToast]);

  // Frames hug their members: after any graph change, snap each membered
  // frame's box to its computed rect (Blender shrink-to-fit; the rect
  // deliberately excludes the frame's own box — FrameNode.tsx). Derived
  // state — plain setNodes, no pushGraph: undo restores the members and
  // the box re-derives; the diff guard makes it converge in one pass.
  useEffect(() => {
    if (!nodes.some((n) => n.data.defType === FRAME_TYPE)) return;
    const rects = computeFrameRects(nodes);
    const updates = new Map<
      string,
      { x: number; y: number; w: number; h: number }
    >();
    for (const f of nodes) {
      if (f.data.defType !== FRAME_TYPE) continue;
      const r = rects.find((z) => z.frameId === f.id);
      if (!r) continue;
      const w = f.data.uiWidth ?? FRAME_DEFAULT_W;
      const h = f.data.uiHeight ?? FRAME_DEFAULT_H;
      if (
        Math.abs(f.position.x - r.bbox.x) > 0.5 ||
        Math.abs(f.position.y - r.bbox.y) > 0.5 ||
        Math.abs(w - r.bbox.width) > 0.5 ||
        Math.abs(h - r.bbox.height) > 0.5
      ) {
        updates.set(f.id, {
          x: r.bbox.x,
          y: r.bbox.y,
          w: r.bbox.width,
          h: r.bbox.height,
        });
      }
    }
    if (updates.size === 0) return;
    setNodes((prev) =>
      prev.map((n) => {
        const u = updates.get(n.id);
        if (!u) return n;
        return {
          ...n,
          position: { x: u.x, y: u.y },
          data: { ...n.data, uiWidth: u.w, uiHeight: u.h },
        };
      })
    );
  }, [nodes, setNodes]);

  // If the scope group vanishes from the graph (undo of the group's
  // creation, deletion from outside, project load), fall back to root.
  // Navigation state is not part of undo history, so this is the only
  // guard needed.
  useEffect(() => {
    if (currentGroupId && !nodes.some((n) => n.id === currentGroupId)) {
      setCurrentGroupId(undefined);
    }
  }, [nodes, currentGroupId]);

  // Commit a freshly-built source node into the graph. At strict root it
  // becomes its own layer (named `label`), wired into the layer's Group
  // Output so it shows immediately; inside a scope it just drops in. Shared
  // by the file-drop and asset-drop paths. Caller pushes undo first.
  const placeSourceNode = useCallback(
    (newNode: Node<NodeDataPayload>, label: string) => {
      if (!currentGroupIdRef.current) {
        const res = createLayer(
          nodesRef.current,
          edgesRef.current,
          { name: label },
          activeCompositionIdRef.current
        );
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
    [setNodes, setEdges, navigateScope]
  );

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
          // Keep the encoded source bytes so save inlines the original file
          // instead of a ~10× PNG re-encode of the decoded bitmap.
          registerImageOriginal(bmp, file);
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
      placeSourceNode(newNode, fileLabel(file.name));
    },
    [pushGraph, getGraphSnapshot, spawnNode, placeSourceNode, flashToast]
  );

  // Clipboard SVG text pasted over the flow (Figma "Copy as SVG" markup or
  // a bare path `d` string) → a Spline Draw node pre-loaded with the parsed
  // paths, immediately pen-tool-editable. parseSvgPasteText contain-fits the
  // geometry inside the visible canvas. An .svg FILE on the clipboard still
  // routes through onAddFileNode (→ SVG Source). Spec: 073026_svg-paste.md.
  const handlePasteSvgText = useCallback(
    async (text: string, flowPos: { x: number; y: number }) => {
      try {
        const mod = await import("@/lib/svg-parse");
        const [w, h] = canvasResRef.current;
        const subpaths = mod.parseSvgPasteText(text, w / Math.max(1, h));
        if (subpaths.length === 0) {
          flashToast("No paths found in the pasted SVG");
          return;
        }
        pushGraph(getGraphSnapshot());
        const node = spawnNode("spline-draw", flowPos);
        node.data.params = { ...node.data.params, spline: { subpaths } };
        placeSourceNode(node, "Pasted SVG");
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("Failed to parse pasted SVG:", err);
        flashToast(
          err instanceof Error ? err.message : "Couldn't parse pasted SVG"
        );
      }
    },
    [pushGraph, getGraphSnapshot, spawnNode, placeSourceNode, flashToast]
  );

  // Drag an asset from the Assets panel into the node editor. Folder media
  // (image/svg/video/audio) read their bytes and route through onAddFileNode
  // (→ Source node); a font becomes a Text node preset to it. See M-A4.
  const onAddAssetNode = useCallback(
    async (
      payload: { source: string; kind: string; ref: string; name: string },
      flowPos: { x: number; y: number }
    ) => {
      try {
        if (payload.kind === "font") {
          pushGraph(getGraphSnapshot());
          const node = spawnNode("text", flowPos);
          if (payload.source === "folder") {
            const folder = assetsFolderRef.current;
            const r = folder ? await folder.read(payload.ref) : null;
            if (!r) return void flashToast("Couldn't read that font.");
            const { registerCustomFontFromBuffer } = await import("@/lib/fonts");
            const fv = await registerCustomFontFromBuffer(r.bytes, {
              filename: r.name,
            });
            node.data.params = { ...node.data.params, custom_font: fv };
          } else {
            node.data.params = {
              ...node.data.params,
              custom_font: { family: payload.ref, filename: payload.name },
            };
          }
          node.data.name =
            (payload.name || "Text").replace(/\.[^/.]+$/, "") || "Text";
          placeSourceNode(node, node.data.name);
          return;
        }
        // Folder media → its Source node (reuse the file-drop path).
        const folder = assetsFolderRef.current;
        const r = folder ? await folder.read(payload.ref) : null;
        if (!r) return void flashToast("Couldn't read that asset.");
        await onAddFileNode(new File([r.bytes], r.name, { type: r.type }), flowPos);
      } catch (err) {
        flashToast(err instanceof Error ? err.message : "Couldn't add asset");
      }
    },
    [pushGraph, getGraphSnapshot, spawnNode, placeSourceNode, onAddFileNode, flashToast]
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

  // Read the Keyer node's wired input image as CPU pixels for the
  // draw-to-sample overlay (sample mode). Reads the upstream's last eval
  // output — same freshness contract as getRefImageBlob — through
  // readImagePixels (the sanctioned readback; blitToCanvas+getImageData
  // resizes the engine's hidden canvas). Downsampled: color sampling
  // doesn't need full res, and the stroke captures once per pointerdown.
  const getKeyerSourcePixels = useCallback(
    (keyerNodeId: string): KeyerSourcePixels | null => {
      const inEdge = edgesRef.current.find(
        (e) => e.target === keyerNodeId && e.targetHandle === "in:image"
      );
      if (!inEdge) return null;
      const out =
        evalCacheRef.current.get(inEdge.source)?.output ??
        lastEvalOutputsRef.current?.get(inEdge.source);
      const handle = inEdge.sourceHandle ?? "out:primary";
      const val = handle.startsWith("out:aux:")
        ? out?.aux?.[handle.slice("out:aux:".length)]
        : out?.primary;
      if (!val || typeof val !== "object" || !("kind" in val)) return null;
      if (val.kind !== "image") return null;
      const backend = backendRef.current;
      if (!backend) return null;
      const ctx = backend.makeContext(0, 0);
      const scale = Math.min(1, 512 / Math.max(val.width, val.height));
      const w = Math.max(1, Math.round(val.width * scale));
      const h = Math.max(1, Math.round(val.height * scale));
      const data = ctx.readImagePixels(val, w, h);
      return data ? { data, width: w, height: h } : null;
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
        registerImageOriginal(bitmap, blob);
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

  // Commit a built recipe fragment (group shell + boundary + interior) onto
  // the canvas: undo snapshot, scope resolution, clone with fresh ids,
  // select. Shared by the in-app AI panel (handleGenerateRecipe) and the MCP
  // bridge's insert_recipe. The scope is re-read at commit time — for the
  // panel that's tens of seconds after submit, and if the user deleted the
  // scope mid-flight, inserting under it would orphan the new nodes (dangling
  // parentId). Fall back to root, which wraps into a fresh layer.
  const commitRecipeFragment = useCallback(
    (
      frag: { nodes: Node<NodeDataPayload>[]; edges: Edge[] },
      warningCount: number
    ): { groupId: string | null; wrapped: boolean } => {
      pushGraph(getGraphSnapshot());
      const base = lastPanePointerRef.current ?? { x: 200, y: 200 };
      let targetScope = currentGroupIdRef.current;
      let baseNodes = nodesRef.current;
      let baseEdges = edgesRef.current;
      if (targetScope && !baseNodes.some((n) => n.id === targetScope)) {
        targetScope = undefined;
      }
      let wrapped: string | null = null;
      if (!targetScope) {
        const res = createLayer(baseNodes, baseEdges, undefined, activeCompositionIdRef.current);
        baseNodes = res.nodes;
        baseEdges = res.edges;
        targetScope = res.layerId;
        wrapped = res.layerId;
      }
      const minX = Math.min(...frag.nodes.map((n) => n.position.x));
      const minY = Math.min(...frag.nodes.map((n) => n.position.y));
      const offset = { x: base.x - minX, y: base.y - minY };
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
      const groupClone = newNodes.find((n) => n.data.defType === GROUP_TYPE);
      if (wrapped) {
        navigateScope(wrapped);
        setNodes((prev) =>
          prev.map((n) =>
            newNodes.some((c) => c.id === n.id) ? { ...n, selected: true } : n
          )
        );
      }
      if (groupClone) setSelectedId(groupClone.id);
      setParamView("node");
      const note = warningCount
        ? ` (${warningCount} note${warningCount > 1 ? "s" : ""})`
        : "";
      flashToast(`recipe added${wrapped ? " to a new layer" : ""}${note}`);
      return { groupId: groupClone?.id ?? null, wrapped: !!wrapped };
    },
    [pushGraph, getGraphSnapshot, flashToast, navigateScope]
  );

  // AI Recipe: generate a node-group from a text prompt, validate it
  // client-side (the engine lives here), and insert it on the canvas exactly
  // like a preset. Mirrors the `preset:*` branch of onAddNode below — kept as
  // its own callback so onAddNode's huge dependency list stays untouched.
  const handleGenerateRecipe = useCallback(
    async (
      prompt: string,
      onProgress?: (e: AiProgress) => void
    ): Promise<{ ok: boolean; message?: string }> => {
      let result;
      try {
        result = await generateRecipe(prompt, { onProgress });
      } catch (e) {
        return { ok: false, message: (e as Error)?.message ?? "Generation failed." };
      }
      if (!result.ok || !result.nodes || !result.edges) {
        return {
          ok: false,
          message: result.errors[0] ?? "Couldn't build a valid recipe from that — try rephrasing.",
        };
      }
      commitRecipeFragment(
        { nodes: result.nodes, edges: result.edges },
        result.warnings.length
      );
      return { ok: true };
    },
    [commitRecipeFragment]
  );

  // Right-click a group → "Edit with AI": open the AI panel in edit mode
  // targeting that group.
  const handleEditWithAI = useCallback((nodeId: string) => {
    const node = nodesRef.current.find((n) => n.id === nodeId);
    if (!node || node.data.defType !== GROUP_TYPE) return;
    setEditTarget({ groupId: nodeId, name: node.data.name || "Group" });
    setEditTranscript(getEditTranscript(nodeId));
    setParamView("ai-recipe");
  }, []);

  const handleClearEditTranscript = useCallback(() => {
    const t = editTargetRef.current;
    if (!t) return;
    clearEditTranscript(t.groupId);
    setEditTranscript([]);
  }, []);

  // The purple-star button on an AI group (EffectNode) dispatches this event.
  useEffect(() => {
    const onAiEdit = (e: Event) => {
      const id = (e as CustomEvent<{ nodeId: string }>).detail?.nodeId;
      if (id) handleEditWithAI(id);
    };
    window.addEventListener("ai-edit-node", onAiEdit);
    return () => window.removeEventListener("ai-edit-node", onAiEdit);
  }, [handleEditWithAI]);

  // Edit the targeted group from a prompt: extract its fragment, run the
  // patch through editGroupRecipe (apply + validate + repair), and commit the
  // result in place — external wires survive because the shell id is unchanged.
  const handleEditGroup = useCallback(
    async (
      prompt: string,
      onProgress?: (e: AiProgress) => void
    ): Promise<{ ok: boolean; message?: string }> => {
      const target = editTargetRef.current;
      if (!target) return { ok: false, message: "No group selected." };
      const groupId = target.groupId;
      const fragIds = expandWithDescendants(nodesRef.current, [groupId]);
      const fragNodes = nodesRef.current.filter((n) => fragIds.has(n.id));
      const fragEdges = edgesRef.current.filter(
        (e) => fragIds.has(e.source) && fragIds.has(e.target)
      );
      // Recent turns give the model intent continuity for follow-ups.
      const history = getEditTranscript(groupId).slice(-8);
      let result;
      try {
        result = await editGroupRecipe(groupId, fragNodes, fragEdges, prompt, { history, onProgress });
      } catch (e) {
        return { ok: false, message: (e as Error)?.message ?? "Edit failed." };
      }
      if (!result.ok || !result.nodes || !result.edges) {
        return {
          ok: false,
          message: result.errors[0] ?? "Couldn't apply that edit — try rephrasing.",
        };
      }
      // The LLM round-trip takes tens of seconds and nothing locks the
      // editor, so re-check at commit time that the submit-time fragment is
      // still exactly the live one. Committing a stale fragment would
      // silently revert the user's mid-flight edits inside the group — or
      // resurrect the group if they deleted it. Graph edits replace node
      // `data` objects and mint fresh edge ids, so data-identity + edge-id
      // sequences are a precise "unchanged" test (pure canvas moves replace
      // the node wrapper but keep `data`, and are fine to commit over).
      const liveTarget = editTargetRef.current;
      const liveFragIds = expandWithDescendants(nodesRef.current, [groupId]);
      const liveFragNodes = nodesRef.current.filter((n) => liveFragIds.has(n.id));
      const liveFragEdges = edgesRef.current.filter(
        (e) => liveFragIds.has(e.source) && liveFragIds.has(e.target)
      );
      const unchanged =
        liveTarget?.groupId === groupId &&
        nodesRef.current.some((n) => n.id === groupId) &&
        liveFragNodes.length === fragNodes.length &&
        liveFragNodes.every(
          (n, i) => n.id === fragNodes[i].id && n.data === fragNodes[i].data
        ) &&
        liveFragEdges.length === fragEdges.length &&
        liveFragEdges.every((e, i) => e.id === fragEdges[i].id);
      if (!unchanged) {
        return {
          ok: false,
          message:
            "The group changed while the edit was running — nothing was applied. Try again.",
        };
      }
      pushGraph(getGraphSnapshot());
      // Mark the (possibly hand-made) group as AI-authored so it keeps the
      // "Edit with AI" button going forward.
      const committed = result.nodes.map((n) =>
        n.id === groupId ? { ...n, data: { ...n.data, aiAuthored: true } } : n
      );
      setNodes(nodesRef.current.filter((n) => !fragIds.has(n.id)).concat(committed));
      setEdges([
        ...edgesRef.current.filter(
          (e) => !(fragIds.has(e.source) && fragIds.has(e.target))
        ),
        ...result.edges,
      ]);
      const summary = result.summary ?? "applied your edit";
      setEditTranscript(appendEditTurn(groupId, { instruction: prompt, summary }));
      flashToast(`edit: ${summary}`);
      return { ok: true };
    },
    [pushGraph, getGraphSnapshot, setNodes, setEdges, flashToast]
  );

  const onAddNode = useCallback(
    (type: string, pendingWire?: PendingWire) => {
      // Pseudo-type from the add menu: show the AI Recipe composer in the
      // params panel instead of inserting a node. (setParamView is a stable
      // setter, so this adds nothing to the dependency list.)
      if (type === "ai-recipe") {
        setParamView("ai-recipe");
        return;
      }
      pushGraph(getGraphSnapshot());
      const base = lastPanePointerRef.current ?? { x: 200, y: 200 };
      // A tiny jitter keeps repeated adds from overlapping pixel-for-pixel.
      const jitter = { x: (Math.random() - 0.5) * 24, y: (Math.random() - 0.5) * 24 };
      const pos = { x: base.x + jitter.x, y: base.y + jitter.y };

      // Compound: "layer" creates a new layer (node + fixed boundary
      // nodes) and splices it into the top of the root chain. Offered
      // only by the root add menus.
      if (type === "layer") {
        const res = createLayer(nodesRef.current, edgesRef.current, undefined, activeCompositionIdRef.current);
        setNodes(res.nodes);
        setEdges(res.edges);
        setSelectedId(res.layerId);
        setParamView("node");
        return;
      }

      // Compound: "iterate" creates the Iterate shell + its boundary
      // trio in the current scope (071826_iterate-node.md). The body
      // renders inline as a zone immediately (071926_iterate-zone-view.md)
      // — build the varied subgraph right there. Auto-wire doesn't apply
      // — the shell has no sockets until the user mints them inside.
      if (type === "iterate") {
        const { iterate, iterateInput } = makeIterateNodes(pos);
        iterate.data.parentId = currentGroupIdRef.current;
        setNodes((prev) => [...prev, iterate, iterateInput]);
        setSelectedId(iterateInput.id);
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
          const res = createLayer(baseNodes, baseEdges, undefined, activeCompositionIdRef.current);
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
      // then picked this node from the search popup. From an output
      // socket, connect their source handle to a compatible input on
      // the new node; from an input socket, connect a compatible
      // output on the new node back into it. Mirrors
      // `isValidConnection` + the onConnect promotion rules for math
      // (uv) and copy-to-points (instance).
      let autoEdge: Edge | null = null;
      if (pendingWire?.kind === "from-source") {
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
                    : srcType === "text_instance"
                      ? "text"
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
            label: a.label,
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
            // Shared coercion table + polymorphic defType exceptions
            // (engine/graph-validation.ts). This used to be a private
            // hand-copy that had drifted — it was missing the Transform/
            // Displace polymorphic rows, so dropping a spline/points wire
            // on the pane and picking those from the search silently
            // failed to auto-wire while a direct socket drop worked.
            for (const i of resolvedInputs) {
              if (
                editorCanCoerce(
                  srcType,
                  i.type,
                  def.type,
                  `in:${i.name}`,
                  newNode.data.params
                )
              ) {
                targetInput = i.name;
                break;
              }
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
      } else if (pendingWire?.kind === "into-target") {
        // Reverse direction: the wire was pulled out of an INPUT socket,
        // so the new node is the producer. Pick one of its outputs and
        // wire it into the stashed input.
        const def = getNodeDef(type);
        if (def) {
          const { targetNodeId, targetHandle, targetType } = pendingWire;
          // Math's primary output is scalar in scalar mode — promote to
          // uv when the stashed input expects uv, mirroring the forward
          // direction (equivalent to switching the Mode param first).
          if (
            def.type === "math" &&
            targetType === "uv" &&
            newNode.data.params.mode === "scalar"
          ) {
            newNode.data.params = { ...newNode.data.params, mode: "uv" };
          }
          // Refresh the resolved socket lists after any param mutation so
          // the edge source matches what the evaluator will see.
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
          const primaryType =
            def.resolvePrimaryOutput?.(newNode.data.params) ??
            def.primaryOutput;
          newNode.data.primaryOutput = primaryType;
          const resolvedAux =
            def.resolveAuxOutputs?.(newNode.data.params) ?? def.auxOutputs;
          newNode.data.auxOutputs = resolvedAux.map((a) => ({
            name: a.name,
            label: a.label,
            type: a.type,
            disabled: a.disabled,
          }));

          // Pick a source output. Exact type match first (primary, then
          // aux), coercion-compatible second — the same preference order
          // the forward direction uses for inputs. Aux-exact beating
          // primary-coercion also gets the Auto Layout case right: an
          // `item:` slot (element) pulls an Image Source's raw `element`
          // aux rather than the coerced full-canvas image.
          const stashTarget = nodesRef.current.find(
            (n) => n.id === targetNodeId
          );
          const targetDefType = stashTarget?.data.defType;
          const targetParams = stashTarget?.data.params;
          const liveAux = resolvedAux.filter((a) => !a.disabled);
          let sourceHandle: string | null = null;
          if (primaryType === targetType) sourceHandle = "out:primary";
          if (!sourceHandle) {
            const exact = liveAux.find((a) => a.type === targetType);
            if (exact) sourceHandle = `out:aux:${exact.name}`;
          }
          if (
            !sourceHandle &&
            primaryType &&
            editorCanCoerce(
              primaryType,
              targetType,
              targetDefType,
              targetHandle,
              targetParams
            )
          ) {
            sourceHandle = "out:primary";
          }
          if (!sourceHandle) {
            const coerced = liveAux.find((a) =>
              editorCanCoerce(
                a.type,
                targetType,
                targetDefType,
                targetHandle,
                targetParams
              )
            );
            if (coerced) sourceHandle = `out:aux:${coerced.name}`;
          }

          if (sourceHandle) {
            autoEdge = {
              id: `e-auto-${newNode.id}-${targetNodeId}-${targetHandle}`,
              source: newNode.id,
              sourceHandle,
              target: targetNodeId,
              targetHandle,
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
        // Displace any wire already on the target input — same single-
        // input rule onConnect applies. No-op in the from-source case
        // (the target is the freshly spawned node).
        const added = autoEdge;
        setEdges((prev) => [
          ...prev.filter(
            (e) =>
              !(e.target === added.target && e.targetHandle === added.targetHandle)
          ),
          added,
        ]);
      }
      setSelectedId(newNode.id);
      setParamView("node");
      // Hand the id back so the caller can pick the fresh node up in
      // G-move (the add menu does). Only this plain single-node path
      // returns one — the compound branches above bail out early, and
      // grabbing a multi-node spawn isn't meaningful.
      return newNode.id;
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
    const fragNodes = nodesRef.current
      .filter((n) => ids.has(n.id))
      .map((n) => ({ ...n, selected: false }));
    clipboardRef.current = { nodes: fragNodes, edges: internalEdges };
    // Also publish a portable text envelope to the OS clipboard so the group /
    // recipe can be pasted into another tab or instance of Toolbox. Best-effort
    // (no-op in insecure contexts); same-tab paste falls back to clipboardRef.
    void writeFragmentToClipboard(fragNodes, internalEdges);
  }, []);

  // Shared insert: clone a fragment with fresh ids and drop it into the scope
  // the user is looking at (auto-wrapping into a new layer at root). Used by
  // both the in-memory paste and the cross-instance fragment paste.
  const insertClonedFragment = useCallback(
    (
      fragNodes: Node<NodeDataPayload>[],
      fragEdges: Edge[],
      toastNew: string
    ) => {
      if (fragNodes.length === 0) return;
      pushGraph(getGraphSnapshot());
      // Anchor to the last pane-pointer position so it lands where attention
      // is; fall back to a small fixed offset.
      const pointer = lastPanePointerRef.current;
      let offset: { x: number; y: number };
      if (pointer) {
        const minX = Math.min(...fragNodes.map((n) => n.position.x));
        const minY = Math.min(...fragNodes.map((n) => n.position.y));
        offset = { x: pointer.x - minX, y: pointer.y - minY };
      } else {
        offset = { x: 24, y: 24 };
      }
      // At root (a strict layer chain) non-layer content auto-wraps into a
      // fresh layer; otherwise it lands in the current group scope.
      let targetScope = currentGroupIdRef.current;
      let baseNodes = nodesRef.current;
      let baseEdges = edgesRef.current;
      let wrapped: string | null = null;
      if (!targetScope && !fragNodes.every((n) => n.data.defType === LAYER_TYPE)) {
        const res = createLayer(baseNodes, baseEdges, undefined, activeCompositionIdRef.current);
        baseNodes = res.nodes;
        baseEdges = res.edges;
        targetScope = res.layerId;
        wrapped = res.layerId;
      }
      const { nodes: newNodes, edges: newEdges } = cloneSubgraph(
        fragNodes,
        fragEdges,
        offset,
        { parentId: targetScope }
      );
      // Re-tag everything new (the clones, and any wrap-layer createLayer just
      // minted) into the active composition — a cross-project fragment carries
      // its origin's composition tag, which would otherwise be filtered out of
      // this project's layer chain (v5). Idempotent for same-project pastes.
      const active = activeCompositionIdRef.current;
      const tagActive = (n: Node<NodeDataPayload>): Node<NodeDataPayload> =>
        n.data.compositionId === active
          ? n
          : { ...n, data: { ...n.data, compositionId: active } };
      setNodes([
        ...baseNodes.map((n) => {
          const t = tagActive(n);
          return t.selected ? { ...t, selected: false } : t;
        }),
        ...newNodes.map(tagActive),
      ]);
      setEdges([...baseEdges, ...newEdges]);
      if (wrapped) {
        flashToast(toastNew);
        navigateScope(wrapped);
        // navigateScope clears selection; keep the pasted clones selected.
        setNodes((prev) =>
          prev.map((n) =>
            newNodes.some((c) => c.id === n.id) ? { ...n, selected: true } : n
          )
        );
      }
    },
    [pushGraph, getGraphSnapshot, setNodes, setEdges, flashToast, navigateScope]
  );

  const handlePasteNodes = useCallback(() => {
    const clip = clipboardRef.current;
    if (!clip || clip.nodes.length === 0) return;
    insertClonedFragment(clip.nodes, clip.edges, "pasted into a new layer");
  }, [insertClonedFragment]);

  // Cross-instance paste: the OS clipboard held a Toolbox fragment envelope
  // (copied from another tab/instance, or pasted from a shared snippet).
  // Deserialize it through the normal load path, then insert like any paste.
  const handlePasteFragmentText = useCallback(
    async (text: string) => {
      const saved = parseFragmentText(text);
      if (!saved) return;
      try {
        const { nodes: fragNodes, edges: fragEdges } = await deserializeGraph(
          saved
        );
        insertClonedFragment(
          fragNodes,
          fragEdges,
          "pasted a copied group into a new layer"
        );
      } catch {
        flashToast("couldn't paste — unrecognized or invalid fragment");
      }
    },
    [insertClonedFragment, flashToast]
  );

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

  // Right-click → "Make Editable" on a spline-output node: bake the node's
  // evaluated spline (exactly what the user sees at the current playhead —
  // a snapshot; animated/procedural upstream behavior freezes, by design)
  // into a fresh Spline Draw node, bypass the original as a revert point,
  // and move its spline out-wires onto the new node (makeSplineEditable in
  // graph-ops). The new node comes back selected + viewport-active so the
  // pen overlay engages immediately.
  const resolveSplineBakeHandle = useCallback(
    (nodeId: string): string | null => {
      const n = nodesRef.current.find((x) => x.id === nodeId);
      if (!n) return null;
      if (n.data.primaryOutput === "spline") return "out:primary";
      const aux = n.data.auxOutputs.find(
        (a) => a.type === "spline" && !a.disabled
      );
      return aux ? `out:aux:${aux.name}` : null;
    },
    []
  );

  // Read the baked spline from the eval cache and apply the graph op.
  // Returns false when the output isn't available (yet) so the caller can
  // force an eval pass — same freshness contract as getRefImageBlob.
  const tryApplyMakeEditable = useCallback(
    (nodeId: string, handle: string): boolean => {
      const out =
        evalCacheRef.current.get(nodeId)?.output ??
        lastEvalOutputsRef.current?.get(nodeId);
      const val =
        handle === "out:primary"
          ? out?.primary
          : out?.aux?.[handle.slice("out:aux:".length)];
      if (!val || val.kind !== "spline" || val.subpaths.length === 0) {
        return false;
      }
      const res = makeSplineEditable(
        nodesRef.current,
        edgesRef.current,
        nodeId,
        handle,
        val.subpaths
      );
      if (!res) return false;
      pushGraph(getGraphSnapshot());
      setNodes(res.nodes);
      setEdges(res.edges);
      setSelectedId(res.newNodeId);
      flashToast("Baked to editable Spline Draw");
      return true;
    },
    [
      pushGraph,
      getGraphSnapshot,
      setNodes,
      setEdges,
      setSelectedId,
      flashToast,
    ]
  );

  const handleMakeEditableNode = useCallback(
    (nodeId: string) => {
      const handle = resolveSplineBakeHandle(nodeId);
      if (!handle) return;
      if (tryApplyMakeEditable(nodeId, handle)) return;
      // Not in the eval cache — disconnected branch, or a consumption-gated
      // aux (Text's marching-squares spline) that never built. Force one
      // pass with the node targeted + the handle consumed; renderFrame
      // calls makeEditableCompleteRef after that eval lands.
      pendingBakeRef.current = { nodeId, handle };
      window.dispatchEvent(new Event("pipeline-bump"));
    },
    [resolveSplineBakeHandle, tryApplyMakeEditable]
  );

  // Latest-value ref assignment (renderFrame is declared far above and must
  // call the current closure) — same pattern as nodeContextMenuRef.
  makeEditableCompleteRef.current = (nodeId: string) => {
    const handle = resolveSplineBakeHandle(nodeId);
    if (!handle || !tryApplyMakeEditable(nodeId, handle)) {
      flashToast("Couldn't read a spline from this node");
    }
  };

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

  // Wire-gesture actions from NodeEditor. `combine` drops a reroute node on
  // the crossed wires (grouped by shared source → one reroute each, source →
  // reroute → targets); `cut` removes the listed edges outright. The reroute
  // is a real node — select/copy/paste/delete/input-swap all come for free
  // (specdocs/071326_reroute-node.md).
  const handleCombineWires = useCallback(
    (edgeIds: string[], midpointFlow: [number, number]) => {
      if (edgeIds.length === 0) return;
      const res = insertReroutesOnEdges(
        nodesRef.current,
        edgesRef.current,
        edgeIds,
        { x: midpointFlow[0], y: midpointFlow[1] }
      );
      if (res.rerouteIds.length === 0) return;
      pushGraph(getGraphSnapshot());
      const newIds = new Set(res.rerouteIds);
      // Select the fresh reroute(s) so they're immediately actionable.
      setNodes(
        res.nodes.map((n) =>
          newIds.has(n.id)
            ? { ...n, selected: true }
            : n.selected
              ? { ...n, selected: false }
              : n
        )
      );
      setEdges(res.edges);
    },
    [pushGraph, getGraphSnapshot, setNodes, setEdges]
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
            srcType === "image" || srcType === "image_group"
              ? "image"
              : srcType === "spline"
                ? "spline"
                : srcType === "points"
                  ? "point"
                  : srcType === "text_instance"
                    ? "text"
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
                label: a.label,
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

  // Strip every edge that touches this node. Used by cmd-drag to "float" a
  // node out of its connections in one gesture.
  const handleDetachNode = useCallback(
    (
      nodeId: string,
      // Present when NodeEditor found the node cleanly inline — heal the
      // chain by reconnecting its neighbors (A→C) as the node leaves.
      // Handles + type-compat are already resolved there (findDetachBridge),
      // same as the splice path trusts NodeEditor's socket resolution.
      bridge?: {
        source: string;
        sourceHandle: string;
        target: string;
        targetHandle: string;
      } | null
    ) => {
      const hasEdges = edgesRef.current.some(
        (e) => e.source === nodeId || e.target === nodeId
      );
      if (!hasEdges) return;
      pushGraph(getGraphSnapshot());
      setEdges((prev) => {
        const stripped = prev.filter(
          (e) => e.source !== nodeId && e.target !== nodeId
        );
        if (!bridge) return stripped;
        // Guard: never double-wire the target's single-input socket
        // (stripping the node's edges already frees it, so this only
        // matters if the graph changed underneath us).
        const occupied = stripped.some(
          (e) =>
            e.target === bridge.target && e.targetHandle === bridge.targetHandle
        );
        if (occupied) return stripped;
        return [
          ...stripped,
          {
            id: `e-heal-${nodeId}-${Math.random().toString(36).slice(2, 8)}`,
            source: bridge.source,
            sourceHandle: bridge.sourceHandle,
            target: bridge.target,
            targetHandle: bridge.targetHandle,
          },
        ];
      });
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
      const tickAtEdit = playbackClock.get().tick;
      // Simulation-zone `kind` is a paired property: the Start and End
      // halves share a zone_id and MUST agree on kind, or ensureZoneState
      // tears down and reallocates the shared state blob every frame (the
      // two halves fight over ctx.state[`sim-zone:<id>`]). So a kind edit on
      // one half mirrors to its partner in the same setNodes pass — one undo
      // entry. Resolve the partner id up front from the current graph.
      let zonePartnerId: string | undefined;
      if (paramName === "kind") {
        const src = nodesRef.current.find((x) => x.id === nodeId);
        const dt = src?.data.defType;
        if (dt === "simulation-start" || dt === "simulation-end") {
          const zid = src?.data.params.zone_id as string | undefined;
          if (zid) {
            const partnerType =
              dt === "simulation-start"
                ? "simulation-end"
                : "simulation-start";
            zonePartnerId = nodesRef.current.find(
              (x) =>
                x.data.defType === partnerType &&
                (x.data.params.zone_id as string | undefined) === zid
            )?.id;
          }
        }
      }
      // Color-ramp stop removal: a shrinking `color_ramp` array drops the
      // removed stops' virtual keyframe tracks, exposedParams/controlParams
      // entries, and any edges feeding their sockets — same edit, so one
      // undo restores stop + tracks + sockets together.
      let removedRampKeys: Set<string> | null = null;
      {
        const src = nodesRef.current.find((x) => x.id === nodeId);
        const pdefType = src
          ? getNodeDef(src.data.defType)?.params.find(
              (p) => p.name === paramName
            )?.type
          : undefined;
        if (pdefType === "color_ramp" && Array.isArray(value)) {
          const before =
            (src?.data.params[paramName] as ColorRampStop[] | undefined) ?? [];
          const kept = new Set((value as ColorRampStop[]).map((s) => s.id));
          const removed = before.filter((s) => !kept.has(s.id));
          if (removed.length > 0) {
            removedRampKeys = new Set(
              removed.flatMap((s) => [
                rampColorKey(paramName, s.id),
                rampAlphaKey(paramName, s.id),
                rampPositionKey(paramName, s.id),
              ])
            );
          }
        }
      }
      // Color node shrink: lowering `count` removes the trailing color
      // outputs — drop any edges wired to them in the same edit.
      let removedColorHandles: Set<string> | null = null;
      if (paramName === "count") {
        const src = nodesRef.current.find((x) => x.id === nodeId);
        if (
          src?.data.defType === "color-literal" &&
          typeof value === "number"
        ) {
          const before = Math.max(
            1,
            Math.floor((src.data.params.count as number) ?? 1)
          );
          const after = Math.max(
            1,
            Math.min(MAX_COLORS, Math.floor(value))
          );
          if (after < before) {
            removedColorHandles = new Set();
            for (let n = after + 1; n <= before; n++) {
              removedColorHandles.add(`out:aux:${colorParamName(n)}`);
            }
          }
        }
      }
      setNodes((prev) =>
        prev.map((n) => {
          // Zone partner: mirror the kind and re-resolve its sockets so the
          // input/output socket types stay in lockstep. No autokey — the
          // enum kind isn't keyframable.
          if (zonePartnerId && n.id === zonePartnerId) {
            return withUpdatedParams(n, { ...n.data.params, kind: value });
          }
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
            // Per-stop color/alpha/position auto-keyframe (color ramps):
            // same contract as gradient points above; keys embed the param
            // name (ramp_c/a/p:<param>:<stopId> — see engine/conventions).
            if (pdefType === "color_ramp") {
              const before =
                (n.data.params[paramName] as ColorRampStop[] | undefined) ??
                [];
              for (const stop of value as ColorRampStop[]) {
                const prev = before.find((b) => b.id === stop.id);
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
                tryKey(
                  rampColorKey(paramName, stop.id),
                  prev.color !== stop.color,
                  hexToRgba01Tuple(
                    typeof stop.color === "string" ? stop.color : "#ffffff"
                  )
                );
                tryKey(
                  rampAlphaKey(paramName, stop.id),
                  (prev.alpha ?? 1) !== (stop.alpha ?? 1),
                  stop.alpha ?? 1
                );
                tryKey(
                  rampPositionKey(paramName, stop.id),
                  prev.position !== stop.position,
                  stop.position
                );
              }
            }
          }
          // Per-anchor auto-keyframe + orphan cleanup (Spline Draw, spec
          // 072726 M6). With whole-shape Path Animation OFF and anchor
          // tracks present, a spline edit mirrors each animated anchor's
          // changed pos/handles into its virtual tracks at the playhead
          // (the constant below still writes — tracks win at eval). The
          // cleanup runs regardless of mode: tracks whose anchor id no
          // longer exists drop in the same pass (ramp-stop precedent).
          {
            const pdT = getNodeDef(n.data.defType)?.params.find(
              (p) => p.name === paramName
            )?.type;
            const nextSpline =
              pdT === "spline_anchors" &&
              value &&
              typeof value === "object" &&
              Array.isArray((value as { subpaths?: unknown }).subpaths)
                ? (value as { subpaths: SplineSubpath[] })
                : null;
            if (nextSpline && nextAnimation) {
              const hasAnchorKeys = Object.keys(nextAnimation).some(
                isAnchorTrackKey
              );
              if (hasAnchorKeys && !isAnimated) {
                const storedPrev = n.data.params[paramName] as
                  | { subpaths?: SplineSubpath[] }
                  | undefined;
                const prevBase: { subpaths: SplineSubpath[] } =
                  storedPrev && Array.isArray(storedPrev.subpaths)
                    ? (storedPrev as { subpaths: SplineSubpath[] })
                    : { subpaths: [] };
                // Diff against the EVALUATED pre-edit shape — the overlay
                // edits branch from what's displayed at the playhead.
                const prevEval =
                  resolveAnchorTracks(prevBase, nextAnimation, tickAtEdit) ??
                  prevBase;
                const prevById = new Map<string, SplineAnchor>();
                for (const s of prevEval.subpaths) {
                  for (const a of s.anchors) if (a.id) prevById.set(a.id, a);
                }
                const same2 = (
                  a: [number, number] | undefined,
                  b: [number, number] | undefined
                ) =>
                  (a?.[0] ?? 0) === (b?.[0] ?? 0) &&
                  (a?.[1] ?? 0) === (b?.[1] ?? 0);
                const tryKey = (
                  key: string,
                  changed: boolean,
                  kf: [number, number]
                ) => {
                  if (!changed) return;
                  const blk = nextAnimation?.[key];
                  if (blk?.animated) {
                    nextAnimation = {
                      ...nextAnimation,
                      [key]: upsertKeyframe(blk, tickAtEdit, kf, "easeInOut"),
                    };
                  }
                };
                for (const s of nextSpline.subpaths) {
                  for (const a of s.anchors) {
                    if (!a.id) continue;
                    const prev = prevById.get(a.id);
                    if (!prev) continue;
                    tryKey(anchorPosKey(a.id), !same2(prev.pos, a.pos), [
                      a.pos[0],
                      a.pos[1],
                    ]);
                    tryKey(
                      anchorInKey(a.id),
                      !same2(prev.inHandle, a.inHandle),
                      [a.inHandle?.[0] ?? 0, a.inHandle?.[1] ?? 0]
                    );
                    tryKey(
                      anchorOutKey(a.id),
                      !same2(prev.outHandle, a.outHandle),
                      [a.outHandle?.[0] ?? 0, a.outHandle?.[1] ?? 0]
                    );
                  }
                }
              }
              if (hasAnchorKeys) {
                const liveIds = new Set<string>();
                for (const s of nextSpline.subpaths) {
                  for (const a of s.anchors) if (a.id) liveIds.add(a.id);
                }
                for (const key of Object.keys(nextAnimation)) {
                  const aid = anchorTrackId(key);
                  if (aid && !liveIds.has(aid)) {
                    const clone: NonNullable<typeof n.data.animation> = {
                      ...nextAnimation,
                    };
                    delete clone[key];
                    nextAnimation = clone;
                  }
                }
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
          // Transform / Displace retype purely from connectedTypes (no stored
          // mode) — the edges-keyed effect owns their sockets. Re-resolving
          // here WITHOUT connectedTypes would reset their output back to
          // "image" on every param edit, so leave their sockets untouched.
          const connTyped = CONNECTED_TYPE_RETYPE_NODES.has(n.data.defType);
          const resolved = connTyped ? undefined : def?.resolveInputs?.(nextParams);
          const nextPrimary = connTyped
            ? n.data.primaryOutput
            : def?.resolvePrimaryOutput?.(nextParams) ?? n.data.primaryOutput;
          const resolvedAux = connTyped
            ? undefined
            : def?.resolveAuxOutputs?.(nextParams);
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
          // Removed stops take their virtual tracks and per-stop
          // expose/control entries with them (edges are dropped below,
          // outside this setNodes pass).
          let nextExposed = n.data.exposedParams;
          let nextControls = n.data.controlParams;
          if (removedRampKeys) {
            const dead = removedRampKeys;
            if (nextAnimation) {
              nextAnimation = Object.fromEntries(
                Object.entries(nextAnimation).filter(([k]) => !dead.has(k))
              );
            }
            nextExposed = nextExposed?.filter((p) => !dead.has(p));
            nextControls = nextControls?.filter((p) => !dead.has(p));
          }
          return {
            ...n,
            data: {
              ...n.data,
              name: nextName,
              exposedParams: nextExposed,
              controlParams: nextControls,
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
                    label: a.label,
                    type: a.type,
                    disabled: a.disabled,
                  }))
                : n.data.auxOutputs,
            },
          };
        })
      );
      if (removedRampKeys) {
        const deadHandles = new Set(
          [...removedRampKeys].map((k) => `in:param:${k}`)
        );
        setEdges((prev) =>
          prev.filter(
            (e) =>
              !(
                e.target === nodeId &&
                e.targetHandle &&
                deadHandles.has(e.targetHandle)
              )
          )
        );
      }
      if (removedColorHandles) {
        const dead = removedColorHandles;
        setEdges((prev) =>
          prev.filter(
            (e) =>
              !(
                e.source === nodeId &&
                e.sourceHandle &&
                dead.has(e.sourceHandle)
              )
          )
        );
      }
    },
    [setNodes, setEdges, pushGraph, getGraphSnapshot]
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
      const tickAtEdit = playbackClock.get().tick;
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
    [setNodes, pushGraph, getGraphSnapshot]
  );

  // Drag a motion-path point (MotionPathOverlay): write a keyframe to BOTH the
  // X and Y position param at the dragged point's tick. X/Y are independent
  // tracks; a point on the path represents the full position at its tick, so a
  // drag unifies both axes there (inserting a keyframe on whichever track
  // lacks one at that tick, and enabling animation if needed). The tick comes
  // from the dragged point, NOT the playhead — so this writes off-playhead and
  // can't route through onParamChange's autokey. One pushGraph + one setNodes
  // so the whole drag coalesces into a single undo entry.
  const onMotionPathPointChange = useCallback(
    (
      nodeId: string,
      xParam: string,
      yParam: string,
      tick: number,
      xVal: number,
      yVal: number,
      coalesceKey: string
    ) => {
      pushGraph(getGraphSnapshot(), coalesceKey);
      setNodes((prev) =>
        prev.map((n) => {
          if (n.id !== nodeId) return n;
          const cur = n.data.animation ?? {};
          const writeAxis = (
            block: KeyframeAnimationBlock | undefined,
            val: number
          ) => {
            const base = block ?? emptyAnimationBlock();
            const enabled = base.animated ? base : { ...base, animated: true };
            return upsertKeyframe(enabled, tick, val, "easeInOut");
          };
          const nextAnim = {
            ...cur,
            [xParam]: writeAxis(cur[xParam], xVal),
            [yParam]: writeAxis(cur[yParam], yVal),
          };
          return {
            ...n,
            data: { ...n.data, animation: nextAnim },
          };
        })
      );
    },
    [setNodes, pushGraph, getGraphSnapshot]
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
      const kept = prev.filter((e) => {
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
      // Almost every run prunes nothing — return the same array so `edges`
      // identity is stable and downstream memos/effects keyed on it don't
      // re-fire on every node change (e.g. per pointermove during a drag).
      return kept.length === prev.length ? prev : kept;
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
        detail.kind === "exprAddInput" ||
        detail.kind === "collectAddInput" ||
        detail.kind === "colorAddOutput" ||
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
            return withUpdatedParams(n, {
              ...n.data.params,
              layers: nextLayers,
            });
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
            return withUpdatedParams(n, {
              ...n.data.params,
              items: nextItems,
            });
          })
        );
      } else if (detail.kind === "exprAddInput") {
        setNodes((prev) =>
          prev.map((n) => {
            if (n.id !== detail.id) return n;
            const current = (n.data.params.inputs as ExprInput[]) ?? [];
            const nextInputs: ExprInput[] = [...current, newExprInput(current)];
            return withUpdatedParams(n, {
              ...n.data.params,
              inputs: nextInputs,
            });
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
            return withUpdatedParams(n, {
              ...n.data.params,
              items: nextItems,
            });
          })
        );
      } else if (detail.kind === "colorAddOutput") {
        // Color node grows via its `count` param (1..MAX_COLORS). Unlike
        // the socket-adders above this mints an OUTPUT — re-resolve aux
        // outputs rather than inputs.
        setNodes((prev) =>
          prev.map((n) => {
            if (n.id !== detail.id) return n;
            const cur = Math.max(
              1,
              Math.floor((n.data.params.count as number) ?? 1)
            );
            const nextCount = Math.min(MAX_COLORS, cur + 1);
            return withUpdatedParams(n, {
              ...n.data.params,
              count: nextCount,
            });
          })
        );
      } else if (detail.kind === "collectAddInput") {
        // Combine (collect) grows via its `count` param (1–26). Bump it by
        // one and re-resolve sockets — same shape as the other socket-adders.
        setNodes((prev) =>
          prev.map((n) => {
            if (n.id !== detail.id) return n;
            const cur = Math.max(
              1,
              Math.floor((n.data.params.count as number) ?? 2)
            );
            const nextCount = Math.min(26, cur + 1);
            return withUpdatedParams(n, {
              ...n.data.params,
              count: nextCount,
            });
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

  // Node resize grip (bottom-right corner on every node). Fires once per drag,
  // on pointer-up, with the final flow-space size; the top-left corner is the
  // drag anchor, so position never changes. One pushGraph + one setNodes =
  // one undo step. `reset` clears the override back to auto content sizing.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (
        e as CustomEvent<{
          id: string;
          width?: number;
          height?: number;
          reset?: boolean;
        }>
      ).detail;
      if (!detail) return;
      pushGraph(getGraphSnapshot());
      setNodes((prev) =>
        prev.map((n) => {
          if (n.id !== detail.id) return n;
          if (detail.reset) {
            const nextData = { ...n.data };
            delete nextData.uiWidth;
            delete nextData.uiHeight;
            return { ...n, data: nextData };
          }
          return {
            ...n,
            data: {
              ...n.data,
              uiWidth: detail.width,
              uiHeight: detail.height,
            },
          };
        })
      );
    };
    window.addEventListener("effect-node-resize", handler);
    return () => window.removeEventListener("effect-node-resize", handler);
  }, [setNodes, pushGraph, getGraphSnapshot]);

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
          const order = getLayerChain(
            nodesRef.current,
            edgesRef.current,
            activeCompositionIdRef.current
          )
            .map((n) => n.id)
            .filter((id) => !dead.has(id));
          const survivors = nodesRef.current.filter((n) => !dead.has(n.id));
          const survEdges = edgesRef.current.filter(
            (e) => !dead.has(e.source) && !dead.has(e.target)
          );
          const res = reorderLayers(survivors, survEdges, order, activeCompositionIdRef.current);
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
  // timeRef/playingRef are live mirrors of the store clock for the export
  // drivers and MCP handlers below, which read `.current` at call time.
  // Subscription-synced, not render-synced — the shell doesn't re-render
  // on clock changes anymore.
  const timeRef = useRef(playbackClock.get().time);
  const playingRef = useRef(playbackClock.get().playing);
  useEffect(() => {
    const sync = () => {
      const s = playbackClock.get();
      timeRef.current = s.time;
      playingRef.current = s.playing;
    };
    sync();
    return playbackClock.subscribe(sync);
  }, []);
  const fpsRef = useRef(fps);
  fpsRef.current = fps;
  const loopFramesRef = useRef(loopFrames);
  loopFramesRef.current = loopFrames;

  // Claude MCP bridge handlers (spec 070926_claude-mcp-bridge.md; the ref +
  // connection live near flashToast above). Rebuilt every render so handlers
  // capture fresh state; assembled here because it needs the clock refs
  // directly above plus commitRecipeFragment / onParamChange / renderFrame.
  mcpHandlersRef.current = buildMcpHandlers({
    status: {
      projectName: currentProject?.name ?? "Untitled",
      canvasWidth: canvasRes[0],
      canvasHeight: canvasRes[1],
      fps,
      // Live getters: get_status can arrive mid-playback, long after this
      // object was built (the shell no longer re-renders with the clock).
      get frame() {
        return Math.round(playbackClock.get().time * fps);
      },
      get playing() {
        return playbackClock.get().playing;
      },
      loopFrames: loopFrames != null && loopFrames > 0 ? loopFrames : fps * 5,
      selectedNodeId: selectedId,
      scope: currentGroupId ?? "root",
    },
    nodesRef,
    edgesRef,
    canvasRef,
    timeRef,
    fpsRef,
    playingRef,
    forcedTerminalRef,
    renderFrame,
    setPlaying,
    setTime,
    onParamChange,
    onAnimationChange,
    pushGraph,
    getGraphSnapshot,
    setNodes,
    setEdges,
    commitRecipeFragment,
    flashToast,
  });

  // The live loop/fps/resolution ARE the active composition's working scene;
  // materialize them onto its registry entry when saving (v5). Other comps
  // keep their stored scenes. Returns the registry to hand to serializeGraph.
  const compositionsForSave = useCallback(
    (thumbnail?: string | null): SavedComposition[] => {
      const scene = {
        loopFrames: loopFramesRef.current,
        fps: fpsRef.current,
        width: canvasResRef.current[0],
        height: canvasResRef.current[1],
      };
      return compositionsRef.current.map((c) =>
        c.id === activeCompositionIdRef.current
          ? {
              ...c,
              scene,
              // A truthy thumbnail means a real project save (vs a
              // switch/create sync) — stamp the edit time then too.
              ...(thumbnail ? { thumbnail, modifiedAt: Date.now() } : {}),
            }
          : c
      );
    },
    []
  );

  // Apply a composition's scene to the live editor (loop / fps / resolution)
  // and clamp the playhead into the new loop (decision: comp switch clamps).
  // A missing scene leaves the current settings untouched.
  const applyScene = useCallback((scene: SavedComposition["scene"]) => {
    if (!scene) return;
    if ("loopFrames" in scene) setLoopFrames(scene.loopFrames ?? null);
    if (scene.fps !== undefined) setFps(scene.fps);
    if (scene.width !== undefined && scene.height !== undefined)
      setCanvasRes([scene.width, scene.height]);
    const lf = "loopFrames" in scene ? scene.loopFrames ?? null : null;
    const f = scene.fps ?? fpsRef.current;
    if (lf != null && lf > 0 && f > 0) {
      const loopSecs = lf / f;
      setTime((t) => (t >= loopSecs ? Math.max(0, loopSecs - 1 / f) : t));
    }
  }, []);

  // Switch the active composition (v5). Navigation, not an undoable edit:
  // commits the outgoing comp's still-untagged nodes (so they don't leak via
  // the defensive membership predicate) and its live scene, then activates
  // the target and loads its scene + default scope.
  const handleSwitchComposition = useCallback(
    (compId: string) => {
      if (compId === activeCompositionIdRef.current) return;
      const outgoing = activeCompositionIdRef.current;
      const sweptNodes = tagUntaggedInto(nodesRef.current, outgoing);
      // compositionsForSave materializes the (still-active) outgoing comp's
      // live scene; every other comp keeps its stored scene.
      const comps = compositionsForSave();
      const incoming = comps.find((c) => c.id === compId);
      if (sweptNodes !== nodesRef.current) setNodes(sweptNodes);
      setCompositions(comps);
      setActiveCompositionId(compId);
      setSelectedId(null);
      setCurrentGroupId(defaultScopeFor(sweptNodes, compId));
      applyScene(incoming?.scene);
    },
    [compositionsForSave, applyScene, setNodes]
  );

  // Create a new composition (empty Output + Layer 1), open it as a tab, and
  // dive into its layer. The new comp inherits the current canvas settings.
  // Undoable (it adds nodes + a registry entry).
  const handleCreateComposition = useCallback(() => {
    pushGraph(getGraphSnapshot());
    const outgoing = activeCompositionIdRef.current;
    const sweptNodes = tagUntaggedInto(nodesRef.current, outgoing);
    const created = createComposition(compositionsRef.current);
    const newComp: SavedComposition = {
      ...created.composition,
      scene: {
        loopFrames: loopFramesRef.current,
        fps: fpsRef.current,
        width: canvasResRef.current[0],
        height: canvasResRef.current[1],
      },
      modifiedAt: Date.now(),
    };
    setNodes([...sweptNodes, ...created.nodes]);
    setEdges([...edgesRef.current, ...created.edges]);
    // Persist the outgoing comp's live scene, then append the new comp.
    setCompositions([...compositionsForSave(), newComp]);
    setActiveCompositionId(created.compositionId);
    setOpenCompositionIds((prev) =>
      prev.includes(created.compositionId)
        ? prev
        : [...prev, created.compositionId]
    );
    setSelectedId(null);
    setCurrentGroupId(created.layerId);
    // New comp inherits the current scene → no applyScene needed.
  }, [pushGraph, getGraphSnapshot, compositionsForSave, setNodes, setEdges]);

  // Close a composition tab — removes it from the bar; the composition stays
  // in the project (reopen via the Project view, M4). Falls the active
  // selection back to an adjacent open tab; the last open tab can't close.
  const handleCloseComposition = useCallback(
    (compId: string) => {
      const open = openCompositionIdsRef.current;
      const next = open.filter((id) => id !== compId);
      if (next.length === 0) return;
      if (compId === activeCompositionIdRef.current) {
        const idx = open.indexOf(compId);
        handleSwitchComposition(next[Math.min(idx, next.length - 1)]);
      }
      setOpenCompositionIds(next);
    },
    [handleSwitchComposition]
  );

  // --- Project view (file browser) ----------------------------------------

  const handleOpenProjectView = useCallback(() => setView("project"), []);

  // Enter a composition from the Project view: open it as a tab, switch to
  // it, and return to the node editor.
  const handleEnterComposition = useCallback(
    (compId: string) => {
      setOpenCompositionIds((prev) =>
        prev.includes(compId) ? prev : [...prev, compId]
      );
      handleSwitchComposition(compId);
      setView("editor");
    },
    [handleSwitchComposition]
  );

  // Delete a composition: remove its nodes + registry entry (no guard — if it
  // was the last/active one we drop into the Project view; a zero-comp
  // project is legal). Undoable.
  const handleDeleteComposition = useCallback(
    (compId: string) => {
      pushGraph(getGraphSnapshot());
      // Sweep so the active comp's untagged nodes are removable / kept right.
      const swept = tagUntaggedInto(
        nodesRef.current,
        activeCompositionIdRef.current
      );
      const { nodes: nextNodes, edges: nextEdges } = deleteCompositionNodes(
        swept,
        edgesRef.current,
        compId
      );
      const nextComps = compositionsRef.current.filter((c) => c.id !== compId);
      setNodes(nextNodes);
      setEdges(nextEdges);
      setCompositions(nextComps);
      setOpenCompositionIds((prev) => prev.filter((id) => id !== compId));
      if (compId === activeCompositionIdRef.current) {
        const fallback = nextComps[0];
        if (fallback) {
          setActiveCompositionId(fallback.id);
          setCurrentGroupId(defaultScopeFor(nextNodes, fallback.id));
          applyScene(fallback.scene);
          setView("project");
        } else {
          // Empty project — nothing to render; stay in the Project view.
          setActiveCompositionId("");
          setCurrentGroupId(undefined);
          setView("project");
        }
        setSelectedId(null);
      }
    },
    [pushGraph, getGraphSnapshot, applyScene, setNodes, setEdges]
  );

  // Duplicate a composition (deep-copy its graph into a new comp, inserted
  // right after the source). Opens as a tab. Undoable.
  const handleDuplicateComposition = useCallback(
    (compId: string) => {
      pushGraph(getGraphSnapshot());
      const swept = tagUntaggedInto(
        nodesRef.current,
        activeCompositionIdRef.current
      );
      const newId = newCompositionId();
      const { nodes: clones, edges: clonedEdges } = cloneCompositionNodes(
        swept,
        edgesRef.current,
        compId,
        newId
      );
      const src = compositionsRef.current.find((c) => c.id === compId);
      const newComp: SavedComposition = {
        id: newId,
        name: `${src?.name ?? "Composition"} copy`,
        scene: src?.scene,
        thumbnail: src?.thumbnail,
        modifiedAt: Date.now(),
      };
      const idx = compositionsRef.current.findIndex((c) => c.id === compId);
      const nextComps = [...compositionsRef.current];
      nextComps.splice(idx + 1, 0, newComp);
      setNodes([...swept, ...clones]);
      setEdges([...edgesRef.current, ...clonedEdges]);
      setCompositions(nextComps);
      setOpenCompositionIds((prev) =>
        prev.includes(newId) ? prev : [...prev, newId]
      );
    },
    [pushGraph, getGraphSnapshot, setNodes, setEdges]
  );

  const handleRenameComposition = useCallback(
    (compId: string, name: string) => {
      pushGraph(getGraphSnapshot());
      setCompositions((prev) =>
        prev.map((c) => (c.id === compId ? { ...c, name } : c))
      );
    },
    [pushGraph, getGraphSnapshot]
  );

  const handleReorderCompositions = useCallback((orderedIds: string[]) => {
    setCompositions((prev) => {
      const byId = new Map(prev.map((c) => [c.id, c]));
      const ordered = orderedIds
        .map((id) => byId.get(id))
        .filter((c): c is SavedComposition => !!c);
      const seen = new Set(orderedIds);
      return [...ordered, ...prev.filter((c) => !seen.has(c.id))];
    });
    // Keep the tab order in step with the project order.
    setOpenCompositionIds((prev) => {
      const rank = new Map(orderedIds.map((id, i) => [id, i]));
      return [...prev].sort(
        (a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9)
      );
    });
  }, []);

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
  // Synchronous re-entrancy lock for the standalone Export button.
  // `recordingRef` mirrors React state and only reflects a COMMITTED render,
  // so two clicks landing before the next commit both pass its guard and start
  // two overlapping offline exports (fighting over offlineRenderingRef + the
  // time save/restore → corrupted capture). This ref is set/cleared
  // synchronously around the dispatch, so the second click bails immediately.
  // See 072226 audit editor Tier-1 #2. (relinkBusyRef is the same pattern.)
  const exportBusyRef = useRef(false);

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

  // Drives the save/load progress readout in the MenuBar's status chip
  // (MessageConsole). `progress` is a 0..1 value; the chip renders it as
  // a spinner + percentage plus a thin fill bar.
  const [progressStatus, setProgressStatus] = useState<{
    label: string;
    progress: number;
    tone: "save" | "load";
  } | null>(null);

  // Nodes that do async work (model downloads, etc.) dispatch
  // `node-progress` events. EffectsApp listens and forwards to the same
  // chip used for save/load so the user gets consistent progress UX
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

  // Frame labels (FrameNode's click-to-edit chip) commit through this
  // event — routing into the standard rename path keeps undo + the
  // no-op/empty guards in one place.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ id: string; name: string }>).detail;
      if (!detail) return;
      handleRenameNode(detail.id, detail.name);
    };
    window.addEventListener("effect-node-rename", handler);
    return () => window.removeEventListener("effect-node-rename", handler);
  }, [handleRenameNode]);

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
  //
  // Iterate zone (071926_iterate-zone-view.md): an Iterate shell ALWAYS
  // renders its children inline in its own scope (positions are already
  // parent-space — scoping is purely a visibility filter), so
  // visibility recurses through Iterate shells. There is no collapsed
  // view and no diving in; membership stays parentId.
  const scopedNodes = useMemo(() => {
    const typeById = new Map(nodes.map((n) => [n.id, n.data.defType]));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const visibleCache = new Map<string, boolean>();
    const isVisible = (n: (typeof nodes)[number]): boolean => {
      const cached = visibleCache.get(n.id);
      if (cached !== undefined) return cached;
      let v: boolean;
      if (n.data.parentId === currentGroupId) {
        // Direct scope: comp filter only bites at root, where every
        // comp's root nodes otherwise coexist.
        v = belongsToComposition(n, activeCompositionId);
      } else {
        // Zone-visible: parent is an Iterate shell that is itself
        // visible.
        const p = n.data.parentId ? byId.get(n.data.parentId) : undefined;
        v = !!p && p.data.defType === ITERATE_TYPE && isVisible(p);
      }
      visibleCache.set(n.id, v);
      return v;
    };
    return nodes.map((n) => {
      const hidden = !isVisible(n);
      const disp = layerDisplayFor(n, typeById);
      const sameHidden = !!n.hidden === hidden;
      const sameName = n.data.displayName === disp.displayName;
      const sameAccent = !!n.data.layerAccent === !!disp.layerAccent;
      if (sameHidden && sameName && sameAccent) return n;
      return {
        ...n,
        hidden,
        data: {
          ...n.data,
          displayName: disp.displayName,
          layerAccent: disp.layerAccent,
        },
      };
    });
  }, [nodes, currentGroupId, activeCompositionId]);

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
    const activeComp = compositions.find((c) => c.id === activeCompositionId);
    // Project crumb (PROJECT_CRUMB_ID) opens the Project view; the
    // composition crumb (id:null) is the comp's root scope; then the group
    // chain. See NodeEditor's onNavigateScope / onOpenProject handling.
    return [
      { id: PROJECT_CRUMB_ID, name: currentProject?.name ?? "Untitled" },
      { id: null, name: activeComp?.name ?? "Composition 1" },
      ...chain,
    ];
  }, [nodes, currentGroupId, currentProject, compositions, activeCompositionId]);

  // --- Layers editor wiring ------------------------------------------------

  // Ordered root layer chain (bottom → top) — the Layers editor renders
  // it reversed (top of stack first).
  const layerChain = useMemo(
    () => getLayerChain(nodes, edges, activeCompositionId),
    [nodes, edges, activeCompositionId]
  );

  // Assets for the Assets view: bundled custom fonts (M-A2, scanned from the
  // graph) + the external folder's media files (M-A3).
  const projectAssets = useMemo<AssetItem[]>(() => {
    const items: AssetItem[] = [];
    const fonts = new Map<string, string | undefined>();
    for (const n of nodes) {
      for (const v of Object.values(n.data.params ?? {})) {
        const family = (v as { family?: unknown } | null)?.family;
        if (typeof family === "string" && family.startsWith("toolbox-custom-")) {
          if (!fonts.has(family))
            fonts.set(family, (v as { filename?: string }).filename);
        }
      }
    }
    for (const [family, filename] of fonts) {
      items.push({
        id: `font:${family}`,
        name: filename ?? "Custom font",
        kind: "font",
        source: "bundled",
        ref: family,
      });
    }
    if (assetsFolder) {
      for (const f of assetsFolder.files) {
        const kind = kindFromExt(f.ext);
        if (kind === "other") continue; // media only (matches native scan)
        items.push({
          id: `folder:${f.ref}`,
          name: f.name,
          kind,
          source: "folder",
          ref: f.ref,
        });
      }
    }
    return items;
  }, [nodes, assetsFolder]);

  // Pick an assets folder (web FSA / native dir dialog) for the Folder section.
  const handlePickAssetsFolder = useCallback(async () => {
    try {
      const folder = (await platform.assets?.pick?.()) ?? null;
      if (folder) setAssetsFolder(folder);
    } catch {
      // cancelled / unsupported — leave the current folder
    }
  }, []);

  const handleReorderLayers = useCallback(
    (orderedBottomToTop: string[]) => {
      pushGraph(getGraphSnapshot());
      const res = reorderLayers(
        nodesRef.current,
        edgesRef.current,
        orderedBottomToTop,
        activeCompositionIdRef.current
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
      const res = createLayer(
        nodesRef.current,
        edgesRef.current,
        { content, name },
        activeCompositionIdRef.current
      );
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
    if (!node) return null;
    if (node.data.defType === "output") return node.data.params;
    // Layer Output (the fixed group-output inside a layer): render the layer's
    // interior (forcedTerminal remaps to the interior producer) using the
    // layer's OWN export settings, stored on the node instance — independent
    // of the composition Output. See 071526_layer-output-export-settings.md.
    if (
      node.data.defType === GROUP_OUTPUT_TYPE &&
      (node.data.params as { fixed?: boolean })?.fixed === true
    ) {
      return node.data.params;
    }
    return null;
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

  // Two-pass deterministic offline render, shared by every frame-stepped
  // export path (video high/max, sequence, GIF, image-at-frame, node-frame
  // capture). Pass 1 issues any async media work (video seeks to the exact
  // target time); nodes register a settle promise, and if any did we wait
  // for the decode to land, then render again so captures read the now-
  // correct frames. Without this, video sources record stale frames and
  // multiple videos drift out of sync. `flush` yields one rAF so the GL
  // commands land before the caller reads pixels back (toBlob/readback
  // sites); the encoder-driven renderAt loops capture on their own
  // schedule and skip it.
  const renderSettledFrameAt = useCallback(
    async (t: number, fps: number, opts?: { flush?: boolean }) => {
      // setTime only advances the visible timeline cursor for progress
      // feedback — with the eval effect guarded by offlineRenderingRef it
      // doesn't trigger a redundant render of the same frame.
      setTime(t);
      const backend = backendRef.current;
      renderFrameRef.current?.(t, fps, true);
      const settled = backend ? await awaitMediaSettle(backend.state) : false;
      if (settled) renderFrameRef.current?.(t, fps, true);
      if (opts?.flush) {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
      }
    },
    [setTime]
  );

  // Rebuild frame-accumulated simulation state by stepping the offline clock
  // from frame 0 up to (but NOT including) `toTime` — the caller renders the
  // target frame itself, so the last step here is the one that leaves the sims
  // ready for it.
  //
  // Why any of this is needed: an export-resolution switch recreates the
  // engine backend, and the teardown runs disposeAllNodeState + destroy(),
  // which takes ctx.state — and therefore every sim's accumulated result —
  // with it. Capturing frame 50 straight after that wipe yields a freshly
  // seeded sim, or a blank frame for the readback-deferred solvers (matter,
  // particles) that publish one frame late. lib/sim-preroll.ts decides when a
  // given Output needs this; only nodes marked `simulation` in their
  // NodeDefinition can force it, and only ctx.time-driven accumulation is
  // reproducible this way (wall-clock nodes like Cursor Trail are excluded).
  //
  // Caller owns offlineRenderingRef, the banner lifecycle (via onProgress —
  // kept out of here so a Render Queue item can't leave a banner dangling
  // over the batch's own), and the time/playing save-restore; this only
  // steps the clock.
  const prerollSimulations = useCallback(
    async (
      toTime: number,
      fps: number,
      onProgress?: (done: number, total: number) => void
    ) => {
      const frames = Math.max(0, Math.round(toTime * fps));
      for (let f = 0; f < frames; f++) {
        await renderSettledFrameAt(f / fps, fps);
        // Yield a real frame between steps: the banner repaints, and the
        // solvers whose result arrives via an async GPU readback get the gap
        // they need to land it before the next step reads their output.
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        onProgress?.(f + 1, frames);
      }
    },
    [renderSettledFrameAt]
  );

  // Banner reporter shared by the pre-roll callers — the extra frame in the
  // denominator is the capture render the caller does after the pre-roll.
  const prerollProgress = useCallback(
    (label: string) => (done: number, total: number) =>
      setRecording({
        mode: "offline",
        label: `${label} ${done}/${total}`,
        progress: done / (total + 1),
      }),
    []
  );

  // --- export-resolution bracket (073126_export-resolution-and-app-slim.md)
  // beginExportResolution switches the engine to the given size (no-op when
  // it already matches) and endExportResolution restores the preview size
  // when the OUTERMOST bracket closes. The depth counter lets the batch
  // drivers (Render Queue, wedge batches) hold one bracket open across rows
  // so the per-row driver brackets don't thrash the backend back to preview
  // res between items — a batch passes `null` (hold open, don't touch the
  // size; the per-row driver sets the real size). Every begin must be
  // balanced by an end in the caller's finally, including when begin
  // itself rejects (the depth is incremented first for exactly that).
  const exportResDepthRef = useRef(0);
  const beginExportResolution = useCallback(
    async (target: [number, number] | null) => {
      exportResDepthRef.current++;
      if (!target) return;
      const dimsMatch = () => {
        const b = backendRef.current;
        return !!b && b.width === target[0] && b.height === target[1];
      };
      if (dimsMatch()) {
        // Re-check after a frame: a just-closed bracket's restore
        // recreation may still be pending, in which case the match is
        // stale and we must set the override like any other switch.
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        if (dimsMatch()) return;
      }
      setExportResOverride(target);
      // The backend-recreation effect is a passive effect: poll until the
      // new backend and the preview canvas element both report the target
      // size, then wait two more rAFs so the setBackendReady(true)
      // re-render has committed (renderFrame's closure gates on it).
      const deadline = performance.now() + 8000;
      await new Promise<void>((resolve, reject) => {
        const check = () => {
          const b = backendRef.current;
          const c = canvasRef.current;
          if (
            b &&
            c &&
            b.width === target[0] &&
            b.height === target[1] &&
            c.width === target[0] &&
            c.height === target[1]
          ) {
            requestAnimationFrame(() =>
              requestAnimationFrame(() => resolve())
            );
            return;
          }
          if (performance.now() > deadline) {
            reject(
              new Error(
                `Couldn't switch the render resolution to ${target[0]}×${target[1]} for export`
              )
            );
            return;
          }
          requestAnimationFrame(check);
        };
        check();
      });
    },
    []
  );
  const endExportResolution = useCallback(() => {
    exportResDepthRef.current = Math.max(0, exportResDepthRef.current - 1);
    if (exportResDepthRef.current === 0) setExportResOverride(null);
  }, []);

  const exportImage = useCallback(
    async (nodeId: string) => {
      const canvas = canvasRef.current;
      const params = getOutputParams(nodeId);
      if (!canvas || !params) return;
      const format = (params.imageFormat as string) ?? "png";
      const quality = (params.imageQuality as number) ?? 0.92;
      // {i} tokens resolve to 0 in a single render — never leak literally.
      const base = resolveWedgeName(
        sanitizeFilename((params.filename as string) ?? ""),
        0,
        1
      );
      const mime = `image/${format}`;
      const useQuality = format === "jpeg" || format === "webp";
      const target = resolveExportResolution(params, canvasResRef.current);
      const savedTime = timeRef.current;
      const savedPlaying = playingRef.current;
      const fps = fpsRef.current;
      // Does this capture need a simulation pre-roll? Only when the export
      // size actually differs from what the engine is rendering at — that's
      // the case that recreates the backend and wipes every sim's
      // accumulated ctx.state (see prerollSimulations). When the sizes
      // match, beginExportResolution early-returns, the live state is
      // untouched, and the frame on screen is already the right one; a
      // pre-roll would only be a slow way to reproduce it. That's the
      // difference between this path and renderImageToBlobAtFrame, which
      // renders an arbitrary frame and so always pre-rolls.
      const backend = backendRef.current;
      const resWillSwitch =
        !backend ||
        backend.width !== target[0] ||
        backend.height !== target[1];
      const preroll =
        resWillSwitch &&
        savedTime > 0 &&
        outputNeedsSimPreroll(nodesRef.current, edgesRef.current, nodeId);
      // Render this specific Output before the snapshot: a Layer Output's
      // interior may not be what the live preview shows, a resolution
      // switch leaves the canvas stale until the next render, and the
      // snapshot should capture this Output regardless of which node is
      // set Active (same semantics as the video/sequence exporters).
      forcedTerminalRef.current = nodeId;
      if (preroll) {
        // A pre-roll steps the clock itself, so it takes the same offline
        // treatment as the frame-stepped exporters: pause the transport so
        // the playback driver doesn't render competing frames, and flip
        // ctx.offline so the sims' step gating advances per stepped frame.
        setPlaying(false);
        offlineRenderingRef.current = true;
        setRecording({
          mode: "offline",
          label: "Re-simulating…",
          progress: 0,
        });
      }
      try {
        await beginExportResolution(target);
        if (preroll) {
          await prerollSimulations(
            savedTime,
            fps,
            prerollProgress("Re-simulating frame")
          );
        }
        await renderSettledFrameAt(savedTime, fps, { flush: true });
        const blob = await new Promise<Blob | null>((res) =>
          canvas.toBlob(
            (b) => res(b),
            mime,
            useQuality ? quality : undefined
          )
        );
        if (blob) {
          downloadBlob(
            blob,
            base ? `${base}.${format}` : defaultFilename(format)
          );
        }
      } finally {
        forcedTerminalRef.current = null;
        if (preroll) {
          offlineRenderingRef.current = false;
          setRecording(null);
          setPlaying(savedPlaying);
          setTime(savedTime);
        }
        endExportResolution();
      }
    },
    [
      getOutputParams,
      beginExportResolution,
      endExportResolution,
      prerollSimulations,
      prerollProgress,
      renderSettledFrameAt,
      setPlaying,
      setTime,
    ]
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
      // back instead of being downloaded — the Render Queue and the wedge
      // batch driver collect them and deliver at the end. `labelPrefix`
      // prepends batch position ("Variation 2/5 — ") to the offline
      // progress-banner labels.
      opts?: {
        sink?: (blob: Blob, ext: string) => void;
        labelPrefix?: string;
      }
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
      // {i} tokens resolve to 0 in a single render (batch runs name their
      // files in the driver via `sink`, so this base is single-render only).
      const base = resolveWedgeName(
        sanitizeFilename((params.filename as string) ?? ""),
        0,
        1
      );
      const previewFps = fpsRef.current;
      const exportFps =
        quality === "fast"
          ? previewFps
          : Math.max(1, (params.videoFps as number) ?? previewFps);
      // Export resolution (even dims — H.264/H.265 reject odd sizes).
      const targetRes = resolveExportResolution(params, canvasResRef.current, {
        even: true,
      });

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
          // Switch the engine to the export resolution before the recorder
          // starts — the canvas capture track follows the element size.
          await beginExportResolution(targetRes);
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
          endExportResolution();
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
      const lp = opts?.labelPrefix ?? "";
      setRecording({ mode: "offline", label: `${lp}Preparing…`, progress: 0 });

      // Pre-warm fonts before the frame loop. Async font loads (curated/web
      // families fetched from the CDN) otherwise resolve mid-export, so the
      // first frames would capture a fallback face; installed/bundled fonts are
      // already live, making this a no-op for them. Gather every family the
      // graph's Text nodes reference and await them, bounded so a dead CDN
      // can't hang the export.
      {
        const families = new Set<string>();
        for (const n of nodesRef.current) {
          if (n.data?.defType !== "text") continue;
          const params = n.data.params ?? {};
          const fam = params.font_family;
          if (typeof fam === "string" && fam) families.add(fam);
          const custom = params.custom_font as { family?: string } | null | undefined;
          if (custom?.family) families.add(custom.family);
        }
        if (families.size > 0) {
          const { ensureFontLoaded } = await import("@/lib/fonts");
          await Promise.race([
            Promise.all([...families].map((f) => ensureFontLoaded(f))).then(
              () => document.fonts.ready
            ),
            new Promise((r) => setTimeout(r, 4000)),
          ]);
        }
      }

      const renderAt = async (frameIndex: number, _t: number) => {
        // The exporter counts from 0; offset by startFrame so the export
        // window is [startFrame, startFrame + durationFrames). Ignore the
        // exporter's own `t` and compute the real project time here.
        await renderSettledFrameAt((startFrame + frameIndex) / exportFps, exportFps);
      };

      try {
        // Switch the engine to the export resolution first — every capture
        // route below (WebCodecs CanvasSource, PNG frames, native-ffmpeg
        // readback) reads the preview canvas / backend at this size.
        await beginExportResolution(targetRes);
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
                label: `${lp}${label}`,
                progress: frac,
              }),
          });
        } else {
          const rawCodec = (params.videoCodec as string) ?? "h264";
          type FC =
            | "h264" | "h264-lossless" | "h265" | "prores" | "qtrle" | "vp9" | "av1";
          const ffAllowed: FC[] = [
            "h264", "h264-lossless", "h265", "prores", "qtrle", "vp9", "av1",
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
          // ProRes and QuickTime Animation (qtrle) want a QuickTime container;
          // nudge mp4/webm → mov. (qtrle is the universal-alpha codec that AE
          // and Resolve both read — see export-ffmpeg-args.js.)
          const needsMov = codec === "prores" || codec === "qtrle";
          const ffContainer =
            needsMov && (container === "mp4" || container === "webm")
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
                setRecording({ mode: "offline", label: `${lp}${label}`, progress: frac })
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
                  label: `${lp}Encoding ${i + 1}/${durationFrames}`,
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
              setRecording({ mode: "offline", label: `${lp}${label}`, progress: frac }),
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
        endExportResolution();
      }
    },
    [
      getOutputParams,
      getOutputAudioSpec,
      getLiveAudioTrack,
      flashToast,
      renderSettledFrameAt,
      beginExportResolution,
      endExportResolution,
    ]
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
      // Unlike exportImage this renders an ARBITRARY frame, so accumulated
      // sim state is never the right one to capture from — whatever ctx.state
      // holds belongs to some other frame (or was just wiped by an export-
      // resolution switch). Sims therefore always get stepped from frame 0.
      // The wedge/queue batches hold one resolution bracket across items, so
      // there's no per-item switch to key off of anyway.
      const preroll =
        frame > 0 &&
        outputNeedsSimPreroll(nodesRef.current, edgesRef.current, nodeId);
      try {
        await beginExportResolution(
          resolveExportResolution(params, canvasResRef.current)
        );
        if (preroll) {
          await prerollSimulations(
            t,
            fps,
            prerollProgress("Re-simulating frame")
          );
        }
        await renderSettledFrameAt(t, fps, { flush: true });
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
        // Only ours to clear — a batch driver's own banner is untouched
        // when this call never raised one.
        if (preroll) setRecording(null);
        setPlaying(savedPlaying);
        setTime(savedTime);
        endExportResolution();
      }
    },
    [
      getOutputParams,
      prerollProgress,
      prerollSimulations,
      renderSettledFrameAt,
      beginExportResolution,
      endExportResolution,
    ]
  );

  // Wedge batch for an Output — count + the reachable wedges (for
  // {wedge:Name} filename tokens). The real work is the shared pure helper
  // in lib/wedge-batch.ts (the UI readouts use it too); this wrapper just
  // binds the live graph refs.
  const resolveWedgeBatch = useCallback(
    (outputNodeId: string): WedgeBatchInfo =>
      resolveWedgeBatchInfo(nodesRef.current, edgesRef.current, outputNodeId),
    []
  );

  // Standalone Export with wedges upstream: render the whole tree once per
  // variation (ctx.wedgeIndex stepping 0..count−1 via wedgeIndexRef) and
  // deliver iterated filenames (resolveWedgeName's {i} tokens). No wedges ⇒
  // falls through to the plain single-render paths unchanged. Delivery is
  // sequential downloads (the Render Queue's default); route the Output
  // through a Render Queue for zip/folder delivery of heavy batches. The eval
  // cache is NOT cleared between variations — branches that don't depend on a
  // wedge render once and stay cached for the whole batch.
  const exportWedged = useCallback(
    async (nodeId: string, kind: "image" | "video") => {
      const batch = resolveWedgeBatch(nodeId);
      const total = batch.count;
      if (total <= 1) {
        if (kind === "image") await exportImage(nodeId);
        else await exportVideo(nodeId);
        return;
      }
      if (recordingRef.current || queueRenderingRef.current) return;
      // Reuse the queue's serialization lock — a wedge batch is a queue-of-
      // one rendered N times, and the same "don't interleave batches" rule
      // applies in both directions.
      queueRenderingRef.current = true;
      // Hold the export-resolution bracket open across variations so the
      // per-variation drivers (which begin/end their own brackets at the
      // same target) don't recreate the backend back to preview res
      // between items. `null` = depth-hold only; the drivers set the size.
      await beginExportResolution(null);
      const params = getOutputParams(nodeId);
      const node = nodesRef.current.find((n) => n.id === nodeId);
      const rawBase =
        sanitizeFilename((params?.filename as string) ?? "") ||
        sanitizeFilename(node?.data.name ?? "") ||
        "export";
      const usedNames = new Set<string>();
      let done = 0;
      try {
        for (let v = 0; v < total; v++) {
          wedgeIndexRef.current = v;
          const out: { blob: Blob | null; ext: string } = {
            blob: null,
            ext: "",
          };
          if (kind === "video") {
            await exportVideo(nodeId, {
              sink: (b, e) => {
                out.blob = b;
                out.ext = e;
              },
              labelPrefix: `Variation ${v + 1}/${total} — `,
            });
          } else {
            const frame = Math.floor(timeRef.current * fpsRef.current);
            const r = await renderImageToBlobAtFrame(nodeId, frame);
            if (r) {
              out.blob = r.blob;
              out.ext = r.ext;
            }
          }
          if (!out.blob) continue;
          const resolved = resolveWedgeName(
            rawBase,
            v,
            total,
            wedgeTokensAt(batch, v)
          );
          let name = `${resolved}.${out.ext}`;
          let n = 2;
          while (usedNames.has(name)) name = `${resolved}-${n++}.${out.ext}`;
          usedNames.add(name);
          downloadBlob(out.blob, name);
          done++;
        }
        flashToast(
          done === total
            ? `Rendered ${done} variation${done === 1 ? "" : "s"}`
            : `Rendered ${done}/${total} variations`
        );
      } catch (err) {
        console.error("Wedge batch failed:", err);
        flashToast(err instanceof Error ? err.message : "Wedge batch failed");
      } finally {
        wedgeIndexRef.current = undefined;
        queueRenderingRef.current = false;
        endExportResolution();
      }
    },
    [
      resolveWedgeBatch,
      exportImage,
      exportVideo,
      renderImageToBlobAtFrame,
      getOutputParams,
      flashToast,
      beginExportResolution,
      endExportResolution,
    ]
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
      // Wedge variations: the whole frame range renders once per variation,
      // with the variation's iterated base naming its frames. All variations
      // share ONE delivery — a single zip / one picked folder — so a batch is
      // one download, not N.
      const batch = resolveWedgeBatch(nodeId);
      const wedgeTotal = batch.count;

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
      const totalFrames = wedgeTotal * durationFrames;
      let written = 0;
      try {
        await beginExportResolution(
          resolveExportResolution(params, canvasResRef.current)
        );
        for (let v = 0; v < wedgeTotal; v++) {
          wedgeIndexRef.current = wedgeTotal > 1 ? v : undefined;
          const vbase = resolveWedgeName(
            base,
            v,
            wedgeTotal,
            wedgeTokensAt(batch, v)
          );
          const vprefix =
            wedgeTotal > 1 ? `Variation ${v + 1}/${wedgeTotal} — ` : "";
          for (let i = 0; i < durationFrames; i++) {
            const frame = startFrame + i;
            const t = frame / fps;
            await renderSettledFrameAt(t, fps, { flush: true });
            const blob = await new Promise<Blob | null>((res) =>
              canvas.toBlob(
                (b) => res(b),
                `image/${format}`,
                useQuality ? quality : undefined
              )
            );
            if (blob) {
              const name = `${vbase}.${String(frame).padStart(pad, "0")}.${format}`;
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
              label: `${vprefix}Frame ${i + 1}/${durationFrames}`,
              progress: (v * durationFrames + i + 1) / totalFrames,
            });
          }
        }

        if (delivery === "zip" && collected.length) {
          setRecording({ mode: "offline", label: "zipping…", progress: 1 });
          const JSZip = (await import("jszip")).default;
          const zip = new JSZip();
          for (const c of collected) zip.file(c.name, c.blob);
          const zipBlob = await zip.generateAsync({ type: "blob" });
          // One zip spans every variation, so its name strips {i} tokens
          // rather than resolving them to a single index.
          downloadBlob(zipBlob, `${stripWedgeTokens(base)}.zip`);
        }
        flashToast(`Rendered ${written} frame${written === 1 ? "" : "s"}`);
      } catch (err) {
        console.error("Sequence export failed:", err);
        flashToast(err instanceof Error ? err.message : "Sequence export failed");
      } finally {
        wedgeIndexRef.current = undefined;
        offlineRenderingRef.current = false;
        forcedTerminalRef.current = null;
        setPlaying(savedPlaying);
        setTime(savedTime);
        setRecording(null);
        endExportResolution();
      }
    },
    [
      getOutputParams,
      resolveWedgeBatch,
      flashToast,
      renderSettledFrameAt,
      beginExportResolution,
      endExportResolution,
    ]
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
        await renderSettledFrameAt((startFrame + frameIndex) / exportFps, exportFps);
      };

      // Wedge variations: one GIF per variation, sequential downloads with
      // iterated names (an unnamed batch still needs distinct names, so the
      // Output's node name backstops the timestamp fallback).
      const batch = resolveWedgeBatch(nodeId);
      const wedgeTotal = batch.count;
      const node = nodesRef.current.find((n) => n.id === nodeId);
      const batchBase =
        base || sanitizeFilename(node?.data.name ?? "") || "export";

      try {
        await beginExportResolution(
          resolveExportResolution(params, canvasResRef.current)
        );
        const { exportGif: runGifExport } = await import("@/lib/export-gif");
        for (let v = 0; v < wedgeTotal; v++) {
          wedgeIndexRef.current = wedgeTotal > 1 ? v : undefined;
          const vprefix =
            wedgeTotal > 1 ? `Variation ${v + 1}/${wedgeTotal} — ` : "";
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
              setRecording({
                mode: "offline",
                label: `${vprefix}${label}`,
                progress,
              }),
          });
          downloadBlob(
            result.blob,
            wedgeTotal > 1
              ? `${resolveWedgeName(batchBase, v, wedgeTotal, wedgeTokensAt(batch, v))}.${result.ext}`
              : base
                ? `${resolveWedgeName(base, 0, 1)}.${result.ext}`
                : defaultFilename(result.ext)
          );
        }
      } catch (err) {
        console.error("GIF export failed:", err);
        flashToast(err instanceof Error ? err.message : "GIF export failed");
      } finally {
        wedgeIndexRef.current = undefined;
        offlineRenderingRef.current = false;
        forcedTerminalRef.current = null;
        setPlaying(savedPlaying);
        setTime(savedTime);
        setRecording(null);
        endExportResolution();
      }
    },
    [
      getOutputParams,
      resolveWedgeBatch,
      flashToast,
      renderSettledFrameAt,
      beginExportResolution,
      endExportResolution,
    ]
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
          await renderSettledFrameAt(t, fps, { flush: true });
          const backend = backendRef.current;
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
    [renderSettledFrameAt]
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
      // Wedge variations multiply each row: an Output with wedges upstream
      // renders once per variation into the same delivery. Resolved up front
      // so the end-of-run toast can report files, not rows.
      const wedgeBatches = resolved.map(({ output }) =>
        output
          ? resolveWedgeBatch(output.id)
          : ({ count: 1, wedges: [] } as WedgeBatchInfo)
      );
      const totalFiles = wedgeBatches.reduce((a, b) => a + b.count, 0);
      try {
        // Hold the export-resolution bracket open across rows so per-row
        // driver brackets don't restore preview res between items (rows
        // with the same target then share one backend recreation).
        await beginExportResolution(null);
        for (let i = 0; i < resolved.length; i++) {
          const { item, output } = resolved[i];
          if (!output) continue;
          const displayName = output.data.name ?? "output";
          const p = output.data.params;
          const baseName =
            sanitizeFilename((p.filename as string) ?? "") ||
            (output.data.name ?? `item-${i + 1}`);
          const wedgeBatch = wedgeBatches[i];
          const wedgeTotal = wedgeBatch.count;

          for (let v = 0; v < wedgeTotal; v++) {
            wedgeIndexRef.current = wedgeTotal > 1 ? v : undefined;
            setQueueProgress({
              index: i,
              total,
              name:
                wedgeTotal > 1
                  ? `${displayName} · ${v + 1}/${wedgeTotal}`
                  : displayName,
              nodeId: queueNodeId,
              itemId: item.id,
            });

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
                labelPrefix:
                  wedgeTotal > 1
                    ? `Variation ${v + 1}/${wedgeTotal} — `
                    : undefined,
              });
            } else {
              const r = await renderImageToBlobAtFrame(output.id, item.frame);
              if (r) {
                out.blob = r.blob;
                out.ext = r.ext;
              }
            }
            if (!out.blob) {
              // Render produced nothing (e.g. the offline encoder bailed).
              // Record it so the end-of-run toast reports the gap instead of
              // silently delivering a short batch.
              skipped.push(
                wedgeTotal > 1
                  ? `${displayName} (variation ${v + 1})`
                  : displayName
              );
              continue;
            }

            // Iterated name per variation ({i} tokens / auto _{i:3} suffix),
            // then de-dupe within the batch.
            const iterated = resolveWedgeName(
              baseName,
              v,
              wedgeTotal,
              wedgeTokensAt(wedgeBatch, v)
            );
            let name = `${iterated}.${out.ext}`;
            let n = 2;
            while (usedNames.has(name)) name = `${iterated}-${n++}.${out.ext}`;
            usedNames.add(name);

            if (delivery === "folder" && folder) {
              await folder.writeFile(name, out.blob);
            } else if (delivery === "sequential") {
              downloadBlob(out.blob, name);
            } else {
              collected.push({ blob: out.blob, name });
            }
          }
          wedgeIndexRef.current = undefined;
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
            ? `Rendered ${done}/${totalFiles} — ${skipped.length} failed: ${skipped.join(", ")}`
            : `Rendered ${done} file${done === 1 ? "" : "s"}`
        );
      } catch (err) {
        console.error("Render queue failed:", err);
        flashToast(err instanceof Error ? err.message : "Render queue failed");
      } finally {
        wedgeIndexRef.current = undefined;
        queueRenderingRef.current = false;
        forcedTerminalRef.current = null;
        setQueueProgress(null);
        endExportResolution();
      }
    },
    [
      resolveQueueItems,
      resolveWedgeBatch,
      exportVideo,
      renderImageToBlobAtFrame,
      flashToast,
      beginExportResolution,
      endExportResolution,
    ]
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
          overlayLandedMedia(nodesRef.current),
          edgesRef.current,
          undefined,
          {
            loopFrames: loopFramesRef.current,
            fps: fpsRef.current,
            width: canvasResRef.current[0],
            height: canvasResRef.current[1],
          },
          {
            compositions: compositionsForSave(),
            activeCompositionId: activeCompositionIdRef.current,
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
        const { packageExportApp, graphUsesMlNodes, ORT_WASM_ASSET_RE } =
          await import("@/lib/export-packager");
        // The ~22 MB ONNX-runtime wasm is only ever fetched at runtime by
        // the ML nodes (bg-remove / segment / depth) — drop it from the
        // bundle (and skip downloading it here) when the project has none.
        // Spec: 073126_export-resolution-and-app-slim.md.
        const wantedDistFiles = graphUsesMlNodes(graphJson)
          ? distManifest.distFiles
          : distManifest.distFiles.filter((p) => !ORT_WASM_ASSET_RE.test(p));
        const [distFiles, sourceFiles] = await Promise.all([
          fetchAll("/export-template/v1/dist", wantedDistFiles),
          fetchAll("/export-template/v1/source", distManifest.sourceFiles),
        ]);
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
    [exportApp, canvasRes, flashToast, compositionsForSave]
  );

  // Async Export App size estimate (073126 M3). The old inline estimate
  // measured the manifest JSON only (~KBs) while the real payload is the
  // serialized graph (embedded media) + the template. Serialize once when
  // the modal opens; template byte counts come from the template
  // manifest's distBytes/sourceBytes/tierABytes (absent on older template
  // builds → the template portion reads 0 and only the graph is counted).
  const [exportAppEstimate, setExportAppEstimate] = useState<{
    totalBytes: number;
    contentBytes: number;
    ml: boolean;
  } | null>(null);
  useEffect(() => {
    if (!exportApp) {
      setExportAppEstimate(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const graphJson = await serializeGraph(
          overlayLandedMedia(nodesRef.current),
          edgesRef.current,
          undefined,
          {
            loopFrames: loopFramesRef.current,
            fps: fpsRef.current,
            width: canvasResRef.current[0],
            height: canvasResRef.current[1],
          },
          {
            compositions: compositionsForSave(),
            activeCompositionId: activeCompositionIdRef.current,
          }
        );
        const { graphUsesMlNodes, ORT_WASM_ASSET_RE } = await import(
          "@/lib/export-packager"
        );
        const ml = graphUsesMlNodes(graphJson);
        const contentBytes = JSON.stringify(graphJson).length;
        let templateBytes = 0;
        try {
          const m = (await fetch("/export-template/v1/manifest.json").then(
            (r) => r.json()
          )) as {
            distBytes?: Record<string, number>;
            sourceBytes?: Record<string, number>;
            tierABytes?: number;
          };
          for (const [p, b] of Object.entries(m.distBytes ?? {})) {
            if (!ml && ORT_WASM_ASSET_RE.test(p)) continue;
            templateBytes += b;
          }
          for (const b of Object.values(m.sourceBytes ?? {})) {
            templateBytes += b;
          }
          templateBytes += m.tierABytes ?? 0;
        } catch {
          // Template missing/unbuilt — the export path surfaces that with
          // its own friendly error; estimate the graph alone here.
        }
        if (!cancelled) {
          setExportAppEstimate({
            totalBytes: templateBytes + contentBytes,
            contentBytes,
            ml,
          });
        }
      } catch (e) {
        console.warn("Export App size estimate failed:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [exportApp, compositionsForSave]);

  // SVG Export node (spec 072726 M2): serialize the node's stashed input
  // spline (written by its compute every eval — the node is terminal, so
  // the stash always reflects the current playhead) and save it through
  // the platform seam. The composition **Output** node stashes under the
  // same key from its own optional `spline` tap and declares the same
  // styling params, so this one exporter serves both.
  const exportSvgNode = useCallback(
    async (nodeId: string) => {
      const backend = backendRef.current;
      if (!backend) return;
      const ctx = backend.makeContext(0, 0);
      const node = nodesRef.current.find((n) => n.id === nodeId);
      // A Layer Output never computes — flatten dissolves every group
      // boundary — so its ENCLOSING LAYER stashes the tap's spline under
      // the layer's own id (layer.compute). Styling params still come from
      // the Layer Output, which owns the layer's export config.
      const isLayerOutput =
        node?.data.defType === GROUP_OUTPUT_TYPE &&
        (node.data.params as { fixed?: boolean })?.fixed === true;
      const stashId = (isLayerOutput ? node?.data.parentId : null) ?? nodeId;
      const stash = ctx.state[svgExportStashKey(stashId)] as
        | SvgExportStash
        | undefined;
      if (!stash || stash.subpaths.length === 0) {
        const where = isLayerOutput
          ? "Layer Output"
          : node?.data.defType === "output"
            ? "Output"
            : "SVG Export";
        flashToast(`Nothing to export — wire a spline into ${where}`);
        return;
      }
      const p = node?.data.params ?? {};
      const style = {
        stroke: p.stroke_enabled
          ? {
              color: (p.stroke_color as string) ?? "#ffffff",
              width: (p.stroke_width as number) ?? 4,
            }
          : undefined,
        fill: p.fill_enabled
          ? {
              color: (p.fill_color as string) ?? "#ffffff",
              rule:
                p.fill_rule === "nonzero"
                  ? ("nonzero" as const)
                  : ("evenodd" as const),
            }
          : undefined,
      };
      const svg = splineToSvg(stash.subpaths, stash.width, stash.height, style);
      // SVG Export defaults `filename` to "spline"; Output leaves it empty
      // (its placeholder is the auto-timestamp used by the raster products),
      // so fall back to the node's own name before the generic default —
      // same ladder as the image/video paths.
      const base =
        sanitizeFilename(((p.filename as string) ?? "").trim()) ||
        sanitizeFilename(node?.data.name ?? "") ||
        "spline";
      try {
        await platform.saveFile(new Blob([svg], { type: "image/svg+xml" }), {
          suggestedName: `${base}.svg`,
          mimeType: "image/svg+xml",
          filters: [{ name: "SVG", extensions: ["svg"] }],
        });
        flashToast(`Exported ${base}.svg`);
      } catch (err) {
        console.error("SVG export failed:", err);
        flashToast(err instanceof Error ? err.message : "SVG export failed");
      }
    },
    [flashToast]
  );

  useEffect(() => {
    const handler = async (e: Event) => {
      const detail = (
        e as CustomEvent<{
          id: string;
          kind: "image" | "video" | "sequence" | "gif" | "app" | "queue" | "svg";
        }>
      ).detail;
      if (!detail) return;
      // The offline single-export kinds share offlineRenderingRef and the
      // time save/restore, so they must not overlap. Take a SYNCHRONOUS lock
      // here (before the first await) so a double-click's second event bails —
      // recordingRef alone can't (it lags the React commit). Batch/queue paths
      // are serialized separately (queueRenderingRef) and stay unguarded here.
      const offlineKind =
        detail.kind === "image" ||
        detail.kind === "video" ||
        detail.kind === "sequence" ||
        detail.kind === "gif";
      if (offlineKind) {
        if (exportBusyRef.current) return;
        exportBusyRef.current = true;
        try {
          if (detail.kind === "image") await exportWedged(detail.id, "image");
          else if (detail.kind === "video") await exportWedged(detail.id, "video");
          else if (detail.kind === "sequence") await exportSequence(detail.id);
          else if (detail.kind === "gif") await exportGif(detail.id);
        } finally {
          exportBusyRef.current = false;
        }
        return;
      }
      if (detail.kind === "app") onOpenExportApp(detail.id);
      else if (detail.kind === "queue") renderQueue(detail.id);
      else if (detail.kind === "svg") exportSvgNode(detail.id);
    };
    window.addEventListener("effect-node-export", handler);
    return () => window.removeEventListener("effect-node-export", handler);
  }, [
    exportWedged,
    exportSequence,
    exportGif,
    onOpenExportApp,
    renderQueue,
    exportSvgNode,
  ]);

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
    // Wait out any in-flight streamed images so serialize never captures a
    // not-yet-loaded image as null. Failed streams settle to their envelope,
    // which round-trips — so this resolves even if a fetch errored.
    if (mediaLoadRef.current) await mediaLoadRef.current;
    const canvas = canvasRef.current;
    const thumbnail = canvas ? generateThumbnail(canvas, 256) : null;
    const graph = await serializeGraph(
      overlayLandedMedia(nodesRef.current),
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
      },
      {
        // Stamp the active comp's poster onto its registry entry (v5).
        compositions: compositionsForSave(thumbnail),
        activeCompositionId: activeCompositionIdRef.current,
      }
    );
    // Per-project tiled layout (M4) — attached post-serialize so
    // serializeGraph's signature (and its other callers: fragments,
    // exported apps) stay untouched.
    graph.layout = toSavedLayout(layoutTreeRef.current);
    setProgressStatus({ label: "saving", progress: SERIALIZE_SHARE, tone: "save" });
    // Heads-up on the INLINE media size. Post-Tier-2 the DB row is tiny
    // (media lives in Storage as refs), so this no longer gates the save —
    // the real ceiling is enforced on the final row inside the row writers
    // (guardRowSize), which only bites the rare inline-fallback path. A large
    // inline size still predicts a slow FIRST save while new assets upload.
    const approxMb = JSON.stringify(graph).length / (1024 * 1024);
    if (approxMb > 16) {
      flashToast(
        `large project (~${Math.round(approxMb)}MB) — first save may be slow`
      );
    }
    if (mode === "update" && existingId) {
      // Compare-and-swap only when updating the row THIS editor loaded —
      // the overwrite-by-name path targets a row we never loaded, so it
      // keeps last-writer-wins.
      const expected =
        existingId === currentProject?.id
          ? currentProject?.updatedAt ?? undefined
          : undefined;
      const res = await updateProjectRow(existingId, graph, thumbnail, expected);
      if (res.conflict) {
        throw new Error(
          "This project was saved from another window — reload it (or Save As a copy) before saving here."
        );
      }
      if (!res.ok) return null;
      // Carry the new row version forward so the next save's guard matches.
      if (res.updatedAt) {
        setCurrentProject((prev) =>
          prev && prev.id === existingId
            ? { ...prev, updatedAt: res.updatedAt }
            : prev
        );
      }
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
          recordCloudRecent(conflict.id, conflict.name);
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
        recordCloudRecent(result.id, name);
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
        recordCloudRecent(result.id, copyName);
        setSaveState("saved");
        setLoadRefreshKey((n) => n + 1);
        flashToast("saved a copy");
        return "saved";
      } catch (e) {
        // Surface the real reason — a thrown serialize/thumbnail error here
        // was previously swallowed, leaving only a bare "save failed".
        console.error("save failed (copy):", e);
        setSaveState("error");
        flashToast(e instanceof Error ? e.message : "save failed");
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
        recordCloudRecent(currentProject.id, currentProject.name);
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
      flashToast(e instanceof Error ? e.message : "save failed");
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
      recordCloudRecent(result.id, newName);
      setSaveState("saved");
      setLoadRefreshKey((n) => n + 1);
      flashToast(`saved as ${newName}`);
    } catch (e) {
      setSaveState("error");
      flashToast(e instanceof Error ? e.message : "save failed");
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
        const {
          nodes: nextNodes,
          edges: nextEdges,
          scene,
          compositions: nextComps,
          activeCompositionId: nextActiveComp,
          missingMedia,
          pendingMedia,
        } = await deserializeGraph(
          saved.graph,
          (f) =>
            setProgressStatus({
              label: "loading",
              progress: 1 - SERIALIZE_SHARE + f * SERIALIZE_SHARE,
              tone: "load",
            }),
          { deferRemoteMedia: true }
        );
        // Only snapshot the outgoing graph once the incoming one has
        // deserialized — a failed load must not insert an undo entry or
        // dirty the save pill.
        pushGraph(getGraphSnapshot());
        setNodes(nextNodes);
        setEdges(nextEdges);
        setCompositions(nextComps);
        setActiveCompositionId(nextActiveComp);
        setOpenCompositionIds(nextComps.map((c) => c.id));
        setView("editor");
        setAssetsFolder(null);
        setCurrentGroupId(defaultScopeFor(nextNodes, nextActiveComp));
        setMissingMedia(missingMedia);
        // Stream Storage-hosted images in after the graph is interactive.
        streamPendingMedia(pendingMedia);
        frameGraph();
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
        // Per-project tiled layout (M4): absent/malformed → default preset.
        applyLoadedLayout((saved.graph as { layout?: unknown }).layout);
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
          updatedAt: saved.updated_at,
        });
        recordCloudRecent(id, saved.name);
        // Load applies a graph snapshot via setNodes/setEdges, which
        // doesn't flow through pushGraph — so saveState isn't auto-
        // flipped to "dirty". Explicitly mark clean.
        setSaveState("saved");
        setProgressStatus({ label: "loading", progress: 1, tone: "load" });
      } catch (e) {
        console.error("[load] cloud project load failed:", e);
        flashToast(e instanceof Error ? e.message : "Could not load project");
      } finally {
        setProgressStatus(null);
      }
    },
    [pushGraph, getGraphSnapshot, setNodes, setEdges, user, setMissingMedia, streamPendingMedia, frameGraph, flashToast, applyLoadedLayout]
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
      // Wait out streamed images so a not-yet-loaded image doesn't serialize
      // as null (same guard as the cloud save path).
      if (mediaLoadRef.current) await mediaLoadRef.current;
      setProgressStatus({ label: "saving", progress: 0.1, tone: "save" });
      const canvas = canvasRef.current;
      const thumbnailDataUrl = canvas ? generateThumbnail(canvas, 256) : null;
      const graph = await serializeGraph(
        overlayLandedMedia(nodesRef.current),
        edgesRef.current,
        (f) =>
          setProgressStatus({ label: "saving", progress: f * 0.8, tone: "save" }),
        {
          loopFrames: loopFramesRef.current,
          fps: fpsRef.current,
          width: canvasResRef.current[0],
          height: canvasResRef.current[1],
        },
        {
          // Stamp the active comp's poster onto its registry entry (v5).
          compositions: compositionsForSave(thumbnailDataUrl),
          activeCompositionId: activeCompositionIdRef.current,
        }
      );
      // Per-project tiled layout (M4) — rides project.json in the zip.
      graph.layout = toSavedLayout(layoutTreeRef.current);
      const name =
        currentProject?.name ?? projectFileNameRef.current ?? "Untitled";
      const { writeProjectFile, TOOLBOX_EXTENSION } = await import(
        "@/lib/project-file"
      );
      const blob = await writeProjectFile({ name, graph, thumbnailDataUrl });
      setProgressStatus({ label: "saving", progress: 1, tone: "save" });
      projectFileNameRef.current = name;
      // downloadBlob's body, plus a recents poke once the save settles: on
      // desktop the native dialog records the path into main's recents
      // out-of-band, so the Open Recent list must refresh AFTER the dialog
      // closes. Fire-and-forget (not awaited) so the progress chip clears
      // immediately, exactly as before.
      void platform
        .saveFile(blob, {
          suggestedName: `${sanitizeFileName(name)}.${TOOLBOX_EXTENSION}`,
        })
        .then(() => notifyRecentProjectsChanged())
        .catch((e) => console.error("saveFile failed:", e));
    } catch (e) {
      console.error("Save to file failed:", e);
      flashToast(e instanceof Error ? e.message : "Could not save project file");
    } finally {
      setProgressStatus(null);
    }
  }, [currentProject, flashToast, compositionsForSave]);

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
        const {
          nodes: nextNodes,
          edges: nextEdges,
          scene,
          compositions: nextComps,
          activeCompositionId: nextActiveComp,
          missingMedia,
        } = await deserializeGraph(graph, (f) =>
          setProgressStatus({
            label: "loading",
            progress: 0.1 + f * 0.9,
            tone: "load",
          })
        );
        // Snapshot the outgoing graph only after a successful deserialize —
        // a failed open must not insert an undo entry or dirty the pill.
        pushGraph(getGraphSnapshot());
        suppressNextSelectionViewFlipRef.current = true;
        setNodes(nextNodes);
        setEdges(nextEdges);
        setCompositions(nextComps);
        setActiveCompositionId(nextActiveComp);
        setOpenCompositionIds(nextComps.map((c) => c.id));
        setView("editor");
        setAssetsFolder(null);
        setCurrentGroupId(defaultScopeFor(nextNodes, nextActiveComp));
        setMissingMedia(missingMedia);
        frameGraph();
        if (scene) {
          if ("loopFrames" in scene) setLoopFrames(scene.loopFrames ?? null);
          if (scene.fps !== undefined) setFps(scene.fps);
          if (scene.width !== undefined && scene.height !== undefined)
            setCanvasRes([scene.width, scene.height]);
        }
        // Per-project tiled layout (M4): absent/malformed → default preset.
        applyLoadedLayout((graph as { layout?: unknown }).layout);
        setSelectedId(null);
        setParamView("node");
        // A file-loaded project has no cloud row — cloud Save falls through
        // to Save As. Remember the name for the next Save to File.
        setCurrentProject(null);
        projectFileNameRef.current =
          file.name.replace(/\.toolbox$/i, "") || name;
        setSaveState("saved");
        // Desktop records opened paths into main's recents out-of-band
        // (files.js / recents.open) — refresh the Open Recent list. Web
        // FSA opens recorded at pick time refresh via the same poke.
        notifyRecentProjectsChanged();
        setProgressStatus({ label: "loading", progress: 1, tone: "load" });
        // Desktop: surface the assets/ folder beside the just-opened project
        // (main armed it when it read the file). Best-effort; web has no path.
        try {
          setAssetsFolder((await platform.assets?.scanCurrent?.()) ?? null);
        } catch {
          setAssetsFolder(null);
        }
      } catch (e) {
        console.error("Open project file failed:", e);
        flashToast(e instanceof Error ? e.message : "Could not open project file");
      } finally {
        setProgressStatus(null);
      }
    },
    [pushGraph, getGraphSnapshot, setNodes, setEdges, flashToast, setMissingMedia, frameGraph, applyLoadedLayout]
  );

  const handleOpenProjectFile = useCallback(() => {
    // Native: OS Open dialog. Web: FSA picker on Chromium — its handle is
    // recorded so File → Open Recent can reopen the file later
    // (073026_open-recent.md) — else the legacy <input type="file">
    // (which yields no handle, so those opens aren't recorded).
    if (platform.isNative) {
      void platform.pickOpenFiles({ kind: "toolbox" }).then((files) => {
        const file = files?.[0];
        if (file) void loadToolboxFile(file);
      });
      return;
    }
    if (supportsLocalFileRecents()) {
      // null = cancelled — no fallback dialog in that case.
      void pickAndRecordLocalToolbox().then((file) => {
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

  // --- File → Open Recent (spec 073026_open-recent.md) ----------------------
  // The merged recency-sorted list (localStorage cloud/web-local entries +
  // desktop native recents), kept in sync via the store's subscribe hook.
  const [recentProjects, setRecentProjects] = useState<RecentProjectEntry[]>(
    []
  );
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void listRecentProjects().then((list) => {
        if (alive) setRecentProjects(list);
      });
    };
    refresh();
    const unsub = subscribeRecentProjects(refresh);
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  const handleOpenRecent = useCallback(
    (entry: RecentProjectEntry) => {
      switch (entry.kind) {
        case "cloud":
          // loadProject can't distinguish deleted-row from network failure,
          // so a failed open only toasts (inside handleLoadProject) — it
          // never prunes the entry.
          void handleLoadProject(entry.id);
          return;
        case "local-native":
          void handleOpenLocalRecent(entry.path);
          return;
        case "local":
          // Handle from IDB + permission dance; self-prunes if the file is
          // gone, survives a permission denial.
          void openLocalRecentFile(entry.refId).then((file) => {
            if (file) void loadToolboxFile(file);
            else
              flashToast(
                "Couldn't open — the file may have moved, been deleted, or permission was denied."
              );
          });
          return;
      }
    },
    [handleLoadProject, handleOpenLocalRecent, loadToolboxFile, flashToast]
  );

  const handleClearRecents = useCallback(() => {
    void clearRecentProjects();
  }, []);

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
        // Reuse the save-progress chip so the UX matches a save.
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
          // The source row is gone; the conflict row is now "this project".
          removeCloudRecent(currentProject.id);
          recordCloudRecent(conflict.id, conflict.name);
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
      const renameRes = await renameProjectRow(
        currentProject.id,
        trimmed,
        currentProject.updatedAt ?? undefined
      );
      if (renameRes.conflict) {
        setSaveState("error");
        flashToast(
          "This project was saved from another window — reload it before renaming here."
        );
        return;
      }
      if (!renameRes.ok || !renameRes.updatedAt) {
        setSaveState("error");
        flashToast("rename failed");
        return;
      }
      // Rename bumps the row's updated_at — mirror it or the next save's
      // compare-and-swap would false-conflict.
      setCurrentProject({
        ...currentProject,
        name: trimmed,
        updatedAt: renameRes.updatedAt,
      });
      renameCloudRecent(currentProject.id, trimmed);
      setLoadRefreshKey((n) => n + 1);
      flashToast(`renamed to ${trimmed}`);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signedIn, user, currentProject, findConflict, flashToast]
  );

  // Project-title rename from the Project view. Cloud projects persist via
  // handleRenameProject; a local/file project just updates its base name
  // (a ref → bump a tick so the title re-renders).
  const canRenameProject =
    !currentProject || (!!user && currentProject.ownerId === user.id);
  const handleRenameProjectName = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      if (currentProject) {
        void handleRenameProject(trimmed);
      } else {
        projectFileNameRef.current = trimmed;
        setProjectNameTick((n) => n + 1);
      }
    },
    [currentProject, handleRenameProject]
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
    const result = await setProjectVisibilityRow(
      currentProject.id,
      next,
      currentProject.updatedAt ?? undefined
    );
    if (!result.ok) {
      setSaveState("error");
      flashToast(
        result.conflict
          ? "This project was saved from another window — reload it before changing visibility."
          : "visibility update failed"
      );
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
      // The toggle bumps updated_at — mirror it so the next save's
      // compare-and-swap doesn't false-conflict.
      updatedAt: result.updatedAt,
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
    setCompositions([{ id: fresh.compositionId, name: "Composition 1" }]);
    setActiveCompositionId(fresh.compositionId);
    setOpenCompositionIds([fresh.compositionId]);
    setView("editor");
    setAssetsFolder(null);
    setCurrentGroupId(fresh.layerId);
    setSelectedId(null);
    setParamView("node");
    setCurrentProject(null);
    projectFileNameRef.current = null;
    setSaveState("saved");
    frameGraph();
    // Drop any survival snapshot from a prior session — otherwise a
    // docs round-trip after File → New would resurrect the graph
    // the user explicitly walked away from.
    clearEditorSession();
  }, [setNodes, setEdges, frameGraph]);

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

  // Pie-menu items (config-driven registry). Each `run()` calls an
  // existing handler — the pie is just a fast radial launcher. The two
  // paramView entries replicate the MenuBar's onOpenLoad/onOpenAssets
  // logic (suppress the selection→view flip, clear selection). "Add
  // Node" hands the pie's origin to the node-search popup via a window
  // event the NodeEditor listens for. Spec: specdocs/071326_pie-menu.md.
  const pieItems = useMemo<PieMenuItem[]>(
    () => [
      {
        id: "save",
        label: "Save",
        hint: "⌘S",
        icon: SaveIcon,
        disabled: !signedIn,
        run: () => {
          void handleSave();
        },
      },
      {
        id: "projects",
        label: "Open Projects",
        icon: ProjectsIcon,
        run: () => {
          suppressNextSelectionViewFlipRef.current = true;
          setSelectedId(null);
          setNodes((prev) =>
            prev.map((n) => (n.selected ? { ...n, selected: false } : n)),
          );
          setParamView("load");
        },
      },
      {
        id: "assets",
        label: "Assets",
        icon: AssetsIcon,
        run: () => {
          suppressNextSelectionViewFlipRef.current = true;
          setParamView("assets");
        },
      },
      {
        id: "add-node",
        label: "Add Node",
        hint: "⇧A",
        icon: AddNodeIcon,
        run: () => {
          broadcastAppEvent(
            () =>
              new CustomEvent("toolbox:open-node-search", {
                detail: { ...lastPointerRef.current },
              })
          );
        },
      },
      {
        id: "split",
        label: "Split Viewport",
        hint: "⇧S",
        icon: SplitViewportIcon,
        run: () => setViewportSplit((v) => !v),
      },
      {
        id: "full-canvas",
        label: "Full Canvas",
        hint: "F",
        icon: FullCanvasIcon,
        run: () => setFullCanvas((v) => !v),
      },
      {
        id: "new",
        label: "New Project",
        icon: NewProjectIcon,
        run: () => handleNewProjectRef.current(),
      },
    ],
    [signedIn, handleSave, setNodes],
  );

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
  //
  // Multi-select: every selected gizmo-capable node renders its handles at
  // once (spec 070826_multiselect-gizmos.md), so these derive LISTS from
  // the nodes' `selected` flags (the same source Cmd+G reads). `selectedId`
  // is unioned in as a fallback for programmatic selects that haven't
  // echoed through ReactFlow yet — that keeps single-selection behavior
  // identical to the old selectedId-only lookup.
  const selectedGizmoCandidates = useMemo(() => {
    const sel = nodes.filter((n) => n.selected);
    if (selectedId && !sel.some((n) => n.id === selectedId)) {
      const n = nodes.find((nn) => nn.id === selectedId);
      if (n) sel.push(n);
    }
    return sel;
  }, [nodes, selectedId]);
  const transformGizmoNodes = useMemo(
    () =>
      selectedGizmoCandidates.filter(
        (n) => !!getNodeDef(n.data.defType)?.supportsTransformGizmo
      ),
    [selectedGizmoCandidates]
  );
  // On-canvas shape handles for selected spline primitives (Circle,
  // Rectangle, …). Driven by the adapter map so new primitives opt in
  // there without touching this wiring.
  const primitiveGizmoNodes = useMemo(
    () =>
      selectedGizmoCandidates.filter((n) => {
        const adapter = PRIMITIVE_GIZMO_ADAPTERS[n.data.defType];
        if (!adapter) return false;
        // An adapter can declare sockets that invalidate its handles
        // when wired (SDF's `position` chain retargets the whole sample
        // space, so the shape stops sitting at its raw x/y).
        if (adapter.hideWhenWired?.length) {
          const wired = edges.some(
            (e) =>
              e.target === n.id &&
              adapter.hideWhenWired!.some((h) => e.targetHandle === `in:${h}`)
          );
          if (wired) return false;
        }
        return true;
      }),
    [selectedGizmoCandidates, edges]
  );
  // With 2+ gizmos up, TransformGizmo trades its canvas-wide translate
  // surface for its bounds polygon so stacked gizmos don't fight over
  // empty-canvas drags.
  const multiGizmo =
    transformGizmoNodes.length + primitiveGizmoNodes.length > 1;

  // The TransformContextBar (flip H/V) stays bound to the single primary
  // selection, as does the ParamPanel.
  const activeTransformNode = selectedId
    ? nodes.find((n) => {
        if (n.id !== selectedId) return false;
        const def = getNodeDef(n.data.defType);
        return !!def?.supportsTransformGizmo;
      })
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

  // Draw-to-sample overlay: active whenever a Keyer node in sample mode is
  // selected (the other modes are pointer-free). Dragging on the canvas
  // scrubs colors from the node's input into its `sample_colors` param.
  const activeKeyerNode = selectedId
    ? nodes.find(
        (n) =>
          n.id === selectedId &&
          n.data.defType === "keyer" &&
          (n.data.params.mode as string) === "sample"
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

  // ---------------------------------------------------------------------
  // Shared building blocks for the layouts.
  //
  // The two layouts (default + timeline) need the same NodeEditor,
  // ParamPanel, dock body, and PlaybackBar — extracting them here keeps
  // a single source of truth for the props each receives so the
  // layouts only differ in how the pieces are arranged on screen.
  // ---------------------------------------------------------------------
  // Stable identities for NodeEditor's function props — inline closures
  // here would re-mint every render (every rAF tick during playback) and
  // defeat NodeEditor's memo. All three touch only refs / stable setters.
  const handleSelectNode = useCallback((id: string | null) => {
    if (suppressNextSelectionViewFlipRef.current) {
      suppressNextSelectionViewFlipRef.current = false;
      return;
    }
    setSelectedId(id);
    if (id) setParamView("node");
  }, []);
  const handlePanePointer = useCallback(
    (p: { x: number; y: number }) => {
      lastPanePointerRef.current = p;
    },
    []
  );
  const handleNavigateScope = useCallback(
    (id: string | null) => navigateScope(id ?? undefined),
    [navigateScope]
  );

  // Switch the param panel to the Project Settings view. Shared by File →
  // Project Settings… and the gear chip in a Parameters panel's header.
  //
  // Deselect so switching back to the node view doesn't silently resurrect
  // whichever node happened to be selected when the user opened Project
  // Settings. Clear React Flow's per-node `.selected` flag too —
  // setSelectedId alone leaves the node visually highlighted in the flow
  // pane. Same rule for Load.
  const openProjectSettings = useCallback(() => {
    suppressNextSelectionViewFlipRef.current = true;
    setSelectedId(null);
    setNodes((prev) =>
      prev.map((n) => (n.selected ? { ...n, selected: false } : n))
    );
    setParamView("project");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The per-panel editor-kind switcher chip. Re-assigning the LAST
  // viewport leaf away is blocked — the engine blit target, overlays
  // and the tracks dock all anchor to a live viewport panel.
  const panelKindMenuFor = (
    leafId: string,
    panel: PanelKind,
    floating: boolean,
    /** Square edge, for hosts whose control row has a fixed height. */
    size?: number
  ) => {
    const lastViewport =
      panel === "viewport" && countLeavesOfKind(layoutTree, "viewport") === 1;
    const reason = "The layout keeps at least one viewport";
    const detached = detachedPanels.some((d) => d.id === leafId);
    // Every kind pops out now (M2/M3). The primary viewport is the one
    // hold-out — it owns canvasRef and every overlay/gizmo, all of which
    // anchor to one canvas rect in this window.
    const popOutReason =
      panel === "viewport" && leafId === primaryViewportLeafId
        ? "The main viewport stays in this window"
        : panel === "viewport" && lastViewport
          ? reason
          : undefined;
    return (
      <PanelKindMenu
        value={panel}
        floating={floating}
        size={size}
        onChange={(kind) => handleAssignPanelKind(leafId, kind)}
        disabledReason={
          // A DETACHED panel can retype freely except into a viewport:
          // that would elect a second blit target outside the main
          // window while the tree still needs one inside it.
          detached
            ? {
                viewport:
                  "Retype this window's panel in place, or close it first",
              }
            : lastViewport
              ? { nodes: reason, params: reason, timeline: reason }
              : undefined
        }
        onPopOut={
          detached ? undefined : () => handleDetachPanel(leafId, panel)
        }
        popOutDisabledReason={popOutReason}
      />
    );
  };

  // One Node Editor pane instance per "nodes" leaf. Each pane wraps
  // itself in its OWN ReactFlowProvider so duplicates get independent
  // stores/cameras; window-level shortcuts route to the pane that owns
  // the instance scope (nodes-pane-scope.ts, claimed by NodeEditor's
  // wrapper). The panel-kind chip sits left of the composition tabs.
  const renderNodesPanel = (leafId: string) => (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        position: "relative",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "stretch",
          minWidth: 0,
          background: "var(--tb-n-0)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "0 0 0 4px",
            // Continue the tab bar's bottom border under the chip cell
            // so the header strip reads as one bar.
            borderBottom: "1px solid var(--tb-n-4)",
            flexShrink: 0,
          }}
        >
          {panelKindMenuFor(leafId, "nodes", false)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <CompositionTabBar
            tabs={openCompositionIds
              .map((id) => compositions.find((c) => c.id === id))
              .filter((c): c is SavedComposition => !!c)
              .map((c) => ({ id: c.id, name: c.name }))}
            activeId={activeCompositionId}
            onSelect={handleSwitchComposition}
            onClose={handleCloseComposition}
            onCreate={handleCreateComposition}
            onReorder={setOpenCompositionIds}
            canClose={openCompositionIds.length > 1}
          />
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <ReactFlowProvider>
        <NodeEditor
          paneId={leafId}
          nodes={scopedNodes}
      edges={edges}
      onNodesChange={onNodesChangeWithHistory}
      onEdgesChange={onEdgesChangeWithHistory}
      onConnect={onConnect}
      onSelectNode={handleSelectNode}
      onAddNode={onAddNode}
      onPanePointer={handlePanePointer}
      onDuplicateOnDrag={handleDuplicateOnDrag}
      onDetachNode={handleDetachNode}
      onDuplicateNode={handleDuplicateNode}
      onMakeEditableNode={handleMakeEditableNode}
      onDuplicateSelection={handleDuplicateSelection}
      onMergeSelection={handleMergeSelection}
      onCopyNodes={handleCopyNodes}
      onPasteNodes={handlePasteNodes}
      onPasteFragmentText={handlePasteFragmentText}
      onPasteSvgText={handlePasteSvgText}
      onEditWithAINode={handleEditWithAI}
      onAddFileNode={onAddFileNode}
      onAddImageNodeFromImageGen={onAddImageNodeFromImageGen}
      onAddAssetNode={onAddAssetNode}
      onCombineWires={handleCombineWires}
      onCutWires={handleCutWires}
      onSpliceNode={handleSpliceNode}
      onGroupSelection={handleGroupSelection}
      onUngroupSelection={handleUngroupSelection}
      onDiveIntoGroup={handleDiveIntoGroup}
      onReparentNode={handleReparentNode}
      onStyleNodes={handleStyleNodes}
      onFrameSelection={handleFrameSelection}
      onSetNodeFrame={handleSetNodeFrame}
      onScopeUp={handleScopeUp}
      breadcrumbs={breadcrumbs}
      onNavigateScope={handleNavigateScope}
      onOpenProject={handleOpenProjectView}
      atRoot={currentGroupId == null}
      frameSignal={frameGraphSignal}
      viewportOverlay={
        inspectIds.length > 0 || socketPeek ? (
          <>
            {inspectIds.map((id) => {
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
            })}
            {(() => {
              if (!socketPeek) return null;
              const n = nodes.find((x) => x.id === socketPeek.nodeId);
              if (!n) return null;
              // Re-read on every inspect bump — each eval refreshes the
              // popover with the value it just produced.
              void inspectTick;
              const out =
                evalCacheRef.current.get(socketPeek.nodeId)?.output ??
                lastEvalOutputsRef.current?.get(socketPeek.nodeId);
              const value =
                socketPeek.handle === "out:primary"
                  ? out?.primary
                  : out?.aux?.[socketPeek.handle.slice("out:aux:".length)];
              return (
                <SocketPeekPopover
                  key={`peek-${socketPeek.nodeId}-${socketPeek.handle}`}
                  node={n}
                  handle={socketPeek.handle}
                  anchorY={socketPeek.anchorY}
                  value={value}
                  evaluated={!!out}
                  canvasAspect={canvasRes[0] / canvasRes[1]}
                  readPixels={readPeekPixels}
                  onPointerEnter={holdSocketPeek}
                  onPointerLeave={clearSocketPeek}
                />
              );
            })()}
          </>
        ) : null
      }
        />
        </ReactFlowProvider>
      </div>
    </div>
  );

  // The Project view replaces the node editor while active. The preview /
  // timeline keep rendering the last-active composition (decision 4).
  const projectViewJsx = (
    <ProjectView
      projectName={
        currentProject?.name ?? projectFileNameRef.current ?? "Untitled"
      }
      canRenameProject={canRenameProject}
      compositions={compositions}
      activeId={activeCompositionId}
      assets={projectAssets}
      assetsFolderName={assetsFolder?.name ?? null}
      onPickAssetsFolder={handlePickAssetsFolder}
      onRenameProject={handleRenameProjectName}
      onEnter={handleEnterComposition}
      onCreate={handleCreateComposition}
      onDelete={handleDeleteComposition}
      onDuplicate={handleDuplicateComposition}
      onRename={handleRenameComposition}
      onReorder={handleReorderCompositions}
    />
  );
  // Leaf content router for the tiled LayoutRegion. The Project view
  // replaces the node editor in EVERY nodes leaf while active (same
  // rule as the old single editor pane); params leaves all mirror the
  // shared paramView; non-primary viewport leaves are watch windows.
  const renderLayoutPanel = (
    leafId: string,
    panel: PanelKind
  ): React.ReactNode => {
    if (panel === "viewport") {
      // The PRIMARY viewport leaf never reaches here — the LayoutRegion
      // renderPanel wrapper in the return JSX renders it inline (it owns
      // canvasRef + every overlay). Everything else is a watch window.
      return (
        <WatchViewport
          leafId={leafId}
          renderRes={renderRes}
          register={registerWatchCanvas}
          kindMenu={panelKindMenuFor(leafId, "viewport", true)}
          backdrop={canvasBackdrop}
        />
      );
    }
    if (panel === "timeline") {
      // The same dock the floating modal hosts. The editors inside all
      // size themselves off a ResizeObserver, so a panel that grows or
      // shrinks by its gutters needs nothing extra here. Its kind chip
      // rides in the toolbar's left cluster (renderDockBody), so no
      // header strip or floating chip of its own.
      return (
        <div
          className="timeline-dock"
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {renderDockBody({
            host: "panel",
            instanceId: `leaf:${leafId}`,
            leafId,
          })}
        </div>
      );
    }
    if (panel === "nodes") {
      if (view === "project") {
        return (
          <div
            style={{
              flex: 1,
              minHeight: 0,
              position: "relative",
              display: "flex",
              flexDirection: "column",
            }}
          >
            {panelKindMenuFor(leafId, "nodes", true)}
            {projectViewJsx}
          </div>
        );
      }
      return renderNodesPanel(leafId);
    }
    // Parameters: a slim header strip hosts the kind chip (ParamPanel's
    // own content starts with headers a floating chip would cover) plus,
    // at the far right, the Project Settings shortcut.
    return (
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            height: 24,
            padding: "0 4px",
            background: "var(--tb-n-0)",
            borderBottom: "1px solid var(--tb-n-4)",
            flexShrink: 0,
          }}
        >
          {panelKindMenuFor(leafId, "params", false)}
          <ProjectSettingsChip
            active={paramView === "project"}
            // Toggling back lands on the node view — Project Settings has
            // no back affordance of its own, so the chip is the way out.
            onClick={() =>
              paramView === "project"
                ? setParamView("node")
                : openProjectSettings()
            }
          />
        </div>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {paramPanelJsx}
        </div>
      </div>
    );
  };

  // Single 0..1 fraction for the queue item currently rendering. Offline
  // encoders (WebCodecs / ffmpeg) report it per frame via `recording`.
  // Realtime MediaRecorder captures report nothing; elapsed wall time over
  // the capture window stands in (the playhead itself can wrap when the
  // project loop is shorter than the capture, so don't use the clock).
  // The shell no longer re-renders during playback, so pulse a few
  // re-renders per second while a live capture runs to keep the wall-time
  // readout moving.
  const [, setLiveCapturePulse] = useState(0);
  useEffect(() => {
    if (recording?.mode !== "live") return;
    const id = window.setInterval(
      () => setLiveCapturePulse((n) => n + 1),
      200
    );
    return () => window.clearInterval(id);
  }, [recording?.mode]);
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
    broadcastAppEvent(
      () =>
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

  // Stable identities for ParamPanel's non-primitive props — inline
  // closures/objects would re-mint every render and defeat its memo.
  const handleSeekTick = useCallback(
    (tick: number) => onSeek(tick / (fps * ticksPerFrame)),
    [onSeek, fps, ticksPerFrame]
  );
  const handlePanelSelectNode = useCallback((nodeId: string) => {
    setNodes((prev) =>
      prev.map((n) => ({ ...n, selected: n.id === nodeId }))
    );
    setSelectedId(nodeId);
    setParamView("node");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Per-anchor keyframing (Spline Draw, spec 072726 M6): create or remove
  // the three vec2 tracks (anchor_p/in/out:<id>) for a set of anchors of
  // one subpath. Anchors without an id get one minted here (written into
  // the stored spline in the same pass — lazy ids, no migration). Enabling
  // seeds each track with a keyframe at the playhead pinning the current
  // pose; disabling deletes the tracks. One undo entry.
  const onAnchorAnimate = useCallback(
    (
      nodeId: string,
      subpathIndex: number,
      anchorIndexes: number[],
      enable: boolean
    ) => {
      pushGraph(getGraphSnapshot());
      const tickNow = playbackClock.get().tick;
      const mintId = () => Math.random().toString(36).slice(2, 9);
      setNodes((prev) =>
        prev.map((n) => {
          if (n.id !== nodeId) return n;
          const spline = n.data.params.spline as
            | { subpaths?: SplineSubpath[] }
            | undefined;
          if (!spline || !Array.isArray(spline.subpaths)) return n;
          const subs = spline.subpaths.map((s) => ({
            ...s,
            anchors: s.anchors.map((a) => ({ ...a })),
          }));
          const sub = subs[subpathIndex];
          if (!sub) return n;
          let animation = { ...(n.data.animation ?? {}) };
          for (const ai of anchorIndexes) {
            const a = sub.anchors[ai];
            if (!a) continue;
            if (!a.id) a.id = mintId();
            const id = a.id;
            if (enable) {
              const mk = (value: [number, number]) => ({
                animated: true,
                trackVisible: true,
                keyframes: [
                  { tick: tickNow, value, easingOut: "easeInOut" as const },
                ],
              });
              if (!animation[anchorPosKey(id)]?.animated) {
                animation[anchorPosKey(id)] = mk([a.pos[0], a.pos[1]]);
              }
              if (!animation[anchorInKey(id)]?.animated) {
                animation[anchorInKey(id)] = mk([
                  a.inHandle?.[0] ?? 0,
                  a.inHandle?.[1] ?? 0,
                ]);
              }
              if (!animation[anchorOutKey(id)]?.animated) {
                animation[anchorOutKey(id)] = mk([
                  a.outHandle?.[0] ?? 0,
                  a.outHandle?.[1] ?? 0,
                ]);
              }
            } else {
              animation = { ...animation };
              delete animation[anchorPosKey(id)];
              delete animation[anchorInKey(id)];
              delete animation[anchorOutKey(id)];
            }
          }
          return {
            ...n,
            data: {
              ...n.data,
              params: {
                ...n.data.params,
                spline: { ...spline, subpaths: subs },
              },
              animation,
            },
          };
        })
      );
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    []
  );
  const queueRenderInfo = useMemo(
    () =>
      queueProgress
        ? {
            nodeId: queueProgress.nodeId,
            activeItemId: queueProgress.itemId,
            itemProgress: queueItemProgress,
          }
        : null,
    [queueProgress, queueItemProgress]
  );

  const paramPanelJsx = paramView === "ai-recipe" ? (
    <AiRecipePanel
      key={editTarget ? `edit:${editTarget.groupId}` : "generate"}
      signedIn={signedIn}
      editTarget={editTarget ? { name: editTarget.name } : null}
      transcript={editTranscript}
      onClearTranscript={handleClearEditTranscript}
      onSubmit={editTarget ? handleEditGroup : handleGenerateRecipe}
      onClose={() => {
        setEditTarget(null);
        setParamView("node");
      }}
      onOpenPreferences={() => setUserPrefsOpen(true)}
    />
  ) : paramView === "assets" ? (
    <AssetsView
      assets={projectAssets}
      folderName={assetsFolder?.name ?? null}
      onPickFolder={handlePickAssetsFolder}
    />
  ) : (
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
      getAnimation={getAnimation}
      onAnimationChange={onAnimationChange}
      onSeekTick={handleSeekTick}
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
      queueRender={queueRenderInfo}
      onSelectNode={handlePanelSelectNode}
    />
  );

  // The body of the dock — the toolbar plus the active editor (Layers /
  // Tracks / Graph). Rendered by BOTH hosts: the floating modal and any
  // `timeline` leaf in the tiled layout (080226_timeline-modal-panel.md).
  // Kept as a closure rather than its own component on purpose — it
  // reads ~30 values off this scope, and props-threading all of them
  // would buy nothing (same call as the primary viewport's inline JSX).
  //
  // `host` decides only what occupies the slot left of the tab toggle:
  // the close ✕ in the modal, the panel-kind chip in a panel (a panel
  // closes through the tiling join gesture, so it has no ✕). The
  // wrapping container — flex sizing, frame, position — belongs to the
  // caller.
  const renderDockBody = (opts: {
    host: "modal" | "panel";
    instanceId: string;
    /** Panel host only — the leaf the kind chip reassigns. */
    leafId?: string;
  }) => {
    const { host, instanceId, leafId } = opts;
    const dockTab = dockTabFor(instanceId);
    const setDockTab = (tab: DockTab) => setDockTabFor(instanceId, tab);
    return (
      <>
        <div
          // The modal's drag bar. Only presses on the bar ITSELF start a
          // drag (see startDockDrag) — its buttons and the two cluster
          // wrappers are descendants, so they keep working normally.
          onPointerDown={host === "modal" ? startDockDrag : undefined}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            // Equal margin on all sides around the buttons.
            padding: 6,
            background: "var(--tb-frame)",
            borderBottom: "1px solid var(--tb-n-7)",
            flexShrink: 0,
            cursor: host === "modal" ? "grab" : undefined,
            // The bar owns its gesture, so iPadOS can't reinterpret a
            // finger/Pencil drag as a scroll and cancel the pointer stream.
            ...(host === "modal" ? TOUCH_DRAG_STYLE : null),
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {host === "modal" ? (
              <DockButton onClick={() => setTrackEditorOpen(false)} title="Close">
                ✕
              </DockButton>
            ) : (
              leafId &&
              panelKindMenuFor(leafId, "timeline", false, DOCK_CTRL_H)
            )}
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
              onAnimationChange={onAnimationChange}
              onScrub={(tick) => onSeek(tick / (fps * ticksPerFrame))}
              normalizeY={graphNormalizeY}
              refitVersion={graphRefitVersion}
            />
          )}
        </div>
      </>
    );
  };

  const playbackBarJsx = !fullCanvas && (
    <PlaybackBar
      fps={fps}
      loopFrames={loopFrames}
      onPlayPause={onPlayPause}
      onReset={onReset}
      onSeek={onSeek}
      onScrubStart={onScrubStart}
      onScrubEnd={onScrubEnd}
      onLoopFramesChange={setLoopFrames}
      tracksOpen={trackEditorOpen}
      onToggleTracks={() => setTrackEditorOpen((o) => !o)}
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
        background: "var(--tb-frame)",
        color: "var(--tb-n-16)",
        fontFamily: "var(--ui-font)",
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
        onOpenProjectSettings={openProjectSettings}
        onNewProject={handleNewProject}
        onSave={handleSave}
        onSaveAs={() => setSaveModalOpen(true)}
        onSaveAsNamed={handleSaveAsProject}
        onSaveIncremental={handleSaveIncremental}
        canSaveIncremental={signedIn && !!currentProject}
        onOpenLanding={() => {
          // menuSettled back to false so the bar animates out and in
          // again rather than snapping once the gateway clears.
          setMenuSettled(false);
          setLandingReopened(true);
          setShowLanding(true);
        }}
        onOpenLoad={() => {
          suppressNextSelectionViewFlipRef.current = true;
          setSelectedId(null);
          setNodes((prev) =>
            prev.map((n) => (n.selected ? { ...n, selected: false } : n))
          );
          setParamView("load");
        }}
        onOpenAssets={() => {
          suppressNextSelectionViewFlipRef.current = true;
          setParamView("assets");
        }}
        onOpenProjectFile={handleOpenProjectFile}
        recentProjects={recentProjects}
        onOpenRecent={handleOpenRecent}
        onClearRecents={handleClearRecents}
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
        layoutPresets={layoutPresetEntries(layoutPresets)}
        onApplyLayoutPreset={applyLayoutPreset}
        onNewLayoutPreset={() => setNewLayoutPresetOpen(true)}
        onOpenUserPreferences={() => setUserPrefsOpen(true)}
        mcpStatus={mcp.status.state}
        onToggleMcpBridge={mcp.toggle}
        statusToast={toast}
        consoleLog={consoleLog}
        progressStatus={progressStatus}
      />
      </div>
      </div>
      {/* Tiled editor body (072726_window-tiling.md). The PRIMARY
          viewport panel renders inline right here — it owns canvasRef,
          every on-canvas overlay/gizmo, the tracks dock and the
          Shift+S A/B split, so its JSX keeps living where it always
          has. Every other leaf (nodes / params / watch viewports)
          routes through renderLayoutPanel. Full-canvas mode solos the
          primary viewport leaf edge-to-edge (all other panels stay
          mounted, display:none). */}
      <LayoutRegion
        tree={layoutTree}
        soloLeafId={fullCanvas ? primaryViewportLeafId : null}
        onSetRatio={handleSetLayoutRatio}
        onSplitLeaf={handleSplitLeaf}
        onSwapLeaves={handleSwapPanels}
        onJoinLeaves={handleJoinPanels}
        renderPanel={(leafId, panel) => {
          if (panel !== "viewport" || leafId !== primaryViewportLeafId) {
            return renderLayoutPanel(leafId, panel);
          }
          return (
            <div
              style={{
                flex: 1,
                minWidth: 0,
                minHeight: 0,
                position: "relative",
                display: "flex",
                flexDirection: "column",
              }}
            >
        {!fullCanvas && (
          <ViewportMenuBar
            leading={panelKindMenuFor(leafId, "viewport", false)}
            projectRes={canvasRes}
            previewScale={previewScale}
            onPreviewScaleChange={setPreviewScale}
            trailing={
              <>
                <ViewportGizmoToggle
                  on={showGizmos}
                  onToggle={() => setShowGizmos((v) => !v)}
                />
                <ViewportCheckerToggle
                  on={showChecker}
                  onToggle={() => setShowChecker((v) => !v)}
                />
              </>
            }
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
            background: "var(--tb-n-0)",
            padding: fullCanvas ? 0 : 12,
            overflow: "hidden",
            // Confine all on-canvas GUI (transform/primitive/gradient
            // gizmos, spline pen, points/segment dots, 3D + particle
            // overlays, text box handles) to the canvas area. Every one of
            // those overlays is `position: fixed` with viewport-space coords
            // (canvas.getBoundingClientRect), so it escapes the `overflow:
            // hidden` above AND jumps to the root stacking context — which is
            // why it used to paint over the node editor, param panel, and
            // timeline. `clip-path` is a grouping clip that, unlike
            // `overflow`, DOES clip fixed descendants, and the stacking
            // context it establishes traps them here so the surrounding app
            // chrome always renders on top. It does not reparent their
            // containing block, so the overlays' viewport-coordinate math is
            // unchanged. Keep this in sync if the canvas viewport moves.
            clipPath: "inset(0)",
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
                background: canvasBackdrop,
                border: "1px solid var(--tb-n-1)",
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
                const startY = e.clientY;
                const parent = (e.currentTarget as HTMLDivElement)
                  .parentElement;
                if (!parent) return;
                const total = parent.clientHeight;
                const startRatio = viewportSplitRatio;
                const started = startPointerDrag(e, {
                  cursor: "row-resize",
                  onMove: (ev) => {
                    const dy = ev.clientY - startY;
                    const next = Math.max(
                      0.1,
                      Math.min(0.9, startRatio + dy / Math.max(1, total))
                    );
                    setViewportSplitRatio(next);
                  },
                  onCancel: () => setViewportSplitRatio(startRatio),
                });
                if (started) e.preventDefault();
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
                  background: canvasBackdrop,
                  border: "1px solid var(--tb-n-7)",
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
              // Keyed per node so per-session state (tool, the Shift-line
              // anchor) resets instead of leaking across paint nodes.
              key={activePaintNode.id}
              nodeId={activePaintNode.id}
              params={activePaintNode.data.params}
              canvasRes={canvasRes}
              previewCanvas={canvasRef.current}
              onParamChange={onParamChange}
              onStrokeCommit={(nodeId, canvas, before) =>
                pushPaint({ nodeId, canvas, imageData: before })
              }
            />
          )}
          {showGizmos &&
            selectedPoints &&
            selectedPoints.count > 0 &&
            backendReady && (
              <PointsOverlay
                canvas={canvasRef.current}
                value={selectedPoints}
              />
            )}
          {showGizmos && active3DSceneRenderId && backendReady && (
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
          {showGizmos && activeSplineNode && backendReady && (
            <SplineEditorOverlayAtTick
              node={activeSplineNode}
              nodes={nodes}
              canvas={canvasRef.current}
              onParamChange={onParamChange}
              onSelectNode={handlePanelSelectNode}
              onAnchorAnimate={onAnchorAnimate}
            />
          )}
          {showGizmos && activeSegmentNode && backendReady && (
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
          {showGizmos && activeKeyerNode && backendReady && (
            <KeyerSampleOverlay
              canvas={canvasRef.current}
              colors={
                Array.isArray(activeKeyerNode.data.params.sample_colors)
                  ? (activeKeyerNode.data.params.sample_colors as string[])
                  : []
              }
              onChange={(next) =>
                onParamChange(activeKeyerNode.id, "sample_colors", next)
              }
              getSourcePixels={() =>
                getKeyerSourcePixels(activeKeyerNode.id)
              }
            />
          )}
          {showGizmos &&
            backendReady &&
            transformGizmoNodes.map((gizmoNode) => (
              <TransformGizmoAtTick
                key={gizmoNode.id}
                node={gizmoNode}
                canvas={canvasRef.current}
                boundsSourceId={
                  gizmoNode.data.params.mode === "spline"
                    ? edges.find(
                        (e) =>
                          e.target === gizmoNode.id &&
                          e.targetHandle === "in:image"
                      )?.source
                    : undefined
                }
                evalCacheRef={evalCacheRef}
                multiGizmo={multiGizmo}
                ticksPerFrame={ticksPerFrame}
                onParamChange={onParamChange}
                onMotionPathPointChange={onMotionPathPointChange}
              />
            ))}
          {/* Shape-primitive handles (Circle, Rectangle, …) — move the
              center, drag edges/corners to resize. */}
          {showGizmos &&
            backendReady &&
            primitiveGizmoNodes.map((node) => (
              <PrimitiveGizmoAtTick
                key={node.id}
                node={node}
                canvas={canvasRef.current}
                canvasWidth={canvasRes[0]}
                canvasHeight={canvasRes[1]}
                evalCacheRef={evalCacheRef}
                ticksPerFrame={ticksPerFrame}
                onParamChange={onParamChange}
                onMotionPathPointChange={onMotionPathPointChange}
              />
            ))}
          {/* Gradient handles — linear endpoints (line + 2 dots) or the
              radial center/radius. */}
          {showGizmos && activeGradientNode && backendReady && (
            <GradientOverlayAtTick
              node={activeGradientNode}
              canvas={canvasRef.current}
              onParamChange={onParamChange}
            />
          )}
          {recording && <RecordingBanner state={recording} />}
          {queueProgress && <QueueBanner state={queueProgress} />}
          <MediaRelinkModal
            open={relinkItems.length > 0}
            items={relinkItems}
            busy={relinkBusy}
            onRelink={relinkMissingMedia}
            onClose={() => setRelinkItems([])}
          />
        </div>
            </div>
          );
        }}
      />
      {/* Panels detached into their own OS windows (M1 — viewport only;
          080226_panel-popout-windows.md). Each renders the SAME
          renderLayoutPanel body the tiled grid would, portalled into a
          same-origin child document: a detached watch viewport
          registers its canvas in exactly the same registry and the eval
          loop blits to it without knowing it lives elsewhere. */}
      {detachedPanels.map((d) => (
        <PanelPopout
          key={d.id}
          id={d.id}
          title={`${currentProject?.name ?? "Untitled"} — ${PANEL_LABELS[d.panel]}`}
          onClose={() => handleRehomePanel(d.id, d.panel)}
          onBlocked={() => {
            handleRehomePanel(d.id, d.panel);
            flashToast("Allow pop-ups for this site to open a panel window");
          }}
        >
          {renderLayoutPanel(d.id, d.panel)}
        </PanelPopout>
      ))}
      {/* The floating timeline dock (080226_timeline-modal-panel.md).
          A ROOT-LEVEL fixed layer, not a child of the viewport panel —
          nothing on this path carries a transform/filter, so `fixed`
          resolves against the window. z 900 puts it over every panel and
          its overlays (which top out at 50) while staying under the
          playback bar (950), the menu bar (1000) and the blocking
          dialogs (2000). Hidden in full-canvas, like the playback bar. */}
      {trackDockMounted && !fullCanvas && (
        <div
          className="timeline-dock"
          style={{
            position: "fixed",
            left: dockRect.x,
            top: dockRect.y,
            width: dockRect.w,
            height: dockRect.h,
            background: "var(--tb-n-0)",
            // Match the framed panels: thin stroke + clipping (which the
            // editors rely on). The radius overrides PANEL_FRAME's 5 —
            // this is a floating window, not a tiled panel, so it carries
            // a softer corner.
            ...PANEL_FRAME,
            borderRadius: 12,
            boxShadow: "0 12px 40px rgba(0,0,0,0.55)",
            display: "flex",
            flexDirection: "column",
            zIndex: 900,
            // Slide up from below the window edge on open (and back down
            // on close). Parking by exactly `100dvh - y` puts the top of
            // the box on the bottom edge, so no sliver stays visible
            // whatever the resting rect is.
            transform: trackDockShown
              ? "translateY(0)"
              : `translateY(calc(100dvh - ${dockRect.y}px))`,
            transition: "transform 240ms cubic-bezier(0.16, 1, 0.3, 1)",
            // A drag that outruns the pointer would otherwise select
            // text in the editors underneath the cursor.
            userSelect: dockDragging ? "none" : undefined,
          }}
        >
          {renderDockBody({ host: "modal", instanceId: DOCK_MODAL_ID })}
          {/* Resize handles — 4 edges + 4 corners, overlaid so they add
              no layout size. Corners sit above the edges they overlap.
              Grab zones double on a touch primary (DOCK_EDGE_HIT /
              DOCK_CORNER_HIT): 6px is a mouse target, not a fingertip one.
              The corners grow more than the edges because they're the
              handles people actually reach for, and unlike the edges they
              don't run the full side of the dock over its content. */}
          {(
            [
              [
                "n",
                { top: 0, left: 0, right: 0, height: dockEdgeHit },
                "ns-resize",
                11,
              ],
              [
                "s",
                { bottom: 0, left: 0, right: 0, height: dockEdgeHit },
                "ns-resize",
                11,
              ],
              [
                "w",
                { top: 0, bottom: 0, left: 0, width: dockEdgeHit },
                "ew-resize",
                11,
              ],
              [
                "e",
                { top: 0, bottom: 0, right: 0, width: dockEdgeHit },
                "ew-resize",
                11,
              ],
              [
                "nw",
                { top: 0, left: 0, width: dockCornerHit, height: dockCornerHit },
                "nwse-resize",
                12,
              ],
              [
                "ne",
                {
                  top: 0,
                  right: 0,
                  width: dockCornerHit,
                  height: dockCornerHit,
                },
                "nesw-resize",
                12,
              ],
              [
                "sw",
                {
                  bottom: 0,
                  left: 0,
                  width: dockCornerHit,
                  height: dockCornerHit,
                },
                "nesw-resize",
                12,
              ],
              [
                "se",
                {
                  bottom: 0,
                  right: 0,
                  width: dockCornerHit,
                  height: dockCornerHit,
                },
                "nwse-resize",
                12,
              ],
            ] as const
          ).map(([edge, box, cursor, z]) => (
            <div
              key={edge}
              onPointerDown={(e) => startDockResize(e, edge)}
              style={{
                position: "absolute",
                ...box,
                cursor,
                zIndex: z,
                ...TOUCH_DRAG_STYLE,
              }}
            />
          ))}
        </div>
      )}
      {playbackBarJsx && (
        <div
          style={{
            flexShrink: 0,
            background: "var(--tb-frame)",
            // No vertical gap and only a hair of side inset, so the timeline
            // sits tight and spans a touch wider than the panels above.
            padding: "0 1px",
            // Above the floating dock (900) — the dock slides UNDER the
            // playback bar, per 080226_timeline-modal-panel.md §2.
            position: "relative",
            zIndex: 950,
          }}
        >
          {playbackBarJsx}
        </div>
      )}
      {pieMenu && (
        <PieMenu
          key={`${pieMenu.x},${pieMenu.y}`}
          origin={pieMenu}
          items={pieItems}
          onClose={() => setPieMenu(null)}
        />
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
      {mcp.status.state === "pairing" && (
        <McpPairingDialog
          code={mcp.status.code}
          onConfirm={mcp.confirmPairing}
          onCancel={mcp.cancelPairing}
        />
      )}
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
            estimatedSizeBytes={exportAppEstimate?.totalBytes ?? null}
            estimatedContentBytes={exportAppEstimate?.contentBytes ?? null}
            mlRuntimeIncluded={exportAppEstimate?.ml ?? false}
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
      {newLayoutPresetOpen && (
        <NewLayoutPresetModal
          onClose={() => setNewLayoutPresetOpen(false)}
          onSave={saveLayoutPreset}
          existingNames={layoutPresets.map((p) => p.name)}
        />
      )}
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
            // Via handleNewProject, not resetToFreshProject: now that the
            // gateway can be re-opened over a live editor, "New Project"
            // has to clear the unsaved-work confirm first. On the
            // first-load path saveState is "saved", so it still goes
            // straight through.
            handleNewProject();
          }}
          onClose={
            landingReopened ? () => setShowLanding(false) : undefined
          }
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
//
// "The window level" means the window that owns the VIEWPORT, resolved
// via ownerDocument (layout/panel-window.ts) — not the module-scope
// `window`, which is always the main one. A popped-out viewport
// (080226_panel-popout-windows.md) lives in another document, where
// module-scope `window` would both miss the child's events and
// hit-test the main window's pointer coordinates against a rect from a
// different coordinate space.
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
    const win = ownerWindow(viewportRef.current);
    win.addEventListener("wheel", onWheel, { passive: false });
    return () => win.removeEventListener("wheel", onWheel);
  }, [viewportRef, setPan, setZoom]);

  useEffect(() => {
    const win = ownerWindow(viewportRef.current);
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
        win.removeEventListener("pointermove", onMove);
        win.removeEventListener("pointerup", onUp);
      };
      win.addEventListener("pointermove", onMove);
      win.addEventListener("pointerup", onUp);
    };
    win.addEventListener("pointerdown", onDown);
    return () => win.removeEventListener("pointerdown", onDown);
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

// Watch viewport — a non-primary viewport leaf in the tiled layout
// (072726_window-tiling.md §5). Pure blit target: registers its canvas
// with EffectsShell's watch registry (renderFrame copies the terminal
// image to it every eval) and owns its own pan/zoom, exactly like the
// primary's frame controls. No overlays, no dock — those anchor to the
// primary viewport only.
function WatchViewport({
  leafId,
  renderRes,
  register,
  kindMenu,
  backdrop,
}: {
  leafId: string;
  renderRes: [number, number];
  register: (leafId: string, el: HTMLCanvasElement | null) => void;
  kindMenu: React.ReactNode;
  /** Checker or flat plate — the shell's one global choice, passed down. */
  backdrop: string;
}) {
  const { viewportRef, zoom, pan, setZoom, setPan, reset, isDefault } =
    useViewportPanZoom();
  useViewportGestures(viewportRef, setPan, setZoom);
  const canvasRef = useCallback(
    (el: HTMLCanvasElement | null) => register(leafId, el),
    [leafId, register]
  );
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        position: "relative",
        display: "flex",
        flexDirection: "column",
        background: "var(--tb-n-0)",
        padding: 12,
        overflow: "hidden",
      }}
    >
      {kindMenu}
      <div
        ref={viewportRef}
        style={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          width: "100%",
          overflow: "hidden",
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
            background: backdrop,
            border: "1px solid var(--tb-n-1)",
            transform: `translate(${pan[0]}px, ${pan[1]}px) scale(${zoom})`,
            transformOrigin: "center center",
          }}
        />
        {!isDefault && (
          <ViewportZoomChip
            label={`${Math.round(zoom * 100)}% · reset`}
            onClick={reset}
          />
        )}
      </div>
    </div>
  );
}

// Splitter handle. Renders a thin 1px visual line but keeps a wider
// (default 5px) hit-target so it's easy to grab.
function Divider({
  orientation,
  hit = 5,
  thickness = 1,
  color = "var(--tb-n-7)",
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
  // Fingertip-sized grab zone on a touch primary; same constants the tiled
  // LayoutRegion seams use, so both kinds of splitter grow together.
  const gutterHit = useCoarsePointer() ? GUTTER_HIT_COARSE : GUTTER_HIT;
  // Negative margin reclaims the grab zone's extra width so it nets out
  // to PANEL_GAP of layout while overlapping the panels for easy grabbing.
  const bleed = -(gutterHit - PANEL_GAP) / 2;
  const gutterStyle: React.CSSProperties = gutter
    ? isH
      ? { height: gutterHit, marginTop: bleed, marginBottom: bleed, position: "relative", zIndex: 10 }
      : { width: gutterHit, marginLeft: bleed, marginRight: bleed, position: "relative", zIndex: 10 }
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
        // The splitter owns its gesture — without this iPadOS treats a
        // finger/Pencil drag as a scroll of whichever panel is under it
        // and cancels the pointer stream before the first move lands.
        ...TOUCH_DRAG_STYLE,
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

/**
 * Transparency-grid switch. Lives in the viewport menu bar's trailing slot
 * — same row as the preview-resolution slider, hard right — rather than
 * floating over the canvas, so nothing overlaps the image. Global: it
 * drives the backdrop of every viewport canvas, not just the primary.
 *
 * The glyph IS the thing it controls — a miniature of the canvas checker,
 * flat plate when off — so it shows the state it's about to leave behind
 * and needs no label. Sized 17px to match the panel-kind chip and the
 * MiniBarSlider beside it.
 */
function ViewportCheckerToggle({
  on,
  onToggle,
}: {
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      aria-pressed={on}
      title={
        on
          ? "Transparency grid on — click for a flat backdrop"
          : "Transparency grid off — click to show alpha as a checker"
      }
      style={{
        width: 19,
        height: 17,
        padding: 0,
        display: "grid",
        placeItems: "center",
        boxSizing: "border-box",
        background: on ? "var(--tb-n-5)" : "var(--tb-n-3)",
        border: `1px solid ${on ? "var(--tb-n-9)" : "var(--tb-n-7)"}`,
        borderRadius: 3,
        cursor: "pointer",
      }}
    >
      <span
        style={{
          width: 11,
          height: 11,
          borderRadius: 2,
          // Same conic recipe as the canvas, scaled to the glyph, and a
          // couple of ramp steps brighter on both cells so it still reads
          // at 11px against the chip fill.
          background: on
            ? "repeating-conic-gradient(var(--tb-n-13) 0% 25%, var(--tb-n-8) 0% 50%) 0 0 / 5.5px 5.5px"
            : "var(--tb-frame)",
          boxShadow: on ? "none" : "inset 0 0 0 1px var(--tb-n-9)",
        }}
      />
    </button>
  );
}

/**
 * On-canvas GUI switch — sits immediately left of the transparency-grid
 * toggle in the viewport menu bar's trailing slot, and shares its chrome
 * (19×17 chip, pressed fill when on) so the two read as one pair of view
 * options.
 *
 * The glyph is a miniature gizmo: a bounds box with corner handles, which
 * is what most of the overlays it controls actually look like. Struck
 * through when off, the standard "this layer of drawing is suppressed"
 * mark, since an empty box would just read as a lighter gizmo.
 */
function ViewportGizmoToggle({
  on,
  onToggle,
}: {
  on: boolean;
  onToggle: () => void;
}) {
  const stroke = on ? "var(--tb-n-16)" : "var(--tb-n-11)";
  return (
    <button
      onClick={onToggle}
      aria-pressed={on}
      title={
        on
          ? "Node GUI on — click to hide the selected node's on-canvas handles"
          : "Node GUI off — click to show the selected node's on-canvas handles"
      }
      style={{
        width: 19,
        height: 17,
        padding: 0,
        display: "grid",
        placeItems: "center",
        boxSizing: "border-box",
        background: on ? "var(--tb-n-5)" : "var(--tb-n-3)",
        border: `1px solid ${on ? "var(--tb-n-9)" : "var(--tb-n-7)"}`,
        borderRadius: 3,
        cursor: "pointer",
      }}
    >
      <svg width={11} height={11} viewBox="0 0 11 11" aria-hidden>
        <rect
          x={2.5}
          y={2.5}
          width={6}
          height={6}
          fill="none"
          stroke={stroke}
          strokeWidth={1}
          strokeDasharray="1.6 1.4"
        />
        {[
          [2.5, 2.5],
          [8.5, 2.5],
          [2.5, 8.5],
          [8.5, 8.5],
        ].map(([cx, cy]) => (
          <rect
            key={`${cx},${cy}`}
            x={cx - 1.25}
            y={cy - 1.25}
            width={2.5}
            height={2.5}
            fill={stroke}
          />
        ))}
        {!on && (
          <line
            x1={0.75}
            y1={10.25}
            x2={10.25}
            y2={0.75}
            stroke="var(--tb-n-14)"
            strokeWidth={1.25}
          />
        )}
      </svg>
    </button>
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
        // Tucked into the corner of the viewport, same inset as the
        // menu bar's trailing controls at the top.
        right: 4,
        bottom: 4,
        background: "var(--tb-n-3)",
        color: "var(--tb-n-13)",
        border: "1px solid var(--tb-n-9)",
        borderRadius: 3,
        padding: "3px 8px",
        fontFamily: "var(--ui-font)",
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
        background: "color-mix(in srgb, var(--tb-n-0) 85%, transparent)",
        color: "var(--tb-n-13)",
        border: "1px solid var(--tb-n-7)",
        borderRadius: 3,
        fontFamily: "var(--ui-font)",
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
    broadcastAppEvent(() => new CustomEvent("keyframe-stagger-end"));
  }, []);

  const toggle = () => {
    if (open) {
      close();
      return;
    }
    let responded = false;
    // Broadcast: the editor that answers may be in a popped-out
    // timeline window (080226_panel-popout-windows.md). `respond` is
    // called synchronously by whichever listener claims the gesture, so
    // the flag is settled by the time this returns.
    broadcastAppEvent(
      () =>
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
    broadcastAppEvent(
      () =>
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
          width: DOCK_CTRL_H,
          height: DOCK_CTRL_H,
          boxSizing: "border-box",
          borderRadius: DOCK_RADIUS_INNER,
          background: open ? "var(--tb-a-navy-deep)" : "var(--tb-n-0)",
          border: `1px solid ${open ? "var(--tb-a-navy-tint)" : "var(--tb-n-7)"}`,
          color: open ? "var(--tb-a-blue-200)" : "var(--tb-n-12)",
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
              background: "var(--tb-n-3)",
              border: "1px solid var(--tb-n-7)",
              borderRadius: 6,
              boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
              padding: 8,
              width: 160,
            }}
          >
          <div
            style={{
              color: "var(--tb-n-11)",
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
            <div style={{ color: "var(--tb-n-10)", fontSize: 10, lineHeight: 1.4 }}>
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
  useEffect(() => {
    if (!editing) setText(String(value));
  }, [value, editing]);
  // Scrub state lives inside the gesture rather than in a ref + a pair of
  // always-mounted window listeners: the drag is scoped to the press, and
  // `startPointerDrag` guarantees it ends exactly once even if iPadOS
  // cancels it mid-way.
  const startScrub = (e: React.PointerEvent<HTMLDivElement>) => {
    const startX = e.clientX;
    const startVal = value;
    let moved = false;
    const started = startPointerDrag(e, {
      cursor: "ew-resize",
      onMove: (ev) => {
        if (Math.abs(ev.clientX - startX) > 2) moved = true;
        onChange(startVal + Math.round((ev.clientX - startX) / 5));
      },
      // A press that never travelled is a click — switch to typing.
      onUp: () => {
        if (!moved) setEditing(true);
      },
      onCancel: () => onChange(startVal),
    });
    if (started) e.preventDefault();
  };
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
        background: "var(--tb-n-0)",
        border: "1px solid var(--tb-n-9)",
        color: "var(--tb-n-16)",
        fontFamily: "var(--ui-font)",
        fontSize: 12,
        padding: "4px 6px",
        borderRadius: 4,
        boxSizing: "border-box",
      }}
    />
  ) : (
    <div
      onPointerDown={startScrub}
      title="Drag to scrub, click to type — frames offset per layer step"
      style={{
        width: "100%",
        background: "var(--tb-n-0)",
        border: "1px solid var(--tb-n-7)",
        color: "var(--tb-n-16)",
        fontFamily: "var(--ui-font)",
        fontSize: 12,
        padding: "4px 6px",
        borderRadius: 4,
        boxSizing: "border-box",
        cursor: "ew-resize",
        userSelect: "none",
        display: "flex",
        justifyContent: "space-between",
        ...TOUCH_DRAG_STYLE,
      }}
    >
      <span>{value}</span>
      <span style={{ color: "var(--tb-n-10)" }}>frames</span>
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
  value: DockTab;
  onChange: (v: DockTab) => void;
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
        alignItems: "stretch",
        height: DOCK_CTRL_H,
        boxSizing: "border-box",
        background: "var(--tb-n-0)",
        border: "1px solid var(--tb-n-7)",
        borderRadius: DOCK_RADIUS,
        padding: 2,
      }}
    >
      {/* Sliding highlight — one button-width, translated to the active
          tab. The width has to be derived the SAME way the buttons' is
          (the track minus both 2px pads, split N ways) — the old
          `calc(100%/N - 2px)` measured against the padding box, which
          left the highlight a fraction short and drifting further left
          on each successive tab. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: 2,
          bottom: 2,
          left: 2,
          width: `calc((100% - 4px) / ${tabs.length})`,
          background: "var(--tb-a-navy-deep)",
          border: "1px solid var(--tb-a-navy-tint)",
          borderRadius: DOCK_RADIUS_INNER,
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
              padding: "0 14px",
              background: "transparent",
              border: "none",
              borderRadius: DOCK_RADIUS_INNER,
              color: active ? "var(--tb-a-blue-200)" : "var(--tb-n-12)",
              fontFamily: "var(--ui-font)",
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
  pad = "0 10px",
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
        background: active ? "var(--tb-a-navy-deep)" : hover ? "var(--tb-n-3)" : "transparent",
        border: `1px solid ${active ? "var(--tb-a-navy-tint)" : hover ? "var(--tb-n-8)" : "var(--tb-n-3)"}`,
        color: active ? "var(--tb-a-blue-200)" : hover ? "var(--tb-n-16)" : "var(--tb-n-12)",
        // Fixed height + centred content instead of vertical padding, so
        // this lines up exactly with the tab toggle and the stagger
        // button whatever the label is. `pad` now only sets the sides.
        height: DOCK_CTRL_H,
        boxSizing: "border-box",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: pad,
        fontFamily: "var(--ui-font)",
        fontSize: 10,
        lineHeight: 1,
        cursor: "pointer",
        borderRadius: DOCK_RADIUS_INNER,
        transition: "background 80ms, border-color 80ms, color 80ms",
      }}
    >
      {children}
    </button>
  );
}

// Gear chip pinned to the right end of a Parameters panel's header strip:
// a one-click route to the Project Settings view, which otherwise only
// opens from File → Project Settings…. Sized and coloured to match the
// PanelKindMenu chip it shares the strip with; `active` reuses DockButton's
// navy-on-blue treatment so "you are here" reads the same everywhere.
function ProjectSettingsChip({
  active,
  onClick,
}: {
  active: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      title={active ? "Close Project Settings" : "Project Settings"}
      aria-label="Project Settings"
      aria-pressed={active}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        // Pushes the chip to the far right of the header strip.
        marginLeft: "auto",
        width: 19,
        height: 17,
        boxSizing: "border-box",
        flexShrink: 0,
        background: active
          ? "var(--tb-a-navy-deep)"
          : hover
            ? "var(--tb-n-3)"
            : "color-mix(in srgb, var(--tb-n-0) 85%, transparent)",
        border: `1px solid ${
          active
            ? "var(--tb-a-navy-tint)"
            : hover
              ? "var(--tb-n-9)"
              : "var(--tb-n-7)"
        }`,
        borderRadius: 4,
        color: active
          ? "var(--tb-a-blue-200)"
          : hover
            ? "var(--tb-n-16)"
            : "var(--tb-n-13)",
        cursor: "pointer",
        padding: 0,
        transition: "background 80ms, border-color 80ms, color 80ms",
      }}
    >
      <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden>
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth={1.1}
          strokeLinecap="round"
        >
          <circle cx={6} cy={6} r={3.5} />
          <circle cx={6} cy={6} r={1.3} />
          {/* Six teeth at 60° steps, radius 3.5 → 4.9. */}
          <path d="M9.5 6h1.4M2.5 6H1.1M7.75 2.97l.7-1.21M4.25 2.97l-.7-1.21M4.25 9.03l-.7 1.21M7.75 9.03l.7 1.21" />
        </g>
      </svg>
    </button>
  );
}

// Outer batch banner for the Render Queue — sits just above the per-item
// RecordingBanner so the user sees both "Item 2/5" and that item's own
// progress at once.
// {wedge:Name} filename-token sources for batch iteration `v` — each
// reachable wedge's display name paired with its value at that iteration.
function wedgeTokensAt(batch: WedgeBatchInfo, v: number): WedgeTokenSource[] {
  return batch.wedges.map((w) => ({
    name: w.name,
    value: wedgeTokenValue(w.params, v),
  }));
}

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
        color: "var(--tb-n-16)",
        border: "1px solid var(--tb-n-9)",
        borderRadius: 4,
        fontFamily: "var(--ui-font)",
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
        color: "var(--tb-a-red-50)",
        border: "1px solid var(--tb-a-red-500)",
        borderRadius: 4,
        fontFamily: "var(--ui-font)",
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
            background: "var(--tb-a-red-300)",
            boxShadow: "0 0 8px var(--tb-a-red-500)",
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
              background: "var(--tb-a-red-300)",
              transition: "width 80ms linear",
            }}
          />
        </div>
      )}
    </div>
  );
}
