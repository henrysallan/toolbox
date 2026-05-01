import { coerceValue } from "./coerce";
import { MASK_INPUT_NAME, withMaskInput } from "./conventions";
import { getNodeDef } from "./registry";
import { paramSocketType, parseTargetHandleKind } from "./graph-helpers";
import {
  evaluateKeyframesAt,
  isKeyframable,
  type AnimationMap,
} from "./keyframes";
import type {
  ImageValue,
  MaskValue,
  NodeDefinition,
  NodeOutput,
  ParamType,
  RenderContext,
  ResolveCtx,
  SocketType,
  SocketValue,
} from "./types";

const MASK_APPLY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_base;
uniform sampler2D u_effect;
uniform sampler2D u_mask;
uniform int u_hasBase;
out vec4 outColor;
void main() {
  float m = texture(u_mask, v_uv).r;
  vec4 e = texture(u_effect, v_uv);
  if (u_hasBase == 1) {
    vec4 b = texture(u_base, v_uv);
    outColor = mix(b, e, m);
  } else {
    outColor = vec4(e.rgb * m, e.a * m);
  }
}`;

function applyMask(
  ctx: RenderContext,
  effect: ImageValue,
  mask: MaskValue,
  base: ImageValue | undefined
): ImageValue {
  const out = ctx.allocImage();
  const prog = ctx.getShader("engine/mask", MASK_APPLY_FS);
  ctx.drawFullscreen(prog, out, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    // WebGL requires the sampler to be bound even if we branch it off — use
    // the effect texture as a harmless placeholder when there's no base.
    gl.bindTexture(gl.TEXTURE_2D, base ? base.texture : effect.texture);
    gl.uniform1i(gl.getUniformLocation(prog, "u_base"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, effect.texture);
    gl.uniform1i(gl.getUniformLocation(prog, "u_effect"), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, mask.texture);
    gl.uniform1i(gl.getUniformLocation(prog, "u_mask"), 2);
    gl.uniform1i(gl.getUniformLocation(prog, "u_hasBase"), base ? 1 : 0);
  });
  return out;
}

export interface GraphNode {
  id: string;
  type: string;
  params: Record<string, unknown>;
  // Names of params exposed as input sockets on this node. An exposed param
  // with a connected edge has its value overridden by the incoming signal at
  // compute time.
  exposedParams?: string[];
  // Per-parameter keyframe animation. Wire > keyframes > constant.
  animation?: AnimationMap;
  bypassed?: boolean;
}

export interface GraphEdge {
  id: string;
  source: string;
  sourceHandle: string; // "out:primary" or "out:aux:<name>"
  target: string;
  targetHandle: string; // "in:<socketName>"
}

export interface CachedEntry {
  fingerprint: string;
  output: NodeOutput;
  // Whether this entry owns its primary/aux textures (so we should release
  // them on eviction). Bypass passes through an upstream texture — we don't
  // own it and must not release it.
  ownsTextures: boolean;
}

export type EvalCache = Map<string, CachedEntry>;

// Snapshot of one node's resolved inputs for the data inspector. Outputs
// are already in `EvalResult.outputs`; inputs aren't otherwise retained
// after eval, so we capture them here only for ids the caller asks about.
export interface InspectSnapshot {
  inputs: Record<string, SocketValue | undefined>;
}

export interface EvalResult {
  outputs: Map<string, NodeOutput>;
  terminalImage?: { nodeId: string; image: SocketValue };
  errors: Record<string, string>;
  // Per-node fingerprints this eval produced. Useful for debugging/tools;
  // the evaluator keeps its own authoritative copy inside the cache.
  fingerprints: Map<string, string>;
  // Populated only for node ids passed in via `inspectIds`. Lets the
  // node-inspector popup read live input values without us caching
  // every node's inputs every frame.
  inspectInputs?: Map<string, InspectSnapshot>;
  // Wall-clock duration in milliseconds that each node's compute()
  // call (and downstream mask blend) took on this eval. Cache hits
  // are reported as ~0 since no compute happened. Drives the in-
  // editor "node timing" overlay.
  timings: Map<string, number>;
}

// Stable stringify for params. Sorts object keys, and gives opaque browser
// objects (canvases, bitmaps) a stable WeakMap-backed id token. Primitive and
// array handling is standard; unknown objects fall through to sorted-key
// recursion. Not safe against cycles — params are never cyclic.
const opaqueIds = new WeakMap<object, string>();
let opaqueCounter = 0;
function opaqueId(obj: object, tag: string): string {
  let id = opaqueIds.get(obj);
  if (id == null) {
    id = `${tag}#${++opaqueCounter}`;
    opaqueIds.set(obj, id);
  }
  return id;
}

