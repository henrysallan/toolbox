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
import { computeActiveNodeSet } from "@/engine/active-branch";
import {
  colorValueToHex,
  parseMergeLayerKey,
  parseRampParamKey,
} from "@/engine/conventions";
import type { ColorRampStop } from "@/engine/color-ramp";
import type { MergeLayer } from "@/nodes/effect/merge";
import type { ImageValue } from "@/engine/types";
import { rgbaToBytes } from "@/lib/export-capture";
import { registerAllNodes } from "@/nodes";
import { deserializeGraph, type SavedProject } from "@/lib/project";
import {
  mountCursorCapture,
  type CursorCaptureHandle,
} from "@/lib/cursor-capture";
import { DEFAULT_TICKS_PER_FRAME } from "@/engine/keyframes";
import { feedWheel } from "@/components/effects/input-device";
import {
  useViewportGestures,
  useViewportPanZoom,
} from "@/lib/viewport-gestures";
import { useUndoShortcuts } from "@/state/history";
import type { ExportManifest } from "./manifest-types";
import { ControlPanel, type PanelTitle } from "./ControlPanel";
import {
  createParamHistory,
  type HistoryGroup,
  type ParamEdit,
} from "./param-history";
import { LiveGizmoLayer } from "./LiveGizmoLayer";
import { ZoomChip } from "./ZoomChip";
import type { LiveLoadPhase } from "./LiveLoadOverlay";
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
  // Patch identity for the panel's title row (ControlPanel PanelTitle).
  // /live passes it; the exported app omits it and gets no row.
  title?: PanelTitle;
  // Load-phase reporting for the host's LiveLoadOverlay (mounted → graph →
  // ready, or failed). Optional: a host without a veil just doesn't listen.
  onLoadPhase?: (phase: LiveLoadPhase) => void;
}

