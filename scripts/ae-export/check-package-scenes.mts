// The scene walk and the package writer together, offline: every graph in
// scripts/fixtures/ae-export/graphs/fixtures.mts → buildAeSceneForEditor →
// createAeExportRunner with a fake renderer and an in-memory folder sink.
// check-package-runner holds the runner to hand-made scenes and
// check-scene-* hold the walk; this holds the hand-off between them (every
// file the scene names gets written, scene.json validates, the shader
// bundles and presets land, bakes stream every frame). The live AE build of
// the same graphs is roundtrip.mts.

import { makeChecker, loadRegistry } from "./harness.mts";
import { SCENE_FIXTURES, sceneOf } from "../fixtures/ae-export/graphs/fixtures.mts";
import { createAeExportRunner, type AeFrameRenderer, type AePackageSink } from "@/lib/ae-export/package";
import { validateAeScene } from "@/lib/ae-export/runtime/validate";

interface Written {
  files: Map<string, Uint8Array | string>;
  frames: Map<string, number>;
}

function memorySink(root: string, out: Written): AePackageSink {
  return {
    kind: "folder",
    location: `/tmp/${root}`,
    warnings: [],
    async writeFile(path, data) {
      out.files.set(path, data);
    },
    async encodeBake(bake) {
      out.frames.set(bake.path, 0);
      return {
        writeFrame: async () => {
          out.frames.set(bake.path, (out.frames.get(bake.path) ?? 0) + 1);
        },
        finish: async () => {
          out.files.set(bake.path, new Uint8Array(16));
          return { bytes: 16 };
        },
        abort: async () => {},
      };
    },
    async finish() {},
  };
}

const solid: AeFrameRenderer = async (_target, ticks, size, onFrame) => {
  let i = 0;
  for (const tick of ticks) await onFrame({ tick, index: i++, rgba: new Uint8Array(size.width * size.height * 4).fill(128) });
};

export default async function run(): Promise<number> {
  const c = makeChecker("package-scenes");
  await loadRegistry();
  for (const f of SCENE_FIXTURES) {
    const b = await sceneOf(f);
    const out: Written = { files: new Map(), frames: new Map() };
    const runAe = createAeExportRunner({
      toolboxVersion: "check",
      buildScene: () => b,
      renderFrames: solid,
      readAsset: async () => new Uint8Array(8),
      openSink: async (_d, root) => memorySink(root, out),
    });
    const r = await runAe({ policy: {}, overrides: {}, fused: {}, name: f.title, destination: "folder", build: false });
    if (b.problems.length) {
      c.check(`${f.name}: the scene's problems stop the export`, !r.ok && b.problems.every((p) => r.problems.some((q) => q.includes(p))), r.problems);
      continue;
    }
    c.check(`${f.name}: exports with no problems`, r.ok && r.problems.length === 0, r.problems);
    const missing = (r.files ?? []).filter((p) => !out.files.has(p));
    c.check(`${f.name}: every listed file is written (${r.files?.length ?? 0})`, !!r.files?.length && missing.length === 0, missing);
    const sceneText = out.files.get("scene.json");
    const scene = typeof sceneText === "string" ? JSON.parse(sceneText) : null;
    const v = scene ? validateAeScene(scene) : null;
    c.check(`${f.name}: scene.json validates`, !!v && v.length === 0, v);
    c.check(`${f.name}: build.jsx, toolbox.json, README.txt`, ["build.jsx", "toolbox.json", "README.txt"].every((p) => out.files.has(p)));
    c.check(`${f.name}: a .tbxfx per shader bundle (${b.bundles.length})`, b.bundles.every((s) => out.files.has(`shaders/${s.id}.tbxfx`)));
    c.check(`${f.name}: every preset (${b.presets.length})`, b.presets.every((p) => out.files.has(p.path)));
    const short = b.bakes.filter((k) => out.frames.get(k.path) !== k.frames[1] - k.frames[0] + 1).map((k) => `${k.path}: ${out.frames.get(k.path) ?? 0}`);
    c.check(`${f.name}: each bake streams every frame (${b.bakes.length})`, short.length === 0, short);
  }
  return c.failures;
}
