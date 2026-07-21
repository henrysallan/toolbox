"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import type { SplineAnchor } from "@/engine/types";
import type { SplineParamValue } from "@/nodes/source/spline-draw";
import { aspectCorrectY, aspectUncorrectY } from "@/engine/aspect";
import { roundCornersPerAnchor } from "@/engine/spline-math";
import { buildPlanarShape, type PlanarShape } from "@/engine/spline-planar";
import { rectsEqual } from "../overlay-rect";
import { getShortcutScope } from "../shortcut-scope";
import {
  ANCHOR_HIT_R,
  ANCHOR_R,
  ANCHOR_SQUARE,
  COL_CORNER_WIDGET,
  COL_FILL,
  COL_HANDLE_FILL,
  COL_HANDLE_LINE,
  COL_HANDLE_STROKE,
  COL_INACTIVE,
  COL_PATH,
  COL_RUBBER,
  COL_SEG_HOVER,
  COL_GUIDE,
  COL_HOVER,
  COL_SEL_FILL,
  COL_SEL_STROKE,
  COL_STROKE,
  CORNER_WIDGET_HIT_R,
  CORNER_WIDGET_R,
  HANDLE_HIT_R,
  HANDLE_R,
  SEGMENT_HIT_W,
} from "./constants";
import type {
  BBoxHandle,
  DragState,
  FacePick,
  MenuState,
  SplineEditorEnv,
  ToolMode,
} from "./types";
import {
  alignHandles,
  bezierAt,
  evenHandles,
  subpathToPathD,
  subpathsOf,
} from "./geometry";
import { makeSplineOps } from "./ops";
import type { SnapGuide } from "./snapping";
import { dragMove, dragUp } from "./drag";
import { penBackgroundDown } from "./tools/pen";
import { beginPencilStroke } from "./tools/pencil";
import { beginBBoxDrag, beginPathMove } from "./tools/path";
import {
  beginMarquee,
  beginSegmentDrag,
  segmentParamAtClient,
  subpathAnchorSelection,
} from "./tools/subpath";
import { beginCornerRadiusDrag, cornerWidgets } from "./tools/corner";
import {
  beginShapeDrag,
  pickContainsClient,
  shapeFacePickAtClient,
  shapeSignatureAtClient,
} from "./tools/shape";
import { SplineContextMenu, ToolDock } from "./dock";

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
// Four tool modes:
//   - "pen"     — pen tool; background click creates an anchor on the active
//                 subpath (or starts a new subpath when the active one is
//                 closed); quick click on an existing anchor toggles corner ↔
//                 smooth (or closes the loop on the first anchor of an open
//                 path). A dotted rubber-band previews the next segment.
//   - "pencil"  — freehand draw; drag to sketch a stroke, and on release the
//                 sampled polyline is fit to a smooth chain of cubic béziers
//                 (Schneider, engine/spline-math.ts) committed as a NEW
//                 subpath (auto-closed if the stroke ends near its start). One
//                 onChange / one undo per stroke. Spec: 062526_spline-pencil-tool.md.
//   - "path"    — Path Select (filled arrow): click any subpath to select the
//                 whole path; drag (body or bounding-box handles) moves /
//                 scales all subpaths, baked into the geometry. No params.
//   - "subpath" — Sub-path Select (outline arrow / direct selection): click a
//                 subpath to make it active, then edit its anchors. Clicks
//                 select anchors; shift-click extends; click+drag on empty
//                 draws a marquee; drag a selected anchor moves the selection;
//                 grab a curve *segment* to bend it (minimum-norm
//                 least-squares solve). Delete removes selected anchors.
//   - "shape"   — Shape Builder (B): the subpaths' overlaps partition the
//                 canvas into faces (engine/spline-planar.ts). Hover
//                 highlights the face under the cursor; click extracts it as
//                 its own subpath; drag across faces merges them into one;
//                 Alt-click/-drag deletes the area. Destructive — involved
//                 subpaths are re-cut (polygonal, Spline Boolean fidelity);
//                 untouched ones pass through. One undo per gesture.
//                 Spec: 071926_spline-draw-authoring-upgrade.md M3.
//
// Handle gestures (drag to reshape, right-click to drop a handle) work in the
// pen + sub-path modes. Smooth anchors mirror their handles on drag; Alt-drag
// *breaks* the anchor (persistently) so the two handles move independently.
// Right-click an anchor for a context menu (delete / align / even handles);
// right-click a handle to drop just that handle.
//
// Snapping (spec 071926 M2, ./snapping.ts) — the modifier vocabulary:
//   - Pen clicks and anchor drags snap to OTHER anchors (ring guide) and to
//     canvas edges / center / thirds (hairline guides). Hold Cmd/Ctrl to
//     suppress snapping mid-gesture.
//   - Shift during a handle drag (or while pulling handles out of a new
//     anchor) locks the handle angle to 45° increments. Shift is free there;
//     its pen-mode insert-on-path meaning applies only to background clicks.
// Hover (backlog #150): anchors/handles highlight under the cursor; the pen
// shows a pointer cursor over anchors and rings the first anchor of an open
// path when a click would close the loop.
//
// Path surgery + alignment (spec 071926 M4): right-click an anchor for Cut
// path here (scissors — closed opens, open splits in two), Join endpoint,
// Reverse direction, and (with a multi-selection) Align X/Y + Distribute
// X/Y; right-click a segment for Insert point / Cut path at that spot. `J`
// joins: both endpoints of the open active subpath selected → close; one
// endpoint selected → concatenate with the nearest other open subpath's end
// (coincident endpoints weld into one anchor). A small chevron on the active
// subpath (sub-path mode) shows travel direction.
//
// M0 decomposition (specdocs/071926_spline-draw-authoring-upgrade.md): the
// per-tool pointer logic lives in ./tools/*, value writes in ./ops.ts, the
// drag-stream dispatch in ./drag.ts, chrome in ./dock.tsx, pure math in
// ./geometry.ts. This component owns state, the effects, coordinate
// conversion, and ALL rendering — the SVG paint-pass z-order below is
// load-bearing and stays centralized here.

