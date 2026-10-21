// Text calibration (spec §4.7, M4 text lane; results specdocs/ae-m4/text.md):
// toolbox's Text node rendered by the real engine (tbx-render) against the
// SAME graph exported by the scene walk and built by the real build.jsx in
// After Effects (headless aerender, under the AE lock). Measured glyph by
// glyph (text-glyphs.mts): each case renders a run of separated Arial "I"s,
// and the animated quantity — alpha, scale, offset, angle, spacing, colour —
// is read per glyph against a static reference render of the same layout in
// the same renderer, so the two renderers' glyph metrics cancel and what is
// left is the selector shape (and pivot / units) error.
//
//   npx tsx scripts/ae-export-spike/calibrate/text.mts [filter…] [--work DIR] [--no-ae] [--reuse]
//
// --reuse re-measures the renders already in --work DIR (no launches).
//
// Cases: every animator prop × direction × based-on (cascade, linear), the
// easing routes (exact Ease High / Low, a fitted one, Expression Selector),
// uniform drivers, the min / max branches (a base animator), text on an arc
// (align × offset × side × flip), keyed documents (font size, text) and a
// keyed fill colour. Writes calibrate/measured/text.json.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry } from "../../ae-export/harness.mts";
import { GraphBuilder, track } from "../../fixtures/ae-export/graphs/fixtures.mts";
import { HERE, REPO, readAeFrame, renderQueue, renderedFile, runAeJob } from "./ae.mts";
import { readF32, renderTbx, savePng, type FloatImage } from "./lib.mts";
import { allStats, glyphBlobs, glyphCells, recordJson, type Cell, type GlyphStats } from "./text-glyphs.mts";
import type { TbxRender } from "./tbx-page";

/* eslint-disable @typescript-eslint/no-explicit-any */

const args = process.argv.slice(2);
const wi = args.indexOf("--work");
const WORK = wi >= 0 ? args[wi + 1] : join(tmpdir(), `toolbox-ae-text-${Date.now()}`);
const noAe = args.includes("--no-ae");
const filters = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--work");
mkdirSync(WORK, { recursive: true });
console.log(`work: ${WORK}`);

await loadRegistry();
const { getNodeDef } = await import("@/engine/registry");
const { makeInstanceNode, makeLayerNodes } = await import("@/state/graph-ops");
const { buildAeSceneForEditor } = await import("@/lib/ae-export/scene");
const { validateAeScene } = await import("@/lib/ae-export/runtime/validate");
const { parseAnimators, resolveGlyphAnim, resolveTrackingExtra, wordIndices } = await import("@/engine/text-animators");

const W = 1000;
const H = 300;
const FPS = 30;
const FRAMES = 30;
const SWEEP = track([[0, 0], [24, 1]]);
const SAMPLE = [3, 7, 11, 15, 19];
const CHARS = "IIIIIIIIII";
const WORDS = "II II II II";
const BASE = { font_family: "Arial", font_size: 40, letter_spacing: 60, color: "#ffffff", alignment: "center" };

type Prop = "typeon" | "opacity" | "position" | "scale" | "rotation" | "tracking" | "color";
interface Case {
  name: string;
  ref: string;
  prop?: Prop;
  params: Record<string, unknown>;
  animation?: Record<string, unknown>;
  path?: { type: string; params: Record<string, unknown> };
  frames: number[];
  // What the case measures.
  measure: "anim" | "path" | "doc" | "color" | "metric";
}

