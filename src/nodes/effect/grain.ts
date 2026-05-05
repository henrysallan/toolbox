import type { NodeDefinition } from "@/engine/types";

// Procedural film grain. Two channels (luminance + chromatic),
// one fragment-shader pass, no texture lookups for the noise (a
// stable hash function gives us free per-pixel grain).
//
// • Luminance amount  — single-channel grain that nudges brightness
//   uniformly across R, G, B. Default ~0.15 sits in the "subtle film
//   shimmer" range.
// • Chromatic amount  — independent per-channel grain. Reads as
//   colored speckle. Default 0; cranking adds the colored-grain look.
// • Scale             — grain dot size in pixels. Default 1.0 (the
//   finest possible: one grain dot per pixel). Larger values pool the
//   noise into chunkier blobs via floor-quantization of UV.
// • Seed              — animate this for moving grain; static seed →
//   static grain. Wire Scene Time in for moving grain.
// • Mix amount        — opacity of the grain layer when an image is
//   wired (1 = fully replace via the chosen mode, 0 = pass-through).
// • Mix mode          — which formula combines grain with the input
//   when one is wired. Ignored when input is empty (we just emit the
//   grain on neutral 50% gray, so the node also doubles as a
//   stand-alone grain texture you can composite downstream).

const GRAIN_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform int   u_hasSrc;
uniform vec2  u_res;
uniform float u_lum;     // luminance grain amount, [0..]
uniform float u_chr;     // chromatic grain amount, [0..]
uniform float u_scale;   // grain dot size in pixels (≥ 1 ⇒ finer)
uniform float u_seed;    // animate for moving grain
uniform float u_mix;     // 0..1 layer opacity over input
uniform int   u_mode;    // mix-mode index (see switch below)
out vec4 outColor;

// Hash → uniform [0,1). Same trick used elsewhere in the codebase
// (audio.ts, perlin-noise.ts) — produces visually grain-like noise
// without any texture sampling.
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

// Approx Gaussian via two uniforms summed (central-limit). Gives the
// noise a softer film-like shoulder than raw uniform speckle.
float gaussian(vec3 p) {
  float a = hash13(p);
  float b = hash13(p + vec3(17.0, 31.0, 13.0));
  return (a + b - 1.0); // ≈ in [-1, 1] with Gaussian-ish PDF
}

vec3 blendMode(vec3 base, vec3 grain, int mode) {
  if (mode == 0) {
    // add
    return base + grain;
  } else if (mode == 1) {
    // screen: 1 - (1-a)*(1-b). Symmetric around mid-gray. Treat
    // grain as a 0..1 layer (centered at 0.5 + grain/2) so that 0
    // grain = no change.
    vec3 layer = clamp(0.5 + grain * 0.5, 0.0, 1.0);
    return 1.0 - (1.0 - base) * (1.0 - layer);
  } else if (mode == 2) {
    // overlay — most film-y on mid-tones. Layer is grain centered
    // at 0.5; overlay falls back to identity at 0 grain.
    vec3 layer = clamp(0.5 + grain * 0.5, 0.0, 1.0);
    vec3 lo = 2.0 * base * layer;
    vec3 hi = 1.0 - 2.0 * (1.0 - base) * (1.0 - layer);
    return mix(lo, hi, step(0.5, base));
  } else if (mode == 3) {
    // soft-light (Pegtop) — gentler than overlay.
    vec3 layer = clamp(0.5 + grain * 0.5, 0.0, 1.0);
    return (1.0 - 2.0 * layer) * base * base + 2.0 * layer * base;
  } else if (mode == 4) {
    // multiply
    vec3 layer = clamp(0.5 + grain * 0.5, 0.0, 1.0);
    return base * layer * 2.0; // *2 so 0.5 layer = identity
  } else if (mode == 5) {
    // linear-light = base + 2*layer - 1, with layer centered at 0.5.
    vec3 layer = clamp(0.5 + grain * 0.5, 0.0, 1.0);
    return base + 2.0 * layer - 1.0;
  }
  // 6: replace — base swapped for the grain texture (centered at 0.5).
  return clamp(0.5 + grain * 0.5, 0.0, 1.0);
}

