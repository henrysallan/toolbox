"use client";

import { useEffect, useRef } from "react";

// Global custom cursor: a small crosshair — a center ring with four
// short tick marks (N / S / E / W) — that follows the mouse. The
// ring's center sits exactly at the click hot spot. On hover the
// crosshair gains a soft white halo; on a strong hover (button,
// input, socket) a red dot fades in at the ring's center and the
// halo blooms a touch.
//
// Only enabled on real mouse pointers — touch / pen devices use
// the native cursor (or none at all).

const SCALE_BASE = 1; // scale at rest
const SCALE_HOVER = 0.92; // scale when hovering anything interactive
const LERP_SHAPE = 0.22; // shape lerp per frame — slower for a soft feel

// Crosshair geometry, in a square box CURSOR_SIZE wide. Hot spot is
// the exact center.
const CURSOR_SIZE = 22;
const CENTER = CURSOR_SIZE / 2;
const RING_R = 3.5; // ring radius
const TICK_GAP = 1.5; // gap between ring and the start of each tick
const TICK_LEN = 4; // length of each tick mark
const STROKE_W = 1.1;
const DOT_R = 1.6; // radius of the red hover dot

// Outer SVG canvas needs a touch of padding so the strokes near the
// edge ticks don't get clipped under any edge cases. With overflow:
// visible we don't strictly need this, but it keeps drop-shadow
// filter regions tight and predictable.
const PAD = 2;
const SVG_SIZE = CURSOR_SIZE + PAD * 2;
const SVG_CENTER = SVG_SIZE / 2;
const TICK_INNER = RING_R + TICK_GAP;
const TICK_OUTER = TICK_INNER + TICK_LEN;

// Two-tier hover detection.
// "strong" → an actual click / drag target (button, input, socket, …):
//            crosshair shrinks + glows AND the red dot fades in.
// "soft"   → a broader interactive surface (a node body, an edge):
//            crosshair shrinks + glows, no dot.
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
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const dotRef = useRef<SVGCircleElement | null>(null);

  useEffect(() => {
    let raf = 0;
    let mounted = true;
    let visible = false;
    let touchSeen = false;

    // glow drives shrink + halo (fires on both soft and strong);
    // dot drives the red center dot (fires only on strong).
    const target = { x: 0, y: 0, scale: SCALE_BASE, glow: 0, dot: 0 };
    const cur = { x: 0, y: 0, scale: SCALE_BASE, glow: 0, dot: 0 };

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType === "touch" || e.pointerType === "pen") {
        touchSeen = true;
        visible = false;
        return;
      }
      if (touchSeen) return;
      target.x = e.clientX;
      target.y = e.clientY;
      visible = true;
      const el = document.elementFromPoint(
        e.clientX,
        e.clientY
      ) as HTMLElement | null;
      const tier = hoverTier(el);
      const hovering = tier !== "none";
      target.scale = hovering ? SCALE_HOVER : SCALE_BASE;
      target.glow = hovering ? 1 : 0;
      target.dot = tier === "strong" ? 1 : 0;
    };

    const onLeave = () => {
      visible = false;
    };

    const tick = () => {
      if (!mounted) return;
      // Position snaps to the actual pointer — no lerp — so the
      // ring center always sits exactly at the click target.
      cur.x = target.x;
      cur.y = target.y;
      cur.scale += (target.scale - cur.scale) * LERP_SHAPE;
      cur.glow += (target.glow - cur.glow) * LERP_SHAPE;
      cur.dot += (target.dot - cur.dot) * LERP_SHAPE;
      const w = wrapRef.current;
      const d = dotRef.current;
      if (w) {
        // The wrapper is a zero-size point anchored at the ring
        // center: position: fixed; width: 0; height: 0. We move it
        // to the click target with top / left, then scale around
        // its own (0, 0) which is the ring center. The SVG inside
        // uses a viewBox centered at (0, 0) with overflow: visible,
        // so the ring + ticks render outward from the hot spot.
        // Avoiding any "translate ± half size" math removes the
        // chance for sub-pixel drift between the visual center and
        // the click point.
        w.style.left = `${cur.x}px`;
        w.style.top = `${cur.y}px`;
        w.style.transform = `scale(${cur.scale})`;
        const g = cur.glow;
        // Soft white halo grows with the glow value. The strong
        // tier (g approaches 1 along with dot) gets a slight red
        // bias so the bloom matches the dot color.
        const dt = cur.dot;
        w.style.filter =
          g > 0.001
            ? `drop-shadow(0 0 ${1 + g * 2}px rgba(255,255,255,${
                0.55 * g
              })) drop-shadow(0 0 ${4 + g * 8}px rgba(${
                255 - dt * 80
              }, ${255 - dt * 200}, ${255 - dt * 200}, ${0.35 * g}))`
            : "none";
        w.style.opacity = visible && !touchSeen ? "1" : "0";
      }
      if (d) {
        // Dot stays at the ring center in SVG coords; opacity +
        // scale fade in with the strong-hover signal.
        const dt = cur.dot;
        d.setAttribute("opacity", `${dt}`);
        d.setAttribute("r", `${DOT_R * (0.5 + dt * 0.5)}`);
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
    <div
      ref={wrapRef}
      aria-hidden
      style={{
        position: "fixed",
        left: 0,
        top: 0,
        // Zero-size anchor — the wrapper IS the ring center.
        width: 0,
        height: 0,
        // Scale around the wrapper's own (0, 0) — same point as
        // the ring center / hot spot — so hover shrink stays
        // pinned to the click target.
        transformOrigin: "0 0",
        pointerEvents: "none",
        zIndex: 2147483647,
        opacity: 0,
        willChange: "transform, filter, opacity, top, left",
      }}
    >
      <svg
        width={SVG_SIZE}
        height={SVG_SIZE}
        // viewBox centered at (0, 0) so SVG (0, 0) is the ring
        // center. overflow: visible lets the ticks + halo extend
        // past the box without clipping.
        viewBox={`${-SVG_CENTER} ${-SVG_CENTER} ${SVG_SIZE} ${SVG_SIZE}`}
        style={{
          display: "block",
          overflow: "visible",
          position: "absolute",
          // Position the SVG so its viewBox (0, 0) — the ring
          // center — sits exactly at the wrapper's (0, 0).
          left: -SVG_CENTER,
          top: -SVG_CENTER,
        }}
      >
        <g
          fill="none"
          stroke="#fff"
          strokeWidth={STROKE_W}
          strokeLinecap="round"
        >
          {/* Center ring */}
          <circle cx={0} cy={0} r={RING_R} />
          {/* N / S / E / W ticks */}
          <line x1={0} y1={-TICK_OUTER} x2={0} y2={-TICK_INNER} />
          <line x1={0} y1={TICK_INNER} x2={0} y2={TICK_OUTER} />
          <line x1={-TICK_OUTER} y1={0} x2={-TICK_INNER} y2={0} />
          <line x1={TICK_INNER} y1={0} x2={TICK_OUTER} y2={0} />
        </g>
        {/* Red hover dot at the exact ring center — opacity + radius
            driven by `cur.dot`. */}
        <circle
          ref={dotRef}
          cx={0}
          cy={0}
          r={DOT_R}
          fill="#ef4444"
          opacity={0}
        />
      </svg>
    </div>
  );
}
