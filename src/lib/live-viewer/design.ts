// LiveDesign — the per-project look-and-feel block for the live link and
// the exported standalone app (specdocs/081426_live-link-designer.md).
//
// This module OWNS the shape. `SavedProject.liveDesign` carries it opaquely
// (`unknown`, the layout-block precedent); EffectsApp attaches/applies it
// around serialize/deserialize; LiveClient and the export packager thread a
// validated copy onto the manifest (`ExportManifest.design`), which is the
// ONLY place the viewer reads it from.
//
// It lives under lib/live-viewer/ because the export template bundles this
// directory — nothing here may import editor-only modules. The one editor
// import (theme/oklch) is a pure math leaf, alias-mapped in
// src/export-template/vite.config.ts like KeyframeDiamond.

import { hexToOklch, oklchToHex } from "@/components/effects/theme/oklch";
import { NEUTRAL_RAMP } from "@/components/effects/theme/tokens";

export const LIVE_DESIGN_VERSION = 1;

export type LiveCanvasMode = "inset" | "full-bleed";
export type LivePanelSide = "left" | "right";
export type LivePanelMode = "full-height" | "floating";
export type LivePanelAlign = "top" | "middle" | "bottom";
export type LiveCornerRadius = "none" | "small" | "large";
export type LiveThemeMode = "dark" | "light";

export interface LiveDesign {
  version: 1;
  layout: {
    /** inset = contain in a padded area (today); full-bleed = cover, crop. */
    canvas: LiveCanvasMode;
    panelSide: LivePanelSide;
    /** full-height = flanking column (today); floating = overlay card. */
    panelMode: LivePanelMode;
    /** Vertical anchor of the floating card; full-height ignores it. */
    panelAlign: LivePanelAlign;
    /**
     * Enum, not px — bounded customization. Applied to the inset canvas
     * rect and the floating panel card; meaningless combinations (full-
     * bleed canvas, full-height panel edges) ignore it.
     */
    cornerRadius: LiveCornerRadius;
  };
  theme: {
    mode: LiveThemeMode;
    /** Hue wash over the grey tokens, degrees; null = neutral. */
    tintHue: number | null;
    /** 0…1, scales MAX_TINT_CHROMA — same semantics as the editor tint. */
    tintStrength: number;
    /** Control-panel background alpha, 0…1 (1 = solid, today's look). */
    panelOpacity: number;
    /** Control-panel backdrop blur in px, 0…40 (0 = none). */
    panelBlur: number;
  };
  /**
   * Ids into the registries below. Unknown id → the registry's first
   * entry ("classic"), so removing a pack later degrades instead of
   * breaking saved designs.
   */
  presets: {
    slider: string;
    dropdown: string;
    numeric: string;
    font: string;
  };
  controls: {
    /**
     * Refs "<nodeId>::<paramName>" (ControlPanel's paramKey format), one
     * list covering Controls AND File Inputs rows; each section sorts its
     * own members by index here. Unlisted entries keep manifest order
     * after the ordered ones; stale refs are ignored (nodes get deleted —
     * never an error).
     */
    order: string[];
    /** Ref → rename override. Empty/missing → the default label. */
    labels: Record<string, string>;
  };
  /** Viewer-facing export buttons. All false = no export UI (today). */
  export: {
    image: boolean;
    video: boolean;
    gif: boolean;
    /**
     * Live-link canvas resolution override, [w, h]; null = the
     * project's resolution. Overrides manifest.canvasRes for the whole
     * viewer (render AND capture), not just exports — surfaced in the
     * designer's Export section because that's when dimensions start
     * mattering to the author.
     */
    resolution: [number, number] | null;
  };
}

export const DEFAULT_LIVE_DESIGN: LiveDesign = {
  version: 1,
  layout: {
    canvas: "inset",
    panelSide: "right",
    panelMode: "full-height",
    panelAlign: "top",
    cornerRadius: "none",
  },
  theme: {
    mode: "dark",
    tintHue: null,
    tintStrength: 0.5,
    panelOpacity: 1,
    panelBlur: 0,
  },
  presets: {
    slider: "classic",
    dropdown: "classic",
    numeric: "classic",
    font: "system",
  },
  controls: { order: [], labels: {} },
  export: { image: false, video: false, gif: false, resolution: null },
};

