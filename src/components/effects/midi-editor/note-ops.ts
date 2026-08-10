// Pure note-clip operations for the piano roll (080926_midi-editor.md M1).
//
// The keyframe-ops/clip-ops policy, transplanted to notes: every gesture
// SNAPSHOTS the clip at pointer-down, every pointer-move REBUILDS from
// that snapshot (never from the previous move's output — trims stay
// non-destructive mid-drag), and release commits ONE onNotesChange with a
// nextGestureKey so undo coalesces per gesture.
//
// Policy, stated once:
//  - Ticks and pitches are integers; ticks clamp ≥ 0 and pitches to MIDI
//    0..127 by clamping the GESTURE DELTA, so a selection pushed against
//    an edge stops as a unit instead of piling up (keyframe-ops rule).
//  - Snap applies to the dragged ANCHOR's head (clip-ops rule: a bar-long
//    phrase lands ON the bar), and the anchor's rounded delta moves the
//    whole selection — relative spacing inside a selection never warps.
//    Shift bypasses snap per gesture (snapTicks: null).
//  - Overlaps resolve per pitch row, DRAGGED WINS: a stationary note
//    under a moved/created/resized note trims to the winner's edges and
//    drops when nothing remains. Winners never trim each other — two
//    selected notes may overlap mid-gesture and keep doing so (Logic
//    behavior); the next gesture that moves one of them resolves it.
//  - Order stability: output preserves the input array's authored order
//    (minus drops, plus appends) so React keys and note ids stay calm.
//
// No DOM, no engine imports beyond the NoteEvent type — covered by
// scripts/check-note-ops.mts in `npm run check`.

import type { NoteEvent } from "@/engine/types";

export const PITCH_MIN = 0;
export const PITCH_MAX = 127;

// Editor-side note-id mint. Monotonic per session + a random suffix so
// ids from two sessions editing the same project can't collide.
let noteIdCounter = 0;
const NOTE_ID_SALT = Math.random().toString(36).slice(2, 8);
export function mintNoteId(): string {
  noteIdCounter += 1;
  return `n${NOTE_ID_SALT}${noteIdCounter}`;
}

// Selection and gestures need stable identity; generated or pre-M1 notes
// arrive without ids. Returns the SAME array when nothing was missing so
// callers can skip a no-op param write.
export function ensureNoteIds(notes: NoteEvent[]): NoteEvent[] {
  if (notes.every((n) => typeof n.id === "string" && n.id.length > 0)) {
    return notes;
  }
  return notes.map((n) => (n.id ? n : { ...n, id: mintNoteId() }));
}

export interface NoteOpOptions {
  // Grid size in ticks; null = snap off (Shift held, or snap set to Off).
  snapTicks: number | null;
}

export function snapTick(tick: number, snapTicks: number | null): number {
  const t = Math.max(0, Math.round(tick));
  if (!snapTicks || snapTicks <= 0) return t;
  return Math.max(0, Math.round(t / snapTicks) * snapTicks);
}

const clampPitch = (p: number): number =>
  Math.max(PITCH_MIN, Math.min(PITCH_MAX, Math.round(p)));

// ---------------------------------------------------------------------------
// Overlap resolution — dragged wins, per pitch row
// ---------------------------------------------------------------------------

