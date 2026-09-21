# Asynchronous, pipelined export readback (task spec, 2026-09-21)

**Status:** built 2026-09-21 for the native ffmpeg path. The engine half
(`readImagePixelsAsync`) is proven byte-identical to the sync readback and
stale-free under a real WebGL2 context by `npm run check:readback-async`;
the scheduler by `npm run check:export-pipeline`. The speed win has NOT been
measured yet — it needs a desktop export of the reference project (see
TESTING.md, "Verifying the pipelined export on the desktop"). The wasm,
sequence and GIF loops still use the sync readback, per §Export loops:
measure the native path first. Prereqs: 092126_export-capture-readback.md
(the synchronous readback this replaces) and TESTING.md §3 (GPU timing
traps).

### What landed

- `src/engine/gl.ts` — `readImagePixelsAsync` on `EngineBackend`: the sync
  path's Y-flipped blit into the pooled RGBA8 target (factored into
  `drawReadbackTarget` so the two stay byte-identical), `readPixels` into a
  `STREAM_READ` PIXEL_PACK_BUFFER from a 3-slot pool (an over-subscribed
  pool falls back to a per-read buffer deleted on completion), a fence +
  `flush`, a 2 ms `setTimeout` poll, `getBufferSubData` on signal, 5 s
  timeout → null. `cancel()` frees the fence and slot at once and resolves
  null; `destroy()` disposes every outstanding read first. PIXEL_PACK_BUFFER
  is unbound after every use — it is global state and a stray binding turns
  every later plain `readPixels` into a PBO write.
- `src/lib/export-pipeline.ts` — `runFramePipeline`, the pure one-in-flight
  scheduler from §Export loops. It reports `render` and `capture` (fence
  wait); `write` is the consumer's own span since only it knows when the
  encoder took the bytes. Any failure cancels the read issued for the next
  frame and rethrows.
- `src/components/effects/EffectsApp.tsx` — `captureFrameRGBAAsync`; the
  native ffmpeg loop runs on the pipeline. Progress counts frames handed
  off. `session.abort()` on error is unchanged.
- Gates: `scripts/check-export-pipeline.mts` (in `npm run check`),
  `scripts/check-readback-async.cjs` (Electron, bundles gl.ts with esbuild).

## Problem

Since 2026-09-21 the frame-loop exporters read each frame straight off the
terminal texture with `EngineBackend.readImagePixels` (`gl.readPixels`,
synchronous). The measured cost per frame, from the export logs of the
BrexGradients project on an M5 Pro:

| Stage | 3840² | 4000² |
|---|---|---|
| render (CPU side of eval + blit) | 25 ms | 50–58 ms |
| capture (`readImagePixels`: GPU finish + 59–64 MB readback) | **340 ms** | **400 ms** |
| write (IPC clone + pipe drain to ffmpeg) | 74 ms | 76–116 ms |
| total per frame | ~450 ms | ~600 ms |

The GPU has to finish the frame before its pixels can move, and the CPU
sits idle while that happens; then the GPU sits idle while the CPU copies
and ships the bytes. Nothing overlaps. The encoder (native ffmpeg, even
lossless x264) kept pace in every run, so the frame loop is the ceiling.

## Goal

Overlap GPU work on frame N+1 with the CPU work on frame N, without ever
delivering a stale or wrong frame. Target: per-frame time close to
`max(gpu render + copy, cpu transfer)` instead of their sum — for the runs
above roughly 340 ms → ~250 ms at 3840², i.e. a 25–35 % faster export. Not
a goal: reducing the GPU's own render time (that is graph cost) or the IPC
copy (see the streaming-transport idea in the 2026-09-21 discussion).

## Design

### Engine: `readImagePixelsAsync`

Add to `EngineBackend` (src/engine/gl.ts), next to `readImagePixels`:

```ts
readImagePixelsAsync(image: ImageValue, width?: number, height?: number):
  { promise: Promise<Uint8ClampedArray<ArrayBuffer> | null>; cancel(): void }
```

