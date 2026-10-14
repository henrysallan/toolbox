// Copies CanvasKit's browser build (canvaskit.js + canvaskit.wasm) from the
// pinned canvaskit-wasm package into public/canvaskit/<version>/, where the
// SkSL Shader node loads it at runtime (src/engine/skia/canvaskit.ts). The
// files are gitignored: they are an npm artifact, ~7 MB, and the version in
// the path must move with package.json, not with a commit.
//
// Runs from postinstall; idempotent (skips when the copy is current).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = path.join(ROOT, "node_modules", "canvaskit-wasm");

if (!fs.existsSync(path.join(PKG, "package.json"))) {
  console.log("copy-canvaskit: canvaskit-wasm not installed — skipping");
  process.exit(0);
}

const { version } = JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8"));
const outDir = path.join(ROOT, "public", "canvaskit", version);
fs.mkdirSync(outDir, { recursive: true });

for (const file of ["canvaskit.js", "canvaskit.wasm"]) {
  const src = path.join(PKG, "bin", file);
  const dst = path.join(outDir, file);
  const s = fs.statSync(src);
  if (fs.existsSync(dst) && fs.statSync(dst).size === s.size) continue;
  fs.copyFileSync(src, dst);
  console.log(`copy-canvaskit: ${path.relative(ROOT, dst)}`);
}
