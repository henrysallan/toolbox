import { coerceValue } from "./coerce";
import {
  colorValueToHex,
  GPOINT_C_PREFIX,
  GPOINT_X_PREFIX,
  GPOINT_Y_PREFIX,
  LAYER_OPACITY_PREFIX,
  MASK_INPUT_NAME,
  parseRampParamKey,
  rampFieldSocketType,
  resolveAnchorTracks,
  withMaskInput,
  type RampStopField,
} from "./conventions";
import { getNodeDef } from "./registry";
import { flattenGraph, resolvePreviewProducer } from "./flatten";
import { ITERATE_EDGE_PREFIX, ITERATE_TYPE, LAYER_TYPE } from "./groups";
import { paramSocketType, parseTargetHandleKind } from "./graph-helpers";
import {
  evaluateKeyframesAt,
  isKeyframable,
  type AnimationMap,
} from "./keyframes";
import {
  clipLocalTick,
  emptyClipOutput,
  isTimeDrivenClip,
  resolveClipAt,
  type ClipBlock,
} from "./clips";
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
  SplineSubpath,
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

const OPACITY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform float u_opacity;
out vec4 outColor;
void main() {
  vec4 c = texture(u_src, v_uv);
  // Straight (non-premultiplied) alpha convention — fade alpha only.
  outColor = vec4(c.rgb, c.a * u_opacity);
}`;

function applyOpacity(
  ctx: RenderContext,
  src: ImageValue,
  opacity: number
): ImageValue {
  const out = ctx.allocImage({ width: src.width, height: src.height });
  const prog = ctx.getShader("engine/opacity", OPACITY_FS);
  ctx.drawFullscreen(prog, out, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.texture);
    gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
    gl.uniform1f(gl.getUniformLocation(prog, "u_opacity"), opacity);
  });
  return out;
}

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
  // Group nesting (id of the enclosing node-group; undefined = root).
  // Evaluation itself ignores scope — the flatten pass dissolves group
  // boundaries before this graph reaches evaluateGraph.
  parentId?: string;
  params: Record<string, unknown>;
  // Names of params exposed as input sockets on this node. An exposed param
  // with a connected edge has its value overridden by the incoming signal at
  // compute time.
  exposedParams?: string[];
  // Per-parameter keyframe animation. Wire > keyframes > constant.
  animation?: AnimationMap;
  // Timeline clip windows (in/out gates + optional local-time remap). See
  // clips.ts.
  clips?: ClipBlock[];
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

// Textures produced by UNCACHEABLE nodes (stable:false, bypassed) this eval.
// They never enter the cache, so eviction can't release them — without this
// they'd only be reclaimed when the JS GC happens to collect the wrapper
// (a playing Video Source orphans a full-canvas texture EVERY eval). They
// must survive until the frame is blitted, so each eval releases the
// PREVIOUS eval's set on entry. Keyed per cache so split-viewport / offline
// evals don't release each other's textures mid-frame; entries die with
// their cache (backend swap discards both cache and GL context together).
const transientsByCache = new WeakMap<EvalCache, WebGLTexture[]>();

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
  // Encoded media bytes (EXR stills, sequence frames): identity token, like
  // bitmaps — re-picking a file must re-fingerprint even when the metadata
  // around it (filename/dims/layers) happens to match.
  if (typeof Blob !== "undefined" && v instanceof Blob) {
    return opaqueId(v, "blob");
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
// Read a specific output handle ("out:primary" / "out:aux:<name>") off a
// node result, returning it only when it holds an image. Lets the preview
// path show the exact output a group's image socket was fed from after a
// structural Active/preview target is remapped to its interior producer.
function pickHandleImage(
  result: NodeOutput,
  handle: string | undefined
): SocketValue | undefined {
  if (!handle) return undefined;
  const v =
    handle === "out:primary"
      ? result.primary
      : handle.startsWith("out:aux:")
        ? result.aux?.[handle.slice("out:aux:".length)]
        : undefined;
  return v && v.kind === "image" ? v : undefined;
}

export function computeNeededSet(
  nodes: GraphNode[],
  edges: GraphEdge[],
  activeNodeId: string | null | undefined,
  // Extra nodes to evaluate even when they don't feed the active/terminal
  // node — e.g. a selected node we want to preview on its own.
  extraTargets?: Iterable<string>
): Set<string> {
  // `render` edges (Output → Render Queue) are organizational, not data —
  // they must NOT pull the wired Output chains into evaluation just because
  // the queue is a target. Identify queue nodes and skip every edge into
  // them (the queue only has `render` inputs, so this drops exactly the
  // render links).
  const renderQueueIds = new Set(
    nodes
      .filter((n) => getNodeDef(n.type)?.type === "render-queue")
      .map((n) => n.id)
  );
  const parents = new Map<string, string[]>();
  for (const e of edges) {
    if (renderQueueIds.has(e.target)) continue;
    const list = parents.get(e.target);
    if (list) list.push(e.source);
    else parents.set(e.target, [e.source]);
  }
  const byId = new Set(nodes.map((n) => n.id));
  const targets = new Set<string>();
  if (activeNodeId) {
    targets.add(activeNodeId);
  } else {
    for (const n of nodes) {
      const d = getNodeDef(n.type);
      if (d?.terminal) targets.add(n.id);
    }
  }
  if (extraTargets) {
    for (const id of extraTargets) if (byId.has(id)) targets.add(id);
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
  paramType: ParamType,
  alphaColor = false
): unknown | undefined {
  switch (paramType) {
    case "scalar":
      return sv.kind === "scalar" ? sv.value : undefined;
    case "boolean":
      return sv.kind === "scalar" ? sv.value !== 0 : undefined;
    case "string":
      return sv.kind === "string" ? sv.value : undefined;
    case "vec2":
      return sv.kind === "vec2" ? [...sv.value] : undefined;
    case "vec3":
      return sv.kind === "vec3" ? [...sv.value] : undefined;
    case "vec4":
      return sv.kind === "vec4" ? [...sv.value] : undefined;
    case "color":
      // Color params store hex — normalize the wired vec4 so compute
      // functions never see a tuple (they'd crash on hexToRgba et al).
      // The tuple's alpha survives as `#rrggbbaa` only for defs that
      // opt in (`ParamDef.alpha`); everywhere else it's dropped.
      return sv.kind === "vec4"
        ? colorValueToHex([...sv.value], "#000000", alphaColor)
        : undefined;
    case "color_ramp":
      // The param stores a bare ColorRampStop[] and every consumer reads it
      // with Array.isArray — so hand back the stops verbatim, not the
      // ColorRampValue wrapper. The wire's `interp` is dropped here; see the
      // note on ColorRampValue (types.ts) for why, and what would change it.
      return sv.kind === "color_ramp" ? sv.stops : undefined;
    default:
      return undefined;
  }
}

