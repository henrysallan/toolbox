// Text animators — stackable, additive, per-character animation for the Text
// node. Each animator drives one property (opacity, position, scale, rotation,
// tracking, color, or a type-on reveal) per glyph. The per-character drive is
// `t ∈ [0,1]`, produced from a keyframable Amount by the animator's driver:
//   uniform  → t = Amount                       (whole-word)
//   field    → t = Amount × field(glyphCentre)  (Amount masters a spatial image)
//   cascade  → t = sweep(Amount, charIndex, …)  (range-selector / type-on)
// and the property value is `lerp(min, max, t)`. Animators stack additively.
// See specdocs/062526_text-animators.md.
//
// Pure module — no GL, no DOM. The Text node parses params into TextAnimators
// and reads any wired field images to pixel buffers; text-raster.ts applies the
// resolved per-glyph result in its modulated (per-character) draw path.

import type { InputSocketDef, ParamDef } from "@/engine/types";

// Property keys. `typeon` is a fixed 0→1 opacity reveal (always cascade);
// `tracking` is index-driven only (it changes advances, so it can't sample a
// field at a centre it would itself move).
export type AnimProp =
  | "typeon"
  | "opacity"
  | "position"
  | "scale"
  | "rotation"
  | "tracking"
  | "color";

export type AnimDriver = "field" | "cascade" | "uniform";
export type CascadeDir = "forward" | "backward" | "center" | "edges" | "random";

// Props that can be driven by an image field (→ get a conditional field input).
export const FIELD_PROPS: AnimProp[] = [
  "opacity",
  "position",
  "scale",
  "rotation",
  "color",
];

interface CascadeCfg {
  softness: number;
  direction: CascadeDir;
  seed: number;
}

interface BaseCfg extends CascadeCfg {
  enabled: boolean;
  amount: number;
  driver: AnimDriver;
}

export interface TextAnimators {
  typeon?: CascadeCfg & { enabled: boolean; amount: number };
  opacity?: BaseCfg & { min: number; max: number };
  position?: BaseCfg & { minX: number; maxX: number; minY: number; maxY: number };
  scale?: BaseCfg & { min: number; max: number };
  rotation?: BaseCfg & { min: number; max: number };
  tracking?: BaseCfg & { min: number; max: number };
  color?: BaseCfg & { min: string; max: string };
}

// Per-glyph resolved result the rasterizer applies (draw pass).
export interface GlyphAnim {
  offsetX: number; // px
  offsetY: number; // px
  scale: number; // multiplicative (1 = unchanged)
  rotation: number; // radians
  alpha: number; // multiplicative (1 = opaque)
  color: string | null; // fill override, or null to keep base
}

// Per-glyph field samples (R/luminance ∈ [0,1]) at the glyph centre, or null
// when that animator has no field wired. Keyed by prop.
export type GlyphFields = Partial<Record<AnimProp, number | null>>;

