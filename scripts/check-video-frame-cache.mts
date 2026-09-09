// Guards the pure half of the Video Source frame cache
// (src/engine/video-frame-cache.ts, spec 090426_video-frame-cache.md):
// the byte-budgeted LRU + timestamp lookup, the decode-window planner, and
// the paused-path draw planner whose decision the node fingerprint stamps.
// The mediabunny/GL half is browser-only and is verified live.
//
// Run: tsx scripts/check-video-frame-cache.mts
import {
  ELEMENT_EPS,
  FrameCache,
  GOP_BUDGET_FRACTION,
  MAX_FOLLOW,
  NEAREST_MAX,
  PARK_AFTER_MS,
  PLAYING_CATCHUP,
  WINDOW_FAR,
  WINDOW_NEAR,
  drawPlanStamp,
  jobAccepts,
  planPausedDraw,
  planPlayingDraw,
  planSeqWindow,
  planWindow,
  slideLimit,
  widenToGop,
  type DrawProbe,
  type FrameEntry,
  type JobWindow,
} from "../src/engine/video-frame-cache";

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (!cond) {
    failures++;
    console.error("  FAIL:", msg);
  }
}

const FPS = 30;
const DUR = 1 / FPS;
type Tex = { id: number };
let released: number[] = [];
function entry(frame: number, exact = true, bytes = 100): FrameEntry<Tex> {
  return {
    ts: frame / FPS,
    dur: DUR,
    w: exact ? 1920 : 960,
    h: exact ? 1080 : 540,
    exact,
    bytes,
    payload: { id: frame },
  };
}
function makeCache(budget = 1000): FrameCache<Tex> {
  released = [];
  return new FrameCache<Tex>(budget, (p) => released.push(p.id));
}

// ── 1. lookup / nearest ────────────────────────────────────────────────
{
  const c = makeCache();
  for (const f of [10, 11, 12, 20]) c.insert(entry(f));
  check(c.lookup(10 / FPS)?.payload.id === 10, "lookup exact start");
  check(c.lookup(10.5 / FPS)?.payload.id === 10, "lookup mid-frame");
  check(c.lookup(12.99 / FPS)?.payload.id === 12, "lookup last frame of run");
  check(c.lookup(13.5 / FPS) === null, "gap after run is a miss");
  check(c.lookup(9 / FPS) === null, "before first frame is a miss");
  // float slop: a scene-time target a hair before the frame boundary
  check(c.lookup(11 / FPS - 1e-7)?.payload.id === 11, "tolerance at boundary");
  check(c.nearest(15 / FPS, 0.5)?.payload.id === 12, "nearest picks closer side");
  check(c.nearest(17 / FPS, 0.5)?.payload.id === 20, "nearest picks the frame ahead");
  check(c.nearest(40 / FPS, 0.5) === null, "nearest respects maxDist");
  check(c.nearest(5 / FPS, 0.5)?.payload.id === 10, "nearest before first frame");
  console.log("lookup / nearest ok");
}

// ── 2. budget + eviction ───────────────────────────────────────────────
{
  const c = makeCache(350); // 3 frames of 100 fit, the 4th evicts
  c.insert(entry(1));
  c.insert(entry(2));
  c.insert(entry(3));
  c.touch(1 / FPS); // frame 1 is now most-recent; frame 2 is the LRU
  c.insert(entry(4));
  check(released.length === 1 && released[0] === 2, `evicts LRU (released ${released})`);
  check(c.size === 3 && c.totalBytes === 300, "size/bytes after eviction");
  // protect: the on-screen frame survives even when it is the LRU
  c.insert(entry(5), 3 / FPS);
  check(!released.includes(3), "protected frame not evicted");
  check(c.has(3 / FPS), "protected frame still resident");
  // replacing an existing ts releases the old payload, keeps bytes right
  const before = c.totalBytes;
  c.insert({ ...entry(5), bytes: 120, payload: { id: 55 } });
  check(released.includes(5), "replace releases the old payload");
  check(c.totalBytes === before + 20, "replace adjusts bytes");
  // a single oversized frame is kept (never evict the last entry)
  const big = makeCache(50);
  big.insert(entry(7, true, 500));
  check(big.size === 1 && big.has(7 / FPS), "oversized lone frame kept");
  big.insert(entry(8, true, 500));
  check(big.size === 1 && big.has(8 / FPS) && released.includes(7), "oversized: newest wins");
  big.clear();
  check(big.size === 0 && big.totalBytes === 0 && released.includes(8), "clear releases everything");
  console.log("budget / eviction ok");
}

