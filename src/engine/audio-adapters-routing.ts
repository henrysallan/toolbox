// Routing stage adapters — specdocs/080826_audio-nodes.md.
//
// Only "mix" lives here: the N-lane summing stage behind Audio Merge AND
// Crossfade (a crossfade is a 2-lane mix whose def computes equal-power
// lane gains — descriptor composition, no adapter of its own). Lane
// membership changes arrive as a rewire (the engine re-connects after
// buildLanes drops the strips); gain/pan/mute changes ramp in place.

import type { AudioChainMix, AudioChainNode } from "./types";
import {
  type AdapterFactory,
  type StageHandles,
  type ToneModule,
  RAMP_SEC,
} from "./audio-adapter-types";

type ToneGain = InstanceType<ToneModule["Gain"]>;
type TonePanner = InstanceType<ToneModule["Panner"]>;

function mixAdapter(T: ToneModule, stage: AudioChainNode): StageHandles | null {
  if (stage.kind !== "mix") return null;
  const sum = new T.Gain(1);
  let lanes: { gain: ToneGain; pan: TonePanner }[] = [];

  const buildLanes = (mix: AudioChainMix) => {
    for (const lane of lanes) {
      lane.gain.dispose();
      lane.pan.dispose();
    }
    lanes = mix.inputs.map((input) => {
      const gain = new T.Gain(input.mute ? 0 : Math.max(0, input.gain));
      const pan = new T.Panner(Math.max(-1, Math.min(1, input.pan)));
      gain.connect(pan);
      pan.connect(sum);
      return { gain, pan };
    });
  };
  buildLanes(stage);

  return {
    output: sum,
    inputAt: (i) => lanes[i]?.gain ?? null,
    update(next, u, at) {
      if (next.kind !== "mix") return;
      if (next.inputs.length !== lanes.length) {
        // Lane count changed — rebuilding the strips drops the upstream
        // connections, which is fine: a lane-count change always comes
        // with a rewire op that re-makes them.
        buildLanes(next);
        return;
      }
      if (!u.mixLanesChanged) return;
      next.inputs.forEach((input, i) => {
        lanes[i].gain.gain.rampTo(
          input.mute ? 0 : Math.max(0, input.gain),
          RAMP_SEC,
          at
        );
        lanes[i].pan.pan.rampTo(
          Math.max(-1, Math.min(1, input.pan)),
          RAMP_SEC,
          at
        );
      });
    },
    dispose() {
      for (const lane of lanes) {
        lane.gain.dispose();
        lane.pan.dispose();
      }
      sum.dispose();
    },
  };
}

export const routingAdapters: Record<string, AdapterFactory> = {
  mix: mixAdapter,
};
