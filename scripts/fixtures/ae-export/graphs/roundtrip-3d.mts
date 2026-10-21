// The 3-D lane's After Effects round trip (M4 lane 5, specdocs/ae-m4/3d.md):
// the t-* fixtures (a GLB + camera + lights) → buildAeSceneForEditor → a
// package built by the real build.jsx in aerender's core and rendered
// (run.mts --fixtures, under the AE lock) → compared with the SAME graph
// rendered by toolbox's real engine (calibrate/tbx-render.cjs, Electron):
// silhouette IoU, centroid and extent deltas (framing), and the colour error
// inside the shape (lighting, approx).
//
//   npx tsx scripts/fixtures/ae-export/graphs/roundtrip-3d.mts [t-scene3d …] [--work DIR]
//
// Writes calibrate/measured/three-d-roundtrip.json and side-by-side PNGs
// (<work>/compare/*.png). Needs After Effects 26.x and Electron; never touches
// the After Effects GUI.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry } from "../../../ae-export/harness.mts";
import { readAeTiff } from "../../../ae-export-spike/calibrate/ae.mts";
import { renderTbx, savePng, type FloatImage } from "../../../ae-export-spike/calibrate/lib.mts";
import type { TbxRender } from "../../../ae-export-spike/calibrate/tbx-page.ts";
import { buildFixture, SCENE_FIXTURES, sceneOf } from "./fixtures.mts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const args = process.argv.slice(2);
const wi = args.indexOf("--work");
const WORK = wi >= 0 ? resolve(args[wi + 1]) : join(tmpdir(), `toolbox-ae-3d-roundtrip-${Date.now()}`);
const filters = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--work");
const fixtures = SCENE_FIXTURES.filter((f) => f.name.startsWith("t-") && f.probe && (!filters.length || filters.some((x) => f.name.includes(x))));
if (!fixtures.length) throw new Error("no t-* fixture with a probe matched");

await loadRegistry();
const { flattenAeComposition } = await import("@/lib/ae-export/editor");
const SRC = join(WORK, "sources");
mkdirSync(SRC, { recursive: true });

// --- 1. AE: packages built + rendered by run.mts ------------------------------------------------
for (const f of fixtures) {
  const b = await sceneOf(f);
  if (b.problems.length) throw new Error(`${f.name}: ${b.problems.join("; ")}`);
  writeFileSync(join(SRC, `${f.name}.scene.json`), JSON.stringify(b.scene, null, 2));
  const files = join(SRC, `${f.name}.files`);
  mkdirSync(join(files, "footage"), { recursive: true });
  for (const a of b.assets) {
    const bytes = a.source.kind === "model" ? f.models?.[a.source.ref] : undefined;
    if (!bytes) throw new Error(`${f.name}: no bytes for asset ${a.id}`);
    writeFileSync(join(files, a.path), bytes());
  }
  const main = b.scene.comps.find((c) => c.id === b.scene.main)!;
  const pixels = f.probe!.pixels.map((p) => (p.want ? p : { ...p, soft: true }));
  writeFileSync(join(SRC, `${f.name}.probe.json`), JSON.stringify({ render: { comp: main.name, frames: f.probe!.frames }, pixels }, null, 2));
}
const run = spawnSync("npx", ["tsx", join(REPO, "scripts/ae-export-spike/run.mts"), "--fixtures", SRC, "--out", join(WORK, "packages")], { stdio: "inherit", cwd: REPO });
const runOk = run.status === 0;

// --- 2. toolbox: the same graphs through the real engine ----------------------------------------
const W = fixtures[0].comp.width;
const H = fixtures[0].comp.height;
const tbxDir = join(WORK, "tbx-tbx");
mkdirSync(tbxDir, { recursive: true });
const renders: TbxRender[] = [];
for (const f of fixtures) {
  const { nodes, edges } = await buildFixture(f);
  const flat = flattenAeComposition(nodes, edges);
  const eng = flat.allNodes.map((n) => {
    if (n.type !== "import-3d" || !f.models?.[n.id]) return n;
    writeFileSync(join(tbxDir, `${f.name}-${n.id}.glb`), f.models[n.id]());
    return { ...n, params: { ...n.params, model: { ...(n.params.model as object), url: `/inputs/${f.name}-${n.id}.glb` } } };
  });
  // The Scene Render's image: the main comp is its precomp at identity.
  const scene = eng.find((n) => n.type === "scene-render")!;
  renders.push({ id: f.name, nodes: eng, edges: flat.wires, target: scene.id, frames: f.probe!.frames } as unknown as TbxRender);
}
const tbx = await renderTbx("tbx", { width: W, height: H }, [], renders, WORK);

