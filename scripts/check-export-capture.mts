// check-export-capture: the pure half of the export capture + log path
// (src/lib/export-capture.ts, src/lib/export-log.ts). The GPU readback
// itself (EngineBackend.readImagePixels) and rgbaToBlob (OffscreenCanvas)
// are browser-only — drive them in the live app. See TESTING.md.
//
//   npx tsx scripts/check-export-capture.mts

import {
  CHECKSUM_SAMPLES,
  FrameRunTracker,
  frameChecksum,
  toError,
} from "../src/lib/export-capture";
import { ExportLog } from "../src/lib/export-log";
import type { ExportLogSink } from "../src/lib/platform/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---- frameChecksum ---------------------------------------------------------
{
  const small = new Uint8ClampedArray(64 * 4).fill(7);
  const a = frameChecksum(small);
  check("checksum: deterministic", frameChecksum(small) === a);
  check("checksum: uint32", Number.isInteger(a) && a >= 0 && a <= 0xffffffff);
  const flipped = new Uint8ClampedArray(small);
  flipped[0] ^= 0xff;
  check("checksum: a changed byte changes it (small buffer)", frameChecksum(flipped) !== a);
  check(
    "checksum: length is part of it",
    frameChecksum(new Uint8ClampedArray(65 * 4).fill(7)) !== a
  );
  // Large buffer: sampled on a fixed stride, whole pixels. Byte 0 and every
  // stride multiple are always sampled; unsampled bytes are (by design)
  // invisible, so the tests only touch sampled positions.
  const big = new Uint8ClampedArray(1920 * 1080 * 4);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
  const c = frameChecksum(big);
  check("checksum: large buffer deterministic", frameChecksum(big) === c);
  const stride = Math.max(4, Math.floor(big.length / 4 / CHECKSUM_SAMPLES) * 4);
  const big2 = new Uint8ClampedArray(big);
  big2[stride * 100 + 2] ^= 0x80;
  check("checksum: a sampled pixel change is detected", frameChecksum(big2) !== c);
  const big3 = new Uint8ClampedArray(big);
  big3[0] ^= 0x01;
  check("checksum: byte 0 is always sampled", frameChecksum(big3) !== c);
}

// ---- FrameRunTracker -------------------------------------------------------
{
  const t = new FrameRunTracker();
  for (const c of [1, 1, 1, 2, 2, 3]) t.push(c);
  const s = t.summary();
  check("runs: frames", s.frames === 6);
  check("runs: distinct", s.distinctFrames === 3);
  check(
    "runs: longest run + where it starts",
    s.longestIdenticalRun === 3 && s.longestRunStartFrame === 0
  );
  check("runs: never suspicious under 20 frames", !t.suspicious);

  const u = new FrameRunTracker();
  for (let i = 0; i < 5; i++) u.push(i);
  for (let i = 0; i < 25; i++) u.push(99);
  check(
    "runs: 25 identical of 30 → suspicious, run starts at frame 5",
    u.suspicious && u.longestRun === 25 && u.longestRunStart === 5
  );

  const v = new FrameRunTracker();
  for (let i = 0; i < 30; i++) v.push(i % 2 === 0 ? 1 : 2);
  check("runs: alternating frames are not suspicious", !v.suspicious);

  const w = new FrameRunTracker();
  for (let i = 0; i < 30; i++) w.push(i < 12 ? 5 : i);
  check("runs: a run under half the export is not suspicious", !w.suspicious);
}

// ---- toError ---------------------------------------------------------------
{
  const e = new Error("boom");
  check("toError: Error passes through", toError(e) === e);
  check("toError: worker string → Error", toError("FS error").message === "FS error");
  check(
    "toError: {message} → Error",
    toError({ message: "ErrnoError: FS error" }).message === "ErrnoError: FS error"
  );
  check(
    "toError: junk → fallback",
    toError(42).message === "Export failed" && toError("   ", "x").message === "x"
  );
}

// ---- ExportLog against a fake sink ------------------------------------------
{
  const appended: string[] = [];
  let closed = 0;
  const sink: ExportLogSink = {
    id: "xlog-1",
    path: "/tmp/fake.log",
    append: (l) => {
      appended.push(l);
    },
    close: async () => {
      closed++;
    },
  };
  const quiet = { info: console.info, warn: console.warn, error: console.error };
  console.info = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    const log = new ExportLog("video", sink);
    log.info("start", { codec: "h264-lossless", fps: 60, ratio: 1 / 3 });
    check("log: id + path come from the sink", log.sinkId === "xlog-1" && log.path === "/tmp/fake.log");
    check(
      "log: line format [time] LEVEL message {json, floats to 3dp}",
      /^\[\s*\d+\.\d{3}s\] INFO {2}start \{"codec":"h264-lossless","fps":60,"ratio":0\.333\}$/.test(
        appended[0] ?? ""
      ),
      appended[0]
    );
    log.debug("quiet line");
    check("log: debug reaches the sink", appended.some((l) => l.includes("DEBUG quiet line")));

    // 100 frames: 40 identical, then 60 distinct.
    const total = 100;
    for (let i = 0; i < total; i++) {
      log.frame(i, total, { render: 1, capture: 2, write: 3 }, i < 40 ? 7 : i, 1000);
    }
    const frameLines = appended.filter((l) => / frame \d+\/100 /.test(l));
    check(
      "log: frame cadence — first 3, every 30th, last",
      frameLines.length === 7,
      `${frameLines.length} lines`
    );
    check(
      "log: identical-run warning fires exactly once",
      appended.filter((l) => l.includes("WARN") && l.includes("unchanged for 10 frames")).length === 1
    );
    const s = log.summary() as {
      frames: number;
      distinctFrames: number;
      longestIdenticalRun: number;
      longestRunStartFrame: number;
      capturedFrames: number;
      bytesToEncoder: number;
      avgMs: { render: number; capture: number; write: number };
    };
    check(
      "log: summary counts",
      s.frames === 100 &&
        s.capturedFrames === 100 &&
        s.distinctFrames === 61 &&
        s.longestIdenticalRun === 40 &&
        s.longestRunStartFrame === 0,
      JSON.stringify(s)
    );
    check(
      "log: summary averages + bytes",
      s.avgMs.render === 1 && s.avgMs.capture === 2 && s.avgMs.write === 3 && s.bytesToEncoder === 100000
    );
    check("log: 40 identical of 100 is under half → not suspicious", !log.runs.suspicious);
    check("log: tail(n) returns the last n lines", log.tail(3).split("\n").length === 3);

    await log.finish("ok", { path: "/x/out.mov" });
    const last = appended[appended.length - 1] ?? "";
    check(
      "log: finish writes the summary at INFO and closes the sink",
      last.includes("INFO  video export ok") && last.includes('"path":"/x/out.mov"') && closed === 1,
      last
    );
    await log.finish("failed");
    check(
      "log: finish is idempotent",
      closed === 1 && !(appended[appended.length - 1] ?? "").includes("failed")
    );

    const ring = new ExportLog("gif", null);
    for (let i = 0; i < 1000; i++) ring.debug(`line ${i}`);
    check(
      "log: ring keeps the last 600 lines",
      ring.lines.length === 600 &&
        ring.lines[0].endsWith("line 400") &&
        ring.lines[599].endsWith("line 999")
    );
    check("log: no sink → path/id null", ring.path === null && ring.sinkId === null);
  } finally {
    console.info = quiet.info;
    console.warn = quiet.warn;
    console.error = quiet.error;
  }
}

if (failures > 0) {
  console.log(`\ncheck-export-capture: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall passed");
