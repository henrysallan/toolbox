// skia-device-parity — device truth for the React Native Skia export
// (specdocs/101326_skia-target.md §3.6, §5.4, lane L5).
//
// Builds skia-harness for the iOS Simulator or an Android emulator, captures
// the exported bundle's frames there through the harness's deep-link capture
// mode (skia-harness/capture.ts), and scores them against toolbox's golden
// frames (scripts/fixtures/skia/golden/, written by
// `npm run parity:skia -- --write-golden`) with compare_renders' own metrics —
// src/lib/glsl-translation/compare.ts imported directly (Node ≥ 22.18 strips
// its types), so the numbers are the editor's, not a port's.
//
//   npm run parity:skia:device -- --platform ios
//   npm run parity:skia:device -- --platform android --device emulator-5554
//   npm run parity:skia:device -- --platform ios --build-only        # CI: build step
//   npm run parity:skia:device -- --platform ios --skip-build        # CI: capture step
//
// Steps: prebuild (expo prebuild, once) → native build (xcodebuild for the
// simulator / gradle assemble) → boot (create + boot a simulator from the
// newest iOS runtime; use or boot an Android emulator) → install → start a
// collector on 127.0.0.1 → open `toolboxharness://hello` until the app
// answers → one `toolboxharness://capture?t=…` per golden frame (`xcrun
// simctl openurl` / `adb shell am start -a VIEW -d …`) → compare → write
// skia-harness/device-out/<platform>/ (f<N>-device.png, f<N>-golden.png,
// f<N>-heat.png, report.json, report.md; the summary is appended to
// $GITHUB_STEP_SUMMARY when set). The simulator reaches the collector at
// 127.0.0.1, the emulator at 10.0.2.2 (its alias for the host's loopback).
//
// Release builds: the JS bundle is embedded, so no Metro server has to run
// beside the device, and dev-only overlays and checks are off.
//
// Options:
//   --platform ios|android   required
//   --golden FILE            golden meta (default scripts/fixtures/skia/golden/aurora-512.json)
//   --frames 0,150           a subset of the golden frames (default: all)
//   --expect match|close     band every frame must reach (default match)
//   --device ID              iOS: simulator UDID or name; Android: adb serial
//   --avd NAME               Android: boot this AVD when no device is attached
//   --abi ABI                Android ABI to build (default: the host's — x86_64 / arm64-v8a)
//   --configuration C        Release (default) | Debug (Debug needs Metro running)
//   --build-only | --skip-build
//   --app PATH               install this .app / .apk instead of the built one
//   --clean                  re-run expo prebuild --clean
//   --screenshots            also save the device screen per frame (unscored:
//                            the composited, color-managed screen, see below)
//   --timeout MS             per-capture timeout (default 90000)
//   --allow-stale-golden     score even if the bundle changed since the goldens
//   --out DIR                output dir (default skia-harness/device-out/<platform>)
//   --simulate [noise]       self-test without a device: answer the deep links
//                            with the golden frames (+ ±noise steps) through
//                            the real collector. Exercises everything but the
//                            device; the report says so.
//
// Exit codes: 0 every frame within --expect and the clock moved; 1 a frame
// beyond the band (or a static clock); 2 setup / build / device / timeout.
//
// What the snapshot measures: makeImageSnapshot() of a declarative canvas
// is a replay into an offscreen sRGB surface (react-native-skia 3.4.0,
// RNSkView::makeImageSnapshot), so these numbers are the device GPU's math
// in sRGB — not what a Display P3 screen shows. --screenshots keeps the
// screen for eyeballing; scoring it needs color management this tool
// doesn't do.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { encodePng } = require("./skia/png.cjs");
const golden = require("./skia/golden.cjs");

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS = path.join(REPO, "skia-harness");
const APP_JSON = JSON.parse(fs.readFileSync(path.join(HARNESS, "app.json"), "utf8")).expo;
const SCHEME = APP_JSON.scheme;
const VERDICT_RANK = { match: 0, close: 1, off: 2 };

class SetupError extends Error {}

