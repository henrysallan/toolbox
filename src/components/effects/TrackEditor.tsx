"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import {
  ownerDocument,
  ownerWindow,
  usePanelWindow,
} from "@/components/effects/layout/panel-window";
import type { Edge, Node } from "@xyflow/react";
import type { NodeDataPayload } from "@/state/graph";
import { playbackClock } from "@/state/playback-clock";
import {
  type EasingPreset,
  type KeyframeAnimationBlock,
  type ProjectTimeline,
  EASING_PRESET_ORDER,
  EASING_PRESET_LABELS,
  emptyAnimationBlock,
  evaluateKeyframesAt,
  findKeyframeAt,
  isStepOnly,
  removeKeyframeAt,
  snapTickToFrame,
  upsertKeyframe,
  type Keyframe,
} from "@/engine/keyframes";
import { getNodeDef } from "@/engine/registry";
import { getEffectiveDevice } from "./input-device";
import { GROUP_TYPE } from "@/engine/groups";
import { resolvePromotedParams } from "@/state/graph-ops";
import {
  anchorTrackId,
  LAYER_OPACITY_PREFIX,
  parseRampParamKey,
} from "@/engine/conventions";
import {
  getPublishedAnchorSelection,
  requestAnchorSelection,
  subscribePublishedAnchorSelection,
} from "./spline-anchor-scope";
import {
  type ClipBlock,
  clipSlipsOnInTrim,
  defaultClip,
  isClippable,
  isTimeDrivenClip,
  resolveClipAt,
  splitClipsAt,
} from "@/engine/clips";
import type { ParamType } from "@/engine/types";
import {
  COLOR_ACCENT,
  COLOR_BG,
  COLOR_BORDER,
  COLOR_CLIP_BORDER,
  COLOR_CLIP_BORDER_SELECTED,
  COLOR_CLIP_FILL,
  COLOR_CLIP_FILL_HOVER,
  COLOR_CLIP_FILL_SELECTED,
  COLOR_CLIP_GHOST,
  COLOR_CLIP_GHOST_BORDER,
  COLOR_CLIP_GHOST_BORDER_HOVER,
  COLOR_CLIP_GHOST_HOVER,
  COLOR_CLIP_HANDLE,
  COLOR_CLIP_HANDLE_HOVER,
  COLOR_DIAMOND,
  COLOR_DIAMOND_BORDER,
  COLOR_DIAMOND_HOVER,
  COLOR_DIAMOND_HOVER_BORDER,
  COLOR_DIAMOND_SELECTED_BORDER,
  COLOR_RULER_TEXT,
  COLOR_RULER_TICK,
  COLOR_SEGMENT,
  COLOR_SEGMENT_HOLD,
  COLOR_SEGMENT_HOVER,
  KEY_SIZE,
  SEGMENT_HIT_PX,
  COLOR_GUTTER_BG,
  COLOR_GUTTER_BORDER,
  COLOR_GUTTER_CHEVRON,
  COLOR_GUTTER_TEXT,
  COLOR_GUTTER_TEXT_STRONG,
  COLOR_LANE_SEP,
  COLOR_MUTED,
  COLOR_TEXT,
  GUTTER_RADIUS,
  COLOR_LANE_SELECTED_BG,
  KEY_HIT_PX,
  ANCHOR_HIGHLIGHT_BG,
  ANCHOR_HIGHLIGHT_EDGE,
  SNAP_PROXIMITY_PX,
  CLIP_EDGE_PX,
  MARQUEE_BORDER,
  MARQUEE_FILL,
  RULER_HEIGHT,
  ZOOM_SENSITIVITY,
} from "./timeline/theme";
import { clampPixelsPerTick, useTimelineView } from "./timeline/view";
import {
  type GroupBase,
  type KeyframeOpResult,
  type SelectionKey,
  buildGroupBases,
  keyframeValuesEqual,
  groupSelection,
  laneKey,
  moveKeyframes,
  nextGestureKey,
  scaleKeyframes as scaleKeyframesOp,
  selKey,
  staggerKeyframes as staggerKeyframesOp,
} from "./timeline/keyframe-ops";
import { moveClipWindow, trimClipWindow } from "./timeline/clip-ops";
import { rulerSpacing as computeRulerSpacing } from "./timeline/ruler";
import { LaneFrameTicks, RulerFrameStubs } from "./timeline/FrameTicks";
import { EasingTile } from "./timeline/EasingTile";
import {
  HoverLine,
  type HoverLineHandle,
  PlayheadHandle,
  PlayheadLine,
} from "./timeline/PlayheadChrome";
import { DiamondNav } from "./timeline/DiamondNav";

// ---------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------

export interface TrackEditorProps {
  nodes: Node<NodeDataPayload>[];
  // Full, unscoped graph — used to surface a group's promoted params as
  // lanes (the keyframes live on the deep interior node, which isn't in
  // the scoped `nodes`). Falls back to `nodes` when omitted.
  allNodes?: Node<NodeDataPayload>[];
  edges?: Edge[];
  timeline: ProjectTimeline;

  onScrub(tick: number): void;
  onAnimationChange(
    nodeId: string,
    paramName: string,
    next: KeyframeAnimationBlock | undefined,
    coalesceKey?: string
  ): void;

  // Set/clear a node's timeline clip windows. Called during clip drag
  // (move/trim), on clip creation, and on split. `undefined` (or an empty
  // array) removes all clips from the node.
  onClipChange?(nodeId: string, next: ClipBlock[] | undefined): void;

  collapsedNodeIds?: Set<string>;
  onToggleCollapsed?(nodeId: string): void;
  // Bumped by the parent to trigger "fit scene to width" — the fit button
  // moved up to the dock header.
  fitVersion?: number;
  // Fired when the user clicks a track header or param lane label.
  // EffectsApp wires this to its node-select callback so the
  // corresponding node lights up in the node editor and surfaces in
  // the param panel — the inverse of the "selected only" filter.
  onSelectNode?(nodeId: string): void;
}

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------
// Palette + shared metrics live in ./timeline/theme.ts; only the
// Tracks-specific layout constants stay here.

const NODE_HEADER_HEIGHT = 22;
const INSPECTOR_HEIGHT = 28;
const PARAM_LABEL_WIDTH = 184;
const TRACK_HEIGHT = 28;
// The label gutter is drawn as an inset rounded card floating over the
// lanes. The inset applies on the left, top and bottom — NOT the right,
// where the card's edge IS the gutter/lane boundary. Deliberately not
// applied to the lanes viewport's left edge: the ruler above shares that
// origin, so shifting it would slide every tick off its keyframes.
const GUTTER_INSET = 12;
// What the time axis must clear to keep tick 0 just right of the card.
const GUTTER_RESERVE = PARAM_LABEL_WIDTH + GUTTER_INSET;

const EASING_PRESETS = EASING_PRESET_ORDER;
const EASING_LABELS = EASING_PRESET_LABELS;

// ---------------------------------------------------------------------
// Internal lane shape
// ---------------------------------------------------------------------

// One visual row in the track-list. Either a node header or a param lane.
type LaneRow =
  | {
      kind: "nodeHeader";
      nodeId: string;
      nodeName: string;
      visibleParamCount: number;
      collapsed: boolean;
      selected: boolean;
      // True for source nodes that can carry a timeline clip (Video, Image,
      // Text, Spline Draw, spline primitives). When true, the header row
      // renders a clip bar in its empty timeline strip.
      clippable: boolean;
      // The node's current clip windows, if any. Empty/undefined ⇒ render a
      // faint full-duration ghost that creates a window when dragged.
      clips?: ClipBlock[];
      // Whether this node's windows carry a local clock (Video's clip-local
      // remap, a layer's interior offset). In-trims on these slip
      // sourceInTick so the content stays anchored — see clipSlipsOnInTrim.
      slipsInTrim: boolean;
    }
  | {
      kind: "paramLane";
      nodeId: string;
      paramName: string;
      paramLabel: string;
      paramType: ParamType;
      block: KeyframeAnimationBlock;
      selected: boolean;
    };

type DragKind =
  | { kind: "none" }
  | {
      kind: "scrub";
    }
  | {
      kind: "pan";
      startMouseX: number;
      startMouseY: number;
      startTickOffset: number;
      startScrollY: number;
    }
  | {
      kind: "marquee";
      startMouseX: number;
      startMouseY: number;
      currentMouseX: number;
      currentMouseY: number;
      // Shift held at start → merge the box's keys into the selection.
      additive: boolean;
    }
  | {
      kind: "moveKeyframes";
      startMouseX: number;
      // Per-lane snapshot of the entire keyframe arrays at drag-start,
      // so each mousemove rebuilds from a stable baseline (see
      // timeline/keyframe-ops.ts).
      groupBases: GroupBase[];
      // Undo coalesce key for this gesture — unique per drag so two
      // rapid drags never merge into one history entry.
      gestureKey: string;
      // Option/Alt held → fan the selection across lanes instead of
      // moving it uniformly (stagger).
      stagger?: boolean;
    }
  | {
      // Dragging a clip body — shifts inTick/outTick together. `startClips`
      // is the snapshot of the node's whole window array at drag-start so each
      // move rebuilds from a stable baseline; `clipIndex` is the dragged one.
      kind: "clipMove";
      nodeId: string;
      clipIndex: number;
      startMouseX: number;
      startClips: ClipBlock[];
    }
  | {
      // Dragging a clip edge — trims in or out. For clock-carrying clips
      // (video, layer) the in-edge also slips sourceInTick so the content
      // stays anchored.
      kind: "clipTrim";
      nodeId: string;
      clipIndex: number;
      side: "in" | "out";
      startClips: ClipBlock[];
      slipsInTrim: boolean;
      // Source footage length in ticks (video only) — bounds the trim so the
      // window can't extend past the available footage. Undefined ⇒ unbounded.
      sourceDurationTicks?: number;
    }
  | {
      kind: "scaleSelection";
      side: "left" | "right";
      // Anchor (opposite edge in ticks) and drag-start snapshots.
      anchorTick: number;
      startEdgeTick: number;
      groupBases: GroupBase[];
      gestureKey: string;
    };

interface ContextMenuState {
  x: number;
  y: number;
  // The keyframe that was right-clicked (used as primary target if no
  // selection exists yet).
  target: SelectionKey;
  submenu: "easing" | null;
}

// ---------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------

