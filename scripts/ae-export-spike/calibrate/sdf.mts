// M4 lane 4 measurement (specdocs/ae-m4/sdf.md): the `s-` scene fixtures
// (scripts/fixtures/ae-export/graphs/sdf-fixtures.mts) rendered by toolbox's
// real engine (Electron, tbx-render.cjs) and by After Effects (the package
// round trip: build.jsx headless through aerender, then the queued probe
// frames) — and the pixels compared.
//
//   npx tsx scripts/ae-export-spike/calibrate/sdf.mts [--work DIR] [--no-ae] [s-boolean …]
//
// --no-ae reuses the AE renders already in DIR (a second toolbox pass with
// different variants costs no aerender launch). Every aerender launch goes
// through run.mts, which holds the AE lock (ae-lock.mts) for its whole run.
// The owner's After Effects GUI is never contacted.
//
// Per fixture and frame: compareRgba-style metrics (lib.mts metrics), the
// share of pixels off by > 2/255 and > 16/255, and the coverage bias — the
// signed coverage difference (toolbox − AE) summed over the frame divided by
// the edge length (AE's partially covered pixels): a mean outward offset of
// toolbox's edge in px, which separates geometry from anti-aliasing.
// Variants re-render toolbox with the consumer's softness changed.
//
// Writes calibrate/measured/sdf.json.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry } from "../../ae-export/harness.mts";
import { HERE, REPO, readAeFrame } from "./ae.mts";
import { metrics, renderTbx, round, savePng, type FloatImage } from "./lib.mts";

/* eslint-disable @typescript-eslint/no-explicit-any */

const args = process.argv.slice(2);
const wi = args.indexOf("--work");
const WORK = wi >= 0 ? args[wi + 1] : join(tmpdir(), `toolbox-ae-sdf-${Date.now()}`);
const noAe = args.includes("--no-ae");
const filters = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--work");
const SRC = join(WORK, "src");
const PKG = join(WORK, "packages");
mkdirSync(SRC, { recursive: true });
mkdirSync(join(WORK, "png"), { recursive: true });

await loadRegistry();
const { SCENE_FIXTURES, buildFixture } = await import("../../fixtures/ae-export/graphs/fixtures.mts");
const { flattenAeComposition } = await import("@/lib/ae-export/editor");
const fixtures = SCENE_FIXTURES.filter((f) => f.name.startsWith("s-") && f.probe && (!filters.length || filters.some((x) => f.name.includes(x))));

// Cases: every fixture as authored, plus softness / blur variants of two of
// them — the consumer's softness patched (toolbox and the scene alike), and
// the scene's edge Blurriness scaled (×0 = AE's own anti-aliasing only).
interface Case {
  id: string;
  fixture: (typeof SCENE_FIXTURES)[number];
  // Consumer params patched (toolbox and the scene alike).
  patch?: Record<string, unknown>;
  blurScale?: number;
}
const cases: Case[] = [];
for (const f of fixtures) {
  cases.push({ id: f.name, fixture: f });
  if (f.name === "s-chain") cases.push({ id: `${f.name}~aspect-off`, fixture: f, patch: { aspect_correct: false } });
  if (f.name !== "s-boolean" && f.name !== "s-offsets") continue;
  // (Softness 1, as authored, maps to no blur; 2 and 4 to Gaussian Blur 2 —
  // ×0 is AE's own anti-aliasing alone, ×0.8 / ×1.2 bracket the map.)
  for (const [softness, scales] of [
    [0.5, [1]],
    [2, [0, 0.8, 1, 1.2]],
    [4, [0, 0.8, 1, 1.2]],
  ] as [number, number[]][])
    for (const k of scales) cases.push({ id: `${f.name}~s${softness}b${k}`, fixture: f, patch: { softness }, blurScale: k });
}

const { buildAeSceneForEditor } = await import("@/lib/ae-export/scene");
const renders: any[] = [];
for (const k of cases) {
  const f = k.fixture;
  const { nodes, edges } = await buildFixture(f);
  const into = edges.find((e) => e.target.endsWith(".out") && e.targetHandle === "in:image");
  if (!into) throw new Error(`${f.name}: no layer output`);
  if (k.patch) {
    const n = nodes.find((x) => x.id === into.source)!;
    n.data.params = { ...n.data.params, ...k.patch };
  }
  const b = buildAeSceneForEditor(nodes, edges, {
    env: { composition: { id: `comp-${f.name}`, name: f.title, width: f.comp.width, height: f.comp.height, fps: f.comp.fps, durationFrames: f.comp.frames } },
    name: f.title,
    toolboxVersion: "fixture",
    generatedAt: "2026-10-21T00:00:00.000Z",
  });
  if (b.problems.length || b.bakes.length || b.bundles.length) throw new Error(`${k.id}: not a native scene (${b.problems.join("; ")}; ${b.bakes.length} bakes)`);
  if (k.blurScale !== undefined)
    for (const c of b.scene.comps)
      for (const L of c.layers) {
        const fx = L.effects?.find((x) => x.match === "ADBE Gaussian Blur 2");
        if (!fx) continue;
        const v = (fx.props["ADBE Gaussian Blur 2-0001"] as { v: number }).v * k.blurScale;
        if (v > 0) fx.props["ADBE Gaussian Blur 2-0001"] = { v };
        else L.effects = L.effects!.filter((x) => x !== fx);
      }
  writeFileSync(join(SRC, `${k.id}.scene.json`), JSON.stringify(b.scene, null, 2));
  const main = b.scene.comps.find((c) => c.id === b.scene.main)!;
  const pixels = k.id === f.name ? f.probe!.pixels.map((p) => (p.want ? p : { ...p, soft: true })) : [];
  writeFileSync(join(SRC, `${k.id}.probe.json`), JSON.stringify({ render: { comp: main.name, frames: f.probe!.frames }, pixels }, null, 2));
  const flat = flattenAeComposition(nodes, edges, undefined);
  renders.push({ id: k.id, nodes: flat.allNodes, edges: flat.wires, target: into.source, handle: into.sourceHandle, frames: f.probe!.frames });
}
if (!noAe) {
  const r = spawnSync("npx", ["tsx", join(REPO, "scripts/ae-export-spike/run.mts"), "--fixtures", SRC, "--out", PKG], { stdio: "inherit", cwd: REPO });
  console.log(`run.mts exited ${r.status}`);
}

