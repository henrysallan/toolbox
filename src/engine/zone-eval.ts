import type {
  ImageGroupValue,
  ImageValue,
  InputSocketDef,
  Point,
  PointsValue,
  RenderContext,
  SocketType,
  SocketValue,
  SplineSubpath,
  SplineValue,
} from "./types";
import {
  ITERATE_EDGE_PREFIX,
  ITERATE_FEED_TYPE,
  ITERATE_PARAM_PREFIX,
  ITERATE_PASSTHROUGH_PREFIX,
  VIRTUAL_SOCKET,
  ZONE_LOOP_PARAMS,
  readBoundarySockets,
  readGroupInterface,
  type GroupSocketSpec,
} from "./groups";
import { evaluateKeyframesAt } from "./keyframes";
import {
  disposeEvalCache,
  evaluateGraph,
  ITERATE_STASH_KEY,
  type EvalCache,
  type GraphEdge,
  type GraphNode,
  type IterateStash,
} from "./evaluator";
import { resolveInteriorProducer } from "./flatten";
import { ensurePointArray, pointsFromArray } from "./points";
import { hash01 } from "./spline-color-source";

// Shared nested-eval loop for Iterate / Repeat / For Each Element zones.
// Each shell's compute resolves K and the per-pass `values`, then this
// runs the interior K times, copies image results out of the nested
// cache, and either groups every pass (Iterate, For Each) or keeps the
// last (Repeat).

