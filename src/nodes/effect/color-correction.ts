import type { NodeDefinition, ParamDef } from "@/engine/types";
import {
  type CurvePoint,
  computeMonotoneTangents,
  defaultFloatCurve,
  evalMonotoneCubic,
  newCurvePointId,
  sanitizeFloatCurve,
} from "@/engine/float-curve";

// The single-channel curve math lives engine-side now (engine/float-curve.ts,
// shared with the generic `float_curve` param type). Re-exported here for
// back-compat with existing importers (rgb-curves, RgbCurvesPanel,
// param-controls).
export {
  computeMonotoneTangents,
  evalMonotoneCubic,
  newCurvePointId,
  type CurvePoint,
};

export type CurveChannel = "rgb" | "r" | "g" | "b";

export interface CurvesValue {
  rgb: CurvePoint[];
  r: CurvePoint[];
  g: CurvePoint[];
  b: CurvePoint[];
}

const CURVE_CHANNELS: CurveChannel[] = ["rgb", "r", "g", "b"];

export function defaultCurveChannel(): CurvePoint[] {
  return defaultFloatCurve(0, 1);
}

export function defaultCurvesValue(): CurvesValue {
  return {
    rgb: defaultCurveChannel(),
    r: defaultCurveChannel(),
    g: defaultCurveChannel(),
    b: defaultCurveChannel(),
  };
}

function sanitizeCurveChannel(raw: unknown): CurvePoint[] {
  return sanitizeFloatCurve(raw, 0, 1);
}

export function sanitizeCurvesValue(raw: unknown): CurvesValue {
  const v = (raw ?? {}) as Partial<CurvesValue>;
  return {
    rgb: sanitizeCurveChannel(v.rgb),
    r: sanitizeCurveChannel(v.r),
    g: sanitizeCurveChannel(v.g),
    b: sanitizeCurveChannel(v.b),
  };
}

function buildLut256(points: CurvePoint[]): Uint8Array {
  const tangents = computeMonotoneTangents(points);
  const out = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    const y = evalMonotoneCubic(points, tangents, x);
    out[i] = Math.max(0, Math.min(255, Math.round(y * 255)));
  }
  return out;
}

// HSV helpers in the shader are compact branchless form. Hue is taken as a
// fractional rotation (radians or 0..1); we pass it in 0..1. Saturation
// multiplies and clamps. Brightness and contrast are linear ops in RGB.
const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform sampler2D u_lut;
uniform float u_hue;         // 0..1, wraps
uniform float u_saturation;  // 1.0 = identity (legacy global)
uniform float u_contrast;    // 1.0 = identity, pivots on u_pivot
uniform float u_brightness;  // 0.0 = identity, additive
// DaVinci-style primaries. Each wheel packs (balanceX, balanceY, lum, exp).
uniform vec4 u_dark;    // Lift   (shadows)
uniform vec4 u_shadow;  // Gamma  (low-mids)
uniform vec4 u_light;   // Gain   (highlights)
uniform vec4 u_global;  // Offset (overall)
uniform vec4 u_sats;    // per-wheel saturation: dark, shadow, light, global
uniform float u_temp;   // white balance, blue<->orange
uniform float u_tint;   // white balance, green<->magenta
uniform float u_pivot;  // contrast pivot
uniform float u_md;     // midtone detail (mid contrast)
uniform float u_boffset;// black offset
out vec4 outColor;

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(
    abs(q.z + (q.w - q.y) / (6.0 * d + e)),
    d / (q.x + e),
    q.x
  );
}

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

float sampleLut(float v, int channel) {
  // Four channels packed into RGBA; sample with LINEAR filtering.
  vec4 s = texture(u_lut, vec2(clamp(v, 0.0, 1.0), 0.5));
  if (channel == 0) return s.r;
  if (channel == 1) return s.g;
  if (channel == 2) return s.b;
  return s.a; // master
}

const float LUMA_R = 0.2126, LUMA_G = 0.7152, LUMA_B = 0.0722;

