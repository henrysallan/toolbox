"use client";

import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import {
  Handle,
  Position,
  useNodeConnections,
  useReactFlow,
  useUpdateNodeInternals,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { usePanelWindow } from "./layout/panel-window";
import { getNodeDef } from "@/engine/registry";
import { paramSocketType } from "@/state/graph";
import type { NodeDataPayload } from "@/state/graph";
import type { SocketType } from "@/engine/types";
import {
  parseRampParamKey,
  rampFieldSocketType,
} from "@/engine/conventions";
import type { ColorRampStop } from "@/engine/color-ramp";
import { MAX_COLORS, getExtractedPalette } from "@/nodes/source/color-literal";
import { ColorPickerPopover } from "@/lib/color-picker-popover";
import {
  BAR_SLIDER_RADIUS,
  MiniBarSlider,
  NumberField,
} from "@/lib/param-controls";
import {
  startPointerDrag,
  useCoarsePointer,
  TOUCH_DRAG_STYLE,
} from "@/lib/pointer-drag";
import { colorForSocket } from "./socketColor";
import { tintRgba } from "./node-tints";
import { Spinner } from "./Spinner";
import { VIRTUAL_SOCKET } from "@/engine/groups";

type EffectNodeType = Node<NodeDataPayload, "effect">;

const ROW_H = 22;
const PAD_Y = 8;
// Visual dot diameter. Click area is decoupled (HANDLE_HIT below) so
// the ports look the same as before but are easier to grab.
const HANDLE_SIZE = 10;
// Hit area of the Handle element. Larger than the visual dot — the
// dot is rendered as an inner child div, so the surrounding ring
// catches clicks without making the port look chunky. Capped just
// below ROW_H (22) so adjacent rows don't have overlapping hitboxes.
const HANDLE_HIT = 20;
// Dwell time on an output socket before the data-peek popover opens
// (SocketPeekPopover). Long enough that ordinary wiring gestures never
// trip it; short enough to be discoverable.
const PEEK_DWELL_MS = 2000;

// Node types that surface an editable text box directly on the node body,
// mapped to the string param it edits. Both params are declared
// `multiline: true`, so the on-node control is a <textarea>. Edits route
// through the shared `effect-node-param` event (→ onParamChange), same as
// the header dropdowns and Color swatches.
const STRING_INPUT_PARAMS: Record<string, string> = {
  "string-literal": "value",
  text: "text",
};

// Node types that surface an inline scalar slider on the node body, mapped to
// the scalar param it drives. Reuses the ParamPanel slider visuals
// (MiniBarSlider + NumberField) at node scale; edits route through the same
// `effect-node-param` event.
const SCALAR_INPUT_PARAMS: Record<string, string> = {
  constant: "value",
};

// Node types that surface a colour swatch on the node body, mapped to
// the params behind it. `paint` (when present) is the inherit toggle —
// the SDF primitives are unpainted by default and take their colour
// from an enclosing SDF Material or the terminal's foreground, so the
// swatch has to show an "inheriting" state, not just a colour. SDF
// Material itself always paints, so it declares no toggle.
//
// A swatch here rather than only in the panel because per-shape colour
// is the one SDF param you set while looking at the graph, and burying
// it costs a selection round-trip per shape. Spec:
// 080226_sdf-materials-and-shading.md.
const COLOR_SWATCH_PARAMS: Record<
  string,
  { color: string; paint?: string }
> = {
  "sdf-circle": { color: "color", paint: "paint" },
  "sdf-rectangle": { color: "color", paint: "paint" },
  "sdf-line-segment": { color: "color", paint: "paint" },
  "sdf-polygon": { color: "color", paint: "paint" },
  "sdf-triangle": { color: "color", paint: "paint" },
  "sdf-star": { color: "color", paint: "paint" },
  "sdf-spline": { color: "color", paint: "paint" },
  "sdf-from-image": { color: "color", paint: "paint" },
  "sdf-material": { color: "color" },
};

interface ExposedSocket {
  name: string;
  label: string;
  socketType: SocketType;
}

// Compact ms formatting for the timing overlay. Sub-millisecond
// values land at "<1ms"; everything else rounds to whole ms so the
// label stays narrow and visually quiet.
function formatMs(v: number): string {
  if (v < 1) return "<1ms";
  if (v < 10) return v.toFixed(1) + "ms";
  return Math.round(v) + "ms";
}

// Memoized: xyflow re-renders its NodeWrapper for every node whenever any
// pane-level handler prop changes identity; the memo stops that cascade here
// as long as this node's own props (id/data/selected) are unchanged.
function EffectNode({ id, data, selected }: NodeProps<EffectNodeType>) {
  // Null in the main window; the child Window when this node's pane is
  // popped out (080226_panel-popout-windows.md §3). Only the LISTENERS
  // need it — this node's own dispatches go to module-scope `window`,
  // which is the main one, exactly where EffectsApp listens.
  const panelWin = usePanelWindow();
  // Per-node compute time, surfaced when the Window-menu "Show
  // Node Timings" toggle is on. EffectsApp dispatches a
  // `node-timings` event after each pipeline eval; we pick our
  // own ms out of the map. A `null` detail means the toggle was
  // turned off — clear the local state so the label disappears.
  // rAF-batches the visible state update so a fast pipeline doesn't
  // thrash React with one render per node per eval.
  const [evalMs, setEvalMs] = useState<number | null>(null);
  useEffect(() => {
    let pending: number | null | undefined = undefined;
    let raf = 0;
    const onTimings = (e: Event) => {
      const detail = (e as CustomEvent<Map<string, number> | null>)
        .detail;
      if (detail === null) {
        pending = null;
      } else {
        const t = detail.get(id);
        if (t === undefined) return;
        pending = t;
      }
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (pending !== undefined) setEvalMs(pending);
        pending = undefined;
      });
    };
    const win = panelWin ?? window;
    win.addEventListener("node-timings", onTimings);
    return () => {
      win.removeEventListener("node-timings", onTimings);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [id]);

  // Media-loading state: EffectsApp streams v9 Storage images in after the
  // graph is interactive and broadcasts the still-loading node ids via
  // `node-media-loading`. We pick our own id out of the set to show a
  // spinner on the node header until this node's image lands.
  const [mediaLoading, setMediaLoading] = useState(false);
  useEffect(() => {
    const onLoading = (e: Event) => {
      const set = (e as CustomEvent<Set<string>>).detail;
      setMediaLoading(!!set && set.has(id));
    };
    const win = panelWin ?? window;
    win.addEventListener("node-media-loading", onLoading);
    return () => win.removeEventListener("node-media-loading", onLoading);
  }, [id]);

  // Mirror EffectsApp's split-viewport state. EffectsApp dispatches a
  // `viewport-split-changed` event whenever the user flips it; we
  // subscribe so the header can render the second active toggle (A2)
  // only when there's actually a second viewport to drive.
  const [viewportSplit, setViewportSplit] = useState(false);
  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<{ split: boolean }>).detail;
      if (detail) setViewportSplit(!!detail.split);
    };
    const win = panelWin ?? window;
    win.addEventListener("viewport-split-changed", onChange);
    return () => win.removeEventListener("viewport-split-changed", onChange);
  }, []);

  const isQueue = data.defType === "render-queue";
  // A Layer Output (the fixed group-output inside a layer) gets the Output
  // node's render buttons too, so you can render a layer from inside it (var(--tb-a-blue-link)).
  const isLayerOutput =
    data.defType === "group-output" &&
    (data.params as { fixed?: boolean } | undefined)?.fixed === true;

  // Render Queue nodes draw an inline progress bar per item row.
  // EffectsApp broadcasts the batch state on `render-queue-progress`
  // (same pattern as `node-timings`); null detail or another queue
  // node's id clears ours.
  const [queueProg, setQueueProg] = useState<{
    activeItemId: string | null;
    itemProgress: number | null;
  } | null>(null);
  useEffect(() => {
    if (!isQueue) return;
    const onProg = (e: Event) => {
      const d = (
        e as CustomEvent<{
          nodeId: string;
          activeItemId: string | null;
          itemProgress: number | null;
        } | null>
      ).detail;
      setQueueProg(
        d && d.nodeId === id
          ? { activeItemId: d.activeItemId, itemProgress: d.itemProgress }
          : null
      );
    };
    const win = panelWin ?? window;
    win.addEventListener("render-queue-progress", onProg);
    return () => win.removeEventListener("render-queue-progress", onProg);
  }, [isQueue, id]);

  // Output-socket peek: dwell on an output handle for PEEK_DWELL_MS →
  // dispatch `socket-peek` and EffectsApp mounts SocketPeekPopover next to
  // the socket with the value the eval produced there. Leaving the handle
  // (or pressing down to start a wire drag) cancels the dwell and asks
  // EffectsApp to hide — with a short grace so the pointer can travel into
  // the popover. One timer per node; hopping sockets restarts it.
  const peekTimerRef = useRef<number | null>(null);
  const peekShownRef = useRef<string | null>(null);
  useEffect(() => {
    return () => {
      if (peekTimerRef.current !== null) {
        window.clearTimeout(peekTimerRef.current);
        peekTimerRef.current = null;
      }
      const shown = peekShownRef.current;
      if (shown) {
        peekShownRef.current = null;
        window.dispatchEvent(
          new CustomEvent("socket-peek", {
            detail: { id, handle: shown, hide: true },
          })
        );
      }
    };
  }, [id]);
  const cancelSocketPeek = () => {
    if (peekTimerRef.current !== null) {
      window.clearTimeout(peekTimerRef.current);
      peekTimerRef.current = null;
    }
    const shown = peekShownRef.current;
    if (shown) {
      peekShownRef.current = null;
      window.dispatchEvent(
        new CustomEvent("socket-peek", {
          detail: { id, handle: shown, hide: true },
        })
      );
    }
  };
  const armSocketPeek = (
    e: React.PointerEvent,
    handle: string,
    anchorY: number
  ) => {
    // A held button means a wire drag is passing over — don't arm.
    if (e.buttons !== 0) return;
    if (peekTimerRef.current !== null) {
      window.clearTimeout(peekTimerRef.current);
    }
    peekTimerRef.current = window.setTimeout(() => {
      peekTimerRef.current = null;
      peekShownRef.current = handle;
      window.dispatchEvent(
        new CustomEvent("socket-peek", { detail: { id, handle, anchorY } })
      );
    }, PEEK_DWELL_MS);
  };

  // Hidden inputs (evaluator-only sockets like a layer's `content`)
  // never render — no handle, no row.
  const inputs = data.inputs.filter((i) => !i.hidden);
  const auxes = data.auxOutputs;
  const hasPrimary = !!data.primaryOutput;

  // Resolve exposed-param sockets by pulling current def info. Only params
  // whose type maps to a data socket (scalar/vec*/color/bool) produce a
  // socket; anything else silently drops. Virtual ramp-stop names
  // (ramp_c/a/p:<param>:<stopId> — engine/conventions) resolve to a
  // vec4/scalar socket labeled by the stop's sorted position, matching the
  // "stop · n/N" numbering in the param panel.
  const exposedSockets: ExposedSocket[] = useMemo(() => {
    const def = getNodeDef(data.defType);
    if (!def) return [];
    const names = data.exposedParams ?? [];
    const out: ExposedSocket[] = [];
    for (const name of names) {
      const rk = parseRampParamKey(name);
      if (rk) {
        const p = def.params.find(
          (x) => x.name === rk.paramName && x.type === "color_ramp"
        );
        if (!p) continue;
        const raw = data.params[rk.paramName];
        const stops = Array.isArray(raw) ? (raw as ColorRampStop[]) : [];
        const idx = [...stops]
          .sort((a, b) => a.position - b.position)
          .findIndex((s) => s.id === rk.stopId);
        const stopTag = idx >= 0 ? ` ${idx + 1}` : "";
        out.push({
          name,
          label: `${p.label ?? p.name} · ${rk.field}${stopTag}`,
          socketType: rampFieldSocketType(rk.field),
        });
        continue;
      }
      const p = def.params.find((x) => x.name === name);
      if (!p) continue;
      const st = paramSocketType(p.type);
      if (!st) continue;
      out.push({ name, label: p.label ?? p.name, socketType: st });
    }
    return out;
  }, [data.defType, data.exposedParams, data.params]);

  // React Flow caches handle positions per node and only re-measures on
  // resize. A socket *rename* swaps handle ids without changing the
  // node's height (same row count), so edges pointing at the new id
  // can't find their handle until something forces a re-measure —
  // they'd silently vanish until the node remounts (e.g. leaving and
  // re-entering a group scope). Re-measure whenever the handle id set
  // changes.
  const updateNodeInternals = useUpdateNodeInternals();
  const handleSignature = [
    ...inputs.map((i) => `in:${i.name}`),
    ...exposedSockets.map((e) => `in:param:${e.name}`),
    data.primaryOutput ? "out:primary" : "",
    ...auxes.map((a) => `out:aux:${a.name}`),
  ].join("|");
  useEffect(() => {
    updateNodeInternals(id);
  }, [handleSignature, id, updateNodeInternals]);

  const leftRows = inputs.length + exposedSockets.length;
  const rightRows = (hasPrimary ? 1 : 0) + auxes.length;
  const maxRows = Math.max(leftRows, rightRows, 1);
  const bodyH = maxRows * ROW_H + PAD_Y * 2;
  const active = !!data.active;
  const active2 = !!data.active2;
  const bypassed = !!data.bypassed;

  // On-node text box: String source (`value`) and Text node (`text`) render
  // an editable box on the node body. The placeholder comes from the def.
  const stringInputParam: string | undefined = STRING_INPUT_PARAMS[data.defType];
  const stringPlaceholder = useMemo(() => {
    if (!stringInputParam) return undefined;
    const def = getNodeDef(data.defType);
    return def?.params.find((p) => p.name === stringInputParam)?.placeholder;
  }, [data.defType, stringInputParam]);

  // On-node scalar slider (Constant). Range mirrors the ParamPanel logic —
  // per-node paramOverride wins, softMax caps the slider (number field keeps
  // the full range as the escape hatch) — but a very-negative hard min is
  // clamped into a usable span so the on-node bar isn't pinned to one end.
  const scalarInputParam: string | undefined = SCALAR_INPUT_PARAMS[data.defType];
  const scalarConfig = useMemo(() => {
    if (!scalarInputParam) return null;
    const def = getNodeDef(data.defType);
    const p = def?.params.find((x) => x.name === scalarInputParam);
    if (!p || p.type !== "scalar") return null;
    const ov = data.paramOverrides?.[scalarInputParam];
    const min = ov?.min ?? p.min ?? 0;
    const max = ov?.max ?? p.max ?? 1;
    // Param-driven increment (stepFrom — e.g. Constant's value follows its
    // `step`/`mode` params). When active, edits snap to k·step (see
    // NodeScalarSlider) so the on-node bar matches the ParamPanel row.
    const dynStep = p.stepFrom?.(data.params);
    const step = dynStep ?? p.step ?? 0.01;
    const sliderMax = ov?.softMax ?? p.softMax ?? max;
    const sliderMin = Math.max(min, -sliderMax);
    return { min, max, step, snapToStep: dynStep !== undefined, sliderMin, sliderMax };
  }, [data.defType, scalarInputParam, data.paramOverrides, data.params]);

  // On-node colour swatch (SDF primitives + SDF Material).
  const colorSwatch = COLOR_SWATCH_PARAMS[data.defType];
  const [swatchOpen, setSwatchOpen] = useState(false);

  // Content-driven minimum width (the auto size when unresized). Reused as
  // the outer div's minWidth AND the resize clamp floor.
  const minWidth = isQueue
    ? 300
    : data.defType === "collect"
      ? 240
      : data.defType === "color-literal"
        ? 220
        : 200;

  // Bottom-right resize grip. Drag = live local preview (the outer div grows
  // as the right/bottom edges follow the cursor — the top-left corner is the
  // anchor, so position never moves); a single commit on pointer-up dispatches
  // `effect-node-resize`, which EffectsApp turns into one setNodes + one undo
  // step (size on data.uiWidth/uiHeight).
  const nodeRef = useRef<HTMLDivElement>(null);
  const rf = useReactFlow();
  const [resizeDrag, setResizeDrag] = useState<{
    w: number;
    h: number;
  } | null>(null);

  const onResizeStart = (e: React.PointerEvent<HTMLElement>) => {
    const el = nodeRef.current;
    if (!el) return;
    const zoom = rf.getZoom() || 1;
    const rect = el.getBoundingClientRect();
    // getBoundingClientRect is post-zoom (screen px); divide back to flow px.
    const startW = rect.width / zoom;
    const startH = rect.height / zoom;
    const startX = e.clientX;
    const startY = e.clientY;
    const minH = 40;
    let latest = { w: startW, h: startH };
    const started = startPointerDrag(e, {
      cursor: "nwse-resize",
      onMove: (ev) => {
        const dxFlow = (ev.clientX - startX) / zoom;
        const dyFlow = (ev.clientY - startY) / zoom;
        // right/bottom edges follow the pointer; top-left stays anchored
        const w = Math.max(minWidth, startW + dxFlow);
        const h = Math.max(minH, startH + dyFlow);
        latest = { w, h };
        setResizeDrag({ w, h });
      },
      onUp: () => {
        setResizeDrag(null);
        window.dispatchEvent(
          new CustomEvent("effect-node-resize", {
            detail: {
              id,
              width: Math.round(latest.w),
              height: Math.round(latest.h),
            },
          })
        );
      },
      // Cancelled (iPadOS reclaimed the gesture, or the node unmounted):
      // drop the live preview WITHOUT committing, so no undo step is minted
      // for a size the user never released on.
      onCancel: () => setResizeDrag(null),
    });
    if (!started) return;
    e.stopPropagation();
    e.preventDefault();
  };

  // Double-click the grip clears the override → back to auto content size.
  const onResizeReset = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.dispatchEvent(
      new CustomEvent("effect-node-resize", { detail: { id, reset: true } })
    );
  };

  // Re-measure handle positions after a committed resize (right-side sockets
  // moved with the width) so wires stay attached — same re-measure the
  // socket-rename path relies on.
  useEffect(() => {
    updateNodeInternals(id);
  }, [data.uiWidth, data.uiHeight, id, updateNodeInternals]);

  // Does any param actually animate? Same test `evaluateKeyframesAt` runs
  // before it will return a keyframed value — an `animated` block with no
  // keys, or keys with animation switched off, is not animation.
  const hasKeyframes = useMemo(
    () =>
      Object.values(data.animation ?? {}).some(
        (b) => b.animated && b.keyframes.length > 0
      ),
    [data.animation]
  );

  const dispatch = (kind: "toggleActive" | "toggleActive2" | "toggleBypass") => {
    window.dispatchEvent(
      new CustomEvent("effect-node-toggle", { detail: { id, kind } })
    );
  };

  // Color node on-node controls: one swatch per color output; clicking a
  // swatch opens the picker popover anchored under its row. `pickerFor`
  // holds the color param name being edited (null = closed). Spec:
  // 071026_color-node-multi-output.md.
  const isColorNode = data.defType === "color-literal";
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const colorHexFor = (paramName: string): string => {
    const v = data.params[paramName];
    return typeof v === "string" ? v : "#ffffff";
  };
  const colorNodeCount = isColorNode
    ? Math.max(1, Math.floor((data.params.count as number) ?? 1))
    : 1;
  // Palette mode: with an image wired into the Color node, compute
  // extracts a palette and announces it via "color-node-palette". The
  // swatches mirror it read-only — the stored params are inert while the
  // image drives the outputs. Initial state reads the session store:
  // compute only re-runs on cache misses, so a remounting node can't
  // count on the event ever re-firing.
  const [palette, setPalette] = useState<string[] | null>(() =>
    isColorNode ? getExtractedPalette(id) : null
  );
  useEffect(() => {
    if (!isColorNode) return;
    const onPalette = (e: Event) => {
      const detail = (
        e as CustomEvent<{ nodeId: string; colors: string[] | null }>
      ).detail;
      if (!detail || detail.nodeId !== id) return;
      setPalette(detail.colors);
      if (detail.colors) setPickerFor(null);
    };
    const win = panelWin ?? window;
    win.addEventListener("color-node-palette", onPalette);
    return () => win.removeEventListener("color-node-palette", onPalette);
  }, [isColorNode, id]);
  // Swatch color: extracted palette wins over the stored param while active.
  const swatchHexFor = (n: number, paramName: string): string =>
    palette?.[Math.min(n - 1, palette.length - 1)] ?? colorHexFor(paramName);

  // Mirrors the queue-panel row logic: rows before the active item are
  // done, the active one shows its export fraction (or an indeterminate
  // dim fill), rows after are pending. activeItemId === null while a
  // batch runs means the trailing zip step — everything reads done.
  const queueActiveIdx = queueProg?.activeItemId
    ? inputs.findIndex((inp) => inp.name === `item:${queueProg.activeItemId}`)
    : -1;
  const queueRowFill = (i: number): number | "indeterminate" => {
    if (!queueProg) return 0;
    if (queueProg.activeItemId === null) return 1;
    if (queueActiveIdx === -1) return 0;
    if (i < queueActiveIdx) return 1;
    if (i > queueActiveIdx) return 0;
    return queueProg.itemProgress ?? "indeterminate";
  };

  return (
    <div
      ref={nodeRef}
      style={{
        minWidth,
        // User-resized box (bottom-right grip) → explicit size; a live drag
        // previews from local state. Absent ⇒ auto (minWidth / content height).
        width: resizeDrag ? resizeDrag.w : data.uiWidth,
        height: resizeDrag ? resizeDrag.h : data.uiHeight,
        // A node with an on-node text box lays out as a flex column so the
        // textarea can flex to fill a resized (taller) body. Other node types
        // stay in block flow — an over-tall box just leaves bottom space.
        display: stringInputParam ? "flex" : undefined,
        flexDirection: stringInputParam ? "column" : undefined,
        // Layer nodes + their boundary nodes get a faint blue wash (#159);
        // a user tint (right-click menu) washes over the base the same way,
        // layered so the body stays opaque (wires must not show through).
        background: data.tint
          ? `linear-gradient(${tintRgba(data.tint, 0.13)}, ${tintRgba(
              data.tint,
              0.13
            )}), var(--tb-n-3)`
          : data.layerAccent
            ? "var(--tb-t-navy-d-3)"
            : "var(--tb-n-3)",
        // Border precedence: selection and error stay legible over any
        // cosmetic tint.
        border: `1px solid ${
          selected
            ? "var(--tb-a-blue-400)"
            : data.error
              ? "var(--tb-a-red-500)"
              : data.tint
                ? tintRgba(data.tint, 0.6)
                : data.layerAccent
                  ? "var(--tb-t-navy-d-4)"
                  : "var(--tb-n-9)"
        }`,
        borderRadius: 10,
        fontFamily: "var(--ui-font)",
        fontSize: 11,
        color: "var(--tb-n-16)",
        opacity: bypassed ? 0.5 : 1,
        // Bold = an extra outline ring via box-shadow (border width never
        // changes, so sockets don't shift and no re-measure is needed).
        // Composes with the selection ring: bold sits outside it.
        boxShadow: (() => {
          const boldRing = data.bold
            ? `0 0 0 ${selected ? 3 : 2}px ${
                data.tint ? tintRgba(data.tint, 0.9) : "var(--tb-n-15)"
              }`
            : null;
          const base = selected
            ? "0 0 0 1px color-mix(in srgb, var(--tb-a-blue-400) 30%, transparent)"
            : "var(--tb-shadow-node)";
          return boldRing ? `${base}, ${boldRing}` : base;
        })(),
        // Fade the selection outline (border tint + ring) in/out rather
        // than snapping it on click.
        transition: "border-color 140ms ease, box-shadow 140ms ease",
        // position: relative anchors the timing label below as an
        // absolutely-positioned overlay above the node's top edge.
        position: "relative",
      }}
    >
      {hasKeyframes && (
        <div
          title="Animated — this node has keyframed parameters"
          style={{
            position: "absolute",
            // Floats off the top-left corner, clear of the timing readout
            // (which starts at left: 2) so both can show at once.
            top: -6,
            left: -6,
            width: 7,
            height: 7,
            borderRadius: "50%",
            // Keyframe red, same as the Track Editor diamond on a key.
            background: "var(--tb-a-red-500)",
            // A dark rim keeps the dot legible over a wire or a node it
            // happens to overlap.
            boxShadow: "0 0 0 1.5px var(--tb-n-3)",
            zIndex: 5,
          }}
        />
      )}
      {evalMs !== null && (
        <div
          style={{
            position: "absolute",
            // Sits above the node's top-left corner.
            top: -14,
            left: 2,
            fontSize: 9,
            // Color tier matches the FPS counter convention so the
            // two readouts read as related diagnostics:
            //   < 4ms  green   (cheap)
            //   4–16ms yellow  (one frame budget)
            //   > 16ms red     (over a frame, will drop fps)
            color:
              evalMs < 4
                ? "var(--tb-a-emerald-400)"
                : evalMs < 16
                ? "var(--tb-a-yellow-400)"
                : "var(--tb-a-red-500)",
            opacity: 0.7,
            letterSpacing: 0.3,
            fontVariantNumeric: "tabular-nums",
            pointerEvents: "none",
          }}
        >
          {formatMs(evalMs)}
        </div>
      )}
      {!!data.aiAuthored && <AiEditButton id={id} />}
      <div
        style={{
          // The header is an inset chip, not an edge-to-edge bar: it sits
          // 4px inside the node with its own lifted fill and rounding, so no
          // divider rule is needed to separate it from the body.
          margin: 4,
          padding: "4px 6px",
          // Lifted a step off the body (#18181b → #2a2a2a). A tint / layer
          // accent washes over the chip the same way it washes the body, so
          // a tinted node still reads tinted in its header.
          background: data.tint
            ? `linear-gradient(${tintRgba(data.tint, 0.13)}, ${tintRgba(
                data.tint,
                0.13
              )}), var(--tb-n-7)`
            : data.layerAccent
              ? "var(--tb-t-navy-d-5)"
              : "var(--tb-n-7)",
          border: "1px solid var(--tb-n-9)",
          borderRadius: 8,
          display: "flex",
          gap: 6,
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span
          style={{
            fontWeight: 600,
            letterSpacing: 0.3,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {mediaLoading && (
            <span
              title="Loading image…"
              style={{ display: "inline-flex", color: "var(--tb-a-blue-300)" }}
            >
              <Spinner size={11} stroke={1.6} arc={0.28} />
            </span>
          )}
          {data.displayName ?? data.name}
          <InspectButton id={id} />
          {(() => {
            // Header dropdown for an enum param — lets nodes like Group
            // / Pick / Length flip mode without opening the params
            // panel. The choice retypes sockets immediately so
            // quick-access is high-value for these.
            const def = getNodeDef(data.defType);
            const hc = def?.headerControl;
            if (!hc) return null;
            const p = def.params.find((x) => x.name === hc.paramName);
            if (!p || p.type !== "enum" || !p.options) return null;
            const current = (data.params[hc.paramName] as string) ?? p.default;
            return (
              <select
                value={current}
                className="nodrag"
                // Both, deliberately: `nodrag` + stopping POINTERdown is what
                // holds on touch (React Flow's node drag is pointer-driven —
                // a mousedown-only guard lets a tap drag the node instead).
                onPointerDown={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                onChange={(e) => {
                  window.dispatchEvent(
                    new CustomEvent("effect-node-param", {
                      detail: {
                        id,
                        name: hc.paramName,
                        value: e.target.value,
                      },
                    })
                  );
                }}
                style={{
                  background: "var(--tb-n-3)",
                  color: "var(--tb-n-16)",
                  border: "1px solid var(--tb-n-7)",
                  borderRadius: 3,
                  fontFamily: "inherit",
                  fontSize: 10,
                  padding: "1px 2px",
                  outline: "none",
                }}
              >
                {p.options.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            );
          })()}
        </span>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {data.error ? (
            <span
              title={data.error}
              style={{ color: "var(--tb-a-red-500)", fontSize: 10, marginRight: 4 }}
            >
              ERR
            </span>
          ) : null}
          {/* A view / A2 / B bypass make no sense on a Render Queue —
              it produces nothing to view or pass through. */}
          {!isQueue && (
            <HeaderToggle
              on={active}
              // Split viewport swaps the eye for bare viewport numbers —
              // one eye can't say *which* viewport it means.
              label={viewportSplit ? "1" : <EyeIcon />}
              title={
                active
                  ? viewportSplit
                    ? "Active in viewport 1"
                    : "Active (viewed)"
                  : viewportSplit
                    ? "Set active in viewport 1"
                    : "Set active (view on canvas)"
              }
              activeBg="#047857"
              activeFg="var(--tb-t-cyan-l-0)"
              onClick={() => dispatch("toggleActive")}
            />
          )}
          {!isQueue && viewportSplit && (
            <HeaderToggle
              on={active2}
              label="2"
              title={
                active2
                  ? "Active in viewport 2"
                  : "Set active in viewport 2"
              }
              activeBg="#0369a1"
              activeFg="var(--tb-a-blue-100)"
              onClick={() => dispatch("toggleActive2")}
            />
          )}
          {!isQueue && (
            <HeaderToggle
              on={bypassed}
              label={<BanIcon />}
              title={bypassed ? "Bypassed" : "Bypass (pass through)"}
              activeBg="var(--tb-a-amber-700)"
              activeFg="var(--tb-a-amber-100)"
              onClick={() => dispatch("toggleBypass")}
            />
          )}
          {data.defType === "merge" && (
            <HeaderToggle
              on={false}
              label="+"
              title="Add input layer"
              activeBg="var(--tb-a-gray-700)"
              activeFg="var(--tb-n-16)"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("effect-node-toggle", {
                    detail: { id, kind: "mergeAddLayer" },
                  })
                )
              }
            />
          )}
          {data.defType === "collect" && (
            <HeaderToggle
              on={false}
              label="+"
              title="Add input"
              activeBg="var(--tb-a-gray-700)"
              activeFg="var(--tb-n-16)"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("effect-node-toggle", {
                    detail: { id, kind: "collectAddInput" },
                  })
                )
              }
            />
          )}
          {isColorNode && colorNodeCount < MAX_COLORS && (
            <HeaderToggle
              on={false}
              label="+"
              title="Add color output"
              activeBg="var(--tb-a-gray-700)"
              activeFg="var(--tb-n-16)"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("effect-node-toggle", {
                    detail: { id, kind: "colorAddOutput" },
                  })
                )
              }
            />
          )}
          {data.defType === "autolayout" && (
            <HeaderToggle
              on={false}
              label="+"
              title="Add item slot"
              activeBg="var(--tb-a-gray-700)"
              activeFg="var(--tb-n-16)"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("effect-node-toggle", {
                    detail: { id, kind: "autolayoutAddItem" },
                  })
                )
              }
            />
          )}
          {data.defType === "expression" && (
            <HeaderToggle
              on={false}
              label="+"
              title="Add input variable"
              activeBg="var(--tb-a-gray-700)"
              activeFg="var(--tb-n-16)"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("effect-node-toggle", {
                    detail: { id, kind: "exprAddInput" },
                  })
                )
              }
            />
          )}
          {data.defType === "render-queue" && (
            <HeaderToggle
              on={false}
              label="+"
              title="Add queue slot"
              activeBg="var(--tb-a-gray-700)"
              activeFg="var(--tb-n-16)"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("effect-node-toggle", {
                    detail: { id, kind: "queueAddItem" },
                  })
                )
              }
            />
          )}
          {data.defType === "output" && (
            <HeaderToggle
              on={false}
              label="↗"
              title="Export App — bundle this graph as a runnable web app"
              activeBg="var(--tb-a-blue-900)"
              activeFg="var(--tb-a-blue-200)"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("effect-node-export", {
                    detail: { id, kind: "app" },
                  })
                )
              }
            />
          )}
          {data.defType === "trails" && (
            <HeaderToggle
              on={false}
              label="↻"
              title="Clear trail history"
              activeBg="var(--tb-a-gray-700)"
              activeFg="var(--tb-n-16)"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("effect-node-toggle", {
                    detail: { id, kind: "trailsReset" },
                  })
                )
              }
            />
          )}
        </div>
      </div>

      <div style={{ position: "relative", height: bodyH }}>
        {inputs.map((input, i) => {
          const rowTop = PAD_Y + i * ROW_H;
          const handleCenter = rowTop + ROW_H / 2;
          // Trailing virtual socket on Group Output — hollow dashed dot;
          // wiring into it mints a real typed socket.
          const isVirtual = input.name === VIRTUAL_SOCKET;
          return (
            <Fragment key={`in-${input.name}`}>
              <Handle
                type="target"
                id={`in:${input.name}`}
                position={Position.Left}
                style={{
                  top: handleCenter,
                  width: HANDLE_HIT,
                  height: HANDLE_HIT,
                  background: "transparent",
                  border: "none",
                }}
              >
                <SocketDot
                  size={HANDLE_SIZE}
                  background={
                    isVirtual ? "transparent" : colorForSocket(input.type)
                  }
                  border={
                    isVirtual ? "1px dashed var(--tb-n-10)" : "1px solid var(--tb-n-0)"
                  }
                />
              </Handle>
              <div
                style={{
                  position: "absolute",
                  top: rowTop,
                  left: 0,
                  height: ROW_H,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  paddingLeft: 14,
                  // Queue rows stretch across the node so the inline
                  // progress bar gets the leftover width.
                  ...(isQueue ? { right: 10 } : {}),
                }}
              >
                <span
                  style={{
                    color: isVirtual ? "var(--tb-n-10)" : "var(--tb-n-13)",
                    fontStyle: isVirtual ? "italic" : undefined,
                  }}
                >
                  {isVirtual ? "new socket" : input.label ?? input.name}
                </span>
                {isQueue ? (
                  (() => {
                    const fill = queueRowFill(i);
                    return (
                      <div
                        style={{
                          flex: 1,
                          height: 6,
                          borderRadius: 999,
                          background: "var(--tb-n-0)",
                          border: "1px solid var(--tb-n-7)",
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            width:
                              fill === "indeterminate"
                                ? "100%"
                                : `${fill * 100}%`,
                            height: "100%",
                            background: "var(--tb-a-blue-600)",
                            opacity: fill === "indeterminate" ? 0.45 : 1,
                            transition: "width 200ms",
                          }}
                        />
                      </div>
                    );
                  })()
                ) : (
                  <span
                    style={{ color: colorForSocket(input.type), fontSize: 9 }}
                  >
                    {input.type}
                  </span>
                )}
              </div>
            </Fragment>
          );
        })}

        {exposedSockets.map((ex, i) => {
          const rowTop = PAD_Y + (inputs.length + i) * ROW_H;
          const handleCenter = rowTop + ROW_H / 2;
          return (
            <Fragment key={`expo-${ex.name}`}>
              <Handle
                type="target"
                id={`in:param:${ex.name}`}
                position={Position.Left}
                style={{
                  top: handleCenter,
                  width: HANDLE_HIT,
                  height: HANDLE_HIT,
                  background: "transparent",
                  border: "none",
                }}
              >
                <SocketDot
                  size={HANDLE_SIZE}
                  background={colorForSocket(ex.socketType)}
                  border="1px dashed var(--tb-n-10)"
                  borderRadius={2}
                />
              </Handle>
              <div
                style={{
                  position: "absolute",
                  top: rowTop,
                  left: 0,
                  height: ROW_H,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  paddingLeft: 14,
                }}
              >
                <span style={{ color: "var(--tb-n-11)", fontStyle: "italic" }}>
                  {ex.label}
                </span>
                <span
                  style={{
                    color: colorForSocket(ex.socketType),
                    fontSize: 9,
                  }}
                >
                  {ex.socketType}
                </span>
              </div>
            </Fragment>
          );
        })}

        {hasPrimary && (
          <Fragment>
            <Handle
              type="source"
              id="out:primary"
              position={Position.Right}
              onPointerEnter={(e) =>
                armSocketPeek(e, "out:primary", PAD_Y + ROW_H / 2)
              }
              onPointerLeave={cancelSocketPeek}
              onPointerDown={cancelSocketPeek}
              style={{
                top: PAD_Y + ROW_H / 2,
                width: HANDLE_HIT,
                height: HANDLE_HIT,
                background: "transparent",
                border: "none",
              }}
            >
              <SocketDot
                size={HANDLE_SIZE + 2}
                background={colorForSocket(data.primaryOutput!)}
                border="1px solid var(--tb-n-0)"
              />
            </Handle>
            <div
              style={{
                position: "absolute",
                top: PAD_Y,
                right: 0,
                height: ROW_H,
                display: "flex",
                alignItems: "center",
                gap: 6,
                paddingRight: 14,
              }}
            >
              {isColorNode && (
                <ColorSwatchButton
                  color={swatchHexFor(1, "color")}
                  title={
                    palette
                      ? "Palette from image — disconnect to edit"
                      : "Edit color"
                  }
                  disabled={!!palette}
                  onClick={() => setPickerFor("color")}
                />
              )}
              <span
                style={{ color: colorForSocket(data.primaryOutput!), fontSize: 9 }}
              >
                {data.primaryOutput}
              </span>
              <span style={{ color: "var(--tb-n-16)" }}>out</span>
            </div>
          </Fragment>
        )}

        {auxes.map((aux, i) => {
          const rowTop = PAD_Y + ((hasPrimary ? 1 : 0) + i) * ROW_H;
          const handleCenter = rowTop + ROW_H / 2;
          const disabled = !!aux.disabled;
          // Trailing virtual socket on Group Input — hollow dashed dot;
          // wiring from it mints a real typed socket.
          const isVirtual = aux.name === VIRTUAL_SOCKET;
          return (
            <Fragment key={`aux-${aux.name}`}>
              <Handle
                type="source"
                id={`out:aux:${aux.name}`}
                position={Position.Right}
                isConnectable={!disabled}
                onPointerEnter={
                  disabled || isVirtual
                    ? undefined
                    : (e) =>
                        armSocketPeek(e, `out:aux:${aux.name}`, handleCenter)
                }
                onPointerLeave={
                  disabled || isVirtual ? undefined : cancelSocketPeek
                }
                onPointerDown={
                  disabled || isVirtual ? undefined : cancelSocketPeek
                }
                style={{
                  top: handleCenter,
                  width: HANDLE_HIT,
                  height: HANDLE_HIT,
                  background: "transparent",
                  border: "none",
                  opacity: disabled ? 0.55 : 1,
                }}
              >
                <SocketDot
                  size={HANDLE_SIZE}
                  background={
                    disabled || isVirtual
                      ? isVirtual
                        ? "transparent"
                        : "var(--tb-n-7)"
                      : colorForSocket(aux.type)
                  }
                  border={
                    disabled || isVirtual
                      ? "1px dashed var(--tb-n-10)"
                      : "1px solid var(--tb-n-0)"
                  }
                />
              </Handle>
              <div
                style={{
                  position: "absolute",
                  top: rowTop,
                  right: 0,
                  height: ROW_H,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  paddingRight: 14,
                  opacity: disabled ? 0.5 : 1,
                }}
              >
                {isColorNode && !isVirtual && (
                  <ColorSwatchButton
                    color={swatchHexFor(
                      parseInt(aux.name.slice("color".length), 10) || 1,
                      aux.name
                    )}
                    title={
                      palette
                        ? "Palette from image — disconnect to edit"
                        : `Edit ${aux.label ?? aux.name}`
                    }
                    disabled={!!palette}
                    onClick={() => setPickerFor(aux.name)}
                  />
                )}
                {!isVirtual && (
                  <span
                    style={{
                      color: disabled ? "var(--tb-n-10)" : colorForSocket(aux.type),
                      fontSize: 9,
                    }}
                  >
                    {aux.type}
                  </span>
                )}
                <span
                  style={{
                    color: isVirtual ? "var(--tb-n-10)" : "var(--tb-n-11)",
                    fontStyle: isVirtual ? "italic" : undefined,
                  }}
                >
                  {isVirtual ? "new socket" : aux.label ?? aux.name}
                </span>
              </div>
            </Fragment>
          );
        })}

        {isColorNode &&
          pickerFor &&
          (() => {
            // Anchor the popover just under the row whose swatch opened
            // it. Color N sits at row N-1 (primary is color 1, aux
            // colorN follows in order).
            const n =
              pickerFor === "color"
                ? 1
                : parseInt(pickerFor.slice("color".length), 10) || 1;
            const rowTop = PAD_Y + (n - 1) * ROW_H;
            return (
              <ColorPickerPopover
                value={colorHexFor(pickerFor)}
                onChange={(hex) =>
                  window.dispatchEvent(
                    new CustomEvent("effect-node-param", {
                      detail: { id, name: pickerFor, value: hex },
                    })
                  )
                }
                onClose={() => setPickerFor(null)}
                style={{ top: rowTop + ROW_H + 2, right: 8 }}
              />
            );
          })()}
      </div>

      {stringInputParam && (
        <div
          style={{
            padding: "6px 8px",
            borderTop: "1px solid var(--tb-n-7)",
            // Fill the remaining height of a resized node so the textarea can
            // grow with it; minHeight:0 lets it shrink inside the flex column.
            flex: "1 1 auto",
            minHeight: 0,
            display: "flex",
          }}
        >
          <NodeStringInput
            id={id}
            paramName={stringInputParam}
            value={
              typeof data.params[stringInputParam] === "string"
                ? (data.params[stringInputParam] as string)
                : ""
            }
            placeholder={stringPlaceholder}
          />
        </div>
      )}

      {scalarInputParam && scalarConfig && (
        <div
          style={{
            padding: "6px 8px",
            borderTop: "1px solid var(--tb-n-7)",
          }}
        >
          <NodeScalarSlider
            id={id}
            paramName={scalarInputParam}
            value={
              typeof data.params[scalarInputParam] === "number"
                ? (data.params[scalarInputParam] as number)
                : 0
            }
            min={scalarConfig.min}
            max={scalarConfig.max}
            step={scalarConfig.step}
            snapToStep={scalarConfig.snapToStep}
            sliderMin={scalarConfig.sliderMin}
            sliderMax={scalarConfig.sliderMax}
          />
        </div>
      )}

      {colorSwatch && (
        <div
          style={{
            padding: "6px 8px",
            borderTop: "1px solid var(--tb-n-7)",
          }}
        >
          <NodeColorSwatch
            id={id}
            colorParam={colorSwatch.color}
            paintParam={colorSwatch.paint}
            color={
              typeof data.params[colorSwatch.color] === "string"
                ? (data.params[colorSwatch.color] as string)
                : "#ffffff"
            }
            // No `paint` param (SDF Material) means always painted.
            painted={
              !colorSwatch.paint || data.params[colorSwatch.paint] === true
            }
            open={swatchOpen}
            setOpen={setSwatchOpen}
          />
        </div>
      )}

      {(data.defType === "output" || isLayerOutput) && (
        <div
          style={{
            padding: "6px 8px",
            borderTop: "1px solid var(--tb-n-7)",
            display: "flex",
            gap: 6,
          }}
        >
          <ExportButton
            label="Image"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent("effect-node-export", {
                  detail: { id, kind: "image" },
                })
              )
            }
          />
          <ExportButton
            label={
              data.params?.exportMode === "sequence"
                ? "Sequence"
                : data.params?.exportMode === "gif"
                  ? "GIF"
                  : "Video"
            }
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent("effect-node-export", {
                  detail: {
                    id,
                    kind:
                      data.params?.exportMode === "sequence"
                        ? "sequence"
                        : data.params?.exportMode === "gif"
                          ? "gif"
                          : "video",
                  },
                })
              )
            }
          />
          {/* Vector product. Both surfaces carry a `spline` tap — the
              composition Output as a real input, a Layer Output as its
              third fixed boundary socket. Self-gating: renders nothing
              until something is wired into `in:spline`, so the usual
              two-button row is unchanged for everyone else. */}
          <SvgExportButton id={id} />
        </div>
      )}

      {isQueue && (
        <div
          style={{
            padding: "6px 8px",
            borderTop: "1px solid var(--tb-n-7)",
            display: "flex",
          }}
        >
          <RenderQueueButton id={id} />
        </div>
      )}

      <ResizeGrip
        active={!!resizeDrag || selected}
        onPointerDown={onResizeStart}
        onDoubleClick={onResizeReset}
      />
    </div>
  );
}