// --- preset registries ---------------------------------------------------
//
// v1 ships the machinery with one pixel-identical "classic" entry per
// control class; real packs land as registry entries + scoped CSS blocks in
// design-presets.css when the owner supplies references (spec M4).

export interface ControlStylePreset {
  id: string;
  label: string;
}

export interface FontPreset {
  id: string;
  label: string;
  /** CSS font-family stack applied to .live-root. */
  stack: string;
  /** Reserved for future packs; v1 entries are system stacks only. */
  webfontUrl?: string;
}

export const SLIDER_PRESETS: ControlStylePreset[] = [
  { id: "classic", label: "Classic" },
];

export const DROPDOWN_PRESETS: ControlStylePreset[] = [
  { id: "classic", label: "Classic" },
];

export const NUMERIC_PRESETS: ControlStylePreset[] = [
  { id: "classic", label: "Classic" },
];

export const FONT_PRESETS: FontPreset[] = [
  {
    id: "system",
    label: "System Sans",
    stack:
      'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
  {
    id: "mono",
    label: "System Mono",
    stack:
      'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  },
];

/** Unknown id → the registry's first entry, never undefined. */
export function resolvePreset<T extends { id: string }>(
  registry: T[],
  id: string
): T {
  return registry.find((p) => p.id === id) ?? registry[0];
}

export const CORNER_RADIUS_PX: Record<LiveCornerRadius, number> = {
  none: 0,
  small: 10,
  large: 20,
};

// --- validation ----------------------------------------------------------

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T =>
  allowed.includes(v as T) ? (v as T) : dflt;

const clamp01 = (v: number): number =>
  !Number.isFinite(v) ? 0 : v < 0 ? 0 : v > 1 ? 1 : v;

/** Sanity caps for untrusted blobs — a live link renders public rows. */
const MAX_ORDER_ENTRIES = 512;
const MAX_LABEL_ENTRIES = 512;
const MAX_LABEL_LENGTH = 120;

/**
 * Validate an untrusted `SavedProject.liveDesign` blob field-by-field,
 * defaulting anything malformed. `undefined`/`null` (project never
 * authored a design) → DEFAULT_LIVE_DESIGN, which renders pixel-identical
 * to the pre-design viewer.
 */
export function fromSavedLiveDesign(saved: unknown): LiveDesign {
  if (typeof saved !== "object" || saved === null) return DEFAULT_LIVE_DESIGN;
  const s = saved as Record<string, unknown>;
  const layout = (s.layout ?? {}) as Record<string, unknown>;
  const theme = (s.theme ?? {}) as Record<string, unknown>;
  const presets = (s.presets ?? {}) as Record<string, unknown>;
  const controls = (s.controls ?? {}) as Record<string, unknown>;
  const exp = (s.export ?? {}) as Record<string, unknown>;

  const rawHue = Number(theme.tintHue);
  const tintHue =
    theme.tintHue === null || !Number.isFinite(rawHue)
      ? null
      : ((rawHue % 360) + 360) % 360;

  const order = Array.isArray(controls.order)
    ? controls.order
        .filter((r): r is string => typeof r === "string")
        .slice(0, MAX_ORDER_ENTRIES)
    : [];

  const labels: Record<string, string> = {};
  if (typeof controls.labels === "object" && controls.labels !== null) {
    for (const [ref, label] of Object.entries(
      controls.labels as Record<string, unknown>
    )) {
      if (typeof label !== "string" || label.length === 0) continue;
      labels[ref] = label.slice(0, MAX_LABEL_LENGTH);
      if (Object.keys(labels).length >= MAX_LABEL_ENTRIES) break;
    }
  }

  const presetId = (v: unknown, registry: { id: string }[]): string =>
    resolvePreset(registry, typeof v === "string" ? v : "").id;

  return {
    version: 1,
    layout: {
      canvas: oneOf(layout.canvas, ["inset", "full-bleed"], "inset"),
      panelSide: oneOf(layout.panelSide, ["left", "right"], "right"),
      panelMode: oneOf(
        layout.panelMode,
        ["full-height", "floating"],
        "full-height"
      ),
      panelAlign: oneOf(
        layout.panelAlign,
        ["top", "middle", "bottom"],
        "top"
      ),
      cornerRadius: oneOf(
        layout.cornerRadius,
        ["none", "small", "large"],
        "none"
      ),
    },
    theme: {
      mode: oneOf(theme.mode, ["dark", "light"], "dark"),
      tintHue,
      tintStrength: clamp01(Number(theme.tintStrength ?? 0.5)),
      // Default BEFORE clamping: clamp01(NaN) is 0, and a pre-panel-
      // opacity blob must read as today's solid panel, not invisible.
      panelOpacity: Number.isFinite(Number(theme.panelOpacity))
        ? clamp01(Number(theme.panelOpacity))
        : 1,
      panelBlur: Number.isFinite(Number(theme.panelBlur))
        ? Math.max(0, Math.min(40, Number(theme.panelBlur)))
        : 0,
    },
    presets: {
      slider: presetId(presets.slider, SLIDER_PRESETS),
      dropdown: presetId(presets.dropdown, DROPDOWN_PRESETS),
      numeric: presetId(presets.numeric, NUMERIC_PRESETS),
      font: presetId(presets.font, FONT_PRESETS),
    },
    controls: { order, labels },
    export: {
      image: exp.image === true,
      video: exp.video === true,
      gif: exp.gif === true,
      resolution: sanitizeResolution(exp.resolution),
    },
  };
}

// Bounds mirror components/effects/res-controls.tsx (MIN_RES/MAX_RES) —
// not imported: that's editor land and the template bundle has no alias
// for it.
const MIN_EXPORT_RES = 16;
const MAX_EXPORT_RES = 8192;

function sanitizeResolution(raw: unknown): [number, number] | null {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const w = Number(raw[0]);
  const h = Number(raw[1]);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  const clampRes = (n: number) =>
    Math.min(MAX_EXPORT_RES, Math.max(MIN_EXPORT_RES, Math.round(n)));
  return [clampRes(w), clampRes(h)];
}

// --- token sheet ---------------------------------------------------------
//
// The complete set of custom properties the viewer consumes, computed in
// TS and applied inline on .live-root. Defining EVERY var here — including
// the `--tb-*` names form-controls.css reads — is what makes the three
// surfaces deterministic: /live can't half-follow the app's theme tokens,
// the exported app can't drift from its fallbacks, and the designer's
// in-editor preview can't inherit the editor theme (the accuracy trap in
// the spec's "Theme + tokens" section).

/**
 * Chroma at full tint strength. Deliberately HIGHER than the editor's
 * 0.045 ceiling (owner call, 2026-08-17): a live link is a presentation
 * surface, so full strength is allowed to read as a clearly colored
 * panel, not just a cast grey. Mid-slider lands near the editor's max.
 */
const MAX_TINT_CHROMA = 0.09;
/** Pale surfaces clip before carrying full chroma; ease the ceiling down. */
const PALE_TINT_CAP = 0.05;
const PALE_THRESHOLD = 0.9;

/** Greyscale ramp per mode. `accent` is deliberately outside the ramp —
 * tint touches greys only, so tinting can't restyle the accent. */
const PALETTES: Record<LiveThemeMode, Record<string, string>> = {
  dark: {
    "--bg-deep": "#050505",
    "--bg": "#0a0a0a",
    "--bg-2": "#111113",
    "--bg-3": "#18181b",
    "--bg-hover": "#232328",
    "--canvas-bg": "#000000",
    "--border": "#27272a",
    "--border-strong": "#3f3f46",
    "--text": "#e5e7eb",
    "--text-dim": "#a1a1aa",
    "--text-faint": "#71717a",
    // The wash-direction token (number-field spinner chrome etc.);
    // the full `--tb-n-*` ramp is generated from NEUTRAL_RAMP below.
    "--tb-lift": "#ffffff",
  },
  light: {
    "--bg-deep": "#ededf0",
    "--bg": "#f7f7f8",
    "--bg-2": "#ffffff",
    "--bg-3": "#ececee",
    "--bg-hover": "#e2e2e6",
    "--canvas-bg": "#ffffff",
    "--border": "#d9d9de",
    "--border-strong": "#b9b9c0",
    "--text": "#1a1a1e",
    "--text-dim": "#56565e",
    "--text-faint": "#8b8b93",
    "--tb-lift": "#000000",
  },
};

const ACCENTS: Record<LiveThemeMode, string> = {
  dark: "#93c5fd",
  light: "#2563eb",
};

/**
 * One OKLCH round-trip per grey token (editor theme.ts `adjust` semantics,
 * minus the brightness trim — the design has no trim knob).
 */
function tintToken(hex: string, hue: number, chroma: number): string {
  const { l } = hexToOklch(hex);
  const cap = l > PALE_THRESHOLD ? PALE_TINT_CAP : MAX_TINT_CHROMA;
  return oklchToHex({
    l,
    c: Math.min(chroma, cap),
    h: (hue * Math.PI) / 180,
  });
}

/**
 * Sort panel entries by the design's control order. Ordered refs first (in
 * order-list position), unlisted entries after them in their incoming
 * (manifest) order. Used by ControlPanel for both the Controls and File
 * Inputs sections, and by the designer's reorder list (spec M2).
 */
export function orderControlRefs<T>(
  entries: T[],
  refOf: (entry: T) => string,
  design: LiveDesign | undefined
): T[] {
  const order = design?.controls.order;
  if (!order || order.length === 0) return entries;
  const index = new Map(order.map((ref, i) => [ref, i] as const));
  return entries
    .map((entry, i) => ({
      entry,
      key: index.get(refOf(entry)) ?? order.length + i,
    }))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.entry);
}

/** 6-digit hex + alpha → 8-digit hex. */
const hexWithAlpha = (hex: string, alpha: number): string =>
  hex +
  Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");

/** The complete inline var sheet for `.live-root`. */
export function designTokens(design: LiveDesign): Record<string, string> {
  const { mode, tintHue, tintStrength, panelOpacity, panelBlur } =
    design.theme;
  const base = PALETTES[mode];
  const chroma = tintHue === null ? 0 : MAX_TINT_CHROMA * tintStrength;
  const out: Record<string, string> = {};
  const grey = (hex: string): string =>
    tintHue === null || chroma <= 0 ? hex : tintToken(hex, tintHue, chroma);
  for (const [name, hex] of Object.entries(base)) {
    out[name] = grey(hex);
  }
  // The FULL editor neutral ramp, from the same source of truth the
  // editor theme is generated from (theme/tokens.ts). The shared
  // ParamControl chrome consumes --tb-n-0..17 throughout, so light mode
  // must flip the whole ramp end-for-end — pinning a subset leaves every
  // other step inheriting the HOST document's (editor-dark) values,
  // which is exactly the half-dark light panel this replaced.
  NEUTRAL_RAMP.forEach((pair, i) => {
    out[`--tb-n-${i}`] = grey(pair[mode]);
  });
  out["--accent"] = ACCENTS[mode];
  // Control-panel surface: bg-2 with the author's alpha; backdrop blur
  // only when set (the CSS fallback is `none`, so an absent var costs
  // nothing — a permanent blur(0px) would still create a backdrop root).
  out["--panel-bg"] =
    panelOpacity >= 1
      ? out["--bg-2"]
      : hexWithAlpha(out["--bg-2"], panelOpacity);
  if (panelBlur > 0) {
    out["--panel-backdrop"] = `blur(${Math.round(panelBlur)}px)`;
  }
  return out;
}
