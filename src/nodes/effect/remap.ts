import type {
  InputSocketDef,
  NodeDefinition,
  ScalarFieldNode,
  ScalarFieldValue,
  ScalarValue,
  SocketType,
  SocketValue,
} from "@/engine/types";

// Linear remap from [in_min, in_max] to [out_min, out_max].
//
// Three pipelines coexist on this single node:
//   - Scalar:  primary input/output (CPU value, current behavior)
//   - Image:   primary input/output when mode = "image" (per-pixel shader)
//   - Field:   `input_field` input + `field` aux output, always
//              available regardless of mode. Wires straight through
//              the SDF compiler — drop a Remap between Noise.field
//              and a downstream consumer (Polygon.sides_field,
//              Rotate.angle_field, etc.) and the remap inlines into
//              the compiled shader.
//
// The mode enum still gates scalar vs image (those are mutually
// exclusive — either CPU or rasterized). Field is orthogonal: its
// input/output are always exposed, and feeding either with no value
// no-ops cleanly.

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
  category: "utility",
  description:
    "Remap an input from [in_min, in_max] to [out_min, out_max]. Mode chooses between Scalar (CPU value) and Image (per-pixel shader) for the primary path. The Input Field socket + Field output are always available — wire a scalar_field in to get a remapped scalar_field out, inlined into the SDF shader.",
  backend: "webgl2",
  inputs: [
    { name: "input", type: "scalar", required: true },
    {
      name: "input_field",
      type: "scalar_field",
      required: false,
      label: "Input Field",
    },
  ],
  resolveInputs(params): InputSocketDef[] {
    const t: SocketType = modeOf(params) === "image" ? "image" : "scalar";
    return [
      {
        name: "input",
        label: modeOf(params) === "image" ? "Image" : "Input",
        type: t,
        required: true,
      },
      {
        name: "input_field",
        type: "scalar_field",
        required: false,
        label: "Input Field",
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
  auxOutputs: [
    {
      name: "field",
      type: "scalar_field",
      description:
        "Remapped scalar field — the same linear remap applied per-pixel in the SDF shader. Wire here when feeding from Noise.field, or to chain remaps inside an SDF graph.",
    },
  ],

  compute({ inputs, params, ctx }) {
    const mode = modeOf(params);
    const inMin = (params.in_min as number) ?? 0;
    const inMax = (params.in_max as number) ?? 1;
    const outMin = (params.out_min as number) ?? 0;
    const outMax = (params.out_max as number) ?? 1;
    const clampFlag = !!params.clamp;

    // Field path is always built. If a field is wired, wrap it in a
    // remap AST. If not but a scalar is wired, wrap the scalar as a
    // constant field so downstream consumers can still pull a field
    // (a scalar Remap gracefully degrades to a constant field).
    const fieldChild = buildFieldChild(inputs);
    const fieldOut: ScalarFieldValue = {
      kind: "scalar_field",
      root: {
        kind: "remap",
        child: fieldChild,
        inMin,
        inMax,
        outMin,
        outMax,
        clamp: clampFlag,
      },
    };

    if (mode === "image") {
      const output = ctx.allocImage();
      const src = inputs.input;
      if (!src || src.kind !== "image") {
        ctx.clearTarget(output, [0, 0, 0, 0]);
        return { primary: output, aux: { field: fieldOut } };
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
      return { primary: output, aux: { field: fieldOut } };
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
      aux: { field: fieldOut },
    };
  },
};

// Pick the field's child AST. Priority:
//   1. Wired input_field — pass through directly.
//   2. Wired scalar input — wrap as a constant field.
//   3. Nothing wired — constant field of value 0.
function buildFieldChild(
  inputs: Record<string, SocketValue | undefined>
): ScalarFieldNode {
  const f = inputs.input_field;
  if (f && f.kind === "scalar_field") return (f as ScalarFieldValue).root;
  const s = inputs.input;
  if (s && s.kind === "scalar") return { kind: "constant", value: s.value };
  return { kind: "constant", value: 0 };
}
