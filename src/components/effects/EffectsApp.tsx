"use client";

import {
  addEdge,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import NodeEditor from "./NodeEditor";
import ParamPanel from "./ParamPanel";
import PaintOverlay from "./PaintOverlay";
import Timeline from "./Timeline";
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

const RES_PRESETS: Array<{ label: string; w: number; h: number }> = [
  { label: "512 × 512", w: 512, h: 512 },
  { label: "1024 × 1024", w: 1024, h: 1024 },
  { label: "2048 × 2048", w: 2048, h: 2048 },
  { label: "1280 × 720", w: 1280, h: 720 },
  { label: "1920 × 1080", w: 1920, h: 1080 },
  { label: "3840 × 2160", w: 3840, h: 2160 },
];

function EffectsShell() {
  const [nodes, setNodes, onNodesChange] =
    useNodesState<Node<NodeDataPayload>>(INITIAL_NODES);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(INITIAL_EDGES);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [canvasRes, setCanvasRes] = useState<[number, number]>([1024, 1024]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [rightColWidth, setRightColWidth] = useState(520);
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
    [setEdges]
  );

  const onAddNode = useCallback(
    (type: string) => {
      const pos = {
        x: 200 + Math.random() * 200,
        y: 200 + Math.random() * 100,
      };
      setNodes((prev) => [...prev, makeInstanceNode(type, pos)]);
    },
    [setNodes]
  );

  const onParamChange = useCallback(
    (nodeId: string, paramName: string, value: unknown) => {
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
    [setNodes]
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
  }, [setNodes]);

  const onToggleParamExposed = useCallback(
    (nodeId: string, paramName: string) => {
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
    [setNodes, setEdges]
  );

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

  const resKey = `${canvasRes[0]}×${canvasRes[1]}`;
  const isPreset = RES_PRESETS.some((r) => `${r.w}×${r.h}` === resKey);

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
        <header
          style={{
            padding: "8px 12px",
            borderBottom: "1px solid #27272a",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span style={{ fontSize: 11, letterSpacing: 0.5 }}>
            toolbox · canvas
          </span>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 16,
              fontSize: 11,
              color: "#a1a1aa",
            }}
          >
            <span
              title="Target playback framerate (configured in timeline)"
              style={{
                fontVariantNumeric: "tabular-nums",
                color: "#a1a1aa",
              }}
            >
              {fps} fps
            </span>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11,
              color: "#a1a1aa",
            }}
          >
            resolution
            <select
              value={isPreset ? resKey : "__custom__"}
              onChange={(e) => {
                if (e.target.value === "__custom__") return;
                const [w, h] = e.target.value.split("×").map(Number);
                setCanvasRes([w, h]);
              }}
              style={{
                background: "#0a0a0a",
                border: "1px solid #27272a",
                color: "#e5e7eb",
                fontFamily: "inherit",
                fontSize: 11,
                padding: "2px 4px",
              }}
            >
              {RES_PRESETS.map((r) => (
                <option key={r.label} value={`${r.w}×${r.h}`}>
                  {r.label}
                </option>
              ))}
              {!isPreset && (
                <option value="__custom__">
                  {canvasRes[0]} × {canvasRes[1]} (custom)
                </option>
              )}
            </select>
            <ResInput
              value={canvasRes[0]}
              onCommit={(w) => setCanvasRes([w, canvasRes[1]])}
            />
            <span style={{ color: "#52525b" }}>×</span>
            <ResInput
              value={canvasRes[1]}
              onCommit={(h) => setCanvasRes([canvasRes[0], h])}
            />
          </label>
          </div>
        </header>
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
            />
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
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onSelectNode={setSelectedId}
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

function ResInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);
  const commit = () => {
    const n = Math.round(parseFloat(draft));
    if (!Number.isFinite(n) || n < 16 || n > 8192) {
      setDraft(String(value));
      return;
    }
    if (n !== value) onCommit(n);
  };
  return (
    <input
      type="number"
      value={draft}
      min={16}
      max={8192}
      step={1}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      style={{
        width: 64,
        background: "#0a0a0a",
        border: "1px solid #27272a",
        color: "#e5e7eb",
        fontFamily: "inherit",
        fontSize: 11,
        padding: "2px 4px",
      }}
    />
  );
}
