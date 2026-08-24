"use client";

import { useEffect, useRef } from "react";

// Magnifier over the preview canvas. Shown in place mode and while dragging
// an anchor. Copies pixels from the 2D preview canvas (no GL readback).
// Spec: 082226_motion-tracking.md §8.2.

const SIZE = 160;

interface Props {
  previewCanvas: HTMLCanvasElement | null;
  rect: DOMRect;
  // Cursor in CSS pixels relative to the overlay (0..rect.width).
  x: number;
  y: number;
  zoom: number;
  // Pattern box half-size in preview-canvas pixels (for the outline).
  patternPx?: number;
}

export default function Loupe({
  previewCanvas,
  rect,
  x,
  y,
  zoom,
  patternPx = 31,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const c = canvasRef.current;
    const src = previewCanvas;
    if (!c || !src || src.width < 1 || src.height < 1) return;
    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(SIZE * dpr);
    if (c.width !== px) c.width = px;
    if (c.height !== px) c.height = px;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);

    const srcX = (x / rect.width) * src.width;
    const srcY = (y / rect.height) * src.height;
    const sw = SIZE / zoom;
    const sh = SIZE / zoom;
    ctx.drawImage(src, srcX - sw / 2, srcY - sh / 2, sw, sh, 0, 0, SIZE, SIZE);

    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(SIZE / 2, 0);
    ctx.lineTo(SIZE / 2, SIZE);
    ctx.moveTo(0, SIZE / 2);
    ctx.lineTo(SIZE, SIZE / 2);
    ctx.stroke();

    const box = (patternPx * zoom * (rect.width / src.width));
    if (box > 4 && box < SIZE - 4) {
      ctx.strokeStyle = "rgba(96,165,250,0.9)";
      ctx.strokeRect(SIZE / 2 - box / 2, SIZE / 2 - box / 2, box, box);
    }
  }, [previewCanvas, rect, x, y, zoom, patternPx]);

  const flipX = x + 12 + SIZE > rect.width;
  const flipY = y + 12 + SIZE > rect.height;
  const left = flipX ? x - 12 - SIZE : x + 12;
  const top = flipY ? y - 12 - SIZE : y + 12;

  return (
    <canvas
      ref={canvasRef}
      width={SIZE}
      height={SIZE}
      style={{
        position: "absolute",
        left,
        top,
        width: SIZE,
        height: SIZE,
        pointerEvents: "none",
        border: "1px solid var(--tb-n-9)",
        borderRadius: 2,
        background: "#000",
        zIndex: 3,
      }}
    />
  );
}
