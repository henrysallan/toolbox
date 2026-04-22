import type { ImageValue, InputSocketDef, NodeDefinition } from "@/engine/types";

export type BlendMode = "mix" | "normal" | "overlay" | "screen" | "multiply";

export interface MergeLayer {
  id: string;
  mode: BlendMode;
  opacity: number;
}

const BLIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  outColor = texture(u_src, v_uv);
}`;

const BLEND_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_base;
uniform sampler2D u_layer;
uniform float u_opacity;
uniform int u_mode;
out vec4 outColor;

vec3 overlayCh(vec3 a, vec3 b) {
  return mix(2.0 * a * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b), step(0.5, a));
}

void main() {
  vec3 a = texture(u_base, v_uv).rgb;
  vec3 b = texture(u_layer, v_uv).rgb;
  vec3 r;
  if (u_mode == 0) r = b;                       // mix: pure lerp via u_opacity
  else if (u_mode == 1) r = b;                  // normal
  else if (u_mode == 2) r = overlayCh(a, b);    // overlay
  else if (u_mode == 3) r = 1.0 - (1.0 - a) * (1.0 - b); // screen
  else if (u_mode == 4) r = a * b;              // multiply
  else r = b;
  outColor = vec4(mix(a, r, u_opacity), 1.0);
}`;

function modeToInt(m: BlendMode): number {
  switch (m) {
    case "mix": return 0;
    case "normal": return 1;
    case "overlay": return 2;
    case "screen": return 3;
    case "multiply": return 4;
  }
}

export function newLayerId(): string {
  return `lyr-${Math.random().toString(36).slice(2, 8)}`;
}

export const mergeNode: NodeDefinition = {
  type: "merge",
  name: "Merge",
  category: "effect",
  description: "Blends a base image with one or more layer images.",
  backend: "webgl2",
  inputs: [{ name: "base", type: "image", required: true }],
  resolveInputs(params) {
    const layers = (params.layers as MergeLayer[]) ?? [];
    const result: InputSocketDef[] = [
      { name: "base", type: "image", required: true },
    ];
    layers.forEach((l, i) => {
      result.push({
        name: `layer:${l.id}`,
        label: `layer ${i + 1}`,
        type: "image",
        required: false,
      });
    });
    return result;
  },
  params: [
    {
      name: "layers",
      label: "Layers",
      type: "merge_layers",
      default: [{ id: "lyr-initial", mode: "normal", opacity: 1 }],
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx }) {
    const output = ctx.allocImage();
    const base = inputs["base"];
    if (!base || base.kind !== "image") {
      ctx.clearTarget(output, [0, 0, 0, 1]);
      return { primary: output };
    }

    const layers = (params.layers as MergeLayer[]) ?? [];
    const connected: Array<{ layer: MergeLayer; img: ImageValue }> = [];
    for (const l of layers) {
      const v = inputs[`layer:${l.id}`];
      if (v && v.kind === "image") connected.push({ layer: l, img: v });
    }

    const blitProg = ctx.getShader("merge/blit", BLIT_FS);
    if (connected.length === 0) {
      ctx.drawFullscreen(blitProg, output, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, base.texture);
        gl.uniform1i(gl.getUniformLocation(blitProg, "u_src"), 0);
      });
      return { primary: output };
    }

    const blendProg = ctx.getShader("merge/blend", BLEND_FS);
    let current: ImageValue = base;
    for (let i = 0; i < connected.length; i++) {
      const { layer, img } = connected[i];
      const isLast = i === connected.length - 1;
      const dest = isLast ? output : ctx.allocImage();
      ctx.drawFullscreen(blendProg, dest, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, current.texture);
        gl.uniform1i(gl.getUniformLocation(blendProg, "u_base"), 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, img.texture);
        gl.uniform1i(gl.getUniformLocation(blendProg, "u_layer"), 1);
        gl.uniform1f(
          gl.getUniformLocation(blendProg, "u_opacity"),
          layer.opacity
        );
        gl.uniform1i(
          gl.getUniformLocation(blendProg, "u_mode"),
          modeToInt(layer.mode)
        );
      });
      if (current !== base) ctx.releaseTexture(current.texture);
      current = dest;
    }

    return { primary: output };
  },
};
