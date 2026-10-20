// validateAeShader — the AE twin of get_shader_errors (spec §7.4): fail a
// bundle before anything reaches After Effects.
//
// Pure everywhere (Linux CI included): the bundle's structure against
// AeShaderBundle and the host pool, the id against its content hash, and
// source.msl against a fresh translation of source.glsl under the bundle's
// own slots (so a stale or hand-edited MSL is caught, with GLSL lines).
// Given a `compiler` (native.ts builds one on macOS: the host's
// tbxshader-check when present, else Metal's runtime compiler through
// msl-compile.m) it also compiles prelude + source.msl + epilogue and maps
// compiler lines back to GLSL lines.

import { TBX_SHADER_BUNDLE_VERSION, TBX_SHADER_POOL, type AeShaderBundle } from "../types";
import { MSL_HEADER } from "./emit-msl";
import { fullMslSource } from "./prelude";
import { bundleId } from "./tbxfx";
import { glslToMsl, listGlslUniforms, type MslBinding } from "./translate";

export type ShaderValidator = "tbxshader-check" | "msl-compile";

export interface ShaderCompileResult {
  validator: ShaderValidator;
  ok: boolean;
  log: string;
  device?: string;
  // Errors already on source.msl's own lines (tbxshader-check --json).
  diagnostics?: { mslLine: number; message: string }[];
}

// `source` is prelude + bundle.source.msl + epilogue; `firstBundleLine` is
// the 1-based line where bundle.source.msl starts in it.
export type ShaderCompiler = (input: { bundle: AeShaderBundle; source: string; firstBundleLine: number }) => ShaderCompileResult;

export interface AeShaderIssue {
  message: string;
  // GLSL line in source.glsl, when one is known.
  line?: number;
}

export interface AeShaderValidation {
  ok: boolean;
  errors: AeShaderIssue[];
  warnings: string[];
  // What ran beyond the structural checks: a compiler, or why none did.
  compile: ShaderCompileResult | { skipped: string };
}

export interface ValidateOptions {
  compiler?: ShaderCompiler | null;
  // Shown as compile.skipped when there is no compiler.
  skipNote?: string;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const POOL_SIZE = { slider: TBX_SHADER_POOL.sliders, color: TBX_SHADER_POOL.colors, point: TBX_SHADER_POOL.points, checkbox: TBX_SHADER_POOL.checkboxes };

export function validateAeShader(input: unknown, opts: ValidateOptions = {}): AeShaderValidation {
  const errors: AeShaderIssue[] = [];
  const warnings: string[] = [];
  const fail = (message: string, line?: number) => errors.push(line ? { message, line } : { message });
  const skipped = (why: string): AeShaderValidation => ({ ok: errors.length === 0, errors, warnings, compile: { skipped: why } });

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("bundle is not an object");
    return skipped("not a bundle");
  }
  const b = input as AeShaderBundle;
  if (b.format !== "tbxfx") fail(`format must be "tbxfx" (got ${JSON.stringify(b.format)})`);
  if (b.version !== TBX_SHADER_BUNDLE_VERSION) fail(`version must be ${TBX_SHADER_BUNDLE_VERSION} (got ${JSON.stringify(b.version)})`);
  if (!Number.isInteger(b.id) || b.id < 1 || b.id >= 2 ** 24) fail(`id must be an integer in 1…2^24−1 (got ${JSON.stringify(b.id)})`);
  if (typeof b.hostMin !== "string" || !/^\d+\.\d+\.\d+$/.test(b.hostMin)) fail(`hostMin must be a semver "x.y.z" (got ${JSON.stringify(b.hostMin)})`);
  if (typeof b.name !== "string" || !b.name.trim()) fail("name must be a non-empty string");
  if (typeof b.readsTime !== "boolean") fail("readsTime must be a boolean");
  if (!(typeof b.fps === "number" && Number.isFinite(b.fps) && b.fps > 0)) fail("fps must be a positive number");
  if (!(Number.isInteger(b.loopFrames) && b.loopFrames >= 0)) fail("loopFrames must be a non-negative integer");
  if (!b.canvas || !(Number.isInteger(b.canvas.width) && b.canvas.width > 0 && Number.isInteger(b.canvas.height) && b.canvas.height > 0))
    fail("canvas must be { width, height } in positive integer pixels");

  // --- inputs ---
  if (!Array.isArray(b.inputs)) fail("inputs must be an array");
  else {
    const seen = new Set<string>();
    for (const s of b.inputs) {
      if (!["a", "b", "c", "d"].includes(s)) fail(`inputs: "${s}" is not a layer slot (a–d)`);
      if (seen.has(s)) fail(`inputs: "${s}" listed twice`);
      seen.add(s);
    }
  }

