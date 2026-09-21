// Export log files (main process). The renderer opens one log per export
// run through the preload bridge and appends its own lines; the native
// ffmpeg session (ffmpeg.js) appends the spawned command line and ffmpeg's
// stderr to the SAME file under the log id, so a failed export reads as one
// story. Files live under app.getPath("logs")/exports —
// macOS: ~/Library/Logs/Toolbox/exports, Windows: %APPDATA%\Toolbox\logs\exports —
// and the newest MAX_LOGS are kept.
//
// The renderer only ever supplies a display name (sanitised into the file
// name) and text lines (length-capped); it never picks a path.
"use strict";

const { app, ipcMain } = require("electron");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const MAX_LOGS = 40;
const MAX_LINE = 4000;

const logs = new Map(); // id → { path, stream }
let counter = 0;

function logsDir() {
  const dir = path.join(app.getPath("logs"), "exports");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function sanitizeName(name) {
  const s = String(name || "export").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return (s || "export").slice(0, 40);
}

// Best-effort: keep the newest MAX_LOGS files, unlink the rest.
async function prune(dir) {
  try {
    const names = (await fsp.readdir(dir)).filter((n) => n.endsWith(".log"));
    if (names.length <= MAX_LOGS) return;
    const stats = await Promise.all(
      names.map(async (n) => {
        const p = path.join(dir, n);
        const st = await fsp.stat(p).catch(() => null);
        return { p, mtime: st ? st.mtimeMs : 0 };
      })
    );
    stats.sort((a, b) => b.mtime - a.mtime);
    await Promise.all(stats.slice(MAX_LOGS).map((s) => fsp.unlink(s.p).catch(() => {})));
  } catch {
    /* housekeeping only */
  }
}

function openLog(name) {
  const dir = logsDir();
  const id = `xlog-${++counter}`;
  const file = path.join(dir, `${stamp()}-${sanitizeName(name)}.log`);
  const stream = fs.createWriteStream(file, { flags: "a" });
  stream.on("error", () => {}); // a full disk must not crash main
  logs.set(id, { path: file, stream });
  stream.write(`# Toolbox ${app.getVersion()} export log — ${new Date().toISOString()}\n`);
  void prune(dir);
  return { id, path: file };
}

// Returns false when the id is unknown (closed, or never opened).
function appendLog(id, line) {
  const l = logs.get(id);
  if (!l) return false;
  let text = String(line);
  if (text.length > MAX_LINE) text = text.slice(0, MAX_LINE) + " …";
  l.stream.write(text.endsWith("\n") ? text : text + "\n");
  return true;
}

function closeLog(id) {
  const l = logs.get(id);
  if (!l) return;
  logs.delete(id);
  l.stream.end();
}

function closeAll() {
  for (const id of [...logs.keys()]) closeLog(id);
}

function register() {
  ipcMain.handle("toolbox:exportLogOpen", (_event, name) => openLog(name));
  ipcMain.handle("toolbox:exportLogAppend", (_event, id, line) => {
    appendLog(String(id), line);
  });
  ipcMain.handle("toolbox:exportLogClose", (_event, id) => {
    closeLog(String(id));
  });
}

module.exports = { register, openLog, appendLog, closeLog, closeAll };
