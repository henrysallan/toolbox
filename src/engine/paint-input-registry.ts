// =====================================================================
// Paint input registry (101526_paint-selection-transform.md §1)
// =====================================================================
//
// A module-level bridge that hands a Paint node's wired-in IMAGE to its
// on-canvas editor as CPU pixels. The editor can't read it anywhere else:
// the preview shows the end of the chain (not Paint's input), and pooled
// pipeline textures don't outlive an eval. So the editor files a request
// here and bumps the pipeline; Paint's compute folds the request epoch into
// its fingerprint (so it re-runs even when nothing else changed), sees the
// waiters, reads its input back with `ctx.readImagePixels`, and resolves
// them. Nothing is read back unless the editor asks.
//
// Engine-side (components may import engine; not vice-versa — invariant
// #1). Mirrors three-viewport-registry.ts.

// Straight-alpha RGBA8, y-down (row 0 = visual top) — the 2D-canvas
// ImageData layout, so it can go straight into putImageData. Covers the
// requested region: (x, y) is its top-left in edit-canvas px (0, 0 for a
// full-canvas request) and width/height its size.
export interface PaintInputPixels {
  x: number;
  y: number;
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

// An integer edit-canvas-px rectangle, already clamped to the canvas.
export interface PaintInputRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PaintInputWaiter {
  // The edit canvas size the input is resampled to.
  width: number;
  height: number;
  // Only this part of it (a lift reads just the selection's bbox); null =
  // the whole canvas.
  rect: PaintInputRect | null;
  resolve: (pixels: PaintInputPixels | null) => void;
}

const epochs = new Map<string, number>();
const waiters = new Map<string, PaintInputWaiter[]>();

// Folded into the Paint node's fingerprintExtras: a new request bumps it,
// which makes the next eval recompute the node even with unchanged params
// and inputs.
export function paintInputEpoch(nodeId: string): number {
  return epochs.get(nodeId) ?? 0;
}

// Ask for the node's input at `width`×`height` (the edit canvas size; the
// readback resamples to it), optionally just `rect` of it. Resolves null
// when no image is wired, or when no eval reaches the node within
// `timeoutMs` (e.g. the node isn't on the chain being rendered). The CALLER must trigger an eval afterwards (the
// editor dispatches "pipeline-bump") — the engine never touches window.
export function requestPaintInput(
  nodeId: string,
  width: number,
  height: number,
  rect: PaintInputRect | null = null,
  timeoutMs = 3000
): Promise<PaintInputPixels | null> {
  return new Promise((resolve) => {
    let done = false;
    const waiter: PaintInputWaiter = {
      width,
      height,
      rect,
      resolve: (px) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(px);
      },
    };
    const timer = setTimeout(() => {
      const list = waiters.get(nodeId);
      if (list) {
        const i = list.indexOf(waiter);
        if (i >= 0) list.splice(i, 1);
        if (list.length === 0) waiters.delete(nodeId);
      }
      waiter.resolve(null);
    }, timeoutMs);
    const list = waiters.get(nodeId) ?? [];
    list.push(waiter);
    waiters.set(nodeId, list);
    epochs.set(nodeId, paintInputEpoch(nodeId) + 1);
  });
}

// Called by Paint's compute: removes and returns the node's pending
// waiters (empty when there are none). Each must be resolved.
export function takePaintInputWaiters(nodeId: string): PaintInputWaiter[] {
  const list = waiters.get(nodeId);
  if (!list) return [];
  waiters.delete(nodeId);
  return list;
}
