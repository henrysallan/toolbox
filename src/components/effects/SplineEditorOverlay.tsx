"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import type { SplineAnchor, SplineSubpath } from "@/engine/types";
import type { SplineParamValue } from "@/nodes/source/spline-draw";
import { aspectCorrectY, aspectUncorrectY } from "@/engine/aspect";
import { getShortcutScope } from "./shortcut-scope";

// The overlay edits one ACTIVE subpath at a time (anchors/handles/segments),
// while rendering every other subpath as a muted outline. Multi-subpath
// compound paths (e.g. an SVG with several paths, or a glyph with holes) live
// in one Spline Draw node; `activeSubpath` (component state below) selects
// which one the pen extends and the edit handles attach to.
//
// On-canvas pen tool for the Spline Draw node.
//
// Coordinate convention matches the node's stored format: normalized [0,1]²
// with Y-DOWN (row 0 at top). That lets the overlay, the 2D canvas raster,
// and the DOM coordinate system all line up without per-operation flips.
// Consumers that expect Y-up (future "sample along path" nodes) are
// responsible for flipping on their side.
//
// Three tool modes:
//   - "pen"     — pen tool; background click creates an anchor on the active
//                 subpath (or starts a new subpath when the active one is
//                 closed); quick click on an existing anchor toggles corner ↔
//                 smooth (or closes the loop on the first anchor of an open
//                 path). A dotted rubber-band previews the next segment.
//   - "path"    — Path Select (filled arrow): click any subpath to select the
//                 whole path; drag (body or bounding-box handles) moves /
//                 scales all subpaths, baked into the geometry. No params.
//   - "subpath" — Sub-path Select (outline arrow / direct selection): click a
//                 subpath to make it active, then edit its anchors. Clicks
//                 select anchors; shift-click extends; click+drag on empty
//                 draws a marquee; drag a selected anchor moves the selection;
//                 grab a curve *segment* to bend it (minimum-norm
//                 least-squares solve). Delete removes selected anchors.
//
// Handle gestures (drag to reshape, right-click to drop a handle) work in the
// pen + sub-path modes. Smooth anchors mirror their handles on drag; Alt-drag
// *breaks* the anchor (persistently) so the two handles move independently.
// Right-click an anchor for a context menu (delete / align / even handles);
// right-click a handle to drop just that handle.

type ToolMode = "pen" | "path" | "subpath";

interface Props {
  canvas: HTMLCanvasElement | null;
  value: SplineParamValue;
  onChange: (next: SplineParamValue) => void;
}

// Visual sizing. Anchors are intentionally small and outlined (blue stroke,
// faint fill); corner anchors (no handles) draw as squares, smooth/handled
// anchors as circles — matching Illustrator/AE pen-tool affordances.
const ANCHOR_R = 4; // circle radius for handled (smooth) anchors
const ANCHOR_SQUARE = 7; // square side for corner anchors (no handles)
const HANDLE_R = 3; // handle dot radius
// Hidden hit-target radius around each anchor / handle. Larger than
// the visual dot so users don't have to be pixel-perfect, and so a
// small wiggle during a click doesn't trip the drag threshold and
// suppress the corner ↔ smooth toggle.
const ANCHOR_HIT_R = 11;
const HANDLE_HIT_R = 9;
// px stroke width of the invisible per-segment hit path used for hover +
// direct segment dragging in select mode.
const SEGMENT_HIT_W = 12;
// px; below this a pointerup counts as a click. Bumped well above
// the visible dot radii so trackpad jitter and mouse wobble during
// a rapid double-click don't trip into drag mode and suppress the
// corner ↔ smooth toggle.
const DRAG_THRESHOLD = 10;

// Palette.
const COL_STROKE = "#3b82f6"; // anchor outline (blue)
const COL_FILL = "rgba(59, 130, 246, 0.18)"; // low-opacity anchor fill
const COL_SEL_STROKE = "#f59e0b"; // selected anchor outline (amber)
const COL_SEL_FILL = "rgba(245, 158, 11, 0.25)";
const COL_PATH = "#22d3ee"; // authored-curve preview
const COL_HANDLE_LINE = "#60a5fa"; // anchor → handle connector
const COL_HANDLE_FILL = "#3b82f6";
const COL_HANDLE_STROKE = "#dbeafe";
const COL_SEG_HOVER = "#22d3ee"; // highlighted segment under cursor
const COL_RUBBER = "#22d3ee"; // dotted next-segment preview

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
      // Snapshot of every anchor's pos at gesture start, keyed by index.
      // For multi-select drags the whole group moves by the same delta;
      // for single-anchor drags this still contains just the dragged
      // anchor's start so endpoint math is uniform.
      groupStarts?: Map<number, [number, number]>;
    }
  | {
      kind: "handle";
      index: number;
      side: "in" | "out";
      symmetric: boolean;
      startClient: { x: number; y: number };
    }
  | {
      // Direct segment drag: bend the cubic between anchors i and j by
      // moving its two interior controls. t (the grabbed parameter) is
      // cached at drag-start so the curve doesn't slide under the cursor.
      kind: "segment";
      seg: number;
      i: number;
      j: number;
      t: number;
      startClient: { x: number; y: number };
    }
  | {
      kind: "marquee";
      // Client-coord rect anchored at the press; updated on move.
      startClient: { x: number; y: number };
      currentClient: { x: number; y: number };
      // Selection that was already active when the marquee started —
      // shift-marquee unions with this; plain marquee replaces it.
      additive: boolean;
      baseSelection: Set<number>;
    }
  | {
      // Path Select drag: translate every anchor of every subpath by the
      // pointer delta (baked into geometry). `startValue` is snapshotted so
      // the move is computed from the gesture's start, not incrementally.
      kind: "path-move";
      startClient: { x: number; y: number };
      startNorm: [number, number];
      startValue: SplineParamValue;
    }
  | {
      // Bounding-box transform drag (Path Select, A6): scale all subpaths
      // about an anchored edge/corner, baked via transformSpline.
      kind: "bbox";
      handle: BBoxHandle;
      startClient: { x: number; y: number };
      startBox: { minX: number; minY: number; maxX: number; maxY: number };
      startValue: SplineParamValue;
    };

// Bounding-box transform handles (Path Select). Corners scale both axes;
// edges scale one. The dragged handle moves; the opposite edge/corner stays
// anchored (the box's anchor point for the scale pivot).
type BBoxHandle =
  | "tl"
  | "tr"
  | "br"
  | "bl"
  | "t"
  | "r"
  | "b"
  | "l";

// --- pure bezier helpers (px or norm, caller-consistent) -------------------

function bezierAt(
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  t: number
): [number, number] {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return [
    w0 * p0[0] + w1 * p1[0] + w2 * p2[0] + w3 * p3[0],
    w0 * p0[1] + w1 * p1[1] + w2 * p2[1] + w3 * p3[1],
  ];
}

// Coarse-to-fine nearest-point projection onto a cubic. Returns the
// parameter t minimizing distance to `target`. Operates in whatever space
// the control points are given in (we feed it pixels so "nearest" matches
// what the user sees on a non-square canvas).
function nearestTOnCubic(
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  target: [number, number]
): number {
  const dist2 = (t: number) => {
    const b = bezierAt(p0, p1, p2, p3, t);
    const dx = b[0] - target[0];
    const dy = b[1] - target[1];
    return dx * dx + dy * dy;
  };
  let bestT = 0;
  let bestD = Infinity;
  const N = 24;
  for (let k = 0; k <= N; k++) {
    const t = k / N;
    const d = dist2(t);
    if (d < bestD) {
      bestD = d;
      bestT = t;
    }
  }
  const lo = Math.max(0, bestT - 1 / N);
  const hi = Math.min(1, bestT + 1 / N);
  const M = 20;
  for (let k = 0; k <= M; k++) {
    const t = lo + ((hi - lo) * k) / M;
    const d = dist2(t);
    if (d < bestD) {
      bestD = d;
      bestT = t;
    }
  }
  return bestT;
}

const vlen = (v: [number, number]) => Math.hypot(v[0], v[1]);

// Build an SVG path string for one subpath, mapping each normalized point to
// screen px via `toPx`. Shared by the active-subpath preview and the muted
// inactive-subpath outlines. Returns "" for subpaths with < 2 anchors.
function subpathToPathD(
  anchors: SplineAnchor[],
  closed: boolean,
  toPx: (p: [number, number]) => { x: number; y: number }
): string {
  if (anchors.length < 2) return "";
  const firstPx = toPx(anchors[0].pos);
  let d = `M ${firstPx.x} ${firstPx.y}`;
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
  if (closed) {
    const last = anchors[anchors.length - 1];
    const a0 = anchors[0];
    const cp1 = last.outHandle
      ? toPx([last.pos[0] + last.outHandle[0], last.pos[1] + last.outHandle[1]])
      : toPx(last.pos);
    const cp2 = a0.inHandle
      ? toPx([a0.pos[0] + a0.inHandle[0], a0.pos[1] + a0.inHandle[1]])
      : toPx(a0.pos);
    const end = toPx(a0.pos);
    d += ` C ${cp1.x} ${cp1.y}, ${cp2.x} ${cp2.y}, ${end.x} ${end.y} Z`;
  }
  return d;
}

// Muted color for the non-active subpath outlines.
const COL_INACTIVE = "rgba(148, 163, 184, 0.55)"; // slate-400 @ 55%

