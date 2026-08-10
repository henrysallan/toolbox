// Generator stage adapters (free-running sources, no note input) —
// specdocs/080826_audio-nodes.md. Keys: "generator:<gen>".
//
// osc is the canonical reference adapter: typed closures own the Tone
// objects, continuous params ramp (RAMP_SEC), discrete params set.

import type { AudioChainNode } from "./types";
import {
  type AdapterFactory,
  type StageHandles,
  type ToneModule,
  num,
  RAMP_SEC,
  str,
} from "./audio-adapter-types";

const OSC_WAVES = new Set(["sine", "square", "sawtooth", "triangle"]);
const NOISE_TYPES = new Set(["white", "pink", "brown"]);

// Fixed sample COUNT, not seconds × sampleRate: the live context and
// Tone.Offline may run at different rates, and the determinism contract
// (audio-adapter-types.ts AdapterEnv) is identical SAMPLES in both modes.
// A few percent of loop-length drift is meaningless for noise. ~2s @ 48k.
const NOISE_SAMPLES = 96_000;

// Seeded noise buffer — the whole reason this node doesn't use Tone.Noise
// (random buffers, so live and export would never match). Everything here
// is IEEE-exact double arithmetic + a 32-bit LCG, bit-reproducible across
// engines and contexts.
function makeNoiseArray(type: string, seed: number): Float32Array {
  // Fold the type into the seed so white/pink/brown at the same seed are
  // decorrelated streams, not one stream filtered three ways.
  const typeIndex = type === "pink" ? 1 : type === "brown" ? 2 : 0;
  let s = (seed * 747796405 + typeIndex * 2891336453 + 1) >>> 0;
  const next = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x80000000 - 1; // [-1, 1)
  };
  const out = new Float32Array(NOISE_SAMPLES);
  if (type === "pink") {
    // Paul Kellet's one-pole cascade — cheap, deterministic, close enough
    // to -3dB/oct for a musical pink.
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < NOISE_SAMPLES; i++) {
      const w = next();
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else if (type === "brown") {
    // Leaky integration of white (-6dB/oct). The integrator wanders, so:
    // detrend linearly to close the loop seam (last sample meets the
    // first — no 0.5Hz click on wrap), then peak-normalize so `level`
    // means the same thing regardless of seed.
    let acc = 0;
    for (let i = 0; i < NOISE_SAMPLES; i++) {
      acc = (acc + 0.02 * next()) / 1.02;
      out[i] = acc;
    }
    const end = out[NOISE_SAMPLES - 1];
    let peak = 0;
    for (let i = 0; i < NOISE_SAMPLES; i++) {
      out[i] -= (end * i) / (NOISE_SAMPLES - 1);
      peak = Math.max(peak, Math.abs(out[i]));
    }
    if (peak > 0) {
      for (let i = 0; i < NOISE_SAMPLES; i++) out[i] /= peak;
    }
  } else {
    for (let i = 0; i < NOISE_SAMPLES; i++) out[i] = next();
  }
  return out;
}

function noiseAdapter(
  T: ToneModule,
  stage: AudioChainNode
): StageHandles | null {
  if (stage.kind !== "generator") return null;
  const p = stage.params;
  let type = str(p.type, "white");
  if (!NOISE_TYPES.has(type)) type = "white";
  let seed = Math.max(0, Math.floor(num(p.seed, 0)));
  const player = new T.Player({
    url: T.ToneAudioBuffer.fromArray(makeNoiseArray(type, seed)),
    loop: true,
  }).start();
  const level = new T.Gain(num(p.level, 0.3));
  player.connect(level);
  return {
    output: level,
    inputAt: () => null,
    update(next, _u, at) {
      if (next.kind !== "generator") return;
      const q = next.params;
      level.gain.rampTo(Math.max(0, num(q.level, 0.3)), RAMP_SEC, at);
      // discrete — not schedulable, skipped during automation replay
      if (at === undefined) {
        let t = str(q.type, "white");
        if (!NOISE_TYPES.has(t)) t = "white";
        const sd = Math.max(0, Math.floor(num(q.seed, 0)));
        if (t !== type || sd !== seed) {
          type = t;
          seed = sd;
          // A looping source keeps reading the buffer it started with, so a
          // buffer swap alone is inaudible — restart to pick it up.
          player.stop();
          player.buffer = T.ToneAudioBuffer.fromArray(makeNoiseArray(type, seed));
          player.start();
        }
      }
    },
    dispose() {
      player.dispose();
      level.dispose();
    },
  };
}

