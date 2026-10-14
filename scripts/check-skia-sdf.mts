// check-skia-sdf: the Skia SDF family gate (specdocs/101326_skia-target.md §7
// Wave 2, family 5). CanvasKit in Node, CPU raster surfaces, the real
// evaluator on a data-only context (no GL — what the exporter runs):
//
//   1. every SDF primitive, operator, position op and scalar-field kind,
//      through every Skia SDF terminal (rasterize / mask / distance / bevel /
//      shade), generates SkSL that compiles in CanvasKit, declares exactly
//      the uniforms its binds supply, and renders finite pixels (spot
//      checks on a disc);
//   2. the SkSL depends on the tree's shape only: new values keep the text
//      (CanvasKit's compile cache), new structure changes it;
//   3. provenance: every tree uniform binds to the SDF node + param that
//      produced it — plain refs, `scale` for width/2 and degrees → radians,
//      deps for a value a socket overrode or a clamp changed;
//   4. what has no Skia lowering is refused with a reason and emits
//      transparent: SDF Displace, SDF From Image, Material ramp mode, Shade
//      height_mode=curve, splines over 128 segments;
//   5. export: the fixture's trees under one Skia Canvas export through
//      exportSkia (checkExportable: programs compile, uniforms match, the
//      bundle type-checks against react-native-skia when skia-harness is
//      installed);
//   6. keyframed SDF params (and an Animated Value wired into an exposed
//      one) export as timeline TRACKS — bind plans read from the scene
//      exporter — while socket-wired and spline-derived values sample.
//
//   npx tsx scripts/check-skia-sdf.mts

/* eslint-disable @typescript-eslint/no-explicit-any */
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type { SdfNode } from "@/engine/types";
import type { SkslProgramIR } from "@/engine/skia/scene-ir";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { evaluateGraph } = await import("@/engine/evaluator");
const { dataOnlyContext, makeSceneSampler } = await import("@/lib/skia-export/scene-sample");
const { exportSkiaScene } = await import("@/lib/skia-export");
const { compileSksl, packUniforms } = await import("@/engine/skia/sksl-program");
const { compileSdfSksl, SKIA_SDF_TERMINAL_UNIFORMS } = await import("@/engine/skia/sdf/sksl");
const { SKIA_SDF_TREE_TYPES } = await import("@/engine/skia/sdf/provenance");
const { getNodeDef } = await import("@/engine/registry");
const { isOfferedInSkiaLayer } = await import("@/engine/skia/layer-target");
const { checkExportable } = await import("./skia/export-check.ts");
const fx = await import("./fixtures/skia/sdf-graph.ts");

const require = createRequire(path.join(ROOT, "package.json"));
const CK = await require("canvaskit-wasm")();

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}

const MODES = ["rasterize", "mask", "distance", "bevel", "shade"] as const;
const TERMINAL: Record<(typeof MODES)[number], string> = {
  rasterize: "skia-sdf-rasterize",
  mask: "skia-sdf-to-mask",
  distance: "skia-sdf-to-distance-image",
  bevel: "skia-sdf-bevel",
  shade: "skia-sdf-shade",
};
const W = 64;
const H = 48;

// ---- helpers ------------------------------------------------------------------------

class G {
  nodes: GraphNode[] = [];
  edges: GraphEdge[] = [];
  add(id: string, type: string, params: Record<string, unknown> = {}, extra: Partial<GraphNode> = {}) {
    this.nodes.push({ id, type, params, ...extra });
    return id;
  }
  wire(source: string, target: string, socket: string, sourceHandle = "out:primary") {
    this.edges.push({ id: `${source}>${target}:${socket}:${this.edges.length}`, source, sourceHandle, target, targetHandle: `in:${socket}` });
  }
}

// A GL that accepts every call and returns a dummy object, so nodes that
// upload a texture as a side job (Noise's placeholder, SDF Spline's
// segments, Material's ramp LUT) still hand their SDF values downstream.
// The exporter's own context has no GL at all; section 5 runs on that.
const noGl: WebGL2RenderingContext = new Proxy({} as WebGL2RenderingContext, { get: () => () => ({}) });

function evaluate(g: G, targets: string[], size: [number, number] = [W, H], tick = 0) {
  const ctx = dataOnlyContext({ width: size[0], height: size[1] }, { fps: 60, ticksPerFrame: 1000 });
  ctx.gl = noGl;
  ctx.tick = tick;
  ctx.frame = Math.floor(tick / 1000);
  ctx.time = tick / 60_000;
  return evaluateGraph(g.nodes, g.edges, ctx, new Map(), null, undefined, null, { extraTargets: targets } as any);
}

