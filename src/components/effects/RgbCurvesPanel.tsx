"use client";

import { useEffect, useRef, useState } from "react";
import type { Node } from "@xyflow/react";
import type { NodeDataPayload } from "@/state/graph";
import {
  type CurveChannel,
  type CurvesValue,
  computeMonotoneTangents,
  defaultCurveChannel,
  defaultCurvesValue,
  evalMonotoneCubic,
  newCurvePointId,
  sanitizeCurvesValue,
} from "@/nodes/effect/color-correction";

// Full-panel RGB Curves editor. The main mode edits the combined RGB curve;
// the R / G / B tabs switch to the individual channel curves. The editor
// fills the parameters panel and resizes with it. Interactions:
//   • double-click  → add a point
//   • drag          → move (clamped to 0..1 on both axes)
//   • right-click   → remove a point (min 2 kept)

interface Props {
  node: Node<NodeDataPayload>;
  onParamChange: (nodeId: string, paramName: string, value: unknown) => void;
}

const CHANNELS: CurveChannel[] = ["rgb", "r", "g", "b"];
const COLORS: Record<CurveChannel, string> = {
  rgb: "var(--tb-n-16)",
  r: "var(--tb-a-red-500)",
  g: "var(--tb-a-green-500)",
  b: "var(--tb-a-blue-500)",
};
const LABELS: Record<CurveChannel, string> = {
  rgb: "RGB",
  r: "R",
  g: "G",
  b: "B",
};
// Inset so points sitting on the 0 / 1 edges are still grabbable.
const PAD = 10;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export default function RgbCurvesPanel({ node, onParamChange }: Props) {
  const curves = sanitizeCurvesValue(node.data.params.curves);
  const [activeCh, setActiveCh] = useState<CurveChannel>("rgb");
  const setCurves = (next: CurvesValue) =>
    onParamChange(node.id, "curves", next);

  const resetBtn: React.CSSProperties = {
    flex: 1,
    padding: "4px 0",
    background: "transparent",
    border: "1px solid var(--tb-n-9)",
    color: "var(--tb-n-13)",
    borderRadius: 4,
    fontFamily: "inherit",
    fontSize: 10,
    cursor: "pointer",
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        gap: 8,
      }}
    >
      {/* Channel toggle: RGB (combined) or an individual R / G / B curve. */}
      <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
        {CHANNELS.map((ch) => {
          const active = ch === activeCh;
          return (
            <button
              key={ch}
              onClick={() => setActiveCh(ch)}
              style={{
                flex: 1,
                padding: "4px 0",
                background: active ? COLORS[ch] : "var(--tb-n-3)",
                color: active ? "var(--tb-n-0)" : COLORS[ch],
                border: `1px solid ${COLORS[ch]}`,
                borderRadius: 4,
                fontFamily: "inherit",
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              {LABELS[ch]}
            </button>
          );
        })}
      </div>

      {/* Editor fills the remaining height. */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <CurveEditor channel={activeCh} curves={curves} onChange={setCurves} />
      </div>

      <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
        <button
          style={resetBtn}
          onClick={() =>
            setCurves({ ...curves, [activeCh]: defaultCurveChannel() })
          }
        >
          reset {LABELS[activeCh]}
        </button>
        <button style={resetBtn} onClick={() => setCurves(defaultCurvesValue())}>
          reset all
        </button>
      </div>
      <div style={{ color: "var(--tb-n-10)", fontSize: 10, flexShrink: 0 }}>
        double-click to add · drag to move · right-click a point to remove
      </div>
    </div>
  );
}

// ========================================================================
// resize-aware curve canvas
// ========================================================================

function CurveEditor({
  channel,
  curves,
  onChange,
}: {
  channel: CurveChannel;
  curves: CurvesValue;
  onChange: (next: CurvesValue) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [dragId, setDragId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Live mirror for the window-level drag handler (set up once per drag) —
  // updated in an effect so the drag closure always sees fresh values
  // without re-binding listeners on every pointermove.
  const liveRef = useRef({ channel, curves, size });
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    liveRef.current = { channel, curves, size };
    onChangeRef.current = onChange;
  });

  // Track the container's pixel size so the SVG fills it and stays crisp.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({
        w: Math.max(0, Math.floor(r.width)),
        h: Math.max(0, Math.floor(r.height)),
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { w, h } = size;
  const points = curves[channel];
  const color = COLORS[channel];

  const dataToPx = (x: number, width: number) => PAD + x * (width - 2 * PAD);
  const dataToPy = (y: number, height: number) =>
    PAD + (1 - y) * (height - 2 * PAD);
  const pxToData = (px: number, py: number, width: number, height: number) => {
    const sx = width - 2 * PAD;
    const sy = height - 2 * PAD;
    return {
      x: clamp01(sx > 0 ? (px - PAD) / sx : 0),
      y: clamp01(sy > 0 ? 1 - (py - PAD) / sy : 0),
    };
  };

  // Drag the active point — clamped 0..1, list re-sorted by x.
  useEffect(() => {
    if (!dragId) return;
    const onMove = (e: PointerEvent) => {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const live = liveRef.current;
      const d = pxToData(
        e.clientX - rect.left,
        e.clientY - rect.top,
        live.size.w,
        live.size.h
      );
      const pts = live.curves[live.channel]
        .map((p) => (p.id === dragId ? { ...p, x: d.x, y: d.y } : p))
        .sort((a, b) => a.x - b.x);
      onChangeRef.current({ ...live.curves, [live.channel]: pts });
    };
    const onUp = () => setDragId(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragId]);

  const tangents = computeMonotoneTangents(points);
  let pathD = "";
  if (w > 0 && h > 0) {
    const SAMPLES = 128;
    const segs: string[] = [];
    for (let i = 0; i <= SAMPLES; i++) {
      const t = i / SAMPLES;
      const y = clamp01(evalMonotoneCubic(points, tangents, t));
      segs.push(
        `${i === 0 ? "M" : "L"} ${dataToPx(t, w).toFixed(2)} ${dataToPy(
          y,
          h
        ).toFixed(2)}`
      );
    }
    pathD = segs.join(" ");
  }

  function addPointAt(clientX: number, clientY: number) {
    const svg = svgRef.current;
    if (!svg || points.length >= 32) return;
    const rect = svg.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    // Ignore double-clicks that land on an existing point (that's a no-op,
    // not a request for a duplicate).
    if (
      points.some(
        (p) =>
          Math.abs(dataToPx(p.x, w) - px) < 8 &&
          Math.abs(dataToPy(p.y, h) - py) < 8
      )
    ) {
      return;
    }
    const d = pxToData(px, py, w, h);
    const id = newCurvePointId();
    const next = [...points, { id, x: d.x, y: d.y }].sort((a, b) => a.x - b.x);
    onChange({ ...curves, [channel]: next });
    setSelectedId(id);
  }

  function removePoint(id: string) {
    if (points.length <= 2) return;
    onChange({ ...curves, [channel]: points.filter((p) => p.id !== id) });
    if (selectedId === id) setSelectedId(null);
  }

  return (
    <div ref={wrapRef} style={{ width: "100%", height: "100%", minHeight: 0 }}>
      {w > 0 && h > 0 && (
        <svg
          ref={svgRef}
          width={w}
          height={h}
          onDoubleClick={(e) => {
            e.preventDefault();
            addPointAt(e.clientX, e.clientY);
          }}
          onContextMenu={(e) => e.preventDefault()}
          style={{
            display: "block",
            background: "var(--tb-n-0)",
            border: "1px solid var(--tb-n-7)",
            borderRadius: 4,
            cursor: "crosshair",
            touchAction: "none",
          }}
        >
          {/* 4×4 grid */}
          {[0, 1, 2, 3, 4].map((i) => {
            const t = i / 4;
            return (
              <g key={i}>
                <line
                  x1={dataToPx(t, w)}
                  y1={dataToPy(0, h)}
                  x2={dataToPx(t, w)}
                  y2={dataToPy(1, h)}
                  stroke="var(--tb-n-3)"
                  strokeWidth={1}
                />
                <line
                  x1={dataToPx(0, w)}
                  y1={dataToPy(t, h)}
                  x2={dataToPx(1, w)}
                  y2={dataToPy(t, h)}
                  stroke="var(--tb-n-3)"
                  strokeWidth={1}
                />
              </g>
            );
          })}
          {/* Identity diagonal */}
          <line
            x1={dataToPx(0, w)}
            y1={dataToPy(0, h)}
            x2={dataToPx(1, w)}
            y2={dataToPy(1, h)}
            stroke="var(--tb-n-7)"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
          {/* Curve */}
          <path d={pathD} stroke={color} strokeWidth={1.5} fill="none" />
          {/* Control points */}
          {points.map((p) => {
            const cx = dataToPx(p.x, w);
            const cy = dataToPy(p.y, h);
            const sel = p.id === selectedId;
            return (
              <circle
                key={p.id}
                cx={cx}
                cy={cy}
                r={sel ? 6 : 5}
                fill={sel ? color : "var(--tb-n-0)"}
                stroke={color}
                strokeWidth={sel ? 2 : 1.5}
                style={{ cursor: "grab", touchAction: "none" }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  setSelectedId(p.id);
                  setDragId(p.id);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  removePoint(p.id);
                }}
                // Don't let a double-click on a point also add a point.
                onDoubleClick={(e) => e.stopPropagation()}
              />
            );
          })}
        </svg>
      )}
    </div>
  );
}
