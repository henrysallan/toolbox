import type { NodeDefinition, NoteEvent } from "@/engine/types";
import { beatsToTicks, DEFAULT_BPM } from "@/engine/audio-chain";

// MIDI Editor — the piano-roll note source (specdocs/080926_midi-editor.md).
//
// The notes live in the hidden `notes` param (ParamType "notes_clip",
// NoteEvent[] in absolute scene ticks) and are authored in the full
// viewport piano-roll editor, which engages on double-click / the header
// Edit button — this def is just the storage + the `notes` emitter.
//
// Like every note source, times are integer ticks and compute passes the
// stored array BY REFERENCE, so an unchanged clip is descriptor-identical
// downstream (instrument reschedule diffs stay on the fast path). The
// data is authored, not tempo-derived — a BPM change moves the GRID the
// editor draws, never the notes — so the def stays cacheable with no
// fingerprintExtras (contrast step-pattern.ts, which derives ticks from
// ctx.bpm at compute time).

function isNoteEvent(v: unknown): v is NoteEvent {
  if (!v || typeof v !== "object") return false;
  const n = v as Record<string, unknown>;
  return (
    typeof n.pitch === "number" &&
    typeof n.velocity === "number" &&
    typeof n.startTick === "number" &&
    typeof n.durationTicks === "number"
  );
}

export const midiEditorNode: NodeDefinition = {
  type: "midi-editor",
  name: "MIDI Editor",
  category: "audio",
  subcategory: "generator",
  description:
    "Author notes on a piano roll. Double-click the node (or press its Edit button) to open the editor over the viewport; wire the notes output into an instrument (Synth, FM Synth, Sampler). Notes live on the scene timeline — bars follow the project BPM.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [],
  params: [
    {
      name: "notes",
      label: "Notes",
      type: "notes_clip",
      default: [],
      // Editor-authored (the piano roll), never panel-edited.
      hidden: true,
    },
    {
      name: "default_velocity",
      label: "New-note velocity",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.8,
    },
    // Region loop (owner request 2026-08-09): notes starting inside
    // [0, loop_end_bars) repeat every loop_end_bars for `loop_repeats`
    // cycles; notes at/after the loop point go silent while looping
    // (Logic region-loop semantics). Bars are 4/4 at the project BPM.
    {
      name: "loop",
      label: "Loop",
      type: "boolean",
      default: false,
    },
    {
      name: "loop_end_bars",
      label: "Loop end (bars)",
      type: "scalar",
      min: 0.25,
      max: 256,
      softMax: 16,
      step: 0.25,
      default: 4,
      visibleIf: (p) => p.loop === true,
    },
    {
      name: "loop_repeats",
      label: "Repeats",
      type: "scalar",
      min: 1,
      max: 512,
      softMax: 64,
      step: 1,
      default: 32,
      visibleIf: (p) => p.loop === true,
    },
  ],
  primaryOutput: "notes",
  auxOutputs: [],

  compute({ params, ctx }) {
    const raw = params.notes;
    // Tolerant read: hand-edited or partial saves degrade to the valid
    // subset rather than throwing mid-eval (readGroupInterface precedent).
    const notes = Array.isArray(raw) ? (raw.filter(isNoteEvent) as NoteEvent[]) : [];
    if (notes.length === 0) return {};

    if (params.loop === true) {
      const bars = Math.max(0.25, (params.loop_end_bars as number) ?? 4);
      const loopTicks = Math.max(
        1,
        beatsToTicks(bars * 4, ctx.bpm ?? DEFAULT_BPM, ctx.ticksPerFrame, ctx.fps)
      );
      const repeats = Math.max(
        1,
        Math.min(512, Math.round((params.loop_repeats as number) ?? 32))
      );
      // Only notes STARTING inside the region loop; a note crossing the
      // loop point keeps its full duration (repetitions may overlap its
      // tail — dragged-wins is an editor concept, not an emission one).
      const region = notes.filter((n) => n.startTick < loopTicks);
      if (region.length === 0) return {};
      const tiled: NoteEvent[] = [];
      for (let k = 0; k < repeats; k++) {
        const offset = k * loopTicks;
        for (const n of region) {
          // Plain musical fields only — ids are editor identity and the
          // k copies of a note would otherwise share one.
          tiled.push({
            pitch: n.pitch,
            velocity: n.velocity,
            startTick: n.startTick + offset,
            durationTicks: n.durationTicks,
          });
        }
      }
      return { primary: { kind: "notes", notes: tiled } };
    }

    // BY REFERENCE when the whole array validated — identity fast path.
    const value =
      Array.isArray(raw) && notes.length === raw.length
        ? (raw as NoteEvent[])
        : notes;
    return { primary: { kind: "notes", notes: value } };
  },

  // Loop tick math reads ctx.bpm / ticksPerFrame / fps, which the param
  // fingerprint can't see — fold them in when looping so a tempo change
  // re-tiles instead of serving the stale grid (step-pattern precedent).
  // Loop OFF contributes nothing, keeping the plain path's cache behavior
  // identical to pre-loop saves.
  fingerprintExtras(params, ctx) {
    return params.loop === true
      ? `bpm:${ctx.bpm ?? DEFAULT_BPM}|tpf:${ctx.ticksPerFrame}|fps:${ctx.fps}`
      : "";
  },
};
