// The editor's colour tokens. Spec: 080226_theme-modes.md.
//
// THE NEUTRAL RAMP IS POSITIONAL, NOT SEMANTIC. `#27272a` is a border in 59
// files and a raised surface in others, so calling it `--tb-border` would be
// wrong half the time. Instead the greys are `--tb-n-0` (deepest) through
// `--tb-n-17` (brightest), and light mode mirrors the ramp end-for-end.
// Every site keeps its RELATIVE position, so nesting relationships invert
// for free: a panel one step darker than its parent becomes one step
// lighter, with no per-site decision. That is what makes the value-based
// codemod (scripts/codemod-theme-tokens.mjs) safe.
//
// Dark values are exactly what the UI used before the theme layer landed,
// so dark mode is unchanged. Near-duplicate greys (#18181b / #1a1a1a /
// #19191c, all inside 0.8% lightness) collapse onto one step — below the
// perceptual floor, and worth it to keep the ramp legible.
//
// Semantic aliases live at the bottom. New code should prefer those; the
// positional names exist because that's what the existing 1,377 call sites
// actually meant.

export type ThemeMode = "dark" | "light";

export interface TokenPair {
  dark: string;
  light: string;
}

/**
 * Ramp step 0 (deepest surface) … 17 (brightest ink).
 *
 * Steps 0–9 are SURFACES, 10–17 are INK. The brightness trim treats the two
 * halves differently (see theme.ts), so this boundary is load-bearing.
 */
export const NEUTRAL_RAMP: TokenPair[] = [
  { dark: "#0a0a0a", light: "#f7f7f8" }, //  0  app bg, sunken inputs
  { dark: "#0f0f12", light: "#f2f2f4" }, //  1
  { dark: "#141417", light: "#ededf0" }, //  2
  { dark: "#18181b", light: "#e8e8ec" }, //  3  standard panel
  { dark: "#1c1c1f", light: "#e3e3e8" }, //  4
  { dark: "#1f1f23", light: "#dedee4" }, //  5  raised row
  { dark: "#232327", light: "#d8d8df" }, //  6
  { dark: "#27272a", light: "#d2d2da" }, //  7  standard border / divider
  { dark: "#2a2a2e", light: "#cbcbd4" }, //  8  hover fill
  { dark: "#3f3f46", light: "#b4b4bf" }, //  9  strong border, active pill
  { dark: "#52525b", light: "#9a9aa6" }, // 10  disabled ink
  { dark: "#71717a", light: "#7c7c86" }, // 11  muted ink
  { dark: "#8a8a90", light: "#63636c" }, // 12
  { dark: "#a1a1aa", light: "#52525b" }, // 13  secondary ink / labels
  { dark: "#c7c7cc", light: "#3a3a42" }, // 14
  { dark: "#d4d4d8", light: "#2e2e35" }, // 15
  { dark: "#e5e7eb", light: "#1f1f24" }, // 16  primary ink
  { dark: "#fafafa", light: "#131317" }, // 17  emphasis ink
];

/** Index of the first INK step. Below this, tokens are surfaces. */
export const INK_START = 10;

/**
 * Every neutral hex the editor actually used, folded onto its ramp step.
 * Left-hand side is lowercase 6-digit; the codemod normalises before lookup.
 */
