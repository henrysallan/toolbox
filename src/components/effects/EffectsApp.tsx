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
import NodeEditor from "./NodeEditor";
import ParamPanel from "./ParamPanel";
import PaintOverlay from "./PaintOverlay";
import PlaybackBar from "./PlaybackBar";
import MenuBar from "./MenuBar";
import { registerAllNodes } from "@/nodes";
import { getNodeDef } from "@/engine/registry";
import { createEngineBackend, type EngineBackend } from "@/engine/gl";
import {
  evaluateGraph,
  type EvalCache,
  type GraphEdge,
  type GraphNode,
} from "@/engine/evaluator";
import { withMaskInput } from "@/engine/conventions";
import type { NodeDataPayload } from "@/state/graph";
import { parseTargetHandleKind } from "@/state/graph";
import { newNodeId } from "@/state/graph";
import { newLayerId, type MergeLayer } from "@/nodes/effect/merge";
import { useHistory, useUndoShortcuts, type GraphSnapshot } from "@/state/history";
import {
  defaultFilename,
  downloadBlob,
  pickVideoMime,
  sanitizeFilename,
} from "@/lib/export";
import {
  deserializeGraph,
  generateThumbnail,
  incrementName,
  serializeGraph,
} from "@/lib/project";
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
import PublicPrivateConfirm from "./PublicPrivateConfirm";
import NewProjectConfirm from "./NewProjectConfirm";
import {
  clearEditorSession,
  readEditorSession,
  writeEditorSession,
} from "@/state/editor-session";
import type { SaveState } from "./FileNameMenu";
import TransformGizmo from "./TransformGizmo";
import SplineEditorOverlay from "./SplineEditorOverlay";
import PointsOverlay from "./PointsOverlay";
import TimelineCurveEditor from "./TimelineCurveEditor";
import { defaultTimelineCurve } from "@/nodes/source/timeline/eval";
import type { TimelineCurveValue } from "@/engine/types";
import type { Point as PointValue } from "@/engine/types";
import type { SplineParamValue } from "@/nodes/source/spline-draw";

registerAllNodes();

const INITIAL_NODES: Node<NodeDataPayload>[] = [
  makeInstanceNode("image-source", { x: 40, y: 80 }),
  makeInstanceNode("bloom", { x: 340, y: 80 }),
  makeInstanceNode("output", { x: 640, y: 120 }),
];

const INITIAL_EDGES: Edge[] = [
  {
    id: "e1",
    source: INITIAL_NODES[0].id,
    sourceHandle: "out:primary",
    target: INITIAL_NODES[1].id,
    targetHandle: "in:image",
  },
  {
    id: "e2",
    source: INITIAL_NODES[1].id,
    sourceHandle: "out:primary",
    target: INITIAL_NODES[2].id,
    targetHandle: "in:image",
  },
];

