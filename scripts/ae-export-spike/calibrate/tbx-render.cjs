// tbx-render: render toolbox nodes on exact test images, headless, with the
// real engine (renderer page: calibrate/tbx-page.ts). The toolbox half of the
// effect calibration (spec 091926_after-effects-handoff.md §14).
//
//   env -u ELECTRON_RUN_AS_NODE npx electron scripts/ae-export-spike/calibrate/tbx-render.cjs --job job.json --out dir
//
// job.json: TbxJob plus `inputs: [{ slot, frame?, file }]` — each file is raw
// float32 straight RGBA, row 0 = top, at the job's size. Writes
// <out>/<render id>-f<frame>.f32 (same layout) and <out>/done.json.
// Exit 0 on success, 2 on a setup or render error.
//
// CommonJS: an Electron main-process entry. Must run with ELECTRON_RUN_AS_NODE
// unset.
/* eslint-disable @typescript-eslint/no-require-imports */
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const H = require("../../skia/electron-harness.cjs");

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("ignore-gpu-blocklist");

const JOB = H.arg("job");
const OUT = H.arg("out");
if (!JOB || !OUT) {
  console.error("usage: electron tbx-render.cjs --job job.json --out dir");
  process.exit(2);
}
const BUNDLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tbx-calibrate-"));

app.whenReady().then(async () => {
  let code = 2;
  let server = null;
  try {
    const job = JSON.parse(fs.readFileSync(JOB, "utf8"));
    H.bundlePage({ entry: path.join(__dirname, "tbx-page.ts"), outfile: path.join(BUNDLE_DIR, "bundle.js"), globalName: "__cal" });
    const inputsDir = path.dirname(path.resolve(JOB));
    server = await H.startServer({
      routes: {
        "/__cal/page.html": {
          type: "text/html",
          body: `<!doctype html><meta charset="utf-8"><body><script src="/__cal/bundle.js"></script></body>`,
        },
      },
      mounts: { "/__cal/": BUNDLE_DIR, "/inputs/": inputsDir, "/fonts/": path.join(H.REPO, "public", "fonts") },
    });
    const win = H.makeWindow(320, 320);
    await win.loadURL(`${server.base}/__cal/page.html`);
    await H.waitFor(win, "window.__cal", 30000);
    await H.call(win, "window.__cal.init()", 60000, "init");
    for (const inp of job.inputs ?? []) {
      const rel = path.relative(inputsDir, path.resolve(inputsDir, inp.file));
      await H.call(win, `window.__cal.loadInput(${JSON.stringify(inp.slot)}, ${inp.frame ?? -1}, ${JSON.stringify("/inputs/" + rel)})`, 60000, `input ${inp.slot}`);
    }
    fs.mkdirSync(OUT, { recursive: true });
    const done = [];
    for (let i = 0; i < job.renders.length; i++) {
      const frames = await H.call(win, `window.__cal.render(${JSON.stringify({ size: job.size, fps: job.fps, renders: job.renders })}, ${i})`, 600000, `render ${job.renders[i].id}`);
      for (const f of frames) {
        if (!f.b64) {
          done.push({ id: job.renders[i].id, frame: f.frame, error: f.error });
          console.log(`tbx-render: ${job.renders[i].id} f${f.frame}: ${f.error}`);
          continue;
        }
        const file = path.join(OUT, `${job.renders[i].id}-f${f.frame}.f32`);
        fs.writeFileSync(file, Buffer.from(f.b64, "base64"));
        done.push({ id: job.renders[i].id, frame: f.frame, file });
      }
    }
    fs.writeFileSync(path.join(OUT, "done.json"), JSON.stringify(done) + "\n");
    code = 0;
  } catch (e) {
    console.error(`tbx-render: ${e && e.message ? e.message : e}`);
    if (e && e.pageStack) console.error(e.pageStack);
    code = 2;
  } finally {
    if (server) server.close();
    fs.rmSync(BUNDLE_DIR, { recursive: true, force: true });
    app.exit(code);
  }
});
