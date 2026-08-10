// Evaluator performance collector — spec specdocs/080726_perf-profiler.md (M1).
//
// A columnar ring buffer of per-eval samples. Engine-side and import-free
// (devguide invariant #1: nothing under src/engine may reach into
// src/components | src/state | src/lib), so the evaluator can write to it
// and any sink — perf panel, MCP handler, headless bench — pulls from it.
//
// WHY COLUMNAR: a 200-node graph at 60fps is ~12k node samples/second. An
// object per node per frame would add GC pressure to the exact hot path
// under study, so writes go into preallocated typed arrays and object
// shapes are materialized only when a sink reads. Same reasoning that put
// PointsValue on typed arrays (see points.ts).
//
// WHY A MODULE SINGLETON: there is one editor session, and threading a
// collector through evaluateGraph → compute → gl.ts would touch every node
// def. The level check is a single numeric compare, and at level 0 nothing
// past that compare runs.

// ---------------------------------------------------------------------------
// Capture levels
// ---------------------------------------------------------------------------

// 0 off · 1 phases + node ms + reason · 2 + fingerprint bytes/time, volume,
// pool churn · 3 + GPU timer queries (M5, not yet implemented).
export type CaptureLevel = 0 | 1 | 2 | 3;

/** True when the caller should issue GPU timer queries. */
export function wantsGpuTiming(): boolean {
  return level >= 3;
}

export const REASONS = [
  "hit", // fingerprint matched — no compute ran
  "cold", // no prior cache entry
  "params", // this node's own params changed
  "input", // an input fingerprint changed — the chain-poisoning signal
  "anim", // keyframe / animation block advanced
  "unstable", // def.stable === false — never cacheable
  "extras", // fingerprintExtras changed (Cursor, Wedge, Iterate shells)
  "bypass", // node is bypassed — passthrough, no compute
  "gated", // outside its clip window — empty output, no compute
  "error", // compute threw
  "other", // fingerprint changed but no single part explains it
] as const;
export type RecomputeReason = (typeof REASONS)[number];

const REASON_INDEX: Record<RecomputeReason, number> = Object.fromEntries(
  REASONS.map((r, i) => [r, i])
) as Record<RecomputeReason, number>;

export const TRIGGERS = [
  "raf", // playback rAF tick
  "state", // React state change (param edit, wire, selection)
  "bump", // async result landed (font, video frame, image-gen)
  "seek", // scrub / explicit time set
  "export", // offline frame-by-frame capture
  "unknown",
] as const;
export type FrameTrigger = (typeof TRIGGERS)[number];

const TRIGGER_INDEX: Record<FrameTrigger, number> = Object.fromEntries(
  TRIGGERS.map((t, i) => [t, i])
) as Record<FrameTrigger, number>;

// Phase slots, in the order they appear in the per-frame phase block.
// `compute` and `post` are sums over nodes; `total` is evaluateGraph's own
// wall clock, so total − (the rest) is unattributed evaluator overhead.
const PHASE_NAMES = [
  "flatten",
  "topo",
  "fingerprint",
  "compute",
  "post",
  "blit",
  "total",
] as const;
export type PhaseName = (typeof PHASE_NAMES)[number];
const PHASE_COUNT = PHASE_NAMES.length;
const PHASE_INDEX: Record<PhaseName, number> = Object.fromEntries(
  PHASE_NAMES.map((p, i) => [p, i])
) as Record<PhaseName, number>;

// ---------------------------------------------------------------------------
// Public sample shapes (materialized on read only)
// ---------------------------------------------------------------------------

export interface NodeVolume {
  points?: number;
  subpaths?: number;
  anchors?: number;
  /** Textures leased during this node's compute. */
  allocs?: number;
  /** Texels allocated during this node's compute. */
  px?: number;
}

export interface NodeSample {
  id: string;
  type: string;
  /** Compute + the evaluator's mask/opacity post-passes, ms. */
  ms: number;
  /** Fingerprint build time, ms. Level 2+. */
  fpMs?: number;
  /**
   * GPU time for this node's draws, ms. Level 3 only, and only where the
   * timer extension is available. Arrives one to three frames after `ms`, so
   * the newest frames in a trace legitimately lack it — absent means "not yet
   * resolved or not measured", never "zero".
   */
  gpuMs?: number;
  reason: RecomputeReason;
  /**
   * Nested-eval depth. 0 = root pass. >0 = inside an Iterate interior, and
   * its time is ALREADY INCLUDED in the enclosing depth-0 sample — sum only
   * depth-0 samples for a frame total or you double-count.
   */
  depth: number;
  vol?: NodeVolume;
}

