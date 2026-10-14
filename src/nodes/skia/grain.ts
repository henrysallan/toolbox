import type { NodeDefinition } from "@/engine/types";
import { mirrorParams } from "@/engine/skia/library";
import { grainNode } from "../effect/grain";
import { bindParam, bindStatic, type Bind, type SkslProgramIR } from "@/engine/skia/scene-ir";
import { filterGroup, filterProgramSksl, num, runtimeFilter, wrapDrawing } from "./filter-shared";

// Grain (Skia) — the Skia-layer mirror of Grain (effect/grain.ts), model
// `classic`: a runtime image filter over the rendered content (React
// Native Skia <RuntimeShader> on a Group layer).
//
// Classic is the pre-v2 shader, ported line for line: a float hash
// (Dave Hoskins' hash13 — already ES2-safe, no uint) per floor-quantised
// cell of `scale` px, a triangular "Gaussian" from two hashes, luminance +
// independent chromatic grain, the seven mix modes, `mix` and `view`. The
// only change is the frame: Skia's main() gets Y-DOWN px, so the cell is
// floor((x, H − y) / scale) — the GL node's v_uv · u_res — and the look is
// the same cell for cell (fp32 both sides). The v2 models (fine, soft,
// film, parametric, sensor, video, plate) hash with integer pcg3d and run
// several passes; porting them means a float hash (spec §3.2), which would
// draw different grain, plus a multipass filter chain — refused here.

// Grain's mix modes, in its shader's index order (MIX_MODES in grain.ts;
// the gate checks they agree).
export const SKIA_GRAIN_MIX_MODES = ["add", "screen", "overlay", "soft-light", "multiply", "linear-light", "replace"] as const;
export const SKIA_GRAIN_MODELS = ["classic", "fine", "soft", "film", "parametric", "sensor", "video", "plate"] as const;

const BODY = `uniform float g_lum;
uniform float g_chr;
uniform float g_scale;
uniform float g_seed;
uniform float g_mix;
uniform int g_mode;
uniform int g_view;
// Grain (classic): hash → uniform [0, 1).
float tbx_grain_hash13(float3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
float tbx_grain_gaussian(float3 p) {
  float a = tbx_grain_hash13(p);
  float b = tbx_grain_hash13(p + float3(17.0, 31.0, 13.0));
  return a + b - 1.0;
}
float3 tbx_grain_blend(float3 base, float3 grain, int mode) {
  float3 layer = clamp(0.5 + grain * 0.5, 0.0, 1.0);
  if (mode == 0) return base + grain;
  if (mode == 1) return 1.0 - (1.0 - base) * (1.0 - layer);
  if (mode == 2) {
    float3 lo = 2.0 * base * layer;
    float3 hi = 1.0 - 2.0 * (1.0 - base) * (1.0 - layer);
    return mix(lo, hi, step(0.5, base));
  }
  if (mode == 3) return (1.0 - 2.0 * layer) * base * base + 2.0 * layer * base;
  if (mode == 4) return base * layer * 2.0;
  if (mode == 5) return base + 2.0 * layer - 1.0;
  return layer;
}
float4 tbx_filter(float2 p) {
  // Grain's v_uv · u_res: x, and y counted from the bottom.
  float2 px = float2(p.x, iResolution.y - p.y);
  float2 cell = floor(px / max(g_scale, 1.0));
  float gl = tbx_grain_gaussian(float3(cell, g_seed));
  float gr = tbx_grain_gaussian(float3(cell, g_seed + 11.13));
  float gg = tbx_grain_gaussian(float3(cell, g_seed + 41.27));
  float gb = tbx_grain_gaussian(float3(cell, g_seed + 73.91));
  float3 grain = float3(gl) * g_lum + float3(gr, gg, gb) * g_chr;
  float4 src = tbx_content(p);
  float3 mixed = tbx_grain_blend(src.rgb, grain, g_mode);
  float3 rgb = mix(src.rgb, mixed, clamp(g_mix, 0.0, 1.0));
  float4 standalone = float4(clamp(0.5 + grain, 0.0, 1.0), 1.0);
  return g_view == 1 ? standalone : float4(rgb, src.a);
}`;

