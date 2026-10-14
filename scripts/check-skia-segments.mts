// check-skia-segments: timeline markers, named segments and the exported
// clock's controls (specdocs/101326_skia-target.md §3.5a, M3 lane B). No GPU;
// DOM stubs only for the persistence half.
//
//   1. the marker model: the save sanitizer (untrusted rows), the ruler's
//      edits, and the strict set_markers boundary;
//   2. segment derivation: ordering, point markers chaining to the next one,
//      ranged markers that don't cut the chain, duplicate names,
//      out-of-range and clamped spans, empty spans, an empty list, a shifted
//      (late layer) clock;
//   3. persistence: SavedComposition.markers survives save → JSON → load,
//      garbage is repaired on load, saves without markers load with none, and
//      an older build's load → save (which spreads the registry entry) keeps
//      them — the case for no schema bump;
//   4. export: SEGMENTS / MARKERS in BOTH bundle kinds and their manifests,
//      issues as warnings, the late-layer shift, the plan summary, format 3;
//   5. the emitted toolbox-clock.ts run on fake frames in Node, twice —
//      (js) the TypeScript module with mocked React / Reanimated hooks (the
//      web semantics), and (ui) the worklets Babel plugin's output on an
//      emulated UI runtime, where every worklet is rebuilt from its code
//      string with only its captured closure (shared values shared,
//      constants copied, JS functions remote) — so a control that reaches
//      outside its closure throws here as it would on a phone. Both runs
//      assert time progression, wrap exactness at segment boundaries over
//      many loops, playSegment / loopSegment / thenLoop / seek / pause /
//      play semantics, onSegmentEnd (worklet: same frame; JS: scheduled),
//      and that the whole-timeline loop is bit-identical to the format-2
//      clock (`(t + dt) % duration`);
//   6. both bundles type-check in skia-harness (react-native-skia 3.4.0 +
//      Reanimated 4.7) beside an app screen that uses every control, and an
//      unknown segment name is a compile error.
//
// (ui) and step 6 need skia-harness/node_modules (Babel + the worklets
// plugin, tsc + the RN types); without it they are skipped with a notice,
// and SKIA_HARNESS_REQUIRED=1 turns the skip into a failure.
//
//   npx tsx scripts/check-skia-segments.mts

/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Edge } from "@xyflow/react";
import type { TimelineMarker } from "@/lib/timeline-markers";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS = path.join(ROOT, "skia-harness");
const HAVE_HARNESS = fs.existsSync(path.join(HARNESS, "node_modules", "react-native-worklets", "plugin"));

