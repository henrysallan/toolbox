"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { Edge, Node } from "@xyflow/react";
import type { NodeDataPayload } from "@/state/graph";
import { useClock } from "@/state/playback-clock";
import {
  type EasingPreset,
  type Keyframe,
  type KeyframeAnimationBlock,
  type ProjectTimeline,
  EASING_PRESET_ORDER,
  EASING_PRESET_LABELS,
  easingPathFor,
  emptyAnimationBlock,
  evaluateKeyframesAt,
  findKeyframeAt,
  diamondStateFor,
  isStepOnly,
  removeKeyframeAt,
  snapTickToFrame,
  upsertKeyframe,
} from "@/engine/keyframes";
import { getNodeDef } from "@/engine/registry";
import { getEffectiveDevice } from "./input-device";
import { GROUP_TYPE } from "@/engine/groups";
import { resolvePromotedParams } from "@/state/graph-ops";
import { LAYER_OPACITY_PREFIX, parseRampParamKey } from "@/engine/conventions";
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
// Constants & theme
// ---------------------------------------------------------------------

const COLOR_BG = "#0a0a0a";
const COLOR_LANE_SEP = "#141417";
const COLOR_BORDER = "#27272a";
const COLOR_MUTED = "#52525b";
const COLOR_TEXT = "#d4d4d8";
const COLOR_ACCENT = "#3b82f6";
const COLOR_PLAYHEAD = "#22c55e";
const COLOR_DIAMOND = "#f59e0b";
const COLOR_DIAMOND_SELECTED = COLOR_ACCENT;
// Clip bar palette. Teal so clips read distinctly from the amber keyframes.
// Base is intentionally dim; hover and selected brighten progressively.
const COLOR_CLIP_FILL = "#123c44"; // dim resting fill
const COLOR_CLIP_FILL_HOVER = "#185863"; // brighter on hover
const COLOR_CLIP_FILL_SELECTED = "#0e7490"; // brightest, selected
const COLOR_CLIP_BORDER = "#1d6373"; // dim resting border
const COLOR_CLIP_BORDER_SELECTED = "#67e8f9"; // bright cyan when selected
const COLOR_CLIP_HANDLE = "#2b8093"; // resting edge grip
const COLOR_CLIP_HANDLE_HOVER = "#a5f3fc"; // grip lit on hover
const COLOR_CLIP_GHOST = "rgba(34, 211, 238, 0.07)";

const RULER_HEIGHT = 24;
const NODE_HEADER_HEIGHT = 22;
const INSPECTOR_HEIGHT = 28;
const PARAM_LABEL_WIDTH = 184;

const DEFAULT_TRACK_HEIGHT = 28;
const MIN_TRACK_HEIGHT = 16;
const MAX_TRACK_HEIGHT = 64;

const MIN_PIXELS_PER_TICK = 0.0002;
const MAX_PIXELS_PER_TICK = 1.5;

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

interface SelectionKey {
  nodeId: string;
  paramName: string;
  tick: number;
}

