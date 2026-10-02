"use client";

import { useEffect, useRef, useState } from "react";
import { claimPointerGesture } from "@/lib/pointer-claim";
import { advancePickCycle, type PickCycle } from "@/lib/viewport-pick";
import { rectsEqual } from "./overlay-rect";

// Viewport pick-select tool (src/lib/viewport-pick.ts does the inference).
// While on, a click on the preview canvas selects the pickable node that
// drew that pixel; clicking again at the same spot cycles down through
// whatever else is stacked there. Esc, Shift+V or the chip turns it off.
//
// The overlay covers only the canvas box and sits above the gizmos
// (zIndex 2) and rulers (3) but below the Track Editor dock (5), so a pick
// click never starts a gizmo drag. Wheel pan/zoom listens on window and
// middle-drag is left alone, so navigation still works while it is on.

interface OverlayProps {
  canvas: HTMLCanvasElement | null;
  // Changes whenever pan/zoom moves the canvas — a CSS transform fires no
  // ResizeObserver, so the owner passes this to force a re-measure.
  layoutKey: string;
  // Pickable node ids under the click (canvas UV, Y-down), topmost first.
  pick: (u: number, v: number) => string[];
  onPick: (nodeId: string) => void;
  labelFor: (nodeId: string) => string;
  onExit: () => void;
}

interface Tag {
  x: number;
  y: number;
  text: string;
  miss: boolean;
}

export function ViewportPickOverlay({
  canvas,
  layoutKey,
  pick,
  onPick,
  labelFor,
  onExit,
}: OverlayProps) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [tag, setTag] = useState<Tag | null>(null);
  const cycleRef = useRef<PickCycle | null>(null);
  const tagTimerRef = useRef(0);

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
  }, [canvas, layoutKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable='true']")) {
        return;
      }
      onExit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onExit]);

  useEffect(() => () => window.clearTimeout(tagTimerRef.current), []);

  if (!rect) return null;

  const showTag = (next: Tag) => {
    setTag(next);
    window.clearTimeout(tagTimerRef.current);
    tagTimerRef.current = window.setTimeout(() => setTag(null), 1400);
  };

  return (
    <div
      onPointerDown={(e) => {
        if (e.button !== 0 || !canvas) return;
        // A pick click is not a cursor press for the graph.
        claimPointerGesture(e.pointerId);
        e.preventDefault();
        // Measure at click time: pan/zoom may have moved the canvas since
        // the last layout pass.
        const r = canvas.getBoundingClientRect();
        const u = (e.clientX - r.left) / r.width;
        const v = (e.clientY - r.top) / r.height;
        if (u < 0 || u > 1 || v < 0 || v > 1) return;
        const hits = pick(u, v);
        const next = advancePickCycle(
          cycleRef.current,
          e.clientX,
          e.clientY,
          hits
        );
        cycleRef.current = next;
        const lx = e.clientX - rect.left;
        const ly = e.clientY - rect.top;
        if (!next) {
          showTag({ x: lx, y: ly, text: "Nothing pickable here", miss: true });
          return;
        }
        const id = next.hits[next.index]!;
        onPick(id);
        showTag({
          x: lx,
          y: ly,
          text:
            next.hits.length > 1
              ? `${labelFor(id)} · ${next.index + 1}/${next.hits.length}`
              : labelFor(id),
          miss: false,
        });
      }}
      style={{
        position: "fixed",
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        pointerEvents: "auto",
        cursor: "crosshair",
        zIndex: 4,
      }}
    >
      {tag && (
        <div
          style={{
            position: "absolute",
            left: tag.x + 12,
            top: tag.y + 12,
            padding: "2px 6px",
            borderRadius: 3,
            background: "var(--tb-n-2)",
            border: "1px solid var(--tb-n-7)",
            color: tag.miss ? "var(--tb-n-12)" : "var(--tb-n-16)",
            font: "11px/15px var(--font-sans, sans-serif)",
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
        >
          {tag.text}
        </div>
      )}
    </div>
  );
}

/**
 * Pick-select switch — leftmost of the viewport menu bar's view/interaction
 * chips, same 19×17 chrome. The glyph is a plain arrow cursor: the select
 * tool, as in every drawing app. Shift+V toggles it too.
 */
export function ViewportPickToggle({
  on,
  onToggle,
}: {
  on: boolean;
  onToggle: () => void;
}) {
  const stroke = on ? "var(--tb-n-16)" : "var(--tb-n-11)";
  return (
    <button
      onClick={onToggle}
      aria-pressed={on}
      title={
        on
          ? "Pick select on (Shift+V) — click the canvas to select the node that drew it; click again to cycle through stacked nodes. Esc to exit"
          : "Pick select (Shift+V) — click the canvas to select the node that drew it"
      }
      style={{
        width: 19,
        height: 17,
        padding: 0,
        display: "grid",
        placeItems: "center",
        boxSizing: "border-box",
        background: on ? "var(--tb-n-5)" : "var(--tb-n-3)",
        border: `1px solid ${on ? "var(--tb-n-9)" : "var(--tb-n-7)"}`,
        borderRadius: 3,
        cursor: "pointer",
      }}
    >
      <svg width={11} height={11} viewBox="0 0 11 11" aria-hidden>
        <path
          d="M2.5 1 L2.5 9.2 L4.6 7.3 L6.1 10.4 L7.4 9.8 L5.9 6.8 L8.7 6.6 Z"
          fill={on ? stroke : "none"}
          stroke={stroke}
          strokeWidth={0.9}
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
