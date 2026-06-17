"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Edge, Node } from "@xyflow/react";
import { getNodeDef } from "@/engine/registry";
import type { NodeDataPayload } from "@/state/graph";
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
  easingPathFor,
  EASING_PRESET_ORDER,
  EASING_PRESET_LABELS,
  type EasingPreset,
  type Keyframe,
} from "@/engine/keyframes";
import type { ParamType } from "@/engine/types";
import { resolvePromotedParams } from "@/state/graph-ops";
import { DiamondNav } from "./TrackEditor";
import type { ClipBlock } from "@/engine/clips";
import { defaultClip, splitClipsAt } from "@/engine/clips";
import { getShortcutScope } from "./shortcut-scope";
import { wheelWantsZoom } from "./input-device";

// AE-style layer stack editor (spec §2 "Layers editor"). A lens over
// the root compositing chain: each row is a layer, top-of-list =
// top-of-stack. The left column carries the visibility toggle + name;
// blend mode and opacity live in the layer node's ParamPanel. The right
// column is a timeline of the same tick scale as Tracks, where each
// layer's in/out bar is its clip window — drag to slide, trim either
// end. Dragging rows reorders the chain.

const RULER_HEIGHT = 24;
const ROW_HEIGHT = 27;
const LANE_HEIGHT = 22;
const LABEL_WIDTH = 200;
const MIN_PIXELS_PER_TICK = 0.0002;
const MAX_PIXELS_PER_TICK = 1.5;

const COLOR_DIAMOND = "#f59e0b";
const COLOR_DIAMOND_SELECTED = "#fbbf24";

// One keyframable param surfaced under a layer's twirl-down: the layer's
// own opacity, plus any param promoted via the layer's Group Input
// "new socket" (those keyframes live on the deep node the socket feeds).
interface LayerTrack {
  nodeId: string;
  paramName: string;
  label: string;
  type: ParamType;
}

// A selected keyframe, identified across all rendered lanes.
interface SelectionKey {
  nodeId: string;
  paramName: string;
  tick: number;
}
const selKey = (s: SelectionKey) => `${s.nodeId} ${s.paramName} ${s.tick}`;

