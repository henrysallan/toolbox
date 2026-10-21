// Essential Properties lane (M4 lane 6): the live round trip, headless.
//
//   npx tsx scripts/ae-export-spike/essential/roundtrip.mts [--work DIR]
//
// The two U fixtures (scripts/fixtures/ae-export/graphs/fixtures.mts) →
// buildAeSceneForEditor → packages; ONE aerender launch (calibrate/ae.mts's
// env-gated startup hook, under the AE lock) builds each with build.jsx, then
// roundtrip.jsx changes the controls the way an After Effects user would and
// reads the driven properties back; a plain aerender launch per project
// renders the queued frames. Checks:
//   u-controls         the Controls null's sliders / angle / color moved →
//                      rotation, position, rectangle size and fill color
//                      equal what the scene walk writes for the SAME change
//                      made in toolbox (a second walk with the new params),
//                      and the render shows the moved, turned, recolored chip
//   u-group-essential  the precomp's Essential Graphics list both inputs in
//                      order; an Essential Properties override on the main
//                      comp's precomp layer reaches the disc inside (render),
//                      while the precomp rendered alone keeps its own values
// Never contacts the After Effects GUI.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry } from "../../ae-export/harness.mts";
import { readAeTiff, renderQueue, renderedFile, REPO, runAeJob } from "../calibrate/ae.mts";

const args = process.argv.slice(2);
const wi = args.indexOf("--work");
const WORK = wi >= 0 ? args[wi + 1] : join(tmpdir(), `toolbox-ae-essential-rt-${Date.now()}`);
mkdirSync(WORK, { recursive: true });

await loadRegistry();
const { SCENE_FIXTURES, buildFixture } = await import("../../fixtures/ae-export/graphs/fixtures.mts");
const { buildAeSceneForEditor } = await import("@/lib/ae-export/scene");
type Fixture = (typeof SCENE_FIXTURES)[number];

const fixture = (name: string) => SCENE_FIXTURES.find((f) => f.name === name)!;
async function walk(f: Fixture, patch?: (nodes: any[]) => void) {
  const { nodes, edges } = await buildFixture(f);
  patch?.(nodes);
  return buildAeSceneForEditor(nodes, edges, {
    env: { composition: { id: `comp-${f.name}`, name: f.title, width: f.comp.width, height: f.comp.height, fps: f.comp.fps, durationFrames: f.comp.frames } },
    name: f.title,
    toolboxVersion: "fixture",
    generatedAt: "2026-10-21T00:00:00.000Z",
  });
}
const params = (nodes: any[], id: string) => nodes.find((n) => n.id === id)!.data.params;

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
};
const close = (a: unknown, b: unknown, tol = 1e-4) => {
  const x = Array.isArray(a) ? a : [a];
  const y = Array.isArray(b) ? b : [b];
  return y.every((v, i) => typeof x[i] === "number" && Math.abs((x[i] as number) - (v as number)) <= tol);
};

// --- u-controls: the change made in AE, and the same change made in toolbox ---------------
const W = 1280;
const uc = fixture("u-controls");
const ucScene = await walk(uc);
const CHANGE = { rotate: 45, translateX: 200 / W, size: 240 / W, color: [0, 0.4, 1] as const };
const ucMoved = await walk(uc, (nodes) => {
  params(nodes, "turn").rotate = CHANGE.rotate;
  params(nodes, "turn").translateX = CHANGE.translateX;
  params(nodes, "size").value = CHANGE.size;
  params(nodes, "paint").color = "#0066ff";
});
const chipOf = (b: Awaited<ReturnType<typeof walk>>) => {
  const L = b.scene.comps.find((c) => c.id === b.scene.main)!.layers.find((l) => l.id === "paint")!;
  const paint = L.contents![0] as any;
  const turn = paint.contents[0];
  return { rotation: turn.transform.rotation.v, position: turn.transform.position.v, size: turn.contents[0].size.v, color: [...paint.contents[1].color.v, 1] };
};
const toolboxMoved = chipOf(ucMoved);
const chipPath = ["ADBE Root Vectors Group", "Paint", "ADBE Vectors Group"];
const turnPath = [...chipPath, "Turn"];

