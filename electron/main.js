// Electron main process — thin shell that loads the deployed web app and gives
// it native power through the preload bridge. No app code is bundled here; the
// renderer IS the live Vercel site (or the local dev server in development).
//
// Spec: specdocs/062626_electron-native-export.md
"use strict";

const { app, BrowserWindow, shell } = require("electron");
const path = require("path");
const { registerFileHandlers } = require("./files");
const { register: registerFfmpeg } = require("./ffmpeg");

// In dev, point at `next dev` (run `npm run dev` in another terminal). In a
// packaged build, load the stable custom domain — NOT the per-deploy
// *.vercel.app hash URL, which changes on every push.
const DEV_URL = process.env.TOOLBOX_DEV_URL || null;
const PROD_URL = "https://toolbox.isthishenry.com";
const APP_URL = DEV_URL || PROD_URL;

function createWindow() {
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

  // The dev server may not be listening yet when Electron launches (or you may
  // start them in either order). On a failed load, keep retrying so start order
  // never matters. Only in dev — a prod load failure (offline) shows Chromium's
  // error page rather than spinning forever.
  const load = () => win.loadURL(APP_URL).catch(() => {});
  win.webContents.on("did-fail-load", (_e, errorCode, _desc, _url, isMainFrame) => {
    // -3 = ERR_ABORTED (a superseded navigation) — not a real failure.
    if (!isMainFrame || errorCode === -3) return;
    if (DEV_URL) setTimeout(load, 1000);
  });

  // Open genuinely external links (different origin, e.g. docs) in the system
  // browser. Same-origin popups (and, for now, OAuth provider windows) open
  // in-app so sign-in works. Strict origin-locking is part of the security
  // pass once the auth flow is verified end-to-end (see spec, Security).
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const appOrigin = new URL(APP_URL).origin;
      if (new URL(url).origin === appOrigin) return { action: "allow" };
    } catch {
      /* fall through to external */
    }
    shell.openExternal(url);
    return { action: "deny" };
  });

  load();
  if (DEV_URL) win.webContents.openDevTools({ mode: "detach" });
}

app.whenReady().then(() => {
  registerFileHandlers();
  registerFfmpeg();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // macOS apps conventionally stay alive until Cmd+Q.
  if (process.platform !== "darwin") app.quit();
});
