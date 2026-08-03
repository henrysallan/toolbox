// Window/document plumbing for detachable panels — the React-free half.
// Spec: specdocs/080226_panel-popout-windows.md §3.
//
// Kept separate from panel-window.tsx (which owns the context and is a
// "use client" module) because these are plain functions that non-React
// code calls directly. Node definitions broadcast app events, and
// src/nodes/index.ts is reachable from the docs pages' SERVER graph via
// src/lib/docs/manifest.ts — importing a client module there would hand
// the server a client-reference proxy instead of the function, and the
// call would throw. Anything here must stay free of React imports.

/** For code holding an element instead of context (hooks taking refs). */
export function ownerWindow(el: Element | null | undefined): Window {
  return el?.ownerDocument.defaultView ?? window;
}

/** The document an element lives in — portal targets, elementFromPoint. */
export function ownerDocument(el: Element | null | undefined): Document {
  return el?.ownerDocument ?? document;
}

// --- cross-window app events ---------------------------------------------

const OPEN_PANEL_WINDOWS = new Set<Window>();

/** PanelPopout calls this while a panel window is alive. */
export function registerPanelWindow(win: Window): () => void {
  OPEN_PANEL_WINDOWS.add(win);
  return () => OPEN_PANEL_WINDOWS.delete(win);
}

/** Every live panel window (main window excluded). */
export function panelWindows(): Window[] {
  for (const w of OPEN_PANEL_WINDOWS) if (w.closed) OPEN_PANEL_WINDOWS.delete(w);
  return [...OPEN_PANEL_WINDOWS];
}

/**
 * Dispatch one of the app's own window CustomEvents to EVERY window.
 *
 * These events are how detached features talk to each other — the
 * stagger control drives the track editor, the pie menu opens the node
 * search, media-load progress reaches per-node spinners. Once either
 * side can be in another window, a plain `window.dispatchEvent` only
 * reaches listeners that happen to share the sender's window. Direction
 * doesn't matter here: a panel calling this runs the SAME module
 * instance as the main window (one JS heap), so a popout broadcasting
 * reaches the main window too.
 *
 * Takes a factory rather than an Event so each target gets its own
 * instance and nothing observes a half-dispatched event.
 */
export function broadcastAppEvent(make: () => Event): void {
  if (typeof window !== "undefined") window.dispatchEvent(make());
  for (const w of panelWindows()) {
    try {
      w.dispatchEvent(make());
    } catch {
      // A window torn down between the liveness check and here — the
      // next panelWindows() call prunes it.
    }
  }
}
