// Native ffmpeg streaming encode (main process). The renderer drives the frame
// loop and pushes RGBA8 frames; we pipe them to a bundled ffmpeg-static process
// reading rawvideo from stdin, and write the encoded file straight to a path
// the USER picked via a native Save dialog. No wasm heap, real threads, no
// whole-export buffering. See specdocs/062626_electron-native-export.md.
"use strict";

const { ipcMain, dialog, BrowserWindow } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
// In a packaged app the binary is unpacked from the asar (see asarUnpack in
// package.json build config), so the path ffmpeg-static reports inside
// app.asar must be redirected to app.asar.unpacked.
let ffmpegPath = require("ffmpeg-static");
if (ffmpegPath && ffmpegPath.includes("app.asar")) {
  ffmpegPath = ffmpegPath.replace("app.asar", "app.asar.unpacked");
}
// Shared, validated arg builder — identical codec/ProRes/alpha behavior as the
// web ffmpeg.wasm path.
const { buildAudioArgs, buildEncoderArgs } = require("../src/lib/export-ffmpeg-args.js");

const ffmpegAvailable = !!ffmpegPath && fs.existsSync(ffmpegPath);

// Only these reach the spawned command line — the renderer can't smuggle
// arbitrary ffmpeg flags. Output path comes from a main-controlled dialog.
const ALLOWED_CODECS = new Set(["h264", "h264-lossless", "h265", "prores", "qtrle", "vp9", "av1"]);
const ALLOWED_CONTAINERS = new Set(["mp4", "mov", "webm", "mkv"]);

const EXT_FILTER = {
  mp4: { name: "MP4 Video", extensions: ["mp4"] },
  mov: { name: "QuickTime", extensions: ["mov"] },
  webm: { name: "WebM", extensions: ["webm"] },
  mkv: { name: "Matroska", extensions: ["mkv"] },
};

const sessions = new Map();
let counter = 0;

function progress(win, sessionId, label, fraction) {
  if (win && !win.isDestroyed()) {
    win.webContents.send("toolbox:encodeProgress", { sessionId, label, fraction });
  }
}

// Run ffmpeg to completion; resolve with the stderr tail, reject on failure.
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (c) => { stderr = (stderr + c).slice(-8000); });
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve(stderr) : reject(new Error(`ffmpeg exited ${code}\n${stderr}`))
    );
  });
}

// Probe the input header. ffmpeg with no output exits non-zero but prints
// stream info (incl. pixel format) to stderr — that's all we need.
function probeInput(inPath) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ["-hide_banner", "-i", inPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (c) => { stderr += c; });
    proc.on("error", () => resolve(""));
    proc.on("close", () => resolve(stderr));
  });
}

