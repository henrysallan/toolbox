// Group flattening — the compile pass that makes node groups (and the
// structural part of layers) transparent to evaluation. Runs at the top
// of evaluateGraph (and anywhere else that needs engine-true
// reachability, e.g. the export manifest builder).
//
// Plain groups are pure structure: the group shell (type "node-group")
// and its interior Group Input / Group Output boundary nodes never
// compute. This pass removes all three from the graph and splices every
// edge that crosses a group boundary straight through to the real
// producer:
//
//   X → (group, in:k)            …consumed; each interior consumer of
//   (groupInput, out:aux:k) → Z  …becomes X → Z
//
//   Z → (groupOutput, in:j)      …consumed; each exterior consumer of
//   (group, out:aux:j) → Y       …becomes Z → Y
//
// Layers are group subtypes whose shell COMPUTES (the blend against the
// stack), so the layer node stays in the flat graph; only its interior
// boundary nodes dissolve:
//
//   Z → (layerGO, in:image)              becomes Z → (layer, in:content)
//   (layerGI, out:aux:backdrop) → Z      becomes <stack producer> → Z
//   audio: (layer, out:aux:audio) → Y    resolves through the interior
//          Group Output's audio input, falling back to the layer's own
//          exterior `audio` input — a pure splice, so audio sources end
//          up wired directly to their final consumers and the
//          audio-routing detection in the evaluator keeps working.
//
// Resolution iterates, so chains across nested groups, stacked layers,
// and pure passthroughs collapse to their endpoints. An unwired
// boundary socket simply drops the edge — the consumer falls back to
// its socket default, same as being unwired.
//
// Node objects pass through by reference (no copies), so param
// identity — which the eval cache fingerprints depend on — is
// preserved. The pass is O(nodes + edges) and skips itself entirely
// for structure-free graphs, so it runs unconditionally every eval
// rather than being cached.
//
// The returned `layerOf` maps every surviving node id to its nearest
// enclosing layer (via the original parentId chains). The evaluator
// uses it to put layer interiors on AE-style local time.

import type { GraphEdge, GraphNode } from "./evaluator";
import {
  GROUP_INPUT_TYPE,
  GROUP_OUTPUT_TYPE,
  GROUP_TYPE,
  LAYER_TYPE,
  readBoundarySockets,
  readGroupInterface,
} from "./groups";
import { parseTargetHandleKind } from "./graph-helpers";

function isStructuralType(type: string): boolean {
  return (
    type === GROUP_TYPE ||
    type === GROUP_INPUT_TYPE ||
    type === GROUP_OUTPUT_TYPE
  );
}

function auxName(sourceHandle: string): string | null {
  return sourceHandle.startsWith("out:aux:")
    ? sourceHandle.slice("out:aux:".length)
    : null;
}

function socketKey(nodeId: string, socketName: string): string {
  return `${nodeId} ${socketName}`;
}