const COPY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() { outColor = texture(u_src, v_uv); }`;

export interface ZoneShellState {
  cache: EvalCache;
  runId: number;
  owned: WebGLTexture[];
}

export function ensureZoneState(
  ctx: RenderContext,
  type: string,
  nodeId: string
): ZoneShellState {
  const key = `${type}:${nodeId}`;
  const existing = ctx.state[key] as ZoneShellState | undefined;
  if (existing) return existing;
  const s: ZoneShellState = { cache: new Map(), runId: 0, owned: [] };
  ctx.state[key] = s;
  return s;
}

export function releaseZoneOwned(
  ctx: RenderContext,
  state: ZoneShellState
): void {
  for (const t of state.owned) ctx.releaseTexture(t);
  state.owned = [];
}

export function disposeZoneState(
  ctx: RenderContext,
  type: string,
  nodeId: string
): void {
  const key = `${type}:${nodeId}`;
  const state = ctx.state[key] as ZoneShellState | undefined;
  if (state) {
    releaseZoneOwned(ctx, state);
    disposeEvalCache(ctx, state.cache);
  }
  delete ctx.state[key];
}

export function emptyZoneValue(type: string): SocketValue {
  if (type === "spline") {
    return { kind: "spline", subpaths: [] } satisfies SplineValue;
  }
  if (type === "points") return pointsFromArray([]);
  return { kind: "image_group", items: [] } satisfies ImageGroupValue;
}

export function zoneInteriorHash(
  ctx: RenderContext,
  nodeId: string
): string {
  const stash = ctx.state[ITERATE_STASH_KEY] as IterateStash | undefined;
  return stash?.get(nodeId)?.hash ?? "";
}

export function findZoneInput(
  interior: { nodes: GraphNode[] } | undefined,
  inputType: string,
  shellId: string
): GraphNode | undefined {
  return interior?.nodes.find(
    (n) => n.type === inputType && n.parentId === shellId
  );
}

export function resolveZoneLoopParam(
  inputs: Record<string, SocketValue | undefined>,
  iterInput: GraphNode | undefined,
  ctx: RenderContext,
  name: string,
  fallback: number
): number {
  const wired = inputs[`${ITERATE_PARAM_PREFIX}${name}`];
  if (wired?.kind === "scalar" && Number.isFinite(wired.value)) {
    return wired.value;
  }
  const block = iterInput?.animation?.[name];
  if (block?.animated && block.keyframes.length > 0) {
    const v = evaluateKeyframesAt(block, "scalar", ctx.tick);
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  const stored = iterInput?.params[name];
  return typeof stored === "number" && Number.isFinite(stored)
    ? stored
    : fallback;
}

export function passthroughValues(
  params: Record<string, unknown>,
  inputs: Record<string, SocketValue | undefined>
): Record<string, SocketValue | undefined> {
  const values: Record<string, SocketValue | undefined> = {};
  for (const s of readGroupInterface(params).inputs) {
    values[s.name] = inputs[`${ITERATE_PASSTHROUGH_PREFIX}${s.name}`];
  }
  return values;
}

export type ZoneCollectMode = "group" | "last";

export interface ZoneLoopArgs {
  nodeId: string;
  ctx: RenderContext;
  inputs: Record<string, SocketValue | undefined>;
  params: Record<string, unknown>;
  state: ZoneShellState;
  minted: GroupSocketSpec[];
  K: number;
  seed: number;
  rMin: number;
  rMax: number;
  collectMode: ZoneCollectMode;
  tagGroupIndex: boolean;
  prepareValues: (
    i: number,
    base: Record<string, SocketValue | undefined>,
    last: Record<string, SocketValue> | null
  ) => Record<string, SocketValue | undefined>;
}

function copyImage(ctx: RenderContext, v: ImageValue): ImageValue {
  const copy = ctx.allocImage();
  const prog = ctx.getShader("iterate/copy", COPY_FS);
  ctx.drawFullscreen(prog, copy, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, v.texture);
    gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
  });
  return copy;
}

export function runZoneNestedLoop(
  args: ZoneLoopArgs
): { aux: Record<string, SocketValue>; ownsTextures: false } {
  const {
    nodeId,
    ctx,
    inputs,
    params,
    state,
    minted,
    K,
    seed,
    rMin,
    rMax,
    collectMode,
    tagGroupIndex,
    prepareValues,
  } = args;

  const allEmpty = () => {
    const aux: Record<string, SocketValue> = {};
    for (const s of minted) aux[s.name] = emptyZoneValue(s.type);
    return { aux, ownsTextures: false as const };
  };

  const stash = ctx.state[ITERATE_STASH_KEY] as IterateStash | undefined;
  const interior = stash?.get(nodeId);
  if (!interior || minted.length === 0 || K <= 0) return allEmpty();

  const taps = minted
    .map((s) => ({
      socket: s,
      producer: resolveInteriorProducer(
        interior.nodes,
        interior.edges,
        nodeId,
        s.name
      ),
    }))
    .filter(
      (t): t is typeof t & { producer: { nodeId: string; handle: string } } =>
        t.producer !== null
    );
  if (taps.length === 0) return allEmpty();

  const baseValues = passthroughValues(params, inputs);

  const interiorIds = new Set(interior.nodes.map((n) => n.id));
  const feedNodes: GraphNode[] = [];
  const nestedEdges: GraphEdge[] = interior.edges
    .filter((e) => e.target !== nodeId)
    .map((e) => {
      if (interiorIds.has(e.source)) return e;
      const key = `${ITERATE_EDGE_PREFIX}${e.id}`;
      baseValues[key] = inputs[key];
      feedNodes.push({
        id: `__iterfeed_${e.id}`,
        type: ITERATE_FEED_TYPE,
        params: { key, kind: inputs[key]?.kind ?? "image" },
      });
      return {
        ...e,
        source: `__iterfeed_${e.id}`,
        sourceHandle: "out:aux:value",
      };
    });
  const nestedNodes = [...interior.nodes, ...feedNodes];

  const runId = ++state.runId;
  const acc = new Map<
    string,
    { items: ImageValue[]; subpaths: SplineSubpath[]; points: Point[] }
  >();
  for (const t of taps) {
    acc.set(t.socket.name, { items: [], subpaths: [], points: [] });
  }

  let lastEmit: Record<string, SocketValue> | null = null;
  const savedIteration = ctx.iteration;
  const savedAudio = ctx.audioRoutedToOutput;
  try {
    for (let i = 0; i < K; i++) {
      const values = prepareValues(i, baseValues, lastEmit);
      ctx.iteration = {
        index: i,
        count: K,
        t: K > 1 ? i / (K - 1) : 0,
        random: rMin + hash01(i, seed) * (rMax - rMin),
        runId,
        values,
      };
      const res = evaluateGraph(
        nestedNodes,
        nestedEdges,
        ctx,
        state.cache,
        taps[0].producer.nodeId,
        undefined,
        undefined,
        {
          nested: true,
          extraTargets: taps.slice(1).map((t) => t.producer.nodeId),
        }
      );
      const thisEmit: Record<string, SocketValue> = {};
      if (collectMode === "last") {
        for (const t of state.owned) ctx.releaseTexture(t);
        state.owned = [];
      }
      for (const tap of taps) {
        const out = res.outputs.get(tap.producer.nodeId);
        const v =
          tap.producer.handle === "out:primary"
            ? out?.primary
            : tap.producer.handle.startsWith("out:aux:")
              ? out?.aux?.[tap.producer.handle.slice("out:aux:".length)]
              : undefined;
        if (!v) continue;
        const a = acc.get(tap.socket.name)!;
        if (v.kind === "image") {
          const copy = copyImage(ctx, v as ImageValue);
          a.items.push(copy);
          state.owned.push(copy.texture);
          thisEmit[tap.socket.name] = copy;
        } else if (v.kind === "spline") {
          const subs = tagGroupIndex
            ? v.subpaths.map((sub) => ({ ...sub, groupIndex: i }))
            : v.subpaths.map((sub) => ({ ...sub }));
          if (collectMode === "last") a.subpaths = subs;
          else for (const sub of subs) a.subpaths.push(sub);
          thisEmit[tap.socket.name] = {
            kind: "spline",
            subpaths: subs,
          } satisfies SplineValue;
        } else if (v.kind === "points") {
          const pts = ensurePointArray(v as PointsValue).map((p) =>
            tagGroupIndex ? { ...p, groupIndex: i } : { ...p }
          );
          if (collectMode === "last") a.points = pts;
          else for (const p of pts) a.points.push(p);
          thisEmit[tap.socket.name] = pointsFromArray(pts);
        }
      }
      lastEmit = thisEmit;
    }
  } finally {
    ctx.iteration = savedIteration;
    ctx.audioRoutedToOutput = savedAudio;
  }

  const aux: Record<string, SocketValue> = {};
  for (const s of minted) {
    const a = acc.get(s.name);
    if (!a) {
      aux[s.name] = emptyZoneValue(s.type);
    } else if (s.type === "spline") {
      aux[s.name] = {
        kind: "spline",
        subpaths: a.subpaths,
      } satisfies SplineValue;
    } else if (s.type === "points") {
      aux[s.name] = pointsFromArray(a.points);
    } else if (collectMode === "last") {
      aux[s.name] = a.items[a.items.length - 1] ?? emptyZoneValue(s.type);
    } else {
      aux[s.name] = {
        kind: "image_group",
        items: a.items,
      } satisfies ImageGroupValue;
    }
  }
  return { aux, ownsTextures: false };
}

export function zoneShellInputs(
  params: Record<string, unknown>,
  extra?: { name: string; type: SocketType; required?: boolean; label?: string }[]
): InputSocketDef[] {
  const out: InputSocketDef[] = [];
  if (extra) {
    for (const s of extra) {
      out.push({
        name: s.name,
        type: s.type,
        required: s.required ?? false,
        label: s.label,
      });
    }
  }
  const minted = readBoundarySockets(params);
  for (const s of minted) {
    out.push({ name: s.name, type: s.type as SocketType, required: false });
  }
  out.push({
    name: VIRTUAL_SOCKET,
    type: "image" as SocketType,
    required: false,
  });
  for (const s of readGroupInterface(params).inputs) {
    out.push({
      name: `${ITERATE_PASSTHROUGH_PREFIX}${s.name}`,
      type: s.type as SocketType,
      required: false,
      hidden: true,
    });
  }
  for (const p of ZONE_LOOP_PARAMS) {
    out.push({
      name: `${ITERATE_PARAM_PREFIX}${p}`,
      type: "scalar" as SocketType,
      required: false,
      hidden: true,
    });
  }
  return out;
}
