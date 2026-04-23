"use client";

import { useEffect, useState } from "react";
import type { Point } from "@/engine/types";

// Read-only visualization for a points value. Renders a small white dot at
// every point's position over the preview canvas — the same way the spline
// editor renders anchor dots — so you can see what a Point / Scatter
// Points / Copy-to-Points node actually emitted.
//
// Positions are normalized [0,1]² Y-DOWN, matching every other overlay in
// this app. The SVG sits in fixed position over the canvas's bounding
// rect; a ResizeObserver keeps the rect fresh through splitter drags.

interface Props {
  canvas: HTMLCanvasElement | null;
  points: Point[];
}

export default function PointsOverlay({ canvas, points }: Props) {
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!canvas) {
      setRect(null);
      return;
    }
    const update = () => setRect(canvas.getBoundingClientRect());
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

  if (!rect) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: 45,
      }}
    >
      <svg
        width="100%"
        height="100%"
        style={{
          position: "absolute",
          inset: 0,
          overflow: "visible",
          pointerEvents: "none",
        }}
      >
        {points.map((pt, i) => {
          const cx = rect.left + pt.pos[0] * rect.width;
          const cy = rect.top + pt.pos[1] * rect.height;
          return (
            <circle
              key={i}
              cx={cx}
              cy={cy}
              r={3}
              fill="#ffffff"
              stroke="#000"
              strokeWidth={0.75}
            />
          );
        })}
      </svg>
    </div>
  );
}
