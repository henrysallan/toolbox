// The instances lane's After Effects round trip (M4, specdocs/ae-m4/
// instances.md), headless: the r- fixtures → buildAeSceneForEditor → packages
// the M0 spike runner builds through aerender (scripts/ae-export-spike/
// run.mts --fixtures, which holds the AE lock), then:
//
//   props   every copy layer's Position / Scale / Rotation / Opacity and its
//           tint effect read back from AE (valueAtTime at the case frames)
//           and the copy layers' stacking order, against toolbox's own copies
//           (instances-reference.mts: the evaluated points + the node's math);
//   pixels  the rendered frames at every copy's centre — the variant's colour
//           × the tint, alpha = the opacity — Repeater copies included (AE's
//           Start / End Opacity interpolation, Array / lattice geometry).
//
//   npx tsx scripts/fixtures/ae-export/graphs/instances-roundtrip.mts          all r- fixtures
//   npx tsx scripts/fixtures/ae-export/graphs/instances-roundtrip.mts r-ramp   by name
//   npx tsx scripts/fixtures/ae-export/graphs/instances-roundtrip.mts --no-ae  write only
//
// Needs After Effects 26.x (AE_DIR); never touches the After Effects GUI.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { loadRegistry, makeChecker } from "../../../ae-export/harness.mts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const args = process.argv.slice(2);
const noAe = args.includes("--no-ae");
const filters = args.filter((a) => !a.startsWith("--"));
const OUT = join(tmpdir(), `toolbox-ae-instances-${Date.now()}`);

await loadRegistry();
const { SCENE_FIXTURES, sceneOf, buildFixture } = await import("./fixtures.mts");
const ref = await import("./instances-reference.mts");
const { makeAeGraph } = await import("@/lib/ae-export/scene/graph");

// Frames each fixture renders (pixels) and samples (props, every case frame).
const RENDER: Record<string, number[]> = { "r-keyed": [0, 15, 30], "r-stagger": [9, 20, 45], "r-switch": [0, 9, 25] };

type Px = { frame: number; x: number; y: number; want: number[]; tol: number; label: string };

// Pixels the Repeater fixtures promise: copy centres from toolbox's evaluated
// geometry, the fill colour, alpha = the opacity attribute.
async function repeaterPixels(name: string): Promise<Px[]> {
  const f = ref.fixtureNamed(name);
  const { nodes, edges } = await buildFixture(f);
  const W = f.comp.width;
  const H = f.comp.height;
  const g = makeAeGraph(nodes, edges, undefined, { width: W, height: H }, f.comp.fps);
  const px = (p: number[]) => [p[0] * W, H / 2 + (p[1] - 0.5) * W];
  const points = (ep: string, color: number[], alphaAttr?: string): Px[] => {
    const v = g.valueAt(ep, 0) as any;
    return Array.from({ length: v.count }, (_, i) => {
      const [x, y] = px([v.positions[i * 2], v.positions[i * 2 + 1]]);
      const a = alphaAttr ? v.attributes[alphaAttr].data[i] : 1;
      return { frame: 0, x: Math.round(x), y: Math.round(y), want: [...color, Math.round(a * 255)], tol: 3, label: `${ep} copy ${i + 1}` };
    });
  };
  const centroids = (ep: string, color: number[]): Px[] =>
    ((g.valueAt(ep, 0) as any).subpaths as any[]).map((s, i) => {
      const [x, y] = px([s.anchors.reduce((a: number, q: any) => a + q.pos[0], 0) / s.anchors.length, s.anchors.reduce((a: number, q: any) => a + q.pos[1], 0) / s.anchors.length]);
      return { frame: 0, x: Math.round(x), y: Math.round(y), want: [...color, 255], tol: 3, label: `${ep} copy ${i + 1}` };
    });
  if (name === "r-ramp") return [...points("fade:out", [255, 255, 255], "alpha"), ...points("fade2:out", [255, 255, 255], "alpha")];
  if (name === "r-array") return [...centroids("arr:out", [255, 170, 0]), ...points("arr2:out", [102, 255, 102]), ...centroids("copies:out", [204, 136, 255])];
  if (name === "r-field") return points("row:out", [136, 204, 255]);
  return [];
}

