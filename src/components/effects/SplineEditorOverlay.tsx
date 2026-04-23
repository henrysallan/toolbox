"use client";

import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { SplineAnchor, SplineSubpath } from "@/engine/types";
import type { SplineParamValue } from "@/nodes/source/spline-draw";

// The overlay authors exactly one subpath — the first in the SplineParamValue.
// Multi-subpath authoring (Figma-style compound paths) is a later concern;
// for now Spline Draw nodes are always single-subpath and SVG Source is
// read-only from the pen tool's perspective.
const EDIT_SUBPATH = 0;

// On-canvas pen tool for the Spline Draw node.
//
// Coordinate convention matches the node's stored format: normalized [0,1]²
// with Y-DOWN (row 0 at top). That lets the overlay, the 2D canvas raster,
// and the DOM coordinate system all line up without per-operation flips.
// Consumers that expect Y-up (future "sample along path" nodes) are
// responsible for flipping on their side.
//
// Two tool modes govern what a background click does (anchor/handle gestures
// are identical in both):
//   - "add"     — pen tool; background click creates an anchor
//   - "select"  — edit tool; background click is inert, so the user can
//                 freely drag existing points without accidentally adding
//                 new ones
//
// Shared gesture grammar:
//   - pointerdown on empty space (add only) → add new anchor (corner)
//     pointerdown + drag                    → converts the new anchor to
//                                              smooth; symmetric handles
//                                              follow the drag direction
//   - pointerdown on existing anchor        → drag moves the anchor (handles
//                                              follow); quick click without
//                                              drag toggles corner ↔ smooth
//   - pointerdown on handle                 → reshape, mirroring the opposite
//                                              handle. Alt-drag breaks the
//                                              symmetry for that gesture.
//   - right-click on anchor                 → delete
//   - right-click on handle                 → remove this handle only
//     (turns that side of the anchor into a corner tangent)

type ToolMode = "add" | "select";

interface Props {
  canvas: HTMLCanvasElement | null;
  value: SplineParamValue;
  onChange: (next: SplineParamValue) => void;
}

const ANCHOR_R = 5;
const HANDLE_R = 4;
const DRAG_THRESHOLD = 3; // px; below this a pointerup counts as a click

type DragState =
  | {
      kind: "new";
      index: number; // index of the just-added anchor
      startClient: { x: number; y: number };
      moved: boolean;
    }
  | {
      kind: "anchor";
      index: number;
      grabOffset: { x: number; y: number }; // stored-coord offset (anchor - pointer)
      startClient: { x: number; y: number };
      moved: boolean;
    }
  | {
      kind: "handle";
      index: number;
      side: "in" | "out";
      symmetric: boolean;
      startClient: { x: number; y: number };
    };

