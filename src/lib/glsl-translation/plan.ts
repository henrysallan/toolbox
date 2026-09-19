// planTranslation — the pure half of the `plan_glsl_translation` tool (spec
// 091626_graph-to-glsl.md §2). Given a scope's graph, a target output, and
// per-node def info, decide which upstream nodes fuse into one GLSL
// Expression, where the region is cut (frontier inputs → u_a..u_d / channel
// sockets), what it will cost, which frames represent the motion, which docs
// the agent must read, and the edit_group skeleton that lands the node.
//
// No engine, no registry, no React: the handler feeds it GroupSpec-shaped
// nodes/edges plus lookups, and scripts/check-glsl-translation.mts runs it on
// fixtures. Everything here is deterministic — the same graph always yields
// the same plan, which is what makes "the plan said X" a debuggable claim.

import {
  CHANNEL_LIKE_SOCKETS,
  FUSABLE_CLASSES,
  IMAGE_LIKE_SOCKETS,
  isClassified,
  translationEntry,
  type TranslationClass,
  type TranslationEntry,
} from "./classes";

export interface PlanNode {
  id: string;
  type: string;
  name?: string;
  // Non-default settable params (what get_graph prints by default).
  params?: Record<string, unknown>;
  keyframed?: string[];
  // Repeat / For Each / Iterate zone shell id when the node is a member.
  parent?: string;
  channels?: { name: string; kind: string; value: unknown; options?: string[]; socket?: string }[];
}

export interface PlanEdge {
  // "<id>:out" | "<id>:aux:<name>"
  from: string;
  // "<id>:in:<socket>" | "<id>:param:<name>"
  to: string;
}

export interface PlanParamDef {
  name: string;
  type: string;
  min?: number;
  max?: number;
  options?: string[];
  default?: unknown;
}

// Per-node facts the planner needs from the registry. Built by the handler
// with `resolveInputs(params)` so dynamic sockets (Merge layers, channels)
// are the ones actually on the node.
export interface PlanNodeInfo {
  inputs: { name: string; type: string }[];
  primaryOutput?: string;
  auxOutputs: { name: string; type: string }[];
  readsTime: boolean;
  simulation: boolean;
  params: PlanParamDef[];
}

export interface PlanInput {
  nodes: PlanNode[];
  edges: PlanEdge[];
  // "<id>" | "<id>:out" | "<id>:aux:<name>"
  target: string;
  // Scope (group / layer id) the target lives in — edit_group's groupId.
  scopeId: string;
  infoOf: (id: string) => PlanNodeInfo | undefined;
  // Full current params (defaults included) — for channel seeds.
  valuesOf: (id: string) => Record<string, unknown>;
  keyframeFramesOf: (id: string) => number[];
  classOf?: (type: string) => TranslationEntry;
  maxInputs?: number;
  frame: number;
  fps: number;
  loopFrames: number;
  canvas: { width: number; height: number };
}

export type FrontierKind = "image" | "channel" | "manual";

export interface FrontierWire {
  kind: FrontierKind;
  from: string; // producer endpoint, recipe grammar
  fromType: string; // producer node type
  type: string; // socket type carried
  // Region node + socket this wire feeds.
  toNode: string;
  toSocket: string; // "in:<name>" | "param:<name>"
  // Assigned sampler for image wires ("a".."d").
  slot?: string;
  // True when this is an interior universal `mask` — fuse it as a matte
  // (docs/fusion.md), it is not part of the node's own math.
  matte?: boolean;
  note?: string;
}

export interface PlanRegionNode {
  id: string;
  type: string;
  name?: string;
  class: TranslationClass;
  doc?: string;
  note?: string;
  // Non-default params, as get_graph prints them.
  params: Record<string, unknown>;
  // Every settable param with its CURRENT value and range — channel seeds.
  paramDefs: (PlanParamDef & { value: unknown })[];
  keyframed: string[];
  channels?: PlanNode["channels"];
  // Upstream evaluations per pixel this node forces on its inputs (cost).
  evaluations: number;
  // Region producers feeding it, by socket.
  inputs: { socket: string; from: string; region: boolean }[];
}

export interface PlanExclusion {
  id: string;
  type: string;
  class: TranslationClass;
  reason: string;
}