const PROP_PARAMS: Record<Prop, Record<string, unknown>> = {
  typeon: {},
  opacity: { anim_opacity_min: 0.2, anim_opacity_max: 1 },
  position: { anim_position_minY: 0, anim_position_maxY: -40 },
  scale: { anim_scale_min: 0.4, anim_scale_max: 1.6 },
  rotation: { anim_rotation_min: 0, anim_rotation_max: 60 },
  tracking: { anim_tracking_min: 0, anim_tracking_max: 30 },
  color: { anim_color_min: "#ff0000", anim_color_max: "#0000ff" },
};
const DIRS = ["forward", "backward", "center", "edges", "random"];
const ARC = { type: "arc", params: { centerX: 0.5, centerY: 0.5 + (480 - H / 2) / W, radius: 420 / W, startAngle: 215, endAngle: 325, mode: "open", stroke_enabled: false } };

// References: the same layout through toolbox's per-glyph draw path (an
// identity opacity animator), and ref_fastpath through its plain one. Both
// paths, like AE, centre a line without the letter spacing after its last
// glyph (until 2026-10-21 the plain path kept it and sat spacing / 2 left).
const IDENTITY = { anim_opacity_enabled: true, anim_opacity_min: 1, anim_opacity_max: 1 };
const CASES: Case[] = [
  { name: "ref_chars", ref: "ref_chars", params: { text: CHARS, ...IDENTITY }, frames: [0], measure: "anim" },
  { name: "ref_words", ref: "ref_words", params: { text: WORDS, ...IDENTITY }, frames: [0], measure: "anim" },
  { name: "ref_fastpath", ref: "ref_fastpath", params: { text: CHARS }, frames: [0], measure: "doc" },
];
const anim = (prop: Prop, extra: Record<string, unknown>, opts: { words?: boolean; driver?: string; name?: string } = {}): Case => {
  const p = `anim_${prop}`;
  return {
    name: opts.name ?? `${prop}_${extra[`${p}_direction`] ?? "forward"}${opts.words ? "_w" : ""}`,
    ref: opts.words ? "ref_words" : "ref_chars",
    prop,
    params: { text: opts.words ? WORDS : CHARS, [`${p}_enabled`]: true, ...(prop === "typeon" ? {} : { [`${p}_driver`]: opts.driver ?? "cascade" }), ...(opts.words ? { [`${p}_by`]: "word" } : {}), ...PROP_PARAMS[prop], ...extra },
    animation: { [`${p}_amount`]: SWEEP },
    frames: SAMPLE,
    measure: "anim",
  };
};
for (const prop of Object.keys(PROP_PARAMS) as Prop[])
  for (const dir of DIRS)
    for (const words of [false, true]) CASES.push(anim(prop, { [`anim_${prop}_direction`]: dir, [`anim_${prop}_seed`]: dir === "random" ? 7 : 0 }, { words }));
