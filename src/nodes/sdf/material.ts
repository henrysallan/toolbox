import type {
  NodeDefinition,
  RenderContext,
  ScalarFieldNode,
  ScalarFieldValue,
  SdfNode,
  SdfValue,
} from "@/engine/types";
import { sdfHexToRgb01 } from "@/engine/sdf-material";
import {
  type ColorRampInterp,
  type ColorRampStop,
  sampleColorRampRgba01,
} from "@/engine/color-ramp";

// Paint an SDF subtree. Distance is untouched — this only sets the
// colour that the shading terminals read, so inserting one anywhere in
// a chain never changes the shape.
//
// Materials INHERIT, CSS-`fill` style: this node paints every shape
// below it that isn't already painted, and a material nearer a leaf
// (another Material node, or a primitive's own Paint toggle) wins for
// its own subtree. That is what makes recolouring six shapes at once a
// one-node edit.
//
// Colour blending is not this node's job — it falls out of the
// combiners. Two painted shapes through an SDF Smooth Union blend their
// colours across exactly the bridge the distance blends over, using
// that node's Smoothness.
//
// RAMP mode is what makes repeated geometry multicolour. A position
// fold (SDF Repeat) means ONE leaf covers every tile, so no amount of
// per-shape colour can vary between tiles — but a ramp sampled at a
// per-pixel scalar field can. The canonical chain:
//
//   SDF Repeat --(cell_id)--> Perlin Noise --> SDF Material (t)
//
// gives every tile its own colour from one primitive and one material.
// Spec: 080226_sdf-materials-and-shading.md.

const LUT_SIZE = 256;

interface MaterialState {
  lut?: WebGLTexture;
  // Rebake only when the stops actually change — the texture upload is
  // cheap but not free, and this runs every eval.
  tag?: string;
}

function rootOf(v: unknown): SdfNode {
  if (v && typeof v === "object" && (v as { kind?: string }).kind === "sdf") {
    return (v as SdfValue).root;
  }
  return { kind: "empty" };
}

// Bake the stops into a 256x1 RGBA texture, LINEAR-filtered so the
// shader's single fetch interpolates between entries.
//
// RGBA8, NOT RGBA32F: float textures are not linearly filterable in
// WebGL2 without OES_texture_float_linear, so a LINEAR float LUT is an
// incomplete texture and samples as solid black. 8 bits per channel is
// exactly the precision the hex stops carry anyway.
function buildLut(
  ctx: RenderContext,
  state: MaterialState,
  stops: ColorRampStop[],
  interp: ColorRampInterp
): WebGLTexture | null {
  const tag = JSON.stringify([stops, interp]);
  if (state.lut && state.tag === tag) return state.lut;

  const gl = ctx.gl;
  if (!state.lut) {
    const tex = gl.createTexture();
    if (!tex) return null;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    state.lut = tex;
  }

  const data = new Uint8Array(LUT_SIZE * 4);
  for (let i = 0; i < LUT_SIZE; i++) {
    // Sample at texel CENTRES so the LINEAR fetch at t maps back to the
    // same colour sampleColorRamp would give on the CPU.
    const t = (i + 0.5) / LUT_SIZE;
    const rgba = sampleColorRampRgba01(stops, t, interp);
    for (let c = 0; c < 4; c++) {
      data[i * 4 + c] = Math.round(Math.max(0, Math.min(1, rgba[c])) * 255);
    }
  }
  gl.bindTexture(gl.TEXTURE_2D, state.lut);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
    LUT_SIZE,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    data
  );
  state.tag = tag;
  return state.lut;
}

export const sdfMaterialNode: NodeDefinition = {
  type: "sdf-material",
  name: "SDF Material",
  category: "utility",
  description:
    "Paint an SDF subtree. Sets the color every shape below it renders with, unless a shape (or a nearer Material) paints itself. Distance is untouched. Constant mode takes a color (or a wired Color node); Ramp mode samples a gradient at a scalar field — wire SDF Repeat's Cell ID through a noise node to give every tile its own color.",
  backend: "webgl2",
  stable: true,
  inputs: [
    { name: "sdf", type: "sdf", required: true, label: "SDF" },
    // vec4 to match the Color node's output and the socket a `color`
    // param mints when exposed (paramSocketType maps color -> vec4).
    // Alpha is dropped: the material AST carries colour only, coverage
    // stays the terminal's job.
    { name: "color", type: "vec4", required: false, label: "Color" },
    { name: "t", type: "scalar_field", required: false, label: "Ramp Factor" },
  ],
  params: [
    {
      name: "color_mode",
      label: "Mode",
      type: "enum",
      options: ["constant", "ramp"],
      default: "constant",
    },
    {
      name: "color",
      label: "Color",
      type: "color",
      default: "#ffffff",
      visibleIf: (p) => (p.color_mode ?? "constant") !== "ramp",
    },
    {
      name: "stops",
      label: "Ramp",
      type: "color_ramp",
      default: [
        { id: "stop-a", position: 0, color: "#ff3b30" },
        { id: "stop-b", position: 0.5, color: "#ffcc00" },
        { id: "stop-c", position: 1, color: "#0a84ff" },
      ] as ColorRampStop[],
      visibleIf: (p) => p.color_mode === "ramp",
    },
    {
      name: "interpolation",
      label: "Interpolation",
      type: "enum",
      options: ["linear", "ease", "constant"],
      default: "linear",
      visibleIf: (p) => p.color_mode === "ramp",
    },
  ],
  primaryOutput: "sdf",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const child = rootOf(inputs.sdf);

    // Wire > param. An exposed `color` param arrives already normalized
    // to hex by the evaluator, so that path falls through to the param
    // branch; this socket is the direct one.
    const wired = inputs.color;
    const color: [number, number, number] =
      wired?.kind === "vec4" || wired?.kind === "vec3"
        ? [wired.value[0], wired.value[1], wired.value[2]]
        : sdfHexToRgb01((params.color as string) ?? "#ffffff");

    let ramp: { lut: WebGLTexture; t: ScalarFieldNode } | undefined;
    if (params.color_mode === "ramp") {
      const key = `sdf-material:${nodeId}`;
      const state = (ctx.state[key] ??= {} as MaterialState) as MaterialState;
      const stops = Array.isArray(params.stops)
        ? (params.stops as ColorRampStop[])
        : [];
      const lut = buildLut(
        ctx,
        state,
        stops,
        (params.interpolation as ColorRampInterp) ?? "linear"
      );
      if (lut) {
        // No field wired: hold the ramp's midpoint. Predictable and
        // flat, rather than silently reverting to the colour param.
        const field = inputs.t;
        const t: ScalarFieldNode =
          field?.kind === "scalar_field"
            ? (field as ScalarFieldValue).root
            : { kind: "constant", value: 0.5 };
        ramp = { lut, t };
      }
    }

    const out: SdfValue = {
      kind: "sdf",
      root: {
        kind: "material",
        child,
        color,
        // Per-material bleed weighting arrives with the terminal that
        // reads the accumulator; every material participates for now.
        bleed: 1,
        ...(ramp ? { ramp } : {}),
      },
    };
    return { primary: out };
  },

  dispose(ctx, nodeId) {
    const key = `sdf-material:${nodeId}`;
    const state = ctx.state[key] as MaterialState | undefined;
    if (state?.lut) ctx.gl.deleteTexture(state.lut);
    delete ctx.state[key];
  },
};
