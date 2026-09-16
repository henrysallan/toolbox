// Verifies the bundled ffmpeg writes ProRes 4444 alpha that APPLE's decoder can
// read — the one check that catches the ffmpeg 6.0 bug (specdocs/091526_prores-alpha.md).
//
// Not in `npm run check`: it needs macOS + swiftc, and CI's check job runs on
// ubuntu. Run it by hand after changing the ffmpeg pin in fetch-ffmpeg.mjs.
//
// ffprobe/ffmpeg CANNOT catch this — ffmpeg decodes its own broken output fine.
// The failure mode is silent: Apple's decoder returns opaque pixels (or errors
// with -12911 on partial alpha), which is why the test decodes through
// VideoToolbox and asserts on actual alpha values.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { buildEncoderArgs } = require("../src/lib/export-ffmpeg-args.js");

if (process.platform !== "darwin") {
  console.log("check:prores-alpha — skipped (needs macOS + VideoToolbox)");
  process.exit(0);
}
try {
  execFileSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" });
} catch {
  console.log("check:prores-alpha — skipped (swiftc not found; install Xcode CLT)");
  process.exit(0);
}

function ffmpegBinary() {
  const bin = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  for (const arch of [process.arch, "arm64", "x64"]) {
    const p = path.join(ROOT, "vendor", "ffmpeg", `${process.platform}-${arch}`, bin);
    if (fs.existsSync(p)) return p;
  }
  throw new Error("no vendored ffmpeg — run `npm run fetch:ffmpeg`");
}

// Decodes every frame through VideoToolbox and prints "<min alpha>/<mean alpha>"
// per frame, or ERR. Frames are decoded individually so one bad frame doesn't
// end the run (AVAssetReader stops at the first failure).
const SWIFT = `
import AVFoundation
import VideoToolbox
let asset = AVURLAsset(url: URL(fileURLWithPath: CommandLine.arguments[1]))
let sem = DispatchSemaphore(value: 0)
Task {
  let track = try! await asset.loadTracks(withMediaType: .video)[0]
  let fmt = try! await track.load(.formatDescriptions)[0]
  let reader = try! AVAssetReader(asset: asset)
  let out = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
  reader.add(out); reader.startReading()
  var session: VTDecompressionSession?
  VTDecompressionSessionCreate(allocator: nil, formatDescription: fmt, decoderSpecification: nil,
    imageBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA] as CFDictionary,
    outputCallback: nil, decompressionSessionOut: &session)
  var out_lines: [String] = []
  while let sb = out.copyNextSampleBuffer() {
    if CMSampleBufferGetNumSamples(sb) == 0 { continue }
    var result = "ERR nocallback"
    let st = VTDecompressionSessionDecodeFrame(session!, sampleBuffer: sb, flags: [], infoFlagsOut: nil) { status, _, img, _, _ in
      guard status == noErr, let img else { result = "ERR \\(status)"; return }
      CVPixelBufferLockBaseAddress(img, .readOnly)
      let w = CVPixelBufferGetWidth(img), h = CVPixelBufferGetHeight(img), bpr = CVPixelBufferGetBytesPerRow(img)
      let p = CVPixelBufferGetBaseAddress(img)!.assumingMemoryBound(to: UInt8.self)
      var mn = 255, sum = 0, n = 0
      for y in stride(from: 0, to: h, by: 4) { for x in stride(from: 0, to: w, by: 4) {
        let a = Int(p[y*bpr + x*4 + 3]); mn = min(mn, a); sum += a; n += 1 } }
      CVPixelBufferUnlockBaseAddress(img, .readOnly)
      result = "\\(mn)/\\(sum/n)"
    }
    out_lines.append(st == noErr ? result : "ERR \\(st)")
  }
  print(out_lines.joined(separator: " "))
  sem.signal()
}
sem.wait()
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "toolbox-prores-check-"));
try {
  const clip = path.join(tmp, "alpha.mov");
  const [w, h, fps, frames] = [320, 240, 24, 24];
  // Soft-edged, per-frame-varying alpha: the shape ffmpeg 6.0 encoded wrong.
  // A hard-edged pattern passes even on the broken encoder, so don't use one.
  const args = ["-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w}x${h}`, "-framerate", String(fps),
    "-i", "pipe:0", ...buildEncoderArgs("prores", 18, 4, true), "-r", String(fps), clip];
  const proc = spawn(ffmpegBinary(), args, { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d) => { stderr += d; });
  for (let f = 0; f < frames; f++) {
    const buf = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      buf[o] = 200; buf[o + 1] = 110; buf[o + 2] = 40;
      buf[o + 3] = Math.max(0, Math.min(255, Math.round((x / w) * 255 - 100 + f * 9)));
    }
    if (!proc.stdin.write(buf)) await new Promise((r) => proc.stdin.once("drain", r));
  }
  proc.stdin.end();
  const code = await new Promise((r) => proc.on("close", r));
  if (code !== 0) throw new Error(`ffmpeg exited ${code}\n${stderr}`);

  const src = path.join(tmp, "probe.swift");
  const exe = path.join(tmp, "probe");
  fs.writeFileSync(src, SWIFT);
  execFileSync("xcrun", ["swiftc", "-O", src, "-o", exe], { stdio: "inherit" });
  const report = execFileSync(exe, [clip], { encoding: "utf8" }).trim().split(/\s+/);

  const errors = report.filter((r) => r.startsWith("ERR"));
  const opaque = report.filter((r) => !r.startsWith("ERR") && r.startsWith("255/"));
  if (report.length !== frames) throw new Error(`expected ${frames} frames, Apple's decoder returned ${report.length}`);
  if (errors.length) {
    throw new Error(`Apple's decoder FAILED on ${errors.length}/${frames} frames (${errors[0]}).\n` +
      `This is the ffmpeg 6.0 ProRes alpha bug — see specdocs/091526_prores-alpha.md.`);
  }
  if (opaque.length === frames) {
    throw new Error(`Apple's decoder read every frame as fully opaque — the alpha plane is being dropped.\n` +
      `See specdocs/091526_prores-alpha.md.`);
  }
  console.log(`check:prores-alpha — OK (${frames} frames decoded by VideoToolbox, alpha preserved)`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
