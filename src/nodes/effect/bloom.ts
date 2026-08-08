import type { ImageValue, NodeDefinition } from "@/engine/types";
import {
  disposePlaceholderTex,
  getPlaceholderTex,
} from "@/engine/placeholder-tex";

// Mip-chain bloom. The COD: Advanced Warfare / UE5 / Unity HDRP
// technique:
//
//   1. THRESHOLD — extract a bright pass with a soft-knee curve so
//      highlights fade in instead of cliffing at a hard cutoff.
//      Downsamples to ½ size in the same step (cheap + matches the
//      first level of the chain).
//   2. DOWNSAMPLE — ½ × ½ each step, N levels deep. Each step uses
//      the COD 13-tap kernel; the FIRST step optionally applies a
//      Karis luma-weighted average to suppress fireflies (single
//      ultra-bright pixels that would otherwise leave a permanent
//      sparkle in every smaller mip).
//   3. UPSAMPLE — walk back up the chain with a 9-tap tent filter,
//      ADDING each mip into the next-larger one as we go. Per-mip
//      tint is applied here — small mips read as the inner core
//      colour, large mips read as the outer halo colour — which
//      fakes the chromatic aberration of a cheap lens for free.
//   4. COMPOSITE — add the final bloom layer over the source. An
//      optional lens dirt input is multiplied with the bloom layer
//      first so the glow looks like it's passing through a dusty
//      windshield.
//
// Anamorphic stretch reshapes the upsample tent so the bloom tail
// becomes horizontal (positive) or vertical (negative), giving the
// classic cinematic flare without a separate parallel chain.

// ------------------------------------------------------------
// Shaders
// ------------------------------------------------------------

// Threshold + soft-knee + downsample-by-2. Karis/Jimenez quadratic
// knee: smooth fade across [threshold − knee, threshold + knee]
// instead of a binary cutoff. Reads at four offsets (small box
// downsample) so the bright pass starts pre-blurred at half res.
const THRESHOLD_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2  u_invSrc;        // 1.0 / src size (for the box taps)
uniform float u_threshold;
uniform float u_softKnee;      // 0 = hard cliff, 1 = soft sigmoid
out vec4 outColor;

vec3 brightenSample(vec3 c) {
  // Quadratic knee: smoothly ramps from 0 at (threshold − knee) to
  // 1 at (threshold + knee), then linear above.
  float br = max(c.r, max(c.g, c.b));
  float knee = max(u_softKnee * u_threshold, 1e-4);
  float t = u_threshold - knee;
  float c2 = max(knee * 2.0, 1e-4);
  float d  = 0.25 / c2;
  float rq = clamp(br - t, 0.0, c2);
  rq = (rq * rq) * d;
  float gain = max(rq, br - u_threshold) / max(br, 1e-5);
  return c * max(gain, 0.0);
}

