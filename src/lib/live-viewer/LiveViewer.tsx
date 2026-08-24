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
import { colorValueToHex, parseRampParamKey } from "@/engine/conventions";
import type { ColorRampStop } from "@/engine/color-ramp";
import type { ImageValue } from "@/engine/types";
import { registerAllNodes } from "@/nodes";
import { deserializeGraph, type SavedProject } from "@/lib/project";
import {
  mountCursorCapture,
  type CursorCaptureHandle,
} from "@/lib/cursor-capture";
import type { ExportManifest } from "./manifest-types";
import { ControlPanel } from "./ControlPanel";
import {
  exportViewerGif,
  exportViewerImage,
  recordViewerVideo,
} from "./viewer-export";

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
  // Viewer export (081426_live-link-designer.md M3). While a GIF export's
  // frame-stepped drive owns the canvas, exportingRef gates the RAF loop
  // and the evalBump repaint so two writers never race a capture.
  const exportingRef = useRef(false);
  const [exportStatus, setExportStatus] = useState<{
    label: string;
    cancel?: () => void;
  } | null>(null);
  const failTimerRef = useRef(0);
  // Use the project's saved playback metadata when present. Pre-v2
  // saves omit `scene`; fall back to the editor's defaults so they
  // play back exactly as they did before the field landed.
  const fps = graph.scene?.fps ?? 60;
  // null = no loop (open-ended). When set, the RAF tick wraps `time`
  // at `loopFrames / fps` so animation/keyframes loop on the same
  // boundary the editor's playhead does.
  const loopSecs =
    graph.scene?.loopFrames != null && graph.scene.loopFrames > 0
      ? graph.scene.loopFrames / fps
      : null;

  // ctx.cursor comes from the shared capture module — the SAME module the
  // editor mounts (lib/cursor-capture), so cursor-aware and interaction
  // nodes behave identically in /live/ and exported apps. The rAF loop
  // below runs runFrame every frame whether playing or paused, so the
  // per-pass commit() in runFrame is all the pacing the snapshot needs
  // (no onInput bump — nothing here waits on pointer activity to render).
  const cursorCaptureRef = useRef<CursorCaptureHandle | null>(null);
  useEffect(() => {
    const capture = mountCursorCapture({
      getBox: () => canvasRef.current,
    });
    cursorCaptureRef.current = capture;
    return () => {
      capture.dispose();
      cursorCaptureRef.current = null;
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
          parentId: n.data.parentId,
          params: { ...n.data.params },
          exposedParams: n.data.exposedParams,
          // Keyframe blocks are first-class on GraphNode — the
          // evaluator reads them per-eval to compute the animated
          // value at the current tick. Dropping this field is what
          // made /live/ render the static initial pose instead of
          // the animated graph.
          animation: n.data.animation,
          clips: n.data.clips,
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
  // Render-resolution scale (2026-08-17) — the live-link analogue of the
  // editor's previewScale: drops the GL buffer size for framerate on
  // weak machines. Recreating the backend resets stateful sims (same
  // trade the editor makes); the CSS box is unchanged, so lowering it
  // just softens the image.
  const [renderScale, setRenderScale] = useState(1);
  const renderRes = useMemo<[number, number]>(
    () => [
      Math.max(2, Math.round(canvasRes[0] * renderScale)),
      Math.max(2, Math.round(canvasRes[1] * renderScale)),
    ],
    [canvasRes, renderScale]
  );
  useEffect(() => {
    try {
      evalCacheRef.current = new Map();
      const backend = createEngineBackend(renderRes[0], renderRes[1]);
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
  }, [renderRes[0], renderRes[1]]);

  const drivenParams = useMemo(
    () => buildDrivenSet(runtimeGraph?.graphEdges ?? []),
    [runtimeGraph]
  );

  const runFrame = useCallback(
    (renderTime: number) => {
      const backend = backendRef.current;
      const canvas = canvasRef.current;
      if (!backend || !canvas || !runtimeGraph) return;
      // One cursor commit per pass — the serial bump clears last pass's
      // derived press/release pulses (engine/cursor-signals.ts).
      const ctx = backend.makeContext(
        renderTime,
        Math.floor(renderTime * fps),
        cursorCaptureRef.current?.commit(),
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
      // A GIF export's frame-stepped drive owns the canvas; idle the
      // interactive loop and re-seed dt on resume so time doesn't jump.
      if (exportingRef.current) {
        lastFrameRef.current = null;
        raf = requestAnimationFrame(tick);
        return;
      }
      const last = lastFrameRef.current;
      lastFrameRef.current = now;
      if (playingRef.current && last !== null) {
        const dt = (now - last) / 1000;
        let next = timeRef.current + dt;
        // Wrap at loop boundary so animation blocks repeat instead
        // of running off into dead time. Mirrors the editor's RAF
        // wrap math; > 0 guard skips degenerate "loop length 0".
        if (loopSecs != null && loopSecs > 0 && next >= loopSecs) {
          next = next % loopSecs;
        }
        timeRef.current = next;
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
    if (exportingRef.current) return;
    runFrame(timeRef.current);
  }, [evalBump, runFrame]);

  const onParamChange = useCallback(
    (ref: { nodeId: string; paramName: string }, value: unknown) => {
      const graph = runtimeGraph;
      if (graph) {
        const node = graph.graphNodes.find((n) => n.id === ref.nodeId);
        if (node) {
          // Per-stop ramp controls carry a virtual paramName
          // (ramp_c/a/p:<param>:<stopId> — engine/conventions): patch the
          // stop inside the owning color_ramp param instead of writing a
          // literal param the node would never read.
          const rk = parseRampParamKey(ref.paramName);
          if (rk) {
            const base = node.params[rk.paramName];
            const stops = Array.isArray(base)
              ? (base as ColorRampStop[]).map((s) => ({ ...s }))
              : [];
            const stop = stops.find((s) => s.id === rk.stopId);
            if (stop) {
              if (rk.field === "color") {
                stop.color = colorValueToHex(value, stop.color);
              } else if (
                typeof value === "number" &&
                Number.isFinite(value)
              ) {
                const v = Math.max(0, Math.min(1, value));
                if (rk.field === "alpha") stop.alpha = v;
                else stop.position = v;
              }
              node.params[rk.paramName] = stops;
            }
          } else {
            node.params[ref.paramName] = value;
          }
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

  const onSeek = useCallback((t: number) => {
    timeRef.current = t;
    setTime(t);
    setEvalBump((n) => n + 1);
  }, []);

  // --- viewer export (081426 M3) ----------------------------------------
  // Which buttons exist is the author's call (design.export); the drivers
  // are lean captures of what's on screen — see viewer-export.ts.
  const appName = manifest.appName;
  // One loop; open-ended (no-loop) projects cap at 10s.
  const exportDurationSecs =
    loopSecs != null && loopSecs > 0 ? loopSecs : 10;

  const showExportError = useCallback((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    setExportStatus({ label: `Export failed: ${msg}` });
    window.clearTimeout(failTimerRef.current);
    failTimerRef.current = window.setTimeout(
      () => setExportStatus(null),
      6000
    );
  }, []);

  const onExportImage = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || exportingRef.current) return;
    exportViewerImage(canvas, appName).catch(showExportError);
  }, [appName, showExportError]);

  const onExportVideo = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || exportingRef.current) return;
    // Restart from 0 and make sure we're playing — the recording is a
    // live capture of the RAF loop covering exactly one loop.
    timeRef.current = 0;
    setTime(0);
    if (!playingRef.current) {
      playingRef.current = true;
      setPlaying(true);
      lastFrameRef.current = null;
    }
    const handle = recordViewerVideo({
      canvas,
      fps,
      durationSecs: exportDurationSecs,
      baseName: appName,
    });
    setExportStatus({ label: "Recording…", cancel: handle.cancel });
    handle.done
      .then(() => setExportStatus(null))
      .catch(showExportError);
  }, [appName, exportDurationSecs, fps, showExportError]);

  const onExportGif = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || exportingRef.current) return;
    const controller = new AbortController();
    exportingRef.current = true;
    setExportStatus({
      label: "Preparing GIF…",
      cancel: () => controller.abort(),
    });
    exportViewerGif({
      canvas,
      durationSecs: exportDurationSecs,
      baseName: appName,
      renderFrame: (t) => runFrame(t),
      onProgress: (label) =>
        setExportStatus((s) => ({ label, cancel: s?.cancel })),
      signal: controller.signal,
    })
      .then(() => setExportStatus(null))
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") {
          setExportStatus(null);
        } else {
          showExportError(err);
        }
      })
      .finally(() => {
        exportingRef.current = false;
        // Repaint the interactive frame the export drive painted over.
        setEvalBump((n) => n + 1);
      });
  }, [appName, exportDurationSecs, runFrame, showExportError]);

  const exportFlags = manifest.design?.export;
  const exportHandlers = useMemo(() => {
    if (!exportFlags) return undefined;
    if (!exportFlags.image && !exportFlags.video && !exportFlags.gif) {
      return undefined;
    }
    return {
      image: exportFlags.image ? onExportImage : undefined,
      video: exportFlags.video ? onExportVideo : undefined,
      gif: exportFlags.gif ? onExportGif : undefined,
    };
  }, [exportFlags, onExportImage, onExportVideo, onExportGif]);

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
          width={renderRes[0]}
          height={renderRes[1]}
          // The CSS box keeps the project's aspect regardless of the
          // render-scale buffer size.
          style={{ aspectRatio: `${canvasRes[0]} / ${canvasRes[1]}` }}
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
        loopSecs={loopSecs}
        onSeek={onSeek}
        renderScale={renderScale}
        onRenderScale={setRenderScale}
        exportHandlers={exportHandlers}
        exportStatus={exportStatus}
      />
    </div>
  );
}
