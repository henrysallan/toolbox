"use client";

// Graph Editor for a single SCALAR keyframe animation block.
//
// Renders one block of keyframes in 2D: x = ticks (display: frames),
// y = parameter value. The caller is responsible for gating this view to
// scalar tracks; this component hard-casts every `keyframe.value` to
// `number` and does not handle vec/color/bool/enum values.
//
// View transform is local; the editor reports edits via `onChange` and
// scrubs via `onScrub`. It does not touch global timeline state directly.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  BezierHandles,
  EasingPreset,
  Keyframe,
  KeyframeAnimationBlock,
  ProjectTimeline,
  SavedEasing,
} from "@/engine/keyframes";
import {
  EASING_PRESET_LABELS,
  EASING_PRESET_ORDER,
  defaultSegmentHandles,
  easeOf,
  emptyAnimationBlock,
  evaluateKeyframesAt,
  framesToTicks,
  snapTickToFrame,
  ticksToFrames,
} from "@/engine/keyframes";
import { getNodeDef } from "@/engine/registry";
import { useClock } from "@/state/playback-clock";
import { LAYER_OPACITY_PREFIX } from "@/engine/conventions";
import { getShortcutScope } from "./shortcut-scope";
import { wheelWantsZoom, getEffectiveDevice } from "./input-device";
import { EasingTile } from "./timeline/EasingTile";
import type { SelectionKey } from "./timeline/keyframe-ops";

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

interface GraphEditorProps {
  nodes: import("@xyflow/react").Node<
    import("@/state/graph").NodeDataPayload
  >[];
  timeline: ProjectTimeline;
  onAnimationChange(
    nodeId: string,
    paramName: string,
    next: KeyframeAnimationBlock | undefined
  ): void;
  onScrub(tick: number): void;
  // When true, ignore the param's declared min/max and fit y-bounds to
  // the active track's keyframe extents. The dock header's "normalize"
  // toggle drives this.
  normalizeY?: boolean;
  // Bumped by the dock header's refresh button to force an immediate
  // y-fit to the current keyframes regardless of `normalizeY` state.
  refitVersion?: number;
  // Which lanes to graph: the lanes of the keyframes currently selected
  // in the Tracks / Layers editor (EffectsApp lifts that selection and
  // derives this). Replaces the old per-track `graphVisible` ∿ toggle.
  visibleLanes?: { nodeId: string; paramName: string }[];
  // The lifted keyframe selection itself — seeds the graph's selection
  // and the fit-to-selection when the active lane changes.
  timelineSelection?: SelectionKey[];
  // Per-project user-saved easing curves. Listed in the easing dropdown
  // under "Saved"; the header's Save button appends to the list via
  // `onSaveEasing` (EffectsApp owns the list and persists it on the
  // project). Both optional so graph-only embeds keep working.
  savedEasings?: SavedEasing[];
  onSaveEasing?(easing: SavedEasing): void;
}

// ---------------------------------------------------------------------
// Constants — dark theme palette and layout metrics
// ---------------------------------------------------------------------

const BG = "var(--tb-n-0)";
const PANEL = "var(--tb-n-5)";
const BORDER = "var(--tb-n-7)";
const MUTED = "var(--tb-n-10)";
const TEXT = "var(--tb-n-15)";
const ACCENT = "var(--tb-a-blue-500)";
const CURVE = "var(--tb-a-blue-400)";

const HEIGHT = 280;
const HEADER_H = 24;
// Time-ruler band drawn at the top of the plot (ticks + frame labels +
// playhead). PADDING.top reserves room for it; x labels live here now
// instead of along the bottom.
const RULER_H = 18;
const PADDING = { top: RULER_H + 10, right: 24, bottom: 18, left: 44 };

const POINT_HIT = 9;
const HANDLE_HIT = 7;
const FIT_PAD = 0.1;

const EASING_PRESETS: { id: EasingPreset; label: string }[] =
  EASING_PRESET_ORDER.map((id) => ({ id, label: EASING_PRESET_LABELS[id] }));

// Dropdown option values for user-saved easings — namespaced so a saved
// easing id can never collide with an EasingPreset name.
const SAVED_EASING_VALUE_PREFIX = "saved:";

// One graphable track. Scalar lanes map 1:1; a vec2/3/4 lane appears as
// `componentCount` tracks, each carrying `component` and a scalar VIEW
// block (componentViewBlock) whose edits merge back into the vec block.
interface VisibleTrack {
  key: string;
  nodeId: string;
  paramName: string;
  label: string;
  block: KeyframeAnimationBlock;
  yMin?: number;
  yMax?: number;
  component?: number;
  componentCount?: number;
}

const VEC_COMPONENT_LABELS = ["X", "Y", "Z", "W"];
const VEC_COMPONENT_COUNT: Partial<Record<string, number>> = {
  vec2: 2,
  vec3: 3,
  vec4: 4,
};

// Ghost-curve palette — the non-active tracks of a cross-track
// selection, cycled by track index. Muted hues distinct from the active
// curve's blue.
const GHOST_CURVE_COLORS = [
  "#d1a05a",
  "#7fb069",
  "#c17fd1",
  "#5bc0be",
  "#d1667f",
  "#8a91d1",
];

// SVG path segments for a keyframe curve. Each segment respects
// prev.easingOut — the same geometry for the active curve and the
// ghosts; only the coordinate mapping differs.
function buildCurvePathSegments(
  ks: Keyframe[],
  tickToX: (tick: number) => number,
  valueToY: (v: number) => number
): string[] {
  if (ks.length === 0) return [];
  if (ks.length === 1) {
    return [`M ${tickToX(ks[0].tick)} ${valueToY(ks[0].value as number)}`];
  }
  const out: string[] = [];
  out.push(`M ${tickToX(ks[0].tick)} ${valueToY(ks[0].value as number)}`);
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i];
    const b = ks[i + 1];
    const ay = valueToY(a.value as number);
    const bx = tickToX(b.tick);
    const by = valueToY(b.value as number);
    const av = a.value as number;
    const bv = b.value as number;
    const span = b.tick - a.tick;
    if (a.easingOut === "linear") {
      out.push(`L ${bx} ${by}`);
    } else if (a.easingOut === "hold") {
      out.push(`L ${bx} ${ay} L ${bx} ${by}`);
    } else if (a.easingOut === "customBezier") {
      const right = a.bezierHandles?.rightHandle ?? defaultRightHandle(ks, i);
      const left = b.bezierHandles?.leftHandle ?? defaultLeftHandle(ks, i + 1);
      const c1x = tickToX(a.tick + right.dx);
      const c1y = valueToY(av + right.dy);
      const c2x = tickToX(b.tick + left.dx);
      const c2y = valueToY(bv + left.dy);
      out.push(`C ${c1x} ${c1y} ${c2x} ${c2y} ${bx} ${by}`);
    } else {
      const ctrl = PRESET_CTRL[a.easingOut];
      if (ctrl) {
        const c1Tick = a.tick + ctrl.p1[0] * span;
        const c1Val = av + ctrl.p1[1] * (bv - av);
        const c2Tick = a.tick + ctrl.p2[0] * span;
        const c2Val = av + ctrl.p2[1] * (bv - av);
        out.push(
          `C ${tickToX(c1Tick)} ${valueToY(c1Val)} ${tickToX(c2Tick)} ${valueToY(c2Val)} ${bx} ${by}`
        );
      } else {
        // Sampled polyline for non-cubic-bezier presets
        // (sine/expo/back/bounce/elastic).
        const SAMPLES = 32;
        for (let s = 1; s <= SAMPLES; s++) {
          const u = s / SAMPLES;
          const v = easeOf(a.easingOut, u);
          out.push(
            `L ${tickToX(a.tick + u * span)} ${valueToY(av + v * (bv - av))}`
          );
        }
      }
    }
  }
  return out;
}

// The full source array rides each view keyframe under this field so a
// later edit can merge back losslessly. Every editor op spreads keyframes
// (`{...k, tick}` / `{...k, value}`), so it survives moves and patches;
// mergeComponentEdit strips it before the block leaves the editor.
const VEC_SOURCE = "__vecSource";
type ViewKeyframe = Keyframe & { [VEC_SOURCE]?: unknown };

// Curve shape of a param-def-less (virtual) track, inferred from its
// keyframe values: every value a number → scalar; every value a number
// array of one shared length 2–4 → that many per-component views;
// anything else → not graphable.
function inferValueShape(ks: Keyframe[]): "scalar" | 2 | 3 | 4 | null {
  if (ks.length === 0) return null;
  let arrLen: number | null = null;
  let sawNumber = false;
  for (const k of ks) {
    if (typeof k.value === "number") {
      if (arrLen != null) return null;
      sawNumber = true;
      continue;
    }
    if (
      sawNumber ||
      !Array.isArray(k.value) ||
      k.value.some((v) => typeof v !== "number")
    ) {
      return null;
    }
    if (arrLen == null) arrLen = k.value.length;
    else if (arrLen !== k.value.length) return null;
  }
  if (sawNumber) return "scalar";
  return arrLen === 2 || arrLen === 3 || arrLen === 4
    ? (arrLen as 2 | 3 | 4)
    : null;
}

// Scalar VIEW of one component of a vec lane.
function componentViewBlock(
  block: KeyframeAnimationBlock,
  c: number
): KeyframeAnimationBlock {
  return {
    ...block,
    keyframes: block.keyframes.map((k) => ({
      ...k,
      value: Array.isArray(k.value) ? ((k.value[c] as number) ?? 0) : 0,
      [VEC_SOURCE]: k.value,
    })),
  };
}

// Merge an edited component view back into vec keyframes. The view is
// authoritative for ticks / count / order / easing; each key's OTHER
// components come from its ridden-along source array, or — for keys the
// editor inserted (no source) — from sampling the real curve at that
// tick, so an insert pins the curve instead of zeroing the other axes.
// (Exported for offline testing only.)
export function mergeComponentEdit(
  view: KeyframeAnimationBlock,
  c: number,
  count: number,
  real: KeyframeAnimationBlock | undefined
): KeyframeAnimationBlock {
  const vecType = count === 2 ? "vec2" : count === 3 ? "vec3" : "vec4";
  const sample = (tick: number): number[] => {
    if (real && real.keyframes.length > 0) {
      const v = evaluateKeyframesAt({ ...real, animated: true }, vecType, tick);
      if (Array.isArray(v)) return (v as number[]).slice();
    }
    return new Array(count).fill(0);
  };
  const keyframes = view.keyframes.map((k) => {
    const { [VEC_SOURCE]: source, ...rest } = k as ViewKeyframe;
    const base = Array.isArray(source)
      ? (source as number[]).slice()
      : sample(k.tick);
    while (base.length < count) base.push(0);
    base.length = count;
    base[c] = k.value as number;
    return { ...rest, value: base };
  });
  return { ...view, keyframes };
}

let savedEasingSeq = 0;
function newSavedEasingId(): string {
  savedEasingSeq += 1;
  return `ease-${Date.now().toString(36)}-${savedEasingSeq}`;
}

// Implicit cubic-bezier control points for the *legacy* named presets
// that still have a clean two-handle representation. Other presets
// (sine, expo, back, bounce, elastic, etc.) are drawn by sampling
// easeOf() into a polyline because they aren't a single cubic.
const PRESET_CTRL: Partial<
  Record<EasingPreset, { p1: [number, number]; p2: [number, number] }>
> = {
  linear: { p1: [0, 0], p2: [1, 1] },
  easeIn: { p1: [0.42, 0], p2: [1, 1] },
  easeOut: { p1: [0, 0], p2: [0.58, 1] },
  easeInOut: { p1: [0.42, 0], p2: [0.58, 1] },
  easeInQuad: { p1: [0.42, 0], p2: [1, 1] },
  easeOutQuad: { p1: [0, 0], p2: [0.58, 1] },
  easeInOutQuad: { p1: [0.42, 0], p2: [0.58, 1] },
  easeInCubic: { p1: [0.55, 0.055], p2: [0.675, 0.19] },
  easeOutCubic: { p1: [0.215, 0.61], p2: [0.355, 1] },
  easeInOutCubic: { p1: [0.645, 0.045], p2: [0.355, 1] },
  easeInSine: { p1: [0.47, 0], p2: [0.745, 0.715] },
  easeOutSine: { p1: [0.39, 0.575], p2: [0.565, 1] },
  easeInOutSine: { p1: [0.445, 0.05], p2: [0.55, 0.95] },
};

// ---------------------------------------------------------------------
// Drag state machine
// ---------------------------------------------------------------------

// One selected key's gesture-start snapshot: exact data (tick/value —
// cancel restores write these back verbatim) plus its screen position
// under the mapping its track had when the gesture began.
interface StartPoint {
  tick: number;
  value: number;
  sx: number;
  sy: number;
}
// trackKey → key index → snapshot, across every track with selection.
type MultiStarts = Map<string, Map<number, StartPoint>>;