// ── 3. decode-window planner ───────────────────────────────────────────
{
  const fwd = planWindow(5, 4.5, 60);
  check(
    Math.abs(fwd.start - (5 - WINDOW_NEAR)) < 1e-9 && Math.abs(fwd.end - (5 + WINDOW_FAR)) < 1e-9,
    "forward drag leans ahead"
  );
  const back = planWindow(5, 5.5, 60);
  check(
    Math.abs(back.start - (5 - WINDOW_FAR)) < 1e-9 && Math.abs(back.end - (5 + WINDOW_NEAR)) < 1e-9,
    "backward drag leans behind"
  );
  const cold = planWindow(5, null, 60);
  check(Math.abs(cold.end - (5 + WINDOW_FAR)) < 1e-9, "no history = forward");
  const head = planWindow(0.1, null, 60);
  check(head.start === 0, "window clamps at 0");
  const tail = planWindow(59.9, 59, 60);
  check(tail.end <= 60 && tail.end > 59.9, "window clamps at duration");
  console.log("window planner ok");
}

// ── 4. draw planner + stamp ────────────────────────────────────────────
{
  const T = 100 / FPS;
  const base = (over: Partial<DrawProbe<Tex>>): DrawProbe<Tex> => ({
    target: T,
    elementTexTime: -1,
    elementSeeking: false,
    restingMs: 0,
    cacheReady: true,
    cacheExact: true,
    hit: null,
    nearest: null,
    ...over,
  });

  // No decoder: the element path as before the cache existed.
  let p = planPausedDraw(base({ cacheReady: false, elementTexTime: 2 }));
  check(p.src === "element" && p.chase && !p.kick, "no decoder → element, chase, no kick");
  p = planPausedDraw(
    base({ cacheReady: false, elementTexTime: T })
  );
  check(p.src === "element" && !p.chase && p.ts === T, "no decoder, element at target → no chase");
  p = planPausedDraw(base({ cacheReady: false }));
  check(p.src === "none" && p.chase, "no decoder, nothing uploaded → none + chase");

  // Exact cache hit wins outright — the element is left parked.
  const hit = entry(100);
  p = planPausedDraw(
    base({ hit, elementTexTime: 3 })
  );
  check(p.src === "cache" && p.entry === hit && !p.chase && !p.kick, "exact hit → cache, no chase");

  // Proxy hit: draw it, but keep chasing with the element…
  const proxy = entry(100, false);
  p = planPausedDraw(base({ hit: proxy, cacheExact: false }));
  check(p.src === "cache" && p.chase && !p.kick, "proxy hit → cache + chase");
  // …until the element is at the target, which then wins.
  p = planPausedDraw(
    base({ hit: proxy, cacheExact: false, elementTexTime: T })
  );
  check(p.src === "element" && p.ts === T && !p.chase, "proxy hit, element at target → element");

  // Element at target with no cache frame: draw it and fill the window.
  p = planPausedDraw(base({ elementTexTime: T }));
  check(p.src === "element" && p.kick && !p.chase, "element at target, miss → element + kick");

  // Miss with a neighbour: draw the neighbour, decode, no chase when exact-capable.
  const near = entry(97);
  p = planPausedDraw(base({ nearest: near, elementTexTime: 1 }));
  check(p.src === "cache" && p.entry === near && p.kick && !p.chase, "nearest → cache + kick");
  p = planPausedDraw(base({ nearest: near, cacheExact: false }));
  check(p.src === "cache" && p.chase, "nearest on a proxy source → chase too");

  // Cold miss: element's stale texture, decode window, chase only for proxies.
  p = planPausedDraw(base({ elementTexTime: 1 }));
  check(p.src === "element" && p.ts === 1 && p.kick && !p.chase, "cold miss, exact-capable → stale element, kick, no chase");
  p = planPausedDraw(base({ elementTexTime: 1, cacheExact: false }));
  check(p.src === "element" && p.kick && p.chase, "cold miss on proxy source → chase");
  p = planPausedDraw(base({}));
  check(p.src === "none" && p.kick, "cold miss, nothing uploaded → none + kick");

  // ELEMENT_EPS: a target within half a 120 fps frame counts as "at".
  p = planPausedDraw(
    base({ elementTexTime: T + ELEMENT_EPS * 0.9 })
  );
  check(p.src === "element" && !p.chase, "element within eps counts as at target");
  p = planPausedDraw(base({ elementTexTime: T + ELEMENT_EPS * 2 }));
  check(p.src === "element" && !p.chase && p.kick && p.ts === T + ELEMENT_EPS * 2, "element outside eps is stale → cache job, no chase");

  // Stamps: the fingerprint must change exactly when the drawn frame does.
  const sHit = drawPlanStamp(planPausedDraw(base({ hit })));
  const sNear = drawPlanStamp(planPausedDraw(base({ nearest: near })));
  const sElem = drawPlanStamp(
    planPausedDraw(base({ elementTexTime: T }))
  );
  const sStale = drawPlanStamp(planPausedDraw(base({ elementTexTime: 1 })));
  const sNone = drawPlanStamp(planPausedDraw(base({})));
  const all = [sHit, sNear, sElem, sStale, sNone];
  check(new Set(all).size === all.length, `stamps distinct: ${all.join(" ")}`);
  check(sHit === "vf:c:3.3333" && sElem === "vf:e:3.3333", "stamp format c/e");
  check(sNone === "vf:-", "stamp for none");
  // Same drawn frame from a different probe → same stamp (cache hit downstream).
  const sHit2 = drawPlanStamp(
    planPausedDraw(base({ hit, elementTexTime: 7 }))
  );
  check(sHit2 === sHit, "same frame → same stamp");
  check(NEAREST_MAX > 0, "NEAREST_MAX exported");

  // Park (M3): a plan that is not chasing turns on park once the target
  // has rested, unless the element is already at the target.
  p = planPausedDraw(base({ hit, restingMs: PARK_AFTER_MS - 1 }));
  check(!p.park, "no park before the rest period");
  p = planPausedDraw(base({ hit, restingMs: PARK_AFTER_MS }));
  check(p.park && p.src === "cache" && !p.chase, "park after rest on an exact hit");
  p = planPausedDraw(base({ hit, restingMs: PARK_AFTER_MS, elementTexTime: T }));
  check(!p.park, "no park when the element is already at the target");
  p = planPausedDraw(base({ hit: proxy, cacheExact: false, restingMs: PARK_AFTER_MS }));
  check(p.chase && !p.park, "a chasing plan never also parks");
  check(
    drawPlanStamp(planPausedDraw(base({ hit, restingMs: PARK_AFTER_MS }))) === sHit,
    "park does not change the stamp"
  );
  console.log("draw planner ok");
}

