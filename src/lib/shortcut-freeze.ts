// Dev-only "Freeze" switch: suppresses every app keyboard shortcut while
// leaving native text editing untouched. One capture-phase listener on
// `window`, registered at module-import time so it runs before any listener
// added in a component effect — including the capture-phase ones in
// NodeEditor/LayersEditor. When frozen, events whose target is not an
// editable element are killed with stopImmediatePropagation; preventDefault
// is never called, so plain typing, focus traversal, and the browser's own
// copy/paste keep working. Editable targets pass through untouched so
// inputs keep their Enter/Escape/paste handlers (app-level shortcut
// handlers already ignore INPUT/TEXTAREA targets themselves).
//
// Clipboard events are gated alongside key events because node paste is
// driven by a window-level "paste" listener, which cmd+V would still reach
// even with its keydown suppressed.

let frozen = false;
const subscribers = new Set<() => void>();

export function isShortcutFrozen(): boolean {
  return frozen;
}

export function setShortcutFrozen(v: boolean): void {
  if (frozen === v) return;
  frozen = v;
  for (const fn of subscribers) fn();
}

export function subscribeShortcutFreeze(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return (
    t.tagName === "INPUT" ||
    t.tagName === "TEXTAREA" ||
    t.tagName === "SELECT" ||
    t.isContentEditable
  );
}

function gate(e: Event): void {
  if (!frozen) return;
  if (isEditableTarget(e.target)) return;
  // Escape stays live while frozen — closing popups/modals shouldn't
  // require unfreezing first.
  if (e instanceof KeyboardEvent && e.key === "Escape") return;
  e.stopImmediatePropagation();
}

// keyup included so held-key tools (pie menu, temporary tools) never see a
// release without a press.
if (typeof window !== "undefined" && process.env.NODE_ENV === "development") {
  for (const type of ["keydown", "keyup", "copy", "cut", "paste"]) {
    window.addEventListener(type, gate, { capture: true });
  }
}