function aeFrame(name: string, frame: number): string | undefined {
  const dir = join(PKG, `${name}.aepkg`, "renders");
  if (!existsSync(dir)) return undefined;
  const f = readdirSync(dir).find((x) => new RegExp(`^rq_f${frame}_\\d+\\.tif$`).test(x));
  return f ? join(dir, f) : undefined;
}

// ---- toolbox ------------------------------------------------------------------------
const W = 1280;
const H = 720;
const tbx = await renderTbx("sdf", { width: W, height: H }, [], renders, WORK);

// ---- compare -------------------------------------------------------------------------
const lum = (img: FloatImage, i: number) => (0.2126 * img.data[i * 4] + 0.7152 * img.data[i * 4 + 1] + 0.0722 * img.data[i * 4 + 2]) * img.data[i * 4 + 3];
function edgeStats(t: FloatImage, a: FloatImage) {
  // Coverage from luma over the frame's darkest / brightest values (the
  // fixtures are two-tone, plus a contour on s-boolean).
  let lo = Infinity;
  let hi = -Infinity;
  const n = a.width * a.height;
  for (let i = 0; i < n; i++) {
    const v = lum(a, i);
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const span = Math.max(1e-6, hi - lo);
  let signed = 0;
  let edge = 0;
  let over2 = 0;
  let over16 = 0;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const ca = (lum(a, i) - lo) / span;
    const ct = (lum(t, i) - lo) / span;
    signed += ct - ca;
    if (ca > 0.02 && ca < 0.98) edge++;
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(t.data[i * 4 + c] * (c < 3 ? t.data[i * 4 + 3] : 1) - a.data[i * 4 + c] * (c < 3 ? a.data[i * 4 + 3] : 1)));
    if (d > 2 / 255) over2++;
    if (d > 16 / 255) over16++;
    max = Math.max(max, d);
  }
  return { edgePx: edge, biasPx: round(edge ? signed / edge : 0, 4), over2: round(over2 / n, 6), over16: round(over16 / n, 6), maxPremult: round(max, 4) };
}

// The probes hold for toolbox's own render too (the fixtures' geometry is
// what the probes say).
let probeFails = 0;
for (const f of fixtures)
  for (const p of f.probe!.pixels) {
    const t = tbx.get(`${f.name}_f${p.frame}`);
    if (!t || !p.want) continue;
    const i = (p.y * t.width + p.x) * 4;
    const got = [0, 1, 2, 3].map((c) => Math.round(t.data[i + c] * 255));
    const ok = p.want.every((w, c) => w === null || w === undefined || Math.abs(got[c] - w) <= (p.tol ?? 2));
    if (!ok) probeFails++;
    console.log(`  toolbox probe ${ok ? "ok  " : "FAIL"} ${f.name} f${p.frame} (${p.x}, ${p.y}) ${p.label}: got ${got.join(",")} want ${p.want.join(",")}`);
  }
console.log(`toolbox probes: ${probeFails} failure(s)`);

const out: Record<string, unknown>[] = [];
for (const k of cases) {
  for (const frame of k.fixture.probe!.frames) {
    const file = aeFrame(k.id, frame);
    const t = tbx.get(`${k.id}_f${frame}`);
    if (!file || !t) {
      console.log(`${k.id} f${frame}: no ${file ? "toolbox" : "AE"} render`);
      continue;
    }
    const ae = await readAeFrame(file);
    await savePng(ae, join(WORK, "png", `${k.id}_f${frame}_ae.png`));
    await savePng(t, join(WORK, "png", `${k.id}_f${frame}_tbx.png`));
    const m = metrics(t, ae);
    const e = edgeStats(t, ae);
    const row = { case: k.id, fixture: k.fixture.name, frame, patch: k.patch ?? {}, blurScale: k.blurScale ?? 1, meanAbs: round(m.rgba.meanAbs, 5), p95Abs: round(m.rgba.p95Abs, 5), alphaMeanAbs: round(m.rgba.alphaMeanAbs, 5), max01: round(m.max01, 4), ...e };
    out.push(row);
    console.log(`${k.id.padEnd(22)} f${String(frame).padEnd(3)} mean ${row.meanAbs} p95 ${row.p95Abs} α ${row.alphaMeanAbs} max ${row.max01} premult-max ${e.maxPremult}  >2/255 ${(e.over2 * 100).toFixed(3)}%  >16/255 ${(e.over16 * 100).toFixed(3)}%  edge ${e.edgePx}px bias ${e.biasPx}px`);
  }
}
mkdirSync(join(HERE, "measured"), { recursive: true });
writeFileSync(join(HERE, "measured", "sdf.json"), JSON.stringify({ measured: new Date().toISOString().slice(0, 10), comp: [W, H], rows: out }, null, 1) + "\n");
console.log(`work ${WORK}`);
