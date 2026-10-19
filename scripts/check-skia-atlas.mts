// check-skia-atlas: Copy to Points (Skia) — points + an instance drawing →
// N vector copy groups or one sprite-sheet <Atlas> (specdocs/101326_skia-
// target.md §7 Wave 3 lane A, §3.4 built and measured). No GPU, no device:
//
//   1. defs: skia-copy-to-points mirrors copy-to-points with its own
//      ParamDefs; Point / Grid / Space Fill / Voronoi are offered in Skia
//      layers and evaluate data-only (no GL: the exporter's sampler);
//   2. placement: every copy — group strategy (outer T·R·S × inner
//      R·S·T(−anchor), via the renderer's own transformMatrix) and atlas
//      (composeAtlasXforms over the sheet) — maps instance px exactly where
//      the GL vertex shader puts them (canvas01 → px, rotation + add, scale ×
//      mul, the anchor), at 256² and 320×180;
//   3. strategy: auto → groups below ATLAS_AUTO_MIN, atlas from it; atlas
//      needs uniform per-point scale; spline / point modes are the GL node's
//      own output, through coerceValue;
//   4. anchors: sceneBounds (tight cubic boxes, strokes, transforms, clips,
//      unbounded fills / text) and glContentCenter vs the GL node's readback
//      emulated on a CanvasKit raster of the instance (bilinear taps, 8-bit)
//      — equal for symmetric and flat-edged drawings; the star's narrow tip
//      residual is printed, not held;
//   5. pixels (CanvasKit CPU): atlas ≡ groups at integer placement, the
//      sheet at k = 2 is crisp, the texture cache renders a sheet once,
//      rotated / scaled copies agree in ink mass and centroid;
//   6. export: per case, the bind kinds — keyframed Scale × / Rotate + over
//      static points are TRACKS in both strategies (atlas rotate / scale over
//      static xforms), moving points are SAMPLED; an animated instance under
//      an atlas is refused (the sheet renders once) and fine under groups;
//      the emitted RSXform worklet, run on the emitted timeline, reproduces
//      the preview's xforms at every frame bit for bit; worklets call only
//      functions declared above them; the bundle type-checks in skia-harness;
//      skia-harness/src/bundle-atlas is today's export;
//   7. the GL node's image mode, on a GL that records its calls: the taps
//      premultiplied before filtering, premultiplied source-over into a
//      scratch texture, one unpremultiply pass into the straight output (the
//      AA-edge darkening fixed 2026-10-16; its pixels are compare:skia's
//      `gl_id` vs `inst_skc` and `gl_gridc` vs `ska_gridc_skc`).
//
//   npx tsx scripts/check-skia-atlas.mts

/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CanvasKit, Image } from "canvaskit-wasm";
import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type { SkiaNode, SkiaScene } from "@/engine/skia/scene-ir";
import type { ImageGroupValue, ImageValue, PointsValue, RenderContext, SkiaDrawValue } from "@/engine/types";
import { sameUpToFloatNoise } from "./skia/snapshot-diff.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { getNodeDef } = await import("@/engine/registry");
const { evaluateGraph } = await import("@/engine/evaluator");
const { coerceValue } = await import("@/engine/coerce");
const { isOfferedInSkiaLayer } = await import("@/engine/skia/layer-target");
const { renderScene, transformMatrix, composeAtlasXforms } = await import("@/engine/skia/scene-render");
const { sceneBounds, svgPathBox } = await import("@/engine/skia/scene-bounds");
const { exportSkia, makeSceneSampler } = await import("@/lib/skia-export");
const { dataOnlyContext } = await import("@/lib/skia-export/scene-sample");
const { copyToPointsNode } = await import("@/nodes/effect/copy-to-points");
const { skiaCopyToPointsNode, glContentCenter, ATLAS_AUTO_MIN } = await import("@/nodes/skia/copy-to-points");
const { checkExportable } = await import("./skia/export-check.ts");
const fx = await import("./fixtures/skia/atlas-graph.ts");

const require = createRequire(path.join(ROOT, "package.json"));
const CK: CanvasKit = await require("canvaskit-wasm")();

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${!cond && detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
const same = (a: unknown, b: unknown) =>
  Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => Object.is(x, b[i])) : Object.is(a, b);

const TL = fx.ATLAS_EXPORT_TIMELINE;
const FRAMES = TL.sceneDurationTicks / TL.ticksPerFrame + 1;
const runtimeSource = fs.readFileSync(path.join(ROOT, "src/lib/skia-export/runtime/toolbox-timeline.ts"), "utf8");
const SQUARE = { width: 256, height: 256 };
const WIDE = { width: 320, height: 180 };

const defaults = (type: string) => Object.fromEntries(getNodeDef(type)!.params.map((p) => [p.name, p.default]));

function closure(g: { nodes: GraphNode[]; edges: GraphEdge[] }, rootId: string) {
  const keep = new Set([rootId]);
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const e of g.edges) {
      if (e.target === id && !keep.has(e.source)) {
        keep.add(e.source);
        stack.push(e.source);
      }
    }
  }
  return { nodes: g.nodes.filter((n) => keep.has(n.id)).map((n) => structuredClone(n)), edges: g.edges.filter((e) => keep.has(e.source) && keep.has(e.target)) };
}

function sceneOf(g: { nodes: GraphNode[]; edges: GraphEdge[] }, canvasId: string, canvas = SQUARE, tick = 0): SkiaScene {
  const s = makeSceneSampler(g.nodes, g.edges, canvasId, canvas, TL);
  if ("problem" in s) throw new Error(s.problem);
  const sc = s.sampleAt(tick);
  if (!sc) throw new Error(s.lastProblem() ?? "no scene");
  return sc;
}

function render(scene: SkiaScene, o: { k?: number; cache?: Map<string, Image> } = {}) {
  const k = o.k ?? 1;
  const w = Math.round(scene.width * k);
  const h = Math.round(scene.height * k);
  const surface = CK.MakeSurface(w, h)!;
  const canvas = surface.getCanvas();
  canvas.clear(CK.TRANSPARENT);
  if (k !== 1) canvas.scale(k, k);
  const res = renderScene(CK, canvas, scene, { surfaceSize: [w, h], ...(o.cache ? { textureCache: o.cache } : {}) });
  surface.flush();
  const snap = surface.makeImageSnapshot();
  const px = snap.readPixels(0, 0, { width: w, height: h, colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB }) as Uint8Array;
  res.release();
  snap.delete();
  surface.delete();
  return { px: new Uint8Array(px), w, h, problems: res.problems };
}

