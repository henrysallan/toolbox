// Time Offset closures (specdocs/081426_time-offset.md).
//
// A Time Offset node re-evaluates everything upstream of its `in` socket at
// `tick − offset` through a private nested evaluateGraph pass (the Iterate
// pattern). This module owns the PURE structure step: walking the flat
// graph backwards from each shell's `in` edge and collecting the ancestor
// closure that will re-run on the shifted clock.
//
// Unlike Iterate interiors, closure nodes STAY in the outer graph — other
// consumers may still evaluate them at outer time; the closure holds
// references, never copies. The walk stops at nodes that cannot exist at
// two clocks in one eval:
//
//   - `simulation: true` defs (state integrated across frames) and
//     `retimeable: false` defs (live external state — video elements,
//     webcam, the audio transport, cursor, trackers). Their OUTER value is
//     fed through un-shifted: the crossing edge is recorded as a feed, the
//     evaluator mirrors it onto a hidden `to__e_<edgeId>` shell input, and
//     the shell's compute re-injects it via a synthetic feed node.
//   - Iterate shells: their private cache + owned-texture lifecycle assume
//     ONE consumer sequence; two clock domains would release each other's
//     collected textures mid-frame. Boundary-fed like the flagged defs.
//   - Other Time Offset shells: chained offsets are rejected in v1
//     (Decision 3 in the spec) — the shell's compute throws, telling the
//     user to sum into one node's offset.
//
// The evaluator (see the stash block in evaluator.ts) adds a structure
// hash + timeDriven flag per closure and stashes the result in ctx.state
// for the shell's compute / fingerprintExtras — exactly the Iterate stash
// contract, under its own key.

import { getNodeDef } from "./registry";
import { ITERATE_TYPE } from "./groups";
import { is3DPoints } from "./points";
import type { GraphEdge, GraphNode } from "./evaluator";
import type { PointsValue, SocketType, SocketValue } from "./types";

export const TIME_OFFSET_TYPE = "time-offset";
export const TIME_OFFSET_FEED_TYPE = "time-offset-feed";
// Hidden shell inputs carrying boundary-fed outer values, one per crossing
// edge. Namespaced so they can never collide with declared sockets.
export const TIME_OFFSET_EDGE_PREFIX = "to__e_";
// ctx.state key for the per-shell closure stash. Colon-free so the
// dispose sweep (sweepNodeState's `<type>:<nodeId>` convention) skips it.
export const TIME_OFFSET_STASH_KEY = "__time-offset-closures__";

// Socket types the `in` socket carries in v1. Everything here is either a
// plain CPU value (safe to pass by reference out of the private cache) or
// a texture-backed value the shell copies into node-owned textures before
// emitting. Deliberately excluded: `audio` (one Tone transport; a shifted
// chain descriptor reaching the outer reconcile would collide with its
// unshifted twin), `element` (deferred closures capturing interior state),
// `image_group`/`list` (borrowed container items — the private cache could
// evict the producers under the outer consumer), particles/sdf/3D values
// (GPU/retained state coupled to their producer's ctx.state).
export const TIME_OFFSET_CARRIED_TYPES: readonly SocketType[] = [
  "scalar",
  "vec2",
  "vec3",
  "vec4",
  "string",
  "spline",
  "points",
  "points3d",
  "image",
  "mask",
  "uv",
  "notes",
  "color_ramp",
];

// A boundary crossing edge: `edge.source` is outside the closure (flagged
// def / Iterate shell), `edge.target` inside. The outer value is delivered
// on the shell's hidden `inputName` input via an evaluator-minted mirror
// edge, and re-emitted inside the nested pass by a feed node.
export interface TimeOffsetFeed {
  edge: GraphEdge;
  inputName: string;
  producerType: string;
}

export interface TimeOffsetClosure {
  // References into the flat graph — never copies.
  nodes: GraphNode[];
  // Edges fully inside the closure (source and target both members).
  edges: GraphEdge[];
  // What the shell's `in` wire reads: producer id + source handle.
  tap: { producerId: string; sourceHandle: string } | null;
  // Set when the tap producer ITSELF is a boundary — the shell is then a
  // pure passthrough of the outer value (`inputs.in`; no nested eval, no
  // mirror edge needed since the `in` edge stays in the needed set).
  tapIsBoundary: boolean;
  feeds: TimeOffsetFeed[];
  // Boundary def types encountered, for the console warning (deduped).
  boundaryTypes: string[];
  // An upstream Time Offset shell was hit — compute rejects with a node
  // error (chained offsets are v1-unsupported; sum into one node).
  chained: boolean;
  // Filled by the evaluator's stash build (structure hash — NO time; the
  // shell's fingerprintExtras folds the scoped tick when timeDriven).
  hash?: string;
  timeDriven?: boolean;
}

