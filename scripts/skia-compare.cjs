// compare:skia — render two nodes of fixture graphs through toolbox's REAL
// evaluator, headless, and score them with compare_renders' metrics. The
// tool a port is proven with (a native GL node vs its skia-* / SkSL port)
// without a live editor. Spec: specdocs/101326_skia-target.md §7 (L5).
//
//   npm run compare:skia -- --a aurora:ramp --b aurora:aurora
//   npm run compare:skia -- --a noise:native --b noise:skia --frames 0,60 --size 1920x1080
//   npm run compare:skia -- --a text:glyphs:aux:preview --b text:port --expect close
//
// Sides: `<fixture>:<nodeId>[:<handle>]`. <fixture> names the module
// scripts/fixtures/skia/<fixture>-graph.ts, which exports
// `fixture: SkiaGraphFixture` (scripts/skia/fixture.ts: timeline, default
// frames/size, build()). <handle> is `primary` (default) or `aux:<name>`
// (a bare `<name>` means `aux:<name>`). Node ids must not contain ":".
//
// Options:
//   --frames 0,45,120   frame numbers in the fixture's timeline (default:
//                       fixture A's `frames`, else 0)
//   --size 512 | WxH    canvas size (default: fixture A's `size`, else 512)
//   --analysis N        read back at N px on the long edge, as
//                       compare_renders does (256); default: full size
//   --threshold T       per-channel "over" threshold (default 0.02)
//   --expect B          exit 0 only if every frame is within band B:
//                       match (default) | close | off (never fails on pixels)
//   --out DIR           output dir (default scripts/.skia-compare-out/<a>-vs-<b>)
//   --timeout MS        per-frame render timeout (default 60000)
//   --verbose           echo every page console line
//
// Writes f<N>-a.png, f<N>-b.png, f<N>-heat.png (|A−B| ×4, blue = alpha) and
// report.json. Exit codes: 0 within the band; 1 a frame is beyond it;
// 2 usage, fixture, bundle, CanvasKit, render or timeout errors.
//
// Each frame renders from a fresh evaluation cache, so stateful nodes
// (simulations, feedback) see no history — compare them at frame 0 or
// build the fixture so the compared frame doesn't depend on prior frames.
//
// CommonJS: an Electron main-process entry. Must run with ELECTRON_RUN_AS_NODE
// unset (the npm script handles it).
/* eslint-disable @typescript-eslint/no-require-imports */
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const H = require("./skia/electron-harness.cjs");
const { encodePng } = require("./skia/png.cjs");

const FIXTURES = path.join(H.REPO, "scripts", "fixtures", "skia");
const VERDICT_RANK = { match: 0, close: 1, off: 2 };

function usage(msg) {
  if (msg) console.error(`compare:skia: ${msg}`);
  console.error(
    "usage: npm run compare:skia -- --a <fixture>:<node>[:<handle>] --b <fixture>:<node>[:<handle>]\n" +
      "         [--frames 0,45] [--size 512|WxH] [--analysis 256] [--threshold 0.02]\n" +
      "         [--expect match|close|off] [--out dir] [--timeout ms] [--verbose]\n" +
      "fixtures: " +
      (fs.existsSync(FIXTURES)
        ? fs
            .readdirSync(FIXTURES)
            .filter((f) => f.endsWith("-graph.ts"))
            .map((f) => f.slice(0, -"-graph.ts".length))
            .join(", ")
        : "none")
  );
  process.exit(2);
}

