"use client";

// The Paint node's on-canvas editor (071926_paint-toolkit.md). Replaces the
// old Atrament wrapper with the in-house stamp engine (./engine.ts) and a
// spline-draw-style tool dock: brush / eraser / blur / fill / eyedropper +
// Clear (+ Flatten when an image is wired).
//
// Interaction model (unchanged from the original overlay): painting is gated
// on the paint node being SELECTED; the paint canvas itself is never shown —
// strokes appear through the pipeline as rendered by the active node, so you
// paint and see the end-of-chain result live (a rAF loop snapshots the
// canvas mid-stroke to drive re-evals). Undo rides the dedicated paint lane:
// every completed action (stroke, fill, clear, flatten) commits the
// pre-action pixels of the surfaces it touched through onStrokeCommit —
// strokes only their bbox.
//
// Image input (101526_paint-selection-transform.md §1): with an image wired,
// the node also owns a `knockout` canvas (alpha 1 = hide the input). The
// eraser mirrors into it so it erases what you see, input included; Clear
// resets both; Flatten bakes the current input into the edit layer and
// knocks the live input out entirely.
//
// Selection (101526 §2/§3, M1): rectangular + elliptical marquee into a
// per-node mask (./selection.ts). Every paint tool clips to it; Delete
// clears it, Alt+Backspace fills it; Cmd+A / Cmd+D / Cmd+Shift+D /
// Cmd+Shift+I select all / deselect / reselect / invert. Marching ants trace
// the mask's pixel edges. Selection changes ride the paint undo lane like
// pixel edits. The Cmd/Delete shortcuts belong to the canvas only while it
// has FOCUS — the last pointerdown landed on the paint surface or its docks
// (§7) — so the graph keeps them otherwise.
//
// Move + clipboard (101526 §4, M2): the Move tool (V) lifts the selection's
// composite pixels (input included) into a FLOATING selection
// (./floating.ts), leaving a hole — Alt-drag duplicates instead. Arrows
// nudge (Shift = 10 px). The float commits on Enter, a tool switch, any
// other edit, or deselecting the node; Escape (or Cmd+Z) cancels. Cmd+C /
// Cmd+X copy the composite under the selection to an internal clipboard
// and, as PNG, the OS clipboard; Cmd+V pastes the internal clip in place or
// an OS image centered (fit), as a new float.
//
// Free transform (101526 §5, M3): with the Move tool active, transform
// handles frame the selection (or the float) — no Cmd+T. Corners scale
// proportionally (Shift frees them), edges scale one axis, Alt scales about
// the center, Cmd/Ctrl-drag an edge skews, the ring just outside a corner
// rotates (Shift snaps 15°), inside moves. Grabbing a handle on a plain
// selection lifts it first. Every drag rebuilds the float's matrix from the
// matrix at press (./transform.ts), so the source resamples once, at
// commit. The shelf shows W / H % · angle · X / Y (editable) and flips.
//
// More selection (101526 §3, M4): freehand Lasso and Polygonal Lasso (L;
// Shift+L toggles — click vertices, close on the first vertex / double-click
// / Enter, Backspace pops one, Shift snaps 45°), and the Magic Wand (W:
// tolerance, contiguous, anti-alias). The wand and Fill sample the
// COMPOSITE — what you see, input included — via a full input readback.
// Selection shelf: Feather / Expand / Contract by N px, Select painted.
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
import { requestPaintInput } from "@/engine/paint-input-registry";
import {
  affineBounds,
  applyAffine,
  compose,
  compositeUnderSelection,
  copyCanvas,
  fitCentered,
  getPixelClip,
  newCanvas,
  placeMask,
  renderFloating,
  restoreFrom,
  setPixelClip,
  stampIntoBase,
  translation,
  writeOsClipboard,
  type Affine,
  type Floating,
  type PixelClip,
} from "./floating";
import type { PaintSurfaceSnapshot } from "@/state/history";
import { rectsEqual } from "../overlay-rect";
import { resolveBrush } from "./brushes";
import {
  PaintBrushShelf,
  PaintMoveShelf,
  PaintSelectionShelf,
  PaintToolDock,
} from "./dock";
import { cloneCanvas, floodFill, StrokeSession } from "./engine";
import {
  alphaEdges,
  clearMask,
  combineIntoMask,
  combinePolygon,
  combineRegion,
  featherMask,
  floodRegion,
  growMask,
  pointsBBox,
  selectPainted,
  snap45,
  copyMask,
  eraseSelection,
  fillMask,
  fillSelection,
  invertMask,
  marqueeRect,
  maskBBox,
  maskEdges,
  peekSelectionMask,
  rememberForReselect,
  reselectSource,
  restoreOutsideSelection,
  selectionMask,
  unionRect,
  type PxRect,
  type SelectionMode,
} from "./selection";
import { claimPointerGesture } from "@/lib/pointer-claim";
import { RULER_SIZE, VERTICAL_RULER_SIDE } from "../ViewportRulers";
import {
  buildTransform,
  dragTransform,
  flipTransform,
  handleCursor,
  handlePoints,
  hitGizmo,
  readTransform,
  type DragKind,
  type GizmoHit,
  type TransformReadout,
} from "./transform";
import {
  isLassoTool,
  isMarqueeTool,
  isSelectionTool,
  type PaintTool,
} from "./types";

interface Props {
  nodeId: string;
  params: Record<string, unknown>;
  canvasRes: [number, number];
  // The visible preview canvas: rect source for coordinate mapping, and the
  // eyedropper's sample target (it holds the composited pipeline output).
  previewCanvas: HTMLCanvasElement | null;
  // An image is wired into the node's `image` input — gates the eraser's
  // knockout mirror and the Flatten action.
  hasInput: boolean;
  onParamChange: (nodeId: string, paramName: string, value: unknown) => void;
  // Fires after each completed action (stroke / fill / clear / flatten)
  // with the pre-action pixels of every surface it touched so the caller
  // can push them onto the undo stack.
  onStrokeCommit?: (nodeId: string, surfaces: PaintSurfaceSnapshot[]) => void;
  // Viewport rulers are up — inset the docks so they clear the bars.
  rulersVisible?: boolean;
}

type SurfaceParam = "paint" | "knockout";

// The current selection as the overlay renders and clips with it: the mask's
// selected bbox and its pixel-edge runs (marching ants). Null = no selection.
interface SelectionView {
  bbox: PxRect;
  edges: Int32Array;
  // Canvas size the edges were traced at (they're in canvas px).
  w: number;
  h: number;
}

// A marquee drag in flight (canvas px).
interface MarqueeDrag {
  shape: "rect" | "ellipse";
  mode: SelectionMode;
  start: [number, number];
  cur: [number, number];
  pressClient: [number, number];
  // Photoshop: a modifier held AT PRESS picks the combine mode; it only
  // starts constraining (square / from-center) once released and re-pressed.
  shiftAtPress: boolean;
  altAtPress: boolean;
  shiftReleased: boolean;
  altReleased: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

// A lasso in progress (canvas px). Freehand collects the drag path; the
// polygonal one collects clicked vertices until it closes.
interface LassoDraft {
  kind: "free" | "poly";
  mode: SelectionMode;
  pts: [number, number][];
  // Polygonal: the last click (double-click closes).
  lastClick: { t: number; x: number; y: number } | null;
}

// Combine mode from the modifiers held at a selection tool's press
// (Photoshop): Shift add, Alt subtract, both intersect, else the shelf's.
function modeFromMods(e: { shiftKey: boolean; altKey: boolean }, fallback: SelectionMode): SelectionMode {
  return e.shiftKey && e.altKey
    ? "intersect"
    : e.shiftKey
      ? "add"
      : e.altKey
        ? "subtract"
        : fallback;
}

// A Move-tool drag in flight (canvas px). The lift may still be waiting on
// the input readback, so the pointer path is tracked independently and
// applied once the float exists.
interface MoveDrag {
  // What the press grabbed (move = the pixels; scale / rotate / skew = a
  // gizmo handle, `handle` its index — see transform.ts).
  kind: DragKind;
  handle: number;
  startPt: [number, number];
  lastPt: [number, number];
  pressClient: [number, number];
  // Live modifiers: Alt = duplicate (move) / about-center (scale); Shift =
  // free corners (scale) / 15° snap (rotate).
  alt: boolean;
  shift: boolean;
  // The float's matrix at press (null until the lift lands).
  startMatrix: Affine | null;
  lifting: boolean;
  // Alt-drag of an EXISTING float has stamped its copy (once per drag).
  stamped: boolean;
}

// Rotate cursor for the ring outside the gizmo's corners: a light curved
// arrow with a dark casing, hotspot at its center.
const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M6 13a6 6 0 1 0 2-5.2M5 4v4h4" stroke="#000" stroke-width="4"/>' +
    '<path d="M6 13a6 6 0 1 0 2-5.2M5 4v4h4" stroke="#fff" stroke-width="1.6"/>' +
    "</g></svg>"
)}") 12 12, alias`;

// Pad a rect (and clamp it to the canvas) — undo regions cover the soft
// antialiased fringe the 50% bbox threshold leaves out.
function padRect(r: PxRect, pad: number, w: number, h: number): PxRect {
  const x = Math.max(0, r.x - pad);
  const y = Math.max(0, r.y - pad);
  return {
    x,
    y,
    w: Math.min(w, r.x + r.w + pad) - x,
    h: Math.min(h, r.y + r.h + pad) - y,
  };
}

