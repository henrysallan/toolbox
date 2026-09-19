// Color-space conversions shared by the keyframe engine (OKLab color
// keyframes) and the color-ramp sampler (091626_ramp-space-interp.md).
// All sRGB values are 0..1, gamma-encoded; "linear" is linear light.
// OKLab / OKLCH per Björn Ottosson's reference coefficients; OKLCH hue is
// degrees, NaN for achromatic colors (chroma below OKLCH_ACHROMATIC).

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export function linearToOklab(
  r: number,
  g: number,
  b: number
): [number, number, number] {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
}

export function oklabToLinear(
  L: number,
  a: number,
  b: number
): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

// sRGB (gamma) → OKLab.
export function rgbToOklab(
  r: number,
  g: number,
  b: number
): [number, number, number] {
  return linearToOklab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b));
}

// OKLab → sRGB (gamma). Unclamped: out-of-gamut input yields values
// outside 0..1, which the caller clips or gamut-maps.
export function oklabToRgb(
  L: number,
  a: number,
  b: number
): [number, number, number] {
  const [r, g, bl] = oklabToLinear(L, a, b);
  return [linearToSrgb(r), linearToSrgb(g), linearToSrgb(bl)];
}

// Below this chroma a color has no meaningful hue.
export const OKLCH_ACHROMATIC = 1e-4;

export function oklabToOklch(
  L: number,
  a: number,
  b: number
): [number, number, number] {
  const C = Math.hypot(a, b);
  const h =
    C < OKLCH_ACHROMATIC
      ? NaN
      : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return [L, C, h];
}

export function oklchToOklab(
  L: number,
  C: number,
  hDeg: number
): [number, number, number] {
  if (!Number.isFinite(hDeg) || C <= 0) return [L, 0, 0];
  const h = (hDeg * Math.PI) / 180;
  return [L, C * Math.cos(h), C * Math.sin(h)];
}

function linearInGamut(rgb: [number, number, number]): boolean {
  return (
    rgb[0] > -0.0005 &&
    rgb[0] < 1.0005 &&
    rgb[1] > -0.0005 &&
    rgb[1] < 1.0005 &&
    rgb[2] > -0.0005 &&
    rgb[2] < 1.0005
  );
}

// OKLCH → sRGB (gamma), gamut-mapped the CSS Color 4 way: keep lightness
// and hue, shrink chroma until the color fits, then clip the residue.
// Interpolating in OKLCH routinely leaves the sRGB gamut mid-ramp (a
// vivid blue→yellow passes through chroma no monitor can show); plain
// clipping there shifts hue and lightness, chroma reduction only dulls.
export function oklchToSrgbGamutMapped(
  L: number,
  C: number,
  hDeg: number
): [number, number, number] {
  const Lc = Math.max(0, Math.min(1, L));
  const at = (c: number) => {
    const [a, b] = oklchToOklab(Lc, c, hDeg).slice(1);
    return oklabToLinear(Lc, a, b);
  };
  let lin = at(C);
  if (!linearInGamut(lin)) {
    let lo = 0;
    let hi = C;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (linearInGamut(at(mid))) lo = mid;
      else hi = mid;
    }
    lin = at(lo);
  }
  return [
    linearToSrgb(Math.max(0, Math.min(1, lin[0]))),
    linearToSrgb(Math.max(0, Math.min(1, lin[1]))),
    linearToSrgb(Math.max(0, Math.min(1, lin[2]))),
  ];
}
