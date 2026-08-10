// Console handle for the evaluator perf trace — spec
// specdocs/080726_perf-profiler.md (M1).
//
// M1 ships no UI, so this is how a trace gets armed and read: `__perf` on
// window. The aggregation below is NOT throwaway — the perf panel (M3) and
// the `get_perf` MCP tool (M2) both need exactly this summary, so it lives
// here rather than inside a console helper, and both will import it.
//
// App-side rather than engine-side on purpose: `summarize` needs the graph
// edges to attribute chain poisoning, and the engine may not reach into app
// state (devguide invariant #1). The engine collects; this interprets.

import * as prof from "@/engine/profiler";
import type { FrameSample, RecomputeReason } from "@/engine/profiler";
import {
  getBlendFieldForceCpu,
  setBlendFieldForceCpu,
} from "@/engine/spline-blend-intersections-gpu";

export interface NodeAggregate {
  id: string;
  type: string;
  /** Evals in which this node appeared. */
  samples: number;
  /** Evals in which it actually recomputed (reason !== "hit"). */
  recomputes: number;
  /** Fraction of appearances that recomputed. 1 = never cached. */
  recomputeRate: number;
  totalMs: number;
  meanMs: number;
  p95Ms: number;
  maxMs: number;
  /** Mean ms per frame across the window — the honest "what does this cost me". */
  msPerFrame: number;
  dominantReason: RecomputeReason;
  reasons: Partial<Record<RecomputeReason, number>>;
  /** Mean GPU ms per frame. Level 3 only; absent when nothing resolved. */
  gpuMsPerFrame?: number;
  /** How many of this node's samples carried a resolved GPU timing. */
  gpuSamples?: number;
  points?: number;
  /** Nanoseconds per point at the mean — algorithm-bound vs overhead-bound. */
  nsPerPoint?: number;
  allocs?: number;
}

export interface PoisonRoot {
  id: string;
  type: string;
  reason: RecomputeReason;
  /** Its own mean cost per frame. */
  selfMsPerFrame: number;
  /** Mean per-frame cost of descendants that recomputed with reason "input". */
  downstreamMsPerFrame: number;
  downstreamNodes: number;
}

export interface PerfSummary {
  level: number;
  frames: number;
  droppedFrames: number;
  truncatedFrames: number;
  fps: { mean: number; p5: number } | null;
  frameMs: { mean: number; p50: number; p95: number; max: number };
  /**
   * The slowest frames, with their sequence numbers — without these, a p95 or
   * max in this payload is a dead end, because get_perf_frame needs a `seq`
   * and nothing else in the summary carries one.
   */
  worstFrames: { seq: number; totalMs: number; trigger: string }[];
  /**
   * What caused each eval, by count. The question this answers is "why is the
   * app evaluating at all" — a paused, idle editor showing hundreds of `raf`
   * frames is burning a full graph evaluation per tick for nothing, and no
   * per-node number reveals that.
   */
  triggers: Partial<Record<string, number>>;
  phaseMsPerFrame: Record<string, number>;
  /** total − the sum of the named phases: evaluator work nobody has named yet. */
  unattributedMsPerFrame: number;
  /**
   * Level 3 only. `msPerFrame` is summed GPU time across nodes — the number
   * to compare against the frame budget when CPU time looks innocent.
   * `coverage` is the share of node samples that resolved a timing; a low
   * value means most of the picture is missing, not that the GPU was idle.
   */
  gpu?: { msPerFrame: number; coverage: number };
  fingerprintBytesPerFrame: number;
  poolPerFrame: { allocs: number; releases: number; mb: number };
  /**
   * Share of node evaluations that hit the cache, plus how many nodes are
   * EFFECTIVELY never cached (recompute rate ≥ 95%). The threshold matters:
   * a strict "zero hits ever" test reported 1 of 28 on a graph where twelve
   * nodes had hit exactly once in 600 frames — technically cached, in
   * practice recomputing forever.
   */
  cache: {
    hitRate: number;
    alwaysRecomputing: number;
    totalNodes: number;
  };
  nodes: NodeAggregate[];
  poisonRoots: PoisonRoot[];
}

