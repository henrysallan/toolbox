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
import {
  ACCENTS as EDITOR_ACCENTS,
  INK_START,
  NEUTRAL_RAMP,
} from "@/components/effects/theme/tokens";

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
    /**
     * Control-panel width in CSS px BEFORE uiScale (added 2026-09-16).
     * PANEL_WIDTH_RANGE bounds it; 280 is the pre-design fixed width.
     */
    panelWidth: number;
    /**
     * Zoom factor for the whole control panel — text, the inline-styled
     * shared controls, spacing AND the px width scale together (CSS
     * `zoom` on .sidebar, added 2026-09-16). 1 = today's size;
     * UI_SCALE_RANGE bounds it (½× … 2×). The canvas is content, not
     * UI, and is untouched.
     */
    uiScale: number;
    /**
     * Vertical spacing between parameter rows in the panel, CSS px before
     * uiScale (added 2026-09-16). ROW_GAP_RANGE bounds it; 10 is the
     * pre-slider row margin. Rows only — section padding, the label-to-
     * control gap inside a row and the toolbar are unchanged.
     */
    rowGap: number;
    /**
     * Pan / zoom control (091826_live-pan-zoom.md, added 2026-09-18): when
     * true the panel's title row carries a button that lets a visitor pan
     * and zoom the canvas with the editor's own gestures (scroll / pinch /
     * middle-drag / touch). Off = today's fixed framing. The visitor's
     * view is per session; switching the button off resets it.
     */
    panZoom: boolean;
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
    /**
     * Ink intensity 0…1 (added 2026-09-16). 1 = today's text colors;
     * lower fades every text token (--text*, the --tb-n ink steps) toward
     * the panel surface — dark mode literally dims the text, light mode
     * lightens it; either way less contrast. Surfaces, borders and the
     * accent are untouched.
     */
    textBrightness: number;
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
    /** Play / skip-to-start buttons (added 2026-09-15). */
    transport: string;
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

// --- layout slider bounds + designer calibration --------------------------
//
// Both layout knobs are stored in real units (px, a zoom factor) but the
// designer presents them as a 0–100 % POSITION, not a unit — the owner's
// framing (2026-09-16): today's look must read "UI scale · 50 %" (room to
// shrink and to grow) and "Panel width · 25 %". UI scale is logarithmic so
// equal slider travel is an equal size RATIO (0 % = ½×, 50 % = 1×, 100 % =
// 2×); width is linear across PANEL_WIDTH_RANGE (0 % = 160 px, 25 % =
// 280 px, 100 % = 640 px). Calibration is checked by
// scripts/check-live-presets.mts.

export const PANEL_WIDTH_RANGE = { min: 160, max: 640, dflt: 280 } as const;
export const UI_SCALE_RANGE = { min: 0.5, max: 2, dflt: 1 } as const;
/** Row gap is shown in its own unit (px) — no % calibration. */
export const ROW_GAP_RANGE = { min: 0, max: 40, dflt: 10 } as const;