// Snapshot of a block's keyframes at drag-start, so each mousemove
// recomputes from a stable baseline (porting the Track editor's
// group-bases pattern for multi-keyframe move / scale).
interface GroupBase {
  nodeId: string;
  paramName: string;
  originals: Keyframe[];
  selectedOriginalTicks: Set<number>;
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
  currentTick: number;
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

// Clip palette — mirrors the Track editor's hover / selected states.
const CLIP_FILL = "#123c44";
const CLIP_FILL_HOVER = "#185863";
const CLIP_FILL_SELECTED = "#0e7490";
const CLIP_BORDER = "#1d6373";
const CLIP_BORDER_SELECTED = "#67e8f9";
const CLIP_HANDLE = "#2b8093";
const CLIP_HANDLE_HOVER = "#a5f3fc";
const CLIP_GHOST_FILL = "rgba(34, 211, 238, 0.07)";
const CLIP_GHOST_FILL_HOVER = "rgba(34, 211, 238, 0.13)";
const CLIP_GHOST_BORDER = "rgba(34, 211, 238, 0.22)";
const COLOR_PLAYHEAD = "#22c55e";

type Drag =
  | { kind: "none" }
  | { kind: "scrub" }
  | {
      kind: "bar";
      nodeId: string;
      // Index of the window being dragged in the layer's clips array, or
      // -1 for a ghost (no clips) — the first drag materializes it.
      clipIndex: number;
      mode: "move" | "trimIn" | "trimOut";
      startMouseX: number;
      startIn: number;
      startOut: number;
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
      kind: "marquee";
      startX: number;
      startY: number;
      curX: number;
      curY: number;
      additive: boolean;
    }
  | {
      // Dragging a selected keyframe (or the bbox body) — moves the whole
      // selection by a tick delta from drag-start snapshots. `anchorTick`
      // is the clicked keyframe's tick (for seek-on-click). `stagger`
      // (Option/Alt held) fans the selection across lanes instead of
      // moving it uniformly.
      kind: "moveKf";
      startMouseX: number;
      anchorTick: number;
      bases: GroupBase[];
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
    };

export function LayersEditor({
  layers,
  timeline,
  currentTick,
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
  // Display order: top of stack first.
  const display = useMemo(() => [...layers].reverse(), [layers]);

  const [pixelsPerTick, setPixelsPerTick] = useState(0.01);
  const [viewTickOffset, setViewTickOffset] = useState(0);
  const [drag, setDrag] = useState<Drag>({ kind: "none" });
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

  // Current value of a track's param — the evaluated keyframe value when
  // animated, else the node's stored constant. Used as the value for a
  // freshly-inserted keyframe.
  const currentValueOf = useCallback(
    (track: LayerTrack): unknown => {
      const block = getAnimation(track.nodeId, track.paramName);
      if (block?.animated && block.keyframes.length > 0) {
        return evaluateKeyframesAt(block, track.type, currentTick);
      }
      return nodes.find((n) => n.id === track.nodeId)?.data.params[
        track.paramName
      ];
    },
    [getAnimation, nodes, currentTick]
  );

  // --- keyframe selection ---
  const [selection, setSelection] = useState<SelectionKey[]>([]);
  const selSet = useMemo(() => new Set(selection.map(selKey)), [selection]);
  // Keep a live ref so drag handlers and the keyboard handler read the
  // current selection without re-subscribing every change.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  // Selected clip window (a layer's in/out bar) — for delete after a
  // slice. Distinct from the keyframe selection above.
  const [selectedClip, setSelectedClip] = useState<{
    nodeId: string;
    index: number;
  } | null>(null);
  const selectedClipRef = useRef(selectedClip);
  selectedClipRef.current = selectedClip;
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
  layoutRef.current = rowLayout;

  // Block lookup (live).
  const blockOf = useCallback(
    (s: { nodeId: string; paramName: string }) =>
      getAnimation(s.nodeId, s.paramName),
    [getAnimation]
  );

  // Snapshot the selected blocks' keyframes for an in-progress drag.
  const buildBases = useCallback(
    (sel: SelectionKey[]): GroupBase[] => {
      const map = new Map<string, GroupBase>();
      for (const s of sel) {
        const gk = `${s.nodeId} ${s.paramName}`;
        let e = map.get(gk);
        if (!e) {
          const block = blockOf(s);
          if (!block) continue;
          e = {
            nodeId: s.nodeId,
            paramName: s.paramName,
            originals: block.keyframes.map((k) => ({ ...k })),
            selectedOriginalTicks: new Set<number>(),
          };
          map.set(gk, e);
        }
        e.selectedOriginalTicks.add(s.tick);
      }
      return [...map.values()];
    },
    [blockOf]
  );

  const snap = timeline.ticksPerFrame;

  // Move the selection by a tick delta (live; rebuilt from bases).
  const applyMove = useCallback(
    (bases: GroupBase[], deltaTicks: number) => {
      const nextSel: SelectionKey[] = [];
      for (const base of bases) {
        const block = getAnimation(base.nodeId, base.paramName);
        if (!block) continue;
        const remapped = base.originals.map((k) => {
          if (!base.selectedOriginalTicks.has(k.tick)) return { ...k };
          const target = Math.max(
            0,
            Math.round(snapTickToFrame(k.tick + deltaTicks, snap))
          );
          return { ...k, tick: target };
        });
        const seen = new Map<number, Keyframe>();
        for (const k of remapped) seen.set(k.tick, k);
        const sorted = [...seen.values()].sort((a, b) => a.tick - b.tick);
        onAnimationChange(base.nodeId, base.paramName, {
          ...block,
          animated: true,
          keyframes: sorted,
        }, "kf-batch");
        for (const ot of base.selectedOriginalTicks) {
          nextSel.push({
            nodeId: base.nodeId,
            paramName: base.paramName,
            tick: Math.max(0, Math.round(snapTickToFrame(ot + deltaTicks, snap))),
          });
        }
      }
      setSelection(nextSel);
    },
    [getAnimation, onAnimationChange, snap]
  );

  // Scale the selection in time about `anchorTick` (bbox edge handle).
  const applyScale = useCallback(
    (bases: GroupBase[], anchorTick: number, startEdge: number, curEdge: number) => {
      const span = startEdge - anchorTick;
      if (Math.abs(span) < 1) return;
      const factor = (curEdge - anchorTick) / span;
      const nextSel: SelectionKey[] = [];
      for (const base of bases) {
        const block = getAnimation(base.nodeId, base.paramName);
        if (!block) continue;
        const remapped = base.originals.map((k) => {
          if (!base.selectedOriginalTicks.has(k.tick)) return { ...k };
          const target = Math.max(
            0,
            Math.round(
              snapTickToFrame(anchorTick + (k.tick - anchorTick) * factor, snap)
            )
          );
          return { ...k, tick: target };
        });
        const seen = new Map<number, Keyframe>();
        for (const k of remapped) seen.set(k.tick, k);
        const sorted = [...seen.values()].sort((a, b) => a.tick - b.tick);
        onAnimationChange(base.nodeId, base.paramName, {
          ...block,
          animated: true,
          keyframes: sorted,
        }, "kf-batch");
        for (const ot of base.selectedOriginalTicks) {
          nextSel.push({
            nodeId: base.nodeId,
            paramName: base.paramName,
            tick: Math.max(
              0,
              Math.round(
                snapTickToFrame(anchorTick + (ot - anchorTick) * factor, snap)
              )
            ),
          });
        }
      }
      setSelection(nextSel);
    },
    [getAnimation, onAnimationChange, snap]
  );

  // Stagger: order the selected lanes top → bottom; the topmost stays
  // static and each lane below offsets its keys by `stepTicks × order`,
  // preserving intra-track spacing. No-op when only one lane is
  // selected. `stepTicks` is snapped to a frame so every lane's offset
  // is frame-aligned.
  const applyStagger = useCallback(
    (bases: GroupBase[], stepTicks: number) => {
      const step = Math.round(snapTickToFrame(stepTicks, snap));
      const ordered = bases
        .map((base) => {
          const lane = rowLayout.lanes.find(
            (l) =>
              l.track.nodeId === base.nodeId &&
              l.track.paramName === base.paramName
          );
          return { base, top: lane?.laneTop ?? 0 };
        })
        .sort((a, b) => a.top - b.top);
      const nextSel: SelectionKey[] = [];
      ordered.forEach(({ base }, k) => {
        const offset = step * k;
        const block = getAnimation(base.nodeId, base.paramName);
        if (!block) return;
        const remapped = base.originals.map((kf) => {
          if (!base.selectedOriginalTicks.has(kf.tick)) return { ...kf };
          return { ...kf, tick: Math.max(0, kf.tick + offset) };
        });
        const seen = new Map<number, Keyframe>();
        for (const kf of remapped) seen.set(kf.tick, kf);
        const sorted = [...seen.values()].sort((a, b) => a.tick - b.tick);
        onAnimationChange(base.nodeId, base.paramName, {
          ...block,
          animated: true,
          keyframes: sorted,
        }, "kf-batch");
        for (const ot of base.selectedOriginalTicks) {
          nextSel.push({
            nodeId: base.nodeId,
            paramName: base.paramName,
            tick: Math.max(0, ot + offset),
          });
        }
      });
      setSelection(nextSel);
    },
    [getAnimation, onAnimationChange, rowLayout, snap]
  );

  // True when the selection spans ≥2 distinct lanes (stagger has an
  // effect only then).
  const selectionSpansLanes = useCallback((sel: SelectionKey[]) => {
    const lanes = new Set(sel.map((s) => `${s.nodeId} ${s.paramName}`));
    return lanes.size >= 2;
  }, []);

  // Apply an easing preset to a set of keyframes.
  const setEasingFor = useCallback(
    (targets: SelectionKey[], easing: EasingPreset) => {
      const groups = new Map<string, SelectionKey[]>();
      for (const s of targets) {
        const gk = `${s.nodeId} ${s.paramName}`;
        const l = groups.get(gk);
        if (l) l.push(s);
        else groups.set(gk, [s]);
      }
      for (const items of groups.values()) {
        const { nodeId, paramName } = items[0];
        const block = getAnimation(nodeId, paramName);
        if (!block) continue;
        const ticks = new Set(items.map((i) => i.tick));
        onAnimationChange(nodeId, paramName, {
          ...block,
          keyframes: block.keyframes.map((k) =>
            ticks.has(k.tick) ? { ...k, easingOut: easing } : k
          ),
        });
      }
    },
    [getAnimation, onAnimationChange]
  );

  const deleteSelection = useCallback(() => {
    const sel = selectionRef.current;
    if (sel.length === 0) return;
    const groups = new Map<string, SelectionKey[]>();
    for (const s of sel) {
      const gk = `${s.nodeId} ${s.paramName}`;
      const l = groups.get(gk);
      if (l) l.push(s);
      else groups.set(gk, [s]);
    }
    for (const items of groups.values()) {
      const { nodeId, paramName } = items[0];
      let block = getAnimation(nodeId, paramName);
      if (!block) continue;
      for (const it of items) block = removeKeyframeAt(block, it.tick);
      onAnimationChange(
        nodeId,
        paramName,
        block.keyframes.length > 0 ? block : undefined
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
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, []);

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
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [deleteSelection, deleteSelectedClip]);

  // Stagger from the dock header's stagger control. The control fires
  // `keyframe-stagger-begin` (snapshot the multi-lane selection),
  // `keyframe-stagger` (apply step live), and `keyframe-stagger-end`.
  // We only respond when the selection spans ≥2 lanes — otherwise the
  // control reports "no effect" to the user.
  const staggerBaseRef = useRef<GroupBase[] | null>(null);
  useEffect(() => {
    const onBegin = (e: Event) => {
      const sel = selectionRef.current;
      if (selectionSpansLanes(sel)) {
        staggerBaseRef.current = buildBases(sel);
        (e as CustomEvent).detail?.respond?.(true);
      } else {
        staggerBaseRef.current = null;
      }
    };
    const onStep = (e: Event) => {
      if (!staggerBaseRef.current) return;
      const ticks = (e as CustomEvent<{ stepTicks: number }>).detail?.stepTicks;
      if (typeof ticks === "number") applyStagger(staggerBaseRef.current, ticks);
    };
    const onEnd = () => {
      staggerBaseRef.current = null;
    };
    window.addEventListener("keyframe-stagger-begin", onBegin);
    window.addEventListener("keyframe-stagger", onStep);
    window.addEventListener("keyframe-stagger-end", onEnd);
    return () => {
      window.removeEventListener("keyframe-stagger-begin", onBegin);
      window.removeEventListener("keyframe-stagger", onStep);
      window.removeEventListener("keyframe-stagger-end", onEnd);
    };
  }, [applyStagger, buildBases, selectionSpansLanes]);

  // Toggle a keyframe at the playhead (the lane-label diamond).
  const toggleKeyAtPlayhead = useCallback(
    (track: LayerTrack) => {
      const block = getAnimation(track.nodeId, track.paramName);
      if (block && findKeyframeAt(block, currentTick)) {
        const next = removeKeyframeAt(block, currentTick);
        onAnimationChange(
          track.nodeId,
          track.paramName,
          next.keyframes.length > 0 ? { ...next, animated: true } : undefined
        );
      } else {
        const base = block ?? emptyAnimationBlock();
        const next = upsertKeyframe(
          { ...base, animated: true },
          currentTick,
          currentValueOf(track)
        );
        onAnimationChange(track.nodeId, track.paramName, next);
      }
    },
    [getAnimation, onAnimationChange, currentTick, currentValueOf]
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
  // Cursor x in timeline-local px, for the faded hover playhead line.
  const [hoverX, setHoverX] = useState<number | null>(null);
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
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [addMenuOpen]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const lanesAreaRef = useRef<HTMLDivElement | null>(null);
  // The timeline column (ruler + bar lanes share its left edge / width).
  // Used for tick↔px conversions; lanesAreaRef (full-width body) is only
  // for vertical scroll + reorder Y.
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const [lanesWidth, setLanesWidth] = useState(0);

  const tickToPx = useCallback(
    (tick: number) => (tick - viewTickOffset) * pixelsPerTick,
    [viewTickOffset, pixelsPerTick]
  );
  const pxToTick = useCallback(
    (px: number) => viewTickOffset + px / pixelsPerTick,
    [viewTickOffset, pixelsPerTick]
  );

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
    const pps =
      timeline.sceneDurationTicks > 0
        ? (lanesWidth * 0.95) / timeline.sceneDurationTicks
        : 0.01;
    setPixelsPerTick(
      Math.max(MIN_PIXELS_PER_TICK, Math.min(MAX_PIXELS_PER_TICK, pps))
    );
    setViewTickOffset(0);
  }, [lanesWidth, timeline.sceneDurationTicks]);

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
        const tickAtCursor = pxToTick(mx);
        setPixelsPerTick((prev) => {
          const factor = Math.exp(-(dx || dy) * 0.0015);
          const next = Math.max(
            MIN_PIXELS_PER_TICK,
            Math.min(MAX_PIXELS_PER_TICK, prev * factor)
          );
          setViewTickOffset(tickAtCursor - mx / next);
          return next;
        });
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
  }, [pxToTick, pixelsPerTick]);

  // Middle-drag pans the time axis; Cmd/Ctrl + middle-drag zooms it about the
  // press point. stopPropagation keeps the preview canvas's window-level
  // middle-drag from also panning the canvas (bug #2). Scoped to button 1, so
  // left-button keyframe interactions are untouched.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
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
          // Drag up zooms in (larger pixels-per-tick).
          const factor = Math.exp(-(ev.clientY - startY) * 0.0015);
          const next = Math.max(
            MIN_PIXELS_PER_TICK,
            Math.min(MAX_PIXELS_PER_TICK, startPpt * factor)
          );
          setViewTickOffset(Math.max(0, tickAt - anchorX / next));
          setPixelsPerTick(next);
        } else {
          setViewTickOffset(
            Math.max(0, startOffset - (ev.clientX - startX) / startPpt)
          );
        }
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
  }, [pixelsPerTick, viewTickOffset]);

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
    const snap = timeline.ticksPerFrame;
    const snapTick = (t: number) => Math.round(t / snap) * snap;

    function onMove(e: MouseEvent) {
      if (drag.kind === "scrub") {
        const rect = timelineRef.current?.getBoundingClientRect();
        if (!rect) return;
        onScrub(Math.max(0, snapTick(pxToTick(e.clientX - rect.left))));
        return;
      }
      if (drag.kind === "bar") {
        const deltaTicks = (e.clientX - drag.startMouseX) / pixelsPerTick;
        let inT = drag.startIn;
        let outT = drag.startOut;
        if (drag.mode === "move") {
          let d = snapTick(deltaTicks);
          if (drag.startIn + d < 0) d = -drag.startIn;
          inT = drag.startIn + d;
          outT = drag.startOut + d;
        } else if (drag.mode === "trimIn") {
          inT = Math.max(0, Math.min(snapTick(drag.startIn + deltaTicks), outT - snap));
        } else {
          outT = Math.max(inT + snap, snapTick(drag.startOut + deltaTicks));
        }
        // Edit only the dragged window; materialize a ghost on first
        // drag, and preserve the window's source slip on a video clip.
        const existing = layers.find((l) => l.id === drag.nodeId)?.data.clips;
        let next: ClipBlock[];
        if (drag.clipIndex < 0 || !existing || existing.length === 0) {
          next = [defaultClip(inT, outT)];
        } else {
          next = existing.map((c, i) =>
            i === drag.clipIndex ? { ...c, inTick: inT, outTick: outT } : c
          );
        }
        onClipChange(drag.nodeId, next);
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
          // Option/Alt held → stagger the selection across lanes; the
          // drag delta becomes the per-lane step.
          if (drag.stagger) applyStagger(drag.bases, deltaTicks);
          else applyMove(drag.bases, deltaTicks);
        }
        if (moved !== drag.moved) setDrag({ ...drag, moved });
        return;
      }
      if (drag.kind === "scaleKf") {
        const rect = timelineRef.current?.getBoundingClientRect();
        if (!rect) return;
        const curEdge = pxToTick(e.clientX - rect.left);
        applyScale(drag.bases, drag.anchorTick, drag.startEdgeTick, curEdge);
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
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [
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
    applyMove,
    applyScale,
    applyStagger,
    display,
    layers,
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
      if (isSplit) {
        e.preventDefault();
        onSplitLayer(layer.id, currentTick);
        return;
      }
      const existing = layer.data.clips;
      const base =
        existing && existing.length > 0
          ? existing
          : [defaultClip(0, timeline.sceneDurationTicks)];
      // Only cut when the playhead is strictly inside a window.
      const inside = base.some(
        (c) => currentTick > c.inTick && currentTick < c.outTick
      );
      if (!inside) return;
      e.preventDefault();
      onClipChange(layer.id, splitClipsAt(base, Math.round(currentTick)));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    layers,
    selectedId,
    currentTick,
    onClipChange,
    onSplitLayer,
    timeline.sceneDurationTicks,
  ]);

  // ---- Ruler tick spacing ----
  const rulerSpacing = useMemo(() => {
    const pxPerFrame = pixelsPerTick * timeline.ticksPerFrame;
    if (pxPerFrame <= 0) return 60;
    const raw = 80 / pxPerFrame;
    const pow = Math.pow(10, Math.floor(Math.log10(Math.max(1, raw))));
    const norm = raw / pow;
    const nice = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
    return Math.max(1, Math.round(nice * pow));
  }, [pixelsPerTick, timeline.ticksPerFrame]);

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

  const playheadX = tickToPx(currentTick);

  const startBarDrag = (
    e: React.MouseEvent,
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
    setDrag({
      kind: "bar",
      nodeId,
      clipIndex,
      mode,
      startMouseX: e.clientX,
      startIn: inTick,
      startOut: outTick,
    });
  };

  // Mousedown on a keyframe diamond → update selection + start a move
  // drag (or shift-click to toggle without dragging).
  const startDiamondDrag = (
    e: React.MouseEvent,
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
      anchorTick: tick,
      bases: buildBases(sel),
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

  const startMarquee = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // Plain click on empty lane clears selection.
    setSelectedClip(null);
    setDrag({
      kind: "marquee",
      startX: e.clientX,
      startY: e.clientY,
      curX: e.clientX,
      curY: e.clientY,
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
        const rect = timelineRef.current?.getBoundingClientRect();
        if (!rect) return;
        const x = e.clientX - rect.left;
        setHoverX(x >= 0 && x <= rect.width ? x : null);
      }}
      onMouseLeave={() => setHoverX(null)}
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "#0a0a0a",
        color: "#e5e7eb",
        fontFamily: "ui-monospace, monospace",
        fontSize: 11,
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
            borderRight: "1px solid #1f1f23",
            borderBottom: "1px solid #1f1f23",
            display: "flex",
            alignItems: "center",
            paddingLeft: 8,
          }}
        >
          <button
            type="button"
            onClick={() => setAddMenuOpen((v) => !v)}
            title="Add a layer"
            style={{
              background: addMenuOpen ? "#26262b" : "#1c1c1f",
              border: `1px solid ${addMenuOpen ? "#52525b" : "#3f3f46"}`,
              color: addMenuOpen ? "#e1e1e1" : "#a1a1aa",
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
                background: "#18181b",
                border: "1px solid #27272a",
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
            borderBottom: "1px solid #1f1f23",
            overflow: "hidden",
            cursor: "ew-resize",
          }}
          onMouseDown={(e) => {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const snap = timeline.ticksPerFrame;
            onScrub(
              Math.max(
                0,
                Math.round(pxToTick(e.clientX - rect.left) / snap) * snap
              )
            );
            setDrag({ kind: "scrub" });
          }}
        >
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
                borderLeft: "1px solid #27272a",
                color: "#71717a",
                fontSize: 9,
                pointerEvents: "none",
              }}
            >
              {t.frame}
            </div>
          ))}
          {/* Hover preview line through the ruler. */}
          {hoverX != null && drag.kind === "none" && (
            <div
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: hoverX,
                width: 1,
                background: COLOR_PLAYHEAD,
                opacity: 0.3,
                pointerEvents: "none",
              }}
            />
          )}
          {/* Playhead triangle handle — drag to scrub. */}
          {playheadX >= 0 && playheadX <= lanesWidth && (
            <div
              style={{
                position: "absolute",
                left: playheadX - 6,
                top: 2,
                width: 12,
                height: RULER_HEIGHT - 4,
                cursor: "ew-resize",
              }}
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                setDrag({ kind: "scrub" });
              }}
            >
              <div
                style={{
                  width: 0,
                  height: 0,
                  margin: "0 auto",
                  borderLeft: "6px solid transparent",
                  borderRight: "6px solid transparent",
                  borderTop: `8px solid ${COLOR_PLAYHEAD}`,
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Body: rows. */}
      <div
        ref={lanesAreaRef}
        style={{ position: "relative", flex: 1, overflow: "auto" }}
        onMouseDown={(e) => {
          // Empty space (below / around the rows) starts a marquee too —
          // rows, bars and lanes have their own handlers, so this only
          // fires on the bare body.
          if (e.target === e.currentTarget) startMarquee(e);
        }}
      >
        {display.length === 0 && (
          <div style={{ padding: 16, color: "#52525b" }}>
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
                background: isSelected ? "#13131a" : "transparent",
                borderBottom: "1px solid #141417",
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
                  paddingLeft: 4,
                  borderRight: "1px solid #1f1f23",
                  cursor: "grab",
                  userSelect: "none",
                }}
                onMouseDown={(e) => {
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
                    color: "#71717a",
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
                    color: hidden ? "#3f3f46" : "#a1a1aa",
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
                    fontSize: 11,
                    color: hidden ? "#52525b" : isSelected ? "#e5e7eb" : "#c7c7cc",
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
                onMouseDown={() => onSelectLayer(layer.id)}
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
                    ? "#1b1b1f"
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
                    ? "#2a2a30"
                    : w.ghost
                      ? CLIP_GHOST_BORDER
                      : clipSelected
                        ? CLIP_BORDER_SELECTED
                        : CLIP_BORDER;
                  const gripCol = (active: boolean) =>
                    hidden
                      ? "#3f3f46"
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
                      onMouseDown={(e) =>
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
                      }}
                    >
                      <div
                        onMouseDown={(e) =>
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
                          width: region === "in" ? 5 : 3,
                          background: gripCol(region === "in"),
                          borderTopLeftRadius: 4,
                          borderBottomLeftRadius: 4,
                          cursor: "ew-resize",
                        }}
                      />
                      <div
                        onMouseDown={(e) =>
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
                          width: region === "out" ? 5 : 3,
                          background: gripCol(region === "out"),
                          borderTopRightRadius: 4,
                          borderBottomRightRadius: 4,
                          cursor: "ew-resize",
                        }}
                      />
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
                currentTick={currentTick}
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
                onDiamondMouseDown={(e, tick) =>
                  startDiamondDrag(e, track, tick)
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
              background: "#3b82f6",
              pointerEvents: "none",
            }}
          />
        )}

        {/* Marquee rubber-band. */}
        {drag.kind === "marquee" &&
          (() => {
            const cont = lanesAreaRef.current;
            const rect = cont?.getBoundingClientRect();
            if (!rect) return null;
            const sy = cont!.scrollTop;
            const left = Math.min(drag.startX, drag.curX) - rect.left;
            const top = Math.min(drag.startY, drag.curY) - rect.top + sy;
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
                  background: "rgba(59,130,246,0.12)",
                  border: "1px solid rgba(59,130,246,0.6)",
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
              border: "1px solid rgba(59,130,246,0.7)",
              background: "rgba(59,130,246,0.06)",
              cursor: "grab",
            }}
            onMouseDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              setDrag({
                kind: "moveKf",
                startMouseX: e.clientX,
                anchorTick: -1,
                bases: buildBases(selectionRef.current),
                stagger: e.altKey,
                moved: false,
              });
            }}
          >
            <div
              onMouseDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                setDrag({
                  kind: "scaleKf",
                  anchorTick: selectionBox.maxTick,
                  startEdgeTick: selectionBox.minTick,
                  bases: buildBases(selectionRef.current),
                });
              }}
              style={{
                position: "absolute",
                left: -3,
                top: 0,
                bottom: 0,
                width: 6,
                cursor: "ew-resize",
                background: "rgba(59,130,246,0.7)",
              }}
            />
            <div
              onMouseDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                setDrag({
                  kind: "scaleKf",
                  anchorTick: selectionBox.minTick,
                  startEdgeTick: selectionBox.maxTick,
                  bases: buildBases(selectionRef.current),
                });
              }}
              style={{
                position: "absolute",
                right: -3,
                top: 0,
                bottom: 0,
                width: 6,
                cursor: "ew-resize",
                background: "rgba(59,130,246,0.7)",
              }}
            />
          </div>
        )}

        {/* Hover preview line through the lanes (tracks the cursor). */}
        {hoverX != null && drag.kind === "none" && (
          <div
            style={{
              position: "absolute",
              left: LABEL_WIDTH + hoverX,
              top: 0,
              bottom: 0,
              width: 1,
              background: COLOR_PLAYHEAD,
              opacity: 0.3,
              pointerEvents: "none",
            }}
          />
        )}

        {/* Playhead line across the timeline portion. */}
        <div
          style={{
            position: "absolute",
            left: LABEL_WIDTH + playheadX,
            top: 0,
            bottom: 0,
            width: 1,
            background: COLOR_PLAYHEAD,
            opacity: 0.7,
            pointerEvents: "none",
            display: playheadX < 0 ? "none" : "block",
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
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as globalThis.Node)) onClose();
    };
    // Defer so the right-click that opened the menu doesn't immediately
    // dismiss it.
    const id = window.setTimeout(
      () => window.addEventListener("mousedown", onDown),
      0
    );
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);
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
        background: "#1a1a1f",
        border: "1px solid #27272a",
        borderRadius: 6,
        boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
        padding: 6,
      }}
    >
      <div
        style={{
          color: "#71717a",
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
    document.body
  );
}

