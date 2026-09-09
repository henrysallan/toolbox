// Video seek-latency bench (specdocs/090426_video-scrub-audit.md §5).
//
// Measures what a timeline scrub actually pays per landed frame, per source
// keyframe interval: `<video>` currentTime write → `seeked` for +1-frame,
// −1-frame and random seeks; what currentTime / readyState report mid-seek;
// how many seeks land when retargeted every 16 ms (the no-coalescing case);
// and mediabunny's WebCodecs VideoSampleSink for the same targets (pipelined
// forward, independent backward, independent random).
//
// Run (must be the Electron binary, NOT node — see TESTING.md / the
// check:shaders script for the env gotcha):
//   env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron scripts/bench-video-seek.cjs
//
// Clips are synthesized with ffmpeg-static into a temp dir on first run
// (7 × 10 s H.264: 1080p + 4K at GOP 250 / 30 / 1, plus a 1080p all-intra
// proxy derived from the 4K GOP-250 file) and reused afterwards. Synthetic
// testsrc2 frames decode faster than camera footage — read the ratios, not
// the absolutes. Needs a visible window: a backgrounded one records nothing.
// Prints one JSON line per (clip, kind); stats are ms.
/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FPS = 30;
const DIR = path.join(os.tmpdir(), "toolbox-video-seek-bench");
const FFMPEG = require("ffmpeg-static");

const CLIPS = [
  { name: "h264_1080p_g250", size: "1920x1080", g: 250 },
  { name: "h264_1080p_g30", size: "1920x1080", g: 30 },
  { name: "h264_1080p_g1", size: "1920x1080", g: 1 },
  { name: "h264_4k_g250", size: "3840x2160", g: 250 },
  { name: "h264_4k_g30", size: "3840x2160", g: 30 },
  { name: "h264_4k_g1", size: "3840x2160", g: 1 },
];

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))));
  });
}

async function ensureClips() {
  fs.mkdirSync(DIR, { recursive: true });
  const out = [];
  for (const c of CLIPS) {
    const file = path.join(DIR, `${c.name}.mp4`);
    if (!fs.existsSync(file)) {
      await ffmpeg([
        "-f", "lavfi", "-i", `testsrc2=size=${c.size}:rate=${FPS}`, "-t", "10",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
        "-g", String(c.g), "-keyint_min", String(c.g), "-sc_threshold", "0",
        "-movflags", "+faststart", file,
      ]);
    }
    out.push(file);
  }
  // The scrub-proxy candidate: 1080p all-intra transcoded FROM the 4K long-GOP source.
  const proxy = path.join(DIR, "proxy_1080p_intra_from4k.mp4");
  if (!fs.existsSync(proxy)) {
    await ffmpeg([
      "-i", path.join(DIR, "h264_4k_g250.mp4"), "-vf", "scale=1920:-2",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-g", "1", "-an", proxy,
    ]);
  }
  out.push(proxy);
  return out;
}