export const NEUTRAL_ALIASES: Record<string, number> = {
  "#050505": 0, "#0a0a0a": 0,
  "#0c0c0e": 1, "#0f0f0f": 1, "#0f0f11": 1, "#0f0f12": 1, "#101013": 1,
  "#111111": 1, "#111112": 1, "#111113": 1, "#111114": 1,
  "#131315": 2, "#13131a": 2, "#141414": 2, "#141416": 2, "#141417": 2,
  "#15151a": 3, "#161619": 3, "#171719": 3, "#18181b": 3, "#19191c": 3,
  "#1a1a1a": 3, "#1a1a1d": 3,
  "#1a1a1f": 4, "#1b1b1f": 4, "#1c1c1f": 4, "#1c1c20": 4, "#1d1d21": 4,
  "#1e1e22": 5, "#1f1f23": 5, "#202023": 5, "#202024": 5,
  "#212126": 6, "#232327": 6, "#242428": 6,
  "#26262b": 7, "#27272a": 7, "#28282c": 7, "#2a2a2a": 7,
  "#2a2a2e": 8, "#2a2a30": 8, "#2d2d32": 8, "#303036": 8,
  "#3a3a41": 9, "#3f3f46": 9, "#44444c": 9,
  "#4a4a52": 10, "#52525b": 10, "#5a5a62": 10, "#5f5f66": 10,
  "#6b6b73": 11, "#71717a": 11, "#7a7a83": 11,
  "#8a8a90": 12, "#8d9199": 12, "#909097": 12,
  "#9ca3af": 13, "#a1a1aa": 13, "#a8a8b0": 13,
  "#c4c4c8": 14, "#c7c7cc": 14, "#c9c9cf": 14,
  "#d1d1d6": 15, "#d4d4d8": 15, "#d9d9de": 15,
  "#e1e1e1": 16, "#e4e4e7": 16, "#e5e7eb": 16, "#e8e8ec": 16,
  "#f4f4f5": 17, "#fafafa": 17, "#f5f5f5": 17,
};

/**
 * Surfaces that sit OUTSIDE the ramp.
 *
 * `--tb-frame` is the app frame — menu bar, playback bar, panel headers, the
 * backdrop a viewport floats on. Those are pure `#000`, a step below the
 * ramp's own floor (`#0a0a0a`). Folding them into `--tb-n-0` would have been
 * tidy but would have lightened the frame in dark mode, so they keep their
 * own token instead. Trimmed as a surface, like ramp steps 0–9.
 */
export const EXTRA_SURFACES: Record<string, TokenPair> = {
  "--tb-frame": { dark: "#000000", light: "#ffffff" },
};

/**
 * The two directions a translucent wash can go.
 *
 * `rgba(255,255,255,0.08)` doesn't mean "white" — it means "lighten what's
 * behind me by 8%", which on a light surface has to become "darken by 8%".
 * These two tokens let a wash say which direction it meant, and the codemod
 * rewrites washes as
 * `color-mix(in srgb, var(--tb-lift) 8%, transparent)`.
 *
 * Not trimmed: a wash is relative to whatever it sits on, and that surface
 * has already moved.
 */
export const WASHES: Record<string, TokenPair> = {
  "--tb-lift": { dark: "#ffffff", light: "#000000" },
  "--tb-sink": { dark: "#000000", light: "#ffffff" },
};

/**
 * Elevation shadows, as whole `box-shadow` values rather than colours.
 *
 * They can't be a colour token with a shared alpha: a shadow tuned for a dark
 * UI is doing two jobs at once — separating the element from its background
 * AND reading as depth — and on a light surface the first job is already done
 * by the border. Carried over unchanged, a 40%-black drop shadow on a white
 * panel reads as grime. So light mode gets its own tighter, far softer value,
 * not a recoloured version of the dark one.
 */
export const SHADOWS: Record<string, TokenPair> = {
  // Node bodies in the node editor.
  "--tb-shadow-node": {
    dark: "0 2px 8px rgba(0,0,0,0.4)",
    light: "0 1px 3px rgba(0,0,0,0.10)",
  },
  // Small badges/chips that hover off a node's corner.
  "--tb-shadow-chip": {
    dark: "0 1px 4px rgba(0,0,0,0.45)",
    light: "0 1px 2px rgba(0,0,0,0.12)",
  },
  // Popovers, dropdowns, floating menus.
  "--tb-shadow-pop": {
    dark: "0 8px 24px rgba(0,0,0,0.5)",
    light: "0 6px 16px rgba(0,0,0,0.10)",
  },
};

