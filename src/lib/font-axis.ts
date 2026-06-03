// Per-character font-axis modulation.
//
// Each axis in `params.font_variations` can either be:
//   - a plain number (legacy / shorthand for `constant`), or
//   - a tagged object with a `mode` describing how its value
//     varies per-character across the string.
//
// `resolveAxisAt(axis, t, charIndex)` returns the axis value for a
// single character. `t` is the normalised position in the string
// ([0, 1]); charIndex is the absolute character index — kept
// separate so deterministic random can hash on it without
// depending on the total length.
//
// Phase A wires up modes: constant, gradient, sine, random,
// cycle. Phase C will add `perGlyph` (explicit values per char)
// and a path-warp mode (handled in a different rendering path).

export type AxisMode =
  | "constant"
  | "gradient"
  | "sine"
  | "random"
  | "cycle"
  | "perGlyph"
  | "maskDriven";

export type AxisValue =
  | { mode: "constant"; value: number }
  | {
      mode: "gradient";
      from: number;
      to: number;
      // ease shape across the string. 1 = linear, >1 = ease-in,
      // <1 = ease-out. Default 1.
      curve?: number;
    }
  | {
      mode: "sine";
      // value oscillates as: center + amplitude * sin(2π(t*freq + phase))
      center: number;
      amplitude: number;
      frequency: number;
      phase: number;
    }
  | {
      mode: "random";
      min: number;
      max: number;
      // Stable across renders so the random output is repeatable.
      seed: number;
    }
  | {
      mode: "cycle";
      values: number[];
    }
  | {
      // Phase C — explicit per-character values, indexed by
      // absolute character position. `values[charIndex]` is used
      // when set; otherwise we fall back to the axis's default at
      // resolve time. Lets the user dial in each glyph by hand
      // (vs `cycle` which wraps modulo the array length).
      mode: "perGlyph";
      values: number[];
    }
  | {
      // Mask-driven per-glyph. The rasterizer samples the consuming
      // node's `mask` image input at each character's centre, then
      // interpolates between `a` (mask = 0) and `b` (mask = 1) to
      // pick that glyph's axis value. Each character gets ONE value
      // (per-glyph, not sub-pixel) — bright regions of the mask
      // bold up the characters they cover, dark regions leave them
      // thin. When the mask socket is unwired we fall back to `a`.
      mode: "maskDriven";
      a: number;
      b: number;
    };

// Convenience: any of (legacy plain number, undefined, or the full
// AxisValue object) all flow through resolveAxisAt cleanly.
export type AxisInput = number | AxisValue | undefined | null;

export function isModulated(axis: AxisInput): boolean {
  if (axis == null) return false;
  if (typeof axis === "number") return false;
  return axis.mode !== "constant";
}

// Treat undefined / null as "axis not set" and return null. Numbers
// and `{mode:"constant"}` resolve to that constant. Other modes use
// `t` (normalised char position) and `charIndex` (absolute index)
// to produce the per-character value.
//
// `maskValue` is only consulted by the `maskDriven` mode — the
// rasterizer samples the mask image at each character's centre
// and passes the resulting [0, 1] luminance here so we can
// interpolate between the axis's endpoints. `null` means the mask
// socket isn't wired (or sampling failed); maskDriven falls back
// to its `a` endpoint in that case.
export function resolveAxisAt(
  axis: AxisInput,
  t: number,
  charIndex: number,
  maskValue: number | null = null
): number | null {
  if (axis == null) return null;
  if (typeof axis === "number") return axis;
  switch (axis.mode) {
    case "constant":
      return axis.value;
    case "gradient": {
      const c = axis.curve ?? 1;
      const eased = c === 1 ? t : Math.pow(t, c);
      return axis.from + (axis.to - axis.from) * eased;
    }
    case "sine": {
      const phase = axis.phase ?? 0;
      const freq = axis.frequency ?? 1;
      return (
        axis.center +
        axis.amplitude *
          Math.sin(2 * Math.PI * (t * freq + phase))
      );
    }
    case "random": {
      // Deterministic hash on (seed, charIndex). Plain xorshift-ish
      // mix — output in [0, 1).
      const r = hashUnit((axis.seed | 0) + charIndex * 2654435761);
      return axis.min + r * (axis.max - axis.min);
    }
    case "cycle": {
      if (!axis.values || axis.values.length === 0) return null;
      return axis.values[charIndex % axis.values.length];
    }
    case "perGlyph": {
      if (!axis.values || axis.values.length === 0) return null;
      if (charIndex < 0 || charIndex >= axis.values.length) return null;
      const v = axis.values[charIndex];
      if (typeof v !== "number" || !Number.isFinite(v)) return null;
      return v;
    }
    case "maskDriven": {
      // No mask wired → stick to endpoint `a` so the user sees a
      // sensible constant until they hook up the input. With a
      // mask, lerp(a, b, m) per character.
      if (maskValue == null || !Number.isFinite(maskValue)) {
        return axis.a;
      }
      const m = Math.max(0, Math.min(1, maskValue));
      return axis.a + (axis.b - axis.a) * m;
    }
  }
}

