"use client";

// Mouse vs trackpad input handling. The editor's pan/zoom was built entirely
// on the trackpad idiom (plain scroll = pan, Cmd/Ctrl + scroll = zoom). This
// module is the single source of truth for whether the active pointing device
// is a mouse or a trackpad, so every wheel handler can switch behavior with
// one predicate (`wheelWantsZoom`). See specdocs/archive/061726_mouse-input-ux.md.
//
// Usable from both React (via the hooks below) and raw window/DOM handlers
// (via the plain getters) — the gesture handlers in EffectsApp and the
// timeline editors are imperative `addEventListener` blocks, not React.

import { useSyncExternalStore } from "react";

export type InputOverride = "auto" | "mouse" | "trackpad";
export type InputDevice = "mouse" | "trackpad";

const STORAGE_KEY = "toolbox:input-device";

// Persisted user override. localStorage (not the account-level Supabase prefs)
// because the input device is physically tied to the machine — a mouse on a
// desktop and a trackpad on a laptop can share one account.
let override: InputOverride = "auto";
// Sticky auto-detection result. Null until a confident classification lands;
// `getEffectiveDevice` falls back to "trackpad" so existing behavior is
// unchanged until a mouse gesture proves otherwise.
let detected: InputDevice | null = null;
// Hysteresis: only flip `detected` after N consecutive agreeing events so a
// single ambiguous wheel tick can't toggle behavior mid-scroll.
let pending: InputDevice | null = null;
let pendingCount = 0;
const FLIP_AFTER = 2;

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((cb) => cb());

function readStoredOverride(): InputOverride {
  if (typeof window === "undefined") return "auto";
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === "mouse" || v === "trackpad" || v === "auto") return v;
  } catch {
    // localStorage can throw (private mode, disabled) — fall back to auto.
  }
  return "auto";
}

// Initialize from storage at module load (client only).
override = readStoredOverride();

export function getInputOverride(): InputOverride {
  return override;
}

export function setInputOverride(next: InputOverride): void {
  override = next;
  try {
    if (typeof window !== "undefined")
      window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Ignore persistence failures; the in-memory value still applies.
  }
  emit();
}

// Classify a single wheel event. Returns null when inconclusive (or when it's
// an explicit pinch/zoom gesture that shouldn't be used to classify).
export function classifyWheel(e: WheelEvent): InputDevice | null {
  // Trackpad pinch arrives as a ctrlKey wheel; it's "zoom intent" either way,
  // so don't let it drive device classification.
  if (e.ctrlKey) return null;

  // The legacy `wheelDeltaY` is the most reliable mouse-vs-trackpad signal in
  // Blink/WebKit — and it's the one that works on macOS, where the OS smooths
  // a physical mouse wheel into trackpad-like fractional `deltaY` (which would
  // otherwise fool the size/integer checks below).
  //   - Chrome/Safari trackpads satisfy exactly  wheelDeltaY === deltaY * -3.
  //   - A mouse wheel reports notch-quantized values (±120 multiples).
  const wd = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
  if (typeof wd === "number" && wd !== 0) {
    if (wd === e.deltaY * -3) return "trackpad";
    if (Math.abs(wd) % 120 === 0) return "mouse";
  }

  // Line/page delta mode is a classic mouse wheel (e.g. Firefox).
  if (e.deltaMode !== 0) return "mouse";
  // Mouse wheels are vertical-only; any horizontal component is a trackpad.
  if (e.deltaX !== 0) return "trackpad";
  const ay = Math.abs(e.deltaY);
  // Smooth/inertial trackpad scrolling: small or fractional deltas.
  if (ay < 8 || !Number.isInteger(e.deltaY)) return "trackpad";
  // Large, vertical-only, integer delta → a mouse wheel notch.
  return "mouse";
}

// Feed a wheel event into the sticky detector. Call this once per event from a
// single global listener (EffectsApp mounts one in capture phase).
export function feedWheel(e: WheelEvent): void {
  const c = classifyWheel(e);
  if (!c) return;
  if (c === detected) {
    pending = null;
    pendingCount = 0;
    return;
  }
  // First-ever detection latches immediately, so the very first mouse notch
  // zooms instead of waiting out the hysteresis. Subsequent flips
  // (mouse↔trackpad mid-session) need FLIP_AFTER agreeing events to avoid
  // flicker from the occasional ambiguous gesture.
  if (detected === null) {
    detected = c;
    pending = null;
    pendingCount = 0;
    if (override === "auto") emit();
    return;
  }
  if (c === pending) {
    pendingCount++;
  } else {
    pending = c;
    pendingCount = 1;
  }
  if (pendingCount >= FLIP_AFTER) {
    detected = c;
    pending = null;
    pendingCount = 0;
    // Only matters for the node editor (its props are derived from the device)
    // when override is "auto".
    if (override === "auto") emit();
  }
}

export function getEffectiveDevice(): InputDevice {
  if (override !== "auto") return override;
  return detected ?? "trackpad";
}

// The one predicate every wheel handler switches on: should this wheel gesture
// zoom (vs pan)? True for any explicit zoom modifier, or when the effective
// device is a mouse.
export function wheelWantsZoom(e: WheelEvent): boolean {
  return e.ctrlKey || e.metaKey || getEffectiveDevice() === "mouse";
}

export function subscribeInputDevice(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// React: re-renders when the effective device changes (override flips, or auto
// detection lands). Used by the node editor to flip its xyflow scroll props.
// The server snapshot is the stable "trackpad" default, so SSR + first client
// render agree (no hydration mismatch when the stored override is "mouse").
export function useEffectiveDevice(): InputDevice {
  return useSyncExternalStore(
    subscribeInputDevice,
    getEffectiveDevice,
    () => "trackpad" as InputDevice
  );
}

// React: for the settings control. Returns the raw override + a setter.
export function useInputOverride(): [InputOverride, (n: InputOverride) => void] {
  const value = useSyncExternalStore(
    subscribeInputDevice,
    getInputOverride,
    () => "auto" as InputOverride
  );
  return [value, setInputOverride];
}
