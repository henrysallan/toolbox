// Node-only native half of the shader validator (never import this from the
// editor bundle — it spawns processes). On macOS it provides the `compiler`
// validateAeShader takes:
//   1. the host's own checker, ../AE_Plugins/toolbox-shader/build/tbxshader-check
//      (or $TBX_SHADER_CHECK), run as `tbxshader-check <bundle.tbxfx> --json`
//      (exit 0 ok · 1 errors · 2 usage / I/O / no device; diagnostics on
//      source.msl's own lines) — preferred: it parses the bundle the way the
//      plug-in does and compiles with the host's real prelude / epilogue;
//   2. else scripts/ae-export/msl-compile.m, built with clang into a temp dir
//      and run on prelude.ts's copy of the prelude / epilogue — Metal's
//      runtime compiler (newLibraryWithSource), the call the host makes.
// Elsewhere (Linux CI, no clang, no Metal device) it returns a skip note.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AeShaderBundle } from "../types";
import { fullMslSource } from "./prelude";
import { writeTbxfx } from "./tbxfx";
import type { ShaderCompileResult, ShaderCompiler, ShaderValidator } from "./validate";

export interface NativeOptions {
  // The toolbox checkout (default: cwd). The host checker is looked up next
  // to the MAIN checkout, so a git worktree still finds ../AE_Plugins.
  repoRoot?: string;
  // msl-compile.m (default: <repoRoot>/scripts/ae-export/msl-compile.m).
  mslCompileSource?: string;
  // Where the built msl-compile binary is cached (default: the OS temp dir).
  buildDir?: string;
  // Ignore the host checker even when it exists.
  noHostChecker?: boolean;
}

export type NativeCompiler =
  | { ok: true; compiler: ShaderCompiler; validator: ShaderValidator; detail: string }
  | { ok: false; skipped: string }
  | { ok: false; error: string };

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "tbx-shader-"));

export function nativeShaderCompiler(opts: NativeOptions = {}): NativeCompiler {
  if (process.platform !== "darwin") return { ok: false, skipped: `not macOS (${process.platform})` };
  const host = opts.noHostChecker ? null : findHostChecker(opts.repoRoot);
  if (host) {
    return {
      ok: true,
      validator: "tbxshader-check",
      detail: host,
      compiler: ({ bundle }) => runHostChecker(host, bundle),
    };
  }
  const built = buildMslCompile(opts);
  if (!built.ok) return built;
  return {
    ok: true,
    validator: "msl-compile",
    detail: `${built.bin} (${built.device})`,
    compiler: ({ source }) => compileWithMslCompile(built.bin, source),
  };
}

// ---------------------------------------------------------------------------
// tbxshader-check
// ---------------------------------------------------------------------------

export function findHostChecker(repoRoot = process.cwd()): string | null {
  const env = process.env.TBX_SHADER_CHECK;
  if (env) return fs.existsSync(env) ? env : null;
  const roots = new Set<string>([path.resolve(repoRoot)]);
  const main = mainCheckout(repoRoot);
  if (main) roots.add(main);
  for (const r of roots) {
    const p = path.join(path.dirname(r), "AE_Plugins", "toolbox-shader", "build", "tbxshader-check");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// The main checkout behind a worktree (git's common dir is <main>/.git).
function mainCheckout(repoRoot: string): string | null {
  const r = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repoRoot, encoding: "utf8" });
  if (r.status !== 0) return null;
  const common = r.stdout.trim();
  return path.basename(common) === ".git" ? path.dirname(common) : null;
}