// Premultiplied ink stats: mass, centroid, and the max channel difference.
function ink(px: Uint8Array, w: number) {
  let m = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3] / 255;
    m += a;
    sx += a * ((i / 4) % w);
    sy += a * Math.floor(i / 4 / w);
  }
  return { mass: m, cx: sx / m, cy: sy / m };
}
function maxDiff(a: Uint8Array, b: Uint8Array): number {
  let mx = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 4; c++) {
      const va = c < 3 ? (a[i + c] * a[i + 3]) / 255 : a[i + 3];
      const vb = c < 3 ? (b[i + c] * b[i + 3]) / 255 : b[i + 3];
      mx = Math.max(mx, Math.abs(va - vb));
    }
  }
  return mx;
}

// ---- 1. defs ------------------------------------------------------------------------------------
{
  const def = getNodeDef("skia-copy-to-points");
  check(
    "skia-copy-to-points: native Skia def mirroring copy-to-points, offered in a Skia layer",
    !!def && def.skia?.class === "native" && def.skia.mirrors === "copy-to-points" && isOfferedInSkiaLayer(def)
  );
  const shared = ["mode", "pick_attr", "pick_seed", "anchor", "anchor_x", "anchor_y", "draw_order", "output_tag", "driver_attr", "scale_mul_default", "rotate_add_default"];
  check(
    "…its params are Copy to Points' own ParamDefs (same objects) plus strategy",
    !!def && shared.every((n) => def.params.find((p) => p.name === n) === copyToPointsNode.params.find((p) => p.name === n)) && def.params.some((p) => p.name === "strategy"),
    def?.params.map((p) => p.name).join(", ")
  );
  check(
    "…the instance socket follows the mode (skia_draw / spline / points), output too",
    def!.resolveInputs!({ mode: "image" }).find((i) => i.name === "instance")?.type === "skia_draw" &&
      def!.resolveInputs!({ mode: "spline" }).find((i) => i.name === "instance")?.type === "spline" &&
      def!.resolvePrimaryOutput!({ mode: "point" }) === "points" &&
      def!.resolvePrimaryOutput!({ mode: "text" }) === "skia_draw"
  );
  const sources = ["point", "grid", "space-fill", "voronoi"];
  const bad = sources.filter((t) => !isOfferedInSkiaLayer(getNodeDef(t)));
  check(`the CPU point sources (${sources.join(", ")}) are offered in Skia layers`, bad.length === 0, bad.join(", "));
  // Data-only evaluation: no GL anywhere (the exporter's sampler).
  const ctx = dataOnlyContext(SQUARE, TL);
  const outs: Record<string, PointsValue | undefined> = {};
  const nodes: GraphNode[] = [
    { id: "p", type: "point", params: { ...defaults("point"), count: 3 } },
    { id: "g", type: "grid", params: { ...defaults("grid"), countX: 4, countY: 3 } },
    { id: "sf", type: "space-fill", params: { ...defaults("space-fill"), max_lines: 12, seed: 3 } },
    { id: "v", type: "voronoi", params: { ...defaults("voronoi"), source: "scatter", placement: "uniform", count: 20, seed: 5 } },
    { id: "vl", type: "voronoi", params: { ...defaults("voronoi"), source: "lattice", scale: 4 } },
  ];
  const r = evaluateGraph(nodes, [], ctx, new Map(), null, undefined, null, {
    extraTargets: nodes.map((n) => n.id),
    extraConsumed: new Map([["sf", ["primary", "tips"]], ["v", ["primary", "centers"]], ["vl", ["primary", "centers"]]]),
  });
  outs.p = r.outputs.get("p")?.primary as PointsValue;
  outs.g = r.outputs.get("g")?.primary as PointsValue;
  outs.sf = r.outputs.get("sf")?.aux?.tips as PointsValue;
  outs.v = r.outputs.get("v")?.aux?.centers as PointsValue;
  outs.vl = r.outputs.get("vl")?.aux?.centers as PointsValue;
  check(
    "they evaluate with no GL: Point 3, Grid 12, Space Fill tips, Voronoi centers (scatter 20, lattice)",
    !Object.keys(r.errors).length && outs.p?.count === 3 && outs.g?.count === 12 && (outs.sf?.count ?? 0) > 0 && outs.v?.count === 20 && (outs.vl?.count ?? 0) > 0,
    JSON.stringify({ errors: r.errors, counts: Object.fromEntries(Object.entries(outs).map(([k, v]) => [k, v?.count])) })
  );
  check(
    "Voronoi centers carry a uniform per-cell scale (atlas-able)",
    !!outs.v?.scales && Array.from({ length: outs.v.count }, (_, i) => outs.v!.scales![i * 2] === outs.v!.scales![i * 2 + 1]).every(Boolean)
  );
}