// ── math ──────────────────────────────────────────────────────────────────

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// Deterministic [0,1) hash for the `random` cascade direction.
function hashUnit(n: number): number {
  let x = (n | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

// Where character `i` sits in the sweep order, [0,1]. Lower = animates earlier.
function charPos(i: number, total: number, dir: CascadeDir, seed: number): number {
  if (total <= 1) return 0;
  const f = i / (total - 1);
  switch (dir) {
    case "backward":
      return 1 - f;
    case "center":
      return Math.abs(f - 0.5) * 2; // centre glyphs first
    case "edges":
      return 1 - Math.abs(f - 0.5) * 2; // edge glyphs first
    case "random":
      return hashUnit(seed + i * 2654435761);
    case "forward":
    default:
      return f;
  }
}

// Range-selector sweep: as `amount` goes 0→1 each char ramps from 0→1 over a
// window of width `softness`, staggered by its position. amount 0 → all 0,
// amount 1 → all 1, monotonic in between.
function sweep(amount: number, i: number, total: number, c: CascadeCfg): number {
  const w = Math.max(0.0001, Math.min(1, c.softness));
  const start = charPos(i, total, c.direction, c.seed) * (1 - w);
  return clamp01((clamp01(amount) - start) / w);
}

function driveT(c: BaseCfg, i: number, total: number, field: number | null): number {
  switch (c.driver) {
    case "field":
      return clamp01(c.amount * (field ?? 1));
    case "cascade":
      return sweep(c.amount, i, total, c);
    case "uniform":
    default:
      return clamp01(c.amount);
  }
}

// hex (#rgb / #rrggbb) → [r,g,b] 0..255; null on parse failure.
function hexRgb(hex: string): [number, number, number] | null {
  const h = (hex || "").replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (s.length !== 6) return null;
  const n = parseInt(s, 16);
  if (!Number.isFinite(n)) return null;
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function lerpColor(a: string, b: string, t: number): string {
  const ca = hexRgb(a);
  const cb = hexRgb(b);
  if (!ca || !cb) return b || a;
  const r = Math.round(lerp(ca[0], cb[0], t));
  const g = Math.round(lerp(ca[1], cb[1], t));
  const bl = Math.round(lerp(ca[2], cb[2], t));
  return `rgb(${r}, ${g}, ${bl})`;
}

// ── resolution ──────────────────────────────────────────────────────────────

// Per-char tracking offset (px) added to the advance in the layout pass.
// Index-driven only — see the module header.
export function resolveTrackingExtra(
  anim: TextAnimators,
  i: number,
  total: number
): number {
  const c = anim.tracking;
  if (!c || !c.enabled) return 0;
  const t = driveT(c, i, total, null);
  return lerp(c.min, c.max, t);
}

// Resolve the per-glyph transform/alpha/color from every active animator.
export function resolveGlyphAnim(
  anim: TextAnimators,
  i: number,
  total: number,
  fields: GlyphFields
): GlyphAnim {
  const out: GlyphAnim = {
    offsetX: 0,
    offsetY: 0,
    scale: 1,
    rotation: 0,
    alpha: 1,
    color: null,
  };

  if (anim.typeon?.enabled) {
    out.alpha *= sweep(anim.typeon.amount, i, total, anim.typeon);
  }
  if (anim.opacity?.enabled) {
    const t = driveT(anim.opacity, i, total, fields.opacity ?? null);
    out.alpha *= lerp(anim.opacity.min, anim.opacity.max, t);
  }
  if (anim.position?.enabled) {
    const t = driveT(anim.position, i, total, fields.position ?? null);
    out.offsetX += lerp(anim.position.minX, anim.position.maxX, t);
    out.offsetY += lerp(anim.position.minY, anim.position.maxY, t);
  }
  if (anim.scale?.enabled) {
    const t = driveT(anim.scale, i, total, fields.scale ?? null);
    out.scale *= lerp(anim.scale.min, anim.scale.max, t);
  }
  if (anim.rotation?.enabled) {
    const t = driveT(anim.rotation, i, total, fields.rotation ?? null);
    out.rotation += (lerp(anim.rotation.min, anim.rotation.max, t) * Math.PI) / 180;
  }
  if (anim.color?.enabled) {
    const t = driveT(anim.color, i, total, fields.color ?? null);
    out.color = lerpColor(anim.color.min, anim.color.max, t);
  }
  return out;
}

// ── param parsing ────────────────────────────────────────────────────────────

const num = (v: unknown, fb: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fb;
const str = (v: unknown, fb: string): string => (typeof v === "string" ? v : fb);
const bool = (v: unknown): boolean => v === true;

function cascadeFrom(params: Record<string, unknown>, p: AnimProp): CascadeCfg {
  return {
    softness: num(params[`anim_${p}_softness`], 0.3),
    direction: str(params[`anim_${p}_direction`], "forward") as CascadeDir,
    seed: num(params[`anim_${p}_seed`], 0),
  };
}

function baseFrom(params: Record<string, unknown>, p: AnimProp): BaseCfg {
  return {
    enabled: bool(params[`anim_${p}_enabled`]),
    amount: num(params[`anim_${p}_amount`], 1),
    driver: str(params[`anim_${p}_driver`], "uniform") as AnimDriver,
    ...cascadeFrom(params, p),
  };
}

export function parseAnimators(params: Record<string, unknown>): TextAnimators {
  return {
    typeon: {
      enabled: bool(params.anim_typeon_enabled),
      amount: num(params.anim_typeon_amount, 1),
      ...cascadeFrom(params, "typeon"),
    },
    opacity: {
      ...baseFrom(params, "opacity"),
      min: num(params.anim_opacity_min, 1),
      max: num(params.anim_opacity_max, 1),
    },
    position: {
      ...baseFrom(params, "position"),
      minX: num(params.anim_position_minX, 0),
      maxX: num(params.anim_position_maxX, 0),
      minY: num(params.anim_position_minY, 0),
      maxY: num(params.anim_position_maxY, 0),
    },
    scale: {
      ...baseFrom(params, "scale"),
      min: num(params.anim_scale_min, 1),
      max: num(params.anim_scale_max, 1),
    },
    rotation: {
      ...baseFrom(params, "rotation"),
      min: num(params.anim_rotation_min, 0),
      max: num(params.anim_rotation_max, 0),
    },
    tracking: {
      ...baseFrom(params, "tracking"),
      min: num(params.anim_tracking_min, 0),
      max: num(params.anim_tracking_max, 0),
    },
    color: {
      ...baseFrom(params, "color"),
      min: str(params.anim_color_min, "#ffffff"),
      max: str(params.anim_color_max, "#ffffff"),
    },
  };
}

const ALL_PROPS: AnimProp[] = [
  "typeon",
  "opacity",
  "position",
  "scale",
  "rotation",
  "tracking",
  "color",
];

export function anyAnimatorActive(params: Record<string, unknown>): boolean {
  return ALL_PROPS.some((p) => bool(params[`anim_${p}_enabled`]));
}

// Compact signature of every animator param, folded into the raster cache key.
export function animatorsSignature(params: Record<string, unknown>): string {
  const keys = Object.keys(params)
    .filter((k) => k.startsWith("anim_"))
    .sort();
  return keys.map((k) => `${k}=${JSON.stringify(params[k])}`).join("|");
}

// ── input sockets (conditional field inputs) ────────────────────────────────

// Field inputs shown only when their animator is enabled AND its driver is
// `field`. Spread into the Text node's resolveInputs after the base inputs.
export function animatorFieldInputs(
  params: Record<string, unknown>
): InputSocketDef[] {
  const out: InputSocketDef[] = [];
  for (const p of FIELD_PROPS) {
    if (bool(params[`anim_${p}_enabled`]) && params[`anim_${p}_driver`] === "field") {
      out.push({
        name: `field_${p}`,
        label: `${cap(p)} field`,
        type: "image",
        required: false,
      });
    }
  }
  return out;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ── param builder ────────────────────────────────────────────────────────────

const DIR_OPTIONS = ["forward", "backward", "center", "edges", "random"];

// Shared rows for one animator: enable, amount, driver, and cascade shaping.
function commonRows(
  p: AnimProp,
  label: string,
  driverModes: string[] | null
): ParamDef[] {
  const en = (q: Record<string, unknown>) => q[`anim_${p}_enabled`] === true;
  // typeon has no driver and is always cascade; others are cascade when their
  // driver enum says so.
  const isCascade = (q: Record<string, unknown>) =>
    en(q) && (p === "typeon" || q[`anim_${p}_driver`] === "cascade");
  const isRandom = (q: Record<string, unknown>) =>
    isCascade(q) && q[`anim_${p}_direction`] === "random";
  const rows: ParamDef[] = [
    // The enable toggle is the group's collapsible header.
    { name: `anim_${p}_enabled`, label, type: "boolean", default: false, group: p, groupHeader: true },
    {
      name: `anim_${p}_amount`,
      label: `Amount`,
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 1,
      visibleIf: en,
      group: p,
    },
  ];
  if (driverModes) {
    rows.push({
      name: `anim_${p}_driver`,
      label: `Driver`,
      type: "enum",
      options: driverModes,
      default: driverModes.includes("uniform") ? "uniform" : driverModes[0],
      visibleIf: en,
      group: p,
    });
  }
  rows.push(
    {
      name: `anim_${p}_softness`,
      label: `Softness`,
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.3,
      visibleIf: isCascade,
      group: p,
    },
    {
      name: `anim_${p}_direction`,
      label: `Direction`,
      type: "enum",
      options: DIR_OPTIONS,
      default: "forward",
      visibleIf: isCascade,
      group: p,
    },
    {
      name: `anim_${p}_seed`,
      label: `Seed`,
      type: "scalar",
      min: 0,
      max: 9999,
      step: 1,
      default: 0,
      visibleIf: isRandom,
      group: p,
    }
  );
  return rows;
}

function scalarRow(
  p: AnimProp,
  key: string,
  label: string,
  opts: { min: number; max: number; softMax?: number; step: number; default: number }
): ParamDef {
  return {
    name: `anim_${p}_${key}`,
    label: `${label}`,
    type: "scalar",
    min: opts.min,
    max: opts.max,
    softMax: opts.softMax,
    step: opts.step,
    default: opts.default,
    visibleIf: (q) => q[`anim_${p}_enabled`] === true,
    group: p,
  };
}

// The full animator param block, spread into the Text node's `params`.
export const TEXT_ANIMATOR_PARAMS: ParamDef[] = [
  // Type On — index reveal (always cascade).
  ...commonRows("typeon", "Type On", null),
  // Opacity.
  ...commonRows("opacity", "Opacity", ["field", "cascade", "uniform"]),
  scalarRow("opacity", "min", "Min", { min: 0, max: 1, step: 0.001, default: 1 }),
  scalarRow("opacity", "max", "Max", { min: 0, max: 1, step: 0.001, default: 1 }),
  // Position (px offsets).
  ...commonRows("position", "Position", ["field", "cascade", "uniform"]),
  scalarRow("position", "minX", "Min X", { min: -1000, max: 1000, softMax: 100, step: 1, default: 0 }),
  scalarRow("position", "maxX", "Max X", { min: -1000, max: 1000, softMax: 100, step: 1, default: 0 }),
  scalarRow("position", "minY", "Min Y", { min: -1000, max: 1000, softMax: 100, step: 1, default: 0 }),
  scalarRow("position", "maxY", "Max Y", { min: -1000, max: 1000, softMax: 100, step: 1, default: 0 }),
  // Scale.
  ...commonRows("scale", "Scale", ["field", "cascade", "uniform"]),
  scalarRow("scale", "min", "Min", { min: 0, max: 4, softMax: 2, step: 0.01, default: 1 }),
  scalarRow("scale", "max", "Max", { min: 0, max: 4, softMax: 2, step: 0.01, default: 1 }),
  // Rotation (degrees).
  ...commonRows("rotation", "Rotation", ["field", "cascade", "uniform"]),
  scalarRow("rotation", "min", "Min", { min: -360, max: 360, softMax: 180, step: 1, default: 0 }),
  scalarRow("rotation", "max", "Max", { min: -360, max: 360, softMax: 180, step: 1, default: 0 }),
  // Tracking (px letter-spacing; index-driven only).
  ...commonRows("tracking", "Tracking", ["cascade", "uniform"]),
  scalarRow("tracking", "min", "Min", { min: -200, max: 400, softMax: 100, step: 1, default: 0 }),
  scalarRow("tracking", "max", "Max", { min: -200, max: 400, softMax: 100, step: 1, default: 0 }),
  // Color.
  ...commonRows("color", "Color", ["field", "cascade", "uniform"]),
  {
    name: "anim_color_min",
    label: "Min",
    type: "color",
    default: "#ffffff",
    visibleIf: (q) => q.anim_color_enabled === true,
    group: "color",
  },
  {
    name: "anim_color_max",
    label: "Max",
    type: "color",
    default: "#ffffff",
    visibleIf: (q) => q.anim_color_enabled === true,
    group: "color",
  },
];