// Pixels of the exploded cases: each visible copy's centre, where no other
// copy of the fixture comes within `sep` px.
function copyPixels(kase: (typeof ref.INSTANCE_CASES)[number], frame: number, copies: any[], others: number[][], sep = 60): Px[] {
  const out: Px[] = [];
  for (const c of copies) {
    if (Math.min(c.scale[0], c.scale[1]) < 40) continue;
    const near = others.some((o) => o !== c.pos && Math.hypot(o[0] - c.pos[0], o[1] - c.pos[1]) < sep);
    if (near) continue;
    const base = kase.colors[c.k];
    const rgb = c.tint ? base.map((x: number, ch: number) => Math.round(Math.min(1, Math.max(0, (x / 255) * c.tint[ch])) * 255)) : base;
    out.push({ frame, x: Math.round(c.pos[0]), y: Math.round(c.pos[1]), want: [...rgb, Math.round((c.opacity / 100) * 255)], tol: 3, label: `${kase.copy} point ${c.i + 1} variant ${c.k + 1}` });
  }
  return out;
}

mkdirSync(OUT, { recursive: true });
const fixtures = SCENE_FIXTURES.filter((f) => f.name.startsWith("r-") && (!filters.length || filters.some((x) => f.name.includes(x))));
const plans: { name: string; scene: any; pixels: Px[]; samples: any[] }[] = [];
for (const f of fixtures) {
  const b = await sceneOf(f);
  if (b.problems.length || b.bakes.length) throw new Error(`${f.name}: ${[...b.problems, ...b.bakes.map((x) => x.reason)].join("; ")}`);
  writeFileSync(join(OUT, `${f.name}.scene.json`), JSON.stringify(b.scene, null, 2));
  const files = join(OUT, `${f.name}.files`);
  mkdirSync(join(files, "footage"), { recursive: true });
  for (const t of b.files) writeFileSync(join(files, t.path), t.text);
  const cases = ref.INSTANCE_CASES.filter((k) => k.fixture === f.name);
  const frames = RENDER[f.name] ?? [0];
  const samples: any[] = [];
  const pixels: Px[] = await repeaterPixels(f.name);
  for (const k of cases) {
    const comp = ref.layerComp(b.scene, k.layer)!;
    const times = k.frames.map((fr) => fr / f.comp.fps);
    for (const L of comp.layers) {
      if (L.kind !== "precomp" || !L.origin?.includes(k.copy)) continue;
      for (const mn of ["ADBE Position", "ADBE Scale", "ADBE Rotate Z", "ADBE Opacity"]) samples.push({ comp: comp.name, layer: L.name, path: ["ADBE Transform Group", mn], times });
      const fx = L.effects?.[0];
      if (fx) for (const mn of Object.keys(fx.props)) samples.push({ comp: comp.name, layer: L.name, path: ["ADBE Effect Parade", 1, mn], times });
    }
  }
  for (const fr of frames) {
    const all = await Promise.all(cases.map((k) => ref.toolboxCopies(f, k.copy, [fr]).then((x) => x[0])));
    const centres = all.flat().map((c) => c.pos);
    cases.forEach((k, n) => pixels.push(...copyPixels(k, fr, all[n], centres)));
  }
  const main = b.scene.comps.find((c) => c.id === b.scene.main)!;
  writeFileSync(join(OUT, `${f.name}.probe.json`), JSON.stringify({ render: { comp: main.name, frames }, samples }, null, 2));
  plans.push({ name: f.name, scene: b.scene, pixels, samples });
}
// A measurement, not a fixture: does AE take a Repeater Start / End Opacity
// outside 0–100 %? The r-ramp scene with its Repeaters rewritten forwards:
// the row 3 copies Start 20 → End 140 %, the grid's columns Start −20 →
// End 100 %. Its pixels are recorded (results.repeaterRange), not checked.
const PROBE_PIXELS: Record<string, [number, number]> = { "row 1": [256, 200], "row 2": [448, 200], "row 3": [640, 200], "column 1": [448, 328], "column 2": [640, 328], "column 3": [832, 328] };
if (plans.some((x) => x.name === "r-ramp")) {
  const scene = structuredClone(plans.find((x) => x.name === "r-ramp")!.scene);
  const main = scene.comps.find((x: any) => x.id === scene.main);
  main.name = "R zz range";
  const shape = (name: string) => scene.comps.flatMap((x: any) => x.layers).find((l: any) => l.name === name).contents[0].contents;
  const fwd = (rep: any, copies: number, d: number[], s0: number, s1: number) => Object.assign(rep, { composite: "above", copies: { v: copies } }) && Object.assign(rep.transform, { position: { v: d }, startOpacity: { v: s0 }, endOpacity: { v: s1 } });
  const row = shape("Ramp row");
  row[0].transform.position = { v: [-384, -160] };
  fwd(row[1], 3, [192, 0], 20, 140);
  const grid = shape("Ramp grid");
  grid[0].contents[0].transform.position = { v: [-192, -32] };
  fwd(grid[0].contents[1], 3, [192, 0], -20, 100);
  fwd(grid[1], 1, [0, 192], 100, 100);
  writeFileSync(join(OUT, "r-zz-range.scene.json"), JSON.stringify(scene, null, 2));
  writeFileSync(join(OUT, "r-zz-range.probe.json"), JSON.stringify({ render: { comp: main.name, frames: [0] } }, null, 2));
}
console.log(`wrote ${plans.length} package source(s) to ${OUT}`);
if (noAe) process.exit(0);