// ---- 2. placement vs the GL vertex shader -------------------------------------------------------------
// The GL node: pixel = c·res + R(rot + add)·S(sx·mul, sy·mul)·(q − A), with
// c = (x, ½ + (y − ½)·W/H) for instance px q (Y-down) and anchor A (px).
function glPixel(q: [number, number], p: { x: number; y: number; rot: number; sx: number; sy: number }, add: number, mul: number, A: [number, number], W: number, H: number): [number, number] {
  const cx = p.x * W;
  const cy = (0.5 + (p.y - 0.5) * (W / H)) * H;
  const lx = (q[0] - A[0]) * p.sx * mul;
  const ly = (q[1] - A[1]) * p.sy * mul;
  const r = p.rot + add;
  return [cx + Math.cos(r) * lx - Math.sin(r) * ly, cy + Math.sin(r) * lx + Math.cos(r) * ly];
}
const apply = (m: number[], q: [number, number]): [number, number] => [m[0] * q[0] + m[1] * q[1] + m[2], m[3] * q[0] + m[4] * q[1] + m[5]];
const mul3 = (a: number[], b: number[]) => {
  const o = new Array<number>(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return o;
};

// A drawing whose box we know: a filled circle at (cx, cy) r.
function circleDraw(cx: number, cy: number, r: number): SkiaDrawValue {
  return { kind: "skia_draw", node: { k: "shape", id: "inst", geom: { k: "circle", cx: { v: cx }, cy: { v: cy }, r: { v: r } }, paint: { style: "fill", color: { v: [1, 0, 0, 1] } } } };
}
function pointsOf(list: { x: number; y: number; rot: number; sx: number; sy: number }[]): PointsValue {
  const n = list.length;
  return {
    kind: "points",
    count: n,
    positions: Float32Array.from(list.flatMap((p) => [p.x, p.y])),
    rotations: Float32Array.from(list.map((p) => p.rot)),
    scales: Float32Array.from(list.flatMap((p) => [p.sx, p.sy])),
    points: [],
  } as PointsValue;
}
function runNode(params: Record<string, unknown>, points: PointsValue, inst: SkiaDrawValue, canvas = SQUARE): SkiaDrawValue {
  const ctx = dataOnlyContext(canvas, TL);
  const p = { ...defaults("skia-copy-to-points"), ...params };
  const out = skiaCopyToPointsNode.compute({ inputs: { points: coerceValue(points, "points", ctx), instance: coerceValue(inst, "skia_draw", ctx) }, params: p, ctx, nodeId: "cp" } as any) as { primary: SkiaDrawValue };
  return out.primary;
}

for (const canvas of [SQUARE, WIDE]) {
  const W = canvas.width;
  const H = canvas.height;
  const tag = `${W}×${H}`;
  // Fp32 positions, as every PointsValue stores them.
  const f32 = (v: number) => Math.fround(v);
  const list = [
    { x: f32(0.2), y: f32(0.3), rot: f32(0.4), sx: f32(1.5), sy: f32(1.5) },
    { x: f32(0.7), y: f32(0.62), rot: f32(-1.1), sx: f32(0.6), sy: f32(0.6) },
    { x: f32(0.45), y: f32(0.8), rot: f32(2.0), sx: f32(1), sy: f32(1) },
  ];
  const listNU = list.map((p, i) => ({ ...p, sy: f32(p.sy * (i === 0 ? 0.5 : 1)) }));
  const inst = circleDraw(W * 0.5, H * 0.5, W * 0.08);
  const add = 0.37;
  const mul = 0.9;
  const qs: [number, number][] = [
    [W * 0.5, H * 0.5],
    [W * 0.5 + W * 0.08, H * 0.5],
    [W * 0.42, H * 0.44],
  ];
  for (const anchor of ["canvas center", "custom"] as const) {
    const params = { mode: "image", anchor, anchor_x: 0.4, anchor_y: 0.55, rotate_add_default: add, scale_mul_default: mul };
    const A: [number, number] = anchor === "custom" ? [0.4 * W, 0.55 * H] : [W / 2, H / 2];
    // groups
    for (const [label, pts] of [["uniform", list], ["non-uniform", listNU]] as const) {
      const out = runNode({ ...params, strategy: "groups" }, pointsOf(pts), inst, canvas);
      const copies = (out.node as Extract<SkiaNode, { k: "group" }>).children as Extract<SkiaNode, { k: "group" }>[];
      let worst = 0;
      copies.forEach((outer, i) => {
        const inner = outer.children[0] as Extract<SkiaNode, { k: "group" }>;
        const m = mul3(transformMatrix(outer.transform)!, transformMatrix(inner.transform)!);
        for (const q of qs) {
          const a = apply(m, q);
          const b = glPixel(q, pts[i], add, mul, A, W, H);
          worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1]));
        }
      });
      check(`groups ${tag} ${anchor}, ${label} scale: every copy lands where the GL shader puts it (≤ 1e-9 px)`, copies.length === pts.length && worst <= 1e-9, `worst ${worst}`);
    }
    // atlas
    const out = runNode({ ...params, strategy: "atlas" }, pointsOf(list), inst, canvas);
    const at = out.node as Extract<SkiaNode, { k: "atlas" }>;
    const xf = composeAtlasXforms(at.xforms.v, { pivots: at.pivots!.v, rotate: at.rotate!.v, scale: at.scale!.v });
    const [x0, y0] = at.texture!.rect;
    let worst = 0;
    list.forEach((p, i) => {
      const [a, b, tx, ty] = xf.slice(i * 4, i * 4 + 4);
      for (const q of qs) {
        const u = q[0] - x0;
        const v = q[1] - y0;
        const got: [number, number] = [a * u - b * v + tx, b * u + a * v + ty];
        const want = glPixel(q, p, add, mul, A, W, H);
        worst = Math.max(worst, Math.hypot(got[0] - want[0], got[1] - want[1]));
      }
    });
    check(`atlas ${tag} ${anchor}: every sprite lands where the GL shader puts it (≤ 1e-9 px)`, at.k === "atlas" && worst <= 1e-9, `worst ${worst}`);
  }
}