export interface TranslationPlan {
  target: { id: string; handle: string; type: string; name?: string };
  // Empty when the target itself cannot be fused; `refusal` says why.
  region: string[]; // topological, producers first, target last
  refusal?: string;
  nodes: PlanRegionNode[];
  frontier: FrontierWire[];
  excluded: PlanExclusion[];
  time: { dependent: boolean; frames: number[]; fps: number; loopFrames: number };
  cost: { evaluationsPerPixel: number; warnings: string[] };
  canvas: { width: number; height: number; aspect: number };
  // The target's own universal mask / opacity — inherited by the fused node
  // via its own mask socket (wired in the skeleton) and an explicit alpha
  // multiply respectively.
  targetMask?: string;
  targetOpacity?: number;
  docs: string[];
  sourceHints: { type: string; note: string }[];
  skeleton: {
    groupId: string;
    localId: string;
    ops: Record<string, unknown>[];
    // Wires into channel sockets — apply AFTER the expression declares the
    // channels (same batch is fine: add_node Syncs them first).
    channelEdges: { from: string; toSocketHint: string; type: string; drives: string }[];
  };
  warnings: string[];
}

const DEFAULT_MAX_INPUTS = 4;
const SLOTS = ["a", "b", "c", "d"] as const;
const GATHER_DEFAULT_TAPS = 9;
const COST_WARN_EVALS = 64;
const TIME_RE = /\bu_(time|frame)\b/;

export function parseEndpoint(s: string): { id: string; handle: string } {
  const aux = /^(.*):aux:([A-Za-z0-9_-]+)$/.exec(s);
  if (aux) return { id: aux[1], handle: `aux:${aux[2]}` };
  if (s.endsWith(":out")) return { id: s.slice(0, -4), handle: "out" };
  const inp = /^(.*):(in|param):(.+)$/.exec(s);
  if (inp) return { id: inp[1], handle: `${inp[2]}:${inp[3]}` };
  return { id: s, handle: "out" };
}

function outputType(info: PlanNodeInfo | undefined, handle: string): string | undefined {
  if (!info) return undefined;
  if (handle === "out") return info.primaryOutput;
  if (handle.startsWith("aux:"))
    return info.auxOutputs.find((a) => a.name === handle.slice(4))?.type;
  return undefined;
}

function inputType(info: PlanNodeInfo | undefined, handle: string): string | undefined {
  if (!info) return undefined;
  if (handle.startsWith("in:"))
    return info.inputs.find((i) => i.name === handle.slice(3))?.type;
  if (handle.startsWith("param:"))
    return info.params.find((p) => p.name === handle.slice(6))?.type;
  return undefined;
}

function tapsOf(entry: TranslationEntry): number {
  if (entry.class === "pure") return typeof entry.taps === "number" ? Math.max(1, entry.taps) : 1;
  if (typeof entry.taps === "number") return Math.max(1, entry.taps);
  if (entry.class === "gather" || entry.class === "multipass") return GATHER_DEFAULT_TAPS;
  return 1;
}

function readsClock(node: PlanNode, info: PlanNodeInfo | undefined, entry: TranslationEntry, values: Record<string, unknown>): boolean {
  if (node.type === "glsl-expression") {
    const src = values.expression;
    return typeof src === "string" && TIME_RE.test(src);
  }
  return !!(info?.readsTime || info?.simulation || entry.time);
}

// Even spacing across the loop, keyframe frames kept, capped.
export function proposeFrames(
  dependent: boolean,
  current: number,
  loopFrames: number,
  keyframeFrames: number[],
  want = 6,
  cap = 8
): number[] {
  if (!dependent) return [Math.max(0, Math.round(current))];
  const end = Math.max(1, Math.round(loopFrames) - 1);
  const set = new Set<number>();
  for (const f of keyframeFrames) {
    const r = Math.round(f);
    if (r >= 0 && r <= end) set.add(r);
  }
  const keyed = [...set].sort((a, b) => a - b);
  const evenCount = Math.max(2, want - keyed.length);
  for (let i = 0; i < evenCount; i++) set.add(Math.round((end * i) / (evenCount - 1)));
  let frames = [...set].sort((a, b) => a - b);
  // Over the cap: drop evenly-spaced fillers first (keyframes carry signal),
  // then the most crowded keyframes.
  while (frames.length > cap) {
    const fillers = frames.filter((f) => !keyed.includes(f));
    const pool = fillers.length ? fillers : frames.slice(1, -1);
    if (!pool.length) break;
    // Remove the candidate closest to a neighbour.
    let victim = pool[0];
    let best = Infinity;
    for (const f of pool) {
      const i = frames.indexOf(f);
      const gap = Math.min(
        i > 0 ? f - frames[i - 1] : Infinity,
        i < frames.length - 1 ? frames[i + 1] - f : Infinity
      );
      if (gap < best) {
        best = gap;
        victim = f;
      }
    }
    frames = frames.filter((f) => f !== victim);
  }
  return frames;
}

