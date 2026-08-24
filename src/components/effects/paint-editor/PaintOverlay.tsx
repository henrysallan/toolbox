"use client";

// The Paint node's on-canvas editor (071926_paint-toolkit.md). Replaces the
// old Atrament wrapper with the in-house stamp engine (./engine.ts) and a
// spline-draw-style tool dock: brush / eraser / blur / fill / eyedropper +
// Clear.
//
// Interaction model (unchanged from the original overlay): painting is gated
// on the paint node being SELECTED; the paint canvas itself is never shown —
// strokes appear through the pipeline as rendered by the active node, so you
// paint and see the end-of-chain result live (a rAF loop snapshots the
// canvas mid-stroke to drive re-evals). Undo rides the dedicated paint lane:
// every completed action (stroke, fill, clear) commits the pre-action pixels
// through onStrokeCommit.
//
// Coordinates: the overlay tracks the preview canvas's on-screen rect (which
// includes the viewport pan/zoom transform) and maps client px → canvas px
// through it, so the cursor↔stroke mapping is exact at any zoom. Brush size
// is in CANVAS px.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { PaintParamValue } from "@/engine/types";
import { rectsEqual } from "../overlay-rect";
import { resolveBrush } from "./brushes";
import { PaintBrushShelf, PaintToolDock } from "./dock";
import { floodFill, StrokeSession } from "./engine";
import { claimPointerGesture } from "@/lib/pointer-claim";
import type { PaintTool } from "./types";

interface Props {
  nodeId: string;
  params: Record<string, unknown>;
  canvasRes: [number, number];
  // The visible preview canvas: rect source for coordinate mapping, and the
  // eyedropper's sample target (it holds the composited pipeline output).
  previewCanvas: HTMLCanvasElement | null;
  onParamChange: (nodeId: string, paramName: string, value: unknown) => void;
  // Fires after each completed action (stroke / fill / clear) with the
  // pre-action pixels so the caller can push them onto the undo stack.
  onStrokeCommit?: (
    nodeId: string,
    canvas: HTMLCanvasElement,
    before: ImageData
  ) => void;
}

