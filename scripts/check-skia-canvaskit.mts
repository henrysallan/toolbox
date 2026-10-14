// check-skia-canvaskit: the CanvasKit wiring behind the SkSL Shader node and
// Skia layers (specdocs/101326_skia-target.md §1.4, §3.8.6, §5.6). No GPU:
//
//   1. version policy — the loader's CANVASKIT_VERSION is the installed
//      canvaskit-wasm, and react-native-skia's web target (skia-harness, when
//      installed) resolves the same version;
//   2. same binary — scripts/copy-canvaskit.mjs copies `bin/full/` (what RN
//      Skia's LoadSkiaWeb imports), byte for byte, and is idempotent;
//   3. exported apps — the loader prefix is overridable (setCanvasKitBase,
//      trailing slash added) and the export template's main.tsx points it at
//      the document-relative dist/canvaskit/<ver>/ that build-export-template
//      copies;
//   4. packaging — templateDistFilesFor ships canvaskit/ only for graphs with
//      an SkSL Shader or skia-* node, and keeps the ONNX-runtime rule.
//
// The device lanes (scripts/skia-device-parity.mjs) and parity:skia need a
// simulator / Electron; this is the part a plain `npm run check` can hold.
//
//   npx tsx scripts/check-skia-canvaskit.mts

/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const ck = await import("@/engine/skia/canvaskit");
const pkgVersion = JSON.parse(
  fs.readFileSync(path.join(ROOT, "node_modules", "canvaskit-wasm", "package.json"), "utf8")
).version;

// 1. version policy
check(
  "CANVASKIT_VERSION is the installed canvaskit-wasm",
  ck.CANVASKIT_VERSION === pkgVersion,
  `loader ${ck.CANVASKIT_VERSION}, node_modules ${pkgVersion}`
);
check("CANVASKIT_BASE is /canvaskit/<version>/", ck.CANVASKIT_BASE === `/canvaskit/${pkgVersion}/`, ck.CANVASKIT_BASE);
const rnCk = path.join(ROOT, "skia-harness", "node_modules", "canvaskit-wasm", "package.json");
if (fs.existsSync(rnCk)) {
  const v = JSON.parse(fs.readFileSync(rnCk, "utf8")).version;
  check("skia-harness's react-native-skia resolves the same canvaskit-wasm", v === pkgVersion, `harness ${v}`);
} else {
  console.log("SKIP  skia-harness not installed — RN Skia's canvaskit-wasm version not compared");
}

// 2. same binary
const { copyCanvasKit, CANVASKIT_BUILD_DIR } = (await import(
  path.join(ROOT, "scripts", "copy-canvaskit.mjs")
)) as any;
check("copy-canvaskit copies bin/full", CANVASKIT_BUILD_DIR === path.join("bin", "full"), CANVASKIT_BUILD_DIR);
const lws = path.join(ROOT, "skia-harness", "node_modules", "react-native-skia", "lib", "module", "web", "LoadSkiaWeb.js");
if (fs.existsSync(lws)) {
  check(
    "react-native-skia's web loader imports canvaskit-wasm/bin/full",
    /canvaskit-wasm\/bin\/full\/canvaskit/.test(fs.readFileSync(lws, "utf8"))
  );
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "check-skia-canvaskit-"));
try {
  const logged: string[] = [];
  const r = copyCanvasKit(tmp, (f: string) => logged.push(f));
  check("copyCanvasKit writes <dest>/<version>/", r?.outDir === path.join(tmp, pkgVersion), r?.outDir);
  for (const f of ["canvaskit.js", "canvaskit.wasm"]) {
    const src = fs.readFileSync(path.join(ROOT, "node_modules", "canvaskit-wasm", "bin", "full", f));
    const dst = fs.readFileSync(path.join(tmp, pkgVersion, f));
    check(`${f} is bin/full's, byte for byte`, src.equals(dst), `${dst.length} B`);
  }
  const again: string[] = [];
  copyCanvasKit(tmp, (f: string) => again.push(f));
  check("copyCanvasKit is idempotent (second run copies nothing)", logged.length === 2 && again.length === 0);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 3. exported apps
check("canvasKitBase() defaults to CANVASKIT_BASE", ck.canvasKitBase() === ck.CANVASKIT_BASE);
ck.setCanvasKitBase("https://cdn.example/app/canvaskit/0.41.0");
check("setCanvasKitBase adds the trailing slash", ck.canvasKitBase() === "https://cdn.example/app/canvaskit/0.41.0/");
ck.setCanvasKitBase(ck.CANVASKIT_BASE);
const main = fs.readFileSync(path.join(ROOT, "src", "export-template", "src", "main.tsx"), "utf8");
check(
  "export template points the loader at ./canvaskit/<version>/ before rendering",
  /setCanvasKitBase\(new URL\(`\.\/canvaskit\/\$\{CANVASKIT_VERSION\}\/`, document\.baseURI\)/.test(main) &&
    main.indexOf("setCanvasKitBase(") < main.indexOf("createRoot(")
);
const build = fs.readFileSync(path.join(ROOT, "scripts", "build-export-template.mjs"), "utf8");
check(
  "build-export-template copies CanvasKit into dist/canvaskit/ before listing distFiles",
  /copyCanvasKit\(join\(OUT_DIR, "dist", "canvaskit"\)\)/.test(build) &&
    build.indexOf("copyCanvasKit(join(OUT_DIR") < build.indexOf("const distFiles = listFilesRecursive")
);

// 4. packaging
const { templateDistFilesFor, graphUsesCanvasKit } = await import("@/lib/export-packager");
const dist = [
  "index.html",
  "assets/index-abc.js",
  "assets/ort-wasm-simd-threaded.jsep-xyz.wasm",
  `canvaskit/${pkgVersion}/canvaskit.js`,
  `canvaskit/${pkgVersion}/canvaskit.wasm`,
];
const project = (...types: string[]): any => ({ schemaVersion: 9, nodes: types.map((t, i) => ({ id: `n${i}`, defType: t })), edges: [] });
const has = (files: string[], re: RegExp) => files.some((f) => re.test(f));
const plain = templateDistFilesFor(project("noise", "output"), dist);
check("a graph without Skia nodes ships no canvaskit/", !has(plain, /^canvaskit\//) && plain.includes("index.html"), plain.join(", "));
check("…and no ONNX runtime", !has(plain, /ort-.*\.wasm$/));
const sksl = templateDistFilesFor(project("sksl-shader", "output"), dist);
check("an SkSL Shader graph ships canvaskit/<ver>/{js,wasm}", sksl.filter((f) => f.startsWith("canvaskit/")).length === 2);
check("a skia-* graph ships canvaskit/", has(templateDistFilesFor(project("skia-canvas"), dist), /^canvaskit\//));
check("an ML graph ships the ONNX runtime", has(templateDistFilesFor(project("bg-remove"), dist), /ort-.*\.wasm$/));
check("graphUsesCanvasKit ignores look-alikes", !graphUsesCanvasKit(project("sksl", "noise-skia")));

if (failures) {
  console.error(`check-skia-canvaskit: ${failures} failure(s)`);
  process.exit(1);
}
console.log("check-skia-canvaskit: all passed");
