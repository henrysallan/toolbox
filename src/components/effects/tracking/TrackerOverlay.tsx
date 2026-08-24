"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import type { PointTrackerData } from "@/engine/types";
import { aspectCorrectY, aspectUncorrectY } from "@/engine/aspect";
import { useClock } from "@/state/playback-clock";
import {
  addTrack,
  asPointTrackerData,
  removeSample,
  setSampleManual,
  shiftSamplesAfter,
  updateTrack,
} from "@/engine/tracking/track-data";
import { sampleTrackAtFrame, smoothTrack, trackColor } from "@/engine/tracking/sample";
import { claimPointerGesture } from "@/lib/pointer-claim";
import { rectsEqual } from "../overlay-rect";
import {
  setTrackerSelection,
  toggleTrackerSelection,
  useTrackerSelection,
} from "@/state/tracker-selection";
import Loupe from "./Loupe";

type ParamChange = (
  nodeId: string,
  paramName: string,
  value: unknown,
  coalesceKey?: string
) => void;

interface Props {
  canvas: HTMLCanvasElement | null;
  nodeId: string;
  params: Record<string, unknown>;
  onParamChange: ParamChange;
}

function oddSize(n: unknown, fallback: number): number {
  const v = Math.max(9, Math.round(typeof n === "number" ? n : fallback));
  return v % 2 === 0 ? v + 1 : v;
}

function toPx(
  ax: number,
  ay: number,
  rect: DOMRect
): { x: number; y: number } {
  const aspect = rect.width / rect.height;
  return { x: ax * rect.width, y: aspectCorrectY(ay, aspect) * rect.height };
}

function fromPx(
  px: number,
  py: number,
  rect: DOMRect
): { x: number; y: number } {
  const aspect = rect.width / rect.height;
  return {
    x: Math.max(0, Math.min(1, px / rect.width)),
    y: Math.max(0, Math.min(1, aspectUncorrectY(py / rect.height, aspect))),
  };
}

type Drag =
  | { kind: "anchor"; id: number }
  | {
      kind: "sample";
      id: number;
      frame: number;
      shift: boolean;
      start: PointTrackerData;
      origX: number;
      origY: number;
    }
  | { kind: "box"; id: number; which: "pattern" | "search" };

const STATUS_FILL: Record<number, string> = {
  0: "",
  1: "#ffffff",
  2: "#fbbf24",
  3: "transparent",
  4: "#f87171",
};

export function TrackerOverlayAtTick(props: Props) {
  const frame = useClock((s) => s.frame);
  return <TrackerOverlay {...props} frame={frame} />;
}

