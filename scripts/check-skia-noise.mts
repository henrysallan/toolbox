// check-skia-noise: the noise & fields family gate (specdocs/101326_skia-target.md
// §7 Wave 2, family 1 — Noise (Skia) on all eleven algorithms + the looping
// evolution, Shape Cells (Skia), Lyapunov Fractal (Skia), Texture
// Coordinate (Skia)). CanvasKit in Node, CPU raster surfaces, no GPU:
//
//   1. library: every family function validates, compiles alone inside a
//      fused program and declares exactly the uniforms its binds supply;
//      entry names are prefix-free; only the looping variants and Shape
//      Cells read iTime;
//   2. node defs: mirrored ParamDefs, sockets, the variant each type ×
//      animated × UV wiring selects, reported options, the binds that are
//      not 1:1 (fps, the scaled phasor orientation, the derived arrays);
//   3. CPU references: Noise (Skia) vs engine/noise.ts (perlin, simplex,
//      value, phasor — offset, seed, aspect, W slice blend, contrast,
//      colors; and the looping evolution at fractional frames), Lyapunov
//      vs lyapunovExponent, Shape Cells' ramp walk vs makeColorRampSampler,
//      the float cell hash vs its JS twin, Texture Coordinate;
//   4. export: Skia Canvas graphs holding every port (every algorithm
//      static and looping, UV-wired, Lyapunov, Shape Cells, Texture
//      Coordinate) with Animated Value / keyframed params go through
//      checkExportable — no problems, every runtime program compiles with
//      exactly its uniforms, the bundle type-checks in skia-harness.
//
// The pixel proof against the GL nodes is compare:skia (Electron + GPU,
// not in this gate): scripts/fixtures/skia/noise-graph.ts.
//
//   npx tsx scripts/check-skia-noise.mts

/* eslint-disable @typescript-eslint/no-explicit-any */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { EasingPreset, KeyframeAnimationBlock } from "@/engine/keyframes";
import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type { ShaderExpr } from "@/engine/skia/shader-expr";
import type { SkslProgramIR } from "@/engine/skia/scene-ir";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { getNodeDef } = await import("@/engine/registry");
const lib = await import("@/engine/skia/library");
const { fuseShader } = await import("@/engine/skia/fuse");
const { bindStatic } = await import("@/engine/skia/scene-ir");
const { compileSksl, packUniforms } = await import("@/engine/skia/sksl-program");
const { shaderReadsTime } = await import("@/nodes/skia/fill");
const { makeColorRampSampler, COLOR_RAMP_INTERP_OPTIONS, COLOR_RAMP_SPACE_OPTIONS } = await import("@/engine/color-ramp");
const { fbmWithW, noiseFnFor, loopEvolutionOffset } = await import("@/engine/noise");
const { lyapunovExponent, sequenceFromParams } = await import("@/nodes/source/lyapunov");
const { lyapunovSteps } = await import("@/nodes/skia/lyapunov");
const { SKIA_NOISE_FUNCTION_IDS } = await import("@/nodes/skia/noise");
const { packRampStops } = await import("@/nodes/skia/color-ramp");
const { checkExportable } = await import("./skia/export-check.ts");

const require = createRequire(path.join(ROOT, "package.json"));
const CK = await require("canvaskit-wasm")();

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
function info(msg: string) {
  console.log(`info ${msg}`);
}

// ---- rendering on CanvasKit CPU surfaces ------------------------------------------

function programShader(p: SkslProgramIR): any {
  const r = compileSksl(CK, p.sksl);
  if (!r.effect) throw new Error(r.error);
  const values: Record<string, number | number[]> = {};
  for (const [k, b] of Object.entries(p.uniforms)) values[k] = b.v;
  return r.effect.makeShader(packUniforms(r.effect, values));
}

// Straight-alpha RGBA8, row 0 = top.
function renderShader(shader: any, w: number, h: number): Uint8Array {
  const surf = CK.MakeSurface(w, h);
  const canvas = surf.getCanvas();
  canvas.clear(CK.TRANSPARENT);
  const paint = new CK.Paint();
  paint.setShader(shader);
  paint.setBlendMode(CK.BlendMode.Src);
  canvas.drawPaint(paint);
  surf.flush();
  const img = surf.makeImageSnapshot();
  const px = img.readPixels(0, 0, {
    width: w,
    height: h,
    colorType: CK.ColorType.RGBA_8888,
    alphaType: CK.AlphaType.Unpremul,
    colorSpace: CK.ColorSpace.SRGB,
  }) as Uint8Array;
  img.delete();
  paint.delete();
  shader.delete();
  surf.delete();
  return px;
}

function fused(expr: ShaderExpr, w: number, h: number, time = 0): SkslProgramIR {
  const r = fuseShader(expr, { resolution: [w, h], time });
  if (!r.shader || r.shader.k !== "runtime") throw new Error(`fuse failed: ${r.problems.join(" | ")}`);
  return r.shader.program;
}

function uniformNames(sksl: string): Set<string> {
  const r = compileSksl(CK, sksl);
  const out = new Set<string>();
  if (!r.effect) return out;
  for (let i = 0; i < r.effect.getUniformCount(); i++) out.add(r.effect.getUniformName(i));
  return out;
}

const FPS = 60;
const TPF = 1000;
const ctxFor = (w: number, h: number, frame = 0): any => ({
  gl: {}, width: w, height: h, time: frame / FPS, frame: Math.floor(frame), tick: Math.round(frame * TPF), ticksPerFrame: TPF, fps: FPS,
  playing: false, offline: false, cursor: { x: 0, y: 0, active: false }, state: {},
});

function defaults(type: string): Record<string, unknown> {
  const def = getNodeDef(type)!;
  return Object.fromEntries(def.params.map((p) => [p.name, p.default]));
}

const quiet = <T,>(f: () => T): T => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return f();
  } finally {
    console.warn = warn;
  }
};

