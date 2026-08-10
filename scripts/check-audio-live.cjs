// check-audio-live: end-to-end LIVE audio-path check for the chain engine
// (specdocs/080826_audio-nodes.md). Bundles scripts/audio/harness.ts and
// runs it in a hidden Electron renderer with a real AudioContext — real
// Tone graph, real samples read back from an analyser tap, plus a
// double offline render compared sample-exact for determinism.
//
//   npm run check:audio-live
//
// Electron because the Node test runner has no WebAudio; same pattern as
// bench-nodes.cjs / check-shaders.cjs. Must stay .cjs — Electron MAIN
// process entry (see TESTING.md §2 on the .mjs hang trap).
/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow } = require("electron");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..");
const BUNDLE = path.join(REPO, "scripts", ".audio-harness.bundle.js");

console.log("bundling audio harness…");
execFileSync(
  "npx",
  [
    "esbuild",
    path.join(REPO, "scripts/audio/harness.ts"),
    "--bundle",
    "--format=iife",
    "--global-name=__audioCheck",
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
    width: 320,
    height: 200,
    webPreferences: { nodeIntegration: false },
  });
  // file:// — a SECURE CONTEXT in Chromium, unlike a data: URL. AudioWorklet
  // (BitCrusher) refuses to exist in insecure contexts, and the app always
  // runs secure (localhost / https / Electron), so the harness must too.
  const PAGE = path.join(REPO, "scripts", ".audio-harness.html");
  fs.writeFileSync(PAGE, "<body></body>");
  await win.loadFile(PAGE);
  win.webContents.on("console-message", (_e, _lvl, msg) => {
    console.log("[renderer]", msg);
  });

  await win.webContents.executeJavaScript(harnessJs);
  const result = await win.webContents.executeJavaScript(
    "window.__audioCheck.run()",
    true
  );

  fs.rmSync(BUNDLE, { force: true });
  fs.rmSync(PAGE, { force: true });

  const num = (v) => (typeof v === "number" ? v.toFixed(4) : String(v));
  console.log(`live RMS at filter tap : ${num(result.liveRms)} (want > 0.02)`);
  console.log(`offline render RMS     : ${num(result.offlineRms)} (want > 0.02)`);
  console.log(`offline deterministic  : ${result.deterministic}`);
  console.log(`master gain            : ${num(result.masterGain)} (want > 0.9)`);
  console.log(`synth chain live RMS   : ${num(result.synthRms)} (want > 0.02)`);
  console.log(`synth offline RMS      : ${num(result.synthOfflineRms)} (want > 0.005, incl. bitcrusher worklet)`);
  console.log(`synth offline determ.  : ${result.synthDeterministic}`);
  console.log(`analysis tap live RMS  : ${num(result.tapLiveRms)} (want > 0.02)`);
  console.log(`analysis tap offl. RMS : ${num(result.tapOfflineRms)} (want > 0.005)`);
  console.log(`LFO wobble peak RMS    : ${num(result.wobMax)} (want > 0.05)`);
  console.log(`LFO wobble RMS spread  : ${num(result.wobbleSpread)} (want > 0.03 — proof the mod moves)`);
  console.log(`element-leaf offl. RMS : ${num(result.leafOfflineRms)} (want > 0.1 — url decode path)`);
  console.log(`preview-while-paused   : ${num(result.previewRms)} (want > 0.02 — audition fires with transport stopped)`);
  console.log(`automation opening 5%  : ${num(result.autoFirstQ)}`);
  console.log(`automation last-quarter: ${num(result.autoLastQ)} (want > 0.1 and > 2.5× the opening — the sweep opened)`);
  if (!result.ok) {
    console.log("engine report:", JSON.stringify(result.report ?? result, null, 2));
    console.log("\ncheck-audio-live: FAILED");
    app.exit(1);
    return;
  }
  console.log("\ncheck-audio-live: all passed");
  app.exit(0);
});
