// One decoded-frame store per video FILE, shared by every Video Source
// node that reads it (spec 090526_video-scrub-optimizations.md M5). Holds
// the byte-budgeted texture cache (video-frame-cache.ts), the single
// background decode job that fills it, and the scratch canvas for
// rotated / downscaled uploads. Nodes acquire/release; the store keeps its
// textures while at least one node uses it and the decode source stays
// with the param value until disposeVideoFile.
//
// The decode job (M1/M2): one iterator at a time per source, always
// moving forward. A forward target ahead of the cursor is FOLLOWED — the
// job's stop point slides with the pointer, so a long forward drag is one
// continuous decode with no keyframe restart. Backward targets, jumps
// beyond MAX_FOLLOW, or targets already passed restart the job at the
// keyframe. Windows widen to the whole GOP when its textures fit in half
// the budget, so short-GOP camera footage becomes fully bidirectional
// after a single pass.
import type { VideoFileParamValue } from "./types";
import type { VideoSample } from "mediabunny";
import {
  FrameCache,
  VIDEO_CACHE_BYTES,
  VIDEO_CACHE_MAX_DIM,
  WINDOW_FAR,
  jobAccepts,
  planWindow,
  slideLimit,
  widenToGop,
  type JobWindow,
} from "./video-frame-cache";
import {
  getVideoDecodeSource,
  type VideoDecodeInfo,
  type VideoDecodeSource,
} from "./video-decode-source";

export interface DecodeJob extends JobWindow {
  target: number;
  cancelled: boolean;
  landed: boolean; // the frame covering target has been uploaded
  lastBump: number;
  done: Promise<void>;
  // Forward jobs idle at their limit with the iterator open, waiting for
  // the pointer to slide it (M1). requestFrames wakes them; after
  // JOB_IDLE_MS without a new target the job closes to free the decoder.
  wake: (() => void) | null;
}

export const JOB_IDLE_MS = 1500;

export interface FrameStore {
  readonly file: VideoFileParamValue;
  readonly cache: FrameCache<WebGLTexture>;
  // The context the textures belong to; null between backends / after the
  // last user released (uploads are refused).
  gl: WebGL2RenderingContext | null;
  job: DecodeJob | null;
  // Previous requested target — decides the direction a new job leans.
  lastTarget: number | null;
  // Cache ts most recently drawn by any node — eviction-protected.
  drawnTs: number;
  scratch: OffscreenCanvas | null;
  readonly users: Set<string>;
  // Diagnostics: how many jobs were started (a forward drag should add 1).
  jobStarts: number;
}

const stores = new WeakMap<VideoFileParamValue, FrameStore>();

function bump(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("pipeline-bump"));
  }
}

// Bind a node to the file's store for the given GL context. A different
// context than last time (backend recreated on a resolution change) means
// the textures are gone with it: drop the bookkeeping, keep the store.
export function acquireFrameStore(
  file: VideoFileParamValue,
  gl: WebGL2RenderingContext,
  nodeId: string
): FrameStore {
  let store = stores.get(file);
  if (!store) {
    const s: FrameStore = {
      file,
      cache: new FrameCache<WebGLTexture>(VIDEO_CACHE_BYTES, (tex) => {
        if (s.gl) s.gl.deleteTexture(tex);
      }),
      gl,
      job: null,
      lastTarget: null,
      drawnTs: NaN,
      scratch: null,
      users: new Set(),
      jobStarts: 0,
    };
    store = s;
    stores.set(file, store);
  } else if (store.gl !== gl) {
    cancelStoreJob(store);
    // Old context's textures are already dead — release must not touch it.
    store.gl = null;
    store.cache.clear();
    store.drawnTs = NaN;
    store.scratch = null;
    store.gl = gl;
  }
  store.users.add(nodeId);
  return store;
}

// A node stopped reading the file. The last user out drops the textures
// (up to the whole budget) but keeps the store for a future node.
export function releaseFrameStore(file: VideoFileParamValue, nodeId: string): void {
  const store = stores.get(file);
  if (!store) return;
  store.users.delete(nodeId);
  if (store.users.size === 0) {
    cancelStoreJob(store);
    store.cache.clear();
    store.gl = null;
    store.drawnTs = NaN;
    store.scratch = null;
    store.lastTarget = null;
  }
}

// The file value itself is going away (disposeVideoFile).
export function disposeFrameStore(file: VideoFileParamValue): void {
  const store = stores.get(file);
  if (!store) return;
  stores.delete(file);
  cancelStoreJob(store);
  store.cache.clear();
  store.gl = null;
}

export function peekFrameStore(file: VideoFileParamValue): FrameStore | null {
  return stores.get(file) ?? null;
}

export function cancelStoreJob(store: FrameStore): void {
  if (store.job) {
    store.job.cancelled = true;
    store.job.wake?.();
  }
}

// Stored size for a source: long side capped at VIDEO_CACHE_MAX_DIM.
export function cacheDims(info: VideoDecodeInfo): { w: number; h: number; scale: number } {
  const scale = Math.min(1, VIDEO_CACHE_MAX_DIM / Math.max(1, info.width, info.height));
  return {
    w: Math.max(1, Math.round(info.width * scale)),
    h: Math.max(1, Math.round(info.height * scale)),
    scale,
  };
}

// Frames from this source are stored pixel-exact (full resolution and not
// a re-encoded proxy).
export function sourceIsExact(source: VideoDecodeSource): boolean {
  return !source.proxy && cacheDims(source.frameInfo).scale === 1;
}