function stableStringify(v: unknown): string {
  if (v == null) return "_";
  const t = typeof v;
  if (t === "number" || t === "string" || t === "boolean") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  if (typeof ImageBitmap !== "undefined" && v instanceof ImageBitmap) {
    return opaqueId(v, "bmp");
  }
  if (typeof HTMLCanvasElement !== "undefined" && v instanceof HTMLCanvasElement) {
    return opaqueId(v, "cnv");
  }
  if (t === "object") {
    const entries = Object.entries(v as Record<string, unknown>).sort(
      (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
    );
    return (
      "{" +
      entries.map(([k, val]) => JSON.stringify(k) + ":" + stableStringify(val)).join(",") +
      "}"
    );
  }
  return "?";
}

function topoSort(nodes: GraphNode[], edges: GraphEdge[]): string[] {
  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    inDeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of edges) {
    if (!inDeg.has(e.source) || !inDeg.has(e.target)) continue;
    inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1);
    adj.get(e.source)!.push(e.target);
  }
  const queue: string[] = [];
  inDeg.forEach((d, id) => {
    if (d === 0) queue.push(id);
  });
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of adj.get(id) ?? []) {
      inDeg.set(next, (inDeg.get(next) ?? 1) - 1);
      if (inDeg.get(next) === 0) queue.push(next);
    }
  }
  return order;
}

// Compute the set of nodes whose output actually feeds the eval target
// (active node if set, otherwise any terminal node). A disconnected node not
// in this set is skipped entirely — no compute, no texture allocation.
// Exported so callers (export-manifest builder, save flows) can reuse the
// reachability calculation and stay in sync with what the evaluator does.
export function computeNeededSet(
  nodes: GraphNode[],
  edges: GraphEdge[],
  activeNodeId: string | null | undefined
): Set<string> {
  const parents = new Map<string, string[]>();
  for (const e of edges) {
    const list = parents.get(e.target);
    if (list) list.push(e.source);
    else parents.set(e.target, [e.source]);
  }
  const targets = new Set<string>();
  if (activeNodeId) {
    targets.add(activeNodeId);
  } else {
    for (const n of nodes) {
      const d = getNodeDef(n.type);
      if (d?.terminal) targets.add(n.id);
    }
  }
  const needed = new Set<string>(targets);
  const queue = [...targets];
  while (queue.length) {
    const id = queue.shift()!;
    for (const p of parents.get(id) ?? []) {
      if (!needed.has(p)) {
        needed.add(p);
        queue.push(p);
      }
    }
  }
  return needed;
}

function parseSourceHandle(
  handle: string
): { kind: "primary" } | { kind: "aux"; name: string } | null {
  if (handle === "out:primary") return { kind: "primary" };
  if (handle.startsWith("out:aux:"))
    return { kind: "aux", name: handle.slice("out:aux:".length) };
  return null;
}

