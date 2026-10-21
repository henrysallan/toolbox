// How After Effects' text animators behave, measured by rendering (spec
// §4.7; results in specdocs/ae-m4/text.md). Scripting reads back property
// values, not what a selector selected, so each question is a comp of ten
// separated block glyphs (Menlo █, a system font both renderers share) whose
// per-glyph alpha / size / centroid / colour answers it:
//
//   stacking   two animators of one property (opacity, scale, fill colour)
//   ranges     Start / Offset outside 0–100 %, index units, Amount
//   shapes     Ramp Up / Down, Square coverage, Ease High / Low, Random Order
//   modes      two Range Selectors combined by Min / Max
//   expression the Expression Selector's output range and textIndex base
//   anchor     where a character scales / rotates (Grouping Alignment)
//   tracking   Tracking Type After vs Before & After
//   path       First / Last Margin per justification, Reverse Path,
//              baseline shift on a path
//
//   npx tsx scripts/ae-export-spike/calibrate/text-probe.mts [--set 1|2] [--work DIR]
//
// Writes calibrate/measured/text-probe-<set>.json. Set 1: stacking, ranges,
// shapes, modes, expression range, anchor, path margins. Set 2: what set 1
// left open — opacity chaining vs product, the animator Anchor Point as a
// pivot, tracking units, word grouping, the Expression Selector reading a
// slider, a second font.

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERE, readAeFrame, renderQueue, renderedFile, runAeJob } from "./ae.mts";
import { allStats, glyphCells, r4, recordJson, type GlyphStats } from "./text-glyphs.mts";

/* eslint-disable @typescript-eslint/no-explicit-any */

const args = process.argv.slice(2);
const si = args.indexOf("--set");
const SET = si >= 0 ? args[si + 1] : "1";
const wi = args.indexOf("--work");
const WORK = wi >= 0 ? args[wi + 1] : join(tmpdir(), `toolbox-ae-text-probe-${Date.now()}`);
const RENDERS = join(WORK, "renders");
mkdirSync(RENDERS, { recursive: true });

const N = 10;
const BLOCKS = "█".repeat(N);
const FONT = "Menlo-Regular";
const SIZE = 40;
const base = { w: 900, h: 240, text: BLOCKS, font: FONT, size: SIZE, tracking: 1000, just: "left", pos: [40, 150] };
const op0 = { "ADBE Text Opacity": 0 };
type Sel = Record<string, unknown>;
const range = (s: Sel = {}): Sel => ({ kind: "range", ...s });
const item = (name: string, o: Record<string, unknown>) => ({ ...base, name, ...o });

