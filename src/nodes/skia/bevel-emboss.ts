import { defineSkslNode, mirrorParams } from "@/engine/skia/library";
import { GATHER_EDGE } from "@/engine/skia/library/helpers-gather";
import { bevelEmbossNode } from "../effect/bevel-emboss";
import { isShader, withWiring } from "./gather-wiring";

// Bevel & Emboss (Skia) — the Skia-layer port of Bevel & Emboss's `emboss`
// style (specdocs/101326_skia-target.md §3.2 `sksl-gather`): the height is
// the alpha-weighted luminance of the height input (the image itself while
// height is unwired), lit by the two lights with the shared highlight /
// shadow colors and blend modes — the GL node's FS line for line on its
// u_heightFromJfa == 0 path. The light vectors (CPU in the GL node) are
// built from angle + elevation in the shader so every param ships as its
// own track.
//
// outer-bevel / inner-bevel / pillow-emboss read a JFA signed-distance
// field (engine/sdf.ts: log2(size) passes) — multipass, no gather form —
// and are reported unsupported.

const BEVEL_SKSL = `float tbx_bevel_emboss_height(float2 uv, float2 res) {
  // Luminance of the source, alpha-weighted so transparent areas show no relief.
  float4 c = $height(tbx_gather_edge_uv(uv, res));
  return dot(c.rgb, float3(0.2126, 0.7152, 0.0722)) * c.a;
}

// A 3x3 (1-2-1) Gaussian over +-feather/2 px; single tap while feather is off.
float tbx_bevel_emboss_feathered(float2 uv, float2 res, float feather) {
  if (feather < 0.5) return tbx_bevel_emboss_height(uv, res);
  float2 r = (1.0 / res) * feather * 0.5;
  float s = 0.0;
  s += tbx_bevel_emboss_height(uv + float2(-r.x, -r.y), res) * 1.0;
  s += tbx_bevel_emboss_height(uv + float2(0.0, -r.y), res) * 2.0;
  s += tbx_bevel_emboss_height(uv + float2(r.x, -r.y), res) * 1.0;
  s += tbx_bevel_emboss_height(uv + float2(-r.x, 0.0), res) * 2.0;
  s += tbx_bevel_emboss_height(uv, res) * 4.0;
  s += tbx_bevel_emboss_height(uv + float2(r.x, 0.0), res) * 2.0;
  s += tbx_bevel_emboss_height(uv + float2(-r.x, r.y), res) * 1.0;
  s += tbx_bevel_emboss_height(uv + float2(0.0, r.y), res) * 2.0;
  s += tbx_bevel_emboss_height(uv + float2(r.x, r.y), res) * 1.0;
  return s / 16.0;
}

float3 tbx_bevel_emboss_normal(float2 uv, float2 res, float depth, float soften, float feather) {
  float2 px = 1.0 / res;
  // Soften widens the central-difference stencil.
  float2 st = px * (1.0 + soften * 0.5);
  float hL = tbx_bevel_emboss_feathered(uv - float2(st.x, 0.0), res, feather);
  float hR = tbx_bevel_emboss_feathered(uv + float2(st.x, 0.0), res, feather);
  float hD = tbx_bevel_emboss_feathered(uv - float2(0.0, st.y), res, feather);
  float hU = tbx_bevel_emboss_feathered(uv + float2(0.0, st.y), res, feather);
  // The outward normal is the NEGATIVE gradient (y-up sample space).
  float gx = (hL - hR) / (2.0 * st.x);
  float gy = (hD - hU) / (2.0 * st.y);
  // Depth scales relief strength so the face angle stays consistent.
  float reliefScale = max(depth * min(px.x, px.y), 1e-6);
  return normalize(float3(gx * reliefScale, gy * reliefScale, 1.0));
}

// Bevel & Emboss lightDirection(): azimuth + elevation (degrees) → unit xyz.
float3 tbx_bevel_emboss_light_dir(float angleDeg, float elevDeg) {
  float az = angleDeg * 3.141592653589793 / 180.0;
  float el = elevDeg * 3.141592653589793 / 180.0;
  float ce = cos(el);
  return float3(cos(az) * ce, sin(az) * ce, sin(el));
}

float3 tbx_bevel_emboss_hi(float3 base, float3 layer, float a, int mode) {
  // Options: screen, add, linear-dodge (= add), normal.
  if (mode == 0) return mix(base, float3(1.0) - (float3(1.0) - base) * (float3(1.0) - layer), a);
  if (mode == 1 || mode == 2) return mix(base, min(base + layer, float3(1.0)), a);
  return mix(base, layer, a);
}

float3 tbx_bevel_emboss_sh(float3 base, float3 layer, float a, int mode) {
  // Options: multiply, linear-burn, color-burn (clamped), normal.
  if (mode == 0) return mix(base, base * layer, a);
  if (mode == 1) return mix(base, max(base + layer - float3(1.0), float3(0.0)), a);
  if (mode == 2) {
    float3 cb = float3(1.0) - clamp((float3(1.0) - base) / max(layer, float3(1e-3)), 0.0, 1.0);
    return mix(base, cb, a);
  }
  return mix(base, layer, a);
}

float3 tbx_bevel_emboss_light(float3 col, float3 n, float3 lightDir, float hiOp, float shOp,
                              float3 hiColor, float3 shColor, int hiBlend, int shBlend) {
  // diff > 0: the surface tilts toward the light (highlight side).
  float diff = dot(n, normalize(lightDir));
  if (diff > 0.0) return tbx_bevel_emboss_hi(col, hiColor, hiOp * diff, hiBlend);
  if (diff < 0.0) return tbx_bevel_emboss_sh(col, shColor, shOp * (-diff), shBlend);
  return col;
}

float4 tbx_bevel_emboss(float2 uv, float2 res, float depth, float soften, float feather,
                        float l1_angle, float l1_elevation, float l1_hi_op, float l1_sh_op,
                        float l2_angle, float l2_elevation, float l2_hi_op, float l2_sh_op,
                        float4 highlight_color, float4 shadow_color, int highlight_blend, int shadow_blend,
                        float4 src) {
  float3 n = tbx_bevel_emboss_normal(uv, res, depth, soften, feather);
  float3 col = src.rgb;
  col = tbx_bevel_emboss_light(col, n, tbx_bevel_emboss_light_dir(l1_angle, l1_elevation), l1_hi_op, l1_sh_op,
                               highlight_color.rgb, shadow_color.rgb, highlight_blend, shadow_blend);
  col = tbx_bevel_emboss_light(col, n, tbx_bevel_emboss_light_dir(l2_angle, l2_elevation), l2_hi_op, l2_sh_op,
                               highlight_color.rgb, shadow_color.rgb, highlight_blend, shadow_blend);
  return float4(col, src.a);
}`;

