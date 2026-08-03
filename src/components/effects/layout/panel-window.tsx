import React, { createContext, useContext } from "react";

// Which WINDOW a panel's subtree is living in.
// Spec: specdocs/080226_panel-popout-windows.md §3.
//
// A popped-out panel is portalled into another document, but it is
// still the same React tree — so module-scope `window` inside its
// components is the MAIN window, not the one the user is looking at. A
// listener registered there never hears the panel's events, and rect
// math done against it compares coordinates from two different spaces.
//
// The rule for anything renderable inside a detachable panel:
//
//   const panelWin = usePanelWindow();            // null in the main window
//   useEffect(() => {
//     const win = panelWin ?? window;             // fallback INSIDE the effect
//     win.addEventListener(...);
//     return () => win.removeEventListener(...);
//   }, [panelWin, ...]);
//
// The fallback lives inside the effect on purpose: `window` is
// undefined during SSR, and effects never run there. Keep `panelWin` in
// the dep list so listeners re-bind if a panel changes windows.

const PanelWindowContext = createContext<Window | null>(null);

/** The window owning this subtree, or null when it's the main one. */
export function usePanelWindow(): Window | null {
  return useContext(PanelWindowContext);
}

export function PanelWindowProvider({
  win,
  children,
}: {
  win: Window;
  children: React.ReactNode;
}) {
  return (
    <PanelWindowContext.Provider value={win}>
      {children}
    </PanelWindowContext.Provider>
  );
}

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
