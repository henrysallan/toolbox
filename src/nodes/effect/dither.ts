import type { ImageValue, NodeDefinition } from "@/engine/types";
import {
  KERNELS,
  ditherKernelBW,
  ditherKernelColor,
  ditherOrderedBW,
  ditherOrderedColor,
  ditherThresholdBW,
  ditherThresholdColor,
} from "./dither-algorithms";

// A linear downsample from the source into a smaller RGBA8 texture.
const DOWNSAMPLE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  outColor = texture(u_src, v_uv);
}`;

// Nearest-style blit — the actual nearest-filtering is set on the source
// texture before drawing, so this shader is just a passthrough sample.
const BLIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  outColor = texture(u_src, v_uv);
}`;

const ALGO_OPTIONS = [
  "floyd-steinberg",
  "atkinson",
  "stucki",
  "burkes",
  "sierra",
  "jarvis",
  "ordered",
  "threshold",
];

interface DitherState {
  tex: WebGLTexture | null;
  width: number;
  height: number;
  pixels: Uint8Array | null;
}

function allocRgba8(
  gl: WebGL2RenderingContext,
  w: number,
  h: number
): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error("dither: failed to create texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
    w,
    h,
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

export const ditherNode: NodeDefinition = {
  type: "dither",
  name: "Dither",
  category: "effect",
  description:
    "Quantize the input image with error-diffusion or ordered dithering.",
  backend: "webgl2",
  inputs: [{ name: "image", type: "image", required: true }],
  params: [
    {
      name: "algorithm",
      label: "Algorithm",
      type: "enum",
      options: ALGO_OPTIONS,
      default: "floyd-steinberg",
    },
    {
      name: "pixel_scale",
      label: "Pixel scale",
      type: "scalar",
      min: 1,
      max: 16,
      step: 1,
      default: 1,
    },
    {
      name: "threshold",
      label: "Threshold",
      type: "scalar",
      min: 1,
      max: 255,
      step: 1,
      default: 128,
    },
    {
      name: "spread",
      label: "Error spread",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.05,
      default: 1,
    },
    {
      name: "color_mode",
      label: "Color mode",
      type: "boolean",
      default: false,
    },
    {
      name: "levels",
      label: "Levels / channel",
      type: "scalar",
      min: 2,
      max: 8,
      step: 1,
      default: 2,
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

    const algo = (params.algorithm as string) ?? "floyd-steinberg";
    const ps = Math.max(1, Math.round((params.pixel_scale as number) ?? 1));
    const threshold = (params.threshold as number) ?? 128;
    const spread = (params.spread as number) ?? 1;
    const colorMode = !!params.color_mode;
    const levels = Math.max(
      2,
      Math.min(8, Math.round((params.levels as number) ?? 2))
    );

    const dw = Math.max(1, Math.round(src.width / ps));
    const dh = Math.max(1, Math.round(src.height / ps));

    const gl = ctx.gl;
    const stateKey = `dither:${nodeId}`;
    let state = ctx.state[stateKey] as DitherState | undefined;
    if (!state || state.width !== dw || state.height !== dh || !state.tex) {
      if (state?.tex) gl.deleteTexture(state.tex);
      state = {
        tex: allocRgba8(gl, dw, dh),
        width: dw,
        height: dh,
        pixels: new Uint8Array(dw * dh * 4),
      };
      ctx.state[stateKey] = state;
    }
    const tempImg: ImageValue = {
      kind: "image",
      texture: state.tex!,
      width: dw,
      height: dh,
    };

    // LINEAR filter for a clean anti-aliased downsample.
    gl.bindTexture(gl.TEXTURE_2D, state.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.bindTexture(gl.TEXTURE_2D, null);

    const downProg = ctx.getShader("dither/downsample", DOWNSAMPLE_FS);
    ctx.drawFullscreen(downProg, tempImg, (gl2) => {
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_2D, src.texture);
      gl2.uniform1i(gl2.getUniformLocation(downProg, "u_src"), 0);
    });

    // FBO is still bound to tempImg from drawFullscreen — read directly.
    const pixels = state.pixels!;
    gl.readPixels(0, 0, dw, dh, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    if (algo === "threshold") {
      if (colorMode) ditherThresholdColor(pixels, dw, dh, levels);
      else ditherThresholdBW(pixels, dw, dh, threshold);
    } else if (algo === "ordered") {
      if (colorMode) ditherOrderedColor(pixels, dw, dh, levels);
      else ditherOrderedBW(pixels, dw, dh, threshold);
    } else {
      const kernel = KERNELS[algo] ?? KERNELS["floyd-steinberg"];
      if (colorMode) ditherKernelColor(pixels, dw, dh, levels, spread, kernel);
      else ditherKernelBW(pixels, dw, dh, threshold, spread, kernel);
    }

    // Upload the dithered pixels back to the temp texture and switch to
    // NEAREST so the upscale to the full-size output stays crisp.
    gl.bindTexture(gl.TEXTURE_2D, state.tex);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      dw,
      dh,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_2D, null);

    const blitProg = ctx.getShader("dither/blit", BLIT_FS);
    ctx.drawFullscreen(blitProg, output, (gl2) => {
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_2D, state!.tex);
      gl2.uniform1i(gl2.getUniformLocation(blitProg, "u_src"), 0);
    });

    return { primary: output };
  },

  dispose(ctx, nodeId) {
    const stateKey = `dither:${nodeId}`;
    const cached = ctx.state[stateKey] as DitherState | undefined;
    if (cached?.tex) ctx.gl.deleteTexture(cached.tex);
    delete ctx.state[stateKey];
  },
};
