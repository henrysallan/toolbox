// Embedded Next standalone server (main process). For the desktop build we run
// the app's own `next build` output locally instead of loading a remote URL —
// full route + auth parity (cookies on localhost), and it serves offline.
// Cloud calls (Supabase) still go over the network and degrade gracefully.
//
// The server runs in Electron's bundled Node via `utilityProcess.fork`, so we
// don't ship a separate node binary. We deliberately do NOT `spawn(process.
// execPath, …)` with ELECTRON_RUN_AS_NODE: on macOS that relaunches the app's
// own GUI binary as a second app instance, which gets its own (perpetually
// bouncing) Dock tile and a fragile lifecycle. `utilityProcess` runs real
// Node, never creates a Dock tile, and is tied to the app's lifetime.
// Spec: specdocs/062626_electron-native-export.md
"use strict";

const http = require("http");
const path = require("path");
const fs = require("fs");
const { app, utilityProcess } = require("electron");

// Pinned so the OAuth redirect URI is stable (allowlist
// http://127.0.0.1:<port>/auth/callback in Supabase). Overridable for testing.
const HOST = "127.0.0.1";
const PORT = Number(process.env.TOOLBOX_SERVER_PORT) || 38274;

// Packaged: bundled via files + asarUnpack → Resources/app.asar.unpacked/.next/standalone.
// Unpackaged (`npm run desktop:prepare && npm run electron`): repo .next/standalone.
function serverEntry() {
  return app.isPackaged
    ? path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        ".next",
        "standalone",
        "server.js"
      )
    : path.join(__dirname, "..", ".next", "standalone", "server.js");
}

let child = null;

function serverUrl() {
  return `http://${HOST}:${PORT}`;
}

function startServer() {
  const entry = serverEntry();
  if (!fs.existsSync(entry)) {
    throw new Error(
      `standalone server not found at ${entry} — run \`npm run desktop:prepare\` first`
    );
  }
  // utilityProcess.fork runs the standalone server as a managed Node child —
  // no Dock tile (unlike re-launching process.execPath), and it always runs as
  // Node so ELECTRON_RUN_AS_NODE isn't needed.
  child = utilityProcess.fork(entry, [], {
    cwd: path.dirname(entry),
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(PORT),
      HOSTNAME: HOST,
    },
    stdio: ["ignore", "pipe", "pipe"],
    serviceName: "toolbox-next-server",
  });
  child.stdout?.on("data", (d) => process.stdout.write(`[next] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[next] ${d}`));
  child.on("exit", (code) => {
    if (code) console.error(`[next] standalone server exited with code ${code}`);
    child = null;
  });
  return serverUrl();
}

// Poll until the server answers, so we don't loadURL before it's listening.
function waitForReady(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(serverUrl(), (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() > deadline) reject(new Error("standalone server did not become ready"));
        else setTimeout(tryOnce, 250);
      });
    };
    tryOnce();
  });
}

function stopServer() {
  if (child) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    child = null;
  }
}

module.exports = { startServer, waitForReady, stopServer, serverUrl };
