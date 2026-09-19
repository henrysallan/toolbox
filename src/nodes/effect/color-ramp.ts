import type { ColorRampValue, NodeDefinition } from "@/engine/types";
// The canonical model now lives engine-side (engine/color-ramp.ts) so engine
// rasterizers can sample a ramp without an engine→nodes import. Re-exported
// here for back-compat with existing importers (shape-cells, param-controls).
import {
  COLOR_RAMP_MAX_STOPS,
  colorRampLutGlsl,
  getColorRampLut,
  normalizeRampInterp,
  normalizeRampSpace,
  rampInterpParam,
  rampSpaceParam,
  releaseColorRampLut,
  type ColorRampLutState,
  type ColorRampStop,
} from "@/engine/color-ramp";
export { COLOR_RAMP_MAX_STOPS };
export type { ColorRampStop };

export function newStopId(): string {
  return `stop-${Math.random().toString(36).slice(2, 8)}`;
}

// The ramp is baked on the CPU into a 1-D LUT (engine/color-ramp.ts —
// every interpolation curve and blend color space lives in that one
// sampler) and the shader does a single filtered fetch. `constant` snaps
// to texel centres inside the LUT helper so its steps stay hard.
export const COLOR_RAMP_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform float u_offset;
${colorRampLutGlsl("sampleRamp", "u_lut", "u_constant")}
out vec4 outColor;

void main() {
  vec4 c = texture(u_src, v_uv);
  float lum = clamp(dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
  // Offset 0 keeps lum as-is so 1.0 still hits the last stop.
  // Any other offset wraps (fract) so the gradient loops past 1.
  float t = lum;
  if (abs(u_offset) > 1e-8) t = fract(lum + u_offset);
  vec4 ramp = sampleRamp(t);
  // Preserve the source's alpha — the ramp decides color, not coverage.
  outColor = vec4(ramp.rgb, ramp.a * c.a);
}`;

const stateKey = (nodeId: string) => `color-ramp:${nodeId}`;

export const colorRampNode: NodeDefinition = {
  type: "color-ramp",
  name: "Color Ramp",
  category: "image",
  subcategory: "modifier",
  description:
    "Remaps the input's luminance through a gradient of user-defined color stops. Offset slides the ramp; values past 1 wrap so the gradient loops. Interpolation picks the curve between stops (eases, splines through the stops, a Gaussian smooth, hard steps); Color space picks where the blend happens (sRGB, linear light, OKLab, OKLCH).",
  facts: {
    gotchas: [
      "Remaps by luminance (Rec.709 weighted), not per channel; the source's own alpha is preserved and multiplied by the ramp stop's alpha.",
      "offset=0 pins t=1 exactly to the last stop; any nonzero offset wraps the whole 0..1 domain via fract(), shifting what shows at the extremes.",
      "Up to 16 stops — extras are silently dropped after sorting by position.",
      "The ramp aux always emits the sorted stop list, even with nothing wired into image — it works as a pure palette source into Stroke/Rasterize Spline.",
      "interpolation=cardinal can overshoot past a stop's color; monotone is the no-overshoot spline. bspline approximates: interior stops pull the curve rather than pin it.",
      "space=oklch / oklch_long rotate hue the short / long way round with chroma kept up; out-of-gamut samples lose chroma, not hue. Identical hues under oklch_long make a full rainbow turn.",
      "The ramp is sampled through a 1024-entry LUT: a `constant` step lands on a 1/1024 grid of t.",
    ],
  },
  backend: "webgl2",
  // NOT required: since the node gained a `ramp` aux output
  // (080526_on-node-color-ramp.md) a Color Ramp used purely as a palette
  // source — authored on the node body, wired into Stroke or Rasterize
  // Spline's ramp param — is a legitimate graph with nothing on `image`.
  // Leaving it required would flag every one of those as unwired forever.
  inputs: [{ name: "image", type: "image", required: false }],
  // No headerControl for `interpolation`, deliberately: an enum dropdown in
  // the header sets a width floor of its own (wide enough for "constant"),
  // and this node is meant to sit narrow. Interpolation is a set-once choice
  // — the panel is the right home for it. See 080526_on-node-color-ramp.md.
  params: [
    {
      name: "stops",
      label: "Ramp",
      type: "color_ramp",
      default: [
        { id: "stop-a", position: 0, color: "#000000" },
        { id: "stop-b", position: 1, color: "#ffffff" },
      ] as ColorRampStop[],
    },
    {
      name: "offset",
      label: "Offset",
      type: "scalar",
      min: 0,
      max: 8,
      softMax: 1,
      step: 0.001,
      default: 0,
    },
    rampInterpParam({ name: "interpolation", label: "Interpolation" }),
    rampSpaceParam({ name: "space", label: "Color space" }),
  ],
  primaryOutput: "image",
  // The ramp itself, as a value. Aux rather than primary because this node is
  // still a luminance remap first — the tap just makes the palette reusable,
  // so one authored ramp can drive Stroke's colour or Rasterize Spline's fill
  // and stroke ramps. Spec: 080526_on-node-color-ramp.md.
  auxOutputs: [{ name: "ramp", type: "color_ramp" }],

  compute({ inputs, params, ctx, nodeId }) {
    const rawStops = Array.isArray(params.stops)
      ? (params.stops as ColorRampStop[])
      : [];
    const sorted = [...rawStops]
      .filter((s) => typeof s.position === "number")
      .sort((a, b) => a.position - b.position)
      .slice(0, COLOR_RAMP_MAX_STOPS);
    const interp = normalizeRampInterp(params.interpolation);
    const space = normalizeRampSpace(params.space);
    // Emitted on every path, including the no-input one below: a Color Ramp
    // used purely as a palette source has nothing wired into `image`, and its
    // ramp still has to reach the consumer.
    const rampAux: ColorRampValue = {
      kind: "color_ramp",
      stops: sorted,
      interp,
      space,
    };

    const output = ctx.allocImage();
    const src = inputs["image"];
    if (!src || src.kind !== "image") {
      ctx.clearTarget(output, [0, 0, 0, 1]);
      return { primary: output, aux: { ramp: rampAux } };
    }

    const key = stateKey(nodeId);
    const state = (ctx.state[key] ??= {} as ColorRampLutState) as ColorRampLutState;
    const lut = getColorRampLut(ctx, state, sorted, interp, space);
    const offset = Number.isFinite(params.offset as number)
      ? (params.offset as number)
      : 0;

    const prog = ctx.getShader("color-ramp/fs-lut", COLOR_RAMP_FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, lut.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_lut"), 1);
      gl.uniform1i(
        gl.getUniformLocation(prog, "u_constant"),
        interp === "constant" ? 1 : 0
      );
      gl.uniform1f(gl.getUniformLocation(prog, "u_offset"), offset);
    });

    return { primary: output, aux: { ramp: rampAux } };
  },

  dispose(ctx, nodeId) {
    const key = stateKey(nodeId);
    releaseColorRampLut(ctx, ctx.state[key] as ColorRampLutState | undefined);
    delete ctx.state[key];
  },
};
