import type { NodeDefinition } from "@/engine/types";
import { mirrorParams } from "@/engine/skia/library";
import { lensFlareNode } from "../effect/lens-flare";
import { bindDerived, bindParam, bindStatic, type Bind, type BindRef, type ImageFilterIR, type SkiaNode, type SkslProgramIR } from "@/engine/skia/scene-ir";
import { filterProgramSksl, num, runtimeFilter, wrapDrawing } from "./filter-shared";

// Lens Flare (Skia) — the Skia-layer mirror of Lens Flare
// (effect/lens-flare.ts): its bright pass, ghosts + halo and streak as
// runtime image filters (React Native Skia <RuntimeShader>), the two
// branches summed with a `plus` layer:
//
//   group  layer {}                                         isolate
//     group  layer { [bright, ghosts+halo, Blur σ] }         ← content
//     group  layer { [bright, streak, Blur σ], blendMode plus } ← content
//
// Each GL pass is ported line for line in the GL node's own uv frame (Y up,
// 0..1; Skia's Y-down px are flipped on the way in), every sample clamped
// to the canvas like its CLAMP_TO_EDGE textures, ghost UVs wrapped with
// fract as there. Like the GL node the output is the FLARE LAYER ALONE,
// opaque black where there is none (its composite writes alpha 1);
// `output: over` instead adds both branches over the content (both
// layers blendMode plus) — what Lens Flare → Merge (add) gives natively.
// (A Skia Group's own blendMode would not do it: it reaches the draws
// INSIDE a filter's layers, never the layer composite — scene-ir.ts.)
//
// Budget (spec §3.3, 32 texture units / px): ghosts + halo read the bright
// pass 3 × (ghosts + 1) ≤ 27 times, the streak 21 times, each its own
// stage; the bright pass is one content sample. The GL node runs all three
// at half resolution and upsamples; here they run at full resolution and a
// σ = 1.29 px blur stands in for the half-res softening (the 2×2 bright-
// pass box, the half-res bilinear taps and the final bilinear upsample:
// 0.25 + 0.67 + 0.75 px²).

export const LENS_FLARE_SOFTEN_SIGMA = Math.sqrt(0.25 + 2 / 3 + 0.75);

const BRIGHT_BODY = `uniform float lf_threshold;
uniform float lf_knee;
// Lens Flare's bright pass (THRESHOLD_FS brightenSample), verbatim.
float3 tbx_flare_brighten(float3 c) {
  float br = max(c.r, max(c.g, c.b));
  float knee = max(lf_knee * lf_threshold, 1e-4);
  float t = lf_threshold - knee;
  float c2 = max(knee * 2.0, 1e-4);
  float d = 0.25 / c2;
  float rq = clamp(br - t, 0.0, c2);
  rq = (rq * rq) * d;
  float gain = max(rq, br - lf_threshold) / max(br, 1e-5);
  return c * max(gain, 0.0);
}
float4 tbx_filter(float2 p) {
  float2 q = clamp(p, float2(0.5), iResolution.xy - 0.5);
  return float4(tbx_flare_brighten(tbx_content(q).rgb), 1.0);
}`;

// The bright pass at a GL uv (Y up, 0..1), clamped like the GL texture.
const BRIGHT_AT = `float3 tbx_flare_bright(float2 uv) {
  float2 px = clamp(float2(uv.x, 1.0 - uv.y) * iResolution.xy, float2(0.5), iResolution.xy - 0.5);
  return tbx_content(px).rgb;
}
float2 tbx_flare_uv(float2 p) {
  return float2(p.x, iResolution.y - p.y) / iResolution.xy;
}`;