function makeInstanceNode(
  type: string,
  position: { x: number; y: number }
): Node<NodeDataPayload> {
  const def = getNodeDef(type);
  if (!def) throw new Error(`Unknown node type ${type}`);
  const params: Record<string, unknown> = {};
  for (const p of def.params) params[p.name] = p.default;
  const resolved = withMaskInput(def.resolveInputs?.(params) ?? def.inputs);
  return {
    id: newNodeId(type),
    type: "effect",
    position,
    data: {
      defType: type,
      params,
      exposedParams: [],
      name: def.name,
      inputs: resolved.map((i) => ({
        name: i.name,
        label: i.label,
        type: i.type,
      })),
      auxOutputs: (def.resolveAuxOutputs?.(params) ?? def.auxOutputs).map(
        (a) => ({
          name: a.name,
          type: a.type,
          disabled: a.disabled,
        })
      ),
      primaryOutput:
        def.resolvePrimaryOutput?.(params) ?? def.primaryOutput,
      terminal: def.terminal,
      active: !!def.terminal,
      bypassed: false,
    },
  };
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

export default function EffectsApp() {
  return (
    <AuthProvider>
      <ReactFlowProvider>
        <EffectsShell />
      </ReactFlowProvider>
    </AuthProvider>
  );
}

function EffectsShell() {
  // Rehydrate from the session stash if the user is returning from
  // a route change (e.g. /docs → back to /). Read once; if present,
  // seed every piece of React state below from the same snapshot so
  // they're all internally consistent on first paint.
  const rehydrate = readEditorSession();
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
  // Controls which panel the right-side parameters section is showing.
  // Selecting a node switches it to "node"; Project Settings flips it to
  // "project"; File → Load flips it to "load" (grid of saved projects).
  const [paramView, setParamView] = useState<"project" | "node" | "load">(
    rehydrate?.paramView ?? "node"
  );
  // Full-canvas mode: canvas fills the viewport, all other UI chrome
  // is hidden. Toggled via the F shortcut or the Window menu's "Full
  // Canvas" item. Esc exits.
  const [fullCanvas, setFullCanvas] = useState(false);
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
  // When set, plain "Save" silently overwrites this row; cleared only by
  // switching to a different project (Load or Save As creating a new row).
  const [currentProject, setCurrentProject] = useState<
    | {
        id: string;
        name: string;
        isPublic: boolean;
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
  >(rehydrate?.currentProject ?? null);
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
  useEffect(() => {
    let rafId: number | null = null;
    const scheduleBump = () => {
      if (rafId != null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
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
      cursorRef.current = { x, y, active: inside };
      scheduleBump();
    };
    const onLeave = () => {
      cursorRef.current = { ...cursorRef.current, active: false };
      scheduleBump();
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
  // During scrubbing the RAF advancer is suspended so the drag can set time
  // directly without a running playback stepping on the mouse. `playing`
  // itself isn't touched, so clearing `scrubbing` restores the prior state —
  // a timeline that was paused before the drag stays paused.
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
      const backend = createEngineBackend(canvasRes[0], canvasRes[1]);
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
  }, [canvasRes]);

  const startVResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = rightColWidth;
    const onMove = (ev: MouseEvent) => {
      const dx = startX - ev.clientX;
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
  }, [rightColWidth]);

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
        params: n.data.params,
        exposedParams: n.data.exposedParams,
        bypassed: !!n.data.bypassed,
      }));
      const activeNodeId =
        currentNodes.find((n) => n.data.active)?.id ?? null;
      const activeNodeId2 =
        currentNodes.find((n) => n.data.active2)?.id ?? null;
      const graphEdges: GraphEdge[] = currentEdges.map((e) => ({
        id: e.id,
        source: e.source,
        sourceHandle: e.sourceHandle ?? "out:primary",
        target: e.target,
        targetHandle: e.targetHandle ?? "in:image",
      }));

      const ctx = backend.makeContext(
        renderTime,
        Math.floor(renderTime * renderFps),
        cursorRef.current,
        playingHint
      );
      const result = evaluateGraph(
        graphNodes,
        graphEdges,
        ctx,
        evalCacheRef.current,
        activeNodeId
      );
      setErrors(result.errors);

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
          activeNodeId2
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
  ]);

  // Capture the selected node's points output after each pipeline run so
  // PointsOverlay has fresh dots to draw. Reads the evaluator cache
  // directly — it holds the most recent NodeOutput per node regardless
  // of whether the eval effect ran on the same tick as the selection
  // change. Dep list tracks both selection and pipeline invalidation.
  useEffect(() => {
    if (!selectedId) {
      setSelectedPoints(null);
      return;
    }
    const entry = evalCacheRef.current.get(selectedId);
    const primary = entry?.output.primary;
    if (primary && primary.kind === "points") {
      setSelectedPoints(primary.points);
    } else {
      setSelectedPoints(null);
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
                  ? withMaskInput(resolved).map((i) => ({
                      name: i.name,
                      label: i.label,
                      type: i.type,
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
                  ? withMaskInput(resolved).map((i) => ({
                      name: i.name,
                      label: i.label,
                      type: i.type,
                    }))
                  : n.data.inputs,
              },
            };
          })
        );
      }

      setEdges((eds) => {
        const filtered = eds.filter(
          (e) =>
            !(
              e.target === connection.target &&
              e.targetHandle === connection.targetHandle
            )
        );
        return addEdge(connection, filtered);
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
          paramValue = await createImageBitmap(file);
        } else if (kind === "svg") {
          nodeType = "svg-source";
          const mod = await import("@/lib/svg-parse");
          const text = await file.text();
          paramValue = mod.parseSvg(text, file.name);
        } else if (kind === "video") {
          nodeType = "video-source";
          const mod = await import("@/lib/video");
          paramValue = await mod.registerVideoFile(file);
        } else {
          nodeType = "audio-source";
          const mod = await import("@/lib/audio");
          paramValue = await mod.registerAudioFile(file);
        }
      } catch (err) {
        // Bad SVG text, corrupt video metadata, etc. Surface without
        // crashing the editor — user can retry with a different file.
        // eslint-disable-next-line no-console
        console.warn(`Failed to load dropped ${kind}:`, err);
        return;
      }

      pushGraph(getGraphSnapshot());
      const newNode = makeInstanceNode(nodeType, flowPos);
      newNode.data.params = { ...newNode.data.params, file: paramValue };
      setNodes((prev) => [...prev, newNode]);
    },
    [pushGraph, getGraphSnapshot, setNodes]
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

      // Compound: "simulation-zone" creates a Start + End pair with a
      // shared zone_id. Start lands at `pos`; End is offset to the right
      // so the pair is pre-arranged. They're NOT pre-wired to each other
      // — the user wires the compute between them. Auto-wire from a
      // dropped source wire doesn't apply to compound nodes — skip.
      if (type === "simulation-zone") {
        const zoneId = `zone-${Math.random().toString(36).slice(2, 10)}`;
        const start = makeInstanceNode("simulation-start", pos);
        const end = makeInstanceNode("simulation-end", {
          x: pos.x + 380,
          y: pos.y,
        });
        start.data.params = { ...start.data.params, zone_id: zoneId };
        end.data.params = { ...end.data.params, zone_id: zoneId };
        setNodes((prev) => [...prev, start, end]);
        return;
      }

      const newNode = makeInstanceNode(type, pos);

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
              srcType === "image"
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
            def.resolveInputs?.(newNode.data.params) ?? def.inputs
          );
          newNode.data.inputs = resolvedInputs.map((i) => ({
            name: i.name,
            label: i.label,
            type: i.type,
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
                srcType === "spline" ||
                srcType === "points")
            ) {
              targetInput = "instance";
            }
          }

          if (targetInput) {
            autoEdge = {
              id: `e-auto-${pendingWire.sourceNodeId}-${newNode.id}-${targetInput}`,
              source: pendingWire.sourceNodeId,
              sourceHandle: pendingWire.sourceHandle,
              target: newNode.id,
              targetHandle: `in:${targetInput}`,
            };
          }
        }
      }

      setNodes((prev) => [...prev, newNode]);
      if (autoEdge) {
        setEdges((prev) => [...prev, autoEdge as Edge]);
      }
    },
    [setNodes, setEdges, pushGraph, getGraphSnapshot]
  );

  // Shallow-clone a node with a fresh id + position. Params share references
  // (so fonts, bitmaps, paint canvases are reused rather than deep-copied) —
  // intentional for v1: deep-cloning a paint canvas or video element would
  // be a bigger project and isn't what most users expect from duplicate.
  const cloneNode = useCallback(
    (
      n: Node<NodeDataPayload>,
      position: { x: number; y: number }
    ): Node<NodeDataPayload> => {
      const newId = newNodeId(n.data.defType);
      return {
        ...n,
        id: newId,
        position,
        selected: false,
        data: {
          ...n.data,
          params: { ...n.data.params },
          exposedParams: n.data.exposedParams
            ? [...n.data.exposedParams]
            : [],
        },
      };
    },
    []
  );

  const handleCopyNodes = useCallback(() => {
    const selected = nodesRef.current.filter((n) => n.selected);
    if (selected.length === 0) return;
    const ids = new Set(selected.map((n) => n.id));
    const internalEdges = edgesRef.current.filter(
      (e) => ids.has(e.source) && ids.has(e.target)
    );
    clipboardRef.current = {
      nodes: selected.map((n) => ({ ...n, selected: false })),
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
    const idMap = new Map<string, string>();
    const newNodes = clip.nodes.map((n) => {
      const cloned = cloneNode(n, {
        x: n.position.x + offset.x,
        y: n.position.y + offset.y,
      });
      idMap.set(n.id, cloned.id);
      cloned.selected = true;
      return cloned;
    });
    const newEdges = clip.edges.map((e) => ({
      ...e,
      id: `e-${Math.random().toString(36).slice(2, 10)}`,
      source: idMap.get(e.source) ?? e.source,
      target: idMap.get(e.target) ?? e.target,
    }));
    setNodes((prev) => [
      ...prev.map((n) => ({ ...n, selected: false })),
      ...newNodes,
    ]);
    setEdges((prev) => [...prev, ...newEdges]);
  }, [pushGraph, getGraphSnapshot, cloneNode, setNodes, setEdges]);

  // Context-menu / standalone Duplicate: clone the source node at a small
  // offset so it's visibly distinct. No edge surgery — the clone starts
  // disconnected and the user wires it up themselves.
  const handleDuplicateNode = useCallback(
    (nodeId: string) => {
      const src = nodesRef.current.find((n) => n.id === nodeId);
      if (!src) return;
      pushGraph(getGraphSnapshot());
      const clone = cloneNode(src, {
        x: src.position.x + 32,
        y: src.position.y + 32,
      });
      clone.selected = true;
      setNodes((prev) => [
        ...prev.map((n) => ({ ...n, selected: false })),
        clone,
      ]);
    },
    [pushGraph, getGraphSnapshot, cloneNode, setNodes]
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
      const clone = cloneNode(src, {
        x: src.position.x,
        y: src.position.y,
      });
      setNodes((prev) => [...prev, clone]);
      setEdges((prev) =>
        prev.map((e) => ({
          ...e,
          source: e.source === nodeId ? clone.id : e.source,
          target: e.target === nodeId ? clone.id : e.target,
        }))
      );
    },
    [pushGraph, getGraphSnapshot, cloneNode, setNodes, setEdges]
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
            def.resolveInputs?.(nextParams) ?? def.inputs
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
    (nodeId: string, paramName: string, value: unknown) => {
      // Coalesce rapid same-param changes (slider drags, color-ramp moves,
      // curve point drags) into a single undo entry keyed by node+param.
      // Paint param updates are internal-only — pipeline snapshots and undo
      // restores trigger them — and are excluded to keep those flows linear.
      if (paramName !== "paint") {
        pushGraph(getGraphSnapshot(), `param:${nodeId}:${paramName}`);
      }
      setNodes((prev) =>
        prev.map((n) => {
          if (n.id !== nodeId) return n;
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
            }
          }
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
                ? withMaskInput(resolved).map((i) => ({
                    name: i.name,
                    label: i.label,
                    type: i.type,
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
                  ? withMaskInput(resolved).map((i) => ({
                      name: i.name,
                      label: i.label,
                      type: i.type,
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
      onNodesChange(changes);
    },
    [onNodesChange, pushGraph, getGraphSnapshot]
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

  const getOutputParams = useCallback((nodeId: string) => {
    const node = nodesRef.current.find((n) => n.id === nodeId);
    return node?.data.defType === "output" ? node.data.params : null;
  }, []);

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
    async (nodeId: string) => {
      if (recordingRef.current) return;
      const canvas = canvasRef.current;
      const params = getOutputParams(nodeId);
      if (!canvas || !params) return;

      const quality =
        (params.videoQuality as "fast" | "high" | "max") ?? "high";
      const container =
        (params.videoFormat as "mp4" | "webm" | "mov" | "mkv") ?? "mp4";
      const durationFrames = (params.videoFrames as number) ?? 240;
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
        const picked = pickVideoMime(liveContainer);
        if (!picked) {
          console.error("No supported video codec in this browser");
          return;
        }
        const totalSec = durationFrames / previewFps;
        const stream = canvas.captureStream(previewFps);
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

        setTime(0);
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
        setPlaying(savedPlaying);
        setTime(savedTime);
        setRecording(null);

        const blob = await done;
        downloadBlob(
          blob,
          base ? `${base}.${picked.ext}` : defaultFilename(picked.ext)
        );
        return;
      }

      // ---- Offline path (WebCodecs or ffmpeg.wasm) ------------------------
      // Both rely on `renderFrameRef.current(t, fps, true)` to step the
      // pipeline synchronously. We pass `playing: true` so animation
      // nodes that gate on it (audio sources, particle systems, etc.)
      // still advance during the export render.
      setPlaying(false);
      setRecording({ mode: "offline", label: "Preparing…", progress: 0 });

      const renderAt = (_frameIndex: number, t: number) => {
        // Update the visible timeline so the preview stays in sync with
        // what the encoder is reading. setTime is async, so we also
        // call renderFrame imperatively to guarantee the canvas matches
        // the timestamp we hand to the encoder.
        setTime(t);
        renderFrameRef.current?.(t, exportFps, true);
      };

      try {
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
            renderFrame: renderAt,
            onProgress: (label, frac) =>
              setRecording({
                mode: "offline",
                label,
                progress: frac,
              }),
          });
        } else {
          const { exportVideoFfmpeg } = await import("@/lib/export-ffmpeg");
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
          // ProRes is only compatible with mov/mkv; nudge the user.
          const ffContainer =
            (codec === "prores" && container === "mp4")
              ? "mov"
              : (codec === "prores" && container === "webm")
                ? "mov"
                : container;
          result = await exportVideoFfmpeg({
            canvas,
            container: ffContainer,
            codec,
            crf: (params.videoCrf as number) ?? 18,
            proresProfile: proresMap[proresName] ?? 3,
            fps: exportFps,
            durationFrames,
            renderFrame: renderAt,
            onProgress: (label, frac) =>
              setRecording({ mode: "offline", label, progress: frac }),
          });
        }

        downloadBlob(
          result.blob,
          base ? `${base}.${result.ext}` : defaultFilename(result.ext)
        );
      } catch (err) {
        console.error("Video export failed:", err);
        const msg = err instanceof Error ? err.message : "Export failed";
        flashToast(msg);
      } finally {
        setPlaying(savedPlaying);
        setTime(savedTime);
        setRecording(null);
      }
    },
    [getOutputParams, flashToast]
  );

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (
        e as CustomEvent<{ id: string; kind: "image" | "video" }>
      ).detail;
      if (!detail) return;
      if (detail.kind === "image") exportImage(detail.id);
      else if (detail.kind === "video") exportVideo(detail.id);
    };
    window.addEventListener("effect-node-export", handler);
    return () => window.removeEventListener("effect-node-export", handler);
  }, [exportImage, exportVideo]);

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
        })
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
          ownerId: user.id,
          authorName: null,
        });
        setSaveState("saved");
        setLoadRefreshKey((n) => n + 1);
        flashToast("saved a copy");
        return "saved";
      } catch {
        setSaveState("error");
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
    } catch {
      setSaveState("error");
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
        const { nodes: nextNodes, edges: nextEdges } = await deserializeGraph(
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
        setSelectedId(null);
        setParamView("node");
        setCurrentProject({
          id,
          name: saved.name,
          isPublic: saved.is_public,
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
    [pushGraph, getGraphSnapshot, setNodes, setEdges, user]
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
    const ok = await setProjectVisibilityRow(currentProject.id, next);
    if (!ok) {
      setSaveState("error");
      flashToast("visibility update failed");
      setPendingVisibility(null);
      return;
    }
    setCurrentProject({ ...currentProject, isPublic: next });
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
    // INITIAL_NODES directly since its node IDs were frozen at import
    // time; calling makeInstanceNode fresh here gives us unique IDs.
    const imageSrc = makeInstanceNode("image-source", { x: 40, y: 80 });
    const bloom = makeInstanceNode("bloom", { x: 340, y: 80 });
    const output = makeInstanceNode("output", { x: 640, y: 120 });
    const freshNodes: Node<NodeDataPayload>[] = [imageSrc, bloom, output];
    const freshEdges: Edge[] = [
      {
        id: `e-${imageSrc.id}-${bloom.id}`,
        source: imageSrc.id,
        sourceHandle: "out:primary",
        target: bloom.id,
        targetHandle: "in:image",
      },
      {
        id: `e-${bloom.id}-${output.id}`,
        source: bloom.id,
        sourceHandle: "out:primary",
        target: output.id,
        targetHandle: "in:image",
      },
    ];
    // Suppress the echo-selection-change paramView flip, same rule
    // as File → Load / Project Settings.
    suppressNextSelectionViewFlipRef.current = true;
    setNodes(freshNodes);
    setEdges(freshEdges);
    setSelectedId(null);
    setParamView("node");
    setCurrentProject(null);
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
      return edges.some((e) => {
        if (e.target !== nodeId) return false;
        const parsed = parseTargetHandleKind(e.targetHandle ?? "");
        return parsed?.kind === "param" && parsed.name === paramName;
      });
    },
    [edges]
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

  // Show the pivot gizmo for any selected node whose definition opts in via
  // `supportsTransformGizmo` and exposes the expected param names. Today
  // that's Transform and Text, but new nodes can participate by flipping
  // the flag without any changes here.
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

  // Curve editor overlay docks at the bottom of the canvas region. A small
  // tab at the bottom-center toggles it open. The editor only edits a node
  // when a Timeline node is selected; otherwise the tab is shown but
  // clicking it surfaces a hint (or just opens an empty editor — keep
  // simple and only show the tab when a Timeline node is selected).
  const activeTimelineNode = selectedId
    ? nodes.find(
        (n) => n.id === selectedId && n.data.defType === "timeline"
      )
    : undefined;
  const [timelineEditorOpen, setTimelineEditorOpen] = useState(false);
  const [timelineEditorHeight, setTimelineEditorHeight] = useState(280);
  // Read the most recent wrapped-t the evaluator stashed for the selected
  // Timeline node. Re-read on every frame tick so the playhead glides.
  const [timelinePlayheadT, setTimelinePlayheadT] = useState<number | null>(
    null
  );
  useEffect(() => {
    if (!activeTimelineNode || !timelineEditorOpen) {
      setTimelinePlayheadT(null);
      return;
    }
    const id = activeTimelineNode.id;
    const backend = backendRef.current;
    if (!backend) return;
    const v = backend.state[`timeline:${id}:t`];
    setTimelinePlayheadT(typeof v === "number" ? v : null);
  }, [activeTimelineNode, timelineEditorOpen, time, pipelineBumpKey]);

  // Preview dots for any selected node whose primary output is a points
  // value. Populated by the pipeline-eval effect after each render pass.
  const [selectedPoints, setSelectedPoints] = useState<PointValue[] | null>(
    null
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        width: "100%",
        background: "#000",
        color: "#e5e7eb",
        fontFamily: "ui-monospace, monospace",
        fontSize: 12,
      }}
    >
      <div style={{ display: fullCanvas ? "none" : "contents" }}>
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
        projectName={currentProject?.name ?? "Untitled"}
        projectId={currentProject?.id ?? null}
        saveState={saveState}
        isPublic={currentProject?.isPublic ?? false}
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
        fullCanvas={fullCanvas}
        onToggleFullCanvas={() => setFullCanvas((v) => !v)}
        onEnterBrowserFullscreen={enterBrowserFullscreen}
        showFps={showFps}
        onToggleShowFps={() => setShowFps((v) => !v)}
        showNodeTimings={showNodeTimings}
        onToggleShowNodeTimings={() => setShowNodeTimings((v) => !v)}
        viewportSplit={viewportSplit}
        onToggleViewportSplit={() => setViewportSplit((v) => !v)}
      />
      </div>
      <div
        style={{
          display: "flex",
          flex: 1,
          minHeight: 0,
          width: "100%",
        }}
      >
      <section
        style={{
          flex: 1,
          minWidth: 0,
          position: "relative",
          display: "flex",
          flexDirection: "column",
        }}
      >
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
            }}
          >
            <canvas
              ref={canvasRef}
              width={canvasRes[0]}
              height={canvasRes[1]}
              style={{
                maxWidth: "100%",
                maxHeight: "100%",
                background:
                  "repeating-conic-gradient(#1a1a1a 0% 25%, #0f0f0f 0% 50%) 0 0 / 24px 24px",
                border: "1px solid #27272a",
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
                overflow: "hidden",
              }}
            >
              <canvas
                ref={canvas2Ref}
                width={canvasRes[0]}
                height={canvasRes[1]}
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
          {selectedPoints && selectedPoints.length > 0 && backendReady && (
            <PointsOverlay
              canvas={canvasRef.current}
              points={selectedPoints}
            />
          )}
          {activeSplineNode && backendReady && (
            <SplineEditorOverlay
              canvas={canvasRef.current}
              value={
                (activeSplineNode.data.params.spline as SplineParamValue) ?? {
                  subpaths: [{ anchors: [], closed: false }],
                }
              }
              onChange={(next) =>
                onParamChange(activeSplineNode.id, "spline", next)
              }
            />
          )}
          {activeTransformNode && backendReady && (
            <TransformGizmo
              canvas={canvasRef.current}
              pivotX={(activeTransformNode.data.params.pivotX as number) ?? 0.5}
              pivotY={(activeTransformNode.data.params.pivotY as number) ?? 0.5}
              translateX={
                (activeTransformNode.data.params.translateX as number) ?? 0
              }
              translateY={
                (activeTransformNode.data.params.translateY as number) ?? 0
              }
              scaleX={
                (activeTransformNode.data.params.scaleX as number) ?? 1
              }
              scaleY={
                (activeTransformNode.data.params.scaleY as number) ?? 1
              }
              rotate={
                (activeTransformNode.data.params.rotate as number) ?? 0
              }
              onChange={(patch) => {
                const id = activeTransformNode.id;
                for (const [k, v] of Object.entries(patch)) {
                  if (typeof v === "number")
                    onParamChange(id, k, v);
                }
              }}
            />
          )}
          {/* Curve editor dock — anchored to the bottom edge of the canvas
              area. A small tab pokes up from the bottom-center to toggle
              visibility. The tab only appears when a Timeline node is the
              current selection; selecting a different node hides it. */}
          {activeTimelineNode && !timelineEditorOpen && (
            <button
              onClick={() => setTimelineEditorOpen(true)}
              title="Open curve editor"
              style={{
                position: "absolute",
                bottom: 0,
                left: "50%",
                transform: "translateX(-50%)",
                background: "#18181b",
                color: "#a1a1aa",
                border: "1px solid #3f3f46",
                borderBottom: "none",
                borderTopLeftRadius: 6,
                borderTopRightRadius: 6,
                padding: "3px 14px",
                fontFamily: "ui-monospace, monospace",
                fontSize: 10,
                cursor: "pointer",
                zIndex: 5,
              }}
            >
              ▲ curve
            </button>
          )}
          {activeTimelineNode && timelineEditorOpen && (
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                height: timelineEditorHeight,
                background: "#0a0a0a",
                borderTop: "1px solid #3f3f46",
                display: "flex",
                flexDirection: "column",
                zIndex: 5,
              }}
            >
              <Divider
                orientation="horizontal"
                onMouseDown={(e) => {
                  e.preventDefault();
                  const startY = e.clientY;
                  const startH = timelineEditorHeight;
                  const onMove = (ev: MouseEvent) => {
                    const dy = startY - ev.clientY;
                    setTimelineEditorHeight(
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
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "2px 8px",
                  background: "#111114",
                  borderBottom: "1px solid #27272a",
                  flexShrink: 0,
                }}
              >
                <span
                  style={{
                    color: "#a1a1aa",
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 10,
                  }}
                >
                  Curve · {activeTimelineNode.data.name}
                </span>
                <button
                  onClick={() => setTimelineEditorOpen(false)}
                  title="Close curve editor"
                  style={{
                    background: "transparent",
                    border: "1px solid #3f3f46",
                    color: "#a1a1aa",
                    padding: "1px 8px",
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 10,
                    cursor: "pointer",
                    borderRadius: 3,
                  }}
                >
                  ▼
                </button>
              </div>
              <div style={{ flex: 1, minHeight: 0 }}>
                <TimelineCurveEditor
                  value={
                    (activeTimelineNode.data.params.curve as TimelineCurveValue) ??
                    defaultTimelineCurve()
                  }
                  onChange={(next) =>
                    onParamChange(activeTimelineNode.id, "curve", next)
                  }
                  playheadT={timelinePlayheadT}
                  height={timelineEditorHeight - 30}
                  onScrub={(t) => {
                    // Map normalized 0..1 onto scene seconds. The
                    // Timeline node wraps via fract, so the scene
                    // duration we should map to is the loop window
                    // when set, otherwise one second.
                    const loopSec =
                      loopFrames != null && loopFrames > 0
                        ? loopFrames / fps
                        : 1;
                    onSeek(t * loopSec);
                  }}
                />
              </div>
            </div>
          )}
          {recording && <RecordingBanner state={recording} />}
          {progressStatus && <ProgressBanner status={progressStatus} />}
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
        <section
          style={{
            flex: 1,
            minHeight: 0,
            background: "#0a0a0a",
          }}
        >
          <NodeEditor
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChangeWithHistory}
            onEdgesChange={onEdgesChangeWithHistory}
            onConnect={onConnect}
            onSelectNode={(id) => {
              // One-shot echo suppression: if we just programmatically
              // deselected via a menu handler, ignore the stale
              // selection-change that React Flow fires right after.
              if (suppressNextSelectionViewFlipRef.current) {
                suppressNextSelectionViewFlipRef.current = false;
                return;
              }
              setSelectedId(id);
              // Clicking a node flips the right panel back to node params —
              // a deselection alone shouldn't disturb the project-settings view.
              if (id) setParamView("node");
            }}
            onAddNode={onAddNode}
            onPanePointer={(p) => {
              lastPanePointerRef.current = p;
            }}
            onDuplicateOnDrag={handleDuplicateOnDrag}
            onDetachNode={handleDetachNode}
            onDuplicateNode={handleDuplicateNode}
            onCopyNodes={handleCopyNodes}
            onPasteNodes={handlePasteNodes}
            onAddFileNode={onAddFileNode}
            onCombineWires={handleCombineWires}
            onCutWires={handleCutWires}
            onSpliceNode={handleSpliceNode}
            onWaypointDragStart={handleWaypointDragStart}
            onWaypointDrag={handleWaypointDrag}
          />
        </section>

        <Divider orientation="horizontal" onMouseDown={startHResize} />

        <section style={{ height: bottomRowHeight, minHeight: 0, flexShrink: 0 }}>
          <ParamPanel
            nodes={nodes}
            selectedId={selectedId}
            mode={paramView}
            canvasRes={canvasRes}
            onCanvasResChange={setCanvasRes}
            onParamChange={onParamChange}
            onToggleParamExposed={onToggleParamExposed}
            onParamRangeChange={onParamRangeChange}
            onToggleParamLink={onToggleParamLink}
            isParamDriven={isParamDriven}
            signedIn={signedIn}
            currentUserId={user?.id ?? null}
            onLoadProject={handleLoadProject}
            loadRefreshKey={loadRefreshKey}
          />
        </section>
      </div>
      </div>
      {!fullCanvas && (
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
          onFpsChange={setFps}
          onLoopFramesChange={setLoopFrames}
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
      const isZoom = e.metaKey || e.ctrlKey;
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
      const startX = e.clientX;
      const startY = e.clientY;
      let curPan: [number, number] = [0, 0];
      setPan((p) => {
        curPan = p;
        return p;
      });
      const onMove = (ev: PointerEvent) => {
        setPan([
          curPan[0] + (ev.clientX - startX),
          curPan[1] + (ev.clientY - startY),
        ]);
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
  }, [viewportRef, setPan]);
}

// Splitter handle. Renders a thin 1px visual line but keeps a wider
// (default 5px) hit-target so it's easy to grab. The visible line
// stays centered inside the hit zone via flex.
function Divider({
  orientation,
  hit = 5,
  thickness = 1,
  color = "#27272a",
  hidden = false,
  onPointerDown,
  onMouseDown,
}: {
  orientation: "horizontal" | "vertical";
  hit?: number;
  thickness?: number;
  color?: string;
  hidden?: boolean;
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onMouseDown?: (e: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const isH = orientation === "horizontal";
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
        height: isH ? hit : "auto",
        width: isH ? "auto" : hit,
        alignSelf: "stretch",
        background: "transparent",
      }}
    >
      <div
        style={{
          background: color,
          height: isH ? thickness : "100%",
          width: isH ? "100%" : thickness,
        }}
      />
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
