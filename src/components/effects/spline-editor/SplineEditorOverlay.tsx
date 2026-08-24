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
  clearPublishedAnchorSelection,
  getAnchorSelectionRequest,
  publishAnchorSelection,
  subscribeAnchorSelectionRequest,
} from "../spline-anchor-scope";
import {
  ANCHOR_HIT_R,
  ANCHOR_R,
  ANCHOR_SQUARE,
  COL_CORNER_WIDGET,
  COL_FILL,
  COL_GHOST,
  COL_HANDLE_FILL,
  COL_HANDLE_LINE,
  COL_HANDLE_STROKE,
  COL_INACTIVE,
  COL_PATH,
  COL_RUBBER,
  COL_SEG_HOVER,
  COL_GUIDE,
  COL_HOVER,
  COL_ONION_NEXT,
  COL_ONION_PREV,
  COL_SEL_FILL,
  COL_SEL_STROKE,
  COL_MEASURE,
  COL_STROKE,
  COL_TUNNI,
  COL_USER_GUIDE,
  COL_WIDTH_WIDGET,
  GUIDE_DOT_HIT_R,
  GUIDE_DOT_R,
  MEASURE_TICK,
  TUNNI_HIT_R,
  TUNNI_R,
  CORNER_WIDGET_HIT_R,
  CORNER_WIDGET_R,
  WIDTH_WIDGET_HIT_R,
  WIDTH_WIDGET_R,
  HANDLE_HIT_R,
  HANDLE_R,
  SEGMENT_HIT_W,
} from "./constants";
import {
  isPrimitiveTool,
  type BBoxHandle,
  type DragState,
  type FacePick,
  type HudState,
  type MeasureLine,
  type MenuState,
  type SplineGuide,
  type ModalTransform,
  type SplineEditorEnv,
  type ToolMode,
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
import { beginPrimitiveDraw } from "./tools/primitive";
import {
  applyModalTransform,
  beginExtrude,
  beginModalTransform,
  cancelModalTransform,
  MODAL_HUD_SEED,
} from "./tools/transform";
import { beginBBoxDrag, beginPathMove } from "./tools/path";
import {
  beginMarquee,
  beginSegmentDrag,
  beginSegmentSelect,
  segmentParamAtClient,
  subpathAnchorSelection,
} from "./tools/subpath";
import {
  beginCornerRadiusDrag,
  cornerWidgets,
  cycleCornerStyle,
} from "./tools/corner";
import { beginWidthDrag, widthWidgets } from "./tools/width";
import {
  beginTunniDrag,
  tunniBalance,
  tunniForSegment,
  type TunniPoint,
} from "./tools/tunni";
import { beginMeasureDrag, measureCrossings } from "./tools/measure";
import {
  beginShapeDrag,
  pickContainsClient,
  shapeFacePickAtClient,
  shapeSignatureAtClient,
} from "./tools/shape";
import { SplineContextMenu, ToolDock } from "./dock";
import { claimPointerGesture } from "@/lib/pointer-claim";

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
// Tool modes:
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
//   - "rect" /  — primitive stamping (M / L): drag a rubber-band box; release
//     "ellipse"   commits it as one closed subpath (4 corner anchors / 4
//                 kappa-handled quadrant anchors). Shift = 1:1 (square /
//                 circle, screen-space), Alt = the press point is the CENTRE,
//                 Alt+Shift = both. Ordinary editable geometry afterwards.
//                 tools/primitive.ts; spec 071926 M6, backlog #55.
//   - "path"    — Path Select (filled arrow): click any subpath to select the
//                 whole path; drag (body or bounding-box handles) moves /
//                 scales all subpaths, baked into the geometry. No params.
//   - "subpath" — Sub-path Select (outline arrow / direct selection): click a
//                 subpath to make it active, then edit its anchors. Clicks
//                 select anchors; shift-click extends; click+drag on empty
//                 draws a marquee; drag a selected anchor moves the selection.
//                 On a *segment*: click selects its two adjacent anchors (and
//                 dragging moves them together, so the segment translates
//                 rigidly), double-click selects the whole subpath, and
//                 ALT+drag bends the curve (minimum-norm least-squares solve
//                 on the two interior controls). Delete removes selected
//                 anchors.
//   - "width"   — Width tool (W): every anchor of the active subpath shows
//                 a widget pair perpendicular to the path; drag either side
//                 to set that anchor's stroke-width MULTIPLIER
//                 (anchor.width, absent = 1 — symbolic 16px-per-× widget
//                 scale; the node raster previews the true envelope). HUD
//                 shows ×; right-click a widget → Reset width. Consumed by
//                 the Stroke node + the bundled rasterizer via
//                 engine/spline-width.ts. Spec: 072726 M3.
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
// pen + sub-path modes. Smooth anchors keep their handles collinear on drag
// (the partner rotates but keeps its own length — see drag.ts); Alt-drag
// *breaks* the anchor (persistently) so the two handles move independently.
// Right-click an anchor for a context menu (delete / align / even handles);
// right-click a handle to drop just that handle.
//
// Snapping (spec 071926 M2, ./snapping.ts) — the modifier vocabulary:
//   - Pen clicks, anchor drags and primitive draws snap to OTHER anchors —
//     landing right on one (ring guide) or LINING UP with one on either axis
//     (dashed alignment guide spanning the participants, ticked at each) —
//     and to canvas edges / center / thirds (solid hairline guides). Hold
//     Cmd/Ctrl to suppress snapping mid-gesture.
//   - Shift during a handle drag (or while pulling handles out of a new
//     anchor) locks the handle angle to 45° increments. Shift is free there;
//     its pen-mode insert-on-path meaning applies only to background clicks.
//     In the primitive tools Shift is the 1:1 lock, so it stands the free
//     corner's snapping down for the gesture.
// Hover (backlog #150): anchors/handles highlight under the cursor; the pen
// shows a pointer cursor over anchors and rings the first anchor of an open
// path when a click would close the loop.
//
// Blender-style modal transforms (tools/transform.ts): with the cursor over
// the canvas, G / S / R start a move / scale / rotate that follows the
// pointer with NO button held — left-click or Enter confirms, Escape or
// right-click reverts, X / Y constrain move + scale to one axis, Shift snaps
// a rotate to 45°. They act on the selected anchors, or the whole active
// subpath when nothing is selected (every subpath in Path Select), about the
// targets' median. E extrudes: a new anchor grows off the open active
// subpath's endpoint and rides the same modal move, so points can be added
// without leaving the sub-path tool (and E chains, since the new anchor
// stays selected). The cursor gate is why the modal keys can own G/S/R/E
// while the tool letters stay unconditional.
//
// Per-anchor keyframing (spec 072726 M6): right-click an anchor (or a
// multi-selection) → "Animate anchor(s)" mints stable ids and creates three
// vec2 tracks (anchor_p/in/out:<id>, engine/conventions.ts) seeded at the
// playhead; dragging an animated anchor/handle then autokeys just that
// anchor. Animated anchors wear a dashed amber ring. EITHER/OR with
// whole-shape Path Animation — the menu items hide while it's keyframed.
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
// M0 decomposition (specdocs/archive/071926_spline-draw-authoring-upgrade.md): the
// per-tool pointer logic lives in ./tools/*, value writes in ./ops.ts, the
// drag-stream dispatch in ./drag.ts, chrome in ./dock.tsx, pure math in
// ./geometry.ts. This component owns state, the effects, coordinate
// conversion, and ALL rendering — the SVG paint-pass z-order below is
// load-bearing and stays centralized here.

interface Props {
  canvas: HTMLCanvasElement | null;
  /** This Spline Draw node's id — its name on the anchor-selection
   *  channel shared with the Tracks editor (spline-anchor-scope.ts). */
  nodeId: string;
  value: SplineParamValue;
  onChange: (next: SplineParamValue) => void;
  // Onion skinning (spec 072726 M1): the stored keyframe shapes strictly
  // before/after the playhead when Path Animation is keyframed. Rendered as
  // dashed red/green ghosts; the dock toggle appears only when one exists.
  onionPrev?: SplineParamValue | null;
  onionNext?: SplineParamValue | null;
  // Multi-node ghosts (spec 072726 M5): every other Spline Draw node's
  // spline at the tick. Rendered as dim reference outlines, their anchors
  // join the snapping targets, and select-tool clicks switch the overlay to
  // that node via onSelectNode.
  others?: Array<{ nodeId: string; value: SplineParamValue }>;
  onSelectNode?: (nodeId: string) => void;
  // Per-anchor keyframing (spec 072726 M6): ids with animated tracks (badge
  // rendering + menu state), whether whole-shape Path Animation is on (the
  // either/or — anchor-animate items hide then), and the create/remove
  // callback (EffectsApp owns the animation-map mutation).
  animatedAnchorIds?: Set<string>;
  pathAnimated?: boolean;
  onAnchorAnimate?: (
    subpathIndex: number,
    anchorIndexes: number[],
    enable: boolean
  ) => void;
  // Guidelines (spec 080226 M5): the node's guides (from the hidden
  // `spline_guides` param — never the keyframed spline envelope) and the
  // write-through. Guides render as full-canvas lines with a grab dot,
  // join the snap service, and delete when dropped outside the canvas.
  guides?: SplineGuide[];
  onGuidesChange?: (next: SplineGuide[]) => void;
}

export default function SplineEditorOverlay({
  canvas,
  nodeId,
  value,
  onChange,
  onionPrev,
  onionNext,
  others,
  onSelectNode,
  animatedAnchorIds,
  pathAnimated,
  onAnchorAnimate,
  guides,
  onGuidesChange,
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
  // Numeric drag HUD — written by drag.ts per move, cleared on pointerup.
  const [hud, setHud] = useState<HudState | null>(null);
  // Measurement line (spec 080226 M4) — persists past pointerup; Escape or
  // a new measure drag clears. Rendering is gated on the measure tool.
  const [measure, setMeasure] = useState<MeasureLine | null>(null);
  // Blender-style modal transform (G / S / R, tools/transform.ts). Lives
  // outside DragState: it starts on a keypress and ends on a click.
  const [modal, setModal] = useState<ModalTransform | null>(null);
  // Onion-skin toggle (spec 072726 M1) — on by default; only surfaced in the
  // dock while a neighboring keyframe ghost actually exists.
  const [onionOn, setOnionOn] = useState(true);
  // Multi-node ghosts toggle (spec 072726 M5) — on by default; surfaced only
  // while another Spline Draw node exists.
  const [ghostsOn, setGhostsOn] = useState(true);
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

  // Multi-node ghosts (spec 072726 M5): other Spline Draw nodes' anchor
  // positions in px, joined into the snap targets while ghosts are shown.
  const ghostSnapPx = useMemo(() => {
    const out: Array<{ x: number; y: number }> = [];
    if (!rect || !ghostsOn || !others?.length) return out;
    for (const g of others) {
      for (const s of subpathsOf(g.value)) {
        for (const a of s.anchors) out.push(normToPx(a.pos));
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rect, ghostsOn, others]);

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
    ghostSnapPx,
    setSelected,
    setActiveSubpath,
    setPenSealed,
    setDrag,
    setPencilVersion,
    setHoverSeg,
    setMenu,
    setSnapGuides,
    setHud,
    setMeasure,
    guides: guides ?? [],
    onGuidesChange: onGuidesChange ?? (() => {}),
    clientToNorm,
    normToPx,
  };
  const ops = makeSplineOps(env);
  // The once-bound keyboard effect reaches ops (and the env behind it)
  // through these refs so it never holds a stale closure (e.g.
  // commitPencilStroke's rect, or the modal transform's live tool).
  const opsRef = useRef(ops);
  opsRef.current = ops;
  // Live snapshot for the once-bound keyboard effect and the modal
  // transform's listeners (env carries rect + tool). Written in an EFFECT
  // rather than during render — pointer/key events can't fire between commit
  // and effects, the same reasoning planarShapeRef uses below — and as ONE
  // object so the render stays free of ref writes.
  const liveRef = useRef({ env, drag, modal });
  useEffect(() => {
    liveRef.current = { env, drag, modal };
  });
  // Last pointer position, tracked without re-rendering — the G/S/R
  // shortcuts are gated on the cursor actually being over the canvas, and
  // the axis-lock keys re-apply the transform from here.
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      pointerRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  // End a modal transform: the value is already written (confirm) or has
  // been reverted by the caller (cancel).
  const endModal = () => {
    setModal(null);
    setHud(null);
  };

  // While a modal transform runs it owns the pointer and the keyboard:
  // capture-phase listeners so neither the overlay's own handlers nor the
  // tool-letter shortcuts see the confirming click / cancelling Escape.
  const modalOn = modal !== null;
  useEffect(() => {
    if (!modalOn) return;
    // Re-apply from the last known pointer position — for changes that carry
    // no pointer event of their own (the axis keys, and Shift's 45° rotate
    // lock going on or off).
    const reapply = (m: ModalTransform, shift: boolean) => {
      const p = pointerRef.current;
      if (!p) return;
      setHud({
        x: p.x,
        y: p.y,
        text: applyModalTransform(liveRef.current.env, m, p.x, p.y, shift),
      });
    };
    const onMove = (e: PointerEvent) => {
      const m = liveRef.current.modal;
      if (!m) return;
      const text = applyModalTransform(
        liveRef.current.env,
        m,
        e.clientX,
        e.clientY,
        e.shiftKey
      );
      setHud({ x: e.clientX, y: e.clientY, text });
    };
    const onDown = (e: PointerEvent) => {
      const m = liveRef.current.modal;
      if (!m) return;
      e.preventDefault();
      e.stopPropagation();
      // Left confirms (the value already reflects the last move); any other
      // button reverts, matching Blender's LMB/RMB grammar.
      if (e.button !== 0) cancelModalTransform(liveRef.current.env, m);
      endModal();
    };
    const onKey = (e: KeyboardEvent) => {
      const m = liveRef.current.modal;
      if (!m) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelModalTransform(liveRef.current.env, m);
        endModal();
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        endModal();
      } else if (
        m.mode !== "rotate" &&
        (e.key === "x" || e.key === "X" || e.key === "y" || e.key === "Y")
      ) {
        // Axis constraint, toggled like Blender's — press the same axis
        // again to release it. Re-apply immediately so the shape answers
        // without waiting for the next pointer move.
        e.preventDefault();
        e.stopPropagation();
        const want = e.key === "x" || e.key === "X" ? "x" : "y";
        const next: ModalTransform = {
          ...m,
          axis: m.axis === want ? null : want,
        };
        setModal(next);
        reapply(next, e.shiftKey);
      } else if (e.key === "Shift") {
        // Engage the 45° rotate lock without waiting for a pointer move.
        reapply(m, true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const m = liveRef.current.modal;
      if (m && e.key === "Shift") reapply(m, false);
    };
    const onContext = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("contextmenu", onContext, true);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("contextmenu", onContext, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalOn]);

  // While the spline editor is engaged, every primary-button press on the
  // canvas is a tool action (pen click, anchor drag, modal confirm, …) —
  // claim them all so none read as graph cursor gestures
  // (ctx.cursor.pressed / press counters). Window capture phase so it
  // also covers handlers that stopPropagation; claims for presses outside
  // the preview box are harmless no-ops (those were never counted).
  useEffect(() => {
    const onAnyDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      claimPointerGesture(e.pointerId);
    };
    window.addEventListener("pointerdown", onAnyDown, true);
    return () => window.removeEventListener("pointerdown", onAnyDown, true);
  }, []);

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
      // Blender-style modal transforms (G / S / R) and extrude (E), gated on
      // the cursor actually being over the preview canvas so they never fire
      // while the user is working in another panel. They own those letters —
      // hence Rectangle and Ellipse sit on M / L (Illustrator's keys).
      const k = e.key.toLowerCase();
      if (k === "g" || k === "s" || k === "r" || k === "e") {
        if (liveRef.current.modal || liveRef.current.drag) return;
        const r = liveRef.current.env.rect;
        const p = pointerRef.current;
        const inside =
          !!r &&
          !!p &&
          p.x >= r.left &&
          p.x <= r.right &&
          p.y >= r.top &&
          p.y <= r.bottom;
        if (!inside) return;
        const started =
          k === "e"
            ? beginExtrude(liveRef.current.env, p)
            : beginModalTransform(
                liveRef.current.env,
                k === "g" ? "move" : k === "s" ? "scale" : "rotate",
                p
              );
        if (!started) return;
        e.preventDefault();
        setModal(started);
        // Seed text only — arming must not write an identity transform, or
        // G-then-Escape would leave a no-op entry in the undo stack. (The
        // extrude's own anchor write already happened, and its cancel undoes
        // it.)
        setHud({ x: p.x, y: p.y, text: MODAL_HUD_SEED[started.mode] });
        return;
      }
      if (e.key === "p" || e.key === "P") setTool("pen");
      else if (e.key === "n" || e.key === "N") setTool("pencil");
      else if (e.key === "m" || e.key === "M") setTool("rect");
      else if (e.key === "l" || e.key === "L") setTool("ellipse");
      else if (e.key === "v" || e.key === "V") setTool("path");
      else if (e.key === "a" || e.key === "A") setTool("subpath");
      else if (e.key === "b" || e.key === "B") setTool("shape");
      else if (e.key === "w" || e.key === "W") setTool("width");
      else if (e.key === "i" || e.key === "I") setTool("measure");
      else if (e.key === "j" || e.key === "J") {
        // Join endpoints (spec 071926 M4): close the active open subpath
        // when both its endpoints are selected, else concatenate the single
        // selected endpoint with the nearest other open subpath's end.
        if (getShortcutScope() !== "spline") return;
        opsRef.current.joinPath();
      } else if (e.key === "Escape") {
        setSelected(new Set());
        setMenu(null);
        setMeasure(null);
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

  // ---- Anchor-selection link with the Tracks editor -----------------------
  // (spline-anchor-scope.ts). `selected` holds indices into the ACTIVE
  // subpath; the channel speaks stable anchor ids, so both directions
  // translate here.

  // canvas → tracks: publish the ids of whatever is selected, so the
  // Tracks editor can highlight the matching anchor lanes.
  useEffect(() => {
    const anchors = subpathsOf(value)[activeSubpath]?.anchors ?? [];
    const ids: string[] = [];
    for (const i of selected) {
      const id = anchors[i]?.id;
      if (id) ids.push(id);
    }
    publishAnchorSelection({ nodeId, anchorIds: ids });
  }, [selected, activeSubpath, value, nodeId]);

  // Drop the published selection when this overlay goes away, so stale
  // lane highlights don't outlive the node being active.
  useEffect(() => {
    return () => clearPublishedAnchorSelection(nodeId);
  }, [nodeId]);

  // tracks → canvas: apply a selection requested by clicking anchor
  // keyframes. Anchors are addressed by id and may live in a subpath
  // other than the active one, so this also SWITCHES the active subpath
  // — without that, an anchor outside it simply couldn't be selected.
  // (That does re-target the pen/pencil tools, which is the same thing
  // clicking the anchor on canvas would have done.)
  useEffect(() => {
    let lastVersion = getAnchorSelectionRequest()?.version ?? 0;
    const apply = () => {
      const req = getAnchorSelectionRequest();
      if (!req || req.version === lastVersion) return;
      lastVersion = req.version;
      if (req.nodeId !== nodeId || req.anchorIds.length === 0) return;
      const wanted = new Set(req.anchorIds);
      const subs = subpathsOf(valueRef.current);
      // Prefer a subpath already active; otherwise the first one holding
      // any requested anchor.
      const scoreOf = (si: number) =>
        (subs[si]?.anchors ?? []).reduce(
          (n, a) => n + (a.id && wanted.has(a.id) ? 1 : 0),
          0
        );
      let targetSub = -1;
      if (scoreOf(activeSubpathRef.current) > 0) {
        targetSub = activeSubpathRef.current;
      } else {
        for (let si = 0; si < subs.length; si++) {
          if (scoreOf(si) > 0) {
            targetSub = si;
            break;
          }
        }
      }
      if (targetSub < 0) return;
      const anchors = subs[targetSub]?.anchors ?? [];
      const next = new Set<number>();
      anchors.forEach((a, i) => {
        if (a.id && wanted.has(a.id)) next.add(i);
      });
      if (next.size === 0) return;
      if (targetSub !== activeSubpathRef.current) setActiveSubpath(targetSub);
      setSelected(next);
    };
    return subscribeAnchorSelectionRequest(apply);
  }, [nodeId]);

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
    if (tool === "width") {
      // Width mode: only the widgets are interactive; background is inert.
      return;
    }
    if (isPrimitiveTool(tool)) {
      beginPrimitiveDraw(ops, env, tool, e);
      return;
    }
    if (tool === "measure") {
      beginMeasureDrag(env, e);
      return;
    }
    penBackgroundDown(ops, env, e);
  };

  // Width tool widget grab — perpendicular drag sets the anchor's width
  // multiplier (tools/width.ts).
  const onWidthWidgetDown =
    (index: number) => (e: React.PointerEvent<SVGCircleElement>) => {
      if (!rect) return;
      if (e.button !== 0) return;
      setMenu(null);
      e.preventDefault();
      e.stopPropagation();
      beginWidthDrag(env, index, e);
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
      // (fixing the old bug where a later plain drag re-linked them). A
      // smooth (un-broken) anchor keeps its partner collinear (each handle
      // keeps its own length — see drag.ts); a broken one moves each
      // handle alone.
      if (e.altKey && !wasBroken) ops.updateAnchor(index, { broken: true });
      setDrag({
        kind: "handle",
        index,
        side,
        linked: !e.altKey && !wasBroken,
        startClient: { x: e.clientX, y: e.clientY },
      });
    };

  // Segment press (sub-path mode): plain = select the two adjacent anchors
  // and move the segment with them; Alt = bend the curve. Bending is the
  // modified gesture because a plain grab of a path should never reshape it.
  const onSegmentPointerDown =
    (seg: { seg: number; i: number; j: number }) =>
    (e: React.PointerEvent<SVGPathElement>) => {
      if (!rect) return;
      if (e.button !== 0) return;
      if (tool !== "subpath") return;
      setMenu(null);
      e.preventDefault();
      e.stopPropagation();
      if (e.altKey) beginSegmentDrag(ops, env, seg, e);
      else beginSegmentSelect(ops, env, seg, e);
    };

  // Double-click a segment (or an inactive subpath's outline) → select the
  // whole subpath. Runs after the second press has already selected the
  // segment's pair, so it simply widens the selection to everything.
  const onSelectWholeSubpath =
    (index?: number) => (e: React.MouseEvent<SVGPathElement>) => {
      if (tool !== "subpath") return;
      e.preventDefault();
      e.stopPropagation();
      if (index !== undefined && index !== activeSubpathRef.current) {
        ops.selectSubpath(index);
      }
      ops.selectAllAnchors(index);
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
      // Alt-click cycles the corner style (round → chamfer → scoop);
      // plain press drags the radius. Spec 080226 M1.
      if (e.altKey) {
        cycleCornerStyle(ops, env, index);
        return;
      }
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

  // Multi-node ghost outlines (spec 072726 M5): every other Spline Draw
  // node's effective geometry, dim reference chrome + switch targets.
  const ghostD = useMemo(() => {
    const out: Array<{ nodeId: string; d: string }> = [];
    if (!rect || !ghostsOn || !others?.length) return out;
    for (const g of others) {
      const subs = roundCornersPerAnchor(subpathsOf(g.value));
      for (let i = 0; i < subs.length; i++) {
        const d = subpathToPathD(
          subs[i]?.anchors ?? [],
          subs[i]?.closed ?? false,
          normToPx
        );
        if (d) out.push({ nodeId: g.nodeId, d });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rect, ghostsOn, others]);

  // Onion-skin ghost outlines (spec 072726 M1): neighboring keyframe shapes,
  // run through the effective-geometry fillet like every preview.
  const onionD = useMemo(() => {
    const out: Array<{ key: string; d: string; color: string }> = [];
    if (!rect) return out;
    const build = (
      v: SplineParamValue | null | undefined,
      color: string,
      tag: string
    ) => {
      if (!v) return;
      const subs = roundCornersPerAnchor(subpathsOf(v));
      for (let i = 0; i < subs.length; i++) {
        const d = subpathToPathD(
          subs[i]?.anchors ?? [],
          subs[i]?.closed ?? false,
          normToPx
        );
        if (d) out.push({ key: `${tag}-${i}`, d, color });
      }
    };
    build(onionPrev, COL_ONION_PREV, "prev");
    build(onionNext, COL_ONION_NEXT, "next");
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rect, onionPrev, onionNext]);

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

  // Width tool widgets (spec 072726 M3) — every anchor of the active
  // subpath gets a perpendicular widget pair in width mode.
  // Measurement readout (spec 080226 M4): crossings of the persistent
  // measure line with the EFFECTIVE outlines, plus the span labels between
  // consecutive crossings and the total — all in CANVAS px (client px ×
  // the buffer/display scale), the same unit stroke thickness uses.
  const measureData = useMemo(() => {
    if (tool !== "measure" || !measure || !rect) return null;
    const dx = measure.x2 - measure.x1;
    const dy = measure.y2 - measure.y1;
    const len = Math.hypot(dx, dy);
    if (len < 2) return null;
    const scale = canvas ? canvas.width / rect.width : 1;
    const ts = measureCrossings(measure, effSubpaths, normToPx);
    const ux = dx / len;
    const uy = dy / len;
    const nx2 = -uy;
    const ny2 = ux;
    const fmtPx = (v: number) => (v >= 10 ? v.toFixed(0) : v.toFixed(1));
    const ticks = ts.map((t) => ({
      x: measure.x1 + dx * t,
      y: measure.y1 + dy * t,
    }));
    const spans: Array<{ x: number; y: number; label: string }> = [];
    for (let k = 0; k + 1 < ts.length; k++) {
      const mid = (ts[k] + ts[k + 1]) / 2;
      spans.push({
        x: measure.x1 + dx * mid + nx2 * 12,
        y: measure.y1 + dy * mid + ny2 * 12,
        label: fmtPx((ts[k + 1] - ts[k]) * len * scale),
      });
    }
    return {
      nx: nx2,
      ny: ny2,
      ticks,
      spans,
      total: fmtPx(len * scale),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, measure, rect, effSubpaths, canvas]);

  // Tunni tension points (spec 080226 M3): one per segment whose two
  // adjacent anchors are both selected (the pair-select segment grammar) and
  // whose handle rays properly intersect.
  const tunniPoints = useMemo(() => {
    if (tool !== "subpath" || !rect) return [];
    const anchorsNow = subpathsOf(value)[activeSubpath]?.anchors ?? [];
    const out: TunniPoint[] = [];
    for (const s of segments) {
      if (!selected.has(s.i) || !selected.has(s.j)) continue;
      const tp = tunniForSegment({ rect, normToPx }, anchorsNow, s);
      if (tp) out.push(tp);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, rect, value, activeSubpath, selected, segments]);

  const widthWidgetList = useMemo(() => {
    if (tool !== "width" || !rect) return [];
    const sub = subpathsOf(value)[activeSubpath];
    return widthWidgets(
      { rect, normToPx },
      sub?.anchors ?? [],
      sub?.closed ?? false
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, rect, value, activeSubpath]);

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

  // Path Select, Shape Builder and the primitive tools hide the per-anchor
  // editing UI (anchors / handles / segment hit paths) — Path shows outlines
  // + bounding box, Shape shows outlines + face highlights, the primitives
  // keep the canvas clear so a drag can start anywhere (an anchor hit ring
  // under the press would otherwise swallow it). Pen and Sub-path modes
  // render the active subpath's anchors for editing; Width mode shows anchor
  // MARKS (visual passes) but its widgets are the only interactive targets.
  const anchors =
    tool === "path" ||
    tool === "shape" ||
    tool === "measure" ||
    isPrimitiveTool(tool)
      ? []
      : subpathsOf(value)[activeSubpathRef.current]?.anchors ?? [];
  // Width mode: suppress handle chrome + the anchor/handle hit rings so
  // widget drags can't collide with anchor moves.
  const anchorsInteractive = tool !== "width";
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
      // G2 curvature continuity (spec 080226 M2): slides each qualifying
      // smooth anchor along its handle axis so the curvature matches
      // across it; non-qualifying targets skip silently.
      menuItems.push({
        label: "Harmonize (G2)",
        onClick: () => {
          ops.harmonizeAnchors(idx);
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
        // Corner style picker (spec 080226 M1) — current style marked;
        // Alt-clicking the widget cycles the same three.
        const curStyle = menuAnchors[idx]?.cornerStyle;
        const styleItem = (
          label: string,
          style: SplineAnchor["cornerStyle"]
        ) => {
          menuItems.push({
            label: `${curStyle === style ? "✓ " : "   "}${label}`,
            onClick: () => {
              const patch = new Map<number, Partial<SplineAnchor>>();
              for (const i of menuTargets) patch.set(i, { cornerStyle: style });
              ops.patchAnchors(patch);
              closeMenu();
            },
          });
        };
        styleItem("Corner: round", undefined);
        styleItem("Corner: chamfer", "chamfer");
        styleItem("Corner: scoop", "scoop");
      }
      if (menuTargets.some((i) => menuAnchors[i]?.width !== undefined)) {
        menuItems.push({
          label: "Reset width",
          onClick: () => {
            const patch = new Map<number, Partial<SplineAnchor>>();
            for (const i of menuTargets) patch.set(i, { width: undefined });
            ops.patchAnchors(patch);
            closeMenu();
          },
        });
      }
      // Per-anchor keyframing (spec 072726 M6) — hidden while whole-shape
      // Path Animation is on (either/or).
      if (onAnchorAnimate && !pathAnimated) {
        const isAnim = (i: number) => {
          const id = menuAnchors[i]?.id;
          return !!(id && animatedAnchorIds?.has(id));
        };
        if (!menuTargets.every(isAnim)) {
          menuItems.push({
            label:
              menuTargets.length > 1 ? "Animate anchors" : "Animate anchor",
            onClick: () => {
              onAnchorAnimate(activeSubpath, menuTargets, true);
              closeMenu();
            },
          });
        }
        if (menuTargets.some(isAnim)) {
          menuItems.push({
            label: "Remove anchor animation",
            onClick: () => {
              onAnchorAnimate(activeSubpath, menuTargets, false);
              closeMenu();
            },
          });
        }
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
    } else if (menu.kind === "segment") {
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
    } else if (onGuidesChange) {
      // Canvas background (spec 080226 M5): guides at the click point.
      const mx = menu.x;
      const my = menu.y;
      menuItems.push({
        label: "Add vertical guide here",
        onClick: () => {
          const [gx] = clientToNorm(mx, my);
          onGuidesChange([...(guides ?? []), { axis: "x", pos: gx }]);
          closeMenu();
        },
      });
      menuItems.push({
        label: "Add horizontal guide here",
        onClick: () => {
          const [, gy] = clientToNorm(mx, my);
          onGuidesChange([...(guides ?? []), { axis: "y", pos: gy }]);
          closeMenu();
        },
      });
      if ((guides?.length ?? 0) > 0) {
        menuItems.push({
          label: "Clear guides",
          onClick: () => {
            onGuidesChange([]);
            closeMenu();
          },
        });
      }
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
              tool === "pen" ||
              tool === "pencil" ||
              tool === "shape" ||
              tool === "measure" ||
              isPrimitiveTool(tool)
                ? "crosshair"
                : "default",
            pointerEvents: "auto",
          }}
          onPointerDown={onBackgroundPointerDown}
          onContextMenu={(e) => {
            // Background context menu (spec 080226 M5): add guides here.
            e.preventDefault();
            e.stopPropagation();
            setMenu({ kind: "background", x: e.clientX, y: e.clientY });
          }}
        />

        {/* User guidelines (spec 080226 M5): full-canvas lines with a grab
            dot at the near edge — drag to move (snapping targets update
            live), drop outside the canvas to delete. */}
        {(guides ?? []).map((g, k) => {
          const isV = g.axis === "x";
          const gx = isV ? normToPx([g.pos, 0]).x : 0;
          const gy = isV ? 0 : normToPx([0, g.pos]).y;
          const dotX = isV ? gx : rect.left + 12;
          const dotY = isV ? rect.top + 12 : gy;
          return (
            <g key={`uguide-${k}`}>
              <line
                x1={isV ? gx : rect.left}
                y1={isV ? rect.top : gy}
                x2={isV ? gx : rect.right}
                y2={isV ? rect.bottom : gy}
                stroke={COL_USER_GUIDE}
                strokeWidth={1}
                opacity={0.55}
                style={{ pointerEvents: "none" }}
              />
              <circle
                cx={dotX}
                cy={dotY}
                r={GUIDE_DOT_R}
                fill="rgba(129, 140, 248, 0.35)"
                stroke={COL_USER_GUIDE}
                strokeWidth={1.2}
                style={{ pointerEvents: "none" }}
              />
              <circle
                cx={dotX}
                cy={dotY}
                r={GUIDE_DOT_HIT_R}
                fill="transparent"
                style={{
                  cursor: isV ? "ew-resize" : "ns-resize",
                  pointerEvents: "auto",
                }}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  setMenu(null);
                  e.preventDefault();
                  e.stopPropagation();
                  setDrag({
                    kind: "guide",
                    index: k,
                    startClient: { x: e.clientX, y: e.clientY },
                  });
                }}
                onContextMenu={(e) => e.preventDefault()}
              />
            </g>
          );
        })}

        {/* Other Spline Draw nodes' ghost outlines (spec 072726 M5) — the
            dimmest layer. The visual paths are inert; in the select tools a
            wide hit path over each lets a click SWITCH the overlay to that
            node (rendered before all own-node chrome, so the active node
            always wins overlaps). */}
        {ghostD.map((g, i) => (
          <path
            key={`ghost-${g.nodeId}-${i}`}
            d={g.d}
            fill="none"
            stroke={COL_GHOST}
            strokeWidth={1}
            style={{ pointerEvents: "none" }}
          />
        ))}
        {onSelectNode &&
          (tool === "path" || tool === "subpath") &&
          ghostD.map((g, i) => (
            <path
              key={`ghosthit-${g.nodeId}-${i}`}
              d={g.d}
              fill="none"
              stroke="transparent"
              strokeWidth={SEGMENT_HIT_W}
              strokeLinecap="round"
              style={{ cursor: "pointer", pointerEvents: "stroke" }}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();
                onSelectNode(g.nodeId);
              }}
              onContextMenu={(e) => e.preventDefault()}
            />
          ))}

        {/* Onion-skin ghosts — beneath every other path layer. Previous
            keyframe red, next green, dashed, non-interactive. */}
        {onionOn &&
          onionD.map((g) => (
            <path
              key={`onion-${g.key}`}
              d={g.d}
              fill="none"
              stroke={g.color}
              strokeWidth={1.1}
              strokeDasharray="5 4"
              opacity={0.5}
              style={{ pointerEvents: "none" }}
            />
          ))}

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
              onDoubleClick={onSelectWholeSubpath(p.index)}
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
            highlighting, the select/move press, the double-click select-all,
            and the Alt bend drag. Drawn beneath the anchor/handle hit rings
            so grabbing an endpoint still wins. */}
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
              onDoubleClick={onSelectWholeSubpath()}
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
        {anchorsInteractive &&
          anchors.map((a, i) => {
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
        {anchorsInteractive &&
          anchors.map((a, i) => {
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
        {anchorsInteractive &&
          anchors.map((a, i) => {
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
          // Per-anchor animation badge (spec 072726 M6): a dashed ring marks
          // anchors that carry keyframe tracks.
          const animRing =
            a.id && animatedAnchorIds?.has(a.id) ? (
              <circle
                cx={p.x}
                cy={p.y}
                r={ANCHOR_HIT_R - 3}
                fill="none"
                stroke={COL_SEL_STROKE}
                strokeWidth={1}
                strokeDasharray="2 2"
                opacity={0.85}
                style={{ pointerEvents: "none" }}
              />
            ) : null;
          if (hasHandles) {
            return (
              <g key={`av-${i}`}>
                {animRing}
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={isSel || isHov ? ANCHOR_R + 1 : ANCHOR_R}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={1.4}
                  style={{ pointerEvents: "none" }}
                />
              </g>
            );
          }
          const half = (isSel || isHov ? ANCHOR_SQUARE + 2 : ANCHOR_SQUARE) / 2;
          return (
            <g key={`av-${i}`}>
              {animRing}
              <rect
                x={p.x - half}
                y={p.y - half}
                width={half * 2}
                height={half * 2}
                fill={fill}
                stroke={stroke}
                strokeWidth={1.4}
                style={{ pointerEvents: "none" }}
              />
            </g>
          );
        })}

        {/* Pass 4 — handle visual dots, on top of anchor visuals. Hit rings
            are already in pass 1 so these are pointer-event-free. */}
        {anchorsInteractive &&
          anchors.map((a, i) => {
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

        {/* Snap guides (spec 071926 M2): canvas guide hairlines, a ring on a
            snapped-to anchor, and dashed alignment guides spanning the
            anchors the point lined up with (ticked at each participant).
            Rendered above the editing chrome, below the marquee. */}
        {snapGuides.map((g, gi) =>
          g.kind === "align" ? (
            <g key={`sg-${gi}`} style={{ pointerEvents: "none" }}>
              <line
                x1={g.axis === "x" ? g.at : g.from}
                y1={g.axis === "x" ? g.from : g.at}
                x2={g.axis === "x" ? g.at : g.to}
                y2={g.axis === "x" ? g.to : g.at}
                stroke={COL_GUIDE}
                strokeWidth={1}
                strokeDasharray="4 3"
                opacity={0.95}
              />
              {/* A short tick across each aligned anchor, so it reads as
                  "these are the points you're lined up with". */}
              {g.marks.map((m, mi) => (
                <line
                  key={mi}
                  x1={g.axis === "x" ? g.at - 3 : m}
                  y1={g.axis === "x" ? m : g.at - 3}
                  x2={g.axis === "x" ? g.at + 3 : m}
                  y2={g.axis === "x" ? m : g.at + 3}
                  stroke={COL_GUIDE}
                  strokeWidth={1.3}
                  opacity={0.95}
                />
              ))}
            </g>
          ) : g.kind === "vline" ? (
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

        {/* Measurement readout (spec 080226 M4): the ruler line, a tick at
            every outline crossing, span labels between crossings, and the
            total at the end — all in canvas px. */}
        {tool === "measure" && measure && measureData && (
          <g style={{ pointerEvents: "none" }}>
            <line
              x1={measure.x1}
              y1={measure.y1}
              x2={measure.x2}
              y2={measure.y2}
              stroke={COL_MEASURE}
              strokeWidth={1}
              opacity={0.9}
            />
            {measureData.ticks.map((tk, k) => (
              <line
                key={`mt-${k}`}
                x1={tk.x - measureData.nx * MEASURE_TICK}
                y1={tk.y - measureData.ny * MEASURE_TICK}
                x2={tk.x + measureData.nx * MEASURE_TICK}
                y2={tk.y + measureData.ny * MEASURE_TICK}
                stroke={COL_MEASURE}
                strokeWidth={1.2}
              />
            ))}
            {measureData.spans.map((sp, k) => (
              <text
                key={`ms-${k}`}
                x={sp.x}
                y={sp.y}
                fill={COL_MEASURE}
                fontSize={10}
                fontFamily="ui-monospace, monospace"
                textAnchor="middle"
                stroke="#111"
                strokeWidth={3}
                paintOrder="stroke"
              >
                {sp.label}
              </text>
            ))}
            <text
              x={measure.x2 + measureData.nx * 14}
              y={measure.y2 + measureData.ny * 14}
              fill={COL_MEASURE}
              fontSize={10}
              fontFamily="ui-monospace, monospace"
              textAnchor="middle"
              stroke="#111"
              strokeWidth={3}
              paintOrder="stroke"
            >
              {`Σ ${measureData.total}`}
            </text>
          </g>
        )}

        {/* Tunni tension widgets (spec 080226 M3): the dashed "Tunni line"
            between the segment's handle tips + a dot at the ray
            intersection. Drag re-aims both handles preserving tension;
            double-click balances the tensions. */}
        {tunniPoints.map((tp) => (
          <g key={`tunni-${tp.seg}`}>
            <line
              x1={tp.p1x}
              y1={tp.p1y}
              x2={tp.p2x}
              y2={tp.p2y}
              stroke={COL_TUNNI}
              strokeWidth={1}
              strokeDasharray="3 3"
              opacity={0.55}
              style={{ pointerEvents: "none" }}
            />
            <circle
              cx={tp.x}
              cy={tp.y}
              r={TUNNI_R}
              fill="rgba(251, 146, 60, 0.3)"
              stroke={COL_TUNNI}
              strokeWidth={1.3}
              style={{ pointerEvents: "none" }}
            />
            <circle
              cx={tp.x}
              cy={tp.y}
              r={TUNNI_HIT_R}
              fill="transparent"
              style={{ cursor: "grab", pointerEvents: "auto" }}
              onPointerDown={(e) => {
                if (!rect) return;
                if (e.button !== 0) return;
                setMenu(null);
                e.preventDefault();
                e.stopPropagation();
                beginTunniDrag(env, tp, e);
              }}
              onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                tunniBalance(ops, env, tp);
              }}
              onContextMenu={(e) => e.preventDefault()}
            />
          </g>
        ))}

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

        {/* Width tool widgets (width mode) — a perpendicular pair per
            anchor; drag either side to set the anchor's width multiplier
            symmetrically. */}
        {widthWidgetList.map((w) => (
          <g key={`ww-${w.index}`}>
            <line
              x1={w.x1}
              y1={w.y1}
              x2={w.x2}
              y2={w.y2}
              stroke={COL_WIDTH_WIDGET}
              strokeWidth={1}
              opacity={0.55}
              style={{ pointerEvents: "none" }}
            />
            {[
              [w.x1, w.y1],
              [w.x2, w.y2],
            ].map(([wx, wy], side) => (
              <g key={side}>
                <circle
                  cx={wx}
                  cy={wy}
                  r={WIDTH_WIDGET_R}
                  fill="rgba(167, 139, 250, 0.3)"
                  stroke={COL_WIDTH_WIDGET}
                  strokeWidth={1.3}
                  style={{ pointerEvents: "none" }}
                />
                <circle
                  cx={wx}
                  cy={wy}
                  r={WIDTH_WIDGET_HIT_R}
                  fill="transparent"
                  style={{ cursor: "grab", pointerEvents: "auto" }}
                  onPointerDown={onWidthWidgetDown(w.index)}
                  onContextMenu={onAnchorContextMenu(w.index)}
                />
              </g>
            ))}
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

        {/* Modal transform chrome (G / S / R): a cross on the pivot (the
            targets' median — what scale and rotate work about) plus the
            axis-constraint hairline through it while X / Y is engaged. */}
        {modal &&
          (() => {
            const p = normToPx(modal.pivot);
            return (
              <g style={{ pointerEvents: "none" }}>
                {modal.axis === "x" && (
                  <line
                    x1={rect.left}
                    y1={p.y}
                    x2={rect.right}
                    y2={p.y}
                    stroke={COL_GUIDE}
                    strokeWidth={1}
                    opacity={0.8}
                  />
                )}
                {modal.axis === "y" && (
                  <line
                    x1={p.x}
                    y1={rect.top}
                    x2={p.x}
                    y2={rect.bottom}
                    stroke={COL_GUIDE}
                    strokeWidth={1}
                    opacity={0.8}
                  />
                )}
                <line
                  x1={p.x - 6}
                  y1={p.y}
                  x2={p.x + 6}
                  y2={p.y}
                  stroke={COL_GUIDE}
                  strokeWidth={1.3}
                />
                <line
                  x1={p.x}
                  y1={p.y - 6}
                  x2={p.x}
                  y2={p.y + 6}
                  stroke={COL_GUIDE}
                  strokeWidth={1.3}
                />
              </g>
            );
          })()}

        {/* Primitive rubber band (rect / ellipse tools) — the RESOLVED box
            from the drag state, so this preview is exactly the geometry the
            release commits. A faint box accompanies the ellipse so the
            gesture's extents stay legible. */}
        {drag?.kind === "primitive" && drag.box && (
          <>
            {drag.prim === "ellipse" && (
              <rect
                x={drag.box.x}
                y={drag.box.y}
                width={drag.box.w}
                height={drag.box.h}
                fill="none"
                stroke={COL_PATH}
                strokeWidth={1}
                strokeDasharray="3 4"
                opacity={0.35}
                style={{ pointerEvents: "none" }}
              />
            )}
            {drag.prim === "rect" ? (
              <rect
                x={drag.box.x}
                y={drag.box.y}
                width={drag.box.w}
                height={drag.box.h}
                fill="none"
                stroke={COL_PATH}
                strokeWidth={1.4}
                style={{ pointerEvents: "none" }}
              />
            ) : (
              <ellipse
                cx={drag.box.x + drag.box.w / 2}
                cy={drag.box.y + drag.box.h / 2}
                rx={drag.box.w / 2}
                ry={drag.box.h / 2}
                fill="none"
                stroke={COL_PATH}
                strokeWidth={1.4}
                style={{ pointerEvents: "none" }}
              />
            )}
          </>
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
        left={(hostRect ?? rect).left + 2}
        top={(hostRect ?? rect).top + 2}
        tool={tool}
        onSelectTool={setTool}
        closed={subpathsOf(value)[activeSubpath]?.closed ?? false}
        onToggleClosed={ops.toggleClosed}
        showDeleteSubpath={subpathsOf(value).length > 1}
        onDeleteSubpath={ops.deleteActiveSubpath}
        showOnion={onionD.length > 0}
        onionOn={onionOn}
        onToggleOnion={() => setOnionOn((v) => !v)}
        showGhosts={(others?.length ?? 0) > 0}
        ghostsOn={ghostsOn}
        onToggleGhosts={() => setGhostsOn((v) => !v)}
      />

      {/* Numeric drag HUD — a readout chip trailing the pointer (position +
          Δ / angle + length / radius / scale %, per drag kind). Normalized
          units; angles are screen-space degrees. */}
      {hud && (
        <div
          style={{
            position: "fixed",
            left: hud.x + 14,
            top: hud.y + 18,
            padding: "3px 7px",
            background: "rgba(17, 17, 17, 0.92)",
            border: "1px solid #27272a",
            borderRadius: 4,
            color: "#e4e4e7",
            fontFamily: "var(--ui-font)",
            fontSize: 11,
            whiteSpace: "nowrap",
            pointerEvents: "none",
            zIndex: 11,
          }}
        >
          {hud.text}
        </div>
      )}

      {/* Context menu (anchor or segment target). */}
      {menu && menuItems.length > 0 && (
        <SplineContextMenu x={menu.x} y={menu.y} items={menuItems} />
      )}
    </div>
  );
}
