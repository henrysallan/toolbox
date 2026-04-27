"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createEngineBackend, type EngineBackend } from "@/engine/gl";
import {
  evaluateGraph,
  type EvalCache,
  type GraphEdge,
  type GraphNode,
} from "@/engine/evaluator";
import { parseTargetHandleKind } from "@/engine/graph-helpers";
import type { ImageValue } from "@/engine/types";
import { registerAllNodes } from "@/nodes";
import { deserializeGraph, type SavedProject } from "@/lib/project";
import type { ExportManifest } from "./manifest-types";
import { ControlPanel } from "./ControlPanel";

// Node defs are global state — register once on module init. Safe to call
// repeatedly (the registry no-ops on dupes), but module-init keeps it
// happening exactly once per page load.
registerAllNodes();

interface RuntimeGraph {
  graphNodes: GraphNode[];
  graphEdges: GraphEdge[];
}

function buildDrivenSet(edges: GraphEdge[]): Set<string> {
  const set = new Set<string>();
  for (const edge of edges) {
    const parsed = parseTargetHandleKind(edge.targetHandle);
    if (parsed?.kind === "param") {
      set.add(`${edge.target}::${parsed.name}`);
    }
  }
  return set;
}

export interface LiveViewerProps {
  graph: SavedProject;
  manifest: ExportManifest;
}

export default function LiveViewer({ graph, manifest }: LiveViewerProps) {
  const [error, setError] = useState<string | null>(null);
  const [runtimeGraph, setRuntimeGraph] = useState<RuntimeGraph | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const backendRef = useRef<EngineBackend | null>(null);
  const evalCacheRef = useRef<EvalCache>(new Map());

  const [paramValues, setParamValues] = useState<
    Map<string, Record<string, unknown>>
  >(new Map());
  const paramValuesRef = useRef<Map<string, Record<string, unknown>>>(
    new Map()
  );

  const [evalBump, setEvalBump] = useState(0);

  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const playingRef = useRef(false);
  const timeRef = useRef(0);
  const lastFrameRef = useRef<number | null>(null);
  const fps = 60;

  // Live cursor in canvas UV. Updated on pointermove and read on every
  // frame — mirrors the editor's wiring so cursor-aware nodes (Cursor
  // source, scatter-points, etc.) behave the same way in /live/.
  const cursorRef = useRef<{ x: number; y: number; active: boolean }>({
    x: 0.5,
    y: 0.5,
    active: false,
  });
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      // DOM y-down → pipeline y-up. Engine textures use v_uv.y = 0 at
      // the bottom of the frame, so we flip here once.
      const yDom = (e.clientY - rect.top) / rect.height;
      const y = 1 - yDom;
      const inside = x >= 0 && x <= 1 && yDom >= 0 && yDom <= 1;
      cursorRef.current = { x, y, active: inside };
    };
    const onLeave = () => {
      cursorRef.current = { ...cursorRef.current, active: false };
    };
    window.addEventListener("pointermove", onMove);
    document.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    deserializeGraph(graph)
      .then(({ nodes, edges }) => {
        if (cancelled) return;
        const graphNodes: GraphNode[] = nodes.map((n) => ({
          id: n.id,
          type: n.data.defType,
          params: { ...n.data.params },
          exposedParams: n.data.exposedParams,
          bypassed: !!n.data.bypassed,
        }));
        const graphEdges: GraphEdge[] = edges.map((e) => ({
          id: e.id,
          source: e.source,
          sourceHandle: e.sourceHandle ?? "out:primary",
          target: e.target,
          targetHandle: e.targetHandle ?? "in:image",
        }));
        const initialParams = new Map<string, Record<string, unknown>>();
        for (const gn of graphNodes) {
          initialParams.set(gn.id, gn.params);
        }
        paramValuesRef.current = initialParams;
        setParamValues(new Map(initialParams));
        setRuntimeGraph({ graphNodes, graphEdges });
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error("LiveViewer deserialize failed", err);
        if (!cancelled) setError(msg);
      });
    return () => {
      cancelled = true;
    };
  }, [graph]);

  const canvasRes = manifest.canvasRes;
  useEffect(() => {
    try {
      evalCacheRef.current = new Map();
      const backend = createEngineBackend(canvasRes[0], canvasRes[1]);
      backendRef.current = backend;
      setEvalBump((n) => n + 1);
      return () => {
        backend.destroy();
        backendRef.current = null;
      };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Engine init failed", err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [canvasRes[0], canvasRes[1]]);

  const drivenParams = useMemo(
    () => buildDrivenSet(runtimeGraph?.graphEdges ?? []),
    [runtimeGraph]
  );

  const runFrame = useCallback(
    (renderTime: number) => {
      const backend = backendRef.current;
      const canvas = canvasRef.current;
      if (!backend || !canvas || !runtimeGraph) return;
      const ctx = backend.makeContext(
        renderTime,
        Math.floor(renderTime * fps),
        cursorRef.current,
        playingRef.current
      );
      const result = evaluateGraph(
        runtimeGraph.graphNodes,
        runtimeGraph.graphEdges,
        ctx,
        evalCacheRef.current,
        manifest.outputNodeId
      );
      const term = result.terminalImage;
      if (term && term.image.kind === "image") {
        ctx.blitToCanvas(term.image as ImageValue, canvas);
      }
    },
    [runtimeGraph, manifest.outputNodeId]
  );

  useEffect(() => {
    if (!runtimeGraph) return;
    let raf = 0;
    let cancelled = false;
    lastFrameRef.current = null;
    const tick = (now: number) => {
      if (cancelled) return;
      const last = lastFrameRef.current;
      lastFrameRef.current = now;
      if (playingRef.current && last !== null) {
        const dt = (now - last) / 1000;
        timeRef.current += dt;
        setTime(timeRef.current);
      }
      runFrame(timeRef.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [runtimeGraph, runFrame]);

  useEffect(() => {
    if (playingRef.current) return;
    runFrame(timeRef.current);
  }, [evalBump, runFrame]);

  const onParamChange = useCallback(
    (ref: { nodeId: string; paramName: string }, value: unknown) => {
      const graph = runtimeGraph;
      if (graph) {
        const node = graph.graphNodes.find((n) => n.id === ref.nodeId);
        if (node) {
          node.params[ref.paramName] = value;
        }
      }
      const next = new Map(paramValuesRef.current);
      const existing = next.get(ref.nodeId) ?? {};
      const updated = { ...existing, [ref.paramName]: value };
      next.set(ref.nodeId, updated);
      paramValuesRef.current = next;
      setParamValues(next);
      setEvalBump((n) => n + 1);
    },
    [runtimeGraph]
  );

  const onTogglePlay = useCallback(() => {
    setPlaying((p) => {
      const next = !p;
      playingRef.current = next;
      lastFrameRef.current = null;
      return next;
    });
  }, []);

  const onReset = useCallback(() => {
    timeRef.current = 0;
    setTime(0);
    setEvalBump((n) => n + 1);
  }, []);

  if (error) {
    return (
      <div className="fatal">
        Live viewer failed to load:{"\n"}
        {error}
      </div>
    );
  }

  return (
    <div className="app">
      <div className="canvas-area">
        <canvas
          ref={canvasRef}
          width={canvasRes[0]}
          height={canvasRes[1]}
        />
      </div>
      <ControlPanel
        manifest={manifest}
        paramValues={paramValues}
        drivenParams={drivenParams}
        onParamChange={onParamChange}
        playing={playing}
        onTogglePlay={onTogglePlay}
        onReset={onReset}
        time={time}
      />
    </div>
  );
}
