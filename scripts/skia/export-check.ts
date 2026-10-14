// Shared by the Skia family gates (specdocs/101326_skia-target.md §7 Wave 2):
// "does this Skia Canvas graph ship?" in one call —
//   1. exportSkia on the canvas → no problems (warnings are returned);
//   2. every runtime program in the scene IR (fill/paint shaders, children,
//      runtime image filters) compiles in CanvasKit (Node) and declares
//      exactly the uniforms its binds supply;
//   3. optionally, the emitted bundle type-checks inside skia-harness against
//      react-native-skia 3.4.0 + Reanimated 4.7 (skipped with a notice when
//      skia-harness/node_modules is absent, as in CI; SKIA_HARNESS_REQUIRED=1
//      turns the skip into a failure).
// The pattern is check-skia-scene-export.mts §7–8, factored so each family
// gate stays short. Call registerAllNodes() before using it. Step 3 alone,
// for any bundle kind (an SkSL Shader bundle too), is typecheckBundle().

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type { ImageFilterIR, PaintIR, ShaderIR, SkiaNode, SkslProgramIR } from "@/engine/skia/scene-ir";
import type { TimelineMarker } from "@/lib/timeline-markers";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface ExportCheckOptions {
  nodes: GraphNode[];
  edges: GraphEdge[];
  canvasId: string;
  name?: string;
  canvas?: { width: number; height: number };
  timeline?: { fps: number; ticksPerFrame: number; sceneDurationTicks: number; markers?: readonly TimelineMarker[] };
  // Type-check the emitted bundle in skia-harness (slow: a few seconds).
  typecheck?: boolean;
  // Files type-checked beside the bundle (e.g. an app screen using it).
  extraFiles?: Record<string, string>;
  // Subfolder under skia-harness/src/__family_check__/ (unique per gate).
  slot: string;
  // The export's timeline shape (SkiaExportRequest.animation). "baked"
  // checks the programs as baked (emit-baked.ts), with the uniforms they
  // still declare.
  animation?: "worklet" | "baked";
}

export interface ExportCheckResult {
  problems: string[];
  warnings: string[];
  files: Record<string, string> | null;
  programs: { where: string; ok: boolean; detail: string }[];
  typecheck: { ran: boolean; ok: boolean; output: string };
}

function programsOf(node: SkiaNode, where: string, out: { where: string; program: SkslProgramIR }[]): void {
  const shader = (s: ShaderIR | undefined, w: string) => {
    if (!s) return;
    if (s.k === "runtime") {
      out.push({ where: w, program: s.program });
      s.program.children.forEach((c, i) => shader(c.shader, `${w}.children.${i}`));
    }
  };
  const filter = (f: ImageFilterIR, w: string) => {
    if (f.k === "runtime") out.push({ where: w, program: f.program });
    if (f.k === "displacement") shader(f.map, `${w}.map`);
  };
  const paint = (p: PaintIR | undefined, w: string) => {
    if (!p) return;
    shader(p.shader, `${w}.shader`);
  };
  switch (node.k) {
    case "group":
      node.layer?.imageFilters?.forEach((f, i) => filter(f, `${where}.layer.imageFilters.${i}`));
      node.children.forEach((c, i) => programsOf(c, `${where}.children.${i}`, out));
      break;
    case "fill":
    case "shape":
    case "text":
      paint(node.paint, `${where}.paint`);
      break;
    default:
      break;
  }
}

