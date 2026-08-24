"use client";

import { useEffect, useRef, useState } from "react";
import type { PointsValue } from "@/engine/types";
import { aspectCorrectY } from "@/engine/aspect";
import { TRACK_PALETTE } from "@/engine/tracking/sample";
import { rectsEqual } from "./overlay-rect";

// Read-only visualization for a points value. Renders dots via a single
// canvas2D draw over the preview canvas — no per-point JSX/SVG
// reconciliation, so the cost stays flat as the point count grows.
//
// Reads `positions: Float32Array` directly off PointsValue to avoid
// materializing a lazy `Point[]` view every frame (which would alloc N
// objects per animated frame). Positions are normalized [0,1]² Y-DOWN.

interface Props {
  canvas: HTMLCanvasElement | null;
  // Pass the typed-array points value directly; we read positions from
  // its Float32Array. `null` hides the overlay.
  value: PointsValue | null;
}

export default function PointsOverlay({ canvas, value }: Props) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!canvas) {
      setRect((prev) => (prev === null ? prev : null));
      return;
    }
    // Guard against a ResizeObserver feedback loop — see overlay-rect.ts.
    const update = () => {
      const r = canvas.getBoundingClientRect();
      setRect((prev) => (rectsEqual(prev, r) ? prev : r));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(canvas);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [canvas]);

  useEffect(() => {
    const c = overlayRef.current;
    if (!c || !rect || !value) return;
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
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 0.75;

    const pos = value.positions;
    const n = value.count;
    const groups = value.groupIndices;
    const r = 3;
    const tau = Math.PI * 2;
    // Match the rasterizers' aspect correction so dots sit on the rendered
    // geometry (e.g. points along a spline) on a non-square canvas.
    const aspect = cssW / cssH;
    for (let i = 0; i < n; i++) {
      const x = pos[i * 2] * cssW;
      const y = aspectCorrectY(pos[i * 2 + 1], aspect) * cssH;
      if (groups) {
        const g = groups[i] ?? i;
        ctx.fillStyle =
          TRACK_PALETTE[((g % TRACK_PALETTE.length) + TRACK_PALETTE.length) % TRACK_PALETTE.length]!;
      }
      ctx.beginPath();
      ctx.arc(x, y, r, 0, tau);
      ctx.fill();
      ctx.stroke();
    }
  }, [rect, value]);

  if (!rect) return null;

  return (
    <canvas
      ref={overlayRef}
      style={{
        position: "fixed",
        pointerEvents: "none",
        zIndex: 2,
      }}
    />
  );
}
