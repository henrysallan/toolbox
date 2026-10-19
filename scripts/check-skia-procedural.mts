// check-skia-procedural: procedural drivers compiled for the React Native
// Skia export (specdocs/101326_skia-target.md §3.5e, Wave 3 lane P,
// src/lib/skia-export/procedural/). No GPU, no device:
//
//   0. the parser: the Expression subset parses; everything else — and every
//      place the EDITOR fails to compile (a bare `x;`, a trailing // comment,
//      `-x ** 2`, `return` + line break) — refuses with a reason; nothing is
//      evaluated (a side-effecting source refuses and has no effect; the
//      procedural sources contain no eval / new Function);
//   1. every driver case (scripts/fixtures/skia/procedural-graph.ts: every LFO
//      shape and clock, every Math op, every Scene Time mode × easing incl. a
//      custom curve, Random, Constant, Animated Value on wired clocks, an
//      Expression battery incl. random()) compiles, and the program's
//      interpreter equals the REAL evaluator bit for bit at every frame and
//      at three sub-frame ticks per frame;
//   2. the emitted worklet module (procedural.ts) equals the evaluator bit for
//      bit at the same ticks, and its easing / curve helpers equal
//      engine/easing.ts over a dense grid;
//   3. …also as the worklets Babel plugin's output on an emulated UI runtime
//      (each worklet rebuilt from its code string with only its closure — the
//      device's capture semantics; skipped without skia-harness/node_modules);
//   4. no worklet in an emitted module reads a function or constant declared
//      below it (the TDZ trap, §2d);
//   5. baked: every case without integer hashing compiles to SkSL and runs on
//      a CanvasKit F32 surface at every frame and sub-frame tick, within the
//      bounds below of the worklet; a discontinuous case may land on the other
//      side of a jump only where the double sits on it (proven per sample);
//   6. plan kinds and bundles: SkSL Shader uniforms take procedural drivers
//      (worklet / baked / native), a Skia scene's binds get kind "expr"
//      (sampleBinds == the producer every frame; baked program uniforms;
//      native on the linear clock), manifests flag procedural values;
//   7. fallbacks and refusals: unsupported syntax in a scene samples (with a
//      warning), Math.random / Random frame mode / clips / bypass / unknown
//      drivers refuse, random() refuses to bake;
//   8. the emitted bundles type-check in skia-harness; the harness slots
//      (skia-harness/src/bundle-procedural, -baked) are today's export.
//
//   npx tsx scripts/check-skia-procedural.mts   (PROCEDURAL_SIZE=<px> for §6 renders)

/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { GraphEdge, GraphNode } from "@/engine/evaluator";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS = path.join(ROOT, "skia-harness");
const HAVE_HARNESS = fs.existsSync(path.join(HARNESS, "node_modules", "react-native-worklets", "plugin"));

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { evaluateGraph } = await import("@/engine/evaluator");
const { applyEasing, applyEasingOrCurve, EASING_OPTIONS } = await import("@/engine/easing");
const { dataOnlyContext, makeSceneSampler } = await import("@/lib/skia-export/scene-sample");
const P = await import("@/lib/skia-export/procedural");
const { emitProceduralModule, proceduralFnName } = await import("@/lib/skia-export/procedural/emit-js");
const { exportSkia, exportSkiaScene, planSkiaExport } = await import("@/lib/skia-export");
const { collectBinds, closeValue } = await import("@/lib/skia-export/scene-plan");
const bk = await import("@/lib/skia-export/emit-baked");
const { checkExportable, typecheckBundle } = await import("./skia/export-check.ts");
const fx = await import("./fixtures/skia/procedural-graph.ts");
const afx = await import("./fixtures/skia/aurora.ts");
const { auroraSceneGraph } = await import("./fixtures/skia/aurora-scene-graph.ts");
import type { ProcProgram } from "@/lib/skia-export/procedural/ir";
import { sameUpToFloatNoise } from "./skia/snapshot-diff.ts";

const require = createRequire(path.join(ROOT, "package.json"));
const CK = await require("canvaskit-wasm")();
const runtimeSource = fs.readFileSync(path.join(ROOT, "src/lib/skia-export/runtime/toolbox-timeline.ts"), "utf8");
const TL = fx.PROCEDURAL_TIMELINE;
const TPF = TL.ticksPerFrame;
const FRAMES = TL.sceneDurationTicks / TPF + 1;
const SUBS = [0, 250, 500, 750];
const SIZE = Number(process.env.PROCEDURAL_SIZE ?? 32);

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
const info = (msg: string) => console.log(`     ${msg}`);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skia-procedural-"));
process.on("exit", () => fs.rmSync(tmpRoot, { recursive: true, force: true }));
// Bundles type-checked together at the end (§8): <slot>/<file>.
const typecheckFiles: Record<string, string> = {};
const typecheckSlots = new Set<string>();
function queueTypecheck(slot: string, files: Record<string, string>) {
  typecheckSlots.add(slot);
  for (const [f, text] of Object.entries(files)) typecheckFiles[`${slot}/${f}`] = text;
}

