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
  FloatCurveEditor,
  MiniBarSlider,
  NumberField,
  hexAlpha01,
  hexToHsl,
  hslToHex,
  sampleRampAlpha,
  sampleRampColor,
  withHexAlpha,
} from "@/lib/param-controls";
import { sanitizeFloatCurve, type CurvePoint } from "@/engine/float-curve";
import { HslField } from "@/lib/number-field";
import { COLOR_RAMP_MAX_STOPS, newStopId } from "@/nodes/effect/color-ramp";
import {
  startPointerDrag,
  useCoarsePointer,
  TOUCH_DRAG_STYLE,
} from "@/lib/pointer-drag";
import { colorForSocket } from "./socketColor";
import {
  isAttrNameInvalid,
  readUpstreamAttrNames,
} from "./attr-name-source";
import { tintRgba } from "./node-tints";
import { Spinner } from "./Spinner";
import { useAudioAudible } from "@/state/audio-audibility";
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
// mapped to the string param it edits. Multiline params render a
// <textarea> that fills the body; `singleLine` renders a compact one-row
// <input> (Set Named Attribute's channel name — the name IS the node's
// meaning, so it belongs on the body). Edits route through the shared
// `effect-node-param` event (→ onParamChange), same as the header
// dropdowns and Color swatches.
const STRING_INPUT_PARAMS: Record<
  string,
  { param: string; singleLine?: boolean }
> = {
  "string-literal": { param: "value" },
  text: { param: "text" },
  // Expression's source is the whole point of the node — reading the graph
  // means reading the formula, so it goes on the body next to the input
  // variables the header `+` mints rather than only in the panel.
  expression: { param: "expression" },
  // The shader source IS the node, same reasoning as Expression.
  "glsl-expression": { param: "expression" },
  "set-named-attribute": { param: "attr_name", singleLine: true },
  "attribute-math": { param: "attr_name", singleLine: true },
  "attribute-blur": { param: "attr_name", singleLine: true },
  "attribute-transfer": { param: "attr_name", singleLine: true },
};

