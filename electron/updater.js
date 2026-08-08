// Desktop auto-update — hosts electron-updater in the main process and exposes
// a narrow IPC surface. The renderer's state is driven entirely by pushed
// `toolbox:update:state` events (one payload shape for every phase), so it
// never depends on electron-updater's resolved return types.
//
// electron-updater is loaded from a vendor bundle (electron/vendor/, built by
// desktop:prepare via esbuild) because the electron-builder `files` config
// excludes node_modules. Missing bundle (dev runs) or unpackaged app ⇒ the
// updater degrades to a no-op: manual checks report "none" (Up to Date).
//
// Spec: specdocs/archive/070826_desktop-auto-update.md
"use strict";

const { app, ipcMain, BrowserWindow } = require("electron");

function broadcast(payload) {
  // Quiet state trace — invisible in normal launches, shows when the app is
  // run from a terminal. Handy for diagnosing update issues in the field.
  console.log(`updater state: ${payload.state}${payload.version ? ` v${payload.version}` : ""}`);
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("toolbox:update:state", payload);
  }
}

function loadAutoUpdater() {
  // Only meaningful in a packaged build: app-update.yml (the feed pointer) is
  // embedded by electron-builder at package time.
  if (!app.isPackaged) return null;
  try {
    // eslint-disable-next-line global-require
    const { autoUpdater } = require("./vendor/electron-updater.cjs");
    return autoUpdater;
  } catch (e) {
    console.error("updater: vendor bundle unavailable:", e?.message || e);
    return null;
  }
}

function registerUpdater() {
  const updater = loadAutoUpdater();

  if (updater) {
    // Download only on explicit user action (the "Update Toolbox" menu item).
    updater.autoDownload = false;
    // Default-on, kept explicit: a downloaded-but-not-restarted update still
    // installs on the next normal quit.
    updater.autoInstallOnAppQuit = true;

    updater.on("update-available", (info) =>
      broadcast({ state: "available", version: info?.version })
    );
    updater.on("update-not-available", () => broadcast({ state: "none" }));
    updater.on("download-progress", (p) =>
      broadcast({
        state: "downloading",
        percent: p?.percent ?? 0,
        bytesPerSecond: p?.bytesPerSecond ?? 0,
      })
    );
    updater.on("update-downloaded", (info) =>
      broadcast({ state: "ready", version: info?.version })
    );
    updater.on("error", (err) => {
      // Expected offline / rate-limit failures land here too — the renderer
      // treats error as "revert to Check for Updates", nothing louder.
      console.error("updater:", err?.message || err);
      broadcast({ state: "error", message: String(err?.message || err) });
    });
  }

  ipcMain.handle("toolbox:update:check", async () => {
    if (!updater) {
      broadcast({ state: "none" });
      return;
    }
    broadcast({ state: "checking" });
    // Resolution/errors flow through the event handlers above.
    await updater.checkForUpdates().catch(() => {});
  });

  ipcMain.handle("toolbox:update:download", async () => {
    if (!updater) return;
    broadcast({ state: "downloading", percent: 0, bytesPerSecond: 0 });
    await updater.downloadUpdate().catch(() => {});
  });

  ipcMain.on("toolbox:update:install", () => {
    // Silent install + relaunch (NSIS /S on Windows; params ignored on mac,
    // where Squirrel swaps the .app and relaunches). before-quit still fires,
    // so the embedded server shuts down normally.
    if (updater) updater.quitAndInstall(true, true);
  });
}

module.exports = { registerUpdater };
