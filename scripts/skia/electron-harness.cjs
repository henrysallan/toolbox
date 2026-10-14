// Shared plumbing for the Electron-hosted Skia tools: parity:skia
// (scripts/skia-parity.cjs) and compare:skia (scripts/skia-compare.cjs).
//
// - bundlePage(): esbuild a renderer page against toolbox's real src/ (the
//   `@/` alias), with the loaders the engine and fixtures need.
// - canvasKitAssets(): where the CanvasKit browser build is served from
//   (public/canvaskit/<ver>/, the copy the editor loads), re-running
//   scripts/copy-canvaskit.mjs when it is missing.
// - makeWindow(): an OFFSCREEN window, not a hidden one. A hidden or
//   backgrounded window suspends requestAnimationFrame entirely
//   (TESTING.md §Traps) — React Native Skia's web canvas only redraws on
//   rAF, and anything else that waits on a frame hangs the same way.
// - js() / waitFor(): executeJavaScript with a timeout, so a wedged page
//   fails with the call that hung instead of sitting forever.
//
// CommonJS: required from Electron main-process entries.
/* eslint-disable @typescript-eslint/no-require-imports */
const { BrowserWindow } = require("electron");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..");
const CANVASKIT_PUBLIC = path.join(REPO, "public", "canvaskit");

function canvasKitVersion() {
  const pkg = path.join(REPO, "node_modules", "canvaskit-wasm", "package.json");
  if (!fs.existsSync(pkg)) throw new Error("canvaskit-wasm is not installed (npm install)");
  return JSON.parse(fs.readFileSync(pkg, "utf8")).version;
}

// { version, dir, wasmBytes } for public/canvaskit/<ver>/.
function canvasKitAssets() {
  const version = canvasKitVersion();
  // The loader's pinned version must be the installed one, or every page
  // fetches a directory that doesn't exist (version policy: they move together).
  const loader = fs.readFileSync(path.join(REPO, "src", "engine", "skia", "canvaskit.ts"), "utf8");
  const pinned = /CANVASKIT_VERSION\s*=\s*"([^"]+)"/.exec(loader)?.[1];
  if (pinned && pinned !== version) {
    throw new Error(`src/engine/skia/canvaskit.ts pins CanvasKit ${pinned} but canvaskit-wasm ${version} is installed`);
  }
  const dir = path.join(CANVASKIT_PUBLIC, version);
  if (!fs.existsSync(path.join(dir, "canvaskit.wasm"))) {
    execFileSync(process.env.NODE_BINARY || "node", [path.join(REPO, "scripts", "copy-canvaskit.mjs")], {
      cwd: REPO,
      stdio: "inherit",
    });
  }
  if (!fs.existsSync(path.join(dir, "canvaskit.wasm"))) {
    throw new Error(`public/canvaskit/${version}/ is missing — run \`node scripts/copy-canvaskit.mjs\``);
  }
  return { version, dir, wasmBytes: fs.statSync(path.join(dir, "canvaskit.wasm")).size };
}

// esbuild a renderer page. `entry` is a file path, or { contents, resolveDir,
// sourcefile } for a generated entry. node:* stays external: esm-potrace-
// wasm's glue has a guarded require("node:fs") branch that never runs in a
// renderer.
function bundlePage({ entry, outfile, globalName }) {
  const esbuild = require("esbuild");
  const common = {
    bundle: true,
    format: "iife",
    globalName,
    platform: "browser",
    target: "es2022",
    alias: { "@": path.join(REPO, "src") },
    loader: { ".wasm": "file", ".sksl": "text", ".glsl": "text" },
    external: ["node:*"],
    outfile,
    logLevel: "error",
    absWorkingDir: REPO,
  };
  if (typeof entry === "string") esbuild.buildSync({ ...common, entryPoints: [entry] });
  else esbuild.buildSync({ ...common, stdin: { ...entry, loader: "ts" } });
}

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".css": "text/css",
};

// Static server on 127.0.0.1. `routes` maps an exact path to a file or a
// { type, body } literal; `mounts` maps a path prefix to a directory;
// `fallback` (optional) is served for unmatched paths (SPA index).
// Returns { base, close, served } — `served` records every 200 so a tool
// can say which CanvasKit binary a page actually fetched.
async function startServer({ routes = {}, mounts = {}, fallback } = {}) {
  const served = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const p = decodeURIComponent(url.pathname);
    let file = null;
    const route = routes[p];
    if (route && typeof route === "object") {
      res.writeHead(200, { "content-type": route.type });
      return res.end(route.body);
    }
    if (typeof route === "string") file = route;
    if (!file) {
      for (const [prefix, dir] of Object.entries(mounts)) {
        if (!p.startsWith(prefix)) continue;
        const f = path.join(dir, p.slice(prefix.length));
        if (f.startsWith(dir) && fs.existsSync(f) && fs.statSync(f).isFile()) file = f;
        break;
      }
    }
    if (!file && fallback) file = fallback(p);
    if (!file || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }
    served.push({ path: p, file, bytes: fs.statSync(file).size });
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    served,
    close: () => server.close(),
  };
}

function makeWindow(width, height, { verbose = false } = {}) {
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    webPreferences: { offscreen: true, backgroundThrottling: false, nodeIntegration: false },
  });
  win.webContents.setFrameRate(60);
  win.webContents.on("console-message", (e) => {
    // Electron ≥ 35: one event object; `level` is "info" | "warning" | "error" | "debug".
    const level = e.level ?? "info";
    const msg = e.message ?? "";
    if (/Electron Security Warning/.test(msg)) return;
    if (verbose || level === "warning" || level === "error") console.log(`[page:${level}] ${msg}`);
  });
  return win;
}

function js(win, code, ms = 30000, label) {
  let timer;
  return Promise.race([
    win.webContents.executeJavaScript(code),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${ms} ms: ${label ?? code.slice(0, 80)}`)),
        ms
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

// Like js(), but an exception in the page comes back with its message
// (executeJavaScript otherwise rejects with a generic "Script failed to
// execute" and the cause is only in the renderer console).
async function call(win, expr, ms = 30000, label) {
  const r = await js(
    win,
    `(async () => { try { return { ok: true, value: await (${expr}) }; } catch (e) { return { ok: false, error: String((e && e.stack) || e) }; } })()`,
    ms,
    label ?? expr.slice(0, 80)
  );
  if (!r.ok) {
    const err = new Error(String(r.error).split("\n")[0].replace(/^Error: /, ""));
    err.pageStack = r.error;
    throw err;
  }
  return r.value;
}

async function waitFor(win, expr, ms = 60000) {
  const t0 = Date.now();
  for (;;) {
    if (await win.webContents.executeJavaScript(`!!(${expr})`)) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms waiting for ${expr}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`--${name} needs a value`);
  return v;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

module.exports = {
  REPO,
  canvasKitAssets,
  canvasKitVersion,
  bundlePage,
  startServer,
  makeWindow,
  js,
  call,
  waitFor,
  arg,
  flag,
};