// Easing routes.
CASES.push(
  anim("rotation", { anim_rotation_easing: "smoothstep" }, { name: "ease_smoothstep_rotation" }),
  anim("opacity", { anim_opacity_easing: "ease-in-out-sine" }, { name: "ease_sine_opacity" }),
  anim("typeon", { anim_typeon_easing: "ease-in-quad" }, { name: "ease_quad_typeon" }),
  anim("position", { anim_position_easing: "ease-out-back" }, { name: "ease_back_position" }),
  anim("scale", { anim_scale_easing: "ease-in-cubic", anim_scale_direction: "center" }, { name: "ease_cubic_scale_center" }),
  anim("typeon", { anim_typeon_easing: "ease-out-bounce", anim_typeon_softness: 0.6 }, { name: "ease_bounce_typeon" }),
  anim("opacity", { anim_opacity_softness: 0.9 }, { name: "soft09_opacity" }),
  anim("opacity", { anim_opacity_softness: 0.05 }, { name: "soft005_opacity" }),
  // Uniform drivers.
  anim("opacity", {}, { name: "uniform_opacity", driver: "uniform" }),
  anim("position", { anim_position_easing: "ease-in-out-cubic" }, { name: "uniform_eased_position", driver: "uniform" }),
  // min / max branches: a base animator.
  anim("opacity", { anim_opacity_min: 0.2, anim_opacity_max: 0.6 }, { name: "base_opacity" }),
  anim("position", { anim_position_minX: 10, anim_position_maxX: -10, anim_position_minY: 0, anim_position_maxY: -30 }, { name: "base_position" }),
  anim("scale", { anim_scale_min: 0, anim_scale_max: 1, anim_scale_direction: "center" }, { name: "zero_scale" }),
  anim("rotation", { anim_rotation_min: -20, anim_rotation_max: 40 }, { name: "base_rotation" }),
  anim("color", { anim_color_min: "#ffffff", anim_color_max: "#00ff00" }, { name: "rest_color" }),
);
// Text on an arc (no animator), and one with a rotation animator.
const pathCase = (name: string, extra: Record<string, unknown>, more: Partial<Case> = {}): Case => ({
  name,
  ref: name,
  params: { text: "IIIIIIIIII", letter_spacing: 20, path_align: "center", ...extra },
  path: ARC,
  frames: [0],
  measure: "path",
  ...more,
});
CASES.push(
  pathCase("path_center", {}),
  pathCase("path_start", { path_align: "start" }),
  pathCase("path_end", { path_align: "end" }),
  pathCase("path_start_off", { path_align: "start", path_offset: 0.15 }),
  pathCase("path_center_off", { path_offset: 0.1 }),
  pathCase("path_above", { path_side: "above" }),
  pathCase("path_below", { path_side: "below" }),
  pathCase("path_flip", { path_flip: true }),
  pathCase("path_rot", { anim_rotation_enabled: true, anim_rotation_driver: "cascade", anim_rotation_max: 40 }, { animation: { anim_rotation_amount: SWEEP }, frames: [11] })
);
// Keyed documents and a keyed fill colour.
CASES.push(
  { name: "doc_size", ref: "doc_size", params: { text: "IIIIII", letter_spacing: 30 }, animation: { font_size: track([[0, 32], [24, 72]]) }, frames: [0, 12, 24], measure: "doc" },
  { name: "doc_weight", ref: "doc_weight", params: { text: "IIIIII", letter_spacing: 30 }, animation: { font_weight: track([[0, 400], [24, 700]]) }, frames: [6, 18], measure: "doc" },
  { name: "doc_color", ref: "doc_color", params: { text: CHARS }, animation: { color: track([[0, "#ff0000"], [24, "#0000ff"]]) }, frames: [0, 12, 24], measure: "color" }
);

// Font metrics: toolbox's canvas "middle" baseline and AE's first box
// baseline per family (one line of "HHH" at 120 px; an H sits on the
// baseline). Inter is not installed for AE here (AE substitutes): its AE
// numbers are not Inter's.
const METRIC_FONTS = ["Arial", "Helvetica", "Times New Roman", "Courier New", "Georgia", "Menlo", "Inter"];
for (const font of METRIC_FONTS)
  CASES.push({ name: `metric_${font.replace(/\s+/g, "")}`, ref: "", params: { text: "HHH", font_family: font, font_size: 120, letter_spacing: 0 }, frames: [0], measure: "metric" as Case["measure"] });

const cases = CASES.filter((c) => !filters.length || c.name.startsWith("ref_") || filters.some((f) => c.name.includes(f)));

const defaults = (type: string) => Object.fromEntries((getNodeDef(type)?.params ?? []).map((p: any) => [p.name, p.default]));

// --- the two graphs of a case ------------------------------------------------------------

function editorGraph(c: Case) {
  const g = new GraphBuilder({ makeInstanceNode, makeLayerNodes });
  const L = g.layer("L", c.name);
  g.node(L, "t", "text", { ...BASE, ...c.params }, c.animation);
  if (c.path) {
    g.node(L, "p", c.path.type, c.path.params);
    g.wire("p:out", "t:in:path");
  }
  g.out(L, "t:out");
  return { nodes: g.nodes, edges: g.edges };
}