const SET1 = [
  item("base", {}),
  item("op_one50", { animators: [{ props: { "ADBE Text Opacity": 50 }, selectors: [range()] }] }),
  item("op_two50", { animators: [{ props: { "ADBE Text Opacity": 50 }, selectors: [range()] }, { props: { "ADBE Text Opacity": 50 }, selectors: [range()] }] }),
  item("op_one50_amt50", { animators: [{ props: { "ADBE Text Opacity": 50 }, selectors: [range({ amount: 50 })] }] }),
  item("sc_one50", { animators: [{ props: { "ADBE Text Scale 3D": [50, 50, 100] }, selectors: [range()] }] }),
  item("sc_two50", { animators: [{ props: { "ADBE Text Scale 3D": [50, 50, 100] }, selectors: [range()] }, { props: { "ADBE Text Scale 3D": [50, 50, 100] }, selectors: [range()] }] }),
  item("sc_one50_amt50", { animators: [{ props: { "ADBE Text Scale 3D": [50, 50, 100] }, selectors: [range({ amount: 50 })] }] }),
  item("sc_200", { animators: [{ props: { "ADBE Text Scale 3D": [200, 200, 100] }, selectors: [range()] }] }),
  item("sc_200_al50", { groupAlign: [0, -50], animators: [{ props: { "ADBE Text Scale 3D": [200, 200, 100] }, selectors: [range()] }] }),
  item("sc_200_al100", { groupAlign: [0, -100], animators: [{ props: { "ADBE Text Scale 3D": [200, 200, 100] }, selectors: [range()] }] }),
  item("rot_30", { animators: [{ props: { "ADBE Text Rotation": 30 }, selectors: [range()] }] }),
  item("pos_amt_neg", { animators: [{ props: { "ADBE Text Position 3D": [0, 40, 0] }, selectors: [range({ amount: -50 })] }] }),
  item("col_two", { animators: [{ props: { "ADBE Text Fill Color": [1, 0, 0] }, selectors: [range()] }, { props: { "ADBE Text Fill Color": [0, 0, 1] }, selectors: [range({ amount: 50 })] }] }),
  item("col_one_amt50", { fill: [0, 1, 0], animators: [{ props: { "ADBE Text Fill Color": [1, 0, 0] }, selectors: [range({ amount: 50 })] }] }),
  item("ramp_up", { animators: [{ props: op0, selectors: [range({ shape: 2 })] }] }),
  item("ramp_down", { animators: [{ props: op0, selectors: [range({ shape: 3 })] }] }),
  item("ramp_up_20_60_o10", { animators: [{ props: op0, selectors: [range({ shape: 2, start: 20, end: 60, offset: 10 })] }] }),
  item("square_15_52", { animators: [{ props: op0, selectors: [range({ start: 15, end: 52 })] }] }),
  item("ramp_start_neg50", { animators: [{ props: op0, selectors: [range({ shape: 2, start: -50, end: 50 })] }] }),
  item("ramp_end_150", { animators: [{ props: op0, selectors: [range({ shape: 2, start: 0, end: 150 })] }] }),
  item("ramp_off_150", { animators: [{ props: op0, selectors: [range({ shape: 2, start: 0, end: 20, offset: 150 })] }] }),
  item("ramp_off_neg30", { animators: [{ props: op0, selectors: [range({ shape: 2, start: 0, end: 100, offset: -30 })] }] }),
  item("ramp_inverted", { animators: [{ props: op0, selectors: [range({ shape: 2, start: 80, end: 20 })] }] }),
  item("index_2_5", { animators: [{ props: op0, selectors: [range({ units: 2, start: 2, end: 5 })] }] }),
  item("index_ramp_neg", { animators: [{ props: op0, selectors: [range({ units: 2, shape: 2, start: -3, end: 4 })] }] }),
  item("ease_h50_l50", { animators: [{ props: op0, selectors: [range({ shape: 2, easeHigh: 50, easeLow: 50 })] }] }),
  item("ease_h100_l0", { animators: [{ props: op0, selectors: [range({ shape: 2, easeHigh: 100, easeLow: 0 })] }] }),
  item("ease_hn50_ln50", { animators: [{ props: op0, selectors: [range({ shape: 2, easeHigh: -50, easeLow: -50 })] }] }),
  item("random_s0", { animators: [{ props: op0, selectors: [range({ shape: 2, random: true, seed: 0 })] }] }),
  item("random_s7", { animators: [{ props: op0, selectors: [range({ shape: 2, random: true, seed: 7 })] }] }),
  item("min_mode", { animators: [{ props: op0, selectors: [range({ shape: 2, start: 0, end: 50 }), range({ shape: 3, start: 50, end: 100, mode: 4 })] }] }),
  item("max_mode", { animators: [{ props: op0, selectors: [range({ shape: 3, start: 0, end: 50 }), range({ shape: 2, start: 50, end: 100, mode: 5 })] }] }),
  item("triangle", { animators: [{ props: op0, selectors: [range({ shape: 4 })] }] }),
  item("expr_150", { animators: [{ props: { "ADBE Text Position 3D": [0, 40, 0] }, selectors: [{ kind: "expression", expression: "150" }] }] }),
  item("expr_neg50", { animators: [{ props: { "ADBE Text Position 3D": [0, 40, 0] }, selectors: [{ kind: "expression", expression: "-50" }] }] }),
  item("expr_index", { animators: [{ props: op0, selectors: [{ kind: "expression", expression: "textIndex / textTotal * 100" }] }] }),
  item("expr_op_150", { animators: [{ props: { "ADBE Text Opacity": 50 }, selectors: [{ kind: "expression", expression: "150" }] }] }),
  item("expr_sc_150", { animators: [{ props: { "ADBE Text Scale 3D": [50, 50, 100] }, selectors: [{ kind: "expression", expression: "150" }] }] }),
  item("expr_sc_neg100", { animators: [{ props: { "ADBE Text Scale 3D": [50, 50, 100] }, selectors: [{ kind: "expression", expression: "-100" }] }] }),
  item("expr_vec", { animators: [{ props: { "ADBE Text Position 3D": [0, 40, 0] }, selectors: [{ kind: "expression", expression: "[100, 25, 0]" }] }] }),
  item("trk_after", { tracking: 0, animators: [{ props: { "ADBE Text Tracking Amount": 1000 }, trackingType: 3, selectors: [range({ start: 50 })] }] }),
  item("trk_both", { tracking: 0, animators: [{ props: { "ADBE Text Tracking Amount": 1000 }, trackingType: 1, selectors: [range({ start: 50 })] }] }),
  item("trk_base_after", { tracking: 0, dump: true, animators: [{ props: { "ADBE Text Tracking Amount": 1000 }, trackingType: 3, selectors: [range()] }] }),
  item("words", { text: "██ ██ ██ ██ ██", tracking: 500, animators: [{ props: op0, selectors: [range({ shape: 2, basedOn: 3 })] }] }),
  item("lines_chars", { text: "█████\r█████", h: 300, pos: [40, 120], animators: [{ props: op0, selectors: [range({ shape: 2 })] }] }),
  // Text on a straight horizontal mask, x 100 → 800 at y 150 (layer at the origin).
  ...[
    ["path_left", { just: "left" }],
    ["path_left_f100", { just: "left", first: 100 }],
    ["path_center", { just: "center" }],
    ["path_center_f100", { just: "center", first: 100 }],
    ["path_center_l100", { just: "center", last: 100 }],
    ["path_right", { just: "right" }],
    ["path_right_l100", { just: "right", last: 100 }],
    ["path_right_f100", { just: "right", first: 100 }],
    ["path_left_rev", { just: "left", reverse: true }],
    ["path_left_bs20", { just: "left", bs: 20 }],
    ["path_left_fneg100", { just: "left", first: -100 }],
  ].map(([name, o]: any) =>
    item(name, {
      tracking: 500,
      just: o.just,
      pos: [0, 0],
      baselineShift: o.bs,
      path: { vertices: [[100, 150], [800, 150]], reverse: o.reverse, first: o.first, last: o.last },
    })
  ),
];