const GHOSTS_BODY = `uniform int lf_ghosts;
uniform float lf_dispersal;
uniform float lf_distortion;
uniform float lf_halo_width;
uniform float lf_halo_intensity;
uniform float3 lf_gain;  // tint × intensity
${BRIGHT_AT}
float3 tbx_flare_ghost_sample(float2 uv, float dist) {
  float2 dir = (float2(0.5) - uv) * lf_distortion * dist;
  float r = tbx_flare_bright(uv + dir * 1.0).r;
  float g = tbx_flare_bright(uv + dir * 0.0).g;
  float b = tbx_flare_bright(uv - dir * 1.0).b;
  return float3(r, g, b);
}
float tbx_flare_edge_falloff(float2 uv) {
  float2 d = float2(1.0) - 2.0 * abs(uv - 0.5);
  return clamp(min(d.x, d.y), 0.0, 1.0);
}
float4 tbx_filter(float2 p) {
  float2 v_uv = tbx_flare_uv(p);
  float2 ghostVec = (float2(0.5) - v_uv) * lf_dispersal;
  float3 ghosts = float3(0.0);
  for (int i = 1; i <= 8; i++) {
    if (i > lf_ghosts) break;
    float2 uv = fract(v_uv + ghostVec * float(i));
    float weight = pow(max(1.0 - distance(uv, float2(0.5)) * 2.0, 0.0), 6.0);
    ghosts += tbx_flare_ghost_sample(uv, float(i)) * weight;
  }
  ghosts *= tbx_flare_edge_falloff(v_uv);
  float2 haloDir = normalize(float2(0.5) - v_uv) * lf_halo_width;
  float2 haloUv = v_uv + haloDir;
  float haloWeight = pow(max(1.0 - abs(distance(haloUv, float2(0.5)) - 0.45), 0.0), 12.0);
  float3 halo = tbx_flare_ghost_sample(haloUv, 1.0) * haloWeight * lf_halo_intensity;
  halo *= tbx_flare_edge_falloff(v_uv);
  return float4((ghosts + halo) * lf_gain, 1.0);
}`;

const STREAK_BODY = `uniform float2 lf_dir;
uniform float lf_length;
uniform float lf_strength;
uniform float3 lf_gain;  // tint × intensity
${BRIGHT_AT}
float4 tbx_filter(float2 p) {
  float2 v_uv = tbx_flare_uv(p);
  float3 acc = float3(0.0);
  float wsum = 0.0;
  for (int i = -10; i <= 10; i++) {
    float t = float(i) / 10.0;
    float w = 1.0 - abs(t);
    acc += tbx_flare_bright(v_uv + lf_dir * t * lf_length) * w;
    wsum += w;
  }
  acc /= max(wsum, 1e-4);
  return float4(acc * lf_strength * lf_gain, 1.0);
}`;

export const SKIA_LENS_FLARE_BRIGHT_SKSL = filterProgramSksl({ name: "Lens Flare (Skia) bright pass", uniforms: [], body: BRIGHT_BODY });
export const SKIA_LENS_FLARE_GHOSTS_SKSL = filterProgramSksl({ name: "Lens Flare (Skia) ghosts + halo", uniforms: [], body: GHOSTS_BODY });
export const SKIA_LENS_FLARE_STREAK_SKSL = filterProgramSksl({ name: "Lens Flare (Skia) streak", uniforms: [], body: STREAK_BODY });

function hexRgb(hex: unknown): [number, number, number] {
  const h = String(typeof hex === "string" ? hex : "#ffffff").replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6);
  const n = parseInt(s, 16);
  if (!Number.isFinite(n)) return [1, 1, 1];
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

function axisVec(name: unknown): [number, number] {
  return name === "vertical" ? [0, 1] : name === "diagonal" ? [Math.SQRT1_2, Math.SQRT1_2] : [1, 0];
}

