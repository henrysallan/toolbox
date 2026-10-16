// Layer parenting (specdocs/101526_layer-transforms-parenting.md §7): the
// wire `(P, out:aux:transform) → (C, in:transform)` IS the parent link —
// the timeline's Parent column only reads and writes it. Pure graph ops on
// the editor's node/edge arrays, so check-layer-parenting.mts drives them
// directly and EffectsApp wraps each in one history entry.
//
// Keep-in-place (D2): parenting / unparenting rewrites the child's TRS so
// its world placement at the playhead holds — newLocal = P⁻¹ ∘ C_world,
// decomposed back into TRS about the child's own pivot. It's skipped (the
// child jumps, and the caller says so) when the child's TRS is animated,
// when the result would need shear (a rotated child under a non-uniformly
// scaled parent), or when a parent in the chain isn't a layer (its
// transform isn't knowable outside an eval).

import type { Edge } from "@xyflow/react";
import { LAYER_TYPE } from "@/engine/groups";
import { parseTargetHandleKind } from "@/engine/graph-helpers";
import { evaluateKeyframesAt } from "@/engine/keyframes";
import {
  composeOpsToAffine,
  decomposeAffineToTrs,
  invertAffine,
  isIdentityOp,
  multiplyAffine,
  opFromParams,
  TRANSFORM_TRS_PARAMS,
} from "@/engine/transform-value";
import type { TransformOp } from "@/engine/types";
import { newEdgeId, type GraphNode } from "./graph-ops";

export const PARENT_TARGET_HANDLE = "in:transform";
export const PARENT_SOURCE_HANDLE = "out:aux:transform";

const TRS_NAMES = TRANSFORM_TRS_PARAMS.map((p) => p.name);

const isLayer = (n: GraphNode | undefined): n is GraphNode =>
  !!n && n.data.defType === LAYER_TYPE;

// The edge feeding a node's Parent input, if any.
export function parentEdgeOf(edges: readonly Edge[], childId: string): Edge | undefined {
  return edges.find((e) => e.target === childId && e.targetHandle === PARENT_TARGET_HANDLE);
}

// A layer's parent: the producer of its Parent input, flagged when that
// producer isn't a layer (hand-wired — shown read-only in the timeline).
export function layerParentOf(
  nodes: readonly GraphNode[],
  edges: readonly Edge[],
  childId: string
): { id: string; isLayer: boolean } | null {
  const e = parentEdgeOf(edges, childId);
  if (!e) return null;
  return { id: e.source, isLayer: isLayer(nodes.find((n) => n.id === e.source)) };
}

// Layers parented to `parentId`.
export function layerChildrenOf(
  nodes: readonly GraphNode[],
  edges: readonly Edge[],
  parentId: string
): string[] {
  return edges
    .filter(
      (e) =>
        e.source === parentId &&
        e.sourceHandle === PARENT_SOURCE_HANDLE &&
        e.targetHandle === PARENT_TARGET_HANDLE &&
        isLayer(nodes.find((n) => n.id === e.target))
    )
    .map((e) => e.target);
}

// True when parenting `childId` to `candidateId` would close a loop: the
// candidate is the child, or the child is among the candidate's ancestors.
export function wouldLoop(
  edges: readonly Edge[],
  childId: string,
  candidateId: string
): boolean {
  const seen = new Set<string>();
  let cur: string | undefined = candidateId;
  while (cur && !seen.has(cur)) {
    if (cur === childId) return true;
    seen.add(cur);
    cur = parentEdgeOf(edges, cur)?.source;
  }
  return false;
}

// True when a wire drives one of the layer's TRS params (`in:param:<trs>`)
// — wire beats keyframes and the static value, so neither tells us where
// the layer is, and a rewrite of the static value wouldn't move it.
export function hasWiredTrs(edges: readonly Edge[], layerId: string): boolean {
  return edges.some((e) => {
    if (e.target !== layerId) return false;
    const parsed = parseTargetHandleKind(e.targetHandle ?? "");
    return parsed?.kind === "param" && TRS_NAMES.includes(parsed.name);
  });
}

// True when any TRS param of the layer has live keyframes.
export function isTrsAnimated(node: GraphNode): boolean {
  const anim = node.data.animation;
  if (!anim) return false;
  return TRS_NAMES.some((name) => {
    const b = anim[name];
    return !!b && b.animated && b.keyframes.length > 0;
  });
}

// The layer's own TRS at `tick` (global — layer-own keys run on the global
// clock, like opacity), keyframes applied.
function localOpAt(node: GraphNode, tick: number): TransformOp {
  const params: Record<string, unknown> = { ...node.data.params };
  const anim = node.data.animation;
  if (anim) {
    for (const name of TRS_NAMES) {
      const b = anim[name];
      if (!b || !b.animated || b.keyframes.length === 0) continue;
      const v = evaluateKeyframesAt(b, "scalar", tick);
      if (typeof v === "number") params[name] = v;
    }
  }
  return opFromParams(params);
}

// A layer's world transform at `tick` as ops (local first, then each
// ancestor) — what its layer-xform node evaluates. Null when it can't be
// known here: a layer in the chain isn't a layer, has a wired TRS param
// (its value only exists at eval), or the chain loops (mangled data).
export function worldOpsAt(
  nodes: readonly GraphNode[],
  edges: readonly Edge[],
  layerId: string,
  tick: number
): TransformOp[] | null {
  const ops: TransformOp[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = layerId;
  while (cur) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const node = nodes.find((n) => n.id === cur);
    if (!isLayer(node) || hasWiredTrs(edges, cur)) return null;
    const op = localOpAt(node, tick);
    if (!isIdentityOp(op)) ops.push(op);
    cur = parentEdgeOf(edges, cur)?.source;
  }
  return ops;
}