function tbxRender(c: Case): TbxRender {
  const nodes: any[] = [{ id: "t", type: "text", params: { ...defaults("text"), ...BASE, ...c.params }, animation: c.animation }];
  const edges: any[] = [];
  if (c.path) {
    nodes.push({ id: "p", type: c.path.type, params: { ...defaults(c.path.type), ...c.path.params } });
    edges.push({ id: "e0", source: "p", sourceHandle: "out:primary", target: "t", targetHandle: "in:path" });
  }
  return { id: c.name, nodes, edges, target: "t", frames: c.frames };
}

// --- AE: one merged scene ------------------------------------------------------------------

function prefixScene(scene: any, pre: string) {
  const ids = new Set<string>();
  for (const cp of scene.comps) for (const l of cp.layers) ids.add(l.id);
  const P = (s: string) => `${pre}/${s}`;
  for (const cp of scene.comps) {
    cp.id = P(cp.id);
    for (const l of cp.layers) {
      l.id = P(l.id);
      if (l.parent) l.parent = P(l.parent);
      if (l.matte) l.matte.layer = P(l.matte.layer);
      if (l.source) l.source = P(l.source);
      for (const fx of l.effects ?? []) for (const v of Object.values(fx.props ?? {})) if ((v as any)?.layerRef) (v as any).layerRef = P((v as any).layerRef);
    }
  }
  for (const f of scene.footage) f.id = P(f.id);
  scene.main = P(scene.main);
}

const merged: any = { comps: [], footage: [], presets: [] };
const built = new Map<string, any>();
for (const c of cases) {
  const { nodes, edges } = editorGraph(c);
  const b = buildAeSceneForEditor(nodes as any, edges as any, {
    env: { composition: { id: `comp-${c.name}`, name: c.name, width: W, height: H, fps: FPS, durationFrames: FRAMES } },
    name: c.name,
    toolboxVersion: "calibration",
    generatedAt: "2026-10-21T00:00:00.000Z",
  });
  if (b.problems.length) throw new Error(`${c.name}: ${b.problems.join("; ")}`);
  if (b.bakes.length) console.log(`  ${c.name}: bakes (${b.bakes.map((k) => k.reason).join("; ")}) — measured anyway`);
  const s = JSON.parse(JSON.stringify(b.scene));
  prefixScene(s, c.name);
  const main = s.comps.find((x: any) => x.id === s.main);
  main.name = c.name;
  for (const cp of s.comps) if (cp !== main) cp.name = `${c.name} · ${cp.name}`;
  built.set(c.name, { scene: b.scene, report: b.scene.report });
  if (!merged.schemaVersion) Object.assign(merged, { schemaVersion: s.schemaVersion, generatedAt: s.generatedAt, toolboxVersion: s.toolboxVersion, project: s.project, main: s.main, report: s.report });
  merged.comps.push(...s.comps);
  merged.footage.push(...s.footage);
}
const vp = validateAeScene(merged);
if (vp.length) throw new Error(`merged scene invalid: ${vp.slice(0, 5).join("; ")}`);
console.log(`${cases.length} cases, ${merged.comps.length} comps`);

// --- render both ----------------------------------------------------------------------------

