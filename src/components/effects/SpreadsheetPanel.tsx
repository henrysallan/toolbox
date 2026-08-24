"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Node } from "@xyflow/react";
import type { NodeDataPayload } from "@/state/graph";
import type { NodeOutput, SocketValue } from "@/engine/types";
import { tableForValue, type TableModel } from "@/engine/table-model";
import { colorForSocket } from "./socketColor";
import { ValueSummary } from "./NodeInspectorPopup";

// The Spreadsheet panel (specdocs/081326_spreadsheet-panel.md): a Blender-
// style table over the evaluated data flowing out of a node. Follows the
// selected node (primary output by default, any output via the dropdown)
// unless pinned. Rows come from engine/table-model.ts; values that don't
// project fall back to the shared ValueSummary line.
//
// Data path is the peek popover's: EffectsApp keeps this panel's target in
// a ref merged into evaluateGraph's extraTargets/extraConsumed (so a
// disconnected or consumption-gated socket still produces data), and the
// panel POLLS the eval cache — PerfPanel's reasoning: never re-render a
// grid at frame rate. Value-object identity is the change signal (cache
// hits return the same object; a recompute mints a new one).
//
// State is derived, never effect-synced (React 19 hooks rules): the
// dropdown choice remembers WHICH node it was made on and simply stops
// applying when selection moves, and the polled snapshot carries its
// target key so a stale value for the previous target never renders.

export interface SpreadsheetTarget {
  nodeId: string;
  handle: string; // "out:primary" | "out:aux:<name>" — the peek grammar
}

const ROW_H = 18;
const OVERSCAN = 10;
const POLL_MS = 300;
const INDEX_W = 64;
const NUM_W = 78;
const TEXT_W = 150;

interface OutputOption {
  handle: string;
  label: string;
  type: string;
}

// The node's pickable outputs, from the payload's already-resolved socket
// lists (EffectNode renders its handles from the same fields).
function outputOptions(data: NodeDataPayload): OutputOption[] {
  const opts: OutputOption[] = [];
  if (data.primaryOutput) {
    opts.push({
      handle: "out:primary",
      label: "primary",
      type: data.primaryOutput,
    });
  }
  for (const aux of data.auxOutputs) {
    if (aux.disabled) continue;
    opts.push({
      handle: `out:aux:${aux.name}`,
      label: aux.label ?? aux.name,
      type: aux.type,
    });
  }
  return opts;
}

// Compact cell rendering: up to 4 decimals, no trailing zeros, exponential
// for extremes (the inspector's formatNumber convention).
function fmtCell(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  if (Math.abs(n) >= 10000 || (Math.abs(n) < 0.001 && n !== 0)) {
    return n.toExponential(3);
  }
  return n.toFixed(4).replace(/\.?0+$/, "") || "0";
}

interface Snap {
  key: string; // the target key this snapshot belongs to
  value: SocketValue | undefined;
  evaluated: boolean;
}

