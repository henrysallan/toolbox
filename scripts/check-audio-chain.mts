// check-audio-chain: guards the PURE half of the audio chain engine
// (specdocs/080826_audio-nodes.md) — engine/audio-chain.ts. The live
// reconciler (audio-engine.ts) executes exactly the ops this module
// produces, so plan/diff correctness here is what keeps the Tone graph
// from leaking stages, missing retunes, or rebuilding on every frame.
//
// Covers: post-order (topo) plan building, shared-subtree dedup, the
// identity short-circuit (cache-hit descriptors must produce an EMPTY
// diff), param retunes, shape-change dispose+create, rewires on input
// changes and upstream recreation, sink routing changes, mix-lane and
// notes-change detection, sink reachability (element claim policy), and
// the tick→seconds/beat→tick musical-time conversions.
//
//   npx tsx scripts/check-audio-chain.mts

import type {
  AudioChainEffect,
  AudioChainGenerator,
  AudioChainInstrument,
  AudioChainMix,
  AudioChainNode,
  NoteEvent,
} from "../src/engine/types";
import {
  audioTickToSeconds,
  beatsToTicks,
  buildAudioGraphPlan,
  chainSignature,
  diffAudioGraphPlans,
  diffIsEmpty,
  midiToFreq,
  noteEventsToSeconds,
  sinkReachableIds,
  stageShapeKey,
} from "../src/engine/audio-chain";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const osc = (id: string, freq = 220): AudioChainGenerator => ({
  kind: "generator",
  nodeId: id,
  gen: "osc",
  params: { wave: "sine", freq, detune: 0, level: 0.5 },
});

const filter = (
  id: string,
  input: AudioChainNode,
  cutoff = 800
): AudioChainEffect => ({
  kind: "effect",
  nodeId: id,
  fx: "filter",
  params: { type: "lowpass", cutoff, q: 1, rolloff: -12 },
  input,
});

const mix = (
  id: string,
  inputs: { chain: AudioChainNode; gain?: number; pan?: number; mute?: boolean }[]
): AudioChainMix => ({
  kind: "mix",
  nodeId: id,
  params: {},
  inputs: inputs.map((i) => ({
    chain: i.chain,
    gain: i.gain ?? 1,
    pan: i.pan ?? 0,
    mute: i.mute ?? false,
  })),
});

const inst = (id: string, notes: NoteEvent[]): AudioChainInstrument => ({
  kind: "instrument",
  nodeId: id,
  inst: "synth",
  params: { attack: 0.01 },
  notes,
});

// --- plan building ---------------------------------------------------------

{
  const chain = filter("f1", osc("o1"));
  const plan = buildAudioGraphPlan([{ chain, routed: true }]);
  check("plan: two stages", plan.stages.size === 2);
  check(
    "plan: topo order (child before parent)",
    [...plan.stages.keys()].join(",") === "o1,f1"
  );
  check("plan: sink is routed root", plan.sinks.join(",") === "f1");
  check(
    "plan: effect inputIds",
    plan.stages.get("f1")!.inputIds.join(",") === "o1"
  );
}

{
  // One oscillator fanned into two filters, both mixed — shared subtree
  // appears ONCE, keyed by nodeId.
  const shared = osc("o1");
  const m = mix("m1", [
    { chain: filter("f1", shared) },
    { chain: filter("f2", shared) },
  ]);
  const plan = buildAudioGraphPlan([{ chain: m, routed: true }]);
  check("plan: shared subtree dedup", plan.stages.size === 4);
  check(
    "plan: mix inputIds in lane order",
    plan.stages.get("m1")!.inputIds.join(",") === "f1,f2"
  );
}

{
  // Two roots — an unrouted analysis branch over the same stages plus a
  // routed sink — merge into one plan with one sink.
  const o = osc("o1");
  const f = filter("f1", o);
  const plan = buildAudioGraphPlan([
    { chain: o, routed: false },
    { chain: f, routed: true },
  ]);
  check("plan: multi-root merge", plan.stages.size === 2);
  check("plan: only routed root is a sink", plan.sinks.join(",") === "f1");
}

// --- diffing ---------------------------------------------------------------

{
  // Identity short-circuit: SAME descriptor objects (cache hit) → empty diff.
  const chain = filter("f1", osc("o1"));
  const a = buildAudioGraphPlan([{ chain, routed: true }]);
  const b = buildAudioGraphPlan([{ chain, routed: true }]);
  check("diff: identical objects → empty", diffIsEmpty(diffAudioGraphPlans(a, b)));
}

{
  // Structurally equal but fresh objects (stable:false upstream defeated
  // the cache) → still empty: field-level compare catches equality.
  const a = buildAudioGraphPlan([{ chain: filter("f1", osc("o1")), routed: true }]);
  const b = buildAudioGraphPlan([{ chain: filter("f1", osc("o1")), routed: true }]);
  check("diff: equal fresh objects → empty", diffIsEmpty(diffAudioGraphPlans(a, b)));
}