// --reuse: measure the renders already in WORK (no toolbox or AE launch).
const reuse = args.includes("--reuse");
const tbx = reuse ? readTbxRenders() : await renderTbx("text", { width: W, height: H }, [], cases.map(tbxRender), WORK, FPS);
const ae = new Map<string, FloatImage>();
if (reuse) {
  const renders = join(WORK, "ae-renders");
  for (const c of cases)
    for (const f of c.frames) {
      const file = renderedFile(renders, `${c.name}_f${f}`);
      if (file) ae.set(`${c.name}_f${f}`, await readAeFrame(file));
    }
} else if (!noAe) {
  const pkg = join(WORK, "text.aepkg");
  const renders = join(WORK, "ae-renders");
  mkdirSync(renders, { recursive: true });
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "scene.json"), JSON.stringify(merged));
  copyFileSync(join(REPO, "src/lib/ae-export/runtime/build.jsx"), join(pkg, "build.jsx"));
  const project = join(pkg, "text.aep");
  // A launch now and then never reaches the startup hook (seen right after
  // another checkout's aerender run): no job JSON, aerender exit 0. Retry.
  let job: Awaited<ReturnType<typeof runAeJob>> | undefined;
  for (let attempt = 1; !job; attempt++) {
    try {
      job = await runAeJob("text-build", "text-build.jsx", { pkg, project, renders, comps: cases.map((c) => ({ name: c.name, frames: c.frames })) }, WORK);
    } catch (e) {
      if (attempt >= 3 || !/wrote no/.test(String(e))) throw e;
      console.log(`  AE launch ${attempt} ran no job (${String(e).slice(0, 80)}…) — retrying`);
    }
  }
  const bd = job.out.build;
  console.log(`  AE build ${job.seconds.toFixed(1)} s: ok ${bd?.ok}, ${bd?.problems?.length ?? "?"} problem(s), ${bd?.warnings?.length ?? 0} warning(s), ${job.out.queued} frames queued`);
  for (const p of bd?.problems ?? []) console.log(`  ! ${p}`);
  for (const w of (bd?.warnings ?? []).slice(0, 8)) console.log(`  ~ ${w}`);
  for (const e of job.out.errors ?? []) console.log(`  ! ${e}`);
  const rq = await renderQueue(project, WORK);
  console.log(`  AE render ${rq.seconds.toFixed(1)} s (exit ${rq.code})`);
  for (const c of cases)
    for (const f of c.frames) {
      const file = renderedFile(renders, `${c.name}_f${f}`);
      if (file) ae.set(`${c.name}_f${f}`, await readAeFrame(file));
      else console.log(`  AE: no render for ${c.name} f${f}`);
    }
  writeFileSync(join(WORK, "ae-build.json"), JSON.stringify(job.out, null, 1));
}

function readTbxRenders(): Map<string, FloatImage> {
  const out = new Map<string, FloatImage>();
  const done: { id: string; frame: number; file?: string }[] = JSON.parse(readFileSync(join(WORK, "text-tbx", "out", "done.json"), "utf8"));
  for (const d of done) if (d.file) out.set(`${d.id}_f${d.frame}`, readF32(d.file, W, H));
  return out;
}

// --- measure --------------------------------------------------------------------------------

const visible = (text: string) => Array.from(text).flatMap((ch, i) => (/\s/.test(ch) ? [] : [i]));
const wrap90 = (a: number) => {
  let d = a;
  while (d > 90) d -= 180;
  while (d <= -90) d += 180;
  return d;
};

// The engine's value per visible glyph at frame f (the toolbox model).
function engineValues(c: Case, f: number): number[][] {
  const params = { ...defaults("text"), ...BASE, ...c.params };
  const a = Math.min(1, Math.max(0, f / 24));
  params[`anim_${c.prop}_amount`] = a;
  const A = parseAnimators(params);
  const text = String(params.text);
  const chars = Array.from(text);
  const words = wordIndices([chars]);
  const gi = (i: number) => ({ char: i, charTotal: chars.length, word: words.ids[0][i], wordTotal: words.total });
  const vis = visible(text);
  const tr = chars.map((_, i) => resolveTrackingExtra(A, gi(i)));
  const shift = (i: number) => tr.slice(0, i).reduce((s, x) => s + x, 0) - tr.slice(0, chars.length - 1).reduce((s, x) => s + x, 0) / 2;
  return vis.map((i) => {
    const g = resolveGlyphAnim(A, gi(i), {});
    switch (c.prop) {
      case "typeon":
      case "opacity":
        return [g.alpha];
      case "position":
        return [g.offsetX + g.word.offsetX, g.offsetY + g.word.offsetY];
      case "scale":
        return [g.scale * g.word.scale];
      case "rotation":
        return [((g.rotation + g.word.rotation) * 180) / Math.PI];
      case "tracking":
        return [shift(i)];
      case "color": {
        const m = /rgb\((\d+), (\d+), (\d+)\)/.exec(g.color ?? "");
        return m ? [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255] : [1, 1, 1];
      }
    }
    return [];
  });
}