// Node types that surface an inline scalar slider on the node body, mapped to
// the scalar param it drives. Reuses the ParamPanel slider visuals
// (MiniBarSlider + NumberField) at node scale; edits route through the same
// `effect-node-param` event.
const SCALAR_INPUT_PARAMS: Record<string, string> = {
  constant: "value",
  // Switch's `index` — which slot is live is the one thing you flip while
  // looking at the graph, so it gets a bar on the node. Its range follows
  // `count` via ParamDef.maxFrom.
  switch: "index",
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

// Node types that surface a mini colour-ramp editor on the node body, mapped
// to the `color_ramp` param it edits. A registry rather than "any node with a
// color_ramp param" because four of the ramp-bearing nodes (Ascii, Stroke,
// Rasterize Spline, Diffusion Curves) declare TWO, and there's no honest rule
// for which one belongs on the body — see 080526_on-node-color-ramp.md.
//
// The widget is the panel's ColorRampControl minus the per-stop keyframe /
// expose affordances: bar + selected-stop row + H/S/L/A. Interpolation rides
// the header dropdown (def.headerControl) instead of eating a body row.
const RAMP_WIDGET_PARAMS: Record<string, string> = {
  "color-ramp": "stops",
};

// Node types that surface the float-curve editor on the node body, mapped to
// the `float_curve` param it edits. The Float Curve node IS its curve —
// burying the editor in the panel costs a selection round-trip per tweak.
// Reuses the panel's FloatCurveEditor wholesale (click-to-add, drag,
// drag-off-to-remove, x/y row); edits route through the same
// `effect-node-param` event. Unlike the ramp there's no wired/read-only
// case: float_curve params aren't exposable (paramSocketType → null).
const CURVE_WIDGET_PARAMS: Record<string, string> = {
  "float-curve": "curve",
};

interface ExposedSocket {
  name: string;
  label: string;
  socketType: SocketType;
}

// Compact ms formatting for the timing overlay. Sub-millisecond
// values land at "<1ms"; everything else rounds to whole ms so the
// label stays narrow and visually quiet.
// Shared with the perf panel's table (PerfPanel.costColor) so a node reads
// the same in the graph as it does in the list.
function perfColor(share: number): string {
  if (share >= 0.25) return "var(--tb-a-red-400)";
  if (share >= 0.12) return "var(--tb-a-amber-400)";
  if (share >= 0.05) return "var(--tb-a-yellow-400)";
  return "var(--tb-a-blue-400)";
}

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

  // Perf heatmap (specdocs/080726_perf-profiler.md M3): EffectsApp broadcasts
  // each node's SHARE of the frame while capture is armed. A share rather
  // than raw ms — the tint answers "where does the frame go", and an absolute
  // scale washes out entirely on a fast graph. `null` detail = capture off.
  const [perf, setPerf] = useState<{ share: number; ms: number; gpu: boolean } | null>(
    null
  );
  useEffect(() => {
    const onPerf = (e: Event) => {
      const detail = (e as CustomEvent<Map<string, { share: number; ms: number; gpu: boolean }> | null>)
        .detail;
      setPerf(detail ? detail.get(id) ?? null : null);
    };
    const win = panelWin ?? window;
    win.addEventListener("node-perf", onPerf);
    return () => win.removeEventListener("node-perf", onPerf);
  }, [id, panelWin]);

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

  // Not-audible indicator (080926_audio-v2-integration.md M-D): an
  // audio-CATEGORY node with an audio-typed primary output whose chain
  // reached no audible sink last eval — Output's `audio` socket, a Layer
  // Output audio boundary, or the Active node — gets a small muted-speaker
  // glyph in the header. The primary-output gate keeps notes-only (Step
  // Pattern) and analysis (Bands/Pitch/Spectral) nodes clean; `null` means
  // no eval has published a set yet, which must render nothing.
  const audible = useAudioAudible(id);
  const showNotAudible =
    audible === false &&
    data.primaryOutput === "audio" &&
    getNodeDef(data.defType)?.category === "audio";

  // On-node text box: String source (`value`), Text (`text`), Expression
  // (`expression`) and the attribute nodes (`attr_name`, single-line)
  // render an editable box on the node body. Placeholder + attr-name
  // semantics come from the def's ParamDef.
  const stringInput = STRING_INPUT_PARAMS[data.defType];
  const stringInputParam: string | undefined = stringInput?.param;
  const stringParamDef = useMemo(() => {
    if (!stringInputParam) return undefined;
    return getNodeDef(data.defType)?.params.find(
      (p) => p.name === stringInputParam
    );
  }, [data.defType, stringInputParam]);
  const stringPlaceholder = stringParamDef?.placeholder;
  // Invalid-attribute tint: same singleton read + rule as the panel row
  // (attr-name-source.ts). Refreshes when the node re-renders (param
  // edits); a purely-upstream channel change can lag one render — the
  // suggestions' freshness contract.
  let stringInvalid = false;
  if (stringParamDef?.suggestAttrsFrom && stringInputParam) {
    const current = data.params[stringInputParam];
    stringInvalid = isAttrNameInvalid(
      typeof current === "string" ? current : "",
      readUpstreamAttrNames(id, stringParamDef.suggestAttrsFrom),
      !!stringParamDef.suggestAttrsRequire
    );
  }

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
    // Param-driven upper bound (maxFrom — Switch's `index` spans exactly the
    // slots `count` mints). Override wins, `max` is the fallback.
    const max = ov?.max ?? p.maxFrom?.(data.params) ?? p.max ?? 1;
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

  // On-node mini colour ramp (Color Ramp). The stops live in data.params; the
  // only local state is which stop is selected, held here rather than inside
  // the widget so it survives the widget's re-renders.
  const rampParam: string | undefined = RAMP_WIDGET_PARAMS[data.defType];
  const rampStops: ColorRampStop[] | null = useMemo(() => {
    if (!rampParam) return null;
    const raw = data.params[rampParam];
    return Array.isArray(raw) ? (raw as ColorRampStop[]) : [];
  }, [rampParam, data.params]);
  const [rampSelId, setRampSelId] = useState<string | null>(null);

  // On-node float-curve editor (Float Curve). Memoized so the editor sees a
  // stable array identity per param value — a valid param passes through
  // sanitize with its ids intact, so drag-by-id survives re-renders. The
  // (0, 1) fallback endpoints match the node's ParamDef default.
  const curveParam: string | undefined = CURVE_WIDGET_PARAMS[data.defType];
  const curvePoints: CurvePoint[] | null = useMemo(() => {
    if (!curveParam) return null;
    return sanitizeFloatCurve(data.params[curveParam], 0, 1);
  }, [curveParam, data.params]);

  // The two nodes whose output IS a colour: the Color node (one swatch per
  // colour output) and Solid Color (one colour, one image out). Both carry a
  // clickable swatch on the output row and the shared H/S/L/A row below.
  // Declared up here because `minWidth` sizes for that row.
  const isColorNode = data.defType === "color-literal";
  const isSolidColorNode = data.defType === "solid-color";
  const hasOutSwatch = isColorNode || isSolidColorNode;

  // Content-driven minimum width (the auto size when unresized). Reused as
  // the outer div's minWidth AND the resize clamp floor.
  const minWidth = isQueue
    ? 300
    : data.defType === "collect"
      ? 240
      : // Four labelled number fields across, in one row.
        hasOutSwatch
        ? 260
        : // Ramp nodes sit NARROWER than the 200 default, not wider. Same
          // H/S/L/A fields, but stacked 2×2 instead of 4-across — a ramp is a
          // tall control, and a node that's mostly gradient reads better than
          // one padded out to fit a single row of number fields. Still
          // resizable: bar and grid both flex if it's dragged wider.
          // Curve nodes share the ramp's narrow floor: the chart scales to
          // node width, and a square editor at 150 is already comfortable.
          rampParam || curveParam
          ? 150
          : // Constant is half the default: its whole body is one bar + one
            // number, so 200 was mostly empty padding, and these tend to
            // appear in clusters feeding exposed inputs. 100 is the floor
            // the NodeScalarSlider row still fits in (MiniBarSlider's
            // minWidth 40 + the number field, inside 8px side padding).
            data.defType === "constant"
            ? 100
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
  // 071026_color-node-multi-output.md. Solid Color reuses the whole
  // arrangement — one output, one `color` param, so row-1 anchoring lands
  // as-is and `palette` stays null for it.
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const colorHexFor = (paramName: string): string => {
    const v = data.params[paramName];
    return typeof v === "string" ? v : "#ffffff";
  };
  const colorNodeCount = isColorNode
    ? Math.max(1, Math.floor((data.params.count as number) ?? 1))
    : 1;
  // 1-based index behind a color param name ("color" → 1, "color3" → 3).
  const colorParamIndex = (name: string): number =>
    name === "color" ? 1 : parseInt(name.slice("color".length), 10) || 1;
  // Which colour the bottom H/S/L/A row edits. Only the Color node with
  // count > 1 offers a choice; clicking a swatch moves the selection (and
  // opens that swatch's picker, as before). Dropping `count` can strand the
  // selection on a colour that no longer has an output — fall back to 1.
  const [selectedColorParam, setSelectedColorParam] = useState("color");
  const hslColorParam =
    colorParamIndex(selectedColorParam) <= colorNodeCount
      ? selectedColorParam
      : "color";
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
      {perf !== null && perf.share > 0.02 && (
        <>
          {/* Cost bar along the node's top edge — length and colour both
              track the node's share of the frame, so the expensive node in a
              graph is findable at a glance without reading any numbers. */}
          <div
            style={{
              position: "absolute",
              top: -3,
              left: 4,
              right: 4,
              height: 3,
              borderRadius: 2,
              background: "var(--tb-n-4)",
              overflow: "hidden",
              pointerEvents: "none",
              zIndex: 4,
            }}
          >
            <div
              style={{
                width: `${Math.min(100, perf.share * 100)}%`,
                height: "100%",
                background: perfColor(perf.share),
              }}
            />
          </div>
          <div
            style={{
              position: "absolute",
              top: -14,
              right: 2,
              fontSize: 9,
              color: perfColor(perf.share),
              opacity: 0.85,
              fontVariantNumeric: "tabular-nums",
              pointerEvents: "none",
            }}
            title={`${Math.round(perf.share * 100)}% of the frame's ${perf.gpu ? "GPU" : "CPU"} time`}
          >
            {perf.gpu ? "gpu " : ""}
            {formatMs(perf.ms)}
          </div>
        </>
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
          {showNotAudible && (
            <span
              title="Not audible — route to a Layer Output audio socket, the Output node, or set Active"
              style={{
                display: "inline-flex",
                color: "var(--tb-n-12)",
                flexShrink: 0,
              }}
            >
              <MutedSpeakerIcon />
            </span>
          )}
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
          {data.defType === "midi-editor" && (
            <HeaderToggle
              on={false}
              label="Edit"
              title="Open the piano-roll editor (or double-click the node)"
              activeBg="var(--tb-a-gray-700)"
              activeFg="var(--tb-n-16)"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("effect-node-toggle", {
                    detail: { id, kind: "midiEditorOpen" },
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
              {hasOutSwatch && (
                <ColorSwatchButton
                  color={swatchHexFor(1, "color")}
                  title={
                    palette
                      ? "Palette from image — disconnect to edit"
                      : "Edit color"
                  }
                  disabled={!!palette}
                  selected={colorNodeCount > 1 && hslColorParam === "color"}
                  onClick={() => {
                    setSelectedColorParam("color");
                    setPickerFor("color");
                  }}
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
                    color={swatchHexFor(colorParamIndex(aux.name), aux.name)}
                    title={
                      palette
                        ? "Palette from image — disconnect to edit"
                        : `Edit ${aux.label ?? aux.name}`
                    }
                    disabled={!!palette}
                    selected={hslColorParam === aux.name}
                    onClick={() => {
                      setSelectedColorParam(aux.name);
                      setPickerFor(aux.name);
                    }}
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

        {hasOutSwatch &&
          pickerFor &&
          (() => {
            // Anchor the popover just under the row whose swatch opened
            // it. Color N sits at row N-1 (primary is color 1, aux
            // colorN follows in order).
            const rowTop = PAD_Y + (colorParamIndex(pickerFor) - 1) * ROW_H;
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
            // Multiline fills the remaining height of a resized node so the
            // textarea can grow with it; the single-line variant keeps its
            // natural row height.
            flex: stringInput?.singleLine ? undefined : "1 1 auto",
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
            singleLine={stringInput?.singleLine}
            invalid={stringInvalid}
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
            // Keep the bar's floor in step with whatever width this node
            // type declares: row budget = minWidth − 16px side padding −
            // 4px gap − the 44px number field. Constant's 100 leaves 36.
            // Without this the bar's own 40px floor wins and the node
            // renders wider than its minWidth (it auto-sizes to content).
            barMinWidth={Math.max(24, minWidth - 64)}
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

      {hasOutSwatch && (
        <div
          style={{
            padding: "6px 8px",
            borderTop: "1px solid var(--tb-n-7)",
          }}
        >
          <NodeHslRow
            id={id}
            colorParam={hslColorParam}
            alphaParam="alpha"
            // Palette mode shows the extracted colour, matching the swatch.
            color={swatchHexFor(colorParamIndex(hslColorParam), hslColorParam)}
            alpha={
              typeof data.params.alpha === "number"
                ? (data.params.alpha as number)
                : 1
            }
            colorReadOnly={!!palette}
            readOnlyTitle="Palette from image — disconnect to edit"
          />
        </div>
      )}

      {rampParam && rampStops && (
        <div
          style={{
            padding: "6px 8px",
            borderTop: "1px solid var(--tb-n-7)",
          }}
        >
          <NodeColorRamp
            id={id}
            paramName={rampParam}
            stops={rampStops}
            selectedId={rampSelId}
            setSelectedId={setRampSelId}
          />
        </div>
      )}

      {curveParam && curvePoints && (
        <div
          className="nodrag"
          // Both, deliberately: `nodrag` + stopping POINTERdown is what holds
          // on touch (React Flow's node drag is pointer-driven). On the
          // wrapper rather than inside the editor — the panel component has
          // no reason to know about xyflow.
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            padding: "6px 8px",
            borderTop: "1px solid var(--tb-n-7)",
          }}
        >
          <FloatCurveEditor
            points={curvePoints}
            onChange={(next) =>
              window.dispatchEvent(
                new CustomEvent("effect-node-param", {
                  detail: { id, name: curveParam, value: next },
                })
              )
            }
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

// Editable text box rendered on the node body (String source, Text,
// Expression — see STRING_INPUT_PARAMS).
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
  singleLine,
  invalid,
}: {
  id: string;
  paramName: string;
  value: string;
  placeholder?: string;
  /** Compact one-row <input> instead of the body-filling <textarea>. */
  singleLine?: boolean;
  /** Verified-wrong attribute name — error tint (attr-name-source.ts). */
  invalid?: boolean;
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

  if (singleLine) {
    return (
      <input
        type="text"
        className="nodrag"
        value={wired ? value : text}
        readOnly={wired}
        placeholder={placeholder}
        title={
          invalid
            ? "No attribute with this name on the wired input (reserved names can't be attributes)"
            : undefined
        }
        spellCheck={false}
        onFocus={() => {
          editing.current = true;
        }}
        onBlur={() => {
          editing.current = false;
          setText(value);
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          // Enter commits (the change already dispatched) and drops focus.
          if (e.key === "Enter") e.currentTarget.blur();
        }}
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
          boxSizing: "border-box",
          background: invalid
            ? "color-mix(in srgb, var(--tb-a-red-400) 12%, var(--tb-n-1))"
            : "var(--tb-n-1)",
          color: wired ? "var(--tb-n-11)" : "var(--tb-n-16)",
          border: `1px solid ${invalid ? "var(--tb-a-red-400)" : "var(--tb-n-7)"}`,
          borderRadius: 4,
          fontFamily: "inherit",
          fontSize: 11,
          lineHeight: 1.4,
          padding: "3px 6px",
          outline: "none",
        }}
      />
    );
  }

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
  barMinWidth,
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
  // Host's node minWidth is tighter than the bar's 40px default floor —
  // without this the bar wins and the node renders wider than it declares.
  barMinWidth?: number;
}) {
  const conns = useNodeConnections({
    handleType: "target",
    handleId: `in:param:${paramName}`,
  });
  // A node may ALSO carry a real input socket of the same name that outranks
  // the stored param at eval time — Switch's `index`, the live-switching
  // wire. Read-only then, exactly as for an exposed-param wire, so the bar
  // never invites an edit the evaluator will ignore.
  const socketConns = useNodeConnections({
    handleType: "target",
    handleId: `in:${paramName}`,
  });
  const wired = conns.length > 0 || socketConns.length > 0;
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
        minWidth={barMinWidth}
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

// Checkerboard behind the ramp bar and its handles, so a partly transparent
// stop reads as transparent rather than as a dark colour.
const RAMP_CHECKER =
  "repeating-conic-gradient(var(--tb-n-3) 0% 25%, var(--tb-n-1) 0% 50%) 0 0 / 6px 6px";

// Inline colour-ramp editor on the node body (Color Ramp). A compact twin of
// the panel's ColorRampControl — same gestures, same model, same
// `effect-node-param` round-trip, so undo coalescing (`param:<id>:<name>`),
// autokey and the removed-stop cleanup in onParamChange all apply unchanged.
//
// Deliberately NOT a superset of the panel control: no per-stop keyframe
// diamonds and no expose buttons. This is the quick-adjust surface you use
// while looking at the canvas; the panel stays the complete one.
//
// Selection lives in the parent (EffectNode) so it survives this component's
// re-renders, and falls back to the leftmost stop rather than rendering an
// empty "pick a stop" state — on a node there is no room to spend a row
// saying nothing.
function NodeColorRamp({
  id,
  paramName,
  stops,
  selectedId,
  setSelectedId,
}: {
  id: string;
  paramName: string;
  stops: ColorRampStop[];
  selectedId: string | null;
  setSelectedId: (v: string | null) => void;
}) {
  const panelWin = usePanelWindow();
  const barRef = useRef<HTMLDivElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // A wire into the exposed ramp param wins at eval (M2 of
  // 080526_on-node-color-ramp.md), so the editor goes read-only — same
  // contract as NodeScalarSlider.
  const conns = useNodeConnections({
    handleType: "target",
    handleId: `in:param:${paramName}`,
  });
  const wired = conns.length > 0;

  // Latest stops for the pointermove handler, so a drag doesn't re-subscribe
  // the window listeners on every emitted frame. Synced in an effect rather
  // than during render — writing a ref in the render body is what
  // react-hooks/refs flags, and the commit lands well before any pointer
  // event can read it.
  const stopsRef = useRef(stops);
  useEffect(() => {
    stopsRef.current = stops;
  }, [stops]);

  const emit = (next: ColorRampStop[]) =>
    window.dispatchEvent(
      new CustomEvent("effect-node-param", {
        detail: { id, name: paramName, value: next },
      })
    );

  useEffect(() => {
    if (!dragId) return;
    const onMove = (e: PointerEvent) => {
      const rect = barRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      // clientX and the rect are both post-zoom screen px, so the ratio is
      // zoom-invariant — no need to divide out the flow transform.
      const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      window.dispatchEvent(
        new CustomEvent("effect-node-param", {
          detail: {
            id,
            name: paramName,
            value: stopsRef.current.map((s) =>
              s.id === dragId ? { ...s, position: pos } : s
            ),
          },
        })
      );
    };
    const onUp = () => setDragId(null);
    const win = panelWin ?? window;
    win.addEventListener("pointermove", onMove);
    win.addEventListener("pointerup", onUp);
    win.addEventListener("pointercancel", onUp);
    return () => {
      win.removeEventListener("pointermove", onMove);
      win.removeEventListener("pointerup", onUp);
      win.removeEventListener("pointercancel", onUp);
    };
  }, [dragId, panelWin, id, paramName]);

  const sorted = [...stops].sort((a, b) => a.position - b.position);
  const selected = stops.find((s) => s.id === selectedId) ?? sorted[0] ?? null;
  const selColor = selected?.color ?? "#000000";
  const selAlpha = Math.max(0, Math.min(1, selected?.alpha ?? 1));

  // Local H/S/L draft, mirroring ColorControl: hex→HSL→hex is lossy at the
  // achromatic edges (S 0, L 0/100 all collapse the hue), so typing a hue on
  // a black stop would snap back to 0 on every keystroke without this. The
  // key carries the stop id so SELECTING another stop resyncs, while our own
  // emits (which pre-stamp the key) do not.
  const [hsl, setHsl] = useState<[number, number, number]>(() =>
    hexToHsl(selColor)
  );
  const hslKeyRef = useRef(`${selected?.id ?? ""}|${selColor}`);
  useEffect(() => {
    const key = `${selected?.id ?? ""}|${selColor}`;
    if (key !== hslKeyRef.current) {
      hslKeyRef.current = key;
      setHsl(hexToHsl(selColor));
    }
  }, [selected?.id, selColor]);

  const gradientCss =
    sorted.length === 0
      ? "transparent"
      : sorted.length === 1
        ? (() => {
            const c = withHexAlpha(sorted[0].color, sorted[0].alpha ?? 1);
            return `linear-gradient(${c}, ${c})`;
          })()
        : `linear-gradient(to right, ${sorted
            .map(
              (s) =>
                `${withHexAlpha(s.color, s.alpha ?? 1)} ${(s.position * 100).toFixed(2)}%`
            )
            .join(", ")})`;

  function patchSelected(patch: Partial<ColorRampStop>) {
    if (!selected) return;
    emit(stops.map((s) => (s.id === selected.id ? { ...s, ...patch } : s)));
  }

  function addStopAt(pos: number) {
    if (stops.length >= COLOR_RAMP_MAX_STOPS) return;
    const p = Math.max(0, Math.min(1, pos));
    // Sample the ramp at the click so the new stop starts as the colour that
    // was already showing there — inserting a stop shouldn't change the ramp.
    // The empty-ramp guard matters: sampleRampColor returns a `var(--tb-n-12)`
    // placeholder with no stops to sample, and a CSS var must never be stored
    // into a project (it resolves nowhere in an exported app).
    const stop: ColorRampStop = {
      id: newStopId(),
      position: p,
      color: sorted.length > 0 ? sampleRampColor(sorted, p) : "#ffffff",
      alpha: sorted.length > 0 ? sampleRampAlpha(sorted, p) : 1,
    };
    emit([...stops, stop]);
    setSelectedId(stop.id);
  }

  function removeSelected() {
    if (!selected || stops.length <= 1) return;
    emit(stops.filter((s) => s.id !== selected.id));
    // Clear rather than pick: `selected` falls back to the leftmost stop, so
    // this lands somewhere predictable. Picking next[0] would follow STORED
    // order, which is whatever order stops happened to be added in.
    setSelectedId(null);
  }

  const setChannel = (idx: 0 | 1 | 2, v: number) => {
    if (!selected) return;
    const next: [number, number, number] = [...hsl];
    next[idx] = Math.max(0, Math.min(idx === 0 ? 360 : 100, Math.round(v)));
    setHsl(next);
    const hex = hslToHex(next[0], next[1], next[2]);
    hslKeyRef.current = `${selected.id}|${hex}`;
    patchSelected({ color: hex });
  };

  const dim: React.CSSProperties = wired
    ? { opacity: 0.5, pointerEvents: "none" }
    : {};
  const selIndex = selected
    ? sorted.findIndex((s) => s.id === selected.id) + 1
    : 0;

  return (
    <div
      className="nodrag"
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      style={{ display: "flex", flexDirection: "column", gap: 6, position: "relative" }}
    >
      <div
        ref={barRef}
        title={wired ? "Driven by a wired input" : "Click to add a stop"}
        onPointerDown={(e) => {
          if (wired) return;
          // Handles are children that overhang the bar — only a press on the
          // track itself inserts.
          if (e.target !== e.currentTarget) return;
          const rect = e.currentTarget.getBoundingClientRect();
          addStopAt((e.clientX - rect.left) / rect.width);
        }}
        style={{
          position: "relative",
          height: 20,
          background: `${gradientCss}, ${RAMP_CHECKER}`,
          border: "1px solid var(--tb-n-7)",
          borderRadius: 3,
          cursor: wired ? "default" : "copy",
          opacity: wired ? 0.6 : 1,
          boxSizing: "border-box",
        }}
      >
        {sorted.map((s) => {
          const isSel = s.id === selected?.id;
          const c8 = withHexAlpha(s.color, s.alpha ?? 1);
          return (
            <div
              key={s.id}
              onPointerDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                setSelectedId(s.id);
                if (!wired) setDragId(s.id);
              }}
              title={`${s.color} · α ${(s.alpha ?? 1).toFixed(2)} · pos ${s.position.toFixed(3)}`}
              style={{
                position: "absolute",
                left: `${Math.max(0, Math.min(1, s.position)) * 100}%`,
                top: -3,
                bottom: -3,
                width: 9,
                transform: "translateX(-50%)",
                boxSizing: "border-box",
                background: `linear-gradient(${c8}, ${c8}), ${RAMP_CHECKER}`,
                border: `1px solid ${isSel ? "var(--tb-n-17)" : "var(--tb-n-9)"}`,
                // A second ring in the surface colour so a light stop on a
                // light part of the ramp still reads as a separate object.
                boxShadow: `0 0 0 1px var(--tb-n-1)`,
                borderRadius: 3,
                cursor: wired ? "default" : "ew-resize",
              }}
            />
          );
        })}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          ...dim,
        }}
      >
        <span
          title="Selected stop, by position along the ramp"
          style={{
            fontSize: 10,
            color: "var(--tb-n-11)",
            fontVariantNumeric: "tabular-nums",
            flexShrink: 0,
          }}
        >
          {selIndex}/{sorted.length}
        </span>
        {/* No "Pos" label — at this width the field has to carry its own
            meaning, and its tooltip says so. The flex wrapper (with
            minWidth 0) is what lets the field's `width: 100%` shrink instead
            of overflowing the row. */}
        <div style={{ flex: 1, minWidth: 0, display: "flex" }}>
          <NumberField
            value={selected?.position ?? 0}
            onChange={(v) =>
              patchSelected({ position: Math.max(0, Math.min(1, v)) })
            }
            min={0}
            max={1}
            step={0.001}
            width="100%"
            title="Position along the ramp · drag to scrub, click to type"
          />
        </div>
        <button
          className="nodrag"
          title="Edit this stop's colour"
          onClick={(e) => {
            e.stopPropagation();
            setPickerOpen(!pickerOpen);
          }}
          style={{
            width: 22,
            height: 16,
            padding: 0,
            flexShrink: 0,
            borderRadius: 3,
            border: "1px solid var(--tb-n-9)",
            background: `linear-gradient(${withHexAlpha(selColor, selAlpha)}, ${withHexAlpha(selColor, selAlpha)}), ${RAMP_CHECKER}`,
            cursor: "pointer",
          }}
        />
        <button
          className="nodrag"
          title={
            stops.length <= 1 ? "A ramp needs at least one stop" : "Remove this stop"
          }
          disabled={stops.length <= 1}
          onClick={(e) => {
            e.stopPropagation();
            removeSelected();
          }}
          style={{
            width: 14,
            height: 14,
            padding: 0,
            marginLeft: "auto",
            flexShrink: 0,
            lineHeight: "12px",
            fontSize: 11,
            borderRadius: 3,
            border: "1px solid var(--tb-n-7)",
            background: "transparent",
            color: stops.length <= 1 ? "var(--tb-n-9)" : "var(--tb-n-11)",
            cursor: stops.length <= 1 ? "not-allowed" : "pointer",
            fontFamily: "inherit",
          }}
        >
          ×
        </button>
      </div>

      {/* H/S/L/A as a 2×2 grid, not a 4-across row: four labelled number
          fields need ~260px of node, and a ramp node wants to be narrow. The
          grid keeps every channel one click away at 150px and simply
          stretches if the node is dragged wider. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 4,
          ...dim,
        }}
      >
        {(["H", "S", "L"] as const).map((lbl, i) => (
          <HslField
            key={lbl}
            label={lbl}
            value={hsl[i]}
            max={i === 0 ? 360 : 100}
            onChange={(v) => setChannel(i as 0 | 1 | 2, v)}
            grow
          />
        ))}
        <HslField
          label="A"
          value={Math.round(selAlpha * 100)}
          max={100}
          onChange={(v) =>
            patchSelected({ alpha: Math.max(0, Math.min(100, v)) / 100 })
          }
          grow
        />
      </div>

      {pickerOpen && !wired && (
        <ColorPickerPopover
          // The stop model keeps colour and alpha in separate fields; the
          // picker speaks 8-digit hex, so compose on the way in and split on
          // the way out.
          value={withHexAlpha(selColor, selAlpha)}
          alpha
          onChange={(hex) => {
            const rgb = hex.slice(0, 7);
            hslKeyRef.current = `${selected?.id ?? ""}|${rgb}`;
            setHsl(hexToHsl(rgb));
            patchSelected({ color: rgb, alpha: hexAlpha01(hex) });
          }}
          onClose={() => setPickerOpen(false)}
          style={{ top: "100%", right: 0, marginTop: 4 }}
        />
      )}
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

// Muted speaker for the not-audible chip on audio nodes. The body is
// filled so it still reads at 12px; the "x" is stroked like the other
// header icons.
function MutedSpeakerIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      aria-hidden
    >
      <path
        d="M11 5 6 9H2v6h4l5 4z"
        fill="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="m16 9 6 6M22 9l-6 6" />
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

// Compact H/S/L/A row on the node body, for the nodes whose output IS a
// colour (Color, Solid Color). Same four fields the Color Ramp puts under
// its bar, and there for the same reason: nudging one channel shouldn't
// cost a trip through the picker popover.
//
// Unlike the ramp — whose stops carry colour and alpha in one object —
// these nodes keep them in two params, an RGB hex and a 0..1 scalar. So A
// reads and writes as a percentage of `alphaParam`, and the two halves lock
// independently: a wire into the colour param must not grey out an alpha
// that is still live (exactly what happens in the Color node's palette
// mode, where the image drives the colours but `alpha` still applies).
//
// The local H/S/L draft mirrors NodeColorRamp's: hex→HSL→hex is lossy at
// the achromatic edges (S 0, L 0/100 all collapse the hue), so typing a hue
// on a black colour would snap back to 0 on every keystroke without it.
// `syncKey` carries the target param name, so SWITCHING which colour is
// selected resyncs the draft while our own emits (which pre-stamp the key)
// do not.
function NodeHslRow({
  id,
  colorParam,
  alphaParam,
  color,
  alpha,
  colorReadOnly,
  readOnlyTitle,
}: {
  id: string;
  colorParam: string;
  alphaParam: string;
  color: string;
  alpha: number;
  colorReadOnly?: boolean;
  readOnlyTitle?: string;
}) {
  // A wire into either exposed param wins at eval, so that half goes
  // read-only — same contract as NodeScalarSlider and NodeColorRamp.
  const colorConns = useNodeConnections({
    handleType: "target",
    handleId: `in:param:${colorParam}`,
  });
  const alphaConns = useNodeConnections({
    handleType: "target",
    handleId: `in:param:${alphaParam}`,
  });
  const colorWired = colorConns.length > 0;
  const colorLocked = !!colorReadOnly || colorWired;
  const alphaLocked = alphaConns.length > 0;

  const [hsl, setHsl] = useState<[number, number, number]>(() =>
    hexToHsl(color)
  );
  const syncKey = useRef(`${colorParam}|${color}`);
  useEffect(() => {
    const key = `${colorParam}|${color}`;
    if (key !== syncKey.current) {
      syncKey.current = key;
      setHsl(hexToHsl(color));
    }
  }, [colorParam, color]);

  const emit = (name: string, value: unknown) =>
    window.dispatchEvent(
      new CustomEvent("effect-node-param", { detail: { id, name, value } })
    );

  const setChannel = (idx: 0 | 1 | 2, v: number) => {
    const next: [number, number, number] = [...hsl];
    next[idx] = Math.max(0, Math.min(idx === 0 ? 360 : 100, Math.round(v)));
    setHsl(next);
    const hex = hslToHex(next[0], next[1], next[2]);
    syncKey.current = `${colorParam}|${hex}`;
    emit(colorParam, hex);
  };

  // Each field gets its own flex:1 cell so all four come out the same width
  // — grouping H/S/L under one flex:3 box would charge that box for its two
  // internal gaps and leave A a few px wider.
  const cell = (locked: boolean): React.CSSProperties => ({
    display: "flex",
    flex: 1,
    minWidth: 0,
    ...(locked ? { opacity: 0.5, pointerEvents: "none" } : null),
  });

  // The lock message rides the row, not the cells: `pointerEvents: none` is
  // what makes a cell inert, and an inert element never shows a title.
  const lockTitle =
    colorLocked && alphaLocked
      ? "Driven by wired inputs"
      : colorWired
        ? "Color driven by a wired input"
        : colorReadOnly
          ? readOnlyTitle
          : alphaLocked
            ? "Alpha driven by a wired input"
            : undefined;

  return (
    <div
      className="nodrag"
      title={lockTitle}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      style={{ display: "flex", alignItems: "center", gap: 4 }}
    >
      {(["H", "S", "L"] as const).map((lbl, i) => (
        <div key={lbl} style={cell(colorLocked)}>
          <HslField
            label={lbl}
            value={hsl[i]}
            max={i === 0 ? 360 : 100}
            onChange={(v) => setChannel(i as 0 | 1 | 2, v)}
            grow
          />
        </div>
      ))}
      <div style={cell(alphaLocked)}>
        <HslField
          label="A"
          value={Math.round(Math.max(0, Math.min(1, alpha)) * 100)}
          max={100}
          onChange={(v) => emit(alphaParam, Math.max(0, Math.min(100, v)) / 100)}
          grow
        />
      </div>
    </div>
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
  selected,
}: {
  color: string;
  title: string;
  onClick: () => void;
  // Palette mode (image wired) — the swatch is a readout, not an editor.
  disabled?: boolean;
  // This is the colour the body's H/S/L/A row edits. Only set when there is
  // more than one swatch to choose between, so a single-colour node never
  // wears a selection ring for a choice it doesn't offer.
  selected?: boolean;
}) {
  const [hover, setHover] = useState(false);
  // The swatch IS its colour, so hover brightens the inset ring rather than
  // the fill — nothing about the value on screen may shift. A disabled
  // swatch is inert to hover, but still shows selection: which colour the
  // H/S/L/A row points at stays meaningful in palette mode.
  const lit = selected || (hover && !disabled);
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