export function planTranslation(input: PlanInput): TranslationPlan {
  const classOf = input.classOf ?? translationEntry;
  const maxInputs = Math.min(4, Math.max(1, Math.round(input.maxInputs ?? DEFAULT_MAX_INPUTS)));
  const byId = new Map(input.nodes.map((n) => [n.id, n]));
  const { id: targetId, handle: targetHandle } = parseEndpoint(input.target);
  const warnings: string[] = [];
  const aspect = input.canvas.height > 0 ? input.canvas.width / input.canvas.height : 1;
  const canvas = { ...input.canvas, aspect };
  const timeMeta = { fps: input.fps, loopFrames: input.loopFrames };

  const targetNode = byId.get(targetId);
  if (!targetNode) {
    throw new Error(`No node "${targetId}" in this scope — call get_graph for current ids.`);
  }
  const targetEntry = classOf(targetNode.type);
  const targetInfo = input.infoOf(targetId);
  const targetOutType = outputType(targetInfo, targetHandle);

  const emptyPlan = (refusal: string): TranslationPlan => ({
    target: { id: targetId, handle: targetHandle, type: targetNode.type, name: targetNode.name },
    region: [],
    refusal,
    nodes: [],
    frontier: [],
    excluded: [
      { id: targetId, type: targetNode.type, class: targetEntry.class, reason: refusal },
    ],
    time: { dependent: false, frames: [Math.round(input.frame)], ...timeMeta },
    cost: { evaluationsPerPixel: 0, warnings: [] },
    canvas,
    docs: [],
    sourceHints: [],
    skeleton: { groupId: input.scopeId, localId: "glsl", ops: [], channelEdges: [] },
    warnings,
  });

  if (targetOutType && !IMAGE_LIKE_SOCKETS.has(targetOutType)) {
    return emptyPlan(
      `"${targetId}${targetHandle === "out" ? "" : `:${targetHandle}`}" carries ${targetOutType}, not an image — a GLSL Expression can only reproduce image/mask/uv outputs.`
    );
  }
  if (!FUSABLE_CLASSES.has(targetEntry.class)) {
    return emptyPlan(
      `${targetNode.type} is ${targetEntry.class}${targetEntry.note ? ` — ${targetEntry.note}` : ""}. Nothing to fuse: pick the node downstream of it, or the pure/gather chain feeding it.`
    );
  }
  if (targetHandle !== "out" && targetNode.type !== "glsl-expression") {
    // Aux images of fusable nodes are side products (bloom_only, index…).
    warnings.push(
      `Target is the aux output "${targetHandle}" — the plan reproduces the node's math; make the helper return that aux quantity instead of the primary.`
    );
  }

  // --- adjacency ------------------------------------------------------------
  // inputsOf(nodeId) → wires into it, with producer endpoint + socket handle.
  const inputsOf = new Map<string, { from: string; fromId: string; fromHandle: string; toHandle: string }[]>();
  for (const e of input.edges) {
    const f = parseEndpoint(e.from);
    const t = parseEndpoint(e.to);
    const list = inputsOf.get(t.id) ?? [];
    list.push({ from: e.from, fromId: f.id, fromHandle: f.handle, toHandle: t.handle });
    inputsOf.set(t.id, list);
  }

  const targetZone = targetNode.parent;

  // --- region growth with an exclusion set (re-run when shrinking) -----------
  type Grow = {
    region: Set<string>;
    order: string[];
    frontier: FrontierWire[];
    excluded: PlanExclusion[];
    inputsByNode: Map<string, { socket: string; from: string; region: boolean }[]>;
  };

  function grow(forceExcluded: Map<string, string>): Grow {
    const region = new Set<string>();
    const excluded: PlanExclusion[] = [];
    const excludedIds = new Set<string>();
    const frontier: FrontierWire[] = [];
    const inputsByNode = new Map<string, { socket: string; from: string; region: boolean }[]>();
    const order: string[] = [];
    const visiting = new Set<string>();

    const exclude = (n: PlanNode, reason: string) => {
      if (excludedIds.has(n.id)) return;
      excludedIds.add(n.id);
      excluded.push({ id: n.id, type: n.type, class: classOf(n.type).class, reason });
    };

    // Can `n` join the region? Returns a reason when not.
    const blocker = (n: PlanNode): string | null => {
      const forced = forceExcluded.get(n.id);
      if (forced) return forced;
      const entry = classOf(n.type);
      if (!FUSABLE_CLASSES.has(entry.class))
        return `${entry.class}${entry.note ? ` — ${entry.note}` : ""}`;
      if (n.parent !== targetZone)
        return n.parent
          ? `inside zone "${n.parent}" (iteration) while the target is not — zone members do not fuse across the boundary`
          : `outside the target's zone "${targetZone}"`;
      const info = input.infoOf(n.id);
      // A fusable node operating on non-image data (Displace pushing a
      // spline) is not a per-pixel function here.
      for (const w of inputsOf.get(n.id) ?? []) {
        const t = outputType(input.infoOf(w.fromId), w.fromHandle) ?? inputType(info, w.toHandle);
        if (!t) continue;
        if (IMAGE_LIKE_SOCKETS.has(t) || CHANNEL_LIKE_SOCKETS.has(t)) continue;
        if (w.toHandle.startsWith("param:")) continue; // manual frontier, handled below
        const producer = byId.get(w.fromId);
        const pEntry = producer ? classOf(producer.type) : null;
        if (pEntry?.class === "compiled") continue; // SDF/position chain — stays fusable
        return `input "${w.toHandle.slice(3)}" carries ${t} from ${producer?.type ?? w.fromId} — this node is not a per-pixel function of images here`;
      }
      return null;
    };

    const visit = (id: string): boolean => {
      // returns true when `id` joined the region
      if (region.has(id)) return true;
      if (excludedIds.has(id)) return false;
      const n = byId.get(id);
      if (!n) return false;
      const why = blocker(n);
      if (why) {
        exclude(n, why);
        return false;
      }
      if (visiting.has(id)) return true; // acyclic by contract; be safe
      visiting.add(id);
      region.add(id);
      const nodeInputs: { socket: string; from: string; region: boolean }[] = [];
      const info = input.infoOf(id);
      for (const w of inputsOf.get(id) ?? []) {
        const producer = byId.get(w.fromId);
        const t = outputType(input.infoOf(w.fromId), w.fromHandle) ?? inputType(info, w.toHandle) ?? "unknown";
        const isMask = w.toHandle === "in:mask";
        let joined = false;
        if (producer && (IMAGE_LIKE_SOCKETS.has(t) || classOf(producer.type).class === "compiled") && !isMask) {
          joined = visit(w.fromId);
        }
        nodeInputs.push({ socket: w.toHandle, from: w.from, region: joined });
        if (joined) continue;
        if (IMAGE_LIKE_SOCKETS.has(t) || (t === "unknown" && w.toHandle.startsWith("in:"))) {
          frontier.push({
            kind: "image",
            from: w.from,
            fromType: producer?.type ?? "?",
            type: t,
            toNode: id,
            toSocket: w.toHandle,
            ...(isMask ? { matte: true } : {}),
          });
        } else if (CHANNEL_LIKE_SOCKETS.has(t)) {
          frontier.push({
            kind: "channel",
            from: w.from,
            fromType: producer?.type ?? "?",
            type: t,
            toNode: id,
            toSocket: w.toHandle,
          });
        } else {
          frontier.push({
            kind: "manual",
            from: w.from,
            fromType: producer?.type ?? "?",
            type: t,
            toNode: id,
            toSocket: w.toHandle,
            note: `GLSL channels are scalar / color / ramp only — fold the wired ${t} into constants (read its current value with get_node_data) or split it into scalar channels.`,
          });
        }
      }
      inputsByNode.set(id, nodeInputs);
      visiting.delete(id);
      order.push(id); // postorder ⇒ producers first
      return true;
    };

    visit(targetId);
    return { region, order, frontier, excluded, inputsByNode };
  }

  // The target's own mask is inherited by the fused node's mask socket, so
  // it never costs a sampler: pull it out of the frontier.
  const splitTargetMask = (g: Grow) => {
    const own = g.frontier.find((f) => f.toNode === targetId && f.matte);
    if (own) g.frontier = g.frontier.filter((f) => f !== own);
    return own?.from;
  };

  const imageSlotsNeeded = (g: Grow) => new Set(g.frontier.filter((f) => f.kind === "image").map((f) => f.from)).size;

  const forced = new Map<string, string>();
  let g = grow(forced);
  let targetMask = splitTargetMask(g);
  // Shrink: drop the deepest region node carrying frontier images until the
  // distinct-producer count fits the sampler budget.
  for (let guard = 0; guard < input.nodes.length && imageSlotsNeeded(g) > maxInputs; guard++) {
    const depth = new Map<string, number>();
    depth.set(targetId, 0);
    // order is producers-first; walk consumers → producers for depth.
    for (const id of [...g.order].reverse()) {
      const d = depth.get(id) ?? 0;
      for (const w of g.inputsByNode.get(id) ?? []) {
        if (!w.region) continue;
        const pid = parseEndpoint(w.from).id;
        depth.set(pid, Math.max(depth.get(pid) ?? 0, d + 1));
      }
    }
    const carriers = new Map<string, number>();
    for (const f of g.frontier) if (f.kind === "image") carriers.set(f.toNode, (carriers.get(f.toNode) ?? 0) + 1);
    const candidates = [...carriers.keys()].filter((id) => id !== targetId);
    if (!candidates.length) break;
    candidates.sort((a, b) => (depth.get(b) ?? 0) - (depth.get(a) ?? 0) || (carriers.get(b) ?? 0) - (carriers.get(a) ?? 0));
    const victim = candidates[0];
    forced.set(
      victim,
      `sampler cap — its inputs would push the fused node past ${maxInputs} image inputs; it stays a node and its output is wired in instead`
    );
    g = grow(forced);
    targetMask = splitTargetMask(g);
  }
  if (imageSlotsNeeded(g) > maxInputs) {
    warnings.push(
      `The target alone needs ${imageSlotsNeeded(g)} image inputs but glsl-expression has ${maxInputs}. Pre-merge inputs in a second GLSL Expression, or pick a smaller target.`
    );
  }

  // --- slots ------------------------------------------------------------------
  const slotByFrom = new Map<string, string>();
  for (const f of g.frontier) {
    if (f.kind !== "image") continue;
    if (!slotByFrom.has(f.from) && slotByFrom.size < SLOTS.length) slotByFrom.set(f.from, SLOTS[slotByFrom.size]);
    f.slot = slotByFrom.get(f.from);
    if (!f.slot) f.note = "no sampler left — see warnings";
  }

  // --- per-node detail, cost, time, docs --------------------------------------
  const evals = new Map<string, number>();
  evals.set(targetId, 1);
  for (const id of [...g.order].reverse()) {
    const n = byId.get(id)!;
    const m = evals.get(id) ?? 1;
    const taps = tapsOf(classOf(n.type));
    for (const w of g.inputsByNode.get(id) ?? []) {
      if (!w.region) continue;
      const pid = parseEndpoint(w.from).id;
      evals.set(pid, Math.max(evals.get(pid) ?? 0, m * taps));
    }
  }
  const costWarnings: string[] = [];
  let dependent = false;
  const keyframeFrames: number[] = [];
  const docs = new Set<string>(["conventions", "fusion", "parity"]);
  const sourceHints: { type: string; note: string }[] = [];
  const seenHint = new Set<string>();
  const nodes: PlanRegionNode[] = g.order.map((id) => {
    const n = byId.get(id)!;
    const entry = classOf(n.type);
    const info = input.infoOf(id);
    const values = input.valuesOf(id);
    if (!isClassified(n.type)) warnings.push(`${n.type} is not in the translation table — treated as opaque.`);
    if (readsClock(n, info, entry, values)) dependent = true;
    const kf = n.keyframed ?? [];
    if (kf.length) {
      dependent = true;
      keyframeFrames.push(...input.keyframeFramesOf(id));
    }
    if (entry.doc) docs.add(`nodes/${entry.doc}`);
    else if (!seenHint.has(n.type)) {
      seenHint.add(n.type);
      sourceHints.push({
        type: n.type,
        note: `No translation doc yet — read the node's shader with get_node_source("${n.type}") and port the branch its params select.${entry.note ? ` ${entry.note}` : ""}`,
      });
    }
    if (entry.class === "multipass")
      costWarnings.push(`${n.type} (${id}) is multipass — the one-pass form is an approximation; say which one you used.`);
    const e = evals.get(id) ?? 1;
    if (e > COST_WARN_EVALS)
      costWarnings.push(
        `${n.type} (${id}) would be evaluated ~${e}× per pixel through the gathers downstream of it — consider keeping it as a separate node (wired input) instead of fusing it.`
      );
    const paramDefs = (info?.params ?? []).map((p) => ({ ...p, value: values[p.name] ?? p.default }));
    return {
      id,
      type: n.type,
      ...(n.name ? { name: n.name } : {}),
      class: entry.class,
      ...(entry.doc ? { doc: `nodes/${entry.doc}` } : {}),
      ...(entry.note ? { note: entry.note } : {}),
      params: n.params ?? {},
      paramDefs,
      keyframed: kf,
      ...(n.channels ? { channels: n.channels } : {}),
      evaluations: e,
      inputs: g.inputsByNode.get(id) ?? [],
    };
  });
  const evaluationsPerPixel = [...evals.values()].reduce((a, b) => a + b, 0);
  const frames = proposeFrames(dependent, input.frame, input.loopFrames, keyframeFrames);

  for (const f of g.frontier) {
    if (f.kind === "manual")
      warnings.push(`${f.toNode}.${f.toSocket} is wired from a ${f.type} (${f.fromType}) — ${f.note}`);
  }
  for (const x of g.excluded) {
    if (x.class === "stateful" || x.class === "opaque") continue; // expected frontiers
    warnings.push(`${x.type} (${x.id}) excluded: ${x.reason}`);
  }

  // --- skeleton --------------------------------------------------------------
  const localId = "glsl";
  const targetValues = input.valuesOf(targetId);
  const targetOpacity = typeof targetValues.opacity === "number" && targetValues.opacity !== 1 ? targetValues.opacity : undefined;
  const ops: Record<string, unknown>[] = [
    {
      op: "add_node",
      id: localId,
      type: "glsl-expression",
      params: {
        // `transparent`, not passthrough: a compile error must look broken,
        // not like a plausible copy of input a.
        on_error: "transparent",
        expression: "// <write the fused shader here — see plan.docs>\nfragColor = vec4(0.0);",
      },
      ...(targetZone ? { parent: targetZone } : {}),
    },
    { op: "rename_node", node: localId, name: `${targetNode.name ?? targetNode.type} (GLSL)` },
  ];
  for (const [from, slot] of slotByFrom) ops.push({ op: "add_edge", from, to: `${localId}:in:${slot}` });
  if (targetMask) ops.push({ op: "add_edge", from: targetMask, to: `${localId}:in:mask` });
  const channelEdges = g.frontier
    .filter((f) => f.kind === "channel")
    .map((f) => ({
      from: f.from,
      toSocketHint: `${localId}:in:<channelName>`,
      type: f.type,
      drives: `${f.toNode}.${f.toSocket.replace(/^(in|param):/, "")}`,
    }));

  return {
    target: { id: targetId, handle: targetHandle, type: targetNode.type, ...(targetNode.name ? { name: targetNode.name } : {}) },
    region: g.order,
    nodes,
    frontier: g.frontier,
    excluded: g.excluded,
    time: { dependent, frames, ...timeMeta },
    cost: { evaluationsPerPixel, warnings: costWarnings },
    canvas,
    ...(targetMask ? { targetMask } : {}),
    ...(targetOpacity !== undefined ? { targetOpacity } : {}),
    docs: [...docs],
    sourceHints,
    skeleton: { groupId: input.scopeId, localId, ops, channelEdges },
    warnings,
  };
}
