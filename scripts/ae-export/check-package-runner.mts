// The AE export runner (src/lib/ae-export/package/runner.ts) with fake
// deps: the order it writes in (static files → copied assets → bakes →
// README last), the ticks and sizes it asks renderNodeFrames for, frames
// streamed into the encoder in order, a failed frame aborting only its bake,
// cancel / refusal / zip+build / no-AE paths, progress phases; folderSink's
// folder-target encode spec; and the tbxshader-check → ShaderCompileResult
// mapping validate_ae_shader uses on the desktop.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { makeChecker } from "./harness.mts";
import { bakeEncodeSpec, createAeExportRunner, type AeExportProgress, type AeFrameRenderer, type AePackageSink } from "@/lib/ae-export/package";
import { folderSink } from "@/lib/ae-export/package/sinks";
import { hostCheckResult } from "@/lib/ae-export/package/shader-check";
import type { AeSceneBuild } from "@/lib/ae-export/scene";
import { DEFAULT_AE_POLICY, type AeScene } from "@/lib/ae-export/types";
import type { AeBuildResult, AePackageFolder, NativeVideoEncodeSpec } from "@/lib/platform/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../..");
const scene0 = JSON.parse(readFileSync(join(REPO, "scripts/fixtures/ae-export/e-kitchen-sink.scene.json"), "utf8")) as AeScene;

function buildWithBake(): AeSceneBuild {
  const scene = JSON.parse(JSON.stringify(scene0)) as AeScene;
  scene.footage.push({ id: "p1", path: "footage/p1.mov", kind: "video", alpha: "straight", fps: 24 });
  const main = scene.comps.find((c) => c.id === scene.main)!;
  main.layers.push({ ...main.layers.find((l) => l.kind === "footage")!, id: "p1Layer", name: "P1", source: "p1" } as any);
  return {
    plan: {
      route: "direct+bake",
      composition: { id: "c1", name: main.name, width: main.width, height: main.height, fps: 24, durationFrames: 48 },
      layers: [],
      shaderRegions: [],
      bakes: [],
      expressions: [],
      blocked: [],
      approximations: [],
      estimates: { layers: 0, keyframes: 0, footageMB: 0 },
      fonts: [],
      policy: DEFAULT_AE_POLICY,
      warnings: [],
    },
    scene,
    bakes: [{ id: "p1", output: "parts-1:aux:image", frames: [2, 5], size: [8, 4], codec: "qtrle", path: "footage/p1.mov" }],
    bundles: [],
    presets: [],
    files: [],
    assets: [{ id: "dot", path: "footage/dot.png", source: { kind: "image", ref: "/assets/dot.png" } }],
    problems: [],
    warnings: [],
  };
}

interface Log {
  events: string[];
  frames: number[];
  aborted: number;
  progress: (AeExportProgress | null)[];
}

function fakeSink(log: Log, kind: "folder" | "zip" = "folder"): AePackageSink {
  return {
    kind,
    location: kind === "folder" ? "/Users/x/Documents/Toolbox/After Effects/Kitchen 2.aepkg" : "Kitchen.aepkg.zip",
    warnings: [],
    async writeFile(path) {
      log.events.push(`write ${path}`);
    },
    async encodeBake(bake, fps) {
      log.events.push(`encode ${bake.path} @${fps}`);
      return {
        writeFrame: async (rgba) => {
          log.frames.push(rgba[0]);
        },
        finish: async () => {
          log.events.push(`finish ${bake.path}`);
          return { bytes: 2048 };
        },
        abort: async () => {
          log.aborted++;
        },
      };
    },
    async finish() {
      log.events.push("sink finish");
    },
  };
}

const renderer = (log: Log, bad?: number): AeFrameRenderer => async (target, ticks, size, onFrame) => {
  log.events.push(`render ${target.node} ${target.handle} [${ticks.join(",")}] ${size.width}x${size.height}`);
  let i = 0;
  for (const tick of ticks) {
    const px = new Uint8Array(size.width * size.height * 4).fill(tick / 1000);
    await onFrame({ tick, index: i++, rgba: tick / 1000 === bad ? null : px });
  }
};