// --- 3. compare ---------------------------------------------------------------------------------
// The model's coverage: alpha over a transparent background; over a solid
// one (opaque corner), the pixels that differ from the corner's colour.
function coverageOf(img: FloatImage): Float32Array {
  const out = new Float32Array(img.width * img.height);
  const solid = img.data[3] > 0.999;
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    out[i] = solid ? (Math.max(Math.abs(img.data[o] - img.data[0]), Math.abs(img.data[o + 1] - img.data[1]), Math.abs(img.data[o + 2] - img.data[2])) > 4 / 255 ? 1 : 0) : img.data[o + 3];
  }
  return out;
}

function stats(img: FloatImage, cov: Float32Array) {
  let area = 0, cx = 0, cy = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const a = cov[y * img.width + x];
      if (a <= 0) continue;
      area += a;
      cx += a * (x + 0.5);
      cy += a * (y + 0.5);
      if (a >= 0.5) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    }
  return { area, centroid: [cx / area, cy / area], box: [x0, y0, x1, y1] };
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const results: Record<string, unknown> = {};
const outDir = join(WORK, "compare");
mkdirSync(outDir, { recursive: true });
for (const f of fixtures) {
  const pkg = join(WORK, "packages", `${f.name}.aepkg`, "renders");
  for (const frame of f.probe!.frames) {
    const file = existsSync(pkg) ? readdirSync(pkg).find((x) => new RegExp(`^rq_f${frame}_\\d+\\.tif$`).test(x)) : undefined;
    const t = tbx.get(`${f.name}_f${frame}`);
    const key = `${f.name}@${frame}`;
    if (!file || !t) {
      results[key] = { missing: { ae: !file, tbx: !t } };
      continue;
    }
    const a = await readAeTiff(join(pkg, file));
    const ca = coverageOf(a);
    const ct = coverageOf(t);
    let inter = 0, uni = 0, n = 0, sum = 0, worst = 0;
    const diffs: number[] = [];
    for (let i = 0; i < a.data.length; i += 4) {
      inter += Math.min(ca[i / 4], ct[i / 4]);
      uni += Math.max(ca[i / 4], ct[i / 4]);
      if (ca[i / 4] < 0.999 || ct[i / 4] < 0.999 || a.data[i + 3] < 0.999 || t.data[i + 3] < 0.999) continue;
      const d = (Math.abs(a.data[i] - t.data[i]) + Math.abs(a.data[i + 1] - t.data[i + 1]) + Math.abs(a.data[i + 2] - t.data[i + 2])) / 3;
      sum += d;
      worst = Math.max(worst, d);
      diffs.push(d);
      n++;
    }
    diffs.sort((x, y) => x - y);
    const sa = stats(a, ca);
    const st = stats(t, ct);
    results[key] = {
      silhouetteIoU: r3(inter / uni),
      centroidDeltaPx: [r3(sa.centroid[0] - st.centroid[0]), r3(sa.centroid[1] - st.centroid[1])],
      boxAe: sa.box,
      boxTbx: st.box,
      areaRatio: r3(sa.area / st.area),
      colorInside: { pixels: n, mean: r3(sum / n), p95: r3(diffs[Math.floor(0.95 * (n - 1))] ?? 0), max: r3(worst) },
    };
    // AE | toolbox side by side.
    const both: FloatImage = { width: W * 2, height: H, data: new Float32Array(W * 2 * H * 4), bits: 8 };
    for (let y = 0; y < H; y++) {
      both.data.set(a.data.subarray(y * W * 4, (y + 1) * W * 4), y * W * 2 * 4);
      both.data.set(t.data.subarray(y * W * 4, (y + 1) * W * 4), (y * W * 2 + W) * 4);
    }
    await savePng(both, join(outDir, `${f.name}_f${frame}.png`));
  }
}
const out = join(REPO, "scripts/ae-export-spike/calibrate/measured/three-d-roundtrip.json");
writeFileSync(out, JSON.stringify({ runOk, results }, null, 1) + "\n");
console.log(JSON.stringify(results, null, 1));
console.log(`run.mts ${runOk ? "passed" : "FAILED"}; wrote ${out}; side-by-sides in ${outDir}`);
process.exit(runOk ? 0 : 1);
