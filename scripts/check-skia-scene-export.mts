// check-skia-scene-export: the Skia scene → React Native Skia export gate
// (specdocs/101326_skia-target.md §3.4–3.5, lane L3). No GPU, no device:
//
//   1. bind resolution: the fixture scene (scripts/fixtures/skia/scene-fixture.ts)
//      exports through exportSkia's skia-canvas branch — real evaluator, real
//      Animated Value / Color / Constant drivers — and every bind resolves as
//      the spec says (keyframed → track, wired driver → track / static,
//      derived → sampled or static, iTime → clock, transformed or untagged
//      values → sampled with a warning);
//   2. the emitted timeline (sampleBinds + PATH_* series) reproduces the
//      producer's bound value at EVERY frame, bit for bit;
//   3. the emitted programs compile in CanvasKit and declare exactly the
//      uniforms the bundle supplies;
//   4. refusals: foreign drivers, translucent color keys, a keyframed
//      Constant, a retimed clock, structure that animates, missing nodes /
//      assets, clips, retimed layers, filters RN Skia can't express;
//   5. expression-channel refs (ch:<name>) follow M0's driver rules;
//   6. the emitted files match scripts/fixtures/skia/snapshots/ (--update
//      rewrites them);
//   7. the CLI (--fixture scene, --scene ir.json) writes the same bundle;
//   8. the emitted bundles type-check inside skia-harness against
//      react-native-skia 3.4.0 + Reanimated 4.7 (written to
//      skia-harness/src/__scene_check__/, deleted afterwards). Skipped,
//      with a notice, when skia-harness/node_modules is absent (CI installs
//      the root only); SKIA_HARNESS_REQUIRED=1 turns the skip into a failure.
//
//   npx tsx scripts/check-skia-scene-export.mts [--update]

/* eslint-disable @typescript-eslint/no-explicit-any */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type { Bind, SkiaNode, SkiaScene, SkslProgramIR } from "@/engine/skia/scene-ir";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UPDATE = process.argv.includes("--update");

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { syncChannelInputs } = await import("@/engine/expr-channels");
const { exportSkia, exportSkiaScene, makeSceneSampler, planSceneExport } = await import("@/lib/skia-export");
const { collectBinds } = await import("@/lib/skia-export/scene-plan");
const { svgPathSignature } = await import("@/lib/skia-export/scene-emit");
const fx = await import("./fixtures/skia/scene-fixture.ts");

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${!cond && detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
const same = (a: unknown, b: unknown) =>
  Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => Object.is(x, b[i])) : Object.is(a, b);

const runtimeSource = fs.readFileSync(path.join(ROOT, "src/lib/skia-export/runtime/toolbox-timeline.ts"), "utf8");
const TL = fx.SCENE_TIMELINE;
const FRAMES = TL.sceneDurationTicks / TL.ticksPerFrame + 1;
const s = <T,>(v: T): Bind<T> => ({ v });

// ---- 0. path verb signatures ------------------------------------------------------------
check(
  "svgPathSignature: implicit lineTo after M, H/V → L, S → C, T → Q, arcs refuse",
  svgPathSignature("M0 0 10 0 10 10 H 0 V 5 Z") === "MLLLLZ" &&
    svgPathSignature("m0 0 c1 1 2 2 3 3 s4 4 5 5 q1 1 2 2 t3 3z") === "MCCQQZ" &&
    svgPathSignature("M0 0 A5 5 0 0 1 10 0") === null &&
    svgPathSignature("M0 0 L1") === null
);

