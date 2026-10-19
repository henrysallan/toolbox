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
import { snapshotDrift } from "./skia/snapshot-diff.ts";
import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type { Bind, SkiaNode, SkiaScene, SkslProgramIR } from "@/engine/skia/scene-ir";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UPDATE = process.argv.includes("--update");

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { syncChannelInputs } = await import("@/engine/expr-channels");
const { exportSkia, exportSkiaScene, makeSceneSampler, planSceneExport } = await import("@/lib/skia-export");
const { closeValue, collectBinds, skslDeclarations } = await import("@/lib/skia-export/scene-plan");
const { hexToRgba01 } = await import("@/engine/spline-fill");
const { svgPathSignature } = await import("@/lib/skia-export/scene-emit");
const { GRADIENT_PROGRAM_MARKER, lowerSceneGradients } = await import("@/engine/skia/library/gradient-program");
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
const sampler = makeSceneSampler(g.nodes, g.edges, g.canvasId, fx.SCENE_CANVAS, TL, hexToRgba01("#10203080") as [number, number, number, number]);
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
  // (gradients plan as their color-managed programs: a stop color is a uniform)
  ["root.children.0.paint.shader.program.children.0.shader.program.uniforms.tbx_g_c0", "track", "gradient stop color wired from a keyframed Color → track"],
  ["root.children.1.transform.translate.0", "track", "vec2 component (customBezier keys) → scalar track"],
  ["root.children.1.transform.translate.1", "track", "vec2 component → scalar track"],
  ["root.children.1.transform.rotate", "track", "degrees param bound as radians (BindRef.scale) → scaled track"],
  ["root.children.2.children.6.geom.d", "sampled", "deps: [] → the producer's wires animate → sampled, no warning"],
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
check("deps: [] resolved through the producer's wires raises no warning", !res.warnings.some((w) => w.includes("children.2.children.6")));
const rot = plan("root.children.1.transform.rotate") as any;
check(
  "a scaled ref exports the raw keys with the track's scale (the runtime multiplies)",
  rot?.tracks?.[0]?.scale === Math.PI / 180 && rot.tracks[0].keys[1].value === Math.PI && files["timeline.ts"].includes(`"scale":${Math.PI / 180}`)
);
check(
  "Skia Group's (deg · π) / 180 rounding still verifies as a track (within an ulp), not a sampled fallback",
  kindOf("root.children.12.transform.rotate") === "track" && !res.warnings.some((w) => w.includes("children.12"))
);
check(
  "manifest flags RN-web-unplayable features (runtime image filter, composed path effects)",
  JSON.parse(files["manifest.json"]).webPlayable === false &&
    res.warnings.some((w) => w.includes("runtime image filter") && w.includes("not playable on React Native Skia web")) &&
    res.warnings.some((w) => w.includes("composed path effects (dash → corner)"))
);
{
  const tsx = files["ToolboxScene.tsx"];
  check(
    "text with a width → <Paragraph> (top-left, aligned in the width); without → <Text> anchored by its advance",
    /<Paragraph paragraph=\{D\d+\} x=\{156\} y=\{420\} width=\{200\} \/>/.test(tsx) &&
      tsx.includes("makeParagraph(FONTS") &&
      tsx.includes("TextAlign.Center") &&
      /500 - textAdvance\(/.test(tsx)
  );
  check("several trims compose into one interval", tsx.includes("trimSpan([0, 0.75, 0.2, 1], 0)") && tsx.includes("trimSpan([0, 0.75, 0.2, 1], 1)"));
  check("a trimmed open polyline draws as its open path", tsx.includes("Skia.Path.Polygon(toPoints([40, 10, 60, 30, 80, 10]), false)"));
  check("the canvas background ships as the first fill", tsx.includes(`<Fill color={${JSON.stringify(hexToRgba01("#10203080")).replace(/,/g, ", ")}} />`));
}
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
check(
  "every gradient ships as its color-managed program (gradient-program.ts), never as an RN gradient component (Skia interpolates those in the canvas's working space — shifted on Display P3)",
  !/<(LinearGradient|RadialGradient|SweepGradient|TwoPointConicalGradient)\b/.test(files["ToolboxScene.tsx"]) && files["effects.ts"].includes("Generated by toolbox (engine/skia/library/gradient-program.ts): a linear gradient, 2 stops, tile clamp.")
);
const manifest = JSON.parse(files["manifest.json"]);
check(
  "manifest: format 3, kind scene, non-bundled assets keep their URL",
  manifest.format === 3 &&
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
    const sc = lowerSceneGradients(sampler.sampleAt(f * TL.ticksPerFrame)!);
    const byPath = new Map(collectBinds(sc.root).map((fb) => [fb.path, fb.bind.v]));
    const out = emitted.sampleBinds(f / TL.fps);
    for (const b of manifest.binds) {
      const want = byPath.get(b.path);
      const got = b.role === "path" ? emitted.seriesStep(emitted[`PATH_${b.sample}`], f) : out[b.sample];
      compared++;
      if (!(b.scale !== undefined ? closeValue(want, got) : same(want, got))) {
        mismatch = `frame ${f} ${b.path}: producer ${JSON.stringify(want)?.slice(0, 80)} export ${JSON.stringify(got)?.slice(0, 80)}`;
        break;
      }
    }
  }
  check(`emitted sampleBinds / PATH_* == the producer's bound values (${manifest.binds.length} animated binds × ${FRAMES} frames, ${compared} reads)`, !mismatch, mismatch);
  check("the clock is seconds, also between frames", emitted.sampleBinds(0.0123)[manifest.binds.find((b: any) => b.kind === "clock").sample] === 0.0123);
  {
    // Every program the planned (gradient-lowered) scene draws, verbatim and
    // once: the fixture's two plus one per gradient shape (kind × stops × tile).
    const want = new Set<string>();
    const walkP = (x: unknown) => {
      if (Array.isArray(x)) x.forEach(walkP);
      else if (x && typeof x === "object") {
        const o = x as Record<string, unknown>;
        if (typeof o.sksl === "string" && o.uniforms) want.add(o.sksl);
        Object.values(o).forEach(walkP);
      }
    };
    walkP(lowerSceneGradients(scene0).root);
    const shipped = Object.entries(effects).filter(([k]) => /^SKSL_\d+$/.test(k)).map(([, v]) => v as string);
    check(
      `effects.ts carries each program verbatim, once (${shipped.length}: the fixture's 2 + ${shipped.filter((x) => x.startsWith(GRADIENT_PROGRAM_MARKER)).length} gradient programs)`,
      effects.SKSL_0 === fx.FILL_SKSL && shipped.includes(fx.INVERT_SKSL) && shipped.length === want.size && new Set(shipped).size === shipped.length && shipped.every((x) => want.has(x))
    );
  }

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
  walk(lowerSceneGradients(scene0).root);
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

// ---- 3b. a static fused fill: iTime is declared but never read ------------------------
{
  // Nothing upstream animates, so the Skia Fill stays cached and its iTime
  // bind keeps frame 0's value — the planner must still ship it as the clock
  // (the program never reads it) without a "not the scene clock" warning.
  const e = (source: string, target: string, targetHandle: string) => ({ id: `${source}->${target}`, source, sourceHandle: "out:primary", target, targetHandle });
  const sn: GraphNode[] = [
    { id: "sn", type: "skia-noise", params: { type: "simplex", scale: 4 } },
    { id: "sf", type: "skia-fill", params: { color: "#ffffff", opacity: 1 } },
    { id: "sc", type: "skia-canvas", params: { background_on: false } },
  ];
  const se = [e("sn", "sf", "in:shader"), e("sf", "sc", "in:scene")];
  const r = exportSkia({ ...req, nodes: sn, edges: se, targetId: "sc", name: "static fill" });
  check("a static fused fill exports iTime as the clock with no warning", !!r.files && r.warnings.length === 0, [...r.problems, ...r.warnings].join(" | "));
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
  const r = refuse((n, e) => {
    n.push({ id: "sm", type: "smooth", params: {} });
    e.find((x) => x.source === "av")!.source = "sm";
  });
  check("refuses a param driven by a node that is neither a keyframe source nor a procedural driver (Smooth)", has(r, "driven by a smooth node"), r.problems.join(" | "));
  // Since Wave 3 lane P (spec §3.5e) an LFO compiles to a procedural driver.
  const l = refuse((n, e) => {
    n.push({ id: "wob", type: "lfo", params: {} });
    e.find((x) => x.source === "av")!.source = "wob";
  });
  check("a param driven by an LFO exports as a procedural driver (expr)", !!l.files && JSON.parse(l.files["manifest.json"]).bindCounts.expr >= 1, l.problems.join(" | ") || JSON.stringify(l.files && JSON.parse(l.files["manifest.json"]).bindCounts));
}
{
  const r = refuse((n) => {
    node(n, "scene").animation!.tint = kf([[0, "#ff7a4580"], [60, "#1b2cff"]]);
  });
  check("refuses translucent color keys", has(r, "carry alpha"), r.problems.join(" | "));
}
{
  // Since Wave 3 lane P (spec §3.5e): a keyframed Constant (snapped to its
  // step every frame) and an Animated Value on a wired clock compile to
  // procedural drivers, verified against the producer at every frame.
  const r = refuse((n) => {
    node(n, "k").animation = { value: kf([[0, 0.5], [30, 1]]) };
  });
  check("a keyframed Constant driver exports as a procedural driver (expr), not a track", !!r.files && JSON.parse(r.files["manifest.json"]).bindCounts.expr >= 1, r.problems.join(" | "));
}
{
  const r = refuse((n, e) => {
    n.push({ id: "clk", type: "constant", params: { value: 10 } });
    e.push({ id: "c", source: "clk", sourceHandle: "out:primary", target: "av", targetHandle: "in:time" });
  });
  check("an Animated Value on a wired clock exports as a procedural driver (its keys sampled at the clock)", !!r.files && JSON.parse(r.files["manifest.json"]).bindCounts.expr >= 1, r.problems.join(" | "));
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
  // The interior's keys are on the layer's local clock, which the export
  // plays from 0 (the editor's export action warns about the offset).
  check("a layer whose clip shifts local time still exports (local clock from 0)", !!r.files && JSON.stringify(r.files) === JSON.stringify(files), r.problems.join(" | "));
}
{
  const r = refuse((n) => {
    node(n, "scene").params.fail = true;
  });
  check("refuses when the producer reports problems (SkiaDrawValue.problems)", has(r, "asked to fail"), r.problems.join(" | "));
}
{
  const r = refuse((n) => {
    node(n, "canvas").animation = { background: kf([[0, "#000000"], [30, "#ffffff"]]) };
  });
  check("refuses an animated canvas background", has(r, "animated background"), r.problems.join(" | "));
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
  check(
    "a ch: channel driven by an LFO plans as a procedural driver (expr)",
    lfo.binds.find((b: any) => b.path.endsWith("uniforms.amount"))?.plan.kind === "expr",
    lfo.problems.join(" | ")
  );
  gg.nodes.push({ id: "sm", type: "smooth", params: {} });
  gg.edges.find((e) => e.id === "c1")!.source = "sm";
  const sm = planOf(sceneOf(prog({ amount: { v: 2, ref: { node: "sk", param: "ch:amount" } } })), gg.nodes, gg.edges);
  check("refuses a ch: channel driven by a Smooth (neither a keyframe source nor a procedural driver)", sm.problems.some((x) => x.includes("driven by a smooth")), sm.problems.join(" | "));

  // Lane L4: keyframes on the channel itself (`ch:<name>` on the node).
  const own = fx.sceneFixtureGraph();
  own.nodes.push({
    id: "sk2",
    type: "sksl-shader",
    params: { expression: src, inputs },
    animation: {
      "ch:amount": kf([[0, 0.25], [30, 0.75]], "easeInOutCubic"),
      "ch:ink": kf([[0, "#ff000080"], [30, "#0000ffff"]], "linear"),
      "ch:on": kf([[0, true], [20, false]], "linear"),
    },
  });
  const ownPlan = planOf(
    sceneOf(
      prog({
        amount: { v: 0.25, ref: { node: "sk2", param: "ch:amount" } },
        ink: { v: [1, 0, 0, 0.5], ref: { node: "sk2", param: "ch:ink" } },
        on: { v: 1, ref: { node: "sk2", param: "ch:on" } },
      })
    ),
    own.nodes,
    own.edges
  );
  const ownAt = (u: string) => ownPlan.binds.find((b) => b.path === `root.paint.shader.program.uniforms.${u}`)?.plan as any;
  check(
    "ch: scalar keyframes → scalar track",
    ownAt("amount")?.kind === "track" && ownAt("amount").tracks[0].kind === "scalar" && JSON.stringify(ownAt("amount").tracks[0].keys.map((k: any) => k.value)) === "[0.25,0.75]"
  );
  check(
    "ch: color keyframes → quantize8 + quantizeAlpha track (the row's hex keeps alpha)",
    ownAt("ink")?.tracks?.[0]?.quantize8 === true && ownAt("ink").tracks[0].quantizeAlpha === true && ownAt("ink").tracks[0].keys[0].value[3] === 128 / 255
  );
  check("ch: toggle keyframes → stepped 1 / 0", JSON.stringify(ownAt("on")?.tracks?.[0]?.keys.map((k: any) => [k.value, k.easing])) === '[[1,"hold"],[0,"hold"]]');
}

// ---- 5b. provenance the graph resolves ------------------------------------------------------------
{
  const gg = fx.sceneFixtureGraph();
  // `deps: []` with a still producer → static; with no producer named → needs the sampler.
  gg.nodes.push({ id: "still", type: "constant", params: { value: 1 } }, { id: "shp", type: "constant", params: { value: 2 } });
  gg.edges.push({ id: "s1", source: "still", sourceHandle: "out:primary", target: "shp", targetHandle: "in:x" });
  const pathNode = (id?: string): SkiaNode => ({ k: "shape", ...(id ? { id } : {}), geom: { k: "path", d: { v: "M0 0L1 1", deps: [] } }, paint: { style: "stroke" } });
  const still = planOf(sceneOf(pathNode("shp")), gg.nodes, gg.edges);
  check("deps: [] over a still upstream → static", still.binds[0]?.plan.kind === "static", JSON.stringify(still.binds[0]?.plan));
  gg.nodes.find((n) => n.id === "still")!.animation = { value: kf([[0, 1], [10, 2]]) };
  const moving = planOf(sceneOf(pathNode("shp")), gg.nodes, gg.edges);
  check("deps: [] over a keyframed upstream, no sampler → refused (needs the sampler)", moving.problems.some((p) => p.includes("still is keyframed") && p.includes("per-frame sampler")), moving.problems.join(" | "));
  const anon = planOf(sceneOf(pathNode()), gg.nodes, gg.edges);
  check("deps: [] with no producer id, no sampler → refused", anon.problems.some((p) => p.includes("names no producer")), anon.problems.join(" | "));

  // L2's Skia Color Ramp: stops derived from `stops`, animated per stop
  // through virtual keys (ramp_c: / ramp_a: / ramp_p:).
  gg.nodes.push({ id: "ramp", type: "constant", params: { stops: [] } });
  const stopsBind = (): SkiaNode => ({
    k: "fill",
    paint: { style: "fill", shader: { k: "runtime", program: { sksl: "uniform float n[4];\nhalf4 main(float2 p){return half4(n[0]);}", uniforms: { n: { v: [0, 0, 0, 0], deps: [{ node: "ramp", param: "stops" }] } }, children: [] } } },
  });
  check("ramp stops with no stop keys → static", planOf(sceneOf(stopsBind()), gg.nodes, gg.edges).binds[0]?.plan.kind === "static");
  gg.nodes.find((n) => n.id === "ramp")!.animation = { "ramp_c:stops:s1": kf([[0, "#000000"], [10, "#ffffff"]]) };
  const rp = planOf(sceneOf(stopsBind()), gg.nodes, gg.edges);
  check("a keyframed ramp stop (ramp_c:stops:<id>) animates `stops`", rp.problems.some((p) => p.includes("ramp.stops") && p.includes("per-frame sampler")), rp.problems.join(" | "));

  // Step-only params: the producer uploads 0 | 1 / the option index.
  const sc = fx.sceneFixtureGraph();
  node(sc.nodes, "scene").animation!.mode = kf([[0, "soft"], [10, "wild"], [20, "hard"]], "linear");
  node(sc.nodes, "scene").animation!.extra = kf([[0, false], [10, true]], "linear");
  const step = planOf(
    sceneOf({
      k: "group",
      children: [circle({ v: 0, ref: { node: "scene", param: "mode" } }), circle({ v: 0, ref: { node: "scene", param: "extra" } })],
    }),
    sc.nodes,
    sc.edges
  );
  const keysOf = (i: number) => JSON.stringify((step.binds[3 * i + 2]?.plan as any)?.tracks?.[0]?.keys.map((k: any) => [k.value, k.easing]));
  check("a keyframed enum param → stepped option indices", keysOf(0) === '[[0,"hold"],[2,"hold"],[1,"hold"]]', keysOf(0));
  check("a keyframed boolean param → stepped 0 / 1", keysOf(1) === '[[0,"hold"],[1,"hold"]]', keysOf(1));

  // A color param with ParamDef.alpha replays translucent keys exactly
  // (quantizeAlpha): the hex round trip, alpha byte included.
  node(sc.nodes, "scene").animation!.ink = kf([[0, "#ff000040"], [30, "#00ff80ff"], [60, "#2040ffc0"]], "easeInOutQuad");
  const ink = planOf(sceneOf(circle({ v: 0, ref: { node: "scene", param: "ink", component: 3 } })), sc.nodes, sc.edges).binds.find((b) => b.path === "root.geom.r")?.plan as any;
  const { evaluateKeyframesAt } = await import("@/engine/keyframes");
  const { colorValueToHex } = await import("@/engine/conventions");
  const { evaluateTrackPlan } = await import("@/lib/skia-export/scene-plan");
  let inkBad = "";
  for (let t = 0; t <= 60_000 && !inkBad; t += 250) {
    const hex = colorValueToHex(evaluateKeyframesAt(node(sc.nodes, "scene").animation!.ink, "color", t), "#ffffff", true);
    const want = hexToRgba01(hex)[3];
    const got = evaluateTrackPlan(ink, t);
    if (!Object.is(want, got)) inkBad = `tick ${t}: hex ${hex} → ${want}, track ${got}`;
  }
  check("a ParamDef.alpha color param's translucent keys → quantizeAlpha track, bit-identical alpha", ink?.kind === "track" && ink.tracks[0].quantizeAlpha === true && !inkBad, inkBad || JSON.stringify(ink)?.slice(0, 100));
}

// ---- 5c. programs must bind every declared uniform and child -----------------------------------
{
  check(
    "skslDeclarations reads uniforms (layout, arrays) and children in order",
    JSON.stringify(skslDeclarations("// uniform float nope;\nuniform float3 iResolution;\nlayout(color) uniform float4 c[16];\nuniform shader a;\nuniform shader b;\nuniform int k;")) ===
      JSON.stringify({ uniforms: ["iResolution", "c", "k"], children: ["a", "b"] })
  );
  const p = planOf(
    sceneOf({
      k: "fill",
      paint: { style: "fill", shader: { k: "runtime", program: { sksl: "uniform float a;\nuniform float b;\nuniform shader s;\nhalf4 main(float2 p){return half4(a+b);}", uniforms: { a: s(1) }, children: [] } } },
    })
  );
  check("refuses a declared uniform with no bind (RN throws)", p.problems.some((x) => x.includes("declares uniform b with no bind")), p.problems.join(" | "));
  check("refuses declared children that don't match the bound ones", p.problems.some((x) => x.includes("child shaders (s) but binds (none)")));
  const para = planOf(
    sceneOf(
      { k: "text", text: s("hi"), font: { asset: "f", size: s(12) }, x: s(0), y: s(0), width: s(40), paint: { style: "fill", shader: { k: "color", color: s([1, 1, 1, 1]) } } },
      { f: { id: "f", kind: "font", mime: "font/ttf", url: "x.ttf" } }
    )
  );
  check("refuses a Paragraph whose paint needs more than color + opacity", para.problems.some((x) => x.includes("exports as a Paragraph")), para.problems.join(" | "));
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
    // Text exact, numbers to 1e-12: raw doubles differ in the last ulp
    // between V8 builds (snapshots written on macOS, CI on Linux).
    else drift ||= snapshotDrift(f, have[f], want[f]);
  }
  check(`emitted files match snapshots/${name} (${names.length} files)`, !drift, drift ? `${drift}\n       (npx tsx scripts/check-skia-scene-export.mts --update after a deliberate change)` : "");
}
{
  // The tolerant compare itself (scripts/skia/snapshot-diff.ts): a last-ulp
  // nudge of a sampled double passes; a real value change, a toFixed(3)
  // rounding flip and a text change all still fail.
  const { sameUpToFloatNoise } = await import("./skia/snapshot-diff.ts");
  const x = 0.5403023058681398;
  const nudged = x + Number.EPSILON * x;
  const line = (v: number, t = 401.047) => `const S: Series<number[]> = {"v":[[${v},0.8414709848078965,100,${t}]]};`;
  check(
    "snapshot compare: float noise passes, real changes fail",
    nudged !== x &&
      sameUpToFloatNoise(line(x), line(nudged)) &&
      !sameUpToFloatNoise(line(x), line(x + 1e-6)) &&
      !sameUpToFloatNoise(line(x), line(x, 401.048)) &&
      !sameUpToFloatNoise(line(x), line(x).replace("Series", "Track")),
    `${x} vs ${nudged}`
  );
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