// A color wheel's per-channel push. The 2D balance angle is read clockwise
// from "up" to match the panel's conic hue disc (red at top), so dragging
// toward a displayed color pushes that color; radius is strength. The tint is
// made roughly luminance-neutral, then the master "lum" lifts all channels.
vec3 wheelRGB(vec2 p, float lum) {
  float radius = min(length(p), 1.0);
  float ang = atan(p.x, -p.y);             // 0 = up = red, clockwise
  float hue = fract(ang / 6.2831853 + 1.0);
  vec3 tint = hsv2rgb(vec3(hue, 1.0, 1.0)) - vec3(1.0 / 3.0);
  return tint * radius * 0.8 + lum * 0.5;
}

void main() {
  vec4 src = texture(u_src, v_uv);
  vec3 c = src.rgb;

  // ---- White balance (temp / tint) ----
  c.r *= 1.0 + u_temp * 0.4;
  c.b *= 1.0 - u_temp * 0.4;
  c.g *= 1.0 + u_tint * 0.4;
  c.r *= 1.0 - u_tint * 0.2;
  c.b *= 1.0 - u_tint * 0.2;
  c = max(c, 0.0);

  // ---- Lift / Gamma / Gain / Offset (the four wheels) ----
  vec3 lift   = wheelRGB(u_dark.xy, u_dark.z);
  vec3 gainv  = 1.0 + wheelRGB(u_light.xy, u_light.z);
  vec3 gammav = 1.0 + wheelRGB(u_shadow.xy, u_shadow.z);
  vec3 offv   = wheelRGB(u_global.xy, u_global.z);
  c = gainv * c + lift * (1.0 - c);
  c = pow(max(c, 0.0), 1.0 / max(gammav, vec3(0.05)));
  c = c + offv;
  c += vec3(u_boffset * 0.2); // black offset

  // ---- Zone weights (for per-wheel exposure + saturation) ----
  float luma = dot(clamp(c, 0.0, 1.0), vec3(LUMA_R, LUMA_G, LUMA_B));
  float wDark = 1.0 - smoothstep(0.0, 0.5, luma);
  float wLight = smoothstep(0.5, 1.0, luma);
  float wMid = clamp(1.0 - abs(luma - 0.5) * 2.0, 0.0, 1.0);

  // Per-wheel exposure (stops), summed by zone; global applies everywhere.
  float ev = u_dark.w * wDark + u_shadow.w * wMid + u_light.w * wLight + u_global.w;
  c *= exp2(ev);

  // Per-wheel saturation, blended by zone.
  float satF = 1.0
    + (u_sats.x - 1.0) * wDark
    + (u_sats.y - 1.0) * wMid
    + (u_sats.z - 1.0) * wLight
    + (u_sats.w - 1.0);
  float l2 = dot(c, vec3(LUMA_R, LUMA_G, LUMA_B));
  c = mix(vec3(l2), c, satF);

  // ---- Brightness + contrast (pivot) ----
  c += vec3(u_brightness);
  c = (c - u_pivot) * u_contrast + u_pivot;

  // ---- Midtone detail: extra contrast weighted to the mids ----
  vec3 cm = (c - 0.5) * (1.0 + u_md) + 0.5;
  c = mix(c, cm, wMid);

  c = clamp(c, 0.0, 1.0);

  // ---- Global hue + saturation (legacy) ----
  vec3 hsv = rgb2hsv(c);
  hsv.x = fract(hsv.x + u_hue + 1.0);
  hsv.y = clamp(hsv.y * u_saturation, 0.0, 1.0);
  c = hsv2rgb(hsv);
  c = clamp(c, 0.0, 1.0);

  // ---- Curves: master then per-channel ----
  c = vec3(sampleLut(c.r, 3), sampleLut(c.g, 3), sampleLut(c.b, 3));
  c = vec3(sampleLut(c.r, 0), sampleLut(c.g, 1), sampleLut(c.b, 2));

  outColor = vec4(c, src.a);
}`;

interface CCState {
  lut: WebGLTexture | null;
  lutBuf: Uint8Array;
}

function allocLutTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error("color-correction: failed to create LUT texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
    256,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    null
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

export { CURVE_CHANNELS };

// Wheel keys in tonal order; the panel and shader share these names.
export const GRADE_WHEELS = ["dark", "shadow", "light", "global"] as const;
export type GradeWheel = (typeof GRADE_WHEELS)[number];

// The bottom-bar grade fields, in display order. ParamPanel renders these as
// standard param rows (keyframeable + exposable) under the wheels panel.
export const CC_BAR_PARAM_NAMES = [
  "temp",
  "tint",
  "hue",
  "contrast",
  "pivot",
  "md",
  "boffset",
] as const;

// The DaVinci-style primaries params: per wheel a balance (X/Y), master (Lum),
// Exp, and Sat; plus the bottom bar (Temp/Tint/Pivot/MD/Black Offset). Hue and
// Contrast already exist above and serve the bar's Hue/Cont fields.
const GRADE_PARAMS: ParamDef[] = (() => {
  const ps: ParamDef[] = [];
  for (const w of GRADE_WHEELS) {
    ps.push(
      { name: `${w}X`, label: `${w} balance X`, type: "scalar", min: -1, max: 1, step: 0.001, default: 0 },
      { name: `${w}Y`, label: `${w} balance Y`, type: "scalar", min: -1, max: 1, step: 0.001, default: 0 },
      { name: `${w}Lum`, label: `${w} master`, type: "scalar", min: -2, max: 2, step: 0.001, default: 0 },
      { name: `${w}Exp`, label: `${w} exposure`, type: "scalar", min: -2, max: 2, step: 0.001, default: 0 },
      { name: `${w}Sat`, label: `${w} saturation`, type: "scalar", min: 0, max: 2, step: 0.001, default: 1 }
    );
  }
  ps.push(
    { name: "temp", label: "Temp", type: "scalar", min: -1, max: 1, step: 0.001, default: 0, trackGradient: "linear-gradient(90deg,var(--tb-a-blue-500),var(--tb-a-amber-500))" },
    { name: "tint", label: "Tint", type: "scalar", min: -1, max: 1, step: 0.001, default: 0, trackGradient: "linear-gradient(90deg,var(--tb-a-green-500),#d946ef)" },
    { name: "pivot", label: "Pivot", type: "scalar", min: 0, max: 1, step: 0.001, default: 0.5 },
    { name: "md", label: "Midtone Detail", type: "scalar", min: -1, max: 1, step: 0.001, default: 0 },
    { name: "boffset", label: "Black Offset", type: "scalar", min: -1, max: 1, step: 0.001, default: 0 }
  );
  return ps;
})();

export const colorCorrectionNode: NodeDefinition = {
  type: "color-correction",
  name: "Color Correction",
  category: "image",
  subcategory: "modifier",
  description:
    "Hue, saturation, brightness, contrast, and per-channel RGB curves.",
  backend: "webgl2",
  inputs: [{ name: "image", type: "image", required: true }],
  params: [
    {
      name: "hue",
      label: "Hue (°)",
      type: "scalar",
      min: -180,
      max: 180,
      step: 1,
      default: 0,
      trackGradient:
        "linear-gradient(90deg,#ff0000,#ffff00,#00ff00,#00ffff,#0000ff,#ff00ff,#ff0000)",
    },
    {
      name: "saturation",
      label: "Saturation",
      type: "scalar",
      min: 0,
      max: 50,
      softMax: 2,
      step: 0.01,
      default: 1,
    },
    {
      name: "contrast",
      label: "Contrast",
      type: "scalar",
      min: 0,
      max: 4,
      softMax: 2,
      step: 0.01,
      default: 1,
      trackGradient: "linear-gradient(90deg,#000,#fff)",
    },
    {
      name: "brightness",
      label: "Brightness",
      type: "scalar",
      min: -1,
      max: 1,
      step: 0.01,
      default: 0,
    },
    {
      name: "curves",
      label: "RGB Curves",
      type: "curves",
      default: defaultCurvesValue(),
    },
    ...GRADE_PARAMS,
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const output = ctx.allocImage();
    const src = inputs["image"];
    if (!src || src.kind !== "image") {
      ctx.clearTarget(output, [0, 0, 0, 1]);
      return { primary: output };
    }

    const gl = ctx.gl;
    const stateKey = `color-correction:${nodeId}`;
    let state = ctx.state[stateKey] as CCState | undefined;
    if (!state || !state.lut) {
      state = {
        lut: allocLutTexture(gl),
        lutBuf: new Uint8Array(256 * 4),
      };
      ctx.state[stateKey] = state;
    }

    const curves = sanitizeCurvesValue(params.curves);
    const rL = buildLut256(curves.r);
    const gL = buildLut256(curves.g);
    const bL = buildLut256(curves.b);
    const mL = buildLut256(curves.rgb);
    const buf = state.lutBuf;
    for (let i = 0; i < 256; i++) {
      buf[i * 4 + 0] = rL[i];
      buf[i * 4 + 1] = gL[i];
      buf[i * 4 + 2] = bL[i];
      buf[i * 4 + 3] = mL[i];
    }
    gl.bindTexture(gl.TEXTURE_2D, state.lut);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      256,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      buf
    );
    gl.bindTexture(gl.TEXTURE_2D, null);

    const num = (name: string, d: number) =>
      typeof params[name] === "number" ? (params[name] as number) : d;

    const hueDeg = num("hue", 0);
    const saturation = num("saturation", 1);
    const contrast = num("contrast", 1);
    const brightness = num("brightness", 0);

    // Per wheel: (balanceX, balanceY, master/lum, exposure).
    const wheel = (w: string): [number, number, number, number] => [
      num(`${w}X`, 0),
      num(`${w}Y`, 0),
      num(`${w}Lum`, 0),
      num(`${w}Exp`, 0),
    ];
    const dark = wheel("dark");
    const shadow = wheel("shadow");
    const light = wheel("light");
    const global = wheel("global");

    const prog = ctx.getShader("color-correction/fs", FS);
    ctx.drawFullscreen(prog, output, (gl2) => {
      const u = (n: string) => gl2.getUniformLocation(prog, n);
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_2D, src.texture);
      gl2.uniform1i(u("u_src"), 0);
      gl2.activeTexture(gl2.TEXTURE1);
      gl2.bindTexture(gl2.TEXTURE_2D, state!.lut);
      gl2.uniform1i(u("u_lut"), 1);
      gl2.uniform1f(u("u_hue"), ((hueDeg % 360) + 360) / 360);
      gl2.uniform1f(u("u_saturation"), saturation);
      gl2.uniform1f(u("u_contrast"), contrast);
      gl2.uniform1f(u("u_brightness"), brightness);
      gl2.uniform4fv(u("u_dark"), dark);
      gl2.uniform4fv(u("u_shadow"), shadow);
      gl2.uniform4fv(u("u_light"), light);
      gl2.uniform4fv(u("u_global"), global);
      gl2.uniform4fv(u("u_sats"), [
        num("darkSat", 1),
        num("shadowSat", 1),
        num("lightSat", 1),
        num("globalSat", 1),
      ]);
      gl2.uniform1f(u("u_temp"), num("temp", 0));
      gl2.uniform1f(u("u_tint"), num("tint", 0));
      gl2.uniform1f(u("u_pivot"), num("pivot", 0.5));
      gl2.uniform1f(u("u_md"), num("md", 0));
      gl2.uniform1f(u("u_boffset"), num("boffset", 0));
    });

    return { primary: output };
  },

  dispose(ctx, nodeId) {
    const stateKey = `color-correction:${nodeId}`;
    const state = ctx.state[stateKey] as CCState | undefined;
    if (state?.lut) ctx.gl.deleteTexture(state.lut);
    delete ctx.state[stateKey];
  },
};