export default function LiveViewer({
  graph,
  manifest,
  title,
  onLoadPhase,
}: LiveViewerProps) {
  const [error, setError] = useState<string | null>(null);
  const [runtimeGraph, setRuntimeGraph] = useState<RuntimeGraph | null>(null);

  // The host's veil listens through a ref so the deserialize and frame
  // effects below don't re-run when the host re-renders with a fresh
  // callback. "mounted" = the dynamic chunk arrived; "ready" fires once,
  // from the first full runFrame.
  const onLoadPhaseRef = useRef(onLoadPhase);
  useEffect(() => {
    onLoadPhaseRef.current = onLoadPhase;
  });
  const readyReportedRef = useRef(false);
  useEffect(() => {
    onLoadPhaseRef.current?.("mounted");
  }, []);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The canvas ELEMENT as state, for the gizmo layer (091726_live-gizmos.md):
  // the overlays take the element as a prop and track its rect, so they
  // need a render after it mounts — a ref alone would never re-render them.
  const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null);
  const attachCanvas = useCallback((el: HTMLCanvasElement | null) => {
    canvasRef.current = el;
    setCanvasEl(el);
  }, []);
  const backendRef = useRef<EngineBackend | null>(null);
  // Terminal image of the latest runFrame pass — the GIF export reads its
  // pixels straight off the GPU (export-capture.ts) rather than copying the
  // on-screen canvas, which a hidden tab can hold stale.
  const lastTerminalRef = useRef<ImageValue | null>(null);
  const evalCacheRef = useRef<EvalCache>(new Map());

  const [paramValues, setParamValues] = useState<
    Map<string, Record<string, unknown>>
  >(new Map());
  const paramValuesRef = useRef<Map<string, Record<string, unknown>>>(
    new Map()
  );

  const [evalBump, setEvalBump] = useState(0);

  // Undo / redo for the visitor's param edits (param-history.ts): a
  // per-session stack over the same two writes onParamChange makes. The
  // editor's history never sees these edits (they never leave the viewer),
  // so before this ⌘Z on a live link did nothing.
  const historyRef = useRef(createParamHistory());

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
        // A fresh graph means fresh nodes — entries recorded against the
        // old ones would write into objects nothing renders any more.
        historyRef.current.clear();
        setRuntimeGraph({ graphNodes, graphEdges });
        onLoadPhaseRef.current?.("graph");
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error("LiveViewer deserialize failed", err);
        if (!cancelled) {
          setError(msg);
          onLoadPhaseRef.current?.("failed");
        }
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
      onLoadPhaseRef.current?.("failed");
    }
  }, [renderRes[0], renderRes[1]]);

  const drivenParams = useMemo(
    () => buildDrivenSet(runtimeGraph?.graphEdges ?? []),
    [runtimeGraph]
  );

  // Active-branch filter (engine/active-branch.ts): which manifest rows
  // show follows what the graph is rendering — at a Switch, only the
  // picked slot's upstream. Keyed on paramValues (a fresh Map per control
  // edit) and fed the live Index values, so flipping a Switch pill hides
  // the other branch's rows on the same render.
  const activeNodeIds = useMemo(() => {
    if (!runtimeGraph) return undefined;
    return computeActiveNodeSet(
      runtimeGraph.graphNodes,
      runtimeGraph.graphEdges,
      manifest.outputNodeId,
      { indexOf: (id) => paramValues.get(id)?.index }
    );
  }, [runtimeGraph, paramValues, manifest.outputNodeId]);

  // Visitor-facing gizmo visibility (091726_live-gizmos.md, decision 1):
  // every shipped GUI starts HIDDEN — the canvas loads clean and a visitor
  // opts into a set of handles from its row (the owner flipped the
  // start-visible first cut after trying it). Per session only. Rows and
  // handles on an unpicked Switch branch drop with the active-branch
  // filter like every other row.
  const [shownGizmos, setShownGizmos] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const onToggleGizmo = useCallback((nodeId: string, visible: boolean) => {
    setShownGizmos((prev) => {
      const next = new Set(prev);
      if (visible) next.add(nodeId);
      else next.delete(nodeId);
      return next;
    });
  }, []);
  const visibleGizmos = useMemo(
    () =>
      (manifest.gizmos ?? []).filter(
        (g) =>
          shownGizmos.has(g.nodeId) &&
          (!activeNodeIds || activeNodeIds.has(g.nodeId))
      ),
    [manifest.gizmos, shownGizmos, activeNodeIds]
  );
  // The tick the evaluator samples keyframes at for this frame — what
  // makeContext derives when runFrame passes no timeline (frame × 1000) —
  // so a handle on an animated param sits where the render put it.
  const gizmoTick = Math.floor(time * fps) * DEFAULT_TICKS_PER_FRAME;

  // Pan / zoom (091826_live-pan-zoom.md): the author enables the control
  // per link (design.layout.panZoom); the visitor switches it on from the
  // title-row button. The gestures are the editor's own
  // (lib/viewport-gestures: trackpad scroll pans, pinch / ⌘-scroll zooms,
  // a mouse wheel zooms, middle-drag pans, touch pans / pinches), bound to
  // the canvas area and attached only while the button is on. Switching
  // it off resets the view — that is also the visitor's way back to the
  // default framing.
  const panZoomAvailable = manifest.design?.layout.panZoom === true;
  const [panZoomOn, setPanZoomOn] = useState(false);
  const {
    viewportRef,
    zoom,
    pan,
    setPan,
    setZoom,
    reset: resetView,
    isDefault: viewIsDefault,
  } = useViewportPanZoom();
  const gesturesOn = panZoomAvailable && panZoomOn;
  useViewportGestures(viewportRef, setPan, setZoom, gesturesOn);
  const onTogglePanZoom = useCallback(() => {
    if (panZoomOn) resetView();
    setPanZoomOn(!panZoomOn);
  }, [panZoomOn, resetView]);
  // Mouse-vs-trackpad detection behind wheelWantsZoom (input-device.ts) —
  // the same capture listener the editor mounts. Only while the control
  // is available; a link without it pays nothing.
  useEffect(() => {
    if (!panZoomAvailable) return;
    const onWheel = (e: WheelEvent) => feedWheel(e);
    window.addEventListener("wheel", onWheel, { capture: true, passive: true });
    return () => window.removeEventListener("wheel", onWheel, { capture: true });
  }, [panZoomAvailable]);
  // The gizmo overlays cache the canvas rect and refresh it on window
  // "resize" — the editor fires the same synthetic event on its own
  // zoom / pan, so the handles follow the transformed canvas.
  useEffect(() => {
    window.dispatchEvent(new Event("resize"));
  }, [zoom, pan]);

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
      lastTerminalRef.current =
        term && term.image.kind === "image" ? (term.image as ImageValue) : null;
      if (term && term.image.kind === "image") {
        ctx.blitToCanvas(term.image as ImageValue, canvas);
      }
      // First full pass: whatever it drew (a graph with no image at the
      // terminal is still loaded), the viewer is up — lift the veil.
      if (!readyReportedRef.current) {
        readyReportedRef.current = true;
        onLoadPhaseRef.current?.("ready");
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

  // Write one per-session value into `paramValues` (copy-on-write: the
  // Map identity is what the panel and the active-branch filter key on).
  // `undefined` deletes the key, so an undo of a virtual ramp / merge key
  // that never existed before the edit leaves the record as it was.
  const writeSessionValue = useCallback(
    (nodeId: string, key: string, value: unknown) => {
      const next = new Map(paramValuesRef.current);
      const existing = next.get(nodeId) ?? {};
      const updated = { ...existing };
      if (value === undefined) delete updated[key];
      else updated[key] = value;
      next.set(nodeId, updated);
      paramValuesRef.current = next;
    },
    []
  );

  const onParamChange = useCallback(
    (
      ref: { nodeId: string; paramName: string },
      value: unknown,
      // History grouping: rapid writes sharing a key collapse into one
      // undo step (a slider drag, a gizmo drag writing several params).
      // Defaults to the param itself; the gizmo layer passes its node.
      coalesceKey?: string
    ) => {
      const graph = runtimeGraph;
      // Where the write lands on the runtime node, and its before / after,
      // for the history entry. Defaults to "the param itself"; the ramp /
      // merge branches below redirect it to the owning array.
      let storedKey = ref.paramName;
      let prevStored: unknown;
      let nextStored: unknown;
      let touchedNode = false;
      if (graph) {
        const node = graph.graphNodes.find((n) => n.id === ref.nodeId);
        if (node) {
          touchedNode = true;
          // Per-stop ramp controls carry a virtual paramName
          // (ramp_c/a/p:<param>:<stopId> — engine/conventions): patch the
          // stop inside the owning color_ramp param instead of writing a
          // literal param the node would never read.
          const rk = parseRampParamKey(ref.paramName);
          const lk = rk ? null : parseMergeLayerKey(ref.paramName);
          if (rk) storedKey = rk.paramName;
          else if (lk && lk.field !== "layer") storedKey = lk.paramName;
          // Captured BEFORE the branches write. The ramp / merge branches
          // shallow-copy the stops / layers into a fresh array, and the
          // plain branch replaces the value, so this reference is not
          // mutated by what follows.
          prevStored = node.params[storedKey];
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
            // Per-layer Merge controls (mlayer_m/o:<param>:<layerId>):
            // patch the layer's blend mode / opacity inside the owning
            // merge_layers array, same contract as the ramp stops.
            if (lk && lk.field !== "layer") {
              const base = node.params[lk.paramName];
              const layers = Array.isArray(base)
                ? (base as MergeLayer[]).map((l) => ({ ...l }))
                : [];
              const layer = layers.find((l) => l.id === lk.layerId);
              if (layer) {
                if (lk.field === "mode") {
                  if (typeof value === "string") {
                    layer.mode = value as MergeLayer["mode"];
                  }
                } else if (
                  typeof value === "number" &&
                  Number.isFinite(value)
                ) {
                  layer.opacity = Math.max(0, Math.min(1, value));
                }
                node.params[lk.paramName] = layers;
              }
            } else {
              node.params[ref.paramName] = value;
            }
          }
          nextStored = node.params[storedKey];
        }
      }
      const prevValue = paramValuesRef.current.get(ref.nodeId)?.[ref.paramName];
      writeSessionValue(ref.nodeId, ref.paramName, value);
      setParamValues(paramValuesRef.current);
      setEvalBump((n) => n + 1);
      // A write that found no runtime node changed nothing the render
      // reads; recording it would make undo delete a stored param that
      // was never touched.
      if (!touchedNode) return;
      const edit: ParamEdit = {
        nodeId: ref.nodeId,
        storedKey,
        prevStored,
        nextStored,
        valueKey: ref.paramName,
        prevValue,
        nextValue: value,
      };
      historyRef.current.record(
        edit,
        coalesceKey ?? `param:${ref.nodeId}:${ref.paramName}`
      );
    },
    [runtimeGraph, writeSessionValue]
  );

  // Apply one history entry in either direction: the stored params go
  // straight back onto the runtime nodes (the evaluator reads them
  // per-eval, fingerprinting by value), the session values through the
  // same copy-on-write the live write uses, then one repaint.
  const applyHistoryGroup = useCallback(
    (group: HistoryGroup, dir: "prev" | "next") => {
      const graph = runtimeGraph;
      if (graph) {
        for (const w of group.stored) {
          const node = graph.graphNodes.find((n) => n.id === w.nodeId);
          if (!node) continue;
          const v = w[dir];
          if (v === undefined) delete node.params[w.key];
          else node.params[w.key] = v;
        }
      }
      for (const w of group.values) {
        writeSessionValue(w.nodeId, w.key, w[dir]);
      }
      setParamValues(paramValuesRef.current);
      setEvalBump((n) => n + 1);
    },
    [runtimeGraph, writeSessionValue]
  );

  const undo = useCallback(() => {
    const group = historyRef.current.undo();
    if (group) applyHistoryGroup(group, "prev");
  }, [applyHistoryGroup]);

  const redo = useCallback(() => {
    const group = historyRef.current.redo();
    if (group) applyHistoryGroup(group, "next");
  }, [applyHistoryGroup]);

  // ⌘Z / ⇧⌘Z / ⌘Y — the editor's own binding (state/history.ts), which
  // already skips text fields (native undo) but not range / color inputs,
  // so ⌘Z with a slider focused undoes the slider.
  useUndoShortcuts(undo, redo);

  const onTogglePlay = useCallback(() => {
    setPlaying((p) => {
      const next = !p;
      playingRef.current = next;
      lastFrameRef.current = null;
      return next;
    });
  }, []);

  // Spacebar = play / pause (2026-09-15), the transport convention every
  // player shares. Skipped while a text field, select or button has focus:
  // typing needs the space, and a focused button already fires its own
  // click on space (toggling twice would cancel out). preventDefault keeps
  // the page from scrolling.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" && e.key !== " ") return;
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          tag === "BUTTON" ||
          t.isContentEditable
        ) {
          return;
        }
      }
      e.preventDefault();
      onTogglePlay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onTogglePlay]);

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
      capturePng: async () => {
        const backend = backendRef.current;
        const img = lastTerminalRef.current;
        const px =
          backend && img
            ? backend.readImagePixels(img, canvas.width, canvas.height)
            : null;
        if (!px) {
          throw new Error(
            "nothing to capture — the graph has no image at its output, or the GPU context was lost"
          );
        }
        return rgbaToBytes(
          { px, width: canvas.width, height: canvas.height },
          "image/png"
        );
      },
      width: canvas.width,
      height: canvas.height,
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
      <div
        className="canvas-area"
        ref={viewportRef}
        // While the visitor's pan/zoom is on, the touch handler owns the
        // gestures (one finger pans, two pinch); otherwise the page keeps
        // its native touch scrolling.
        style={gesturesOn ? { touchAction: "none" } : undefined}
      >
        <canvas
          ref={attachCanvas}
          width={renderRes[0]}
          height={renderRes[1]}
          // The CSS box keeps the project's aspect regardless of the
          // render-scale buffer size. The transform is the visitor's view
          // (identity until they pan / zoom), same composition as the
          // editor's viewport canvas.
          style={{
            aspectRatio: `${canvasRes[0]} / ${canvasRes[1]}`,
            transform: `translate(${pan[0]}px, ${pan[1]}px) scale(${zoom})`,
            transformOrigin: "center center",
          }}
        />
        {/* Zoom readout + reset — the editor's viewport chip, only while
            the view is off the default framing. */}
        {panZoomAvailable && !viewIsDefault && (
          <ZoomChip zoom={zoom} onReset={resetView} />
        )}
      </div>
      {/* On-canvas handles (091726_live-gizmos.md): fixed-position
          overlays that track the canvas box, so their place in the tree
          doesn't matter for layout. DOM, not pixels — the viewer exports
          capture the canvas alone. */}
      {runtimeGraph && visibleGizmos.length > 0 && (
        <LiveGizmoLayer
          gizmos={visibleGizmos}
          canvas={canvasEl}
          canvasRes={canvasRes}
          graphNodes={runtimeGraph.graphNodes}
          graphEdges={runtimeGraph.graphEdges}
          evalCacheRef={evalCacheRef}
          paramValues={paramValues}
          tick={gizmoTick}
          onParamChange={onParamChange}
        />
      )}
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
        activeNodeIds={activeNodeIds}
        title={title}
        shownGizmos={shownGizmos}
        onToggleGizmo={onToggleGizmo}
        panZoomOn={panZoomOn}
        onTogglePanZoom={onTogglePanZoom}
      />
    </div>
  );
}