export function TrackEditor(props: TrackEditorProps) {
  const {
    nodes,
    allNodes,
    edges,
    timeline,
    onScrub,
    onAnimationChange,
    onClipChange,
    collapsedNodeIds,
    onToggleCollapsed,
    onSelectNode,
    fitVersion,
  } = props;
  // Null in the main window; the child Window when this editor is
  // popped out (080226_panel-popout-windows.md §3). Every window-level
  // listener below resolves through it.
  const panelWin = usePanelWindow();
  // No top-level clock subscription (clock-store spec, leaf pass): the
  // playhead chrome and DiamondNav subscribe themselves, and actions
  // read the tick imperatively at event time — playback no longer
  // re-renders the whole editor per frame.
  const fullNodes = allNodes ?? nodes;
  // Stable identity for the no-edges fallback so downstream memos don't
  // recompute every render.
  const allEdges = useMemo(() => edges ?? [], [edges]);

  // --- View state (shared tick↔px math; see timeline/view.ts) ---
  const view = useTimelineView();
  const {
    pixelsPerTick,
    viewTickOffset,
    setPixelsPerTick,
    setViewTickOffset,
    tickToPx,
    pxToTick,
    zoomTo,
    fit: fitView,
  } = view;
  const [scrollY, setScrollY] = useState(0);

  // --- Selection ---
  // The list is the source of truth (order-of-most-recent click is
  // preserved for the inspector); the Set is derived for membership
  // tests. Previously these were two parallel useStates kept in sync by
  // hand at every call site.
  const [selectionList, setSelectionList] = useState<SelectionKey[]>([]);
  const selection = useMemo(
    () => new Set(selectionList.map(selKey)),
    [selectionList]
  );

  // ---- Anchor link with the Spline Draw overlay --------------------------
  // (spline-anchor-scope.ts). A Spline Draw node's per-anchor keyframes
  // live on `anchor_p:<id>`-style virtual tracks, so a lane here and an
  // anchor on canvas can name the same thing.

  // tracks → canvas: selecting keyframes on anchor lanes asks the overlay
  // to select those anchors. Overlays for other nodes ignore the request,
  // so this doesn't need to know which spline node is active. Only fires
  // when the selection is anchor lanes of a SINGLE node — a mixed or
  // cross-node selection has no one anchor set to mean.
  useEffect(() => {
    let nodeId: string | null = null;
    const ids: string[] = [];
    for (const s of selectionList) {
      const anchorId = anchorTrackId(s.paramName);
      if (!anchorId) return;
      if (nodeId === null) nodeId = s.nodeId;
      else if (nodeId !== s.nodeId) return;
      if (!ids.includes(anchorId)) ids.push(anchorId);
    }
    if (nodeId && ids.length > 0) requestAnchorSelection(nodeId, ids);
  }, [selectionList]);

  // canvas → tracks: the anchors selected on canvas, so their lanes can
  // be highlighted. A highlight, NOT a selection — that's what keeps the
  // two channels from feeding each other.
  const canvasAnchors = useSyncExternalStore(
    subscribePublishedAnchorSelection,
    getPublishedAnchorSelection,
    getPublishedAnchorSelection
  );
  const highlightedAnchorIds = useMemo(
    () => new Set(canvasAnchors.anchorIds),
    [canvasAnchors]
  );
  /** Is this lane one of the anchors currently selected on canvas? */
  const isAnchorHighlighted = useCallback(
    (nodeId: string, paramName: string): boolean => {
      if (canvasAnchors.nodeId !== nodeId || highlightedAnchorIds.size === 0) {
        return false;
      }
      const id = anchorTrackId(paramName);
      return !!id && highlightedAnchorIds.has(id);
    },
    [canvasAnchors.nodeId, highlightedAnchorIds]
  );

  // --- Drag / context menu ---
  const [drag, setDrag] = useState<DragKind>({ kind: "none" });
  // Faded playhead-preview lines (ruler + lanes). Positioned
  // imperatively through HoverLine handles — mousemove writes the
  // transform directly instead of re-rendering the editor per cursor
  // event.
  const rulerHoverRef = useRef<HoverLineHandle | null>(null);
  const lanesHoverRef = useRef<HoverLineHandle | null>(null);
  const setHoverLineX = (x: number | null) => {
    rulerHoverRef.current?.set(x);
    lanesHoverRef.current?.set(x);
  };
  // Hide the preview the moment any drag starts (scrub already moves the
  // real playhead).
  useEffect(() => {
    if (drag.kind !== "none") setHoverLineX(null);
  }, [drag.kind]);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  // --- Clipboard for copy/paste ---
  // Multi-track aware: each entry remembers its source (nodeId,
  // paramName) plus a tick offset relative to the earliest copied
  // keyframe. Paste re-anchors the offsets at the current playhead.
  // Lives on a ref (not state) — it's pure clipboard, no UI binding.
  const clipboardRef = useRef<{
    items: Array<{
      nodeId: string;
      paramName: string;
      offsetTicks: number;
      keyframe: Keyframe;
    }>;
  } | null>(null);

  // Internal: hold space-key state for pan-gesture activation.
  const spaceDownRef = useRef(false);
  const [spaceDown, setSpaceDown] = useState(false);

  // Razor (blade) tool: when on, clicking a clip bar splits it at the click
  // position instead of selecting/dragging. Toggle with `C`; `V`/Escape
  // returns to the select tool. `Cmd/Ctrl+B` splits at the playhead in any
  // tool. Mirrored on a ref so the latest value is visible inside the
  // window-level mousedown/keydown closures.
  const [razorMode, setRazorMode] = useState(false);
  const razorModeRef = useRef(false);
  // Latest split-at-playhead action, so the once-subscribed window
  // keydown handler always splits at the live tick.
  const splitAtPlayheadRef = useRef<() => void>(() => {});

  // Clip selection (one window) and hover, for styling + cursor + delete.
  type ClipRef = { nodeId: string; clipIndex: number };
  const [selectedClip, setSelectedClip] = useState<ClipRef | null>(null);
  const [hoveredClip, setHoveredClip] = useState<
    (ClipRef & { region: "in" | "out" | "body" }) | null
  >(null);
  // Refs so the once-subscribed keydown handler sees the live values
  // (synced in the every-render effect below, next to the actions).
  const selectedClipRef = useRef<ClipRef | null>(null);
  const deleteSelectedClipRef = useRef<() => void>(() => {});

  // Refs for measuring and event capture.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lanesAreaRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(800);
  const fitDoneRef = useRef(false);

  // ---- Derived: lane rows ----
  const lanes: LaneRow[] = useMemo(() => {
    const out: LaneRow[] = [];
    const collapsed = collapsedNodeIds ?? new Set<string>();
    for (const node of nodes) {
      const data = node.data;
      if (!data) continue;
      const def = getNodeDef(data.defType);
      const anim = data.animation;
      const visibleParams = anim
        ? Object.entries(anim).filter(([, b]) => b && b.trackVisible === true)
        : [];
      const clippable = isClippable(data.defType);
      // A group surfaces its promoted params (keyframes live on the deep
      // interior nodes) so they're editable from here without diving in.
      const promoted =
        data.defType === GROUP_TYPE
          ? resolvePromotedParams(node.id, fullNodes, allEdges)
          : [];
      // A node appears in the editor if it has visible keyframe tracks, a
      // clippable clip bar, or (for groups) promoted params.
      if (visibleParams.length === 0 && !clippable && promoted.length === 0) {
        continue;
      }
      const isCollapsed = collapsed.has(node.id);
      const isSelected = !!node.selected;
      out.push({
        kind: "nodeHeader",
        nodeId: node.id,
        nodeName: data.name,
        visibleParamCount: visibleParams.length + promoted.length,
        collapsed: isCollapsed,
        selected: isSelected,
        clippable,
        clips: data.clips,
        slipsInTrim: clipSlipsOnInTrim(data.defType),
      });
      if (isCollapsed) continue;
      // Promoted-param lanes — block lives on the deep node; an empty
      // block lets you add the first key from here.
      for (const p of promoted) {
        const deep = fullNodes.find((n) => n.id === p.nodeId);
        const block =
          deep?.data.animation?.[p.paramName] ?? emptyAnimationBlock();
        out.push({
          kind: "paramLane",
          nodeId: p.nodeId,
          paramName: p.paramName,
          paramLabel: p.label,
          paramType: p.type,
          block,
          selected: isSelected,
        });
      }
      for (const [pname, block] of visibleParams) {
        const pdef = def?.params.find((p) => p.name === pname);
        let pType: ParamType = (pdef?.type ?? "scalar") as ParamType;
        // Virtual per-layer opacity keys (merge node) have no param def —
        // label them by the layer's current position in the stack.
        let paramLabel = pdef?.label ?? pname;
        if (!pdef && pname.startsWith(LAYER_OPACITY_PREFIX)) {
          const layerId = pname.slice(LAYER_OPACITY_PREFIX.length);
          const layersRaw = data.params?.layers;
          const idx = Array.isArray(layersRaw)
            ? layersRaw.findIndex(
                (l) => (l as { id?: string } | null)?.id === layerId
              )
            : -1;
          paramLabel = idx >= 0 ? `layer ${idx + 1} opacity` : "layer opacity";
        }
        // Virtual ramp-stop keys (ramp_c/a/p:<param>:<stopId>) — label by
        // the ramp's label + the stop's sorted position, matching the
        // "stop · n/N" numbering in the param panel.
        const rampKey = !pdef ? parseRampParamKey(pname) : null;
        if (rampKey) {
          const rampDef = def?.params.find(
            (p) => p.name === rampKey.paramName
          );
          const stopsRaw = data.params?.[rampKey.paramName];
          const idx = Array.isArray(stopsRaw)
            ? [...(stopsRaw as Array<{ id?: string; position?: number }>)]
                .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
                .findIndex((s) => s.id === rampKey.stopId)
            : -1;
          paramLabel = `${rampDef?.label ?? rampKey.paramName} · ${
            rampKey.field
          }${idx >= 0 ? ` ${idx + 1}` : ""}`;
          if (rampKey.field === "color") pType = "color";
        }
        out.push({
          kind: "paramLane",
          nodeId: node.id,
          paramName: pname,
          paramLabel,
          paramType: pType,
          block,
          selected: isSelected,
        });
      }
    }
    return out;
  }, [nodes, collapsedNodeIds, fullNodes, allEdges]);

  // Map row index → y offset within the scrolled lanes area.
  const laneRowYs: number[] = useMemo(() => {
    const ys: number[] = [];
    let y = 0;
    for (const row of lanes) {
      ys.push(y);
      y += row.kind === "nodeHeader" ? NODE_HEADER_HEIGHT : TRACK_HEIGHT;
    }
    return ys;
  }, [lanes]);
  const totalLanesHeight =
    laneRowYs.length === 0
      ? 0
      : laneRowYs[laneRowYs.length - 1] +
        (lanes[lanes.length - 1].kind === "nodeHeader"
          ? NODE_HEADER_HEIGHT
          : TRACK_HEIGHT);

  // ---- Container width tracking ----
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerWidth(el.clientWidth);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- Fit (first mount, Home key, dock-header button) ----
  // The label gutter floats OVER the lanes' left edge, so the fit
  // reserves its width: tick 0 lands just right of the gutter instead of
  // underneath it, keeping early keyframes visible and clickable.
  const lanesAreaWidth = Math.max(50, containerWidth);

  const fit = useCallback(() => {
    if (lanesAreaWidth <= 0) return;
    fitView(lanesAreaWidth, timeline.sceneDurationTicks, GUTTER_RESERVE);
  }, [lanesAreaWidth, timeline.sceneDurationTicks, fitView]);

  useEffect(() => {
    if (fitDoneRef.current) return;
    if (containerWidth <= 0) return;
    fit();
    fitDoneRef.current = true;
  }, [containerWidth, fit]);

  // F — zoom/pan so the selected keyframes fill the usable viewport
  // (the region right of the floating label gutter).
  const focusSelection = useCallback(() => {
    if (selectionList.length === 0) return;
    let minTick = Infinity;
    let maxTick = -Infinity;
    for (const s of selectionList) {
      if (s.tick < minTick) minTick = s.tick;
      if (s.tick > maxTick) maxTick = s.tick;
    }
    if (!isFinite(minTick)) return;
    // A single column still gets a sensible zoom: pretend it spans 10
    // frames so F on one keyframe centers it rather than zooming to max.
    const span = Math.max(maxTick - minTick, timeline.ticksPerFrame * 10);
    const usable = Math.max(50, lanesAreaWidth - GUTTER_RESERVE);
    const pps = clampPixelsPerTick((usable * 0.6) / span);
    const centerTick = (minTick + maxTick) / 2;
    const centerPx = GUTTER_RESERVE + usable / 2;
    setPixelsPerTick(pps);
    setViewTickOffset(centerTick - centerPx / pps);
  }, [
    selectionList,
    lanesAreaWidth,
    timeline.ticksPerFrame,
    setPixelsPerTick,
    setViewTickOffset,
  ]);

  // Parent-triggered fit (the fit button now lives in the dock header).
  // Skip the initial render so this doesn't fight the first-mount fit.
  const fitVersionFirstRef = useRef(true);
  useEffect(() => {
    if (fitVersionFirstRef.current) {
      fitVersionFirstRef.current = false;
      return;
    }
    fit();
  }, [fitVersion, fit]);

  // ---- Wheel: pan by default; Cmd/Ctrl = zoom anchored to cursor ----
  // Bound to the whole container so wheel events anywhere in the editor
  // (including the labels column) get captured here and don't bubble up
  // to the canvas / NodeEditor pan-zoom layer beneath us.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      const lanesRect = lanesAreaRef.current?.getBoundingClientRect();
      const dx = e.deltaX || 0;
      const dy = e.deltaY || 0;
      const overLanes =
        !!lanesRect &&
        e.clientX >= lanesRect.left &&
        e.clientX <= lanesRect.right &&
        e.clientY >= lanesRect.top &&
        e.clientY <= lanesRect.bottom;

      // Mouse: the wheel zooms the time axis about the cursor (over the
      // lanes). Shift, or scrolling over the labels column, scrolls the lane
      // list instead — the trackpad path below keeps plain vertical = list.
      if (getEffectiveDevice() === "mouse") {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey || !overLanes || !lanesRect) {
          const viewportH = lanesRect ? lanesRect.height : 0;
          const maxScroll = Math.max(0, totalLanesHeight - viewportH);
          setScrollY((prev) => Math.max(0, Math.min(maxScroll, prev + dy)));
          return;
        }
        const mx = e.clientX - lanesRect.left;
        const mag = Math.abs(dx) > Math.abs(dy) ? dx : dy;
        zoomTo(
          mx,
          pxToTick(mx),
          pixelsPerTick * Math.exp(-mag * ZOOM_SENSITIVITY)
        );
        return;
      }

      // Cmd / Ctrl + wheel = horizontal zoom anchored to cursor.
      // Driven by horizontal scroll (deltaX), since the lane time axis
      // is horizontal — vertical scroll keeps panning the lane list.
      if ((e.metaKey || e.ctrlKey) && overLanes && lanesRect && dx !== 0) {
        e.preventDefault();
        e.stopPropagation();
        const mx = e.clientX - lanesRect.left;
        zoomTo(
          mx,
          pxToTick(mx),
          pixelsPerTick * Math.exp(-dx * ZOOM_SENSITIVITY)
        );
        return;
      }

      // Plain wheel = pan. Always handle it (preventing fall-through to
      // the underlying canvas), even in the labels column where only
      // vertical scroll is meaningful.
      e.preventDefault();
      e.stopPropagation();
      // Vertical scroll moves the lane list (clamped to total height).
      if (dy !== 0) {
        const viewportH = lanesRect ? lanesRect.height : 0;
        const maxScroll = Math.max(0, totalLanesHeight - viewportH);
        setScrollY((prev) => Math.max(0, Math.min(maxScroll, prev + dy)));
      }
      // Horizontal scroll pans the timeline (only while over the lanes).
      if (dx !== 0 && overLanes) {
        setViewTickOffset((prev) => prev + dx / pixelsPerTick);
      }
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [pxToTick, pixelsPerTick, totalLanesHeight, zoomTo, setViewTickOffset]);

  // Middle-button pointerdown: stop it reaching the preview canvas's
  // window-level middle-drag pan (bug #2 — the bleed-through). Scoped to
  // button 1 so left-button keyframe interactions are untouched.
  //
  // BOTH middle-button gestures live here. This listener is on containerRef,
  // an ANCESTOR of the lanes area, and React delegates from the app root —
  // so it runs first, and its stopPropagation means the React surface
  // handler never sees button 1. (It used to lean on the compat mousedown
  // reaching React afterwards for the plain-pan case; pointer events have no
  // such second delivery, so the pan is started directly below.)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 1) return;
      e.stopPropagation();
      e.preventDefault();
      const rect = lanesAreaRef.current?.getBoundingClientRect();
      if (!rect) return;
      // Plain middle-drag = pan.
      if (!(e.metaKey || e.ctrlKey)) {
        setDrag({
          kind: "pan",
          startMouseX: e.clientX,
          startMouseY: e.clientY,
          startTickOffset: viewTickOffset,
          startScrollY: scrollY,
        });
        return;
      }
      // Cmd/Ctrl + middle-drag = zoom the time axis.
      const startX = e.clientX;
      const startY = e.clientY;
      const anchorX = startX - rect.left;
      const startPpt = pixelsPerTick;
      const tickAt = viewTickOffset + anchorX / startPpt;
      const onMove = (ev: PointerEvent) => {
        // Drag up zooms in (larger pixels-per-tick).
        const factor = Math.exp(-(ev.clientY - startY) * ZOOM_SENSITIVITY);
        zoomTo(anchorX, tickAt, startPpt * factor);
      };
      const win = ownerWindow(el);
      const onUp = () => {
        win.removeEventListener("pointermove", onMove);
        win.removeEventListener("pointerup", onUp);
      };
      win.addEventListener("pointermove", onMove);
      win.addEventListener("pointerup", onUp);
    };
    el.addEventListener("pointerdown", onDown);
    return () => el.removeEventListener("pointerdown", onDown);
  }, [pixelsPerTick, viewTickOffset, zoomTo, scrollY]);

  // ---- Keyboard: space-pan, tools, delete, copy/paste, Home/F ----
  // Delete/Backspace is gated by `hoveredRef` so the keyframe deletion
  // only fires while the mouse is over the Track Editor — otherwise the
  // node-graph editor's own delete handler is the right target.
  //
  // The listener subscribes ONCE and reads the latest closures through
  // `keyActionsRef` (assigned every render). Previously it re-subscribed
  // only on selection identity, so Cmd+V pasted at whatever tick the
  // playhead had when the selection last changed, and Cmd+C copied from
  // a stale block index.
  const hoveredRef = useRef(false);
  const keyActionsRef = useRef({
    deleteSelected: () => {},
    copySelected: () => {},
    pasteAtPlayhead: () => {},
    fit: () => {},
    focusSelection: () => {},
    hasSelection: false,
  });
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      const acts = keyActionsRef.current;

      if (e.code === "Space" && !spaceDownRef.current && !e.shiftKey) {
        // !shiftKey so Shift+Space (the pie menu chord) never starts a pan.
        spaceDownRef.current = true;
        setSpaceDown(true);
        e.preventDefault();
        return;
      }
      if (e.key === "Escape") {
        setSelectionList([]);
        setSelectedClip(null);
        setMenu(null);
        setRazorMode(false);
        return;
      }
      // Tool + view shortcuts (only while hovering the editor so bare
      // keys don't hijack typing elsewhere): C = razor/blade, V = select,
      // Home = fit the scene, F = focus the selection.
      if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key.toLowerCase() === "c" && hoveredRef.current) {
          e.preventDefault();
          setRazorMode((m) => !m);
          return;
        }
        if (e.key.toLowerCase() === "v" && hoveredRef.current) {
          e.preventDefault();
          setRazorMode(false);
          return;
        }
        if (e.key === "Home" && hoveredRef.current) {
          e.preventDefault();
          acts.fit();
          return;
        }
        if (e.key.toLowerCase() === "f" && hoveredRef.current) {
          if (!acts.hasSelection) return;
          e.preventDefault();
          acts.focusSelection();
          return;
        }
      }
      // Cmd/Ctrl+B — split the clip(s) under the playhead.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        if (!hoveredRef.current) return;
        e.preventDefault();
        e.stopPropagation();
        splitAtPlayheadRef.current();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (!hoveredRef.current) return;
        // A selected clip takes precedence over keyframe selection.
        if (selectedClipRef.current) {
          e.preventDefault();
          e.stopPropagation();
          deleteSelectedClipRef.current();
          return;
        }
        if (!acts.hasSelection) return;
        e.preventDefault();
        e.stopPropagation();
        acts.deleteSelected();
      }
      // Copy / paste — only when hovering the editor so the global
      // Cmd+C / Cmd+V shortcuts don't get hijacked elsewhere.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
        if (!hoveredRef.current) return;
        if (!acts.hasSelection) return;
        e.preventDefault();
        e.stopPropagation();
        acts.copySelected();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") {
        if (!hoveredRef.current) return;
        if (!clipboardRef.current) return;
        e.preventDefault();
        e.stopPropagation();
        acts.pasteAtPlayhead();
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "Space") {
        spaceDownRef.current = false;
        setSpaceDown(false);
      }
    }
    const win = panelWin ?? window;
    win.addEventListener("keydown", onKeyDown);
    win.addEventListener("keyup", onKeyUp);
    return () => {
      win.removeEventListener("keydown", onKeyDown);
      win.removeEventListener("keyup", onKeyUp);
    };
  }, [panelWin]);

  // ---- Block-by-key index for fast updates ----
  // nodeId → paramName → block (uses the same block reference as `lanes`)
  const blockIndex: Map<string, Map<string, KeyframeAnimationBlock>> = useMemo(() => {
    const idx = new Map<string, Map<string, KeyframeAnimationBlock>>();
    // Built from the full graph so promoted-group lanes (whose keyframes
    // live on deep interior nodes outside the current scope) resolve.
    for (const n of fullNodes) {
      const m = new Map<string, KeyframeAnimationBlock>();
      const anim = n.data?.animation;
      if (anim) {
        for (const [pname, b] of Object.entries(anim)) m.set(pname, b);
      }
      idx.set(n.id, m);
    }
    return idx;
  }, [fullNodes]);

  // Adapter for the shared snapshot/op helpers (timeline/keyframe-ops).
  const getBlockForBases = (nodeId: string, paramName: string) =>
    blockIndex.get(nodeId)?.get(paramName);

  // Apply a shared keyframe-op result: one onAnimationChange per lane,
  // all sharing the gesture's coalesce key so the whole gesture is ONE
  // undo entry, then adopt the rebuilt selection. A null result (e.g. a
  // scale pinned at its minimum span) keeps the last applied state.
  function applyKeyframeOp(
    result: KeyframeOpResult | null,
    gestureKey: string
  ) {
    if (!result) return;
    for (const u of result.updates) {
      const block = blockIndex.get(u.nodeId)?.get(u.paramName);
      if (!block) continue;
      onAnimationChange(
        u.nodeId,
        u.paramName,
        { ...block, keyframes: u.keyframes },
        gestureKey
      );
    }
    setSelectionList(result.selection);
  }

  // Stagger fans lanes top → bottom; order the bases by lane row index.
  function orderBasesByLane(bases: GroupBase[]): GroupBase[] {
    const idxOf = (b: GroupBase) =>
      lanes.findIndex(
        (r) =>
          r.kind === "paramLane" &&
          r.nodeId === b.nodeId &&
          r.paramName === b.paramName
      );
    return [...bases].sort((a, b) => idxOf(a) - idxOf(b));
  }

  function deleteSelected() {
    if (selectionList.length === 0) return;
    // One gesture key for every affected lane → one undo entry.
    const gestureKey = nextGestureKey("delete");
    const groups = groupSelection(selectionList);
    for (const [, items] of groups) {
      const { nodeId, paramName } = items[0];
      const block = blockIndex.get(nodeId)?.get(paramName);
      if (!block) continue;
      let next: KeyframeAnimationBlock = block;
      for (const it of items) {
        next = removeKeyframeAt(next, it.tick);
      }
      onAnimationChange(nodeId, paramName, next, gestureKey);
    }
    setSelectionList([]);
  }

  function copySelected() {
    if (selectionList.length === 0) return;
    // Snapshot the actual Keyframe records (value + easing + handles)
    // and store each one's tick offset relative to the earliest copied
    // tick. Paste re-anchors at the playhead so multi-track selections
    // preserve their internal timing.
    const minTick = selectionList.reduce(
      (m, s) => Math.min(m, s.tick),
      Infinity
    );
    const items: NonNullable<typeof clipboardRef.current>["items"] = [];
    for (const s of selectionList) {
      const block = blockIndex.get(s.nodeId)?.get(s.paramName);
      const kf = block?.keyframes.find((k) => k.tick === s.tick);
      if (!kf) continue;
      items.push({
        nodeId: s.nodeId,
        paramName: s.paramName,
        offsetTicks: s.tick - minTick,
        keyframe: { ...kf, bezierHandles: kf.bezierHandles },
      });
    }
    if (items.length === 0) return;
    clipboardRef.current = { items };
  }

  function pasteAtPlayhead() {
    const clip = clipboardRef.current;
    if (!clip || clip.items.length === 0) return;
    // The LIVE playhead — read at paste time, not captured at render.
    const tickNow = playbackClock.get().tick;
    const gestureKey = nextGestureKey("paste");
    // Group pastes by lane so each affected block emits a single
    // onAnimationChange call.
    const grouped = new Map<
      string,
      {
        nodeId: string;
        paramName: string;
        items: { tick: number; keyframe: Keyframe }[];
      }
    >();
    for (const it of clip.items) {
      const targetTick = tickNow + it.offsetTicks;
      const key = laneKey(it.nodeId, it.paramName);
      const g = grouped.get(key);
      const item = {
        tick: targetTick,
        keyframe: { ...it.keyframe, tick: targetTick },
      };
      if (g) g.items.push(item);
      else
        grouped.set(key, {
          nodeId: it.nodeId,
          paramName: it.paramName,
          items: [item],
        });
    }
    // Apply per-block. If the source track is gone (param renamed,
    // node deleted), skip silently — keyframable check ensures we
    // only paste into params that can hold animation.
    const newSelection: SelectionKey[] = [];
    for (const g of grouped.values()) {
      const block = blockIndex.get(g.nodeId)?.get(g.paramName);
      if (!block) continue;
      // Drop any existing keyframe at the same tick to avoid
      // collision; the pasted one wins.
      const ticks = new Set(g.items.map((i) => i.tick));
      const filtered = block.keyframes.filter((k) => !ticks.has(k.tick));
      const merged = [...filtered, ...g.items.map((i) => i.keyframe)].sort(
        (a, b) => a.tick - b.tick
      );
      onAnimationChange(
        g.nodeId,
        g.paramName,
        {
          ...block,
          animated: true,
          keyframes: merged,
        },
        gestureKey
      );
      for (const i of g.items) {
        newSelection.push({
          nodeId: g.nodeId,
          paramName: g.paramName,
          tick: i.tick,
        });
      }
    }
    setSelectionList(newSelection);
  }

  // Current stored value for a param, resolving virtual keys (merge
  // layer opacity, ramp stops) that have no entry in `params`. Returns
  // undefined when no value can be determined — callers then skip the
  // insert instead of writing an undefined-valued keyframe.
  function storedParamValue(
    node: Node<NodeDataPayload> | undefined,
    paramName: string
  ): unknown {
    if (!node) return undefined;
    const direct = node.data.params[paramName];
    if (direct !== undefined) return direct;
    if (paramName.startsWith(LAYER_OPACITY_PREFIX)) {
      const layerId = paramName.slice(LAYER_OPACITY_PREFIX.length);
      const layersRaw = node.data.params?.layers;
      if (!Array.isArray(layersRaw)) return undefined;
      const layer = layersRaw.find(
        (l) => (l as { id?: string } | null)?.id === layerId
      ) as { opacity?: number } | undefined;
      return layer ? (layer.opacity ?? 1) : undefined;
    }
    const rampKey = parseRampParamKey(paramName);
    if (rampKey) {
      const stopsRaw = node.data.params?.[rampKey.paramName];
      if (!Array.isArray(stopsRaw)) return undefined;
      const stop = (
        stopsRaw as Array<({ id?: string } & Record<string, unknown>) | null>
      ).find((s) => s?.id === rampKey.stopId);
      if (!stop) return undefined;
      if (rampKey.field === "color") return stop.color;
      if (rampKey.field === "alpha")
        return (stop.alpha as number | undefined) ?? 1;
      return stop.position;
    }
    return undefined;
  }

  // Add / remove a keyframe at the playhead for a track (the lane-label
  // diamond). Mirrors the param-panel diamond. Reads the playhead
  // imperatively so the toggle always lands at the live tick.
  function toggleKeyAtPlayhead(
    nodeId: string,
    paramName: string,
    type: ParamType
  ) {
    const tickNow = playbackClock.get().tick;
    const block = blockIndex.get(nodeId)?.get(paramName);
    if (block && findKeyframeAt(block, tickNow)) {
      const next = removeKeyframeAt(block, tickNow);
      onAnimationChange(
        nodeId,
        paramName,
        next.keyframes.length > 0 ? { ...next, animated: true } : undefined
      );
      return;
    }
    const node = fullNodes.find((n) => n.id === nodeId);
    const value =
      block?.animated && block.keyframes.length > 0
        ? evaluateKeyframesAt(block, type, tickNow)
        : storedParamValue(node, paramName);
    if (value === undefined) return;
    const base = block ?? emptyAnimationBlock();
    onAnimationChange(
      nodeId,
      paramName,
      upsertKeyframe({ ...base, animated: true }, tickNow, value)
    );
  }

  function setKeyframeEasing(targets: SelectionKey[], easing: EasingPreset) {
    if (targets.length === 0) return;
    const gestureKey = nextGestureKey("easing");
    const groups = groupSelection(targets);
    for (const [, items] of groups) {
      const { nodeId, paramName } = items[0];
      const block = blockIndex.get(nodeId)?.get(paramName);
      if (!block) continue;
      const ticksToChange = new Set(items.map((it) => it.tick));
      const nextKfs = block.keyframes.map((k) =>
        ticksToChange.has(k.tick) ? { ...k, easingOut: easing } : k
      );
      onAnimationChange(
        nodeId,
        paramName,
        { ...block, keyframes: nextKfs },
        gestureKey
      );
    }
  }

  // ---- Hit testing on lanes ----
  /**
   * The two keyframes bracketing a click on the connector line BETWEEN
   * them — i.e. the pair that owns that segment's easing. Only the
   * interior of the line counts: the ends belong to the keyframes
   * themselves, and hitTestKeyframe runs first regardless.
   */
  function hitTestSegment(
    contentX: number,
    contentY: number
  ): SelectionKey[] | null {
    for (let i = 0; i < lanes.length; i++) {
      const row = lanes[i];
      if (row.kind !== "paramLane") continue;
      const yTop = laneRowYs[i];
      if (contentY < yTop || contentY > yTop + TRACK_HEIGHT) continue;
      // Connectors are drawn at the lane's mid-height.
      if (Math.abs(contentY - (yTop + TRACK_HEIGHT / 2)) > SEGMENT_HIT_PX) {
        return null;
      }
      const kfs = row.block.keyframes;
      for (let j = 1; j < kfs.length; j++) {
        if (
          contentX > tickToPx(kfs[j - 1].tick) + KEY_HIT_PX &&
          contentX < tickToPx(kfs[j].tick) - KEY_HIT_PX
        ) {
          return [
            {
              nodeId: row.nodeId,
              paramName: row.paramName,
              tick: kfs[j - 1].tick,
            },
            { nodeId: row.nodeId, paramName: row.paramName, tick: kfs[j].tick },
          ];
        }
      }
      return null;
    }
    return null;
  }

  // Returns the keyframe selection key + lane row index for a click within
  // the lanes content area.
  function hitTestKeyframe(
    contentX: number,
    contentY: number
  ): { key: SelectionKey; rowIdx: number } | null {
    for (let i = 0; i < lanes.length; i++) {
      const row = lanes[i];
      if (row.kind !== "paramLane") continue;
      const yTop = laneRowYs[i];
      const yBot = yTop + TRACK_HEIGHT;
      if (contentY < yTop || contentY > yBot) continue;
      // Found the lane; walk its keyframes and test x distance.
      for (const kf of row.block.keyframes) {
        const kx = tickToPx(kf.tick);
        if (Math.abs(kx - contentX) <= KEY_HIT_PX) {
          return {
            key: { nodeId: row.nodeId, paramName: row.paramName, tick: kf.tick },
            rowIdx: i,
          };
        }
      }
    }
    return null;
  }

  // The current clip windows for a node id (live from props).
  function clipsForNode(nodeId: string): ClipBlock[] | undefined {
    return nodes.find((n) => n.id === nodeId)?.data.clips;
  }

  // The source footage length of a time-driven node (Video) in ticks, or
  // undefined for static sources / unknown duration. Used to keep a clip from
  // running past the end of (or before the start of) the actual video.
  function sourceDurationTicksFor(nodeId: string): number | undefined {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node || !isTimeDrivenClip(node.data.defType)) return undefined;
    const file = node.data.params.file as { duration?: number } | null | undefined;
    const dur = file?.duration;
    if (typeof dur !== "number" || !isFinite(dur) || dur <= 0) return undefined;
    return Math.round(dur * timeline.ticksPerFrame * timeline.fps);
  }

  // Full-duration default window for a node, clamped to the source length for
  // video so a freshly-created clip never exceeds the footage.
  function defaultClipForNode(nodeId: string): ClipBlock {
    const srcDur = sourceDurationTicksFor(nodeId);
    const out =
      srcDur != null
        ? Math.min(timeline.sceneDurationTicks, srcDur)
        : timeline.sceneDurationTicks;
    return defaultClip(0, out);
  }

  // Hit-test the clip bars in a clippable node's header strip. Returns the
  // node id, which part was hit (in/out edge or body), and the index of the
  // window hit (0 when the user grabbed the full-duration ghost of a
  // window-less node).
  function hitTestClip(
    contentX: number,
    contentY: number
  ): {
    nodeId: string;
    region: "in" | "out" | "body";
    clipIndex: number;
    slipsInTrim: boolean;
  } | null {
    const EDGE = CLIP_EDGE_PX;
    for (let i = 0; i < lanes.length; i++) {
      const row = lanes[i];
      if (row.kind !== "nodeHeader" || !row.clippable) continue;
      const yTop = laneRowYs[i];
      const yBot = yTop + NODE_HEADER_HEIGHT;
      if (contentY < yTop || contentY > yBot) continue;
      const windows = row.clips && row.clips.length > 0 ? row.clips : null;
      if (!windows) {
        // Faint full-duration ghost.
        const inPx = tickToPx(0);
        const outPx = tickToPx(timeline.sceneDurationTicks);
        if (contentX < inPx - EDGE || contentX > outPx + EDGE) return null;
        let region: "in" | "out" | "body";
        if (Math.abs(contentX - inPx) <= EDGE) region = "in";
        else if (Math.abs(contentX - outPx) <= EDGE) region = "out";
        else region = "body";
        return { nodeId: row.nodeId, region, clipIndex: 0, slipsInTrim: row.slipsInTrim };
      }
      for (let ci = 0; ci < windows.length; ci++) {
        const c = windows[ci];
        const inPx = tickToPx(c.inTick);
        const outPx = tickToPx(c.outTick);
        if (contentX < inPx - EDGE || contentX > outPx + EDGE) continue;
        let region: "in" | "out" | "body";
        if (Math.abs(contentX - inPx) <= EDGE) region = "in";
        else if (Math.abs(contentX - outPx) <= EDGE) region = "out";
        else region = "body";
        return { nodeId: row.nodeId, region, clipIndex: ci, slipsInTrim: row.slipsInTrim };
      }
      // Inside the row's Y band but on no window — let other handlers run.
      return null;
    }
    return null;
  }

  // Split the window containing `tick` on a node into two. A window-less
  // clippable node is treated as one implicit full-scene window, so a razor
  // cut materializes it into two real windows.
  function splitClipAtTick(nodeId: string, tick: number) {
    const existing = clipsForNode(nodeId);
    const base =
      existing && existing.length > 0
        ? existing
        : [defaultClipForNode(nodeId)];
    const next = splitClipsAt(base, Math.round(tick));
    // Emit when the cut actually changed something, or when we just
    // materialized a ghost into a real clip.
    if (next.length !== base.length || !existing || existing.length === 0) {
      onClipChange?.(nodeId, next);
    }
  }

  // Split at the playhead. With clippable nodes selected, split those (and
  // materialize a ghost if needed); with no selection, split every clippable
  // node that already has a window under the playhead.
  function splitAtPlayhead() {
    const tickNow = playbackClock.get().tick;
    const headers = lanes.filter(
      (r): r is Extract<LaneRow, { kind: "nodeHeader" }> =>
        r.kind === "nodeHeader" && r.clippable
    );
    const selected = headers.filter((h) => h.selected);
    const targets = selected.length > 0 ? selected : headers;
    for (const h of targets) {
      const hasClips = !!h.clips && h.clips.length > 0;
      if (hasClips) {
        if (resolveClipAt(h.clips, tickNow).active) {
          splitClipAtTick(h.nodeId, tickNow);
        }
      } else if (selected.length > 0) {
        // Explicitly targeted, no windows yet → materialize + cut.
        splitClipAtTick(h.nodeId, tickNow);
      }
    }
  }

  // Remove the currently selected clip window.
  function deleteSelectedClip() {
    const sel = selectedClipRef.current;
    if (!sel) return;
    const clips = clipsForNode(sel.nodeId);
    if (!clips) return;
    const next = clips.filter((_, i) => i !== sel.clipIndex);
    onClipChange?.(sel.nodeId, next.length > 0 ? next : undefined);
    setSelectedClip(null);
    setHoveredClip(null);
  }

  // Sync every ref the once-subscribed window handlers read. Runs after
  // every render (no dep array) so the handlers always see the latest
  // closures and values — the stale-paste/copy bug came from syncing
  // these only when the selection identity changed.
  useEffect(() => {
    razorModeRef.current = razorMode;
    selectedClipRef.current = selectedClip;
    splitAtPlayheadRef.current = splitAtPlayhead;
    deleteSelectedClipRef.current = deleteSelectedClip;
    keyActionsRef.current = {
      deleteSelected,
      copySelected,
      pasteAtPlayhead,
      fit,
      focusSelection,
      hasSelection: selectionList.length > 0,
    };
  });

  // Param types across the current selection — drives the customBezier
  // gate (scalar-only) and the step-only easing hide. Computed once per
  // selection/lane change instead of per <option> per render.
  const selectionTypes = useMemo(() => {
    const typeOf = new Map<string, ParamType>();
    for (const r of lanes) {
      if (r.kind === "paramLane") {
        typeOf.set(laneKey(r.nodeId, r.paramName), r.paramType);
      }
    }
    let allScalar = selectionList.length > 0;
    let stepOnly = selectionList.length > 0;
    for (const s of selectionList) {
      const t = typeOf.get(laneKey(s.nodeId, s.paramName));
      if (t !== "scalar") allScalar = false;
      if (!t || !isStepOnly(t)) stepOnly = false;
    }
    return { allScalar, stepOnly };
  }, [lanes, selectionList]);

  // ---- Selection bounding box (in ticks + row idx range) ----
  const selectionBox = useMemo(() => {
    if (selectionList.length < 2) return null;
    let minTick = Infinity;
    let maxTick = -Infinity;
    let minRow = Infinity;
    let maxRow = -Infinity;
    // Build a fast lookup lane -> rowIdx.
    const rowIdx = new Map<string, number>();
    for (let i = 0; i < lanes.length; i++) {
      const r = lanes[i];
      if (r.kind === "paramLane") rowIdx.set(laneKey(r.nodeId, r.paramName), i);
    }
    for (const s of selectionList) {
      if (s.tick < minTick) minTick = s.tick;
      if (s.tick > maxTick) maxTick = s.tick;
      const ri = rowIdx.get(laneKey(s.nodeId, s.paramName));
      if (ri == null) continue;
      if (ri < minRow) minRow = ri;
      if (ri > maxRow) maxRow = ri;
    }
    if (!isFinite(minTick) || !isFinite(minRow)) return null;
    return { minTick, maxTick, minRow, maxRow };
  }, [selectionList, lanes]);

  // ---- Pointer interactions on the lanes area ----
  // Pointer, not mouse: iPadOS synthesizes mouse events only for a tap, so a
  // mousedown-rooted gesture has no move stream under finger or Pencil.
  function onLanesPointerDown(e: React.PointerEvent) {
    // Middle-button never reaches here: the native pointerdown listener
    // above owns both middle gestures (pan / Cmd-zoom) and stops propagation.
    if (e.button !== 0) {
      return;
    }
    const rect = lanesAreaRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const contentX = mx;
    const contentY = my + scrollY;

    setMenu(null);
    // Any mousedown clears the clip selection; the clip branch below re-sets
    // it when a window was actually clicked (last write wins in this batch).
    setSelectedClip(null);

    // Space + drag = pan.
    if (spaceDownRef.current) {
      setDrag({
        kind: "pan",
        startMouseX: e.clientX,
        startMouseY: e.clientY,
        startTickOffset: viewTickOffset,
        startScrollY: scrollY,
      });
      e.preventDefault();
      return;
    }

    // Clip bar interaction (header strip of clippable source nodes). Takes
    // priority over marquee/keyframe hits since header rows hold no keys.
    const clipHit = hitTestClip(contentX, contentY);
    if (clipHit) {
      onSelectNode?.(clipHit.nodeId);
      // Razor tool: click cuts the window at the click position.
      if (razorModeRef.current) {
        const raw = pxToTick(contentX);
        const tick = e.shiftKey
          ? raw
          : snapTickToFrame(raw, timeline.ticksPerFrame);
        splitClipAtTick(clipHit.nodeId, tick);
        e.preventDefault();
        return;
      }
      // Select this window (and clear any keyframe selection so Backspace is
      // unambiguous).
      setSelectedClip({ nodeId: clipHit.nodeId, clipIndex: clipHit.clipIndex });
      setSelectionList([]);
      // A window-less node's ghost gets a full-duration default as the
      // drag baseline, but it is NOT written until the drag actually
      // moves (the mousemove handlers emit from this snapshot) — a plain
      // click no longer dirties the document. For video the default is
      // clamped to the footage length.
      let startClips = clipsForNode(clipHit.nodeId);
      if (!startClips || startClips.length === 0) {
        startClips = [defaultClipForNode(clipHit.nodeId)];
      }
      if (clipHit.region === "body") {
        setDrag({
          kind: "clipMove",
          nodeId: clipHit.nodeId,
          clipIndex: clipHit.clipIndex,
          startMouseX: e.clientX,
          startClips,
        });
      } else {
        setDrag({
          kind: "clipTrim",
          nodeId: clipHit.nodeId,
          clipIndex: clipHit.clipIndex,
          side: clipHit.region,
          startClips,
          slipsInTrim: clipHit.slipsInTrim,
          sourceDurationTicks: sourceDurationTicksFor(clipHit.nodeId),
        });
      }
      e.preventDefault();
      return;
    }

    // Bounding-box scale handles take priority when a selection exists.
    if (selectionBox) {
      const leftPx = tickToPx(selectionBox.minTick);
      const rightPx = tickToPx(selectionBox.maxTick);
      const yTop = laneRowYs[selectionBox.minRow] ?? 0;
      const yBotRow = lanes[selectionBox.maxRow];
      const yBot =
        (laneRowYs[selectionBox.maxRow] ?? 0) +
        (yBotRow?.kind === "nodeHeader" ? NODE_HEADER_HEIGHT : TRACK_HEIGHT);
      const inYBand = contentY >= yTop - 4 && contentY <= yBot + 4;
      const EDGE = 6;
      // Suppress scale handles entirely when the box has no usable
      // interior — i.e. all selected keyframes share a tick column or
      // the box is too narrow to leave any clickable middle. In that
      // case the whole strip is a move-group hit zone (with a small
      // lateral pad so the user can grab a single shared column).
      const boxWidth = rightPx - leftPx;
      const allowScale = boxWidth >= 2 * EDGE + 2;
      if (allowScale && inYBand && Math.abs(contentX - leftPx) <= EDGE) {
        // Drag left edge -> scale toward right anchor.
        setDrag({
          kind: "scaleSelection",
          side: "left",
          anchorTick: selectionBox.maxTick,
          startEdgeTick: selectionBox.minTick,
          groupBases: buildGroupBases(selectionList, getBlockForBases),
          gestureKey: nextGestureKey("scale"),
        });
        e.preventDefault();
        return;
      }
      if (allowScale && inYBand && Math.abs(contentX - rightPx) <= EDGE) {
        setDrag({
          kind: "scaleSelection",
          side: "right",
          anchorTick: selectionBox.minTick,
          startEdgeTick: selectionBox.maxTick,
          groupBases: buildGroupBases(selectionList, getBlockForBases),
          gestureKey: nextGestureKey("scale"),
        });
        e.preventDefault();
        return;
      }
      // Interior drag = move group. When the box is degenerate (zero or
      // near-zero width) we widen the hit zone laterally around the
      // shared column so the cursor has something to grab.
      const PAD = allowScale ? EDGE : 8;
      const interior =
        inYBand && contentX >= leftPx - PAD && contentX <= rightPx + PAD;
      if (interior) {
        const hit = hitTestKeyframe(contentX, contentY);
        // Shift-click toggles membership even inside the box — without
        // this, keyframes inside the bounding box could never be
        // shift-deselected (the interior swallowed the click as a
        // group-move).
        if (hit && e.shiftKey) {
          const k = selKey(hit.key);
          setSelectionList(
            selection.has(k)
              ? selectionList.filter((s) => selKey(s) !== k)
              : [...selectionList, hit.key]
          );
          e.preventDefault();
          return;
        }
        if (hit && !selection.has(selKey(hit.key))) {
          // Click on a non-selected keyframe inside the box: replace
          // selection and start a single-keyframe move.
          setSelectionList([hit.key]);
          setDrag({
            kind: "moveKeyframes",
            startMouseX: e.clientX,
            groupBases: buildGroupBases([hit.key], getBlockForBases),
            gestureKey: nextGestureKey("drag"),
            stagger: e.altKey,
          });
          e.preventDefault();
          return;
        }
        setDrag({
          kind: "moveKeyframes",
          startMouseX: e.clientX,
          groupBases: buildGroupBases(selectionList, getBlockForBases),
          gestureKey: nextGestureKey("drag"),
          stagger: e.altKey,
        });
        e.preventDefault();
        return;
      }
    }

    // Hit a keyframe?
    const hit = hitTestKeyframe(contentX, contentY);
    if (hit) {
      const k = selKey(hit.key);
      if (e.shiftKey) {
        // Toggle membership; no drag on a shift-click.
        setSelectionList(
          selection.has(k)
            ? selectionList.filter((s) => selKey(s) !== k)
            : [...selectionList, hit.key]
        );
        e.preventDefault();
        return;
      }
      if (!selection.has(k)) {
        setSelectionList([hit.key]);
      }
      // Start a move drag on the (possibly-updated) selection.
      const effective = selection.has(k) ? selectionList : [hit.key];
      setDrag({
        kind: "moveKeyframes",
        startMouseX: e.clientX,
        groupBases: buildGroupBases(effective, getBlockForBases),
        gestureKey: nextGestureKey("drag"),
        stagger: e.altKey,
      });
      e.preventDefault();
      return;
    }

    // Hit the connector between two keyframes? Select the pair that
    // bounds the segment, and start a move on them — same gesture the
    // keyframes themselves get, so dragging the line slides both ends.
    // Shift merges the pair into the existing selection.
    const seg = hitTestSegment(contentX, contentY);
    if (seg) {
      const next = e.shiftKey
        ? [...selectionList, ...seg.filter((s) => !selection.has(selKey(s)))]
        : seg;
      setSelectionList(next);
      if (!e.shiftKey) {
        setDrag({
          kind: "moveKeyframes",
          startMouseX: e.clientX,
          groupBases: buildGroupBases(next, getBlockForBases),
          gestureKey: nextGestureKey("drag"),
          stagger: e.altKey,
        });
      }
      e.preventDefault();
      return;
    }

    // Empty space: begin marquee box-select. Shift = additive (the box's
    // keys merge into the selection on release).
    setDrag({
      kind: "marquee",
      startMouseX: mx,
      startMouseY: my,
      currentMouseX: mx,
      currentMouseY: my,
      additive: e.shiftKey,
    });
    if (!e.shiftKey) {
      setSelectionList([]);
    }
    e.preventDefault();
  }

  // Window-level pointermove/pointerup for active drag.
  useEffect(() => {
    if (drag.kind === "none") return;
    function onMove(e: PointerEvent) {
      const rect = lanesAreaRef.current?.getBoundingClientRect();
      if (!rect) return;
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      if (drag.kind === "pan") {
        const dx = e.clientX - drag.startMouseX;
        const dy = e.clientY - drag.startMouseY;
        setViewTickOffset(drag.startTickOffset - dx / pixelsPerTick);
        setScrollY(
          Math.max(0, Math.min(totalLanesHeight, drag.startScrollY - dy))
        );
        return;
      }
      if (drag.kind === "marquee") {
        setDrag({
          ...drag,
          currentMouseX: mx,
          currentMouseY: my,
        });
        return;
      }
      if (drag.kind === "moveKeyframes") {
        let deltaTicks = (e.clientX - drag.startMouseX) / pixelsPerTick;
        let snapToFrame = !e.shiftKey;
        // Proximity snap to the playhead: if any dragged key would land
        // within SNAP_PROXIMITY_PX of it, nudge the WHOLE delta so that
        // key lands exactly on it (the selection keeps its shape).
        // Suppressed by Option, and skipped for a stagger drag, where
        // the delta is a per-lane step rather than a position.
        // The tick is read imperatively off the clock store — this
        // editor deliberately doesn't subscribe at its top level.
        if (!e.altKey && !drag.stagger && pixelsPerTick > 0) {
          const playTick = playbackClock.get().tick;
          const tol = SNAP_PROXIMITY_PX / pixelsPerTick;
          let bestDelta: number | null = null;
          let bestD = Infinity;
          for (const base of drag.groupBases) {
            for (const t of base.selectedOriginalTicks) {
              const landed = t + deltaTicks;
              const d = Math.abs(landed - playTick);
              if (d <= tol && d < bestD) {
                bestD = d;
                bestDelta = deltaTicks + (playTick - landed);
              }
            }
          }
          if (bestDelta != null) {
            deltaTicks = bestDelta;
            // The delta is already exact; re-snapping to the frame grid
            // would drag it back off the playhead whenever the playhead
            // itself sits off-frame (a shift-scrub can park it there).
            snapToFrame = false;
          }
        }
        const opts = {
          snap: snapToFrame,
          ticksPerFrame: timeline.ticksPerFrame,
        };
        if (drag.stagger) {
          // Option/Alt held → stagger the selection across lanes; the
          // drag delta becomes the per-lane step.
          applyKeyframeOp(
            staggerKeyframesOp(
              orderBasesByLane(drag.groupBases),
              deltaTicks,
              opts
            ),
            drag.gestureKey
          );
        } else {
          applyKeyframeOp(
            moveKeyframes(drag.groupBases, deltaTicks, opts),
            drag.gestureKey
          );
        }
        return;
      }
      if (drag.kind === "scaleSelection") {
        applyKeyframeOp(
          scaleKeyframesOp(
            drag.groupBases,
            drag.anchorTick,
            drag.startEdgeTick,
            pxToTick(mx),
            { snap: !e.shiftKey, ticksPerFrame: timeline.ticksPerFrame }
          ),
          drag.gestureKey
        );
        return;
      }
      if (drag.kind === "clipMove") {
        const next = moveClipWindow(
          drag.startClips,
          drag.clipIndex,
          (e.clientX - drag.startMouseX) / pixelsPerTick,
          { snap: !e.shiftKey, ticksPerFrame: timeline.ticksPerFrame }
        );
        if (next) onClipChange?.(drag.nodeId, next);
        return;
      }
      if (drag.kind === "clipTrim") {
        const next = trimClipWindow(
          drag.startClips,
          drag.clipIndex,
          drag.side,
          pxToTick(mx),
          {
            snap: !e.shiftKey,
            ticksPerFrame: timeline.ticksPerFrame,
            slipsInTrim: drag.slipsInTrim,
            sourceDurationTicks: drag.sourceDurationTicks,
          }
        );
        if (next) onClipChange?.(drag.nodeId, next);
        return;
      }
    }
    function onUp() {
      if (drag.kind === "marquee") {
        const x0 = Math.min(drag.startMouseX, drag.currentMouseX);
        const x1 = Math.max(drag.startMouseX, drag.currentMouseX);
        const y0 = Math.min(drag.startMouseY, drag.currentMouseY);
        const y1 = Math.max(drag.startMouseY, drag.currentMouseY);
        // Convert screen-space rect to content-space.
        const cy0 = y0 + scrollY;
        const cy1 = y1 + scrollY;
        const t0 = pxToTick(x0);
        const t1 = pxToTick(x1);
        const tMin = Math.min(t0, t1);
        const tMax = Math.max(t0, t1);
        const newList: SelectionKey[] = [];
        for (let i = 0; i < lanes.length; i++) {
          const row = lanes[i];
          if (row.kind !== "paramLane") continue;
          const yTop = laneRowYs[i];
          const yBot = yTop + TRACK_HEIGHT;
          if (yBot < cy0 || yTop > cy1) continue;
          for (const kf of row.block.keyframes) {
            if (kf.tick >= tMin && kf.tick <= tMax) {
              newList.push({
                nodeId: row.nodeId,
                paramName: row.paramName,
                tick: kf.tick,
              });
            }
          }
        }
        if (drag.additive) {
          // Shift-marquee merges into the existing selection.
          const seen = new Set(selectionList.map(selKey));
          const merged = [...selectionList];
          for (const s of newList) {
            const k = selKey(s);
            if (!seen.has(k)) {
              seen.add(k);
              merged.push(s);
            }
          }
          setSelectionList(merged);
        } else {
          setSelectionList(newList);
        }
      }
      setDrag({ kind: "none" });
    }
    function onBlur() {
      // Cmd+Tab away mid-drag: the pointerup never arrives, so end the
      // gesture here instead of leaving it stuck until the next click.
      setDrag({ kind: "none" });
    }
    const win = panelWin ?? window;
    win.addEventListener("pointermove", onMove);
    win.addEventListener("pointerup", onUp);
    // iPadOS fires pointercancel instead of pointerup whenever the system
    // claims the gesture (scroll takeover, palm, backgrounding). Without
    // this the drag state machine stays latched after the finger lifts.
    win.addEventListener("pointercancel", onUp);
    win.addEventListener("blur", onBlur);
    return () => {
      win.removeEventListener("pointermove", onMove);
      win.removeEventListener("pointerup", onUp);
      win.removeEventListener("pointercancel", onUp);
      win.removeEventListener("blur", onBlur);
    };
    // The op appliers are plain per-render closures; the effect keys on
    // the drag/view state that actually changes gesture behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    drag,
    pixelsPerTick,
    totalLanesHeight,
    scrollY,
    pxToTick,
    laneRowYs,
    lanes,
    selectionList,
    panelWin,
  ]);

  // ---- Hover tracking for clip bars (styling + cursor) ----
  // Clip bars are pointer-events:none and hit-tested by coordinate, so we
  // derive hover from a mousemove on the lanes area. Skipped while a drag,
  // pan, or razor gesture owns the cursor.
  function onLanesHoverMove(e: React.MouseEvent) {
    if (drag.kind !== "none" || spaceDownRef.current || razorModeRef.current) {
      if (hoveredClip) setHoveredClip(null);
      return;
    }
    const rect = lanesAreaRef.current?.getBoundingClientRect();
    if (!rect) return;
    const contentX = e.clientX - rect.left;
    const contentY = e.clientY - rect.top + scrollY;
    const hit = hitTestClip(contentX, contentY);
    if (!hit) {
      if (hoveredClip) setHoveredClip(null);
      return;
    }
    if (
      hoveredClip &&
      hoveredClip.nodeId === hit.nodeId &&
      hoveredClip.clipIndex === hit.clipIndex &&
      hoveredClip.region === hit.region
    ) {
      return; // unchanged — avoid redundant re-render
    }
    setHoveredClip({
      nodeId: hit.nodeId,
      clipIndex: hit.clipIndex,
      region: hit.region,
    });
  }

  // ---- Right-click on a keyframe ----
  function onLanesContextMenu(e: React.MouseEvent) {
    const rect = lanesAreaRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const contentX = mx;
    const contentY = my + scrollY;
    const hit = hitTestKeyframe(contentX, contentY);
    if (!hit) return;
    e.preventDefault();
    // If the clicked keyframe is not in the selection, replace selection.
    if (!selection.has(selKey(hit.key))) {
      setSelectionList([hit.key]);
    }
    setMenu({ x: e.clientX, y: e.clientY, target: hit.key, submenu: null });
  }

  // Click-outside dismiss for menu.
  useEffect(() => {
    if (!menu) return;
    function onDown() {
      setMenu(null);
    }
    // Defer one tick so the original mousedown that opened the menu
    // doesn't immediately close it.
    const win = panelWin ?? window;
    const t = window.setTimeout(() => {
      win.addEventListener("mousedown", onDown);
    }, 0);
    return () => {
      window.clearTimeout(t);
      win.removeEventListener("mousedown", onDown);
    };
  }, [menu, panelWin]);

  // ---- Stagger from the dock header control ----
  // The control fires `keyframe-stagger-begin` (we snapshot a ≥2-lane
  // selection and report back), `keyframe-stagger` (apply step live),
  // and `keyframe-stagger-end`.
  const staggerBaseRef = useRef<{
    bases: GroupBase[];
    gestureKey: string;
  } | null>(null);
  useEffect(() => {
    const onBegin = (e: Event) => {
      const distinctLanes = new Set(
        selectionList.map((s) => laneKey(s.nodeId, s.paramName))
      );
      if (distinctLanes.size >= 2) {
        staggerBaseRef.current = {
          bases: orderBasesByLane(
            buildGroupBases(selectionList, getBlockForBases)
          ),
          gestureKey: nextGestureKey("stagger"),
        };
        (e as CustomEvent).detail?.respond?.(true);
      } else {
        staggerBaseRef.current = null;
      }
    };
    const onStep = (e: Event) => {
      const base = staggerBaseRef.current;
      if (!base) return;
      const ticks = (e as CustomEvent<{ stepTicks: number }>).detail?.stepTicks;
      if (typeof ticks === "number") {
        applyKeyframeOp(
          staggerKeyframesOp(base.bases, ticks, {
            snap: true,
            ticksPerFrame: timeline.ticksPerFrame,
          }),
          base.gestureKey
        );
      }
    };
    const onEnd = () => {
      staggerBaseRef.current = null;
    };
    // The stagger control broadcasts to every window
    // (broadcastAppEvent), so this listens on its own — whichever that
    // is — and hears the control wherever IT lives.
    const win = panelWin ?? window;
    win.addEventListener("keyframe-stagger-begin", onBegin);
    win.addEventListener("keyframe-stagger", onStep);
    win.addEventListener("keyframe-stagger-end", onEnd);
    return () => {
      win.removeEventListener("keyframe-stagger-begin", onBegin);
      win.removeEventListener("keyframe-stagger", onStep);
      win.removeEventListener("keyframe-stagger-end", onEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionList, panelWin]);

  // ---- Proximity snapping (playhead ↔ keyframes) ----
  // Every keyframe tick on the VISIBLE lanes, deduped and sorted — the
  // targets a playhead scrub can snap onto.
  const laneKeyTicks = useMemo(() => {
    const ticks = new Set<number>();
    for (const row of lanes) {
      if (row.kind !== "paramLane") continue;
      for (const k of row.block.keyframes) ticks.add(k.tick);
    }
    return Array.from(ticks).sort((a, b) => a - b);
  }, [lanes]);

  /**
   * The keyframe tick to snap a scrub onto, or null when none is within
   * SNAP_PROXIMITY_PX. The tolerance converts px→ticks through the live
   * zoom, so the pull is a constant on-screen distance.
   */
  const snapScrubToKeyframe = useCallback(
    (rawTick: number): number | null => {
      if (pixelsPerTick <= 0) return null;
      const tol = SNAP_PROXIMITY_PX / pixelsPerTick;
      let best: number | null = null;
      let bestD = Infinity;
      for (const t of laneKeyTicks) {
        const d = Math.abs(t - rawTick);
        if (d <= tol && d < bestD) {
          bestD = d;
          best = t;
        }
      }
      return best;
    },
    [laneKeyTicks, pixelsPerTick]
  );

  /**
   * Resolve a scrub position: proximity-snap to a keyframe first (it
   * wins over frame snapping, and is exact — so a keyframe parked
   * off-frame by a shift-drag is still reachable), otherwise fall back
   * to the frame grid unless Shift. Option/Alt suppresses the proximity
   * pull entirely.
   */
  const resolveScrubTick = useCallback(
    (rawTick: number, e: { shiftKey: boolean; altKey: boolean }): number => {
      if (!e.altKey) {
        const onKey = snapScrubToKeyframe(rawTick);
        if (onKey != null) return Math.max(0, Math.round(onKey));
      }
      const tick = e.shiftKey
        ? rawTick
        : snapTickToFrame(rawTick, timeline.ticksPerFrame);
      return Math.max(0, Math.round(tick));
    },
    [snapScrubToKeyframe, timeline.ticksPerFrame]
  );

  // ---- Ruler scrub ----
  // Clamped at 0 — the playhead can't be dragged into negative time.
  function onRulerPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mx = e.clientX - rect.left;
    onScrub(resolveScrubTick(pxToTick(mx), e));
    setDrag({ kind: "scrub" });
  }

  useEffect(() => {
    if (drag.kind !== "scrub") return;
    function onMove(e: PointerEvent) {
      const rect = lanesAreaRef.current?.getBoundingClientRect();
      if (!rect) return;
      const mx = e.clientX - rect.left;
      onScrub(resolveScrubTick(pxToTick(mx), e));
    }
    function onUp() {
      setDrag({ kind: "none" });
    }
    const win = panelWin ?? window;
    win.addEventListener("pointermove", onMove);
    win.addEventListener("pointerup", onUp);
    win.addEventListener("pointercancel", onUp);
    win.addEventListener("blur", onUp);
    return () => {
      win.removeEventListener("pointermove", onMove);
      win.removeEventListener("pointerup", onUp);
      win.removeEventListener("pointercancel", onUp);
      win.removeEventListener("blur", onUp);
    };
  }, [drag.kind, pxToTick, onScrub, resolveScrubTick, panelWin]);

  // ---- Ruler tick spacing (shared 1/2/5 ladder) ----
  const rulerSpacing = useMemo(
    () => computeRulerSpacing(pixelsPerTick, timeline.ticksPerFrame),
    [pixelsPerTick, timeline.ticksPerFrame]
  );

  // ---- Render ----

  // Cursor over the lanes content: space-pan and razor win first; then the
  // active clip drag; then clip hover (edge grips → resize, body → grab).
  const lanesCursor = spaceDown
    ? drag.kind === "pan"
      ? "grabbing"
      : "grab"
    : razorMode
      ? "crosshair"
      : drag.kind === "clipTrim"
        ? "ew-resize"
        : drag.kind === "clipMove"
          ? "grabbing"
          : hoveredClip
            ? hoveredClip.region === "body"
              ? "grab"
              : "ew-resize"
            : "default";

  const lanesViewportHeight = "100%"; // governed by parent layout

  return (
    <div
      ref={containerRef}
      data-track-editor="true"
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        background: COLOR_BG,
        color: COLOR_TEXT,
        // Match the Layers editor's typography — the two timeline
        // surfaces should read as one family.
        font: "10px/1.2 var(--ui-font)",
        // tabIndex below is only there to capture keyboard shortcuts;
        // the browser's focus ring on a whole editor pane reads as a
        // stray blue box around the panel, so suppress it.
        outline: "none",
        display: "flex",
        flexDirection: "column",
        userSelect: "none",
        overflow: "hidden",
        cursor: spaceDown ? "grab" : razorMode ? "crosshair" : "default",
      }}
      onMouseEnter={() => {
        hoveredRef.current = true;
      }}
      onMouseLeave={() => {
        hoveredRef.current = false;
      }}
      onMouseDown={(e) => {
        // Focus container so keyboard works without explicit click.
        (e.currentTarget as HTMLDivElement).focus();
      }}
      tabIndex={0}
    >
      {/* Ruler row — spans the full width; labels float over the left. */}
      <div
        style={{
          height: RULER_HEIGHT,
          minHeight: RULER_HEIGHT,
          display: "flex",
          borderBottom: "1px solid var(--tb-n-5)",
        }}
      >
        <div
          onPointerDown={onRulerPointerDown}
          onMouseMove={(e) => {
            // Measure against the lanes viewport so the preview lines up
            // with the playhead's coordinate space (shared column origin).
            if (drag.kind !== "none") return;
            const rect = lanesAreaRef.current?.getBoundingClientRect();
            if (rect) setHoverLineX(e.clientX - rect.left);
          }}
          onMouseLeave={() => setHoverLineX(null)}
          style={{
            position: "relative",
            flex: 1,
            cursor: "ew-resize",
            overflow: "hidden",
            // The ruler owns the scrub gesture — opt out of browser panning
            // so iPadOS can't cancel the drag to scroll an ancestor.
            touchAction: "none",
          }}
        >
          <Ruler
            width={lanesAreaWidth}
            height={RULER_HEIGHT}
            tickToPx={tickToPx}
            pxToTick={pxToTick}
            timeline={timeline}
            majorFrames={rulerSpacing.majorFrames}
            minorFrames={rulerSpacing.minorFrames}
          />
          {/* Hover preview within the ruler — continues the lanes line up
              through the time markers. */}
          <HoverLine ref={rulerHoverRef} />
          {/* Playhead handle (self-subscribing leaf) */}
          <PlayheadHandle
            tickToPx={tickToPx}
            onStartScrub={() => setDrag({ kind: "scrub" })}
          />
        </div>
      </div>

      {/* Lanes area. The vertical padding is what insets the gutter card
          top and bottom: it moves the in-flow lanes viewport down by the
          same amount the absolutely-positioned card is offset, so the two
          content origins stay identical and every label keeps sitting on
          its own lane. Everything that hit-tests measures against the
          lanes viewport's own rect, so the offset needs no other edits. */}
      <div
        style={{
          flex: 1,
          display: "flex",
          minHeight: 0,
          position: "relative",
          overflow: "hidden",
          height: lanesViewportHeight,
          paddingTop: GUTTER_INSET,
          paddingBottom: GUTTER_INSET,
        }}
      >
        {/* Left label column — an inset rounded card floating over the
            full-width timeline. The 1px frame is an INSET box-shadow, not
            a border: a real border would shift this card's absolutely-
            positioned contents down a pixel relative to the lanes and
            break the row alignment. The frame is a separate overlay at
            the end of this element — an inset shadow set here would paint
            UNDER the rows, and a selected row's opaque fill would cover
            it. */}
        <div
          style={{
            position: "absolute",
            left: GUTTER_INSET,
            top: GUTTER_INSET,
            bottom: GUTTER_INSET,
            zIndex: 2,
            width: PARAM_LABEL_WIDTH,
            minWidth: PARAM_LABEL_WIDTH,
            background: COLOR_GUTTER_BG,
            borderRadius: GUTTER_RADIUS,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              position: "absolute",
              top: -scrollY,
              left: 0,
              right: 0,
            }}
          >
            {lanes.map((row) => {
              if (row.kind === "nodeHeader") {
                return (
                  <div
                    key={`nh:${row.nodeId}`}
                    onClick={() => {
                      onSelectNode?.(row.nodeId);
                      onToggleCollapsed?.(row.nodeId);
                    }}
                    style={{
                      height: NODE_HEADER_HEIGHT,
                      display: "flex",
                      alignItems: "center",
                      padding: "0 8px 0 4px",
                      gap: 4,
                      background: row.selected ? "var(--tb-n-2)" : "transparent",
                      borderBottom: `1px solid ${COLOR_LANE_SEP}`,
                      cursor: "pointer",
                      fontSize: 10,
                    }}
                  >
                    {/* Collapse chevron — same glyph the Layers editor
                        uses, rotated when open. */}
                    <span
                      style={{
                        width: 14,
                        height: 14,
                        flexShrink: 0,
                        color: COLOR_GUTTER_CHEVRON,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        transform: row.collapsed ? "none" : "rotate(90deg)",
                        transition: "transform 120ms",
                      }}
                    >
                      <svg
                        width={9}
                        height={9}
                        viewBox="0 0 9 9"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={1.4}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M3 1.5 L6 4.5 L3 7.5" />
                      </svg>
                    </span>
                    <span
                      style={{
                        // Dimmed against the card so the lanes and their
                        // keyframes stay the brightest thing on screen.
                        color: row.selected ? "var(--tb-n-14)" : COLOR_GUTTER_TEXT_STRONG,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        flex: 1,
                      }}
                    >
                      {row.nodeName}
                    </span>
                    <span style={{ color: COLOR_MUTED, fontSize: 10 }}>
                      {row.visibleParamCount}
                    </span>
                  </div>
                );
              }
              const isVecBadge =
                row.paramType === "vec2" ||
                row.paramType === "vec3" ||
                row.paramType === "vec4";
              const badge = isVecBadge ? row.paramType : null;
              const isScalarTrack = row.paramType === "scalar";
              const graphOn = !!row.block.graphVisible;
              // This lane's anchor is selected on the Spline Draw canvas
              // — a marker so it's obvious which lane is which anchor.
              const anchorLit = isAnchorHighlighted(row.nodeId, row.paramName);
              return (
                <div
                  key={`pl:${row.nodeId}:${row.paramName}`}
                  onClick={() => onSelectNode?.(row.nodeId)}
                  style={{
                    height: TRACK_HEIGHT,
                    display: "flex",
                    alignItems: "center",
                    padding: "0 8px 0 10px",
                    gap: 8,
                    borderBottom: `1px solid ${COLOR_LANE_SEP}`,
                    background: anchorLit
                      ? ANCHOR_HIGHLIGHT_BG
                      : row.selected
                        ? "color-mix(in srgb, var(--tb-lift) 4%, transparent)"
                        : undefined,
                    // A stripe on the card's inner edge, so the link reads
                    // even when the row is scrolled and the label clipped.
                    boxShadow: anchorLit
                      ? `inset 2px 0 0 0 ${ANCHOR_HIGHLIGHT_EDGE}`
                      : undefined,
                    cursor: "pointer",
                  }}
                >
                  <DiamondNav
                    block={row.block}
                    onToggle={() =>
                      toggleKeyAtPlayhead(
                        row.nodeId,
                        row.paramName,
                        row.paramType
                      )
                    }
                    onSeek={onScrub}
                  />
                  <span
                    style={{
                      color: COLOR_GUTTER_TEXT,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      flex: 1,
                      fontSize: 10,
                    }}
                  >
                    {row.paramLabel}
                  </span>
                  {badge && (
                    <span
                      style={{
                        background: "var(--tb-n-5)",
                        color: COLOR_MUTED,
                        border: `1px solid ${COLOR_BORDER}`,
                        borderRadius: 2,
                        padding: "0 4px",
                        fontSize: 9,
                        textTransform: "uppercase",
                      }}
                    >
                      {badge}
                    </span>
                  )}
                  {isScalarTrack && (
                    <button
                      type="button"
                      title={
                        graphOn
                          ? "Hide curve in Graph Editor"
                          : "Show curve in Graph Editor"
                      }
                      onClick={() =>
                        onAnimationChange(row.nodeId, row.paramName, {
                          ...row.block,
                          graphVisible: !graphOn,
                        })
                      }
                      style={{
                        background: graphOn ? COLOR_ACCENT : "transparent",
                        color: graphOn ? "#fff" : COLOR_MUTED,
                        border: `1px solid ${COLOR_BORDER}`,
                        borderRadius: 2,
                        cursor: "pointer",
                        fontSize: 10,
                        padding: "0 4px",
                        lineHeight: "16px",
                      }}
                    >
                      {"∿"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {/* The card's stroke, above the scrolled rows — so a selected
              row's fill passes behind the frame instead of over it. */}
          <div
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: GUTTER_RADIUS,
              boxShadow: `inset 0 0 0 1px ${COLOR_GUTTER_BORDER}`,
              pointerEvents: "none",
              zIndex: 1,
            }}
          />
        </div>

        {/* Lanes content (scrollable, scrubbable) */}
        <div
          ref={lanesAreaRef}
          onPointerDown={onLanesPointerDown}
          onMouseMove={(e) => {
            onLanesHoverMove(e);
            if (drag.kind !== "none") return;
            const rect = lanesAreaRef.current?.getBoundingClientRect();
            if (rect) setHoverLineX(e.clientX - rect.left);
          }}
          onMouseLeave={() => {
            if (hoveredClip) setHoveredClip(null);
            setHoverLineX(null);
          }}
          onContextMenu={onLanesContextMenu}
          style={{
            position: "relative",
            flex: 1,
            overflow: "hidden",
            cursor: lanesCursor,
            // Keyframe drags, marquee and clip moves all start here — the
            // lanes own their gestures rather than letting iPadOS pan.
            touchAction: "none",
          }}
        >
          {/* Frame-division grid. A FIXED backdrop — outside the scrolled
              content, and first in the DOM so every lane, clip bar and
              keyframe paints over it. */}
          <LaneFrameTicks
            width={lanesAreaWidth}
            tickToPx={tickToPx}
            pxToTick={pxToTick}
            ticksPerFrame={timeline.ticksPerFrame}
            majorFrames={rulerSpacing.majorFrames}
            minorFrames={rulerSpacing.minorFrames}
          />
          {/* Inner scrollable content */}
          <div
            style={{
              position: "absolute",
              top: -scrollY,
              left: 0,
              width: "100%",
              height: totalLanesHeight,
            }}
          >
            {lanes.map((row, i) => {
              const yTop = laneRowYs[i];
              if (row.kind === "nodeHeader") {
                // Clip bars. Each window → a solid teal bar across [in, out]
                // with edge grips. A clippable node with no windows → a faint
                // full-duration ghost the user can grab to create one.
                let clipBar: React.ReactNode = null;
                if (row.clippable) {
                  const windows =
                    row.clips && row.clips.length > 0 ? row.clips : null;
                  if (!windows) {
                    const leftPx = tickToPx(0);
                    const widthPx = Math.max(
                      2,
                      tickToPx(timeline.sceneDurationTicks) - leftPx
                    );
                    const ghostHover = hoveredClip?.nodeId === row.nodeId;
                    clipBar = (
                      <div
                        style={{
                          position: "absolute",
                          left: leftPx,
                          top: 3,
                          width: widthPx,
                          height: NODE_HEADER_HEIGHT - 7,
                          background: ghostHover
                            ? COLOR_CLIP_GHOST_HOVER
                            : COLOR_CLIP_GHOST,
                          border: `1px solid ${
                            ghostHover
                              ? COLOR_CLIP_GHOST_BORDER_HOVER
                              : COLOR_CLIP_GHOST_BORDER
                          }`,
                          borderRadius: 3,
                          boxSizing: "border-box",
                          pointerEvents: "none",
                          transition:
                            "background 90ms ease, border-color 90ms ease",
                        }}
                      />
                    );
                  } else {
                    clipBar = windows.map((c, ci) => {
                      const leftPx = tickToPx(c.inTick);
                      const widthPx = Math.max(2, tickToPx(c.outTick) - leftPx);
                      const isSelected =
                        selectedClip?.nodeId === row.nodeId &&
                        selectedClip.clipIndex === ci;
                      const isHovered =
                        hoveredClip?.nodeId === row.nodeId &&
                        hoveredClip.clipIndex === ci;
                      const hoverRegion = isHovered ? hoveredClip!.region : null;
                      const fill = isSelected
                        ? COLOR_CLIP_FILL_SELECTED
                        : isHovered
                          ? COLOR_CLIP_FILL_HOVER
                          : COLOR_CLIP_FILL;
                      const borderCol = isSelected
                        ? COLOR_CLIP_BORDER_SELECTED
                        : COLOR_CLIP_BORDER;
                      const gripCol = (active: boolean) =>
                        active
                          ? COLOR_CLIP_HANDLE_HOVER
                          : isSelected
                            ? COLOR_CLIP_BORDER_SELECTED
                            : COLOR_CLIP_HANDLE;
                      return (
                        <div
                          key={`clip:${row.nodeId}:${ci}`}
                          style={{
                            position: "absolute",
                            left: leftPx,
                            top: 3,
                            width: widthPx,
                            height: NODE_HEADER_HEIGHT - 7,
                            background: fill,
                            border: `1px solid ${borderCol}`,
                            borderRadius: 3,
                            boxSizing: "border-box",
                            pointerEvents: "none",
                            boxShadow: isSelected
                              ? `0 0 0 1px ${COLOR_CLIP_BORDER_SELECTED}55`
                              : undefined,
                            transition:
                              "background 90ms ease, border-color 90ms ease",
                          }}
                        >
                          {/* Edge grips — lit when the cursor is over them. */}
                          <div
                            style={{
                              position: "absolute",
                              left: 0,
                              top: 0,
                              bottom: 0,
                              width: hoverRegion === "in" ? 4 : 3,
                              background: gripCol(hoverRegion === "in"),
                              borderTopLeftRadius: 3,
                              borderBottomLeftRadius: 3,
                            }}
                          />
                          <div
                            style={{
                              position: "absolute",
                              right: 0,
                              top: 0,
                              bottom: 0,
                              width: hoverRegion === "out" ? 4 : 3,
                              background: gripCol(hoverRegion === "out"),
                              borderTopRightRadius: 3,
                              borderBottomRightRadius: 3,
                            }}
                          />
                        </div>
                      );
                    });
                  }
                }
                return (
                  <div
                    key={`lnh:${row.nodeId}`}
                    style={{
                      position: "absolute",
                      top: yTop,
                      left: 0,
                      right: 0,
                      height: NODE_HEADER_HEIGHT,
                      // Translucent, not a ramp colour: this row spans
                      // the full lane width, and an opaque fill blanks
                      // the frame grid behind it.
                      background: row.selected
                        ? COLOR_LANE_SELECTED_BG
                        : "transparent",
                      borderBottom: `1px solid ${COLOR_LANE_SEP}`,
                    }}
                  >
                    {clipBar}
                  </div>
                );
              }
              return (
                <ParamLane
                  key={`lp:${row.nodeId}:${row.paramName}`}
                  row={row}
                  yTop={yTop}
                  height={TRACK_HEIGHT}
                  viewWidth={lanesAreaWidth}
                  tickToPx={tickToPx}
                  selection={selection}
                  anchorLit={isAnchorHighlighted(row.nodeId, row.paramName)}
                />
              );
            })}

            {/* Selection bounding box (drawn over the lanes) */}
            {selectionBox && (
              <SelectionBox
                box={selectionBox}
                tickToPx={tickToPx}
                laneRowYs={laneRowYs}
                lanes={lanes}
              />
            )}
          </div>

          {/* Hover preview — a faded playhead line that tracks the cursor.
              Hidden during any drag (scrub already moves the real one). */}
          <HoverLine ref={lanesHoverRef} />

          {/* Playhead vertical line (self-subscribing leaf) */}
          <PlayheadLine tickToPx={tickToPx} />

          {/* Marquee */}
          {drag.kind === "marquee" && (
            <div
              style={{
                position: "absolute",
                left: Math.min(drag.startMouseX, drag.currentMouseX),
                top: Math.min(drag.startMouseY, drag.currentMouseY),
                width: Math.abs(drag.currentMouseX - drag.startMouseX),
                height: Math.abs(drag.currentMouseY - drag.startMouseY),
                background: MARQUEE_FILL,
                border: MARQUEE_BORDER,
                pointerEvents: "none",
              }}
            />
          )}
        </div>
      </div>

      {/* Inspector strip (only with selection) */}
      {selectionList.length > 0 && (
        <div
          style={{
            height: INSPECTOR_HEIGHT,
            minHeight: INSPECTOR_HEIGHT,
            borderTop: `1px solid ${COLOR_BORDER}`,
            background: "var(--tb-n-1)",
            display: "flex",
            alignItems: "center",
            padding: "0 8px",
            gap: 12,
            fontSize: 11,
          }}
        >
          <div style={{ color: COLOR_MUTED }}>
            {selectionList.length} keyframe
            {selectionList.length === 1 ? "" : "s"} selected
          </div>
          <div style={{ flex: 1 }} />
          <label style={{ color: COLOR_MUTED }}>easing:</label>
          <EasingPickerButton
            value={(() => {
              // Show the easing of the most-recently selected keyframe.
              const last = selectionList[selectionList.length - 1];
              const kf = blockIndex
                .get(last.nodeId)
                ?.get(last.paramName)
                ?.keyframes.find((k) => k.tick === last.tick);
              return kf?.easingOut ?? "easeInOut";
            })()}
            allScalar={selectionTypes.allScalar}
            onPick={(p) => setKeyframeEasing(selectionList, p)}
          />
          <button
            type="button"
            onClick={deleteSelected}
            style={{
              background: "transparent",
              color: COLOR_TEXT,
              border: `1px solid ${COLOR_BORDER}`,
              borderRadius: 2,
              padding: "2px 8px",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            delete
          </button>
        </div>
      )}

      {/* Razor-tool indicator */}
      {razorMode && (
        <div
          style={{
            position: "absolute",
            top: RULER_HEIGHT + 4,
            right: 8,
            zIndex: 5,
            background: COLOR_CLIP_FILL_SELECTED,
            color: "var(--tb-t-cyan-l-1)",
            border: `1px solid ${COLOR_CLIP_BORDER_SELECTED}`,
            borderRadius: 3,
            padding: "1px 6px",
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: 0.3,
            pointerEvents: "none",
          }}
        >
          RAZOR — click a clip to split · C/V to switch
        </div>
      )}

      {/* Context menu */}
      {menu && (
        <ContextMenuView
          menu={menu}
          onClose={() => setMenu(null)}
          onDelete={() => {
            // If the right-clicked keyframe wasn't already in the selection
            // we replaced selection on context-down; either way, delete.
            deleteSelected();
            setMenu(null);
          }}
          onSetEasing={(p) => {
            setKeyframeEasing(selectionList, p);
            setMenu(null);
          }}
          allScalar={selectionTypes.allScalar}
          stepOnly={selectionTypes.stepOnly}
        />
      )}
    </div>
  );
}

export default TrackEditor;

// ---------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------

interface RulerProps {
  width: number;
  height: number;
  tickToPx: (tick: number) => number;
  pxToTick: (px: number) => number;
  timeline: ProjectTimeline;
  majorFrames: number;
  minorFrames: number;
}

function Ruler(props: RulerProps) {
  const { width, height, tickToPx, pxToTick, timeline, majorFrames, minorFrames } =
    props;
  const startTick = pxToTick(0);
  const endTick = pxToTick(width);
  const startFrame = Math.floor(startTick / timeline.ticksPerFrame);
  const endFrame = Math.ceil(endTick / timeline.ticksPerFrame);
  // Layers-editor-style ruler: a bordered cell per major frame with the
  // frame number inside, vertically centered — no tick stubs or seconds
  // suffix, so Tracks and Layers read as one surface.
  const cells: { x: number; frame: number }[] = [];
  const firstMajor = Math.ceil(startFrame / majorFrames) * majorFrames;
  for (let f = firstMajor; f <= endFrame; f += majorFrames) {
    const x = tickToPx(f * timeline.ticksPerFrame);
    if (x < -40 || x > width + 40) continue;
    cells.push({ x, frame: f });
  }
  return (
    <svg
      width={width}
      height={height}
      style={{ display: "block", pointerEvents: "none" }}
    >
      {/* Minor divisions as short stubs off the bottom edge, on the same
          1/2/5 ladder as the numbers — drawn first so the numbered
          majors below paint over them. */}
      <RulerFrameStubs
        width={width}
        height={height}
        tickToPx={tickToPx}
        pxToTick={pxToTick}
        ticksPerFrame={timeline.ticksPerFrame}
        majorFrames={majorFrames}
        minorFrames={minorFrames}
      />
      {cells.map((t) => (
        <g key={t.frame}>
          <line
            x1={t.x}
            x2={t.x}
            y1={0}
            y2={height}
            stroke={COLOR_RULER_TICK}
            strokeWidth={1}
          />
          <text
            x={t.x + 4}
            y={height / 2 + 3}
            fontSize={9}
            // style, not the presentation attribute — var() only resolves
            // through the CSS cascade.
            style={{ fontFamily: "var(--ui-font)" }}
            fill={COLOR_RULER_TEXT}
          >
            {t.frame}
          </text>
        </g>
      ))}
    </svg>
  );
}

interface ParamLaneProps {
  row: Extract<LaneRow, { kind: "paramLane" }>;
  yTop: number;
  height: number;
  // Viewport width for culling off-screen keyframes/segments.
  viewWidth: number;
  tickToPx: (tick: number) => number;
  selection: Set<string>;
  /** This lane's Spline Draw anchor is selected on the canvas. */
  anchorLit?: boolean;
}

function ParamLane(props: ParamLaneProps) {
  const { row, yTop, height, viewWidth, tickToPx, selection, anchorLit } =
    props;
  const isColor = row.paramType === "color";
  // Hover is tracked per-lane rather than lifted to the editor: the
  // diamonds are pointerEvents:none (the lanes container owns every
  // click), so this re-derives the same KEY_HIT_PX rule the hit test
  // uses and re-renders only the one lane the cursor is over.
  const [hoverTick, setHoverTick] = useState<number | null>(null);
  const [hoverSeg, setHoverSeg] = useState<number | null>(null);
  const onHover = (e: React.MouseEvent) => {
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
    const kfs = row.block.keyframes;
    let bestTick: number | null = null;
    let bestD = Infinity;
    for (const k of kfs) {
      const d = Math.abs(tickToPx(k.tick) - x);
      if (d <= KEY_HIT_PX && d < bestD) {
        bestD = d;
        bestTick = k.tick;
      }
    }
    let seg: number | null = null;
    if (bestTick == null && Math.abs(y - height / 2) <= SEGMENT_HIT_PX) {
      for (let i = 1; i < kfs.length; i++) {
        if (
          x > tickToPx(kfs[i - 1].tick) + KEY_HIT_PX &&
          x < tickToPx(kfs[i].tick) - KEY_HIT_PX
        ) {
          seg = i;
          break;
        }
      }
    }
    if (bestTick !== hoverTick) setHoverTick(bestTick);
    if (seg !== hoverSeg) setHoverSeg(seg);
  };
  const clearHover = () => {
    if (hoverTick !== null) setHoverTick(null);
    if (hoverSeg !== null) setHoverSeg(null);
  };
  return (
    <div
      onMouseMove={onHover}
      onMouseLeave={clearHover}
      style={{
        position: "absolute",
        top: yTop,
        left: 0,
        right: 0,
        height,
        borderBottom: `1px solid ${COLOR_LANE_SEP}`,
        // Faint white wash + a top stroke when this lane belongs to
        // the currently-selected node — pairs with the left-stripe
        // on the label gutter to make the active row read as one
        // continuous selection across the full editor width. The anchor
        // highlight wins: it's answering a narrower question ("which
        // lane is the anchor I just clicked on canvas?").
        background: anchorLit
          ? ANCHOR_HIGHLIGHT_BG
          : row.selected
            ? COLOR_LANE_SELECTED_BG
            : undefined,
        borderTop: row.selected
          ? "1px solid color-mix(in srgb, var(--tb-lift) 50%, transparent)"
          : undefined,
      }}
    >
      {isColor ? (
        <ColorRamp keyframes={row.block.keyframes} tickToPx={tickToPx} height={height} />
      ) : null}
      {/* Easing connector lines between consecutive keyframes */}
      {row.block.keyframes.map((k, i) => {
        if (i === 0) return null;
        const prev = row.block.keyframes[i - 1];
        const x0 = tickToPx(prev.tick);
        const x1 = tickToPx(k.tick);
        if (x1 < -20 || x0 > viewWidth + 20) return null;
        const isHold = prev.easingOut === "hold";
        const segHovered = hoverSeg === i;
        // Dashed where the value CHANGES across the segment, solid where
        // it holds — so a track's actual motion reads at a glance.
        const changes = !keyframeValuesEqual(prev.value, k.value);
        const color = segHovered
          ? COLOR_SEGMENT_HOVER
          : isHold
            ? COLOR_SEGMENT_HOLD
            : COLOR_SEGMENT;
        return (
          <div
            key={`seg:${prev.tick}:${k.tick}`}
            style={{
              position: "absolute",
              top: height / 2 - 0.5,
              left: x0,
              width: x1 - x0,
              // A border (not a background) so the dash pattern renders;
              // the box itself collapses to zero height.
              height: 0,
              borderTop: `1px ${changes ? "dashed" : "solid"} ${color}`,
              opacity: isColor ? 0 : segHovered ? 1 : 0.6,
              pointerEvents: "none",
            }}
          />
        );
      })}
      {/* Diamond keyframes (skipped for color; ramp stops are visual instead) */}
      {!isColor &&
        row.block.keyframes.map((k) => {
          const x = tickToPx(k.tick);
          if (x < -20 || x > viewWidth + 20) return null;
          const isSel = selection.has(
            selKey({ nodeId: row.nodeId, paramName: row.paramName, tick: k.tick })
          );
          const isHover = !isSel && hoverTick === k.tick;
          const size = Math.max(4, Math.min(KEY_SIZE, height * 0.24));
          return (
            <div
              key={`kf:${k.tick}`}
              style={{
                position: "absolute",
                left: x - size / 2,
                top: height / 2 - size / 2,
                width: size,
                height: size,
                // Hover scales about the diamond's own centre, so the
                // key never appears to move off its tick.
                transform: `rotate(45deg) scale(${isHover ? 1.25 : 1})`,
                // Selection changes the OUTLINE only — the amber fill is
                // constant so a selected key still reads as a keyframe.
                background: isHover ? COLOR_DIAMOND_HOVER : COLOR_DIAMOND,
                border: `1px solid ${
                  isSel
                    ? COLOR_DIAMOND_SELECTED_BORDER
                    : isHover
                      ? COLOR_DIAMOND_HOVER_BORDER
                      : COLOR_DIAMOND_BORDER
                }`,
                transition: "transform 90ms, background 90ms",
                pointerEvents: "none",
              }}
            />
          );
        })}
      {/* Color ramp's keyframe stop indicators */}
      {isColor &&
        row.block.keyframes.map((k) => {
          const x = tickToPx(k.tick);
          if (x < -20 || x > viewWidth + 20) return null;
          const isSel = selection.has(
            selKey({ nodeId: row.nodeId, paramName: row.paramName, tick: k.tick })
          );
          return (
            <div
              key={`cs:${k.tick}`}
              style={{
                position: "absolute",
                left: x - 1,
                top: 2,
                width: 2,
                height: height - 4,
                background: isSel ? "#fff" : "color-mix(in srgb, var(--tb-lift) 50%, transparent)",
                outline: isSel ? `1px solid ${COLOR_ACCENT}` : "none",
                pointerEvents: "none",
              }}
            />
          );
        })}
    </div>
  );
}

interface ColorRampProps {
  keyframes: Keyframe[];
  tickToPx: (tick: number) => number;
  height: number;
}

function ColorRamp(props: ColorRampProps) {
  const { keyframes, tickToPx, height } = props;
  if (keyframes.length === 0) return null;
  // Build a CSS linear-gradient between adjacent stops, paired with absolute
  // x positions so we can size and position a single gradient div spanning
  // first..last keyframe ticks. (v1: simple per-segment gradient div.)
  const segments: { x: number; w: number; from: string; to: string }[] = [];
  for (let i = 0; i < keyframes.length - 1; i++) {
    const a = keyframes[i];
    const b = keyframes[i + 1];
    const x0 = tickToPx(a.tick);
    const x1 = tickToPx(b.tick);
    segments.push({
      x: x0,
      w: Math.max(0, x1 - x0),
      from: rgbaToCss(a.value),
      to: rgbaToCss(b.value),
    });
  }
  // Edge clamp: solid swatch before first and after last.
  const first = keyframes[0];
  const last = keyframes[keyframes.length - 1];
  return (
    <>
      {/* before first */}
      <div
        style={{
          position: "absolute",
          left: -10000,
          width: tickToPx(first.tick) + 10000,
          top: 4,
          height: height - 8,
          background: rgbaToCss(first.value),
          opacity: 0.6,
        }}
      />
      {segments.map((s, i) => (
        <div
          key={`grad:${i}`}
          style={{
            position: "absolute",
            left: s.x,
            width: s.w,
            top: 4,
            height: height - 8,
            background: `linear-gradient(to right, ${s.from}, ${s.to})`,
          }}
        />
      ))}
      {/* after last */}
      <div
        style={{
          position: "absolute",
          left: tickToPx(last.tick),
          width: 10000,
          top: 4,
          height: height - 8,
          background: rgbaToCss(last.value),
          opacity: 0.6,
        }}
      />
    </>
  );
}

function rgbaToCss(value: unknown): string {
  // Color keyframes store [r,g,b,a] in 0..1 (per keyframes.ts color path).
  if (Array.isArray(value) && value.length >= 3) {
    const r = Math.round(Math.max(0, Math.min(1, Number(value[0]))) * 255);
    const g = Math.round(Math.max(0, Math.min(1, Number(value[1]))) * 255);
    const b = Math.round(Math.max(0, Math.min(1, Number(value[2]))) * 255);
    const a = value.length >= 4 ? Math.max(0, Math.min(1, Number(value[3]))) : 1;
    return `rgba(${r},${g},${b},${a})`;
  }
  return "var(--tb-n-12)";
}

interface SelectionBoxProps {
  box: { minTick: number; maxTick: number; minRow: number; maxRow: number };
  tickToPx: (tick: number) => number;
  laneRowYs: number[];
  lanes: LaneRow[];
}

function SelectionBox(props: SelectionBoxProps) {
  const { box, tickToPx, laneRowYs, lanes } = props;
  const leftRaw = tickToPx(box.minTick);
  const rightRaw = tickToPx(box.maxTick);
  const yTop = (laneRowYs[box.minRow] ?? 0) - 2;
  const lastRow = lanes[box.maxRow];
  const yBot =
    (laneRowYs[box.maxRow] ?? 0) +
    (lastRow?.kind === "nodeHeader" ? NODE_HEADER_HEIGHT : TRACK_HEIGHT) +
    2;
  const EDGE = 6;
  const naturalW = rightRaw - leftRaw;
  const degenerate = naturalW < 2 * EDGE + 2;
  // When degenerate, widen the visual box laterally around the shared
  // column so the user has a clear strip to grab. The mousedown handler
  // already extends the interior hit zone the same way.
  const PAD = degenerate ? 8 : 0;
  const left = leftRaw - PAD;
  const w = Math.max(2, naturalW + PAD * 2);
  const h = Math.max(2, yBot - yTop);
  return (
    <div
      style={{
        position: "absolute",
        left,
        top: yTop,
        width: w,
        height: h,
        border: `1px solid ${COLOR_ACCENT}`,
        borderRadius: 5,
        background: degenerate
          ? "color-mix(in srgb, var(--tb-a-blue-500) 15%, transparent)"
          : "color-mix(in srgb, var(--tb-a-blue-500) 5%, transparent)",
        pointerEvents: "none",
        boxSizing: "border-box",
      }}
    >
      {/* Scale handles — short, thick, rounded bars centred on each edge,
          so the box reads as grabbable rather than as a plain outline.
          Purely visual: the hit zone is still the EDGE band in
          onLanesPointerDown, which is wider than the bar is drawn.
          Only rendered when the box is wide enough to scale; when
          degenerate the strip itself is the move-group hit zone. */}
      {!degenerate && (
        <>
          <div
            style={{
              position: "absolute",
              left: -2,
              top: "50%",
              transform: "translateY(-50%)",
              width: 3,
              height: Math.max(8, Math.min(18, h * 0.45)),
              borderRadius: 2,
              background: COLOR_ACCENT,
            }}
          />
          <div
            style={{
              position: "absolute",
              right: -2,
              top: "50%",
              transform: "translateY(-50%)",
              width: 3,
              height: Math.max(8, Math.min(18, h * 0.45)),
              borderRadius: 2,
              background: COLOR_ACCENT,
            }}
          />
        </>
      )}
    </div>
  );
}

interface ContextMenuViewProps {
  menu: ContextMenuState;
  onClose(): void;
  onDelete(): void;
  onSetEasing(p: EasingPreset): void;
  allScalar: boolean;
  stepOnly: boolean;
}

function ContextMenuView(props: ContextMenuViewProps) {
  const { menu, onDelete, onSetEasing, allScalar, stepOnly } = props;
  const panelWin = usePanelWindow();
  const [hoverEasing, setHoverEasing] = useState(false);
  // Portal to the body — the dock's slide transform would otherwise be
  // the containing block for `position: fixed`, offsetting the menu from
  // the cursor.
  return createPortal(
    <div
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        left: menu.x,
        top: menu.y,
        zIndex: 1000,
        background: "var(--tb-n-4)",
        color: COLOR_TEXT,
        border: `1px solid ${COLOR_BORDER}`,
        borderRadius: 4,
        boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
        minWidth: 160,
        fontSize: 12,
      }}
    >
      {!stepOnly && (
        <div
          onMouseEnter={() => setHoverEasing(true)}
          onMouseLeave={() => setHoverEasing(false)}
          style={{
            position: "relative",
            padding: "6px 10px",
            cursor: "default",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            background: hoverEasing ? "var(--tb-n-7)" : "transparent",
          }}
        >
          <span>Set easing</span>
          <span style={{ color: COLOR_MUTED }}>{"▶"}</span>
          {hoverEasing && (
            <EasingGrid
              allScalar={allScalar}
              onPick={(p) => onSetEasing(p)}
            />
          )}
        </div>
      )}
      <div
        onClick={onDelete}
        style={{
          padding: "6px 10px",
          cursor: "pointer",
        }}
        onMouseEnter={(e) =>
          ((e.currentTarget as HTMLDivElement).style.background = "var(--tb-n-7)")
        }
        onMouseLeave={(e) =>
          ((e.currentTarget as HTMLDivElement).style.background = "transparent")
        }
      >
        Delete keyframe
      </div>
    </div>,
    // This editor's OWN body — a popped-out timeline must not drop its
    // context menu into the main window.
    (panelWin ?? window).document.body
  );
}

interface EasingGridProps {
  allScalar: boolean;
  onPick(p: EasingPreset): void;
  /** Overrides the default submenu placement (used by the picker button). */
  style?: React.CSSProperties;
  /** Marks the current preset. */
  active?: EasingPreset;
}

function EasingGrid(props: EasingGridProps) {
  const { allScalar, onPick, style, active } = props;
  const TILE = 36;
  const COLS = 6;
  return (
    <div
      style={{
        position: "absolute",
        left: "100%",
        top: 0,
        background: "var(--tb-n-4)",
        border: `1px solid ${COLOR_BORDER}`,
        borderRadius: 4,
        padding: 6,
        boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
        display: "grid",
        gridTemplateColumns: `repeat(${COLS}, ${TILE}px)`,
        gap: 4,
        ...style,
      }}
    >
      {EASING_PRESETS.map((p) => {
        const disabled = p === "customBezier" && !allScalar;
        return (
          <EasingTile
            key={p}
            preset={p}
            size={TILE}
            disabled={disabled}
            active={active === p}
            label={EASING_LABELS[p]}
            onClick={() => {
              if (disabled) return;
              onPick(p);
            }}
          />
        );
      })}
    </div>
  );
}

/**
 * The inspector strip's easing control. Was a native <select>, which
 * rendered the OS menu (and its focus ring) in the middle of an
 * otherwise custom surface; this is the same tile grid the right-click
 * menu already uses, opened from a button styled like the rest of the
 * strip.
 */
function EasingPickerButton(props: {
  value: EasingPreset;
  allScalar: boolean;
  onPick(p: EasingPreset): void;
}) {
  const { value, allScalar, onPick } = props;
  const panelWin = usePanelWindow();
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(
    null
  );
  useEffect(() => {
    if (!open) return;
    const r = btnRef.current?.getBoundingClientRect();
    // Opens UPWARD: the strip is pinned to the bottom of the editor, so
    // there is never room below it.
    if (r) setAnchor({ left: r.left, top: r.top - 6 });
    const onDown = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as globalThis.Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const win = ownerWindow(btnRef.current);
    win.addEventListener("mousedown", onDown);
    win.addEventListener("keydown", onKey);
    return () => {
      win.removeEventListener("mousedown", onDown);
      win.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title="Set easing for the selected keyframes"
        onMouseDown={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          background: open || hover ? "var(--tb-n-5)" : "var(--tb-n-3)",
          color: COLOR_TEXT,
          border: `1px solid ${open ? "var(--tb-n-9)" : COLOR_BORDER}`,
          borderRadius: 3,
          padding: "0 8px",
          height: 18,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontFamily: "var(--ui-font)",
          fontSize: 10,
          cursor: "pointer",
          outline: "none",
        }}
      >
        {EASING_LABELS[value]}
        <span style={{ color: COLOR_MUTED, fontSize: 8 }}>{"▲"}</span>
      </button>
      {open &&
        anchor &&
        createPortal(
          <div
            onMouseDown={(e) => e.stopPropagation()}
            style={{ position: "fixed", left: 0, top: 0, zIndex: 1000 }}
          >
            <EasingGrid
              allScalar={allScalar}
              active={value}
              onPick={(p) => {
                setOpen(false);
                onPick(p);
              }}
              style={{
                position: "fixed",
                left: anchor.left,
                top: anchor.top,
                transform: "translateY(-100%)",
              }}
            />
          </div>,
          // Context, not the ref — portal targets are computed during
          // render, where refs are off-limits.
          (panelWin ?? window).document.body
        )}
    </>
  );
}
