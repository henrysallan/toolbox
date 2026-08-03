"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

// ---------------------------------------------------------------------------
// Pie menu — a radial, cursor-anchored quick-action menu (Shift+Space).
//
// Presentational + self-contained: it knows nothing about the app, only a
// list of items (each with its own run()). The owner (EffectsApp) builds the
// item array wired to real handlers. Look & feel follows the editor's house
// language (inline-hex zinc/blue, var(--ui-font), pills at 999, house easing).
//
// Interaction = hybrid (Blender-style): flick a direction and release the
// keys to fire; OR tap the chord and it stays open for point-and-click.
// Spec: specdocs/071326_pie-menu.md.
// ---------------------------------------------------------------------------

export type PieMenuItem = {
  id: string;
  label: string;
  /** Optional shortcut glyph shown on the pill, e.g. "⌘S". */
  hint?: string;
  /** Inline <svg> — fill:none stroke:currentColor so color flows from state. */
  icon: React.ReactNode;
  disabled?: boolean;
  /** Fired when the item is selected. */
  run: () => void;
};

type Props = {
  /** Cursor position (screen px) captured at Shift+Space keydown. */
  origin: { x: number; y: number };
  items: PieMenuItem[];
  onClose: () => void;
};

// Geometry (screen px).
const R = 96; // ring radius: center → chip center
const DEAD = 30; // dead zone / hub radius (center = cancel)
const CHIP = 40;
const HUB = 56;
const OUTER = R + 128; // clicks past this in persistent phase = dismiss

const EASE = "cubic-bezier(0.4,0,0.2,1)";

function deg2rad(d: number) {
  return (d * Math.PI) / 180;
}