export default function SpreadsheetPanel({
  leafId,
  kindMenu,
  nodes,
  selectedId,
  canvasRes,
  readOutput,
  onTargetChange,
}: {
  leafId: string;
  kindMenu?: React.ReactNode;
  nodes: readonly Node<NodeDataPayload>[];
  selectedId: string | null;
  canvasRes: readonly [number, number];
  /** Read a node's latest evaluated output (eval cache → last-outputs). */
  readOutput: (nodeId: string) => NodeOutput | undefined;
  /**
   * Report this panel's effective target so the render loop keeps it
   * force-evaluated (extraTargets/extraConsumed). null on unmount.
   */
  onTargetChange: (leafId: string, target: SpreadsheetTarget | null) => void;
}) {
  const [pinned, setPinned] = useState<SpreadsheetTarget | null>(null);
  // The dropdown pick, tagged with the node it was made on — it applies
  // only while that node is still the followed one, so following a new
  // node lands back on primary with no reset effect.
  const [handleChoice, setHandleChoice] = useState<{
    nodeId: string;
    handle: string;
  } | null>(null);
  const [units, setUnits] = useState<"normalized" | "pixels">("normalized");
  const [snap, setSnap] = useState<Snap | null>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const followedId = pinned ? pinned.nodeId : selectedId;
  const node = useMemo(
    () => (followedId ? nodes.find((n) => n.id === followedId) : undefined),
    [nodes, followedId]
  );
  const options = node ? outputOptions(node.data) : [];

  // Effective handle: the pin's, else the remembered choice if it was made
  // on this node and the node still offers it (params can retire an aux),
  // else primary.
  const wanted = pinned
    ? pinned.handle
    : handleChoice && handleChoice.nodeId === followedId
      ? handleChoice.handle
      : "out:primary";
  const handle = options.some((o) => o.handle === wanted)
    ? wanted
    : "out:primary";
  const targetNodeId = node && options.length > 0 ? node.id : null;
  const targetKey = targetNodeId ? `${targetNodeId} ${handle}` : null;

  // Keep the render loop's forced-target map current, and nudge a paused
  // editor into one eval so a fresh target shows data immediately.
  useEffect(() => {
    onTargetChange(
      leafId,
      targetNodeId ? { nodeId: targetNodeId, handle } : null
    );
    if (targetNodeId) window.dispatchEvent(new Event("pipeline-bump"));
  }, [leafId, targetNodeId, handle, onTargetChange]);
  useEffect(
    () => () => onTargetChange(leafId, null),
    [leafId, onTargetChange]
  );

  // Poll the eval cache (identity-guarded). First tick on the next frame,
  // a quick follow-up to catch the pipeline-bump eval, then the steady
  // interval. All ticks are async — no setState in the effect body.
  useEffect(() => {
    if (!targetNodeId) return;
    const key = `${targetNodeId} ${handle}`;
    const tick = () => {
      const out = readOutput(targetNodeId);
      const value =
        handle === "out:primary"
          ? out?.primary
          : out?.aux?.[handle.slice("out:aux:".length)];
      setSnap((prev) =>
        prev &&
        prev.key === key &&
        prev.value === value &&
        prev.evaluated === !!out
          ? prev
          : { key, value, evaluated: !!out }
      );
    };
    const first = requestAnimationFrame(tick);
    const catchUp = window.setTimeout(tick, 120);
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelAnimationFrame(first);
      window.clearTimeout(catchUp);
      window.clearInterval(id);
    };
  }, [targetNodeId, handle, readOutput]);

  // A snapshot only counts for the target it was read for — switching
  // targets renders the loading state, never the previous node's rows.
  const live = snap && snap.key === targetKey ? snap : null;
  const liveValue = live?.value;
  const model = useMemo(() => tableForValue(liveValue), [liveValue]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);
  // Snap the viewport back for a new target — through the DOM only; the
  // scroll event it fires updates the state.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && el.scrollTop !== 0) el.scrollTop = 0;
  }, [targetKey]);

  const hasSpaceCols = !!model?.columns.some((c) => c.space);
  const pinActive = !!pinned;
  const nodeLabel = node
    ? ((node.data.displayName ?? node.data.name) as string)
    : pinned
      ? "(node deleted)"
      : "no selection";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        background: "var(--tb-bg)",
        color: "var(--tb-ink)",
        fontSize: 11,
      }}
    >
      {/* header — the kind chip rides inline, PerfPanel-style */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 6px",
          borderBottom: "1px solid var(--tb-border)",
          flex: "0 0 auto",
          minWidth: 0,
        }}
      >
        {kindMenu}
        <span
          title={node ? `${node.data.name} (${node.id})` : undefined}
          style={{
            color: node ? "var(--tb-ink-hi)" : "var(--tb-ink-muted)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            flex: "0 1 auto",
          }}
        >
          {nodeLabel}
        </span>
        {node && options.length > 0 && (
          <select
            value={handle}
            onChange={(e) => {
              const next = e.target.value;
              if (pinned) setPinned({ nodeId: pinned.nodeId, handle: next });
              else if (followedId)
                setHandleChoice({ nodeId: followedId, handle: next });
            }}
            style={{
              background: "var(--tb-n-2)",
              color: "var(--tb-ink)",
              border: "1px solid var(--tb-border)",
              borderRadius: 3,
              fontSize: 10,
              padding: "1px 3px",
              maxWidth: 130,
            }}
          >
            {options.map((o) => (
              <option key={o.handle} value={o.handle}>
                {o.label} ({o.type})
              </option>
            ))}
          </select>
        )}
        {node && options.length > 0 && (
          <span
            aria-hidden
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              flexShrink: 0,
              background: colorForSocket(
                options.find((o) => o.handle === handle)?.type ?? ""
              ),
            }}
          />
        )}
        <button
          type="button"
          title={
            pinActive
              ? "Unpin — follow the selected node again"
              : "Pin this node + socket (stop following selection)"
          }
          onClick={() =>
            setPinned(
              pinActive
                ? null
                : targetNodeId
                  ? { nodeId: targetNodeId, handle }
                  : null
            )
          }
          disabled={!pinActive && !targetNodeId}
          style={{
            padding: "1px 7px",
            fontSize: 10,
            borderRadius: 3,
            border: "1px solid var(--tb-border)",
            background: pinActive ? "var(--tb-a-blue-500)" : "var(--tb-n-2)",
            color: pinActive ? "var(--tb-n-0)" : "var(--tb-ink)",
            cursor: !pinActive && !targetNodeId ? "default" : "pointer",
            flexShrink: 0,
          }}
        >
          pin
        </button>
        {hasSpaceCols && (
          <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
            {(["normalized", "pixels"] as const).map((u) => (
              <button
                key={u}
                type="button"
                title={
                  u === "pixels"
                    ? "Positions × canvas size (x × width, y × height)"
                    : "Authored space — normalized [0,1]², y down"
                }
                onClick={() => setUnits(u)}
                style={{
                  padding: "1px 7px",
                  fontSize: 10,
                  borderRadius: 3,
                  border: "1px solid var(--tb-border)",
                  background:
                    units === u ? "var(--tb-a-blue-500)" : "var(--tb-n-2)",
                  color: units === u ? "var(--tb-n-0)" : "var(--tb-ink)",
                  cursor: "pointer",
                }}
              >
                {u === "normalized" ? "norm" : "px"}
              </button>
            ))}
          </div>
        )}
        <span
          style={{
            marginLeft: "auto",
            color: "var(--tb-ink-muted)",
            fontSize: 10,
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          {model
            ? `${model.rowCount.toLocaleString()} row${model.rowCount === 1 ? "" : "s"}`
            : ""}
        </span>
      </div>

      {model ? (
        <Grid
          model={model}
          units={units}
          canvasRes={canvasRes}
          scrollTop={scrollTop}
          scrollRef={scrollRef}
          onScroll={onScroll}
        />
      ) : (
        <div
          style={{
            padding: 10,
            color: "var(--tb-ink-muted)",
            fontFamily: "var(--code-font)",
            fontSize: 10,
            lineHeight: 1.6,
          }}
        >
          {!followedId ? (
            "Select a node to inspect its data."
          ) : !node ? (
            "The pinned node no longer exists — unpin to follow selection."
          ) : options.length === 0 ? (
            "(no outputs)"
          ) : !live || !live.evaluated ? (
            // The peek popover's known gaps apply here too: group boundary
            // nodes and Iterate members never evaluate under their own id.
            "(not evaluated)"
          ) : live.value === undefined ? (
            "— (empty output)"
          ) : (
            <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
              <ValueSummary value={live.value} />
              <span style={{ color: "var(--tb-n-10)" }}>
                (no table view for this type)
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// The virtualized grid: a spacer div carries the full scroll height, only
// the visible row window (+overscan) renders — 100k-point values stay a
// ~40-row render. Header sticks inside the same scroll container so
// horizontal scroll moves it with the columns.
function Grid({
  model,
  units,
  canvasRes,
  scrollTop,
  scrollRef,
  onScroll,
}: {
  model: TableModel;
  units: "normalized" | "pixels";
  canvasRes: readonly [number, number];
  scrollTop: number;
  scrollRef: React.MutableRefObject<HTMLDivElement | null>;
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void;
}) {
  const [viewH, setViewH] = useState(400);
  const px = units === "pixels";

  // Track the visible height so the row window matches the real panel.
  // RO callbacks are async — no setState in the effect body itself.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollRef]);

  const cols = model.columns;
  const widths = cols.map((c) =>
    c.kind === "index" ? INDEX_W : c.kind === "text" ? TEXT_W : NUM_W
  );
  const template = widths
    .map((w, i) =>
      // Text columns flex to swallow spare width; numeric stay fixed.
      cols[i].kind === "text" ? `minmax(${w}px, 1fr)` : `${w}px`
    )
    .join(" ");
  const minW = widths.reduce((a, b) => a + b, 0);

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(
    model.rowCount,
    Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN
  );
  const rows: React.ReactNode[] = [];
  for (let r = first; r < last; r++) {
    rows.push(
      <div
        key={r}
        style={{
          position: "absolute",
          top: r * ROW_H,
          left: 0,
          right: 0,
          height: ROW_H,
          display: "grid",
          gridTemplateColumns: template,
          alignItems: "center",
          borderBottom: "1px solid var(--tb-n-3)",
          background: r % 2 ? "var(--tb-n-1)" : "transparent",
        }}
      >
        {cols.map((c, ci) => {
          const raw = c.get(r);
          if (c.kind === "color" && typeof raw === "string") {
            return (
              <div
                key={c.key}
                title={raw}
                style={{
                  padding: "0 8px",
                  display: "flex",
                  alignItems: "center",
                  borderLeft: ci > 0 ? "1px solid var(--tb-n-3)" : undefined,
                }}
              >
                <span
                  style={{
                    width: 26,
                    height: 10,
                    borderRadius: 2,
                    background: raw,
                    border: "1px solid var(--tb-n-6)",
                  }}
                />
              </div>
            );
          }
          let text: string;
          let muted = false;
          if (raw === null) {
            text = "–";
            muted = true;
          } else if (typeof raw === "string") {
            text = raw;
          } else if (c.kind === "angle") {
            text = `${fmtCell((raw * 180) / Math.PI)}°`;
          } else if (px && c.space) {
            text = fmtCell(
              raw * (c.space === "norm-x" ? canvasRes[0] : canvasRes[1])
            );
          } else {
            text = fmtCell(raw);
          }
          return (
            <div
              key={c.key}
              style={{
                padding: "0 8px",
                textAlign:
                  c.kind === "index" || c.kind === "text" ? "left" : "right",
                fontVariantNumeric: "tabular-nums",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                color: muted
                  ? "var(--tb-ink-disabled)"
                  : c.kind === "index"
                    ? "var(--tb-ink-muted)"
                    : "var(--tb-ink-hi)",
                borderLeft: ci > 0 ? "1px solid var(--tb-n-3)" : undefined,
              }}
              title={c.kind === "text" ? text : undefined}
            >
              {text}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      style={{
        flex: 1,
        minHeight: 0,
        overflow: "auto",
        fontFamily: "var(--code-font)",
        fontSize: 10,
      }}
    >
      <div style={{ minWidth: minW, position: "relative" }}>
        <div
          style={{
            position: "sticky",
            top: 0,
            zIndex: 1,
            display: "grid",
            gridTemplateColumns: template,
            height: ROW_H + 2,
            alignItems: "center",
            background: "var(--tb-n-0)",
            borderBottom: "1px solid var(--tb-border)",
            color: "var(--tb-ink-muted)",
          }}
        >
          {cols.map((c, ci) => (
            <div
              key={c.key}
              style={{
                padding: "0 8px",
                textAlign:
                  c.kind === "number" || c.kind === "angle" ? "right" : "left",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                borderLeft: ci > 0 ? "1px solid var(--tb-n-3)" : undefined,
              }}
            >
              {c.label}
              {c.kind === "angle" ? " (°)" : ""}
            </div>
          ))}
        </div>
        <div style={{ position: "relative", height: model.rowCount * ROW_H }}>
          {rows}
        </div>
      </div>
    </div>
  );
}
