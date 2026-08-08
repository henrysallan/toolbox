// bench-nodes: measures every node type's CPU and GPU cost in isolation and
// emits a ranked report. Spec: specdocs/080726_perf-profiler.md (M4).
//
//   npm run bench:nodes            # hardware GL (real numbers)
//   npm run bench:nodes -- --reps 15
//
// Bundles scripts/bench/harness.ts with esbuild, runs it in a hidden Electron
// renderer with a real WebGL2 context, and writes:
//   bench/node-bench.json  — full data, diffable across commits
//   bench/node-bench.md    — the ranked worklist
//
// Hardware GL on purpose. The shader checks use swiftshader because they only
// need correctness; a PERFORMANCE ranking from a software rasterizer would be
// a ranking of swiftshader, not of the GPU anyone actually runs.
//
// CommonJS require, not ESM import: Electron MAIN-process entry, loaded by the
// Electron binary rather than Node's ESM loader.
/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow } = require("electron");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..");
const OUT_DIR = path.join(REPO, "bench");
const BUNDLE = path.join(OUT_DIR, ".harness.bundle.js");

const repsArg = process.argv.indexOf("--reps");
const REPS = repsArg > -1 ? Number(process.argv[repsArg + 1]) || 7 : 7;

fs.mkdirSync(OUT_DIR, { recursive: true });

// --- bundle the harness -----------------------------------------------------
// `--alias:@=./src` mirrors the tsconfig path mapping; without it every engine
// import fails to resolve.
console.log("bundling harness…");
execFileSync(
  "npx",
  [
    "esbuild",
    path.join(REPO, "scripts/bench/harness.ts"),
    "--bundle",
    "--format=iife",
    "--global-name=__bench",
    "--platform=browser",
    "--target=es2022",
    `--alias:@=${path.join(REPO, "src")}`,
    "--loader:.wasm=file",
    `--outfile=${BUNDLE}`,
    "--log-level=warning",
  ],
  { cwd: REPO, stdio: "inherit" }
);

const harnessJs = fs.readFileSync(BUNDLE, "utf8");

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: { nodeIntegration: false, offscreen: false },
  });
  await win.loadURL("data:text/html,<body></body>");

  win.webContents.on("console-message", (_e, _lvl, msg) => {
    if (msg.startsWith("[bench]")) console.log(msg);
  });

  console.log(`running ${REPS} reps per node…`);
  await win.webContents.executeJavaScript(harnessJs);
  const result = await win.webContents.executeJavaScript(
    `window.__bench.runBench({ reps: ${REPS} })`
  );

  fs.writeFileSync(
    path.join(OUT_DIR, "node-bench.json"),
    JSON.stringify(result, null, 2)
  );
  fs.writeFileSync(path.join(OUT_DIR, "node-bench.md"), toMarkdown(result));
  fs.rmSync(BUNDLE, { force: true });

  const ok = result.rows.filter((r) => r.status === "ok");
  const errored = result.rows.filter((r) => r.status === "error");
  console.log(
    `\n${ok.length} measured · ${result.rows.length - ok.length - errored.length} skipped · ${errored.length} errored`
  );
  console.log(`wrote bench/node-bench.json and bench/node-bench.md`);
  app.exit(0);
});

function toMarkdown(result) {
  const { rows, canvas, gpuTimingAvailable } = result;
  const ok = rows.filter((r) => r.status === "ok");
  const cost = (r) => (r.gpuMs ?? 0) + (r.cpuMs ?? 0);
  const ranked = [...ok].sort((a, b) => cost(b) - cost(a));
  const unmeasured = ok.filter((r) => r.gpuMs === undefined && (r.allocs ?? 0) > 0);
  const num = (v) => (v === undefined ? "n/a" : v.toFixed(3));

  const L = [];
  L.push(`# Node cost bench`);
  L.push("");
  L.push(
    `Canvas ${canvas.width}×${canvas.height} · median of ${ok[0]?.reps ?? "?"} reps · ` +
      `GPU timing ${gpuTimingAvailable ? "available" : "UNAVAILABLE (CPU only)"}`
  );
  L.push("");
  L.push(
    `Each node is called in isolation with synthesized inputs — no caching, no ` +
      `graph, identical inputs for every node. **Total = GPU + CPU**, because a ` +
      `fill-bound node costs almost nothing on the CPU and ranking by CPU alone ` +
      `puts the wrong nodes on top.`
  );
  L.push("");
  L.push(
    `Numbers are comparable to each other, not to a frame budget: geometry ` +
      `nodes run on a synthetic ${8}×${24}-anchor spline / 2000 points, so a node ` +
      `whose cost scales with input size will move with your real data.`
  );
  L.push("");

  if (unmeasured.length) {
    L.push(
      `> **${unmeasured.length} node(s) allocate textures but returned no GPU timing** ` +
        `(shown as \`n/a\`, never as 0 — a zero would read as "free"). Their ` +
        `\`total\` is CPU-only and therefore an UNDER-estimate: ` +
        unmeasured.map((r) => `\`${r.type}\``).join(", ")
    );
    L.push("");
  }

  L.push(`## Worklist — 30 most expensive`);
  L.push("");
  L.push(`| # | node | category | total ms | gpu | cpu | tex |`);
  L.push(`|---|---|---|---|---|---|---|`);
  ranked.slice(0, 30).forEach((r, i) => {
    L.push(
      `| ${i + 1} | \`${r.type}\` | ${r.category}${r.subcategory ? "/" + r.subcategory : ""} | **${cost(r).toFixed(3)}** | ${num(r.gpuMs)} | ${num(r.cpuMs)} | ${r.allocs ?? 0} |`
    );
  });
  L.push("");

  L.push(`## All measured nodes`);
  L.push("");
  L.push(`| node | category | total ms | gpu | cpu | tex |`);
  L.push(`|---|---|---|---|---|---|`);
  for (const r of ranked) {
    L.push(
      `| \`${r.type}\` | ${r.category}${r.subcategory ? "/" + r.subcategory : ""} | ${cost(r).toFixed(3)} | ${num(r.gpuMs)} | ${num(r.cpuMs)} | ${r.allocs ?? 0} |`
    );
  }
  L.push("");

  const skipped = rows.filter((r) => r.status === "skipped");
  const errored = rows.filter((r) => r.status === "error");
  if (errored.length) {
    L.push(`## Errored (${errored.length}) — not measured`);
    L.push("");
    L.push(
      `These threw on synthetic inputs. Usually a socket type the harness ` +
        `can't synthesize, sometimes a real latent bug — worth a glance.`
    );
    L.push("");
    for (const r of errored) L.push(`- \`${r.type}\` — ${r.reason}`);
    L.push("");
  }
  if (skipped.length) {
    L.push(`## Skipped (${skipped.length})`);
    L.push("");
    for (const r of skipped) L.push(`- \`${r.type}\` — ${r.reason}`);
    L.push("");
  }
  return L.join("\n");
}
