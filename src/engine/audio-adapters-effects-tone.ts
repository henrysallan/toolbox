// Tone-shaping effect stage adapters (filter / EQ / dynamics / channel
// strip) — specdocs/080826_audio-nodes.md. Keys: "effect:<fx>".
//
// filter is the canonical reference adapter for single-input effects:
// input === output === the Tone effect object, continuous params ramp.

import type { AudioChainNode } from "./types";
import {
  type AdapterFactory,
  type StageHandles,
  type ToneModule,
  num,
  RAMP_SEC,
  str,
} from "./audio-adapter-types";

const FILTER_TYPES = new Set([
  "lowpass",
  "highpass",
  "bandpass",
  "notch",
  "allpass",
  "lowshelf",
  "highshelf",
  "peaking",
]);

function filterAdapter(T: ToneModule, stage: AudioChainNode): StageHandles | null {
  if (stage.kind !== "effect") return null;
  const p = stage.params;
  const type = str(p.type, "lowpass");
  const rolloffNum = num(p.rolloff, -12);
  const filter = new T.Filter({
    frequency: num(p.cutoff, 800),
    Q: num(p.q, 1),
    type: (FILTER_TYPES.has(type) ? type : "lowpass") as "lowpass",
    rolloff: (rolloffNum === -24 || rolloffNum === -48 || rolloffNum === -96
      ? rolloffNum
      : -12) as -12,
  });
  return {
    output: filter,
    inputAt: () => filter,
    update(next, _u, at) {
      if (next.kind !== "effect") return;
      const q = next.params;
      filter.frequency.rampTo(num(q.cutoff, 800), RAMP_SEC, at);
      filter.Q.rampTo(Math.max(0.0001, num(q.q, 1)), RAMP_SEC, at);
      // discrete — not schedulable, skipped during automation replay
      if (at === undefined) {
        const ty = str(q.type, "lowpass");
        if (FILTER_TYPES.has(ty) && filter.type !== ty) filter.type = ty as "lowpass";
        const ro = num(q.rolloff, -12);
        const roClamped = (ro === -24 || ro === -48 || ro === -96 ? ro : -12) as -12;
        if (filter.rolloff !== roClamped) filter.rolloff = roClamped;
      }
    },
    // Mod input (080926 M-C): sums with the cutoff knob inside the Signal.
    modTarget(param) {
      return param === "cutoff" ? filter.frequency : null;
    },
    dispose() {
      filter.dispose();
    },
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// Smoothing note for the dynamics adapters: Compressor/Limiter threshold and
// knee are Tone Params over the NATIVE DynamicsCompressorNode dB AudioParams
// (units "decibels", convert:false — the stored value IS the raw dB number,
// negative or zero). Param.rampTo on "decibels" units picks an EXPONENTIAL
// ramp, which is wrong for raw dB (a 0 target gets clamped to ~1e-7 and a
// sign crossing never ramps at all), so those retune via targetRampTo
// (setTargetAtTime + linear finish — sign-safe, converges in RAMP_SEC).
// EQ3 band gains and Channel.volume are convert:true dB Params (dB→gain
// before scheduling, always positive), so plain rampTo is correct there.

function eq3Adapter(T: ToneModule, stage: AudioChainNode): StageHandles | null {
  if (stage.kind !== "effect") return null;
  const p = stage.params;
  const eq = new T.EQ3({
    low: num(p.low, 0),
    mid: num(p.mid, 0),
    high: num(p.high, 0),
    lowFrequency: Math.max(1, num(p.low_freq, 400)),
    highFrequency: Math.max(1, num(p.high_freq, 2500)),
  });
  return {
    output: eq,
    inputAt: () => eq,
    update(next, _u, at) {
      if (next.kind !== "effect") return;
      const q = next.params;
      eq.low.rampTo(num(q.low, 0), RAMP_SEC, at);
      eq.mid.rampTo(num(q.mid, 0), RAMP_SEC, at);
      eq.high.rampTo(num(q.high, 0), RAMP_SEC, at);
      eq.lowFrequency.rampTo(Math.max(1, num(q.low_freq, 400)), RAMP_SEC, at);
      eq.highFrequency.rampTo(Math.max(1, num(q.high_freq, 2500)), RAMP_SEC, at);
    },
    dispose() {
      eq.dispose();
    },
  };
}

const OVERSAMPLE_TYPES = new Set(["none", "2x", "4x"]);

function distortionAdapter(
  T: ToneModule,
  stage: AudioChainNode
): StageHandles | null {
  if (stage.kind !== "effect") return null;
  const p = stage.params;
  const os = str(p.oversample, "2x");
  const dist = new T.Distortion({
    distortion: clamp(num(p.drive, 0.4), 0, 1),
    oversample: (OVERSAMPLE_TYPES.has(os) ? os : "2x") as "2x",
    wet: clamp(num(p.wet, 1), 0, 1),
  });
  return {
    output: dist,
    inputAt: () => dist,
    update(next, _u, at) {
      if (next.kind !== "effect") return;
      const q = next.params;
      // .distortion / .oversample are plain properties (they rebuild the
      // waveshaper curve), not Signals — direct assignment, no ramp.
      // discrete — not schedulable, skipped during automation replay
      if (at === undefined) {
        const drive = clamp(num(q.drive, 0.4), 0, 1);
        if (dist.distortion !== drive) dist.distortion = drive;
        const o = str(q.oversample, "2x");
        if (OVERSAMPLE_TYPES.has(o) && dist.oversample !== o) {
          dist.oversample = o as "2x";
        }
      }
      dist.wet.rampTo(clamp(num(q.wet, 1), 0, 1), RAMP_SEC, at);
    },
    dispose() {
      dist.dispose();
    },
  };
}

function bitcrusherAdapter(
  T: ToneModule,
  stage: AudioChainNode
): StageHandles | null {
  if (stage.kind !== "effect") return null;
  const p = stage.params;
  // Tone's BitCrusher options overload is typed as the WORKLET options (no
  // `wet` field), so construct with the bits shorthand and set wet after.
  const crusher = new T.BitCrusher(clamp(num(p.bits, 4), 1, 16));
  crusher.wet.value = clamp(num(p.wet, 1), 0, 1);
  return {
    output: crusher,
    inputAt: () => crusher,
    update(next, _u, at) {
      if (next.kind !== "effect") return;
      const q = next.params;
      crusher.bits.rampTo(clamp(num(q.bits, 4), 1, 16), RAMP_SEC, at);
      crusher.wet.rampTo(clamp(num(q.wet, 1), 0, 1), RAMP_SEC, at);
    },
    dispose() {
      crusher.dispose();
    },
  };
}

function compressorAdapter(
  T: ToneModule,
  stage: AudioChainNode
): StageHandles | null {
  if (stage.kind !== "effect") return null;
  const p = stage.params;
  // Clamps mirror the native DynamicsCompressorNode AudioParam ranges —
  // Tone's Param._assertRange THROWS outside them, and wire-driven values
  // aren't bounded by the ParamDef sliders.
  const comp = new T.Compressor({
    threshold: clamp(num(p.threshold, -24), -100, 0),
    ratio: clamp(num(p.ratio, 4), 1, 20),
    attack: clamp(num(p.attack, 0.003), 0.001, 1),
    release: clamp(num(p.release, 0.25), 0.001, 1),
    knee: clamp(num(p.knee, 30), 0, 40),
  });
  return {
    output: comp,
    inputAt: () => comp,
    update(next, _u, at) {
      if (next.kind !== "effect") return;
      const q = next.params;
      comp.threshold.targetRampTo(
        clamp(num(q.threshold, -24), -100, 0),
        RAMP_SEC,
        at
      );
      comp.knee.targetRampTo(clamp(num(q.knee, 30), 0, 40), RAMP_SEC, at);
      comp.ratio.rampTo(clamp(num(q.ratio, 4), 1, 20), RAMP_SEC, at);
      comp.attack.rampTo(clamp(num(q.attack, 0.003), 0.001, 1), RAMP_SEC, at);
      comp.release.rampTo(clamp(num(q.release, 0.25), 0.001, 1), RAMP_SEC, at);
    },
    dispose() {
      comp.dispose();
    },
  };
}

function limiterAdapter(
  T: ToneModule,
  stage: AudioChainNode
): StageHandles | null {
  if (stage.kind !== "effect") return null;
  const p = stage.params;
  const limiter = new T.Limiter(clamp(num(p.threshold, -6), -100, 0));
  return {
    output: limiter,
    inputAt: () => limiter,
    update(next, _u, at) {
      if (next.kind !== "effect") return;
      const q = next.params;
      limiter.threshold.targetRampTo(
        clamp(num(q.threshold, -6), -100, 0),
        RAMP_SEC,
        at
      );
    },
    dispose() {
      limiter.dispose();
    },
  };
}

function channelAdapter(
  T: ToneModule,
  stage: AudioChainNode
): StageHandles | null {
  if (stage.kind !== "effect") return null;
  const p = stage.params;
  const channel = new T.Channel({
    volume: num(p.gain, 0),
    pan: clamp(num(p.pan, 0), -1, 1),
    mute: p.mute === true,
    // Solo is a descriptor-build-time concept in this app (Audio Merge
    // resolves it to lane gains); never engage Tone's global solo bus.
    solo: false,
  });
  // Trailing unity gain = the gain_mod summing point (080926 M-C).
  // Channel.volume is a dB Param — summing a linear modulator into dB
  // units would be nonsense, so tremolo lives on this linear stage
  // (base 1, modulator sums deviation around it) and the knob stays dB.
  const post = new T.Gain(1);
  channel.connect(post);
  return {
    output: post,
    inputAt: () => channel,
    update(next, _u, at) {
      if (next.kind !== "effect") return;
      const q = next.params;
      channel.volume.rampTo(num(q.gain, 0), RAMP_SEC, at);
      channel.pan.rampTo(clamp(num(q.pan, 0), -1, 1), RAMP_SEC, at);
      // discrete — not schedulable, skipped during automation replay
      if (at === undefined) {
        const mute = q.mute === true;
        if (channel.mute !== mute) channel.mute = mute;
      }
    },
    modTarget(param) {
      if (param === "gain") return post.gain;
      if (param === "pan") return channel.pan;
      return null;
    },
    dispose() {
      channel.dispose();
      post.dispose();
    },
  };
}

export const toneEffectAdapters: Record<string, AdapterFactory> = {
  "effect:filter": filterAdapter,
  "effect:eq3": eq3Adapter,
  "effect:distortion": distortionAdapter,
  "effect:bitcrusher": bitcrusherAdapter,
  "effect:compressor": compressorAdapter,
  "effect:limiter": limiterAdapter,
  "effect:channel": channelAdapter,
};
