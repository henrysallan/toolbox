import type { ImageValue, InputSocketDef, NodeDefinition } from "@/engine/types";

export type BlendMode =
  | "mix"
  | "normal"
  | "overlay"
  | "screen"
  | "multiply"
  | "add"
  | "subtract"
  | "divide"
  | "difference"
  | "average"
  | "hard-light"
  | "soft-light"
  | "vivid-light"
  | "pin-light"
  | "linear-light"
  | "hard-mix"
  | "lighten"
  | "darken"
  | "lighter-color"
  | "darker-color"
  | "color-dodge"
  | "color-burn"
  | "linear-dodge"
  | "linear-burn"
  | "exclusion"
  | "negation"
  | "reflect"
  | "glow"
  | "phoenix";

// Canonical order for the UI dropdown. Grouped roughly by family so the
// picker is scannable. `mix` stays at the tail (legacy alias of `normal`
// kept alive only so existing saves keep loading).
export const BLEND_MODE_ORDER: BlendMode[] = [
  "normal",
  "add",
  "subtract",
  "multiply",
  "divide",
  "difference",
  "average",
  "screen",
  "overlay",
  "hard-light",
  "soft-light",
  "vivid-light",
  "pin-light",
  "linear-light",
  "hard-mix",
  "lighten",
  "darken",
  "lighter-color",
  "darker-color",
  "color-dodge",
  "color-burn",
  "linear-dodge",
  "linear-burn",
  "exclusion",
  "negation",
  "reflect",
  "glow",
  "phoenix",
  "mix",
];

const BLEND_LABELS: Record<BlendMode, string> = {
  normal: "Normal",
  add: "Add",
  subtract: "Subtract",
  multiply: "Multiply",
  divide: "Divide",
  difference: "Difference",
  average: "Average",
  screen: "Screen",
  overlay: "Overlay",
  "hard-light": "Hard Light",
  "soft-light": "Soft Light",
  "vivid-light": "Vivid Light",
  "pin-light": "Pin Light",
  "linear-light": "Linear Light",
  "hard-mix": "Hard Mix",
  lighten: "Lighten",
  darken: "Darken",
  "lighter-color": "Lighter Color",
  "darker-color": "Darker Color",
  "color-dodge": "Color Dodge",
  "color-burn": "Color Burn",
  "linear-dodge": "Linear Dodge",
  "linear-burn": "Linear Burn",
  exclusion: "Exclusion",
  negation: "Negation",
  reflect: "Reflect",
  glow: "Glow",
  phoenix: "Phoenix",
  mix: "Mix (legacy)",
};

export function blendModeLabel(mode: string): string {
  return BLEND_LABELS[mode as BlendMode] ?? mode;
}

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

// Layer `b` is composited over base `a` with a Porter-Duff "src over dst"
// that respects per-pixel layer alpha (scaled by the opacity slider). The
// selected blend mode is applied to RGB first; source-over then decides how
// much of that blended RGB reaches the output based on the effective alpha.
//
// Formulas match the widely-cited Photoshop / Krita set; division-based
// modes guard the denominator so backgrounds don't explode to infinity on
// black/white pixels.
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
vec3 hardLightCh(vec3 a, vec3 b) {
  return mix(2.0 * a * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b), step(0.5, b));
}
vec3 softLightCh(vec3 a, vec3 b) {
  // Photoshop formulation.
  vec3 lo = 2.0 * a * b + a * a * (1.0 - 2.0 * b);
  vec3 hi = 2.0 * a * (1.0 - b) + sqrt(max(a, vec3(0.0))) * (2.0 * b - 1.0);
  return mix(lo, hi, step(0.5, b));
}
vec3 colorDodgeCh(vec3 a, vec3 b) {
  return clamp(a / max(1.0 - b, vec3(1e-5)), 0.0, 1.0);
}
vec3 colorBurnCh(vec3 a, vec3 b) {
  return clamp(1.0 - (1.0 - a) / max(b, vec3(1e-5)), 0.0, 1.0);
}
vec3 vividLightCh(vec3 a, vec3 b) {
  vec3 burn = clamp(1.0 - (1.0 - a) / max(2.0 * b, vec3(1e-5)), 0.0, 1.0);
  vec3 dodge = clamp(a / max(1.0 - 2.0 * (b - 0.5), vec3(1e-5)), 0.0, 1.0);
  return mix(burn, dodge, step(0.5, b));
}
vec3 pinLightCh(vec3 a, vec3 b) {
  vec3 darken = min(a, 2.0 * b);
  vec3 lighten = max(a, 2.0 * (b - 0.5));
  return mix(darken, lighten, step(0.5, b));
}
vec3 reflectCh(vec3 a, vec3 b) {
  return clamp(a * a / max(1.0 - b, vec3(1e-5)), 0.0, 1.0);
}
vec3 glowCh(vec3 a, vec3 b) {
  return clamp(b * b / max(1.0 - a, vec3(1e-5)), 0.0, 1.0);
}

