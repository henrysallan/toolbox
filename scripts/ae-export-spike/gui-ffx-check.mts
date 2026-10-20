// Verify the synthesized .ffx gradient presets in the After Effects APP —
// the one spike check that cannot run headless (layer.applyPreset hangs
// aerender's render core; spec §13).
//
//   npx tsx scripts/ae-export-spike/gui-ffx-check.mts --yes-gui [--out DIR]
//   npx tsx scripts/ae-export-spike/gui-ffx-check.mts --frame gui-frame0.png   re-check a captured frame (no AE)
//
// It SCRIPTS THE RUNNING After Effects (osascript DoScriptFile into
// com.adobe.AfterEffects.application), so it refuses without --yes-gui; run it
// only with the owner's OK. What it does there (gui-ffx-check.jsx): refuses if
// the open project has unsaved changes; imports a test project as a folder;
// applies the three presets of fixture c-gradient; saves one frame as PNG;
// removes the folder and re-opens the comp that was active. Side effects: two
// undo steps, and AE marks the project modified (its contents are unchanged).
//
// Before that it builds the test project headless through aerender (the same
// one-launch Startup hook as run.mts; the GUI is not involved in that part).

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

/* eslint-disable @typescript-eslint/no-explicit-any */

const HERE = dirname(fileURLToPath(import.meta.url));
const AE_DIR = process.env.AE_DIR ?? "/Applications/Adobe After Effects 2026";
const AERENDER = join(AE_DIR, "aerender");
const STARTUP = join(homedir(), "Library/Preferences/Adobe/After Effects", process.env.AE_PREFS_VERSION ?? "26.5", "Scripts/Startup");
const HOOK = join(STARTUP, "zz_toolbox_ae_spike_hook.jsx");
const GUI_BUNDLE = "com.adobe.AfterEffects.application";

const args = process.argv.slice(2);

// ---------------------------------------------------------------------------
// The frame check. saveFrameToPng writes a 16-bit PNG whose scale depends on
// the open project's settings (the owner's project put white at 6553/65535),
// so every sample is read relative to the plain white fill in the same frame.
// ---------------------------------------------------------------------------

function decodePng(buf: Buffer) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let o = 8;
  let width = 0, height = 0, depth = 0, type = 0;
  const idat: Buffer[] = [];
  while (o < buf.length) {
    const n = buf.readUInt32BE(o);
    const t = buf.toString("latin1", o + 4, o + 8);
    const body = buf.subarray(o + 8, o + 8 + n);
    if (t === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      type = body[9];
      if (body[12] !== 0) throw new Error("interlaced PNG");
    } else if (t === "IDAT") idat.push(body);
    o += 12 + n;
  }
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[type];
  if (!channels || (depth !== 8 && depth !== 16)) throw new Error(`unsupported PNG (type ${type}, ${depth}-bit)`);
  const bpp = (channels * depth) / 8;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const rows: Uint8Array[] = [];
  let prev = new Uint8Array(stride);
  for (let y = 0, p = 0; y < height; y++, p += stride + 1) {
    const f = raw[p];
    const line = new Uint8Array(raw.subarray(p + 1, p + 1 + stride));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      line[x] = (line[x] + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]) & 255;
    }
    rows.push(line);
    prev = line;
  }
  const max = depth === 16 ? 65535 : 255;
  const get = (x: number, y: number): number[] => {
    const r = rows[y];
    const v: number[] = [];
    for (let k = 0; k < channels; k++) v.push((depth === 16 ? (r[(x * channels + k) * 2] << 8) | r[(x * channels + k) * 2 + 1] : r[x * channels + k]) / max);
    return channels >= 3 ? v : [v[0], v[0], v[0], v[1] ?? 1];
  };
  return { width, height, depth, channels, get };
}

// The c-gradient fixture's gradient samples (run.mts lists the same, GUI-only).
const CHECKS: [string, number, number, number[]][] = [
  ["bar (preset path group 0 / item 2 ≠ the item, 1): red stop", 101, 150, [255, 0, 0]],
  ["bar: red → green at 25%", 250, 150, [128, 128, 0]],
  ["bar: green stop at 50%", 400, 150, [0, 255, 0]],
  ["bar: blue stop at the end", 698, 150, [0, 0, 255]],
  ["ring (radial G-Stroke, exact path): 75% yellow → magenta", 350, 420, [255, 64, 191]],
  ["nested groups (exact path): black → white midpoint", 650, 330, [128, 128, 128]],
];
const WHITE: [number, number] = [600, 580]; // the SVG-seeded layer's plain white fill