const t0 = Date.now();
const run = spawnSync("npx", ["tsx", join(REPO, "scripts/ae-export-spike/run.mts"), "--fixtures", OUT, "--out", join(OUT, "packages")], { stdio: "inherit", cwd: REPO });
const seconds = (Date.now() - t0) / 1000;

// --- compare -------------------------------------------------------------------------------
const c = makeChecker("instances-roundtrip");
const results: Record<string, unknown> = { runner: run.status, seconds, out: OUT };
const near3 = (v: any): number[] => (Array.isArray(v) ? v : [v]);
for (const p of plans) {
  const f = ref.fixtureNamed(p.name);
  const pkg = join(OUT, "packages", `${p.name}.aepkg`);
  const probePath = join(pkg, "probe.json");
  if (!existsSync(probePath)) {
    c.check(`${p.name}: probe.json written`, false);
    continue;
  }
  const probe = JSON.parse(readFileSync(probePath, "utf8"));
  const sample = (comp: string, layer: string, mn: string) => probe.samples.find((s: any) => s && s.comp === comp && s.layer === layer && s.path[s.path.length - 1] === mn);
  const worst: Record<string, number> = {};
  for (const k of ref.INSTANCE_CASES.filter((x) => x.fixture === p.name)) {
    const comp = ref.layerComp(p.scene, k.layer)!;
    const items = await ref.variantItems(f, k.copy);
    const aeComp = probe.project.comps.find((x: any) => x.name === comp.name);
    // AE's own stacking (index 1 = top) → bottom first.
    const order: string[] = (aeComp?.layers ?? []).map((l: any) => l.name).reverse();
    const want = await ref.toolboxCopies(f, k.copy, k.frames);
    for (let n = 0; n < k.frames.length; n++) {
      const got: any[] = [];
      for (const name of order) {
        const L = comp.layers.find((x: any) => x.name === name);
        if (!L || L.kind !== "precomp" || !L.origin?.includes(k.copy)) continue;
        const at = (mn: string) => near3(sample(comp.name, name, mn)?.values?.[n]);
        const opacity = at("ADBE Opacity")[0];
        if (!(opacity > 0)) continue;
        const fx = L.effects?.[0];
        got.push({
          layer: name,
          k: ref.variantOfComp(p.scene, L.source!, items),
          i: ref.slotOfName(name)!.i,
          pos: at("ADBE Position"),
          scale: at("ADBE Scale"),
          rot: at("ADBE Rotate Z")[0],
          opacity,
          ...(fx?.match === "ADBE Fill" ? { fill: at("ADBE Fill-0002") } : {}),
          ...(fx?.match === "ADBE CHANNEL MIXER" ? { mixer: ["0001", "0006", "0011"].map((id) => at(`ADBE CHANNEL MIXER-${id}`)[0]) } : {}),
        });
      }
      const w = ref.compareCopies(`(AE) ${p.name}/${k.copy} frame ${k.frames[n]}`, got, want[n], c, { rotTol: k.rotTol, flat: k.colors[0] });
      for (const [key, v] of Object.entries(w)) worst[`${k.copy}.${key}`] = Math.max(worst[`${k.copy}.${key}`] ?? 0, v);
    }
  }
  // Pixels: the queued TIFFs (premultiplied) → straight 8-bit.
  const renders = join(pkg, "renders");
  const files = existsSync(renders) ? readdirSync(renders) : [];
  const decoded = new Map<number, { data: Uint8Array; width: number }>();
  for (const fr of new Set(p.pixels.map((x) => x.frame))) {
    const file = files.find((x) => new RegExp(`^rq_f${fr}_\\d+\\.tif$`).test(x));
    if (!file) {
      c.check(`${p.name}: frame ${fr} rendered`, false);
      continue;
    }
    const { data, info } = await sharp(join(renders, file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    decoded.set(fr, { data: new Uint8Array(data), width: info.width });
  }
  let pxWorst = 0;
  let pxFail = 0;
  for (const q of p.pixels) {
    const img = decoded.get(q.frame);
    if (!img) continue;
    if (q.x < 0 || q.y < 0 || q.x >= img.width || q.y * img.width * 4 >= img.data.length) {
      c.check(`(AE pixels) ${p.name} ${q.label}: (${q.x}, ${q.y}) is inside the frame`, false);
      continue;
    }
    const o = (q.y * img.width + q.x) * 4;
    const a = img.data[o + 3];
    const un = (v: number) => (a ? Math.round((v * 255) / a) : 0);
    const gotPx = [un(img.data[o]), un(img.data[o + 1]), un(img.data[o + 2]), a];
    // Colour only counts where there is coverage.
    const d = Math.max(Math.abs(gotPx[3] - q.want[3]), ...(q.want[3] > 8 ? [0, 1, 2].map((ch) => Math.abs(gotPx[ch] - q.want[ch])) : [0]));
    pxWorst = Math.max(pxWorst, d);
    if (d > q.tol) {
      pxFail++;
      c.check(`(AE pixels) ${p.name} frame ${q.frame} (${q.x}, ${q.y}) ${q.label}`, false, { got: gotPx, want: q.want });
    }
  }
  c.check(`(AE pixels) ${p.name}: ${p.pixels.length - pxFail}/${p.pixels.length} copy centres within ±3/255 (worst ${pxWorst})`, pxFail === 0 && p.pixels.length > 0);
  results[p.name] = { worst, pixels: p.pixels.length, pixelWorst: pxWorst, pixelFailures: pxFail, samples: p.samples.length, build: probe.build?.seconds };
}
const rangeDir = join(OUT, "packages", "r-zz-range.aepkg", "renders");
const rangeFile = existsSync(rangeDir) ? readdirSync(rangeDir).find((x) => /^rq_f0_\d+\.tif$/.test(x)) : undefined;
if (rangeFile) {
  const { data, info } = await sharp(join(rangeDir, rangeFile)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  results.repeaterRange = Object.fromEntries(Object.entries(PROBE_PIXELS).map(([k, [x, y]]) => [k, data[(y * info.width + x) * 4 + 3]]));
  console.log("Repeater opacity outside 0–100 % (alpha 0–255 at each copy centre):", JSON.stringify(results.repeaterRange));
}
writeFileSync(join(OUT, "instances-results.json"), JSON.stringify(results, null, 2));
console.log(`\ninstances round trip: runner exit ${run.status}, ${seconds.toFixed(1)} s; results ${join(OUT, "instances-results.json")}`);
console.log(c.failures ? `instances round trip: ${c.failures} FAILED` : "instances round trip: all checks passed");
process.exit(c.failures || run.status ? 1 : 0);