// --- u-group-essential --------------------------------------------------------------------
const ug = fixture("u-group-essential");
const ugScene = await walk(ug);
const inner = ugScene.scene.comps.find((c) => c.id !== ugScene.scene.main)!;
const fillPath = ["ADBE Root Vectors Group", "Fill", "ADBE Vectors Group"];
const OVERRIDE = { radius: 150 / W, color: [1, 0, 0, 1] };

const packages = [
  {
    name: "u-controls",
    build: ucScene,
    reads: [
      { id: "rotation", comp: uc.title, layer: "Chip", path: [...turnPath, "ADBE Vector Transform Group", "ADBE Vector Rotation"] },
      { id: "position", comp: uc.title, layer: "Chip", path: [...turnPath, "ADBE Vector Transform Group", "ADBE Vector Position"] },
      { id: "size", comp: uc.title, layer: "Chip", path: [...turnPath, "ADBE Vectors Group", "Rectangle", "ADBE Vector Rect Size"] },
      { id: "color", comp: uc.title, layer: "Chip", path: [...chipPath, "ADBE Vector Graphic - Fill", "ADBE Vector Fill Color"] },
    ],
    edits: [
      { comp: uc.title, layer: "Controls", effect: "Turn · Rotate (°)", value: CHANGE.rotate },
      { comp: uc.title, layer: "Controls", effect: "Turn · Translate X", value: CHANGE.translateX },
      { comp: uc.title, layer: "Controls", effect: "Size · Value", value: CHANGE.size },
      { comp: uc.title, layer: "Controls", effect: "Paint · Color", value: [...CHANGE.color, 1] },
    ],
    renders: [{ comp: uc.title, frame: 0, prefix: "main" }],
    essential: [] as { comp: string; layer: string }[],
    controllers: [] as string[],
  },
  {
    name: "u-group-essential",
    build: ugScene,
    reads: [
      { id: "size", comp: inner.name, layer: "Fill", path: [...fillPath, "Circle", "ADBE Vector Ellipse Size"] },
      { id: "color", comp: inner.name, layer: "Fill", path: [...fillPath, "ADBE Vector Graphic - Fill", "ADBE Vector Fill Color"] },
    ],
    edits: [
      { comp: ug.title, layer: "Badges", essential: "Radius", value: OVERRIDE.radius },
      { comp: ug.title, layer: "Badges", essential: "Color", value: OVERRIDE.color },
    ],
    renders: [
      { comp: ug.title, frame: 0, prefix: "main" },
      { comp: inner.name, frame: 0, prefix: "inner" },
    ],
    essential: [{ comp: ug.title, layer: "Badges" }],
    controllers: [inner.name],
  },
];

const cfgPackages = packages.map((p) => {
  if (p.build.problems.length) throw new Error(`${p.name}: ${p.build.problems.join("; ")}`);
  const dir = join(WORK, `${p.name}.aepkg`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "renders"), { recursive: true });
  writeFileSync(join(dir, "scene.json"), JSON.stringify(p.build.scene, null, 2));
  copyFileSync(join(REPO, "src/lib/ae-export/runtime/build.jsx"), join(dir, "build.jsx"));
  const { build: _b, ...rest } = p;
  void _b;
  return { ...rest, dir };
});
const project = (name: string) => join(WORK, `${name}.aepkg`, `${name}.aep`);

console.log(`packages: ${WORK}`);
const job = await runAeJob("essential-roundtrip", "../essential/roundtrip.jsx", { packages: cfgPackages, project: join(WORK, "startup-none.aep") }, WORK, 300_000);
console.log(`build + edit launch: ${job.seconds.toFixed(1)} s (aerender exit ${job.code})`);
if (job.out.errors.length) check("job errors", false, job.out.errors);
for (const p of packages) await renderQueue(project(p.name), WORK, 300_000);

