// check-skia-export: the SkSL Shader → React Native Skia export gate
// (specdocs/101326_skia-target.md). No GPU, no device:
//
//   1. the worklet runtime (src/lib/skia-export/runtime/toolbox-timeline.ts)
//      returns the SAME doubles as engine/keyframes.ts for every easing
//      preset, cubicBezier, customBezier, hold and both color spaces, and
//      matches the Color node's hex round trip bit for bit;
//   2. the Aurora fixture exports, and the emitted timeline.ts reproduces
//      what the real evaluator feeds the SkSL node at every frame;
//   2b. channels keyframed ON the node (`ch:<name>` tracks — scalar, toggle,
//      pick, color with keyed alpha, both color spaces) export as tracks
//      whose emitted values are bit-identical to the uniforms the evaluator
//      delivers to the node at every frame; a wire still wins (and warns);
//      unreplayable keys are refused;
//   3. the emitted program compiles in CanvasKit (Node) and declares exactly
//      the uniforms sampleUniforms() supplies — no missing, no extra;
//   4. the planner refuses what M0 cannot ship (wired images, foreign
//      drivers, keyframed Constant, ramp channels) instead of exporting it;
//   5. prelude + lint rules (toggles → int, colors → layout(color), children
//      only when referenced, `uniform` lines rejected) and the recipe
//      builder's channel-by-name wiring for channelSync nodes.
//
//   npx tsx scripts/check-skia-export.mts

/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { getNodeDef } = await import("@/engine/registry");
const { evaluateGraph } = await import("@/engine/evaluator");
const { evaluateKeyframesAt, EASING_PRESET_ORDER } = await import("@/engine/keyframes");
const { colorValueToHex } = await import("@/engine/conventions");
const { syncChannelInputs, readChannelValues } = await import("@/engine/expr-channels");
const { buildSkslProgram, channelUniformValues, compileSksl, lintSksl, userLineError } = await import("@/engine/skia/sksl-program");
const { planSkiaExport, emitSkiaBundle } = await import("@/lib/skia-export");
const rt = await import("@/lib/skia-export/runtime/toolbox-timeline");
const { toTimelineKey, hexToTuple } = await import("@/lib/skia-export/drivers");
const { buildRecipe } = await import("@/state/recipe-builder");
const fx = await import("./fixtures/skia/aurora.ts");
import type { EvalCache, GraphEdge, GraphNode } from "@/engine/evaluator";
import type { Keyframe, KeyframeAnimationBlock } from "@/engine/keyframes";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${!cond && detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}

const SPAN = 120_000;
const sampleTicks: number[] = [];
for (let t = -500; t <= SPAN * 2 + 500; t += 37) sampleTicks.push(t);
for (let f = 0; f <= 240; f++) sampleTicks.push(f * 1000);
sampleTicks.push(0.5, 999.999, 60_000.25, SPAN - 1e-7);

const blockOf = (keys: Keyframe[], colorSpace?: "oklab" | "rgb"): KeyframeAnimationBlock => ({
  animated: true,
  trackVisible: true,
  keyframes: keys,
  ...(colorSpace ? { colorSpace } : {}),
});

