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
  ITERATE_EDGE_PREFIX,
  ITERATE_INPUT_TYPE,
  ITERATE_PARAM_PREFIX,
  ITERATE_PASSTHROUGH_PREFIX,
  ITERATE_TYPE,
  LAYER_TYPE,
  readBoundarySockets,
  readGroupInterface,
} from "./groups";
import { parseTargetHandleKind, REROUTE_TYPE } from "./graph-helpers";

function isStructuralType(type: string): boolean {
  return (
    type === GROUP_TYPE ||
    type === GROUP_INPUT_TYPE ||
    type === GROUP_OUTPUT_TYPE
  );
}

// Types the flatten pass removes from the evaluated graph, splicing their
// edges straight through: group structure (above) plus the reroute node — a
// pure wire waypoint whose single `value` input resolves to its output. See
// specdocs/071326_reroute-node.md.
function isDissolvedType(type: string): boolean {
  return isStructuralType(type) || type === REROUTE_TYPE;
}

// The socket a dissolved node's output resolves back through. Reroute carries
// its lone `value` input to its output; group structure is handled by
// resolveBoundarySource's own cases.
const REROUTE_INPUT = "value";

// Layer Output socket → the layer node's own input it becomes. These are the
// PUSH-side splices: the interior producer is rewired straight onto the layer
// shell, which computes with it. `image` feeds the blend as the hidden
// `content`; `spline` is the vector export tap (stashed by layer.compute for
// the Layer Output's SVG button, never rendered). `audio` is deliberately
// absent — it resolves on the PULL side, in resolveBoundarySource, because a
// spliced audio chain has to land directly on its consumer for the
// evaluator's audio-routing detection to see it.
const LAYER_OUTPUT_TO_LAYER_INPUT: Record<string, string | undefined> = {
  image: "content",
  spline: "spline",
};

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
    if (n.type === REROUTE_TYPE) {
      // Reroute output → the producer wired into its `value` input. An
      // unwired reroute dead-ends (its downstream edges drop, like any
      // unwired boundary). Chains of reroutes collapse via this same loop.
      const inner = edgeIntoSocket.get(socketKey(n.id, REROUTE_INPUT));
      if (!inner) return null;
      cur = { source: inner.source, sourceHandle: inner.sourceHandle };
    } else if (n.type === GROUP_TYPE) {
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
  // Iterate shell id → its interior subgraph (boundary nodes included),
  // removed wholesale from the flat graph. The evaluator stashes these
  // on ctx for the shells' computes (nested evaluation) and folds an
  // interior hash into each shell's fingerprint. Absent when the graph
  // has no Iterate nodes. See specdocs/071826_iterate-node.md.
  iterateInteriors?: Map<string, { nodes: GraphNode[]; edges: GraphEdge[] }>;
}

const EMPTY_LAYER_OF: Map<string, string> = new Map();

// Remove every Iterate interior from the graph, returning the reduced
// arrays plus the per-shell interior subgraphs. Interiors are identified
// by parentId chain: any node whose chain reaches an ITERATE_TYPE shell
// PRESENT in `nodes` belongs to that (nearest) shell. A nested Iterate's
// shell is itself interior to the outer one — its own interior lands in
// the outer shell's subgraph too (the shell's compute rejects nested
// runs; see the iterate def).
function extractIterateInteriors(
  nodes: GraphNode[],
  edges: GraphEdge[]
): {
  nodes: GraphNode[];
  edges: GraphEdge[];
  iterateInteriors: Map<string, { nodes: GraphNode[]; edges: GraphEdge[] }>;
} | null {
  let hasIterate = false;
  for (const n of nodes) {
    if (n.type === ITERATE_TYPE) {
      hasIterate = true;
      break;
    }
  }
  if (!hasIterate) return null;

  const byId = new Map(nodes.map((n) => [n.id, n]));
  // Nearest enclosing iterate shell per node (walking parentId chains).
  const shellOf = new Map<string, string>();
  for (const n of nodes) {
    let cur = n.parentId;
    for (let hops = 0; cur && hops < nodes.length; hops++) {
      const p = byId.get(cur);
      if (!p) break;
      if (p.type === ITERATE_TYPE) {
        shellOf.set(n.id, p.id);
        break;
      }
      cur = p.parentId;
    }
  }
  if (shellOf.size === 0) return null;

  const iterateInteriors = new Map<
    string,
    { nodes: GraphNode[]; edges: GraphEdge[] }
  >();
  const interior = (shellId: string) => {
    let e = iterateInteriors.get(shellId);
    if (!e) {
      e = { nodes: [], edges: [] };
      iterateInteriors.set(shellId, e);
    }
    return e;
  };
  const outNodes: GraphNode[] = [];
  for (const n of nodes) {
    const shell = shellOf.get(n.id);
    if (shell) interior(shell).nodes.push(n);
    else outNodes.push(n);
  }
  const outEdges: GraphEdge[] = [];
  for (const e of edges) {
    const s = shellOf.get(e.source);
    const t = shellOf.get(e.target);
    if (!s && !t) {
      outEdges.push(e);
    } else if (s && s === t) {
      interior(s).edges.push(e);
    } else if (s && !t && e.target === s) {
      // Collect tap: member → its own shell's minted input. Lives in
      // the interior record — the shell's compute resolves the producer
      // from it; the outer graph never sees it (its source is gone).
      interior(s).edges.push(e);
    } else if (!s && t) {
      // Exterior → member. Legal only onto the Iteration Input's
      // exterior face: reroute onto the shell's hidden inputs so the
      // value is evaluated outer-side. Input sockets (`in:<name>`) are
      // the passthroughs, re-injected per iteration; exposed-param
      // wires (`in:param:<name>`, the loop params — count / seed /
      // random range) land on the shell's `zi__param__` inputs and win
      // over keyframes/stored per the house precedence, resolved in the
      // shell's compute. Anything else is mangled data — dropped.
      const target = byId.get(e.target);
      const parsed = parseTargetHandleKind(e.targetHandle);
      if (target?.type === ITERATE_INPUT_TYPE && target.parentId === t) {
        if (parsed?.kind === "input") {
          outEdges.push({
            ...e,
            target: t,
            targetHandle: `in:${ITERATE_PASSTHROUGH_PREFIX}${parsed.name}`,
          });
        } else if (parsed?.kind === "param") {
          outEdges.push({
            ...e,
            target: t,
            targetHandle: `in:${ITERATE_PARAM_PREFIX}${parsed.name}`,
          });
        }
      } else if (parsed) {
        // Direct crossing wire onto any other member — kept exactly as
        // the user drew it. Mirror the value onto a per-edge hidden
        // shell input (evaluated outer-side, raw) and keep the original
        // edge in the interior record; the shell's compute synthesizes
        // a feed node for it per iteration.
        outEdges.push({
          ...e,
          target: t,
          targetHandle: `in:${ITERATE_EDGE_PREFIX}${e.id}`,
        });
        interior(t).edges.push(e);
      }
    }
    // Remaining case (member → exterior, not a tap): a PENDING iteration
    // wire — the editor allows wiring index/t/random to outside nodes
    // while building; it only becomes live once the chain is piped into
    // the Iteration Output and absorbed. Dropped at eval (the consumer
    // sees its socket default).
  }
  return { nodes: outNodes, edges: outEdges, iterateInteriors };
}

