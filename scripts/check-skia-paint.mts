// check-skia-paint: the Skia paint family — Stroke / Fill / Trim Path /
// Round Corners / Dash / Gradient Fill / Text (Skia)
// (specdocs/101326_skia-target.md §7 Wave 2, family F8). Offline:
// CanvasKit on a CPU surface in Node, the real evaluator in a data-only
// context, the real exporter.
//
//   1. every Skia Canvas of scripts/fixtures/skia/paint-graph.ts exports
//      with no problems and its runtime programs (none expected) compile;
//      one combined canvas holding every node kind — animated trim, radius,
//      dash offset and font size included — exports, its bundle
//      type-checks against react-native-skia 3.4.0 (skia-harness), and the
//      tracks / sampled paths it ships are the ones the nodes tag;
//   2. the mirrors are the originals' math: the fillet path is
//      roundCorners' to the path data's precision, the trim windows cover
//      the arc length trimSubpaths keeps, the gradient endpoints / stops are
//      the Canvas2D gradient Rasterize Spline builds (a recording fake), the
//      conic's rotated sweep stops reproduce the conic ramp at every angle;
//   3. the text layout constants are measured truths: the bundled fonts'
//      tables match the files, canvasMiddleToAlphabetic equals Chromium's
//      TextMetrics (values measured in Electron), paragraphLineBox equals
//      CanvasKit's SkParagraph line metrics, the Geist typeface really
//      loads (family name read back from the face);
//   4. CanvasKit draws what the IR means: trim reveals the right share of
//      the outline and the wrapped remainder, the fillet and the corner
//      effect clear a star's tips, the dash modifier is pixel-identical to
//      Stroke (Skia)'s own dashes, dots are dots, the gradient's ends carry
//      the ramp's ends, a paragraph wraps inside its box, paragraph shaping
//      kerns where simple runs don't;
//   5. the emitted Paragraph folds an enclosing group's opacity into its
//      run (React Native paints a Paragraph with its own paint).
//
// Pixel parity against the native nodes needs real GL and Chromium's text:
// `npm run compare:skia -- --a paint:<pair>n --b paint:<pair>s --expect close`
// (pairs in the fixture's header).
//
//   npx tsx scripts/check-skia-paint.mts

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { CanvasKit } from "canvaskit-wasm";
import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type { GradientCanvas } from "@/engine/spline-gradient-fill";
import type { SkiaNode, SkiaScene, ShaderIR } from "@/engine/skia/scene-ir";
import type { SplineSubpath } from "@/engine/types";
import type { TrimMeasure } from "@/engine/spline-trim";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { checkExportable } = await import("./skia/export-check");
const { makeSceneSampler } = await import("@/lib/skia-export");
const { renderScene } = await import("@/engine/skia/scene-render");
const fx = await import("./fixtures/skia/paint-graph");
const { trimWindows } = await import("@/nodes/skia/trim-path");
const { parseSvgPathD, subpathsToD, subpathsToLineD } = await import("@/nodes/skia/paint-shared");
const { SKIA_FONTS, canvasMiddleToAlphabetic, paragraphLineBox } = await import("@/nodes/skia/fonts");
const { roundCorners, measureSpline } = await import("@/engine/spline-math");
const { trimSubpaths } = await import("@/engine/spline-trim");
const { splineToSvgPathD } = await import("@/engine/svg-serialize");
const { makeSubpathGradientFn } = await import("@/engine/spline-gradient-fill");

const require = createRequire(path.join(ROOT, "package.json"));
const CK: CanvasKit = await require("canvaskit-wasm")();

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${!cond && detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}

const SIZE = fx.PAINT_SIZE;
const CANVAS = { width: SIZE, height: SIZE };
const TIMELINE = { ...fx.PAINT_TIMELINE, sceneDurationTicks: fx.PAINT_SCENE_TICKS };
const G = fx.paintGraph();

// ---- helpers ----------------------------------------------------------------------------

function sceneAt(nodes: GraphNode[], edges: GraphEdge[], canvasId: string, frame: number): SkiaScene {
  const s = makeSceneSampler(nodes, edges, canvasId, CANVAS, TIMELINE);
  if ("problem" in s) throw new Error(s.problem);
  const scene = s.sampleAt(frame * TIMELINE.ticksPerFrame);
  if (!scene) throw new Error(`${canvasId}: no scene at frame ${frame}: ${s.lastProblem()}`);
  return scene;
}

const fontBytes: Record<string, Uint8Array> = {};
for (const f of Object.values(SKIA_FONTS)) {
  fontBytes[f.asset.id] = new Uint8Array(fs.readFileSync(path.join(ROOT, "public", f.asset.url)));
}