type DragState =
  | { kind: "none" }
  | {
      kind: "point";
      group: number[];
      startMouseX: number;
      startMouseY: number;
      starts: Map<number, { tick: number; value: number }>;
      // Present when the selection spans other tracks too — the move
      // then runs through the unified screen-space transform path
      // instead of the single-track patchMany.
      multiStarts?: MultiStarts;
    }
  | {
      kind: "handle";
      keyIdx: number;
      side: "left" | "right";
      startMouseX: number;
      startMouseY: number;
      startHandle: { dx: number; dy: number };
    }
  | {
      kind: "pan";
      startMouseX: number;
      startMouseY: number;
      startView: {
        viewTickOffset: number;
        pixelsPerTick: number;
        yMinView: number;
        yMaxView: number;
      };
    }
  | { kind: "scrub" }
  | {
      kind: "marquee";
      startX: number;
      startY: number;
      curX: number;
      curY: number;
      // Selection to union the box hits into (the prior selection when
      // shift-dragging; empty otherwise).
      base: Set<number>;
      // Same, for the non-active tracks' selections.
      baseExtra: Map<string, Set<number>>;
    }
  | {
      // Drag a handle of the multi-select transform box → scale the
      // selection in screen space around the opposite edge/corner.
      kind: "boxResize";
      handle: BoxHandle;
      anchorX: number; // fixed screen point the scale pivots around
      anchorY: number;
      box: { left: number; right: number; top: number; bottom: number };
      starts: Map<number, { sx: number; sy: number }>;
    };

type BoxHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

// Blender-style keyboard-driven modal transform (G grab / S scale /
// R rotate) with optional X/Y axis constraint (grab/scale only).
// Confirmed by click/Enter, cancelled by Esc/right-click. Updates follow
// the cursor (no button held). Operates on the WHOLE cross-track
// selection: starts snapshot every selected key on every track, the
// transform runs in screen space, and each track inverts through its
// own value mapping.
type ModalTransform =
  | null
  | {
      mode: "grab" | "scale" | "rotate";
      axis: "x" | "y" | null;
      origin: { x: number; y: number }; // cursor when the modal began
      starts: MultiStarts;
      // Screen-space pivot. Scale: playhead in x, selection centroid in
      // y (the playhead line has no y). Rotate: the centroid in both.
      // Grab: unused.
      anchor: { sx: number; sy: number };
    };

// ---------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------

