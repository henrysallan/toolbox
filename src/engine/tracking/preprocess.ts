// Shared preprocess param block + the GL pass that builds the single-channel
// tracking image the kernel reads. Channel pick, denoise, DoG band-pass,
// local contrast, invert, gamma. Mask exclusion is a socket (pixels with
// mask < 0.5 are zeroed). Spec: 082226_motion-tracking.md §6.

import type {
  ImageValue,
  MaskValue,
  ParamDef,
  RenderContext,
} from "../types";

export const TRACKING_PREPROCESS_PARAMS: ParamDef[] = [
  {
    name: "channel",
    label: "Channel",
    type: "enum",
    options: ["luminance", "red", "green", "blue", "saturation"],
    default: "luminance",
    group: "preprocess",
    groupHeader: true,
  },
  {
    name: "denoise",
    label: "Denoise",
    type: "enum",
    options: ["none", "median3", "blur"],
    default: "none",
    group: "preprocess",
  },
  {
    name: "denoise_radius",
    label: "Denoise radius",
    type: "scalar",
    min: 0.5,
    max: 4,
    step: 0.5,
    default: 1,
    group: "preprocess",
    visibleIf: (p) => p.denoise === "blur",
  },
  {
    name: "bandpass",
    label: "Band-pass",
    type: "boolean",
    default: true,
    group: "preprocess",
  },
  {
    name: "bandpass_low",
    label: "Band-pass low σ",
    type: "scalar",
    min: 0.3,
    max: 8,
    step: 0.1,
    default: 0.8,
    group: "preprocess",
    visibleIf: (p) => !!p.bandpass,
  },
  {
    name: "bandpass_high",
    label: "Band-pass high σ",
    type: "scalar",
    min: 1,
    max: 24,
    step: 0.5,
    default: 6,
    group: "preprocess",
    visibleIf: (p) => !!p.bandpass,
  },
  {
    name: "contrast",
    label: "Contrast",
    type: "enum",
    options: ["none", "stretch", "local"],
    default: "none",
    group: "preprocess",
  },
  {
    name: "invert",
    label: "Invert",
    type: "boolean",
    default: false,
    group: "preprocess",
  },
  {
    name: "gamma",
    label: "Gamma",
    type: "scalar",
    min: 0.2,
    max: 4,
    step: 0.05,
    default: 1,
    group: "preprocess",
  },
  {
    name: "view_tracking_image",
    label: "View tracking image",
    type: "boolean",
    default: false,
    group: "preprocess",
  },
];

export interface TrackingPreprocessOpts {
  channel?: string;
  denoise?: string;
  denoise_radius?: number;
  bandpass?: boolean;
  bandpass_low?: number;
  bandpass_high?: number;
  contrast?: string;
  invert?: boolean;
  gamma?: number;
}

const CHANNEL_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform sampler2D u_mask;
uniform int u_hasMask;
uniform int u_channel; // 0 lum 1 r 2 g 3 b 4 sat
uniform int u_invert;
uniform float u_gamma;
out vec4 outColor;

float sat(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  return mx < 1e-5 ? 0.0 : (mx - mn) / mx;
}

void main() {
  vec4 c = texture(u_src, v_uv);
  float v;
  if (u_channel == 1) v = c.r;
  else if (u_channel == 2) v = c.g;
  else if (u_channel == 3) v = c.b;
  else if (u_channel == 4) v = sat(c.rgb);
  else v = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  if (u_invert == 1) v = 1.0 - v;
  v = pow(max(v, 0.0), u_gamma);
  if (u_hasMask == 1 && texture(u_mask, v_uv).r < 0.5) v = 0.0;
  outColor = vec4(v, 0.0, 0.0, 1.0);
}`;

const BLUR_H_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform float u_sigma;
uniform float u_srcW;
out vec4 outColor;
void main() {
  float s = max(u_sigma, 0.01);
  int r = int(clamp(ceil(s * 3.0), 1.0, 24.0));
  float sum = 0.0;
  float wsum = 0.0;
  for (int i = -24; i <= 24; i++) {
    if (i < -r || i > r) continue;
    float w = exp(-float(i * i) / (2.0 * s * s));
    float x = v_uv.x + float(i) / u_srcW;
    sum += texture(u_src, vec2(clamp(x, 0.0, 1.0), v_uv.y)).r * w;
    wsum += w;
  }
  outColor = vec4(sum / wsum, 0.0, 0.0, 1.0);
}`;