export interface FrameSample {
  seq: number;
  /** performance.now() at eval start. */
  t: number;
  tick: number;
  playing: boolean;
  trigger: FrameTrigger;
  /** Since the previous eval's start — the true frame-rate signal. */
  gapMs: number;
  /**
   * Phase buckets and the node table are two different decompositions of the
   * same frame, not addends — do not mix them.
   *
   * Phases INCLUDE work done inside nested (Iterate) passes, charged to the
   * bucket it actually happened in. The node table's depth-0 samples instead
   * charge all of that to the enclosing shell. So for an Iterate graph,
   * `sum(depth-0 ms)` will exceed `compute + post` — the shell's time also
   * covers interior flatten/topo/fingerprint. That's the trace being honest
   * about two viewpoints, not a bookkeeping error.
   *
   * `blit` is measured outside evaluateGraph and is NOT part of `total`.
   */
  phases: Record<PhaseName, number>;
  /** Total characters of fingerprint string built. Level 2+. */
  fingerprintBytes: number;
  pool: { allocs: number; releases: number; bytes: number };
  nodes: NodeSample[];
}

export interface TraceMeta {
  level: CaptureLevel;
  /** Frames dropped off the back of the ring since capture started. */
  droppedFrames: number;
  /** Frames whose node samples were overwritten by arena wrap. */
  truncatedFrames: number;
  frameCapacity: number;
  nodeCapacity: number;
}

