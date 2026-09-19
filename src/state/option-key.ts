// Whether the Option (Alt) key is currently down, per window. Popped-out
// panels (specdocs/archive/080226_panel-popout-windows.md) receive their own
// key events, so the main window's modifier state says nothing about a
// detached ParamPanel — each window gets its own store, created on first
// subscribe and torn down with the last unsubscribe.
//
// UI feedback only: the param panel tags Option-linkable rows while the key
// is down. The linked edit itself reads `altKey` off the pointer / key event
// that starts the gesture (ParamRow), so a missed keyup here can never route
// a write to the wrong node. Playback-clock pattern: subscribe + a hook.

import { useCallback, useSyncExternalStore } from "react";

interface OptionKeyStore {
  held: boolean;
  listeners: Set<() => void>;
  detach: () => void;
}

const stores = new WeakMap<Window, OptionKeyStore>();

function storeFor(win: Window): OptionKeyStore {
  const existing = stores.get(win);
  if (existing) return existing;
  const store: OptionKeyStore = {
    held: false,
    listeners: new Set(),
    detach: () => {},
  };
  const set = (held: boolean) => {
    if (store.held === held) return;
    store.held = held;
    for (const l of [...store.listeners]) l();
  };
  // Every key event carries the live modifier state, so any keydown/keyup
  // resyncs — Option released while another key was down still clears.
  const onKey = (e: KeyboardEvent) => set(e.altKey);
  // The keyup lands in whichever window has focus; losing focus drops it.
  const onBlur = () => set(false);
  win.addEventListener("keydown", onKey, true);
  win.addEventListener("keyup", onKey, true);
  win.addEventListener("blur", onBlur);
  store.detach = () => {
    win.removeEventListener("keydown", onKey, true);
    win.removeEventListener("keyup", onKey, true);
    win.removeEventListener("blur", onBlur);
  };
  stores.set(win, store);
  return store;
}

function subscribe(win: Window, cb: () => void): () => void {
  const store = storeFor(win);
  store.listeners.add(cb);
  return () => {
    store.listeners.delete(cb);
    if (store.listeners.size === 0) {
      store.detach();
      stores.delete(win);
    }
  };
}

const noopSubscribe = () => () => {};
const falseSnapshot = () => false;

/**
 * True while Option is held in `win` (null ⇒ the main window, matching
 * usePanelWindow's convention). `enabled: false` subscribes to nothing and
 * reads false, so a component that only sometimes cares (the param panel
 * with a single node selected) doesn't re-render on every Option press.
 */
export function useOptionHeld(win: Window | null, enabled = true): boolean {
  const target =
    enabled ? win ?? (typeof window === "undefined" ? null : window) : null;
  const sub = useCallback(
    (cb: () => void) => (target ? subscribe(target, cb) : noopSubscribe()),
    [target]
  );
  const get = useCallback(
    () => (target ? stores.get(target)?.held ?? false : false),
    [target]
  );
  return useSyncExternalStore(sub, get, falseSnapshot);
}