const BLUR_V_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform float u_sigma;
uniform float u_srcH;
out vec4 outColor;
void main() {
  float s = max(u_sigma, 0.01);
  int r = int(clamp(ceil(s * 3.0), 1.0, 24.0));
  float sum = 0.0;
  float wsum = 0.0;
  for (int i = -24; i <= 24; i++) {
    if (i < -r || i > r) continue;
    float w = exp(-float(i * i) / (2.0 * s * s));
    float y = v_uv.y + float(i) / u_srcH;
    sum += texture(u_src, vec2(v_uv.x, clamp(y, 0.0, 1.0))).r * w;
    wsum += w;
  }
  outColor = vec4(sum / wsum, 0.0, 0.0, 1.0);
}`;

const MEDIAN3_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_texel;
out vec4 outColor;

float med3(float a, float b, float c) {
  return max(min(a, b), min(max(a, b), c));
}

void main() {
  float s[9];
  int k = 0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      s[k++] = texture(u_src, v_uv + vec2(float(i), float(j)) * u_texel).r;
    }
  }
  float a = med3(s[0], s[1], s[2]);
  float b = med3(s[3], s[4], s[5]);
  float c = med3(s[6], s[7], s[8]);
  outColor = vec4(med3(a, b, c), 0.0, 0.0, 1.0);
}`;

