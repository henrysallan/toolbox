"use client";

// Editor theme: light/dark mode + a per-mode brightness trim.
// Spec: 080226_theme-modes.md. Token table: ./tokens.ts.
//
// Patterned on ui-font.ts — localStorage rather than the Supabase account
// prefs, because it's a cosmetic per-device choice that has to work signed
// out and apply with no network round-trip. Same useSyncExternalStore shape.
//
// TWO THINGS DIFFER FROM ui-font:
//
// 1. Mode rides a `data-theme` attribute on <html>, and globals.css carries
//    both full ramps. So switching mode is one attribute write, and the
//    server-rendered / pre-hydration state is already correct.
// 2. The brightness trim needs OKLCH maths that can't run in the tiny
//    pre-paint script in layout.tsx. Rather than duplicate the maths into a
//    string literal there, we CACHE the computed declarations in
//    localStorage under THEME_CSS_CACHE_KEY; the pre-paint script just
//    replays them. THEME_CSS_VERSION invalidates the cache when the token
//    table changes under a returning user.

import { useSyncExternalStore } from "react";
import { hexToOklch, oklchToHex } from "./oklch";
import {
  EXTRA_SURFACES,
  INK_START,
  NEUTRAL_RAMP,
  neutralVar,
  tintPreset,
  type ThemeMode,
} from "./tokens";

export type { ThemeMode };

export const THEME_STORAGE_KEY = "toolbox:theme";
export const THEME_CSS_CACHE_KEY = "toolbox:theme-css";

/** Bump when NEUTRAL_RAMP or the trim/tint maths change, to void stale
 *  caches. Keep in step with the check in app/layout.tsx. */
export const THEME_CSS_VERSION = 2;

/**
 * How far the trim can push a surface, in OKLCH lightness. 0.09 puts
 * `#0a0a0a` (L 0.14) at 0.23 fully lifted and 0.05 fully sunk — a clear
 * move in both directions that never stops reading as "dark mode".
 */
const TRIM_AMPLITUDE = 0.09;

/**
 * Ink follows the surfaces at a quarter rate rather than staying put. Text
 * that holds absolutely still while the background lifts starts to look
 * pasted on; letting it drift along keeps the pairing intact and costs only
 * a little contrast (in dark mode at full lift, separation goes 0.78 → 0.71).
 */
const INK_FOLLOW = 0.25;

/**
 * Chroma the tint adds to a surface at full intensity. 0.045 is a clear hue
 * cast that still reads as "tinted grey" rather than "coloured panel" —
 * past about 0.06 a dark surface stops looking neutral at all.
 */
const MAX_TINT_CHROMA = 0.045;

/**
 * Ink takes half the tint of surfaces. Fully-tinted text fights the hue cast
 * of the panel behind it and costs legibility for no real gain — the tint
 * wants to read as the room's colour, not the writing's.
 */
const INK_TINT = 0.5;

/**
 * Near-white can't hold much chroma in sRGB before the per-channel clip
 * starts bending the hue, so pale surfaces get a lower ceiling. 0.03 is
 * about what a warm off-white (#fdf6e3 and friends) actually carries.
 */
const PALE_TINT_CAP = 0.03;
const PALE_THRESHOLD = 0.9;

export interface ThemeTint {
  /** A TINT_PRESETS id; "none" leaves the ramp neutral. */
  preset: string;
  /** 0 … 1. Scales MAX_TINT_CHROMA. */
  intensity: number;
}

export interface ThemeState {
  mode: ThemeMode;
  /** Per-mode trim, −1 (darker) … +1 (lighter), 0 = the designed ramp. */
  brightness: Record<ThemeMode, number>;
  /**
   * Hue wash over the GREYSCALE tokens only. Global rather than per-mode: a
   * chosen tint is a taste about the product, and having "sepia" evaporate
   * on switching to light mode would read as a bug.
   */
  tint: ThemeTint;
}

const DEFAULT_STATE: ThemeState = {
  mode: "dark",
  brightness: { dark: 0, light: 0 },
  tint: { preset: "none", intensity: 0.5 },
};

let current: ThemeState = DEFAULT_STATE;

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((cb) => cb());

const clampTrim = (v: number): number =>
  !Number.isFinite(v) ? 0 : v < -1 ? -1 : v > 1 ? 1 : v;

const clamp01 = (v: number): number =>
  !Number.isFinite(v) ? 0 : v < 0 ? 0 : v > 1 ? 1 : v;

function readStored(): ThemeState {
  if (typeof window === "undefined") return DEFAULT_STATE;
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as Partial<ThemeState>;
    const mode: ThemeMode = parsed.mode === "light" ? "light" : "dark";
    return {
      mode,
      brightness: {
        dark: clampTrim(Number(parsed.brightness?.dark ?? 0)),
        light: clampTrim(Number(parsed.brightness?.light ?? 0)),
      },
      tint: {
        // tintPreset() falls back to "none" for an unknown id, so a preset
        // renamed in a later build degrades to neutral rather than throwing.
        preset: tintPreset(String(parsed.tint?.preset ?? "none")).id,
        intensity: clamp01(Number(parsed.tint?.intensity ?? 0.5)),
      },
    };
  } catch {
    // Malformed JSON, or localStorage disabled (private mode) — use defaults.
    return DEFAULT_STATE;
  }
}

current = readStored();

/**
 * Applies the brightness trim and the tint to one greyscale token.
 *
 * Both are lightness/chroma edits in OKLCH on the SAME colour, so they're
 * done in one conversion rather than two round-trips through hex — chaining
 * them would quantise twice and drift the hue on the darkest steps.
 */
