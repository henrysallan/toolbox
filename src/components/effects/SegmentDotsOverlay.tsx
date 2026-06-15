"use client";

import { useEffect, useRef, useState } from "react";
import type { SegmentDot } from "@/lib/ai/segment";

// Click-to-place prompt dots for the Segment Anything node. Mounted while
// a segment node is selected (same gating as the spline pen overlay).
//
// Click empty canvas → add a dot (another object joins the selection).
// Click an existing dot → remove it. While a bake exists the dots are
// LOCKED (editing the prompt under a baked cache would silently desync
// them) — clicks are ignored and the dots render dimmed; the param panel
// explains the Free Bake escape hatch.
//
// Dots live in normalized [0,1]² Y-DOWN image space — the same space as
// DOM pointer math over the canvas rect AND the upstream PNG's pixels, so
// no flips or aspect correction anywhere in the chain.

const HIT_RADIUS_PX = 10;

interface Props {
  canvas: HTMLCanvasElement | null;
  dots: SegmentDot[];
  locked: boolean;
  onChange: (next: SegmentDot[]) => void;
}

export default function SegmentDotsOverlay({
  canvas,
  dots,
  locked,
  onChange,
}: Props) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);

  // Track the preview canvas's on-screen rect (pan/zoom/resize all land
  // here via the resize + scroll listeners — same pattern as PointsOverlay,
  // with the initial measure deferred to a rAF so the effect body itself
  // doesn't set state).
  useEffect(() => {
    const update = () =>
      setRect(canvas ? canvas.getBoundingClientRect() : null);
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

  // Draw the dots.
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

    const tau = Math.PI * 2;
    for (const d of dots) {
      const x = d.x * cssW;
      const y = d.y * cssH;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, tau);
      ctx.fillStyle = locked
        ? "rgba(74, 222, 128, 0.4)"
        : "rgba(74, 222, 128, 0.9)";
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = locked ? "rgba(255,255,255,0.4)" : "#ffffff";
      ctx.stroke();
      // Center pip so the exact prompt pixel is readable.
      ctx.beginPath();
      ctx.arc(x, y, 1.2, 0, tau);
      ctx.fillStyle = locked ? "rgba(10,10,10,0.4)" : "#0a0a0a";
      ctx.fill();
    }
  }, [rect, dots, locked]);

  if (!rect) return null;

  return (
    <canvas
      ref={overlayRef}
      onPointerDown={(e) => {
        if (locked) return;
        if (e.button !== 0) return;
        const x = (e.clientX - rect.left) / rect.width;
        const y = (e.clientY - rect.top) / rect.height;
        if (x < 0 || x > 1 || y < 0 || y > 1) return;
        // Hit-test existing dots in CSS pixels — click one to remove it.
        for (let i = 0; i < dots.length; i++) {
          const dx = (dots[i].x - x) * rect.width;
          const dy = (dots[i].y - y) * rect.height;
          if (dx * dx + dy * dy <= HIT_RADIUS_PX * HIT_RADIUS_PX) {
            onChange(dots.filter((_, j) => j !== i));
            return;
          }
        }
        onChange([...dots, { x, y }]);
      }}
      style={{
        position: "fixed",
        pointerEvents: locked ? "none" : "auto",
        cursor: "crosshair",
        zIndex: 3,
      }}
    />
  );
}
