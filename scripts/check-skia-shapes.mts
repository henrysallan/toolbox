// check-skia-shapes: the vector-shapes family of the Skia target
// (specdocs/101326_skia-target.md §7 Wave 2, family 7). No GPU, no device:
//
//   1. defs: Circle / Rectangle / Line (Skia) are native Skia nodes that
//      mirror circle / rectangle / line with the SAME ParamDef objects; the
//      twelve spline generators are native Skia too (offered in a Skia
//      layer, feeding Skia Shape);
//   2. the primitives bind DIRECTLY: every geometry value is one param ×
//      a constant (BindRef.scale = the canvas width, −W, 2W, −W/2, π/180),
//      and a non-square canvas's y shift is a static outer group — no
//      derived binds, at 256² and at 320×180;
//   3. export, per node, keyframed and static, through exportSkia /
//      checkExportable (scripts/skia/export-check.ts) on the shared fixture
//      (scripts/fixtures/skia/shapes-graph.ts): no problems, no warnings;
//      primitives' keyframed params → TRACKS (never sampled), the rest
//      static; generators' paths → SAMPLED (upstream provenance, no
//      warning) when keyframed, static when not; driver-wired params too;
//   4. one canvas holding every drawing exports, its emitted timeline
//      replays the producer's bound values at every frame, and the bundle
//      type-checks in skia-harness (react-native-skia 3.4.0, Reanimated 4.7);
//   5. pixels (CanvasKit, CPU): the rendered scene puts fill / stroke /
//      nothing at interior points computed from the params at that frame —
//      centers, radii, rotated rect sides and corner radius, line ends and
//      round caps, every generator anchor under its stroke — at 256² and
//      320×180 (where y = y·W + (H − W)/2);
//   6. edges of the contract: a generator with its bundled raster on still
//      evaluates in the data-only sampler (spline-raster-aux's no-GL guard),
//      an upstream compute that throws refuses the export instead of
//      shipping an empty path, and a radius key that overshoots below 0
//      clamps like the mirror and is sampled with a warning.
//
//   npx tsx scripts/check-skia-shapes.mts

/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CanvasKit } from "canvaskit-wasm";
import type { EvalCache, GraphEdge, GraphNode } from "@/engine/evaluator";
import type { BindRef, SkiaNode, SkiaScene } from "@/engine/skia/scene-ir";
import type { NodeDefinition, SplineValue } from "@/engine/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { getNodeDef, registerNode } = await import("@/engine/registry");
const { evaluateGraph } = await import("@/engine/evaluator");
const { evaluateKeyframesAt } = await import("@/engine/keyframes");
const { aspectCorrectY } = await import("@/engine/aspect");
const { isOfferedInSkiaLayer } = await import("@/engine/skia/layer-target");
const { renderScene } = await import("@/engine/skia/scene-render");
const { exportSkia, exportSkiaScene, makeSceneSampler } = await import("@/lib/skia-export");
const { collectBinds, closeValue } = await import("@/lib/skia-export/scene-plan");
const { dataOnlyContext } = await import("@/lib/skia-export/scene-sample");
const { checkExportable } = await import("./skia/export-check.ts");
const fx = await import("./fixtures/skia/shapes-graph.ts");

const require = createRequire(path.join(ROOT, "package.json"));
const CK: CanvasKit = await require("canvaskit-wasm")();

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${!cond && detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
const same = (a: unknown, b: unknown) =>
  Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => Object.is(x, b[i])) : Object.is(a, b);

const TL = fx.SHAPES_EXPORT_TIMELINE;
const FRAMES = TL.sceneDurationTicks / TL.ticksPerFrame + 1;
const runtimeSource = fs.readFileSync(path.join(ROOT, "src/lib/skia-export/runtime/toolbox-timeline.ts"), "utf8");
const SQUARE = { width: 256, height: 256 };
const WIDE = { width: 320, height: 180 };
const PRIMS = { "skia-circle": "circle", "skia-rect": "rectangle", "skia-line": "line" } as const;
const GENERATORS = ["polygon", "star", "arc", "wave", "spiral", "cross", "arrow", "spline-draw", "svg-source", "circle", "rectangle", "line"];

// The subgraph a canvas draws (its upstream closure).
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

