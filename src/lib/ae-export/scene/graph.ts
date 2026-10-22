// The composition as the scene walk reads it: the same flattened graph the
// planner saw (editor.ts flattenAeComposition, so ids agree), wire lookups by
// endpoint, and a sampler that runs the real evaluator on a node's upstream
// closure at any tick of its layer's clock — without GL (skia-export's
// dataOnlyContext). Spline, point, scalar, vector and transform values are
// CPU data, so they evaluate here; image nodes get no-op stubs and their
// values are never read.

import type { Edge } from "@xyflow/react";
import { evaluateGraph, type EvalCache, type GraphEdge, type GraphNode as EngineNode } from "@/engine/evaluator";
import type { KeyframeAnimationBlock } from "@/engine/keyframes";
import { DEFAULT_TICKS_PER_FRAME } from "@/engine/keyframes";
import { LAYER_TYPE, LAYER_XFORM_TYPE } from "@/engine/groups";
import type { SocketValue } from "@/engine/types";
import type { GraphNode } from "@/state/graph-ops";
import { dataOnlyContext, upstreamClosure } from "@/lib/skia-export/scene-sample";
import { flattenAeComposition, type AeFlatComposition } from "../editor";

export interface AeGraph {
  flat: AeFlatComposition;
  node(id: string): EngineNode | undefined;
  // Display name (editor name or the def name).
  name(id: string): string;
  // Wires into a node (bypasses resolved), by target handle ("in:path",
  // "in:param:radius", "in:mask:<id>" …).
  into(id: string): GraphEdge[];
  wireInto(id: string, handle: string): GraphEdge | undefined;
  // Wires out of a node.
  outOf(id: string): GraphEdge[];
  // A live keyframe block for a param (≥ 1 key), else undefined.
  block(id: string, param: string): KeyframeAnimationBlock | undefined;
  params(id: string): Record<string, unknown>;
  // The value at `endpoint` ("<id>:out" | "<id>:aux:<name>") at a tick of
  // the node's own (layer-local) clock. Undefined when the evaluator
  // produced nothing there.
  valueAt(endpoint: string, tick: number): SocketValue | undefined;
  // Last evaluation error at a node, if any.
  errorAt(id: string): string | undefined;
}

const handleOf = (endpoint: string): { id: string; handle: string; out: string } => {
  const aux = /^(.*):aux:([A-Za-z0-9_-]+)$/.exec(endpoint);
  if (aux) return { id: aux[1], handle: `aux:${aux[2]}`, out: `out:aux:${aux[2]}` };
  const id = endpoint.endsWith(":out") ? endpoint.slice(0, -4) : endpoint;
  return { id, handle: "primary", out: "out:primary" };
};

export function parseOut(endpoint: string): { id: string; out: string } {
  const h = handleOf(endpoint);
  return { id: h.id, out: h.out };
}

// "<id>:out" / "<id>:aux:<name>" of a wire's source.
export function sourceEndpoint(e: { source: string; sourceHandle: string }): string {
  return e.sourceHandle.startsWith("out:aux:") ? `${e.source}:aux:${e.sourceHandle.slice(8)}` : `${e.source}:out`;
}