// The renderer's value per glyph against its own reference.
function measured(c: Case, img: FloatImage, ref: GlyphStats[], refCells: Cell[]): number[][] | null {
  const own = c.prop === "tracking" ? glyphCellsSafe(img, refCells.length) : refCells;
  if (!own) return null;
  const st = allStats(img, own);
  return st.map((g, i) => {
    const r = ref[i];
    switch (c.prop) {
      case "typeon":
      case "opacity":
        return [g.mass / r.mass];
      case "position":
        return [g.cx - r.cx, g.cy - r.cy];
      case "scale":
        // A glyph scaled to nothing has no spread.
        return [g.mass < 1e-3 * r.mass ? 0 : g.spread / r.spread];
      case "rotation":
        return [wrap90(g.angle - r.angle)];
      case "tracking":
        return [g.cx - r.cx];
      case "color":
        return g.rgb;
    }
    return [];
  });
}

function glyphCellsSafe(img: FloatImage, n?: number): Cell[] | null {
  try {
    return glyphCells(img, n);
  } catch {
    return null;
  }
}

const RANGE: Record<Prop, number> = { typeon: 1, opacity: 0.8, position: 40, scale: 1.2, rotation: 60, tracking: 30, color: 1 };
const results: Record<string, any> = {};
const refStats = (renderer: Map<string, FloatImage>, ref: string) => {
  const img = renderer.get(`${ref}_f0`);
  if (!img) return null;
  const cells = glyphCellsSafe(img, visible(String(cases.find((x) => x.name === ref)!.params.text)).length);
  return cells ? { cells, stats: allStats(img, cells) } : null;
};
const tbxRefs = new Map<string, ReturnType<typeof refStats>>();
const aeRefs = new Map<string, ReturnType<typeof refStats>>();
for (const r of ["ref_chars", "ref_words"]) {
  tbxRefs.set(r, refStats(tbx, r));
  aeRefs.set(r, refStats(ae, r));
}
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const maxAbs = (a: number[][], b: number[][]) => {
  let m = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) for (let k = 0; k < a[i].length; k++) m = Math.max(m, Math.abs(a[i][k] - b[i][k]));
  return m;
};

