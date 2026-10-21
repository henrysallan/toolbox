// check-expressions: the value-graph → AE expression compiler (spec
// 091926_after-effects-handoff.md §3 rung 3, M4 lane 1;
// src/lib/ae-export/scene/expressions/).
//
// A corpus of driver graphs — every rung-3 node and mode, wired into every
// kind of consumer the walk compiles (a scalar prop, a spatial pair, a
// color, a Transform node's TRS, an effect param through its linear map, an
// opacity product, a Gradient Ramp point) on the plain clock, an offset
// layer and a precomp — is built twice: with the compiler (policy.drivers
// "expression") and without it ("keys", the per-frame keys the walk sampled
// from graph.valueAt before). Every compiled expression then runs in a
// node:vm sandbox with a small After Effects shim (time, thisComp,
// seedRandom / random, linear / ease, vector math) at every frame of its
// layer, and must equal the sampled key there. Frame-mode Random (AE's own
// seedRandom) is held to its range instead. The refusals — stateful and
// audio nodes, a keyed param in the closure, a uv-mode Math, Math.random(),
// a wired Switch index — must stay sampled, with the reason in the report.
//
//   npx tsx scripts/check-ae-export.mts expressions


import vm from "node:vm";
import { loadRegistry, makeChecker } from "./harness.mts";
import { GraphBuilder } from "../fixtures/ae-export/graphs/fixtures.mts";
import { addConsumer, aeShim, buildCorpus, caseOf, constant, expressionProps, FPS, FRAMES, get, H, ramp, rawEdge, same, sampledAt, W, type Case, type Found } from "../fixtures/ae-export/graphs/expressions-corpus.mts";