export const SKIA_GRAIN_SKSL = filterProgramSksl({ name: "Grain (Skia), classic", uniforms: [], body: BODY });

export const skiaGrainNode: NodeDefinition = {
  type: "skia-grain",
  name: "Grain (Skia)",
  category: "image",
  subcategory: "modifier",
  description:
    "Grain's classic model over the Skia drawing wired into it — a runtime image filter (React Native Skia <RuntimeShader>): hashed cells of `scale` px, luminance + chromatic grain, Grain's seven mix modes, mix and view. Keyframe `seed` to animate it, as with classic Grain.",
  searchAliases: ["skia", "grain", "film grain", "noise", "react native"],
  facts: {
    space: { out: "pixels", "param:scale": "pixels" },
    gotchas: [
      "Only model=classic ports (its float hash is ES2-safe); the v2 models hash with uint pcg3d and are refused.",
      "scale is the grain cell in canvas px; on device the exported canvas scales and the cells scale with it.",
      "Classic grain is static unless seed animates (keyframe it) — the v2 models' frame-locked motion is not part of this node.",
      "A runtime image filter: native React Native Skia only (RN web has no RuntimeShader filter), so a web export doesn't play it.",
    ],
  },
  backend: "webgl2",
  skia: { class: "filter", mirrors: "grain" },
  noMaskInput: true,
  inputs: [{ name: "content", label: "Content", type: "skia_draw", required: true }],
  // Grain's own ParamDefs for what classic reads; `model` is this node's
  // own (Grain's defaults to fine, which isn't ported).
  params: [
    { name: "model", label: "Model", type: "enum", options: [...SKIA_GRAIN_MODELS], default: "classic" },
    ...mirrorParams(grainNode, ["scale", "luminance", "chromatic", "seed", "mix_mode", "mix", "view"]),
  ],
  primaryOutput: "skia_draw",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const model = String(params.model ?? "classic");
    if (model !== "classic") {
      const why = `Grain (Skia) "${nodeId}": model "${model}" is not ported — only classic (a float hash, one pass). The v2 models hash with uint pcg3d, which SkSL (GLSL ES 1.0) has no integers for, and run several passes; the content passes through ungrained.`;
      return { primary: wrapDrawing(inputs.content, nodeId, [why], (c) => c) };
    }
    const modeIdx = Math.max(0, (SKIA_GRAIN_MIX_MODES as readonly string[]).indexOf(String(params.mix_mode ?? "overlay")));
    const uniforms: Record<string, Bind<number | number[]>> = {
      iResolution: bindStatic([ctx.width, ctx.height, 1]),
      g_lum: bindParam(num(params.luminance, 0.06), nodeId, "luminance"),
      g_chr: bindParam(num(params.chromatic, 0), nodeId, "chromatic"),
      // The program clamps it to ≥ 1 as Grain does, so the raw param is
      // the uniform (and a keyframed scale exports as its own track).
      g_scale: bindParam(num(params.scale, 1), nodeId, "scale"),
      g_seed: bindParam(num(params.seed, 0), nodeId, "seed"),
      g_mix: bindParam(num(params.mix, 1), nodeId, "mix"),
      g_mode: bindParam(modeIdx, nodeId, "mix_mode"),
      g_view: bindParam(params.view === "grain" ? 1 : 0, nodeId, "view"),
    };
    const program: SkslProgramIR = { sksl: SKIA_GRAIN_SKSL, uniforms, children: [], fused: ["grain (classic)"] };
    return { primary: filterGroup(inputs.content, nodeId, { imageFilters: [runtimeFilter(program)] }) };
  },
};