function checkFrame(png: string): number {
  const img = decodePng(readFileSync(png));
  const white = img.get(WHITE[0], WHITE[1]);
  const scale = white[0];
  let failures = 0;
  const line = (ok: boolean, text: string) => {
    if (!ok) failures++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${text}`);
  };
  console.log(`\nframe ${img.width}×${img.height}, ${img.depth}-bit, ${img.channels} channels; white fill encodes as ${white.slice(0, 3).map((v) => v.toFixed(4)).join(", ")}`);
  line(scale > 0 && white[1] === scale && white[2] === scale && white[3] === 1, `white reference at (${WHITE[0]}, ${WHITE[1]}) is neutral and opaque`);
  for (const [label, x, y, want] of CHECKS) {
    const got = img.get(x, y).slice(0, 3).map((v) => Math.round((v / scale) * 255));
    line(want.every((w, i) => Math.abs(got[i] - w) <= 3), `(${x}, ${y}) ${label} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)} (relative to white)`);
  }
  return failures;
}

const frameIdx = args.indexOf("--frame");
if (frameIdx >= 0) {
  const n = checkFrame(resolve(args[frameIdx + 1]));
  console.log(n ? `\ngui-ffx-check --frame: ${n} FAILED` : "\ngui-ffx-check --frame: all passed");
  process.exit(n ? 1 : 0);
}

if (!args.includes("--yes-gui")) {
  console.error("This scripts the running After Effects app. Re-run with --yes-gui once the owner has agreed.");
  process.exit(2);
}
const outIdx = args.indexOf("--out");
const WORK = outIdx >= 0 ? resolve(args[outIdx + 1]) : join(tmpdir(), `toolbox-ae-gui-ffx-${Date.now()}`);
mkdirSync(WORK, { recursive: true });
const js = (v: unknown) => JSON.stringify(v).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

// 1. The c-gradient package (presets synthesized, bar on ffx.ts's default path).
const pk = spawnSync("npx", ["tsx", join(HERE, "run.mts"), "c-gradient", "--no-ae", "--out", WORK], { stdio: "inherit" });
if (pk.status !== 0) process.exit(1);
const PKG = join(WORK, "c-gradient.aepkg");
const AEP = join(PKG, "c-gradient.aep");

// 2. Build it headless (build.jsx only).
const buildDriver = join(WORK, "build-only.jsx");
writeFileSync(buildDriver, [
  "$.global.TBX_AE_QUIET = true;",
  "$.global.TBX_AE_OVERWRITE = true;",
  `$.global.TBX_AE_PACKAGE = ${js(PKG)};`,
  "app.setSavePreferencesOnQuit(false);",
  `$.evalFile(new File(${js(join(PKG, "build.jsx"))}));`,
  "",
].join("\n"));
if (existsSync(HOOK)) rmSync(HOOK);
mkdirSync(STARTUP, { recursive: true });
copyFileSync(join(HERE, "hook.jsx"), HOOK);
process.on("exit", () => existsSync(HOOK) && rmSync(HOOK));
await new Promise<void>((res) => {
  const child = spawn(AERENDER, ["-project", join(WORK, "none.aep")], { env: { ...process.env, TBX_AE_SPIKE_DRIVER: buildDriver }, stdio: "ignore" });
  child.on("close", () => res());
});
rmSync(HOOK, { force: true });
const built = JSON.parse(readFileSync(join(PKG, "build-log.json"), "utf8"));
if (!built.ok || !existsSync(AEP)) {
  console.error("headless build failed", built.problems);
  process.exit(1);
}
console.log(`built ${AEP} headless (presets skipped there: ${built.warnings.length})`);

// 3. Phase 1 in the app.
const STATIC = join(HERE, "gui-ffx-check.jsx");
const PNG = join(WORK, "gui-frame0.png");
function runInApp(phase: number, extra: Record<string, unknown>): Record<string, any> {
  const result = join(WORK, `gui-result-${phase}.json`);
  rmSync(result, { force: true });
  const driver = join(WORK, `gui-phase${phase}.jsx`);
  writeFileSync(driver, `$.global.TBX_FFX_CHECK_CFG = ${js({ phase, result, ...extra })};\n$.evalFile(new File(${js(STATIC)}));\n`);
  execFileSync("osascript", ["-e", "with timeout of 300 seconds", "-e", `tell application id "${GUI_BUNDLE}" to DoScriptFile (POSIX file ${JSON.stringify(driver)})`, "-e", "end timeout"], { stdio: "inherit" });
  return JSON.parse(readFileSync(result, "utf8"));
}
rmSync(PNG, { force: true });
const jobs = [
  { layer: "Gradient rect", preset: join(PKG, "presets/bar.ffx") },
  { layer: "Gradient ring", preset: join(PKG, "presets/ring.ffx") },
  { layer: "Nested gradient", preset: join(PKG, "presets/nested.ffx") },
];
const r1 = runInApp(1, { aep: AEP, comp: "Gradient", png: PNG, jobs });
console.log("phase 1:", JSON.stringify(r1));
if (r1.aborted || !r1.ok) process.exit(r1.aborted ? 2 : 1);

// 4. Wait for the asynchronous frame, then clean up in the app.
const t0 = Date.now();
while (!existsSync(PNG) && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 250));
await new Promise((r) => setTimeout(r, 500));
const pngOk = existsSync(PNG);
const r2 = runInApp(2, { state: { folderId: r1.folderId, folderName: r1.folderName, prevActiveId: r1.prevActiveId } });
console.log("phase 2:", JSON.stringify(r2));
if (!pngOk) {
  console.error("no frame written within 60 s");
  process.exit(1);
}

// 5. Pixels.
let failures = checkFrame(PNG);
for (const j of r1.jobs ?? []) {
  const ok = j.ok && j.layersAfter === 0 && j.itemsAdded === 0;
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${j.layer}: preset applied in place (new layers ${j.layersAfter}, new contents ${j.itemsAdded})${j.error ? " — " + j.error : ""}`);
}
const restored = r2.ok && r2.itemsAfter === r1.itemsBefore;
if (!restored) failures++;
console.log(`  ${restored ? "ok  " : "FAIL"} project item count restored (${r1.itemsBefore} → ${r2.itemsAfter})`);
writeFileSync(join(WORK, "gui-ffx-results.json"), JSON.stringify({ phase1: r1, phase2: r2, frame: PNG }, null, 2));
console.log(failures ? `\ngui-ffx-check: ${failures} FAILED (${WORK})` : `\ngui-ffx-check: all passed (${WORK})`);
process.exit(failures ? 1 : 0);
