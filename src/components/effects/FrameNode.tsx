"use client";

import { memo, useRef, useState } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import type { NodeDataPayload } from "@/state/graph";
import { FRAME_TYPE } from "@/engine/graph-helpers";
import { ITERATE_TYPE } from "@/engine/groups";
import { FRAME_NEUTRAL, tintRgba } from "./node-tints";

// Blender-style frame zone (073026_node-cosmetics-and-frames.md): a shaded
// rect behind its member nodes. The frame is a real xyflow node — its
// wrapper is click-through (FRAME_XY_PROPS sets pointerEvents: none, z -1)
// and only the edge bands + label chip below re-enable pointer events, all
// tagged `.frame-drag-handle` so React Flow starts drags exclusively from
// them; the interior stays free for marquee/pane gestures and the nodes on
// top. NodeEditor's zone-drag replay moves the members with the frame, and
// EffectsApp reconciles position + uiWidth/uiHeight to `computeFrameRects`
// so the box hugs its members as they move.
//
// `computeFrameRects` is shared with NodeEditor's drag-stop membership
// hit-test — same contract as computeIterateZoneRects: "visually inside"
// and "joins on drop" are the same rectangle by construction, and
// `excludeMemberId` lets a dragged member actually leave (the union bbox
// would otherwise follow it).

type FrameNodeType = Node<NodeDataPayload, "frame">;

interface NodeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const FALLBACK_W = 220;
const FALLBACK_H = 100;
export const FRAME_DEFAULT_W = 320;
export const FRAME_DEFAULT_H = 200;
export const FRAME_PADDING = 28;
// Grabbable border strip width. Wider than the drawn border so the edges
// are comfortable to hit at low zoom.
const EDGE_BAND = 10;

function nodeBox(n: Node<NodeDataPayload>): NodeBox {
  const w = n.measured?.width ?? n.width ?? FALLBACK_W;
  const h = n.measured?.height ?? n.height ?? FALLBACK_H;
  return { x: n.position.x, y: n.position.y, width: w, height: h };
}

