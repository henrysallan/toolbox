import type { LutFileParamValue, NodeDefinition } from "@/engine/types";
import { lutToFloatVolume, parseCubeLut } from "@/lib/cube-lut";

// Apply a .cube 3D LUT to the input image using a hardware-filtered 3D
// texture (trilinear interpolation). 1D LUTs are expanded to a 3D grid by
// the parser so there's a single sampling path.
//
// HDR support (spec 070926_exr-color-pipeline.md): the volume uploads as
// RGBA16F (no 8-bit banding, LUT outputs > 1 survive), and an optional
// log2 SHAPER maps scene-linear input into the cube's [0,1] domain — the
// same shaper+cube shape `ociobakelut` emits, so OCIO-baked ACES/display
// transforms apply correctly to linear EXR footage. Without the shaper,
// input past 1.0 clamps at the cube edge (fine for display-referred grades).

const COPY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() { outColor = texture(u_src, v_uv); }`;

const LUT_FS = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 v_uv;
uniform sampler2D u_src;
uniform sampler3D u_lut;
uniform float u_scale;        // (N-1)/N — keeps sampling on texel centres
uniform float u_offset;       // 0.5/N
uniform float u_intensity;    // 0 = original, 1 = full LUT
uniform vec3 u_domainMin;
uniform vec3 u_domainMax;
uniform int u_shaper;         // 0 = none (domain remap), 1 = log2 stops
uniform float u_shaperMin;    // log2 stops mapped to cube 0
uniform float u_shaperMax;    // log2 stops mapped to cube 1
out vec4 outColor;

void main() {
  vec4 src = texture(u_src, v_uv);
  vec3 c;
  if (u_shaper == 1) {
    // ociobakelut-style log2 shaper: scene-linear HDR → the cube's [0,1].
    c = clamp(
      (log2(max(src.rgb, vec3(1e-6))) - vec3(u_shaperMin)) /
        max(u_shaperMax - u_shaperMin, 1e-5),
      0.0, 1.0
    );
  } else {
    // Remap input through the LUT's declared domain (usually 0..1).
    c = clamp(
      (src.rgb - u_domainMin) / max(u_domainMax - u_domainMin, vec3(1e-5)),
      0.0, 1.0
    );
  }
  vec3 coord = c * u_scale + u_offset;
  vec3 graded = texture(u_lut, coord).rgb;
  outColor = vec4(mix(src.rgb, graded, u_intensity), src.a);
}`;

interface LutState {
  tex: WebGLTexture | null;
  // Which .cube text the current texture was built from — re-upload only
  // when this changes.
  srcText: string | null;
  size: number;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
}

function uploadVolume(
  gl: WebGL2RenderingContext,
  state: LutState,
  size: number,
  data: Float32Array
) {
  if (!state.tex) state.tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, state.tex);
  // RGBA16F: filterable in core WebGL2, no 8-bit banding on subtle grades,
  // and LUT outputs > 1 (HDR-to-HDR transforms) survive.
  gl.texImage3D(
    gl.TEXTURE_3D,
    0,
    gl.RGBA16F,
    size,
    size,
    size,
    0,
    gl.RGBA,
    gl.FLOAT,
    data
  );
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_3D, null);
  state.size = size;
}