float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
  vec4 a = texture(u_base, v_uv);
  vec4 b = texture(u_layer, v_uv);
  vec3 blended;
  if      (u_mode == 0)  blended = b.rgb;                                     // mix (legacy)
  else if (u_mode == 1)  blended = b.rgb;                                     // normal
  else if (u_mode == 2)  blended = overlayCh(a.rgb, b.rgb);                   // overlay
  else if (u_mode == 3)  blended = 1.0 - (1.0 - a.rgb) * (1.0 - b.rgb);       // screen
  else if (u_mode == 4)  blended = a.rgb * b.rgb;                             // multiply
  else if (u_mode == 5)  blended = clamp(a.rgb + b.rgb, 0.0, 1.0);            // add
  else if (u_mode == 6)  blended = clamp(a.rgb - b.rgb, 0.0, 1.0);            // subtract
  else if (u_mode == 7)  blended = clamp(a.rgb / max(b.rgb, vec3(1e-5)), 0.0, 1.0); // divide
  else if (u_mode == 8)  blended = abs(a.rgb - b.rgb);                        // difference
  else if (u_mode == 9)  blended = (a.rgb + b.rgb) * 0.5;                     // average
  else if (u_mode == 10) blended = hardLightCh(a.rgb, b.rgb);                 // hard light
  else if (u_mode == 11) blended = softLightCh(a.rgb, b.rgb);                 // soft light
  else if (u_mode == 12) blended = vividLightCh(a.rgb, b.rgb);                // vivid light
  else if (u_mode == 13) blended = pinLightCh(a.rgb, b.rgb);                  // pin light
  else if (u_mode == 14) blended = clamp(a.rgb + 2.0 * b.rgb - 1.0, 0.0, 1.0); // linear light
  else if (u_mode == 15) blended = step(vec3(1.0), a.rgb + b.rgb);            // hard mix
  else if (u_mode == 16) blended = max(a.rgb, b.rgb);                         // lighten
  else if (u_mode == 17) blended = min(a.rgb, b.rgb);                         // darken
  else if (u_mode == 18) blended = luma(a.rgb) > luma(b.rgb) ? a.rgb : b.rgb; // lighter color
  else if (u_mode == 19) blended = luma(a.rgb) < luma(b.rgb) ? a.rgb : b.rgb; // darker color
  else if (u_mode == 20) blended = colorDodgeCh(a.rgb, b.rgb);                // color dodge
  else if (u_mode == 21) blended = colorBurnCh(a.rgb, b.rgb);                 // color burn
  else if (u_mode == 22) blended = clamp(a.rgb + b.rgb, 0.0, 1.0);            // linear dodge (= add)
  else if (u_mode == 23) blended = clamp(a.rgb + b.rgb - 1.0, 0.0, 1.0);      // linear burn
  else if (u_mode == 24) blended = a.rgb + b.rgb - 2.0 * a.rgb * b.rgb;       // exclusion
  else if (u_mode == 25) blended = vec3(1.0) - abs(vec3(1.0) - a.rgb - b.rgb);// negation
  else if (u_mode == 26) blended = reflectCh(a.rgb, b.rgb);                   // reflect
  else if (u_mode == 27) blended = glowCh(a.rgb, b.rgb);                      // glow
  else if (u_mode == 28) blended = clamp(min(a.rgb, b.rgb) - max(a.rgb, b.rgb) + vec3(1.0), 0.0, 1.0); // phoenix
  else blended = b.rgb;

  float srcA = clamp(b.a * u_opacity, 0.0, 1.0);
  float outA = srcA + a.a * (1.0 - srcA);
  vec3 outRgb;
  if (outA < 1e-4) {
    outRgb = vec3(0.0);
  } else {
    outRgb = (blended * srcA + a.rgb * a.a * (1.0 - srcA)) / outA;
  }
  outColor = vec4(outRgb, outA);
}`;

function modeToInt(m: BlendMode): number {
  switch (m) {
    case "mix": return 0;
    case "normal": return 1;
    case "overlay": return 2;
    case "screen": return 3;
    case "multiply": return 4;
    case "add": return 5;
    case "subtract": return 6;
    case "divide": return 7;
    case "difference": return 8;
    case "average": return 9;
    case "hard-light": return 10;
    case "soft-light": return 11;
    case "vivid-light": return 12;
    case "pin-light": return 13;
    case "linear-light": return 14;
    case "hard-mix": return 15;
    case "lighten": return 16;
    case "darken": return 17;
    case "lighter-color": return 18;
    case "darker-color": return 19;
    case "color-dodge": return 20;
    case "color-burn": return 21;
    case "linear-dodge": return 22;
    case "linear-burn": return 23;
    case "exclusion": return 24;
    case "negation": return 25;
    case "reflect": return 26;
    case "glow": return 27;
    case "phoenix": return 28;
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