// ---- 1. runtime == engine ---------------------------------------------------
{
  const presets = [...EASING_PRESET_ORDER.filter((p) => p !== "customBezier"), "easeIn", "easeOut", "easeInOut", "cubicBezier"];
  let worst = 0;
  let worstAt = "";
  for (const p of presets) {
    const keys: Keyframe[] = [
      { tick: 0, value: -2, easingOut: p as any, ...(p === "cubicBezier" ? { bezier: { x1: 0.2, y1: 1.6, x2: 0.3, y2: -0.4 } } : {}) },
      { tick: SPAN, value: 5, easingOut: p as any, ...(p === "cubicBezier" ? { bezier: { x1: 0.9, y1: 0, x2: 0.1, y2: 1 } } : {}) },
      { tick: SPAN * 2, value: 1, easingOut: "linear" },
    ];
    const block = blockOf(keys);
    const track = { kind: "scalar" as const, keys: keys.map((k) => ({ tick: k.tick, value: k.value as number, easing: k.easingOut, ...(k.bezier ? { bezier: k.bezier } : {}) })) };
    for (const t of sampleTicks) {
      const a = evaluateKeyframesAt(block, "scalar", t) as number;
      const b = rt.evaluateTrack(track, t) as number;
      const d = Object.is(a, b) ? 0 : Math.abs(a - b) || Infinity;
      if (d > worst) {
        worst = d;
        worstAt = `${p} @${t}: engine ${a} runtime ${b}`;
      }
    }
  }
  check(`scalar runtime is bit-identical to evaluateKeyframesAt (${presets.length} easings × ${sampleTicks.length} ticks)`, worst === 0, worstAt);

  // customBezier with explicit and missing handles.
  const keys: Keyframe[] = [
    { tick: 0, value: 0, easingOut: "customBezier", bezierHandles: { rightHandle: { dx: 50_000, dy: 9 }, leftHandle: { dx: -1, dy: 0 } } },
    { tick: SPAN, value: 4, easingOut: "customBezier", bezierHandles: { rightHandle: { dx: 2_000, dy: -3 }, leftHandle: { dx: -70_000, dy: 2 } } },
    { tick: SPAN * 2, value: -1, easingOut: "customBezier" },
    { tick: SPAN * 3, value: 2, easingOut: "linear" },
  ];
  const track = {
    kind: "scalar" as const,
    keys: keys.map((k) => ({
      tick: k.tick,
      value: k.value as number,
      easing: k.easingOut,
      ...(k.bezierHandles ? { right: k.bezierHandles.rightHandle, left: k.bezierHandles.leftHandle } : {}),
    })),
  };
  const bad = sampleTicks
    .concat(sampleTicks.map((t) => t + SPAN))
    .find((t) => !Object.is(evaluateKeyframesAt(blockOf(keys), "scalar", t), rt.evaluateTrack(track, t)));
  check("customBezier (explicit + default handles) is bit-identical", bad === undefined, `first mismatch @${bad}`);

  // spring: Reanimated's withSpring as a time remap (engine/spring-easing.ts),
  // across under-damped / critical / ζ > 1 (Reanimated's critically damped
  // branch), several settle points, junk params, and fractional ticks — both
  // the raw key params (the runtime solves the rest time) and the exporter's
  // keys (toTimelineKey precomputes it).
  {
    const springs: (Keyframe["spring"] | undefined)[] = [
      undefined,
      { dampingRatio: 0.05 },
      { dampingRatio: 0.2, settle: 0.4 },
      { dampingRatio: 0.5, settle: 1 },
      { dampingRatio: 0.75, settle: 0.83 },
      { dampingRatio: 0.999 },
      { dampingRatio: 1 },
      { dampingRatio: 1, settle: 0.05 },
      { dampingRatio: 2.5, settle: 0.6 },
      { dampingRatio: 0.001, settle: 7 },
      { dampingRatio: Number.NaN, settle: -1 } as never,
    ];
    const ticks = sampleTicks.concat(sampleTicks.map((t) => t + 0.37), [1e-9, SPAN - 0.5, SPAN + 1e-6]);
    let bad = "";
    let n = 0;
    for (const spring of springs) {
      const keys: Keyframe[] = [
        { tick: 0, value: -2, easingOut: "spring", ...(spring ? { spring } : {}) },
        { tick: SPAN, value: 5, easingOut: "spring", spring: { dampingRatio: 0.3, settle: 0.7 } },
        { tick: SPAN * 2, value: 1, easingOut: "linear" },
      ];
      const raw = { kind: "scalar" as const, keys: keys.map((k) => ({ tick: k.tick, value: k.value as number, easing: k.easingOut, ...(k.spring ? { spring: k.spring as any } : {}) })) };
      const exported = { kind: "scalar" as const, keys: keys.map((k) => toTimelineKey(k, "scalar")) };
      for (const t of ticks) {
        const a = evaluateKeyframesAt(blockOf(keys), "scalar", t);
        const b = rt.evaluateTrack(raw, t);
        const c = rt.evaluateTrack(exported, t);
        n++;
        if (!Object.is(a, b) || !Object.is(a, c)) {
          bad ||= `${JSON.stringify(spring)} @${t}: engine ${a} runtime ${b} exported ${c}`;
        }
      }
    }
    check(`spring runtime (raw + exported keys) is bit-identical to evaluateKeyframesAt (${springs.length} configs, ${n} samples)`, !bad, bad);
    const springHex: Keyframe[] = [
      { tick: 0, value: "#ff7a45", easingOut: "spring", spring: { dampingRatio: 0.35 } },
      { tick: SPAN, value: "#1b2cff", easingOut: "linear" },
    ];
    const cBad = (["oklab", "rgb"] as const).find((space) => {
      const ct = { kind: "color" as const, colorSpace: space, keys: springHex.map((k) => toTimelineKey(k, "color")) };
      return sampleTicks.some((t) => {
        const a = evaluateKeyframesAt(blockOf(springHex, space), "color", t);
        const b = rt.evaluateTrackRaw(ct, t) as number[];
        const av = typeof a === "string" ? hexToTuple(a) : (a as number[]);
        return av.some((x, i) => !Object.is(x, b[i]));
      });
    });
    check("spring color tracks (OKLab + RGB) are bit-identical", cBad === undefined, `space ${cBad}`);
  }

  // Colors: raw interpolation in both spaces, then the Color node round trip.
  const hexKeys: Keyframe[] = [
    { tick: 0, value: "#ff7a45", easingOut: "easeInOutQuad" },
    { tick: SPAN, value: "#1b2cff", easingOut: "easeOutBack" },
    { tick: SPAN * 2, value: "#00ffa2", easingOut: "linear" },
  ];
  const tuple = (h: string) => {
    const n = parseInt(h.slice(1, 7), 16);
    return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255, 1];
  };
  const colorDef = getNodeDef("color-literal")!;
  for (const space of ["oklab", "rgb"] as const) {
    const ctrack = { kind: "color" as const, colorSpace: space, keys: hexKeys.map((k) => ({ tick: k.tick, value: tuple(k.value as string), easing: k.easingOut })) };
    const rawBad = sampleTicks.find((t) => {
      const a = evaluateKeyframesAt(blockOf(hexKeys, space), "color", t);
      const b = rt.evaluateTrackRaw(ctrack, t);
      const av = typeof a === "string" ? tuple(a) : (a as number[]);
      return av.some((x, i) => !Object.is(x, (b as number[])[i]));
    });
    check(`color (${space}) raw interpolation is bit-identical`, rawBad === undefined, `first mismatch @${rawBad}`);
    const qtrack = { ...ctrack, quantize8: true, alpha: 0.75 };
    const qBad = sampleTicks.find((t) => {
      const v = evaluateKeyframesAt(blockOf(hexKeys, space), "color", t);
      const hex = colorValueToHex(v, "#000000");
      const out = colorDef.compute({ inputs: {}, auxIn: {}, params: { color: hex, alpha: 0.75, count: 1 }, ctx: undefined as never, nodeId: "c" }) as any;
      const want = out.primary.value as number[];
      const got = rt.evaluateTrack(qtrack, t) as number[];
      return want.some((x, i) => !Object.is(x, got[i]));
    });
    check(`color (${space}) through the Color node's hex round trip is bit-identical`, qBad === undefined, `first mismatch @${qBad}`);
  }
  check(
    "ticksAt snaps frame-aligned seconds to exact ticks",
    [0, 7, 59, 240, 299].every((f) => rt.ticksAt(f / 60, 60, 1000) === f * 1000) && rt.ticksAt(0.0123, 60, 1000) === 0.0123 * 60 * 1000
  );
}

