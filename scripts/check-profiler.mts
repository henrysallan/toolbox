// check-profiler: guards the evaluator perf collector (src/engine/profiler.ts)
// and its recompute-reason classifier (classifyMiss in evaluator.ts).
// Spec: specdocs/080726_perf-profiler.md (M1).
//
// Both are pure and GL-free, so they test offline like the other check-*.mts
// gates. What matters here:
//
//   - level 0 is genuinely inert (no storage, no samples) — the profiler must
//     cost nothing when disabled
//   - the frame ring drops OLDEST, and readTrace returns newest-last
//   - arena wrap is REPORTED (meta.truncatedFrames), never silently short —
//     a frame missing its nodes must not read as "this frame was cheap"
//   - nested samples are tagged depth 1 and land in the enclosing frame
//   - reason classification prefers own-node causes over inherited ones,
//     which is what makes the chain-poisoning report trustworthy
//
//   npx tsx scripts/check-profiler.mts
/* eslint-disable @typescript-eslint/no-explicit-any */

const g = globalThis as any;
const stub = () => ({ getContext: () => null, style: {}, addEventListener() {} });
g.window ??= g;
g.self ??= g;
g.document ??= { createElement: stub, createElementNS: stub, fonts: { add() {}, forEach() {} }, body: { appendChild() {} }, addEventListener() {} };
g.navigator ??= { userAgent: "node" };
g.HTMLCanvasElement ??= class {};
g.OffscreenCanvas ??= class { getContext() { return null; } };
g.WebGL2RenderingContext ??= class {};

