// Shared geometry-equality guard for the on-canvas overlays (Points, Gradient,
// Segment dots, Spline editor, WebGPU particles). Each tracks the preview
// canvas's getBoundingClientRect() in React state and refreshes it from a
// ResizeObserver. getBoundingClientRect() returns a fresh DOMRect every call,
// so setting it unconditionally installs a new state reference even when
// nothing moved — and because the observer reads layout inside its own callback
// (and the overlays render position:fixed inside xyflow's transformed
// containers), a sub-pixel jitter re-fires the observer, re-sets state,
// re-renders, and re-fires again: React throws "Maximum update depth exceeded".
// Wrapping the setRect updater in `rectsEqual(prev, next) ? prev : next` makes
// the update idempotent and terminates the feedback loop. It only ever skips a
// no-op update, never a real geometry change, so it is always safe.
export function rectsEqual(a: DOMRect | null, b: DOMRect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height
  );
}