{
  // Param change → one update with the changed key, no create/dispose.
  const a = buildAudioGraphPlan([{ chain: filter("f1", osc("o1"), 800), routed: true }]);
  const b = buildAudioGraphPlan([{ chain: filter("f1", osc("o1"), 2000), routed: true }]);
  const d = diffAudioGraphPlans(a, b);
  check(
    "diff: param retune",
    d.create.length === 0 &&
      d.dispose.length === 0 &&
      d.update.length === 1 &&
      d.update[0].nodeId === "f1" &&
      d.update[0].params.join(",") === "cutoff"
  );
}

{
  // Shape change (filter became a different fx) → dispose + create + rewire
  // of the stage AND of its consumer.
  const a = buildAudioGraphPlan([{ chain: filter("f1", osc("o1")), routed: true }]);
  const delay: AudioChainEffect = {
    kind: "effect",
    nodeId: "f1",
    fx: "delay",
    params: { time: 0.25 },
    input: osc("o1"),
  };
  const b = buildAudioGraphPlan([{ chain: delay, routed: true }]);
  const d = diffAudioGraphPlans(a, b);
  check(
    "diff: shape change disposes + recreates",
    d.dispose.includes("f1") && d.create.includes("f1")
  );
  check("diff: shape change rewires self", d.rewire.includes("f1"));
  check("diff: recreated sink re-marks sinks", d.sinksChanged);
}

{
  // New stage spliced between o1 and f1 → f1 rewires, o1 untouched.
  const a = buildAudioGraphPlan([{ chain: filter("f1", osc("o1")), routed: true }]);
  const b = buildAudioGraphPlan([
    { chain: filter("f1", filter("f2", osc("o1"))), routed: true },
  ]);
  const d = diffAudioGraphPlans(a, b);
  check("diff: splice creates the new stage", d.create.join(",") === "f2");
  check(
    "diff: splice rewires consumer (and new stage), not the source",
    d.rewire.includes("f1") && d.rewire.includes("f2") && !d.rewire.includes("o1")
  );
}

{
  // Upstream recreation forces the consumer to rewire even though the
  // consumer's own inputIds are unchanged.
  const a = buildAudioGraphPlan([{ chain: filter("f1", osc("o1")), routed: true }]);
  const noise: AudioChainGenerator = {
    kind: "generator",
    nodeId: "o1",
    gen: "noise",
    params: { level: 0.5 },
  };
  const b = buildAudioGraphPlan([{ chain: filter("f1", noise), routed: true }]);
  const d = diffAudioGraphPlans(a, b);
  check(
    "diff: upstream recreation rewires consumer",
    d.dispose.includes("o1") && d.create.includes("o1") && d.rewire.includes("f1")
  );
}

{
  // Routing flip only (same graph, sink appears) → sinksChanged, no ops.
  const chain = filter("f1", osc("o1"));
  const a = buildAudioGraphPlan([{ chain, routed: false }]);
  const b = buildAudioGraphPlan([{ chain, routed: true }]);
  const d = diffAudioGraphPlans(a, b);
  check(
    "diff: routing flip is sink-only",
    d.sinksChanged && d.create.length === 0 && d.update.length === 0
  );
}

{
  // Mix lane gain tweak → update with mixLanesChanged (not a rewire).
  const o1 = osc("o1");
  const a = buildAudioGraphPlan([
    { chain: mix("m1", [{ chain: o1, gain: 1 }]), routed: true },
  ]);
  const b = buildAudioGraphPlan([
    { chain: mix("m1", [{ chain: o1, gain: 0.5 }]), routed: true },
  ]);
  const d = diffAudioGraphPlans(a, b);
  check(
    "diff: mix lane change",
    d.update.length === 1 &&
      d.update[0].mixLanesChanged &&
      d.rewire.length === 0
  );
}

{
  // Instrument notes change → notesChanged (schedule rebuild), no rewire.
  const n1: NoteEvent[] = [
    { pitch: 60, velocity: 1, startTick: 0, durationTicks: 500 },
  ];
  const n2: NoteEvent[] = [
    { pitch: 62, velocity: 1, startTick: 0, durationTicks: 500 },
  ];
  const a = buildAudioGraphPlan([{ chain: inst("i1", n1), routed: true }]);
  const b = buildAudioGraphPlan([{ chain: inst("i1", n2), routed: true }]);
  const d = diffAudioGraphPlans(a, b);
  check(
    "diff: notes change",
    d.update.length === 1 && d.update[0].notesChanged && !d.sinksChanged
  );
}

{
  // Vanished root disposes the whole chain.
  const a = buildAudioGraphPlan([{ chain: filter("f1", osc("o1")), routed: true }]);
  const b = buildAudioGraphPlan([]);
  const d = diffAudioGraphPlans(a, b);
  check(
    "diff: teardown disposes all",
    d.dispose.length === 2 && d.create.length === 0 && d.sinksChanged
  );
}