// ---- args --------------------------------------------------------------------
const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) usage(`--${name} needs a value`);
  return v;
}
const flag = (name) => argv.includes(`--${name}`);
function usage(msg) {
  if (msg) console.error(`skia-device-parity: ${msg}`);
  console.error(
    "usage: npm run parity:skia:device -- --platform ios|android [--golden file] [--frames 0,150]\n" +
      "         [--expect match|close] [--device id] [--avd name] [--abi abi] [--configuration Release|Debug]\n" +
      "         [--build-only|--skip-build] [--app path] [--clean] [--screenshots] [--timeout ms]\n" +
      "         [--allow-stale-golden] [--out dir] [--simulate [noise]]"
  );
  process.exit(2);
}
if (flag("help")) usage();
const PLATFORM = arg("platform");
if (PLATFORM !== "ios" && PLATFORM !== "android") usage("--platform must be ios or android");
const GOLDEN = path.resolve(arg("golden", golden.metaPath("aurora", 512)));
const EXPECT = arg("expect", "match");
if (!(EXPECT in VERDICT_RANK)) usage("--expect must be match, close or off");
const CONFIG = arg("configuration", "Release");
if (CONFIG !== "Release" && CONFIG !== "Debug") usage("--configuration must be Release or Debug");
const BUILD_ONLY = flag("build-only");
const SKIP_BUILD = flag("skip-build");
if (BUILD_ONLY && SKIP_BUILD) usage("--build-only and --skip-build are exclusive");
const APP_ARG = arg("app");
const CLEAN = flag("clean");
const SCREENSHOTS = flag("screenshots");
const TIMEOUT = Number(arg("timeout", "90000"));
const ALLOW_STALE = flag("allow-stale-golden");
const OUT = path.resolve(arg("out", path.join(HARNESS, "device-out", PLATFORM)));
const DEVICE = arg("device");
const AVD = arg("avd");
const ABI = arg("abi", process.arch === "arm64" ? "arm64-v8a" : "x86_64");
const simIdx = argv.indexOf("--simulate");
const SIMULATE = simIdx >= 0;
const SIM_NOISE = SIMULATE && argv[simIdx + 1] && !argv[simIdx + 1].startsWith("--") ? Number(argv[simIdx + 1]) : 0;
const FRAMES_ARG = arg("frames");

