// skia-parity: does the React Native Skia export render what toolbox renders?
// Spec: specdocs/101326_skia-target.md (M0 step 4, §3.6).
//
//   npm run export:skia -- --fixture aurora --out skia-harness/src/bundle
//   npm --prefix skia-harness run export:web
//   npm run parity:skia            # [--frames 0,45,120] [--size 512] [--write-golden]
//   npm run parity:skia -- --bundle native|native-easings   # Reanimated-native exports
//
// One offscreen Electron window, two pages on one local server:
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
// --write-golden also writes TOOLBOX's frames (never the device's) to
// scripts/fixtures/skia/golden/aurora-<size>-f<frame>.png + aurora-<size>.json
// (scripts/skia/golden.cjs). Commit them: the iOS / Android lanes
// (scripts/skia-device-parity.mjs, .github/workflows/skia-device-parity.yml)
// score device captures against those files, since there is no toolbox on
// a phone to render the reference.
//
// CommonJS: an Electron main-process entry. Must run with ELECTRON_RUN_AS_NODE
// unset (the npm script handles it).
/* eslint-disable @typescript-eslint/no-require-imports */
const { app } = require("electron");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const H = require("./skia/electron-harness.cjs");
const { encodePng } = require("./skia/png.cjs");
const golden = require("./skia/golden.cjs");

const REPO = H.REPO;
const HARNESS_DIST = path.join(REPO, "skia-harness", "dist");
// effect = the M0 SkSL Shader bundle (skia-harness/src/bundle); scene = the
// Skia-layer scene bundle (src/bundle-scene, `--fixture aurora-scene`); baked =
// the effect bundle exported with `--animation baked` (src/bundle-baked);
// image = an SkSL Shader sampling a bundled image + ramp / curve LUT
// children (src/bundle-image, `--fixture image`, Wave 3 lane I);
// native / native-easings / native-scene = Reanimated-native exports
// (`--animation native`: src/bundle-native = Aurora, src/bundle-native-
// easings = every easing kind, src/bundle-native-scene = Aurora as a Skia
// layer); atlas = Copy to Points (Skia) (src/bundle-atlas, `--fixture atlas`:
// sprite-sheet atlases + vector copy groups). The native pages run on the harness's fake clock
// (?clock=fake): each capture steps Reanimated frame by frame from play(),
// so frames must ascend, and the run also reports every animated value's
// drift from the worklet-mode curve at every frame (drift.json).
const BUNDLE = H.arg("bundle", "effect");
const NATIVE = BUNDLE === "native" || BUNDLE === "native-easings" || BUNDLE === "native-scene";
// --jitter <ms> [--seed n] (native only): the fake clock's frames wobble by
// up to ± that much, deterministically — a real vsync, not a perfect one.
// Drift is then measured against the worklet value at the same jittered
// time; the pixels still compare with toolbox's exact frames.
const JITTER = Number(H.arg("jitter", "0"));
const SEED = Number(H.arg("seed", "1"));
const OUT = path.join(REPO, "skia-harness", "parity-out", NATIVE ? `${BUNDLE}${JITTER ? `-jitter${JITTER}` : ""}` : "");
const BUNDLE_DIR = path.join(OUT, ".bundle");

// atlas = Copy to Points (Skia) (src/bundle-atlas, `--fixture atlas`): a 30 fps
// fixture, so its default frames (60 Hz, as every capture time is f / 60)
// land on its own frames 0, 10, … 60.
const DEFAULT_FRAMES =
  BUNDLE === "native-easings"
    ? "0,10,30,57,58,90,120,150,151,163,200,240,299"
    : BUNDLE === "atlas"
      ? "0,20,40,60,80,100,120"
      : "0,45,90,120,150,200,240,299";
const FRAMES = H.arg("frames", DEFAULT_FRAMES).split(",").map(Number);
const SIZE = Number(H.arg("size", "512"));
const WRITE_GOLDEN = H.flag("write-golden");
const FPS = 60;

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("ignore-gpu-blocklist");