// Tear down per-node persistent state (`ctx.state["<type>:<nodeId>"]`, per
// the convention in types.ts) for nodes NOT in `keep` — or for every node
// when `keep` is null. Runs the def's `dispose` (which frees GL textures,
// DOM canvases, media elements), then deletes any leftover keys for that
// node so the sweep converges even if a dispose is incomplete. Keys whose
// first segment isn't a registered node type (engine-internal `__…__` keys,
// `sim-zone:<zoneId>` shared state) are left alone.
// Colon-bearing state prefixes that are deliberately NOT node types (so a
// getNodeDef miss on them is expected, not a bug). `sim-zone:<zoneId>` is
// shared Start/End feedback state; `__…__` engine-internal keys are filtered
// earlier by the no-colon check but are listed for future colon-bearing ones.
const KNOWN_NON_TYPE_STATE_PREFIXES = new Set(["sim-zone"]);
// Dedup the "unregistered prefix" warning so the per-eval sweep logs each
// offending prefix at most once per session.
const warnedUnknownStatePrefixes = new Set<string>();

function sweepNodeState(
  ctx: RenderContext,
  keep: ReadonlySet<string> | null
): void {
  const state = ctx.state as Record<string, unknown>;
  const disposed = new Set<string>();
  for (const key of Object.keys(state)) {
    const i = key.indexOf(":");
    if (i <= 0) continue;
    const type = key.slice(0, i);
    const rest = key.slice(i + 1);
    const j = rest.indexOf(":");
    const nodeId = j === -1 ? rest : rest.slice(0, j);
    if (!nodeId || (keep && keep.has(nodeId))) continue;
    const def = getNodeDef(type);
    if (!def) {
      // A state key whose first segment resolves to no node type means its
      // dispose can NEVER run (this sweep is the only dispose call site) — a
      // silent per-node resource leak. That's exactly how the particle sim's
      // `particle-sim:`/`particle-sim-webgpu:` keys leaked GPU state before
      // 072226. Warn once so the next such convention break is loud.
      if (
        !type.startsWith("__") &&
        !KNOWN_NON_TYPE_STATE_PREFIXES.has(type) &&
        !warnedUnknownStatePrefixes.has(type)
      ) {
        warnedUnknownStatePrefixes.add(type);
        console.warn(
          `[eval] ctx.state key prefix "${type}:" is not a registered node ` +
            `type — its dispose will never run (resource leak). State keys must ` +
            `be "<nodeType>:<nodeId>" (see types.ts) or an allowlisted shared ` +
            `prefix.`
        );
      }
      continue;
    }
    const pairKey = `${type}:${nodeId}`;
    if (disposed.has(pairKey)) continue;
    disposed.add(pairKey);
    try {
      def.dispose?.(ctx, nodeId);
    } catch (e) {
      console.error(`[eval] dispose failed for ${pairKey}:`, e);
    }
    for (const k of Object.keys(state)) {
      if (k === pairKey || k.startsWith(pairKey + ":")) delete state[k];
    }
  }
}

// Full teardown of all per-node state — call before discarding a backend
// (resolution change, editor unmount) so DOM-side resources (Text's hidden
// canvases, media elements) don't outlive the GL context they belonged to.
export function disposeAllNodeState(ctx: RenderContext): void {
  sweepNodeState(ctx, null);
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
  ctx: RenderContext,
  clipFp: string
): string {
  const parts: string[] = [
    node.type,
    node.bypassed ? "B" : "C",
    stableStringify(node.params),
    inputFps.join("|"),
  ];
  // A gated clip makes the output an empty value regardless of params/inputs;
  // marking it keeps the gated output cached (stable while gated) and forces
  // a recompute when the playhead re-enters the window. Active time-driven
  // clips need no marker — their local clock already rides ctx.time via the
  // stable:false stamp below.
  if (clipFp) parts.push(clipFp);
  if (node.animation) parts.push("a:" + stableStringify(node.animation));
  if (def.stable === false) parts.push("t:" + ctx.time);
  // External-state hook (e.g. the Cursor node mixing in live pointer pos).
  // Runs after the stable-false time stamp so both signals contribute.
  const extras = def.fingerprintExtras?.(node.params, ctx, node.id);
  if (extras) parts.push(extras);
  return parts.join("::");
}

// ctx.state key under which the evaluator stashes each Iterate shell's
// interior subgraph + fingerprint hash for the shell's compute /
// fingerprintExtras to read. The colon-free key is invisible to
// sweepNodeState. See specdocs/071826_iterate-node.md.
export const ITERATE_STASH_KEY = "__iterate-interiors__";
export type IterateStash = Map<
  string,
  { nodes: GraphNode[]; edges: GraphEdge[]; hash: string }
