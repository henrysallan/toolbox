// Audio chain plans — the PURE half of the audio engine
// (specdocs/080826_audio-nodes.md).
//
// Audio node defs emit AudioChainNode descriptor trees (types.ts); this
// module flattens the trees that arrived at the end of an eval into an
// AudioGraphPlan (stages keyed by nodeId + which roots are routed to the
// Output node) and diffs two plans into the minimal op set the live
// reconciler (audio-engine.ts) must execute: create / dispose / retune /
// rewire / reschedule.
//
// Everything here is synchronous, allocation-light, and free of Tone /
// WebAudio / DOM so `scripts/check-audio-chain.mts` can exercise it under
// Node. Keep it that way — this file is the contract the M1 node batch and
// the offline export renderer both compile against.

import type {
  AudioChainNode,
  AudioStageParams,
  NoteEvent,
} from "./types";

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export interface AudioChainRoot {
  chain: AudioChainNode;
  // True when this root's AudioValue landed on an Output node's `audio`
  // socket this eval — only routed roots reach the speakers; everything
  // else is built but stays disconnected from the destination (so analysis
  // taps keep reading live data, the chain analog of "advances muted").
  routed: boolean;
}

export interface AudioStagePlan {
  nodeId: string;
  stage: AudioChainNode;
  // Upstream stage nodeIds in port order: effects have exactly one, mix
  // stages one per lane, sources none. Connection edges are derived from
  // this, so "rewire" = this array changed.
  inputIds: string[];
  // Modulation edges (080926 M-C): which stage's output sums into which
  // named Tone Signal of this stage. A separate edge class from inputIds —
  // signal-path lanes are positional, mod connections are named.
  modConns: { param: string; fromId: string }[];
}

export interface AudioGraphPlan {
  // Insertion order is topological (children registered before parents by
  // the post-order walk in buildAudioGraphPlan) — the reconciler creates
  // stages by iterating this map directly, upstream first.
  stages: Map<string, AudioStagePlan>;
  // Routed root stage ids, in arrival order.
  sinks: string[];
}

export function emptyAudioGraphPlan(): AudioGraphPlan {
  return { stages: new Map(), sinks: [] };
}

function childrenOf(stage: AudioChainNode): AudioChainNode[] {
  switch (stage.kind) {
    case "effect":
      return [stage.input];
    case "mix":
      return stage.inputs.map((i) => i.chain);
    default:
      return [];
  }
}

function modsOf(stage: AudioChainNode): { param: string; chain: AudioChainNode }[] {
  return stage.kind === "generator" ||
    stage.kind === "effect" ||
    stage.kind === "instrument"
    ? stage.mods ?? []
    : [];
}

