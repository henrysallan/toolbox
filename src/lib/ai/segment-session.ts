// Session-only state for Segment Anything nodes.
//
// The node's params carry only what serializes into .toolbox files (mode,
// dots, levels, in/out frames, feather/threshold). Everything heavy lives
// here, in memory, keyed by node id:
//
//   live  — the single-frame mask from interactive dot placement (or an
//           auto-mode preview run).
//   bake  — per-frame PNG-compressed masks produced by the Bake button.
//           DELIBERATELY not serialized: reopening a project requires a
//           re-bake (the prompt params are saved, so it's one click).
//
// Masks come in two kinds:
//   alpha — single-channel selection (dots mode). 0..255 coverage.
//   index — per-pixel segment SLOT id (auto modes). Slot 0 = background;
//           slots 1..N are stable segment identities assigned by the
//           cross-frame matcher. Stored losslessly (PNG R channel) and
//           colorized in the node's shader.
//
// FRAME KEYING — important invariant: baked masks are keyed by the
// segment NODE'S OWN clock (the layer-scoped ctx.frame its compute sees),
// NOT the global timeline frame. Nodes inside a layer run on layer-local
// time, so a bake driven by global frames would store keys the node's
// lookups never hit (the freeze-at-first-frame bug). The node records its
// scoped frame on every compute; the bake driver reads it back per
// captured frame via getScopedFrame.
//
// Both the React panels (writers, via the action functions) and the node's
// compute (reader, via peek/getDecodedMask) import this module. The
// sessions map is parked on globalThis so panel and engine code paths see
// the same store even if the bundler ever duplicates the module instance.

import type { SamEmbedding, SegmentDot, SegmentProgress } from "./segment";

export type MaskKind = "alpha" | "index";

// Hard ceiling on the bake cache, summed across ALL segment nodes. PNG
// masks are tiny (tens of KB/frame at 1080p) so this covers thousands of
// frames — but a pathological input (high-res noise compresses badly)
// aborts with an error instead of eating the tab's memory.
export const MAX_BAKE_BYTES = 512 * 1024 * 1024;

// Decoded-bitmap LRU per node — full-res RGBA bitmaps are ~8 MB at 1080p,
// so keep only a small playback window decoded at once.
const DECODED_MAX = 24;
const PREFETCH_AHEAD = 4;