// Bottom-right resize handle: a quarter-round bracket that traces just
// OUTSIDE the node's corner (the node clips nothing, so it can overhang),
// echoing the body's border radius. Brightens when the node is selected or
// being dragged. `nodrag` so grabbing it resizes the node instead of moving it.
function ResizeGrip({
  active,
  onPointerDown,
  onDoubleClick,
}: {
  active: boolean;
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  onDoubleClick: (e: React.MouseEvent) => void;
}) {
  const [hover, setHover] = useState(false);
  const coarse = useCoarsePointer();
  // The visible bracket stays 12px at every input type; only the invisible
  // grab box around it grows for a fingertip.
  const hit = coarse ? 28 : 16;
  return (
    <div
      className="nodrag"
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "absolute",
        // Overhangs the corner by 4px — the bracket reads as an outline
        // offset from the node edge rather than a glyph sitting on it.
        right: -4,
        bottom: -4,
        width: hit,
        height: hit,
        cursor: "nwse-resize",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "flex-end",
        zIndex: 4,
        // Always fully opaque on touch: there's no hover to reveal it, and a
        // 0.28 grip is easy to miss when you can't feel your way to it.
        opacity: hover ? 0.95 : active ? 0.6 : coarse ? 0.55 : 0.28,
        transition: "opacity 120ms ease",
        // React Flow's node drag is pointer-driven; without this the browser
        // can claim the gesture for a pan before the grip's capture lands.
        ...TOUCH_DRAG_STYLE,
      }}
    >
      {/* Two borders + a corner radius draw the quarter arc exactly; an SVG
          path would have to guess at the same curve. */}
      <div
        style={{
          width: 12,
          height: 12,
          borderRight: "1px solid var(--tb-n-13)",
          borderBottom: "1px solid var(--tb-n-13)",
          borderBottomRightRadius: 12,
        }}
      />
    </div>
  );
}

function ExportButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      className="nodrag"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        flex: 1,
        background: hover ? "var(--tb-n-9)" : "var(--tb-n-7)",
        color: hover ? "var(--tb-n-17)" : "var(--tb-n-16)",
        border: `1px solid ${hover ? "var(--tb-n-11)" : "var(--tb-n-9)"}`,
        borderRadius: 3,
        padding: "3px 6px",
        fontFamily: "inherit",
        fontSize: 10,
        cursor: "pointer",
        transition:
          "background 100ms ease, color 100ms ease, border-color 100ms ease",
      }}
    >
      {label}
    </button>
  );
}

// The third export product on an Output / Layer Output: the spline wired
// into its `spline` tap, saved as a standalone .svg at the current playhead.
// Its own component so the connection subscription lives here — the row
// renders nothing at all when the tap is empty, which keeps the default
// chrome (Image / Video) exactly as it was. The panel gates its
// "Export SVG →" twin on the same wire.
function SvgExportButton({ id }: { id: string }) {
  const conns = useNodeConnections({
    handleType: "target",
    handleId: "in:spline",
  });
  if (conns.length === 0) return null;
  return (
    <ExportButton
      label="SVG"
      onClick={() =>
        window.dispatchEvent(
          new CustomEvent("effect-node-export", {
            detail: { id, kind: "svg" },
          })
        )
      }
    />
  );
}

