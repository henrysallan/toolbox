// bench:skia-atlas — what Copy to Points (Skia) costs to draw per frame,
// groups (N vector <Group> copies) vs atlas (one <Atlas> of a sprite sheet),
// on CanvasKit WebGL (Ganesh: React Native Skia's web renderer), headless.
// The numbers behind ATLAS_AUTO_MIN (src/nodes/skia/copy-to-points.ts) and
// specdocs/101326_skia-target.md §3.4 "built and measured".
//
//   npm run bench:skia-atlas [-- --counts 1,4,16,64,256,1024,4096] [--size 512] [--frames 60] [--static]
//
// Prints one row per (N, strategy): median and p90 ms per frame (draw +
// submit + GPU wait), and the first frame (the atlas sheet's one-time
// raster). Writes scripts/.skia-compare-out/atlas-bench[-static].json. State the machine with the
// numbers (TESTING.md §6); a GPU-bound phone is not this Mac.
//
// CommonJS: an Electron main-process entry (run with ELECTRON_RUN_AS_NODE
// unset — the npm script handles it).
/* eslint-disable @typescript-eslint/no-require-imports */
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const H = require("./skia/electron-harness.cjs");

const COUNTS = H.arg("counts", "1,4,9,16,25,36,64,144,256,1024,4096")
  .split(",")
  .map((s) => Number(s.trim()));
const SIZE = Number(H.arg("size", "512"));
const FRAMES = Number(H.arg("frames", "60"));
const ANIMATED = !H.flag("static");
const BUNDLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "skia-atlas-bench-"));

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("ignore-gpu-blocklist");

app.whenReady().then(async () => {
  let code = 2;
  let server = null;
  let win = null;
  try {
    const ck = H.canvasKitAssets();
    H.bundlePage({ entry: path.join(H.REPO, "scripts", "skia", "atlas-bench-page.ts"), outfile: path.join(BUNDLE_DIR, "bundle.js"), globalName: "__bench" });
    server = await H.startServer({
      routes: {
        "/__bench/page.html": {
          type: "text/html",
          body: `<!doctype html><meta charset="utf-8"><body>
<script src="/canvaskit/${ck.version}/canvaskit.js"></script>
<script src="/__bench/bundle.js"></script></body>`,
        },
      },
      mounts: { "/canvaskit/": path.dirname(ck.dir), "/__bench/": BUNDLE_DIR },
    });
    win = H.makeWindow(SIZE + 64, SIZE + 64);
    await win.loadURL(`${server.base}/__bench/page.html`);
    await H.waitFor(win, "window.__bench && window.CanvasKitInit", 30000);
    await H.call(win, "window.__bench.init()", 60000, "init");
    const gpu = await H.call(win, "window.__bench.renderer()", 10000, "renderer");
    console.log(`CanvasKit ${ck.version} WebGL · ${gpu} · ${SIZE}² · ${FRAMES} frames · ${ANIMATED ? "Rotate + animated" : "static"}`);
    const rows = [];
    for (const n of COUNTS) {
      const line = [];
      for (const strategy of ["groups", "atlas"]) {
        const r = await H.call(win, `window.__bench.bench(${n}, ${JSON.stringify(strategy)}, ${SIZE}, ${FRAMES}, ${ANIMATED})`, 600000, `bench ${n} ${strategy}`);
        rows.push(r);
        line.push(`${strategy} ${r.medianMs.toFixed(3)} ms mean (p90 ${r.p90Ms.toFixed(3)}, first ${r.firstMs.toFixed(1)})`);
      }
      const g = rows[rows.length - 2];
      const a = rows[rows.length - 1];
      console.log(`N=${String(n).padStart(5)}: ${line.join(" · ")} · atlas/groups ${(a.medianMs / g.medianMs).toFixed(2)}`);
    }
    const outDir = path.join(H.REPO, "scripts", ".skia-compare-out");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `atlas-bench${ANIMATED ? "" : "-static"}.json`), JSON.stringify({ gpu, size: SIZE, frames: FRAMES, animated: ANIMATED, rows }, null, 2) + "\n");
    code = 0;
  } catch (e) {
    console.error(`bench:skia-atlas: ${e && e.message ? e.message : e}`);
    if (e && e.pageStack) console.error(e.pageStack);
  } finally {
    if (server) server.close();
    fs.rmSync(BUNDLE_DIR, { recursive: true, force: true });
    app.exit(code);
  }
});