export function makeAeGraph(nodes: GraphNode[], edges: Edge[], compositionId: string | undefined, canvas: { width: number; height: number }, fps: number): AeGraph {
  const flat = flattenAeComposition(nodes, edges, compositionId);
  const into = new Map<string, GraphEdge[]>();
  const outOf = new Map<string, GraphEdge[]>();
  for (const e of flat.wires) {
    (into.get(e.target) ?? into.set(e.target, []).get(e.target)!).push(e);
    (outOf.get(e.source) ?? outOf.set(e.source, []).get(e.source)!).push(e);
  }
  const ctx = dataOnlyContext(canvas, { fps, ticksPerFrame: DEFAULT_TICKS_PER_FRAME });
  // One cache per target node: tick-independent upstream computes once.
  const caches = new Map<string, EvalCache>();
  const closures = new Map<string, { nodes: EngineNode[]; edges: GraphEdge[] }>();
  const errors = new Map<string, string>();
  // The evaluator is not cheap; a walk asks for the same value repeatedly.
  const memo = new Map<string, SocketValue | undefined>();
  // Layers and their transform plumbing are root structure the walk maps
  // itself; an interior closure never needs them.
  const stop = (e: GraphEdge) => {
    const t = flat.byId.get(e.source)?.type;
    return t === LAYER_TYPE || t === LAYER_XFORM_TYPE || t === "output";
  };
  const closureOf = (id: string) => {
    let c = closures.get(id);
    if (!c) {
      const sub = upstreamClosure(flat.allNodes, flat.wires, id, stop);
      // Interior members keep their parentId, but no layer node is in the
      // closure, so the evaluator applies no layer clock offset: the tick
      // passed in IS the layer-local tick.
      c = { nodes: sub.nodes.map((n) => ({ ...n, parentId: undefined })), edges: sub.edges };
      closures.set(id, c);
    }
    return c;
  };
  return {
    flat,
    node: (id) => flat.byId.get(id),
    name: (id) => flat.names.get(id) ?? flat.byId.get(id)?.type ?? id,
    into: (id) => into.get(id) ?? [],
    wireInto: (id, handle) => (into.get(id) ?? []).find((e) => e.targetHandle === handle),
    outOf: (id) => outOf.get(id) ?? [],
    block(id, param) {
      const b = (flat.byId.get(id)?.animation as Record<string, KeyframeAnimationBlock> | undefined)?.[param];
      return b && b.animated && Array.isArray(b.keyframes) && b.keyframes.length > 0 ? b : undefined;
    },
    params: (id) => flat.byId.get(id)?.params ?? {},
    valueAt(endpoint, tick) {
      const key = `${endpoint}@${tick}`;
      if (memo.has(key)) return memo.get(key);
      const { id, handle } = handleOf(endpoint);
      if (!flat.byId.has(id)) return undefined;
      const sub = closureOf(id);
      let cache = caches.get(id);
      if (!cache) caches.set(id, (cache = new Map()));
      ctx.tick = tick;
      ctx.frame = Math.floor(tick / DEFAULT_TICKS_PER_FRAME);
      ctx.time = tick / (DEFAULT_TICKS_PER_FRAME * fps);
      let v: SocketValue | undefined;
      try {
        const r = evaluateGraph(sub.nodes, sub.edges, ctx, cache, null, undefined, null, {
          extraTargets: [id],
          extraConsumed: new Map([[id, [handle]]]),
        });
        const out = r.outputs.get(id);
        v = handle === "primary" ? out?.primary : out?.aux?.[handle.slice(4)];
        // A node upstream that threw (a GPU-only compute — Spline Merge's
        // Flow — has no GL here) left its consumers without an input: the
        // value is not toolbox's, so it is none.
        const up = Object.keys(r.errors).find((k) => k !== id);
        const err = r.errors[id] ?? (up ? `${flat.names.get(up) ?? up} (${up}) failed in the export's evaluator: ${r.errors[up]}` : undefined);
        if (err) {
          errors.set(id, err);
          if (up && !r.errors[id]) v = undefined;
        }
      } catch (e) {
        errors.set(id, e instanceof Error ? e.message : String(e));
        v = undefined;
      }
      memo.set(key, v);
      return v;
    },
    errorAt: (id) => errors.get(id),
  };
}

// A value socket as numbers: scalar → [v], vecN → [...], color strings → RGBA.
export function numbersOf(v: SocketValue | undefined): number[] | undefined {
  if (!v) return undefined;
  const x = (v as { value?: unknown }).value;
  if (typeof x === "number") return [x];
  if (Array.isArray(x) && x.every((c) => typeof c === "number")) return x as number[];
  return undefined;
}
