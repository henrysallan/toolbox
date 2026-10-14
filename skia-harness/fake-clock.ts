// A deterministic animation clock for the web harness — native-mode parity
// (specdocs/101326_skia-target.md §3.5c). Web only; installed by
// index.web.ts when the page has ?clock=fake.
//
// Reanimated on the web steps every running animation from
// requestAnimationFrame callbacks, with the callback's timestamp, and stamps
// a new animation with _getAnimationTimestamp() (performance.now()). This
// shim keeps rAF callbacks running on real frames — React Native Skia's
// first draws and the harness's snapshot loop need them — but hands every
// callback the FAKE time, which moves only when the harness steps it:
// exactly 1000 / fps ms per frame from t0 (plus ?jitter= ms of seeded,
// per-frame wobble, to model a real vsync). So after advanceTo(f) the
// shared values hold what that display shows f frames after play(), and a
// capture is reproducible run to run.
//
// While advanceTo() steps, real frames don't flush (each frame's callbacks
// run once, at that frame's time). A real frame between captures re-runs
// the queued callbacks at the frozen time; Reanimated's animations are
// idempotent at a repeated timestamp (no step of the native export starts
// with a zero delay), so that only redraws.

export interface FakeClock {
  readonly fps: number;
  readonly t0: number;
  // ± ms of deterministic per-frame jitter (?jitter=, ?seed=): a vsync
  // whose timestamps wobble around the ideal grid. 0 = a perfect display.
  readonly jitterMs: number;
  frame(): number;
  now(): number;
  // Step to frame f, one 1000/fps ms frame at a time: run that frame's
  // queued callbacks, let the mapper microtasks settle, then onFrame(f).
  advanceTo(f: number, onFrame?: (frame: number) => void): Promise<void>;
  // Point Reanimated's animation timestamp at the fake clock. Call after
  // react-native-worklets has initialised (it installs performance.now).
  bindReanimated(): void;
}

// Uniform 0..1 per frame and seed — the same function as
// scripts/skia/reanimated-sim.ts jitter01, so the offline simulator can
// replay a jittered harness run frame for frame.
export function jitter01(frame: number, seed: number): number {
  let a = (Math.imul(frame, 0x9e3779b1) ^ seed) >>> 0;
  a = (a + 0x6d2b79f5) >>> 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function installFakeClock(fps = 60, t0 = 10_000, jitterMs = 0, seed = 1): FakeClock {
  const realRaf = window.requestAnimationFrame.bind(window);
  const nowOf = (f: number) => t0 + (f * 1000) / fps + (jitterMs && f > 0 ? jitterMs * (2 * jitter01(f, seed) - 1) : 0);
  let frame = 0;
  let now = nowOf(0);
  let queue: { id: number; cb: FrameRequestCallback }[] = [];
  let nextId = 1;
  let pending = false;
  let stepping = false;

  const flush = () => {
    const q = queue;
    queue = [];
    for (const { cb } of q) {
      try {
        cb(now);
      } catch (e) {
        console.error(e);
      }
    }
  };
  const onRealFrame = () => {
    pending = false;
    if (stepping) {
      if (queue.length) schedule();
      return;
    }
    flush();
  };
  const schedule = () => {
    if (pending) return;
    pending = true;
    realRaf(onRealFrame);
  };

  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    const id = nextId++;
    queue.push({ id, cb });
    schedule();
    return id;
  };
  window.cancelAnimationFrame = (id: number | null | undefined) => {
    queue = queue.filter((e) => e.id !== id);
  };

  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  return {
    fps,
    t0,
    jitterMs,
    frame: () => frame,
    now: () => now,
    async advanceTo(f, onFrame) {
      stepping = true;
      try {
        while (frame < f) {
          frame++;
          now = nowOf(frame);
          flush();
          await settle();
          onFrame?.(frame);
        }
      } finally {
        stepping = false;
        if (queue.length) schedule();
      }
    },
    bindReanimated() {
      (globalThis as unknown as { _getAnimationTimestamp: () => number })._getAnimationTimestamp = () => now;
    },
  };
}

const G = globalThis as unknown as { __toolboxFakeClock?: FakeClock };

// Installed while this module evaluates — index.web.ts imports it first, so
// no other module can have captured the real requestAnimationFrame.
if (typeof window !== "undefined") {
  const q = new URLSearchParams(window.location.search);
  if (q.get("clock") === "fake") G.__toolboxFakeClock = installFakeClock(60, 10_000, Number(q.get("jitter") ?? 0) || 0, Number(q.get("seed") ?? 1) || 1);
}

// The page's clock (null without ?clock=fake).
export function fakeClock(): FakeClock | null {
  return G.__toolboxFakeClock ?? null;
}