// True when nothing about the axis varies across characters — used
// by the rasterizer to skip the per-character layout path in the
// common all-constant case.
export function isAxisDictAllConstant(
  axes: Record<string, AxisInput> | undefined | null
): boolean {
  if (!axes) return true;
  for (const v of Object.values(axes)) {
    if (isModulated(v)) return false;
  }
  return true;
}

// True when any axis is in `maskDriven` mode — signals the
// rasterizer to read the mask socket and sample it per character.
export function hasMaskDriven(
  axes: Record<string, AxisInput> | undefined | null
): boolean {
  if (!axes) return false;
  for (const v of Object.values(axes)) {
    if (v && typeof v === "object" && "mode" in v && v.mode === "maskDriven") {
      return true;
    }
  }
  return false;
}

// Hash an integer to a [0, 1) float. Fast, deterministic, good
// enough for visual noise (not crypto).
function hashUnit(n: number): number {
  let h = n | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 0x100000) / 0x100000;
}

// Coerce whatever's stored in params.font_variations (legacy plain
// numbers, undefined, full mode objects) into a canonical Record
// keyed on axis tag. Values stay in their original shape (number
// or AxisValue) — resolveAxisAt handles both.
export function asAxisDict(
  raw: unknown
): Record<string, AxisInput> {
  if (!raw || typeof raw !== "object") return {};
  return raw as Record<string, AxisInput>;
}

// Normalize an axis value to its canonical AxisValue shape. Plain
// numbers expand to `{mode: "constant", value: number}`. Used by
// the UI when the user flips into a non-constant mode for the
// first time.
export function ensureAxisValueObject(
  axis: AxisInput,
  fallbackDefault: number
): AxisValue {
  if (typeof axis === "number") {
    return { mode: "constant", value: axis };
  }
  if (axis && typeof axis === "object" && "mode" in axis) {
    return axis;
  }
  return { mode: "constant", value: fallbackDefault };
}

// Sensible defaults when the user flips a mode on for the first
// time. Min/max/default come from the font's declared axis range
// so the new mode lands inside the valid envelope.
export function defaultsForMode(
  mode: AxisMode,
  axisMin: number,
  axisMax: number,
  axisDefault: number
): AxisValue {
  const span = axisMax - axisMin;
  switch (mode) {
    case "constant":
      return { mode: "constant", value: axisDefault };
    case "gradient":
      return {
        mode: "gradient",
        from: axisMin,
        to: axisMax,
        curve: 1,
      };
    case "sine":
      return {
        mode: "sine",
        center: axisDefault,
        amplitude: span * 0.25,
        frequency: 1,
        phase: 0,
      };
    case "random":
      return {
        mode: "random",
        min: axisMin,
        max: axisMax,
        seed: 1,
      };
    case "cycle":
      return {
        mode: "cycle",
        values: [axisMin, axisMax],
      };
    case "perGlyph":
      // Seed with a single default — UI will grow the array as
      // the user dials in glyph slots. Resolver falls back to the
      // axis default for any index past the array end.
      return { mode: "perGlyph", values: [axisDefault] };
    case "maskDriven":
      return { mode: "maskDriven", a: axisMin, b: axisMax };
  }
}