const COMBINE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform sampler2D u_low;
uniform sampler2D u_high;
uniform int u_bandpass;
uniform int u_contrast; // 0 none 1 stretch (no-op here; stretch is CPU) 2 local
uniform vec2 u_texel;
out vec4 outColor;
void main() {
  float v = texture(u_src, v_uv).r;
  if (u_bandpass == 1) {
    v = texture(u_low, v_uv).r - texture(u_high, v_uv).r;
    v = v * 0.5 + 0.5;
  }
  if (u_contrast == 2) {
    float mean = 0.0;
    for (int j = -2; j <= 2; j++) {
      for (int i = -2; i <= 2; i++) {
        mean += texture(u_src, v_uv + vec2(float(i), float(j)) * u_texel).r;
      }
    }
    mean /= 25.0;
    float var = 0.0;
    for (int j = -2; j <= 2; j++) {
      for (int i = -2; i <= 2; i++) {
        float d = texture(u_src, v_uv + vec2(float(i), float(j)) * u_texel).r - mean;
        var += d * d;
      }
    }
    float std = sqrt(var / 25.0) + 1e-4;
    v = clamp((v - mean) / (2.0 * std) * 0.5 + 0.5, 0.0, 1.0);
  }
  outColor = vec4(v, 0.0, 0.0, 1.0);
}`;

const CHANNEL_MAP: Record<string, number> = {
  luminance: 0,
  red: 1,
  green: 2,
  blue: 3,
  saturation: 4,
};

function gaussianBlur(
  ctx: RenderContext,
  src: MaskValue,
  sigma: number
): MaskValue {
  const tmp = ctx.allocMask({ width: src.width, height: src.height });
  const out = ctx.allocMask({ width: src.width, height: src.height });
  const ph = ctx.getShader("tracking/blur-h", BLUR_H_FS);
  ctx.drawFullscreen(ph, tmp, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.texture);
    gl.uniform1i(gl.getUniformLocation(ph, "u_src"), 0);
    gl.uniform1f(gl.getUniformLocation(ph, "u_sigma"), sigma);
    gl.uniform1f(gl.getUniformLocation(ph, "u_srcW"), src.width);
  });
  const pv = ctx.getShader("tracking/blur-v", BLUR_V_FS);
  ctx.drawFullscreen(pv, out, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tmp.texture);
    gl.uniform1i(gl.getUniformLocation(pv, "u_src"), 0);
    gl.uniform1f(gl.getUniformLocation(pv, "u_sigma"), sigma);
    gl.uniform1f(gl.getUniformLocation(pv, "u_srcH"), src.height);
  });
  ctx.releaseTexture(tmp.texture);
  return out;
}

/** Build the tracking image (single-channel-in-R mask). Caller owns the
 *  returned texture — release via `ctx.releaseTexture`. */
export function preprocessTrackingImage(
  ctx: RenderContext,
  src: ImageValue,
  params: TrackingPreprocessOpts,
  mask?: MaskValue | null
): MaskValue {
  const w = src.width;
  const h = src.height;
  const extracted = ctx.allocMask({ width: w, height: h });
  const prog = ctx.getShader("tracking/channel", CHANNEL_FS);
  const ch = CHANNEL_MAP[params.channel ?? "luminance"] ?? 0;
  ctx.drawFullscreen(prog, extracted, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.texture);
    gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, mask?.texture ?? src.texture);
    gl.uniform1i(gl.getUniformLocation(prog, "u_mask"), 1);
    gl.uniform1i(gl.getUniformLocation(prog, "u_hasMask"), mask ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(prog, "u_channel"), ch);
    gl.uniform1i(gl.getUniformLocation(prog, "u_invert"), params.invert ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(prog, "u_gamma"), params.gamma ?? 1);
  });

  let current = extracted;
  const denoise = params.denoise ?? "none";
  if (denoise === "median3") {
    const med = ctx.allocMask({ width: w, height: h });
    const pm = ctx.getShader("tracking/median3", MEDIAN3_FS);
    ctx.drawFullscreen(pm, med, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, current.texture);
      gl.uniform1i(gl.getUniformLocation(pm, "u_src"), 0);
      gl.uniform2f(gl.getUniformLocation(pm, "u_texel"), 1 / w, 1 / h);
    });
    ctx.releaseTexture(current.texture);
    current = med;
  } else if (denoise === "blur") {
    const blurred = gaussianBlur(ctx, current, params.denoise_radius ?? 1);
    ctx.releaseTexture(current.texture);
    current = blurred;
  }

  const bandpass = !!params.bandpass;
  const contrast = params.contrast === "local" ? 2 : 0;
  if (bandpass || contrast === 2) {
    let low: MaskValue | null = null;
    let high: MaskValue | null = null;
    if (bandpass) {
      low = gaussianBlur(ctx, current, params.bandpass_low ?? 0.8);
      high = gaussianBlur(ctx, current, params.bandpass_high ?? 6);
    }
    const out = ctx.allocMask({ width: w, height: h });
    const pc = ctx.getShader("tracking/combine", COMBINE_FS);
    ctx.drawFullscreen(pc, out, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, current.texture);
      gl.uniform1i(gl.getUniformLocation(pc, "u_src"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, (low ?? current).texture);
      gl.uniform1i(gl.getUniformLocation(pc, "u_low"), 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, (high ?? current).texture);
      gl.uniform1i(gl.getUniformLocation(pc, "u_high"), 2);
      gl.uniform1i(gl.getUniformLocation(pc, "u_bandpass"), bandpass ? 1 : 0);
      gl.uniform1i(gl.getUniformLocation(pc, "u_contrast"), contrast);
      gl.uniform2f(gl.getUniformLocation(pc, "u_texel"), 1 / w, 1 / h);
    });
    ctx.releaseTexture(current.texture);
    if (low) ctx.releaseTexture(low.texture);
    if (high) ctx.releaseTexture(high.texture);
    current = out;
  }

  return current;
}

const MASK_TO_RGB_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  float v = texture(u_src, v_uv).r;
  outColor = vec4(v, v, v, 1.0);
}`;

/** Copy a single-channel tracking mask into an RGB image for preview. */
export function trackingMaskToImage(
  ctx: RenderContext,
  src: MaskValue
): ImageValue {
  const out = ctx.allocImage({ width: src.width, height: src.height });
  const prog = ctx.getShader("tracking/mask-to-rgb", MASK_TO_RGB_FS);
  ctx.drawFullscreen(prog, out, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.texture);
    gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
  });
  return out;
}
