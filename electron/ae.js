// After Effects on the desktop (main process) — spec
// 091926_after-effects-handoff.md §5.3, §7.5, §8, §13. Backs the renderer's
// `platform.aeCapabilities` / `platform.runAfterEffects`:
//
//   capabilities     where After Effects, aerender, the Toolbox Shader host
//                    and tbxshader-check are (candidates reported, like
//                    CLAUDE_BIN_CANDIDATES), and main's own export folder
//   createPackage    <root>/<name>.aepkg — root is a folder the user picked
//                    or main's export folder; registered for nested writes
//   build            headless build: aerender + the one-launch startup hook
//                    (ae-core.js), returns build-log.json and the .aep;
//                    `open` then hands the saved .aep to the After Effects
//                    app with `open -a` — the GUI is never scripted
//   render           plain `aerender -project … -s N -e N` per frame through
//                    "TIFF Sequence with Alpha", decoded with the bundled
//                    ffmpeg and unpremultiplied
//   checkShader      tbxshader-check --json on one .tbxfx (validate_ae_shader)
//
// Trust boundary (§8): every path main hands to After Effects is one it
// built itself inside a package it created this session; the renderer only
// ever names a package by the path createPackage returned. The build
// evaluates main's own copy of build.jsx after checking it against the
// pinned hash (ae-core.BUILD_JSX_SHA256); scene.json stays data. Jobs run one
// at a time, time out, and are killed (wrapper and render core) on quit.
"use strict";

const { app, ipcMain } = require("electron");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const core = require("./ae-core");
const { aerenderSafe, sanitizeBaseName } = require("./safe-paths");
const { registerFolder, isRegisteredFolder } = require("./files");
const { ffmpegPath, ffmpegAvailable } = require("./ffmpeg");

const TIMEOUT_MS = Number(process.env.TOOLBOX_AE_TIMEOUT_MS) > 0 ? Number(process.env.TOOLBOX_AE_TIMEOUT_MS) : 5 * 60_000;

function plistVersion(bundle) {
  const r = spawnSync("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", path.join(bundle, "Contents", "Info.plist")], {
    encoding: "utf8",
    timeout: 5000,
  });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

function exportRoot() {
  return process.env.TOOLBOX_AE_EXPORT_DIR || path.join(app.getPath("documents"), "Toolbox", "After Effects");
}

let cachedCaps = null;
function capabilities() {
  if (cachedCaps) return cachedCaps;
  const candidates = core.aeCandidateDirs().map((c) => ({
    dir: c.dir,
    source: c.source,
    found: fs.existsSync(c.aerender) && fs.existsSync(c.app),
    aerender: c.aerender,
    app: c.app,
  }));
  const hit = candidates.find((c) => c.found);
  const checkers = core.shaderCheckCandidates(process.env, __dirname);
  const shaderCheck = checkers.find((c) => fs.existsSync(c.path))?.path ?? null;
  const hostPath = core.shaderHostCandidates(hit?.dir).find((p) => fs.existsSync(p)) ?? null;
  const caps = {
    available: !!hit,
    candidates: candidates.map(({ dir, source, found }) => ({ dir, source, found })),
    shaderHost: { installed: !!hostPath, ...(hostPath ? { path: hostPath, version: plistVersion(hostPath) } : {}) },
    shaderCheck,
    canEncode: ffmpegAvailable,
    exportRoot: exportRoot(),
  };
  if (process.platform !== "darwin") caps.reason = "After Effects export runs on macOS only for now (spec §11.7).";
  else if (!hit) caps.reason = "After Effects was not found (looked in /Applications/Adobe After Effects 20xx; set TOOLBOX_AE_DIR to the folder that holds aerender).";
  if (hit) {
    const version = plistVersion(hit.app);
    const prefsRoot = path.join(os.homedir(), "Library", "Preferences", "Adobe", "After Effects");
    let existing = [];
    try {
      existing = fs.readdirSync(prefsRoot);
    } catch {
      /* no prefs yet — AE was never launched */
    }
    const prefs = core.pickPrefsVersion(version, existing);
    Object.assign(caps, {
      dir: hit.dir,
      aerender: hit.aerender,
      app: hit.app,
      version,
      ...(prefs ? { startupFolder: path.join(prefsRoot, prefs, "Scripts", "Startup") } : {}),
    });
    if (!prefs) {
      caps.available = false;
      caps.reason = `Could not tell which After Effects preferences folder ${hit.app} reads (version ${version ?? "unknown"}).`;
    }
  }
  cachedCaps = caps;
  return caps;
}

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

