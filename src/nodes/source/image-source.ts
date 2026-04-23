import type { NodeDefinition } from "@/engine/types";

// u_hasUvIn: 0 = no UV field connected (use v_uv), 1 = UV texture, 2 = scalar
// broadcast (whole frame samples the same point). Fit math runs on the
// resolved UV so warps happen in output/canvas space before the aspect fit.
const FIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_invScale;
uniform float u_letterbox;
uniform int u_hasUvIn;
uniform sampler2D u_uvIn;
uniform vec2 u_uvConst;
out vec4 outColor;
void main() {
  vec2 uv;
  if (u_hasUvIn == 1) uv = texture(u_uvIn, v_uv).rg;
  else if (u_hasUvIn == 2) uv = u_uvConst;
  else uv = v_uv;

  vec2 s = 0.5 + (uv - 0.5) * u_invScale;
  if (u_letterbox > 0.5 && (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0)) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  // Source bitmap is uploaded without UNPACK_FLIP_Y (unreliable for ImageBitmap across browsers).
  // Flip vertically here so row 0 of the bitmap ends up at the top of the WebGL-Y-up render target.
  outColor = texture(u_src, vec2(s.x, 1.0 - s.y));
}`;

interface SourceState {
  bitmapRef: ImageBitmap | null;
  tex: WebGLTexture | null;
  // 1×1 placeholder so the u_uvIn sampler has a valid binding even when no
  // UV field is connected (WebGL requires every declared sampler to be
  // bound to something).
  zeroTex: WebGLTexture | null;
}

export const imageSourceNode: NodeDefinition = {
  type: "image-source",
  name: "Image Source",
  category: "source",
  description: "Uploads an image and produces it as the canonical output.",
  backend: "webgl2",
  inputs: [
    { name: "uv_in", label: "UV", type: "uv", required: false },
  ],
  params: [
    { name: "file", label: "Image", type: "file", default: null },
    {
      name: "fit",
      label: "Fit",
      type: "enum",
      options: ["cover", "contain", "stretch"],
      default: "cover",
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const output = ctx.allocImage();
    const bitmap = params.file as ImageBitmap | null | undefined;

    if (!bitmap) {
      ctx.clearTarget(output, [0, 0, 0, 1]);
      return { primary: output };
    }

    const stateKey = `image-source:${nodeId}`;
    const gl = ctx.gl;
    let cached = ctx.state[stateKey] as SourceState | undefined;
    if (!cached || cached.bitmapRef !== bitmap) {
      if (cached?.tex) gl.deleteTexture(cached.tex);
      const tex = gl.createTexture();
      if (!tex) throw new Error("image-source: failed to create texture");
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        bitmap
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      cached = {
        bitmapRef: bitmap,
        tex,
        zeroTex: cached?.zeroTex ?? null,
      };
      ctx.state[stateKey] = cached;
    }
    if (!cached.zeroTex) {
      cached.zeroTex = makeZeroTex(gl);
    }

    const uvIn = inputs.uv_in;
    let uvInMode = 0;
    let uvInTex: WebGLTexture | null = cached.zeroTex;
    let uvConst: [number, number] = [0, 0];
    if (uvIn) {
      if (uvIn.kind === "uv") {
        uvInMode = 1;
        uvInTex = uvIn.texture;
      } else if (uvIn.kind === "scalar") {
        uvInMode = 2;
        uvConst = [uvIn.value, uvIn.value];
      }
    }

    const imgAspect = bitmap.width / bitmap.height;
    const outAspect = output.width / output.height;
    const alpha = imgAspect / outAspect;
    const fit = (params.fit as string) ?? "cover";

    let invScale: [number, number];
    let letterbox = 0;
    if (fit === "stretch") {
      invScale = [1, 1];
    } else if (fit === "cover") {
      invScale = alpha > 1 ? [1 / alpha, 1] : [1, alpha];
    } else {
      invScale = alpha > 1 ? [1, alpha] : [1 / alpha, 1];
      letterbox = 1;
    }

    const prog = ctx.getShader("image-source/fit", FIT_FS);
    ctx.drawFullscreen(prog, output, (gl2) => {
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_2D, cached!.tex);
      gl2.uniform1i(gl2.getUniformLocation(prog, "u_src"), 0);
      gl2.uniform2f(
        gl2.getUniformLocation(prog, "u_invScale"),
        invScale[0],
        invScale[1]
      );
      gl2.uniform1f(gl2.getUniformLocation(prog, "u_letterbox"), letterbox);

      gl2.activeTexture(gl2.TEXTURE1);
      gl2.bindTexture(gl2.TEXTURE_2D, uvInTex);
      gl2.uniform1i(gl2.getUniformLocation(prog, "u_uvIn"), 1);
      gl2.uniform1i(gl2.getUniformLocation(prog, "u_hasUvIn"), uvInMode);
      gl2.uniform2f(
        gl2.getUniformLocation(prog, "u_uvConst"),
        uvConst[0],
        uvConst[1]
      );
    });

    return { primary: output };
  },

  dispose(ctx, nodeId) {
    const stateKey = `image-source:${nodeId}`;
    const cached = ctx.state[stateKey] as SourceState | undefined;
    if (cached?.tex) ctx.gl.deleteTexture(cached.tex);
    if (cached?.zeroTex) ctx.gl.deleteTexture(cached.zeroTex);
    delete ctx.state[stateKey];
  },
};

// 1×1 RGBA8 zero texture — a stand-in bound to u_uvIn when no UV field is
// connected so the sampler stays valid without affecting the output.
function makeZeroTex(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error("image-source: failed to create placeholder texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array([0, 0, 0, 0])
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}
