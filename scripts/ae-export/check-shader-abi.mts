// The MSL ABI v1 contract (src/lib/ae-export/shader/ABI.md) held against the
// three copies that must agree with it: prelude.ts (the validator's prelude),
// the emitter's TbxProgram (constructor, members, shade), and msl-compile.m's
// C mirror of TbxUniforms. When the host is checked out next to toolbox
// (../AE_Plugins/toolbox-shader/src/gpu/prelude.metal) its prelude is held to
// the same TbxUniforms and TbxImage members.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeChecker } from "./harness.mts";
import { syncChannelInputs } from "@/engine/expr-channels";
import { glslExpressionSource } from "@/nodes/effect/glsl-expression";
import { MSL_ABI_VERSION } from "@/lib/ae-export/shader/emit-msl";
import { TBX_MSL_EPILOGUE, TBX_MSL_PRELUDE } from "@/lib/ae-export/shader/prelude";
import { glslToMsl } from "@/lib/ae-export/shader/translate";
import { TBX_SHADER_POOL } from "@/lib/ae-export/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ABI = fs.readFileSync(path.join(ROOT, "src", "lib", "ae-export", "shader", "ABI.md"), "utf8");

// Comments out, whitespace collapsed, spaces around punctuation removed.
const norm = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*([{}();,:&*[\]<>=])\s*/g, "$1")
    .trim();

function section(md: string, heading: string): string {
  const i = md.indexOf(heading);
  if (i < 0) return "";
  const m = /```metal\n([\s\S]*?)```/.exec(md.slice(i));
  return m ? m[1] : "";
}

function structBody(src: string, name: string): string | null {
  const m = new RegExp(`struct ${name} \\{([\\s\\S]*?)\\n\\};`).exec(src);
  return m ? m[1] : null;
}

const IMAGE_MEMBERS = ["float4 sample(float2 uv) const", "float4 fetch(int2 p) const", "int2 size() const"];

function mainCheckout(): string | null {
  const r = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: ROOT, encoding: "utf8" });
  return r.status === 0 && path.basename(r.stdout.trim()) === ".git" ? path.dirname(r.stdout.trim()) : null;
}