// Flatten root descriptor trees into one stage map. Shared subtrees (a
// generator fanned out into two filters) appear once — keyed by nodeId —
// with every consumer pointing at the same stage. When the same nodeId
// shows up with two DIFFERENT descriptor objects (possible while a
// stable:false upstream defeats the cache), the first registration wins;
// within one eval both copies describe the same node with the same params,
// so the choice is content-neutral and, importantly, deterministic.
export function buildAudioGraphPlan(roots: AudioChainRoot[]): AudioGraphPlan {
  const plan = emptyAudioGraphPlan();
  const visit = (stage: AudioChainNode): void => {
    if (plan.stages.has(stage.nodeId)) return;
    const children = childrenOf(stage);
    for (const c of children) visit(c);
    const mods = modsOf(stage);
    for (const m of mods) visit(m.chain);
    plan.stages.set(stage.nodeId, {
      nodeId: stage.nodeId,
      stage,
      inputIds: children.map((c) => c.nodeId),
      modConns: mods.map((m) => ({ param: m.param, fromId: m.chain.nodeId })),
    });
  };
  for (const root of roots) {
    visit(root.chain);
    if (root.routed && !plan.sinks.includes(root.chain.nodeId)) {
      plan.sinks.push(root.chain.nodeId);
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

// Identity of a stage's EXECUTION SHAPE. Same key = the live object can be
// retuned in place; different key = dispose + create (a filter that became
// a delay, an osc that became noise). Params are deliberately not part of
// the key.
export function stageShapeKey(stage: AudioChainNode): string {
  switch (stage.kind) {
    case "element":
      return `element:${stage.source}`;
    case "generator":
      return `generator:${stage.gen}`;
    case "instrument":
      return `instrument:${stage.inst}`;
    case "effect":
      return `effect:${stage.fx}`;
    case "mix":
      return "mix";
  }
}

export interface AudioStageUpdate {
  nodeId: string;
  // Param keys whose values changed (added / removed / different value).
  params: string[];
  // Mix only: some lane's gain/pan/mute changed (lane membership changes
  // surface as a rewire instead).
  mixLanesChanged: boolean;
  // Instrument only: the note list changed — live playback must rebuild
  // this stage's scheduled part.
  notesChanged: boolean;
}

export interface AudioGraphDiff {
  // Stage ids to instantiate, in next-plan topo order. Includes shape
  // changes (which also appear in `dispose`).
  create: string[];
  // Stage ids whose live objects must be torn down (gone, or shape-changed).
  dispose: string[];
  // In-place retunes for surviving stages.
  update: AudioStageUpdate[];
  // Stage ids whose input connections must be re-made: inputIds changed, or
  // an input stage was (re)created this diff. Freshly created stages are
  // included — connection always follows creation.
  rewire: string[];
  // The routed sink set changed (order-insensitive).
  sinksChanged: boolean;
}

export function diffIsEmpty(d: AudioGraphDiff): boolean {
  return (
    d.create.length === 0 &&
    d.dispose.length === 0 &&
    d.update.length === 0 &&
    d.rewire.length === 0 &&
    !d.sinksChanged
  );
}

// Changed-key list between two shallow param records. Order: next's keys
// first (added/changed), then keys that vanished.
export function diffStageParams(
  prev: AudioStageParams,
  next: AudioStageParams
): string[] {
  if (prev === next) return [];
  const changed: string[] = [];
  for (const k of Object.keys(next)) {
    if (prev[k] !== next[k]) changed.push(k);
  }
  for (const k of Object.keys(prev)) {
    if (!(k in next)) changed.push(k);
  }
  return changed;
}

function paramsOf(stage: AudioChainNode): AudioStageParams {
  return stage.kind === "element" ? {} : stage.params;
}

function sameIdList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function notesEqual(a: NoteEvent[], b: NoteEvent[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.pitch !== y.pitch ||
      x.velocity !== y.velocity ||
      x.startTick !== y.startTick ||
      x.durationTicks !== y.durationTicks
    ) {
      return false;
    }
  }
  return true;
}

function mixLanesEqual(a: AudioChainNode, b: AudioChainNode): boolean {
  if (a.kind !== "mix" || b.kind !== "mix") return true;
  if (a.inputs.length !== b.inputs.length) return false;
  for (let i = 0; i < a.inputs.length; i++) {
    const x = a.inputs[i];
    const y = b.inputs[i];
    if (x.gain !== y.gain || x.pan !== y.pan || x.mute !== y.mute) return false;
  }
  return true;
}

export function diffAudioGraphPlans(
  prev: AudioGraphPlan,
  next: AudioGraphPlan
): AudioGraphDiff {
  const create: string[] = [];
  const dispose: string[] = [];
  const update: AudioStageUpdate[] = [];
  const rewire: string[] = [];
  const recreated = new Set<string>();

  // next-plan iteration order is topo (inputs first), which is exactly the
  // creation order the reconciler needs.
  for (const [id, nextStage] of next.stages) {
    const prevStage = prev.stages.get(id);
    if (!prevStage) {
      create.push(id);
      recreated.add(id);
      continue;
    }
    if (stageShapeKey(prevStage.stage) !== stageShapeKey(nextStage.stage)) {
      dispose.push(id);
      create.push(id);
      recreated.add(id);
      continue;
    }
    // Identity short-circuit: a cache-hit upstream hands back the same
    // descriptor object, so most stages cost one pointer compare per eval.
    if (prevStage.stage === nextStage.stage) continue;
    const params = diffStageParams(
      paramsOf(prevStage.stage),
      paramsOf(nextStage.stage)
    );
    const lanes = !mixLanesEqual(prevStage.stage, nextStage.stage);
    const notes =
      prevStage.stage.kind === "instrument" &&
      nextStage.stage.kind === "instrument" &&
      !notesEqual(prevStage.stage.notes, nextStage.stage.notes);
    if (params.length > 0 || lanes || notes) {
      update.push({
        nodeId: id,
        params,
        mixLanesChanged: lanes,
        notesChanged: notes,
      });
    }
  }

  for (const id of prev.stages.keys()) {
    if (!next.stages.has(id)) dispose.push(id);
  }

  const sameModList = (
    a: AudioStagePlan["modConns"],
    b: AudioStagePlan["modConns"]
  ): boolean => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i].param !== b[i].param || a[i].fromId !== b[i].fromId) return false;
    }
    return true;
  };

  for (const [id, nextStage] of next.stages) {
    const prevStage = prev.stages.get(id);
    const freshlyCreated = recreated.has(id);
    const inputsChanged =
      !prevStage || !sameIdList(prevStage.inputIds, nextStage.inputIds);
    const inputRecreated = nextStage.inputIds.some((i) => recreated.has(i));
    const modsChanged =
      !prevStage || !sameModList(prevStage.modConns, nextStage.modConns);
    const modRecreated = nextStage.modConns.some((m) => recreated.has(m.fromId));
    if (freshlyCreated || inputsChanged || inputRecreated || modsChanged || modRecreated) {
      rewire.push(id);
    }
  }

  const prevSinks = new Set(prev.sinks);
  const nextSinks = new Set(next.sinks);
  const sinksChanged =
    prevSinks.size !== nextSinks.size ||
    next.sinks.some((s) => !prevSinks.has(s)) ||
    // A sink whose stage was recreated needs its destination connection
    // re-made even though the id set is unchanged.
    next.sinks.some((s) => recreated.has(s));

  return { create, dispose, update, rewire, sinksChanged };
}

