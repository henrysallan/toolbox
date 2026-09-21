// check-live-param-history: the live viewer's undo / redo stack
// (lib/live-viewer/param-history.ts), the pure half.
//
// LiveViewer records every slider / gizmo write as a ParamEdit and applies
// what undo() / redo() hand back. What must hold: rapid same-key writes
// coalesce into one entry that undoes to the FIRST before-value; different
// keys (or a gap past the window, or an undo in between) start new
// entries; a coalesced gizmo drag touching several params undoes them all
// at once; two virtual ramp-stop keys landing on one stored array unwind
// to the array before either moved, however the writes interleaved; a
// write after an undo drops the redo stack; the stack caps at MAX_HISTORY.
// The ⌘Z binding and the writes onto the runtime graph are live-app
// questions (open a /live link, drag, ⌘Z).
//
//   npx tsx scripts/check-live-param-history.mts

const { createParamHistory, MAX_HISTORY, COALESCE_WINDOW_MS } = await import(
  "@/lib/live-viewer/param-history"
);
type ParamEdit = import("@/lib/live-viewer/param-history").ParamEdit;
type HistoryGroup = import("@/lib/live-viewer/param-history").HistoryGroup;

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// A fake clock so the coalesce window is deterministic.
function clock() {
  let t = 0;
  return { now: () => t, tick: (ms: number) => (t += ms) };
}

// A minimal stand-in for LiveViewer's two writes: node.params[storedKey]
// and paramValues[nodeId][valueKey]. `edit` writes and records exactly as
// onParamChange does; `apply` mirrors applyHistoryGroup.
function harness(opts: { now: () => number }) {
  const history = createParamHistory({ now: opts.now });
  const stored: Record<string, Record<string, unknown>> = {};
  const values: Record<string, Record<string, unknown>> = {};
  const edit = (
    nodeId: string,
    valueKey: string,
    storedKey: string,
    nextStored: unknown,
    nextValue: unknown,
    coalesceKey?: string
  ) => {
    stored[nodeId] ??= {};
    values[nodeId] ??= {};
    const e: ParamEdit = {
      nodeId,
      storedKey,
      prevStored: stored[nodeId][storedKey],
      nextStored,
      valueKey,
      prevValue: values[nodeId][valueKey],
      nextValue,
    };
    stored[nodeId][storedKey] = nextStored;
    values[nodeId][valueKey] = nextValue;
    history.record(e, coalesceKey);
  };
  const apply = (group: HistoryGroup | null, dir: "prev" | "next") => {
    if (!group) return false;
    for (const w of group.stored) {
      if (w[dir] === undefined) delete stored[w.nodeId][w.key];
      else stored[w.nodeId][w.key] = w[dir];
    }
    for (const w of group.values) {
      if (w[dir] === undefined) delete values[w.nodeId][w.key];
      else values[w.nodeId][w.key] = w[dir];
    }
    return true;
  };
  return {
    history,
    stored,
    values,
    edit,
    undo: () => apply(history.undo(), "prev"),
    redo: () => apply(history.redo(), "next"),
  };
}

// --- a slider drag coalesces to one step -----------------------------------
{
  const c = clock();
  const h = harness(c);
  h.stored.n1 = { radius: 10 };
  h.values.n1 = { radius: 10 };
  for (const v of [11, 12, 13, 14]) {
    c.tick(50);
    h.edit("n1", "radius", "radius", v, v, "param:n1:radius");
  }
  check("slider drag: one undo entry", h.history.canUndo() && !h.history.canRedo());
  h.undo();
  check(
    "slider drag: undo restores the FIRST before-value",
    h.stored.n1.radius === 10 && h.values.n1.radius === 10,
    JSON.stringify(h.stored.n1)
  );
  check("slider drag: nothing left to undo", !h.history.canUndo());
  h.redo();
  check(
    "slider drag: redo restores the LAST after-value",
    h.stored.n1.radius === 14 && h.values.n1.radius === 14
  );
  check("slider drag: redo stack drained", !h.history.canRedo());
}