interface Rendered {
  px: Uint8Array;
  problems: string[];
}
function render(scene: SkiaScene): Rendered {
  const surface = CK.MakeSurface(SIZE, SIZE)!;
  const canvas = surface.getCanvas();
  canvas.clear(CK.TRANSPARENT);
  const r = renderScene(CK, canvas, scene, {
    assets: (id, kind) => (kind === "font" ? (fontBytes[id] ?? null) : null),
  });
  surface.flush();
  const px = canvas.readPixels(0, 0, {
    width: SIZE,
    height: SIZE,
    colorType: CK.ColorType.RGBA_8888,
    alphaType: CK.AlphaType.Unpremul,
    colorSpace: CK.ColorSpace.SRGB,
  }) as Uint8Array;
  r.release();
  surface.delete();
  return { px, problems: r.problems };
}
const at = (r: Rendered, x: number, y: number) => {
  const i = (Math.round(y) * SIZE + Math.round(x)) * 4;
  return [r.px[i], r.px[i + 1], r.px[i + 2], r.px[i + 3]];
};
const inked = (r: Rendered, x: number, y: number) => at(r, x, y)[3] > 128;
function inkCount(r: Rendered): number {
  let n = 0;
  for (let i = 3; i < r.px.length; i += 4) if (r.px[i] > 128) n++;
  return n;
}
// Ink rows / columns span and row bands (runs of inked rows).
function inkBox(r: Rendered) {
  let x0 = SIZE, x1 = -1, y0 = SIZE, y1 = -1;
  const rows = new Array<boolean>(SIZE).fill(false);
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++)
      if (r.px[(y * SIZE + x) * 4 + 3] > 128) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
        rows[y] = true;
      }
  let bands = 0;
  for (let y = 0; y < SIZE; y++) if (rows[y] && (y === 0 || !rows[y - 1])) bands++;
  return { x0, x1, y0, y1, bands };
}
// Canvas01 → px (square canvas: identity scale).
const P = (x: number, y: number): [number, number] => [x * SIZE, y * SIZE];

function walk(n: SkiaNode, fn: (n: SkiaNode) => void) {
  fn(n);
  if (n.k === "group") n.children.forEach((c) => walk(c, fn));
}

// ---- 1. every canvas exports; the combined canvas type-checks ---------------------------
const canvases = G.nodes.filter((n) => n.type === "skia-canvas").map((n) => n.id);
for (const id of canvases) {
  const r = await checkExportable({ nodes: G.nodes, edges: G.edges, canvasId: id, canvas: CANVAS, timeline: TIMELINE, slot: `paint-${id}` });
  check(`export ${id}: no problems`, r.problems.length === 0 && !!r.files, r.problems.join(" | "));
  check(`export ${id}: runtime programs compile`, r.programs.every((p) => p.ok), JSON.stringify(r.programs.filter((p) => !p.ok)));
}

// The combined canvas: every node kind under nested Skia Groups, with the
// animations the exporter must ship as tracks (trim end, corner radius,
// dash offset, font size) or as sampled geometry (the fillet radius).
function combinedGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = G.nodes.map((n) => ({ ...n }));
  const edges: GraphEdge[] = [...G.edges];
  const e = (source: string, target: string, targetHandle: string): GraphEdge => ({ id: `${source}->${target}:${targetHandle}`, source, sourceHandle: "out:primary", target, targetHandle });
  const key = (pairs: [number, number][]) => ({ animated: true, trackVisible: true, keyframes: pairs.map(([f, v]) => ({ tick: f * TIMELINE.ticksPerFrame, value: v, easingOut: "easeInOutSine" as const })) });
  // Animated copies of the corner / dash / text nodes.
  nodes.push({ id: "ax_rc", type: "skia-round-corners", params: { radius: 0.02, method: "corner" }, animation: { radius: key([[0, 0.02], [60, 0.08]]) } });
  edges.push(e("rc1k", "ax_rc", "in:drawing"));
  nodes.push({ id: "ax_fil", type: "skia-round-corners", params: { radius: 0.02, method: "fillet" }, animation: { radius: key([[0, 0.02], [60, 0.08]]) } });
  edges.push(e("rc3k", "ax_fil", "in:drawing"));
  nodes.push({ id: "ax_dash", type: "skia-dash", params: { style: "dashed", dash_length: 20, dash_gap: 10, dot_spacing: 12, dash_offset: 0, units: "px" }, animation: { dash_offset: key([[0, 0], [60, 60]]) } });
  edges.push(e("d1k", "ax_dash", "in:drawing"));
  nodes.push({ id: "ax_text", type: "skia-text", params: { ...(G.nodes.find((n) => n.id === "t1k")!.params), text: "Grow" }, animation: { font_size: key([[0, 40], [60, 80]]) } });
  nodes.push({ id: "ax_line", type: "skia-text", params: { ...(G.nodes.find((n) => n.id === "t1lk")!.params), text: "Runs", translateY: 0.3 } });
  const groups: string[][] = [
    ["s1k", "s2k", "s3k", "s4k"],
    ["d1d", "f1k", "f2k", "tr1x"],
    ["tr2x", "rc1x", "rc2x", "rc3x"],
    ["g1x", "g2x", "g3x", "t1k"],
    ["t2k", "t3k", "t4g", "ax_rc"],
    ["ax_fil", "ax_dash", "ax_text", "ax_line"],
  ];
  const top: string[] = [];
  groups.forEach((kids, gi) => {
    const id = `cg${gi}`;
    nodes.push({ id, type: "skia-group", params: { translateX: 0, translateY: 0, rotate: 0, scaleX: 1, scaleY: 1, originX: 0, originY: 0, opacity: 1, blendMode: "srcOver" } });
    kids.forEach((k, i) => edges.push(e(k, id, `in:child${i + 1}`)));
    top.push(id);
  });
  const outer = (id: string, kids: string[]) => {
    nodes.push({ id, type: "skia-group", params: { translateX: 0, translateY: 0, rotate: 0, scaleX: 1, scaleY: 1, originX: 0, originY: 0, opacity: 1, blendMode: "srcOver" } });
    kids.forEach((k, i) => edges.push(e(k, id, `in:child${i + 1}`)));
  };
  outer("cgA", top.slice(0, 3));
  outer("cgB", top.slice(3));
  outer("cgAll", ["cgA", "cgB"]);
  nodes.push({ id: "cAll", type: "skia-canvas", params: { background_on: false } });
  edges.push(e("cgAll", "cAll", "in:scene"));
  return { nodes, edges };
}
const C = combinedGraph();
const combined = await checkExportable({ nodes: C.nodes, edges: C.edges, canvasId: "cAll", canvas: CANVAS, timeline: TIMELINE, typecheck: true, slot: "paint-all" });
check("combined canvas: exports with no problems", combined.problems.length === 0 && !!combined.files, combined.problems.join(" | "));
check(
  "combined canvas: the emitted bundle type-checks against react-native-skia 3.4.0 (Paragraph code included)",
  combined.typecheck.ok,
  combined.typecheck.output
);
if (!combined.typecheck.ran) console.log(`     (${combined.typecheck.output})`);
for (const w of combined.warnings) console.log(`     warning: ${w}`);

