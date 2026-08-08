// Produce a runnable Next standalone tree for the Electron desktop build.
// `next build` with output:'standalone' (gated by DESKTOP_BUILD) emits
// .next/standalone/server.js + traced node_modules, but NOT the static assets
// or public/ — those must be copied alongside it. electron-builder then bundles
// .next/standalone via extraResources. See specdocs/archive/062626_electron-native-export.md.
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const root = process.cwd();
const standalone = path.join(root, ".next", "standalone");
const require = createRequire(import.meta.url);

// Bundle electron-updater into a single vendor file for the Electron main
// process. The electron-builder `files` config excludes node_modules (the Next
// standalone carries its own traced copy), so a bare require("electron-updater")
// wouldn't resolve in the packaged app — and whitelisting its ~15 transitive
// deps is drift-prone. electron/updater.js lazy-requires this bundle and
// degrades gracefully if it's missing (dev runs). Spec: 070826_desktop-auto-update.md.
console.log("→ bundling electron-updater vendor…");
const updaterEntry = require.resolve("electron-updater");
const vendorOut = path.join(root, "electron", "vendor", "electron-updater.cjs");
mkdirSync(path.dirname(vendorOut), { recursive: true });
execSync(
  `npx esbuild "${updaterEntry}" --bundle --platform=node --format=cjs --external:electron --outfile="${vendorOut}" --log-level=warning`,
  { stdio: "inherit" }
);

console.log("→ next build (DESKTOP_BUILD=1, standalone)…");
execSync("next build", {
  stdio: "inherit",
  env: { ...process.env, DESKTOP_BUILD: "1" },
});

if (!existsSync(path.join(standalone, "server.js"))) {
  throw new Error("standalone build did not produce server.js");
}

console.log("→ copying .next/static into standalone…");
cpSync(path.join(root, ".next", "static"), path.join(standalone, ".next", "static"), {
  recursive: true,
});

if (existsSync(path.join(root, "public"))) {
  console.log("→ copying public/ into standalone…");
  cpSync(path.join(root, "public"), path.join(standalone, "public"), { recursive: true });
}

console.log("✓ standalone ready at .next/standalone");
