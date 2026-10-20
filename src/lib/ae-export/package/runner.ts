// The AE export runner (spec 091926_after-effects-handoff.md §5): plan →
// scene build → package files → bakes → write → optional headless build.
//
// Everything editor- or platform-specific comes in through AeRunnerDeps, so
// the same runner serves the Export to After Effects modal, the
// export_ae_package tool and the offline gate (check-package-runner.mts runs
// it on fixture scenes with fake renderers and sinks). EffectsApp supplies
// the scene build, renderNodeFrames, and a sink: a package folder main
// created (desktop) or a zip (web, or desktop by choice).

import { DEFAULT_TICKS_PER_FRAME } from "@/engine/keyframes";
import type { AeBuildResult } from "@/lib/platform/types";
import type { AeAssetCopy, AeBakeRequest, AeSceneBuild } from "../scene";
import {
  README_FILE,
  endpointTarget,
  aePackagePaths,
  aePackageReport,
  aeReadme,
  assembleAePackage,
  type AeAssembly,
  type AeBakeOutcome,
} from "./files";
import type { AeExportOptions, AeExportProgress, AeExportResult } from "./index";

// One rendered frame, streamed: `rgba` is straight RGBA8, row 0 = top, at
// the requested size, or null when the node produced no image at that tick.
export interface AeRenderedTick {
  tick: number;
  // Position in the (sorted, de-duplicated) render order.
  index: number;
  rgba: Uint8Array | null;
}

// EffectsApp renderNodeFrames: render `target` at each composition tick with
// the real engine at `size`, handing each frame to `onFrame` as it lands
// (awaited — an encoder's backpressure holds the next frame back).
export type AeFrameRenderer = (
  target: { node: string; handle: string },
  ticks: number[],
  size: { width: number; height: number },
  onFrame: (frame: AeRenderedTick) => void | Promise<void>,
  opts?: { label?: (done: number, total: number) => string }
) => Promise<void>;

export interface AeBakeEncoder {
  writeFrame(rgba: Uint8Array): Promise<void>;
  finish(): Promise<{ bytes?: number }>;
  abort(): Promise<void>;
}

// Where a package goes: a folder (desktop) or a zip being assembled.
export interface AePackageSink {
  kind: "folder" | "zip";
  // Folder: its absolute path. Zip: the file name it downloads as.
  location: string;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  encodeBake(bake: AeBakeRequest, fps: number): Promise<AeBakeEncoder>;
  // Zip: generate + download. Folder: nothing left to do.
  finish(): Promise<void>;
  // Notes the sink adds (a codec it had to switch, an aerender-unsafe path).
  warnings: string[];
}