export interface Trace {
  meta: TraceMeta;
  frames: FrameSample[];
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const DEFAULT_FRAMES = 600; // ~10s at 60fps
const DEFAULT_NODES_PER_FRAME = 64;
const MIN_ARENA = 8192;
const MAX_ARENA = 500_000;

let level: CaptureLevel = 0;

// Interned id/type tables. Node ids and defTypes repeat every frame, so
// interning turns a per-sample string reference into an Int32 write.
let strings: string[] = [];
let stringIds = new Map<string, number>();
function intern(s: string): number {
  const hit = stringIds.get(s);
  if (hit !== undefined) return hit;
  const id = strings.length;
  strings.push(s);
  stringIds.set(s, id);
  return id;
}

let frameCap = 0;
let arenaCap = 0;

// Per-frame columns (indexed by seq % frameCap).
let fSeq!: Float64Array;
let fT!: Float64Array;
let fTick!: Float64Array;
let fGap!: Float32Array;
let fPlaying!: Uint8Array;
let fTrigger!: Uint8Array;
let fPhase!: Float32Array; // frameCap * PHASE_COUNT
let fFpBytes!: Float64Array;
let fPoolAllocs!: Int32Array;
let fPoolReleases!: Int32Array;
let fPoolBytes!: Float64Array;
let fNodeStart!: Float64Array; // monotonic arena position at frame start
let fNodeCount!: Int32Array;

// Node arena columns (circular, indexed by arenaTotal % arenaCap).
let aNode!: Int32Array;
let aType!: Int32Array;
let aMs!: Float32Array;
let aFpMs!: Float32Array;
let aReason!: Uint8Array;
let aDepth!: Uint8Array;
let aPoints!: Int32Array;
let aSubpaths!: Int32Array;
let aAnchors!: Int32Array;
let aAllocs!: Int32Array;
let aPx!: Float64Array;
// -1 = unresolved. Written LATE, by resolveNodeGpu, into frames that have
// already been committed.
let aGpuMs!: Float32Array;

// Monotonic counters. `arenaTotal` is a plain number (exact to 2^53), which
// is what makes the overwrite check below a subtraction rather than modular
// arithmetic.
let seqCounter = 0;
let arenaTotal = 0;
let droppedFrames = 0;

// Scratch for the frame currently being written.
const curPhase = new Float64Array(PHASE_COUNT);
let curFpBytes = 0;
let curPoolAllocs = 0;
let curPoolReleases = 0;
let curPoolBytes = 0;
let curNodeStart = 0;
let curNodeCount = 0;
let curT = 0;
let curTick = 0;
let curPlaying = false;
let curTrigger: FrameTrigger = "unknown";
let pendingTrigger: FrameTrigger | null = null;
let lastEvalStart = 0;

// Depth of nested evaluateGraph calls. Only depth 0 opens/closes a frame.
let evalDepth = 0;
let frameOpen = false;
// Slot of the most recently closed frame, so a post-eval markBlit lands on
// the frame it belongs to.
let lastClosedSlot = -1;

// Per-node scratch, reset by nodeBegin. Pool counters are attributed to
// whichever node is currently computing.
let nodeAllocs = 0;
let nodePx = 0;

function allocStorage(frames: number): void {
  frameCap = Math.max(1, frames | 0);
  arenaCap = Math.min(
    MAX_ARENA,
    Math.max(MIN_ARENA, frameCap * DEFAULT_NODES_PER_FRAME)
  );

  fSeq = new Float64Array(frameCap);
  fT = new Float64Array(frameCap);
  fTick = new Float64Array(frameCap);
  fGap = new Float32Array(frameCap);
  fPlaying = new Uint8Array(frameCap);
  fTrigger = new Uint8Array(frameCap);
  fPhase = new Float32Array(frameCap * PHASE_COUNT);
  fFpBytes = new Float64Array(frameCap);
  fPoolAllocs = new Int32Array(frameCap);
  fPoolReleases = new Int32Array(frameCap);
  fPoolBytes = new Float64Array(frameCap);
  fNodeStart = new Float64Array(frameCap);
  fNodeCount = new Int32Array(frameCap);
  // -1 marks "never written" so readTrace can skip unfilled slots on a
  // ring that hasn't wrapped yet.
  fSeq.fill(-1);

  aNode = new Int32Array(arenaCap);
  aType = new Int32Array(arenaCap);
  aMs = new Float32Array(arenaCap);
  aFpMs = new Float32Array(arenaCap);
  aReason = new Uint8Array(arenaCap);
  aDepth = new Uint8Array(arenaCap);
  aPoints = new Int32Array(arenaCap);
  aSubpaths = new Int32Array(arenaCap);
  aAnchors = new Int32Array(arenaCap);
  aAllocs = new Int32Array(arenaCap);
  aPx = new Float64Array(arenaCap);
  aGpuMs = new Float32Array(arenaCap);
  aGpuMs.fill(-1);
}

function resetStorage(): void {
  strings = [];
  stringIds = new Map();
  topoSource = [];
  topoTarget = [];
  topoRef = null;
  seqCounter = 0;
  arenaTotal = 0;
  droppedFrames = 0;
  evalDepth = 0;
  frameOpen = false;
  lastClosedSlot = -1;
  lastEvalStart = 0;
  pendingTrigger = null;
}

// ---------------------------------------------------------------------------
// Control
// ---------------------------------------------------------------------------

// When set, only evals with the transport playing are captured — paused
// param edits, scrubs, and preview renders are gated out at beginEval, so
// they open no frame, no GPU queries, and no arena writes. The Performance
// panel arms with this ON (its stats should describe playback, not whatever
// the user happened to click while reading them); the MCP tools arm with it
// OFF, because the agent workflow explicitly traces paused edits
// ("set_param, then get_perf").
let playingOnly = false;

/**
 * Arm or disarm capture. Setting a level always clears the existing trace —
 * mixing samples from two capture levels would produce a trace whose columns
 * are populated for some frames and not others.
 */
export function setCaptureLevel(
  next: CaptureLevel,
  opts?: { frames?: number; playingOnly?: boolean }
): void {
  level = next;
  playingOnly = opts?.playingOnly ?? false;
  resetStorage();
  if (next === 0) {
    // Drop the arrays so an idle session doesn't hold ~40MB of typed arrays.
    frameCap = 0;
    arenaCap = 0;
    return;
  }
  allocStorage(opts?.frames ?? DEFAULT_FRAMES);
}

export function getCaptureLevel(): CaptureLevel {
  return level;
}

/** Clear samples, keep the level and capacity. */
export function resetTrace(): void {
  if (level === 0) return;
  const frames = frameCap;
  resetStorage();
  allocStorage(frames);
}

/**
 * Label the next root eval. The caller knows why it is evaluating;
 * evaluateGraph does not. Consumed by the next depth-0 beginEval.
 */
export function markTrigger(t: FrameTrigger): void {
  if (level === 0) return;
  pendingTrigger = t;
}

/**
 * Label the next root eval only if nothing more specific was set. The render
 * path can infer a coarse trigger for every eval; a call site that knows
 * better (a scrub, an async bump) calls markTrigger first and wins.
 */
export function markTriggerDefault(t: FrameTrigger): void {
  if (level === 0 || pendingTrigger !== null) return;
  pendingTrigger = t;
}

// ---------------------------------------------------------------------------
// Write path (evaluator)
// ---------------------------------------------------------------------------

/**
 * Open an eval. Returns whether this pass is being captured, so the caller
 * can hold it in a local and skip every other profiler call at level 0.
 * Nested passes (Iterate interiors) do not open a frame — their samples land
 * in the enclosing frame tagged with depth > 0.
 *
 * `playing` is the transport state for THIS eval (the same value endEval
 * records). Under `playingOnly` capture, a paused eval is gated HERE rather
 * than discarded at commit: no frame opens, so recordNode/countAlloc all
 * no-op on their frameOpen guards, the evaluator sees `false` and skips its
 * GPU timer entirely, and seqCounter never advances — which matters because
 * a late resolveNodeGpu(seq, …) for a discarded-at-commit frame would have
 * matched the NEXT committed frame reusing that seq and billed a stale GPU
 * time to the wrong frame's nodes.
 */
export function beginEval(nested: boolean, playing?: boolean): boolean {
  if (level === 0) return false;
  if (nested) {
    evalDepth++;
    return frameOpen;
  }
  if (playingOnly && !playing) {
    // Consume the trigger — it labeled this (uncaptured) eval; leaving it
    // pending would mislabel the first captured frame after play starts.
    pendingTrigger = null;
    evalDepth = 1;
    frameOpen = false;
    return false;
  }
  // Keyed purely off `nested`, not off evalDepth: a root pass is a root pass.
  // If a previous eval threw before endEval, the depth counter is stale — this
  // self-heals rather than mis-filing every later frame as nested.
  evalDepth = 1;
  frameOpen = true;
  const now = performance.now();
  curPhase.fill(0);
  curFpBytes = 0;
  curPoolAllocs = 0;
  curPoolReleases = 0;
  curPoolBytes = 0;
  curNodeStart = arenaTotal;
  curNodeCount = 0;
  curT = now;
  curTrigger = pendingTrigger ?? "unknown";
  pendingTrigger = null;
  return true;
}

/** Close an eval and, at depth 0, commit the frame. */
export function endEval(
  nested: boolean,
  info?: { tick?: number; playing?: boolean }
): void {
  if (level === 0) return;
  if (nested) {
    if (evalDepth > 0) evalDepth--;
    return;
  }
  if (!frameOpen) {
    evalDepth = 0;
    return;
  }
  evalDepth = 0;
  frameOpen = false;

  const now = performance.now();
  curPhase[PHASE_INDEX.total] = now - curT;
  curTick = info?.tick ?? 0;
  curPlaying = info?.playing ?? false;

  const slot = seqCounter % frameCap;
  if (fSeq[slot] >= 0) droppedFrames++;
  fSeq[slot] = seqCounter;
  fT[slot] = curT;
  fTick[slot] = curTick;
  fGap[slot] = lastEvalStart > 0 ? curT - lastEvalStart : 0;
  fPlaying[slot] = curPlaying ? 1 : 0;
  fTrigger[slot] = TRIGGER_INDEX[curTrigger];
  for (let i = 0; i < PHASE_COUNT; i++) {
    fPhase[slot * PHASE_COUNT + i] = curPhase[i];
  }
  fFpBytes[slot] = curFpBytes;
  fPoolAllocs[slot] = curPoolAllocs;
  fPoolReleases[slot] = curPoolReleases;
  fPoolBytes[slot] = curPoolBytes;
  fNodeStart[slot] = curNodeStart;
  fNodeCount[slot] = curNodeCount;

  lastEvalStart = curT;
  lastClosedSlot = slot;
  seqCounter++;
}

/** Add `ms` to a frame-level phase bucket. */
export function addPhase(name: PhaseName, ms: number): void {
  if (level === 0 || !frameOpen) return;
  curPhase[PHASE_INDEX[name]] += ms;
}

/**
 * Attribute the blit to the frame that just closed. The blit happens after
 * evaluateGraph returns, so there is no open frame to charge it to.
 */
export function markBlit(ms: number): void {
  if (level === 0 || lastClosedSlot < 0) return;
  fPhase[lastClosedSlot * PHASE_COUNT + PHASE_INDEX.blit] += ms;
}

/** Level 2: total characters of fingerprint string built this eval. */
export function addFingerprintBytes(n: number): void {
  if (level < 2 || !frameOpen) return;
  curFpBytes += n;
}

/**
 * Open per-node pool attribution. Call immediately before def.compute so
 * texture allocations land on the right node.
 */
export function nodeBegin(): void {
  if (level < 2) return;
  nodeAllocs = 0;
  nodePx = 0;
}

/** Texture pool counters, called from gl.ts. */
export function countAlloc(w: number, h: number, bytesPerTexel: number): void {
  if (level < 2 || !frameOpen) return;
  nodeAllocs++;
  nodePx += w * h;
  curPoolAllocs++;
  curPoolBytes += w * h * bytesPerTexel;
}

export function countRelease(): void {
  if (level < 2 || !frameOpen) return;
  curPoolReleases++;
}

/**
 * Record one node sample. `vol` is read at level 2+ only; callers should
 * skip building it below that.
 */
export function recordNode(
  id: string,
  type: string,
  ms: number,
  reason: RecomputeReason,
  depth: number,
  fpMs: number,
  vol?: { points?: number; subpaths?: number; anchors?: number }
): number {
  if (level === 0 || !frameOpen) return -1;
  const i = arenaTotal % arenaCap;
  aNode[i] = intern(id);
  aType[i] = intern(type);
  aMs[i] = ms;
  aFpMs[i] = fpMs;
  aReason[i] = REASON_INDEX[reason];
  aDepth[i] = depth > 255 ? 255 : depth;
  if (level >= 2) {
    aPoints[i] = vol?.points ?? -1;
    aSubpaths[i] = vol?.subpaths ?? -1;
    aAnchors[i] = vol?.anchors ?? -1;
    aAllocs[i] = nodeAllocs;
    aPx[i] = nodePx;
  } else {
    aPoints[i] = -1;
    aSubpaths[i] = -1;
    aAnchors[i] = -1;
    aAllocs[i] = 0;
    aPx[i] = 0;
  }
  aGpuMs[i] = -1;
  arenaTotal++;
  // The index WITHIN this frame — the address a GPU result resolves back to,
  // since the arena slot itself may be recycled by the time it lands.
  return curNodeCount++;
}

/** Sequence number of the frame currently being written. */
export function currentSeq(): number {
  return seqCounter;
}


/**
 * Write a GPU timing into an already-committed frame. Silently drops results
 * for frames that have aged out of the ring or whose node samples were
 * overwritten by arena wrap — a late result for a frame nobody can read is
 * not an error, it's the normal tail of an async pipeline.
 */
export function resolveNodeGpu(seq: number, idx: number, ms: number): void {
  if (level === 0 || frameCap === 0) return;
  const slot = seq % frameCap;
  if (fSeq[slot] !== seq) return;
  if (idx < 0 || idx >= fNodeCount[slot]) return;
  const start = fNodeStart[slot];
  if (arenaTotal - start > arenaCap) return; // node samples already recycled
  aGpuMs[(start + idx) % arenaCap] = ms;
}

// ---------------------------------------------------------------------------
// Read path (sinks)
// ---------------------------------------------------------------------------

/**
 * Materialize the trace. `frames` caps how many of the most recent frames
 * come back (default all). Frames whose node samples have been overwritten
 * by arena wrap come back with an empty `nodes` array and are counted in
 * `meta.truncatedFrames` — a silently short list would read as "this frame
 * was cheap".
 */
export function readTrace(opts?: { frames?: number }): Trace {
  const meta: TraceMeta = {
    level,
    droppedFrames,
    truncatedFrames: 0,
    frameCapacity: frameCap,
    nodeCapacity: arenaCap,
  };
  if (level === 0 || frameCap === 0) return { meta, frames: [] };

  // Walk seq descending so "most recent N" is a prefix, then reverse.
  const want = Math.min(opts?.frames ?? frameCap, frameCap, seqCounter);
  const out: FrameSample[] = [];
  for (let k = 0; k < want; k++) {
    const seq = seqCounter - 1 - k;
    if (seq < 0) break;
    const slot = seq % frameCap;
    if (fSeq[slot] !== seq) break; // overwritten by a newer frame
    out.push(materializeFrame(slot, meta));
  }
  out.reverse();
  return { meta, frames: out };
}

/** One frame by sequence number. Null if it has aged out of the ring. */
export function readFrame(seq: number): FrameSample | null {
  if (level === 0 || frameCap === 0) return null;
  const slot = seq % frameCap;
  if (fSeq[slot] !== seq) return null;
  const meta: TraceMeta = {
    level,
    droppedFrames,
    truncatedFrames: 0,
    frameCapacity: frameCap,
    nodeCapacity: arenaCap,
  };
  return materializeFrame(slot, meta);
}

function materializeFrame(slot: number, meta: TraceMeta): FrameSample {
  const phases = {} as Record<PhaseName, number>;
  for (let i = 0; i < PHASE_COUNT; i++) {
    phases[PHASE_NAMES[i]] = fPhase[slot * PHASE_COUNT + i];
  }

  const start = fNodeStart[slot];
  const count = fNodeCount[slot];
  const nodes: NodeSample[] = [];
  // The arena is circular: a frame's samples survive only while they are
  // within arenaCap writes of the head.
  const intact = arenaTotal - start <= arenaCap;
  if (!intact && count > 0) {
    meta.truncatedFrames++;
  } else {
    for (let k = 0; k < count; k++) {
      const i = (start + k) % arenaCap;
      const s: NodeSample = {
        id: strings[aNode[i]] ?? "?",
        type: strings[aType[i]] ?? "?",
        ms: aMs[i],
        reason: REASONS[aReason[i]] ?? "other",
        depth: aDepth[i],
      };
      if (aGpuMs[i] >= 0) s.gpuMs = aGpuMs[i];
      if (level >= 2) {
        s.fpMs = aFpMs[i];
        const vol: NodeVolume = {};
        if (aPoints[i] >= 0) vol.points = aPoints[i];
        if (aSubpaths[i] >= 0) vol.subpaths = aSubpaths[i];
        if (aAnchors[i] >= 0) vol.anchors = aAnchors[i];
        if (aAllocs[i] > 0) vol.allocs = aAllocs[i];
        if (aPx[i] > 0) vol.px = aPx[i];
        if (Object.keys(vol).length > 0) s.vol = vol;
      }
      nodes.push(s);
    }
  }

  return {
    seq: fSeq[slot],
    t: fT[slot],
    tick: fTick[slot],
    playing: fPlaying[slot] === 1,
    trigger: TRIGGERS[fTrigger[slot]] ?? "unknown",
    gapMs: fGap[slot],
    phases,
    fingerprintBytes: fFpBytes[slot],
    pool: {
      allocs: fPoolAllocs[slot],
      releases: fPoolReleases[slot],
      bytes: fPoolBytes[slot],
    },
    nodes,
  };
}

/** Frames captured since the last reset (may exceed what the ring holds). */
export function frameCount(): number {
  return seqCounter;
}

// ---------------------------------------------------------------------------
// Topology
// ---------------------------------------------------------------------------

// The FLATTENED edge list the evaluator actually ran against. Sinks need this
// to attribute chain poisoning, and they must not reconstruct it from the raw
// project edges: flatten dissolves groups and rewires layer interiors onto the
// layer's hidden `content` input, so a walk over raw edges stops dead at every
// group boundary and massively under-reports the downstream cone. (Found the
// hard way — the first real trace showed every node recomputing with reason
// "input" while the poison report named a single root with one descendant.)
let topoSource: string[] = [];
let topoTarget: string[] = [];
let topoRef: unknown = null;

/**
 * Record the flattened topology. Rebuilds only when the caller hands over a
 * different array instance — for structure-free graphs flattenGraph returns
 * the same array every eval, so this is one identity compare per frame.
 */
export function recordTopology(
  edges: readonly { source: string; target: string }[]
): void {
  if (level === 0 || !frameOpen) return;
  if (edges === topoRef) return;
  topoRef = edges;
  const n = edges.length;
  const src = new Array<string>(n);
  const dst = new Array<string>(n);
  for (let i = 0; i < n; i++) {
    src[i] = edges[i].source;
    dst[i] = edges[i].target;
  }
  topoSource = src;
  topoTarget = dst;
}

/** The most recent flattened topology, or an empty list if none was recorded. */
export function readTopology(): { source: string; target: string }[] {
  const out: { source: string; target: string }[] = [];
  for (let i = 0; i < topoSource.length; i++) {
    out.push({ source: topoSource[i], target: topoTarget[i] });
  }
  return out;
}