export type TimeOffsetStash = Map<string, TimeOffsetClosure>;

export function feedInputName(edgeId: string): string {
  return `${TIME_OFFSET_EDGE_PREFIX}${edgeId}`;
}

// Socket type of a value the shell actually emitted. The shell's tap
// producer is deliberately NOT outer-evaluated, so `connectedTypesFor`
// (which reads outputTypeCache) can't type the shell's `in` — its
// resolvePrimaryOutput would register the resting "scalar" while carrying,
// say, a spline, and polymorphic consumers downstream (Switch auto,
// Transform/Displace source) would mis-retype. The evaluator overrides the
// shell's outputTypeCache entry with THIS after compute — the emitted
// value is the authority. Null for kinds outside the carried set.
export function carriedSocketTypeOf(v: SocketValue): SocketType | null {
  switch (v.kind) {
    case "points":
      return is3DPoints(v as PointsValue) ? "points3d" : "points";
    case "scalar":
    case "vec2":
    case "vec3":
    case "vec4":
    case "string":
    case "spline":
    case "image":
    case "mask":
    case "uv":
    case "notes":
    case "color_ramp":
      return v.kind;
    default:
      return null;
  }
}

// Can this def run inside a shifted nested pass? False for defs whose
// output depends on evaluation history or live external state rather than
// the clock. The test: could two copies of this node at two different
// ticks coexist in one eval and both be right, given only ctx? Pure
// `stable:false` defs (Scene Time, Wave, noise) pass — f(ctx.time) retimes
// exactly. Unknown types fail closed.
export function isTimeOffsetBoundary(nodeType: string): boolean {
  if (nodeType === ITERATE_TYPE) return true;
  const def = getNodeDef(nodeType);
  if (!def) return true;
  return def.simulation === true || def.retimeable === false;
}

// Walk the flat graph backwards from each Time Offset shell's `in` edge.
// Returns null when the graph has no shells (the common case — callers
// skip all stash work). Follows EVERY incoming edge of a member — data
// and exposed-param wires alike, since a param wire's producer is part of
// the branch's animation too.
export function collectTimeOffsetClosures(
  nodes: GraphNode[],
  edges: GraphEdge[]
): TimeOffsetStash | null {
  let hasShell = false;
  for (const n of nodes) {
    if (n.type === TIME_OFFSET_TYPE) {
      hasShell = true;
      break;
    }
  }
  if (!hasShell) return null;

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    const list = incoming.get(e.target);
    if (list) list.push(e);
    else incoming.set(e.target, [e]);
  }

  const out: TimeOffsetStash = new Map();
  for (const shell of nodes) {
    if (shell.type !== TIME_OFFSET_TYPE) continue;
    const closure: TimeOffsetClosure = {
      nodes: [],
      edges: [],
      tap: null,
      tapIsBoundary: false,
      feeds: [],
      boundaryTypes: [],
      chained: false,
    };
    out.set(shell.id, closure);

    const inEdge = (incoming.get(shell.id) ?? []).find(
      (e) => e.targetHandle === "in:in"
    );
    if (!inEdge) continue;
    const srcNode = byId.get(inEdge.source);
    if (!srcNode) continue;
    closure.tap = {
      producerId: inEdge.source,
      sourceHandle: inEdge.sourceHandle,
    };
    if (srcNode.type === TIME_OFFSET_TYPE) {
      closure.chained = true;
      continue;
    }
    if (isTimeOffsetBoundary(srcNode.type)) {
      closure.tapIsBoundary = true;
      closure.boundaryTypes.push(srcNode.type);
      continue;
    }

    const visited = new Set<string>([inEdge.source]);
    const queue = [inEdge.source];
    const edgeSeen = new Set<string>();
    while (queue.length) {
      const id = queue.shift()!;
      const node = byId.get(id);
      if (!node) continue;
      closure.nodes.push(node);
      for (const e of incoming.get(id) ?? []) {
        const src = byId.get(e.source);
        if (!src) continue;
        if (src.type === TIME_OFFSET_TYPE) {
          // A shell upstream anywhere in the branch is the chained case.
          closure.chained = true;
          continue;
        }
        if (isTimeOffsetBoundary(src.type)) {
          if (!edgeSeen.has(e.id)) {
            edgeSeen.add(e.id);
            closure.feeds.push({
              edge: e,
              inputName: feedInputName(e.id),
              producerType: src.type,
            });
            if (!closure.boundaryTypes.includes(src.type)) {
              closure.boundaryTypes.push(src.type);
            }
          }
          continue;
        }
        if (!edgeSeen.has(e.id)) {
          edgeSeen.add(e.id);
          closure.edges.push(e);
        }
        if (!visited.has(e.source)) {
          visited.add(e.source);
          queue.push(e.source);
        }
      }
    }
  }
  return out;
}