function runHostChecker(bin: string, bundle: AeShaderBundle): ShaderCompileResult {
  const dir = tmpRoot();
  try {
    const file = path.join(dir, `${bundle.id}.tbxfx`);
    fs.writeFileSync(file, writeTbxfx(bundle));
    const r = spawnSync(bin, [file, "--json"], { encoding: "utf8", timeout: 60_000 });
    const log = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}`;
    const j = parseJsonLine(r.stdout ?? "");
    if (!j) return { validator: "tbxshader-check", ok: false, log };
    type Diag = { file?: string; line?: number; severity?: string; message?: string };
    const errors = (Array.isArray(j.errors) ? j.errors : []) as Diag[];
    const warnings = (Array.isArray(j.warnings) ? j.warnings : []) as Diag[];
    const text = [
      ...(typeof j.error === "string" ? [`${j.stage ?? "error"}: ${j.error}`] : []),
      ...errors.map((d) => `${d.file || "source.msl"}:${d.line ?? 0}: error: ${d.message ?? ""}`),
      ...warnings.map((d) => `${d.file || "source.msl"}:${d.line ?? 0}: warning: ${d.message ?? ""}`),
    ].join("\n");
    return {
      validator: "tbxshader-check",
      ok: j.ok === true && r.status === 0,
      log: text || log,
      device: `host ${String(j.host ?? "?")}, ABI ${String(j.abi ?? "?")}`,
      diagnostics: errors
        .filter((d) => !d.file || /source\.msl/.test(d.file))
        .map((d) => ({ mslLine: Number(d.line ?? 0), message: String(d.message ?? "") })),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// msl-compile
// ---------------------------------------------------------------------------

export type MslCompileBuild = { ok: true; bin: string; device: string } | { ok: false; skipped: string } | { ok: false; error: string };

let cachedBuild: { key: string; result: MslCompileBuild } | null = null;

export function buildMslCompile(opts: NativeOptions = {}): MslCompileBuild {
  if (process.platform !== "darwin") return { ok: false, skipped: `not macOS (${process.platform})` };
  const src = opts.mslCompileSource ?? path.join(opts.repoRoot ?? process.cwd(), "scripts", "ae-export", "msl-compile.m");
  if (!fs.existsSync(src)) return { ok: false, error: `msl-compile.m not found at ${src}` };
  const text = fs.readFileSync(src);
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const key = `${src}:${hash}:${opts.buildDir ?? ""}`;
  if (cachedBuild?.key === key) return cachedBuild.result;

  // `xcrun clang` (or the /usr/bin shim) sets the SDK sysroot; the bare
  // toolchain binary `xcrun --find clang` names does not.
  const cc = spawnSync("xcrun", ["clang", "--version"], { encoding: "utf8" }).status === 0 ? ["xcrun", "clang"] : ["/usr/bin/clang"];
  const probe = spawnSync(cc[0], [...cc.slice(1), "--version"], { encoding: "utf8" });
  if (probe.status !== 0) return remember({ ok: false, skipped: "no working clang (install the Xcode command line tools)" });

  const dir = path.join(opts.buildDir ?? os.tmpdir(), `toolbox-msl-compile-${hash}`);
  const bin = path.join(dir, "msl-compile");
  if (!fs.existsSync(bin)) {
    fs.mkdirSync(dir, { recursive: true });
    const tmpBin = `${bin}.${process.pid}`;
    const r = spawnSync(cc[0], [...cc.slice(1), "-fobjc-arc", "-O2", src, "-framework", "Metal", "-framework", "Foundation", "-o", tmpBin], { encoding: "utf8" });
    if (r.status !== 0) return remember({ ok: false, error: `clang could not build msl-compile.m:\n${r.stderr}` });
    fs.renameSync(tmpBin, bin);
  }
  // A trivial library: proves there is a Metal device and reports its name.
  const smoke = compileWithMslCompile(bin, "#include <metal_stdlib>\nkernel void tbx_smoke() {}\n");
  if (!smoke.ok) {
    if (/no Metal device/.test(smoke.log)) return remember({ ok: false, skipped: "no Metal device" });
    return remember({ ok: false, error: `msl-compile smoke test failed: ${smoke.log}` });
  }
  return remember({ ok: true, bin, device: smoke.device ?? "Metal" });

  function remember(result: MslCompileBuild): MslCompileBuild {
    cachedBuild = { key, result };
    return result;
  }
}

function parseJsonLine(stdout: string): Record<string, unknown> | null {
  const line = stdout.trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function compileWithMslCompile(bin: string, source: string): ShaderCompileResult {
  const dir = tmpRoot();
  try {
    const file = path.join(dir, "shader.metal");
    fs.writeFileSync(file, source);
    const r = spawnSync(bin, ["compile", file], { encoding: "utf8", timeout: 120_000, maxBuffer: 64 << 20 });
    const j = parseJsonLine(r.stdout ?? "");
    if (!j) return { validator: "msl-compile", ok: false, log: `msl-compile produced no result (status ${r.status}): ${r.stderr ?? ""}${r.error ?? ""}` };
    return { validator: "msl-compile", ok: j.ok === true, log: String(j.log ?? ""), device: String(j.device ?? "") };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Probe: shade() at listed uvs on the GPU (the parity gate's Metal side)
// ---------------------------------------------------------------------------

export interface ProbeTexture {
  w: number;
  h: number;
  // w × h × 4 floats, row 0 = uv.y 0.
  data: ArrayLike<number>;
  format?: "rgba16f" | "rgba32f";
}

export interface ProbeJob {
  uniforms: {
    res: [number, number];
    time: number;
    frame: number;
    aspect: number;
    sliders: number[];
    colors: number[][];
    checkboxes: number[];
  };
  // 12 slots: a, b, c, d, l0…l7 (null = 1×1 transparent).
  textures: (ProbeTexture | null)[];
  // u0, v0, u1, v1, …
  uvs: number[];
  // Compile with Metal's fast math instead of the host's IEEE mode — only
  // to tell a reference renderer's math library apart from a translation bug.
  fastMath?: boolean;
}

export type ProbeResult = { ok: true; out: (number | null)[]; device: string } | { ok: false; log: string };

export function probeShade(bin: string, bundleMsl: string, job: ProbeJob): ProbeResult {
  const dir = tmpRoot();
  try {
    const source = path.join(dir, "probe.metal");
    fs.writeFileSync(source, fullMslSource(bundleMsl).source);
    const jobFile = path.join(dir, "job.json");
    fs.writeFileSync(
      jobFile,
      JSON.stringify({
        source,
        kernel: "tbx_probe",
        uniforms: { ...job.uniforms, points: [] },
        textures: job.textures.map((t) => (t ? { w: t.w, h: t.h, format: t.format ?? "rgba16f", data: Array.from(t.data) } : null)),
        uvs: job.uvs,
        fastMath: job.fastMath === true,
      })
    );
    const r = spawnSync(bin, ["probe", jobFile], { encoding: "utf8", timeout: 120_000, maxBuffer: 256 << 20 });
    const j = parseJsonLine(r.stdout ?? "");
    if (!j) return { ok: false, log: `msl-compile probe produced no result (status ${r.status}): ${r.stderr ?? ""}` };
    if (j.ok !== true) return { ok: false, log: String(j.log ?? "") };
    return { ok: true, out: j.out as (number | null)[], device: String(j.device ?? "") };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
