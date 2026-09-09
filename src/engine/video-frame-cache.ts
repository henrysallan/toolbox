// Decoded-frame cache for the Video Source paused path — the bookkeeping
// half of specdocs/090426_video-frame-cache.md. Pure and GL-free on
// purpose: the payload is opaque (the node stores WebGLTextures; the
// offline check stores plain objects), so the byte-budgeted LRU, the
// timestamp lookup, the decode-window planner and the draw planner can all
// be exercised by scripts/check-video-frame-cache.mts without a browser.
//
// Why a cache at all: a <video> element re-decodes from the previous
// keyframe on every currentTime write, in both directions, even for a
// one-frame step — 40–240 ms per landed frame on long-GOP sources (audit:
// specdocs/090426_video-scrub-audit.md F2). WebCodecs decodes *forward*
// through a GOP at 0.3–1.4 ms/frame and a decoded frame uploads to GL in
// ~0.5 ms, so the win is not "decode the target frame", it is "decode a
// window around the target once and keep it": every frame inside a cached
// window is then a texture bind in either direction.

// One cached frame. `ts` is media time in seconds with the track's first
// frame at 0 — the same origin as HTMLMediaElement.currentTime — so the
// node can look frames up by the target it computes for the element.
export interface FrameEntry<P> {
  ts: number;
  dur: number;
  // Stored pixel size (post-rotation, possibly downscaled). The node's fit
  // math only needs the aspect.
  w: number;
  h: number;
  // True when the frame was stored at full source resolution. A downscaled
  // frame is a scrub proxy: the node still chases it with the element so
  // the picture refines to full quality once the playhead rests.
  exact: boolean;
  bytes: number;
  payload: P;
}

// Cache textures are RGBA8; cap the stored long side so a 4K source keeps
// a useful window inside the byte budget (4K RGBA8 is 33 MB a frame — 15
// frames per 512 MB; at 1920 it is 8.3 MB — 61 frames). Sources at or
// below the cap are stored exact.
export const VIDEO_CACHE_MAX_DIM = 1920;
// Same budget as the image-sequence cache in nodes/source/video.ts.
export const VIDEO_CACHE_BYTES = 512 * 1024 * 1024;

// Lookup tolerance: decoder timestamps come from integer timescales, the
// node's target from float scene time — a quarter of a 240 fps frame.
const TS_EPS = 1 / 960;

export class FrameCache<P> {
  private entries = new Map<number, FrameEntry<P>>();
  // Timestamps ascending — binary-searched by lookup()/nearest().
  private order: number[] = [];
  // Timestamps, least-recently used first.
  private lru: number[] = [];
  totalBytes = 0;

  constructor(
    readonly budgetBytes: number,
    private readonly release: (payload: P) => void
  ) {}

  get size(): number {
    return this.entries.size;
  }

  has(ts: number): boolean {
    return this.entries.has(ts);
  }

  // Insert (or replace) a frame and evict least-recently-used frames past
  // the budget — never the frame just inserted, and never `protect` (the
  // frame currently on screen), so a window larger than the budget still
  // leaves the playhead's frame resident.
  insert(entry: FrameEntry<P>, protect?: number): void {
    const prev = this.entries.get(entry.ts);
    if (prev) {
      this.release(prev.payload);
      this.totalBytes -= prev.bytes;
      this.removeFrom(this.lru, entry.ts);
    } else {
      this.insertSorted(entry.ts);
    }
    this.entries.set(entry.ts, entry);
    this.totalBytes += entry.bytes;
    this.lru.push(entry.ts);
    this.evict(entry.ts, protect);
  }

  // The frame covering media time `t`: last ts ≤ t with t < ts + dur.
  lookup(t: number): FrameEntry<P> | null {
    const i = this.lastAtOrBefore(t + TS_EPS);
    if (i < 0) return null;
    const e = this.entries.get(this.order[i])!;
    return t < e.ts + e.dur + TS_EPS ? e : null;
  }

