import {
  COLOR_RAMP_INTERP_OPTIONS,
  COLOR_RAMP_MAX_STOPS,
  COLOR_RAMP_SPACE_OPTIONS,
  normalizeRampInterp,
  normalizeRampSpace,
  type ColorRampStop,
} from "@/engine/color-ramp";
import { bindDerived } from "@/engine/skia/scene-ir";
import { defineSkslNode, mirrorParams, parseSkslColor } from "@/engine/skia/library";
import { colorRampNode } from "../effect/color-ramp";

// Color Ramp (Skia) — the Skia-layer port of Color Ramp
// (specdocs/101326_skia-target.md §3.2). It evaluates makeColorRampSampler
// (engine/color-ramp.ts) per pixel instead of baking the GL node's 1024-texel
// LUT: stops ride as uniform arrays (16 = COLOR_RAMP_MAX_STOPS, Skia needs a
// constant bound) walked by loop index, and only the bracketing pair is
// converted to the blend space. `constant` keeps the LUT's 1/1024 step grid
// so its edges land where the GL node puts them.
//
// Ported: interpolation linear / ease / smoother / sine / ease_in / ease_out
// / constant, spaces srgb / linear / oklab. The spline, Gaussian and OKLCH
// modes need per-ramp precomputation (tangents, a blurred table, gamut
// mapping) and are reported unsupported for now.

const MAX = COLOR_RAMP_MAX_STOPS;
const INTERP_INDEX = (name: string) => (COLOR_RAMP_INTERP_OPTIONS as readonly string[]).indexOf(name);
const SPACE_INDEX = (name: string) => (COLOR_RAMP_SPACE_OPTIONS as readonly string[]).indexOf(name);
const UNPORTED_INTERP = new Set(["cardinal", "monotone", "bspline", "smooth"]);
const UNPORTED_SPACE = new Set(["oklch", "oklch_long"]);

const COLOR_RAMP_SKSL = `float3 tbx_color_ramp_to_working(float3 c, int space) {
  if (space == ${SPACE_INDEX("linear")}) return tbx_srgb_to_linear3(c);
  if (space == ${SPACE_INDEX("oklab")}) return tbx_srgb_to_oklab(c);
  return c;
}

float4 tbx_color_ramp_from_working(float4 v, int space) {
  float3 c;
  if (space == ${SPACE_INDEX("linear")}) c = tbx_linear_to_srgb3(clamp(v.rgb, 0.0, 1.0));
  else if (space == ${SPACE_INDEX("oklab")}) c = tbx_linear_to_srgb3(clamp(tbx_oklab_to_linear(v.rgb), 0.0, 1.0));
  else c = clamp(v.rgb, 0.0, 1.0);
  return float4(c, clamp(v.a, 0.0, 1.0));
}

float4 tbx_color_ramp_knot(float4 c, int space) {
  return float4(tbx_color_ramp_to_working(c.rgb, space), clamp(c.a, 0.0, 1.0));
}

float tbx_color_ramp_remap(float f, int interp) {
  if (interp == ${INTERP_INDEX("ease")}) return f * f * (3.0 - 2.0 * f);
  if (interp == ${INTERP_INDEX("smoother")}) return f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  if (interp == ${INTERP_INDEX("sine")}) return 0.5 - 0.5 * cos(3.141592653589793 * f);
  if (interp == ${INTERP_INDEX("ease_in")}) return f * f;
  if (interp == ${INTERP_INDEX("ease_out")}) return 1.0 - (1.0 - f) * (1.0 - f);
  return f;
}

float4 tbx_color_ramp(float2 uv, float2 res, float stops_pos[${MAX}], float4 stops_color[${MAX}],
                      float stops_count, float offset, int interpolation, int space, float4 src) {
  float t = clamp(tbx_luma709(src.rgb), 0.0, 1.0);
  // offset 0 keeps t = 1 on the last stop; any other offset wraps.
  if (abs(offset) > 1e-8) t = fract(t + offset);
  // The GL node's LUT puts a constant ramp's steps on a 1/1024 grid of t.
  if (interpolation == ${INTERP_INDEX("constant")}) t = (floor(t * 1024.0) + 0.5) / 1024.0;
  float4 ramp;
  if (stops_count < 0.5) {
    ramp = float4(t, t, t, 1.0);
  } else {
    // One walk finds the last stop and the first interval [pa, pb] with
    // t <= pb (makeColorRampSampler's bracket on sorted stops).
    float pfirst = stops_pos[0];
    float4 cfirst = stops_color[0];
    float pa = pfirst;
    float4 ca = cfirst;
    float pb = pfirst;
    float4 cb = cfirst;
    float plast = pfirst;
    float4 clast = cfirst;
    bool found = false;
    for (int i = 1; i < ${MAX}; i++) {
      if (float(i) >= stops_count) break;
      plast = stops_pos[i];
      clast = stops_color[i];
      if (!found) {
        pb = plast;
        cb = clast;
        if (t <= pb) found = true;
        else {
          pa = pb;
          ca = cb;
        }
      }
    }
    float4 w;
    if (t <= pfirst) w = tbx_color_ramp_knot(cfirst, space);
    else if (t >= plast) w = tbx_color_ramp_knot(clast, space);
    else if (interpolation == ${INTERP_INDEX("constant")}) w = tbx_color_ramp_knot(ca, space);
    else {
      float4 wa = tbx_color_ramp_knot(ca, space);
      float4 wb = tbx_color_ramp_knot(cb, space);
      float f = tbx_color_ramp_remap((t - pa) / max(pb - pa, 1e-4), interpolation);
      w = wa + (wb - wa) * f;
    }
    ramp = tbx_color_ramp_from_working(w, space);
  }
  // The ramp decides color; the source's alpha still decides coverage.
  return float4(ramp.rgb, ramp.a * src.a);
}`;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// The stops exactly as makeColorRampSampler sees them: positioned ones,
// sorted (stable), capped at 16, positions clamped, colors parsed.
export function packRampStops(raw: unknown): { pos: number[]; color: number[]; count: number } {
  const sorted = (Array.isArray(raw) ? (raw as ColorRampStop[]) : [])
    .filter((s) => s && typeof s.position === "number")
    .sort((a, b) => a.position - b.position)
    .slice(0, MAX);
  const pos = new Array<number>(MAX).fill(0);
  const color = new Array<number>(MAX * 4).fill(0);
  sorted.forEach((s, i) => {
    pos[i] = clamp01(s.position);
    const [r, g, b] = parseSkslColor(typeof s.color === "string" ? s.color.slice(0, 7) : s.color);
    color.splice(i * 4, 4, r, g, b, clamp01(s.alpha ?? 1));
  });
  return { pos, color, count: sorted.length };
}

