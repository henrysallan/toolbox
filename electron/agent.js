// Assistant panel agent host, supervised by the main process (spec
// 080826_claude-agent-panel.md, milestone 1).
//
// Runs scripts/agent-host.mjs as a managed child so the in-app assistant
// panel works without the user starting anything by hand. Same rationale as
// server.js for using utilityProcess.fork: real Node, no Dock tile, tied to
// the app's lifetime.
//
// Token delivery needs no IPC. The desktop build serves the real Next app on
// loopback, so the renderer reads /api/agent-handshake exactly as the browser
// does, and that route reads the host's handshake file server-side.
//
// PACKAGING. The host and the SDK are in electron-builder's `files` +
// `asarUnpack` (a forked child can't run from inside the asar). The SDK's
// 303MB per-platform binaries are deliberately EXCLUDED — the host drives the
// user's own installed Claude Code CLI via pathToClaudeCodeExecutable, so the
// bundled one is dead weight. Verified: the SDK loads and runs with its
// platform package absent. See the spec's packaging decision for why bundling
// wouldn't have removed the install prerequisite anyway.
"use strict";

const path = require("path");
const fs = require("fs");
const { app, utilityProcess } = require("electron");

let child = null;

function hostEntry() {
  // Packaged: asarUnpack → Resources/app.asar.unpacked/scripts/.
  // Unpackaged: the repo checkout.
  return app.isPackaged
    ? path.join(process.resourcesPath, "app.asar.unpacked", "scripts", "agent-host.mjs")
    : path.join(__dirname, "..", "scripts", "agent-host.mjs");
}

function startAgentHost() {
  if (child) return;
  const entry = hostEntry();
  if (!fs.existsSync(entry)) {
    console.error(`[agent] host not found at ${entry}`);
    return;
  }

  // Explicit allowlist, same reasoning as server.js: this host listens on
  // loopback, so shell secrets must not leak into it. Two entries matter
  // more here than for the Next server:
  //   PATH — the SDK locates the user's `claude` binary through it.
  //   HOME — the binary reads the user's logged-in credentials from ~/.claude,
  //          which is how inference bills to their subscription.
  // ANTHROPIC_API_KEY is deliberately NOT forwarded: the panel must use the
  // subscription path, and a stray key in the launching shell would silently
  // redirect billing to it.
  const env = {};
  for (const k of ["PATH", "HOME", "TMPDIR", "LANG", "TZ", "SHELL", "USER"]) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  for (const k of [
    "TOOLBOX_AGENT_PORT",
    "TOOLBOX_AGENT_MODEL",
    "TOOLBOX_AGENT_MAX_TURNS",
  ]) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }

  child = utilityProcess.fork(entry, [], {
    // Node resolves node_modules by walking up from the script, so this only
    // needs to be a real directory on the same branch as the unpacked deps.
    cwd: path.dirname(path.dirname(entry)),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    serviceName: "toolbox-agent-host",
  });
  // The host prints one JSON handshake line on stdout; everything else is
  // stderr. Neither is needed here (the renderer gets the token from the
  // Next route), so both are just surfaced for debugging.
  child.stdout?.on("data", (d) => process.stdout.write(`[agent] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[agent] ${d}`));
  child.on("exit", (code) => {
    if (code) console.error(`[agent] host exited with code ${code}`);
    child = null;
  });
}

function stopAgentHost() {
  if (child) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    child = null;
  }
}

module.exports = { startAgentHost, stopAgentHost };