export default async function run(): Promise<number> {
  const c = makeChecker("package-runner");
  const newLog = (): Log => ({ events: [], frames: [], aborted: 0, progress: [] });

  // ---- the happy path ------------------------------------------------------------
  {
    const log = newLog();
    let builtAt = "";
    const runAe = createAeExportRunner({
      toolboxVersion: "0.6.1",
      buildScene: () => buildWithBake(),
      renderFrames: renderer(log),
      readAsset: async () => new Uint8Array([1, 2, 3]),
      openSink: async (dest, root) => {
        log.events.push(`open ${dest} ${root}`);
        return fakeSink(log);
      },
      build: async (location): Promise<AeBuildResult> => {
        builtAt = location;
        return { ok: true, aep: `${location}/Kitchen 2.aep`, log: '{"ok":true}', result: { ok: true }, notes: [], opened: false, seconds: 4.1, aerender: { code: 0, timedOut: false, output: "" } };
      },
      output: () => "out-1:out",
      onProgress: (p) => log.progress.push(p),
      now: () => new Date("2026-10-20T12:00:00Z"),
    });
    const res = await runAe({ policy: {}, overrides: {}, fused: {}, name: "Kitchen", destination: "folder", build: true });
    c.check("ok, with the sink's location", res.ok && !!res.location?.endsWith("Kitchen 2.aepkg"), res);
    const ev = log.events;
    const idx = (s: string) => ev.findIndex((e) => e.startsWith(s));
    c.check("opens the sink with the destination and <name>.aepkg", ev[0] === "open folder Kitchen.aepkg", ev[0]);
    c.check(
      "order: scene.json / build.jsx / toolbox.json → assets → bake → README → sink finish",
      idx("write scene.json") < idx("write footage/dot.png") && idx("write footage/dot.png") < idx("encode footage/p1.mov") && idx("finish footage/p1.mov") < idx("write README.txt") && idx("write README.txt") < idx("sink finish"),
      ev
    );
    c.check(
      "renderNodeFrames gets the bake's endpoint, inclusive frames as ticks, and its size",
      ev.includes("render parts-1 out:aux:image [2000,3000,4000,5000] 8x4"),
      ev.filter((e) => e.startsWith("render"))
    );
    c.check("the encoder gets the comp fps and every frame in order", ev.includes("encode footage/p1.mov @24") && JSON.stringify(log.frames) === "[2,3,4,5]", log.frames);
    c.check("build runs on the folder, after the write", builtAt === res.location && res.built?.ok === true && res.built.aep?.endsWith(".aep") === true, res.built);
    c.check("files: README first, then every path", res.files?.[0] === "README.txt" && ["build.jsx", "scene.json", "toolbox.json", "footage/dot.png", "footage/p1.mov"].every((f) => res.files!.includes(f)), res.files);
    c.check("report lists the bake with its encoded size", /footage\/p1\.mov — parts-1:aux:image, frames 2–5, 8×4, qtrle, 0\.0 MB/.test(res.report), res.report);
    const phases = log.progress.map((p) => p?.phase ?? null);
    c.check(
      "progress: plan → scene → write → bake → encode → … → build, then cleared",
      ["plan", "scene", "write", "bake", "encode", "build"].every((p) => phases.includes(p as any)) && phases.at(-1) === null && phases.indexOf("bake") < phases.indexOf("encode"),
      phases
    );
    const bakeP = log.progress.filter((p) => p?.phase === "bake");
    c.check("bake progress counts frames over all bakes", bakeP.at(-1)?.done === 4 && bakeP.at(-1)?.total === 4, bakeP.at(-1));
  }

  // ---- refusals, cancel, failures ------------------------------------------------------
  {
    const log = newLog();
    let opened = false;
    const runAe = createAeExportRunner({
      toolboxVersion: "x",
      buildScene: () => ({ ...buildWithBake(), problems: ["Live Input (cam-1) needs a recorded take"] }),
      renderFrames: renderer(log),
      openSink: async () => {
        opened = true;
        return fakeSink(log);
      },
    });
    const res = await runAe({ policy: {}, overrides: {}, fused: {}, name: "K", destination: "folder", build: false });
    c.check("scene problems refuse before any sink opens", !res.ok && !opened && res.problems.some((p) => /recorded take/.test(p)) && !res.location, res);
  }
  {
    const runAe = createAeExportRunner({ toolboxVersion: "x", buildScene: () => buildWithBake(), renderFrames: renderer(newLog()), openSink: async () => null });
    const res = await runAe({ policy: {}, overrides: {}, fused: {}, name: "K", destination: "folder", build: false });
    c.check("a cancelled folder pick is not an export", !res.ok && res.problems[0] === "Export cancelled — no folder was picked." && !res.location);
  }
  {
    const log = newLog();
    let built = false;
    const runAe = createAeExportRunner({
      toolboxVersion: "x",
      buildScene: () => buildWithBake(),
      renderFrames: renderer(log, 4),
      readAsset: async () => null,
      openSink: async () => fakeSink(log),
      build: async () => {
        built = true;
        throw new Error("unreachable");
      },
    });
    const res = await runAe({ policy: {}, overrides: {}, fused: {}, name: "K", destination: "folder", build: true });
    c.check("a frame with no image fails its bake, aborts that encoder, and says which frame", !res.ok && log.aborted === 1 && res.problems.some((p) => /footage\/p1\.mov: parts-1:aux:image rendered no 8×4 image at frame 4/.test(p)), res.problems);
    c.check("an unreadable asset is a problem", res.problems.some((p) => /could not read image "\/assets\/dot\.png"/.test(p)), res.problems);
    c.check("the README is still written, the build is skipped", log.events.includes("write README.txt") && !built && !res.built);
    c.check("the report marks the bake FAILED", /FAILED: parts-1:aux:image rendered no/.test(res.report));
  }
  {
    const log = newLog();
    const runAe = createAeExportRunner({ toolboxVersion: "x", buildScene: () => buildWithBake(), renderFrames: renderer(log), readAsset: async () => new Uint8Array(1), openSink: async () => fakeSink(log, "zip") });
    const res = await runAe({ policy: {}, overrides: {}, fused: {}, name: "K", destination: "zip", build: true });
    c.check("a zip with build: exported, not built, and says why", res.ok && !res.built && res.warnings.some((w) => /needs the folder destination/.test(w)) && res.location === "Kitchen.aepkg.zip", res.warnings);
  }
  {
    const log = newLog();
    const runAe = createAeExportRunner({ toolboxVersion: "x", buildScene: () => buildWithBake(), renderFrames: renderer(log), readAsset: async () => new Uint8Array(1), openSink: async () => fakeSink(log) });
    const res = await runAe({ policy: {}, overrides: {}, fused: {}, name: "K", destination: "folder", build: true });
    c.check("build without After Effects: exported with a warning", res.ok && !res.built && res.warnings.some((w) => /found no After Effects/.test(w)), res.warnings);
  }
  {
    const runAe = createAeExportRunner({
      toolboxVersion: "x",
      buildScene: () => {
        throw new Error("buildAeSceneForEditor: not implemented yet (AE export wave 2, scene lane)");
      },
      renderFrames: renderer(newLog()),
      openSink: async () => null,
    });
    let msg = "";
    try {
      await runAe({ policy: {}, overrides: {}, fused: {}, name: "K", destination: "zip", build: false });
    } catch (e) {
      msg = (e as Error).message;
    }
    c.check("a scene-build throw reaches the caller (the modal shows it)", /not implemented yet/.test(msg), msg);
  }

  // ---- folderSink: the folder-target encode ------------------------------------------------
  {
    const writes: [string, Uint8Array][] = [];
    const specs: NativeVideoEncodeSpec[] = [];
    const pkg: AePackageFolder = {
      name: "K.aepkg",
      path: "/Users/x/K.aepkg",
      aerenderSafe: false,
      aerenderReason: 'contains a double quote',
      writeFile: async () => {},
      writeFileAt: async (p, d) => {
        writes.push([p, d as Uint8Array]);
      },
    };
    const frames: number[] = [];
    const sink = folderSink(pkg, {
      canEncodeNative: true,
      encodeVideo: async (spec) => {
        specs.push(spec);
        return { writeFrame: async (rgba) => void frames.push(rgba.length), finish: async () => ({ path: "x", bytes: 99 }), abort: async () => {} };
      },
    });
    await sink.writeFile("scene.json", "{}");
    c.check("folderSink writes text as UTF-8 at the nested path", writes[0]?.[0] === "scene.json" && new TextDecoder().decode(writes[0][1]) === "{}");
    const enc = await sink.encodeBake({ id: "p1", output: "a:out", frames: [0, 9], size: [64, 32], codec: "prores4444", path: "footage/p1.mov" }, 30);
    await enc.writeFrame(new Uint8Array(64 * 32 * 4));
    const fin = await enc.finish();
    const s = specs[0];
    c.check(
      "folderSink: no Save dialog — into the package at the bake's path, .mov, ProRes 4444 with alpha, every frame",
      s?.into?.folder === pkg && s.into.path === "footage/p1.mov" && s.container === "mov" && s.codec === "prores" && s.proresProfile === 4 && s.alpha === true && s.durationFrames === 10 && s.width === 64 && s.height === 32 && fin.bytes === 99 && frames[0] === 64 * 32 * 4,
      s
    );
    c.check("folderSink warns when aerender can't take the folder", sink.warnings.some((w) => /command-line renderer can't open this folder/.test(w)), sink.warnings);
    const noFfmpeg = folderSink(pkg, { canEncodeNative: false });
    let err = "";
    try {
      await noFfmpeg.encodeBake({ id: "p1", output: "a:out", frames: [0, 0], size: [2, 2], codec: "qtrle", path: "footage/p1.mov" }, 30);
    } catch (e) {
      err = (e as Error).message;
    }
    c.check("folderSink without native ffmpeg says to export a zip", /export a zip instead/.test(err), err);
    c.check(
      "bakeEncodeSpec: prores4444 → ProRes profile 4 with alpha; qtrle → QuickTime Animation",
      JSON.stringify(bakeEncodeSpec("prores4444")) === JSON.stringify({ codec: "prores", proresProfile: 4, alpha: true }) && bakeEncodeSpec("qtrle").codec === "qtrle"
    );
  }

  // ---- tbxshader-check --json → ShaderCompileResult ------------------------------------------
  {
    const ok = hostCheckResult({ available: true, status: 0, json: { ok: true, stage: "ok", host: "1.0.0", abi: 1, errors: [], warnings: [] } });
    c.check("tbxshader-check ok → ok, with the host + ABI", ok.ok && ok.validator === "tbxshader-check" && ok.device === "host 1.0.0, ABI 1", ok);
    const bad = hostCheckResult({
      available: true,
      status: 1,
      json: {
        ok: false,
        stage: "compile",
        errors: [
          { file: "bundle.source.msl", line: 12, column: 22, severity: "error", message: "use of undeclared identifier 'missing_value'" },
          { file: "prelude.metal", line: 3, severity: "error", message: "host side" },
        ],
        warnings: [{ file: "bundle.source.msl", line: 4, message: "unused variable" }],
      },
    });
    c.check(
      "tbxshader-check errors → diagnostics on source.msl lines only, log keeps all",
      !bad.ok && JSON.stringify(bad.diagnostics) === JSON.stringify([{ mslLine: 12, message: "use of undeclared identifier 'missing_value'" }]) && /prelude\.metal:3: error/.test(bad.log) && /warning: unused variable/.test(bad.log),
      bad
    );
    const exit2 = hostCheckResult({ available: true, status: 2, json: { ok: true } });
    c.check("a non-zero exit is never ok, whatever the JSON says", !exit2.ok);
    const garbled = hostCheckResult({ available: true, status: 2, json: null, stdout: "boom", stderr: "no device" });
    c.check("no JSON → not ok, with the output quoted", !garbled.ok && /boom/.test(garbled.log) && /no device/.test(garbled.log), garbled);
  }

  return c.failures;
}