export interface GraphEdgeLite {
  source: string;
  target: string;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

const round = (n: number, d = 2) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

/**
 * Collapse a trace into the shape a human table or an LLM can read.
 *
 * `edges` is optional; without it the poisoning report is empty, because
 * "which nodes are downstream of this one" is not answerable from timings
 * alone and guessing would be worse than omitting it.
 */
export function summarize(opts?: {
  frames?: number;
  top?: number;
  edges?: readonly GraphEdgeLite[];
}): PerfSummary {
  const trace = prof.readTrace({ frames: opts?.frames });
  const frames = trace.frames;
  const n = frames.length;

  const empty: PerfSummary = {
    level: trace.meta.level,
    frames: 0,
    droppedFrames: trace.meta.droppedFrames,
    truncatedFrames: trace.meta.truncatedFrames,
    fps: null,
    frameMs: { mean: 0, p50: 0, p95: 0, max: 0 },
    worstFrames: [],
    triggers: {},
    phaseMsPerFrame: {},
    unattributedMsPerFrame: 0,
    fingerprintBytesPerFrame: 0,
    poolPerFrame: { allocs: 0, releases: 0, mb: 0 },
    cache: { hitRate: 0, alwaysRecomputing: 0, totalNodes: 0 },
    nodes: [],
    poisonRoots: [],
  };
  if (n === 0) return empty;

  // --- frame level ---------------------------------------------------------
  const totals: number[] = [];
  const gaps: number[] = [];
  const phaseSum: Record<string, number> = {};
  const triggers: Partial<Record<string, number>> = {};
  let fpBytes = 0;
  let poolA = 0;
  let poolR = 0;
  let poolBytes = 0;
  for (const f of frames) {
    totals.push(f.phases.total);
    // gap 0 = first frame of the capture, no previous eval to measure from.
    if (f.gapMs > 0) gaps.push(f.gapMs);
    for (const [k, v] of Object.entries(f.phases)) {
      phaseSum[k] = (phaseSum[k] ?? 0) + v;
    }
    triggers[f.trigger] = (triggers[f.trigger] ?? 0) + 1;
    fpBytes += f.fingerprintBytes;
    poolA += f.pool.allocs;
    poolR += f.pool.releases;
    poolBytes += f.pool.bytes;
  }
  const sortedTotals = [...totals].sort((a, b) => a - b);
  const sortedGaps = [...gaps].sort((a, b) => a - b);

  const phaseMsPerFrame: Record<string, number> = {};
  for (const [k, v] of Object.entries(phaseSum)) {
    phaseMsPerFrame[k] = round(v / n);
  }
  // `total` is measured wall clock; the rest are components of it. blit is
  // measured OUTSIDE evaluateGraph, so it isn't part of total and mustn't be
  // subtracted here.
  const named =
    (phaseMsPerFrame.flatten ?? 0) +
    (phaseMsPerFrame.topo ?? 0) +
    (phaseMsPerFrame.fingerprint ?? 0) +
    (phaseMsPerFrame.compute ?? 0) +
    (phaseMsPerFrame.post ?? 0);

  // --- node level ----------------------------------------------------------
  // Depth-0 samples only: interior (Iterate) time is already inside its
  // shell's number, so including both would double-count the frame.
  interface Acc {
    type: string;
    ms: number[];
    recomputes: number;
    reasons: Partial<Record<RecomputeReason, number>>;
    points: number;
    pointSamples: number;
    allocs: number;
    gpuMs: number;
    gpuSamples: number;
  }
  const acc = new Map<string, Acc>();
  for (const f of frames) {
    for (const s of f.nodes) {
      if (s.depth !== 0) continue;
      let a = acc.get(s.id);
      if (!a) {
        a = {
          type: s.type,
          ms: [],
          recomputes: 0,
          reasons: {},
          points: 0,
          pointSamples: 0,
          allocs: 0,
          gpuMs: 0,
          gpuSamples: 0,
        };
        acc.set(s.id, a);
      }
      a.ms.push(s.ms);
      if (s.gpuMs !== undefined) {
        a.gpuMs += s.gpuMs;
        a.gpuSamples++;
      }
      if (s.reason !== "hit") a.recomputes++;
      a.reasons[s.reason] = (a.reasons[s.reason] ?? 0) + 1;
      if (s.vol?.points !== undefined) {
        a.points += s.vol.points;
        a.pointSamples++;
      }
      if (s.vol?.allocs) a.allocs += s.vol.allocs;
    }
  }

  const nodes: NodeAggregate[] = [];
  for (const [id, a] of acc) {
    const sorted = [...a.ms].sort((x, y) => x - y);
    const total = a.ms.reduce((x, y) => x + y, 0);
    const mean = total / a.ms.length;
    let dominant: RecomputeReason = "hit";
    let best = -1;
    for (const [r, c] of Object.entries(a.reasons)) {
      if (c > best) {
        best = c;
        dominant = r as RecomputeReason;
      }
    }
    const agg: NodeAggregate = {
      id,
      type: a.type,
      samples: a.ms.length,
      recomputes: a.recomputes,
      recomputeRate: round(a.recomputes / a.ms.length, 3),
      totalMs: round(total),
      meanMs: round(mean, 3),
      p95Ms: round(quantile(sorted, 0.95), 3),
      maxMs: round(sorted[sorted.length - 1], 3),
      msPerFrame: round(total / n, 3),
      dominantReason: dominant,
      reasons: a.reasons,
    };
    if (a.pointSamples > 0) {
      const meanPoints = a.points / a.pointSamples;
      agg.points = Math.round(meanPoints);
      // Only meaningful for work that actually ran.
      if (meanPoints > 0 && a.recomputes > 0) {
        const meanRecomputeMs = total / a.recomputes;
        agg.nsPerPoint = round((meanRecomputeMs * 1e6) / meanPoints, 1);
      }
    }
    if (a.allocs > 0) agg.allocs = a.allocs;
    if (a.gpuSamples > 0) {
      // Averaged over the samples that RESOLVED, then charged across all
      // frames — dividing the resolved total by every frame would under-report
      // a node whose results are still in flight.
      agg.gpuMsPerFrame = round(a.gpuMs / a.gpuSamples, 3);
      agg.gpuSamples = a.gpuSamples;
    }
    nodes.push(agg);
  }
  // Sort by GPU cost when we have it — on a fill-bound frame the CPU ordering
  // is actively misleading (a Merge chain is ~0.02ms of CPU and can be tens
  // of ms of GPU).
  const anyGpu = nodes.some((x) => x.gpuMsPerFrame !== undefined);
  nodes.sort((x, y) =>
    anyGpu
      ? (y.gpuMsPerFrame ?? 0) - (x.gpuMsPerFrame ?? 0) || y.totalMs - x.totalMs
      : y.totalMs - x.totalMs
  );

  // --- chain poisoning -----------------------------------------------------
  // Prefer the flattened topology the evaluator recorded: raw project edges
  // stop at every group/layer boundary, which silently shrinks each root's
  // downstream cone to near nothing.
  const recorded = prof.readTopology();
  const topology: readonly GraphEdgeLite[] =
    recorded.length > 0 ? recorded : (opts?.edges ?? []);
  const poisonRoots: PoisonRoot[] = [];
  if (topology.length > 0) {
    const adj = new Map<string, string[]>();
    for (const e of topology) {
      const list = adj.get(e.source);
      if (list) list.push(e.target);
      else adj.set(e.source, [e.target]);
    }
    const byId = new Map(nodes.map((x) => [x.id, x]));
    // A root is a node that can never cache (or whose own state forces it):
    // these are the nodes whose cost is structural rather than incidental.
    for (const node of nodes) {
      if (
        node.dominantReason !== "unstable" &&
        node.dominantReason !== "extras" &&
        node.dominantReason !== "anim"
      ) {
        continue;
      }
      // BFS downstream, counting only descendants whose recompute is
      // attributable to an input change — i.e. ones this root drags along.
      const seen = new Set<string>([node.id]);
      const queue = [...(adj.get(node.id) ?? [])];
      let downstreamMs = 0;
      let count = 0;
      while (queue.length) {
        const id = queue.shift()!;
        if (seen.has(id)) continue;
        seen.add(id);
        const d = byId.get(id);
        if (d && d.dominantReason === "input") {
          downstreamMs += d.msPerFrame;
          count++;
        }
        for (const next of adj.get(id) ?? []) queue.push(next);
      }
      if (count > 0) {
        poisonRoots.push({
          id: node.id,
          type: node.type,
          reason: node.dominantReason,
          selfMsPerFrame: node.msPerFrame,
          downstreamMsPerFrame: round(downstreamMs, 3),
          downstreamNodes: count,
        });
      }
    }
    poisonRoots.sort(
      (a, b) => b.downstreamMsPerFrame - a.downstreamMsPerFrame
    );
  }

  return {
    level: trace.meta.level,
    frames: n,
    droppedFrames: trace.meta.droppedFrames,
    truncatedFrames: trace.meta.truncatedFrames,
    fps:
      sortedGaps.length > 0
        ? {
            mean: round(1000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length), 1),
            // Slowest gaps = lowest fps, so the 5th percentile of fps is the
            // 95th percentile of gap.
            p5: round(1000 / quantile(sortedGaps, 0.95), 1),
          }
        : null,
    frameMs: {
      mean: round(totals.reduce((a, b) => a + b, 0) / n),
      p50: round(quantile(sortedTotals, 0.5)),
      p95: round(quantile(sortedTotals, 0.95)),
      max: round(sortedTotals[sortedTotals.length - 1]),
    },
    worstFrames: [...frames]
      .sort((a, b) => b.phases.total - a.phases.total)
      .slice(0, 3)
      .map((f) => ({
        seq: f.seq,
        totalMs: round(f.phases.total),
        trigger: f.trigger,
      })),
    triggers,
    phaseMsPerFrame,
    unattributedMsPerFrame: round((phaseMsPerFrame.total ?? 0) - named),
    gpu: (() => {
      let totalGpu = 0;
      let resolved = 0;
      let samples = 0;
      for (const a of acc.values()) {
        totalGpu += a.gpuMs;
        resolved += a.gpuSamples;
        samples += a.ms.length;
      }
      if (resolved === 0) return undefined;
      return {
        msPerFrame: round(totalGpu / n),
        coverage: round(resolved / samples, 3),
      };
    })(),
    fingerprintBytesPerFrame: Math.round(fpBytes / n),
    poolPerFrame: {
      allocs: round(poolA / n, 1),
      releases: round(poolR / n, 1),
      mb: round(poolBytes / n / (1024 * 1024), 2),
    },
    cache: (() => {
      let evals = 0;
      let hits = 0;
      let always = 0;
      for (const a of acc.values()) {
        evals += a.ms.length;
        hits += a.ms.length - a.recomputes;
        if (a.ms.length > 1 && a.recomputes / a.ms.length >= 0.95) always++;
      }
      return {
        hitRate: evals > 0 ? round(hits / evals, 3) : 0,
        alwaysRecomputing: always,
        totalNodes: acc.size,
      };
    })(),
    nodes: nodes.slice(0, opts?.top ?? 20),
    poisonRoots,
  };
}