/**
 * One-off tinted colours — the navy layer-node washes, the violet Iterate
 * zone, the cyan "frozen" indicator. Too incidental to name by role, but
 * they can't stay put: a dark navy node body is invisible against a light
 * panel, and pale blue ink is invisible on white.
 *
 * Light values are DERIVED, not hand-picked: same hue, lightness mirrored
 * with the curve fitted to the neutral ramp (L' = 1.11 − 0.93·L), chroma
 * scaled to 0.55 because a pale tint needs less of it to read. Generated by
 * the rule in scripts/codemod-theme-tokens.mts, which only mirrors colours
 * that are unambiguously dark surfaces (L < 0.45) or bright ink (L > 0.75)
 * AND under 0.15 chroma — saturated identity colours (the macOS traffic
 * lights, record red, status dots) all sit outside that window and keep
 * their exact values in both modes.
 */
export const TINTS: Record<string, TokenPair> = {
  "amber-d-0": { dark: "#1f1408", light: "#ece4db" },
  "amber-d-1": { dark: "#6b3308", light: "#c9a590" },
  "cyan-d-0": { dark: "#123c44", light: "#acc3c8" },
  "cyan-d-1": { dark: "#185863", light: "#8aa9af" },
  "cyan-l-0": { dark: "#d1fae5", light: "#0f2018" },
  "cyan-l-1": { dark: "#ecfeff", light: "#0f1617" },
  "cyan-l-2": { dark: "#2dd4bf", light: "#004f45" },
  "cyan-l-3": { dark: "#2dd9d9", light: "#004949" },
  "cyan-l-4": { dark: "#67e8f9", light: "#00383f" },
  "cyan-l-5": { dark: "#a5f3fc", light: "#02292d" },
  "green-d-0": { dark: "#052e16", light: "#c2d9c7" },
  "green-l-0": { dark: "#f0fdf4", light: "#121713" },
  "magenta-d-0": { dark: "#3b0764", light: "#d4bff6" },
  "magenta-l-0": { dark: "#f0abfc", light: "#48294d" },
  "navy-d-0": { dark: "#0b1220", light: "#e5ebf7" },
  "navy-d-1": { dark: "#1f2937", light: "#c8cfd9" },
  "navy-d-2": { dark: "#141c2e", light: "#d7ddeb" },
  "navy-d-3": { dark: "#171b24", light: "#dcdfe6" },
  "navy-d-4": { dark: "#39507a", light: "#93a2bb" },
  "navy-d-5": { dark: "#252b36", light: "#c7cbd3" },
  "navy-d-6": { dark: "#1e376b", light: "#a8badc" },
  "navy-d-7": { dark: "#172a52", light: "#bccae6" },
  "navy-d-8": { dark: "#0f172a", light: "#dde4f3" },
  "navy-l-0": { dark: "#eff6ff", light: "#15181b" },
  "navy-l-1": { dark: "#a5b4fc", light: "#394061" },
  "red-d-0": { dark: "#7f1d1d", light: "#d69a94" },
  "red-d-1": { dark: "#3b1113", light: "#efcecd" },
  "red-l-0": { dark: "#fee2e2", light: "#271c1c" },
  "sky-d-0": { dark: "#0c2733", light: "#c7d7e0" },
  "sky-l-0": { dark: "#38bdf8", light: "#11516d" },
  "sky-l-1": { dark: "#f0f9ff", light: "#131719" },
  "violet-d-0": { dark: "#2a1f4a", light: "#cfcae9" },
  "violet-d-1": { dark: "#1a1430", light: "#e1def4" },
  "violet-d-2": { dark: "#1e1b4b", light: "#ced1f4" },
  "violet-d-3": { dark: "#312e81", light: "#abb2e6" },
  "violet-l-0": { dark: "#c8cdf2", light: "#2e3040" },
  "violet-l-1": { dark: "#c4b5fd", light: "#3d3656" },
  "violet-l-2": { dark: "#ede9fe", light: "#1e1c24" },
};

export const tintVar = (name: string): string => `--tb-t-${name}`;

