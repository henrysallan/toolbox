// Web Worker entry for off-main-thread EXR decode. One job in, one result
// out; the pixel buffer transfers back (zero-copy). The pool pings a fresh
// worker before trusting it with a job — job buffers TRANSFER on post, so
// they must never be sent to a worker that can't run (e.g. the single-file
// exported app, where worker chunks can't be inlined). See decode-pool.ts.
import { decodeExrToFloat, type ExrDecodeOptions } from "./exr-core";

interface DecodeJob {
  id: number;
  ping?: boolean;
  buffer?: ArrayBuffer;
  options?: ExrDecodeOptions;
}

self.onmessage = (e: MessageEvent<DecodeJob>) => {
  const { id, ping, buffer, options } = e.data;
  if (ping) {
    (self as unknown as Worker).postMessage({ id, ok: true, pong: true });
    return;
  }
  try {
    const out = decodeExrToFloat(buffer!, options ?? {});
    (self as unknown as Worker).postMessage(
      { id, ok: true, width: out.width, height: out.height, data: out.data },
      [out.data.buffer]
    );
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
