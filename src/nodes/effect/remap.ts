import type {
  InputSocketDef,
  NodeDefinition,
  ScalarValue,
  SocketType,
} from "@/engine/types";

// Linear remap from [in_min, in_max] to [out_min, out_max].
//
// Polymorphic on the input: scalar mode runs on CPU and emits a scalar;
// image mode runs a per-pixel shader and emits an image (same remap
// applied to every channel including alpha). Parameters are always
// scalar — if you need per-channel remaps, stack multiple Remap nodes
// after channel-picking with Color Correction.
//
// Switch modes with the `mode` param. Same pattern as Math node's
// scalar/uv toggle — resolveInputs + resolvePrimaryOutput re-type the
// sockets on each change.

const REMAP_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform float u_inMin;
uniform float u_inMax;
uniform float u_outMin;
uniform float u_outMax;
uniform int u_clamp;
out vec4 outColor;
void main() {
  vec4 c = texture(u_src, v_uv);
  float range = max(u_inMax - u_inMin, 1e-6);
  vec4 t = (c - vec4(u_inMin)) / range;
  if (u_clamp == 1) t = clamp(t, vec4(0.0), vec4(1.0));
  outColor = vec4(u_outMin) + t * (u_outMax - u_outMin);
}`;

function modeOf(params: Record<string, unknown>): "scalar" | "image" {
  return params.mode === "image" ? "image" : "scalar";
}

export const remapNode: NodeDefinition = {
  type: "remap",
  name: "Remap",
  category: "effect",
  description:
    "Remap an input from [in_min, in_max] to [out_min, out_max]. Scalar mode drives animation; image mode remaps every pixel's channels through the same range.",
  backend: "webgl2",
  inputs: [{ name: "input", type: "scalar", required: true }],
  resolveInputs(params): InputSocketDef[] {
    const t: SocketType = modeOf(params) === "image" ? "image" : "scalar";
    return [
      {
        name: "input",
        label: modeOf(params) === "image" ? "Image" : "Input",
        type: t,
        required: true,
      },
    ];
  },
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["scalar", "image"],
      default: "scalar",
    },
    {
      name: "in_min",
      label: "In min",
      type: "scalar",
      min: -10,
      max: 10,
      step: 0.001,
      default: 0,
    },
    {
      name: "in_max",
      label: "In max",
      type: "scalar",
      min: -10,
      max: 10,
      step: 0.001,
      default: 1,
    },
    {
      name: "out_min",
      label: "Out min",
      type: "scalar",
      min: -10,
      max: 10,
      step: 0.001,
      default: 0,
    },
    {
      name: "out_max",
      label: "Out max",
      type: "scalar",
      min: -10,
      max: 10,
      step: 0.001,
      default: 1,
    },
    {
      name: "clamp",
      label: "Clamp",
      type: "boolean",
      default: true,
    },
  ],
  primaryOutput: "scalar",
  resolvePrimaryOutput(params): SocketType {
    return modeOf(params) === "image" ? "image" : "scalar";
  },
  auxOutputs: [],

  compute({ inputs, params, ctx }) {
    const mode = modeOf(params);
    const inMin = (params.in_min as number) ?? 0;
    const inMax = (params.in_max as number) ?? 1;
    const outMin = (params.out_min as number) ?? 0;
    const outMax = (params.out_max as number) ?? 1;
    const clampFlag = !!params.clamp;

    if (mode === "image") {
      const output = ctx.allocImage();
      const src = inputs.input;
      if (!src || src.kind !== "image") {
        ctx.clearTarget(output, [0, 0, 0, 0]);
        return { primary: output };
      }
      const prog = ctx.getShader("remap/image", REMAP_FS);
      ctx.drawFullscreen(prog, output, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, src.texture);
        gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
        gl.uniform1f(gl.getUniformLocation(prog, "u_inMin"), inMin);
        gl.uniform1f(gl.getUniformLocation(prog, "u_inMax"), inMax);
        gl.uniform1f(gl.getUniformLocation(prog, "u_outMin"), outMin);
        gl.uniform1f(gl.getUniformLocation(prog, "u_outMax"), outMax);
        gl.uniform1i(
          gl.getUniformLocation(prog, "u_clamp"),
          clampFlag ? 1 : 0
        );
      });
      return { primary: output };
    }

    // scalar mode
    const src = inputs.input;
    const v = src?.kind === "scalar" ? src.value : 0;
    const range = Math.max(inMax - inMin, 1e-6);
    let t = (v - inMin) / range;
    if (clampFlag) t = Math.max(0, Math.min(1, t));
    const result = outMin + t * (outMax - outMin);
    return {
      primary: { kind: "scalar", value: result } satisfies ScalarValue,
    };
  },
};