if (
  FRAMES.some((f) => !Number.isInteger(f) || f < 0) ||
  (NATIVE && FRAMES.some((f, i) => i > 0 && f <= FRAMES[i - 1])) ||
  !(SIZE > 0) ||
  !(JITTER >= 0) ||
  (JITTER > 0 && !NATIVE) ||
  !["effect", "scene", "baked", "native", "native-easings", "native-scene", "atlas", "image"].includes(BUNDLE) ||
  (WRITE_GOLDEN && BUNDLE !== "effect")
) {
  console.error(
    "usage: npm run parity:skia -- [--frames 0,45,120 (ascending for native)] [--size 512] [--bundle effect|scene|baked|native|native-easings|native-scene|atlas|image] [--jitter ms --seed n (native only)] [--write-golden (effect only)]"
  );
  process.exit(2);
}
if (!fs.existsSync(path.join(HARNESS_DIST, "index.html"))) {
  console.error("skia-harness/dist is missing — run `npm --prefix skia-harness run export:web` first.");
  process.exit(2);
}
fs.mkdirSync(BUNDLE_DIR, { recursive: true });

function b64(s) {
  return Buffer.from(s, "base64");
}

function writePng(file, rgbaB64, width, height) {
  fs.writeFileSync(file, encodePng(b64(rgbaB64), width, height));
}

function gitHead() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

