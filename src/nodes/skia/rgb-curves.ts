import { computeMonotoneTangents } from "@/engine/float-curve";
import { bindDerived, type Bind, type BindRef } from "@/engine/skia/scene-ir";
import { defineSkslNode, mirrorParams } from "@/engine/skia/library";
import { SKSL_CURVE_MAX_POINTS } from "@/engine/skia/library/helpers-color";
import { sanitizeCurvesValue } from "../effect/color-correction";
import { rgbCurvesNode } from "../effect/rgb-curves";

// RGB Curves (Skia) — the Skia-layer port of RGB Curves
// (specdocs/101326_skia-target.md §3.2). The `curves` param splits into four
// packed uniform arrays (x, y, Fritsch–Carlson tangent per point — the
// float-curve model of engine/float-curve.ts, tangents solved here once per
// change) and the shader evaluates the monotone cubic per lookup. To land
// on the GL node's pixels it reproduces the node's 256-entry RGBA8 LUT
// rather than the ideal curve: each lookup evaluates the two LUT entries
// around the input, rounds them to 8 bits and blends them as LINEAR
// filtering does (helpers-color.ts tbx.cf.curve).

const N = SKSL_CURVE_MAX_POINTS;
const CHANNELS = ["rgb", "r", "g", "b"] as const;

export interface PackedCurves {
  // float4 per point: x, y, tangent, 0 — N points per channel.
  rgb: number[];
  r: number[];
  g: number[];
  b: number[];
  // Point counts (master, r, g, b), capped at N.
  count: [number, number, number, number];
  // Channels with more than N points (the shader would drop the rest).
  over: string[];
}

// The curves exactly as the GL nodes' buildLut256 sees them: sanitized
// (clamped, sorted, ≥ 2 points), tangents from computeMonotoneTangents.
export function packCurves(raw: unknown): PackedCurves {
  const curves = sanitizeCurvesValue(raw);
  const out: PackedCurves = { rgb: [], r: [], g: [], b: [], count: [0, 0, 0, 0], over: [] };
  CHANNELS.forEach((ch, k) => {
    const pts = curves[ch];
    if (pts.length > N) out.over.push(`${ch} (${pts.length} points)`);
    const m = computeMonotoneTangents(pts);
    const arr = new Array<number>(N * 4).fill(0);
    pts.slice(0, N).forEach((p, i) => arr.splice(i * 4, 4, p.x, p.y, m[i] ?? 0, 0));
    out[ch] = arr;
    out.count[k] = Math.min(pts.length, N);
  });
  return out;
}

// The five derived binds both curve ports feed their function with.
export function curveBinds(params: Record<string, unknown>, nodeId: string): Record<string, Bind<number | number[]>> {
  const c = packCurves(params.curves);
  const deps: BindRef[] = [{ node: nodeId, param: "curves" }];
  return {
    curves_rgb: bindDerived(c.rgb, deps),
    curves_r: bindDerived(c.r, deps),
    curves_g: bindDerived(c.g, deps),
    curves_b: bindDerived(c.b, deps),
    curves_count: bindDerived([...c.count], deps),
  };
}

export function curveProblems(node: string, params: Record<string, unknown>): string[] {
  const over = packCurves(params.curves).over;
  return over.length ? [`${node} supports up to ${N} points per curve; ${over.join(", ")} has more.`] : [];
}

// Lib params for the curve split (the fused uniforms, in signature order).
export const CURVE_LIB_PARAMS = [
  { name: "curves_rgb", type: "float4" as const, count: N },
  { name: "curves_r", type: "float4" as const, count: N },
  { name: "curves_g", type: "float4" as const, count: N },
  { name: "curves_b", type: "float4" as const, count: N },
  { name: "curves_count", type: "float4" as const },
];

const RGB_CURVES_SKSL = `float4 tbx_rgb_curves(float2 uv, float2 res, float4 curves_rgb[${N}], float4 curves_r[${N}],
                      float4 curves_g[${N}], float4 curves_b[${N}], float4 curves_count, float4 src) {
  return float4(tbx_cf_curves_apply(src.rgb, curves_rgb, curves_r, curves_g, curves_b, curves_count), src.a);
}`;

export const skiaRgbCurvesNode = defineSkslNode({
  type: "skia-rgb-curves",
  name: "RGB Curves (Skia)",
  mirrors: "rgb-curves",
  subcategory: "modifier",
  description:
    "Skia-layer RGB Curves: a master curve on every channel, then the R / G / B curves, fused into the layer's one runtime shader. Same `curves` param as RGB Curves (monotone cubic through the points, up to 16 per curve).",
  searchAliases: ["curves", "rgb curves", "tone curve", "levels", "skia", "sksl"],
  facts: {
    gotchas: [
      "Master (combined) curve first, then each channel's own; alpha passes through.",
      "Reproduces the GL node's 256-entry 8-bit LUT with linear filtering (two curve evaluations per lookup), not the exact curve.",
      "Up to 16 points per curve; more emits transparent and reports it. Unwired, the output is opaque black like RGB Curves'.",
    ],
  },
  fn: {
    id: "tbx.rgb_curves@1",
    entry: "tbx_rgb_curves",
    source: RGB_CURVES_SKSL,
    params: CURVE_LIB_PARAMS,
    inputs: [{ name: "src", mode: "pure" }],
    uses: ["tbx.cf.curve"],
    // 6 lookups × 2 curve evaluations, each a ≤16-step bracket walk.
    cost: 2,
  },
  params: mirrorParams(rgbCurvesNode, ["curves"]),
  inputs: [{ name: "image", fnInput: "src" }],
  binds: ({ params, nodeId }) => curveBinds(params, nodeId),
  whenUnwired: () => [0, 0, 0, 1],
  unsupported: (params) => curveProblems("RGB Curves (Skia)", params),
});
