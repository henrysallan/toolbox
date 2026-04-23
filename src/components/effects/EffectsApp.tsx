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
import Timeline from "./Timeline";
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
  loadProject as loadProjectRow,
  saveProject as saveProjectRow,
  updateProject as updateProjectRow,
} from "@/lib/supabase/projects";
import { AuthProvider, useUser } from "@/lib/auth-context";
import SaveModal from "./SaveModal";
import TransformGizmo from "./TransformGizmo";
import SplineEditorOverlay from "./SplineEditorOverlay";
import PointsOverlay from "./PointsOverlay";
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
  const [nodes, setNodes, onNodesChange] =
    useNodesState<Node<NodeDataPayload>>(INITIAL_NODES);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(INITIAL_EDGES);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [canvasRes, setCanvasRes] = useState<[number, number]>([1024, 1024]);
  // Controls which panel the right-side parameters section is showing.
  // Selecting a node switches it to "node"; Project Settings flips it to
  // "project"; File → Load flips it to "load" (grid of saved projects).
  const [paramView, setParamView] = useState<"project" | "node" | "load">(
    "node"
  );
  // Bumped after every save so the load grid refetches on next view.
  const [loadRefreshKey, setLoadRefreshKey] = useState(0);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  // When set, plain "Save" silently overwrites this row; cleared only by
  // switching to a different project (Load or Save As creating a new row).
  const [currentProject, setCurrentProject] = useState<
    { id: string; name: string } | null
  >(null);
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
  const [backendReady, setBackendReady] = useState(false);
  // Incremented when a source (currently: async font load) needs the
  // pipeline to re-evaluate while nothing else has changed.
  const [pipelineBumpKey, setPipelineBumpKey] = useState(0);
  useEffect(() => {
    const onBump = () => setPipelineBumpKey((n) => n + 1);
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

  const { pushGraph, pushPaint, undo, redo, canUndo, canRedo } = useHistory({
    getGraphSnapshot,
    applyGraphSnapshot,
    onPaintRestore,
  });
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
          n.data.bypassed ? 1 : 0
        }:${fp(n.data.params)}:X=${expo}`
      );
    }
    for (const e of edges) {
      parts.push(
        `E:${e.source}|${e.sourceHandle}|${e.target}|${e.targetHandle}`
      );
    }
    return parts.sort().join(";");
  }, [nodes, edges]);

  useEffect(() => {
    const backend = backendRef.current;
    const canvas = canvasRef.current;
    if (!backend || !backendReady || !canvas) return;

    const graphNodes: GraphNode[] = nodes.map((n) => ({
      id: n.id,
      type: n.data.defType,
      params: n.data.params,
      exposedParams: n.data.exposedParams,
      bypassed: !!n.data.bypassed,
    }));
    const activeNodeId = nodes.find((n) => n.data.active)?.id ?? null;
    const graphEdges: GraphEdge[] = edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle ?? "out:primary",
      target: e.target,
      targetHandle: e.targetHandle ?? "in:image",
    }));

    const ctx = backend.makeContext(
      time,
      Math.floor(time * fps),
      cursorRef.current,
      playing && !scrubbing
    );
    const result = evaluateGraph(
      graphNodes,
      graphEdges,
      ctx,
      evalCacheRef.current,
      activeNodeId
    );
    setErrors(result.errors);

    if (result.terminalImage && result.terminalImage.image.kind === "image") {
      ctx.blitToCanvas(result.terminalImage.image, canvas);
    } else {
      const c2d = canvas.getContext("2d");
      if (c2d) {
        c2d.fillStyle = "#111";
        c2d.fillRect(0, 0, canvas.width, canvas.height);
        c2d.fillStyle = "#52525b";
        c2d.font = "14px ui-monospace, monospace";
        c2d.fillText(
          "Connect an Output node to preview.",
          20,
          canvas.height / 2
        );
      }
    }
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

  const [recording, setRecording] = useState<{
    totalSec: number;
    startedAt: number;
  } | null>(null);
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

      const requested = (params.videoFormat as "mp4" | "webm") ?? "mp4";
      const picked = pickVideoMime(requested);
      if (!picked) {
        console.error("No supported video codec in this browser");
        return;
      }
      const durationFrames = (params.videoFrames as number) ?? 240;
      const bitrateMbps = (params.videoBitrateMbps as number) ?? 8;
      const base = sanitizeFilename((params.filename as string) ?? "");
      const currentFps = fpsRef.current;
      const totalSec = durationFrames / currentFps;

      const stream = canvas.captureStream(currentFps);
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

      const savedTime = timeRef.current;
      const savedPlaying = playingRef.current;

      // Rewind and let the pipeline render t=0 before we start recording so
      // the first captured frame isn't whatever was on screen a moment ago.
      setTime(0);
      await new Promise<void>((r) => {
        requestAnimationFrame(() => requestAnimationFrame(() => r()));
      });

      setPlaying(true);
      recorder.start();
      setRecording({ totalSec, startedAt: performance.now() });

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
    },
    [getOutputParams]
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

  // Modal callback: always creates a NEW row. After success the new row
  // becomes the "current project" so plain Save overwrites it next time.
  const handleSaveAsProject = useCallback(
    async (name: string) => {
      if (!signedIn) throw new Error("Sign in to save projects.");
      try {
        const result = await saveToRow(name, "insert");
        if (!result)
          throw new Error("Save failed — check RLS policy / network.");
        setCurrentProject({ id: result.id, name });
        setLoadRefreshKey((n) => n + 1);
        flashToast(`saved as ${name}`);
      } finally {
        setProgressStatus(null);
      }
    },
    // saveToRow closes over refs, flashToast, and setters — all stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signedIn, flashToast]
  );

  // Silent overwrite if we're already on a row; otherwise this is effectively
  // Save As and opens the name modal.
  const handleSave = useCallback(async () => {
    if (!signedIn) return;
    if (!currentProject) {
      setSaveModalOpen(true);
      return;
    }
    try {
      const result = await saveToRow(
        currentProject.name,
        "update",
        currentProject.id
      );
      if (result) {
        flashToast("saved");
        setLoadRefreshKey((n) => n + 1);
      } else {
        flashToast("save failed");
      }
    } finally {
      setProgressStatus(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, currentProject, flashToast]);

  // New row, name derived from the current one by incrementing any trailing
  // digits (foo → foo_01, foo_01 → foo_02, foo_99 → foo_100). Becomes the
  // new current project.
  const handleSaveIncremental = useCallback(async () => {
    if (!signedIn || !currentProject) return;
    const newName = incrementName(currentProject.name);
    try {
      const result = await saveToRow(newName, "insert");
      if (!result) {
        flashToast("save failed");
        return;
      }
      setCurrentProject({ id: result.id, name: newName });
      setLoadRefreshKey((n) => n + 1);
      flashToast(`saved as ${newName}`);
    } finally {
      setProgressStatus(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, currentProject, flashToast]);

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
        setCurrentProject({ id, name: saved.name });
        setProgressStatus({ label: "loading", progress: 1, tone: "load" });
      } finally {
        setProgressStatus(null);
      }
    },
    [pushGraph, getGraphSnapshot, setNodes, setEdges]
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
          setSelectedId(null);
          setNodes((prev) =>
            prev.map((n) => (n.selected ? { ...n, selected: false } : n))
          );
          setParamView("project");
        }}
        onSave={handleSave}
        onSaveAs={() => setSaveModalOpen(true)}
        onSaveIncremental={handleSaveIncremental}
        canSaveIncremental={signedIn && !!currentProject}
        onOpenLoad={() => {
          setSelectedId(null);
          setNodes((prev) =>
            prev.map((n) => (n.selected ? { ...n, selected: false } : n))
          );
          setParamView("load");
        }}
      />
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
            justifyContent: "center",
            alignItems: "center",
            background: "#050505",
            padding: 12,
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
            }}
          />
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

      <div
        onMouseDown={startVResize}
        style={{
          width: 5,
          cursor: "col-resize",
          background: "#27272a",
          flexShrink: 0,
        }}
      />

      <div
        style={{
          width: rightColWidth,
          flexShrink: 0,
          display: "flex",
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

        <div
          onMouseDown={startHResize}
          style={{
            height: 5,
            cursor: "row-resize",
            background: "#27272a",
            flexShrink: 0,
          }}
        />

        <section style={{ height: bottomRowHeight, minHeight: 0, flexShrink: 0 }}>
          <ParamPanel
            nodes={nodes}
            selectedId={selectedId}
            mode={paramView}
            canvasRes={canvasRes}
            onCanvasResChange={setCanvasRes}
            onParamChange={onParamChange}
            onToggleParamExposed={onToggleParamExposed}
            isParamDriven={isParamDriven}
            signedIn={signedIn}
            onLoadProject={handleLoadProject}
            loadRefreshKey={loadRefreshKey}
          />
        </section>
      </div>
      </div>
      <Timeline
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
      <SaveModal
        open={saveModalOpen}
        onClose={() => setSaveModalOpen(false)}
        onSave={handleSaveAsProject}
      />
    </div>
  );
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

function RecordingBanner({
  state,
}: {
  state: { totalSec: number; startedAt: number };
}) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setNow(performance.now());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  const elapsed = Math.max(0, (now - state.startedAt) / 1000);
  const remaining = Math.max(0, state.totalSec - elapsed);
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
        display: "flex",
        alignItems: "center",
        gap: 8,
        boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
        pointerEvents: "none",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: "#fca5a5",
          boxShadow: "0 0 8px #ef4444",
        }}
      />
      REC {remaining.toFixed(1)}s remaining
    </div>
  );
}
