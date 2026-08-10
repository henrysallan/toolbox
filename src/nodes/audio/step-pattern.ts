import type { NodeDefinition, NoteEvent, NotesValue } from "@/engine/types";
import { beatsToTicks, DEFAULT_BPM } from "@/engine/audio-chain";

// Step Pattern — the deliberately-dumb v1 note source
// (specdocs/080826_audio-nodes.md, decision #4). A text pattern of hits and
// rests tiled from tick 0, converted to NoteEvents through the PROJECT
// TEMPO: one step = one musical division at Project Settings BPM, so a BPM
// change re-generates the pattern while the stored data type stays integer
// ticks. Param-panel-only UI by design — the real sequencer/piano-roll
// replaces this later; the `notes` type is the contract.
//
// Deliberately cacheable (no stable:false): the tick math reads ctx.bpm /
// ctx.ticksPerFrame / ctx.fps, which are NOT in the param+input
// fingerprint, so fingerprintExtras folds them in below — without that the
// cache would keep serving the old-tempo pattern after a BPM change.

export const audioStepPatternNode: NodeDefinition = {
  type: "audio-step-pattern",
  name: "Step Pattern",
  category: "audio",
  subcategory: "generator",
  description:
    "Text-pattern note trigger: each character is one step — `x` = hit, `X` = accented hit (velocity 1), `.` or `-` = rest, anything else is ignored (spaces are fine as separators). One step lasts the chosen division at the Project Settings BPM; the pattern tiles from the timeline start. Wire the notes output into an instrument (Synth / FM Synth / Sampler) to hear it.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [],
  params: [
    {
      name: "pattern",
      label: "Pattern",
      type: "string",
      default: "x...x...x...x...",
      placeholder: "x...x...x...x...",
    },
    {
      name: "division",
      label: "Division",
      type: "enum",
      options: ["1/4", "1/8", "1/16", "1/32"],
      default: "1/16",
    },
    {
      name: "pitch",
      label: "Pitch (MIDI)",
      type: "scalar",
      min: 0,
      max: 127,
      step: 1,
      default: 36,
    },
    {
      name: "velocity",
      label: "Velocity",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.8,
    },
    {
      name: "gate",
      label: "Gate",
      type: "scalar",
      min: 0.05,
      max: 1,
      step: 0.01,
      default: 0.5,
    },
    {
      name: "swing",
      label: "Swing",
      type: "scalar",
      min: 0,
      max: 0.75,
      step: 0.01,
      default: 0,
    },
    {
      name: "repeats",
      label: "Repeats",
      type: "scalar",
      min: 1,
      max: 256,
      softMax: 64,
      step: 1,
      default: 64,
    },
  ],
  primaryOutput: "notes",
  auxOutputs: [],

  // stepTicks depends on project tempo and timebase (ctx.bpm /
  // ctx.ticksPerFrame / ctx.fps) — external state the fingerprint can't
  // see. Folding them in here is what keeps this def cacheable: unchanged
  // params at an unchanged tempo hand back the identical NotesValue
  // (downstream instrument diffs short-circuit on identity), while a BPM
  // change in Project Settings busts the cache instead of serving a stale
  // pattern at the old tempo.
  fingerprintExtras(_params, ctx) {
    return `bpm:${ctx.bpm ?? DEFAULT_BPM}|tpf:${ctx.ticksPerFrame}|fps:${ctx.fps}`;
  },

  compute({ params, ctx }) {
    // Tokenize: x/X occupy a step and hit, '.'/'-' occupy a step and rest,
    // every other character is skipped entirely (so "x... x..." reads the
    // same as "x...x..." — separators don't shift the grid).
    type Step = "hit" | "accent" | "rest";
    const steps: Step[] = [];
    for (const ch of (params.pattern as string) ?? "") {
      if (ch === "x") steps.push("hit");
      else if (ch === "X") steps.push("accent");
      else if (ch === "." || ch === "-") steps.push("rest");
    }
    if (steps.length === 0) {
      return { primary: { kind: "notes", notes: [] } };
    }

    // One "1/16" step is 0.25 beats — beats = 4/denominator — converted to
    // ticks through the project tempo (see fingerprintExtras above).
    const division = (params.division as string) ?? "1/16";
    const denominator = Number(division.split("/")[1] ?? "16") || 16;
    const stepBeats = 4 / denominator;
    const stepTicks = Math.max(
      1,
      beatsToTicks(
        stepBeats,
        ctx.bpm ?? DEFAULT_BPM,
        ctx.ticksPerFrame,
        ctx.fps
      )
    );

    const pitch = Math.max(0, Math.min(127, (params.pitch as number) ?? 36));
    const velocity = Math.max(
      0,
      Math.min(1, (params.velocity as number) ?? 0.8)
    );
    const gate = Math.max(0.05, Math.min(1, (params.gate as number) ?? 0.5));
    const swing = Math.max(0, Math.min(0.75, (params.swing as number) ?? 0));
    const repeats = Math.max(1, Math.round((params.repeats as number) ?? 64));

    const durationTicks = Math.max(1, Math.round(gate * stepTicks));
    const notes: NoteEvent[] = [];
    for (let r = 0; r < repeats; r++) {
      for (let s = 0; s < steps.length; s++) {
        const step = steps[s];
        if (step === "rest") continue;
        // Swing delays every 2nd step by swing × step/2, on the ABSOLUTE
        // step grid from tick 0 (not the pattern-local index) so
        // odd-length patterns still swing the off-beats consistently
        // across tiles.
        const globalStep = r * steps.length + s;
        const swingOffset =
          globalStep % 2 === 1 ? (swing * stepTicks) / 2 : 0;
        notes.push({
          pitch,
          velocity: step === "accent" ? 1 : velocity,
          startTick: Math.round(globalStep * stepTicks + swingOffset),
          durationTicks,
        });
      }
    }

    const value: NotesValue = { kind: "notes", notes };
    return { primary: value };
  },
};