void main() {
  // Quantize UV into "grain cells" of u_scale pixels. A cell of 1
  // pixel = the finest possible grain (one independent sample per
  // pixel); larger u_scale pools many pixels onto a single sample,
  // producing chunky grain.
  vec2 px = v_uv * u_res;
  vec2 cell = floor(px / max(u_scale, 1.0));

  // Luminance grain — same value applied to R, G, B so the
  // brightness shifts but hue / saturation don't.
  float gl = gaussian(vec3(cell, u_seed));

  // Chromatic grain — independent per channel, offset hashes so the
  // three channels don't correlate.
  float gr = gaussian(vec3(cell, u_seed + 11.13));
  float gg = gaussian(vec3(cell, u_seed + 41.27));
  float gb = gaussian(vec3(cell, u_seed + 73.91));

  vec3 grain = vec3(gl) * u_lum + vec3(gr, gg, gb) * u_chr;

  if (u_hasSrc == 1) {
    vec4 src = texture(u_src, v_uv);
    vec3 mixed = blendMode(src.rgb, grain, u_mode);
    vec3 rgb = mix(src.rgb, mixed, clamp(u_mix, 0.0, 1.0));
    outColor = vec4(rgb, src.a);
  } else {
    // Stand-alone grain on neutral 50% gray. Downstream Merge
    // nodes can composite this however they like.
    outColor = vec4(clamp(0.5 + grain, 0.0, 1.0), 1.0);
  }
}`;

const MIX_MODES = [
  "add",
  "screen",
  "overlay",
  "soft-light",
  "multiply",
  "linear-light",
  "replace",
] as const;

function mixModeIndex(name: string): number {
  const idx = (MIX_MODES as readonly string[]).indexOf(name);
  return idx < 0 ? 2 : idx; // default overlay
}

export const grainNode: NodeDefinition = {
  type: "grain",
  name: "Grain",
  category: "image",
  subcategory: "modifier",
  description:
    "Procedural film grain with separate luminance and chromatic channels. Works as a stand-alone grain source (no input → grain on 50% gray) or as a one-shot composite over an input image with a choice of mix modes. Animate Seed (e.g. wire Scene Time in via a Math expression) for moving grain.",
  backend: "webgl2",
  inputs: [{ name: "image", label: "Image", type: "image", required: false }],
  params: [
    {
      name: "luminance",
      label: "Luminance",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.5,
      step: 0.001,
      default: 0.15,
    },
    {
      name: "chromatic",
      label: "Chromatic",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.5,
      step: 0.001,
      default: 0,
    },
    {
      name: "scale",
      label: "Scale (px)",
      type: "scalar",
      min: 1,
      max: 32,
      softMax: 8,
      step: 0.1,
      default: 1,
    },
    {
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 1000,
      step: 1,
      default: 0,
    },
    {
      name: "mix_mode",
      label: "Mix Mode",
      type: "enum",
      options: MIX_MODES as unknown as string[],
      default: "overlay",
    },
    {
      name: "mix",
      label: "Mix Amount",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 1,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx }) {
    const output = ctx.allocImage();
    const src = inputs.image;
    const hasSrc = !!(src && src.kind === "image") ? 1 : 0;
    const lum = (params.luminance as number) ?? 0.15;
    const chr = (params.chromatic as number) ?? 0;
    const scale = Math.max(1, (params.scale as number) ?? 1);
    const seed = (params.seed as number) ?? 0;
    const mixAmt = (params.mix as number) ?? 1;
    const mode = mixModeIndex((params.mix_mode as string) ?? "overlay");
    const W = ctx.width;
    const H = ctx.height;

    const prog = ctx.getShader("grain/main", GRAIN_FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      // When no image is wired, bind a dummy texture so the sampler
      // is still defined. We never actually read it (u_hasSrc gates).
      gl.bindTexture(
        gl.TEXTURE_2D,
        hasSrc === 1 && src && src.kind === "image" ? src.texture : null
      );
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
      gl.uniform1i(gl.getUniformLocation(prog, "u_hasSrc"), hasSrc);
      gl.uniform2f(gl.getUniformLocation(prog, "u_res"), W, H);
      gl.uniform1f(gl.getUniformLocation(prog, "u_lum"), lum);
      gl.uniform1f(gl.getUniformLocation(prog, "u_chr"), chr);
      gl.uniform1f(gl.getUniformLocation(prog, "u_scale"), scale);
      gl.uniform1f(gl.getUniformLocation(prog, "u_seed"), seed);
      gl.uniform1f(gl.getUniformLocation(prog, "u_mix"), mixAmt);
      gl.uniform1i(gl.getUniformLocation(prog, "u_mode"), mode);
    });

    return { primary: output };
  },
};
