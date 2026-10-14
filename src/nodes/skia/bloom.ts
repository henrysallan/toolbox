import type { NodeDefinition } from "@/engine/types";
import { mirrorParams } from "@/engine/skia/library";
import { bloomNode } from "../effect/bloom";
import { bindDerived, bindParam, bindStatic, type Bind, type BindRef, type SkiaNode, type SkslProgramIR } from "@/engine/skia/scene-ir";
import { filterProgramSksl, num, runtimeFilter, wrapDrawing } from "./filter-shared";

// Bloom (Skia) — the Skia-layer mirror of Bloom (effect/bloom.ts), as
// native React Native Skia filters plus one runtime threshold program:
//
//   group  layer {}                         isolate: the bloom sees only its content
//     content                               the source, S
//     group  layer { [threshold_j, Blur σ_j], blendMode srcATop }   × levels
//       content
//
// Bloom's mip chain is a sum of `levels` blurred copies of the soft-knee
// bright pass, one per mip, each kernel normalised, added onto the source:
//   out.rgb = src.rgb + intensity · Σ_j w_j · (K_j ⊛ bright),  out.a = src.a
// where w_j is the product of the per-mip tints above level j. Here each
// level is a Gaussian of the SAME variance as that level's path through
// the chain (2×2 bright-pass box, j COD 13-tap downsamples — Karis-averaged
// for the first — j 9-tap tent upsamples with their bilinear taps, the
// final bilinear upsample; bloomLevelSigmas), so a mip chain of 6 becomes
// six blurs whose sigmas are ≈ 1, 3.8, 7.9, 15.9, 32 and 64 px at quality
// high. The threshold program returns the glow as ADDITIVE LIGHT (alpha 0,
// premultiplied rgb): srcATop then composites
//   r = glow·Da + D·(1 − 0) = D + glow·Da,  alpha = Da
// which is exactly Bloom's straight-alpha composite (src + glow, the
// source's alpha) in premultiplied form, for any source alpha. The
// threshold clamps its sample to the canvas, as Bloom's textures clamp,
// so bright content at the edge blooms past it the same way.
//
// Not ported: lens dirt (no image input in a Skia layer yet), the
// bloom_only output, Karis's per-pixel firefly weighting (approximated by
// its effect on the kernel width; isolated 1–2 px highlights glow a little
// brighter here), and HDR: Skia's layers are 8-bit, so a glow level whose
// bright pass × weight exceeds 1 clips before its blur (intensity > ~3).
// Cost on device: the content is drawn levels + 1 times, plus one
// threshold pass and one blur per level.

const BODY = `uniform float b_threshold;
uniform float b_knee;
uniform float3 b_weight;  // intensity × this level's tint product
// Bloom's soft-knee bright pass (THRESHOLD_FS brightenSample), verbatim.
float3 tbx_bloom_brighten(float3 c) {
  float br = max(c.r, max(c.g, c.b));
  float knee = max(b_knee * b_threshold, 1e-4);
  float t = b_threshold - knee;
  float c2 = max(knee * 2.0, 1e-4);
  float d = 0.25 / c2;
  float rq = clamp(br - t, 0.0, c2);
  rq = (rq * rq) * d;
  float gain = max(rq, br - b_threshold) / max(br, 1e-5);
  return c * max(gain, 0.0);
}
float4 tbx_filter(float2 p) {
  // Bloom's textures clamp to the edge texel: so does this sample.
  float2 q = clamp(p, float2(0.5), iResolution.xy - 0.5);
  float4 c = tbx_content(q);
  // Additive light: premultiplied rgb with alpha 0 (srcATop adds it).
  return float4(tbx_bloom_brighten(c.rgb) * b_weight, 0.0);
}`;

export const SKIA_BLOOM_THRESHOLD_SKSL = filterProgramSksl({ name: "Bloom (Skia) bright pass", uniforms: [], body: BODY, premulOut: true });

function hexRgb(hex: unknown): [number, number, number] {
  const h = String(typeof hex === "string" ? hex : "#ffffff").replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6);
  const n = parseInt(s, 16);
  if (!Number.isFinite(n)) return [1, 1, 1];
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