// Minimal DOM stubs — importing @/lib/project pulls the engine/registry in.
const g = globalThis as any;
const stub = () => ({ getContext: () => null, style: {}, addEventListener() {} });
g.window ??= g;
g.self ??= g;
g.document ??= {
  createElement: stub,
  createElementNS: stub,
  fonts: { add() {}, forEach() {} },
  body: { appendChild() {} },
  addEventListener() {},
};
g.navigator ??= { userAgent: "node" };
g.HTMLCanvasElement ??= class {};
g.OffscreenCanvas ??= class { getContext() { return null; } };
g.WebGL2RenderingContext ??= class {};

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const tm = await import("@/lib/timeline-markers");
const { serializeGraph, deserializeGraph, CURRENT_SCHEMA } = await import("@/lib/project");
const sx = await import("@/lib/skia-export");
const ed = await import("@/lib/skia-export/editor");
const { ticksAt } = await import("@/lib/skia-export/runtime/toolbox-timeline");
const { makeInstanceNode, makeLayerNodes, refreshNodeSockets, newEdgeId } = await import("@/state/graph-ops");
const { checkExportable, typecheckBundle } = await import("./skia/export-check.ts");
const fx = await import("./fixtures/skia/aurora.ts");
const { auroraSceneGraph } = await import("./fixtures/skia/aurora-scene-graph.ts");
import type { GraphNode } from "@/state/graph-ops";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${!cond && detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const RUNTIME = fs.readFileSync(path.join(ROOT, "src/lib/skia-export/runtime/toolbox-timeline.ts"), "utf8");
const TL = fx.AURORA_TIMELINE; // 60 fps, 300 frames
const MARKERS: TimelineMarker[] = fx.AURORA_MARKERS; // intro 0, loop 120, flash 150+30

// ---- 1. the marker model --------------------------------------------------------------
console.log("— marker model");
{
  const raw = [
    { id: "b", name: "  idle\n loop ", frame: 72.4 },
    { id: "a", name: "intro", frame: 0, duration: 0 },
    null,
    "nope",
    { id: "a", name: "dup id", frame: 10 },
    { name: "", frame: -5, duration: 12.6 },
    { id: "bad id!", name: 7, frame: 30 },
    { id: "nf", name: "no frame" },
    { id: "inf", name: "inf", frame: Infinity },
  ];
  const s = tm.sanitizeMarkers(raw);
  check("sanitize: non-objects and frameless / non-finite markers are dropped", s.length === 5, JSON.stringify(s));
  check(
    "sanitize: frame order, frames rounded and clamped ≥ 0, names trimmed / collapsed",
    same(s.map((m) => m.frame), [0, 0, 10, 30, 72]) && s.find((m) => m.frame === 72)?.name === "idle loop",
    JSON.stringify(s)
  );
  check("sanitize: a duration < 1 frame is dropped, others round", s.find((m) => m.name === "intro")?.duration === undefined && s.find((m) => m.name === "Marker")?.duration === 13);
  check("sanitize: an empty or non-string name becomes \"Marker\"", s.filter((m) => m.name === "Marker").length === 2);
  const ids = s.map((m) => m.id);
  check(
    "sanitize: ids are unique and well-formed (repeats and junk re-minted, good ones kept)",
    new Set(ids).size === ids.length && ids.every((i) => /^[A-Za-z0-9_-]+$/.test(i)) && ids.includes("a") && ids.includes("b") && !ids.includes("bad id!"),
    JSON.stringify(ids)
  );
  check("sanitize: not an array → []", tm.sanitizeMarkers({}).length === 0 && tm.sanitizeMarkers(undefined).length === 0);
  check(
    "sanitize: capped at MAX_MARKERS",
    tm.sanitizeMarkers(Array.from({ length: tm.MAX_MARKERS + 10 }, (_, i) => ({ name: `m${i}`, frame: i }))).length === tm.MAX_MARKERS
  );
  check("sanitize: idempotent", same(tm.sanitizeMarkers(s), s));
  check("sanitize: a control-character name is cleaned, long names capped", tm.cleanMarkerName("a\u0000b\tc") === "a b c" && tm.cleanMarkerName("x".repeat(200)).length === tm.MARKER_NAME_MAX);

  // Edits (the ruler).
  let ms: TimelineMarker[] = [];
  const a1 = tm.addMarker(ms, 30);
  ms = a1.markers;
  const a2 = tm.addMarker(ms, 10.6);
  ms = a2.markers;
  check("add: default names count up, frame order, whole frames", same(ms.map((m) => [m.name, m.frame]), [["Marker 2", 11], ["Marker 1", 30]]), JSON.stringify(ms));
  ms = tm.updateMarker(ms, a1.id, { frame: 5, name: " Intro " });
  check("update: move re-sorts, rename trims", ms[0].id === a1.id && ms[0].frame === 5 && ms[0].name === "Intro");
  ms = tm.updateMarker(ms, a1.id, { duration: 20 });
  check("update: set a range", ms[0].duration === 20);
  ms = tm.updateMarker(ms, a1.id, { duration: undefined });
  check("update: clearing the range makes a point marker", !("duration" in ms[0]));
  ms = tm.updateMarker(ms, a1.id, { name: "   " });
  check("update: an empty rename keeps the old name", ms[0].name === "Intro");
  ms = tm.removeMarker(ms, a1.id);
  check("remove", ms.length === 1 && ms[0].id === a2.id);
  check("uniqueMarkerName skips used names", tm.uniqueMarkerName([{ id: "x", name: "Marker 1", frame: 0 }]) === "Marker 2");

  // The set_markers boundary.
  const existing: TimelineMarker[] = [{ id: "keep-me", name: "old", frame: 3 }];
  const ok = tm.vetMarkersInput(
    [
      { name: "loop", frame: 120 },
      { id: "keep-me", name: "intro", frame: 0 },
      { name: "flash", frame: 150, duration: 30 },
      { id: "unknown-id", name: "tail", frame: 290, duration: null },
    ],
    existing
  );
  check(
    "vet: valid input → sorted markers, a known id kept, unknown ids minted, null duration = point",
    ok.ok &&
      same(ok.markers.map((m) => m.name), ["intro", "loop", "flash", "tail"]) &&
      ok.markers[0].id === "keep-me" &&
      ok.markers[3].id !== "unknown-id" &&
      !("duration" in ok.markers[3]) &&
      ok.markers[2].duration === 30,
    JSON.stringify(ok)
  );
  const bad = tm.vetMarkersInput(
    [{ name: "a", frame: 1.5 }, { name: "a", frame: 2 }, { name: "", frame: 3 }, { name: "d", frame: -1 }, { name: "e", frame: 4, duration: 0 }, 7],
    []
  );
  const errs = bad.ok ? [] : bad.errors;
  check(
    "vet: fractional / negative frames, repeated / empty names, bad durations and non-objects each named",
    !bad.ok &&
      errs.some((e) => e.includes("markers[0].frame")) &&
      errs.some((e) => e.includes("markers[1].name") && e.includes("repeats")) &&
      errs.some((e) => e.includes("markers[2].name")) &&
      errs.some((e) => e.includes("markers[3].frame")) &&
      errs.some((e) => e.includes("markers[4].duration")) &&
      errs.some((e) => e.includes("markers[5]")),
    JSON.stringify(errs)
  );
  check("vet: not an array is refused", !tm.vetMarkersInput({}, []).ok);
  check("vet: [] clears", (() => { const r = tm.vetMarkersInput([], existing); return r.ok && r.markers.length === 0; })());
  const rep = tm.describeMarkers(MARKERS, 60, 300);
  check(
    "describeMarkers (get_status): markers with seconds, segments in frames and seconds",
    same(rep.markers.map((m) => [m.name, m.frame, m.seconds]), [["intro", 0, 0], ["loop", 120, 2], ["flash", 150, 2.5]]) &&
      same(rep.segments.map((s) => [s.name, s.startFrame, s.endFrame, s.start, s.end, s.kind]), [
        ["intro", 0, 120, 0, 2, "next"],
        ["loop", 120, 300, 2, 5, "next"],
        ["flash", 150, 180, 2.5, 3, "range"],
      ]) &&
      rep.issues.length === 0,
    JSON.stringify(rep)
  );
}

// ---- 2. segment derivation ------------------------------------------------------------
console.log("— segment derivation");
const segsOf = (ms: TimelineMarker[], D: number) => tm.deriveSegments(ms, D).segments.map((s) => `${s.name}:${s.startFrame}-${s.endFrame}${s.kind === "range" ? "r" : ""}`).join(" ");
const issuesOf = (ms: TimelineMarker[], D: number) => tm.deriveSegments(ms, D).issues.map((i) => `${i.code}:${i.name}`).join(" ");
const M = (name: string, frame: number, duration?: number, id = name + frame): TimelineMarker => (duration === undefined ? { id, name, frame } : { id, name, frame, duration });
{
  check("point markers chain to the next one, the last to the scene end", segsOf([M("a", 0), M("b", 60), M("c", 200)], 300) === "a:0-60 b:60-200 c:200-300");
  check("unsorted input derives the same", segsOf([M("c", 200), M("a", 0), M("b", 60)], 300) === "a:0-60 b:60-200 c:200-300");
  check("frames before the first marker belong to no segment", segsOf([M("a", 30)], 300) === "a:30-300");
  check(
    "a ranged marker is its own span and does not cut the chain",
    segsOf([M("a", 0), M("r", 30, 10), M("b", 60)], 300) === "a:0-60 r:30-40r b:60-300"
  );
  check("overlapping ranges are fine", segsOf([M("x", 10, 50), M("y", 20, 10)], 300) === "x:10-60r y:20-30r");
  const dup = [M("idle", 72), M("intro", 0), M("idle", 200)];
  check(
    "duplicate names: the first ships, the later one still cuts the chain and is flagged",
    segsOf(dup, 300) === "intro:0-72 idle:72-200" && issuesOf(dup, 300) === "duplicate-name:idle",
    `${segsOf(dup, 300)} | ${issuesOf(dup, 300)}`
  );
  const oor = [M("a", 0), M("late", 300), M("later", 450)];
  check(
    "markers at / past the scene end have no segment and are flagged; the chain ends at the scene end",
    segsOf(oor, 300) === "a:0-300" && issuesOf(oor, 300) === "out-of-range:late out-of-range:later",
    `${segsOf(oor, 300)} | ${issuesOf(oor, 300)}`
  );
  const clamp = [M("r", 280, 50)];
  check("a range past the end is clamped and flagged", segsOf(clamp, 300) === "r:280-300r" && issuesOf(clamp, 300) === "clamped:r");
  check("a point marker running to the end is not 'clamped'", issuesOf([M("a", 10)], 300) === "");
  const tie = [M("first", 60), M("second", 60), M("a", 0)];
  check(
    "two point markers on one frame: the first's span is empty (flagged), the second gets it",
    segsOf(tie, 300) === "a:0-60 second:60-300" && issuesOf(tie, 300) === "empty:first",
    `${segsOf(tie, 300)} | ${issuesOf(tie, 300)}`
  );
  const tieD = tm.deriveSegments(tie, 300);
  check("…and the empty one still has a marker time", tieD.markers.some((m) => m.name === "first" && m.frame === 60));
  check("no markers → no segments, no issues", segsOf([], 300) === "" && issuesOf([], 300) === "");
  const shifted = [M("pre", -30), M("a", -10), M("b", 40), M("r", -20, 10)];
  check(
    "a shifted clock: spans before 0 are cut to 0 (clamped), spans ending ≤ 0 are out of range",
    segsOf(shifted, 300) === "a:0-40 b:40-300" && issuesOf(shifted, 300) === "out-of-range:pre out-of-range:r clamped:a",
    `${segsOf(shifted, 300)} | ${issuesOf(shifted, 300)}`
  );
  check("marker times exclude out-of-range and repeated names", same(tm.deriveSegments(dup, 300).markers.map((m) => m.name), ["intro", "idle"]));
}

// ---- 3. persistence -------------------------------------------------------------------
console.log("— persistence");
{
  const comps = [
    { id: "comp-a", name: "Main", markers: MARKERS },
    { id: "comp-b", name: "Other" },
  ];
  const saved = await serializeGraph([], [], undefined, { fps: 60, loopFrames: 300 }, { compositions: comps, activeCompositionId: "comp-a" });
  const wire = JSON.parse(JSON.stringify(saved));
  check("save writes markers on the composition, not the scene", same(wire.compositions[0].markers, MARKERS) && !("markers" in (wire.scene ?? {})) && !("markers" in wire.compositions[1]));
  check("additive: a save carries them at the current schema (no version of their own)", wire.schemaVersion === CURRENT_SCHEMA);
  const loaded = await deserializeGraph(wire);
  check("load → the same markers on the same composition", same(loaded.compositions.find((c) => c.id === "comp-a")?.markers, MARKERS));
  check("a composition without markers loads without the field", !("markers" in loaded.compositions.find((c) => c.id === "comp-b")!));
  // An older build: its deserializeGraph hands the registry entry through and
  // its save spreads it (compositionsForSave: { ...c, scene, … }) — model
  // that with a plain spread of every field the old code knew nothing about.
  const oldBuildComps = (wire.compositions as any[]).map((c) => ({ ...c, scene: { fps: 60, loopFrames: 300 }, modifiedAt: 1 }));
  const resaved = await serializeGraph([], [], undefined, { fps: 60 }, { compositions: oldBuildComps, activeCompositionId: "comp-a" });
  check("an older build's load → save keeps markers (it spreads the entry)", same(JSON.parse(JSON.stringify(resaved)).compositions[0].markers, MARKERS));
  // Garbage on the wire is repaired on load.
  const dirty = { ...wire, compositions: [{ id: "comp-a", name: "Main", markers: [{ name: "x", frame: 3.7 }, { frame: "no" }, { id: "dup", name: "y", frame: 1 }, { id: "dup", name: "z", frame: 2 }] }, { id: "comp-c", name: "C", markers: "junk" }] };
  const fixed = await deserializeGraph(dirty);
  const fm = fixed.compositions[0].markers ?? [];
  check(
    "load sanitizes untrusted markers (frames rounded, junk dropped, ids unique)",
    same(fm.map((m) => [m.name, m.frame]), [["y", 1], ["z", 2], ["x", 4]]) && new Set(fm.map((m) => m.id)).size === 3,
    JSON.stringify(fm)
  );
  check("a non-array markers field loads as none", !("markers" in fixed.compositions[1]));
  const legacy = await deserializeGraph({ schemaVersion: 4, nodes: [], edges: [], scene: { fps: 30 } } as any);
  check("a pre-composition (≤v4) save loads with no markers", legacy.compositions.length === 1 && !("markers" in legacy.compositions[0]));
  const v12 = await deserializeGraph({ schemaVersion: 12, compositions: [{ id: "c", name: "C" }], activeCompositionId: "c", nodes: [], edges: [] } as any);
  check("a v12 save from before markers loads with none", !("markers" in v12.compositions[0]));
}

// ---- 4. export ------------------------------------------------------------------------
console.log("— export");
const effectGraph = fx.auroraGraph();
const sceneGraph = auroraSceneGraph(fx.AURORA_SKSL);
const reqBase = { canvas: { width: 512, height: 512 }, runtimeSource: RUNTIME };
const effect = sx.exportSkia({ ...reqBase, ...effectGraph, name: "Aurora", timeline: { ...TL, markers: MARKERS } });
const scene = sx.exportSkia({ ...reqBase, nodes: sceneGraph.nodes, edges: sceneGraph.edges, targetId: "skc", name: "Aurora (Skia layer)", timeline: { ...TL, markers: MARKERS } });
const bare = sx.exportSkia({ ...reqBase, ...effectGraph, name: "Aurora", timeline: TL });
const EXPECT_SEGMENTS = `export const SEGMENTS = {\n  "intro": [0, 2], // frames 0–120\n  "loop": [2, 5], // frames 120–300\n  "flash": [2.5, 3], // frames 150–180 (range)\n} as const;`;
{
  check("both bundle kinds export", !!effect.files && !!scene.files, JSON.stringify([effect.problems, scene.problems]));
  for (const [kind, r] of [["effect", effect], ["scene", scene]] as const) {
    const f = r.files!;
    const clock = f["toolbox-clock.ts"] ?? "";
    check(`${kind}: ships toolbox-clock.ts with SEGMENTS name → [startSec, endSec)`, clock.includes(EXPECT_SEGMENTS), clock.slice(0, 600));
    check(`${kind}: MARKERS name → seconds`, clock.includes(`export const MARKERS = {\n  "intro": 0, // frame 0\n  "loop": 2, // frame 120\n  "flash": 2.5, // frame 150\n} as const;`));
    check(`${kind}: the clock reads the scene length`, clock.includes("export const DURATION_SEC = 5;"));
    const man = JSON.parse(f["manifest.json"]);
    check(
      `${kind}: manifest format 3 lists segments (seconds + frames) and markers`,
      man.format === 3 &&
        same(man.segments, [
          { name: "intro", start: 0, end: 2, frames: [0, 120], kind: "next" },
          { name: "loop", start: 2, end: 5, frames: [120, 300], kind: "next" },
          { name: "flash", start: 2.5, end: 3, frames: [150, 180], kind: "range" },
        ]) &&
        same(man.markers.map((m: any) => m.name), ["intro", "loop", "flash"]),
      JSON.stringify([man.format, man.segments])
    );
    const comp = kind === "effect" ? f["ToolboxEffect.tsx"] : f["ToolboxScene.tsx"];
    check(
      `${kind}: the component keeps \`time: SharedValue<number>\` and re-exports the clock (no clock code of its own)`,
      comp.includes("time: SharedValue<number>;") && comp.includes(`} from "./toolbox-clock";`) && !comp.includes("useFrameCallback") && !comp.includes("useSharedValue"),
      comp.slice(-600)
    );
    check(
      `${kind}: the barrel exports the clock, SEGMENTS, MARKERS and their types`,
      ["useToolboxClock", "SEGMENTS", "MARKERS", "DURATION_SEC", "type ToolboxClock", "type SegmentName"].every((n) => f["index.ts"].includes(n)) &&
        f["index.ts"].includes(`from "./toolbox-clock"`)
    );
  }
  check("format constants: both kinds are 3", sx.SKIA_EXPORT_FORMAT === 3 && sx.SKIA_SCENE_EXPORT_FORMAT === 3);
  check(
    "no markers → empty SEGMENTS / MARKERS, same clock",
    !!bare.files && bare.files["toolbox-clock.ts"].includes("export const SEGMENTS = {} as const;") && bare.files["toolbox-clock.ts"].includes("export const MARKERS = {} as const;") &&
      same(JSON.parse(bare.files["manifest.json"]).segments, [])
  );
  check(
    "markers change nothing but the clock module and the manifest",
    !!bare.files && Object.keys(bare.files).every((k) => k === "toolbox-clock.ts" || k === "manifest.json" || bare.files![k] === effect.files![k])
  );
  const dupR = sx.exportSkia({ ...reqBase, ...effectGraph, name: "Aurora", timeline: { ...TL, markers: [...MARKERS, M("loop", 200), M("late", 400)] } });
  check(
    "marker issues ride out as export warnings (and never refuse)",
    !!dupR.files && dupR.warnings.some((w) => w.startsWith("Timeline markers:") && w.includes('"loop"') && w.includes("same name")) && dupR.warnings.some((w) => w.includes('"late"') && w.includes("scene end")),
    JSON.stringify(dupR.warnings)
  );
  const direct = sx.exportSkiaScene(
    { version: 1, width: 64, height: 64, root: { k: "group", children: [] }, assets: {} } as any,
    [],
    [],
    { name: "bare scene", timeline: { ...TL, markers: [M("a", 0), M("b", 60)] }, runtimeSource: RUNTIME }
  );
  check("exportSkiaScene (IR fixtures) reads timeline.markers too", !!direct.files && direct.files["toolbox-clock.ts"].includes(`"b": [1, 5]`), JSON.stringify(direct.problems));

  // The editor path: env.markers → request; a late layer shifts them.
  const edge = (source: string, sourceHandle: string, target: string, targetHandle: string): Edge => ({ id: newEdgeId(), source, sourceHandle, target, targetHandle });
  const node = (type: string, id: string, parentId?: string): GraphNode => {
    const n = makeInstanceNode(type, { x: 0, y: 0 });
    n.id = id;
    n.data.parentId = parentId;
    return refreshNodeSockets(n);
  };
  const { layer, groupInput, groupOutput } = makeLayerNodes("Aurora Layer", { x: 0, y: 0 });
  layer.data.params = { ...layer.data.params, target: "skia" };
  const nodes: GraphNode[] = [layer, groupInput, groupOutput];
  for (const en of effectGraph.nodes) {
    const n = node(en.type, en.id, layer.id);
    n.data.params = en.params;
    n.data.animation = en.animation;
    nodes.push(n);
  }
  const edges: Edge[] = [...effectGraph.edges.map((e) => ({ ...e })), edge("aurora", "out:primary", groupOutput.id, "in:image")];
  const ENV = { canvas: { width: 512, height: 512 }, fps: 60, frames: 300, markers: MARKERS };
  const onTime = ed.prepareSkiaExport(nodes, edges, layer.id, ENV);
  check("editor: the request carries the composition's markers", same(onTime.request?.timeline.markers, MARKERS));
  const viaEditor = ed.exportSkiaFromEditor(nodes, edges, layer.id, ENV).result;
  check("editor: the bundle's clock matches the direct export", viaEditor.files?.["toolbox-clock.ts"] === effect.files?.["toolbox-clock.ts"]);
  const plan = ed.planSkiaExportForEditor(nodes, edges, layer.id, ENV);
  check("plan_skia_export summary lists the segments", same(plan.segments?.map((s) => [s.name, s.start, s.end]), [["intro", 0, 2], ["loop", 2, 5], ["flash", 2.5, 3]]), JSON.stringify(plan.segments));
  layer.data.clips = [{ inTick: 30_000, outTick: 300_000, sourceInTick: 0, enabled: true }];
  const late = ed.exportSkiaFromEditor(nodes, edges, layer.id, ENV).result;
  const lateClock = late.files?.["toolbox-clock.ts"] ?? "";
  check(
    "editor: a layer starting at frame 30 shifts markers onto its own clock (−30 frames) and says so",
    lateClock.includes(`"intro": [0, 1.5], // frames 0–90`) &&
      lateClock.includes(`"loop": [1.5, 5], // frames 90–300`) &&
      lateClock.includes(`"flash": [2, 2.5], // frames 120–150 (range)`) &&
      late.warnings.some((w) => w.includes("starts at frame 30") && w.includes("shift by −30 frames")) &&
      late.warnings.some((w) => w.includes('"intro"') && w.includes("cut to")),
    `${lateClock.slice(lateClock.indexOf("SEGMENTS"), lateClock.indexOf("SEGMENTS") + 220)} | ${JSON.stringify(late.warnings)}`
  );
  const noMarkers = ed.prepareSkiaExport(nodes, edges, layer.id, { ...ENV, markers: undefined });
  check("editor: no markers → none on the request", noMarkers.request !== null && !("markers" in noMarkers.request.timeline));
}

// ---- 5. the clock on fake frames ------------------------------------------------------
console.log("— the emitted clock");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skia-segments-"));

// The mocks keep their state on globalThis.__SEGMENT_MOCKS__[slot], so the
// gate sees it whichever module instance a loader hands the clock.
interface MockState {
  registered: { cb: (f: unknown) => void; raw: any; autostart: boolean }[];
  scheduled: (() => void)[];
  toUI: (f: any) => any;
}
const mockState = (g.__SEGMENT_MOCKS__ ??= {}) as Record<string, MockState>;
const MOCK_REACT = `export function useMemo(f) { return f(); }\nexport function useCallback(f) { return f; }\n`;
// Hooks run once per mount. A frame callback registers through toUI —
// identity for (js); the UI-runtime rebuild for (ui).
const MOCK_REANIMATED = (slot: string) =>
  `const S = globalThis.__SEGMENT_MOCKS__[${JSON.stringify(slot)}];\nexport function useSharedValue(value) { return { value, __shared: true }; }\nexport function useFrameCallback(cb, autostart = true) { S.registered.push({ cb: S.toUI(cb), raw: cb, autostart }); return { setActive() {}, isActive: autostart, callbackId: S.registered.length }; }\n`;
// scheduleOnRN is library code callable on the UI runtime (__host); what it
// queues runs when the gate flushes (the JS thread's next turn).
const MOCK_WORKLETS = (slot: string) =>
  `const S = globalThis.__SEGMENT_MOCKS__[${JSON.stringify(slot)}];\nexport function isWorkletFunction(f) { return typeof f === "function" && !!f.__workletHash; }\nexport function scheduleOnRN(f, ...args) { S.scheduled.push(() => (f.__remote ?? f)(...args)); }\nscheduleOnRN.__host = true;\n`;

function rewriteImports(src: string, dir: string): string {
  return src
    .replace(/from "react"/g, `from ${JSON.stringify(pathToFileURL(path.join(dir, "mock-react.mjs")).href)}`)
    .replace(/from "react-native-reanimated"/g, `from ${JSON.stringify(pathToFileURL(path.join(dir, "mock-reanimated.mjs")).href)}`)
    .replace(/from "react-native-worklets"/g, `from ${JSON.stringify(pathToFileURL(path.join(dir, "mock-worklets.mjs")).href)}`);
}

interface Loaded {
  mod: any;
  state: MockState;
  // A function as the UI thread sees it (worklets rebuilt; identity in js).
  ui: (f: any) => any;
}

async function loadMode(mode: "js" | "ui", clockSrc: string, slot: string): Promise<Loaded | null> {
  const key = `${mode}-${slot}`;
  const dir = path.join(tmpRoot, key);
  fs.mkdirSync(dir, { recursive: true });
  const state: MockState = (mockState[key] = { registered: [], scheduled: [], toUI: (f) => f });
  fs.writeFileSync(path.join(dir, "mock-react.mjs"), MOCK_REACT);
  fs.writeFileSync(path.join(dir, "mock-reanimated.mjs"), MOCK_REANIMATED(key));
  fs.writeFileSync(path.join(dir, "mock-worklets.mjs"), MOCK_WORKLETS(key));
  let file: string;
  let ui: (f: any) => any = (f) => f;
  if (mode === "js") {
    file = path.join(dir, "toolbox-clock.ts");
    fs.writeFileSync(file, rewriteImports(clockSrc, dir));
  } else {
    const req = createRequire(path.join(HARNESS, "package.json"));
    const babel = req("@babel/core");
    const src = path.join(dir, "toolbox-clock.src.ts");
    fs.writeFileSync(src, clockSrc);
    const out = babel.transformSync(clockSrc, {
      filename: src,
      babelrc: false,
      configFile: false,
      presets: [[req.resolve("@babel/preset-typescript")]],
      plugins: [[req.resolve("react-native-worklets/plugin")]],
    });
    file = path.join(dir, "toolbox-clock.ui.mjs");
    fs.writeFileSync(file, rewriteImports(out.code, dir));
    ui = makeUiRuntime();
    state.toUI = ui;
  }
  const mod = await import(pathToFileURL(file).href);
  return { mod, state, ui };
}

// An emulated worklet runtime: a worklet is re-created from the plugin's code
// string and called with `this.__closure` = its captured values, converted the
// way react-native-worklets moves them — shared values stay shared, worklets
// recurse, host functions pass, other JS functions become remote (callable only
// through scheduleOnRN), plain data is deep-copied and frozen.
function makeUiRuntime() {
  const cache = new Map<any, any>();
  const toUI = (v: any): any => {
    if (v === null || v === undefined) return v;
    if (typeof v === "function") {
      if (cache.has(v)) return cache.get(v);
      if (v.__host) return v;
      if (v.__workletHash && v.__initData?.code) {
        const fn = new Function(`"use strict"; return ${v.__initData.code};`)();
        const self: any = { __closure: undefined };
        const w: any = (...args: any[]) => fn.apply(self, args);
        w.__workletHash = v.__workletHash;
        cache.set(v, w);
        self.__closure = Array.isArray(v.__closure) ? v.__closure.map(toUI) : Object.fromEntries(Object.entries(v.__closure ?? {}).map(([k, x]) => [k, toUI(x)]));
        return w;
      }
      if (v.__workletHash) return v; // an app worklet built by hand in this gate
      const remote: any = () => {
        throw new Error(`a JS function (${v.name || "anonymous"}) was called synchronously on the UI runtime`);
      };
      remote.__remote = v;
      cache.set(v, remote);
      return remote;
    }
    if (typeof v === "object") {
      if (v.__shared) return v;
      return deepFreeze(structuredClone(v));
    }
    return v;
  };
  return toUI;
}
function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze((o as any)[k]);
  }
  return o;
}