function TrackerOverlay({
  canvas,
  nodeId,
  params,
  onParamChange,
  frame,
}: Props & { frame: number }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [loupeZoom, setLoupeZoom] = useState(4);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  const onChangeRef = useRef(onParamChange);
  onChangeRef.current = onParamChange;
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const selectedIds = useTrackerSelection(nodeId);
  const placeMode = !!params.place_mode;
  const data = asPointTrackerData(params.tracks);
  const smoothRadius = Math.max(0, Math.round((params.smooth_radius as number) ?? 0));
  const smoothMode = ((params.smooth_mode as string) ?? "gaussian") as "gaussian" | "savgol";
  const gapFill = ((params.gap_fill as string) ?? "hold") === "interpolate" ? "interpolate" : "hold";

  useEffect(() => {
    const update = () =>
      setRect((prev) => {
        if (!canvas) return prev === null ? prev : null;
        const r = canvas.getBoundingClientRect();
        return rectsEqual(prev, r) ? prev : r;
      });
    const raf = requestAnimationFrame(update);
    if (!canvas) return () => cancelAnimationFrame(raf);
    const ro = new ResizeObserver(update);
    ro.observe(canvas);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [canvas]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!rect) return;
      setCursor({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      const d = dragRef.current;
      if (!d) return;
      const authored = fromPx(e.clientX - rect.left, e.clientY - rect.top, rect);
      const cur = asPointTrackerData(paramsRef.current.tracks);
      const key = `tracks:${nodeId}`;
      if (d.kind === "anchor") {
        const t = cur.tracks.find((tr) => tr.id === d.id);
        if (!t) return;
        if (t.frames.length === 0) {
          onChangeRef.current(
            nodeId,
            "tracks",
            updateTrack(cur, d.id, {
              ref: { frame: t.ref.frame, x: authored.x, y: authored.y },
            }),
            key
          );
        } else {
          onChangeRef.current(
            nodeId,
            "tracks",
            setSampleManual(cur, d.id, frame, authored.x, authored.y),
            key
          );
        }
      } else if (d.kind === "sample") {
        if (d.shift) {
          onChangeRef.current(
            nodeId,
            "tracks",
            shiftSamplesAfter(
              d.start,
              d.id,
              d.frame,
              authored.x - d.origX,
              authored.y - d.origY
            ),
            key
          );
        } else {
          onChangeRef.current(
            nodeId,
            "tracks",
            setSampleManual(cur, d.id, d.frame, authored.x, authored.y),
            key
          );
        }
      } else if (d.kind === "box") {
        const t = cur.tracks.find((tr) => tr.id === d.id);
        if (!t || !canvas) return;
        const pos = samplePos(t, frame, gapFill, smoothRadius, smoothMode);
        const c = toPx(pos.x, pos.y, rect);
        const dist = Math.max(
          8,
          Math.hypot(e.clientX - rect.left - c.x, e.clientY - rect.top - c.y)
        );
        const canvasPx = dist * (canvas.width / rect.width);
        const size = oddSize(canvasPx * 2, 31);
        if (d.which === "pattern") {
          onChangeRef.current(
            nodeId,
            "tracks",
            updateTrack(cur, d.id, { patternW: size, patternH: size }),
            key
          );
        } else {
          onChangeRef.current(
            nodeId,
            "tracks",
            updateTrack(cur, d.id, {
              searchW: Math.max(size, t.patternW + 8),
              searchH: Math.max(size, t.patternH + 8),
            }),
            key
          );
        }
      }
    };
    const onUp = () => setDrag(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [rect, canvas, nodeId, frame, gapFill, smoothRadius, smoothMode]);

  if (!rect) return null;

  const showLoupe =
    (placeMode && cursor) ||
    (drag && (drag.kind === "anchor" || drag.kind === "box") && cursor);
  const patternDefault = oddSize(params.pattern_size, 31);

  const onPlace = (e: ReactPointerEvent) => {
    if (!placeMode) return;
    if ((e.target as Element).closest("[data-trk-handle]")) return;
    e.preventDefault();
    e.stopPropagation();
    claimPointerGesture(e.pointerId);
    const authored = fromPx(e.clientX - rect.left, e.clientY - rect.top, rect);
    const search = oddSize(params.search_size, 61);
    const next = addTrack(data, { frame, x: authored.x, y: authored.y }, {
      patternW: patternDefault,
      patternH: patternDefault,
      searchW: Math.max(search, patternDefault + 8),
      searchH: Math.max(search, patternDefault + 8),
    });
    const newId = next.nextId - 1;
    onParamChange(nodeId, "tracks", next);
    setTrackerSelection(nodeId, [newId]);
    if (!e.shiftKey) onParamChange(nodeId, "place_mode", false);
  };

  const onWheel = (e: ReactWheelEvent) => {
    if (!e.metaKey && !e.ctrlKey) return;
    if (!placeMode && !drag) return;
    e.preventDefault();
    const dir = e.deltaY > 0 ? -1 : 1;
    setLoupeZoom((z) => Math.max(2, Math.min(16, z + dir)));
  };

  return (
    <div
      style={{
        position: "fixed",
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        zIndex: 2,
        pointerEvents: placeMode ? "auto" : "none",
        cursor: placeMode ? "none" : "default",
      }}
      onPointerDown={placeMode ? onPlace : undefined}
      onPointerMove={(e) =>
        setCursor({ x: e.clientX - rect.left, y: e.clientY - rect.top })
      }
      onPointerLeave={() => {
        if (!drag) setCursor(null);
      }}
      onWheel={onWheel}
    >
      <svg
        width={rect.width}
        height={rect.height}
        style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "none" }}
      >
        {data.tracks.map((t, index) => {
          const selected = selectedIds.includes(t.id);
          const color = trackColor(index);
          const dim = selectedIds.length > 0 && !selected;
          const opacity = dim ? 0.35 : 1;
          const pos = samplePos(t, frame, gapFill, smoothRadius, smoothMode);
          const c = toPx(pos.x, pos.y, rect);
          const canvasW = canvas?.width || rect.width;
          const pxPerCanvas = rect.width / canvasW;
          const patternR = (t.patternW / 2) * pxPerCanvas;
          const searchR = (t.searchW / 2) * pxPerCanvas;
          const smoothed =
            smoothRadius > 0 ? smoothTrack(t, smoothRadius, smoothMode) : null;
          const dotStep = t.frames.length > 2000 ? Math.ceil(t.frames.length / 2000) : 1;
          const rawPts = t.frames.map((_, i) =>
            toPx(t.x[i]! + t.offset[0], t.y[i]! + t.offset[1], rect)
          );
          const smoothPts = smoothed
            ? t.frames.map((_, i) =>
                toPx(
                  (smoothed.x[i] ?? t.x[i]!) + t.offset[0],
                  (smoothed.y[i] ?? t.y[i]!) + t.offset[1],
                  rect
                )
              )
            : null;
          return (
            <g key={t.id} opacity={opacity}>
              {rawPts.length > 1 && (
                <polyline
                  fill="none"
                  stroke={color}
                  strokeWidth={1.25}
                  points={rawPts.map((p) => `${p.x},${p.y}`).join(" ")}
                />
              )}
              {smoothPts && smoothPts.length > 1 && (
                <polyline
                  fill="none"
                  stroke={color}
                  strokeWidth={0.75}
                  opacity={0.7}
                  points={smoothPts.map((p) => `${p.x},${p.y}`).join(" ")}
                />
              )}
              {rawPts.map((p, i) => {
                if (i % dotStep !== 0) return null;
                const st = t.status[i] ?? 0;
                const fill = STATUS_FILL[st] || color;
                const hollow = st === 3;
                return (
                  <circle
                    key={t.frames[i]}
                    data-trk-handle="1"
                    cx={p.x}
                    cy={p.y}
                    r={3}
                    fill={hollow ? "none" : fill}
                    stroke={st === 3 ? "#fbbf24" : "#000"}
                    strokeWidth={0.75}
                    style={{ pointerEvents: "auto", cursor: "grab" }}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      claimPointerGesture(e.pointerId);
                      if (e.altKey) {
                        onParamChange(
                          nodeId,
                          "tracks",
                          removeSample(data, t.id, t.frames[i]!)
                        );
                        return;
                      }
                      toggleTrackerSelection(nodeId, t.id, e.shiftKey || e.metaKey);
                      setDrag({
                        kind: "sample",
                        id: t.id,
                        frame: t.frames[i]!,
                        shift: e.shiftKey,
                        start: data,
                        origX: t.x[i]! + t.offset[0],
                        origY: t.y[i]! + t.offset[1],
                      });
                    }}
                  />
                );
              })}
              {/* Anchor */}
              <g
                data-trk-handle="1"
                style={{ pointerEvents: "auto", cursor: selected ? "grab" : "pointer" }}
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  claimPointerGesture(e.pointerId);
                  toggleTrackerSelection(nodeId, t.id, e.shiftKey || e.metaKey);
                  if (selected || selectedIds.length === 0) {
                    setDrag({ kind: "anchor", id: t.id });
                  }
                }}
              >
                <line x1={c.x - 8} y1={c.y} x2={c.x + 8} y2={c.y} stroke={color} strokeWidth={1.5} />
                <line x1={c.x} y1={c.y - 8} x2={c.x} y2={c.y + 8} stroke={color} strokeWidth={1.5} />
                <circle cx={c.x} cy={c.y} r={5} fill="none" stroke={color} strokeWidth={1.25} />
              </g>
              {selected && (
                <>
                  <rect
                    x={c.x - patternR}
                    y={c.y - patternR}
                    width={patternR * 2}
                    height={patternR * 2}
                    fill="none"
                    stroke={color}
                    strokeWidth={1}
                  />
                  <rect
                    x={c.x - searchR}
                    y={c.y - searchR}
                    width={searchR * 2}
                    height={searchR * 2}
                    fill="none"
                    stroke={color}
                    strokeDasharray="3 3"
                    strokeWidth={1}
                    opacity={0.8}
                  />
                  <rect
                    data-trk-handle="1"
                    x={c.x + patternR - 4}
                    y={c.y + patternR - 4}
                    width={8}
                    height={8}
                    fill={color}
                    style={{ pointerEvents: "auto", cursor: "nwse-resize" }}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      claimPointerGesture(e.pointerId);
                      setDrag({ kind: "box", id: t.id, which: "pattern" });
                    }}
                  />
                  <rect
                    data-trk-handle="1"
                    x={c.x + searchR - 4}
                    y={c.y + searchR - 4}
                    width={8}
                    height={8}
                    fill={color}
                    opacity={0.7}
                    style={{ pointerEvents: "auto", cursor: "nwse-resize" }}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      claimPointerGesture(e.pointerId);
                      setDrag({ kind: "box", id: t.id, which: "search" });
                    }}
                  />
                </>
              )}
            </g>
          );
        })}
        {placeMode && cursor && (
          <circle
            cx={cursor.x}
            cy={cursor.y}
            r={10}
            fill="none"
            stroke="#60a5fa"
            strokeWidth={1.5}
          />
        )}
      </svg>
      {showLoupe && cursor && (
        <Loupe
          previewCanvas={canvas}
          rect={rect}
          x={cursor.x}
          y={cursor.y}
          zoom={loupeZoom}
          patternPx={
            drag?.kind === "box" && drag.which === "pattern"
              ? (data.tracks.find((t) => t.id === drag.id)?.patternW ?? patternDefault)
              : patternDefault
          }
        />
      )}
    </div>
  );
}

function samplePos(
  t: PointTrackerData["tracks"][number],
  frame: number,
  gapFill: "hold" | "interpolate",
  smoothRadius: number,
  smoothMode: "gaussian" | "savgol"
) {
  const smoothed = smoothRadius > 0 ? smoothTrack(t, smoothRadius, smoothMode) : undefined;
  const s = sampleTrackAtFrame(t, frame, gapFill, smoothed);
  return {
    x: s?.x ?? t.ref.x + t.offset[0],
    y: s?.y ?? t.ref.y + t.offset[1],
  };
}

export default TrackerOverlayAtTick;