// The mip chain Bloom builds at this size (its own clamps: base = canvas /
// div, the smallest mip ≥ 4 px, ≤ 8 levels, quality's skipped octaves).
export function bloomChain(params: Record<string, unknown>, width: number, height: number): { levels: number; div: number } {
  const quality = String(params.quality ?? "high");
  const div = quality === "performance" ? 8 : quality === "balanced" ? 4 : 2;
  const skip = quality === "performance" ? 2 : quality === "balanced" ? 1 : 0;
  const baseW = Math.max(2, Math.floor(width / div));
  const baseH = Math.max(2, Math.floor(height / div));
  const maxByRes = Math.max(1, Math.floor(Math.log2(Math.min(baseW, baseH)) - 1));
  const raw = num(params.levels, 6);
  const levels = Math.max(1, Math.round(Math.min(8, Math.min(maxByRes, Math.max(1, raw - skip)))));
  return { levels, div };
}

// Per-level Gaussian sigmas (canvas px, [x, y]) with the variance of that
// level's path through Bloom's chain, per axis:
//   bright pass   4 taps ±div/4 px: div 2 → 0.25 px² (pixel centres),
//                 else (div/4)² + 0.25 (each tap a 2-px bilinear average)
//   final         bilinear upsample from mip 0 (texel = div px):
//                 div² · (2div² + 1) / (12 div²) = (2div² + 1) / 12
//   per level i   COD 13-tap downsample of mip i−1 (texel s = div·2^(i−1)):
//                 1.75 s² (offsets 1.5 + the 2×2 bilinear tap 0.25); with
//                 Karis at i = 1 the five groups weigh ~equally: 2.05 s²
//                 tent upsample back to mip i−1: (0.5 a² + 0.75) s² — the
//                 9-tap tent at ±1 dst texel (0.5), its quarter-texel
//                 bilinear taps (0.75), the tent squashed by `a` on the
//                 anamorphic axis (Bloom's mix(1, 0.15, |anamorphic|))
// Level 0 is the bright pass itself (box + final upsample): σ = 1 px.
export function bloomLevelSigmas(params: Record<string, unknown>, width: number, height: number): [number, number][] {
  const { levels, div } = bloomChain(params, width, height);
  const karis = params.karis_average !== false;
  const a = Math.max(-1, Math.min(1, num(params.anamorphic, 0)));
  const sx = a < 0 ? 1 + (0.15 - 1) * -a : 1;
  const sy = a > 0 ? 1 + (0.15 - 1) * a : 1;
  const box = div === 2 ? 0.25 : (div / 4) ** 2 + 0.25;
  const fin = (2 * div * div + 1) / 12;
  const out: [number, number][] = [];
  let vx = box + fin;
  let vy = box + fin;
  for (let j = 0; j < levels; j++) {
    if (j > 0) {
      const s2 = (div * 2 ** (j - 1)) ** 2;
      const down = j === 1 && karis ? 2.05 : 1.75;
      vx += (down + 0.5 * sx * sx + 0.75) * s2;
      vy += (down + 0.5 * sy * sy + 0.75) * s2;
    }
    out.push([Math.sqrt(vx), Math.sqrt(vy)]);
  }
  return out;
}

// Level j's weight: intensity × the product of the tints on its way up
// (Bloom tints each upsample: finalTint_i = 1 − amount + amount·lerp(halo,
// core, 1 − i/(levels−1))).
export function bloomLevelWeights(params: Record<string, unknown>, levels: number): [number, number, number][] {
  const intensity = num(params.intensity, 1);
  const amt = num(params.tint_amount, 0);
  const low = hexRgb(params.tint_low);
  const high = hexRgb(params.tint_high);
  const tint = (i: number): [number, number, number] => {
    const t = levels > 1 ? 1 - i / (levels - 1) : 0;
    return [0, 1, 2].map((k) => 1 - amt + amt * (high[k] + (low[k] - high[k]) * t)) as [number, number, number];
  };
  const out: [number, number, number][] = [];
  let w: [number, number, number] = [1, 1, 1];
  for (let j = 0; j < levels; j++) {
    if (j > 0) {
      const t = tint(j - 1);
      w = [w[0] * t[0], w[1] * t[1], w[2] * t[2]];
    }
    out.push([w[0] * intensity, w[1] * intensity, w[2] * intensity]);
  }
  return out;
}