>;

// Release everything a private (nested-eval) cache holds: cached owned
// textures plus the last eval's transient set. Used by the Iterate
// shell's dispose — the outer evaluator's eviction never sees private
// caches.
export function disposeEvalCache(ctx: RenderContext, cache: EvalCache): void {
  const transients = transientsByCache.get(cache);
  if (transients) {
    for (const t of transients) ctx.releaseTexture(t);
    transientsByCache.delete(cache);
  }
  for (const entry of cache.values()) {
    releaseCachedTextures(ctx, entry);
  }
  cache.clear();
}

export function evaluateGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  ctx: RenderContext,
  cache: EvalCache,
  activeNodeId?: string | null,
  inspectIds?: ReadonlySet<string>,
  // Optional node to also evaluate (so its output is available even when it
  // isn't wired to a terminal) — used to preview the selected node.
  previewNodeId?: string | null,
  // nested: this is an Iterate shell's private interior evaluation. Skips
  // the global side effects that belong to the outer pass only: the
  // end-of-eval state sweep (its keep-set would be just the interior ids,
  // disposing every other node's state) and audio routing.
  // extraTargets: additional node ids to force into the needed set (and
  // mark output-consumed) — the Iterate shell's multi-socket collection
  // evaluates several tap producers in one pass.
  // extraConsumed: specific output handles ("primary" / "aux:<name>") to
  // mark consumed beyond what wires imply — the socket-peek popover reads
  // an output that may be unwired, and consumedOutputs-gating nodes (Text)
  // would otherwise skip building it.
  opts?: {
    nested?: boolean;
    extraTargets?: string[];
    extraConsumed?: ReadonlyMap<string, readonly string[]>;
  }
): EvalResult {
  const nested = opts?.nested === true;
  const extraTargets = opts?.extraTargets ?? [];
  // Group shells and Group Output boundary nodes are dissolved by flatten,
  // so previewing one directly shows nothing on the canvas. Remap a
  // structural Active / preview target to the interior producer feeding the
  // group's image output — BEFORE flatten and the needed-set, so that branch
  // evaluates even when the group isn't wired to an Output yet. `*Handle`
  // remembers the exact output that fed the group's image socket.
  // Pre-flatten node-id set — the reference for "does this node still
  // exist" in the end-of-eval state sweep (flatten dissolves group shells,
  // so the post-flatten array under-counts live nodes).
  const presentIds = new Set(nodes.map((n) => n.id));

  // Release the previous eval's uncacheable-output textures (see
  // transientsByCache). Their consumers (downstream computes, the blit)
  // all finished within that eval, so this is the earliest safe point.
  const prevTransients = transientsByCache.get(cache);
  if (prevTransients) {
    for (const t of prevTransients) ctx.releaseTexture(t);
  }
  const evalTransients: WebGLTexture[] = [];
  transientsByCache.set(cache, evalTransients);

  let activeHandle: string | undefined;
  let previewHandle: string | undefined;
  if (activeNodeId) {
    const remap = resolvePreviewProducer(nodes, edges, activeNodeId);
    if (remap) {
      activeNodeId = remap.nodeId;
      activeHandle = remap.handle;
    }
  }
  if (previewNodeId) {
    const remap = resolvePreviewProducer(nodes, edges, previewNodeId);
    if (remap) {
      previewNodeId = remap.nodeId;
      previewHandle = remap.handle;
    }
  }

  // Dissolve group structure first — groups are transparent at eval
  // time (see flatten.ts). No-op (same arrays back) for structure-free
  // graphs. `layerOf` maps interior nodes to their enclosing layer for
  // AE-style local time.
  const flat = flattenGraph(nodes, edges);
  nodes = flat.nodes;
  const layerOf = flat.layerOf;

  // Stash Iterate interiors for the shells' computes, with a hash the
  // shell's fingerprintExtras folds in — the shell's own fingerprint
  // can't see interior params, so interior edits must bust it here.
  // Time joins the hash when the interior is time-driven (a stable:false
  // def, or any keyframed interior node) so animation inside an Iterate
  // advances at an honest K× cost while static interiors stay cached.
  if (flat.iterateInteriors) {
    // Outer pass: fresh map (stale shells drop). Nested pass that itself
    // contains Iterate shells (a nested Iterate — rejected at compute, but
    // present structurally): MERGE into the outer stash rather than
    // clobbering it mid-outer-eval.
    const existing = nested
      ? (ctx.state[ITERATE_STASH_KEY] as IterateStash | undefined)
      : undefined;
    const stash: IterateStash = existing ?? new Map();
    for (const [shellId, interior] of flat.iterateInteriors) {
      const parts: string[] = [];
      let timeDriven = false;
      for (const n of interior.nodes) {
        parts.push(
          n.id,
          n.type,
          n.bypassed ? "B" : "C",
          stableStringify(n.params),
          n.animation ? "a:" + stableStringify(n.animation) : "_"
        );
        if (getNodeDef(n.type)?.stable === false) timeDriven = true;
        if (n.animation) {
          for (const block of Object.values(n.animation)) {
            if (block?.animated && block.keyframes.length > 0) {
              timeDriven = true;
              break;
            }
          }
        }
      }
      for (const e of interior.edges) {
        parts.push(e.source, e.sourceHandle, e.target, e.targetHandle);
      }
      if (timeDriven) parts.push("t:" + ctx.tick);
      stash.set(shellId, { ...interior, hash: parts.join("|") });
    }
    ctx.state[ITERATE_STASH_KEY] = stash;
  } else if (!nested) {
    delete ctx.state[ITERATE_STASH_KEY];
  }

  // Per-layer time offset for this pass, from the layer's clip windows:
  // interior local time is `globalTick − inTick + sourceInTick` of the
  // active (or nearest) window, so sliding a layer slides its interior
  // animation. Layers outside every window are gated: the layer node
  // passes its stack through, and dropping its `content` edge here
  // removes the whole interior from the needed set for free.
  //
  // PRE-ROLL: a gated layer whose next window starts within
  // PREROLL_SECONDS keeps its `content` edge, so its interior evaluates
  // invisibly ahead of the cut — with the interior clock PINNED to the
  // window's entry tick (its sourceInTick) and ctx.preroll set. Media
  // park exactly on the first frame the cut reveals (Video seeks once,
  // paused; Audio holds paused at the entry point), shaders compile, and
  // cacheable nodes fingerprint at the fixed entry tick so they compute
  // once and cache-hit until the cut. Without this every cut evaluated
  // the incoming interior cold and hard-seeked its videos exactly at the
  // boundary — visible dropped frames. The layer shell itself stays a
  // gated passthrough, so nothing shows early.
  const PREROLL_SECONDS = 0.5;
  // A nested pass (Iterate interiors) has no layers of its own, but the
  // shell may itself be computing inside a pre-rolling layer — its members
  // must inherit the flag or a video member would play during pre-roll.
  const inheritedPreroll = nested && ctx.preroll === true;
  const layerOffsets = new Map<string, number>();
  const gatedLayers = new Set<string>();
  // Layer id → interior entry tick of the upcoming window being pre-rolled.
  const prerollLayers = new Map<string, number>();
  const prerollTicks = Math.round(
    PREROLL_SECONDS * ctx.fps * ctx.ticksPerFrame
  );
  for (const n of nodes) {
    if (n.type !== LAYER_TYPE) continue;
    const res = resolveClipAt(n.clips, ctx.tick);
    if (res.gated) gatedLayers.add(n.id);
    // Clock reference: the active window, else the next upcoming enabled
    // window (so gated interiors — pre-roll, attribute exports — run on
    // the clock of the window they're about to enter), else the last one
    // behind the playhead.
    let ref = res.active;
    if (!ref) {
      let next: ClipBlock | undefined;
      let last: ClipBlock | undefined;
      for (const c of n.clips ?? []) {
        if (!c.enabled) continue;
        if (c.inTick > ctx.tick) {
          if (!next || c.inTick < next.inTick) next = c;
        } else if (!last || c.inTick > last.inTick) {
          last = c;
        }
      }
      ref = next ?? last;
      if (res.gated && next && next.inTick - ctx.tick <= prerollTicks) {
        prerollLayers.set(n.id, next.sourceInTick);
      }
    }
    layerOffsets.set(n.id, ref ? ref.inTick - ref.sourceInTick : 0);
  }
  edges =
    gatedLayers.size === 0
      ? flat.edges
      : flat.edges.filter(
          (e) =>
            !(
              // Both edges flatten pushes from a Layer Output onto the layer
              // shell: the blend content and the vector export tap. A gated
              // layer shows nothing, so neither interior branch should be
              // kept alive (gatedLayers holds layer ids only, so this can't
              // catch another node type's `in:spline`).
              ((e.targetHandle === "in:content" ||
                e.targetHandle === "in:spline") &&
                gatedLayers.has(e.target) &&
                !prerollLayers.has(e.target))
            )
        );

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
  const needed = computeNeededSet(
    nodes,
    edges,
    activeNodeId,
    previewNodeId || extraTargets.length > 0
      ? [...(previewNodeId ? [previewNodeId] : []), ...extraTargets]
      : undefined
  );

  // Per-node set of output handles ("primary" / "aux:<name>") that
  // something consumes this eval: any output wired to a node that will be
  // evaluated, plus the primary/image of whatever the viewport shows.
  // Lets nodes skip expensive outputs nobody reads (see ComputeArgs.
  // consumedOutputs — Text's SDF/spline are the motivating case).
  const consumedOutputs = new Map<string, Set<string>>();
  const markConsumed = (nodeId: string, key: string) => {
    let set = consumedOutputs.get(nodeId);
    if (!set) {
      set = new Set();
      consumedOutputs.set(nodeId, set);
    }
    set.add(key);
  };
  for (const e of edges) {
    if (!needed.has(e.target)) continue;
    const ps = parseSourceHandle(e.sourceHandle);
    if (!ps) continue;
    markConsumed(e.source, ps.kind === "primary" ? "primary" : `aux:${ps.name}`);
  }
  // The active / preview node's image is shown directly (no edge needed),
  // so its primary and any image aux count as consumed for display. Extra
  // targets (Iterate collection taps) are read the same way.
  for (const id of [activeNodeId, previewNodeId, ...extraTargets]) {
    if (!id) continue;
    markConsumed(id, "primary");
    markConsumed(id, "aux:image");
  }
  if (opts?.extraConsumed) {
    for (const [nodeId, keys] of opts.extraConsumed) {
      for (const k of keys) markConsumed(nodeId, k);
    }
  }

  // Audio sources whose primary output is wired into an Output node's
  // `audio` socket. Only these play audibly; every other audio source
  // keeps advancing its element (for data) but stays muted. Recomputed
  // each eval so re-wiring takes effect immediately.
  if (!nested) {
    const audioRoutedToOutput = new Set<string>();
    for (const e of edges) {
      if (e.targetHandle !== "in:audio") continue;
      // Audio Source emits audio on its primary; Video Source emits it on an
      // `audio` aux output. Both un-mute only when wired here.
      if (
        e.sourceHandle !== "out:primary" &&
        e.sourceHandle !== "out:aux:audio"
      ) {
        continue;
      }
      const target = byId.get(e.target);
      if (target && getNodeDef(target.type)?.type === "output") {
        audioRoutedToOutput.add(e.source);
      }
    }
    ctx.audioRoutedToOutput = audioRoutedToOutput;
  }
  // Cache of resolved primary output types in topo order. Used by
  // `connectedTypesFor` so polymorphic nodes (Math, Lerp, …) can
  // reshape their own sockets based on what's wired into them.
  const outputTypeCache = new Map<string, SocketType | null>();

  // Global clock for this pass. Clipped time-driven nodes temporarily
  // override ctx.tick/time/frame with a clip-local clock during their own
  // processing and restore these afterwards, so every other node still sees
  // the global clock.
  const globalTick = ctx.tick;
  const globalTime = ctx.time;
  const globalFrame = ctx.frame;

  for (const id of order) {
    if (!needed.has(id)) continue;
    const node = byId.get(id);
    if (!node) continue;
    const def = getNodeDef(node.type);
    if (!def) {
      errors[id] = `Unknown node type: ${node.type}`;
      continue;
    }

    // --- Layer-local time (AE-style) ----------------------------------
    // Nodes inside a layer run on the layer's clock: a pure offset that
    // never stops (negative before the in-point; keyframe eval clamps to
    // the first key). Layers are root-only, so offsets never compose —
    // every node is at most one offset from the global clock. The scoped
    // tick drives this node's clip gating, keyframe evaluation, and
    // every ctx.tick/time/frame read during its compute; ctx is restored
    // at the end of the iteration. A PRE-ROLLING interior instead runs
    // pinned to its upcoming window's entry tick (see prerollLayers
    // above), warming exactly the state the cut will reveal.
    const enclosingLayer = layerOf.get(id);
    const layerOffset = enclosingLayer
      ? layerOffsets.get(enclosingLayer) ?? 0
      : 0;
    const prerollEntry = enclosingLayer
      ? prerollLayers.get(enclosingLayer)
      : undefined;
    ctx.preroll = inheritedPreroll || prerollEntry !== undefined;
    const scopedTick = prerollEntry ?? globalTick - layerOffset;
    if (scopedTick !== globalTick) {
      ctx.tick = scopedTick;
      ctx.frame = Math.floor(scopedTick / ctx.ticksPerFrame);
      ctx.time = scopedTick / (ctx.ticksPerFrame * ctx.fps);
    }

    // --- Timeline clip: gate + local-time -----------------------------
    // `gated` ⇒ playhead is outside the clip window; the node emits an empty
    // value of its output type and skips compute. `timeDriven` ⇒ an active
    // clip on a Video-style source; we remap the clock so its content (and
    // its stable:false fingerprint) reflect clip-local time. Static clipped
    // sources are pure gates — no clock change, so their keyframes stay on
    // the global clock for now. ctx is restored at the end of the iteration.
    const { gated, active: activeClip } = resolveClipAt(node.clips, scopedTick);
    const timeDriven = !!activeClip && isTimeDrivenClip(node.type);
    if (timeDriven) {
      const localTick = clipLocalTick(activeClip!, scopedTick);
      ctx.tick = localTick;
      ctx.frame = Math.floor(localTick / ctx.ticksPerFrame);
      ctx.time = localTick / (ctx.ticksPerFrame * ctx.fps);
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
      def.resolveInputs?.(node.params, resolveCtx) ?? def.inputs,
      def
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

    // Iterate shells: undeclared per-edge `zi__e_<edgeId>` inputs carry
    // direct crossing-wire values (flatten mirrors exterior→member edges
    // here — 071926_iterate-zone-view.md, "stay as wired"). Raw and
    // UNCOERCED: the member's socket does its own coercion when the
    // nested feed node re-emits the value.
    if (node.type === ITERATE_TYPE) {
      for (const e of edges) {
        if (e.target !== id) continue;
        const parsed = parseTargetHandleKind(e.targetHandle);
        if (
          parsed?.kind !== "input" ||
          !parsed.name.startsWith(ITERATE_EDGE_PREFIX)
        ) {
          continue;
        }
        const srcOut = outputs.get(e.source);
        const p = parseSourceHandle(e.sourceHandle);
        const raw =
          p?.kind === "primary"
            ? srcOut?.primary
            : p?.kind === "aux"
              ? srcOut?.aux?.[p.name]
              : undefined;
        inputs[parsed.name] = raw;
        inputFpParts.push(
          `${parsed.name}=${fingerprints.get(e.source) ?? "_"}`
        );
      }
    }

    // Resolve exposed-param overrides. Each exposed param with a connected
    // edge substitutes its value into the params map passed to compute.
    // Disconnected exposed params are no-ops (just a visible socket on the
    // node). FP includes a per-param entry so (connect/disconnect) and
    // (source value change) both bust correctly.
    const paramOverrides: Record<string, unknown> = {};
    // Wired per-stop ramp overrides (virtual `ramp_*` exposed names —
    // conventions.ts). Collected here but applied AFTER keyframe resolution
    // below, so a wire wins per field without clobbering other fields'
    // keyframed values on the same stops array.
    const rampWireOverrides: Array<{
      paramName: string;
      stopId: string;
      field: RampStopField;
      value: unknown;
    }> = [];
    const exposedParams = node.exposedParams ?? [];
    for (const pname of exposedParams) {
      const rampKey = parseRampParamKey(pname);
      const pdef = rampKey
        ? def.params.find(
            (p) => p.name === rampKey.paramName && p.type === "color_ramp"
          )
        : def.params.find((p) => p.name === pname);
      if (!pdef) continue;
      const socketType = rampKey
        ? rampFieldSocketType(rampKey.field)
        : paramSocketType(pdef.type);
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
        if (rampKey) {
          const rawValue = socketToParamRaw(
            coerced,
            rampKey.field === "color" ? "color" : "scalar"
          );
          if (rawValue !== undefined) {
            rampWireOverrides.push({ ...rampKey, value: rawValue });
          }
        } else {
          const rawValue = socketToParamRaw(coerced, pdef.type, pdef.alpha);
          if (rawValue !== undefined) paramOverrides[pname] = rawValue;
        }
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
        if (v !== undefined) {
          // Interpolated colors come back as 0..1 RGBA tuples — normalize
          // to the hex form the param stores (same contract as the wired
          // path in socketToParamRaw).
          keyframeOverrides[pdef.name] =
            pdef.type === "color"
              ? colorValueToHex(
                  v,
                  typeof node.params[pdef.name] === "string"
                    ? (node.params[pdef.name] as string)
                    : "#000000",
                  pdef.alpha
                )
              : v;
        }
      }
      // Virtual per-layer opacity keys ("layer_opacity:<id>") animate a
      // single layer's opacity inside a merge_layers param. The array
      // param isn't keyframable itself; each layer opacity is a scalar
      // with its own block. Applied onto a clone so the stored params
      // stay untouched. Blocks whose layer no longer exists are ignored.
      const layersParam = def.params.find((p) => p.type === "merge_layers");
      if (layersParam) {
        let layers:
          | Array<{ id?: string; opacity?: number } & Record<string, unknown>>
          | null = null;
        for (const [key, block] of Object.entries(animation)) {
          if (!key.startsWith(LAYER_OPACITY_PREFIX)) continue;
          if (!block || !block.animated || block.keyframes.length === 0) {
            continue;
          }
          const v = evaluateKeyframesAt(block, "scalar", ctx.tick);
          if (typeof v !== "number") continue;
          if (!layers) {
            const base = node.params[layersParam.name];
            layers = Array.isArray(base)
              ? base.map((l) => ({ ...(l as Record<string, unknown>) }))
              : [];
          }
          const id = key.slice(LAYER_OPACITY_PREFIX.length);
          const layer = layers.find((l) => l.id === id);
          if (layer) {
            layer.opacity = Math.max(0, Math.min(1, v));
            anyAnimated = true;
            keyframeOverrides[layersParam.name] = layers;
          }
        }
      }
      // Virtual per-point keys for a multipoint gradient: gpoint_x/y/c:<id>
      // animate one point's x / y (scalar) / color (RGBA) inside a
      // `gradient_points` param. Same clone-and-override contract as layer
      // opacity above; blocks whose point no longer exists are ignored.
      const pointsParam = def.params.find((p) => p.type === "gradient_points");
      if (pointsParam) {
        let pts:
          | Array<{ id?: string } & Record<string, unknown>>
          | null = null;
        const ensurePts = () => {
          if (!pts) {
            const base = node.params[pointsParam.name];
            pts = Array.isArray(base)
              ? base.map((p) => ({ ...(p as Record<string, unknown>) }))
              : [];
          }
          return pts;
        };
        for (const [key, block] of Object.entries(animation)) {
          if (!block || !block.animated || block.keyframes.length === 0) {
            continue;
          }
          let prefix: string | null = null;
          let field: "x" | "y" | "color" | null = null;
          if (key.startsWith(GPOINT_X_PREFIX)) {
            prefix = GPOINT_X_PREFIX;
            field = "x";
          } else if (key.startsWith(GPOINT_Y_PREFIX)) {
            prefix = GPOINT_Y_PREFIX;
            field = "y";
          } else if (key.startsWith(GPOINT_C_PREFIX)) {
            prefix = GPOINT_C_PREFIX;
            field = "color";
          }
          if (!prefix || !field) continue;
          const v = evaluateKeyframesAt(
            block,
            field === "color" ? "color" : "scalar",
            ctx.tick
          );
          if (v === undefined) continue;
          const id = key.slice(prefix.length);
          const arr = ensurePts();
          const pt = arr.find((p) => p.id === id);
          if (pt) {
            // color resolves to an RGBA tuple (or the stored hex at an exact
            // keyframe); x/y to a number. The node parses either color form.
            pt[field] = field === "color" ? v : (v as number);
            anyAnimated = true;
            keyframeOverrides[pointsParam.name] = arr;
          }
        }
      }
      // Virtual per-stop keys for color ramps: ramp_c/a/p:<param>:<stopId>
      // animate one stop's color (RGBA) / alpha / position inside a
      // `color_ramp` param. Same clone-and-override contract as the two
      // blocks above; keys whose param or stop no longer exists are ignored.
      {
        const clones = new Map<string, Array<Record<string, unknown>>>();
        for (const [key, block] of Object.entries(animation)) {
          if (!block || !block.animated || block.keyframes.length === 0) {
            continue;
          }
          const rk = parseRampParamKey(key);
          if (!rk) continue;
          const pdef = def.params.find(
            (p) => p.name === rk.paramName && p.type === "color_ramp"
          );
          if (!pdef) continue;
          const v = evaluateKeyframesAt(
            block,
            rk.field === "color" ? "color" : "scalar",
            ctx.tick
          );
          if (v === undefined) continue;
          let stops = clones.get(pdef.name);
          if (!stops) {
            const base = node.params[pdef.name];
            stops = Array.isArray(base)
              ? base.map((s) => ({ ...(s as Record<string, unknown>) }))
              : [];
            clones.set(pdef.name, stops);
          }
          const stop = stops.find((s) => s.id === rk.stopId);
          if (!stop) continue;
          if (rk.field === "color") {
            // Resolves to an RGBA tuple (or the stored hex at an exact
            // keyframe); the stop model stores hex.
            stop.color = colorValueToHex(
              v,
              typeof stop.color === "string" ? stop.color : "#000000"
            );
          } else {
            if (typeof v !== "number" || !Number.isFinite(v)) continue;
            stop[rk.field] = Math.max(0, Math.min(1, v));
          }
          anyAnimated = true;
          keyframeOverrides[pdef.name] = stops;
        }
      }
      // Virtual per-anchor keys for Spline Draw (anchor_p/in/out:<id> —
      // spec 072726 M6): animate INDIVIDUAL anchors of a `spline_anchors`
      // param. EITHER/OR with whole-shape Path Animation — when the spline
      // param's own block is animated (resolved by the standard keyframe
      // step above), per-anchor tracks are ignored. Same clone-and-override
      // contract as the three blocks above; tracks whose anchor id no
      // longer exists are ignored.
      const splineParam = def.params.find((p) => p.type === "spline_anchors");
      if (splineParam && !animation[splineParam.name]?.animated) {
        const base = (keyframeOverrides[splineParam.name] ??
          node.params[splineParam.name]) as
          | { subpaths?: SplineSubpath[] }
          | undefined;
        if (base && Array.isArray(base.subpaths)) {
          const resolved = resolveAnchorTracks(
            base as { subpaths: SplineSubpath[] },
            animation,
            ctx.tick
          );
          if (resolved) {
            anyAnimated = true;
            keyframeOverrides[splineParam.name] = resolved;
          }
        }
      }
      if (anyAnimated) {
        // Tick + animated-param-name list are enough — values are
        // determined by (tick, keyframes) and keyframes already
        // contribute via stableStringify(node.animation) below.
        inputFpParts.push(`anim:${ctx.tick}`);
      }
    }

    // Wired per-stop ramp overrides apply on top of the keyframe-resolved
    // stops (wire > keyframe per FIELD — other fields keep their keyframed
    // values). The clone starts from the keyframe result when one exists.
    if (rampWireOverrides.length > 0) {
      const cloned = new Map<string, Array<Record<string, unknown>>>();
      for (const o of rampWireOverrides) {
        let stops = cloned.get(o.paramName);
        if (!stops) {
          const base =
            keyframeOverrides[o.paramName] ?? node.params[o.paramName];
          stops = Array.isArray(base)
            ? base.map((s) => ({ ...(s as Record<string, unknown>) }))
            : [];
          cloned.set(o.paramName, stops);
          paramOverrides[o.paramName] = stops;
        }
        const stop = stops.find((s) => s.id === o.stopId);
        if (!stop) continue;
        if (o.field === "color") {
          stop.color = colorValueToHex(
            o.value,
            typeof stop.color === "string" ? stop.color : "#000000"
          );
        } else if (typeof o.value === "number" && Number.isFinite(o.value)) {
          stop[o.field] = Math.max(0, Math.min(1, o.value));
        }
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

    const clipFp = gated ? "clip:gated" : "";
    const fingerprint = computeNodeFingerprint(
      node,
      def,
      inputFpParts,
      ctx,
      clipFp
    );
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
        if (gated && node.type === LAYER_TYPE) {
          // A layer outside its window is a pure passthrough — the
          // stack below it flows on unchanged (its interior already
          // left the needed set via the content-edge drop above). Like
          // bypass, we don't own the upstream texture.
          const passthrough = inputs.stack;
          result = passthrough ? { primary: passthrough } : {};
          ownsTextures = false;
        } else if (gated) {
          // Clip window doesn't contain the playhead — emit an empty value of
          // this node's output type and skip compute. We own any allocated
          // texture (transparent image), so it releases on eviction like a
          // normal output.
          result = emptyClipOutput(
            ctx,
            resolvePrimaryType(def, node.params, resolveCtx)
          );
          ownsTextures = !!(result.primary && "texture" in result.primary);
        } else if (node.bypassed) {
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
            consumedOutputs: consumedOutputs.get(id),
          }) ?? {};
        }

        // Node-declared ownership: outputs whose textures live in ctx.state
        // (NodeOutput.ownsTextures === false — Text, Cursor, Simulation
        // Zones) must never be released by the evaluator; the node's own
        // dispose tears them down.
        if (result.ownsTextures === false) ownsTextures = false;
        // The mask/opacity post-passes below REPLACE outputs with freshly
        // allocated textures — those are evaluator-owned even when the
        // originals were state-backed. Track replacements so the transient
        // collection can release them.
        let primaryReplaced = false;
        let auxReplaced: Set<string> | null = null;

        // Apply the universal mask input after compute. Not applied to
        // bypassed nodes or when result has no image primary. With a base
        // image input present, masks blend between base and effect; without
        // one (pure sources), the mask multiplies the output.
        const maskIn = inputs[MASK_INPUT_NAME];
        if (
          !node.bypassed &&
          !gated &&
          maskIn &&
          maskIn.kind === "mask" &&
          result.primary &&
          result.primary.kind === "image"
        ) {
          // `noMaskBase` sources (e.g. Text) always matte — never treat one
          // of their image inputs as a blend base.
          const firstImgInput = def.noMaskBase
            ? undefined
            : defInputs.find(
                (i) => i.type === "image" && i.name !== MASK_INPUT_NAME
              );
          const base = firstImgInput ? inputs[firstImgInput.name] : undefined;
          const baseImg =
            base && base.kind === "image" ? (base as ImageValue) : undefined;
          const masked = applyMask(ctx, result.primary, maskIn, baseImg);
          if (ownsTextures) ctx.releaseTexture(result.primary.texture);
          result = { ...result, primary: masked };
          primaryReplaced = true;
        }

        // Universal per-node opacity (see OPACITY_PARAM in conventions):
        // any def declaring an `opacity` param gets its image outputs —
        // primary and aux — alpha-multiplied here. One convention covers
        // image sources and spline primitives whose visible raster is an
        // aux output. No-op at 1 so undeclared/default nodes pay nothing.
        const opacity = effectiveParams.opacity;
        if (
          !node.bypassed &&
          !gated &&
          typeof opacity === "number" &&
          opacity < 1
        ) {
          const o = Math.max(0, opacity);
          if (result.primary?.kind === "image") {
            const faded = applyOpacity(ctx, result.primary, o);
            // A mask-pass replacement is ours to release even when the
            // node's original textures were state-backed.
            if (ownsTextures || primaryReplaced) {
              ctx.releaseTexture(result.primary.texture);
            }
            result = { ...result, primary: faded };
            primaryReplaced = true;
          }
          if (result.aux) {
            let nextAux: typeof result.aux | null = null;
            for (const [name, value] of Object.entries(result.aux)) {
              if (value?.kind !== "image") continue;
              const faded = applyOpacity(ctx, value, o);
              if (ownsTextures) ctx.releaseTexture(value.texture);
              (nextAux ??= { ...result.aux })[name] = faded;
              (auxReplaced ??= new Set()).add(name);
            }
            if (nextAux) result = { ...result, aux: nextAux };
          }
        }

        outputs.set(id, result);
        outputTypeCache.set(id, resolvePrimaryType(def, node.params, resolveCtx));

        if (cacheable) {
          if (prev) releaseCachedTextures(ctx, prev);
          cache.set(id, { fingerprint, output: result, ownsTextures });
        } else {
          if (prev) {
            // No longer cacheable (e.g., user toggled bypass on). Evict.
            releaseCachedTextures(ctx, prev);
            cache.delete(id);
          }
          // Uncacheable output: nothing will ever evict it, so its owned
          // textures go to the transient set, released at the start of the
          // NEXT eval (they must outlive this frame's downstream reads and
          // the blit). Excluded: state-backed outputs (ownsTextures false)
          // and borrowed passthroughs (bypass / gated layer); included:
          // post-pass replacements, which are always evaluator-owned.
          const seen = new Set<WebGLTexture>();
          const collect = (v: SocketValue | undefined, owned: boolean) => {
            if (!owned || !v) return;
            if (v.kind !== "image" && v.kind !== "mask" && v.kind !== "uv")
              return;
            if (seen.has(v.texture)) return;
            seen.add(v.texture);
            evalTransients.push(v.texture);
          };
          collect(result.primary, ownsTextures || primaryReplaced);
          if (result.aux) {
            for (const [name, v] of Object.entries(result.aux)) {
              collect(v, ownsTextures || (auxReplaced?.has(name) ?? false));
            }
          }
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

    // Terminal preview selection. Active override wins; otherwise the first
    // terminal node's first-input image is shown. When the chosen node's
    // primary isn't an image but it exposes an `image` aux (e.g. a spline
    // primitive's bundled rasterizer), fall back to that.
    if (activeNodeId && id === activeNodeId) {
      // When the Active target was remapped from a group, prefer the exact
      // output handle that fed the group's image socket; otherwise fall
      // back to primary / first-input / image aux as before.
      let img = pickHandleImage(result, activeHandle);
      if (!img) img = result.primary ?? inputs[defInputs[0]?.name ?? ""];
      if (img && img.kind === "image") {
        terminalImage = { nodeId: id, image: img };
      } else if (result.aux?.image?.kind === "image") {
        terminalImage = { nodeId: id, image: result.aux.image };
      }
    } else if (!activeNodeId && def.terminal) {
      const firstInput = defInputs[0]?.name;
      const img = firstInput ? inputs[firstInput] : undefined;
      if (img && img.kind === "image") {
        terminalImage = { nodeId: id, image: img };
      }
    }

    // Restore the global clock if this node ran on clip-local,
    // layer-local, or pre-roll-pinned time.
    if (timeDriven || scopedTick !== globalTick) {
      ctx.tick = globalTick;
      ctx.time = globalTime;
      ctx.frame = globalFrame;
    }
  }
  ctx.preroll = inheritedPreroll;

  // Preview fallback: if nothing claimed the canvas (no active node, no
  // connected terminal image), show the selected node's own image — its
  // primary if it's an image, otherwise its `image` aux. Lets you drop in a
  // node (e.g. a spline primitive) and see it without wiring an Output.
  if (!terminalImage && previewNodeId) {
    const out = outputs.get(previewNodeId);
    if (out) {
      const handleImg = pickHandleImage(out, previewHandle);
      if (handleImg) {
        terminalImage = { nodeId: previewNodeId, image: handleImg };
      } else if (out.primary?.kind === "image") {
        terminalImage = { nodeId: previewNodeId, image: out.primary };
      } else if (out.aux?.image?.kind === "image") {
        terminalImage = { nodeId: previewNodeId, image: out.aux.image };
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

  // Tear down persistent state for nodes deleted from the graph. The cache
  // eviction above misses them when they were never cacheable (stable:false
  // — exactly the heavy state owners: Text, video, sims), so sweep by the
  // state-key convention against the pre-flatten id set. Never inside a
  // nested (Iterate-interior) pass — its keep-set would be just the
  // interior ids, disposing every other node's state. Iterate interiors
  // themselves survive the OUTER sweep because presentIds is pre-flatten.
  if (!nested) sweepNodeState(ctx, presentIds);

  return { outputs, terminalImage, errors, fingerprints, timings, inspectInputs };
}
