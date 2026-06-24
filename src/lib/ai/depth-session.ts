// Session-only state for Depth Anything nodes. Modeled on
// lib/ai/segment-session.ts (the proven per-frame ML bake store), simplified:
// depth has a single output kind (a grayscale depth bitmap), no prompts and
// no encoder embeddings.
//
// The node's params carry only what serializes into .toolbox files (model,
// output mode, invert/near/far, in/out frames). Everything heavy lives here,
// in memory, keyed by node id:
//
//   live — the single-frame depth bitmap from a Preview run (current frame).
//   bake — per-frame PNG-compressed depth maps produced by the Bake button.
//          DELIBERATELY not serialized: reopening a project requires a
//          re-bake (the model/params are saved, so it's one click).
//
// FRAME KEYING — same invariant as Segment: baked frames are keyed by the
// node's OWN clock (the layer-scoped ctx.frame its compute sees), NOT the
// global timeline frame. Nodes inside an offset layer run on layer-local
// time, so a bake driven by global frames would store keys the node's lookups
// never hit (the freeze-at-first-frame bug). The node records its scoped
// frame every compute via recordScopedFrame; the bake driver reads it back
// per captured frame via getScopedFrame.
//
// Both the React panel (writer, via the action functions) and the node's
// compute (reader, via peek/getDecodedDepth) import this module. The sessions
// map is parked on globalThis so panel and engine code paths see the same
// store even if the bundler ever duplicates the module instance.

import type { DepthDtype, DepthModelId } from "./depth-anything";

// Hard ceiling on the bake cache, summed across ALL depth nodes. PNG depth
// maps are small (tens of KB/frame) so this covers thousands of frames — but
// a pathological input aborts with an error instead of eating the tab's
// memory.
export const MAX_BAKE_BYTES = 512 * 1024 * 1024;

// Decoded-bitmap LRU per node — full-res RGBA bitmaps are ~8 MB at 1080p, so
// keep only a small playback window decoded at once.
const DECODED_MAX = 24;
const PREFETCH_AHEAD = 4;

export interface DepthStatus {
  phase: "idle" | "loading-model" | "running" | "baking" | "error";
  // Model-download progress [0..1] when known.
  progress?: number;
  // Bake progress (frames done / total) while phase === "baking".
  frameDone?: number;
  frameTotal?: number;
  error?: string;
  // Non-fatal notice surfaced after a completed action (e.g. "every baked
  // frame was identical — is the upstream actually animating?").
  warning?: string;
}

interface DepthBake {
  // Derived from the stored keys at commit time (min/max), in the NODE'S
  // scoped-frame space. Provisional zeros while the bake is in flight.
  inFrame: number;
  outFrame: number;
  // Expected frame count, for progress display.
  expected: number;
  frames: Map<number, Blob>;
  bytes: number;
  // False while a bake is in flight — the node ignores the bake (and the
  // panel locks model/param editing) until commit flips this on.
  complete: boolean;
}

interface DepthSession {
  live: ImageBitmap | null;
  bake: DepthBake | null;
  decoded: Map<number, ImageBitmap>; // insertion order = LRU order
  decodePending: Map<number, Promise<void>>;
  status: DepthStatus;
  // Bumped whenever the renderable depth changes (live update, bake commit,
  // free). Folded into the node's fingerprint.
  version: number;
  // The node's own clock — last ctx.frame its compute saw. Written every
  // compute; the bake driver keys frames by it (see header comment).
  scopedFrame: number | null;
  liveRunning: boolean;
  pendingLive: {
    getBlob: () => Promise<Blob | null>;
    model: DepthModelId;
    dtype: DepthDtype;
  } | null;
}

// globalThis-parked so engine-side and panel-side imports always share one
// store, even across bundler module duplication.
const SESSIONS_KEY = "__toolboxDepthSessions";
const sessions: Map<string, DepthSession> = (() => {
  const g = globalThis as Record<string, unknown>;
  let m = g[SESSIONS_KEY] as Map<string, DepthSession> | undefined;
  if (!m) {
    m = new Map();
    g[SESSIONS_KEY] = m;
  }
  return m;
})();

// Single revision counter + listener list — the panel subscribes via
// useSyncExternalStore and re-reads session fields on any change.
let storeRev = 0;
const listeners = new Set<() => void>();

