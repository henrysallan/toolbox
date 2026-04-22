import type { NodeDefinition } from "@/engine/types";

export interface CurvePoint {
  id: string;
  x: number; // 0..1 input
  y: number; // 0..1 output
}

export type CurveChannel = "rgb" | "r" | "g" | "b";

export interface CurvesValue {
  rgb: CurvePoint[];
  r: CurvePoint[];
  g: CurvePoint[];
  b: CurvePoint[];
}

const CURVE_CHANNELS: CurveChannel[] = ["rgb", "r", "g", "b"];

export function newCurvePointId(): string {
  return `cp-${Math.random().toString(36).slice(2, 8)}`;
}

export function defaultCurveChannel(): CurvePoint[] {
  return [
    { id: newCurvePointId(), x: 0, y: 0 },
    { id: newCurvePointId(), x: 1, y: 1 },
  ];
}

export function defaultCurvesValue(): CurvesValue {
  return {
    rgb: defaultCurveChannel(),
    r: defaultCurveChannel(),
    g: defaultCurveChannel(),
    b: defaultCurveChannel(),
  };
}

// Monotone cubic Hermite interpolation (Fritsch-Carlson). Chosen because it
// won't overshoot — critical for curve editors where points are clamped 0..1.
export function computeMonotoneTangents(pts: CurvePoint[]): number[] {
  const n = pts.length;
  if (n < 2) return new Array(n).fill(0);
  const d = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    d[i] = dx === 0 ? 0 : (pts[i + 1].y - pts[i].y) / dx;
  }
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else m[i] = (d[i - 1] + d[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
    } else {
      const a = m[i] / d[i];
      const b = m[i + 1] / d[i];
      const h = a * a + b * b;
      if (h > 9) {
        const t = 3 / Math.sqrt(h);
        m[i] = t * a * d[i];
        m[i + 1] = t * b * d[i];
      }
    }
  }
  return m;
}

export function evalMonotoneCubic(
  pts: CurvePoint[],
  tangents: number[],
  x: number
): number {
  if (pts.length === 0) return 0;
  if (pts.length === 1) return pts[0].y;
  if (x <= pts[0].x) return pts[0].y;
  if (x >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
  let i = 0;
  for (; i < pts.length - 1; i++) {
    if (x <= pts[i + 1].x) break;
  }
  const x0 = pts[i].x;
  const x1 = pts[i + 1].x;
  const h = x1 - x0;
  if (h === 0) return pts[i].y;
  const t = (x - x0) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return (
    h00 * pts[i].y +
    h10 * h * tangents[i] +
    h01 * pts[i + 1].y +
    h11 * h * tangents[i + 1]
  );
}

function sanitizeCurveChannel(raw: unknown): CurvePoint[] {
  if (!Array.isArray(raw) || raw.length === 0) return defaultCurveChannel();
  const pts = (raw as CurvePoint[])
    .filter(
      (p) =>
        p &&
        typeof p.x === "number" &&
        typeof p.y === "number" &&
        typeof p.id === "string"
    )
    .map((p) => ({
      id: p.id,
      x: Math.max(0, Math.min(1, p.x)),
      y: Math.max(0, Math.min(1, p.y)),
    }))
    .sort((a, b) => a.x - b.x);
  if (pts.length < 2) return defaultCurveChannel();
  return pts;
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
uniform float u_saturation;  // 1.0 = identity
uniform float u_contrast;    // 1.0 = identity, pivots on 0.5
uniform float u_brightness;  // 0.0 = identity, additive
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

void main() {
  vec4 src = texture(u_src, v_uv);
  vec3 c = src.rgb;

  // Brightness: additive, pre-clamp.
  c += vec3(u_brightness);

  // Contrast: pivot around 0.5.
  c = (c - 0.5) * u_contrast + 0.5;

  c = clamp(c, 0.0, 1.0);

  // Hue + saturation in HSV.
  vec3 hsv = rgb2hsv(c);
  hsv.x = fract(hsv.x + u_hue + 1.0);
  hsv.y = clamp(hsv.y * u_saturation, 0.0, 1.0);
  c = hsv2rgb(hsv);

  c = clamp(c, 0.0, 1.0);

  // Master curve first (treated as a per-channel tone curve applied equally),
  // then per-channel curves stacked on top.
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

export const colorCorrectionNode: NodeDefinition = {
  type: "color-correction",
  name: "Color Correction",
  category: "effect",
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

    const hueDeg = (params.hue as number) ?? 0;
    const saturation = (params.saturation as number) ?? 1;
    const contrast = (params.contrast as number) ?? 1;
    const brightness = (params.brightness as number) ?? 0;

    const prog = ctx.getShader("color-correction/fs", FS);
    ctx.drawFullscreen(prog, output, (gl2) => {
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_2D, src.texture);
      gl2.uniform1i(gl2.getUniformLocation(prog, "u_src"), 0);
      gl2.activeTexture(gl2.TEXTURE1);
      gl2.bindTexture(gl2.TEXTURE_2D, state!.lut);
      gl2.uniform1i(gl2.getUniformLocation(prog, "u_lut"), 1);
      gl2.uniform1f(
        gl2.getUniformLocation(prog, "u_hue"),
        ((hueDeg % 360) + 360) / 360
      );
      gl2.uniform1f(
        gl2.getUniformLocation(prog, "u_saturation"),
        saturation
      );
      gl2.uniform1f(gl2.getUniformLocation(prog, "u_contrast"), contrast);
      gl2.uniform1f(
        gl2.getUniformLocation(prog, "u_brightness"),
        brightness
      );
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