// exportSkia's skia-canvas branch, keeping the per-bind plans.
function exportOf(g: { nodes: GraphNode[]; edges: GraphEdge[] }, canvasId: string, canvas = SQUARE) {
  const sampler = makeSceneSampler(g.nodes, g.edges, canvasId, canvas, TL);
  if ("problem" in sampler) return { problems: [sampler.problem], warnings: [] as string[], binds: [], files: null, scene0: null, sampler: null };
  const scene0 = sampler.sampleAt(0);
  if (!scene0) return { problems: [sampler.lastProblem() ?? "nothing"], warnings: [] as string[], binds: [], files: null, scene0: null, sampler };
  const r = exportSkiaScene(scene0, g.nodes, g.edges, { name: canvasId, timeline: TL, runtimeSource, sampleAt: (t) => sampler.sampleAt(t) });
  const producer = sampler.producerProblems();
  return { problems: [...producer, ...r.problems], warnings: r.warnings, binds: r.binds, files: producer.length ? null : r.files, scene0, sampler };
}

const refsOf = (root: SkiaNode) => collectBinds(root).filter((fb) => fb.bind.ref).map((fb) => ({ path: fb.path, ref: fb.bind.ref as BindRef, v: fb.bind.v }));

// ---- 1. defs ----------------------------------------------------------------------------------
for (const [type, mirror] of Object.entries(PRIMS)) {
  const def = getNodeDef(type);
  const m = getNodeDef(mirror)!;
  check(
    `${type}: native Skia def mirroring ${mirror}, skia_draw out, offered in a Skia layer`,
    !!def && def.skia?.class === "native" && def.skia.mirrors === mirror && def.primaryOutput === "skia_draw" && isOfferedInSkiaLayer(def)
  );
  check(
    `${type}: every param is ${mirror}'s own ParamDef (same object, so the port can't drift)`,
    !!def && def.params.length > 0 && def.params.every((p) => m.params.includes(p)),
    def?.params.filter((p) => !m.params.includes(p)).map((p) => p.name).join(", ")
  );
}
{
  const bad = GENERATORS.filter((t) => getNodeDef(t)?.skia?.class !== "native" || !isOfferedInSkiaLayer(getNodeDef(t)));
  check(`the ${GENERATORS.length} spline generators are native Skia (offered in a Skia layer, feed Skia Shape)`, bad.length === 0, bad.join(", "));
  check("Skia Shape takes a generator's spline (its input is a spline)", getNodeDef("skia-shape")!.inputs.some((i) => i.name === "spline" && i.type === "spline"));
}

// ---- 2. direct binds -------------------------------------------------------------------------
const graph = fx.shapesGraph();
for (const canvas of [SQUARE, WIDE]) {
  const W = canvas.width;
  const off = (canvas.height - canvas.width) / 2;
  const tag = `${canvas.width}×${canvas.height}`;
  const want: Record<string, Record<string, number[]>> = {
    "skia-circle": { centerX: [W], centerY: [W], radiusX: [-W, 2 * W], radiusY: [-W, 2 * W], stroke_thickness: [1] },
    "skia-rect": { originX: [W], originY: [W], width: [-W / 2, W], height: [-W / 2, W], corner_radius: [W], rotate: [Math.PI / 180], stroke_thickness: [1] },
    "skia-line": { startX: [W], startY: [W], endX: [W], endY: [W], stroke_thickness: [1] },
  };
  for (const [type, mirror] of Object.entries(PRIMS)) {
    const id = `sk${mirror}`;
    const sub = closure(graph, `${id}_skc`);
    const s = makeSceneSampler(sub.nodes, sub.edges, `${id}_skc`, canvas, TL);
    const sc = "problem" in s ? null : s.sampleAt(0);
    if (!sc) {
      check(`${type} ${tag}: samples`, false);
      continue;
    }
    const all = collectBinds(sc.root);
    const refs = refsOf(sc.root);
    const untagged = all.filter((fb) => !fb.bind.ref);
    const derived = all.filter((fb) => fb.bind.deps);
    const scales: Record<string, Set<number>> = {};
    for (const r of refs) (scales[r.ref.param] ??= new Set()).add(r.ref.scale ?? 1);
    const mismatch = Object.entries(want[type]).filter(([p, ss]) => !scales[p] || ss.some((x) => !scales[p].has(x)) || scales[p].size !== ss.length);
    check(`${type} ${tag}: every geometry value is a ref × a constant scale (no deps)`, derived.length === 0 && mismatch.length === 0, `deps ${derived.length}; ${mismatch.map(([p]) => `${p}: ${[...(scales[p] ?? [])]}`).join("; ")}`);
    const values = refs.every((r) => {
      const n = sub.nodes.find((x) => x.id === r.ref.node)!;
      const p = n.animation?.[r.ref.param] ? evaluateKeyframesAt(n.animation[r.ref.param], "scalar", 0) : n.params[r.ref.param];
      if (typeof p !== "number") return true; // colors
      const raw = r.ref.param.startsWith("radius") || ["width", "height", "corner_radius", "stroke_thickness"].includes(r.ref.param) ? Math.max(0, p) : p;
      return closeValue(r.v, raw * (r.ref.scale ?? 1));
    });
    check(`${type} ${tag}: each bound value is its param × its scale`, values);
    const offsets = untagged.filter((fb) => /transform\.translate\.[01]$/.test(fb.path));
    check(
      `${type} ${tag}: the canvas y shift is a static outer group translate ${off === 0 ? "(none on a square canvas)" : `(0, ${off})`}`,
      off === 0 ? untagged.length === 0 : offsets.length === 2 && untagged.length === 2 && offsets[0].bind.v === 0 && offsets[1].bind.v === off,
      untagged.map((u) => `${u.path}=${JSON.stringify(u.bind.v)}`).join(", ")
    );
  }
}