// Render Queue's "run the whole queue" button — the one on-node action that
// isn't a toggle, so it gets a filled accent instead of HeaderToggle's pill.
function RenderQueueButton({ id }: { id: string }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      className="nodrag"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        window.dispatchEvent(
          new CustomEvent("effect-node-export", {
            detail: { id, kind: "queue" },
          })
        );
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="Render every queued Output in order"
      style={{
        flex: 1,
        background: hover ? "var(--tb-a-blue-700)" : "var(--tb-a-blue-900)",
        border: `1px solid ${hover ? "var(--tb-a-blue-500)" : "var(--tb-a-blue-700)"}`,
        color: hover ? "var(--tb-t-navy-l-0)" : "var(--tb-a-blue-200)",
        borderRadius: 999,
        padding: "4px 10px",
        fontFamily: "inherit",
        fontSize: 10,
        letterSpacing: 0.3,
        cursor: "pointer",
        transition:
          "background 100ms ease, color 100ms ease, border-color 100ms ease",
      }}
    >
      Render ▶
    </button>
  );
}

// Editable text box rendered on the node body (String source + Text node).
// Buffered-controlled: a local value backs the textarea while the user is
// editing so the round-trip through effect-node-param → onParamChange →
// re-render can't jump the caret. External changes (undo, a wired string
// driving the param, AI edits) are adopted only while NOT focused. When the
// param is exposed and wired, the wire wins at eval — so the box goes
// read-only and shows the stored value greyed to avoid a silent no-op edit.
function NodeStringInput({
  id,
  paramName,
  value,
  placeholder,
}: {
  id: string;
  paramName: string;
  value: string;
  placeholder?: string;
}) {
  const [text, setText] = useState(value);
  const editing = useRef(false);
  // Only this node's own `in:param:<name>` target handle; [] when the param
  // isn't exposed (no such handle) — so unexposed String/Text stays editable.
  const conns = useNodeConnections({
    handleType: "target",
    handleId: `in:param:${paramName}`,
  });
  const wired = conns.length > 0;

  // Adopt external value changes only when the user isn't typing here, so
  // fast keystrokes never get clobbered by a stale prop from an in-flight
  // store update.
  useEffect(() => {
    if (!editing.current) setText(value);
  }, [value]);

  return (
    <textarea
      className="nodrag"
      value={wired ? value : text}
      readOnly={wired}
      placeholder={placeholder}
      spellCheck={false}
      rows={3}
      onFocus={() => {
        editing.current = true;
      }}
      onBlur={() => {
        editing.current = false;
        // Resync to the canonical value in case onParamChange normalized it.
        setText(value);
      }}
      // Keep canvas interactions from firing while interacting with the box:
      // no node drag / marquee / shift-drag connect, and no editor keyboard
      // shortcuts (Backspace/Delete deleting the node, Space, Cmd-C/V/A…).
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onChange={(e) => {
        const next = e.target.value;
        setText(next);
        window.dispatchEvent(
          new CustomEvent("effect-node-param", {
            detail: { id, name: paramName, value: next },
          })
        );
      }}
      style={{
        width: "100%",
        minHeight: 48,
        // Fill a resized node's body (Feature B); box-sizing so the padding
        // doesn't overflow the node width.
        height: "100%",
        boxSizing: "border-box",
        resize: "none",
        background: "var(--tb-n-1)",
        color: wired ? "var(--tb-n-11)" : "var(--tb-n-16)",
        border: "1px solid var(--tb-n-7)",
        borderRadius: 4,
        fontFamily: "inherit",
        fontSize: 11,
        lineHeight: 1.4,
        padding: "4px 6px",
        outline: "none",
      }}
    />
  );
}