// Package folders main created this session → their .aep base name.
const packages = new Map();

async function createPackage({ name, folderToken } = {}) {
  let root;
  if (folderToken != null) {
    if (!isRegisteredFolder(folderToken)) throw new Error("createPackage: unknown folder token");
    root = folderToken;
  } else {
    root = exportRoot();
    await fsp.mkdir(root, { recursive: true });
  }
  const base = sanitizeBaseName(name);
  for (let n = 1; n < 1000; n++) {
    const dir = path.join(root, `${n === 1 ? base : `${base} ${n}`}.aepkg`);
    try {
      await fsp.mkdir(dir); // not recursive: an existing folder is never reused
    } catch (e) {
      if (e && e.code === "EEXIST") continue;
      throw e;
    }
    registerFolder(dir);
    packages.set(dir, { base: path.basename(dir).replace(/\.aepkg$/i, "") });
    const safe = aerenderSafe(dir);
    return { token: dir, path: dir, name: path.basename(dir), aerenderSafe: safe.ok, ...(safe.ok ? {} : { aerenderReason: safe.reason }) };
  }
  throw new Error(`createPackage: ${base}.aepkg … ${base} 999.aepkg all exist in ${root}`);
}

function packageOf(pkg) {
  const meta = typeof pkg === "string" ? packages.get(pkg) : undefined;
  if (!meta)
    throw new Error(
      "That folder is not an After Effects package this app wrote in this session — export it again (export_ae_package), then pass the `location` it returns."
    );
  return { dir: pkg, ...meta, aep: path.join(pkg, `${meta.base}.aep`) };
}

// ---------------------------------------------------------------------------
// aerender
// ---------------------------------------------------------------------------

const running = new Set();
let hookInstalled = null;

function killTree(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }
  // The render core is launched through LaunchServices (ppid 1, its own
  // group) and names its wrapper: -aerenderpid <pid>.
  spawnSync("pkill", ["-KILL", "-f", `aerendercore.*-aerenderpid ${child.pid}( |$)`], { timeout: 5000 });
}

function runAerender(args, env, timeoutMs = TIMEOUT_MS) {
  const caps = capabilities();
  if (!caps.available) return Promise.reject(new Error(caps.reason || "After Effects is not available"));
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn(caps.aerender, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    running.add(child);
    let out = "";
    const add = (d) => {
      out = (out + d).slice(-20000);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      running.delete(child);
      reject(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      running.delete(child);
      resolve({ code, signal, timedOut, output: out, seconds: (Date.now() - t0) / 1000 });
    });
  });
}

function installHook() {
  const caps = capabilities();
  fs.mkdirSync(caps.startupFolder, { recursive: true });
  const hook = path.join(caps.startupFolder, core.HOOK_FILE);
  fs.writeFileSync(hook, core.HOOK_SOURCE);
  hookInstalled = hook;
  return hook;
}

function removeHook() {
  if (!hookInstalled) return;
  try {
    fs.rmSync(hookInstalled, { force: true });
  } catch {
    /* best effort; the hook is inert without its env var */
  }
  hookInstalled = null;
}

// One After Effects job at a time: the startup hook is a single file, and two
// render cores at once only compete for the GPU.
let queue = Promise.resolve();
function enqueue(job) {
  const p = queue.then(job, job);
  queue = p.catch(() => {});
  return p;
}

const tail = (s, n = 30) => String(s).split(/\r\n|\n|\r/).filter((l) => l.trim()).slice(-n).join("\n");

async function readIfExists(file) {
  try {
    return await fsp.readFile(file, "utf8");
  } catch {
    return null;
  }
}

