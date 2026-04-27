"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { getNodeDef } from "@/engine/registry";
import { paramSocketType } from "@/state/graph";
import type { NodeDataPayload } from "@/state/graph";
import type { SocketType } from "@/engine/types";
import { colorForSocket } from "./socketColor";

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

export default function EffectNode({
  id,
  data,
  selected,
}: NodeProps<EffectNodeType>) {
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

  const inputs = data.inputs;
  const auxes = data.auxOutputs;
  const hasPrimary = !!data.primaryOutput;

  // Resolve exposed-param sockets by pulling current def info. Only params
  // whose type maps to a data socket (scalar/vec*/color/bool) produce a
  // socket; anything else silently drops.
  const exposedSockets: ExposedSocket[] = useMemo(() => {
    const def = getNodeDef(data.defType);
    if (!def) return [];
    const names = data.exposedParams ?? [];
    const out: ExposedSocket[] = [];
    for (const name of names) {
      const p = def.params.find((x) => x.name === name);
      if (!p) continue;
      const st = paramSocketType(p.type);
      if (!st) continue;
      out.push({ name, label: p.label ?? p.name, socketType: st });
    }
    return out;
  }, [data.defType, data.exposedParams]);

  const leftRows = inputs.length + exposedSockets.length;
  const rightRows = (hasPrimary ? 1 : 0) + auxes.length;
  const maxRows = Math.max(leftRows, rightRows, 1);
  const bodyH = maxRows * ROW_H + PAD_Y * 2;
  const active = !!data.active;
  const active2 = !!data.active2;
  const bypassed = !!data.bypassed;

  const dispatch = (kind: "toggleActive" | "toggleActive2" | "toggleBypass") => {
    window.dispatchEvent(
      new CustomEvent("effect-node-toggle", { detail: { id, kind } })
    );
  };

  return (
    <div
      style={{
        minWidth: 200,
        background: "#18181b",
        border: `1px solid ${selected ? "#60a5fa" : data.error ? "#ef4444" : "#3f3f46"}`,
        borderRadius: 6,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        fontSize: 11,
        color: "#e5e7eb",
        opacity: bypassed ? 0.5 : 1,
        boxShadow: selected
          ? "0 0 0 1px rgba(96,165,250,0.3)"
          : "0 2px 8px rgba(0,0,0,0.4)",
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
          {data.name}
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
          {viewportSplit && (
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
          <HeaderToggle
            on={bypassed}
            label="B"
            title={bypassed ? "Bypassed" : "Bypass (pass through)"}
            activeBg="#b45309"
            activeFg="#fef3c7"
            onClick={() => dispatch("toggleBypass")}
          />
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
                  background={colorForSocket(input.type)}
                  border="1px solid #0a0a0a"
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
                <span style={{ color: "#a1a1aa" }}>
                  {input.label ?? input.name}
                </span>
                <span
                  style={{ color: colorForSocket(input.type), fontSize: 9 }}
                >
                  {input.type}
                </span>
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
          return (
            <Fragment key={`aux-${aux.name}`}>
              <Handle
                type="source"
                id={`out:aux:${aux.name}`}
                position={Position.Right}
                isConnectable={!disabled}
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
                    disabled ? "#27272a" : colorForSocket(aux.type)
                  }
                  border={
                    disabled ? "1px dashed #52525b" : "1px solid #0a0a0a"
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
                <span
                  style={{
                    color: disabled ? "#52525b" : colorForSocket(aux.type),
                    fontSize: 9,
                  }}
                >
                  {aux.type}
                </span>
                <span style={{ color: "#71717a" }}>{aux.name}</span>
              </div>
            </Fragment>
          );
        })}
      </div>

      {data.defType === "output" && (
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
            label="Video"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent("effect-node-export", {
                  detail: { id, kind: "video" },
                })
              )
            }
          />
        </div>
      )}
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