// --- a long drag keeps coalescing while gaps stay inside the window --------
{
  const c = clock();
  const h = harness(c);
  h.stored.n1 = { radius: 0 };
  h.values.n1 = { radius: 0 };
  let steps = 0;
  // 2 s of drag at 100 ms gaps — well past the 700 ms window in total.
  for (let i = 1; i <= 20; i++) {
    c.tick(100);
    h.edit("n1", "radius", "radius", i, i, "param:n1:radius");
    steps++;
  }
  check("long drag: window refreshes per write", steps === 20);
  h.undo();
  check("long drag: one undo undoes the whole drag", h.stored.n1.radius === 0);
  check("long drag: no second entry", !h.history.canUndo());
}

// --- a gap past the window splits the entry ---------------------------------
{
  const c = clock();
  const h = harness(c);
  h.stored.n1 = { radius: 0 };
  h.values.n1 = { radius: 0 };
  h.edit("n1", "radius", "radius", 1, 1, "param:n1:radius");
  c.tick(COALESCE_WINDOW_MS + 1);
  h.edit("n1", "radius", "radius", 2, 2, "param:n1:radius");
  h.undo();
  check("gap: first undo returns to the intermediate value", h.stored.n1.radius === 1);
  h.undo();
  check("gap: second undo returns to the origin", h.stored.n1.radius === 0);
}

// --- a different key starts a new entry --------------------------------------
{
  const c = clock();
  const h = harness(c);
  h.stored.n1 = { radius: 0, softness: 0 };
  h.values.n1 = { radius: 0, softness: 0 };
  h.edit("n1", "radius", "radius", 1, 1, "param:n1:radius");
  c.tick(10);
  h.edit("n1", "softness", "softness", 5, 5, "param:n1:softness");
  h.undo();
  check(
    "different key: undo touches only the later param",
    h.stored.n1.radius === 1 && h.stored.n1.softness === 0
  );
  h.undo();
  check("different key: second undo restores the first", h.stored.n1.radius === 0);
}

// --- no coalesce key: every write is its own entry ---------------------------
{
  const c = clock();
  const h = harness(c);
  h.stored.n1 = { radius: 0 };
  h.values.n1 = { radius: 0 };
  h.edit("n1", "radius", "radius", 1, 1);
  h.edit("n1", "radius", "radius", 2, 2);
  h.undo();
  check("no key: undo steps back one write", h.stored.n1.radius === 1);
  h.undo();
  check("no key: second undo reaches the origin", h.stored.n1.radius === 0);
}

// --- an undo is a boundary: the next write does not join the undone group ---
{
  const c = clock();
  const h = harness(c);
  h.stored.n1 = { radius: 0 };
  h.values.n1 = { radius: 0 };
  h.edit("n1", "radius", "radius", 1, 1, "param:n1:radius");
  h.undo();
  c.tick(10);
  h.edit("n1", "radius", "radius", 7, 7, "param:n1:radius");
  check("undo boundary: redo stack dropped by the new write", !h.history.canRedo());
  h.undo();
  check("undo boundary: undo of the new write returns to 0, not 1", h.stored.n1.radius === 0);
  check("undo boundary: nothing else to undo", !h.history.canUndo());
}