export default async function run(): Promise<number> {
  const c = makeChecker("shader-abi");
  const prelude = section(ABI, "## Host prelude");
  const bundleSrc = section(ABI, "## Bundle source");
  c.check("ABI.md has the host prelude and bundle source blocks", !!prelude && !!bundleSrc);
  c.check(`ABI.md is v${MSL_ABI_VERSION} (the emitter's header)`, ABI.startsWith(`# Toolbox Shader MSL ABI, v${MSL_ABI_VERSION}`));

  // --- TbxUniforms ---
  const abiU = structBody(prelude, "TbxUniforms");
  const ourU = structBody(TBX_MSL_PRELUDE, "TbxUniforms");
  c.check("prelude.ts TbxUniforms = ABI.md TbxUniforms (fields, types, order)", !!abiU && !!ourU && norm(abiU) === norm(ourU), { abi: abiU && norm(abiU), ours: ourU && norm(ourU) });
  const pool = `sliders[${TBX_SHADER_POOL.sliders}]|colors[${TBX_SHADER_POOL.colors}]|points[${TBX_SHADER_POOL.points}]|checkboxes[${TBX_SHADER_POOL.checkboxes}]`;
  c.check("TbxUniforms arrays are TBX_SHADER_POOL's sizes", pool.split("|").every((f) => norm(abiU ?? "").includes(f)), pool);
  const objc = fs.readFileSync(path.join(ROOT, "scripts", "ae-export", "msl-compile.m"), "utf8");
  const cStruct = /typedef struct \{([\s\S]*?)\} TbxUniforms;/.exec(objc)?.[1] ?? "";
  const cFields = norm(cStruct).replace(/simd_float(\d)/g, "float$1");
  c.check("msl-compile.m's C TbxUniforms mirrors ABI.md (simd types for MSL alignment)", !!abiU && cFields === norm(abiU), { c: cFields, abi: abiU && norm(abiU) });

  // --- TbxImage: the three members toolbox code may call ---
  const ourImage = structBody(TBX_MSL_PRELUDE, "TbxImage") ?? "";
  for (const m of IMAGE_MEMBERS) {
    c.check(`ABI.md TbxImage declares ${m}`, norm(prelude).includes(norm(m) + ";"));
    c.check(`prelude.ts TbxImage defines ${m}`, norm(ourImage).includes(norm(m) + "{"));
  }

  // --- TbxProgram as the emitter prints it ---
  const body = `// ramp("ink", "#000000", "#ffffff")\n// ch("k", 0.5)\nfragColor = ink(k) + texture(u_a, v_uv) + texelFetch(u_b, ivec2(0), 0) * float(textureSize(u_c, 0).x);`;
  const src = glslExpressionSource({ inputs: syncChannelInputs([], body), expression: body });
  const r = glslToMsl(src);
  c.check("fixture translates", !r.errors.length, r.errors);
  const msl = norm(r.msl);
  const abiCtor = /TbxProgram\(constant TbxUniforms& U,[\s\S]*?TbxImage l7\)/.exec(bundleSrc)?.[0] ?? "";
  c.check("constructor signature = ABI.md's", !!abiCtor && msl.includes(norm(abiCtor)), norm(abiCtor));
  c.check("template members = ABI.md's (u_res, u_time, u_frame, u_aspect; u_a..u_d)", msl.includes(norm("float2 u_res; float u_time; float u_frame; float u_aspect;")) && msl.includes(norm("TbxImage u_a, u_b, u_c, u_d;")));
  c.check("mem-initializers = ABI.md's (u_res(U.res) … u_d(d))", msl.includes(norm("u_res(U.res), u_time(U.time), u_frame(U.frame), u_aspect(U.aspect), u_a(a), u_b(b), u_c(c), u_d(d)")));
  c.check("shade signature = ABI.md's", norm(bundleSrc).includes(norm("float4 shade(float2 v_uv)")) && msl.includes(norm("float4 shade(float2 v_uv) {")));
  const calls = [...r.msl.matchAll(/\bu_[a-z_]+\.(\w+)\(/g)].map((m) => m[1]);
  c.check("bundle code calls only TbxImage's sample / fetch / size", calls.length >= 3 && calls.every((m) => ["sample", "fetch", "size"].includes(m)), [...new Set(calls)]);
  const tbxNames = [...r.msl.matchAll(/\b(tbx_\w+|Tbx\w+)/g)].map((m) => m[1]);
  c.check("bundle code's own program-scope names are tbx_* (Tbx* are the ABI's)", tbxNames.every((n) => n.startsWith("tbx_") || ["TbxProgram", "TbxImage", "TbxUniforms"].includes(n)), [...new Set(tbxNames)]);
  c.check("prelude.ts's epilogue builds TbxProgram(U, a, b, c, d, l0…l7) like ABI.md's epilogue", /TbxProgram p\(U, TbxImage\{a\}, TbxImage\{b\}, TbxImage\{c\}, TbxImage\{d\}, TbxImage\{l0\},[^)]*TbxImage\{l7\}\)/.test(TBX_MSL_EPILOGUE));

  // --- the host's real prelude, when it is checked out ---
  const roots = [ROOT, mainCheckout()].filter((x): x is string => !!x);
  const hostPrelude = roots.map((r) => path.join(path.dirname(r), "AE_Plugins", "toolbox-shader", "src", "gpu", "prelude.metal")).find((p) => fs.existsSync(p));
  if (!hostPrelude) console.log("  note host prelude (../AE_Plugins/toolbox-shader/src/gpu/prelude.metal) not checked out — not compared");
  else {
    const text = fs.readFileSync(hostPrelude, "utf8");
    const hostU = structBody(text, "TbxUniforms");
    c.check(`host prelude TbxUniforms = ABI.md's (${hostPrelude.slice(hostPrelude.indexOf("AE_Plugins"))})`, !!hostU && !!abiU && norm(hostU) === norm(abiU), hostU && norm(hostU));
    const hostImage = norm(structBody(text, "TbxImage") ?? "");
    c.check("host prelude TbxImage has sample / fetch / size", IMAGE_MEMBERS.every((m) => hostImage.includes(norm(m) + "{")));
  }
  return c.failures;
}
