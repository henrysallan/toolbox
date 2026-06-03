// =====================================================================
// WebGPU device boot wrapper — Phase 1 infrastructure
// =====================================================================
//
// Thin layer over `ctx.getWebGPUDevice()` that gives callers a single
// typed status instead of a (device | null) plus their own error UX.
// The existing `getWebGPUDevice` in engine/gl.ts already caches the
// device promise; this module's job is twofold:
//
//  - Normalize the failure modes into a small union so node compute()
//    callers can render a one-time error message and stop instead of
//    re-trying every frame.
//  - Cache the resolved status in `ctx.state` so that subsequent
//    frames don't even await the promise — the typical hot path on
//    frame N>0 is a synchronous Map lookup.
//
// Calling pattern from a node:
//
//   const status = await ensureWebGPUDevice(ctx);
//   if (!status.ok) {
//     ctx.state[`<node>:webgpu-error`] = status.reason;
//     return; // fall back / surface error / etc.
//   }
//   const { device } = status;
//   ...

import type { RenderContext } from "@/engine/types";

export type WebGPUUnavailableReason =
  | "no-navigator-gpu"
  | "no-adapter"
  | "device-request-failed";

export type WebGPUStatus =
  | { ok: true; device: GPUDevice }
  | {
      ok: false;
      reason: WebGPUUnavailableReason;
      // User-facing message. Safe to render verbatim.
      message: string;
    };

const STATE_KEY = "webgpu:device-status";

interface CachedStatus {
  promise: Promise<WebGPUStatus>;
  resolved: WebGPUStatus | null;
}

// Returns a stable WebGPUStatus for the engine's WebGPU device. First
// call awaits the device boot; subsequent calls resolve synchronously
// via the cached value. Safe to await every frame — the cache means
// frame N>0 doesn't actually queue a microtask, the promise is already
// settled.
export async function ensureWebGPUDevice(
  ctx: RenderContext
): Promise<WebGPUStatus> {
  const cached = ctx.state[STATE_KEY] as CachedStatus | undefined;
  if (cached?.resolved) return cached.resolved;
  if (cached?.promise) return cached.promise;

  const promise = (async (): Promise<WebGPUStatus> => {
    const device = await ctx.getWebGPUDevice();
    if (!device) {
      // The engine returns null for both "no navigator.gpu" and "no
      // adapter". We can't tell them apart from here; surface the
      // ambiguous case as no-adapter since it covers Safari < 18.2
      // and headless builds. The boot warning in gl.ts already logs
      // the real reason when it happens.
      return {
        ok: false,
        reason: "no-adapter",
        message:
          "WebGPU is not available in this browser or no GPU adapter was found.",
      };
    }
    return { ok: true, device };
  })();

  const entry: CachedStatus = { promise, resolved: null };
  ctx.state[STATE_KEY] = entry;
  const resolved = await promise;
  entry.resolved = resolved;
  return resolved;
}

// Synchronous accessor for nodes that have already awaited the device
// in a prior frame. Returns null if the boot hasn't completed yet (or
// hasn't started). Useful inside hot loops that don't want to await.
export function peekWebGPUDevice(ctx: RenderContext): WebGPUStatus | null {
  const cached = ctx.state[STATE_KEY] as CachedStatus | undefined;
  return cached?.resolved ?? null;
}