// Common tangent axis (unit) for an anchor's handles: average of the out
// direction and the negated in direction (both point "along" the tangent).
function handleAxis(a: SplineAnchor): [number, number] | null {
  let ax = 0;
  let ay = 0;
  if (a.outHandle) {
    const m = vlen(a.outHandle) || 1;
    ax += a.outHandle[0] / m;
    ay += a.outHandle[1] / m;
  }
  if (a.inHandle) {
    const m = vlen(a.inHandle) || 1;
    ax += -a.inHandle[0] / m;
    ay += -a.inHandle[1] / m;
  }
  const m = Math.hypot(ax, ay);
  if (m < 1e-6) {
    // Handles already directly opposed (cancel out) or degenerate — fall
    // back to whichever handle exists.
    if (a.outHandle) {
      const om = vlen(a.outHandle) || 1;
      return [a.outHandle[0] / om, a.outHandle[1] / om];
    }
    if (a.inHandle) {
      const im = vlen(a.inHandle) || 1;
      return [-a.inHandle[0] / im, -a.inHandle[1] / im];
    }
    return null;
  }
  return [ax / m, ay / m];
}

// "Align handles": make the two handles collinear (opposite directions),
// keeping each one's current length. Re-links the anchor to smooth.
function alignHandles(a: SplineAnchor): SplineAnchor {
  if (!a.inHandle && !a.outHandle) return a;
  const axis = handleAxis(a);
  if (!axis) return a;
  const next: SplineAnchor = { ...a, broken: false };
  const lOut = a.outHandle ? vlen(a.outHandle) : a.inHandle ? vlen(a.inHandle) : 0;
  const lIn = a.inHandle ? vlen(a.inHandle) : a.outHandle ? vlen(a.outHandle) : 0;
  next.outHandle = [axis[0] * lOut, axis[1] * lOut];
  next.inHandle = [-axis[0] * lIn, -axis[1] * lIn];
  return next;
}