// The node's shader expression for these params (and wired shader inputs).
function exprOf(type: string, params: Record<string, unknown>, w = 64, h = 64, frame = 0, inputs: Record<string, ShaderExpr> = {}): ShaderExpr {
  const def = getNodeDef(type)!;
  const wired = Object.fromEntries(Object.entries(inputs).map(([k, e]) => [k, { kind: "skia_shader", expr: e }]));
  const out = quiet(() =>
    def.compute({ inputs: wired as any, auxIn: {}, params: { ...defaults(type), ...params }, ctx: ctxFor(w, h, frame), nodeId: "n", consumedOutputs: new Set(["primary"]) })
  ) as any;
  return out.primary.expr;
}

function render(type: string, params: Record<string, unknown>, w: number, h: number, frame = 0, inputs: Record<string, ShaderExpr> = {}): Uint8Array {
  return renderShader(programShader(fused(exprOf(type, params, w, h, frame, inputs), w, h, frame / FPS)), w, h);
}

const hexRgb = (hex: string): [number, number, number] => {
  const c = lib.parseSkslColor(hex);
  return [c[0], c[1], c[2]];
};
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

const NOISE_TYPES = getNodeDef("noise")!.params.find((p) => p.name === "type")!.options as string[];
const FAMILY = ["skia-noise", "skia-shape-cells", "skia-lyapunov", "skia-texture-coordinate"] as const;
const MIRROR: Record<(typeof FAMILY)[number], string> = {
  "skia-noise": "noise",
  "skia-shape-cells": "shape-cells",
  "skia-lyapunov": "lyapunov",
  "skia-texture-coordinate": "texture-coordinate",
};
const FAMILY_FNS = [...SKIA_NOISE_FUNCTION_IDS, "tbx.lyapunov@1", "tbx.lyapunov.uv@1", "tbx.shape_cells@1", "tbx.texcoord@1"];
// Lib params that are not a same-named toolbox param, by design.
const DERIVED = new Set(["fps", "seq", "seq_len", "ramp_pos", "ramp_color", "ramp_count"]);
const TEXCOORD: ShaderExpr = { k: "call", fn: "tbx.texcoord@1", node: "tc", params: {}, inputs: {} };

// ---- 1. the family's library functions ------------------------------------------------
{
  const fns = FAMILY_FNS.map((id) => lib.getSkslFunction(id));
  check(`all ${FAMILY_FNS.length} family functions are registered (11 types × static/loop × canvas/UV uv + Lyapunov ×2 + Shape Cells + Texture Coordinate)`, fns.every(Boolean) && SKIA_NOISE_FUNCTION_IDS.length === 44, FAMILY_FNS.filter((_, i) => !fns[i]).join());
  const bad = fns.flatMap((f) => (f ? lib.validateSkslFunction(f) : []));
  check("every family function validates", bad.length === 0, bad.join(" | "));
  const failed: string[] = [];
  const binds: string[] = [];
  for (const f of fns) {
    if (!f) continue;
    const params: Record<string, any> = {};
    for (const p of f.params) {
      const width = lib.skslTypeWidth(p.type);
      params[p.name] = bindStatic(p.count !== undefined || width > 1 ? new Array((p.count ?? 1) * width).fill(0.5) : 0.5);
    }
    const inputs = Object.fromEntries(f.inputs.map((i) => [i.name, lib.constExpr(`in-${i.name}`, [0.5, 0.25, 0.75, 1])]));
    const r = fuseShader({ k: "call", fn: f.id, node: "probe", params, inputs }, { resolution: [16, 16], time: 0.5 });
    if (!r.shader || r.shader.k !== "runtime") {
      failed.push(`${f.id}: ${r.problems.join(" ")}`);
      continue;
    }
    const c = compileSksl(CK, r.shader.program.sksl);
    if (!c.effect) {
      failed.push(`${f.id}: ${c.error.split("\n")[0]}`);
      continue;
    }
    const declared = uniformNames(r.shader.program.sksl);
    const supplied = new Set(Object.keys(r.shader.program.uniforms));
    if (declared.size !== supplied.size || [...declared].some((n) => !supplied.has(n))) binds.push(f.id);
    const readsTime = shaderReadsTime(r.shader);
    if (readsTime !== !!f.usesTime) binds.push(`${f.id}: reads iTime ${readsTime} but usesTime ${!!f.usesTime}`);
  }
  check(`every family function compiles alone in a fused program (${fns.length})`, failed.length === 0, failed.join(" | "));
  check("each declares exactly the uniforms its binds supply, and reads iTime iff usesTime", binds.length === 0, binds.join(" | "));
  const entries = fns.filter(Boolean).map((f) => f!.entry);
  const all = [...entries, ...lib.allSkslFunctions().map((f) => f.entry)];
  const clash = entries.filter((e) => all.some((o) => o !== e && o.startsWith(e)));
  check("no family entry name is a prefix of another library entry (gather copies rename by prefix)", clash.length === 0, clash.join());
  const timed = fns.filter((f) => f?.usesTime).map((f) => f!.id);
  check("only the looping variants and Shape Cells read the clock", timed.every((id) => id.includes(".loop") || id === "tbx.shape_cells@1") && timed.length === 23, `${timed.length}: ${timed.join()}`);
}