// Trim every non-winner against every winner sharing its (integer) pitch
// row. Cases: fully covered → drop; head under a winner → trim head to the
// winner's end; tail under a winner → trim tail to the winner's start; a
// winner strictly inside → keep the FRONT segment (no splitting in v1 —
// splitting would mint a note the user never placed).
export function resolveRowOverlaps(
  notes: NoteEvent[],
  winnerIds: ReadonlySet<string>
): NoteEvent[] {
  const winnersByRow = new Map<number, NoteEvent[]>();
  for (const n of notes) {
    if (n.id && winnerIds.has(n.id)) {
      const row = clampPitch(n.pitch);
      const list = winnersByRow.get(row);
      if (list) list.push(n);
      else winnersByRow.set(row, [n]);
    }
  }
  if (winnersByRow.size === 0) return notes;

  const out: NoteEvent[] = [];
  for (const n of notes) {
    if (n.id && winnerIds.has(n.id)) {
      out.push(n);
      continue;
    }
    const winners = winnersByRow.get(clampPitch(n.pitch));
    if (!winners) {
      out.push(n);
      continue;
    }
    let start = n.startTick;
    let end = n.startTick + n.durationTicks;
    let dropped = false;
    for (const w of winners) {
      const ws = w.startTick;
      const we = w.startTick + w.durationTicks;
      if (ws <= start && we >= end) {
        dropped = true; // fully covered
        break;
      }
      if (ws <= start && we > start) {
        start = we; // head under the winner
      } else if (ws < end && we >= end) {
        end = ws; // tail under the winner
      } else if (ws > start && we < end) {
        end = ws; // winner inside — keep the front segment
      }
      if (end - start < 1) {
        dropped = true;
        break;
      }
    }
    if (!dropped) {
      out.push(
        start === n.startTick && end === n.startTick + n.durationTicks
          ? n
          : { ...n, startTick: start, durationTicks: end - start }
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gestures (snapshot in, full next clip out)
// ---------------------------------------------------------------------------

// Move the selection by a tick/pitch delta. `anchorId` is the grabbed
// note — its head snaps to the grid and its rounded delta carries the
// whole selection.
export function moveNotes(
  originals: NoteEvent[],
  selectedIds: ReadonlySet<string>,
  anchorId: string,
  deltaTicks: number,
  deltaPitch: number,
  opts: NoteOpOptions
): NoteEvent[] {
  const selected = originals.filter((n) => n.id && selectedIds.has(n.id));
  if (selected.length === 0) return originals;
  const anchor = selected.find((n) => n.id === anchorId) ?? selected[0];

  // Gesture-delta clamps: the selection stops AS A UNIT at tick 0 and at
  // the pitch rails.
  let dt = Math.round(deltaTicks);
  const minStart = Math.min(...selected.map((n) => n.startTick));
  dt = Math.max(dt, -minStart);
  // Anchor-head snap, applied as a shared delta.
  dt = snapTick(anchor.startTick + dt, opts.snapTicks) - anchor.startTick;
  if (dt < -minStart) {
    // Snapping pushed the unit past 0 — take the next grid position up.
    dt = opts.snapTicks ? dt + opts.snapTicks : -minStart;
  }

  let dp = Math.round(deltaPitch);
  const minPitch = Math.min(...selected.map((n) => clampPitch(n.pitch)));
  const maxPitch = Math.max(...selected.map((n) => clampPitch(n.pitch)));
  dp = Math.max(PITCH_MIN - minPitch, Math.min(PITCH_MAX - maxPitch, dp));

  if (dt === 0 && dp === 0) return originals;
  const moved = originals.map((n) =>
    n.id && selectedIds.has(n.id)
      ? {
          ...n,
          startTick: n.startTick + dt,
          pitch: clampPitch(n.pitch) + dp,
        }
      : n
  );
  return resolveRowOverlaps(moved, selectedIds);
}

// Resize the selection's right edges. `targetEndTick` is where the
// anchor's end should land (already in ticks); the snapped delta applies
// to every selected note, clamped to a one-grid-step (or 1-tick) minimum.
export function resizeNotes(
  originals: NoteEvent[],
  selectedIds: ReadonlySet<string>,
  anchorId: string,
  targetEndTick: number,
  opts: NoteOpOptions
): NoteEvent[] {
  const selected = originals.filter((n) => n.id && selectedIds.has(n.id));
  if (selected.length === 0) return originals;
  const anchor = selected.find((n) => n.id === anchorId) ?? selected[0];
  const anchorEnd = anchor.startTick + anchor.durationTicks;
  const snappedEnd = snapTick(targetEndTick, opts.snapTicks);
  const dd = snappedEnd - anchorEnd;
  if (dd === 0) return originals;

  const minDur = Math.max(1, opts.snapTicks ?? 1);
  const resized = originals.map((n) =>
    n.id && selectedIds.has(n.id)
      ? { ...n, durationTicks: Math.max(minDur, n.durationTicks + dd) }
      : n
  );
  return resolveRowOverlaps(resized, selectedIds);
}

// Pencil commit: head-snapped, id-minted, dragged-wins over whatever it
// covers. Returns the id so the caller can select + audition it.
export function addNote(
  originals: NoteEvent[],
  note: { pitch: number; velocity: number; startTick: number; durationTicks: number },
  opts: NoteOpOptions
): { notes: NoteEvent[]; id: string } {
  const id = mintNoteId();
  const startTick = snapTick(note.startTick, opts.snapTicks);
  const fresh: NoteEvent = {
    id,
    pitch: clampPitch(note.pitch),
    velocity: Math.max(0, Math.min(1, note.velocity)),
    startTick,
    durationTicks: Math.max(1, Math.round(note.durationTicks)),
  };
  return {
    notes: resolveRowOverlaps([...originals, fresh], new Set([id])),
    id,
  };
}

export function deleteNotes(
  originals: NoteEvent[],
  ids: ReadonlySet<string>
): NoteEvent[] {
  const next = originals.filter((n) => !(n.id && ids.has(n.id)));
  return next.length === originals.length ? originals : next;
}

// Shift-drag copy (080926_midi-editor.md, owner addition): clone the
// selection IN PLACE with NO overlap resolution — the clones ride the
// ensuing move gesture as its selection, stacked on their originals until
// the drag carries them away. Resolution happens at the move's commit
// (dragged-wins as usual), so a copy dropped back onto its source trims
// the source — correct — while a copy dragged clear leaves it untouched.
// The caller must only commit a LATCHED drag (a bare Shift-click stays a
// selection toggle, never a silent stacked duplicate).
export function cloneNotesForDrag(
  originals: NoteEvent[],
  ids: ReadonlySet<string>
): { notes: NoteEvent[]; newIds: Set<string> } {
  const clones: NoteEvent[] = [];
  const newIds = new Set<string>();
  for (const n of originals) {
    if (!(n.id && ids.has(n.id))) continue;
    const id = mintNoteId();
    newIds.add(id);
    clones.push({ ...n, id });
  }
  if (clones.length === 0) return { notes: originals, newIds };
  return { notes: [...originals, ...clones], newIds };
}

// Clones land `offsetTicks` later (one grid step from the caller), win
// their overlaps, and come back selected via `newIds`.
export function duplicateNotes(
  originals: NoteEvent[],
  ids: ReadonlySet<string>,
  offsetTicks: number
): { notes: NoteEvent[]; newIds: Set<string> } {
  const clones: NoteEvent[] = [];
  const newIds = new Set<string>();
  for (const n of originals) {
    if (!(n.id && ids.has(n.id))) continue;
    const id = mintNoteId();
    newIds.add(id);
    clones.push({
      ...n,
      id,
      startTick: Math.max(0, n.startTick + Math.round(offsetTicks)),
    });
  }
  if (clones.length === 0) return { notes: originals, newIds };
  return {
    notes: resolveRowOverlaps([...originals, ...clones], newIds),
    newIds,
  };
}

// Alt+vertical-drag: shared additive delta, clamped per note to 0..1.
export function adjustVelocity(
  originals: NoteEvent[],
  selectedIds: ReadonlySet<string>,
  deltaVelocity: number
): NoteEvent[] {
  if (deltaVelocity === 0) return originals;
  return originals.map((n) =>
    n.id && selectedIds.has(n.id)
      ? {
          ...n,
          velocity: Math.max(0, Math.min(1, n.velocity + deltaVelocity)),
        }
      : n
  );
}