export default async function checkExpressions(): Promise<number> {
  const c = makeChecker("expressions");
  await loadRegistry();
  const { buildAeSceneForEditor } = await import("@/lib/ae-export/scene");
  const { HEADER_MARK } = await import("@/lib/ae-export/scene/expressions");
  const { makeInstanceNode, makeLayerNodes } = await import("@/state/graph-ops");

  const g = new GraphBuilder({ makeInstanceNode, makeLayerNodes });
  const all: Case[] = buildCorpus(g);
  const build = (drivers: "expression" | "keys") =>
    buildAeSceneForEditor(g.nodes, g.edges, {
      env: { composition: { id: "comp-expr", name: "Expressions", width: W, height: H, fps: FPS, durationFrames: FRAMES }, policy: { drivers } },
      name: "Expressions",
      toolboxVersion: "gate",
      generatedAt: "2026-10-21T00:00:00.000Z",
    });
  const A = build("expression");
  const B = build("keys");
  c.check("both builds are valid scenes", A.problems.length === 0 && B.problems.length === 0, [...A.problems, ...B.problems].slice(0, 5));
  const found = expressionProps(A.scene, HEADER_MARK);
  const byCase = new Map<string, Found[]>();
  for (const f of found) {
    const id = caseOf(f.prop.expression);
    byCase.set(id, [...(byCase.get(id) ?? []), f]);
  }
  c.check("the keys policy compiles nothing", expressionProps(B.scene, HEADER_MARK).length === 0);
  const report = [...A.scene.report.native, ...A.scene.report.approx];
  const noteOf = (id: string) => report.filter((l) => l.id === id || l.id.startsWith(`${id}-`)).map((l) => l.note ?? "").join(" · ");

  let compared = 0;
  let exprCount = 0;
  for (const k of all) {
    const props = byCase.get(k.id) ?? [];
    const expect = k.expect ?? "exact";
    if (expect instanceof RegExp) {
      c.check(`${k.id}: stays sampled — ${expect.source}`, props.length === 0 && expect.test(noteOf(k.id)), { props: props.length, note: noteOf(k.id).slice(0, 300) });
      continue;
    }
    if (!props.length) {
      c.check(`${k.id}: compiles to an expression`, false, noteOf(k.id).slice(0, 400));
      continue;
    }
    let worst = 0;
    let bad: unknown;
    let n = 0;
    for (const f of props) {
      exprCount++;
      let script: vm.Script;
      try {
        script = new vm.Script(f.prop.expression);
      } catch (e) {
        bad = { syntax: String(e), expression: f.prop.expression.slice(0, 400) };
        break;
      }
      const want = get(B.scene, f.path);
      const seen = new Set<string>();
      for (let fr = f.frames[0]; fr <= f.frames[1]; fr++) {
        let got: unknown;
        try {
          got = script.runInNewContext(aeShim(fr / f.fps, f.fps));
        } catch (e) {
          bad = { frame: fr, threw: String(e) };
          break;
        }
        const g4 = (Array.isArray(got) ? got : [got]) as number[];
        if (expect === "random") {
          seen.add(JSON.stringify(g4));
          if (!g4.every((x) => typeof x === "number" && x >= k.range![0] && x <= k.range![1])) bad = { frame: fr, got: g4, range: k.range };
          continue;
        }
        const w = sampledAt(want, fr, f.fps);
        if (!w) {
          bad = { frame: fr, path: f.path.join("."), sampled: want };
          break;
        }
        // A color expression returns [r, g, b, 1]; the scene value is [r, g, b].
        if (!(g4.length === w.length || (g4.length === 4 && w.length === 3 && g4[3] === 1))) {
          bad = { frame: fr, got: g4, want: w };
          break;
        }
        for (let i = 0; i < w.length; i++) {
          if (!same(g4[i], w[i])) {
            bad ??= { frame: fr, component: i, got: g4[i], want: w[i], path: f.path.slice(4).join(".") };
          }
          if (Number.isFinite(g4[i] - w[i])) worst = Math.max(worst, Math.abs(g4[i] - w[i]));
        }
        n++;
      }
      // Sub-frame times (motion blur) read the interpolated clock: numbers.
      const mid = script.runInNewContext(aeShim((f.frames[0] + 0.5) / f.fps, f.fps));
      if (!(Array.isArray(mid) ? mid : [mid]).every((x: unknown) => typeof x === "number")) bad ??= { subframe: mid };
      if (expect === "random" && seen.size < 3) bad ??= { varies: false, distinct: seen.size };
      if (bad) break;
    }
    compared += n;
    c.check(`${k.id}: ${props.length} expression${props.length > 1 ? "s" : ""} ${expect === "random" ? "in range and varying (AE's own seedRandom)" : `≡ the sampled keys at ${n} frames (max |Δ| ${worst.toExponential(1)})`}`, !bad, bad);
  }

  // Facts on the text and the report.
  const exprOf = (id: string) => byCase.get(id)?.[0]?.prop.expression as string | undefined;
  c.check("an offset layer's clock: comp tick − 10000 (its clip starts at frame 10)", /: tick\) - 10000;/.test(exprOf("clock-offset-layer") ?? ""), exprOf("clock-offset-layer")?.split("\n").slice(0, 8));
  c.check("a precomp's clock: the precomp's own time (no offset inside)", /var tick = time \* 30 \* 1000;\ntick = \(.*: tick\);/.test(exprOf("clock-precomp") ?? ""), exprOf("clock-precomp")?.split("\n").slice(0, 8));
  c.check("seeded Random: the editor's hash, reported exact", /tbxHash01/.test(exprOf("random-seeded-uniform") ?? "") && A.scene.report.native.some((l) => l.id === "random-seeded-uniform" && l.fidelity === "exact"));
  c.check("frame-mode Random: seedRandom(…, false) + random(), reported approx", /seedRandom\(\d+, false\);/.test(exprOf("random-frame-uniform") ?? "") && /random\(\)/.test(exprOf("random-frame-uniform") ?? "") && A.scene.report.approx.some((l) => l.id === "random-frame-uniform"));
  c.check("Expression random(): the node's own mulberry32 per frame", /tbxDraw\(r\d+ = /.test(exprOf("expr-random") ?? ""));
  const trs = byCase.get("consumer-trs") ?? [];
  c.check("a wired Transform: position and rotation compile, anchor / scale stay plain values", trs.length === 2 && trs.some((f) => f.path.includes("position")) && trs.some((f) => f.path.includes("rotation")), trs.map((f) => f.path.slice(4).join(".")));
  c.check("a static value graph is a static value, no expression", (() => {
    const s = buildAeSceneForEditor(...(() => {
      const h = new GraphBuilder({ makeInstanceNode, makeLayerNodes });
      const L = h.layer("LS", "static");
      constant(h, L, "k", 0.7);
      addConsumer(h, L, "st", "rot", "k:out");
      return [h.nodes, h.edges] as const;
    })(), { env: { composition: { id: "s", name: "S", width: W, height: H, fps: FPS, durationFrames: 10 } }, name: "S", toolboxVersion: "gate" });
    const json = JSON.stringify(s.scene.comps);
    return json.includes('"rotation":{"v":0.7}') && !json.includes(HEADER_MARK);
  })());
  // A Toolbox Shader channel: the c-shader fixture's fused `gain` wired from
  // an LFO → an expression on the host's slider, equal to the slider keys.
  {
    const { SCENE_FIXTURES, sceneOf } = await import("../fixtures/ae-export/graphs/fixtures.mts");
    const base = SCENE_FIXTURES.find((f) => f.name === "c-shader")!;
    const wired = {
      ...base,
      build(g: GraphBuilder) {
        base.build(g);
        g.node("LC", "gainLfo", "lfo", { frequency: 0.5, amplitude: 0.25, offset: 0.5 });
        // The channel's socket is in:<row id>: the edge handle is in:in:ch-gain.
        g.wire("gainLfo:out", "fused:in:in:ch-gain");
      },
    };
    const sa = await sceneOf(wired);
    const sb = await sceneOf({ ...wired, opts: { ...wired.opts, policy: { drivers: "keys" } } });
    const props = (s: typeof sa) => s.scene.comps.flatMap((x) => x.layers).flatMap((l) => l.effects ?? []).filter((e) => e.match === "TBX Shader").flatMap((e) => Object.values(e.props) as { expression?: string; keys?: { v: number }[] }[]);
    const slider = props(sa).find((p) => typeof p?.expression === "string");
    const keys = props(sb).find((p) => Array.isArray(p?.keys) && p.keys.length === FRAMES);
    let ok = !!slider && !!keys;
    for (let f = 0; ok && f < FRAMES; f++) ok = same(new vm.Script(slider!.expression!).runInNewContext(aeShim(f / FPS, FPS)), keys!.keys![f].v);
    c.check("a wired Toolbox Shader channel → an expression on its slider, ≡ the slider keys at every frame", ok, { slider: slider?.expression?.split("\n").slice(0, 3), keys: keys?.keys?.length });
  }

  // Refusals a scene can't hold quietly (a uv-mode Math's texture into a
  // scalar param makes the sampler draw without GL): the compiler alone.
  {
    const { AeBuilder, compileEndpoint, Refusal } = await import("@/lib/ae-export/scene/expressions/compile");
    const { flattenAeComposition } = await import("@/lib/ae-export/editor");
    const h = new GraphBuilder({ makeInstanceNode, makeLayerNodes });
    const L = h.layer("LU", "uv");
    ramp(h, L, "ua");
    h.node(L, "uv", "math", { mode: "uv", operation: "Add" });
    h.wire("ua:out", "uv:in:a");
    h.node(L, "img", "noise", {});
    h.node(L, "fx", "expression", { expression: "x * 2", inputs: [{ id: "ein-x0", name: "x", default: 1 }] });
    rawEdge(h, "img", "out:primary", "fx", "in:in:ein-x0");
    const flat = flattenAeComposition(h.nodes, h.edges);
    const refusal = (ep: string) => {
      try {
        compileEndpoint(new AeBuilder(flat.byId, flat.wires, { fps: FPS, ticksPerFrame: 1000 }, (_n, _p, value) => ({ value })), ep);
        return "compiled";
      } catch (e) {
        return e instanceof Refusal ? e.message : `threw ${String(e)}`;
      }
    };
    // A leaf with `code` (the Essential Properties hook): the expression
    // reads the code live, the interpreter the value; two equal values keep
    // their own code.
    {
      const { finishProgram } = await import("@/lib/ae-export/scene/expressions/compile");
      const { emitAeExpression } = await import("@/lib/ae-export/scene/expressions");
      const { evaluateProgram } = await import("@/lib/skia-export/procedural/ir");
      const k = new GraphBuilder({ makeInstanceNode, makeLayerNodes });
      const KL = k.layer("LK", "knobs");
      k.node(KL, "osc", "lfo", { frequency: 0.5, amplitude: 2, offset: 2 });
      const kf = flattenAeComposition(k.nodes, k.edges);
      const tl = { fps: FPS, ticksPerFrame: 1000 };
      const b = new AeBuilder(kf.byId, kf.wires, tl, (_n, p, value) => (p === "amplitude" || p === "offset" ? { value, code: `knob(${JSON.stringify(p)})` } : { value }));
      const { program, outs } = finishProgram(b, compileEndpoint(b, "osc:out").comps, tl);
      const text = emitAeExpression(program, outs, { fps: FPS, ticksPerFrame: 1000, offsetTicks: 0, header: [], leafCode: b.leafCode, aeRngs: b.aeRngs }, (o) => o[0]);
      const run = (f: number, knobs: Record<string, number>) => new vm.Script(text).runInNewContext({ ...aeShim(f / FPS, FPS), knob: (p: string) => knobs[p] });
      const asIs = [3, 17, 40].every((f) => same(run(f, { amplitude: 2, offset: 2 }), evaluateProgram({ ...program, out: outs[0] }, f * 1000)));
      const moved = same(run(7, { amplitude: 5, offset: -1 }), 5 * Math.sin(2 * Math.PI * (((((7 / 30) * 0.5) % 1) + 1) % 1)) - 1);
      c.check("a live leaf (exprLeaf code): read at evaluation, the interpreter keeps the value; equal values keep their own code", asIs && moved && /knob\("amplitude"\)/.test(text) && /knob\("offset"\)/.test(text), text.split("\n").slice(-6));
    }
    c.check("Math in uv mode refuses (a per-pixel shader, not a value)", /uv mode/.test(refusal("uv:out")), refusal("uv:out"));
    c.check("a value read from an image node refuses (a non-value input)", /isn't one the exporter compiles/.test(refusal("fx:out")), refusal("fx:out"));
  }
  console.log(`  ·    ${all.length} cases, ${exprCount} expressions, ${compared} frames compared`);
  return c.failures;
}
