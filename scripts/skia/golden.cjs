// Golden frames for the device parity lanes (specdocs/101326_skia-target.md
// §3.6). `npm run parity:skia -- --write-golden` renders the fixture through
// TOOLBOX (not the device) and writes
//
//   scripts/fixtures/skia/golden/<fixture>-<size>-f<frame>.png   (RGBA8, exact)
//   scripts/fixtures/skia/golden/<fixture>-<size>.json           (meta)
//
// scripts/skia-device-parity.mjs captures the same frames from the exported
// bundle on an iOS simulator / Android emulator and scores them against
// these files. The meta records the bundle digest the goldens were made
// against, so a device run on a regenerated bundle with stale goldens fails
// loudly instead of reporting a mismatch nobody can explain.
//
// CommonJS: required by the Electron parity entry, imported by the .mjs driver.
/* eslint-disable @typescript-eslint/no-require-imports */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { encodePng, decodePng } = require("./png.cjs");

const REPO = path.resolve(__dirname, "..", "..");
const GOLDEN_DIR = path.join(REPO, "scripts", "fixtures", "skia", "golden");
const BUNDLE_DIR = path.join(REPO, "skia-harness", "src", "bundle");

// sha256 over the exported bundle's files (sorted names + contents).
function bundleDigest(dir = BUNDLE_DIR) {
  const h = crypto.createHash("sha256");
  for (const f of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, f);
    if (!fs.statSync(p).isFile()) continue;
    h.update(f + "\0");
    h.update(fs.readFileSync(p));
    h.update("\0");
  }
  return h.digest("hex");
}

function metaPath(fixture, size) {
  return path.join(GOLDEN_DIR, `${fixture}-${size}.json`);
}

function framePath(fixture, size, frame) {
  return path.join(GOLDEN_DIR, `${fixture}-${size}-f${frame}.png`);
}

// frames: [{ frame, rgba }]; meta: extra fields to record.
function writeGolden({ fixture, size, fps, frames, meta = {} }) {
  fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  const keep = new Set(frames.map((f) => path.basename(framePath(fixture, size, f.frame))));
  const prefix = `${fixture}-${size}-f`;
  for (const f of fs.readdirSync(GOLDEN_DIR)) {
    if (f.startsWith(prefix) && f.endsWith(".png") && !keep.has(f)) fs.rmSync(path.join(GOLDEN_DIR, f));
  }
  const files = {};
  for (const { frame, rgba } of frames) {
    const p = framePath(fixture, size, frame);
    fs.writeFileSync(p, encodePng(rgba, size, size));
    files[frame] = path.basename(p);
  }
  const doc = {
    fixture,
    size,
    fps,
    frames: frames.map((f) => f.frame),
    files,
    bundle: { dir: path.relative(REPO, BUNDLE_DIR), sha256: bundleDigest() },
    ...meta,
  };
  fs.writeFileSync(metaPath(fixture, size), JSON.stringify(doc, null, 2) + "\n");
  return { meta: metaPath(fixture, size), files: Object.values(files).map((f) => path.join(GOLDEN_DIR, f)) };
}

// { meta, frames: Map<frame, rgba> } — throws with the fix when files are missing.
function readGolden(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`${path.relative(REPO, file)} is missing — run \`npm run parity:skia -- --write-golden\``);
  }
  const meta = JSON.parse(fs.readFileSync(file, "utf8"));
  const frames = new Map();
  for (const f of meta.frames) {
    const p = path.join(path.dirname(file), meta.files[f]);
    const img = decodePng(fs.readFileSync(p));
    if (img.width !== meta.size || img.height !== meta.size) {
      throw new Error(`${path.relative(REPO, p)} is ${img.width}×${img.height}, meta says ${meta.size}²`);
    }
    frames.set(f, img.rgba);
  }
  return { meta, frames };
}

module.exports = { GOLDEN_DIR, BUNDLE_DIR, bundleDigest, metaPath, framePath, writeGolden, readGolden };