export default function PaintOverlay({
  nodeId,
  params,
  canvasRes,
  previewCanvas,
  hasInput,
  onParamChange,
  onStrokeCommit,
  rulersVisible = false,
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
  // The knockout canvas, once created. Mirrored into a ref so a canvas
  // minted mid-gesture (first erase / flatten) is usable before the param
  // change round-trips through a render.
  const knockoutParam = (params.knockout as PaintParamValue | null) ?? null;
  const knockoutRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (knockoutParam?.canvas) knockoutRef.current = knockoutParam.canvas;
  }, [knockoutParam]);
  const [flattening, setFlattening] = useState(false);
  const color = (params.color as string) ?? "#ffffff";
  const size = typeof params.size === "number" ? (params.size as number) : 12;
  const fillTolerance =
    typeof params.fill_tolerance === "number"
      ? (params.fill_tolerance as number)
      : 0.05;
  const brush = useMemo(() => resolveBrush(params.brush), [params.brush]);

  const [tool, setTool] = useState<PaintTool>("brush");
  // Tool switches go through selectTool (below) so a float commits first;
  // the once-bound key handler reaches it through this ref.
  const selectToolRef = useRef<(t: PaintTool) => void>(setTool);
  const pickVariantRef = useRef<
    (family: "marquee" | "lasso", toggle: boolean) => void
  >(() => {});
  // The marquee shape M returns to (Shift+M toggles it).
  const [lastMarquee, setLastMarquee] = useState<
    "marquee-rect" | "marquee-ellipse"
  >("marquee-rect");
  // The lasso variant L returns to (Shift+L toggles it).
  const [lastLasso, setLastLasso] = useState<"lasso" | "lasso-poly">("lasso");
  // Lasso in progress + its preview (the cursor drives the polygon's
  // rubber band).
  const lassoRef = useRef<LassoDraft | null>(null);
  const [lassoView, setLassoView] = useState<{
    kind: "free" | "poly";
    pts: [number, number][];
    cursor: [number, number] | null;
    closeHint: boolean;
  } | null>(null);
  // Magic wand settings (editor session).
  const [wandTolerance, setWandTolerance] = useState(0.12);
  const [wandContiguous, setWandContiguous] = useState(true);
  const [wandAntiAlias, setWandAntiAlias] = useState(true);
  // Selection modify amount (px) for Feather / Expand / Contract.
  const [modifyPx, setModifyPx] = useState(4);
  // Combine mode for a plain (unmodified) marquee drag — the shelf buttons.
  const [selMode, setSelMode] = useState<SelectionMode>("new");
  const [sel, setSel] = useState<SelectionView | null>(null);
  const selRef = useRef<SelectionView | null>(null);
  // Live marquee preview (canvas px) + the drag bookkeeping behind it.
  const [marqueeBox, setMarqueeBox] = useState<{
    rect: PxRect;
    shape: "rect" | "ellipse";
  } | null>(null);
  const marqueeRef = useRef<MarqueeDrag | null>(null);
  // Space held during a marquee drag repositions it (Photoshop).
  const spaceRef = useRef(false);
  // Canvas focus (§7): last pointerdown was on the paint surface / docks.
  const focusedRef = useRef(false);
  // The floating selection (§4) and what the overlay renders of it (its
  // ants through the matrix).
  const floatingRef = useRef<Floating | null>(null);
  const [floatView, setFloatView] = useState<{
    matrix: Affine;
    edges: Int32Array;
    content: PxRect;
  } | null>(null);
  const moveRef = useRef<MoveDrag | null>(null);
  // What a press would grab under the cursor (drives the Move cursor).
  const [hoverHit, setHoverHit] = useState<GizmoHit | null>(null);
  const floatRafRef = useRef(0);
  // A lift waiting on the input readback (a second one must not start).
  const liftingRef = useRef(false);
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
  // Dock gap from the viewport edges; the ruler bars (top + one side) push
  // it in by their thickness so the docks sit fully inside them.
  const DOCK_GAP = 10;
  const dockInset = {
    top: DOCK_GAP + (rulersVisible ? RULER_SIZE : 0),
    left:
      DOCK_GAP +
      (rulersVisible && VERTICAL_RULER_SIDE === "left" ? RULER_SIZE : 0),
    right:
      DOCK_GAP +
      (rulersVisible && VERTICAL_RULER_SIDE === "right" ? RULER_SIZE : 0),
  };
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
    // The knockout tracks the edit layer's resolution too.
    if (knockoutRef.current && knockoutRef.current !== canvas) {
      resizeSurface(knockoutRef.current);
    }
    const resized =
      canvas.width !== canvasRes[0] || canvas.height !== canvasRes[1];
    resizeSurface(canvas);
    // …and so does the selection (selectionMask rescales it on a size
    // change); its ants were traced in the old pixel space.
    if (resized && selRef.current) refreshSelection(getMask(canvas));
  };
  const resizeSurface = (canvas: HTMLCanvasElement) => {
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
      if (k === "m") {
        // M = marquee (last shape); Shift+M toggles rect ↔ ellipse.
        pickVariantRef.current("marquee", e.shiftKey);
      } else if (k === "l") {
        // L = lasso (last kind); Shift+L toggles freehand ↔ polygonal.
        pickVariantRef.current("lasso", e.shiftKey);
      } else if (k === "w") selectToolRef.current("wand");
      else if (k === "v") selectToolRef.current("move");
      else if (k === "b") selectToolRef.current("brush");
      else if (k === "e") selectToolRef.current("eraser");
      else if (k === "g") selectToolRef.current("fill");
      else if (k === "i") selectToolRef.current("eyedropper");
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
  const beforeRef = useRef<PaintSurfaceSnapshot[] | null>(null);
  const rafRef = useRef(0);
  // The knockout the in-flight stroke mirrors into (eraser + input only).
  const strokeKnockoutRef = useRef<HTMLCanvasElement | null>(null);
  const snapshotPendingRef = useRef<Record<SurfaceParam, boolean>>({
    paint: false,
    knockout: false,
  });

  const snapshotTrailingRef = useRef<
    Record<SurfaceParam, HTMLCanvasElement | null>
  >({ paint: null, knockout: null });

  const snapshot = (
    canvas: HTMLCanvasElement,
    param: SurfaceParam = "paint"
  ) => {
    // One createImageBitmap in flight per surface. A request that lands
    // meanwhile isn't dropped — it re-runs once the pending one settles, so
    // an action's final pixels (stroke end, fill, clear) always publish.
    if (snapshotPendingRef.current[param]) {
      snapshotTrailingRef.current[param] = canvas;
      return;
    }
    snapshotPendingRef.current[param] = true;
    // PREMULTIPLIED on purpose (the default): the Paint node's textures hold
    // the canvas's native premultiplied pixels and its shaders divide alpha
    // back out (paint.ts bitmapTexture). A premultiplied bitmap of an
    // accelerated canvas is a zero-copy GPU reference; `premultiplyAlpha:
    // "none"` would read the whole canvas back to the CPU every live frame
    // (20–43 ms at 3k–4k). WebGL ignores the UNPACK premultiply flag for
    // ImageBitmaps, so this creation-time choice IS the upload format — keep
    // it in step with EffectsApp's onPaintRestore and project.ts's load.
    createImageBitmap(canvas)
      .then((bmp) => {
        onChangeRef.current(nodeIdRef.current, param, {
          canvas,
          snapshot: bmp,
        });
      })
      .finally(() => {
        snapshotPendingRef.current[param] = false;
        const trailing = snapshotTrailingRef.current[param];
        if (trailing) {
          snapshotTrailingRef.current[param] = null;
          snapshot(trailing, param);
        }
      });
  };

  // The knockout canvas, created (empty, edit-layer sized) on first need.
  const ensureKnockout = (edit: HTMLCanvasElement): HTMLCanvasElement => {
    const existing = knockoutRef.current;
    if (existing) return existing;
    const ko = document.createElement("canvas");
    ko.width = edit.width;
    ko.height = edit.height;
    knockoutRef.current = ko;
    onChangeRef.current(nodeIdRef.current, "knockout", {
      canvas: ko,
      snapshot: null,
    });
    return ko;
  };

  // Full-canvas before-state, for the whole-canvas actions (fill, clear,
  // flatten); strokes record their own bbox instead.
  const captureBefore = (canvases: HTMLCanvasElement[]) => {
    beforeRef.current = canvases.flatMap((canvas) => {
      const imageData = canvas
        .getContext("2d")
        ?.getImageData(0, 0, canvas.width, canvas.height);
      return imageData ? [{ canvas, x: 0, y: 0, imageData }] : [];
    });
  };

  const commitBefore = () => {
    const surfaces = beforeRef.current;
    beforeRef.current = null;
    if (surfaces && surfaces.length > 0) {
      onCommitRef.current?.(nodeIdRef.current, surfaces);
    }
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

  // ── Selection ─────────────────────────────────────────────────────
  const getMask = (canvas: HTMLCanvasElement) =>
    selectionMask(nodeIdRef.current, canvas.width, canvas.height);

  // Re-derive the rendered selection (bbox + ants) from the mask's pixels.
  const refreshSelection = (mask: HTMLCanvasElement) => {
    const bbox = maskBBox(mask);
    const view = bbox
      ? { bbox, edges: maskEdges(mask, bbox), w: mask.width, h: mask.height }
      : null;
    selRef.current = view;
    setSel(view);
  };

  // The clip mask for paint tools: the mask while a selection exists.
  const activeClip = (canvas: HTMLCanvasElement) =>
    selRef.current ? getMask(canvas) : null;

  // Change the selection as one undoable step: record the mask pixels in
  // `region` (null = the whole mask), mutate, re-derive, commit.
  const changeSelection = (
    canvas: HTMLCanvasElement,
    region: PxRect | null,
    mutate: (mask: HTMLCanvasElement) => void
  ) => {
    const mask = getMask(canvas);
    const r = region
      ? padRect(region, 2, mask.width, mask.height)
      : { x: 0, y: 0, w: mask.width, h: mask.height };
    const before =
      r.w > 0 && r.h > 0
        ? mask.getContext("2d")?.getImageData(r.x, r.y, r.w, r.h)
        : undefined;
    mutate(mask);
    refreshSelection(mask);
    if (before) {
      onCommitRef.current?.(nodeIdRef.current, [
        { canvas: mask, x: r.x, y: r.y, imageData: before },
      ]);
    }
  };

  const selectAll = () => {
    commitFloating();
    const canvas = paint?.canvas;
    if (!canvas) return;
    ensureCanvasRes(canvas);
    changeSelection(canvas, null, fillMask);
  };

  const deselect = () => {
    commitFloating();
    const canvas = paint?.canvas;
    const cur = selRef.current;
    if (!canvas || !cur) return;
    rememberForReselect(nodeIdRef.current);
    changeSelection(canvas, cur.bbox, clearMask);
  };

  const reselect = () => {
    commitFloating();
    const canvas = paint?.canvas;
    if (!canvas) return;
    ensureCanvasRes(canvas);
    const src = reselectSource(nodeIdRef.current);
    if (!src) return;
    changeSelection(canvas, null, (mask) => copyMask(mask, src));
  };

  const invertSelection = () => {
    commitFloating();
    const canvas = paint?.canvas;
    if (!canvas || !selRef.current) return;
    ensureCanvasRes(canvas);
    changeSelection(canvas, null, invertMask);
  };

  // Delete: clear the edit layer inside the selection — and, with an image
  // wired, hide the input there too (the knockout gets the mask).
  const deleteInSelection = () => {
    // Delete while floating drops the floating pixels (the hole stays).
    const f = floatingRef.current;
    if (f) {
      f.source.getContext("2d")?.clearRect(0, 0, f.source.width, f.source.height);
      commitFloating();
      return;
    }
    const canvas = paint?.canvas;
    const cur = selRef.current;
    if (!canvas || !cur) return;
    ensureCanvasRes(canvas);
    const knockout = hasInput ? ensureKnockout(canvas) : knockoutRef.current;
    const r = padRect(cur.bbox, 2, canvas.width, canvas.height);
    const surfaces = [canvas, ...(knockout ? [knockout] : [])].flatMap(
      (c) => {
        const imageData = c.getContext("2d")?.getImageData(r.x, r.y, r.w, r.h);
        return imageData ? [{ canvas: c, x: r.x, y: r.y, imageData }] : [];
      }
    );
    eraseSelection(canvas, hasInput ? knockout : null, getMask(canvas));
    snapshot(canvas);
    if (knockout && hasInput) snapshot(knockout, "knockout");
    onCommitRef.current?.(nodeIdRef.current, surfaces);
  };

  // Alt+Backspace: fill the selection (no selection = the whole canvas)
  // with the current color.
  const fillInSelection = () => {
    commitFloating();
    const canvas = paint?.canvas;
    if (!canvas) return;
    ensureCanvasRes(canvas);
    const cur = selRef.current;
    const r = cur
      ? padRect(cur.bbox, 2, canvas.width, canvas.height)
      : { x: 0, y: 0, w: canvas.width, h: canvas.height };
    const before = canvas.getContext("2d")?.getImageData(r.x, r.y, r.w, r.h);
    fillSelection(canvas, cur ? getMask(canvas) : null, color);
    snapshot(canvas);
    if (before) {
      onCommitRef.current?.(nodeIdRef.current, [
        { canvas, x: r.x, y: r.y, imageData: before },
      ]);
    }
  };

  // ── Floating selection (§4) ─────────────────────────────────────
  const publishFloatView = (f: Floating | null) =>
    setFloatView(
      f ? { matrix: f.matrix, edges: f.edges, content: f.content } : null
    );

  // Re-render edit = base + float on the next frame (pointer moves arrive
  // faster than frames).
  const scheduleFloatRender = () => {
    if (floatRafRef.current) return;
    floatRafRef.current = requestAnimationFrame(() => {
      floatRafRef.current = 0;
      const f = floatingRef.current;
      const canvas = paint?.canvas;
      if (!f || !canvas) return;
      renderFloating(canvas, f);
      snapshot(canvas);
      publishFloatView(f);
    });
  };

  const setFloatMatrix = (f: Floating, m: Affine) => {
    const canvas = paint?.canvas;
    f.matrix = m;
    if (canvas) {
      const b = affineBounds(m, f.source.width, f.source.height, canvas.width, canvas.height);
      f.touched = unionRect(f.touched, b);
    }
    scheduleFloatRender();
  };

  // The float's matrix for a Move-tool drag, from its matrix at press.
  const dragMatrix = (md: MoveDrag, f: Floating): Affine | null => {
    const m0 = md.startMatrix;
    if (!m0) return null;
    if (md.kind === "move") {
      return compose(
        translation(md.lastPt[0] - md.startPt[0], md.lastPt[1] - md.startPt[1]),
        m0
      );
    }
    return dragTransform(md.kind, md.handle, m0, f.content, md.startPt, md.lastPt, {
      shift: md.shift,
      alt: md.alt,
    });
  };

  const applyMoveDrag = (md: MoveDrag) => {
    const f = floatingRef.current;
    if (!f) return;
    const m = dragMatrix(md, f);
    if (m) setFloatMatrix(f, m);
  };

  // Shelf edits (W / H / angle / X / Y, flips) — lifting the selection first
  // when nothing floats yet.
  const withFloat = (fn: (f: Floating) => void) => {
    const f = floatingRef.current;
    if (f) {
      fn(f);
      return;
    }
    if (!selRef.current) return;
    void beginLift(false).then((ok) => {
      const nf = floatingRef.current;
      if (ok && nf) fn(nf);
    });
  };

  const editReadout = (patch: Partial<TransformReadout>) =>
    withFloat((f) =>
      setFloatMatrix(
        f,
        buildTransform({ ...readTransform(f.matrix, f.content), ...patch }, f.content)
      )
    );

  const flipFloat = (axis: "h" | "v") =>
    withFloat((f) => setFloatMatrix(f, flipTransform(f.matrix, f.content, axis)));

  // Start floating `source`/`mask` (source px) at `matrix` over `base`.
  // `before` are the pre-float copies (cancel + undo).
  const startFloating = (
    canvas: HTMLCanvasElement,
    pieces: {
      source: HTMLCanvasElement;
      mask: HTMLCanvasElement;
      content: PxRect;
    },
    matrix: Affine,
    before: Floating["before"],
    touched: PxRect | null
  ) => {
    const { source, mask, content } = pieces;
    const mdata = mask
      .getContext("2d")
      ?.getImageData(0, 0, mask.width, mask.height).data;
    const f: Floating = {
      source,
      mask,
      matrix,
      content,
      base: copyCanvas(canvas),
      before,
      touched: unionRect(
        touched,
        affineBounds(matrix, source.width, source.height, canvas.width, canvas.height)
      ),
      edges: mdata ? alphaEdges(mdata, mask.width, mask.height) : new Int32Array(0),
    };
    floatingRef.current = f;
    renderFloating(canvas, f);
    snapshot(canvas);
    publishFloatView(f);
  };

  // Lift the selection (no selection = everything) into a float: pick up
  // the composite under it, then — unless duplicating — cut the hole (edit
  // cleared there, input knocked out). Resolves false if the input couldn't
  // be read or the canvas changed underneath.
  const beginLift = async (duplicate: boolean): Promise<boolean> => {
    const canvas = paint?.canvas;
    if (!canvas || floatingRef.current || liftingRef.current) return false;
    ensureCanvasRes(canvas);
    const W = canvas.width;
    const H = canvas.height;
    const mask = getMask(canvas);
    const before: Floating["before"] = {
      edit: copyCanvas(canvas),
      knockout: knockoutRef.current ? copyCanvas(knockoutRef.current) : null,
      selection: copyCanvas(mask),
    };
    if (!selRef.current) {
      // Move with nothing selected moves everything (Photoshop).
      fillMask(mask);
      refreshSelection(mask);
    }
    const sel = selRef.current;
    if (!sel) return false;
    const bbox = padRect(sel.bbox, 2, W, H);
    let input: Uint8ClampedArray<ArrayBuffer> | null = null;
    if (hasInput) {
      liftingRef.current = true;
      const req = requestPaintInput(nodeIdRef.current, W, H, bbox);
      window.dispatchEvent(new Event("pipeline-bump"));
      const px = await req;
      liftingRef.current = false;
      if (!px || canvas.width !== W || canvas.height !== H) {
        console.warn("[paint] Move: the input image wasn't readable — lift cancelled");
        restoreFrom(mask, before.selection!);
        refreshSelection(mask);
        return false;
      }
      input = px.data;
    }
    const pieces = compositeUnderSelection(
      canvas,
      knockoutRef.current,
      input,
      mask,
      bbox
    );
    if (!duplicate) {
      const ko = hasInput ? ensureKnockout(canvas) : null;
      eraseSelection(canvas, ko, mask);
      if (ko) snapshot(ko, "knockout");
    }
    const content = {
      x: sel.bbox.x - bbox.x,
      y: sel.bbox.y - bbox.y,
      w: sel.bbox.w,
      h: sel.bbox.h,
    };
    startFloating(
      canvas,
      { ...pieces, content },
      translation(bbox.x, bbox.y),
      before,
      bbox
    );
    return true;
  };

  // Keep the float: the edit canvas already shows it; the selection moves
  // to where the pixels landed; one undo entry restores the pre-float state
  // over everything the float touched.
  const commitFloating = () => {
    const f = floatingRef.current;
    const canvas = paint?.canvas;
    if (!f || !canvas) return;
    floatingRef.current = null;
    moveRef.current = null;
    cancelAnimationFrame(floatRafRef.current);
    floatRafRef.current = 0;
    renderFloating(canvas, f);
    const mask = getMask(canvas);
    placeMask(mask, f);
    refreshSelection(mask);
    snapshot(canvas);
    setFloatView(null);
    const touched = f.touched;
    if (!touched) return;
    const r = padRect(touched, 2, canvas.width, canvas.height);
    const crop = (c: HTMLCanvasElement | null) =>
      c?.getContext("2d")?.getImageData(r.x, r.y, r.w, r.h) ??
      new ImageData(r.w, r.h);
    const surfaces: PaintSurfaceSnapshot[] = [
      { canvas, x: r.x, y: r.y, imageData: crop(f.before.edit) },
      { canvas: mask, x: r.x, y: r.y, imageData: crop(f.before.selection) },
    ];
    const ko = knockoutRef.current;
    if (ko) {
      surfaces.push({ canvas: ko, x: r.x, y: r.y, imageData: crop(f.before.knockout) });
    }
    onCommitRef.current?.(nodeIdRef.current, surfaces);
  };

  // Drop the float and put everything back as it was before it.
  const cancelFloating = () => {
    const f = floatingRef.current;
    const canvas = paint?.canvas;
    if (!f || !canvas) return;
    floatingRef.current = null;
    moveRef.current = null;
    cancelAnimationFrame(floatRafRef.current);
    floatRafRef.current = 0;
    restoreFrom(canvas, f.before.edit);
    const ko = knockoutRef.current;
    if (ko) {
      if (f.before.knockout) restoreFrom(ko, f.before.knockout);
      else ko.getContext("2d")?.clearRect(0, 0, ko.width, ko.height);
      snapshot(ko, "knockout");
    }
    const mask = getMask(canvas);
    if (f.before.selection) restoreFrom(mask, f.before.selection);
    refreshSelection(mask);
    snapshot(canvas);
    setFloatView(null);
  };

  // Arrow keys: Move tool nudges the pixels (lifting first if needed);
  // the marquee nudges just the outline.
  const nudge = (dx: number, dy: number) => {
    const canvas = paint?.canvas;
    if (!canvas) return;
    const f = floatingRef.current;
    if (f) {
      setFloatMatrix(f, compose(translation(dx, dy), f.matrix));
      return;
    }
    if (!selRef.current) return;
    if (tool === "move") {
      void beginLift(false).then((ok) => {
        const nf = floatingRef.current;
        if (ok && nf) setFloatMatrix(nf, compose(translation(dx, dy), nf.matrix));
      });
      return;
    }
    if (isMarqueeTool(tool)) {
      const cur = selRef.current;
      changeSelection(
        canvas,
        unionRect(cur.bbox, { ...cur.bbox, x: cur.bbox.x + dx, y: cur.bbox.y + dy }),
        (mask) => {
          const copy = copyCanvas(mask);
          clearMask(mask);
          mask.getContext("2d")?.drawImage(copy, dx, dy);
        }
      );
    }
  };

  // ── Clipboard (§4) ──
  // The pixels under the selection (or the float), as a clip.
  const captureClip = async (): Promise<PixelClip | null> => {
    const canvas = paint?.canvas;
    if (!canvas) return null;
    const f = floatingRef.current;
    if (f) {
      return {
        source: copyCanvas(f.source),
        mask: copyCanvas(f.mask),
        content: f.content,
        matrix: f.matrix,
      };
    }
    const sel = selRef.current;
    if (!sel) return null;
    const W = canvas.width;
    const H = canvas.height;
    const bbox = padRect(sel.bbox, 2, W, H);
    let input: Uint8ClampedArray<ArrayBuffer> | null = null;
    if (hasInput) {
      const req = requestPaintInput(nodeIdRef.current, W, H, bbox);
      window.dispatchEvent(new Event("pipeline-bump"));
      const px = await req;
      if (!px || canvas.width !== W || canvas.height !== H) return null;
      input = px.data;
    }
    const pieces = compositeUnderSelection(
      canvas,
      knockoutRef.current,
      input,
      getMask(canvas),
      bbox
    );
    return {
      ...pieces,
      content: {
        x: sel.bbox.x - bbox.x,
        y: sel.bbox.y - bbox.y,
        w: sel.bbox.w,
        h: sel.bbox.h,
      },
      matrix: translation(bbox.x, bbox.y),
    };
  };

  const copySelection = (cut: boolean) => {
    const pending = captureClip();
    // Start the OS write inside the key gesture; the PNG follows.
    writeOsClipboard(pending.then((c) => c?.source ?? null));
    void pending.then((c) => {
      if (!c) return;
      setPixelClip(c);
      if (cut) deleteInSelection();
    });
  };

  // Paste a clip as a new float over the current edit layer (no hole).
  const pasteClip = (clip: PixelClip, matrix: Affine) => {
    const canvas = paint?.canvas;
    if (!canvas) return;
    commitFloating();
    ensureCanvasRes(canvas);
    const mask = getMask(canvas);
    const before: Floating["before"] = {
      edit: copyCanvas(canvas),
      knockout: knockoutRef.current ? copyCanvas(knockoutRef.current) : null,
      selection: copyCanvas(mask),
    };
    startFloating(
      canvas,
      {
        source: copyCanvas(clip.source),
        mask: copyCanvas(clip.mask),
        content: clip.content,
      },
      matrix,
      before,
      null
    );
    selectTool("move");
  };

  // An OS image (or the internal clip, recognised by its size — our own
  // copy round-trips through the OS clipboard as a same-size PNG).
  const pasteImage = async (file: File | null) => {
    const canvas = paint?.canvas;
    if (!canvas) return;
    const internal = getPixelClip();
    if (file) {
      let bmp: ImageBitmap;
      try {
        // Only ever drawn into a 2D canvas (which premultiplies anyway), so
        // the cheap default bitmap is the right one.
        bmp = await createImageBitmap(file);
      } catch {
        if (internal) pasteInternal(internal);
        return;
      }
      if (
        internal &&
        bmp.width === internal.source.width &&
        bmp.height === internal.source.height
      ) {
        bmp.close();
        pasteInternal(internal);
        return;
      }
      const source = newCanvas(bmp.width, bmp.height);
      source.getContext("2d")?.drawImage(bmp, 0, 0);
      const mask = newCanvas(bmp.width, bmp.height);
      const mctx = mask.getContext("2d");
      if (mctx) {
        mctx.fillStyle = "#ffffff";
        mctx.fillRect(0, 0, mask.width, mask.height);
      }
      const m = fitCentered(bmp.width, bmp.height, canvas.width, canvas.height);
      bmp.close();
      pasteClip(
        {
          source,
          mask,
          content: { x: 0, y: 0, w: source.width, h: source.height },
          matrix: m,
        },
        m
      );
      return;
    }
    if (internal) pasteInternal(internal);
  };

  // Internal clips paste in place (where they were copied from).
  const pasteInternal = (clip: PixelClip) => pasteClip(clip, clip.matrix);

  // Tool switches commit a float (except staying on Move).
  const selectTool = (t: PaintTool) => {
    if (t !== "move") commitFloating();
    if (t !== tool) cancelLasso();
    if (isMarqueeTool(t)) setLastMarquee(t);
    if (isLassoTool(t)) setLastLasso(t);
    setTool(t);
  };

  // M / L (and the dock's grouped slots): the family's last variant, or —
  // `toggle` (Shift, or clicking the active slot) — the other one.
  const pickVariant = (family: "marquee" | "lasso", toggle: boolean) => {
    if (family === "marquee") {
      const other = lastMarquee === "marquee-rect" ? "marquee-ellipse" : "marquee-rect";
      selectTool(toggle ? other : lastMarquee);
    } else {
      const other = lastLasso === "lasso" ? "lasso-poly" : "lasso";
      selectTool(toggle ? other : lastLasso);
    }
  };

  // ── Composite sampling (M4) ──
  // What you SEE on the Paint node — input (minus knockout) under the edit
  // layer — as full-canvas RGBA: the wand and Fill match against it. Unwired
  // it's just the edit layer; a failed input readback falls back to that.
  const compositePixels = async (
    canvas: HTMLCanvasElement
  ): Promise<Uint8ClampedArray | null> => {
    const W = canvas.width;
    const H = canvas.height;
    const own = () =>
      canvas.getContext("2d")?.getImageData(0, 0, W, H).data ?? null;
    if (!hasInput) return own();
    const req = requestPaintInput(nodeIdRef.current, W, H);
    window.dispatchEvent(new Event("pipeline-bump"));
    const px = await req;
    if (!px || canvas.width !== W || canvas.height !== H) return own();
    const tmp = newCanvas(W, H);
    const tctx = tmp.getContext("2d");
    if (!tctx) return own();
    tctx.putImageData(new ImageData(px.data, W, H), 0, 0);
    const ko = knockoutRef.current;
    if (ko) {
      tctx.globalCompositeOperation = "destination-out";
      tctx.drawImage(ko, 0, 0);
    }
    tctx.globalCompositeOperation = "source-over";
    tctx.drawImage(canvas, 0, 0);
    return tctx.getImageData(0, 0, W, H).data;
  };

  // Fill at a canvas point: region from the composite, color into the edit
  // layer, clipped to the selection; one undo entry.
  const fillAt = async (pt: [number, number]) => {
    const canvas = paint?.canvas;
    if (!canvas) return;
    const W = canvas.width;
    const H = canvas.height;
    const sample = hasInput ? await compositePixels(canvas) : undefined;
    if (canvas.width !== W || canvas.height !== H || sample === null) return;
    const clip = activeClip(canvas);
    captureBefore([canvas]);
    const pre = clip ? cloneCanvas(canvas) : null;
    if (floodFill(canvas, pt[0], pt[1], color, fillTolerance, sample)) {
      if (pre && clip) restoreOutsideSelection(canvas, pre, clip);
      snapshot(canvas);
      commitBefore();
    } else {
      beforeRef.current = null;
    }
  };

  // Magic wand click: the composite region around the point, combined into
  // the selection.
  const wandAt = async (pt: [number, number], mode: SelectionMode) => {
    const canvas = paint?.canvas;
    if (!canvas) return;
    const W = canvas.width;
    const H = canvas.height;
    const sample = await compositePixels(canvas);
    if (!sample || canvas.width !== W || canvas.height !== H) return;
    const region = floodRegion(sample, W, H, pt[0], pt[1], wandTolerance, wandContiguous);
    if (!region) return;
    changeSelection(canvas, null, (mask) =>
      combineRegion(mask, region, wandAntiAlias, mode)
    );
  };

  // ── Lassos ──
  const cancelLasso = () => {
    lassoRef.current = null;
    setLassoView(null);
  };

  // Close the lasso into the selection. Fewer than 3 points (a click) in
  // "new" mode deselects, as with the marquee.
  const finishLasso = () => {
    const draft = lassoRef.current;
    const canvas = paint?.canvas;
    cancelLasso();
    if (!draft || !canvas) return;
    const box = pointsBBox(draft.pts, canvas.width, canvas.height);
    if (draft.pts.length < 3 || !box || (box.w < 2 && box.h < 2)) {
      if (draft.mode === "new") deselect();
      return;
    }
    const old = selRef.current?.bbox ?? null;
    changeSelection(canvas, unionRect(old, box), (mask) =>
      combinePolygon(mask, draft.pts, draft.mode)
    );
  };

  const popLassoVertex = () => {
    const draft = lassoRef.current;
    if (!draft || draft.kind !== "poly") return;
    draft.pts.pop();
    if (draft.pts.length === 0) {
      cancelLasso();
      return;
    }
    setLassoView((v) => (v ? { ...v, pts: [...draft.pts] } : v));
  };

  // Is the client point within the polygon's close radius of its first
  // vertex (screen px)?
  const nearFirstVertex = (draft: LassoDraft, clientX: number, clientY: number) => {
    const r = rectRef.current;
    const c = paint?.canvas;
    if (!r || !c || draft.pts.length < 3) return false;
    const [fx, fy] = draft.pts[0];
    const sx = r.left + (fx / c.width) * r.width;
    const sy = r.top + (fy / c.height) * r.height;
    return Math.hypot(clientX - sx, clientY - sy) <= 8;
  };

  // ── Selection modify (M4) ──
  const modifySelection = (op: "feather" | "expand" | "contract", px: number) => {
    commitFloating();
    const canvas = paint?.canvas;
    const cur = selRef.current;
    if (!canvas || !cur || !(px > 0)) return;
    const pad = Math.ceil(op === "feather" ? px * 1.5 : px) + 2;
    const region = padRect(cur.bbox, pad, canvas.width, canvas.height);
    changeSelection(canvas, region, (mask) => {
      if (op === "feather") featherMask(mask, px);
      else growMask(mask, op === "expand" ? px : -px, cur.bbox);
    });
  };

  const selectPaintedPixels = () => {
    commitFloating();
    const canvas = paint?.canvas;
    if (!canvas) return;
    ensureCanvasRes(canvas);
    changeSelection(canvas, null, (mask) => selectPainted(mask, canvas));
  };

  // Commit a marquee drag into the mask. A click without a drag in "new"
  // mode deselects (Photoshop); otherwise a degenerate box does nothing.
  const finishMarquee = (drag: MarqueeDrag, clientX: number, clientY: number) => {
    const canvas = paint?.canvas;
    if (!canvas) return;
    const moved = Math.hypot(
      clientX - drag.pressClient[0],
      clientY - drag.pressClient[1]
    );
    const r = moved < 3 ? null : marqueeGeometry(drag, canvas);
    if (!r) {
      if (drag.mode === "new") deselect();
      return;
    }
    const old = selRef.current?.bbox ?? null;
    changeSelection(canvas, unionRect(old, r), (mask) =>
      combineIntoMask(
        mask,
        (ctx) => {
          if (drag.shape === "rect") {
            ctx.fillRect(r.x, r.y, r.w, r.h);
          } else {
            ctx.beginPath();
            ctx.ellipse(
              r.x + r.w / 2,
              r.y + r.h / 2,
              r.w / 2,
              r.h / 2,
              0,
              0,
              Math.PI * 2
            );
            ctx.fill();
          }
        },
        drag.mode
      )
    );
  };

  const marqueeGeometry = (drag: MarqueeDrag, canvas: HTMLCanvasElement) =>
    marqueeRect(drag.start, drag.cur, {
      square: drag.shiftKey && (!drag.shiftAtPress || drag.shiftReleased),
      fromCenter: drag.altKey && (!drag.altAtPress || drag.altReleased),
      width: canvas.width,
      height: canvas.height,
    });

  // Fold the latest pointer/modifier state into the drag and re-preview.
  const updateMarquee = (
    pt: [number, number] | null,
    shiftKey: boolean,
    altKey: boolean
  ) => {
    const drag = marqueeRef.current;
    const canvas = paint?.canvas;
    if (!drag || !canvas) return;
    if (pt) {
      if (spaceRef.current) {
        // Space-drag: move the whole marquee with the pointer.
        drag.start = [
          drag.start[0] + pt[0] - drag.cur[0],
          drag.start[1] + pt[1] - drag.cur[1],
        ];
      }
      drag.cur = pt;
    }
    drag.shiftKey = shiftKey;
    drag.altKey = altKey;
    if (!shiftKey) drag.shiftReleased = true;
    if (!altKey) drag.altReleased = true;
    const r = marqueeGeometry(drag, canvas);
    setMarqueeBox(r ? { rect: r, shape: drag.shape } : null);
  };

  const cancelMarquee = () => {
    marqueeRef.current = null;
    spaceRef.current = false;
    setMarqueeBox(null);
  };

  // Latest-closure mirror for the once-bound window listeners below.
  const actionsRef = useRef({
    selectAll,
    deselect,
    reselect,
    invertSelection,
    deleteInSelection,
    fillInSelection,
    updateMarquee,
    cancelMarquee,
    refreshSelection,
    getMask,
    commitFloating,
    cancelFloating,
    nudge,
    copySelection,
    pasteImage,
    applyMoveDrag,
    finishLasso,
    cancelLasso,
    popLassoVertex,
    paintCanvas: paint?.canvas ?? null,
  });
  useEffect(() => {
    actionsRef.current = {
      selectAll,
      deselect,
      reselect,
      invertSelection,
      deleteInSelection,
      fillInSelection,
      updateMarquee,
      cancelMarquee,
      refreshSelection,
      getMask,
      commitFloating,
      cancelFloating,
      nudge,
      copySelection,
      pasteImage,
      applyMoveDrag,
      finishLasso,
      cancelLasso,
      popLassoVertex,
      paintCanvas: paint?.canvas ?? null,
    };
    selectToolRef.current = selectTool;
    pickVariantRef.current = pickVariant;
  });

  // A pending float commits on unmount (deselecting the node keeps the
  // move rather than silently dropping it).
  useEffect(() => {
    return () => {
      cancelAnimationFrame(floatRafRef.current);
      actionsRef.current.commitFloating();
    };
  }, []);

  // Pick up a selection that outlived a remount (the mask store is
  // per-node, editor-session). Deferred a frame so the effect doesn't set
  // state synchronously.
  const paintCanvas = paint?.canvas ?? null;
  useEffect(() => {
    if (!paintCanvas || !peekSelectionMask(nodeId)) return;
    const raf = requestAnimationFrame(() =>
      actionsRef.current.refreshSelection(
        actionsRef.current.getMask(paintCanvas)
      )
    );
    return () => cancelAnimationFrame(raf);
  }, [paintCanvas, nodeId]);

  // Undo/redo restored mask pixels (EffectsApp broadcasts every paint-lane
  // restore) — re-derive the ants.
  useEffect(() => {
    const onRestored = (e: Event) => {
      const detail = (e as CustomEvent<{
        nodeId: string;
        canvases: HTMLCanvasElement[];
      }>).detail;
      const canvas = actionsRef.current.paintCanvas;
      if (!detail || detail.nodeId !== nodeIdRef.current || !canvas) return;
      const mask = peekSelectionMask(nodeIdRef.current);
      if (mask && detail.canvases.includes(mask)) {
        actionsRef.current.refreshSelection(mask);
      }
    };
    window.addEventListener("paint-surfaces-restored", onRestored);
    return () =>
      window.removeEventListener("paint-surfaces-restored", onRestored);
  }, []);

  // Canvas focus (§7): any pointerdown decides whether the paint canvas or
  // the rest of the app owns the Cmd / Delete shortcuts.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target;
      focusedRef.current =
        t instanceof Element && !!t.closest("[data-paint-overlay]");
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, []);

  // Selection shortcuts. Capture phase on window so they run before the
  // graph's own (bubble) handlers, which they then stop — but only while the
  // canvas has focus, and never while typing in a field.
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
    const claim = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onKey = (e: KeyboardEvent) => {
      const a = actionsRef.current;
      const md = moveRef.current;
      if (md && (e.key === "Shift" || e.key === "Alt")) {
        md.shift = e.shiftKey;
        md.alt = e.altKey;
        a.applyMoveDrag(md);
      }
      if (marqueeRef.current) {
        // Mid-drag: Space repositions, Escape cancels, modifiers re-preview
        // (so Shift/Alt constrain without having to move the pointer).
        if (e.key === " ") {
          spaceRef.current = true;
          claim(e);
          return;
        }
        if (e.key === "Escape") {
          a.cancelMarquee();
          claim(e);
          return;
        }
        if (e.key === "Shift" || e.key === "Alt") {
          a.updateMarquee(null, e.shiftKey, e.altKey);
        }
      }
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      // A polygonal lasso in progress owns Enter (close), Backspace (drop
      // the last vertex) and Escape (cancel).
      if (lassoRef.current?.kind === "poly" && !isTyping(e.target)) {
        if (e.key === "Enter") {
          claim(e);
          a.finishLasso();
          return;
        }
        if (e.key === "Backspace" || e.key === "Delete") {
          claim(e);
          a.popLassoVertex();
          return;
        }
        if (e.key === "Escape") {
          claim(e);
          a.cancelLasso();
          return;
        }
      }
      // A float is modal-ish: Enter keeps it, Escape / Cmd+Z drop it (undo
      // while floating = cancel), Cmd+Shift+Z keeps it — wherever focus is,
      // so the history lane never steps underneath a pending float.
      if (floatingRef.current && !isTyping(e.target)) {
        if (e.key === "Enter" || (mod && k === "z" && e.shiftKey)) {
          claim(e);
          a.commitFloating();
          return;
        }
        if (e.key === "Escape" || (mod && k === "z")) {
          claim(e);
          a.cancelFloating();
          return;
        }
      }
      if (!focusedRef.current || isTyping(e.target)) return;
      const hasPixels = !!floatingRef.current || !!selRef.current;
      if (mod && !e.altKey && !e.shiftKey && (k === "c" || k === "x") && hasPixels) {
        claim(e);
        a.copySelection(k === "x");
      } else if (
        !mod &&
        hasPixels &&
        (e.key === "ArrowLeft" ||
          e.key === "ArrowRight" ||
          e.key === "ArrowUp" ||
          e.key === "ArrowDown")
      ) {
        claim(e);
        const step = e.shiftKey ? 10 : 1;
        a.nudge(
          e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0,
          e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0
        );
      } else if (mod && !e.altKey && k === "a" && !e.shiftKey) {
        claim(e);
        a.selectAll();
      } else if (mod && !e.altKey && k === "d") {
        claim(e);
        if (e.shiftKey) a.reselect();
        else a.deselect();
      } else if (mod && e.shiftKey && !e.altKey && k === "i") {
        claim(e);
        a.invertSelection();
      } else if (!mod && (e.key === "Backspace" || e.key === "Delete")) {
        // Claimed even with nothing selected: with the canvas focused, a
        // stray Delete must not delete the Paint node out from under you.
        claim(e);
        if (e.altKey) a.fillInSelection();
        else a.deleteInSelection();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const md = moveRef.current;
      if (md && (e.key === "Shift" || e.key === "Alt")) {
        md.shift = e.shiftKey;
        md.alt = e.altKey;
        actionsRef.current.applyMoveDrag(md);
      }
      if (!marqueeRef.current) return;
      if (e.key === " ") {
        spaceRef.current = false;
        claim(e);
      } else if (e.key === "Shift" || e.key === "Alt") {
        actionsRef.current.updateMarquee(null, e.shiftKey, e.altKey);
      }
    };
    // Paste (§7): with the canvas focused, an OS image or the internal
    // pixel clip lands here as a float instead of becoming a new source node
    // (NodeEditor's bubble-phase paste handler never sees it).
    const onPaste = (e: ClipboardEvent) => {
      if (!focusedRef.current || isTyping(e.target)) return;
      const item = Array.from(e.clipboardData?.items ?? []).find((i) =>
        i.type.startsWith("image/")
      );
      const file = item?.getAsFile() ?? null;
      if (!file && !getPixelClip()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      void actionsRef.current.pasteImage(file);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("paste", onPaste, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("paste", onPaste, true);
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
  // (Not the marquee or Move: there Alt is subtract / from-center /
  // duplicate.)
  const effectiveTool: PaintTool =
    altHeld &&
    tool !== "fill" &&
    tool !== "eyedropper" &&
    tool !== "move" &&
    !isSelectionTool(tool)
      ? "eyedropper"
      : tool;

  // The transform gizmo's 8 handles in CLIENT px (transform.ts order), shown
  // with the Move tool whenever there's something to transform: the float
  // through its matrix, else the selection's bbox. Null = no gizmo.
  const gizmoHandles: [number, number][] | null = (() => {
    const c = paint?.canvas;
    if (tool !== "move" || !rect || !c || c.width <= 0) return null;
    const sx = rect.width / c.width;
    const sy = rect.height / c.height;
    const toClient = ([x, y]: [number, number]): [number, number] => [
      rect.left + x * sx,
      rect.top + y * sy,
    ];
    if (floatView) {
      const m = floatView.matrix;
      return handlePoints(floatView.content).map((p) =>
        toClient(applyAffine(m, p[0], p[1]))
      );
    }
    if (sel) return handlePoints(sel.bbox).map(toClient);
    return null;
  })();

  // Cursor over the Move tool's gizmo / pixels.
  const moveCursor = (() => {
    if (!hoverHit || !gizmoHandles) return "move";
    if (hoverHit.kind === "rotate") return ROTATE_CURSOR;
    if (hoverHit.kind === "scale" || hoverHit.kind === "skew") {
      return handleCursor(gizmoHandles, hoverHit.handle);
    }
    return "move";
  })();

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
    if (effectiveTool === "move") {
      // Drag moves the float (or lifts the selection on first movement).
      const pt = toCanvasPx(e.clientX, e.clientY);
      if (!pt) return;
      e.preventDefault();
      const f = floatingRef.current;
      const hit = gizmoHandles
        ? hitGizmo(gizmoHandles, [e.clientX, e.clientY], e.metaKey || e.ctrlKey)
        : { kind: "move" as const, handle: -1 };
      moveRef.current = {
        kind: hit.kind,
        handle: hit.handle,
        startPt: pt,
        lastPt: pt,
        pressClient: [e.clientX, e.clientY],
        alt: e.altKey,
        shift: e.shiftKey,
        startMatrix: f ? f.matrix : null,
        lifting: false,
        // Alt duplicates only on a plain move.
        stamped: !f || hit.kind !== "move",
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    // Every other tool edits the canvas: a pending float lands first.
    commitFloating();
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
    if (effectiveTool === "wand") {
      void wandAt(pt, modeFromMods(e, selMode));
      return;
    }
    if (effectiveTool === "lasso") {
      lassoRef.current = {
        kind: "free",
        mode: modeFromMods(e, selMode),
        pts: [pt],
        lastClick: null,
      };
      setLassoView({ kind: "free", pts: [pt], cursor: null, closeHint: false });
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (effectiveTool === "lasso-poly") {
      const now = performance.now();
      const draft = lassoRef.current;
      if (!draft || draft.kind !== "poly") {
        lassoRef.current = {
          kind: "poly",
          mode: modeFromMods(e, selMode),
          pts: [pt],
          lastClick: { t: now, x: e.clientX, y: e.clientY },
        };
        setLassoView({ kind: "poly", pts: [pt], cursor: pt, closeHint: false });
        return;
      }
      // Close on the first vertex, or on a double-click.
      const lc = draft.lastClick;
      const dbl =
        lc !== null &&
        now - lc.t < 350 &&
        Math.hypot(e.clientX - lc.x, e.clientY - lc.y) < 5;
      if (dbl || nearFirstVertex(draft, e.clientX, e.clientY)) {
        finishLasso();
        return;
      }
      const last = draft.pts[draft.pts.length - 1];
      draft.pts.push(e.shiftKey ? snap45(last, pt) : pt);
      draft.lastClick = { t: now, x: e.clientX, y: e.clientY };
      setLassoView({ kind: "poly", pts: [...draft.pts], cursor: pt, closeHint: false });
      return;
    }
    if (isMarqueeTool(effectiveTool)) {
      marqueeRef.current = {
        shape: effectiveTool === "marquee-rect" ? "rect" : "ellipse",
        mode: modeFromMods(e, selMode),
        start: pt,
        cur: pt,
        pressClient: [e.clientX, e.clientY],
        shiftAtPress: e.shiftKey,
        altAtPress: e.altKey,
        shiftReleased: false,
        altReleased: false,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
      };
      spaceRef.current = false;
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    const clip = activeClip(canvas);
    if (effectiveTool === "fill") {
      // Region from the composite, clipped to the selection (fillAt).
      void fillAt(pt);
      return;
    }
    // Brush / eraser / blur: begin a stroke session. With an image wired,
    // the eraser also cuts the input (mirrors into the knockout).
    const knockout =
      effectiveTool === "eraser" && hasInput ? ensureKnockout(canvas) : null;
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
      knockout,
      clip,
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
      if (knockout) snapshot(knockout, "knockout");
      rafRef.current = requestAnimationFrame(tick);
    };
    strokeKnockoutRef.current = knockout;
    rafRef.current = requestAnimationFrame(tick);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    setCursor({ x: e.clientX, y: e.clientY });
    const md = moveRef.current;
    if (!md && tool === "move") {
      const hit = gizmoHandles
        ? hitGizmo(gizmoHandles, [e.clientX, e.clientY], e.metaKey || e.ctrlKey)
        : null;
      setHoverHit((prev) =>
        prev?.kind === hit?.kind && prev?.handle === hit?.handle ? prev : hit
      );
    }
    if (md) {
      const pt = toCanvasPx(e.clientX, e.clientY);
      if (!pt) return;
      md.lastPt = pt;
      md.shift = e.shiftKey;
      md.alt = e.altKey;
      // A couple of screen px before anything lifts, so a click is a no-op.
      if (
        Math.hypot(e.clientX - md.pressClient[0], e.clientY - md.pressClient[1]) < 2 &&
        !md.lifting &&
        !floatingRef.current
      ) {
        return;
      }
      const f = floatingRef.current;
      if (!f) {
        if (md.lifting) return;
        md.lifting = true;
        // Apply wherever the pointer is when the lift lands (it may wait a
        // frame on the input readback; the drag may even be over by then).
        void beginLift(md.kind === "move" && md.alt).then((ok) => {
          const nf = floatingRef.current;
          if (!ok || !nf) return;
          md.startMatrix = nf.matrix;
          applyMoveDrag(md);
        });
        return;
      }
      if (!md.startMatrix) return;
      if (md.kind === "move" && md.alt && !md.stamped) {
        // Alt-drag an existing float: leave a copy behind.
        stampIntoBase(f);
        md.stamped = true;
      }
      applyMoveDrag(md);
      return;
    }
    if (marqueeRef.current) {
      updateMarquee(toCanvasPx(e.clientX, e.clientY), e.shiftKey, e.altKey);
      return;
    }
    const draft = lassoRef.current;
    if (draft) {
      if (draft.kind === "free") {
        const events = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];
        for (const ev of events) {
          const p = toCanvasPx(ev.clientX, ev.clientY);
          const last = draft.pts[draft.pts.length - 1];
          if (p && Math.hypot(p[0] - last[0], p[1] - last[1]) >= 0.75) {
            draft.pts.push(p);
          }
        }
        setLassoView({ kind: "free", pts: [...draft.pts], cursor: null, closeHint: false });
      } else {
        const p = toCanvasPx(e.clientX, e.clientY);
        if (p) {
          const last = draft.pts[draft.pts.length - 1];
          setLassoView({
            kind: "poly",
            pts: [...draft.pts],
            cursor: e.shiftKey ? snap45(last, p) : p,
            closeHint: nearFirstVertex(draft, e.clientX, e.clientY),
          });
        }
      }
      return;
    }
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
    if (lassoRef.current?.kind === "free") {
      if (e.type === "pointerup") finishLasso();
      else cancelLasso();
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      return;
    }
    if (moveRef.current) {
      // The float stays put until something commits or cancels it.
      moveRef.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      return;
    }
    const drag = marqueeRef.current;
    if (drag) {
      marqueeRef.current = null;
      spaceRef.current = false;
      setMarqueeBox(null);
      if (e.type === "pointerup") finishMarquee(drag, e.clientX, e.clientY);
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      return;
    }
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
      const knockout = strokeKnockoutRef.current;
      if (knockout) snapshot(knockout, "knockout");
      const surfaces = session.undoSurfaces();
      if (surfaces.length > 0) {
        onCommitRef.current?.(nodeIdRef.current, surfaces);
      }
    }
    strokeKnockoutRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  // Clear = back to the bare input: wipes the edit layer and any knockout.
  const onClear = () => {
    commitFloating();
    const canvas = paint?.canvas;
    if (!canvas) return;
    const c2d = canvas.getContext("2d");
    if (!c2d) return;
    ensureCanvasRes(canvas);
    const knockout = knockoutRef.current;
    captureBefore(knockout ? [canvas, knockout] : [canvas]);
    c2d.clearRect(0, 0, canvas.width, canvas.height);
    snapshot(canvas);
    if (knockout) {
      knockout.getContext("2d")?.clearRect(0, 0, knockout.width, knockout.height);
      snapshot(knockout, "knockout");
    }
    commitBefore();
  };

  // Flatten: bake the input as it looks right now (minus what's already
  // knocked out) under the strokes into the edit layer, then knock the live
  // input out entirely — the fully destructive, Photoshop-style state. The
  // input's pixels come from the node's compute via the paint-input
  // registry (one readback, on demand).
  const onFlatten = async () => {
    commitFloating();
    const canvas = paint?.canvas;
    if (!canvas || !hasInput || flattening) return;
    ensureCanvasRes(canvas);
    const w = canvas.width;
    const h = canvas.height;
    setFlattening(true);
    const request = requestPaintInput(nodeIdRef.current, w, h);
    window.dispatchEvent(new Event("pipeline-bump"));
    const pixels = await request;
    setFlattening(false);
    if (!pixels) {
      console.warn(
        "[paint] Flatten: the input image wasn't readable (is this Paint node on the rendered chain?)"
      );
      return;
    }
    // The canvas may have been resized while the readback was in flight.
    if (canvas.width !== w || canvas.height !== h) return;
    const c2d = canvas.getContext("2d");
    const knockout = ensureKnockout(canvas);
    const kctx = knockout.getContext("2d");
    if (!c2d || !kctx) return;
    captureBefore([canvas, knockout]);
    const tmp = document.createElement("canvas");
    tmp.width = w;
    tmp.height = h;
    const tctx = tmp.getContext("2d");
    if (!tctx) {
      beforeRef.current = null;
      return;
    }
    tctx.putImageData(new ImageData(pixels.data, w, h), 0, 0);
    tctx.globalCompositeOperation = "destination-out";
    tctx.drawImage(knockout, 0, 0);
    tctx.globalCompositeOperation = "source-over";
    tctx.drawImage(canvas, 0, 0);
    c2d.clearRect(0, 0, w, h);
    c2d.drawImage(tmp, 0, 0);
    kctx.save();
    kctx.globalCompositeOperation = "source-over";
    kctx.fillStyle = "#ffffff";
    kctx.fillRect(0, 0, w, h);
    kctx.restore();
    snapshot(canvas);
    snapshot(knockout, "knockout");
    commitBefore();
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

  // Marching ants, in wrapper-local screen px: each pixel-edge run of the
  // mask mapped through the preview rect (so they track pan/zoom exactly).
  // While floating, the ants are the float's own outline carried through
  // its matrix (source px → canvas px) instead of the pre-lift selection.
  const canvasW = paint?.canvas.width ?? 0;
  const canvasH = paint?.canvas.height ?? 0;
  const antsPath = useMemo(() => {
    if (!rect || !hostRect) return null;
    const ox = rect.left - hostRect.left;
    const oy = rect.top - hostRect.top;
    let e: Int32Array;
    let toCanvas: (x: number, y: number) => [number, number];
    let sx: number;
    let sy: number;
    if (floatView) {
      if (canvasW <= 0 || canvasH <= 0) return null;
      e = floatView.edges;
      const m = floatView.matrix;
      toCanvas = (x, y) => applyAffine(m, x, y);
      sx = rect.width / canvasW;
      sy = rect.height / canvasH;
    } else if (sel) {
      e = sel.edges;
      toCanvas = (x, y) => [x, y];
      sx = rect.width / sel.w;
      sy = rect.height / sel.h;
    } else {
      return null;
    }
    const parts: string[] = [];
    for (let i = 0; i < e.length; i += 4) {
      const [ax, ay] = toCanvas(e[i], e[i + 1]);
      const [bx, by] = toCanvas(e[i + 2], e[i + 3]);
      parts.push(
        `M${(ox + ax * sx).toFixed(1)} ${(oy + ay * sy).toFixed(1)}` +
          `L${(ox + bx * sx).toFixed(1)} ${(oy + by * sy).toFixed(1)}`
      );
    }
    return parts.join("");
  }, [sel, floatView, rect, hostRect, canvasW, canvasH]);

  // The marquee being dragged, in wrapper-local screen px.
  const marqueeScreen =
    marqueeBox && rect && hostRect && paint?.canvas
      ? {
          shape: marqueeBox.shape,
          x:
            rect.left -
            hostRect.left +
            (marqueeBox.rect.x * rect.width) / paint.canvas.width,
          y:
            rect.top -
            hostRect.top +
            (marqueeBox.rect.y * rect.height) / paint.canvas.height,
          w: (marqueeBox.rect.w * rect.width) / paint.canvas.width,
          h: (marqueeBox.rect.h * rect.height) / paint.canvas.height,
        }
      : null;

  // The lasso being drawn, in wrapper-local screen px: the path so far
  // (polygonal: plus the rubber band to the cursor).
  const lassoScreen = (() => {
    if (!lassoView || !rect || !hostRect || !paint?.canvas) return null;
    const c = paint.canvas;
    const map = ([x, y]: [number, number]): [number, number] => [
      rect.left - hostRect.left + (x / c.width) * rect.width,
      rect.top - hostRect.top + (y / c.height) * rect.height,
    ];
    const pts = lassoView.pts.map(map);
    const all = lassoView.cursor ? [...pts, map(lassoView.cursor)] : pts;
    return {
      d: all.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(""),
      vertices: lassoView.kind === "poly" ? pts : [],
      closeHint: lassoView.closeHint,
    };
  })();

  // Ants style: a light solid line under an animated dark dash, so they
  // read on any content.
  const antsUnder = {
    fill: "none",
    stroke: "rgba(255,255,255,0.95)",
    strokeWidth: 1,
  } as const;
  const antsOver = {
    fill: "none",
    stroke: "rgba(0,0,0,0.95)",
    strokeWidth: 1,
    strokeDasharray: "4 4",
    style: { animation: "tb-paint-ants 0.5s linear infinite" },
  } as const;

  return (
    <>
      <style>{`@keyframes tb-paint-ants { to { stroke-dashoffset: -8; } }`}</style>
      {/* Clip wrapper pinned to the viewport panel: a zoomed-in canvas
          extends past the panel, and strokes must not start from outside it.
          Pointer events pass through the wrapper (only the surface inside
          captures), so the zoom chip and window-level viewport gestures keep
          working. */}
      <div
        data-paint-overlay=""
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
            cursor: showRing ? "none" : tool === "move" ? moveCursor : "crosshair",
          }}
        />
        {/* Move tool: a pointer surface hugging the gizmo, so handles and
            the rotate ring stay grabbable where they hang off the canvas
            (a select-all puts them on its border) without covering the
            rest of the viewport. */}
        {gizmoHandles && hostRect && (() => {
          const xs = gizmoHandles.map((p) => p[0]);
          const ys = gizmoHandles.map((p) => p[1]);
          const pad = 30;
          const left = Math.min(...xs) - pad - hostRect.left;
          const top = Math.min(...ys) - pad - hostRect.top;
          return (
            <div
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endStroke}
              onPointerCancel={endStroke}
              style={{
                position: "absolute",
                left,
                top,
                width: Math.max(...xs) - Math.min(...xs) + pad * 2,
                height: Math.max(...ys) - Math.min(...ys) + pad * 2,
                pointerEvents: "auto",
                touchAction: "none",
                cursor: moveCursor,
              }}
            />
          );
        })()}
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
        {/* The lasso in progress. */}
        {lassoScreen && (
          <svg
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              pointerEvents: "none",
            }}
          >
            <path d={lassoScreen.d} {...antsUnder} />
            <path d={lassoScreen.d} {...antsOver} />
            {lassoScreen.vertices.map(([x, y], i) => (
              <rect
                key={i}
                x={x - (i === 0 && lassoScreen.closeHint ? 4.5 : 2.5)}
                y={y - (i === 0 && lassoScreen.closeHint ? 4.5 : 2.5)}
                width={i === 0 && lassoScreen.closeHint ? 9 : 5}
                height={i === 0 && lassoScreen.closeHint ? 9 : 5}
                fill="color-mix(in srgb, var(--tb-lift) 95%, transparent)"
                stroke="rgba(0,0,0,0.75)"
                strokeWidth={1}
              />
            ))}
          </svg>
        )}
        {/* Selection ants + the live marquee. */}
        {(antsPath || marqueeScreen) && (
          <svg
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              pointerEvents: "none",
              shapeRendering: "crispEdges",
            }}
          >
            {antsPath && (
              <>
                <path d={antsPath} {...antsUnder} />
                <path d={antsPath} {...antsOver} />
              </>
            )}
            {marqueeScreen &&
              (marqueeScreen.shape === "rect" ? (
                <>
                  <rect
                    x={marqueeScreen.x + 0.5}
                    y={marqueeScreen.y + 0.5}
                    width={marqueeScreen.w}
                    height={marqueeScreen.h}
                    {...antsUnder}
                  />
                  <rect
                    x={marqueeScreen.x + 0.5}
                    y={marqueeScreen.y + 0.5}
                    width={marqueeScreen.w}
                    height={marqueeScreen.h}
                    {...antsOver}
                  />
                </>
              ) : (
                <>
                  <ellipse
                    cx={marqueeScreen.x + marqueeScreen.w / 2}
                    cy={marqueeScreen.y + marqueeScreen.h / 2}
                    rx={marqueeScreen.w / 2}
                    ry={marqueeScreen.h / 2}
                    {...antsUnder}
                  />
                  <ellipse
                    cx={marqueeScreen.x + marqueeScreen.w / 2}
                    cy={marqueeScreen.y + marqueeScreen.h / 2}
                    rx={marqueeScreen.w / 2}
                    ry={marqueeScreen.h / 2}
                    {...antsOver}
                  />
                </>
              ))}
          </svg>
        )}
        {/* Transform gizmo: frame, 8 handles, center mark. */}
        {gizmoHandles && hostRect && (() => {
          const local = gizmoHandles.map(
            ([x, y]) => [x - hostRect.left, y - hostRect.top] as [number, number]
          );
          const frame = [0, 2, 4, 6]
            .map((i) => `${local[i][0].toFixed(1)},${local[i][1].toFixed(1)}`)
            .join(" ");
          const cx = (local[0][0] + local[4][0]) / 2;
          const cy = (local[0][1] + local[4][1]) / 2;
          return (
            <svg
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                pointerEvents: "none",
              }}
            >
              <polygon points={frame} fill="none" stroke="rgba(0,0,0,0.6)" strokeWidth={3} />
              <polygon
                points={frame}
                fill="none"
                stroke="color-mix(in srgb, var(--tb-lift) 95%, transparent)"
                strokeWidth={1}
              />
              {local.map(([x, y], i) => (
                <rect
                  key={i}
                  x={x - 3.5}
                  y={y - 3.5}
                  width={7}
                  height={7}
                  fill="color-mix(in srgb, var(--tb-lift) 95%, transparent)"
                  stroke="rgba(0,0,0,0.75)"
                  strokeWidth={1}
                />
              ))}
              <path
                d={`M${cx - 4} ${cy}H${cx + 4}M${cx} ${cy - 4}V${cy + 4}`}
                stroke="rgba(0,0,0,0.6)"
                strokeWidth={3}
              />
              <path
                d={`M${cx - 4} ${cy}H${cx + 4}M${cx} ${cy - 4}V${cy + 4}`}
                stroke="color-mix(in srgb, var(--tb-lift) 95%, transparent)"
                strokeWidth={1}
              />
            </svg>
          );
        })()}
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
        // display: contents — a focus marker only (§7); the docks position
        // themselves fixed.
        <div data-paint-overlay="" style={{ display: "contents" }}>
          <PaintToolDock
            left={hostRect.left + dockInset.left}
            top={hostRect.top + dockInset.top}
            tool={tool}
            onSelectTool={(t) => {
              // Clicking the active grouped slot flips its variant.
              if (t === tool && isMarqueeTool(t)) pickVariant("marquee", true);
              else if (t === tool && isLassoTool(t)) pickVariant("lasso", true);
              else selectTool(t);
            }}
            marqueeVariant={lastMarquee}
            lassoVariant={lastLasso}
            onClear={onClear}
            onFlatten={hasInput ? onFlatten : undefined}
            flattening={flattening}
          />
          {tool === "move" ? (
            <PaintMoveShelf
              right={Math.max(10, window.innerWidth - hostRect.right + dockInset.right)}
              top={hostRect.top + dockInset.top}
              floating={floatView !== null}
              readout={
                floatView
                  ? readTransform(floatView.matrix, floatView.content)
                  : sel
                    ? readTransform([1, 0, 0, 1, 0, 0], sel.bbox)
                    : null
              }
              onReadoutChange={editReadout}
              onFlip={flipFloat}
              onCommit={commitFloating}
              onCancel={cancelFloating}
            />
          ) : isSelectionTool(tool) ? (
            <PaintSelectionShelf
              right={Math.max(10, window.innerWidth - hostRect.right + dockInset.right)}
              top={hostRect.top + dockInset.top}
              mode={selMode}
              onModeChange={setSelMode}
              hasSelection={sel !== null}
              onSelectAll={selectAll}
              onDeselect={deselect}
              onInvert={invertSelection}
              onSelectPainted={selectPaintedPixels}
              modifyPx={modifyPx}
              onModifyPxChange={setModifyPx}
              onModify={(op) => modifySelection(op, modifyPx)}
              wand={
                tool === "wand"
                  ? {
                      tolerance: wandTolerance,
                      contiguous: wandContiguous,
                      antiAlias: wandAntiAlias,
                      onTolerance: setWandTolerance,
                      onContiguous: setWandContiguous,
                      onAntiAlias: setWandAntiAlias,
                    }
                  : null
              }
            />
          ) : (
          <PaintBrushShelf
            right={Math.max(10, window.innerWidth - hostRect.right + dockInset.right)}
            top={hostRect.top + dockInset.top}
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
          )}
        </div>
      )}
    </>
  );
}
