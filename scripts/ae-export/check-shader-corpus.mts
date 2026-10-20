// The graph-to-GLSL docs corpus through the whole Toolbox Shader pipeline:
// every ```glsl-body snippet under src/lib/glsl-translation/docs/** is built
// into a GLSL Expression node's params (channels synced from its comments,
// as add_node does), bundled (bundleFromGlslExpression), validated
// (validateAeShader) and — on macOS — compiled by the preferred validator:
// the host's tbxshader-check when ../AE_Plugins/toolbox-shader is built,
// else Metal's runtime compiler via msl-compile.m. The three gold docs
// (nodes/blur, nodes/displace, nodes/noise) are compiled by BOTH when both
// exist, so the host's prelude and prelude.ts's copy are held to the same
// sources.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeChecker } from "./harness.mts";
import { syncChannelInputs } from "@/engine/expr-channels";
import { bundleFromGlslExpression } from "@/lib/ae-export/shader/bundle";
import { buildMslCompile, compileWithMslCompile, nativeShaderCompiler } from "@/lib/ae-export/shader/native";
import { fullMslSource } from "@/lib/ae-export/shader/prelude";
import { validateAeShader, type ShaderCompiler } from "@/lib/ae-export/shader/validate";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOCS = path.join(ROOT, "src", "lib", "glsl-translation", "docs");
const GOLD = ["nodes/blur.md", "nodes/displace.md", "nodes/noise.md"];
const FENCE = /```glsl-body\r?\n([\s\S]*?)```/g;

function walk(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : d.name.endsWith(".md") ? [path.join(dir, d.name)] : []))
    .sort();
}

export default async function run(): Promise<number> {
  const c = makeChecker("shader-corpus");
  const snippets: { doc: string; index: number; body: string }[] = [];
  for (const file of walk(DOCS)) {
    const doc = path.relative(DOCS, file).split(path.sep).join("/");
    const text = fs.readFileSync(file, "utf8");
    let m: RegExpExecArray | null;
    let i = 0;
    FENCE.lastIndex = 0;
    while ((m = FENCE.exec(text))) snippets.push({ doc, index: i++, body: m[1] });
  }
  for (const g of GOLD) c.check(`gold doc ${g} has a glsl-body snippet`, snippets.some((s) => s.doc === g));

  const native = nativeShaderCompiler({ repoRoot: ROOT });
  let compiler: ShaderCompiler | null = null;
  if (native.ok) {
    compiler = native.compiler;
    console.log(`  validator: ${native.validator} — ${native.detail}`);
  } else if ("skipped" in native) console.log(`  note Metal compilation skipped: ${native.skipped}`);
  else c.check("native shader compiler is available", false, native.error);

  // The second validator for the gold docs (msl-compile when the host
  // checker is the preferred one).
  const second = native.ok && native.validator === "tbxshader-check" ? buildMslCompile({ repoRoot: ROOT }) : null;

  let translated = 0;
  let compiled = 0;
  for (const s of snippets) {
    const label = `${s.doc}#${s.index}`;
    const params = { inputs: syncChannelInputs([], s.body), expression: s.body };
    const built = bundleFromGlslExpression(params, { name: label, fps: 30, loopFrames: 0, canvas: { width: 1920, height: 1080 } });
    if (!built.ok) {
      c.check(`${label} translates`, false, built.errors.map((e) => `L${e.line} (body L${e.line - built.preludeLines}): ${e.message}`).join(" | "));
      continue;
    }
    translated++;
    const v = validateAeShader(built.bundle, { compiler });
    const ran = "validator" in v.compile ? `${v.compile.validator}${v.compile.ok ? "" : " FAILED"}` : `not compiled (${v.compile.skipped})`;
    c.check(`${label} translates, bundles and validates — ${ran}`, v.ok, v.errors.map((e) => (e.line ? `GLSL L${e.line}: ${e.message}` : e.message)).join(" | "));
    if (v.ok && "validator" in v.compile && v.compile.ok) compiled++;
    if (second?.ok && GOLD.includes(s.doc)) {
      const r = compileWithMslCompile(second.bin, fullMslSource(built.bundle.source.msl!).source);
      c.check(`${label} also compiles with msl-compile (prelude.ts's prelude / epilogue)`, r.ok, r.log.slice(0, 1500));
    }
  }
  const total = snippets.length;
  console.log(`  corpus: ${translated} / ${total} translated, ${compiled} / ${total} compiled${compiler ? "" : " (no compiler on this platform)"}`);
  c.check(`every glsl-body snippet translates (${translated} / ${total})`, translated === total && total > 0);
  if (compiler) c.check(`every glsl-body snippet compiles (${compiled} / ${total})`, compiled === total);
  return c.failures;
}