// ---- process helpers ------------------------------------------------------------
function run(cmd, args, { cwd = REPO, env, label } = {}) {
  console.log(`$ ${[cmd, ...args].join(" ")}${cwd !== REPO ? `   (in ${path.relative(REPO, cwd) || "."})` : ""}`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
  if (r.error?.code === "ENOENT") throw new SetupError(`${label ?? cmd}: ${cmd} is not installed or not on PATH`);
  if (r.error) throw new SetupError(`${label ?? cmd}: ${r.error.message}`);
  if (r.status !== 0) throw new SetupError(`${label ?? cmd} exited with ${r.status}`);
}

function out(cmd, args, { cwd = REPO, allowFail = false, encoding = "utf8" } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) {
    if (allowFail) return null;
    if (r.error.code === "ENOENT") throw new SetupError(`${cmd} is not installed or not on PATH (needed for: ${cmd} ${args.join(" ")})`);
    throw new SetupError(`${cmd} ${args.join(" ")}: ${r.error.message}`);
  }
  if (r.status !== 0) {
    if (allowFail) return null;
    throw new SetupError(`${cmd} ${args.join(" ")} exited with ${r.status}: ${String(r.stderr).trim().slice(0, 2000)}`);
  }
  return r.stdout;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function versionCmp(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

function prebuild(platform) {
  const dir = path.join(HARNESS, platform);
  if (fs.existsSync(dir) && !CLEAN) return;
  run("npx", ["expo", "prebuild", "--platform", platform, "--no-install", ...(CLEAN ? ["--clean"] : [])], {
    cwd: HARNESS,
    env: { CI: "1", EXPO_NO_GIT_STATUS: "1", EXPO_NO_TELEMETRY: "1" },
    label: "expo prebuild",
  });
}

// ---- iOS -----------------------------------------------------------------------
const IOS_DERIVED = path.join(HARNESS, "ios", "build");

function iosWorkspace() {
  const dir = path.join(HARNESS, "ios");
  const ws = fs.existsSync(dir) && fs.readdirSync(dir).find((f) => f.endsWith(".xcworkspace"));
  if (!ws) throw new SetupError("skia-harness/ios has no .xcworkspace — run with --clean, or check `expo prebuild` / `pod install` output");
  return { dir, ws: path.join(dir, ws), scheme: ws.replace(/\.xcworkspace$/, "") };
}

function iosAppPath() {
  // Before a prebuild there is no workspace to read the scheme from; Expo
  // names the project after expo.name with the non-alphanumerics dropped.
  let scheme = APP_JSON.name.replace(/[^A-Za-z0-9]/g, "");
  try {
    scheme = iosWorkspace().scheme;
  } catch {
    // not prebuilt yet — the caller reports the missing .app
  }
  return path.join(IOS_DERIVED, "Build", "Products", `${CONFIG}-iphonesimulator`, `${scheme}.app`);
}

function iosBuild() {
  prebuild("ios");
  run("pod", ["install"], { cwd: path.join(HARNESS, "ios"), label: "pod install" });
  const { dir, ws, scheme } = iosWorkspace();
  run(
    "xcodebuild",
    [
      "-workspace", ws,
      "-scheme", scheme,
      "-configuration", CONFIG,
      "-sdk", "iphonesimulator",
      "-destination", "generic/platform=iOS Simulator",
      "-derivedDataPath", IOS_DERIVED,
      `ARCHS=${process.arch === "arm64" ? "arm64" : "x86_64"}`,
      "ONLY_ACTIVE_ARCH=NO",
      "CODE_SIGNING_ALLOWED=NO",
      "COMPILER_INDEX_STORE_ENABLE=NO",
      "-quiet",
      "build",
    ],
    { cwd: dir, label: "xcodebuild" }
  );
  return iosAppPath();
}

function simctlJson(...args) {
  return JSON.parse(out("xcrun", ["simctl", "list", ...args, "-j"]));
}

// A booted simulator UDID, plus what it is for the report.
function iosDevice() {
  const devices = simctlJson("devices", "available").devices;
  const all = Object.entries(devices).flatMap(([runtime, list]) => list.map((d) => ({ ...d, runtime })));
  let dev = null;
  if (DEVICE) {
    dev = all.find((d) => d.udid === DEVICE) ?? all.find((d) => d.name === DEVICE);
    if (!dev) throw new SetupError(`no available simulator "${DEVICE}" (have: ${all.map((d) => d.name).join(", ")})`);
  } else {
    const runtimes = simctlJson("runtimes", "available").runtimes.filter((r) => r.platform === "iOS" && r.isAvailable !== false);
    if (!runtimes.length) throw new SetupError("no iOS simulator runtime is installed (xcodebuild -downloadPlatform iOS)");
    runtimes.sort((a, b) => versionCmp(b.version, a.version));
    const rt = runtimes[0];
    const types = (rt.supportedDeviceTypes ?? simctlJson("devicetypes").devicetypes).filter(
      (t) => (t.productFamily ?? (/iPhone/.test(t.name) ? "iPhone" : "")) === "iPhone"
    );
    const pick =
      types.filter((t) => /^iPhone \d+ Pro$/.test(t.name)).sort((a, b) => versionCmp(b.name.match(/\d+/)[0], a.name.match(/\d+/)[0]))[0] ??
      types[types.length - 1];
    if (!pick) throw new SetupError(`runtime ${rt.name} supports no iPhone device type`);
    const name = `toolbox-parity ${pick.name} (${rt.version})`;
    dev = all.find((d) => d.name === name && d.runtime === rt.identifier);
    if (!dev) {
      const udid = out("xcrun", ["simctl", "create", name, pick.identifier, rt.identifier]).trim();
      dev = { udid, name, runtime: rt.identifier, state: "Shutdown" };
      console.log(`created simulator ${name} → ${udid}`);
    }
  }
  if (dev.state !== "Booted") out("xcrun", ["simctl", "boot", dev.udid], { allowFail: true });
  run("xcrun", ["simctl", "bootstatus", dev.udid, "-b"], { label: "simctl bootstatus" });
  return { id: dev.udid, description: `${dev.name} · ${dev.runtime.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, "")}` };
}

function iosBundleId(app) {
  const id = out("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", path.join(app, "Info.plist")], { allowFail: true });
  return (id ?? APP_JSON.ios.bundleIdentifier).trim();
}

const ios = {
  build: iosBuild,
  appPath: iosAppPath,
  device: iosDevice,
  host: (port) => `http://127.0.0.1:${port}`,
  install(dev, app) {
    run("xcrun", ["simctl", "install", dev.id, app], { label: "simctl install" });
    this.bundleId = iosBundleId(app);
    out("xcrun", ["simctl", "terminate", dev.id, this.bundleId], { allowFail: true });
  },
  open(dev, url) {
    out("xcrun", ["simctl", "openurl", dev.id, url]);
  },
  screenshot(dev, file) {
    out("xcrun", ["simctl", "io", dev.id, "screenshot", "--type=png", file], { allowFail: true });
  },
};

// ---- Android -----------------------------------------------------------------
function sdkTool(rel, name) {
  const home = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const p = home && path.join(home, rel, name);
  return p && fs.existsSync(p) ? p : name;
}
const ADB = () => sdkTool("platform-tools", "adb");

function androidApkPath() {
  const v = CONFIG.toLowerCase();
  return path.join(HARNESS, "android", "app", "build", "outputs", "apk", v, `app-${v}.apk`);
}

function androidBuild() {
  prebuild("android");
  const dir = path.join(HARNESS, "android");
  run(path.join(dir, process.platform === "win32" ? "gradlew.bat" : "gradlew"), [`assemble${CONFIG}`, `-PreactNativeArchitectures=${ABI}`], {
    cwd: dir,
    label: "gradle",
  });
  return androidApkPath();
}

function adbDevices() {
  return out(ADB(), ["devices"])
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter(([s, state]) => s && state === "device")
    .map(([s]) => s);
}

async function androidDevice() {
  if (DEVICE && !adbDevices().includes(DEVICE)) {
    throw new SetupError(`adb has no device "${DEVICE}" (attached: ${adbDevices().join(", ") || "none"})`);
  }
  let serial = DEVICE ?? adbDevices()[0];
  if (!serial && AVD) {
    console.log(`booting AVD ${AVD}…`);
    const emu = spawn(sdkTool("emulator", "emulator"), ["-avd", AVD, "-no-window", "-gpu", "swiftshader_indirect", "-no-snapshot", "-noaudio", "-no-boot-anim"], {
      detached: true,
      stdio: "ignore",
    });
    emu.unref();
    out(ADB(), ["wait-for-device"]);
    serial = adbDevices()[0];
  }
  if (!serial) throw new SetupError("no Android device attached (start an emulator, or pass --avd <name>)");
  const t0 = Date.now();
  while (out(ADB(), ["-s", serial, "shell", "getprop", "sys.boot_completed"], { allowFail: true })?.trim() !== "1") {
    if (Date.now() - t0 > 600000) throw new SetupError(`${serial} did not finish booting in 10 min`);
    await sleep(2000);
  }
  const prop = (k) => out(ADB(), ["-s", serial, "shell", "getprop", k], { allowFail: true })?.trim() ?? "?";
  return { id: serial, description: `${prop("ro.product.model")} · Android ${prop("ro.build.version.release")} (API ${prop("ro.build.version.sdk")}) · ${prop("ro.product.cpu.abi")}` };
}

const android = {
  build: androidBuild,
  appPath: androidApkPath,
  device: androidDevice,
  host: (port) => `http://10.0.2.2:${port}`,
  install(dev, apk) {
    run(ADB(), ["-s", dev.id, "install", "-r", "-t", apk], { label: "adb install" });
    this.pkg = APP_JSON.android.package;
    out(ADB(), ["-s", dev.id, "shell", "am", "force-stop", this.pkg], { allowFail: true });
  },
  open(dev, url) {
    // adb joins the args into one device-shell command line: quote the URL
    // so its `&`s survive (it never contains a single quote).
    out(ADB(), ["-s", dev.id, "shell", "am", "start", "-W", "-a", "android.intent.action.VIEW", "-d", `'${url}'`, this.pkg]);
  },
  screenshot(dev, file) {
    const png = out(ADB(), ["-s", dev.id, "exec-out", "screencap", "-p"], { allowFail: true, encoding: "buffer" });
    if (png) fs.writeFileSync(file, png);
  },
};

// ---- collector -----------------------------------------------------------------
// POST /hello | /frame | /error with { run, frame?, … }. Arrivals for this
// run land in a mailbox, so a reply that beats its waiter is not lost.
function startCollector(run) {
  const mailbox = new Map();
  const waiters = new Map();
  let failure = null;
  const deliver = (key, msg) => {
    const w = waiters.get(key);
    if (w) {
      waiters.delete(key);
      clearTimeout(w.timer);
      w.resolve(msg);
    } else if (!mailbox.has(key)) mailbox.set(key, msg);
  };
  const server = http.createServer((req, res) => {
    const kind = req.url.replace(/^\/+/, "").split("?")[0];
    if (req.method !== "POST" || !["hello", "frame", "error"].includes(kind)) {
      res.writeHead(404);
      return res.end();
    }
    const chunks = [];
    let bytes = 0;
    req.on("data", (c) => {
      bytes += c.length;
      if (bytes > 512 * 1024 * 1024) req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400);
        return res.end();
      }
      res.writeHead(204);
      res.end();
      if (body.run !== run) return; // a previous run's straggler
      if (kind === "hello") deliver("hello", body);
      else if (kind === "frame") deliver(`frame:${body.frame}`, body);
      else {
        failure = new SetupError(`the harness reported an error${body.frame != null ? ` at frame ${body.frame}` : ""}: ${body.message}`);
        for (const [key, w] of waiters) {
          waiters.delete(key);
          clearTimeout(w.timer);
          w.reject(failure);
        }
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        close: () => server.close(),
        wait(key, ms) {
          if (failure) return Promise.reject(failure);
          if (mailbox.has(key)) {
            const m = mailbox.get(key);
            mailbox.delete(key);
            return Promise.resolve(m);
          }
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              waiters.delete(key);
              rej(new SetupError(`no ${key} from the harness within ${ms} ms`));
            }, ms);
            waiters.set(key, { resolve: res, reject: rej, timer });
          });
        },
      })
    )
  );
}

