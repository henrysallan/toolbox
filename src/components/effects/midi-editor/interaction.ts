// Pure interaction helpers for the piano roll's M1 editing grammar
// (080926_midi-editor.md § Interactions). Everything that MUTATES the
// clip lives in note-ops.ts (frozen policy, covered by
// scripts/check-note-ops.mts) — this module owns only the snap-division
// table and the editor's internal copy/paste clipboard, so
// MidiEditor.tsx stays event wiring + state.

import type { NoteEvent } from "@/engine/types";
import { beatsToTicks } from "@/engine/audio-chain";
import { mintNoteId, resolveRowOverlaps } from "./note-ops";

// ---------------------------------------------------------------------------
// Snap divisions
// ---------------------------------------------------------------------------

// Fixed 4/4 in v1 (owner decision 2), so Bar = 4 beats and Bar ≡ 1/1.
// Both stay listed anyway — they stop agreeing the moment time
// signatures land, and users expect to find both in the menu (Logic).
export const SNAP_OPTIONS = [
  "Bar",
  "1/1",
  "1/2",
  "1/4",
  "1/8",
  "1/16",
  "1/32",
  "Off",
] as const;
export type SnapOption = (typeof SNAP_OPTIONS)[number];
export const DEFAULT_SNAP: SnapOption = "1/16";

const SNAP_BEATS: Record<SnapOption, number | null> = {
  Bar: 4,
  "1/1": 4,
  "1/2": 2,
  "1/4": 1,
  "1/8": 0.5,
  "1/16": 0.25,
  "1/32": 0.125,
  Off: null,
};

/**
 * Grid size in ticks for a snap option; null = snap off. Clamped ≥ 1 so
 * an extreme bpm/fps combination can't round to a 0-tick grid (which
 * note-ops' snapTick would read as "off").
 */
export function snapTicksFor(
  option: SnapOption,
  bpm: number,
  ticksPerFrame: number,
  fps: number
): number | null {
  const beats = SNAP_BEATS[option];
  if (beats == null) return null;
  return Math.max(1, beatsToTicks(beats, bpm, ticksPerFrame, fps));
}

// ---------------------------------------------------------------------------
// Internal clipboard
// ---------------------------------------------------------------------------

// Module-level so it survives closing and reopening the editor within a
// session (cross-node paste is deliberately deferred, per the spec —
// note ticks are absolute scene time, so shapes stay meaningful). Plain
// musical shapes, no ids: paste mints fresh ones.

export interface NoteShape {
  pitch: number;
  velocity: number;
  startTick: number;
  durationTicks: number;
}

let clipboard: NoteShape[] = [];

/**
 * Copy the selected notes' shapes. Returns how many were copied; an
 * empty selection copies nothing and leaves the clipboard untouched.
 */
export function copyNotesToClipboard(
  notes: NoteEvent[],
  ids: ReadonlySet<string>
): number {
  const picked: NoteShape[] = [];
  for (const n of notes) {
    if (!(n.id && ids.has(n.id))) continue;
    picked.push({
      pitch: n.pitch,
      velocity: n.velocity,
      startTick: n.startTick,
      durationTicks: n.durationTicks,
    });
  }
  if (picked.length > 0) clipboard = picked;
  return picked.length;
}

/**
 * Paste-in-place: clones land at their ORIGINAL ticks (no playhead
 * math — the user drags them where they want), win their overlaps
 * (dragged-wins, via note-ops' resolveRowOverlaps), and come back in
 * `newIds` so the caller selects them. Null when the clipboard is empty.
 */
export function pasteNotesFromClipboard(
  originals: NoteEvent[]
): { notes: NoteEvent[]; newIds: Set<string> } | null {
  if (clipboard.length === 0) return null;
  const newIds = new Set<string>();
  const clones: NoteEvent[] = clipboard.map((s) => {
    const id = mintNoteId();
    newIds.add(id);
    return { ...s, id };
  });
  return {
    notes: resolveRowOverlaps([...originals, ...clones], newIds),
    newIds,
  };
}
