import { bindDerived } from "@/engine/skia/scene-ir";
import { defineSkslNode, mirrorParams, parseSkslColor } from "@/engine/skia/library";
import { KEYER_MAX_SAMPLES, keyerNode } from "../effect/keyer";

// Keyer (Skia) — the Skia-layer port of Keyer
// (specdocs/101326_skia-target.md §3.2): KEYER_FS line for line — luma,
// color (RGB distance), chroma (CbCr distance) and sample (nearest of up to
// 64 scrubbed colors) mattes, the softness feather, invert and the uniform
// despill. The matte multiplies the source alpha, so the keyed shader is
// the whole result; the GL node's `matte` mask aux has no Skia port (a
// Skia layer reads coverage from alpha).

const MAX = KEYER_MAX_SAMPLES;

const KEYER_SKSL = `float2 tbx_keyer_cbcr(float3 c) {
  float y = dot(c, float3(0.2126, 0.7152, 0.0722));
  return float2((c.b - y) / 1.8556, (c.r - y) / 1.5748);
}

float3 tbx_keyer_despill(float3 rgb, float3 k, float spill) {
  if (k.g >= k.r && k.g >= k.b) {
    rgb.g = mix(rgb.g, min(rgb.g, max(rgb.r, rgb.b)), spill);
  } else if (k.b >= k.r) {
    rgb.b = mix(rgb.b, min(rgb.b, max(rgb.r, rgb.g)), spill);
  } else {
    rgb.r = mix(rgb.r, min(rgb.r, max(rgb.g, rgb.b)), spill);
  }
  return rgb;
}

float4 tbx_keyer(float2 uv, float2 res, int mode, float threshold, float4 key_color, float tolerance,
                 float softness, float spill, int invert, float4 sample_colors[${MAX}], float sample_count,
                 float4 sample_mean, float4 src) {
  // The GL node clamps softness ≥ 0 and spill to 0..1 before upload.
  float soft = max(softness, 0.0);
  float sp = clamp(spill, 0.0, 1.0);
  // Sample mode despills against the mean sample (key_color with none).
  float3 k = mode == 3 ? sample_mean.rgb : key_color.rgb;
  float matte;
  if (mode == 0) {
    float luma = dot(src.rgb, float3(0.2126, 0.7152, 0.0722));
    matte = soft <= 0.0 ? step(threshold, luma)
                        : smoothstep(threshold - soft * 0.5, threshold + soft * 0.5, luma);
  } else {
    float dist;
    if (mode == 1) {
      dist = distance(src.rgb, k) * 0.57735;
    } else if (mode == 2) {
      dist = distance(tbx_keyer_cbcr(src.rgb), tbx_keyer_cbcr(k));
    } else {
      float minD = 1e9;
      for (int i = 0; i < ${MAX}; i++) {
        if (float(i) >= sample_count) break;
        minD = min(minD, distance(src.rgb, sample_colors[i].rgb));
      }
      dist = minD * 0.57735;
    }
    matte = soft <= 0.0 ? step(tolerance, dist) : smoothstep(tolerance, tolerance + soft, dist);
  }
  if (invert == 1) matte = 1.0 - matte;
  float3 rgb = src.rgb;
  if (mode != 0 && sp > 0.0) rgb = tbx_keyer_despill(rgb, k, sp);
  return float4(rgb, src.a * matte);
}`;

// The sample set as the GL node uploads it: hex strings only, first 64,
// and their mean as the despill reference (key_color while empty).
export function packKeyerSamples(raw: unknown, keyColor: unknown): { colors: number[]; count: number; mean: number[] } {
  const samples = (Array.isArray(raw) ? raw : []).filter((s): s is string => typeof s === "string").slice(0, MAX);
  const colors = new Array<number>(MAX * 4).fill(0);
  let mr = 0;
  let mg = 0;
  let mb = 0;
  samples.forEach((s, i) => {
    const [r, g, b] = parseSkslColor(s);
    colors.splice(i * 4, 4, r, g, b, 1);
    mr += r;
    mg += g;
    mb += b;
  });
  const n = samples.length;
  const kc = parseSkslColor(typeof keyColor === "string" ? keyColor : "#00ff00");
  const mean = n ? [mr / n, mg / n, mb / n, 1] : [kc[0], kc[1], kc[2], 1];
  return { colors, count: n, mean };
}

export const skiaKeyerNode = defineSkslNode({
  type: "skia-keyer",
  name: "Keyer (Skia)",
  mirrors: "keyer",
  subcategory: "modifier",
  description:
    "Skia-layer Keyer: keys pixels transparent by luminance (luma), RGB distance to a key color (color), chroma-plane distance (chroma — green screen) or the nearest of a scrubbed color set (sample), with softness, invert and spill suppression. Same params as Keyer; the matte multiplies alpha, fused into the layer's one runtime shader.",
  searchAliases: ["keyer", "chroma key", "green screen", "luma key", "skia", "sksl"],
  facts: {
    gotchas: [
      "threshold applies only in mode=luma; key_color, tolerance and spill only in color/chroma/sample modes.",
      "softness feathers symmetrically around threshold (luma) but only outward past tolerance in the other modes.",
      "sample mode keys by the nearest of up to 64 sample_colors and despills against their mean; empty, it keys nothing.",
      "No matte aux: the matte is the output alpha (source alpha × matte). Unwired, the output is transparent.",
    ],
  },
  fn: {
    id: "tbx.keyer@1",
    entry: "tbx_keyer",
    source: KEYER_SKSL,
    params: [
      { name: "mode", type: "int" },
      { name: "threshold", type: "float" },
      { name: "key_color", type: "color" },
      { name: "tolerance", type: "float" },
      { name: "softness", type: "float" },
      { name: "spill", type: "float" },
      { name: "invert", type: "int" },
      { name: "sample_colors", type: "color", count: MAX },
      { name: "sample_count", type: "float" },
      { name: "sample_mean", type: "color" },
    ],
    inputs: [{ name: "src", mode: "pure" }],
    // Sample mode walks up to 64 colors.
    cost: 1,
  },
  params: mirrorParams(keyerNode, ["mode", "threshold", "key_color", "tolerance", "softness", "spill", "invert", "sample_colors"]),
  inputs: [{ name: "image", fnInput: "src" }],
  // sample_colors is a hidden JSON list: split into a color array, its
  // count, and the despill mean (which also follows key_color while empty).
  binds({ params, nodeId }) {
    const { colors, count, mean } = packKeyerSamples(params.sample_colors, params.key_color);
    const samples = [{ node: nodeId, param: "sample_colors" }];
    return {
      sample_colors: bindDerived(colors, samples),
      sample_count: bindDerived(count, samples),
      sample_mean: bindDerived(mean, [...samples, { node: nodeId, param: "key_color" }]),
    };
  },
  whenUnwired: () => [0, 0, 0, 0],
});