function EasingTile({
  preset,
  size,
  disabled,
  label,
  onClick,
}: {
  preset: EasingPreset;
  size: number;
  disabled: boolean;
  label: string;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  const inset = 4;
  const w = size - inset * 2;
  const h = size - inset * 2;
  const path = easingPathFor(preset, w, h, 40);
  return (
    <button
      type="button"
      title={label}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onClick();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: size,
        height: size,
        padding: 0,
        background: hover && !disabled ? "#27272a" : "#101013",
        border: `1px solid ${hover && !disabled ? "#3f3f46" : "#27272a"}`,
        borderRadius: 4,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.35 : 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
        <line x1={0} y1={h * 0.82} x2={w} y2={h * 0.82} stroke="#2a2a30" strokeWidth={1} />
        <line x1={0} y1={h * 0.18} x2={w} y2={h * 0.18} stroke="#2a2a30" strokeWidth={1} />
        <path
          d={path}
          fill="none"
          stroke={hover && !disabled ? "#fbbf24" : "#3b82f6"}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
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
        background: hover ? "#26262b" : "transparent",
        border: "none",
        borderRadius: 4,
        color: hover ? "#e5e7eb" : "#c7c7cc",
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
  currentTick,
  tickToPx,
  selSet,
  onToggleKey,
  onSeek,
  graphOn,
  onToggleGraph,
  onDiamondMouseDown,
  onDiamondContextMenu,
  onMarqueeStart,
}: {
  track: LayerTrack;
  block: KeyframeAnimationBlock | undefined;
  currentTick: number;
  tickToPx: (tick: number) => number;
  selSet: Set<string>;
  onToggleKey: () => void;
  onSeek: (tick: number) => void;
  graphOn: boolean;
  // Present only for scalar tracks (the graph editor draws scalars).
  onToggleGraph?: () => void;
  onDiamondMouseDown: (e: React.MouseEvent, tick: number) => void;
  onDiamondContextMenu: (e: React.MouseEvent, tick: number) => void;
  onMarqueeStart: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        height: LANE_HEIGHT,
        background: "#0c0c0e",
        borderBottom: "1px solid #141417",
      }}
    >
      <div
        style={{
          width: LABEL_WIDTH,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 8,
          paddingLeft: 26,
          borderRight: "1px solid #1f1f23",
        }}
      >
        <DiamondNav
          block={block}
          currentTick={currentTick}
          onToggle={onToggleKey}
          onSeek={onSeek}
        />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: "#9ca3af",
            fontSize: 10,
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
              background: graphOn ? "#3b82f6" : "transparent",
              color: graphOn ? "#fff" : "#52525b",
              border: "1px solid #27272a",
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
        style={{ position: "relative", flex: 1, overflow: "hidden" }}
        onMouseDown={(e) => {
          // Container-level hit-test (mirrors the Track editor): only
          // left-click acts. Right-click / ctrl-click fall through to
          // onContextMenu — no drag, no playhead move.
          if (e.button !== 0 || e.ctrlKey) return;
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const x = e.clientX - rect.left;
          const hit = hitTestTick(block, tickToPx, x);
          if (hit != null) onDiamondMouseDown(e, hit);
          else onMarqueeStart(e);
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
          return (
            <div
              key={`seg:${prev.tick}:${k.tick}`}
              style={{
                position: "absolute",
                top: LANE_HEIGHT / 2 - 0.5,
                left: x0,
                width: x1 - x0,
                height: 1,
                background: prev.easingOut === "hold" ? "#52525b" : "#3f3f46",
                opacity: 0.6,
                pointerEvents: "none",
              }}
            />
          );
        })}
        {(block?.keyframes ?? []).map((k) => {
          const isSel = selSet.has(
            `${track.nodeId} ${track.paramName} ${k.tick}`
          );
          const x = tickToPx(k.tick);
          return (
            <div
              key={k.tick}
              style={{
                position: "absolute",
                left: x - 4,
                top: LANE_HEIGHT / 2 - 4,
                width: 8,
                height: 8,
                transform: "rotate(45deg)",
                background: isSel ? COLOR_DIAMOND_SELECTED : COLOR_DIAMOND,
                border: `1px solid ${isSel ? "#fff" : "#92400e"}`,
                boxShadow: isSel ? "0 0 0 2px rgba(59,130,246,0.35)" : "none",
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
  const KEY_HIT_PX = 7;
  let best: { tick: number; d: number } | null = null;
  for (const k of block?.keyframes ?? []) {
    const d = Math.abs(tickToPx(k.tick) - x);
    if (d <= KEY_HIT_PX && (!best || d < best.d)) best = { tick: k.tick, d };
  }
  return best ? best.tick : null;
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
