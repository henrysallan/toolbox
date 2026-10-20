// The After Effects package's trust boundary in the main process (spec
// 091926_after-effects-handoff.md §8): electron/safe-paths.js (what a nested
// write may name, what may reach aerender's command line), files.js
// resolveInFolder (writes stay inside a registered folder, symlinks
// included), and electron/ae-core.js (the pinned build.jsx hash, the startup
// hook, the build driver, aerender's render argv, the TIFF unpremultiply,
// where After Effects is looked for). The renderer-side mirror
// (package/files.ts vetPackagePath / aePackageBaseName) is held to the same
// corpus. The live half — real aerender — is e2e-package.mts.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import * as acorn from "acorn";

import { makeChecker } from "./harness.mts";
import { aePackageBaseName, vetPackagePath } from "@/lib/ae-export/package/files";

/* eslint-disable @typescript-eslint/no-explicit-any */

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const safe = require(join(REPO, "electron/safe-paths.js"));
const core = require(join(REPO, "electron/ae-core.js"));
const files = require(join(REPO, "electron/files.js"));

const GOOD = [
  "scene.json",
  "build.jsx",
  "presets/bar.ffx",
  "shaders/3720283.tbxfx",
  "footage/p1.mov",
  "footage/deep/nested/a b.png",
  "footage/café ☕.png",
  "a".repeat(128),
];
const BAD: [string, string][] = [
  ["", "empty"],
  ["/etc/passwd", "absolute"],
  ["C:/x.mov", "drive"],
  ["c:x", "drive letter, no slash"],
  ["../x.mov", "climbs"],
  ["footage/../../x", "climbs mid-path"],
  ["footage/./x.mov", "dot segment"],
  ["footage//x.mov", "empty segment"],
  ["footage/", "trailing slash"],
  ["footage\\x.mov", "backslash"],
  ['foo"bar.mov', "double quote"],
  ["footage/it's.mov", "single quote (package files are generated names; the folder above may have one)"],
  ["foo`bar", "backtick"],
  ["a:b", "colon"],
  ["a*b", "star"],
  ["a?b", "question mark"],
  ["a<b>", "angle brackets"],
  ["a|b", "pipe"],
  ["a\nb", "newline"],
  ["a\u0000b", "NUL"],
  ["a\u0085b", "C1 control"],
  ["a\u2028b", "line separator"],
  [".hidden", "hidden file"],
  ["footage/.DS_Store", "hidden segment"],
  ["~/x", "tilde"],
  ["footage/x. ", "trailing space"],
  ["footage/x.", "trailing dot"],
  ["a".repeat(129), "segment too long"],
  [`${"a/".repeat(260)}x`, "path too long"],
];

