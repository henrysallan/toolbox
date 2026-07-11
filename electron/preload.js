// Preload — exposes the narrow `window.toolboxNative` bridge to the renderer.
// Runs sandboxed (contextIsolation on); it may only use contextBridge +
// ipcRenderer. All real work lives in the main process behind ipcMain handlers,
// added in Milestones 2 (file I/O) and 3 (native ffmpeg).
//
// Milestone 1: every operation is a stub that throws. Nothing in the renderer
// calls these yet, so the app behaves exactly like the web build — this just
// proves the shell loads and the bridge is reachable.
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// Origin gate: only expose the bridge on the app's own origin. The preload
// runs for EVERY navigation in this webContents — including the OAuth
// full-page redirect chain (Supabase → Google → back) that will-navigate
// deliberately allows — and an off-origin page must never see
// window.toolboxNative. Main passes the app origin via additionalArguments.
const appOriginArg = process.argv.find((a) =>
  a.startsWith("--toolbox-app-origin=")
);
const appOrigin = appOriginArg
  ? appOriginArg.slice("--toolbox-app-origin=".length)
  : null;
if (!appOrigin || window.location.origin !== appOrigin) {
  // Foreign origin (or misconfigured launch): expose nothing.
  return;
}

// Probe native ffmpeg availability once, synchronously, so the renderer's
// platform adapter can gate on canEncodeNative before attempting an encode.
let caps = { canEncodeNative: false };
try {
  caps = ipcRenderer.sendSync("toolbox:capabilities") || caps;
} catch {
  // handler not registered (shouldn't happen) — stay on the wasm path.
}

contextBridge.exposeInMainWorld("toolboxNative", {
  version: 1,
  platform: process.platform,
  canEncodeNative: !!caps.canEncodeNative,

  // ---- File I/O (Milestone 2) ----
  saveFile: (opts) => ipcRenderer.invoke("toolbox:saveFile", opts),
  pickSaveFolder: () => ipcRenderer.invoke("toolbox:pickSaveFolder"),
  writeFileInFolder: (token, name, bytes) =>
    ipcRenderer.invoke("toolbox:writeFileInFolder", token, name, bytes),
  pickOpenFiles: (opts) => ipcRenderer.invoke("toolbox:pickOpenFiles", opts),

  // ---- Native ffmpeg streaming encode (Milestone 3) ----
  encodeVideoBegin: (spec) => ipcRenderer.invoke("toolbox:encodeVideoBegin", spec),
  encodeVideoFrame: (sessionId, rgba) =>
    ipcRenderer.invoke("toolbox:encodeVideoFrame", sessionId, rgba),
  encodeVideoEnd: (sessionId) => ipcRenderer.invoke("toolbox:encodeVideoEnd", sessionId),
  encodeVideoAbort: (sessionId) => ipcRenderer.invoke("toolbox:encodeVideoAbort", sessionId),
  onEncodeProgress: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on("toolbox:encodeProgress", listener);
    return () => ipcRenderer.removeListener("toolbox:encodeProgress", listener);
  },

  // ---- Transcode-on-import ----
  transcodeForPlayback: (opts) => ipcRenderer.invoke("toolbox:transcodeForPlayback", opts),

  // ---- Window controls (frameless desktop) ----
  window: {
    minimize: () => ipcRenderer.send("toolbox:win:minimize"),
    toggleMaximize: () => ipcRenderer.send("toolbox:win:toggleMaximize"),
    toggleFullscreen: () => ipcRenderer.send("toolbox:win:toggleFullscreen"),
    close: () => ipcRenderer.send("toolbox:win:close"),
    isMaximized: () => ipcRenderer.invoke("toolbox:win:isMaximized"),
    onMaximizeChange: (cb) => {
      const listener = (_e, val) => cb(!!val);
      ipcRenderer.on("toolbox:win:maximize-changed", listener);
      return () => ipcRenderer.removeListener("toolbox:win:maximize-changed", listener);
    },
  },

  // ---- Desktop auto-update ----
  updates: {
    check: () => ipcRenderer.invoke("toolbox:update:check"),
    download: () => ipcRenderer.invoke("toolbox:update:download"),
    install: () => ipcRenderer.send("toolbox:update:install"),
    onState: (cb) => {
      const listener = (_e, s) => cb(s);
      ipcRenderer.on("toolbox:update:state", listener);
      return () => ipcRenderer.removeListener("toolbox:update:state", listener);
    },
  },

  // ---- Recent local .toolbox files ----
  recents: {
    list: () => ipcRenderer.invoke("toolbox:recents:list"),
    open: (p) => ipcRenderer.invoke("toolbox:recents:open", p),
    remove: (p) => ipcRenderer.invoke("toolbox:recents:remove", p),
  },

  // ---- External assets folders ----
  assets: {
    scanCurrent: () => ipcRenderer.invoke("toolbox:assets:scanCurrent"),
    pick: () => ipcRenderer.invoke("toolbox:assets:pick"),
    read: (ref) => ipcRenderer.invoke("toolbox:assets:read", ref),
  },
});
