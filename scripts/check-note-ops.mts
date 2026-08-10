// check-note-ops: guards the piano roll's pure gesture policy
// (src/components/effects/midi-editor/note-ops.ts — 080926_midi-editor.md
// M1). The interaction layer commits exactly what these functions return,
// so the drag policy — anchor-head snap with shared delta, gesture-delta
// clamping at tick 0 and the pitch rails, dragged-wins per-row overlap
// trims, order stability — lives or dies here.
//
//   npx tsx scripts/check-note-ops.mts

import type { NoteEvent } from "../src/engine/types";
import {
  addNote,
  adjustVelocity,
  cloneNotesForDrag,
  deleteNotes,
  duplicateNotes,
  ensureNoteIds,
  mintNoteId,
  moveNotes,
  resizeNotes,
  resolveRowOverlaps,
  snapTick,
} from "../src/components/effects/midi-editor/note-ops";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const note = (
  id: string,
  pitch: number,
  startTick: number,
  durationTicks: number,
  velocity = 0.8
): NoteEvent => ({ id, pitch, velocity, startTick, durationTicks });

const ids = (...list: string[]) => new Set(list);
const byId = (notes: NoteEvent[], id: string) => notes.find((n) => n.id === id);

const GRID = 1000; // one grid step, in ticks
const opts = { snapTicks: GRID };
const noSnap = { snapTicks: null };

// --- ids & snap --------------------------------------------------------------

{
  const a = mintNoteId();
  const b = mintNoteId();
  check("ids: mint is unique", a !== b && a.length > 0);
  const withIds = [note("x", 60, 0, 10)];
  check("ids: ensureNoteIds no-ops when complete", ensureNoteIds(withIds) === withIds);
  const bare = [{ pitch: 60, velocity: 1, startTick: 0, durationTicks: 10 }] as NoteEvent[];
  const fixed = ensureNoteIds(bare);
  check("ids: ensureNoteIds mints missing", fixed !== bare && !!fixed[0].id);
  check("snap: rounds to grid", snapTick(1499, GRID) === 1000 && snapTick(1501, GRID) === 2000);
  check("snap: off rounds to int and clamps 0", snapTick(-5.4, null) === 0 && snapTick(7.6, null) === 8);
}

// --- move -------------------------------------------------------------------

{
  // Anchor-head snap carries the whole selection: anchor at 100 dragged
  // +850 → snapped head 1000 → shared delta +900 lands the second note
  // off-grid by the same relative offset it started with.
  const start = [note("a", 60, 100, 500), note("b", 62, 350, 500)];
  const out = moveNotes(start, ids("a", "b"), "a", 850, 0, opts);
  check(
    "move: anchor snaps, delta shared, spacing preserved",
    byId(out, "a")!.startTick === 1000 && byId(out, "b")!.startTick === 1250
  );
}

{
  // Gesture-delta clamp at tick 0: selection stops as a unit.
  const start = [note("a", 60, 200, 100), note("b", 60, 700, 100)];
  const out = moveNotes(start, ids("a", "b"), "a", -5000, 0, noSnap);
  check(
    "move: unit clamp at tick 0",
    byId(out, "a")!.startTick === 0 && byId(out, "b")!.startTick === 500
  );
}

{
  // Pitch rail clamp is also a unit clamp.
  const start = [note("a", 1, 0, 100), note("b", 10, 0, 100)];
  const out = moveNotes(start, ids("a", "b"), "a", 0, -8, noSnap);
  check(
    "move: unit clamp at pitch floor",
    byId(out, "a")!.pitch === 0 && byId(out, "b")!.pitch === 9
  );
  const up = moveNotes(start, ids("a", "b"), "a", 0, 200, noSnap);
  check(
    "move: unit clamp at pitch ceiling",
    byId(up, "b")!.pitch === 127 && byId(up, "a")!.pitch === 118
  );
}

{
  // Dragged wins: moved note covers a stationary one → drop; clips
  // another's head → trim.
  const start = [
    note("mv", 60, 0, 1000),
    note("covered", 60, 2100, 300),
    note("clipped", 60, 2800, 1000),
    note("otherRow", 61, 2100, 300),
  ];
  const out = moveNotes(start, ids("mv"), "mv", 2000, 0, opts);
  check("move: fully covered stationary drops", byId(out, "covered") === undefined);
  const clipped = byId(out, "clipped")!;
  check(
    "move: overlapped head trims to winner end",
    clipped.startTick === 3000 && clipped.durationTicks === 800
  );
  check("move: other rows untouched", byId(out, "otherRow")!.durationTicks === 300);
  check(
    "move: order stability",
    out.map((n) => n.id).join(",") === "mv,clipped,otherRow"
  );
}

{
  // Winners never trim each other, and a zero-delta move returns the
  // ORIGINAL array (identity fast path).
  const start = [note("a", 60, 0, 1000), note("b", 60, 400, 1000)];
  const out = moveNotes(start, ids("a", "b"), "a", 120, 0, opts);
  check(
    "move: winners coexist (no mutual trim)",
    out.length === 2 && byId(out, "b")!.durationTicks === 1000
  );
  check("move: zero-delta returns input", moveNotes(start, ids("a"), "a", 10, 0, opts) === start);
}