// Offline automation timeline (080926 M-B): per-stage param snapshots
// sampled from the KEYFRAMED node params across the export window,
// replayed by renderOffline as scheduled ramps. Only entries whose values
// changed need appear (the replay diffs consecutive frames anyway).
// Mix lanes and element leaves are not automatable this way — their
// "params" live outside the params record (documented spec limitation:
// keyframed Crossfade fades / Merge lane gains still export as
// start-of-window snapshots).
export type AudioAutomationTimeline = Map<
  string,
  { timeSec: number; params: AudioStageParams }[]
>;

// Stage ids reachable from the routed sinks (the sinks themselves
// included). The reconciler uses this to decide which element leaves are
// part of an AUDIBLE chain: only those claim their element's direct
// speaker path (mute it, so dry + processed don't double up). An element
// inside an analysis-only chain leaves the direct path alone — the chain
// is silent at the master anyway, and the user may still be listening to
// the element through a plain Source → Output wire.
export function sinkReachableIds(plan: AudioGraphPlan): Set<string> {
  const reachable = new Set<string>();
  const stack = [...plan.sinks];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const sp = plan.stages.get(id);
    if (sp) {
      stack.push(...sp.inputIds);
      // Mod edges join the walk: an element modulating an audible chain
      // is part of that audible graph (its direct speaker path must mute
      // like any processed element's).
      for (const m of sp.modConns) stack.push(m.fromId);
    }
  }
  return reachable;
}

