// bench-blend-gpu: honest A/B of Blend Intersections' CPU vs GPU field
// evaluation on HARDWARE GL. Spec: specdocs/080826_blend-intersections-gpu.md
// (acceptance gate 5).
//
//   npm run bench:blend-gpu            # hardware GL (real numbers)
//   npm run bench:blend-gpu -- --reps 15
//
// Exists because neither existing bench can see this comparison:
// bench:spline runs under tsx with no GL (CPU only), and bench:nodes
// cache-hits the node's geometry signature (reads ~0.1 ms). Pattern:
// scripts/bench-nodes.cjs — esbuild-bundle the TS harness, run it in a
// hidden Electron renderer. Hardware GL on purpose; never read timings off
// swiftshader.
/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow } = require("electron");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..");
const BUNDLE = path.join(REPO, "bench", ".blend-gpu.bundle.js");

const repsArg = process.argv.indexOf("--reps");
const REPS = repsArg > -1 ? Number(process.argv[repsArg + 1]) || 7 : 7;

fs.mkdirSync(path.dirname(BUNDLE), { recursive: true });

console.log("bundling harness…");
execFileSync(
  "npx",
  [
    "esbuild",
    path.join(REPO, "scripts/bench/blend-gpu-harness.ts"),
    "--bundle",
    "--format=iife",
    "--global-name=__blendBench",
    "--platform=browser",
    "--target=es2022",
    `--alias:@=${path.join(REPO, "src")}`,
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
    webPreferences: { nodeIntegration: false },
  });
  await win.loadURL("data:text/html,<body></body>");

  await win.webContents.executeJavaScript(harnessJs);
  const { gl, results } = await win.webContents.executeJavaScript(
    `window.__blendBench.run({ reps: ${REPS} })`
  );
  fs.rmSync(BUNDLE, { force: true });

  console.log(`\nGL: ${gl} · min of ${REPS} reps\n`);
  const num = (v) => (v === null ? "  n/a" : v.toFixed(2).padStart(6));
  console.log(
    "case                    grid      segs   setup  fieldCPU fieldGPU   nodeCPU  nodeGPU"
  );
  for (const r of results) {
    console.log(
      `${r.name.padEnd(22)} ${String(r.gw + "x" + r.gh).padStart(9)} ` +
        `${String(r.segCount).padStart(6)}  ${num(r.setupMs)} ` +
        `${num(r.cpuFieldMs)}   ${num(r.gpuFieldMs)}   ${num(r.nodeCpuMs)} ` +
        `${num(r.nodeGpuMs)}`
    );
  }
  console.log(
    "\nfield = evaluate the SDF grid (GPU column includes pack/upload/draw/readback);" +
      "\nnode  = full blendIntersections (field + marching + cleanup + fit).\n"
  );
  app.exit(0);
});
