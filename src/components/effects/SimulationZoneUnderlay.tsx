"use client";

import { useMemo } from "react";
import { ViewportPortal, type Node } from "@xyflow/react";
import type { NodeDataPayload } from "@/state/graph";

// Tinted rectangle rendered behind each Simulation Zone pair. The bbox
// starts as (Start ∪ End) with padding, then iteratively expands to
// include any other node whose bbox overlaps — so dropping a node
// visually between the two ends grows the zone around it. Blender's
// simulation-zone underlay works the same way: it's a purely visual
// grouping cue, with no graph-topology enforcement.
//
// Rendered via <ViewportPortal> so the rectangle lives in the same
// pan/zoom transform as the nodes themselves. pointer-events off so
// it never swallows clicks meant for the flow pane or nodes.

interface NodeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const FALLBACK_W = 220;
const FALLBACK_H = 100;
const PADDING = 24;
const MAX_EXPAND_PASSES = 8;

function nodeBox(n: Node<NodeDataPayload>): NodeBox {
  // `measured` is populated by React Flow after the node has rendered.
  // On first mount it can be undefined — use a conservative fallback
  // so the zone still draws during the initial tick.
  const w = n.measured?.width ?? n.width ?? FALLBACK_W;
  const h = n.measured?.height ?? n.height ?? FALLBACK_H;
  return { x: n.position.x, y: n.position.y, width: w, height: h };
}

function rectsOverlap(a: NodeBox, b: NodeBox): boolean {
  return !(
    a.x + a.width < b.x ||
    b.x + b.width < a.x ||
    a.y + a.height < b.y ||
    b.y + b.height < a.y
  );
}

function unionBox(a: NodeBox, b: NodeBox): NodeBox {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

function inflate(b: NodeBox, pad: number): NodeBox {
  return {
    x: b.x - pad,
    y: b.y - pad,
    width: b.width + pad * 2,
    height: b.height + pad * 2,
  };
}

interface ZoneRect {
  zoneId: string;
  bbox: NodeBox;
}

function computeZones(nodes: Node<NodeDataPayload>[]): ZoneRect[] {
  // Pair Starts and Ends by zone_id. Broken pairs (one end missing)
  // contribute no rectangle — keeps the underlay clean during half-
  // mid-creation states.
  const starts = new Map<string, Node<NodeDataPayload>>();
  const ends = new Map<string, Node<NodeDataPayload>>();
  for (const n of nodes) {
    const zid = (n.data.params?.zone_id as string | undefined) ?? "";
    if (!zid) continue;
    if (n.data.defType === "simulation-start") starts.set(zid, n);
    else if (n.data.defType === "simulation-end") ends.set(zid, n);
  }

  const out: ZoneRect[] = [];
  for (const [zid, startNode] of starts) {
    const endNode = ends.get(zid);
    if (!endNode) continue;
    let bbox = unionBox(nodeBox(startNode), nodeBox(endNode));
    // Iteratively fold in any other node whose bbox overlaps the
    // current zone bbox. Stops when a pass doesn't grow the bbox.
    // Cap at MAX_EXPAND_PASSES to avoid pathological shapes.
    for (let i = 0; i < MAX_EXPAND_PASSES; i++) {
      let grew = false;
      for (const n of nodes) {
        if (n.id === startNode.id || n.id === endNode.id) continue;
        // Skip OTHER zones' Start/End nodes — they belong to their own
        // pair's zone, not this one.
        if (
          n.data.defType === "simulation-start" ||
          n.data.defType === "simulation-end"
        ) {
          continue;
        }
        const nb = nodeBox(n);
        if (rectsOverlap(bbox, nb)) {
          const merged = unionBox(bbox, nb);
          if (
            merged.x !== bbox.x ||
            merged.y !== bbox.y ||
            merged.width !== bbox.width ||
            merged.height !== bbox.height
          ) {
            bbox = merged;
            grew = true;
          }
        }
      }
      if (!grew) break;
    }
    out.push({ zoneId: zid, bbox: inflate(bbox, PADDING) });
  }
  return out;
}

interface Props {
  nodes: Node<NodeDataPayload>[];
}

export default function SimulationZoneUnderlay({ nodes }: Props) {
  const zones = useMemo(() => computeZones(nodes), [nodes]);
  if (zones.length === 0) return null;

  return (
    <ViewportPortal>
      {zones.map((z) => (
        <div
          key={z.zoneId}
          style={{
            position: "absolute",
            left: z.bbox.x,
            top: z.bbox.y,
            width: z.bbox.width,
            height: z.bbox.height,
            // Semi-transparent purple matching the pink/violet that
            // Blender uses for its simulation-zone highlight. Kept
            // subtle so nodes remain the visual focus.
            background: "rgba(168, 85, 247, 0.08)",
            border: "1px solid rgba(168, 85, 247, 0.35)",
            borderRadius: 12,
            pointerEvents: "none",
            // Lower than React Flow's nodes (default z ≈ 1-10) so the
            // rectangle renders behind them. The ViewportPortal puts
            // us inside the transformed viewport so pan/zoom apply.
            zIndex: 0,
          }}
        />
      ))}
    </ViewportPortal>
  );
}
