"use client";

import { useMemo } from "react";
import { ViewportPortal, type Node } from "@xyflow/react";
import type { NodeDataPayload } from "@/state/graph";
import { ITERATE_INPUT_TYPE, ITERATE_TYPE } from "@/engine/groups";

// Tinted region behind each Iterate shell's inline body — an Iterate is
// simply a zone, always rendered inline (071926_iterate-zone-view.md).
// Unlike SimulationZoneUnderlay this does NOT grow to overlapping nodes
// — Iterate membership is structural (parentId), and an unrelated node
// dragged across the zone must not look captured. bbox = shell ∪
// visible members, padded.
//
// `computeIterateZoneRects` is shared with NodeEditor's drag-stop
// reparent hit-test so "visually inside the zone" and "reparents into
// the zone" are the same rectangle by construction.
//
// Rendered via <ViewportPortal> so the rect lives in the nodes'
// pan/zoom transform; pointer-events off so it never swallows clicks.

interface NodeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const FALLBACK_W = 220;
const FALLBACK_H = 100;
const PADDING = 28;

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

export interface IterateZoneRect {
  shellId: string;
  label: string;
  bbox: NodeBox;
}

// `excludeMemberId` drops one member from every bbox — the drag-stop
// hit-test uses it so a member being dragged can actually LEAVE its
// zone (otherwise the rect follows the node, since bbox = members'
// union). Rendering passes nothing.
export function computeIterateZoneRects(
  nodes: Node<NodeDataPayload>[],
  excludeMemberId?: string
): IterateZoneRect[] {
  const zones: IterateZoneRect[] = [];
  for (const shell of nodes) {
    if (shell.hidden) continue;
    if (shell.data.defType !== ITERATE_TYPE) continue;
    let bbox = nodeBox(shell);
    for (const n of nodes) {
      if (n.hidden || n.id === shell.id || n.id === excludeMemberId) continue;
      // Direct members plus nested-expanded descendants (their parent
      // chain reaches this shell through visible nodes).
      let cur = n.data.parentId;
      let member = false;
      for (let hops = 0; cur && hops < nodes.length; hops++) {
        if (cur === shell.id) {
          member = true;
          break;
        }
        const p = nodes.find((x) => x.id === cur);
        if (!p || p.hidden) break;
        cur = p.data.parentId;
      }
      if (member) bbox = unionBox(bbox, nodeBox(n));
    }
    // The loop count lives on the zone's Iteration Input member.
    const input = nodes.find(
      (n) =>
        n.data.defType === ITERATE_INPUT_TYPE &&
        n.data.parentId === shell.id
    );
    const count = Number(input?.data.params?.count ?? 0);
    zones.push({
      shellId: shell.id,
      label: `Iterate${count > 0 ? ` ×${count}` : ""}`,
      bbox: {
        x: bbox.x - PADDING,
        y: bbox.y - PADDING,
        width: bbox.width + PADDING * 2,
        height: bbox.height + PADDING * 2,
      },
    });
  }
  return zones;
}

export default function IterateZoneUnderlay({
  nodes,
}: {
  nodes: Node<NodeDataPayload>[];
}) {
  const zones = useMemo(() => computeIterateZoneRects(nodes), [nodes]);
  if (zones.length === 0) return null;
  return (
    <ViewportPortal>
      {zones.map((z) => (
        <div
          key={z.shellId}
          style={{
            position: "absolute",
            left: z.bbox.x,
            top: z.bbox.y,
            width: z.bbox.width,
            height: z.bbox.height,
            background: "color-mix(in srgb, var(--tb-a-violet-400) 5%, transparent)",
            border: "1px dashed color-mix(in srgb, var(--tb-a-violet-400) 35%, transparent)",
            borderRadius: 10,
            pointerEvents: "none",
            zIndex: -1,
          }}
        >
          <span
            style={{
              position: "absolute",
              top: 4,
              left: 8,
              fontSize: 10,
              letterSpacing: 0.4,
              color: "rgba(196, 181, 253, 0.8)",
              userSelect: "none",
            }}
          >
            {z.label}
          </span>
        </div>
      ))}
    </ViewportPortal>
  );
}
