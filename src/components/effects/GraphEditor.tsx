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
} from "@/engine/keyframes";
import {
  EASING_PRESET_LABELS,
  EASING_PRESET_ORDER,
  easeOf,
  easingPathFor,
  emptyAnimationBlock,
  framesToTicks,
  snapTickToFrame,
  ticksToFrames,
} from "@/engine/keyframes";
import { getNodeDef } from "@/engine/registry";
import { useClock } from "@/state/playback-clock";
import { LAYER_OPACITY_PREFIX } from "@/engine/conventions";
import { getShortcutScope } from "./shortcut-scope";
import { wheelWantsZoom, getEffectiveDevice } from "./input-device";

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
}

// ---------------------------------------------------------------------
// Constants — dark theme palette and layout metrics
// ---------------------------------------------------------------------

const BG = "#0a0a0c";
const PANEL = "#1f1f23";
const BORDER = "#27272a";
const MUTED = "#52525b";
const TEXT = "#d4d4d8";
const ACCENT = "#3b82f6";
const CURVE = "#60a5fa";

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

type DragState =
  | { kind: "none" }
  | {
      kind: "point";
      group: number[];
      startMouseX: number;
      startMouseY: number;
      starts: Map<number, { tick: number; value: number }>;
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

// Blender-style keyboard-driven modal transform (G grab / S scale) with
// optional X/Y axis constraint. Confirmed by click/Enter, cancelled by
// Esc/right-click. Updates follow the cursor (no button held).
type ModalTransform =
  | null
  | {
      mode: "grab" | "scale";
      axis: "x" | "y" | null;
      origin: { x: number; y: number }; // cursor when the modal began
      starts: Map<number, { tick: number; value: number }>;
      anchorTick: number; // scale pivot (playhead) in tick space
      anchorValue: number; // scale pivot (selection centroid) in value space
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
}: GraphEditorProps) {
  // Clock read from the playback store (clock-store spec, step 3) — this
  // editor re-renders per frame by design (playhead line).
  const currentTick = useClock((s) => s.tick);
  // Collect all scalar tracks whose `graphVisible` toggle is on. The
  // graph icon on each track row in the Track Editor flips this flag.
  const visibleTracks = useMemo(() => {
    const out: {
      key: string;
      nodeId: string;
      paramName: string;
      label: string;
      block: KeyframeAnimationBlock;
      yMin?: number;
      yMax?: number;
    }[] = [];
    for (const n of nodes) {
      const anim = n.data?.animation;
      if (!anim) continue;
      const def = getNodeDef(n.data.defType);
      for (const [pname, b] of Object.entries(anim)) {
        if (!b || !b.animated || !b.graphVisible) continue;
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
        if (!pdef || pdef.type !== "scalar") continue;
        out.push({
          key: `${n.id}|${pname}`,
          nodeId: n.id,
          paramName: pname,
          label: `${n.data.name} · ${pdef.label ?? pname}`,
          block: b,
          yMin: pdef.min,
          yMax: pdef.max,
        });
      }
    }
    return out;
  }, [nodes]);

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
  const onChange = active
    ? (next: KeyframeAnimationBlock) =>
        onAnimationChange(active.nodeId, active.paramName, next)
    : () => {};
  const trackPicker =
    visibleTracks.length > 1 ? (
      <select
        value={active?.key ?? ""}
        onChange={(e) => setActiveKey(e.target.value)}
        style={{
          background: "#15151a",
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

  // Re-fit y bounds when the active track changes, when normalize is
  // toggled, when refresh is clicked, or when the param's declared
  // bounds change. With normalize off and a declared range, use that;
  // otherwise auto-fit to keyframe extents.
  useEffect(() => {
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

  function getMousePos(e: React.MouseEvent | MouseEvent) {
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

  function setEasingFor(idx: number, preset: EasingPreset) {
    const ks = blockRef.current.keyframes;
    const k = ks[idx];
    if (!k) return;
    let bezierHandles = k.bezierHandles;
    if (preset === "customBezier") {
      // Initialize handles from a sensible default — half the segment to
      // the next keyframe, slope from local neighbors.
      bezierHandles = bezierHandles ?? defaultBezierHandles(ks, idx);
    } else {
      bezierHandles = undefined;
    }
    const next = ks.slice();
    next[idx] = { ...k, easingOut: preset, bezierHandles };
    commit({ ...blockRef.current, keyframes: next });
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
  // middle-drag (bug #2). Plain middle-drag pans via the React onMouseDown
  // (the compat mousedown still fires); Cmd/Ctrl + middle-drag zooms —
  // horizontal movement zooms time (X), vertical zooms value (Y), about the
  // press point. Drag right / up zooms in. Scoped to button 1 so left-button
  // keyframe interactions are untouched.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 1) return;
      e.stopPropagation();
      if (!(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
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
  }, [pixelsPerTick, yMinView, yMaxView, screenToTick, screenToValue]);

  // ----- Keyboard: space / delete / escape / F -----
  useEffect(() => {
    function startModal(mode: "grab" | "scale") {
      const kks = blockRef.current.keyframes;
      const starts = new Map<number, { tick: number; value: number }>();
      let sum = 0;
      for (const i of selected) {
        const k = kks[i];
        if (!k) continue;
        starts.set(i, { tick: k.tick, value: k.value as number });
        sum += k.value as number;
      }
      if (starts.size === 0) return;
      setModal({
        mode,
        axis: null,
        origin: { ...cursorRef.current },
        starts,
        anchorTick: currentTick,
        anchorValue: sum / starts.size,
      });
    }

    function onDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      const inInput = tag === "input" || tag === "textarea";

      // ----- Modal transform live: capture its controls -----
      if (modal) {
        if (e.key === "Escape") {
          // Cancel — restore the original positions.
          const restore = new Map<number, Partial<Keyframe>>();
          for (const [i, s] of modal.starts)
            restore.set(i, { tick: s.tick, value: s.value });
          patchMany(restore);
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
        setContextMenu(null);
      }
      // Contextual transforms — need a keyframe selection.
      if (
        (e.key === "g" || e.key === "G") &&
        !inInput &&
        selected.size > 0
      ) {
        e.preventDefault();
        startModal("grab");
        return;
      }
      if (
        (e.key === "s" || e.key === "S") &&
        !inInput &&
        selected.size > 0
      ) {
        e.preventDefault();
        startModal("scale");
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && !inInput) {
        if (selected.size === 0) return;
        e.preventDefault();
        deleteKeyframes(selected);
        setSelected(new Set());
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
  }, [selected, innerW, yMin, yMax, modal, currentTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // ----- Mouse interactions on the SVG surface -----
  function onMouseDown(e: React.MouseEvent) {
    if (contextMenu) setContextMenu(null);
    // A click while a modal transform is live confirms it (positions are
    // already committed by the modal's move handler).
    if (modal) {
      setModal(null);
      e.preventDefault();
      return;
    }
    if (e.button !== 0 && e.button !== 1) return;
    shiftAxisRef.current = null;
    const { x, y } = getMousePos(e);

    // Cmd/Ctrl + middle-drag = zoom (owned by the native pointerdown
    // listener); bail so we don't also start a pan.
    if (e.button === 1 && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      return;
    }
    // Space-drag or middle-click → pan.
    if (spaceHeld || e.button === 1) {
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

    // Then keyframes.
    const ph = pointAt(x, y);
    if (ph !== null) {
      let nextSel: Set<number>;
      if (e.shiftKey) {
        nextSel = new Set(selected);
        if (nextSel.has(ph)) nextSel.delete(ph);
        else nextSel.add(ph);
      } else if (selected.has(ph)) {
        nextSel = new Set(selected);
      } else {
        nextSel = new Set([ph]);
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
  }

  function onContextMenuHandler(e: React.MouseEvent) {
    // Right-click cancels an in-progress modal transform (Blender style).
    if (modal) {
      e.preventDefault();
      const restore = new Map<number, Partial<Keyframe>>();
      for (const [i, s] of modal.starts)
        restore.set(i, { tick: s.tick, value: s.value });
      patchMany(restore);
      setModal(null);
      return;
    }
    const { x, y } = getMousePos(e);
    const ph = pointAt(x, y);
    if (ph === null) return;
    e.preventDefault();
    if (!selected.has(ph)) setSelected(new Set([ph]));
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
    function onMove(ev: MouseEvent) {
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
        const mks = blockRef.current.keyframes;
        const hits = new Set(drag.base);
        for (let i = 0; i < mks.length; i++) {
          const px = tickToScreen(mks[i].tick);
          const py = valueToScreen(mks[i].value as number);
          if (px >= minX && px <= maxX && py >= minY && py <= maxY) hits.add(i);
        }
        setSelected(hits);
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
        const existing =
          k.bezierHandles ??
          defaultBezierHandles(blockRef.current.keyframes, drag.keyIdx);
        if (drag.side === "right") {
          rightHandle = { dx: newDx, dy: newDy };
          // v1: always mirror the opposite handle.
          leftHandle = { dx: -newDx, dy: -newDy };
        } else {
          leftHandle = { dx: newDx, dy: newDy };
          rightHandle = { dx: -newDx, dy: -newDy };
        }
        // Don't write a non-custom easing key's mirrored side as if it
        // were live; only the side(s) attached to a custom segment matter.
        // We still store both sides on `bezierHandles` because the data
        // model holds them together — readers consult them only when the
        // adjacent segment is customBezier.
        void existing;
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
        if (!moved && drag.base.size === 0) setSelected(new Set());
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
    innerH,
    pixelsPerTick,
    yMaxView,
    yMinView,
    timeline.ticksPerFrame,
    onScrub,
    screenToTick,
    screenToValue,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  // ----- Modal G/S transform: follow the cursor, apply continuously -----
  useEffect(() => {
    if (!modal) return;
    const apply = (cur: { x: number; y: number }) => {
      const updates = new Map<number, Partial<Keyframe>>();
      const tpf = timeline.ticksPerFrame;
      if (modal.mode === "grab") {
        let dxPx = cur.x - modal.origin.x;
        let dyPx = cur.y - modal.origin.y;
        if (modal.axis === "x") dyPx = 0;
        else if (modal.axis === "y") dxPx = 0;
        const dTick = dxPx / pixelsPerTick;
        const dValue = -(dyPx / innerH) * (yMaxView - yMinView);
        for (const [i, s] of modal.starts) {
          updates.set(i, {
            tick: snapTickToFrame(Math.round(s.tick + dTick), tpf),
            value: s.value + dValue,
          });
        }
      } else {
        // Scale around the playhead (x) / selection centroid (y).
        const ax = tickToScreen(modal.anchorTick);
        const ay = valueToScreen(modal.anchorValue);
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
        for (const [i, s] of modal.starts) {
          updates.set(i, {
            tick: snapTickToFrame(
              Math.round(modal.anchorTick + (s.tick - modal.anchorTick) * fx),
              tpf
            ),
            value: modal.anchorValue + (s.value - modal.anchorValue) * fy,
          });
        }
      }
      patchMany(updates);
    };
    // Re-apply right away so axis-toggles update without needing a move.
    apply(cursorRef.current);
    const onMove = (ev: MouseEvent) => {
      cursorRef.current = getMousePos(ev);
      apply(cursorRef.current);
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal, pixelsPerTick, innerH, yMaxView, yMinView, timeline.ticksPerFrame]);

  // ---------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------

  const ks = block.keyframes;

  // Build the curve path. Each segment respects prev.easingOut.
  const pathSegments = useMemo(() => {
    if (ks.length === 0) return [] as string[];
    if (ks.length === 1) {
      const sx = tickToScreen(ks[0].tick);
      const sy = valueToScreen(ks[0].value as number);
      return [`M ${sx} ${sy}`];
    }
    const out: string[] = [];
    out.push(`M ${tickToScreen(ks[0].tick)} ${valueToScreen(ks[0].value as number)}`);
    for (let i = 0; i < ks.length - 1; i++) {
      const a = ks[i];
      const b = ks[i + 1];
      const ax = tickToScreen(a.tick);
      const ay = valueToScreen(a.value as number);
      const bx = tickToScreen(b.tick);
      const by = valueToScreen(b.value as number);
      const av = a.value as number;
      const bv = b.value as number;
      const span = b.tick - a.tick;
      if (a.easingOut === "linear") {
        out.push(`L ${bx} ${by}`);
      } else if (a.easingOut === "hold") {
        out.push(`L ${bx} ${ay} L ${bx} ${by}`);
      } else if (a.easingOut === "customBezier") {
        const right =
          a.bezierHandles?.rightHandle ?? defaultRightHandle(ks, i);
        const left =
          b.bezierHandles?.leftHandle ?? defaultLeftHandle(ks, i + 1);
        const c1x = tickToScreen(a.tick + right.dx);
        const c1y = valueToScreen(av + right.dy);
        const c2x = tickToScreen(b.tick + left.dx);
        const c2y = valueToScreen(bv + left.dy);
        out.push(`C ${c1x} ${c1y} ${c2x} ${c2y} ${bx} ${by}`);
      } else {
        const ctrl = PRESET_CTRL[a.easingOut];
        if (ctrl) {
          const c1Tick = a.tick + ctrl.p1[0] * span;
          const c1Val = av + ctrl.p1[1] * (bv - av);
          const c2Tick = a.tick + ctrl.p2[0] * span;
          const c2Val = av + ctrl.p2[1] * (bv - av);
          out.push(
            `C ${tickToScreen(c1Tick)} ${valueToScreen(c1Val)} ${tickToScreen(c2Tick)} ${valueToScreen(c2Val)} ${bx} ${by}`
          );
        } else {
          // Sampled polyline for non-cubic-bezier presets
          // (sine/expo/back/bounce/elastic).
          const SAMPLES = 32;
          for (let s = 1; s <= SAMPLES; s++) {
            const u = s / SAMPLES;
            const v = easeOf(a.easingOut, u);
            const tk = a.tick + u * span;
            const vv = av + v * (bv - av);
            out.push(`L ${tickToScreen(tk)} ${valueToScreen(vv)}`);
          }
        }
      }
      void ax;
      void ay;
    }
    return out;
  }, [ks, tickToScreen, valueToScreen]);

  const pathD = pathSegments.join(" ");

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
    e: React.MouseEvent,
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
          fontFamily: "ui-monospace, monospace",
          padding: 16,
          textAlign: "center",
        }}
      >
        No curves visible. Click the ∿ icon on a scalar track in the Track
        Editor to show it here.
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
        fontFamily: "ui-monospace, monospace",
        fontSize: 11,
        color: TEXT,
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
          <select
            value={firstSelected.easingOut}
            onChange={(e) => {
              const preset = e.target.value as EasingPreset;
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
              fontFamily: "ui-monospace, monospace",
            }}
          >
            {EASING_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        )}
        {trackPicker}
      </div>

      {/* Plot SVG */}
      <svg
        ref={svgRef}
        width={width}
        height={height - HEADER_H}
        style={{ display: "block" }}
        onMouseDown={onMouseDown}
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
          fill="#111114"
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
                    stroke="#1e3a8a"
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
                    stroke="#1e3a8a"
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
            fill="rgba(59,130,246,0.12)"
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
                    onMouseDown={(e) => startBoxResize(e, h.key, selBox)}
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
              stroke="#ef4444"
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
              stroke="#22c55e"
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
              onMouseDown={(e) => {
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
          {modal.mode === "grab" ? "GRAB" : "SCALE"}
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
          onPickEasing={(preset) => {
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
            void setEasingFor;
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
    fontFamily: "ui-monospace, monospace",
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
            {EASING_PRESETS.map((p) => {
              const active = keyframe.easingOut === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  title={p.label}
                  onClick={() => onPickEasing(p.id)}
                  style={{
                    width: 36,
                    height: 36,
                    padding: 0,
                    background: active ? "#1e3a8a" : "#101013",
                    border: `1px solid ${active ? "#3b82f6" : BORDER}`,
                    borderRadius: 4,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <svg width={28} height={28} viewBox="0 0 28 28" aria-hidden>
                    <line
                      x1={0}
                      y1={28 * 0.82}
                      x2={28}
                      y2={28 * 0.82}
                      stroke="#2a2a30"
                      strokeWidth={1}
                    />
                    <line
                      x1={0}
                      y1={28 * 0.18}
                      x2={28}
                      y2={28 * 0.18}
                      stroke="#2a2a30"
                      strokeWidth={1}
                    />
                    <path
                      d={easingPathFor(p.id, 28, 28, 36)}
                      fill="none"
                      stroke={active ? "#fbbf24" : "#3b82f6"}
                      strokeWidth={1.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              );
            })}
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
              (e.currentTarget.style.background = "#7f1d1d")
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

function defaultRightHandle(
  ks: Keyframe[],
  i: number
): { dx: number; dy: number } {
  const a = ks[i];
  const b = ks[i + 1];
  if (!b) return { dx: 0, dy: 0 };
  const span = b.tick - a.tick;
  const dv = (b.value as number) - (a.value as number);
  // Half the segment in x, with a third of the dy as a soft default.
  return { dx: span * 0.33, dy: dv * 0.33 };
}

function defaultLeftHandle(
  ks: Keyframe[],
  i: number
): { dx: number; dy: number } {
  const a = ks[i - 1];
  const b = ks[i];
  if (!a) return { dx: 0, dy: 0 };
  const span = b.tick - a.tick;
  const dv = (b.value as number) - (a.value as number);
  return { dx: -span * 0.33, dy: -dv * 0.33 };
}

function defaultBezierHandles(ks: Keyframe[], i: number): BezierHandles {
  return {
    rightHandle: defaultRightHandle(ks, i),
    leftHandle: defaultLeftHandle(ks, i),
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