const ar = (name: string, o: Record<string, unknown>) => item(name, { font: "ArialMT", text: "HHHHHHHHHH", ...o });
const SET2 = [
  item("base", {}),
  item("op_50_80", { animators: [{ props: { "ADBE Text Opacity": 50 }, selectors: [range()] }, { props: { "ADBE Text Opacity": 80 }, selectors: [range()] }] }),
  item("op_80_50", { animators: [{ props: { "ADBE Text Opacity": 80 }, selectors: [range()] }, { props: { "ADBE Text Opacity": 50 }, selectors: [range()] }] }),
  item("op_x_fillop", { animators: [{ props: { "ADBE Text Opacity": 50 }, selectors: [range()] }, { props: { "ADBE Text Fill Opacity": 50 }, selectors: [range()] }] }),
  item("fillop_50_80h", { animators: [{ props: { "ADBE Text Fill Opacity": 50 }, selectors: [range()] }, { props: { "ADBE Text Fill Opacity": 80 }, selectors: [range({ amount: 50 })] }] }),
  item("pos_two20", { animators: [{ props: { "ADBE Text Position 3D": [0, 20, 0] }, selectors: [range()] }, { props: { "ADBE Text Position 3D": [0, 20, 0] }, selectors: [range()] }] }),
  item("rot_two20", { animators: [{ props: { "ADBE Text Rotation": 20 }, selectors: [range()] }, { props: { "ADBE Text Rotation": 20 }, selectors: [range()] }] }),
  item("anc_only", { animators: [{ props: { "ADBE Text Anchor Point 3D": [0, -20, 0] }, selectors: [range()] }] }),
  item("anc_sc200", { animators: [{ props: { "ADBE Text Anchor Point 3D": [0, -20, 0], "ADBE Text Scale 3D": [200, 200, 100] }, selectors: [range()] }] }),
  item("anc_then_sc200", { animators: [{ props: { "ADBE Text Anchor Point 3D": [0, -20, 0] }, selectors: [range()] }, { props: { "ADBE Text Scale 3D": [200, 200, 100] }, selectors: [range()] }] }),
  item("anc_sc200_half", { animators: [{ props: { "ADBE Text Anchor Point 3D": [0, -20, 0], "ADBE Text Scale 3D": [200, 200, 100] }, selectors: [range({ amount: 50 })] }] }),
  item("anc_rot90", { animators: [{ props: { "ADBE Text Anchor Point 3D": [0, -20, 0], "ADBE Text Rotation": 90 }, selectors: [range()] }] }),
  item("anc_pos_sc", { animators: [{ props: { "ADBE Text Anchor Point 3D": [0, -20, 0], "ADBE Text Position 3D": [0, 30, 0], "ADBE Text Scale 3D": [200, 200, 100] }, selectors: [range()] }] }),
  item("sc_then_anc_sc", { animators: [{ props: { "ADBE Text Scale 3D": [50, 50, 100] }, selectors: [range()] }, { props: { "ADBE Text Anchor Point 3D": [0, -20, 0], "ADBE Text Scale 3D": [200, 200, 100] }, selectors: [range()] }] }),
  item("rot_then_pos", { animators: [{ props: { "ADBE Text Rotation": 90 }, selectors: [range()] }, { props: { "ADBE Text Position 3D": [30, 0, 0] }, selectors: [range()] }] }),
  ar("ar_base", {}),
  ar("ar_sc200", { animators: [{ props: { "ADBE Text Scale 3D": [200, 200, 100] }, selectors: [range()] }] }),
  ar("ar_sc200_al50", { groupAlign: [0, -50], animators: [{ props: { "ADBE Text Scale 3D": [200, 200, 100] }, selectors: [range()] }] }),
  item("al50_80px", { size: 80, tracking: 500, pos: [40, 180], groupAlign: [0, -50], animators: [{ props: { "ADBE Text Scale 3D": [200, 200, 100] }, selectors: [range()] }] }),
  item("base_80px", { size: 80, tracking: 500, pos: [40, 180] }),
  ...[0, 100, 500].flatMap((t) => [item(`trk${t}_40`, { tracking: t }), item(`trk${t}_80`, { size: 80, tracking: t, pos: [40, 180] }), ar(`artrk${t}_40`, { tracking: t })]),
  ...[1, 3].flatMap((type) => [
    item(`ta${type}_50_40`, { tracking: 300, animators: [{ props: { "ADBE Text Track Type": type, "ADBE Text Tracking Amount": 50 }, selectors: [range({ start: 50 })] }] }),
    item(`ta${type}_50_80`, { size: 80, tracking: 300, pos: [40, 180], animators: [{ props: { "ADBE Text Track Type": type, "ADBE Text Tracking Amount": 50 }, selectors: [range({ start: 50 })] }] }),
  ]),
  item("ta3_100_40_all", { tracking: 300, animators: [{ props: { "ADBE Text Track Type": 3, "ADBE Text Tracking Amount": 100 }, selectors: [range()] }] }),
  item("ta3_100_40_just_c", { tracking: 300, just: "center", pos: [450, 150], animators: [{ props: { "ADBE Text Track Type": 3, "ADBE Text Tracking Amount": 100 }, selectors: [range()] }] }),
  item("base_just_c", { tracking: 300, just: "center", pos: [450, 150] }),
  item("words_base", { text: "\u2588\u2588 \u2588\u2588 \u2588\u2588 \u2588\u2588 \u2588\u2588", tracking: 500 }),
  item("words_g2_sc200", { text: "\u2588\u2588 \u2588\u2588 \u2588\u2588 \u2588\u2588 \u2588\u2588", tracking: 500, grouping: 2, animators: [{ props: { "ADBE Text Scale 3D": [200, 200, 100] }, selectors: [range({ basedOn: 3 })] }] }),
  item("words_g2_anc_sc200", { text: "\u2588\u2588 \u2588\u2588 \u2588\u2588 \u2588\u2588 \u2588\u2588", tracking: 500, grouping: 2, animators: [{ props: { "ADBE Text Anchor Point 3D": [0, -20, 0], "ADBE Text Scale 3D": [200, 200, 100] }, selectors: [range({ basedOn: 3 })] }] }),
  item("words_expr", { text: "\u2588\u2588 \u2588\u2588 \u2588\u2588 \u2588\u2588 \u2588\u2588", tracking: 500, animators: [{ props: op0, selectors: [{ kind: "expression", basedOn: 3, expression: "textIndex / textTotal * 100" }] }] }),
  item("expr_slider", { slider: 0.25, animators: [{ props: op0, selectors: [{ kind: "expression", expression: "var a = effect(\"Amt\")(1).value; 100 * Math.min(1, Math.max(0, a * 4 - (textIndex - 1) / 3));" }] }] }),
  item("expr_imul", { animators: [{ props: op0, selectors: [{ kind: "expression", expression: "var x = (textIndex * 2654435761) | 0; x = Math.imul(x ^ (x >>> 16), 0x45d9f3b); 100 * ((x >>> 0) / 4294967296);" }] }] }),
  item("stroke_fillop", { stroke: 3, animators: [{ props: { "ADBE Text Fill Opacity": 0 }, selectors: [range()] }] }),
  item("path_center_f100_l100", { tracking: 500, just: "center", pos: [0, 0], path: { vertices: [[100, 150], [800, 150]], first: 100, last: 100 } }),
  item("path_rev_bs20", { tracking: 500, just: "left", pos: [0, 0], baselineShift: 20, path: { vertices: [[100, 150], [800, 150]], reverse: true } }),
];
// Set 3: can the Expression Selector's own Amount carry the toolbox amount's
// keys (read back as `value`), so no Slider Control is needed?
const SET3 = [
  item("base", {}),
  item("expr_value_keys", { duration: 2, frames: [0, 15, 30], animators: [{ props: op0, selectors: [{ kind: "expression", keys: [[0, [0, 0, 0]], [1, [100, 100, 100]]], expression: "var a = value[0] / 100; 100 * Math.min(1, Math.max(0, a * 10 - (textIndex - 1)));" }] }] }),
  item("expr_value_static", { animators: [{ props: op0, selectors: [{ kind: "expression", value: [40, 40, 40], expression: "var a = value[0] / 100; 100 * Math.min(1, Math.max(0, a * 10 - (textIndex - 1)));" }] }] }),
];
// Set 4: an Expression Selector reading the layer's own text (toolbox's word
// index per character, spaces included). Opacity 0; the selection is 50 %
// when the expression read the right length (alpha 0.5), 0 for a wrong one
// (alpha 1); an expression error leaves AE's Amount, 100 % (alpha 0).
const W4 = "\u2588\u2588 \u2588\u2588 \u2588\u2588 \u2588\u2588";
const is = (expr: string, n: number) => `(${expr}) === ${n} ? 50 : 0`;
const SET4 = [
  item("base", {}),
  item("src_string", { text: W4, tracking: 500, animators: [{ props: op0, selectors: [{ kind: "expression", expression: is("Array.from(String(text.sourceText)).length", 11) }] }] }),
  item("src_value", { text: W4, tracking: 500, animators: [{ props: op0, selectors: [{ kind: "expression", expression: is("Array.from(String(text.sourceText.value)).length", 11) }] }] }),
  item("src_this", { text: W4, tracking: 500, animators: [{ props: op0, selectors: [{ kind: "expression", expression: is("Array.from(thisLayer.text.sourceText.value.toString()).length", 11) }] }] }),
  ...[4, 5, 6].map((n) => item(`src_len${n}`, { text: "\u2588\u2588\r\u2588\u2588", tracking: 500, animators: [{ props: op0, selectors: [{ kind: "expression", expression: is("String(text.sourceText).length", n) }] }] })),
  ...[3, 10, 13].map((c) => item(`src_code${c}`, { text: "\u2588\u2588\r\u2588\u2588", tracking: 500, animators: [{ props: op0, selectors: [{ kind: "expression", expression: is("String(text.sourceText).charCodeAt(2)", c) }] }] })),
];
// Set 5: the kerning mode a new text layer inherits (the Character panel's
// last-used settings) against metric / none, Arial "I" at 40 and 72 px.
const SET5 = [40, 72].flatMap((size) =>
  [undefined, "METRIC_KERN", "NO_AUTO_KERN", "OPTICAL_KERN"].map((k) =>
    item(`kern_${k ?? "inherited"}_${size}`, { font: "ArialMT", text: "IIIIII", size, tracking: Math.round((30 / size) * 1000), autoKern: k, pos: [40, 150] })
  )
);
const ITEMS = SET === "5" ? SET5 : SET === "4" ? SET4 : SET === "3" ? SET3 : SET === "2" ? SET2 : SET1;