// Headless build of a package main created (spec §13): main's verified copy
// of build.jsx, driven through the startup hook, TBX_SHADER_BUNDLES pointing
// the Toolbox Shader host at the package's shaders/.
async function buildPackage(pkg, opts = {}) {
  const p = packageOf(pkg);
  const caps = capabilities();
  if (!caps.available) throw new Error(caps.reason || "After Effects is not available");
  const bjPath = path.join(p.dir, "build.jsx");
  const st = await fsp.lstat(bjPath).catch(() => null);
  if (!st || !st.isFile()) throw new Error("The package has no build.jsx — export it again.");
  const bytes = await fsp.readFile(bjPath);
  if (core.sha256(bytes) !== core.BUILD_JSX_SHA256)
    throw new Error("The package's build.jsx is not the builder this app ships — export the package again from this version of Toolbox.");
  if (!fs.existsSync(path.join(p.dir, "scene.json"))) throw new Error("The package has no scene.json — export it again.");

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "toolbox-ae-build-"));
  const buildJsx = path.join(tmp, "build.jsx");
  const driver = path.join(tmp, "driver.jsx");
  const doneFile = path.join(tmp, "done.txt");
  await fsp.writeFile(buildJsx, bytes);
  await fsp.writeFile(driver, core.driverSource({ buildJsx, packageDir: p.dir, doneFile }));
  await fsp.rm(path.join(p.dir, "build-log.json"), { force: true });
  const t0 = Date.now();
  let run;
  try {
    installHook();
    run = await runAerender(core.BUILD_ARGS, { [core.HOOK_ENV]: driver, TBX_SHADER_BUNDLES: path.join(p.dir, "shaders") });
  } finally {
    removeHook();
  }
  const done = await readIfExists(doneFile);
  const hookError = await readIfExists(path.join(tmp, "hook-error.txt"));
  await fsp.rm(tmp, { recursive: true, force: true });
  const logText = await readIfExists(path.join(p.dir, "build-log.json"));
  let result = null;
  try {
    result = logText ? JSON.parse(logText) : null;
  } catch {
    result = null;
  }
  const aepStat = await fsp.stat(p.aep).catch(() => null);
  const fresh = !!aepStat && aepStat.mtimeMs >= t0 - 2000;
  const [doneState = "", , doneErr = ""] = (done ?? "").split("\n");
  const ok = doneState === "ok" && fresh && (!result || result.ok === true);
  const notes = [];
  if (run.timedOut) notes.push(`aerender did not finish within ${TIMEOUT_MS / 1000}s and was stopped.`);
  if (!done) notes.push("The build driver never ran (After Effects' render core did not evaluate the startup hook).");
  if (hookError) notes.push(`startup hook: ${hookError.trim()}`);
  if (doneErr.trim()) notes.push(`build.jsx: ${doneErr.trim()}`);
  if (done && !logText)
    notes.push('No build-log.json: turn on After Effects → Settings → Scripting & Expressions → "Allow Scripts to Write Files and Access Network".');
  if (!fresh && doneState === "ok") notes.push(`build.jsx reported success but ${p.aep} was not written.`);
  let opened = false;
  if (ok && opts.open) opened = openInAe(p.aep);
  return {
    ok,
    aep: fresh ? p.aep : undefined,
    log: logText ?? "",
    result,
    notes,
    opened,
    seconds: (Date.now() - t0) / 1000,
    aerender: { code: run.code, timedOut: run.timedOut, output: tail(run.output) },
  };
}

