// Produce a runnable Next standalone tree for the Electron desktop build.
// `next build` with output:'standalone' (gated by DESKTOP_BUILD) emits
// .next/standalone/server.js + traced node_modules, but NOT the static assets
// or public/ — those must be copied alongside it. electron-builder then bundles
// .next/standalone via extraResources. See specdocs/062626_electron-native-export.md.
import { execSync } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const standalone = path.join(root, ".next", "standalone");

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