void main() {
  vec2 o = u_invSrc;
  // 4-tap box downsample; the call to brightenSample on each tap
  // means a hot pixel can't dominate the sum.
  vec3 c0 = brightenSample(texture(u_src, v_uv + o * vec2(-0.5, -0.5)).rgb);
  vec3 c1 = brightenSample(texture(u_src, v_uv + o * vec2( 0.5, -0.5)).rgb);
  vec3 c2 = brightenSample(texture(u_src, v_uv + o * vec2(-0.5,  0.5)).rgb);
  vec3 c3 = brightenSample(texture(u_src, v_uv + o * vec2( 0.5,  0.5)).rgb);
  outColor = vec4((c0 + c1 + c2 + c3) * 0.25, 1.0);
}`;

// COD 13-tap downsample. Sample positions form a "hexagonal-ish"
// pattern: 9 taps on a 2-pixel grid (a..i) plus 4 inner taps on a
// 1-pixel grid (j..m) that get extra weight. Dramatically less
// flicker than a 4-tap box because the inner cluster oversamples
// the centre.
//
// Karis branch: average the 13 taps in 5 luma-weighted groups.
// 1 / (1 + luma) attenuates fireflies — the brighter a 4-pixel
// neighbourhood is, the less it contributes to the average.
const DOWNSAMPLE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2  u_texel;     // 1.0 / src size
uniform int   u_karis;     // 1 = first downsample, use Karis weights
out vec4 outColor;

vec3 tap(vec2 uv) { return texture(u_src, uv).rgb; }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main() {
  vec2 t = u_texel;
  vec3 a = tap(v_uv + t * vec2(-2.0,  2.0));
  vec3 b = tap(v_uv + t * vec2( 0.0,  2.0));
  vec3 c = tap(v_uv + t * vec2( 2.0,  2.0));
  vec3 d = tap(v_uv + t * vec2(-2.0,  0.0));
  vec3 e = tap(v_uv);
  vec3 f = tap(v_uv + t * vec2( 2.0,  0.0));
  vec3 g = tap(v_uv + t * vec2(-2.0, -2.0));
  vec3 h = tap(v_uv + t * vec2( 0.0, -2.0));
  vec3 i = tap(v_uv + t * vec2( 2.0, -2.0));
  vec3 j = tap(v_uv + t * vec2(-1.0,  1.0));
  vec3 k = tap(v_uv + t * vec2( 1.0,  1.0));
  vec3 l = tap(v_uv + t * vec2(-1.0, -1.0));
  vec3 m = tap(v_uv + t * vec2( 1.0, -1.0));

  vec3 result;
  if (u_karis == 1) {
    vec3 g1 = (a + b + d + e) * 0.25;
    vec3 g2 = (b + c + e + f) * 0.25;
    vec3 g3 = (d + e + g + h) * 0.25;
    vec3 g4 = (e + f + h + i) * 0.25;
    vec3 g5 = (j + k + l + m) * 0.25;
    float w1 = 1.0 / (1.0 + luma(g1));
    float w2 = 1.0 / (1.0 + luma(g2));
    float w3 = 1.0 / (1.0 + luma(g3));
    float w4 = 1.0 / (1.0 + luma(g4));
    float w5 = 1.0 / (1.0 + luma(g5));
    float ws = w1 + w2 + w3 + w4 + w5;
    result = (g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4 + g5 * w5) / ws;
  } else {
    // COD weights: centre ring gets the most, corner taps the least.
    result  = e * 0.125;
    result += (a + c + g + i) * 0.03125;
    result += (b + d + f + h) * 0.0625;
    result += (j + k + l + m) * 0.125;
  }
  outColor = vec4(result, 1.0);
}`;

// 9-tap tent upsample. Reads the SMALLER mip (`u_src`) with a tent
// kernel offset by `u_radius` destination texels; reads the LARGER
// mip (`u_dst`) at the same UV; outputs the additive sum, tinted
// by `u_tint`.
//
// `u_anamorphic` (-1..1) reshapes the tent: positive squashes Y so
// the blur stretches horizontally, negative stretches vertically.
const UPSAMPLE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;     // smaller mip
uniform sampler2D u_dst;     // larger mip we're adding into
uniform vec2  u_texel;       // 1.0 / dst size
uniform float u_radius;      // sample radius in dst texels (default 1)
uniform vec3  u_tint;        // per-mip tint (rgb)
uniform float u_anamorphic;  // -1..1
out vec4 outColor;

vec3 tap(vec2 uv) { return texture(u_src, uv).rgb; }

void main() {
  // Anamorphic axis squash: |a| in [0,1] reduces the perpendicular
  // axis radius. ax = 1.0 always, ay shrinks for positive (horiz
  // stretch); reverse for negative.
  float a = clamp(u_anamorphic, -1.0, 1.0);
  float sx = a < 0.0 ? mix(1.0, 0.15, -a) : 1.0;
  float sy = a > 0.0 ? mix(1.0, 0.15,  a) : 1.0;
  vec2 r = u_texel * u_radius * vec2(sx, sy);

  vec3 s = vec3(0.0);
  s += tap(v_uv + r * vec2(-1.0, -1.0)) * 1.0;
  s += tap(v_uv + r * vec2( 0.0, -1.0)) * 2.0;
  s += tap(v_uv + r * vec2( 1.0, -1.0)) * 1.0;
  s += tap(v_uv + r * vec2(-1.0,  0.0)) * 2.0;
  s += tap(v_uv + r * vec2( 0.0,  0.0)) * 4.0;
  s += tap(v_uv + r * vec2( 1.0,  0.0)) * 2.0;
  s += tap(v_uv + r * vec2(-1.0,  1.0)) * 1.0;
  s += tap(v_uv + r * vec2( 0.0,  1.0)) * 2.0;
  s += tap(v_uv + r * vec2( 1.0,  1.0)) * 1.0;
  s *= (1.0 / 16.0);
  s *= u_tint;

  vec3 dst = texture(u_dst, v_uv).rgb;
  outColor = vec4(dst + s, 1.0);
}`;

// Final composite: source.rgb + bloom.rgb * intensity (* dirt if
// supplied). bloom layer comes in at half-res; we sample it
// bilinearly to upscale to the source's resolution.
const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_base;
uniform sampler2D u_bloom;
uniform sampler2D u_dirt;
uniform int   u_hasDirt;
uniform float u_intensity;
out vec4 outColor;

void main() {
  vec4 b = texture(u_base, v_uv);
  vec3 g = texture(u_bloom, v_uv).rgb;
  if (u_hasDirt == 1) g *= texture(u_dirt, v_uv).rgb;
  outColor = vec4(b.rgb + g * u_intensity, b.a);
}`;

