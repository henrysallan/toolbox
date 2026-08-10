#!/usr/bin/env node
// Builds the export-template (Vite app under src/export-template/) into both
// Tier-A single-file and Tier-B dist/ artifacts, copies the source/ tree, and
// emits a manifest.json listing every file the runtime needs to fetch. The
// editor serves these as static assets under public/export-template/v1/.
//
// Run via `npm run build:export-template`. Idempotent — clears the destination
// before writing.
//
// `--slim` drops the ~23 MB ONNX-runtime wasm from the published template.
// The web deploy (vercel.json buildCommand) uses it: on Vercel the template
// ships as static assets on every deployment and that one file is ~85% of the
// weight, while ML exports are rare. Desktop / local builds stay full-fat.
// The manifest records `mlRuntime: false` so the editor blocks an ML export
// against a slim template instead of shipping an app that 404s its runtime.
//
// The template's vite toolchain lives in its devDependencies, and npm omits
// dev deps whenever NODE_ENV=production — which Vercel sets during builds.
// `install:export-template` therefore passes --include=dev; without it the
// install brings in only react/react-dom and `npx vite` falls back to an
// ephemeral latest-vite that can't load vite.config.ts's plugin imports.

import { execSync } from "node:child_process";
import { mkdirSync, rmSync, cpSync, writeFileSync, readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const TEMPLATE_DIR = join(REPO, "src", "export-template");
const OUT_DIR = join(REPO, "public", "export-template", "v1");

const SLIM = process.argv.includes("--slim");
// Mirrors ORT_WASM_ASSET_RE in src/lib/export-packager.ts — keep in sync.
const ORT_WASM_ASSET_RE = /^assets\/ort-.*\.wasm$/;

// Paths inside the template-source tree that the user-facing Tier C
// `source/` zip needs. We curate the list rather than blindly copying so
// node_modules / dist / build artifacts never leak in.
const SOURCE_INCLUDE = [
  "package.json",
  "tsconfig.json",
  "vite.config.ts",
  "index.html",
  "README.md",
  "src",
];

function run(cmd, cwd, extraEnv) {
  console.log(`[build-export-template] $ ${cmd}`);
  // Env passed via the `env` option (not a `VAR=1 cmd` shell prefix) so it works
  // on Windows cmd.exe too, not just POSIX shells.
  execSync(cmd, {
    cwd,
    stdio: "inherit",
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
}

function listFilesRecursive(root, base = root) {
  const entries = readdirSync(root);
  const files = [];
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name === "dist-single") {
      continue;
    }
    const full = join(root, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      files.push(...listFilesRecursive(full, base));
    } else {
      files.push(relative(base, full).split("\\").join("/"));
    }
  }
  return files;
}

console.log("[build-export-template] Cleaning output…");
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

// Skip the actual Vite build when the template hasn't been npm-installed yet.
// This lets `npm run build` succeed in fresh checkouts; the editor's Export
// App button will surface a helpful error at runtime if the template hasn't
// been built. CI / pre-publish should run a separate install + build step.
const TEMPLATE_NODE_MODULES = join(TEMPLATE_DIR, "node_modules");
if (!existsSync(TEMPLATE_NODE_MODULES)) {
  console.warn(
    "[build-export-template] src/export-template/node_modules not found — skipping template build."
  );
  console.warn(
    "[build-export-template] Run `npm --prefix src/export-template install` then re-run this script to produce a working Export App template."
  );
  // Still emit a manifest stub so the editor can detect "template missing".
  writeFileSync(
    join(OUT_DIR, "manifest.json"),
    JSON.stringify(
      {
        built: false,
        reason: "template-not-installed",
        mlRuntime: !SLIM,
        distFiles: [],
        sourceFiles: [],
      },
      null,
      2
    )
  );
  process.exit(0);
}

console.log("[build-export-template] Building Tier B (dist/)…");
run("npx vite build --outDir dist --emptyOutDir", TEMPLATE_DIR);

console.log("[build-export-template] Building Tier A (single-file)…");
run("npx vite build --outDir dist-single --emptyOutDir", TEMPLATE_DIR, {
  BUILD_SINGLEFILE: "1",
});

// --- assemble public/export-template/v1/ -----------------------------------

const SINGLEFILE_SRC = join(TEMPLATE_DIR, "dist-single", "index.html");
const DIST_SRC = join(TEMPLATE_DIR, "dist");

console.log("[build-export-template] Copying Tier A single-file…");
cpSync(SINGLEFILE_SRC, join(OUT_DIR, "index.html"));

console.log("[build-export-template] Copying Tier B dist/…");
cpSync(DIST_SRC, join(OUT_DIR, "dist"), { recursive: true });

if (SLIM) {
  // Strip before the manifest is listed, so distFiles/distBytes never
  // advertise a file the deploy doesn't serve.
  const dropped = listFilesRecursive(join(OUT_DIR, "dist")).filter((f) =>
    ORT_WASM_ASSET_RE.test(f)
  );
  for (const f of dropped) rmSync(join(OUT_DIR, "dist", f));
  console.log(
    `[build-export-template] --slim: dropped ML runtime (${dropped.length} file(s): ${dropped.join(", ") || "none"})`
  );
}

console.log("[build-export-template] Copying Tier C source tree…");
const sourceOut = join(OUT_DIR, "source");
mkdirSync(sourceOut, { recursive: true });
for (const item of SOURCE_INCLUDE) {
  const src = join(TEMPLATE_DIR, item);
  if (!existsSync(src)) continue;
  cpSync(src, join(sourceOut, item), { recursive: true });
}
// The Tier-C `source/` zip is for users who want to fork the template, so
// we add a hint about installing once it's in the user's hands. The shipped
// package.json already has the right scripts.

// --- manifest --------------------------------------------------------------

const distFiles = listFilesRecursive(join(OUT_DIR, "dist"));
const sourceFiles = listFilesRecursive(join(OUT_DIR, "source"));

// Per-file byte counts + the Tier-A single-file size, so the editor's
// Export App modal can show a truthful bundle-size estimate (and subtract
// the ort wasm when the project has no ML nodes). Older editors ignore
// the extra fields; older manifests without them fall back to a
// graph-only estimate. Spec: 073126_export-resolution-and-app-slim.md.
const byteMap = (root, files) => {
  const out = {};
  for (const f of files) out[f] = statSync(join(root, f)).size;
  return out;
};
const distBytes = byteMap(join(OUT_DIR, "dist"), distFiles);
const sourceBytes = byteMap(join(OUT_DIR, "source"), sourceFiles);
const tierABytes = statSync(join(OUT_DIR, "index.html")).size;

const manifest = {
  built: true,
  builtAt: new Date().toISOString(),
  // false → this copy has no ONNX runtime; the editor refuses ML exports
  // against it. Absent on manifests built before --slim existed, which the
  // editor treats as true (full template).
  mlRuntime: !SLIM,
  distFiles,
  sourceFiles,
  distBytes,
  sourceBytes,
  tierABytes,
};
writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));

console.log(
  `[build-export-template] Done${SLIM ? " (slim, no ML runtime)" : ""}. dist=${distFiles.length} files, source=${sourceFiles.length} files.`
);