function playerAdapter(
  T: ToneModule,
  stage: AudioChainNode
): StageHandles | null {
  if (stage.kind !== "generator") return null;
  const p = stage.params;
  let url = str(p.url, "");
  if (!url) return null;
  const player = new T.Player({
    url,
    loop: p.loop !== false,
    playbackRate: Math.max(0.01, num(p.rate, 1)),
    // Without an onerror a failed decode surfaces as an unhandled
    // rejection AND a silent node — undebuggable from the UI.
    onerror: (err) =>
      console.warn("[audio-player] failed to load audio file:", err),
  });
  // SYNCED to the transport (unlike the free-running noise/osc sources):
  // the transport is slaved to the scene clock, so play/pause/seek — and
  // the offline transport's start at the export window — all drive this
  // player without any per-frame nudging. `offset` skips INTO the file
  // (start(transportTime = 0, fileOffset)) — the same meaning as Audio
  // Source's identically-named param.
  let offset = Math.max(0, num(p.offset, 0));
  player.sync().start(0, offset);
  const level = new T.Gain(num(p.level, 0.8));
  player.connect(level);
  return {
    output: level,
    inputAt: () => null,
    update(next, _u, at) {
      if (next.kind !== "generator") return;
      const q = next.params;
      level.gain.rampTo(Math.max(0, num(q.level, 0.8)), RAMP_SEC, at);
      // discrete — not schedulable, skipped during automation replay
      if (at === undefined) {
        player.loop = q.loop !== false;
        player.playbackRate = Math.max(0.01, num(q.rate, 1));
        const nextUrl = str(q.url, "");
        if (nextUrl && nextUrl !== url) {
          url = nextUrl;
          void player.load(url).catch((err) => {
            console.warn("[audio-player] failed to load audio file:", err);
          });
        }
        const nextOffset = Math.max(0, num(q.offset, 0));
        if (nextOffset !== offset) {
          offset = nextOffset;
          // The start schedule lives on the transport, not the player —
          // re-sync to move it. Safe mid-play: unsync stops the source and
          // start() catches up to a running transport.
          player.unsync();
          player.sync().start(0, offset);
        }
      }
    },
    dispose() {
      player.unsync();
      player.dispose();
      level.dispose();
    },
  };
}

function oscAdapter(T: ToneModule, stage: AudioChainNode): StageHandles | null {
  if (stage.kind !== "generator") return null;
  const p = stage.params;
  const wave = str(p.wave, "sine");
  const osc = new T.Oscillator({
    frequency: num(p.freq, 220),
    detune: num(p.detune, 0),
    type: (OSC_WAVES.has(wave) ? wave : "sine") as "sine",
  }).start();
  const level = new T.Gain(num(p.level, 0.5));
  osc.connect(level);
  return {
    output: level,
    inputAt: () => null,
    update(next, _u, at) {
      if (next.kind !== "generator") return;
      const q = next.params;
      osc.frequency.rampTo(num(q.freq, 220), RAMP_SEC, at);
      osc.detune.rampTo(num(q.detune, 0), RAMP_SEC, at);
      level.gain.rampTo(Math.max(0, num(q.level, 0.5)), RAMP_SEC, at);
      // discrete — not schedulable, skipped during automation replay
      if (at === undefined) {
        const w = str(q.wave, "sine");
        if (OSC_WAVES.has(w) && osc.type !== w) osc.type = w as "sine";
      }
    },
    // Mod inputs (080926 M-C): the wire's signal SUMS with the knob value
    // inside these Signals.
    modTarget(param) {
      if (param === "freq") return osc.frequency;
      if (param === "level") return level.gain;
      return null;
    },
    dispose() {
      osc.dispose();
      level.dispose();
    },
  };
}

// Audio-rate modulator (080926 M-C). Tone.LFO's output runs min..max in
// the DESTINATION param's units — source-side attenuation, so the mod
// input needs no depth knob. Deterministic offline: phase starts where
// the `phase` param says in the fresh offline context.
const LFO_SHAPES = new Set(["sine", "square", "sawtooth", "triangle"]);

function lfoAdapter(T: ToneModule, stage: AudioChainNode): StageHandles | null {
  if (stage.kind !== "generator") return null;
  const p = stage.params;
  const shape = str(p.shape, "sine");
  const lfo = new T.LFO({
    frequency: Math.max(0.01, num(p.rate, 2)),
    min: num(p.min, -500),
    max: num(p.max, 500),
    type: (LFO_SHAPES.has(shape) ? shape : "sine") as "sine",
    phase: num(p.phase, 0),
  }).start();
  return {
    output: lfo,
    inputAt: () => null,
    update(next, _u, at) {
      if (next.kind !== "generator") return;
      const q = next.params;
      lfo.frequency.rampTo(Math.max(0.01, num(q.rate, 2)), RAMP_SEC, at);
      // discrete — not schedulable, skipped during automation replay
      if (at === undefined) {
        lfo.min = num(q.min, -500);
        lfo.max = num(q.max, 500);
        const sh = str(q.shape, "sine");
        if (LFO_SHAPES.has(sh) && lfo.type !== sh) lfo.type = sh as "sine";
        const ph = num(q.phase, 0);
        if (lfo.phase !== ph) lfo.phase = ph;
      }
    },
    dispose() {
      lfo.dispose();
    },
  };
}

export const generatorAdapters: Record<string, AdapterFactory> = {
  "generator:osc": oscAdapter,
  "generator:noise": noiseAdapter,
  "generator:player": playerAdapter,
  "generator:lfo": lfoAdapter,
};