// Final pass for `bloom_only` aux output (just the bloom layer with
// optional dirt + intensity, no source underneath).
const BLOOM_ONLY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_bloom;
uniform sampler2D u_dirt;
uniform int   u_hasDirt;
uniform float u_intensity;
out vec4 outColor;
void main() {
  vec3 g = texture(u_bloom, v_uv).rgb;
  if (u_hasDirt == 1) g *= texture(u_dirt, v_uv).rgb;
  outColor = vec4(g * u_intensity, 1.0);
}`;

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(s, 16);
  return [
    ((n >> 16) & 0xff) / 255,
    ((n >> 8) & 0xff) / 255,
    (n & 0xff) / 255,
  ];
}

function lerp3(
  a: [number, number, number],
  b: [number, number, number],
  t: number
): [number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

// ------------------------------------------------------------
// Node
// ------------------------------------------------------------

export const bloomNode: NodeDefinition = {
  type: "bloom",
  name: "Bloom",
  category: "image",
  subcategory: "modifier",
  description:
    "Mip-chain bloom (COD / UE5 / Unity HDRP technique). Soft-knee threshold + Karis-average downsample + 9-tap tent upsample give a crisp bright core with hundreds of pixels of soft tail at constant cost. Optional per-mip tint, anamorphic stretch, and lens dirt overlay.",
  backend: "webgl2",
  inputs: [
    { name: "image", type: "image", required: true },
    { name: "lens_dirt", label: "Lens Dirt", type: "image", required: false },
  ],
  params: [
    {
      name: "threshold",
      label: "Threshold",
      type: "scalar",
      min: 0,
      max: 2,
      softMax: 1.5,
      step: 0.01,
      default: 0.7,
    },
    {
      name: "soft_knee",
      label: "Soft Knee",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
    },
    {
      name: "intensity",
      label: "Intensity",
      type: "scalar",
      min: 0,
      max: 5,
      softMax: 2,
      step: 0.01,
      default: 1.0,
    },
    {
      // # of mip levels in the chain. More levels = wider bloom
      // halo. Cost grows ~4/3× a single half-res blur regardless.
      name: "levels",
      label: "Levels",
      type: "scalar",
      min: 1,
      max: 8,
      step: 1,
      default: 6,
    },
    {
      name: "karis_average",
      label: "Karis (firefly fix)",
      type: "boolean",
      default: true,
    },
    {
      name: "anamorphic",
      label: "Anamorphic",
      type: "scalar",
      min: -1,
      max: 1,
      step: 0.01,
      default: 0,
    },
    {
      // Per-mip tint = blend between two colours across the chain.
      // Small mips (= the bright core) read as `tint_low`; large
      // mips (= the wide halo) read as `tint_high`. Set both to
      // white + amount=0 for a neutral bloom.
      name: "tint_low",
      label: "Core Tint",
      type: "color",
      default: "#ffffff",
    },
    {
      name: "tint_high",
      label: "Halo Tint",
      type: "color",
      default: "#ffffff",
    },
    {
      name: "tint_amount",
      label: "Tint Amount",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [
    {
      name: "bloom_only",
      type: "image",
      description: "Glow without the original image composited underneath.",
    },
  ],
  // `bloom_only` is skipped when unconsumed (below), and this node IS
  // cacheable — so the consumed-handle set has to reach the fingerprint or
  // wiring that output would cache-hit and hand back a texture that was
  // never rendered. See NodeDefinition.gatesOutputs.
  gatesOutputs: true,

  compute({ inputs, params, ctx, nodeId, consumedOutputs }) {
    const src = inputs.image;
    const dirt = inputs.lens_dirt;
    // `bloom_only` costs a FULL-CANVAS pass — on a 4K canvas that was ~37% of
    // this node's fill, spent every frame whether or not anything read it. A
    // level-3 GPU trace put Bloom at 4.17 ms/frame, the largest single item in
    // the graph. Undefined ⇒ non-evaluator caller; build it, as before.
    const wantBloomOnly =
      !consumedOutputs || consumedOutputs.has("aux:bloom_only");
    const output = ctx.allocImage();
    const bloomOnly = wantBloomOnly ? ctx.allocImage() : null;

    if (!src || src.kind !== "image") {
      ctx.clearTarget(output, [0, 0, 0, 1]);
      if (bloomOnly) ctx.clearTarget(bloomOnly, [0, 0, 0, 0]);
      return {
        primary: output,
        ...(bloomOnly ? { aux: { bloom_only: bloomOnly } } : {}),
      };
    }

    const threshold = (params.threshold as number) ?? 0.7;
    const softKnee = (params.soft_knee as number) ?? 0.5;
    const intensity = (params.intensity as number) ?? 1.0;
    const levelsRaw = (params.levels as number) ?? 6;
    const karis = params.karis_average !== false;
    const anamorphic = (params.anamorphic as number) ?? 0;
    const tintAmount = (params.tint_amount as number) ?? 0;
    const tintLowRgb = hexToRgb((params.tint_low as string) ?? "#ffffff");
    const tintHighRgb = hexToRgb((params.tint_high as string) ?? "#ffffff");

    // Cap levels by what actually fits in the source — at least 4
    // pixels wide for the smallest mip so the tent kernel still
    // means something.
    const maxByRes = Math.max(
      1,
      Math.floor(Math.log2(Math.min(src.width, src.height)) - 2)
    );
    const levels = Math.max(1, Math.min(8, Math.min(maxByRes, levelsRaw)));

    // ---- Pass 1: threshold + ½× downsample ----
    const baseW = Math.max(2, Math.floor(src.width / 2));
    const baseH = Math.max(2, Math.floor(src.height / 2));
    const mipsDown: ImageValue[] = [];
    const mipsUp: ImageValue[] = [];
    const bright = ctx.allocImage({ width: baseW, height: baseH });
    {
      const prog = ctx.getShader("bloom2/threshold", THRESHOLD_FS);
      ctx.drawFullscreen(prog, bright, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, src.texture);
        gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
        gl.uniform2f(
          gl.getUniformLocation(prog, "u_invSrc"),
          1 / src.width,
          1 / src.height
        );
        gl.uniform1f(
          gl.getUniformLocation(prog, "u_threshold"),
          threshold
        );
        gl.uniform1f(
          gl.getUniformLocation(prog, "u_softKnee"),
          softKnee
        );
      });
    }
    mipsDown.push(bright);

    // ---- Pass 2: downsample chain ----
    const dsProg = ctx.getShader("bloom2/downsample", DOWNSAMPLE_FS);
    let prev = bright;
    for (let i = 1; i < levels; i++) {
      const w = Math.max(2, Math.floor(prev.width / 2));
      const h = Math.max(2, Math.floor(prev.height / 2));
      const dst = ctx.allocImage({ width: w, height: h });
      const useKaris = karis && i === 1;
      ctx.drawFullscreen(dsProg, dst, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, prev.texture);
        gl.uniform1i(gl.getUniformLocation(dsProg, "u_src"), 0);
        gl.uniform2f(
          gl.getUniformLocation(dsProg, "u_texel"),
          1 / prev.width,
          1 / prev.height
        );
        gl.uniform1i(
          gl.getUniformLocation(dsProg, "u_karis"),
          useKaris ? 1 : 0
        );
      });
      mipsDown.push(dst);
      prev = dst;
    }

    // ---- Pass 3: upsample chain (additive into next-larger) ----
    // Walk smallest → largest. The smallest mip seeds `mipsUp`; each
    // step writes a NEW destination same-size as the next-larger
    // download mip, so we never read+write the same texture.
    const usProg = ctx.getShader("bloom2/upsample", UPSAMPLE_FS);
    // Index 0 = largest mip; (levels-1) = smallest. mipsUp[i] holds
    // the upsampled bloom at level i.
    mipsUp[levels - 1] = mipsDown[levels - 1];
    for (let i = levels - 2; i >= 0; i--) {
      const lower = mipsUp[i + 1]; // smaller, source for tent
      const sameSize = mipsDown[i]; // larger, additive base
      const dst = ctx.allocImage({
        width: sameSize.width,
        height: sameSize.height,
      });
      // Tint blends from low (smallest mip) → high (largest).
      // Levels=1 → t=0 always; otherwise normalize i over (levels-1).
      const t = levels > 1 ? 1 - i / (levels - 1) : 0;
      const tintRgb = lerp3(tintHighRgb, tintLowRgb, t);
      const finalTint: [number, number, number] = [
        1 - tintAmount + tintAmount * tintRgb[0],
        1 - tintAmount + tintAmount * tintRgb[1],
        1 - tintAmount + tintAmount * tintRgb[2],
      ];
      ctx.drawFullscreen(usProg, dst, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, lower.texture);
        gl.uniform1i(gl.getUniformLocation(usProg, "u_src"), 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, sameSize.texture);
        gl.uniform1i(gl.getUniformLocation(usProg, "u_dst"), 1);
        gl.uniform2f(
          gl.getUniformLocation(usProg, "u_texel"),
          1 / dst.width,
          1 / dst.height
        );
        gl.uniform1f(gl.getUniformLocation(usProg, "u_radius"), 1.0);
        gl.uniform3f(
          gl.getUniformLocation(usProg, "u_tint"),
          finalTint[0],
          finalTint[1],
          finalTint[2]
        );
        gl.uniform1f(
          gl.getUniformLocation(usProg, "u_anamorphic"),
          anamorphic
        );
      });
      mipsUp[i] = dst;
    }

    // ---- Lens dirt placeholder if not connected ----
    const dirtKey = `bloom2:${nodeId}:dirt`;
    let dirtTex: WebGLTexture;
    let hasDirt = 0;
    if (dirt && dirt.kind === "image") {
      dirtTex = dirt.texture;
      hasDirt = 1;
    } else {
      dirtTex = getPlaceholderTex(ctx.gl, ctx.state, dirtKey);
    }

    // ---- Pass 4: composite + bloom_only ----
    const compProg = ctx.getShader("bloom2/composite", COMPOSITE_FS);
    const bloomLayer = mipsUp[0];
    ctx.drawFullscreen(compProg, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform1i(gl.getUniformLocation(compProg, "u_base"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, bloomLayer.texture);
      gl.uniform1i(gl.getUniformLocation(compProg, "u_bloom"), 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, dirtTex);
      gl.uniform1i(gl.getUniformLocation(compProg, "u_dirt"), 2);
      gl.uniform1i(gl.getUniformLocation(compProg, "u_hasDirt"), hasDirt);
      gl.uniform1f(
        gl.getUniformLocation(compProg, "u_intensity"),
        intensity
      );
    });

    if (bloomOnly) {
      const bloomOnlyProg = ctx.getShader(
        "bloom2/bloom_only",
        BLOOM_ONLY_FS
      );
      ctx.drawFullscreen(bloomOnlyProg, bloomOnly, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, bloomLayer.texture);
        gl.uniform1i(gl.getUniformLocation(bloomOnlyProg, "u_bloom"), 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, dirtTex);
        gl.uniform1i(gl.getUniformLocation(bloomOnlyProg, "u_dirt"), 1);
        gl.uniform1i(
          gl.getUniformLocation(bloomOnlyProg, "u_hasDirt"),
          hasDirt
        );
        gl.uniform1f(
          gl.getUniformLocation(bloomOnlyProg, "u_intensity"),
          intensity
        );
      });
    }

    // Free intermediate mips. The upsample chain's outputs (mipsUp)
    // are independent allocations, so we free both chains except
    // mipsUp[0] which we just sampled — actually that's done too,
    // we already wrote `output` and `bloomOnly` from it. Safe.
    for (const m of mipsDown) ctx.releaseTexture(m.texture);
    for (let i = 0; i < mipsUp.length; i++) {
      // mipsUp[levels-1] alias to mipsDown — already released above.
      if (i === levels - 1) continue;
      const m = mipsUp[i];
      if (m) ctx.releaseTexture(m.texture);
    }

    return {
      primary: output,
      ...(bloomOnly ? { aux: { bloom_only: bloomOnly } } : {}),
    };
  },

  dispose(ctx, nodeId) {
    disposePlaceholderTex(ctx.gl, ctx.state, `bloom2:${nodeId}:dirt`);
  },
};