// ---- 2. node defs ---------------------------------------------------------------------------
{
  for (const type of FAMILY) {
    const def = getNodeDef(type);
    const orig = getNodeDef(MIRROR[type]);
    if (!def || !orig) {
      check(`${type} and ${MIRROR[type]} are registered`, false);
      continue;
    }
    check(
      `${type}: skia { class: "sksl", mirrors: "${MIRROR[type]}" }, shader primary + gated image preview`,
      def.skia?.class === "sksl" && def.skia.mirrors === MIRROR[type] && def.primaryOutput === "skia_shader" && def.auxOutputs.some((a) => a.name === "preview" && a.type === "image") && def.gatesOutputs === true
    );
    const drift = def.params.filter((p) => orig.params.find((o) => o.name === p.name) !== p).map((p) => p.name);
    check(`${type}: every param is the mirror's own ParamDef`, drift.length === 0, drift.join());
  }
  // Every lib param is fed by a same-named param, or is one of the derived extras.
  const unfed: string[] = [];
  for (const id of FAMILY_FNS) {
    const fn = lib.getSkslFunction(id)!;
    const type = id.startsWith("tbx.noise") ? "skia-noise" : id.startsWith("tbx.lyapunov") ? "skia-lyapunov" : id.startsWith("tbx.shape") ? "skia-shape-cells" : "skia-texture-coordinate";
    const def = getNodeDef(type)!;
    for (const p of fn.params) if (!DERIVED.has(p.name) && !def.params.some((d) => d.name === p.name)) unfed.push(`${id}.${p.name}`);
  }
  check("every lib param is a same-named toolbox param or a documented derived value", unfed.length === 0, unfed.join());
  const sockets = (t: string) => getNodeDef(t)!.inputs.map((i) => `${i.name}:${i.type}`).join();
  check("UV sockets mirror Noise / Lyapunov's `uv_in` (as skia_shader); Shape Cells and Texture Coordinate have none", sockets("skia-noise") === "uv_in:skia_shader" && sockets("skia-lyapunov") === "uv_in:skia_shader" && sockets("skia-shape-cells") === "" && sockets("skia-texture-coordinate") === "");

  // Variant selection.
  const wrong: string[] = [];
  const picked = new Set<string>();
  for (const type of NOISE_TYPES) {
    for (const animated of [false, true]) {
      for (const uv of [false, true]) {
        const e = exprOf("skia-noise", { type, animated }, 16, 16, 0, uv ? { uv_in: TEXCOORD } : {}) as any;
        picked.add(e.fn);
        const ok = e.k === "call" && !!lib.getSkslFunction(e.fn) && e.fn.includes(".loop") === animated && e.fn.endsWith(".uv@1") === uv && !!e.inputs.uv_in === uv;
        if (!ok) wrong.push(`${type}/${animated}/${uv} → ${e.fn}`);
      }
    }
  }
  check(`skia-noise picks its own function per type × animated × UV wiring (${picked.size} of ${NOISE_TYPES.length * 4})`, wrong.length === 0 && picked.size === NOISE_TYPES.length * 4, wrong.join(" | "));
  const ids = new Set(NOISE_TYPES.map((type) => (exprOf("skia-noise", { type }) as any).fn));
  check("each of the eleven types selects its own function", ids.size === 11 && ![...ids].includes("tbx.const@1"), [...ids].join());
  check("the default stays the Wave 1 reference port tbx.noise.simplex@1", (exprOf("skia-noise", {}) as any).fn === "tbx.noise.simplex@1");
  const lya = (uv: boolean) => (exprOf("skia-lyapunov", {}, 16, 16, 0, uv ? { uv_in: TEXCOORD } : {}) as any).fn;
  check("skia-lyapunov: canvas uv unwired, the UV variant when wired", lya(false) === "tbx.lyapunov@1" && lya(true) === "tbx.lyapunov.uv@1");

  // Reported options.
  const noise = getNodeDef("skia-noise")!;
  const silentTypes = NOISE_TYPES.filter((t) => noise.validateParams!({ type: t }).length > 0 || noise.validateParams!({ type: t, animated: true }).length > 0);
  check("skia-noise: every type, static and animated, validates", silentTypes.length === 0, silentTypes.join());
  check("skia-noise: a type outside the enum is reported and emits transparent", noise.validateParams!({ type: "voronoi" }).length === 1 && (exprOf("skia-noise", { type: "voronoi" }) as any).fn === "tbx.const@1");
  const cells = getNodeDef("skia-shape-cells")!;
  const portedInterp = ["linear", "ease", "smoother", "sine", "ease_in", "ease_out", "constant"];
  const portedSpace = ["srgb", "linear", "oklab"];
  const silent = [
    ...COLOR_RAMP_INTERP_OPTIONS.filter((o) => portedInterp.includes(o) === (cells.validateParams!({ interpolation: o }).length > 0)),
    ...COLOR_RAMP_SPACE_OPTIONS.filter((o) => portedSpace.includes(o) === (cells.validateParams!({ space: o }).length > 0)),
  ];
  check("skia-shape-cells: every ramp option is verified below or reported unsupported", silent.length === 0, silent.join());

  // Binds that are not 1:1.
  const loopE = exprOf("skia-noise", { type: "perlin", animated: true }) as any;
  check("looping noise binds fps as a static value from the timeline", loopE.params.fps?.v === FPS && !loopE.params.fps.ref && !loopE.params.fps.deps && loopE.params.w === undefined);
  const ph = exprOf("skia-noise", { type: "phasor", phasor_orientation: 45 }) as any;
  check("phasor_orientation binds radians as a scaled ref (track × π/180)", ph.params.phasor_orientation.v === 45 * (Math.PI / 180) && ph.params.phasor_orientation.ref?.param === "phasor_orientation" && ph.params.phasor_orientation.ref.scale === Math.PI / 180);
  const ly = exprOf("skia-lyapunov", { preset: "custom", sequence: "bbAxBa", warmup: 700, iterations: 600 }) as any;
  const steps = lyapunovSteps({ warmup: 700, iterations: 600 });
  check(
    "Lyapunov: the sequence is a 32-float array (1 = B), warmup/iterations rescaled like the GL node, all derived",
    ly.params.seq.v.slice(0, 6).join() === "1,1,0,1,0,0" && ly.params.seq.v.length === 32 && ly.params.seq_len.v === 5 && ly.params.seq.deps?.map((d: any) => d.param).join() === "preset,sequence" &&
      ly.params.warmup.v === steps.warmup && ly.params.iterations.v === steps.iterations && steps.warmup + steps.iterations === 1024 && steps.warmup === 551 && ly.params.warmup.deps?.length === 2,
    `${ly.params.seq.v.slice(0, 6)} len ${ly.params.seq_len.v} steps ${steps.warmup}+${steps.iterations}`
  );
  check("Lyapunov: an empty custom sequence falls back to AB", sequenceFromParams({ preset: "custom", sequence: "xyz" }).join() === "0,1" && (exprOf("skia-lyapunov", { preset: "custom", sequence: "" }) as any).params.seq_len.v === 2);
  const sc = exprOf("skia-shape-cells", {}) as any;
  check("Shape Cells: the ramp splits into derived arrays (16 stops)", sc.params.ramp_pos.v.length === 16 && sc.params.ramp_color.v.length === 64 && sc.params.ramp_count.v === 7 && sc.params.ramp_pos.deps?.[0]?.param === "ramp");

  // Clock reads in the fused program and the fingerprint.
  const reads = (e: ShaderExpr) => shaderReadsTime(fuseShader(e, { resolution: [8, 8], time: 0 }).shader);
  check("a static noise's program does not read iTime; a looping one and Shape Cells do (Skia Fill re-renders per frame only then)", !reads(exprOf("skia-noise", { type: "flow" })) && reads(exprOf("skia-noise", { type: "flow", animated: true })) && reads(exprOf("skia-shape-cells", {})));
  const fp = (params: Record<string, unknown>) => noise.fingerprintExtras!({ ...defaults("skia-noise"), ...params }, ctxFor(8, 8, 12), "n");
  check("fingerprint folds the clock in only while animated", !fp({ type: "curl" }).includes("t:") && fp({ type: "curl", animated: true }).includes("t:0.2"), `${fp({})} / ${fp({ animated: true })}`);
}

