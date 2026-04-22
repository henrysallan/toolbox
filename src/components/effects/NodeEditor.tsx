"use client";

import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type EdgeChange,
  type OnConnect,
  type OnEdgesChange,
  type OnNodesChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo, useState } from "react";
import EffectNode from "./EffectNode";
import { allNodeDefs, getNodeDef } from "@/engine/registry";
import { paramSocketType, parseTargetHandleKind } from "@/state/graph";
import type { NodeDataPayload } from "@/state/graph";

interface Props {
  nodes: Node<NodeDataPayload>[];
  edges: Edge[];
  onNodesChange: OnNodesChange<Node<NodeDataPayload>>;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  onSelectNode: (id: string | null) => void;
  onAddNode: (type: string) => void;
}

export default function NodeEditor({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onSelectNode,
  onAddNode,
}: Props) {
  const nodeTypes = useMemo(() => ({ effect: EffectNode }), []);

  const isValidConnection = (c: Connection | Edge) => {
    if (!c.sourceHandle || !c.targetHandle) return false;
    const sourceNode = nodes.find((n) => n.id === c.source);
    const targetNode = nodes.find((n) => n.id === c.target);
    if (!sourceNode || !targetNode) return false;

    const srcType = resolveSourceSocketType(sourceNode, c.sourceHandle);
    const tgtType = resolveTargetSocketType(targetNode, c.targetHandle);
    if (!srcType || !tgtType) return false;

    if (srcType === tgtType) return true;
    if (srcType === "mask" && tgtType === "image") return true;
    if (srcType === "image" && tgtType === "mask") return true;
    if (srcType === "scalar" && (tgtType === "vec2" || tgtType === "vec3" || tgtType === "vec4")) return true;
    return false;
  };

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange as (c: NodeChange[]) => void}
        onEdgesChange={onEdgesChange as (c: EdgeChange[]) => void}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onSelectionChange={(sel) => {
          const first = sel.nodes[0];
          onSelectNode(first?.id ?? null);
        }}
        fitView
        proOptions={{ hideAttribution: true }}
        colorMode="dark"
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>

      <AddNodeMenu onAdd={onAddNode} />
    </div>
  );
}

function resolveSourceSocketType(
  node: Node<NodeDataPayload>,
  handle: string | null | undefined
): string | null {
  if (!handle) return null;
  if (handle === "out:primary") return node.data.primaryOutput ?? null;
  if (handle.startsWith("out:aux:")) {
    const name = handle.slice("out:aux:".length);
    return node.data.auxOutputs.find((a) => a.name === name)?.type ?? null;
  }
  return null;
}

function resolveTargetSocketType(
  node: Node<NodeDataPayload>,
  handle: string | null | undefined
): string | null {
  if (!handle) return null;
  const parsed = parseTargetHandleKind(handle);
  if (!parsed) return null;
  if (parsed.kind === "input") {
    return node.data.inputs.find((i) => i.name === parsed.name)?.type ?? null;
  }
  // Exposed-param sockets — look up the def to find the underlying param's
  // ParamType and map it to its driving SocketType.
  const def = getNodeDef(node.data.defType);
  if (!def) return null;
  const p = def.params.find((x) => x.name === parsed.name);
  if (!p) return null;
  return paramSocketType(p.type);
}

function AddNodeMenu({ onAdd }: { onAdd: (type: string) => void }) {
  const [query, setQuery] = useState("");
  const defs = allNodeDefs();

  const normalized = query.trim().toLowerCase();
  const matches = normalized
    ? defs.filter(
        (d) =>
          d.name.toLowerCase().includes(normalized) ||
          d.type.toLowerCase().includes(normalized) ||
          d.category.toLowerCase().includes(normalized)
      )
    : [];

  const byCategory: Record<string, typeof defs> = {};
  for (const d of matches) {
    (byCategory[d.category] ??= []).push(d);
  }

  function handleAdd(type: string) {
    onAdd(type);
    setQuery("");
  }

  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        left: 8,
        zIndex: 10,
        background: "#0a0a0a",
        border: "1px solid #27272a",
        borderRadius: 6,
        padding: 8,
        fontFamily: "ui-monospace, monospace",
        fontSize: 11,
        color: "#e5e7eb",
        minWidth: 180,
      }}
    >
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setQuery("");
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "Enter" && matches.length > 0) {
            handleAdd(matches[0].type);
          }
        }}
        placeholder="search nodes…"
        style={{
          width: "100%",
          background: "#18181b",
          border: "1px solid #27272a",
          borderRadius: 4,
          color: "#e5e7eb",
          fontFamily: "inherit",
          fontSize: 11,
          padding: "4px 6px",
          outline: "none",
          boxSizing: "border-box",
        }}
      />
      {normalized && (
        <div style={{ marginTop: 6 }}>
          {matches.length === 0 ? (
            <div style={{ color: "#52525b", padding: "4px 2px" }}>
              no matches
            </div>
          ) : (
            Object.entries(byCategory).map(([cat, nodes]) => (
              <div key={cat} style={{ marginTop: 4 }}>
                <div style={{ color: "#52525b", fontSize: 10 }}>{cat}</div>
                {nodes.map((def) => (
                  <button
                    key={def.type}
                    onClick={() => handleAdd(def.type)}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "3px 6px",
                      marginTop: 2,
                      background: "#18181b",
                      border: "1px solid #27272a",
                      borderRadius: 4,
                      color: "#e5e7eb",
                      fontFamily: "inherit",
                      fontSize: 11,
                      cursor: "pointer",
                    }}
                  >
                    + {def.name}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
