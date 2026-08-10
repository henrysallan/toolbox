// Time-based effect stage adapters (delay / reverb / chorus / phaser) —
// specdocs/080826_audio-nodes.md. Keys: "effect:<fx>".
//
// Determinism rule (spec § sharp edges): anything built from randomness —
// reverb impulse responses above all — must come from a SEEDED generator
// so offline export renders byte-identically, and must produce the same
// samples live and offline. Cache expensive derived buffers (IRs) per
// param combination at module scope.
//
// Delay registers TWO keys ("effect:delay" / "effect:delay-pingpong"): the
// node's mode enum swaps Tone classes, and a class swap must be a SHAPE
// change, so the def folds the mode into the fx key and each key gets its
// own factory over a shared handles builder.
//
// Chorus/Phaser LFOs are acceptable as-is offline: they start at phase 0
// in the offline context, which is deterministic.

import type { AudioChainNode } from "./types";
import {
  type AdapterFactory,
  type StageHandles,
  type ToneModule,
  num,
  RAMP_SEC,
} from "./audio-adapter-types";

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// --- Delay (normal / ping-pong) ---------------------------------------------

// FeedbackDelay and PingPongDelay expose the same three controls, all
// rampable (delayTime is a Param on one and a Signal on the other — both
// have rampTo), so one handles builder serves both factories.
type DelayTone =
  | InstanceType<ToneModule["FeedbackDelay"]>
  | InstanceType<ToneModule["PingPongDelay"]>;

// Delay time ceiling in seconds. Matches the node def's `time` max; also
// passed as maxDelay at construction (Tone's default maxDelay is 1s).
const DELAY_MAX_SEC = 2;

function delayHandles(delay: DelayTone): StageHandles {
  return {
    output: delay,
    inputAt: () => delay,
    update(next, _u, at) {
      if (next.kind !== "effect") return;
      const q = next.params;
      delay.delayTime.rampTo(
        clamp(num(q.time, 0.25), 0.001, DELAY_MAX_SEC),
        RAMP_SEC,
        at
      );
      delay.feedback.rampTo(clamp(num(q.feedback, 0.35), 0, 0.95), RAMP_SEC, at);
      delay.wet.rampTo(clamp(num(q.wet, 0.5), 0, 1), RAMP_SEC, at);
    },
    dispose() {
      delay.dispose();
    },
  };
}

function delayAdapter(T: ToneModule, stage: AudioChainNode): StageHandles | null {
  if (stage.kind !== "effect") return null;
  const p = stage.params;
  return delayHandles(
    new T.FeedbackDelay({
      delayTime: clamp(num(p.time, 0.25), 0.001, DELAY_MAX_SEC),
      maxDelay: DELAY_MAX_SEC,
      feedback: clamp(num(p.feedback, 0.35), 0, 0.95),
      wet: clamp(num(p.wet, 0.5), 0, 1),
    })
  );
}

function pingPongDelayAdapter(
  T: ToneModule,
  stage: AudioChainNode
): StageHandles | null {
  if (stage.kind !== "effect") return null;
  const p = stage.params;
  return delayHandles(
    new T.PingPongDelay({
      delayTime: clamp(num(p.time, 0.25), 0.001, DELAY_MAX_SEC),
      maxDelay: DELAY_MAX_SEC,
      feedback: clamp(num(p.feedback, 0.35), 0, 0.95),
      wet: clamp(num(p.wet, 0.5), 0, 1),
    })
  );
}

// --- Reverb (seeded convolution — NEVER Tone.Reverb) -------------------------

// Tone.Reverb generates its IR from unseeded noise, so two offline renders
// of the same project would differ sample-for-sample. We build the IR
// ourselves: stereo seeded-LCG noise under an exponential decay envelope,
// with pre_delay seconds of leading silence. Fixed seeds (one per channel,
// decorrelated for stereo width) make it identical every run, live and
// offline.
const IR_SEED_L = 0x9e3779b9;
const IR_SEED_R = 0x85ebca6b;

// (decay|preDelay|sampleRate) → generated IR. AudioBuffers are context-
// independent, so one cached buffer serves live and offline contexts at the
// same rate. Insertion-order-capped so a keyframed decay can't grow this
// without bound (a 20s stereo IR at 48kHz is ~7.7MB).
const irCache = new Map<string, AudioBuffer>();
const IR_CACHE_MAX = 8;

function reverbIR(T: ToneModule, decay: number, preDelay: number): AudioBuffer {
  const sampleRate = T.getContext().sampleRate;
  const key = `${decay}|${preDelay}|${sampleRate}`;
  const cached = irCache.get(key);
  if (cached) return cached;

  const preSamples = Math.round(preDelay * sampleRate);
  const decaySamples = Math.max(1, Math.round(decay * sampleRate));
  const buffer = T.getContext().createBuffer(
    2,
    preSamples + decaySamples,
    sampleRate
  );
  const seeds = [IR_SEED_L, IR_SEED_R];
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let s = seeds[ch] >>> 0;
    for (let i = 0; i < decaySamples; i++) {
      // Numerical Recipes 32-bit LCG — deterministic and cheap; noise
      // quality is irrelevant under convolution.
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const noise = (s / 0xffffffff) * 2 - 1;
      // Exponential envelope hitting -60 dB (×0.001) at t = decay.
      data[preSamples + i] =
        noise * Math.exp((-6.907755278982137 * i) / decaySamples);
    }
  }

  if (irCache.size >= IR_CACHE_MAX) {
    const oldest = irCache.keys().next().value;
    if (oldest !== undefined) irCache.delete(oldest);
  }
  irCache.set(key, buffer);
  return buffer;
}

