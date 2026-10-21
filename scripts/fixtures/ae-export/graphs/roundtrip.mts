// The scene walk's After Effects round trip (headless): every fixture in
// fixtures.mts → buildAeSceneForEditor → a package folder the M0 spike runner
// builds through aerender (scripts/ae-export-spike/run.mts --fixtures), then
// renders the probe frames and samples the probe pixels.
//
//   npx tsx scripts/fixtures/ae-export/graphs/roundtrip.mts            all fixtures
//   npx tsx scripts/fixtures/ae-export/graphs/roundtrip.mts a- c-      by name
//   npx tsx scripts/fixtures/ae-export/graphs/roundtrip.mts --no-ae    write only
//
// The package writer (package lane) renders bakes; here each bake is a
// placeholder clip (ffmpeg, a flat translucent color) so AE has real footage
// to import. Shader bundles go to shaders/<id>.tbxfx; the runner points the
// Toolbox Shader host at them (TBX_SHADER_BUNDLES). Gradients that own their
// layer take the SVG route (the default); .ffx presets cannot apply headless
// (spec §13), so the fixtures probe only SVG-seeded ones. Needs After Effects 26.x
// (AE_DIR) and never touches the After Effects GUI.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry } from "../../../ae-export/harness.mts";
import { SCENE_FIXTURES, sceneOf } from "./fixtures.mts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const args = process.argv.slice(2);
const noAe = args.includes("--no-ae");
const filters = args.filter((a) => !a.startsWith("--"));
const OUT = join(tmpdir(), `toolbox-ae-scene-${Date.now()}`);

await loadRegistry();
const { writeTbxfx } = await import("@/lib/ae-export/shader");
mkdirSync(OUT, { recursive: true });
let n = 0;
for (const f of SCENE_FIXTURES) {
  if (filters.length && !filters.some((x) => f.name.includes(x))) continue;
  const b = await sceneOf(f);
  if (b.problems.length) {
    console.log(`${f.name}: ${b.problems.length} problem(s) — skipped:\n  ${b.problems.join("\n  ")}`);
    continue;
  }
  writeFileSync(join(OUT, `${f.name}.scene.json`), JSON.stringify(b.scene, null, 2));
  const files = join(OUT, `${f.name}.files`);
  mkdirSync(join(files, "footage"), { recursive: true });
  for (const bundle of b.bundles) {
    mkdirSync(join(files, "shaders"), { recursive: true });
    writeFileSync(join(files, "shaders", `${bundle.id}.tbxfx`), writeTbxfx(bundle));
  }
  for (const p of b.presets) {
    mkdirSync(join(files, "presets"), { recursive: true });
    writeFileSync(join(files, p.path), p.bytes);
  }
  for (const t of b.files) writeFileSync(join(files, t.path), t.text);
  for (const k of b.bakes) {
    const dur = (k.frames[1] - k.frames[0] + 1) / f.comp.fps;
    const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=0xff00ff@0.5:s=${k.size[0]}x${k.size[1]}:r=${f.comp.fps}:d=${dur},format=rgba`, "-c:v", "qtrle", "-pix_fmt", "argb", join(files, k.path)]);
    if (r.status !== 0) throw new Error(`ffmpeg placeholder for ${k.id}: ${r.stderr}`);
  }
  for (const a of b.assets) {
    // 3-D models (lane 5) carry their file's bytes; other assets have none.
    const model = a.source.kind === "model" ? f.models?.[a.source.ref] : undefined;
    if (!model) throw new Error(`${f.name}: asset ${a.id} needs a source file — fixtures carry none`);
    writeFileSync(join(files, a.path), model());
  }
  const main = b.scene.comps.find((c) => c.id === b.scene.main)!;
  // A pixel without `want` expects a soft edge: run.mts's predicate form.
  const pixels = f.probe?.pixels.map((p) => (p.want ? p : { ...p, soft: true }));
  if (f.probe) writeFileSync(join(OUT, `${f.name}.probe.json`), JSON.stringify({ render: { comp: main.name, frames: f.probe.frames }, pixels }, null, 2));
  n++;
}
console.log(`wrote ${n} scene package source(s) to ${OUT}`);
if (noAe) process.exit(0);
const r = spawnSync("npx", ["tsx", join(REPO, "scripts/ae-export-spike/run.mts"), "--fixtures", OUT, "--out", join(OUT, "packages")], { stdio: "inherit", cwd: REPO });
process.exit(r.status ?? 1);
