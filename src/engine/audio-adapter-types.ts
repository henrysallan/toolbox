// Shared contract between audio-engine.ts and the per-family stage-adapter
// modules (audio-adapters-*.ts) — specdocs/080826_audio-nodes.md M1.
//
// Types and tiny param helpers ONLY. No Tone VALUE imports anywhere in this
// file (the ToneModule type is erased at compile time) — Tone must stay out
// of every bundle that never builds an audio chain. Adapter modules receive
// the loaded module as their `T` argument.
//
// An adapter turns one AudioChainNode descriptor into live Tone objects and
// owns them completely: `create` returns closures for retune / rewire /
// schedule / dispose, and nothing outside the adapter ever touches its Tone
// objects. Keyed by `stageShapeKey()` output ("generator:osc",
// "effect:filter", "instrument:synth", "mix", "element:file", …) in the
// ADAPTERS table audio-engine.ts assembles from the family modules.

import type { AudioChainNode, RenderContext } from "./types";
import type { AudioStageUpdate } from "./audio-chain";

export type ToneModule = typeof import("tone");
export type OutputNodeT = Parameters<ToneModule["connect"]>[0];
export type InputNodeT = Parameters<ToneModule["connect"]>[1];

// Param/gain ramp time — long enough to kill zipper noise, short enough to
// feel immediate under a slider drag. Use for every continuous retune.
export const RAMP_SEC = 0.03;

export interface AdapterEnv {
  // The evaluator's RenderContext for LIVE creation (shared AudioContext /
  // element-source registry live in ctx.state). Null inside Tone.Offline.
  renderCtx: RenderContext | null;
  // True inside a Tone.Offline callback. Element leaves have no live media
  // element to capture there; seeded buffers (noise, reverb IRs) must
  // produce identical samples in both modes.
  offline: boolean;
}

// Tick→seconds conversion inputs for note scheduling (audio-chain.ts
// noteEventsToSeconds) — handed to `schedule` by the engine.
export interface AudioTimebase {
  bpm: number;
  fps: number;
  ticksPerFrame: number;
}

export interface StageHandles {
  // What downstream stages connect FROM.
  output: OutputNodeT;
  // Where upstream lane `i` connects INTO. Single-input stages ignore the
  // index; mix stages route each lane through its own gain→pan strip;
  // sources return null.
  inputAt(index: number): InputNodeT | null;
  // Retune in place after a param / mix-lane change. `u.params` lists the
  // changed keys; ramp continuous values (RAMP_SEC), set discrete ones.
  //
  // `at` (080926 M-B automation): ABSENT on live retunes (ramp from now).
  // Present inside an offline render's automation replay — the context
  // time (seconds) the change happens at; every continuous retune must
  // SCHEDULE there instead of "now" (`signal.rampTo(v, RAMP_SEC, at)`,
  // `param.setTargetAtTime(v, at, RAMP_SEC)` — both treat undefined as
  // "now", so passing `at` through unconditionally is correct). Discrete
  // params (enum swaps) cannot be scheduled and may be skipped when `at`
  // is present — keyframing an enum is not supported automation.
  update(stage: AudioChainNode, u: AudioStageUpdate, at?: number): void;
  // Instruments only: (re)build the transport-scheduled Tone.Part from
  // stage.notes. Called on play, on notes change while playing, and inside
  // offline renders. Schedule at ABSOLUTE transport seconds
  // (noteEventsToSeconds + offsetSec); the transport itself is slaved to
  // the scene clock (or started at the export window's startSec offline).
  schedule?(stage: AudioChainNode, offsetSec: number, tb: AudioTimebase): void;
  // Instruments only: silence held voices (pause / seek / teardown).
  releaseAll?(): void;
  // Instruments only: fire ONE note now, outside the transport — the
  // piano roll's audition (080926_midi-editor.md M2). Never called from
  // renders; the engine routes audibility (previewNote handles the
  // stopped-transport master gate).
  triggerNote?(pitch: number, velocity: number, durationSec: number): void;
  // Element leaves only: mute (true) / restore (false) the element's
  // default direct-to-speakers path. Driven by the engine's routed-
  // reachability pass.
  claim?(mute: boolean): void;
  // Modulation target (080926 M-C): the Tone Signal a named mod input sums
  // into. Adapters opt in per param name (the def's `<param>_mod` socket
  // and this must agree); unknown names return null and the mod edge stays
  // silently unconnected.
  modTarget?(param: string): InputNodeT | null;
  dispose(): void;
}

export type AdapterFactory = (
  T: ToneModule,
  stage: AudioChainNode,
  env: AdapterEnv
) => StageHandles | null;

export function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}

export function str(v: unknown, fb: string): string {
  return typeof v === "string" ? v : fb;
}