/**
 * THEME TINT presets — the user-facing "tint the greys" control. Not to be
 * confused with TINTS above, which is the fixed table of one-off tinted
 * colours; this is a hue the whole neutral ramp gets pushed toward at
 * runtime.
 *
 * A preset is just a hue angle. Chroma comes from the intensity slider, and
 * only the GREYSCALE tokens are affected — accents, socket hues and the
 * derived tints keep their own colour, which is the whole point: tinting the
 * chrome must not quietly restyle an error red.
 *
 * `hue` is OKLCH hue in degrees, taken from the Tailwind anchor in `swatch`
 * so the preset reads as the colour on its button.
 */
export interface TintPreset {
  id: string;
  label: string;
  /** OKLCH hue in degrees; null = no tint (pure grey). */
  hue: number | null;
  /** Button swatch. */
  swatch: string;
}

export const TINT_PRESETS: TintPreset[] = [
  { id: "none", label: "None", hue: null, swatch: "#71717a" },
  { id: "slate", label: "Slate", hue: 257.4, swatch: "#64748b" },
  { id: "blue", label: "Blue", hue: 259.8, swatch: "#3b82f6" },
  { id: "indigo", label: "Indigo", hue: 277.1, swatch: "#6366f1" },
  { id: "violet", label: "Violet", hue: 293.5, swatch: "#a78bfa" },
  { id: "teal", label: "Teal", hue: 182.5, swatch: "#14b8a6" },
  { id: "green", label: "Green", hue: 149.6, swatch: "#22c55e" },
  { id: "sepia", label: "Sepia", hue: 49.0, swatch: "#b45309" },
  { id: "rose", label: "Rose", hue: 16.4, swatch: "#f43f5e" },
];

export const tintPreset = (id: string): TintPreset =>
  TINT_PRESETS.find((p) => p.id === id) ?? TINT_PRESETS[0];

/** Reverse index: dark-mode hex → tint name. */
export const TINT_ALIASES: Record<string, string> = Object.fromEntries(
  Object.entries(TINTS).map(([name, pair]) => [pair.dark, name])
);

/**
 * Accents. These carry MEANING (error, warning, selection, success), so they
 * get hand-picked light counterparts rather than an algorithmic flip — a
 * `#1e3a8a` selection fill reads as "deep blue on dark", and its light-mode
 * equivalent is a pale `#bfdbfe` wash, not a mechanically inverted colour.
 *
 * Accents deliberately do NOT respond to the brightness trim; sliding them
 * washes out exactly the states that need to stay loud.
 */