// --simulate: a stand-in device that answers each link with the golden
// frame (± noise) through the real collector.
function simulator(goldenFrames, size) {
  const post = (url, body) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
  let seed = 1;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  return {
    build: () => null,
    appPath: () => "(simulated)",
    device: async () => ({ id: "sim", description: `simulated device (golden frames${SIM_NOISE ? ` ± ${SIM_NOISE} steps` : ""}) — NOT a device measurement` }),
    host: (port) => `http://127.0.0.1:${port}`,
    install() {},
    open(_dev, url) {
      const m = /^[^:]+:\/\/([a-z]+)\?(.*)$/.exec(url);
      const p = Object.fromEntries(m[2].split("&").map((kv) => kv.split("=").map(decodeURIComponent)));
      if (m[1] === "hello") return void post(`${p.host}/hello`, { run: p.run, platform: "simulated", pixelRatio: 1 });
      const px = Buffer.from(goldenFrames.get(Number(p.frame)));
      if (SIM_NOISE) for (let i = 0; i < px.length; i++) if (i % 4 !== 3) px[i] = Math.max(0, Math.min(255, px[i] + Math.round((rand() * 2 - 1) * SIM_NOISE)));
      void post(`${p.host}/frame`, { run: p.run, frame: Number(p.frame), t: Number(p.t), width: size, height: size, pixelRatio: 1, attempts: 2, rgba: px.toString("base64") });
    },
    screenshot() {},
  };
}

