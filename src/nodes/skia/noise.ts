import { defineSkslNode, mirrorParams } from "@/engine/skia/library";
import { perlinNoiseNode } from "../source/perlin-noise";

// Noise (Skia) — the Skia-layer port of Noise (specdocs/101326_skia-target.md
// §3.2), and the reference port for the defineSkslNode factory. The math is
// NOISE_FS's simplex branch line for line: same aspect-corrected sample
// point, seed offset, fBm, W slice blend and contrast, with only Skia's ES2
// rules applied (a float octave count against a constant loop bound). The
// other ten algorithms and the looping evolution are reported unsupported
// until the noise family lands (Wave 2).

const NOISE_SIMPLEX_SKSL = `float tbx_noise_simplex_fbm(float2 p, float octaves, float persistence, float lacunarity) {
  float total = 0.0;
  float amp = 1.0;
  float freq = 1.0;
  float maxAmp = 0.0;
  for (int i = 0; i < 8; i++) {
    if (float(i) >= octaves) break;
    total += tbx_snoise2(p * freq) * amp;
    maxAmp += amp;
    amp *= persistence;
    freq *= lacunarity;
  }
  return total / max(maxAmp, 0.0001);
}

float4 tbx_noise_simplex(float2 uv, float2 res, float scale, float octaves, float persistence,
                         float lacunarity, float offset_x, float offset_y, float seed, float w,
                         float contrast, float4 color_a, float4 color_b, float alpha, float opacity) {
  // The GL node rounds octaves to an int in 1..8 (Math.round = floor(x + 0.5)).
  float oct = clamp(floor(octaves + 0.5), 1.0, 8.0);
  float2 seedOffset = float2(seed * 127.1, seed * 311.7);
  // Aspect-correct so cells stay square: scale counts cells across the width.
  float aspect = res.x / res.y;
  float2 p = (uv - 0.5) * scale;
  p.y /= aspect;
  p += float2(offset_x, offset_y) + seedOffset;
  // W slice blend: smoothstep between hashed integer slices.
  float wi = floor(w);
  float wf = w - wi;
  wf = wf * wf * (3.0 - 2.0 * wf);
  float2 o0 = tbx_noise_slice_offset(wi);
  float n;
  if (wf == 0.0) {
    n = tbx_noise_simplex_fbm(p + o0, oct, persistence, lacunarity);
  } else {
    float2 o1 = tbx_noise_slice_offset(wi + 1.0);
    n = mix(tbx_noise_simplex_fbm(p + o0, oct, persistence, lacunarity),
            tbx_noise_simplex_fbm(p + o1, oct, persistence, lacunarity), wf);
  }
  float t = n * 0.5 + 0.5;
  t = clamp(0.5 + (t - 0.5) * contrast, 0.0, 1.0);
  return float4(mix(color_a.rgb, color_b.rgb, t), alpha * opacity);
}`;

export const skiaNoiseNode = defineSkslNode({
  type: "skia-noise",
  name: "Noise (Skia)",
  mirrors: "noise",
  subcategory: "generator",
  description:
    "Skia-layer Noise: simplex fBm as an SkSL function that fuses into the layer's one runtime shader. Same params as Noise (scale counts cells across the width, octaves, persistence, lacunarity, offset, seed, W evolution, contrast, Color A → B, alpha). The `preview` output renders it through CanvasKit; the shader output feeds other Skia nodes.",
  searchAliases: ["noise", "simplex", "fbm", "skia", "sksl"],
  facts: {
    gotchas: [
      "Only type=simplex is ported; other types and animated=true emit transparent and report unsupported (validateParams rejects them in recipes).",
      "offset_x/offset_y are in noise-lattice units added after scale and the y aspect compression, exactly as Noise; seed adds (127.1, 311.7) per unit.",
      "w is a smoothstep blend between hashed integer slices, so fractional w costs two fBm evaluations; integer w costs one.",
      "opacity is folded into the shader's alpha; the preview output is faded by the evaluator instead, so it is not applied twice.",
    ],
  },
  fn: {
    id: "tbx.noise.simplex@1",
    entry: "tbx_noise_simplex",
    source: NOISE_SIMPLEX_SKSL,
    params: [
      { name: "scale", type: "float" },
      { name: "octaves", type: "float" },
      { name: "persistence", type: "float" },
      { name: "lacunarity", type: "float" },
      { name: "offset_x", type: "float" },
      { name: "offset_y", type: "float" },
      { name: "seed", type: "float" },
      { name: "w", type: "float" },
      { name: "contrast", type: "float" },
      { name: "color_a", type: "color" },
      { name: "color_b", type: "color" },
      { name: "alpha", type: "float" },
      { name: "opacity", type: "float" },
    ],
    inputs: [],
    uses: ["tbx.noise.simplex2d", "tbx.noise.slice"],
    // Up to 8 octaves (4 by default), two fBm passes while w is fractional.
    cost: 4,
  },
  params: mirrorParams(perlinNoiseNode, [
    "opacity",
    "type",
    "scale",
    "octaves",
    "persistence",
    "lacunarity",
    "offset_x",
    "offset_y",
    "seed",
    "w",
    "animated",
    "anim_start",
    "anim_end",
    "anim_rate",
    "contrast",
    "color_a",
    "color_b",
    "alpha",
  ]),
  unsupported(params) {
    const out: string[] = [];
    const type = (params.type as string) ?? "simplex";
    if (type !== "simplex") {
      out.push(`Noise (Skia) supports type=simplex only so far; type=${type} has no SkSL port yet.`);
    }
    if (params.animated === true) {
      out.push("Noise (Skia) does not port the looping evolution (animated) yet — drive `w` from an Animated Value instead.");
    }
    return out;
  },
});
