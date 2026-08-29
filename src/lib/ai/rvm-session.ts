// Session-only state for Robust Video Matting on the Background Remove node.
// Modeled on lib/ai/depth-session.ts (the proven per-frame ML bake store).
//
// The node's params carry only what serializes into .toolbox files (model,
// downsample, feather/threshold, in/out frames). Everything heavy lives
// here, in memory, keyed by node id:
//
//   live — the single-frame alpha bitmap from a Preview run (current frame).
//   bake — per-frame PNG-compressed alpha masks produced by Bake over an
//          in/out range. DELIBERATELY not serialized: reopening a project
//          requires a re-bake (the model/params are saved, so it's one click).
//
// FRAME KEYING — same invariant as Segment / Depth: baked frames are keyed
// by the node's OWN clock (the layer-scoped ctx.frame its compute sees),
// NOT the global timeline frame. The node records its scoped frame every
// compute via recordScopedFrame; the bake driver reads it back per captured
// frame via getScopedFrame.
//
// Parked on globalThis so panel and engine code paths share one store even
// if the bundler duplicates the module instance.

import type { RvmDownsample, RvmModelId } from "./rvm";

export const MAX_BAKE_BYTES = 512 * 1024 * 1024;

const DECODED_MAX = 24;
const PREFETCH_AHEAD = 4;

export interface RvmStatus {
  phase: "idle" | "loading-model" | "running" | "baking" | "error";
  progress?: number;
  frameDone?: number;
  frameTotal?: number;
  error?: string;
  warning?: string;
}

interface RvmBake {
  inFrame: number;
  outFrame: number;
  expected: number;
  frames: Map<number, Blob>;
  bytes: number;
  complete: boolean;
}

interface RvmSession {
  live: ImageBitmap | null;
  bake: RvmBake | null;
  decoded: Map<number, ImageBitmap>;
  decodePending: Map<number, Promise<void>>;
  status: RvmStatus;
  version: number;
  scopedFrame: number | null;
  liveRunning: boolean;
  pendingLive: {
    getBlob: () => Promise<Blob | null>;
    model: RvmModelId;
    downsample: RvmDownsample | number | string;
  } | null;
}

const SESSIONS_KEY = "__toolboxRvmSessions";
const sessions: Map<string, RvmSession> = (() => {
  const g = globalThis as Record<string, unknown>;
  let m = g[SESSIONS_KEY] as Map<string, RvmSession> | undefined;
  if (!m) {
    m = new Map();
    g[SESSIONS_KEY] = m;
  }
  return m;
})();

let storeRev = 0;
const listeners = new Set<() => void>();

export function subscribeRvmStore(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getRvmStoreRev(): number {
  return storeRev;
}

function notify() {
  storeRev++;
  for (const fn of listeners) fn();
}

function bumpPipeline() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("pipeline-bump"));
  }
}

function ensure(nodeId: string): RvmSession {
  let s = sessions.get(nodeId);
  if (!s) {
    s = {
      live: null,
      bake: null,
      decoded: new Map(),
      decodePending: new Map(),
      status: { phase: "idle" },
      version: 0,
      scopedFrame: null,
      liveRunning: false,
      pendingLive: null,
    };
    sessions.set(nodeId, s);
  }
  return s;
}

export function peekRvmSession(nodeId: string): {
  live: ImageBitmap | null;
  baked: boolean;
  bakeRange: { inFrame: number; outFrame: number } | null;
  version: number;
} {
  const s = sessions.get(nodeId);
  const baked = !!s?.bake?.complete;
  return {
    live: s?.live ?? null,
    baked,
    bakeRange:
      baked && s?.bake
        ? { inFrame: s.bake.inFrame, outFrame: s.bake.outFrame }
        : null,
    version: s?.version ?? 0,
  };
}

export function getRvmStatus(nodeId: string): RvmStatus {
  return sessions.get(nodeId)?.status ?? { phase: "idle" };
}

export function isRvmLocked(nodeId: string): boolean {
  return !!sessions.get(nodeId)?.bake;
}

export function isRvmBaked(nodeId: string): boolean {
  return !!sessions.get(nodeId)?.bake?.complete;
}

function setStatus(s: RvmSession, status: RvmStatus) {
  s.status = status;
  notify();
}

export function setRvmStatusBusy(nodeId: string, status: RvmStatus): void {
  setStatus(ensure(nodeId), status);
}

export function setRvmStatusError(nodeId: string, error: string): void {
  setStatus(ensure(nodeId), { phase: "error", error });
}

export function recordScopedFrame(nodeId: string, frame: number): void {
  ensure(nodeId).scopedFrame = frame;
}

export function getScopedFrame(nodeId: string): number | null {
  return sessions.get(nodeId)?.scopedFrame ?? null;
}

export function setLiveMask(nodeId: string, bitmap: ImageBitmap): void {
  const s = ensure(nodeId);
  s.live?.close();
  s.live = bitmap;
  s.version++;
  setStatus(s, { phase: "idle" });
  bumpPipeline();
}

export function clearLiveMask(nodeId: string): void {
  const s = sessions.get(nodeId);
  if (!s || !s.live) return;
  s.live.close();
  s.live = null;
  s.version++;
  setStatus(s, { phase: "idle" });
  bumpPipeline();
}