const FPS = TL.fps;
const frameOf = (t: number) => ticksAt(t, FPS, TL.ticksPerFrame) / TL.ticksPerFrame;

function runClockSuite(L: Loaded, tag: string, opts: { segments: boolean }) {
  const c = (name: string, cond: boolean, detail?: string) => check(`(${tag}) ${name}`, cond, detail);
  const { mod, state, ui } = L;
  const wl = state;
  const flush = () => {
    while (state.scheduled.length) state.scheduled.shift()!();
  };
  const mount = (o: Record<string, unknown> = {}) => {
    const before = state.registered.length;
    const clock = mod.useToolboxClock(o);
    const reg = state.registered[before];
    const once = state.registered.length === before + 1;
    const step = (ms: number | null) => reg.cb({ timestamp: 0, timeSincePreviousFrame: ms, timeSinceFirstFrame: 0 });
    return { clock, step, once, reg };
  };
  // Run n frames of `ms`; the frame number shown after each.
  const run = (m: ReturnType<typeof mount>, n: number, ms: number, afterEach?: () => void) => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      m.step(ms);
      afterEach?.();
      out.push(frameOf(m.clock.time.value));
    }
    return out;
  };
  const DT = 1000 / FPS;
  const firstMismatch = (got: number[], want: (k: number) => number) => {
    for (let i = 0; i < got.length; i++) if (!Object.is(got[i], want(i + 1))) return `step ${i + 1}: frame ${got[i]}, want ${want(i + 1)}`;
    return "";
  };

  {
    const ends: unknown[] = [];
    const m = mount({ onSegmentEnd: (s: unknown) => ends.push(s) });
    c("one frame callback per mount, autostarted", m.once && m.reg.autostart === true);
    if (tag === "ui") c("the frame callback is a worklet (rebuilt from its code string)", !!m.reg.raw.__workletHash && !!m.reg.raw.__initData);
    m.step(null);
    c("a first frame (timeSincePreviousFrame null) does not move time", m.clock.time.value === 0);
    const got = run(m, 900, DT);
    const mm = firstMismatch(got, (k) => k % 300);
    c("whole timeline at 60 fps: every frame lands on an exact frame, wrapping 299 → 0 (3 loops)", !mm, mm);
    c("JS onSegmentEnd is scheduled, not called on the frame", ends.length === 0 && wl.scheduled.length === 3);
    flush();
    c("…once per wrap, with segment null for the whole timeline", same(ends, [null, null, null]));
    c("segment / playing state", m.clock.segment.value === null && m.clock.playing.value === true);
  }
  {
    const m = mount();
    const got = run(m, 1200, 1000 / 120);
    const mm = firstMismatch(got, (k) => (k / 2) % 300);
    c("120 Hz: half frames, exact, wrapping at 300", !mm, mm);
  }
  {
    // Bit-identical to the format-2 clock over a jittery 5000-frame run.
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const m = mount();
    let old = 0;
    let diff = "";
    for (let i = 0; i < 5000 && !diff; i++) {
      const ms = 5 + rnd() * 35;
      m.step(ms);
      old = (old + ms / 1000) % 5;
      if (!Object.is(old, m.clock.time.value)) diff = `frame ${i}: ${m.clock.time.value} vs ${old}`;
    }
    c("whole-timeline loop is bit-identical to the format-2 clock ((t + dt) % duration), 5000 jittered frames", !diff, diff);
  }
  {
    const m = mount({ playing: false });
    run(m, 5, DT);
    c("playing: false holds at 0", m.clock.time.value === 0 && m.clock.playing.value === false);
    m.clock.play();
    run(m, 3, DT);
    c("play() starts it", frameOf(m.clock.time.value) === 3);
    m.clock.pause();
    run(m, 5, DT);
    c("pause() holds", frameOf(m.clock.time.value) === 3 && m.clock.playing.value === false);
    m.clock.play();
    run(m, 1, DT);
    c("play() resumes from where it paused", frameOf(m.clock.time.value) === 4);
  }
  {
    const m = mount({ start: 1 });
    run(m, 1, DT);
    c("start: 1 s begins at frame 60", frameOf(m.clock.time.value) === 61);
    const ends: unknown[] = [];
    const once = mount({ loop: false, onSegmentEnd: (s: unknown) => ends.push(s) });
    run(once, 310, DT);
    flush();
    c("loop: false plays the timeline once, holds on its end and fires once", Object.is(once.clock.time.value, 5) && once.clock.playing.value === false && same(ends, [null]));
  }
  if (!opts.segments) {
    const m = mount({ segment: "intro" });
    c("no segments: an initial segment name is ignored", m.clock.segment.value === null && m.clock.time.value === 0);
    c("no segments: playSegment refuses", m.clock.playSegment("intro") === false && m.clock.segment.value === null);
    return;
  }
  {
    const ends: unknown[] = [];
    const m = mount({ playing: false, onSegmentEnd: (s: unknown) => ends.push(s) });
    c("playSegment(intro) starts it", m.clock.playSegment("intro") === true && m.clock.segment.value === "intro" && m.clock.playing.value === true);
    const got = run(m, 130, DT);
    const mm = firstMismatch(got, (k) => Math.min(k, 120));
    flush();
    c("play once: 1…119, then holds ON the end instant (frame 120 = the next segment's first)", !mm, mm);
    c("…exactly SEGMENTS.intro[1], paused, onSegmentEnd(intro) once", Object.is(m.clock.time.value, mod.SEGMENTS.intro[1]) && m.clock.playing.value === false && same(ends, ["intro"]));
    m.clock.play();
    c("play() at the end of a play-once segment restarts it", m.clock.time.value === 0 && m.clock.playing.value === true && m.clock.segment.value === "intro");
  }
  {
    const ends: unknown[] = [];
    const m = mount({ onSegmentEnd: (s: unknown) => ends.push(s) });
    c("loopSegment(loop)", m.clock.loopSegment("loop") === true && m.clock.time.value === 2);
    const got = run(m, 1800, DT);
    const mm = firstMismatch(got, (k) => 120 + (k % 180));
    flush();
    c("loop [120, 300): exact frames over 10 loops, wrapping 299 → 120, never showing 300", !mm, mm);
    c("…onSegmentEnd(loop) per wrap", ends.length === 10 && ends.every((e) => e === "loop"));
  }
  {
    const m = mount();
    m.clock.loopSegment("flash");
    const got = run(m, 300, DT);
    const mm = firstMismatch(got, (k) => 150 + (k % 30));
    c("a ranged segment loops exactly: flash [150, 180)", !mm, mm);
    m.clock.loopSegment("flash");
    m.step(1250);
    c("a long frame (1.25 s) wraps by the overshoot: 2.5 + 0.75 mod 0.5 → frame 165", frameOf(m.clock.time.value) === 165, String(m.clock.time.value));
  }
  {
    const ends: unknown[] = [];
    const m = mount({ playing: false, onSegmentEnd: (s: unknown) => ends.push(s) });
    m.clock.playSegment("intro", { thenLoop: "loop" });
    let switchedAt = -1;
    const got = run(m, 1000, DT, () => {
      if (switchedAt < 0 && m.clock.segment.value === "loop") switchedAt = frameOf(m.clock.time.value);
    });
    const mm = firstMismatch(got, (k) => (k < 120 ? k : 120 + ((k - 120) % 180)));
    flush();
    c("thenLoop: intro 1…119 → loop from 120 with no dropped or repeated frame, looping", !mm, mm);
    c("…the segment switches at the boundary frame", switchedAt === 120 && m.clock.segment.value === "loop");
    c("…onSegmentEnd(intro) then (loop) per wrap", ends[0] === "intro" && ends.slice(1).every((e) => e === "loop") && ends.length === 1 + Math.floor((1000 - 120) / 180));
    m.clock.playSegment("intro", { thenLoop: "nope" as never });
    run(m, 130, DT);
    c("thenLoop with an unknown name plays once", m.clock.playing.value === false && Object.is(m.clock.time.value, 2));
  }
  {
    // A worklet onSegmentEnd runs in the same frame and can call controls.
    const calls: unknown[] = [];
    const ref: { clock?: any } = {};
    const chain = Object.assign(
      (s: unknown) => {
        calls.push(s);
        if (s === "intro") ref.clock.loopSegment("loop");
      },
      { __workletHash: 1 }
    );
    flush();
    const m = mount({ playing: false, onSegmentEnd: chain });
    ref.clock = m.clock;
    m.clock.playSegment("intro");
    const got = run(m, 400, DT);
    const mm = firstMismatch(got, (k) => (k <= 120 ? k : 120 + ((k - 120) % 180)));
    c(
      "worklet onSegmentEnd runs in the frame: chaining loopSegment from it is seamless",
      !mm && calls[0] === "intro" && wl.scheduled.length === 0,
      `${mm} calls ${JSON.stringify(calls.slice(0, 3))} scheduled ${wl.scheduled.length}`
    );
  }
  {
    const m = mount();
    m.clock.loopSegment("loop");
    m.clock.seek(2.5);
    c("seek inside the playing segment keeps it", m.clock.segment.value === "loop" && m.clock.time.value === 2.5);
    run(m, 1, DT);
    c("…and plays on from there", frameOf(m.clock.time.value) === 151);
    m.clock.seek(0.5);
    c("seek outside it returns to the whole timeline", m.clock.segment.value === null && m.clock.time.value === 0.5);
    const got = run(m, 300, DT);
    c("…looping the whole timeline again (the hook's loop option)", got[0] === 31 && got[269] === 0 && got[299] === 30, `${got[0]} ${got[269]} ${got[299]}`);
    m.clock.seek(-3);
    c("seek clamps below 0", m.clock.time.value === 0);
    m.clock.seek(99);
    c("seek clamps to the scene end", m.clock.time.value === 5);
    run(m, 1, DT);
    c("…and the next frame wraps from there", frameOf(m.clock.time.value) === 1);
    m.clock.seek(Number.NaN);
    c("seek(NaN) → 0", m.clock.time.value === 0);
  }
  {
    const m = mount();
    m.clock.loopSegment("flash");
    const snap = JSON.stringify([m.clock.time.value, m.clock.segment.value, m.clock.playing.value]);
    const refused = ["nope", "constructor", "__proto__", "toString", ""].every((n) => m.clock.playSegment(n as never) === false && m.clock.loopSegment(n as never) === false);
    c("unknown names (incl. prototype keys) refuse and change nothing", refused && snap === JSON.stringify([m.clock.time.value, m.clock.segment.value, m.clock.playing.value]));
    m.clock.playAll({ loop: false });
    c("playAll returns to the whole timeline from 0", m.clock.segment.value === null && m.clock.time.value === 0 && m.clock.playing.value === true);
    run(m, 400, DT);
    c("…playAll({ loop: false }) plays it once", Object.is(m.clock.time.value, 5) && m.clock.playing.value === false);
  }
  {
    const m = mount({ segment: "loop" });
    c("segment option: starts at its start, loops it (loop default true)", m.clock.segment.value === "loop" && m.clock.time.value === 2);
    const got = run(m, 360, DT);
    const mm = firstMismatch(got, (k) => 120 + (k % 180));
    c("…exactly", !mm, mm);
  }
  {
    // The controls from the UI thread (a gesture / animated reaction worklet).
    const m = mount({ playing: false });
    const names = ["play", "pause", "seek", "playSegment", "loopSegment", "playAll"];
    if (tag === "ui") c("every control is a worklet", names.every((n) => !!m.clock[n].__workletHash));
    c("loopSegment on the UI thread", ui(m.clock.loopSegment)("flash") === true && m.clock.segment.value === "flash");
    run(m, 3, DT);
    c("…plays", frameOf(m.clock.time.value) === 153);
    ui(m.clock.seek)(2.75);
    ui(m.clock.pause)();
    run(m, 3, DT);
    c("seek + pause on the UI thread", frameOf(m.clock.time.value) === 165 && m.clock.playing.value === false);
    ui(m.clock.play)();
    run(m, 1, DT);
    c("play on the UI thread", frameOf(m.clock.time.value) === 166);
    ui(m.clock.playSegment)("intro", { thenLoop: "loop" });
    const got = run(m, 200, DT);
    c("playSegment(…, { thenLoop }) on the UI thread", got[119] === 120 && got[120] === 121 && m.clock.segment.value === "loop");
    ui(m.clock.playAll)({ loop: true });
    c("playAll on the UI thread", m.clock.segment.value === null && m.clock.time.value === 0);
  }
}