// ---- 1. the fixture through exportSkia ------------------------------------------------------
const g = fx.sceneFixtureGraph();
const req = { nodes: g.nodes, edges: g.edges, targetId: g.canvasId, name: "Scene fixture", canvas: fx.SCENE_CANVAS, timeline: TL, runtimeSource };
const res = exportSkia(req);
check("fixture exports through exportSkia's skia-canvas branch", !!res.files && res.problems.length === 0, res.problems.join(" | "));
if (!res.files) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
const files = res.files;
const sampler = makeSceneSampler(g.nodes, g.edges, g.canvasId, fx.SCENE_CANVAS, TL);
if ("problem" in sampler) throw new Error(sampler.problem);
const scene0 = sampler.sampleAt(0)!;
const direct = exportSkiaScene(scene0, g.nodes, g.edges, { name: "Scene fixture", timeline: TL, runtimeSource, sampleAt: (t) => sampler.sampleAt(t) });
check("exportSkiaScene(scene, sampler) emits the same files", JSON.stringify(direct.files) === JSON.stringify(files));
const plan = (p: string) => direct.binds.find((b) => b.path === p)?.plan;
const kindOf = (p: string) => plan(p)?.kind ?? "missing";
const expectKinds: [string, string, string][] = [
  ["root.children.0.paint.shader.program.uniforms.iTime", "clock", "untagged iTime is the master clock"],
  ["root.children.0.paint.shader.program.uniforms.iResolution", "static", "iResolution is static canvas px"],
  ["root.children.0.paint.shader.program.uniforms.tint", "track", "keyframed color param → color track"],
  ["root.children.0.paint.shader.program.children.0.shader.stops.0.color", "track", "color param wired from a keyframed Color → track"],
  ["root.children.1.transform.translate.0", "track", "vec2 component (customBezier keys) → scalar track"],
  ["root.children.1.transform.translate.1", "track", "vec2 component → scalar track"],
  ["root.children.1.transform.rotate", "track", "keyframed scalar → track"],
  ["root.children.1.transform.scale.0", "static", "param wired from a static Constant → static"],
  ["root.children.1.layer.imageFilters.0.sx", "track", "param wired from a keyframed Animated Value → track"],
  ["root.children.1.children.0.geom.r", "track", "keyframed radius (hold + cubicBezier keys) → track"],
  ["root.children.2.children.0.geom.d", "sampled", "path derived from an animated param → sampled"],
  ["root.children.2.children.1.geom.d", "sampled", "path whose verbs change → sampled"],
  ["root.children.2.children.2.geom.d", "static", "path derived from static params only → static"],
  ["root.children.2.children.3.geom.pts", "sampled", "points derived from an animated param → sampled"],
  ["root.children.4.text", "sampled", "untagged value that moves → sampled"],
  ["root.children.5.font.size", "track", "keyframed font size → track"],
  ["root.children.5.text", "static", "string param → static"],
  ["root.children.6.xforms", "sampled", "atlas xforms derived from an animated param → sampled"],
  ["root.children.8.geom.r", "sampled", "a transformed value tagged as a plain ref → sampled"],
];
for (const [p, k, why] of expectKinds) check(`${why} (${p})`, kindOf(p) === k, `got ${kindOf(p)}`);
check(
  "the warnings name the untagged and the transformed bind",
  res.warnings.some((w) => w.includes("root.children.4.text") && w.includes("say static")) &&
    res.warnings.some((w) => w.includes("root.children.8.geom.r") && w.includes("does not reproduce"))
);
const tintPlan = plan("root.children.0.paint.shader.program.uniforms.tint") as any;
check("a color param's track snaps to 8 bits like colorValueToHex", tintPlan?.tracks?.[0]?.quantize8 === true && tintPlan.tracks[0].alpha === 1);
const tl = files["timeline.ts"];
check(
  "the star path interpolates (equal verbs), the polygon steps",
  /children\.2\.children\.0\.geom\.d: .*interpolated \(equal verbs\)/.test(tl) &&
    /children\.2\.children\.1\.geom\.d: .*stepped \(verbs change\)/.test(tl) &&
    files["ToolboxScene.tsx"].includes("usePathInterpolation(F, PATH_")
);
check(
  "binds reading the same thing share one sampleBinds key",
  (tl.match(/evaluateTrack\(T_/g) ?? []).length < direct.binds.filter((b) => b.plan.kind === "track").length
);
check(
  "the component reads one derived value for the scene and selects props from it",
  files["ToolboxScene.tsx"].includes("const B = useDerivedValue(() => sampleBinds(time.value));") && files["ToolboxScene.tsx"].includes('select(B, "')
);
check("the root group scales toolbox px to the RN canvas", files["ToolboxScene.tsx"].includes("transform={[{ scaleX: width / CANVAS.width }, { scaleY: height / CANVAS.height }]}"));
check(
  "bundle files",
  ["ToolboxScene.tsx", "timeline.ts", "toolbox-timeline.ts", "effects.ts", "assets.ts", "manifest.json", "index.ts", "assets/logo.png.b64", "assets/inter.ttf.b64"].every((f) => f in files) &&
    !("assets/sprites.png.b64" in files)
);
check("runtime ships verbatim", files["toolbox-timeline.ts"] === runtimeSource);
const manifest = JSON.parse(files["manifest.json"]);
check(
  "manifest: format 2, kind scene, non-bundled assets keep their URL",
  manifest.format === 2 &&
    manifest.kind === "scene" &&
    manifest.assets.find((a: any) => a.id === "sprites")?.url === fx.SCENE_ASSETS.sprites.url &&
    manifest.assets.find((a: any) => a.id === "logo")?.bundled === true &&
    manifest.sampledFrames === FRAMES
);

// ---- 2. emitted timeline == the producer, every frame ------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skia-scene-export-"));
try {
  for (const [f, text] of Object.entries(files)) {
    if (f.includes("/")) continue;
    fs.writeFileSync(path.join(tmp, f), text);
  }
  const emitted = await import(pathToFileURL(path.join(tmp, "timeline.ts")).href);
  const effects = await import(pathToFileURL(path.join(tmp, "effects.ts")).href);
  let mismatch = "";
  let compared = 0;
  for (let f = 0; f < FRAMES && !mismatch; f++) {
    const sc = sampler.sampleAt(f * TL.ticksPerFrame)!;
    const byPath = new Map(collectBinds(sc.root).map((fb) => [fb.path, fb.bind.v]));
    const out = emitted.sampleBinds(f / TL.fps);
    for (const b of manifest.binds) {
      const want = byPath.get(b.path);
      const got = b.role === "path" ? emitted.seriesStep(emitted[`PATH_${b.sample}`], f) : out[b.sample];
      compared++;
      if (!same(want, got)) {
        mismatch = `frame ${f} ${b.path}: producer ${JSON.stringify(want)?.slice(0, 80)} export ${JSON.stringify(got)?.slice(0, 80)}`;
        break;
      }
    }
  }
  check(`emitted sampleBinds / PATH_* == the producer's bound values (${manifest.binds.length} animated binds × ${FRAMES} frames, ${compared} reads)`, !mismatch, mismatch);
  check("the clock is seconds, also between frames", emitted.sampleBinds(0.0123)[manifest.binds.find((b: any) => b.kind === "clock").sample] === 0.0123);
  check("effects.ts carries each program verbatim", effects.SKSL_0 === fx.FILL_SKSL && effects.SKSL_1 === fx.INVERT_SKSL);

  // ---- 3. CanvasKit: compiles, uniforms == the bundle's ------------------------------------------
  const require = createRequire(path.join(ROOT, "package.json"));
  const CK = await require("canvaskit-wasm")();
  const programs: SkslProgramIR[] = [];
  const walk = (x: unknown) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      if (typeof o.sksl === "string" && o.uniforms) programs.push(o as unknown as SkslProgramIR);
      Object.values(o).forEach(walk);
    }
  };
  walk(scene0.root);
  for (const p of programs) {
    const eff = CK.RuntimeEffect.Make(p.sksl, (e: string) => console.log(`  CanvasKit: ${e}`));
    const declared = new Set<string>();
    if (eff) for (let i = 0; i < eff.getUniformCount(); i++) declared.add(eff.getUniformName(i));
    const supplied = Object.keys(p.uniforms);
    check(
      `program compiles in CanvasKit and declares exactly the bundle's uniforms (${supplied.join(", ")})`,
      !!eff && declared.size === supplied.length && supplied.every((u) => declared.has(u)),
      eff ? `declared ${[...declared]}` : "no effect"
    );
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- 4. refusals --------------------------------------------------------------------------------
const refuse = (mut: (n: GraphNode[], e: GraphEdge[]) => void) => {
  const gg = fx.sceneFixtureGraph();
  mut(gg.nodes, gg.edges);
  return exportSkia({ ...req, nodes: gg.nodes, edges: gg.edges });
};
const node = (n: GraphNode[], id: string) => n.find((x) => x.id === id)!;
const has = (r: { files: unknown; problems: string[] }, needle: string) => !r.files && r.problems.some((p) => p.includes(needle));
const kf = (frames: [number, unknown][], easingOut: any = "linear") => ({
  animated: true,
  trackVisible: true,
  keyframes: frames.map(([f, value]) => ({ tick: f * TL.ticksPerFrame, value, easingOut })),
});
{
  // Text with a width is a wrapped paragraph in the IR (scene-render draws
  // it so); until the <Paragraph> emitter lands, the export must refuse.
  const st = (v: number) => ({ v });
  const para: SkiaScene = {
    version: 1,
    width: 64,
    height: 64,
    assets: { inter: { id: "inter", kind: "font", mime: "font/ttf", url: "data:font/ttf;base64,AA==" } },
    root: {
      k: "text",
      text: { v: "wrap me" },
      font: { asset: "inter", size: st(12) },
      x: st(0),
      y: st(0),
      width: st(40),
      paint: { style: "fill" },
    },
  };
  const r = exportSkiaScene(para, [], [], { name: "para", timeline: TL, runtimeSource });
  check("refuses text with a width (a paragraph) until the Paragraph emitter lands", !r.files && r.problems.some((p) => p.includes("wrapped paragraph")), r.problems.join(" | "));
}
{
  const r = refuse((n, e) => {
    n.push({ id: "wob", type: "lfo", params: {} });
    e.find((x) => x.source === "av")!.source = "wob";
  });
  check("refuses a param driven by a non-keyframe node (LFO)", has(r, "driven by a lfo node"), r.problems.join(" | "));
}
{
  const r = refuse((n) => {
    node(n, "scene").animation!.tint = kf([[0, "#ff7a4580"], [60, "#1b2cff"]]);
  });
  check("refuses translucent color keys", has(r, "carry alpha"), r.problems.join(" | "));
}
{
  const r = refuse((n) => {
    node(n, "k").animation = { value: kf([[0, 0.5], [30, 1]]) };
  });
  check("refuses a keyframed Constant driver", has(r, "Constant snaps"), r.problems.join(" | "));
}
{
  const r = refuse((n, e) => {
    n.push({ id: "clk", type: "constant", params: { value: 10 } });
    e.push({ id: "c", source: "clk", sourceHandle: "out:primary", target: "av", targetHandle: "in:time" });
  });
  check("refuses an Animated Value on a wired clock", has(r, "only an unwired clock exports"), r.problems.join(" | "));
}
{
  const r = refuse((n) => {
    node(n, "scene").animation!.extra = kf([[0, false], [30, true]], "hold");
  });
  check("refuses structure that changes over time (a child appears at frame 30)", has(r, "structure changes at frame 30"), r.problems.join(" | "));
}
{
  const r = refuse((n) => {
    node(n, "scene").clips = [{ inTick: 0, outTick: 30_000, sourceInTick: 0, enabled: true }];
  });
  check("refuses refs into a clipped node", has(r, "clip window"), r.problems.join(" | "));
}
{
  const r = refuse((n) => {
    n.push({ id: "lay", type: "layer", params: {}, clips: [{ inTick: 10_000, outTick: 60_000, sourceInTick: 0, enabled: true }] });
    node(n, "scene").parentId = "lay";
  });
  check("refuses refs inside a layer whose clip shifts local time", has(r, "shifts its local time"), r.problems.join(" | "));
}
{
  const r = exportSkia({ ...req, edges: g.edges.filter((e) => e.target !== g.canvasId) });
  check("refuses a Skia Canvas with nothing wired", has(r, "Nothing is wired"), r.problems.join(" | "));
}
// Plan-level refusals on hand-written IR.
const sceneOf = (root: SkiaNode, assets: SkiaScene["assets"] = {}): SkiaScene => ({ version: 1, width: 64, height: 64, root, assets });
const planOf = (scene: SkiaScene, nodes: GraphNode[] = [], edges: GraphEdge[] = [], sampleAt?: (t: number) => SkiaScene | null) =>
  planSceneExport(scene, nodes, edges, { name: "t", timeline: TL, sampleAt });
const circle = (r: Bind<number>): SkiaNode => ({ k: "shape", geom: { k: "circle", cx: s(1), cy: s(1), r }, paint: { style: "fill" } });
{
  const p = planOf(sceneOf(circle({ v: 3, ref: { node: "ghost", param: "r" } })));
  check("refuses a ref to a node that is not in the graph", p.problems.some((x) => x.includes('"ghost" is not in the graph')), p.problems.join(" | "));
}
{
  const gg = fx.sceneFixtureGraph();
  const p = planOf(sceneOf(circle({ v: 3, deps: [{ node: "scene", param: "spin" }] })), gg.nodes, gg.edges);
  check("refuses a bind derived from animated params when there is no sampler", p.problems.some((x) => x.includes("needs a per-frame sampler")), p.problems.join(" | "));
}
{
  const gg = fx.sceneFixtureGraph();
  node(gg.nodes, "scene").exposedParams!.push("center");
  gg.edges.push({ id: "v", source: "av", sourceHandle: "out:primary", target: "scene", targetHandle: "in:param:center" });
  const whole = planOf(sceneOf({ k: "shape", geom: { k: "points", pts: { v: [1, 2], ref: { node: "scene", param: "center" } }, mode: "points" }, paint: { style: "fill" } }), gg.nodes, gg.edges);
  check("refuses a whole wired vector (bind components)", whole.problems.some((x) => x.includes("bind one component")), whole.problems.join(" | "));
  const comp = planOf(sceneOf(circle({ v: 2, ref: { node: "scene", param: "center", component: 1 } })), gg.nodes, gg.edges);
  check("a vec component wired from Animated Value broadcasts → track", comp.binds.find((b) => b.path === "root.geom.r")?.plan.kind === "track", comp.problems.join(" | "));
}
{
  const p = planOf(
    sceneOf({
      k: "group",
      clip: { geom: { k: "line", p1: [s(0), s(0)], p2: [s(1), s(1)] } },
      layer: { imageFilters: [{ k: "runtime", program: { sksl: fx.INVERT_SKSL, uniforms: { amount: s(1) }, children: [{ name: "x", shader: { k: "color", color: s([1, 1, 1, 1]) } }] }, content: "content" }] },
      children: [
        { k: "image", asset: "nope", x: s(0), y: s(0), w: s(1), h: s(1), fit: "fill" },
        { k: "image", asset: "vec", x: s(0), y: s(0), w: s(1), h: s(1), fit: "fill" },
      ],
    }, { vec: { id: "vec", kind: "svg", mime: "image/svg+xml", url: "x.svg" } })
  );
  check("refuses a line clip", p.problems.some((x) => x.includes("no area to clip")), p.problems.join(" | "));
  check("refuses extra child shaders on a RuntimeShader filter", p.problems.some((x) => x.includes("extra child shaders")));
  check("refuses an asset the scene does not list", p.problems.some((x) => x.includes('"nope", which the scene does not list')));
  check("refuses SVG image assets (not yet)", p.problems.some((x) => x.includes("SVG assets don't export yet")));
}
{
  // A sampler that disappears mid-scene.
  const sc = sceneOf(circle(s(2)));
  const p = planOf(sc, [], [], (t) => (t < 10_000 ? sc : null));
  check("refuses a scene that stops reaching the canvas", p.problems.some((x) => x.includes("Nothing reaches the canvas at frame 10")), p.problems.join(" | "));
}

// ---- 5. expression channels (ch:<name>) --------------------------------------------------------
{
  const src = `// ch("amount", 0.5, 0, 1)\n// color("ink", "#ff8800")\n// toggle("on", true)\nhalf4 main(float2 p) { return half4(ink.rgb * amount, 1); }`;
  const inputs = syncChannelInputs([], src) as any[];
  const id = (name: string) => inputs.find((r) => r.name === name).id;
  const gg = fx.sceneFixtureGraph();
  gg.nodes.push({ id: "sk", type: "sksl-shader", params: { expression: src, inputs } });
  gg.edges.push(
    { id: "c1", source: "av", sourceHandle: "out:primary", target: "sk", targetHandle: `in:in:${id("amount")}` },
    { id: "c2", source: "col", sourceHandle: "out:primary", target: "sk", targetHandle: `in:in:${id("ink")}` }
  );
  const prog = (u: Record<string, Bind<number | number[]>>): SkiaNode => ({ k: "fill", paint: { style: "fill", shader: { k: "runtime", program: { sksl: "x", uniforms: u, children: [] } } } });
  const p = planOf(
    sceneOf(
      prog({
        amount: { v: 2, ref: { node: "sk", param: "ch:amount" } },
        ink: { v: [0.2, 0.333, 1, 1], ref: { node: "sk", param: "ch:ink" } },
        on: { v: 1, ref: { node: "sk", param: "ch:on" } },
      })
    ),
    gg.nodes,
    gg.edges
  );
  const at = (u: string) => p.binds.find((b) => b.path === `root.paint.shader.program.uniforms.${u}`)?.plan as any;
  check("ch: scalar wired from Animated Value → scalar track", at("amount")?.kind === "track" && at("amount").tracks[0].kind === "scalar", JSON.stringify(at("amount")));
  check(
    "ch: color wired from Color → quantised color track with the node's alpha",
    at("ink")?.kind === "track" && at("ink").tracks[0].quantize8 === true && at("ink").tracks[0].colorSpace === "rgb",
    JSON.stringify(at("ink"))?.slice(0, 120)
  );
  check("ch: unwired channel → static", at("on")?.kind === "static");
  const missing = planOf(sceneOf(prog({ x: { v: 1, ref: { node: "sk", param: "ch:nope" } } })), gg.nodes, gg.edges);
  check("refuses a ch: ref to a channel the node lacks", missing.problems.some((x) => x.includes('channel "nope"')));
  gg.nodes.push({ id: "wob", type: "lfo", params: {} });
  gg.edges.find((e) => e.id === "c1")!.source = "wob";
  const lfo = planOf(sceneOf(prog({ amount: { v: 2, ref: { node: "sk", param: "ch:amount" } } })), gg.nodes, gg.edges);
  check("refuses a ch: channel driven by an LFO", lfo.problems.some((x) => x.includes("driven by a lfo")), lfo.problems.join(" | "));
}

// ---- 6. snapshots ---------------------------------------------------------------------------------
const staticFx = fx.staticSceneFixture();
const staticRes = exportSkiaScene(staticFx.scene, [], [], { name: "Static fixture", timeline: TL, runtimeSource });
check("a scene with nothing animated exports, and never reads the clock", !!staticRes.files && !staticRes.files["ToolboxScene.tsx"].includes("sampleBinds(time.value)"), staticRes.problems.join(" | "));
const SNAP = path.join(ROOT, "scripts/fixtures/skia/snapshots");
function readTree(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) Object.assign(out, readTree(p, base));
    else out[path.relative(base, p).replace(/\.snap$/, "")] = fs.readFileSync(p, "utf8");
  }
  return out;
}
function snapshot(name: string, got: Record<string, string>) {
  const dir = path.join(SNAP, name);
  // The runtime ships verbatim (checked above); don't pin it twice.
  const want = Object.fromEntries(Object.entries(got).filter(([f]) => f !== "toolbox-timeline.ts"));
  if (UPDATE) {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [f, text] of Object.entries(want)) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, `${f}.snap`), text);
    }
    console.log(`     updated snapshots/${name} (${Object.keys(want).length} files)`);
    return;
  }
  const have = readTree(dir);
  const names = [...new Set([...Object.keys(have), ...Object.keys(want)])].sort();
  let drift = "";
  for (const f of names) {
    if (!(f in have)) drift ||= `${f} is new (run with --update)`;
    else if (!(f in want)) drift ||= `${f} is no longer emitted`;
    else if (have[f] !== want[f]) {
      const a = have[f].split("\n");
      const b = want[f].split("\n");
      const i = a.findIndex((l, k) => l !== b[k]);
      drift ||= `${f}:${i + 1}\n       snapshot: ${a[i]?.slice(0, 120)}\n       emitted:  ${b[i]?.slice(0, 120)}`;
    }
  }
  check(`emitted files match snapshots/${name} (${names.length} files)`, !drift, drift ? `${drift}\n       (npx tsx scripts/check-skia-scene-export.mts --update after a deliberate change)` : "");
}
snapshot("scene", files);
if (staticRes.files) snapshot("static", staticRes.files);