// Walk a source endpoint backward through boundary structure (group shells,
// group/layer inputs, layer audio splices) until it lands on a real
// producer. Returns null when the chain dead-ends on an unwired boundary
// socket (or, defensively, on a cycle in mangled data). Shared by the
// flatten pass and the preview-target resolver below.
function resolveBoundarySource(
  byId: Map<string, GraphNode>,
  edgeIntoSocket: Map<string, GraphEdge>,
  outputNodeOf: Map<string, string>,
  maxHops: number,
  source: string,
  sourceHandle: string
): { source: string; sourceHandle: string } | null {
  let cur = { source, sourceHandle };
  for (let hops = 0; hops <= maxHops; hops++) {
    const n = byId.get(cur.source);
    if (!n) return null;
    const name = auxName(cur.sourceHandle);
    if (n.type === GROUP_TYPE) {
      // Group shell output → the interior producer wired into the
      // matching Group Output socket.
      const interiorId = name != null ? outputNodeOf.get(n.id) : undefined;
      const inner = interiorId
        ? edgeIntoSocket.get(socketKey(interiorId, name!))
        : undefined;
      if (!inner) return null;
      cur = { source: inner.source, sourceHandle: inner.sourceHandle };
    } else if (n.type === GROUP_INPUT_TYPE) {
      // Interior face of a group/layer input → the exterior producer.
      // Layers map the reserved `backdrop` socket onto the exterior `stack`
      // input; any other (user-minted) Layer Input socket has a same-named
      // exterior input on the layer node (layer.resolveInputs surfaces it),
      // so it resolves by name just like a plain group's sockets.
      const parent = n.parentId ? byId.get(n.parentId) : undefined;
      const exteriorSocket =
        parent?.type === LAYER_TYPE && name === "backdrop" ? "stack" : name;
      const outer =
        exteriorSocket != null && n.parentId
          ? edgeIntoSocket.get(socketKey(n.parentId, exteriorSocket))
          : undefined;
      if (!outer) return null;
      cur = { source: outer.source, sourceHandle: outer.sourceHandle };
    } else if (n.type === LAYER_TYPE && name === "audio") {
      // Layer audio is a pure splice: the interior Group Output's audio
      // input wins; an unwired interior falls back to the layer's
      // exterior audio input (the chain below).
      const interiorId = outputNodeOf.get(n.id);
      const inner = interiorId
        ? edgeIntoSocket.get(socketKey(interiorId, "audio"))
        : undefined;
      const next = inner ?? edgeIntoSocket.get(socketKey(n.id, "audio"));
      if (!next) return null;
      cur = { source: next.source, sourceHandle: next.sourceHandle };
    } else if (n.type === GROUP_OUTPUT_TYPE) {
      // Group Output has no output sockets; appearing as a source means
      // the data is mangled.
      return null;
    } else {
      return cur;
    }
  }
  return null;
}

export interface FlattenResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  // Surviving node id → nearest enclosing layer node id. Only nodes
  // inside a layer have entries.
  layerOf: Map<string, string>;
}

const EMPTY_LAYER_OF: Map<string, string> = new Map();

