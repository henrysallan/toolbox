// Brush model for the Paint editor (071926_paint-toolkit.md): resolving the
// node's stored settings blob, the built-in presets, and the cached stamp
// bitmaps the stroke engine draws with.

import {
  DEFAULT_BRUSH_SETTINGS,
  type BrushSettingsValue,
} from "@/engine/types";

// A saved preset carries the brush blob plus the node-level size param so
// picking "Pencil" also sets a sensible size.
export interface BrushPreset {
  id: string;
  name: string;
  size: number; // canvas px — applied to the node's `size` param
  brush: BrushSettingsValue;
}

const clamp01 = (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isFinite(v)
    ? Math.max(0, Math.min(1, v))
    : fallback;

// Resolve a stored blob (possibly null / partial / from an older save) to a
// complete settings object. Always returns a fresh object.
export function resolveBrush(stored: unknown): BrushSettingsValue {
  const d = DEFAULT_BRUSH_SETTINGS;
  if (!stored || typeof stored !== "object") return { ...d };
  const s = stored as Partial<BrushSettingsValue>;
  return {
    hardness: clamp01(s.hardness, d.hardness),
    opacity: clamp01(s.opacity, d.opacity),
    flow: clamp01(s.flow, d.flow),
    spacing:
      typeof s.spacing === "number" && Number.isFinite(s.spacing)
        ? Math.max(0.02, Math.min(1, s.spacing))
        : d.spacing,
    smoothing: clamp01(s.smoothing, d.smoothing),
    pressureSize: s.pressureSize ?? d.pressureSize,
    pressureOpacity: s.pressureOpacity ?? d.pressureOpacity,
  };
}

export const BUILTIN_PRESETS: BrushPreset[] = [
  {
    id: "builtin-hard-round",
    name: "Hard Round",
    size: 12,
    brush: {
      hardness: 0.95,
      opacity: 1,
      flow: 1,
      spacing: 0.12,
      smoothing: 0.3,
      pressureSize: true,
      pressureOpacity: false,
    },
  },
  {
    id: "builtin-soft-round",
    name: "Soft Round",
    size: 28,
    brush: {
      hardness: 0.25,
      opacity: 1,
      flow: 0.9,
      spacing: 0.12,
      smoothing: 0.35,
      pressureSize: true,
      pressureOpacity: false,
    },
  },
  {
    id: "builtin-airbrush",
    name: "Airbrush",
    size: 48,
    brush: {
      hardness: 0,
      opacity: 1,
      flow: 0.15,
      spacing: 0.08,
      smoothing: 0.4,
      pressureSize: false,
      pressureOpacity: true,
    },
  },
  {
    id: "builtin-marker",
    name: "Marker",
    size: 18,
    brush: {
      hardness: 0.85,
      opacity: 0.85,
      flow: 1,
      spacing: 0.15,
      smoothing: 0.5,
      pressureSize: false,
      pressureOpacity: false,
    },
  },
  {
    id: "builtin-pencil",
    name: "Pencil",
    size: 4,
    brush: {
      hardness: 1,
      opacity: 0.95,
      flow: 1,
      spacing: 0.25,
      smoothing: 0.15,
      pressureSize: true,
      pressureOpacity: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Stamp cache. One tip bitmap per (diameter, hardness, color); the engine
// draws it thousands of times per stroke, so re-rendering the radial
// gradient per stamp would be silly. Keyed exactly; cleared wholesale when
// it grows past a small cap (size/hardness/color churn is user-paced).

const stampCache = new Map<string, HTMLCanvasElement>();
const STAMP_CACHE_MAX = 64;

export function getStamp(
  diameter: number,
  hardness: number,
  color: string
): HTMLCanvasElement {
  // Quantize so pressure-scaled sizes don't mint a bitmap per pointermove.
  const d = Math.max(1, Math.round(diameter));
  const h = Math.round(Math.max(0, Math.min(1, hardness)) * 100) / 100;
  const key = `${d}|${h}|${color}`;
  const hit = stampCache.get(key);
  if (hit) return hit;
  if (stampCache.size >= STAMP_CACHE_MAX) stampCache.clear();

  const c = document.createElement("canvas");
  c.width = d;
  c.height = d;
  const ctx = c.getContext("2d");
  if (ctx) {
    const r = d / 2;
    if (h >= 0.99 || d <= 2) {
      // Hard disc (tiny brushes skip the gradient — it just antialiases).
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(r, r, r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Solid core out to `hardness`, smoothstep-ish falloff to the rim
      // (two intermediate stops approximate a gaussian shoulder well enough
      // at brush sizes).
      const g = ctx.createRadialGradient(r, r, 0, r, r, r);
      const edge = Math.max(0, Math.min(0.98, h));
      const span = 1 - edge;
      g.addColorStop(0, colorWithAlpha(color, 1));
      g.addColorStop(edge, colorWithAlpha(color, 1));
      g.addColorStop(edge + span * 0.5, colorWithAlpha(color, 0.5));
      g.addColorStop(edge + span * 0.85, colorWithAlpha(color, 0.12));
      g.addColorStop(1, colorWithAlpha(color, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, d, d);
    }
  }
  stampCache.set(key, c);
  return c;
}

// Hex (#rgb / #rrggbb) → rgba() string at the given alpha.
function colorWithAlpha(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const s =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const n = parseInt(s, 16);
  if (!Number.isFinite(n)) return `rgba(255,255,255,${alpha})`;
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
}
