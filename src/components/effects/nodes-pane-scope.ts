// With the tiled layout (specdocs/archive/072726_window-tiling.md) several
// Node Editor panes can be mounted at once — all rendering the same
// graph. Each instance attaches window-level listeners (shortcuts,
// paste, the pie-menu open-search event); without gating, two panes
// would both handle a Cmd+V and paste twice.
//
// Rule (Blender's): shortcuts go to the pane the pointer last entered.
// Sticky, not hover-gated — with a single pane (the common case) it
// always owns the scope, so shortcuts keep working while the cursor is
// over the params panel, exactly as before tiling. This is the
// pane-INSTANCE dimension; shortcut-scope.ts stays the editor-KIND
// dimension (node vs graph vs spline) and both checks compose.
//
// Pop-out (080226_panel-popout-windows.md) makes the scope PER WINDOW.
// A pane in another window attaches its listeners there, so a keystroke
// only ever reaches panes in the window that has OS focus — the real
// question is "which pane within this window", not "which pane
// overall". Scoping per window also fixes the case a single global
// owner gets wrong: pointer resting over the main window's pane while
// the popped-out window holds keyboard focus would otherwise leave the
// focused pane inert.

const mounted = new Set<string>();
/** Pane id → the window its listeners live on. */
const paneWindows = new Map<string, Window>();
/** Window → the pane in it the pointer last entered. */
const ownerByWindow = new Map<Window, string>();
/**
 * The single most-recently-claimed pane across ALL windows. Needed
 * because the two scope questions differ once panes span windows:
 *
 *   "handle this keystroke?"  → per window (the event already picked one)
 *   "handle this broadcast?"  → global (broadcastAppEvent hits EVERY
 *                               window, so per-window scope would let one
 *                               pane per window answer — the exact
 *                               double-fire this module exists to stop)
 */
let globalOwner: string | null = null;

function windowFor(id: string): Window | null {
  return paneWindows.get(id) ?? null;
}

/**
 * Call on pane mount. The first pane mounted in a given window becomes
 * that window's owner.
 */
export function registerNodesPane(id: string, win?: Window | null): void {
  mounted.add(id);
  const w = win ?? (typeof window !== "undefined" ? window : null);
  if (!w) return;
  paneWindows.set(id, w);
  const current = ownerByWindow.get(w);
  if (!current || !mounted.has(current)) ownerByWindow.set(w, id);
  if (globalOwner === null || !mounted.has(globalOwner)) globalOwner = id;
}

/** Call on pane unmount. Ownership falls to any surviving pane there. */
export function unregisterNodesPane(id: string): void {
  mounted.delete(id);
  const w = windowFor(id);
  paneWindows.delete(id);
  if (globalOwner === id) {
    globalOwner = mounted.values().next().value ?? null;
  }
  if (!w) return;
  if (ownerByWindow.get(w) !== id) return;
  let next: string | undefined;
  for (const other of mounted) {
    if (paneWindows.get(other) === w) {
      next = other;
      break;
    }
  }
  if (next) ownerByWindow.set(w, next);
  else ownerByWindow.delete(w);
}

/** Pointer entered / pressed inside the pane — it takes the scope. */
export function claimNodesPane(id: string): void {
  if (!mounted.has(id)) return;
  globalOwner = id;
  const w = windowFor(id);
  if (w) ownerByWindow.set(w, id);
}

/**
 * Should this pane's window-level handlers act right now? For events
 * delivered to ONE window (keystrokes, paste, pointer) — the window has
 * already been chosen, so this only disambiguates panes within it.
 */
export function ownsNodesPaneScope(id: string): boolean {
  const w = windowFor(id);
  if (!w) return true;
  const owner = ownerByWindow.get(w);
  return owner === undefined || owner === id;
}

/**
 * Should this pane answer an event broadcast to EVERY window (the
 * pie menu's node-search request)? Exactly one pane app-wide may.
 */
export function ownsGlobalNodesPaneScope(id: string): boolean {
  return globalOwner === null || globalOwner === id;
}