export default function SplineEditorOverlay({
  canvas,
  value,
  onChange,
}: Props) {
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const [rect, setRect] = useState<DOMRect | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [tool, setTool] = useState<ToolMode>("add");

  // P / V switch modes — matching the Photoshop/Figma convention. Skipped
  // while focus is in a text field so typing into the param panel doesn't
  // flip tools under the user.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return;
      }
      if (e.key === "p" || e.key === "P") setTool("add");
      else if (e.key === "v" || e.key === "V") setTool("select");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Track the canvas's on-screen rectangle the same way TransformGizmo does —
  // ResizeObserver catches splitter resizes and zoom-to-fit changes.
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

  const clientToNorm = (cx: number, cy: number): [number, number] => {
    if (!rect) return [0, 0];
    return [(cx - rect.left) / rect.width, (cy - rect.top) / rect.height];
  };

  const normToPx = (p: [number, number]) => {
    if (!rect) return { x: 0, y: 0 };
    return { x: rect.left + p[0] * rect.width, y: rect.top + p[1] * rect.height };
  };

  // Everything below operates on the first subpath exclusively — multi-subpath
  // authoring isn't a v1 feature. Reads return [] if the value happens to
  // arrive without any subpaths; writes always materialize the subpath on
  // first touch.
  const readAnchors = (v: SplineParamValue): SplineAnchor[] =>
    v.subpaths[EDIT_SUBPATH]?.anchors ?? [];
  const withSubpathPatch = (
    cur: SplineParamValue,
    patch: Partial<SplineSubpath>
  ): SplineParamValue => {
    const base: SplineSubpath[] =
      cur.subpaths.length > 0
        ? cur.subpaths
        : [{ anchors: [], closed: false }];
    return {
      ...cur,
      subpaths: base.map((s, i) =>
        i === EDIT_SUBPATH ? { ...s, ...patch } : s
      ),
    };
  };

  // Derive handle auto-fill vectors for converting a corner anchor to smooth.
  // Uses the adjacent anchors for a simple tangent; falls back to a small
  // horizontal handle when the anchor is isolated (only one in the path).
  const autoSmoothHandles = (
    anchors: SplineAnchor[],
    i: number
  ): { inHandle: [number, number]; outHandle: [number, number] } => {
    const a = anchors[i];
    const prev = i > 0 ? anchors[i - 1] : null;
    const next = i < anchors.length - 1 ? anchors[i + 1] : null;
    let tx = 0;
    let ty = 0;
    if (prev && next) {
      tx = next.pos[0] - prev.pos[0];
      ty = next.pos[1] - prev.pos[1];
    } else if (prev) {
      tx = a.pos[0] - prev.pos[0];
      ty = a.pos[1] - prev.pos[1];
    } else if (next) {
      tx = next.pos[0] - a.pos[0];
      ty = next.pos[1] - a.pos[1];
    } else {
      tx = 0.1;
      ty = 0;
    }
    const mag = Math.hypot(tx, ty) || 1;
    // Handle length = ~1/3 of the tangent span, matching Illustrator's
    // default Auto Smooth.
    const L = mag / 3;
    const ux = (tx / mag) * L;
    const uy = (ty / mag) * L;
    return { inHandle: [-ux, -uy], outHandle: [ux, uy] };
  };

  // --- pointer actions -----------------------------------------------------

  const addAnchorAt = (nx: number, ny: number) => {
    const cur = valueRef.current;
    const anchors = readAnchors(cur);
    const next = withSubpathPatch(cur, {
      anchors: [...anchors, { pos: [nx, ny] }],
    });
    onChangeRef.current(next);
    return anchors.length;
  };

  const updateAnchor = (i: number, patch: Partial<SplineAnchor>) => {
    const cur = valueRef.current;
    const anchors = readAnchors(cur);
    const next = withSubpathPatch(cur, {
      anchors: anchors.map((a, idx) => (idx === i ? { ...a, ...patch } : a)),
    });
    onChangeRef.current(next);
  };

  const deleteAnchor = (i: number) => {
    const cur = valueRef.current;
    const anchors = readAnchors(cur);
    const next = withSubpathPatch(cur, {
      anchors: anchors.filter((_, idx) => idx !== i),
    });
    onChangeRef.current(next);
  };

  const toggleCornerSmooth = (i: number) => {
    const anchors = readAnchors(valueRef.current);
    const a = anchors[i];
    if (!a) return;
    const hasHandles = !!a.inHandle || !!a.outHandle;
    if (hasHandles) {
      // Smooth → corner: strip handles.
      const patched: SplineAnchor = { pos: a.pos };
      updateAnchor(i, patched);
    } else {
      // Corner → smooth: auto-tangent from neighbors.
      const { inHandle, outHandle } = autoSmoothHandles(anchors, i);
      updateAnchor(i, { inHandle, outHandle });
    }
  };

  // Single effect handles the live pointer stream for ALL drag kinds. Without
  // an active drag the effect does nothing. Delta tracking is in client-px so
  // movement thresholds compare cleanly regardless of zoom.
  useEffect(() => {
    if (!drag || !rect) return;

    const onMove = (e: PointerEvent) => {
      const [nx, ny] = clientToNorm(e.clientX, e.clientY);
      const anchors = readAnchors(valueRef.current);
      switch (drag.kind) {
        case "new": {
          const dx = e.clientX - drag.startClient.x;
          const dy = e.clientY - drag.startClient.y;
          if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
          drag.moved = true;
          // Pointer direction → symmetric handles. outHandle is pointer-ward,
          // inHandle mirrors it.
          const a = anchors[drag.index];
          if (!a) return;
          const hx = nx - a.pos[0];
          const hy = ny - a.pos[1];
          updateAnchor(drag.index, {
            inHandle: [-hx, -hy],
            outHandle: [hx, hy],
          });
          break;
        }
        case "anchor": {
          const dx = e.clientX - drag.startClient.x;
          const dy = e.clientY - drag.startClient.y;
          if (!drag.moved && Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
            drag.moved = true;
          }
          if (drag.moved) {
            // Preserve handle offsets — they're stored relative to pos, so
            // moving pos automatically carries them along.
            updateAnchor(drag.index, {
              pos: [nx + drag.grabOffset.x, ny + drag.grabOffset.y],
            });
          }
          break;
        }
        case "handle": {
          const a = anchors[drag.index];
          if (!a) break;
          const hx = nx - a.pos[0];
          const hy = ny - a.pos[1];
          const patch: Partial<SplineAnchor> = {};
          if (drag.side === "out") {
            patch.outHandle = [hx, hy];
            if (drag.symmetric) patch.inHandle = [-hx, -hy];
          } else {
            patch.inHandle = [hx, hy];
            if (drag.symmetric) patch.outHandle = [-hx, -hy];
          }
          updateAnchor(drag.index, patch);
          break;
        }
      }
    };

    const onUp = (e: PointerEvent) => {
      // Quick click on an existing anchor (no meaningful movement) →
      // corner↔smooth toggle. The "new" case is never a toggle candidate
      // (the anchor was just created this gesture).
      if (drag.kind === "anchor" && !drag.moved) {
        const dx = e.clientX - drag.startClient.x;
        const dy = e.clientY - drag.startClient.y;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) {
          toggleCornerSmooth(drag.index);
        }
      }
      setDrag(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, rect]);

  const onBackgroundPointerDown = (e: React.PointerEvent<SVGRectElement>) => {
    if (!rect) return;
    if (e.button !== 0) return; // left only; right-click adds nothing
    // In select mode, background clicks are inert — the toolbar's pen icon
    // is the only way to author new anchors.
    if (tool !== "add") return;
    e.preventDefault();
    e.stopPropagation();
    const [nx, ny] = clientToNorm(e.clientX, e.clientY);
    const newIdx = addAnchorAt(nx, ny);
    setDrag({
      kind: "new",
      index: newIdx,
      startClient: { x: e.clientX, y: e.clientY },
      moved: false,
    });
  };

  const onAnchorPointerDown =
    (index: number) => (e: React.PointerEvent<SVGCircleElement>) => {
      if (!rect) return;
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const [nx, ny] = clientToNorm(e.clientX, e.clientY);
      const a = readAnchors(valueRef.current)[index];
      if (!a) return;
      setDrag({
        kind: "anchor",
        index,
        grabOffset: { x: a.pos[0] - nx, y: a.pos[1] - ny },
        startClient: { x: e.clientX, y: e.clientY },
        moved: false,
      });
    };

  const onHandlePointerDown =
    (index: number, side: "in" | "out") =>
    (e: React.PointerEvent<SVGCircleElement>) => {
      if (!rect) return;
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      setDrag({
        kind: "handle",
        index,
        side,
        // Alt held on pointerdown breaks symmetry for the whole gesture — no
        // mid-drag flip so the user doesn't accidentally snap handles.
        symmetric: !e.altKey,
        startClient: { x: e.clientX, y: e.clientY },
      });
    };

  const onAnchorContextMenu =
    (index: number) => (e: React.MouseEvent<SVGCircleElement>) => {
      e.preventDefault();
      e.stopPropagation();
      deleteAnchor(index);
    };

  const onHandleContextMenu =
    (index: number, side: "in" | "out") =>
    (e: React.MouseEvent<SVGCircleElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const a = readAnchors(valueRef.current)[index];
      if (!a) return;
      // Rebuild as a fresh object so the updater sees the delete as a change.
      const cleaned: SplineAnchor = { pos: a.pos };
      if (side === "in" && a.outHandle) cleaned.outHandle = a.outHandle;
      if (side === "out" && a.inHandle) cleaned.inHandle = a.inHandle;
      updateAnchor(index, cleaned);
    };

  // --- rendering -----------------------------------------------------------

  const pathD = useMemo(() => {
    if (!rect) return "";
    const anchors = value.subpaths[EDIT_SUBPATH]?.anchors ?? [];
    if (anchors.length < 2) return "";
    const toPx = (p: [number, number]) => normToPx(p);
    const first = toPx(anchors[0].pos);
    let d = `M ${first.x} ${first.y}`;
    for (let i = 1; i < anchors.length; i++) {
      const prev = anchors[i - 1];
      const cur = anchors[i];
      const cp1 = prev.outHandle
        ? toPx([prev.pos[0] + prev.outHandle[0], prev.pos[1] + prev.outHandle[1]])
        : toPx(prev.pos);
      const cp2 = cur.inHandle
        ? toPx([cur.pos[0] + cur.inHandle[0], cur.pos[1] + cur.inHandle[1]])
        : toPx(cur.pos);
      const end = toPx(cur.pos);
      d += ` C ${cp1.x} ${cp1.y}, ${cp2.x} ${cp2.y}, ${end.x} ${end.y}`;
    }
    return d;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rect, value]);

  if (!rect) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: 50,
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
        {/* Canvas-area background — receives pointerdown for adding anchors
            in "add" mode. In "select" mode it lets events pass through so
            the click doesn't feel caught. */}
        <rect
          x={rect.left}
          y={rect.top}
          width={rect.width}
          height={rect.height}
          fill="transparent"
          style={{
            cursor: tool === "add" ? "crosshair" : "default",
            pointerEvents: tool === "add" ? "auto" : "none",
          }}
          onPointerDown={onBackgroundPointerDown}
          onContextMenu={(e) => e.preventDefault()}
        />

        {/* Path preview — non-interactive; just shows the curve the user
            is authoring. */}
        {pathD && (
          <path
            d={pathD}
            fill="none"
            stroke="#22d3ee"
            strokeWidth={1.2}
            strokeDasharray="0"
            opacity={0.9}
            style={{ pointerEvents: "none" }}
          />
        )}

        {/* Handle lines (anchor → handle dot). Drawn beneath the dots so
            the dots sit visually on top. */}
        {(value.subpaths[EDIT_SUBPATH]?.anchors ?? []).map((a, i) => {
          const anchorPx = normToPx(a.pos);
          const lines = [] as ReactElement[];
          if (a.inHandle) {
            const hp = normToPx([
              a.pos[0] + a.inHandle[0],
              a.pos[1] + a.inHandle[1],
            ]);
            lines.push(
              <line
                key={`hl-${i}-in`}
                x1={anchorPx.x}
                y1={anchorPx.y}
                x2={hp.x}
                y2={hp.y}
                stroke="#94a3b8"
                strokeWidth={1}
                style={{ pointerEvents: "none" }}
              />
            );
          }
          if (a.outHandle) {
            const hp = normToPx([
              a.pos[0] + a.outHandle[0],
              a.pos[1] + a.outHandle[1],
            ]);
            lines.push(
              <line
                key={`hl-${i}-out`}
                x1={anchorPx.x}
                y1={anchorPx.y}
                x2={hp.x}
                y2={hp.y}
                stroke="#94a3b8"
                strokeWidth={1}
                style={{ pointerEvents: "none" }}
              />
            );
          }
          return lines;
        })}

        {/* Anchor dots */}
        {(value.subpaths[EDIT_SUBPATH]?.anchors ?? []).map((a, i) => {
          const p = normToPx(a.pos);
          return (
            <circle
              key={`a-${i}`}
              cx={p.x}
              cy={p.y}
              r={ANCHOR_R}
              fill="#0ea5e9"
              stroke="#f0f9ff"
              strokeWidth={1.2}
              style={{ cursor: "grab", pointerEvents: "auto" }}
              onPointerDown={onAnchorPointerDown(i)}
              onContextMenu={onAnchorContextMenu(i)}
            />
          );
        })}

        {/* Handle dots */}
        {(value.subpaths[EDIT_SUBPATH]?.anchors ?? []).map((a, i) => {
          const dots: ReactElement[] = [];
          if (a.inHandle) {
            const p = normToPx([
              a.pos[0] + a.inHandle[0],
              a.pos[1] + a.inHandle[1],
            ]);
            dots.push(
              <circle
                key={`h-${i}-in`}
                cx={p.x}
                cy={p.y}
                r={HANDLE_R}
                fill="#f8fafc"
                stroke="#0f172a"
                strokeWidth={1}
                style={{ cursor: "grab", pointerEvents: "auto" }}
                onPointerDown={onHandlePointerDown(i, "in")}
                onContextMenu={onHandleContextMenu(i, "in")}
              />
            );
          }
          if (a.outHandle) {
            const p = normToPx([
              a.pos[0] + a.outHandle[0],
              a.pos[1] + a.outHandle[1],
            ]);
            dots.push(
              <circle
                key={`h-${i}-out`}
                cx={p.x}
                cy={p.y}
                r={HANDLE_R}
                fill="#f8fafc"
                stroke="#0f172a"
                strokeWidth={1}
                style={{ cursor: "grab", pointerEvents: "auto" }}
                onPointerDown={onHandlePointerDown(i, "out")}
                onContextMenu={onHandleContextMenu(i, "out")}
              />
            );
          }
          return dots;
        })}
      </svg>

      {/* Tool picker, pinned to the canvas's upper-left. Positioned in client
          coords via `rect` so it stays put through splitter drags / resize /
          zoom. Lives outside the SVG to keep its hit-testing simple. */}
      <div
        style={{
          position: "fixed",
          left: rect.left + 8,
          top: rect.top + 8,
          display: "flex",
          gap: 4,
          padding: 3,
          background: "rgba(17, 17, 17, 0.9)",
          border: "1px solid #27272a",
          borderRadius: 4,
          boxShadow: "0 4px 12px rgba(0, 0, 0, 0.35)",
          pointerEvents: "auto",
          fontFamily: "ui-monospace, monospace",
        }}
      >
        <ToolButton
          active={tool === "add"}
          label="Add point (P)"
          onClick={() => setTool("add")}
        >
          <PenIcon />
        </ToolButton>
        <ToolButton
          active={tool === "select"}
          label="Select point (V)"
          onClick={() => setTool("select")}
        >
          <CursorIcon />
        </ToolButton>
      </div>
    </div>
  );
}

function ToolButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: ReactElement;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      style={{
        width: 26,
        height: 26,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: active ? "#0ea5e9" : "transparent",
        color: active ? "#0b1220" : "#d4d4d8",
        border: "1px solid",
        borderColor: active ? "#0ea5e9" : "transparent",
        borderRadius: 3,
        cursor: "pointer",
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}

// Inline icons so we don't pull in an icon dependency for two glyphs.
function PenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M11 2l3 3-8 8-4 1 1-4 8-8z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path
        d="M9 4l3 3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CursorIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M3 2l6 12 1.8-4.2L15 8 3 2z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="currentColor"
        fillOpacity="0.15"
      />
    </svg>
  );
}