// Ask for the frame at `target` (and a window around it). Returns at once.
export function requestFrames(store: FrameStore, target: number): void {
  const source = getVideoDecodeSource(store.file);
  if (!source || !store.gl) return;
  const cur = store.job;
  if (cur && !cur.cancelled && jobAccepts(cur, target)) {
    cur.target = target;
    cur.landed = false;
    cur.limit = slideLimit(cur, target);
    store.lastTarget = target;
    cur.wake?.();
    return;
  }
  if (cur) cur.cancelled = true;
  const backward = store.lastTarget != null && target < store.lastTarget;
  const job: DecodeJob = {
    target,
    start: 0,
    limit: 0,
    cursor: -Infinity,
    backward,
    cancelled: false,
    landed: false,
    lastBump: 0,
    done: Promise.resolve(),
    wake: null,
  };
  const prev = cur?.done ?? Promise.resolve();
  job.done = prev.then(() => runJob(store, source, job));
  store.job = job;
  store.lastTarget = target;
  store.jobStarts++;
}

async function runJob(
  store: FrameStore,
  source: VideoDecodeSource,
  job: DecodeJob
): Promise<void> {
  if (job.cancelled || !store.gl) return;
  const info = source.frameInfo;
  const { w, h } = cacheDims(info);
  const lean = planWindow(job.target, job.backward ? job.target + 1 : null, info.duration);
  const gop = await source.gopAround(job.target).catch(() => null);
  if (job.cancelled || !store.gl) return;
  const win = widenToGop(lean, gop, info.fps, w * h * 4, store.cache.budgetBytes);
  job.start = win.start;
  // A target accepted while the GOP lookup was in flight may already have
  // slid the limit — never shrink it.
  job.limit = Math.max(
    job.limit,
    job.backward ? win.end : Math.max(win.end, job.target + WINDOW_FAR)
  );
  try {
    for await (const sample of source.samples(job.start, info.duration + 1)) {
      if (job.cancelled || !store.gl) {
        sample.close();
        break;
      }
      const ts = sample.timestamp;
      if (ts >= job.limit && !job.backward) {
        // At the limit of a forward window: hold this frame and idle with
        // the decoder open. A slid limit resumes right here — no keyframe
        // restart; a quiet pointer or a cancel lets the job go.
        const resumed = await idleUntilSlid(job, ts);
        if (!resumed) {
          sample.close();
          break;
        }
      } else if (ts >= job.limit) {
        sample.close();
        break;
      }
      job.cursor = ts;
      if (!store.cache.has(ts)) uploadSample(store, source, sample, ts, job.target);
      const dur = sample.duration;
      sample.close();
      const now = performance.now();
      const covers = ts <= job.target && job.target < ts + dur;
      if (!job.landed && (covers || ts > job.target)) {
        // The playhead's frame is in — re-evaluate now. (Bumps are
        // rAF-coalesced by the shell; the rest of the window lands
        // silently except for a slow heartbeat so a nearest-frame proxy
        // can advance during a long decode.)
        job.landed = true;
        job.lastBump = now;
        bump();
      } else if (now - job.lastBump > 120) {
        job.lastBump = now;
        bump();
      }
    }
  } catch (err) {
    if (!job.cancelled && store.gl) {
      console.warn("video-frame-store: decode failed —", err);
    }
  } finally {
    if (store.job === job) store.job = null;
    if (store.gl) bump();
  }
}

// Wait for the limit to move past `ts`, a cancel, or the idle timeout.
// Resolves true when decoding should continue with the held frame.
function idleUntilSlid(job: DecodeJob, ts: number): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (ok: boolean) => {
      if (timer) clearTimeout(timer);
      job.wake = null;
      resolve(ok);
    };
    const check = () => {
      if (job.cancelled) finish(false);
      else if (ts < job.limit) finish(true);
      else {
        // Woken by a target the job accepted but that sits behind this
        // frame — nothing to do until the limit passes us.
        job.wake = check;
      }
    };
    job.wake = check;
    timer = setTimeout(() => finish(false), JOB_IDLE_MS);
    if (job.cancelled || ts < job.limit) check();
  });
}

// Decoded sample → RGBA8 texture in the cache. GPU-backed frames upload
// straight from the VideoFrame (~0.5 ms at 1080p, 1.4 ms at 4K measured);
// rotated or oversized sources go through a 2D canvas, which applies the
// rotation metadata and the VIDEO_CACHE_MAX_DIM downscale in one draw.
function uploadSample(
  store: FrameStore,
  source: VideoDecodeSource,
  sample: VideoSample,
  ts: number,
  protect: number
): void {
  const gl = store.gl;
  if (!gl) return;
  const info = source.frameInfo;
  const { w, h, scale } = cacheDims(info);
  const exact = scale === 1 && !source.proxy;
  const tex = gl.createTexture();
  if (!tex) return;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  let ok = false;
  try {
    if (scale === 1 && info.rotation === 0) {
      const frame = sample.toVideoFrame();
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
      } finally {
        frame.close();
      }
    } else {
      if (!store.scratch || store.scratch.width !== w || store.scratch.height !== h) {
        store.scratch = new OffscreenCanvas(w, h);
      }
      const c2d = store.scratch.getContext("2d");
      if (!c2d) throw new Error("no 2d context");
      sample.draw(c2d, 0, 0, w, h);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, store.scratch);
    }
    ok = true;
  } catch (err) {
    console.warn("video-frame-store: frame upload failed —", err);
  } finally {
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
  if (!ok) {
    gl.deleteTexture(tex);
    return;
  }
  const keep = Number.isNaN(store.drawnTs) ? protect : store.drawnTs;
  store.cache.insert(
    { ts, dur: sample.duration, w, h, exact, bytes: w * h * 4, payload: tex },
    keep
  );
}
