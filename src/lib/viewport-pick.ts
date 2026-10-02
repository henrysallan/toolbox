// Viewport pick-select: which source nodes drew the pixel under the cursor?
//
// Nothing in the engine records provenance — images are bare textures — so
// this infers it from the last frame's per-node outputs. Starting at the
// node whose image is on the canvas, walk BACKWARD along content edges;
// follow an edge only when its source's value covers the clicked point
// (image/mask: alpha at that pixel; spline: padded bounds), and collect
// every `pickable` node reached. Inputs are visited top-of-stack first
// (Merge's last layer before its base, a Layer's content before the stack
// below it), so the hit list reads topmost → bottommost and repeated clicks
// cycle down through what is stacked there.
//
// Correct through anything that leaves pixels where they are (Blur, color
// grades, Merge, Layer, masks). NOT through nodes that move pixels
// (Transform on images, Displace, Polar Coords): the input is sampled at the
// output's pixel, so a moved source usually reads transparent there and
// simply drops out rather than being credited wrongly.
//
// Pure: the caller supplies the flattened graph, the last eval's outputs,
// and the alpha sampler (EffectsApp does the GPU readback).

import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type {
  ImageValue,
  MaskValue,
  NodeOutput,
  SocketValue,
  SplineValue,
} from "@/engine/types";
import { aspectUncorrectY } from "@/engine/aspect";

// Alpha at or below this counts as empty — straight-alpha AA fringes and
// 8-bit readback noise sit well under it.
export const PICK_ALPHA_THRESHOLD = 0.04;

// Spline bounds padding in canvas01 (width) units. Bounds are anchor-only
// (bézier bulge and stroke width sit outside them); the consuming raster
// already confirmed coverage at the pixel, so this is a coarse reject.
const SPLINE_PAD = 0.03;

// Value kinds that carry drawable content. Everything else (scalars,
// vectors, strings, audio, UV fields, ramps…) drives parameters, never
// appears on the canvas itself, and is not walked.
const CONTENT_KINDS = new Set<string>([
  "image",
  "mask",
  "spline",
  "points",
  "image_group",
  "list",
  "text_instance",
  "sdf",
  "element",
]);

export interface PickArgs {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  outputs: ReadonlyMap<string, NodeOutput>;
  // Node whose image is on the canvas (EvalResult.terminalImage.nodeId).
  startNodeId: string;
  // Click point, per-axis [0,1] of the canvas, Y-DOWN (DOM pointer space).
  u: number;
  v: number;
  // Canvas width / height — maps the click into authored spline space.
  aspect: number;
  isPickable: (type: string) => boolean;
  // Coverage (0..1) of an image/mask at the click point, or null when it
  // cannot be read (treated as covered: never lose a hit to a failed read).
  sampleAlpha: (value: ImageValue | MaskValue) => number | null;
}

/** Pickable node ids under the point, topmost first. */
export function pickNodesAt(args: PickArgs): string[] {
  const { nodes, edges, outputs, u, v, aspect, isPickable, sampleAlpha } =
    args;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const inbound = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    const list = inbound.get(e.target);
    if (list) list.push(e);
    else inbound.set(e.target, [e]);
  }
  const px = u;
  const py = aspectUncorrectY(v, aspect);

  const covers = (value: SocketValue): boolean => {
    if (value.kind === "image" || value.kind === "mask") {
      const a = sampleAlpha(value);
      return a == null || a > PICK_ALPHA_THRESHOLD;
    }
    if (value.kind === "spline") return splineNear(value, px, py);
    // Points / SDF ASTs / instances / elements: no cheap CPU coverage test.
    // Their consumer's raster already covered this pixel, so pass.
    return true;
  };

  const hits: string[] = [];
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    const node = byId.get(id);
    if (!node) return;
    if (!node.bypassed && isPickable(node.type)) hits.push(id);
    for (const e of orderTopFirst(node, inbound.get(id) ?? [])) {
      if (!isContentSocket(e.targetHandle)) continue;
      const value = outputValue(outputs.get(e.source), e.sourceHandle);
      if (!value || !CONTENT_KINDS.has(value.kind)) continue;
      if (covers(value)) visit(e.source);
    }
  };
  visit(args.startNodeId);
  return hits;
}

/**
 * Click-to-cycle: a click near the previous one (same hit list) steps to
 * the next hit; anything else starts again at the topmost.
 */
export interface PickCycle {
  x: number; // client px of the click that produced this state
  y: number;
  hits: string[];
  index: number;
}

export function advancePickCycle(
  prev: PickCycle | null,
  x: number,
  y: number,
  hits: string[],
  tolerancePx = 4
): PickCycle | null {
  if (hits.length === 0) return null;
  const same =
    prev &&
    Math.hypot(prev.x - x, prev.y - y) <= tolerancePx &&
    prev.hits.length === hits.length &&
    prev.hits.every((h, i) => h === hits[i]);
  return {
    x,
    y,
    hits,
    index: same ? (prev.index + 1) % hits.length : 0,
  };
}

// Masks (Merge's per-layer mattes, the universal `mask` input) shape what
// is visible but are not content of their own; params never are.
function isContentSocket(targetHandle: string): boolean {
  if (!targetHandle.startsWith("in:")) return false;
  const name = targetHandle.slice(3);
  if (name.startsWith("param:")) return false;
  return name !== "mask" && !name.startsWith("mask:");
}

function outputValue(
  out: NodeOutput | undefined,
  handle: string
): SocketValue | undefined {
  if (!out) return undefined;
  if (handle.startsWith("out:aux:")) {
    return out.aux?.[handle.slice("out:aux:".length)];
  }
  return out.primary;
}

// Visit order = stacking order, top first. Merge composites its layers in
// `params.layers` order over `base`; a Layer puts `content` over `stack`.
// Other nodes have no stacking meaning — keep edge order.
function orderTopFirst(node: GraphNode, inEdges: GraphEdge[]): GraphEdge[] {
  const rank = new Map<string, number>();
  if (node.type === "merge") {
    const layers = Array.isArray(node.params.layers)
      ? (node.params.layers as { id?: unknown }[])
      : [];
    layers.forEach((l, i) => {
      if (typeof l?.id === "string") {
        rank.set(`in:layer:${l.id}`, i + 1);
      }
    });
    rank.set("in:base", 0);
  } else if (node.type === "layer") {
    rank.set("in:content", 1);
    rank.set("in:stack", 0);
  } else {
    return inEdges;
  }
  const r = (e: GraphEdge) => rank.get(e.targetHandle) ?? -1;
  return [...inEdges].sort((a, b) => r(b) - r(a));
}

function splineNear(s: SplineValue, x: number, y: number): boolean {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const sub of s.subpaths) {
    for (const a of sub.anchors) {
      const [ax, ay] = a.pos;
      if (ax < minX) minX = ax;
      if (ax > maxX) maxX = ax;
      if (ay < minY) minY = ay;
      if (ay > maxY) maxY = ay;
    }
  }
  if (!Number.isFinite(minX)) return false;
  return (
    x >= minX - SPLINE_PAD &&
    x <= maxX + SPLINE_PAD &&
    y >= minY - SPLINE_PAD &&
    y <= maxY + SPLINE_PAD
  );
}