// ---- 3. strategy, modes ---------------------------------------------------------------------------------
{
  const inst = circleDraw(128, 128, 20);
  const grid = (n: number) => pointsOf(Array.from({ length: n }, (_, i) => ({ x: (i % 10) / 10, y: Math.floor(i / 10) / 10, rot: 0, sx: 1, sy: 1 })));
  const kindOf = (v: SkiaDrawValue) => v.node.k;
  check(
    `auto: groups below ${ATLAS_AUTO_MIN} copies, an atlas from ${ATLAS_AUTO_MIN}`,
    kindOf(runNode({ mode: "image", strategy: "auto" }, grid(ATLAS_AUTO_MIN - 1), inst)) === "group" && kindOf(runNode({ mode: "image", strategy: "auto" }, grid(ATLAS_AUTO_MIN), inst)) === "atlas"
  );
  const nu = pointsOf([{ x: 0.5, y: 0.5, rot: 0, sx: 1, sy: 2 }, ...Array.from({ length: 30 }, () => ({ x: 0.3, y: 0.3, rot: 0, sx: 1, sy: 1 }))]);
  check("atlas needs uniform per-point scale: non-uniform draws groups, even when forced", kindOf(runNode({ mode: "image", strategy: "atlas" }, nu, inst)) === "group" && kindOf(runNode({ mode: "image", strategy: "auto" }, nu, inst)) === "group");
  check("strategy groups stays groups at any count", kindOf(runNode({ mode: "image", strategy: "groups" }, grid(64), inst)) === "group");
  const empty = runNode({ mode: "image" }, pointsOf([]), inst);
  check("no points → an empty group (nothing draws)", empty.node.k === "group" && empty.node.children.length === 0);
  // Spline / point modes: the GL node's own output.
  const ctx = dataOnlyContext(SQUARE, TL);
  const pts = pointsOf([{ x: 0.3, y: 0.4, rot: 0.5, sx: 1.2, sy: 0.8 }, { x: 0.6, y: 0.6, rot: -0.2, sx: 1, sy: 1 }]);
  const spline = { kind: "spline", subpaths: [{ closed: true, anchors: [{ pos: [0.45, 0.45] }, { pos: [0.55, 0.45] }, { pos: [0.5, 0.55] }] }] } as any;
  const instPts = pointsOf([{ x: 0.5, y: 0.5, rot: 0, sx: 1, sy: 1 }, { x: 0.52, y: 0.5, rot: 0.1, sx: 1, sy: 1 }]);
  for (const [mode, instance, type] of [
    ["spline", spline, "spline"],
    ["point", instPts, "points"],
  ] as const) {
    const params = { ...defaults("skia-copy-to-points"), mode, anchor: "content center", draw_order: "by y", output_tag: "copy index", rotate_add_default: 0.2, scale_mul_default: 1.1 };
    const inputs = { points: coerceValue(pts, "points", ctx), instance: coerceValue(instance, type, ctx) };
    const a = (skiaCopyToPointsNode.compute({ inputs, params, ctx, nodeId: "cp" } as any) as any).primary;
    const b = (copyToPointsNode.compute({ inputs, params: { ...defaults("copy-to-points"), ...params }, ctx, nodeId: "gl" } as any) as any).primary;
    const strip = (v: any) => JSON.stringify(v, (_k, x) => (x instanceof Float32Array || x instanceof Int32Array ? Array.from(x) : x));
    check(`${mode} mode is Copy to Points' own ${type} output (same inputs through coerceValue)`, a?.kind === b?.kind && strip(a) === strip(b));
  }
}

// ---- 4. bounds and anchors ------------------------------------------------------------------------------------
{
  const b = svgPathBox("M 0 0 C 0 -10, 10 -10, 10 0 Z");
  check("svgPathBox: a cubic's box is its extrema (y to −7.5), not its control points (−10)", !!b && Math.abs(b[1] + 7.5) < 1e-9 && b[0] === 0 && b[2] === 10 && b[3] === 0, JSON.stringify(b));
  const stroke = sceneBounds({ k: "shape", geom: { k: "rect", x: { v: 10 }, y: { v: 20 }, w: { v: 30 }, h: { v: 40 } }, paint: { style: "stroke", strokeWidth: { v: 4 }, strokeJoin: "round" } });
  check("sceneBounds: a round-joined stroke grows the box by half its width", same(stroke.box, [8, 18, 42, 62]) && !stroke.unbounded, JSON.stringify(stroke));
  const grp = sceneBounds({
    k: "group",
    transform: { translate: [{ v: 100 }, { v: 0 }], scale: [{ v: 2 }, { v: 2 }] },
    clip: { geom: { k: "rect", x: { v: 0 }, y: { v: 0 }, w: { v: 15 }, h: { v: 100 } } },
    children: [{ k: "shape", geom: { k: "circle", cx: { v: 10 }, cy: { v: 10 }, r: { v: 10 } }, paint: { style: "fill" } }],
  });
  check("…through a group transform, cut by its clip", same(grp.box, [100, 0, 130, 40]), JSON.stringify(grp.box));
  const fill = sceneBounds({ k: "group", children: [{ k: "fill", paint: { style: "fill" } }] });
  const text = sceneBounds({ k: "text", text: { v: "hi" }, font: { asset: "f", size: { v: 12 } }, x: { v: 0 }, y: { v: 0 }, paint: { style: "fill" } });
  check("…a fill and text are unbounded (callers use the canvas)", fill.unbounded && text.unbounded && fill.why[0].startsWith("a fill"));

  // glContentCenter vs the GL node's readback, emulated on a raster: 128-px
  // taps (bilinear at each texel centre, 8-bit), alpha bbox, one-texel pad.
  const W = 512;
  const emulate = (node: SkiaNode): [number, number] => {
    const r = render({ version: 1, width: W, height: W, root: node, assets: {} });
    const n = 128;
    const at = (x: number, y: number) => r.px[(Math.min(W - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 4 + 3] / 255;
    let t0 = n;
    let t1 = -1;
    let u0 = n;
    let u1 = -1;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const sx = ((i + 0.5) * W) / n - 0.5;
        const sy = ((j + 0.5) * W) / n - 0.5;
        const ax = Math.floor(sx);
        const ay = Math.floor(sy);
        const fx0 = sx - ax;
        const fy0 = sy - ay;
        const v = at(ax, ay) * (1 - fx0) * (1 - fy0) + at(ax + 1, ay) * fx0 * (1 - fy0) + at(ax, ay + 1) * (1 - fx0) * fy0 + at(ax + 1, ay + 1) * fx0 * fy0;
        if (Math.round(v * 255) > 0) {
          t0 = Math.min(t0, i);
          t1 = Math.max(t1, i);
          u0 = Math.min(u0, j);
          u1 = Math.max(u1, j);
        }
      }
    }
    const m0 = Math.max(0, t0 - 1);
    const m1 = Math.min(n - 1, t1 + 1);
    const k0 = Math.max(0, u0 - 1);
    const k1 = Math.min(n - 1, u1 + 1);
    return [((m0 + (m1 - m0 + 1) / 2) / n) * W, ((k0 + (k1 - k0 + 1) / 2) / n) * W];
  };
  const fillP = { style: "fill" as const, color: { v: [1, 1, 1, 1] as [number, number, number, number] } };
  const cases: [string, SkiaNode, boolean][] = [
    ["a centred circle", { k: "shape", geom: { k: "circle", cx: { v: 256 }, cy: { v: 256 }, r: { v: 40 } }, paint: fillP }, true],
    ["an off-centre circle", { k: "shape", geom: { k: "circle", cx: { v: 181.3 }, cy: { v: 300.7 }, r: { v: 33.2 } }, paint: fillP }, true],
    ["a stroked rect", { k: "shape", geom: { k: "rect", x: { v: 97.4 }, y: { v: 141.2 }, w: { v: 120.5 }, h: { v: 61.3 } }, paint: { ...fillP, style: "stroke", strokeWidth: { v: 5 }, strokeJoin: "round" } }, true],
    ["a cubic blob", { k: "shape", geom: { k: "path", d: { v: "M 200 180 C 260 150, 330 210, 310 260 C 290 320, 210 330, 190 280 C 175 240, 170 200, 200 180 Z" } }, paint: fillP }, true],
  ];
  // The fixture's star: narrow tips — the readback can miss a tip's pixels.
  const g = fx.atlasGraph({});
  const star = sceneOf(closure(g, "inst_skc"), "inst_skc", { width: W, height: W });
  cases.push(["the fixture's star (tips)", star.root, false]);
  for (const [what, node, hold] of cases) {
    const b = sceneBounds(node).box!;
    const got = glContentCenter(b, W, W);
    const want = emulate(node);
    const d = Math.hypot(got[0] - want[0], got[1] - want[1]);
    if (hold) check(`content center ≡ the GL node's (emulated readback) for ${what}`, d === 0, `model ${got} vs GL ${want}`);
    else console.log(`     (${what}: model ${got.map((v) => v.toFixed(1))} vs GL readback ${want.map((v) => v.toFixed(1))} — ${d.toFixed(1)} px: a ${W / 128}-px readback texel misses the tip's pixels)`);
  }
}