interface Props {
  canvas: HTMLCanvasElement | null;
  value: SplineParamValue;
  onChange: (next: SplineParamValue) => void;
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
  // Segment under the cursor in select mode (index into the segment list),
  // and the live cursor position used for the add-mode rubber band.
  const [hoverSeg, setHoverSeg] = useState<number | null>(null);
  const [hoverPx, setHoverPx] = useState<{ x: number; y: number } | null>(null);
  // Hovered anchor / handle (backlog #150): drives the hover highlight rings
  // and the pen-mode cursor variants. Only tracked while no drag is active.
  const [hoverAnchor, setHoverAnchor] = useState<number | null>(null);
  const [hoverHandle, setHoverHandle] = useState<{
    index: number;
    side: "in" | "out";
  } | null>(null);
  // Active snap guides (spec 071926 M2) — written by the drag handlers /
  // pen-click placement, rendered as hairlines + rings, cleared on pointerup.
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]);
  // Shape Builder (spec 071926 M3): the planar-face geometry cache the tools
  // read at event time (synced from the memo by an effect below), and the
  // face currently under the cursor.
  const planarShapeRef = useRef<PlanarShape | null>(null);
  const [hoverFace, setHoverFace] = useState<FacePick | null>(null);
  // Right-click context menu anchored at a client position for one anchor.
  const [menu, setMenu] = useState<MenuState | null>(null);
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

  // Pencil (freehand) capture. Raw client-px samples accumulate in the ref
  // (mutated in place to avoid an array allocation per pointermove); the
  // version counter bumps each move so the live preview path re-renders. Both
  // reset at stroke start, consumed at stroke end. Nothing touches `value` /
  // onChange until release, so the stroke is one undo entry.
  const pencilPtsRef = useRef<Array<[number, number]>>([]);
  const [pencilVersion, setPencilVersion] = useState(0);

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

  // The shared context for ops/tools/drag — rebuilt every render so `rect` /
  // `tool` snapshots carry the same stale-closure semantics the monolith had
  // (a drag effect captures the render its gesture began in; live data flows
  // through refs). See types.ts.
  const env: SplineEditorEnv = {
    valueRef,
    onChangeRef,
    activeSubpathRef,
    selectedRef,
    lastAnchorRef,
    penSealedRef,
    pencilPtsRef,
    planarShapeRef,
    rect,
    tool,
    setSelected,
    setActiveSubpath,
    setPenSealed,
    setDrag,
    setPencilVersion,
    setHoverSeg,
    setMenu,
    setSnapGuides,
    clientToNorm,
    normToPx,
  };
  const ops = makeSplineOps(env);
  // The once-bound keyboard effect reaches ops through this ref so it never
  // holds a stale closure (e.g. commitPencilStroke's rect).
  const opsRef = useRef(ops);
  opsRef.current = ops;

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
      else if (e.key === "n" || e.key === "N") setTool("pencil");
      else if (e.key === "v" || e.key === "V") setTool("path");
      else if (e.key === "a" || e.key === "A") setTool("subpath");
      else if (e.key === "b" || e.key === "B") setTool("shape");
      else if (e.key === "j" || e.key === "J") {
        // Join endpoints (spec 071926 M4): close the active open subpath
        // when both its endpoints are selected, else concatenate the single
        // selected endpoint with the nearest other open subpath's end.
        if (getShortcutScope() !== "spline") return;
        opsRef.current.joinPath();
      } else if (e.key === "Escape") {
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
        const anchorsNow = opsRef.current.readAnchors(valueRef.current);
        const sel = selectedRef.current;
        if (sel.size > 0) {
          if (anchorsNow.length === 0) return;
          e.preventDefault();
          opsRef.current.deleteAnchorIndices(sel);
          setSelected(new Set());
        } else if (
          toolRef.current !== "pen" &&
          subpathsOf(valueRef.current).length > 1
        ) {
          // No anchor selection in Path / Sub-path mode → delete the whole
          // active subpath (the implicitly-selected one).
          e.preventDefault();
          opsRef.current.deleteActiveSubpath();
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
          opsRef.current.deleteAnchor(idx);
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

  // Keep `activeSubpath` in range when the value shrinks underneath us — undo /
  // redo (and node switches) replace `value` without touching this component
  // state, so a stale index can point past the end. Every write keys on
  // `activeSubpathRef` (withSubpathPatch, commitPencilStroke, addAnchorAt…), so
  // an out-of-range index silently no-ops every edit — e.g. drawing several
  // pencil strokes then undoing back to empty would leave the pen AND pencil
  // unable to add anything. Clamp to the last subpath whenever it overflows.
  useEffect(() => {
    const count = subpathsOf(value).length;
    if (count > 0 && activeSubpath > count - 1) {
      setActiveSubpath(count - 1);
      setSelected(new Set());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, activeSubpath]);

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
    // Idempotent updates — avoids a ResizeObserver feedback loop (overlay-rect.ts).
    const update = () => {
      const r = canvas.getBoundingClientRect();
      setRect((prev) => (rectsEqual(prev, r) ? prev : r));
      const hr = (host ?? canvas).getBoundingClientRect();
      setHostRect((prev) => (rectsEqual(prev, hr) ? prev : hr));
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

  // While a drag is active, bind window pointer listeners and forward the
  // stream to drag.ts. The `ops`/`env` captured here are from the render in
  // which the gesture began — same semantics as the monolith's inline switch
  // (all live data flows through refs).
  useEffect(() => {
    if (!drag || !rect) return;
    const onMove = (e: PointerEvent) => dragMove(ops, env, drag, e);
    const onUp = (e: PointerEvent) => dragUp(ops, env, drag, e);
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

  // --- pointer-down entry points (thin wrappers over tools/*) --------------

  const onBackgroundPointerDown = (e: React.PointerEvent<SVGRectElement>) => {
    if (!rect) return;
    if (e.button !== 0) return; // left only; right-click adds nothing
    setMenu(null);
    e.preventDefault();
    e.stopPropagation();
    if (tool === "pencil") {
      beginPencilStroke(env, e);
      return;
    }
    if (tool === "subpath") {
      beginMarquee(env, e);
      return;
    }
    if (tool === "path") {
      // Path Select: background click clears the anchor selection. Move /
      // scale of the whole path happen via its body + bounding-box handles.
      setSelected(new Set());
      return;
    }
    if (tool === "shape") {
      beginShapeDrag(env, e);
      return;
    }
    penBackgroundDown(ops, env, e);
  };

  const onAnchorPointerDown =
    (index: number) => (e: React.PointerEvent<SVGCircleElement>) => {
      if (!rect) return;
      if (e.button !== 0) return;
      setMenu(null);
      e.preventDefault();
      e.stopPropagation();
      const [nx, ny] = clientToNorm(e.clientX, e.clientY);
      const a = ops.readAnchors(valueRef.current)[index];
      if (!a) return;
      lastAnchorRef.current = index;
      // Select-mode click resolves the selection up-front so a drag of
      // a freshly-clicked anchor moves the right group. Shift extends.
      // In add mode the selection state isn't surfaced, so leave it
      // alone — the click-no-drag path triggers corner↔smooth toggling.
      let groupStarts: Map<number, [number, number]> | undefined;
      if (tool === "subpath") {
        groupStarts = subpathAnchorSelection(ops, env, index, e);
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
      const a = ops.readAnchors(valueRef.current)[index];
      const wasBroken = !!a?.broken;
      lastAnchorRef.current = index;
      // Alt held on pointerdown *breaks* the anchor persistently — the two
      // handles become independent and stay that way for future drags too
      // (fixing the old bug where a later plain drag re-mirrored them). A
      // smooth (un-broken) anchor mirrors its partner; a broken one moves
      // each handle alone.
      if (e.altKey && !wasBroken) ops.updateAnchor(index, { broken: true });
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
      beginSegmentDrag(ops, env, seg, e);
    };

  // Live Corners widget grab (sub-path mode) — drags cornerRadius along the
  // corner's interior bisector (tools/corner.ts).
  const onCornerWidgetDown =
    (index: number) => (e: React.PointerEvent<SVGCircleElement>) => {
      if (!rect) return;
      if (e.button !== 0) return;
      setMenu(null);
      e.preventDefault();
      e.stopPropagation();
      beginCornerRadiusDrag(ops, env, index, e);
    };

  // Sub-path mode: click an (inactive) subpath's outline to make it active.
  const onSubpathSelectDown =
    (index: number) => (e: React.PointerEvent<SVGPathElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      ops.selectSubpath(index);
    };

  // Path mode: click any subpath to select the whole path (make that subpath
  // active) and begin a whole-path move.
  const onPathGrabDown =
    (index: number) => (e: React.PointerEvent<SVGPathElement>) => {
      if (!rect) return;
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      beginPathMove(ops, env, index, e);
    };

  // Path mode: grab a bounding-box handle to scale the whole path.
  const onBBoxHandleDown =
    (handle: BBoxHandle) => (e: React.PointerEvent<SVGRectElement>) => {
      if (!rect || !pathBBox) return;
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      beginBBoxDrag(env, handle, pathBBox, e);
    };

  const onAnchorContextMenu =
    (index: number) => (e: React.MouseEvent<SVGCircleElement>) => {
      e.preventDefault();
      e.stopPropagation();
      // Surface which anchor the menu targets. Keep an existing
      // multi-selection if the clicked anchor is part of it.
      if (!selectedRef.current.has(index)) setSelected(new Set([index]));
      lastAnchorRef.current = index;
      setMenu({ kind: "anchor", x: e.clientX, y: e.clientY, index });
    };

  // Segment right-click (sub-path mode): insert / cut at the clicked point.
  const onSegmentContextMenu =
    (seg: { seg: number; i: number; j: number }) =>
    (e: React.MouseEvent<SVGPathElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const t = segmentParamAtClient(ops, env, seg, e.clientX, e.clientY);
      if (t === null) return;
      setMenu({
        kind: "segment",
        x: e.clientX,
        y: e.clientY,
        i: seg.i,
        j: seg.j,
        t,
      });
    };

  const onHandleContextMenu =
    (index: number, side: "in" | "out") =>
    (e: React.MouseEvent<SVGCircleElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const a = ops.readAnchors(valueRef.current)[index];
      if (!a) return;
      // Rebuild as a fresh object so the updater sees the delete as a change.
      const cleaned: SplineAnchor = { pos: a.pos };
      if (side === "in" && a.outHandle) cleaned.outHandle = a.outHandle;
      if (side === "out" && a.inHandle) cleaned.inHandle = a.inHandle;
      if (a.broken) cleaned.broken = a.broken;
      ops.updateAnchor(index, cleaned);
    };

  // --- rendering -----------------------------------------------------------

  // Live Corners: curve previews render the EFFECTIVE rounded geometry (the
  // same per-anchor fillet the node applies at emit — roundCornersPerAnchor),
  // while anchors, segment hit paths, and all editing math stay on the
  // logical sharp anchors. Identity (same array) when no radius is set.
  const effSubpaths = useMemo(
    () => roundCornersPerAnchor(subpathsOf(value)),
    [value]
  );

  // Shape Builder planar geometry — built from the EFFECTIVE subpaths (the
  // same resolution applyShapeBuilderOp uses) whenever the tool is active.
  const planarShape = useMemo(
    () => (tool === "shape" ? buildPlanarShape(effSubpaths) : null),
    [tool, effSubpaths]
  );
  // Sync into the ref the tools read at event time (an effect, not a render
  // write — pointer events can't fire between commit and effects).
  useEffect(() => {
    planarShapeRef.current = planarShape;
  }, [planarShape]);

  // Hover face tracking (shape tool). Per move: containment against the
  // current pick is one point-in-polygon test; on a face change, a cheap
  // signature probe consults the cache (keyed sig:component — one signature
  // can name several disconnected components) before paying for a boolean
  // composition. Compositions run once per face visited per geometry.
  useEffect(() => {
    // No synchronous clear here (react-hooks/set-state-in-effect): leaving
    // shape mode / a geometry change clears via the PREVIOUS run's cleanup.
    if (tool !== "shape" || !rect || !planarShape) return;
    const cache = new Map<string, FacePick>();
    let last: FacePick | null = null;
    const onMove = (e: PointerEvent) => {
      if (last && pickContainsClient(env, last, e.clientX, e.clientY)) return;
      const sig = shapeSignatureAtClient(env, e.clientX, e.clientY);
      if (!sig) {
        if (last) {
          last = null;
          setHoverFace(null);
        }
        return;
      }
      let pick: FacePick | null = null;
      for (const [key, cached] of cache) {
        if (
          key.startsWith(`${sig}:`) &&
          pickContainsClient(env, cached, e.clientX, e.clientY)
        ) {
          pick = cached;
          break;
        }
      }
      if (!pick) {
        pick = shapeFacePickAtClient(env, e.clientX, e.clientY);
        if (pick) cache.set(`${sig}:${pick.component}`, pick);
      }
      last = pick;
      setHoverFace(pick);
    };
    window.addEventListener("pointermove", onMove);
    return () => {
      window.removeEventListener("pointermove", onMove);
      setHoverFace(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, rect, planarShape]);

  // Live Corners widgets — Sub-path Select mode only. All eligible corners
  // of the active subpath, narrowed to the selection when one exists.
  const cornerWidgetList = useMemo(() => {
    if (tool !== "subpath" || !rect) return [];
    const sub = subpathsOf(value)[activeSubpath];
    return cornerWidgets(
      { rect, normToPx },
      sub?.anchors ?? [],
      sub?.closed ?? false,
      selected
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, rect, value, activeSubpath, selected]);

  const pathD = useMemo(() => {
    if (!rect) return "";
    const sub = effSubpaths[activeSubpathRef.current];
    return subpathToPathD(sub?.anchors ?? [], sub?.closed ?? false, normToPx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rect, effSubpaths, activeSubpath]);

  // Muted outlines for every subpath except the active one — so a compound /
  // multi-path shape (e.g. a converted multi-path SVG) shows all its pieces
  // while you edit one at a time.
  const inactivePathsD = useMemo(() => {
    if (!rect) return [] as { index: number; d: string }[];
    const subs = effSubpaths;
    const out: { index: number; d: string }[] = [];
    for (let s = 0; s < subs.length; s++) {
      if (s === activeSubpathRef.current) continue;
      const d = subpathToPathD(subs[s]?.anchors ?? [], subs[s]?.closed ?? false, normToPx);
      if (d) out.push({ index: s, d });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rect, effSubpaths, activeSubpath]);

  // Every subpath's outline (incl. active) — drives Path Select hit-testing
  // (click any subpath to grab the whole path).
  const allSubpathsD = useMemo(() => {
    if (!rect) return [] as { index: number; d: string }[];
    const subs = effSubpaths;
    const out: { index: number; d: string }[] = [];
    for (let s = 0; s < subs.length; s++) {
      const d = subpathToPathD(subs[s]?.anchors ?? [], subs[s]?.closed ?? false, normToPx);
      if (d) out.push({ index: s, d });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rect, effSubpaths]);

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

  // Live freehand preview: a polyline through the raw captured samples (client
  // px) while a pencil stroke is in progress. Re-derived each sample via the
  // version counter; replaced by the fitted curve on release.
  const pencilD = useMemo(() => {
    if (drag?.kind !== "pencil") return "";
    const pts = pencilPtsRef.current;
    if (pts.length < 2) return "";
    let d = `M ${pts[0][0]} ${pts[0][1]}`;
    for (let i = 1; i < pts.length; i++) d += ` L ${pts[i][0]} ${pts[i][1]}`;
    return d;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, pencilVersion]);

  // Insert-on-path preview: while shift is held in add mode, snap a ghost
  // point to the nearest spot on the spline so the user sees where a click
  // would split the curve.
  const insertPreview = useMemo(() => {
    if (tool !== "pen" || !shiftHeld || drag || !hoverPx || !rect) return null;
    return ops.findInsertOnSpline(hoverPx.x, hoverPx.y);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, shiftHeld, drag, hoverPx, value, rect, activeSubpath]);

  if (!rect) return null;

  // Path Select and Shape Builder hide the per-anchor editing UI (anchors /
  // handles / segment hit paths) — Path shows outlines + bounding box, Shape
  // shows outlines + face highlights. Pen and Sub-path modes render the
  // active subpath's anchors for editing.
  const anchors =
    tool === "path" || tool === "shape"
      ? []
      : subpathsOf(value)[activeSubpathRef.current]?.anchors ?? [];
  const activeSeg =
    drag?.kind === "segment" ? drag.seg : hoverSeg !== null ? hoverSeg : null;
  const activeSegD =
    activeSeg !== null ? segments.find((s) => s.seg === activeSeg)?.d : undefined;

  // Context-menu item list, built per target (anchor vs segment, selection
  // size, endpoint-ness, corner radii). All plain state reads — refs are
  // render-forbidden; the onClick closures may use ops freely.
  const menuItems: Array<{ label: string; onClick: () => void }> = [];
  if (menu) {
    const closeMenu = () => setMenu(null);
    if (menu.kind === "anchor") {
      const idx = menu.index;
      // Mirrors ops.targetsFor via state.
      const menuTargets =
        selected.has(idx) && selected.size > 1 ? [...selected] : [idx];
      const menuSub = subpathsOf(value)[activeSubpath];
      const menuAnchors = menuSub?.anchors ?? [];
      const nA = menuAnchors.length;
      const menuClosed = menuSub?.closed ?? false;
      menuItems.push({
        label: "Delete point",
        onClick: () => {
          ops.deleteAnchorIndices(new Set(ops.targetsFor(idx)));
          setSelected(new Set());
          closeMenu();
        },
      });
      menuItems.push({
        label: "Align handles",
        onClick: () => {
          ops.applyHandleOp(idx, alignHandles);
          closeMenu();
        },
      });
      menuItems.push({
        label: "Even handles",
        onClick: () => {
          ops.applyHandleOp(idx, evenHandles);
          closeMenu();
        },
      });
      if (menuTargets.some((i) => (menuAnchors[i]?.cornerRadius ?? 0) > 0)) {
        menuItems.push({
          label: "Reset corner",
          onClick: () => {
            const patch = new Map<number, Partial<SplineAnchor>>();
            for (const i of menuTargets) patch.set(i, { cornerRadius: undefined });
            ops.patchAnchors(patch);
            closeMenu();
          },
        });
      }
      const canCut = menuClosed ? nA >= 3 : idx > 0 && idx < nA - 1 && nA >= 3;
      if (canCut) {
        menuItems.push({
          label: "Cut path here",
          onClick: () => {
            ops.cutAtAnchor(idx);
            closeMenu();
          },
        });
      }
      if (!menuClosed && nA >= 2 && (idx === 0 || idx === nA - 1)) {
        menuItems.push({
          label: "Join endpoint (J)",
          onClick: () => {
            ops.joinPath(idx);
            closeMenu();
          },
        });
      }
      menuItems.push({
        label: "Reverse direction",
        onClick: () => {
          ops.reverseActiveSubpath();
          closeMenu();
        },
      });
      if (selected.size >= 2) {
        menuItems.push({
          label: "Align X",
          onClick: () => {
            ops.alignSelected(0);
            closeMenu();
          },
        });
        menuItems.push({
          label: "Align Y",
          onClick: () => {
            ops.alignSelected(1);
            closeMenu();
          },
        });
      }
      if (selected.size >= 3) {
        menuItems.push({
          label: "Distribute X",
          onClick: () => {
            ops.distributeSelected(0);
            closeMenu();
          },
        });
        menuItems.push({
          label: "Distribute Y",
          onClick: () => {
            ops.distributeSelected(1);
            closeMenu();
          },
        });
      }
    } else {
      menuItems.push({
        label: "Insert point here",
        onClick: () => {
          ops.insertAnchorOnSegment(menu.i, menu.j, menu.t);
          closeMenu();
        },
      });
      menuItems.push({
        label: "Cut path here",
        onClick: () => {
          ops.cutAtSegmentPoint(menu.i, menu.j, menu.t);
          closeMenu();
        },
      });
    }
  }

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
            cursor:
              tool === "pen" || tool === "pencil" || tool === "shape"
                ? "crosshair"
                : "default",
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
              onContextMenu={onSegmentContextMenu(s)}
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

        {/* Shape Builder face highlights: the hovered face, or every face the
            current gesture has collected. Cyan = merge/extract; red = delete
            (Alt held at press). evenodd so holes render as holes. */}
        {tool === "shape" &&
          (drag?.kind === "shape"
            ? drag.faces
            : hoverFace
              ? [hoverFace]
              : []
          ).map((f, i) => (
            <path
              key={`face-${f.ref.sig}-${f.component}-${i}`}
              d={f.d}
              fill={
                drag?.kind === "shape" && drag.alt
                  ? "rgba(248, 113, 113, 0.3)"
                  : "rgba(34, 211, 238, 0.25)"
              }
              stroke={
                drag?.kind === "shape" && drag.alt ? "#f87171" : COL_PATH
              }
              strokeWidth={1}
              fillRule="evenodd"
              style={{ pointerEvents: "none" }}
            />
          ))}

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
                onPointerEnter={() => {
                  if (!drag) setHoverHandle({ index: i, side: "in" });
                }}
                onPointerLeave={() => {
                  if (!drag)
                    setHoverHandle((cur) =>
                      cur?.index === i && cur.side === "in" ? null : cur
                    );
                }}
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
                onPointerEnter={() => {
                  if (!drag) setHoverHandle({ index: i, side: "out" });
                }}
                onPointerLeave={() => {
                  if (!drag)
                    setHoverHandle((cur) =>
                      cur?.index === i && cur.side === "out" ? null : cur
                    );
                }}
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
              // Pen over an anchor = a click action (toggle corner↔smooth,
              // or close the loop on the first anchor) → pointer cursor;
              // select modes drag → grab.
              style={{
                cursor: tool === "pen" ? "pointer" : "grab",
                pointerEvents: "auto",
              }}
              onPointerDown={onAnchorPointerDown(i)}
              onContextMenu={onAnchorContextMenu(i)}
              onPointerEnter={() => {
                if (!drag) setHoverAnchor(i);
              }}
              onPointerLeave={() => {
                if (!drag) setHoverAnchor((cur) => (cur === i ? null : cur));
              }}
            />
          );
        })}

        {/* Pass 3 — anchor visual marks. Corner anchors (no handles) draw
            as squares; smooth/handled anchors as circles. Blue outline with
            a faint fill; selected anchors switch to amber. */}
        {anchors.map((a, i) => {
          const p = normToPx(a.pos);
          const isSel = selected.has(i);
          // Hover ring (backlog #150): lighter blue + the selected-size bump,
          // only when not already selected (amber wins).
          const isHov = !isSel && hoverAnchor === i;
          const hasHandles = !!a.inHandle || !!a.outHandle;
          const stroke = isSel ? COL_SEL_STROKE : isHov ? COL_HOVER : COL_STROKE;
          const fill = isSel ? COL_SEL_FILL : COL_FILL;
          if (hasHandles) {
            return (
              <circle
                key={`av-${i}`}
                cx={p.x}
                cy={p.y}
                r={isSel || isHov ? ANCHOR_R + 1 : ANCHOR_R}
                fill={fill}
                stroke={stroke}
                strokeWidth={1.4}
                style={{ pointerEvents: "none" }}
              />
            );
          }
          const half = (isSel || isHov ? ANCHOR_SQUARE + 2 : ANCHOR_SQUARE) / 2;
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
            const hov = hoverHandle?.index === i && hoverHandle.side === "in";
            dots.push(
              <circle
                key={`hv-${i}-in`}
                cx={p.x}
                cy={p.y}
                r={hov ? HANDLE_R + 1 : HANDLE_R}
                fill={COL_HANDLE_FILL}
                stroke={hov ? COL_HOVER : COL_HANDLE_STROKE}
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
            const hov = hoverHandle?.index === i && hoverHandle.side === "out";
            dots.push(
              <circle
                key={`hv-${i}-out`}
                cx={p.x}
                cy={p.y}
                r={hov ? HANDLE_R + 1 : HANDLE_R}
                fill={COL_HANDLE_FILL}
                stroke={hov ? COL_HOVER : COL_HANDLE_STROKE}
                strokeWidth={1}
                style={{ pointerEvents: "none" }}
              />
            );
          }
          return dots;
        })}

        {/* Direction chevron (sub-path mode): a subtle arrowhead at the
            midpoint of the active subpath's first segment, pointing along
            travel — pairs with "Reverse direction" (spec 071926 M4). */}
        {tool === "subpath" &&
          anchors.length >= 2 &&
          (() => {
            const A = anchors[0];
            const B2 = anchors[1];
            const q0 = normToPx(A.pos);
            const q1 = A.outHandle
              ? normToPx([A.pos[0] + A.outHandle[0], A.pos[1] + A.outHandle[1]])
              : q0;
            const q3 = normToPx(B2.pos);
            const q2 = B2.inHandle
              ? normToPx([B2.pos[0] + B2.inHandle[0], B2.pos[1] + B2.inHandle[1]])
              : q3;
            const c0: [number, number] = [q0.x, q0.y];
            const c1: [number, number] = [q1.x, q1.y];
            const c2: [number, number] = [q2.x, q2.y];
            const c3: [number, number] = [q3.x, q3.y];
            const mid = bezierAt(c0, c1, c2, c3, 0.5);
            const ahead = bezierAt(c0, c1, c2, c3, 0.56);
            const dx = ahead[0] - mid[0];
            const dy = ahead[1] - mid[1];
            const len = Math.hypot(dx, dy);
            if (len < 1e-3) return null;
            const ux = dx / len;
            const uy = dy / len;
            const nx2 = -uy;
            const ny2 = ux;
            const S = 4.5;
            const tipX = mid[0] + ux * S;
            const tipY = mid[1] + uy * S;
            const bLx = tipX - ux * S * 1.6 + nx2 * S;
            const bLy = tipY - uy * S * 1.6 + ny2 * S;
            const bRx = tipX - ux * S * 1.6 - nx2 * S;
            const bRy = tipY - uy * S * 1.6 - ny2 * S;
            return (
              <path
                d={`M ${bLx} ${bLy} L ${tipX} ${tipY} L ${bRx} ${bRy}`}
                stroke={COL_PATH}
                strokeWidth={1.3}
                fill="none"
                opacity={0.7}
                strokeLinecap="round"
                style={{ pointerEvents: "none" }}
              />
            );
          })()}

        {/* Pen-mode close-loop affordance: hovering the FIRST anchor of an
            open path (≥3 anchors) shows a ring — "click here to close". */}
        {tool === "pen" &&
          hoverAnchor === 0 &&
          anchors.length >= 3 &&
          !(subpathsOf(value)[activeSubpath]?.closed ?? false) &&
          (() => {
            const p = normToPx(anchors[0].pos);
            return (
              <circle
                cx={p.x}
                cy={p.y}
                r={ANCHOR_HIT_R - 2}
                fill="none"
                stroke={COL_PATH}
                strokeWidth={1.3}
                opacity={0.9}
                style={{ pointerEvents: "none" }}
              />
            );
          })()}

        {/* Snap guides (spec 071926 M2): canvas guide hairlines + a ring on
            the snapped-to anchor. Rendered above the editing chrome, below
            the marquee. */}
        {snapGuides.map((g, gi) =>
          g.kind === "vline" ? (
            <line
              key={`sg-${gi}`}
              x1={g.x}
              y1={rect.top}
              x2={g.x}
              y2={rect.bottom}
              stroke={COL_GUIDE}
              strokeWidth={1}
              opacity={0.9}
              style={{ pointerEvents: "none" }}
            />
          ) : g.kind === "hline" ? (
            <line
              key={`sg-${gi}`}
              x1={rect.left}
              y1={g.y}
              x2={rect.right}
              y2={g.y}
              stroke={COL_GUIDE}
              strokeWidth={1}
              opacity={0.9}
              style={{ pointerEvents: "none" }}
            />
          ) : (
            <circle
              key={`sg-${gi}`}
              cx={g.x}
              cy={g.y}
              r={7}
              fill="none"
              stroke={COL_GUIDE}
              strokeWidth={1.3}
              style={{ pointerEvents: "none" }}
            />
          )
        )}

        {/* Live Corners widgets (sub-path mode) — a small dot along each
            eligible corner's interior bisector; drag toward the interior to
            round. Rendered after the anchor/handle passes so the hit ring
            wins the overlap zone next to the anchor. */}
        {cornerWidgetList.map((w) => (
          <g key={`cw-${w.index}`}>
            <circle
              cx={w.x}
              cy={w.y}
              r={CORNER_WIDGET_R}
              fill="rgba(240, 171, 252, 0.25)"
              stroke={COL_CORNER_WIDGET}
              strokeWidth={1.4}
              style={{ pointerEvents: "none" }}
            />
            <circle
              cx={w.x}
              cy={w.y}
              r={CORNER_WIDGET_HIT_R}
              fill="transparent"
              style={{ cursor: "grab", pointerEvents: "auto" }}
              onPointerDown={onCornerWidgetDown(w.index)}
              onContextMenu={(e) => e.preventDefault()}
            />
          </g>
        ))}

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

        {/* Live freehand stroke preview (pencil mode, mid-drag). Replaced by
            the fitted bézier curve on release. */}
        {pencilD && (
          <path
            d={pencilD}
            fill="none"
            stroke={COL_PATH}
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.85}
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

      <ToolDock
        left={(hostRect ?? rect).left + 8}
        top={(hostRect ?? rect).top + 8}
        tool={tool}
        onSelectTool={setTool}
        closed={subpathsOf(value)[activeSubpath]?.closed ?? false}
        onToggleClosed={ops.toggleClosed}
        showDeleteSubpath={subpathsOf(value).length > 1}
        onDeleteSubpath={ops.deleteActiveSubpath}
      />

      {/* Context menu (anchor or segment target). */}
      {menu && menuItems.length > 0 && (
        <SplineContextMenu x={menu.x} y={menu.y} items={menuItems} />
      )}
    </div>
  );
}
