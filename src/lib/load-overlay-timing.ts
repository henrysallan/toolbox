// Timing shared by the two project-load veils — the editor's
// ProjectLoadOverlay (components/effects) and the live viewer's
// LiveLoadOverlay (lib/live-viewer, bundled into exported apps too) — so a
// live link fills, holds and fades on exactly the editor's cadence. Leaf
// module on purpose: the export template bundles it, so nothing here may
// import editor-only code.

// Held long enough that a fast in-memory deserialize still reads as a
// fill, not a snap-to-done. The bar itself eases over BAR_MS, so this
// floor is slightly longer than that transition.
export const PROJECT_LOAD_MIN_MS = 520;
export const PROJECT_LOAD_FADE_MS = 480;
export const PROJECT_LOAD_BAR_MS = 320;

export function waitAnimationFrames(count = 2): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const step = (left: number) => {
      if (left <= 0) {
        done();
        return;
      }
      requestAnimationFrame(() => step(left - 1));
    };
    requestAnimationFrame(() => step(count - 1));
    // Hidden / background tabs throttle or pause rAF; don't let the
    // overlay wait on a frame that will never come.
    window.setTimeout(done, Math.max(50, count * 32));
  });
}
