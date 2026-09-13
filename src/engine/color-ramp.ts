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

const STOP_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function normalizeStopHex(raw: string): string | null {
  const s = raw.trim();
  if (!STOP_HEX.test(s)) return null;
  let h = s.slice(1).toLowerCase();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length === 8 && h.endsWith("ff")) h = h.slice(0, 6);
  return `#${h}`;
}

export function newColorRampStopId(): string {
  return `stop-${Math.random().toString(36).slice(2, 8)}`;
}

// Remote / recipe write of a `color_ramp` param (or a GLSL ramp() channel).
// Same [{position, color, alpha?}] shape both paths accept; ids are minted
// when the caller omits them.
export function vetColorRampStops(
  value: unknown
): { ok: true; value: ColorRampStop[] } | { ok: false; reason: string } {
  if (!Array.isArray(value) || value.length === 0 || value.length > COLOR_RAMP_MAX_STOPS)
    return {
      ok: false,
      reason: `expected 1–${COLOR_RAMP_MAX_STOPS} stops as [{position, color, alpha?}]`,
    };
  const stops: ColorRampStop[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return { ok: false, reason: "each stop must be an object" };
    const rec = raw as Record<string, unknown>;
    const pos = rec.position;
    const hex = typeof rec.color === "string" ? normalizeStopHex(rec.color) : null;
    if (typeof pos !== "number" || !Number.isFinite(pos) || pos < 0 || pos > 1)
      return { ok: false, reason: "stop.position must be a number in 0..1" };
    if (!hex) return { ok: false, reason: 'stop.color must be "#rrggbb"' };
    const alpha =
      typeof rec.alpha === "number" && Number.isFinite(rec.alpha)
        ? Math.max(0, Math.min(1, rec.alpha))
        : hex.length === 9
          ? parseInt(hex.slice(7, 9), 16) / 255
          : undefined;
    stops.push({
      id: typeof rec.id === "string" && rec.id ? rec.id : newColorRampStopId(),
      position: pos,
      color: hex.slice(0, 7),
      ...(alpha !== undefined && alpha < 1 ? { alpha } : {}),
    });
  }
  return { ok: true, value: stops };
}

// Slide `t` by `offset` and wrap into [0, 1). Offset 0 keeps the legacy
// clamp so t=1 still hits the last stop (GLSL `fract(1.0)` would snap it
// to 0). Non-zero offsets loop: 1.2 looks like 0.2, and a sample that
// pushes past 1 re-enters at the start of the ramp. Matches GLSL `fract`
// for negative values (`floor`, not `%`).
export function offsetRampT(t: number, offset = 0): number {
  const tc = Math.max(0, Math.min(1, t));
  if (!(Math.abs(offset) > 1e-8)) return tc;
  const x = tc + offset;
  return x - Math.floor(x);
}

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
// clamped to [0, 1]; a non-zero `offset` wraps (`offsetRampT`) so the
// gradient loops instead of pinning at the last stop.
export function sampleColorRamp(
  stops: ColorRampStop[],
  t: number,
  interp: ColorRampInterp = "linear",
  offset = 0
): string {
  const sorted = [...stops]
    .filter((s) => typeof s.position === "number")
    .sort((a, b) => a.position - b.position)
    .slice(0, COLOR_RAMP_MAX_STOPS);
  const tc = offsetRampT(t, offset);

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

// Numeric sibling of sampleColorRamp for consumers that feed GPU buffers
// rather than Canvas2D fillStyles (first: Diffusion Curves' per-sample
// constraint colors, 072726_diffusion-curves.md). Same stop semantics —
// sort/clamp/bracket, per-stop straight alpha, `ease` smoothsteps,
// `constant` holds the left stop — but returns RGBA in 0..1 without the
// string round-trip (and without the string version's 8-bit rounding).
export function sampleColorRampRgba01(
  stops: ColorRampStop[],
  t: number,
  interp: ColorRampInterp = "linear",
  offset = 0
): [number, number, number, number] {
  const sorted = [...stops]
    .filter((s) => typeof s.position === "number")
    .sort((a, b) => a.position - b.position)
    .slice(0, COLOR_RAMP_MAX_STOPS);
  const tc = offsetRampT(t, offset);

  const toVec = (stop: ColorRampStop): [number, number, number, number] => {
    const [r, g, b] = hexToRgb(stop.color);
    const a = Math.max(0, Math.min(1, stop.alpha ?? 1));
    return [r / 255, g / 255, b / 255, a];
  };

  if (sorted.length === 0) return [tc, tc, tc, 1];
  if (sorted.length === 1) return toVec(sorted[0]);
  if (tc <= sorted[0].position) return toVec(sorted[0]);
  if (tc >= sorted[sorted.length - 1].position)
    return toVec(sorted[sorted.length - 1]);

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (tc >= a.position && tc <= b.position) {
      if (interp === "constant") return toVec(a);
      let f = (tc - a.position) / Math.max(b.position - a.position, 1e-4);
      if (interp === "ease") f = f * f * (3 - 2 * f); // smoothstep
      const va = toVec(a);
      const vb = toVec(b);
      return [
        va[0] + (vb[0] - va[0]) * f,
        va[1] + (vb[1] - va[1]) * f,
        va[2] + (vb[2] - va[2]) * f,
        va[3] + (vb[3] - va[3]) * f,
      ];
    }
  }
  return toVec(sorted[sorted.length - 1]);
}