// Inline colour swatch on the node body (SDF primitives + SDF Material).
//
// Three states, because SDF colour is genuinely tri-state:
//   inheriting — `paint` off; the shape takes an enclosing Material's
//                colour, or the terminal's foreground. Shown as a
//                slashed outline, NOT as a colour, so "no colour of its
//                own" never reads as "black".
//   painted    — `paint` on; filled swatch + hex. The ✕ returns to
//                inheriting without disturbing the stored colour, so
//                toggling back and forth is lossless.
//   driven     — a wire into the colour input wins at eval, so the
//                swatch goes read-only and dims (same contract as
//                NodeScalarSlider).
function NodeColorSwatch({
  id,
  colorParam,
  paintParam,
  color,
  painted,
  open,
  setOpen,
}: {
  id: string;
  colorParam: string;
  paintParam?: string;
  color: string;
  painted: boolean;
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  // Two ways a colour can be driven: a real `color` input socket (SDF
  // Material) or the param exposed as `in:param:color` (any primitive).
  // Hooks can't be conditional, so both are always queried.
  const socketConns = useNodeConnections({
    handleType: "target",
    handleId: `in:${colorParam}`,
  });
  const paramConns = useNodeConnections({
    handleType: "target",
    handleId: `in:param:${colorParam}`,
  });
  const wired = socketConns.length > 0 || paramConns.length > 0;

  const emit = (name: string, value: unknown) =>
    window.dispatchEvent(
      new CustomEvent("effect-node-param", { detail: { id, name, value } })
    );

  const swatchBg = painted && !wired ? color : "transparent";

  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 6 }}>
      <button
        className="nodrag"
        title={
          wired
            ? "Driven by a wired input"
            : painted
              ? "Edit color"
              : "Give this shape its own color"
        }
        disabled={wired}
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          if (wired) return;
          // Turning paint on and opening the picker is one gesture —
          // an extra click to reveal a control you just asked for is
          // pure friction.
          if (paintParam && !painted) emit(paintParam, true);
          setOpen(!open);
        }}
        style={{
          width: 22,
          height: 16,
          padding: 0,
          borderRadius: 3,
          border: "1px solid var(--tb-n-9)",
          background: swatchBg,
          cursor: wired ? "default" : "pointer",
          opacity: wired ? 0.5 : 1,
          position: "relative",
          overflow: "hidden",
        }}
      >
        {!painted && !wired && (
          // Corner-to-corner slash: the conventional "no paint" mark.
          <span
            style={{
              position: "absolute",
              inset: 0,
              background:
                "linear-gradient(to top right, transparent 45%, var(--tb-n-10) 45%, var(--tb-n-10) 55%, transparent 55%)",
            }}
          />
        )}
      </button>

      <span style={{ fontSize: 10, color: "var(--tb-n-11)", flex: 1 }}>
        {wired ? "driven" : painted ? color : "inherit"}
      </span>

      {painted && paintParam && !wired && (
        <button
          className="nodrag"
          title="Back to inheriting"
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            emit(paintParam, false);
            setOpen(false);
          }}
          style={{
            width: 14,
            height: 14,
            padding: 0,
            lineHeight: "12px",
            fontSize: 11,
            borderRadius: 3,
            border: "1px solid var(--tb-n-7)",
            background: "transparent",
            color: "var(--tb-n-11)",
            cursor: "pointer",
          }}
        >
          ×
        </button>
      )}

      {open && !wired && (
        <ColorPickerPopover
          value={color}
          onChange={(hex) => emit(colorParam, hex)}
          onClose={() => setOpen(false)}
          style={{ top: "100%", right: 0, marginTop: 4 }}
        />
      )}
    </div>
  );
}