  // The cached frame whose start is closest to `t`, within `maxDist`
  // seconds, or null. What the node draws while a window decodes so a fast
  // drag shows motion instead of a frozen picture.
  nearest(t: number, maxDist: number): FrameEntry<P> | null {
    const i = this.lastAtOrBefore(t);
    let best: FrameEntry<P> | null = null;
    let bestD = maxDist;
    if (i >= 0) {
      const e = this.entries.get(this.order[i])!;
      const d = t - e.ts;
      if (d <= bestD) {
        best = e;
        bestD = d;
      }
    }
    if (i + 1 < this.order.length) {
      const e = this.entries.get(this.order[i + 1])!;
      const d = e.ts - t;
      if (d < bestD) best = e;
    }
    return best;
  }

  // Mark a frame as just used so eviction takes something else first.
  touch(ts: number): void {
    if (!this.entries.has(ts)) return;
    this.removeFrom(this.lru, ts);
    this.lru.push(ts);
  }

  clear(): void {
    for (const e of this.entries.values()) this.release(e.payload);
    this.entries.clear();
    this.order.length = 0;
    this.lru.length = 0;
    this.totalBytes = 0;
  }

  private evict(keep: number, protect?: number): void {
    let guard = this.lru.length;
    while (this.totalBytes > this.budgetBytes && this.lru.length > 1 && guard-- > 0) {
      const victim = this.lru[0];
      if (victim === keep || victim === protect) {
        // Rotate the protected entry to the back and keep looking.
        this.lru.shift();
        this.lru.push(victim);
        continue;
      }
      this.lru.shift();
      const e = this.entries.get(victim);
      if (!e) continue;
      this.release(e.payload);
      this.totalBytes -= e.bytes;
      this.entries.delete(victim);
      this.removeFrom(this.order, victim);
    }
  }

  private lastAtOrBefore(t: number): number {
    let lo = 0;
    let hi = this.order.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.order[mid] <= t) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  private insertSorted(ts: number): void {
    const i = this.lastAtOrBefore(ts);
    this.order.splice(i + 1, 0, ts);
  }

  private removeFrom(arr: number[], ts: number): void {
    const at = arr.indexOf(ts);
    if (at >= 0) arr.splice(at, 1);
  }
}

// ── Decode-window planning ─────────────────────────────────────────────
// A cache miss decodes a window of frames around the target rather than
// the target alone. The window leans in the direction the playhead is
// moving: forward drags want frames ahead (the job outruns the pointer at
// ~0.5 ms/frame), backward drags want frames behind (each new window
// restarts at a keyframe, so make the restart pay for many steps).
export const WINDOW_NEAR = 0.25;
export const WINDOW_FAR = 1.0;

export function planWindow(
  target: number,
  lastTarget: number | null,
  duration: number
): { start: number; end: number } {
  const backward = lastTarget != null && target < lastTarget;
  const behind = backward ? WINDOW_FAR : WINDOW_NEAR;
  const ahead = backward ? WINDOW_NEAR : WINDOW_FAR;
  const start = Math.max(0, target - behind);
  const end = Math.min(Math.max(duration, target + 0.001), target + ahead);
  return { start, end };
}

// A forward target this far ahead of a running job's cursor is followed
// (the decoder outruns any drag); further than that, restarting at the
// target's keyframe is cheaper than decoding the gap.
export const MAX_FOLLOW = 2.0;

// The live part of a decode job that the accept/slide rules read.
export interface JobWindow {
  start: number;
  // Exclusive stop timestamp — slides forward on forward jobs.
  limit: number;
  // Last decoded timestamp (-Infinity before the first frame).
  cursor: number;
  backward: boolean;
}

// Can a running job serve `target` without restarting? A job only ever
// moves forward, so anything at or behind its cursor needs a new job.
// Forward jobs follow the pointer up to MAX_FOLLOW ahead of the cursor;
// backward jobs (fixed limit) serve only what their window still holds.
export function jobAccepts(job: JobWindow, target: number): boolean {
  if (target <= job.cursor) return false;
  if (job.backward) return target >= job.start && target < job.limit;
  return target - job.cursor <= MAX_FOLLOW;
}