// ── 5. playing catch-up planner (M3) ───────────────────────────────────
{
  const T = 100 / FPS;
  const hit = entry(100);
  let p = planPlayingDraw<Tex>({ target: T, elementTexTime: T - 0.01, elementSeeking: false, hit });
  check(p.src === "element", "steady playback: element wins even with a hit");
  p = planPlayingDraw<Tex>({ target: T, elementTexTime: T - 0.01, elementSeeking: true, hit });
  check(p.src === "cache" && p.entry === hit, "seeking: cache covers");
  p = planPlayingDraw<Tex>({ target: T, elementTexTime: T - PLAYING_CATCHUP * 2, elementSeeking: false, hit });
  check(p.src === "cache", "element far behind: cache covers");
  p = planPlayingDraw<Tex>({ target: T, elementTexTime: -1, elementSeeking: false, hit });
  check(p.src === "cache", "nothing uploaded yet: cache covers");
  p = planPlayingDraw<Tex>({ target: T, elementTexTime: T - 1, elementSeeking: true, hit: null });
  check(p.src === "element" && p.ts === T - 1, "seeking without a hit: stale element");
  p = planPlayingDraw<Tex>({ target: T, elementTexTime: -1, elementSeeking: true, hit: null });
  check(p.src === "none", "nothing at all: none");
  check(!p.chase && !p.kick && !p.park, "playing plans never seek or decode");
  console.log("playing planner ok");
}