// Inline scalar slider on the node body (Constant). Reuses the ParamPanel
// slider visuals (MiniBarSlider) + scrub number field at node scale. Both
// controls buffer their own interaction state and rAF-coalesce, so edits are
// just forwarded through effect-node-param → onParamChange. Wrapped in
// `nodrag` + propagation stops so dragging the bar / scrubbing the number
// doesn't move or delete the node. When the param is exposed and wired, the
// wire wins at eval — so we show a greyed read-only value instead.
function NodeScalarSlider({
  id,
  paramName,
  value,
  min,
  max,
  step,
  snapToStep,
  sliderMin,
  sliderMax,
}: {
  id: string;
  paramName: string;
  value: number;
  min: number;
  max: number;
  step: number;
  // Step came from ParamDef.stepFrom — snap edits to zero-based multiples
  // of it (k·step, clamped) so values land ON the increments rather than
  // the native range's min-offset grid. Mirrors ParamControl's behavior.
  snapToStep?: boolean;
  sliderMin: number;
  sliderMax: number;
}) {
  const conns = useNodeConnections({
    handleType: "target",
    handleId: `in:param:${paramName}`,
  });
  const wired = conns.length > 0;
  const emit = (raw: number) => {
    let v = raw;
    if (snapToStep && step > 0 && Number.isFinite(v)) {
      v = parseFloat((Math.round(v / step) * step).toFixed(6));
      v = Math.max(min, Math.min(max, v));
    }
    window.dispatchEvent(
      new CustomEvent("effect-node-param", {
        detail: { id, name: paramName, value: v },
      })
    );
  };

  if (wired) {
    return (
      <div
        title="Driven by a wired input"
        style={{
          height: 20,
          display: "flex",
          alignItems: "center",
          paddingLeft: 6,
          borderRadius: BAR_SLIDER_RADIUS,
          boxShadow: "inset 0 0 0 1px var(--tb-n-6)",
          background: "var(--tb-n-1)",
          color: "var(--tb-n-11)",
          fontSize: 11,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {Number.isInteger(value) ? value : Number(value.toFixed(3))}
      </div>
    );
  }

  return (
    <div
      className="nodrag"
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      style={{ display: "flex", gap: 4, alignItems: "center" }}
    >
      <MiniBarSlider
        value={value}
        min={sliderMin}
        max={sliderMax}
        step={step}
        onChange={emit}
      />
      <NumberField
        value={value}
        onChange={emit}
        min={min}
        max={max}
        step={step}
        width={44}
      />
    </div>
  );
}

// View / bypass glyphs. `currentColor` so they inherit HeaderToggle's
// on/off/hover colour without either side knowing the other's palette.
function EyeIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M1.5 12S5.8 5.5 12 5.5 22.5 12 22.5 12 18.2 18.5 12 18.5 1.5 12 1.5 12z" />
      <circle cx="12" cy="12" r="3.2" />
    </svg>
  );
}

function BanIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M5.6 5.6 18.4 18.4" />
    </svg>
  );
}

// Header pill button (view / bypass / viewport numbers / +). `label` is a
// node, not a string, so the view + bypass toggles can carry icons while the
// rest stay glyphs. Hover lives in local state on purpose — keeping it out of
// EffectNode means pointing at one toggle doesn't re-render the whole node.
function HeaderToggle({
  on,
  label,
  title,
  activeBg,
  activeFg,
  onClick,
}: {
  on: boolean;
  label: React.ReactNode;
  title: string;
  activeBg: string;
  activeFg: string;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={title}
      aria-label={title}
      className="nodrag"
      style={{
        width: 18,
        height: 18,
        borderRadius: 6,
        fontSize: 10,
        fontWeight: 600,
        padding: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: on ? activeBg : hover ? "var(--tb-n-9)" : "transparent",
        color: on ? activeFg : hover ? "var(--tb-n-16)" : "var(--tb-n-11)",
        border: `1px solid ${on ? activeBg : hover ? "var(--tb-n-11)" : "var(--tb-n-9)"}`,
        // An ON toggle already owns its accent hue, so hover lifts it with a
        // white film instead of a second colour — one rule covers every
        // activeBg (view green, bypass amber, the grey + buttons).
        boxShadow: on && hover
          ? "inset 0 0 0 20px color-mix(in srgb, var(--tb-lift) 16%, transparent)"
          : undefined,
        cursor: "pointer",
        fontFamily: "inherit",
        transition:
          "background 100ms ease, color 100ms ease, border-color 100ms ease, box-shadow 100ms ease",
      }}
    >
      {label}
    </button>
  );
}