function unionBox(a: NodeBox, b: NodeBox): NodeBox {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

// A frame's members: nodes pointing at it via data.frameId that are its
// same-scope siblings (frame membership never crosses parentId scopes),
// plus one hop of zone expansion — an Iterate shell member brings its
// inline zone members along, so the rect fits (and a frame drag moves)
// the whole zone. Groups/layers don't expand: their interiors live in a
// different coordinate scope and are never co-visible.
export function collectFrameMemberIds(
  nodes: Node<NodeDataPayload>[],
  frameId: string
): Set<string> {
  const frame = nodes.find((n) => n.id === frameId);
  const members = new Set<string>();
  if (!frame) return members;
  for (const n of nodes) {
    if (n.hidden || n.id === frameId) continue;
    if (n.data.defType === FRAME_TYPE) continue;
    if (n.data.frameId !== frameId) continue;
    if (n.data.parentId !== frame.data.parentId) continue;
    members.add(n.id);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    if (n.hidden || members.has(n.id)) continue;
    const p = n.data.parentId ? byId.get(n.data.parentId) : undefined;
    if (p && p.data.defType === ITERATE_TYPE && members.has(p.id)) {
      members.add(n.id);
    }
  }
  return members;
}

export interface FrameRect {
  frameId: string;
  // The frame node's scope — drop-in hit-tests only offer frames that are
  // siblings of the dragged node.
  parentId: string | undefined;
  bbox: NodeBox;
}

export function computeFrameRects(
  nodes: Node<NodeDataPayload>[],
  excludeMemberId?: string
): FrameRect[] {
  const rects: FrameRect[] = [];
  for (const frame of nodes) {
    if (frame.hidden || frame.data.defType !== FRAME_TYPE) continue;
    const memberIds = collectFrameMemberIds(nodes, frame.id);
    if (excludeMemberId) memberIds.delete(excludeMemberId);
    let bbox: NodeBox | null = null;
    for (const n of nodes) {
      if (!memberIds.has(n.id)) continue;
      const b = nodeBox(n);
      bbox = bbox ? unionBox(bbox, b) : b;
    }
    // With members the frame's OWN box is deliberately excluded from the
    // union so the rect shrinks back around them (Blender shrink-to-fit);
    // an empty frame keeps its stored box.
    rects.push({
      frameId: frame.id,
      parentId: frame.data.parentId,
      bbox: bbox
        ? {
            x: bbox.x - FRAME_PADDING,
            y: bbox.y - FRAME_PADDING,
            width: bbox.width + FRAME_PADDING * 2,
            height: bbox.height + FRAME_PADDING * 2,
          }
        : {
            x: frame.position.x,
            y: frame.position.y,
            width: frame.data.uiWidth ?? FRAME_DEFAULT_W,
            height: frame.data.uiHeight ?? FRAME_DEFAULT_H,
          },
    });
  }
  return rects;
}

function FrameNode({ id, data, selected }: NodeProps<FrameNodeType>) {
  const [editing, setEditing] = useState(false);
  // Pointer travel between down and click on the label tells a clean
  // click (→ edit) apart from the tail of a label-drag (→ nothing).
  const labelDownRef = useRef<{ x: number; y: number } | null>(null);
  const tint = data.tint ?? FRAME_NEUTRAL;
  const w = data.uiWidth ?? FRAME_DEFAULT_W;
  const h = data.uiHeight ?? FRAME_DEFAULT_H;

  const commitLabel = (raw: string) => {
    setEditing(false);
    const name = raw.trim();
    if (!name || name === data.name) return;
    window.dispatchEvent(
      new CustomEvent("effect-node-rename", { detail: { id, name } })
    );
  };

  const band = (edge: "top" | "bottom" | "left" | "right") => (
    <div
      key={edge}
      className="frame-drag-handle"
      style={{
        position: "absolute",
        ...(edge === "top" || edge === "bottom"
          ? { left: 0, right: 0, height: EDGE_BAND }
          : { top: 0, bottom: 0, width: EDGE_BAND }),
        ...(edge === "top" ? { top: 0 } : {}),
        ...(edge === "bottom" ? { bottom: 0 } : {}),
        ...(edge === "left" ? { left: 0 } : {}),
        ...(edge === "right" ? { right: 0 } : {}),
        pointerEvents: "auto",
        cursor: "move",
      }}
    />
  );

  return (
    <div
      style={{
        width: w,
        height: h,
        position: "relative",
        pointerEvents: "none",
        fontFamily: "var(--ui-font)",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: tintRgba(tint, selected ? 0.09 : 0.06),
          border: `${data.bold ? 3 : 1.5}px solid ${
            selected ? "var(--tb-a-blue-400)" : tintRgba(tint, 0.5)
          }`,
          borderRadius: 10,
          transition: "border-color 140ms ease, background 140ms ease",
        }}
      />
      {band("top")}
      {band("bottom")}
      {band("left")}
      {band("right")}
      {editing ? (
        <input
          className="nodrag nopan"
          autoFocus
          defaultValue={data.name || "Frame"}
          onFocus={(e) => e.currentTarget.select()}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commitLabel(e.currentTarget.value);
            else if (e.key === "Escape") setEditing(false);
          }}
          onBlur={(e) => commitLabel(e.currentTarget.value)}
          style={{
            position: "absolute",
            top: 5,
            left: 8,
            width: Math.max(80, Math.min(220, w - 24)),
            pointerEvents: "auto",
            background: "var(--tb-n-3)",
            border: "1px solid var(--tb-n-9)",
            borderRadius: 3,
            color: "var(--tb-n-16)",
            fontSize: 11,
            fontFamily: "inherit",
            padding: "1px 5px",
            outline: "none",
          }}
        />
      ) : (
        <span
          className="frame-drag-handle"
          title="Click to rename; drag to move the frame"
          onPointerDown={(e) => {
            labelDownRef.current = { x: e.clientX, y: e.clientY };
          }}
          onClick={(e) => {
            const d = labelDownRef.current;
            labelDownRef.current = null;
            if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 3) return;
            setEditing(true);
          }}
          style={{
            position: "absolute",
            top: 6,
            left: 10,
            maxWidth: Math.max(60, w - 24),
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            pointerEvents: "auto",
            cursor: "move",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0.3,
            color: tintRgba(tint, 0.95),
            userSelect: "none",
          }}
        >
          {data.name || "Frame"}
        </span>
      )}
    </div>
  );
}

export default memo(FrameNode);