if (combined.files) {
  const manifest = JSON.parse(combined.files["manifest.json"]) as { binds: { path: string; kind: string; from: string; role?: string }[] };
  const tsx = combined.files["ToolboxScene.tsx"];
  const bindAt = (re: RegExp) => manifest.binds.filter((b) => re.test(b.path));
  const sceneC = sceneAt(C.nodes, C.edges, "cAll", 0);
  // Find IR paths of the animated nodes by id.
  const pathsOf = (id: string): string[] => {
    const out: string[] = [];
    const visit = (n: SkiaNode, p: string) => {
      if (n.id === id) out.push(p);
      if (n.k === "group") n.children.forEach((c, i) => visit(c, `${p}.children.${i}`));
    };
    visit(sceneC.root, "root");
    return out;
  };
  const under = (id: string) => pathsOf(id).map((p) => new RegExp(`^${p.replace(/\./g, "\\.")}\\.`));
  const anyUnder = (id: string, pred: (b: { path: string; kind: string; role?: string }) => boolean) =>
    manifest.binds.some((b) => under(id).some((re) => re.test(b.path)) && pred(b));
  check("export: a keyframed trim end ships as a track (<Path end>)", anyUnder("tr1x", (b) => /pathEffects\.0\.end$/.test(b.path) && b.kind === "track"));
  check("export: an offset trim that wraps ships sampled windows", anyUnder("tr2x", (b) => /pathEffects\.0\.(start|end)$/.test(b.path) && b.kind === "sampled"));
  check("export: a keyframed corner radius ships as a scaled track (CornerPathEffect r)", anyUnder("ax_rc", (b) => /pathEffects\.\d\.r$/.test(b.path) && b.kind === "track"));
  check("export: a keyframed fillet radius ships the rounded path per frame", anyUnder("ax_fil", (b) => /geom\.d$/.test(b.path) && b.kind === "sampled" && b.role === "path"));
  check("export: the fillet's per-frame path interpolates (equal verbs)", /usePathInterpolation/.test(tsx));
  // (Dash (Skia) keeps its shapes' ids; its phase is the only animated one.)
  check("export: a keyframed dash offset ships as a track (DashPathEffect phase)", manifest.binds.some((b) => /pathEffects\.\d\.phase$/.test(b.path) && b.kind === "track"));
  check("export: a keyframed font size ships as a track", anyUnder("ax_text", (b) => /font\.size$/.test(b.path) && b.kind === "track"));
  // (The line box follows the size; the anchor point doesn't since Wave 3
  // lane T — y is the box edge vAlign names.)
  check("export: text placement that depends on the size is sampled", anyUnder("ax_text", (b) => /\.(lineHeight|baselineOffset)$/.test(b.path) && b.kind === "sampled"));
  check("export: paragraph text emits <Picture> + makeTextPicture (exact line placement, lane T)", /<Picture/.test(tsx) && /makeTextPicture\(/.test(tsx));
  check("export: simple-run text emits <Text>", /<Text\b/.test(tsx) && /textAdvance\(/.test(tsx));
  check("export: the Geist font ships as an asset with its editor URL", combined.files["manifest.json"].includes("/fonts/Geist-Regular.ttf"));
  void bindAt;
}

// ---- 2. the mirrors are the originals' math -------------------------------------------------
const shapesOf = (scene: SkiaScene) => {
  const out: Extract<SkiaNode, { k: "shape" }>[] = [];
  walk(scene.root, (n) => {
    if (n.k === "shape") out.push(n);
  });
  return out;
};
const authoredToPx = (subs: SplineSubpath[]) => parseSvgPathD(splineToSvgPathD(subs, SIZE, SIZE));
function maxPathDiff(a: string, b: string): number {
  const pa = parseSvgPathD(a);
  const pb = parseSvgPathD(b);
  if ("problem" in pa || "problem" in pb || pa.subpaths.length !== pb.subpaths.length) return Infinity;
  let m = 0;
  pa.subpaths.forEach((s, i) => {
    const t = pb.subpaths[i];
    if (s.anchors.length !== t.anchors.length || s.closed !== t.closed) m = Infinity;
    s.anchors.forEach((an, j) => {
      const bn = t.anchors[j];
      if (!bn) return;
      const pairs: [number[] | undefined, number[] | undefined][] = [[an.pos, bn.pos], [an.inHandle, bn.inHandle], [an.outHandle, bn.outHandle]];
      for (const [x, y] of pairs) {
        const xx = x ?? [0, 0];
        const yy = y ?? [0, 0];
        m = Math.max(m, Math.abs(xx[0] - yy[0]), Math.abs(xx[1] - yy[1]));
      }
    });
  });
  return m;
}
{
  // Fillet = Round Corners' roundCorners on the same spline.
  const rc = shapesOf(sceneAt(G.nodes, G.edges, "rc1s", 0))[0];
  const native = splineToSvgPathD(roundCorners([fx.STAR], 0.06), SIZE, SIZE);
  const diff = rc?.geom.k === "path" ? maxPathDiff(rc.geom.d.v, native) : Infinity;
  check("fillet: the rounded path is Round Corners' (anchors and handles within 0.002 px)", diff <= 0.002, `max ${diff}`);
  const parsed = authoredToPx([fx.STAR]);
  check("path reader: toolbox path data reads back to the same anchors", !("problem" in parsed) && parsed.subpaths[0].anchors.length === 10 && parsed.subpaths[0].closed);
  // The corner effect keeps the geometry (as lines) and rounds by r = radius × W.
  const ce = shapesOf(sceneAt(G.nodes, G.edges, "rc2s", 0))[0];
  const corner = ce?.paint.pathEffects?.find((e) => e.k === "corner");
  check("corner effect: CornerPathEffect r = radius × canvas width, straight edges as lines", corner?.k === "corner" && Math.abs(corner.r.v - 0.06 * SIZE) < 1e-9 && ce.geom.k === "path" && /L /.test(ce.geom.d.v) && !/C /.test(ce.geom.d.v));
}
{
  // Trim windows: the window semantics of trimSubpaths, case by case …
  const cases: [number, number, number, [number, number], [number, number]][] = [
    [0.2, 0.6, 0, [0.2, 0.6], [0, 0]],
    [0, 0.4, 0.75, [0.75, 1], [0, 0.15]],
    [0.3, 0.9, -0.5, [0.8, 1], [0, 0.4]],
    [0, 1, 0.3, [0, 1], [0, 0]],
    [0.5, 0.5, 0.2, [0, 0], [0, 0]],
    [0.1, 0.3, 2.25, [0.35, 0.55], [0, 0]],
  ];
  for (const [s, e, o, a, b] of cases) {
    const w = trimWindows(s, e, o);
    const ok = [...w.a, ...w.b].every((v, i) => Math.abs(v - [...a, ...b][i]) < 1e-9);
    check(`trim window (${s}, ${e}, offset ${o}) → [${a}] + [${b}]`, ok, JSON.stringify(w));
  }
  // … and the arc length they keep is the length trimSubpaths keeps
  // (measure = arc length, what a new Trim Path does: exact on the star's
  // and hexagon's straight cubics as on the circle).
  let worst = 0;
  for (const sub of [fx.CIRCLE, fx.STAR, fx.HEXAGON, fx.S_CURVE]) {
    const total = measureSpline({ kind: "spline", subpaths: [sub] }).total;
    for (const [s, e, o] of [[0, 0.4, 0.75], [0.1, 0.7, 0], [0.25, 0.5, 0.6], [0.03, 0.37, 0]] as const) {
      const kept = measureSpline({ kind: "spline", subpaths: trimSubpaths([sub], s, e, o, "arc length") }).total / total;
      const w = trimWindows(s, e, o);
      worst = Math.max(worst, Math.abs(kept - (w.a[1] - w.a[0] + w.b[1] - w.b[0])));
    }
  }
  check("trim windows keep the arc length trimSubpaths keeps (circle, star, hexagon, S-curve; within 1e-9)", worst < 1e-9, `worst ${worst.toExponential(2)}`);
}
{
  // Where React Native cuts: CanvasKit's Path.makeTrimmed (SkTrimPathEffect,
  // what <Path start end> runs) on the path data the Skia nodes emit
  // (splineToSvgPathD: every segment a cubic, a handle-less edge a
  // degenerate one), vs where Trim Path cuts. Arc length agrees to Skia's
  // own measuring tolerance: SkContourMeasure subdivides a cubic until its
  // control points sit within 0.5 px of the chord's thirds and maps length
  // linearly inside each piece, so on a degenerate-cubic edge its cut lands
  // up to ~0.3 px off the true point; written as lines (L), it is exact and
  // so is the agreement. The original segment measure (old saves) drifts
  // along each straight edge.
  const pxOf = (sub: SplineSubpath): SplineSubpath => ({
    closed: sub.closed,
    anchors: sub.anchors.map((a) => ({
      pos: [a.pos[0] * SIZE, a.pos[1] * SIZE],
      ...(a.inHandle ? { inHandle: [a.inHandle[0] * SIZE, a.inHandle[1] * SIZE] as [number, number] } : {}),
      ...(a.outHandle ? { outHandle: [a.outHandle[0] * SIZE, a.outHandle[1] * SIZE] as [number, number] } : {}),
    })),
  });
  const L_PATH: SplineSubpath = { closed: false, anchors: [{ pos: [0.1, 0.2] }, { pos: [0.82, 0.2] }, { pos: [0.82, 0.38] }] };
  const shapes: [string, SplineSubpath, boolean][] = [["star", fx.STAR, true], ["hexagon", fx.HEXAGON, true], ["circle", fx.CIRCLE, false], ["S-curve", fx.S_CURVE, false], ["0.72 + 0.18 polyline", L_PATH, true]];
  type Worst = [number, string];
  const worstBy: Record<"arc" | "seg" | "arcLines", Worst> = { arc: [0, ""], seg: [0, ""], arcLines: [0, ""] };
  const cutAt = (d: string, f: number): [number, number] => {
    const ck = CK.Path.MakeFromSVGString(d)!;
    const cut = ck.makeTrimmed(0, f, false)!;
    const pt = cut.getPoint(cut.countPoints() - 1);
    cut.delete();
    ck.delete();
    return [pt[0], pt[1]];
  };
  for (const [name, sub, straight] of shapes) {
    const px = pxOf(sub);
    for (const f of [0.07, 0.23, 0.4, 0.61, 0.88]) {
      const rn = cutAt(subpathsToD([px]), f);
      const sides: ["arc" | "seg" | "arcLines", TrimMeasure, [number, number]][] = [["arc", "arc length", rn], ["seg", "segment", rn]];
      if (straight) sides.push(["arcLines", "arc length", cutAt(subpathsToLineD([px]), f)]);
      for (const [key, measure, ref] of sides) {
        const out = trimSubpaths([px], 0, f, 0, measure);
        const end = out[out.length - 1].anchors[out[out.length - 1].anchors.length - 1].pos;
        const d = Math.hypot(end[0] - ref[0], end[1] - ref[1]);
        if (d > worstBy[key][0]) worstBy[key] = [d, `${name} @${f}`];
      }
    }
  }
  const fmtW = (w: Worst) => `${w[0].toFixed(4)} px (${w[1]})`;
  check(
    `Trim Path (measure = arc length) cuts where React Native does (CanvasKit makeTrimmed on the emitted path data, ${shapes.length} shapes × 5 ends, within Skia's 0.5 px measure tolerance at 512 px)`,
    worstBy.arc[0] < 0.5,
    `worst ${fmtW(worstBy.arc)}`
  );
  check("…and exactly on the straight shapes once their edges are lines (L; within 0.01 px)", worstBy.arcLines[0] < 0.01, `worst ${fmtW(worstBy.arcLines)}`);
  check("…while the original segment measure does not (> 2 px off)", worstBy.seg[0] > 2, `worst ${fmtW(worstBy.seg)}`);
  console.log(`     cut vs React Native: arc length ${fmtW(worstBy.arc)}, as lines ${fmtW(worstBy.arcLines)}; segment ${fmtW(worstBy.seg)}`);
}
{
  // measure = segment has no RN form: the export refuses with the reason.
  const nodes = G.nodes.map((n) => (n.id === "tr3x" ? { ...n, params: { ...n.params, measure: "segment" } } : n));
  const r = await checkExportable({ nodes, edges: G.edges, canvasId: "tr3s", canvas: CANVAS, timeline: TIMELINE, slot: "paint-tr3s-segment" });
  check("Trim Path (Skia) measure = segment: the export is refused with the reason", !r.files && r.problems.some((p) => p.includes('measure "segment"')), r.problems.join(" | "));
}
{
  // Gradients: what Rasterize Spline hands Canvas2D, recorded.
  type Call = { kind: string; args: number[]; stops: [number, string][] };
  const calls: Call[] = [];
  const fake: GradientCanvas = {
    createLinearGradient: (...args: number[]) => rec("linear", args),
    createRadialGradient: (...args: number[]) => rec("radial", args),
    createConicGradient: (...args: number[]) => rec("conic", args),
  };
  function rec(kind: string, args: number[]): CanvasGradient {
    const c: Call = { kind, args, stops: [] };
    calls.push(c);
    return { addColorStop: (p: number, col: string) => void c.stops.push([p, col]) } as CanvasGradient;
  }
  const css = (s: string) => (/rgba?\(([^)]*)\)/.exec(s)?.[1] ?? "").split(",").map((x, i) => (i < 3 ? Number(x) / 255 : Number(x)));
  const lerpStops = (stops: [number, number[]][], u: number) => {
    if (u <= stops[0][0]) return stops[0][1];
    for (let i = 1; i < stops.length; i++) {
      if (u <= stops[i][0]) {
        const [p0, c0] = stops[i - 1];
        const [p1, c1] = stops[i];
        const t = p1 - p0 > 0 ? (u - p0) / (p1 - p0) : 1;
        return c0.map((x, k) => x + (c1[k] - x) * t);
      }
    }
    return stops[stops.length - 1][1];
  };
  const pairs: [string, string, SplineSubpath[]][] = [["g1", "linear", [fx.STAR]], ["g2", "radial", [fx.CIRCLE]], ["g3", "conic", fx.TWO_CIRCLES]];
  for (const [pair, kind, subs] of pairs) {
    calls.length = 0;
    const p = G.nodes.find((n) => n.id === `${pair}n`)!.params as Record<string, unknown>;
    const fn = makeSubpathGradientFn(
      fake,
      subs,
      {
        kind: p.gradient_kind as "linear",
        frame: p.gradient_frame as "shape",
        angleDeg: p.gradient_angle as number,
        scale: p.gradient_scale as number,
        offset: p.gradient_offset as number,
        stops: p.fill_ramp as never,
        interp: p.ramp_interp as "linear",
        space: p.ramp_space as "srgb",
        vary: p.gradient_vary as "none",
        varyAmount: p.gradient_vary_amount as number,
        seed: 0,
        varyAngleDeg: 0,
      },
      SIZE,
      SIZE
    );
    subs.forEach((s, i) => fn(i, s));
    const shaders = shapesOf(sceneAt(G.nodes, G.edges, `${pair}s`, 0)).map((s) => s.paint.shader as ShaderIR);
    let geo = 0;
    let col = 0;
    calls.forEach((c, i) => {
      const sh = shaders[i];
      const nat = c.stops.map(([q, s]) => [q, css(s)] as [number, number[]]);
      if (kind === "linear" && sh?.k === "linear") {
        geo = Math.max(geo, ...[sh.start[0].v, sh.start[1].v, sh.end[0].v, sh.end[1].v].map((v, k) => Math.abs(v - c.args[k])));
      } else if (kind === "radial" && sh?.k === "radial") {
        geo = Math.max(geo, Math.abs(sh.c[0].v - c.args[0]), Math.abs(sh.c[1].v - c.args[1]), Math.abs(sh.r.v - c.args[5]));
      } else if (kind === "conic" && sh?.k === "sweep") {
        geo = Math.max(geo, Math.abs(sh.c[0].v - c.args[1]), Math.abs(sh.c[1].v - c.args[2]));
      } else {
        geo = Infinity;
        return;
      }
      const mine = sh.stops.map((s) => [s.pos.v, s.color.v] as [number, number[]]);
      // Color at 97 points along the gradient parameter (conic: around the
      // circle, the canvas ramp starting at its start angle).
      for (let k = 0; k <= 96; k++) {
        // (Off the grid, so no sample lands exactly on a hard seam stop.)
        const u = (k + 0.37) / 97;
        const want = kind === "conic" ? lerpStops(nat, (((u - c.args[0] / (2 * Math.PI)) % 1) + 1) % 1) : lerpStops(nat, u);
        const got = lerpStops(mine, u);
        col = Math.max(col, ...want.map((x, j) => Math.abs(x - got[j])));
      }
    });
    check(`gradient ${pair} (${kind}): geometry is Rasterize Spline's Canvas2D gradient (within 0.01 px)`, calls.length === shaders.length && geo < 0.01, `${calls.length} vs ${shaders.length} gradients, max ${geo}`);
    check(`gradient ${pair} (${kind}): the stops reproduce its ramp at every point${kind === "conic" ? " (rotated sweep)" : ""}`, col < 1e-6, `max ${col}`);
  }
}

// ---- 3. text layout constants are measured truths ----------------------------------------------
{
  for (const face of Object.values(SKIA_FONTS)) {
    const buf = Buffer.from(fontBytes[face.asset.id]);
    const n = buf.readUInt16BE(4);
    const tables: Record<string, number> = {};
    for (let i = 0; i < n; i++) tables[buf.toString("ascii", 12 + i * 16, 16 + i * 16)] = buf.readUInt32BE(12 + i * 16 + 8);
    const upem = buf.readUInt16BE(tables.head + 18);
    const hAsc = buf.readInt16BE(tables.hhea + 4);
    const hDesc = -buf.readInt16BE(tables.hhea + 6);
    const os2 = tables["OS/2"];
    const tAsc = buf.readInt16BE(os2 + 68);
    const tDesc = -buf.readInt16BE(os2 + 70);
    const useTypo = (buf.readUInt16BE(os2 + 62) & 0x80) !== 0;
    check(
      `${face.family}: the metrics table is the file's (upem ${upem}, typo ${tAsc}/${tDesc}, hhea == typo, USE_TYPO_METRICS)`,
      upem === face.unitsPerEm && tAsc === face.ascender && tDesc === face.descender && hAsc === tAsc && hDesc === tDesc && useTypo
    );
    const tf = CK.Typeface.MakeFreeTypeFaceFromData(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    check(`${face.family}: the bundled file loads as that typeface in CanvasKit`, !!tf && tf.getFamilyName() === face.family, tf?.getFamilyName());
    tf?.delete();
  }
  // Chromium's TextMetrics.alphabeticBaseline under textBaseline "middle",
  // measured in Electron (Chromium 140) for the bundled files.
  const measured: [string, number, number][] = [
    ["Geist", 37, 10.109375], ["Geist", 64, 17.484375], ["Geist", 96, 26.21875],
    ["Inter", 37, 11.125], ["Inter", 64, 19.234375], ["Inter", 96, 28.859375],
  ];
  for (const [fam, size, want] of measured) {
    const got = canvasMiddleToAlphabetic(SKIA_FONTS[fam], size);
    check(`${fam} ${size}px: middle → alphabetic baseline = Chromium's ${want}`, got === want, `${got}`);
  }
  // SkParagraph's line box, read back from CanvasKit.
  let worst = 0;
  let bad = "";
  for (const face of Object.values(SKIA_FONTS)) {
    const bytes = fontBytes[face.asset.id];
    const prov = CK.TypefaceFontProvider.Make();
    prov.registerFont(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, "f");
    for (const size of [12, 37, 40, 48, 64, 72, 96, 133.5]) {
      const b = CK.ParagraphBuilder.MakeFromFontProvider(new CK.ParagraphStyle({ textStyle: { fontFamilies: ["f"], fontSize: size } }), prov);
      b.addText("Hg\nHg");
      const para = b.build();
      para.layout(10000);
      const lm = para.getLineMetrics();
      const box = paragraphLineBox(face, size);
      const d = Math.max(Math.abs(lm[0].baseline - box.baseline), Math.abs(lm[1].baseline - lm[0].baseline - box.height));
      if (d > worst) {
        worst = d;
        bad = `${face.family} ${size}px: ${lm[0].baseline}/${lm[1].baseline - lm[0].baseline} vs ${box.baseline}/${box.height}`;
      }
      para.delete();
      b.delete();
    }
    prov.delete();
  }
  check("paragraphLineBox = CanvasKit SkParagraph's first baseline and line pitch (both fonts, 8 sizes, within 0.001 px)", worst < 1e-3, bad);
}

// ---- 4. CanvasKit draws what the IR means ---------------------------------------------------------
{
  const rTrim = (f: number) => render(sceneAt(G.nodes, G.edges, "tr1s", f));
  const full = render(sceneAt(G.nodes, G.edges, "s1s", 0));
  void full;
  const t0 = rTrim(0);
  const t24 = rTrim(24);
  const t40 = rTrim(40);
  check("trim renders with no problems", [t0, t24, t40].every((r) => !r.problems.length), [...t0.problems, ...t24.problems].join(" | "));
  const end24 = (() => {
    let v = NaN;
    walk(sceneAt(G.nodes, G.edges, "tr1s", 24).root, (n) => {
      if (n.k === "shape" && Number.isNaN(v)) {
        const t = n.paint.pathEffects?.find((e) => e.k === "trim");
        if (t?.k === "trim") v = t.end.v;
      }
    });
    return v;
  })();
  const share = inkCount(t24) / inkCount(t40);
  check(`trim: ink grows with the window (f0 < f24 < f40) and f24 shows ≈ its end ${end24.toFixed(3)} of the outline`, inkCount(t0) < inkCount(t24) && inkCount(t24) < inkCount(t40) && Math.abs(share - end24) < 0.04, `share ${share.toFixed(3)}`);
  // The wrapped remainder: offset 0.75 at frame 45 → [0.75, 1] + [0, 0.15].
  const w45 = render(sceneAt(G.nodes, G.edges, "tr2s", 45));
  const top = P(0.5, 0.2);
  const bottom = P(0.5, 0.8);
  const upperRight = P(0.5 + 0.3 * Math.cos(-Math.PI / 6) * 0.9, 0.5 + 0.3 * Math.sin(-Math.PI / 6) * 0.9 - 0.05);
  check("trim offset: the window wraps — both sides of the path start draw, the far side doesn't", inked(w45, top[0] + 20, top[1] + 10) && inked(w45, top[0] - 20, top[1] + 10) && !inked(w45, ...bottom), `${at(w45, top[0] + 20, top[1] + 10)} ${at(w45, top[0] - 20, top[1] + 10)} ${at(w45, ...bottom)}`);
  void upperRight;

  // Corners: the star's top tip is ink when sharp, empty once rounded.
  const sharp = render(sceneAt(G.nodes, G.edges, "s1s", 0));
  const tip = P(0.5, 0.5 - 0.36);
  const fil = render(sceneAt(G.nodes, G.edges, "rc1s", 0));
  const cor = render(sceneAt(G.nodes, G.edges, "rc2s", 0));
  check("round corners: fillet and corner effect both clear the sharp tip", inked(sharp, tip[0], tip[1] + 2) && !inked(fil, tip[0], tip[1] + 2) && !inked(cor, tip[0], tip[1] + 2));
  check("round corners: render with no problems", !fil.problems.length && !cor.problems.length, [...fil.problems, ...cor.problems].join(" | "));
  const corInk = inkCount(cor) / inkCount(fil);
  check("round corners: the corner effect's quadratic corners are close to the fillet's arcs (ink within 6 %)", Math.abs(corInk - 1) < 0.06, corInk.toFixed(3));

  // Dash (Skia) over a solid stroke == Stroke (Skia) dashed, pixel for pixel.
  const s2 = render(sceneAt(G.nodes, G.edges, "s2s", 0));
  const d1 = render(sceneAt(G.nodes, G.edges, "d1s", 0));
  let same = s2.px.length === d1.px.length;
  for (let i = 0; i < s2.px.length && same; i++) same = s2.px[i] === d1.px[i];
  check("dash: Dash (Skia) is pixel-identical to Stroke (Skia)'s own dashes", same && inkCount(s2) > 1000);
  // Along the hexagon's first edge (top vertex → upper right): 24 on, 12 off.
  const a0 = P(0.5, 0.2);
  const a1 = P(0.5 + 0.3 * Math.cos(-Math.PI / 6), 0.5 + 0.3 * Math.sin(-Math.PI / 6));
  const edgeLen = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]);
  const onAt = (dist: number) => inked(s2, a0[0] + ((a1[0] - a0[0]) * dist) / edgeLen, a0[1] + ((a1[1] - a0[1]) * dist) / edgeLen);
  check("dash: 24 px on, 12 px off from the path start", onAt(6) && onAt(18) && !onAt(30) && onAt(42) && !onAt(66), [6, 18, 30, 42, 66].map(onAt).join(","));
  // Dots: one blob per spacing around the circle.
  const dots = render(sceneAt(G.nodes, G.edges, "s3s", 0));
  let blobs = 0;
  let prev = false;
  const N = 2000;
  let firstOn = false;
  for (let k = 0; k < N; k++) {
    const a = -Math.PI / 2 + (k / N) * 2 * Math.PI;
    const on = inked(dots, 256 + Math.cos(a) * 153.6, 256 + Math.sin(a) * 153.6);
    if (k === 0) firstOn = on;
    if (on && !prev) blobs++;
    prev = on;
  }
  if (firstOn && prev) blobs--; // the run across the start
  const expectDots = Math.ceil((2 * Math.PI * 153.6) / 22);
  check(`dotted: ${expectDots} dots around the circle (round caps on zero-length dashes)`, Math.abs(blobs - expectDots) <= 1, `${blobs}`);

  // Gradient: the radial's center is the ramp's start color.
  const g2 = render(sceneAt(G.nodes, G.edges, "g2s", 0));
  const c = at(g2, 256, 256);
  check("gradient: the radial center carries the ramp's first stop (#ff5f6d)", Math.abs(c[0] - 0xff) <= 2 && Math.abs(c[1] - 0x5f) <= 2 && Math.abs(c[2] - 0x6d) <= 2 && c[3] === 255, `${c}`);
  const g1 = render(sceneAt(G.nodes, G.edges, "g1s", 0));
  check("gradient: renders with no problems", !g1.problems.length && !g2.problems.length, [...g1.problems, ...g2.problems].join(" | "));

  // Text: the paragraph wraps inside its box; paragraph shaping kerns.
  const t3 = render(sceneAt(G.nodes, G.edges, "t3s", 0));
  const box3 = inkBox(t3);
  const bw = 0.62 * SIZE;
  check("paragraph: wraps into several lines inside the box width", !t3.problems.length && box3.bands >= 4 && box3.x0 >= SIZE / 2 - bw / 2 - 1 && box3.x1 <= SIZE / 2 + bw / 2 + 1, JSON.stringify(box3));
  const t1 = render(sceneAt(G.nodes, G.edges, "t1s", 0));
  const t1l = render(sceneAt(G.nodes, G.edges, "t1ls", 0));
  const w1 = inkBox(t1);
  const wl = inkBox(t1l);
  check("text: paragraph and simple runs both draw the bundled font", !t1.problems.length && !t1l.problems.length && inkCount(t1) > 2000 && inkCount(t1l) > 2000);
  check("text: simple runs (no kerning) run wider than the kerned paragraph", wl.x1 - wl.x0 - (w1.x1 - w1.x0) >= 3, `${w1.x1 - w1.x0} vs ${wl.x1 - wl.x0}`);
  check("text: one line centered on the canvas (ink center within 2 px)", Math.abs((w1.x0 + w1.x1) / 2 - SIZE / 2) <= 2, JSON.stringify(w1));
}

