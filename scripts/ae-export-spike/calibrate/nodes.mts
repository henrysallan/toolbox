// Effect-class node calibration (spec 091926_after-effects-handoff.md §14):
// each suite renders toolbox's node and its AE stand-in on the same test
// images and records compareRgba metrics per case.
//
//   npx tsx scripts/ae-export-spike/calibrate/nodes.mts [suite…] [--work DIR] [--bpc 8|16]
//
// A case's AE effects come from calibration.ts (aeEffectsFor(map, values))
// when the node has a map, so the numbers measure the shipped map; a case may
// instead name its own `ae` effects (alternatives that were tried, or nodes
// that route to shader and are measured to say why). Results merge into
// calibrate/measured/nodes.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERE } from "./ae.mts";
import { aeEffectsFor, resolveAeEffectMap, type AeEffectContext, type AeEffectInstance } from "@/lib/ae-export/calibration";
import { grainStats } from "./grain-stats.mts";
import { loadRegistry } from "../../ae-export/harness.mts";
import { getNodeDef } from "@/engine/registry";
import { metrics, renderAe, renderTbx, round, savePng, summary, writePng16, type AeItem, type FloatImage } from "./lib.mts";
import { SUITES, type Suite } from "./suites.mts";
import type { TbxRender } from "./tbx-page";

const args = process.argv.slice(2);
const wi = args.indexOf("--work");
const WORK = wi >= 0 ? args[wi + 1] : join(tmpdir(), `toolbox-ae-nodes-${Date.now()}`);
const bi = args.indexOf("--bpc");
const BPCS: (8 | 16)[] = bi >= 0 ? [Number(args[bi + 1]) as 8 | 16] : [16, 8];
const only = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--work" && args[i - 1] !== "--bpc");
mkdirSync(WORK, { recursive: true });
console.log(`work: ${WORK}`);

await loadRegistry();
const defaults = (type: string): Record<string, unknown> => {
  const def = getNodeDef(type);
  if (!def) throw new Error(`no node ${type}`);
  return Object.fromEntries(def.params.map((p) => [p.name, p.default]));
};

const OUT = join(HERE, "measured", "nodes.json");
const recorded: Record<string, unknown> = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};

// A name selects a suite by id (a node's validation suite has the node's name).
const suites = SUITES.filter((s) => !only.length || only.includes(s.id ?? s.node));
for (const suite of suites) await runSuite(suite);