for (const c of cases) {
  if (c.name.startsWith("ref_")) continue;
  const rep = built.get(c.name)?.report;
  const line = [...(rep?.approx ?? []), ...(rep?.native ?? [])].find((x: any) => x.type === "text");
  const out: any = { route: line?.fidelity, note: line?.note?.split(" · ").filter((s: string) => !s.startsWith("Text layer (TextDocument)") && /animator|path|Source Text|Fill Color/.test(s)) };
  if (c.measure === "anim") {
    const tr = tbxRefs.get(c.ref);
    const ar = aeRefs.get(c.ref);
    const frames: any[] = [];
    let eTbx = 0;
    let eAe = 0;
    let eModel = 0;
    for (const f of c.frames) {
      const ti = tbx.get(`${c.name}_f${f}`);
      const ai = ae.get(`${c.name}_f${f}`);
      const model = engineValues(c, f);
      const tv = ti && tr ? measured(c, ti, tr.stats, tr.cells) : null;
      const av = ai && ar ? measured(c, ai, ar.stats, ar.cells) : null;
      if (tv) eModel = Math.max(eModel, maxAbs(tv, model));
      if (av) eAe = Math.max(eAe, maxAbs(av, model));
      if (tv && av) eTbx = Math.max(eTbx, maxAbs(av, tv));
      frames.push({ f, model: model.map((v) => v.map(r4)), tbx: tv?.map((v) => v.map(r4)), ae: av?.map((v) => v.map(r4)) });
    }
    const R = RANGE[c.prop!];
    Object.assign(out, { prop: c.prop, range: R, aeVsTbx: r4(eTbx), aeVsModel: r4(eAe), tbxVsModel: r4(eModel), aeVsTbxPct: r4((100 * eTbx) / R), aeVsModelPct: r4((100 * eAe) / R), frames });
  } else if (c.measure === "metric") {
    const size = Number(c.params.font_size);
    const ink = (img?: FloatImage) => {
      const st = img ? glyphBlobs(img) : [];
      return st.length ? { base: Math.max(...st.map((g) => g.by1)), top: Math.min(...st.map((g) => g.by0)), n: st.length } : null;
    };
    const t = ink(tbx.get(`${c.name}_f0`));
    const a = ink(ae.get(`${c.name}_f0`));
    const doc: any = (() => {
      const L = built.get(c.name)?.scene.comps.flatMap((x: any) => x.layers).find((l: any) => l.kind === "text");
      return L?.text?.document?.v;
    })();
    const boxTop = doc?.box?.position?.[1];
    Object.assign(out, {
      measure: "metric",
      font: c.params.font_family,
      size,
      // Toolbox: the line's middle is the canvas centre; its baseline that far below.
      middleEm: t ? r4((t.base - H / 2) / size) : null,
      capEmTbx: t ? r4((t.base - t.top) / size) : null,
      // AE: the first baseline below the box top the scene wrote.
      firstBaselineEm: a && boxTop !== undefined ? r4((a.base - boxTop) / size) : null,
      capEmAe: a ? r4((a.base - a.top) / size) : null,
      baselineDeltaPx: t && a ? r4(a.base - t.base) : null,
    });
  } else {
    // Path / doc / color: per-frame glyph runs side by side.
    const frames: any[] = [];
    for (const f of c.frames) {
      const ti = tbx.get(`${c.name}_f${f}`);
      const ai = ae.get(`${c.name}_f${f}`);
      const run = (img?: FloatImage) => {
        if (!img) return null;
        const st = glyphBlobs(img).sort((a, b) => a.cx - b.cx);
        const mass = st.reduce((s, g) => s + g.mass, 0);
        return { n: st.length, cx: st.map((g) => r4(g.cx)), cy: st.map((g) => r4(g.cy)), angle: st.map((g) => r4(g.angle)), mass: r4(mass), rgb: st[0]?.rgb.map(r4), height: st.length ? Math.max(...st.map((g) => g.by1 - g.by0)) : 0 };
      };
      const t = run(ti);
      const a = run(ai);
      const d: any = { f, tbx: t, ae: a };
      if (t && a && t.n === a.n) {
        // Glyphs matched in x order (both runs read left to right, or both reversed).
        d.dPos = r4(Math.max(...t.cx.map((x, i) => Math.hypot(x - a.cx[i], t.cy[i] - a.cy[i]))));
        d.meanPos = r4(t.cx.reduce((s, x, i) => s + Math.hypot(x - a.cx[i], t.cy[i] - a.cy[i]), 0) / t.n);
        d.dAngle = r4(Math.max(...t.angle.map((x, i) => Math.abs(wrap90(x - a.angle[i])))));
        // Along the glyph's own axes: an "I"'s major axis is its up, normal
        // to the path (side / baseline error); across it runs along the path
        // (margin / advance error). Signed by the toolbox glyph's axis.
        // The axis is ±180° ambiguous: orient "up" toward the top of the
        // frame (every case's glyphs lean less than 90°), "along" rightward.
        const along = (i: number, normal: boolean) => {
          const th = (t.angle[i] * Math.PI) / 180;
          let n = [Math.cos(th), Math.sin(th)];
          if (n[1] > 0) n = [-n[0], -n[1]];
          const v = normal ? n : [-n[1], n[0]];
          return (a.cx[i] - t.cx[i]) * v[0] + (a.cy[i] - t.cy[i]) * v[1];
        };
        const nrm = t.cx.map((_, i) => along(i, true));
        const tan = t.cx.map((_, i) => along(i, false));
        d.normal = { mean: r4(nrm.reduce((x, y) => x + y, 0) / nrm.length), maxAbs: r4(Math.max(...nrm.map(Math.abs))) };
        d.tangent = { mean: r4(tan.reduce((x, y) => x + y, 0) / tan.length), maxAbs: r4(Math.max(...tan.map(Math.abs))) };
        d.massRatio = r4(a.mass / t.mass);
        d.dRgb = t.rgb && a.rgb ? r4(Math.max(...t.rgb.map((x, i) => Math.abs(x - a.rgb![i])))) : undefined;
        d.heightRatio = t.height ? r4(a.height / t.height) : undefined;
      } else d.mismatch = `glyph runs: toolbox ${t?.n ?? "none"}, AE ${a?.n ?? "none"}`;
      frames.push(d);
    }
    Object.assign(out, { measure: c.measure, frames });
  }
  results[c.name] = out;
}

