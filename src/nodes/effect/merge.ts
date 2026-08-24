import type {
  ImageValue,
  InputSocketDef,
  MaskValue,
  NodeDefinition,
} from "@/engine/types";

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
  // Per-layer bypass. `false` skips the layer in the blend chain (its input
  // socket stays, so the wire is preserved — it's just not composited).
  // Optional/undefined = enabled, so old saves (which never wrote it) keep
  // compositing every layer.
  enabled?: boolean;
  // Inverts this layer's wired mask (coverage becomes 1 − mask). Only takes
  // effect when a mask is actually connected — an absent matte stays full
  // coverage, so the toggle is inert on unmasked layers rather than blanking
  // them. Optional/undefined = off (old saves never wrote it).
  maskInvert?: boolean;
}

export const BLIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  outColor = texture(u_src, v_uv);
}`;

// Blit with a per-pixel matte: alpha is multiplied by the mask's coverage,
// RGB passes through (straight-alpha convention — coverage is all a matte
// touches). Used for the base input's mask, both on the no-layers fast
// path and as the pre-pass that mattes the base before the blend chain.
const MATTE_BLIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform sampler2D u_matte;
out vec4 outColor;
void main() {
  vec4 c = texture(u_src, v_uv);
  float m = texture(u_matte, v_uv).r;
  outColor = vec4(c.rgb, c.a * m);
}`;

// The blend math, shared verbatim by the pairwise shader (BLEND_FS, also used
// by the Layer node) and the fused multi-layer shader below. It lives in one
// string on purpose: two copies of twenty-nine blend formulas would drift the
// first time one of them was touched, and the divergence would show up as a
// subtle color difference that nobody would trace back to here.
//
// Formulas match the widely-cited Photoshop / Krita set; division-based
// modes guard the denominator so backgrounds don't explode to infinity on
// black/white pixels.
const BLEND_MODE_GLSL = `
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

vec3 blendRgb(int mode, vec3 a, vec3 b) {
  if      (mode == 0)  return b;                                     // mix (legacy)
  else if (mode == 1)  return b;                                     // normal
  else if (mode == 2)  return overlayCh(a, b);                       // overlay
  else if (mode == 3)  return 1.0 - (1.0 - a) * (1.0 - b);           // screen
  else if (mode == 4)  return a * b;                                 // multiply
  else if (mode == 5)  return clamp(a + b, 0.0, 1.0);                // add
  else if (mode == 6)  return clamp(a - b, 0.0, 1.0);                // subtract
  else if (mode == 7)  return clamp(a / max(b, vec3(1e-5)), 0.0, 1.0); // divide
  else if (mode == 8)  return abs(a - b);                            // difference
  else if (mode == 9)  return (a + b) * 0.5;                         // average
  else if (mode == 10) return hardLightCh(a, b);                     // hard light
  else if (mode == 11) return softLightCh(a, b);                     // soft light
  else if (mode == 12) return vividLightCh(a, b);                    // vivid light
  else if (mode == 13) return pinLightCh(a, b);                      // pin light
  else if (mode == 14) return clamp(a + 2.0 * b - 1.0, 0.0, 1.0);    // linear light
  else if (mode == 15) return step(vec3(1.0), a + b);                // hard mix
  else if (mode == 16) return max(a, b);                             // lighten
  else if (mode == 17) return min(a, b);                             // darken
  else if (mode == 18) return luma(a) > luma(b) ? a : b;             // lighter color
  else if (mode == 19) return luma(a) < luma(b) ? a : b;             // darker color
  else if (mode == 20) return colorDodgeCh(a, b);                    // color dodge
  else if (mode == 21) return colorBurnCh(a, b);                     // color burn
  else if (mode == 22) return clamp(a + b, 0.0, 1.0);                // linear dodge (= add)
  else if (mode == 23) return clamp(a + b - 1.0, 0.0, 1.0);          // linear burn
  else if (mode == 24) return a + b - 2.0 * a * b;                   // exclusion
  else if (mode == 25) return vec3(1.0) - abs(vec3(1.0) - a - b);    // negation
  else if (mode == 26) return reflectCh(a, b);                       // reflect
  else if (mode == 27) return glowCh(a, b);                          // glow
  else if (mode == 28) return clamp(min(a, b) - max(a, b) + vec3(1.0), 0.0, 1.0); // phoenix
  return b;
}

// Porter-Duff "src over dst" respecting per-pixel layer alpha (scaled by the
// opacity slider and any matte). The blend mode shapes RGB first; source-over
// then decides how much of that reaches the output.
vec4 compositeOver(vec4 a, vec4 b, float opacity, float matte, int mode) {
  vec3 blended = blendRgb(mode, a.rgb, b.rgb);
  float srcA = clamp(b.a * opacity * matte, 0.0, 1.0);
  float outA = srcA + a.a * (1.0 - srcA);
  vec3 outRgb;
  if (outA < 1e-4) {
    outRgb = vec3(0.0);
  } else {
    outRgb = (blended * srcA + a.rgb * a.a * (1.0 - srcA)) / outA;
  }
  return vec4(outRgb, outA);
}
`;