function parseSide(name) {
  const raw = H.arg(name);
  if (!raw) usage(`--${name} is required`);
  const parts = raw.split(":");
  if (parts.length < 2 || !parts[0] || !parts[1]) usage(`--${name} "${raw}" is not <fixture>:<node>[:<handle>]`);
  const [fixture, node, ...rest] = parts;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(fixture)) usage(`--${name}: bad fixture name "${fixture}"`);
  let handle = rest.join(":");
  if (!handle || handle === "primary" || handle === "out") handle = "primary";
  else if (!handle.startsWith("aux:")) handle = `aux:${handle}`;
  if (handle === "aux:") usage(`--${name}: empty aux handle`);
  const file = path.join(FIXTURES, `${fixture}-graph.ts`);
  if (!fs.existsSync(file)) usage(`--${name}: no fixture module scripts/fixtures/skia/${fixture}-graph.ts`);
  return { fixture, node, handle, file, label: raw };
}

function parseSize(raw) {
  const m = /^(\d+)(?:x(\d+))?$/.exec(String(raw));
  if (!m) usage(`--size "${raw}" is not N or WxH`);
  const w = Number(m[1]);
  const h = Number(m[2] ?? m[1]);
  if (w < 1 || h < 1 || w > 8192 || h > 8192) usage(`--size ${raw} is out of range (1–8192)`);
  return [w, h];
}

let A, B, framesArg, sizeArg, analysisArg, threshold, expect, outArg, timeoutMs, verbose;
try {
  if (H.flag("help") || H.flag("h")) usage();
  A = parseSide("a");
  B = parseSide("b");
  framesArg = H.arg("frames");
  sizeArg = H.arg("size");
  analysisArg = H.arg("analysis");
  threshold = H.arg("threshold") === undefined ? undefined : Number(H.arg("threshold"));
  expect = H.arg("expect", "match");
  outArg = H.arg("out");
  timeoutMs = Number(H.arg("timeout", "60000"));
  verbose = H.flag("verbose");
} catch (e) {
  usage(e.message);
}
if (!(expect in VERDICT_RANK)) usage(`--expect must be match, close or off (got "${expect}")`);
if (threshold !== undefined && !(threshold > 0 && threshold <= 1)) usage("--threshold must be in (0, 1]");
if (!(timeoutMs > 0)) usage("--timeout must be a positive number of ms");
const sizeParsed = sizeArg !== undefined ? parseSize(sizeArg) : null;
let frames = null;
if (framesArg !== undefined) {
  frames = framesArg.split(",").map((s) => Number(s.trim()));
  if (!frames.length || frames.some((f) => !Number.isInteger(f) || f < 0)) usage(`--frames "${framesArg}" must be non-negative integers`);
}
const safe = (s) => s.replace(/[^A-Za-z0-9_.-]+/g, "_");
const OUT = path.resolve(outArg ?? path.join(H.REPO, "scripts", ".skia-compare-out", `${safe(A.label)}-vs-${safe(B.label)}`));
// The bundled page lives outside the repo (and is removed afterwards) so
// lint and search never trip over a 10 MB generated file.
const BUNDLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "skia-compare-"));

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("ignore-gpu-blocklist");

// The generated entry: the page plus every fixture module named on the
// command line and every text asset next to them (ctx.text(file)).
function entrySource() {
  const imp = (p) => JSON.stringify(p.split(path.sep).join("/"));
  const lines = [`import * as page from ${imp(path.join(H.REPO, "scripts", "skia", "compare-page.ts"))};`];
  const mods = [];
  for (const [i, side] of [A, B].entries()) {
    if (mods.some((m) => m.fixture === side.fixture)) continue;
    lines.push(`import * as fx${i} from ${imp(side.file)};`);
    mods.push({ fixture: side.fixture, v: `fx${i}` });
  }
  const assets = fs.readdirSync(FIXTURES).filter((f) => /\.(sksl|glsl)$/.test(f));
  assets.forEach((f, i) => lines.push(`import t${i} from ${imp(path.join(FIXTURES, f))};`));
  lines.push(
    `page.install({ ${mods.map((m) => `${JSON.stringify(m.fixture)}: ${m.v}`).join(", ")} }, { ${assets
      .map((f, i) => `${JSON.stringify(f)}: t${i}`)
      .join(", ")} });`,
    `export * from ${imp(path.join(H.REPO, "scripts", "skia", "compare-page.ts"))};`
  );
  return lines.join("\n");
}