  // --- params ---
  const params = Array.isArray(b.params) ? b.params : [];
  if (!Array.isArray(b.params)) fail("params must be an array");
  const names = new Set<string>();
  const slots = new Set<string>();
  for (const p of params) {
    const where = `param ${JSON.stringify(p?.name)}`;
    if (!p || typeof p !== "object") {
      fail("params: entry is not an object");
      continue;
    }
    if (typeof p.name !== "string" || !IDENT.test(p.name)) fail(`${where}: name must be a GLSL identifier`);
    if (names.has(p.name)) fail(`${where}: duplicate name`);
    names.add(p.name);
    if (typeof p.label !== "string") fail(`${where}: label must be a string`);
    const size = POOL_SIZE[p.kind as keyof typeof POOL_SIZE];
    if (!size) {
      fail(`${where}: kind must be slider / color / checkbox / point (got ${JSON.stringify(p.kind)})`);
      continue;
    }
    if (p.kind === "point") fail(`${where}: point params are reserved (ABI v1 bundles use none)`);
    if (!Number.isInteger(p.slot) || p.slot < 1 || p.slot > size) fail(`${where}: ${p.kind} slot must be 1–${size} (got ${p.slot})`);
    const key = `${p.kind}:${p.slot}`;
    if (slots.has(key)) fail(`${where}: ${p.kind} slot ${p.slot} is used twice`);
    slots.add(key);
    if (p.kind === "slider") {
      const ok = typeof p.default === "number" && Number.isFinite(p.default);
      if (!ok) fail(`${where}: slider default must be a finite number`);
      if (p.min !== undefined || p.max !== undefined) {
        if (!(Number.isFinite(p.min) && Number.isFinite(p.max) && (p.min as number) <= (p.max as number))) fail(`${where}: min/max must be finite with min ≤ max`);
        else if (ok && ((p.default as number) < (p.min as number) || (p.default as number) > (p.max as number)))
          fail(`${where}: default ${p.default} is outside [${p.min}, ${p.max}] (AE would clamp it)`);
      }
    } else if (p.kind === "color") {
      if (!(Array.isArray(p.default) && p.default.length === 4 && p.default.every((x) => typeof x === "number" && Number.isFinite(x))))
        fail(`${where}: color default must be [r, g, b, a] (straight, 0–1)`);
    } else if (p.kind === "checkbox" && typeof p.default !== "boolean") fail(`${where}: checkbox default must be a boolean`);
  }

  // --- luts ---
  const luts = b.luts ?? [];
  if (!Array.isArray(luts)) fail("luts must be an array");
  else {
    if (luts.length > 8) fail(`${luts.length} LUTs exceed the host's 8 (l0–l7)`);
    const seen = new Set<string>();
    for (const l of luts) {
      const where = `lut ${JSON.stringify(l?.name)}`;
      if (!l || typeof l.name !== "string" || !/^u_(?:ramp|curve)_[A-Za-z_][A-Za-z0-9_]*$/.test(l.name)) fail(`${where}: name must be u_ramp_<name> or u_curve_<name>`);
      else if (seen.has(l.name)) fail(`${where}: duplicate`);
      else seen.add(l.name);
      if (!l || !Number.isInteger(l.width) || l.width < 1 || l.width > 65536) fail(`${where}: width must be 1–65536`);
      else if (!Array.isArray(l.data) || l.data.length !== l.width * 4) fail(`${where}: data must hold width × 4 = ${l.width * 4} floats`);
      else if (!l.data.every((x) => typeof x === "number" && Number.isFinite(x))) fail(`${where}: data must be finite numbers`);
    }
  }

  // --- id ---
  if (Number.isInteger(b.id)) {
    const want = bundleId(b);
    if (want !== b.id) fail(`id ${b.id} does not match the content hash ${want} — the bundle was edited after export (the host caches by id)`);
  }