console.log(`text probe set ${SET}: ${ITEMS.length} comps → ${WORK}`);
const project = join(WORK, "text-probe.aep");
const job = await runAeJob("text-probe", "text.jsx", { project, renders: RENDERS, items: ITEMS }, WORK);
console.log(`  build ${job.seconds.toFixed(1)} s; ${job.out.errors.length} error(s)`);
for (const e of job.out.errors) console.log(`  ! ${e}`);
const rq = await renderQueue(project, WORK);
console.log(`  render ${rq.seconds.toFixed(1)} s (exit ${rq.code})`);

const stats = new Map<string, GlyphStats[]>();
const refCells = new Map<string, ReturnType<typeof glyphCells>>();
const img = async (name: string) => {
  const f = renderedFile(RENDERS, name.includes("@") ? name.replace("@", "_f") : `${name}_f0`);
  if (!f) throw new Error(`no render for ${name}`);
  return readAeFrame(f);
};
const baseImg = await img(ITEMS[0].name);
const cells = SET === "5" ? glyphCells(baseImg) : glyphCells(baseImg, N);
refCells.set("base", cells);
const results: Record<string, unknown> = { ae: job.out.ae, items: job.out.items, cells };
const views = ITEMS.flatMap((it: any) => (it.frames ?? [0]).map((f: number) => (f ? { ...it, name: `${it.name}@${f}` } : it)));
for (const it of views) {
  try {
    const im = await img(it.name);
    // Path / word / line comps lay their glyphs out differently: own cells.
    const own = /^(path_|words|lines_|trk|ta\d|ar|al50|base_|src_|kern_)/.test(it.name);
    const cs = own ? glyphCells(im) : cells;
    const s = allStats(im, cs);
    stats.set(it.name, s);
    results[it.name] = {
      cells: own ? cs.length : undefined,
      mass: s.map((g, i) => r4(g.mass / (stats.get("base")?.[i]?.mass ?? g.mass))),
      cx: s.map((g) => r4(g.cx)),
      cy: s.map((g) => r4(g.cy)),
      bbox: s.map((g) => [g.bx0, g.by0, g.bx1, g.by1]),
      angle: s.map((g) => r4(g.angle)),
      rgb: s.map((g) => g.rgb.map(r4)),
    };
  } catch (e) {
    results[it.name] = { error: String(e) };
  }
}
const out = join(HERE, "measured", `text-probe-${SET}.json`);
writeFileSync(out, recordJson(results));
console.log(`wrote ${out}`);
