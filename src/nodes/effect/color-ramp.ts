import type { ColorRampValue, NodeDefinition } from "@/engine/types";
import type { ColorRampInterp } from "@/engine/color-ramp";
// The canonical model now lives engine-side (engine/color-ramp.ts) so engine
// rasterizers can sample a ramp without an engine→nodes import. Re-exported
// here for back-compat with existing importers (shape-cells, param-controls).
import {
  COLOR_RAMP_MAX_STOPS,
  type ColorRampStop,
} from "@/engine/color-ramp";
export { COLOR_RAMP_MAX_STOPS };
export type { ColorRampStop };

export function newStopId(): string {
  return `stop-${Math.random().toString(36).slice(2, 8)}`;
}

// Stops are uploaded into fixed-size uniform arrays. The shader walks the
// sorted stops to find the bracket around the input factor and interpolates
// between them according to the interpolation mode.
const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform int u_stopCount;
uniform float u_positions[${COLOR_RAMP_MAX_STOPS}];
uniform vec4  u_colors[${COLOR_RAMP_MAX_STOPS}];
uniform int u_interp; // 0: linear, 1: ease, 2: constant
out vec4 outColor;

vec4 sampleRamp(float t) {
  if (u_stopCount == 0) return vec4(t, t, t, 1.0);
  if (u_stopCount == 1) return u_colors[0];
  if (t <= u_positions[0]) return u_colors[0];
  if (t >= u_positions[u_stopCount - 1]) return u_colors[u_stopCount - 1];

  for (int i = 0; i < ${COLOR_RAMP_MAX_STOPS - 1}; i++) {
    if (i + 1 >= u_stopCount) break;
    float a = u_positions[i];
    float b = u_positions[i + 1];
    if (t >= a && t <= b) {
      float f = (t - a) / max(b - a, 0.0001);
      if (u_interp == 2) return u_colors[i];            // constant (left)
      if (u_interp == 1) f = smoothstep(0.0, 1.0, f);   // ease
      return mix(u_colors[i], u_colors[i + 1], f);
    }
  }
  return u_colors[u_stopCount - 1];
}

void main() {
  vec4 c = texture(u_src, v_uv);
  float lum = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  vec4 ramp = sampleRamp(clamp(lum, 0.0, 1.0));
  // Preserve the source's alpha — the ramp decides color, not coverage.
  outColor = vec4(ramp.rgb, ramp.a * c.a);
}`;

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(s, 16);
  return [
    ((n >> 16) & 0xff) / 255,
    ((n >> 8) & 0xff) / 255,
    (n & 0xff) / 255,
  ];
}

function interpToInt(m: string): number {
  switch (m) {
    case "linear": return 0;
    case "ease": return 1;
    case "constant": return 2;
    default: return 0;
  }
}

export const colorRampNode: NodeDefinition = {
  type: "color-ramp",
  name: "Color Ramp",
  category: "image",
  subcategory: "modifier",
  description:
    "Remaps the input's luminance through a gradient of user-defined color stops.",
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
      name: "interpolation",
      label: "Interpolation",
      type: "enum",
      options: ["linear", "ease", "constant"],
      default: "linear",
    },
  ],
  primaryOutput: "image",
  // The ramp itself, as a value. Aux rather than primary because this node is
  // still a luminance remap first — the tap just makes the palette reusable,
  // so one authored ramp can drive Stroke's colour or Rasterize Spline's fill
  // and stroke ramps. Spec: 080526_on-node-color-ramp.md.
  auxOutputs: [{ name: "ramp", type: "color_ramp" }],

  compute({ inputs, params, ctx }) {
    const rawStops = Array.isArray(params.stops)
      ? (params.stops as ColorRampStop[])
      : [];
    const sorted = [...rawStops]
      .filter((s) => typeof s.position === "number")
      .sort((a, b) => a.position - b.position)
      .slice(0, COLOR_RAMP_MAX_STOPS);
    // Emitted on every path, including the no-input one below: a Color Ramp
    // used purely as a palette source has nothing wired into `image`, and its
    // ramp still has to reach the consumer.
    const rampAux: ColorRampValue = {
      kind: "color_ramp",
      stops: sorted,
      interp: (params.interpolation as ColorRampInterp) ?? "linear",
    };

    const output = ctx.allocImage();
    const src = inputs["image"];
    if (!src || src.kind !== "image") {
      ctx.clearTarget(output, [0, 0, 0, 1]);
      return { primary: output, aux: { ramp: rampAux } };
    }

    const positions = new Float32Array(COLOR_RAMP_MAX_STOPS);
    const colors = new Float32Array(COLOR_RAMP_MAX_STOPS * 4);
    for (let i = 0; i < sorted.length; i++) {
      positions[i] = Math.max(0, Math.min(1, sorted[i].position));
      const [r, g, b] = hexToRgb(sorted[i].color ?? "#000000");
      const a = Math.max(0, Math.min(1, sorted[i].alpha ?? 1));
      colors[i * 4 + 0] = r;
      colors[i * 4 + 1] = g;
      colors[i * 4 + 2] = b;
      colors[i * 4 + 3] = a;
    }

    const interp = interpToInt((params.interpolation as string) ?? "linear");

    const prog = ctx.getShader("color-ramp/fs", FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
      gl.uniform1i(
        gl.getUniformLocation(prog, "u_stopCount"),
        sorted.length
      );
      gl.uniform1fv(
        gl.getUniformLocation(prog, "u_positions[0]"),
        positions
      );
      gl.uniform4fv(gl.getUniformLocation(prog, "u_colors[0]"), colors);
      gl.uniform1i(gl.getUniformLocation(prog, "u_interp"), interp);
    });

    return { primary: output, aux: { ramp: rampAux } };
  },
};
