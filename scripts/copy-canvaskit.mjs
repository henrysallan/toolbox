// Copies CanvasKit's browser build (canvaskit.js + canvaskit.wasm) from the
// pinned canvaskit-wasm package into public/canvaskit/<version>/, where the
// SkSL Shader node loads it at runtime (src/engine/skia/canvaskit.ts). The
// files are gitignored: they are an npm artifact, ~8 MB, and the version in
// the path must move with package.json, not with a commit.
//
// The build is `bin/full/`, the one react-native-skia's web target imports
// (lib/module/web/LoadSkiaWeb.js → canvaskit-wasm/bin/full/canvaskit), so
// the editor, the exported apps and the RN web harness all run the same
// binary. `bin/` (the package main) is the same Skia without Paragraph /
// Skottie and friends; the SkSL compiler is identical, but "same binary"
// is the claim parity:skia makes. specdocs/101326_skia-target.md §1.4.
//
// Runs from postinstall; idempotent (skips when the copy is current).
// scripts/build-export-template.mjs imports copyCanvasKit() to ship the
// same files inside exported apps.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = path.join(ROOT, "node_modules", "canvaskit-wasm");

// The canvaskit-wasm sub-build react-native-skia's web target loads.
export const CANVASKIT_BUILD_DIR = path.join("bin", "full");
export const CANVASKIT_FILES = ["canvaskit.js", "canvaskit.wasm"];

// { version, srcDir } of the installed canvaskit-wasm, or null when it is
// not installed.
export function canvasKitSource() {
  if (!fs.existsSync(path.join(PKG, "package.json"))) return null;
  const { version } = JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8"));
  return { version, srcDir: path.join(PKG, CANVASKIT_BUILD_DIR) };
}

// Copies the build into <destRoot>/<version>/. Returns the version and the
// destination files, or null when canvaskit-wasm is not installed.
export function copyCanvasKit(destRoot, log = () => {}) {
  const src = canvasKitSource();
  if (!src) return null;
  const outDir = path.join(destRoot, src.version);
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  for (const file of CANVASKIT_FILES) {
    const from = path.join(src.srcDir, file);
    const to = path.join(outDir, file);
    files.push(to);
    // Size differs between bin/ and bin/full/, so a copy left over from
    // the old build is replaced, not kept.
    if (fs.existsSync(to) && fs.statSync(to).size === fs.statSync(from).size) continue;
    fs.copyFileSync(from, to);
    log(to);
  }
  return { version: src.version, outDir, files };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const r = copyCanvasKit(path.join(ROOT, "public", "canvaskit"), (to) =>
    console.log(`copy-canvaskit: ${path.relative(ROOT, to)}`)
  );
  if (!r) console.log("copy-canvaskit: canvaskit-wasm not installed — skipping");
}
