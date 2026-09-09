"use client";

import { useMemo } from "react";
import { ViewportPortal, type Node } from "@xyflow/react";
import type { NodeDataPayload } from "@/state/graph";
import {
  FOREACH_TYPE,
  REPEAT_TYPE,
  isZoneInput,
  isZoneShell,
} from "@/engine/groups";

// Tinted region behind each zone shell's inline body — Iterate, Repeat,
// and For Each Element all render as zones (071926_iterate-zone-view.md).
// bbox = shell ∪ visible members, padded. Not grown to overlapping
// unrelated nodes — membership is structural (parentId).

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
  tint: string;
  bbox: NodeBox;
}

function zoneChrome(defType: string): { label: string; tint: string } {
  if (defType === REPEAT_TYPE) {
    return { label: "Repeat", tint: "var(--tb-a-cyan-400)" };
  }
  if (defType === FOREACH_TYPE) {
    return { label: "For Each", tint: "var(--tb-a-amber-400)" };
  }
  return { label: "Iterate", tint: "var(--tb-a-violet-400)" };
}

export function computeIterateZoneRects(
  nodes: Node<NodeDataPayload>[],
  excludeMemberId?: string
): IterateZoneRect[] {
  const zones: IterateZoneRect[] = [];
  for (const shell of nodes) {
    if (shell.hidden) continue;
    if (!isZoneShell(shell.data.defType)) continue;
    let bbox = nodeBox(shell);
    for (const n of nodes) {
      if (n.hidden || n.id === shell.id || n.id === excludeMemberId) continue;
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
    const input = nodes.find(
      (n) =>
        n.data.parentId === shell.id && isZoneInput(n.data.defType)
    );
    const chrome = zoneChrome(shell.data.defType);
    const count = Number(input?.data.params?.count ?? 0);
    const countLabel =
      shell.data.defType === FOREACH_TYPE
        ? ""
        : count > 0
          ? ` ×${count}`
          : "";
    zones.push({
      shellId: shell.id,
      label: `${chrome.label}${countLabel}`,
      tint: chrome.tint,
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
            background: `color-mix(in srgb, ${z.tint} 5%, transparent)`,
            border: `1px dashed color-mix(in srgb, ${z.tint} 35%, transparent)`,
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
              color: z.tint,
              opacity: 0.8,
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