// ---- 7. the CLI ------------------------------------------------------------------------------------
{
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "skia-scene-cli-"));
  try {
    const tsx = path.join(ROOT, "node_modules/.bin/tsx");
    execFileSync(tsx, ["scripts/export-skia.mts", "--fixture", "scene", "--out", path.join(out, "a")], { cwd: ROOT, stdio: "pipe" });
    const bad = Object.entries(files).find(([f, text]) =>
      f.endsWith(".b64")
        ? !fs.readFileSync(path.join(out, "a", f.slice(0, -4))).equals(Buffer.from(text, "base64"))
        : fs.readFileSync(path.join(out, "a", f), "utf8") !== text
    );
    check("export-skia --fixture scene writes the same bundle (assets decoded)", !bad, bad?.[0]);
    const ir = path.join(out, "static.json");
    fs.writeFileSync(ir, JSON.stringify({ scene: staticFx.scene, timeline: TL, name: "Static fixture" }));
    execFileSync(tsx, ["scripts/export-skia.mts", "--scene", ir, "--out", path.join(out, "b")], { cwd: ROOT, stdio: "pipe" });
    const bad2 = Object.entries(staticRes.files ?? {}).find(([f, text]) => fs.readFileSync(path.join(out, "b", f), "utf8") !== text);
    check("export-skia --scene ir.json writes exportSkiaScene's bundle", !!staticRes.files && !bad2, bad2?.[0]);
  } catch (e) {
    check("export-skia CLI runs", false, String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 400));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