function reverbAdapter(T: ToneModule, stage: AudioChainNode): StageHandles | null {
  if (stage.kind !== "effect") return null;
  const p = stage.params;
  let decay = clamp(num(p.decay, 2.5), 0.1, 20);
  let preDelay = clamp(num(p.pre_delay, 0.01), 0, 0.5);
  const wet0 = clamp(num(p.wet, 0.35), 0, 1);

  // Hand-built dry/wet around the convolver (Convolver has no wet knob):
  //   input ─┬─ dry gain ──────────────┬─ out
  //          └─ convolver ── wet gain ─┘
  const input = new T.Gain(1);
  const dry = new T.Gain(1 - wet0);
  const wetGain = new T.Gain(wet0);
  const out = new T.Gain(1);
  const convolver = new T.Convolver(reverbIR(T, decay, preDelay));
  input.connect(dry);
  dry.connect(out);
  input.connect(convolver);
  convolver.connect(wetGain);
  wetGain.connect(out);

  return {
    output: out,
    inputAt: () => input,
    update(next, _u, at) {
      if (next.kind !== "effect") return;
      const q = next.params;
      const wet = clamp(num(q.wet, 0.35), 0, 1);
      wetGain.gain.rampTo(wet, RAMP_SEC, at);
      dry.gain.rampTo(1 - wet, RAMP_SEC, at);
      // discrete — not schedulable, skipped during automation replay
      if (at === undefined) {
        const nextDecay = clamp(num(q.decay, 2.5), 0.1, 20);
        const nextPre = clamp(num(q.pre_delay, 0.01), 0, 0.5);
        if (nextDecay !== decay || nextPre !== preDelay) {
          decay = nextDecay;
          preDelay = nextPre;
          convolver.buffer = new T.ToneAudioBuffer(reverbIR(T, decay, preDelay));
        }
      }
    },
    dispose() {
      // Disposing the convolver drops its ToneAudioBuffer wrapper only —
      // the cached native AudioBuffer stays valid for reuse.
      input.dispose();
      dry.dispose();
      wetGain.dispose();
      out.dispose();
      convolver.dispose();
    },
  };
}

// --- Chorus -------------------------------------------------------------------

function chorusAdapter(T: ToneModule, stage: AudioChainNode): StageHandles | null {
  if (stage.kind !== "effect") return null;
  const p = stage.params;
  const chorus = new T.Chorus({
    frequency: clamp(num(p.rate, 1.5), 0.1, 10),
    depth: clamp(num(p.depth, 0.7), 0, 1),
    delayTime: clamp(num(p.delay_ms, 3.5), 2, 20),
    spread: clamp(num(p.spread, 180), 0, 180),
    wet: clamp(num(p.wet, 0.5), 0, 1),
  }).start();
  return {
    output: chorus,
    inputAt: () => chorus,
    update(next, _u, at) {
      if (next.kind !== "effect") return;
      const q = next.params;
      chorus.frequency.rampTo(clamp(num(q.rate, 1.5), 0.1, 10), RAMP_SEC, at);
      chorus.wet.rampTo(clamp(num(q.wet, 0.5), 0, 1), RAMP_SEC, at);
      // discrete — not schedulable, skipped during automation replay
      if (at === undefined) {
        const depth = clamp(num(q.depth, 0.7), 0, 1);
        if (chorus.depth !== depth) chorus.depth = depth;
        const delayMs = clamp(num(q.delay_ms, 3.5), 2, 20);
        if (chorus.delayTime !== delayMs) chorus.delayTime = delayMs;
        const spread = clamp(num(q.spread, 180), 0, 180);
        if (chorus.spread !== spread) chorus.spread = spread;
      }
    },
    dispose() {
      chorus.dispose();
    },
  };
}

// --- Phaser -------------------------------------------------------------------

function phaserAdapter(T: ToneModule, stage: AudioChainNode): StageHandles | null {
  if (stage.kind !== "effect") return null;
  const p = stage.params;
  const phaser = new T.Phaser({
    frequency: clamp(num(p.rate, 0.5), 0.1, 10),
    octaves: clamp(num(p.octaves, 3), 0, 8),
    baseFrequency: clamp(num(p.base_freq, 350), 20, 2000),
    wet: clamp(num(p.wet, 0.5), 0, 1),
  });
  return {
    output: phaser,
    inputAt: () => phaser,
    update(next, _u, at) {
      if (next.kind !== "effect") return;
      const q = next.params;
      phaser.frequency.rampTo(clamp(num(q.rate, 0.5), 0.1, 10), RAMP_SEC, at);
      phaser.wet.rampTo(clamp(num(q.wet, 0.5), 0, 1), RAMP_SEC, at);
      // discrete — not schedulable, skipped during automation replay
      if (at === undefined) {
        const octaves = clamp(num(q.octaves, 3), 0, 8);
        if (phaser.octaves !== octaves) phaser.octaves = octaves;
        const baseFreq = clamp(num(q.base_freq, 350), 20, 2000);
        if (phaser.baseFrequency !== baseFreq) phaser.baseFrequency = baseFreq;
      }
    },
    dispose() {
      phaser.dispose();
    },
  };
}

export const timeEffectAdapters: Record<string, AdapterFactory> = {
  "effect:delay": delayAdapter,
  "effect:delay-pingpong": pingPongDelayAdapter,
  "effect:reverb": reverbAdapter,
  "effect:chorus": chorusAdapter,
  "effect:phaser": phaserAdapter,
};