1. Render `image` into the pooled RGBA8 readback target exactly as
   `readImagePixelsInternal` does (same Y-flipped `READBACK_FS`, so bytes
   stay row-0-top and byte-identical to the sync path).
2. Bind a `PIXEL_PACK_BUFFER` from a small pool (3 buffers of `w*h*4`
   bytes, `STREAM_READ`), `gl.readPixels(0, 0, w, h, RGBA, UNSIGNED_BYTE, 0)`
   — this enqueues a GPU-side copy and returns immediately.
3. `const sync = gl.fenceSync(SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush();`
4. Poll `gl.clientWaitSync(sync, 0, 0)` on a short timer (2–4 ms, or a
   rAF when one is running) until `ALREADY_SIGNALED` / `CONDITION_SATISFIED`,
   then `gl.getBufferSubData(PIXEL_PACK_BUFFER, 0, dst)` into a fresh
   `Uint8Array(w*h*4)`, delete the sync, return the buffer to the pool.
5. Time out at 5 s → resolve `null` (the caller treats null as a hard
   error, as today). Guard `fenceSync` availability; WebGL2 always has it.

Ordering guarantee that makes this safe: GL executes commands in order, so
the copy into the PBO is complete before any later command writes the
readback target or the source texture. The NEXT eval may release / reuse
the terminal texture; it cannot affect a copy already enqueued.

`readImagePixels` (sync) stays for the MCP screenshot and single stills.

### Export loops: one frame in flight

In `EffectsApp.exportVideo` (native path first; then wasm and sequence):

```
render(0); pending = readAsync(0)
for i in 1..N-1:
  render(i)                     // GPU starts frame i
  next = readAsync(i)           // enqueue copy of frame i
  px = await pending.promise    // frame i-1 lands (GPU is busy with i)
  await writeFrame(px)          // IPC + drain overlaps GPU work on i
  pending = next
px = await pending.promise; await writeFrame(px)
```

- Keep `checksum` / `log.frame` bookkeeping per frame; timings become
  `render`, `capture` (fence wait only), `write`.
- Two frames of RGBA8 alive at once (118–128 MB) — fine on desktop.
- The progress bar's "Rendering i/N" counts frames HANDED OFF, not rendered.
- Abort / error: cancel the pending read, `session.abort()`, rethrow.
- `renderSettledFrameAt` may render twice (media settle). The async read
  must be issued after the settled pass — keep it inside `renderAt`'s
  continuation, not before the settle.
- The wasm tier and the sequence exporter can use the same shape with
  `rgbaToBytes` / `rgbaToBlob` as the consumer; the GIF path likewise. Do
  the native path first and measure before touching the others.

### Depth of pipelining

Start at one frame in flight. Going deeper buys little once the GPU is the
bottleneck and costs 59 MB per extra frame; measure before adding a third
buffer.

## Verify

- Byte parity: export 24 frames of the same project with the sync and the
  async paths and compare checksums in the two export logs (the log prints
  one per frame). They must be identical.
- Speed: the export log's `avgMs` block — `capture` should drop to the
  fence-wait time and total per frame to roughly `max(...)`. State the
  project, size and machine with the numbers (TESTING.md §6).
- No stale frames: `distinctFrames` equals `frames` for an animated graph;
  the identical-run warning must not fire.
- Abort mid-export leaves no pending fences or PBOs (`gl.getError()` clean,
  no growth in the pool).
- `npm run check` (add a pure-half gate for the pipeline scheduler if it is
  factored as a function: issue order, hand-off order, abort path).

## Files

- `src/engine/gl.ts` — `readImagePixelsAsync`, PBO pool, fence polling.
- `src/components/effects/EffectsApp.tsx` — `captureFrameRGBAAsync`, the
  native loop; then wasm / sequence / GIF loops.
- `src/lib/export-log.ts` — no change expected; timings already per stage.
- `TESTING.md` — the new gate, if any, and the parity procedure above.
