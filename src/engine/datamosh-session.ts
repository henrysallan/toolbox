// Session-only state for Datamosh nodes. Modeled on lib/ai/depth-session.ts
// (the proven per-frame bake store), generalized to THREE strips:
//
//   clipA / clipB — the two input clips, frame-stepped into PNG strips by the
//                   panel's "Bake" buttons (captureNodeFrames over each input's
//                   upstream). Indexed strip-local 0..count-1.
//   output        — the moshed result. Produced by the panel's "Mosh" build,
//                   which frame-steps THIS node (captureNodeFrames on its own id)
//                   while compute() runs the flow advection live; each rendered
//                   frame is read back and stored. Keyed by the node's scoped
//                   frame (the depth-session keying invariant — see below).
//
// All three are DELIBERATELY session-only: the timeline placement + engine
// params serialize with the project, the baked frames don't (reopen → re-bake).
// The store is parked on globalThis so the React panel (writer) and the node's
// compute (reader) share one instance across any bundler module duplication.
//
// FRAME KEYING — the output strip is keyed by the node's OWN clock (the
// layer-scoped ctx.frame its compute sees), not the global timeline frame, so a
// node inside an offset layer looks frames up where it stored them. compute()
// publishes its scoped frame every eval via recordScopedFrame; the Mosh build
// reads it back per captured frame via getScopedFrame. Input strips need no such
// bridge — they're raw captured footage indexed from zero and positioned by the
// timeline params.

export type StripName = "A" | "B" | "out";

// Hard ceiling across ALL datamosh strips of ALL nodes. Two input clips + one
// output strip of PNG frames; a pathological range aborts instead of eating the
// tab's memory.
export const MAX_BAKE_BYTES = 768 * 1024 * 1024;

// Decoded-bitmap LRU per strip — full-res RGBA bitmaps are ~8 MB at 1080p, so
// keep a small window decoded. The flow build needs only the current step's two
// source frames at a time, so a modest window covers playback + build.
const DECODED_MAX = 32;
const PREFETCH_AHEAD = 4;

export interface DatamoshStatus {
  phase: "idle" | "baking-a" | "baking-b" | "moshing" | "error";
  frameDone?: number;
  frameTotal?: number;
  error?: string;
  warning?: string;
}

interface Strip {
  frames: Map<number, Blob>;
  bytes: number;
  // Authoritative frame count, set at commit (max key + 1 for input strips,
  // which are dense 0..n-1; for output, derived range).
  count: number;
  // For the output strip: min/max scoped key actually stored.
  inFrame: number;
  outFrame: number;
  // False while a bake is in flight — readers ignore the strip until commit.
  complete: boolean;
}

interface StripCaches {
  decoded: Map<number, ImageBitmap>; // insertion order = LRU order
  decodePending: Map<number, Promise<void>>;
}

interface DatamoshSession {
  strips: Record<StripName, Strip | null>;
  caches: Record<StripName, StripCaches>;
  status: DatamoshStatus;
  // Bumped whenever a strip changes (commit / free). Folded into the node's
  // fingerprint so a static graph caches as a constant.
  version: number;
  // The node's own clock — last ctx.frame its compute saw. The Mosh build keys
  // output frames by it (see FRAME KEYING).
  scopedFrame: number | null;
}

const SESSIONS_KEY = "__toolboxDatamoshSessions";
const sessions: Map<string, DatamoshSession> = (() => {
  const g = globalThis as Record<string, unknown>;
  let m = g[SESSIONS_KEY] as Map<string, DatamoshSession> | undefined;
  if (!m) {
    m = new Map();
    g[SESSIONS_KEY] = m;
  }
  return m;
})();

let storeRev = 0;
const listeners = new Set<() => void>();