  // --- sources ---
  const msl = b.source?.msl;
  const glsl = b.source?.glsl;
  if (typeof msl !== "string" || !msl.trim()) {
    fail("source.msl is missing");
    return skipped("no source.msl");
  }
  if (!msl.startsWith(MSL_HEADER)) fail("source.msl does not start with the translator's header (MSL ABI v1)");
  if (!/^struct TbxProgram \{$/m.test(msl)) fail("source.msl has no `struct TbxProgram {`");
  if (!/float4 shade\(float2 v_uv\)/.test(msl)) fail("source.msl has no `float4 shade(float2 v_uv)`");
  for (const [re, what] of [
    [/^\s*#\s*include\b/m, "#include (the host prelude owns it)"],
    [/\bkernel\s+void\b/, "a kernel (the host epilogue owns the entry point)"],
    [/\[\[/, "an [[attribute]] (bindings are the host's)"],
    [/\bstruct\s+TbxUniforms\b/, "struct TbxUniforms (host prelude)"],
    [/\bstruct\s+TbxImage\b/, "struct TbxImage (host prelude)"],
  ] as const)
    if (re.test(msl)) fail(`source.msl contains ${what}`);

  let lineMap: number[] = [];
  if (typeof glsl !== "string") warnings.push("no source.glsl — source.msl is not cross-checked against the GLSL it came from");
  else {
    const re = retranslate(b, glsl, params, luts);
    for (const e of re.errors) fail(e.message, e.line || undefined);
    if (re.result) {
      lineMap = re.result.lineMap;
      if (re.result.msl !== msl) fail("source.msl is not the translation of source.glsl under these params / luts (stale or hand-edited)");
      const inputs = re.result.inputs.join();
      if (Array.isArray(b.inputs) && [...b.inputs].sort().join() !== inputs) fail(`inputs [${b.inputs.join(", ")}] differ from what the shader samples [${inputs}]`);
      if (typeof b.readsTime === "boolean" && b.readsTime !== re.result.readsTime)
        fail(`readsTime is ${b.readsTime} but the shader ${re.result.readsTime ? "reads" : "never reads"} u_time / u_frame`);
    }
  }

  if (!opts.compiler) return skipped(opts.skipNote ?? "no MSL compiler on this platform (structural checks only)");
  if (errors.length) return skipped("structural errors — not compiled");
  const { source, firstBundleLine } = fullMslSource(msl);
  const compiled = opts.compiler({ bundle: b, source, firstBundleLine });
  if (!compiled.ok) {
    const issues = compiled.diagnostics?.length
      ? compiled.diagnostics.map((d) => ({ message: `source.msl line ${d.mslLine}: ${d.message}`, line: lineMap[d.mslLine - 1] || undefined }))
      : compilerIssues(compiled.log, firstBundleLine, lineMap);
    if (issues.length) for (const i of issues) fail(i.message, i.line);
    else fail(`${compiled.validator} failed: ${compiled.log.trim().slice(0, 2000) || "(no log)"}`);
  } else if (/warning:/.test(compiled.log)) warnings.push(`${compiled.validator} warnings:\n${compiled.log.trim().slice(0, 2000)}`);
  return { ok: errors.length === 0, errors, warnings, compile: compiled };
}

// Rebuild the bindings the bundle implies and translate source.glsl again.
function retranslate(
  b: AeShaderBundle,
  glsl: string,
  params: AeShaderBundle["params"],
  luts: NonNullable<AeShaderBundle["luts"]>
): { errors: { message: string; line: number }[]; result?: ReturnType<typeof glslToMsl> } {
  const declared = listGlslUniforms(glsl);
  if (!declared.ok) return { errors: declared.errors };
  const bindings: Record<string, MslBinding> = {};
  for (const p of params) {
    if (p.kind === "slider" || p.kind === "color" || p.kind === "checkbox") bindings[p.name] = { kind: p.kind, slot: p.slot };
  }
  luts.forEach((l, index) => (bindings[l.name] = { kind: "lut", index }));
  const ints = declared.uniforms.filter((u) => u.type === "int").map((u) => u.name);
  for (const n of ints) bindings[n] = { kind: "enum", value: 0 };
  const errors: { message: string; line: number }[] = [];
  for (const u of declared.uniforms) {
    if (/^u_(?:ramp|curve)_/.test(u.name) && !luts.some((l) => l.name === u.name)) errors.push({ line: u.line, message: `sampler "${u.name}" has no lut in the bundle` });
    if (u.name.startsWith("u_") || u.type === "int") continue;
    if (!bindings[u.name]) errors.push({ line: u.line, message: `uniform "${u.name}" has no param in the bundle` });
  }
  for (const p of params) if (!declared.uniforms.some((u) => u.name === p.name)) errors.push({ line: 0, message: `param "${p.name}" is not a uniform in source.glsl` });
  for (const l of luts) if (!declared.uniforms.some((u) => u.name === l.name)) errors.push({ line: 0, message: `lut "${l.name}" is not a sampler in source.glsl` });
  if (errors.length) return { errors };
  if (ints.length) {
    // Picks are baked into the MSL; read the values back by their MSL names.
    const probe = glslToMsl(glsl, { bindings });
    if (probe.errors.length) return { errors: probe.errors };
    for (const n of ints) {
      const mslName = probe.uniforms.find((u) => u.name === n)?.msl ?? n;
      const m = new RegExp(`^constant int ${mslName} = (-?\\d+);$`, "m").exec(b.source.msl ?? "");
      if (!m) errors.push({ line: 0, message: `pick "${n}" has no baked \`constant int ${mslName}\` in source.msl` });
      else bindings[n] = { kind: "enum", value: Number(m[1]) };
    }
    if (errors.length) return { errors };
  }
  const result = glslToMsl(glsl, { bindings });
  return { errors: result.errors, result };
}

// Metal's diagnostics → issues, with the GLSL line behind each bundle line.
export function compilerIssues(log: string, firstBundleLine: number, lineMap: number[]): AeShaderIssue[] {
  const issues: AeShaderIssue[] = [];
  const re = /^(?:program_source|[^:\n]*\.metal):(\d+):(\d+): (error|fatal error): (.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(log))) {
    const line = Number(m[1]);
    const mslLine = line - firstBundleLine + 1;
    const where = mslLine >= 1 && mslLine <= lineMap.length + 1 ? `source.msl line ${mslLine}` : `host prelude/epilogue line ${line}`;
    const glslLine = lineMap[mslLine - 1] || undefined;
    issues.push({ message: `${where}: ${m[4]}`, line: glslLine });
  }
  if (!issues.length && /error/.test(log)) {
    const first = log.split("\n").find((l) => /error/.test(l));
    if (first) issues.push({ message: first.trim() });
  }
  return issues;
}