const PAGE = String.raw`<!doctype html><meta charset="utf-8"><body><script type="module">
const q = new URLSearchParams(location.search);
const clips = JSON.parse(q.get("clips"));
const FPS = Number(q.get("fps"));
const MB = await import("file://" + q.get("mb"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = (a) => { const s = [...a].sort((x, y) => x - y); const p = (f) => s[Math.min(s.length - 1, Math.floor(f * s.length))]; return { n: s.length, med: +p(0.5).toFixed(1), p90: +p(0.9).toFixed(1), max: +s[s.length - 1].toFixed(1) }; };
const log = (o) => console.log(JSON.stringify(o));
async function loadVideo(url) {
  const v = document.createElement("video");
  v.src = url; v.muted = true; v.playsInline = true; v.preload = "auto"; v.crossOrigin = "anonymous";
  await new Promise((res, rej) => { v.addEventListener("loadedmetadata", res, { once: true }); v.addEventListener("error", () => rej(new Error("load error " + (v.error && v.error.code))), { once: true }); });
  document.body.appendChild(v);
  return v;
}
async function seekOnce(v, t) {
  const t0 = performance.now();
  const done = new Promise((r) => v.addEventListener("seeked", r, { once: true }));
  v.currentTime = t;
  const ctBefore = v.currentTime.toFixed(4);
  const rsDuring = v.readyState;
  await done;
  return { ms: performance.now() - t0, ctBefore, ctAfter: v.currentTime.toFixed(4), rsDuring };
}
async function benchVideo(name, url) {
  const v = await loadVideo(url);
  await seekOnce(v, 0.5); await sleep(50);
  const fwd = []; let ctDiff = 0, rsLow = 0;
  for (let k = 0; k < 60; k++) { const r = await seekOnce(v, 2 + k / FPS); fwd.push(r.ms); if (r.ctBefore !== r.ctAfter) ctDiff++; if (r.rsDuring < 2) rsLow++; }
  const back = [];
  for (let k = 0; k < 60; k++) back.push((await seekOnce(v, 6 - k / FPS)).ms);
  const rnd = [];
  for (let k = 0; k < 40; k++) { const r = await seekOnce(v, 0.2 + Math.random() * 9.5); rnd.push(r.ms); if (r.ctBefore !== r.ctAfter) ctDiff++; }
  let landed = 0; const onS = () => landed++; v.addEventListener("seeked", onS);
  const tStart = performance.now(); let writes = 0;
  while (performance.now() - tStart < 1000) { v.currentTime = 1 + (writes++ % 200) / FPS; await sleep(16); }
  await sleep(300); v.removeEventListener("seeked", onS);
  log({ clip: name, kind: "video-element", fwd1: stats(fwd), back1: stats(back), random: stats(rnd), currentTimeDiffersAfterLanding: ctDiff + "/100", readyStateBelow2DuringSeek: rsLow + "/60", retargetEvery16ms: { writes, landed } });
  v.remove();
}
async function benchMediabunny(name, blob) {
  try {
    const input = new MB.Input({ source: new MB.BlobSource(blob), formats: MB.ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!(await track.canDecode())) { log({ clip: name, kind: "mediabunny", canDecode: false }); return; }
    const sink = new MB.VideoSampleSink(track);
    const ts = []; for (let k = 0; k < 60; k++) ts.push(2 + k / FPS);
    const seq = []; let t0 = performance.now();
    for await (const s of sink.samplesAtTimestamps(ts)) { seq.push(performance.now() - t0); t0 = performance.now(); if (s) s.close(); }
    const rnd = [];
    for (let k = 0; k < 40; k++) { const a = performance.now(); const s = await sink.getSample(0.2 + Math.random() * 9.5); rnd.push(performance.now() - a); if (s) s.close(); }
    const back = [];
    for (let k = 0; k < 60; k++) { const a = performance.now(); const s = await sink.getSample(6 - k / FPS); back.push(performance.now() - a); if (s) s.close(); }
    log({ clip: name, kind: "mediabunny", fwd1_pipelined: stats(seq), back1_independent: stats(back), random_independent: stats(rnd) });
  } catch (e) { log({ clip: name, kind: "mediabunny", error: String(e) }); }
}
for (const p of clips) {
  const name = p.split("/").pop();
  const blob = await (await fetch("file://" + p)).blob();
  const url = URL.createObjectURL(blob);
  await benchVideo(name, url);
  await benchMediabunny(name, blob);
  URL.revokeObjectURL(url);
}
console.log("ALLDONE");
</script></body>`;

app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.whenReady().then(async () => {
  let clips;
  try {
    clips = await ensureClips();
  } catch (e) {
    console.error(String(e));
    app.exit(1);
    return;
  }
  const pagePath = path.join(DIR, "page.html");
  fs.writeFileSync(pagePath, PAGE);
  const win = new BrowserWindow({
    width: 480, height: 320, show: true, x: 0, y: 0,
    webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: false, backgroundThrottling: false },
  });
  win.webContents.on("console-message", (_e, _l, msg) => {
    if (msg === "ALLDONE") app.exit(0);
    else if (msg.startsWith("{")) process.stdout.write(msg + "\n");
  });
  ipcMain.on("done", () => app.exit(0));
  await win.loadFile(pagePath, {
    query: {
      clips: JSON.stringify(clips),
      fps: String(FPS),
      mb: path.resolve(__dirname, "../node_modules/mediabunny/dist/bundles/mediabunny.mjs"),
    },
  });
  setTimeout(() => { console.error("bench timed out"); app.exit(2); }, 300000);
});
