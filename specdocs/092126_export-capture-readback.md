# Export capture: direct GPU readback + per-export logs (2026-09-21)

**Status:** built 2026-09-21. Desktop path verified by the author's reproduction
before the change; the change itself needs a desktop run (see §Verify).

## The bug this fixes

A desktop export at Canvas resolution (3840×3840, Max / mov / h264-lossless)
animated for a handful of frames and then held one picture for the rest of
the file. The same project exported correctly at Scale 0.25. The count of
good frames changed from run to run.

What the evidence said:

- The perf trace of the failing run showed all 240 frames evaluated with the
  `export` trigger, the Grain node recomputing on 239 of them with a fresh
  time key, no node errors, a steady texture pool, and a flat GPU process.
  The engine rendered every frame.
- ffmpeg received 240 frames of the right size and exited 0.
- So the frozen pixels were produced between the engine and the encoder:
  the export read the **on-screen preview canvas** (`drawImage` into a CPU
  canvas → `getImageData`; the wasm, sequence and GIF tiers used
  `canvas.toBlob`). Chromium can hand back a 2D canvas' *last* picture while
  the window is occluded or the canvas is hibernated or resource-starved,
  which is exactly a large canvas during a long export.

Nothing in the app noticed: the success toast said "Exported 240 frames",
neither tier surfaced ffmpeg's messages or exit code, and the wasm tier
would happily deliver a truncated file after a non-zero exit.

## The change

### Capture (`src/lib/export-capture.ts`)

Frames come from `EngineBackend.readImagePixels(terminalImage, w, h)` — the
same readback the MCP screenshot has used in production — RGBA8, straight
alpha, row 0 = visual top. `EffectsApp.renderFrame` publishes the pass'
terminal `ImageValue` in `lastTerminalImageRef`; `captureFrameRGBA(w, h)`
reads it. The texture is valid until the next eval, and the exporters read
it immediately after `renderSettledFrameAt`.

- Native ffmpeg: the bytes go to `session.writeFrame` unchanged — no
  offscreen 2D canvas, no `getImageData`, no `requestAnimationFrame` wait.
  Alpha is now byte-exact (the 2D canvas premultiplied and un-premultiplied
  on the way through).
- ffmpeg.wasm and GIF: `capturePng()` → `rgbaToBytes` (OffscreenCanvas PNG).
- PNG sequence: `rgbaToBlob` at the chosen format/quality.
- Live viewer GIF (`lib/live-viewer`): same readback from the viewer's own
  backend.
- Unchanged: the **fast** tier (MediaRecorder on `captureStream`) and the
  **high** tier (WebCodecs via mediabunny's `CanvasSource`) still sample the
  preview canvas; the log names this on the high tier. Single stills
  (`exportImage`, Render Queue stills) still use `toBlob`.

A null capture (no terminal image, lost context, incomplete FBO) is a hard
error naming the frame, never a stale or blank frame in the file.

### Logs (`src/lib/export-log.ts`, `electron/export-log.js`)

Every exporter opens one `ExportLog` and closes it with a status:

- settings and tier decisions (requested vs actual codec/container, crf,
  ProRes profile, alpha, resolution, audio),
- per-frame `render / capture / write` ms for the first three frames, every
  30th, and the last; a sampled **checksum** per frame feeds an
  identical-run tracker, which warns once at a 10-frame run and, when one
  picture covers ≥10 frames *and* ≥half the export, puts
  "N in a row were identical from frame M; see the export log" in the
  success toast,
- the encoder's own output: the native session appends the spawned command
  line and every ffmpeg stderr line under the log id; the wasm tier mirrors
  ffmpeg's log, checks the exit code, quotes the last 20 lines on failure,
  and drops the core after a wasm abort so the next export reloads it,
- a summary line (frames, distinct frames, longest run, average/max stage
  times, bytes to the encoder, elapsed) and the output path + size.

Desktop: one file per export under `app.getPath("logs")/exports`
(macOS `~/Library/Logs/Toolbox/exports/<stamp>-<kind>.log`, newest 40 kept).
Web: memory ring (600 lines) + console; the failure path dumps the tail.
Failure toasts read `Export failed: <first line> — log: <path>`.

## Verify

- `npm run check:export-capture` — the pure half (checksum, run tracker,
  error normalisation, log format/cadence/summary).
- Desktop: run the export that froze (Canvas res, Max, mov, h264-lossless),
  then open the log the toast names or `~/Library/Logs/Toolbox/exports`.
  Expect `[ffmpeg] spawn: …`, frame lines with distinct checksums, no
  identical-run warning for an animated graph, `exit code 0`, and
  `video export ok {"frames":240,"distinctFrames":240,…}`.
- Web: DevTools console shows `[export:video] …` info lines; force a
  failure (e.g. lossless at 4000² on the wasm tier) and the toast quotes
  ffmpeg's `malloc … failed` line instead of "Export failed".

## Not done here (deliberately)

Hardware encoders (`prores_videotoolbox`, `hevc_videotoolbox` with alpha),
the lossless preset change (veryslow → medium), asynchronous PBO readback,
a streaming transport instead of IPC clones, a browser-tier pixel budget,
and a background export renderer — all discussed 2026-09-21 and parked.
