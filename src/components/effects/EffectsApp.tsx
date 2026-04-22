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
      auxOutputs: def.auxOutputs.map((a) => ({ name: a.name, type: a.type })),
      primaryOutput: def.primaryOutput,
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
    <ReactFlowProvider>
      <EffectsShell />
    </ReactFlowProvider>
  );
}

function EffectsShell() {
  const [nodes, setNodes, onNodesChange] =
    useNodesState<Node<NodeDataPayload>>(INITIAL_NODES);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(INITIAL_EDGES);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [canvasRes, setCanvasRes] = useState<[number, number]>([1024, 1024]);
  // Controls which panel the right-side parameters section is showing.
  // Selecting a node switches it to "node"; the Project Settings menu item
  // switches it back to "project".
  const [paramView, setParamView] = useState<"project" | "node">("node");
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

    const ctx = backend.makeContext(time, Math.floor(time * fps));
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
  }, [structFp, backendReady, time, fps]);

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
    [setEdges, pushGraph, getGraphSnapshot]
  );

  const onAddNode = useCallback(
    (type: string) => {
      pushGraph(getGraphSnapshot());
      const pos = {
        x: 200 + Math.random() * 200,
        y: 200 + Math.random() * 100,
      };
      setNodes((prev) => [...prev, makeInstanceNode(type, pos)]);
    },
    [setNodes, pushGraph, getGraphSnapshot]
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
    },
    [setNodes, pushGraph, getGraphSnapshot]
  );

  // Drop edges whose target handle no longer exists on the node — e.g. after
  // a merge layer was removed, a gradient mode change dropped the angle_mod
  // socket, or a param was un-exposed.
  useEffect(() => {
    setEdges((prev) => {
      const byId = new Map(nodes.map((n) => [n.id, n]));
      return prev.filter((e) => {
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
        detail.kind === "mergeAddLayer"
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

  const [copied, setCopied] = useState(false);
  const copiedTimeoutRef = useRef<number | null>(null);
  const flashCopied = useCallback(() => {
    setCopied(true);
    if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current);
    copiedTimeoutRef.current = window.setTimeout(() => setCopied(false), 1200);
  }, []);
  useEffect(
    () => () => {
      if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current);
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
      flashCopied();
    } catch (e) {
      console.error("Copy to clipboard failed:", e);
    }
  }, [flashCopied]);

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
        onOpenProjectSettings={() => setParamView("project")}
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
          {recording && <RecordingBanner state={recording} />}
          {copied && (
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
              copied
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