// ---- 8. the bundles type-check in skia-harness ------------------------------------------------------
{
  const harness = path.join(ROOT, "skia-harness");
  const dir = path.join(harness, "src", "__scene_check__");
  if (!fs.existsSync(path.join(harness, "node_modules", "react-native-skia"))) {
    // CI's `npm ci` installs the root only; the harness is its own Expo app.
    if (process.env.SKIA_HARNESS_REQUIRED) check("skia-harness has node_modules (npm --prefix skia-harness install)", false);
    else console.log("skip emitted bundles type-check in skia-harness — skia-harness/node_modules is not installed (npm --prefix skia-harness install; SKIA_HARNESS_REQUIRED=1 makes this a failure)");
  } else {
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      for (const [name, bundle] of [["scene", files], ["static", staticRes.files ?? {}]] as const) {
        for (const [f, text] of Object.entries(bundle)) {
          if (f.endsWith(".b64")) continue;
          fs.mkdirSync(path.dirname(path.join(dir, name, f)), { recursive: true });
          fs.writeFileSync(path.join(dir, name, f), text);
        }
      }
      // The harness's own pinned TypeScript when installed (what the app
      // builds with), else the root one.
      const own = path.join(harness, "node_modules", ".bin", "tsc");
      const [cmd, args] = fs.existsSync(own) ? [own, ["--noEmit", "-p", harness]] : ["npx", ["tsc", "--noEmit", "-p", harness]];
      const t0 = Date.now();
      let output = "";
      let ok = true;
      try {
        execFileSync(cmd, args, { cwd: ROOT, stdio: "pipe" });
      } catch (e) {
        ok = false;
        output = String((e as { stdout?: Buffer }).stdout ?? e);
      }
      check(
        `emitted bundles type-check in skia-harness (react-native-skia 3.4.0, Reanimated 4.7; ${((Date.now() - t0) / 1000).toFixed(1)}s)`,
        ok,
        output.split("\n").filter((l) => l.includes("__scene_check__") || l.includes("error")).slice(0, 12).join("\n       ")
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