// Strips for a look: toolbox above AE, per case.
mkdirSync(join(WORK, "png"), { recursive: true });
for (const c of cases.slice(0, 400)) {
  const f = c.frames[Math.floor(c.frames.length / 2)];
  const t = tbx.get(`${c.name}_f${f}`);
  const a = ae.get(`${c.name}_f${f}`);
  if (!t) continue;
  const both: FloatImage = { width: W, height: a ? 2 * H : H, data: new Float32Array(W * (a ? 2 : 1) * H * 4), bits: 16 };
  both.data.set(t.data, 0);
  if (a) both.data.set(a.data, W * H * 4);
  for (let i = 0; i < both.data.length; i += 4) {
    // Over mid grey so alpha shows.
    const al = both.data[i + 3];
    for (let k = 0; k < 3; k++) both.data[i + k] = both.data[i + k] * al + 0.25 * (1 - al);
    both.data[i + 3] = 1;
  }
  await savePng(both, join(WORK, "png", `${c.name}.png`));
}

const OUT = join(HERE, "measured", "text.json");
writeFileSync(OUT, recordJson({ ae: noAe ? null : "26.5", font: "ArialMT", size: [W, H], sample: SAMPLE, ...results }));
console.log(`\nwrote ${OUT}\n`);
const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
for (const [name, r] of Object.entries(results)) {
  if (r.measure === "metric") console.log(`${pad(name, 28)} toolbox middle ${r.middleEm} em (cap ${r.capEmTbx}) · AE first baseline ${r.firstBaselineEm} em (cap ${r.capEmAe}) · AE − toolbox baseline ${r.baselineDeltaPx} px`);
  else if (r.prop) console.log(`${pad(name, 28)} ${pad(r.prop, 9)} AE−tbx ${pad(String(r.aeVsTbxPct), 8)}%  AE−model ${pad(String(r.aeVsModelPct), 8)}%  tbx−model ${r.tbxVsModel}`);
  else console.log(`${pad(name, 28)} ${r.measure} ${r.frames.map((d: any) => (d.mismatch ? d.mismatch : `f${d.f}: Δpos ${d.dPos} px (mean ${d.meanPos}; normal ${d.normal?.mean}±${d.normal?.maxAbs}, along ${d.tangent?.mean}±${d.tangent?.maxAbs}) Δangle ${d.dAngle}° mass ${d.massRatio}${d.dRgb !== undefined ? ` Δrgb ${d.dRgb}` : ""}${d.heightRatio !== undefined ? ` h ${d.heightRatio}` : ""}`)).join(" | ")}`);
}
