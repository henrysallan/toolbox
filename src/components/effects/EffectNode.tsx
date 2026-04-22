"use client";

import { Fragment, useMemo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { getNodeDef } from "@/engine/registry";
import { paramSocketType } from "@/state/graph";
import type { NodeDataPayload } from "@/state/graph";
import type { SocketType } from "@/engine/types";
import { colorForSocket } from "./socketColor";

type EffectNodeType = Node<NodeDataPayload, "effect">;

const ROW_H = 22;
const PAD_Y = 8;
const HANDLE_SIZE = 10;

interface ExposedSocket {
  name: string;
  label: string;
  socketType: SocketType;
}

export default function EffectNode({
  id,
  data,
  selected,
}: NodeProps<EffectNodeType>) {
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
  const bypassed = !!data.bypassed;

  const dispatch = (kind: "toggleActive" | "toggleBypass") => {
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
      }}
    >
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
        <span style={{ fontWeight: 600, letterSpacing: 0.3 }}>{data.name}</span>
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
            label="A"
            title={active ? "Active (viewed)" : "Set active (view on canvas)"}
            activeBg="#047857"
            activeFg="#d1fae5"
            onClick={() => dispatch("toggleActive")}
          />
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
                  width: HANDLE_SIZE,
                  height: HANDLE_SIZE,
                  background: colorForSocket(input.type),
                  border: "1px solid #0a0a0a",
                }}
              />
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
                  width: HANDLE_SIZE - 2,
                  height: HANDLE_SIZE - 2,
                  background: colorForSocket(ex.socketType),
                  border: "1px dashed #52525b",
                  borderRadius: 2,
                }}
              />
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
                width: HANDLE_SIZE + 2,
                height: HANDLE_SIZE + 2,
                background: colorForSocket(data.primaryOutput!),
                border: "1px solid #0a0a0a",
              }}
            />
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
          return (
            <Fragment key={`aux-${aux.name}`}>
              <Handle
                type="source"
                id={`out:aux:${aux.name}`}
                position={Position.Right}
                style={{
                  top: handleCenter,
                  width: HANDLE_SIZE,
                  height: HANDLE_SIZE,
                  background: colorForSocket(aux.type),
                  border: "1px solid #0a0a0a",
                }}
              />
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
                }}
              >
                <span style={{ color: colorForSocket(aux.type), fontSize: 9 }}>
                  {aux.type}
                </span>
                <span style={{ color: "#71717a" }}>{aux.name}</span>
              </div>
            </Fragment>
          );
        })}
      </div>
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
