"use client";

import { useEffect, useRef } from "react";

// Global custom cursor: a white ring that follows the mouse, lerps
// slightly smaller and gains a soft glow + center dot when the
// pointer is over something clickable. Renders via a fixed-position
// div on top of every other UI surface; pointer-events: none keeps
// it transparent to interaction.
//
// Only enabled on real mouse pointers — touch / pen devices use the
// native cursor (or none at all).

const RING_BASE = 16; // diameter at rest
const RING_HOVER = 13; // diameter when over a clickable
const DOT_SIZE = 3; // diameter of the inner hover dot
const LERP_POS = 0.45; // pos lerp per frame — high so it tracks tightly
const LERP_SHAPE = 0.22; // size / glow lerp per frame — slower for a soft feel

// Two-tier hover detection.
// "strong" → an actual click / drag target (button, input, socket, …):
//            ring shrinks + glows AND the center dot fades in.
// "soft"   → a broader interactive surface (a node body, an edge):
//            ring shrinks + glows, no dot.
// "none"   → resting cursor.
type HoverTier = "none" | "soft" | "strong";

function hoverTier(start: HTMLElement | null): HoverTier {
  let cur: HTMLElement | null = start;
  let depth = 0;
  // Track the best tier seen so far — strong wins as soon as we
  // encounter it, soft is held in case nothing stronger sits above.
  let best: HoverTier = "none";
  while (cur && depth < 8) {
    const tag = cur.tagName;
    if (
      tag === "BUTTON" ||
      tag === "A" ||
      tag === "SELECT" ||
      tag === "SUMMARY" ||
      tag === "LABEL" ||
      // Form controls — sliders (range), number inputs, color pickers,
      // checkboxes, text fields, textareas. Treat them all as click
      // / drag targets.
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "OPTION"
    )
      return "strong";
    const role = cur.getAttribute("role");
    if (
      role === "button" ||
      role === "link" ||
      role === "tab" ||
      role === "menuitem" ||
      role === "slider" ||
      role === "checkbox" ||
      role === "switch" ||
      role === "radio" ||
      role === "spinbutton" ||
      role === "combobox" ||
      role === "option"
    )
      return "strong";
    const cls = cur.classList;
    if (cls) {
      // Sockets are real click targets — strong tier even though
      // they live inside a node.
      if (cls.contains("react-flow__handle")) return "strong";
      // Node bodies + edges are the broader "interactive surface" —
      // soft tier. Don't return immediately: a stronger element
      // (button, input, …) might still sit above us in the chain.
      if (
        cls.contains("react-flow__node") ||
        cls.contains("react-flow__edge") ||
        cls.contains("react-flow__edge-interaction") ||
        cls.contains("react-flow__edge-path")
      ) {
        if (best === "none") best = "soft";
      }
    }
    // Author-declared cursor → strong. We can't trust
    // getComputedStyle here because the global override sets
    // `cursor: none !important` on every element; that wins the
    // cascade and computed always reports "none". The inline style
    // (set via React's `style={{ cursor: ... }}`) bypasses the
    // cascade entirely, so it's the reliable signal for things like
    // the on-canvas TransformGizmo handles, which mark themselves
    // with cursors like ew-resize / ns-resize / grab / move.
    const inline = (cur as HTMLElement).style?.cursor;
    if (inline && inline !== "" && inline !== "none" && inline !== "default") {
      return "strong";
    }
    cur = cur.parentElement;
    depth++;
  }
  return best;
}

export default function CustomCursor() {
  const ringRef = useRef<HTMLDivElement | null>(null);
  const dotRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let raf = 0;
    let mounted = true;
    let visible = false;
    let touchSeen = false;

    // glow drives ring shrink + halo (fires on both soft and strong);
    // dot drives the inner dot (fires only on strong).
    const target = { x: 0, y: 0, size: RING_BASE, glow: 0, dot: 0 };
    const cur = { x: 0, y: 0, size: RING_BASE, glow: 0, dot: 0 };
    let initialized = false;

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType === "touch" || e.pointerType === "pen") {
        touchSeen = true;
        visible = false;
        return;
      }
      if (touchSeen) return;
      if (!initialized) {
        cur.x = e.clientX;
        cur.y = e.clientY;
        initialized = true;
      }
      target.x = e.clientX;
      target.y = e.clientY;
      visible = true;
      const el = document.elementFromPoint(
        e.clientX,
        e.clientY
      ) as HTMLElement | null;
      const tier = hoverTier(el);
      const hovering = tier !== "none";
      target.size = hovering ? RING_HOVER : RING_BASE;
      target.glow = hovering ? 1 : 0;
      target.dot = tier === "strong" ? 1 : 0;
    };

    const onLeave = () => {
      visible = false;
    };

    const tick = () => {
      if (!mounted) return;
      cur.x += (target.x - cur.x) * LERP_POS;
      cur.y += (target.y - cur.y) * LERP_POS;
      cur.size += (target.size - cur.size) * LERP_SHAPE;
      cur.glow += (target.glow - cur.glow) * LERP_SHAPE;
      cur.dot += (target.dot - cur.dot) * LERP_SHAPE;
      const r = ringRef.current;
      const d = dotRef.current;
      if (r) {
        const s = cur.size;
        r.style.transform = `translate3d(${cur.x - s / 2}px, ${cur.y - s / 2}px, 0)`;
        r.style.width = `${s}px`;
        r.style.height = `${s}px`;
        const g = cur.glow;
        // Soft outer halo + a tighter inner halo so the boundary
        // stays crisp at small sizes when the outer halo bleeds in.
        r.style.boxShadow =
          g > 0.001
            ? `0 0 ${8 + g * 10}px rgba(255,255,255,${0.3 * g}), 0 0 ${
                1.5 + g * 3
              }px rgba(255,255,255,${0.5 * g})`
            : "none";
        r.style.opacity = visible && !touchSeen ? "1" : "0";
      }
      if (d) {
        const dt = cur.dot;
        d.style.transform = `translate3d(${cur.x - DOT_SIZE / 2}px, ${
          cur.y - DOT_SIZE / 2
        }px, 0) scale(${0.5 + dt * 0.5})`;
        d.style.opacity = `${visible && !touchSeen ? dt : 0}`;
      }
      raf = requestAnimationFrame(tick);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerdown", onPointerMove);
    document.addEventListener("mouseleave", onLeave);
    raf = requestAnimationFrame(tick);
    return () => {
      mounted = false;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerdown", onPointerMove);
      document.removeEventListener("mouseleave", onLeave);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <>
      <div
        ref={ringRef}
        aria-hidden
        style={{
          position: "fixed",
          left: 0,
          top: 0,
          width: RING_BASE,
          height: RING_BASE,
          borderRadius: "50%",
          border: "1px solid rgba(255,255,255,0.95)",
          pointerEvents: "none",
          zIndex: 2147483647,
          opacity: 0,
          willChange: "transform, width, height, box-shadow",
        }}
      />
      <div
        ref={dotRef}
        aria-hidden
        style={{
          position: "fixed",
          left: 0,
          top: 0,
          width: DOT_SIZE,
          height: DOT_SIZE,
          borderRadius: "50%",
          background: "rgba(255,255,255,0.95)",
          pointerEvents: "none",
          zIndex: 2147483647,
          opacity: 0,
          willChange: "transform, opacity",
        }}
      />
    </>
  );
}