// New stop timestamp after accepting `target`: forward jobs keep decoding
// WINDOW_FAR past the newest target; backward jobs keep their window.
export function slideLimit(job: JobWindow, target: number): number {
  return job.backward ? job.limit : Math.max(job.limit, target + WINDOW_FAR);
}

// Whole-GOP windows when affordable: decoding from the keyframe is paid
// anyway, so if the GOP's textures fit in half the budget, keep all of them
// — every frame of a 1–2 s camera GOP is then a hit in both directions.
export const GOP_BUDGET_FRACTION = 0.5;

export function widenToGop(
  win: { start: number; end: number },
  gop: { start: number; end: number } | null,
  fps: number,
  bytesPerFrame: number,
  budgetBytes: number
): { start: number; end: number } {
  if (!gop || !(fps > 0) || gop.end <= gop.start) return win;
  const frames = Math.ceil((gop.end - gop.start) * fps);
  if (frames * bytesPerFrame > budgetBytes * GOP_BUDGET_FRACTION) return win;
  return {
    start: Math.min(win.start, gop.start),
    end: Math.max(win.end, gop.end),
  };
}

// ── Image-sequence decode-ahead ────────────────────────────────────────
// Timeline frames to decode around `frame`, nearest first, leaning in the
// drag direction. Loop-aware; clipped to [0, length) otherwise.
export const SEQ_AHEAD = 24;
export const SEQ_BEHIND = 4;

export function planSeqWindow(
  frame: number,
  lastFrame: number | null,
  length: number,
  loop: boolean,
  ahead = SEQ_AHEAD,
  behind = SEQ_BEHIND
): number[] {
  if (length <= 1) return [];
  const backward = lastFrame != null && frame < lastFrame;
  // The leading side (the way the drag is going) gets `ahead` frames,
  // the trailing side `behind`.
  const dir = backward ? -1 : 1;
  const out: number[] = [];
  const push = (f: number) => {
    if (loop) {
      out.push(((f % length) + length) % length);
    } else if (f >= 0 && f < length) {
      out.push(f);
    }
  };
  // Interleave so the nearest frames on the leading side come first but
  // the trailing side is not starved.
  const n = Math.max(ahead, behind);
  for (let d = 1; d <= n; d++) {
    if (d <= ahead) push(frame + dir * d);
    if (d <= behind) push(frame - dir * d);
  }
  // Loop wrap can revisit the playhead's own frame on tiny sequences.
  return out.filter((f, i) => f !== frame && out.indexOf(f) === i);
}

// ── Draw planning ──────────────────────────────────────────────────────
// The node decides ONCE per eval what it draws on the paused path, and the
// fingerprint stamps that decision — the whole point of the stamp is that
// a media frame can change without scene time changing. Fingerprints are
// computed before compute runs, so this function must be a pure read of
// the state compute will see (it is called from both).
export interface DrawProbe<P> {
  // Media time wanted (the element target: scene time × speed + offset,
  // looped/clamped).
  target: number;
  // Media time the element texture holds AFTER this eval's upload — the
  // node uploads before it seeks, and uploads whenever the element is not
  // seeking and has data, so this is currentTime when uploadable and the
  // last uploaded time otherwise (-1 before any upload). Probing it this
  // way is what lets the fingerprint (computed before compute) and
  // compute agree on the drawn frame.
  elementTexTime: number;
  // The element has a seek in flight right now.
  elementSeeking: boolean;
  // Milliseconds since this node's target last changed — the park timer.
  restingMs: number;
  // Decoder is up and frames can be cached for this source.
  cacheReady: boolean;
  // Cached frames for this source are full resolution (not proxies).
  cacheExact: boolean;
  hit: FrameEntry<P> | null;
  nearest: FrameEntry<P> | null;
}

export interface DrawPlan<P> {
  src: "cache" | "element" | "none";
  // Identity of the drawn frame: the cache entry's ts, or the media time
  // the element texture holds. NaN for "none".
  ts: number;
  entry: FrameEntry<P> | null;
  // Issue the (coalesced) element seek toward target — the picture is a
  // proxy or stale and the element can refine it.
  chase: boolean;
  // Start/continue a decode window around target.
  kick: boolean;
  // The playhead has rested and the element is not at the target: issue
  // the coalesced seek anyway so play starts instantly and proxies refine.
  park: boolean;
}