// Content signature of a whole chain — stable string over stage kinds,
// params, notes, mix lanes, and element urls (NOT element object identity,
// which never serializes). Used to invalidate offline analysis-tap buffers
// (080926_audio-v2-integration.md M-A): descriptor OBJECT identity churns
// every eval under a stable:false upstream, but two chains with equal
// signatures render identical offline audio, so the signature is the
// honest cache key. Cheap: chains are a handful of stages; notes lists are
// the only bulk, and they're plain number joins.
export function chainSignature(chain: AudioChainNode): string {
  const parts: string[] = [];
  const paramsSig = (p: AudioStageParams): string =>
    Object.keys(p)
      .sort()
      .map((k) => `${k}=${p[k]}`)
      .join(",");
  const visit = (s: AudioChainNode): void => {
    switch (s.kind) {
      case "element":
        parts.push(`el:${s.nodeId}:${s.source}:${s.url ?? ""}`);
        return;
      case "generator":
        parts.push(`gen:${s.nodeId}:${s.gen}:${paramsSig(s.params)}`);
        break;
      case "instrument": {
        let n = "";
        for (const ev of s.notes) {
          n += `${ev.pitch},${ev.velocity},${ev.startTick},${ev.durationTicks};`;
        }
        parts.push(`inst:${s.nodeId}:${s.inst}:${paramsSig(s.params)}:${n}`);
        break;
      }
      case "effect":
        parts.push(`fx:${s.nodeId}:${s.fx}:${paramsSig(s.params)}`);
        visit(s.input);
        break;
      case "mix":
        parts.push(
          `mix:${s.nodeId}:${s.inputs
            .map((i) => `${i.gain},${i.pan},${i.mute ? 1 : 0}`)
            .join("|")}`
        );
        for (const i of s.inputs) visit(i.chain);
        return;
    }
    // Mod edges are content too — a re-aimed or re-tuned modulator changes
    // what the chain sounds like.
    if (s.kind === "generator" || s.kind === "effect" || s.kind === "instrument") {
      for (const m of s.mods ?? []) {
        parts.push(`mod:${s.nodeId}:${m.param}`);
        visit(m.chain);
      }
    }
  };
  visit(chain);
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Musical time
// ---------------------------------------------------------------------------

export const DEFAULT_BPM = 120;

// Ticks are the app's integer timebase: tick = frame × ticksPerFrame,
// seconds = tick / (ticksPerFrame × fps). See engine/keyframes.ts.
export function audioTickToSeconds(
  tick: number,
  ticksPerFrame: number,
  fps: number
): number {
  return tick / (ticksPerFrame * Math.max(1e-6, fps));
}

export function beatsToTicks(
  beats: number,
  bpm: number,
  ticksPerFrame: number,
  fps: number
): number {
  const seconds = (beats * 60) / Math.max(1e-6, bpm);
  return Math.round(seconds * ticksPerFrame * fps);
}

export interface ScheduledNote {
  timeSec: number;
  durationSec: number;
  pitch: number;
  velocity: number;
}

// NoteEvent[] (ticks) → transport-seconds events, sorted by start time.
// Zero/negative durations clamp to one tick so every scheduled note has an
// audible attack+release pair.
export function noteEventsToSeconds(
  notes: readonly NoteEvent[],
  ticksPerFrame: number,
  fps: number
): ScheduledNote[] {
  const out: ScheduledNote[] = notes.map((n) => ({
    timeSec: audioTickToSeconds(n.startTick, ticksPerFrame, fps),
    durationSec: audioTickToSeconds(
      Math.max(1, n.durationTicks),
      ticksPerFrame,
      fps
    ),
    pitch: n.pitch,
    velocity: Math.max(0, Math.min(1, n.velocity)),
  }));
  out.sort((a, b) => a.timeSec - b.timeSec);
  return out;
}

// MIDI note number → Hz (69 = A4 = 440). Fractional pitches detune.
export function midiToFreq(pitch: number): number {
  return 440 * Math.pow(2, (pitch - 69) / 12);
}