// Why a parent change didn't hold the child in place.
export type JumpReason = "animated" | "wired" | "shear" | "unknown-parent";

export type SetParentResult =
  | {
      ok: true;
      nodes: GraphNode[];
      edges: Edge[];
      // True when the child's TRS was rewritten to hold its placement.
      held: boolean;
      // Set when keepInPlace was asked for but couldn't be honoured.
      jumped?: JumpReason;
    }
  | { ok: false; error: string };

// Set (parentId) or clear (null) a layer's parent. `keepInPlace` false is
// AE's Alt-parent: rewire only, the child jumps.
export function setLayerParent(
  nodes: GraphNode[],
  edges: Edge[],
  childId: string,
  parentId: string | null,
  tick: number,
  opts: { keepInPlace: boolean }
): SetParentResult {
  const child = nodes.find((n) => n.id === childId);
  if (!isLayer(child)) return { ok: false, error: "Not a layer." };
  if (parentId !== null) {
    if (!isLayer(nodes.find((n) => n.id === parentId))) {
      return { ok: false, error: "A parent must be a layer." };
    }
    if (wouldLoop(edges, childId, parentId)) {
      return { ok: false, error: "That would create a parenting loop." };
    }
  }
  const current = parentEdgeOf(edges, childId);
  if ((current?.source ?? null) === parentId) {
    return { ok: true, nodes, edges, held: false };
  }

  const nextEdges = edges.filter((e) => e !== current);
  if (parentId !== null) {
    nextEdges.push({
      id: newEdgeId(),
      source: parentId,
      sourceHandle: PARENT_SOURCE_HANDLE,
      target: childId,
      targetHandle: PARENT_TARGET_HANDLE,
    });
  }
  if (!opts.keepInPlace) {
    return { ok: true, nodes, edges: nextEdges, held: false };
  }
  if (isTrsAnimated(child)) {
    return { ok: true, nodes, edges: nextEdges, held: false, jumped: "animated" };
  }
  if (hasWiredTrs(edges, childId)) {
    return { ok: true, nodes, edges: nextEdges, held: false, jumped: "wired" };
  }

  const before = worldOpsAt(nodes, edges, childId, tick);
  const parentWorld = parentId === null ? [] : worldOpsAt(nodes, edges, parentId, tick);
  if (!before || !parentWorld) {
    return { ok: true, nodes, edges: nextEdges, held: false, jumped: "unknown-parent" };
  }
  const inv = invertAffine(composeOpsToAffine(parentWorld));
  const local = opFromParams(child.data.params);
  const solved = inv
    ? decomposeAffineToTrs(
        multiplyAffine(inv, composeOpsToAffine(before)),
        local.pivotX,
        local.pivotY,
        local.rotateDeg
      )
    : null;
  if (!solved) {
    return { ok: true, nodes, edges: nextEdges, held: false, jumped: "shear" };
  }
  const nextNodes = nodes.map((n) =>
    n.id === childId
      ? {
          ...n,
          data: {
            ...n.data,
            params: {
              ...n.data.params,
              translateX: solved.translateX,
              translateY: solved.translateY,
              scaleX: solved.scaleX,
              scaleY: solved.scaleY,
              rotate: solved.rotateDeg,
            },
          },
        }
      : n
  );
  return { ok: true, nodes: nextNodes, edges: nextEdges, held: true };
}

// Deleting a parent unparents its surviving children first, holding them
// in place (or jumping, with the reason). Runs on the FULL graph, before
// the caller drops the dead nodes' edges.
export function unparentChildrenOf(
  nodes: GraphNode[],
  edges: Edge[],
  deadIds: ReadonlySet<string>,
  tick: number
): { nodes: GraphNode[]; edges: Edge[]; jumped: { id: string; reason: JumpReason }[] } {
  const orphans = nodes.filter((n) => {
    if (!isLayer(n) || deadIds.has(n.id)) return false;
    const p = parentEdgeOf(edges, n.id)?.source;
    return !!p && deadIds.has(p);
  });
  let curNodes = nodes;
  let curEdges = edges;
  const jumped: { id: string; reason: JumpReason }[] = [];
  for (const o of orphans) {
    const r = setLayerParent(curNodes, curEdges, o.id, null, tick, { keepInPlace: true });
    if (!r.ok) continue;
    curNodes = r.nodes;
    curEdges = r.edges;
    if (r.jumped) jumped.push({ id: o.id, reason: r.jumped });
  }
  return { nodes: curNodes, edges: curEdges, jumped };
}

// Duplicate rule: a cloned layer keeps its parent when that parent wasn't
// cloned with it (a parent cloned alongside — layer or not — is an internal
// edge the clone already carries). `idMap` is the FULL original → clone
// map; `carries(origId)` picks which clones get the rule (layers).
export function carriedParentEdges(
  edges: readonly Edge[],
  idMap: ReadonlyMap<string, string>,
  carries: (origId: string) => boolean = () => true
): Edge[] {
  const out: Edge[] = [];
  for (const [orig, clone] of idMap) {
    if (!carries(orig)) continue;
    const e = parentEdgeOf(edges, orig);
    if (!e || idMap.has(e.source)) continue;
    out.push({ ...e, id: newEdgeId(), target: clone });
  }
  return out;
}

export function jumpReasonText(reason: JumpReason): string {
  switch (reason) {
    case "animated":
      return "its transform is animated";
    case "wired":
      return "a wire drives its transform";
    case "shear":
      return "the parent's non-uniform scale can't be undone with position / scale / rotation";
    case "unknown-parent":
      return "a parent's transform can't be read here (not a layer, or wired)";
  }
}
