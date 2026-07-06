// Shared color-ramp model + CPU sampler. Lives engine-side so engine
// rasterizers (e.g. per-subpath spline fill in Rasterize Spline) can sample a
// ramp without an engine→nodes import (invariant #1). The Color Ramp node
// re-exports `ColorRampStop` / `COLOR_RAMP_MAX_STOPS` from here for
// back-compat with existing importers.

export interface ColorRampStop {
  id: string;
  position: number; // 0..1
  color: string; // hex, e.g. "#ff00aa"
  // Per-stop opacity in [0, 1]. Optional so stops saved before alpha support
  // keep working — treat `undefined` as fully opaque.
  alpha?: number;
}

export const COLOR_RAMP_MAX_STOPS = 16;

export type ColorRampInterp = "linear" | "ease" | "constant";

function hexToRgb(hex: string): [number, number, number] {
  const h = (hex ?? "#000000").replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(s || "0", 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

// CPU mirror of the Color Ramp node's GLSL `sampleRamp`: sort stops by
// position, clamp to the ends, bracket `t`, and interpolate. `constant` holds
// the left stop; `ease` smoothsteps the blend factor. Returns an `rgba(...)`
// string ready for a Canvas2D fillStyle, honoring per-stop alpha. `t` is
// clamped to [0, 1] by the caller's intent but guarded here too.
export function sampleColorRamp(
  stops: ColorRampStop[],
  t: number,
  interp: ColorRampInterp = "linear"
): string {
  const sorted = [...stops]
    .filter((s) => typeof s.position === "number")
    .sort((a, b) => a.position - b.position)
    .slice(0, COLOR_RAMP_MAX_STOPS);
  const tc = Math.max(0, Math.min(1, t));

  const toRgba = (stop: ColorRampStop): string => {
    const [r, g, b] = hexToRgb(stop.color);
    const a = Math.max(0, Math.min(1, stop.alpha ?? 1));
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  };

  if (sorted.length === 0) {
    const v = Math.round(tc * 255);
    return `rgba(${v}, ${v}, ${v}, 1)`;
  }
  if (sorted.length === 1) return toRgba(sorted[0]);
  if (tc <= sorted[0].position) return toRgba(sorted[0]);
  if (tc >= sorted[sorted.length - 1].position)
    return toRgba(sorted[sorted.length - 1]);

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (tc >= a.position && tc <= b.position) {
      if (interp === "constant") return toRgba(a);
      let f = (tc - a.position) / Math.max(b.position - a.position, 1e-4);
      if (interp === "ease") f = f * f * (3 - 2 * f); // smoothstep
      const [ar, ag, ab] = hexToRgb(a.color);
      const [br, bg, bb] = hexToRgb(b.color);
      const aa = Math.max(0, Math.min(1, a.alpha ?? 1));
      const ba = Math.max(0, Math.min(1, b.alpha ?? 1));
      const r = Math.round(ar + (br - ar) * f);
      const g = Math.round(ag + (bg - ag) * f);
      const bl = Math.round(ab + (bb - ab) * f);
      const al = aa + (ba - aa) * f;
      return `rgba(${r}, ${g}, ${bl}, ${al})`;
    }
  }
  return toRgba(sorted[sorted.length - 1]);
}