export function flattenGraph(
  nodes: GraphNode[],
  edges: GraphEdge[]
): FlattenResult {
  const hasStructure = nodes.some(
    (n) => isStructuralType(n.type) || n.type === LAYER_TYPE
  );
  if (!hasStructure) {
    return { nodes, edges, layerOf: EMPTY_LAYER_OF };
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  // parent (group or layer) id → interior Group Output node id.
  const outputNodeOf = new Map<string, string>();
  for (const n of nodes) {
    if (n.type === GROUP_OUTPUT_TYPE && n.parentId) {
      outputNodeOf.set(n.parentId, n.id);
    }
  }

  // One producer per input socket: (target, socketName) → edge.
  const edgeIntoSocket = new Map<string, GraphEdge>();
  for (const e of edges) {
    const parsed = parseTargetHandleKind(e.targetHandle);
    if (parsed?.kind === "input") {
      edgeIntoSocket.set(socketKey(e.target, parsed.name), e);
    }
  }

  // Walk a source endpoint backward through boundary structure until it
  // lands on a real producer (see resolveBoundarySource). Returns null when
  // the chain dead-ends on an unwired boundary socket — the consuming edge
  // is dropped and the consumer sees its socket default.
  const resolveSource = (source: string, sourceHandle: string) =>
    resolveBoundarySource(
      byId,
      edgeIntoSocket,
      outputNodeOf,
      edges.length,
      source,
      sourceHandle
    );

  // True when this edge's source endpoint needs resolution before it
  // can appear in the flat graph.
  function sourceNeedsResolve(e: GraphEdge): boolean {
    const src = byId.get(e.source);
    if (!src) return false;
    if (isStructuralType(src.type)) return true;
    return src.type === LAYER_TYPE && auxName(e.sourceHandle) === "audio";
  }

  const outNodes = nodes.filter((n) => !isStructuralType(n.type));
  const outEdges: GraphEdge[] = [];
  for (const e of edges) {
    const target = byId.get(e.target);
    if (target && isStructuralType(target.type)) {
      // Edges into structure are consumed by source resolution of the
      // edges on the far side of the boundary — except a layer's
      // content: the interior result wired into the layer's Group
      // Output `image` socket becomes the layer node's hidden
      // `content` input (the layer computes the blend itself).
      const parent = target.parentId ? byId.get(target.parentId) : undefined;
      const parsed = parseTargetHandleKind(e.targetHandle);
      if (
        target.type === GROUP_OUTPUT_TYPE &&
        parent?.type === LAYER_TYPE &&
        parsed?.kind === "input" &&
        parsed.name === "image"
      ) {
        const resolved = sourceNeedsResolve(e)
          ? resolveSource(e.source, e.sourceHandle)
          : { source: e.source, sourceHandle: e.sourceHandle };
        if (resolved) {
          outEdges.push({
            ...e,
            source: resolved.source,
            sourceHandle: resolved.sourceHandle,
            target: parent.id,
            targetHandle: "in:content",
          });
        }
      }
      continue;
    }
    if (!sourceNeedsResolve(e)) {
      outEdges.push(e);
      continue;
    }
    const resolved = resolveSource(e.source, e.sourceHandle);
    if (!resolved) continue;
    // Keep the consumer edge's id — each consumer edge maps to at most
    // one flattened edge, so ids stay unique.
    outEdges.push({
      ...e,
      source: resolved.source,
      sourceHandle: resolved.sourceHandle,
    });
  }

  // Nearest enclosing layer per surviving node, via the original
  // parentId chains (group shells in the chain are dissolved but still
  // looked up in the original byId).
  const layerOf = new Map<string, string>();
  for (const n of outNodes) {
    let cur = n.parentId;
    for (let hops = 0; cur && hops < nodes.length; hops++) {
      const p = byId.get(cur);
      if (!p) break;
      if (p.type === LAYER_TYPE) {
        layerOf.set(n.id, p.id);
        break;
      }
      cur = p.parentId;
    }
  }

  return { nodes: outNodes, edges: outEdges, layerOf };
}

// Pick which output socket of a group to preview: the first image/mask-typed
// one (what the 2D canvas can actually show), else the first declared.
function preferImageSocket(
  specs: { name: string; type: string }[]
): string | undefined {
  if (specs.length === 0) return undefined;
  const img = specs.find((s) => s.type === "image" || s.type === "mask");
  return (img ?? specs[0]).name;
}

// Resolve a structural preview target — a node-group shell or a Group Output
// boundary node — to the real interior producer feeding its image output.
// Flatten dissolves the shell/boundary, so without this the canvas can't
// preview a group via its Active button (or by selecting it). Returns null
// for any other node type (Group Input has nothing to preview) or when the
// chosen output is unwired. The returned `handle` lets the caller read the
// exact output the group's image socket was fed from.
export function resolvePreviewProducer(
  nodes: GraphNode[],
  edges: GraphEdge[],
  targetId: string
): { nodeId: string; handle: string } | null {
  const target = nodes.find((n) => n.id === targetId);
  if (!target) return null;
  if (target.type !== GROUP_TYPE && target.type !== GROUP_OUTPUT_TYPE) {
    return null;
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outputNodeOf = new Map<string, string>();
  for (const n of nodes) {
    if (n.type === GROUP_OUTPUT_TYPE && n.parentId) {
      outputNodeOf.set(n.parentId, n.id);
    }
  }
  const edgeIntoSocket = new Map<string, GraphEdge>();
  for (const e of edges) {
    const parsed = parseTargetHandleKind(e.targetHandle);
    if (parsed?.kind === "input") {
      edgeIntoSocket.set(socketKey(e.target, parsed.name), e);
    }
  }

  // The (Group Output node, socket name) whose interior producer we want.
  let groupOutputId: string | undefined;
  let socketName: string | undefined;
  if (target.type === GROUP_TYPE) {
    groupOutputId = outputNodeOf.get(target.id);
    socketName = preferImageSocket(readGroupInterface(target.params).outputs);
  } else {
    groupOutputId = target.id;
    socketName = preferImageSocket(readBoundarySockets(target.params));
  }
  if (!groupOutputId || !socketName) return null;

  const into = edgeIntoSocket.get(socketKey(groupOutputId, socketName));
  if (!into) return null;
  const resolved = resolveBoundarySource(
    byId,
    edgeIntoSocket,
    outputNodeOf,
    edges.length,
    into.source,
    into.sourceHandle
  );
  if (!resolved) return null;
  return { nodeId: resolved.source, handle: resolved.sourceHandle };
}