// ---- 0. the parser ---------------------------------------------------------------------------
{
  const bad = fx.EXPRESSION_SOURCES.filter((e) => !P.parseExpressionSource(e.src).ok);
  check(`the fixture's ${fx.EXPRESSION_SOURCES.length} Expression sources parse`, !bad.length, bad.map((b) => b.src).join(" | "));
  const refusals: [string, RegExp][] = [
    ["x & 1", /bitwise/],
    ["x << 2", /shift/],
    ["x | 0", /bitwise/],
    ["~x", /bitwise/],
    ['"a" + x', /string/],
    ["`t${x}`", /template/],
    ["x = 2", /assignment/],
    ["x += 1", /assignment/],
    ["x++", /increment/],
    ["-x ** 2", /unary operator directly before \*\*/],
    ["x;", /a ; in a bare expression/],
    ["x + 1 // note", /comment at the end of a bare expression/],
    ["return\n  x * 2", /line break right after `return`/],
    ["let a = x; return a", /assignment|statements before the `return`/],
    ["if (x) return 1", /statements before the `return`/],
    ["return x; return y", /more statements/],
    ["x.y", /member access/],
    ["x[0]", /indexing|member/],
    ["(x, 2)", /comma/],
    ["x ?? 1", /\?\?/],
    ["x?.y", /optional chaining/],
    ["typeof x", /typeof/],
    ["new Date()", /reserved word "new"/],
    ["this", /reserved word "this"/],
    ["x => x", /arrow/],
    ["{ a: 1 }", /object literals|blocks/],
    ["010", /legacy octal/],
    ["1_000", /separators/],
    ["10n", /BigInt/],
    ["3x", /directly followed by a name/],
    ["[1, [2]]", /array literal inside/],
    ["x + [1]", /array literal inside/],
    ["[x,, y]", /holes/],
    ["\\u0078", /escape/],
    ["sin(x)(2)", /call's result/],
    ["/* open", /unterminated/],
    ["x ? y", /without its ':'/],
    ["undefined", /reserved word "undefined"/],
  ];
  const wrong = refusals.flatMap(([src, re]) => {
    const r = P.parseExpressionSource(src);
    return r.ok || !re.test(r.reason) ? [`${JSON.stringify(src)} → ${r.ok ? "accepted" : r.reason}`] : [];
  });
  check(`${refusals.length} sources outside the subset (or that the editor can't compile) refuse with their reason`, !wrong.length, wrong.join(" | "));
  const accepted = ["  x  ", "return x;", "return x // fine in statement mode", "x // comment\n + 1", "/* c */ x /* d */", "0x1f + 0b101 + 0o17 + .5 + 5. + 1e-3 + 2E+2", "a ? b ? 1 : 2 : c ? 3 : 4", "2 ** -x", "2 ** 3 ** 2", "(-x) ** 2", "-(x ** 2)", "!x + !!y", "Math.PI"];
  const notAccepted = accepted.filter((s) => !P.parseExpressionSource(s).ok);
  check("edge forms JavaScript accepts parse (whitespace, comments, number forms, nested ?:, ** associativity)", !notAccepted.length, notAccepted.join(" | "));
  {
    const r = P.parseExpressionSource("2 ** 3 ** 2") as any;
    check("** is right-associative (2 ** (3 ** 2))", r.ast?.k === "binary" && r.ast.b?.k === "binary" && r.ast.b.op === "**");
    const s = P.parseExpressionSource("a - b - c") as any;
    check("- is left-associative ((a - b) - c)", s.ast?.k === "binary" && s.ast.a?.k === "binary" && s.ast.a.op === "-");
  }
  // Compile-level refusals (names, calls, the editor's own failures).
  const compileRefusal = (src: string, vars: string[] = ["x"]) => {
    const n = [fx.expressionNode("e", src, vars)];
    const r = P.compileDriver({ source: "e", sourceHandle: "out:primary" }, n, [], TL);
    return r.ok ? "accepted" : `${r.sampleable ? "sampleable" : "refused"}: ${r.reason}`;
  };
  const cases: [string, string[], RegExp][] = [
    ["foo(x)", ["x"], /sampleable: .*unknown function "foo"/],
    ["q + 1", ["x"], /sampleable: .*unknown name "q"/],
    ["Math.random()", ["x"], /^refused: .*Math\.random/],
    ["Math.imul(x, 3)", ["x"], /sampleable: .*integer bit math/],
    ["Math.nope(x)", ["x"], /sampleable: .*Math\.nope/],
    ["sin(x, 2)", ["x"], /sampleable: .*sin takes 1 argument/],
    ["clamp(x)", ["x"], /sampleable: .*clamp takes 3 arguments/],
    ["random(2)", ["x"], /sampleable: .*random\(\) takes no arguments/],
    ["sin", ["x"], /sampleable: .*used as a value/],
    ["x(2)", ["x"], /sampleable: .*calling the variable/],
    ["(x > 0) === 1", ["x"], /sampleable: .*strict equality/],
    ["t", ["t"], /sampleable: .*shadows the global/],
    ["x", ["x", "x"], /declared twice/],
    ["x", ["Math"], /hides the Math object/],
    ["x", ["9a"], /invalid/],
    ["x", ["class"], /reserved word/],
  ];
  const off = cases.flatMap(([src, vars, re]) => {
    const got = compileRefusal(src, vars);
    return re.test(got) ? [] : [`${JSON.stringify(src)} [${vars}] → ${got}`];
  });
  check(`${cases.length} compile refusals (unknown names, Math.random, arity, strict ===, variable names the editor can't compile)`, !off.length, off.join(" | "));
  // Never evaluated: a side-effecting source refuses and does nothing.
  (globalThis as any).__procedural_pwned = 0;
  const pw = compileRefusal("globalThis.__procedural_pwned = 1");
  const pw2 = compileRefusal("process.exit(3)");
  check("a side-effecting source refuses at parse time and has no effect (nothing is evaluated)", pw !== "accepted" && pw2 !== "accepted" && (globalThis as any).__procedural_pwned === 0, `${pw} | ${pw2}`);
  const src = ["parse.ts", "ir.ts", "compile.ts", "emit-js.ts", "emit-sksl.ts", "index.ts"].map((f) => fs.readFileSync(path.join(ROOT, "src/lib/skia-export/procedural", f), "utf8"));
  check("the procedural exporter contains no eval / new Function / Function(", !src.some((s) => /\beval\s*\(|new\s+Function\b|[^.\w]Function\s*\(/.test(s.replace(/\/\/[^\n]*/g, ""))));
}

// ---- 1. compile + interpreter == the evaluator ------------------------------------------------
interface Ref {
  name: string;
  c: ReturnType<typeof fx.proceduralCases>[number];
  program: ProcProgram;
  ticks: number[];
  want: number[];
}
const refs: Ref[] = [];
{
  const cases = fx.proceduralCases();
  const refused: string[] = [];
  const mismatch: string[] = [];
  let compared = 0;
  for (const c of cases) {
    const target = c.component !== undefined ? { socket: "vec4" as const, component: c.component } : { socket: "scalar" as const };
    const r = P.compileDriver({ source: c.out, sourceHandle: "out:primary" }, c.nodes, c.edges, TL, target);
    if (!r.ok) {
      refused.push(`${c.name}: ${r.reason}`);
      continue;
    }
    const ctx: any = dataOnlyContext({ width: 64, height: 64 }, TL);
    const cache = new Map();
    const ticks: number[] = [];
    const want: number[] = [];
    let bad = "";
    for (let f = 0; f < FRAMES; f++) {
      for (const sub of SUBS) {
        const tick = f * TPF + sub;
        ctx.tick = tick;
        ctx.frame = Math.floor(tick / TPF);
        ctx.time = tick / (TPF * TL.fps);
        const res = evaluateGraph(c.nodes, c.edges, ctx, cache as any, null, undefined, null, { extraTargets: [c.out] });
        const v: any = res.outputs.get(c.out)?.primary;
        let w: number;
        if (v?.kind === "scalar") w = v.value;
        else {
          const vals = (v?.value ?? []) as number[];
          const k = c.component ?? 0;
          w = k < vals.length ? vals[k] : k === 3 ? 1 : 0;
        }
        ticks.push(tick);
        want.push(w);
        compared++;
        const got = P.evaluateProgram(r.program, tick);
        if (!bad && !Object.is(got, w)) bad = `tick ${tick}: engine ${w}, program ${got}`;
      }
    }
    if (bad) mismatch.push(`${c.name}: ${bad}`);
    refs.push({ name: c.name, c, program: r.program, ticks, want });
  }
  check(`all ${cases.length} driver cases compile`, !refused.length, refused.join(" | "));
  check(`the program interpreter == the real evaluator, bit for bit (${refs.length} cases × ${FRAMES} frames × ${SUBS.length} ticks per frame = ${compared} values)`, !mismatch.length, mismatch.slice(0, 6).join(" | "));
  const kinds = new Map<string, number>();
  for (const c of cases) for (const n of c.nodes) kinds.set(n.type, (kinds.get(n.type) ?? 0) + 1);
  info(`node types exercised: ${[...kinds].map(([k, n]) => `${k} ×${n}`).join(", ")}`);
}

{
  const { getNodeDef } = await import("@/engine/registry");
  const { isOfferedInSkiaLayer } = await import("@/engine/skia/layer-target");
  const off = [...P.PROCEDURAL_DRIVER_TYPES].filter((t) => getNodeDef(t)?.skia?.class !== "driver" || !isOfferedInSkiaLayer(getNodeDef(t)));
  check(`every compiled driver type (${[...P.PROCEDURAL_DRIVER_TYPES].join(", ")}) is a Skia-layer driver (skia.class "driver")`, !off.length, off.join(", "));
}

// ---- 2. the emitted worklet module == the evaluator -------------------------------------------
const MODULE_DIR = path.join(tmpRoot, "js");
fs.mkdirSync(MODULE_DIR, { recursive: true });
const caseKey = (i: number) => `c${i}`;
// Easing / curve grid programs: P_ease_<k>(tick) = applyEasing(name, tick / 1000, 1.3).
const GRID_NAMES = [...EASING_OPTIONS, "no-such-easing"];
const CURVE = [
  { id: "a", x: 0, y: 0.1 },
  { id: "b", x: 0.2, y: 0.8 },
  { id: "c", x: 0.2, y: 0.85 },
  { id: "d", x: 0.55, y: 0.3 },
  { id: "e", x: 1, y: 0.95 },
];
function gridProgram(fn: string, curves: ProcProgram["curves"] = []): ProcProgram {
  return {
    body: [{ k: "let", e: { k: "bin", op: "/", a: { k: "tick" }, b: { k: "lit", v: 1000 } } }],
    out: { k: "call", fn, args: [{ k: "slot", i: 0 }, { k: "lit", v: 1.3 }] },
    tracks: [],
    curves,
    nodes: [],
    fps: TL.fps,
    ticksPerFrame: TPF,
  };
}
const { computeMonotoneTangents, sanitizeFloatCurve } = await import("@/engine/float-curve");
const sanitized = sanitizeFloatCurve(CURVE, 0, 1);
const gridCurve = { x: sanitized.map((p) => p.x), y: sanitized.map((p) => p.y), m: computeMonotoneTangents(sanitized) };
const values = [
  ...refs.map((r, i) => ({ key: caseKey(i), program: r.program, from: r.name })),
  ...GRID_NAMES.map((n, i) => ({ key: `ease_${i}`, program: gridProgram(`ease:${n in Object.fromEntries(EASING_OPTIONS.map((x) => [x, 1])) ? n : "linear"}`), from: `applyEasing("${n}")` })),
  { key: "curve", program: gridProgram("curve:0", [gridCurve]), from: "custom curve" },
];
const moduleSrc = emitProceduralModule(values);
fs.writeFileSync(path.join(MODULE_DIR, "procedural.ts"), moduleSrc);
fs.writeFileSync(path.join(MODULE_DIR, "toolbox-timeline.ts"), runtimeSource);
{
  const mod = await import(pathToFileURL(path.join(MODULE_DIR, "procedural.ts")).href);
  const mismatch: string[] = [];
  let compared = 0;
  refs.forEach((r, i) => {
    const fn = mod[proceduralFnName(caseKey(i))];
    for (let k = 0; k < r.ticks.length; k++) {
      compared++;
      const got = fn(r.ticks[k]);
      if (!Object.is(got, r.want[k])) {
        mismatch.push(`${r.name} @ tick ${r.ticks[k]}: engine ${r.want[k]}, worklet ${got}`);
        break;
      }
    }
  });
  check(`emitted procedural.ts == the real evaluator, bit for bit (${compared} values)`, !mismatch.length, mismatch.slice(0, 6).join(" | "));
  // Helpers on a dense grid (t from −0.1 to 1.1, 1201 samples, intensity 1.3).
  const gridBad: string[] = [];
  GRID_NAMES.forEach((n, i) => {
    const fn = mod[proceduralFnName(`ease_${i}`)];
    for (let tk = -100; tk <= 1100; tk++) {
      const want = applyEasing(n, tk / 1000, 1.3);
      if (!Object.is(fn(tk), want)) {
        gridBad.push(`${n} @ ${tk / 1000}: engine ${want}, worklet ${fn(tk)}`);
        break;
      }
    }
  });
  const cf = mod[proceduralFnName("curve")];
  for (let tk = -100; tk <= 1100; tk++) {
    const want = applyEasingOrCurve("custom", tk / 1000, 1.3, CURVE);
    if (!Object.is(cf(tk), want)) {
      gridBad.push(`custom curve @ ${tk / 1000}: engine ${want}, worklet ${cf(tk)}`);
      break;
    }
  }
  check(`the easing helpers (${GRID_NAMES.length} names incl. an unknown one → linear) and the custom-curve helper == engine/easing.ts on a 1201-point grid`, !gridBad.length, gridBad.slice(0, 4).join(" | "));
}

// ---- 3. the worklets Babel plugin's output on an emulated UI runtime ---------------------------
function makeUiRuntime() {
  const cache = new Map<any, any>();
  const deepFreeze = <T,>(o: T): T => {
    if (o && typeof o === "object") {
      Object.freeze(o);
      for (const k of Object.keys(o)) deepFreeze((o as any)[k]);
    }
    return o;
  };
  const toUI = (v: any): any => {
    if (v === null || v === undefined) return v;
    if (typeof v === "function") {
      if (cache.has(v)) return cache.get(v);
      if (v.__workletHash && v.__initData?.code) {
        const fn = new Function(`"use strict"; return ${v.__initData.code};`)();
        const self: any = { __closure: undefined };
        const w: any = (...args: any[]) => fn.apply(self, args);
        w.__workletHash = v.__workletHash;
        cache.set(v, w);
        self.__closure = Array.isArray(v.__closure) ? v.__closure.map(toUI) : Object.fromEntries(Object.entries(v.__closure ?? {}).map(([k, x]) => [k, toUI(x)]));
        return w;
      }
      const remote: any = () => {
        throw new Error(`a JS function (${v.name || "anonymous"}) was called synchronously on the UI runtime`);
      };
      cache.set(v, remote);
      return remote;
    }
    if (typeof v === "object") return deepFreeze(structuredClone(v));
    return v;
  };
  return toUI;
}
if (!HAVE_HARNESS) {
  check("(ui) worklets plugin run skipped — skia-harness/node_modules is not installed (SKIA_HARNESS_REQUIRED=1 fails instead)", !process.env.SKIA_HARNESS_REQUIRED);
} else {
  const hreq = createRequire(path.join(HARNESS, "package.json"));
  const babel = hreq("@babel/core");
  const dir = path.join(tmpRoot, "ui");
  fs.mkdirSync(dir, { recursive: true });
  const transform = (src: string, name: string) => {
    // (The plugin re-reads the source file for each worklet's code string.)
    fs.writeFileSync(path.join(dir, `${name}.ts`), src);
    const out = babel.transformSync(src, {
      filename: path.join(dir, `${name}.ts`),
      babelrc: false,
      configFile: false,
      presets: [[hreq.resolve("@babel/preset-typescript")]],
      plugins: [[hreq.resolve("react-native-worklets/plugin")]],
    });
    return out.code.replace(/from "\.\/toolbox-timeline"/g, `from ${JSON.stringify(pathToFileURL(path.join(dir, "toolbox-timeline.ui.mjs")).href)}`);
  };
  fs.writeFileSync(path.join(dir, "toolbox-timeline.ui.mjs"), transform(runtimeSource, "toolbox-timeline"));
  fs.writeFileSync(path.join(dir, "procedural.ui.mjs"), transform(moduleSrc, "procedural"));
  const mod = await import(pathToFileURL(path.join(dir, "procedural.ui.mjs")).href);
  const toUI = makeUiRuntime();
  const notWorklets = refs.map((_, i) => proceduralFnName(caseKey(i))).filter((n) => !mod[n]?.__workletHash);
  check("every emitted P_ function is a worklet after the plugin", !notWorklets.length, notWorklets.slice(0, 4).join(", "));
  const mismatch: string[] = [];
  let compared = 0;
  refs.forEach((r, i) => {
    let fn: (t: number) => number;
    try {
      fn = toUI(mod[proceduralFnName(caseKey(i))]);
    } catch (e) {
      mismatch.push(`${r.name}: rebuilding the worklet threw ${(e as Error).message}`);
      return;
    }
    for (let k = 0; k < r.ticks.length; k++) {
      compared++;
      let got: number;
      try {
        got = fn(r.ticks[k]);
      } catch (e) {
        mismatch.push(`${r.name}: threw on the UI runtime — ${(e as Error).message}`);
        return;
      }
      if (!Object.is(got, r.want[k])) {
        mismatch.push(`${r.name} @ tick ${r.ticks[k]}: engine ${r.want[k]}, ui ${got}`);
        return;
      }
    }
  });
  check(`(ui) the plugin's worklets, rebuilt from their code strings with only their closures, == the evaluator bit for bit (${compared} values)`, !mismatch.length, mismatch.slice(0, 6).join(" | "));
}

// ---- 4. declaration order (the TDZ trap) --------------------------------------------------------
function lateReads(src: string): string[] {
  const decl = /^(?:export )?(?:function (\w+)\(|const (\w+)\b|let (\w+)\b)/gm;
  const found: { name: string; at: number }[] = [];
  for (let m = decl.exec(src); m; m = decl.exec(src)) found.push({ name: m[1] ?? m[2] ?? m[3], at: m.index });
  const errs: string[] = [];
  found.forEach((d, i) => {
    // (Comments between declarations aren't code.)
    const body = src.slice(d.at, found[i + 1]?.at ?? src.length).replace(/\/\/[^\n]*/g, "");
    if (!/^\s*"worklet";/m.test(body.split("\n").slice(1, 3).join("\n"))) return;
    for (const later of found.slice(i + 1)) if (new RegExp(`\\b${later.name}\\b`).test(body)) errs.push(`${d.name} reads ${later.name}, declared below it`);
  });
  return errs;
}
check("lateReads() catches a worklet reading a constant declared below it", lateReads(`function a() {\n  "worklet";\n  return B.x;\n}\nconst B = { x: 1 };\n`).length === 1);
const orderErrs = lateReads(moduleSrc);
check("the emitted procedural module declares every helper and constant above the worklets that read them", !orderErrs.length, orderErrs.slice(0, 4).join("; "));

// ---- 5. baked: the SkSL backend on CanvasKit (F32) ----------------------------------------------
// One probe per case: pixel i evaluates the baked function at the i-th tick
// (frame floor(i / 4), sub-frame (i mod 4) · 250 ticks — exact integers, the
// ticks tbk_tick snaps a frame-aligned iTime to).
const BAKED_HELPER_ORDER = ["math", "spring", "bezier", "oklab", "q8"] as const;
function probeSksl(prog: ProcProgram, label: string): { sksl: string; problems: string[] } {
  const gen = new bk.BakeGen(TL);
  const r = P.bakeProcedural(gen, prog, label);
  if (!r) return { sksl: "", problems: gen.problems };
  const lines = [
    `uniform float iTime;`,
    ...BAKED_HELPER_ORDER.filter((h) => gen.helpers.has(h)).flatMap((h) => ["", bk.BAKED_HELPERS[h]]),
    ...gen.fns.flatMap((f) => ["", f]),
    "",
    `half4 main(float2 p) {`,
    `  float i = floor(p.x);`,
    `  float fr = floor(i / ${SUBS.length}.0 + 1e-4);`,
    `  float tk = fr * ${TPF}.0 + (i - ${SUBS.length}.0 * fr) * ${SUBS[1]}.0;`,
    `  return half4(${r.fn}(tk), 0.0, 0.0, 1.0);`,
    `}`,
  ];
  return { sksl: lines.join("\n"), problems: [] };
}
function runProbe(sksl: string, n: number): Float32Array | string {
  const errs: string[] = [];
  const e = CK.RuntimeEffect.Make(sksl, (m: string) => errs.push(m));
  if (!e) return `CanvasKit: ${errs.join("; ")}`;
  const mem = CK.Malloc(Float32Array, n * 4);
  const surf = CK.MakeRasterDirectSurface({ width: n, height: 1, colorType: CK.ColorType.RGBA_F32, alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB }, mem, n * 16);
  const paint = new CK.Paint();
  paint.setBlendMode(CK.BlendMode.Src);
  const shader = e.makeShader(new Float32Array([0]));
  paint.setShader(shader);
  surf.getCanvas().drawPaint(paint);
  surf.flush();
  const out = Float32Array.from((mem.toTypedArray() as Float32Array).filter((_, k) => k % 4 === 0));
  shader.delete();
  paint.delete();
  surf.delete();
  CK.Free(mem);
  e.delete();
  return out;
}
// The first-order fp32 error bound of a program at a tick: running error
// analysis on the double evaluation. Every operation's result carries
// e = Σ |∂f/∂xᵢ| · eᵢ + its own rounding — u · |v| for + − × (u = 2⁻²⁴), 2u
// for ÷ (Skia may multiply by the reciprocal), 16u · max(1, |v|) for the
// polynomial transcendentals, the easing / curve / phase helpers and a
// track's interpolation; literals carry their exact fp32 representation
// error, the probe's integer ticks none. Partial derivatives are numerical
// (central, in double); step-like functions (floor, round, comparisons…)
// contribute none — landing on the other side of their jump is the jump
// check's business. What this bounds is what fp32 can do at all: a product
// with b ≈ 2.4 carries the LFO's phase rounding × 2.4, asin near ±1 and
// 1 / √a near 0 amplify without limit — so the gate holds baked SkSL to a
// small multiple of it, and reports where it permits 1e-6.
const U32 = 2 ** -24;
const STEP_FNS = new Set(["floor", "ceil", "round", "trunc", "sign", "frameOf", "isFinite"]);
const EXACT_FNS = new Set(["abs", "min", "max", "fround", "toNum", "clamp", "saturate"]);
// NaN when the double evaluation itself passes through a non-finite value
// (a domain error the engine's toNum later maps to 0): fp32 GPU code makes no
// NaN / Infinity promise, so those samples are counted, not held.
function fp32Bound(prog: ProcProgram, tick: number): number {
  type VE = { v: number; e: number };
  const slots: VE[] = [];
  const fns = new Map<string, (...a: number[]) => number>();
  let nonFinite = false;
  const fnOf = (name: string) => {
    let f = fns.get(name);
    if (!f) fns.set(name, (f = P.fnImpl(name, prog)));
    return f;
  };
  const ev = (x: any): VE => {
    const r = ev0(x);
    if (!Number.isFinite(r.v)) nonFinite = true;
    return r;
  };
  const ev0 = (x: any): VE => {
    switch (x.k) {
      case "lit":
        return { v: x.v, e: Number.isFinite(x.v) ? Math.abs(Math.fround(x.v) - x.v) : 0 };
      case "slot":
        return slots[x.i];
      case "tick":
        return { v: tick, e: 0 };
      case "bin": {
        const a = ev(x.a);
        const b = ev(x.b);
        switch (x.op) {
          case "+":
          case "-": {
            const v = x.op === "+" ? a.v + b.v : a.v - b.v;
            return { v, e: a.e + b.e + U32 * Math.abs(v) };
          }
          case "*": {
            const v = a.v * b.v;
            return { v, e: Math.abs(b.v) * a.e + Math.abs(a.v) * b.e + U32 * Math.abs(v) };
          }
          case "/": {
            const v = a.v / b.v;
            return { v, e: a.e / Math.abs(b.v) + (Math.abs(a.v) * b.e) / (b.v * b.v) + 2 * U32 * Math.abs(v) };
          }
          case "%": {
            const v = a.v % b.v;
            const q = Math.trunc(a.v / b.v);
            return { v, e: a.e + Math.abs(q) * b.e + 2 * U32 * Math.abs(a.v) };
          }
          case "**": {
            const v = a.v ** b.v;
            const da = Math.abs(b.v * a.v ** (b.v - 1));
            const db = Math.abs(v * Math.log(Math.abs(a.v)));
            return { v, e: (Number.isFinite(da) ? da : 0) * a.e + (Number.isFinite(db) ? db : 0) * b.e + 16 * U32 * Math.max(1, Math.abs(v)) };
          }
        }
        break;
      }
      case "cmp": {
        const a = ev(x.a).v;
        const b = ev(x.b).v;
        const v = x.op === "<" ? a < b : x.op === "<=" ? a <= b : x.op === ">" ? a > b : x.op === ">=" ? a >= b : x.op === "==" ? a === b : a !== b;
        return { v: v ? 1 : 0, e: 0 };
      }
      case "neg": {
        const a = ev(x.a);
        return { v: -a.v, e: a.e };
      }
      case "not":
        return { v: ev(x.a).v ? 0 : 1, e: 0 };
      case "and": {
        const a = ev(x.a);
        return a.v ? ev(x.b) : a;
      }
      case "or": {
        const a = ev(x.a);
        return a.v ? a : ev(x.b);
      }
      case "cond":
        return ev(x.c).v ? ev(x.a) : ev(x.b);
      case "call": {
        const args: VE[] = x.args.map(ev);
        const f = fnOf(x.fn);
        const vs = args.map((a) => a.v);
        const v = f(...vs);
        if (STEP_FNS.has(x.fn)) return { v, e: 0 };
        let e = 0;
        args.forEach((a, i) => {
          if (!a.e) return;
          const h = 1e-6 * Math.max(1, Math.abs(a.v));
          const at = (dx: number) => {
            const xs = vs.slice();
            xs[i] += dx;
            return f(...xs);
          };
          // Central where both sides exist; one-sided at a domain edge (acos
          // at 1, √ at 0); unbounded where neither does.
          const up = at(h);
          const dn = at(-h);
          const d = Number.isFinite(up) && Number.isFinite(dn) ? (up - dn) / (2 * h) : Number.isFinite(up) ? (up - v) / h : Number.isFinite(dn) ? (v - dn) / h : Infinity;
          e += Math.abs(d) * a.e;
        });
        const own = x.fn === "fixed6" ? 5e-7 : EXACT_FNS.has(x.fn) ? 0 : x.fn === "sqrt" ? 2 * U32 * Math.abs(v) : 16 * U32 * Math.max(1, Math.abs(v));
        return { v, e: e + own };
      }
      case "track": {
        const at = ev(x.at);
        const t = prog.tracks[x.t];
        const v = rtEval(t, at.v) as number;
        const d = ((rtEval(t, at.v + 0.5) as number) - (rtEval(t, at.v - 0.5) as number)) / 1;
        return { v, e: (Number.isFinite(d) ? Math.abs(d) : 0) * at.e + 16 * U32 * Math.max(1, Math.abs(v)) };
      }
    }
    throw new Error(`fp32Bound: ${x.k}`);
  };
  for (const s of prog.body) slots.push(s.k === "let" ? ev(s.e) : { v: 0, e: 0 });
  const out = ev(prog.out);
  return nonFinite ? NaN : out.e;
}
const { evaluateTrack: rtEval } = await import("@/lib/skia-export/runtime/toolbox-timeline");
{
  // Held: |baked − worklet| ≤ 4 × the fp32 bound (+ 1e-12) at every sample, or
  // the baked value is the worklet's just to one side of a jump.
  const K = 4;
  const rows: { name: string; max: number; ratio: number; flips: number; at: string; chain: boolean }[] = [];
  const failed: string[] = [];
  const refusedOk: string[] = [];
  let flipsTotal = 0;
  let samples = 0;
  let permits = 0;
  let worstPermitted = 0;
  let over1e6 = 0;
  let nonFiniteSamples = 0;
  for (const r of refs) {
    const chain = r.program.nodes.length > 1;
    const pr = probeSksl(r.program, r.name);
    if (r.c.random || r.c.bakeRefusal) {
      const re = r.c.bakeRefusal ?? /integer (hashing|math)/;
      if (pr.problems.length && pr.problems.every((p) => re.test(p))) refusedOk.push(r.name);
      else failed.push(`${r.name}: expected a bake refusal (${re}), got ${pr.problems.join("; ") || "SkSL"}`);
      continue;
    }
    if (pr.problems.length) {
      failed.push(`${r.name}: ${pr.problems.join("; ")}`);
      continue;
    }
    const out = runProbe(pr.sksl, r.ticks.length);
    if (typeof out === "string") {
      failed.push(`${r.name}: ${out}`);
      continue;
    }
    let max = 0;
    let ratio = 0;
    let at = "";
    let flips = 0;
    let bad = "";
    for (let k = 0; k < r.ticks.length; k++) {
      const w = r.want[k];
      const b = out[k];
      const E = fp32Bound(r.program, r.ticks[k]);
      if (!Number.isFinite(w) || Number.isNaN(E)) {
        // A non-finite value on the way (Math.sqrt(−1), asin(1.2), pow(−x, ½),
        // 1 / 0 — the engine's toNum maps the result to 0): fp32 GPU code makes
        // no NaN / Infinity promise, so these are counted, not held.
        nonFiniteSamples++;
        continue;
      }
      samples++;
      const scale = Math.max(1, Math.abs(w));
      const err = Math.abs(b - w);
      if (err <= K * E + 1e-12) {
        if (K * E <= 1e-6 * scale) {
          permits++;
          worstPermitted = Math.max(worstPermitted, err / scale);
        }
        if (err / scale > 1e-6) over1e6++;
        if (!r.c.jumps && err / scale > max) {
          max = err / scale;
          at = `tick ${r.ticks[k]}`;
        }
        if (E > 0) ratio = Math.max(ratio, err / E);
        continue;
      }
      // A jump: the baked value must be the worklet's just to one side of the tick.
      const side = Math.min(Math.abs(b - P.evaluateProgram(r.program, r.ticks[k] - 0.05)), Math.abs(b - P.evaluateProgram(r.program, r.ticks[k] + 0.05))) / scale;
      if (r.c.jumps && side <= 1e-4) {
        flips++;
        continue;
      }
      if (!bad) bad = `tick ${r.ticks[k]}: worklet ${w}, baked ${b} (err ${(err / scale).toExponential(2)}, fp32 bound ${E.toExponential(2)}, side ${side.toExponential(2)})`;
    }
    flipsTotal += flips;
    rows.push({ name: r.name, max, ratio, flips, at, chain });
    if (bad) failed.push(`${r.name}: ${bad}`);
  }
  const single = rows.filter((r) => !r.chain);
  check(
    `baked SkSL (CanvasKit CPU, F32) within ${K}× the fp32 error bound of the worklet at every sample: ${rows.length} cases × ${refs[0]?.ticks.length ?? 0} ticks (${samples} finite samples; worst error / bound ${Math.max(0, ...rows.map((r) => r.ratio)).toFixed(2)}); ${flipsTotal} samples on a jump's other side, each proven at the jump`,
    !failed.length,
    failed.slice(0, 6).join(" | ")
  );
  check(
    `…so where fp32 permits 1e-6 (${permits} samples, ${((100 * permits) / Math.max(1, samples)).toFixed(1)}%), baked is within 1e-6 × max(1, |v|): max ${worstPermitted.toExponential(2)}`,
    worstPermitted <= 1e-6
  );
  check(
    `the ${refusedOk.length} cases with no fp32 form (Random / random()'s integer hashing, an Infinity constant) refuse to bake with the reason`,
    refusedOk.length === refs.filter((r) => r.c.random || r.c.bakeRefusal).length
  );
  info(`${nonFiniteSamples} samples pass through a non-finite value in the engine (a domain error toNum maps to 0) — not held`);
  rows.sort((a, b) => b.max - a.max);
  const cont = (rs: typeof rows) => rs.filter((r) => !refs.find((x) => x.name === r.name)?.c.jumps);
  info(
    `continuous cases, max error × max(1, |v|): one driver node ${Math.max(0, ...cont(single).map((r) => r.max)).toExponential(2)} over ${cont(single).length} cases; chains ${Math.max(0, ...cont(rows.filter((r) => r.chain)).map((r) => r.max)).toExponential(2)} over ${cont(rows.filter((r) => r.chain)).length} (discontinuous cases: within the bound away from their jumps)`
  );
  info(`samples above 1e-6 × max(1, |v|): ${over1e6} of ${samples} (${((100 * over1e6) / Math.max(1, samples)).toFixed(2)}%) — each where the fp32 bound itself exceeds it`);
  {
    const fam = new Map<string, number>();
    for (const r of cont(single)) {
      const t = refs.find((x) => x.name === r.name)!.program.nodes[0]?.type ?? "?";
      fam.set(t, Math.max(fam.get(t) ?? 0, r.max));
    }
    info(`one continuous driver node, max error × max(1, |v|) by type: ${[...fam].map(([t, m]) => `${t} ${m.toExponential(2)}`).join(", ")}`);
  }
  info(`worst baked errors: ${rows.slice(0, 8).map((r) => `${r.name} ${r.max.toExponential(2)} @ ${r.at}${r.flips ? ` (+${r.flips} jump samples)` : ""}`).join("; ")}`);
}

// ---- 6. plan kinds and bundles ------------------------------------------------------------------
const g = fx.proceduralAuroraGraph(afx.AURORA_SKSL);
const req = { nodes: g.nodes, edges: g.edges, targetId: g.targetId, name: "Aurora (procedural)", canvas: { width: 512, height: 512 }, timeline: { ...TL, markers: fx.PROCEDURAL_MARKERS }, runtimeSource };
const outputsAt = (nodes: GraphNode[], edges: GraphEdge[], ids: string[]) => {
  const ctx: any = dataOnlyContext({ width: 64, height: 64 }, TL);
  const cache = new Map();
  return (tick: number) => {
    ctx.tick = tick;
    ctx.frame = Math.floor(tick / TPF);
    ctx.time = tick / (TPF * TL.fps);
    const r = evaluateGraph(nodes, edges, ctx, cache as any, null, undefined, null, { extraTargets: ids });
    return ids.map((id) => (r.outputs.get(id)?.primary as any)?.value);
  };
};
async function importBundle(files: Record<string, string>, slot: string) {
  const dir = path.join(tmpRoot, slot);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, text] of Object.entries(files)) if (!f.includes("/")) fs.writeFileSync(path.join(dir, f), text);
  return { dir, timeline: await import(pathToFileURL(path.join(dir, "timeline.ts")).href) };
}
{
  const { plan, problems } = planSkiaExport(g.nodes, g.edges, g.targetId, req);
  check("planSkiaExport: the procedural Aurora plans", !!plan, problems.join(" | "));
  const u = (n: string) => plan?.uniforms.find((x) => x.name === n);
  check(
    "SkSL Shader uniforms take procedural drivers: scale / drift_x / contrast → expr, c2 → a track, the rest static",
    !!u("scale")?.expr && !!u("drift_x")?.expr && !!u("contrast")?.expr && !!u("c2")?.track && u("octaves")?.value === 4,
    plan?.uniforms.map((x) => `${x.name}:${x.expr ? "expr" : x.track ? "track" : "static"}`).join(" ")
  );
  check("provenance names the compiled nodes", u("scale")?.from === "procedural: Expression scale_expr ← LFO wob", u("scale")?.from);
  // The parity fixture's drivers, baked, at every frame and sub-frame tick: ≤ 1e-6.
  {
    const rows: string[] = [];
    let worst = 0;
    for (const name of ["scale", "drift_x", "contrast"]) {
      const prog = u(name)!.expr!;
      const pr = probeSksl(prog, name);
      const n = FRAMES * SUBS.length;
      const out = pr.problems.length ? pr.problems.join("; ") : runProbe(pr.sksl, n);
      if (typeof out === "string") {
        rows.push(`${name}: ${out}`);
        continue;
      }
      let max = 0;
      for (let i = 0; i < n; i++) {
        const tick = Math.floor(i / SUBS.length) * TPF + (i % SUBS.length) * SUBS[1];
        const w = P.evaluateProgram(prog, tick);
        max = Math.max(max, Math.abs(out[i] - w) / Math.max(1, Math.abs(w)));
      }
      worst = Math.max(worst, max);
      rows.push(`${name} ${max.toExponential(2)}`);
    }
    check(`the parity fixture's three drivers, baked, vs the worklet at ${FRAMES * SUBS.length} ticks each: ≤ 1e-6 (${rows.join(", ")})`, worst <= 1e-6 && rows.every((r) => !r.includes(":")));
  }

  // Worklet bundle: sampleUniforms == the evaluator's driver outputs, every frame and between.
  const w = exportSkia(req);
  check("exportSkia (worklet) ships procedural.ts beside the timeline", !!w.files?.["procedural.ts"] && /import \{ P_scale, P_drift_x, P_contrast \} from "\.\/procedural"/.test(w.files["timeline.ts"]), w.problems.join(" | "));
  const m = JSON.parse(w.files!["manifest.json"]);
  check(
    "the manifest says which uniforms are procedural (and from which nodes)",
    m.procedural?.values?.join() === "scale,drift_x,contrast" && m.uniforms.find((x: any) => x.name === "contrast")?.procedural?.nodes?.join() === "expression contrast_expr,scene-time st" && m.uniforms.find((x: any) => x.name === "c2")?.procedural === undefined
  );
  const { timeline } = await importBundle(w.files!, "effect-worklet");
  const ev = outputsAt(g.nodes, g.edges, ["scale_expr", "lfo", "contrast_expr"]);
  let bad = "";
  let compared = 0;
  const { ticksAt } = await import("@/lib/skia-export/runtime/toolbox-timeline");
  for (let f = 0; f < FRAMES && !bad; f++) {
    for (const sub of [0, 1 / 3, 1 / 2]) {
      // The device clock is seconds; the tick is ticksAt(seconds) (exact on
      // frame-aligned times) — the engine evaluated at that same tick.
      const seconds = (f + sub) / TL.fps;
      const tick = ticksAt(seconds, TL.fps, TPF);
      const want = ev(tick);
      const got = timeline.sampleUniforms(seconds, 512, 512);
      const vals = [got.scale, got.drift_x, got.contrast];
      compared += 3;
      if (!vals.every((v: number, i: number) => Object.is(v, want[i]))) bad = `tick ${tick}: engine ${want} bundle ${vals}`;
    }
  }
  check(`emitted sampleUniforms == the evaluator's driver outputs, bit for bit (${compared} values: every frame + 2 sub-frame times)`, !bad, bad);
  queueTypecheck("effect-worklet", w.files!);

  // Baked: the drivers inside the SkSL; pixels vs the worklet bundle at every frame.
  const b = exportSkia({ ...req, animation: "baked" });
  check("exportSkia (baked) bakes the procedural uniforms into the SkSL", !!b.files && /float tbk_p0\(float tk\)/.test(b.files["effect.ts"]) && !("procedural.ts" in b.files) && !/scale:|drift_x:|contrast:/.test(b.files["timeline.ts"]), b.problems.join(" | "));
  const bm = b.files ? JSON.parse(b.files["manifest.json"]) : {};
  check(
    "the baked manifest lists them as baked procedural values",
    bm.baked?.programs?.[0]?.baked?.filter((x: any) => x.kind === "procedural").map((x: any) => x.name).join() === "scale,drift_x,contrast" && bm.uniforms?.find((x: any) => x.name === "scale")?.procedural?.nodes?.length === 2
  );
  if (b.files) {
    const bakedSksl = JSON.parse(/export const SKSL = (".*");/.exec(b.files["effect.ts"])![1]);
    const workletSksl = JSON.parse(/export const SKSL = (".*");/.exec(w.files!["effect.ts"])![1]);
    const { timeline: bt } = await importBundle(b.files, "effect-baked");
    const render = (sksl: string, values: Record<string, number | number[]>): Uint8Array => {
      const e = CK.RuntimeEffect.Make(sksl);
      const flat: number[] = [];
      for (let i = 0; i < e.getUniformCount(); i++) {
        const name = e.getUniformName(i);
        const v = values[name];
        if (v === undefined) throw new Error(`no value for ${name}`);
        flat.push(...(typeof v === "number" ? [v] : v));
      }
      const surf = CK.MakeSurface(SIZE, SIZE);
      const paint = new CK.Paint();
      paint.setBlendMode(CK.BlendMode.Src);
      const sh = e.makeShader(new Float32Array(flat));
      paint.setShader(sh);
      surf.getCanvas().drawPaint(paint);
      surf.flush();
      const img = surf.makeImageSnapshot();
      const px = img.readPixels(0, 0, { width: SIZE, height: SIZE, colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB }) as Uint8Array;
      img.delete();
      sh.delete();
      paint.delete();
      surf.delete();
      e.delete();
      return px;
    };
    let max = 0;
    let differ = 0;
    for (let f = 0; f < FRAMES; f++) {
      const s = f / TL.fps;
      const pa = render(workletSksl, timeline.sampleUniforms(s, SIZE, SIZE));
      const pb = render(bakedSksl, bt.sampleUniforms(s, SIZE, SIZE));
      for (let i = 0; i < pa.length; i++) {
        const d = Math.abs(pa[i] - pb[i]);
        if (d) differ++;
        if (d > max) max = d;
      }
    }
    check(`baked Aurora vs the worklet bundle, CanvasKit CPU ${SIZE}², EVERY frame (${FRAMES}): max ${max}/255 (${differ} channel values differ)`, max <= 1);
    queueTypecheck("effect-baked", b.files);
  }

  // Native: the drivers read the linear clock.
  const n = exportSkia({ ...req, animation: "native" });
  check(
    "exportSkia (native): procedural uniforms evaluate from the linear clock's tick",
    !!n.files?.["procedural.ts"] && /const tick = ticksAt\(A\.clock\.value, 60, 1000\);/.test(n.files["ToolboxEffect.tsx"]) && /scale: P_scale\(tick\)/.test(n.files["ToolboxEffect.tsx"]) && /export function clockAnimation/.test(n.files["animations.ts"]),
    n.problems.join(" | ")
  );
  if (n.files) {
    queueTypecheck("effect-native", n.files);
    const ord = ["procedural.ts", "animations.ts", "toolbox-native.ts"].flatMap((f) => (n.files![f] ? lateReads(n.files![f]).map((e) => `${f}: ${e}`) : []));
    check("…and its modules declare every worklet callee above its callers", !ord.length, ord.join("; "));
  }
  for (const [label, files] of [["worklet", w.files], ["baked", b.files]] as const) {
    const ord = files ? Object.entries(files).flatMap(([f, s]) => (f.endsWith(".ts") && f !== "toolbox-timeline.ts" ? lateReads(s).map((e) => `${f}: ${e}`) : [])) : [];
    check(`${label} bundle: no worklet reads a declaration below it`, !ord.length, ord.join("; "));
  }
}

// A Skia-layer scene on procedural drivers: Aurora (Skia) with Noise (Skia)'s
// scale / offset_x / contrast on the drivers, plus a Skia Circle whose radius
// (canvas01 × width, a BindRef.scale) follows an LFO.
function sceneGraph(mut?: (n: GraphNode[], e: GraphEdge[]) => void) {
  const base = auroraSceneGraph(afx.AURORA_SKSL);
  const p = fx.proceduralAuroraGraph(afx.AURORA_SKSL);
  const drivers = p.nodes.filter((x) => ["lfo", "wob", "scale_expr", "st", "contrast_expr"].includes(x.id));
  const nodes: GraphNode[] = [...base.nodes.filter((x) => !["drift", "scale", "contrast"].includes(x.id)), ...drivers];
  const keep = base.edges.filter((e) => !["drift", "scale", "contrast"].includes(e.source));
  const e = (source: string, target: string, targetHandle: string): GraphEdge => ({ id: `${source}->${target}:${targetHandle}`, source, sourceHandle: "out:primary", target, targetHandle });
  const edges: GraphEdge[] = [
    ...keep,
    ...p.edges.filter((x) => x.target !== "aurora"),
    e("lfo", "skn", "in:param:offset_x"),
    e("scale_expr", "skn", "in:param:scale"),
    e("contrast_expr", "skn", "in:param:contrast"),
  ];
  mut?.(nodes, edges);
  return { nodes, edges };
}
{
  const s = sceneGraph();
  const sreq = { ...req, nodes: s.nodes, edges: s.edges, targetId: "skc", name: "Aurora scene (procedural)" };
  const sampler = makeSceneSampler(s.nodes, s.edges, "skc", sreq.canvas, TL);
  if ("problem" in sampler) throw new Error(sampler.problem);
  const scene0 = sampler.sampleAt(0)!;
  const r = exportSkiaScene(scene0, s.nodes, s.edges, { name: sreq.name, timeline: TL, runtimeSource, sampleAt: (t) => sampler.sampleAt(t) });
  const exprBinds = r.binds.filter((b) => b.plan.kind === "expr");
  check(
    "scene binds driven by procedural drivers plan as kind \"expr\" (Noise (Skia) scale / offset_x / contrast uniforms)",
    !!r.files && exprBinds.length === 3 && exprBinds.every((b) => /uniforms\.nskn_(scale|offset_x|contrast)$/.test(b.path)),
    `${r.problems.join(" | ")} ${r.binds.map((b) => `${b.path.split(".").slice(-1)}:${b.plan.kind}`).join(" ")}`
  );
  if (r.files) {
    const man = JSON.parse(r.files["manifest.json"]);
    check("the scene manifest counts and flags them", man.bindCounts.expr === 3 && man.binds.filter((b: any) => b.kind === "expr").every((b: any) => b.procedural?.nodes?.length >= 1) && !!r.files["procedural.ts"]);
    const { timeline } = await importBundle(r.files, "scene-worklet");
    let bad = "";
    for (let f = 0; f < FRAMES && !bad; f++) {
      const sc = sampler.sampleAt(f * TPF)!;
      const byPath = new Map(collectBinds(sc.root).map((fb) => [fb.path, fb.bind.v]));
      const out = timeline.sampleBinds(f / TL.fps);
      for (const b of man.binds.filter((x: any) => x.kind === "expr")) {
        if (!Object.is(out[b.sample], byPath.get(b.path))) bad = `frame ${f} ${b.path}: producer ${byPath.get(b.path)} bundle ${out[b.sample]}`;
      }
    }
    check(`emitted sampleBinds == the producer's bound values for every expr bind at every frame (${FRAMES})`, !bad, bad);
  }
  // A BindRef.scale on an expr: Skia Circle's center x = centerX · width,
  // centerX ← an LFO.
  {
    const c = sceneGraph((n, e) => {
      n.push({ id: "circ_x", type: "lfo", params: { shape: "sine", frequency: 0.8, phase: 0, amplitude: 0.2, offset: 0.5 } });
      n.push({
        id: "circle",
        type: "skia-circle",
        params: { centerX: 0.5, centerY: 0.5, radiusX: 0.1, radiusY: 0.1, fill_enabled: true, fill_color: "#ffffff", stroke_enabled: false, opacity: 1 },
        exposedParams: ["centerX"],
      });
      n.push({ id: "grp", type: "skia-group", params: {} });
      const fillEdge = e.find((x) => x.source === "skf" && x.target === "skc")!;
      fillEdge.target = "grp";
      fillEdge.targetHandle = "in:child1";
      e.push({ id: "c->grp", source: "circle", sourceHandle: "out:primary", target: "grp", targetHandle: "in:child2" });
      e.push({ id: "grp->skc", source: "grp", sourceHandle: "out:primary", target: "skc", targetHandle: "in:scene" });
      e.push({ id: "x->circle", source: "circ_x", sourceHandle: "out:primary", target: "circle", targetHandle: "in:param:centerX" });
    });
    const res = await checkExportable({ nodes: c.nodes, edges: c.edges, canvasId: "skc", slot: "procedural-scene", canvas: { width: 512, height: 512 }, timeline: TL });
    const sm = res.files ? JSON.parse(res.files["manifest.json"]) : null;
    const rb = sm?.binds.find((b: any) => b.kind === "expr" && b.scale !== undefined);
    if (res.files) queueTypecheck("scene-worklet", res.files);
    check(
      "a scaled ref (Skia Circle centerX × width) on an LFO plans as expr × scale; its programs compile in CanvasKit with exactly the bundle's uniforms",
      !!res.files && !!rb && res.programs.every((p) => p.ok),
      [...res.problems, ...res.programs.filter((p) => !p.ok).map((p) => p.detail)].join(" | ") || JSON.stringify(sm?.bindCounts)
    );
    if (res.files && rb) {
      const { timeline } = await importBundle(res.files, "scene-scaled");
      const sp = makeSceneSampler(c.nodes, c.edges, "skc", { width: 512, height: 512 }, TL);
      if ("problem" in sp) throw new Error(sp.problem);
      let bad = "";
      for (let f = 0; f < FRAMES && !bad; f++) {
        const byPath = new Map(collectBinds(sp.sampleAt(f * TPF)!.root).map((fb) => [fb.path, fb.bind.v]));
        const got = timeline.sampleBinds(f / TL.fps)[rb.sample];
        if (!closeValue(got, byPath.get(rb.path))) bad = `frame ${f}: producer ${byPath.get(rb.path)} bundle ${got}`;
      }
      check("…and its sampleBinds equal the producer (within float rounding of the scale) at every frame", !bad, bad);
    }
    for (const animation of ["baked", "native"] as const) {
      const ra = await checkExportable({ nodes: c.nodes, edges: c.edges, canvasId: "skc", slot: `procedural-scene-${animation}`, canvas: { width: 512, height: 512 }, timeline: TL, animation });
      const am = ra.files ? JSON.parse(ra.files["manifest.json"]) : null;
      if (ra.files) queueTypecheck(`scene-${animation}`, ra.files);
      const ok =
        animation === "baked"
          ? am?.baked?.programs?.flatMap((p: any) => p.baked).filter((x: any) => x.kind === "procedural").length === 3 && am.baked.worklet.kinds.expr === 1
          : !!ra.files?.["procedural.ts"] && /const time = A\.clock;/.test(ra.files["ToolboxScene.tsx"]);
      check(
        animation === "baked"
          ? "baked scene: the three program uniforms bake as procedural SkSL; the circle's center (not a program uniform) stays on the worklet"
          : "native scene: expr binds stay in sampleBinds, read from the linear clock",
        !!ra.files && ok && ra.programs.every((p) => p.ok),
        [...ra.problems, ...ra.programs.filter((p) => !p.ok).map((p) => `${p.where}: ${p.detail}`)].join(" | ") || JSON.stringify(am?.baked?.worklet ?? am?.bindCounts)
      );
    }
  }

  // ---- 7. fallbacks and refusals --------------------------------------------------------------
  const sceneWith = (src: string, mut?: (n: GraphNode[], e: GraphEdge[]) => void) => {
    const gg = sceneGraph((n, e) => {
      const ex = n.find((x) => x.id === "scale_expr")!;
      ex.params = { ...ex.params, expression: src };
      mut?.(n, e);
    });
    return exportSkia({ ...sreq, nodes: gg.nodes, edges: gg.edges });
  };
  {
    const r1 = sceneWith("3.4 + (x * 8 & 3) * 0.1");
    check(
      "unsupported syntax in a scene driver (a bitwise &) falls back to sampling, with a warning naming it",
      !!r1.files && r1.warnings.some((w) => /doesn't compile to a worklet: .*bitwise operators .* — sampled per frame instead/.test(w)) && JSON.parse(r1.files["manifest.json"]).bindCounts.sampled >= 1,
      [...r1.problems, ...r1.warnings].join(" | ")
    );
    const r2 = sceneWith("3.4 + Math.random() * 0.1");
    check("Math.random() in a scene driver refuses (the editor itself never repeats it)", !r2.files && r2.problems.some((p) => /Math\.random/.test(p)), r2.problems.join(" | "));
    const r3 = sceneWith("3.4", (n) => {
      n.find((x) => x.id === "lfo")!.clips = [{ id: "c", enabled: true, inTick: 0, outTick: 60_000, sourceInTick: 0 } as any];
    });
    check("a clip window on a driver refuses", !r3.files && r3.problems.some((p) => /clip window/.test(p)), r3.problems.join(" | "));
    const r4 = sceneWith("3.4", (n) => {
      n.find((x) => x.id === "lfo")!.bypassed = true;
    });
    check("a bypassed driver refuses", !r4.files && r4.problems.some((p) => /bypassed/.test(p)), r4.problems.join(" | "));
    const r5 = sceneWith("x", (n, e) => {
      n.push({ id: "sm", type: "smooth", params: {} });
      e.push({ id: "sm->lfo", source: "sm", sourceHandle: "out:primary", target: "wob", targetHandle: "in:clock" });
    });
    check("a stateful node upstream (Smooth) refuses — it isn't a driver the exporter compiles", !r5.files && r5.problems.some((p) => /"sm" \(smooth\) feeds the driver/.test(p)), r5.problems.join(" | "));
  }
  {
    // SkSL Shader target: refusals carry the reason, random() / Random refuse to bake.
    const mutate = (src: string, extra?: (n: GraphNode[], e: GraphEdge[]) => void) => {
      const gg = fx.proceduralAuroraGraph(afx.AURORA_SKSL);
      gg.nodes.find((x) => x.id === "scale_expr")!.params.expression = src;
      extra?.(gg.nodes, gg.edges);
      return gg;
    };
    const a = mutate("3.4 + (x & 1)");
    const ra = exportSkia({ ...req, nodes: a.nodes, edges: a.edges });
    check("SkSL Shader: an unsupported expression refuses with the reason (no sampler there)", !ra.files && ra.problems.some((p) => /Channel "scale" is driven by expression "scale_expr", which doesn't compile for export: .*bitwise/.test(p)), ra.problems.join(" | "));
    const rnd = mutate("3.4 + random() * 0.2");
    const rw = exportSkia({ ...req, nodes: rnd.nodes, edges: rnd.edges });
    const rb = exportSkia({ ...req, nodes: rnd.nodes, edges: rnd.edges, animation: "baked" });
    check(
      "random() exports on the worklet and refuses to bake, with the reason",
      !!rw.files && /tbxRand\(/.test(rw.files["procedural.ts"]) && !rb.files && rb.problems.some((p) => /random\(\).*no fp32 SkSL form.*worklet/.test(p)),
      [...rw.problems, ...rb.problems].join(" | ")
    );
    const fm = mutate("x", (n, e) => {
      n.push({ id: "rf", type: "random", params: { mode: "frame" } });
      e.push({ id: "rf->s", source: "rf", sourceHandle: "out:primary", target: "scale_expr", targetHandle: fx.exprInput("scale_expr", "x") });
      const i = e.findIndex((x) => x.source === "wob");
      e.splice(i, 1);
    });
    const rf = exportSkia({ ...req, nodes: fm.nodes, edges: fm.edges });
    check("Random in frame mode refuses", !rf.files && rf.problems.some((p) => /frame mode/.test(p)), rf.problems.join(" | "));
    const vec = mutate("x", (n, e) => {
      n.push({ id: "rv", type: "random", params: { mode: "seeded", shape: "vec2" } });
      e.push({ id: "rv->s", source: "rv", sourceHandle: "out:primary", target: "scale_expr", targetHandle: fx.exprInput("scale_expr", "x") });
      const i = e.findIndex((x) => x.source === "wob");
      e.splice(i, 1);
    });
    const rv = exportSkia({ ...req, nodes: vec.nodes, edges: vec.edges });
    check("a vec2 wired into a scalar input refuses (the editor coerces it to nothing)", !rv.files && rv.problems.some((p) => /vector into a scalar socket/.test(p)), rv.problems.join(" | "));
    const mu = mutate("x", (n, e) => {
      n.push({ id: "mu", type: "math", params: { mode: "uv", operation: "Add" } });
      e.push({ id: "mu->s", source: "mu", sourceHandle: "out:primary", target: "scale_expr", targetHandle: fx.exprInput("scale_expr", "x") });
      const i = e.findIndex((x) => x.source === "wob");
      e.splice(i, 1);
    });
    const rmu = exportSkia({ ...req, nodes: mu.nodes, edges: mu.edges });
    check("Math in uv mode refuses (a per-pixel shader, not a value)", !rmu.files && rmu.problems.some((p) => /uv mode/.test(p)), rmu.problems.join(" | "));
    const cv = mutate("x");
    cv.nodes.find((x) => x.id === "scale_expr")!.params.out_type = "curve";
    const rcv = exportSkia({ ...req, nodes: cv.nodes, edges: cv.edges });
    check("an Expression in curve mode refuses (a float curve isn't a value)", !rcv.files && rcv.problems.some((p) => /float curve/.test(p)), rcv.problems.join(" | "));
  }
}

// ---- 8. type-check + the harness slots ---------------------------------------------------------
{
  // One tsc run over every bundle above (each in its own folder).
  const tc = typecheckBundle(typecheckFiles, "procedural");
  check(`every emitted bundle (${[...typecheckSlots].join(", ")}) type-checks in skia-harness against react-native-skia 3.4.0 + Reanimated 4.7${tc.ran ? "" : ` (${tc.output})`}`, tc.ok, tc.output);
}
for (const [slot, animation] of [["bundle-procedural", undefined], ["bundle-procedural-baked", "baked"]] as const) {
  const dir = path.join(HARNESS, "src", slot);
  const r = exportSkia({ ...req, animation });
  const stale = !r.files
    ? ["(export failed)"]
    : Object.entries(r.files).flatMap(([f, text]) => {
        const p = path.join(dir, f);
        return !fs.existsSync(p) || !sameUpToFloatNoise(fs.readFileSync(p, "utf8"), text) ? [f] : [];
      });
  const extra = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !r.files || !(f in r.files)) : [];
  check(
    `skia-harness/src/${slot} is byte-identical to a fresh export (re-export: npx tsx scripts/export-skia.mts --fixture procedural${animation ? ` --animation ${animation}` : ""} --out skia-harness/src/${slot})`,
    !stale.length && !extra.length,
    [...stale.map((f) => `stale ${f}`), ...extra.map((f) => `extra ${f}`)].join(", ")
  );
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