export async function checkExportable(o: ExportCheckOptions): Promise<ExportCheckResult> {
  const { exportSkia, makeSceneSampler } = await import("@/lib/skia-export");
  const { compileSksl } = await import("@/engine/skia/sksl-program");
  const canvas = o.canvas ?? { width: 256, height: 256 };
  const timeline = o.timeline ?? { fps: 60, ticksPerFrame: 1000, sceneDurationTicks: 60_000 };
  const runtimeSource = fs.readFileSync(path.join(ROOT, "src/lib/skia-export/runtime/toolbox-timeline.ts"), "utf8");
  const r = exportSkia({
    nodes: o.nodes,
    edges: o.edges,
    targetId: o.canvasId,
    name: o.name ?? o.slot,
    canvas,
    timeline,
    runtimeSource,
    animation: o.animation,
  });
  const result: ExportCheckResult = {
    problems: r.problems,
    warnings: r.warnings,
    files: r.files,
    programs: [],
    typecheck: { ran: false, ok: false, output: "" },
  };

  // Runtime programs at tick 0, straight from the IR the exporter read.
  const sampler = makeSceneSampler(o.nodes, o.edges, o.canvasId, canvas, timeline);
  if ("problem" in sampler) {
    result.problems.push(sampler.problem);
  } else {
    let scene = sampler.sampleAt(0);
    if (scene && o.animation === "baked") {
      // The programs as the baked bundle ships them.
      const { planSceneExport } = await import("@/lib/skia-export");
      const { bakeScenePlan } = await import("@/lib/skia-export/emit-baked");
      const p = planSceneExport(scene, o.nodes, o.edges, { name: o.slot, timeline, sampleAt: (t) => sampler.sampleAt(t) }).plan;
      const b = p ? bakeScenePlan(p) : null;
      scene = b?.plan?.scene ?? null;
    }
    if (scene) {
      const found: { where: string; program: SkslProgramIR }[] = [];
      programsOf(scene.root, "root", found);
      const require = createRequire(path.join(ROOT, "package.json"));
      const CK = await require("canvaskit-wasm")();
      for (const { where, program } of found) {
        const c = compileSksl(CK, program.sksl);
        if (!c.effect) {
          result.programs.push({ where, ok: false, detail: c.error });
          continue;
        }
        const declared = new Set<string>();
        for (let i = 0; i < c.effect.getUniformCount(); i++) declared.add(c.effect.getUniformName(i));
        const supplied = new Set(Object.keys(program.uniforms));
        const missing = [...declared].filter((n) => !supplied.has(n));
        const extra = [...supplied].filter((n) => !declared.has(n));
        result.programs.push({
          where,
          ok: !missing.length && !extra.length,
          detail: missing.length || extra.length ? `missing [${missing}] extra [${extra}]` : `${declared.size} uniforms`,
        });
      }
    }
  }

  if (o.typecheck && r.files) result.typecheck = typecheckBundle(r.files, o.slot, o.extraFiles);
  return result;
}

// Type-check bundle files (any export kind) inside skia-harness against
// react-native-skia 3.4.0 + Reanimated 4.7, under
// skia-harness/src/__family_check__/<slot>/. `extra` adds files beside the
// bundle (an app-side usage file that imports it). Skipped with a notice when
// skia-harness/node_modules is absent; SKIA_HARNESS_REQUIRED=1 turns the
// skip into a failure.
export function typecheckBundle(
  files: Record<string, string>,
  slot: string,
  extra: Record<string, string> = {}
): ExportCheckResult["typecheck"] {
  const harness = path.join(ROOT, "skia-harness");
  if (!fs.existsSync(path.join(harness, "node_modules", "react-native-skia"))) {
    return {
      ran: false,
      ok: !process.env.SKIA_HARNESS_REQUIRED,
      output: "skia-harness/node_modules is not installed — type-check skipped (SKIA_HARNESS_REQUIRED=1 makes this a failure)",
    };
  }
  const dir = path.join(harness, "src", "__family_check__", slot);
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    for (const [f, text] of Object.entries({ ...files, ...extra })) {
      if (f.endsWith(".b64")) continue;
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), text);
    }
    const own = path.join(harness, "node_modules", ".bin", "tsc");
    const [cmd, args] = fs.existsSync(own) ? [own, ["--noEmit", "-p", harness]] : ["npx", ["tsc", "--noEmit", "-p", harness]];
    try {
      execFileSync(cmd, args, { cwd: ROOT, stdio: "pipe" });
      return { ran: true, ok: true, output: "" };
    } catch (e) {
      const output = String((e as { stdout?: Buffer }).stdout ?? e);
      return {
        ran: true,
        ok: false,
        output: output.split("\n").filter((l) => l.includes("__family_check__") || l.includes("error")).slice(0, 12).join("\n"),
      };
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      fs.rmdirSync(path.join(harness, "src", "__family_check__"));
    } catch {
      /* other slots still present */
    }
  }
}