/** Human-readable digest for the console. */
export function formatSummary(s: PerfSummary): string {
  if (s.frames === 0) return "perf: no frames captured (is capture armed?)";
  const L: string[] = [];
  L.push(
    `perf — ${s.frames} frames @ level ${s.level}` +
      (s.fps ? ` · ${s.fps.mean} fps mean, ${s.fps.p5} p5` : "")
  );
  L.push(
    `eval ms: mean ${s.frameMs.mean} · p50 ${s.frameMs.p50} · p95 ${s.frameMs.p95} · max ${s.frameMs.max}`
  );
  const p = s.phaseMsPerFrame;
  L.push(
    `phases/frame: flatten ${p.flatten ?? 0} · topo ${p.topo ?? 0} · fingerprint ${p.fingerprint ?? 0} · compute ${p.compute ?? 0} · post ${p.post ?? 0} · blit ${p.blit ?? 0} · unattributed ${s.unattributedMsPerFrame}`
  );
  if (s.fingerprintBytesPerFrame > 0) {
    L.push(`fingerprint chars/frame: ${s.fingerprintBytesPerFrame.toLocaleString()}`);
  }
  if (s.poolPerFrame.allocs > 0) {
    L.push(
      `textures/frame: ${s.poolPerFrame.allocs} created, ${s.poolPerFrame.releases} deleted, ${s.poolPerFrame.mb} MB`
    );
  }
  if (s.gpu) {
    L.push(
      `GPU: ${s.gpu.msPerFrame} ms/frame (${(s.gpu.coverage * 100).toFixed(0)}% of samples resolved)`
    );
  }
  L.push(
    `cache: ${(s.cache.hitRate * 100).toFixed(0)}% hit rate · ${s.cache.alwaysRecomputing}/${s.cache.totalNodes} nodes recompute every frame`
  );
  L.push(
    `triggers: ${Object.entries(s.triggers)
      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
      .map(([k, v]) => `${k} ${v}`)
      .join(" · ")}`
  );
  if (s.worstFrames.length > 0) {
    L.push(
      `worst frames: ${s.worstFrames.map((f) => `#${f.seq} ${f.totalMs}ms (${f.trigger})`).join(" · ")}`
    );
  }
  if (s.truncatedFrames > 0) {
    L.push(`WARNING: ${s.truncatedFrames} frame(s) lost their node samples to arena wrap`);
  }
  if (s.poisonRoots.length > 0) {
    L.push("", "cache-poisoning roots (uncacheable nodes dragging a chain):");
    for (const r of s.poisonRoots.slice(0, 5)) {
      L.push(
        `  ${r.type} (${r.id}) [${r.reason}] — self ${r.selfMsPerFrame}ms + ${r.downstreamMsPerFrame}ms across ${r.downstreamNodes} downstream node(s)`
      );
    }
  }
  L.push("", s.gpu ? "top nodes by GPU ms:" : "top nodes by total ms:");
  for (const nd of s.nodes.slice(0, 12)) {
    const vol =
      nd.points !== undefined
        ? ` · ${nd.points} pts${nd.nsPerPoint !== undefined ? ` @ ${nd.nsPerPoint}ns/pt` : ""}`
        : "";
    const gpu =
      nd.gpuMsPerFrame !== undefined ? `  gpu ${nd.gpuMsPerFrame.toFixed(2)}ms` : "";
    L.push(
      `  cpu ${nd.msPerFrame.toFixed(2)}ms/f${gpu}  ${(nd.recomputeRate * 100).toFixed(0)}% recompute  ${nd.dominantReason.padEnd(8)} ${nd.type} (${nd.id})${vol}`
    );
  }
  return L.join("\n");
}

