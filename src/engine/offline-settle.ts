// =====================================================================
// Offline media settle coordination
// =====================================================================
//
// During a deterministic offline export (ctx.offline) the clock is stepped
// frame-by-frame, not in wall-clock realtime. Async media — chiefly a
// <video> element being seeked to an exact time — can't decode the target
// frame synchronously inside a node's compute(). If we capture immediately
// we record whatever stale frame the decoder happened to be on, which with
// multiple videos shows up as jitter / frames snapping back and forth.
//
// The contract: a node that issues an async seek during offline render
// pushes a "settle" promise here (it resolves when the seek's frame is
// decoded). The export driver renders once to ISSUE the seeks, awaits the
// settle promises, then renders again to UPLOAD the now-decoded frames
// before capturing. Realtime playback never touches any of this.

import type { RenderContext } from "./types";

const SETTLE_KEY = "__offlineMediaSettle";

// Register a promise that resolves once a just-issued async media operation
// (e.g. a video seek) has produced its target frame. No-op storage cost
// when offline rendering isn't active — callers only push when ctx.offline.
export function pushMediaSettle(
  ctx: RenderContext,
  promise: Promise<void>
): void {
  const arr = (ctx.state[SETTLE_KEY] as Promise<void>[] | undefined) ?? [];
  arr.push(promise);
  ctx.state[SETTLE_KEY] = arr;
}

// Await every settle promise registered since the last call, then clear the
// queue. Returns true if anything was pending (so the caller knows a second
// render pass is worthwhile). Safe to call when nothing registered.
export async function awaitMediaSettle(
  state: Record<string, unknown>
): Promise<boolean> {
  const arr = state[SETTLE_KEY] as Promise<void>[] | undefined;
  if (!arr || arr.length === 0) return false;
  state[SETTLE_KEY] = [];
  await Promise.all(arr);
  return true;
}

// Build a settle promise for a <video> seek: resolves on the next 'seeked'
// event (frame decoded), immediately if already parked at the target, or
// after a safety timeout so a wedged decode can't hang the whole export.
export function videoSeekSettle(
  video: HTMLVideoElement,
  target: number,
  timeoutMs = 2000
): Promise<void> {
  return new Promise<void>((resolve) => {
    const HAVE_CURRENT_DATA = 2;
    if (
      !video.seeking &&
      video.readyState >= HAVE_CURRENT_DATA &&
      Math.abs(video.currentTime - target) < 0.02
    ) {
      resolve();
      return;
    }
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      video.removeEventListener("seeked", finish);
      resolve();
    };
    video.addEventListener("seeked", finish, { once: true });
    timer = setTimeout(finish, timeoutMs);
  });
}