// ---- 5. Paragraph under a translucent group --------------------------------------------
{
  const r = await checkExportable({ nodes: G.nodes, edges: G.edges, canvasId: "t4s", canvas: CANVAS, timeline: TIMELINE, slot: "paint-t4" });
  const tsx = r.files?.["ToolboxScene.tsx"] ?? "";
  const call = /makeTextPicture\(FONTS[^\n]*\)/.exec(tsx)?.[0] ?? "";
  check("Paragraph: the enclosing group's opacity is folded into the run (RN paints it with its own paint)", /Math\.min\(1, Math\.max\(0, Math\.min\(1, Math\.max\(0, 1 \* 0\.5\)\) \* 1\)\), BlendMode\.SrcOver\)$/.test(call), call);
  const plain = await checkExportable({ nodes: G.nodes, edges: G.edges, canvasId: "t1s", canvas: CANVAS, timeline: TIMELINE, slot: "paint-t1" });
  const plainCall = /makeTextPicture\(FONTS[^\n]*\)/.exec(plain.files?.["ToolboxScene.tsx"] ?? "")?.[0] ?? "";
  check("Paragraph: without an enclosing opacity the run keeps its own opacity untouched", /, 1, BlendMode\.SrcOver\)$/.test(plainCall), plainCall);
}

if (failures) {
  console.error(`\ncheck-skia-paint: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncheck-skia-paint: all checks passed.");