async function runSuite(suite: Suite) {
  const tag = suite.id ?? suite.node;
  const { width: W, height: H } = suite.size;
  const fps = suite.fps ?? 30;
  const ctx: AeEffectContext = { width: W, height: H, bitsPerChannel: 16, fps };
  const dir = join(WORK, tag);
  mkdirSync(join(dir, "png"), { recursive: true });
  // Images: one PNG (or a numbered sequence) per slot.
  const pngs: Record<string, { file?: string; sequence?: string }> = {};
  for (const [slot, img] of Object.entries(suite.images)) {
    if (Array.isArray(img)) {
      mkdirSync(join(dir, slot), { recursive: true });
      for (let f = 0; f < img.length; f++) await writePng16(img[f], join(dir, slot, `${slot}_${String(f).padStart(4, "0")}.png`));
      pngs[slot] = { sequence: join(dir, slot, `${slot}_0000.png`) };
    } else {
      pngs[slot] = { file: join(dir, `${slot}.png`) };
      await writePng16(img, pngs[slot].file!);
    }
  }
  const cases = suite.cases.map((c) => {
    const values = { ...defaults(suite.node), ...c.values };
    const r = resolveAeEffectMap(suite.node, values, ctx);
    const map = r && "map" in r ? r.map : undefined;
    const applies = !c.ae && !!map;
    const effects: AeEffectInstance[] = c.ae ? c.ae(values, ctx) : map ? aeEffectsFor(map, values, ctx) : [];
    return { ...c, values, applies, refusal: r && "refusal" in r ? r.refusal : undefined, effects };
  });
  // AE: the input image on top with the effects; extra inputs below, hidden.
  const items: AeItem[] = cases.map((c) => {
    const extra = Object.entries(c.inputs ?? {});
    const layerOf = (socket: string) => 2 + extra.findIndex(([s]) => s === socket);
    const effects = c.effects.map((e) => ({
      match: e.match,
      props: Object.fromEntries(Object.entries(e.props).map(([k, v]) => [k, v && typeof v === "object" && "input" in (v as object) ? { layer: layerOf((v as { input: string }).input) } : v])),
    }));
    const img = pngs[c.image];
    return {
      name: c.id,
      w: W,
      h: H,
      fps,
      dur: suite.frames ? (Math.max(...suite.frames) + 2) / fps : 1,
      frames: suite.frames ?? [0],
      layers: [
        { name: "img", ...(img.sequence ? { sequence: img.sequence } : { image: img.file }), effects },
        ...extra.map(([socket, slot]) => ({ name: socket, image: pngs[slot].file, hidden: true })),
      ],
    };
  });
  const tbRenders: TbxRender[] = cases.map((c) => {
    const nodes: TbxRender["nodes"] = [
      { id: "src", type: "calib-input", params: { slot: c.image } },
      { id: "fx", type: suite.node, params: c.values },
    ];
    const edges: TbxRender["edges"] = [{ id: "e0", source: "src", sourceHandle: "out:primary", target: "fx", targetHandle: `in:${suite.input ?? "image"}` }];
    for (const [socket, slot] of Object.entries(c.inputs ?? {})) {
      nodes.push({ id: `in-${socket}`, type: "calib-input", params: { slot } });
      edges.push({ id: `e-${socket}`, source: `in-${socket}`, sourceHandle: "out:primary", target: "fx", targetHandle: `in:${socket}` });
    }
    return { id: c.id, nodes, edges, target: "fx", frames: suite.frames, sequential: !!suite.frames };
  });
  const inputs = Object.entries(suite.images).flatMap(([slot, img]) => (Array.isArray(img) ? img.map((image, frame) => ({ slot, frame, image })) : [{ slot, image: img }]));
  const tb = await renderTbx(tag, { width: W, height: H }, inputs, tbRenders, dir, fps);
  const results: Record<string, unknown>[] = [];
  for (const bpc of BPCS) {
    const ae = await renderAe(tag, items, { work: dir, bpc, fps });
    for (const c of cases)
      for (const f of suite.frames ?? [0]) {
        const a = ae.images.get(`${c.id}_f${f}`);
        const t = tb.get(`${c.id}_f${f}`);
        if (!a || !t) {
          console.log(`  ${c.id} f${f}: missing ${!a ? "AE" : "toolbox"} render`);
          continue;
        }
        const m = metrics(t, a, c.crop ?? 0);
        // Grain: per-band statistics instead of pixels (it is noise).
        const stats = suite.stats ? bandStats(t, a, suite.images[c.image] as FloatImage) : undefined;
        const nonDefault = Object.fromEntries(Object.entries(c.values).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(defaults(suite.node)[k])));
        results.push({ id: c.id, frame: f, bpc, applies: c.applies, ...(c.refusal ? { refusal: c.refusal } : {}), values: nonDefault, ae: c.effects, ...(c.crop ? { crop: c.crop } : {}), ...summary(m), ...(stats ? { stats } : {}) });
        console.log(`  ${c.id.padEnd(28)} f${String(f).padEnd(3)} ${bpc}  ${c.applies ? "map " : "    "} mean ${round(m.rgba.meanAbs, 4)}  p95 ${round(m.rgba.p95Abs, 4)}  α ${round(m.rgba.alphaMeanAbs, 4)}  max ${round(m.max01, 4)}  ${m.rgba.verdict}${stats ? `  grain std rel ${stats.maxRelStd} acf1 ${stats.acf1[0]}/${stats.acf1[1]}` : ""}`);
        if (bpc === BPCS[0] && f === (suite.frames ?? [0])[(suite.frames ?? [0]).length - 1]) {
          await savePng(a, join(dir, "png", `${c.id}-ae.png`));
          await savePng(t, join(dir, "png", `${c.id}-tbx.png`));
        }
      }
  }
  recorded[tag] = { node: suite.node, size: [W, H], fps, measured: new Date().toISOString().slice(0, 10), note: suite.note, results };
  mkdirSync(join(HERE, "measured"), { recursive: true });
  writeFileSync(OUT, JSON.stringify(recorded, null, 1) + "\n");
}

// Std of (out − in) per 1/8-width band (a ramp's luminance bands), toolbox vs
// AE, and the worst relative difference; lag-1 autocorrelation of each.
function bandStats(t: FloatImage, a: FloatImage, src: FloatImage) {
  const bands = 8;
  const bw = Math.floor(t.width / bands);
  const std = (img: FloatImage, b: number) => {
    let s = 0;
    let s2 = 0;
    let n = 0;
    for (let y = 8; y < img.height - 8; y++)
      for (let x = b * bw; x < (b + 1) * bw; x++) {
        const i = (y * img.width + x) * 4 + 1;
        const v = img.data[i] - src.data[i];
        s += v;
        s2 += v * v;
        n++;
      }
    return Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
  };
  const tb = Array.from({ length: bands }, (_, b) => round(std(t, b), 5));
  const ae = Array.from({ length: bands }, (_, b) => round(std(a, b), 5));
  const maxRelStd = round(Math.max(...tb.map((v, i) => Math.abs(ae[i] - v) / Math.max(v, 1e-6))), 4);
  return { tb, ae, maxRelStd, acf1: [round(grainStats(t, 8, src).acf1, 4), round(grainStats(a, 8, src).acf1, 4)] };
}

export type { FloatImage };