const LIB_PARAMS = [
  "depth",
  "soften",
  "feather",
  "l1_angle",
  "l1_elevation",
  "l1_hi_op",
  "l1_sh_op",
  "l2_angle",
  "l2_elevation",
  "l2_hi_op",
  "l2_sh_op",
] as const;

// Evaluations of the height input per pixel: 4 (central differences), or
// 4 × 9 while feather ≥ 0.5 px turns each into a 3×3 blur.
export function skiaBevelEmbossTaps(params: Record<string, unknown>): { height: number; src: number } {
  const feather = typeof params.feather === "number" ? params.feather : 0;
  return { height: feather < 0.5 ? 4 : 36, src: 1 };
}

const base = defineSkslNode({
  type: "skia-bevel-emboss",
  name: "Bevel & Emboss (Skia)",
  mirrors: "bevel-emboss",
  subcategory: "modifier",
  description:
    "Skia-layer Bevel & Emboss, emboss style: the upstream's luminance (or the height input's) is the height field, shaded by two lights with highlight / shadow colors and blend modes, fused into the layer's one runtime shader. Same params as Bevel & Emboss; the JFA bevel styles (outer, inner, pillow) need a distance-field pass and are not offered.",
  searchAliases: ["bevel", "emboss", "relief", "light", "skia", "sksl"],
  facts: {
    space: { "param:depth": "pixels", "param:soften": "pixels", "param:feather": "pixels" },
    gotchas: [
      "Only style=emboss is ported: outer/inner/pillow read a JFA distance field (multipass), emit transparent and report unsupported.",
      "The height is the alpha-weighted luminance of the height input, or of the image while height is unwired.",
      "4 evaluations of the height per pixel, 36 once feather ≥ 0.5 px (a 3×3 blur per tap): feather is the expensive knob.",
      "depth / soften / feather are canvas pixels (1 / iResolution); on a device they are points.",
    ],
  },
  fn: {
    id: "tbx.bevel_emboss.emboss@1",
    entry: "tbx_bevel_emboss",
    source: BEVEL_SKSL,
    params: [
      ...LIB_PARAMS.map((name) => ({ name, type: "float" as const })),
      { name: "highlight_color", type: "color" },
      { name: "shadow_color", type: "color" },
      { name: "highlight_blend", type: "int" },
      { name: "shadow_blend", type: "int" },
    ],
    inputs: [
      { name: "height", mode: "gather", taps: "param" },
      { name: "src", mode: "pure" },
    ],
    uses: [GATHER_EDGE],
    cost: 0.6,
  },
  params: mirrorParams(bevelEmbossNode, [
    "style",
    ...LIB_PARAMS,
    "highlight_color",
    "shadow_color",
    "highlight_blend",
    "shadow_blend",
  ]),
  inputs: [
    { name: "image", fnInput: "src" },
    { name: "height", label: "Height (override)" },
  ],
  // Image unwired: Bevel & Emboss outputs transparent. (Height is never
  // unwired by itself here — the wrapper below reads the image instead.)
  whenUnwired: () => [0, 0, 0, 0],
  unsupported(params) {
    const style = (params.style as string) ?? "inner-bevel";
    return style === "emboss"
      ? []
      : [`Bevel & Emboss (Skia) ports style=emboss only; style=${style} reads a JFA distance field, a multipass the Skia layer has no gather form for.`];
  },
});

export const skiaBevelEmbossNode = withWiring(base, (inputs) =>
  isShader(inputs.height) || !isShader(inputs.image) ? inputs : { ...inputs, height: inputs.image }
);
