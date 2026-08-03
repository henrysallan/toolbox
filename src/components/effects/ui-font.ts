"use client";

// Editor UI font preference. The editor chrome hard-codes no font family:
// component inline styles say `fontFamily: "var(--ui-font)"` and globals.css
// gives :root the monospace default, so the editor looks exactly as before
// until a different font is chosen. Picking one here overrides --ui-font on
// <html> for the current machine.
//
// localStorage (not the account-level Supabase prefs) on purpose: it's a
// cosmetic, per-device choice that should work signed-out and apply before
// any network round-trip. Same reasoning as the input-device override
// (input-device.ts), which this module is patterned after.
//
// Surfaces that are semantically code (expression editors, the message
// console, char-aligned inspectors) use var(--code-font) instead and are
// not affected by this toggle.

import { useSyncExternalStore } from "react";

export type UiFontId = "mono" | "inter";

export const UI_FONTS: { id: UiFontId; label: string; stack: string }[] = [
  // "mono" mirrors the :root default in globals.css — applying it removes
  // the override rather than restating the stack, so globals.css stays the
  // single source of truth for the default look.
  { id: "mono", label: "Mono", stack: "ui-monospace, monospace" },
  // Same stack as the landing modal's INTER constant (Landing.tsx); the
  // variable TTF is @font-face'd in globals.css.
  { id: "inter", label: "Inter", stack: '"Inter", system-ui, -apple-system, sans-serif' },
];

const STORAGE_KEY = "toolbox:ui-font";

let current: UiFontId = "mono";

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((cb) => cb());

function readStored(): UiFontId {
  if (typeof window === "undefined") return "mono";
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (UI_FONTS.some((f) => f.id === v)) return v as UiFontId;
  } catch {
    // localStorage can throw (private mode, disabled) — keep the default.
  }
  return "mono";
}

current = readStored();

function applyToDocument(id: UiFontId): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (id === "mono") {
    root.style.removeProperty("--ui-font");
    return;
  }
  const font = UI_FONTS.find((f) => f.id === id);
  if (font) root.style.setProperty("--ui-font", font.stack);
}

export function getUiFont(): UiFontId {
  return current;
}

export function setUiFont(next: UiFontId): void {
  current = next;
  try {
    if (typeof window !== "undefined")
      window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Ignore persistence failures; the in-memory value still applies.
  }
  applyToDocument(next);
  emit();
}

// Called once from EffectsApp on mount (post-hydration, so the inline style
// on <html> can't race React's hydration of the element). Until it runs the
// UI renders in the default mono — a brief, acceptable flash.
export function applyStoredUiFont(): void {
  applyToDocument(current);
}

// React: for the settings control. Returns the current id + a setter that
// persists and applies immediately.
export function useUiFont(): [UiFontId, (n: UiFontId) => void] {
  const value = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getUiFont,
    () => "mono" as UiFontId
  );
  return [value, setUiFont];
}