export const ACCENTS: Record<string, TokenPair> = {
  // Blue — selection, info, links.
  "blue-900": { dark: "#1e3a8a", light: "#bfdbfe" },
  "blue-700": { dark: "#1d4ed8", light: "#1d4ed8" },
  "blue-600": { dark: "#2563eb", light: "#1d4ed8" },
  "blue-500": { dark: "#3b82f6", light: "#2563eb" },
  "blue-400": { dark: "#60a5fa", light: "#2563eb" },
  "blue-300": { dark: "#93c5fd", light: "#1d4ed8" },
  "blue-200": { dark: "#bfdbfe", light: "#1e3a8a" },
  "blue-100": { dark: "#dbeafe", light: "#1e3a8a" },
  "navy-tint": { dark: "#26375f", light: "#dbeafe" },
  "navy-deep": { dark: "#1b2741", light: "#eff6ff" },
  "blue-link": { dark: "#115599", light: "#115599" },
  "blue-bright": { dark: "#4a90ff", light: "#2563eb" },

  // Red — errors, destructive actions.
  "red-700": { dark: "#b91c1c", light: "#b91c1c" },
  "red-500": { dark: "#ef4444", light: "#dc2626" },
  "red-400": { dark: "#f87171", light: "#dc2626" },
  "red-300": { dark: "#fca5a5", light: "#b91c1c" },
  "red-200": { dark: "#fecaca", light: "#991b1b" },
  "red-50": { dark: "#fef2f2", light: "#7f1d1d" },

  // Green — success, confirmations.
  "green-800": { dark: "#166534", light: "#dcfce7" },
  "green-600": { dark: "#16a34a", light: "#15803d" },
  "green-500": { dark: "#22c55e", light: "#16a34a" },
  "green-400": { dark: "#4ade80", light: "#16a34a" },
  "green-300": { dark: "#86efac", light: "#15803d" },
  "green-100": { dark: "#dcfce7", light: "#14532d" },
  "green-deep": { dark: "#115500", light: "#dcfce7" },
  "emerald-800": { dark: "#065f46", light: "#d1fae5" },
  "emerald-400": { dark: "#34d399", light: "#059669" },
  "emerald-200": { dark: "#a7f3d0", light: "#065f46" },

  // Amber / yellow — warnings, keyframes, "unsaved".
  "amber-800": { dark: "#92400e", light: "#92400e" },
  "amber-700": { dark: "#b45309", light: "#b45309" },
  "amber-500": { dark: "#f59e0b", light: "#b45309" },
  "amber-400": { dark: "#fbbf24", light: "#d97706" },
  "amber-200": { dark: "#fde68a", light: "#78350f" },
  "amber-100": { dark: "#fef3c7", light: "#78350f" },
  "yellow-500": { dark: "#eab308", light: "#a16207" },
  "yellow-400": { dark: "#facc15", light: "#ca8a04" },

  // Odds and ends.
  "violet-400": { dark: "#a78bfa", light: "#7c3aed" },
  "cyan-400": { dark: "#22d3ee", light: "#0891b2" },
  "gray-700": { dark: "#374151", light: "#d1d5db" },
  "slate-700": { dark: "#334155", light: "#cbd5e1" },
};

/** Reverse index: dark-mode hex → accent name. Built once at module load. */
export const ACCENT_ALIASES: Record<string, string> = Object.fromEntries(
  Object.entries(ACCENTS).map(([name, pair]) => [pair.dark, name])
);

export const neutralVar = (step: number): string => `--tb-n-${step}`;
export const accentVar = (name: string): string => `--tb-a-${name}`;

/**
 * Hex → CSS custom-property name, or null if the colour isn't themed.
 *
 * Returns null for pure black/white on purpose: `#ffffff` and `#000000` have
 * genuinely mixed roles in this codebase (colour-picker gradient stops, param
 * defaults, canvas fillStyle, shadow colours), so blanket substitution would
 * corrupt content. Their handful of real chrome uses are converted by hand.
 */
export function tokenForHex(raw: string): string | null {
  let hex = raw.toLowerCase();
  if (hex.length === 4) hex = "#" + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
  if (hex.length !== 7) return null;
  if (hex === "#ffffff" || hex === "#000000") return null;

  const step = NEUTRAL_ALIASES[hex];
  if (step !== undefined) return neutralVar(step);

  const accent = ACCENT_ALIASES[hex];
  if (accent !== undefined) return accentVar(accent);

  const tint = TINT_ALIASES[hex];
  if (tint !== undefined) return tintVar(tint);

  return null;
}

/**
 * Semantic aliases over the ramp — for NEW code, so it doesn't have to know
 * that "the standard border" happens to be step 7. Emitted as real custom
 * properties that point at the positional ones, so they track the trim.
 */
export const SEMANTIC_ALIASES: Record<string, string> = {
  "--tb-bg": "--tb-n-0",
  "--tb-panel": "--tb-n-3",
  "--tb-panel-raised": "--tb-n-5",
  "--tb-border": "--tb-n-7",
  "--tb-border-strong": "--tb-n-9",
  "--tb-hover": "--tb-n-8",
  "--tb-ink-disabled": "--tb-n-10",
  "--tb-ink-muted": "--tb-n-11",
  "--tb-ink-secondary": "--tb-n-13",
  "--tb-ink": "--tb-n-16",
  "--tb-ink-hi": "--tb-n-17",
};