{
  // stroke_units=% is a fraction of the canvas width (resolveStrokePx).
  const sub = closure(graph, "skline_skc");
  Object.assign(sub.nodes.find((n) => n.id === "skline")!.params, { stroke_units: "%", stroke_thickness: 2 });
  const s = makeSceneSampler(sub.nodes, sub.edges, "skline_skc", WIDE, TL);
  const sw = "problem" in s ? undefined : collectBinds(s.sampleAt(0)!.root).find((fb) => fb.path.endsWith("paint.strokeWidth"))?.bind;
  check("skia-line: stroke_units=% → strokeWidth = thickness × W/100, tagged with that scale", sw?.ref?.scale === WIDE.width / 100 && closeValue(sw?.v, 2 * (WIDE.width / 100)), JSON.stringify(sw));
}

// ---- 3. export kinds, per node ----------------------------------------------------------------
const kindOf = (b: { plan: { kind: string } }) => b.plan.kind;
for (const c of fx.SHAPE_CASES) {
  const sub = closure(graph, c.skia);
  const r = exportOf(sub, c.skia);
  check(`${c.id} (${c.type}) keyframed: exports with no problems and no warnings`, !!r.files && !r.problems.length && !r.warnings.length, [...r.problems, ...r.warnings].join(" | "));
  const sampled = r.binds.filter((b) => kindOf(b) === "sampled");
  if (c.kind === "primitive") {
    const refs = new Map(refsOf(r.scene0!.root).map((x) => [x.path, x.ref]));
    const wrong = r.binds.filter((b) => {
      const ref = refs.get(b.path);
      const animated = !!ref && c.animated.includes(ref.param);
      return kindOf(b) !== (animated ? "track" : "static");
    });
    const tracks = r.binds.filter((b) => kindOf(b) === "track");
    check(
      `${c.id}: keyframed ${c.animated.join(", ")} → ${tracks.length} exact TRACKS, nothing sampled, the rest static`,
      tracks.length > 0 && sampled.length === 0 && wrong.length === 0,
      wrong.map((b) => `${b.path}: ${kindOf(b)} (${(b.plan as any).from ?? (b.plan as any).reason})`).join("; ")
    );
    const scaled = tracks.filter((b) => (b.plan as any).tracks.every((t: any) => typeof t.scale === "number"));
    check(`${c.id}: the tracks carry their scale (canvas px / radians)`, scaled.length === tracks.length);
  } else {
    const paths = r.binds.filter((b) => b.role === "path");
    check(
      `${c.id}: keyframed generator → every path SAMPLED from upstream provenance, nothing else animated`,
      paths.length === (c.fill ? 2 : 1) && paths.every((b) => kindOf(b) === "sampled" && /derived from .*inputs .*keyframed/.test((b.plan as any).from)) && sampled.length === paths.length,
      r.binds.filter((b) => kindOf(b) !== "static").map((b) => `${b.path}: ${kindOf(b)} ${(b.plan as any).from ?? ""}`).join("; ")
    );
    const d0 = collectBinds(r.scene0!.root).find((fb) => fb.role === "path")?.bind.v;
    check(`${c.id}: the path is drawn (the bundled raster's no-GL guard lets the spline compute)`, typeof d0 === "string" && d0.startsWith("M "), String(d0).slice(0, 40));
  }
  // The same graph with nothing keyframed.
  const still = closure(graph, c.skia);
  for (const n of still.nodes) delete n.animation;
  const rs = exportOf(still, c.skia);
  check(
    `${c.id}: static params → every bind static, no warnings`,
    !!rs.files && !rs.warnings.length && rs.binds.every((b) => kindOf(b) === "static"),
    [...rs.problems, ...rs.warnings, ...rs.binds.filter((b) => kindOf(b) !== "static").map((b) => b.path)].join(" | ")
  );
}
// Through the shared family helper too (exportSkia + CanvasKit program
// checks), static and keyframed, at the non-square size.
{
  const bad: string[] = [];
  let typechecked = false;
  for (const c of fx.SHAPE_CASES) {
    for (const keyed of [true, false]) {
      const sub = closure(graph, c.skia);
      if (!keyed) for (const n of sub.nodes) delete n.animation;
      const r = await checkExportable({ nodes: sub.nodes, edges: sub.edges, canvasId: c.skia, canvas: WIDE, timeline: TL, typecheck: true, slot: "shapes" });
      if (!r.files || r.problems.length || r.warnings.length || r.programs.some((p) => !p.ok) || !r.typecheck.ok) {
        bad.push(`${c.id}${keyed ? "" : " (static)"}: ${[...r.problems, ...r.warnings, r.typecheck.ok ? "" : r.typecheck.output].join(" | ")}`);
      }
      typechecked ||= r.typecheck.ran;
    }
  }
  check(
    `checkExportable: all ${fx.SHAPE_CASES.length} canvases × keyframed/static ship at 320×180 with no warnings${typechecked ? " and type-check in skia-harness" : " (type-check skipped: no skia-harness/node_modules)"}`,
    bad.length === 0,
    bad.join("; ")
  );
}
// Driver wires: an Animated Value into an exposed param.
{
  const av = (id: string): GraphNode => ({ id, type: "animated-value", params: { value: 0 }, animation: { value: fx.kf([[0, 0.3], [60, 0.6]]) } });
  const prim = closure(graph, "skcircle_skc");
  for (const n of prim.nodes) delete n.animation;
  prim.nodes.find((n) => n.id === "skcircle")!.exposedParams = ["centerX"];
  prim.nodes.push(av("drv"));
  prim.edges.push({ id: "d", source: "drv", sourceHandle: "out:primary", target: "skcircle", targetHandle: "in:param:centerX" });
  const r = exportOf(prim, "skcircle_skc");
  const cx = r.binds.find((b) => b.path.endsWith("transform.translate.0"));
  check(
    "skia-circle: centerX wired from an Animated Value → a scaled track (× W), no warnings",
    !!r.files && !r.warnings.length && cx?.plan.kind === "track" && (cx.plan as any).tracks[0].scale === SQUARE.width,
    `${[...r.problems, ...r.warnings].join(" | ")} ${JSON.stringify(cx?.plan).slice(0, 120)}`
  );
  const gen = closure(graph, "star_skc");
  for (const n of gen.nodes) delete n.animation;
  gen.nodes.find((n) => n.id === "star")!.exposedParams = ["rotation"];
  gen.nodes.push({ ...av("drv"), animation: { value: fx.kf([[0, 0], [60, 40]]) } });
  gen.edges.push({ id: "d", source: "drv", sourceHandle: "out:primary", target: "star", targetHandle: "in:param:rotation" });
  const rg = exportOf(gen, "star_skc");
  check(
    "star: rotation wired from an Animated Value → the path is sampled (the driver is upstream), no warnings",
    !!rg.files && !rg.warnings.length && rg.binds.filter((b) => b.role === "path").every((b) => b.plan.kind === "sampled"),
    [...rg.problems, ...rg.warnings].join(" | ")
  );
}

