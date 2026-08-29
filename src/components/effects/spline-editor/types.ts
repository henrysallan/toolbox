// Shared types for the Spline Draw editor overlay (spline-editor/).
// Split out of the monolith in M0 of
// specdocs/archive/071926_spline-draw-authoring-upgrade.md.

import type { Dispatch, SetStateAction } from "react";
import type { MultiPolygon } from "polygon-clipping";
import type { FaceRef, PlanarShape } from "@/engine/spline-planar";
import type { SplineParamValue } from "@/nodes/source/spline-draw";
import type { SnapGuide } from "./snapping";

export type ToolMode =
  | "pen"
  | "pencil"
  | "rect"
  | "ellipse"
  | "path"
  | "subpath"
  | "shape"
  | "width"
  | "measure";

// A user guideline (spec 080226 M5): a full-canvas vertical (`axis: "x"`)
// or horizontal (`axis: "y"`) line at a normalized position — anchor
// space, so guides ride canvas-resolution changes. Stored per node in the
// hidden `spline_guides` param (NOT the keyframed spline envelope — guide
// edits must never mint Path Animation keyframes).
export interface SplineGuide {
  axis: "x" | "y";
  pos: number;
}

// The measurement tool's persistent line (spec 080226 M4) — client px.
// Survives pointerup so the readout can be studied; cleared by Escape or a
// new drag. Rendering is gated on the measure tool being active.
export interface MeasureLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

// The primitive-stamping tools (tools/primitive.ts) — one drag draws one
// closed subpath. Grouped because several call sites branch on "is a
// primitive tool active" (anchor chrome hides, the cursor goes crosshair).
export type PrimitiveKind = "rect" | "ellipse";
export const isPrimitiveTool = (t: ToolMode): t is PrimitiveKind =>
  t === "rect" || t === "ellipse";

// A picked Shape Builder face: the engine FaceRef (signature + seed point —
// component-precise, since two disconnected regions can share a signature),
// the picked component's geometry (scaled space — used for cheap "is the
// cursor still in this face" containment tests), its component index within
// the signature's composition (cache key), and the prebuilt px-space SVG
// path of its highlight fill.
export interface FacePick {
  ref: FaceRef;
  geom: MultiPolygon;
  component: number;
  d: string;
}

// Bounding-box transform handles (Path Select). Corners scale both axes;
// edges scale one. The dragged handle moves; the opposite edge/corner stays
// anchored (the box's anchor point for the scale pivot).
export type BBoxHandle = "tl" | "tr" | "br" | "bl" | "t" | "r" | "b" | "l";