export const skiaColorRampNode = defineSkslNode({
  type: "skia-color-ramp",
  name: "Color Ramp (Skia)",
  mirrors: "color-ramp",
  subcategory: "modifier",
  description:
    "Skia-layer Color Ramp: remaps the upstream shader's luminance through the stops, fused into the layer's one runtime shader. Same params as Color Ramp; offset slides and wraps the ramp. Ported: interpolation linear, ease, smoother, sine, ease in/out, constant; color spaces sRGB, linear, OKLab.",
  searchAliases: ["color ramp", "gradient map", "colorize", "skia", "sksl"],
  facts: {
    gotchas: [
      "Remaps Rec.709 luminance of the straight-alpha input; output alpha = stop alpha × input alpha.",
      "interpolation cardinal/monotone/bspline/smooth and space oklch/oklch_long are not ported: the node emits transparent and reports them.",
      "Evaluates the stops per pixel instead of the GL node's 1024-texel LUT; only `constant` keeps the LUT's 1/1024 step grid.",
      "Unwired, the output is opaque black like Color Ramp's; up to 16 stops after sorting by position, extras dropped.",
    ],
  },
  fn: {
    id: "tbx.color_ramp@1",
    entry: "tbx_color_ramp",
    source: COLOR_RAMP_SKSL,
    params: [
      { name: "stops_pos", type: "float", count: MAX },
      { name: "stops_color", type: "color", count: MAX },
      { name: "stops_count", type: "float" },
      { name: "offset", type: "float" },
      { name: "interpolation", type: "int" },
      { name: "space", type: "int" },
    ],
    inputs: [{ name: "src", mode: "pure" }],
    uses: ["tbx.color.luma", "tbx.color.srgb", "tbx.color.oklab"],
    cost: 1,
  },
  params: mirrorParams(colorRampNode, ["stops", "offset", "interpolation", "space"]),
  inputs: [{ name: "image", fnInput: "src" }],
  // The three stop arrays are one param split for Skia: derived binds.
  binds({ params, nodeId }) {
    const { pos, color, count } = packRampStops(params.stops);
    const deps = [{ node: nodeId, param: "stops" }];
    return {
      stops_pos: bindDerived(pos, deps),
      stops_color: bindDerived(color, deps),
      stops_count: bindDerived(count, deps),
    };
  },
  whenUnwired: () => [0, 0, 0, 1],
  unsupported(params) {
    const out: string[] = [];
    const interp = normalizeRampInterp(params.interpolation);
    const space = normalizeRampSpace(params.space);
    if (UNPORTED_INTERP.has(interp)) {
      out.push(`Color Ramp (Skia) does not port interpolation=${interp} yet (linear, ease, smoother, sine, ease_in, ease_out, constant).`);
    }
    if (UNPORTED_SPACE.has(space)) {
      out.push(`Color Ramp (Skia) does not port space=${space} yet (srgb, linear, oklab).`);
    }
    return out;
  },
});
