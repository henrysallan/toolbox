// Instrument stage adapters (notes → audio, the domain crossing) —
// specdocs/080826_audio-nodes.md. Keys: "instrument:<inst>".
//
// Instruments own a Tone.Part built in `schedule` from stage.notes via
// noteEventsToSeconds (audio-chain.ts) + the AudioTimebase the engine
// passes; events sit at ABSOLUTE transport seconds (the transport is
// slaved to the scene clock live, and started at the window offset in
// offline renders — offsetSec arrives as 0 there, no local
// compensation). `releaseAll` must silence held voices — the engine
// calls it on pause and seek. Cap polyphony (maxPolyphony 32).

import type { AudioChainNode, AudioStageParams } from "./types";
import {
  midiToFreq,
  noteEventsToSeconds,
  type ScheduledNote,
} from "./audio-chain";
import {
  type AdapterFactory,
  type AudioTimebase,
  type StageHandles,
  type ToneModule,
  num,
  RAMP_SEC,
  str,
} from "./audio-adapter-types";

// Tone.Part instance typed to the [absoluteSeconds, note] tuples we feed
// it (type-only import — erased at compile time, so Tone stays lazy).
type NotePart = import("tone").Part<[number, ScheduledNote]>;

const MAX_POLYPHONY = 32;

const SYNTH_WAVES = new Set(["sine", "square", "sawtooth", "triangle"]);

// ADSR params → Tone envelope options. Defaults mirror the node defs;
// clamps keep a wire-driven value from handing Tone a zero/negative time.
function envelopeOf(p: AudioStageParams) {
  return {
    attack: Math.max(0.001, num(p.attack, 0.01)),
    decay: Math.max(0.001, num(p.decay, 0.15)),
    sustain: Math.max(0, Math.min(1, num(p.sustain, 0.5))),
    release: Math.max(0.001, num(p.release, 0.3)),
  };
}

