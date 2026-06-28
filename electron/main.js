// Electron main process. The desktop build runs the app's own Next standalone
// server locally (offline-capable, full cloud parity over the network) and
// gives the renderer native power through the preload bridge.
//
//   TOOLBOX_DEV_URL    → load that (dev: `npm run dev`), with reload-on-fail.
//   TOOLBOX_REMOTE_URL → load that (escape hatch, e.g. the deployed site).
//   otherwise          → spawn the embedded standalone server, load localhost.
//
// Spec: specdocs/062626_electron-native-export.md
"use strict";

const { app, BrowserWindow, shell } = require("electron");
const path = require("path");
const { registerFileHandlers } = require("./files");
const { register: registerFfmpeg } = require("./ffmpeg");
const { startServer, waitForReady, stopServer, serverUrl } = require("./server");

const DEV_URL = process.env.TOOLBOX_DEV_URL || null;
const REMOTE_URL = process.env.TOOLBOX_REMOTE_URL || null;

function installWindowGuards(win, originUrl) {
  // A file dropped outside an app drop-zone would otherwise navigate the window
  // to file://… and blank the app. Block file:// only — https/localhost
  // redirects (OAuth, full-page sign-in) must still work.
  const blockFileNav = (e, url) => {
    if (url.startsWith("file://")) e.preventDefault();
  };
  win.webContents.on("will-navigate", blockFileNav);
  win.webContents.on("will-frame-navigate", (e) => blockFileNav(e, e.url));

  // Same-origin popups (incl. OAuth) open in-app; genuinely external links go
  // to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (new URL(url).origin === new URL(originUrl).origin) return { action: "allow" };
    } catch {
      /* fall through to external */
    }
    shell.openExternal(url);
    return { action: "deny" };
  });
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    backgroundColor: "#0a0a0a",
    title: "Toolbox",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (DEV_URL || REMOTE_URL) {
    const url = DEV_URL || REMOTE_URL;
    installWindowGuards(win, url);
    // The dev server may not be listening yet (or you start them in either
    // order). Retry on failure so start order never matters; only in dev — a
    // remote failure (offline) shows Chromium's error page instead of spinning.
    const load = () => win.loadURL(url).catch(() => {});
    win.webContents.on("did-fail-load", (_e, code, _d, _u, isMainFrame) => {
      if (isMainFrame && code !== -3 && DEV_URL) setTimeout(load, 1000);
    });
    load();
    if (DEV_URL) win.webContents.openDevTools({ mode: "detach" });
    return;
  }

  // Embedded standalone server.
  const url = serverUrl();
  installWindowGuards(win, url);
  try {
    startServer();
    await waitForReady();
  } catch (e) {
    console.error("embedded server failed:", e);
  }
  win.loadURL(url).catch((e) => console.error("loadURL failed:", e));
}

app.whenReady().then(() => {
  registerFileHandlers();
  registerFfmpeg();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => stopServer());
app.on("window-all-closed", () => {
  stopServer();
  // macOS apps conventionally stay alive until Cmd+Q.
  if (process.platform !== "darwin") app.quit();
});