function adjust(
  hex: string,
  trim: number,
  tintHue: number | null,
  tintChroma: number
): string {
  const { l, c, h } = hexToOklch(hex);
  const nextL = Math.max(0, Math.min(1, l + trim));
  if (tintHue === null || tintChroma <= 0) {
    return trim === 0 ? hex : oklchToHex({ l: nextL, c, h });
  }
  // Pale surfaces clip before they can carry full chroma; ease the ceiling
  // down rather than letting the per-channel clip bend the hue.
  const cap = nextL > PALE_THRESHOLD ? PALE_TINT_CAP : MAX_TINT_CHROMA;
  return oklchToHex({
    l: nextL,
    c: Math.min(tintChroma, cap),
    h: (tintHue * Math.PI) / 180,
  });
}

/**
 * The inline custom-property declarations for a given state, or "" when
 * neither trim nor tint is active (the common case) so the generated ramp in
 * theme-tokens.css shows through untouched.
 *
 * ONLY greyscale tokens are listed here. Accents, socket hues and the derived
 * tints are deliberately absent: tinting the chrome must not restyle an error
 * red or repaint a wire's identity.
 */
function rampDeclarations(state: ThemeState): string {
  const d = state.brightness[state.mode];
  const preset = tintPreset(state.tint.preset);
  const tinting = preset.hue !== null && state.tint.intensity > 0;
  if (d === 0 && !tinting) return "";

  const chroma = tinting ? state.tint.intensity * MAX_TINT_CHROMA : 0;

  const ramp = NEUTRAL_RAMP.map((pair, step) => {
    const isInk = step >= INK_START;
    const trim = d * TRIM_AMPLITUDE * (isInk ? INK_FOLLOW : 1);
    const value = adjust(
      pair[state.mode],
      trim,
      preset.hue,
      chroma * (isInk ? INK_TINT : 1)
    );
    return `${neutralVar(step)}:${value};`;
  });

  // The frame lives outside the ramp but is still a surface, so it has to
  // move with it — a frame that stayed pinned at #000 while every panel
  // lifted would read as a black border round the app.
  const extra = Object.entries(EXTRA_SURFACES).map(
    ([name, pair]) =>
      `${name}:${adjust(pair[state.mode], d * TRIM_AMPLITUDE, preset.hue, chroma)};`
  );

  return [...ramp, ...extra].join("");
}

function applyToDocument(state: ThemeState): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;

  root.dataset.theme = state.mode;

  const css = rampDeclarations(state);
  for (let step = 0; step < NEUTRAL_RAMP.length; step++) {
    root.style.removeProperty(neutralVar(step));
  }
  for (const name of Object.keys(EXTRA_SURFACES)) root.style.removeProperty(name);
  if (css) {
    for (const decl of css.split(";")) {
      if (!decl) continue;
      const i = decl.indexOf(":");
      root.style.setProperty(decl.slice(0, i), decl.slice(i + 1));
    }
  }

  // Feed the pre-paint script in layout.tsx so the next cold load doesn't
  // flash the untrimmed ramp.
  try {
    window.localStorage.setItem(
      THEME_CSS_CACHE_KEY,
      JSON.stringify({ v: THEME_CSS_VERSION, mode: state.mode, css })
    );
  } catch {
    // Cache is an optimisation; a failure just means a brief flash.
  }
}

function persist(state: ThemeState): void {
  try {
    if (typeof window !== "undefined")
      window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore persistence failures; the in-memory value still applies.
  }
}

function commit(next: ThemeState): void {
  current = next;
  persist(next);
  applyToDocument(next);
  emit();
}

export function getTheme(): ThemeState {
  return current;
}

export function setThemeMode(mode: ThemeMode): void {
  if (mode === current.mode) return;
  commit({ ...current, mode });
}

/** Sets the trim for the CURRENTLY ACTIVE mode. −1 … +1. */
export function setThemeBrightness(value: number): void {
  const v = clampTrim(value);
  if (v === current.brightness[current.mode]) return;
  commit({
    ...current,
    brightness: { ...current.brightness, [current.mode]: v },
  });
}

/** Sets the tint hue preset (a TINT_PRESETS id). Global across both modes. */
export function setThemeTintPreset(preset: string): void {
  const id = tintPreset(preset).id;
  if (id === current.tint.preset) return;
  commit({ ...current, tint: { ...current.tint, preset: id } });
}

/** Sets how strongly the tint hue washes the greys. 0 … 1. */
export function setThemeTintIntensity(value: number): void {
  const v = clamp01(value);
  if (v === current.tint.intensity) return;
  commit({ ...current, tint: { ...current.tint, intensity: v } });
}

/**
 * Called once from EffectsApp on mount, mirroring applyStoredUiFont(). The
 * pre-paint script in layout.tsx has usually done this already; this makes
 * the DOM authoritative again after hydration and repairs a stale cache.
 */
export function applyStoredTheme(): void {
  applyToDocument(current);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** React binding for the preferences controls. */
export function useTheme(): {
  mode: ThemeMode;
  brightness: number;
  tintPreset: string;
  tintIntensity: number;
  setMode: (m: ThemeMode) => void;
  setBrightness: (v: number) => void;
  setTintPreset: (id: string) => void;
  setTintIntensity: (v: number) => void;
} {
  const state = useSyncExternalStore(subscribe, getTheme, () => DEFAULT_STATE);
  return {
    mode: state.mode,
    brightness: state.brightness[state.mode],
    tintPreset: state.tint.preset,
    tintIntensity: state.tint.intensity,
    setMode: setThemeMode,
    setBrightness: setThemeBrightness,
    setTintPreset: setThemeTintPreset,
    setTintIntensity: setThemeTintIntensity,
  };
}
