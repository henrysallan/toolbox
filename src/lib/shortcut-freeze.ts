// Capture-phase input gates on `window`, registered at module-import time
// so they run before any listener added in a component effect — including
// the capture-phase ones in NodeEditor/LayersEditor.
//
// Gate 1 — dev-only "Freeze" switch: suppresses every app keyboard
// shortcut while leaving native text editing untouched. When frozen,
// events whose target is not an editable element are killed with
// stopImmediatePropagation; preventDefault is never called, so plain
// typing, focus traversal, and the browser's own copy/paste keep working.
// Editable targets pass through untouched so inputs keep their
// Enter/Escape/paste handlers (app-level shortcut handlers already ignore
// INPUT/TEXTAREA targets themselves).
//
// Gate 2 — landing-gateway lock: engaged while the Landing overlay is up
// (Landing.tsx) so the editor mounted behind the veil can't be driven
// from the keyboard or clipboard. It shares the key/clipboard gate with
// the freeze switch, and additionally kills wheel and middle-click
// pointerdown propagation: the viewport pan/zoom handlers listen on
// `window` and hit-test the CURSOR against the viewport's rect rather
// than the DOM (useViewportGestures), so a scroll or middle-drag over
// the landing would otherwise pan/zoom the editor straight through it.
// preventDefault is never called, so the landing's own native scrolling
// keeps working, and left/right pointer events pass through untouched
// (the landing needs them for tile drag and its popovers).
//
// Clipboard events are gated alongside key events because node paste is
// driven by a window-level "paste" listener, which cmd+V would still reach
// even with its keydown suppressed.

let frozen = false;
let gatewayLocked = false;
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

export function isGatewayInputLocked(): boolean {
  return gatewayLocked;
}

export function setGatewayInputLock(v: boolean): void {
  gatewayLocked = v;
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
  if (!frozen && !gatewayLocked) return;
  if (isEditableTarget(e.target)) return;
  // Escape stays live while gated — closing popups/modals (and the
  // landing itself) shouldn't require lifting the gate first.
  if (e instanceof KeyboardEvent && e.key === "Escape") return;
  e.stopImmediatePropagation();
}

// Wheel + middle-click gate for the gateway lock only (the dev freeze is
// strictly about keyboard shortcuts). Nothing on the landing consumes
// either, so both are safe to kill outright while locked.
function gateGesture(e: Event): void {
  if (!gatewayLocked) return;
  if (e.type === "pointerdown" && (e as PointerEvent).button !== 1) return;
  e.stopImmediatePropagation();
}

// keyup included so held-key tools (pie menu, temporary tools) never see a
// release without a press.
if (typeof window !== "undefined") {
  for (const type of ["keydown", "keyup", "copy", "cut", "paste"]) {
    window.addEventListener(type, gate, { capture: true });
  }
  // passive: the gate never preventDefaults, and a passive wheel listener
  // keeps native scrolling on the compositor's fast path.
  window.addEventListener("wheel", gateGesture, {
    capture: true,
    passive: true,
  });
  window.addEventListener("pointerdown", gateGesture, { capture: true });
}
