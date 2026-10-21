// The AE package's files (src/lib/ae-export/package/files.ts, sinks.ts zip):
// what each fixture scene's package holds, that the zip holds the same under
// "<name>.aepkg/", the README's how-to and report (native / approximate /
// sampled / shader / baked / blocked, fonts, the Toolbox Shader version),
// toolbox.json, and every refusal assembleAePackage makes before anything
// is written. Pure — fixtures wrapped as AeSceneBuild, no AE, no DOM.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

import { loadRegistry, makeChecker } from "./harness.mts";
import { syncChannelInputs } from "@/engine/expr-channels";
import { BUILD_JSX_SOURCE } from "@/lib/ae-export/runtime";
import { synthesizeScenePresets } from "@/lib/ae-export/runtime/ffx";
import {
  aePackagePaths,
  aePackageReport,
  aeReadme,
  assembleAePackage,
  type AePackageManifest,
} from "@/lib/ae-export/package/files";
import { zipSink } from "@/lib/ae-export/package/sinks";
import type { AeSceneBuild } from "@/lib/ae-export/scene";
import { DEFAULT_AE_POLICY, tbxShaderParamMatch, type AeExportPlan, type AeScene, type AeShaderBundle } from "@/lib/ae-export/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURES = join(REPO, "scripts/fixtures/ae-export");
const AT = "2026-10-20T12:00:00.000Z";

function planOf(scene: AeScene, extra: Partial<AeExportPlan> = {}): AeExportPlan {
  const main = scene.comps.find((c) => c.id === scene.main)!;
  return {
    route: scene.report.route,
    composition: { id: "c1", name: main.name, width: main.width, height: main.height, fps: main.fps, durationFrames: Math.round(main.duration * main.fps) },
    layers: [],
    shaderRegions: [],
    bakes: [],
    expressions: [],
    blocked: [],
    approximations: [],
    estimates: { layers: 0, keyframes: 0, footageMB: 0 },
    fonts: scene.report.requires.fonts,
    policy: DEFAULT_AE_POLICY,
    warnings: [],
    ...extra,
  };
}