// One Tone.Part per instrument stage, rebuilt whole on every (re)schedule
// — play pressed, notes changed while playing, or an offline render
// building its graph. `trigger` fires per event with the Part's exact
// audio time; the closure reads the instrument at trigger time, so a
// rebuilt instrument (Sampler url swap) picks up automatically.
function makeNoteScheduler(
  T: ToneModule,
  trigger: (time: number, ev: ScheduledNote) => void
) {
  let part: NotePart | null = null;
  return {
    schedule(stage: AudioChainNode, offsetSec: number, tb: AudioTimebase): void {
      if (stage.kind !== "instrument") return;
      part?.dispose();
      const events = noteEventsToSeconds(stage.notes, tb.ticksPerFrame, tb.fps);
      part = new T.Part<[number, ScheduledNote]>(
        trigger,
        events.map((ev): [number, ScheduledNote] => [ev.timeSec + offsetSec, ev])
      );
      part.start(0);
    },
    dispose(): void {
      part?.dispose();
      part = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Synth — PolySynth over Tone.Synth (osc type + ADSR)
// ---------------------------------------------------------------------------

function synthAdapter(T: ToneModule, stage: AudioChainNode): StageHandles | null {
  if (stage.kind !== "instrument") return null;
  const p = stage.params;
  const wave = str(p.wave, "sawtooth");
  const synth = new T.PolySynth({
    voice: T.Synth,
    maxPolyphony: MAX_POLYPHONY,
    options: {
      oscillator: {
        type: (SYNTH_WAVES.has(wave) ? wave : "sawtooth") as "sawtooth",
      },
      envelope: envelopeOf(p),
    },
  });
  const level = new T.Gain(Math.max(0, num(p.level, 0.7)));
  synth.connect(level);
  const scheduler = makeNoteScheduler(T, (time, ev) => {
    synth.triggerAttackRelease(
      midiToFreq(ev.pitch),
      ev.durationSec,
      time,
      ev.velocity
    );
  });
  return {
    output: level,
    inputAt: () => null,
    update(next, _u, at) {
      if (next.kind !== "instrument") return;
      const q = next.params;
      // discrete — not schedulable, skipped during automation replay
      if (at === undefined) {
        const w = str(q.wave, "sawtooth");
        synth.set({
          oscillator: {
            type: (SYNTH_WAVES.has(w) ? w : "sawtooth") as "sawtooth",
          },
          envelope: envelopeOf(q),
        });
      }
      level.gain.rampTo(Math.max(0, num(q.level, 0.7)), RAMP_SEC, at);
    },
    schedule: scheduler.schedule,
    releaseAll() {
      synth.releaseAll?.();
    },
    // One-shot audition, outside the transport (piano-roll preview).
    triggerNote(pitch, velocity, durationSec) {
      synth.triggerAttackRelease(
        midiToFreq(pitch),
        Math.max(0.02, durationSec),
        undefined,
        Math.max(0, Math.min(1, velocity))
      );
    },
    dispose() {
      scheduler.dispose();
      synth.dispose();
      level.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// FM Synth — PolySynth over Tone.FMSynth (harmonicity + mod index + ADSR)
// ---------------------------------------------------------------------------

function fmAdapter(T: ToneModule, stage: AudioChainNode): StageHandles | null {
  if (stage.kind !== "instrument") return null;
  const p = stage.params;
  const synth = new T.PolySynth<InstanceType<ToneModule["FMSynth"]>>({
    voice: T.FMSynth,
    maxPolyphony: MAX_POLYPHONY,
    options: {
      harmonicity: Math.max(0.01, num(p.harmonicity, 3)),
      modulationIndex: Math.max(0, num(p.mod_index, 10)),
      envelope: envelopeOf(p),
    },
  });
  const level = new T.Gain(Math.max(0, num(p.level, 0.7)));
  synth.connect(level);
  const scheduler = makeNoteScheduler(T, (time, ev) => {
    synth.triggerAttackRelease(
      midiToFreq(ev.pitch),
      ev.durationSec,
      time,
      ev.velocity
    );
  });
  return {
    output: level,
    inputAt: () => null,
    update(next, _u, at) {
      if (next.kind !== "instrument") return;
      const q = next.params;
      // discrete — not schedulable, skipped during automation replay
      if (at === undefined) {
        synth.set({
          harmonicity: Math.max(0.01, num(q.harmonicity, 3)),
          modulationIndex: Math.max(0, num(q.mod_index, 10)),
          envelope: envelopeOf(q),
        });
      }
      level.gain.rampTo(Math.max(0, num(q.level, 0.7)), RAMP_SEC, at);
    },
    schedule: scheduler.schedule,
    releaseAll() {
      synth.releaseAll?.();
    },
    // One-shot audition, outside the transport (piano-roll preview).
    triggerNote(pitch, velocity, durationSec) {
      synth.triggerAttackRelease(
        midiToFreq(pitch),
        Math.max(0.02, durationSec),
        undefined,
        Math.max(0, Math.min(1, velocity))
      );
    },
    dispose() {
      scheduler.dispose();
      synth.dispose();
      level.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Sampler — Tone.Sampler repitching one file from its MIDI root
// ---------------------------------------------------------------------------

function samplerAdapter(
  T: ToneModule,
  stage: AudioChainNode
): StageHandles | null {
  if (stage.kind !== "instrument") return null;
  const p = stage.params;
  const level = new T.Gain(Math.max(0, num(p.level, 0.8)));

  // The level Gain is the permanent `output` anchor: url / root_pitch
  // changes swap the internal Tone.Sampler (buffers are load-time state,
  // not a rampable param) and reconnect the new one here, so connections
  // the engine made downstream survive the rebuild.
  const build = (params: AudioStageParams) => {
    const s = new T.Sampler({
      urls: {
        [T.Frequency(num(params.root_pitch, 60), "midi").toNote()]: str(
          params.url,
          ""
        ),
      },
      release: Math.max(0.001, num(params.release, 0.5)),
    });
    s.connect(level);
    return s;
  };
  let sampler = build(p);
  let url = str(p.url, "");
  let rootPitch = num(p.root_pitch, 60);

  const scheduler = makeNoteScheduler(T, (time, ev) => {
    // Buffers fetch/decode async — a trigger before the load settles
    // would throw inside the Part callback. Offline renders never hit
    // this branch: the engine awaits T.loaded() before rolling.
    if (!sampler.loaded) return;
    sampler.triggerAttackRelease(
      T.Frequency(ev.pitch, "midi").toNote(),
      ev.durationSec,
      time,
      ev.velocity
    );
  });

  return {
    output: level,
    inputAt: () => null,
    update(next, _u, at) {
      if (next.kind !== "instrument") return;
      const q = next.params;
      // discrete — not schedulable, skipped during automation replay
      if (at === undefined) {
        const nextUrl = str(q.url, "");
        const nextRoot = num(q.root_pitch, 60);
        if (nextUrl !== url || nextRoot !== rootPitch) {
          sampler.releaseAll?.();
          sampler.dispose();
          sampler = build(q);
          url = nextUrl;
          rootPitch = nextRoot;
        } else {
          sampler.release = Math.max(0.001, num(q.release, 0.5));
        }
      }
      level.gain.rampTo(Math.max(0, num(q.level, 0.8)), RAMP_SEC, at);
    },
    schedule: scheduler.schedule,
    releaseAll() {
      sampler.releaseAll?.();
    },
    // One-shot audition. Same buffer-readiness guard as the Part trigger:
    // a preview before the sample decodes must not throw.
    triggerNote(pitch, velocity, durationSec) {
      if (!sampler.loaded) return;
      sampler.triggerAttackRelease(
        T.Frequency(pitch, "midi").toNote(),
        Math.max(0.02, durationSec),
        undefined,
        Math.max(0, Math.min(1, velocity))
      );
    },
    dispose() {
      scheduler.dispose();
      sampler.dispose();
      level.dispose();
    },
  };
}

export const instrumentAdapters: Record<string, AdapterFactory> = {
  "instrument:synth": synthAdapter,
  "instrument:fm": fmAdapter,
  "instrument:sampler": samplerAdapter,
};
