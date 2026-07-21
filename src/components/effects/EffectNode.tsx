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
import { MiniBarSlider, NumberField } from "@/lib/param-controls";
import { colorForSocket } from "./socketColor";
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
    window.addEventListener("node-timings", onTimings);
    return () => {
      window.removeEventListener("node-timings", onTimings);
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
    window.addEventListener("node-media-loading", onLoading);
    return () => window.removeEventListener("node-media-loading", onLoading);
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
    window.addEventListener("viewport-split-changed", onChange);
    return () => window.removeEventListener("viewport-split-changed", onChange);
  }, []);

  const isQueue = data.defType === "render-queue";
  // A Layer Output (the fixed group-output inside a layer) gets the Output
  // node's render buttons too, so you can render a layer from inside it (#159).
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
    window.addEventListener("render-queue-progress", onProg);
    return () => window.removeEventListener("render-queue-progress", onProg);
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
    const step = p.step ?? 0.01;
    const sliderMax = ov?.softMax ?? p.softMax ?? max;
    const sliderMin = Math.max(min, -sliderMax);
    return { min, max, step, sliderMin, sliderMax };
  }, [data.defType, scalarInputParam, data.paramOverrides]);

  // Content-driven minimum width (the auto size when unresized). Reused as
  // the outer div's minWidth AND the resize clamp floor.
  const minWidth = isQueue
    ? 300
    : data.defType === "collect"
      ? 240
      : data.defType === "color-literal"
        ? 220
        : 200;

  // Bottom-left resize grip. Drag = live local preview (the outer div grows +
  // a transform keeps the RIGHT edge anchored while the LEFT edge follows the
  // cursor); a single commit on pointer-up dispatches `effect-node-resize`,
  // which EffectsApp turns into one setNodes + one undo step (size on
  // data.uiWidth/uiHeight, plus position.x shifted so the right edge holds).
  const nodeRef = useRef<HTMLDivElement>(null);
  const rf = useReactFlow();
  const [resizeDrag, setResizeDrag] = useState<{
    w: number;
    h: number;
    tx: number;
  } | null>(null);

  const onResizeStart = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
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
    let latest = { w: startW, h: startH, tx: 0 };
    const onMove = (ev: PointerEvent) => {
      const dxFlow = (ev.clientX - startX) / zoom;
      const dyFlow = (ev.clientY - startY) / zoom;
      const w = Math.max(minWidth, startW - dxFlow); // left edge follows cursor
      const h = Math.max(minH, startH + dyFlow); // bottom edge follows cursor
      const tx = startW - w; // shift so the right edge stays put
      latest = { w, h, tx };
      setResizeDrag({ w, h, tx });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setResizeDrag(null);
      window.dispatchEvent(
        new CustomEvent("effect-node-resize", {
          detail: {
            id,
            width: Math.round(latest.w),
            height: Math.round(latest.h),
            dx: latest.tx,
          },
        })
      );
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Double-click the grip clears the override → back to auto content size.
  const onResizeReset = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.dispatchEvent(
      new CustomEvent("effect-node-resize", { detail: { id, reset: true } })
    );
  };

  // Re-measure handle positions after a committed resize (right-side sockets
  // moved with the width; left sockets moved with a left-edge resize) so wires
  // stay attached — same re-measure the socket-rename path relies on.
  useEffect(() => {
    updateNodeInternals(id);
  }, [data.uiWidth, data.uiHeight, id, updateNodeInternals]);

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
    window.addEventListener("color-node-palette", onPalette);
    return () => window.removeEventListener("color-node-palette", onPalette);
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
        // User-resized box (bottom-left grip) → explicit size; a live drag
        // previews from local state. Absent ⇒ auto (minWidth / content height).
        width: resizeDrag ? resizeDrag.w : data.uiWidth,
        height: resizeDrag ? resizeDrag.h : data.uiHeight,
        // Keep the right edge anchored while the left edge follows the cursor
        // during a drag; removed on commit (position.x absorbs the shift).
        transform: resizeDrag ? `translateX(${resizeDrag.tx}px)` : undefined,
        // A node with an on-node text box lays out as a flex column so the
        // textarea can flex to fill a resized (taller) body. Other node types
        // stay in block flow — an over-tall box just leaves bottom space.
        display: stringInputParam ? "flex" : undefined,
        flexDirection: stringInputParam ? "column" : undefined,
        // Layer nodes + their boundary nodes get a faint blue wash (#159).
        background: data.layerAccent ? "#171b24" : "#18181b",
        border: `1px solid ${
          selected
            ? "#60a5fa"
            : data.error
              ? "#ef4444"
              : data.layerAccent
                ? "#39507a"
                : "#3f3f46"
        }`,
        borderRadius: 6,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        fontSize: 11,
        color: "#e5e7eb",
        opacity: bypassed ? 0.5 : 1,
        boxShadow: selected
          ? "0 0 0 1px rgba(96,165,250,0.3)"
          : "0 2px 8px rgba(0,0,0,0.4)",
        // Fade the selection outline (border tint + ring) in/out rather
        // than snapping it on click.
        transition: "border-color 140ms ease, box-shadow 140ms ease",
        // position: relative anchors the timing label below as an
        // absolutely-positioned overlay above the node's top edge.
        position: "relative",
      }}
    >
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
                ? "#34d399"
                : evalMs < 16
                ? "#facc15"
                : "#ef4444",
            opacity: 0.7,
            letterSpacing: 0.3,
            fontVariantNumeric: "tabular-nums",
            pointerEvents: "none",
          }}
        >
          {formatMs(evalMs)}
        </div>
      )}
      {!!data.aiAuthored && (
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
            background: "#1a1430",
            border: "1px solid #6d28d9",
            cursor: "pointer",
            padding: 0,
            zIndex: 5,
            boxShadow: "0 1px 4px rgba(0,0,0,0.45)",
          }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="#a78bfa" aria-hidden>
            <path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2z" />
          </svg>
        </button>
      )}
      <div
        style={{
          padding: "6px 8px",
          borderBottom: "1px solid #27272a",
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
              style={{ display: "inline-flex", color: "#93c5fd" }}
            >
              <Spinner size={11} stroke={1.6} arc={0.28} />
            </span>
          )}
          {data.displayName ?? data.name}
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
            title="Inspect — show inputs and outputs flowing through this node"
            className="nodrag"
            data-node-inspect-toggle="1"
            style={{
              width: 14,
              height: 14,
              borderRadius: "50%",
              background: "transparent",
              border: "1px solid #52525b",
              color: "#a1a1aa",
              fontSize: 9,
              fontWeight: 700,
              fontFamily: "inherit",
              fontStyle: "italic",
              lineHeight: "12px",
              textAlign: "center",
              padding: 0,
              cursor: "pointer",
            }}
          >
            i
          </button>
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
                  background: "#18181b",
                  color: "#e5e7eb",
                  border: "1px solid #27272a",
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
              style={{ color: "#ef4444", fontSize: 10, marginRight: 4 }}
            >
              ERR
            </span>
          ) : null}
          {/* A view / A2 / B bypass make no sense on a Render Queue —
              it produces nothing to view or pass through. */}
          {!isQueue && (
            <HeaderToggle
              on={active}
              label={viewportSplit ? "A1" : "A"}
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
              activeFg="#d1fae5"
              onClick={() => dispatch("toggleActive")}
            />
          )}
          {!isQueue && viewportSplit && (
            <HeaderToggle
              on={active2}
              label="A2"
              title={
                active2
                  ? "Active in viewport 2"
                  : "Set active in viewport 2"
              }
              activeBg="#0369a1"
              activeFg="#dbeafe"
              onClick={() => dispatch("toggleActive2")}
            />
          )}
          {!isQueue && (
            <HeaderToggle
              on={bypassed}
              label="B"
              title={bypassed ? "Bypassed" : "Bypass (pass through)"}
              activeBg="#b45309"
              activeFg="#fef3c7"
              onClick={() => dispatch("toggleBypass")}
            />
          )}
          {data.defType === "merge" && (
            <HeaderToggle
              on={false}
              label="+"
              title="Add input layer"
              activeBg="#374151"
              activeFg="#e5e7eb"
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
              activeBg="#374151"
              activeFg="#e5e7eb"
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
              activeBg="#374151"
              activeFg="#e5e7eb"
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
              activeBg="#374151"
              activeFg="#e5e7eb"
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
              activeBg="#374151"
              activeFg="#e5e7eb"
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
              activeBg="#374151"
              activeFg="#e5e7eb"
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
              activeBg="#1e3a8a"
              activeFg="#bfdbfe"
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
              activeBg="#374151"
              activeFg="#e5e7eb"
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
                    isVirtual ? "1px dashed #52525b" : "1px solid #0a0a0a"
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
                    color: isVirtual ? "#52525b" : "#a1a1aa",
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
                          background: "#0a0a0a",
                          border: "1px solid #27272a",
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
                            background: "#2563eb",
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
                  border="1px dashed #52525b"
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
                <span style={{ color: "#71717a", fontStyle: "italic" }}>
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
                border="1px solid #0a0a0a"
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
              <span style={{ color: "#e4e4e7" }}>out</span>
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
                        : "#27272a"
                      : colorForSocket(aux.type)
                  }
                  border={
                    disabled || isVirtual
                      ? "1px dashed #52525b"
                      : "1px solid #0a0a0a"
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
                      color: disabled ? "#52525b" : colorForSocket(aux.type),
                      fontSize: 9,
                    }}
                  >
                    {aux.type}
                  </span>
                )}
                <span
                  style={{
                    color: isVirtual ? "#52525b" : "#71717a",
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
            borderTop: "1px solid #27272a",
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
            borderTop: "1px solid #27272a",
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
            sliderMin={scalarConfig.sliderMin}
            sliderMax={scalarConfig.sliderMax}
          />
        </div>
      )}

      {(data.defType === "output" || isLayerOutput) && (
        <div
          style={{
            padding: "6px 8px",
            borderTop: "1px solid #27272a",
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
        </div>
      )}

      {isQueue && (
        <div
          style={{
            padding: "6px 8px",
            borderTop: "1px solid #27272a",
            display: "flex",
          }}
        >
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
            title="Render every queued Output in order"
            style={{
              flex: 1,
              background: "#1e3a8a",
              border: "1px solid #1d4ed8",
              color: "#bfdbfe",
              borderRadius: 999,
              padding: "4px 10px",
              fontFamily: "inherit",
              fontSize: 10,
              letterSpacing: 0.3,
              cursor: "pointer",
            }}
          >
            Render ▶
          </button>
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

// Bottom-left resize handle. A quiet corner target that brightens when the
// node is selected or being dragged. `nodrag` so grabbing it resizes the
// node instead of moving it.
function ResizeGrip({
  active,
  onPointerDown,
  onDoubleClick,
}: {
  active: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onDoubleClick: (e: React.MouseEvent) => void;
}) {
  const [hover, setHover] = useState(false);
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
        left: 0,
        bottom: 0,
        width: 16,
        height: 16,
        cursor: "nesw-resize",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "flex-start",
        padding: 3,
        // The bottom-left rounding matches the node corner so the hit area
        // doesn't poke past it.
        borderBottomLeftRadius: 6,
        zIndex: 4,
        opacity: hover ? 0.95 : active ? 0.6 : 0.28,
        transition: "opacity 120ms ease",
      }}
    >
      <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden>
        <path
          d="M0 8 L8 0 M0 8 L4 8 M0 8 L0 4"
          stroke="#a1a1aa"
          strokeWidth="1"
          fill="none"
        />
      </svg>
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
  return (
    <button
      className="nodrag"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{
        flex: 1,
        background: "#27272a",
        color: "#e5e7eb",
        border: "1px solid #3f3f46",
        borderRadius: 3,
        padding: "3px 6px",
        fontFamily: "inherit",
        fontSize: 10,
        cursor: "pointer",
      }}
    >
      {label}
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
        background: "#0e0e11",
        color: wired ? "#71717a" : "#e5e7eb",
        border: "1px solid #27272a",
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
  sliderMin,
  sliderMax,
}: {
  id: string;
  paramName: string;
  value: number;
  min: number;
  max: number;
  step: number;
  sliderMin: number;
  sliderMax: number;
}) {
  const conns = useNodeConnections({
    handleType: "target",
    handleId: `in:param:${paramName}`,
  });
  const wired = conns.length > 0;
  const emit = (v: number) =>
    window.dispatchEvent(
      new CustomEvent("effect-node-param", {
        detail: { id, name: paramName, value: v },
      })
    );

  if (wired) {
    return (
      <div
        title="Driven by a wired input"
        style={{
          height: 20,
          display: "flex",
          alignItems: "center",
          paddingLeft: 6,
          borderRadius: 6,
          boxShadow: "inset 0 0 0 1px #232327",
          background: "#0f0f11",
          color: "#71717a",
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

function HeaderToggle({
  on,
  label,
  title,
  activeBg,
  activeFg,
  onClick,
}: {
  on: boolean;
  label: string;
  title: string;
  activeBg: string;
  activeFg: string;
  onClick: () => void;
}) {
  return (
    <button
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={title}
      className="nodrag"
      style={{
        width: 18,
        height: 18,
        borderRadius: 3,
        fontSize: 10,
        fontWeight: 600,
        lineHeight: "16px",
        textAlign: "center",
        padding: 0,
        background: on ? activeBg : "transparent",
        color: on ? activeFg : "#71717a",
        border: `1px solid ${on ? activeBg : "#3f3f46"}`,
        cursor: "pointer",
        fontFamily: "inherit",
      }}
    >
      {label}
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
      style={{
        width: 14,
        height: 14,
        flexShrink: 0,
        borderRadius: 3,
        background: color,
        border: "1px solid rgba(0,0,0,0.55)",
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.14)",
        cursor: disabled ? "default" : "pointer",
        padding: 0,
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
