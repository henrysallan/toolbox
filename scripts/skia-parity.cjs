// skia-parity: does the React Native Skia export render what toolbox renders?
// Spec: specdocs/101326_skia-target.md (M0 step 4).
//
//   npm run export:skia -- --fixture aurora --out skia-harness/src/bundle
//   npm --prefix skia-harness run export:web
//   npm run parity:skia            # [--frames 0,45,120] [--size 512]
//
// One hidden Electron window, two pages on one local server:
//   device  — skia-harness/dist: the exported bundle running in React Native
//             Skia's web target (CanvasKit, Reanimated on the JS thread). Each
//             frame is seeked on the master clock and read back through
//             makeImageSnapshot().readPixels() — Skia's pixels, not the
//             compositor's.
//   toolbox — scripts/skia/parity-page.ts: the same fixture through
//             evaluateGraph and the SkSL Shader node, read back with the
//             engine's readImagePixels — what the editor shows.
// Metrics are compare_renders' own (compareRgba); PNGs + report land in
// skia-harness/parity-out/. Exit 1 unless every frame reads `match`.
//
// What this does NOT cover: the iOS / Android renderers (Graphite on Metal /
// Vulkan). That needs `npx expo run:ios` on a Mac with Xcode, then the same
// capture through the simulator — spec M1.
//
// CommonJS: an Electron main-process entry. Must run with ELECTRON_RUN_AS_NODE
// unset (the npm script handles it).
/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, nativeImage } = require("electron");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..");
const HARNESS_DIST = path.join(REPO, "skia-harness", "dist");
const OUT = path.join(REPO, "skia-harness", "parity-out");
const BUNDLE = path.join(OUT, ".parity-page.bundle.js");
const CANVASKIT_DIR = path.join(REPO, "public", "canvaskit");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}
const FRAMES = arg("frames", "0,45,90,120,150,200,240,299").split(",").map(Number);
const SIZE = Number(arg("size", "512"));
const FPS = 60;

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("ignore-gpu-blocklist");

