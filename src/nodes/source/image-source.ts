import type { NodeDefinition } from "@/engine/types";

const FIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_invScale;
uniform float u_letterbox;
out vec4 outColor;
void main() {
  vec2 s = 0.5 + (v_uv - 0.5) * u_invScale;
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
}

export const imageSourceNode: NodeDefinition = {
  type: "image-source",
  name: "Image Source",
  category: "source",
  description: "Uploads an image and produces it as the canonical output.",
  backend: "webgl2",
  inputs: [],
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

  compute({ params, ctx, nodeId }) {
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
      cached = { bitmapRef: bitmap, tex };
      ctx.state[stateKey] = cached;
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
    });

    return { primary: output };
  },

  dispose(ctx, nodeId) {
    const stateKey = `image-source:${nodeId}`;
    const cached = ctx.state[stateKey] as SourceState | undefined;
    if (cached?.tex) ctx.gl.deleteTexture(cached.tex);
    delete ctx.state[stateKey];
  },
};