// "Even handles": collinear AND equal length (a perfect mirror), using the
// average of the present handle lengths. Re-links the anchor to smooth.
function evenHandles(a: SplineAnchor): SplineAnchor {
  if (!a.inHandle && !a.outHandle) return a;
  const axis = handleAxis(a);
  if (!axis) return a;
  const lens: number[] = [];
  if (a.outHandle) lens.push(vlen(a.outHandle));
  if (a.inHandle) lens.push(vlen(a.inHandle));
  const L = lens.reduce((s, x) => s + x, 0) / lens.length;
  return {
    ...a,
    broken: false,
    outHandle: [axis[0] * L, axis[1] * L],
    inHandle: [-axis[0] * L, -axis[1] * L],
  };
}

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
  // Rect of the canvas's containing viewport panel (its parent). The tool
  // dock anchors to this so it sits at the panel's corner rather than the
  // letterboxed canvas edge, which can be inset on non-matching aspects.
  const [hostRect, setHostRect] = useState<DOMRect | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [tool, setTool] = useState<ToolMode>("pen");
  // Mirror for the window keydown handler (bound once), so contextual Delete
  // can branch on the live tool without re-binding.
  const toolRef = useRef(tool);
  toolRef.current = tool;
  // Which subpath the pen extends and the edit handles attach to. Other
  // subpaths render as muted outlines. Mirrored in a ref so the long-running
  // pointer handlers read the live index without re-binding.
  const [activeSubpath, setActiveSubpath] = useState(0);
  const activeSubpathRef = useRef(activeSubpath);
  activeSubpathRef.current = activeSubpath;
  // "Sealed" = the user finished drawing the active subpath (Enter / Return).
  // The next pen background click starts a fresh subpath instead of extending
  // this one, and the rubber-band preview hides. Reset when a new subpath
  // starts or the active subpath is re-selected, so you can resume extending.
  const [penSealed, setPenSealed] = useState(false);
  const penSealedRef = useRef(penSealed);
  penSealedRef.current = penSealed;
  const [selected, setSelected] = useState<Set<number>>(() => new Set());

  // Switch the active subpath, clearing the anchor selection (indices are
  // per-subpath, so they don't carry across).
  const selectSubpath = (i: number) => {
    setActiveSubpath(i);
    setSelected(new Set());
    // Re-selecting a subpath means you may want to extend it again.
    setPenSealed(false);
  };
  // Segment under the cursor in select mode (index into the segment list),
  // and the live cursor position used for the add-mode rubber band.
  const [hoverSeg, setHoverSeg] = useState<number | null>(null);
  const [hoverPx, setHoverPx] = useState<{ x: number; y: number } | null>(null);
  // Right-click context menu anchored at a client position for one anchor.
  const [menu, setMenu] = useState<{ x: number; y: number; index: number } | null>(
    null
  );
  // Mirror selection in a ref so the long-running pointermove handler in
  // the drag effect can read the latest set without re-binding when the
  // selection changes mid-gesture.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  // The most recently touched anchor (created / clicked / dragged / right-
  // clicked). Drives contextual Delete when nothing is selected — "delete
  // the point near where I was last working" rather than the graph node.
  const lastAnchorRef = useRef<number | null>(null);
  // Shift toggles the add-mode "insert on path" affordance (snap a preview
  // point to the nearest spot on an existing segment; click inserts there).
  const [shiftHeld, setShiftHeld] = useState(false);

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
      if (e.key === "p" || e.key === "P") setTool("pen");
      else if (e.key === "v" || e.key === "V") setTool("path");
      else if (e.key === "a" || e.key === "A") setTool("subpath");
      else if (e.key === "Escape") {
        setSelected(new Set());
        setMenu(null);
      } else if (e.key === "Enter") {
        // Finish drawing the current pen subpath: the next pen click starts a
        // new subpath instead of extending this one. Only when the spline
        // canvas is the active scope and the pen tool is in use.
        if (getShortcutScope() !== "spline") return;
        if (toolRef.current !== "pen") return;
        e.preventDefault();
        setPenSealed(true);
        setSelected(new Set());
        setMenu(null);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        // Contextual delete: only act when the spline canvas is the last
        // clicked region (scope "spline"). Otherwise let the node editor's
        // window handler delete the selected graph node instead — pressing
        // Delete while working in the graph must still remove the node.
        if (getShortcutScope() !== "spline") return;
        const anchorsNow = readAnchors(valueRef.current);
        const sel = selectedRef.current;
        if (sel.size > 0) {
          if (anchorsNow.length === 0) return;
          e.preventDefault();
          deleteAnchorIndices(sel);
          setSelected(new Set());
        } else if (
          toolRef.current !== "pen" &&
          subpathsOf(valueRef.current).length > 1
        ) {
          // No anchor selection in Path / Sub-path mode → delete the whole
          // active subpath (the implicitly-selected one).
          e.preventDefault();
          deleteActiveSubpath();
        } else {
          // Pen mode (or single subpath): delete the point near where the
          // user last worked, falling back to the most recent anchor.
          if (anchorsNow.length === 0) return;
          e.preventDefault();
          const li = lastAnchorRef.current;
          const idx =
            li != null && li >= 0 && li < anchorsNow.length
              ? li
              : anchorsNow.length - 1;
          deleteAnchor(idx);
        }
        lastAnchorRef.current = null;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track the Shift key for the add-mode insert-on-path affordance. Cleared
  // on blur so a tab-away mid-hold doesn't leave it stuck on.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftHeld(false);
    };
    const blur = () => setShiftHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  // Track the canvas's on-screen rectangle the same way TransformGizmo does —
  // ResizeObserver catches splitter resizes and zoom-to-fit changes. Also
  // track the parent panel rect (for docking the toolbar); observe both since
  // the panel can resize without the letterboxed canvas changing size.
  useEffect(() => {
    if (!canvas) {
      setRect(null);
      setHostRect(null);
      return;
    }
    const host = canvas.parentElement;
    const update = () => {
      setRect(canvas.getBoundingClientRect());
      setHostRect((host ?? canvas).getBoundingClientRect());
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(canvas);
    if (host) ro.observe(host);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [canvas]);

  // Anchors are normalized [0,1]²; the rasterizer aspect-corrects y so the
  // spline stays round on a non-square canvas. Apply the same correction here
  // so the editor handles sit exactly on the rendered curve.
  const clientToNorm = (cx: number, cy: number): [number, number] => {
    if (!rect) return [0, 0];
    const aspect = rect.width / rect.height;
    return [
      (cx - rect.left) / rect.width,
      aspectUncorrectY((cy - rect.top) / rect.height, aspect),
    ];
  };

  const normToPx = (p: [number, number]) => {
    if (!rect) return { x: 0, y: 0 };
    const aspect = rect.width / rect.height;
    return {
      x: rect.left + p[0] * rect.width,
      y: rect.top + aspectCorrectY(p[1], aspect) * rect.height,
    };
  };

  // The anchor-level helpers below operate on the ACTIVE subpath
  // (activeSubpathRef.current). Reads return [] if the value arrives without
  // any subpaths; writes materialize the active subpath on first touch.
  //
  // `subpathsOf` copes with legacy save data where the param envelope was
  // missing `subpaths` entirely. Treating that case as "no anchors yet" lets
  // old projects load without crashing.
  const subpathsOf = (v: SplineParamValue | undefined | null): SplineSubpath[] =>
    v?.subpaths ?? [];
  const readAnchors = (v: SplineParamValue): SplineAnchor[] =>
    subpathsOf(v)[activeSubpathRef.current]?.anchors ?? [];
  const withSubpathPatch = (
    cur: SplineParamValue,
    patch: Partial<SplineSubpath>
  ): SplineParamValue => {
    const subpaths = subpathsOf(cur);
    const base: SplineSubpath[] =
      subpaths.length > 0 ? subpaths : [{ anchors: [], closed: false }];
    return {
      ...cur,
      subpaths: base.map((s, i) =>
        i === activeSubpathRef.current ? { ...s, ...patch } : s
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

  // Project a client point onto the nearest spot on any segment of the path.
  // Returns the segment endpoints (i, j) and parameter t plus the projected
  // px point, or null when there are no segments. Used for the shift-insert
  // affordance in add mode.
  const findInsertOnSpline = (
    cx: number,
    cy: number
  ): { i: number; j: number; t: number; x: number; y: number } | null => {
    const sub = subpathsOf(valueRef.current)[activeSubpathRef.current];
    const anchors = sub?.anchors ?? [];
    const closed = sub?.closed ?? false;
    const n = anchors.length;
    const count = closed ? n : n - 1;
    if (count < 1) return null;
    let best: { i: number; j: number; t: number; x: number; y: number; d: number } | null =
      null;
    for (let s = 0; s < count; s++) {
      const i = s;
      const j = (s + 1) % n;
      const A = anchors[i];
      const B = anchors[j];
      const p0 = normToPx(A.pos);
      const p1 = A.outHandle
        ? normToPx([A.pos[0] + A.outHandle[0], A.pos[1] + A.outHandle[1]])
        : p0;
      const p3 = normToPx(B.pos);
      const p2 = B.inHandle
        ? normToPx([B.pos[0] + B.inHandle[0], B.pos[1] + B.inHandle[1]])
        : p3;
      const c0: [number, number] = [p0.x, p0.y];
      const c1: [number, number] = [p1.x, p1.y];
      const c2: [number, number] = [p2.x, p2.y];
      const c3: [number, number] = [p3.x, p3.y];
      const t = nearestTOnCubic(c0, c1, c2, c3, [cx, cy]);
      const b = bezierAt(c0, c1, c2, c3, t);
      const d = Math.hypot(b[0] - cx, b[1] - cy);
      if (!best || d < best.d) best = { i, j, t, x: b[0], y: b[1], d };
    }
    if (!best) return null;
    return { i: best.i, j: best.j, t: best.t, x: best.x, y: best.y };
  };

  // Insert a new anchor on the segment between anchors i and j at parameter t,
  // splitting the cubic via de Casteljau so the existing curve shape is
  // preserved. A straight segment (no handles either side) just gets a plain
  // corner anchor at the point; a curved segment splits into two smooth halves.
  const insertAnchorOnSegment = (i: number, j: number, t: number) => {
    const cur = valueRef.current;
    const anchors = readAnchors(cur);
    const A = anchors[i];
    const B = anchors[j];
    if (!A || !B) return;
    const straight = !A.outHandle && !B.inHandle;
    let inserted: SplineAnchor;
    const patchI: Partial<SplineAnchor> = {};
    const patchJ: Partial<SplineAnchor> = {};
    if (straight) {
      const x = A.pos[0] + (B.pos[0] - A.pos[0]) * t;
      const y = A.pos[1] + (B.pos[1] - A.pos[1]) * t;
      inserted = { pos: [x, y] };
    } else {
      const P0 = A.pos;
      const P3 = B.pos;
      const P1: [number, number] = [
        P0[0] + (A.outHandle?.[0] ?? 0),
        P0[1] + (A.outHandle?.[1] ?? 0),
      ];
      const P2: [number, number] = [
        P3[0] + (B.inHandle?.[0] ?? 0),
        P3[1] + (B.inHandle?.[1] ?? 0),
      ];
      const lerp = (
        a: [number, number],
        b: [number, number]
      ): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const a1 = lerp(P0, P1);
      const b1 = lerp(P1, P2);
      const c1 = lerp(P2, P3);
      const d1 = lerp(a1, b1);
      const e1 = lerp(b1, c1);
      const f1 = lerp(d1, e1); // split point
      // |v|≈0 → drop the handle (undefined) rather than store a zero vector
      // that would render a degenerate dot on top of the anchor.
      const nz = (
        vx: number,
        vy: number
      ): [number, number] | undefined =>
        Math.hypot(vx, vy) < 1e-6 ? undefined : [vx, vy];
      patchI.outHandle = nz(a1[0] - P0[0], a1[1] - P0[1]);
      patchJ.inHandle = nz(c1[0] - P3[0], c1[1] - P3[1]);
      inserted = {
        pos: f1,
        inHandle: nz(d1[0] - f1[0], d1[1] - f1[1]),
        outHandle: nz(e1[0] - f1[0], e1[1] - f1[1]),
        broken: false,
      };
    }
    const out: SplineAnchor[] = [];
    for (let k = 0; k < anchors.length; k++) {
      let a = anchors[k];
      if (k === i && !straight) a = { ...a, ...patchI };
      if (k === j && !straight) a = { ...a, ...patchJ };
      out.push(a);
      if (k === i) out.push(inserted);
    }
    onChangeRef.current(withSubpathPatch(cur, { anchors: out }));
    lastAnchorRef.current = i + 1;
  };

  const updateAnchor = (i: number, patch: Partial<SplineAnchor>) => {
    const cur = valueRef.current;
    const anchors = readAnchors(cur);
    const next = withSubpathPatch(cur, {
      anchors: anchors.map((a, idx) => (idx === i ? { ...a, ...patch } : a)),
    });
    onChangeRef.current(next);
  };

  // Patch several anchors in one onChange. Needed when a single gesture
  // (segment drag, align/even on a multi-selection) must touch more than one
  // anchor: calling updateAnchor twice in a row would have the second read a
  // stale value (React hasn't re-rendered yet) and clobber the first.
  const patchAnchors = (patches: Map<number, Partial<SplineAnchor>>) => {
    const cur = valueRef.current;
    const anchors = readAnchors(cur);
    const next = withSubpathPatch(cur, {
      anchors: anchors.map((a, idx) => {
        const p = patches.get(idx);
        return p ? { ...a, ...p } : a;
      }),
    });
    onChangeRef.current(next);
  };

  // Apply a position delta to many anchors at once. Used for group drags
  // when the user moves a multi-selection in select mode. Handle offsets
  // are stored relative to pos, so they ride along automatically.
  const moveAnchors = (
    starts: Map<number, [number, number]>,
    dx: number,
    dy: number
  ) => {
    const cur = valueRef.current;
    const anchors = readAnchors(cur);
    const next = withSubpathPatch(cur, {
      anchors: anchors.map((a, idx) => {
        const start = starts.get(idx);
        if (!start) return a;
        return { ...a, pos: [start[0] + dx, start[1] + dy] };
      }),
    });
    onChangeRef.current(next);
  };

  // Path Select move: translate every anchor of every subpath by (dx, dy) in
  // normalized space, computed from a start snapshot. Handle offsets are
  // relative to pos, so they ride along. Bakes into the spline geometry.
  const translateWholePath = (
    start: SplineParamValue,
    dx: number,
    dy: number
  ) => {
    const subs = subpathsOf(start).map((s) => ({
      ...s,
      anchors: s.anchors.map((a) => ({
        ...a,
        pos: [a.pos[0] + dx, a.pos[1] + dy] as [number, number],
      })),
    }));
    onChangeRef.current({ ...start, subpaths: subs });
  };

  // Scale every subpath about `pivot` (normalized space) by (sx, sy), from a
  // start snapshot. Preserves the `broken` flag and all anchor fields (unlike
  // engine/transformSpline, which rebuilds anchors and drops `broken`). Handle
  // offsets are deltas, so they scale but don't translate.
  const scaleWholePath = (
    start: SplineParamValue,
    pivot: [number, number],
    sx: number,
    sy: number
  ) => {
    const subs = subpathsOf(start).map((s) => ({
      ...s,
      anchors: s.anchors.map((a) => ({
        ...a,
        pos: [
          pivot[0] + (a.pos[0] - pivot[0]) * sx,
          pivot[1] + (a.pos[1] - pivot[1]) * sy,
        ] as [number, number],
        inHandle: a.inHandle
          ? ([a.inHandle[0] * sx, a.inHandle[1] * sy] as [number, number])
          : a.inHandle,
        outHandle: a.outHandle
          ? ([a.outHandle[0] * sx, a.outHandle[1] * sy] as [number, number])
          : a.outHandle,
      })),
    }));
    onChangeRef.current({ ...start, subpaths: subs });
  };

  // Resolve a bounding-box handle drag into a scale about the anchored
  // (opposite) edge/corner. `nx,ny` is the live pointer in normalized space.
  const applyBBoxDrag = (
    d: Extract<DragState, { kind: "bbox" }>,
    nx: number,
    ny: number,
    shift: boolean
  ) => {
    const { minX, minY, maxX, maxY } = d.startBox;
    const w0 = Math.max(1e-4, maxX - minX);
    const h0 = Math.max(1e-4, maxY - minY);
    const h = d.handle;
    const movesL = h === "l" || h === "tl" || h === "bl";
    const movesR = h === "r" || h === "tr" || h === "br";
    const movesT = h === "t" || h === "tl" || h === "tr";
    const movesB = h === "b" || h === "bl" || h === "br";
    // Anchor point = the opposite edge/corner (stays fixed). For edge drags
    // the unmoved axis pivots on its min (keeps that axis put, scale 1).
    const pivotX = movesL ? maxX : minX;
    const pivotY = movesT ? maxY : minY;
    let sx = movesL ? (maxX - nx) / w0 : movesR ? (nx - minX) / w0 : 1;
    let sy = movesT ? (maxY - ny) / h0 : movesB ? (ny - minY) / h0 : 1;
    const MIN = 0.02;
    if (sx < MIN) sx = MIN;
    if (sy < MIN) sy = MIN;
    // Shift on a corner locks aspect to the dominant axis.
    const isCorner = h === "tl" || h === "tr" || h === "br" || h === "bl";
    if (shift && isCorner) {
      const s = Math.abs(sx - 1) > Math.abs(sy - 1) ? sx : sy;
      sx = s;
      sy = s;
    }
    scaleWholePath(d.startValue, [pivotX, pivotY], sx, sy);
  };

  const deleteAnchorIndices = (indices: Set<number>) => {
    if (indices.size === 0) return;
    const cur = valueRef.current;
    const anchors = readAnchors(cur);
    const next = withSubpathPatch(cur, {
      anchors: anchors.filter((_, idx) => !indices.has(idx)),
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
    // Reindex the selection: anchors after `i` shift down by one, the
    // deleted index drops out. Without this the selection points at
    // stale slots after a delete.
    if (selectedRef.current.size > 0) {
      const nextSel = new Set<number>();
      for (const s of selectedRef.current) {
        if (s === i) continue;
        nextSel.add(s > i ? s - 1 : s);
      }
      setSelected(nextSel);
    }
  };

  // Toggle subpath.closed on the current subpath. Single source of
  // truth — downstream nodes (Stroke, Resample, Fill, etc.) all read
  // `subpath.closed` from the spline value, so flipping it here
  // propagates everywhere that cares.
  const toggleClosed = () => {
    const cur = valueRef.current;
    const wasClosed = subpathsOf(cur)[activeSubpathRef.current]?.closed ?? false;
    const next = withSubpathPatch(cur, { closed: !wasClosed });
    onChangeRef.current(next);
  };

  // Pen-on-empty when the active subpath is closed (or none exists): append a
  // fresh subpath seeded with the first anchor and make it active. Returns the
  // new active subpath index (its first anchor is index 0).
  const startNewSubpath = (nx: number, ny: number): number => {
    const cur = valueRef.current;
    const subs = subpathsOf(cur);
    const newSubs: SplineSubpath[] = [
      ...subs,
      { anchors: [{ pos: [nx, ny] }], closed: false },
    ];
    const newActive = newSubs.length - 1;
    onChangeRef.current({ ...cur, subpaths: newSubs });
    setActiveSubpath(newActive);
    setSelected(new Set());
    // We're now drawing this fresh subpath — clear any prior "sealed" state.
    setPenSealed(false);
    return newActive;
  };

  // Remove the active subpath (keeping ≥ 1 — never an empty subpaths array).
  // No-op when only one subpath exists. Clamps the active index to a neighbor.
  const deleteActiveSubpath = () => {
    const cur = valueRef.current;
    const subs = subpathsOf(cur);
    if (subs.length <= 1) return;
    const idx = activeSubpathRef.current;
    const newSubs = subs.filter((_, i) => i !== idx);
    onChangeRef.current({ ...cur, subpaths: newSubs });
    setActiveSubpath(Math.max(0, Math.min(idx, newSubs.length - 1)));
    setSelected(new Set());
  };

  const toggleCornerSmooth = (i: number) => {
    const anchors = readAnchors(valueRef.current);
    const a = anchors[i];
    if (!a) return;
    const hasHandles = !!a.inHandle || !!a.outHandle;
    if (hasHandles) {
      // Smooth → corner: strip handles. updateAnchor merges via
      // `{ ...a, ...patch }`, so simply omitting `inHandle` /
      // `outHandle` in the patch leaves the existing values in
      // place — bug! We need to explicitly overwrite them with
      // undefined so the spread drops them. JSON.stringify omits
      // undefined-valued props on save, so the cleaned anchor
      // round-trips correctly.
      updateAnchor(i, { inHandle: undefined, outHandle: undefined, broken: undefined });
    } else {
      // Corner → smooth: auto-tangent from neighbors.
      const { inHandle, outHandle } = autoSmoothHandles(anchors, i);
      updateAnchor(i, { inHandle, outHandle });
    }
  };

  // Resolve which anchors a context-menu action applies to: the whole
  // selection if the right-clicked anchor is part of a multi-selection,
  // otherwise just the clicked anchor.
  const targetsFor = (index: number): number[] => {
    const sel = selectedRef.current;
    if (sel.has(index) && sel.size > 1) return [...sel];
    return [index];
  };

  const applyHandleOp = (
    index: number,
    op: (a: SplineAnchor) => SplineAnchor
  ) => {
    const anchors = readAnchors(valueRef.current);
    const patches = new Map<number, Partial<SplineAnchor>>();
    for (const idx of targetsFor(index)) {
      const a = anchors[idx];
      if (!a) continue;
      const r = op(a);
      patches.set(idx, {
        inHandle: r.inHandle,
        outHandle: r.outHandle,
        broken: r.broken,
      });
    }
    if (patches.size) patchAnchors(patches);
  };

  // --- segment geometry (for hover + direct drag) --------------------------

  // The current subpath's segments as { seg, i, j, d } where `d` is the SVG
  // path string in client px. Used both to paint hit/hover paths and to
  // recompute t at drag-start. Memoized on value/rect so it tracks edits.
  const segments = useMemo(() => {
    if (!rect) return [] as { seg: number; i: number; j: number; d: string }[];
    const sub = subpathsOf(value)[activeSubpathRef.current];
    const anchors = sub?.anchors ?? [];
    const closed = sub?.closed ?? false;
    const n = anchors.length;
    const count = closed ? n : n - 1;
    const out: { seg: number; i: number; j: number; d: string }[] = [];
    for (let s = 0; s < count; s++) {
      const i = s;
      const j = (s + 1) % n;
      const a = anchors[i];
      const b = anchors[j];
      const p0 = normToPx(a.pos);
      const p1 = a.outHandle
        ? normToPx([a.pos[0] + a.outHandle[0], a.pos[1] + a.outHandle[1]])
        : p0;
      const p3 = normToPx(b.pos);
      const p2 = b.inHandle
        ? normToPx([b.pos[0] + b.inHandle[0], b.pos[1] + b.inHandle[1]])
        : p3;
      out.push({
        seg: s,
        i,
        j,
        d: `M ${p0.x} ${p0.y} C ${p1.x} ${p1.y}, ${p2.x} ${p2.y}, ${p3.x} ${p3.y}`,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, rect, activeSubpath]);

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
            // Compute the world-space delta from gesture start. Group
            // drags use the snapshot to keep relative offsets exact;
            // single drags fall back to the original grab-offset path.
            if (drag.groupStarts && drag.groupStarts.size > 1) {
              const start = drag.groupStarts.get(drag.index);
              if (!start) break;
              const targetX = nx + drag.grabOffset.x;
              const targetY = ny + drag.grabOffset.y;
              moveAnchors(
                drag.groupStarts,
                targetX - start[0],
                targetY - start[1]
              );
            } else {
              updateAnchor(drag.index, {
                pos: [nx + drag.grabOffset.x, ny + drag.grabOffset.y],
              });
            }
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
        case "segment": {
          // Bend the cubic so it passes under the cursor while the anchors
          // (P0, P3) stay pinned. The grabbed point depends on the two
          // interior controls through the Bernstein weights b1, b2; the
          // constraint b1·ΔP1 + b2·ΔP2 = D is underdetermined, so we take
          // the minimum-norm least-squares solution — each handle shifts in
          // proportion to its influence at t. t is cached from drag-start so
          // the curve doesn't slide under the cursor.
          const A = anchors[drag.i];
          const B = anchors[drag.j];
          if (!A || !B) break;
          const P0 = A.pos;
          const P3 = B.pos;
          const outH = A.outHandle ?? ([0, 0] as [number, number]);
          const inH = B.inHandle ?? ([0, 0] as [number, number]);
          const P1: [number, number] = [P0[0] + outH[0], P0[1] + outH[1]];
          const P2: [number, number] = [P3[0] + inH[0], P3[1] + inH[1]];
          const bt = bezierAt(P0, P1, P2, P3, drag.t);
          const Dx = nx - bt[0];
          const Dy = ny - bt[1];
          const u = 1 - drag.t;
          const b1 = 3 * u * u * drag.t;
          const b2 = 3 * u * drag.t * drag.t;
          const denom = b1 * b1 + b2 * b2;
          if (denom < 1e-6) break; // grabbed right at an anchor; nothing to do
          const k1 = b1 / denom;
          const k2 = b2 / denom;
          patchAnchors(
            new Map<number, Partial<SplineAnchor>>([
              [
                drag.i,
                {
                  outHandle: [outH[0] + Dx * k1, outH[1] + Dy * k1],
                  broken: true,
                },
              ],
              [
                drag.j,
                {
                  inHandle: [inH[0] + Dx * k2, inH[1] + Dy * k2],
                  broken: true,
                },
              ],
            ])
          );
          break;
        }
        case "marquee": {
          setDrag({ ...drag, currentClient: { x: e.clientX, y: e.clientY } });
          break;
        }
        case "path-move": {
          // Translate the whole path from the start snapshot by the
          // normalized pointer delta.
          translateWholePath(
            drag.startValue,
            nx - drag.startNorm[0],
            ny - drag.startNorm[1]
          );
          break;
        }
        case "bbox": {
          // Scale the whole path about the anchored edge/corner. Computed
          // from the start box + snapshot so the drag doesn't compound.
          applyBBoxDrag(drag, nx, ny, e.shiftKey);
          break;
        }
      }
    };

    const onUp = (e: PointerEvent) => {
      if (drag.kind === "anchor" && !drag.moved) {
        const dx = e.clientX - drag.startClient.x;
        const dy = e.clientY - drag.startClient.y;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) {
          if (tool === "pen") {
            // Add-mode quick click on an existing anchor: close the
            // spline if it's the first anchor of an open path with
            // ≥3 anchors, otherwise toggle corner ↔ smooth.
            const sub = subpathsOf(valueRef.current)[activeSubpathRef.current];
            const anchors = sub?.anchors ?? [];
            const isStart = drag.index === 0;
            const closed = sub?.closed ?? false;
            if (isStart && !closed && anchors.length >= 3) {
              toggleClosed();
            } else {
              toggleCornerSmooth(drag.index);
            }
          }
          // Select-mode click was already handled at pointerdown
          // (the anchor was added to the selection there). No further
          // action on the up — just drop the drag state.
        }
      }
      if (drag.kind === "marquee") {
        // Resolve which anchors lie inside the marquee rect and either
        // replace the selection or extend it (shift-marquee).
        const x0 = Math.min(drag.startClient.x, drag.currentClient.x);
        const x1 = Math.max(drag.startClient.x, drag.currentClient.x);
        const y0 = Math.min(drag.startClient.y, drag.currentClient.y);
        const y1 = Math.max(drag.startClient.y, drag.currentClient.y);
        const moved = Math.hypot(x1 - x0, y1 - y0) >= DRAG_THRESHOLD;
        if (moved) {
          const anchors = readAnchors(valueRef.current);
          const next = drag.additive
            ? new Set(drag.baseSelection)
            : new Set<number>();
          for (let i = 0; i < anchors.length; i++) {
            const p = normToPx(anchors[i].pos);
            if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) {
              next.add(i);
            }
          }
          setSelected(next);
        } else if (!drag.additive) {
          // Plain click on empty space with no drag clears selection.
          setSelected(new Set());
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

  // Track the cursor in add mode (when not mid-gesture) to drive the dotted
  // rubber-band preview of the next segment.
  useEffect(() => {
    if (tool !== "pen") {
      setHoverPx(null);
      return;
    }
    const onMove = (e: PointerEvent) =>
      setHoverPx({ x: e.clientX, y: e.clientY });
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [tool]);

  // Close the context menu on any outside mousedown.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && el.closest("[data-spline-menu]")) return;
      setMenu(null);
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [menu]);

  const onBackgroundPointerDown = (e: React.PointerEvent<SVGRectElement>) => {
    if (!rect) return;
    if (e.button !== 0) return; // left only; right-click adds nothing
    setMenu(null);
    e.preventDefault();
    e.stopPropagation();
    if (tool === "subpath") {
      // Background drag in sub-path mode → marquee. Plain click without
      // movement clears the selection (resolved in onUp).
      setDrag({
        kind: "marquee",
        startClient: { x: e.clientX, y: e.clientY },
        currentClient: { x: e.clientX, y: e.clientY },
        additive: e.shiftKey,
        baseSelection: new Set(selectedRef.current),
      });
      return;
    }
    if (tool === "path") {
      // Path Select: background click clears the anchor selection. Move /
      // scale of the whole path happen via its body + bounding-box handles.
      setSelected(new Set());
      return;
    }
    // Shift in pen mode = insert a point on the nearest existing segment
    // (split the curve) instead of appending a new endpoint.
    if (e.shiftKey) {
      const ins = findInsertOnSpline(e.clientX, e.clientY);
      if (ins) {
        insertAnchorOnSegment(ins.i, ins.j, ins.t);
        return;
      }
    }
    const [nx, ny] = clientToNorm(e.clientX, e.clientY);
    // Extend the active subpath, unless it's closed (or there are none) — then
    // start a fresh subpath. Either way the new anchor's index within its
    // subpath is what the "new" drag tracks (0 for a fresh subpath).
    const active = subpathsOf(valueRef.current)[activeSubpathRef.current];
    let newIdx: number;
    // Extend the active subpath, unless it's closed, sealed (Enter), or there
    // are none — then start a fresh subpath.
    if (active && !active.closed && !penSealedRef.current) {
      newIdx = addAnchorAt(nx, ny);
    } else {
      startNewSubpath(nx, ny);
      newIdx = 0;
    }
    lastAnchorRef.current = newIdx;
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
      setMenu(null);
      e.preventDefault();
      e.stopPropagation();
      const [nx, ny] = clientToNorm(e.clientX, e.clientY);
      const a = readAnchors(valueRef.current)[index];
      if (!a) return;
      lastAnchorRef.current = index;
      // Select-mode click resolves the selection up-front so a drag of
      // a freshly-clicked anchor moves the right group. Shift extends.
      // In add mode the selection state isn't surfaced, so leave it
      // alone — the click-no-drag path triggers corner↔smooth toggling.
      let groupStarts: Map<number, [number, number]> | undefined;
      if (tool === "subpath") {
        const cur = new Set(selectedRef.current);
        if (e.shiftKey) {
          if (cur.has(index)) cur.delete(index);
          else cur.add(index);
        } else if (!cur.has(index)) {
          cur.clear();
          cur.add(index);
        }
        setSelected(cur);
        const anchors = readAnchors(valueRef.current);
        groupStarts = new Map();
        for (const i of cur) {
          const ai = anchors[i];
          if (ai) groupStarts.set(i, [ai.pos[0], ai.pos[1]]);
        }
      }
      setDrag({
        kind: "anchor",
        index,
        grabOffset: { x: a.pos[0] - nx, y: a.pos[1] - ny },
        startClient: { x: e.clientX, y: e.clientY },
        moved: false,
        groupStarts,
      });
    };

  const onHandlePointerDown =
    (index: number, side: "in" | "out") =>
    (e: React.PointerEvent<SVGCircleElement>) => {
      if (!rect) return;
      if (e.button !== 0) return;
      setMenu(null);
      e.preventDefault();
      e.stopPropagation();
      const a = readAnchors(valueRef.current)[index];
      const wasBroken = !!a?.broken;
      lastAnchorRef.current = index;
      // Alt held on pointerdown *breaks* the anchor persistently — the two
      // handles become independent and stay that way for future drags too
      // (fixing the old bug where a later plain drag re-mirrored them). A
      // smooth (un-broken) anchor mirrors its partner; a broken one moves
      // each handle alone.
      if (e.altKey && !wasBroken) updateAnchor(index, { broken: true });
      setDrag({
        kind: "handle",
        index,
        side,
        symmetric: !e.altKey && !wasBroken,
        startClient: { x: e.clientX, y: e.clientY },
      });
    };

  const onSegmentPointerDown =
    (seg: { seg: number; i: number; j: number }) =>
    (e: React.PointerEvent<SVGPathElement>) => {
      if (!rect) return;
      if (e.button !== 0) return;
      if (tool !== "subpath") return;
      setMenu(null);
      e.preventDefault();
      e.stopPropagation();
      const anchors = readAnchors(valueRef.current);
      const A = anchors[seg.i];
      const B = anchors[seg.j];
      if (!A || !B) return;
      // Find the grabbed parameter t by projecting the cursor onto the cubic
      // in pixel space (so "nearest" matches what the user sees). Cache it so
      // the curve tracks the cursor without sliding.
      const p0 = normToPx(A.pos);
      const p1 = A.outHandle
        ? normToPx([A.pos[0] + A.outHandle[0], A.pos[1] + A.outHandle[1]])
        : p0;
      const p3 = normToPx(B.pos);
      const p2 = B.inHandle
        ? normToPx([B.pos[0] + B.inHandle[0], B.pos[1] + B.inHandle[1]])
        : p3;
      const t = nearestTOnCubic(
        [p0.x, p0.y],
        [p1.x, p1.y],
        [p2.x, p2.y],
        [p3.x, p3.y],
        [e.clientX, e.clientY]
      );
      setHoverSeg(seg.seg);
      setDrag({
        kind: "segment",
        seg: seg.seg,
        i: seg.i,
        j: seg.j,
        t,
        startClient: { x: e.clientX, y: e.clientY },
      });
    };

  // Sub-path mode: click an (inactive) subpath's outline to make it active.
  const onSubpathSelectDown =
    (index: number) => (e: React.PointerEvent<SVGPathElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      selectSubpath(index);
    };

  // Path mode: click any subpath to select the whole path (make that subpath
  // active) and begin a whole-path move.
  const onPathGrabDown =
    (index: number) => (e: React.PointerEvent<SVGPathElement>) => {
      if (!rect) return;
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (index !== activeSubpathRef.current) selectSubpath(index);
      const [nx, ny] = clientToNorm(e.clientX, e.clientY);
      setDrag({
        kind: "path-move",
        startClient: { x: e.clientX, y: e.clientY },
        startNorm: [nx, ny],
        startValue: valueRef.current,
      });
    };

  // Path mode: grab a bounding-box handle to scale the whole path.
  const onBBoxHandleDown =
    (handle: BBoxHandle) => (e: React.PointerEvent<SVGRectElement>) => {
      if (!rect || !pathBBox) return;
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      setDrag({
        kind: "bbox",
        handle,
        startClient: { x: e.clientX, y: e.clientY },
        startBox: { ...pathBBox },
        startValue: valueRef.current,
      });
    };

  const onAnchorContextMenu =
    (index: number) => (e: React.MouseEvent<SVGCircleElement>) => {
      e.preventDefault();
      e.stopPropagation();
      // Surface which anchor the menu targets. Keep an existing
      // multi-selection if the clicked anchor is part of it.
      if (!selectedRef.current.has(index)) setSelected(new Set([index]));
      lastAnchorRef.current = index;
      setMenu({ x: e.clientX, y: e.clientY, index });
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
      if (a.broken) cleaned.broken = a.broken;
      updateAnchor(index, cleaned);
    };

  // --- rendering -----------------------------------------------------------

  const pathD = useMemo(() => {
    if (!rect) return "";
    const sub = subpathsOf(value)[activeSubpathRef.current];
    return subpathToPathD(sub?.anchors ?? [], sub?.closed ?? false, normToPx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rect, value, activeSubpath]);

  // Muted outlines for every subpath except the active one — so a compound /
  // multi-path shape (e.g. a converted multi-path SVG) shows all its pieces
  // while you edit one at a time.
  const inactivePathsD = useMemo(() => {
    if (!rect) return [] as { index: number; d: string }[];
    const subs = subpathsOf(value);
    const out: { index: number; d: string }[] = [];
    for (let s = 0; s < subs.length; s++) {
      if (s === activeSubpathRef.current) continue;
      const d = subpathToPathD(subs[s]?.anchors ?? [], subs[s]?.closed ?? false, normToPx);
      if (d) out.push({ index: s, d });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rect, value, activeSubpath]);

  // Every subpath's outline (incl. active) — drives Path Select hit-testing
  // (click any subpath to grab the whole path).
  const allSubpathsD = useMemo(() => {
    if (!rect) return [] as { index: number; d: string }[];
    const subs = subpathsOf(value);
    const out: { index: number; d: string }[] = [];
    for (let s = 0; s < subs.length; s++) {
      const d = subpathToPathD(subs[s]?.anchors ?? [], subs[s]?.closed ?? false, normToPx);
      if (d) out.push({ index: s, d });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rect, value]);

  // Bounding box of the whole path (all anchors, normalized space). Drives the
  // Path Select bounding-box transform handle (A6). Null when there are no
  // anchors. Sampled off anchor positions (not flattened curve extent) — close
  // enough for a transform gizmo and cheap.
  const pathBBox = useMemo(() => {
    const subs = subpathsOf(value);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const s of subs) {
      for (const a of s.anchors) {
        if (a.pos[0] < minX) minX = a.pos[0];
        if (a.pos[0] > maxX) maxX = a.pos[0];
        if (a.pos[1] < minY) minY = a.pos[1];
        if (a.pos[1] > maxY) maxY = a.pos[1];
      }
    }
    if (!Number.isFinite(minX)) return null;
    return { minX, minY, maxX, maxY };
  }, [value]);

  // Dotted rubber-band from the last anchor to the cursor (add mode only),
  // previewing the next point. A corner last anchor (no out handle) draws a
  // straight line. A weighted last anchor (out handle, from a click-drag)
  // draws a curve that leaves along the out tangent so the user sees the
  // approximated curvature of the next segment.
  //
  // Two guards keep it from reading as a hook/loop (the earlier version's
  // failure mode): the leaving tangent length is clamped to the distance to
  // the cursor so it can't overshoot, and the second control gets a real
  // arrival tangent (a third of the way back from the cursor toward the
  // first control) instead of sitting on the endpoint — `cp2 == cursor`
  // forces the end velocity to zero and curls the tail into a cusp.
  const rubberD = useMemo(() => {
    // Hidden while shift-inserting (the insert preview takes over) or after the
    // active subpath has been sealed (Enter) — there's nothing to extend.
    if (tool !== "pen" || drag || !hoverPx || !rect || shiftHeld || penSealed)
      return "";
    const sub = subpathsOf(value)[activeSubpathRef.current];
    const anchors = sub?.anchors ?? [];
    if (anchors.length < 1 || (sub?.closed ?? false)) return "";
    const last = anchors[anchors.length - 1];
    const p0 = normToPx(last.pos);
    if (!last.outHandle) {
      return `M ${p0.x} ${p0.y} L ${hoverPx.x} ${hoverPx.y}`;
    }
    const h = normToPx([
      last.pos[0] + last.outHandle[0],
      last.pos[1] + last.outHandle[1],
    ]);
    const hx = h.x - p0.x;
    const hy = h.y - p0.y;
    const hLen = Math.hypot(hx, hy) || 1;
    const segLen = Math.hypot(hoverPx.x - p0.x, hoverPx.y - p0.y);
    const L = Math.min(hLen, segLen); // clamp so it can't overshoot the cursor
    const cp1x = p0.x + (hx / hLen) * L;
    const cp1y = p0.y + (hy / hLen) * L;
    const cp2x = hoverPx.x + (cp1x - hoverPx.x) / 3;
    const cp2y = hoverPx.y + (cp1y - hoverPx.y) / 3;
    return `M ${p0.x} ${p0.y} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${hoverPx.x} ${hoverPx.y}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, drag, hoverPx, value, rect, shiftHeld, activeSubpath, penSealed]);

  // Insert-on-path preview: while shift is held in add mode, snap a ghost
  // point to the nearest spot on the spline so the user sees where a click
  // would split the curve.
  const insertPreview = useMemo(() => {
    if (tool !== "pen" || !shiftHeld || drag || !hoverPx || !rect) return null;
    return findInsertOnSpline(hoverPx.x, hoverPx.y);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, shiftHeld, drag, hoverPx, value, rect, activeSubpath]);

  if (!rect) return null;

  // Path Select hides the per-anchor editing UI (anchors / handles / segment
  // hit paths) — that mode shows only the path outlines + bounding box. Pen
  // and Sub-path modes render the active subpath's anchors for editing.
  const anchors =
    tool === "path"
      ? []
      : subpathsOf(value)[activeSubpathRef.current]?.anchors ?? [];
  const activeSeg =
    drag?.kind === "segment" ? drag.seg : hoverSeg !== null ? hoverSeg : null;
  const activeSegD =
    activeSeg !== null ? segments.find((s) => s.seg === activeSeg)?.d : undefined;

  return (
    <div
      // Registering as a shortcut scope makes Delete contextual: clicking the
      // canvas sets the active scope to "spline" (see shortcut-scope.ts), so
      // the node editor's window-level Delete handler stands down and we delete
      // points here instead of the graph node.
      data-shortcut-scope="spline"
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        // Above canvas, below Track Editor dock and other UI chrome.
        zIndex: 2,
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
        {/* Canvas-area background. Pen mode: click adds an anchor (or starts
            a new subpath). Sub-path mode: starts a marquee (or clears the
            anchor selection). Path mode: clears the whole-path selection. */}
        <rect
          x={rect.left}
          y={rect.top}
          width={rect.width}
          height={rect.height}
          fill="transparent"
          style={{
            cursor: tool === "pen" ? "crosshair" : "default",
            pointerEvents: "auto",
          }}
          onPointerDown={onBackgroundPointerDown}
          onContextMenu={(e) => e.preventDefault()}
        />

        {/* Sub-path mode: clicking an inactive subpath's outline activates it
            (then its anchors become editable). Drawn below the active
            subpath's segment hit paths so bending the active curve still
            wins where they overlap. */}
        {tool === "subpath" &&
          inactivePathsD.map((p) => (
            <path
              key={`subsel-${p.index}`}
              d={p.d}
              fill="none"
              stroke="transparent"
              strokeWidth={SEGMENT_HIT_W}
              strokeLinecap="round"
              style={{ cursor: "pointer", pointerEvents: "stroke" }}
              onPointerDown={onSubpathSelectDown(p.index)}
              onContextMenu={(e) => e.preventDefault()}
            />
          ))}

        {/* Path mode: every subpath is a grab target for moving the whole
            path. */}
        {tool === "path" &&
          allSubpathsD.map((p) => (
            <path
              key={`pathgrab-${p.index}`}
              d={p.d}
              fill="none"
              stroke="transparent"
              strokeWidth={SEGMENT_HIT_W}
              strokeLinecap="round"
              style={{ cursor: "move", pointerEvents: "stroke" }}
              onPointerDown={onPathGrabDown(p.index)}
              onContextMenu={(e) => e.preventDefault()}
            />
          ))}

        {/* Invisible per-segment hit paths (sub-path mode only) — drive hover
            highlighting and direct segment dragging. Drawn beneath the
            anchor/handle hit rings so grabbing an endpoint still wins. */}
        {tool === "subpath" &&
          segments.map((s) => (
            <path
              key={`seg-${s.seg}`}
              d={s.d}
              fill="none"
              stroke="transparent"
              strokeWidth={SEGMENT_HIT_W}
              strokeLinecap="round"
              style={{ cursor: "grab", pointerEvents: "stroke" }}
              onPointerEnter={() => {
                if (!drag) setHoverSeg(s.seg);
              }}
              onPointerLeave={() => {
                if (!drag) setHoverSeg((cur) => (cur === s.seg ? null : cur));
              }}
              onPointerDown={onSegmentPointerDown(s)}
              onContextMenu={(e) => e.preventDefault()}
            />
          ))}

        {/* Inactive subpaths — muted, non-interactive outlines so the whole
            compound shape stays visible while one subpath is edited. */}
        {inactivePathsD.map((p) => (
          <path
            key={`inactive-${p.index}`}
            d={p.d}
            fill="none"
            stroke={COL_INACTIVE}
            strokeWidth={1.1}
            opacity={0.8}
            style={{ pointerEvents: "none" }}
          />
        ))}

        {/* Path preview — non-interactive; just shows the curve the user
            is authoring. */}
        {pathD && (
          <path
            d={pathD}
            fill="none"
            stroke={COL_PATH}
            strokeWidth={1.2}
            opacity={0.9}
            style={{ pointerEvents: "none" }}
          />
        )}

        {/* Hovered / dragged segment highlight, painted over the preview. */}
        {activeSegD && (
          <path
            d={activeSegD}
            fill="none"
            stroke={COL_SEG_HOVER}
            strokeWidth={3}
            opacity={0.55}
            strokeLinecap="round"
            style={{ pointerEvents: "none" }}
          />
        )}

        {/* Handle lines (anchor → handle dot). Drawn beneath the dots so
            the dots sit visually on top. */}
        {anchors.map((a, i) => {
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
                stroke={COL_HANDLE_LINE}
                strokeWidth={1}
                opacity={0.7}
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
                stroke={COL_HANDLE_LINE}
                strokeWidth={1}
                opacity={0.7}
                style={{ pointerEvents: "none" }}
              />
            );
          }
          return lines;
        })}

        {/* Layered rendering: paint passes are split so anchor hit
            rings sit ABOVE handle hit rings in the SVG stack. Without
            this, a click near the anchor that overlaps a nearby
            bezier-handle hit ring gets caught by the handle (SVG
            paints later siblings on top), starting a handle drag
            instead of triggering the anchor's click-toggle.

            Order from bottom to top:
              1. Handle hit rings (transparent, large)
              2. Anchor hit rings (transparent, large) — on top so
                 clicks within anchor radius win
              3. Anchor visual marks (square=corner, circle=smooth)
              4. Handle visual dots — visually on top */}

        {/* Pass 1 — handle hit rings */}
        {anchors.map((a, i) => {
          const out: ReactElement[] = [];
          if (a.inHandle) {
            const p = normToPx([
              a.pos[0] + a.inHandle[0],
              a.pos[1] + a.inHandle[1],
            ]);
            out.push(
              <circle
                key={`hh-${i}-in`}
                cx={p.x}
                cy={p.y}
                r={HANDLE_HIT_R}
                fill="transparent"
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
            out.push(
              <circle
                key={`hh-${i}-out`}
                cx={p.x}
                cy={p.y}
                r={HANDLE_HIT_R}
                fill="transparent"
                style={{ cursor: "grab", pointerEvents: "auto" }}
                onPointerDown={onHandlePointerDown(i, "out")}
                onContextMenu={onHandleContextMenu(i, "out")}
              />
            );
          }
          return out;
        })}

        {/* Pass 2 — anchor hit rings on top, so they intercept clicks
            within their radius even when a handle is nearby. */}
        {anchors.map((a, i) => {
          const p = normToPx(a.pos);
          return (
            <circle
              key={`ah-${i}`}
              cx={p.x}
              cy={p.y}
              r={ANCHOR_HIT_R}
              fill="transparent"
              style={{ cursor: "grab", pointerEvents: "auto" }}
              onPointerDown={onAnchorPointerDown(i)}
              onContextMenu={onAnchorContextMenu(i)}
            />
          );
        })}

        {/* Pass 3 — anchor visual marks. Corner anchors (no handles) draw
            as squares; smooth/handled anchors as circles. Blue outline with
            a faint fill; selected anchors switch to amber. */}
        {anchors.map((a, i) => {
          const p = normToPx(a.pos);
          const isSel = selected.has(i);
          const hasHandles = !!a.inHandle || !!a.outHandle;
          const stroke = isSel ? COL_SEL_STROKE : COL_STROKE;
          const fill = isSel ? COL_SEL_FILL : COL_FILL;
          if (hasHandles) {
            return (
              <circle
                key={`av-${i}`}
                cx={p.x}
                cy={p.y}
                r={isSel ? ANCHOR_R + 1 : ANCHOR_R}
                fill={fill}
                stroke={stroke}
                strokeWidth={1.4}
                style={{ pointerEvents: "none" }}
              />
            );
          }
          const half = (isSel ? ANCHOR_SQUARE + 2 : ANCHOR_SQUARE) / 2;
          return (
            <rect
              key={`av-${i}`}
              x={p.x - half}
              y={p.y - half}
              width={half * 2}
              height={half * 2}
              fill={fill}
              stroke={stroke}
              strokeWidth={1.4}
              style={{ pointerEvents: "none" }}
            />
          );
        })}

        {/* Pass 4 — handle visual dots, on top of anchor visuals. Hit rings
            are already in pass 1 so these are pointer-event-free. */}
        {anchors.map((a, i) => {
          const dots: ReactElement[] = [];
          if (a.inHandle) {
            const p = normToPx([
              a.pos[0] + a.inHandle[0],
              a.pos[1] + a.inHandle[1],
            ]);
            dots.push(
              <circle
                key={`hv-${i}-in`}
                cx={p.x}
                cy={p.y}
                r={HANDLE_R}
                fill={COL_HANDLE_FILL}
                stroke={COL_HANDLE_STROKE}
                strokeWidth={1}
                style={{ pointerEvents: "none" }}
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
                key={`hv-${i}-out`}
                cx={p.x}
                cy={p.y}
                r={HANDLE_R}
                fill={COL_HANDLE_FILL}
                stroke={COL_HANDLE_STROKE}
                strokeWidth={1}
                style={{ pointerEvents: "none" }}
              />
            );
          }
          return dots;
        })}

        {/* Dotted rubber-band preview of the next segment (add mode). */}
        {rubberD && (
          <path
            d={rubberD}
            fill="none"
            stroke={COL_RUBBER}
            strokeWidth={1.2}
            strokeDasharray="4 4"
            opacity={0.7}
            style={{ pointerEvents: "none" }}
          />
        )}

        {/* Insert-on-path preview dot (shift held in add mode). Marks where a
            click would split the curve. */}
        {insertPreview && (
          <circle
            cx={insertPreview.x}
            cy={insertPreview.y}
            r={ANCHOR_R + 1}
            fill={COL_FILL}
            stroke={COL_STROKE}
            strokeWidth={1.4}
            style={{ pointerEvents: "none" }}
          />
        )}

        {/* Marquee box rendered last so it sits visually on top of the
            anchors / handles while the user drags. */}
        {drag?.kind === "marquee" && (
          <rect
            x={Math.min(drag.startClient.x, drag.currentClient.x)}
            y={Math.min(drag.startClient.y, drag.currentClient.y)}
            width={Math.abs(drag.currentClient.x - drag.startClient.x)}
            height={Math.abs(drag.currentClient.y - drag.startClient.y)}
            fill="rgba(251, 191, 36, 0.1)"
            stroke="#fbbf24"
            strokeDasharray="3 3"
            style={{ pointerEvents: "none" }}
          />
        )}

        {/* Path Select bounding box — drag the interior to move, the handles
            to scale (baked into geometry; no node params). Per-axis handles
            are suppressed on a degenerate (zero-extent) axis. */}
        {tool === "path" && pathBBox && (() => {
          const bw = pathBBox.maxX - pathBBox.minX;
          const bh = pathBBox.maxY - pathBBox.minY;
          const hasW = bw > 1e-3;
          const hasH = bh > 1e-3;
          if (!hasW && !hasH) return null;
          const tl = normToPx([pathBBox.minX, pathBBox.minY]);
          const br = normToPx([pathBBox.maxX, pathBBox.maxY]);
          const x0 = Math.min(tl.x, br.x);
          const y0 = Math.min(tl.y, br.y);
          const x1 = Math.max(tl.x, br.x);
          const y1 = Math.max(tl.y, br.y);
          const midX = (x0 + x1) / 2;
          const midY = (y0 + y1) / 2;
          const HS = 8;
          const defs = (
            [
              { h: "tl", x: x0, y: y0, cursor: "nwse-resize" },
              { h: "tr", x: x1, y: y0, cursor: "nesw-resize" },
              { h: "br", x: x1, y: y1, cursor: "nwse-resize" },
              { h: "bl", x: x0, y: y1, cursor: "nesw-resize" },
              { h: "t", x: midX, y: y0, cursor: "ns-resize" },
              { h: "b", x: midX, y: y1, cursor: "ns-resize" },
              { h: "l", x: x0, y: midY, cursor: "ew-resize" },
              { h: "r", x: x1, y: midY, cursor: "ew-resize" },
            ] as { h: BBoxHandle; x: number; y: number; cursor: string }[]
          ).filter((d) =>
            d.h === "l" || d.h === "r"
              ? hasW
              : d.h === "t" || d.h === "b"
                ? hasH
                : hasW && hasH
          );
          return (
            <>
              {/* Interior move target — drag anywhere inside to move the path. */}
              <rect
                x={x0}
                y={y0}
                width={x1 - x0}
                height={y1 - y0}
                fill="transparent"
                style={{ cursor: "move", pointerEvents: "auto" }}
                onPointerDown={onPathGrabDown(activeSubpath)}
                onContextMenu={(e) => e.preventDefault()}
              />
              {/* Box outline. */}
              <rect
                x={x0}
                y={y0}
                width={x1 - x0}
                height={y1 - y0}
                fill="none"
                stroke={COL_PATH}
                strokeWidth={1}
                strokeDasharray="4 3"
                opacity={0.9}
                style={{ pointerEvents: "none" }}
              />
              {/* Scale handles. */}
              {defs.map((d) => (
                <rect
                  key={`bbox-${d.h}`}
                  x={d.x - HS / 2}
                  y={d.y - HS / 2}
                  width={HS}
                  height={HS}
                  rx={1.5}
                  fill="#111"
                  stroke={COL_PATH}
                  strokeWidth={1}
                  style={{ cursor: d.cursor, pointerEvents: "auto" }}
                  onPointerDown={onBBoxHandleDown(d.h)}
                  onContextMenu={(e) => e.preventDefault()}
                />
              ))}
            </>
          );
        })()}
      </svg>

      {/* Tool dock, pinned to the viewport panel's upper-left. Positioned in
          client coords via `hostRect` (the canvas's containing panel) so it
          docks to the window corner rather than the letterboxed canvas edge,
          and stays put through splitter drags / resize / zoom. Lives outside
          the SVG to keep its hit-testing simple. */}
      <div
        style={{
          position: "fixed",
          left: (hostRect ?? rect).left + 8,
          top: (hostRect ?? rect).top + 8,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 4,
          padding: 3,
          background: "rgba(17, 17, 17, 0.9)",
          border: "1px solid #27272a",
          borderRadius: 6,
          boxShadow: "0 4px 12px rgba(0, 0, 0, 0.35)",
          pointerEvents: "auto",
          fontFamily: "ui-monospace, monospace",
        }}
      >
        {/* Mode: Add / Select — a vertically stacked segmented pill whose
            active highlight and hover ghost both slide between the segments. */}
        <ModeSlider tool={tool} onSelect={setTool} />
        {/* Divider before the standalone close-loop toggle. */}
        <div
          style={{
            height: 1,
            width: TOOL_BTN,
            margin: "1px 0",
            background: "#3f3f46",
          }}
        />
        {/* Close loop — a stateful toggle, not a mode, so it lives outside the
            sliding pill and lights up independently. */}
        <IconToggle
          active={subpathsOf(value)[activeSubpath]?.closed ?? false}
          label="Close loop"
          onClick={toggleClosed}
        >
          <LoopIcon />
        </IconToggle>
        {/* Delete the active subpath — only when there's more than one (we
            never reduce to an empty subpaths array). */}
        {subpathsOf(value).length > 1 && (
          <IconToggle
            active={false}
            label="Delete sub-path (⌫)"
            onClick={deleteActiveSubpath}
          >
            <TrashIcon />
          </IconToggle>
        )}
      </div>

      {/* Anchor context menu. */}
      {menu && (
        <div
          data-spline-menu
          style={{
            position: "fixed",
            left: menu.x,
            top: menu.y,
            minWidth: 150,
            padding: 4,
            background: "rgba(17, 17, 17, 0.97)",
            border: "1px solid #3f3f46",
            borderRadius: 5,
            boxShadow: "0 6px 18px rgba(0, 0, 0, 0.45)",
            pointerEvents: "auto",
            fontFamily: "ui-monospace, monospace",
            fontSize: 12,
            zIndex: 10,
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <MenuItem
            label="Delete point"
            onClick={() => {
              const targets = new Set(targetsFor(menu.index));
              deleteAnchorIndices(targets);
              setSelected(new Set());
              setMenu(null);
            }}
          />
          <MenuItem
            label="Align handles"
            onClick={() => {
              applyHandleOp(menu.index, alignHandles);
              setMenu(null);
            }}
          />
          <MenuItem
            label="Even handles"
            onClick={() => {
              applyHandleOp(menu.index, evenHandles);
              setMenu(null);
            }}
          />
        </div>
      )}
    </div>
  );
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "5px 9px",
        background: hover ? "#0ea5e9" : "transparent",
        color: hover ? "#0b1220" : "#e4e4e7",
        border: "none",
        borderRadius: 3,
        cursor: "pointer",
        fontFamily: "inherit",
        fontSize: "inherit",
      }}
    >
      {label}
    </button>
  );
}

// Segment size for the mode pill (square icon buttons sit edge-to-edge so the
// sliding highlight is contiguous).
const TOOL_BTN = 26;
const TOOL_INSET = 2; // gap between a segment edge and its highlight

// Add / Select mode picker. A single active highlight (low-opacity blue fill +
// blue stroke) slides between the two segments, and a neutral hover ghost
// slides to whichever segment is hovered — matching the app's PillToggle.
function ModeSlider({
  tool,
  onSelect,
}: {
  tool: ToolMode;
  onSelect: (t: ToolMode) => void;
}) {
  const items: { id: ToolMode; label: string; icon: ReactElement }[] = [
    { id: "pen", label: "Pen (P)", icon: <PenIcon /> },
    { id: "path", label: "Path select (V)", icon: <FilledArrowIcon /> },
    { id: "subpath", label: "Sub-path select (A)", icon: <OutlineArrowIcon /> },
  ];
  const activeIdx = Math.max(
    0,
    items.findIndex((it) => it.id === tool)
  );
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const ghostIdx = hoverIdx ?? activeIdx;
  return (
    <div
      onMouseLeave={() => setHoverIdx(null)}
      style={{ position: "relative", display: "flex", flexDirection: "column" }}
    >
      {/* Active highlight — slides vertically between segments. */}
      <div
        style={{
          position: "absolute",
          left: TOOL_INSET,
          right: TOOL_INSET,
          top: activeIdx * TOOL_BTN + TOOL_INSET,
          height: TOOL_BTN - TOOL_INSET * 2,
          background: COL_FILL,
          border: `1px solid ${COL_STROKE}`,
          borderRadius: 4,
          boxSizing: "border-box",
          transition: "top 0.16s cubic-bezier(0.4,0,0.2,1)",
          pointerEvents: "none",
        }}
      />
      {/* Hover ghost — slides to the hovered segment, shown only when hovering
          a non-active one. */}
      <div
        style={{
          position: "absolute",
          left: TOOL_INSET,
          right: TOOL_INSET,
          top: ghostIdx * TOOL_BTN + TOOL_INSET,
          height: TOOL_BTN - TOOL_INSET * 2,
          background: "rgba(255, 255, 255, 0.08)",
          borderRadius: 4,
          opacity: hoverIdx !== null && hoverIdx !== activeIdx ? 1 : 0,
          transition: "top 0.12s ease, opacity 0.12s ease",
          pointerEvents: "none",
        }}
      />
      {items.map((it, i) => {
        const active = i === activeIdx;
        return (
          <button
            key={it.id}
            type="button"
            title={it.label}
            aria-label={it.label}
            aria-pressed={active}
            onClick={() => onSelect(it.id)}
            onMouseEnter={() => setHoverIdx(i)}
            style={{
              position: "relative",
              zIndex: 1,
              width: TOOL_BTN,
              height: TOOL_BTN,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "transparent",
              color: active ? COL_STROKE : hoverIdx === i ? "#e4e4e7" : "#a1a1aa",
              border: "none",
              cursor: "pointer",
              padding: 0,
              transition: "color 0.12s ease",
            }}
          >
            {it.icon}
          </button>
        );
      })}
    </div>
  );
}

// Standalone stateful icon toggle (used for Close loop). Low-opacity blue fill
// + blue stroke when active; a neutral wash on hover.
function IconToggle({
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
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: TOOL_BTN,
        height: TOOL_BTN,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: active
          ? COL_FILL
          : hover
            ? "rgba(255, 255, 255, 0.08)"
            : "transparent",
        color: active ? COL_STROKE : hover ? "#e4e4e7" : "#a1a1aa",
        border: `1px solid ${active ? COL_STROKE : "transparent"}`,
        borderRadius: 4,
        boxSizing: "border-box",
        cursor: "pointer",
        padding: 0,
        transition:
          "background 0.12s ease, color 0.12s ease, border-color 0.12s ease",
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

// Path Select — a solid (filled) arrow cursor: "move the whole object".
function FilledArrowIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M3 2l6 12 1.8-4.2L15 8 3 2z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="currentColor"
      />
    </svg>
  );
}

// Sub-path Select — a hollow (outline) arrow cursor: "direct-select / edit
// anchors", mirroring Illustrator's white Direct Selection arrow.
function OutlineArrowIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M3 2l6 12 1.8-4.2L15 8 3 2z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

function LoopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle
        cx="8"
        cy="8"
        r="5"
        stroke="currentColor"
        strokeWidth="1.6"
        fill="none"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M3 4h10M6.5 4V3h3v1M5 4l.7 9h4.6L11 4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