export const lutNode: NodeDefinition = {
  type: "lut",
  name: "Apply LUT",
  category: "image",
  subcategory: "modifier",
  description:
    "Apply a .cube 3D LUT (color grade) to the image. The optional log2 HDR shaper applies OCIO-baked (shaper + cube) LUTs to scene-linear footage.",
  backend: "webgl2",
  inputs: [{ name: "image", type: "image", required: true }],
  params: [
    { name: "lut", label: "LUT (.cube)", type: "lut_file", default: null },
    {
      name: "intensity",
      label: "Intensity",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 1,
    },
    // HDR input shaper. "log2" maps scene-linear stops onto the cube's
    // [0,1] domain before lookup — set to the shaper range the LUT was
    // baked with (ociobakelut --shaper log2 defaults to about −10…+6.5).
    {
      name: "shaper",
      label: "HDR shaper",
      type: "enum",
      options: ["none", "log2"],
      default: "none",
      control: "segmented",
    },
    {
      name: "shaper_min_stops",
      label: "Shaper min (stops)",
      type: "scalar",
      min: -16,
      max: 0,
      step: 0.1,
      default: -10,
      visibleIf: (p) => p.shaper === "log2",
    },
    {
      name: "shaper_max_stops",
      label: "Shaper max (stops)",
      type: "scalar",
      min: 0,
      max: 16,
      step: 0.1,
      default: 6.5,
      visibleIf: (p) => p.shaper === "log2",
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const output = ctx.allocImage();
    const src = inputs["image"];
    if (!src || src.kind !== "image") {
      ctx.clearTarget(output, [0, 0, 0, 1]);
      return { primary: output };
    }

    const gl = ctx.gl;
    const lutVal = (params.lut ?? null) as LutFileParamValue | null;

    // No LUT loaded (or it failed to parse) → straight passthrough copy.
    const passthrough = () => {
      const prog = ctx.getShader("lut/copy", COPY_FS);
      ctx.drawFullscreen(prog, output, (gl2) => {
        gl2.activeTexture(gl2.TEXTURE0);
        gl2.bindTexture(gl2.TEXTURE_2D, src.texture);
        gl2.uniform1i(gl2.getUniformLocation(prog, "u_src"), 0);
      });
      return { primary: output };
    };

    if (!lutVal || !lutVal.text) return passthrough();

    const stateKey = `lut:${nodeId}`;
    let state = ctx.state[stateKey] as LutState | undefined;
    if (!state) {
      state = {
        tex: null,
        srcText: null,
        size: 0,
        domainMin: [0, 0, 0],
        domainMax: [1, 1, 1],
      };
      ctx.state[stateKey] = state;
    }

    // (Re)parse + upload only when the source text changes.
    if (state.srcText !== lutVal.text || !state.tex) {
      const parsed = parseCubeLut(lutVal.text);
      if (!parsed) {
        // Remember the bad text so we don't re-parse every frame; keep any
        // previously-built texture, otherwise fall back to passthrough.
        state.srcText = lutVal.text;
        if (!state.tex) return passthrough();
      } else {
        const vol = lutToFloatVolume(parsed);
        uploadVolume(gl, state, vol.size, vol.data);
        state.srcText = lutVal.text;
        state.domainMin = parsed.domainMin;
        state.domainMax = parsed.domainMax;
      }
    }

    if (!state.tex) return passthrough();

    const n = state.size;
    const scale = (n - 1) / n;
    const offset = 0.5 / n;
    const intensity =
      typeof params.intensity === "number" ? params.intensity : 1;
    const shaper = params.shaper === "log2" ? 1 : 0;
    const shaperMin =
      typeof params.shaper_min_stops === "number" ? params.shaper_min_stops : -10;
    const shaperMax =
      typeof params.shaper_max_stops === "number" ? params.shaper_max_stops : 6.5;

    const prog = ctx.getShader("lut/apply", LUT_FS);
    ctx.drawFullscreen(prog, output, (gl2) => {
      const u = (name: string) => gl2.getUniformLocation(prog, name);
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_2D, src.texture);
      gl2.uniform1i(u("u_src"), 0);
      gl2.activeTexture(gl2.TEXTURE1);
      gl2.bindTexture(gl2.TEXTURE_3D, state!.tex);
      gl2.uniform1i(u("u_lut"), 1);
      gl2.uniform1f(u("u_scale"), scale);
      gl2.uniform1f(u("u_offset"), offset);
      gl2.uniform1f(u("u_intensity"), intensity);
      gl2.uniform3fv(u("u_domainMin"), state!.domainMin);
      gl2.uniform3fv(u("u_domainMax"), state!.domainMax);
      gl2.uniform1i(u("u_shaper"), shaper);
      gl2.uniform1f(u("u_shaperMin"), shaperMin);
      gl2.uniform1f(u("u_shaperMax"), shaperMax);
    });

    return { primary: output };
  },

  dispose(ctx, nodeId) {
    const stateKey = `lut:${nodeId}`;
    const state = ctx.state[stateKey] as LutState | undefined;
    if (state?.tex) ctx.gl.deleteTexture(state.tex);
    delete ctx.state[stateKey];
  },
};
