// Electron side of the After Effects package end-to-end run
// (scripts/ae-export/e2e-package.mts — not a gate: it needs After Effects).
//
//   npx electron scripts/ae-export/e2e-electron-host.cjs
//
// Loads the REAL main-process modules (electron/files.js, ffmpeg.js, ae.js),
// captures the ipcMain handlers they register, and serves them as JSON lines
// on stdin / stdout, so the TypeScript side drives nested writes, the
// folder-target encode, the headless build and aerender renders exactly as
// the renderer's preload would. A hidden window supplies event.sender.
// Binary values cross as { __b64 }. One extra verb, `test:registerFolder`,
// stands in for the user picking a folder.
"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- an Electron main script (CommonJS) */

const { app, ipcMain, BrowserWindow } = require("electron");
const readline = require("readline");

const handlers = new Map();
const syncHandlers = new Map();
ipcMain.handle = (channel, fn) => {
  handlers.set(channel, fn);
};
ipcMain.on = (channel, fn) => {
  syncHandlers.set(channel, fn);
  return ipcMain;
};

const enc = (v) => {
  if (v instanceof ArrayBuffer) return { __b64: Buffer.from(v).toString("base64") };
  if (ArrayBuffer.isView(v)) return { __b64: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64") };
  if (Array.isArray(v)) return v.map(enc);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)]));
  return v;
};
const dec = (v) => {
  if (v && typeof v === "object" && typeof v.__b64 === "string") {
    const b = Buffer.from(v.__b64, "base64");
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
  if (Array.isArray(v)) return v.map(dec);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dec(x)]));
  return v;
};

if (app.dock) app.dock.hide();
app.on("window-all-closed", () => {});

app.whenReady().then(() => {
  const files = require("../../electron/files");
  files.registerFileHandlers();
  require("../../electron/ffmpeg").register();
  const ae = require("../../electron/ae");
  ae.register();
  const win = new BrowserWindow({ show: false, width: 64, height: 64 });
  const event = { sender: win.webContents };
  const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const { id, channel } = msg;
    const args = dec(msg.args || []);
    try {
      let value;
      if (channel === "test:registerFolder") value = files.registerFolder(args[0]);
      else if (channel === "test:quit") {
        send({ id, ok: true });
        ae.killAll();
        app.exit(0);
        return;
      } else if (syncHandlers.has(channel)) {
        const ev = { ...event, returnValue: undefined };
        syncHandlers.get(channel)(ev, ...args);
        value = ev.returnValue;
      } else if (handlers.has(channel)) value = await handlers.get(channel)(event, ...args);
      else throw new Error(`no handler for ${channel}`);
      send({ id, ok: true, value: enc(value) });
    } catch (e) {
      send({ id, ok: false, error: e && e.message ? e.message : String(e) });
    }
  });
  rl.on("close", () => {
    ae.killAll();
    app.exit(0);
  });
  send({ ready: true });
});
