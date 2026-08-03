"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ownerWindow,
  usePanelWindow,
} from "@/components/effects/layout/panel-window";
import type { Edge, Node } from "@xyflow/react";
import { getNodeDef } from "@/engine/registry";
import type { NodeDataPayload } from "@/state/graph";
import { playbackClock } from "@/state/playback-clock";
import type {
  KeyframeAnimationBlock,
  ProjectTimeline,
} from "@/engine/keyframes";
import {
  emptyAnimationBlock,
  evaluateKeyframesAt,
  findKeyframeAt,
  removeKeyframeAt,
  snapTickToFrame,
  upsertKeyframe,
  EASING_PRESET_ORDER,
  EASING_PRESET_LABELS,
  type EasingPreset,
} from "@/engine/keyframes";
import type { ParamType } from "@/engine/types";
import { resolvePromotedParams } from "@/state/graph-ops";
import type { ClipBlock } from "@/engine/clips";
import {
  clipSlipsOnInTrim,
  defaultClip,
  splitClipsAt,
} from "@/engine/clips";
import { useCoarsePointer } from "@/lib/pointer-drag";
import { getShortcutScope } from "./shortcut-scope";
import { wheelWantsZoom } from "./input-device";
import {
  COLOR_CLIP_BORDER as CLIP_BORDER,
  COLOR_CLIP_BORDER_SELECTED as CLIP_BORDER_SELECTED,
  COLOR_CLIP_FILL as CLIP_FILL,
  COLOR_CLIP_FILL_HOVER as CLIP_FILL_HOVER,
  COLOR_CLIP_FILL_SELECTED as CLIP_FILL_SELECTED,
  COLOR_CLIP_GHOST as CLIP_GHOST_FILL,
  COLOR_CLIP_GHOST_BORDER as CLIP_GHOST_BORDER,
  COLOR_CLIP_GHOST_HOVER as CLIP_GHOST_FILL_HOVER,
  COLOR_CLIP_HANDLE as CLIP_HANDLE,
  COLOR_CLIP_HANDLE_HOVER as CLIP_HANDLE_HOVER,
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
  COLOR_LANE_RECESSED_BG,
  KEY_HIT_PX,
  KEY_SIZE,
  SEGMENT_HIT_PX,
  COLOR_GUTTER_BG,
  COLOR_GUTTER_BORDER,
  COLOR_GUTTER_CHEVRON,
  COLOR_GUTTER_TEXT,
  COLOR_GUTTER_TEXT_STRONG,
  GUTTER_RADIUS,
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

// AE-style layer stack editor (spec §2 "Layers editor"). A lens over
// the root compositing chain: each row is a layer, top-of-list =
// top-of-stack. The left column carries the visibility toggle + name;
// blend mode and opacity live in the layer node's ParamPanel. The right
// column is a timeline of the same tick scale as Tracks, where each
// layer's in/out bar is its clip window — drag to slide, trim either
// end. Dragging rows reorders the chain.

const ROW_HEIGHT = 27;
const LANE_HEIGHT = 22;
// The label gutter is an inset rounded card (matching Tracks). Unlike
// Tracks — where the gutter is one absolutely-positioned column — here
// every row owns its own label cell, so the card is a static backdrop
// painted BEHIND the rows and the inset is folded into LABEL_WIDTH:
// the cells keep starting at x=0 and just pad themselves in, which
// leaves every existing `LABEL_WIDTH + tickToPx(...)` lane offset
// correct with no other edits.
const GUTTER_INSET = 12;
const GUTTER_CARD_WIDTH = 200;
const LABEL_WIDTH = GUTTER_CARD_WIDTH + GUTTER_INSET;

// One keyframable param surfaced under a layer's twirl-down: the layer's
// own opacity, plus any param promoted via the layer's Group Input
// "new socket" (those keyframes live on the deep node the socket feeds).
interface LayerTrack {
  nodeId: string;
  paramName: string;
  label: string;
  type: ParamType;
}

export type AddLayerKind = "empty" | "text" | "image" | "video";

const ADD_LAYER_ITEMS: { kind: AddLayerKind; label: string }[] = [
  { kind: "empty", label: "Empty" },
  { kind: "text", label: "Text" },
  { kind: "image", label: "Image" },
  { kind: "video", label: "Video" },
];

export interface LayersEditorProps {
  // Root layer chain, BOTTOM → TOP (as getLayerChain returns it). The
  // editor renders it reversed so the top of the stack is the top row.
  layers: Node<NodeDataPayload>[];
  timeline: ProjectTimeline;
  selectedId: string | null;
  onScrub(tick: number): void;
  onClipChange(nodeId: string, next: ClipBlock[] | undefined): void;
  onSelectLayer(nodeId: string): void;
  onDiveLayer(nodeId: string): void;
  onToggleVisibility(nodeId: string): void;
  // New bottom → top order after a row drag-reorder.
  onReorder(orderedBottomToTop: string[]): void;
  onAddLayer(kind: AddLayerKind): void;
  // Cmd+Shift+D — split the layer at the playhead into two distinct
  // layers (deep copy; in/out set by the split position).
  onSplitLayer(nodeId: string, splitTick: number): void;
  // Full graph — needed to resolve promoted-param keyframe lanes (a
  // layer's Group Input sockets feeding deep nodes' exposed params).
  nodes: Node<NodeDataPayload>[];
  edges: Edge[];
  getAnimation(
    nodeId: string,
    paramName: string
  ): KeyframeAnimationBlock | undefined;
  onAnimationChange(
    nodeId: string,
    paramName: string,
    next: KeyframeAnimationBlock | undefined,
    coalesceKey?: string
  ): void;
  fitVersion?: number;
}

type Drag =
  | { kind: "none" }
  | { kind: "scrub" }
  | {
      kind: "bar";
      nodeId: string;
      // Index into `startClips` of the window being dragged. A ghost
      // (layer with no clips) materializes as a full-scene default in
      // `startClips` at drag start but is only WRITTEN on the first
      // actual move — a plain click doesn't dirty the document.
      clipIndex: number;
      mode: "move" | "trimIn" | "trimOut";
      startMouseX: number;
      startClips: ClipBlock[];
      // Whether an in-trim slips sourceInTick (clipSlipsOnInTrim — true
      // for layer rows, kept dynamic so this editor never hardcodes it).
      slipsInTrim: boolean;
    }
  | {
      kind: "reorder";
      nodeId: string;
      startMouseY: number;
      // Insertion index in the TOP→BOTTOM display order, updated on move.
      overIndex: number;
      moved: boolean;
    }
  | {
      // Marquee rubber-band over the lane area → selects keyframes.
      // `originX/originY` capture the lanes container's content origin
      // (rect minus scroll) at drag start so RENDERING the box never
      // reads a ref mid-render; the mouseup hit-test re-measures live.
      kind: "marquee";
      startX: number;
      startY: number;
      curX: number;
      curY: number;
      originX: number;
      originY: number;
      additive: boolean;
    }
  | {
      // Dragging a selected keyframe (or the bbox body) — moves the whole
      // selection by a tick delta from drag-start snapshots. `stagger`
      // (Option/Alt held) fans the selection across lanes instead of
      // moving it uniformly.
      kind: "moveKf";
      startMouseX: number;
      bases: GroupBase[];
      gestureKey: string;
      stagger: boolean;
      moved: boolean;
    }
  | {
      // Dragging a bbox edge handle — scales the selection in time about
      // the opposite edge.
      kind: "scaleKf";
      anchorTick: number;
      startEdgeTick: number;
      bases: GroupBase[];
      gestureKey: string;
    };

export function LayersEditor({
  layers,
  timeline,
  selectedId,
  onScrub,
  onClipChange,
  onSelectLayer,
  onDiveLayer,
  onToggleVisibility,
  onReorder,
  onAddLayer,
  onSplitLayer,
  nodes,
  edges,
  getAnimation,
  onAnimationChange,
  fitVersion,
}: LayersEditorProps) {
  // Null in the main window; the child Window when the timeline panel
  // is popped out (080226_panel-popout-windows.md §3).
  const panelWin = usePanelWindow();
  // No top-level clock subscription (clock-store spec, leaf pass): the
  // playhead chrome and DiamondNav subscribe themselves, and actions
  // read the tick imperatively at event time — playback no longer
  // re-renders the whole editor per frame.
  // Display order: top of stack first.
  const display = useMemo(() => [...layers].reverse(), [layers]);

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
  const [drag, setDrag] = useState<Drag>({ kind: "none" });
  // Touch primary → widen the clip trim grips (see their style below).
  const coarsePointer = useCoarsePointer();
  // Layers whose keyframe lanes are twirled open.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Keyframe lanes for a layer: its own opacity, plus any param
  // promoted through the layer's Group Input "new socket" (each such
  // socket feeds a deep node's exposed param `in:param:Y`; the lane
  // edits that deep node's animation directly).
  const tracksFor = useCallback(
    (layer: Node<NodeDataPayload>): LayerTrack[] => {
      return [
        {
          nodeId: layer.id,
          paramName: "opacity",
          label: "Opacity",
          type: "scalar",
        },
        ...resolvePromotedParams(layer.id, nodes, edges),
      ];
    },
    [nodes, edges]
  );

  // Current value of a track's param at the LIVE playhead — the
  // evaluated keyframe value when animated, else the node's stored
  // constant. Used as the value for a freshly-inserted keyframe.
  const currentValueOf = useCallback(
    (track: LayerTrack): unknown => {
      const tickNow = playbackClock.get().tick;
      const block = getAnimation(track.nodeId, track.paramName);
      if (block?.animated && block.keyframes.length > 0) {
        return evaluateKeyframesAt(block, track.type, tickNow);
      }
      return nodes.find((n) => n.id === track.nodeId)?.data.params[
        track.paramName
      ];
    },
    [getAnimation, nodes]
  );

  // --- keyframe selection ---
  const [selection, setSelection] = useState<SelectionKey[]>([]);
  const selSet = useMemo(() => new Set(selection.map(selKey)), [selection]);
  // Keep a live ref so drag handlers and the keyboard handler read the
  // current selection without re-subscribing every change (synced in the
  // every-render effect below rowLayout).
  const selectionRef = useRef(selection);
  // Selected clip window (a layer's in/out bar) — for delete after a
  // slice. Distinct from the keyframe selection above.
  const [selectedClip, setSelectedClip] = useState<{
    nodeId: string;
    index: number;
  } | null>(null);
  const selectedClipRef = useRef(selectedClip);
  // Right-click easing menu. `allScalar` gates the custom-bezier tile.
  const [kfMenu, setKfMenu] = useState<{
    x: number;
    y: number;
    targets: SelectionKey[];
    allScalar: boolean;
  } | null>(null);

  // Vertical layout: each layer's row plus its (open) keyframe lanes,
  // top-to-bottom. Each lane carries its absolute Y so marquee/bbox can
  // hit-test across layers. Drives row positioning, reorder, and the
  // overlays. Mirrored to a ref so window handlers read the latest.
  const rowLayout = useMemo(() => {
    const rows: {
      id: string;
      top: number;
      height: number;
      tracks: LayerTrack[];
    }[] = [];
    const lanes: { track: LayerTrack; laneTop: number }[] = [];
    let y = 0;
    for (const layer of display) {
      const tracks = expanded.has(layer.id) ? tracksFor(layer) : [];
      const height = ROW_HEIGHT + tracks.length * LANE_HEIGHT;
      tracks.forEach((track, ti) => {
        lanes.push({ track, laneTop: y + ROW_HEIGHT + ti * LANE_HEIGHT });
      });
      rows.push({ id: layer.id, top: y, height, tracks });
      y += height;
    }
    return { rows, lanes, totalHeight: y };
  }, [display, expanded, tracksFor]);
  const layoutRef = useRef(rowLayout);

  // Sync the refs the window-level handlers read. Runs after every
  // render (no dep array) so handlers always see the latest values.
  useEffect(() => {
    selectionRef.current = selection;
    selectedClipRef.current = selectedClip;
    layoutRef.current = rowLayout;
  });

  // Stagger fans lanes top → bottom; order bases by their lane Y.
  const orderBasesByLane = useCallback((bases: GroupBase[]): GroupBase[] => {
    const topOf = (b: GroupBase) =>
      layoutRef.current.lanes.find(
        (l) => l.track.nodeId === b.nodeId && l.track.paramName === b.paramName
      )?.laneTop ?? 0;
    return [...bases].sort((a, b) => topOf(a) - topOf(b));
  }, []);

  // Apply a shared keyframe-op result (timeline/keyframe-ops): one
  // onAnimationChange per lane, all sharing the gesture's coalesce key
  // so the whole gesture is ONE undo entry, then adopt the rebuilt
  // selection. Null (a scale pinned at its minimum span) keeps the last
  // applied state.
  const applyKeyframeOp = useCallback(
    (result: KeyframeOpResult | null, gestureKey: string) => {
      if (!result) return;
      for (const u of result.updates) {
        const block = getAnimation(u.nodeId, u.paramName);
        if (!block) continue;
        onAnimationChange(
          u.nodeId,
          u.paramName,
          { ...block, keyframes: u.keyframes },
          gestureKey
        );
      }
      setSelection(result.selection);
    },
    [getAnimation, onAnimationChange]
  );

  // True when the selection spans ≥2 distinct lanes (stagger has an
  // effect only then).
  const selectionSpansLanes = useCallback((sel: SelectionKey[]) => {
    const laneSet = new Set(sel.map((s) => laneKey(s.nodeId, s.paramName)));
    return laneSet.size >= 2;
  }, []);

  // Apply an easing preset to a set of keyframes (one undo entry).
  const setEasingFor = useCallback(
    (targets: SelectionKey[], easing: EasingPreset) => {
      const gestureKey = nextGestureKey("easing");
      for (const items of groupSelection(targets).values()) {
        const { nodeId, paramName } = items[0];
        const block = getAnimation(nodeId, paramName);
        if (!block) continue;
        const ticks = new Set(items.map((i) => i.tick));
        onAnimationChange(
          nodeId,
          paramName,
          {
            ...block,
            keyframes: block.keyframes.map((k) =>
              ticks.has(k.tick) ? { ...k, easingOut: easing } : k
            ),
          },
          gestureKey
        );
      }
    },
    [getAnimation, onAnimationChange]
  );

  const deleteSelection = useCallback(() => {
    const sel = selectionRef.current;
    if (sel.length === 0) return;
    const gestureKey = nextGestureKey("delete");
    for (const items of groupSelection(sel).values()) {
      const { nodeId, paramName } = items[0];
      let block = getAnimation(nodeId, paramName);
      if (!block) continue;
      for (const it of items) block = removeKeyframeAt(block, it.tick);
      onAnimationChange(
        nodeId,
        paramName,
        block.keyframes.length > 0 ? block : undefined,
        gestureKey
      );
    }
    setSelection([]);
  }, [getAnimation, onAnimationChange]);

  // Remove the selected clip window from its layer. Dropping the last
  // window clears the layer's clips entirely (back to always-active).
  const deleteSelectedClip = useCallback(() => {
    const sel = selectedClipRef.current;
    if (!sel) return;
    const layer = layers.find((l) => l.id === sel.nodeId);
    const clips = layer?.data.clips;
    if (!clips || sel.index < 0 || sel.index >= clips.length) return;
    const next = clips.filter((_, i) => i !== sel.index);
    onClipChange(sel.nodeId, next.length > 0 ? next : undefined);
    setSelectedClip(null);
  }, [layers, onClipChange]);

  // Bounding box around ≥2 selected keyframes (ticks + lane Y range).
  const selectionBox = useMemo(() => {
    if (selection.length < 2) return null;
    let minTick = Infinity;
    let maxTick = -Infinity;
    const tops: number[] = [];
    for (const s of selection) {
      minTick = Math.min(minTick, s.tick);
      maxTick = Math.max(maxTick, s.tick);
      const lane = rowLayout.lanes.find(
        (l) =>
          l.track.nodeId === s.nodeId && l.track.paramName === s.paramName
      );
      if (lane) tops.push(lane.laneTop);
    }
    if (tops.length === 0 || minTick === maxTick) return null;
    return {
      minTick,
      maxTick,
      top: Math.min(...tops),
      bottom: Math.max(...tops) + LANE_HEIGHT,
    };
  }, [selection, rowLayout]);

  // Whether the user's last pointer-down landed inside this editor — so
  // Delete removes keyframes here, but still deletes nodes when the user
  // was last working in the node editor (both share shortcut scope
  // "node").
  const activeRef = useRef(false);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      activeRef.current = !!containerRef.current?.contains(
        e.target as globalThis.Node
      );
    };
    const win = panelWin ?? window;
    win.addEventListener("mousedown", onDown, true);
    return () => win.removeEventListener("mousedown", onDown, true);
  }, [panelWin]);

  // Delete removes selected keyframes (capture phase, so it beats the
  // node editor's window Delete that would otherwise remove the layer).
  // Escape clears the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || t?.isContentEditable) return;
      if (!activeRef.current || getShortcutScope() !== "node") return;
      if (e.key === "Escape") {
        if (selectionRef.current.length > 0 || selectedClipRef.current) {
          setSelection([]);
          setSelectedClip(null);
          setKfMenu(null);
        }
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        // Keyframe selection wins; otherwise delete the selected clip
        // window. (Capture phase so neither falls through to the node
        // editor's "delete the layer".)
        if (selectionRef.current.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          deleteSelection();
        } else if (selectedClipRef.current) {
          e.preventDefault();
          e.stopPropagation();
          deleteSelectedClip();
        }
      }
    };
    const win = panelWin ?? window;
    win.addEventListener("keydown", onKey, true);
    return () => win.removeEventListener("keydown", onKey, true);
  }, [deleteSelection, deleteSelectedClip, panelWin]);

  // Stagger from the dock header's stagger control. The control fires
  // `keyframe-stagger-begin` (snapshot the multi-lane selection),
  // `keyframe-stagger` (apply step live), and `keyframe-stagger-end`.
  // We only respond when the selection spans ≥2 lanes — otherwise the
  // control reports "no effect" to the user.
  const staggerBaseRef = useRef<{
    bases: GroupBase[];
    gestureKey: string;
  } | null>(null);
  useEffect(() => {
    const onBegin = (e: Event) => {
      const sel = selectionRef.current;
      if (selectionSpansLanes(sel)) {
        staggerBaseRef.current = {
          bases: orderBasesByLane(buildGroupBases(sel, getAnimation)),
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
    // Broadcast reaches every window, so listening on our own is enough
    // wherever the stagger control itself lives.
    const win = panelWin ?? window;
    win.addEventListener("keyframe-stagger-begin", onBegin);
    win.addEventListener("keyframe-stagger", onStep);
    win.addEventListener("keyframe-stagger-end", onEnd);
    return () => {
      win.removeEventListener("keyframe-stagger-begin", onBegin);
      win.removeEventListener("keyframe-stagger", onStep);
      win.removeEventListener("keyframe-stagger-end", onEnd);
    };
  }, [
    panelWin,
    applyKeyframeOp,
    orderBasesByLane,
    selectionSpansLanes,
    getAnimation,
    timeline.ticksPerFrame,
  ]);

  // Toggle a keyframe at the playhead (the lane-label diamond). Reads
  // the playhead imperatively so the toggle always lands at the live
  // tick.
  const toggleKeyAtPlayhead = useCallback(
    (track: LayerTrack) => {
      const tickNow = playbackClock.get().tick;
      const block = getAnimation(track.nodeId, track.paramName);
      if (block && findKeyframeAt(block, tickNow)) {
        const next = removeKeyframeAt(block, tickNow);
        onAnimationChange(
          track.nodeId,
          track.paramName,
          next.keyframes.length > 0 ? { ...next, animated: true } : undefined
        );
      } else {
        const base = block ?? emptyAnimationBlock();
        const next = upsertKeyframe(
          { ...base, animated: true },
          tickNow,
          currentValueOf(track)
        );
        onAnimationChange(track.nodeId, track.paramName, next);
      }
    },
    [getAnimation, onAnimationChange, currentValueOf]
  );

  // Toggle whether a track's curve shows in the Graph editor (the ∿
  // button). Only meaningful once the param has an animation block.
  const toggleGraphFor = useCallback(
    (track: LayerTrack) => {
      const block = getAnimation(track.nodeId, track.paramName);
      const base = block ?? emptyAnimationBlock();
      onAnimationChange(track.nodeId, track.paramName, {
        ...base,
        graphVisible: !base.graphVisible,
      });
    },
    [getAnimation, onAnimationChange]
  );

  // Which window the cursor is over, and which third of it (for grip
  // lighting) — mirrors the Track editor's clip hover feedback.
  const [hovered, setHovered] = useState<{
    nodeId: string;
    index: number;
    region: "in" | "out" | "body";
  } | null>(null);
  // Faded hover playhead lines (ruler + lanes), positioned imperatively
  // so mousemove never re-renders the editor. The lanes line offsets by
  // the label column width.
  const rulerHoverRef = useRef<HoverLineHandle | null>(null);
  const lanesHoverRef = useRef<HoverLineHandle | null>(null);
  const setHoverLineX = (x: number | null) => {
    rulerHoverRef.current?.set(x);
    lanesHoverRef.current?.set(x == null ? null : LABEL_WIDTH + x);
  };
  // Hide the preview while a drag owns the cursor.
  useEffect(() => {
    if (drag.kind !== "none") setHoverLineX(null);
     
  }, [drag.kind]);
  // "+ Layer" dropdown (Empty / Text / Image / Video).
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!addMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!addMenuRef.current?.contains(e.target as globalThis.Node)) {
        setAddMenuOpen(false);
      }
    };
    const win = panelWin ?? window;
    win.addEventListener("mousedown", onDown);
    return () => win.removeEventListener("mousedown", onDown);
  }, [addMenuOpen, panelWin]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const lanesAreaRef = useRef<HTMLDivElement | null>(null);
  // The timeline column (ruler + bar lanes share its left edge / width).
  // Used for tick↔px conversions; lanesAreaRef (full-width body) is only
  // for vertical scroll + reorder Y.
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const [lanesWidth, setLanesWidth] = useState(0);

  // Measure the timeline column so fit + ruler know its width.
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setLanesWidth(w);
    });
    ro.observe(el);
    setLanesWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(() => {
    if (lanesWidth <= 0) return;
    fitView(lanesWidth, timeline.sceneDurationTicks);
  }, [lanesWidth, timeline.sceneDurationTicks, fitView]);

  // Fit once the width is known.
  const fittedRef = useRef(false);
  useEffect(() => {
    if (!fittedRef.current && lanesWidth > 0) {
      fittedRef.current = true;
      fit();
    }
  }, [lanesWidth, fit]);
  // Parent-triggered fit.
  const fitFirstRef = useRef(true);
  useEffect(() => {
    if (fitFirstRef.current) {
      fitFirstRef.current = false;
      return;
    }
    fit();
  }, [fitVersion, fit]);

  // Wheel: plain = pan horizontally; Cmd/Ctrl = zoom anchored to cursor.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      const rect = timelineRef.current?.getBoundingClientRect();
      const dx = e.deltaX || 0;
      const dy = e.deltaY || 0;
      // Zoom on an explicit modifier OR when the device is a mouse (wheel
      // zooms about the cursor); otherwise a trackpad two-finger scroll pans.
      if (wheelWantsZoom(e) && rect) {
        e.preventDefault();
        e.stopPropagation();
        const mx = e.clientX - rect.left;
        zoomTo(
          mx,
          pxToTick(mx),
          pixelsPerTick * Math.exp(-(dx || dy) * ZOOM_SENSITIVITY)
        );
        return;
      }
      // Plain wheel pans the time axis (horizontal scroll, or vertical
      // when the trackpad only reports dy).
      e.preventDefault();
      e.stopPropagation();
      const panBy = dx !== 0 ? dx : dy;
      setViewTickOffset((prev) =>
        Math.max(0, prev + panBy / pixelsPerTick)
      );
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [pxToTick, pixelsPerTick, zoomTo, setViewTickOffset]);

  // Middle-drag pans the time axis; Cmd/Ctrl + middle-drag zooms it about the
  // press point. stopPropagation keeps the preview canvas's window-level
  // middle-drag from also panning the canvas (bug #2). Scoped to button 1, so
  // left-button keyframe interactions are untouched.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const win = ownerWindow(el);
    const onDown = (e: PointerEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = timelineRef.current?.getBoundingClientRect();
      const zoom = e.metaKey || e.ctrlKey;
      const startX = e.clientX;
      const startY = e.clientY;
      const anchorX = rect ? startX - rect.left : 0;
      const startPpt = pixelsPerTick;
      const startOffset = viewTickOffset;
      const tickAt = startOffset + anchorX / startPpt;
      const onMove = (ev: PointerEvent) => {
        if (zoom) {
          // Drag up zooms in (larger pixels-per-tick). Pan stays clamped
          // ≥ 0 — this editor's timeline column has no left gutter.
          const factor = Math.exp(-(ev.clientY - startY) * ZOOM_SENSITIVITY);
          const next = clampPixelsPerTick(startPpt * factor);
          setViewTickOffset(Math.max(0, tickAt - anchorX / next));
          setPixelsPerTick(next);
        } else {
          setViewTickOffset(
            Math.max(0, startOffset - (ev.clientX - startX) / startPpt)
          );
        }
      };
      const onUp = () => {
        win.removeEventListener("pointermove", onMove);
        win.removeEventListener("pointerup", onUp);
      };
      win.addEventListener("pointermove", onMove);
      win.addEventListener("pointerup", onUp);
    };
    el.addEventListener("pointerdown", onDown);
    return () => el.removeEventListener("pointerdown", onDown);
  }, [pixelsPerTick, viewTickOffset, setPixelsPerTick, setViewTickOffset]);

  // Clip window for a layer: the first enabled window, or a full-scene
  // ghost when the layer has no clips (always active).
  const windowsFor = useCallback(
    (
      layer: Node<NodeDataPayload>
    ): { inTick: number; outTick: number; ghost: boolean; index: number }[] => {
      const clips = layer.data.clips;
      if (clips && clips.length > 0) {
        return clips.map((c, i) => ({
          inTick: c.inTick,
          outTick: c.outTick,
          ghost: false,
          index: i,
        }));
      }
      // No clips → one full-scene ghost bar; the first drag/slice
      // materializes it into a real window.
      return [
        {
          inTick: 0,
          outTick: timeline.sceneDurationTicks,
          ghost: true,
          index: -1,
        },
      ];
    },
    [timeline.sceneDurationTicks]
  );

  // ---- Drag handling (scrub / bar / reorder) ----
  useEffect(() => {
    if (drag.kind === "none") return;

    function onMove(e: PointerEvent) {
      if (drag.kind === "scrub") {
        const rect = timelineRef.current?.getBoundingClientRect();
        if (!rect) return;
        let tick = pxToTick(e.clientX - rect.left);
        // Shift unlocks sub-frame scrubbing, same as the Tracks tab.
        if (!e.shiftKey) tick = snapTickToFrame(tick, timeline.ticksPerFrame);
        onScrub(Math.max(0, Math.round(tick)));
        return;
      }
      if (drag.kind === "bar") {
        // Shared clip drag math (timeline/clip-ops): trim semantics,
        // slip, min-width and ≥0 clamps live there, identical to the
        // Tracks tab. Emits from the drag-start snapshot, so a ghost
        // materializes on the first real move.
        const opts = {
          snap: !e.shiftKey,
          ticksPerFrame: timeline.ticksPerFrame,
        };
        let next: ClipBlock[] | null;
        if (drag.mode === "move") {
          next = moveClipWindow(
            drag.startClips,
            drag.clipIndex,
            (e.clientX - drag.startMouseX) / pixelsPerTick,
            opts
          );
        } else {
          const rect = timelineRef.current?.getBoundingClientRect();
          if (!rect) return;
          next = trimClipWindow(
            drag.startClips,
            drag.clipIndex,
            drag.mode === "trimIn" ? "in" : "out",
            pxToTick(e.clientX - rect.left),
            { ...opts, slipsInTrim: drag.slipsInTrim }
          );
        }
        if (next) onClipChange(drag.nodeId, next);
        return;
      }
      if (drag.kind === "reorder") {
        const rect = lanesAreaRef.current?.getBoundingClientRect();
        if (!rect) return;
        const moved =
          drag.moved || Math.abs(e.clientY - drag.startMouseY) > 4;
        const y = e.clientY - rect.top + (lanesAreaRef.current?.scrollTop ?? 0);
        // Insertion index from variable-height rows: count rows whose
        // header midpoint sits above the cursor.
        const rows = layoutRef.current.rows;
        let overIndex = rows.length;
        for (let k = 0; k < rows.length; k++) {
          if (y < rows[k].top + ROW_HEIGHT / 2) {
            overIndex = k;
            break;
          }
        }
        setDrag({ ...drag, moved, overIndex });
        return;
      }
      if (drag.kind === "moveKf") {
        const deltaTicks = (e.clientX - drag.startMouseX) / pixelsPerTick;
        const moved =
          drag.moved || Math.abs(e.clientX - drag.startMouseX) > 3;
        if (moved) {
          const opts = {
            snap: !e.shiftKey,
            ticksPerFrame: timeline.ticksPerFrame,
          };
          // Option/Alt held → stagger the selection across lanes; the
          // drag delta becomes the per-lane step.
          if (drag.stagger) {
            applyKeyframeOp(
              staggerKeyframesOp(
                orderBasesByLane(drag.bases),
                deltaTicks,
                opts
              ),
              drag.gestureKey
            );
          } else {
            applyKeyframeOp(
              moveKeyframes(drag.bases, deltaTicks, opts),
              drag.gestureKey
            );
          }
        }
        if (moved !== drag.moved) setDrag({ ...drag, moved });
        return;
      }
      if (drag.kind === "scaleKf") {
        const rect = timelineRef.current?.getBoundingClientRect();
        if (!rect) return;
        applyKeyframeOp(
          scaleKeyframesOp(
            drag.bases,
            drag.anchorTick,
            drag.startEdgeTick,
            pxToTick(e.clientX - rect.left),
            { snap: !e.shiftKey, ticksPerFrame: timeline.ticksPerFrame }
          ),
          drag.gestureKey
        );
        return;
      }
      if (drag.kind === "marquee") {
        setDrag({ ...drag, curX: e.clientX, curY: e.clientY });
        return;
      }
    }
    function onUp() {
      if (drag.kind === "moveKf") {
        // No seek on a plain click — the playhead only moves from the
        // ruler up top.
        setDrag({ kind: "none" });
        return;
      }
      if (drag.kind === "scaleKf") {
        setDrag({ kind: "none" });
        return;
      }
      if (drag.kind === "marquee") {
        // Select every keyframe whose diamond falls inside the box.
        const cont = lanesAreaRef.current;
        const tlRect = timelineRef.current?.getBoundingClientRect();
        if (cont && tlRect) {
          const contRect = cont.getBoundingClientRect();
          const scrollY = cont.scrollTop;
          const x0 = Math.min(drag.startX, drag.curX) - tlRect.left;
          const x1 = Math.max(drag.startX, drag.curX) - tlRect.left;
          const y0 =
            Math.min(drag.startY, drag.curY) - contRect.top + scrollY;
          const y1 =
            Math.max(drag.startY, drag.curY) - contRect.top + scrollY;
          const hits: SelectionKey[] = [];
          for (const lane of layoutRef.current.lanes) {
            const cy = lane.laneTop + LANE_HEIGHT / 2;
            if (cy < y0 || cy > y1) continue;
            const block = getAnimation(
              lane.track.nodeId,
              lane.track.paramName
            );
            for (const k of block?.keyframes ?? []) {
              const px = tickToPx(k.tick);
              if (px >= x0 && px <= x1) {
                hits.push({
                  nodeId: lane.track.nodeId,
                  paramName: lane.track.paramName,
                  tick: k.tick,
                });
              }
            }
          }
          setSelection((prev) =>
            drag.additive
              ? [
                  ...prev,
                  ...hits.filter(
                    (h) => !prev.some((s) => selKey(s) === selKey(h))
                  ),
                ]
              : hits
          );
        }
        setDrag({ kind: "none" });
        return;
      }
      if (drag.kind === "reorder") {
        if (!drag.moved) {
          onSelectLayer(drag.nodeId);
        } else {
          // display is TOP→BOTTOM; build the new top→bottom order with
          // the dragged layer moved to overIndex, then hand back
          // bottom→top.
          const from = display.findIndex((l) => l.id === drag.nodeId);
          if (from !== -1) {
            const next = display.map((l) => l.id);
            next.splice(from, 1);
            const insert = drag.overIndex > from ? drag.overIndex - 1 : drag.overIndex;
            next.splice(Math.max(0, Math.min(next.length, insert)), 0, drag.nodeId);
            onReorder([...next].reverse());
          }
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
    // iPadOS fires pointercancel in place of pointerup when the system
    // takes the gesture (scroll takeover, palm, backgrounding) — without
    // it the drag stays latched after the finger lifts.
    win.addEventListener("pointercancel", onUp);
    win.addEventListener("blur", onBlur);
    return () => {
      win.removeEventListener("pointermove", onMove);
      win.removeEventListener("pointerup", onUp);
      win.removeEventListener("pointercancel", onUp);
      win.removeEventListener("blur", onBlur);
    };
  }, [
    panelWin,
    drag,
    pixelsPerTick,
    pxToTick,
    tickToPx,
    onScrub,
    onClipChange,
    onReorder,
    onSelectLayer,
    onAnimationChange,
    getAnimation,
    applyKeyframeOp,
    orderBasesByLane,
    display,
    timeline.ticksPerFrame,
  ]);

  // Keyboard:
  //  • Cmd/Ctrl+B — *slice* the selected layer's window at the playhead
  //    into two windows of the SAME layer (materializing a ghost first).
  //  • Cmd/Ctrl+Shift+D — *split* the layer into two DISTINCT layers,
  //    each with its in/out set by the split position.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const isSlice = !e.shiftKey && (e.key === "b" || e.key === "B");
      const isSplit = e.shiftKey && (e.key === "d" || e.key === "D");
      if (!isSlice && !isSplit) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || t?.isContentEditable) {
        return;
      }
      if (getShortcutScope() !== "node") return;
      const layer = layers.find((l) => l.id === selectedId);
      if (!layer) return;
      // Live playhead, read at keypress — this effect no longer
      // re-subscribes its window listener every tick.
      const tickNow = playbackClock.get().tick;
      if (isSplit) {
        e.preventDefault();
        onSplitLayer(layer.id, tickNow);
        return;
      }
      const existing = layer.data.clips;
      const base =
        existing && existing.length > 0
          ? existing
          : [defaultClip(0, timeline.sceneDurationTicks)];
      // Only cut when the playhead is strictly inside a window.
      const inside = base.some(
        (c) => tickNow > c.inTick && tickNow < c.outTick
      );
      if (!inside) return;
      e.preventDefault();
      onClipChange(layer.id, splitClipsAt(base, Math.round(tickNow)));
    };
    const win = panelWin ?? window;
    win.addEventListener("keydown", onKey);
    return () => win.removeEventListener("keydown", onKey);
  }, [
    panelWin,
    layers,
    selectedId,
    onClipChange,
    onSplitLayer,
    timeline.sceneDurationTicks,
  ]);

  // ---- Ruler tick spacing (shared 1/2/5 ladder) ----
  const rulerSpacing = useMemo(
    () => computeRulerSpacing(pixelsPerTick, timeline.ticksPerFrame).majorFrames,
    [pixelsPerTick, timeline.ticksPerFrame]
  );
  // The finer step between numbered divisions — drives the frame grid
  // behind the lanes and the ruler's stubs (FrameTicks.tsx).
  const minorSpacing = useMemo(
    () => computeRulerSpacing(pixelsPerTick, timeline.ticksPerFrame).minorFrames,
    [pixelsPerTick, timeline.ticksPerFrame]
  );

  const rulerTicks = useMemo(() => {
    if (lanesWidth <= 0) return [];
    const step = rulerSpacing * timeline.ticksPerFrame;
    const startFrame = Math.floor(viewTickOffset / step) * rulerSpacing;
    const out: { frame: number; x: number }[] = [];
    for (let f = startFrame; ; f += rulerSpacing) {
      const x = tickToPx(f * timeline.ticksPerFrame);
      if (x > lanesWidth) break;
      if (x >= -40) out.push({ frame: f, x });
      if (out.length > 400) break;
    }
    return out;
  }, [rulerSpacing, viewTickOffset, lanesWidth, tickToPx, timeline.ticksPerFrame]);

  const startBarDrag = (
    e: React.PointerEvent,
    nodeId: string,
    clipIndex: number,
    mode: "move" | "trimIn" | "trimOut",
    inTick: number,
    outTick: number
  ) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    onSelectLayer(nodeId);
    // Select the clicked window (real clips only — a ghost has no
    // window to delete). Clear any keyframe selection.
    setSelectedClip(clipIndex >= 0 ? { nodeId, index: clipIndex } : null);
    setSelection([]);
    const layer = layers.find((l) => l.id === nodeId);
    const clips = layer?.data.clips;
    // Ghost rows (no clips) get a full-scene default as the drag
    // baseline; it's only written once the drag actually moves.
    const startClips =
      clips && clips.length > 0 ? clips : [defaultClip(inTick, outTick)];
    setDrag({
      kind: "bar",
      nodeId,
      clipIndex: clipIndex >= 0 ? clipIndex : 0,
      mode,
      startMouseX: e.clientX,
      startClips,
      slipsInTrim: clipSlipsOnInTrim(layer?.data.defType ?? "layer"),
    });
  };

  // Mousedown on a keyframe diamond → update selection + start a move
  // drag (or shift-click to toggle without dragging).
  const startDiamondDrag = (
    e: React.PointerEvent,
    track: LayerTrack,
    tick: number
  ) => {
    // Let right-click fall through to the context menu (no drag/seek).
    if (e.button !== 0) {
      e.stopPropagation();
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    setSelectedClip(null);
    const key: SelectionKey = {
      nodeId: track.nodeId,
      paramName: track.paramName,
      tick,
    };
    const k = selKey(key);
    if (e.shiftKey) {
      setSelection((prev) =>
        prev.some((s) => selKey(s) === k)
          ? prev.filter((s) => selKey(s) !== k)
          : [...prev, key]
      );
      return;
    }
    let sel = selectionRef.current;
    if (!sel.some((s) => selKey(s) === k)) {
      sel = [key];
      setSelection(sel);
    }
    setDrag({
      kind: "moveKf",
      startMouseX: e.clientX,
      bases: buildGroupBases(sel, getAnimation),
      gestureKey: nextGestureKey("drag"),
      stagger: e.altKey,
      moved: false,
    });
  };

  /**
   * Click on the connector BETWEEN two keyframes: select the pair that
   * bounds it (the segment's easing owner) and start the same move drag
   * a keyframe click starts, so dragging the line slides both ends.
   * Shift merges the pair into the existing selection instead.
   */
  const startSegmentDrag = (
    e: React.PointerEvent,
    track: LayerTrack,
    ticks: [number, number]
  ) => {
    if (e.button !== 0) {
      e.stopPropagation();
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    setSelectedClip(null);
    const keys: SelectionKey[] = ticks.map((tick) => ({
      nodeId: track.nodeId,
      paramName: track.paramName,
      tick,
    }));
    if (e.shiftKey) {
      setSelection((prev) => [
        ...prev,
        ...keys.filter((key) => !prev.some((s) => selKey(s) === selKey(key))),
      ]);
      return;
    }
    setSelection(keys);
    setDrag({
      kind: "moveKf",
      startMouseX: e.clientX,
      bases: buildGroupBases(keys, getAnimation),
      gestureKey: nextGestureKey("drag"),
      stagger: e.altKey,
      moved: false,
    });
  };

  const openKfMenu = (e: React.MouseEvent, track: LayerTrack, tick: number) => {
    e.preventDefault();
    e.stopPropagation();
    const key: SelectionKey = {
      nodeId: track.nodeId,
      paramName: track.paramName,
      tick,
    };
    const k = selKey(key);
    // Right-clicking an unselected key targets just it; otherwise the
    // whole current selection.
    const targets = selectionRef.current.some((s) => selKey(s) === k)
      ? selectionRef.current
      : [key];
    if (!selectionRef.current.some((s) => selKey(s) === k)) setSelection([key]);
    const allScalar = targets.every((t) => {
      const def = getNodeDef(
        nodes.find((n) => n.id === t.nodeId)?.data.defType ?? ""
      );
      return def?.params.find((p) => p.name === t.paramName)?.type === "scalar";
    });
    setKfMenu({ x: e.clientX, y: e.clientY, targets, allScalar });
  };

  const startMarquee = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // Plain click on empty lane clears selection.
    setSelectedClip(null);
    const cont = lanesAreaRef.current;
    const rect = cont?.getBoundingClientRect();
    setDrag({
      kind: "marquee",
      startX: e.clientX,
      startY: e.clientY,
      curX: e.clientX,
      curY: e.clientY,
      originX: rect?.left ?? 0,
      originY: (rect?.top ?? 0) - (cont?.scrollTop ?? 0),
      additive: e.shiftKey,
    });
  };

  return (
    <div
      ref={containerRef}
      data-shortcut-scope="node"
      onMouseMove={(e) => {
        // Track the cursor across the timeline column for the faded
        // hover playhead line.
        if (drag.kind !== "none") return;
        const rect = timelineRef.current?.getBoundingClientRect();
        if (!rect) return;
        const x = e.clientX - rect.left;
        setHoverLineX(x >= 0 && x <= rect.width ? x : null);
      }}
      onMouseLeave={() => setHoverLineX(null)}
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--tb-n-0)",
        color: "var(--tb-n-16)",
        fontFamily: "var(--ui-font)",
        fontSize: 10,
        outline: "none",
        overflow: "hidden",
        // Timeline editor — dragging (playhead, bars, keyframes) must
        // never text-select the ruler numbers or labels.
        userSelect: "none",
        WebkitUserSelect: "none",
      }}
    >
      {/* Header: ruler aligned with the timeline; "+ Layer" on the left. */}
      <div style={{ display: "flex", height: RULER_HEIGHT, flexShrink: 0 }}>
        <div
          ref={addMenuRef}
          style={{
            position: "relative",
            width: LABEL_WIDTH,
            flexShrink: 0,
            // No right divider — the gutter below is a card with its own
            // frame, so a rule here would dangle above nothing.
            borderBottom: "1px solid var(--tb-n-5)",
            display: "flex",
            alignItems: "center",
            paddingLeft: GUTTER_INSET + 8,
          }}
        >
          <button
            type="button"
            onClick={() => setAddMenuOpen((v) => !v)}
            title="Add a layer"
            style={{
              background: addMenuOpen ? "var(--tb-n-7)" : "var(--tb-n-4)",
              border: `1px solid ${addMenuOpen ? "var(--tb-n-10)" : "var(--tb-n-9)"}`,
              color: addMenuOpen ? "var(--tb-n-16)" : "var(--tb-n-13)",
              borderRadius: 999,
              fontFamily: "inherit",
              fontSize: 10,
              lineHeight: "14px",
              height: 16,
              padding: "0 10px",
              cursor: "pointer",
              transition: "background 90ms, border-color 90ms, color 90ms",
            }}
          >
            + Layer
          </button>
          {addMenuOpen && (
            <div
              style={{
                position: "absolute",
                top: RULER_HEIGHT - 3,
                left: 6,
                zIndex: 50,
                minWidth: 120,
                background: "var(--tb-n-3)",
                border: "1px solid var(--tb-n-7)",
                borderRadius: 6,
                boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
                padding: 4,
                display: "flex",
                flexDirection: "column",
                gap: 1,
              }}
            >
              {ADD_LAYER_ITEMS.map((item) => (
                <AddMenuItem
                  key={item.kind}
                  label={item.label}
                  onClick={() => {
                    setAddMenuOpen(false);
                    onAddLayer(item.kind);
                  }}
                />
              ))}
            </div>
          )}
        </div>
        <div
          ref={timelineRef}
          style={{
            position: "relative",
            flex: 1,
            borderBottom: "1px solid var(--tb-n-5)",
            overflow: "hidden",
            cursor: "ew-resize",
            // Scrub strip owns its gesture; without this iPadOS reads a
            // finger drag as a scroll and cancels the pointer stream.
            touchAction: "none",
          }}
          onPointerDown={(e) => {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            let tick = pxToTick(e.clientX - rect.left);
            // Shift unlocks sub-frame scrubbing (same as the Tracks tab).
            if (!e.shiftKey) {
              tick = snapTickToFrame(tick, timeline.ticksPerFrame);
            }
            onScrub(Math.max(0, Math.round(tick)));
            setDrag({ kind: "scrub" });
          }}
        >
          {/* Minor divisions as short stubs off the bottom edge, on the
              same 1/2/5 ladder as the numbers. First in the DOM so the
              numbered majors below paint over them. */}
          <svg
            aria-hidden
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: lanesWidth,
              height: RULER_HEIGHT,
              pointerEvents: "none",
            }}
          >
            <RulerFrameStubs
              width={lanesWidth}
              height={RULER_HEIGHT}
              tickToPx={tickToPx}
              pxToTick={pxToTick}
              ticksPerFrame={timeline.ticksPerFrame}
              majorFrames={rulerSpacing}
              minorFrames={minorSpacing}
            />
          </svg>
          {rulerTicks.map((t) => (
            <div
              key={t.frame}
              style={{
                position: "absolute",
                left: t.x,
                top: 0,
                bottom: 0,
                display: "flex",
                alignItems: "center",
                paddingLeft: 3,
                borderLeft: `1px solid ${COLOR_RULER_TICK}`,
                color: COLOR_RULER_TEXT,
                fontSize: 9,
                pointerEvents: "none",
              }}
            >
              {t.frame}
            </div>
          ))}
          {/* Hover preview line through the ruler. */}
          <HoverLine ref={rulerHoverRef} />
          {/* Playhead triangle handle — drag to scrub (self-subscribing
              leaf). */}
          <PlayheadHandle
            tickToPx={tickToPx}
            visibleWidth={lanesWidth}
            onStartScrub={() => setDrag({ kind: "scrub" })}
          />
        </div>
      </div>

      {/* Body: rows, inside the gutter card. The vertical inset lives on
          this WRAPPER rather than on the scroller, so the scroller and
          everything positioned inside it (rows and absolute lane
          overlays alike) shift together and nothing desyncs. */}
      <div
        style={{
          position: "relative",
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          paddingTop: GUTTER_INSET,
          paddingBottom: GUTTER_INSET,
        }}
      >
        {/* The card's FILL — a static backdrop the rows scroll over. It
            comes FIRST in the DOM and takes no z-index, so it paints
            under the positioned scroller below; row backgrounds are
            transparent, so it shows through. Non-interactive.
            Its stroke is a separate layer painted ABOVE the rows (see
            below) — a selected row's highlight spans the full width, and
            with the stroke down here it would wash the frame out. */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: GUTTER_INSET,
            top: GUTTER_INSET,
            bottom: GUTTER_INSET,
            width: GUTTER_CARD_WIDTH,
            background: COLOR_GUTTER_BG,
            borderRadius: GUTTER_RADIUS,
            pointerEvents: "none",
          }}
        />
        {/* Frame-division grid over the LANE half only (the gutter card
            owns everything left of LABEL_WIDTH). A fixed backdrop, like
            the card fill: it sits outside the scroller so it doesn't move
            with the rows, and before it in the DOM so every row, clip bar
            and keyframe paints over it. */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: LABEL_WIDTH,
            right: 0,
            top: GUTTER_INSET,
            bottom: GUTTER_INSET,
            overflow: "hidden",
            pointerEvents: "none",
          }}
        >
          <LaneFrameTicks
            width={lanesWidth}
            tickToPx={tickToPx}
            pxToTick={pxToTick}
            ticksPerFrame={timeline.ticksPerFrame}
            majorFrames={rulerSpacing}
            minorFrames={minorSpacing}
          />
        </div>
        <div
          ref={lanesAreaRef}
          style={{
            position: "relative",
            flex: 1,
            overflow: "auto",
            // Vertical scroll stays with the browser (this list is long);
            // horizontal pan is ours, so clip drags aren't stolen.
            touchAction: "pan-y",
          }}
          onPointerDown={(e) => {
            // Empty space (below / around the rows) starts a marquee too —
            // rows, bars and lanes have their own handlers, so this only
            // fires on the bare body.
            if (e.target === e.currentTarget) startMarquee(e);
          }}
        >
        {display.length === 0 && (
          <div style={{ padding: 16, color: "var(--tb-n-10)" }}>
            No layers. Click “+ Layer”.
          </div>
        )}
        {display.map((layer, i) => {
          const windows = windowsFor(layer);
          const isSelected = layer.id === selectedId;
          const hidden = !!layer.data.bypassed;
          const isExpanded = expanded.has(layer.id);
          const tracks = isExpanded ? tracksFor(layer) : [];
          const reorderActive =
            drag.kind === "reorder" && drag.moved && drag.nodeId === layer.id;
          return (
            <Fragment key={layer.id}>
            <div
              style={{
                display: "flex",
                height: ROW_HEIGHT,
                opacity: reorderActive ? 0.4 : 1,
                // Translucent, not the old opaque #13131a: this row spans
                // the gutter card, and an opaque fill would black out the
                // card's left inset and frame wherever a row is selected.
                background: isSelected ? "color-mix(in srgb, var(--tb-lift) 4.5%, transparent)" : "transparent",
                borderBottom: "1px solid var(--tb-n-2)",
              }}
            >
              {/* Left: chevron + visibility + name. mousedown starts
                  select / reorder; double-click dives in. */}
              <div
                style={{
                  width: LABEL_WIDTH,
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  // The gutter card's inset is padding here; its right
                  // edge is the card's own frame, so no divider rule.
                  paddingLeft: GUTTER_INSET + 4,
                  cursor: "grab",
                  userSelect: "none",
                }}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  setDrag({
                    kind: "reorder",
                    nodeId: layer.id,
                    startMouseY: e.clientY,
                    overIndex: i,
                    moved: false,
                  });
                }}
                onDoubleClick={() => onDiveLayer(layer.id)}
              >
                <button
                  type="button"
                  title={isExpanded ? "Collapse keyframes" : "Expand keyframes"}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpanded((prev) => {
                      const next = new Set(prev);
                      if (next.has(layer.id)) next.delete(layer.id);
                      else next.add(layer.id);
                      return next;
                    });
                  }}
                  style={{
                    width: 14,
                    height: 14,
                    flexShrink: 0,
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    color: COLOR_GUTTER_CHEVRON,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    transform: isExpanded ? "rotate(90deg)" : "none",
                    transition: "transform 120ms",
                  }}
                >
                  <ChevronIcon />
                </button>
                <button
                  type="button"
                  title={hidden ? "Show layer" : "Hide layer"}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleVisibility(layer.id);
                  }}
                  style={{
                    width: 15,
                    height: 15,
                    flexShrink: 0,
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    color: hidden ? "var(--tb-n-9)" : "var(--tb-n-13)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <EyeIcon open={!hidden} />
                </button>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: 10,
                    // Dimmed to match the Tracks gutter — the card is a
                    // quiet surface, the lanes are the loud one.
                    color: hidden
                      ? "var(--tb-n-10)"
                      : isSelected
                        ? "var(--tb-n-14)"
                        : COLOR_GUTTER_TEXT_STRONG,
                  }}
                >
                  {layer.data.name}
                </span>
              </div>

              {/* Right: the in/out bar(s) on the timeline. A sliced
                  layer has several windows; each is its own draggable
                  bar. */}
              <div
                style={{ position: "relative", flex: 1, overflow: "hidden" }}
                onPointerDown={() => onSelectLayer(layer.id)}
                onDoubleClick={() => onDiveLayer(layer.id)}
              >
                {windows.map((w) => {
                  const left = tickToPx(w.inTick);
                  const width = Math.max(2, tickToPx(w.outTick) - left);
                  const isHovered =
                    hovered?.nodeId === layer.id && hovered.index === w.index;
                  const region = isHovered ? hovered!.region : null;
                  // This specific window is selected (click a bar) — only
                  // real windows are selectable, not the full-span ghost.
                  const clipSelected =
                    !w.ghost &&
                    selectedClip?.nodeId === layer.id &&
                    selectedClip.index === w.index;
                  const fill = hidden
                    ? "var(--tb-n-4)"
                    : w.ghost
                      ? isHovered
                        ? CLIP_GHOST_FILL_HOVER
                        : CLIP_GHOST_FILL
                      : clipSelected
                        ? CLIP_FILL_SELECTED
                        : isHovered
                          ? CLIP_FILL_HOVER
                          : CLIP_FILL;
                  const borderCol = hidden
                    ? "var(--tb-n-8)"
                    : w.ghost
                      ? CLIP_GHOST_BORDER
                      : clipSelected
                        ? CLIP_BORDER_SELECTED
                        : CLIP_BORDER;
                  const gripCol = (active: boolean) =>
                    hidden
                      ? "var(--tb-n-9)"
                      : active
                        ? CLIP_HANDLE_HOVER
                        : clipSelected
                          ? CLIP_BORDER_SELECTED
                          : CLIP_HANDLE;
                  return (
                    <div
                      key={w.index}
                      onMouseMove={(e) => {
                        // Region = which third the cursor is over, for
                        // grip lighting (matches the Track editor).
                        const r = (
                          e.currentTarget as HTMLElement
                        ).getBoundingClientRect();
                        const x = e.clientX - r.left;
                        const reg: "in" | "out" | "body" =
                          x <= 6 ? "in" : x >= r.width - 6 ? "out" : "body";
                        if (
                          !isHovered ||
                          hovered!.region !== reg
                        ) {
                          setHovered({ nodeId: layer.id, index: w.index, region: reg });
                        }
                      }}
                      onMouseLeave={() =>
                        setHovered((h) =>
                          h && h.nodeId === layer.id && h.index === w.index
                            ? null
                            : h
                        )
                      }
                      onPointerDown={(e) =>
                        startBarDrag(
                          e,
                          layer.id,
                          w.index,
                          "move",
                          w.inTick,
                          w.outTick
                        )
                      }
                      style={{
                        position: "absolute",
                        left,
                        width,
                        top: 5,
                        height: ROW_HEIGHT - 11,
                        borderRadius: 4,
                        boxSizing: "border-box",
                        background: fill,
                        border: `1px solid ${borderCol}`,
                        boxShadow:
                          clipSelected && !hidden
                            ? `0 0 0 1px ${CLIP_BORDER_SELECTED}55`
                            : undefined,
                        cursor: "grab",
                        transition: "background 90ms ease, border-color 90ms ease",
                        touchAction: "none",
                      }}
                    >
                      <div
                        onPointerDown={(e) =>
                          startBarDrag(
                            e,
                            layer.id,
                            w.index,
                            "trimIn",
                            w.inTick,
                            w.outTick
                          )
                        }
                        style={{
                          position: "absolute",
                          left: 0,
                          top: 0,
                          bottom: 0,
                          // Grab box, not the visual: a 3px trim handle is
                          // unhittable with a fingertip, so it widens on a
                          // touch primary while the coloured bar inside
                          // keeps its original width.
                          width: coarsePointer ? 14 : region === "in" ? 5 : 3,
                          cursor: "ew-resize",
                          touchAction: "none",
                        }}
                      >
                        <div
                          style={{
                            position: "absolute",
                            left: 0,
                            top: 0,
                            bottom: 0,
                            width: region === "in" ? 5 : 3,
                            background: gripCol(region === "in"),
                            borderTopLeftRadius: 4,
                          borderBottomLeftRadius: 4,
                            pointerEvents: "none",
                          }}
                        />
                      </div>
                      <div
                        onPointerDown={(e) =>
                          startBarDrag(
                            e,
                            layer.id,
                            w.index,
                            "trimOut",
                            w.inTick,
                            w.outTick
                          )
                        }
                        style={{
                          position: "absolute",
                          right: 0,
                          top: 0,
                          bottom: 0,
                          // Grab box, not the visual: a 3px trim handle is
                          // unhittable with a fingertip, so it widens on a
                          // touch primary while the coloured bar inside
                          // keeps its original width.
                          width: coarsePointer ? 14 : region === "out" ? 5 : 3,
                          cursor: "ew-resize",
                          touchAction: "none",
                        }}
                      >
                        <div
                          style={{
                            position: "absolute",
                            right: 0,
                            top: 0,
                            bottom: 0,
                            width: region === "out" ? 5 : 3,
                            background: gripCol(region === "out"),
                            borderTopRightRadius: 4,
                          borderBottomRightRadius: 4,
                            pointerEvents: "none",
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Keyframe lanes (twirl-down). */}
            {tracks.map((track) => {
              const laneBlock = getAnimation(track.nodeId, track.paramName);
              return (
              <KeyframeLane
                key={`${track.nodeId}:${track.paramName}`}
                track={track}
                block={laneBlock}
                tickToPx={tickToPx}
                selSet={selSet}
                onToggleKey={() => toggleKeyAtPlayhead(track)}
                onSeek={onScrub}
                graphOn={!!laneBlock?.graphVisible}
                onToggleGraph={
                  track.type === "scalar"
                    ? () => toggleGraphFor(track)
                    : undefined
                }
                onDiamondPointerDown={(e, tick) =>
                  startDiamondDrag(e, track, tick)
                }
                onSegmentPointerDown={(e, ticks) =>
                  startSegmentDrag(e, track, ticks)
                }
                onDiamondContextMenu={(e, tick) =>
                  openKfMenu(e, track, tick)
                }
                onMarqueeStart={(e) => startMarquee(e)}
              />
              );
            })}
            </Fragment>
          );
        })}

        {/* Reorder insertion indicator. */}
        {drag.kind === "reorder" && drag.moved && (
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top:
                rowLayout.rows[drag.overIndex]?.top ?? rowLayout.totalHeight,
              height: 2,
              background: "var(--tb-a-blue-500)",
              pointerEvents: "none",
            }}
          />
        )}

        {/* Marquee rubber-band. */}
        {drag.kind === "marquee" &&
          (() => {
            const left = Math.min(drag.startX, drag.curX) - drag.originX;
            const top = Math.min(drag.startY, drag.curY) - drag.originY;
            const w = Math.abs(drag.curX - drag.startX);
            const h = Math.abs(drag.curY - drag.startY);
            if (w < 2 && h < 2) return null;
            return (
              <div
                style={{
                  position: "absolute",
                  left,
                  top,
                  width: w,
                  height: h,
                  background: MARQUEE_FILL,
                  border: MARQUEE_BORDER,
                  pointerEvents: "none",
                }}
              />
            );
          })()}

        {/* Selection bounding box (≥2 keyframes) — body drags the
            selection, edge handles scale it in time. */}
        {selectionBox && drag.kind !== "marquee" && (
          <div
            style={{
              position: "absolute",
              left: LABEL_WIDTH + tickToPx(selectionBox.minTick) - 4,
              width:
                tickToPx(selectionBox.maxTick) -
                tickToPx(selectionBox.minTick) +
                8,
              top: selectionBox.top + 2,
              height: selectionBox.bottom - selectionBox.top - 4,
              border: "1px solid color-mix(in srgb, var(--tb-a-blue-500) 70%, transparent)",
              borderRadius: 5,
              background: "color-mix(in srgb, var(--tb-a-blue-500) 6%, transparent)",
              cursor: "grab",
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              setDrag({
                kind: "moveKf",
                startMouseX: e.clientX,
                bases: buildGroupBases(selectionRef.current, getAnimation),
                gestureKey: nextGestureKey("drag"),
                stagger: e.altKey,
                moved: false,
              });
            }}
          >
            <div
              onPointerDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                setDrag({
                  kind: "scaleKf",
                  anchorTick: selectionBox.maxTick,
                  startEdgeTick: selectionBox.minTick,
                  bases: buildGroupBases(selectionRef.current, getAnimation),
                  gestureKey: nextGestureKey("scale"),
                });
              }}
              // The GRAB zone stays full-height and 6px wide; the visual
              // indicator inside it is a short rounded bar, so the box
              // reads as draggable without shrinking the hit target.
              style={{
                position: "absolute",
                left: -3,
                top: 0,
                bottom: 0,
                width: 6,
                cursor: "ew-resize",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <ScaleHandleBar />
            </div>
            <div
              onPointerDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                setDrag({
                  kind: "scaleKf",
                  anchorTick: selectionBox.minTick,
                  startEdgeTick: selectionBox.maxTick,
                  bases: buildGroupBases(selectionRef.current, getAnimation),
                  gestureKey: nextGestureKey("scale"),
                });
              }}
              style={{
                position: "absolute",
                right: -3,
                top: 0,
                bottom: 0,
                width: 6,
                cursor: "ew-resize",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <ScaleHandleBar />
            </div>
          </div>
        )}

        {/* Hover preview line through the lanes (tracks the cursor). */}
        <HoverLine ref={lanesHoverRef} />

        {/* Playhead line across the timeline portion (self-subscribing
            leaf). */}
        <PlayheadLine
          tickToPx={tickToPx}
          leftOffset={LABEL_WIDTH}
          visibleWidth={lanesWidth}
        />
        </div>
        {/* The card's STROKE, above the rows — so a selected row's
            highlight (and the twirl-down tint) pass behind the frame
            instead of over it. Fill only, no background. */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: GUTTER_INSET,
            top: GUTTER_INSET,
            bottom: GUTTER_INSET,
            width: GUTTER_CARD_WIDTH,
            borderRadius: GUTTER_RADIUS,
            boxShadow: `inset 0 0 0 1px ${COLOR_GUTTER_BORDER}`,
            pointerEvents: "none",
            zIndex: 1,
          }}
        />
      </div>

      {/* Right-click quick-easing menu for the selected keyframe(s). */}
      {kfMenu && (
        <EasingMenu
          x={kfMenu.x}
          y={kfMenu.y}
          allScalar={kfMenu.allScalar}
          onPick={(easing) => {
            setEasingFor(kfMenu.targets, easing);
            setKfMenu(null);
          }}
          onClose={() => setKfMenu(null)}
        />
      )}
    </div>
  );
}