export const skiaLensFlareNode: NodeDefinition = {
  type: "skia-lens-flare",
  name: "Lens Flare (Skia)",
  category: "image",
  subcategory: "modifier",
  description:
    "Lens Flare over the Skia drawing wired into it, with Lens Flare's params: chromatic ghosts, a halo ring and a streak from its soft-knee bright pass, as runtime image filters (React Native Skia <RuntimeShader>). Outputs the FLARE LAYER ONLY on opaque black, like Lens Flare, or with output=over the flare added over the content (Lens Flare → Merge add).",
  searchAliases: ["skia", "lens flare", "flare", "ghosts", "halo", "streak", "react native"],
  facts: {
    space: {
      out: "pixels",
      "param:ghost_dispersal": "uv01",
      "param:chromatic_aberration": "uv01",
      "param:halo_width": "uv01",
      "param:streak_length": "uv01",
    },
    gotchas: [
      "output=flare is the flare alone on opaque black (alpha 1), as Lens Flare writes it; output=over adds it over the content.",
      "A Skia Group's blendMode can't add the flare over its source: it reaches the draws inside a filter's layers, not the layer.",
      "ghost_dispersal, chromatic_aberration, halo_width and streak_length are uv fractions of the canvas (not aspect-corrected), as in Lens Flare.",
      "Runs at full resolution with a 1.3 px blur standing in for Lens Flare's half-res passes; the content is drawn twice (ghosts and streak branches).",
      "Runtime image filters: native React Native Skia only (RN web has no RuntimeShader filter).",
    ],
  },
  backend: "webgl2",
  skia: { class: "filter", mirrors: "lens-flare" },
  noMaskInput: true,
  inputs: [{ name: "content", label: "Content", type: "skia_draw", required: true }],
  // Lens Flare's own ParamDefs, plus `output`.
  params: [
    ...mirrorParams(lensFlareNode, [
      "threshold",
      "soft_knee",
      "intensity",
      "tint",
      "num_ghosts",
      "ghost_dispersal",
      "chromatic_aberration",
      "halo_width",
      "halo_intensity",
      "streak_strength",
      "streak_length",
      "streak_axis",
    ]),
    { name: "output", label: "Output", type: "enum", options: ["flare", "over"], default: "flare" },
  ],
  primaryOutput: "skia_draw",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const ref = (param: string): BindRef => ({ node: nodeId, param });
    const resolution = bindStatic([ctx.width, ctx.height, 1]);
    const tint = hexRgb(params.tint);
    const intensity = num(params.intensity, 1);
    const gain = bindDerived(tint.map((t) => t * intensity), [ref("tint"), ref("intensity")]) as Bind<number | number[]>;
    const bright = (): ImageFilterIR => {
      const program: SkslProgramIR = {
        sksl: SKIA_LENS_FLARE_BRIGHT_SKSL,
        uniforms: {
          iResolution: resolution,
          lf_threshold: bindParam(num(params.threshold, 0.8), nodeId, "threshold"),
          lf_knee: bindParam(num(params.soft_knee, 0.4), nodeId, "soft_knee"),
        },
        children: [],
        fused: ["lens flare bright pass"],
      };
      return runtimeFilter(program);
    };
    const ghosts: SkslProgramIR = {
      sksl: SKIA_LENS_FLARE_GHOSTS_SKSL,
      uniforms: {
        iResolution: resolution,
        // Lens Flare rounds and clamps the count in JS.
        lf_ghosts: bindDerived(Math.max(0, Math.min(8, Math.round(num(params.num_ghosts, 4)))), [ref("num_ghosts")]),
        lf_dispersal: bindParam(num(params.ghost_dispersal, 0.4), nodeId, "ghost_dispersal"),
        lf_distortion: bindParam(num(params.chromatic_aberration, 0.015), nodeId, "chromatic_aberration"),
        lf_halo_width: bindParam(num(params.halo_width, 0.5), nodeId, "halo_width"),
        lf_halo_intensity: bindParam(num(params.halo_intensity, 1), nodeId, "halo_intensity"),
        lf_gain: gain,
      },
      children: [],
      fused: ["lens flare ghosts + halo"],
    };
    const strength = num(params.streak_strength, 0.6);
    const length = num(params.streak_length, 0.2);
    const streak: SkslProgramIR = {
      sksl: SKIA_LENS_FLARE_STREAK_SKSL,
      uniforms: {
        iResolution: resolution,
        lf_dir: bindDerived(axisVec(params.streak_axis), [ref("streak_axis")]),
        lf_length: bindParam(length, nodeId, "streak_length"),
        // Lens Flare skips the streak (black) unless both are > 0.
        lf_strength: bindDerived(strength > 0 && length > 0 ? strength : 0, [ref("streak_strength"), ref("streak_length")]),
        lf_gain: gain,
      },
      children: [],
      fused: ["lens flare streak"],
    };
    const soften = (): ImageFilterIR => {
      const s = bindStatic(LENS_FLARE_SOFTEN_SIGMA);
      return { k: "blur", sx: s, sy: s, tile: "clamp" };
    };
    const over = params.output === "over";
    return {
      primary: wrapDrawing(inputs.content, nodeId, [], (content): SkiaNode => ({
        k: "group",
        id: nodeId,
        layer: {},
        children: [
          ...(over ? [content] : []),
          {
            k: "group",
            id: nodeId,
            layer: { imageFilters: [bright(), runtimeFilter(ghosts), soften()], ...(over ? { blendMode: "plus" as const } : {}) },
            children: [content],
          },
          { k: "group", id: nodeId, layer: { imageFilters: [bright(), runtimeFilter(streak), soften()], blendMode: "plus" }, children: [content] },
        ],
      })),
    };
  },
};
