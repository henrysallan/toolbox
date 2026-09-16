// Fetches the ffmpeg binary the desktop app ships, into vendor/ffmpeg/<platform>-<arch>/.
//
// Replaces the `ffmpeg-static` npm package, which is pinned to ffmpeg 6.0 and
// whose prores_ks writes a ProRes 4444 alpha plane that Apple's decoder cannot
// read: Premiere / AE / FCP / QuickTime all render such exports fully opaque
// (Resolve, with its own decoder, shows the alpha — which is what makes this so
// easy to misdiagnose as a toolbox bug). ffmpeg 9.0 writes alpha those decoders
// accept. See specdocs/091526_prores-alpha.md.
//
// Runs from postinstall for the host platform; pass --platform=win32-x64 to
// fetch a cross-platform binary (the Windows CI runner fetches its own).
// Every download is pinned by SHA256 — both the archive and the extracted
// binary. A mismatch is a hard failure: the upstream file changed under us, so
// re-verify the new build (including the ProRes alpha check) before repinning.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Verified 2026-09-15 against Apple's ProRes decoder (VideoToolbox) on real
// 4444 alpha footage, plus an encode smoke test of every codec the app offers.
const PINS = {
  // Same upstream ffmpeg-static used for Apple Silicon, just current.
  "darwin-arm64": {
    url: "https://www.osxexperts.net/ffmpeg9arm.zip",
    archiveSha256: "d0c06c5c68ce48af3143b262f7a9118a7c9f67de1e237fcc24ffb14df9c67af9",
    binarySha256: "591260c945d0eef150e3bf82b0ef988bd36a9cecc18ff05d6679617159f0a95e",
    // Mutable URL: osxexperts republishes at the same path, so a hash mismatch
    // here means a new upstream build, not corruption.
    member: "ffmpeg",
    binary: "ffmpeg",
  },
  "win32-x64": {
    url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-15-13-18/ffmpeg-n9.0.1-30-g9258bacca5-win64-gpl-9.0.zip",
    archiveSha256: "f5ab48026a847851639ac804d8768c7098ea4ba8350cb09578dd5c616e4acfda",
    binarySha256: "ed1ceaa4417803d5705c6e40de611a21ab2305d5f35094fd7138f5895a545907",
    member: "ffmpeg-n9.0.1-30-g9258bacca5-win64-gpl-9.0/bin/ffmpeg.exe",
    binary: "ffmpeg.exe",
  },
};

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function target(key) {
  return path.join(ROOT, "vendor", "ffmpeg", key, PINS[key].binary);
}

async function fetchPlatform(key, { force = false } = {}) {
  const pin = PINS[key];
  if (!pin) throw new Error(`no ffmpeg pin for ${key} (have: ${Object.keys(PINS).join(", ")})`);
  const dest = target(key);

  if (!force && fs.existsSync(dest) && sha256(fs.readFileSync(dest)) === pin.binarySha256) {
    console.log(`ffmpeg ${key}: already present and verified`);
    return dest;
  }

  console.log(`ffmpeg ${key}: downloading ${pin.url}`);
  const res = await fetch(pin.url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  const archive = Buffer.from(await res.arrayBuffer());

  const got = sha256(archive);
  if (got !== pin.archiveSha256) {
    throw new Error(
      `ffmpeg ${key}: archive SHA256 mismatch\n  expected ${pin.archiveSha256}\n  got      ${got}\n` +
        `The upstream build changed. Re-verify it (ProRes 4444 alpha against Apple's decoder) before updating the pin.`,
    );
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "toolbox-ffmpeg-"));
  try {
    const zip = path.join(tmp, "ffmpeg.zip");
    fs.writeFileSync(zip, archive);
    // bsdtar reads zips on macOS and Windows 10+; both CI runners have it.
    execFileSync("tar", ["-xf", zip, pin.member], { cwd: tmp, stdio: "inherit" });

    const extracted = path.join(tmp, pin.member);
    const bin = fs.readFileSync(extracted);
    const binGot = sha256(bin);
    if (binGot !== pin.binarySha256) {
      throw new Error(`ffmpeg ${key}: binary SHA256 mismatch\n  expected ${pin.binarySha256}\n  got      ${binGot}`);
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bin);
    fs.chmodSync(dest, 0o755);
    console.log(`ffmpeg ${key}: verified -> ${path.relative(ROOT, dest)}`);
    return dest;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// process.arch lies on this studio's Mac: node is x64 under Rosetta, so it
// reports darwin-x64 on Apple Silicon hardware (the same trap the devguide flags
// for ffmpeg-static). Ask the hardware, and honor npm_config_arch like npm does.
function hostKey() {
  const platform = process.env.npm_config_platform || process.platform;
  let arch = process.env.npm_config_arch || process.arch;
  if (!process.env.npm_config_arch && platform === "darwin" && arch === "x64") {
    try {
      if (execFileSync("sysctl", ["-n", "hw.optional.arm64"], { encoding: "utf8" }).trim() === "1") {
        arch = "arm64";
      }
    } catch {
      // Intel Mac: the sysctl is absent, so x64 was right.
    }
  }
  return `${platform}-${arch}`;
}

const args = process.argv.slice(2);
const force = args.includes("--force");
const asked = args.find((a) => a.startsWith("--platform="))?.slice("--platform=".length);
const keys = asked === "all" ? Object.keys(PINS) : [asked || hostKey()];

for (const key of keys) {
  if (!PINS[key] && !asked) {
    // A dev on an unsupported host (e.g. linux) still gets a working checkout;
    // the app falls back to the wasm export path when the binary is missing.
    console.log(`ffmpeg: no pinned build for ${key} — skipping (desktop export will be unavailable)`);
    process.exit(0);
  }
  await fetchPlatform(key, { force });
}