// ---- 5. pixels --------------------------------------------------------------------------------------------------
{
  // A crisp instance: a filled rect + a stroked circle, copied at integer
  // offsets, scale 1, no rotation: the sheet samples at texel centres, so
  // the atlas copies are the groups' copies pixel for pixel.
  const inst: SkiaDrawValue = {
    kind: "skia_draw",
    node: {
      k: "group",
      id: "inst",
      children: [
        { k: "shape", geom: { k: "rect", x: { v: 118 }, y: { v: 120 }, w: { v: 20 }, h: { v: 14 } }, paint: { style: "fill", color: { v: [0.2, 0.5, 1, 1] } } },
        { k: "shape", geom: { k: "circle", cx: { v: 128 }, cy: { v: 128 }, r: { v: 9.5 } }, paint: { style: "stroke", strokeWidth: { v: 3 }, color: { v: [1, 0.7, 0.1, 0.8] } } },
      ],
    },
  };
  const at = (x: number, y: number) => ({ x: x / 256, y: y / 256, rot: 0, sx: 1, sy: 1 });
  const pts = pointsOf([at(40, 40), at(100, 60), at(200, 180), at(64, 210)]);
  const scene = (v: SkiaDrawValue): SkiaScene => ({ version: 1, width: 256, height: 256, root: v.node, assets: {} });
  const g = render(scene(runNode({ mode: "image", anchor: "canvas center", strategy: "groups" }, pts, inst)));
  const a = render(scene(runNode({ mode: "image", anchor: "canvas center", strategy: "atlas" }, pts, inst)));
  check("atlas ≡ groups at integer offsets, scale 1 (the sheet samples at texel centres; ≤ 2/255 premultiplied, 8-bit rounding)", maxDiff(a.px, g.px) <= 2 && !a.problems.length && !g.problems.length, `max ${maxDiff(a.px, g.px).toFixed(2)} ${a.problems}`);
  // Rotated / scaled: same ink, same place; edges resample.
  const ptsR = pointsOf([{ x: 0.3, y: 0.3, rot: 0.7, sx: 1.6, sy: 1.6 }, { x: 0.7, y: 0.65, rot: -0.4, sx: 0.7, sy: 0.7 }]);
  const gR = render(scene(runNode({ mode: "image", anchor: "canvas center", strategy: "groups", rotate_add_default: 0.2 }, ptsR, inst)));
  const aR = render(scene(runNode({ mode: "image", anchor: "canvas center", strategy: "atlas", rotate_add_default: 0.2 }, ptsR, inst)));
  const ig = ink(gR.px, 256);
  const ia = ink(aR.px, 256);
  check(
    "rotated / scaled copies: atlas and groups agree in ink mass (≤ 1 %) and centroid (≤ 0.05 px)",
    Math.abs(ia.mass / ig.mass - 1) <= 0.01 && Math.hypot(ia.cx - ig.cx, ia.cy - ig.cy) <= 0.05,
    `mass ${ia.mass.toFixed(1)} vs ${ig.mass.toFixed(1)}, centroid Δ ${Math.hypot(ia.cx - ig.cx, ia.cy - ig.cy).toFixed(3)}`
  );
  // k = 2: the sheet rasterises at the surface's density — crisp, so the
  // atlas at 2× matches groups at 2× as at 1×.
  const g2 = render(scene(runNode({ mode: "image", anchor: "canvas center", strategy: "groups" }, pts, inst)), { k: 2 });
  const a2 = render(scene(runNode({ mode: "image", anchor: "canvas center", strategy: "atlas" }, pts, inst)), { k: 2 });
  check("at a 2× surface the sheet rasterises at 2× (atlas ≡ groups, not an upscaled 1× sheet)", maxDiff(a2.px, g2.px) <= 2, `max ${maxDiff(a2.px, g2.px).toFixed(2)}`);
  // The texture cache: a sheet renders once, the frame is the same.
  const cache = new Map<string, Image>();
  const sc = scene(runNode({ mode: "image", anchor: "canvas center", strategy: "atlas" }, pts, inst));
  const c1 = render(sc, { cache });
  const c2 = render(sc, { cache });
  check("textureCache: one sheet across frames, identical pixels", cache.size === 1 && maxDiff(c1.px, a.px) === 0 && maxDiff(c2.px, a.px) === 0, `cache ${cache.size}`);
  for (const img of cache.values()) img.delete();
  // composeAtlasXforms ≡ matrices.
  const xs = [1.2, 0.3, 50, 60, -0.5, 0.8, 10, 20];
  const pv = [70, 80, 15, 25];
  const out = composeAtlasXforms(xs, { pivots: pv, rotate: 0.6, scale: 1.3, k: 2 });
  let worst = 0;
  for (let i = 0; i < 2; i++) {
    const [s, c, tx, ty] = xs.slice(i * 4, i * 4 + 4);
    const M = [s, -c, tx, c, s, ty, 0, 0, 1];
    const mod = mul3(mul3([1, 0, pv[i * 2], 0, 1, pv[i * 2 + 1], 0, 0, 1], [Math.cos(0.6) * 1.3, -Math.sin(0.6) * 1.3, 0, Math.sin(0.6) * 1.3, Math.cos(0.6) * 1.3, 0, 0, 0, 1]), [1, 0, -pv[i * 2], 0, 1, -pv[i * 2 + 1], 0, 0, 1]);
    const want = mul3(mod, M);
    // Texture px u' = 2u: scos'·u' = scos·u.
    const got = [out[i * 4] * 2, -out[i * 4 + 1] * 2, out[i * 4 + 2], out[i * 4 + 1] * 2, out[i * 4] * 2, out[i * 4 + 3]];
    for (const [j, w] of [want[0], want[1], want[2], want[3], want[4], want[5]].entries()) worst = Math.max(worst, Math.abs(got[j] - w));
  }
  check("composeAtlasXforms = T(p)·R·S·T(−p)·xform, scales ÷ k", worst < 1e-12, `${worst}`);
}

