// sRGB ↔ OKLab/OKLCH, just enough of it to slide a colour's lightness.
//
// Why OKLab and not "add 10 to each channel": the brightness trim has to
// feel like the SAME amount of lighter at both ends of an 18-step ramp.
// In sRGB it doesn't — a +10 nudge is dramatic on #0a0a0a and invisible on
// #e5e7eb, because sRGB lightness is wildly non-uniform. OKLab is built so
// equal numeric steps read as equal perceptual steps, so one delta applied
// across the whole ramp keeps the ramp's spacing intact.
//
// Björn Ottosson's coefficients (https://bottosson.github.io/posts/oklab/).

export interface Oklch {
  /** Perceptual lightness, 0 (black) … 1 (white). */
  l: number;
  /** Chroma, 0 (grey) … ~0.4 in practice. */
  c: number;
  /** Hue in radians. Meaningless when c ≈ 0. */
  h: number;
}

const srgbToLinear = (v: number): number =>
  v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);

const linearToSrgb = (v: number): number =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** "#rrggbb" → OKLCH. Assumes a 6-digit hex; callers normalise first. */
export function hexToOklch(hex: string): Oklch {
  const r = srgbToLinear(parseInt(hex.slice(1, 3), 16) / 255);
  const g = srgbToLinear(parseInt(hex.slice(3, 5), 16) / 255);
  const b = srgbToLinear(parseInt(hex.slice(5, 7), 16) / 255);

  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;

  return { l: L, c: Math.hypot(a, bb), h: Math.atan2(bb, a) };
}

/** OKLCH → "#rrggbb", gamut-clipped per channel. */
export function oklchToHex({ l, c, h }: Oklch): string {
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;

  const L = l_ * l_ * l_;
  const M = m_ * m_ * m_;
  const S = s_ * s_ * s_;

  // Per-channel clip. Good enough here: the trim only moves lightness on
  // near-neutral greys, which never leave the sRGB gamut anyway.
  const to255 = (v: number): string =>
    Math.round(clamp01(linearToSrgb(v)) * 255)
      .toString(16)
      .padStart(2, "0");

  return (
    "#" +
    to255(4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S) +
    to255(-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S) +
    to255(-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S)
  );
}

/**
 * Shift a hex colour's perceptual lightness by `delta`, leaving chroma and
 * hue alone — so greys stay grey rather than drifting warm or cool.
 */
export function shiftLightness(hex: string, delta: number): string {
  if (delta === 0) return hex;
  const lch = hexToOklch(hex);
  return oklchToHex({ ...lch, l: clamp01(lch.l + delta) });
}
