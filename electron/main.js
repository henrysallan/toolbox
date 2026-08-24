// Electron main process. The desktop build runs the app's own Next standalone
// server locally (offline-capable, full cloud parity over the network) and
// gives the renderer native power through the preload bridge.
//
//   TOOLBOX_DEV_URL    → load that (dev: `npm run dev`), with reload-on-fail.
//   TOOLBOX_REMOTE_URL → load that (escape hatch, e.g. the deployed site).
//   otherwise          → spawn the embedded standalone server, load localhost.
//
// Spec: specdocs/archive/062626_electron-native-export.md
"use strict";

const { app, BrowserWindow, shell, ipcMain, nativeImage } = require("electron");
const path = require("path");
const { registerFileHandlers } = require("./files");
const { register: registerFfmpeg, killAllSessions } = require("./ffmpeg");
const { registerRecentsHandlers } = require("./recents");
const { registerAssetsHandlers } = require("./assets");
const { registerUpdater } = require("./updater");
const { startServer, waitForReady, stopServer, serverUrl } = require("./server");
const { startAgentHost, stopAgentHost } = require("./agent");

const DEV_URL = process.env.TOOLBOX_DEV_URL || null;
const REMOTE_URL = process.env.TOOLBOX_REMOTE_URL || null;

function installWindowGuards(win, originUrl) {
  const appOrigin = new URL(originUrl).origin;
  // Navigation policy: same-origin always; off-origin only over https —
  // that keeps the OAuth full-page redirect chain working (Supabase →
  // provider → back to the callback) while blocking file:// (a file dropped
  // outside a drop-zone would blank the app), custom schemes, and plain-http
  // third parties. Off-origin pages get no native bridge either way: the
  // preload's origin gate (preload.js) refuses to expose toolboxNative there.
  const guardNav = (e, url) => {
    try {
      const u = new URL(url);
      if (u.origin === appOrigin) return;
      if (u.protocol === "https:") return;
    } catch {
      /* unparseable — block */
    }
    e.preventDefault();
  };
  win.webContents.on("will-navigate", guardNav);
  win.webContents.on("will-frame-navigate", (e) => guardNav(e, e.url));

  // Same-origin popups (incl. OAuth) open in-app; genuinely external links go
  // to the system browser.
  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    // Panel pop-outs (specdocs/archive/080226_panel-popout-windows.md) are
    // `window.open("", "tb-panel-<leaf>")` — an about:blank child the
    // renderer dresses itself. about:blank parses to origin "null", so
    // it has to be matched by frame name BEFORE the origin check or the
    // panel window would be handed to the system browser.
    //
    // Native frame on purpose: a pop-out has no menu bar to host the
    // app's custom window controls, and a native frame gets OS window
    // snapping and multi-monitor placement for free.
    if (typeof frameName === "string" && frameName.startsWith("tb-panel-")) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          backgroundColor: "#0a0a0a",
          autoHideMenuBar: true,
          minWidth: 320,
          minHeight: 240,
        },
      };
    }
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
  // The app URL is knowable up front in every mode (serverUrl() is pure), so
  // the preload can receive the app origin at window construction — it gates
  // the toolboxNative bridge to this origin.
  const appUrl = DEV_URL || REMOTE_URL || serverUrl();
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    backgroundColor: "#0a0a0a",
    title: "Toolbox",
    // Frameless: no native title bar / traffic lights. The app's nav bar is the
    // title bar (custom window controls + an app-region drag handle).
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Don't throttle rAF/timers — this is a real-time animation tool.
      backgroundThrottling: false,
      additionalArguments: [
        `--toolbox-app-origin=${new URL(appUrl).origin}`,
      ],
    },
  });

  // Broadcast maximize/restore so the renderer's Windows caption buttons can
  // swap the maximize↔restore glyph — this covers native paths too (Win+Up,
  // Snap, double-clicking the drag region), not just our own toggle button.
  const sendMaxState = () => {
    if (!win.isDestroyed())
      win.webContents.send("toolbox:win:maximize-changed", win.isMaximized());
  };
  win.on("maximize", sendMaxState);
  win.on("unmaximize", sendMaxState);

  // Assistant panel's agent host. Started for both the dev-URL and embedded
  // paths — it is independent of how the page itself is served, and the
  // renderer discovers it through /api/agent-handshake either way.
  startAgentHost();

  if (DEV_URL || REMOTE_URL) {
    const url = appUrl;
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
  const url = appUrl;
  installWindowGuards(win, url);
  let ok = false;
  try {
    startServer();
    await waitForReady();
    ok = true;
  } catch (e) {
    console.error("embedded server failed:", e);
  }
  if (ok) {
    const load = () => win.loadURL(url).catch(() => {});
    win.webContents.on("did-fail-load", (_e, code, _d, _u, isMainFrame) => {
      if (isMainFrame && code !== -3) setTimeout(load, 500);
    });
    load();
  } else {
    // Surface the failure instead of a silent black screen.
    const msg =
      "Toolbox couldn't start its local server. Try relaunching; if it persists, reinstall.";
    win.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(
          `<body style="background:#0a0a0a;color:#eee;font:14px -apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div>${msg}</div></body>`
        )
    );
  }
}

// Custom window controls (the renderer draws its own traffic lights since the
// window is frameless).
function registerWindowControls() {
  ipcMain.on("toolbox:win:minimize", (e) =>
    BrowserWindow.fromWebContents(e.sender)?.minimize()
  );
  // Maximize/restore toggle (the Windows caption button; also usable on macOS).
  ipcMain.on("toolbox:win:toggleMaximize", (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });
  ipcMain.handle("toolbox:win:isMaximized", (e) =>
    !!BrowserWindow.fromWebContents(e.sender)?.isMaximized()
  );
  ipcMain.on("toolbox:win:toggleFullscreen", (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return;
    w.setFullScreen(!w.isFullScreen());
  });
  ipcMain.on("toolbox:win:close", (e) =>
    BrowserWindow.fromWebContents(e.sender)?.close()
  );
}

// Dev dock icon. The packaged .app gets its icon from the bundle (build/
// icon.icns via electron-builder); but `npm run electron` / `dev:desktop` run
// plain Electron, which would show the generic Electron dock icon. Point the
// dock at the source PNG in that case (skipped when packaged — the bundled
// icns already wins, and ../public doesn't exist inside the asar).
function setDevDockIcon() {
  if (process.platform !== "darwin" || app.isPackaged || !app.dock) return;
  try {
    const img = nativeImage.createFromPath(
      path.join(__dirname, "..", "public", "ToolboxIcon-iOS-Default-1024x1024@1x.png")
    );
    if (!img.isEmpty()) app.dock.setIcon(img);
  } catch {
    /* non-fatal */
  }
}

app.whenReady().then(() => {
  setDevDockIcon();
  registerFileHandlers();
  registerFfmpeg();
  registerWindowControls();
  registerRecentsHandlers();
  registerAssetsHandlers();
  registerUpdater();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  killAllSessions();
  stopAgentHost();
  stopServer();
});
app.on("window-all-closed", () => {
  killAllSessions();
  stopAgentHost();
  stopServer();
  // macOS apps conventionally stay alive until Cmd+Q.
  if (process.platform !== "darwin") app.quit();
});