// ---- 4. everything on one canvas: replay + type-check ------------------------------------------
{
  const all = fx.shapesGraph();
  const drawings = [...fx.SHAPE_CASES.filter((c) => c.kind === "generator").map((c) => `${c.id}_g`), ...fx.SHAPE_CASES.filter((c) => c.kind === "primitive").map((c) => c.id)];
  const grp = (id: string): GraphNode => ({ id, type: "skia-group", params: { translateX: 0, translateY: 0, rotate: 0, scaleX: 1, scaleY: 1, originX: 0, originY: 0, opacity: 1, blendMode: "srcOver" } });
  const wire = (source: string, target: string, handle: string): GraphEdge => ({ id: `${source}->${target}:${handle}`, source, sourceHandle: "out:primary", target, targetHandle: handle });
  const leaves: string[] = [];
  for (let i = 0; i < drawings.length; i += 4) {
    const gid = `all_${i / 4}`;
    all.nodes.push(grp(gid));
    drawings.slice(i, i + 4).forEach((d, k) => all.edges.push(wire(d, gid, `in:child${k + 1}`)));
    leaves.push(gid);
  }
  all.nodes.push(grp("all_root"), { id: "all_skc", type: "skia-canvas", params: { background_on: false, background: "#000000" } });
  leaves.forEach((l, k) => all.edges.push(wire(l, "all_root", `in:child${k + 1}`)));
  all.edges.push(wire("all_root", "all_skc", "in:scene"));

  const r = await checkExportable({ nodes: all.nodes, edges: all.edges, canvasId: "all_skc", canvas: WIDE, timeline: TL, typecheck: true, slot: "shapes" });
  check(`one canvas with all ${drawings.length} drawings exports at 320×180 with no warnings`, !!r.files && !r.problems.length && !r.warnings.length, [...r.problems, ...r.warnings].join(" | "));
  if (r.typecheck.ran || !r.typecheck.ok) check("the bundle type-checks in skia-harness (react-native-skia 3.4.0, Reanimated 4.7)", r.typecheck.ok, r.typecheck.output);
  else console.log(`skip ${r.typecheck.output}`);
  if (r.files) {
    const manifest = JSON.parse(r.files["manifest.json"]);
    const counts = manifest.bindCounts as Record<string, number>;
    check(
      `the bundle: ${counts.track ?? 0} tracks, ${counts.sampled ?? 0} sampled paths, ${counts.static ?? 0} static — sampled are exactly the generator paths`,
      manifest.binds.filter((b: any) => b.kind === "sampled").every((b: any) => b.role === "path") &&
        (counts.sampled ?? 0) === fx.SHAPE_CASES.filter((c) => c.kind === "generator").reduce((n, c) => n + (c.fill ? 2 : 1), 0),
      JSON.stringify(counts)
    );
    const sampler = makeSceneSampler(all.nodes, all.edges, "all_skc", WIDE, TL);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skia-shapes-"));
    try {
      for (const [f, text] of Object.entries(r.files)) if (!f.includes("/")) fs.writeFileSync(path.join(tmp, f), text);
      const emitted = await import(pathToFileURL(path.join(tmp, "timeline.ts")).href);
      let mismatch = "";
      let compared = 0;
      for (let f = 0; f < FRAMES && !mismatch && !("problem" in sampler); f++) {
        const sc = sampler.sampleAt(f * TL.ticksPerFrame)!;
        const byPath = new Map(collectBinds(sc.root).map((fb) => [fb.path, fb.bind.v]));
        const out = emitted.sampleBinds(f / TL.fps);
        for (const b of manifest.binds) {
          const wantV = byPath.get(b.path);
          const got = b.role === "path" ? emitted.seriesStep(emitted[`PATH_${b.sample}`], f) : out[b.sample];
          compared++;
          if (!(b.scale !== undefined ? closeValue(wantV, got) : same(wantV, got))) {
            mismatch = `frame ${f} ${b.path}: producer ${JSON.stringify(wantV)?.slice(0, 60)} export ${JSON.stringify(got)?.slice(0, 60)}`;
            break;
          }
        }
      }
      check(`the emitted timeline replays every animated bind at every frame (${manifest.binds.length} binds × ${FRAMES} frames, ${compared} reads)`, !mismatch && compared > 0, mismatch);
      const jsx = r.files["ToolboxScene.tsx"];
      check("the primitives emit React Native Skia's own <Oval>, <RoundedRect> and <Line>", ["<Oval", "<RoundedRect", "<Line"].every((t) => jsx.includes(t)));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

// ---- 5. pixels --------------------------------------------------------------------------------
type RGBA = [number, number, number, number];
const hex = (h: string): RGBA => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255];
const FILL = hex(fx.FILL);
const STROKE = hex(fx.STROKE);

function render(scene: SkiaScene): { px: Uint8Array; w: number; h: number; problems: string[] } {
  const surface = CK.MakeSurface(scene.width, scene.height)!;
  const canvas = surface.getCanvas();
  canvas.clear(CK.TRANSPARENT);
  const res = renderScene(CK, canvas, scene, {});
  surface.flush();
  const snap = surface.makeImageSnapshot();
  const px = snap.readPixels(0, 0, { width: scene.width, height: scene.height, colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB }) as Uint8Array;
  res.release();
  snap.delete();
  surface.delete();
  return { px: new Uint8Array(px), w: scene.width, h: scene.height, problems: res.problems };
}

interface Probe {
  what: string;
  x: number;
  y: number;
  want: RGBA | "clear";
}
function probe(img: ReturnType<typeof render>, p: Probe): string | null {
  const x = Math.floor(p.x);
  const y = Math.floor(p.y);
  if (x < 1 || y < 1 || x >= img.w - 1 || y >= img.h - 1) return null; // off canvas: not a claim
  const o = (y * img.w + x) * 4;
  const got = Array.from(img.px.subarray(o, o + 4));
  const ok = p.want === "clear" ? got[3] === 0 : p.want.every((v, i) => Math.abs(got[i] - v) <= 2);
  return ok ? null : `${p.what} @(${x},${y}) = [${got}] want ${p.want === "clear" ? "clear" : `[${p.want}]`}`;
}

const at = (n: GraphNode, param: string, tick: number): number => {
  const block = n.animation?.[param];
  const v = block ? evaluateKeyframesAt(block, "scalar", tick) : n.params[param];
  return typeof v === "number" ? v : Number(getNodeDef(n.type)!.params.find((p) => p.name === param)?.default);
};

function primitiveProbes(type: string, n: GraphNode, tick: number, W: number, H: number): Probe[] {
  const X = (x: number) => x * W;
  const Y = (y: number) => y * W + (H - W) / 2;
  const half = fx.STROKE_PX / 2;
  if (type === "skia-circle") {
    const cx = X(at(n, "centerX", tick));
    const cy = Y(at(n, "centerY", tick));
    const rx = at(n, "radiusX", tick) * W;
    const ry = at(n, "radiusY", tick) * W;
    return [
      { what: "center (fill)", x: cx, y: cy, want: FILL },
      { what: "0.7·rx (fill)", x: cx + 0.7 * rx, y: cy, want: FILL },
      { what: "+rx outline (stroke)", x: cx + rx, y: cy, want: STROKE },
      { what: "−rx outline (stroke)", x: cx - rx, y: cy, want: STROKE },
      { what: "+ry outline (stroke: the y radius)", x: cx, y: cy + ry, want: STROKE },
      { what: "past the stroke on x", x: cx + rx + half + 3, y: cy, want: "clear" },
      { what: "past the stroke on y", x: cx, y: cy - ry - half - 3, want: "clear" },
      { what: "inside the bounding box corner", x: cx + 0.8 * rx, y: cy + 0.8 * ry, want: "clear" },
    ];
  }
  if (type === "skia-rect") {
    const cx = X(at(n, "originX", tick));
    const cy = Y(at(n, "originY", tick));
    const w = at(n, "width", tick) * W;
    const h = at(n, "height", tick) * W;
    const r = Math.min(at(n, "corner_radius", tick) * W, w / 2, h / 2);
    const th = (at(n, "rotate", tick) * Math.PI) / 180;
    const P = (lx: number, ly: number) => ({ x: cx + lx * Math.cos(th) - ly * Math.sin(th), y: cy + lx * Math.sin(th) + ly * Math.cos(th) });
    // The corner arc's point on the diagonal is on the outline; the sharp
    // corner is √2·r from the arc's center — outside the stroke once
    // r·(√2 − 1) clears half the stroke (r > ~10 px here).
    const diag = r - r / Math.SQRT2;
    return [
      { what: "center (fill)", ...P(0, 0), want: FILL },
      { what: "0.4·w along the rotated x (fill)", ...P(0.4 * w, 0), want: FILL },
      { what: "0.35·h along the rotated y (fill)", ...P(0, 0.35 * h), want: FILL },
      { what: "right side (stroke)", ...P(w / 2, 0), want: STROKE },
      { what: "bottom side (stroke)", ...P(0, h / 2), want: STROKE },
      { what: "past the right side", ...P(w / 2 + half + 3, 0), want: "clear" },
      { what: "the corner arc on the diagonal (stroke)", ...P(w / 2 - diag, h / 2 - diag), want: STROKE },
      ...(r * (Math.SQRT2 - 1) > half + 1.5 ? [{ what: "the sharp corner, cut by corner_radius", ...P(w / 2, h / 2), want: "clear" as const }] : []),
    ];
  }
  // skia-line
  const x1 = X(at(n, "startX", tick));
  const y1 = Y(at(n, "startY", tick));
  const x2 = X(at(n, "endX", tick));
  const y2 = Y(at(n, "endY", tick));
  const len = Math.hypot(x2 - x1, y2 - y1);
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const L = (t: number, s: number) => ({ x: x1 + (x2 - x1) * t - uy * s, y: y1 + (y2 - y1) * t + ux * s });
  return [
    { what: "midpoint (stroke)", ...L(0.5, 0), want: STROKE },
    { what: "a quarter along (stroke)", ...L(0.25, 0), want: STROKE },
    { what: "beside the stroke", ...L(0.5, half + 3), want: "clear" },
    { what: "the round cap past the end", x: x2 + ux * (half - 1.5), y: y2 + uy * (half - 1.5), want: STROKE },
    { what: "beyond the cap", x: x2 + ux * (half + 3), y: y2 + uy * (half + 3), want: "clear" },
  ];
}

// A generator's spline at `tick`, evaluated the way the sampler does.
function splineAt(g: { nodes: GraphNode[]; edges: GraphEdge[] }, id: string, tick: number, canvas: { width: number; height: number }): SplineValue | null {
  const ctx = dataOnlyContext(canvas, TL);
  ctx.tick = tick;
  ctx.frame = tick / TL.ticksPerFrame;
  ctx.time = tick / (TL.ticksPerFrame * TL.fps);
  const r = evaluateGraph(g.nodes, g.edges, ctx, new Map() as EvalCache, null, undefined, null, { extraTargets: [id], extraConsumed: new Map([[id, ["primary"]]]) });
  const v = r.outputs.get(id)?.primary;
  return v?.kind === "spline" ? (v as SplineValue) : null;
}

const INTERIOR: Record<string, (n: GraphNode, tick: number) => [number, number] | null> = {
  circle: (n, t) => [at(n, "centerX", t), at(n, "centerY", t)],
  rectangle: (n, t) => [at(n, "originX", t), at(n, "originY", t)],
  polygon: (n, t) => [at(n, "centerX", t), at(n, "centerY", t)],
  star: (n, t) => [at(n, "centerX", t), at(n, "centerY", t)],
  arrow: (n, t) => [(at(n, "tailX", t) + at(n, "tipX", t)) / 2 - 0.05, (at(n, "tailY", t) + at(n, "tipY", t)) / 2],
  arc: (n, t) => {
    const mid = ((at(n, "startAngle", t) + at(n, "endAngle", t)) / 2) * (Math.PI / 180);
    const r = at(n, "radius", t) * 0.5;
    return [at(n, "centerX", t) + Math.cos(mid) * r, at(n, "centerY", t) + Math.sin(mid) * r];
  },
  "spline-draw": () => [0.5, 0.5],
  "svg-source": () => [0.5, 0.5],
};

for (const canvas of [SQUARE, WIDE]) {
  const tag = `${canvas.width}×${canvas.height}`;
  for (const c of fx.SHAPE_CASES) {
    const sub = closure(graph, c.skia);
    const s = makeSceneSampler(sub.nodes, sub.edges, c.skia, canvas, TL);
    if ("problem" in s) {
      check(`${c.id} ${tag}: samples`, false, s.problem);
      continue;
    }
    const misses: string[] = [];
    let probes = 0;
    let problems: string[] = [];
    for (const f of fx.SHAPES_FRAMES) {
      const tick = f * TL.ticksPerFrame;
      const sc = s.sampleAt(tick)!;
      const img = render(sc);
      problems = problems.concat(img.problems);
      const list: Probe[] = [{ what: "corner", x: 2, y: 2, want: "clear" }];
      if (c.kind === "primitive") {
        list.push(...primitiveProbes(c.type, sub.nodes.find((n) => n.id === c.id)!, tick, canvas.width, canvas.height));
      } else {
        const n = sub.nodes.find((x) => x.id === c.id)!;
        const sp = splineAt(sub, c.id, tick, canvas);
        const toPx = (p: [number, number]) => ({ x: p[0] * canvas.width, y: aspectCorrectY(p[1], canvas.width / canvas.height) * canvas.height });
        for (const sub0 of sp?.subpaths ?? []) for (const a of sub0.anchors) list.push({ what: "anchor under the stroke", ...toPx(a.pos), want: STROKE });
        const inner = c.fill ? INTERIOR[c.id]?.(n, tick) : null;
        if (inner) list.push({ what: "interior (fill)", ...toPx(inner), want: FILL });
      }
      for (const p of list) {
        const m = probe(img, p);
        if (m) misses.push(`f${f} ${m}`);
        else probes++;
      }
    }
    check(`${c.id} (${c.type}) ${tag}: pixels at ${probes} probes over frames ${fx.SHAPES_FRAMES.join("/")} match the geometry`, misses.length === 0 && problems.length === 0, [...problems, ...misses].slice(0, 4).join("; "));
  }
}

// ---- 6. edges of the contract -------------------------------------------------------------------
{
  // An upstream compute that throws: the shape downstream gets no spline.
  const THROWS: NodeDefinition = {
    type: "test-shapes-throws",
    name: "Throws",
    category: "spline",
    description: "check-skia-shapes fixture",
    hidden: true,
    backend: "webgl2",
    // Reads the tick: never cached.
    stable: false,
    skia: { class: "native" },
    inputs: [],
    params: [],
    primaryOutput: "spline",
    auxOutputs: [],
    compute({ ctx }) {
      if (ctx.tick >= 30_000) throw new Error("boom at frame 30");
      return { primary: { kind: "spline", subpaths: [{ anchors: [{ pos: [0.2, 0.2] }, { pos: [0.8, 0.8] }], closed: false }] } };
    },
  };
  registerNode(THROWS);
  const g = closure(graph, "line_skc");
  g.nodes = g.nodes.map((n) => (n.id === "line" ? { id: "line", type: THROWS.type, params: {} } : n));
  // (The evaluator logs every throw; this one is on purpose.)
  const log = console.error;
  console.error = () => {};
  let r: ReturnType<typeof exportSkia>;
  try {
    r = exportSkia({ nodes: g.nodes, edges: g.edges, targetId: "line_skc", name: "t", canvas: SQUARE, timeline: TL, runtimeSource });
  } finally {
    console.error = log;
  }
  check(
    "an upstream node that throws while sampling refuses the export (not an empty path)",
    !r.files && r.problems.some((p) => p.includes('Node "line" failed while sampling the scene: boom at frame 30')),
    r.problems.join(" | ")
  );
}
{
  // A radius keyed to 0 with an overshooting ease: the mirror clamps the
  // dip below 0, so does the port, and the export samples what it draws.
  const g = closure(graph, "skcircle_skc");
  const n = g.nodes.find((x) => x.id === "skcircle")!;
  n.animation = { radiusX: fx.kf([[0, 0.2], [60, 0]], "easeOutBack") };
  const r = exportOf(g, "skcircle_skc");
  const rx = r.binds.filter((b) => /geom\.(x|w)$/.test(b.path));
  check(
    "a radius keyed below 0 (easeOutBack overshoot) clamps like Circle: sampled, with a warning naming the bind",
    !!r.files && rx.length > 0 && rx.every((b) => b.plan.kind === "sampled") && r.warnings.some((w) => w.includes("geom.x") && w.includes("does not reproduce")),
    [...r.problems, ...r.warnings].join(" | ")
  );
}
{
  // The bundled raster is skipped only where there is no GL.
  const def = getNodeDef("star")!;
  const ctx = dataOnlyContext(SQUARE, TL);
  const n = graph.nodes.find((x) => x.id === "star")!;
  const out = def.compute({ inputs: {}, params: n.params, ctx, nodeId: "star" } as any) as { primary: SplineValue; aux?: Record<string, unknown> };
  check("data-only star (stroke + fill on): spline out, no image aux, no throw", out.primary.subpaths[0].anchors.length === 10 && !out.aux?.image);
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