// Resolve the *socket type* of one of a node's outputs without
// running compute. Used by `connectedTypesFor` so polymorphic nodes
// (Math, Lerp, etc.) can retype their own inputs based on what's
// wired into them. Recurses through resolveOutputType for primary
// outputs whose type itself depends on connected sources — but keeps
// recursion bounded by the topo order: the source has already been
// processed, and we only need its *declared* output type, not a live
// computation.
function resolvePrimaryType(
  def: NodeDefinition,
  params: Record<string, unknown>,
  ctx?: ResolveCtx
): SocketType | null {
  return def.resolvePrimaryOutput?.(params, ctx) ?? def.primaryOutput;
}

function resolveAuxType(
  def: NodeDefinition,
  params: Record<string, unknown>,
  name: string
): SocketType | null {
  const list = def.resolveAuxOutputs?.(params) ?? def.auxOutputs;
  return list.find((a) => a.name === name)?.type ?? null;
}

// Build the connectedTypes map for a target node — for every input
// socket that has a wire, record the source's resolved output type.
// Sources are resolved using their own resolvePrimaryOutput (or a
// previously-cached type from `outputTypeCache` to avoid re-evaluating
// chains of polymorphic nodes).
function connectedTypesFor(
  targetId: string,
  edges: GraphEdge[],
  byId: Map<string, GraphNode>,
  outputTypeCache: Map<string, SocketType | null>
): Record<string, SocketType | undefined> {
  const out: Record<string, SocketType | undefined> = {};
  for (const e of edges) {
    if (e.target !== targetId) continue;
    const tParsed = parseTargetHandleKind(e.targetHandle);
    if (tParsed?.kind !== "input") continue;
    const srcNode = byId.get(e.source);
    if (!srcNode) continue;
    const srcDef = getNodeDef(srcNode.type);
    if (!srcDef) continue;
    const sParsed = parseSourceHandle(e.sourceHandle);
    let t: SocketType | null = null;
    if (sParsed?.kind === "primary") {
      t = outputTypeCache.get(srcNode.id) ?? null;
    } else if (sParsed?.kind === "aux") {
      t = resolveAuxType(srcDef, srcNode.params, sParsed.name);
    }
    if (t) out[tParsed.name] = t;
  }
  return out;
}

// Convert a resolved socket value back into a raw param value (number, bool,
// number[]). Returns undefined if the socket type can't drive the param.
function socketToParamRaw(
  sv: SocketValue,
  paramType: ParamType
): unknown | undefined {
  switch (paramType) {
    case "scalar":
      return sv.kind === "scalar" ? sv.value : undefined;
    case "boolean":
      return sv.kind === "scalar" ? sv.value !== 0 : undefined;
    case "vec2":
      return sv.kind === "vec2" ? [...sv.value] : undefined;
    case "vec3":
      return sv.kind === "vec3" ? [...sv.value] : undefined;
    case "vec4":
    case "color":
      return sv.kind === "vec4" ? [...sv.value] : undefined;
    default:
      return undefined;
  }
}

function releaseCachedTextures(ctx: RenderContext, entry: CachedEntry): void {
  if (!entry.ownsTextures) return;
  const { output } = entry;
  if (output.primary && "texture" in output.primary) {
    ctx.releaseTexture(output.primary.texture);
  }
  if (output.aux) {
    for (const v of Object.values(output.aux)) {
      if (v && "texture" in v) ctx.releaseTexture(v.texture);
    }
  }
}

function computeNodeFingerprint(
  node: GraphNode,
  def: NodeDefinition,
  inputFps: string[],
  ctx: RenderContext
): string {
  const parts: string[] = [
    node.type,
    node.bypassed ? "B" : "C",
    stableStringify(node.params),
    inputFps.join("|"),
  ];
  if (node.animation) parts.push("a:" + stableStringify(node.animation));
  if (def.stable === false) parts.push("t:" + ctx.time);
  // External-state hook (e.g. the Cursor node mixing in live pointer pos).
  // Runs after the stable-false time stamp so both signals contribute.
  const extras = def.fingerprintExtras?.(node.params, ctx);
  if (extras) parts.push(extras);
  return parts.join("::");
}

