// Tracks which editor "scope" should receive contextual keyboard shortcuts
// (the node editor's G-move / Delete, the graph editor's G/S modal, etc.),
// based on the last mouse click that landed inside a scoped region.
//
// A region opts in by setting `data-shortcut-scope="<name>"` on its root
// element. Clicks on neutral chrome (param panel, menus, toolbars) leave the
// active scope UNCHANGED — so selecting a node and then tweaking its params
// keeps the node editor's shortcuts active, rather than silently disabling
// every editor's shortcuts.

let activeScope: string | null = null;
let installed = false;

function ensureInstalled() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  // Capture phase so the scope is updated before any downstream handler runs
  // (and regardless of stopPropagation further down the tree).
  window.addEventListener(
    "mousedown",
    (e) => {
      const target = e.target as HTMLElement | null;
      const el = target?.closest?.(
        "[data-shortcut-scope]"
      ) as HTMLElement | null;
      if (el) activeScope = el.dataset.shortcutScope ?? null;
    },
    true
  );
}

/** The scope name of the editor that was last clicked, or null. */
export function getShortcutScope(): string | null {
  ensureInstalled();
  return activeScope;
}