// ── 6. job accept / slide (M1) ─────────────────────────────────────────
{
  const fwd: JobWindow = { start: 5, limit: 6.25, cursor: 5.5, backward: false };
  check(jobAccepts(fwd, 5.6), "forward: target just ahead of cursor accepted");
  check(jobAccepts(fwd, 5.5 + MAX_FOLLOW), "forward: up to MAX_FOLLOW ahead accepted");
  check(!jobAccepts(fwd, 5.5 + MAX_FOLLOW + 0.01), "forward: beyond MAX_FOLLOW restarts");
  check(!jobAccepts(fwd, 5.5), "at the cursor: already passed");
  check(!jobAccepts(fwd, 5.2), "behind the cursor: restart");
  check(jobAccepts(fwd, 7.0), "forward: past the current limit still accepted (it slides)");
  check(Math.abs(slideLimit(fwd, 7.0) - (7.0 + WINDOW_FAR)) < 1e-9, "limit slides to target + WINDOW_FAR");
  check(slideLimit(fwd, 5.1) === 6.25, "limit never shrinks");
  const back: JobWindow = { start: 4, limit: 5.25, cursor: 4.5, backward: true };
  check(jobAccepts(back, 4.8), "backward: inside window and ahead of cursor");
  check(!jobAccepts(back, 5.3), "backward: beyond its fixed limit restarts");
  check(!jobAccepts(back, 4.2), "backward: behind cursor restarts");
  check(slideLimit(back, 5.0) === 5.25, "backward limit is fixed");
  console.log("job accept / slide ok");
}

// ── 7. GOP widening (M2) ───────────────────────────────────────────────
{
  const win = { start: 4.75, end: 6 };
  const budget = 512 * 1024 * 1024;
  const bytes1080 = 1920 * 1080 * 4;
  // 1 s GOP at 30 fps = 30 frames × 8.3 MB = 249 MB ≤ half the budget → whole GOP
  let w = widenToGop(win, { start: 4, end: 5 }, 30, bytes1080, budget);
  check(w.start === 4 && w.end === 6, "short GOP: window widens to cover it");
  // 250-frame GOP: 2 GB > half → untouched
  w = widenToGop(win, { start: 0, end: 8.33 }, 30, bytes1080, budget);
  check(w.start === 4.75 && w.end === 6, "long GOP: window unchanged");
  w = widenToGop(win, null, 30, bytes1080, budget);
  check(w.start === 4.75 && w.end === 6, "no GOP info: unchanged");
  // exactly at the fraction boundary counts as affordable
  const frames = Math.floor((budget * GOP_BUDGET_FRACTION) / bytes1080);
  w = widenToGop(win, { start: 4, end: 4 + frames / 30 }, 30, bytes1080, budget);
  check(w.start === 4, "GOP at the budget fraction still widens");
  console.log("gop widening ok");
}

// ── 8. sequence decode-ahead window (M7) ───────────────────────────────
{
  const fwd = planSeqWindow(10, 9, 100, false, 24, 4);
  check(fwd[0] === 11 && fwd[1] === 9 && fwd.length === 28, `forward: leads ahead, 28 frames (${fwd.slice(0, 4)})`);
  check(!fwd.includes(10), "never the playhead's own frame");
  const back = planSeqWindow(50, 51, 100, false, 24, 4);
  check(back[0] === 49 && back[1] === 51 && back.filter((f) => f < 50).length === 24, "backward: leads behind");
  const head = planSeqWindow(1, null, 100, false, 24, 4);
  check(head.every((f) => f >= 0 && f < 100) && head.includes(0) && !head.includes(-1), "clips at 0 without loop");
  const wrap = planSeqWindow(98, 97, 100, true, 24, 4);
  check(wrap.includes(0) && wrap.includes(99) && wrap.every((f) => f >= 0 && f < 100), "loop wraps past the end");
  const tiny = planSeqWindow(0, null, 3, true, 24, 4);
  check(tiny.length === 2 && !tiny.includes(0), "tiny loop: each other frame once");
  check(planSeqWindow(0, null, 1, true).length === 0, "single frame: nothing to prefetch");
  console.log("sequence window ok");
}

if (failures > 0) {
  console.error(`check-video-frame-cache: ${failures} failure(s)`);
  process.exit(1);
}
console.log("check-video-frame-cache: all passed");