function selKey(s: SelectionKey): string {
  return `${s.nodeId}\u0000${s.paramName}\u0000${s.tick}`;
}

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
    }
  | {
      kind: "moveKeyframes";
      startMouseX: number;
      // Snapshot of original ticks per selected key.
      starts: Map<string, number>;
      // Per-(nodeId, paramName) snapshot of the entire keyframe array at
      // drag-start, so each mousemove can rebuild the array from a stable
      // baseline. Without this, after the first apply the live block has
      // the new ticks and we lose the ability to look up originals.
      groupBases: Map<
        string,
        {
          nodeId: string;
          paramName: string;
          originals: Keyframe[];
          selectedOriginalTicks: Set<number>;
        }
      >;
      // Anchor tick used to compute snapping.
      anchorStartTick: number;
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
      // Anchor (opposite edge in ticks) and starts snapshot.
      anchorTick: number;
      startEdgeTick: number;
      starts: Map<string, number>;
      groupBases: Map<
        string,
        {
          nodeId: string;
          paramName: string;
          originals: Keyframe[];
          selectedOriginalTicks: Set<number>;
        }
      >;
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
  // Clock read from the playback store (clock-store spec, step 3): this
  // editor re-renders per frame by design (playhead + diamond states);
  // subscribing here keeps the tick off the shell's props.
  const currentTick = useClock((s) => s.tick);
  const fullNodes = allNodes ?? nodes;
  // Stable identity for the no-edges fallback so downstream memos don't
  // recompute every render.
  const allEdges = useMemo(() => edges ?? [], [edges]);

  // --- View state (local) ---
  const [viewTickOffset, setViewTickOffset] = useState(0); // leftmost visible tick
  const [pixelsPerTick, setPixelsPerTick] = useState(0.01); // adjusted on first mount
  const [trackHeight, setTrackHeight] = useState(DEFAULT_TRACK_HEIGHT);
  const [scrollY, setScrollY] = useState(0);

  // --- Selection ---
  const [selection, setSelection] = useState<Set<string>>(new Set());
  // Mirror selection content as objects for inspector/easing ops (parallel
  // to the string set so order-of-most-recent click is preserved).
  const [selectionList, setSelectionList] = useState<SelectionKey[]>([]);

  // --- Drag / context menu ---
  const [drag, setDrag] = useState<DragKind>({ kind: "none" });
  // Cursor x (px within the lanes viewport) while hovering — drives the
  // faded playhead-preview line. Null when the cursor is off the lanes.
  const [hoverX, setHoverX] = useState<number | null>(null);
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
  razorModeRef.current = razorMode;
  // Latest split-at-playhead action, so the window keydown handler (which is
  // re-subscribed only on selection change) always splits at the live tick.
  const splitAtPlayheadRef = useRef<() => void>(() => {});

  // Clip selection (one window) and hover, for styling + cursor + delete.
  type ClipRef = { nodeId: string; clipIndex: number };
  const [selectedClip, setSelectedClip] = useState<ClipRef | null>(null);
  const [hoveredClip, setHoveredClip] = useState<
    (ClipRef & { region: "in" | "out" | "body" }) | null
  >(null);
  // Refs so the selection-scoped keydown handler sees the live values.
  const selectedClipRef = useRef<ClipRef | null>(null);
  selectedClipRef.current = selectedClip;
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
      y += row.kind === "nodeHeader" ? NODE_HEADER_HEIGHT : trackHeight;
    }
    return ys;
  }, [lanes, trackHeight]);
  const totalLanesHeight =
    laneRowYs.length === 0
      ? 0
      : laneRowYs[laneRowYs.length - 1] +
        (lanes[lanes.length - 1].kind === "nodeHeader"
          ? NODE_HEADER_HEIGHT
          : trackHeight);

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

  // ---- Fit on first mount: scale pixelsPerTick so sceneDuration fits ----
  useEffect(() => {
    if (fitDoneRef.current) return;
    if (containerWidth <= 0) return;
    const lanesPx = Math.max(50, containerWidth);
    const pad = 0.95;
    const pps =
      timeline.sceneDurationTicks > 0
        ? (lanesPx * pad) / timeline.sceneDurationTicks
        : 0.01;
    setPixelsPerTick(
      Math.max(MIN_PIXELS_PER_TICK, Math.min(MAX_PIXELS_PER_TICK, pps))
    );
    setViewTickOffset(0);
    fitDoneRef.current = true;
  }, [containerWidth, timeline.sceneDurationTicks]);

  // ---- Helpers: tick <-> pixel ----
  const lanesAreaWidth = Math.max(50, containerWidth);

  const tickToPx = useCallback(
    (tick: number) => (tick - viewTickOffset) * pixelsPerTick,
    [viewTickOffset, pixelsPerTick]
  );
  const pxToTick = useCallback(
    (px: number) => viewTickOffset + px / pixelsPerTick,
    [viewTickOffset, pixelsPerTick]
  );

  // ---- Fit handler (Home key behavior, also exposed via toolbar) ----
  const fit = useCallback(() => {
    if (lanesAreaWidth <= 0) return;
    const pad = 0.95;
    const pps =
      timeline.sceneDurationTicks > 0
        ? (lanesAreaWidth * pad) / timeline.sceneDurationTicks
        : 0.01;
    setPixelsPerTick(
      Math.max(MIN_PIXELS_PER_TICK, Math.min(MAX_PIXELS_PER_TICK, pps))
    );
    setViewTickOffset(0);
  }, [lanesAreaWidth, timeline.sceneDurationTicks]);

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
        const tickAtCursor = pxToTick(mx);
        const mag = Math.abs(dx) > Math.abs(dy) ? dx : dy;
        setPixelsPerTick((prev) => {
          const factor = Math.exp(-mag * 0.0015);
          const next = Math.max(
            MIN_PIXELS_PER_TICK,
            Math.min(MAX_PIXELS_PER_TICK, prev * factor)
          );
          setViewTickOffset(tickAtCursor - mx / next);
          return next;
        });
        return;
      }

      // Cmd / Ctrl + wheel = horizontal zoom anchored to cursor.
      // Driven by horizontal scroll (deltaX), since the lane time axis
      // is horizontal — vertical scroll keeps panning the lane list.
      if ((e.metaKey || e.ctrlKey) && overLanes && lanesRect && dx !== 0) {
        e.preventDefault();
        e.stopPropagation();
        const mx = e.clientX - lanesRect.left;
        const tickAtCursor = pxToTick(mx);
        setPixelsPerTick((prev) => {
          const factor = Math.exp(-dx * 0.0015);
          const next = Math.max(
            MIN_PIXELS_PER_TICK,
            Math.min(MAX_PIXELS_PER_TICK, prev * factor)
          );
          const newOffset = tickAtCursor - mx / next;
          setViewTickOffset(newOffset);
          return next;
        });
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
  }, [pxToTick, pixelsPerTick, totalLanesHeight]);

  // Middle-button pointerdown: stop it reaching the preview canvas's
  // window-level middle-drag pan (bug #2 — the bleed-through). Scoped to
  // button 1 so left-button keyframe interactions are untouched. Plain
  // middle-drag pans via the React onMouseDown above (the compat mousedown
  // still fires); Cmd/Ctrl + middle-drag zooms the time axis here.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 1) return;
      e.stopPropagation();
      if (!(e.metaKey || e.ctrlKey)) return;
      // preventDefault suppresses the compat mousedown, so the React pan
      // handler won't also fire for this Cmd/Ctrl + middle gesture.
      e.preventDefault();
      const rect = lanesAreaRef.current?.getBoundingClientRect();
      if (!rect) return;
      const startX = e.clientX;
      const startY = e.clientY;
      const anchorX = startX - rect.left;
      const startPpt = pixelsPerTick;
      const tickAt = viewTickOffset + anchorX / startPpt;
      const onMove = (ev: PointerEvent) => {
        // Drag up zooms in (larger pixels-per-tick).
        const factor = Math.exp(-(ev.clientY - startY) * 0.0015);
        const next = Math.max(
          MIN_PIXELS_PER_TICK,
          Math.min(MAX_PIXELS_PER_TICK, startPpt * factor)
        );
        setViewTickOffset(tickAt - anchorX / next);
        setPixelsPerTick(next);
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

  // ---- Keyboard: space-pan, delete, escape ----
  // Delete/Backspace is gated by `hoveredRef` so the keyframe deletion
  // only fires while the mouse is over the Track Editor — otherwise the
  // node-graph editor's own delete handler is the right target.
  const hoveredRef = useRef(false);
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;

      if (e.code === "Space" && !spaceDownRef.current && !e.shiftKey) {
        // !shiftKey so Shift+Space (the pie menu chord) never starts a pan.
        spaceDownRef.current = true;
        setSpaceDown(true);
        e.preventDefault();
        return;
      }
      if (e.key === "Escape") {
        setSelection(new Set());
        setSelectionList([]);
        setSelectedClip(null);
        setMenu(null);
        setRazorMode(false);
        return;
      }
      // Tool shortcuts (only while hovering the editor so bare keys don't
      // hijack typing elsewhere): C = razor/blade, V = select.
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
        if (selection.size === 0) return;
        e.preventDefault();
        e.stopPropagation();
        deleteSelected();
      }
      // Copy / paste — only when hovering the editor so the global
      // Cmd+C / Cmd+V shortcuts don't get hijacked elsewhere.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
        if (!hoveredRef.current) return;
        if (selection.size === 0) return;
        e.preventDefault();
        e.stopPropagation();
        copySelected();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") {
        if (!hoveredRef.current) return;
        if (!clipboardRef.current) return;
        e.preventDefault();
        e.stopPropagation();
        pasteAtPlayhead();
      }
      // TODO: keyboard shortcuts for Home (fit) and F (focus selection).
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "Space") {
        spaceDownRef.current = false;
        setSpaceDown(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [selection]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Snapshot the original keyframe arrays for every (nodeId, paramName)
  // touched by `sel`, plus which of their ticks were selected. Used as
  // the immutable baseline for in-progress drags so each mousemove
  // recomputes from the original state instead of the just-mutated one.
  function buildGroupBases(sel: SelectionKey[]) {
    const bases = new Map<
      string,
      {
        nodeId: string;
        paramName: string;
        originals: Keyframe[];
        selectedOriginalTicks: Set<number>;
      }
    >();
    for (const s of sel) {
      const gkey = `${s.nodeId} ${s.paramName}`;
      let entry = bases.get(gkey);
      if (!entry) {
        const block = blockIndex.get(s.nodeId)?.get(s.paramName);
        if (!block) continue;
        entry = {
          nodeId: s.nodeId,
          paramName: s.paramName,
          originals: block.keyframes.map((k) => ({ ...k })),
          selectedOriginalTicks: new Set<number>(),
        };
        bases.set(gkey, entry);
      }
      entry.selectedOriginalTicks.add(s.tick);
    }
    return bases;
  }

  // Group selection entries by (nodeId, paramName) so we can emit one
  // onAnimationChange per affected block.
  function groupSelection(sel: SelectionKey[]) {
    const groups = new Map<string, SelectionKey[]>();
    for (const s of sel) {
      const k = `${s.nodeId}\u0000${s.paramName}`;
      const list = groups.get(k);
      if (list) list.push(s);
      else groups.set(k, [s]);
    }
    return groups;
  }

  function deleteSelected() {
    if (selectionList.length === 0) return;
    const groups = groupSelection(selectionList);
    for (const [, items] of groups) {
      const { nodeId, paramName } = items[0];
      const block = blockIndex.get(nodeId)?.get(paramName);
      if (!block) continue;
      let next: KeyframeAnimationBlock = block;
      for (const it of items) {
        next = removeKeyframeAt(next, it.tick);
      }
      onAnimationChange(nodeId, paramName, next);
    }
    setSelection(new Set());
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
    // Group pastes by (nodeId, paramName) so each affected block emits
    // a single onAnimationChange call.
    const grouped = new Map<
      string,
      {
        nodeId: string;
        paramName: string;
        items: { tick: number; keyframe: Keyframe }[];
      }
    >();
    for (const it of clip.items) {
      const targetTick = currentTick + it.offsetTicks;
      const key = `${it.nodeId} ${it.paramName}`;
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
      onAnimationChange(g.nodeId, g.paramName, {
        ...block,
        animated: true,
        keyframes: merged,
      });
      for (const i of g.items) {
        newSelection.push({
          nodeId: g.nodeId,
          paramName: g.paramName,
          tick: i.tick,
        });
      }
    }
    setSelectionList(newSelection);
    setSelection(new Set(newSelection.map(selKey)));
  }

  // Add / remove a keyframe at the playhead for a track (the lane-label
  // diamond). Mirrors the param-panel diamond.
  function toggleKeyAtPlayhead(
    nodeId: string,
    paramName: string,
    type: ParamType
  ) {
    const block = blockIndex.get(nodeId)?.get(paramName);
    if (block && findKeyframeAt(block, currentTick)) {
      const next = removeKeyframeAt(block, currentTick);
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
        ? evaluateKeyframesAt(block, type, currentTick)
        : node?.data.params[paramName];
    const base = block ?? emptyAnimationBlock();
    onAnimationChange(
      nodeId,
      paramName,
      upsertKeyframe({ ...base, animated: true }, currentTick, value)
    );
  }

  function setKeyframeEasing(targets: SelectionKey[], easing: EasingPreset) {
    if (targets.length === 0) return;
    const groups = groupSelection(targets);
    for (const [, items] of groups) {
      const { nodeId, paramName } = items[0];
      const block = blockIndex.get(nodeId)?.get(paramName);
      if (!block) continue;
      const ticksToChange = new Set(items.map((it) => it.tick));
      const nextKfs = block.keyframes.map((k) =>
        ticksToChange.has(k.tick) ? { ...k, easingOut: easing } : k
      );
      onAnimationChange(nodeId, paramName, { ...block, keyframes: nextKfs });
    }
  }

  function moveKeyframesByDelta(
    groupBases: Map<
      string,
      {
        nodeId: string;
        paramName: string;
        originals: Keyframe[];
        selectedOriginalTicks: Set<number>;
      }
    >,
    deltaTicks: number,
    snap: boolean
  ) {
    // Rebuild every affected block from its drag-start snapshot.
    const newSelectionListMK: SelectionKey[] = [];
    for (const baseMK of groupBases.values()) {
      const blockMK = blockIndex.get(baseMK.nodeId)?.get(baseMK.paramName);
      if (!blockMK) continue;
      const remappedMK: Keyframe[] = baseMK.originals.map((k) => {
        if (!baseMK.selectedOriginalTicks.has(k.tick)) return { ...k };
        let target = k.tick + deltaTicks;
        if (snap) target = snapTickToFrame(target, timeline.ticksPerFrame);
        target = Math.round(target);
        return { ...k, tick: target };
      });
      const seenMK = new Map<number, Keyframe>();
      for (const k of remappedMK) seenMK.set(k.tick, k);
      const sortedMK = [...seenMK.values()].sort((a, b) => a.tick - b.tick);
      onAnimationChange(
        baseMK.nodeId,
        baseMK.paramName,
        {
          ...blockMK,
          keyframes: sortedMK,
        },
        "kf-batch"
      );
      for (const origTick of baseMK.selectedOriginalTicks) {
        let target = origTick + deltaTicks;
        if (snap) target = snapTickToFrame(target, timeline.ticksPerFrame);
        target = Math.round(target);
        newSelectionListMK.push({
          nodeId: baseMK.nodeId,
          paramName: baseMK.paramName,
          tick: target,
        });
      }
    }
    setSelectionList(newSelectionListMK);
    setSelection(new Set(newSelectionListMK.map(selKey)));
  }

  // Stagger: order the selected lanes top → bottom (by lane row index);
  // the topmost stays static and each lane below offsets its keys by
  // `stepTicks × order`, preserving intra-track spacing. `stepTicks` is
  // snapped to a frame so every offset is frame-aligned. No-op when only
  // one lane is selected.
  function staggerKeyframes(
    groupBases: Map<
      string,
      {
        nodeId: string;
        paramName: string;
        originals: Keyframe[];
        selectedOriginalTicks: Set<number>;
      }
    >,
    stepTicks: number
  ) {
    const step = Math.round(snapTickToFrame(stepTicks, timeline.ticksPerFrame));
    const laneIndexOf = (nodeId: string, paramName: string) =>
      lanes.findIndex(
        (r) =>
          r.kind === "paramLane" &&
          r.nodeId === nodeId &&
          r.paramName === paramName
      );
    const ordered = [...groupBases.values()]
      .map((b) => ({ b, idx: laneIndexOf(b.nodeId, b.paramName) }))
      .sort((a, b) => a.idx - b.idx);
    const newSel: SelectionKey[] = [];
    ordered.forEach(({ b }, k) => {
      const block = blockIndex.get(b.nodeId)?.get(b.paramName);
      if (!block) return;
      const offset = step * k;
      const remapped = b.originals.map((kf) =>
        b.selectedOriginalTicks.has(kf.tick)
          ? { ...kf, tick: Math.max(0, kf.tick + offset) }
          : { ...kf }
      );
      const seen = new Map<number, Keyframe>();
      for (const kf of remapped) seen.set(kf.tick, kf);
      const sorted = [...seen.values()].sort((a, b) => a.tick - b.tick);
      onAnimationChange(
        b.nodeId,
        b.paramName,
        { ...block, keyframes: sorted },
        "kf-batch"
      );
      for (const ot of b.selectedOriginalTicks) {
        newSel.push({
          nodeId: b.nodeId,
          paramName: b.paramName,
          tick: Math.max(0, ot + offset),
        });
      }
    });
    setSelectionList(newSel);
    setSelection(new Set(newSel.map(selKey)));
  }

  function scaleKeyframes(
    groupBases: Map<
      string,
      {
        nodeId: string;
        paramName: string;
        originals: Keyframe[];
        selectedOriginalTicks: Set<number>;
      }
    >,
    anchorTick: number,
    startEdgeTick: number,
    currentEdgeTick: number,
    snap: boolean
  ) {
    const span = startEdgeTick - anchorTick;
    if (Math.abs(span) < 1) return;
    const factor = (currentEdgeTick - anchorTick) / span;
    const newSelectionList: SelectionKey[] = [];
    for (const base of groupBases.values()) {
      const block = blockIndex.get(base.nodeId)?.get(base.paramName);
      if (!block) continue;
      const remapped = base.originals.map((k) => {
        if (!base.selectedOriginalTicks.has(k.tick)) return { ...k };
        let target = anchorTick + (k.tick - anchorTick) * factor;
        if (snap) target = snapTickToFrame(target, timeline.ticksPerFrame);
        target = Math.round(target);
        return { ...k, tick: target };
      });
      const seen = new Map<number, Keyframe>();
      for (const k of remapped) seen.set(k.tick, k);
      const sorted = [...seen.values()].sort((a, b) => a.tick - b.tick);
      onAnimationChange(
        base.nodeId,
        base.paramName,
        {
          ...block,
          keyframes: sorted,
        },
        "kf-batch"
      );
      for (const origTick of base.selectedOriginalTicks) {
        let target = anchorTick + (origTick - anchorTick) * factor;
        if (snap) target = snapTickToFrame(target, timeline.ticksPerFrame);
        target = Math.round(target);
        newSelectionList.push({
          nodeId: base.nodeId,
          paramName: base.paramName,
          tick: target,
        });
      }
    }
    setSelectionList(newSelectionList);
    setSelection(new Set(newSelectionList.map(selKey)));
  }

  // ---- Hit testing on lanes ----
  // Returns the keyframe selection key + lane row index for a click within
  // the lanes content area.
  function hitTestKeyframe(
    contentX: number,
    contentY: number
  ): { key: SelectionKey; rowIdx: number } | null {
    const KEY_HIT_PX = 6;
    for (let i = 0; i < lanes.length; i++) {
      const row = lanes[i];
      if (row.kind !== "paramLane") continue;
      const yTop = laneRowYs[i];
      const yBot = yTop + trackHeight;
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
    const EDGE = 6;
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
    const headers = lanes.filter(
      (r): r is Extract<LaneRow, { kind: "nodeHeader" }> =>
        r.kind === "nodeHeader" && r.clippable
    );
    const selected = headers.filter((h) => h.selected);
    const targets = selected.length > 0 ? selected : headers;
    for (const h of targets) {
      const hasClips = !!h.clips && h.clips.length > 0;
      if (hasClips) {
        if (resolveClipAt(h.clips, currentTick).active) {
          splitClipAtTick(h.nodeId, currentTick);
        }
      } else if (selected.length > 0) {
        // Explicitly targeted, no windows yet → materialize + cut.
        splitClipAtTick(h.nodeId, currentTick);
      }
    }
  }
  splitAtPlayheadRef.current = splitAtPlayhead;

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
  deleteSelectedClipRef.current = deleteSelectedClip;

  // ---- Selection bounding box (in ticks + row idx range) ----
  const selectionBox = useMemo(() => {
    if (selectionList.length < 2) return null;
    let minTick = Infinity;
    let maxTick = -Infinity;
    let minRow = Infinity;
    let maxRow = -Infinity;
    // Build a fast lookup nodeId+paramName -> rowIdx.
    const rowIdx = new Map<string, number>();
    for (let i = 0; i < lanes.length; i++) {
      const r = lanes[i];
      if (r.kind === "paramLane")
        rowIdx.set(`${r.nodeId}\u0000${r.paramName}`, i);
    }
    for (const s of selectionList) {
      if (s.tick < minTick) minTick = s.tick;
      if (s.tick > maxTick) maxTick = s.tick;
      const ri = rowIdx.get(`${s.nodeId}\u0000${s.paramName}`);
      if (ri == null) continue;
      if (ri < minRow) minRow = ri;
      if (ri > maxRow) maxRow = ri;
    }
    if (!isFinite(minTick) || !isFinite(minRow)) return null;
    return { minTick, maxTick, minRow, maxRow };
  }, [selectionList, lanes]);

  // ---- Mouse interactions on the lanes area ----
  function onLanesMouseDown(e: React.MouseEvent) {
    // Middle-click = pan (handled here without requiring Space). Cmd/Ctrl +
    // middle-drag = zoom instead, which the native pointerdown listener owns —
    // bail here so we don't also start a pan.
    if (e.button === 1) {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        return;
      }
      const rect = lanesAreaRef.current?.getBoundingClientRect();
      if (!rect) return;
      e.preventDefault();
      setDrag({
        kind: "pan",
        startMouseX: e.clientX,
        startMouseY: e.clientY,
        startTickOffset: viewTickOffset,
        startScrollY: scrollY,
      });
      return;
    }
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
      setSelection(new Set());
      setSelectionList([]);
      // Materialize a window-less node's ghost into a real full-duration
      // window so the drag has a stable baseline (and it persists). For video
      // this is clamped to the footage length.
      let startClips = clipsForNode(clipHit.nodeId);
      if (!startClips || startClips.length === 0) {
        startClips = [defaultClipForNode(clipHit.nodeId)];
        onClipChange?.(clipHit.nodeId, startClips);
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
        (yBotRow?.kind === "nodeHeader" ? NODE_HEADER_HEIGHT : trackHeight);
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
        const starts = new Map<string, number>();
        for (const s of selectionList) starts.set(selKey(s), s.tick);
        setDrag({
          kind: "scaleSelection",
          side: "left",
          anchorTick: selectionBox.maxTick,
          startEdgeTick: selectionBox.minTick,
          starts,
          groupBases: buildGroupBases(selectionList),
        });
        e.preventDefault();
        return;
      }
      if (allowScale && inYBand && Math.abs(contentX - rightPx) <= EDGE) {
        const starts = new Map<string, number>();
        for (const s of selectionList) starts.set(selKey(s), s.tick);
        setDrag({
          kind: "scaleSelection",
          side: "right",
          anchorTick: selectionBox.minTick,
          startEdgeTick: selectionBox.maxTick,
          starts,
          groupBases: buildGroupBases(selectionList),
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
        // Always treat interior-drag as group-move, even if the cursor is
        // over a keyframe (keyframe-click path below handles non-selected).
        if (
          hit &&
          !selection.has(selKey(hit.key)) &&
          !e.shiftKey
        ) {
          // Click on a non-selected keyframe inside the box: replace selection.
          const ne: SelectionKey[] = [hit.key];
          setSelection(new Set([selKey(hit.key)]));
          setSelectionList(ne);
          // Start a single-keyframe move below.
          const starts = new Map<string, number>();
          starts.set(selKey(hit.key), hit.key.tick);
          setDrag({
            kind: "moveKeyframes",
            startMouseX: e.clientX,
            starts,
            anchorStartTick: hit.key.tick,
            groupBases: buildGroupBases([hit.key]),
            stagger: e.altKey,
          });
          e.preventDefault();
          return;
        }
        const starts = new Map<string, number>();
        for (const s of selectionList) starts.set(selKey(s), s.tick);
        setDrag({
          kind: "moveKeyframes",
          startMouseX: e.clientX,
          starts,
          anchorStartTick: selectionList[0]?.tick ?? 0,
          groupBases: buildGroupBases(selectionList),
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
        // Toggle membership.
        if (selection.has(k)) {
          const nextSet = new Set(selection);
          nextSet.delete(k);
          setSelection(nextSet);
          setSelectionList(selectionList.filter((s) => selKey(s) !== k));
        } else {
          const nextSet = new Set(selection);
          nextSet.add(k);
          setSelection(nextSet);
          setSelectionList([...selectionList, hit.key]);
        }
      } else {
        if (!selection.has(k)) {
          setSelection(new Set([k]));
          setSelectionList([hit.key]);
        }
      }
      // Start a move drag on the (possibly-updated) selection.
      const starts = new Map<string, number>();
      const effective = selection.has(k) ? selectionList : [hit.key];
      for (const s of effective) starts.set(selKey(s), s.tick);
      setDrag({
        kind: "moveKeyframes",
        startMouseX: e.clientX,
        starts,
        anchorStartTick: hit.key.tick,
        groupBases: buildGroupBases(effective),
        stagger: e.altKey,
      });
      e.preventDefault();
      return;
    }

    // Empty space: begin marquee box-select.
    setDrag({
      kind: "marquee",
      startMouseX: mx,
      startMouseY: my,
      currentMouseX: mx,
      currentMouseY: my,
    });
    if (!e.shiftKey) {
      setSelection(new Set());
      setSelectionList([]);
    }
    e.preventDefault();
  }

  // Window-level mousemove/mouseup for active drag.
  useEffect(() => {
    if (drag.kind === "none") return;
    function onMove(e: MouseEvent) {
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
        const dxPx = e.clientX - drag.startMouseX;
        const deltaTicks = dxPx / pixelsPerTick;
        if (drag.stagger) {
          // Option/Alt held → stagger the selection across lanes; the
          // drag delta becomes the per-lane step.
          staggerKeyframes(drag.groupBases, deltaTicks);
        } else {
          moveKeyframesByDelta(drag.groupBases, deltaTicks, !e.shiftKey);
        }
        return;
      }
      if (drag.kind === "scaleSelection") {
        const currentEdgeTick = pxToTick(mx);
        const snap = !e.shiftKey;
        scaleKeyframes(
          drag.groupBases,
          drag.anchorTick,
          drag.startEdgeTick,
          currentEdgeTick,
          snap
        );
        return;
      }
      if (drag.kind === "clipMove") {
        const win = drag.startClips[drag.clipIndex];
        if (!win) return;
        const snap = !e.shiftKey;
        let delta = (e.clientX - drag.startMouseX) / pixelsPerTick;
        if (snap) {
          const snappedIn = snapTickToFrame(
            win.inTick + delta,
            timeline.ticksPerFrame
          );
          delta = snappedIn - win.inTick;
        }
        let newIn = win.inTick + delta;
        let newOut = win.outTick + delta;
        // Keep the window on the non-negative side of the timeline.
        if (newIn < 0) {
          newOut -= newIn;
          newIn = 0;
        }
        const next = drag.startClips.map((c, i) =>
          i === drag.clipIndex
            ? { ...c, inTick: Math.round(newIn), outTick: Math.round(newOut) }
            : c
        );
        onClipChange?.(drag.nodeId, next);
        return;
      }
      if (drag.kind === "clipTrim") {
        const win = drag.startClips[drag.clipIndex];
        if (!win) return;
        const snap = !e.shiftKey;
        const minW = timeline.ticksPerFrame;
        const raw = pxToTick(mx);
        const t = snap ? snapTickToFrame(raw, timeline.ticksPerFrame) : raw;
        let updated: ClipBlock;
        if (drag.side === "in") {
          // Clock-carrying clips can't pull the head earlier than the content
          // anchor: for video that's the start of the footage (sourceIn would
          // go negative), for a layer its interior's time zero.
          const minIn = drag.slipsInTrim
            ? Math.max(0, win.inTick - win.sourceInTick)
            : 0;
          const newIn = Math.round(
            Math.max(minIn, Math.min(t, win.outTick - minW))
          );
          // Clock-carrying clips slip the source so the content under the
          // trimmed head stays put (classic NLE in-trim).
          const sourceIn = drag.slipsInTrim
            ? win.sourceInTick + (newIn - win.inTick)
            : win.sourceInTick;
          updated = { ...win, inTick: newIn, sourceInTick: sourceIn };
        } else {
          let newOut = Math.round(Math.max(win.inTick + minW, t));
          // For video, the tail can't run past the end of the footage.
          if (drag.sourceDurationTicks != null) {
            const maxOut =
              win.inTick + (drag.sourceDurationTicks - win.sourceInTick);
            newOut = Math.min(newOut, Math.round(maxOut));
          }
          updated = { ...win, outTick: newOut };
        }
        const next = drag.startClips.map((c, i) =>
          i === drag.clipIndex ? updated : c
        );
        onClipChange?.(drag.nodeId, next);
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
          const yBot = yTop + trackHeight;
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
        setSelection(new Set(newList.map(selKey)));
        setSelectionList(newList);
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
    totalLanesHeight,
    scrollY,
    pxToTick,
    laneRowYs,
    lanes,
    trackHeight,
    selectionList,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const k = selKey(hit.key);
    if (!selection.has(k)) {
      setSelection(new Set([k]));
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
    const t = window.setTimeout(() => {
      window.addEventListener("mousedown", onDown);
    }, 0);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("mousedown", onDown);
    };
  }, [menu]);

  // ---- Stagger from the dock header control ----
  // The control fires `keyframe-stagger-begin` (we snapshot a ≥2-lane
  // selection and report back), `keyframe-stagger` (apply step live),
  // and `keyframe-stagger-end`.
  const staggerBaseRef = useRef<ReturnType<typeof buildGroupBases> | null>(
    null
  );
  useEffect(() => {
    const onBegin = (e: Event) => {
      const distinctLanes = new Set(
        selectionList.map((s) => `${s.nodeId} ${s.paramName}`)
      );
      if (distinctLanes.size >= 2) {
        staggerBaseRef.current = buildGroupBases(selectionList);
        (e as CustomEvent).detail?.respond?.(true);
      } else {
        staggerBaseRef.current = null;
      }
    };
    const onStep = (e: Event) => {
      if (!staggerBaseRef.current) return;
      const ticks = (e as CustomEvent<{ stepTicks: number }>).detail?.stepTicks;
      if (typeof ticks === "number") {
        staggerKeyframes(staggerBaseRef.current, ticks);
      }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionList]);

  // ---- Ruler scrub ----
  function onRulerMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mx = e.clientX - rect.left;
    let tick = pxToTick(mx);
    if (!e.shiftKey) tick = snapTickToFrame(tick, timeline.ticksPerFrame);
    onScrub(Math.round(tick));
    setDrag({ kind: "scrub" });
  }

  useEffect(() => {
    if (drag.kind !== "scrub") return;
    function onMove(e: MouseEvent) {
      const rect = lanesAreaRef.current?.getBoundingClientRect();
      if (!rect) return;
      const mx = e.clientX - rect.left;
      let tick = pxToTick(mx);
      if (!e.shiftKey) tick = snapTickToFrame(tick, timeline.ticksPerFrame);
      onScrub(Math.round(tick));
    }
    function onUp() {
      setDrag({ kind: "none" });
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag.kind, pxToTick, onScrub, timeline.ticksPerFrame]);

  // ---- Ruler tick spacing (dynamic) ----
  // Choose major frame interval so the on-screen spacing is ~80px and the
  // step is a "nice" frame number (1, 2, 5, 10, 20, 50, 100, ...).
  const rulerSpacing = useMemo(() => {
    const targetPx = 80;
    const ticksPerFrame = timeline.ticksPerFrame;
    const pxPerFrame = pixelsPerTick * ticksPerFrame;
    if (pxPerFrame <= 0) return { majorFrames: 60, minorFrames: 10 };
    const rawFrames = targetPx / pxPerFrame;
    // Snap to nice numbers in 1/2/5 sequence.
    const pow = Math.pow(10, Math.floor(Math.log10(Math.max(1, rawFrames))));
    const norm = rawFrames / pow;
    let nice: number;
    if (norm < 1.5) nice = 1;
    else if (norm < 3.5) nice = 2;
    else if (norm < 7.5) nice = 5;
    else nice = 10;
    const majorFrames = Math.max(1, Math.round(nice * pow));
    const minorFrames = Math.max(1, Math.round(majorFrames / 5));
    return { majorFrames, minorFrames };
  }, [pixelsPerTick, timeline.ticksPerFrame]);

  // ---- Render ----
  const playheadX = tickToPx(currentTick);

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
        font: "11px/1.2 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
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
          borderBottom: "1px solid #1f1f23",
        }}
      >
        <div
          onMouseDown={onRulerMouseDown}
          onMouseMove={(e) => {
            // Measure against the lanes viewport so the preview lines up
            // with the playhead's coordinate space (shared column origin).
            const rect = lanesAreaRef.current?.getBoundingClientRect();
            if (rect) setHoverX(e.clientX - rect.left);
          }}
          onMouseLeave={() => setHoverX(null)}
          style={{
            position: "relative",
            flex: 1,
            cursor: "ew-resize",
            overflow: "hidden",
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
          {/* Playhead handle */}
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
        </div>
      </div>

      {/* Lanes area */}
      <div
        style={{
          flex: 1,
          display: "flex",
          minHeight: 0,
          position: "relative",
          overflow: "hidden",
          height: lanesViewportHeight,
        }}
      >
        {/* Left label column — floats over the full-width timeline. Semi-
            transparent so the lanes/keyframes stay visible behind it. */}
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            zIndex: 2,
            width: PARAM_LABEL_WIDTH,
            minWidth: PARAM_LABEL_WIDTH,
            background: "rgba(10, 10, 10, 0.7)",
            borderRight: "1px solid #1f1f23",
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
            {lanes.map((row, i) => {
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
                      background: row.selected ? "#13131a" : "transparent",
                      borderBottom: `1px solid ${COLOR_LANE_SEP}`,
                      cursor: "pointer",
                      fontSize: 11,
                    }}
                  >
                    {/* Collapse chevron — same glyph the Layers editor
                        uses, rotated when open. */}
                    <span
                      style={{
                        width: 14,
                        height: 14,
                        flexShrink: 0,
                        color: "#71717a",
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
                        color: row.selected ? "#e5e7eb" : "#c7c7cc",
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
              return (
                <div
                  key={`pl:${row.nodeId}:${row.paramName}`}
                  onClick={() => onSelectNode?.(row.nodeId)}
                  style={{
                    height: trackHeight,
                    display: "flex",
                    alignItems: "center",
                    padding: "0 8px 0 10px",
                    gap: 8,
                    borderBottom: `1px solid ${COLOR_LANE_SEP}`,
                    background: row.selected ? "rgba(250,250,250,0.04)" : undefined,
                    cursor: "pointer",
                  }}
                >
                  <DiamondNav
                    block={row.block}
                    currentTick={currentTick}
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
                      color: COLOR_TEXT,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      flex: 1,
                      fontSize: 11,
                    }}
                  >
                    {row.paramLabel}
                  </span>
                  {badge && (
                    <span
                      style={{
                        background: "#1f1f23",
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
        </div>

        {/* Lanes content (scrollable, scrubbable) */}
        <div
          ref={lanesAreaRef}
          onMouseDown={onLanesMouseDown}
          onMouseMove={(e) => {
            onLanesHoverMove(e);
            const rect = lanesAreaRef.current?.getBoundingClientRect();
            if (rect) setHoverX(e.clientX - rect.left);
          }}
          onMouseLeave={() => {
            if (hoveredClip) setHoveredClip(null);
            setHoverX(null);
          }}
          onContextMenu={onLanesContextMenu}
          style={{
            position: "relative",
            flex: 1,
            overflow: "hidden",
            cursor: lanesCursor,
          }}
        >
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
                            ? "rgba(34,211,238,0.13)"
                            : COLOR_CLIP_GHOST,
                          border: `1px solid rgba(34,211,238,${
                            ghostHover ? 0.4 : 0.22
                          })`,
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
                      background: row.selected ? "#13131a" : "transparent",
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
                  height={trackHeight}
                  tickToPx={tickToPx}
                  selection={selection}
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
                trackHeight={trackHeight}
              />
            )}
          </div>

          {/* Hover preview — a faded playhead line that tracks the cursor.
              Hidden during any drag (scrub already moves the real one). */}
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

          {/* Playhead vertical line (in the visible viewport) */}
          <div
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: playheadX,
              width: 1,
              background: COLOR_PLAYHEAD,
              opacity: 0.7,
              pointerEvents: "none",
            }}
          />

          {/* Marquee */}
          {drag.kind === "marquee" && (
            <div
              style={{
                position: "absolute",
                left: Math.min(drag.startMouseX, drag.currentMouseX),
                top: Math.min(drag.startMouseY, drag.currentMouseY),
                width: Math.abs(drag.currentMouseX - drag.startMouseX),
                height: Math.abs(drag.currentMouseY - drag.startMouseY),
                background: "rgba(96, 165, 250, 0.1)",
                border: `1px dashed ${COLOR_ACCENT}`,
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
            background: "#0f0f12",
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
          <select
            value={
              (() => {
                // Show the easing of the most-recently selected keyframe.
                const last = selectionList[selectionList.length - 1];
                const kf = blockIndex
                  .get(last.nodeId)
                  ?.get(last.paramName)
                  ?.keyframes.find((k) => k.tick === last.tick);
                return kf?.easingOut ?? "easeInOut";
              })()
            }
            onChange={(e) =>
              setKeyframeEasing(
                selectionList,
                e.target.value as EasingPreset
              )
            }
            style={{
              background: "#15151a",
              color: COLOR_TEXT,
              border: `1px solid ${COLOR_BORDER}`,
              borderRadius: 2,
              padding: "2px 4px",
              fontSize: 11,
            }}
          >
            {EASING_PRESETS.map((p) => {
              const allScalar = selectionList.every((s) => {
                const lane = lanes.find(
                  (l) =>
                    l.kind === "paramLane" &&
                    l.nodeId === s.nodeId &&
                    l.paramName === s.paramName
                ) as Extract<LaneRow, { kind: "paramLane" }> | undefined;
                return lane?.paramType === "scalar";
              });
              const disabled = p === "customBezier" && !allScalar;
              return (
                <option key={p} value={p} disabled={disabled}>
                  {EASING_LABELS[p]}
                </option>
              );
            })}
          </select>
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
            color: "#ecfeff",
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
          allScalar={selectionList.every((s) => {
            const lane = lanes.find(
              (l) =>
                l.kind === "paramLane" &&
                l.nodeId === s.nodeId &&
                l.paramName === s.paramName
            ) as Extract<LaneRow, { kind: "paramLane" }> | undefined;
            return lane?.paramType === "scalar";
          })}
          stepOnly={selectionList.every((s) => {
            const lane = lanes.find(
              (l) =>
                l.kind === "paramLane" &&
                l.nodeId === s.nodeId &&
                l.paramName === s.paramName
            ) as Extract<LaneRow, { kind: "paramLane" }> | undefined;
            return lane ? isStepOnly(lane.paramType) : false;
          })}
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
  void minorFrames;
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
      {cells.map((t) => (
        <g key={t.frame}>
          <line
            x1={t.x}
            x2={t.x}
            y1={0}
            y2={height}
            stroke={COLOR_BORDER}
            strokeWidth={1}
          />
          <text
            x={t.x + 4}
            y={height / 2 + 3}
            fontSize={9}
            fontFamily="ui-monospace, monospace"
            fill="#71717a"
          >
            {t.frame}
          </text>
        </g>
      ))}
    </svg>
  );
}

// Lane-label keyframe cluster: ‹ ◆ › — chevrons jump the playhead to
// the previous / next keyframe; the diamond toggles a key at the
// playhead (empty / yellow / red, same as the param panel). Shared look
// with the Layers editor.
export function DiamondNav({
  block,
  currentTick,
  onToggle,
  onSeek,
}: {
  block: KeyframeAnimationBlock | undefined;
  currentTick: number;
  onToggle: () => void;
  onSeek: (tick: number) => void;
}) {
  const st = diamondStateFor(block, currentTick);
  const col =
    st === "red" ? "#ef4444" : st === "yellow" ? "#facc15" : "#52525b";
  let prev: number | null = null;
  let next: number | null = null;
  for (const k of block?.keyframes ?? []) {
    if (k.tick < currentTick && (prev == null || k.tick > prev)) prev = k.tick;
    if (k.tick > currentTick && (next == null || k.tick < next)) next = k.tick;
  }
  const navBtn = (dir: "prev" | "next", target: number | null) => (
    <button
      type="button"
      title={dir === "prev" ? "Jump to previous keyframe" : "Jump to next keyframe"}
      disabled={target == null}
      onClick={(e) => {
        e.stopPropagation();
        if (target != null) onSeek(target);
      }}
      style={{
        width: 10,
        height: 12,
        flexShrink: 0,
        background: "transparent",
        border: "none",
        padding: 0,
        cursor: target == null ? "default" : "pointer",
        color: target == null ? "#2e2e33" : "#71717a",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <svg
        width={7}
        height={9}
        viewBox="0 0 7 9"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ transform: dir === "prev" ? "rotate(180deg)" : "none" }}
      >
        <path d="M2 1.5 L5 4.5 L2 7.5" />
      </svg>
    </button>
  );
  return (
    <span
      style={{ display: "flex", alignItems: "center", gap: 3, flexShrink: 0 }}
    >
      {navBtn("prev", prev)}
      <button
        type="button"
        title="Toggle keyframe at playhead"
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        style={{
          width: 8,
          height: 8,
          flexShrink: 0,
          transform: "rotate(45deg)",
          background: st === "empty" ? "transparent" : col,
          border: `1px solid ${st === "empty" ? "#52525b" : col}`,
          padding: 0,
          cursor: "pointer",
        }}
      />
      {navBtn("next", next)}
    </span>
  );
}

interface ParamLaneProps {
  row: Extract<LaneRow, { kind: "paramLane" }>;
  yTop: number;
  height: number;
  tickToPx: (tick: number) => number;
  selection: Set<string>;
}

function ParamLane(props: ParamLaneProps) {
  const { row, yTop, height, tickToPx, selection } = props;
  const isColor = row.paramType === "color";
  return (
    <div
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
        // continuous selection across the full editor width.
        background: row.selected ? "rgba(250,250,250,0.04)" : undefined,
        borderTop: row.selected
          ? "1px solid rgba(250,250,250,0.5)"
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
        if (x1 < -20 || x0 > 99999) return null;
        const isHold = prev.easingOut === "hold";
        return (
          <div
            key={`seg:${prev.tick}:${k.tick}`}
            style={{
              position: "absolute",
              top: height / 2 - 0.5,
              left: x0,
              width: x1 - x0,
              height: 1,
              background: isHold ? COLOR_MUTED : "#3f3f46",
              opacity: isColor ? 0 : 0.6,
              pointerEvents: "none",
            }}
          />
        );
      })}
      {/* Diamond keyframes (skipped for color; ramp stops are visual instead) */}
      {!isColor &&
        row.block.keyframes.map((k) => {
          const x = tickToPx(k.tick);
          const sk = `${row.nodeId}\u0000${row.paramName}\u0000${k.tick}`;
          const isSel = selection.has(sk);
          const size = Math.max(5, Math.min(8, height * 0.28));
          return (
            <div
              key={`kf:${k.tick}`}
              style={{
                position: "absolute",
                left: x - size / 2,
                top: height / 2 - size / 2,
                width: size,
                height: size,
                transform: "rotate(45deg)",
                background: isSel ? COLOR_DIAMOND_SELECTED : COLOR_DIAMOND,
                border: `1px solid ${isSel ? "#fff" : "#92400e"}`,
                boxShadow: isSel
                  ? `0 0 0 2px rgba(59,130,246,0.35)`
                  : "none",
                pointerEvents: "none",
              }}
            />
          );
        })}
      {/* Color ramp's keyframe stop indicators */}
      {isColor &&
        row.block.keyframes.map((k) => {
          const x = tickToPx(k.tick);
          const sk = `${row.nodeId}\u0000${row.paramName}\u0000${k.tick}`;
          const isSel = selection.has(sk);
          return (
            <div
              key={`cs:${k.tick}`}
              style={{
                position: "absolute",
                left: x - 1,
                top: 2,
                width: 2,
                height: height - 4,
                background: isSel ? "#fff" : "rgba(255,255,255,0.5)",
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
  return "#888";
}

interface SelectionBoxProps {
  box: { minTick: number; maxTick: number; minRow: number; maxRow: number };
  tickToPx: (tick: number) => number;
  laneRowYs: number[];
  lanes: LaneRow[];
  trackHeight: number;
}

function SelectionBox(props: SelectionBoxProps) {
  const { box, tickToPx, laneRowYs, lanes, trackHeight } = props;
  const leftRaw = tickToPx(box.minTick);
  const rightRaw = tickToPx(box.maxTick);
  const yTop = (laneRowYs[box.minRow] ?? 0) - 2;
  const lastRow = lanes[box.maxRow];
  const yBot =
    (laneRowYs[box.maxRow] ?? 0) +
    (lastRow?.kind === "nodeHeader" ? NODE_HEADER_HEIGHT : trackHeight) +
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
        background: degenerate
          ? "rgba(59,130,246,0.15)"
          : "rgba(59,130,246,0.05)",
        pointerEvents: "none",
        boxSizing: "border-box",
      }}
    >
      {/* Edge handles only render when the box is wide enough to scale.
          When degenerate the strip itself is the move-group hit zone. */}
      {!degenerate && (
        <>
          <div
            style={{
              position: "absolute",
              left: -3,
              top: 0,
              bottom: 0,
              width: 4,
              background: "rgba(59,130,246,0.4)",
            }}
          />
          <div
            style={{
              position: "absolute",
              right: -3,
              top: 0,
              bottom: 0,
              width: 4,
              background: "rgba(59,130,246,0.4)",
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
        background: "#1a1a1f",
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
            background: hoverEasing ? "#27272a" : "transparent",
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
          ((e.currentTarget as HTMLDivElement).style.background = "#27272a")
        }
        onMouseLeave={(e) =>
          ((e.currentTarget as HTMLDivElement).style.background = "transparent")
        }
      >
        Delete keyframe
      </div>
    </div>,
    document.body
  );
}

interface EasingGridProps {
  allScalar: boolean;
  onPick(p: EasingPreset): void;
}

function EasingGrid(props: EasingGridProps) {
  const { allScalar, onPick } = props;
  const TILE = 36;
  const COLS = 6;
  return (
    <div
      style={{
        position: "absolute",
        left: "100%",
        top: 0,
        background: "#1a1a1f",
        border: `1px solid ${COLOR_BORDER}`,
        borderRadius: 4,
        padding: 6,
        boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
        display: "grid",
        gridTemplateColumns: `repeat(${COLS}, ${TILE}px)`,
        gap: 4,
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

interface EasingTileProps {
  preset: EasingPreset;
  size: number;
  disabled: boolean;
  label: string;
  onClick(): void;
}

function EasingTile(props: EasingTileProps) {
  const { preset, size, disabled, label, onClick } = props;
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
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: size,
        height: size,
        padding: 0,
        background: hover && !disabled ? "#27272a" : "#101013",
        border: `1px solid ${hover && !disabled ? "#3f3f46" : COLOR_BORDER}`,
        borderRadius: 4,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.35 : 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
        {/* baseline & ceiling */}
        <line
          x1={0}
          y1={h * 0.82}
          x2={w}
          y2={h * 0.82}
          stroke="#2a2a30"
          strokeWidth={1}
        />
        <line
          x1={0}
          y1={h * 0.18}
          x2={w}
          y2={h * 0.18}
          stroke="#2a2a30"
          strokeWidth={1}
        />
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
