import type { RenderContext, SocketType, SocketValue } from "./types";

const MASK_TO_IMAGE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  float m = texture(u_src, v_uv).r;
  outColor = vec4(m, m, m, 1.0);
}`;

const IMAGE_TO_MASK_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  vec3 c = texture(u_src, v_uv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  outColor = vec4(l, 0.0, 0.0, 1.0);
}`;

export function coerceValue(
  value: SocketValue | undefined,
  target: SocketType,
  ctx: RenderContext
): SocketValue | undefined {
  if (!value) return undefined;
  if (value.kind === target) return value;

  if (value.kind === "mask" && target === "image") {
    const out = ctx.allocImage({ width: value.width, height: value.height });
    const program = ctx.getShader("__mask_to_image__", MASK_TO_IMAGE_FS);
    ctx.drawFullscreen(program, out, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, value.texture);
      gl.uniform1i(gl.getUniformLocation(program, "u_src"), 0);
    });
    return out;
  }

  if (value.kind === "image" && target === "mask") {
    const out = ctx.allocMask({ width: value.width, height: value.height });
    const program = ctx.getShader("__image_to_mask__", IMAGE_TO_MASK_FS);
    ctx.drawFullscreen(program, out, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, value.texture);
      gl.uniform1i(gl.getUniformLocation(program, "u_src"), 0);
    });
    return out;
  }

  if (value.kind === "scalar") {
    const v = value.value;
    if (target === "vec2") return { kind: "vec2", value: [v, v] };
    if (target === "vec3") return { kind: "vec3", value: [v, v, v] };
    if (target === "vec4") return { kind: "vec4", value: [v, v, v, v] };
  }

  return undefined;
}