{
  const clockSrc = effect.files!["toolbox-clock.ts"];
  check("toolbox-clock.ts is identical in both bundle kinds", clockSrc === scene.files!["toolbox-clock.ts"].replace("change the Skia layer", "change the SkSL Shader node"));
  const directives = clockSrc.match(/"worklet";/g)?.length ?? 0;
  check("every function the UI thread runs carries \"worklet\" (rangeOf, the frame callback, 7 controls)", directives === 9, String(directives));
  const js = await loadMode("js", clockSrc, "segments");
  runClockSuite(js!, "js", { segments: true });
  const jsBare = await loadMode("js", bare.files!["toolbox-clock.ts"], "bare");
  runClockSuite(jsBare!, "js, no markers", { segments: false });
  if (HAVE_HARNESS) {
    const uiRun = await loadMode("ui", clockSrc, "segments");
    runClockSuite(uiRun!, "ui", { segments: true });
    const uiBare = await loadMode("ui", bare.files!["toolbox-clock.ts"], "bare");
    runClockSuite(uiBare!, "ui, no markers", { segments: false });
  } else {
    console.log("skip (ui) worklet-runtime run — skia-harness/node_modules is not installed");
    if (process.env.SKIA_HARNESS_REQUIRED) check("(ui) worklet-runtime run", false, "SKIA_HARNESS_REQUIRED=1");
  }
}
fs.rmSync(tmpRoot, { recursive: true, force: true });