// The header's circled "i" — opens NodeInspectorPopup. Its own component so
// hover state doesn't re-render the node; `data-node-inspect-toggle` is what
// the popup's outside-click handler looks for, so it has to stay.
function InspectButton({ id }: { id: string }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        window.dispatchEvent(
          new CustomEvent("effect-node-toggle", {
            detail: { id, kind: "toggleInspect" },
          })
        );
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="Inspect — show inputs and outputs flowing through this node"
      className="nodrag"
      data-node-inspect-toggle="1"
      style={{
        width: 14,
        height: 14,
        borderRadius: "50%",
        background: hover ? "var(--tb-n-9)" : "transparent",
        border: `1px solid ${hover ? "var(--tb-n-13)" : "var(--tb-n-10)"}`,
        color: hover ? "var(--tb-n-16)" : "var(--tb-n-13)",
        fontSize: 9,
        fontWeight: 800,
        fontFamily: "inherit",
        lineHeight: "12px",
        textAlign: "center",
        padding: 0,
        cursor: "pointer",
        transition:
          "background 100ms ease, color 100ms ease, border-color 100ms ease",
      }}
    >
      i
    </button>
  );
}

// Star badge above the top-right corner of an AI-authored group.
function AiEditButton({ id }: { id: string }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      className="nodrag"
      title="Edit with AI"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        window.dispatchEvent(
          new CustomEvent("ai-edit-node", { detail: { nodeId: id } })
        );
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "absolute",
        // Hovers just above the node's top-right corner.
        top: -12,
        right: -8,
        width: 20,
        height: 20,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 999,
        background: hover ? "var(--tb-t-violet-d-0)" : "var(--tb-t-violet-d-1)",
        border: `1px solid ${hover ? "var(--tb-a-violet-400)" : "#6d28d9"}`,
        cursor: "pointer",
        padding: 0,
        zIndex: 5,
        boxShadow: "var(--tb-shadow-chip)",
        transition: "background 100ms ease, border-color 100ms ease",
      }}
    >
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill={hover ? "var(--tb-t-violet-l-1)" : "var(--tb-a-violet-400)"}
        aria-hidden
      >
        <path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2z" />
      </svg>
    </button>
  );
}

// On-node color swatch (Color node output rows) — clicking opens the
// picker popover for that output's param. Checker underlay is unnecessary:
// param colors are RGB hex (alpha is a separate param).
function ColorSwatchButton({
  color,
  title,
  onClick,
  disabled,
}: {
  color: string;
  title: string;
  onClick: () => void;
  // Palette mode (image wired) — the swatch is a readout, not an editor.
  disabled?: boolean;
}) {
  const [hover, setHover] = useState(false);
  // The swatch IS its colour, so hover brightens the inset ring rather than
  // the fill — nothing about the value on screen may shift. A disabled
  // swatch is a readout and stays inert.
  const lit = hover && !disabled;
  return (
    <button
      className="nodrag"
      title={title}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onClick();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 14,
        height: 14,
        flexShrink: 0,
        borderRadius: 3,
        background: color,
        border: "1px solid rgba(0,0,0,0.55)",
        boxShadow: lit
          ? "inset 0 0 0 1px color-mix(in srgb, var(--tb-lift) 50%, transparent)"
          : "inset 0 0 0 1px color-mix(in srgb, var(--tb-lift) 14%, transparent)",
        cursor: disabled ? "default" : "pointer",
        padding: 0,
        transition: "box-shadow 100ms ease",
      }}
    />
  );
}

// Visual dot rendered as a child of the larger transparent Handle.
// pointerEvents: none so all clicks fall through to the Handle for
// React Flow's connection logic.
function SocketDot({
  size,
  background,
  border,
  borderRadius = "50%",
}: {
  size: number;
  background: string;
  border: string;
  borderRadius?: number | string;
}) {
  return (
    <div
      style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        width: size,
        height: size,
        background,
        border,
        borderRadius,
        pointerEvents: "none",
      }}
    />
  );
}

export default memo(EffectNode);
