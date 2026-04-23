import type { NodeDefinition } from "@/engine/types";

// Classic 2D displacement: per-pixel offset into the source is driven by a
// channel of a second image. After-Effects-style channel selection per axis
// so users can, e.g., take R for X and G for Y (typical for "displacement
// maps" shipped as RG images) or luminance for both axes (simple height
// maps).
const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform sampler2D u_disp;
uniform float u_amountX;
uniform float u_amountY;
uniform float u_midlevel;
uniform int u_channelX; // 0=R 1=G 2=B 3=A 4=luma
uniform int u_channelY;
uniform int u_wrap;     // 0=transparent 1=clamp 2=mirror
out vec4 outColor;

float pick(vec4 c, int ch) {
  if (ch == 0) return c.r;
  if (ch == 1) return c.g;
  if (ch == 2) return c.b;
  if (ch == 3) return c.a;
  return dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
}

vec2 wrapUv(vec2 uv) {
  if (u_wrap == 1) return clamp(uv, 0.0, 1.0);
  if (u_wrap == 2) return abs(fract(uv * 0.5) * 2.0 - 1.0);
  return uv;
}

void main() {
  vec4 d = texture(u_disp, v_uv);
  float vx = pick(d, u_channelX);
  float vy = pick(d, u_channelY);
  // Midlevel is the "no displacement" value. 0.5 is the standard encoding
  // for signed displacement in an 8-bit texture.
  vec2 offset = vec2(
    (vx - u_midlevel) * u_amountX,
    (vy - u_midlevel) * u_amountY
  );
  vec2 uv = v_uv + offset;
  if (u_wrap == 0 && (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0)) {
    outColor = vec4(0.0);
    return;
  }
  outColor = texture(u_src, wrapUv(uv));
}`;

const CHANNEL_OPTIONS = ["r", "g", "b", "a", "luminance"] as const;
const WRAP_OPTIONS = ["transparent", "clamp", "mirror"] as const;

function channelToInt(s: string): number {
  switch (s) {
    case "r":
      return 0;
    case "g":
      return 1;
    case "b":
      return 2;
    case "a":
      return 3;
    case "luminance":
    default:
      return 4;
  }
}

function wrapToInt(s: string): number {
  switch (s) {
    case "transparent":
      return 0;
    case "clamp":
      return 1;
    case "mirror":
      return 2;
    default:
      return 0;
  }
}

export const displaceNode: NodeDefinition = {
  type: "displace",
  name: "Displace",
  category: "effect",
  description:
    "Offset each pixel of the input by a vector read from a displacement image. Midlevel is the neutral (no-offset) value — 0.5 for signed 8-bit maps.",
  backend: "webgl2",
  inputs: [
    { name: "image", label: "image", type: "image", required: true },
    {
      name: "displacement",
      label: "displace",
      type: "image",
      required: true,
    },
  ],
  params: [
    {
      name: "amountX",
      label: "Amount X",
      type: "scalar",
      min: -1,
      max: 1,
      softMax: 0.5,
      step: 0.001,
      default: 0.05,
    },
    {
      name: "amountY",
      label: "Amount Y",
      type: "scalar",
      min: -1,
      max: 1,
      softMax: 0.5,
      step: 0.001,
      default: 0.05,
    },
    {
      name: "channelX",
      label: "Channel X",
      type: "enum",
      options: CHANNEL_OPTIONS as unknown as string[],
      default: "r",
    },
    {
      name: "channelY",
      label: "Channel Y",
      type: "enum",
      options: CHANNEL_OPTIONS as unknown as string[],
      default: "g",
    },
    {
      name: "midlevel",
      label: "Midlevel",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
    },
    {
      name: "wrap",
      label: "Edge",
      type: "enum",
      options: WRAP_OPTIONS as unknown as string[],
      default: "clamp",
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx }) {
    const output = ctx.allocImage();
    const src = inputs.image;
    const disp = inputs.displacement;
    if (!src || src.kind !== "image") {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }

    const prog = ctx.getShader("displace/fs", FS);
    // Missing displacement: degrade to a straight pass-through so the graph
    // stays visible while the user wires things up.
    const dispTex =
      disp && disp.kind === "image" ? disp.texture : src.texture;
    const channelX = channelToInt((params.channelX as string) ?? "r");
    const channelY = channelToInt((params.channelY as string) ?? "g");
    const wrap = wrapToInt((params.wrap as string) ?? "clamp");
    const amountX =
      disp && disp.kind === "image" ? ((params.amountX as number) ?? 0) : 0;
    const amountY =
      disp && disp.kind === "image" ? ((params.amountY as number) ?? 0) : 0;
    const midlevel = (params.midlevel as number) ?? 0.5;

    ctx.drawFullscreen(prog, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, dispTex);
      gl.uniform1i(gl.getUniformLocation(prog, "u_disp"), 1);
      gl.uniform1f(gl.getUniformLocation(prog, "u_amountX"), amountX);
      gl.uniform1f(gl.getUniformLocation(prog, "u_amountY"), amountY);
      gl.uniform1f(gl.getUniformLocation(prog, "u_midlevel"), midlevel);
      gl.uniform1i(gl.getUniformLocation(prog, "u_channelX"), channelX);
      gl.uniform1i(gl.getUniformLocation(prog, "u_channelY"), channelY);
      gl.uniform1i(gl.getUniformLocation(prog, "u_wrap"), wrap);
    });

    return { primary: output };
  },
};
