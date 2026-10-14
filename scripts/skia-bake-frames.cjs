// skia-bake-frames: render Skia Bake frames with toolbox's REAL engine,
// headless — the CLI exporter's (scripts/export-skia.mts) stand-in for the
// editor's renderSkiaBakeFrames. Spec: specdocs/101326_skia-target.md §3.2
// (`bake`).
//
//   env -u ELECTRON_RUN_AS_NODE electron scripts/skia-bake-frames.cjs --job job.json --out dir
//
// job.json (scripts/skia/bake-page.ts BakeJob): { nodes, edges, size,
// timeline, renders: [{ nodeId, source: { node, handle }, ticks }] }.
// Writes <out>/<render index>-<tick>.rgba (width × height × 4 bytes, RGBA8
// straight alpha, row 0 = top) for every frame that rendered, and
// <out>/done.json listing them. Exit 0 on success, 2 on any setup or
// render error.
//
// CommonJS: an Electron main-process entry. Must run with ELECTRON_RUN_AS_NODE
// unset.
/* eslint-disable @typescript-eslint/no-require-imports */
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const H = require("./skia/electron-harness.cjs");

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("ignore-gpu-blocklist");

const JOB = H.arg("job");
const OUT = H.arg("out");
if (!JOB || !OUT) {
  console.error("usage: electron scripts/skia-bake-frames.cjs --job job.json --out dir");
  process.exit(2);
}
const BUNDLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "skia-bake-frames-"));

app.whenReady().then(async () => {
  let code = 2;
  let server = null;
  try {
    const job = JSON.parse(fs.readFileSync(JOB, "utf8"));
    const ck = H.canvasKitAssets();
    H.bundlePage({ entry: path.join(H.REPO, "scripts", "skia", "bake-page.ts"), outfile: path.join(BUNDLE_DIR, "bundle.js"), globalName: "__bake" });
    server = await H.startServer({
      routes: {
        "/__bake/page.html": {
          type: "text/html",
          body: `<!doctype html><meta charset="utf-8"><body>
<script src="/canvaskit/${ck.version}/canvaskit.js"></script>
<script src="/__bake/bundle.js"></script></body>`,
        },
      },
      mounts: { "/canvaskit/": path.dirname(ck.dir), "/__bake/": BUNDLE_DIR, "/fonts/": path.join(H.REPO, "public", "fonts") },
    });
    const win = H.makeWindow(320, 320);
    await win.loadURL(`${server.base}/__bake/page.html`);
    await H.waitFor(win, "window.__bake && window.CanvasKitInit", 30000);
    await H.call(win, "window.__bake.init()", 60000, "init");
    fs.mkdirSync(OUT, { recursive: true });
    const done = [];
    for (let i = 0; i < job.renders.length; i++) {
      const frames = await H.call(win, `window.__bake.render(${JSON.stringify(job)}, ${i})`, 600000, `render ${job.renders[i].nodeId}`);
      job.renders[i].ticks.forEach((tick, k) => {
        if (!frames[k]) return;
        const file = path.join(OUT, `${i}-${tick}.rgba`);
        fs.writeFileSync(file, Buffer.from(frames[k], "base64"));
        done.push({ render: i, tick, file });
      });
      console.log(`skia-bake-frames: ${job.renders[i].nodeId} — ${frames.filter(Boolean).length}/${frames.length} frames at ${job.size.width}×${job.size.height}`);
    }
    fs.writeFileSync(path.join(OUT, "done.json"), JSON.stringify(done) + "\n");
    code = 0;
  } catch (e) {
    console.error(`skia-bake-frames: ${e && e.message ? e.message : e}`);
    if (e && e.pageStack) console.error(e.pageStack);
    code = 2;
  } finally {
    if (server) server.close();
    fs.rmSync(BUNDLE_DIR, { recursive: true, force: true });
    app.exit(code);
  }
});