// Pairwise blend of one layer over one base. Still used by the Layer node
// (group/layer.ts) and by nothing else now that Merge fuses its chain.
// A wired per-layer matte multiplies into the effective alpha exactly like a
// per-pixel opacity slider (u_hasMatte defaults to 0, so the Layer node keeps
// the un-matted behavior).
export const BLEND_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_base;
uniform sampler2D u_layer;
uniform sampler2D u_matte;
uniform float u_opacity;
uniform int u_mode;
uniform int u_hasMatte;
out vec4 outColor;
${BLEND_MODE_GLSL}
void main() {
  vec4 a = texture(u_base, v_uv);
  vec4 b = texture(u_layer, v_uv);
  float matte = u_hasMatte == 1 ? texture(u_matte, v_uv).r : 1.0;
  outColor = compositeOver(a, b, u_opacity, matte, u_mode);
}`;

// FUSED multi-layer composite — the whole point of this file's perf work.
//
// The old chain ran ONE FULL-CANVAS PASS PER LAYER: N layers meant N writes of
// every pixel plus N-1 reads back of a full RGBA16F canvas. At 4K that
// dominated the frame — a level-3 GPU trace put two Merge nodes at 4.0 ms of
// GPU against 0.03 ms of CPU, and removing them took the scene from 30fps to
// 120fps (specdocs/080726_perf-profiler.md).
//
// This composites `n` layers over the base in ONE pass, accumulating in
// registers. Bandwidth drops from N canvas writes to 1.
//
// Generated per layer count rather than looped because GLSL ES 3.00 only
// permits CONSTANT expressions when indexing a sampler array — a loop counter
// will not compile. `n` is small and bounded by the texture-unit budget, so
// this is a handful of cached programs.
// Exported for scripts/check-shaders.mts — a GLSL syntax error here is a
// runtime-only failure that typecheck cannot see.
export function fusedMergeFs(n: number): string {
  const samplers = Array.from(
    { length: n },
    (_, i) => `uniform sampler2D u_layer${i};\nuniform sampler2D u_matte${i};`
  ).join("\n");
  const steps = Array.from({ length: n }, (_, i) => `
  {
    vec4 b = texture(u_layer${i}, v_uv);
    float m = 1.0;
    if (u_hasMatte[${i}] == 1) {
      m = texture(u_matte${i}, v_uv).r;
      // Invert lives INSIDE the hasMatte branch: flipping the no-matte
      // fallback (1.0) would silently blank the whole layer.
      if (u_invMatte[${i}] == 1) m = 1.0 - m;
    }
    acc = compositeOver(acc, b, u_opacity[${i}], m, u_mode[${i}]);
  }`).join("");
  return `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_base;