// --- resize -----------------------------------------------------------------

{
  const start = [note("a", 60, 1000, 1000), note("b", 62, 0, 500)];
  const out = resizeNotes(start, ids("a", "b"), "a", 3400, opts);
  check(
    "resize: anchor end snaps, delta shared",
    byId(out, "a")!.durationTicks === 2000 && byId(out, "b")!.durationTicks === 1500
  );
  const shrunk = resizeNotes(start, ids("a"), "a", 900, opts);
  check("resize: min one grid step", byId(shrunk, "a")!.durationTicks === GRID);
  const tail = [note("w", 60, 0, 1000), note("s", 60, 1500, 1000)];
  const grown = resizeNotes(tail, ids("w"), "w", 2200, noSnap);
  const s = byId(grown, "s")!;
  check(
    "resize: grown winner trims downstream head",
    s.startTick === 2200 && s.durationTicks === 300
  );
}

// --- add (pencil) -------------------------------------------------------------

{
  const start = [note("s", 60, 900, 2000)];
  const { notes: out, id } = addNote(
    start,
    { pitch: 60.4, velocity: 1.7, startTick: 1400, durationTicks: 990.6 },
    opts
  );
  const added = byId(out, id)!;
  check(
    "add: head snaps, pitch/velocity clamp, duration rounds",
    added.startTick === 1000 && added.pitch === 60 && added.velocity === 1 && added.durationTicks === 991
  );
  // The new note lands strictly inside `s` — per the no-split rule the
  // stationary note keeps its FRONT segment, trimmed at the winner's head.
  const trimmedS = byId(out, "s")!;
  check(
    "add: new note wins — stationary keeps front, trimmed at winner head",
    trimmedS.startTick === 900 && trimmedS.durationTicks === 100
  );
}

// --- overlap edge: winner strictly inside keeps the front segment ------------

{
  const out = resolveRowOverlaps(
    [note("s", 60, 0, 4000), note("w", 60, 1000, 1000)],
    ids("w")
  );
  const s = byId(out, "s")!;
  check(
    "overlap: winner inside → stationary keeps front (no split)",
    s.startTick === 0 && s.durationTicks === 1000
  );
}

// --- delete / duplicate / velocity -------------------------------------------

{
  const start = [note("a", 60, 0, 100), note("b", 61, 0, 100)];
  check("delete: removes by id", deleteNotes(start, ids("a")).length === 1);
  check("delete: no-op returns input", deleteNotes(start, ids("zz")) === start);

  const { notes: dup, newIds } = duplicateNotes(start, ids("a"), GRID);
  check(
    "duplicate: clone offset one grid step, new id, selected set returned",
    dup.length === 3 &&
      newIds.size === 1 &&
      dup[2].startTick === GRID &&
      dup[2].id !== "a" &&
      newIds.has(dup[2].id!)
  );

  const vel = adjustVelocity(start, ids("a", "b"), 0.5);
  check(
    "velocity: shared delta, clamped 0..1",
    byId(vel, "a")!.velocity === 1 && byId(vel, "b")!.velocity === 1
  );
  check("velocity: zero delta returns input", adjustVelocity(start, ids("a"), 0) === start);
}

// --- shift-drag copy ----------------------------------------------------------

{
  const start = [note("a", 60, 1000, 500), note("b", 64, 2000, 500)];
  const { notes: withClones, newIds } = cloneNotesForDrag(start, ids("a", "b"));
  check(
    "copy-drag: clones stack in place, UNRESOLVED, originals intact",
    withClones.length === 4 &&
      newIds.size === 2 &&
      byId(withClones, "a")!.durationTicks === 500 &&
      withClones.filter((n) => n.pitch === 60).length === 2
  );
  const cloneId = [...newIds].find(
    (id) => byId(withClones, id)!.pitch === 60
  )!;
  // Dragging the clones away resolves cleanly: originals untouched,
  // clones landed shifted.
  const dragged = moveNotes(withClones, newIds, cloneId, 3000, 0, opts);
  check(
    "copy-drag: dragged clear — originals survive, clones moved",
    byId(dragged, "a")!.startTick === 1000 &&
      byId(dragged, cloneId)!.startTick === 4000 &&
      dragged.length === 4
  );
  // Dropping the clones 40 ticks later: dragged-wins trims the original
  // to the uncovered lead-in sliver (drop only happens on full coverage).
  const dropped = moveNotes(withClones, newIds, cloneId, 40, 0, noSnap);
  check(
    "copy-drag: dropped nearly in place — original trims to the lead-in",
    byId(dropped, "a")!.durationTicks === 40 &&
      byId(dropped, cloneId)!.startTick === 1040
  );
}

console.log(
  failures === 0 ? "\ncheck-note-ops: all passed" : `\ncheck-note-ops: ${failures} FAILED`
);
process.exit(failures === 0 ? 0 : 1);