// ---- scoring ------------------------------------------------------------------
function stats(a, b, n) {
  let maxSteps = 0;
  let identical = 0;
  for (let i = 0; i < n; i++) {
    let px = 0;
    for (let c = 0; c < 4; c++) px = Math.max(px, Math.abs(a[i * 4 + c] - b[i * 4 + c]));
    if (px === 0) identical++;
    if (px > maxSteps) maxSteps = px;
  }
  return { maxSteps, identical: identical / n };
}

function markdown(report) {
  const pct = (v) => `${(v * 100).toFixed(2)}%`;
  const lines = [
    `### Skia device parity — ${report.platform}: ${report.ok ? "PASS" : "FAIL"}`,
    "",
    `- device: ${report.device.description}${report.hello?.pixelRatio ? ` · pixel ratio ${report.hello.pixelRatio}` : ""}`,
    `- golden: \`${report.golden.file}\` (${report.golden.size}², CanvasKit ${report.golden.canvasKit?.version ?? "?"} ${report.golden.canvasKit?.build ?? ""}, toolbox ${report.golden.toolboxCommit ?? "?"})`,
    `- band: \`${report.expect}\` · motion f${report.frames[0]}→f${report.motion.frame}: meanAbs ${report.motion.meanAbs.toFixed(4)}`,
    "",
    "| frame | verdict | meanAbs | p95 | max | identical | alpha |",
    "|---:|---|---:|---:|---:|---:|---:|",
    ...report.rows.map(
      (r) =>
        `| ${r.frame} | ${r.verdict}${r.note ? ` (${r.note})` : ""} | ${r.meanAbs.toFixed(5)} | ${r.p95Abs.toFixed(4)} | ${r.maxSteps}/255 | ${pct(r.identical)} | ${r.alphaMeanAbs.toFixed(4)} |`
    ),
    "",
    "Snapshots are `makeImageSnapshot()` replays into an sRGB surface: GPU math in sRGB, not the (possibly Display P3) screen.",
  ];
  return lines.join("\n") + "\n";
}