export interface AeRunnerDeps {
  toolboxVersion: string;
  buildScene(opts: AeExportOptions): AeSceneBuild | Promise<AeSceneBuild>;
  renderFrames: AeFrameRenderer;
  // Bytes of an asset the scene copies into footage/ (null: unreadable).
  readAsset?(copy: AeAssetCopy): Promise<Uint8Array | null>;
  // `root` = "<base>.aepkg". null = the user cancelled (a folder picker).
  openSink(destination: AeExportOptions["destination"], root: string, assembly: AeAssembly): Promise<AePackageSink | null>;
  // The headless build (desktop with After Effects); absent elsewhere.
  build?(location: string): Promise<AeBuildResult>;
  // toolbox.json's `output` (the node the main comp reproduces).
  output?(): string | undefined;
  onProgress?(p: AeExportProgress | null): void;
  now?(): Date;
  ticksPerFrame?: number;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createAeExportRunner(deps: AeRunnerDeps) {
  const tpf = deps.ticksPerFrame ?? DEFAULT_TICKS_PER_FRAME;
  const progress = (p: AeExportProgress | null) => deps.onProgress?.(p);

  return async function runAeExport(opts: AeExportOptions): Promise<AeExportResult> {
    try {
      progress({ phase: "plan", done: 0, total: 1 });
      progress({ phase: "scene", done: 0, total: 1, label: "Building the scene" });
      const build = await deps.buildScene(opts);
      const exportedAt = (deps.now?.() ?? new Date()).toISOString();
      const assembly = assembleAePackage(build, {
        name: opts.name,
        toolboxVersion: deps.toolboxVersion,
        exportedAt,
        output: deps.output?.(),
      });
      const report0 = aePackageReport(build);
      if (assembly.problems.length) return { ok: false, report: report0, problems: assembly.problems, warnings: assembly.warnings };
      if (opts.build && opts.destination !== "folder")
        assembly.warnings.push("Build in After Effects needs the folder destination; the zip was exported without building.");

      const sink = await deps.openSink(opts.destination, assembly.root, assembly);
      if (!sink) return { ok: false, report: report0, problems: ["Export cancelled — no folder was picked."], warnings: assembly.warnings };
      const warnings = [...assembly.warnings];
      const problems: string[] = [];

      // Static files first, so a failed bake still leaves a buildable scene.
      const total = assembly.files.length + assembly.footage.assets.length + 1;
      let done = 0;
      for (const f of assembly.files) {
        progress({ phase: "write", done: done++, total, label: `Writing ${f.path}` });
        await sink.writeFile(f.path, f.bytes ?? f.text ?? "");
      }
      for (const a of assembly.footage.assets) {
        progress({ phase: "write", done: done++, total, label: `Copying ${a.path}` });
        const bytes = deps.readAsset ? await deps.readAsset(a).catch(() => null) : null;
        if (!bytes) problems.push(`could not read ${a.source.kind} "${a.source.ref}" for ${a.path}`);
        else await sink.writeFile(a.path, bytes);
      }

      // Bakes: render each region at the comp's ticks and stream the frames
      // into its encoder.
      const outcomes: AeBakeOutcome[] = [];
      const fps = build.plan.composition.fps;
      const bakeFrames = assembly.footage.bakes.reduce((n, b) => n + (b.frames[1] - b.frames[0] + 1), 0);
      let rendered = 0;
      for (const bake of assembly.footage.bakes) {
        const outcome: AeBakeOutcome = { id: bake.id, path: bake.path, frames: bake.frames, codec: bake.codec };
        outcomes.push(outcome);
        const [w, h] = bake.size;
        const ticks: number[] = [];
        for (let f = bake.frames[0]; f <= bake.frames[1]; f++) ticks.push(f * tpf);
        let enc: AeBakeEncoder | null = null;
        try {
          enc = await sink.encodeBake(bake, fps);
          const encoder = enc;
          const target = endpointTarget(bake.output);
          await deps.renderFrames(
            target,
            ticks,
            { width: w, height: h },
            async ({ tick, rgba }) => {
              if (!rgba || rgba.length !== w * h * 4)
                throw new Error(`${bake.output} rendered no ${w}×${h} image at frame ${tick / tpf}`);
              await encoder.writeFrame(rgba);
              rendered++;
              progress({ phase: "bake", done: rendered, total: bakeFrames, label: `Rendering ${bake.path} — frame ${rendered}/${bakeFrames}` });
            },
            { label: (d, t) => `Rendering ${bake.path} for After Effects — frame ${d}/${t}` }
          );
          progress({ phase: "encode", done: 0, total: 1, label: `Encoding ${bake.path}` });
          const fin = await encoder.finish();
          enc = null;
          if (fin.bytes != null) outcome.bytes = fin.bytes;
        } catch (e) {
          outcome.error = errText(e);
          problems.push(`baked footage ${bake.path}: ${outcome.error}`);
          await enc?.abort().catch(() => {});
        }
      }

      warnings.push(...sink.warnings);
      const files = aePackagePaths(assembly);
      progress({ phase: "write", done: total - 1, total, label: `Writing ${README_FILE}` });
      const root = sink.kind === "folder" ? (sink.location.split(/[\\/]/).pop() ?? assembly.root) : assembly.root;
      await sink.writeFile(README_FILE, aeReadme(build, { name: opts.name, toolboxVersion: deps.toolboxVersion, exportedAt, bakes: outcomes, files, root }));
      await sink.finish();
      progress({ phase: "write", done: total, total });

      const report = aePackageReport(build, outcomes);
      const result: AeExportResult = { ok: problems.length === 0, location: sink.location, report, problems, warnings: [...new Set(warnings)], files };

      if (opts.build && sink.kind === "folder" && result.ok) {
        if (!deps.build) result.warnings.push("Not built: this app found no After Effects (aerender) — open build.jsx in After Effects to build it.");
        else {
          progress({ phase: "build", done: 0, total: 1, label: "Building in After Effects (headless)" });
          try {
            const b = await deps.build(sink.location);
            result.built = { ok: b.ok, log: [b.log, ...b.notes].filter(Boolean).join("\n"), ...(b.aep ? { aep: b.aep } : {}) };
          } catch (e) {
            result.built = { ok: false, log: errText(e) };
          }
          progress({ phase: "build", done: 1, total: 1 });
        }
      }
      return result;
    } finally {
      progress(null);
    }
  };
}

// AeBakeCodec → the shared encoder-arg builder's codec (export-ffmpeg-args.js).
export function bakeEncodeSpec(codec: AeBakeRequest["codec"]): { codec: "prores" | "qtrle"; proresProfile: number; alpha: boolean } {
  return codec === "prores4444" ? { codec: "prores", proresProfile: 4, alpha: true } : { codec: "qtrle", proresProfile: 0, alpha: true };
}