function clampRange(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function uiScaleToPct(scale: number): number {
  return 50 + 50 * Math.log2(scale);
}

export function pctToUiScale(pct: number): number {
  const scale = 2 ** ((pct - 50) / 50);
  // Four decimals: keeps the saved JSON tidy and still round-trips to
  // the same integer percent.
  return clampRange(
    Math.round(scale * 1e4) / 1e4,
    UI_SCALE_RANGE.min,
    UI_SCALE_RANGE.max
  );
}

export function panelWidthToPct(px: number): number {
  const { min, max } = PANEL_WIDTH_RANGE;
  return ((px - min) / (max - min)) * 100;
}

export function pctToPanelWidth(pct: number): number {
  const { min, max } = PANEL_WIDTH_RANGE;
  return Math.round(clampRange(min + (pct / 100) * (max - min), min, max));
}

export const DEFAULT_LIVE_DESIGN: LiveDesign = {
  version: 1,
  layout: {
    canvas: "inset",
    panelSide: "right",
    panelMode: "full-height",
    panelAlign: "top",
    cornerRadius: "none",
    panelWidth: PANEL_WIDTH_RANGE.dflt,
    uiScale: UI_SCALE_RANGE.dflt,
    rowGap: ROW_GAP_RANGE.dflt,
    panZoom: false,
  },
  theme: {
    mode: "dark",
    tintHue: null,
    tintStrength: 0.5,
    panelOpacity: 1,
    panelBlur: 0,
    textBrightness: 1,
  },
  presets: {
    slider: "classic",
    dropdown: "classic",
    numeric: "classic",
    transport: "classic",
    font: "system",
  },
  controls: { order: [], labels: {} },
  export: { image: false, video: false, gif: false, resolution: null },
};

// --- preset registries ---------------------------------------------------
//
// The first entry of each registry is the fallback for unknown ids AND the
// editor-identical look ("classic" — no CSS of its own). Every other entry
// is a rule block in design-presets.css scoped on the matching
// `.live-root[data-<class>="<id>"]`, setting the `--ps-*` custom properties
// the shared controls read (spec M4, landed 2026-09-15; guarded by
// scripts/check-live-presets.mts). `description` is the one-line hint the
// designer's picker shows under the select.

export interface ControlStylePreset {
  id: string;
  label: string;
  description?: string;
}

export interface FontPreset {
  id: string;
  label: string;
  /** CSS font-family stack applied to .live-root. */
  stack: string;
  description?: string;
  /** Reserved for future packs; entries are system stacks only. */
  webfontUrl?: string;
}

export const SLIDER_PRESETS: ControlStylePreset[] = [
  {
    id: "classic",
    label: "Classic",
    description: "The editor's bar slider — filled track, hairline handle.",
  },
  {
    id: "pill",
    label: "Pill",
    description: "Tall fully-rounded bar with a soft fill and a thin marker.",
  },
  {
    id: "dot",
    label: "Dot",
    description: "Thin line, accent-colored fill, round thumb with a halo.",
  },
  {
    id: "ruler",
    label: "Ruler",
    description: "Tick marks along a slim track with a bar marker.",
  },
];

export const DROPDOWN_PRESETS: ControlStylePreset[] = [
  {
    id: "classic",
    label: "Classic",
    description: "The editor's compact dark dropdown.",
  },
  {
    id: "pill",
    label: "Pill",
    description: "Fully rounded filled trigger and a soft rounded list.",
  },
  {
    id: "outline",
    label: "Outline",
    description: "Transparent trigger with a border that lights up on open.",
  },
  {
    id: "inline",
    label: "Inline",
    description: "Label on the left, value on the right, in one rounded card.",
  },
];

export const NUMERIC_PRESETS: ControlStylePreset[] = [
  {
    id: "classic",
    label: "Classic",
    description: "The editor's number field with stacked arrows.",
  },
  {
    id: "split",
    label: "Split stepper",
    description: "− and + buttons flanking a centered value.",
  },
  {
    id: "stacked",
    label: "Stacked stepper",
    description: "Value with a bordered + / − column on the right.",
  },
  {
    id: "plain",
    label: "Plain",
    description: "Borderless numeral, no stepper — drag or type.",
  },
];

export const TRANSPORT_PRESETS: ControlStylePreset[] = [
  {
    id: "classic",
    label: "Classic",
    description: "The editor's playback bar — small boxed icons, green while playing.",
  },
  {
    id: "pill",
    label: "Pill",
    description: "Filled rounded buttons; the play button turns accent while playing.",
  },
  {
    id: "round",
    label: "Round",
    description: "Outlined circles, accent-filled while playing.",
  },
  {
    id: "ghost",
    label: "Ghost",
    description: "Bare icons, no box — accent-colored while playing.",
  },
];

export const FONT_PRESETS: FontPreset[] = [
  {
    id: "system",
    label: "System Sans",
    stack:
      'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    description: "The platform's default interface face.",
  },
  {
    id: "mono",
    label: "System Mono",
    stack:
      'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    description: "Fixed-width — numbers line up.",
  },
  {
    id: "rounded",
    label: "Rounded",
    stack:
      'ui-rounded, "SF Pro Rounded", "Nunito", "Varela Round", "Quicksand", ui-sans-serif, system-ui, sans-serif',
    description: "Soft rounded terminals where the platform has them.",
  },
  {
    id: "serif",
    label: "Serif",
    stack:
      'ui-serif, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif',
    description: "An editorial, bookish panel.",
  },
  {
    id: "geometric",
    label: "Geometric",
    stack:
      '"Avenir Next", Avenir, Futura, "Century Gothic", "Gill Sans", "Trebuchet MS", ui-sans-serif, system-ui, sans-serif',
    description: "Even, circular letterforms.",
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

/**
 * A finite number clamped to [min, max]; anything else — absent, null,
 * NaN, a string — reads as `dflt`. Default BEFORE clamping on purpose: a
 * pre-slider blob must render today's look, not the range's floor.
 */
const numberIn = (
  v: unknown,
  min: number,
  max: number,
  dflt: number
): number =>
  typeof v === "number" && Number.isFinite(v) ? clampRange(v, min, max) : dflt;

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
      panelWidth: Math.round(
        numberIn(
          layout.panelWidth,
          PANEL_WIDTH_RANGE.min,
          PANEL_WIDTH_RANGE.max,
          PANEL_WIDTH_RANGE.dflt
        )
      ),
      uiScale: numberIn(
        layout.uiScale,
        UI_SCALE_RANGE.min,
        UI_SCALE_RANGE.max,
        UI_SCALE_RANGE.dflt
      ),
      rowGap: Math.round(
        numberIn(
          layout.rowGap,
          ROW_GAP_RANGE.min,
          ROW_GAP_RANGE.max,
          ROW_GAP_RANGE.dflt
        )
      ),
      // Off unless the blob says exactly true — a pre-flag design keeps
      // its fixed framing.
      panZoom: layout.panZoom === true,
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
      textBrightness: numberIn(theme.textBrightness, 0, 1, 1),
    },
    presets: {
      slider: presetId(presets.slider, SLIDER_PRESETS),
      dropdown: presetId(presets.dropdown, DROPDOWN_PRESETS),
      numeric: presetId(presets.numeric, NUMERIC_PRESETS),
      transport: presetId(presets.transport, TRANSPORT_PRESETS),
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
 * Text brightness: pull an ink token's OKLCH lightness toward the panel
 * surface's by (1 − k), keeping its chroma and hue so tinted greys stay
 * tinted. k = 1 is the identity; k = 0 lands ON the surface (invisible —
 * the designer's slider floors at 20 %). Lightness-only on purpose: in
 * OKLab equal steps read as equal steps, so the ink ramp keeps its
 * spacing as it fades instead of bunching up at one end.
 */
function fadeToward(hex: string, surfaceL: number, k: number): string {
  const { l, c, h } = hexToOklch(hex);
  return oklchToHex({ l: surfaceL + (l - surfaceL) * k, c, h });
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

/**
 * Design ref of a node's gizmo row (091726_live-gizmos.md) — the same
 * "<nodeId>::<param>" shape control rows use, with a reserved `@gizmo`
 * param no node can declare, so ONE `controls.order` / `controls.labels`
 * covers knobs and on-canvas handles alike.
 */
export const GIZMO_REF_PARAM = "@gizmo";
export function gizmoControlRef(nodeId: string): string {
  return `${nodeId}::${GIZMO_REF_PARAM}`;
}

/** 6-digit hex + alpha → 8-digit hex. */
const hexWithAlpha = (hex: string, alpha: number): string =>
  hex +
  Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");

/** The complete inline var sheet for `.live-root`. */
export function designTokens(design: LiveDesign): Record<string, string> {
  const {
    mode,
    tintHue,
    tintStrength,
    panelOpacity,
    panelBlur,
    textBrightness,
  } = design.theme;
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
  // The editor's accent tokens too (`--tb-a-*`): the shared controls read
  // them for meaning-bearing states — TogglePill's ON fill (blue-500), the
  // dropdown's selected item (yellow-400), validity tints (red/green). Not
  // tinted, exactly like the editor. Without these the exported app (no
  // host tokens at all) rendered those states transparent, and /live
  // half-followed the editor's :root. Per-mode hand-picked pairs, so light
  // mode gets legible counterparts.
  for (const [name, pair] of Object.entries(EDITOR_ACCENTS)) {
    out[`--tb-a-${name}`] = pair[mode];
  }
  // Text brightness (2026-09-16): fade every INK token toward the panel
  // surface (bg-2 — what the text sits on). Ink = the `--text*` family the
  // panel's own labels use PLUS the neutral ramp from INK_START up, which
  // is what the shared controls color their values, glyphs and chevrons
  // with (tokens.ts names those steps "ink"; the slider handle borrows
  // step 12 and fades along, which reads as intended — the whole panel's
  // ink dims together). Applied after tinting so the chroma is already
  // final; < 1 only, so the default sheet is byte-identical to before.
  if (textBrightness < 1) {
    const surfaceL = hexToOklch(out["--bg-2"]).l;
    const fade = (name: string) => {
      out[name] = fadeToward(out[name], surfaceL, textBrightness);
    };
    fade("--text");
    fade("--text-dim");
    fade("--text-faint");
    for (let i = INK_START; i < NEUTRAL_RAMP.length; i++) {
      fade(`--tb-n-${i}`);
    }
  }
  out["--accent"] = ACCENTS[mode];
  // The "playing" state of the classic transport buttons — the editor's
  // PlaybackBar uses a literal emerald fill with a pale mint glyph in both
  // modes, so the live default does too (packs swap in --accent).
  out["--play-bg"] = "#047857";
  out["--play-fg"] = "#d1fae5";
  // Control-panel surface: bg-2 with the author's alpha; backdrop blur
  // only when set (the CSS fallback is `none`, so an absent var costs
  // nothing — a permanent blur(0px) would still create a backdrop root).
  out["--panel-bg"] =
    panelOpacity >= 1
      ? out["--bg-2"]
      : hexWithAlpha(out["--bg-2"], panelOpacity);
  if (panelBlur > 0) {
    out["--panel-backdrop"] = `blur(${Math.round(panelBlur)}px)`;
    // The sticky toolbar (title / transport / export) repaints the panel
    // surface over the rows that scroll under it; at 2× the panel's blur
    // (2026-09-16) those rows smear into a wash instead of ghosting
    // through. Tied to the panel's value rather than a second slider —
    // one knob, and no blur here when the author wants none.
    out["--toolbar-backdrop"] = `blur(${Math.round(panelBlur * 2)}px)`;
  }
  return out;
}