// ---- 6. type-check in skia-harness ----------------------------------------------------
console.log("— type-check");
const screen = (component: "ToolboxEffect" | "ToolboxScene") => `import React, { useEffect } from "react";
import { Button, View } from "react-native";
import { withTiming } from "react-native-reanimated";
import { ${component}, useToolboxClock, SEGMENTS, MARKERS, DURATION_SEC, type SegmentName, type ToolboxClock } from "./index";

// Intro once, then the idle loop; buttons replay it, jump, or ease the clock to a marker.
export function Screen() {
  const clock: ToolboxClock = useToolboxClock({
    playing: false,
    onSegmentEnd: (s) => {
      "worklet";
      if (s === null) return;
    },
  });
  useEffect(() => {
    clock.playSegment("intro", { thenLoop: "loop" });
  }, [clock]);
  const names = Object.keys(SEGMENTS) as SegmentName[];
  const [a, b] = SEGMENTS.flash;
  const mid: number = (a + b) / 2;
  return (
    <View>
      <${component} time={clock.time} width={320} height={320} />
      <Button title="Replay intro" onPress={() => clock.playSegment("intro", { thenLoop: "loop" })} />
      <Button title="Loop flash" onPress={() => clock.loopSegment("flash")} />
      <Button title={names.join(" ")} onPress={() => clock.seek(mid)} />
      <Button title="Pause" onPress={() => clock.pause()} />
      <Button title="Play" onPress={() => clock.play()} />
      <Button title="All" onPress={() => clock.playAll({ loop: DURATION_SEC > 1 })} />
      <Button
        title="Ease to loop"
        onPress={() => {
          clock.pause();
          clock.time.value = withTiming(MARKERS.loop, { duration: 400 });
        }}
      />
    </View>
  );
}

export function NotASegment(clock: ToolboxClock) {
  // @ts-expect-error unknown segment names are compile errors
  clock.playSegment("nope");
}
`;
{
  const sceneCheck = await checkExportable({
    nodes: sceneGraph.nodes,
    edges: sceneGraph.edges,
    canvasId: "skc",
    name: "Aurora (Skia layer)",
    canvas: { width: 512, height: 512 },
    timeline: { ...TL, markers: MARKERS },
    typecheck: true,
    slot: "segments-scene",
    extraFiles: { "Screen.tsx": screen("ToolboxScene") },
  });
  check("scene bundle: exports with every program compiling", !sceneCheck.problems.length && sceneCheck.programs.every((p) => p.ok), JSON.stringify([sceneCheck.problems, sceneCheck.programs]));
  check(`scene bundle + app screen type-check (react-native-skia 3.4.0, Reanimated 4.7)${sceneCheck.typecheck.ran ? "" : " — skipped"}`, sceneCheck.typecheck.ok, sceneCheck.typecheck.output);
  const effectCheck = typecheckBundle(effect.files!, "segments-effect", { "Screen.tsx": screen("ToolboxEffect") });
  check(`SkSL Shader bundle + app screen type-check${effectCheck.ran ? "" : " — skipped"}`, effectCheck.ok, effectCheck.output);
  if (!sceneCheck.typecheck.ran) console.log(`     ${sceneCheck.typecheck.output}`);
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall segment checks passed");
process.exit(failures ? 1 : 0);