const prof = await import("@/engine/profiler");
const { classifyMiss } = await import("@/engine/evaluator");

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`
  );
}

// ms columns are Float32Array — 0.2 round-trips as 0.20000000298023224.
// That precision is right for a profiler; the assertion just has to know it.
function checkClose(label: string, actual: unknown, expected: number) {
  const ok = typeof actual === "number" && Math.abs(actual - expected) < 1e-6;
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ≈${expected}`}`
  );
}

// Write one complete frame containing `nodes` node samples.
function writeFrame(nodes: number, opts?: { nested?: number }) {
  prof.beginEval(false);
  prof.addPhase("flatten", 1);
  prof.addPhase("topo", 2);
  for (let i = 0; i < nodes; i++) {
    prof.recordNode(`n${i}`, `type${i % 3}`, i, i === 0 ? "params" : "input", 0, 0.1);
  }
  // Interior samples land in the SAME frame, tagged one level down.
  if (opts?.nested) {
    prof.beginEval(true);
    for (let i = 0; i < opts.nested; i++) {
      prof.recordNode(`inner${i}`, "interior", 5, "input", 1, 0);
    }
    prof.endEval(true);
  }
  prof.endEval(false, { tick: 1000, playing: true });
}

// --- level 0 is inert -------------------------------------------------------
prof.setCaptureLevel(0);
check("level 0 — beginEval reports not capturing", prof.beginEval(false), false);
prof.recordNode("x", "y", 5, "params", 0, 0);
prof.endEval(false);
check("level 0 — no frames recorded", prof.readTrace().frames.length, 0);
check("level 0 — frameCapacity is 0 (storage released)", prof.readTrace().meta.frameCapacity, 0);

// --- basic capture ----------------------------------------------------------
prof.setCaptureLevel(1, { frames: 8 });
writeFrame(3);
{
  const t = prof.readTrace();
  check("one frame captured", t.frames.length, 1);
  check("node samples materialized", t.frames[0].nodes.length, 3);
  check("phase recorded", t.frames[0].phases.flatten, 1);
  check("topo accumulates across calls", t.frames[0].phases.topo, 2);
  check("first node id", t.frames[0].nodes[0].id, "n0");
  check("first node reason", t.frames[0].nodes[0].reason, "params");
  check("second node reason", t.frames[0].nodes[1].reason, "input");
  check("level 1 omits volume", t.frames[0].nodes[0].vol, undefined);
  check("seq starts at 0", t.frames[0].seq, 0);
}

// --- blit attribution lands on the frame that just closed -------------------
prof.markBlit(4);
check("blit charged to last closed frame", prof.readTrace().frames[0].phases.blit, 4);

// --- nested samples ---------------------------------------------------------
prof.setCaptureLevel(1, { frames: 8 });
writeFrame(2, { nested: 3 });
{
  const f = prof.readTrace().frames[0];
  check("nested samples join the enclosing frame", f.nodes.length, 5);
  check("root sample depth", f.nodes[0].depth, 0);
  check("interior sample depth", f.nodes[4].depth, 1);
  const rootMs = f.nodes.filter((n) => n.depth === 0).reduce((a, b) => a + b.ms, 0);
  check("depth-0 sum excludes interiors", rootMs, 1); // ms 0 + 1
}

// --- frame ring drops oldest ------------------------------------------------
prof.setCaptureLevel(1, { frames: 4 });
for (let i = 0; i < 10; i++) writeFrame(2);
{
  const t = prof.readTrace();
  check("ring holds capacity", t.frames.length, 4);
  check("oldest retained frame is seq 6", t.frames[0].seq, 6);
  check("newest frame is last", t.frames[3].seq, 9);
  check("dropped frames counted", t.meta.droppedFrames, 6);
  check("frameCount counts all evals", prof.frameCount(), 10);
}

// --- readTrace({frames}) returns the most RECENT n --------------------------
{
  const t = prof.readTrace({ frames: 2 });
  check("limited read length", t.frames.length, 2);
  check("limited read is newest", t.frames[1].seq, 9);
  check("limited read is contiguous", t.frames[0].seq, 8);
}

// --- readFrame by seq -------------------------------------------------------
check("readFrame hits a live seq", prof.readFrame(9)?.seq, 9);
check("readFrame misses an aged-out seq", prof.readFrame(1), null);

// --- arena wrap is reported, not silently truncated -------------------------
// The arena is sized frames*64 (floor 8192). Overrun it with far more node
// samples than it can hold, then confirm the surviving frames either carry
// their full node list or are counted as truncated.
prof.setCaptureLevel(1, { frames: 64 });
{
  const cap = prof.readTrace().meta.nodeCapacity;
  const perFrame = 512;
  const frames = Math.ceil((cap * 2) / perFrame);
  for (let i = 0; i < frames; i++) writeFrame(perFrame);
  const t = prof.readTrace();
  const short = t.frames.filter((f) => f.nodes.length > 0 && f.nodes.length < perFrame);
  check("no frame silently short", short.length, 0);
  const empty = t.frames.filter((f) => f.nodes.length === 0).length;
  check("truncated frames are counted", t.meta.truncatedFrames, empty);
  check("some frames survived intact", t.frames.some((f) => f.nodes.length === perFrame), true);
}

// --- level 2 volume ---------------------------------------------------------
prof.setCaptureLevel(2, { frames: 4 });
prof.beginEval(false);
prof.nodeBegin();
prof.countAlloc(100, 100, 8);
prof.countAlloc(100, 100, 8);
prof.recordNode("p", "scatter-points", 3, "params", 0, 0.2, { points: 5000 });
prof.nodeBegin();
prof.countRelease();
prof.recordNode("s", "spline-draw", 1, "hit", 0, 0.1, { subpaths: 2, anchors: 9 });
prof.addFingerprintBytes(1234);
prof.endEval(false, { tick: 0, playing: false });
{
  const f = prof.readTrace().frames[0];
  check("volume: points", f.nodes[0].vol?.points, 5000);
  check("volume: allocs attributed per node", f.nodes[0].vol?.allocs, 2);
  check("volume: px attributed per node", f.nodes[0].vol?.px, 20000);
  check("volume: later node not charged earlier allocs", f.nodes[1].vol?.allocs, undefined);
  check("volume: subpaths", f.nodes[1].vol?.subpaths, 2);
  check("volume: anchors", f.nodes[1].vol?.anchors, 9);
  check("pool totals: allocs", f.pool.allocs, 2);
  check("pool totals: releases", f.pool.releases, 1);
  check("pool totals: bytes", f.pool.bytes, 160000);
  check("fingerprint bytes recorded at level 2", f.fingerprintBytes, 1234);
  checkClose("fpMs present at level 2", f.nodes[0].fpMs, 0.2);
}

// --- fingerprint bytes are level-2 only -------------------------------------
prof.setCaptureLevel(1, { frames: 4 });
prof.beginEval(false);
prof.addFingerprintBytes(999);
prof.recordNode("a", "b", 1, "hit", 0, 0);
prof.endEval(false);
check("level 1 skips fingerprint bytes", prof.readTrace().frames[0].fingerprintBytes, 0);

// --- a leaked open frame self-heals ----------------------------------------
prof.setCaptureLevel(1, { frames: 4 });
prof.beginEval(false);
prof.recordNode("orphan", "t", 1, "params", 0, 0);
// ...evaluateGraph throws here; endEval never runs. The next root eval must
// still open a frame rather than being mis-filed as nested forever.
prof.beginEval(false);
prof.recordNode("after", "t", 2, "params", 0, 0);
prof.endEval(false);
{
  const t = prof.readTrace();
  check("recovered after a leaked frame", t.frames.length, 1);
  check("recovered frame holds the new sample", t.frames[0].nodes[0].id, "after");
}

// --- resetTrace keeps the level, drops samples ------------------------------
prof.resetTrace();
check("resetTrace clears frames", prof.readTrace().frames.length, 0);
check("resetTrace keeps the level", prof.getCaptureLevel(), 1);
check("resetTrace keeps capacity", prof.readTrace().meta.frameCapacity, 4);

// --- GPU results resolve BACKWARDS into committed frames --------------------
// The async part of level 3: a timing lands 1-3 frames after the frame it
// belongs to, so it must be written into an already-closed frame — and must be
// dropped, not misfiled, once that frame ages out.
prof.setCaptureLevel(3, { frames: 4 });
{
  prof.beginEval(false);
  const i0 = prof.recordNode("a", "merge", 0.02, "input", 0, 0);
  const i1 = prof.recordNode("b", "bloom", 0.03, "input", 0, 0);
  prof.endEval(false);
  check("recordNode returns the in-frame index", i0, 0);
  check("indices increment", i1, 1);
  check("gpuMs absent before resolution", prof.readFrame(0)?.nodes[0].gpuMs, undefined);

  // Two frames later, the result for frame 0 arrives.
  prof.beginEval(false);
  prof.recordNode("a", "merge", 0.02, "input", 0, 0);
  prof.endEval(false);
  prof.resolveNodeGpu(0, 0, 24.5);
  check("late GPU result lands on the right frame", prof.readFrame(0)?.nodes[0].gpuMs, 24.5);
  check("and not on its neighbour", prof.readFrame(0)?.nodes[1].gpuMs, undefined);
  check("nor on a later frame", prof.readFrame(1)?.nodes[0].gpuMs, undefined);

  // Out-of-range index for a live frame — must be ignored, not written to a
  // recycled arena slot belonging to some other frame.
  prof.resolveNodeGpu(0, 99, 5);
  check("out-of-range index dropped", prof.readFrame(0)?.nodes.length, 2);

  // Age frame 0 out of the 4-frame ring, then deliver its result late.
  for (let k = 0; k < 5; k++) {
    prof.beginEval(false);
    prof.recordNode("z", "t", 1, "input", 0, 0);
    prof.endEval(false);
  }
  check("aged-out frame is gone", prof.readFrame(0), null);
  prof.resolveNodeGpu(0, 0, 99); // must not throw or corrupt a live frame
  const live = prof.readTrace().frames;
  check("late result for a dead frame is dropped", live.every((f) => f.nodes.every((nd) => nd.gpuMs === undefined)), true);
}
prof.setCaptureLevel(0);

// --- flattened topology hand-off --------------------------------------------
// Sinks attribute chain poisoning with this. It must come from the evaluator's
// POST-flatten edge list; raw project edges stop at group boundaries.
prof.setCaptureLevel(1, { frames: 4 });
{
  const edges = [
    { source: "a", target: "b" },
    { source: "b", target: "c" },
  ];
  prof.beginEval(false);
  prof.recordTopology(edges);
  prof.endEval(false);
  check("topology recorded", prof.readTopology().length, 2);
  check("topology preserves direction", prof.readTopology()[1].source, "b");

  // Same array instance ⇒ no rebuild (the per-frame cost is one identity compare).
  prof.beginEval(false);
  prof.recordTopology(edges);
  prof.endEval(false);
  check("stable topology survives a second eval", prof.readTopology().length, 2);

  // A changed graph replaces it wholesale rather than accumulating.
  prof.beginEval(false);
  prof.recordTopology([{ source: "x", target: "y" }]);
  prof.endEval(false);
  check("changed topology replaces, not appends", prof.readTopology().length, 1);
  check("changed topology content", prof.readTopology()[0].source, "x");

  // A nested pass must not clobber the root topology with its interior.
  prof.beginEval(false);
  prof.recordTopology([{ source: "x", target: "y" }]);
  prof.beginEval(true);
  prof.endEval(true);
  prof.endEval(false);
  check("root topology intact after a nested pass", prof.readTopology()[0].source, "x");
}
prof.setCaptureLevel(0);
check("topology cleared with the trace", prof.readTopology().length, 0);

// --- reason classification --------------------------------------------------
const parts = (o: Partial<Record<string, string>> = {}) => ({
  params: o.params ?? "P",
  inputs: o.inputs ?? "I",
  clip: o.clip ?? "",
  anim: o.anim ?? "",
  time: o.time ?? "",
  extras: o.extras ?? "",
});

check("no prior entry ⇒ cold", classifyMiss(undefined, parts()), "cold");
check("identical parts ⇒ other", classifyMiss(parts(), parts()), "other");
check("own params changed ⇒ params", classifyMiss(parts(), parts({ params: "P2" })), "params");
check("upstream changed ⇒ input", classifyMiss(parts(), parts({ inputs: "I2" })), "input");
check("animation advanced ⇒ anim", classifyMiss(parts(), parts({ anim: "a:1" })), "anim");
check("extras changed ⇒ extras", classifyMiss(parts(), parts({ extras: "cursor:1" })), "extras");
check("time stamp changed ⇒ unstable", classifyMiss(parts(), parts({ time: "t:1" })), "unstable");
check("clip gate changed ⇒ gated", classifyMiss(parts(), parts({ clip: "clip:gated" })), "gated");
// Precedence: when a node's own params AND its inputs changed, the actionable
// cause is its params — reporting "input" would blame an innocent upstream.
check(
  "own cause wins over inherited",
  classifyMiss(parts(), parts({ params: "P2", inputs: "I2" })),
  "params"
);
check(
  "anim wins over inherited",
  classifyMiss(parts(), parts({ anim: "a:1", inputs: "I2" })),
  "anim"
);
// Regression guard for the bug the first real trace exposed: a node whose OWN
// keyframes advanced used to push "anim:<tick>" into the input fingerprints,
// so it classified as "input" and reported itself as a victim of its
// ancestors. The tick now rides the `anim` segment. If this ever regresses,
// the chain-poisoning report silently stops finding animated roots.
check(
  "own keyframe tick advancing ⇒ anim, not input",
  classifyMiss(parts({ anim: "a:{}|anim:1000" }), parts({ anim: "a:{}|anim:2000" })),
  "anim"
);

prof.setCaptureLevel(0);

console.log(
  failures === 0
    ? "\nall profiler checks passed"
    : `\n${failures} profiler check(s) FAILED`
);
process.exit(failures === 0 ? 0 : 1);
