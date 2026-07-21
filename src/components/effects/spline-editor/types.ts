// Shared types for the Spline Draw editor overlay (spline-editor/).
// Split out of the monolith in M0 of
// specdocs/071926_spline-draw-authoring-upgrade.md.

import type { Dispatch, SetStateAction } from "react";
import type { MultiPolygon } from "polygon-clipping";
import type { FaceRef, PlanarShape } from "@/engine/spline-planar";
import type { SplineParamValue } from "@/nodes/source/spline-draw";
import type { SnapGuide } from "./snapping";

export type ToolMode = "pen" | "pencil" | "path" | "subpath" | "shape";

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
    };

// Right-click context menu anchored at a client position — for one anchor,
// or for a point on a segment (right-clicked at parameter t between anchors
// i and j; spec 071926 M4 scissors/insert).
export type MenuState =
  | { kind: "anchor"; x: number; y: number; index: number }
  | { kind: "segment"; x: number; y: number; i: number; j: number; t: number };

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
  // Active snap guides (drag handlers write, the component renders them as
  // hairlines / rings; cleared on pointerup). Spec 071926 M2.
  setSnapGuides: Dispatch<SetStateAction<SnapGuide[]>>;
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