// Rest this long before the element is parked at the playhead.
export const PARK_AFTER_MS = 300;
// While playing, the element texture further than this from the target
// means a hard seek is in flight — the cache may cover for it.
export const PLAYING_CATCHUP = 0.3;

// Half a 120 fps frame: "the element is at the target".
export const ELEMENT_EPS = 1 / 240;
// How far a nearest-neighbour proxy frame may be from the target before
// the node prefers the element's (stale) texture.
export const NEAREST_MAX = 0.5;

export function planPausedDraw<P>(p: DrawProbe<P>): DrawPlan<P> {
  const elementExact =
    p.elementTexTime >= 0 &&
    Math.abs(p.elementTexTime - p.target) <= ELEMENT_EPS;
  const plan = planPausedCore(p, elementExact);
  // Park: the drag has stopped, the element is elsewhere, nothing is
  // already asking it to move — one coalesced seek positions it under the
  // playhead (instant play) and lets a proxy frame refine to full quality.
  plan.park =
    !plan.chase && !elementExact && p.restingMs >= PARK_AFTER_MS;
  return plan;
}

function planPausedCore<P>(p: DrawProbe<P>, elementExact: boolean): DrawPlan<P> {
  const elementFallback = (): DrawPlan<P> =>
    p.elementTexTime >= 0
      ? {
          src: "element",
          ts: p.elementTexTime,
          entry: null,
          chase: !elementExact,
          kick: p.cacheReady,
          park: false,
        }
      : {
          src: "none",
          ts: NaN,
          entry: null,
          chase: true,
          kick: p.cacheReady,
          park: false,
        };

  if (!p.cacheReady) return elementFallback();

  // Exact cache frame, or a proxy the element cannot beat right now.
  if (p.hit && (p.hit.exact || !elementExact)) {
    return {
      src: "cache",
      ts: p.hit.ts,
      entry: p.hit,
      chase: !p.hit.exact,
      kick: false,
      park: false,
    };
  }
  if (elementExact) {
    // The element already shows the target; fill the window around it in
    // the background so the next step is a bind.
    return {
      src: "element",
      ts: p.target,
      entry: null,
      chase: false,
      kick: !p.hit,
      park: false,
    };
  }
  if (p.nearest) {
    return {
      src: "cache",
      ts: p.nearest.ts,
      entry: p.nearest,
      chase: !p.cacheExact,
      kick: true,
      park: false,
    };
  }
  // Cold miss: show whatever the element holds, decode a window, and let
  // the element race only when the cache can never be exact.
  const fb = elementFallback();
  return { ...fb, chase: fb.chase && !p.cacheExact, kick: true };
}

// While PLAYING the element owns the picture — except while it is catching
// up after a hard seek (play pressed after a scrub, a loop wrap, a layer
// cut): then a cached frame at the target beats the stale element texture.
// Steady playback never flips sources, so proxies never flash at half res.
export function planPlayingDraw<P>(p: {
  target: number;
  elementTexTime: number;
  elementSeeking: boolean;
  hit: FrameEntry<P> | null;
}): DrawPlan<P> {
  const catchingUp =
    p.elementSeeking ||
    p.elementTexTime < 0 ||
    Math.abs(p.elementTexTime - p.target) > PLAYING_CATCHUP;
  if (p.hit && catchingUp) {
    return {
      src: "cache",
      ts: p.hit.ts,
      entry: p.hit,
      chase: false,
      kick: false,
      park: false,
    };
  }
  return p.elementTexTime >= 0
    ? { src: "element", ts: p.elementTexTime, entry: null, chase: false, kick: false, park: false }
    : { src: "none", ts: NaN, entry: null, chase: false, kick: false, park: false };
}

// The fingerprint segment for a plan — what downstream caches key on.
export function drawPlanStamp<P>(plan: DrawPlan<P>): string {
  if (plan.src === "none") return "vf:-";
  return `vf:${plan.src === "cache" ? "c" : "e"}:${plan.ts.toFixed(4)}`;
}