/** Angular distance between two angles in degrees, wrapped to [0,180]. */
function angDiff(a: number, b: number) {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

export default function PieMenu({ origin, items, onClose }: Props) {
  const n = items.length;
  const step = 360 / n; // degrees between items
  const startAngle = -90; // first item at 12 o'clock, clockwise

  // Per-item ring angle (degrees) and unit direction.
  const geom = useMemo(
    () =>
      items.map((_, i) => {
        const a = startAngle + i * step;
        return { a, ux: Math.cos(deg2rad(a)), uy: Math.sin(deg2rad(a)) };
      }),
    [items, step],
  );

  // Clamp the rendered center so the whole footprint stays on-screen. Angle
  // math + gesture selection both use this rendered center (not raw origin).
  const [center] = useState(() => {
    const margin = R + 130;
    const vw = typeof window !== "undefined" ? window.innerWidth : 1920;
    const vh = typeof window !== "undefined" ? window.innerHeight : 1080;
    const cx =
      vw < margin * 2 ? vw / 2 : Math.min(Math.max(origin.x, margin), vw - margin);
    const cy =
      vh < margin * 2 ? vh / 2 : Math.min(Math.max(origin.y, margin), vh - margin);
    return { cx, cy };
  });

  const [active, setActive] = useState<number | null>(null);
  const [persistent, setPersistent] = useState(false);
  const [shown, setShown] = useState(false);

  // Mutable mirrors for the window listeners (avoid stale closures).
  // Synced in effects, not during render (react-hooks/refs).
  const activeRef = useRef<number | null>(null);
  const persistentRef = useRef(false);
  const draggedRef = useRef(false);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  useEffect(() => {
    persistentRef.current = persistent;
  }, [persistent]);

  // Bloom-in on mount.
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const fire = useCallback(
    (i: number | null) => {
      if (i == null || !items[i] || items[i].disabled) {
        onClose();
        return;
      }
      items[i].run();
      onClose();
    },
    [items, onClose],
  );

  // Which item does a screen point map to? By direction only (pie semantics);
  // null inside the dead zone.
  const pick = useCallback(
    (x: number, y: number): number | null => {
      const dx = x - center.cx;
      const dy = y - center.cy;
      if (Math.hypot(dx, dy) < DEAD) return null;
      const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < n; i++) {
        const d = angDiff(ang, geom[i].a);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      return best;
    },
    [center, geom, n],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const dx = e.clientX - center.cx;
      const dy = e.clientY - center.cy;
      if (Math.hypot(dx, dy) >= DEAD) draggedRef.current = true;
      setActive(pick(e.clientX, e.clientY));
    },
    [center, pick],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const dx = e.clientX - center.cx;
      const dy = e.clientY - center.cy;
      const dist = Math.hypot(dx, dy);
      // Click in the dead zone or well past the ring = dismiss.
      if (dist < DEAD || dist > OUTER) {
        onClose();
        return;
      }
      fire(pick(e.clientX, e.clientY));
    },
    [center, fire, pick, onClose],
  );

  // Keys: Escape cancels always; releasing Space/Shift commits the flick (or
  // falls through to persistent point-and-click on a tap).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== " " && e.key !== "Shift") return;
      if (persistentRef.current) return; // already in click mode
      if (draggedRef.current && activeRef.current != null) {
        fire(activeRef.current);
      } else {
        // A tap: keep the menu open for point-and-click.
        setPersistent(true);
        setActive(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [fire, onClose]);

  // ---- render ----
  const activeGeom = active != null ? geom[active] : null;
  const wedge = activeGeom
    ? (() => {
        const a0 = deg2rad(activeGeom.a - step / 2);
        const a1 = deg2rad(activeGeom.a + step / 2);
        const rw = R + CHIP / 2 - 2;
        const x0 = center.cx + rw * Math.cos(a0);
        const y0 = center.cy + rw * Math.sin(a0);
        const x1 = center.cx + rw * Math.cos(a1);
        const y1 = center.cy + rw * Math.sin(a1);
        return `M ${center.cx} ${center.cy} L ${x0} ${y0} A ${rw} ${rw} 0 0 1 ${x1} ${y1} Z`;
      })()
    : null;

  const overlay = (
    <div
      onPointerMove={onPointerMove}
      onPointerDown={onPointerDown}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9000,
        // No dark scrim — the canvas stays visible (reference has none).
        background: "transparent",
        cursor: "default",
        fontFamily: "var(--ui-font)",
        userSelect: "none",
      }}
    >
      {/* Connecting ring + active wedge (behind chips, non-interactive). */}
      <svg
        width="100%"
        height="100%"
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          opacity: shown ? 1 : 0,
          transform: shown ? "scale(1)" : "scale(0.92)",
          transformOrigin: `${center.cx}px ${center.cy}px`,
          transition: `opacity 0.14s ${EASE}, transform 0.14s ${EASE}`,
        }}
      >
        {wedge && <path d={wedge} fill="color-mix(in srgb, var(--tb-a-blue-900) 35%, transparent)" />}
        <circle
          cx={center.cx}
          cy={center.cy}
          r={R}
          fill="none"
          stroke="var(--tb-n-7)"
          strokeWidth={1}
        />
      </svg>

      {/* Center hub (dead zone / cancel target). */}
      <div
        style={{
          position: "absolute",
          left: center.cx - HUB / 2,
          top: center.cy - HUB / 2,
          width: HUB,
          height: HUB,
          borderRadius: 999,
          border: "1px solid var(--tb-n-7)",
          background: "rgba(10,10,10,0.55)",
          pointerEvents: "none",
          opacity: shown ? 1 : 0,
          transform: shown ? "scale(1)" : "scale(0.5)",
          transformOrigin: "center",
          transition: `opacity 0.14s ${EASE}, transform 0.14s ${EASE}`,
        }}
      />

      {/* Items: icon chip + outward label pill. Purely visual — all hit
          testing is geometric on the overlay above. */}
      {items.map((item, i) => {
        const g = geom[i];
        const cxp = center.cx + R * g.ux;
        const cyp = center.cy + R * g.uy;
        const isActive = active === i;
        const dis = !!item.disabled;

        // Label alignment: read outward from the chip.
        const tx = g.ux > 0.35 ? 0 : g.ux < -0.35 ? -100 : -50;
        const ty = g.uy > 0.35 ? 0 : g.uy < -0.35 ? -100 : -50;
        const labelX = center.cx + (R + CHIP / 2 + 10) * g.ux;
        const labelY = center.cy + (R + CHIP / 2 + 10) * g.uy;

        return (
          <div key={item.id} style={{ pointerEvents: "none" }}>
            {/* chip */}
            <div
              style={{
                position: "absolute",
                left: cxp - CHIP / 2,
                top: cyp - CHIP / 2,
                width: CHIP,
                height: CHIP,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 10,
                background: dis ? "var(--tb-n-2)" : isActive ? "var(--tb-a-blue-900)" : "var(--tb-n-3)",
                border: `1px solid ${
                  dis ? "var(--tb-n-7)" : isActive ? "var(--tb-a-blue-500)" : "var(--tb-n-7)"
                }`,
                color: dis ? "var(--tb-n-10)" : isActive ? "var(--tb-a-blue-100)" : "var(--tb-n-13)",
                boxShadow: isActive
                  ? "0 0 0 3px color-mix(in srgb, var(--tb-a-blue-500) 25%, transparent)"
                  : "none",
                opacity: shown ? (dis ? 0.5 : 1) : 0,
                transform: shown ? "scale(1)" : "scale(0.6)",
                transformOrigin: "center",
                transition: `opacity 0.14s ${EASE}, transform 0.14s ${EASE}, background 0.1s ${EASE}, border-color 0.1s ${EASE}, box-shadow 0.1s ${EASE}, color 0.1s ${EASE}`,
              }}
            >
              {item.icon}
            </div>
            {/* label pill */}
            <div
              style={{
                position: "absolute",
                left: labelX,
                top: labelY,
                transform: `translate(${tx}%, ${ty}%)`,
                display: "flex",
                alignItems: "center",
                gap: 6,
                whiteSpace: "nowrap",
                borderRadius: 999,
                padding: "3px 9px",
                fontSize: 11,
                background: dis ? "var(--tb-n-0)" : isActive ? "var(--tb-a-blue-900)" : "var(--tb-n-0)",
                border: `1px solid ${isActive ? "var(--tb-a-blue-900)" : "var(--tb-n-7)"}`,
                color: dis ? "var(--tb-n-10)" : isActive ? "var(--tb-a-blue-100)" : "var(--tb-n-13)",
                opacity: shown ? (dis ? 0.5 : 1) : 0,
                transition: `opacity 0.14s ${EASE}, background 0.1s ${EASE}, border-color 0.1s ${EASE}, color 0.1s ${EASE}`,
              }}
            >
              <span>{item.label}</span>
              {item.hint && (
                <span
                  style={{
                    color: isActive ? "var(--tb-a-blue-300)" : "var(--tb-n-11)",
                    fontSize: 10,
                    padding: "0 3px",
                    borderRadius: 3,
                    border: `1px solid ${isActive ? "var(--tb-a-blue-700)" : "var(--tb-n-7)"}`,
                  }}
                >
                  {item.hint}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );

  if (typeof document === "undefined") return null;
  return createPortal(overlay, document.body);
}
