import type { NodeDefinition } from "@/engine/types";
import {
  type CurvePoint,
  computeMonotoneTangents,
  defaultCurvesValue,
  evalMonotoneCubic,
  sanitizeCurvesValue,
} from "./color-correction";

// Bake a 256-entry 8-bit lookup table from a monotone cubic curve. Mirrors
// the helper inside color-correction (kept local so this node owns its own
// minimal pipeline rather than depending on a private export).
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

// Single fullscreen pass: apply the master (combined RGB) curve to every
// channel, then the per-channel curve. The four curves are packed into one
// 256×1 RGBA texture — R/G/B carry the channel curves, A the master.
const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform sampler2D u_lut;
out vec4 outColor;

float lut(float v, int ch) {
  vec4 s = texture(u_lut, vec2(clamp(v, 0.0, 1.0), 0.5));
  if (ch == 0) return s.r;
  if (ch == 1) return s.g;
  if (ch == 2) return s.b;
  return s.a; // master
}

void main() {
  vec4 src = texture(u_src, v_uv);
  vec3 c = src.rgb;
  // Master (combined) curve first, then the per-channel curves.
  c = vec3(lut(c.r, 3), lut(c.g, 3), lut(c.b, 3));
  c = vec3(lut(c.r, 0), lut(c.g, 1), lut(c.b, 2));
  outColor = vec4(c, src.a);
}`;

interface CurvesState {
  lut: WebGLTexture | null;
  lutBuf: Uint8Array;
}

function allocLutTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error("rgb-curves: failed to create LUT texture");
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
  // LINEAR so 256 entries interpolate smoothly across 8-bit input values.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

export const rgbCurvesNode: NodeDefinition = {
  type: "rgb-curves",
  name: "RGB Curves",
  category: "image",
  subcategory: "modifier",
  description:
    "Tone curves — a combined RGB curve plus individual R / G / B curves.",
  backend: "webgl2",
  inputs: [{ name: "image", type: "image", required: true }],
  params: [
    {
      name: "curves",
      label: "Curves",
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
    const stateKey = `rgb-curves:${nodeId}`;
    let state = ctx.state[stateKey] as CurvesState | undefined;
    if (!state || !state.lut) {
      state = { lut: allocLutTexture(gl), lutBuf: new Uint8Array(256 * 4) };
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

    const prog = ctx.getShader("rgb-curves/fs", FS);
    ctx.drawFullscreen(prog, output, (gl2) => {
      const u = (n: string) => gl2.getUniformLocation(prog, n);
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_2D, src.texture);
      gl2.uniform1i(u("u_src"), 0);
      gl2.activeTexture(gl2.TEXTURE1);
      gl2.bindTexture(gl2.TEXTURE_2D, state!.lut);
      gl2.uniform1i(u("u_lut"), 1);
    });

    return { primary: output };
  },

  dispose(ctx, nodeId) {
    const stateKey = `rgb-curves:${nodeId}`;
    const state = ctx.state[stateKey] as CurvesState | undefined;
    if (state?.lut) ctx.gl.deleteTexture(state.lut);
    delete ctx.state[stateKey];
  },
};