const px = async (pkg: string, prefix: string, x: number, y: number) => {
  const f = renderedFile(join(WORK, `${pkg}.aepkg`, "renders"), prefix);
  if (!f) return null;
  const img = await readAeTiff(f);
  const o = (y * img.width + x) * 4;
  return Array.from(img.data.slice(o, o + 4)).map((v) => Math.round(v * 255));
};
const pixel = async (pkg: string, prefix: string, x: number, y: number, want: (number | null)[], label: string) => {
  const got = await px(pkg, prefix, x, y);
  check(`${pkg} ${prefix} (${x}, ${y}) ${label}`, !!got && want.every((w, i) => w === null || Math.abs(got[i] - w) <= 3), { got, want });
};

// u-controls
{
  const r = job.out.packages["u-controls"];
  console.log("\nu-controls");
  if (r?.errors?.length) check("job steps", false, r.errors);
  check("build.jsx ok, no problems, no warnings", r?.build?.ok === true && !r.build.problems.length && !r.build.warnings.length, r?.build);
  const before = chipOf(ucScene);
  for (const k of ["rotation", "position", "size", "color"] as const) {
    check(`${k} before the change: the scene's value (${JSON.stringify(before[k])})`, close(r.before[k]?.value, before[k]), r.before[k]);
    check(`${k}: an expression that evaluates cleanly`, r.before[k]?.expression?.includes('layer("Controls")') && r.before[k]?.error === "", r.before[k]);
    check(`${k} after the Controls change = toolbox's walk of the same change (${JSON.stringify(toolboxMoved[k])})`, close(r.after[k]?.value, toolboxMoved[k], 1e-3), r.after[k]);
  }
  await pixel("u-controls", "main", 600, 360, [0, 102, 255, 255], "the moved chip's centre, recolored");
  await pixel("u-controls", "main", 600, 200, [0, 102, 255, 255], "a corner of the 240 px square turned 45° (|dx|+|dy| = 160 < 170)");
  await pixel("u-controls", "main", 710, 470, [null, null, null, 0], "inside the unturned square, outside the turned one");
  await pixel("u-controls", "main", 400, 360, [null, null, null, 0], "the old position");
}

// u-group-essential
{
  const r = job.out.packages["u-group-essential"];
  console.log("\nu-group-essential");
  if (r?.errors?.length) check("job steps", false, r.errors);
  check("build.jsx ok, no problems, no warnings", r?.build?.ok === true && !r.build.problems.length && !r.build.warnings.length, r?.build);
  const ctl = r.controllers[inner.name];
  check(`the precomp's Essential Graphics: Radius, Color in order (template "${inner.name}")`, JSON.stringify(ctl?.names) === JSON.stringify(["Radius", "Color"]) && ctl?.template === inner.name, ctl);
  const ep = r.essential[`${ug.title}/Badges`];
  check("the main comp's precomp layer shows them as Essential Properties", JSON.stringify(ep?.map((x: any) => x.name)) === JSON.stringify(["Radius", "Color"]), ep);
  check("Essential Properties start at the toolbox values", close(ep?.[0]?.value, 90 / W, 1e-6) && close(ep?.[1]?.value, [0.2, 0.8, 0.4, 1], 1e-3), ep);
  check("inside the precomp, the disc reads its Controls (size 180 px, the Color input)", close(r.before.size?.value, [180, 180]) && close(r.before.color?.value, [0.2, 0.8, 0.4, 1], 1e-3) && r.before.size?.error === "", r.before);
  await pixel("u-group-essential", "main", 640, 360, [255, 0, 0, 255], "main comp: the Color override");
  await pixel("u-group-essential", "main", 770, 360, [255, 0, 0, 255], "main comp: inside the Radius override (150 px)");
  await pixel("u-group-essential", "main", 800, 360, [null, null, null, 0], "main comp: outside it");
  await pixel("u-group-essential", "inner", 640, 360, [51, 204, 102, 255], "the precomp alone keeps its own Color");
  await pixel("u-group-essential", "inner", 770, 360, [null, null, null, 0], "…and its own Radius (90 px)");
}

writeFileSync(join(WORK, "roundtrip.json"), JSON.stringify(job.out, null, 2));
console.log(failures ? `\nroundtrip: ${failures} FAILED (${join(WORK, "roundtrip.json")})` : `\nroundtrip: all checks passed (${join(WORK, "roundtrip.json")})`);
process.exit(failures ? 1 : 0);