uniform sampler2D u_baseMatte;
uniform int u_hasBaseMatte;
${samplers}
uniform float u_opacity[${n}];
uniform int u_mode[${n}];
uniform int u_hasMatte[${n}];
uniform int u_invMatte[${n}];
out vec4 outColor;
${BLEND_MODE_GLSL}
void main() {
  vec4 acc = texture(u_base, v_uv);
  // The base matte folds into this pass instead of costing its own
  // full-canvas pre-pass.
  if (u_hasBaseMatte == 1) acc.a *= texture(u_baseMatte, v_uv).r;
${steps}
  outColor = acc;
}`;
}

export function modeToInt(m: BlendMode): number {
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
  category: "image",
  subcategory: "modifier",
  description:
    "Blends a base image with one or more layer images. Every image input " +
    "carries its own mask input underneath — the matte for that layer " +
    "(multiplies its per-pixel coverage, like a track matte). In AI " +
    "recipes/edits: size the stack by setting `layers` to " +
    "[{mode, opacity, maskInvert?}, …] (ids are minted automatically; " +
    "maskInvert flips a wired mask's coverage), and wire inputs " +
    "ordinally — layer1, layer2, … (mask1, mask2, … for the mattes) — " +
    "they resolve to the real per-layer sockets, growing the stack when " +
    "layerN points past the end.",
  backend: "webgl2",
  // Masks are per-image sockets here; the evaluator's universal matte would
  // be redundant (and ambiguous) stacked on top of them.
  noMaskInput: true,
  inputs: [
    { name: "base", type: "image", required: true },
    { name: "mask:base", label: "base mask", type: "mask", required: false },
  ],
  resolveInputs(params) {
    const layers = (params.layers as MergeLayer[]) ?? [];
    const result: InputSocketDef[] = [
      { name: "base", type: "image", required: true },
      { name: "mask:base", label: "base mask", type: "mask", required: false },
    ];
    layers.forEach((l, i) => {
      result.push({
        name: `layer:${l.id}`,
        label: `layer ${i + 1}`,
        type: "image",
        required: false,
      });
      result.push({
        name: `mask:${l.id}`,
        label: `mask ${i + 1}`,
        type: "mask",
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

    const maskFor = (key: string): MaskValue | null => {
      const m = inputs[`mask:${key}`];
      return m && m.kind === "mask" ? m : null;
    };
    const baseMatte = maskFor("base");

    const layers = (params.layers as MergeLayer[]) ?? [];
    const connected: Array<{
      layer: MergeLayer;
      img: ImageValue;
      matte: MaskValue | null;
    }> = [];
    for (const l of layers) {
      // A bypassed layer keeps its socket (wire preserved) but is skipped
      // here, so it never enters the blend chain.
      if (l.enabled === false) continue;
      const v = inputs[`layer:${l.id}`];
      if (v && v.kind === "image") {
        connected.push({ layer: l, img: v, matte: maskFor(l.id) });
      }
    }

    // Base matte applies before the blend chain: with layers it renders the
    // matted base into a temp that seeds the chain (released by the loop's
    // current !== base check); with none it mattes straight into the output.
    const matteBase = (dest: ImageValue) => {
      const prog = ctx.getShader("merge/matte-blit", MATTE_BLIT_FS);
      ctx.drawFullscreen(prog, dest, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, base.texture);
        gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, baseMatte!.texture);
        gl.uniform1i(gl.getUniformLocation(prog, "u_matte"), 1);
      });
    };

    if (connected.length === 0) {
      if (baseMatte) {
        matteBase(output);
      } else {
        const blitProg = ctx.getShader("merge/blit", BLIT_FS);
        ctx.drawFullscreen(blitProg, output, (gl) => {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, base.texture);
          gl.uniform1i(gl.getUniformLocation(blitProg, "u_src"), 0);
        });
      }
      return { primary: output };
    }

    // How many layers fit in ONE fused pass. Each layer costs two texture
    // units (image + matte) on top of the base pair. WebGL2 guarantees at
    // least 16 fragment units, so the floor is 7 layers per pass — enough
    // that almost every real Merge collapses to a single pass.
    const maxUnits = ctx.gl.getParameter(
      ctx.gl.MAX_TEXTURE_IMAGE_UNITS
    ) as number;
    const perPass = Math.max(1, Math.floor(((maxUnits || 16) - 2) / 2));

    let current: ImageValue = base;
    // The base matte rides the first pass (u_hasBaseMatte); later chunks read
    // an already-matted intermediate, so they must not apply it again.
    let baseMatteePending = !!baseMatte;

    for (let start = 0; start < connected.length; start += perPass) {
      const chunk = connected.slice(start, start + perPass);
      const isLastChunk = start + perPass >= connected.length;
      const dest = isLastChunk ? output : ctx.allocImage();
      const n = chunk.length;
      const prog = ctx.getShader(`merge/fused-v2-${n}`, fusedMergeFs(n));
      const applyBaseMatte = baseMatteePending;

      ctx.drawFullscreen(prog, dest, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, current.texture);
        gl.uniform1i(gl.getUniformLocation(prog, "u_base"), 0);
        // Every sampler needs a live binding even when its flag is off —
        // some drivers evaluate both branches of the ternary. The base
        // texture is a harmless stand-in, same trick the old chain used.
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(
          gl.TEXTURE_2D,
          applyBaseMatte ? baseMatte!.texture : current.texture
        );
        gl.uniform1i(gl.getUniformLocation(prog, "u_baseMatte"), 1);
        gl.uniform1i(
          gl.getUniformLocation(prog, "u_hasBaseMatte"),
          applyBaseMatte ? 1 : 0
        );

        const opacities = new Float32Array(n);
        const modes = new Int32Array(n);
        const hasMatte = new Int32Array(n);
        const invMatte = new Int32Array(n);
        for (let i = 0; i < n; i++) {
          const { layer, img, matte } = chunk[i];
          const imgUnit = 2 + i * 2;
          const matteUnit = imgUnit + 1;
          gl.activeTexture(gl.TEXTURE0 + imgUnit);
          gl.bindTexture(gl.TEXTURE_2D, img.texture);
          gl.uniform1i(gl.getUniformLocation(prog, `u_layer${i}`), imgUnit);
          gl.activeTexture(gl.TEXTURE0 + matteUnit);
          gl.bindTexture(gl.TEXTURE_2D, matte ? matte.texture : img.texture);
          gl.uniform1i(gl.getUniformLocation(prog, `u_matte${i}`), matteUnit);
          opacities[i] = layer.opacity;
          modes[i] = modeToInt(layer.mode);
          hasMatte[i] = matte ? 1 : 0;
          invMatte[i] = layer.maskInvert ? 1 : 0;
        }
        gl.uniform1fv(gl.getUniformLocation(prog, "u_opacity"), opacities);
        gl.uniform1iv(gl.getUniformLocation(prog, "u_mode"), modes);
        gl.uniform1iv(gl.getUniformLocation(prog, "u_hasMatte"), hasMatte);
        gl.uniform1iv(gl.getUniformLocation(prog, "u_invMatte"), invMatte);
      });

      baseMatteePending = false;
      if (current !== base) ctx.releaseTexture(current.texture);
      current = dest;
    }

    return { primary: output };
  },
};