export interface SegmentStatus {
  phase:
    | "idle"
    | "loading-model"
    | "embedding"
    | "segmenting"
    | "baking"
    | "error";
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

interface SegmentBake {
  kind: MaskKind;
  // Derived from the stored keys at commit time (min/max), in the NODE'S
  // scoped-frame space. Provisional zeros while the bake is in flight.
  inFrame: number;
  outFrame: number;
  // Expected frame count, for progress display.
  expected: number;
  masks: Map<number, Blob>;
  bytes: number;
  // False while a bake is in flight — the node ignores the bake (and the
  // overlay locks dot editing) until commit flips this on.
  complete: boolean;
}

interface SegmentSession {
  live: ImageBitmap | null;
  liveKind: MaskKind;
  // Encoder output cached against the upstream image's content hash —
  // dot clicks on an unchanged image only re-run the tiny decoder.
  emb: SamEmbedding | null;
  embKey: string | null;
  bake: SegmentBake | null;
  decoded: Map<number, ImageBitmap>; // insertion order = LRU order
  decodePending: Map<number, Promise<void>>;
  status: SegmentStatus;
  // Bumped whenever the renderable mask data changes (live update, bake
  // commit, free). Folded into the node's fingerprint.
  version: number;
  // The node's own clock — last ctx.frame its compute saw. Written every
  // compute; the bake driver keys masks by it (see header comment).
  scopedFrame: number | null;
  liveRunning: boolean;
  pendingLive: { dots: SegmentDot[]; getBlob: () => Promise<Blob | null> } | null;
}

// globalThis-parked so engine-side and panel-side imports always share one
// store, even across bundler module duplication.
const SESSIONS_KEY = "__toolboxSegmentSessions";
const sessions: Map<string, SegmentSession> = (() => {
  const g = globalThis as Record<string, unknown>;
  let m = g[SESSIONS_KEY] as Map<string, SegmentSession> | undefined;
  if (!m) {
    m = new Map();
    g[SESSIONS_KEY] = m;
  }
  return m;
})();

// Single revision counter + listener list — panels subscribe via
// useSyncExternalStore and re-read session fields on any change.
let storeRev = 0;
const listeners = new Set<() => void>();

export function subscribeSegmentStore(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getSegmentStoreRev(): number {
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

function ensure(nodeId: string): SegmentSession {
  let s = sessions.get(nodeId);
  if (!s) {
    s = {
      live: null,
      liveKind: "alpha",
      emb: null,
      embKey: null,
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
export function peekSegmentSession(nodeId: string): {
  live: ImageBitmap | null;
  liveKind: MaskKind;
  baked: boolean;
  bakeKind: MaskKind;
  bakeRange: { inFrame: number; outFrame: number } | null;
  version: number;
} {
  const s = sessions.get(nodeId);
  const baked = !!s?.bake?.complete;
  return {
    live: s?.live ?? null,
    liveKind: s?.liveKind ?? "alpha",
    baked,
    bakeKind: s?.bake?.kind ?? "alpha",
    bakeRange:
      baked && s?.bake
        ? { inFrame: s.bake.inFrame, outFrame: s.bake.outFrame }
        : null,
    version: s?.version ?? 0,
  };
}

export function getSegmentStatus(nodeId: string): SegmentStatus {
  return sessions.get(nodeId)?.status ?? { phase: "idle" };
}

export function isSegmentLocked(nodeId: string): boolean {
  // Prompt params are locked while a bake exists OR is in flight — editing
  // them under a baked cache would silently desync the two.
  return !!sessions.get(nodeId)?.bake;
}

export function isSegmentBaked(nodeId: string): boolean {
  return !!sessions.get(nodeId)?.bake?.complete;
}

function setStatus(s: SegmentSession, status: SegmentStatus) {
  s.status = status;
  notify();
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
// Live (single-frame) masks
// ---------------------------------------------------------------------

// Install a freshly computed live mask. Shared by the dots flow and the
// auto-mode preview runs in the panel.
export function setLiveMask(
  nodeId: string,
  bitmap: ImageBitmap,
  kind: MaskKind
): void {
  const s = ensure(nodeId);
  s.live?.close();
  s.live = bitmap;
  s.liveKind = kind;
  s.version++;
  setStatus(s, { phase: "idle" });
  bumpPipeline();
}

// Run interactive dot segmentation for the current dots. Latest-wins
// queue: a click that lands while a run is in flight replaces any queued
// request, so rapid dot placement converges on the final dot set without
// piling up stale inferences.
export async function runLiveSegment(
  nodeId: string,
  dots: SegmentDot[],
  getBlob: () => Promise<Blob | null>
): Promise<void> {
  const s = ensure(nodeId);
  if (s.bake) return; // locked — free the bake to edit
  if (dots.length === 0) {
    clearLiveSegment(nodeId);
    return;
  }
  s.pendingLive = { dots, getBlob };
  if (s.liveRunning) return;
  s.liveRunning = true;

  try {
    while (s.pendingLive) {
      const req = s.pendingLive;
      s.pendingLive = null;
      try {
        const seg = await import("./segment");
        const onProgress = (p: SegmentProgress) => {
          if (p.phase === "loading-runtime" || p.phase === "loading-model") {
            setStatus(s, { phase: "loading-model", progress: p.progress });
          }
        };
        const blob = await req.getBlob();
        if (!blob) {
          setStatus(s, {
            phase: "error",
            error:
              "Couldn't read the upstream image — make the Segment node's chain visible on the canvas (select it or set it Active), then click again.",
          });
          continue;
        }
        const key = await seg.blobHash(blob);
        if (!s.emb || s.embKey !== key) {
          setStatus(s, { phase: "embedding" });
          s.emb = await seg.embedImage(blob, onProgress);
          s.embKey = key;
        }
        setStatus(s, { phase: "segmenting" });
        const mask = await seg.decodeDots(s.emb, req.dots);
        const bitmap = await seg.maskToBitmap(mask);
        setLiveMask(nodeId, bitmap, "alpha");
      } catch (e) {
        setStatus(s, {
          phase: "error",
          error: (e as Error)?.message ?? "Segmentation failed.",
        });
      }
    }
  } finally {
    s.liveRunning = false;
  }
}

// Generic single-shot live run for the auto modes (no queueing — the
// panel's button is disabled while busy).
export function setSegmentStatusBusy(
  nodeId: string,
  status: SegmentStatus
): void {
  setStatus(ensure(nodeId), status);
}

export function setSegmentStatusError(nodeId: string, error: string): void {
  setStatus(ensure(nodeId), { phase: "error", error });
}

export function clearLiveSegment(nodeId: string): void {
  const s = sessions.get(nodeId);
  if (!s || !s.live) return;
  s.live.close();
  s.live = null;
  s.version++;
  setStatus(s, { phase: "idle" });
  bumpPipeline();
}

// ---------------------------------------------------------------------
// Bake lifecycle
// ---------------------------------------------------------------------

export function beginBake(
  nodeId: string,
  kind: MaskKind,
  expectedFrames: number
): void {
  const s = ensure(nodeId);
  freeBakeInternal(s);
  s.bake = {
    kind,
    inFrame: 0,
    outFrame: 0,
    expected: expectedFrames,
    masks: new Map(),
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
export function addBakeMask(nodeId: string, frame: number, png: Blob): void {
  const s = ensure(nodeId);
  const bake = s.bake;
  if (!bake) throw new Error("No bake in progress.");
  bake.masks.set(frame, png);
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
    frameDone: bake.masks.size,
    frameTotal: bake.expected,
  });
}

export function commitBake(nodeId: string, warning?: string): void {
  const s = ensure(nodeId);
  const bake = s.bake;
  if (!bake) return;
  if (bake.masks.size === 0) {
    freeBake(nodeId, "Bake produced no frames.");
    return;
  }
  // Authoritative range = the keys actually stored, in the node's own
  // frame space.
  let lo = Infinity;
  let hi = -Infinity;
  for (const f of bake.masks.keys()) {
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

function freeBakeInternal(s: SegmentSession): void {
  s.bake = null;
  for (const bmp of s.decoded.values()) bmp.close();
  s.decoded.clear();
  s.decodePending.clear();
}

// ---------------------------------------------------------------------
// Playback-time mask decode (baked path)
// ---------------------------------------------------------------------

// Peek-only readiness check for fingerprinting — must not touch LRU order.
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
    // Refresh LRU position.
    s.decoded.delete(frame);
    s.decoded.set(frame, bmp);
    return bmp;
  }
  return null;
}

// Kick an async PNG → ImageBitmap decode for a baked frame. Resolves when
// the bitmap is stored (the offline exporter awaits this via the media-
// settle queue); realtime playback gets a pipeline-bump instead.
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

// Warm the next few frames' bitmaps. Called on decode MISSES (above) and
// on HITS (from the node's compute) — without the hit-path warm-up,
// sequential playback would drain the prefetched window and hitch every
// PREFETCH_AHEAD frames.
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
  s: SegmentSession,
  frame: number,
  bump: boolean
): Promise<void> {
  if (s.decoded.has(frame)) return Promise.resolve();
  const pending = s.decodePending.get(frame);
  if (pending) {
    // A prefetch-started decode doesn't bump on landing; if a render is
    // now waiting on this frame (paused scrub), chain a bump so the
    // canvas refreshes when it arrives. Bumps are rAF-coalesced upstream.
    return bump ? pending.then(() => bumpPipeline()) : pending;
  }
  const blob = s.bake?.masks.get(frame);
  if (!blob) return Promise.resolve();

  // Index masks carry slot IDs in their pixel values — disable color
  // management so the PNG round-trip is exact (harmless for alpha masks).
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
      // uploaded mask texture, so playback degrades instead of breaking.
    })
    .finally(() => {
      s.decodePending.delete(frame);
    });
  s.decodePending.set(frame, p);
  return p;
}