// ---- 6. export ------------------------------------------------------------------------------------------------------
const graph = fx.atlasGraph();
function exportOf(canvasId: string, g = graph, canvas = SQUARE, name = canvasId) {
  const sub = closure(g, canvasId);
  return { sub, r: exportSkia({ nodes: sub.nodes, edges: sub.edges, targetId: canvasId, name, canvas, timeline: TL, runtimeSource }) };
}
const kinds = (r: ReturnType<typeof exportSkia>) => {
  const m = r.files ? JSON.parse(r.files["manifest.json"]) : null;
  return { m, by: (re: RegExp) => (m?.binds ?? []).filter((b: any) => re.test(b.path)).map((b: any) => b.kind) as string[] };
};
{
  // atlas grid: keyframed Rotate + / Scale × over a static grid.
  const { r } = exportOf("ska_grid_skc");
  const { m, by } = kinds(r);
  check("atlas, keyframed Scale × / Rotate +: exports clean", !!r.files && !r.problems.length && !r.warnings.length, [...r.problems, ...r.warnings].join(" | "));
  check(
    "…rotate and scale are TRACKS; xforms and pivots static (not N×4 floats per frame)",
    same(by(/\.rotate$/), ["track"]) && same(by(/\.scale$/), ["track"]) && !(m?.binds ?? []).some((b: any) => /xforms|pivots/.test(b.path)) && m.bindCounts.sampled === undefined,
    JSON.stringify(m?.bindCounts)
  );
  // groups grid: the outer copy groups' rotate / scale are tracks.
  const gr = exportOf("skg_grid_skc").r;
  const gk = kinds(gr);
  check(
    "groups, keyframed Scale × / Rotate +: every copy's outer rotate / scale is a TRACK, nothing sampled",
    !!gr.files && !gr.problems.length && gk.by(/children\.\d+\.transform\.rotate$/).length === 25 && gk.by(/children\.\d+\.transform\.rotate$/).every((k) => k === "track") && gk.m.bindCounts.sampled === undefined,
    JSON.stringify(gk.m?.bindCounts)
  );
  check("…and the one instance is emitted once (a shared element), not 25 times", (gr.files?.["ToolboxScene.tsx"].match(/drawn 25×/g) ?? []).length === 1);
  // A moving point: sampled xforms / translate.
  const ap = kinds(exportOf("ska_pt_skc").r);
  check("atlas on a moving point: xforms + pivots SAMPLED", same(ap.by(/\.xforms$/), ["sampled"]) && same(ap.by(/\.pivots$/), ["sampled"]), JSON.stringify(ap.m?.binds?.map((b: any) => `${b.path}:${b.kind}`)));
  const gp = kinds(exportOf("skg_pt_skc").r);
  check("groups on a moving point: the copy's translate x SAMPLED, the rest static", same(gp.by(/\.translate\.0$/), ["sampled"]) && gp.m.bindCounts.sampled === 1, JSON.stringify(gp.m?.bindCounts));
  // An animated instance: refused under an atlas, fine under groups.
  const anim = structuredClone(graph);
  anim.nodes.find((n) => n.id === "star_f")!.animation = { color: { animated: true, trackVisible: true, keyframes: [{ tick: 0, value: "#3d7cff", easingOut: "linear" }, { tick: 60_000, value: "#ff3d7c", easingOut: "linear" }] } };
  const ra = exportOf("ska_vor_skc", anim).r;
  check("an animated instance under an atlas is refused, naming the strategy fix", !ra.files && ra.problems.some((p) => /sprite sheet/.test(p) && /strategy to groups/.test(p)), ra.problems.join(" | "));
  const rg = exportOf("skg_vor_skc", anim).r;
  check("…and exports under groups (the instance's color is a track)", !!rg.files && !rg.problems.length && kinds(rg).m.bindCounts.track >= 1, rg.problems.join(" | "));
}