// Quick-easing context menu — a grid of preset tiles, each previewing
// its curve (the same picker the Track editor uses). `customBezier` is
// disabled unless every selected key is a scalar param.
function EasingMenu({
  x,
  y,
  allScalar,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  allScalar: boolean;
  onPick: (easing: EasingPreset) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const panelWin = usePanelWindow();
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as globalThis.Node)) onClose();
    };
    // Defer so the right-click that opened the menu doesn't immediately
    // dismiss it.
    const win = panelWin ?? window;
    const id = window.setTimeout(
      () => win.addEventListener("mousedown", onDown),
      0
    );
    return () => {
      window.clearTimeout(id);
      win.removeEventListener("mousedown", onDown);
    };
  }, [onClose, panelWin]);
  const TILE = 40;
  const COLS = 4;
  // Portal to the body — the dock's slide transform would otherwise be
  // the containing block for `position: fixed`, throwing off the
  // viewport-relative cursor coordinates.
  return createPortal(
    <div
      ref={ref}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        left: x,
        top: y,
        zIndex: 1000,
        background: "var(--tb-n-4)",
        border: "1px solid var(--tb-n-7)",
        borderRadius: 6,
        boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
        padding: 6,
      }}
    >
      <div
        style={{
          color: "var(--tb-n-11)",
          fontSize: 9,
          textTransform: "uppercase",
          letterSpacing: 1,
          padding: "1px 2px 5px",
        }}
      >
        Set easing
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${COLS}, ${TILE}px)`,
          gap: 4,
        }}
      >
        {EASING_PRESET_ORDER.map((preset) => (
          <EasingTile
            key={preset}
            preset={preset}
            size={TILE}
            disabled={preset === "customBezier" && !allScalar}
            label={EASING_PRESET_LABELS[preset]}
            onClick={() => onPick(preset)}
          />
        ))}
      </div>
    </div>,
    (panelWin ?? window).document.body
  );
}

function AddMenuItem({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        textAlign: "left",
        background: hover ? "var(--tb-n-7)" : "transparent",
        border: "none",
        borderRadius: 4,
        color: hover ? "var(--tb-n-16)" : "var(--tb-n-14)",
        fontFamily: "inherit",
        fontSize: 11,
        padding: "5px 8px",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

// One keyframe lane under an expanded layer: a label with a diamond
// toggle (add/remove a key at the playhead) and the keyframe diamonds on
// the shared timeline. Diamonds: click selects + drag moves (multi when
// several selected), shift-click toggles, right-click opens the easing
// menu. Empty lane background starts a marquee.
function KeyframeLane({
  track,
  block,
  tickToPx,
  selSet,
  onToggleKey,
  onSeek,
  graphOn,
  onToggleGraph,
  onDiamondPointerDown,
  onSegmentPointerDown,
  onDiamondContextMenu,
  onMarqueeStart,
}: {
  track: LayerTrack;
  block: KeyframeAnimationBlock | undefined;
  tickToPx: (tick: number) => number;
  selSet: Set<string>;
  onToggleKey: () => void;
  onSeek: (tick: number) => void;
  graphOn: boolean;
  // Present only for scalar tracks (the graph editor draws scalars).
  onToggleGraph?: () => void;
  onDiamondPointerDown: (e: React.PointerEvent, tick: number) => void;
  /** The two keyframes bounding the clicked connector segment. */
  onSegmentPointerDown: (e: React.PointerEvent, ticks: [number, number]) => void;
  onDiamondContextMenu: (e: React.MouseEvent, tick: number) => void;
  onMarqueeStart: (e: React.PointerEvent) => void;
}) {
  // Hover lives here rather than in the parent: the diamonds are
  // pointerEvents:none (the lane container owns every click), so this
  // re-derives the same hit rules and re-renders only this one lane.
  const [hoverTick, setHoverTick] = useState<number | null>(null);
  const [hoverSegStart, setHoverSegStart] = useState<number | null>(null);
  return (
    <div
      style={{
        display: "flex",
        height: LANE_HEIGHT,
        // The recessed tint that marks a twirl-down track lives on the
        // LANE half only (below). Painting it across the whole row would
        // cover the gutter card behind it and punch a full-width band
        // through the card's left inset and frame.
        borderBottom: "1px solid var(--tb-n-2)",
      }}
    >
      <div
        style={{
          width: LABEL_WIDTH,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 8,
          paddingLeft: GUTTER_INSET + 26,
        }}
      >
        <DiamondNav block={block} onToggle={onToggleKey} onSeek={onSeek} />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: COLOR_GUTTER_TEXT,
            fontSize: 9,
          }}
        >
          {track.label}
        </span>
        {onToggleGraph && (
          <button
            type="button"
            title={
              graphOn ? "Hide curve in Graph Editor" : "Show curve in Graph Editor"
            }
            onClick={(e) => {
              e.stopPropagation();
              onToggleGraph();
            }}
            style={{
              flexShrink: 0,
              background: graphOn ? "var(--tb-a-blue-500)" : "transparent",
              color: graphOn ? "#fff" : "var(--tb-n-10)",
              border: "1px solid var(--tb-n-7)",
              borderRadius: 2,
              cursor: "pointer",
              fontSize: 10,
              padding: "0 4px",
              lineHeight: "15px",
            }}
          >
            {"∿"}
          </button>
        )}
      </div>
      <div
        style={{
          position: "relative",
          flex: 1,
          overflow: "hidden",
          // The recessed tint marking a twirl-down track. Translucent,
          // not a ramp colour: the frame grid is a fixed backdrop behind
          // the lanes, and an opaque fill here blanks the ticks under
          // every expanded track row.
          background: COLOR_LANE_RECESSED_BG,
          touchAction: "none",
        }}
        onPointerDown={(e) => {
          // Container-level hit-test (mirrors the Track editor): only
          // left-click acts. Right-click / ctrl-click fall through to
          // onContextMenu — no drag, no playhead move.
          if (e.button !== 0 || e.ctrlKey) return;
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          const hit = hitTestTick(block, tickToPx, x);
          if (hit != null) {
            onDiamondPointerDown(e, hit);
            return;
          }
          const seg = hitTestSegmentTicks(block, tickToPx, x, y);
          if (seg) onSegmentPointerDown(e, seg);
          else onMarqueeStart(e);
        }}
        onMouseMove={(e) => {
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          const tick = hitTestTick(block, tickToPx, x);
          const seg =
            tick == null ? hitTestSegmentTicks(block, tickToPx, x, y) : null;
          if (tick !== hoverTick) setHoverTick(tick);
          const segStart = seg ? seg[0] : null;
          if (segStart !== hoverSegStart) setHoverSegStart(segStart);
        }}
        onMouseLeave={() => {
          if (hoverTick !== null) setHoverTick(null);
          if (hoverSegStart !== null) setHoverSegStart(null);
        }}
        onContextMenu={(e) => {
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const x = e.clientX - rect.left;
          const hit = hitTestTick(block, tickToPx, x);
          if (hit != null) onDiamondContextMenu(e, hit);
        }}
      >
        {/* Easing connector segments. */}
        {(block?.keyframes ?? []).map((k, i) => {
          if (i === 0) return null;
          const prev = block!.keyframes[i - 1];
          const x0 = tickToPx(prev.tick);
          const x1 = tickToPx(k.tick);
          // Dashed where the value CHANGES across the segment, solid
          // where it holds (same rule as the Tracks tab).
          const changes = !keyframeValuesEqual(prev.value, k.value);
          const color =
            hoverSegStart === prev.tick
              ? COLOR_SEGMENT_HOVER
              : prev.easingOut === "hold"
                ? COLOR_SEGMENT_HOLD
                : COLOR_SEGMENT;
          return (
            <div
              key={`seg:${prev.tick}:${k.tick}`}
              style={{
                position: "absolute",
                top: LANE_HEIGHT / 2 - 0.5,
                left: x0,
                width: x1 - x0,
                // A border (not a background) so the dash pattern
                // renders; the box itself collapses to zero height.
                height: 0,
                borderTop: `1px ${changes ? "dashed" : "solid"} ${color}`,
                opacity: hoverSegStart === prev.tick ? 1 : 0.6,
                pointerEvents: "none",
              }}
            />
          );
        })}
        {(block?.keyframes ?? []).map((k) => {
          const isSel = selSet.has(
            selKey({
              nodeId: track.nodeId,
              paramName: track.paramName,
              tick: k.tick,
            })
          );
          const x = tickToPx(k.tick);
          const isHover = !isSel && hoverTick === k.tick;
          return (
            <div
              key={k.tick}
              style={{
                position: "absolute",
                left: x - KEY_SIZE / 2,
                top: LANE_HEIGHT / 2 - KEY_SIZE / 2,
                width: KEY_SIZE,
                height: KEY_SIZE,
                // Scales about its own centre so it never appears to
                // slide off its tick.
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
                // Hit-testing is done by the lane container, not the
                // diamond, so a few px of slop still grabs it.
                pointerEvents: "none",
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

// Nearest keyframe tick within KEY_HIT_PX of the given lane-local x, or
// null. Mirrors the Track editor's hitTestKeyframe.
function hitTestTick(
  block: KeyframeAnimationBlock | undefined,
  tickToPx: (tick: number) => number,
  x: number
): number | null {
  let best: { tick: number; d: number } | null = null;
  for (const k of block?.keyframes ?? []) {
    const d = Math.abs(tickToPx(k.tick) - x);
    if (d <= KEY_HIT_PX && (!best || d < best.d)) best = { tick: k.tick, d };
  }
  return best ? best.tick : null;
}

/**
 * The ticks of the two keyframes bracketing a click on the connector
 * line BETWEEN them, or null. Mirrors the Track editor's hitTestSegment:
 * only the line's interior counts (its ends belong to the keyframes,
 * which are tested first) and the cursor must be within SEGMENT_HIT_PX
 * of the lane's mid-height, where the connector is drawn.
 */
function hitTestSegmentTicks(
  block: KeyframeAnimationBlock | undefined,
  tickToPx: (tick: number) => number,
  x: number,
  y: number
): [number, number] | null {
  if (Math.abs(y - LANE_HEIGHT / 2) > SEGMENT_HIT_PX) return null;
  const kfs = block?.keyframes ?? [];
  for (let i = 1; i < kfs.length; i++) {
    if (
      x > tickToPx(kfs[i - 1].tick) + KEY_HIT_PX &&
      x < tickToPx(kfs[i].tick) - KEY_HIT_PX
    ) {
      return [kfs[i - 1].tick, kfs[i].tick];
    }
  }
  return null;
}

/** The short rounded bar drawn inside a selection-box scale handle. */
function ScaleHandleBar() {
  return (
    <div
      style={{
        width: 3,
        height: "45%",
        minHeight: 8,
        borderRadius: 2,
        background: "color-mix(in srgb, var(--tb-a-blue-500) 95%, transparent)",
        pointerEvents: "none",
      }}
    />
  );
}

function ChevronIcon() {
  return (
    <svg width={9} height={9} viewBox="0 0 9 9" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 1.5 L6 4.5 L3 7.5" />
    </svg>
  );
}

function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M1 7 C2.5 4 4.5 3 7 3 C9.5 3 11.5 4 13 7 C11.5 10 9.5 11 7 11 C4.5 11 2.5 10 1 7 Z" />
      <circle cx="7" cy="7" r="1.8" />
      {!open && <path d="M2 12 L12 2" />}
    </svg>
  );
}