export default function PaintOverlay({
  nodeId,
  params,
  canvasRes,
  previewCanvas,
  onParamChange,
  onStrokeCommit,
}: Props) {
  // Callback/value mirrors for the once-bound keyboard handler and the
  // long-running rAF loop. Updated in a bare effect (after every render) so
  // they're always fresh without render-phase ref writes.
  const onChangeRef = useRef(onParamChange);
  const onCommitRef = useRef(onStrokeCommit);
  const nodeIdRef = useRef(nodeId);
  const sizeRef = useRef(12);
  useEffect(() => {
    onChangeRef.current = onParamChange;
    onCommitRef.current = onStrokeCommit;
    nodeIdRef.current = nodeId;
    sizeRef.current = typeof params.size === "number" ? params.size : 12;
  });

  const paint = (params.paint as PaintParamValue | null) ?? null;
  const color = (params.color as string) ?? "#ffffff";
  const size = typeof params.size === "number" ? (params.size as number) : 12;
  const fillTolerance =
    typeof params.fill_tolerance === "number"
      ? (params.fill_tolerance as number)
      : 0.05;
  const brush = useMemo(() => resolveBrush(params.brush), [params.brush]);

  const [tool, setTool] = useState<PaintTool>("brush");
  // Alt temporarily flips brush-family tools to the eyedropper (Photoshop
  // convention). Tracked as state so the cursor swaps too.
  const [altHeld, setAltHeld] = useState(false);
  // Shift: straight-line helpers. Shift-click connects a line from the last
  // stroke's end; Shift-drag locks the stroke to its dominant axis. Held
  // state drives the dashed connect-preview line.
  const [shiftHeld, setShiftHeld] = useState(false);
  // Live pointer position (client px) for the brush-ring cursor; null when
  // the pointer is off the surface.
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  // End point of the previous stroke (canvas px) — the Shift-click line
  // anchor. Cleared by remount on node switch (EffectsApp keys this overlay
  // by node id).
  const [lastEnd, setLastEnd] = useState<[number, number] | null>(null);
  // True while a stroke session is in flight — state (not just sessionRef)
  // so render-time gates like the connect-preview line can read it.
  const [stroking, setStroking] = useState(false);
  // Shift-drag axis lock for the current stroke: anchor = where Shift
  // engaged; axis locks to the dominant direction once movement clears a
  // small threshold, and re-arms when Shift is released mid-stroke.
  const constraintRef = useRef<{
    anchor: [number, number];
    axis: "h" | "v" | null;
  } | null>(null);

  // On-screen rect of the preview canvas (reflects the viewport's pan/zoom
  // CSS transform) and of its containing panel (the clip region / dock
  // anchor). Tracked like the other overlays: ResizeObserver for layout,
  // window "resize" for pan/zoom (EffectsApp dispatches a synthetic resize on
  // every viewport-1 transform change), scroll-capture for everything else.
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [hostRect, setHostRect] = useState<DOMRect | null>(null);
  const rectRef = useRef<DOMRect | null>(null);

  useEffect(() => {
    const host = previewCanvas?.parentElement ?? null;
    // Idempotent updates — avoids a ResizeObserver feedback loop (overlay-rect.ts).
    const update = () => {
      if (!previewCanvas) {
        rectRef.current = null;
        setRect(null);
        setHostRect(null);
        return;
      }
      const r = previewCanvas.getBoundingClientRect();
      rectRef.current = r;
      setRect((prev) => (rectsEqual(prev, r) ? prev : r));
      const hr = (host ?? previewCanvas).getBoundingClientRect();
      setHostRect((prev) => (rectsEqual(prev, hr) ? prev : hr));
    };
    // Initial read deferred a frame so the effect body doesn't set state
    // synchronously; the overlay is 0-sized for that first frame only.
    const raf = requestAnimationFrame(update);
    if (!previewCanvas) return () => cancelAnimationFrame(raf);
    const ro = new ResizeObserver(update);
    ro.observe(previewCanvas);
    if (host) ro.observe(host);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [previewCanvas]);

  // Bootstrap the persistent drawing canvas on first mount. The canvas stays
  // transparent — strokes carry alpha; the paint node's compute composites
  // them per its bg_mode when rendering to the pipeline.
  useEffect(() => {
    if (paint != null) return;
    const canvas = document.createElement("canvas");
    canvas.width = canvasRes[0];
    canvas.height = canvasRes[1];
    onChangeRef.current(nodeIdRef.current, "paint", { canvas, snapshot: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resize (with pixel preservation) when the engine resolution changed
  // since the last action. Run lazily at the start of each pointer action —
  // visually equivalent to resizing eagerly (the node blits the snapshot
  // full-canvas either way), and it keeps canvas mutation out of effect
  // scope.
  const ensureCanvasRes = (canvas: HTMLCanvasElement) => {
    if (canvas.width === canvasRes[0] && canvas.height === canvasRes[1]) {
      return;
    }
    const tmp = document.createElement("canvas");
    tmp.width = canvas.width;
    tmp.height = canvas.height;
    tmp.getContext("2d")?.drawImage(canvas, 0, 0);
    canvas.width = canvasRes[0];
    canvas.height = canvasRes[1];
    const c2d = canvas.getContext("2d");
    if (c2d) c2d.drawImage(tmp, 0, 0, canvas.width, canvas.height);
  };

  // Tool + size keyboard shortcuts. Skipped while focus is in a text field
  // so typing into the param panel doesn't flip tools under the user.
  useEffect(() => {
    const isTyping = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return (
        !!el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable)
      );
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Alt") {
        setAltHeld(true);
        return;
      }
      if (e.key === "Shift") {
        setShiftHeld(true);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === "b") setTool("brush");
      else if (k === "e") setTool("eraser");
      else if (k === "g") setTool("fill");
      else if (k === "i") setTool("eyedropper");
      else if (e.key === "[" || e.key === "]") {
        // Photoshop-style bracket sizing, in canvas px. Coarser steps at
        // larger sizes so both ends of the range are reachable quickly.
        const cur = sizeRef.current;
        const step = cur < 12 ? 1 : cur < 48 ? 2 : 6;
        const next = Math.max(
          1,
          Math.min(400, cur + (e.key === "]" ? step : -step))
        );
        if (next !== cur) {
          onChangeRef.current(nodeIdRef.current, "size", next);
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Alt") setAltHeld(false);
      if (e.key === "Shift") setShiftHeld(false);
    };
    const onBlur = () => {
      setAltHeld(false);
      setShiftHeld(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // In-flight stroke state. The rAF loop re-composites the live stroke and
  // snapshots the canvas so the pipeline re-evaluates while dragging.
  const sessionRef = useRef<StrokeSession | null>(null);
  const beforeRef = useRef<ImageData | null>(null);
  const rafRef = useRef(0);
  const snapshotPendingRef = useRef(false);

  const snapshot = (canvas: HTMLCanvasElement) => {
    if (snapshotPendingRef.current) return;
    snapshotPendingRef.current = true;
    // premultiplyAlpha "none" is load-bearing: WebGL IGNORES the
    // UNPACK_PREMULTIPLY_ALPHA_WEBGL flag for ImageBitmap sources, so a
    // default (premultiplied) bitmap uploads premultiplied into a pipeline
    // that assumes straight alpha — downstream compositing then applies
    // alpha twice and soft brush edges fade through grey instead of
    // white→transparent.
    createImageBitmap(canvas, { premultiplyAlpha: "none" })
      .then((bmp) => {
        onChangeRef.current(nodeIdRef.current, "paint", {
          canvas,
          snapshot: bmp,
        });
      })
      .finally(() => {
        snapshotPendingRef.current = false;
      });
  };

  const captureBefore = (canvas: HTMLCanvasElement) => {
    const c2d = canvas.getContext("2d");
    if (c2d) {
      beforeRef.current = c2d.getImageData(0, 0, canvas.width, canvas.height);
    }
  };

  const commitBefore = (canvas: HTMLCanvasElement) => {
    if (!beforeRef.current) return;
    onCommitRef.current?.(nodeIdRef.current, canvas, beforeRef.current);
    beforeRef.current = null;
  };

  // Abandon a half-finished stroke on unmount (matches the old overlay: no
  // half-actions on the undo stack; the last live snapshot stands).
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      sessionRef.current = null;
      beforeRef.current = null;
    };
  }, []);

  const toCanvasPx = (
    clientX: number,
    clientY: number
  ): [number, number] | null => {
    const r = rectRef.current;
    const c = paint?.canvas;
    if (!r || !c || r.width <= 0 || r.height <= 0) return null;
    return [
      ((clientX - r.left) / r.width) * c.width,
      ((clientY - r.top) / r.height) * c.height,
    ];
  };

  // Sample the composited pipeline pixel under the cursor (the preview
  // canvas is the blit target — a plain 2D canvas), not just the paint
  // strokes: picking a color off an underlying image/render is the point.
  const sampleColor = (clientX: number, clientY: number) => {
    const r = rectRef.current;
    if (!r || !previewCanvas || r.width <= 0 || r.height <= 0) return;
    const x = Math.floor(((clientX - r.left) / r.width) * previewCanvas.width);
    const y = Math.floor(((clientY - r.top) / r.height) * previewCanvas.height);
    const ctx = previewCanvas.getContext("2d");
    if (!ctx) return;
    const d = ctx.getImageData(
      Math.max(0, Math.min(previewCanvas.width - 1, x)),
      Math.max(0, Math.min(previewCanvas.height - 1, y)),
      1,
      1
    ).data;
    const hex = `#${[d[0], d[1], d[2]]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")}`;
    onChangeRef.current(nodeIdRef.current, "color", hex);
  };

  // Alt temporarily flips the stroke tools to the eyedropper.
  const effectiveTool: PaintTool =
    altHeld && tool !== "fill" && tool !== "eyedropper" ? "eyedropper" : tool;

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return; // middle-click pan / right-click pass through
    const canvas = paint?.canvas;
    if (!canvas) return;
    // Paint stroke / eyedropper — keep it out of the graph's cursor
    // press facts.
    claimPointerGesture(e.pointerId);
    if (effectiveTool === "eyedropper") {
      e.preventDefault();
      sampleColor(e.clientX, e.clientY);
      return;
    }
    // A resolution change rescales the canvas — carry the Shift-line anchor
    // into the new pixel space so a pending connect line stays put.
    const preW = canvas.width;
    const preH = canvas.height;
    ensureCanvasRes(canvas);
    const scaleX = canvas.width / preW;
    const scaleY = canvas.height / preH;
    if (scaleX !== 1 || scaleY !== 1) {
      setLastEnd((p) => (p ? [p[0] * scaleX, p[1] * scaleY] : p));
    }
    const pt = toCanvasPx(e.clientX, e.clientY);
    if (!pt) return;
    e.preventDefault();
    if (effectiveTool === "fill") {
      captureBefore(canvas);
      if (floodFill(canvas, pt[0], pt[1], color, fillTolerance)) {
        snapshot(canvas);
        commitBefore(canvas);
      } else {
        beforeRef.current = null;
      }
      return;
    }
    // Brush / eraser / blur: begin a stroke session.
    captureBefore(canvas);
    const session = new StrokeSession(canvas, {
      mode:
        effectiveTool === "eraser"
          ? "erase"
          : effectiveTool === "blur"
            ? "blur"
            : "paint",
      color,
      size,
      brush,
      pressureCapable: e.pointerType === "pen",
    });
    const pressure = e.pressure || 0.5;
    // Shift-click: connect a straight line from the previous stroke's end
    // (Photoshop convention). The session then stays open, so a Shift-drag
    // keeps painting from the click point.
    const connectFrom =
      e.shiftKey && lastEnd
        ? ([lastEnd[0] * scaleX, lastEnd[1] * scaleY] as [number, number])
        : null;
    if (connectFrom) {
      session.down(connectFrom[0], connectFrom[1], pressure);
      session.lineTo(pt[0], pt[1], pressure);
    } else {
      session.down(pt[0], pt[1], pressure);
    }
    // Arm the Shift-drag axis lock from the press point.
    constraintRef.current = { anchor: pt, axis: null };
    sessionRef.current = session;
    setStroking(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    const tick = () => {
      sessionRef.current?.renderLive();
      snapshot(canvas);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    setCursor({ x: e.clientX, y: e.clientY });
    const session = sessionRef.current;
    if (!session) return;
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];
    for (const ev of events) {
      const pt = toCanvasPx(ev.clientX, ev.clientY);
      if (!pt) continue;
      if (ev.shiftKey) {
        // Shift-drag: lock to the dominant axis through the anchor. The
        // axis picks once movement clears a small threshold, so the first
        // jittery pixels don't decide it.
        const c = constraintRef.current;
        if (c) {
          if (!c.axis) {
            const dx = Math.abs(pt[0] - c.anchor[0]);
            const dy = Math.abs(pt[1] - c.anchor[1]);
            if (Math.max(dx, dy) > 4) c.axis = dx >= dy ? "h" : "v";
          }
          if (c.axis === "h") pt[1] = c.anchor[1];
          else if (c.axis === "v") pt[0] = c.anchor[0];
        }
      } else if (constraintRef.current) {
        // Shift released mid-stroke: back to freehand, and re-arm the lock
        // from wherever the stroke is now so a later Shift press anchors
        // here instead of the original press point.
        constraintRef.current = { anchor: pt, axis: null };
      }
      session.move(pt[0], pt[1], ev.pressure || 0.5);
    }
  };

  const endStroke = (e: ReactPointerEvent<HTMLDivElement>) => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    constraintRef.current = null;
    setStroking(false);
    cancelAnimationFrame(rafRef.current);
    session.end();
    // Remember where this stroke ended — the anchor for the next
    // Shift-click connect line.
    setLastEnd(session.position);
    const canvas = paint?.canvas;
    if (canvas) {
      snapshot(canvas);
      commitBefore(canvas);
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const onClear = () => {
    const canvas = paint?.canvas;
    if (!canvas) return;
    const c2d = canvas.getContext("2d");
    if (!c2d) return;
    ensureCanvasRes(canvas);
    captureBefore(canvas);
    c2d.clearRect(0, 0, canvas.width, canvas.height);
    snapshot(canvas);
    commitBefore(canvas);
  };

  // Brush-ring cursor: canvas-px size mapped to screen px through the rect,
  // so it scales with zoom exactly like the stroke it previews.
  const ringSize =
    rect && paint?.canvas ? (size * rect.width) / paint.canvas.width : 0;
  const showRing =
    cursor !== null &&
    ringSize > 0 &&
    (effectiveTool === "brush" ||
      effectiveTool === "eraser" ||
      effectiveTool === "blur");

  // Shift held with a previous stroke to connect from: preview the line a
  // click would draw, from the last stroke's end to the cursor.
  const connectPreview =
    shiftHeld &&
    !stroking &&
    lastEnd !== null &&
    cursor !== null &&
    rect !== null &&
    hostRect !== null &&
    paint?.canvas &&
    (effectiveTool === "brush" ||
      effectiveTool === "eraser" ||
      effectiveTool === "blur")
      ? {
          x1:
            rect.left -
            hostRect.left +
            (lastEnd[0] / paint.canvas.width) * rect.width,
          y1:
            rect.top -
            hostRect.top +
            (lastEnd[1] / paint.canvas.height) * rect.height,
          x2: cursor.x - hostRect.left,
          y2: cursor.y - hostRect.top,
        }
      : null;

  return (
    <>
      {/* Clip wrapper pinned to the viewport panel: a zoomed-in canvas
          extends past the panel, and strokes must not start from outside it.
          Pointer events pass through the wrapper (only the surface inside
          captures), so the zoom chip and window-level viewport gestures keep
          working. */}
      <div
        style={{
          position: "fixed",
          left: hostRect?.left ?? 0,
          top: hostRect?.top ?? 0,
          width: hostRect?.width ?? 0,
          height: hostRect?.height ?? 0,
          overflow: "hidden",
          pointerEvents: "none",
          background: "transparent",
        }}
      >
        {/* Pointer surface, exactly over the preview canvas's transformed
            rect. */}
        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
          onPointerLeave={() => {
            if (!sessionRef.current) setCursor(null);
          }}
          style={{
            position: "absolute",
            left: rect && hostRect ? rect.left - hostRect.left : 0,
            top: rect && hostRect ? rect.top - hostRect.top : 0,
            width: rect?.width ?? 0,
            height: rect?.height ?? 0,
            pointerEvents: "auto",
            touchAction: "none",
            cursor: showRing ? "none" : "crosshair",
          }}
        />
        {/* Shift connect-line preview — dashed, dark casing under a light
            dash so it reads on any background. */}
        {connectPreview && (
          <svg
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              pointerEvents: "none",
            }}
          >
            <line
              x1={connectPreview.x1}
              y1={connectPreview.y1}
              x2={connectPreview.x2}
              y2={connectPreview.y2}
              stroke="rgba(0,0,0,0.6)"
              strokeWidth={3}
            />
            <line
              x1={connectPreview.x1}
              y1={connectPreview.y1}
              x2={connectPreview.x2}
              y2={connectPreview.y2}
              stroke="color-mix(in srgb, var(--tb-lift) 90%, transparent)"
              strokeWidth={1}
              strokeDasharray="4 4"
            />
          </svg>
        )}
        {/* The ring itself — dual outline (light over dark) so it reads on
            any background. Positioned in wrapper-local coords. */}
        {showRing && hostRect && (
          <div
            style={{
              position: "absolute",
              left: cursor.x - hostRect.left - ringSize / 2,
              top: cursor.y - hostRect.top - ringSize / 2,
              width: ringSize,
              height: ringSize,
              borderRadius: "50%",
              border: "1px solid color-mix(in srgb, var(--tb-lift) 90%, transparent)",
              boxShadow: "0 0 0 1px rgba(0,0,0,0.6)",
              pointerEvents: "none",
              boxSizing: "border-box",
            }}
          />
        )}
      </div>
      {hostRect && (
        <>
          <PaintToolDock
            left={hostRect.left + 10}
            top={hostRect.top + 10}
            tool={tool}
            onSelectTool={setTool}
            onClear={onClear}
          />
          <PaintBrushShelf
            right={Math.max(10, window.innerWidth - hostRect.right + 10)}
            top={hostRect.top + 10}
            size={size}
            hardness={brush.hardness}
            onSizeChange={(v) =>
              onChangeRef.current(nodeIdRef.current, "size", v)
            }
            onHardnessChange={(v) =>
              onChangeRef.current(nodeIdRef.current, "brush", {
                ...brush,
                hardness: v,
              })
            }
            onEditBrush={() =>
              // The Brush Editor window is owned by the ParamPanel's
              // PaintBrushSection (it holds preset state); toggle it from
              // here via the app's window-event pattern.
              window.dispatchEvent(
                new CustomEvent("paint-brush-editor-toggle", {
                  detail: { nodeId: nodeIdRef.current },
                })
              )
            }
          />
        </>
      )}
    </>
  );
}