// --- sink reachability (element claim policy) ------------------------------

{
  const el: AudioChainNode = {
    kind: "element",
    nodeId: "src1",
    element: {} as HTMLMediaElement,
    source: "file",
    url: null,
  };
  const routed = filter("f1", el);
  const analysisOnly = filter("f2", el);
  const plan = buildAudioGraphPlan([
    { chain: routed, routed: true },
    { chain: analysisOnly, routed: false },
  ]);
  const reach = sinkReachableIds(plan);
  check(
    "reach: routed chain + shared leaf",
    reach.has("f1") && reach.has("src1") && !reach.has("f2")
  );
  const unroutedPlan = buildAudioGraphPlan([{ chain: analysisOnly, routed: false }]);
  check(
    "reach: analysis-only chain claims nothing",
    sinkReachableIds(unroutedPlan).size === 0
  );
}

// --- mod edges (080926 M-C) --------------------------------------------------

{
  const lfo: AudioChainGenerator = {
    kind: "generator",
    nodeId: "l1",
    gen: "lfo",
    params: { shape: "sine", rate: 2, min: -500, max: 500 },
  };
  const modded: AudioChainEffect = {
    ...filter("f1", osc("o1")),
    mods: [{ param: "cutoff", chain: lfo }],
  };
  const plan = buildAudioGraphPlan([{ chain: modded, routed: true }]);
  check("mods: modulator registers as a stage", plan.stages.has("l1"));
  check(
    "mods: modConns separate from inputIds",
    plan.stages.get("f1")!.modConns.length === 1 &&
      plan.stages.get("f1")!.modConns[0].param === "cutoff" &&
      plan.stages.get("f1")!.modConns[0].fromId === "l1" &&
      plan.stages.get("f1")!.inputIds.join(",") === "o1"
  );
  check("mods: reachability walks mod edges", sinkReachableIds(plan).has("l1"));

  const plain = buildAudioGraphPlan([{ chain: filter("f1", osc("o1")), routed: true }]);
  const dAdd = diffAudioGraphPlans(plain, plan);
  check(
    "mods: adding a mod creates modulator + rewires consumer",
    dAdd.create.includes("l1") && dAdd.rewire.includes("f1")
  );

  const lfo2 = { ...lfo, nodeId: "l2" };
  const reAimed: AudioChainEffect = {
    ...filter("f1", osc("o1")),
    mods: [{ param: "cutoff", chain: lfo2 }],
  };
  const dSwap = diffAudioGraphPlans(
    plan,
    buildAudioGraphPlan([{ chain: reAimed, routed: true }])
  );
  check(
    "mods: re-aimed mod disposes old, creates new, rewires consumer",
    dSwap.dispose.includes("l1") && dSwap.create.includes("l2") && dSwap.rewire.includes("f1")
  );

  check(
    "mods: chain signature sees mod edges",
    chainSignature(modded) !== chainSignature(filter("f1", osc("o1")))
  );
}

// --- shape keys -------------------------------------------------------------

{
  check(
    "shapeKey: distinguishes families and subtypes",
    stageShapeKey(osc("x")) === "generator:osc" &&
      stageShapeKey(filter("x", osc("y"))) === "effect:filter" &&
      stageShapeKey(mix("x", [])) === "mix" &&
      stageShapeKey(inst("x", [])) === "instrument:synth"
  );
}

// --- musical time ------------------------------------------------------------

{
  // 60fps, 1000 ticks/frame: tick 60000 = 1 second.
  check("time: tick→seconds", audioTickToSeconds(60000, 1000, 60) === 1);
  // 120bpm: 1 beat = 0.5s = 30000 ticks at 60fps/1000tpf.
  check("time: beats→ticks", beatsToTicks(1, 120, 1000, 60) === 30000);
  check("time: A4 = 440Hz", Math.abs(midiToFreq(69) - 440) < 1e-9);
  check(
    "time: octave doubles",
    Math.abs(midiToFreq(81) - 880) < 1e-9
  );
  const sched = noteEventsToSeconds(
    [
      { pitch: 64, velocity: 2, startTick: 60000, durationTicks: 0 },
      { pitch: 60, velocity: 0.5, startTick: 0, durationTicks: 30000 },
    ],
    1000,
    60
  );
  check(
    "time: schedule sorted + clamped",
    sched.length === 2 &&
      sched[0].pitch === 60 &&
      sched[0].durationSec === 0.5 &&
      sched[1].timeSec === 1 &&
      sched[1].durationSec > 0 && // zero-length note clamps to one tick
      sched[1].velocity === 1 // velocity clamps to [0,1]
  );
}

console.log(failures === 0 ? "\ncheck-audio-chain: all passed" : `\ncheck-audio-chain: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
