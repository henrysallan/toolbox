// check-skia-warp: the warp family gate (specdocs/101326_skia-target.md §7
// Wave 2, family F3 — Transform, Mirror, Polar Coords, Pixelate, Array as
// `skia-*` gather nodes). CanvasKit in Node, CPU raster surfaces, no GPU:
//
//   1. the node defs mirror their originals: skia { class: "sksl", mirrors },
//      the mirror's own ParamDef objects, the mirror's socket names, every
//      lib param fed by a same-named param, gathers declared as gathers;
//   2. fuser: every port compiles as a gather over (a) a pure upstream
//      (Noise (Skia)) and (b) another warp (gather of gather), through the
//      real evaluator; one program, no children, the upstream only inside
//      g<k> functions, exactly the uniforms its binds supply, program text
//      independent of param values; a warp whose private helpers are copied
//      for a second upstream (_G1) still compiles;
//   3. the math: each port, rendered on a CPU surface over a linear upstream
//      (rgb = uv), matches a JS transcription of its GL fragment shader
//      (a bilinear texture of a linear field IS the field, so this is the GL
//      node's own output) including CLAMP_TO_EDGE, tiles, wraps, copies and
//      source-over;
//   4. refusals and units: Array mode=spline/point, degrees → radians;
//   5. cost: estimateShaderCost per port over Noise (Skia);
//   6. export: every Skia Canvas of scripts/fixtures/skia/warp-graph.ts
//      exports (checkExportable: programs compile with exact uniforms; the
//      bundle type-checks in skia-harness when installed), and the emitted
//      timeline replays the preview's bound values at every frame.
//
// Pixel parity against the GL nodes on a real GPU is compare:skia's job:
//   npm run compare:skia -- --a warp:<pair>_n --b warp:<pair>_c
//
//   npx tsx scripts/check-skia-warp.mts

/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { EvalCache, GraphEdge, GraphNode } from "@/engine/evaluator";
import type { ShaderExpr } from "@/engine/skia/shader-expr";
import type { SkslProgramIR } from "@/engine/skia/scene-ir";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { getNodeDef } = await import("@/engine/registry");
const { evaluateGraph } = await import("@/engine/evaluator");
const lib = await import("@/engine/skia/library");
const { fuseShader, estimateShaderCost, PARAM_TAPS } = await import("@/engine/skia/fuse");
const { compileSksl, packUniforms } = await import("@/engine/skia/sksl-program");
const { bindStatic } = await import("@/engine/skia/scene-ir");
const { makeSceneSampler } = await import("@/lib/skia-export");
const { collectBinds } = await import("@/lib/skia-export/scene-plan");
const { checkExportable } = await import("./skia/export-check.ts");
const fx = await import("./fixtures/skia/warp-graph.ts");

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

// The family: port type → the node it mirrors, its gather sockets.
const FAMILY = [
  { type: "skia-transform", mirror: "transform", fn: "tbx.transform@1", inputs: ["image"] },
  { type: "skia-mirror", mirror: "mirror", fn: "tbx.mirror@1", inputs: ["source"] },
  { type: "skia-polar-coords", mirror: "polar-coords", fn: "tbx.polar_coords@1", inputs: ["image"] },
  { type: "skia-pixelate", mirror: "pixelate", fn: "tbx.pixelate@1", inputs: ["image"] },
  { type: "skia-array", mirror: "array", fn: "tbx.array@1", inputs: ["instance", "mod_scale", "mod_pos", "mod_rot"] },
] as const;

// ---- shared plumbing --------------------------------------------------------------------

const ctxFor = (w: number, h: number): any => ({
  gl: {}, width: w, height: h, time: 0, frame: 0, tick: 0, ticksPerFrame: 1000, fps: 60,
  playing: false, offline: false, cursor: { x: 0, y: 0, active: false }, state: {},
});

function defaults(type: string): Record<string, unknown> {
  return Object.fromEntries(getNodeDef(type)!.params.map((p) => [p.name, p.default]));
}

function evalExprs(nodes: GraphNode[], edges: GraphEdge[], w: number, h: number): Map<string, ShaderExpr> {
  const r = evaluateGraph(nodes, edges, ctxFor(w, h), new Map() as EvalCache, null, undefined, null, {
    extraTargets: nodes.map((n) => n.id),
  });
  const out = new Map<string, ShaderExpr>();
  for (const n of nodes) {
    const v = r.outputs.get(n.id)?.primary as any;
    if (v?.kind === "skia_shader") out.set(n.id, v.expr);
  }
  return out;
}