// ---- 3. CPU references --------------------------------------------------------------------------
{
  // Noise (Skia) vs engine/noise.ts, for the algorithms it ports to JS
  // that stay comparable in fp32: perlin and simplex hash with Ashima's
  // permutation polynomial (exact integers in fp32) at any seed. Value
  // noise's hash12 ends in fract((x + y) · z) with the product ~1e4, so at
  // a few lattice points fp32 and doubles land on opposite sides of an
  // integer (0.998 vs 0.0), and from |p| ≈ 100 (any seed ≥ 1) fp32 rounding
  // alone moves most hashes by ~1e-2: value runs at seed 0 and is gated on
  // the share of exact pixels (the GL node and the port, both fp32, MATCH
  // in compare:skia at seed 3). Phasor's sin hash (and NOISE_FS's W slice offsets, also
  // sin-hashed) diverge between fp32 and doubles at once, so phasor and
  // w ≠ 0 are proven against the GL node instead (compare:skia, every
  // pair drives w), and W is checked for consistency below.
  interface Q { [k: string]: any }
  const cpuNoise = (q: Q, w: number, h: number, frame: number) => {
    const fn = noiseFnFor(q.type);
    const oct = Math.max(1, Math.min(8, Math.round(q.octaves)));
    const [ax, ay] = q.animated ? loopEvolutionOffset(frame, q.anim_start, q.anim_end, q.anim_rate) : [0, 0];
    const wv = q.animated ? 0 : q.w;
    const A = hexRgb(q.color_a);
    const B = hexRgb(q.color_b);
    const out = new Float64Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = (x + 0.5) / w;
        const v = 1 - (y + 0.5) / h;
        const sx = (u - 0.5) * q.scale + q.offset_x + q.seed * 127.1;
        const sy = ((v - 0.5) * q.scale) / (w / h) + q.offset_y + q.seed * 311.7;
        const n = fbmWithW(fn, sx + ax, sy + ay, wv, oct, q.persistence, q.lacunarity);
        const t = clamp01(0.5 + n * 0.5 * q.contrast);
        const i = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) out[i + c] = (A[c] + (B[c] - A[c]) * t) * 255;
        out[i + 3] = q.alpha * q.opacity * 255;
      }
    }
    return out;
  };
  const maxDiff = (img: Uint8Array, ref: Float64Array) => {
    let m = 0;
    for (let i = 0; i < img.length; i++) m = Math.max(m, Math.abs(img[i] - ref[i]));
    return m;
  };
  // Share of pixels whose every channel is within 1.5/255.
  const exactShare = (img: Uint8Array, ref: Float64Array) => {
    let ok = 0;
    for (let i = 0; i < img.length; i += 4) if ([0, 1, 2, 3].every((k) => Math.abs(img[i + k] - ref[i + k]) <= 1.5)) ok++;
    return ok / (img.length / 4);
  };
  const base = { ...defaults("skia-noise"), color_a: "#1b2a6b", color_b: "#ffd27a" };
  const cases: { w: number; h: number; q: Q }[] = [
    { w: 96, h: 64, q: { scale: 4, octaves: 4, offset_x: 0.3, offset_y: -0.2, seed: 0, contrast: 1.2 } },
    { w: 80, h: 80, q: { scale: 6.5, octaves: 5.4, persistence: 0.6, lacunarity: 2.3, offset_x: -1.7, offset_y: 2.2, seed: 2, contrast: 0.9, alpha: 0.8, opacity: 0.7 } },
    { w: 60, h: 100, q: { scale: 2.5, octaves: 2, offset_x: 0.4, offset_y: 0, seed: 11, contrast: 1.6 } },
  ];
  const report: string[] = [];
  let worst = 0;
  let valueShare = 1;
  for (const type of ["perlin", "simplex", "value"]) {
    let t = 0;
    for (const c of cases) {
      const q = { ...base, type, ...c.q, w: 0, ...(type === "value" ? { seed: 0 } : {}) };
      const img = render("skia-noise", q, c.w, c.h);
      const ref = cpuNoise(q, c.w, c.h, 0);
      if (type === "value") valueShare = Math.min(valueShare, exactShare(img, ref));
      else t = Math.max(t, maxDiff(img, ref));
    }
    if (type !== "value") report.push(`${type} ${t.toFixed(2)}`);
    worst = Math.max(worst, t);
  }
  check("Noise (Skia) matches engine/noise.ts for perlin / simplex (offset, seed, aspect, rounded octaves, contrast, colors, alpha × opacity)", worst <= 1.5, `max |Δ| per type (/255): ${report.join(", ")}`);
  check("Noise (Skia) value matches engine/noise.ts (seed 0) except at fract-wrap lattice points", valueShare >= 0.97, `worst canvas ${(valueShare * 100).toFixed(2)}% of pixels within 1.5/255`);
  // W slice blend, by consistency: w = 0.5 averages slices 0 and 1.
  const atW = (type: string, wv: number) => render("skia-noise", { ...base, type, w: wv, color_a: "#000000", color_b: "#ffffff" }, 48, 48);
  let mid = 0;
  for (const type of ["perlin", "os2s", "phasor"].map((t) => (t === "os2s" ? "opensimplex2s" : t))) {
    const a0 = atW(type, 0);
    const a1 = atW(type, 1);
    const ah = atW(type, 0.5);
    for (let i = 0; i < a0.length; i += 4) mid = Math.max(mid, Math.abs(ah[i] - (a0[i] + a1[i]) / 2));
  }
  check("W: w = 0.5 is the average of slices 0 and 1 (perlin, opensimplex2s, phasor)", mid <= 1, `max |Δ| ${mid}/255`);

  // The looping evolution, at fractional frames inside and outside the window.
  let loopWorst = 0;
  let loopShare = 1;
  for (const type of ["perlin", "simplex", "value"]) {
    for (const frame of [0, 17.25, 64, 129.5, 300]) {
      const q = { ...base, type, scale: 4, seed: type === "value" ? 0 : 1, offset_x: 0.2, animated: true, anim_start: 10, anim_end: 130, anim_rate: 1.7, w: 2.5 };
      const img = render("skia-noise", q, 64, 48, frame);
      const ref = cpuNoise(q, 64, 48, frame);
      if (type === "value") loopShare = Math.min(loopShare, exactShare(img, ref));
      else loopWorst = Math.max(loopWorst, maxDiff(img, ref));
    }
  }
  check("animated=true follows loopEvolutionOffset at fractional frames, w ignored (perlin / simplex / value × 5 frames)", loopWorst <= 1.5 && loopShare >= 0.97, `perlin/simplex max |Δ| ${loopWorst.toFixed(2)}/255, value ${(loopShare * 100).toFixed(2)}% within 1.5/255`);
  const loopAt = (frame: number, extra: Q = {}) => render("skia-noise", { ...base, type: "simplex", animated: true, anim_start: 10, anim_end: 130, ...extra }, 48, 48, frame);
  const same = (a: Uint8Array, b: Uint8Array) => a.every((x, i) => Math.abs(x - b[i]) <= 1);
  check("the loop closes: frame start ≡ frame end, and a degenerate window holds still", same(loopAt(10), loopAt(130)) && !same(loopAt(10), loopAt(70)) && same(loopAt(5, { anim_end: 10 }), loopAt(90, { anim_end: 10 })));
  const flowAt = (frame: number) => render("skia-noise", { ...base, type: "flow", animated: true, anim_start: 0, anim_end: 120, flow_time: 9 }, 48, 48, frame);
  const flowStatic = (ft: number) => render("skia-noise", { ...base, type: "flow", flow_time: ft }, 48, 48, 0);
  check("type=flow loops flow_time through one turn: frame 30 of a 120-frame loop = flow_time π/2", same(flowAt(30), flowStatic(Math.PI / 2)) && same(flowAt(0), flowStatic(0)) && !same(flowAt(30), flowStatic(9)));

  // Curl: RG packs the signed vector 0.5-centred, B = 0, colors ignored.
  const curl = render("skia-noise", { ...base, type: "curl", contrast: 2, alpha: 0.9 }, 32, 32);
  let rg = 0;
  for (let i = 0; i < curl.length; i += 4) if (curl[i] !== curl[i + 1]) rg++;
  check("type=curl writes the vector into R/G (B = 0, alpha kept)", curl.every((x, i) => (i % 4 === 2 ? x === 0 : i % 4 === 3 ? Math.abs(x - 230) <= 1 : true)) && rg > 500);

  // Lyapunov vs lyapunovExponent (CPU, doubles). Inside the periodic
  // region (a, b ≲ 3.45 for AABAB) orbits settle and the two agree, except
  // on the period-doubling lines where λ → 0 and convergence is too slow
  // for the warmup to hide fp32 rounding (a handful of pixels). Over the full square, chaotic orbits (and periodic
  // windows inside the chaotic sea) amplify fp32 rounding into a different
  // λ — the GL node differs from doubles there just the same — so that
  // run is reported, not gated.
  const lyaRun = (over: Record<string, number>, W: number, H: number) => {
    const lp: Record<string, any> = { ...defaults("skia-lyapunov"), warmup: 120, iterations: 160, lambda_neg: 0.7, lambda_pos: 0.45, ...over };
    const img = render("skia-lyapunov", lp, W, H);
    const seq = sequenceFromParams(lp);
    const st = lyapunovSteps(lp);
    const S = hexRgb(lp.color_stable);
    const C = hexRgb(lp.color_chaos);
    const D = hexRgb(lp.color_div);
    let worstPx = 0;
    let within = 0;
    let stable = 0;
    let stableWithin = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const u = (x + 0.5) / W;
        const v = 1 - (y + 0.5) / H;
        const r = lyapunovExponent({ sequence: seq, a: lp.a_min + (lp.a_max - lp.a_min) * u, b: lp.b_min + (lp.b_max - lp.b_min) * v, x0: lp.x0, warmup: st.warmup, iterations: st.iterations });
        let col: number[];
        if (r.diverged || r.n === 0) col = D;
        else if (r.lambda >= 0) col = S.map((s, k) => s + (C[k] - s) * clamp01(r.lambda / lp.lambda_pos));
        else col = S.map((s, k) => s + (D[k] - s) * clamp01(-r.lambda / lp.lambda_neg));
        const i = (y * W + x) * 4;
        const d = Math.max(...[0, 1, 2].map((k) => Math.abs(img[i + k] - col[k] * 255)));
        worstPx = Math.max(worstPx, d);
        if (d <= 2) within++;
        if (!r.diverged && r.lambda < -0.05) {
          stable++;
          if (d <= 2) stableWithin++;
        }
      }
    }
    return { worstPx, within: within / (W * H), stable, stableWithin };
  };
  const periodic = lyaRun({ a_min: 2.6, a_max: 3.45, b_min: 2.5, b_max: 3.4 }, 96, 64);
  check("Lyapunov (Skia) matches lyapunovExponent in the periodic region (≥ 99.9% of pixels within 2/255)", periodic.within >= 0.999, `max |Δ| ${periodic.worstPx.toFixed(2)}/255, ${(periodic.within * 100).toFixed(2)}% within 2/255`);
  const full = lyaRun({ a_min: 2.6, a_max: 3.95, b_min: 2.4, b_max: 3.9 }, 96, 64);
  info(`Lyapunov over [2.6, 3.95]×[2.4, 3.9]: ${(full.within * 100).toFixed(1)}% of pixels within 2/255 of the double-precision reference; stable (λ < −0.05) ${full.stableWithin}/${full.stable}`);
  const expImg = render("skia-lyapunov", { a_min: 2.6, a_max: 3.95, color_mode: "exponent", opacity: 0.5 }, 16, 16);
  check("color_mode=exponent is grey and opacity folds into alpha", expImg.every((x, i) => (i % 4 === 3 ? Math.abs(x - 128) <= 1 : true)) && [0, 4, 8].every((i) => expImg[i] === expImg[i + 1] && expImg[i] === expImg[i + 2]));

  // Shape Cells' ramp walk vs makeColorRampSampler, through the function's
  // own source (the private tbx_shape_cells_ramp).
  const fn = lib.getSkslFunction("tbx.shape_cells@1")!;
  const helpers = lib.resolveHelpers(fn.uses ?? []).order.map((h) => h.source);
  const prog = [
    "uniform float iTime;",
    "uniform float pos[16];",
    "uniform float4 col[16];",
    "uniform float count;",
    "uniform int interp;",
    "uniform int space;",
    ...helpers,
    fn.source,
    "half4 main(float2 fc) { float4 c = tbx_shape_cells_ramp(fc.x / 256.0, pos, col, count, interp, space); return half4(c.rgb * c.a, c.a); }",
  ].join("\n");
  const eff = compileSksl(CK, prog);
  check("the ramp walk compiles standalone", !!eff.effect, eff.error ?? undefined);
  const stops = [
    { id: "a", position: 0.08, color: "#1b2cff" },
    { id: "c", position: 0.62, color: "#ffe3c2", alpha: 0.6 },
    { id: "b", position: 0.3, color: "#ff3d8b" },
    { id: "d", position: 0.91, color: "#00a37a" },
  ];
  const packed = packRampStops(stops);
  let rampWorst = 0;
  let rampAt = "";
  if (eff.effect) {
    for (const interpolation of portedInterpolations()) {
      for (const space of ["srgb", "linear", "oklab"]) {
        const u = packUniforms(eff.effect, {
          iTime: 0, pos: packed.pos, col: packed.color, count: packed.count,
          interp: COLOR_RAMP_INTERP_OPTIONS.indexOf(interpolation as any), space: COLOR_RAMP_SPACE_OPTIONS.indexOf(space as any),
        });
        const img = renderShader(eff.effect.makeShader(u), 256, 1);
        const sample = makeColorRampSampler(stops, { interp: interpolation as any, space: space as any });
        for (let x = 0; x < 256; x++) {
          let t = (x + 0.5) / 256;
          if (interpolation === "constant") t = (Math.floor(t * 1024) + 0.5) / 1024;
          const c = sample(t);
          for (let k = 0; k < 4; k++) {
            const d = Math.abs(img[x * 4 + k] - c[k] * 255);
            if (d > rampWorst) {
              rampWorst = d;
              rampAt = `${interpolation}/${space} x=${x} ch${k}`;
            }
          }
        }
      }
    }
  }
  check("Shape Cells (Skia)'s ramp matches makeColorRampSampler (7 interpolations × 3 spaces)", rampWorst <= 1.5, `max |Δ| ${rampWorst.toFixed(2)}/255${rampWorst > 0 ? ` at ${rampAt}` : ""}`);

  // The documented float cell hash vs its JS twin (fp32 emulated), and its
  // distribution over a 32×32 lattice.
  const f = Math.fround;
  const fract = (x: number) => f(x - Math.floor(x));
  const hash44 = (p: number[]) => {
    let q = [fract(f(p[0] * f(0.1031))), fract(f(p[1] * f(0.103))), fract(f(p[2] * f(0.0973))), fract(f(p[3] * f(0.1099)))];
    const wzxy = [q[3], q[2], q[0], q[1]].map((x) => f(x + f(33.33)));
    const d = f(f(f(q[0] * wzxy[0]) + f(q[1] * wzxy[1])) + f(f(q[2] * wzxy[2]) + f(q[3] * wzxy[3])));
    q = q.map((x) => f(x + d));
    const a = [q[0], q[0], q[1], q[2]];
    const b = [q[1], q[2], q[2], q[3]];
    const c = [q[2], q[1], q[3], q[0]];
    return [0, 1, 2, 3].map((k) => fract(f(f(a[k] + b[k]) * c[k])));
  };
  // Opaque output, three channels per pass (x y z, then w).
  const hp = compileSksl(CK, [
    lib.getSkslHelper("tbx.noise.cellhash")!.source,
    "uniform float seed;",
    "uniform int pass;",
    "half4 main(float2 fc) { float4 h = tbx_noise2_cellhash(float4(floor(fc), seed, 0.0)); return half4(pass == 0 ? h.xyz : float3(h.w, 0.0, 0.0), 1.0); }",
  ].join("\n"));
  check("the cell hash compiles standalone", !!hp.effect, hp.error ?? undefined);
  if (hp.effect) {
    const N = 32;
    const xyz = renderShader(hp.effect.makeShader(packUniforms(hp.effect, { seed: 42, pass: 0 })), N, N);
    const w4 = renderShader(hp.effect.makeShader(packUniforms(hp.effect, { seed: 42, pass: 1 })), N, N);
    let agree = 0;
    const mean = [0, 0, 0, 0];
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const want = hash44([x, y, 42, 0]);
        const i = (y * N + x) * 4;
        const got = [xyz[i], xyz[i + 1], xyz[i + 2], w4[i]];
        if (got.every((g, k) => Math.abs(g - want[k] * 255) <= 1)) agree++;
        for (let k = 0; k < 4; k++) mean[k] += want[k] / (N * N);
      }
    }
    check("the float cell hash matches its fp32 JS twin", agree >= N * N * 0.97, `${agree}/${N * N} cells`);
    check("its four channels are uniform-ish over a 32×32 lattice (means within 0.5 ± 0.05)", mean.every((m) => Math.abs(m - 0.5) < 0.05), mean.map((m) => m.toFixed(3)).join());
  }
  const c0 = render("skia-shape-cells", {}, 96, 64, 0);
  const c1 = render("skia-shape-cells", {}, 96, 64, 100);
  const s0 = render("skia-shape-cells", { speed: 0 }, 96, 64, 0);
  const s1 = render("skia-shape-cells", { speed: 0 }, 96, 64, 100);
  check("Shape Cells (Skia) animates on the clock, and holds still at speed 0", !same(c0, c1) && s0.every((x, i) => x === s1[i]));
  check("Shape Cells (Skia) is deterministic per seed and re-draws for another seed", same(c0, render("skia-shape-cells", {}, 96, 64, 0)) && !same(c0, render("skia-shape-cells", { seed: 7 }, 96, 64, 0)));

  // Texture Coordinate: R = u, G = v (Y-up), B = 0, A = 1; and a wired UV
  // input re-samples the noise exactly where the canvas uv would.
  const tc = renderShader(programShader(fused(TEXCOORD, 64, 32)), 64, 32);
  let tcWorst = 0;
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 64; x++) {
      const i = (y * 64 + x) * 4;
      tcWorst = Math.max(tcWorst, Math.abs(tc[i] - ((x + 0.5) / 64) * 255), Math.abs(tc[i + 1] - (1 - (y + 0.5) / 32) * 255), tc[i + 2], 255 - tc[i + 3]);
    }
  }
  check("Texture Coordinate (Skia) emits (u, v, 0, 1)", tcWorst <= 0.51, `max |Δ| ${tcWorst.toFixed(2)}/255`);
  const viaUv = (type: string, params: Q) => {
    const a = render(type, params, 64, 40);
    const b = render(type, params, 64, 40, 0, { uv_in: TEXCOORD });
    return a.every((x, i) => Math.abs(x - b[i]) <= 1);
  };
  check("Texture Coordinate → UV equals the unwired node (Noise curl / phasor loop, Lyapunov)", viaUv("skia-noise", { ...base, type: "curl" }) && viaUv("skia-noise", { ...base, type: "phasor", animated: true }) && viaUv("skia-lyapunov", { a_min: 2.6, a_max: 3.95, b_min: 2.4, b_max: 3.9 }));
}