export function GraphEditor({
  nodes,
  timeline,
  onAnimationChange,
  onScrub,
  normalizeY = false,
  refitVersion = 0,
  visibleLanes = [],
  timelineSelection = [],
  savedEasings = [],
  onSaveEasing,
}: GraphEditorProps) {
  // Clock read from the playback store (clock-store spec, step 3) — this
  // editor re-renders per frame by design (playhead line).
  const currentTick = useClock((s) => s.tick);
  // Collect the graphable tracks among `visibleLanes` — the lanes of the
  // keyframes selected in the Tracks / Layers editor. Scalar lanes graph
  // directly; vec2/3/4 lanes expand into one per-component X/Y/Z/W view
  // track each (componentViewBlock), edited through a merge-back in
  // onChange below. Colors / splines / step-only types stay ungraphed.
  const visibleTracks = useMemo(() => {
    const wanted = new Set(
      visibleLanes.map((l) => `${l.nodeId}|${l.paramName}`)
    );
    const out: VisibleTrack[] = [];
    for (const n of nodes) {
      const anim = n.data?.animation;
      if (!anim) continue;
      const def = getNodeDef(n.data.defType);
      for (const [pname, b] of Object.entries(anim)) {
        if (!b || !b.animated || !wanted.has(`${n.id}|${pname}`)) continue;
        const pdef = def?.params.find((p) => p.name === pname);
        // Virtual per-layer opacity keys (merge node) have no param def
        // but are plain 0..1 scalars — graph them like one.
        if (!pdef && pname.startsWith(LAYER_OPACITY_PREFIX)) {
          const layerId = pname.slice(LAYER_OPACITY_PREFIX.length);
          const layersRaw = n.data.params?.layers;
          const idx = Array.isArray(layersRaw)
            ? layersRaw.findIndex(
                (l) => (l as { id?: string } | null)?.id === layerId
              )
            : -1;
          out.push({
            key: `${n.id}|${pname}`,
            nodeId: n.id,
            paramName: pname,
            label: `${n.data.name} · ${
              idx >= 0 ? `layer ${idx + 1} opacity` : "layer opacity"
            }`,
            block: b,
            yMin: 0,
            yMax: 1,
          });
          continue;
        }
        if (!pdef) {
          // Virtual tracks — per-anchor spline vec2s (anchor_p/in/out:<id>),
          // gradient-point and ramp-stop scalars, etc. — have no param
          // def, so infer the curve shape from the values themselves:
          // all numbers → scalar, all same-length number arrays →
          // per-component views. Anything else (colors as objects,
          // strings) stays ungraphed. This is what puts marquee-selected
          // anchor keyframes on the graph.
          const shape = inferValueShape(b.keyframes);
          if (shape === "scalar") {
            out.push({
              key: `${n.id}|${pname}`,
              nodeId: n.id,
              paramName: pname,
              label: `${n.data.name} · ${pname}`,
              block: b,
            });
          } else if (shape) {
            for (let c = 0; c < shape; c++) {
              out.push({
                key: `${n.id}|${pname}|${c}`,
                nodeId: n.id,
                paramName: pname,
                component: c,
                componentCount: shape,
                label: `${n.data.name} · ${pname} · ${VEC_COMPONENT_LABELS[c]}`,
                block: componentViewBlock(b, c),
              });
            }
          }
          continue;
        }
        if (pdef.type === "scalar") {
          out.push({
            key: `${n.id}|${pname}`,
            nodeId: n.id,
            paramName: pname,
            label: `${n.data.name} · ${pdef.label ?? pname}`,
            block: b,
            yMin: pdef.min,
            yMax: pdef.max,
          });
          continue;
        }
        const count = VEC_COMPONENT_COUNT[pdef.type];
        if (count) {
          for (let c = 0; c < count; c++) {
            out.push({
              key: `${n.id}|${pname}|${c}`,
              nodeId: n.id,
              paramName: pname,
              component: c,
              componentCount: count,
              label: `${n.data.name} · ${pdef.label ?? pname} · ${
                VEC_COMPONENT_LABELS[c]
              }`,
              block: componentViewBlock(b, c),
              yMin: pdef.min,
              yMax: pdef.max,
            });
          }
        }
      }
    }
    return out;
  }, [nodes, visibleLanes]);

  const [activeKey, setActiveKey] = useState<string | null>(null);
  // Auto-select the first visible track when the prior selection
  // disappears (track unticked, node deleted, etc.).
  useEffect(() => {
    if (visibleTracks.length === 0) {
      if (activeKey !== null) setActiveKey(null);
      return;
    }
    if (!visibleTracks.some((t) => t.key === activeKey)) {
      setActiveKey(visibleTracks[0].key);
    }
  }, [visibleTracks, activeKey]);

  const active =
    visibleTracks.find((t) => t.key === activeKey) ?? visibleTracks[0];

  // NOTE: every hook below must run unconditionally — `active` can flip to
  // undefined mid-session (last track unticked, or a re-render during a
  // modal transform), and an early return here would change the hook count
  // and crash React. So we derive null-safe values and defer the "no
  // curves" message to the render at the very end (after all hooks).
  const block = active?.block ?? emptyAnimationBlock();
  const paramLabel = active?.label ?? "";
  const yMin = active?.yMin;
  const yMax = active?.yMax;
  // On a per-component view track, every edit merges back into the real
  // vec block: the view's scalar value lands in its component, the other
  // components ride along on the hidden source array (or, for inserted
  // keys, sample the real curve at that tick so the insert pins it).
  const onChange = active
    ? (next: KeyframeAnimationBlock) =>
        onAnimationChange(
          active.nodeId,
          active.paramName,
          active.component == null
            ? next
            : mergeComponentEdit(
                next,
                active.component,
                active.componentCount ?? 2,
                nodes.find((n) => n.id === active.nodeId)?.data?.animation?.[
                  active.paramName
                ]
              )
        )
    : () => {};
  const trackPicker =
    visibleTracks.length > 1 ? (
      <select
        value={active?.key ?? ""}
        onChange={(e) => setActiveKey(e.target.value)}
        style={{
          background: "var(--tb-n-3)",
          color: TEXT,
          border: `1px solid ${BORDER}`,
          borderRadius: 2,
          padding: "1px 4px",
          fontSize: 11,
          marginLeft: 8,
        }}
      >
        {visibleTracks.map((t) => (
          <option key={t.key} value={t.key}>
            {t.label}
          </option>
        ))}
      </select>
    ) : null;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [width, setWidth] = useState(800);
  // Measured container height so the plot fills the vertical space the dock
  // gives it (rather than a fixed HEIGHT). Falls back to HEIGHT pre-measure.
  const [height, setHeight] = useState(HEIGHT);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [drag, setDrag] = useState<DragState>({ kind: "none" });
  // Modal G/S transform (keyboard-driven).
  const [modal, setModal] = useState<ModalTransform>(null);
  // Last cursor position within the SVG (for the hover line + as the
  // origin when a modal transform begins).
  const cursorRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  // Axis lock latched when shift is first held mid-drag (keyframe/handle).
  const shiftAxisRef = useRef<"x" | "y" | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [contextMenu, setContextMenu] = useState<
    | {
        clientX: number;
        clientY: number;
        keyIdx: number;
        sub: null | "easing";
      }
    | null
  >(null);

  // Live snapshot for handlers (avoids stale closures inside listeners).
  const blockRef = useRef(block);
  blockRef.current = block;

  // ----- View transform (local) -----
  const initialBounds = useMemo(() => computeFitBounds(block, yMin, yMax), []);
  const [viewTickOffset, setViewTickOffset] = useState(
    initialBounds.viewTickOffset
  );
  const [pixelsPerTick, setPixelsPerTick] = useState(
    initialBounds.pixelsPerTick
  );
  const [yMinView, setYMinView] = useState(initialBounds.yMinView);
  const [yMaxView, setYMaxView] = useState(initialBounds.yMaxView);

  const innerW = Math.max(40, width - PADDING.left - PADDING.right);
  const innerH = Math.max(40, height - HEADER_H - PADDING.top - PADDING.bottom);

  // Selected keys on NON-active tracks (trackKey → view-key indices).
  // The active track's selection stays in `selected`, so every
  // single-track path keeps working; cross-track gestures union the
  // two. Stale trackKeys (lane left the selection) no-op harmlessly.
  const [extraSel, setExtraSel] = useState<Map<string, Set<number>>>(
    () => new Map()
  );
  const extraCount = useMemo(() => {
    let n = 0;
    for (const s of extraSel.values()) n += s.size;
    return n;
  }, [extraSel]);

  // Re-fit y bounds when the active track changes, when normalize is
  // toggled, when refresh is clicked, or when the param's declared
  // bounds change. With normalize off and a declared range, use that;
  // otherwise auto-fit to keyframe extents.
  //
  // Lifted-selection seed, folded in so the two can't fight over the
  // view: the FIRST time a lane becomes active, adopt the timeline
  // selection across EVERY visible lane — the active lane's keys become
  // the graph selection (view fitted to them, not the whole track), the
  // other lanes' keys become the cross-track extras — so a timeline
  // marquee lands in the graph fully selected and G/S/R-ready. After
  // that the default refit behavior applies.
  const seededForRef = useRef<string | null>(null);
  useEffect(() => {
    if (active && seededForRef.current !== active.key) {
      seededForRef.current = active.key;
      // Selected ticks per lane. A component view adopts its vec lane's
      // ticks — a timeline diamond is the whole vec keyframe.
      const byLane = new Map<string, Set<number>>();
      for (const s of timelineSelection) {
        const lk = `${s.nodeId}|${s.paramName}`;
        let set = byLane.get(lk);
        if (!set) {
          set = new Set();
          byLane.set(lk, set);
        }
        set.add(s.tick);
      }
      const indicesFor = (t: VisibleTrack): Set<number> => {
        const ticks = byLane.get(`${t.nodeId}|${t.paramName}`);
        const set = new Set<number>();
        if (ticks) {
          t.block.keyframes.forEach((k, i) => {
            if (ticks.has(k.tick)) set.add(i);
          });
        }
        return set;
      };
      const extras = new Map<string, Set<number>>();
      for (const t of visibleTracks) {
        if (t.key === active.key) continue;
        const set = indicesFor(t);
        if (set.size > 0) extras.set(t.key, set);
      }
      setExtraSel(extras);
      const sel = indicesFor(active);
      if (sel.size > 0) {
        setSelected(sel);
        const fit = computeFitBoundsFromKeys(
          active.block.keyframes.filter((_, i) => sel.has(i)),
          innerW,
          yMin,
          yMax
        );
        setViewTickOffset(fit.viewTickOffset);
        setPixelsPerTick(fit.pixelsPerTick);
        setYMinView(fit.yMinView);
        setYMaxView(fit.yMaxView);
        return;
      }
    }
    if (!normalizeY && yMin != null && yMax != null) {
      setYMinView(yMin);
      setYMaxView(yMax);
      return;
    }
    const fit = computeFitBoundsFromKeys(block.keyframes, innerW);
    setYMinView(fit.yMinView);
    setYMaxView(fit.yMaxView);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.key, normalizeY, refitVersion, yMin, yMax]);

  // ----- Width tracking -----
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setWidth(el.clientWidth);
      setHeight(el.clientHeight);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);


  // ----- Coordinate helpers -----
  const tickToScreen = useCallback(
    (t: number) => PADDING.left + (t - viewTickOffset) * pixelsPerTick,
    [viewTickOffset, pixelsPerTick]
  );
  const valueToScreen = useCallback(
    (v: number) => {
      const span = yMaxView - yMinView;
      const norm = span !== 0 ? (v - yMinView) / span : 0.5;
      return PADDING.top + (1 - norm) * innerH;
    },
    [yMinView, yMaxView, innerH]
  );
  const screenToTick = useCallback(
    (sx: number) => viewTickOffset + (sx - PADDING.left) / pixelsPerTick,
    [viewTickOffset, pixelsPerTick]
  );
  const screenToValue = useCallback(
    (sy: number) => {
      const span = yMaxView - yMinView;
      const norm = 1 - (sy - PADDING.top) / innerH;
      return yMinView + norm * span;
    },
    [yMinView, yMaxView, innerH]
  );

  // ----- Multi-track editing -----
  // Per-track screen mappings: the active track through the live axis,
  // every other through its own auto-fit (position and opacity rarely
  // share units). One source for ghost drawing, cross-track hit-testing,
  // marquee and transforms.
  const trackViews = useMemo(() => {
    return visibleTracks.map((t) => {
      if (t.key === active?.key) {
        return {
          track: t,
          isActive: true,
          yFor: valueToScreen,
          yInv: screenToValue,
        };
      }
      const fit = computeFitBoundsFromKeys(t.block.keyframes, innerW, t.yMin, t.yMax);
      const span = fit.yMaxView - fit.yMinView || 1;
      return {
        track: t,
        isActive: false,
        yFor: (v: number) =>
          PADDING.top + (1 - (v - fit.yMinView) / span) * innerH,
        yInv: (sy: number) =>
          fit.yMinView + (1 - (sy - PADDING.top) / innerH) * span,
      };
    });
  }, [visibleTracks, active?.key, valueToScreen, screenToValue, innerW, innerH]);

  // Live mirrors for gesture handlers — a mid-drag commit re-renders and
  // the drag effect's closures go stale; refs keep commits aimed at the
  // fresh blocks. Assigned in an effect (not render) for the hooks lint.
  const trackViewsRef = useRef(trackViews);
  const graphNodesRef = useRef(nodes);
  const extraSelRef = useRef(extraSel);
  useEffect(() => {
    trackViewsRef.current = trackViews;
    graphNodesRef.current = nodes;
    extraSelRef.current = extraSel;
  });

  function getMousePos(e: React.MouseEvent | MouseEvent | React.PointerEvent | PointerEvent) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ----- Hit testing -----
  function pointAt(sx: number, sy: number): number | null {
    const ks = blockRef.current.keyframes;
    for (let i = 0; i < ks.length; i++) {
      const px = tickToScreen(ks[i].tick);
      const py = valueToScreen(ks[i].value as number);
      if (Math.hypot(px - sx, py - sy) <= POINT_HIT) return i;
    }
    return null;
  }
  function handleAt(
    sx: number,
    sy: number
  ): { keyIdx: number; side: "left" | "right" } | null {
    const ks = blockRef.current.keyframes;
    for (const i of selected) {
      const k = ks[i];
      if (!k) continue;
      // Right handle is editable when this key's outgoing easing is custom.
      if (i < ks.length - 1 && k.easingOut === "customBezier") {
        const h =
          k.bezierHandles?.rightHandle ?? defaultRightHandle(ks, i);
        const hx = tickToScreen(k.tick + h.dx);
        const hy = valueToScreen((k.value as number) + h.dy);
        if (Math.hypot(hx - sx, hy - sy) <= HANDLE_HIT)
          return { keyIdx: i, side: "right" };
      }
      // Left handle is editable when the PREVIOUS key's outgoing easing
      // is custom (this key receives the incoming custom segment).
      const prev = ks[i - 1];
      if (i > 0 && prev && prev.easingOut === "customBezier") {
        const h =
          k.bezierHandles?.leftHandle ?? defaultLeftHandle(ks, i);
        const hx = tickToScreen(k.tick + h.dx);
        const hy = valueToScreen((k.value as number) + h.dy);
        if (Math.hypot(hx - sx, hy - sy) <= HANDLE_HIT)
          return { keyIdx: i, side: "left" };
      }
    }
    return null;
  }

  // Hit-test a keyframe on ANY visible track (active first, so its keys
  // win ties with overlapping ghosts).
  function pointAtAnyTrack(
    sx: number,
    sy: number
  ): { trackKey: string; idx: number; isActive: boolean } | null {
    const views = trackViewsRef.current;
    const ordered = [...views].sort(
      (a, b) => Number(b.isActive) - Number(a.isActive)
    );
    for (const v of ordered) {
      const ks = v.track.block.keyframes;
      for (let i = 0; i < ks.length; i++) {
        const px = tickToScreen(ks[i].tick);
        const py = v.yFor(ks[i].value as number);
        if (Math.hypot(px - sx, py - sy) <= POINT_HIT) {
          return { trackKey: v.track.key, idx: i, isActive: v.isActive };
        }
      }
    }
    return null;
  }

  // Gesture-start snapshot of every selected key on every track: exact
  // tick/value (cancel restores) + screen position under each track's
  // current mapping. `activeIndices` overrides the active track's set
  // for gestures that adjust the selection in the same event.
  function snapshotMultiStarts(
    activeIndices: Iterable<number> = selected
  ): MultiStarts {
    const out: MultiStarts = new Map();
    const add = (trackKey: string, indices: Iterable<number>) => {
      const v = trackViewsRef.current.find((tv) => tv.track.key === trackKey);
      if (!v) return;
      const m = new Map<number, StartPoint>();
      for (const i of indices) {
        const k = v.track.block.keyframes[i];
        if (!k) continue;
        m.set(i, {
          tick: k.tick,
          value: k.value as number,
          sx: tickToScreen(k.tick),
          sy: v.yFor(k.value as number),
        });
      }
      if (m.size > 0) out.set(trackKey, m);
    };
    if (active) add(active.key, activeIndices);
    for (const [tkey, set] of extraSelRef.current) {
      if (tkey !== active?.key) add(tkey, set);
    }
    return out;
  }

  // Commit per-track keyframe patches. Scalar lanes write through their
  // own block; component views of the same vec param are grouped into
  // ONE write built from the real block, so simultaneous X/Y edits can't
  // clobber each other (two merges of the same param would be
  // last-writer-wins).
  function commitMultiTrackPatches(
    patches: Map<string, Map<number, Partial<Keyframe>>>
  ) {
    const groups = new Map<
      string,
      {
        nodeId: string;
        paramName: string;
        entries: { track: VisibleTrack; m: Map<number, Partial<Keyframe>> }[];
      }
    >();
    for (const [tkey, m] of patches) {
      if (m.size === 0) continue;
      const v = trackViewsRef.current.find((tv) => tv.track.key === tkey);
      if (!v) continue;
      const t = v.track;
      const gk = `${t.nodeId}|${t.paramName}`;
      let g = groups.get(gk);
      if (!g) {
        g = { nodeId: t.nodeId, paramName: t.paramName, entries: [] };
        groups.set(gk, g);
      }
      g.entries.push({ track: t, m });
    }
    for (const g of groups.values()) {
      const first = g.entries[0].track;
      if (first.component == null) {
        // Plain scalar lane — its view block IS the real block.
        const block = first.block;
        const next = block.keyframes
          .map((k, i) => {
            const p = g.entries[0].m.get(i);
            return p ? { ...k, ...p } : k;
          })
          .sort((a, b) => a.tick - b.tick);
        onAnimationChange(g.nodeId, g.paramName, {
          ...block,
          keyframes: next,
        });
        continue;
      }
      // Component views — patch the REAL vec block by original index
      // (component view blocks are 1:1 and order-preserving).
      const real = graphNodesRef.current.find((n) => n.id === g.nodeId)?.data
        ?.animation?.[g.paramName];
      if (!real) continue;
      const count = first.componentCount ?? 2;
      const next = real.keyframes
        .map((k, i) => {
          let tick = k.tick;
          const value = Array.isArray(k.value)
            ? (k.value as number[]).slice()
            : new Array<number>(count).fill(0);
          let changed = false;
          for (const { track, m } of g.entries) {
            const p = m.get(i);
            if (!p) continue;
            changed = true;
            if (p.tick != null) tick = p.tick;
            if (typeof p.value === "number" && track.component != null) {
              value[track.component] = p.value;
            }
          }
          return changed ? { ...k, tick, value } : k;
        })
        .sort((a, b) => a.tick - b.tick);
      onAnimationChange(g.nodeId, g.paramName, { ...real, keyframes: next });
    }
  }

  // Apply a screen-space point transform to every snapshotted key and
  // commit — each track inverts y through its own mapping, x through the
  // shared time axis.
  function applyScreenTransform(
    starts: MultiStarts,
    mapPoint: (sx: number, sy: number) => [number, number]
  ) {
    const tpf = timeline.ticksPerFrame;
    const patches = new Map<string, Map<number, Partial<Keyframe>>>();
    for (const [tkey, keyStarts] of starts) {
      const v = trackViewsRef.current.find((tv) => tv.track.key === tkey);
      if (!v) continue;
      const m = new Map<number, Partial<Keyframe>>();
      for (const [i, s] of keyStarts) {
        const [nx, ny] = mapPoint(s.sx, s.sy);
        m.set(i, {
          tick: snapTickToFrame(Math.round(screenToTick(nx)), tpf),
          value: v.yInv(ny),
        });
      }
      patches.set(tkey, m);
    }
    commitMultiTrackPatches(patches);
  }

  // Cancel restore: write every snapshotted key's exact original
  // tick/value back.
  function restoreMultiStarts(starts: MultiStarts) {
    const patches = new Map<string, Map<number, Partial<Keyframe>>>();
    for (const [tkey, keyStarts] of starts) {
      const m = new Map<number, Partial<Keyframe>>();
      for (const [i, s] of keyStarts) m.set(i, { tick: s.tick, value: s.value });
      patches.set(tkey, m);
    }
    commitMultiTrackPatches(patches);
  }

  // Delete the whole cross-track selection. On a vec param, a key
  // selected on ANY component view deletes the whole vec keyframe (one
  // point in time across components).
  function deleteSelectedMulti() {
    const sel = new Map<string, Set<number>>();
    if (active && selected.size > 0) sel.set(active.key, new Set(selected));
    for (const [tkey, set] of extraSelRef.current) {
      if (tkey !== active?.key && set.size > 0) sel.set(tkey, new Set(set));
    }
    if (sel.size === 0) return;
    const groups = new Map<
      string,
      { nodeId: string; paramName: string; isComponent: boolean; drop: Set<number> }
    >();
    for (const [tkey, set] of sel) {
      const v = trackViewsRef.current.find((tv) => tv.track.key === tkey);
      if (!v) continue;
      const t = v.track;
      const gk = `${t.nodeId}|${t.paramName}`;
      let g = groups.get(gk);
      if (!g) {
        g = {
          nodeId: t.nodeId,
          paramName: t.paramName,
          isComponent: t.component != null,
          drop: new Set<number>(),
        };
        groups.set(gk, g);
      }
      for (const i of set) g.drop.add(i);
    }
    for (const g of groups.values()) {
      const block = g.isComponent
        ? graphNodesRef.current.find((n) => n.id === g.nodeId)?.data
            ?.animation?.[g.paramName]
        : trackViewsRef.current.find(
            (tv) =>
              tv.track.nodeId === g.nodeId &&
              tv.track.paramName === g.paramName
          )?.track.block;
      if (!block) continue;
      onAnimationChange(g.nodeId, g.paramName, {
        ...block,
        keyframes: block.keyframes.filter((_, i) => !g.drop.has(i)),
      });
    }
    setSelected(new Set());
    setExtraSel(new Map());
  }

  // ----- Mutation primitives -----
  const commit = useCallback(
    (next: KeyframeAnimationBlock) => onChange(next),
    [onChange]
  );

  function patchKeyframe(idx: number, patch: Partial<Keyframe>) {
    const ks = blockRef.current.keyframes.slice();
    if (!ks[idx]) return;
    ks[idx] = { ...ks[idx], ...patch };
    // Re-sort if tick changed.
    if (patch.tick != null) ks.sort((a, b) => a.tick - b.tick);
    commit({ ...blockRef.current, keyframes: ks });
  }

  function patchMany(updates: Map<number, Partial<Keyframe>>) {
    let ks = blockRef.current.keyframes.map((k, i) => {
      const p = updates.get(i);
      return p ? { ...k, ...p } : k;
    });
    ks = ks.slice().sort((a, b) => a.tick - b.tick);
    commit({ ...blockRef.current, keyframes: ks });
  }

  function deleteKeyframes(indices: Set<number>) {
    const ks = blockRef.current.keyframes.filter((_, i) => !indices.has(i));
    commit({ ...blockRef.current, keyframes: ks });
  }

  function insertKeyframeAt(tick: number, value: number) {
    const ks = blockRef.current.keyframes;
    const newKf: Keyframe = { tick, value, easingOut: "easeInOut" };
    let insertAt = ks.findIndex((k) => k.tick > tick);
    if (insertAt < 0) insertAt = ks.length;
    const next = [...ks.slice(0, insertAt), newKf, ...ks.slice(insertAt)];
    commit({ ...blockRef.current, keyframes: next });
    return insertAt;
  }

  // Apply a saved easing to every selected key's outgoing segment: the
  // key gets customBezier + the denormalized right handle, and the NEXT
  // key (selected or not) gets the matching left handle — that pair is
  // what interpolate() reads for the segment. A key that is both a
  // segment start and the previous segment's end accumulates both edits.
  function applySavedEasing(s: SavedEasing) {
    const ksLocal = blockRef.current.keyframes;
    const handles = new Map<number, BezierHandles>();
    const workingHandles = (i: number): BezierHandles => {
      let h = handles.get(i);
      if (!h) {
        h = {
          ...(ksLocal[i].bezierHandles ?? defaultBezierHandles(ksLocal, i)),
        };
        handles.set(i, h);
      }
      return h;
    };
    const starts = new Set<number>();
    for (const i of selected) {
      const a = ksLocal[i];
      const b = ksLocal[i + 1];
      if (!a || !b) continue;
      const seg = easingHandlesForSegment(s, a, b);
      workingHandles(i).rightHandle = seg.right;
      workingHandles(i + 1).leftHandle = seg.left;
      starts.add(i);
    }
    if (starts.size === 0) return;
    const next = new Map<number, Partial<Keyframe>>();
    for (const [i, bezierHandles] of handles) {
      next.set(
        i,
        starts.has(i)
          ? { easingOut: "customBezier", bezierHandles }
          : { bezierHandles }
      );
    }
    patchMany(next);
  }

  // ----- Wheel: 2-finger scroll = pan; Cmd/Ctrl + scroll = zoom -----
  // x-axis controlled by horizontal delta, y-axis by vertical delta.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const dx = e.deltaX || 0;
      const dy = e.deltaY || 0;

      if (wheelWantsZoom(e)) {
        if (getEffectiveDevice() === "mouse") {
          // Mouse wheel = zoom BOTH axes uniformly about the cursor.
          const mag = Math.abs(dx) > Math.abs(dy) ? dx : dy;
          const factor = Math.exp(-mag * 0.0015);
          const anchorTick = screenToTick(mx);
          const newPpt = Math.max(1e-6, pixelsPerTick * factor);
          setPixelsPerTick(newPpt);
          setViewTickOffset(anchorTick - (mx - PADDING.left) / newPpt);
          const anchorVal = screenToValue(my);
          const span = yMaxView - yMinView;
          const newSpan = Math.max(1e-6, span / factor);
          const norm = span !== 0 ? (anchorVal - yMinView) / span : 0.5;
          setYMinView(anchorVal - norm * newSpan);
          setYMaxView(anchorVal - norm * newSpan + newSpan);
          return;
        }
        // Trackpad + Cmd/Ctrl = zoom. Each axis zooms independently
        // based on its delta sign/magnitude, anchored to the cursor.
        if (dx !== 0) {
          const anchorTick = screenToTick(mx);
          const factor = Math.exp(-dx * 0.0015);
          const newPpt = Math.max(1e-6, pixelsPerTick * factor);
          const newOffset = anchorTick - (mx - PADDING.left) / newPpt;
          setPixelsPerTick(newPpt);
          setViewTickOffset(newOffset);
        }
        if (dy !== 0) {
          const anchorVal = screenToValue(my);
          const factor = Math.exp(dy * 0.0015);
          const span = yMaxView - yMinView;
          const newSpan = Math.max(1e-6, span * factor);
          const norm = span !== 0 ? (anchorVal - yMinView) / span : 0.5;
          const newMin = anchorVal - norm * newSpan;
          const newMax = newMin + newSpan;
          setYMinView(newMin);
          setYMaxView(newMax);
        }
        return;
      }

      // Plain (2-finger) scroll = pan. Horizontal delta scrolls in
      // ticks; vertical delta scrolls in value units. Direction
      // matches the gesture (drag right scrolls content right, etc.).
      if (dx !== 0) {
        setViewTickOffset((prev) => prev + dx / pixelsPerTick);
      }
      if (dy !== 0) {
        // Screen-y is flipped relative to value-space (large values at
        // the top). Scrolling down on the trackpad should drag the view
        // down in value space, so the sign on dyVal must be negative.
        const ySpan = yMaxView - yMinView;
        const valuePerPixel = ySpan / Math.max(1, innerH);
        const dyVal = -dy * valuePerPixel;
        setYMinView((prev) => prev + dyVal);
        setYMaxView((prev) => prev + dyVal);
      }
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [
    pixelsPerTick,
    viewTickOffset,
    yMinView,
    yMaxView,
    innerH,
    screenToTick,
    screenToValue,
  ]);

  // Middle-button pointerdown: block the preview canvas's window-level
  // middle-drag (bug #2). Cmd/Ctrl + middle-drag zooms — horizontal movement
  // zooms time (X), vertical zooms value (Y), about the press point. Drag
  // right / up zooms in. Scoped to button 1 so left-button keyframe
  // interactions are untouched.
  //
  // BOTH middle-button gestures live here. This native listener is on the
  // SVG itself while React delegates from the app root, so it runs first and
  // its stopPropagation means the React surface handler never sees button 1.
  // (It used to lean on the compat mousedown reaching React afterwards for
  // the plain-pan case; pointer events have no such second delivery.)
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 1) return;
      e.stopPropagation();
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      // Plain middle-drag = pan.
      if (!(e.metaKey || e.ctrlKey)) {
        setDrag({
          kind: "pan",
          startMouseX: e.clientX - rect.left,
          startMouseY: e.clientY - rect.top,
          startView: { viewTickOffset, pixelsPerTick, yMinView, yMaxView },
        });
        return;
      }
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const startX = e.clientX;
      const startY = e.clientY;
      const startPpt = pixelsPerTick;
      const startMin = yMinView;
      const startMax = yMaxView;
      const anchorTick = screenToTick(mx);
      const anchorVal = screenToValue(my);
      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        // X (time): drag right zooms in (larger pixels-per-tick).
        const newPpt = Math.max(1e-6, startPpt * Math.exp(dx * 0.0015));
        setPixelsPerTick(newPpt);
        setViewTickOffset(anchorTick - (mx - PADDING.left) / newPpt);
        // Y (value): drag up (dy < 0) zooms in (smaller value span).
        const span = startMax - startMin;
        const newSpan = Math.max(1e-6, span * Math.exp(dy * 0.0015));
        const norm = span !== 0 ? (anchorVal - startMin) / span : 0.5;
        setYMinView(anchorVal - norm * newSpan);
        setYMaxView(anchorVal - norm * newSpan + newSpan);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    };
    el.addEventListener("pointerdown", onDown);
    return () => el.removeEventListener("pointerdown", onDown);
    // viewTickOffset joined the list when the plain-pan branch moved in here
    // — the pan snapshots it at press time, so a stale closure would start
    // the drag from the wrong offset.
  }, [
    pixelsPerTick,
    viewTickOffset,
    yMinView,
    yMaxView,
    screenToTick,
    screenToValue,
  ]);

  // ----- Keyboard: space / delete / escape / F -----
  useEffect(() => {
    function startModal(mode: "grab" | "scale" | "rotate") {
      // The whole cross-track selection, snapshotted in screen space.
      const starts = snapshotMultiStarts();
      let n = 0;
      let sxSum = 0;
      let sySum = 0;
      for (const m of starts.values()) {
        for (const s of m.values()) {
          n++;
          sxSum += s.sx;
          sySum += s.sy;
        }
      }
      if (n === 0 || (mode === "rotate" && n < 2)) return;
      setModal({
        mode,
        axis: null,
        origin: { ...cursorRef.current },
        starts,
        // Scale pivots x on the playhead; rotate on the selection's
        // screen centroid (the playhead line has no y).
        anchor:
          mode === "scale"
            ? { sx: tickToScreen(currentTick), sy: sySum / n }
            : { sx: sxSum / n, sy: sySum / n },
      });
    }

    function onDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      const inInput = tag === "input" || tag === "textarea";

      // ----- Modal transform live: capture its controls -----
      if (modal) {
        if (e.key === "Escape") {
          // Cancel — restore the original positions on every track.
          restoreMultiStarts(modal.starts);
          setModal(null);
          e.preventDefault();
          return;
        }
        if (e.key === "Enter") {
          setModal(null); // confirm — positions already committed
          e.preventDefault();
          return;
        }
        if (e.key === "x" || e.key === "X") {
          setModal((m) => (m ? { ...m, axis: m.axis === "x" ? null : "x" } : m));
          e.preventDefault();
          return;
        }
        if (e.key === "y" || e.key === "Y") {
          setModal((m) => (m ? { ...m, axis: m.axis === "y" ? null : "y" } : m));
          e.preventDefault();
          return;
        }
        // Swallow other keys (incl. re-pressing g/s) while modal is live.
        e.preventDefault();
        return;
      }

      // Everything below is contextual to this editor: only react when the
      // last mouse click landed here, so keypresses meant for the node
      // editor (which has its own G-move, Delete, etc.) don't double-fire.
      if (getShortcutScope() !== "graph") return;

      if (e.key === " " && !inInput && !e.shiftKey) {
        // !shiftKey so Shift+Space (the pie menu chord) never starts a pan.
        setSpaceHeld(true);
        e.preventDefault();
      }
      if (e.key === "Escape") {
        setSelected(new Set());
        setExtraSel(new Map());
        setContextMenu(null);
      }
      // Contextual transforms — need a keyframe selection (any track).
      const totalSel = selected.size + extraCount;
      if ((e.key === "g" || e.key === "G") && !inInput && totalSel > 0) {
        e.preventDefault();
        startModal("grab");
        return;
      }
      if ((e.key === "s" || e.key === "S") && !inInput && totalSel > 0) {
        e.preventDefault();
        startModal("scale");
        return;
      }
      // Rotate needs ≥2 keys — a single key rotating about the selection
      // centroid (itself) is a no-op.
      if ((e.key === "r" || e.key === "R") && !inInput && totalSel > 1) {
        e.preventDefault();
        startModal("rotate");
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && !inInput) {
        if (totalSel === 0) return;
        e.preventDefault();
        deleteSelectedMulti();
      }
      if ((e.key === "f" || e.key === "F") && !inInput) {
        const ks = blockRef.current.keyframes;
        const subset =
          selected.size > 0
            ? ks.filter((_, i) => selected.has(i))
            : ks;
        const fit = computeFitBoundsFromKeys(
          subset,
          innerW,
          yMin,
          yMax
        );
        setViewTickOffset(fit.viewTickOffset);
        setPixelsPerTick(fit.pixelsPerTick);
        setYMinView(fit.yMinView);
        setYMaxView(fit.yMaxView);
      }
    }
    function onUp(e: KeyboardEvent) {
      if (e.key === " ") setSpaceHeld(false);
    }
    function onBlur() {
      setSpaceHeld(false);
    }
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [selected, extraCount, active?.key, innerW, yMin, yMax, modal, currentTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // ----- Pointer interactions on the SVG surface -----
  // Pointer, not mouse: iPadOS emits no mousemove stream during a touch or
  // Pencil drag, so a mousedown-rooted gesture never moves.
  function onSurfacePointerDown(e: React.PointerEvent) {
    if (contextMenu) setContextMenu(null);
    // A click while a modal transform is live confirms it (positions are
    // already committed by the modal's move handler).
    if (modal) {
      setModal(null);
      e.preventDefault();
      return;
    }
    // Middle-button never reaches here: the native pointerdown listener
    // above owns both middle gestures and stops propagation.
    if (e.button !== 0) return;
    shiftAxisRef.current = null;
    const { x, y } = getMousePos(e);

    // Space-drag → pan.
    if (spaceHeld) {
      e.preventDefault();
      setDrag({
        kind: "pan",
        startMouseX: x,
        startMouseY: y,
        startView: {
          viewTickOffset,
          pixelsPerTick,
          yMinView,
          yMaxView,
        },
      });
      return;
    }

    // Try handles first (only on selected customBezier keys).
    const hh = handleAt(x, y);
    if (hh) {
      const k = blockRef.current.keyframes[hh.keyIdx];
      if (k) {
        const handle =
          hh.side === "right"
            ? k.bezierHandles?.rightHandle ??
              defaultRightHandle(blockRef.current.keyframes, hh.keyIdx)
            : k.bezierHandles?.leftHandle ??
              defaultLeftHandle(blockRef.current.keyframes, hh.keyIdx);
        setDrag({
          kind: "handle",
          keyIdx: hh.keyIdx,
          side: hh.side,
          startMouseX: x,
          startMouseY: y,
          startHandle: { ...handle },
        });
      }
      return;
    }

    // Then keyframes — on ANY visible track.
    const hit = pointAtAnyTrack(x, y);
    if (hit && !hit.isActive) {
      // A ghost track's key. Shift toggles it into the cross-track
      // selection; a click on an already-selected one drags the whole
      // group; a plain click activates that track (axis, handles and
      // easing dropdown follow) with just that key selected — the next
      // press drags, once the axis has settled.
      if (e.shiftKey) {
        setExtraSel((prev) => {
          const next = new Map(prev);
          const set = new Set(next.get(hit.trackKey) ?? []);
          if (set.has(hit.idx)) set.delete(hit.idx);
          else set.add(hit.idx);
          if (set.size === 0) next.delete(hit.trackKey);
          else next.set(hit.trackKey, set);
          return next;
        });
        return;
      }
      if (extraSel.get(hit.trackKey)?.has(hit.idx)) {
        setDrag({
          kind: "point",
          group: [],
          startMouseX: x,
          startMouseY: y,
          starts: new Map(),
          multiStarts: snapshotMultiStarts(),
        });
        return;
      }
      // Suppress the lifted-selection seed — this activation is an
      // explicit in-graph click, not a lane arriving from the timeline.
      seededForRef.current = hit.trackKey;
      setActiveKey(hit.trackKey);
      setSelected(new Set([hit.idx]));
      setExtraSel(new Map());
      return;
    }
    const ph = hit ? hit.idx : null;
    if (ph !== null) {
      let nextSel: Set<number>;
      let keepExtras = extraCount > 0;
      if (e.shiftKey) {
        nextSel = new Set(selected);
        if (nextSel.has(ph)) nextSel.delete(ph);
        else nextSel.add(ph);
      } else if (selected.has(ph)) {
        nextSel = new Set(selected);
      } else {
        // Replacement click — the cross-track extras drop too.
        nextSel = new Set([ph]);
        if (keepExtras) setExtraSel(new Map());
        keepExtras = false;
      }
      setSelected(nextSel);
      const ks = blockRef.current.keyframes;
      const starts = new Map<number, { tick: number; value: number }>();
      for (const i of nextSel)
        starts.set(i, { tick: ks[i].tick, value: ks[i].value as number });
      setDrag({
        kind: "point",
        group: [...nextSel],
        startMouseX: x,
        startMouseY: y,
        starts,
        multiStarts: keepExtras ? snapshotMultiStarts(nextSel) : undefined,
      });
      return;
    }

    // Ruler band (top strip) → scrub the playhead, keeping selection.
    if (y < PADDING.top) {
      const tickAt = screenToTick(x);
      const snapped = e.shiftKey
        ? Math.round(tickAt)
        : snapTickToFrame(Math.round(tickAt), timeline.ticksPerFrame);
      onScrub(snapped);
      setDrag({ kind: "scrub" });
      return;
    }

    // Empty plot body → box-select. Shift keeps the current selection as a
    // base to add to; a bare click (no drag) clears it (handled on mouse-up).
    setDrag({
      kind: "marquee",
      startX: x,
      startY: y,
      curX: x,
      curY: y,
      base: e.shiftKey ? new Set(selected) : new Set(),
      baseExtra: e.shiftKey
        ? new Map([...extraSel].map(([k, s]) => [k, new Set(s)]))
        : new Map(),
    });
  }

  function onDoubleClick(e: React.MouseEvent) {
    const { x, y } = getMousePos(e);
    if (pointAt(x, y) !== null) return;
    if (handleAt(x, y) !== null) return;
    const tickAt = screenToTick(x);
    const value = screenToValue(y);
    const snapped = e.shiftKey
      ? Math.round(tickAt)
      : snapTickToFrame(Math.round(tickAt), timeline.ticksPerFrame);
    const newIdx = insertKeyframeAt(snapped, value);
    setSelected(new Set([newIdx]));
    setExtraSel(new Map());
  }

  function onContextMenuHandler(e: React.MouseEvent) {
    // Right-click cancels an in-progress modal transform (Blender style).
    if (modal) {
      e.preventDefault();
      restoreMultiStarts(modal.starts);
      setModal(null);
      return;
    }
    const { x, y } = getMousePos(e);
    const ph = pointAt(x, y);
    if (ph === null) return;
    e.preventDefault();
    if (!selected.has(ph)) {
      setSelected(new Set([ph]));
      setExtraSel(new Map());
    }
    setContextMenu({
      clientX: e.clientX,
      clientY: e.clientY,
      keyIdx: ph,
      sub: null,
    });
  }

  // ----- Window-level move/up so dragging persists out of the SVG -----
  useEffect(() => {
    if (drag.kind === "none") return;
    function onMove(ev: PointerEvent) {
      const { x, y } = getMousePos(ev);
      if (drag.kind === "pan") {
        const sv = drag.startView;
        const dxPx = x - drag.startMouseX;
        const dyPx = y - drag.startMouseY;
        // Pan x: shift offset opposite to mouse motion, so content tracks.
        setViewTickOffset(sv.viewTickOffset - dxPx / sv.pixelsPerTick);
        // Pan y: positive dyPx (mouse down) increases yMin/yMax (view shifts down).
        const ySpan = sv.yMaxView - sv.yMinView;
        const dyVal = (dyPx / innerH) * ySpan;
        setYMinView(sv.yMinView + dyVal);
        setYMaxView(sv.yMaxView + dyVal);
        return;
      }
      if (drag.kind === "scrub") {
        const tickAt = screenToTick(x);
        const snapped = ev.shiftKey
          ? Math.round(tickAt)
          : snapTickToFrame(Math.round(tickAt), timeline.ticksPerFrame);
        onScrub(snapped);
        return;
      }
      if (drag.kind === "marquee") {
        const minX = Math.min(drag.startX, x);
        const maxX = Math.max(drag.startX, x);
        const minY = Math.min(drag.startY, y);
        const maxY = Math.max(drag.startY, y);
        // Box-select across EVERY visible track, each through its own
        // y mapping.
        const hits = new Set(drag.base);
        const extraHits = new Map(
          [...drag.baseExtra].map(([k, s]) => [k, new Set(s)])
        );
        for (const v of trackViewsRef.current) {
          const mks = v.track.block.keyframes;
          for (let i = 0; i < mks.length; i++) {
            const px = tickToScreen(mks[i].tick);
            const py = v.yFor(mks[i].value as number);
            if (px >= minX && px <= maxX && py >= minY && py <= maxY) {
              if (v.isActive) {
                hits.add(i);
              } else {
                const set = extraHits.get(v.track.key) ?? new Set<number>();
                set.add(i);
                extraHits.set(v.track.key, set);
              }
            }
          }
        }
        setSelected(hits);
        setExtraSel(extraHits);
        setDrag({ ...drag, curX: x, curY: y });
        return;
      }
      if (drag.kind === "point") {
        let dxPx = x - drag.startMouseX;
        let dyPx = y - drag.startMouseY;
        // Shift = constrain to the initial dominant direction (latched on
        // first shift-held move so it doesn't flip mid-drag).
        if (ev.shiftKey) {
          if (!shiftAxisRef.current) {
            shiftAxisRef.current =
              Math.abs(dxPx) >= Math.abs(dyPx) ? "x" : "y";
          }
          if (shiftAxisRef.current === "x") dyPx = 0;
          else dxPx = 0;
        } else {
          shiftAxisRef.current = null;
        }
        // Cross-track selection → unified screen-space path.
        if (drag.multiStarts) {
          applyScreenTransform(drag.multiStarts, (sx, sy) => [
            sx + dxPx,
            sy + dyPx,
          ]);
          return;
        }
        const dTickRaw = dxPx / pixelsPerTick;
        const ySpan = yMaxView - yMinView;
        const dValue = -(dyPx / innerH) * ySpan;
        const tpf = timeline.ticksPerFrame;
        const updates = new Map<number, Partial<Keyframe>>();
        for (const i of drag.group) {
          const start = drag.starts.get(i);
          if (!start) continue;
          const newTick = snapTickToFrame(
            Math.round(start.tick + dTickRaw),
            tpf
          );
          updates.set(i, {
            tick: newTick,
            value: start.value + dValue,
          });
        }
        patchMany(updates);
        return;
      }
      if (drag.kind === "boxResize") {
        const { box, anchorX, anchorY } = drag;
        const spanX = box.right - box.left;
        const spanY = box.bottom - box.top;
        const movesX = drag.handle.includes("e") || drag.handle.includes("w");
        const movesY = drag.handle.includes("n") || drag.handle.includes("s");
        const fx = movesX && spanX !== 0 ? (x - anchorX) / (drag.handle.includes("e") ? spanX : -spanX) : 1;
        const fy = movesY && spanY !== 0 ? (y - anchorY) / (drag.handle.includes("s") ? spanY : -spanY) : 1;
        const updates = new Map<number, Partial<Keyframe>>();
        for (const [i, s] of drag.starts) {
          const nsx = anchorX + (s.sx - anchorX) * fx;
          const nsy = anchorY + (s.sy - anchorY) * fy;
          updates.set(i, {
            tick: snapTickToFrame(
              Math.round(screenToTick(nsx)),
              timeline.ticksPerFrame
            ),
            value: screenToValue(nsy),
          });
        }
        patchMany(updates);
        return;
      }
      if (drag.kind === "handle") {
        let dxPx = x - drag.startMouseX;
        let dyPx = y - drag.startMouseY;
        if (ev.shiftKey) {
          if (!shiftAxisRef.current) {
            shiftAxisRef.current =
              Math.abs(dxPx) >= Math.abs(dyPx) ? "x" : "y";
          }
          if (shiftAxisRef.current === "x") dyPx = 0;
          else dxPx = 0;
        } else {
          shiftAxisRef.current = null;
        }
        const dTick = dxPx / pixelsPerTick;
        const ySpan = yMaxView - yMinView;
        const dValue = -(dyPx / innerH) * ySpan;
        const k = blockRef.current.keyframes[drag.keyIdx];
        if (!k) return;
        const newDx = drag.startHandle.dx + dTick;
        const newDy = drag.startHandle.dy + dValue;
        let leftHandle: { dx: number; dy: number };
        let rightHandle: { dx: number; dy: number };
        if (drag.side === "right") {
          rightHandle = { dx: newDx, dy: newDy };
          // v1: always mirror the opposite handle.
          leftHandle = { dx: -newDx, dy: -newDy };
        } else {
          leftHandle = { dx: newDx, dy: newDy };
          rightHandle = { dx: -newDx, dy: -newDy };
        }
        // Both sides store on `bezierHandles` because the data model
        // holds them together — readers consult them only when the
        // adjacent segment is customBezier.
        patchKeyframe(drag.keyIdx, {
          bezierHandles: { leftHandle, rightHandle },
        });
        return;
      }
    }
    function onUp() {
      if (drag.kind === "marquee") {
        const moved =
          Math.abs(drag.curX - drag.startX) > 3 ||
          Math.abs(drag.curY - drag.startY) > 3;
        // Bare click on empty space (no drag, no shift) clears selection.
        if (!moved && drag.base.size === 0) {
          setSelected(new Set());
          setExtraSel(new Map());
        }
      }
      setDrag({ kind: "none" });
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    // iPadOS swaps pointerup for pointercancel whenever the system claims
    // the gesture; without this the drag state machine stays latched.
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [
    drag,
    innerH,
    pixelsPerTick,
    yMaxView,
    yMinView,
    timeline.ticksPerFrame,
    onScrub,
    screenToTick,
    screenToValue,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  // ----- Modal G/S/R transform: follow the cursor, apply continuously -----
  // One screen-space point map per mode, applied to the whole
  // cross-track starts snapshot; each track inverts through its own
  // value mapping (applyScreenTransform).
  useEffect(() => {
    if (!modal) return;
    const apply = (cur: { x: number; y: number }) => {
      let mapPoint: (sx: number, sy: number) => [number, number];
      if (modal.mode === "grab") {
        let dxPx = cur.x - modal.origin.x;
        let dyPx = cur.y - modal.origin.y;
        if (modal.axis === "x") dyPx = 0;
        else if (modal.axis === "y") dxPx = 0;
        mapPoint = (sx, sy) => [sx + dxPx, sy + dyPx];
      } else if (modal.mode === "rotate") {
        // Rotate around the selection's screen centroid — the only
        // space where an angle means anything (x is ticks, y is value
        // units; view zoom decides their relative weight, exactly as
        // the user sees it).
        const { sx: px, sy: py } = modal.anchor;
        const a0 = Math.atan2(modal.origin.y - py, modal.origin.x - px);
        const a1 = Math.atan2(cur.y - py, cur.x - px);
        const cos = Math.cos(a1 - a0);
        const sin = Math.sin(a1 - a0);
        mapPoint = (sx, sy) => {
          const rx = sx - px;
          const ry = sy - py;
          return [px + rx * cos - ry * sin, py + rx * sin + ry * cos];
        };
      } else {
        // Scale around the playhead (x) / selection centroid (y).
        const { sx: ax, sy: ay } = modal.anchor;
        const dx0 = modal.origin.x - ax;
        const dy0 = modal.origin.y - ay;
        let fx = dx0 !== 0 ? (cur.x - ax) / dx0 : 1;
        let fy = dy0 !== 0 ? (cur.y - ay) / dy0 : 1;
        if (modal.axis === "x") fy = 1;
        else if (modal.axis === "y") fx = 1;
        else {
          const d0 = Math.hypot(dx0, dy0);
          const d1 = Math.hypot(cur.x - ax, cur.y - ay);
          const f = d0 !== 0 ? d1 / d0 : 1;
          fx = f;
          fy = f;
        }
        mapPoint = (sx, sy) => [ax + (sx - ax) * fx, ay + (sy - ay) * fy];
      }
      applyScreenTransform(modal.starts, mapPoint);
    };
    // Re-apply right away so axis-toggles update without needing a move.
    apply(cursorRef.current);
    const onMove = (ev: PointerEvent) => {
      cursorRef.current = getMousePos(ev);
      apply(cursorRef.current);
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal, pixelsPerTick, innerH, yMaxView, yMinView, timeline.ticksPerFrame]);

  // ---------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------

  const ks = block.keyframes;

  // Build the active curve's path (shared builder — the ghost curves of
  // the other visible tracks use it too, with their own y mapping).
  const pathSegments = useMemo(
    () => buildCurvePathSegments(ks, tickToScreen, valueToScreen),
    [ks, tickToScreen, valueToScreen]
  );

  const pathD = pathSegments.join(" ");

  // The other visible tracks' curves, drawn behind the active one so a
  // cross-track selection reads (and edits) as one picture. Shared time
  // axis; each track keeps its own value fit (tracks rarely share units
  // — position vs opacity — so a shared y-axis would flatten most of
  // them into lines). Their keyframes render as real diamonds and light
  // up when in the cross-track selection.
  const ghostCurves = useMemo(() => {
    const out: {
      key: string;
      d: string;
      color: string;
      keys: { x: number; y: number; sel: boolean }[];
    }[] = [];
    if (trackViews.length < 2) return out;
    trackViews.forEach((v, idx) => {
      if (v.isActive) return;
      const gks = v.track.block.keyframes;
      if (gks.length === 0) return;
      const selSet = extraSel.get(v.track.key);
      out.push({
        key: v.track.key,
        d: buildCurvePathSegments(gks, tickToScreen, v.yFor).join(" "),
        color: GHOST_CURVE_COLORS[idx % GHOST_CURVE_COLORS.length],
        keys: gks.map((k, i) => ({
          x: tickToScreen(k.tick),
          y: v.yFor(k.value as number),
          sel: selSet?.has(i) ?? false,
        })),
      });
    });
    return out;
  }, [trackViews, tickToScreen, extraSel]);

  // Grid lines.
  const yTicks = useMemo(
    () => makeNiceTicks(yMinView, yMaxView, 5),
    [yMinView, yMaxView]
  );
  const xTicks = useMemo(() => {
    const tpf = timeline.ticksPerFrame;
    const startTick = viewTickOffset;
    const endTick = viewTickOffset + innerW / pixelsPerTick;
    const startFrame = startTick / tpf;
    const endFrame = endTick / tpf;
    const ticks = makeNiceTicks(startFrame, endFrame, 8);
    return ticks.map((f) => ({ frame: f, tick: framesToTicks(f, tpf) }));
  }, [timeline.ticksPerFrame, viewTickOffset, pixelsPerTick, innerW]);

  // Playhead screen x.
  const playheadX = tickToScreen(currentTick);
  const playheadVisible =
    playheadX >= PADDING.left && playheadX <= PADDING.left + innerW;

  // Selected key — for the easing dropdown and ghost handle previews.
  const firstSelected =
    selected.size > 0
      ? ks[Math.min(...Array.from(selected))]
      : undefined;

  // Custom bezier (handle shaping + saved easings) is scalar-only: on a
  // vec lane's per-component view, evaluation runs through easeOf() and
  // ignores handles, so offering the option would draw a curve that
  // doesn't play. Gates the dropdown option, the Saved group, the Save
  // button, and the context menu tile.
  const componentView = active?.component != null;

  // What the header's Save button would capture: the first selected
  // key's outgoing custom curve, or null when there's nothing saveable
  // (preset easing, no following key) — which disables the button.
  const saveableEasing =
    selected.size > 0 && !componentView
      ? normalizedEasingFromSegment(ks, Math.min(...Array.from(selected)))
      : null;

  // Screen-space bounding box of the selection — drives the multi-select
  // transform box (shown for 2+ keyframes). Recomputed live so it tracks
  // the keyframes while they're being scaled.
  const BOX_MARGIN = 7;
  const selBox = (() => {
    if (selected.size < 2) return null;
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    for (const i of selected) {
      const k = ks[i];
      if (!k) continue;
      const sx = tickToScreen(k.tick);
      const sy = valueToScreen(k.value as number);
      left = Math.min(left, sx);
      right = Math.max(right, sx);
      top = Math.min(top, sy);
      bottom = Math.max(bottom, sy);
    }
    if (!isFinite(left)) return null;
    return {
      left: left - BOX_MARGIN,
      right: right + BOX_MARGIN,
      top: top - BOX_MARGIN,
      bottom: bottom + BOX_MARGIN,
    };
  })();

  // Begin a box-resize drag from one of the transform-box handles.
  function startBoxResize(
    e: React.PointerEvent,
    handle: BoxHandle,
    box: { left: number; right: number; top: number; bottom: number }
  ) {
    e.stopPropagation();
    e.preventDefault();
    const starts = new Map<number, { sx: number; sy: number }>();
    for (const i of selected) {
      const k = blockRef.current.keyframes[i];
      if (!k) continue;
      starts.set(i, {
        sx: tickToScreen(k.tick),
        sy: valueToScreen(k.value as number),
      });
    }
    const anchorX = handle.includes("w") ? box.right : box.left;
    const anchorY = handle.includes("n") ? box.bottom : box.top;
    setDrag({ kind: "boxResize", handle, anchorX, anchorY, box, starts });
  }

  // Safe to return conditionally here — every hook has already run above.
  if (!active) {
    return (
      <div
        style={{
          height: "100%",
          background: BG,
          color: MUTED,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 12,
          fontFamily: "var(--ui-font)",
          padding: 16,
          textAlign: "center",
        }}
      >
        {visibleLanes.length > 0
          ? "The selected tracks can't be graphed — colors, splines and " +
            "step params have no curve. Select keyframes on scalar or " +
            "vector tracks instead."
          : "No curves to show. Select keyframes in the Tracks or Layers " +
            "editor and their curves appear here."}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      data-shortcut-scope="graph"
      style={{
        width: "100%",
        height: "100%",
        minHeight: 0,
        background: BG,
        border: `1px solid ${BORDER}`,
        borderRadius: 4,
        position: "relative",
        userSelect: "none",
        fontFamily: "var(--ui-font)",
        fontSize: 10,
        color: TEXT,
        // tabIndex below exists only to capture keyboard shortcuts; the
        // browser's focus ring around a whole editor pane reads as a
        // stray blue box on the panel.
        outline: "none",
        cursor: spaceHeld ? "grab" : drag.kind === "pan" ? "grabbing" : "default",
      }}
      tabIndex={0}
    >
      {/* Header */}
      <div
        style={{
          height: HEADER_H,
          background: PANEL,
          borderBottom: `1px solid ${BORDER}`,
          display: "flex",
          alignItems: "center",
          padding: "0 8px",
          gap: 8,
          fontSize: 11,
        }}
      >
        <span style={{ color: TEXT, flex: "0 0 auto" }}>
          Graph: <span style={{ color: ACCENT }}>{paramLabel}</span>
        </span>
        <div style={{ flex: 1 }} />
        {selected.size > 0 && firstSelected && (
          <>
            <select
              value={firstSelected.easingOut}
              onChange={(e) => {
                const v = e.target.value;
                // "saved:<id>" options — apply the saved curve's handles.
                // The controlled value stays firstSelected.easingOut, which
                // lands on "customBezier" once the patch commits.
                if (v.startsWith(SAVED_EASING_VALUE_PREFIX)) {
                  const s = savedEasings.find(
                    (x) => SAVED_EASING_VALUE_PREFIX + x.id === v
                  );
                  if (s) applySavedEasing(s);
                  return;
                }
                const preset = v as EasingPreset;
                const next = new Map<number, Partial<Keyframe>>();
                const ksLocal = blockRef.current.keyframes;
                for (const i of selected) {
                  const k = ksLocal[i];
                  if (!k) continue;
                  let bezierHandles = k.bezierHandles;
                  if (preset === "customBezier") {
                    bezierHandles =
                      bezierHandles ?? defaultBezierHandles(ksLocal, i);
                  } else {
                    bezierHandles = undefined;
                  }
                  next.set(i, { easingOut: preset, bezierHandles });
                }
                patchMany(next);
              }}
              style={{
                background: BG,
                color: TEXT,
                border: `1px solid ${BORDER}`,
                borderRadius: 3,
                padding: "1px 4px",
                fontSize: 11,
                fontFamily: "var(--ui-font)",
              }}
            >
              {EASING_PRESETS.filter(
                (p) => !componentView || p.id !== "customBezier"
              ).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
              {!componentView && savedEasings.length > 0 && (
                <optgroup label="Saved">
                  {savedEasings.map((s) => (
                    <option
                      key={s.id}
                      value={SAVED_EASING_VALUE_PREFIX + s.id}
                    >
                      {s.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            {onSaveEasing && !componentView && (
              <SaveEasingButton
                canSave={saveableEasing != null}
                onSave={(name) => {
                  // Re-read at commit time — the popover can outlive edits.
                  const shape = normalizedEasingFromSegment(
                    blockRef.current.keyframes,
                    Math.min(...Array.from(selected))
                  );
                  if (!shape) return;
                  onSaveEasing({ id: newSavedEasingId(), name, ...shape });
                }}
              />
            )}
          </>
        )}
        {trackPicker}
      </div>

      {/* Plot SVG */}
      <svg
        ref={svgRef}
        width={width}
        height={height - HEADER_H}
        style={{
          display: "block",
          // The plot owns every gesture on it (scrub, marquee, key drags),
          // so opt out of browser panning rather than lose the stream.
          touchAction: "none",
        }}
        onPointerDown={onSurfacePointerDown}
        onMouseMove={(e) => {
          const p = getMousePos(e);
          cursorRef.current = p;
          setHover(p);
        }}
        onMouseLeave={() => setHover(null)}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenuHandler}
      >
        {/* Plot background */}
        <rect
          x={PADDING.left}
          y={PADDING.top}
          width={innerW}
          height={innerH}
          fill="var(--tb-n-1)"
          stroke={BORDER}
        />

        {/* Y gridlines + labels */}
        {yTicks.map((y, i) => {
          const sy = valueToScreen(y);
          if (sy < PADDING.top || sy > PADDING.top + innerH) return null;
          return (
            <g key={`gy-${i}`}>
              <line
                x1={PADDING.left}
                y1={sy}
                x2={PADDING.left + innerW}
                y2={sy}
                stroke={BORDER}
                strokeDasharray="2 3"
                opacity={0.6}
              />
              <text
                x={PADDING.left - 6}
                y={sy + 3}
                textAnchor="end"
                fill={MUTED}
                fontSize={10}
              >
                {formatTickLabel(y)}
              </text>
            </g>
          );
        })}

        {/* X gridlines + top ruler ticks / frame labels */}
        {xTicks.map(({ frame, tick }, i) => {
          const sx = tickToScreen(tick);
          if (sx < PADDING.left || sx > PADDING.left + innerW) return null;
          const seconds = frame / Math.max(1, timeline.fps);
          return (
            <g key={`gx-${i}`}>
              <line
                x1={sx}
                y1={PADDING.top}
                x2={sx}
                y2={PADDING.top + innerH}
                stroke={BORDER}
                strokeDasharray="2 3"
                opacity={0.6}
              />
              {/* Ruler tick + label in the band above the plot. */}
              <line
                x1={sx}
                y1={PADDING.top - 6}
                x2={sx}
                y2={PADDING.top}
                stroke={MUTED}
                strokeWidth={1}
              />
              <text x={sx + 3} y={PADDING.top - 8} fill={MUTED} fontSize={9}>
                {`${frame}f${seconds >= 1 ? ` ${seconds.toFixed(1)}s` : ""}`}
              </text>
            </g>
          );
        })}

        {/* The other tracks of a cross-track selection, behind the
            active curve — fully selectable/editable: click a diamond to
            activate the track, shift-click to build a cross-track
            selection, marquee/G/S/R/drag/delete work across all. */}
        {ghostCurves.map((g) => (
          <g key={g.key} pointerEvents="none">
            <path
              d={g.d}
              fill="none"
              stroke={g.color}
              strokeWidth={1}
              opacity={0.55}
            />
            {g.keys.map((p, i) => (
              <rect
                key={i}
                x={p.x - (p.sel ? 4.5 : 3.5)}
                y={p.y - (p.sel ? 4.5 : 3.5)}
                width={p.sel ? 9 : 7}
                height={p.sel ? 9 : 7}
                transform={`rotate(45 ${p.x} ${p.y})`}
                fill={p.sel ? ACCENT : g.color}
                stroke={p.sel ? "#fff" : "none"}
                opacity={p.sel ? 1 : 0.75}
              />
            ))}
          </g>
        ))}

        {/* Curve */}
        {pathD && (
          <path d={pathD} fill="none" stroke={CURVE} strokeWidth={1.5} />
        )}

        {/* Bezier handle arms — for selected keys whose adjacent segment
            uses customBezier (live) or named easing (read-only ghost). */}
        {[...selected].map((i) => {
          const k = ks[i];
          if (!k) return null;
          const sx = tickToScreen(k.tick);
          const sy = valueToScreen(k.value as number);
          const arms: React.ReactNode[] = [];
          const prev = ks[i - 1];

          // Left handle (incoming segment owned by prev).
          if (prev) {
            if (prev.easingOut === "customBezier") {
              const h =
                k.bezierHandles?.leftHandle ?? defaultLeftHandle(ks, i);
              const hx = tickToScreen(k.tick + h.dx);
              const hy = valueToScreen((k.value as number) + h.dy);
              arms.push(
                <g key={`lh-${i}`}>
                  <line x1={sx} y1={sy} x2={hx} y2={hy} stroke={MUTED} />
                  <rect
                    x={hx - 4}
                    y={hy - 4}
                    width={8}
                    height={8}
                    fill={ACCENT}
                    stroke="var(--tb-a-blue-900)"
                    style={{ cursor: "move" }}
                  />
                </g>
              );
            } else if (prev.easingOut !== "hold") {
              // Read-only ghost preview based on preset (mapped from
              // preset-space (x,y) to local handle dx/dy at this key —
              // the LEFT handle is anchored at b end, so it points
              // back from p2 toward b: dx = (p2.x - 1)*span,
              // dy = (p2.y - 1)*(b - a)).
              const ctrl = PRESET_CTRL[prev.easingOut];
              if (!ctrl) {
                // Non-cubic-bezier preset (sine/expo/back/bounce/etc.):
                // skip the ghost handle preview.
              } else {
              const span = k.tick - prev.tick;
              const dv = (k.value as number) - (prev.value as number);
              const dx = (ctrl.p2[0] - 1) * span;
              const dy = (ctrl.p2[1] - 1) * dv;
              const hx = tickToScreen(k.tick + dx);
              const hy = valueToScreen((k.value as number) + dy);
              arms.push(
                <g key={`lh-ghost-${i}`} opacity={0.3}>
                  <line
                    x1={sx}
                    y1={sy}
                    x2={hx}
                    y2={hy}
                    stroke={MUTED}
                    strokeDasharray="2 2"
                  />
                  <rect
                    x={hx - 3}
                    y={hy - 3}
                    width={6}
                    height={6}
                    fill="none"
                    stroke={MUTED}
                  />
                </g>
              );
              }
            }
          }

          // Right handle (outgoing segment owned by this key).
          const next = ks[i + 1];
          if (next) {
            if (k.easingOut === "customBezier") {
              const h =
                k.bezierHandles?.rightHandle ?? defaultRightHandle(ks, i);
              const hx = tickToScreen(k.tick + h.dx);
              const hy = valueToScreen((k.value as number) + h.dy);
              arms.push(
                <g key={`rh-${i}`}>
                  <line x1={sx} y1={sy} x2={hx} y2={hy} stroke={MUTED} />
                  <rect
                    x={hx - 4}
                    y={hy - 4}
                    width={8}
                    height={8}
                    fill={ACCENT}
                    stroke="var(--tb-a-blue-900)"
                    style={{ cursor: "move" }}
                  />
                </g>
              );
            } else if (k.easingOut !== "hold") {
              const ctrl = PRESET_CTRL[k.easingOut];
              if (ctrl) {
              const span = next.tick - k.tick;
              const dv = (next.value as number) - (k.value as number);
              const dx = ctrl.p1[0] * span;
              const dy = ctrl.p1[1] * dv;
              const hx = tickToScreen(k.tick + dx);
              const hy = valueToScreen((k.value as number) + dy);
              arms.push(
                <g key={`rh-ghost-${i}`} opacity={0.3}>
                  <line
                    x1={sx}
                    y1={sy}
                    x2={hx}
                    y2={hy}
                    stroke={MUTED}
                    strokeDasharray="2 2"
                  />
                  <rect
                    x={hx - 3}
                    y={hy - 3}
                    width={6}
                    height={6}
                    fill="none"
                    stroke={MUTED}
                  />
                </g>
              );
              }
            }
          }
          return <g key={`harms-${i}`}>{arms}</g>;
        })}

        {/* Keyframe dots */}
        {ks.map((k, i) => {
          const sx = tickToScreen(k.tick);
          const sy = valueToScreen(k.value as number);
          const isSel = selected.has(i);
          return (
            <g key={`pt-${i}`}>
              {isSel && (
                <circle
                  cx={sx}
                  cy={sy}
                  r={8}
                  fill={ACCENT}
                  opacity={0.18}
                />
              )}
              <circle
                cx={sx}
                cy={sy}
                r={isSel ? 5 : 4}
                fill={isSel ? ACCENT : BG}
                stroke={isSel ? ACCENT : CURVE}
                strokeWidth={1.5}
                style={{ cursor: "move" }}
              />
            </g>
          );
        })}

        {/* Marquee box-select */}
        {drag.kind === "marquee" && (
          <rect
            x={Math.min(drag.startX, drag.curX)}
            y={Math.min(drag.startY, drag.curY)}
            width={Math.abs(drag.curX - drag.startX)}
            height={Math.abs(drag.curY - drag.startY)}
            fill="color-mix(in srgb, var(--tb-a-blue-500) 12%, transparent)"
            stroke={ACCENT}
            strokeDasharray="3 3"
            pointerEvents="none"
          />
        )}

        {/* Hover preview — faded playhead line tracking the cursor. */}
        {hover &&
          drag.kind === "none" &&
          !modal &&
          hover.x >= PADDING.left &&
          hover.x <= PADDING.left + innerW && (
            <line
              x1={hover.x}
              y1={PADDING.top - RULER_H}
              x2={hover.x}
              y2={PADDING.top + innerH}
              stroke={ACCENT}
              strokeWidth={1}
              opacity={0.22}
              pointerEvents="none"
            />
          )}

        {/* Multi-select transform box (2+ keyframes) with resize handles. */}
        {selBox &&
          (() => {
            const cx = (selBox.left + selBox.right) / 2;
            const cy = (selBox.top + selBox.bottom) / 2;
            const handles: {
              key: BoxHandle;
              x: number;
              y: number;
              cursor: string;
            }[] = [
              { key: "nw", x: selBox.left, y: selBox.top, cursor: "nwse-resize" },
              { key: "ne", x: selBox.right, y: selBox.top, cursor: "nesw-resize" },
              { key: "sw", x: selBox.left, y: selBox.bottom, cursor: "nesw-resize" },
              { key: "se", x: selBox.right, y: selBox.bottom, cursor: "nwse-resize" },
              { key: "n", x: cx, y: selBox.top, cursor: "ns-resize" },
              { key: "s", x: cx, y: selBox.bottom, cursor: "ns-resize" },
              { key: "w", x: selBox.left, y: cy, cursor: "ew-resize" },
              { key: "e", x: selBox.right, y: cy, cursor: "ew-resize" },
            ];
            return (
              <g>
                <rect
                  x={selBox.left}
                  y={selBox.top}
                  width={selBox.right - selBox.left}
                  height={selBox.bottom - selBox.top}
                  fill="none"
                  stroke={ACCENT}
                  strokeDasharray="3 3"
                  opacity={0.7}
                  pointerEvents="none"
                />
                {handles.map((h) => (
                  <rect
                    key={h.key}
                    x={h.x - 4}
                    y={h.y - 4}
                    width={8}
                    height={8}
                    fill={BG}
                    stroke={ACCENT}
                    strokeWidth={1.5}
                    style={{ cursor: h.cursor }}
                    onPointerDown={(e) => startBoxResize(e, h.key, selBox)}
                  />
                ))}
              </g>
            );
          })()}

        {/* Modal transform axis guide (X = red horizontal, Y = green vertical). */}
        {modal &&
          modal.axis &&
          (modal.axis === "x" ? (
            <line
              x1={PADDING.left}
              y1={cursorRef.current.y}
              x2={PADDING.left + innerW}
              y2={cursorRef.current.y}
              stroke="var(--tb-a-red-500)"
              strokeWidth={1}
              strokeDasharray="4 3"
              opacity={0.5}
              pointerEvents="none"
            />
          ) : (
            <line
              x1={cursorRef.current.x}
              y1={PADDING.top - RULER_H}
              x2={cursorRef.current.x}
              y2={PADDING.top + innerH}
              stroke="var(--tb-a-green-500)"
              strokeWidth={1}
              strokeDasharray="4 3"
              opacity={0.5}
              pointerEvents="none"
            />
          ))}

        {/* Playhead — extends up through the ruler band, with a draggable
            triangle handle at the top for legibility. */}
        {playheadVisible && (
          <g>
            <line
              x1={playheadX}
              y1={PADDING.top - RULER_H}
              x2={playheadX}
              y2={PADDING.top + innerH}
              stroke={ACCENT}
              strokeWidth={1}
              opacity={0.85}
            />
            <path
              d={`M ${playheadX - 5} ${PADDING.top - RULER_H} L ${playheadX + 5} ${PADDING.top - RULER_H} L ${playheadX} ${PADDING.top - RULER_H + 7} Z`}
              fill={ACCENT}
              style={{ cursor: "ew-resize" }}
              onPointerDown={(e) => {
                e.stopPropagation();
                setDrag({ kind: "scrub" });
              }}
            />
          </g>
        )}
      </svg>

      {/* Status footer */}
      <div
        style={{
          position: "absolute",
          left: 8,
          bottom: 4,
          color: MUTED,
          pointerEvents: "none",
          fontSize: 10,
        }}
      >
        {ks.length} kf · {selected.size} sel · frame{" "}
        {ticksToFrames(currentTick, timeline.ticksPerFrame).toFixed(2)}
      </div>

      {/* Modal transform hint — mode + active axis constraint. */}
      {modal && (
        <div
          style={{
            position: "absolute",
            right: 8,
            bottom: 4,
            color: ACCENT,
            pointerEvents: "none",
            fontSize: 10,
            letterSpacing: 0.5,
          }}
        >
          {modal.mode === "grab"
            ? "GRAB"
            : modal.mode === "rotate"
              ? "ROTATE"
              : "SCALE"}
          {modal.axis ? ` ${modal.axis.toUpperCase()}` : ""} · click/↵ confirm ·
          esc cancel
        </div>
      )}

      {contextMenu && (
        <KeyframeContextMenu
          clientX={contextMenu.clientX}
          clientY={contextMenu.clientY}
          keyframe={ks[contextMenu.keyIdx]}
          sub={contextMenu.sub}
          onSubmenu={(sub) =>
            setContextMenu({ ...contextMenu, sub })
          }
          hideCustomBezier={componentView}
          onPickEasing={(preset) => {
            // Scalar-only guard (see componentView above).
            if (componentView && preset === "customBezier") return;
            // Apply to all selected keys (so power-users can change a group).
            const updates = new Map<number, Partial<Keyframe>>();
            const ksLocal = blockRef.current.keyframes;
            const targets = selected.size > 0
              ? Array.from(selected)
              : [contextMenu.keyIdx];
            for (const i of targets) {
              const k = ksLocal[i];
              if (!k) continue;
              let bezierHandles = k.bezierHandles;
              if (preset === "customBezier") {
                bezierHandles =
                  bezierHandles ?? defaultBezierHandles(ksLocal, i);
              } else {
                bezierHandles = undefined;
              }
              updates.set(i, { easingOut: preset, bezierHandles });
            }
            patchMany(updates);
            setContextMenu(null);
          }}
          onDelete={() => {
            const targets = selected.size > 0
              ? selected
              : new Set([contextMenu.keyIdx]);
            deleteKeyframes(targets);
            setSelected(new Set());
            setContextMenu(null);
          }}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Save-easing button + naming popover
// ---------------------------------------------------------------------

// "Save" button beside the easing dropdown. Click opens a small fixed
// popover right above the button (below when the header sits too close
// to the viewport top) with a name field; Enter or the Save button
// commits via `onSave`, Escape / click-outside dismisses. Disabled until
// the selection has a saveable custom curve.
function SaveEasingButton({
  canSave,
  onSave,
}: {
  canSave: boolean;
  onSave: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [anchor, setAnchor] = useState<{
    left: number;
    top: number;
    below: boolean;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return;
    // Above the button per the header's position at the top of the dock
    // panel; flip below when a popped-out window leaves no headroom.
    const below = r.top < 80;
    setAnchor({
      left: r.left,
      top: below ? r.bottom + 6 : r.top - 6,
      below,
    });
    setName("");
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (target.closest("[data-save-easing]")) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const commit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSave(trimmed);
    setOpen(false);
  };

  return (
    <div ref={rootRef} data-save-easing style={{ position: "relative" }}>
      <button
        type="button"
        disabled={!canSave}
        title={
          canSave
            ? "Save this curve as a named easing (this project)"
            : "Select a Custom Bezier keyframe (with a following keyframe) to save its curve"
        }
        onClick={toggle}
        style={{
          background: open ? PANEL : BG,
          color: canSave ? TEXT : MUTED,
          border: `1px solid ${BORDER}`,
          borderRadius: 3,
          padding: "1px 6px",
          fontSize: 11,
          fontFamily: "var(--ui-font)",
          cursor: canSave ? "pointer" : "default",
        }}
      >
        Save
      </button>
      {open && anchor && (
        <div
          data-save-easing
          style={{
            position: "fixed",
            left: anchor.left,
            top: anchor.top,
            transform: anchor.below ? undefined : "translateY(-100%)",
            zIndex: 1000,
            background: PANEL,
            border: `1px solid ${BORDER}`,
            borderRadius: 4,
            boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
            padding: 8,
            width: 180,
          }}
        >
          <div
            style={{
              color: MUTED,
              fontSize: 9,
              textTransform: "uppercase",
              letterSpacing: 1,
              marginBottom: 6,
            }}
          >
            Save easing
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              autoFocus
              type="text"
              value={name}
              placeholder="Name"
              spellCheck={false}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
              }}
              style={{
                flex: 1,
                minWidth: 0,
                background: BG,
                border: `1px solid ${BORDER}`,
                color: TEXT,
                fontFamily: "var(--ui-font)",
                fontSize: 11,
                padding: "3px 6px",
                borderRadius: 3,
                boxSizing: "border-box",
                outline: "none",
              }}
            />
            <button
              type="button"
              onClick={commit}
              disabled={name.trim().length === 0}
              style={{
                background: "var(--tb-a-navy-deep)",
                border: "1px solid var(--tb-a-navy-tint)",
                color:
                  name.trim().length === 0
                    ? MUTED
                    : "var(--tb-a-blue-200)",
                borderRadius: 3,
                fontFamily: "var(--ui-font)",
                fontSize: 10,
                padding: "0 8px",
                cursor: name.trim().length === 0 ? "default" : "pointer",
              }}
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------

interface ContextMenuProps {
  clientX: number;
  clientY: number;
  keyframe: Keyframe | undefined;
  sub: null | "easing";
  onSubmenu: (sub: null | "easing") => void;
  onPickEasing: (preset: EasingPreset) => void;
  onDelete: () => void;
  onClose: () => void;
  // True on a vec lane's per-component view — custom bezier is
  // scalar-only, so its tile is dropped from the easing grid.
  hideCustomBezier?: boolean;
}

function KeyframeContextMenu({
  clientX,
  clientY,
  keyframe,
  sub,
  onSubmenu,
  onPickEasing,
  onDelete,
  onClose,
  hideCustomBezier = false,
}: ContextMenuProps) {
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (target.closest("[data-graph-menu]")) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  if (!keyframe) return null;

  const itemStyle: React.CSSProperties = {
    padding: "5px 10px",
    cursor: "pointer",
    fontSize: 11,
    color: TEXT,
    fontFamily: "var(--ui-font)",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  };

  return (
    <div
      data-graph-menu
      style={{
        position: "fixed",
        left: clientX,
        top: clientY,
        background: PANEL,
        border: `1px solid ${BORDER}`,
        borderRadius: 4,
        boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
        minWidth: 180,
        zIndex: 1000,
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {sub === "easing" && (
        <div style={{ padding: 6 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(6, 36px)",
              gap: 4,
            }}
          >
            {EASING_PRESETS.filter(
              (p) => !hideCustomBezier || p.id !== "customBezier"
            ).map((p) => (
              <EasingTile
                key={p.id}
                preset={p.id}
                size={36}
                disabled={false}
                label={p.label}
                active={keyframe.easingOut === p.id}
                onClick={() => onPickEasing(p.id)}
              />
            ))}
          </div>
          <div style={{ height: 1, background: BORDER, margin: "6px 0 2px" }} />
          <div
            style={itemStyle}
            onClick={() => onSubmenu(null)}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = BORDER)
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
          >
            ← Back
          </div>
        </div>
      )}
      {sub === null && (
        <>
          <div
            style={itemStyle}
            onClick={() => onSubmenu("easing")}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = BORDER)
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
          >
            <span>Set easing</span>
            <span>›</span>
          </div>
          <div style={{ height: 1, background: BORDER, margin: "2px 0" }} />
          <div
            style={itemStyle}
            onClick={onDelete}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = "var(--tb-t-red-d-0)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
          >
            Delete keyframe
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Pure helpers (no hooks; safe to call from render and handlers)
// ---------------------------------------------------------------------

// Both delegate to the engine's defaultSegmentHandles so the drawn
// defaults and the evaluated ones can never drift apart again.
function defaultRightHandle(
  ks: Keyframe[],
  i: number
): { dx: number; dy: number } {
  const a = ks[i];
  const b = ks[i + 1];
  if (!b) return { dx: 0, dy: 0 };
  return defaultSegmentHandles(a, b).right;
}

function defaultLeftHandle(
  ks: Keyframe[],
  i: number
): { dx: number; dy: number } {
  const a = ks[i - 1];
  const b = ks[i];
  if (!a) return { dx: 0, dy: 0 };
  return defaultSegmentHandles(a, b).left;
}

function defaultBezierHandles(ks: Keyframe[], i: number): BezierHandles {
  return {
    rightHandle: defaultRightHandle(ks, i),
    leftHandle: defaultLeftHandle(ks, i),
  };
}

// Normalize key `i`'s outgoing customBezier segment into segment-relative
// control points (SavedEasing shape): x as a fraction of the segment's
// duration, y of its value delta. Missing handles fall back to the same
// defaults the curve path draws with, so what saves is what the plot
// shows. A flat segment (Δvalue ≈ 0) normalizes dy against 1 raw value
// unit — a dip on a flat segment has no delta to be relative to.
// Returns null when the segment isn't a saveable custom curve.
// (Exported with easingHandlesForSegment for offline testing only.)
export function normalizedEasingFromSegment(
  ks: Keyframe[],
  i: number
): Pick<SavedEasing, "x1" | "y1" | "x2" | "y2"> | null {
  const a = ks[i];
  const b = ks[i + 1];
  if (!a || !b || a.easingOut !== "customBezier") return null;
  const span = b.tick - a.tick;
  if (!(span > 0)) return null;
  const dv = (b.value as number) - (a.value as number);
  const vd = Math.abs(dv) > 1e-9 ? dv : 1;
  const right = a.bezierHandles?.rightHandle ?? defaultRightHandle(ks, i);
  const left = b.bezierHandles?.leftHandle ?? defaultLeftHandle(ks, i + 1);
  const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
  return {
    x1: clamp01(right.dx / span),
    y1: right.dy / vd,
    x2: clamp01(1 + left.dx / span),
    y2: 1 + left.dy / vd,
  };
}

// Denormalize a saved easing onto the segment a→b: tick/value-unit
// handles for the outgoing key (right) and the incoming key (left).
export function easingHandlesForSegment(
  e: Pick<SavedEasing, "x1" | "y1" | "x2" | "y2">,
  a: Keyframe,
  b: Keyframe
): { right: { dx: number; dy: number }; left: { dx: number; dy: number } } {
  const span = b.tick - a.tick;
  const dv = (b.value as number) - (a.value as number);
  return {
    right: { dx: e.x1 * span, dy: e.y1 * dv },
    left: { dx: (e.x2 - 1) * span, dy: (e.y2 - 1) * dv },
  };
}

interface FitBounds {
  viewTickOffset: number;
  pixelsPerTick: number;
  yMinView: number;
  yMaxView: number;
}

function computeFitBounds(
  block: KeyframeAnimationBlock,
  yMin?: number,
  yMax?: number
): FitBounds {
  // Initial fit before width is known — pick a reasonable default ppt.
  return computeFitBoundsFromKeys(block.keyframes, 600, yMin, yMax);
}

function computeFitBoundsFromKeys(
  ks: Keyframe[],
  innerW: number,
  yMin?: number,
  yMax?: number
): FitBounds {
  if (ks.length === 0) {
    return {
      viewTickOffset: 0,
      pixelsPerTick: 0.01,
      yMinView: yMin ?? 0,
      yMaxView: yMax ?? 1,
    };
  }
  let tMin = ks[0].tick;
  let tMax = ks[ks.length - 1].tick;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const k of ks) {
    const v = k.value as number;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  if (vMin === vMax) {
    vMin -= 1;
    vMax += 1;
  }
  if (tMin === tMax) {
    tMin -= 1000;
    tMax += 1000;
  }
  const tSpan = tMax - tMin;
  const tPad = tSpan * FIT_PAD;
  const vSpan = vMax - vMin;
  const vPad = vSpan * FIT_PAD;
  const fitTickStart = tMin - tPad;
  const fitTickEnd = tMax + tPad;
  const ppt = innerW / Math.max(1, fitTickEnd - fitTickStart);
  return {
    viewTickOffset: fitTickStart,
    pixelsPerTick: ppt,
    yMinView: yMin ?? vMin - vPad,
    yMaxView: yMax ?? vMax + vPad,
  };
}

// Generate roughly `target` "nice" tick values across [lo, hi].
function makeNiceTicks(lo: number, hi: number, target: number): number[] {
  if (!isFinite(lo) || !isFinite(hi) || hi <= lo) return [];
  const span = hi - lo;
  const rough = span / target;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / pow;
  let step: number;
  if (norm < 1.5) step = 1 * pow;
  else if (norm < 3) step = 2 * pow;
  else if (norm < 7) step = 5 * pow;
  else step = 10 * pow;
  const start = Math.ceil(lo / step) * step;
  const out: number[] = [];
  for (let v = start; v <= hi + step * 1e-6; v += step) {
    // Avoid floating-point fuzz creating spurious tick labels like
    // 0.30000000000000004.
    const rounded = Math.round(v / step) * step;
    out.push(rounded);
    if (out.length > 200) break;
  }
  return out;
}

function formatTickLabel(v: number): string {
  if (!isFinite(v)) return "";
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1000 || abs < 0.001) return v.toExponential(1);
  // Choose precision based on magnitude.
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 10) return v.toFixed(1);
  if (abs >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