// A port's expression from a direct compute (the gate's test upstreams are
// library functions, not nodes).
function portExpr(type: string, params: Record<string, unknown>, inputs: Record<string, ShaderExpr>, w: number, h: number, nodeId = "p"): ShaderExpr {
  const def = getNodeDef(type)!;
  const wired = Object.fromEntries(Object.entries(inputs).map(([k, e]) => [k, { kind: "skia_shader", expr: e }]));
  const out = def.compute({ inputs: wired as any, auxIn: {}, params: { ...defaults(type), ...params }, ctx: ctxFor(w, h), nodeId, consumedOutputs: new Set(["primary"]) }) as any;
  return out.primary.expr;
}

function fused(expr: ShaderExpr, w: number, h: number): SkslProgramIR {
  const r = fuseShader(expr, { resolution: [w, h], time: 0 });
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

function exactUniforms(p: SkslProgramIR): string | null {
  const declared = uniformNames(p.sksl);
  const supplied = new Set(Object.keys(p.uniforms));
  const missing = [...declared].filter((n) => !supplied.has(n));
  const extra = [...supplied].filter((n) => !declared.has(n));
  return declared.size > 0 && !missing.length && !extra.length ? null : `missing [${missing}] extra [${extra}]`;
}

// Straight-alpha RGBA8, row 0 = top.
function render(p: SkslProgramIR, w: number, h: number): Uint8Array {
  const c = compileSksl(CK, p.sksl);
  if (!c.effect) throw new Error(c.error);
  const values: Record<string, number | number[]> = {};
  for (const [k, b] of Object.entries(p.uniforms)) values[k] = b.v;
  const shader = c.effect.makeShader(packUniforms(c.effect, values));
  const surf = CK.MakeSurface(w, h);
  const canvas = surf.getCanvas();
  canvas.clear(CK.TRANSPARENT);
  const paint = new CK.Paint();
  paint.setShader(shader);
  paint.setBlendMode(CK.BlendMode.Src);
  canvas.drawPaint(paint);
  surf.flush();
  const img = surf.makeImageSnapshot();
  const px = img.readPixels(0, 0, { width: w, height: h, colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB }) as Uint8Array;
  img.delete();
  paint.delete();
  shader.delete();
  surf.delete();
  return px;
}

// Test-only library functions: a linear upstream (rgb = uv), and a pure
// two-input mix so one warp can be fused over two different upstreams.
lib.registerSkslFunction({
  id: "test.warp.uv@1",
  entry: "test_warp_uv",
  source: `float4 test_warp_uv(float2 uv, float2 res, float a) { return float4(uv, 0.5, a); }`,
  params: [{ name: "a", type: "float" }],
  inputs: [],
});
lib.registerSkslFunction({
  id: "test.warp.mix@1",
  entry: "test_warp_mix",
  source: `float4 test_warp_mix(float2 uv, float2 res, float4 a, float4 b) { return mix(a, b, 0.5); }`,
  params: [],
  inputs: [{ name: "a", mode: "pure" }, { name: "b", mode: "pure" }],
});
const uvExpr = (a = 1, node = "uvsrc"): ShaderExpr => ({ k: "call", fn: "test.warp.uv@1", node, params: { a: bindStatic(a) }, inputs: {} });

// ---- 1. node defs --------------------------------------------------------------------------
for (const f of FAMILY) {
  const def = getNodeDef(f.type);
  const orig = getNodeDef(f.mirror)!;
  if (!def) {
    check(`${f.type} is registered`, false);
    continue;
  }
  check(
    `${f.type}: skia { class: "sksl", mirrors: "${f.mirror}" }, shader primary + gated image preview`,
    def.skia?.class === "sksl" && def.skia.mirrors === f.mirror && def.primaryOutput === "skia_shader" && def.auxOutputs.some((a) => a.name === "preview" && a.type === "image") && def.gatesOutputs === true
  );
  const drift = def.params.filter((p) => orig.params.find((o) => o.name === p.name) !== p).map((p) => p.name);
  check(`${f.type}: every param is ${f.mirror}'s own ParamDef (names, ranges, defaults)`, drift.length === 0, drift.join());
  const origInputs = new Set([...orig.inputs.map((i) => i.name), ...(orig.resolveInputs?.(defaults(f.mirror), { connectedTypes: {} }) ?? []).map((i) => i.name)]);
  const sockets = def.inputs.map((i) => i.name);
  check(
    `${f.type}: shader sockets keep ${f.mirror}'s names (${sockets.join(", ")})`,
    sockets.join() === f.inputs.join() && sockets.every((s) => origInputs.has(s)) && def.inputs.every((i) => i.type === "skia_shader")
  );
  const fn = lib.getSkslFunction(f.fn)!;
  const unfed = fn.params.filter((p) => !def.params.some((d) => d.name === p.name)).map((p) => p.name);
  check(`${f.type}: every lib param is fed by a same-named param`, unfed.length === 0, unfed.join());
  check(`${f.type}: every input is a gather (warps read their upstream at another uv)`, fn.inputs.length === f.inputs.length && fn.inputs.every((i) => i.mode === "gather"));
  check(`${f.type}: library function validates`, lib.validateSkslFunction(fn).length === 0, lib.validateSkslFunction(fn).join(" | "));
}

// ---- 2. fuser: gather over a pure upstream, and gather of gather -----------------------------
const W = 96;
const H = 64;
const NOISE = { scale: 3, octaves: 3, offset_x: 0.3, offset_y: -0.2, color_a: "#1b2cff", color_b: "#ffd23f" };
const noiseNode = (id: string): GraphNode => ({ id, type: "skia-noise", params: { ...defaults("skia-noise"), ...NOISE } });
const wire = (source: string, target: string, handle: string): GraphEdge => ({ id: `${source}->${target}:${handle}`, source, sourceHandle: "out:primary", target, targetHandle: handle });
// Non-default params per port (also the values section 6 never uses).
const PORT_PARAMS: Record<string, Record<string, unknown>> = {
  "skia-transform": { rotate: 30, scaleX: 0.7, translateX: 0.1, tile: true, tileUnfold: true },
  "skia-mirror": { mode: "radial", count: 5, kaleidoscope: true },
  "skia-polar-coords": { mode: "polar-to-rect", scale_radius: 0.7, wrap: "mirror" },
  "skia-pixelate": { size: 7, shape: "circle", aspect: 1.3 },
  "skia-array": { countX: 3, countY: 2, localRotate: 20 },
};
// The inner warp each port is stacked on for the gather-of-gather case.
const INNER: Record<string, string> = {
  "skia-transform": "skia-mirror",
  "skia-mirror": "skia-transform",
  "skia-polar-coords": "skia-pixelate",
  "skia-pixelate": "skia-polar-coords",
  "skia-array": "skia-transform",
};
const sockOf = (type: string) => FAMILY.find((f) => f.type === type)!.inputs[0];
const gatherBodies = (sksl: string) => [...sksl.matchAll(/^float4 g\d+\(float2 uv\) \{\n([\s\S]*?)^\}/gm)].map((m) => m[1]);
const mainBody = (sksl: string) => sksl.slice(sksl.indexOf("half4 main("));

for (const f of FAMILY) {
  const t = f.type;
  const port = { id: "w", type: t, params: { ...defaults(t), ...PORT_PARAMS[t] } };
  // (a) over a pure upstream
  {
    const exprs = evalExprs([noiseNode("nz"), port], [wire("nz", "w", `in:${sockOf(t)}`)], W, H);
    const e = exprs.get("w")!;
    const p = fused(e, W, H);
    const c = compileSksl(CK, p.sksl);
    check(`${t} over Noise (Skia): one program, no children, compiles`, p.children.length === 0 && !!c.effect && p.fused?.includes(f.fn) === true && p.fused?.includes("tbx.noise.simplex@1") === true, c.error ?? p.fused?.join());
    const bad = exactUniforms(p);
    check(`${t} over Noise (Skia): declares exactly the uniforms its binds supply`, !bad, bad ?? undefined);
    const bodies = gatherBodies(p.sksl);
    check(
      `${t} over Noise (Skia): the upstream is evaluated only inside g<k> (a gather), never in main`,
      bodies.some((b) => /tbx_noise_simplex\(/.test(b)) && !/tbx_noise_simplex\(/.test(mainBody(p.sksl)) && /\$/.test(p.sksl) === false
    );
    const moved = fused(evalExprs([noiseNode("nz"), { ...port, params: { ...port.params, ...Object.fromEntries(Object.entries(PORT_PARAMS[t]).filter(([, v]) => typeof v === "number").map(([k, v]) => [k, (v as number) * 1.5 + 1])) } }], [wire("nz", "w", `in:${sockOf(t)}`)], W, H).get("w")!, W, H);
    check(`${t}: program text depends on structure only (other param values → same SkSL)`, moved.sksl === p.sksl);
  }
  // (b) over another warp (gather of gather)
  {
    const it = INNER[t];
    const inner = { id: "v", type: it, params: { ...defaults(it), ...PORT_PARAMS[it] } };
    const exprs = evalExprs([noiseNode("nz"), inner, port], [wire("nz", "v", `in:${sockOf(it)}`), wire("v", "w", `in:${sockOf(t)}`)], W, H);
    const e = exprs.get("w")!;
    const p = fused(e, W, H);
    const c = compileSksl(CK, p.sksl);
    const bodies = gatherBodies(p.sksl);
    const innerFn = FAMILY.find((x) => x.type === it)!.fn;
    const innerEntry = lib.getSkslFunction(innerFn)!.entry;
    check(
      `${t} over ${it} over Noise (Skia): gather of gather compiles as one program`,
      !!c.effect && p.children.length === 0 && bodies.some((b) => new RegExp(`${innerEntry}\\(`).test(b)) && bodies.some((b) => /tbx_noise_simplex\(/.test(b)),
      c.error ?? undefined
    );
    const bad = exactUniforms(p);
    check(`${t} over ${it}: declares exactly the uniforms its binds supply`, !bad, bad ?? undefined);
  }
}
{
  // One warp function on two different upstreams in one program: its
  // private helpers are copied and renamed (_G1) with the entry.
  const a = portExpr("skia-mirror", { mode: "both" }, { source: uvExpr(1, "u1") }, W, H, "m1");
  const b = portExpr("skia-mirror", { mode: "radial", count: 3 }, { source: portExpr("skia-pixelate", {}, { image: uvExpr(1, "u2") }, W, H, "px") }, W, H, "m2");
  const p = fused({ k: "call", fn: "test.warp.mix@1", node: "mx", params: {}, inputs: { a, b } }, W, H);
  const c = compileSksl(CK, p.sksl);
  check(
    "a warp fused over two upstreams gets a _G1 copy with its private helpers renamed, and compiles",
    !!c.effect && /float4 tbx_mirror_G1\(/.test(p.sksl) && /float4 tbx_mirror_G1_tap\(/.test(p.sksl) && /bool tbx_mirror_G1_on_keep\(/.test(p.sksl),
    c.error ?? undefined
  );
}

// ---- 3. the math vs the GL fragment shaders ---------------------------------------------------
type V4 = [number, number, number, number];
const T0: V4 = [0, 0, 0, 0];
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const fract = (x: number) => x - Math.floor(x);
const mod = (x: number, y: number) => x - y * Math.floor(x / y);
const DEG = Math.PI / 180;
// Linear upstream sampled through CLAMP_TO_EDGE (texel centers).
const sampler = (w: number, h: number, a: number) => (q: [number, number]): V4 => [clamp(q[0], 0.5 / w, 1 - 0.5 / w), clamp(q[1], 0.5 / h, 1 - 0.5 / h), 0.5, a];
const outside = (q: [number, number], lo: [number, number], hi: [number, number]) => q[0] < lo[0] || q[0] > hi[0] || q[1] < lo[1] || q[1] > hi[1];
const over = (s: V4, d: V4): V4 => {
  const oa = s[3] + d[3] * (1 - s[3]);
  if (oa < 1e-4) return [0, 0, 0, oa];
  return [0, 1, 2].map((k) => (s[k] * s[3] + d[k] * d[3] * (1 - s[3])) / oa).concat(oa) as V4;
};

type Ref = (uv: [number, number], P: Record<string, any>, w: number, h: number, up: (q: [number, number]) => V4, mods?: Record<string, (q: [number, number]) => V4>) => V4;

// TRANSFORM_FS with Transform's uniforms (imageTrsUniforms: aspect-rigid,
// translate / pivot Y converted from authored; legacySkew = raw, a = 1).
const refTransform: Ref = (uv, P, w, h, up) => {
  const a = P.legacySkew === true ? 1 : w / h;
  const pivY = a === 1 ? P.pivotY : 0.5 + (P.pivotY - 0.5) * a;
  const piv = [P.pivotX, 1 - pivY];
  let px = uv[0] - P.translateX - piv[0];
  let py = uv[1] + P.translateY * a - piv[1];
  const ang = P.rotate * DEG;
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  py /= a;
  [px, py] = [c * px - s * py, s * px + c * py];
  py *= a;
  let q: [number, number] = [px / Math.max(P.scaleX, 1e-4) + piv[0], py / Math.max(P.scaleY, 1e-4) + piv[1]];
  const tile = P.tile === true;
  const lo: [number, number] = tile ? [-Math.max(P.tileLeft, 0), -Math.max(P.tileDown, 0)] : [0, 0];
  const hi: [number, number] = tile ? [1 + Math.max(P.tileRight, 0), 1 + Math.max(P.tileUp, 0)] : [1, 1];
  if (outside(q, lo, hi)) return T0;
  if (tile) {
    if (P.tileUnfold === true) q = q.map((v) => { const t = mod(v, 2); return t >= 1 ? 2 - t : t; }) as [number, number];
    else q = [fract(q[0]), fract(q[1])];
  }
  return up(q);
};

// MIRROR_FS
const refMirror: Ref = (uv, P, w, h, up) => {
  const aspect = w / Math.max(1, h);
  const modeId = ["x", "y", "both", "radial", "bisect"].indexOf(P.mode);
  const keep = ["x", "-x", "y", "-y"].indexOf(P.keep);
  const cx = P.centerX;
  const cy = P.centerY;
  const p = [uv[0], 0.5 + (0.5 - uv[1]) / Math.max(aspect, 1e-6)];
  let acc: V4 = [0, 0, 0, 0];
  const tap = (flipX: boolean, flipY: boolean, angle: number) => {
    let dx = p[0] - cx;
    let dy = p[1] - cy;
    if (angle !== 0) {
      const iy = dy / Math.max(aspect, 1e-6);
      const cs = Math.cos(angle);
      const sn = Math.sin(angle);
      const rx = cs * dx + sn * iy;
      const ry = -sn * dx + cs * iy;
      dx = rx;
      dy = ry * aspect;
    }
    if (flipX) dx = -dx;
    if (flipY) dy = -dy;
    const sx = cx + dx;
    const sy = cy + dy;
    if (modeId === 4) {
      const ok = keep === 0 ? sx >= cx : keep === 1 ? sx <= cx : keep === 2 ? sy >= cy : sy <= cy;
      if (!ok) return;
    }
    const q: [number, number] = [sx, 0.5 - (sy - 0.5) * aspect];
    if (outside(q, [0, 0], [1, 1])) return;
    acc = over(up(q), acc);
  };
  let axis = modeId;
  if (modeId === 4) axis = keep === 2 || keep === 3 ? 1 : 0;
  if (modeId === 3) {
    const n = Math.max(1, Math.floor(P.count));
    for (let k = 0; k < Math.min(n, 64); k++) {
      const ang = (k * 6.283185307179586) / n;
      tap(false, false, ang);
      if (P.kaleidoscope === true) tap(false, true, ang);
    }
  } else {
    if (P.includeSource !== false) tap(false, false, 0);
    if (axis === 0 || axis === 2) tap(true, false, 0);
    if (axis === 1 || axis === 2) tap(false, true, 0);
    if (axis === 2) tap(true, true, 0);
  }
  return acc;
};

// polar-coords FS
const refPolar: Ref = (uv, P, _w, _h, up) => {
  const TAU = 6.28318530717958647692;
  let q: [number, number];
  if (P.mode === "rect-to-polar") {
    const dx = uv[0] - P.center_x;
    const dy = uv[1] - P.center_y;
    const r = Math.hypot(dx, dy) * P.scale_radius;
    const theta = Math.atan2(dy, dx) + P.rotation;
    let a = mod(theta, TAU) / TAU;
    if (a < 0) a += 1;
    q = [a, r];
  } else {
    const theta = uv[0] * TAU + P.rotation;
    const r = uv[1] * P.scale_radius;
    q = [P.center_x + Math.cos(theta) * r, P.center_y + Math.sin(theta) * r];
  }
  if (P.wrap === "transparent" && outside(q, [0, 0], [1, 1])) return T0;
  if (P.wrap === "clamp") q = [clamp(q[0], 0, 1), clamp(q[1], 0, 1)];
  else if (P.wrap === "mirror") q = q.map((v) => Math.abs(fract(v * 0.5) * 2 - 1)) as [number, number];
  return up(q);
};

// PIXELATE_FS (+ the evaluator's opacity)
const refPixelate: Ref = (uv, P, w, h, up) => {
  const size = Math.max(1, P.size);
  const cell = [Math.max(size * Math.max(0.01, P.aspect), 1), Math.max(size, 1)];
  const grid = [w / cell[0], h / cell[1]];
  const id = [Math.floor(uv[0] * grid[0]), Math.floor(uv[1] * grid[1])];
  let c = up([(id[0] + 0.5) / grid[0], (id[1] + 0.5) / grid[1]]);
  if (P.shape === "circle") {
    const f = [fract(uv[0] * grid[0]) - 0.5, fract(uv[1] * grid[1]) - 0.5];
    if (Math.hypot(f[0], f[1]) > 0.5) c = [0, 0, 0, 0];
  }
  return [c[0], c[1], c[2], c[3] * clamp(P.opacity, 0, 1)];
};

// array FS (image mode); unwired modulators read nothing (has = 0)
const refArray: Ref = (uv, P, w, h, up, mods = {}) => {
  const count = [Math.max(1, Math.floor(P.countX)), Math.max(1, Math.floor(P.countY))];
  const step = P.sizeMode === "fit" ? [1 / count[0], 1 / count[1]] : [P.sizeW, P.sizeH];
  const g = [uv[0] - P.patternOffsetX, uv[1] - P.patternOffsetY];
  const idx = [Math.floor(g[0] / step[0]), Math.floor(g[1] / step[1])];
  const local = [fract(g[0] / step[0]), fract(g[1] / step[1])];
  if (idx[0] < 0 || idx[0] >= count[0] || idx[1] < 0 || idx[1] >= count[1]) return T0;
  const cc: [number, number] = [(idx[0] + 0.5) * step[0] + P.patternOffsetX, (idx[1] + 0.5) * step[1] + P.patternOffsetY];
  const tex = sampler(w, h, 1);
  let sx = Math.max(0.0001, P.localScaleX);
  let sy = Math.max(0.0001, P.localScaleY);
  if (mods.mod_scale) {
    const m = mods.mod_scale(tex(cc) as any)[0];
    sx *= 1 + (m - 0.5) * 2 * P.modScaleAmount;
    sy *= 1 + (m - 0.5) * 2 * P.modScaleAmount;
  }
  let ox = P.localX;
  let oy = P.localY;
  if (mods.mod_pos) {
    const m = mods.mod_pos(tex(cc) as any);
    ox += (m[0] - 0.5) * 2 * P.modPosAmount;
    oy += (m[1] - 0.5) * 2 * P.modPosAmount;
  }
  let ang = P.localRotate * DEG;
  if (mods.mod_rot) ang += (mods.mod_rot(tex(cc) as any)[0] - 0.5) * 2 * P.modRotAmount * DEG;
  let px = local[0] - 0.5 - ox;
  let py = local[1] - 0.5 - oy;
  const c = Math.cos(-ang);
  const s = Math.sin(-ang);
  [px, py] = [c * px - s * py, s * px + c * py];
  const q: [number, number] = [px / Math.max(sx, 0.0001) + 0.5, py / Math.max(sy, 0.0001) + 0.5];
  if (outside(q, [0, 0], [1, 1])) return T0;
  return up(q);
};

interface MathCase {
  label: string;
  type: string;
  ref: Ref;
  params: Record<string, unknown>;
  alpha?: number;
  w?: number;
  h?: number;
  // Modulator sockets wired to the linear upstream too (Array).
  mods?: string[];
}

const CASES: MathCase[] = [
  { label: "defaults", type: "skia-transform", ref: refTransform, params: {} },
  { label: "rotate 37°, scale 0.6×0.8, pivot (0.3, 0.6), translate", type: "skia-transform", ref: refTransform, params: { rotate: 37, scaleX: 0.6, scaleY: 0.8, pivotX: 0.3, pivotY: 0.6, translateX: 0.12, translateY: -0.07 } },
  { label: "tile repeat, uneven extents", type: "skia-transform", ref: refTransform, params: { rotate: -20, scaleX: 0.45, scaleY: 0.5, tile: true, tileLeft: 1, tileRight: 0.3, tileUp: 2, tileDown: 0.5 } },
  { label: "tile unfold", type: "skia-transform", ref: refTransform, params: { rotate: 15, scaleX: 0.4, scaleY: 0.55, translateX: 0.05, tile: true, tileUnfold: true } },
  { label: "legacySkew: per-axis rotate 37°, pivot (0.3, 0.6), translate", type: "skia-transform", ref: refTransform, params: { rotate: 37, scaleX: 0.6, scaleY: 0.8, pivotX: 0.3, pivotY: 0.6, translateX: 0.12, translateY: -0.07, legacySkew: true } },
  { label: "mode x, center 0.37", type: "skia-mirror", ref: refMirror, params: { mode: "x", centerX: 0.37 }, alpha: 0.5 },
  { label: "mode both, no source", type: "skia-mirror", ref: refMirror, params: { mode: "both", centerX: 0.6, centerY: 0.45, includeSource: false }, alpha: 0.5 },
  { label: "radial 5 + kaleidoscope", type: "skia-mirror", ref: refMirror, params: { mode: "radial", count: 5, kaleidoscope: true, centerX: 0.45, centerY: 0.55 }, alpha: 0.5 },
  { label: "bisect keep -x", type: "skia-mirror", ref: refMirror, params: { mode: "bisect", keep: "-x", centerX: 0.55 }, alpha: 0.5 },
  { label: "bisect keep y", type: "skia-mirror", ref: refMirror, params: { mode: "bisect", keep: "y", centerY: 0.4 }, alpha: 0.5 },
  { label: "rect-to-polar, clamp", type: "skia-polar-coords", ref: refPolar, params: { mode: "rect-to-polar", center_x: 0.45, center_y: 0.55, rotation: 0.7, scale_radius: 1.2, wrap: "clamp" } },
  { label: "rect-to-polar, transparent", type: "skia-polar-coords", ref: refPolar, params: { mode: "rect-to-polar", scale_radius: 1.8, wrap: "transparent" } },
  { label: "polar-to-rect, mirror", type: "skia-polar-coords", ref: refPolar, params: { mode: "polar-to-rect", rotation: -1.1, scale_radius: 0.9, wrap: "mirror" } },
  { label: "polar-to-rect, transparent", type: "skia-polar-coords", ref: refPolar, params: { mode: "polar-to-rect", center_x: 0.3, scale_radius: 0.8, wrap: "transparent" } },
  { label: "size 9, square", type: "skia-pixelate", ref: refPixelate, params: { size: 9 } },
  { label: "size 7.5, circle, aspect 1.6, opacity 0.7", type: "skia-pixelate", ref: refPixelate, params: { size: 7.5, shape: "circle", aspect: 1.6, opacity: 0.7 } },
  { label: "4×3 fit, offsets, rotate, scale", type: "skia-array", ref: refArray, params: { countX: 4, countY: 3, patternOffsetX: 0.05, patternOffsetY: -0.04, localX: 0.04, localY: -0.03, localRotate: 25, localScaleX: 0.8, localScaleY: 0.9 } },
  { label: "step 0.3×0.4 past the counts", type: "skia-array", ref: refArray, params: { countX: 2.7, countY: 2, sizeMode: "step", sizeW: 0.3, sizeH: 0.4, patternOffsetX: 0.1 } },
  { label: "modulators wired (scale, pos, rot)", type: "skia-array", ref: refArray, params: { countX: 3, countY: 3, modScaleAmount: 0.5, modPosAmount: 0.1, modRotAmount: 60 }, mods: ["mod_scale", "mod_pos", "mod_rot"] },
];

{
  let worstBad = 0;
  for (const c of CASES) {
    const w = c.w ?? 120;
    const h = c.h ?? 80;
    const a = c.alpha ?? 1;
    const sock = sockOf(c.type);
    const inputs: Record<string, ShaderExpr> = { [sock]: uvExpr(a) };
    for (const m of c.mods ?? []) inputs[m] = uvExpr(1);
    const expr = portExpr(c.type, c.params, inputs, w, h);
    const img = render(fused(expr, w, h), w, h);
    const P = { ...defaults(c.type), ...c.params };
    const up = sampler(w, h, a);
    const mods = Object.fromEntries((c.mods ?? []).map((m) => [m, sampler(w, h, 1)]));
    let max = 0;
    let bad = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const want = c.ref([(x + 0.5) / w, 1 - (y + 0.5) / h], P, w, h, up, mods);
        const i = (y * w + x) * 4;
        // Transparent pixels carry no color (straight alpha 0).
        const chans = want[3] < 1 / 255 && img[i + 3] === 0 ? [3] : [0, 1, 2, 3];
        let d = 0;
        for (const k of chans) d = Math.max(d, Math.abs(img[i + k] - want[k] * 255));
        max = Math.max(max, d);
        if (d > 3) bad++;
      }
    }
    const frac = bad / (w * h);
    worstBad = Math.max(worstBad, frac);
    // Edge decisions (cell / copy / circle boundaries, the polar seam) may
    // fall either side of a pixel center between fp32 SkSL and the double
    // transcription; everything else must agree to rounding.
    check(`${c.type} ${c.label}: matches its GL shader (rgb = uv upstream, ${w}×${h})`, frac <= 0.01, `${(frac * 100).toFixed(2)}% px beyond 3/255, max ${max.toFixed(1)}/255`);
  }
  info(`math cases: worst ${(worstBad * 100).toFixed(2)}% of pixels beyond 3/255 (edge decisions)`);
}

// ---- 4. refusals and units ---------------------------------------------------------------------
{
  const arr = getNodeDef("skia-array")!;
  check(
    "skia-array refuses mode=spline / point (geometry), accepts image",
    arr.validateParams!({ mode: "spline" }).length === 1 && arr.validateParams!({ mode: "point" }).length === 1 && arr.validateParams!({ mode: "image" }).length === 0
  );
  const warn = console.warn;
  console.warn = () => {};
  const refused = portExpr("skia-array", { mode: "spline" }, { instance: uvExpr() }, 8, 8) as any;
  console.warn = warn;
  check("a refused Array (Skia) emits transparent, not image tiling", refused.fn === "tbx.const@1" && refused.params.color.v.join() === "0,0,0,0");
  const xf = portExpr("skia-transform", { rotate: 90 }, { image: uvExpr() }, 8, 8) as any;
  const ar = portExpr("skia-array", { localRotate: -45, modRotAmount: 30 }, { instance: uvExpr() }, 8, 8) as any;
  check(
    "degrees params bind in radians with a scaled ref (rotate, localRotate, modRotAmount)",
    Math.abs(xf.params.rotate.v - Math.PI / 2) < 1e-15 && xf.params.rotate.ref?.param === "rotate" && xf.params.rotate.ref?.scale === Math.PI / 180 &&
      Math.abs(ar.params.localRotate.v + Math.PI / 4) < 1e-15 && ar.params.modRotAmount.ref?.scale === Math.PI / 180
  );
  for (const t of ["skia-transform", "skia-mirror", "skia-polar-coords", "skia-pixelate"]) {
    check(`${t} has no unsupported options`, (getNodeDef(t)!.validateParams?.({ ...defaults(t), ...PORT_PARAMS[t] }) ?? []).length === 0);
  }
  const unw = portExpr("skia-array", {}, { instance: uvExpr() }, 8, 8) as any;
  check("Array (Skia) unwired modulators read mid-grey (no change)", ["mod_scale", "mod_pos", "mod_rot"].every((m) => unw.inputs[m]?.fn === "tbx.const@1" && unw.inputs[m].params.color.v.join() === "0.5,0.5,0.5,1"));
}

// ---- 5. cost ---------------------------------------------------------------------------------------
{
  const rows: string[] = [];
  const evals: Record<string, number> = {};
  for (const f of FAMILY) {
    const t = f.type;
    const e = evalExprs([noiseNode("nz"), { id: "w", type: t, params: { ...defaults(t), ...PORT_PARAMS[t] } }], [wire("nz", "w", `in:${sockOf(t)}`)], W, H).get("w")!;
    const cost = estimateShaderCost(e);
    evals[t] = cost.nodes.find((n) => n.node === "nz")?.evaluations ?? 0;
    rows.push(`${t} ${cost.cost.toFixed(2)} (noise ×${evals[t]})`);
  }
  info(`estimateShaderCost over Noise (Skia) (cost 4): ${rows.join(" · ")}`);
  check(
    `cost: one upstream evaluation per pixel for transform / polar / pixelate / array, PARAM_TAPS (${PARAM_TAPS}) for mirror`,
    evals["skia-transform"] === 1 && evals["skia-polar-coords"] === 1 && evals["skia-pixelate"] === 1 && evals["skia-array"] === 1 && evals["skia-mirror"] === PARAM_TAPS,
    JSON.stringify(evals)
  );
}

// ---- 6. export: every port's Skia Canvas in the compare fixture ----------------------------------
{
  const g = fx.warpGraph();
  const TL = fx.WARP_TIMELINE;
  const canvas = { width: fx.WARP_SIZE[0], height: fx.WARP_SIZE[1] };
  const frames = TL.sceneDurationTicks / TL.ticksPerFrame + 1;
  const same = (a: unknown, b: unknown) =>
    Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => Object.is(x, b[i])) : Object.is(a, b);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skia-warp-"));
  try {
    for (const p of fx.WARP_PAIRS) {
      const r = await checkExportable({ nodes: g.nodes, edges: g.edges, canvasId: p.canvas, name: `warp_${p.pair}`, canvas, timeline: TL, slot: "warp", typecheck: true });
      check(`export ${p.canvas} (${p.type}): exportSkia reports no problems`, r.problems.length === 0 && !!r.files, [...r.problems, ...r.warnings].join(" | "));
      check(`export ${p.canvas}: every runtime program compiles with exactly its binds' uniforms`, r.programs.length === 1 && r.programs.every((x) => x.ok), r.programs.map((x) => `${x.where}: ${x.detail}`).join(" | "));
      check(`export ${p.canvas}: bundle type-checks against react-native-skia + Reanimated`, r.typecheck.ok, r.typecheck.ran ? r.typecheck.output : r.typecheck.output);
      if (!r.files) continue;
      // The emitted timeline replays the preview's bound values.
      const dir = path.join(tmp, p.pair);
      fs.mkdirSync(dir);
      for (const [f, text] of Object.entries(r.files)) if (!f.includes("/")) fs.writeFileSync(path.join(dir, f), text);
      const emitted = await import(pathToFileURL(path.join(dir, "timeline.ts")).href);
      const manifest = JSON.parse(r.files["manifest.json"]);
      const sampler = makeSceneSampler(g.nodes, g.edges, p.canvas, canvas, TL);
      if ("problem" in sampler) {
        check(`export ${p.canvas}: scene sampler`, false, sampler.problem);
        continue;
      }
      const tracks = manifest.binds.filter((b: any) => b.kind === "track");
      const want = fx.warpDrivenParams(p.pair);
      const tracked = want.filter((param) => tracks.some((b: any) => b.path.endsWith(`_${param}`)));
      check(`export ${p.canvas}: the driven params ship as tracks (${want.join(", ")})`, tracked.length === want.length, `tracks: ${tracks.map((b: any) => b.path.split(".").pop()).join(", ")}`);
      let mismatch = "";
      let reads = 0;
      for (let f = 0; f < frames && !mismatch; f++) {
        const sc = sampler.sampleAt(f * TL.ticksPerFrame)!;
        const byPath = new Map(collectBinds(sc.root).map((fb) => [fb.path, fb.bind.v]));
        const out = emitted.sampleBinds(f / TL.fps);
        for (const b of manifest.binds) {
          if (b.kind === "clock") continue;
          reads++;
          if (!same(byPath.get(b.path), out[b.sample])) {
            mismatch = `frame ${f} ${b.path}: preview ${JSON.stringify(byPath.get(b.path))} export ${JSON.stringify(out[b.sample])}`;
            break;
          }
        }
      }
      check(`export ${p.canvas}: emitted sampleBinds == the preview's bound values (${tracks.length} tracks × ${frames} frames)`, !mismatch && reads > 0, mismatch || undefined);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`\ncheck-skia-warp: ${failures === 0 ? "all checks passed" : `${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