export function evaluateGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  ctx: RenderContext,
  cache: EvalCache,
  activeNodeId?: string | null,
  inspectIds?: ReadonlySet<string>
): EvalResult {
  const order = topoSort(nodes, edges);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outputs = new Map<string, NodeOutput>();
  const errors: Record<string, string> = {};
  const fingerprints = new Map<string, string>();
  const timings = new Map<string, number>();
  // Only populated when inspectIds is non-empty; left undefined otherwise
  // so callers can do a cheap presence check.
  const inspectInputs =
    inspectIds && inspectIds.size > 0
      ? new Map<string, InspectSnapshot>()
      : undefined;
  let terminalImage: EvalResult["terminalImage"];
  const needed = computeNeededSet(nodes, edges, activeNodeId);
  // Cache of resolved primary output types in topo order. Used by
  // `connectedTypesFor` so polymorphic nodes (Math, Lerp, …) can
  // reshape their own sockets based on what's wired into them.
  const outputTypeCache = new Map<string, SocketType | null>();

  for (const id of order) {
    if (!needed.has(id)) continue;
    const node = byId.get(id);
    if (!node) continue;
    const def = getNodeDef(node.type);
    if (!def) {
      errors[id] = `Unknown node type: ${node.type}`;
      continue;
    }

    const inputs: Record<string, SocketValue | undefined> = {};
    const auxIn: Record<string, Record<string, SocketValue | undefined>> = {};
    const inputFpParts: string[] = [];

    // Build the resolve-context for this node — connected source
    // types per input socket. Used by polymorphic nodes that need to
    // know what's wired before they declare their own socket types
    // and primary output type.
    const connectedTypes = connectedTypesFor(
      id,
      edges,
      byId,
      outputTypeCache
    );
    const resolveCtx: ResolveCtx = { connectedTypes };

    const defInputs = withMaskInput(
      def.resolveInputs?.(node.params, resolveCtx) ?? def.inputs
    );
    for (const inputDef of defInputs) {
      const incoming = edges.find((e) => {
        if (e.target !== id) return false;
        const parsed = parseTargetHandleKind(e.targetHandle);
        return parsed?.kind === "input" && parsed.name === inputDef.name;
      });
      auxIn[inputDef.name] = {};
      if (!incoming) {
        inputs[inputDef.name] = inputDef.defaultValue;
        inputFpParts.push(`${inputDef.name}=_`);
        continue;
      }
      const srcOut = outputs.get(incoming.source);
      const srcFp = fingerprints.get(incoming.source) ?? "_";
      if (!srcOut) {
        inputs[inputDef.name] = inputDef.defaultValue;
        inputFpParts.push(`${inputDef.name}=_`);
        continue;
      }
      const parsed = parseSourceHandle(incoming.sourceHandle);
      let raw: SocketValue | undefined;
      let handleTag = "";
      if (parsed?.kind === "primary") {
        raw = srcOut.primary;
        handleTag = "p";
      } else if (parsed?.kind === "aux") {
        raw = srcOut.aux?.[parsed.name];
        handleTag = "a:" + parsed.name;
      }
      inputs[inputDef.name] = coerceValue(raw, inputDef.type, ctx);
      if (srcOut.aux) auxIn[inputDef.name] = srcOut.aux;
      inputFpParts.push(`${inputDef.name}=${srcFp}/${handleTag}`);
    }

    // Resolve exposed-param overrides. Each exposed param with a connected
    // edge substitutes its value into the params map passed to compute.
    // Disconnected exposed params are no-ops (just a visible socket on the
    // node). FP includes a per-param entry so (connect/disconnect) and
    // (source value change) both bust correctly.
    const paramOverrides: Record<string, unknown> = {};
    const exposedParams = node.exposedParams ?? [];
    for (const pname of exposedParams) {
      const pdef = def.params.find((p) => p.name === pname);
      if (!pdef) continue;
      const socketType = paramSocketType(pdef.type);
      if (!socketType) continue;
      const incoming = edges.find((e) => {
        if (e.target !== id) return false;
        const parsed = parseTargetHandleKind(e.targetHandle);
        return parsed?.kind === "param" && parsed.name === pname;
      });
      if (!incoming) {
        inputFpParts.push(`param:${pname}=_`);
        continue;
      }
      const srcOut = outputs.get(incoming.source);
      const srcFp = fingerprints.get(incoming.source) ?? "_";
      if (!srcOut) {
        inputFpParts.push(`param:${pname}=_`);
        continue;
      }
      const parsed = parseSourceHandle(incoming.sourceHandle);
      let raw: SocketValue | undefined;
      let handleTag = "";
      if (parsed?.kind === "primary") {
        raw = srcOut.primary;
        handleTag = "p";
      } else if (parsed?.kind === "aux") {
        raw = srcOut.aux?.[parsed.name];
        handleTag = "a:" + parsed.name;
      }
      inputFpParts.push(`param:${pname}=${srcFp}/${handleTag}`);
      const coerced = coerceValue(raw, socketType, ctx);
      if (coerced) {
        const rawValue = socketToParamRaw(coerced, pdef.type);
        if (rawValue !== undefined) paramOverrides[pname] = rawValue;
      }
    }

    // Resolve per-parameter keyframe animation. A param wins from
    // wire > keyframe > constant, so we only evaluate keyframes for
    // params that did NOT get a wire override above. The animation
    // block contributes to the fingerprint via `tick` so caches bust on
    // playhead movement (only when at least one param is animated; an
    // unanimated node stays cacheable across frames).
    const animation = node.animation;
    const keyframeOverrides: Record<string, unknown> = {};
    if (animation) {
      let anyAnimated = false;
      for (const pdef of def.params) {
        if (!isKeyframable(pdef.type)) continue;
        if (paramOverrides[pdef.name] !== undefined) continue; // wire wins
        const block = animation[pdef.name];
        if (!block || !block.animated || block.keyframes.length === 0) continue;
        anyAnimated = true;
        const v = evaluateKeyframesAt(block, pdef.type, ctx.tick);
        if (v !== undefined) keyframeOverrides[pdef.name] = v;
      }
      if (anyAnimated) {
        // Tick + animated-param-name list are enough — values are
        // determined by (tick, keyframes) and keyframes already
        // contribute via stableStringify(node.animation) below.
        inputFpParts.push(`anim:${ctx.tick}`);
      }
    }

    const effectiveParams =
      Object.keys(paramOverrides).length > 0 ||
      Object.keys(keyframeOverrides).length > 0
        ? { ...node.params, ...keyframeOverrides, ...paramOverrides }
        : node.params;

    // Snapshot inputs for inspected nodes BEFORE compute runs. The
    // SocketValue objects (textures included) are still alive at this
    // point — the inspector reads them on the same frame, so no extra
    // ref-counting is needed.
    if (inspectInputs && inspectIds!.has(id)) {
      inspectInputs.set(id, { inputs: { ...inputs } });
    }

    const fingerprint = computeNodeFingerprint(node, def, inputFpParts, ctx);
    fingerprints.set(id, fingerprint);

    const prev = cache.get(id);
    const cacheable = def.stable !== false && !node.bypassed;

    let result: NodeOutput;

    if (cacheable && prev && prev.fingerprint === fingerprint) {
      // Cache hit — reuse the previous output verbatim. Its textures are
      // still alive (not released since we didn't evict).
      result = prev.output;
      outputs.set(id, result);
      outputTypeCache.set(id, resolvePrimaryType(def, node.params, resolveCtx));
      // Cache hit means no compute ran — surface 0 so the overlay
      // shows the node as cheap rather than persisting an old timing.
      timings.set(id, 0);
    } else {
      // Cache miss (or uncacheable): recompute. Wall-clock around the
      // whole branch (compute + mask blend) — this is what the user
      // actually pays for on this eval. GPU work might still be
      // pending after compute returns; CPU dispatch time is what we
      // can measure cheaply without forcing a sync.
      const tStart = performance.now();
      try {
        let ownsTextures = true;
        if (node.bypassed) {
          // Pass-through: primary output = primary input (first input socket).
          // We don't own the upstream texture, so this entry must not release
          // on eviction.
          const firstInput = defInputs[0]?.name;
          const passthrough = firstInput ? inputs[firstInput] : undefined;
          result = passthrough ? { primary: passthrough } : {};
          ownsTextures = false;
        } else {
          result = def.compute({
            inputs,
            auxIn,
            params: effectiveParams,
            ctx,
            nodeId: id,
          }) ?? {};
        }

        // Apply the universal mask input after compute. Not applied to
        // bypassed nodes or when result has no image primary. With a base
        // image input present, masks blend between base and effect; without
        // one (pure sources), the mask multiplies the output.
        const maskIn = inputs[MASK_INPUT_NAME];
        if (
          !node.bypassed &&
          maskIn &&
          maskIn.kind === "mask" &&
          result.primary &&
          result.primary.kind === "image"
        ) {
          const firstImgInput = defInputs.find(
            (i) => i.type === "image" && i.name !== MASK_INPUT_NAME
          );
          const base = firstImgInput ? inputs[firstImgInput.name] : undefined;
          const baseImg =
            base && base.kind === "image" ? (base as ImageValue) : undefined;
          const masked = applyMask(ctx, result.primary, maskIn, baseImg);
          ctx.releaseTexture(result.primary.texture);
          result = { ...result, primary: masked };
        }

        outputs.set(id, result);
        outputTypeCache.set(id, resolvePrimaryType(def, node.params, resolveCtx));

        if (cacheable) {
          if (prev) releaseCachedTextures(ctx, prev);
          cache.set(id, { fingerprint, output: result, ownsTextures });
        } else if (prev) {
          // No longer cacheable (e.g., user toggled bypass on). Evict.
          releaseCachedTextures(ctx, prev);
          cache.delete(id);
        }
      } catch (e) {
        errors[id] = e instanceof Error ? e.message : String(e);
        // eslint-disable-next-line no-console
        console.error(
          `[eval] node ${id} (${node.type}) compute threw:`,
          e
        );
        result = {};
        outputs.set(id, result);
        outputTypeCache.set(id, resolvePrimaryType(def, node.params, resolveCtx));
        if (prev) {
          releaseCachedTextures(ctx, prev);
          cache.delete(id);
        }
      }
      timings.set(id, performance.now() - tStart);
    }

    // Terminal preview selection. Same semantics as before: active override
    // wins; otherwise the first terminal node's first-input image is shown.
    if (activeNodeId && id === activeNodeId) {
      const img = result.primary ?? inputs[defInputs[0]?.name ?? ""];
      if (img && img.kind === "image") {
        terminalImage = { nodeId: id, image: img };
      }
    } else if (!activeNodeId && def.terminal) {
      const firstInput = defInputs[0]?.name;
      const img = firstInput ? inputs[firstInput] : undefined;
      if (img && img.kind === "image") {
        terminalImage = { nodeId: id, image: img };
      }
    }
  }

  // Evict cache entries for nodes that no longer exist in the graph. Nodes
  // that still exist but weren't evaluated this pass (not in `needed`) keep
  // their cache — they may re-enter the needed set later and their FP will
  // be rechecked then.
  for (const [id, entry] of cache) {
    if (!byId.has(id)) {
      releaseCachedTextures(ctx, entry);
      cache.delete(id);
    }
  }

  return { outputs, terminalImage, errors, fingerprints, timings, inspectInputs };
}