// ---- 2. Aurora: emitted timeline == the evaluator's feed ---------------------
const { nodes, edges, targetId } = fx.auroraGraph();
const { plan, problems } = planSkiaExport(nodes, edges, targetId, {
  name: "Aurora",
  canvas: { width: 512, height: 512 },
  timeline: fx.AURORA_TIMELINE,
});
check("Aurora fixture plans without problems", !!plan && problems.length === 0, problems.join(" | "));
if (!plan) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
check("4 of 11 uniforms are animated", plan.uniforms.length === 11 && plan.uniforms.filter((u) => u.track).length === 4);

const tmp = path.join(ROOT, "scripts", ".skia-export.tmp");
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
const runtimeSrc = fs.readFileSync(path.join(ROOT, "src/lib/skia-export/runtime/toolbox-timeline.ts"), "utf8");
const files = emitSkiaBundle(plan, runtimeSrc);
for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(tmp, f), text);
check(
  "bundle has effect / timeline / runtime / component / manifest / index",
  ["effect.ts", "timeline.ts", "toolbox-timeline.ts", "ToolboxEffect.tsx", "manifest.json", "index.ts"].every((f) => f in files)
);
check("runtime ships verbatim", files["toolbox-timeline.ts"] === runtimeSrc);
{
  // The worklets Babel plugin turns each "worklet" function into an object
  // that CAPTURES the functions it calls when it is created — at module
  // evaluation, in source order. A worklet calling a function declared
  // further down throws "Cannot access 'x' before initialization" on device
  // (and in the RN web harness), even though plain JS hoisting makes it work
  // in Node. So: every top-level function may call only functions above it.
  const decls = [...runtimeSrc.matchAll(/^(?:export )?function (\w+)\(/gm)].map((m) => ({ name: m[1], at: m.index! }));
  const late: string[] = [];
  decls.forEach((d, i) => {
    const body = runtimeSrc.slice(d.at, decls[i + 1]?.at ?? runtimeSrc.length);
    for (const later of decls.slice(i + 1)) {
      if (new RegExp(`\\b${later.name}\\s*\\(`).test(body)) late.push(`${d.name} → ${later.name}`);
    }
  });
  check("runtime worklets only call functions declared above them (worklets capture order)", late.length === 0, late.join(", "));
}
const emitted = await import(pathToFileURL(path.join(tmp, "timeline.ts")).href);

{
  const ctx: any = {
    gl: {}, width: 8, height: 8, time: 0, frame: 0, tick: 0, ticksPerFrame: 1000, fps: 60,
    playing: false, offline: false, cursor: { x: 0, y: 0, active: false }, state: {},
  };
  const drivers = nodes.filter((n) => n.type !== "sksl-shader");
  const chanRows = (nodes.find((n) => n.id === targetId)!.params.inputs as any[]);
  const byEdge = edges.map((e) => ({ src: e.source, name: chanRows.find((r) => e.targetHandle === `in:in:${r.id}`)!.name }));
  let mismatch = "";
  for (let f = 0; f <= 300 && !mismatch; f++) {
    ctx.tick = f * 1000;
    ctx.frame = f;
    ctx.time = f / 60;
    const r = evaluateGraph(drivers as GraphNode[], [] as GraphEdge[], ctx, new Map() as EvalCache, null, undefined, null, { extraTargets: drivers.map((d) => d.id) });
    const u = emitted.sampleUniforms(f / 60, 512, 512);
    for (const { src, name } of byEdge) {
      const v = r.outputs.get(src)?.primary as any;
      const want = v?.kind === "scalar" ? [v.value] : v?.value;
      const got = Array.isArray(u[name]) ? u[name] : [u[name]];
      if (!want || want.some((x: number, i: number) => !Object.is(x, got[i]))) {
        mismatch = `frame ${f} ${name}: evaluator ${JSON.stringify(want)} export ${JSON.stringify(got)}`;
        break;
      }
    }
  }
  check("emitted sampleUniforms == evaluator output for every driver, frames 0..300", !mismatch, mismatch);
}

// ---- 2b. channel keyframes on the node itself --------------------------------
// The SkSL node's own `ch:<name>` tracks (engine/channel-keyframes.ts). The
// evaluator side is the real evaluateGraph with the node's compute wrapped to
// capture the uniform values it would pack — channelUniformValues over
// readChannelValues, exactly the real compute's expression (the CanvasKit
// render itself needs a GPU and is not what's under test).
{
  const src = [
    `// ch("gain", 0.5, 0, 4)`,
    `// toggle("flip", false)`,
    `// pick("mode", "soft", "hard", "wild")`,
    `// color("tint", "#3d7bff")`,
    `// color("wash", "#ffffff")`,
    `// ch("still", 0.3)`,
    `// ch("wired", 1.0)`,
    `half4 main(float2 p) {`,
    `  float2 uv = p / iResolution.xy;`,
    `  float k = gain * (flip != 0 ? 1.0 - uv.x : uv.x) + still * wired + float(mode) * 0.1;`,
    `  float4 c = mix(tint, wash, clamp(k, 0.0, 1.0));`,
    `  return half4(float4(c.rgb * c.a, c.a));`,
    `}`,
  ].join("\n");
  const inputs = syncChannelInputs([], src);
  const id = (n: string) => inputs.find((r) => r.name === n)!.id;
  const blk = (keys: Keyframe[], colorSpace?: "oklab" | "rgb"): KeyframeAnimationBlock => blockOf(keys, colorSpace);
  const F = (f: number) => f * 1000;
  const chanGraph = () => {
    const nodes: GraphNode[] = [
      {
        id: "drv",
        type: "animated-value",
        params: { value: 0, unit: "frames" },
        animation: { value: blk([{ tick: 0, value: 0.5, easingOut: "easeInOutSine" }, { tick: F(300), value: 2, easingOut: "linear" }]) },
      },
      {
        id: "chk",
        type: "sksl-shader",
        params: { inputs, expression: src, on_error: "transparent" },
        animation: {
          "ch:gain": blk([
            { tick: 0, value: 0, easingOut: "easeOutBack" },
            { tick: F(60), value: 3, easingOut: "cubicBezier", bezier: { x1: 0.2, y1: 1.4, x2: 0.4, y2: -0.3 } },
            { tick: F(130), value: 1, easingOut: "customBezier", bezierHandles: { rightHandle: { dx: 20_000, dy: 2 }, leftHandle: { dx: -5_000, dy: 0 } } },
            { tick: F(200), value: 2.5, easingOut: "hold" },
            { tick: F(250), value: 0.75, easingOut: "easeOutElastic" },
            { tick: F(290), value: 1.25, easingOut: "linear" },
          ]),
          "ch:flip": blk([
            { tick: F(10), value: false, easingOut: "hold" },
            { tick: F(100), value: true, easingOut: "hold" },
            { tick: F(220), value: false, easingOut: "hold" },
          ]),
          "ch:mode": blk([
            { tick: 0, value: "soft", easingOut: "hold" },
            { tick: F(75), value: "wild", easingOut: "linear" },
            { tick: F(180), value: "hard", easingOut: "hold" },
          ]),
          "ch:tint": blk([
            { tick: 0, value: "#3d7bff", easingOut: "easeInOutCubic" },
            { tick: F(150), value: "#ff7a4580", easingOut: "easeOutBack" },
            { tick: F(300), value: [0.1, 0.9, 0.3, 1], easingOut: "linear" },
          ]),
          "ch:wash": blk(
            [
              { tick: F(20), value: "#00000000", easingOut: "easeInQuad" },
              { tick: F(280), value: "#ffffff", easingOut: "linear" },
            ],
            "rgb"
          ),
          // Shadowed by the wire below — the export must follow the wire.
          "ch:wired": blk([{ tick: 0, value: 9, easingOut: "linear" }, { tick: F(300), value: 7, easingOut: "linear" }]),
        },
      },
    ];
    const edges: GraphEdge[] = [{ id: "w", source: "drv", sourceHandle: "out:primary", target: "chk", targetHandle: `in:in:${id("wired")}` }];
    return { nodes, edges };
  };
  const g = chanGraph();
  const r = planSkiaExport(g.nodes, g.edges, "chk", { name: "Channels", canvas: { width: 64, height: 64 }, timeline: fx.AURORA_TIMELINE });
  check("channel-keyframe fixture plans without problems", !!r.plan && r.problems.length === 0, r.problems.join(" | "));
  if (r.plan) {
    const u = (n: string) => r.plan!.uniforms.find((x) => x.name === n)!;
    check(
      "own ch: tracks export as tracks; the static row stays static; the wire wins",
      ["gain", "flip", "mode", "tint", "wash"].every((n) => u(n).track && u(n).from.startsWith("channel keyframes")) &&
        u("still").value === 0.3 && !u("still").track && u("wired").from.startsWith("Animated Value drv")
    );
    check("a wired channel's own keyframes are reported as ignored", r.plan.warnings.some((w) => w.includes(`"wired"`) && w.includes("ignored")));
    check(
      "track shapes: scalar keys verbatim, toggle / pick as hold ints, colors 8-bit with keyed alpha",
      u("gain").track!.kind === "scalar" && u("gain").track!.keys.length === 6 &&
        u("flip").track!.keys.map((k) => `${k.value}/${k.easing}`).join() === "0/hold,1/hold,0/hold" &&
        u("mode").track!.keys.map((k) => `${k.value}/${k.easing}`).join() === "0/hold,2/hold,1/hold" &&
        u("tint").track!.quantize8 === true && u("tint").track!.quantizeAlpha === true && u("wash").track!.colorSpace === "rgb"
    );

    const dir = path.join(tmp, "channels");
    fs.mkdirSync(dir, { recursive: true });
    const chFiles = emitSkiaBundle(r.plan, runtimeSrc);
    for (const [f, text] of Object.entries(chFiles)) fs.writeFileSync(path.join(dir, f), text);
    const chEmitted = await import(pathToFileURL(path.join(dir, "timeline.ts")).href);

    const skDef = getNodeDef("sksl-shader")!;
    const realCompute = skDef.compute;
    let delivered: Record<string, number | number[]> = {};
    skDef.compute = ((args: any) => {
      const prog = buildSkslProgram(args.params);
      delivered = channelUniformValues(prog.channels, readChannelValues(prog.channels, args.inputs)) as Record<string, number | number[]>;
      return {};
    }) as any;
    const ctx: any = {
      gl: {}, width: 8, height: 8, time: 0, frame: 0, tick: 0, ticksPerFrame: 1000, fps: 60,
      playing: false, offline: false, cursor: { x: 0, y: 0, active: false }, state: {},
    };
    let mismatch = "";
    let alphaSeen = false;
    try {
      const cache: EvalCache = new Map();
      for (let f = 0; f <= 300 && !mismatch; f++) {
        ctx.tick = f * 1000;
        ctx.frame = f;
        ctx.time = f / 60;
        evaluateGraph(g.nodes, g.edges, ctx, cache, null, undefined, null, { extraTargets: ["chk"] });
        const got = chEmitted.sampleUniforms(f / 60, 64, 64);
        for (const name of ["gain", "flip", "mode", "tint", "wash", "still", "wired"]) {
          const want = ([] as number[]).concat(delivered[name] as number | number[]);
          const have = ([] as number[]).concat(got[name]);
          if (want.length === 0 || want.length !== have.length || want.some((x, i) => !Object.is(x, have[i]))) {
            mismatch = `frame ${f} ${name}: evaluator ${JSON.stringify(want)} export ${JSON.stringify(have)}`;
            break;
          }
          if (name === "tint" && want[3] > 0 && want[3] < 1) alphaSeen = true;
        }
      }
    } finally {
      skDef.compute = realCompute;
    }
    check("emitted channel tracks == the uniforms the evaluator delivers, every channel, frames 0..300 (bit-identical)", !mismatch, mismatch);
    check("…including a translucent keyed alpha on the color channel", alphaSeen);

    const require = createRequire(path.join(ROOT, "package.json"));
    const CKit = await require("canvaskit-wasm")();
    const c = compileSksl(CKit, r.plan.sksl);
    check("channel fixture compiles in CanvasKit", !!c.effect, c.error ? userLineError(c.error, r.plan.preludeLines) : "");
    if (c.effect) {
      const declared = new Set<string>();
      for (let i = 0; i < c.effect.getUniformCount(); i++) declared.add(c.effect.getUniformName(i));
      const supplied = Object.keys(chEmitted.sampleUniforms(0, 64, 64));
      check("channel fixture: sampleUniforms supplies exactly the declared uniforms", supplied.length === declared.size && supplied.every((n) => declared.has(n)));
    }
  }
  const refuse = (mut: (n: GraphNode) => void) => {
    const g2 = chanGraph();
    mut(g2.nodes.find((n) => n.id === "chk")!);
    return planSkiaExport(g2.nodes, g2.edges, "chk", { name: "x", canvas: { width: 8, height: 8 }, timeline: fx.AURORA_TIMELINE }).problems;
  };
  check(
    "refuses a scalar channel track with a non-numeric key",
    refuse((n) => (n.animation!["ch:gain"] = blk([{ tick: 0, value: "lots", easingOut: "linear" }]))).some((p) => p.includes(`"gain"`))
  );
  check(
    "refuses a color channel track with a key that isn't a color",
    refuse((n) => (n.animation!["ch:tint"] = blk([{ tick: 0, value: "teal", easingOut: "linear" }]))).some((p) => p.includes(`"tint"`))
  );
  check(
    "a disabled channel track exports the row (static)",
    (() => {
      const g3 = chanGraph();
      const n = g3.nodes.find((x) => x.id === "chk")!;
      n.animation!["ch:gain"] = { ...n.animation!["ch:gain"], animated: false };
      const p = planSkiaExport(g3.nodes, g3.edges, "chk", { name: "x", canvas: { width: 8, height: 8 }, timeline: fx.AURORA_TIMELINE }).plan;
      const gu = p?.uniforms.find((x) => x.name === "gain");
      return !!gu && !gu.track && gu.value === 0.5;
    })()
  );
}

// ---- 3. CanvasKit compile + uniform set ---------------------------------------
{
  const require = createRequire(path.join(ROOT, "package.json"));
  const CK = await require("canvaskit-wasm")();
  const r = compileSksl(CK, plan.sksl);
  check("emitted SkSL compiles in CanvasKit", !!r.effect, r.error ? userLineError(r.error, plan.preludeLines) : "");
  if (r.effect) {
    const declared = new Set<string>();
    for (let i = 0; i < r.effect.getUniformCount(); i++) declared.add(r.effect.getUniformName(i));
    const supplied = new Set(Object.keys(emitted.sampleUniforms(0, 512, 512)));
    const missing = [...declared].filter((n) => !supplied.has(n));
    const extra = [...supplied].filter((n) => !declared.has(n));
    check("sampleUniforms supplies exactly the declared uniforms", !missing.length && !extra.length, `missing ${missing} extra ${extra}`);
  }
}

// ---- 4. refusals ---------------------------------------------------------------
{
  const plan2 = (mut: (n: GraphNode[], e: GraphEdge[]) => void) => {
    const g = fx.auroraGraph();
    mut(g.nodes, g.edges);
    return planSkiaExport(g.nodes, g.edges, g.targetId, { name: "x", canvas: { width: 8, height: 8 }, timeline: fx.AURORA_TIMELINE }).problems;
  };
  check(
    "refuses a wired image child",
    plan2((n, e) => {
      n.push({ id: "img", type: "solid-color", params: {} });
      e.push({ id: "i", source: "img", sourceHandle: "out:primary", target: "aurora", targetHandle: "in:image1" });
    }).some((p) => p.includes("image1"))
  );
  check(
    "refuses a channel driven by a non-keyframe node",
    plan2((n, e) => {
      n.push({ id: "lfo", type: "lfo", params: {} });
      const ed = e.find((x) => x.source === "drift")!;
      ed.source = "lfo";
    }).some((p) => p.includes("driven by a lfo"))
  );
  check(
    "refuses a keyframed Constant",
    plan2((n, e) => {
      n.push({ id: "k", type: "constant", params: { value: 1 }, animation: { value: blockOf([{ tick: 0, value: 1, easingOut: "linear" }, { tick: 5, value: 2, easingOut: "linear" }]) } });
      e.find((x) => x.source === "drift")!.source = "k";
    }).some((p) => p.includes("Constant"))
  );
  check(
    "refuses ramp channels",
    plan2((n) => {
      const sk = n.find((x) => x.id === "aurora")!;
      const src = `${sk.params.expression}\n// ramp("ink", "#000", "#fff")`;
      sk.params = { ...sk.params, expression: src, inputs: syncChannelInputs(sk.params.inputs as any, src) };
    }).some((p) => p.includes("ramp/curve"))
  );
  check(
    "a static Constant exports its stepped value",
    (() => {
      const g = fx.auroraGraph();
      g.nodes.push({ id: "k", type: "constant", params: { value: 1.23456, mode: "float", step: 0.01 } });
      g.edges.find((x) => x.source === "drift")!.source = "k";
      const p = planSkiaExport(g.nodes, g.edges, g.targetId, { name: "x", canvas: { width: 8, height: 8 }, timeline: fx.AURORA_TIMELINE }).plan;
      const v = p?.uniforms.find((u) => u.name === "drift_x")?.value as number;
      return Math.abs(v - 1.23) < 1e-9;
    })()
  );
}

// ---- 5. prelude, lint, recipe wiring ------------------------------------------
{
  const src = `// ch("k", 0.5, 0, 1)\n// toggle("on", true)\n// pick("mode", "soft", "hard")\n// color("tint", "#ff8800")\nhalf4 main(float2 p) { return iImage2.eval(p); }`;
  const prog = buildSkslProgram({ expression: src, inputs: syncChannelInputs([], src) });
  check("toggle → uniform int", prog.sksl.includes("uniform int on;"));
  check("pick → int + option consts", prog.sksl.includes("uniform int mode;") && prog.sksl.includes("const int mode_hard = 1;"));
  check("color → plain float4 of sRGB numbers (no layout(color): the program is color-managed)", /^uniform float4 tint;/m.test(prog.sksl) && !prog.sksl.includes("layout(color)"));
  check("only referenced children are declared", prog.children.join() === "iImage2" && !prog.sksl.includes("iImage1"));
  check("lint rejects `uniform` lines", lintSksl("uniform float x;\nhalf4 main(float2 p){return half4(x);}").problems.length === 1);
  check("lint rejects a missing main", lintSksl("float f(){return 1.0;}").problems.some((p) => p.includes("main")));
  check("lint warns on half declarations, not on return casts", lintSksl("half4 main(float2 p){ half3 c = half3(1); return half4(c, 1); }").warnings.length === 1 && lintSksl("half4 main(float2 p){ return half4(1); }").warnings.length === 0);
  check("error lines map to the user's source", userLineError("error: 9: unknown identifier 'x'", 4) === "error: line 5: unknown identifier 'x'");

  for (const type of ["sksl-shader", "glsl-expression"]) {
    const expression = type === "sksl-shader" ? `// ch("k", 0.5, 0, 1)\nhalf4 main(float2 p) { return half4(k); }` : `// ch("k", 0.5, 0, 1)\nfragColor = vec4(k);`;
    const r: any = buildRecipe({ name: "t", nodes: [{ id: "d", type: "animated-value" }, { id: "s", type, params: { expression } }], edges: [{ from: "d:out", to: "s:in:k" }], outputs: [{ name: "image", from: "s:out", type: "image" }] } as any);
    const th = r.edges?.find((e: any) => e.source.startsWith("animated-value"))?.targetHandle ?? "";
    check(`recipe wires a ${type} channel by name`, th.startsWith("in:in:ein-"), th);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "all checks passed" : `${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