app.whenReady().then(async () => {
  let code = 1;
  let server = null;
  try {
    const ck = H.canvasKitAssets();
    console.log("bundling parity page…");
    try {
      H.bundlePage({
        entry: path.join(REPO, "scripts/skia/parity-page.ts"),
        outfile: path.join(BUNDLE_DIR, "bundle.js"),
        globalName: "__parity",
      });
    } catch (e) {
      throw new Error(`parity page failed to bundle: ${e.message}`);
    }
    server = await H.startServer({
      routes: {
        "/__parity/page.html": {
          type: "text/html",
          body: `<!doctype html><meta charset="utf-8"><body>
<script src="/canvaskit/${ck.version}/canvaskit.js"></script>
<script src="/__parity/bundle.js"></script></body>`,
        },
      },
      mounts: { "/__parity/": BUNDLE_DIR, "/canvaskit/": path.dirname(ck.dir) },
      // Everything else is the static web build; unknown paths are the SPA index.
      fallback: (p) => {
        const f = path.join(HARNESS_DIST, p);
        return f.startsWith(HARNESS_DIST) && fs.existsSync(f) && fs.statSync(f).isFile()
          ? f
          : path.join(HARNESS_DIST, "index.html");
      },
    });
    const win = H.makeWindow(SIZE + 64, SIZE + 96);

    // ---- device: React Native Skia (web) -------------------------------------
    const query = NATIVE ? `bundle=${BUNDLE}&clock=fake${JITTER ? `&jitter=${JITTER}&seed=${SEED}` : ""}` : `t=0${BUNDLE === "effect" ? "" : `&bundle=${BUNDLE}`}`;
    await win.loadURL(`${server.base}/?${query}&size=${SIZE}&chrome=0`);
    await H.waitFor(win, "window.__toolboxHarnessReady");
    const device = [];
    for (const f of FRAMES) {
      device.push(await H.call(win, `window.__toolboxHarness.capture(${f / FPS})`, 60000, `device capture f${f}`));
    }
    const dw = device[0].width;
    const dh = device[0].height;
    console.log(`device: captured ${device.length} frames at ${dw}×${dh}`);

    // ---- native: every animated value vs the worklet-mode curve ----------------
    let drift = null;
    if (NATIVE) {
      drift = await H.call(win, "window.__toolboxHarness.drift()");
      const values = await H.call(win, "window.__toolboxHarness.values()");
      fs.writeFileSync(path.join(OUT, "native-values.json"), JSON.stringify(values) + "\n");
      console.log(
        `native values: ${drift.length} values × ${values.frames} frames (fake 60 Hz clock from play()${JITTER ? `, ±${JITTER} ms jitter, seed ${SEED}` : ""}) vs evaluateTrack:`
      );
      for (const d of drift) {
        const rel = d.range > 0 ? d.maxAbs / d.range : 0;
        console.log(
          `  ${d.key.padEnd(16)} ${d.kind.padEnd(6)} max |Δ| ${d.maxAbs.toExponential(2)} (f${d.maxAt}, ${(rel * 100).toFixed(3)}% of range)` +
            `  frames differing ${d.framesDiffer}, > 1e-9 ${d.framesOff} (of which one frame late: ${d.lagOne})`
        );
      }
    }

    // ---- toolbox: the engine + SkSL Shader node --------------------------------
    await win.loadURL(`${server.base}/__parity/page.html`);
    await H.waitFor(win, "window.__parity && window.CanvasKitInit");
    const toolbox = await H.call(win, `window.__parity.renderToolbox(${JSON.stringify(FRAMES)}, ${SIZE}, ${JSON.stringify(BUNDLE)})`, 120000, "toolbox render");
    const served = server.served.filter((s) => s.path.endsWith("canvaskit.wasm"));
    console.log(
      `toolbox: rendered ${toolbox.length} frames at ${SIZE}×${SIZE} · CanvasKit ${ck.version} ` +
        served.map((s) => `${s.path} ${s.bytes} B`).join(", ")
    );
    if (dw !== SIZE || dh !== SIZE) throw new Error(`device frames are ${dw}×${dh}, toolbox ${SIZE}×${SIZE} — check devicePixelRatio`);

    // ---- compare -----------------------------------------------------------------
    const rows = [];
    for (let i = 0; i < FRAMES.length; i++) {
      const f = FRAMES[i];
      const { metrics, heat } = await H.call(
        win,
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
    const mid = Math.floor(FRAMES.length / 2);
    const moved = (
      await H.call(
        win,
        `window.__parity.compare(${JSON.stringify(device[0].rgba)}, ${JSON.stringify(device[mid].rgba)}, ${SIZE}, ${SIZE})`
      )
    ).metrics.meanAbs;
    console.log(`motion check: device f${FRAMES[0]} vs f${FRAMES[mid]} meanAbs ${moved.toFixed(4)} (must be ≫ 0)`);

    const all = rows.every((r) => r.verdict === "match") && moved > 0.01;
    fs.writeFileSync(
      path.join(OUT, "report.json"),
      JSON.stringify(
        { bundle: BUNDLE, ...(NATIVE ? { jitterMs: JITTER, seed: SEED } : {}), size: SIZE, frames: FRAMES, canvasKit: ck.version, motionMeanAbs: moved, rows, ...(drift ? { drift } : {}), ok: all },
        null,
        2
      ) + "\n"
    );
    console.log(all ? "PARITY: match on every frame" : "PARITY: FAILED");

    if (WRITE_GOLDEN) {
      const full = path.join(REPO, "node_modules", "canvaskit-wasm", "bin", "full", "canvaskit.wasm");
      const build = fs.existsSync(full) && fs.statSync(full).size === ck.wasmBytes ? "bin/full" : "bin";
      const w = golden.writeGolden({
        fixture: "aurora",
        size: SIZE,
        fps: FPS,
        frames: FRAMES.map((frame, i) => ({ frame, rgba: b64(toolbox[i]) })),
        meta: {
          source: "toolbox (scripts/skia/parity-page.ts: evaluateGraph → sksl-shader → readImagePixels)",
          canvasKit: { version: ck.version, build },
          toolboxCommit: gitHead(),
          webParity: {
            verdict: all ? "match" : "failed",
            maxSteps: Math.max(...rows.map((r) => r.maxSteps)),
          },
        },
      });
      console.log(`golden: wrote ${w.files.length} frames + ${path.relative(REPO, w.meta)}${all ? "" : " (web parity FAILED — check before committing)"}`);
    }
    code = all ? 0 : 1;
  } catch (e) {
    console.error(`parity:skia: ${e && e.message ? e.message : e}`);
    code = 2;
  } finally {
    if (server) server.close();
    app.exit(code);
  }
});