function register() {
  // Synchronous capability probe used by the preload to set canEncodeNative.
  ipcMain.on("toolbox:capabilities", (event) => {
    event.returnValue = { canEncodeNative: ffmpegAvailable };
  });

  ipcMain.handle("toolbox:encodeVideoBegin", async (event, spec) => {
    if (!ffmpegAvailable) throw new Error("native ffmpeg unavailable");
    if (!ALLOWED_CODECS.has(spec.codec)) throw new Error(`bad codec: ${spec.codec}`);
    if (!ALLOWED_CONTAINERS.has(spec.container)) throw new Error(`bad container: ${spec.container}`);
    const w = Math.round(Number(spec.width));
    const h = Math.round(Number(spec.height));
    const fps = Number(spec.fps);
    if (!(w > 0 && h > 0 && fps > 0)) throw new Error("bad dimensions/fps");
    const crf = Number.isFinite(spec.crf) ? spec.crf : 18;
    const proresProfile = Number.isFinite(spec.proresProfile) ? spec.proresProfile : 3;

    const win = BrowserWindow.fromWebContents(event.sender) || undefined;
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: spec.suggestedName,
      filters: [EXT_FILTER[spec.container]],
    });
    if (canceled || !filePath) return null;

    // Audio (optional): write the WAV to a temp file and mux as a 2nd input.
    let audioPath = null;
    if (spec.audioWav && spec.audioWav.byteLength > 0) {
      audioPath = path.join(os.tmpdir(), `toolbox-audio-${++counter}.wav`);
      await fsp.writeFile(audioPath, Buffer.from(spec.audioWav));
    }
    const hasAudio = !!audioPath;

    const args = [
      "-y",
      // rawvideo input on stdin — straight-alpha RGBA8, top-to-bottom.
      "-f", "rawvideo",
      "-pix_fmt", "rgba",
      "-s", `${w}x${h}`,
      "-framerate", String(fps),
      "-i", "pipe:0",
      ...(hasAudio ? ["-i", audioPath] : []),
      ...buildEncoderArgs(spec.codec, crf, proresProfile, !!spec.alpha),
      ...(hasAudio ? buildAudioArgs(spec.container) : []),
      ...(hasAudio ? ["-shortest"] : []),
      "-r", String(fps),
      filePath,
    ];

    const proc = spawn(ffmpegPath, args, { stdio: ["pipe", "ignore", "pipe"] });
    const sessionId = `enc-${++counter}`;
    const totalFrames = Math.max(0, Number(spec.durationFrames) || 0);
    const session = { proc, audioPath, filePath, win, totalFrames };
    sessions.set(sessionId, session);

    // Don't crash on a broken pipe if ffmpeg dies early; the exit promise
    // surfaces the real error to encodeVideoEnd.
    proc.stdin.on("error", () => {});

    let stderrTail = "";
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-4000);
      const m = /frame=\s*(\d+)/.exec(chunk);
      if (m) {
        const f = Number(m[1]);
        const frac = totalFrames ? Math.min(0.99, f / totalFrames) : 0;
        progress(win, sessionId, `Encoding ${f}${totalFrames ? `/${totalFrames}` : ""}`, frac);
      }
    });

    session.exit = new Promise((resolve, reject) => {
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}\n${stderrTail}`));
      });
    });

    return { sessionId, path: filePath };
  });

  ipcMain.handle("toolbox:encodeVideoFrame", async (_event, sessionId, rgba) => {
    const s = sessions.get(sessionId);
    if (!s) throw new Error("encodeVideoFrame: unknown session");
    const ok = s.proc.stdin.write(Buffer.from(rgba));
    // Backpressure: resolve only once the OS pipe has drained the chunk.
    if (!ok) await new Promise((resolve) => s.proc.stdin.once("drain", resolve));
  });

  ipcMain.handle("toolbox:encodeVideoEnd", async (_event, sessionId) => {
    const s = sessions.get(sessionId);
    if (!s) throw new Error("encodeVideoEnd: unknown session");
    s.proc.stdin.end();
    try {
      await s.exit;
    } finally {
      if (s.audioPath) fsp.unlink(s.audioPath).catch(() => {});
      sessions.delete(sessionId);
    }
    progress(s.win, sessionId, "Done", 1);
    return { path: s.filePath };
  });

  ipcMain.handle("toolbox:encodeVideoAbort", async (_event, sessionId) => {
    const s = sessions.get(sessionId);
    if (!s) return;
    try { s.proc.stdin.destroy(); } catch { /* ignore */ }
    try { s.proc.kill("SIGKILL"); } catch { /* ignore */ }
    if (s.audioPath) fsp.unlink(s.audioPath).catch(() => {});
    if (s.filePath) fsp.unlink(s.filePath).catch(() => {}); // drop partial output
    sessions.delete(sessionId);
  });

  // Transcode a video Chromium can't decode into a playable form. 10-bit
  // sources go to VP9 profile 2 (preserves depth — matters for gradients);
  // 8-bit sources take the fast H.264 path.
  ipcMain.handle("toolbox:transcodeForPlayback", async (_event, { bytes, name }) => {
    if (!ffmpegAvailable) throw new Error("native ffmpeg unavailable");
    const id = ++counter;
    const inExt = (name && path.extname(String(name))) || ".bin";
    const inPath = path.join(os.tmpdir(), `toolbox-xc-in-${id}${inExt}`);
    await fsp.writeFile(inPath, Buffer.from(bytes));
    let outPath = null;
    try {
      const info = await probeInput(inPath);
      const tenBit = /(10le|12le|10be|12be|p010|p016)/i.test(info);
      let outArgs;
      let outType;
      if (tenBit) {
        outPath = path.join(os.tmpdir(), `toolbox-xc-out-${id}.webm`);
        outArgs = [
          "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p10le",
          "-b:v", "0", "-crf", "20", "-row-mt", "1",
          "-deadline", "good", "-cpu-used", "5",
          "-c:a", "libopus",
        ];
        outType = "video/webm";
      } else {
        outPath = path.join(os.tmpdir(), `toolbox-xc-out-${id}.mp4`);
        outArgs = [
          "-c:v", "libx264", "-pix_fmt", "yuv420p",
          "-preset", "veryfast", "-crf", "18",
          "-c:a", "aac", "-movflags", "+faststart",
        ];
        outType = "video/mp4";
      }
      await runFfmpeg(["-y", "-i", inPath, ...outArgs, outPath]);
      const buf = await fsp.readFile(outPath);
      const out = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      return { bytes: out, type: outType };
    } finally {
      fsp.unlink(inPath).catch(() => {});
      if (outPath) fsp.unlink(outPath).catch(() => {});
    }
  });
}

module.exports = { register, ffmpegAvailable };