// Resolve the interior producer wired into an Iterate's Group Output
// socket `socketName`, walking through any nested plain-group structure.
// Operates on the interior subgraph arrays (shell absent). Used by the
// iterate shell's compute to target the nested evaluation.
export function resolveInteriorProducer(
  nodes: GraphNode[],
  edges: GraphEdge[],
  groupOutputId: string,
  socketName: string
): { nodeId: string; handle: string } | null {
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
  return resolved
    ? { nodeId: resolved.source, handle: resolved.sourceHandle }
    : null;
}

export function flattenGraph(
  nodes: GraphNode[],
  edges: GraphEdge[]
): FlattenResult {
  // Iterate interiors leave the graph before any dissolution logic runs —
  // they evaluate privately inside their shell's compute. The shell itself
  // stays (it computes, like a layer).
  const extracted = extractIterateInteriors(nodes, edges);
  const iterateInteriors = extracted?.iterateInteriors;
  if (extracted) {
    nodes = extracted.nodes;
    edges = extracted.edges;
  }

  const hasStructure = nodes.some(
    (n) => isDissolvedType(n.type) || n.type === LAYER_TYPE
  );
  if (!hasStructure) {
    return { nodes, edges, layerOf: EMPTY_LAYER_OF, iterateInteriors };
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
    if (isDissolvedType(src.type)) return true;
    return src.type === LAYER_TYPE && auxName(e.sourceHandle) === "audio";
  }

  const outNodes = nodes.filter((n) => !isDissolvedType(n.type));
  const outEdges: GraphEdge[] = [];
  for (const e of edges) {
    const target = byId.get(e.target);
    if (target && isDissolvedType(target.type)) {
      // Edges into structure (and reroutes) are consumed by source
      // resolution of the edges on the far side — a reroute's `value` input
      // edge is walked back through by resolveBoundarySource when its output
      // is resolved, so it's simply dropped here — except a layer's
      // content: the interior result wired into the layer's Group
      // Output `image` socket becomes the layer node's hidden
      // `content` input (the layer computes the blend itself).
      const parent = target.parentId ? byId.get(target.parentId) : undefined;
      const parsed = parseTargetHandleKind(e.targetHandle);
      const layerInput =
        target.type === GROUP_OUTPUT_TYPE &&
        parent?.type === LAYER_TYPE &&
        parsed?.kind === "input"
          ? LAYER_OUTPUT_TO_LAYER_INPUT[parsed.name]
          : undefined;
      if (layerInput && parent) {
        const resolved = sourceNeedsResolve(e)
          ? resolveSource(e.source, e.sourceHandle)
          : { source: e.source, sourceHandle: e.sourceHandle };
        if (resolved) {
          outEdges.push({
            ...e,
            source: resolved.source,
            sourceHandle: resolved.sourceHandle,
            target: parent.id,
            targetHandle: `in:${layerInput}`,
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

  return { nodes: outNodes, edges: outEdges, layerOf, iterateInteriors };
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
  if (
    target.type !== GROUP_TYPE &&
    target.type !== GROUP_OUTPUT_TYPE &&
    target.type !== REROUTE_TYPE
  ) {
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

  // A reroute is dissolved at eval, so previewing it directly shows nothing —
  // remap to whatever feeds its `value` input (walking reroute chains).
  if (target.type === REROUTE_TYPE) {
    const into = edgeIntoSocket.get(socketKey(target.id, REROUTE_INPUT));
    if (!into) return null;
    const resolved = resolveBoundarySource(
      byId,
      edgeIntoSocket,
      outputNodeOf,
      edges.length,
      into.source,
      into.sourceHandle
    );
    return resolved
      ? { nodeId: resolved.source, handle: resolved.sourceHandle }
      : null;
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