{
  // The harness export (combo): replay the emitted timeline and RSXform
  // worklet against the preview's xforms at every frame.
  // (Named as export-skia.mts --fixture atlas names it, for the slot check.)
  const { sub, r } = exportOf("combo_skc", graph, { width: fx.ATLAS_SIZE, height: fx.ATLAS_SIZE }, "Copy to Points (Skia)");
  check("combo (atlas static + atlas tracks + groups sampled) exports clean", !!r.files && !r.problems.length, r.problems.join(" | "));
  const tsx = r.files?.["ToolboxScene.tsx"] ?? "";
  check("…one useTexture for the two atlases of one drawing", (tsx.match(/useTexture\(/g) ?? []).length === 1, `${(tsx.match(/useTexture\(/g) ?? []).length}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skia-atlas-"));
  try {
    for (const [f, text] of Object.entries(r.files ?? {})) if (!f.includes("/")) fs.writeFileSync(path.join(tmp, f), text);
    const emitted = await import(pathToFileURL(path.join(tmp, "timeline.ts")).href);
    // The buffer worklet (the modifier body) and its inputs, from the TSX.
    const hook = /const (XF\d+) = useRSXformBuffer\((\d+), \(xf, i\) => \{\n\s+"worklet";\n([\s\S]*?)\n\s+\}\);/.exec(tsx);
    const consts = new Map<string, unknown>();
    for (const m of tsx.matchAll(/^const (X[AP]\d+) = (\[[^\n]*\]);$/gm)) consts.set(m[1], JSON.parse(m[2]));
    const mod = /const (XM\d+) = useDerivedValue\(\(\) => (\[[^\n]*\])\);/.exec(tsx);
    check("…the atlas with tracks fills a useRSXformBuffer whose spin / zoom is one derived value", !!hook && !!mod);
    if (hook && mod) {
      const n = Number(hook[2]);
      const names = [...consts.keys()];
      const body = hook[3];
      // The modifier as the worklet runs it: its closure (B, AK, the spin /
      // zoom derived value, the static xform / pivot data) as parameters.
      const modifier = new Function("xf", "i", "B", "AK", mod[1], ...names, body) as (...a: unknown[]) => void;
      const derive = new Function("B", `return ${mod[2]};`) as (B: unknown) => number[];
      const sampler = makeSceneSampler(sub.nodes, sub.edges, "combo_skc", { width: fx.ATLAS_SIZE, height: fx.ATLAS_SIZE }, TL);
      let bad = "";
      for (let f = 0; f < FRAMES && !bad && !("problem" in sampler); f++) {
        const B = { value: emitted.sampleBinds(f / TL.fps) };
        const M = { value: derive(B) };
        const got: number[] = [];
        for (let i = 0; i < n; i++) {
          const xf = { set: (...v: number[]) => got.push(...v) };
          modifier(xf, i, B, 1, M, ...names.map((k) => consts.get(k)));
        }
        const sc = sampler.sampleAt(f * TL.ticksPerFrame)!;
        const atlas = (sc.root as Extract<SkiaNode, { k: "group" }>).children[1] as Extract<SkiaNode, { k: "atlas" }>;
        const want = composeAtlasXforms(atlas.xforms.v, { pivots: atlas.pivots!.v, rotate: atlas.rotate!.v, scale: atlas.scale!.v });
        if (!same(got, want)) bad = `frame ${f}: ${got.slice(0, 4)} vs ${want.slice(0, 4)}`;
      }
      check(`…the emitted worklet on the emitted timeline ≡ the preview's xforms, bit for bit, all ${FRAMES} frames × ${n} sprites`, !bad, bad);
    }
    // Worklet capture order (TDZ): a worklet may only call worklets above it.
    const order = (src: string): string[] => {
      const decl = /^(?:export )?(?:function (\w+)\(|const (\w+) = (?:\([^)]*\)(?:: [\w[\]<>]+)? =>|function))/gm;
      const found: { name: string; at: number }[] = [];
      for (let m = decl.exec(src); m; m = decl.exec(src)) found.push({ name: m[1] ?? m[2], at: m.index });
      const errs: string[] = [];
      found.forEach((d, i) => {
        const b = src.slice(d.at, found[i + 1]?.at ?? src.length);
        if (!/^\s*"worklet";/m.test(b.split("\n").slice(1, 3).join("\n"))) return;
        for (const later of found.slice(i + 1)) if (new RegExp(`\\b${later.name}\\(`).test(b)) errs.push(`${d.name} calls ${later.name}, declared below it`);
      });
      return errs;
    };
    const errs = ["ToolboxScene.tsx", "timeline.ts"].flatMap((f) => order(r.files?.[f] ?? "").map((e) => `${f}: ${e}`));
    check("worklets in the emitted modules call only functions declared above them", !errs.length, errs.join("; "));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // The harness slot is today's export.
  const slot = path.join(ROOT, "skia-harness", "src", "bundle-atlas");
  const stale = Object.entries(r.files ?? {}).filter(([f, text]) => !f.endsWith(".b64") && (!fs.existsSync(path.join(slot, f)) || !sameUpToFloatNoise(fs.readFileSync(path.join(slot, f), "utf8"), text))).map(([f]) => f);
  check("skia-harness/src/bundle-atlas is today's export", !stale.length, `${stale.join(", ")} differ — npx tsx scripts/export-skia.mts --fixture atlas --out skia-harness/src/bundle-atlas`);
  // checkExportable: programs compile, the bundle type-checks.
  const ce = await checkExportable({ nodes: sub.nodes, edges: sub.edges, canvasId: "combo_skc", canvas: { width: fx.ATLAS_SIZE, height: fx.ATLAS_SIZE }, timeline: TL, typecheck: true, slot: "atlas" });
  check("checkExportable: no problems", !ce.problems.length, ce.problems.join(" | "));
  check(
    `the bundle type-checks in skia-harness (react-native-skia 3.4.0 useTexture / Atlas / useRSXformBuffer)${ce.typecheck.ran ? "" : " — skipped"}`,
    ce.typecheck.ok,
    ce.typecheck.output
  );
}

// ---- 7. the GL node's image mode: straight alpha in and out (stub GL) -----------------------------------------
// Until 2026-10-16 Copy to Points' image mode bilinear-filtered the straight
// instance texture and blended it (SRC_ALPHA, ONE_MINUS_SRC_ALPHA) straight
// into its output, which stored rgb·a as straight rgb: every anti-aliased
// edge came out dark (an identity copy's AA edges at 0.50× the instance's
// rgb). Now the taps are premultiplied before filtering, the copies
// accumulate premultiplied in a scratch texture, and one pass divides the
// alpha back out. The pixels need a GPU — compare:skia `--a atlas:gl_id --b
// atlas:inst_skc` (an identity copy ≡ its instance, max 0/255) and `--a
// atlas:gl_gridc --b atlas:ska_gridc_skc` (MATCH without --premul-a). Here a
// GL that records its calls pins the pipeline.
{
  const { COPY_INST_FS, COPY_UNPREMUL_FS } = await import("@/nodes/effect/copy-to-points");
  const taps = COPY_INST_FS.match(/texelFetch\(u_src\b/g) ?? [];
  const premuls = [...COPY_INST_FS.matchAll(/(\w+)\.rgb \*= \1\.a;/g)];
  const firstMix = COPY_INST_FS.indexOf("mix(");
  const hw = [...COPY_INST_FS.matchAll(/texture\(u_src\b/g)];
  const fastGuard = COPY_INST_FS.lastIndexOf(">= 1.0", hw[0]?.index ?? -1);
  check(
    "instance FS: four texelFetch taps, each premultiplied before the bilinear mix; the hardware sample only where all four are opaque",
    taps.length === 4 && premuls.length === 4 && premuls.every((m) => m.index! < firstMix) && hw.length === 1 && fastGuard > COPY_INST_FS.lastIndexOf("texelFetch", hw[0].index!),
    `taps ${taps.length}, premultiplied ${premuls.length}, texture() ${hw.length}`
  );
  check("…and emits premultiplied colour (opacity scales all four channels)", /outColor = \w+ \* v_opacity;/.test(COPY_INST_FS) && !/outColor\.a \*=/.test(COPY_INST_FS));
  check("unpremultiply FS: texel for texel, rgb ÷ a, 0 where nothing landed", /texelFetch\(u_acc, ivec2\(gl_FragCoord\.xy\), 0\)/.test(COPY_UNPREMUL_FS) && /\.rgb \/ \w+\.a/.test(COPY_UNPREMUL_FS));

  type Call = { fn: string; args: unknown[] };
  const run = (instance: ImageValue | ImageGroupValue, pts: PointsValue) => {
    const calls: Call[] = [];
    let id = 0;
    const handle = (tag: string) => ({ tag, id: id++ });
    // Enums read as their own names, every method records and returns a handle.
    const gl = new Proxy({} as WebGL2RenderingContext, {
      get: (_t, prop) =>
        typeof prop === "string" && /^[A-Z0-9_]+$/.test(prop)
          ? prop
          : (...args: unknown[]) => {
              calls.push({ fn: String(prop), args });
              if (String(prop).startsWith("create")) return handle(String(prop).slice(6));
              if (prop === "getShaderParameter" || prop === "getProgramParameter") return true;
              if (prop === "getUniformLocation") return handle(`u:${String(args[1])}`);
              return undefined;
            },
    });
    const sources = new Map<unknown, string>();
    const ctx = {
      ...dataOnlyContext({ width: 64, height: 64 }, TL),
      gl,
      allocImage: (o?: { width?: number; height?: number }): ImageValue => {
        const v = { kind: "image", texture: handle("pool") as unknown as WebGLTexture, width: o?.width ?? 64, height: o?.height ?? 64 } as ImageValue;
        calls.push({ fn: "allocImage", args: [v.texture] });
        return v;
      },
      releaseTexture: (t: unknown) => calls.push({ fn: "releaseTexture", args: [t] }),
      getShader: (key: string, src: string) => {
        const p = handle(`prog:${key}`);
        sources.set(p, src);
        return p as unknown as WebGLProgram;
      },
      clearTarget: (t: unknown) => calls.push({ fn: "clearTarget", args: [t] }),
      drawFullscreen: (p: unknown, target: unknown, setup?: (g: WebGL2RenderingContext) => void) => {
        calls.push({ fn: "drawFullscreen", args: [p, target] });
        setup?.(gl);
        calls.push({ fn: "drawFullscreen:end", args: [] });
      },
      readImagePixels: () => null,
    } as unknown as RenderContext;
    const params = { ...defaults("copy-to-points"), mode: "image", pick_mode: "all", anchor: "canvas center" };
    const out = copyToPointsNode.compute({ inputs: { points: pts, instance }, params, ctx, nodeId: "gl" } as any) as { primary: ImageValue };
    return { calls, sources, output: out.primary };
  };
  const tex = (n: string) => ({ tag: n }) as unknown as WebGLTexture;
  const pts = pointsOf([{ x: 0.3, y: 0.4, rot: 0.5, sx: 1.2, sy: 1.2 }, { x: 0.6, y: 0.55, rot: 0, sx: 1, sy: 1 }]);
  const cases: [string, ImageValue | ImageGroupValue, number][] = [
    ["an image", { kind: "image", texture: tex("inst"), width: 64, height: 64 }, 1],
    ["an image group (pick all: one draw per item)", { kind: "image_group", items: [{ kind: "image", texture: tex("a"), width: 64, height: 64 }, { kind: "image", texture: tex("b"), width: 32, height: 48 }] } as ImageGroupValue, 2],
  ];
  for (const [what, instance, items] of cases) {
    const { calls, sources, output } = run(instance, pts);
    const at = (fn: string) => calls.flatMap((c, i) => (c.fn === fn ? [i] : []));
    const draws = at("drawArraysInstanced");
    const lastBefore = (i: number, fns: string[], arg0?: unknown) => {
      for (let j = i - 1; j >= 0; j--) if (fns.includes(calls[j].fn) && (arg0 === undefined || calls[j].args[0] === arg0)) return calls[j];
      return undefined;
    };
    const targets = new Set(draws.map((i) => lastBefore(i, ["framebufferTexture2D"])?.args[3]));
    const accum = [...targets][0];
    const allocated = calls.filter((c) => c.fn === "allocImage").map((c) => c.args[0]);
    const blendOk = draws.every((i) => {
      const f = lastBefore(i, ["blendFuncSeparate", "blendFunc"]);
      return same(f?.args, ["ONE", "ONE_MINUS_SRC_ALPHA", "ONE", "ONE_MINUS_SRC_ALPHA"]) && lastBefore(i, ["enable", "disable"], "BLEND")?.fn === "enable";
    });
    const passes = at("drawFullscreen");
    const pass = passes.length === 1 ? calls[passes[0]] : undefined;
    const end = at("drawFullscreen:end")[0];
    const bound = calls.slice(passes[0], end).some((c) => c.fn === "bindTexture" && c.args[1] === accum);
    const released = calls.filter((c) => c.fn === "releaseTexture").map((c) => c.args[0]);
    check(
      `GL image mode, ${what}: ${items} instanced draw(s) into one scratch texture (not the output), premultiplied source-over (ONE, ONE_MINUS_SRC_ALPHA)`,
      draws.length === items && targets.size === 1 && accum !== output.texture && allocated.includes(accum) && blendOk,
      JSON.stringify({ draws: draws.length, targets: targets.size, blends: draws.map((i) => lastBefore(i, ["blendFuncSeparate", "blendFunc"])?.args) })
    );
    check(
      "…then one unpremultiply pass reads the scratch into the output and the scratch goes back to the pool",
      !!pass && sources.get(pass.args[0]) === COPY_UNPREMUL_FS && pass.args[1] === output && passes[0] > draws[draws.length - 1] && bound && same(released, [accum]),
      JSON.stringify({ passes: passes.length, bound, released: released.length })
    );
  }
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