export const skiaBloomNode: NodeDefinition = {
  type: "skia-bloom",
  name: "Bloom (Skia)",
  category: "image",
  subcategory: "modifier",
  description:
    "Bloom over the Skia drawing wired into it, with Bloom's params: a soft-knee bright pass (a runtime filter), one Gaussian blur per mip level sized like Bloom's mip chain, tinted per level and added over the content (React Native Skia <RuntimeShader> + <Blur> on Group layers). Wire a Skia drawing in and the result into Skia Group or Skia Canvas.",
  searchAliases: ["skia", "bloom", "glow", "highlights", "react native"],
  facts: {
    space: { out: "pixels" },
    gotchas: [
      "Each mip level is one Gaussian blur of the bright pass (sigma ≈ 1, 3.8, 7.9, 16, 32, 64 px at quality high), matched to Bloom's chain; the content is drawn levels + 1 times on device.",
      "The glow adds where the content is (its alpha), exactly like Bloom: a transparent region gets no glow.",
      "Lens dirt and the bloom_only output are not ported; isolated 1-2 px highlights glow slightly brighter than with Karis averaging.",
      "Skia's layers are 8-bit: a level whose glow exceeds 1 before its blur clips (very high intensity), where Bloom keeps float16.",
      "The bright pass is a runtime image filter: native React Native Skia only (RN web has no RuntimeShader filter).",
    ],
  },
  backend: "webgl2",
  skia: { class: "filter", mirrors: "bloom" },
  noMaskInput: true,
  inputs: [{ name: "content", label: "Content", type: "skia_draw", required: true }],
  // Bloom's own ParamDefs, every one of them.
  params: mirrorParams(bloomNode, [
    "threshold",
    "soft_knee",
    "intensity",
    "levels",
    "karis_average",
    "quality",
    "anamorphic",
    "tint_low",
    "tint_high",
    "tint_amount",
  ]),
  primaryOutput: "skia_draw",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const W = ctx.width;
    const H = ctx.height;
    const sigmas = bloomLevelSigmas(params, W, H);
    const weights = bloomLevelWeights(params, sigmas.length);
    const ref = (param: string): BindRef => ({ node: nodeId, param });
    const sigmaDeps = ["anamorphic", "karis_average", "quality", "levels"].map(ref);
    const weightDeps = ["intensity", "tint_low", "tint_high", "tint_amount", "levels"].map(ref);
    const threshold = bindParam(num(params.threshold, 0.7), nodeId, "threshold");
    const knee = bindParam(num(params.soft_knee, 0.5), nodeId, "soft_knee");
    const resolution = bindStatic([W, H, 1]);
    return {
      primary: wrapDrawing(inputs.content, nodeId, [], (content): SkiaNode => ({
        k: "group",
        id: nodeId,
        layer: {},
        children: [
          content,
          ...sigmas.map(([sx, sy], j): SkiaNode => {
            const program: SkslProgramIR = {
              sksl: SKIA_BLOOM_THRESHOLD_SKSL,
              uniforms: {
                iResolution: resolution,
                b_threshold: threshold,
                b_knee: knee,
                b_weight: bindDerived(weights[j], weightDeps) as Bind<number | number[]>,
              },
              children: [],
              fused: [`bloom bright pass (level ${j})`],
            };
            // Two binds even when equal: an animated anamorphic splits them
            // (the emitter writes one blur prop when both read the same).
            const sigmaX = bindDerived(sx, sigmaDeps);
            const sigmaY = bindDerived(sy, sigmaDeps);
            return {
              k: "group",
              id: nodeId,
              layer: { imageFilters: [runtimeFilter(program), { k: "blur", sx: sigmaX, sy: sigmaY, tile: "decal" }], blendMode: "srcATop" },
              children: [content],
            };
          }),
        ],
      })),
    };
  },
};