export async function runLivePreview(
  nodeId: string,
  getBlob: () => Promise<Blob | null>,
  model: RvmModelId,
  downsample: RvmDownsample | number | string
): Promise<void> {
  const s = ensure(nodeId);
  if (s.bake) return;
  s.pendingLive = { getBlob, model, downsample };
  if (s.liveRunning) return;
  s.liveRunning = true;

  try {
    while (s.pendingLive) {
      const req = s.pendingLive;
      s.pendingLive = null;
      try {
        const { mattingFrame, freeRvmRec } = await import("./rvm");
        const onProgress = (p: { phase: string; progress?: number }) => {
          if (p.phase === "loading-runtime" || p.phase === "loading-model") {
            setStatus(s, { phase: "loading-model", progress: p.progress });
          } else if (p.phase === "running") {
            setStatus(s, { phase: "running" });
          }
        };
        const blob = await req.getBlob();
        if (!blob) {
          setStatus(s, {
            phase: "error",
            error:
              "Couldn't read the upstream image — make the Background Remove node's chain visible on the canvas, then retry.",
          });
          continue;
        }
        const out = await mattingFrame(blob, null, {
          model: req.model,
          downsample: req.downsample,
          onProgress,
        });
        freeRvmRec(out.rec);
        setLiveMask(nodeId, out.bitmap);
      } catch (e) {
        setStatus(s, {
          phase: "error",
          error: (e as Error)?.message ?? "RVM inference failed.",
        });
      }
    }
  } finally {
    s.liveRunning = false;
  }
}

export function beginBake(nodeId: string, expectedFrames: number): void {
  const s = ensure(nodeId);
  freeBakeInternal(s);
  s.bake = {
    inFrame: 0,
    outFrame: 0,
    expected: expectedFrames,
    frames: new Map(),
    bytes: 0,
    complete: false,
  };
  setStatus(s, {
    phase: "baking",
    frameDone: 0,
    frameTotal: expectedFrames,
  });
}

function totalBakeBytes(): number {
  let sum = 0;
  for (const s of sessions.values()) sum += s.bake?.bytes ?? 0;
  return sum;
}

export function addBakeFrame(nodeId: string, frame: number, png: Blob): void {
  const s = ensure(nodeId);
  const bake = s.bake;
  if (!bake) throw new Error("No bake in progress.");
  bake.frames.set(frame, png);
  bake.bytes += png.size;
  if (totalBakeBytes() > MAX_BAKE_BYTES) {
    throw new Error(
      `Bake cache exceeded ${Math.round(
        MAX_BAKE_BYTES / (1024 * 1024)
      )} MB — try a shorter frame range or a lower input resolution.`
    );
  }
  setStatus(s, {
    phase: "baking",
    frameDone: bake.frames.size,
    frameTotal: bake.expected,
  });
}

export function commitBake(nodeId: string, warning?: string): void {
  const s = ensure(nodeId);
  const bake = s.bake;
  if (!bake) return;
  if (bake.frames.size === 0) {
    freeBake(nodeId, "Bake produced no frames.");
    return;
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const f of bake.frames.keys()) {
    if (f < lo) lo = f;
    if (f > hi) hi = f;
  }
  bake.inFrame = lo;
  bake.outFrame = hi;
  bake.complete = true;
  s.version++;
  setStatus(s, warning ? { phase: "idle", warning } : { phase: "idle" });
  bumpPipeline();
}

export function freeBake(nodeId: string, error?: string): void {
  const s = sessions.get(nodeId);
  if (!s) return;
  freeBakeInternal(s);
  s.version++;
  setStatus(s, error ? { phase: "error", error } : { phase: "idle" });
  bumpPipeline();
}

function freeBakeInternal(s: RvmSession): void {
  s.bake = null;
  for (const bmp of s.decoded.values()) bmp.close();
  s.decoded.clear();
  s.decodePending.clear();
}

export function hasDecodedMask(nodeId: string, frame: number): boolean {
  return !!sessions.get(nodeId)?.decoded.has(frame);
}

export function getDecodedMask(
  nodeId: string,
  frame: number
): ImageBitmap | null {
  const s = sessions.get(nodeId);
  if (!s) return null;
  const bmp = s.decoded.get(frame);
  if (bmp) {
    s.decoded.delete(frame);
    s.decoded.set(frame, bmp);
    return bmp;
  }
  return null;
}

export function requestMaskDecode(
  nodeId: string,
  frame: number
): Promise<void> {
  const s = sessions.get(nodeId);
  const bake = s?.bake;
  if (!s || !bake?.complete) return Promise.resolve();

  const p = decodeOne(s, frame, true);
  prefetchMaskDecodes(nodeId, frame);
  return p;
}

export function prefetchMaskDecodes(nodeId: string, frame: number): void {
  const s = sessions.get(nodeId);
  const bake = s?.bake;
  if (!s || !bake?.complete) return;
  const last = Math.min(frame + PREFETCH_AHEAD, bake.outFrame);
  for (let f = frame + 1; f <= last; f++) {
    void decodeOne(s, f, false);
  }
}

function decodeOne(
  s: RvmSession,
  frame: number,
  bump: boolean
): Promise<void> {
  if (s.decoded.has(frame)) return Promise.resolve();
  const pending = s.decodePending.get(frame);
  if (pending) {
    return bump ? pending.then(() => bumpPipeline()) : pending;
  }
  const blob = s.bake?.frames.get(frame);
  if (!blob) return Promise.resolve();

  const p = createImageBitmap(blob, {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  })
    .then((bmp) => {
      if (!s.bake) {
        bmp.close();
        return;
      }
      s.decoded.set(frame, bmp);
      while (s.decoded.size > DECODED_MAX) {
        const oldest = s.decoded.keys().next().value as number;
        s.decoded.get(oldest)?.close();
        s.decoded.delete(oldest);
      }
      if (bump) bumpPipeline();
    })
    .catch(() => {
      // Decode failure: leave the frame missing — compute holds the last
      // uploaded mask texture, so playback degrades instead of breaking.
    })
    .finally(() => {
      s.decodePending.delete(frame);
    });
  s.decodePending.set(frame, p);
  return p;
}