// The "Build in After Effects" button's second half: the saved project goes
// to the After Effects app like a double-click would. Nothing is scripted.
function openInAe(aep) {
  const caps = capabilities();
  if (!caps.app || !fs.existsSync(aep)) return false;
  const child = spawn("open", ["-a", caps.app, aep], { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
  return true;
}

function decodeTiff(file) {
  return new Promise((resolve, reject) => {
    if (!ffmpegAvailable) return reject(new Error("the bundled ffmpeg is missing, so aerender's TIFF frames can't be read"));
    const child = spawn(ffmpegPath, ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    let err = "";
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => {
      err = (err + d).slice(-4000);
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg could not read ${path.basename(file)}: ${err.trim()}`))));
  });
}

// aerender frames of the package's main comp at comp frames `frames`
// (inclusive -s N -e N, one launch each), straight RGBA8 at comp size.
async function renderFrames(pkg, opts = {}) {
  const p = packageOf(pkg);
  if (!fs.existsSync(p.aep)) throw new Error("The package has not been built yet — run_ae_script first.");
  const sceneText = await readIfExists(path.join(p.dir, "scene.json"));
  if (!sceneText) throw new Error("The package has no scene.json.");
  const comp = core.mainCompOf(sceneText);
  const list = [...new Set((Array.isArray(opts.frames) ? opts.frames : [0]).map((f) => Math.round(Number(f))))];
  if (!list.length || list.length > core.MAX_RENDER_FRAMES) throw new Error(`render takes 1–${core.MAX_RENDER_FRAMES} frames (got ${list.length})`);
  const outDir = path.join(p.dir, "renders", `ae-${Date.now()}`);
  await fsp.mkdir(outDir, { recursive: true });
  const env = { TBX_SHADER_BUNDLES: path.join(p.dir, "shaders") };
  const frames = [];
  const t0 = Date.now();
  for (const frame of list) {
    const args = core.renderArgs({ project: p.aep, comp: comp.name, output: path.join(outDir, `f${frame}_[#####].tif`), frame });
    const run = await runAerender(args, env);
    const file = (await fsp.readdir(outDir)).filter((f) => f.startsWith(`f${frame}_`) && f.endsWith(".tif")).map((f) => path.join(outDir, f))[0];
    if (!file) {
      frames.push({ frame, error: `aerender wrote no frame${run.timedOut ? " (timed out)" : ""}:\n${tail(run.output, 12)}` });
      continue;
    }
    try {
      const rgba = await decodeTiff(file);
      if (rgba.length !== comp.width * comp.height * 4)
        throw new Error(`the frame is ${rgba.length} bytes, not ${comp.width}×${comp.height} RGBA`);
      core.unpremultiply(rgba);
      frames.push({ frame, width: comp.width, height: comp.height, file, rgba: rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength), seconds: run.seconds });
    } catch (e) {
      frames.push({ frame, file, error: e && e.message ? e.message : String(e) });
    }
  }
  return { comp, frames, seconds: (Date.now() - t0) / 1000, manifest: manifestOf(await readIfExists(path.join(p.dir, "toolbox.json"))) };
}

// toolbox.json's two fields compare_ae_renders reads, type-checked: the rest
// of the file is the renderer's and stays in the package.
function manifestOf(text) {
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    const c = j && typeof j.composition === "object" && j.composition ? j.composition : null;
    return {
      ...(typeof j.output === "string" ? { output: j.output.slice(0, 256) } : {}),
      ...(c ? { composition: { ...(typeof c.id === "string" ? { id: c.id.slice(0, 256) } : {}), ...(typeof c.name === "string" ? { name: c.name.slice(0, 256) } : {}) } } : {}),
    };
  } catch {
    return null;
  }
}

function runChecker(bin, file) {
  return new Promise((resolve) => {
    const child = spawn(bin, [file, "--json"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.on("data", (d) => {
      out = (out + d).slice(-200_000);
    });
    child.stderr.on("data", (d) => {
      err = (err + d).slice(-20_000);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ status: -1, stdout: out, stderr: `${err}${e.message}` });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout: out, stderr: err });
    });
  });
}

// tbxshader-check on one bundle's .tbxfx text (validate_ae_shader).
async function checkShader({ text } = {}) {
  const caps = capabilities();
  if (!caps.shaderCheck) return { available: false, reason: "tbxshader-check not found (set TOOLBOX_SHADER_CHECK, or build ../AE_Plugins/toolbox-shader)" };
  if (typeof text !== "string" || !text || text.length > 32 << 20) throw new Error("checkShader: expected the .tbxfx text (≤ 32 MB)");
  let id = 0;
  try {
    id = Number(JSON.parse(text).id);
  } catch {
    /* tbxshader-check reports the parse error itself */
  }
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "toolbox-tbxfx-"));
  try {
    const file = path.join(tmp, `${Number.isInteger(id) && id > 0 ? id : "bundle"}.tbxfx`);
    await fsp.writeFile(file, text);
    const r = await runChecker(caps.shaderCheck, file);
    const line = r.stdout.trim().split("\n").pop() || "";
    let json = null;
    try {
      json = JSON.parse(line);
    } catch {
      json = null;
    }
    return { available: true, checker: caps.shaderCheck, status: r.status, json, stdout: tail(r.stdout, 40), stderr: tail(r.stderr, 20) };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

function killAll() {
  for (const child of [...running]) killTree(child);
  running.clear();
  removeHook();
}

function register() {
  // Synchronous probe for the preload (platform.aeCapabilities).
  ipcMain.on("toolbox:ae:capabilities", (event) => {
    try {
      event.returnValue = capabilities();
    } catch (e) {
      event.returnValue = { available: false, reason: String(e && e.message ? e.message : e), candidates: [], shaderHost: { installed: false }, shaderCheck: null };
    }
  });
  ipcMain.handle("toolbox:ae:createPackage", (_e, opts) => createPackage(opts || {}));
  ipcMain.handle("toolbox:ae:build", (_e, pkg, opts) => enqueue(() => buildPackage(pkg, opts || {})));
  ipcMain.handle("toolbox:ae:render", (_e, pkg, opts) => enqueue(() => renderFrames(pkg, opts || {})));
  ipcMain.handle("toolbox:ae:checkShader", (_e, opts) => checkShader(opts || {}));
}

module.exports = { register, killAll, capabilities, createPackage, buildPackage, renderFrames, checkShader, openInAe };
