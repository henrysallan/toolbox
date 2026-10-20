// buildAeSceneForEditor (src/lib/ae-export/scene/) on every registry fixture
// in scripts/fixtures/ae-export/graphs/fixtures.mts: no problems, a scene
// validateAeScene accepts, byte-identical output for the same graph, and
// the scene JSON (plus bakes, bundles, presets, files, warnings) matches its
// <name>.snapshot.json next to the fixtures up to last-ulp
// float noise (CI is Linux; snapshots are written on macOS).
//
//   npx tsx scripts/check-ae-export.mts scene-snap            this area
//   npx tsx scripts/check-ae-export.mts scene-snap --update   rewrite the snapshots

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeChecker, loadRegistry } from "./harness.mts";
import { snapshotDrift } from "../skia/snapshot-diff.ts";
import type { AeSceneBuild } from "@/lib/ae-export/scene";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/ae-export/graphs");
const UPDATE = process.argv.includes("--update");

// What a snapshot pins: the scene plus the side outputs, with shader bundle
// ids (a content hash the translator lane owns) normalized away.
export function snapshotText(b: AeSceneBuild): string {
  const ids = new Map(b.bundles.map((x, i) => [x.id, `bundle#${i + 1}`]));
  const norm = (v: unknown): unknown => {
    if (typeof v === "number") return ids.get(v) ?? v;
    if (typeof v === "string") {
      let s = v;
      for (const [id, name] of ids) s = s.replace(new RegExp(`(?<![\\d.])${id}(?![\\d.])`, "g"), name);
      return s;
    }
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object" && !(v instanceof Uint8Array)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)]));
    return v;
  };
  const text = JSON.stringify(
    norm({
      scene: b.scene,
      bakes: b.bakes,
      bundles: b.bundles.map((x) => ({ inputs: x.inputs, params: x.params, readsTime: x.readsTime, fps: x.fps, loopFrames: x.loopFrames })),
      presets: b.presets.map((p) => ({ id: p.id, path: p.path, bytes: p.bytes.length })),
      files: b.files.map((f) => ({ path: f.path, text: f.text })),
      assets: b.assets,
      problems: b.problems,
      warnings: b.warnings,
    }),
    null,
    1
  );
  return `${text}\n`;
}

export default async function run(): Promise<number> {
  const c = makeChecker("scene-snapshots");
  await loadRegistry();
  const { validateAeScene } = await import("@/lib/ae-export/runtime/validate");
  const { SCENE_FIXTURES, sceneOf } = await import("../fixtures/ae-export/graphs/fixtures.mts");
  for (const f of SCENE_FIXTURES) {
    const b = await sceneOf(f);
    const again = await sceneOf(f);
    const problems = validateAeScene(b.scene);
    c.check(`${f.name}: validateAeScene accepts the scene`, problems.length === 0, problems.slice(0, 5));
    c.check(`${f.name}: no export problems`, b.problems.length === 0, b.problems);
    const have = snapshotText(b);
    c.check(`${f.name}: the same graph gives byte-identical output`, have === snapshotText(again));
    const file = join(DIR, `${f.name}.snapshot.json`);
    if (UPDATE) {
      writeFileSync(file, have);
      c.check(`${f.name}: snapshot rewritten`, true);
      continue;
    }
    if (!existsSync(file)) {
      c.check(`${f.name}: has a snapshot`, false, `${f.name}.snapshot.json is missing — npx tsx scripts/check-ae-export.mts scene-snap --update`);
      continue;
    }
    const drift = snapshotDrift(`${f.name}.snapshot.json`, readFileSync(file, "utf8"), have);
    c.check(`${f.name}: matches its snapshot`, !drift, drift ? `${drift}\n       (npx tsx scripts/check-ae-export.mts scene-snap --update after a deliberate change)` : "");
  }
  return c.failures;
}
