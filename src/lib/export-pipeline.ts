// Export frame pipeline — one frame in flight between the GPU and the
// encoder. Spec: 092126_async-pipelined-readback.md.
//
// The synchronous loop (render → readPixels → write, per frame) serialises
// two idle waits: the CPU blocks while the GPU finishes the frame and copies
// 60 MB out, then the GPU idles while the CPU clones the bytes over IPC and
// drains the pipe. Measured on the BrexGradients project at 3840² (M5 Pro):
// 25 ms render, 340 ms capture, 74 ms write — nothing overlapping.
//
// This scheduler issues frame i's render and its ASYNC readback (a PBO copy
// behind a fence, EngineBackend.readImagePixelsAsync) before it waits for
// frame i-1's bytes and hands them to the encoder. The GPU therefore works
// on frame i while the CPU ships frame i-1, and per-frame time tends toward
// max(gpu, cpu) rather than their sum. Frames are always consumed in order,
// and a frame is only ever read from a copy that was enqueued right after
// its own render — GL executes in order, so the next eval reusing the
// terminal texture cannot touch a copy already queued.
//
// Pure: no GL, no DOM. The GPU half lives in engine/gl.ts; this module is
// what scripts/check-export-pipeline.mts exercises with fake reads.

export interface AsyncRead<T> {
  promise: Promise<T | null>;
  /** Drop the read: free its resources now; the promise resolves null. */
  cancel(): void;
}

// The two stages the pipeline owns. The third — `write`, the consumer's
// checksum + IPC + pipe drain — is the consumer's own span to measure, since
// it only ends when consume() returns.
export interface PipelineTimings {
  /** render(i) — graph eval + issuing the readback, ms. */
  render: number;
  /** Waiting for frame i's fence (the GPU) once its turn came, ms. */
  capture: number;
}

export interface FramePipelineOptions<T> {
  frames: number;
  /** Render frame i. Must complete (including any media settle) before
   *  the readback is issued — the pipeline calls `read` right after. */
  render: (i: number) => void | Promise<void>;
  /** Enqueue the readback of the frame `render(i)` just produced. */
  read: (i: number) => AsyncRead<T>;
  /** Hand frame i's bytes to the encoder. Called strictly in index order. */
  consume: (i: number, value: T, timings: PipelineTimings) => void | Promise<void>;
  /** Error for a read that resolved null (nothing rendered, lost context,
   *  fence timeout). Default names the frame. */
  missing?: (i: number) => Error;
  /** Clock, for tests. */
  now?: () => number;
}

interface InFlight<T> {
  i: number;
  read: AsyncRead<T>;
  renderMs: number;
}

/**
 * Run the frame loop with one readback in flight. Resolves when every frame
 * has been consumed. On any error — render, a null read, consume — the
 * outstanding read is cancelled and the error rethrown; the caller aborts
 * its encoder session.
 */
export async function runFramePipeline<T>(
  opts: FramePipelineOptions<T>
): Promise<void> {
  const now = opts.now ?? (() => performance.now());
  const missing =
    opts.missing ??
    ((i: number) =>
      new Error(`Frame ${i + 1}/${opts.frames}: nothing to capture`));

  // The read whose bytes have not been consumed yet. At most one at any
  // await point except the hand-off inside the loop body, where frame i's
  // read has just been issued and frame i-1's is being collected.
  let inFlight: InFlight<T> | null = null;

  const settle = async (p: InFlight<T>) => {
    const tCapture = now();
    const value = await p.read.promise;
    const captureMs = now() - tCapture;
    if (value == null) throw missing(p.i);
    await opts.consume(p.i, value, { render: p.renderMs, capture: captureMs });
  };

  try {
    for (let i = 0; i < opts.frames; i++) {
      const tRender = now();
      await opts.render(i);
      const read = opts.read(i);
      const next: InFlight<T> = { i, read, renderMs: now() - tRender };
      const prev = inFlight;
      // From here on `next` is the read a failure must cancel: `prev`'s
      // promise is about to be awaited to completion either way.
      inFlight = next;
      if (prev) await settle(prev);
    }
    if (inFlight) {
      const last = inFlight;
      inFlight = null;
      await settle(last);
    }
  } catch (e) {
    inFlight?.read.cancel();
    inFlight = null;
    throw e;
  }
}