function programOf(r: any, id: string): { program: SkslProgramIR | null; problems: string[]; expr: any } {
  const v = r.outputs.get(id)?.primary as any;
  if (!v || v.kind !== "skia_shader") return { program: null, problems: [`${id} produced ${v ? v.kind : "nothing"} (${r.errors[id] ?? "no error"})`], expr: null };
  return { program: v.expr.k === "program" ? v.expr.program : null, problems: v.problems ?? [], expr: v.expr };
}

function declared(sksl: string): string[] | string {
  const c = compileSksl(CK, sksl);
  if (!c.effect) return c.error;
  const out: string[] = [];
  for (let i = 0; i < c.effect.getUniformCount(); i++) out.push(c.effect.getUniformName(i));
  return out;
}

// Straight-alpha RGBA8 of a program on a CPU surface, row 0 = top.
function render(p: SkslProgramIR, w = W, h = H): Uint8Array {
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

const px = (buf: Uint8Array, x: number, y: number, w = W) => Array.from(buf.slice((y * w + x) * 4, (y * w + x) * 4 + 4));

// ---- 0. Skia-layer membership ---------------------------------------------------------
{
  const missing = SKIA_SDF_TREE_TYPES.filter((t) => getNodeDef(t)?.skia?.class !== "sksl");
  check(`the ${SKIA_SDF_TREE_TYPES.length} instrumented SDF tree defs carry skia: { class: "sksl" }`, missing.length === 0, missing.join(", "));
  const terminals = Object.values(TERMINAL);
  check(
    "the Skia SDF terminals are offered in a Skia layer and mirror their GL nodes",
    terminals.every((t) => isOfferedInSkiaLayer(getNodeDef(t)) && getNodeDef(t)?.skia?.mirrors === t.replace(/^skia-/, "")),
    terminals.map((t) => `${t}→${getNodeDef(t)?.skia?.mirrors}`).join(", ")
  );
  const refusedTypes = ["sdf-displace", "sdf-from-image", "sdf-rasterize", "sdf-shade", "sdf-to-spline"];
  check("refused / GL-only SDF defs stay out of Skia layers", refusedTypes.every((t) => !isOfferedInSkiaLayer(getNodeDef(t))));
  for (const t of terminals) {
    const def = getNodeDef(t)!;
    const mirror = getNodeDef(def.skia!.mirrors!)!;
    const same = def.params.length === mirror.params.length && def.params.every((p, i) => p === mirror.params[i]);
    check(`${t}: params are ${mirror.type}'s ParamDefs, same objects in the same order`, same);
  }
}

// ---- 1. every kind compiles in every mode ----------------------------------------------

type Case = { name: string; build: (g: G) => string };
const circle = (g: G, id: string, extra: Record<string, unknown> = {}) => g.add(id, "sdf-circle", { x: 0.5, y: 0.5, radius: 0.25, ...extra });
const withPos = (type: string, params: Record<string, unknown>) => (g: G) => {
  const op = g.add("op", type, params);
  const c = circle(g, "c", { radius: 0.1, x: 0.6 });
  g.wire(op, c, "position");
  return c;
};
const binary = (type: string, params: Record<string, unknown> = {}) => (g: G) => {
  const a = circle(g, "a", { x: 0.45 });
  const b = g.add("b", "sdf-rectangle", { x: 0.6, width: 0.3, height: 0.25, corner_radius: 0.04 });
  const op = g.add("op", type, params);
  g.wire(a, op, "a");
  g.wire(b, op, "b");
  return op;
};
const unary = (type: string, params: Record<string, unknown>) => (g: G) => {
  const s = g.add("s", "sdf-star", { radius: 0.3 });
  const op = g.add("op", type, params);
  g.wire(s, op, "sdf");
  return op;
};
const noiseField = (g: G, id = "nz") => g.add(id, "noise", { type: "simplex", scale: 3, octaves: 3, seed: 2, field_lo: -1, field_hi: 1 });

const CASES: Case[] = [
  { name: "circle", build: (g) => circle(g, "c") },
  { name: "circle painted", build: (g) => circle(g, "c", { paint: true, color: "#ff8800" }) },
  { name: "rectangle", build: (g) => g.add("r", "sdf-rectangle", { width: 0.5, height: 0.3, corner_radius: 0.05 }) },
  { name: "line segment", build: (g) => g.add("l", "sdf-line-segment", { thickness: 0.05 }) },
  { name: "polygon", build: (g) => g.add("p", "sdf-polygon", { sides: 7 }) },
  {
    name: "polygon, sides field (quantized)",
    build: (g) => {
      const n = noiseField(g);
      const p = g.add("p", "sdf-polygon", { quantize_sides: true });
      g.wire(n, p, "sides_field", "out:aux:field");
      return p;
    },
  },
  {
    name: "polygon, sides field (smooth)",
    build: (g) => {
      const n = noiseField(g);
      const p = g.add("p", "sdf-polygon", { quantize_sides: false });
      g.wire(n, p, "sides_field", "out:aux:field");
      return p;
    },
  },
  { name: "triangle", build: (g) => g.add("t", "sdf-triangle", {}) },
  { name: "star", build: (g) => g.add("s", "sdf-star", { points: 6, sharpness: 3 }) },
  {
    name: "spline (closed star)",
    build: (g) => {
      const sp = g.add("sp", "star", { outerRadius: 0.3, innerRadius: 0.12 });
      const s = g.add("s", "sdf-spline", {});
      g.wire(sp, s, "spline");
      return s;
    },
  },
  {
    name: "spline (open wave, force_open)",
    build: (g) => {
      const sp = g.add("sp", "wave", { resolution: 6 });
      const s = g.add("s", "sdf-spline", { subdivisions: 4, force_open: true, paint: true, color: "#00ffcc" });
      g.wire(sp, s, "spline");
      return s;
    },
  },
  {
    name: "union (3-ary) + empty slot",
    build: (g) => {
      const u = g.add("u", "sdf-union", { slots: ["a", "b", "c", "d"] });
      g.wire(circle(g, "c1", { x: 0.3 }), u, "a");
      g.wire(circle(g, "c2", { x: 0.7 }), u, "c");
      g.wire(g.add("r", "sdf-rectangle", {}), u, "b");
      return u;
    },
  },
  { name: "intersection", build: binary("sdf-intersection") },
  { name: "subtraction", build: binary("sdf-subtraction") },
  { name: "smooth union", build: binary("sdf-smooth-union", { smoothness: 0.08 }) },
  { name: "smooth union k=0", build: binary("sdf-smooth-union", { smoothness: 0 }) },
  { name: "smooth intersection", build: binary("sdf-smooth-intersection", { smoothness: 0.05 }) },
  { name: "smooth subtraction", build: binary("sdf-smooth-subtraction", { smoothness: 0.05 }) },
  { name: "morph", build: binary("sdf-morph", { amount: 0.3 }) },
  {
    name: "morph with an empty side",
    build: (g) => {
      const m = g.add("m", "sdf-morph", { amount: 0.5 });
      g.wire(circle(g, "c"), m, "a");
      return m;
    },
  },
  { name: "round", build: unary("sdf-round", { radius: 0.03 }) },
  { name: "round negative", build: unary("sdf-round", { radius: -0.02 }) },
  { name: "onion", build: unary("sdf-onion", { thickness: 0.02 }) },
  {
    name: "material (constant) over a smooth union of painted shapes",
    build: (g) => {
      const su = binary("sdf-smooth-union", { smoothness: 0.1 })(g);
      const m = g.add("m", "sdf-material", { color: "#3366ff" });
      g.wire(su, m, "sdf");
      const u = g.add("u", "sdf-union", { slots: ["a", "b", "c"] });
      g.wire(m, u, "a");
      g.wire(circle(g, "p", { x: 0.2, radius: 0.1, paint: true, color: "#ff0000" }), u, "b");
      return u;
    },
  },
  {
    name: "material, color socket wired",
    build: (g) => {
      const col = g.add("col", "color-literal", { color: "#22cc88", alpha: 1, count: 1 });
      const m = g.add("m", "sdf-material", {});
      g.wire(circle(g, "c"), m, "sdf");
      g.wire(col, m, "color");
      return m;
    },
  },
  { name: "translate", build: withPos("sdf-translate", { tx: 0.1, ty: -0.05 }) },
  { name: "scale", build: withPos("sdf-scale", { sx: 1.5, sy: 0.7 }) },
  { name: "rotate", build: withPos("sdf-rotate", { rotation: 33 }) },
  {
    name: "rotate, angle field",
    build: (g) => {
      const n = noiseField(g);
      const r = g.add("op", "sdf-rotate", {});
      g.wire(n, r, "angle_field", "out:aux:field");
      const c = g.add("c", "sdf-rectangle", { width: 0.4, height: 0.1 });
      g.wire(r, c, "position");
      return c;
    },
  },
  { name: "repeat (infinite, jitter)", build: withPos("sdf-repeat", { spacing_x: 0.2, spacing_y: 0.2, rotation_jitter: 0.5, position_jitter_x: 0.02, scale_jitter: 0.2, seed: 4 }) },
  { name: "repeat (bounded)", build: withPos("sdf-repeat", { bounded: true, limit_x: 1, limit_y: 2 }) },
  {
    name: "repeat cell id → noise field → rotate",
    build: (g) => {
      const rep = g.add("rep", "sdf-repeat", { spacing_x: 0.25, spacing_y: 0.25 });
      const n = noiseField(g);
      g.wire(rep, n, "field_position", "out:aux:cell_id");
      const r = g.add("rot", "sdf-rotate", {});
      g.wire(rep, r, "position");
      g.wire(n, r, "angle_field", "out:aux:field");
      const s = g.add("s", "sdf-rectangle", { width: 0.1, height: 0.03 });
      g.wire(r, s, "position");
      return s;
    },
  },
  { name: "mirror x", build: withPos("sdf-mirror", { axis: "x" }) },
  { name: "mirror y", build: withPos("sdf-mirror", { axis: "y" }) },
  { name: "mirror both", build: withPos("sdf-mirror", { axis: "both" }) },
  { name: "polar", build: withPos("sdf-polar", { segments: 5, rotation: 0.2 }) },
  { name: "twist", build: withPos("sdf-twist", { strength: 4 }) },
  {
    name: "twist, strength field",
    build: (g) => {
      const n = noiseField(g);
      const t = g.add("op", "sdf-twist", {});
      g.wire(n, t, "strength_field", "out:aux:field");
      const r = g.add("r", "sdf-rectangle", { width: 0.4, height: 0.08 });
      g.wire(t, r, "position");
      return r;
    },
  },
  {
    name: "shared position chain (branched into two shapes)",
    build: (g) => {
      const t = g.add("t", "sdf-translate", { tx: 0.05 });
      const a = circle(g, "a", { x: 0.3, radius: 0.1 });
      const b = g.add("b", "sdf-star", { x: 0.7, radius: 0.15 });
      g.wire(t, a, "position");
      g.wire(t, b, "position");
      const u = g.add("u", "sdf-union", { slots: ["a", "b", "c"] });
      g.wire(a, u, "a");
      g.wire(b, u, "b");
      return u;
    },
  },
];

{
  const bad: string[] = [];
  let programs = 0;
  let fieldPrograms = 0;
  let splinePrograms = 0;
  for (const c of CASES) {
    const g = new G();
    const root = c.build(g);
    const ids = MODES.map((m) => g.add(`t_${m}`, TERMINAL[m], m === "shade" ? { light: true, glow: true, contour: true, bleed: true } : {}));
    ids.forEach((t) => g.wire(root, t, "sdf"));
    const r = evaluate(g, ids);
    for (const [i, m] of MODES.entries()) {
      const { program, problems } = programOf(r, ids[i]);
      if (!program) {
        bad.push(`${c.name} / ${m}: ${problems.join(" ")}`);
        continue;
      }
      const names = declared(program.sksl);
      if (typeof names === "string") {
        bad.push(`${c.name} / ${m}: compile: ${names.split("\n")[0]}`);
        continue;
      }
      const supplied = Object.keys(program.uniforms);
      const missing = names.filter((n) => !supplied.includes(n));
      const extra = supplied.filter((n) => !names.includes(n));
      if (missing.length || extra.length) bad.push(`${c.name} / ${m}: uniforms missing [${missing}] extra [${extra}]`);
      if (m === "rasterize") {
        // White on black by default: something must be drawn, not all of it.
        const pix = render(program);
        let lit = 0;
        let dark = 0;
        for (let k = 0; k < pix.length; k += 4) {
          const v = Math.max(pix[k], pix[k + 1], pix[k + 2]);
          if (v > 100) lit++;
          else if (v < 30) dark++;
        }
        if (!lit || !dark) bad.push(`${c.name}: rasterize drew ${lit} lit / ${dark} dark px of ${W * H}`);
      }
      if (program.sksl.includes("sdf_snoiseFbm(")) fieldPrograms++;
      if (/sdf_spline\d+\(/.test(program.sksl)) splinePrograms++;
      programs++;
    }
  }
  check(`${CASES.length} trees × ${MODES.length} terminals: every program compiles in CanvasKit, declares exactly its binds, and rasterize draws the shape (${programs} programs)`, bad.length === 0, bad.slice(0, 6).join(" | "));
  const fieldCases = CASES.filter((c) => /field/.test(c.name)).length;
  check(`the scalar-field trees really emit the noise field (${fieldPrograms} programs)`, fieldPrograms === fieldCases * MODES.length, `${fieldCases} field cases`);
  check(`the spline trees really emit the segment loop (${splinePrograms} programs)`, splinePrograms === 2 * MODES.length);
}

// Every Math op the scalar-field emitter knows (trees built directly: the
// Math node's field mode is not part of a Skia layer, but the generator
// must not emit SkSL that fails ES2).
{
  const OPS = ["Add", "Subtract", "Multiply", "Divide", "Multiply Add", "Power", "Logarithm", "Square Root", "Inverse Square Root", "Absolute", "Exponent", "Minimum", "Maximum", "Less Than", "Greater Than", "Sign", "Compare", "Smooth Minimum", "Smooth Maximum", "Round", "Floor", "Ceiling", "Truncate", "Fraction", "Truncated Modulo", "Floored Modulo", "Wrap", "Snap", "Ping-Pong", "Sine", "Cosine", "Tangent", "Arcsine", "Arccosine", "Arctangent", "Arctan2", "Hyperbolic Sine", "Hyperbolic Cosine", "Hyperbolic Tangent", "To Radians", "To Degrees", "Unknown Op"];
  const bad: string[] = [];
  const k = (value: number) => ({ kind: "constant" as const, value });
  const terminal = Object.fromEntries(SKIA_SDF_TERMINAL_UNIFORMS.rasterize.map(([n, t]) => [n, { v: t === "color" ? [1, 1, 1, 1] : n === "aspect_correct" ? 1 : 0.5 }]));
  for (const op of OPS) {
    for (const clamp of [false, true]) {
      const field = {
        kind: "remap" as const,
        clamp,
        inMin: -1,
        inMax: 1,
        outMin: 0,
        outMax: 3,
        child: { kind: "mathOp" as const, op, clamp, a: { kind: "noise" as const, position: { kind: "canvasUv" as const }, noiseType: "simplex" as const, scale: 2, octaves: 2, persistence: 0.5, lacunarity: 2, offsetX: 0, offsetY: 0, seed: 1, outLo: -1, outHi: 1 }, b: k(0.7), c: k(0.2) },
      };
      const root: SdfNode = { kind: "polygon", position: { kind: "rotate", child: { kind: "canvasUv" }, rotation: field, cx: 0.5, cy: 0.5 }, cx: 0.5, cy: 0.5, r: 0.3, sides: 5 };
      const res = compileSdfSksl(root, "rasterize", { resolution: [W, H], terminal });
      const c = res.program ? compileSksl(CK, res.program.sksl) : null;
      if (!c?.effect) bad.push(`${op}${clamp ? " (clamp)" : ""}: ${res.problems.join(" ") || c?.error.split("\n")[0]}`);
    }
  }
  check(`scalar fields: remap (±clamp) × ${OPS.length} math ops (incl. the ES2 polyfills) compile`, bad.length === 0, bad.slice(0, 4).join(" | "));
}

// Spot pixels: a white disc of radius 0.25 on black, rasterize at 64×48 with
// aspect correction — centre in, corners out, mask / distance / invert agree.
{
  const g = new G();
  const c = circle(g, "c");
  const ids = [
    g.add("ras", "skia-sdf-rasterize", { softness: 0 }),
    g.add("msk", "skia-sdf-to-mask", { softness: 0 }),
    g.add("inv", "skia-sdf-to-mask", { softness: 0, invert: true }),
    g.add("dst", "skia-sdf-to-distance-image", { range: 0.25 }),
  ];
  ids.forEach((t) => g.wire(c, t, "sdf"));
  const r = evaluate(g, ids);
  const [ras, msk, inv, dst] = ids.map((id) => render(programOf(r, id).program!));
  check("rasterize: centre is foreground, corner background", px(ras, 32, 24).join() === "255,255,255,255" && px(ras, 1, 1).join() === "0,0,0,255", `${px(ras, 32, 24)} / ${px(ras, 1, 1)}`);
  // Aspect-corrected: the disc is round in pixels (radius 0.25 × 64 = 16 px).
  check(
    "aspect correction: the disc spans ±16 px both ways",
    px(ras, 32 + 14, 24)[0] === 255 && px(ras, 32 + 18, 24)[0] === 0 && px(ras, 32, 24 + 14)[0] === 255 && px(ras, 32, 24 + 18)[0] === 0,
    `${px(ras, 46, 24)[0]} ${px(ras, 50, 24)[0]} ${px(ras, 32, 38)[0]} ${px(ras, 32, 42)[0]}`
  );
  check("mask: inside white, outside black, opaque", px(msk, 32, 24).join() === "255,255,255,255" && px(msk, 1, 1).join() === "0,0,0,255");
  check("mask invert flips it", px(inv, 32, 24).join() === "0,0,0,255" && px(inv, 1, 1).join() === "255,255,255,255");
  // Distance at the centre pixel is ≈ −0.24 (its centre is half a pixel
  // off the disc's) → t ≈ −0.96 → almost the inside colour (#000000,
  // from the #808080 zero colour); far outside clamps to the outside
  // colour (#ffffff).
  const centre = px(dst, 32, 24);
  check("distance image: centre ≈ inside colour, corner = outside colour", centre[0] <= 8 && centre[3] === 255 && px(dst, 0, 0).join() === "255,255,255,255", `${centre} / ${px(dst, 0, 0)}`);
}

// ---- 2. determinism ---------------------------------------------------------------------
{
  const build = (radius: number, sides: number, rot: number) => {
    const g = new G();
    const t = g.add("rot", "sdf-rotate", { rotation: rot });
    const a = circle(g, "a", { radius });
    const b = g.add("b", "sdf-polygon", { sides });
    g.wire(t, b, "position");
    const u = g.add("u", "sdf-smooth-union", { smoothness: radius / 4 });
    g.wire(a, u, "a");
    g.wire(b, u, "b");
    const ras = g.add("ras", "skia-sdf-rasterize", { foreground: radius > 0.2 ? "#ff0000" : "#00ff00" });
    g.wire(u, ras, "sdf");
    return programOf(evaluate(g, ["ras"]), "ras").program!;
  };
  const p1 = build(0.1, 5, 10);
  const p2 = build(0.3, 8, 70);
  check("same shape, new values → identical SkSL (the compile cache hits)", p1.sksl === p2.sksl);
  check("…and the uniforms carry the new values", JSON.stringify(p1.uniforms) !== JSON.stringify(p2.uniforms));
  const g = new G();
  const a = circle(g, "a");
  const ras = g.add("ras", "skia-sdf-rasterize", {});
  g.wire(a, ras, "sdf");
  check("new structure → new SkSL", programOf(evaluate(g, ["ras"]), "ras").program!.sksl !== p1.sksl);
}

// ---- 3. provenance ------------------------------------------------------------------------
{
  const g = new G();
  const vec = g.add("vec", "vec2-literal", { x: 0.3, y: 0.4 });
  const rad = g.add("rad", "constant", { value: 0.12 });
  const c1 = circle(g, "c1", { radius: 0.2 });
  const c2 = circle(g, "c2");
  g.wire(vec, c2, "center");
  g.wire(rad, c2, "radius");
  const rect = g.add("rect", "sdf-rectangle", { width: 0.5, height: 0.3, corner_radius: 0.4 });
  const star = g.add("star", "sdf-star", { points: 5, sharpness: 9 });
  const rot = g.add("rot", "sdf-rotate", { rotation: 45 });
  g.wire(rot, star, "position");
  const mat = g.add("mat", "sdf-material", { color: "#336699" });
  g.wire(rect, mat, "sdf");
  const u = g.add("u", "sdf-union", { slots: ["a", "b", "c", "d", "e"] });
  [c1, c2, mat, star].forEach((s, i) => g.wire(s, u, "abcd"[i]));
  const ras = g.add("ras", "skia-sdf-rasterize", { foreground: "#ffaa00", softness: 2 });
  g.wire(u, ras, "sdf");
  const prog = programOf(evaluate(g, ["ras"]), "ras").program!;
  const binds = Object.entries(prog.uniforms);
  const find = (pred: (b: any) => boolean) => binds.find(([, b]) => pred(b))?.[1] as any;
  const refTo = (node: string, param: string) => find((b) => b.ref?.node === node && b.ref?.param === param);
  const depOn = (node: string, param: string) => find((b) => b.deps?.some((d: any) => d.node === node && d.param === param));
  check("circle radius → ref sdf-circle.radius", refTo("c1", "radius")?.v === 0.2);
  check("circle x / y → refs", refTo("c1", "x")?.v === 0.5 && refTo("c1", "y")?.v === 0.5);
  check("wired center (vec2 socket) → deps on the socket", depOn("c2", "center")?.v !== undefined && !refTo("c2", "x"));
  check("wired radius (scalar socket) → deps on the socket", depOn("c2", "radius")?.v === 0.12);
  const sx = refTo("rect", "width");
  check("rect half-extent → ref width with scale 0.5", sx?.ref.scale === 0.5 && sx.v === 0.25, JSON.stringify(sx));
  const cr = refTo("rect", "corner_radius");
  check("rect corner radius past half the short side → raw ref, clamped in-shader", cr?.v === 0.4 && /min\(min\(/.test(prog.sksl), JSON.stringify(cr));
  const r = refTo("rot", "rotation");
  check("rotate degrees → ref with scale π/180", r?.ref.scale === Math.PI / 180 && r.v === 45 * (Math.PI / 180), JSON.stringify(r));
  check("star sharpness 9 > points 5 → raw ref, the clamp re-applied in-shader", refTo("star", "sharpness")?.v === 9 && /max\(min\(/.test(prog.sksl));
  const col = refTo("mat", "color");
  check("material color → ref, float4 RGBA (alpha 1, 8-bit exact)", JSON.stringify(col?.v) === JSON.stringify([0x33 / 255, 0x66 / 255, 0x99 / 255, 1]), JSON.stringify(col));
  check("terminal params → refs on the Skia node", refTo("ras", "softness")?.v === 2 && JSON.stringify(refTo("ras", "foreground")?.v) === JSON.stringify([1, 170 / 255, 0, 1]));
  check("terminal booleans / enums → deps (an animated toggle samples instead of refusing)", !!depOn("ras", "aspect_correct"));
  const tree = binds.filter(([k]) => /^u\d+_/.test(k));
  const untagged = tree.filter(([, b]: any) => !b.ref && !b.deps).map(([k]) => k);
  check(`every tree uniform (${tree.length}) carries a ref or deps`, untagged.length === 0, untagged.join(", "));
}

// ---- 4. refusals --------------------------------------------------------------------------
{
  const cases: [string, (g: G) => string, string][] = [
    [
      "SDF Displace",
      (g) => {
        const n = g.add("img", "noise", {});
        const d = g.add("d", "sdf-displace", {});
        g.wire(circle(g, "c"), d, "sdf");
        g.wire(n, d, "field");
        return d;
      },
      "Displace",
    ],
    ["Material ramp mode", (g) => {
      const m = g.add("m", "sdf-material", { color_mode: "ramp" });
      g.wire(circle(g, "c"), m, "sdf");
      return m;
    }, "ramp"],
    [
      "SDF Spline over 128 segments",
      (g) => {
        const sp = g.add("sp", "wave", { resolution: 32, cycles: 4 });
        const s = g.add("s", "sdf-spline", { subdivisions: 16 });
        g.wire(sp, s, "spline");
        return s;
      },
      "128",
    ],
  ];
  for (const [name, build, word] of cases) {
    const g = new G();
    const root = build(g);
    const ras = g.add("ras", "skia-sdf-rasterize", {});
    g.wire(root, ras, "sdf");
    const r = evaluate(g, ["ras"]);
    const out = programOf(r, "ras");
    const transparent = out.expr?.k === "call" && JSON.stringify(out.expr.params.color.v) === "[0,0,0,0]";
    check(`refused: ${name} → transparent + a reason`, transparent && out.problems.some((p) => p.includes(word)), out.problems.join(" ") || JSON.stringify(r.errors));
  }
  // Ramp mode refused by the generator itself (a tree built directly).
  const terminal = Object.fromEntries(SKIA_SDF_TERMINAL_UNIFORMS.rasterize.map(([n, t]) => [n, { v: t === "color" ? [1, 1, 1, 1] : 1 }]));
  const ramp = compileSdfSksl({ kind: "material", color: [1, 1, 1], bleed: 1, ramp: { lut: {} as WebGLTexture, t: { kind: "constant", value: 0.5 } }, child: { kind: "circle", position: { kind: "canvasUv" }, cx: 0.5, cy: 0.5, r: 0.2 } }, "rasterize", { resolution: [W, H], terminal });
  check("generator: Material ramp mode refuses with a reason", !ramp.program && ramp.problems.some((p) => p.includes("ramp")));
  const img = compileSdfSksl({ kind: "sdfFromImage", position: { kind: "canvasUv" }, image: {} as WebGLTexture, range: 0.1 }, "rasterize", { resolution: [W, H], terminal });
  check("generator: an image-sampled SDF (From Image / Text) refuses", !img.program && img.problems.some((p) => p.includes("image")));
  const shadeDef = getNodeDef("skia-sdf-shade")!;
  const pts = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, x: i / (n - 1), y: (i % 3) / 2 }));
  check(
    "Shade height_mode=curve: up to 16 curve points port, more are refused in validateParams",
    (shadeDef.validateParams?.({ light: true, height_mode: "curve", height_curve: pts(16) }) ?? []).length === 0 &&
      (shadeDef.validateParams?.({ light: true, height_mode: "curve", height_curve: pts(17) }) ?? []).length === 1
  );
}

// ---- 5. export -------------------------------------------------------------------------------
const graph = fx.sdfGraph();
{
  // Every fixture tree under one canvas: one bundle, one type-check. The
  // `field` tree is left out: its Noise node is not a Skia-layer node (and
  // needs GL), so it proves the generator only (section 1, compare:skia).
  const nodes = [...graph.nodes];
  const edges = [...graph.edges];
  const fills = graph.canvases
    .filter((c) => c !== "s_field")
    .map((c) => edges.find((e) => e.target === c && e.targetHandle === "in:scene")!.source);
  let level = fills;
  let groupCount = 0;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 4) {
      const id = `grp${groupCount++}`;
      nodes.push({ id, type: "skia-group", params: { opacity: 0.75 } });
      level.slice(i, i + 4).forEach((src, k) => edges.push({ id: `${src}>${id}`, source: src, sourceHandle: "out:primary", target: id, targetHandle: `in:child${k + 1}` }));
      next.push(id);
    }
    level = next;
  }
  nodes.push({ id: "all", type: "skia-canvas", params: { background_on: false } });
  edges.push({ id: "root>all", source: level[0], sourceHandle: "out:primary", target: "all", targetHandle: "in:scene" });
  const res = await checkExportable({ nodes, edges, canvasId: "all", slot: "sdf", typecheck: true, timeline: fx.SDF_TIMELINE });
  check(`the fixture's ${fills.length} Skia SDF draws export under one Skia Canvas`, res.problems.length === 0 && !!res.files, res.problems.slice(0, 3).join(" | "));
  const badProgs = res.programs.filter((p) => !p.ok);
  check(`every exported runtime program compiles and declares exactly its binds (${res.programs.length})`, res.programs.length >= fills.length && badProgs.length === 0, badProgs.map((p) => `${p.where}: ${p.detail}`).slice(0, 3).join(" | "));
  check(
    res.typecheck.ran ? "the emitted bundle type-checks against react-native-skia 3.4.0 + Reanimated 4.7" : `bundle type-check: ${res.typecheck.output}`,
    res.typecheck.ok,
    res.typecheck.ran ? res.typecheck.output : undefined
  );
  const unexpected = res.warnings.filter((w) => !/clip window/.test(w));
  check("export warnings: none (every animated value is a track or a declared derived bind)", unexpected.length === 0, unexpected.slice(0, 3).join(" | "));
}

// ---- 6. keyframed SDF params → tracks -------------------------------------------------------
{
  const nodes = graph.nodes.map((n) => ({ ...n, params: { ...n.params } }));
  const edges = [...graph.edges];
  // An Animated Value wired into an exposed SDF param, and a keyframed
  // terminal param, on the prims tree.
  nodes.push({ id: "av", type: "animated-value", params: { value: 0.12, unit: "frames" }, animation: { value: { animated: true, trackVisible: true, keyframes: [{ tick: 0, value: 0.1, easingOut: "easeOutBack" }, { tick: 60_000, value: 0.16, easingOut: "linear" }] } } });
  const poly = nodes.find((n) => n.id === "p_poly")!;
  poly.exposedParams = ["radius"];
  edges.push({ id: "av>p_poly", source: "av", sourceHandle: "out:primary", target: "p_poly", targetHandle: "in:param:radius" });
  const kras = nodes.find((n) => n.id === "k_prims")!;
  kras.animation = { softness: { animated: true, trackVisible: true, keyframes: [{ tick: 0, value: 1, easingOut: "linear" }, { tick: 60_000, value: 4, easingOut: "linear" }] } };

  const planOf = (canvasId: string) => {
    const canvas = { width: 256, height: 256 };
    const sampler = makeSceneSampler(nodes, edges, canvasId, canvas, fx.SDF_TIMELINE);
    if ("problem" in sampler) throw new Error(sampler.problem);
    const scene = sampler.sampleAt(0)!;
    const runtimeSource = fs.readFileSync(path.join(ROOT, "src/lib/skia-export/runtime/toolbox-timeline.ts"), "utf8");
    const r = exportSkiaScene(scene, nodes, edges, { name: canvasId, timeline: fx.SDF_TIMELINE, runtimeSource, sampleAt: (t) => sampler.sampleAt(t) });
    const program = (scene.root as any).paint?.shader?.program as SkslProgramIR;
    const byUniform = new Map<string, any>();
    for (const b of r.binds) {
      const m = b.path.match(/paint\.shader\.program\.uniforms\.(\w+)$/);
      if (m) byUniform.set(m[1], b.plan);
    }
    return { r, program, byUniform };
  };
  const planFor = (canvasId: string, node: string, param: string) => {
    const { program, byUniform } = planOf(canvasId);
    const name = Object.entries(program.uniforms).find(([, b]) => b.ref?.node === node && b.ref?.param === param)?.[0];
    return name ? byUniform.get(name) : undefined;
  };
  const tracks: [string, string, string, string][] = [
    ["s_prims", "p_circle", "radius", "keyframed circle radius"],
    ["s_prims", "p_star", "sharpness", "keyframed star sharpness (clamped in-shader)"],
    ["s_prims", "p_poly", "radius", "Animated Value wired into an exposed polygon radius"],
    ["s_prims", "k_prims", "softness", "keyframed terminal softness"],
    ["s_bool", "b_su", "smoothness", "keyframed smooth-union smoothness"],
    ["s_mods", "m_morph", "amount", "keyframed morph amount"],
    ["s_pos", "q_r", "rotation", "keyframed rotate degrees (scaled ref)"],
    ["s_repeat", "r_inf", "spacing_x", "keyframed repeat spacing"],
    ["s_mat", "c_mat", "color", "keyframed material color (color track)"],
  ];
  for (const [canvas, node, param, label] of tracks) {
    const plan = planFor(canvas, node, param);
    check(`track: ${label} (${node}.${param})`, plan?.kind === "track", JSON.stringify(plan)?.slice(0, 160));
  }
  const rot = planFor("s_pos", "q_r", "rotation");
  check("…the rotate track carries scale π/180", rot?.tracks?.[0]?.scale === Math.PI / 180);
  const { r: spl, program: splProg, byUniform: splPlans } = planOf("s_spline");
  const segs = Object.entries(splProg.uniforms).find(([k]) => /_segs$/.test(k));
  const segPlan = segs ? splPlans.get(segs[0]) : undefined;
  check("an animated spline's segments sample per frame (derived from the wired spline)", segPlan?.kind === "sampled" && spl.problems.length === 0, JSON.stringify(segPlan)?.slice(0, 120));
  const staticPlan = planFor("s_prims", "p_rect", "x");
  check("an unanimated SDF param stays static", staticPlan?.kind === "static");
}

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\ncheck-skia-sdf: all checks passed");