export default async function run(): Promise<number> {
  const c = makeChecker("package-paths");

  // ---- relative paths: main and the renderer mirror agree ---------------------
  for (const p of GOOD) {
    const m = safe.vetRelativePath(p);
    c.check(`ok: ${JSON.stringify(p).slice(0, 60)}`, m.ok && vetPackagePath(p).ok, m.reason);
  }
  for (const [p, why] of BAD) {
    const m = safe.vetRelativePath(p);
    const r = vetPackagePath(p);
    c.check(`refused (${why}): ${JSON.stringify(p).slice(0, 40)}`, !m.ok && !r.ok && m.reason === (r as any).reason, { main: m.reason, renderer: (r as any).reason });
  }
  c.check("non-strings are refused", !safe.vetRelativePath(null).ok && !safe.vetRelativePath(42).ok && !vetPackagePath(undefined).ok);

  // ---- resolveInside never leaves the root, fuzzed ------------------------------
  const root = "/tmp/toolbox-pkg-root";
  const alphabet = ["a", "b", "..", ".", "/", "\\", "%2e%2e", "~", " ", ":", "x.mov"];
  let leaked = 0;
  let tried = 0;
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  for (let i = 0; i < 4000; i++) {
    let s = "";
    for (let k = 0, n = 1 + Math.floor(rnd() * 7); k < n; k++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    tried++;
    try {
      const abs: string = safe.resolveInside(root, s);
      if (!abs.startsWith(`${root}/`)) leaked++;
    } catch {
      /* refused — fine */
    }
  }
  c.check(`resolveInside: ${tried} random paths, none resolves outside the root`, leaked === 0, leaked);

  // ---- files.js resolveInFolder: registered folders only, symlinks re-checked ---
  const tmp = mkdtempSync(join(tmpdir(), "tbx-pkg-paths-"));
  try {
    const pkg = join(tmp, "x.aepkg");
    mkdirSync(pkg);
    const outside = join(tmp, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(pkg, "footage"));
    const rejects = async (p: Promise<unknown>) => p.then(() => false, () => true);
    c.check("resolveInFolder refuses a folder nobody registered", await rejects(files.resolveInFolder(pkg, "scene.json")));
    files.registerFolder(pkg);
    const ok: string = await files.resolveInFolder(pkg, "presets/bar.ffx");
    c.check("resolveInFolder: a nested path inside lands inside (parents created)", ok === join(pkg, "presets", "bar.ffx"));
    c.check("resolveInFolder: a symlinked subfolder pointing outside is refused", await rejects(files.resolveInFolder(pkg, "footage/p1.mov")));
    c.check("resolveInFolder: .. is refused", await rejects(files.resolveInFolder(pkg, "../outside/x.mov")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // ---- aerender's command line ----------------------------------------------------
  const okAe = ["/Users/x/Documents/Toolbox/After Effects/Hero.aepkg", "/Users/x/it's mine/a b.aepkg", "/Users/x/café ☕/x.aepkg"];
  const badAe = ['/Users/x/"quoted"/x.aepkg', "/Users/x/back\\slash", "/Users/x/new\nline", "/Users/x/a\u2028b", "relative/x.aepkg", ""];
  c.check("aerenderSafe takes plain absolute paths (a ' measured fine)", okAe.every((p) => safe.aerenderSafe(p).ok));
  c.check("aerenderSafe refuses quotes, backslashes, control / line-terminator characters and relative paths", badAe.every((p) => !safe.aerenderSafe(p).ok));
  const argv = core.renderArgs({ project: "/a/x.aepkg/x.aep", comp: "Main Comp", output: "/a/x.aepkg/renders/r/f3_[#####].tif", frame: 3 });
  c.check(
    "renderArgs: -project / -comp / Best Settings / TIFF Sequence with Alpha / -output / -s N -e N",
    JSON.stringify(argv) ===
      JSON.stringify(["-project", "/a/x.aepkg/x.aep", "-comp", "Main Comp", "-RStemplate", "Best Settings", "-OMtemplate", "TIFF Sequence with Alpha", "-output", "/a/x.aepkg/renders/r/f3_[#####].tif", "-s", "3", "-e", "3", "-sound", "OFF"]),
    argv
  );
  const throws = (f: () => unknown) => {
    try {
      f();
      return false;
    } catch {
      return true;
    }
  };
  c.check("renderArgs refuses an unsafe project / output", throws(() => core.renderArgs({ project: '/a/"x".aep', comp: "C", output: "/a/o.tif", frame: 0 })) && throws(() => core.renderArgs({ project: "/a/x.aep", comp: "C", output: "/a\\o.tif", frame: 0 })));
  c.check("renderArgs refuses a comp name with a quote or backslash", throws(() => core.renderArgs({ project: "/a/x.aep", comp: 'My "comp"', output: "/a/o.tif", frame: 0 })) && throws(() => core.renderArgs({ project: "/a/x.aep", comp: "a\\b", output: "/a/o.tif", frame: 0 })));
  c.check("renderArgs refuses a fractional / negative frame", throws(() => core.renderArgs({ project: "/a/x.aep", comp: "C", output: "/a/o.tif", frame: 1.5 })) && throws(() => core.renderArgs({ project: "/a/x.aep", comp: "C", output: "/a/o.tif", frame: -1 })));
  c.check("the build launch passes aerender no path at all", JSON.stringify(core.BUILD_ARGS) === JSON.stringify(["-sound", "OFF"]));

  // ---- the pinned builder ----------------------------------------------------------
  const bj = readFileSync(join(REPO, "src/lib/ae-export/runtime/build.jsx"));
  const sha = createHash("sha256").update(bj).digest("hex");
  c.check(
    "electron/ae-core.js BUILD_JSX_SHA256 pins build.jsx (update it with build.jsx: main only evaluates the builder it ships)",
    core.BUILD_JSX_SHA256 === sha,
    { pinned: core.BUILD_JSX_SHA256, actual: sha }
  );

  // ---- the startup hook and the driver -----------------------------------------------
  const es3 = (src: string) => {
    try {
      acorn.parse(src, { ecmaVersion: 3, sourceType: "script" });
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };
  const ascii = (src: string) => [...src].every((ch) => ch.charCodeAt(0) <= 0x7e && (ch.charCodeAt(0) >= 0x20 || ch === "\n"));
  c.check("HOOK_SOURCE is ES3 and ASCII", es3(core.HOOK_SOURCE) === "" && ascii(core.HOOK_SOURCE), es3(core.HOOK_SOURCE));
  c.check(
    "the hook is inert without its env var and only evaluates the file it names",
    core.HOOK_SOURCE.includes(`$.getenv("${core.HOOK_ENV}")`) && /if \(!driver\) return;/.test(core.HOOK_SOURCE) && (core.HOOK_SOURCE.match(/evalFile/g) ?? []).length === 1
  );
  c.check("the hook's file name sorts after other startup scripts and names Toolbox", /^zz_toolbox_.*\.jsx$/.test(core.HOOK_FILE));
  const hostile = '/Users/x/he said "hi"\\ \n\u2028 café ☕ \u0000/x.aepkg';
  const drv = core.driverSource({ buildJsx: "/tmp/t/build.jsx", packageDir: hostile, doneFile: "/tmp/t/done.txt" });
  c.check("driverSource is ES3 and ASCII for any package path", es3(drv) === "" && ascii(drv), es3(drv));
  const lit = /\$\.global\.TBX_AE_PACKAGE = (".*");/.exec(drv)?.[1] ?? "";
  c.check("the package path survives the driver's string literal exactly", vm.runInNewContext(lit) === hostile, lit);
  c.check(
    "the driver sets build.jsx's globals (quiet, overwrite, package) and evaluates only main's copy of build.jsx",
    /TBX_AE_QUIET = true/.test(drv) && /TBX_AE_OVERWRITE = true/.test(drv) && (drv.match(/evalFile/g) ?? []).length === 1 && drv.includes('"/tmp/t/build.jsx"')
  );

  // ---- TIFF unpremultiply, comps, candidates -------------------------------------------
  const px = new Uint8Array([100, 50, 0, 200, 255, 255, 255, 255, 7, 7, 7, 0, 128, 64, 32, 128, 255, 0, 0, 1]);
  core.unpremultiply(px);
  c.check(
    "unpremultiply: c·255/a, rounded and clamped; opaque and transparent pixels untouched",
    JSON.stringify([...px]) === JSON.stringify([128, 64, 0, 200, 255, 255, 255, 255, 7, 7, 7, 0, 255, 128, 64, 128, 255, 0, 0, 1]),
    [...px]
  );
  const comp = core.mainCompOf(JSON.stringify({ main: "m", comps: [{ id: "p", name: "Pre", width: 10, height: 10, fps: 24, duration: 1 }, { id: "m", name: "Main", width: 1920, height: 1080, fps: 30, duration: 2 }] }));
  c.check("mainCompOf picks scene.main", comp.name === "Main" && comp.width === 1920 && comp.fps === 30);
  c.check("mainCompOf refuses a scene without its main comp", throws(() => core.mainCompOf(JSON.stringify({ main: "x", comps: [] }))) && throws(() => core.mainCompOf("{")));
  const cands = core.aeCandidateDirs({ TOOLBOX_AE_DIR: "/opt/AE" }, "darwin");
  c.check(
    "After Effects candidates: TOOLBOX_AE_DIR first, then the release folders newest first, then the beta",
    cands[0].dir === "/opt/AE" && cands[0].source === "env" && cands[0].aerender === "/opt/AE/aerender" && cands.some((x: any) => x.dir === "/Applications/Adobe After Effects 2026") && cands.at(-1).dir.endsWith("(Beta)"),
    cands.map((x: any) => x.dir)
  );
  c.check("no After Effects candidates off macOS (spec §11.7)", core.aeCandidateDirs({}, "win32").length === 0);
  c.check(
    "prefs folder: the app's major.minor, else the newest with the same major",
    core.pickPrefsVersion("26.5.0", ["26.0", "26.5"]) === "26.5" && core.pickPrefsVersion("26.6.1", ["26.0", "26.5", "25.6"]) === "26.5" && core.prefsVersionOf("x") === null
  );
  const checkers = core.shaderCheckCandidates({ TOOLBOX_SHADER_CHECK: "/env/tbxshader-check" }, "/Users/x/toolbox/.claude/worktrees/w/electron");
  c.check(
    "tbxshader-check: TOOLBOX_SHADER_CHECK first, then ../AE_Plugins/toolbox-shader/build beside each ancestor",
    checkers[0].path === "/env/tbxshader-check" && checkers.some((x: any) => x.path === "/Users/x/AE_Plugins/toolbox-shader/build/tbxshader-check"),
    checkers.map((x: any) => x.path)
  );

  // ---- package names: main and the renderer agree; the result is writable --------------
  const names = ["Hero", "  My Comp  ", 'a "quoted" / name', ".hidden", "...", "", "x.aepkg", "  .My \"pkg\"/x.aepkg ", "café ☕", "a".repeat(200), "tab\there", "C:\\evil"];
  for (const n of names) {
    const m = safe.sanitizeBaseName(n);
    const r = aePackageBaseName(n);
    c.check(`package name ${JSON.stringify(n).slice(0, 30)} → ${JSON.stringify(m).slice(0, 30)} (main ≡ renderer, a valid folder name)`, m === r && safe.vetRelativePath(`${m}.aepkg`).ok, { main: m, renderer: r });
  }

  return c.failures;
}