/**
 * Install `window.__perf`. Called once from EffectsApp; the getter for edges
 * is supplied by the app so the poisoning report can walk the live graph.
 */
export function installPerfConsole(getEdges: () => readonly GraphEdgeLite[]): void {
  if (typeof window === "undefined") return;
  const api = {
    /** __perf.start(3) — arm capture. 2 adds volume/churn, 3 adds GPU time. */
    start(level: 1 | 2 | 3 = 2, frames = 600) {
      prof.setCaptureLevel(level, { frames });
      return `perf capture armed at level ${level} (${frames}-frame ring)`;
    },
    /** __perf.stop() — disarm and release the ring. */
    stop() {
      prof.setCaptureLevel(0);
      return "perf capture off";
    },
    /** __perf.reset() — clear samples, stay armed. */
    reset() {
      prof.resetTrace();
      return "perf trace cleared";
    },
    /** __perf.report() — print the digest. */
    report(frames?: number) {
      const s = summarize({ frames, edges: getEdges() });
      // eslint-disable-next-line no-console
      console.log(formatSummary(s));
      return s;
    },
    /** __perf.summary() — the same data as a plain object (JSON-friendly). */
    summary(frames?: number) {
      return summarize({ frames, edges: getEdges() });
    },
    /** __perf.frames() — raw per-frame samples. */
    frames(count?: number): FrameSample[] {
      return prof.readTrace({ frames: count }).frames;
    },
    /** __perf.frame(seq) — one frame's full node list. */
    frame(seq: number) {
      return prof.readFrame(seq);
    },
    /**
     * __perf.blendGpu(false) — manual A/B for Blend Intersections' GPU
     * field: false forces the CPU reference path, true (default) re-enables
     * the GPU port. No argument reads the current setting.
     */
    blendGpu(enabled?: boolean) {
      if (enabled !== undefined) setBlendFieldForceCpu(!enabled);
      return `blend-intersections GPU field ${
        getBlendFieldForceCpu() ? "OFF (CPU forced)" : "on"
      }`;
    },
  };
  (window as unknown as Record<string, unknown>).__perf = api;
}