function writePng(file, b64, w, h) {
  fs.writeFileSync(file, encodePng(Buffer.from(b64, "base64"), w, h));
}

function fmt(m) {
  return (
    `${m.verdict.toUpperCase()} meanAbs ${m.meanAbs.toFixed(5)} p95 ${m.p95Abs.toFixed(4)} ` +
    `max ${m.maxSteps}/255 identical ${(m.identical * 100).toFixed(2)}% alpha ${m.alphaMeanAbs.toFixed(4)}`
  );
}

app.whenReady().then(async () => {
  let code = 2;
  let server = null;
  let win = null;
  try {
    const ck = H.canvasKitAssets();
    console.log(`bundling compare page (${A.fixture}${B.fixture !== A.fixture ? ` + ${B.fixture}` : ""})…`);
    try {
      H.bundlePage({
        entry: { contents: entrySource(), resolveDir: FIXTURES, sourcefile: "compare-entry.ts" },
        outfile: path.join(BUNDLE_DIR, "bundle.js"),
        globalName: "__compare",
      });
    } catch (e) {
      throw new Error(`the compare page failed to bundle: ${e.message}`);
    }
    server = await H.startServer({
      routes: {
        "/__compare/page.html": {
          type: "text/html",
          body: `<!doctype html><meta charset="utf-8"><body>
<script src="/canvaskit/${ck.version}/canvaskit.js"></script>
<script src="/__compare/bundle.js"></script></body>`,
        },
      },
      // /fonts/ is public/fonts, as the editor serves it: Skia text fixtures
      // load their bundled font asset (and the Text node its FontFace) by URL.
      mounts: { "/canvaskit/": path.dirname(ck.dir), "/__compare/": BUNDLE_DIR, "/fonts/": path.join(H.REPO, "public", "fonts") },
    });
    win = H.makeWindow(640, 640, { verbose });
    await win.loadURL(`${server.base}/__compare/page.html`);
    await H.waitFor(win, "window.__compare && window.CanvasKitInit", 30000);

    const call = (expr, label, ms = timeoutMs) => H.call(win, `window.__compare.${expr}`, ms, label);
    const infoA = await call(`info(${JSON.stringify(A.fixture)})`, `info(${A.fixture})`);
    const infoB = B.fixture === A.fixture ? infoA : await call(`info(${JSON.stringify(B.fixture)})`, `info(${B.fixture})`);
    if (infoA.timeline.fps !== infoB.timeline.fps) {
      console.warn(`warning: ${A.fixture} runs at ${infoA.timeline.fps} fps, ${B.fixture} at ${infoB.timeline.fps} — frame N is a different time on each side`);
    }
    const list = frames ?? infoA.frames ?? [0];
    const [w, h] = sizeParsed ?? infoA.size ?? [512, 512];
    let aw = w;
    let ah = h;
    if (analysisArg !== undefined) {
      const n = Number(analysisArg);
      if (!(n >= 8 && n <= 8192)) throw new Error(`--analysis ${analysisArg} must be 8–8192`);
      const k = n / Math.max(w, h);
      aw = Math.max(1, Math.round(w * k));
      ah = Math.max(1, Math.round(h * k));
    }

    await call(`init(${w}, ${h})`, "init (CanvasKit + nodes)", 60000);
    const prepA = await call(`prepare("A", ${JSON.stringify({ fixture: A.fixture, node: A.node, handle: A.handle })})`, "prepare A");
    const prepB = await call(`prepare("B", ${JSON.stringify({ fixture: B.fixture, node: B.node, handle: B.handle })})`, "prepare B");
    const wasm = server.served.find((s) => s.path.endsWith("/canvaskit.wasm"));
    const full = path.join(H.REPO, "node_modules", "canvaskit-wasm", "bin", "full", "canvaskit.wasm");
    const build = wasm && fs.existsSync(full) && fs.statSync(full).size === wasm.bytes ? "bin/full" : "bin";
    console.log(`A = ${A.label} [${prepA.nodeType}] · B = ${B.label} [${prepB.nodeType}]`);
    console.log(
      `canvas ${w}×${h} · analysis ${aw}×${ah} · frames ${list.join(",")} · GL ${prepA.renderer} · CanvasKit ${ck.version} (${build})`
    );
    if (infoA.description) console.log(`fixture ${A.fixture}: ${infoA.description}`);

    fs.mkdirSync(OUT, { recursive: true });
    const rows = [];
    for (const f of list) {
      const r = await call(`frame(${f}, ${aw}, ${ah}${threshold ? `, ${threshold}` : ""})`, `frame ${f}`);
      writePng(path.join(OUT, `f${f}-a.png`), r.a, aw, ah);
      writePng(path.join(OUT, `f${f}-b.png`), r.b, aw, ah);
      writePng(path.join(OUT, `f${f}-heat.png`), r.heat, aw, ah);
      rows.push({ frame: f, ...r.metrics });
      console.log(`f${f}: ${fmt(r.metrics)}`);
    }
    let motionA = null;
    if (list.length > 1) {
      const mid = list[Math.floor(list.length / 2)];
      motionA = await call(`motion("A", ${list[0]}, ${mid}, ${aw}, ${ah})`, "motion");
      console.log(`motion: A f${list[0]} vs f${mid} meanAbs ${motionA.toFixed(4)}${motionA < 1e-4 ? " (static — did the drivers move?)" : ""}`);
    }
    const worst = rows.reduce((v, r) => (VERDICT_RANK[r.verdict] > VERDICT_RANK[v] ? r.verdict : v), "match");
    const ok = VERDICT_RANK[worst] <= VERDICT_RANK[expect];
    const mean = (k) => rows.reduce((s, r) => s + r[k], 0) / rows.length;
    const report = {
      a: { fixture: A.fixture, node: A.node, handle: A.handle, type: prepA.nodeType },
      b: { fixture: B.fixture, node: B.node, handle: B.handle, type: prepB.nodeType },
      canvas: { width: w, height: h },
      analysis: { width: aw, height: ah },
      threshold: threshold ?? 0.02,
      canvasKit: { version: ck.version, build },
      renderer: prepA.renderer,
      frames: list,
      rows,
      summary: {
        verdict: worst,
        meanAbs: mean("meanAbs"),
        p95Abs: Math.max(...rows.map((r) => r.p95Abs)),
        maxSteps: Math.max(...rows.map((r) => r.maxSteps)),
        identical: Math.min(...rows.map((r) => r.identical)),
      },
      motionA,
      expect,
      ok,
    };
    fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(
      `overall: ${worst.toUpperCase()} (mean meanAbs ${report.summary.meanAbs.toFixed(5)}, worst p95 ${report.summary.p95Abs.toFixed(4)}, ` +
        `worst max ${report.summary.maxSteps}/255, min identical ${(report.summary.identical * 100).toFixed(2)}%) · expect ${expect} → ${ok ? "PASS" : "FAIL"}`
    );
    console.log(`wrote ${path.relative(process.cwd(), OUT) || "."}/ (f<N>-a.png, f<N>-b.png, f<N>-heat.png, report.json)`);
    code = ok ? 0 : 1;
  } catch (e) {
    console.error(`compare:skia: ${e && e.message ? e.message : e}`);
    if (verbose && e && e.pageStack) console.error(e.pageStack);
    code = 2;
  } finally {
    try {
      if (win && !win.isDestroyed()) await H.js(win, "window.__compare && window.__compare.destroy()", 5000).catch(() => {});
    } catch {
      // the page may already be gone
    }
    if (server) server.close();
    fs.rmSync(BUNDLE_DIR, { recursive: true, force: true });
    app.exit(code);
  }
});