// ---- main ----------------------------------------------------------------------
async function main() {
  let compare;
  try {
    compare = await import("../src/lib/glsl-translation/compare.ts");
  } catch (e) {
    throw new SetupError(
      `could not load src/lib/glsl-translation/compare.ts (${e.message}) — this needs Node ≥ 22.18, which strips TypeScript types natively`
    );
  }
  const { meta, frames: goldenFrames } = golden.readGolden(GOLDEN);
  const size = meta.size;
  let frames = meta.frames;
  if (FRAMES_ARG) {
    frames = FRAMES_ARG.split(",").map(Number);
    const missing = frames.filter((f) => !goldenFrames.has(f));
    if (missing.length) throw new SetupError(`no golden for frame(s) ${missing.join(", ")} (have ${meta.frames.join(", ")})`);
  }
  const digest = golden.bundleDigest();
  if (digest !== meta.bundle?.sha256) {
    const msg = `skia-harness/src/bundle changed since the goldens were written (${meta.bundle?.sha256?.slice(0, 12)} → ${digest.slice(0, 12)}) — re-export, then \`npm run parity:skia -- --write-golden\``;
    if (!ALLOW_STALE) throw new SetupError(msg);
    console.warn(`warning: ${msg}`);
  }
  console.log(`golden: ${path.relative(REPO, GOLDEN)} · ${size}² · frames ${frames.join(",")} · @${meta.fps} fps`);

  const P = SIMULATE ? simulator(goldenFrames, size) : PLATFORM === "ios" ? ios : android;
  if (!SIMULATE && PLATFORM === "ios" && process.platform !== "darwin") throw new SetupError("the iOS lane needs macOS + Xcode");

  let app = APP_ARG ? path.resolve(APP_ARG) : null;
  if (!app && !SKIP_BUILD && !SIMULATE) app = P.build();
  if (BUILD_ONLY) {
    console.log(`built ${path.relative(REPO, app)}`);
    return 0;
  }
  if (!app) app = P.appPath();
  if (!SIMULATE && !fs.existsSync(app)) throw new SetupError(`${app} does not exist — build first (drop --skip-build)`);

  const dev = await P.device();
  console.log(`device: ${dev.description}`);
  P.install(dev, app);

  const RUN = crypto.randomBytes(6).toString("hex");
  const collector = await startCollector(RUN);
  const host = P.host(collector.port);
  const link = (action, params) =>
    `${SCHEME}://${action}?${Object.entries({ ...params, run: RUN, host })
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join("&")}`;
  fs.mkdirSync(OUT, { recursive: true });

  try {
    // Cold start: the first link launches the app (getInitialURL); a link
    // that lands before JS listens is dropped, so repeat until it answers.
    console.log(`collector ${host} · run ${RUN}`);
    const hello = collector.wait("hello", Math.max(TIMEOUT, 180000));
    let answered = false;
    hello.then(() => (answered = true), () => {});
    for (let i = 0; !answered && i < 36; i++) {
      P.open(dev, link("hello", {}));
      for (let k = 0; k < 50 && !answered; k++) await sleep(100);
    }
    const helloMsg = await hello;
    console.log(`harness: ${helloMsg.platform} ${helloMsg.version ?? ""} · pixel ratio ${helloMsg.pixelRatio}`);

    const rows = [];
    const captured = new Map();
    for (const f of frames) {
      const t = f / meta.fps;
      const pending = collector.wait(`frame:${f}`, TIMEOUT);
      P.open(dev, link("capture", { t, frame: f, size }));
      const msg = await pending;
      const px = Buffer.from(msg.rgba, "base64");
      if (SCREENSHOTS) P.screenshot(dev, path.join(OUT, `f${f}-screen.png`));
      fs.writeFileSync(path.join(OUT, `f${f}-device.png`), encodePng(px, msg.width, msg.height));
      if (msg.width !== size || msg.height !== size || px.length !== size * size * 4) {
        rows.push({ frame: f, verdict: "off", note: `device frame is ${msg.width}×${msg.height}, golden ${size}²`, meanAbs: 1, p95Abs: 1, alphaMeanAbs: 1, maxSteps: 255, identical: 0, overThreshold: 1, compared: 0, worstBox: null });
        console.log(`f${f}: OFF — device frame is ${msg.width}×${msg.height} at pixel ratio ${msg.pixelRatio}, golden ${size}² (density rounding? try another device profile)`);
        continue;
      }
      captured.set(f, px);
      const g = goldenFrames.get(f);
      const m = { ...compare.compareRgba(g, px, size, size), ...stats(g, px, size * size), attempts: msg.attempts };
      fs.writeFileSync(path.join(OUT, `f${f}-golden.png`), encodePng(g, size, size));
      fs.writeFileSync(path.join(OUT, `f${f}-heat.png`), encodePng(compare.diffHeatRgba(g, px, size, size), size, size));
      rows.push({ frame: f, ...m });
      console.log(
        `f${f}: ${m.verdict.toUpperCase()} meanAbs ${m.meanAbs.toFixed(5)} p95 ${m.p95Abs.toFixed(4)} max ${m.maxSteps}/255 identical ${(m.identical * 100).toFixed(2)}% alpha ${m.alphaMeanAbs.toFixed(4)}`
      );
    }

    // The clock really moved on the device (not one frame captured N times).
    const mid = frames[Math.floor(frames.length / 2)];
    const motion = {
      frame: mid,
      meanAbs: captured.has(frames[0]) && captured.has(mid) && mid !== frames[0] ? compare.compareRgba(captured.get(frames[0]), captured.get(mid), size, size).meanAbs : 0,
    };
    const moved = frames.length < 2 || motion.meanAbs > 0.01;
    console.log(`motion check: device f${frames[0]} vs f${mid} meanAbs ${motion.meanAbs.toFixed(4)}${moved ? "" : " — the clock did not move"}`);
    const worst = rows.reduce((v, r) => (VERDICT_RANK[r.verdict] > VERDICT_RANK[v] ? r.verdict : v), "match");
    const ok = VERDICT_RANK[worst] <= VERDICT_RANK[EXPECT] && moved;
    const report = {
      platform: PLATFORM,
      simulated: SIMULATE,
      configuration: CONFIG,
      device: dev,
      hello: helloMsg,
      golden: { file: path.relative(REPO, GOLDEN), ...meta, files: undefined },
      bundleSha256: digest,
      expect: EXPECT,
      frames,
      rows,
      motion,
      verdict: worst,
      ok,
    };
    fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2) + "\n");
    const md = markdown(report);
    fs.writeFileSync(path.join(OUT, "report.md"), md);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
    console.log(`${ok ? "DEVICE PARITY: PASS" : "DEVICE PARITY: FAIL"} (${worst}, expect ${EXPECT}) → ${path.relative(REPO, OUT)}/`);
    return ok ? 0 : 1;
  } finally {
    collector.close();
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`skia-device-parity: ${e instanceof SetupError ? e.message : e?.stack ?? e}`);
    process.exit(2);
  }
);
