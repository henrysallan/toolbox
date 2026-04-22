import { coerceValue } from "./coerce";
import { MASK_INPUT_NAME, withMaskInput } from "./conventions";
import { getNodeDef } from "./registry";
import { paramSocketType, parseTargetHandleKind } from "@/state/graph";
import type {
  ImageValue,
  MaskValue,
  NodeDefinition,
  NodeOutput,
  ParamType,
  RenderContext,
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

export interface EvalResult {
  outputs: Map<string, NodeOutput>;
  terminalImage?: { nodeId: string; image: SocketValue };
  errors: Record<string, string>;
  // Per-node fingerprints this eval produced. Useful for debugging/tools;
  // the evaluator keeps its own authoritative copy inside the cache.
  fingerprints: Map<string, string>;
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
function computeNeededSet(
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
  time: number
): string {
  const parts: string[] = [
    node.type,
    node.bypassed ? "B" : "C",
    stableStringify(node.params),
    inputFps.join("|"),
  ];
  if (def.stable === false) parts.push("t:" + time);
  return parts.join("::");
}

export function evaluateGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  ctx: RenderContext,
  cache: EvalCache,
  activeNodeId?: string | null
): EvalResult {
  const order = topoSort(nodes, edges);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outputs = new Map<string, NodeOutput>();
  const errors: Record<string, string> = {};
  const fingerprints = new Map<string, string>();
  let terminalImage: EvalResult["terminalImage"];
  const needed = computeNeededSet(nodes, edges, activeNodeId);

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

    const defInputs = withMaskInput(
      def.resolveInputs?.(node.params) ?? def.inputs
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

    const effectiveParams =
      Object.keys(paramOverrides).length > 0
        ? { ...node.params, ...paramOverrides }
        : node.params;

    const fingerprint = computeNodeFingerprint(node, def, inputFpParts, ctx.time);
    fingerprints.set(id, fingerprint);

    const prev = cache.get(id);
    const cacheable = def.stable !== false && !node.bypassed;

    let result: NodeOutput;

    if (cacheable && prev && prev.fingerprint === fingerprint) {
      // Cache hit — reuse the previous output verbatim. Its textures are
      // still alive (not released since we didn't evict).
      result = prev.output;
      outputs.set(id, result);
    } else {
      // Cache miss (or uncacheable): recompute.
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
        result = {};
        outputs.set(id, result);
        if (prev) {
          releaseCachedTextures(ctx, prev);
          cache.delete(id);
        }
      }
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

  return { outputs, terminalImage, errors, fingerprints };
}
