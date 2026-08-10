// Keyframed-param automation for export audio (080926 M-B).
//
// A keyframed audio param (a cutoff sweep, a rising oscillator) animates
// live because each eval hands the engine a fresh descriptor. An offline
// export renders the whole window in ONE pass from a single descriptor
// snapshot — so without help, keyframes freeze at their start-of-window
// values. This module samples the keyframe blocks of every audible chain
// stage across the export window (pure data — no second render pass, no
// graph evaluation) into an AudioAutomationTimeline that
// audioEngine.renderOffline replays as scheduled ramps.
//
// Coverage is by design KEYFRAMES ONLY, and only numeric params whose def
// param name matches the descriptor param key (the convention every audio
// def follows). Not covered — documented spec limitations: wire-driven
// params (an Audio Bands → cutoff wire has no offline form of its own),
// Crossfade `fade` and Merge lane gains (their knobs land in mix-lane
// gains, not stage params), and enum/discrete params (not schedulable).

import type { Node } from "@xyflow/react";
import type { NodeDataPayload } from "@/state/graph";
import {
  evaluateKeyframesAt,
  framesToTicks,
} from "@/engine/keyframes";
import type { AudioAutomationTimeline } from "@/engine/audio-chain";
import type { AudioChainNode } from "@/engine/types";

interface WindowOpts {
  startFrame: number;
  durationFrames: number;
  // Export frame → scene seconds mapping (the export driver samples scene
  // time at exportFps intervals: timeSec = frame / exportFps).
  exportFps: number;
  // Scene seconds → ticks mapping (ticks live in PROJECT time).
  projectFps: number;
  ticksPerFrame: number;
}

// Walk a chain and yield every stage that owns a params record (mods
// included — a keyframed LFO rate automates too).
function collectStages(chain: AudioChainNode, out: Map<string, AudioChainNode>): void {
  if (out.has(chain.nodeId)) return;
  switch (chain.kind) {
    case "element":
      return;
    case "mix":
      out.set(chain.nodeId, chain);
      for (const lane of chain.inputs) collectStages(lane.chain, out);
      return;
    case "effect":
      out.set(chain.nodeId, chain);
      collectStages(chain.input, out);
      break;
    case "generator":
    case "instrument":
      out.set(chain.nodeId, chain);
      break;
  }
  for (const m of chain.mods ?? []) collectStages(m.chain, out);
}

export function buildAudioAutomationTimeline(
  chains: AudioChainNode[],
  nodes: Node<NodeDataPayload>[],
  opts: WindowOpts
): AudioAutomationTimeline | undefined {
  const stages = new Map<string, AudioChainNode>();
  for (const c of chains) collectStages(c, stages);
  if (stages.size === 0) return undefined;

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const timeline: AudioAutomationTimeline = new Map();

  for (const [nodeId, stage] of stages) {
    if (stage.kind === "element" || stage.kind === "mix") continue;
    const node = byId.get(nodeId);
    const animation = node?.data.animation;
    if (!node || !animation) continue;
    // Automatable = animated keyframe block on a param that exists as a
    // NUMBER in the descriptor's params (name convention: def param name
    // === descriptor key for every scalar audio param).
    const paramNames = Object.keys(stage.params).filter((k) => {
      const block = animation[k];
      return (
        typeof stage.params[k] === "number" &&
        block?.animated === true &&
        block.keyframes.length > 0
      );
    });
    if (paramNames.length === 0) continue;

    const frames: { timeSec: number; params: Record<string, number> }[] = [];
    for (let f = 0; f <= opts.durationFrames; f++) {
      const timeSec = (opts.startFrame + f) / opts.exportFps;
      const tick = framesToTicks(timeSec * opts.projectFps, opts.ticksPerFrame);
      const params: Record<string, number> = {};
      for (const name of paramNames) {
        const v = evaluateKeyframesAt(animation[name], "scalar", tick);
        if (typeof v === "number" && Number.isFinite(v)) params[name] = v;
      }
      if (Object.keys(params).length > 0) frames.push({ timeSec, params });
    }
    if (frames.length > 0) timeline.set(nodeId, frames);
  }

  return timeline.size > 0 ? timeline : undefined;
}
