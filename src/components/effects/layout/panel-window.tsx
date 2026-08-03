"use client";

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
//
// The React-free helpers (ownerWindow, broadcastAppEvent, …) live in
// ./panel-window-dom and are re-exported here so client components can
// keep importing everything from one place. Non-React callers — node
// definitions especially, since src/nodes reaches the docs pages'
// server graph — must import from ./panel-window-dom DIRECTLY: this
// module is "use client", and a server importer would get a
// client-reference proxy rather than the function itself.

export * from "./panel-window-dom";

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