function portedInterpolations(): string[] {
  return ["linear", "ease", "smoother", "sine", "ease_in", "ease_out", "constant"];
}

// ---- 4. export coverage -------------------------------------------------------------------------------
{
  type K = [frame: number, value: number, easing: EasingPreset];
  const block = (keys: K[]): KeyframeAnimationBlock => ({
    animated: true,
    trackVisible: true,
    keyframes: keys.map(([fr, value, easingOut]) => ({ tick: fr * 1000, value, easingOut })),
  });
  const driver = (id: string, keys: K[]): GraphNode => ({ id, type: "animated-value", params: { value: keys[0][1], unit: "frames" }, animation: { value: block(keys) } });
  const wire = (source: string, target: string, handle: string): GraphEdge => ({ id: `${source}->${target}:${handle}`, source, sourceHandle: "out:primary", target, targetHandle: handle });

  // Ports → one Skia Fill each → a tree of Skia Groups (4 children) → Canvas.
  function canvasGraph(ports: { node: GraphNode; drive?: [string, string][]; feed?: [GraphNode, string] }[], drivers: GraphNode[]) {
    const nodes: GraphNode[] = [...drivers];
    const edges: GraphEdge[] = [];
    let level: string[] = [];
    ports.forEach((p, i) => {
      const exposed = (p.drive ?? []).map(([, param]) => param);
      nodes.push({ ...p.node, exposedParams: exposed }, { id: `fill${i}`, type: "skia-fill", params: { color: "#ffffff", opacity: 0.9, blendMode: "srcOver" } });
      for (const [d, param] of p.drive ?? []) edges.push(wire(d, p.node.id, `in:param:${param}`));
      if (p.feed) {
        if (!nodes.some((n) => n.id === p.feed![0].id)) nodes.push(p.feed[0]);
        edges.push(wire(p.feed[0].id, p.node.id, `in:${p.feed[1]}`));
      }
      edges.push(wire(p.node.id, `fill${i}`, "in:shader"));
      level.push(`fill${i}`);
    });
    let g = 0;
    while (level.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < level.length; i += 4) {
        const id = `grp${g++}`;
        nodes.push({ id, type: "skia-group", params: { ...defaults("skia-group") } });
        level.slice(i, i + 4).forEach((c, k) => edges.push(wire(c, id, `in:child${k + 1}`)));
        next.push(id);
      }
      level = next;
    }
    nodes.push({ id: "canvas", type: "skia-canvas", params: { background_on: true, background: "#000000" } });
    edges.push(wire(level[0], "canvas", "in:scene"));
    return { nodes, edges };
  }

  const drivers = [
    driver("d_scale", [[0, 4, "easeInOutCubic"], [30, 6.5, "easeOutBack"], [60, 4, "linear"]]),
    driver("d_drift", [[0, 0, "linear"], [60, 1.5, "linear"]]),
    driver("d_w", [[0, 0, "linear"], [60, 2.6, "linear"]]),
    driver("d_contrast", [[0, 0.9, "easeInOutSine"], [60, 1.4, "linear"]]),
    driver("d_flow", [[0, 0, "linear"], [60, 4, "linear"]]),
    driver("d_orient", [[0, -20, "linear"], [60, 70, "linear"]]),
    driver("d_amin", [[0, 2.5, "easeInOutQuad"], [60, 3.1, "linear"]]),
    driver("d_speed", [[0, 0.4, "linear"], [60, 1.2, "linear"]]),
  ];
  const noiseNode = (id: string, params: Record<string, unknown>): GraphNode => ({ id, type: "skia-noise", params: { ...defaults("skia-noise"), seed: 2, octaves: 5, color_a: "#14213d", color_b: "#fca311", ...params } });
  const driveFor = (type: string, animated: boolean): [string, string][] => [
    ["d_scale", "scale"],
    ["d_contrast", "contrast"],
    ...(animated ? [] : ([["d_drift", "offset_x"], ["d_w", "w"]] as [string, string][])),
    ...(type === "flow" && !animated ? ([["d_flow", "flow_time"]] as [string, string][]) : []),
    ...(type === "phasor" ? ([["d_orient", "phasor_orientation"]] as [string, string][]) : []),
  ];
  const tcNode: GraphNode = { id: "tc", type: "skia-texture-coordinate", params: {} };
  const warpSrc: GraphNode = { id: "warpsrc", type: "skia-noise", params: { ...defaults("skia-noise"), scale: 2, octaves: 3 } };

  const graphs: { name: string; ports: Parameters<typeof canvasGraph>[0] }[] = [
    { name: "every algorithm, driven params", ports: NOISE_TYPES.map((type, i) => ({ node: noiseNode(`nz${i}`, { type }), drive: driveFor(type, false) })) },
    { name: "every algorithm, looping evolution", ports: NOISE_TYPES.map((type, i) => ({ node: noiseNode(`lp${i}`, { type, animated: true, anim_start: 5, anim_end: 50, anim_rate: 1.2 }), drive: driveFor(type, true) })) },
    {
      name: "UV-wired noise, Lyapunov, Shape Cells, Texture Coordinate",
      ports: [
        { node: noiseNode("uv0", { type: "perlin" }), drive: driveFor("perlin", false), feed: [tcNode, "uv_in"] },
        { node: noiseNode("uv1", { type: "value", scale: 6 }), drive: [["d_drift", "offset_x"]], feed: [warpSrc, "uv_in"] },
        { node: noiseNode("uv2", { type: "curl", animated: true }), drive: driveFor("curl", true), feed: [tcNode, "uv_in"] },
        { node: { id: "ly0", type: "skia-lyapunov", params: { ...defaults("skia-lyapunov") } }, drive: [["d_amin", "a_min"]] },
        {
          node: {
            id: "ly1",
            type: "skia-lyapunov",
            params: { ...defaults("skia-lyapunov"), preset: "custom", sequence: "BBABAAB", warmup: 700, iterations: 600, color_mode: "exponent" },
            animation: { b_max: block([[0, 4, "easeInOutSine"], [60, 3.6, "linear"]]) },
          },
        },
        { node: { id: "ly2", type: "skia-lyapunov", params: { ...defaults("skia-lyapunov"), preset: "BBABABA" } }, feed: [tcNode, "uv_in"] },
        { node: { id: "sc0", type: "skia-shape-cells", params: { ...defaults("skia-shape-cells") } }, drive: [["d_speed", "speed"]] },
        { node: { id: "sc1", type: "skia-shape-cells", params: { ...defaults("skia-shape-cells"), interpolation: "linear", space: "oklab", useSquare: false, copiesMax: 5 } } },
        { node: { id: "tcview", type: "skia-texture-coordinate", params: {} } },
      ],
    },
  ];
  for (const g of graphs) {
    const { nodes, edges } = canvasGraph(g.ports, drivers);
    const r = await checkExportable({ nodes, edges, canvasId: "canvas", slot: "noise", typecheck: true, canvas: { width: 192, height: 128 } });
    check(`export (${g.name}): no problems`, r.problems.length === 0 && !!r.files, r.problems.slice(0, 4).join(" | "));
    const bad = r.programs.filter((p) => !p.ok);
    check(`export (${g.name}): ${r.programs.length} runtime programs compile with exactly their uniforms`, r.programs.length === g.ports.length && bad.length === 0, bad.map((p) => `${p.where}: ${p.detail}`).join(" | ") || `${r.programs.length} of ${g.ports.length}`);
    check(`export (${g.name}): bundle type-checks in skia-harness`, r.typecheck.ok, r.typecheck.output || (r.typecheck.ran ? "" : "skipped"));
    if (r.warnings.length) info(`${g.name}: ${r.warnings.length} warning(s): ${r.warnings.slice(0, 3).join(" | ")}`);
    if (r.files) {
      const timeline = Object.entries(r.files).find(([f]) => f.endsWith("timeline.ts"))?.[1] ?? "";
      const scaled = g.name.startsWith("every algorithm, driven") ? /"scale":0\.01745329251994/.test(timeline) : true;
      check(`export (${g.name}): driven params ship as tracks${g.name.startsWith("every algorithm, driven") ? " (the phasor orientation scaled to radians)" : ""}`, /tracks?|keys/.test(timeline) && scaled);
    }
  }
}

console.log(`\ncheck-skia-noise: ${failures === 0 ? "all checks passed" : `${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
