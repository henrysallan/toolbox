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
});