export type DragState =
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
      // Smooth (un-broken) anchor: the partner handle stays collinear with
      // the dragged one but keeps its own length. False (Alt or broken) —
      // the dragged handle moves alone.
      linked: boolean;
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
      // about an anchored edge/corner, baked via scaleWholePath.
      kind: "bbox";
      handle: BBoxHandle;
      startClient: { x: number; y: number };
      startBox: { minX: number; minY: number; maxX: number; maxY: number };
      startValue: SplineParamValue;
    }
  | {
      // Pencil freehand stroke. The captured samples live in `pencilPtsRef`
      // (mutated in place to avoid an array churn per pointermove); this entry
      // just keeps the effect's window listeners bound for the gesture.
      kind: "pencil";
    }
  | {
      // Live Corners widget drag (tools/corner.ts): writes cornerRadius on
      // the grabbed corner + every other selected eligible corner (targets),
      // one patchAnchors per move. Spec: 071926 M1.
      kind: "corner-radius";
      index: number;
      targets: number[];
      startClient: { x: number; y: number };
    }
  | {
      // Shape Builder gesture (tools/shape.ts): faces accumulate as the
      // pointer crosses them (a plain click keeps just the first); resolved
      // to ONE applyShapeBuilderOp on pointerup — merge, or delete when Alt
      // was held at press. Spec: 071926 M3.
      kind: "shape";
      faces: FacePick[];
      alt: boolean;
      startClient: { x: number; y: number };
    }
  | {
      // Width tool drag (tools/width.ts): perpendicular distance from the
      // anchor maps to its `width` multiplier. Spec 072726 M3.
      kind: "width";
      index: number;
      startClient: { x: number; y: number };
    }
  | {
      // Primitive draw (tools/primitive.ts): rubber-band a rectangle or
      // ellipse from the press point, committed as ONE closed subpath on
      // release. `box` is the RESOLVED client-px box with the modifiers
      // already applied (Shift = 1:1, Alt = press point is the centre), so
      // the preview and the committed geometry can never disagree; null
      // until the first move. `startClient` is the snapped press point.
      kind: "primitive";
      prim: PrimitiveKind;
      startClient: { x: number; y: number };
      box: { x: number; y: number; w: number; h: number } | null;
    }
  | {
      // Tunni tension drag (tools/tunni.ts, spec 080226 M3): dragging the
      // handle-ray intersection re-aims BOTH of the segment's handles at
      // the new point, each preserving its captured tension fraction.
      kind: "tunni";
      seg: number;
      i: number;
      j: number;
      f1: number; // |outHandle| / |T−P0| at drag start
      f2: number; // |inHandle| / |T−P3| at drag start
      startClient: { x: number; y: number };
    }
  | {
      // Measurement drag (spec 080226 M4): the live line writes through
      // env.setMeasure; pointerup deliberately KEEPS it on screen.
      kind: "measure";
      startClient: { x: number; y: number };
    }
  | {
      // Guideline drag (spec 080226 M5): reposition guide `index`; dropping
      // with the pointer outside the canvas deletes it.
      kind: "guide";
      index: number;
      startClient: { x: number; y: number };
    };

// Blender-style modal transform (tools/transform.ts): G / S / R start a
// keyboard-initiated transform of the current target set that tracks the
// pointer with no button held, confirmed with a left click or Enter and
// cancelled with Escape or a right click. Unlike every other gesture here it
// is NOT a DragState — it begins on keydown and ends on a click, so it owns
// its own listeners.
export interface ModalTransform {
  mode: "move" | "scale" | "rotate";
  // Anchors under transform as [subpathIndex, anchorIndex] pairs into
  // `startValue` (Path Select transforms every subpath, so this can span
  // more than the active one).
  targets: Array<[number, number]>;
  // Snapshot at keydown: every move recomputes from this, so the transform
  // never compounds.
  startValue: SplineParamValue;
  // What a cancel restores — normally `startValue` itself, but an EXTRUDE
  // arms the modal with its new anchor already written, so its cancel drops
  // back to the pre-extrude value (Escape undoes the whole extrude, rather
  // than leaving a duplicate anchor behind the way Blender does) and puts
  // the selection back on the anchor it grew from.
  cancelValue: SplineParamValue;
  cancelSelection: Set<number> | null;
  // Median of the targets + the pointer, both in normalized space. Note the
  // overlay's normalized space is aspect-corrected, so a normalized offset
  // maps to px by a UNIFORM scale (rect.width) on both axes — scale and
  // rotate can be done directly in normalized units and still look right on
  // a non-square canvas.
  pivot: [number, number];
  startNorm: [number, number];
  // X / Y axis constraint (move + scale; meaningless for a 2D rotate).
  axis: "x" | "y" | null;
}

// Numeric drag HUD (spec 071926, shipped as the M2-tier polish addendum): a
// small readout chip that follows the pointer during drags — position + Δ
// for anchor moves, angle + length for handle pulls, radius for Live
// Corners, scale % for bbox. Written by drag.ts per move, cleared on
// pointerup. Values are in the app's normalized [0,1] units (angles are
// screen-space degrees, matching the 45° lock).
export interface HudState {
  x: number;
  y: number;
  text: string;
}