function wrap(scene: AeScene, extra: Partial<AeSceneBuild> = {}): AeSceneBuild {
  const presets = synthesizeScenePresets(scene).map((p) => ({ id: scene.presets.find((x) => x.path === p.path)!.id, path: p.path, bytes: p.bytes }));
  const files = scene.footage.filter((f) => f.kind === "svg").map((f) => ({ path: f.path, text: "<svg/>" }));
  const assets = scene.footage.filter((f) => f.kind !== "svg").map((f) => ({ id: f.id, path: f.path, source: { kind: "image" as const, ref: `/assets/${f.id}` } }));
  return { plan: planOf(scene), scene, bakes: [], bundles: [], presets, files, assets, problems: [], warnings: [], ...extra };
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

export default async function run(): Promise<number> {
  const c = makeChecker("package-files");
  await loadRegistry();
  const { bundleFromGlslExpression } = await import("@/lib/ae-export/shader/bundle");

  // ---- every fixture's package -------------------------------------------------
  const fixtures = readdirSync(FIXTURES).filter((f) => f.endsWith(".scene.json")).sort();
  for (const f of fixtures) {
    const scene = JSON.parse(readFileSync(join(FIXTURES, f), "utf8")) as AeScene;
    const build = wrap(scene);
    const a = assembleAePackage(build, { name: `Fixture ${f}`, toolboxVersion: "0.0.0-gate", exportedAt: AT, output: "out-1:out" });
    const paths = aePackagePaths(a);
    const want = [
      "README.txt",
      ...["build.jsx", "scene.json", "toolbox.json", ...scene.presets.map((p) => p.path), ...scene.footage.map((x) => x.path)].sort((x, y) => x.localeCompare(y)),
    ];
    c.check(`${f}: assembles with no problems`, a.problems.length === 0, a.problems);
    c.check(`${f}: file list = README + build.jsx + scene.json + toolbox.json + presets + footage`, JSON.stringify(paths) === JSON.stringify(want), { paths, want });
    const byPath = new Map(a.files.map((x) => [x.path, x]));
    c.check(`${f}: build.jsx is BUILD_JSX_SOURCE verbatim`, byPath.get("build.jsx")?.text === BUILD_JSX_SOURCE);
    c.check(`${f}: scene.json round-trips`, JSON.stringify(JSON.parse(byPath.get("scene.json")!.text!)) === JSON.stringify(scene));
    c.check(`${f}: root folder is "<name>.aepkg"`, a.root === `Fixture ${f}.aepkg`, a.root);
  }

  // ---- a scene with a shader bundle and a bake (the d/e-style rest is above) ----
  const body = `// ch("radius", 0.35, 0.0, 1.0)\n// color("tint", "#ff8000")\nfragColor = vec4(tint.rgb, step(length(v_uv - 0.5), radius));`;
  const br = bundleFromGlslExpression({ inputs: syncChannelInputs([], body), expression: body }, { name: "Ring", fps: 30, loopFrames: 0, canvas: { width: 640, height: 360 } });
  if (!br.ok) throw new Error(JSON.stringify(br.errors));
  const bundle: AeShaderBundle = br.bundle;
  const base = JSON.parse(readFileSync(join(FIXTURES, "a-circle.scene.json"), "utf8")) as AeScene;
  const scene = clone(base);
  const main = scene.comps.find((x) => x.id === scene.main)!;
  main.layers.push({
    id: "ring",
    name: "Ring",
    kind: "solid",
    inPoint: 0,
    outPoint: 2,
    startTime: 0,
    blendingMode: "normal",
    solid: { color: [0, 0, 0], width: main.width, height: main.height },
    transform: { anchor: { v: [main.width / 2, main.height / 2] }, position: { v: [main.width / 2, main.height / 2] }, scale: { v: [100, 100] }, rotation: { v: 0 }, opacity: { v: 100 } },
    effects: [{ match: "TBX Shader", bundle: String(bundle.id), props: { [tbxShaderParamMatch("bundle")]: { v: bundle.id } } }],
  } as any);
  main.layers.push({
    id: "dust",
    name: "Dust",
    kind: "footage",
    source: "dust",
    inPoint: 0,
    outPoint: 2,
    startTime: 0,
    blendingMode: "normal",
    transform: { anchor: { v: [160, 90] }, position: { v: [960, 540] }, scale: { v: [100, 100] }, rotation: { v: 0 }, opacity: { v: 100 } },
  } as any);
  scene.footage.push({ id: "dust", path: "footage/dust.mov", kind: "video", alpha: "straight", fps: 30 });
  scene.report = {
    route: "direct+bake",
    native: [
      { id: "c1", type: "circle", name: "Circle", class: "vector", fidelity: "exact" },
      { id: "k1", type: "noise", name: "Wobble", class: "expression", fidelity: "sampled", note: "per-frame keys" },
    ],
    approx: [{ id: "b1", type: "blur", name: "Soft", class: "effect", fidelity: "approx", note: "Gaussian Blur radius ×0.5" }],
    shader: [{ id: "g1", type: "glsl-expression", name: "Ring", class: "shader", fidelity: "exact" }],
    baked: [{ id: "dust", type: "particles", name: "Dust", class: "bake", fidelity: "bake", note: "simulation" }],
    blocked: [],
    warnings: ["anchor count changes at frame 12"],
    requires: { fonts: ["InterBrex-Medium"], shaderHost: "1.0.0" },
  };
  const rich = wrap(scene, {
    assets: [],
    bundles: [bundle],
    bakes: [{ id: "dust", output: "dust-1:aux:image", frames: [0, 59], size: [320, 180], codec: "prores4444", path: "footage/dust.mov" }],
    warnings: ["text layer Title uses a fallback font"],
  });
  rich.plan.fonts = ["ArialMT"];
  const a = assembleAePackage(rich, { name: "Hero", toolboxVersion: "0.6.1", exportedAt: AT, output: "out-1:out" });
  c.check("bundle + bake scene assembles with no problems", a.problems.length === 0, a.problems);
  const paths = aePackagePaths(a);
  c.check("shaders/<id>.tbxfx and footage/dust.mov are in the file list", paths.includes(`shaders/${bundle.id}.tbxfx`) && paths.includes("footage/dust.mov"), paths);
  c.check("the bake is left to the runner (no bytes in the static files)", !a.files.some((x) => x.path === "footage/dust.mov") && a.footage.bakes.length === 1);
  const tbx = a.files.find((x) => x.path === `shaders/${bundle.id}.tbxfx`)?.text ?? "";
  c.check("the .tbxfx is the bundle as JSON with its id", JSON.parse(tbx).id === bundle.id && JSON.parse(tbx).format === "tbxfx");
  const manifest = JSON.parse(a.files.find((x) => x.path === "toolbox.json")!.text!) as AePackageManifest;
  c.check(
    "toolbox.json: format, output, main comp, bundles, bakes",
    manifest.format === "toolbox-ae-package" &&
      manifest.output === "out-1:out" &&
      manifest.main.name === "A Circle" &&
      manifest.bundles[0]?.path === `shaders/${bundle.id}.tbxfx` &&
      manifest.bakes[0]?.output === "dust-1:aux:image" &&
      manifest.exportedAt === AT,
    manifest
  );

  // ---- README: how to run + the report ---------------------------------------------
  const report = aePackageReport(rich, [{ id: "dust", path: "footage/dust.mov", frames: [0, 59], codec: "prores4444", bytes: 3 * 1048576 }]);
  const has = (s: string, needle: string) => s.includes(needle);
  c.check("report: route", report.startsWith("Route: direct+bake"));
  c.check("report: native excludes sampled lines", has(report, "Native (1):\n  - Circle (c1)"), report);
  c.check("report: approximate with the note", has(report, "Approximate (1):\n  - Soft (b1) — Gaussian Blur radius ×0.5"), report);
  c.check("report: sampled to per-frame keys", has(report, "Sampled to per-frame keys (1):\n  - Wobble (k1) — per-frame keys"), report);
  c.check("report: shader regions and bundles", has(report, "Toolbox Shader regions (1):") && has(report, `Ring → shaders/${bundle.id}.tbxfx (Toolbox Shader ${bundle.hostMin} or later)`), report);
  c.check("report: baked footage with frames, size, codec, MB and why", has(report, "footage/dust.mov — dust-1:aux:image, frames 0–59, 320×180, prores4444, 3.0 MB — simulation"), report);
  c.check("report: blocked", has(report, "Blocked (0): none"));
  c.check("report: needs — host version and fonts (scene ∪ plan)", has(report, "Needs: the Toolbox Shader plug-in 1.0.0 or later; fonts: ArialMT, InterBrex-Medium."), report);
  c.check("report: warnings from the scene report and the build", has(report, "anchor count changes at frame 12") && has(report, "text layer Title uses a fallback font"));
  const failed = aePackageReport(rich, [{ id: "dust", path: "footage/dust.mov", frames: [0, 59], codec: "prores4444", error: "ffmpeg exited 1" }]);
  c.check("report: a failed bake says FAILED with the reason", has(failed, "FAILED: ffmpeg exited 1"));
  const switched = aePackageReport(rich, [{ id: "dust", path: "footage/dust.mov", frames: [0, 59], codec: "qtrle", bytes: 1048576 }]);
  c.check("report: a bake line names the codec written (a zip's qtrle), not the one asked for", has(switched, "qtrle, 1.0 MB") && !has(switched, "prores4444"), switched);
  const readme = aeReadme(rich, { name: "Hero", toolboxVersion: "0.6.1", exportedAt: AT, files: paths, root: "Hero 2.aepkg" });
  c.check("README: how to run (Run Script File → build.jsx, the .aep it saves, keep the folder together)", has(readme, "File → Scripts → Run Script File…, and pick build.jsx") && has(readme, "saves Hero 2.aep in this folder") && has(readme, "Keep the folder together"), readme.slice(0, 600));
  c.check("README: the write-files preference", has(readme, "Allow Scripts to Write Files and Access Network"));
  c.check("README: what the AE machine needs", has(readme, "The Toolbox Shader plug-in, version 1.0.0 or later (shaders/ holds 1 bundle).") && has(readme, "Fonts: ArialMT, InterBrex-Medium."), readme);
  c.check("README: the report and the file list", has(readme, "REPORT\nRoute: direct+bake") && has(readme, "FILES\n- README.txt\n- build.jsx"), readme);
  const gradReadme = aeReadme(wrap(JSON.parse(readFileSync(join(FIXTURES, "c-gradient.scene.json"), "utf8"))), { name: "G", toolboxVersion: "x", exportedAt: AT, files: [] });
  c.check("README: gradient presets apply only inside the After Effects app", has(gradReadme, "3 gradient presets (presets/*.ffx) apply only when build.jsx runs inside the"));

  // ---- refusals -------------------------------------------------------------------------
  const refuse = (label: string, b: AeSceneBuild, re: RegExp) => {
    const r = assembleAePackage(b, { name: "X", toolboxVersion: "x", exportedAt: AT });
    c.check(`refused: ${label}`, r.problems.some((p) => re.test(p)), r.problems);
  };
  refuse("the scene build's own problems pass through", { ...rich, problems: ["Live Input needs a recorded take"] }, /recorded take/);
  refuse("a scene validateAeScene rejects", { ...wrap(base), scene: { ...clone(base), main: "nope" } }, /scene\.json/);
  const gradient = JSON.parse(readFileSync(join(FIXTURES, "c-gradient.scene.json"), "utf8")) as AeScene;
  refuse("a preset with no .ffx bytes", { ...wrap(gradient), presets: wrap(gradient).presets.slice(1) }, /has no \.ffx bytes/);
  refuse("an effect naming a bundle the build lacks", { ...rich, bundles: [] }, /no bundle for/);
  refuse("an invalid bundle (edited after export: id ≠ content hash)", { ...rich, bundles: [{ ...bundle, name: "Edited" }] }, /does not match the content hash/);
  refuse("footage nobody writes", { ...rich, bakes: [] }, /neither baked, copied nor written/);
  refuse("a bake that is not a .mov", { ...rich, bakes: [{ ...rich.bakes[0], path: "footage/dust.webm" }], scene: { ...scene, footage: scene.footage.map((x) => (x.id === "dust" ? { ...x, path: "footage/dust.webm" } : x)) } }, /must be a \.mov/);
  refuse("a path that climbs out", { ...rich, files: [{ path: "../evil.txt", text: "x" }] }, /leaves its folder/);
  refuse("a path with a quote", { ...rich, files: [{ path: 'notes/"x".txt', text: "x" }] }, /quote/);
  refuse("a file that would overwrite scene.json", { ...rich, files: [{ path: "scene.json", text: "{}" }] }, /package's own scene\.json/);
  refuse("two outputs at one path (case-insensitive, like the Mac's disk)", { ...rich, files: [{ path: "Footage/Dust.mov", text: "x" }] }, /is also/);
  refuse("an empty bake range", { ...rich, bakes: [{ ...rich.bakes[0], frames: [10, 5] }] }, /is not a range/);

  // ---- the zip holds the same files under <name>.aepkg/ ------------------------------
  let saved: { blob: Blob; name: string } | null = null;
  const sink = zipSink(a.root, {
    encode: async () => {
      let out: Uint8Array | null = null;
      let n = 0;
      return {
        writeFrame: async () => {
          n++;
        },
        finish: async () => {
          out = new Uint8Array([0x6d, 0x6f, 0x6f, 0x76, n]);
          return { bytes: out.length };
        },
        abort: async () => {},
        bytes: () => out,
      };
    },
    save: (blob, name) => {
      saved = { blob, name };
    },
  });
  for (const f of a.files) await sink.writeFile(f.path, f.bytes ?? f.text ?? "");
  const enc = await sink.encodeBake(rich.bakes[0], 30);
  for (let i = 0; i < 3; i++) await enc.writeFrame(new Uint8Array(320 * 180 * 4));
  const fin = await enc.finish();
  await sink.writeFile("README.txt", readme);
  await sink.finish();
  const got = saved as { blob: Blob; name: string } | null;
  c.check('the zip downloads as "<name>.aepkg.zip"', got?.name === "Hero.aepkg.zip" && sink.location === "Hero.aepkg.zip", got?.name);
  c.check("a ProRes 4444 bake in a zip becomes qtrle, with the reason", sink.warnings.some((w) => /QuickTime Animation/.test(w) && /opaque/.test(w)), sink.warnings);
  c.check("…and its finish() says qtrle, for the report", fin.codec === "qtrle", fin);
  if (got) {
    const zip = await JSZip.loadAsync(await got.blob.arrayBuffer());
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
    const want = paths.map((p) => `Hero.aepkg/${p}`).sort();
    c.check("zip entries = the package's file list under Hero.aepkg/", JSON.stringify(names) === JSON.stringify(want), { names, want });
    c.check("zip: build.jsx and the encoded bake are intact", (await zip.file("Hero.aepkg/build.jsx")!.async("string")) === BUILD_JSX_SOURCE && (await zip.file("Hero.aepkg/footage/dust.mov")!.async("uint8array"))[4] === 3);
  }

  return c.failures;
}