export function subscribeDatamoshStore(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getDatamoshStoreRev(): number {
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

function newCaches(): StripCaches {
  return { decoded: new Map(), decodePending: new Map() };
}

function ensure(nodeId: string): DatamoshSession {
  let s = sessions.get(nodeId);
  if (!s) {
    s = {
      strips: { A: null, B: null, out: null },
      caches: { A: newCaches(), B: newCaches(), out: newCaches() },
      status: { phase: "idle" },
      version: 0,
      scopedFrame: null,
    };
    sessions.set(nodeId, s);
  }
  return s;
}

function setStatus(s: DatamoshSession, status: DatamoshStatus) {
  s.status = status;
  notify();
}

export function getDatamoshStatus(nodeId: string): DatamoshStatus {
  return sessions.get(nodeId)?.status ?? { phase: "idle" };
}

export function setDatamoshStatusBusy(
  nodeId: string,
  status: DatamoshStatus
): void {
  setStatus(ensure(nodeId), status);
}

export function setDatamoshError(nodeId: string, error: string): void {
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
// Read-only access for the node's compute / fingerprint (no allocation)
// ---------------------------------------------------------------------

export interface DatamoshPeek {
  aCount: number; // 0 if A not baked
  bCount: number;
  outComplete: boolean;
  outRange: { inFrame: number; outFrame: number } | null;
  version: number;
}

export function peekDatamosh(nodeId: string): DatamoshPeek {
  const s = sessions.get(nodeId);
  const a = s?.strips.A;
  const b = s?.strips.B;
  const out = s?.strips.out;
  return {
    aCount: a?.complete ? a.count : 0,
    bCount: b?.complete ? b.count : 0,
    outComplete: !!out?.complete,
    outRange: out?.complete
      ? { inFrame: out.inFrame, outFrame: out.outFrame }
      : null,
    version: s?.version ?? 0,
  };
}

export function stripCount(nodeId: string, strip: StripName): number {
  const st = sessions.get(nodeId)?.strips[strip];
  return st?.complete ? st.count : 0;
}

export function isInputBaked(nodeId: string): boolean {
  const s = sessions.get(nodeId);
  return !!s?.strips.A?.complete && !!s?.strips.B?.complete;
}

export function isMoshed(nodeId: string): boolean {
  return !!sessions.get(nodeId)?.strips.out?.complete;
}

// Re-baking inputs or editing the timeline/engine while a mosh exists would
// desync the output cache, so the panel locks those until the mosh is freed.
export function isMoshLocked(nodeId: string): boolean {
  return isMoshed(nodeId);
}

// ---------------------------------------------------------------------
// Bake lifecycle (shared across the three strips)
// ---------------------------------------------------------------------

function statusForBake(strip: StripName): DatamoshStatus["phase"] {
  return strip === "A" ? "baking-a" : strip === "B" ? "baking-b" : "moshing";
}

export function beginStripBake(
  nodeId: string,
  strip: StripName,
  expectedFrames: number
): void {
  const s = ensure(nodeId);
  freeStripInternal(s, strip);
  s.strips[strip] = {
    frames: new Map(),
    bytes: 0,
    count: 0,
    inFrame: 0,
    outFrame: 0,
    complete: false,
  };
  setStatus(s, {
    phase: statusForBake(strip),
    frameDone: 0,
    frameTotal: expectedFrames,
  });
}

function totalBakeBytes(): number {
  let sum = 0;
  for (const s of sessions.values()) {
    for (const st of Object.values(s.strips)) sum += st?.bytes ?? 0;
  }
  return sum;
}

// Store one baked frame. For input strips `key` is the strip-local index; for
// the output strip it's the node's scoped frame. Throws over the global budget.
export function addStripFrame(
  nodeId: string,
  strip: StripName,
  key: number,
  png: Blob
): void {
  const s = ensure(nodeId);
  const st = s.strips[strip];
  if (!st) throw new Error("No bake in progress.");
  st.frames.set(key, png);
  st.bytes += png.size;
  if (totalBakeBytes() > MAX_BAKE_BYTES) {
    throw new Error(
      `Datamosh cache exceeded ${Math.round(
        MAX_BAKE_BYTES / (1024 * 1024)
      )} MB — try a shorter range or a lower canvas resolution.`
    );
  }
  setStatus(s, {
    phase: statusForBake(strip),
    frameDone: st.frames.size,
    frameTotal: Math.max(st.frames.size, s.status.frameTotal ?? 0),
  });
}

export function commitStripBake(
  nodeId: string,
  strip: StripName,
  warning?: string
): void {
  const s = ensure(nodeId);
  const st = s.strips[strip];
  if (!st) return;
  if (st.frames.size === 0) {
    freeStrip(nodeId, strip, "Bake produced no frames.");
    return;
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const k of st.frames.keys()) {
    if (k < lo) lo = k;
    if (k > hi) hi = k;
  }
  st.inFrame = lo;
  st.outFrame = hi;
  st.count = hi - lo + 1;
  st.complete = true;
  s.version++;
  setStatus(s, warning ? { phase: "idle", warning } : { phase: "idle" });
  bumpPipeline();
}

export function freeStrip(
  nodeId: string,
  strip: StripName,
  error?: string
): void {
  const s = sessions.get(nodeId);
  if (!s) return;
  freeStripInternal(s, strip);
  s.version++;
  setStatus(s, error ? { phase: "error", error } : { phase: "idle" });
  bumpPipeline();
}

// Freeing the output ("Free Mosh") leaves the input strips intact so the user
// can re-mosh with different params without re-baking the clips.
export function freeOutput(nodeId: string): void {
  freeStrip(nodeId, "out");
}

export function freeAll(nodeId: string): void {
  const s = sessions.get(nodeId);
  if (!s) return;
  freeStripInternal(s, "A");
  freeStripInternal(s, "B");
  freeStripInternal(s, "out");
  s.version++;
  setStatus(s, { phase: "idle" });
  bumpPipeline();
}

function freeStripInternal(s: DatamoshSession, strip: StripName): void {
  s.strips[strip] = null;
  const c = s.caches[strip];
  for (const bmp of c.decoded.values()) bmp.close();
  c.decoded.clear();
  c.decodePending.clear();
  // Freeing an input invalidates the output (it was built from those frames).
  if (strip !== "out") freeStripInternal(s, "out");
}

// ---------------------------------------------------------------------
// Playback-time decode
// ---------------------------------------------------------------------

// Raw PNG blob for a strip frame (no decode). The codec engine reads input
// frames this way to re-encode them through ffmpeg.
export function getStripBlob(
  nodeId: string,
  strip: StripName,
  frame: number
): Blob | null {
  return sessions.get(nodeId)?.strips[strip]?.frames.get(frame) ?? null;
}

export function hasDecoded(
  nodeId: string,
  strip: StripName,
  frame: number
): boolean {
  return !!sessions.get(nodeId)?.caches[strip].decoded.has(frame);
}

export function getDecoded(
  nodeId: string,
  strip: StripName,
  frame: number
): ImageBitmap | null {
  const s = sessions.get(nodeId);
  if (!s) return null;
  const c = s.caches[strip];
  const bmp = c.decoded.get(frame);
  if (bmp) {
    c.decoded.delete(frame);
    c.decoded.set(frame, bmp);
    return bmp;
  }
  return null;
}

// Kick an async PNG → ImageBitmap decode. Resolves when stored (offline export
// awaits this via the media-settle queue); realtime playback gets a bump.
export function requestDecode(
  nodeId: string,
  strip: StripName,
  frame: number
): Promise<void> {
  const s = sessions.get(nodeId);
  const st = s?.strips[strip];
  if (!s || !st?.complete) return Promise.resolve();
  const p = decodeOne(s, strip, frame, true);
  prefetchDecodes(nodeId, strip, frame);
  return p;
}

export function prefetchDecodes(
  nodeId: string,
  strip: StripName,
  frame: number
): void {
  const s = sessions.get(nodeId);
  const st = s?.strips[strip];
  if (!s || !st?.complete) return;
  const last = Math.min(frame + PREFETCH_AHEAD, st.outFrame);
  for (let f = frame + 1; f <= last; f++) void decodeOne(s, strip, f, false);
}

function decodeOne(
  s: DatamoshSession,
  strip: StripName,
  frame: number,
  bump: boolean
): Promise<void> {
  const c = s.caches[strip];
  if (c.decoded.has(frame)) return Promise.resolve();
  const pending = c.decodePending.get(frame);
  if (pending) return bump ? pending.then(() => bumpPipeline()) : pending;
  const blob = s.strips[strip]?.frames.get(frame);
  if (!blob) return Promise.resolve();

  // Color footage — straight alpha to match the engine's non-premultiplied
  // convention; leave colorspace conversion at the default (we want display
  // color, unlike depth's raw-byte round-trip).
  const p = createImageBitmap(blob, { premultiplyAlpha: "none" })
    .then((bmp) => {
      if (!s.strips[strip]) {
        bmp.close();
        return;
      }
      c.decoded.set(frame, bmp);
      while (c.decoded.size > DECODED_MAX) {
        const oldest = c.decoded.keys().next().value as number;
        c.decoded.get(oldest)?.close();
        c.decoded.delete(oldest);
      }
      if (bump) bumpPipeline();
    })
    .catch(() => {
      // Leave the frame missing — compute degrades to the last good texture.
    })
    .finally(() => {
      c.decodePending.delete(frame);
    });
  c.decodePending.set(frame, p);
  return p;
}
