// Worker pool for EXR decodes. A 4K multilayer frame costs seconds of pure
// decompression (measured: ~4.2s DWAA / ~2.1s ZIP at 3840×2160 × 15
// channels), so decode must never block the rAF loop. Jobs queue FIFO onto
// up to POOL_SIZE lazily-spawned workers; the source buffer TRANSFERS to the
// worker (callers hand over a fresh ArrayBuffer — e.g. blob.arrayBuffer() —
// and must not reuse it).
//
// Resilience: a fresh worker is PINGED before it gets a real job — job
// buffers transfer on post, so they must never be handed to a worker whose
// script can't load (the single-file exported app can't inline worker
// chunks). If workers are unavailable (SSR, spawn failure, ping error) the
// queue drains synchronously on the main thread instead.
import {
  decodeExrToFloat,
  type ExrDecodeOptions,
  type ExrDecodeResult,
} from "./exr-core";

interface PendingJob {
  id: number;
  buffer: ArrayBuffer;
  options: ExrDecodeOptions;
  resolve: (r: ExrDecodeResult) => void;
  reject: (e: Error) => void;
}

interface PoolWorker {
  worker: Worker;
  // A worker only receives jobs after answering the ping.
  ready: boolean;
  busy: PendingJob | null;
}

const POOL_SIZE =
  typeof navigator !== "undefined"
    ? Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 4) - 2))
    : 1;

let nextJobId = 1;
let workersBroken = false;
const workers: PoolWorker[] = [];
const queue: PendingJob[] = [];

function handleMessage(pw: PoolWorker, msg: MessageEvent) {
  const data = msg.data as {
    id: number;
    ok: boolean;
    pong?: boolean;
    width?: number;
    height?: number;
    data?: Float32Array;
    error?: string;
  };
  if (data?.pong) {
    pw.ready = true;
    pump();
    return;
  }
  const job = pw.busy;
  pw.busy = null;
  if (job && data && data.id === job.id) {
    if (data.ok) {
      job.resolve({
        width: data.width!,
        height: data.height!,
        data: data.data!,
      });
    } else {
      job.reject(new Error(data.error || "EXR decode failed"));
    }
  }
  pump();
}

function spawnWorker(): void {
  try {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    const pw: PoolWorker = { worker, ready: false, busy: null };
    worker.onmessage = (msg) => handleMessage(pw, msg);
    worker.onerror = () => {
      // Script failed to load or the worker crashed. An in-flight job's
      // buffer transferred with the post, so if the worker had STARTED it
      // the bytes are gone — reject it (Video Source re-reads the blob on a
      // later eval). A never-ready worker had no job to lose.
      if (pw.busy) {
        pw.busy.reject(new Error("EXR decode worker crashed"));
        pw.busy = null;
      }
      const at = workers.indexOf(pw);
      if (at >= 0) workers.splice(at, 1);
      if (workers.length === 0) workersBroken = true;
      worker.terminate();
      pump();
    };
    workers.push(pw);
    worker.postMessage({ id: 0, ping: true });
  } catch {
    workersBroken = true;
  }
}

function pump(): void {
  while (queue.length > 0) {
    const pw = workers.find((w) => w.ready && !w.busy) ?? null;
    if (pw) {
      const job = queue.shift()!;
      pw.busy = job;
      pw.worker.postMessage(
        { id: job.id, buffer: job.buffer, options: job.options },
        [job.buffer]
      );
      continue;
    }
    if (!workersBroken && workers.length < POOL_SIZE) {
      spawnWorker();
      // Fall through: if spawn flipped workersBroken, drain sync below;
      // otherwise wait for the ping to come back.
      if (!workersBroken) return;
    }
    if (workersBroken && workers.length === 0) {
      // Synchronous fallback — drain the queue on the main thread.
      const job = queue.shift()!;
      try {
        job.resolve(decodeExrToFloat(job.buffer, job.options));
      } catch (e) {
        job.reject(e instanceof Error ? e : new Error(String(e)));
      }
      continue;
    }
    return; // workers exist but are busy / still starting up
  }
}

// Decode one layer of an EXR off the main thread. `buffer` is TRANSFERRED —
// pass a fresh copy (blob.arrayBuffer()), never a retained buffer.
export function decodeExrAsync(
  buffer: ArrayBuffer,
  options: ExrDecodeOptions
): Promise<ExrDecodeResult> {
  if (typeof Worker === "undefined") workersBroken = true;
  return new Promise((resolve, reject) => {
    queue.push({ id: nextJobId++, buffer, options, resolve, reject });
    pump();
  });
}

// How many decodes are in flight or queued — the decode-ahead scheduler uses
// this to avoid flooding the pool during playback.
export function exrDecodeBacklog(): number {
  return queue.length + workers.filter((w) => w.busy).length;
}