// Right-click context menu anchored at a client position — for one anchor,
// or for a point on a segment (right-clicked at parameter t between anchors
// i and j; spec 071926 M4 scissors/insert).
export type MenuState =
  | { kind: "anchor"; x: number; y: number; index: number }
  | { kind: "segment"; x: number; y: number; i: number; j: number; t: number }
  // Canvas background (spec 080226 M5): add guides at the click point.
  | { kind: "background"; x: number; y: number };

// Minimal structural ref type — matches React's useRef return shape without
// tying these modules to a specific React version's ref typings.
export interface Ref<T> {
  current: T;
}

// The shared context handed to ops/tools/drag helpers. Built as a plain
// object EVERY render by the component, so the plain-value fields (`rect`,
// `tool`) carry the same stale-closure semantics the monolith had: a drag
// effect binds handlers that captured the render in which the gesture began,
// while all live data flows through the refs. Tools and ops never touch
// component state except through the setters here.
export interface SplineEditorEnv {
  valueRef: Ref<SplineParamValue>;
  onChangeRef: Ref<(next: SplineParamValue) => void>;
  activeSubpathRef: Ref<number>;
  selectedRef: Ref<Set<number>>;
  lastAnchorRef: Ref<number | null>;
  penSealedRef: Ref<boolean>;
  pencilPtsRef: Ref<Array<[number, number]>>;
  // Cached planar-face geometry for the Shape Builder tool — built by the
  // component (from the EFFECTIVE rounded subpaths) whenever the shape tool
  // is active, null otherwise. Tools read it at event time.
  planarShapeRef: Ref<PlanarShape | null>;
  // Current-render snapshots.
  rect: DOMRect | null;
  tool: ToolMode;
  // State setters (stable across renders).
  setSelected: Dispatch<SetStateAction<Set<number>>>;
  setActiveSubpath: Dispatch<SetStateAction<number>>;
  setPenSealed: Dispatch<SetStateAction<boolean>>;
  setDrag: Dispatch<SetStateAction<DragState | null>>;
  setPencilVersion: Dispatch<SetStateAction<number>>;
  setHoverSeg: Dispatch<SetStateAction<number | null>>;
  setMenu: Dispatch<SetStateAction<MenuState | null>>;
  // Other Spline Draw nodes' anchor positions in client px (spec 072726
  // M5) — joined into the snap targets while ghosts are shown. A plain
  // per-render snapshot, like `rect`.
  ghostSnapPx: Array<{ x: number; y: number }>;
  // Active snap guides (drag handlers write, the component renders them as
  // hairlines / rings; cleared on pointerup). Spec 071926 M2.
  setSnapGuides: Dispatch<SetStateAction<SnapGuide[]>>;
  // Viewport snapping toggle — live via a ref so flipping the lock
  // mid-drag takes effect on the next pointermove. Cmd/Ctrl still
  // suppresses a single gesture while it's on.
  snapEnabledRef: Ref<boolean>;
  // Numeric drag HUD (see HudState). Written per move, cleared on pointerup.
  setHud: Dispatch<SetStateAction<HudState | null>>;
  // Measurement line (spec 080226 M4) — written by the measure drag,
  // persists past pointerup.
  setMeasure: Dispatch<SetStateAction<MeasureLine | null>>;
  // Guidelines (spec 080226 M5): per-render snapshot of the node's guides
  // and the write-through (a `spline_guides` param write — its own undo,
  // never touching the keyframed spline). Also feeds the snap service.
  guides: SplineGuide[];
  onGuidesChange: (next: SplineGuide[]) => void;
  // px ↔ normalized converters for the current rect (aspect-corrected — see
  // the component). Return zeros when rect is null.
  clientToNorm: (cx: number, cy: number) => [number, number];
  normToPx: (p: [number, number]) => { x: number; y: number };
}

// The minimal slice of a pointer event the tool helpers need — lets them
// accept both React synthetic events and native PointerEvents.
export interface PointerLike {
  clientX: number;
  clientY: number;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}