export function subscribeDepthStore(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getDepthStoreRev(): number {
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

function ensure(nodeId: string): DepthSession {
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

// Read-only access for the node's compute / fingerprint. Doesn't allocate.
export function peekDepthSession(nodeId: string): {
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

export function getDepthStatus(nodeId: string): DepthStatus {
  return sessions.get(nodeId)?.status ?? { phase: "idle" };
}

export function isDepthLocked(nodeId: string): boolean {
  // Model / params are locked while a bake exists OR is in flight — editing
  // them under a baked cache would silently desync the two.
  return !!sessions.get(nodeId)?.bake;
}

export function isDepthBaked(nodeId: string): boolean {
  return !!sessions.get(nodeId)?.bake?.complete;
}

function setStatus(s: DepthSession, status: DepthStatus) {
  s.status = status;
  notify();
}

export function setDepthStatusBusy(nodeId: string, status: DepthStatus): void {
  setStatus(ensure(nodeId), status);
}

export function setDepthStatusError(nodeId: string, error: string): void {
  setStatus(ensure(nodeId), { phase: "error", error });
}

// ---------------------------------------------------------------------
// Node-clock bridge (see FRAME KEYING in the header)
// ---------------------------------------------------------------------

export function recordScopedFrame(nodeId: string, frame: number): void {
  ensure(nodeId).scopedFrame = frame;
}

export function getScopedFrame(nodeId: string): number | null {
  return sessions.get(nodeId)?.scopedFrame ?? null;
}

// ---------------------------------------------------------------------
// Live (single-frame) preview
// ---------------------------------------------------------------------

export function setLiveDepth(nodeId: string, bitmap: ImageBitmap): void {
  const s = ensure(nodeId);
  s.live?.close();
  s.live = bitmap;
  s.version++;
  setStatus(s, { phase: "idle" });
  bumpPipeline();
}

export function clearLiveDepth(nodeId: string): void {
  const s = sessions.get(nodeId);
  if (!s || !s.live) return;
  s.live.close();
  s.live = null;
  s.version++;
  setStatus(s, { phase: "idle" });
  bumpPipeline();
}

// Run depth estimation on the current frame. Latest-wins queue: a Preview
// click that lands while a run is in flight replaces any queued request, so
// rapid model/frame changes converge on the final state without piling up
// stale inferences.
export async function runLivePreview(
  nodeId: string,
  getBlob: () => Promise<Blob | null>,
  model: DepthModelId,
  dtype: DepthDtype
): Promise<void> {
  const s = ensure(nodeId);
  if (s.bake) return; // locked — free the bake to edit
  s.pendingLive = { getBlob, model, dtype };
  if (s.liveRunning) return;
  s.liveRunning = true;

  try {
    while (s.pendingLive) {
      const req = s.pendingLive;
      s.pendingLive = null;
      try {
        const { estimateDepth } = await import("./depth-anything");
        const onProgress = (p: {
          phase: string;
          progress?: number;
        }) => {
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
              "Couldn't read the upstream image — make the Depth node's chain visible on the canvas (select it or set it Active), then click again.",
          });
          continue;
        }
        const bitmap = await estimateDepth(blob, {
          model: req.model,
          dtype: req.dtype,
          onProgress,
        });
        setLiveDepth(nodeId, bitmap);
      } catch (e) {
        setStatus(s, {
          phase: "error",
          error: (e as Error)?.message ?? "Depth estimation failed.",
        });
      }
    }
  } finally {
    s.liveRunning = false;
  }
}

// ---------------------------------------------------------------------
// Bake lifecycle
// ---------------------------------------------------------------------

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

// Store one baked frame, keyed by the NODE'S scoped frame. Throws when the
// global cache budget is exceeded — the caller frees the partial bake and
// surfaces the error.
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
  // Authoritative range = the keys actually stored, in the node's own frame
  // space.
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

function freeBakeInternal(s: DepthSession): void {
  s.bake = null;
  for (const bmp of s.decoded.values()) bmp.close();
  s.decoded.clear();
  s.decodePending.clear();
}

// ---------------------------------------------------------------------
// Playback-time depth decode (baked path)
// ---------------------------------------------------------------------

// Peek-only readiness check for fingerprinting — must not touch LRU order.
export function hasDecodedDepth(nodeId: string, frame: number): boolean {
  return !!sessions.get(nodeId)?.decoded.has(frame);
}

export function getDecodedDepth(
  nodeId: string,
  frame: number
): ImageBitmap | null {
  const s = sessions.get(nodeId);
  if (!s) return null;
  const bmp = s.decoded.get(frame);
  if (bmp) {
    // Refresh LRU position.
    s.decoded.delete(frame);
    s.decoded.set(frame, bmp);
    return bmp;
  }
  return null;
}

// Kick an async PNG → ImageBitmap decode for a baked frame. Resolves when the
// bitmap is stored (the offline exporter awaits this via the media-settle
// queue); realtime playback gets a pipeline-bump instead.
export function requestDepthDecode(
  nodeId: string,
  frame: number
): Promise<void> {
  const s = sessions.get(nodeId);
  const bake = s?.bake;
  if (!s || !bake?.complete) return Promise.resolve();

  const p = decodeOne(s, frame, true);
  prefetchDepthDecodes(nodeId, frame);
  return p;
}

// Warm the next few frames' bitmaps. Called on decode MISSES (above) and on
// HITS (from the node's compute) — without the hit-path warm-up, sequential
// playback would drain the prefetched window and hitch every PREFETCH_AHEAD
// frames.
export function prefetchDepthDecodes(nodeId: string, frame: number): void {
  const s = sessions.get(nodeId);
  const bake = s?.bake;
  if (!s || !bake?.complete) return;
  const last = Math.min(frame + PREFETCH_AHEAD, bake.outFrame);
  for (let f = frame + 1; f <= last; f++) {
    void decodeOne(s, f, false);
  }
}

function decodeOne(
  s: DepthSession,
  frame: number,
  bump: boolean
): Promise<void> {
  if (s.decoded.has(frame)) return Promise.resolve();
  const pending = s.decodePending.get(frame);
  if (pending) {
    // A prefetch-started decode doesn't bump on landing; if a render is now
    // waiting on this frame (paused scrub), chain a bump so the canvas
    // refreshes when it arrives. Bumps are rAF-coalesced upstream.
    return bump ? pending.then(() => bumpPipeline()) : pending;
  }
  const blob = s.bake?.frames.get(frame);
  if (!blob) return Promise.resolve();

  // Depth values live in the pixel bytes — disable color management so the
  // PNG round-trip is exact.
  const p = createImageBitmap(blob, {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  })
    .then((bmp) => {
      // The bake may have been freed while decoding.
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
      // uploaded depth texture, so playback degrades instead of breaking.
    })
    .finally(() => {
      s.decodePending.delete(frame);
    });
  s.decodePending.set(frame, p);
  return p;
}