if (!fs.existsSync(path.join(HARNESS_DIST, "index.html"))) {
  console.error("skia-harness/dist is missing — run `npm --prefix skia-harness run export:web` first.");
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

console.log("bundling parity page…");
// node:* stays external: esm-potrace-wasm's glue has a guarded
// require("node:fs") branch that never runs in a renderer.
try {
execFileSync(
  "npx",
  [
    "esbuild",
    path.join(REPO, "scripts/skia/parity-page.ts"),
    "--bundle",
    "--format=iife",
    "--global-name=__parity",
    "--platform=browser",
    "--target=es2022",
    `--alias:@=${path.join(REPO, "src")}`,
    "--loader:.wasm=file",
    "--loader:.sksl=text",
    "--external:node:*",
    `--outfile=${BUNDLE}`,
    "--log-level=error",
  ],
  { cwd: REPO, stdio: "inherit" }
);
} catch {
  console.error("parity page failed to bundle");
  process.exit(2);
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".ico": "image/x-icon" };
const PAGE = `<!doctype html><meta charset="utf-8"><body>
<script src="/canvaskit/0.41.0/canvaskit.js"></script>
<script src="/__parity/bundle.js"></script></body>`;

function serve(req, res) {
  const url = new URL(req.url, "http://x");
  let file;
  if (url.pathname === "/__parity/page.html") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(PAGE);
  }
  if (url.pathname === "/__parity/bundle.js") file = BUNDLE;
  else if (url.pathname.startsWith("/canvaskit/")) file = path.join(CANVASKIT_DIR, url.pathname.slice("/canvaskit/".length));
  else {
    file = path.join(HARNESS_DIST, decodeURIComponent(url.pathname));
    if (!file.startsWith(HARNESS_DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(HARNESS_DIST, "index.html");
    }
  }
  if (!fs.existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

function writePng(file, rgbaB64, width, height) {
  const rgba = Buffer.from(rgbaB64, "base64");
  const bgra = Buffer.alloc(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    bgra[i] = rgba[i + 2];
    bgra[i + 1] = rgba[i + 1];
    bgra[i + 2] = rgba[i];
    bgra[i + 3] = rgba[i + 3];
  }
  fs.writeFileSync(file, nativeImage.createFromBitmap(bgra, { width, height }).toPNG());
}

function js(win, code, ms = 30000) {
  return Promise.race([
    win.webContents.executeJavaScript(code),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${code.slice(0, 80)}`)), ms)),
  ]);
}

async function waitFor(win, expr, ms = 60000) {
  const t0 = Date.now();
  for (;;) {
    if (await win.webContents.executeJavaScript(`!!(${expr})`)) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${expr}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

app.whenReady().then(async () => {
  const server = http.createServer(serve);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // Offscreen rendering, not a hidden window: a hidden (or backgrounded)
  // window suspends requestAnimationFrame entirely (TESTING.md §Traps), and
  // React Native Skia's web canvas only redraws on rAF — every capture would
  // wait forever. Offscreen windows keep a real frame clock with WebGL.
  const win = new BrowserWindow({
    show: false,
    width: SIZE + 64,
    height: SIZE + 96,
    webPreferences: { offscreen: true, backgroundThrottling: false, nodeIntegration: false },
  });
  win.webContents.setFrameRate(60);
  win.webContents.on("console-message", (_e, level, msg) => {
    if (level >= 2) console.log(`[page] ${msg}`);
  });
  let code = 1;
  try {
    // ---- device: React Native Skia (web) -------------------------------------
    await win.loadURL(`${base}/?t=0&size=${SIZE}&chrome=0`);
    await waitFor(win, "window.__toolboxHarnessReady");
    const device = [];
    for (const f of FRAMES) {
      device.push(await js(win, `window.__toolboxHarness.capture(${f / FPS})`));
    }
    const dw = device[0].width;
    const dh = device[0].height;
    console.log(`device: captured ${device.length} frames at ${dw}×${dh}`);

    // ---- toolbox: the engine + SkSL Shader node --------------------------------
    await win.loadURL(`${base}/__parity/page.html`);
    await waitFor(win, "window.__parity && window.CanvasKitInit");
    const toolbox = await js(win, `window.__parity.renderToolbox(${JSON.stringify(FRAMES)}, ${SIZE})`, 120000);
    console.log(`toolbox: rendered ${toolbox.length} frames at ${SIZE}×${SIZE}`);
    if (dw !== SIZE || dh !== SIZE) throw new Error(`device frames are ${dw}×${dh}, toolbox ${SIZE}×${SIZE} — check devicePixelRatio`);

    // ---- compare -----------------------------------------------------------------
    const rows = [];
    for (let i = 0; i < FRAMES.length; i++) {
      const f = FRAMES[i];
      const { metrics, heat } = await win.webContents.executeJavaScript(
        `window.__parity.compare(${JSON.stringify(toolbox[i])}, ${JSON.stringify(device[i].rgba)}, ${SIZE}, ${SIZE})`
      );
      writePng(path.join(OUT, `f${f}-toolbox.png`), toolbox[i], SIZE, SIZE);
      writePng(path.join(OUT, `f${f}-device.png`), device[i].rgba, SIZE, SIZE);
      writePng(path.join(OUT, `f${f}-heat.png`), heat, SIZE, SIZE);
      rows.push({ frame: f, ...metrics });
      console.log(
        `f${f}: ${metrics.verdict.toUpperCase()} meanAbs ${metrics.meanAbs.toFixed(5)} p95 ${metrics.p95Abs.toFixed(4)} max ${metrics.maxSteps}/255 identical ${(metrics.identical * 100).toFixed(2)}%`
      );
    }
    // The clock really moved: first and middle device frames must differ.
    const moved = await win.webContents.executeJavaScript(
      `window.__parity.compare(${JSON.stringify(device[0].rgba)}, ${JSON.stringify(device[Math.floor(FRAMES.length / 2)].rgba)}, ${SIZE}, ${SIZE}).metrics.meanAbs`
    );
    console.log(`motion check: device f${FRAMES[0]} vs f${FRAMES[Math.floor(FRAMES.length / 2)]} meanAbs ${moved.toFixed(4)} (must be ≫ 0)`);

    const all = rows.every((r) => r.verdict === "match") && moved > 0.01;
    fs.writeFileSync(
      path.join(OUT, "report.json"),
      JSON.stringify({ size: SIZE, frames: FRAMES, motionMeanAbs: moved, rows, ok: all }, null, 2) + "\n"
    );
    console.log(all ? "PARITY: match on every frame" : "PARITY: FAILED");
    code = all ? 0 : 1;
  } catch (e) {
    console.error(e);
  } finally {
    server.close();
    app.exit(code);
  }
});
