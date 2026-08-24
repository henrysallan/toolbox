"use client";

import { useEffect, useRef, useState } from "react";
import { KEYER_MAX_SAMPLES } from "@/nodes/effect/keyer";
import { rectsEqual } from "./overlay-rect";
import { claimPointerGesture } from "@/lib/pointer-claim";

// Draw-to-sample overlay for the Keyer node's `sample` mode. Mounted while
// a Keyer in sample mode is selected (same gating as SegmentDotsOverlay).
//
// Drag across the preview canvas and every distinct color under the cursor
// is appended to the node's hidden `sample_colors` param — the shader keys
// pixels near ANY sampled color, so scrubbing a backdrop's shadows and
// highlights builds the whole selection in one stroke. Param writes are
// rAF-throttled during the drag so the keyed preview tracks the stroke
// live; the 700ms undo-coalesce window folds a stroke into one entry.
//
// Colors are read from the Keyer's INPUT image (not the keyed preview) via
// `getSourcePixels` — EffectsApp reads the upstream node's last eval output
// with readImagePixels, downsampled. Captured once per stroke: colors are
// frozen at draw time, which is the point of a color-range key (the range
// then tracks a moving video). Pixel rows are ImageData order (row 0 = top,
// Y-DOWN), the same space as the DOM pointer math — no flips.

export interface KeyerSourcePixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

// Minimum RGB distance (0..1 channels) between kept samples. Dedupes the
// near-identical colors a slow scrub yields, so the 64-slot set spends its
// capacity on the selection's actual spread.
const MIN_SAMPLE_DIST = 0.05;
const MIN_SAMPLE_DIST2 = MIN_SAMPLE_DIST * MIN_SAMPLE_DIST;

interface Stroke {
  px: KeyerSourcePixels;
  colors: string[];        // working set, seeded from props at stroke start
  rgb: number[];           // flat 0..1 triples mirroring `colors`
  dirty: boolean;
}

interface Props {
  canvas: HTMLCanvasElement | null;
  colors: string[];
  onChange: (next: string[]) => void;
  getSourcePixels: () => KeyerSourcePixels | null;
}

export default function KeyerSampleOverlay({
  canvas,
  colors,
  onChange,
  getSourcePixels,
}: Props) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [stroking, setStroking] = useState(false);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const strokeRef = useRef<Stroke | null>(null);
  const rafRef = useRef(0);

  // Track the preview canvas's on-screen rect (pan/zoom/resize) — same
  // pattern as SegmentDotsOverlay.
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

  // Cursor ring + sample count while a stroke is filling up.
  useEffect(() => {
    const c = overlayRef.current;
    if (!c || !rect) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = rect.width;
    const cssH = rect.height;
    const pxW = Math.max(1, Math.round(cssW * dpr));
    const pxH = Math.max(1, Math.round(cssH * dpr));
    if (c.width !== pxW) c.width = pxW;
    if (c.height !== pxH) c.height = pxH;
    c.style.width = `${cssW}px`;
    c.style.height = `${cssH}px`;
    c.style.left = `${rect.left}px`;
    c.style.top = `${rect.top}px`;

    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    if (!cursor) return;

    const x = cursor.x * cssW;
    const y = cursor.y * cssH;
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(10,10,10,0.6)";
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = stroking ? "#4ade80" : "#ffffff";
    ctx.stroke();
    if (stroking && strokeRef.current) {
      const n = strokeRef.current.colors.length;
      ctx.font = "10px sans-serif";
      ctx.fillStyle = "rgba(10,10,10,0.7)";
      ctx.fillText(`${n}/${KEYER_MAX_SAMPLES}`, x + 13, y + 4);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(`${n}/${KEYER_MAX_SAMPLES}`, x + 12, y + 3);
    }
  }, [rect, cursor, stroking]);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  if (!rect) return null;

  const flush = () => {
    const s = strokeRef.current;
    if (s && s.dirty) {
      s.dirty = false;
      onChange([...s.colors]);
    }
  };

  const scheduleFlush = () => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(flush);
  };

  const sampleAt = (u: number, v: number) => {
    const s = strokeRef.current;
    if (!s || s.colors.length >= KEYER_MAX_SAMPLES) return;
    if (u < 0 || u > 1 || v < 0 || v > 1) return; // captured drag left the canvas
    const { data, width, height } = s.px;
    const x = Math.max(0, Math.min(width - 1, Math.floor(u * width)));
    const y = Math.max(0, Math.min(height - 1, Math.floor(v * height)));
    const i = (y * width + x) * 4;
    if (data[i + 3] < 32) return; // transparent — no meaningful color
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    for (let k = 0; k < s.rgb.length; k += 3) {
      const dr = r - s.rgb[k];
      const dg = g - s.rgb[k + 1];
      const db = b - s.rgb[k + 2];
      if (dr * dr + dg * dg + db * db < MIN_SAMPLE_DIST2) return;
    }
    const hex =
      "#" +
      data[i].toString(16).padStart(2, "0") +
      data[i + 1].toString(16).padStart(2, "0") +
      data[i + 2].toString(16).padStart(2, "0");
    s.colors.push(hex);
    s.rgb.push(r, g, b);
    s.dirty = true;
    scheduleFlush();
  };

  const toUv = (e: React.PointerEvent) => ({
    x: (e.clientX - rect.left) / rect.width,
    y: (e.clientY - rect.top) / rect.height,
  });

  return (
    <canvas
      ref={overlayRef}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const px = getSourcePixels();
        if (!px) return; // nothing wired upstream yet
        // Sampling stroke — keep it out of the graph's cursor press facts.
        claimPointerGesture(e.pointerId);
        const seed = colors.filter((c) => typeof c === "string");
        strokeRef.current = {
          px,
          colors: [...seed],
          rgb: seed.flatMap((hex) => {
            const n = parseInt(hex.replace("#", ""), 16);
            return [
              ((n >> 16) & 0xff) / 255,
              ((n >> 8) & 0xff) / 255,
              (n & 0xff) / 255,
            ];
          }),
          dirty: false,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
        setStroking(true);
        const { x, y } = toUv(e);
        setCursor({ x, y });
        sampleAt(x, y);
      }}
      onPointerMove={(e) => {
        const { x, y } = toUv(e);
        setCursor(
          x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null
        );
        if (strokeRef.current && stroking) sampleAt(x, y);
      }}
      onPointerUp={() => {
        cancelAnimationFrame(rafRef.current);
        flush();
        strokeRef.current = null;
        setStroking(false);
      }}
      onPointerLeave={() => {
        if (!stroking) setCursor(null);
      }}
      style={{
        position: "fixed",
        pointerEvents: "auto",
        cursor: "none",
        zIndex: 3,
      }}
    />
  );
}