// --- a gizmo drag writing several params undoes as one --------------------
{
  const c = clock();
  const h = harness(c);
  h.stored.t = { position: [0, 0], rotation: 0, scale: 1 };
  h.values.t = { position: [0, 0], rotation: 0, scale: 1 };
  for (let i = 1; i <= 5; i++) {
    c.tick(16);
    h.edit("t", "position", "position", [i, i], [i, i], "gizmo:t");
    h.edit("t", "rotation", "rotation", i * 10, i * 10, "gizmo:t");
  }
  h.undo();
  check(
    "gizmo drag: one undo restores position AND rotation",
    eq(h.stored.t, { position: [0, 0], rotation: 0, scale: 1 }) &&
      eq(h.values.t, { position: [0, 0], rotation: 0, scale: 1 }),
    JSON.stringify(h.stored.t)
  );
  check("gizmo drag: untouched param not in the entry", !h.history.canUndo());
  h.redo();
  check(
    "gizmo drag: redo restores the final pose",
    eq(h.stored.t, { position: [5, 5], rotation: 50, scale: 1 })
  );
}

// --- two ramp stops on one stored array, interleaved ------------------------
// Virtual keys ramp_p:ramp:a / ramp_p:ramp:b both land on `ramp`. Undo must
// return the array as it was before EITHER moved; redo must land on the
// final array, even though the writes alternate.
{
  const c = clock();
  const h = harness(c);
  const ramp0 = [
    { id: "a", position: 0.2 },
    { id: "b", position: 0.8 },
  ];
  h.stored.r = { ramp: ramp0 };
  h.values.r = {};
  const withStop = (id: string, position: number, base: typeof ramp0) =>
    base.map((s) => (s.id === id ? { ...s, position } : { ...s }));
  let cur = ramp0;
  const seq: [string, number][] = [
    ["a", 0.3],
    ["b", 0.7],
    ["a", 0.4],
    ["b", 0.6],
    ["a", 0.5],
  ];
  for (const [id, p] of seq) {
    c.tick(16);
    cur = withStop(id, p, cur);
    h.edit("r", `ramp_p:ramp:${id}`, "ramp", cur, p, "gizmo:r");
  }
  const final = cur;
  h.undo();
  check(
    "ramp stops: undo returns the array before either stop moved",
    eq(h.stored.r.ramp, ramp0),
    JSON.stringify(h.stored.r.ramp)
  );
  check(
    "ramp stops: virtual session keys removed again (never existed before)",
    !("ramp_p:ramp:a" in h.values.r) && !("ramp_p:ramp:b" in h.values.r),
    JSON.stringify(h.values.r)
  );
  h.redo();
  check(
    "ramp stops: redo lands on the FINAL array despite interleaving",
    eq(h.stored.r.ramp, final),
    JSON.stringify(h.stored.r.ramp)
  );
  check(
    "ramp stops: redo restores both virtual session values",
    h.values.r["ramp_p:ramp:a"] === 0.5 && h.values.r["ramp_p:ramp:b"] === 0.6
  );
}

// --- cap ---------------------------------------------------------------------
{
  const c = clock();
  const h = harness(c);
  h.stored.n1 = { radius: 0 };
  h.values.n1 = { radius: 0 };
  for (let i = 1; i <= MAX_HISTORY + 10; i++) {
    h.edit("n1", "radius", "radius", i, i); // no key → one entry each
  }
  let undone = 0;
  while (h.undo()) undone++;
  check(`cap: at most ${MAX_HISTORY} entries kept`, undone === MAX_HISTORY, String(undone));
  check(
    "cap: the oldest surviving entry's before-value is the dropped tail",
    h.stored.n1.radius === 10,
    String(h.stored.n1.radius)
  );
}

// --- clear -------------------------------------------------------------------
{
  const c = clock();
  const h = harness(c);
  h.stored.n1 = { radius: 0 };
  h.values.n1 = { radius: 0 };
  h.edit("n1", "radius", "radius", 1, 1);
  h.undo();
  h.edit("n1", "radius", "radius", 2, 2);
  h.history.clear();
  check(
    "clear: empties both stacks",
    !h.history.canUndo() && !h.history.canRedo() && h.history.undo() === null
  );
}

console.log(
  failures === 0
    ? "\ncheck-live-param-history: all passed"
    : `\ncheck-live-param-history: ${failures} FAILED`
);
process.exit(failures === 0 ? 0 : 1);
